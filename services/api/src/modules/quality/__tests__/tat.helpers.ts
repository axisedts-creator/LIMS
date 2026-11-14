// C9 T-19 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute.
// Spec: 02-TRD §9 (§9.1 inputs, §9.2 segments, §9.3 clock + sweep steps 1-5, §9.4 vectors T1-T14), §10.2 (consumers), §10.3 (tasks), §5.7 (#48-#50), §5.10 (TatAlertDto, TatAlertDetailDto), §14 (metrics);
//       03-APP-FLOW §2.4 (TC1-TC11); 05-SCHEMA (tat_items, tat_alert_events, tat_alert_acks, §5 RLS, §7 retention); PRD AC-14.1-14.8; 07-SECURITY S-02, S-03, S-05, S-21; 08 A17 D-59, P-18(c), P-21.
//   The pure clock (T-18) is `../domain/tat-clock.ts` and is NOT re-tested here: these tests prove load -> transition -> persist -> events around it.
//
//   ../repository/tat.repo.ts     exports `TatRepo` (interface below) + `createTatRepo(): TatRepo`. SQL on the caller's tx (`tx.query(text, values)`), parameterised, explicit `tenant_id = $n` on EVERY statement.
//                                 Timestamps leave as ISO text with ms ('...sssZ'). RLS-invisible rows -> undefined / []. Reads of other schemas ONLY: lab.v_pub_pending_items, lab.v_pub_specimen_timeline,
//                                 reporting.v_pub_order_report_tat (02-CV §5.13); never a base table of another module. Every method is ONE statement (batched with unnest / ANY), so a sweep costs a bounded number of statements.
//   ../service/tat.service.ts     exports `createTatService(deps?: { repo?: TatRepo; settings?: { ensure(tx, who: { tenantId, actorId }): Promise<{ tatAlertsEnabled, tatWarnPct, tatEscalatePct, tatOrphanCloseHours }> } })`:
//        WORKER methods — NO assertRole (system actor; the job is the authority), tenant from ctx.tenantId only, repo calls on ctx.tx, never open/commit a transaction, clock = ctx.now() only,
//        created_by/updated_by = ctx.actor.id:
//          sweep(ctx): Promise<SweepResult>          §9.3 steps 1-5 for the tenant. First `settings.ensure(ctx.tx, { tenantId, actorId })`; `tatAlertsEnabled = false` -> returns the all-zero result and reads NOTHING else.
//          refreshOrder(ctx, { orderId })            §9.3 steps 1-4 for ONE order (listPending({orderId}); items of OTHER orders are never touched, never cancelled).
//          applyVerified(ctx, { orderItemId, testId, verifiedAt })   within_lab -> TC6 / T11 / earliest wins (domain `verified` event); total -> first_verified_at only. No row -> no-op (no throw, no write).
//          applyRelease(ctx, { orderId, reportKind, orderItemIds?, releasedAt })   domain `release` event for every item of the order (repo.listItemsByOrder); only changed rows are written.
//          purgeExpired(ctx): Promise<{ deleted: number }>   repo.deleteExpired(tx, tenant, ctx.now()); nothing else.
//        API methods `(ctx, input) => { status, body, version? }` (same Result shape as review.service):
//          listTatAlerts{level?(csv),acknowledged?,segment?,departmentId?,centreId?,priority?,sort?,cursor?,limit?}   getTatAlert{tatItemId}   acknowledgeTatAlert{tatItemId,expectedVersion,body}
//          Reads: assertRole('quality.tat_alert.read') FIRST -> validate -> repo. Ack: assertRole('quality.tat_alert.ack') FIRST -> validate body (unknown field -> 400 + errors[{path,code:'common.unknown_field'}]) ->
//          If-Match missing -> 428 common.precondition_required -> load (invisible -> 404 common.not_found, centre RLS) -> version mismatch -> 409 common.version_conflict -> domain `ack`
//          (TatClockError 'common.immutable_record' -> LimsError same code, 409) -> repo.ack (insert ack row + item update in ONE statement-set guarded by `version = expected`; undefined result -> 409 common.version_conflict).
//          Ack row: level = the item's CURRENT alert_level, note as sent, membership = ctx.actor.membershipId, centre of the item, created_by = ctx.actor.id. Item: acknowledged_level/at/by (membership), version + 1.
//          DTOs per contracts/openapi/quality.yaml (TatAlertDto, TatAlertDetailDto): test_code from ctx.ports.CatalogPort.getTest(ctx, { testId, asOf }) (one call per DISTINCT test_id), acknowledged_by_display from
//          repo.listMembershipLabels (never the raw id), segment_label starts with "Within lab" / "Total" (AC-14.8), elapsed_seconds = floor(((stopped_at ?? now) - started_at)/1000) (0 without started_at),
//          pct_of_target = floor(elapsed*100/target). Open alert (list) = state running AND alert_level in warning|breached|escalated; `acknowledged=true` <=> acknowledged_level covers alert_level (rank >=).
//   The sweep result: SweepResult = { seen, created, raised: Array<{ level, segment, lagSeconds }>, stopped, cancelled, orphanClosed, openAlerts: { warning, breached, escalated } } (counts of rows OPEN after the sweep).
//   Consumers / tasks: see the worker tests (tat_sweep.test.ts, tat_refresh_order.test.ts, purge_tat_items.test.ts, lab.specimen.status_changed.test.ts, reporting.report.released.test.ts, lab.result.verified.tat.test.ts).
import { LimsError } from '../../../core/errors.js';
import { makeCtx, type Row } from './setup.helpers.js';
import { createFakeCatalogPort } from '../../../../../../packages/fakes/src/CatalogPort.fake.js';
import { INS, TENANT_A, TENANT_B, at, idN } from './run.helpers.js';
export { INS, TENANT_A, TENANT_B, at, idN, type Row };
export { rejection, code, forbidden, noRights, PLANTED, UUID7 } from './setup.helpers.js';

