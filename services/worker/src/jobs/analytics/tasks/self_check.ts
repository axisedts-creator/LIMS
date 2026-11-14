// `analytics.self_check` (02-TRD §9.3; max_attempts 2; PRD R2/R3/R4): for the trailing 7 local days [today-7, today) compare, in ONE read-only statement per
// (rule, family), the rollup against its source (R3, 15 dated families), department_income against income (R2) and collections by method / staff / centre (R4).
// Each statement is bound to (tenant, from, to) only and returns just the mismatching business dates. A mismatch re-marks the partition dirty, counts
// `lims_analytics_reconciliation_mismatch_total{rule,family}` and logs `reconciliation_mismatch {family, business_date}`; figures are never edited here.
import { FAMILY_TABLE, type Family } from '../../../../../api/src/modules/analytics/domain/families.js';
import { markDirty } from '../../../../../api/src/modules/analytics/repository/refresh.repo.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { DATED_FAMILIES, addDays, jobTenant, localNow } from './shared.js';

const DAYS = 7;
const METRIC = 'lims_analytics_reconciliation_mismatch_total';
const BD = `business_date >= $2::date AND business_date < $3::date`;
const FROM_TS = `($2::date::timestamp AT TIME ZONE 'Asia/Kathmandu')`;
const TO_TS = `($3::date::timestamp AT TIME ZONE 'Asia/Kathmandu')`;
const LOCAL = (ts: string) => `(${ts} AT TIME ZONE 'Asia/Kathmandu')::date`;

/** Straight copy of `view` (shared columns `cols`, summed per business_date). */
const straight = (view: string, cols: string[]) => `SELECT business_date, ${cols.map((c) => `sum(${c}) AS ${c}`).join(', ')} FROM ${view} WHERE tenant_id = $1 AND ${BD} GROUP BY 1`;
const stamps = (view: string, ts: string, extra: string) => `SELECT ${LOCAL(ts)} AS business_date FROM ${view} WHERE tenant_id = $1 AND ${ts} >= ${FROM_TS} AND ${ts} < ${TO_TS}${extra}`;

interface R3 { cols: string[]; rollup?: string; view: string }
const SPECIMEN = 'lab.v_pub_specimen_timeline', TAT_VIEW = 'reporting.v_pub_order_report_tat';
const SPEC_LEG = (k: string, ts: string) => `SELECT ${LOCAL(ts)} AS business_date, '${k}' AS k FROM ${SPECIMEN} WHERE tenant_id = $1 AND ${ts} >= ${FROM_TS} AND ${ts} < ${TO_TS} AND parent_specimen_id IS NULL`;
const TAT_LEG = stamps;

