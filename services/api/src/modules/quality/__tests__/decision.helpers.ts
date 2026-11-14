// C9 T-16 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute.
// Spec: 02-TRD §8.4 (algorithm), §8.5 (vectors A1-A16), §11.1 (port), §14 (metrics); 03-IC §4.11; 05-SCHEMA autoverify_decisions; PRD AC-11.1, AC-13.1-13.6; 07-SECURITY (QualityPort row, S-17).
//
//   ../domain/autoverify-eval.ts     exports  compileRuleSet(definition): CompiledRuleSet            (pure; TRD §8.2 maps `analyte|instrument` and `analyte|*`; never mutates its input)
//                                             evaluateWith(rs: CompiledRuleSet, rc: ResultContext, qc?: { status, currentRunId? }): { decision, reasons, matchedRuleKey? }
//                                               (pure; TRD §8.4 evaluateWith(V) steps 1-8; `qc` is only read when rc.instrumentId is present; reasons in canonical order, no duplicates)
//   ../repository/decision.repo.ts   exports  DecisionRepo { insertDecision(tx, tenantId, row): Promise<void> } + createDecisionRepo(): DecisionRepo
//                                             (append-only INSERT into quality.autoverify_decisions on the caller's tx; parameterised; explicit tenant_id; no UPDATE/DELETE anywhere)
//                                             `row` = { id, decided_at, mode, version_id, result_id, analyte_id, instrument_id|null, decision, reasons, matched_rule_key|null, qc_status, qc_run_id|null,
//                                                       inputs: { value_numeric?, range_flag?, delta_check_failed, is_critical, instrument_flags, resulted_at }, created_by }   (05-SCHEMA column names)
//   ../service/decision.service.ts   exports  createDecisionService(deps?: { autoverifyRepo?: AutoverifyRepo, decisionRepo?: DecisionRepo, status?: { qcStatusFor }, ruleCacheMax?: number })
//                                               -> canAutoVerify(ctx, rc): Promise<{ decision, reasons, ruleSetVersion? }>
//                                             reads: IdentityPort.getTenantSettings(ctx, { keys: ['autoVerificationEnabled'] }); AutoverifyRepo.findRuleSet (pointers; once per call) + findVersion (definition; compiled
//                                             rules cached per (tenant, version id), LRU bounded by ruleCacheMax, default loadQualityConfig().ruleCacheMax); status.qcStatusFor({instrumentId, analyteId, at: rc.resultedAt}) at most ONCE per call
//                                             (shared by live and shadow). Never opens a transaction, never calls assertRole (the calling path authorised itself), tenant from ctx only, clock = ctx.now(), row ids uuidv7.
//   ../ports/QualityPort.impl.ts     exports  createQualityPort({ status?, decision? }) — decision defaults to createDecisionService({ status }) (the SAME status service); qualityPort = createQualityPort().
//
// ctx.metrics is optional (`inc(name, labels?, by?)`, `set`, `observe`): missing = no crash. ctx.db is absent on purpose (a service that tries to open its own transaction fails).
import { LimsError } from '../../../core/errors.js';
import { ANALYTE, INSTR, TEST, VER, def, rule, setRow, verRow, makeRepo, idN, TENANT_A, TENANT_B, USER, MEM, REQ_ID, type Row, type FakeRepo } from './autoverify.helpers.js';
export { ANALYTE, INSTR, TEST, VER, def, rule, setRow, verRow, makeRepo, idN, TENANT_A, TENANT_B, USER, MEM, REQ_ID, type Row, type FakeRepo };
export { rejection, code } from './setup.helpers.js';

export const NOW = '2026-11-05T04:20:00.000Z';
export const RESULTED_AT = '2026-11-05T04:15:00.000Z';
export const RESULT = idN(0x9201);
export const RUN = (n: number) => idN(0xa900 + n);
export const SEC = 'SENTINEL-PHI-Sita-Karki-7731';
export const PLANTED = 'PLANTED-INTERNAL-7c1e';
export const REASONS = ['manual_origin', 'rule_missing', 'critical', 'delta_failure', 'instrument_flag', 'outside_autoverify_limits', 'qc_out_of_control', 'qc_warning', 'qc_no_data'] as const;   // canonical order, TRD §8.4
export const K = ANALYTE(1), OTHER_ANALYTE = ANALYTE(2), I1 = INSTR(1), I2 = INSTR(2);
export const V3 = VER(3), V4 = VER(4);