export const ORD = (n: number) => idN(0x9100 + n);
export const OIT = (n: number) => idN(0x9200 + n);
export const TST = (n: number) => idN(0x9300 + n);
export const SPC = (n: number) => idN(0x9400 + n);
export const CEN = (n: number) => idN(0x9500 + n);
export const DEP = (n: number) => idN(0x9600 + n);
export const TAT = (n: number) => idN(0x9700 + n);
export const MEMB = (n: number) => idN(0x9800 + n);
export const DAY = '2026-11-05';
export const T = (hms: string, day = DAY) => `${day}T${hms}.000Z`;
export const HOUR = 3_600_000;
export const DAY_MS = 86_400_000;
export const SETTINGS = { tatAlertsEnabled: true, tatWarnPct: 80, tatEscalatePct: 150, tatOrphanCloseHours: 72 };
/** TST(1) CBC (no tatTargetSegment: C3 default within_lab), TST(2) ESR total, TST(3) LFT within_lab explicit. */
export const TESTS = [{ n: 1, code: 'CBC' }, { n: 2, code: 'ESR', seg: 'total' }, { n: 3, code: 'LFT', seg: 'within_lab' }] as const;
export const DTO_KEYS = ['acknowledged_at', 'acknowledged_by_display', 'acknowledged_level', 'alert_level', 'centre_id', 'department_id', 'elapsed_seconds', 'order_id', 'order_item_id', 'pct_of_target', 'priority', 'segment', 'segment_label',
  'specimen_id', 'start_basis', 'started_at', 'state', 'target_seconds', 'tat_item_id', 'test_code', 'test_id', 'version'];
export const DETAIL_EXTRA = ['acknowledgements', 'first_verified_at', 'level_events', 'restart_count', 'stop_source', 'stopped_at'];

export interface PendingRow { order_item_id: string; test_id: string; specimen_id: string; order_id: string; centre_id: string; department_id: string | null; priority: 'routine' | 'urgent'; item_status: string; received_at: string | null; tat_target_seconds: number | null }
export interface TatItemRow {
  id: string; version: number; centre_id: string; order_id: string; order_item_id: string; test_id: string; specimen_id: string; department_id: string | null; priority: 'routine' | 'urgent'; segment: 'within_lab' | 'total'; target_seconds: number;
  start_basis: string; state: string; started_at: string | null; stopped_at: string | null; stop_source: string | null; restart_count: number; first_verified_at: string | null; in_pending_view: boolean; left_pending_view_at: string | null;
  last_seen_sweep_at: string; alert_level: string; alert_level_at: string | null; acknowledged_level: string | null; acknowledged_at: string | null; acknowledged_by: string | null; expires_at: string | null;
}
export interface EventRow { tat_item_id: string; centre_id: string; level: string; raised_at: string; elapsed_seconds: number; restart_no: number }
export interface AckRow { tat_item_id: string; centre_id: string; level: string; note: string | null; acknowledged_by_membership_id: string; created_at: string; created_by: string }
export interface AlertFilter { levels?: string[]; acknowledged?: boolean; segment?: string; departmentId?: string; centreId?: string; priority?: string; sort: '-alert_level_rank' | '-pct_of_target' | 'started_at'; now: string }

