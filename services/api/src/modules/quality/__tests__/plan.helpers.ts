// C9 T-07 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute.
// Sibling convention: setup.helpers.ts (T-06), autoverify.helpers.ts (T-15).
//
//   ../repository/plan.repo.ts        exports `PlanRepo` (interface below) + `createPlanRepo(): PlanRepo` (SQL on the request tx, parameterised, explicit `tenant_id = $n` on EVERY statement,
//                                     schema-qualified quality.* — REQ-SEC-022/024/082). Column names = 05-SCHEMA §2 (qc_plans / qc_plan_versions) verbatim; timestamps ISO strings; RLS-invisible rows -> undefined.
//                                     qc_plan_versions is INSERT-only (no UPDATE grant, 05-SCHEMA §4/§5): the repo has insertVersion and NO method that updates or deletes a version row.
//   ../service/plan.service.ts        exports `createPlanService(deps?: { repo?: PlanRepo })` -> one async method per operationId #14-#19 `(ctx, input) => { status, body, version? }`:
//                                       listQcPlans{instrumentId?,analyteId?,status?,cursor?,limit?}   createQcPlan{body}   getQcPlan{planId}
//                                       createQcPlanVersion{planId,expectedVersion,body}   activateQcPlan{planId,expectedVersion,body}   deactivateQcPlan{planId,expectedVersion,body}
//                                     `body` = the SNAKE_CASE request body exactly as in quality.yaml; `version` = the plan row's `version` (the ETag). The service validates bodies itself
//                                     (defence in depth, REQ-SEC-080): 400 common.validation_failed, errors[] = [{ path: '/json/pointer', code: 'common.unknown_field'|'common.field_invalid'|'common.field_required' }];
//                                     pointers are relative to the REQUEST body ('/params/mean_rule', '/params/composition/1/count', '/change_reason', '/reason').
//                                     Order of every operation: assertRole (first, before any repo/port call) -> validate -> (If-Match present? 428) -> load via the tenant-scoped repo (404 when invisible)
//                                     -> version check (409) -> state/guard -> write. Reads: quality.qc_run.read; writes: quality.qc.manage (02-TRD §5.0).
//   catalog                           ctx.ports.CatalogPort.getTest(ctx, { testId }) once per distinct test_id per request (unknown test = LimsError('common.not_found') -> 400 '/test_id'; the analyte must be
//                                     one of test.analytes and resultType 'numeric' -> else 400 '/analyte_id'; any other port failure propagates, nothing written). DTO analyte_code / analyte_name /
//                                     unit_code / decimals come from the AnalyteDefinition (code, name, unitCode, decimals).
//                                     #15 warning: ctx.ports.CatalogPort.mapInstrumentCode(ctx, { instrumentId, direction: 'outbound', testId, analyteId }) BEFORE any write; LimsError('catalog.instrument_code_unmapped')
//                                     -> body.warnings = ['instrument_code_unmapped'] (201 still); success -> []; any OTHER error propagates (fail closed).
//   mapper                            QcPlanDto allowlist of 02-TRD §5.10 (no tenant_id / created_by / updated_* / is_active / unknown columns; no null on the wire; absent optional -> omitted);
//                                     params = the 9 QcPlanParams keys of the CURRENT version row; instrument_label = `${display_name} (${instrument_code})`; effective_from = current version's effective_from.
//   job enqueue                       #18 runs `ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', ['quality.reprocess_pending_observations', JSON.stringify({tenant_id, plan_id}), 'reproc:<plan_id>'])`
//                                     AFTER the update, in the same transaction (02-TRD §6.4: "after a plan is activated").
//   dto users                         created_by_display via repo.listUserLabels (same OPEN seam as T-15, .orchestra/cr/C9.T-15.md).
import { LimsError } from '../../../core/errors.js';
import { INS, INS_B, LVL, NOW, TENANT_A, TENANT_B, USER, idN, makeCtx, type Row } from './setup.helpers.js';
export { INS, INS_B, LVL, NOW, TENANT_A, TENANT_B, USER, MEM, REQ_ID, UUID7, idN, rejection, code, forbidden, readOnly, noRights, type Row } from './setup.helpers.js';

