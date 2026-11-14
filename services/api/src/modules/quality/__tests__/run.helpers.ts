// C9 T-10 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute.
// Sibling convention: observation.helpers.ts (T-09). 02-TRD §7.3 (assembly), §7.5, §7.7 (event + hold_since), §10.1/§10.3, §14 (gauge); 03-APP-FLOW §2.1 QR1-QR6; PRD AC-06.6-06.9.
//
//   ../repository/run.repo.ts        exports `RunRepo` (interface below) + `createRunRepo(): RunRepo`. SQL on the caller's tx (`tx.query(text, values)`), parameterised, explicit `tenant_id = $n` on EVERY statement.
//                                    Rows are snake_case DB columns (05-SCHEMA qc_runs / qc_observations), timestamps ISO strings ('...sssZ'), RLS-invisible rows -> undefined. Postgres errors pass through unchanged.
//   ../events/publish.ts             exports `createQualityEvents(events: { publish(ctx, type, input) })` -> `{ publishQcRunRejected(ctx, payload, { runVersion }): Promise<{ eventId, duplicate }> }`.
//                                    `payload` = the 03-IC §3.21 payload exactly (snake_case, ISO-UTC strings; `last_in_control_run_at` ABSENT, never null, when unknown). The publisher fills
//                                    aggregate { type 'qc_run', id payload.qc_run_id, seq runVersion } and idempotencyKey `<qc_run_id>:rejected`, adds no key to the payload, and fails closed on a schema violation.
//   ../service/run.service.ts        exports `createRunService(deps?: { repo?: RunRepo; events?: QualityEvents })` -> `{ assign(ctx, draft): Promise<{ qc_run_id }>, closeStaleRuns(ctx): Promise<CloseStaleResult> }`.
//                                    `assign` IS the T-09 `RunAssembler` seam (observation.service.ts): called per `assigned` draft BEFORE the observation insert, on the job tx, under the pair lock the caller already holds;
//                                    it takes `repo.lockPlan` again itself (same-tx re-lock is free) and returns the run the observation joins. The draft is NOT yet in `listRunMembers`: the service adds it in memory.
//                                    `closeStaleRuns(ctx)` = TRD §7.3 step 7: for every collecting run whose `last_assembled_at` is strictly older than `ctx.now() - run_window_minutes` (per plan): lockPlan, re-read the
//                                    collecting run UNDER the lock (skip when it is gone / no longer collecting / no longer stale), finalise (QR5), publish on rejection, never twice. Runs in ascending plan_id order.
//                                    CloseStaleResult = { closed: number, rejected: number, oldestRejectedWithoutActionAgeSeconds: number } (seconds between ctx.now() and the oldest evaluated rejected run's
//                                    `evaluated_at` with no corrective action, computed AFTER the finalisations; 0 when there is none).
//   ../../../../../worker/src/jobs/quality/tasks/close_stale_runs.ts  see close_stale_runs.test.ts.
//   Clock: `ctx.now()` is the only clock (`last_assembled_at`, `evaluated_at`, `rejected_at`, staleness). No `new Date()` in domain/service decisions.
//   Pair lock fake: lockPlan blocks while ANOTHER tx holds the plan until `h.commit(tx)`; the same tx re-locks freely.
import { makeEventDb, USER, REQ_ID } from '../../../core/events/__tests__/helpers.js';
import { createEvents } from '../../../core/events/publish.js';
import { createRunService } from '../service/run.service.js';
import { createQualityEvents } from '../events/publish.js';
import { INS, LVL, NOW, TENANT_A, TENANT_B, idN, type Row } from './setup.helpers.js';
import { ANA, PLN } from './plan.helpers.js';
export { INS, LVL, TENANT_A, TENANT_B, idN, ANA, PLN, USER, NOW, type Row };
export { rejection, code } from './setup.helpers.js';