export interface TatRepo {
  /** lab.v_pub_pending_items WHERE tenant AND tat_target_seconds IS NOT NULL (+ order_id when given). */
  listPending(tx: any, t: string, o: { orderId?: string }): Promise<PendingRow[]>;
  /** reporting.v_pub_order_report_tat: registered_at per order (orders the view does not know are absent). */
  listTotalStarts(tx: any, t: string, orderIds: string[]): Promise<Array<{ order_id: string; registered_at: string }>>;
  /** lab.v_pub_specimen_timeline: min(ordered_at) per order. */
  listEarliestOrdered(tx: any, t: string, orderIds: string[]): Promise<Array<{ order_id: string; ordered_at: string }>>;
  findItems(tx: any, t: string, keys: Array<{ order_item_id: string; test_id: string }>): Promise<TatItemRow[]>;
  /** state in (not_started, running); order filter optional. */
  listOpenItems(tx: any, t: string, o: { orderId?: string }): Promise<TatItemRow[]>;
  listItemsByOrder(tx: any, t: string, orderId: string): Promise<TatItemRow[]>;
  /** INSERT ... ON CONFLICT (tenant_id, order_item_id, test_id) DO NOTHING RETURNING *: only rows really inserted come back (a concurrent creator wins). */
  insertItems(tx: any, t: string, actorId: string, rows: Array<Omit<TatItemRow, 'id' | 'version'>>): Promise<TatItemRow[]>;
  /** Applies `set` (DB column names) and bumps version by 1 for every patch; returns rows updated. */
  updateItems(tx: any, t: string, actorId: string, patches: Array<{ id: string; set: Row }>): Promise<number>;
  /** last_seen_sweep_at only; MUST NOT bump version (a minute tick must not invalidate a user's If-Match). */
  touchSeen(tx: any, t: string, ids: string[], at: string): Promise<number>;
  /** ON CONFLICT (tenant_id, tat_item_id, restart_no, level) DO NOTHING. */
  insertAlertEvents(tx: any, t: string, actorId: string, rows: EventRow[]): Promise<number>;
  deleteExpired(tx: any, t: string, nowIso: string): Promise<number>;
  listAlerts(tx: any, t: string, f: AlertFilter, page: { cursor?: string; limit: number }): Promise<{ rows: TatItemRow[]; nextCursor?: string }>;
  getItem(tx: any, t: string, id: string): Promise<TatItemRow | undefined>;
  listLevelEvents(tx: any, t: string, id: string): Promise<EventRow[]>;
  listAcks(tx: any, t: string, id: string): Promise<AckRow[]>;
  ack(tx: any, t: string, a: { id: string; expectedVersion: number; level: string; note: string | null; at: string; membershipId: string; actorId: string }): Promise<TatItemRow | undefined>;
  listMembershipLabels(tx: any, t: string, ids: string[]): Promise<Array<{ membership_id: string; display: string }>>;
}

export const pend = (n: number, o: Partial<PendingRow> = {}): PendingRow => ({
  order_item_id: OIT(n), test_id: TST(1), specimen_id: SPC(n), order_id: ORD(n), centre_id: CEN(1), department_id: DEP(1), priority: 'routine', item_status: 'received', received_at: T('08:00:00'), tat_target_seconds: 14_400, ...o });
