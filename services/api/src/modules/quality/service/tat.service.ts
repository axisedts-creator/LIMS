// C9 T-19 — TAT sweep, consumers' stop logic and endpoints #48-#50 (02-TRD §9.1-§9.3, §5.7, §5.10, §10.2, §14; 03-APP-FLOW §2.4; PRD AC-14.1-14.8; 07-SECURITY S-02, S-03, REQ-SEC-024; 08 A17 D-59, P-18(c), P-21).
// The pure clock is domain/tat-clock.ts (T-18); this service loads -> transitions -> persists -> inserts events around it.
// WORKER methods (sweep, refreshOrder, applyVerified, applyRelease, purgeExpired): system actor, NO assertRole, tenant from ctx.tenantId only, repo calls on ctx.tx, never open a transaction, clock = ctx.now(),
//   created_by / updated_by = ctx.actor.id. A sweep costs a bounded number of statements (batched reads, one insert, one update, one touch, one event insert), independent of the item count.
// API methods: assertRole FIRST -> validate -> repo; reads are tenant + centre scoped by RLS (an invisible row is 404, S-02); the ack is guarded by If-Match (version) and unknown body fields are rejected (S-03).
// [CONV] a clock that is back in lab.v_pub_pending_items after it left (in_pending_view = false) is not re-marked: the domain (T-18) owns that state; see the impl notes.
import { LimsError, isLimsError } from '../../../core/errors.js';
import { TatClockError, transitionClock, type AlertLevel, type TatClock, type TatConfig, type TatSegment, type TatStartBasis, type TatState, type TatStopSource, type TatSweepItem, type TatTransition } from '../domain/tat-clock.js';
import { tatAlertDetailDto, tatAlertDto } from '../mappers/tat.mapper.js';
import { createTatRepo, type EventRow, type PendingRow, type TatItemRow, type TatRepo } from '../repository/tat.repo.js';
import { shape } from './plan.service.js';
import { createSettingsService } from './settings.service.js';
import type { Result } from './setup.service.js';
import { Errs, isUuid, paging, qBool, qUuid } from './setup.validate.js';

export interface TatCtx {
  readonly tenantId: string; readonly actor: { readonly id: string; readonly membershipId?: string }; readonly tx: any; readonly now: () => string; readonly ports?: any; readonly log?: any;
}
type Obj = Record<string, any>;
export interface SweepResult {
  seen: number; created: number; raised: Array<{ level: string; segment: string; lagSeconds: number }>; stopped: number; cancelled: number; orphanClosed: number;
  openAlerts: { warning: number; breached: number; escalated: number };
}
export interface TatSettings { tatAlertsEnabled: boolean; tatWarnPct: number; tatEscalatePct: number; tatOrphanCloseHours: number }

const READ = 'quality.tat_alert.read', ACK = 'quality.tat_alert.ack';
const LEVELS = ['warning', 'breached', 'escalated'] as const;
const SORTS = ['-alert_level_rank', '-pct_of_target', 'started_at'] as const;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const NOTE_MAX = 500;
const ACK_CFG: TatConfig = { warnPct: 80, escalatePct: 150, orphanCloseHours: 72 };   // the ack transition reads none of it
const empty = (): SweepResult => ({ seen: 0, created: 0, raised: [], stopped: 0, cancelled: 0, orphanClosed: 0, openAlerts: { warning: 0, breached: 0, escalated: 0 } });

const assert = (ctx: TatCtx, permission: string): Promise<void> => ctx.ports.IdentityPort.assertRole(ctx, { permission });
const invalid = (): never => { throw new LimsError('common.validation_failed'); };
const isoUtc = (v: unknown): v is string => typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));
const D = (v: string | null): Date | null => (v === null ? null : new Date(v));
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const sameTs = (a: string | null, b: Date | null): boolean => (a === null ? b === null : b !== null && Date.parse(a) === b.getTime());
const keyOf = (a: { order_item_id: string; test_id: string }): string => `${a.order_item_id}:${a.test_id}`;
const OPEN = new Set(['not_started', 'running']);

/** LimsErrors pass; a clock refusal keeps its code (409); anything else (driver text, missing data) is common.internal. */
function fail(err: unknown): never {
  if (isLimsError(err)) throw err;
  if (err instanceof TatClockError) throw new LimsError(err.code as 'common.immutable_record');
  throw new LimsError('common.internal');
}

