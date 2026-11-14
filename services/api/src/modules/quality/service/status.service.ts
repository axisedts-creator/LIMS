// C9 T-13 — QC status (02-TRD §7.8 S1-S8, §11.1; 03-IC §4.11) and the status board #34 (§5.5, §5.10 QcStatusRowDto, §14 gauge); PRD AC-09.1-09.5.
// qcStatusFor: the QualityPort read. No permission check (the C5 caller authorised its own action), tenant from ctx only, read-only on ctx.tx, at most two repo calls.
// getQcStatusBoard: assertRole -> validate -> 4 repo reads + CatalogPort.getTest per distinct test (T-13 ruling: analyte_code comes from the catalog, 02-TRD:277,778) -> rows -> gauge -> filter/page in memory.
// Failures: LimsErrors pass through; anything else is common.internal without driver text (fail closed: C5 must never read a failure as in_control).
import { LimsError, isLimsError } from '../../../core/errors.js';
import { qcStatus, type QcStatusRun } from '../domain/qc-status.js';
import { createStatusRepo, type StatusRepo, type StatusRun } from '../repository/status.repo.js';
import { Errs, isObj, isUuid, paging, qBool, qUuid } from './setup.validate.js';

type Row = Record<string, any>;
export interface StatusCtx {
  tenantId: string; tx: any; now(): string;
  ports: { IdentityPort: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> }; CatalogPort: { getTest(ctx: unknown, i: { testId: string }): Promise<Row> } };
  metrics?: { set(name: string, value: number, labels?: Record<string, string>): void };
}
export interface QcStatusPortResult { status: 'in_control' | 'warning' | 'out_of_control' | 'no_qc_data'; lastInControlRunAt?: string; currentRunId?: string; violatedRules?: string[] }

const READ = 'quality.qc_run.read';
const GAUGE = 'lims_quality_qc_overdue_pairs';
const HOUR_MS = 3_600_000;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const STATUS_CSV = /^(in_control|warning|out_of_control|no_qc_data)(,(in_control|warning|out_of_control|no_qc_data)){0,3}$/;   // = quality.yaml #34 `status`

const isInstant = (v: unknown): v is string => typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));
const iso = (v: string) => new Date(Date.parse(v)).toISOString();
const invalid = (path: string): never => { const e = new Errs(); e.add(path); e.done(); throw new LimsError('common.validation_failed'); };

/** LimsErrors (and errors already carrying a LIMS code) pass through; driver / unknown errors become common.internal. */
function fail(err: any): never {
  if (isLimsError(err) || (typeof err?.code === 'string' && /^[a-z]+\.[a-z_]+$/.test(err.code))) throw err;
  throw new LimsError('common.internal');
}
const guard = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (err) { return fail(err); } };

const domainRuns = (rs: StatusRun[]): QcStatusRun[] => rs.map((r) => ({
  id: r.id, status: r.status as QcStatusRun['status'], outcome: r.outcome as QcStatusRun['outcome'], runAt: new Date(Date.parse(r.run_at)),
  closedAt: r.closed_at == null ? null : new Date(Date.parse(r.closed_at)), rulesViolated: [...(r.rules_violated ?? [])],
}));
function evaluate(runs: StatusRun[], at: string, qcValidityHours: number): QcStatusPortResult {
  const r = qcStatus({ hasPlan: true, runs: domainRuns(runs), at: new Date(Date.parse(at)), qcValidityHours });
  return {
    status: r.status,
    ...(r.lastInControlRunAt ? { lastInControlRunAt: r.lastInControlRunAt.toISOString() } : {}),
    ...(r.currentRunId ? { currentRunId: r.currentRunId } : {}),
    ...(r.violatedRules ? { violatedRules: [...r.violatedRules] } : {}),
  };
}

