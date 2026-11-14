// C9 T-13 test helpers (not a test file). Synthetic data only. SEAMS the spec leaves open — the writer must match them or raise a dispute.
// Spec: 02-TRD §7.8 (qcStatusFor, S1-S8), §5.5 #34 + §5.10 QcStatusRowDto, §11.1 (port, contract cases 8/9/12), §10.2 (qc_activity), §14 (gauge lims_quality_qc_overdue_pairs);
//       03-IC §4.11; PRD AC-09.1-09.5; 07-SECURITY REQ-SEC-024/098 (tenant from ctx only, no PHI).
//
//   ../repository/status.repo.ts   exports `StatusRepo` (interface below) + `createStatusRepo(): StatusRepo`. SQL on the caller's tx (`tx.query(text, values)`), parameterised, explicit `tenant_id = $n` on EVERY
//                                  statement, quality.* (+ instruments.v_pub_instrument_directory for labels) only, SELECT only. Timestamps leave as ISO text with ms ('...sssZ'). RLS-invisible rows -> undefined / [].
//   ../service/status.service.ts   exports `createStatusService(deps?: { repo?: StatusRepo })` ->
//                                    qcStatusFor(ctx, { instrumentId, analyteId, at }): Promise<{ status, lastInControlRunAt?, currentRunId?, violatedRules? }>   (the PORT result: ISO strings, absent keys, no undefined values)
//                                      NO permission check (03-IC §4.11: the calling path authorised itself); tenant from ctx.tenantId only; read-only; runs on ctx.tx, never opens a transaction; reads no quality.settings.
//                                      Steps: repo.findPlanForPair (undefined -> no_qc_data, runs not read) -> repo.listRunsForStatus(tx, t, [planId], at) -> domain `qcStatus` (T-05). At most TWO repo calls.
//                                      Bad input (not uuid / `at` not an ISO-UTC instant) -> LimsError 'common.validation_failed' BEFORE any repo call. Any non-Lims repo failure -> LimsError 'common.internal' (message without SQL).
//                                    getQcStatusBoard(ctx, { instrumentId?, status? (csv string as on the wire), overdueOnly?, cursor?, limit? }): Promise<{ status: 200, body }>.
//                                      assertRole('quality.qc_run.read') FIRST (before any repo call), then validate. at = ctx.now(). The board covers ACTIVE plans of the tenant, ordered by (instrument_id, analyte_code, plan_id): the repo orders by SQL (instrument_id, analyte_id, plan_id); the service applies the final order AFTER enrichment —
//                                      analyte_code comes from ctx.ports.CatalogPort.getTest (one call per DISTINCT test_id; code of the analyte whose id = analyte_id; 02-TRD:277,778). T-13 ruling.
//                                      filters and pagination are applied in memory after status is computed. Repo calls: listBoardPlans, listRunsForStatus (ALL plan ids in ONE call), listActivity (one call), listInstrumentLabels (one call).
//                                      Sets the gauge `ctx.metrics.set('lims_quality_qc_overdue_pairs', n, { tenant_id })` (missing ctx.metrics is fine) where n = overdue rows of the WHOLE tenant (not filtered, not paged).
//                                      Invalid cursor -> 'common.invalid_cursor'. Default limit 50, max 200 (_common.yaml Limit).
//   ../ports/QualityPort.impl.ts   exports `qualityPort` (unchanged name: manifest.ports.QualityPort) and `createQualityPort(deps?: { status?: { qcStatusFor } })`; qualityPort.qcStatusFor delegates to the status service.
//                                  canAutoVerify stays the T-01 stub until T-16.
//   ../handlers/status.handlers.ts exports `statusHandlers` ({ getQcStatusBoard }) merged into handlers/index.ts behind the phase switch; service built with createStatusService().
//   Overdue (AC-09.5): qc_overdue = activity.patient_results_since_last_qc > 0 AND (activity.last_qc_run_at is null OR now - last_qc_run_at > qc_validity_hours, strict). No activity row = not overdue, count 0.
//   Clock: ctx.now() for the board; `at` for the port. No `new Date()` in decisions.
import { LimsError } from '../../../core/errors.js';
import { makeCtx, type Row } from './setup.helpers.js';
import { createFakeCatalogPort } from '../../../../../../packages/fakes/src/CatalogPort.fake.js';
import { ANA, PLN } from './plan.helpers.js';
import { INS, RUN, TENANT_A, TENANT_B, at, idN } from './run.helpers.js';
export const TST = (n: number) => idN(0x8300 + n);
export { ANA, PLN, INS, RUN, TENANT_A, TENANT_B, at, idN, type Row };
export { rejection, code, forbidden, readOnly, noRights, UUID7 } from './setup.helpers.js';

export const DAY = '2026-11-05';
export const T = (hms: string, day = DAY) => `${day}T${hms}.000Z`;
export const HOUR = 3_600_000;
export const BOARD_KEYS = ['analyte_code', 'analyte_id', 'current_run_id', 'instrument_id', 'instrument_label', 'last_in_control_run_at', 'last_patient_result_at', 'open_rejected_run_ids', 'patient_results_since_last_qc',
  'plan_id', 'qc_overdue', 'status', 'violated_rules'];