const toClock = (r: TatItemRow): TatClock => ({
  orderItemId: r.order_item_id, testId: r.test_id, segment: r.segment, state: r.state as TatState, alertLevel: r.alert_level as AlertLevel, targetSeconds: r.target_seconds, specimenId: r.specimen_id,
  startedAt: D(r.started_at), startBasis: r.start_basis as TatStartBasis, stoppedAt: D(r.stopped_at), stopSource: r.stop_source as TatStopSource | null, restartCount: r.restart_count,
  acknowledgedLevel: r.acknowledged_level as AlertLevel | null, inPendingView: r.in_pending_view, firstVerifiedAt: D(r.first_verified_at), leftPendingViewAt: D(r.left_pending_view_at), expiresAt: D(r.expires_at),
});

/** The columns of `row` that `c` changes (DB names). alert_level_at follows the level; an ack that the clock cleared (restart) clears its three columns. start_basis never goes back to null. */
function patchOf(row: TatItemRow, c: TatClock, nowIso: string): Obj {
  const p: Obj = {};
  if (row.state !== c.state) p['state'] = c.state;
  if (!sameTs(row.started_at, c.startedAt)) p['started_at'] = iso(c.startedAt);
  if (!sameTs(row.stopped_at, c.stoppedAt)) p['stopped_at'] = iso(c.stoppedAt);
  if (row.stop_source !== c.stopSource) p['stop_source'] = c.stopSource;
  if (row.restart_count !== c.restartCount) p['restart_count'] = c.restartCount;
  if (!sameTs(row.first_verified_at, c.firstVerifiedAt)) p['first_verified_at'] = iso(c.firstVerifiedAt);
  if (row.in_pending_view !== c.inPendingView) p['in_pending_view'] = c.inPendingView;
  if (!sameTs(row.left_pending_view_at, c.leftPendingViewAt)) p['left_pending_view_at'] = iso(c.leftPendingViewAt);
  if (!sameTs(row.expires_at, c.expiresAt)) p['expires_at'] = iso(c.expiresAt);
  if (c.startBasis !== null && row.start_basis !== c.startBasis) p['start_basis'] = c.startBasis;
  if (c.specimenId !== null && row.specimen_id !== c.specimenId) p['specimen_id'] = c.specimenId;
  if (row.alert_level !== c.alertLevel) { p['alert_level'] = c.alertLevel; p['alert_level_at'] = c.alertLevel === 'none' ? null : nowIso; }
  if (row.acknowledged_level !== c.acknowledgedLevel) {
    p['acknowledged_level'] = c.acknowledgedLevel;
    if (c.acknowledgedLevel === null) { p['acknowledged_at'] = null; p['acknowledged_by'] = null; }
  }
  return p;
}

/** Seconds after started_at at which `level` is crossed (thresholds are inclusive: pct >= threshold). */
const thresholdSeconds = (level: string, target: number, cfg: TatConfig): number => (level === 'warning' ? cfg.warnPct : level === 'breached' ? 100 : cfg.escalatePct) * target / 100;