export const OBS = (n: number) => idN(0xb000 + n);
export const RUN = (n: number) => idN(0xa800 + n);
export const TGT = (n: number) => idN(0x8800 + n);
export const HIST = (n: number) => idN(0xb800 + n);
export const SYSTEM = idN(0x1ee0);
export const DAY = '2026-11-13';
/** `at('08:05:00')` -> '2026-11-13T08:05:00.000Z' */
export const at = (hms: string, day = DAY) => `${day}T${hms}.000Z`;

export interface PlanParams {
  plan_id: string; instrument_id: string; analyte_id: string; version_no: number; controls_per_run: 2 | 3 | 4;
  composition: Array<{ level_id: string; count: number }>; mean_rule: string; two_two_s_across_runs: boolean; count_rules_across_materials: boolean;
  exclude_rejected_runs_from_history: boolean; run_window_minutes: number; hold_lookback_hours: number;
}
export const planParams = (o: Partial<PlanParams> = {}): PlanParams => ({
  plan_id: PLN(1), instrument_id: INS(1), analyte_id: ANA(1), version_no: 3, controls_per_run: 2, composition: [{ level_id: LVL(1), count: 1 }, { level_id: LVL(2), count: 1 }], mean_rule: '8x',
  two_two_s_across_runs: true, count_rules_across_materials: true, exclude_rejected_runs_from_history: true, run_window_minutes: 30, hold_lookback_hours: 24, ...o,
});

export interface RunRepo {
  lockPlan(tx: any, tenantId: string, planId: string): Promise<PlanParams | undefined>;                               // SELECT ... FROM quality.qc_plans (+ current quality.qc_plan_versions row) WHERE tenant_id AND id FOR UPDATE
  findCollectingRun(tx: any, tenantId: string, planId: string): Promise<Row | undefined>;                            // status = 'collecting' (partial unique index: at most one)
  findLatestEarlyRejectedRun(tx: any, tenantId: string, planId: string): Promise<Row | undefined>;                   // latest by run_at DESC: status 'evaluated' AND outcome 'rejected' AND is_complete = false
  listCollectingRuns(tx: any, tenantId: string): Promise<Array<Row & { run_window_minutes: number }>>;               // every collecting run of the tenant + its plan's run_window_minutes
  insertRun(tx: any, tenantId: string, row: Row): Promise<void>;
  updateRun(tx: any, tenantId: string, runId: string, patch: Row): Promise<Row>;                                     // column allowlist; version = version + 1; returns the updated row
  listRunMembers(tx: any, tenantId: string, runId: string): Promise<Row[]>;                                          // status 'assigned' observations of the run, ORDER BY observed_at, id: { id, level_id, value, mean, sd, observed_at, received_at }
  listHistory(tx: any, tenantId: string, planId: string, o: { excludeRunId: string; excludeRejectedRuns: boolean; limit: number }): Promise<Row[]>; // already filtered, OLDEST FIRST
  latestInControlRunAt(tx: any, tenantId: string, planId: string, beforeRunAt: string): Promise<string | undefined>; // run_at of the latest run with outcome accepted|accepted_warning and run_at < beforeRunAt
  resetQcActivity(tx: any, tenantId: string, planId: string, runAt: string): Promise<void>;                          // upsert: last_qc_run_at = runAt, patient_results_since_last_qc = 0
  oldestRejectedWithoutActionAt(tx: any, tenantId: string): Promise<string | undefined>;                             // min(evaluated_at) of evaluated rejected runs with no qc_corrective_actions row
}