export const BOARD_REQUIRED = ['analyte_code', 'analyte_id', 'instrument_id', 'open_rejected_run_ids', 'patient_results_since_last_qc', 'plan_id', 'qc_overdue', 'status', 'violated_rules'];
export const PLANTED = 'PLANTED-INTERNAL-7c1e';

export interface StatusRepo {
  findPlanForPair(tx: any, t: string, instrumentId: string, analyteId: string): Promise<{ plan_id: string; qc_validity_hours: number } | undefined>;   // any plan status; qc_validity_hours of the plan's CURRENT version
  /** Per plan id: the latest 20 runs with status evaluated|closed and run_at <= at (run_at DESC), UNION every open rejected run (outcome rejected, status evaluated|closed, run_at <= at, closed_at is null OR > at) even when older than the 20th. */
  listRunsForStatus(tx: any, t: string, planIds: string[], at: string): Promise<Array<{ plan_id: string; id: string; status: string; outcome: string | null; run_at: string; closed_at: string | null; rules_violated: string[] }>>;
  listBoardPlans(tx: any, t: string): Promise<Array<{ plan_id: string; instrument_id: string; analyte_id: string; test_id: string; qc_validity_hours: number }>>;   // status 'active' only; SQL order (instrument_id, analyte_id, plan_id); NO analyte code in SQL (T-13 ruling)
  listActivity(tx: any, t: string, planIds: string[]): Promise<Array<{ plan_id: string; last_patient_result_at: string | null; patient_results_since_last_qc: number; last_qc_run_at: string | null }>>;
  listInstrumentLabels(tx: any, t: string, instrumentIds: string[]): Promise<Array<{ instrument_id: string; instrument_code: string; display_name: string }>>;
}

export interface PlanSeed { id: string; tenant_id: string; instrument_id: string; analyte_id: string; test_id?: string; analyte_code?: string; status?: 'active' | 'inactive'; qc_validity_hours?: number }
export interface RunSeed { id: string; tenant_id: string; plan_id: string; status?: string; outcome: string | null; run_at: string; closed_at?: string | null; rules_violated?: string[] }
export interface ActivitySeed { tenant_id: string; plan_id: string; last_patient_result_at?: string | null; patient_results_since_last_qc?: number; last_qc_run_at?: string | null }
export interface StatusSeed { plans?: PlanSeed[]; runs?: RunSeed[]; activity?: ActivitySeed[]; instruments?: Array<{ tenant_id: string; instrument_id: string; instrument_code: string; display_name: string }> }

export const plan = (n: number, o: Partial<PlanSeed> = {}): PlanSeed => ({ id: PLN(n), tenant_id: TENANT_A, instrument_id: INS(n), analyte_id: ANA(n), test_id: TST(n), analyte_code: `AN${n}`, status: 'active', qc_validity_hours: 24, ...o });
export const run = (n: number, planId: string, outcome: string | null, runAt: string, o: Partial<RunSeed> = {}): RunSeed =>
  ({ id: RUN(n), tenant_id: TENANT_A, plan_id: planId, status: 'evaluated', outcome, run_at: runAt, closed_at: null, rules_violated: [], ...o });

/** §7.8 timeline for the pair PLN(1) = I1 x K, validity 24 h, 2026-11-05: R1 01:00 accepted; R2 06:00 accepted_warning; R3 09:00 rejected (1-3s) closed 10:30; R4 10:00 accepted; R5 14:00 incomplete. */
export function timelineSeed(): StatusSeed {
  const p = PLN(1);
  return {
    plans: [plan(1)],
    runs: [
      run(1, p, 'accepted', T('01:00:00')),
      run(2, p, 'accepted_warning', T('06:00:00'), { rules_violated: [] }),
      run(3, p, 'rejected', T('09:00:00'), { status: 'closed', closed_at: T('10:30:00'), rules_violated: ['1-3s'] }),
      run(4, p, 'accepted', T('10:00:00')),
      run(5, p, 'incomplete', T('14:00:00'), { rules_violated: [] }),
    ],
  };
}