export function createTatService(deps: { repo?: TatRepo; settings?: { ensure(tx: any, who: { tenantId: string; actorId: string }): Promise<TatSettings> } } = {}) {
  const repo = deps.repo ?? createTatRepo();
  let defaultSettings: ReturnType<typeof createSettingsService> | undefined;
  const settings = (): NonNullable<typeof deps.settings> => deps.settings ?? (defaultSettings ??= createSettingsService());

  /** §9.3 steps 1-5 for the tenant (no scope) or steps 1-4 for one order (scope.orderId). The first statement of a sweep is settings.ensure; a disabled tenant reads nothing else. */
  async function run(ctx: TatCtx, scope: { orderId?: string }): Promise<SweepResult> {
    const t = ctx.tenantId, tx = ctx.tx, actor = ctx.actor.id;
    const s = await settings().ensure(tx, { tenantId: t, actorId: actor });
    const res = empty();
    if (!s.tatAlertsEnabled) return res;
    const cfg: TatConfig = { warnPct: s.tatWarnPct, escalatePct: s.tatEscalatePct, orphanCloseHours: s.tatOrphanCloseHours };
    const nowIso = new Date(ctx.now()).toISOString(), now = new Date(nowIso), nowMs = now.getTime();

    // 1. the open tests (an item without a target never gets a clock: AC-14.5) and the clocks that already exist for them
    const pending = new Map<string, PendingRow>();
    for (const p of await repo.listPending(tx, t, scope)) if (p.tat_target_seconds !== null) pending.set(keyOf(p), p);
    res.seen = pending.size;
    const existing = new Map<string, TatItemRow>();
    if (pending.size) for (const r of await repo.findItems(tx, t, [...pending.values()].map((p) => ({ order_item_id: p.order_item_id, test_id: p.test_id })))) existing.set(keyOf(r), r);
    const fresh = [...pending.entries()].filter(([k]) => !existing.has(k)).map(([, p]) => p);

    // segment of a NEW clock: one CatalogPort.getTest per distinct test (absent tatTargetSegment = within_lab); frozen on the row afterwards
    const segments = new Map<string, TatSegment>();
    // ponytail: one parallel getTest per distinct NEW test; batch it if a tenant ever creates hundreds of new distinct tests in one sweep
    await Promise.all([...new Set(fresh.map((p) => p.test_id))].map(async (testId) => {
      const test = await ctx.ports.CatalogPort.getTest(ctx, { testId, asOf: nowIso });
      segments.set(testId, test?.tatTargetSegment === 'total' ? 'total' : 'within_lab');
    }));

    // start of a NEW total clock: registered_at of the order (D-59), else the earliest specimen ordered_at; each source is read only for the orders that need it
    const starts = new Map<string, { at: Date; basis: 'registered_at' | 'specimen_ordered_at' }>();
    const totalOrders = [...new Set(fresh.filter((p) => segments.get(p.test_id) === 'total').map((p) => p.order_id))];
    if (totalOrders.length) {
      for (const r of await repo.listTotalStarts(tx, t, totalOrders)) starts.set(r.order_id, { at: new Date(r.registered_at), basis: 'registered_at' });
      const missing = totalOrders.filter((o) => !starts.has(o));
      if (missing.length) for (const r of await repo.listEarliestOrdered(tx, t, missing)) starts.set(r.order_id, { at: new Date(r.ordered_at), basis: 'specimen_ordered_at' });
    }

    const patches = new Map<string, Obj>(), touch: string[] = [], events: EventRow[] = [];
    const created: Array<{ row: Omit<TatItemRow, 'id' | 'version'>; levels: AlertLevel[]; startedAt: Date | null }> = [];
    const lag = (level: string, c: TatClock) => Math.max(0, Math.floor((nowMs - c.startedAt!.getTime()) / 1000 - thresholdSeconds(level, c.targetSeconds, cfg)));
    const count = (tr: TatTransition[]) => { for (const x of tr) { if (x === 'TC8') res.stopped++; else if (x === 'TC9') res.cancelled++; else if (x === 'TC10') res.orphanClosed++; } };
    const raise = (row: Pick<TatItemRow, 'id' | 'centre_id'>, c: TatClock, levels: AlertLevel[]) => {
      for (const level of levels) {
        events.push({ tat_item_id: row.id, centre_id: row.centre_id, level, raised_at: nowIso, elapsed_seconds: Math.floor((nowMs - c.startedAt!.getTime()) / 1000), restart_no: c.restartCount });
        res.raised.push({ level, segment: c.segment, lagSeconds: lag(level, c) });
      }
    };

    // 2./3. create, start / restart, level recompute
    const finalRows = new Map<string, TatItemRow>();
    for (const [key, p] of pending) {
      const row = existing.get(key);
      const item: TatSweepItem = { orderItemId: p.order_item_id, testId: p.test_id, segment: row?.segment ?? segments.get(p.test_id) ?? 'within_lab', targetSeconds: p.tat_target_seconds, specimenId: p.specimen_id,
        receivedAt: D(p.received_at), itemStatus: p.item_status, totalStart: starts.get(p.order_id) ?? null };
      const r = transitionClock(row ? toClock(row) : null, { type: 'sweep', now, item }, cfg);
      const c = r.clock;
      if (!row) {
        if (!c) continue;   // a total clock with no start yet: the next sweep creates it
        created.push({ levels: r.alertEvents, startedAt: c.startedAt, row: {
          centre_id: p.centre_id, order_id: p.order_id, order_item_id: p.order_item_id, test_id: p.test_id, specimen_id: p.specimen_id, department_id: p.department_id, priority: p.priority, segment: c.segment,
          target_seconds: c.targetSeconds, start_basis: c.startBasis ?? 'specimen_received_at', state: c.state, started_at: iso(c.startedAt), stopped_at: iso(c.stoppedAt), stop_source: c.stopSource, restart_count: c.restartCount,
          first_verified_at: iso(c.firstVerifiedAt), in_pending_view: true, left_pending_view_at: iso(c.leftPendingViewAt), last_seen_sweep_at: nowIso, alert_level: c.alertLevel,
          alert_level_at: c.alertLevel === 'none' ? null : nowIso, acknowledged_level: null, acknowledged_at: null, acknowledged_by: null, expires_at: iso(c.expiresAt) } });
        continue;
      }
      if (!OPEN.has(row.state) || !c) continue;   // stopped / cancelled / orphan_closed: final for sweeps, nothing is written
      const patch = patchOf(row, c, nowIso);
      count(r.transitions);
      raise(row, c, r.alertEvents);
      if (Object.keys(patch).length) { patches.set(row.id, { ...patch, last_seen_sweep_at: nowIso }); finalRows.set(row.id, { ...row, ...patch, last_seen_sweep_at: nowIso } as TatItemRow); }
      else touch.push(row.id);
    }

    // 4./5. open clocks that left the view: cancel, or keep a verified total running (in_pending_view = false) and close it as an orphan after tat_orphan_close_hours; running ones still rise
    const open = await repo.listOpenItems(tx, t, scope);
    for (const row of open) {
      if (pending.has(keyOf(row)) || finalRows.has(row.id)) { if (!finalRows.has(row.id)) finalRows.set(row.id, row); continue; }
      let c = toClock(row);
      const levels: AlertLevel[] = [];
      for (const ev of [{ type: 'left_view', now }, { type: 'orphan_check', now }, { type: 'tick', now }] as const) {
        const r = transitionClock(c, ev, cfg);
        c = r.clock!; levels.push(...r.alertEvents); count(r.transitions);
      }
      const patch = patchOf(row, c, nowIso);
      raise(row, c, levels);
      finalRows.set(row.id, Object.keys(patch).length ? { ...row, ...patch } as TatItemRow : row);
      if (Object.keys(patch).length) patches.set(row.id, patch);
    }

    // writes: ONE statement each. A concurrent creator that won the insert race returns nothing for its key: no event, not counted.
    const inserted = created.length ? await repo.insertItems(tx, t, actor, created.map((c) => c.row)) : [];
    const insertedByKey = new Map(inserted.map((r) => [keyOf(r), r]));
    res.created = inserted.length;
    for (const c of created) {
      const row = insertedByKey.get(keyOf(c.row));
      if (!row) continue;
      finalRows.set(row.id, row);
      if (c.levels.length) raise(row, { ...toClock(row), startedAt: c.startedAt }, c.levels);
    }
    if (events.length) await repo.insertAlertEvents(tx, t, actor, events);
    if (patches.size) await repo.updateItems(tx, t, actor, [...patches].map(([id, set]) => ({ id, set })));
    if (touch.length) await repo.touchSeen(tx, t, touch, nowIso);

    for (const r of finalRows.values()) if (r.state === 'running' && (LEVELS as readonly string[]).includes(r.alert_level)) res.openAlerts[r.alert_level as (typeof LEVELS)[number]]++;
    return res;
  }

  // ------------------------------------------------------------------------------------------------ API helpers
  const label = async (ctx: TatCtx, ids: string[]): Promise<Map<string, string>> =>
    new Map((ids.length ? await repo.listMembershipLabels(ctx.tx, ctx.tenantId, [...new Set(ids)]) : []).map((l) => [l.membership_id, l.display]));
  /** One getTest per DISTINCT test. */
  async function testCodes(ctx: TatCtx, testIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>(), asOf = new Date(ctx.now()).toISOString();
    await Promise.all([...new Set(testIds)].map(async (testId) => {
      const code = (await ctx.ports.CatalogPort.getTest(ctx, { testId, asOf }))?.code;
      if (typeof code !== 'string') throw new LimsError('common.internal');
      out.set(testId, code);
    }));
    return out;
  }
  const levelCsv = (e: Errs, v: unknown): string[] | undefined => {
    if (v === undefined) return undefined;
    const parts = typeof v === 'string' ? v.split(',') : undefined;
    if (!parts || parts.some((x) => !(LEVELS as readonly string[]).includes(x))) { e.add('/level'); return undefined; }
    return parts;
  };
  const oneOf = <V extends string>(e: Errs, v: unknown, k: string, allowed: readonly V[]): V | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !allowed.includes(v as V)) { e.add(`/${k}`); return undefined; }
    return v as V;
  };

  return {
    // ---------------------------------------------------------------------------------------------- worker methods
    /** quality.tat_sweep (cron, per tenant). */
    sweep: (ctx: TatCtx): Promise<SweepResult> => run(ctx, {}),

    /** quality.tat_refresh_order: §9.3 steps 1-4 for ONE order; items of other orders are never touched. */
    async refreshOrder(ctx: TatCtx, i: { orderId: unknown }): Promise<SweepResult> {
      if (!isUuid(i.orderId)) return invalid();
      return run(ctx, { orderId: i.orderId });
    },

    /** lab.result.verified.v1: within_lab -> stopped at verified_at (earliest wins, also from cancelled); total -> first_verified_at only. No clock = no-op. */
    async applyVerified(ctx: TatCtx, i: { orderItemId: unknown; testId: unknown; verifiedAt: unknown }): Promise<void> {
      if (!isUuid(i.orderItemId) || !isUuid(i.testId) || !isoUtc(i.verifiedAt)) return invalid();
      const [row] = await repo.findItems(ctx.tx, ctx.tenantId, [{ order_item_id: i.orderItemId, test_id: i.testId }]);
      if (!row) return;
      const { clock } = transitionClock(toClock(row), { type: 'verified', verifiedAt: new Date(i.verifiedAt) }, ACK_CFG);
      const patch = clock ? patchOf(row, clock, new Date(ctx.now()).toISOString()) : {};
      if (Object.keys(patch).length) await repo.updateItems(ctx.tx, ctx.tenantId, ctx.actor.id, [{ id: row.id, set: patch }]);
    },

    /** reporting.report.released.v1: only report_kind final | partial can stop a total clock (x-extensible: any other kind, known or not, is a no-op). One batched update. */
    async applyRelease(ctx: TatCtx, i: { orderId: unknown; reportKind: unknown; orderItemIds?: unknown; releasedAt: unknown }): Promise<void> {
      const ids = i.orderItemIds;
      if (!isUuid(i.orderId) || typeof i.reportKind !== 'string' || !isoUtc(i.releasedAt) || (ids !== undefined && (!Array.isArray(ids) || !ids.every(isUuid)))) return invalid();
      if (i.reportKind !== 'final' && i.reportKind !== 'partial') return;
      const releasedAt = new Date(i.releasedAt), nowIso = new Date(ctx.now()).toISOString(), patches: Array<{ id: string; set: Obj }> = [];
      for (const row of await repo.listItemsByOrder(ctx.tx, ctx.tenantId, i.orderId)) {
        const { clock } = transitionClock(toClock(row), { type: 'release', releasedAt, reportKind: i.reportKind, ...(ids !== undefined ? { orderItemIds: ids as string[] } : {}) }, ACK_CFG);
        const patch = clock ? patchOf(row, clock, nowIso) : {};
        if (Object.keys(patch).length) patches.push({ id: row.id, set: patch });
      }
      if (patches.length) await repo.updateItems(ctx.tx, ctx.tenantId, ctx.actor.id, patches);
    },

    /** quality.purge_tat_items (P-18(c)): expired rows without alert events / acks, this tenant only; the cut-off is the job clock. */
    async purgeExpired(ctx: TatCtx): Promise<{ deleted: number }> {
      return { deleted: await repo.deleteExpired(ctx.tx, ctx.tenantId, new Date(ctx.now()).toISOString()) };
    },

    // ---------------------------------------------------------------------------------------------- API
    /** #48 (AC-14.1, 14.6-14.8) */
    async listTatAlerts(ctx: TatCtx, q: Obj = {}): Promise<Result> {
      await assert(ctx, READ);
      try {
        const e = new Errs(), pg = paging(e, q);
        const levels = levelCsv(e, q['level']), acknowledged = qBool(e, q, 'acknowledged', 'acknowledged'), segment = oneOf(e, q['segment'], 'segment', ['within_lab', 'total'] as const);
        const departmentId = qUuid(e, q, 'departmentId', 'department_id'), centreId = qUuid(e, q, 'centreId', 'centre_id'), priority = oneOf(e, q['priority'], 'priority', ['routine', 'urgent'] as const);
        const sort = oneOf(e, q['sort'], 'sort', SORTS) ?? SORTS[0];
        e.done();
        const nowIso = new Date(ctx.now()).toISOString();
        const page = await repo.listAlerts(ctx.tx, ctx.tenantId, {
          ...(levels !== undefined ? { levels } : {}), ...(acknowledged !== undefined ? { acknowledged } : {}), ...(segment !== undefined ? { segment } : {}), ...(departmentId !== undefined ? { departmentId } : {}),
          ...(centreId !== undefined ? { centreId } : {}), ...(priority !== undefined ? { priority } : {}), sort, now: nowIso }, pg);
        const [codes, labels] = [await testCodes(ctx, page.rows.map((r) => r.test_id)), await label(ctx, page.rows.flatMap((r) => (r.acknowledged_by ? [r.acknowledged_by] : [])))];
        const nowMs = Date.parse(nowIso);
        return { status: 200, body: { data: page.rows.map((r) => tatAlertDto(r, { testCode: codes.get(r.test_id)!, nowMs, labels })), page: { limit: pg.limit, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) }, generated_at: nowIso } };
      } catch (err) { return fail(err); }
    },

    /** #49: the alert with its level history and acknowledgements; ETag = the item version (If-Match of #50). */
    async getTatAlert(ctx: TatCtx, i: { tatItemId: unknown }): Promise<Result> {
      await assert(ctx, READ);
      try {
        if (!isUuid(i.tatItemId)) return invalid();
        const row = await repo.getItem(ctx.tx, ctx.tenantId, i.tatItemId);
        if (!row) throw new LimsError('common.not_found');   // unknown, another tenant's, or a centre the reader cannot see: the same 404 (S-02)
        const [events, acks] = [await repo.listLevelEvents(ctx.tx, ctx.tenantId, row.id), await repo.listAcks(ctx.tx, ctx.tenantId, row.id)];
        const [codes, labels] = [await testCodes(ctx, [row.test_id]), await label(ctx, [...acks.map((a) => a.acknowledged_by_membership_id), ...(row.acknowledged_by ? [row.acknowledged_by] : [])])];
        return { status: 200, version: row.version, body: tatAlertDetailDto(row, { testCode: codes.get(row.test_id)!, nowMs: Date.parse(ctx.now()), labels, events, acks }) };
      } catch (err) { return fail(err); }
    },

    /** #50 (AC-14.6): acknowledge the CURRENT level of a running alert. A later, higher level is a new unacknowledged alert (it can be acknowledged again, appending a row). */
    async acknowledgeTatAlert(ctx: TatCtx, i: { tatItemId: unknown; expectedVersion?: number | undefined; body: unknown }): Promise<Result> {
      await assert(ctx, ACK);
      try {
        if (!isUuid(i.tatItemId)) return invalid();
        const e = new Errs(), o = shape(e, i.body, ['note']);
        let note: string | null = null;
        if (o && o['note'] !== undefined) { const n = o['note']; if (typeof n !== 'string' || [...n].length > NOTE_MAX) e.add('/note'); else note = n; }
        e.done();
        const membershipId = ctx.actor.membershipId;
        if (typeof membershipId !== 'string') throw new LimsError('common.internal');   // the ack row needs the actor's membership; fail closed
        if (i.expectedVersion === undefined) throw new LimsError('common.precondition_required');
        const row = await repo.getItem(ctx.tx, ctx.tenantId, i.tatItemId);
        if (!row) throw new LimsError('common.not_found');
        if (row.version !== i.expectedVersion) throw new LimsError('common.version_conflict');
        transitionClock(toClock(row), { type: 'ack' }, ACK_CFG);   // TC11; stopped / cancelled / not_started / orphan_closed / level none -> common.immutable_record
        const updated = await repo.ack(ctx.tx, ctx.tenantId, { id: row.id, expectedVersion: i.expectedVersion, level: row.alert_level, note, at: new Date(ctx.now()).toISOString(), membershipId, actorId: ctx.actor.id });
        if (!updated) throw new LimsError('common.version_conflict');   // lost the race (or the row vanished from the reader's centres)
        const [codes, labels] = [await testCodes(ctx, [updated.test_id]), await label(ctx, [membershipId])];
        return { status: 200, version: updated.version, body: tatAlertDto(updated, { testCode: codes.get(updated.test_id)!, nowMs: Date.parse(ctx.now()), labels }) };
      } catch (err) { return fail(err); }
    },
  };
}
export type TatService = ReturnType<typeof createTatService>;
