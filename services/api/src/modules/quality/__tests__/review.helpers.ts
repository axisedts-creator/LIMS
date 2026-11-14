// C9 T-12 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute.
// Sibling convention: target.helpers.ts (T-08), run.helpers.ts (T-10). Spec: 02-TRD §5.5 (#26-#33), §5.10 (DTOs), §7.7 (close-out guard); 03-APP-FLOW §2.1 QR5/QR7, §2.2; 05-SCHEMA §8; PRD AC-07.1-07.5; 07-SECURITY S-09/S-10/S-11/S-16.
//
//   ../repository/review.repo.ts    exports `ReviewRepo` (interface below) + `createReviewRepo(): ReviewRepo`. SQL on the caller's tx (`tx.query(text, values)`), parameterised, explicit `tenant_id = $n` on EVERY
//                                   statement, quality.* only. Timestamps leave as ISO text with ms ('...sssZ'), numerics as decimal text, RLS-invisible rows -> undefined. Postgres errors pass through UNCHANGED.
//                                   It has NO UPDATE/DELETE on qc_corrective_actions / qc_run_reviews (append-only) and its only observation UPDATE sets the exclusion columns (status 'excluded', excluded_*, updated_*).
//   ../repository/run.repo.ts       T-10 file, extended by T-12: `updateRun` PATCHABLE gains `closed_at`, `closed_by`. The close guard runs the update through `RunRepo.updateRun` after `RunRepo.lockPlan`.
//   ../service/review.service.ts    exports `createReviewService(deps?: { repo?: ReviewRepo; runRepo?: RunRepo; runs?: { evaluateNow(ctx, { runId, planId }): Promise<Row> } })` -> one async method per operationId
//                                   #26-#33 `(ctx, input) => { status, body, version? }` (same Result shape as target.service):
//                                     listQcObservations{planId?,instrumentId?,analyteId?,levelId?,lotId?,status?(csv string as on the wire),observedAtFrom?,observedAtTo?,sort?,cursor?,limit?}
//                                     excludeQcObservation{observationId,expectedVersion,body}   listQcRuns{planId?,instrumentId?,analyteId?,status?,outcome?(csv),needsAction?,runAtFrom?,runAtTo?,sort?,cursor?,limit?}
//                                     getQcRun{runId}   evaluateQcRunNow{runId,expectedVersion,body}   recordCorrectiveAction{runId,body}   closeQcRun{runId,expectedVersion,body}   acknowledgeQcRun{runId,body}
//                                   Order for reads: assertRole('quality.qc_run.read') -> validate query -> repo. Order for writes: assertRole (first, before any repo call; #27 'quality.qc.manage', #30-#33
//                                   'quality.qc_run.review') -> validate -> (If-Match required and missing? 428 common.precondition_required) -> load (404 common.not_found when invisible) -> version check (409
//                                   common.version_conflict) -> state/guard checks -> write. Bodies are snake_case exactly as quality.yaml; unknown fields -> 400 common.validation_failed with errors[] =
//                                   [{ path, code: 'common.unknown_field'|'common.field_invalid'|'common.field_required' }]. Tenant, actor, ids come from ctx / the service only.
//                                   `version` of the Result = the row's version (ETag): #27 observation, #30/#32 run. #29/#31/#33 carry none (#31/#33 are 201).
//   ../service/run.service.ts       T-10 file, extended by T-12: `createRunService(...).evaluateNow(ctx, { runId, planId })` (QR5 via #30; planId = the plan of the run the review service already read; unknown plan -> common.not_found): runs under the pair lock (repo.lockPlan first), re-reads the collecting run
//                                   of the plan UNDER the lock, and if it is not the collecting run (or none) throws LimsError('quality.qc_run_already_evaluated'); otherwise finalises it exactly as close_stale_runs
//                                   does (mode 'final': incomplete / accepted_warning-stays-incomplete / rejected + event iff rejected, same tx); evaluated_by = ctx.actor.id. Returns the updated run row.
//   coded sets                      repo.findCode(tx, t, 'corrective_actions' | 'exclusion_reasons', code) -> { code, display, is_active, source } | undefined (tenant override beats global).
//                                   Unknown or inactive code -> 400 common.validation_failed errors[{ path: '/action_code' | '/reason_code', code: 'common.field_invalid' }].
//   staff names                     repo.listUserLabels(tx, t, userIds) / repo.listMembershipLabels(tx, t, membershipIds) (OPEN seam, same as target.helpers.ts / .orchestra/cr/C9.T-15.md): every `*_display`
//                                   / `evaluated_by` is a label; missing label -> a non-empty placeholder, never the raw id. `evaluated_by` is 'system' for the system actor id (SYSTEM below), else the user label.
//   transaction                     every repo call receives `ctx.tx`; the service never opens/commits/rolls back a transaction itself.
//   clock                           `ctx.now()` only (corrective-action bounds, closed_at, excluded_at, created_at).
import { LimsError } from '../../../core/errors.js';
import { ANA, INS, LVL, NOW, PLN, TENANT_A, TENANT_B, idN, planParams, type PlanParams, type Row } from './run.helpers.js';
import { OBS, RUN, SYSTEM, at } from './run.helpers.js';
// USER/MEM = the ctx actor of setup.helpers (ruling C9.T-12-ruling.md #1): created_by/updated_by = ctx.actor.id
import { USER } from './setup.helpers.js';
import { makePlanCtx } from './plan.helpers.js';
export { ANA, INS, LVL, NOW, PLN, TENANT_A, TENANT_B, USER, idN, OBS, RUN, SYSTEM, at, planParams, type PlanParams, type Row };
export { rejection, code, REQ_ID, UUID7, MEM, forbidden, readOnly, noRights, PLANTED } from './setup.helpers.js';