// Source of every family (TRD §9.1 / refresh.repo.ts). tat/specimens/releases are re-derived from the timestamps the same way the refresh does.
const R3_SPECS: Record<string, R3> = {
  orders: { cols: ['orders_registered', 'patients_distinct', 'new_patients', 'urgent_orders', 'cancelled_orders', 'opd_orders', 'ipd_orders'], view: straight('frontdesk.v_pub_order_daily', ['orders_registered', 'patients_distinct', 'new_patients', 'urgent_orders', 'cancelled_orders', 'opd_orders', 'ipd_orders']) },
  centre_volume: { cols: ['orders', 'patients_distinct', 'order_items'], view: straight('frontdesk.v_pub_centre_volume', ['orders', 'patients_distinct', 'order_items']) },
  referrer_volume: { cols: ['orders', 'patients_distinct', 'order_items'], view: straight('frontdesk.v_pub_referrer_volume', ['orders', 'patients_distinct', 'order_items']) },
  income: { cols: ['invoices_issued', 'invoices_cancelled', 'gross_paisa', 'discount_paisa', 'exempt_paisa', 'taxable_paisa', 'vat_paisa', 'other_tax_paisa', 'net_paisa', 'credit_notes_paisa'], view: straight('billing.v_pub_invoice_daily', ['invoices_issued', 'invoices_cancelled', 'gross_paisa', 'discount_paisa', 'exempt_paisa', 'taxable_paisa', 'vat_paisa', 'other_tax_paisa', 'net_paisa', 'credit_notes_paisa']) },
  department_income: { cols: ['line_count', 'gross_paisa', 'discount_paisa', 'net_paisa'], view: straight('billing.v_pub_department_income', ['line_count', 'gross_paisa', 'discount_paisa', 'net_paisa']) },
  collections: { cols: ['entries', 'reversals', 'gross_collected_paisa', 'reversed_paisa', 'net_collected_paisa'], view: straight('billing.v_pub_payment_collection', ['entries', 'reversals', 'gross_collected_paisa', 'reversed_paisa', 'net_collected_paisa']) },
  referrer_billing: { cols: ['orders', 'net_billed_paisa'], view: straight('billing.v_pub_referrer_billing', ['orders', 'net_billed_paisa']) },
  results: { cols: ['results_resulted', 'results_verified', 'results_approved', 'results_amended', 'auto_verified', 'critical_count', 'abnormal_count', 'tests_approved'], view: straight('lab.v_pub_result_daily', ['results_resulted', 'results_verified', 'results_approved', 'results_amended', 'auto_verified', 'critical_count', 'abnormal_count', 'tests_approved']) },
  specimens: {
    cols: ['collected', 'received', 'rejected'],
    view: `SELECT business_date, count(*) FILTER (WHERE k = 'c') AS collected, count(*) FILTER (WHERE k = 'r') AS received, count(*) FILTER (WHERE k = 'x') AS rejected
FROM (${SPEC_LEG('c', 'collected_at')} UNION ALL ${SPEC_LEG('r', 'received_at')} UNION ALL ${SPEC_LEG('x', 'rejected_at')}) s GROUP BY 1`,
  },
  rejections: { cols: ['rejections', 'recollections_ordered'], view: straight('lab.v_pub_rejection_daily', ['rejections', 'recollections_ordered']) },
  critical_values: { cols: ['detected', 'notified'], view: straight('lab.v_pub_critical_value_daily', ['detected', 'notified']) },
  tat: {
    cols: ['facts'], rollup: `SELECT business_date, count(*) AS facts FROM analytics.tat_facts WHERE tenant_id = $1 AND ${BD} GROUP BY 1`,
    view: `SELECT business_date, count(*) AS facts FROM (
${TAT_LEG(SPECIMEN, 'received_at', ' AND collected_at IS NOT NULL AND rejected_at IS NULL AND parent_specimen_id IS NULL')}
UNION ALL ${TAT_LEG(SPECIMEN, 'received_at', ' AND in_transit_at IS NOT NULL AND rejected_at IS NULL AND parent_specimen_id IS NULL')}
UNION ALL ${TAT_LEG(SPECIMEN, 'first_verified_at', ' AND received_at IS NOT NULL AND rejected_at IS NULL AND parent_specimen_id IS NULL')}
UNION ALL ${TAT_LEG(TAT_VIEW, 'first_released_at', ' AND registered_at IS NOT NULL')}
UNION ALL ${TAT_LEG(TAT_VIEW, 'final_released_at', ' AND registered_at IS NOT NULL AND total_tat_seconds IS NOT NULL')}) t GROUP BY 1`,
  },
  releases: { cols: ['released'], view: `SELECT ${LOCAL('released_at')} AS business_date, count(*) AS released FROM reporting.v_pub_report_release WHERE tenant_id = $1 AND released_at >= ${FROM_TS} AND released_at < ${TO_TS} GROUP BY 1` },
  deliveries: { cols: ['queued', 'sent', 'delivered', '"read"', 'failed', 'suppressed'], view: straight('reporting.v_pub_delivery_daily', ['queued', 'sent', 'delivered', '"read"', 'failed', 'suppressed']) },
  interface_messages: { cols: ['messages', 'patient_records', 'qc_records', 'unmatched', 'quarantined', 'duplicates'], view: straight('instruments.v_pub_message_daily', ['messages', 'patient_records', 'qc_records', 'unmatched', 'quarantined', 'duplicates']) },
};

