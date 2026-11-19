// T0B-SYNC-4 test doubles (not a test). Synthetic data only. PINNED SURFACE the writer must implement (every item may be disputed with the lead/arbiter, then the tests follow; the lead
// decisions LD-322 and LD-374 are the authority, design C:/LIMS-state/offline-design-20261117.md sections 3, 5, 8). Nothing here invents a wire name: op types, payload schemas, permissions and
// error codes are the ones of contracts/openapi/core.yaml (SyncOpResultEnter / ResultVerify / ReportPrintMarker / DailyCashClose, SyncErrorCode).
//
//  ADAPTER FILES (additive; each exports the default instance and a factory whose `deps` are SEAMS, every seam optional, default = the production implementation):
//    modules/lab/sync/resultEnter.adapter.ts      `resultEnterAdapter`       + `createResultEnterAdapter(deps?: { readResult?, alerts? })`
//         opType result.enter, permission lab.result.enter, validate = top level shape of lab.yaml BulkEnterResultsRequest (payloadShape of engine.ts)
//    modules/lab/sync/resultVerify.adapter.ts     `resultVerifyAdapter`      + `createResultVerifyAdapter(deps?: { readResult?, alerts?, signoffs?, offlineApprovalAllowed? })`
//         opType result.verify, permission lab.result.verify, validate = VerifyResultRequest shape
//    modules/reporting/sync/printMarker.adapter.ts `reportPrintMarkerAdapter` + `createReportPrintMarkerAdapter(deps?: { resultsOfReport?, readResult?, signoffs?, alerts? })`
//         opType report.print_marker, permission reporting.report.print, validate = CreateReportPrintRequest shape
//    modules/billing/sync/cashClose.adapter.ts    `dailyCashCloseAdapter`    + `createDailyCashCloseAdapter(deps?: { readSession?, closeNeedsStepUp? })`
//         opType daily_cash.close, permission billing.payment.record, validate = CloseCashSessionRequest shape
//    core/sync/index.ts: DEFAULT_SYNC_ADAPTERS holds all eight adapters (the dispatcher registration file of T0B-SYNC-2).
//  SEAMS (types, `ctx` = the per operation HandlerContext; every read goes through ctx.tx under RLS, tenant from ctx only):
//    readResult(ctx, resultId) -> { status: string; version: number; specimenStatus?: string } | undefined          (default: lab.results row + its specimen; undefined = unknown / other tenant / out of scope)
//    alerts.raise(ctx, a: { kind: 'result_locked' | 'verification_policy_failed'; opId: string; resultId: string; code?: string; reportVersionIds?: string[] }) -> void     ALERT TO THE LAB MANAGER (ids and codes only, never a value or a name)
//    signoffs: { recordVerify(ctx, { opId, deviceId, resultId, outcome: 'accepted'|'rejected', deviceCreatedAt }): void
//                reliedVerifies(ctx, { deviceId, resultIds }): { opId, resultId, outcome }[]                       (every verify outcome this device recorded for those results)
//                addMarker(ctx, { opId, reportVersionId, resultIds, deviceId, deviceCreatedAt }): void             (state pending)
//                markersForResult(ctx, resultId): { opId, reportVersionId, deviceId, resultIds, state: 'pending'|'confirmed'|'recall_required' }[]
//                setMarkerState(ctx, opId, state: 'confirmed'|'recall_required'): void }
//    resultsOfReport(ctx, reportVersionId) -> string[] | undefined  (result ids the report version shows; undefined = unknown report version)
//    offlineApprovalAllowed(ctx) -> boolean   (tenant policy, default false = SyncSettings.offlineApprovalAllowed of getSyncStatus)
//    readSession(ctx, sessionId) -> { status: 'open'|'closed'; version: number; closedByMembershipId?: string } | undefined   (billing.cash_sessions under RLS)
//    closeNeedsStepUp(ctx) -> boolean         (tenant requires MFA step up to close the day)
//    NEW STORAGE (marker states, relied-on verify outcomes, alerts) has no table in main: the writer files a CR / migration of its own; the tests never touch it except through these seams.
//  ENGINE (core/sync/engine.ts, additive): SyncAdapter.execute may return `{ outcome: 'rejected', errorCode }` = status rejected + error_code (closed SyncErrorCode list, else common.internal),
//    WITHOUT rolling back the operation SAVEPOINT: the writes of the adapter itself (alert, recall flags, recorded verify outcome) stay. The adapter undoes the wrapped service by running it in a NESTED
//    ctx.db.tx. A plain throw of a LimsError still rolls everything back (as in SYNC-2/3). The ledger row (core.sync_operation) of such an operation is rejected with that error_code, a replay answers duplicate.
//  SERVICE LAYER (called with the SAME ctx, never HTTP, never a copy of the rules): lab/service/result.service.js `bulkEnterResults(ctx, EntryInput)`, `verifyResult(ctx, { resultId, version, acknowledgedFlags? })`,
//    `approveResult(ctx, { resultId, version })`; billing/service/cash.service.js `createCashService().closeCashSession(ctx, { sessionId, expectedVersion, counted, note?, deposit? })` (the way ledger.handlers.ts calls it).
//  RULES (what the tests prove; see the .live tests for the exact cases):
//    result.enter : any entry whose result is verified / approved -> rejected sync.result_locked + alerts.raise(result_locked) (survives the rejection); cancelled result or sample rejected / recollection_ordered /
//                   discarded -> CONFLICT sync.entity_changed; entry version older than the server version -> CONFLICT sync.base_version_stale; unknown -> common.not_found; else the service is called once.
//    result.verify: version mismatch (superseded), lab.verifier_not_distinct, lab.enterer_cannot_verify, lab.result_invalid_transition, or lab.pathologist_required for a signer who is not a pathologist -> rejected
//                   sync.verification_policy_failed, every pending / confirmed marker of the result -> recall_required, alerts.raise(verification_policy_failed, reportVersionIds), outcome recorded; lab.pathologist_required
//                   for a pathologist -> sync.offline_not_allowed unless offlineApprovalAllowed(ctx), then approveResult + an audit event detail.event 'offline_approval'.
//    report.print_marker: stored pending; confirmed when no relied verify was rejected and every result of the report is verified / approved on the server; recall_required (+ alert) when a relied verify was rejected.
//    daily_cash.close: session closed by the same membership = duplicate; by another = CONFLICT common.immutable_record; stale version = CONFLICT sync.base_version_stale; closeNeedsStepUp = sync.offline_not_allowed.
import { LimsError } from '../../../errors.js';
import { ownerRows, superTx, uid, ensureEffectTable } from '../helpers2.js';