export const CA = (n: number) => idN(0xc800 + n);
export const REV = (n: number) => idN(0xc900 + n);
export const OTHER_USER = idN(0xd9);
export const OTHER_MEM = idN(0xd3);
export const OPS = ['listQcObservations', 'excludeQcObservation', 'listQcRuns', 'getQcRun', 'evaluateQcRunNow', 'recordCorrectiveAction', 'closeQcRun', 'acknowledgeQcRun'] as const;
export const SUMMARY_KEYS = ['analyte_id', 'closed_at', 'controls_per_run', 'id', 'instrument_id', 'is_complete', 'needs_action', 'observation_count', 'outcome', 'plan_id', 'rule_mode', 'rules_violated', 'run_at', 'status', 'version', 'warning_rules'];
export const CA_KEYS = ['action_code', 'action_display', 'created_at', 'description', 'id', 'performed_at', 'performed_by_display', 'qc_run_id'];
export const REVIEW_KEYS = ['comment', 'created_at', 'id', 'kind', 'qc_run_id', 'reviewed_by_display'];
export const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------------- state
export interface Page<T = Row> { rows: T[]; nextCursor?: string }
export interface ReviewRepo {
  listObservations(tx: any, t: string, q: { planId?: string; instrumentId?: string; analyteId?: string; levelId?: string; lotId?: string; statuses?: string[]; from: string; to: string; sort: 'observed_at' | '-observed_at'; cursor?: string; limit: number }): Promise<Page>;
  findObservation(tx: any, t: string, id: string): Promise<Row | undefined>;                     // + run_status (qc_runs.status of its qc_run_id, null when it has no run)
  excludeObservation(tx: any, t: string, id: string, expectedVersion: number, patch: { excluded_reason_code: string; excluded_comment: string | null; excluded_by: string; excluded_at: string; updated_by: string }): Promise<Row | undefined>; // undefined = version mismatch; sets status 'excluded'
  listRuns(tx: any, t: string, q: { planId?: string; instrumentId?: string; analyteId?: string; statuses?: string[]; outcomes?: string[]; needsAction?: boolean; from: string; to: string; cursor?: string; limit: number }): Promise<Page>; // rows + corrective_action_count
  findRun(tx: any, t: string, id: string): Promise<Row | undefined>;                              // run row + corrective_action_count + run_window_minutes (plan's current version)
  listRunObservations(tx: any, t: string, runId: string): Promise<Row[]>;                          // members of the run (any status) ORDER BY observed_at, id
  listCorrectiveActions(tx: any, t: string, runId: string): Promise<Row[]>;                        // + action_display; oldest first
  listReviews(tx: any, t: string, runId: string): Promise<Row[]>;                                  // oldest first
  hasLaterAcceptedRun(tx: any, t: string, planId: string, after: string): Promise<boolean>;        // (SELECT 1 ... LIMIT 1: any row = true) a run of the plan: outcome accepted|accepted_warning AND run_at > after (strict)
  insertCorrectiveAction(tx: any, t: string, row: Row): Promise<Row>;
  insertReview(tx: any, t: string, row: Row): Promise<Row>;
  findCode(tx: any, t: string, set: 'corrective_actions' | 'exclusion_reasons', code: string): Promise<{ code: string; display: string; is_active: boolean; source: string } | undefined>;
  listUserLabels(tx: any, t: string, userIds: string[]): Promise<Array<{ user_id: string; display_name: string }>>;
  listMembershipLabels(tx: any, t: string, membershipIds: string[]): Promise<Array<{ membership_id: string; display_name: string }>>;
}