/** In-memory StatusRepo: tenant-aware (RLS + the explicit predicate), applies the 20-latest + open-rejected rule of the interface. `calls` records every call (op, tenant, tx, args). */
export function makeStatusRepo(seed: StatusSeed = timelineSeed()) {
  const s = { plans: (seed.plans ?? []).map((x) => ({ ...x })), runs: (seed.runs ?? []).map((x) => ({ ...x })), activity: (seed.activity ?? []).map((x) => ({ ...x })), instruments: (seed.instruments ?? []).map((x) => ({ ...x })) };
  const calls: Array<{ op: string; tenantId?: string; tx: unknown; args: unknown[] }> = [];
  const rec = <R>(op: string, tx: unknown, t: string | undefined, args: unknown[], fn: () => R): R => { calls.push({ op, tenantId: t, tx, args }); return fn(); };
  const ms = (v: string) => Date.parse(v);
  const repo: StatusRepo = {
    async findPlanForPair(tx, t, instrumentId, analyteId) {
      return rec('findPlanForPair', tx, t, [instrumentId, analyteId], () => {
        const p = s.plans.find((x) => x.tenant_id === t && x.instrument_id === instrumentId && x.analyte_id === analyteId);
        return p ? { plan_id: p.id, qc_validity_hours: p.qc_validity_hours ?? 24 } : undefined;
      });
    },
    async listRunsForStatus(tx, t, planIds, atIso) {
      return rec('listRunsForStatus', tx, t, [planIds, atIso], () => {
        const out: any[] = [];
        for (const pid of planIds) {
          const e = s.runs.filter((r) => r.tenant_id === t && r.plan_id === pid && ['evaluated', 'closed'].includes(r.status ?? 'evaluated') && ms(r.run_at) <= ms(atIso))
            .sort((a, b) => ms(b.run_at) - ms(a.run_at) || (a.id < b.id ? 1 : -1));
          const latest = e.slice(0, 20);
          const open = e.filter((r) => r.outcome === 'rejected' && (r.closed_at == null || ms(r.closed_at) > ms(atIso)));
          for (const r of new Map([...latest, ...open].map((x) => [x.id, x])).values()) {
            out.push({ plan_id: r.plan_id, id: r.id, status: r.status ?? 'evaluated', outcome: r.outcome, run_at: r.run_at, closed_at: r.closed_at ?? null, rules_violated: [...(r.rules_violated ?? [])] });
          }
        }
        return out;
      });
    },
    async listBoardPlans(tx, t) {
      return rec('listBoardPlans', tx, t, [], () => s.plans.filter((x) => x.tenant_id === t && (x.status ?? 'active') === 'active')
        .map((x) => ({ plan_id: x.id, instrument_id: x.instrument_id, analyte_id: x.analyte_id, test_id: x.test_id ?? TST(0), qc_validity_hours: x.qc_validity_hours ?? 24 })));
    },
    async listActivity(tx, t, planIds) {
      return rec('listActivity', tx, t, [planIds], () => s.activity.filter((a) => a.tenant_id === t && planIds.includes(a.plan_id)).map((a) => ({
        plan_id: a.plan_id, last_patient_result_at: a.last_patient_result_at ?? null, patient_results_since_last_qc: a.patient_results_since_last_qc ?? 0, last_qc_run_at: a.last_qc_run_at ?? null })));
    },
    async listInstrumentLabels(tx, t, ids) {
      return rec('listInstrumentLabels', tx, t, [ids], () => s.instruments.filter((i) => i.tenant_id === t && ids.includes(i.instrument_id)).map((i) => ({ instrument_id: i.instrument_id, instrument_code: i.instrument_code, display_name: i.display_name })));
    },
  };
  return { repo, calls, state: s, ops: () => calls.map((c) => c.op) };
}
export type FakeStatusRepo = ReturnType<typeof makeStatusRepo>;

/** Service ctx (setup.helpers makeCtx) + a gauge recorder on `ctx.metrics.set`. `now` = the board clock. */
/** Real @lims/fakes CatalogPort seeded from the plan seeds: test `test_id` (plan's tenant) carries the analyte {id: analyte_id, code: analyte_code}. */
export function makeCatalogFake(plans: PlanSeed[] = []) {
  const tests = new Map<string, any>();
  for (const p of plans) {
    const id = p.test_id ?? TST(0);
    const t = tests.get(id) ?? { id, tenantId: p.tenant_id, code: `T${id.slice(-4)}`, name: 'Synthetic test', departmentId: idN(1), departmentCode: 'BIO', specimenTypeCodes: ['blood'], containerCode: 'edta', workflowType: 'standard', analytes: [], isActive: true, revision: 1 };
    t.analytes.push({ id: p.analyte_id, code: p.analyte_code ?? 'AN', name: 'Synthetic analyte', resultType: 'numeric', reportable: true, sortOrder: t.analytes.length + 1 });
    tests.set(id, t);
  }
  return createFakeCatalogPort({ seed: 7, fixtures: { tests: [...tests.values()] } as any });
}
export function makeStatusCtx(over: { tenantId?: string; roles?: (c: { permission: string }) => void; now?: string; metrics?: boolean; plans?: PlanSeed[] } = {}) {
  const base = makeCtx({ ...(over.tenantId ? { tenantId: over.tenantId } : {}), ...(over.roles ? { roles: over.roles } : {}), ...(over.now ? { now: over.now } : {}) });
  const catalog = makeCatalogFake(over.plans); base.ctx.ports.CatalogPort = catalog;
  const sets: Array<{ name: string; value: number; labels?: Record<string, string> }> = [];
  if (over.metrics !== false) base.ctx.metrics = { set: (name: string, value: number, labels?: Record<string, string>) => { sets.push({ name, value, ...(labels ? { labels } : {}) }); }, inc() {}, observe() {} };
  return { ...base, sets, catalog };
}
export const lims = (c: string) => new LimsError(c as any);
