// C14 T14 emulators + fixtures (not a test file). Loaded by vi.mock factories, so it must NOT import the consumers/tasks or ../index.js.
// Synthetic data only. Handlers run through the REAL C0 consumer/task wrapper (core/tasklist.ts) on the core fake DB (core/__tests__/helpers.ts: inbox dedupe,
// app.enqueue_job with job_key dedupe, commit/rollback of the world); the smartreport repositories + summary.service.buildOrGet are replaced by in-memory fakes.
//
// SEAMS pinned for T14 (the spec fixes behaviour 02-TRD §8.2/§9.1, not the TypeScript shapes):
//   - handlers are reached ONLY through `manifest.subscriptions['lab.result.approved.v1' | 'lab.result.amended.v1']` and `manifest.tasks['smartreport.prebuild_summary']` of ../index.js.
//   - they get ports from `ctx.ports` (like reporting's assemble_report). The fake offers BOTH spellings: identity/IdentityPort, lab/LabPort, frontdesk/FrontdeskPort, catalog/CatalogPort.
//     Feature flag = `ctx.ports.identity.getTenantSettings(ctx, { keys: [...] })` -> `{ featureFlags: { smart_report: boolean } }` (the reporting precedent).
//   - repositories (02-CV layer rule; no raw SQL on smartreport.* tables): summaries.repo.getLiveSummaryByOrder + updateSummary, reviews.repo.insertSummaryReview,
//     library.repo.getApprovedLibraryVersion. RepoCtx = { tx, tenantId, actorId } with tenantId = ctx.tenantId and actorId = the smartreport system actor.
//   - consumer step 2 = ONE ctx.tx.query whose text matches /pg_advisory_xact_lock/ and whose text+values mention tenant id and order id, issued before the live-summary read (as T12 pins).
//   - supersede = updateSummary(rc, id, version, { status: 'superseded', superseded_at, superseded_reason: 'results_changed' }) (NO superseded_by_summary_id) +
//     insertSummaryReview(rc, { id, centre_id: <summary's>, summary_id, action: 'superseded' }) (no actor_membership_id: system, no comment).
//   - enqueue = `SELECT app.enqueue_job('smartreport.prebuild_summary', {tenant_id, order_id}, 'smartreport:prebuild:<order_id>', run_at = now + DELAY s, ...)`; env read at call time
//     (`LIMS_SMARTREPORT_PREBUILD_ENABLED`, `LIMS_SMARTREPORT_PREBUILD_DELAY_SECONDS`, default true / 120).
//   - the task builds through summary.service.buildOrGet(ctx, { orderId, mode: 'prebuild' }) with ctx = { tenantId, actor, tx (WITH .savepoint, T12 BuildCtx), ports: { FrontdeskPort, LabPort, CatalogPort }, log, now }
//     and rolls back to a savepoint on smartreport.no_eligible_results / template_not_approved, then resolves. The worker tx has NO .savepoint of its own (reporting precedent): the task adds it.
import { LimsError } from '../../../../../api/src/core/errors.js';
import { systemActorOf } from '../../../core/__tests__/helpers.js';

export { LimsError };
type Row = Record<string, any>;

export const TA = '0190a000-0000-7000-8000-00000000aaaa';
export const TB = '0190a000-0000-7000-8000-00000000bbbb';
export const SYS = systemActorOf('smartreport');
const u = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const ORDER = u(0xf001), ORDER_2 = u(0xf002), CENTRE = u(0xc001), SUMMARY = u(0x5001), LIB = u(0x1b01), MEMBER = u(0xa001);
export const R = { hgb: u(0xe001), wbc: u(0xe002), txt: u(0xe003), other: u(0xe009) };
export const DEFAULT_DELAY = 120;

export const store = {
  summaries: [] as Row[], reviews: [] as Row[], updates: [] as { id: string; expected: number; patch: Row; tenantId: string; actorId: string }[],
  library: null as Row | null, markers: [] as string[], calls: [] as string[],
  lockQueries: [] as { text: string; values: unknown[]; at: number }[], liveReads: [] as { tenantId: string; orderId: string }[],
  buildCalls: [] as { input: Row; tenantId: string; actorId: string; hasSavepoint: boolean; ports: string[] }[],
  buildImpl: null as null | ((ctx: any, input: any) => Promise<any>),
  portCalls: [] as { port: string; fn: string }[],
  flag: true, orderResults: new Map<string, Row[]>(), settingsCalls: 0, settingsThrows: false,
  failUpdate: null as null | (() => Error),
};
export function reset(): void {
  Object.assign(store, { summaries: [], reviews: [], updates: [], library: { id: LIB, tenant_id: TA, status: 'approved' }, markers: [], calls: [], lockQueries: [], liveReads: [], buildCalls: [],
    buildImpl: null, portCalls: [], flag: true, settingsCalls: 0, settingsThrows: false, failUpdate: null });
  store.orderResults = new Map();
}

