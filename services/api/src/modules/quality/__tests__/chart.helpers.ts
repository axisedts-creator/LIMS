// C9 T-14 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute.
// Spec: 02-TRD §7.10 (LjChartDto + point status mapping + z view), §5.5 #35, §5.10, §12 LIMS_QUALITY_LJ_MAX_POINTS (2,000); PRD AC-08.1, AC-08.4 (AC-08.2/.3/.5 are UI, T-21);
//       07-SECURITY REQ-SEC-024/081/098/100 + S-16 (span > 400 d -> 400), AB-08.
//
//   ../repository/chart.repo.ts   exports `ChartRepo` (interface below) + `createChartRepo(): ChartRepo`. SQL on the caller's tx (`tx.query(text, values)`), parameterised, explicit `tenant_id = $n` on EVERY
//                                 statement, quality.* only (no lab.*, no instruments.*, no catalog.*), SELECT only, no locks. Timestamps leave as ISO text with ms (to_char ... 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
//                                 numerics (value, z, mean, sd) as decimal text (::text). RLS-invisible rows -> undefined / []. One statement per method (no N+1).
//   ../service/chart.service.ts   exports `createChartService(deps?: { repo?: ChartRepo; maxPoints?: number })` (maxPoints default = loadQualityConfig().ljMaxPoints = 2000) ->
//                                   getLeveyJenningsChart(ctx, { planId, view?, levelId?, lotId?, observedAtFrom, observedAtTo }): Promise<{ status: 200, body: LjChartDto }>   (camelCase input, snake_case DTO)
//                                 Order: ctx.ports.IdentityPort.assertRole(ctx, { permission: 'quality.qc_run.read' }) FIRST (before validation and any repo call) -> validate -> reads. Tenant/tx from ctx only.
//                                 Validation (400 common.validation_failed, before any repo call): planId uuid (required); view undefined|'level'|'z' (default 'level'); levelId uuid, REQUIRED when view = 'level',
//                                 optional and not used to narrow in view 'z'; lotId uuid optional; observedAtFrom/observedAtTo ISO-UTC instants (required); from <= to; span (to - from) <= 400 days (inclusive; 400 d + 1 ms rejected).
//                                 Reads (in this order; the last two are independent): findPlan -> (undefined => common.not_found, nothing else read) -> listChartObservations(limit = maxPoints + 1) ->
//                                   listRunsForChart(tx, t, DISTINCT qc_run_ids of the kept points) [skipped when none] and listTargetsForChart(tx, t, { planId, lotIds: DISTINCT lot ids of the kept points, from, to }) [skipped when no points]
//                                   plus ONE CatalogPort.getTest(ctx, { testId }) (analyte_code, unitCode -> unit_code (omitted when absent), decimals (absent => 0, as target.service)). Never one query per point or per series.
//                                 Series = one per (level_id, lot_id) that has >= 1 KEPT point, ordered by (level_code, lot_no); points ascending by (observed_at, observation_id); targets of that (level, lot) ascending
//                                 by (effective_from, target_id), only those the repo returned. Levels and lots are never merged (AC-08.1).
//                                 Truncation (§7.10): the cap is per chart (all series together). The repo returns the newest maxPoints+1 (observed_at DESC, id DESC); more than maxPoints => truncated = true and the NEWEST maxPoints stay.
//                                 Point: { observation_id, observed_at (ISO ms), value (as stored, text), z? (3 dp half-up; absent key when the observation has none), status, qc_run_id? (absent when none), rule_hits: string[] }.
//                                 Status (first match, §7.10): obs.status = 'excluded' -> excluded; obs.status <> 'assigned' -> unevaluated; run.status = 'collecting' -> collecting; run.outcome = 'rejected' AND the observation is listed in a
//                                 run.rule_detail entry -> rejected; |z| > 2 (exact 6 dp stored z, never the rounded wire z; exactly 2 is NOT beyond) -> warning; else accepted.
//                                 rule_hits = the DISTINCT `rule` of the run's rule_detail entries that list the observation (order of rule_detail); [] when the observation has no run or is not listed.
//                                 view 'z': same series/points/targets, the repo is called WITHOUT levelId (all levels of the plan). Any non-Lims failure -> common.internal (message without SQL); LimsErrors pass through.
//   ../handlers/chart.handlers.ts exports `chartHandlers` ({ getLeveyJenningsChart }) merged into handlers/index.ts behind the phase switch; maps query plan_id/view/level_id/lot_id/observed_at_from/observed_at_to
//                                 -> planId/view/levelId/lotId/observedAtFrom/observedAtTo; service built with createChartService().
import { createFakeCatalogPort } from '../../../../../../packages/fakes/src/CatalogPort.fake.js';
import { makeCtx, LVL, LOT, type Row } from './setup.helpers.js';
import { ANA, PLN } from './plan.helpers.js';
import { INS, RUN, TENANT_A, TENANT_B, idN } from './run.helpers.js';
export { ANA, PLN, INS, RUN, LVL, LOT, TENANT_A, TENANT_B, idN, type Row };
export { rejection, code, forbidden, readOnly, noRights } from './setup.helpers.js';