export const PLN = (n: number) => idN(0x8000 + n);
export const TST = (n: number) => idN(0x8100 + n);
export const ANA = (n: number) => idN(0x8200 + n);
export const OTHER_USER = idN(0xd9);
export const PLANTED = 'PLANTED-INTERNAL-7c1e';
export const OPS = ['listQcPlans', 'createQcPlan', 'getQcPlan', 'createQcPlanVersion', 'activateQcPlan', 'deactivateQcPlan'] as const;
export const DTO_KEYS = ['analyte_code', 'analyte_id', 'analyte_name', 'current_version_no', 'decimals', 'effective_from', 'id', 'instrument_id', 'instrument_label', 'params', 'rule_set_preview', 'status', 'test_id', 'unit_code', 'version'];
export const PARAM_KEYS = ['composition', 'controls_per_run', 'count_rules_across_materials', 'exclude_rejected_runs_from_history', 'hold_lookback_hours', 'mean_rule', 'qc_validity_hours', 'run_window_minutes', 'two_two_s_across_runs'];
export const AFTER = '2026-11-14T08:00:00.000Z';   // a later "now" for second writes

// ---------------------------------------------------------------------------------------------------- params
/** Valid QcPlanParams for N=2 {L1:1, L2:1}; `o` overrides top-level keys (use `undefined`-free spreads; delete keys in the test to remove them). */
export const params2 = (o: Row = {}): Row => ({ controls_per_run: 2, composition: [{ level_id: LVL(1), count: 1 }, { level_id: LVL(2), count: 1 }], ...o });
export const params3 = (o: Row = {}): Row => ({ controls_per_run: 3, composition: [{ level_id: LVL(1), count: 1 }, { level_id: LVL(2), count: 1 }, { level_id: LVL(3), count: 1 }], ...o });
export const params4 = (o: Row = {}): Row => ({ controls_per_run: 4, composition: [{ level_id: LVL(1), count: 2 }, { level_id: LVL(2), count: 2 }], ...o });
/** Complete params (every default spelled out) as the DTO returns them. */
export const FULL2: Row = { ...params2(), mean_rule: '10x', two_two_s_across_runs: true, count_rules_across_materials: true, exclude_rejected_runs_from_history: true, run_window_minutes: 30, qc_validity_hours: 24, hold_lookback_hours: 24 };
export const body = (o: Row = {}, p: Row = params2()): Row => ({ instrument_id: INS(1), test_id: TST(1), analyte_id: ANA(1), params: p, ...o });

// ---------------------------------------------------------------------------------------------------- fixtures (rows as the repo returns them)
const audit = { created_at: '2026-11-01T08:00:00.000Z', created_by: USER, updated_at: '2026-11-01T08:00:00.000Z', updated_by: USER, internal_note: PLANTED };
export const planRow = (n: number, o: Row = {}): Row => ({
  id: PLN(n), tenant_id: TENANT_A, instrument_id: INS(1), test_id: TST(1), analyte_id: ANA(n), status: 'inactive', current_version_no: 1, is_active: true, version: 1, ...audit, ...o,
});
export const versionRow = (planNo: number, versionNo: number, o: Row = {}): Row => ({
  id: idN(0x8400 + planNo * 16 + versionNo), tenant_id: TENANT_A, plan_id: PLN(planNo), version_no: versionNo, controls_per_run: 2,
  composition: [{ level_id: LVL(1), count: 1 }, { level_id: LVL(2), count: 1 }], mean_rule: '10x', two_two_s_across_runs: true, count_rules_across_materials: true,
  exclude_rejected_runs_from_history: true, run_window_minutes: 30, qc_validity_hours: 24, hold_lookback_hours: 24, effective_from: '2026-11-01T08:00:00.000Z', is_active: true, version: 1, ...audit, ...o,
});
/**
 * Tenant A: instrument I1 (INS(1)), I2 (INS(2)); levels LVL(1..3) of one material, LVL(4) of another; analytes K = ANA(1) (N=2), GLU = ANA(3), HGB = ANA(4).
 *   PLN(1) K on I1  : ACTIVE,   version 1 of 1 (N=2 {L1:1,L2:1})
 *   PLN(2) GLU on I1: INACTIVE, version 1 of 1 (N=2 {L1:1,L2:1}); targets exist for L1 only          -> activation guard fails
 *   PLN(3) HGB on I1: INACTIVE, version 1 of 1 (N=4 {L1:2,L2:2}); targets exist for L1 and L2        -> activation guard passes
 * Tenant B: instrument INS_B, level LVL(9), PLN(9) (K on INS_B, active).
 */