export const item = (n: number, o: Partial<TatItemRow> = {}): TatItemRow => ({
  id: TAT(n), version: 1, centre_id: CEN(1), order_id: ORD(n), order_item_id: OIT(n), test_id: TST(1), specimen_id: SPC(n), department_id: DEP(1), priority: 'routine', segment: 'within_lab', target_seconds: 14_400,
  start_basis: 'specimen_received_at', state: 'running', started_at: T('08:00:00'), stopped_at: null, stop_source: null, restart_count: 0, first_verified_at: null, in_pending_view: true, left_pending_view_at: null,
  last_seen_sweep_at: T('08:00:00'), alert_level: 'none', alert_level_at: null, acknowledged_level: null, acknowledged_at: null, acknowledged_by: null, expires_at: null, ...o });
export const totalItem = (n: number, o: Partial<TatItemRow> = {}): TatItemRow =>
  item(n, { test_id: TST(2), segment: 'total', start_basis: 'registered_at', started_at: T('08:00:00'), ...o });

export interface TatSeed {
  pending?: Array<PendingRow & { tenant_id?: string }>; items?: Array<TatItemRow & { tenant_id?: string }>; events?: Array<EventRow & { tenant_id?: string }>; acks?: Array<AckRow & { tenant_id?: string }>;
  registered?: Array<{ tenant_id?: string; order_id: string; registered_at: string }>; ordered?: Array<{ tenant_id?: string; order_id: string; ordered_at: string }>;
  labels?: Array<{ tenant_id?: string; membership_id: string; display: string }>;
}
export interface FakeOpts { visibleCentres?: string[]; raceInsert?: (keyOf: { order_item_id: string; test_id: string }) => boolean; failOn?: Record<string, Error> }
const ms = (v: string) => Date.parse(v);
const RANK: Record<string, number> = { none: 0, warning: 1, breached: 2, escalated: 3 };
/** In-memory TatRepo: tenant-aware (explicit predicate AND a centre RLS stand-in), all semantics of the interface above. `calls` records every call (op, tenant, tx, args). */
export function makeTatRepo(seed: TatSeed = {}, opts: FakeOpts = {}) {
  const tagged = <X extends object>(rows: X[] | undefined) => (rows ?? []).map((r) => ({ tenant_id: TENANT_A, ...r }) as X & { tenant_id: string });
  const s = { pending: tagged(seed.pending), items: tagged(seed.items), events: tagged(seed.events), acks: tagged(seed.acks), registered: tagged(seed.registered), ordered: tagged(seed.ordered), labels: tagged(seed.labels), nextId: 100 };
  const calls: Array<{ op: string; tenantId?: string; tx: unknown; args: unknown[] }> = [];
  const rec = <R>(op: string, tx: unknown, t: string | undefined, args: unknown[], fn: () => R): R => { calls.push({ op, tenantId: t, tx, args }); if (opts.failOn?.[op]) throw opts.failOn[op]; return fn(); };
  const vis = (r: { tenant_id: string; centre_id: string }, t: string) => r.tenant_id === t && (!opts.visibleCentres || opts.visibleCentres.includes(r.centre_id));
  const strip = <X extends { tenant_id?: string }>(r: X): Omit<X, 'tenant_id'> => { const { tenant_id: _t, ...rest } = r; return { ...rest } as Omit<X, 'tenant_id'>; };
  const repo: TatRepo = {
    async listPending(tx, t, o) { return rec('listPending', tx, t, [o], () => s.pending.filter((p) => p.tenant_id === t && p.tat_target_seconds !== null && (!o.orderId || p.order_id === o.orderId)).map(strip) as PendingRow[]); },
    async listTotalStarts(tx, t, ids) { return rec('listTotalStarts', tx, t, [ids], () => s.registered.filter((r) => r.tenant_id === t && ids.includes(r.order_id)).map(strip)); },
    async listEarliestOrdered(tx, t, ids) { return rec('listEarliestOrdered', tx, t, [ids], () => s.ordered.filter((r) => r.tenant_id === t && ids.includes(r.order_id)).map(strip)); },
    async findItems(tx, t, keys) { return rec('findItems', tx, t, [keys], () => s.items.filter((i) => vis(i, t) && keys.some((k) => k.order_item_id === i.order_item_id && k.test_id === i.test_id)).map(strip) as TatItemRow[]); },
    async listOpenItems(tx, t, o) { return rec('listOpenItems', tx, t, [o], () => s.items.filter((i) => vis(i, t) && ['not_started', 'running'].includes(i.state) && (!o.orderId || i.order_id === o.orderId)).map(strip) as TatItemRow[]); },
    async listItemsByOrder(tx, t, orderId) { return rec('listItemsByOrder', tx, t, [orderId], () => s.items.filter((i) => vis(i, t) && i.order_id === orderId).map(strip) as TatItemRow[]); },
    async insertItems(tx, t, actorId, rows) {
      return rec('insertItems', tx, t, [actorId, rows], () => {
        const out: TatItemRow[] = [];
        for (const r of rows) {
          if (opts.raceInsert?.(r) || s.items.some((i) => i.tenant_id === t && i.order_item_id === r.order_item_id && i.test_id === r.test_id)) continue;
          const row = { tenant_id: t, id: TAT(s.nextId++), version: 1, ...r } as TatItemRow & { tenant_id: string };
          s.items.push(row); out.push(strip(row) as TatItemRow);
        }
        return out;
      });
    },
    async updateItems(tx, t, actorId, patches) {
      return rec('updateItems', tx, t, [actorId, patches], () => {
        let n = 0;
        for (const p of patches) { const i = s.items.find((x) => x.tenant_id === t && x.id === p.id); if (i) { Object.assign(i, p.set); i.version += 1; n += 1; } }
        return n;
      });
    },
    async touchSeen(tx, t, ids, atIso) { return rec('touchSeen', tx, t, [ids, atIso], () => { let n = 0; for (const i of s.items) if (i.tenant_id === t && ids.includes(i.id)) { i.last_seen_sweep_at = atIso; n += 1; } return n; }); },
    async insertAlertEvents(tx, t, actorId, rows) {
      return rec('insertAlertEvents', tx, t, [actorId, rows], () => {
        let n = 0;
        for (const r of rows) if (!s.events.some((e) => e.tenant_id === t && e.tat_item_id === r.tat_item_id && e.restart_no === r.restart_no && e.level === r.level)) { s.events.push({ tenant_id: t, ...r }); n += 1; }
        return n;
      });
    },
    async deleteExpired(tx, t, nowIso) {
      return rec('deleteExpired', tx, t, [nowIso], () => {
        const gone = s.items.filter((i) => i.tenant_id === t && i.expires_at !== null && ms(i.expires_at) < ms(nowIso) && !s.events.some((e) => e.tenant_id === t && e.tat_item_id === i.id) && !s.acks.some((a) => a.tenant_id === t && a.tat_item_id === i.id));
        s.items = s.items.filter((i) => !gone.includes(i)); return gone.length;
      });
    },
    async listAlerts(tx, t, f, page) {
      return rec('listAlerts', tx, t, [f, page], () => {
        const rank = (i: TatItemRow) => RANK[i.alert_level] ?? 0;
        const pct = (i: TatItemRow) => (i.started_at ? Math.floor(((ms(f.now) - ms(i.started_at)) / 1000) * 100 / i.target_seconds) : 0);
        const covered = (i: TatItemRow) => i.acknowledged_level !== null && (RANK[i.acknowledged_level] ?? 0) >= rank(i);
        let rows = s.items.filter((i) => vis(i, t) && i.state === 'running' && rank(i) >= 1 && (!f.levels || f.levels.includes(i.alert_level)) && (f.acknowledged === undefined || covered(i) === f.acknowledged)
          && (!f.segment || i.segment === f.segment) && (!f.departmentId || i.department_id === f.departmentId) && (!f.centreId || i.centre_id === f.centreId) && (!f.priority || i.priority === f.priority)).map(strip) as TatItemRow[];
        const tie = (a: TatItemRow, b: TatItemRow) => (a.id < b.id ? -1 : 1);
        rows = rows.sort((a, b) => (f.sort === 'started_at' ? ms(a.started_at!) - ms(b.started_at!) || tie(a, b) : f.sort === '-pct_of_target' ? pct(b) - pct(a) || tie(a, b) : rank(b) - rank(a) || pct(b) - pct(a) || tie(a, b)));
        const start = page.cursor ? Number(Buffer.from(page.cursor, 'base64url').toString()) : 0;
        const slice = rows.slice(start, start + page.limit);
        return { rows: slice, ...(start + page.limit < rows.length ? { nextCursor: Buffer.from(String(start + page.limit)).toString('base64url') } : {}) };
      });
    },
    async getItem(tx, t, id) { return rec('getItem', tx, t, [id], () => { const i = s.items.find((x) => vis(x, t) && x.id === id); return i ? (strip(i) as TatItemRow) : undefined; }); },
    async listLevelEvents(tx, t, id) { return rec('listLevelEvents', tx, t, [id], () => s.events.filter((e) => vis(e, t) && e.tat_item_id === id).map(strip) as EventRow[]); },
    async listAcks(tx, t, id) { return rec('listAcks', tx, t, [id], () => s.acks.filter((a) => vis(a, t) && a.tat_item_id === id).map(strip) as AckRow[]); },
    async ack(tx, t, a) {
      return rec('ack', tx, t, [a], () => {
        const i = s.items.find((x) => vis(x, t) && x.id === a.id);
        if (!i || i.version !== a.expectedVersion) return undefined;
        s.acks.push({ tenant_id: t, tat_item_id: i.id, centre_id: i.centre_id, level: a.level, note: a.note, acknowledged_by_membership_id: a.membershipId, created_at: a.at, created_by: a.actorId });
        Object.assign(i, { acknowledged_level: a.level, acknowledged_at: a.at, acknowledged_by: a.membershipId, version: i.version + 1 });
        return strip(i) as TatItemRow;
      });
    },
    async listMembershipLabels(tx, t, ids) { return rec('listMembershipLabels', tx, t, [ids], () => s.labels.filter((l) => l.tenant_id === t && ids.includes(l.membership_id)).map(strip)); },
  };
  return { repo, calls, state: s, ops: () => calls.map((c) => c.op), itemById: (id: string) => s.items.find((i) => i.id === id), itemOf: (n: number) => s.items.find((i) => i.order_item_id === OIT(n)), eventsOf: (id: string) => s.events.filter((e) => e.tat_item_id === id) };
}
export type FakeTatRepo = ReturnType<typeof makeTatRepo>;