/** §8.5 fixture: active V3 = K_ANY (any instrument, 3.5-5.1, flags [N]) + K_I2_OFF (instrument I2, enabled false). Simulating V4 = K_ANY limits 3.0-6.0. */
export const kAny = (o: Row = {}): Row => rule(1, { key: 'K_ANY', test_id: TEST(1), analyte_id: K, limits: { low: '3.5', high: '5.1' }, allowed_range_flags: ['N'], ...o });
export const kI2Off = (): Row => rule(1, { key: 'K_I2_OFF', test_id: TEST(1), analyte_id: K, instrument_id: I2, enabled: false });
export const DEF_V3 = def(kAny(), kI2Off());
export const DEF_V4 = def(kAny({ limits: { low: '3.0', high: '6.0' } }));

export interface ScenarioOpts { active?: Row | null; simulating?: Row | null; tenant?: string; extra?: Row[] }
/** Tenant A rule set with the given active / simulating definitions (null = no such version). Default: V3 active, no simulating version. */
export function scenario(o: ScenarioOpts = {}): FakeRepo {
  const tenant = o.tenant ?? TENANT_A;
  const active = o.active === undefined ? DEF_V3 : o.active, simulating = o.simulating ?? null;
  const versions: Row[] = [];
  if (active) versions.push(verRow(3, 'active', { tenant_id: tenant, definition: active, rule_count: (active['rules'] as unknown[]).length }));
  if (simulating) versions.push(verRow(4, 'simulating', { tenant_id: tenant, definition: simulating, rule_count: (simulating['rules'] as unknown[]).length, simulation_started_at: '2026-11-01T00:00:00.000Z' }));
  versions.push(...(o.extra ?? []));
  return makeRepo({ sets: [setRow({ tenant_id: tenant, active_version_id: active ? V3 : null, simulating_version_id: simulating ? V4 : null })], versions, users: [] });
}

/** ResultContext of the §8.5 base: instrument I1, analyte K, value "4.2", rangeFlag N, no flags, no delta, not critical. */
export const rc = (o: Row = {}): any => ({
  resultId: RESULT, analyteId: K, instrumentId: I1, valueNumeric: '4.2', instrumentFlags: [] as string[], rangeFlag: 'N', deltaCheckFailed: false, isCritical: false, resultedAt: RESULTED_AT, ...o,
});
export const without = (o: Row, ...keys: string[]): any => { const c = { ...o }; for (const k of keys) delete c[k]; return c; };

// ---------------------------------------------------------------------------------------------------- decision repo fake (append-only, tx-bound, emulates the CHECK constraints of 05-SCHEMA)
const pgErr = (code: string, constraint: string) => Object.assign(new Error(`pg error ${constraint}`), { code, constraint });
export function makeDecisionRepo() {
  const rows: Array<{ tx: unknown; tenantId: string; row: Row; rolledBack: boolean }> = [];
  const calls: Array<{ tenantId: string; tx: unknown; row: Row }> = [];
  let failWith: Error | undefined;
  const repo = {
    async insertDecision(tx: any, tenantId: string, row: Row): Promise<void> {
      calls.push({ tenantId, tx, row: structuredClone(row) });
      if (failWith) throw failWith;
      if (!['live', 'shadow'].includes(row['mode'])) throw pgErr('23514', 'autoverify_decisions__mode__ck');
      if (!['allow', 'deny'].includes(row['decision'])) throw pgErr('23514', 'autoverify_decisions__decision__ck');
      if (row['decision'] === 'allow' && (row['reasons'] ?? []).length) throw pgErr('23514', 'autoverify_decisions__allow__ck');
      if (!(row['reasons'] ?? []).every((r: string) => [...REASONS, 'feature_disabled'].includes(r))) throw pgErr('23514', 'autoverify_decisions__reasons__ck');
      if (!['in_control', 'warning', 'out_of_control', 'no_qc_data', 'not_evaluated'].includes(row['qc_status'])) throw pgErr('23514', 'autoverify_decisions__qc__ck');
      if (typeof row['inputs'] !== 'object' || row['inputs'] === null || Array.isArray(row['inputs'])) throw pgErr('23514', 'autoverify_decisions__inputs__ck');
      if (rows.some((r) => r.row['id'] === row['id'])) throw pgErr('23505', 'autoverify_decisions__pk');
      rows.push({ tx, tenantId, row: structuredClone(row), rolledBack: false });
    },
  };
  return {
    repo, calls,
    /** rows that survive (their transaction was not rolled back) */
    rows: (mode?: 'live' | 'shadow') => rows.filter((r) => !r.rolledBack && (!mode || r.row['mode'] === mode)).map((r) => ({ ...r.row, tenant_id: r.tenantId })),
    inTx: (tx: unknown) => rows.filter((r) => r.tx === tx).map((r) => r.row),
    rollback(tx: unknown) { for (const r of rows) if (r.tx === tx) r.rolledBack = true; },
    failNext(e: Error) { failWith = e; },
  };
}
export type FakeDecisionRepo = ReturnType<typeof makeDecisionRepo>;

