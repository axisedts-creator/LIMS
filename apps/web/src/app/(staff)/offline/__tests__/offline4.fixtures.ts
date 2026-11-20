// T0D-OFFLINE-4 shared fixtures (tester-owned; not a test file). Synthetic data only.
//
// CONTRACT chosen by the tester where the brief gives no name (writer: follow it, or dispute in .orchestra/notes/T0D-OFFLINE-4-dispute-*.md).
// Facts from main the tests enforce (read the server code, do not guess):
//   * wire shapes (contracts/openapi/core.yaml SyncOp*): result.enter {payload: BulkEnterResultsRequest, no entity_id, no base_version};
//       result.verify {entity_id = result id, base_version = the result version signed, payload: VerifyResultRequest = {} or {acknowledged_flags}};
//       report.print_marker {entity_id = report_version_id, payload: CreateReportPrintRequest = {variant: letterhead|plain, copies: 1..5}};
//       daily_cash.close {entity_id = cash_session_id, base_version = session version, payload: CloseCashSessionRequest = {counted:[{method_code, amount_paisa}], note?}}.
//   * the refusal codes and the TEXT a person reads are the ones the online screen uses (features/lab/components/QueueScreen.tsx REASON):
//       lab.verifier_not_distinct, lab.enterer_cannot_verify, lab.pathologist_required, lab.result_invalid_transition, lab.flag_ack_required; plus
//       sync.result_locked (entering into a verified or approved result), sync.offline_not_allowed (MFA step up offline), reporting.print_not_ready.
//   * policy rule (services/api/src/modules/lab/service/signoff.service.ts): most specific ACTIVE policy (test > department > lab; none = level 2, pathologist,
//       enterer may not sign); level frozen on the result (signoff_required) wins; one person signs one version once; the final sign off of a require_pathologist
//       policy comes from a pathologist (holds lab.result.approve) and needs MFA step up, which an offline device cannot give unless the tenant allows offline approval.
//   * the server version of a result moves by +1 when result.enter is applied (results.store.ts), so a result entered on this device is signed at cached version + 1.
//
// Modules the writer creates under apps/web/src/core/offline/ (re-exported from index.ts), imported dynamically from '@/core/offline/<file>':
//   labflows.ts   createLabFlows({ store, outbox, deviceId, userId, permissions, now?, offlineApproval? }) ->     (offlineApproval: () => boolean | Promise<boolean>, default off)
//                   worklist()                          cached worklist rows (refdata 'worklist_item:<result id>'), sorted by registration_no
//                   localResult(id)                     the cached row with this device's changes laid over it: { ...row, version, value_*, entered_by_user_id, signoffs, signoff_count }
//                   enterResults({ entries })           -> { ok: true, op_id, entered } | { ok: false, code: 'sync.result_locked', message, result_ids }
//                   checkVerify(id, { acknowledged_flags? }) -> { allowed: true, final } | { allowed: false, code, message }
//                   verifyResult({ result_id, acknowledged_flags? }) -> { ok: true, op_id, final } | { ok: false, code, message }
//                   signoffState(id)                    -> { required, count, final, signers: string[], source: 'server' | 'device' }  ('device' = a counted sign off is queued here)
//                   printReport({ report_version_id, variant, copies }) -> { ok: true, op_id, issued_offline: true, relied_on_device: boolean } | { ok: false, code, message }
//                   reportStatus(report_version_id)     -> { state: 'none' | 'pending' | 'confirmed' } | { state: 'recall', code, result_ids }
//   cashflows.ts  createCashFlows({ store, outbox, permissions, now?, requiresStepUp? }) ->                 (requiresStepUp: () => boolean | Promise<boolean>, default off)
//                   closeDay({ session_id, counted, note? }) -> { ok: true, queued, op_id?, duplicate?, variance } | { ok: false, code, message }
//   Business refusals RETURN { ok: false | allowed: false, code, message }; permission, validation and locked store THROW OfflineError (auth.forbidden,
//   common.validation_failed, common.not_found, offline.locked) exactly as the OFFLINE-3 flows do. A refusal queues nothing.
//   The object the OfflineProvider `flows` prop hands the screens ALSO carries these methods (merge of OfflineFlows, labflows and cashflows) and OfflineFlows.statusOf
//   answers for result ids of a queued result.enter (payload.entries[].result_id), for result ids of result.verify, for report version ids and for cash session ids.
//   ui/OfflineParts.tsx  ReportOfflineMarker({ reportVersionId })  (watermark while pending, recall banner on recall, nothing otherwise; reads flows.reportStatus)
// Cached documents are read from the encrypted 'refdata' store exactly as core/offline/prefetch.ts writes them (key `${entity_type}:${id}`, the read API document as value).
// CR NEEDED (lead; the tester may not write .orchestra/cr): the pull whitelist has no worklist_item, report_version or cash_session entity (and no tenant
// offline approval setting beyond sync status): the tests assume those three documents are cached under the keys above, with the fields written below.
import { vi } from 'vitest';
import { DEVICE, USER, T0 } from '@/core/offline/__tests__/offline1.helpers';
import { createEnv as createBase, simServer, U, type Env as BaseEnv } from './offline3.fixtures';