export const pgErr = (code: string, message = 'pg error') => Object.assign(new Error(message), { code });
export const immutableRow = () => pgErr('P0001', 'immutable_row');

export const runRow = (n: number, o: Row = {}): Row => ({
  id: RUN(n), tenant_id: TENANT_A, plan_id: PLN(1), plan_version_no: 3, instrument_id: INS(1), analyte_id: ANA(1), controls_per_run: 2, rule_mode: 'classic', mean_rule: '8x', run_at: at('08:00:00'),
  last_member_received_at: at('08:00:00'), last_assembled_at: at('08:00:05'), observation_count: 2, status: 'evaluated', outcome: 'rejected', is_complete: true, rules_violated: ['1-3s'], warning_rules: [],
  rule_detail: [{ rule: '1-3s', observation_ids: [OBS(1)] }], evaluated_at: at('08:00:06'), evaluated_by: SYSTEM, last_in_control_run_at: at('06:00:00'), hold_since: at('06:00:00'), rejection_event_id: idN(0xe500 + n),
  closed_at: null, closed_by: null, version: 2, created_at: at('08:00:05'), created_by: SYSTEM, updated_at: at('08:00:06'), updated_by: SYSTEM, internal_note: 'PLANTED-INTERNAL-7c1e', ...o,
});
export const obsRow = (n: number, o: Row = {}): Row => ({
  id: OBS(n), tenant_id: TENANT_A, plan_id: PLN(1), instrument_id: INS(1), analyte_id: ANA(1), level_id: LVL(1), lot_id: idN(0x5001), target_id: idN(0x8801), control_id_raw: 'QC-L1', control_lot_raw: null,
  control_level_raw: '1', value: '106.000000', unit_code: 'mmol_l', observed_at: at('08:00:00'), received_at: at('08:00:00'), observed_at_basis: 'instrument', source: 'instrument', status: 'assigned', qc_run_id: RUN(1),
  mean: '100.000000', sd: '2.000000', z: '3.000000', excluded_reason_code: null, excluded_comment: null, excluded_by: null, excluded_at: null, version: 1, created_by: SYSTEM, source_qc_result_id: idN(0xa000 + n),
  internal_note: 'PLANTED-INTERNAL-7c1e', ...o,
});

export interface Seed { runs?: Row[]; observations?: Row[]; correctives?: Row[]; reviews?: Row[]; plans?: PlanParams[]; codes?: Row[]; users?: Row[]; memberships?: Row[] }
/** Tenant A: PLN(1) (run_window_minutes 30). Runs: RUN(1) rejected+evaluated v2 (08:00, no corrective action); RUN(2) collecting v1; RUN(3) accepted_warning v2; RUN(4) accepted v2; RUN(5) closed v4.
 *  Tenant B: RUN(9). Observations: OBS(1) assigned in RUN(1); OBS(2) assigned in RUN(2) (collecting); OBS(3) no_plan with no run; OBS(9) tenant B. */