/** A live (draft | approved | rejected) summary of ORDER in tenant TA containing `inputs` ("<result_id>:<version_no>"). */
export const summaryRow = (o: Row = {}): Row => ({ id: SUMMARY, tenant_id: TA, centre_id: CENTRE, order_id: ORDER, status: 'approved', version: 3, library_version_id: LIB,
  approved_set_hash: 'h1', input_result_versions: [`${R.hgb}:1`, `${R.wbc}:1`], superseded_by_summary_id: null, ...o });

// ------------------------------------------------------------------------------------------------ repository fakes (merged over the real module exports)
const LIVE = ['draft', 'approved', 'rejected'];
export const summariesRepo = {
  async getLiveSummaryByOrder(rc: Row, orderId: string): Promise<Row | null> {
    store.calls.push('getLive'); store.liveReads.push({ tenantId: rc.tenantId, orderId });
    const r = store.summaries.find((s) => s.tenant_id === rc.tenantId && s.order_id === orderId && LIVE.includes(s.status));
    return r ? structuredClone(r) : null;
  },
  async updateSummary(rc: Row, id: string, expected: number, patch: Row): Promise<Row> {
    store.calls.push('update');
    if (store.failUpdate) throw store.failUpdate();
    const r = store.summaries.find((s) => s.tenant_id === rc.tenantId && s.id === id);
    if (!r) throw new LimsError('common.not_found');
    if (r.version !== expected) throw new LimsError('common.version_conflict');
    store.updates.push({ id, expected, patch: structuredClone(patch), tenantId: rc.tenantId, actorId: rc.actorId });
    Object.assign(r, patch, { version: r.version + 1 });
    return structuredClone(r);
  },
};
export const reviewsRepo = {
  async insertSummaryReview(rc: Row, row: Row): Promise<Row> {
    store.calls.push('review'); const r = { ...row, tenant_id: rc.tenantId, created_by: rc.actorId }; store.reviews.push(r); return r;
  },
};
export const libraryRepo = {
  async getApprovedLibraryVersion(rc: Row): Promise<Row | null> { return store.library && store.library.tenant_id === rc.tenantId ? structuredClone(store.library) : null; },
};
export const summaryService = {
  async buildOrGet(ctx: Row, input: Row): Promise<Row> {
    store.calls.push('build');
    store.buildCalls.push({ input: structuredClone(input), tenantId: ctx.tenantId, actorId: ctx.actor?.id, hasSavepoint: typeof ctx.tx?.savepoint === 'function',
      ports: Object.keys(ctx.ports ?? {}).sort() });
    if (store.buildImpl) return store.buildImpl(ctx, input);
    return { summary: { id: u(0x5002) }, created: true };
  },
};

// ------------------------------------------------------------------------------------------------ ports
const rv = (result_id: string, status: string, version = 1) => ({ resultId: result_id, versionNo: version, status });
export const results = (orderId: string, statuses: string[]): void => {
  store.orderResults.set(orderId, statuses.map((s, i) => rv(u(0xd000 + i), s)));
};
export function makePorts() {
  const identity = {
    async getTenantSettings(_ctx: unknown, _i: unknown) {
      store.portCalls.push({ port: 'identity', fn: 'getTenantSettings' }); store.settingsCalls += 1;
      if (store.settingsThrows) throw new Error('identity down');
      return { featureFlags: { smart_report: store.flag }, partialReleaseAllowed: false };
    },
  };
  const lab = {
    async getOrderResults(_ctx: unknown, i: { orderId: string; scope: string }) {
      store.portCalls.push({ port: 'lab', fn: `getOrderResults:${i.scope}` });
      return { orderId: i.orderId, specimens: [], approvedSetHash: 'h1', items: [{ orderItemId: u(0x7001), testId: u(0x7002), departmentId: u(0x7003), results: store.orderResults.get(i.orderId) ?? [] }] };
    },
    async getAnalyteHistory() { store.portCalls.push({ port: 'lab', fn: 'getAnalyteHistory' }); return { items: [] }; },
  };
  const frontdesk = { async getOrderSummary() { store.portCalls.push({ port: 'frontdesk', fn: 'getOrderSummary' }); return {}; } };
  const catalog = { async getTest() { store.portCalls.push({ port: 'catalog', fn: 'getTest' }); return {}; } };
  return { identity, IdentityPort: identity, lab, LabPort: lab, frontdesk, FrontdeskPort: frontdesk, catalog, CatalogPort: catalog };
}

// ------------------------------------------------------------------------------------------------ tx wrapper (real SAVEPOINT semantics for the in-memory store) + manifest wrapper
export const MARKER_SQL = "INSERT INTO smartreport.t14_marker (note) VALUES ($1)";
const snap = () => structuredClone({ summaries: store.summaries, reviews: store.reviews, markers: store.markers });
const restore = (s: ReturnType<typeof snap>) => { store.summaries = s.summaries; store.reviews = s.reviews; store.markers = s.markers; };