export const TST = (n: number) => idN(0x8300 + n);
export const OBS = (n: number) => idN(0xb000 + n);
export const TGT = (n: number) => idN(0xb800 + n);
export const PLANTED = 'PLANTED-INTERNAL-7c1e';
export const DAY_MS = 86_400_000;
export const FROM = '2026-10-01T00:00:00.000Z';
export const TO = '2026-11-01T00:00:00.000Z';
export const NOW = '2026-11-13T19:00:00.000Z';
export const T = (hms: string, day = '2026-10-10') => `${day}T${hms}.000Z`;

export const PLAN_KEYS = ['analyte_code', 'analyte_id', 'decimals', 'id', 'instrument_id', 'unit_code'];
export const BODY_KEYS = ['plan', 'series', 'truncated', 'view'];
export const SERIES_KEYS = ['level_code', 'level_id', 'lot_id', 'lot_no', 'points', 'targets'];
export const POINT_KEYS = ['observation_id', 'observed_at', 'qc_run_id', 'rule_hits', 'status', 'value', 'z'];
export const TARGET_KEYS = ['effective_from', 'effective_to', 'mean', 'sd', 'source', 'target_id'];
export const STATUSES = ['accepted', 'warning', 'rejected', 'excluded', 'unevaluated', 'collecting'];

export interface ChartRepo {
  findPlan(tx: any, t: string, planId: string): Promise<{ plan_id: string; instrument_id: string; analyte_id: string; test_id: string } | undefined>;   // any plan status
  /** newest first (observed_at DESC, id DESC), at most `limit` rows; plan_id = planId AND level_id/lot_id/value NOT NULL AND observed_at in [from, to] (both inclusive) AND optional level/lot. */
  listChartObservations(tx: any, t: string, q: { planId: string; levelId?: string; lotId?: string; from: string; to: string; limit: number }): Promise<ObsRow[]>;
  listRunsForChart(tx: any, t: string, runIds: string[]): Promise<RunRow[]>;
  /** status active|superseded|retired of the plan, lot in lotIds, overlapping [from, to]: effective_from <= to AND (effective_to IS NULL OR effective_to > from). */
  listTargetsForChart(tx: any, t: string, q: { planId: string; lotIds: string[]; from: string; to: string }): Promise<TargetRow[]>;
}
export interface ObsRow { id: string; level_id: string; level_code: string; lot_id: string; lot_no: string; observed_at: string; value: string; z: string | null; status: string; qc_run_id: string | null }
export interface RunRow { id: string; status: string; outcome: string | null; rule_detail: Array<{ rule: string; observation_ids: string[] }> }
export interface TargetRow { id: string; level_id: string; lot_id: string; mean: string; sd: string; source: 'manufacturer' | 'established'; effective_from: string; effective_to: string | null }