export const MODS = {
  result: '../../../../modules/lab/service/result.service.js',
  cash: '../../../../modules/billing/service/cash.service.js',
} as const;

export interface Call { ctx: any; args: any[] }
export const calls = { enter: [] as Call[], verify: [] as Call[], approve: [] as Call[], close: [] as Call[], order: [] as string[] };
const defaults = () => ({
  async enter(ctx: any, input: any) { await effect(ctx, 'enter'); return { results: (input.entries as any[]).map((e) => ({ resultId: e.resultId, outcome: 'ok' })), recomputed: [] }; },
  async verify(ctx: any, i: any) { await effect(ctx, `verify:${i.resultId}`, i.resultId); return { id: i.resultId, status: 'verified' }; },
  async approve(ctx: any, i: any) { await effect(ctx, `approve:${i.resultId}`, i.resultId); return { id: i.resultId, status: 'approved' }; },
  async close(ctx: any, i: any) { await effect(ctx, `close:${i.sessionId}`, i.sessionId); return { id: i.sessionId, status: 'closed' }; },
});
export const behave: ReturnType<typeof defaults> = defaults();
export const reset = (): void => {
  for (const k of ['enter', 'verify', 'approve', 'close'] as const) calls[k].length = 0;
  calls.order.length = 0;
  Object.assign(behave, defaults()); results.clear(); sessions.clear(); reports.clear(); flags.offlineApproval = false; flags.stepUp = false; flags.failAlerts = false;
};
export const effect = (ctx: any, tag: string, entityId?: string) =>
  ctx.tx.query(`INSERT INTO sync2_test.effect (tenant_id, op_id, op_type, entity_id, actor_id, idempotency_key, tag) VALUES ($1, $2, 'svc', $3, $4, $5, $6)`, [ctx.tenantId, uid(), entityId ?? null, ctx.actor.id, uid(), tag]);