export function baseSeed(): Seed {
  return {
    plans: [planParams()],
    runs: [
      runRow(1), runRow(2, { status: 'collecting', outcome: null, is_complete: null, rules_violated: [], rule_detail: [], evaluated_at: null, evaluated_by: null, last_in_control_run_at: null, hold_since: null, rejection_event_id: null, version: 1, observation_count: 1 }),
      runRow(3, { outcome: 'accepted_warning', rules_violated: [], warning_rules: ['1-2s'], rule_detail: [], hold_since: null, last_in_control_run_at: null, rejection_event_id: null }),
      runRow(4, { outcome: 'accepted', rules_violated: [], rule_detail: [], hold_since: null, last_in_control_run_at: null, rejection_event_id: null }),
      runRow(5, { status: 'closed', closed_at: at('10:30:00'), closed_by: USER, version: 4 }),
      runRow(9, { tenant_id: TENANT_B, plan_id: PLN(9) }),
    ],
    observations: [obsRow(1), obsRow(2, { qc_run_id: RUN(2), version: 1 }), obsRow(3, { status: 'no_plan', qc_run_id: null, plan_id: null, level_id: null, lot_id: null, target_id: null, mean: null, sd: null, z: null }),
      obsRow(9, { tenant_id: TENANT_B, qc_run_id: RUN(9) })],
    correctives: [], reviews: [],
    codes: [
      { set: 'corrective_actions', code: 'recalibration', display: 'Recalibrated', is_active: true, source: 'global' }, { set: 'corrective_actions', code: 'retired_code', display: 'Retired', is_active: false, source: 'global' },
      { set: 'exclusion_reasons', code: 'wrong_material', display: 'Wrong control material', is_active: true, source: 'global' }, { set: 'exclusion_reasons', code: 'retired_reason', display: 'Retired', is_active: false, source: 'tenant' },
    ],
    users: [{ tenant_id: TENANT_A, user_id: USER, display_name: 'Synthetic Technologist' }, { tenant_id: TENANT_A, user_id: OTHER_USER, display_name: 'Synthetic Lab Manager' }],
    memberships: [{ tenant_id: TENANT_A, membership_id: idN(0xd2), display_name: 'Synthetic Technologist' }, { tenant_id: TENANT_A, membership_id: OTHER_MEM, display_name: 'Synthetic Lab Manager' }],
  };
}
export const caRow = (n: number, run: number, o: Row = {}): Row => ({
  id: CA(n), tenant_id: TENANT_A, qc_run_id: RUN(run), action_code: 'recalibration', description: 'Recalibrated the analyser with fresh calibrator', performed_at: at('08:20:00'), performed_by_membership_id: idN(0xd2),
  created_at: at('08:21:00'), created_by: USER, ...o,
});

/** In-memory repo: tenant-aware like RLS + the explicit predicate; emulates the observation exclusion trigger (P0001 immutable_row when the run is not collecting), the run lifecycle/frozen trigger
 *  for the rows it updates, the version check, append-only logs (no update/delete method exists) and the 05-SCHEMA text checks. */