/** Real @lims/fakes CatalogPort with TESTS (+ spy on getTest). TST(2) carries tatTargetSegment 'total'; TST(1) has none (C3 default within_lab). */
export function makeCatalog(tenantId: string = TENANT_A) {
  const tests = TESTS.map((x) => ({ id: TST(x.n), tenantId, code: x.code, name: 'Synthetic test', departmentId: DEP(1), departmentCode: 'HAE', specimenTypeCodes: ['blood'], containerCode: 'edta', workflowType: 'standard', analytes: [], isActive: true, revision: 1,
    ...('seg' in x ? { tatTargetSegment: x.seg } : {}) }));
  const port = createFakeCatalogPort({ seed: 7, fixtures: { tests } as any });
  const getTestCalls: Array<{ testId: string; asOf?: unknown }> = [];
  const wrapped: any = { ...port, getTest: async (c: any, i: any) => { getTestCalls.push({ testId: i.testId, asOf: i.asOf }); return (port as any).getTest(c, i); } };
  return { port: wrapped, getTestCalls };
}
export function makeSettings(o: Partial<typeof SETTINGS> = {}) {
  const calls: Array<{ tx: unknown; who: { tenantId: string; actorId: string } }> = [];
  return { ensure: async (tx: unknown, who: { tenantId: string; actorId: string }) => { calls.push({ tx, who }); return { ...SETTINGS, ...o }; }, calls };
}
/** ctx for the service (setup.helpers makeCtx + CatalogPort + a metrics recorder). `now` = the clock. */
export function makeTatCtx(over: { tenantId?: string; roles?: (c: { permission: string; centreId?: string }) => void; now?: string; membershipId?: string | null } = {}) {
  const base = makeCtx({ ...(over.tenantId ? { tenantId: over.tenantId } : {}), ...(over.roles ? { roles: over.roles } : {}), ...(over.now ? { now: over.now } : {}) });
  const catalog = makeCatalog(over.tenantId ?? TENANT_A); base.ctx.ports.CatalogPort = catalog.port;
  if (over.membershipId === null) delete base.ctx.actor.membershipId;
  return { ...base, catalog };
}
export const FULL = ['quality.tat_alert.read', 'quality.tat_alert.ack'];
export const readOnlyTat = (r: { permission: string }) => { if (r.permission !== 'quality.tat_alert.read') throw new LimsError('auth.forbidden'); };
export const lims = (c: string) => new LimsError(c as any);