function wrapTx(base: any): any {
  const stack: { name: string; s: ReturnType<typeof snap> }[] = [];
  const tx: any = {
    claims: base.claims, startedAt: base.startedAt,
    async query(text: string, values: unknown[] = []) {
      const t = String(text).replace(/\s+/g, ' ').trim();
      let m: RegExpExecArray | null;
      if ((m = /^SAVEPOINT\s+(\w+)/i.exec(t))) { stack.push({ name: m[1]!, s: snap() }); return { rows: [] }; }
      if ((m = /^ROLLBACK TO(?: SAVEPOINT)?\s+(\w+)/i.exec(t))) {
        const i = stack.map((x) => x.name).lastIndexOf(m[1]!);
        if (i < 0) throw new Error(`fake: no savepoint ${m[1]}`);
        restore(stack[i]!.s); stack.length = i + 1; stack[i]!.s = snap(); return { rows: [] };
      }
      if ((m = /^RELEASE(?: SAVEPOINT)?\s+(\w+)/i.exec(t))) { const i = stack.map((x) => x.name).lastIndexOf(m[1]!); if (i >= 0) stack.length = i; return { rows: [] }; }
      if (/pg_advisory_xact_lock/i.test(t)) { store.lockQueries.push({ text: t, values, at: store.calls.length }); store.calls.push('lock'); return { rows: [{}] }; }
      if (/app\.enqueue_job/i.test(t)) store.calls.push('enqueue');
      if (t === MARKER_SQL) { store.markers.push(String(values[0])); return { rows: [] }; }
      return base.query(text, values);
    },
  };
  return tx;
}

/** Same manifest, every handler gets `ctx.ports` and a tx with SAVEPOINT emulation (but no .savepoint method: that is the task's job). */
export function withPorts<M extends { subscriptions?: Record<string, any>; tasks?: Record<string, any> }>(manifest: M, ports = makePorts()): M {
  const wrap = (h: (a: any, c: any) => Promise<void>) => async (a: any, ctx: any) => {
    const next: any = { ...ctx, ports, tx: wrapTx(ctx.tx) };
    next.db = { tx: (fn: (c: any) => Promise<any>) => fn(next) };
    return h(a, next);
  };
  const map = (o?: Record<string, any>) => Object.fromEntries(Object.entries(o ?? {}).map(([k, h]) => [k, wrap(h)]));
  return { ...manifest, subscriptions: map(manifest.subscriptions), tasks: map(manifest.tasks) } as M;
}

// ------------------------------------------------------------------------------------------------ envelopes (valid against contracts/events/lab.result.*.v1.schema.json)
const base = (type: string, eventId: string, seq: number, payload: Row, tenant = TA): Row => ({
  event_id: eventId, event_type: type, tenant_id: tenant, occurred_at: '2026-11-07T12:00:00.000Z', actor: { type: 'user', id: MEMBER }, idempotency_key: `${eventId}-key`,
  producer: 'lab', aggregate: { type: 'result', id: payload['result_id'], seq }, request_id: u(0xf1), payload,
});
export const EV = { one: u(0xe101), two: u(0xe102), three: u(0xe103) };
export const approvedEnvelope = (o: { eventId?: string; resultId?: string; orderId?: string; extra?: Row; tenant?: string } = {}): Row => base('lab.result.approved.v1', o.eventId ?? EV.one, 1, {
  result_id: o.resultId ?? R.other, result_version_no: 1, order_id: o.orderId ?? ORDER, order_item_id: u(0x7001), test_id: u(0x7002), analyte_id: u(0x7004), department_id: u(0x7003),
  approved_at: '2026-11-07T12:00:00.000Z', approved_by_membership_id: MEMBER, ...(o.extra ?? {}),
}, o.tenant);
export const amendedEnvelope = (o: { eventId?: string; resultId?: string; orderId?: string; newVersion?: number; extra?: Row; tenant?: string } = {}): Row => base('lab.result.amended.v1', o.eventId ?? EV.one, 2, {
  result_id: o.resultId ?? R.hgb, previous_version_no: (o.newVersion ?? 2) - 1, new_version_no: o.newVersion ?? 2, order_id: o.orderId ?? ORDER, order_item_id: u(0x7001), test_id: u(0x7002),
  analyte_id: u(0x7004), amendment_reason_code: 'typo_correction', amended_at: '2026-11-07T12:00:00.000Z', amended_by_membership_id: MEMBER, ...(o.extra ?? {}),
}, o.tenant);

/** Seconds between the job clock (core fake FIXED_NOW) and the run_at of an app.enqueue_job statement (Date/ISO value, or `now() + <n>` with n among the bound values). */
export function runAtDelaySeconds(stmt: { text: string; values: unknown[] }, nowMs: number): number | undefined {
  const v = stmt.values[3];
  if (typeof v === 'number') return v;
  if ((v instanceof Date || (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v))) && !Number.isNaN(Date.parse(String(v)))) return Math.round((Date.parse(String(v)) - nowMs) / 1000);
  const n = stmt.values.find((x, i) => i > 3 && typeof x === 'number' && x >= 30);
  return typeof n === 'number' ? n : undefined;
}