export function makeReviewRepo(seed: Seed = baseSeed()) {
  const s = { runs: (seed.runs ?? []).map((r) => ({ ...r })), observations: (seed.observations ?? []).map((r) => ({ ...r })), correctives: (seed.correctives ?? []).map((r) => ({ ...r })),
    reviews: (seed.reviews ?? []).map((r) => ({ ...r })), plans: seed.plans ?? [], codes: seed.codes ?? [], users: seed.users ?? [], memberships: seed.memberships ?? [] };
  const calls: Array<{ op: string; tenantId?: string; tx: unknown; args: unknown[] }> = [];
  const mine = (xs: Row[], t: string) => xs.filter((x) => x['tenant_id'] === t);
  const rec = <T>(op: string, tx: unknown, t: string | undefined, args: unknown[], fn: () => T): T => { calls.push({ op, tenantId: t, tx, args }); return fn(); };
  const window = (r: Row) => s.plans.find((p) => p.plan_id === r['plan_id'])?.run_window_minutes ?? 30;
  const withCount = (r: Row): Row => ({ ...structuredClone(r), corrective_action_count: s.correctives.filter((c) => c['tenant_id'] === r['tenant_id'] && c['qc_run_id'] === r['id']).length, run_window_minutes: window(r) });
  const needsAction = (r: Row) => r['outcome'] === 'rejected' && r['status'] !== 'closed';
  const repo: ReviewRepo = {
    async listObservations(tx, t, q) {
      return rec('listObservations', tx, t, [q], () => {
        let rows = mine(s.observations, t).filter((o) => (!q.planId || o['plan_id'] === q.planId) && (!q.instrumentId || o['instrument_id'] === q.instrumentId) && (!q.analyteId || o['analyte_id'] === q.analyteId)
          && (!q.levelId || o['level_id'] === q.levelId) && (!q.lotId || o['lot_id'] === q.lotId) && (!q.statuses || q.statuses.includes(o['status'])) && o['observed_at'] >= q.from && o['observed_at'] <= q.to);
        rows = rows.sort((a, b) => (a['observed_at'] < b['observed_at'] ? -1 : 1) * (q.sort === '-observed_at' ? -1 : 1));
        return { rows: structuredClone(rows) };
      });
    },
    async findObservation(tx, t, id) {
      return rec('findObservation', tx, t, [id], () => {
        const o = mine(s.observations, t).find((x) => x['id'] === id); if (!o) return undefined;
        return { ...structuredClone(o), run_status: o['qc_run_id'] ? (mine(s.runs, t).find((r) => r['id'] === o['qc_run_id'])?.['status'] ?? null) : null };
      });
    },
    async excludeObservation(tx, t, id, v, patch) {
      return rec('excludeObservation', tx, t, [id, v, patch], () => {
        const o = mine(s.observations, t).find((x) => x['id'] === id); if (!o || o['version'] !== v) return undefined;
        const run = o['qc_run_id'] ? mine(s.runs, t).find((r) => r['id'] === o['qc_run_id']) : undefined;
        if (run && run['status'] !== 'collecting') throw immutableRow();                       // quality.enforce_observation_exclusion
        Object.assign(o, patch, { status: 'excluded', version: o['version'] + 1 }); return structuredClone(o);
      });
    },
    async listRuns(tx, t, q) {
      return rec('listRuns', tx, t, [q], () => {
        const rows = mine(s.runs, t).filter((r) => (!q.planId || r['plan_id'] === q.planId) && (!q.instrumentId || r['instrument_id'] === q.instrumentId) && (!q.analyteId || r['analyte_id'] === q.analyteId)
          && (!q.statuses || q.statuses.includes(r['status'])) && (!q.outcomes || q.outcomes.includes(r['outcome'])) && (q.needsAction === undefined || needsAction(r) === q.needsAction)
          && r['run_at'] >= q.from && r['run_at'] <= q.to).sort((a, b) => (a['run_at'] < b['run_at'] ? 1 : -1));
        return { rows: rows.map(withCount) };
      });
    },
    async findRun(tx, t, id) { return rec('findRun', tx, t, [id], () => { const r = mine(s.runs, t).find((x) => x['id'] === id); return r ? withCount(r) : undefined; }); },
    async listRunObservations(tx, t, runId) { return rec('listRunObservations', tx, t, [runId], () => structuredClone(mine(s.observations, t).filter((o) => o['qc_run_id'] === runId).sort((a, b) => (a['observed_at'] < b['observed_at'] ? -1 : 1)))); },
    async listCorrectiveActions(tx, t, runId) {
      return rec('listCorrectiveActions', tx, t, [runId], () => mine(s.correctives, t).filter((c) => c['qc_run_id'] === runId)
        .map((c) => ({ ...structuredClone(c), action_display: s.codes.find((x) => x['set'] === 'corrective_actions' && x['code'] === c['action_code'])?.['display'] ?? c['action_code'] })));
    },
    async listReviews(tx, t, runId) { return rec('listReviews', tx, t, [runId], () => structuredClone(mine(s.reviews, t).filter((c) => c['qc_run_id'] === runId))); },
    async hasLaterAcceptedRun(tx, t, planId, after) {
      return rec('hasLaterAcceptedRun', tx, t, [planId, after], () => mine(s.runs, t).some((r) => r['plan_id'] === planId && ['accepted', 'accepted_warning'].includes(r['outcome']) && r['run_at'] > after));
    },
    async insertCorrectiveAction(tx, t, row) {
      return rec('insertCorrectiveAction', tx, t, [row], () => {
        if (!mine(s.runs, t).some((r) => r['id'] === row['qc_run_id'])) throw pgErr('23503');
        if ([...String(row['description'])].length < 1 || [...String(row['description'])].length > 1000) throw pgErr('23514');
        const r = { ...row, tenant_id: t }; s.correctives.push(r); return structuredClone(r);
      });
    },
    async insertReview(tx, t, row) {
      return rec('insertReview', tx, t, [row], () => {
        if (!mine(s.runs, t).some((r) => r['id'] === row['qc_run_id'])) throw pgErr('23503');
        if (!['acknowledge', 'evaluate_now', 'close'].includes(row['kind'])) throw pgErr('23514');
        if (row['kind'] === 'acknowledge' && [...String(row['comment'] ?? '')].length < 1) throw pgErr('23514');
        const r = { ...row, tenant_id: t }; s.reviews.push(r); return structuredClone(r);
      });
    },
    async findCode(tx, t, set, code) { return rec('findCode', tx, t, [set, code], () => { const c = s.codes.find((x) => x['set'] === set && x['code'] === code); return c ? { code: c['code'], display: c['display'], is_active: c['is_active'], source: c['source'] } : undefined; }); },
    async listUserLabels(tx, t, ids) { return rec('listUserLabels', tx, t, [ids], () => mine(s.users, t).filter((u) => ids.includes(u['user_id'])).map((u) => ({ user_id: u['user_id'], display_name: u['display_name'] }))); },
    async listMembershipLabels(tx, t, ids) { return rec('listMembershipLabels', tx, t, [ids], () => mine(s.memberships, t).filter((u) => ids.includes(u['membership_id'])).map((u) => ({ membership_id: u['membership_id'], display_name: u['display_name'] }))); },
  };
  return {
    repo, state: s, calls,
    callsOf: (op: string) => calls.filter((c) => c.op === op),
    writes: () => calls.filter((c) => /^(insert|exclude|update)/.test(c.op)),
    run: (n: number) => s.runs.find((r) => r['id'] === RUN(n))!,
    obs: (n: number) => s.observations.find((r) => r['id'] === OBS(n))!,
  };
}
export type FakeReviewRepo = ReturnType<typeof makeReviewRepo>;

