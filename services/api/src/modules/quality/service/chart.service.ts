// C9 T-14 — Levey-Jennings chart data #35 (02-TRD §5.5, §7.10 LjChartDto + point status mapping + z view, §12 LIMS_QUALITY_LJ_MAX_POINTS; PRD AC-08.1, AC-08.4; 07-SECURITY REQ-SEC-024/081/098/100, S-16).
// assertRole(quality.qc_run.read) FIRST -> validate -> findPlan -> newest maxPoints+1 observations -> ONE runs read + ONE targets read (+ ONE CatalogPort.getTest). Read-only on ctx.tx.
// Series = (level, lot) with >= 1 kept point, never merged (AC-08.1). The cap is per chart: more than maxPoints rows -> the newest maxPoints stay, truncated = true.
// Failures: LimsErrors pass through; anything else is common.internal without driver text (fail closed).
import { LimsError, isLimsError } from '../../../core/errors.js';
import { loadQualityConfig } from '../config.js';
import { createChartRepo, type ChartRepo, type ChartRun } from '../repository/chart.repo.js';
import { Errs, isObj, isUuid } from './setup.validate.js';

type Row = Record<string, any>;
export interface ChartCtx {
  tenantId: string; tx: any;
  ports: { IdentityPort: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> }; CatalogPort: { getTest(ctx: unknown, i: { testId: string }): Promise<Row> } };
}

const READ = 'quality.qc_run.read';
const MAX_SPAN_MS = 400 * 86_400_000;   // S-16
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const WARN_Z = 2_000_000n;               // |z| > 2 on the stored 6 dp value

/** An ISO-UTC instant that is a real calendar time (2026-02-31 is refused), as ISO text with ms. */
function instant(v: unknown): string | undefined {
  if (typeof v !== 'string' || !ISO_UTC.test(v)) return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== v.slice(0, 10) ? undefined : new Date(ms).toISOString();
}

function fail(err: any): never {
  if (isLimsError(err) || (typeof err?.code === 'string' && /^[a-z]+\.[a-z_]+$/.test(err.code))) throw err;
  throw new LimsError('common.internal');
}

/** Decimal text -> sign + value scaled by 1e6 (exact; the stored z has 6 dp). */
function scaled(z: string): { neg: boolean; abs: bigint } {
  const m = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(z.trim());
  if (!m) throw new LimsError('common.internal');
  return { neg: m[1] === '-', abs: BigInt(m[2]! + (m[3] ?? '').padEnd(6, '0').slice(0, 6)) };
}
/** 3 dp half-up (away from zero), padded; never "-0.000". */
function wireZ(z: string): string {
  const { neg, abs } = scaled(z);
  const r = (abs + 500n) / 1000n;
  const s = `${r / 1000n}.${String(r % 1000n).padStart(3, '0')}`;
  return neg && r !== 0n ? `-${s}` : s;
}