export { DEVICE, USER, T0, U, simServer };
export const USER2 = '0192f0d6-0000-7000-8000-000000000002';
export const PATH = '0192f0d6-0000-7000-8000-000000000003'; // the pathologist
export const CENTRE = U(3);
export const P_ENTER = ['sync.use', 'lab.result.enter', 'reporting.report.print', 'billing.payment.record'];
export const P_VERIFY = ['sync.use', 'lab.result.verify', 'lab.result.read', 'reporting.report.print'];
export const P_PATH = [...P_VERIFY, 'lab.result.approve'];

export const policy = (over: Record<string, unknown> = {}) => ({
  id: U(700), scope: 'lab', required_verifiers: 2, require_pathologist: true, allow_enterer_verify: false, active: true, version: 1, updated_at: '2026-11-01T00:00:00.000Z', ...over,
});
export const DEPT = U(600);
export const TEST = U(101);
/** a worklist row as the cached read document (CR above): ids, version, state and the sign off chain of the current version */
export const row = (n: number, over: Record<string, unknown> = {}) => ({
  id: U(800 + n), version: 3, current_version_no: 1, order_id: U(900 + n), registration_no: `R-${String(n).padStart(4, '0')}`, test_id: TEST, department_id: DEPT,
  centre_id: CENTRE, status: 'pending', signoff_count: 0, signoffs: [] as unknown[], ...over,
});
export const signoff = (user: string, over: Record<string, unknown> = {}) => ({ seq: 1, result_version: 1, action: 'verify', signer_user_id: user, signer_is_pathologist: false, signed_at: '2026-11-18T05:00:00.000Z', ...over });
export const report = (n: number, resultIds: string[], over: Record<string, unknown> = {}) => ({ id: U(1000 + n), order_id: U(900 + n), registration_no: `R-${String(n).padStart(4, '0')}`, result_ids: resultIds, ...over });
export const cashSession = (n: number, over: Record<string, unknown> = {}) => ({
  id: U(1100 + n), version: 5, status: 'open', centre_id: CENTRE, business_date: '2026-11-18', expected: [{ method_code: 'cash', amount_paisa: 250000 }, { method_code: 'card', amount_paisa: 80000 }], ...over,
});

export const MSG = {
  distinct: 'You already signed this result. A different person must sign it next.',
  enterer: 'You entered this result. Someone else must sign it off.',
  pathologist: 'The final sign-off of this result must come from a pathologist.',
  transition: 'This result is no longer in the right state.',
  flags: 'Acknowledge the flags before verifying.',
};

type Doc = { id: string; [k: string]: unknown };
export async function seedLab(store: { put: (n: string, k: string, v: unknown) => Promise<unknown> }, o: { results?: Doc[]; policies?: Doc[]; reports?: Doc[]; sessions?: Doc[] }) {
  for (const r of o.results ?? []) await store.put('refdata', `worklist_item:${r.id}`, r);
  for (const p of o.policies ?? []) await store.put('refdata', `verification_policy:${p.id}`, p);
  for (const r of o.reports ?? []) await store.put('refdata', `report_version:${r.id}`, r);
  for (const s of o.sessions ?? []) await store.put('refdata', `cash_session:${s.id}`, s);
}

export async function createEnv(o: { results?: Doc[]; policies?: Doc[]; reports?: Doc[]; sessions?: Doc[]; registration?: boolean } = {}) {
  const env = await createBase({ blocks: o.registration === true, seed: o.registration === true }); // registration: price list, patients and number blocks of OFFLINE-3 (the drill)
  await seedLab(env.store as never, { results: o.results ?? [], policies: o.policies ?? [policy()], reports: o.reports ?? [], sessions: o.sessions ?? [] });
  const { createOutbox } = await import('@/core/offline/outbox');
  const { createLabFlows } = await import('@/core/offline/labflows');
  const { createCashFlows } = await import('@/core/offline/cashflows');
  const outboxFor = (userId: string) => (userId === USER ? env.outbox : createOutbox(env.store as never, { deviceId: DEVICE, userId, now: env.c.now }));
  /** flows of one signed in person on this device (a shared PC: the outbox and the store are the same) */
  const lab = (userId = USER, permissions: readonly string[] = P_ENTER, extra: Record<string, unknown> = {}) =>
    createLabFlows({ store: env.store, outbox: outboxFor(userId), deviceId: DEVICE, userId, permissions, now: env.c.now, ...extra } as never) as any;
  const cash = (permissions: readonly string[] = P_ENTER, extra: Record<string, unknown> = {}) =>
    createCashFlows({ store: env.store, outbox: env.outbox, permissions, now: env.c.now, ...extra } as never) as any;
  return { ...env, lab, cash, outboxFor, vi };
}
export type Env = Awaited<ReturnType<typeof createEnv>>;

/** the server stand-in rule hooks: add a rule that answers a rejection or a conflict for an op type (offline3.fixtures simServer.rules) */
export const rule = (env: BaseEnv | Env, f: (op: any) => Record<string, unknown> | undefined) => { (env as any).sim.sim.rules.push(f); };
export async function drainAll(env: Env, max = 20) {
  for (let i = 0; i < max; i++) {
    await env.drain();
    if ((await env.outbox.count()) === 0) return;
    env.c.advance(600_000);
  }
}
export const ops = (env: Env, type?: string) => (env as any).sim.batches.flatMap((b: any) => b.body.operations as Array<{ op_id: string; op_type: string; entity_id?: string; base_version?: number; payload: any }>)
  .filter((o: { op_type: string }) => !type || o.op_type === type);