export const effectTags = async (tags?: string[]): Promise<string[]> =>
  (await ownerRows(`SELECT tag FROM sync2_test.effect WHERE op_type = 'svc' ${tags ? 'AND tag = ANY($1::text[])' : ''} ORDER BY n`, tags ? [tags] : [])).map((r: any) => r.tag);

// ------------------------------------------------------------ module mock factories (vi.mock(path, (orig) => resultMock(orig)) at the top of every test file)
export const resultMock = async (orig: () => Promise<any>) => ({ ...(await orig()),
  bulkEnterResults: (ctx: any, ...a: any[]) => { calls.enter.push({ ctx, args: a }); calls.order.push('enter'); return behave.enter(ctx, a[0]); },
  verifyResult: (ctx: any, ...a: any[]) => { calls.verify.push({ ctx, args: a }); calls.order.push('verify'); return behave.verify(ctx, a[0]); },
  approveResult: (ctx: any, ...a: any[]) => { calls.approve.push({ ctx, args: a }); calls.order.push('approve'); return behave.approve(ctx, a[0]); } });
export const cashMock = async (orig: () => Promise<any>) => ({ ...(await orig()),
  createCashService: () => ({ getMyCashSession: async () => { throw new Error('the close adapter must not read through the online getMyCashSession'); },
    closeCashSession: (ctx: any, ...a: any[]) => { calls.close.push({ ctx, args: a }); calls.order.push('close'); return behave.close(ctx, a[0]); } }) });
// every test file repeats these two lines at its top (vi.mock is hoisted per test file, never from a helper):
//   vi.mock('../../../../modules/lab/service/result.service.js', async (orig) => (await import('./doubles4.js')).resultMock(orig as never));
//   vi.mock('../../../../modules/billing/service/cash.service.js', async (orig) => (await import('./doubles4.js')).cashMock(orig as never));

// ------------------------------------------------------------ seams backed by real tables (schema sync2_test) so SAVEPOINT / rollback behaviour is real
export const results = new Map<string, { status: string; version: number; specimenStatus?: string }>();
export const sessions = new Map<string, { status: 'open' | 'closed'; version: number; closedByMembershipId?: string }>();
export const reports = new Map<string, string[] | undefined>();
export const flags = { offlineApproval: false, stepUp: false, failAlerts: false };
export const readResult = async (_ctx: any, id: string) => results.get(id);
export const resultsOfReport = async (_ctx: any, id: string) => reports.get(id);
export const readSession = async (_ctx: any, id: string) => sessions.get(id);
export const offlineApprovalAllowed = async () => flags.offlineApproval;
export const closeNeedsStepUp = async () => flags.stepUp;

