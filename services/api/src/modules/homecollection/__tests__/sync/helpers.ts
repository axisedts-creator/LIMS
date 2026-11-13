// HC-T12 harness: A3 pushSyncMutations (POST /v1/homecollection/sync/mutations, `homecollection.sync.upload`), 02-TRD §6.3 / §8.1, 03-APP-FLOW §4 (guards) + §5.4/§5.7, 01-PRD US-07 (server side) / US-08 / US-12-1,3,
// 07-SECURITY AB2-AB6, AB14, AB15 + §5.1-5.3. Same convention as ../snapshot/helpers.ts (HC-T11): the handler under test is taken from the module manifest and driven with a request-shaped object and a
// HandlerContext over a REAL PG17 tx (lims_api, RLS on). The core pipeline (OpenAPI validation, auth, x-permission, the Idempotency-Key replay hook of 02-CV §4.5) is NOT re-tested: a replay of the SAME batch_id never
// reaches the handler (TRD §6.3 step 2), so "replay" here = the same mutations in a NEW batch (E2 / AB3).
// ASSUMED ctx (TRD §6.4, as HC-T11) plus: ctx.events = the REAL core createEvents({producer:'homecollection'}) (events land in core.event_log inside the push tx and are read back with the owner role);
//   tx.startedAt is set by this harness (the core tx wrapper provides it in production); ports.LabPort.lookupSpecimens is a FAKE serving the specimens seeded per test (it records every call and can fail);
//   IdentityPort.assertRole fails with auth.forbidden for permissions the caller lacks and for `fx.deniedCentres`. The sync service may publish through ctx.events or build its own createEvents: both reach core.event_log.
// Synthetic data only. Env: LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL, exported by tests/homecollection/HC-T12.pg.sh.
import { createHash } from 'node:crypto';
import { LimsError } from '../../../../core/errors.js';
import { access } from '../../../../core/audit/access.js';
import { createEvents } from '../../../../core/events/publish.js';
import { manifest } from '../../index.js';
import { HC_CENTRE, OTHER_CENTRE, appTx, hc, seed } from '../../repository/__tests__/helpers.js';
import { DISPATCHER, MEMBER, MEMBER2, NOBODY, P, PHLEBO, PHLEBO2, SYS_ACTOR, T, TENANT_A, TENANT_B, nameOf, ownerRows, rejection, req, superTx, uid, type Who } from '../visits/helpers.js';
import { APP, hdr, v7 } from '../devices/helpers.js';
import { ensureSettings, seedVisit, mkRoute, seedDevice, setSettings } from '../snapshot/helpers.js';
import { T0 } from '../../repository/__tests__/helpers.js';

export { DISPATCHER, MEMBER, MEMBER2, NOBODY, P, PHLEBO, PHLEBO2, SYS_ACTOR, T, TENANT_A, TENANT_B, HC_CENTRE, OTHER_CENTRE, APP, hdr, hc, nameOf, ownerRows, rejection, req, seed, superTx, uid, v7, setSettings, ensureSettings };
export type { Who };
export const PHLEBO_B: Who = { tenant: TENANT_B, membershipId: MEMBER.b, grants: [P.read, P.sync] };
export const EVENT = 'homecollection.collection.synced.v1';
export const ASSIGNED_AT = '2027-02-28T10:00:00.000Z';
const NOT_FOUND_VISIT = '01a1a98a-ac40-7000-8000-00000000dead';
void NOT_FOUND_VISIT;

// ---------------------------------------------------------------- the lab fake
export interface SpecRef { specimenId: string; barcode: string; orderId: string; patientId: string; centreId: string; specimenTypeCode: string; status: string; isActive: boolean; version: number }
export interface Fx {
  /** lookupSpecimens fails (every order) with a LimsError / plain Error */
  labFails?: boolean; labPlain?: boolean;
  /** override what lookupSpecimens serves per order (default: the specimens seeded for the order, as `ordered` + active) */
  lab?: Record<string, readonly Partial<SpecRef>[]>;
  /** centres where assertRole(.., {centreId}) fails with auth.forbidden */
  deniedCentres?: readonly string[];
}
export interface Probe { requestId: string; lab: Array<Record<string, unknown>>; identity: Array<{ permission: string; centreId?: string }>; logs: string[] }
export interface Reply { status: number; body: any; headers?: Record<string, string>; probe: Probe }
export interface OpOpts { fx?: Fx; now?: Date; headers?: object; who?: Who; bypassRls?: boolean }