export function baseSeed(): PlanSeed {
  return {
    plans: [
      planRow(1, { status: 'active', analyte_id: ANA(1) }), planRow(2, { analyte_id: ANA(3) }), planRow(3, { analyte_id: ANA(4), test_id: TST(2) }),
      planRow(9, { tenant_id: TENANT_B, instrument_id: INS_B, status: 'active' }),
    ],
    versions: [
      versionRow(1, 1), versionRow(2, 1),
      versionRow(3, 1, { controls_per_run: 4, composition: [{ level_id: LVL(1), count: 2 }, { level_id: LVL(2), count: 2 }] }),
      versionRow(9, 1, { tenant_id: TENANT_B, composition: [{ level_id: LVL(9), count: 2 }] }),
    ],
    levels: [
      ...[1, 2, 3].map((n): Row => ({ id: LVL(n), tenant_id: TENANT_A, material_id: idN(0x3001), level_code: String(n), is_active: true })),
      { id: LVL(4), tenant_id: TENANT_A, material_id: idN(0x3002), level_code: '1', is_active: true }, { id: LVL(9), tenant_id: TENANT_B, material_id: idN(0x3009), level_code: '1', is_active: true },
    ],
    instruments: [
      { tenant_id: TENANT_A, id: INS(1), instrument_code: 'SIM-CHEM-1', display_name: 'Synthetic chemistry analyser' }, { tenant_id: TENANT_A, id: INS(2), instrument_code: 'SIM-CHEM-2', display_name: 'Second analyser' },
      { tenant_id: TENANT_B, id: INS_B, instrument_code: 'SIM-B', display_name: 'Tenant B analyser' },
    ],
    covered: [{ plan_id: PLN(2), level_id: LVL(1) }, { plan_id: PLN(3), level_id: LVL(1) }, { plan_id: PLN(3), level_id: LVL(2) }, { plan_id: PLN(1), level_id: LVL(1) }, { plan_id: PLN(1), level_id: LVL(2) }],
    users: [{ tenant_id: TENANT_A, user_id: USER, display_name: 'Synthetic Lab Manager' }, { tenant_id: TENANT_A, user_id: OTHER_USER, display_name: 'Synthetic Technologist' }],
  };
}

// ---------------------------------------------------------------------------------------------------- repo interface
export interface Page<T = Row> { rows: T[]; nextCursor?: string }
export interface PlanRepo {
  listPlans(tx: any, tenantId: string, q: { instrumentId?: string; analyteId?: string; status?: 'active' | 'inactive'; cursor?: string; limit: number }): Promise<Page>;
  findPlan(tx: any, tenantId: string, id: string): Promise<Row | undefined>;
  insertPlan(tx: any, tenantId: string, row: Row): Promise<Row>;      // duplicate (tenant_id, instrument_id, analyte_id) -> { code: '23505', constraint: 'qc_plans__tenant_instrument_analyte__uq' };
                                                                        // unknown instrument -> { code: '23503', constraint: 'qc_plans__instrument__fk' }
  updatePlan(tx: any, tenantId: string, id: string, expectedVersion: number, patch: Row): Promise<Row | undefined>;   // undefined = version mismatch (WHERE version = $n, version = version + 1)
  insertVersion(tx: any, tenantId: string, row: Row): Promise<Row>;   // INSERT only; the only write to qc_plan_versions
  listVersions(tx: any, tenantId: string, planId: string): Promise<Row[]>;                       // every version of ONE plan, version_no ascending
  listCurrentVersions(tx: any, tenantId: string, planIds: string[]): Promise<Row[]>;             // the version row whose version_no = plan.current_version_no, per plan
  findLevels(tx: any, tenantId: string, levelIds: string[]): Promise<Row[]>;                     // quality.control_levels rows visible to the tenant (unknown/foreign ids simply absent)
  coveredLevelIds(tx: any, tenantId: string, planId: string, levelIds: string[]): Promise<string[]>;   // of `levelIds`: those with a status='active' qc_target for plan `planId` on an is_active lot
  listInstrumentLabels(tx: any, tenantId: string, instrumentIds: string[]): Promise<Array<{ instrument_id: string; instrument_code: string; display_name: string }>>;
  listUserLabels(tx: any, tenantId: string, userIds: string[]): Promise<Array<{ user_id: string; display_name: string }>>;
}
export interface PlanSeed { plans?: Row[]; versions?: Row[]; levels?: Row[]; instruments?: Row[]; covered?: Array<{ plan_id: string; level_id: string }>; users?: Row[] }