/** Full outer join of two per-date aggregates; returns the dates whose columns differ (NULL = 0). */
const compare = (r: string, v: string, cols: string[]) => `WITH r AS (${r}),
v AS (${v})
SELECT coalesce(r.business_date, v.business_date)::text AS business_date FROM r FULL JOIN v ON v.business_date = r.business_date
WHERE (${cols.map((c) => `coalesce(r.${c}, 0)`).join(', ')}) IS DISTINCT FROM (${cols.map((c) => `coalesce(v.${c}, 0)`).join(', ')}) ORDER BY 1`;

const r3 = (family: Family, s: R3): string =>
  compare(s.rollup ?? `SELECT business_date, ${s.cols.map((c) => `sum(${c}) AS ${c}`).join(', ')} FROM analytics.${FAMILY_TABLE[family]} WHERE tenant_id = $1 AND ${BD} GROUP BY 1`, s.view, s.cols);

// R2: Σ over departments of net == income net, per date.
const R2_SQL = compare(
  `SELECT business_date, sum(net_paisa) AS net_paisa FROM analytics.daily_department_income WHERE tenant_id = $1 AND ${BD} GROUP BY 1`,
  `SELECT business_date, sum(net_paisa) AS net_paisa FROM analytics.daily_income WHERE tenant_id = $1 AND ${BD} GROUP BY 1`, ['net_paisa']);

// R4: Σ_method = Σ_staff = Σ_centre of net_collected (NULL keys included, each total taken over its own grouping).
const BY = (col: string) => `SELECT business_date, sum(s) AS t FROM (SELECT business_date, ${col}, sum(net_collected_paisa) AS s FROM analytics.daily_collections WHERE tenant_id = $1 AND ${BD} GROUP BY 1, 2) g GROUP BY 1`;
const R4_SQL = `WITH m AS (${BY('payment_method_code')}), s AS (${BY('collected_by_membership_id')}), c AS (${BY('centre_id')})
SELECT coalesce(m.business_date, s.business_date, c.business_date)::text AS business_date
FROM m FULL JOIN s ON s.business_date = m.business_date FULL JOIN c ON c.business_date = coalesce(m.business_date, s.business_date)
WHERE (coalesce(m.t, 0), coalesce(s.t, 0)) IS DISTINCT FROM (coalesce(c.t, 0), coalesce(c.t, 0)) ORDER BY 1`;

const CHECKS: readonly { rule: 'R2' | 'R3' | 'R4'; family: Family; sql: string; remark: readonly Family[] }[] = [
  ...DATED_FAMILIES.map((family) => ({ rule: 'R3' as const, family, sql: r3(family, R3_SPECS[family]!), remark: [family] as readonly Family[] })),
  { rule: 'R2', family: 'department_income', sql: R2_SQL, remark: ['income', 'department_income'] },
  { rule: 'R4', family: 'collections', sql: R4_SQL, remark: ['collections'] },
];

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const selfCheckTask: TaskHandler = async (payload, ctx) => {
  const tenantId = jobTenant(payload, ctx, 'analytics.self_check');
  const { today } = localNow(ctx);
  const [from, to] = [addDays(today, -DAYS), today];
  const marked = new Set<string>();
  for (const { rule, family, sql, remark } of CHECKS) {
    const rows: { business_date: unknown }[] = (await ctx.tx.query(sql, [tenantId, from, to])).rows;
    const dates = [...new Set(rows.map((r) => String(r.business_date)))].filter((d) => ISO.test(d) && d >= from && d < to);
    if (dates.length === 0) continue;
    (ctx as any).metrics.inc(METRIC, { rule, family });
    for (const businessDate of dates) {
      ctx.log.warn({ event: 'reconciliation_mismatch', rule, family, business_date: businessDate });
      for (const f of remark) {
        if (marked.has(`${f}|${businessDate}`)) continue;
        marked.add(`${f}|${businessDate}`);
        await markDirty(ctx.tx, { tenantId, family: f, businessDate, reason: 'self_check', actorId: ctx.actor.id });
      }
    }
  }
  if (marked.size > 0) {   // debounced like the event consumers: one pending refresh per tenant
    await ctx.tx.query(`SELECT app.enqueue_job('analytics.refresh_tenant', $1::jsonb, $2, now() + interval '60 seconds', 5)`, [JSON.stringify({ tenant_id: tenantId }), `analytics.refresh_tenant:${tenantId}`]);
  }
};