const H = manifest.handlers as unknown as Record<string, (r: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const specStore = new Map<string, SpecRef[]>();   // orderId -> seeded specimens (what LabPort serves)
const events = createEvents({ producer: 'homecollection' });

export async function op(operationId: string, r: ReturnType<typeof req>, who: Who, o: OpOpts = {}): Promise<Reply> {
  const side = who.tenant === TENANT_B ? 'b' : 'a';
  const fx = o.fx ?? {};
  const now = o.now ?? new Date('2028-02-01T06:00:00.000Z');
  const probe: Probe = { logs: [], requestId: uid(), lab: [], identity: [] };
  const run = async (tx: any) => {
    tx.startedAt = now;   // the core tx wrapper's field; core publish stamps occurred_at from it
    const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }, metrics: { inc: () => undefined },
      tenantId: who.tenant, tx, requestId: probe.requestId, now: () => now, centreId: HC_CENTRE[side],
      actor: { type: 'user', id: SYS_ACTOR, membershipId: who.membershipId },
      db: { tx: async (fn: (c: any) => Promise<unknown>) => fn(ctx) },
      ports: {
        IdentityPort: {
          async assertRole(_c: unknown, a: { permission: string; centreId?: string }) {
            probe.identity.push({ permission: a?.permission, ...(a?.centreId ? { centreId: a.centreId } : {}) });
            if (!who.grants.includes(a?.permission)) throw new LimsError('auth.forbidden');
            if (a?.centreId && fx.deniedCentres?.includes(a.centreId)) throw new LimsError('auth.forbidden');
          },
          async getActor() {
            return { actor: { type: 'user', id: SYS_ACTOR, membershipId: who.membershipId }, displayName: 'Synthetic Caller', roles: [], permissions: [...who.grants], centreScope: { all: true, centreIds: [] },
              branchIds: [], mfa: { enrolled: false, level: 'aal1' }, isLocked: false };
          },
          async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
        },
        LabPort: {
          async lookupSpecimens(_c: unknown, a: { orderId: string; statuses?: string[]; specimenIds?: string[] }) {
            probe.lab.push({ ...a });
            if (fx.labFails) throw fx.labPlain ? new Error('synthetic lab outage') : new LimsError('common.dependency_unavailable');
            const base = specStore.get(a.orderId) ?? [];
            const over = fx.lab?.[a.orderId];
            return over ? over.map((x, i) => ({ ...base[i], ...x })) : base;
          },
        },
      },
      events,
      core: { memberships: { async list() { return []; } }, async user(_c: unknown, a: { userId: string }) { return { id: a.userId, displayName: 'Synthetic User', isActive: true }; } },
      audit: { access: (e: any) => access(ctx, e) },
      commitOnError: () => undefined,
    };
    return H[operationId]!(r, ctx);
  };
  try {
    const out = await (o.bypassRls ? superTx(run, who.tenant) : appTx(who.tenant, run));
    return { ...(out as any), probe };
  } catch (e) { if (e && typeof e === 'object') (e as any).probe = probe; throw e; }
}

// ---------------------------------------------------------------- dates / ids
const BASE_DAY = Date.UTC(2028, 1, 1);   // after every date the earlier HC suites use; 120 days per test file, one route date per world
let used = 0;
export const nextDay = (file: number): string => new Date(BASE_DAY + (file * 120 + used++) * 86400000).toISOString().slice(0, 10);
export const noonOf = (date: string): Date => new Date(`${date}T06:00:00.000Z`);
export const at = (date: string, hhmm: string, sec = 0): string => `${date}T${hhmm}:${String(sec).padStart(2, '0')}.000Z`;

let registryDone = false;
/** Test-DB fixture only (HC-T09 ruling): app.enqueue_job needs the task identifiers in core.g_task_registry; the HC-T03 boot does not run registry-sync. core publish enqueues `core.event_fanout`. */
export async function ensureTaskRegistry(): Promise<void> {
  if (registryDone) return;
  await superTx(async (tx: any) => {
    await tx.query(`INSERT INTO core.g_task_registry (identifier,module,kind,scope,max_attempts) VALUES ('core.event_fanout','core','core','per_tenant',10) ON CONFLICT DO NOTHING`);
    await tx.query(`INSERT INTO core.g_task_registry (identifier,module,kind,scope,max_attempts) VALUES ('homecollection.refresh_visit_specimens','homecollection','task','per_tenant',10) ON CONFLICT DO NOTHING`);
  });
  registryDone = true;
}