export interface PlanSeed { id: string; tenant_id: string; instrument_id: string; analyte_id: string; test_id: string }
export interface ObsSeed extends ObsRow { tenant_id: string; plan_id: string; [extra: string]: unknown }
export interface RunSeed extends RunRow { tenant_id: string }
export interface TargetSeed extends TargetRow { tenant_id: string; plan_id: string; status: string }
export interface ChartSeed { plans?: PlanSeed[]; observations?: ObsSeed[]; runs?: RunSeed[]; targets?: TargetSeed[] }

export const plan = (n = 1, o: Partial<PlanSeed> = {}): PlanSeed => ({ id: PLN(n), tenant_id: TENANT_A, instrument_id: INS(n), analyte_id: ANA(n), test_id: TST(n), ...o });
/** An assigned observation of PLN(1), level L<level> / lot LOT-SYN-<lot>, with the planted internal columns a repo must never leak through the service. */
export const obs = (n: number, at: string, value: string, z: string | null, o: Partial<ObsSeed> = {}): ObsSeed => ({
  id: OBS(n), tenant_id: TENANT_A, plan_id: PLN(1), level_id: LVL(1), level_code: 'L1', lot_id: LOT(1), lot_no: 'LOT-SYN-1', observed_at: at, value, z, status: 'assigned', qc_run_id: RUN(1),
  internal_note: PLANTED, created_by: PLANTED, excluded_comment: PLANTED, ...o,
});
export const run = (n: number, outcome: string | null, o: Partial<RunSeed> = {}): RunSeed =>
  ({ id: RUN(n), tenant_id: TENANT_A, status: outcome === null ? 'collecting' : 'evaluated', outcome, rule_detail: [], ...o });
export const target = (n: number, from: string, o: Partial<TargetSeed> = {}): TargetSeed =>
  ({ id: TGT(n), tenant_id: TENANT_A, plan_id: PLN(1), level_id: LVL(1), lot_id: LOT(1), mean: '100.000000', sd: '2.000000', source: 'manufacturer', status: 'active', effective_from: from, effective_to: null, ...o });

/** Level 1 / lot 1 and level 2 / lot 2 of PLN(1): the minimal two-level plan (AC-08.4). */
export const L2 = { level_id: LVL(2), level_code: 'L2', lot_id: LOT(2), lot_no: 'LOT-SYN-2' };

export function baseSeed(): ChartSeed {
  return {
    plans: [plan(1), plan(9, { tenant_id: TENANT_B, id: PLN(9), instrument_id: INS(9), analyte_id: ANA(9), test_id: TST(9) })],
    observations: [
      obs(1, T('08:00:00'), '100.4', '0.200000', { qc_run_id: RUN(1) }),
      obs(2, T('09:00:00'), '103.0', '1.500000', { qc_run_id: RUN(2) }),
      obs(3, T('10:00:00'), '106.4', '3.200000', { qc_run_id: RUN(3) }),
    ],
    runs: [run(1, 'accepted'), run(2, 'accepted'), run(3, 'rejected', { rule_detail: [{ rule: '1-3s', observation_ids: [OBS(3)] }] })],
    targets: [target(1, '2026-09-01T00:00:00.000Z')],
  };
}

