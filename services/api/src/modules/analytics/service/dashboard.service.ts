// Dashboard, freshness and manual refresh (02-TRD §5 #1/#18/#19, §6.7, §9.7; PRD US-01.x, US-16.x, US-19.x; 08 A17 P-22; 07-SECURITY P1/P3/P4/P7/X1/X2).
// Reads write nothing. The only user writes: the `_manual` throttle row, dirty marks, one refresh_tenant job (all in the caller's tx).
import { LimsError } from '../../../core/errors.js';
import { loadAnalyticsConfig } from '../config.js';
import { FAMILIES, SNAPSHOT_DATE, type Family } from '../domain/families.js';
import { evaluateFreshness, liveFreshness, type Freshness } from '../domain/freshness.js';
import { businessDateOf, previousPeriod, type Period } from '../domain/period.js';
import { delta, ratioBp } from '../domain/metrics.js';
import type { Scope } from '../domain/scope.js';
import { loadFamilyStates, markDirty, type RefreshTx } from '../repository/refresh.repo.js';
import * as rollups from '../repository/rollups.repo.js';
import { departmentLabels } from './labels.service.js';
import { invalidField, type ReportsContext } from './reports.service.js';

type Ctx = ReportsContext & { now(): string; tx: RefreshTx & rollups.RollupsTx };

const num = (v: unknown): number => Number(v);
const sum = <T>(xs: readonly T[], f: (x: T) => number): number => xs.reduce((a, x) => a + f(x), 0);

// ------------------------------------------------------------------ freshness
const DASHBOARD_FAMILIES: readonly Family[] = ['orders', 'centre_volume', 'income', 'collections', 'results', 'report_backlog'];
const LIVE_SOURCES = ['pending_items', 'agent_status'] as const; // US-16.3

export async function freshnessOf(ctx: Ctx, families: readonly Family[], live: readonly string[]): Promise<Freshness[]> {
  const cfg = loadAnalyticsConfig();
  const now = ctx.now() as never;
  const states = await loadFamilyStates(ctx.tx, { tenantId: ctx.tenantId });
  return [
    ...states.filter((s) => (families as readonly string[]).includes(s.family)).map((s) => evaluateFreshness(s, now, cfg)),
    ...live.map((f) => liveFreshness(f, now)),
  ];
}
export const allFreshness = (ctx: Ctx) => freshnessOf(ctx, FAMILIES, LIVE_SOURCES);

// ------------------------------------------------------------------ dashboard
export interface Tile { value: number; previous?: number; delta?: number; delta_bp?: number; unit: 'count' | 'paisa' }
const flow = (value: number, previous: number, unit: Tile['unit']): Tile => {
  const d = delta(value, previous);
  return { value, previous, delta: d.absolute, ...(d.percentBp === null ? {} : { delta_bp: d.percentBp }), unit }; // no delta_bp when previous = 0
};
const snapshot = (value: number): Tile => ({ value, unit: 'count' });

const BACKLOG_SQL = `SELECT centre_id, stage, age_bucket, orders, oldest_registered_at FROM analytics.report_backlog
WHERE tenant_id = $1 AND ($2::boolean OR centre_id = ANY ($3::uuid[]))`; // TRD §6 scope predicate: NULL centre only for all-centre readers
const PENDING_SQL = (filtered: boolean) => `SELECT item_status, priority, department_id,
       CASE WHEN age_seconds < 14400 THEN 'lt_4h' WHEN age_seconds < 86400 THEN 'h4_24'
            WHEN age_seconds < 259200 THEN 'd1_3' ELSE 'gt_3d' END AS age_bucket,
       count(*) AS n,
       count(*) FILTER (WHERE tat_target_seconds IS NOT NULL AND age_seconds > tat_target_seconds) AS overdue,
       count(*) FILTER (WHERE tat_target_seconds IS NULL) AS no_target
FROM lab.v_pub_pending_items
WHERE tenant_id = $1${filtered ? ' AND centre_id = ANY ($2::uuid[])' : ''}
GROUP BY 1, 2, 3, 4`; // D-49: no implicit centre predicate - C5 RLS narrows; only an explicit centre/branch filter adds one

export interface DashboardOut {
  tiles: Record<string, Tile>;
  series: { business_date: string; net_sales_paisa: number; patient_visits: number; net_orders: number }[];
  departmentTop: { department_id?: string; label: string; is_multiple: boolean; net_paisa: number; share_bp: number }[];
  freshness: Freshness[];
}