// Board cursor = base64url(JSON [instrument_id, analyte_code, plan_id]) of the last row (keyset on the board order).
type Key = [string, string, string];
const keyOf = (r: Row): Key => [r['instrument_id'], r['analyte_code'], r['plan_id']];
const cmp = (a: Key, b: Key): number => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1; return 0; };
const encodeCursor = (k: Key) => Buffer.from(JSON.stringify(k)).toString('base64url');
function decodeCursor(c: string): Key {
  let v: unknown;
  try { v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')); } catch { throw new LimsError('common.invalid_cursor'); }
  if (!Array.isArray(v) || v.length !== 3 || !isUuid(v[0]) || typeof v[1] !== 'string' || v[1].length > 64 || !isUuid(v[2])) throw new LimsError('common.invalid_cursor');
  return [v[0], v[1], v[2]];
}

export function createStatusService(deps: { repo?: StatusRepo } = {}) {
  const repo = deps.repo ?? createStatusRepo();

  /** One getTest per distinct test_id; the code of the analyte whose id = analyte_id. A missing code fails closed (the DTO requires it). */
  async function analyteCodes(ctx: StatusCtx, plans: Array<{ test_id: string; analyte_id: string }>): Promise<Map<string, string>> {
    const tests = new Map<string, Row>();
    await Promise.all([...new Set(plans.map((p) => p.test_id))].map(async (testId) => { tests.set(testId, await ctx.ports.CatalogPort.getTest(ctx, { testId })); }));
    const out = new Map<string, string>();
    for (const p of plans) {
      const code = (tests.get(p.test_id)?.['analytes'] as Row[] | undefined)?.find((a) => a['id'] === p.analyte_id)?.['code'];
      if (typeof code !== 'string' || !code) throw new LimsError('common.internal');   // [CONV] plan references an analyte the catalog does not know: fail closed
      out.set(`${p.test_id}|${p.analyte_id}`, code);
    }
    return out;
  }

  return {
    async qcStatusFor(ctx: StatusCtx, input: { instrumentId: string; analyteId: string; at: string }): Promise<QcStatusPortResult> {
      if (!isObj(input)) invalid('/');
      if (!isUuid(input.instrumentId)) invalid('/instrumentId');
      if (!isUuid(input.analyteId)) invalid('/analyteId');
      if (!isInstant(input.at)) invalid('/at');
      const at = iso(input.at);
      return guard(async () => {
        const plan = await repo.findPlanForPair(ctx.tx, ctx.tenantId, input.instrumentId, input.analyteId);
        if (!plan) return { status: 'no_qc_data' };
        return evaluate(await repo.listRunsForStatus(ctx.tx, ctx.tenantId, [plan.plan_id], at), at, plan.qc_validity_hours);
      });
    },

    async getQcStatusBoard(ctx: StatusCtx, q: Row = {}): Promise<{ status: 200; body: Row }> {
      await ctx.ports.IdentityPort.assertRole(ctx, { permission: READ });
      const e = new Errs(), pg = paging(e, q);
      const instrumentId = qUuid(e, q, 'instrumentId', 'instrument_id');
      const overdueOnly = qBool(e, q, 'overdueOnly', 'overdue_only');
      let statuses: Set<string> | undefined;
      if (q['status'] !== undefined) {
        if (typeof q['status'] !== 'string' || !STATUS_CSV.test(q['status'])) e.add('/status'); else statuses = new Set(q['status'].split(','));
      }
      e.done();
      const after = pg.cursor === undefined ? undefined : decodeCursor(pg.cursor);
      const now = iso(ctx.now());

      const rows = await guard(async () => {
        const plans = await repo.listBoardPlans(ctx.tx, ctx.tenantId);
        const ids = plans.map((p) => p.plan_id);
        const [runs, activity, labels, codes] = await Promise.all([
          repo.listRunsForStatus(ctx.tx, ctx.tenantId, ids, now),
          repo.listActivity(ctx.tx, ctx.tenantId, ids),
          repo.listInstrumentLabels(ctx.tx, ctx.tenantId, [...new Set(plans.map((p) => p.instrument_id))]),
          analyteCodes(ctx, plans),
        ]);
        const runsOf = new Map<string, StatusRun[]>();
        for (const r of runs) runsOf.set(r.plan_id, [...(runsOf.get(r.plan_id) ?? []), r]);
        const actOf = new Map(activity.map((a) => [a.plan_id, a]));
        const labelOf = new Map(labels.map((l) => [l.instrument_id, `${l.display_name} (${l.instrument_code})`]));
        const nowMs = Date.parse(now);
        return plans.map((p) => {
          const rs = runsOf.get(p.plan_id) ?? [];
          const s = evaluate(rs, now, p.qc_validity_hours);
          const a = actOf.get(p.plan_id);
          const since = a?.patient_results_since_last_qc ?? 0;
          // AC-09.5: patients since QC and (never QC'd, or QC older than the plan validity, strict).
          const overdue = since > 0 && (a?.last_qc_run_at == null || nowMs - Date.parse(a.last_qc_run_at) > p.qc_validity_hours * HOUR_MS);
          const open = rs.filter((r) => r.outcome === 'rejected' && (r.closed_at == null || Date.parse(r.closed_at) > nowMs))
            .sort((x, y) => Date.parse(y.run_at) - Date.parse(x.run_at)).map((r) => r.id);
          const label = labelOf.get(p.instrument_id);
          return {
            plan_id: p.plan_id, instrument_id: p.instrument_id, ...(label ? { instrument_label: label } : {}),
            analyte_id: p.analyte_id, analyte_code: codes.get(`${p.test_id}|${p.analyte_id}`)!, status: s.status,
            ...(s.lastInControlRunAt ? { last_in_control_run_at: s.lastInControlRunAt } : {}), ...(s.currentRunId ? { current_run_id: s.currentRunId } : {}),
            violated_rules: s.violatedRules ?? [], open_rejected_run_ids: open, qc_overdue: overdue, patient_results_since_last_qc: since,
            ...(a?.last_patient_result_at ? { last_patient_result_at: a.last_patient_result_at } : {}),
          } as Row;
        }).sort((x, y) => cmp(keyOf(x), keyOf(y)));
      });

      ctx.metrics?.set(GAUGE, rows.filter((r) => r['qc_overdue']).length, { tenant_id: ctx.tenantId });   // whole tenant, before filters and paging (§14)
      const hits = rows.filter((r) => (instrumentId === undefined || r['instrument_id'] === instrumentId) && (!statuses || statuses.has(r['status']))
        && (!overdueOnly || r['qc_overdue']) && (!after || cmp(keyOf(r), after) > 0));
      const data = hits.slice(0, pg.limit);
      const more = hits.length > pg.limit;
      return { status: 200, body: { data, page: { limit: pg.limit, ...(more ? { next_cursor: encodeCursor(keyOf(data[data.length - 1]!)) } : {}) }, generated_at: now } };
    },
  };
}