const pgErr = (code: string, constraint = '') => Object.assign(new Error('pg error'), { code, constraint });
const FROZEN = ['outcome', 'rules_violated', 'warning_rules', 'is_complete', 'evaluated_at', 'hold_since', 'last_in_control_run_at', 'run_at', 'plan_id', 'rule_mode'];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const draft = (n: number, level: 1 | 2 | 3, z: number, observedAt: string, o: Row = {}): Row => ({
  id: OBS(n), tenant_id: TENANT_A, source_qc_result_id: idN(0xa000 + n), source: 'instrument', instrument_id: INS(1), analyte_id: ANA(1), plan_id: PLN(1), level_id: LVL(level), lot_id: idN(0x5000 + level),
  target_id: TGT(level), control_id_raw: `QC-L${level}`, control_lot_raw: null, control_level_raw: String(level), value: (100 + 2 * z).toFixed(6), unit_code: 'mmol_l', instrument_result_time: observedAt,
  received_at: observedAt, observed_at: observedAt, observed_at_basis: 'instrument', status: 'assigned', mean: '100.000000', sd: '2.000000', z: z.toFixed(6), qc_run_id: null,
  classified_at: observedAt, created_by: SYSTEM, updated_by: SYSTEM, ...o,
});

export interface Hooks { onLock?: (planId: string, state: State) => void; failOp?: Record<string, Error> }
export interface State { plans: PlanParams[]; runs: Row[]; observations: Row[]; history: Row[]; activity: Row[]; corrective: Row[] }
export interface Call { op: string; tenantId: string; tx: any; args: unknown[] }

