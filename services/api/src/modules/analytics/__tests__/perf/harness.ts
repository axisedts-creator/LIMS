// AN-T23 perf harness (TRD §12). Owned by the TESTER per LD-136 (2026-11-12): everything under __tests__/perf/ is test-owned.
// Pure helpers are unit-tested in harness.test.ts. `runPerf` drives the real handlers / engine against a seeded DB (like
// repository/__tests__/refresh.live.test.ts) and is NOT executed in this lane (no seeded database): the live runs are release gate RG-6 (LD-136 (3)).
import { uuidv7 } from '../../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { createDb } from '../../../../core/db/tx.js';
import { FAMILIES, SNAPSHOT_DATE } from '../../domain/families.js';
import { writeXlsx } from '../../export/XlsxWriter.js';
import { buildReport } from '../../export/reportTable.js';
import { handlers } from '../../handlers/index.js';
import { markDirty } from '../../repository/refresh.repo.js';
import { refreshTenant } from '../../service/refresh.service.js';

export type PerfKey = 'dashboard_31d' | 'report_31d' | 'report_366d' | 'tat_366d' | 'pending_summary' | 'export_10k' | 'refresh_lag' | 'sweep_recent';
export interface Target { readonly key: PerfKey; readonly limitMs: number }
export interface PerfResult { key: string; samples: number; p95Ms: number }
export interface PerfReport {
  scale: '1x' | '10x'; generatedAt: string; seed: string; patientsPerDay?: number;
  results: PerfResult[]; sourceViewScans: { view: string; ms: number }[];
}

const frozen = (key: PerfKey, limitMs: number): Target => Object.freeze({ key, limitMs });
/** TRD §12 "Target p95" column, in row order (frozen; harness.test.ts compares it with the TRD text). */
export const TARGETS: readonly Target[] = Object.freeze([
  frozen('dashboard_31d', 300), frozen('report_31d', 500), frozen('report_366d', 1500), frozen('tat_366d', 2000),
  frozen('pending_summary', 300), frozen('export_10k', 60_000), frozen('refresh_lag', 120_000), frozen('sweep_recent', 30_000),
]);

/** TRD §12 last paragraph: sweep_recent > 120 s per tenant at 1x -> raise the sweep interval to 30 min. */
export const SWEEP_ESCALATION_MS = 120_000;
/** TRD §12 refresh lag = debounce 60 s + run. */
export const REFRESH_DEBOUNCE_MS = 60_000;

/** Nearest-rank p95. Throws on an empty / non-finite sample set. */
export function p95(samples: readonly number[]): number {
  if (samples.length === 0 || samples.some((x) => !Number.isFinite(x))) throw new TypeError('p95: non-empty finite samples expected');
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.ceil(0.95 * s.length) - 1]!;
}

export function decideSweepInterval(sweepRecentWallMs1x: number): { intervalMinutes: 10 | 30; cron: string } {
  if (!Number.isFinite(sweepRecentWallMs1x) || sweepRecentWallMs1x < 0) throw new TypeError('decideSweepInterval: non-negative finite ms expected');
  return sweepRecentWallMs1x > SWEEP_ESCALATION_MS ? { intervalMinutes: 30, cron: '*/30 * * * *' } : { intervalMinutes: 10, cron: '*/10 * * * *' };
}