// ---------------------------------------------------------------- the world of one push test
export interface PushWorld {
  s: 'a' | 'b'; date: string; now: Date; who: Who; member: string; device: any; route: any; visit: any; patient: any; order: any; specimens: SpecRef[]; anchorId: string;
  /** next device_seq (1-based, consecutive inside the world) */
  seq: () => number;
}
export interface WorldOpts {
  s?: 'a' | 'b'; file?: number;
  /** the phlebotomist whose device pushes (default MEMBER[s]) */
  member?: string;
  /** assignment history oldest first; the LAST entry is the current assignee (default: the device's member since ASSIGNED_AT) */
  assignees?: Array<{ member: string; at: string }>;
  status?: string; kind?: 'front_desk' | 'booking'; specimens?: number; types?: string[]; deviceExtra?: Record<string, unknown>;
  visitExtra?: Record<string, unknown>; centreId?: string; settings?: Record<string, unknown>;
}
const pad = (n: number) => String(n).padStart(2, '0');
// per-run unique barcode (module-level counters restart in every spec file; parallel files would collide). A-Z0-9, 17 chars.
const nextBarcode = (s: string) => `HC12${uid().replace(/-/g, '').slice(-12).toUpperCase()}${s.toUpperCase()}`;
export async function pushWorld(o: WorldOpts = {}): Promise<PushWorld> {
  await ensureTaskRegistry();
  const s = o.s ?? 'a';
  await ensureSettings(s, o.settings);
  const date = nextDay(o.file ?? 0);
  const member = o.member ?? MEMBER[s];
  const who: Who = { tenant: s === 'a' ? TENANT_A : TENANT_B, membershipId: member, grants: [P.read, P.sync] };
  // an assignee `at` of the form '@HH:MM' means that time of day on the route date (so a reassignment can fall between a capture and the push)
  const when = (t: string) => (t.startsWith('@') ? at(date, t.slice(1)) : t);
  const history = (o.assignees ?? [{ member, at: ASSIGNED_AT }]).map((a) => ({ member: a.member, at: when(a.at) }));
  const cur = history.at(-1)!.member;
  const route = await mkRoute(s, cur, date);
  const sv = await seedVisit(s, { route, member: cur, seq: 1, date, status: o.status ?? 'assigned', extra: { ...(o.centreId ? { centre_id: o.centreId } : {}), ...(o.kind === 'booking' ? { kind: 'booking', booking_id: uid(), orderable_ids: [uid()] } : {}),
    assigned_at: history.at(-1)!.at, ...(o.visitExtra ?? {}) } });
  for (const a of history) {
    await seed('homecollection.visit_assignments', hc.assignment(s, sv.row.id, route.id, { membership_id: a.member, route_date: date, action: 'assign', created_at: a.at, centre_id: o.centreId ?? HC_CENTRE[s] }));
  }
  const n = o.specimens ?? 2;
  const specimens: SpecRef[] = [];
  for (let i = 0; i < n; i++) {
    const row = { id: uid(), tenant_id: sv.order.tenant_id, centre_id: o.centreId ?? HC_CENTRE[s], order_id: sv.order.id, patient_id: sv.patient.id, barcode: nextBarcode(s), creation_key: `hct12-${uid()}`,
      specimen_type_code: o.types?.[i] ?? (i % 2 ? 'EDTA' : 'SST'), priority: 'routine', patient_sex: 'female', status: 'ordered', ordered_at: T0 };
    await seed('lab.specimens', row);
    specimens.push({ specimenId: row.id, barcode: row.barcode, orderId: sv.order.id, patientId: sv.patient.id, centreId: row.centre_id, specimenTypeCode: row.specimen_type_code, status: 'ordered', isActive: true, version: 1 });
  }
  specStore.set(sv.order.id, specimens);
  const device = await seedDevice(s, { membership_id: member, ...(o.deviceExtra ?? {}) });
  let k = 0;
  return { s, date, now: noonOf(date), who, member, device, route, visit: sv.row, patient: sv.patient, order: sv.order, specimens, anchorId: v7(), seq: () => ++k };
}
/** Another visit (own order + specimens) for the SAME device/phlebotomist on the SAME route (second order of a batch, other centre, ...). */
export async function addVisit(w: PushWorld, o: { specimens?: number; centreId?: string; status?: string; seq?: number; assignedTo?: string; id?: string } = {}): Promise<{ visit: any; order: any; specimens: SpecRef[] }> {
  const sv = await seedVisit(w.s, { route: w.route, member: o.assignedTo ?? w.member, seq: o.seq ?? 2, date: w.date, status: o.status ?? 'assigned', extra: { ...(o.centreId ? { centre_id: o.centreId } : {}), ...(o.id ? { id: o.id } : {}), assigned_at: ASSIGNED_AT } });
  await seed('homecollection.visit_assignments', hc.assignment(w.s, sv.row.id, w.route.id, { membership_id: o.assignedTo ?? w.member, route_date: w.date, action: 'assign', created_at: ASSIGNED_AT, centre_id: o.centreId ?? HC_CENTRE[w.s] }));
  const specimens: SpecRef[] = [];
  for (let i = 0; i < (o.specimens ?? 1); i++) {
    const row = { id: uid(), tenant_id: sv.order.tenant_id, centre_id: o.centreId ?? HC_CENTRE[w.s], order_id: sv.order.id, patient_id: sv.patient.id, barcode: nextBarcode(w.s), creation_key: `hct12-${uid()}`,
      specimen_type_code: i % 2 ? 'EDTA' : 'SST', priority: 'routine', patient_sex: 'female', status: 'ordered', ordered_at: T0 };
    await seed('lab.specimens', row);
    specimens.push({ specimenId: row.id, barcode: row.barcode, orderId: sv.order.id, patientId: sv.patient.id, centreId: row.centre_id, specimenTypeCode: row.specimen_type_code, status: 'ordered', isActive: true, version: 1 });
  }
  specStore.set(sv.order.id, specimens);
  return { visit: sv.row, order: sv.order, specimens };
}