export async function dashboard(
  ctx: Ctx,
  a: { period: Period; scope: Scope; filtered: boolean; withCollections: boolean },
): Promise<DashboardOut> {
  const { period, scope } = a;
  const prev = previousPeriod(period);
  const base = { tenantId: ctx.tenantId, scope };
  const wide = { ...base, from: prev.from, to: period.to }; // one read per family covers previous + current; split by date below
  const cur = (d: string | null | undefined) => d != null && d >= period.from;

  const inc = await rollups.incomeRows(ctx.tx, { ...wide, groupBy: 'day' });
  const vol = await rollups.volumeRows(ctx.tx, { ...wide, groupBy: 'day' });
  const res = await rollups.resultsRows(ctx.tx, { ...wide, groupBy: 'day' });
  const col = a.withCollections ? await rollups.collectionRows(ctx.tx, { ...wide, groupBy: 'day' }) : [];
  const dep = await rollups.departmentIncomeRows(ctx.tx, { ...base, from: period.from, to: period.to, grain: 'total' });
  const names = await departmentLabels(ctx);

  const split = <T>(rows: readonly T[], dateOf: (r: T) => string | null | undefined) => ({
    now: rows.filter((r) => cur(dateOf(r))), before: rows.filter((r) => !cur(dateOf(r))),
  });
  const I = split(inc, (r) => r.key), V = split(vol, (r) => r.key), R = split(res, (r) => r.key), C = split(col, (r) => r.period);
  const netOrders = (r: rollups.VolumeRow) => num(r.orders_registered) - num(r.orders_cancelled); // M03, never clamped
  const pair = (f: (rows: never[]) => number, s: { now: unknown[]; before: unknown[] }, unit: Tile['unit']) => flow(f(s.now as never[]), f(s.before as never[]), unit);
  const tiles: Record<string, Tile> = {
    patient_visits: pair((r) => sum(r as rollups.VolumeRow[], (x) => num(x.patient_visits)), V, 'count'),
    new_patients: pair((r) => sum(r as rollups.VolumeRow[], (x) => num(x.new_patients)), V, 'count'),
    net_orders: pair((r) => sum(r as rollups.VolumeRow[], netOrders), V, 'count'),
    tests_ordered: pair((r) => sum(r as rollups.VolumeRow[], (x) => num(x.tests_ordered)), V, 'count'),
    net_sales_paisa: pair((r) => sum(r as rollups.IncomeRow[], (x) => num(x.net_sales_paisa)), I, 'paisa'),
    invoiced_paisa: pair((r) => sum(r as rollups.IncomeRow[], (x) => num(x.invoiced_paisa)), I, 'paisa'),
    credit_notes_paisa: pair((r) => sum(r as rollups.IncomeRow[], (x) => num(x.credit_notes_paisa)), I, 'paisa'),
    results_approved: pair((r) => sum(r as rollups.ResultsRow[], (x) => num(x.results_approved)), R, 'count'), // M42, analyte level
    ...(a.withCollections ? { net_collected_paisa: pair((r) => sum(r as rollups.CollectionRow[], (x) => num(x.net_collected_paisa)), C, 'paisa') } : {}),
  };
  for (const t of Object.values(tiles)) for (const v of [t.value, t.previous ?? 0]) if (!Number.isSafeInteger(v)) throw new RangeError('dashboard: tile is not a safe integer');

  // snapshot tiles: no previous / delta, independent of the period
  const backlog = (await ctx.tx.query(BACKLOG_SQL, [ctx.tenantId, scope.all, [...scope.centreIds]])).rows;
  const pending = (await ctx.tx.query(PENDING_SQL(a.filtered), a.filtered ? [ctx.tenantId, [...scope.centreIds]] : [ctx.tenantId])).rows;
  const ready = sum(backlog.filter((r) => r.stage === 'ready_unreleased'), (r) => num(r.orders));
  tiles.reports_pending = snapshot(sum(backlog, (r) => num(r.orders))); // awaiting_results + ready_unreleased
  tiles.reports_ready_unreleased = snapshot(ready);
  tiles.pending_tests = snapshot(sum(pending, (r) => num(r.n)));
  tiles.pending_overdue = snapshot(sum(pending, (r) => num(r.overdue)));

  // series: one entry per business date that has income or volume, ascending
  const days = new Map<string, { business_date: string; net_sales_paisa: number; patient_visits: number; net_orders: number }>();
  const day = (d: string) => days.get(d) ?? days.set(d, { business_date: d, net_sales_paisa: 0, patient_visits: 0, net_orders: 0 }).get(d)!;
  for (const r of I.now) day(r.key!).net_sales_paisa += num(r.net_sales_paisa);
  for (const r of V.now) { const x = day(r.key); x.patient_visits += num(r.patient_visits); x.net_orders += netOrders(r); }

  // department_top: net desc, <= 10, share of the period total (negative / zero total shows 0, as the department report)
  const byDept = new Map<string | null, number>();
  for (const r of dep) byDept.set(r.department_id, (byDept.get(r.department_id) ?? 0) + num(r.net_paisa));
  const total = sum([...byDept.values()], (n) => n);
  const departmentTop = [...byDept].map(([id, net]) => {
    const l = id === null ? undefined : names.get(id);
    return {
      ...(id === null ? {} : { department_id: id }),
      label: id === null ? 'Multiple departments' : (l?.name ?? `Department ${id.slice(-8)}`),
      is_multiple: id === null, net_paisa: net,
      share_bp: Math.min(1_000_000, Math.max(0, ratioBp(net, total) ?? 0)),
    };
  }).sort((x, y) => y.net_paisa - x.net_paisa || x.label.localeCompare(y.label)).slice(0, 10);

  const freshness = await freshnessOf(ctx, a.withCollections ? DASHBOARD_FAMILIES : DASHBOARD_FAMILIES.filter((f) => f !== 'collections'), ['pending_items']);
  return { tiles, series: [...days.values()].sort((x, y) => x.business_date.localeCompare(y.business_date)), departmentTop, freshness };
}