/** Empty = every target measured and met (equal passes). A missing / NaN / negative measurement is a violation, never a pass. */
export function violations(report: { results?: readonly { key: string; p95Ms: number }[] }, targets: readonly Target[] = TARGETS): string[] {
  const out: string[] = [];
  for (const t of targets) {
    const r = report.results?.find((x) => x.key === t.key);
    if (!r) out.push(`${t.key}: not measured`);
    else if (!Number.isFinite(r.p95Ms) || r.p95Ms < 0) out.push(`${t.key}: invalid measurement`);
    else if (r.p95Ms > t.limitMs) out.push(`${t.key}: p95 ${r.p95Ms} ms > ${t.limitMs} ms`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- live run
const TA = '01a1a98a-ac40-7000-8000-00000000a001';
const MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a500', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const PATIENTS_PER_DAY = { '1x': 500, '10x': 5000 } as const; // T0A-05 generator volumes (`pnpm db:seed --scale 1|10`)
const PUB_VIEWS = [
  'frontdesk.v_pub_order_daily', 'frontdesk.v_pub_centre_volume', 'frontdesk.v_pub_referrer_volume', 'billing.v_pub_invoice_daily', 'billing.v_pub_department_income',
  'billing.v_pub_payment_collection', 'billing.v_pub_referrer_billing', 'lab.v_pub_result_daily', 'lab.v_pub_rejection_daily', 'lab.v_pub_critical_value_daily', 'instruments.v_pub_message_daily',
] as const;
const ms = async (f: () => Promise<unknown>): Promise<number> => { const t = performance.now(); await f(); return performance.now() - t; };
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function runPerf(o: { scale: '1x' | '10x'; superUserUrl: string; appUrl: string }): Promise<PerfReport> {
  const pg: any = await import(['p', 'g'].join('')); // dynamic: `pg` is a runtime-only dependency of the live tests
  const Pool = (pg.default ?? pg).Pool;
  const su = new Pool({ connectionString: o.superUserUrl, max: 2 }), app = new Pool({ connectionString: o.appUrl, max: 4 });
  try {
    const db = createDb({ pool: app, identitySystemActorId: SYS });
    let n = 0;
    const requestTx = <T>(fn: Parameters<typeof db.requestTx<T>>[1]) => db.requestTx({
      claims: { actor_type: 'system', tenant_id: TA, sub: SYS, membership_id: MEMBERSHIP } as never, requestId: uuidv7(), clientIp: '203.0.113.7',
      operation: { module: 'analytics', operationId: `AN-T23.perf.${++n}` },
    }, fn);

    const today = String((await su.query(`SELECT ((now() AT TIME ZONE 'Asia/Kathmandu')::date)::text AS d`)).rows[0].d);
    const base = {
      tenantId: TA, now: () => new Date().toISOString(), metrics: { inc() {} }, log: { warn() {}, info() {}, error() {} },
      audit: { access: async () => undefined }, actor: { type: 'user', id: SYS, membershipId: MEMBERSHIP },
      // Owner persona: every analytics permission, all centres (the scope of the widest realistic query).
      ports: { IdentityPort: {
        assertRole: async () => undefined,
        getActor: async () => ({ permissions: ['analytics.dashboard.read', 'analytics.collections.read', 'analytics.referral_report.read', 'analytics.data.export'], centreScope: { all: true, centreIds: [] } }),
      } },
      core: { branches: async () => [], centres: async () => [] },
    };
    const get = (op: keyof typeof handlers, query: Record<string, unknown>) =>
      requestTx((tx) => handlers[op]({ params: {}, query, headers: {} } as never, { ...base, tx, operationId: op } as never));
    const range = (days: number) => ({ business_date_from: addDays(today, -days), business_date_to: addDays(today, 1) });
    const sample = async (count: number, f: () => Promise<unknown>) => { await f(); /* warm-up, not counted */ const xs: number[] = []; for (let i = 0; i < count; i++) xs.push(await ms(f)); return xs; };
    const results: PerfResult[] = [];
    const add = (key: PerfKey, xs: number[]) => results.push({ key, samples: xs.length, p95Ms: Math.round(p95(xs) * 100) / 100 });

    add('dashboard_31d', await sample(30, () => get('getAnalyticsDashboard', range(30))));
    // "other report GETs, <= 31 days": every rollup-backed report handler, samples pooled.
    const R31 = ['getIncomeReport', 'getDepartmentIncomeReport', 'getCollectionsReport', 'getVolumeReport', 'getTopReferrersReport', 'getTopCentresReport', 'getTestsDoneReport', 'getQualityIndicatorsReport', 'getDeliveryReport', 'getInterfacesReport'] as const;
    add('report_31d', (await Promise.all(R31.map((op) => sample(3, () => get(op, range(30)))))).flat());
    // 366 days: the widest rollup report (referrers, 730k rows/year worst case) and the other handlers; samples pooled.
    const R366 = ['getIncomeReport', 'getTopReferrersReport', 'getTestsDoneReport', 'getVolumeReport'] as const;
    add('report_366d', (await Promise.all(R366.map((op) => sample(5, () => get(op, range(365)))))).flat());
    add('tat_366d', await sample(20, () => get('getTatReport', range(365))));
    add('pending_summary', await sample(30, () => get('getPendingTestsSummary', {})));

    // export <= 10,000 rows: the same service functions + writer as analytics.build_export (steps 4-6), wall time of the build.
    const exp = await sample(3, () => requestTx(async (tx) => {
      const c: any = { ...base, tx };
      const period = (await import('../../domain/period.js')).resolvePeriod(range(365) as never, today as never, 400);
      const built = await buildReport(c, 'top_referrers', {}, { period, scope: { all: true, centreIds: [] }, now: base.now() });
      await writeXlsx({ meta: { tenantDisplayName: 'Perf', reportTitle: built.title, periodLabelAd: '', periodLabelBs: '', scopeLabel: 'All centres', generatedAtLocal: '', exportId: uuidv7(), exportedBy: 'perf', freshnessNote: '' } as never, columns: built.columns, rows: built.rows });
    }));
    add('export_10k', exp);

    const ctx = () => ({
      actor: { id: SYS }, now: base.now, db: { tx: <T>(fn: (c: { tx: any }) => Promise<T>) => requestTx((tx) => fn({ tx })) },
    });
    const mark = (from: string, to: string) => requestTx(async (tx) => {
      for (const family of FAMILIES) {
        if (family === 'report_backlog') { await markDirty(tx as never, { tenantId: TA, family, businessDate: SNAPSHOT_DATE, reason: 'manual', actorId: SYS } as never); continue; }
        for (let d = from; d < to; d = addDays(d, 1)) await markDirty(tx as never, { tenantId: TA, family, businessDate: d, reason: 'manual', actorId: SYS } as never);
      }
    });

    // refresh lag after an evented change = debounce + run (one date of one family marked, then the run).
    const lag: number[] = [];
    for (let i = 0; i < 5; i++) {
      await requestTx((tx) => markDirty(tx as never, { tenantId: TA, family: 'income', businessDate: today, reason: 'event', actorId: SYS } as never));
      lag.push(REFRESH_DEBOUNCE_MS + await ms(() => refreshTenant(ctx() as never, { tenantId: TA, trigger: 'event' } as never)));
    }
    add('refresh_lag', lag);

    // sweep_recent per tenant: 16 families x the last 2 dates, wall time; source-view scan times measured over the same window.
    const sweep: number[] = [];
    for (let i = 0; i < 3; i++) { await mark(addDays(today, -1), addDays(today, 1)); sweep.push(await ms(() => refreshTenant(ctx() as never, { tenantId: TA, trigger: 'sweep_recent' } as never))); }
    add('sweep_recent', sweep);
    const sourceViewScans: PerfReport['sourceViewScans'] = [];
    for (const view of PUB_VIEWS) {
      sourceViewScans.push({ view, ms: Math.round(await ms(() => su.query(`SELECT count(*) FROM ${view} WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3`, [TA, addDays(today, -1), addDays(today, 1)])) * 100) / 100 });
    }

    return { scale: o.scale, generatedAt: new Date().toISOString(), seed: `synthetic-${o.scale === '1x' ? 1 : 10}`, patientsPerDay: PATIENTS_PER_DAY[o.scale], results, sourceViewScans };
  } finally { await su.end(); await app.end(); }
}