const pgErr = (code: string, constraint: string) => Object.assign(new Error('pg error'), { code, constraint });

/** In-memory repo, tenant-aware like RLS + the explicit predicate; emulates qc_plans__tenant_instrument_analyte__uq, qc_plan_versions__plan_version__uq and the instrument FK. */
export function makePlanRepo(seed: PlanSeed = baseSeed()) {
  const plans = (seed.plans ?? []).map((r) => ({ ...r }));
  const versions = (seed.versions ?? []).map((r) => ({ ...r }));
  const levels = seed.levels ?? [], instruments = seed.instruments ?? [], users = seed.users ?? [], covered = seed.covered ?? [];
  const calls: Array<{ op: string; tenantId?: string; args: unknown[] }> = [];
  const rec = <T>(op: string, tenantId: string | undefined, args: unknown[], fn: () => T): T => { calls.push({ op, tenantId, args }); return fn(); };
  const mine = (xs: Row[], t: string) => xs.filter((x) => x['tenant_id'] === t);
  const stamp = (t: string, row: Row): Row => ({ is_active: true, version: 1, created_at: NOW, updated_at: NOW, ...row, tenant_id: t });
  const repo: PlanRepo = {
    async listPlans(_tx, t, q) {
      return rec('listPlans', t, [q], () => {
        const rows = mine(plans, t).filter((p) => (q.instrumentId === undefined || p['instrument_id'] === q.instrumentId) && (q.analyteId === undefined || p['analyte_id'] === q.analyteId) && (q.status === undefined || p['status'] === q.status));
        return { rows: structuredClone(rows) };
      });
    },
    async findPlan(_tx, t, id) { return rec('findPlan', t, [id], () => { const r = mine(plans, t).find((p) => p['id'] === id); return r ? structuredClone(r) : undefined; }); },
    async insertPlan(_tx, t, row) {
      return rec('insertPlan', t, [row], () => {
        if (!mine(instruments, t).some((i) => i['id'] === row['instrument_id'])) throw pgErr('23503', 'qc_plans__instrument__fk');
        if (mine(plans, t).some((p) => p['instrument_id'] === row['instrument_id'] && p['analyte_id'] === row['analyte_id'])) throw pgErr('23505', 'qc_plans__tenant_instrument_analyte__uq');
        const r = stamp(t, { status: 'inactive', current_version_no: 1, ...row }); plans.push(r); return structuredClone(r);
      });
    },
    async updatePlan(_tx, t, id, v, patch) {
      return rec('updatePlan', t, [id, v, patch], () => {
        const r = mine(plans, t).find((p) => p['id'] === id);
        if (!r || r['version'] !== v) return undefined;
        Object.assign(r, patch, { version: r['version'] + 1, updated_at: NOW }); return structuredClone(r);
      });
    },
    async insertVersion(_tx, t, row) {
      return rec('insertVersion', t, [row], () => {
        if (mine(versions, t).some((x) => x['plan_id'] === row['plan_id'] && x['version_no'] === row['version_no'])) throw pgErr('23505', 'qc_plan_versions__plan_version__uq');
        const r = stamp(t, row); versions.push(r); return structuredClone(r);
      });
    },
    async listVersions(_tx, t, planId) { return rec('listVersions', t, [planId], () => structuredClone(mine(versions, t).filter((x) => x['plan_id'] === planId).sort((a, b) => a['version_no'] - b['version_no']))); },
    async listCurrentVersions(_tx, t, planIds) {
      return rec('listCurrentVersions', t, [planIds], () => structuredClone(mine(versions, t).filter((x) => planIds.includes(x['plan_id']) && mine(plans, t).some((p) => p['id'] === x['plan_id'] && p['current_version_no'] === x['version_no']))));
    },
    async findLevels(_tx, t, ids) { return rec('findLevels', t, [ids], () => structuredClone(mine(levels, t).filter((l) => ids.includes(l['id'])))); },
    async coveredLevelIds(_tx, t, planId, ids) {
      return rec('coveredLevelIds', t, [planId, ids], () => (mine(plans, t).some((p) => p['id'] === planId) ? covered.filter((c) => c.plan_id === planId && ids.includes(c.level_id)).map((c) => c.level_id) : []));
    },
    async listInstrumentLabels(_tx, t, ids) {
      return rec('listInstrumentLabels', t, [ids], () => mine(instruments, t).filter((i) => ids.includes(i['id'])).map((i) => ({ instrument_id: i['id'], instrument_code: i['instrument_code'], display_name: i['display_name'] })));
    },
    async listUserLabels(_tx, t, ids) { return rec('listUserLabels', t, [ids], () => mine(users, t).filter((u) => ids.includes(u['user_id'])).map((u) => ({ user_id: u['user_id'], display_name: u['display_name'] }))); },
  };
  return {
    repo, plans, versions, calls,
    callsOf: (op: string) => calls.filter((c) => c.op === op),
    mutations: () => calls.filter((c) => /^(insert|update)/.test(c.op)),
    versionsOf: (planId: string) => versions.filter((v) => v['plan_id'] === planId),
  };
}
export type FakePlanRepo = ReturnType<typeof makePlanRepo>;