// ---------------------------------------------------------------- mutation builders (PushRequest.mutations[], 02-TRD §6.3)
export interface Mut { client_mutation_id: string; device_seq: number; type: string; visit_id?: string; captured: { device_wall_time: string; anchor_id: string; elapsed_since_anchor_ms: number }; payload: any }
const OK_GPS = { status: 'off' } as const;
/** `min` = minutes after the world's anchor (server_time = 04:00Z of the route date): the corrected capture time is 04:00Z + min. */
const mut = (w: PushWorld, type: string, payload: unknown, o: { min?: number; visit?: string; seq?: number; id?: string; noVisit?: boolean } = {}): Mut => {
  const min = o.min ?? 10;
  // device_seq 0 = "assign at batch formation" (batchOf numbers the unnumbered ones consecutively, in array order, and keeps the number on the object so a replay carries the same seq)
  return { client_mutation_id: o.id ?? v7(), device_seq: o.seq ?? 0, type, ...(o.noVisit ? {} : { visit_id: o.visit ?? w.visit.id }),
    captured: { device_wall_time: at(w.date, `${pad(4 + Math.floor(min / 60))}:${pad(min % 60)}`), anchor_id: w.anchorId, elapsed_since_anchor_ms: min * 60_000 }, payload };
};
type MO = Parameters<typeof mut>[3];
export const M = {
  arrived: (w: PushWorld, o?: MO & { gps?: unknown }) => mut(w, 'visit.arrived', { gps: o?.gps ?? OK_GPS }, { min: 5, ...o }),
  identity: (w: PushWorld, o?: MO & { name?: 'matches' | 'mismatch'; second?: 'matches' | 'mismatch' }) =>
    mut(w, 'visit.identity_checked', { name_check: o?.name ?? 'matches', second_identifier: 'phone', second_check: o?.second ?? 'matches' }, { min: 6, ...o }),
  consent: (w: PushWorld, o?: MO & { given?: boolean; version?: string }) => mut(w, 'visit.consent_recorded', { consent_text_version: o?.version ?? 'hc-consent-v1', given: o?.given ?? true }, { min: 7, ...o }),
  collected: (w: PushWorld, spec: SpecRef | { specimenId: string; barcode: string }, o?: MO & { method?: string; scanned?: string; typeCode?: string; gps?: unknown }) =>
    mut(w, 'specimen.collected', { specimen_id: spec.specimenId, scanned_barcode: o?.scanned ?? spec.barcode, scan_method: o?.method ?? 'camera', specimen_type_code: o?.typeCode ?? 'SST', gps: o?.gps ?? OK_GPS }, { min: 10, ...o }),
  notCollected: (w: PushWorld, spec: SpecRef, o?: MO & { reason?: string }) => mut(w, 'specimen.not_collected', { specimen_id: spec.specimenId, reason_code: o?.reason ?? 'unable_to_draw' }, { min: 12, ...o }),
  payment: (w: PushWorld, o?: MO & { order?: string; method?: string; paisa?: number; reference?: string }) =>
    mut(w, 'payment.captured', { order_id: o?.order ?? w.order.id, payment_method_code: o?.method ?? 'cash', amount: { amount_paisa: o?.paisa ?? 180000, currency: 'NPR' }, ...(o?.reference ? { reference: o.reference } : {}) }, { min: 15, ...o }),
  completed: (w: PushWorld, o?: MO & { outcome?: 'collected' | 'partial' }) => mut(w, 'visit.completed', { outcome: o?.outcome ?? 'collected' }, { min: 20, ...o }),
  failed: (w: PushWorld, o?: MO & { reason?: string }) => mut(w, 'visit.failed', { reason_code: o?.reason ?? 'patient_not_home', gps: OK_GPS }, { min: 20, ...o }),
  handover: (w: PushWorld, specimenIds: readonly string[], o?: MO & { to?: string; handoverId?: string }) =>
    mut(w, 'handover.recorded', { handover_id: o?.handoverId ?? v7(), to_centre_id: o?.to ?? OTHER_CENTRE[w.s], specimen_ids: [...specimenIds] }, { min: 30, noVisit: true, ...o }),
};
/** The US-07-1 / US-08-1 flow: arrived, identity (both match), consent given, 2 collections (camera), cash 1,800.00, completed = 7 mutations. */
export const fullFlow = (w: PushWorld): Mut[] => [M.arrived(w), M.identity(w), M.consent(w), M.collected(w, w.specimens[0]!, { typeCode: w.specimens[0]!.specimenTypeCode }), M.collected(w, w.specimens[1]!, { typeCode: w.specimens[1]!.specimenTypeCode, min: 11 }),
  M.payment(w), M.completed(w)];