// ---------------------------------------------------------------------------------------------------- qc status fake (the port's qcStatusFor)
export type QcResult = { status: 'in_control' | 'warning' | 'out_of_control' | 'no_qc_data'; lastInControlRunAt?: string; currentRunId?: string; violatedRules?: string[] };
export const QC = {
  in_control: { status: 'in_control', lastInControlRunAt: '2026-11-05T02:00:00.000Z', currentRunId: RUN(1) } as QcResult,
  warning: { status: 'warning', lastInControlRunAt: '2026-11-05T02:00:00.000Z', currentRunId: RUN(2), violatedRules: ['1-2s'] } as QcResult,
  out_of_control: { status: 'out_of_control', currentRunId: RUN(3), violatedRules: ['1-3s'] } as QcResult,
  no_qc_data: { status: 'no_qc_data' } as QcResult,
};
export function makeStatus(result: QcResult | ((input: any) => QcResult | Promise<QcResult>) = QC.in_control) {
  const calls: Array<{ ctx: unknown; input: any }> = [];
  return { calls, qcStatusFor: async (ctx: unknown, input: any): Promise<QcResult> => { calls.push({ ctx, input }); return typeof result === 'function' ? result(input) : structuredClone(result); } };
}

// ---------------------------------------------------------------------------------------------------- ctx
export function makeCtx(over: { tenantId?: string; enabled?: boolean; now?: string; metrics?: boolean; settingsFail?: Error; actorId?: string } = {}) {
  const tenantId = over.tenantId ?? TENANT_A;
  const queries: Array<{ text: string; values: unknown[] }> = [], settingsCalls: unknown[] = [], assertCalls: unknown[] = [], incs: Array<{ name: string; labels: Record<string, string>; by: number }> = [], logs: unknown[] = [];
  const tx = { async query(text: string, values: unknown[] = []) {
    queries.push({ text, values });
    if (/^\s*(BEGIN|START TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(text)) throw new Error('the service must not control the caller transaction');
    return { rows: [] };
  } };
  const ctx: any = {
    tenantId, actor: { type: 'user', id: over.actorId ?? USER, membershipId: MEM }, requestId: REQ_ID, now: () => over.now ?? NOW, tx,
    ports: { IdentityPort: {
      getTenantSettings: async (_c: unknown, i: unknown) => { settingsCalls.push(i); if (over.settingsFail) throw over.settingsFail; return { autoVerificationEnabled: over.enabled ?? true }; },
      assertRole: async (...a: unknown[]) => { assertCalls.push(a); throw new LimsError('auth.forbidden'); },
    } },
    log: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), debug: (...a: unknown[]) => logs.push(a), child() { return this; } },
  };
  if (over.metrics !== false) ctx.metrics = { inc: (name: string, labels: Record<string, string> = {}, by = 1) => { incs.push({ name, labels, by }); }, set() {}, observe() {} };
  const metric = (name: string) => incs.filter((m) => m.name === name);
  return { ctx, tx, queries, settingsCalls, assertCalls, incs, logs, metric };
}
export const DECISIONS_TOTAL = 'lims_quality_autoverify_decisions_total';
export const SHORT_CIRCUIT = 'lims_quality_autoverify_short_circuit_total';