/** A RunRepo double for the close path: only lockPlan + updateRun, recording order against the review repo; updateRun emulates quality.enforce_run_frozen and the lifecycle CHECK. */
export function makeRunRepoDouble(fake: FakeReviewRepo) {
  const calls: Array<{ op: string; tx: unknown; args: unknown[] }> = [];
  const order: string[] = [];
  const repo: any = {
    async lockPlan(tx: any, t: string, planId: string) { calls.push({ op: 'lockPlan', tx, args: [planId] }); order.push('lockPlan'); return t === TENANT_A && planId === PLN(1) ? planParams() : undefined; },
    async updateRun(tx: any, t: string, id: string, patch: Row) {
      calls.push({ op: 'updateRun', tx, args: [id, patch] }); order.push('updateRun');
      const r = fake.state.runs.find((x) => x['tenant_id'] === t && x['id'] === id); if (!r) throw pgErr('P0002');
      const allowed = ['status', 'closed_at', 'closed_by', 'updated_by'];
      if (Object.keys(patch).some((k) => !allowed.includes(k))) throw new Error(`unexpected column in close update: ${Object.keys(patch).join(',')}`);
      if (r['status'] === 'closed') throw immutableRow();
      if (patch['status'] === 'closed' && !fake.state.correctives.some((c) => c['qc_run_id'] === id)) throw immutableRow();     // enforce_run_frozen backstop
      Object.assign(r, patch, { version: r['version'] + 1 }); return structuredClone(r);
    },
  };
  return { repo, calls, order };
}

/** Service ctx (user actor with a membership id) over the shared plan ctx. `roles` may throw auth.forbidden. */
export function makeReviewCtx(over: { tenantId?: string; roles?: (c: { permission: string }) => void; now?: string } = {}) {
  const base = makePlanCtx(over);
  return { ...base, ctx: base.ctx, asserted: base.asserted, queries: base.queries };
}
export { LimsError };
export const FULL = ['quality.qc_run.read', 'quality.qc_run.review', 'quality.qc.manage'];