// ------------------------------------------------------------------ manual refresh (TRD §9.7)
const THROTTLE_SQL = `INSERT INTO analytics.refresh_state (tenant_id, family, last_manual_at, created_by)
VALUES ($1, '_manual', now(), $3)
ON CONFLICT (tenant_id, family) DO UPDATE SET last_manual_at = now()
 WHERE analytics.refresh_state.last_manual_at IS NULL
    OR analytics.refresh_state.last_manual_at < now() - make_interval(mins => $2)
RETURNING last_manual_at`;
const RETRY_SQL = `SELECT last_manual_at FROM analytics.refresh_state WHERE tenant_id = $1 AND family = '_manual'`;
const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3)';
const MAX_FAMILIES = 20;

/** X2: body is absent or `{families?}`; every item is one of the 16 families (the `_manual` row is not one). Run before the throttle slot is touched. */
export function refreshFamilies(body: unknown): Family[] {
  if (body === undefined) return [...FAMILIES];
  if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'families')) throw invalidField('body');
  const f = (body as { families?: unknown }).families;
  if (f === undefined) return [...FAMILIES];
  if (!Array.isArray(f) || f.length > MAX_FAMILIES || f.some((x) => typeof x !== 'string' || !(FAMILIES as readonly string[]).includes(x))) throw invalidField('families');
  return f.length === 0 ? [...FAMILIES] : [...new Set(f as Family[])]; // [CONV] [] = default (all)
}

const MIN_MS = 60_000;
const NPT_OFFSET_MIN = 5 * 60 + 45;
const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function requestRefresh(ctx: Ctx & { actor: { id: string } }, families: readonly Family[]): Promise<{ queued_families: Family[]; next_allowed_at: string }> {
  const cfg = loadAnalyticsConfig();
  const tenantId = ctx.tenantId, actorId = ctx.actor.id;

  const got = await ctx.tx.query(THROTTLE_SQL, [tenantId, cfg.manualRefreshMinutes, actorId]);
  const last = got.rows[0]?.last_manual_at;
  if (last == null) {
    // throttled: nothing else happens. Retry-After = until last_manual_at + window (clamped to [1, window]; host clock vs DB clock may drift a little).
    const prior = (await ctx.tx.query(RETRY_SQL, [tenantId])).rows[0]?.last_manual_at;
    const windowS = cfg.manualRefreshMinutes * 60;
    const left = prior == null ? windowS : Math.ceil((Date.parse(new Date(prior).toISOString()) + windowS * 1000 - Date.parse(ctx.now())) / 1000);
    const e = new LimsError('common.rate_limited');
    e.retryAfterSeconds = Math.min(windowS, Math.max(1, left));
    throw e;
  }

  const now = ctx.now();
  const today = businessDateOf(now as never);
  const [hh, mm] = cfg.yesterdayUntilLocal.split(':').map(Number) as [number, number];
  const localMin = (Math.floor(Date.parse(now) / MIN_MS) + NPT_OFFSET_MIN) % 1440;
  const dates = localMin < hh * 60 + mm ? [addDay(today, -1), today] : [today]; // before 06:00 local, yesterday is still being closed
  for (const family of families) {
    if (family === 'report_backlog') { await markDirty(ctx.tx, { tenantId, family, businessDate: SNAPSHOT_DATE, reason: 'manual', actorId }); continue; }
    for (const businessDate of dates) await markDirty(ctx.tx, { tenantId, family, businessDate, reason: 'manual', actorId });
  }
  await ctx.tx.query(ENQUEUE_SQL, ['analytics.refresh_tenant', JSON.stringify({ tenant_id: tenantId }), `analytics.refresh_tenant:${tenantId}`]);
  return { queued_families: [...families], next_allowed_at: new Date(new Date(last).getTime() + cfg.manualRefreshMinutes * MIN_MS).toISOString() };
}