/** Everything a collection needs before it (identity both matches + consent given), seqs consecutive. */
export const prelude = (w: PushWorld): Mut[] => [M.identity(w), M.consent(w)];

export const batchOf = (w: PushWorld, mutations: Mut[], o: { batchId?: string; extra?: Record<string, unknown>; anchors?: unknown[]; now?: unknown } = {}) => {
  for (const m of mutations) if (!m.device_seq) m.device_seq = w.seq();   // number the unnumbered ones now, in array order
  return { device_id: w.device.id, batch_id: o.batchId ?? v7(), sent_at_device: at(w.date, '05:59'),
    anchors: o.anchors ?? [{ anchor_id: w.anchorId, server_time: at(w.date, '04:00'), device_wall_time: at(w.date, '04:00'), monotonic_ms: 1000, boot_id: 'b-1' }],
    now: o.now ?? { device_wall_time: at(w.date, '05:59'), monotonic_ms: 1000 + 119 * 60_000, boot_id: 'b-1' }, mutations, ...(o.extra ?? {}) };
};
export const push = (w: PushWorld, body: unknown, o: OpOpts = {}) => op('pushSyncMutations', req({ body, headers: o.headers ?? hdr((body as any)?.device_id ?? w.device.id) }), o.who ?? w.who, { now: w.now, ...o });
export const pushM = (w: PushWorld, mutations: Mut[], o: OpOpts & { batchId?: string; extra?: Record<string, unknown> } = {}) => push(w, batchOf(w, mutations, { batchId: o.batchId, extra: o.extra }), o);
export const pushFails = (w: PushWorld, body: unknown, o: OpOpts = {}) => rejection(push(w, body, o));
export const outcomes = (r: Reply): string[] => r.body.results.map((x: any) => x.outcome);
export const codes = (r: Reply): Array<string | undefined> => r.body.results.map((x: any) => x.code);