/** In-memory ChartRepo: tenant-aware (RLS + the explicit predicate), applies the filters/order/limit of the interface. `calls` records every call (op, tenant, tx, args). */
export function makeChartRepo(seed: ChartSeed = baseSeed()) {
  const s = { plans: [...(seed.plans ?? [])], observations: (seed.observations ?? []).map((x) => ({ ...x })), runs: (seed.runs ?? []).map((x) => ({ ...x })), targets: (seed.targets ?? []).map((x) => ({ ...x })) };
  const calls: Array<{ op: string; tenantId?: string; tx: unknown; args: any[] }> = [];
  const rec = <R>(op: string, tx: unknown, t: string | undefined, args: unknown[], fn: () => R): R => { calls.push({ op, tenantId: t, tx, args }); return fn(); };
  const ms = (v: string) => Date.parse(v);
  const repo: ChartRepo = {
    async findPlan(tx, t, planId) {
      return rec('findPlan', tx, t, [planId], () => {
        const p = s.plans.find((x) => x.tenant_id === t && x.id === planId);
        return p ? { plan_id: p.id, instrument_id: p.instrument_id, analyte_id: p.analyte_id, test_id: p.test_id } : undefined;
      });
    },
    async listChartObservations(tx, t, q) {
      return rec('listChartObservations', tx, t, [q], () => s.observations
        .filter((o) => o.tenant_id === t && o.plan_id === q.planId && (q.levelId === undefined || o.level_id === q.levelId) && (q.lotId === undefined || o.lot_id === q.lotId)
          && ms(o.observed_at) >= ms(q.from) && ms(o.observed_at) <= ms(q.to))
        .sort((a, b) => ms(b.observed_at) - ms(a.observed_at) || (a.id < b.id ? 1 : -1)).slice(0, q.limit)
        .map((o) => ({ ...o })));   // the planted extras ride along on purpose: the service must allowlist
    },
    async listRunsForChart(tx, t, runIds) {
      return rec('listRunsForChart', tx, t, [runIds], () => s.runs.filter((r) => r.tenant_id === t && runIds.includes(r.id)).map((r) => ({ ...r, rule_detail: r.rule_detail.map((d) => ({ rule: d.rule, observation_ids: [...d.observation_ids] })) })));
    },
    async listTargetsForChart(tx, t, q) {
      return rec('listTargetsForChart', tx, t, [q], () => s.targets
        .filter((x) => x.tenant_id === t && x.plan_id === q.planId && q.lotIds.includes(x.lot_id) && ['active', 'superseded', 'retired'].includes(x.status)
          && ms(x.effective_from) <= ms(q.to) && (x.effective_to === null || ms(x.effective_to) > ms(q.from)))
        .map((x) => ({ ...x })));
    },
  };
  return { repo, calls, state: s, ops: () => calls.map((c) => c.op) };
}
export type FakeChartRepo = ReturnType<typeof makeChartRepo>;

/** Real @lims/fakes CatalogPort: test TST(n) carries the analyte ANA(n) with code `GLU<n>`, unitCode and decimals (set to undefined to drop them). */
export function makeChartCatalog(o: { unitCode?: string | undefined; decimals?: number | undefined; plans?: PlanSeed[]; missingAnalyte?: boolean } = {}) {
  const unitCode = 'unitCode' in o ? o.unitCode : 'mg_dl';
  const decimals = 'decimals' in o ? o.decimals : 1;
  const tests = (o.plans ?? [plan(1)]).map((p) => ({
    id: p.test_id, tenantId: p.tenant_id, code: `T${p.test_id.slice(-4)}`, name: 'Synthetic test', departmentId: idN(1), departmentCode: 'BIO', specimenTypeCodes: ['blood'], containerCode: 'edta', workflowType: 'standard',
    analytes: o.missingAnalyte ? [] : [{ id: p.analyte_id, code: `GLU${p.analyte_id.slice(-1)}`, name: 'Synthetic analyte', resultType: 'numeric', reportable: true, sortOrder: 1, ...(unitCode ? { unitCode } : {}), ...(decimals === undefined ? {} : { decimals }) }],
    isActive: true, revision: 1,
  }));
  return createFakeCatalogPort({ seed: 7, fixtures: { tests } as any });
}

export function makeChartCtx(over: { tenantId?: string; roles?: (c: { permission: string }) => void; now?: string; catalog?: ReturnType<typeof makeChartCatalog> } = {}) {
  const base = makeCtx({ ...(over.tenantId ? { tenantId: over.tenantId } : {}), ...(over.roles ? { roles: over.roles } : {}), now: over.now ?? NOW });
  const catalog = over.catalog ?? makeChartCatalog({ plans: [plan(1), plan(9, { tenant_id: TENANT_B, id: PLN(9), instrument_id: INS(9), analyte_id: ANA(9), test_id: TST(9) })] });
  base.ctx.ports.CatalogPort = catalog;
  return { ...base, catalog };
}