export function makeRunHarness(o: { mode?: string | null; plan?: Partial<PlanParams>; now?: string; hooks?: Hooks } = {}) {
  const db = makeEventDb();
  const state: State = { plans: [planParams(o.plan), planParams({ ...o.plan, plan_id: PLN(9), instrument_id: INS(2), analyte_id: ANA(2) })], runs: [], observations: [], history: [], activity: [], corrective: [] };
  const calls: Call[] = [];
  const clock = { iso: o.now ?? at('08:00:05') };
  const holders = new Map<string, any>();
  let wake: Array<() => void> = [];
  const release = (tx: any) => { for (const [k, v] of [...holders]) if (v === tx) holders.delete(k); const w = wake; wake = []; w.forEach((f) => f()); };
  const mine = <T extends Row>(xs: T[], t: string) => xs.filter((x) => x['tenant_id'] === t);
  const rec = async <T>(op: string, tx: any, tenantId: string, args: unknown[], fn: () => T): Promise<T> => {
    calls.push({ op, tenantId, tx, args });
    await Promise.resolve();                                // yield: lets a concurrent tx interleave (pair-lock test)
    const bad = o.hooks?.failOp?.[op]; if (bad) throw bad;
    return fn();
  };
  const byRunAt = (a: Row, b: Row) => (a['run_at'] < b['run_at'] ? 1 : a['run_at'] > b['run_at'] ? -1 : 0);

  const repo: RunRepo = {
    async lockPlan(tx, t, planId) {
      calls.push({ op: 'lockPlan', tenantId: t, tx, args: [planId] });
      while (holders.has(`${t}|${planId}`) && holders.get(`${t}|${planId}`) !== tx) await new Promise<void>((r) => wake.push(r));
      holders.set(`${t}|${planId}`, tx);
      await Promise.resolve();
      o.hooks?.onLock?.(planId, state);
      const p = t === TENANT_A ? state.plans.find((x) => x.plan_id === planId) : undefined;
      return p ? structuredClone(p) : undefined;
    },
    async findCollectingRun(tx, t, p) { return rec('findCollectingRun', tx, t, [p], () => { const r = mine(state.runs, t).find((x) => x['plan_id'] === p && x['status'] === 'collecting'); return r ? structuredClone(r) : undefined; }); },
    async findLatestEarlyRejectedRun(tx, t, p) {
      return rec('findLatestEarlyRejectedRun', tx, t, [p], () => {
        const r = mine(state.runs, t).filter((x) => x['plan_id'] === p && x['status'] === 'evaluated' && x['outcome'] === 'rejected' && x['is_complete'] === false).sort(byRunAt)[0];
        return r ? structuredClone(r) : undefined;
      });
    },
    async listCollectingRuns(tx, t) {
      return rec('listCollectingRuns', tx, t, [], () => mine(state.runs, t).filter((x) => x['status'] === 'collecting')
        .map((x) => ({ ...structuredClone(x), run_window_minutes: state.plans.find((p) => p.plan_id === x['plan_id'])!.run_window_minutes })));
    },
    async insertRun(tx, t, row) {
      return rec('insertRun', tx, t, [row], () => {
        if (row['tenant_id'] !== t) throw pgErr('42501');
        if (row['status'] === 'collecting' && mine(state.runs, t).some((x) => x['plan_id'] === row['plan_id'] && x['status'] === 'collecting')) throw pgErr('23505', 'qc_runs__tenant_plan_collecting__p_uq');
        state.runs.push(structuredClone(row));
      });
    },
    async updateRun(tx, t, runId, patch) {
      return rec('updateRun', tx, t, [runId, patch], () => {
        const r = mine(state.runs, t).find((x) => x['id'] === runId);
        if (!r) throw pgErr('P0002', 'no such run');
        const next = { ...r, ...structuredClone(patch), version: r['version'] + 1, updated_at: clock.iso };
        if (r['outcome'] != null && FROZEN.some((k) => k in patch && !same(patch[k], r[k]))) throw pgErr('P0001', 'immutable_row');   // quality.enforce_run_frozen
        if (next['status'] === 'closed' && r['status'] !== 'closed' && !state.corrective.some((c) => c['qc_run_id'] === runId)) throw pgErr('P0001', 'immutable_row');
        const lifecycle = (next['status'] === 'collecting' && next['outcome'] == null && next['evaluated_at'] == null)
          || (next['status'] === 'evaluated' && next['outcome'] != null && next['evaluated_at'] != null && next['closed_at'] == null) || next['status'] === 'closed';
        if (!lifecycle) throw pgErr('23514', 'qc_runs__lifecycle__ck');
        if (next['outcome'] === 'rejected' && (!(next['rules_violated'] ?? []).length || !next['hold_since'])) throw pgErr('23514', 'qc_runs__rejected__ck / qc_runs__hold__ck');
        Object.assign(r, next);
        return structuredClone(r);
      });
    },
    async listRunMembers(tx, t, runId) {
      return rec('listRunMembers', tx, t, [runId], () => structuredClone(mine(state.observations, t).filter((x) => x['qc_run_id'] === runId && x['status'] === 'assigned')
        .sort((a, b) => (a['observed_at'] < b['observed_at'] ? -1 : a['observed_at'] > b['observed_at'] ? 1 : a['id'] < b['id'] ? -1 : 1))));
    },
    async listHistory(tx, t, p, q) { return rec('listHistory', tx, t, [p, q], () => structuredClone(mine(state.history, t).filter((x) => x['plan_id'] === p))); },
    async latestInControlRunAt(tx, t, p, before) {
      return rec('latestInControlRunAt', tx, t, [p, before], () => mine(state.runs, t).filter((x) => x['plan_id'] === p && ['accepted', 'accepted_warning'].includes(x['outcome']) && x['run_at'] < before).sort(byRunAt)[0]?.['run_at']);
    },
    async resetQcActivity(tx, t, p, runAt) {
      return rec('resetQcActivity', tx, t, [p, runAt], () => {
        const a = state.activity.find((x) => x['tenant_id'] === t && x['plan_id'] === p);
        if (a) { a['last_qc_run_at'] = runAt; a['patient_results_since_last_qc'] = 0; } else state.activity.push({ tenant_id: t, plan_id: p, last_qc_run_at: runAt, patient_results_since_last_qc: 0 });
      });
    },
    async oldestRejectedWithoutActionAt(tx, t) {
      return rec('oldestRejectedWithoutActionAt', tx, t, [], () => mine(state.runs, t).filter((x) => x['status'] === 'evaluated' && x['outcome'] === 'rejected' && !state.corrective.some((c) => c['qc_run_id'] === x['id']))
        .map((x) => x['evaluated_at'] as string).sort()[0]);
    },
  };

  const events = createQualityEvents(createEvents({ producer: 'quality' }) as never);
  const svc = createRunService({ repo, events });
  const identityCalls: unknown[] = [];
  const logs: unknown[] = [];
  const ctx = (over: Row = {}): any => ({
    tenantId: TENANT_A, actor: { type: 'system', id: SYSTEM }, requestId: REQ_ID, tx: db.tx, now: () => clock.iso, attempt: 1, maxAttempts: 5, jobId: '1',
    ports: { IdentityPort: { async getTenantSettings(_c: unknown, q: unknown) { identityCalls.push(q); return o.mode === null ? {} : { westgardMode: o.mode ?? 'classic', timezone: 'Asia/Kathmandu' }; } } },
    log: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), child() { return this; } },
    ...over,
  });

  /** One DB transaction over BOTH the event log and the fake quality tables: commit on resolve, full restore on reject / `rollback`. */
  async function transaction<T>(fn: () => Promise<T>, opts: { rollback?: boolean } = {}): Promise<T> {
    const snap = structuredClone(state);
    try { return await db.transaction(fn, opts); }
    catch (e) { Object.assign(state, snap); throw e; }
    finally { release(db.tx); }
  }
  /** What T-09 does per `assigned` draft: assembler.assign, then the observation insert (which makes the draft a member). */
  const place = (d: Row, c: any = ctx()) => transaction(async () => {
    const r = await svc.assign(c, structuredClone(d));
    state.observations.push({ ...structuredClone(d), qc_run_id: r.qc_run_id, status: 'assigned' });
    return r.qc_run_id as string;
  });
  const seedRun = (n: number, over: Row = {}): Row => {
    const r: Row = {
      id: RUN(n), tenant_id: TENANT_A, plan_id: PLN(1), plan_version_no: 3, instrument_id: INS(1), analyte_id: ANA(1), controls_per_run: 2, rule_mode: 'classic', mean_rule: '8x', run_at: at('08:00:00'),
      last_member_received_at: at('08:00:00'), last_assembled_at: at('08:00:05'), observation_count: 0, status: 'collecting', outcome: null, is_complete: null, rules_violated: [], warning_rules: [], rule_detail: [],
      evaluated_at: null, evaluated_by: null, last_in_control_run_at: null, hold_since: null, rejection_event_id: null, closed_at: null, closed_by: null, version: 1,
      created_at: at('08:00:05'), created_by: SYSTEM, updated_at: at('08:00:05'), updated_by: SYSTEM, ...over,
    };
    state.runs.push(r); return r;
  };
  const seedMember = (runId: string, n: number, level: 1 | 2 | 3, z: number, observedAt: string, over: Row = {}) => { state.observations.push({ ...draft(n, level, z, observedAt), qc_run_id: runId, ...over }); };
  /** A finished earlier run (outcome known) of the pair, for the hold_since / in-control vectors. */
  const seedPrior = (n: number, outcome: string, runAt: string, over: Row = {}) => seedRun(n, { status: 'evaluated', outcome, is_complete: outcome !== 'incomplete', run_at: runAt, evaluated_at: runAt, last_assembled_at: runAt,
    rules_violated: outcome === 'rejected' ? ['1-3s'] : [], hold_since: outcome === 'rejected' ? runAt : null, observation_count: 2, ...over });

  return {
    db, state, calls, repo, svc, ctx, transaction, place, seedRun, seedMember, seedPrior, identityCalls, logs, commit: release,
    at: (iso: string) => { clock.iso = iso; },
    run: (id: string) => state.runs.find((r) => r['id'] === id)!,
    runs: (t = TENANT_A) => state.runs.filter((r) => r['tenant_id'] === t),
    stored: () => db.events.filter((e) => e.eventType === 'quality.qc_run.rejected.v1'),
    callsOf: (op: string) => calls.filter((c) => c.op === op),
    clock,
  };
}
export type RunHarness = ReturnType<typeof makeRunHarness>;