// ---------------------------------------------------------------------------------------------------- CatalogPort fake
/** TST(1): analytes K=ANA(1) numeric (mmol/L, 1 dp), GLU=ANA(3) numeric, ABO=ANA(5) ordinal. TST(2): HGB=ANA(4) numeric. Anything else (TST(9), tenant B's tests) -> common.not_found. */
export const CATALOG: Record<string, Row> = {
  [TST(1)]: { id: TST(1), code: 'BMP', name: 'Basic metabolic panel', analytes: [
    { id: ANA(1), code: 'K', name: 'Potassium', resultType: 'numeric', unitCode: 'mmol/L', decimals: 1 },
    { id: ANA(3), code: 'GLU', name: 'Glucose', resultType: 'numeric', unitCode: 'mmol/L', decimals: 2 },
    { id: ANA(5), code: 'ABO', name: 'Blood group', resultType: 'ordinal', decimals: 0 }] },
  [TST(2)]: { id: TST(2), code: 'HGB', name: 'Haemoglobin', analytes: [{ id: ANA(4), code: 'HGB', name: 'Haemoglobin', resultType: 'numeric', unitCode: 'g/dL', decimals: 1 }] },
};
export function makeCatalog(o: { unmapped?: boolean; mapFails?: Error; getTestFails?: Error } = {}) {
  const getTestCalls: Array<{ testId: string }> = [], mapCalls: Row[] = [];
  const port = {
    async getTest(_c: unknown, i: { testId: string }) {
      getTestCalls.push(i); if (o.getTestFails) throw o.getTestFails;
      const t = CATALOG[i.testId]; if (!t) throw new LimsError('common.not_found'); return structuredClone(t);
    },
    async mapInstrumentCode(_c: unknown, i: Row) {
      mapCalls.push(i); if (o.mapFails) throw o.mapFails; if (o.unmapped) throw new LimsError('catalog.instrument_code_unmapped');
      return { mappingId: idN(0x9001), instrumentId: i['instrumentId'], instrumentCode: 'K', analyteId: i['analyteId'], testId: i['testId'] };
    },
  };
  return { port, getTestCalls, mapCalls };
}

// ---------------------------------------------------------------------------------------------------- ctx
/** makeCtx (T-06) + CatalogPort. */
export function makePlanCtx(over: { tenantId?: string; roles?: (c: { permission: string }) => void; now?: string; enqueueFails?: boolean; catalog?: ReturnType<typeof makeCatalog> } = {}) {
  const base = makeCtx({ ...(over.tenantId ? { tenantId: over.tenantId } : {}), ...(over.roles ? { roles: over.roles } : {}), ...(over.now ? { now: over.now } : {}), ...(over.enqueueFails ? { enqueueFails: true } : {}) });
  const catalog = over.catalog ?? makeCatalog();
  base.ctx.ports.CatalogPort = catalog.port;
  return { ...base, catalog };
}