export function createChartService(deps: { repo?: ChartRepo; maxPoints?: number } = {}) {
  const repo = deps.repo ?? createChartRepo();
  const maxPoints = deps.maxPoints ?? loadQualityConfig().ljMaxPoints;

  function parse(input: unknown) {
    const e = new Errs();
    if (!isObj(input)) { e.add('/'); e.done(); }
    const q = input as Row;
    const planId = q['planId'];
    if (!isUuid(planId)) e.add('/plan_id', planId === undefined ? 'common.field_required' : 'common.field_invalid');
    const view = q['view'] ?? 'level';
    if (view !== 'level' && view !== 'z') e.add('/view');
    const levelId = q['levelId'];
    if (levelId === undefined ? view === 'level' : !isUuid(levelId)) e.add('/level_id', levelId === undefined ? 'common.field_required' : 'common.field_invalid');
    const lotId = q['lotId'];
    if (lotId !== undefined && !isUuid(lotId)) e.add('/lot_id');
    const from = instant(q['observedAtFrom']), to = instant(q['observedAtTo']);
    if (from === undefined) e.add('/observed_at_from', q['observedAtFrom'] === undefined ? 'common.field_required' : 'common.field_invalid');
    if (to === undefined) e.add('/observed_at_to', q['observedAtTo'] === undefined ? 'common.field_required' : 'common.field_invalid');
    if (from !== undefined && to !== undefined && (from > to || Date.parse(to) - Date.parse(from) > MAX_SPAN_MS)) e.add('/observed_at_to');
    e.done();
    return { planId: planId as string, view: view as 'level' | 'z', levelId: levelId as string | undefined, lotId: lotId as string | undefined, from: from!, to: to! };
  }

  /** §7.10 status, first match wins. */
  function status(o: Row, run: ChartRun | undefined, listed: boolean): string {
    if (o['status'] === 'excluded') return 'excluded';
    if (o['status'] !== 'assigned') return 'unevaluated';
    if (run?.status === 'collecting') return 'collecting';
    if (run?.outcome === 'rejected' && listed) return 'rejected';
    return o['z'] != null && scaled(o['z']).abs > WARN_Z ? 'warning' : 'accepted';
  }

  return {
    async getLeveyJenningsChart(ctx: ChartCtx, input: unknown): Promise<{ status: 200; body: Row }> {
      await ctx.ports.IdentityPort.assertRole(ctx, { permission: READ });
      const q = parse(input);
      try {
        const plan = await repo.findPlan(ctx.tx, ctx.tenantId, q.planId);
        if (!plan) throw new LimsError('common.not_found');
        const fetched = await repo.listChartObservations(ctx.tx, ctx.tenantId, {
          planId: q.planId, ...(q.view === 'level' ? { levelId: q.levelId! } : {}), ...(q.lotId === undefined ? {} : { lotId: q.lotId }), from: q.from, to: q.to, limit: maxPoints + 1,
        });
        const truncated = fetched.length > maxPoints;
        const kept = fetched.slice(0, maxPoints);   // newest first: the oldest overflow is dropped

        const [test, runs, targets] = await Promise.all([
          ctx.ports.CatalogPort.getTest(ctx, { testId: plan.test_id }),
          kept.length ? repo.listRunsForChart(ctx.tx, ctx.tenantId, [...new Set(kept.flatMap((o) => (o.qc_run_id ? [o.qc_run_id] : [])))]) : [],
          kept.length ? repo.listTargetsForChart(ctx.tx, ctx.tenantId, { planId: q.planId, lotIds: [...new Set(kept.map((o) => o.lot_id))], from: q.from, to: q.to }) : [],
        ]);
        const analyte = (test?.['analytes'] as Row[] | undefined)?.find((a) => a['id'] === plan.analyte_id);
        if (typeof analyte?.['code'] !== 'string' || !analyte['code']) throw new LimsError('common.internal');   // [CONV] unknown analyte: the DTO requires analyte_code, never guess

        const runOf = new Map(runs.map((r) => [r.id, r]));
        const groups = new Map<string, { head: Row; obs: typeof kept }>();
        for (const o of kept) {
          const k = `${o.level_id}|${o.lot_id}`;
          (groups.get(k) ?? groups.set(k, { head: { level_id: o.level_id, level_code: o.level_code, lot_id: o.lot_id, lot_no: o.lot_no }, obs: [] }).get(k)!).obs.push(o);
        }
        const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
        const series = [...groups.entries()].map(([k, g]) => ({
          ...g.head,
          points: g.obs.sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at) || cmp(a.id, b.id)).map((o) => {
            const run = o.qc_run_id ? runOf.get(o.qc_run_id) : undefined;
            const hits = (run?.rule_detail ?? []).filter((d) => d.observation_ids.includes(o.id));
            return {
              observation_id: o.id, observed_at: new Date(Date.parse(o.observed_at)).toISOString(), value: o.value, ...(o.z == null ? {} : { z: wireZ(o.z) }),
              status: status(o, run, hits.length > 0), ...(o.qc_run_id ? { qc_run_id: o.qc_run_id } : {}), rule_hits: [...new Set(hits.map((d) => d.rule))],
            };
          }),
          targets: targets.filter((t) => `${t.level_id}|${t.lot_id}` === k).sort((a, b) => Date.parse(a.effective_from) - Date.parse(b.effective_from) || cmp(a.id, b.id)).map((t) => ({
            target_id: t.id, effective_from: new Date(Date.parse(t.effective_from)).toISOString(), ...(t.effective_to ? { effective_to: new Date(Date.parse(t.effective_to)).toISOString() } : {}),
            mean: t.mean, sd: t.sd, source: t.source,
          })),
        })).sort((a, b) => cmp(a.level_code, b.level_code) || cmp(a.lot_no, b.lot_no));

        return {
          status: 200,
          body: {
            plan: {
              id: plan.plan_id, instrument_id: plan.instrument_id, analyte_id: plan.analyte_id, analyte_code: analyte['code'],
              ...(typeof analyte['unitCode'] === 'string' && analyte['unitCode'] ? { unit_code: analyte['unitCode'] } : {}),
              decimals: Number.isInteger(analyte['decimals']) ? analyte['decimals'] : 0,   // as target.service
            },
            view: q.view, series, truncated,
          },
        };
      } catch (err) { return fail(err); }
    },
  };
}