// ---------------------------------------------------------------- readers (owner role, RLS bypassed = DB truth)
export const mutRows = (w: PushWorld) => ownerRows('homecollection.mutations', 'device_id = $1 ORDER BY device_seq', [w.device.id]);
export const mutByClient = async (id: string) => (await ownerRows('homecollection.mutations', 'client_mutation_id = $1', [id]))[0];
export const colRows = (visitId: string) => ownerRows('homecollection.collections', 'visit_id = $1 ORDER BY collected_at, id', [visitId]);
export const flagRows = (visitId: string) => ownerRows('homecollection.visit_flags', 'visit_id = $1 ORDER BY created_at, kind', [visitId]);
export const visitRow = async (id: string) => (await ownerRows('homecollection.visits', 'id = $1', [id]))[0];
export const routeRow = async (id: string) => (await ownerRows('homecollection.routes', 'id = $1', [id]))[0];
export const deviceRow = async (id: string) => (await ownerRows('homecollection.devices', 'id = $1', [id]))[0];
export const batchRow = async (id: string) => (await ownerRows('homecollection.sync_batches', 'id = $1', [id]))[0];
export const transitionRows = (visitId: string) => ownerRows('homecollection.visit_transitions', 'visit_id = $1 ORDER BY at, created_at', [visitId]);
export const locationRows = (visitId: string) => ownerRows('homecollection.visit_locations', 'visit_id = $1 ORDER BY captured_at', [visitId]);
/** handovers recorded by this world's device (joined through the handover mutation: every world shares MEMBER[s], the device is unique). */
export const handoverRows = (w: PushWorld) => ownerRows('homecollection.handovers h', `EXISTS (SELECT 1 FROM homecollection.mutations m WHERE m.tenant_id = h.tenant_id AND m.id = h.mutation_id AND m.device_id = $1) ORDER BY h.created_at`, [w.device.id]);
export const itemRows = (handoverId: string) => ownerRows('homecollection.handover_items', 'handover_id = $1 ORDER BY barcode', [handoverId]);
export const eventsOf = (tenant: string, visitId: string) =>
  ownerRows('core.event_log', `tenant_id = $1 AND event_type = '${EVENT}' AND aggregate_id = $2 ORDER BY created_at, aggregate_seq`, [tenant, visitId]);
export const eventsOfTenantSince = (tenant: string, requestId: string) => ownerRows('core.event_log', `tenant_id = $1 AND event_type = '${EVENT}' AND envelope->>'request_id' = $2`, [tenant, requestId]);
export const countAll = async (w: PushWorld) => ({
  mutations: (await mutRows(w)).length, collections: (await colRows(w.visit.id)).length, flags: (await flagRows(w.visit.id)).length, events: (await eventsOf(w.who.tenant, w.visit.id)).length,
  batches: (await ownerRows('homecollection.sync_batches', 'device_id = $1', [w.device.id])).length, handovers: (await handoverRows(w)).length,
});

// ---------------------------------------------------------------- RFC 8785 (JCS) — independent re-implementation for plain JSON (strings, ints, booleans, nulls, arrays, objects), used to check payload_sha256
export function jcs(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return JSON.stringify(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(',')}}`;
}
export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
export const payloadHash = (payload: unknown): string => sha256(jcs(payload));
/** event idempotency key shape `<visit_id>:sync:<64 hex>` (03-IC §3.23). The join format of the sorted ids is not fixed by the spec, so tests check shape + equality/inequality, never the exact digest. */
export const eventKeyRe = (visitId: string): RegExp => new RegExp(`^${visitId}:sync:[0-9a-f]{64}$`);
/** Every key of a JSON value, for "no barcode/name/GPS key anywhere in the event" scans. */
export const keysDeep = (x: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(x)) x.forEach((e) => keysDeep(e, out));
  else if (x && typeof x === 'object') for (const [k, e] of Object.entries(x)) { out.add(k); keysDeep(e, out); }
  return out;
};
export const stringsDeep = (x: unknown, out: string[] = []): string[] => {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) x.forEach((e) => stringsDeep(e, out));
  else if (x && typeof x === 'object') Object.values(x).forEach((e) => stringsDeep(e, out));
  return out;
};
export const lastEvent = async (w: PushWorld) => (await eventsOf(w.who.tenant, w.visit.id)).at(-1);
export const A = 'homecollection.';