let ready = false;
export async function ensure4(): Promise<void> {
  if (ready) return;
  await ensureEffectTable();
  await superTx(async (tx) => {
    await tx.query(`CREATE TABLE IF NOT EXISTS sync2_test.alerts (n bigserial PRIMARY KEY, tenant_id uuid NOT NULL, kind text NOT NULL, op_id uuid NOT NULL, result_id uuid, code text, report_ids jsonb)`);
    await tx.query(`CREATE TABLE IF NOT EXISTS sync2_test.markers (tenant_id uuid NOT NULL, op_id uuid NOT NULL, report_version_id uuid NOT NULL, result_ids uuid[] NOT NULL, device_id uuid NOT NULL, state text NOT NULL, PRIMARY KEY (tenant_id, op_id))`);
    await tx.query(`CREATE TABLE IF NOT EXISTS sync2_test.verifies (n bigserial PRIMARY KEY, tenant_id uuid NOT NULL, op_id uuid NOT NULL, device_id uuid NOT NULL, result_id uuid NOT NULL, outcome text NOT NULL, at timestamptz NOT NULL)`);
    await tx.query('GRANT ALL ON ALL TABLES IN SCHEMA sync2_test TO PUBLIC; GRANT ALL ON ALL SEQUENCES IN SCHEMA sync2_test TO PUBLIC');
  });
  ready = true;
}
export const alerts = {
  async raise(ctx: any, a: { kind: string; opId: string; resultId?: string; code?: string; reportVersionIds?: string[] }) {
    if (flags.failAlerts) throw new Error('alert sink down');
    await ctx.tx.query('INSERT INTO sync2_test.alerts (tenant_id, kind, op_id, result_id, code, report_ids) VALUES ($1, $2, $3, $4, $5, $6)', [ctx.tenantId, a.kind, a.opId, a.resultId ?? null, a.code ?? null, JSON.stringify(a.reportVersionIds ?? null)]);
  },
};
export const signoffs = {
  async recordVerify(ctx: any, v: { opId: string; deviceId: string; resultId: string; outcome: string; deviceCreatedAt: string }) {
    await ctx.tx.query('INSERT INTO sync2_test.verifies (tenant_id, op_id, device_id, result_id, outcome, at) VALUES ($1, $2, $3, $4, $5, $6)', [ctx.tenantId, v.opId, v.deviceId, v.resultId, v.outcome, v.deviceCreatedAt]);
  },
  async reliedVerifies(ctx: any, q: { deviceId: string; resultIds: string[] }) {
    const r = await ctx.tx.query('SELECT op_id, result_id, outcome FROM sync2_test.verifies WHERE tenant_id = $1 AND device_id = $2 AND result_id = ANY($3::uuid[]) ORDER BY n', [ctx.tenantId, q.deviceId, q.resultIds]);
    return r.rows.map((x: any) => ({ opId: x.op_id, resultId: x.result_id, outcome: x.outcome }));
  },
  async addMarker(ctx: any, m: { opId: string; reportVersionId: string; resultIds: string[]; deviceId: string }) {
    await ctx.tx.query(`INSERT INTO sync2_test.markers (tenant_id, op_id, report_version_id, result_ids, device_id, state) VALUES ($1, $2, $3, $4::uuid[], $5, 'pending')`, [ctx.tenantId, m.opId, m.reportVersionId, m.resultIds, m.deviceId]);
  },
  async markersForResult(ctx: any, resultId: string) {
    const r = await ctx.tx.query('SELECT op_id, report_version_id, device_id, result_ids, state FROM sync2_test.markers WHERE tenant_id = $1 AND $2 = ANY(result_ids) ORDER BY op_id', [ctx.tenantId, resultId]);
    return r.rows.map((x: any) => ({ opId: x.op_id, reportVersionId: x.report_version_id, deviceId: x.device_id, resultIds: x.result_ids, state: x.state }));
  },
  async setMarkerState(ctx: any, opId: string, state: string) {
    await ctx.tx.query('UPDATE sync2_test.markers SET state = $3 WHERE tenant_id = $1 AND op_id = $2', [ctx.tenantId, opId, state]);
  },
};
export const alertRows = (tenant: string): Promise<any[]> => ownerRows('SELECT kind, op_id, result_id, code, report_ids FROM sync2_test.alerts WHERE tenant_id = $1 ORDER BY n', [tenant]);
export const markerRows = (opIds: string[]): Promise<any[]> => ownerRows('SELECT op_id, report_version_id, state FROM sync2_test.markers WHERE op_id = ANY($1::uuid[]) ORDER BY op_id', [opIds]);
export const verifyRows = (opIds: string[]): Promise<any[]> => ownerRows('SELECT op_id, result_id, outcome FROM sync2_test.verifies WHERE op_id = ANY($1::uuid[]) ORDER BY n', [opIds]);
export const clearAll = async (): Promise<void> => { await superTx(async (tx) => { await tx.query('TRUNCATE sync2_test.alerts, sync2_test.markers, sync2_test.verifies'); }); };
/** every seam the adapters take, ready for the factories. */
export const seams = () => ({ readResult, alerts, signoffs, resultsOfReport, offlineApprovalAllowed, readSession, closeNeedsStepUp });

// ------------------------------------------------------------ synthetic payloads (shapes of the wrapped request schemas; no real person)
export const enterPayload = (resultId: string, version = 1, over: Record<string, unknown> = {}): Record<string, unknown> => ({ entries: [{ result_id: resultId, version, value_numeric: '5.4', ...over }] });
export const verifyPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...over });
export const markerPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ variant: 'letterhead', copies: 1, ...over });
export const closePayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ counted: [{ method_code: 'cash', amount_paisa: 150_000 }], deposit_paisa: 100_000, note: 'synthetic close', ...over });
export const POLICY_CODES = ['lab.verifier_not_distinct', 'lab.enterer_cannot_verify', 'lab.pathologist_required', 'lab.result_invalid_transition'] as const;
export const refuse = (code: string) => async () => { throw new LimsError(code as never); };
