// Explicit field allow-lists for the report bodies (02-TRD §3.2 mappers, §5.1; 07-SECURITY REQ-SEC-081, P13).
// Nothing is spread from a service/SQL row: a column that is not listed here cannot reach a response. No payout or rate field exists (PRD US-07.3).
import type { Period } from '../domain/period.js';
import type { Scope } from '../domain/scope.js';
import type { Freshness } from '../domain/freshness.js';
import type { ReferralRow, ReferralTotals } from '../service/referral.service.js';
import { RELEASE_COLS, DELIVERY_COLS, RESULT_COLS } from '../domain/columns.js';
import type { PendingItemOut, PendingSummaryOut } from '../service/pending.service.js';
import {
  INCOME_MONEY, VOLUME_MONEY, type CollectionsOutRow, type CollectionsTotals, type DepartmentOutRow, type DepartmentTotals, type IncomeOutRow, type IncomeTotals,
  type TopCentreOutRow, type TopReferrerOutRow, type VolumeOutRow, type VolumeTotals,
  type DeliveryOutRow, type DeliveryTotals, type InstrumentOutRow, type QualityOut, type ReleaseOutRow, type ReleaseTotals, type TatOutRow, type TestsDoneRow, type TestsDoneTotals,
} from '../service/reports.service.js';

export interface ReportMeta { readonly period: Period; readonly scope: Scope; readonly generatedAt: string }

function envelope(reportCode: string, m: ReportMeta) {
  return {
    report_code: reportCode,
    period: {
      business_date_from: m.period.from, business_date_to: m.period.to, days: m.period.days, label_ad: m.period.labelAd, label_bs: m.period.labelBs,
      ...(m.period.bsMonth ? { bs_month: m.period.bsMonth } : {}),
      ...(m.period.fiscalYearBs ? { fiscal_year_bs: m.period.fiscalYearBs } : {}),
      timezone: 'Asia/Kathmandu' as const,
    },
    scope: { all_centres: m.scope.all, centre_ids: m.scope.all ? [] : [...m.scope.centreIds], tenant_wide_sections_hidden: [] as string[] }, // no Phase-1 tenant-wide family (TRD §4.4)
    freshness: [] as object[], // [CONV] filled by the freshness service (AN-T04); empty until that source exists
    generated_at: m.generatedAt,
  };
}

const incomeMoney = (r: IncomeTotals) => Object.fromEntries(INCOME_MONEY.map((k) => [k, r[k]])) as IncomeTotals;

export function toIncomeReportDto(m: ReportMeta, out: { rows: readonly IncomeOutRow[]; totals: IncomeTotals }) {
  return {
    ...envelope('income', m),
    rows: out.rows.map((r) => ({
      key: r.key, label: r.label,
      ...(r.label_bs ? { label_bs: r.label_bs } : {}),
      ...(r.is_inactive ? { is_inactive: true } : {}),
      ...incomeMoney(r),
    })),
    totals: incomeMoney(out.totals),
    basis_note_key: 'analytics.income.basis_note',
  };
}

const pickKeys = <K extends string>(o: Record<K, number>, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, o[k]])) as Record<K, number>;
const rowHead = (r: { key: string; label: string; label_bs?: string | undefined; is_inactive?: true | undefined }) =>
  ({ key: r.key, label: r.label, ...(r.label_bs ? { label_bs: r.label_bs } : {}), ...(r.is_inactive ? { is_inactive: true } : {}) });

export function toVolumeReportDto(m: ReportMeta, out: { rows: readonly VolumeOutRow[]; totals: VolumeTotals }) {
  return {
    ...envelope('volume', m),
    rows: out.rows.map((r) => ({ ...rowHead(r), ...pickKeys(r, VOLUME_MONEY) })),
    totals: pickKeys(out.totals, VOLUME_MONEY),
  };
}

export function toTopCentresReportDto(m: ReportMeta, out: { rows: readonly TopCentreOutRow[]; totals: Record<'orders' | 'patient_visits' | 'tests_ordered' | 'net_sales_paisa', number> }) {
  return {
    ...envelope('top_centres', m),
    rows: out.rows.map((r) => ({
      rank: r.rank, centre_id: r.centre_id, label: r.label, branch_id: r.branch_id, orders: r.orders, patient_visits: r.patient_visits,
      tests_ordered: r.tests_ordered, net_sales_paisa: r.net_sales_paisa,
      by_mode: { walk_in: r.by_mode.walk_in, home: r.by_mode.home, centre: r.by_mode.centre, partner: r.by_mode.partner },
    })),
    totals: { orders: out.totals.orders, patient_visits: out.totals.patient_visits, tests_ordered: out.totals.tests_ordered, net_sales_paisa: out.totals.net_sales_paisa },
  };
}

/** Volume only (D-44): the allow-list below has no money field. */
export function toTopReferrersReportDto(m: ReportMeta, out: { rows: readonly TopReferrerOutRow[]; totals: Record<'orders' | 'patient_visits' | 'tests_ordered', number> }) {
  return {
    ...envelope('top_referrers', m),
    rows: out.rows.map((r) => ({
      rank: r.rank, ...(r.referrer_id ? { referrer_id: r.referrer_id } : {}), label: r.label, is_self: r.is_self, is_inactive: r.is_inactive,
      orders: r.orders, patient_visits: r.patient_visits, tests_ordered: r.tests_ordered,
    })),
    totals: { orders: out.totals.orders, patient_visits: out.totals.patient_visits, tests_ordered: out.totals.tests_ordered },
  };
}

const COLL = ['entries', 'reversals', 'gross_collected_paisa', 'reversed_paisa', 'net_collected_paisa'] as const;
export function toCollectionsReportDto(m: ReportMeta, out: { rows: readonly CollectionsOutRow[]; totals: CollectionsTotals; dailyCashRouteId?: 'staff.billing.daily_cash' | undefined }) {
  return {
    ...envelope('collections', m),
    rows: out.rows.map((r) => ({ ...rowHead(r), ...pickKeys(r, COLL) })),
    totals: pickKeys(out.totals, COLL),
    ...(out.dailyCashRouteId ? { daily_cash_route_id: out.dailyCashRouteId } : {}),
  };
}

export function toDepartmentIncomeReportDto(m: ReportMeta, out: { rows: readonly DepartmentOutRow[]; totals: DepartmentTotals; reconcilesWithIncome: boolean }) {
  return {
    ...envelope('department_income', m),
    rows: out.rows.map((r) => ({
      key: r.key, label: r.label,
      ...(r.is_inactive ? { is_inactive: true } : {}),
      ...(r.department_id ? { department_id: r.department_id } : {}),
      is_multiple: r.is_multiple,
      ...(r.period_key ? { period_key: r.period_key } : {}),
      line_count: r.line_count, gross_paisa: r.gross_paisa, discount_paisa: r.discount_paisa, net_paisa: r.net_paisa, share_bp: r.share_bp,
    })),
    totals: { line_count: out.totals.line_count, gross_paisa: out.totals.gross_paisa, discount_paisa: out.totals.discount_paisa, net_paisa: out.totals.net_paisa },
    reconciles_with_income: out.reconcilesWithIncome,
  };
}

/** AN-T10: the only body with net_billed_paisa (D-44). SELF rows carry no net_billed_paisa; no rate, share or payout field exists (US-07.3/.4). */
export function toReferralIncentiveReportDto(
  m: ReportMeta,
  out: { rows: readonly ReferralRow[]; totals: ReferralTotals; freshness: readonly Freshness[]; limit: number; nextCursor?: string | undefined },
) {
  return {
    ...envelope('referral_incentive', m),
    freshness: out.freshness.map((f) => ({
      family: f.family, ...(f.refreshed_at ? { refreshed_at: f.refreshed_at } : {}), is_stale: f.is_stale, ...(f.stale_reason ? { stale_reason: f.stale_reason } : {}), live: f.live,
    })),
    rows: out.rows.map((r) => ({
      ...(r.referrer_id ? { referrer_id: r.referrer_id } : {}), label: r.label, is_self: r.is_self,
      ...(r.period_key ? { period_key: r.period_key } : {}), ...(r.period_label ? { period_label: r.period_label } : {}),
      orders: r.orders, patient_visits: r.patient_visits, tests_ordered: r.tests_ordered,
      ...(r.is_self || r.net_billed_paisa === undefined ? {} : { net_billed_paisa: r.net_billed_paisa }),
    })),
    totals: { orders: out.totals.orders, patient_visits: out.totals.patient_visits, tests_ordered: out.totals.tests_ordered, net_billed_paisa: out.totals.net_billed_paisa },
    billed_note_key: 'analytics.referrers.billed_note',
    page: { limit: out.limit, ...(out.nextCursor ? { next_cursor: out.nextCursor } : {}) },
  };
}

// ------------------------------------------------------------------ AN-T11
const pickOf = <K extends string>(r: Record<K, number>, keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, r[k]])) as Record<K, number>;
const head = (r: { key: string; label: string; label_bs?: string | undefined; is_inactive?: true | undefined }) => ({
  key: r.key, label: r.label, ...(r.label_bs ? { label_bs: r.label_bs } : {}), ...(r.is_inactive ? { is_inactive: true } : {}),
});

export function toTestsDoneReportDto(m: ReportMeta, out: { rows: readonly TestsDoneRow[]; totals: TestsDoneTotals }) {
  return {
    ...envelope('tests_done', m),
    rows: out.rows.map((r) => ({ ...head(r), ...pickOf(r, RESULT_COLS) })),
    totals: pickOf(out.totals, RESULT_COLS),
  };
}

export function toQualityIndicatorsReportDto(m: ReportMeta, out: QualityOut) {
  const cv = out.criticalValues;
  return {
    ...envelope('quality_indicators', m),
    rejections: {
      rows: out.rejections.rows.map((r) => ({
        ...head(r), rejections: r.rejections, recollections_ordered: r.recollections_ordered, specimens_received: r.specimens_received, per_100_received_bp: r.per_100_received_bp,
      })),
      totals: {
        rejections: out.rejections.totals.rejections, recollections_ordered: out.rejections.totals.recollections_ordered,
        specimens_received: out.rejections.totals.specimens_received, per_100_received_bp: out.rejections.totals.per_100_received_bp,
      },
    },
    critical_values: {
      rows: cv.rows.map((r) => ({
        business_date: r.business_date, detected: r.detected, notified: r.notified, notified_bp: r.notified_bp,
        ...(r.median_notify_seconds === undefined ? {} : { median_notify_seconds: r.median_notify_seconds }),
        ...(r.max_notify_seconds === undefined ? {} : { max_notify_seconds: r.max_notify_seconds }),
      })),
      totals: {
        detected: cv.totals.detected, notified: cv.totals.notified, notified_bp: cv.totals.notified_bp,
        ...(cv.totals.max_notify_seconds === undefined ? {} : { max_notify_seconds: cv.totals.max_notify_seconds }),
      },
    },
  };
}

export function toDeliveryReportDto(
  m: ReportMeta,
  out: { deliveries: { rows: readonly DeliveryOutRow[]; totals: DeliveryTotals }; releases: { rows: readonly ReleaseOutRow[]; totals: ReleaseTotals } },
) {
  const dKeys = [...DELIVERY_COLS, 'failure_share_bp'] as const;
  return {
    ...envelope('delivery', m),
    deliveries: { rows: out.deliveries.rows.map((r) => ({ ...head(r), ...pickOf(r, dKeys) })), totals: pickOf(out.deliveries.totals, dKeys) },
    releases: { rows: out.releases.rows.map((r) => ({ ...head(r), ...pickOf(r, RELEASE_COLS) })), totals: pickOf(out.releases.totals, RELEASE_COLS) },
  };
}

export function toTatReportDto(m: ReportMeta, out: { rows: readonly TatOutRow[]; segments: readonly string[] }) {
  return {
    ...envelope('tat', m),
    rows: out.rows.map((r) => ({
      segment: r.segment,
      ...(r.key === undefined ? {} : { key: r.key }), ...(r.label === undefined ? {} : { label: r.label }),
      n: r.n,
      ...(r.median_seconds === undefined ? {} : { median_seconds: r.median_seconds }),
      ...(r.p90_seconds === undefined ? {} : { p90_seconds: r.p90_seconds }),
      ...(r.max_seconds === undefined ? {} : { max_seconds: r.max_seconds }),
      anomalies: r.anomalies,
    })),
    segment_definitions: out.segments.map((s) => ({ segment: s, start_label_key: `analytics.tat.${s}.start`, stop_label_key: `analytics.tat.${s}.stop` })),
  };
}

// ------------------------------------------------------------------ AN-T13 (no period: live + snapshot)
export function toPendingSummaryDto(m: { scope: Scope; generatedAt: string }, o: PendingSummaryOut) {
  const b = o.backlog;
  return {
    report_code: 'pending_tests',
    scope: { all_centres: m.scope.all, centre_ids: m.scope.all ? [] : [...m.scope.centreIds], tenant_wide_sections_hidden: [] as string[] },
    freshness: [{ family: 'pending_items', refreshed_at: m.generatedAt, is_stale: false, live: true }], // US-16.3; [CONV] report_backlog freshness joins with the freshness service
    generated_at: m.generatedAt,
    total: o.total, overdue: o.overdue, no_target: o.no_target,
    by_status: o.by_status.map((s) => ({ item_status: s.item_status, count: s.count })),
    by_priority: o.by_priority.map((s) => ({ priority: s.priority, count: s.count })),
    by_department: o.by_department.map((d) => ({ department_id: d.department_id, label: d.label, count: d.count, overdue: d.overdue })),
    by_age_bucket: o.by_age_bucket.map((s) => ({ bucket: s.bucket, count: s.count })),
    backlog: {
      reports_pending: b.reports_pending, awaiting_results: b.awaiting_results, ready_unreleased: b.ready_unreleased,
      ...(b.oldest_registered_at === undefined ? {} : { oldest_registered_at: b.oldest_registered_at }),
      by_centre: b.by_centre.map((c) => ({ centre_id: c.centre_id, label: c.label, reports_pending: c.reports_pending, awaiting_results: c.awaiting_results, ready_unreleased: c.ready_unreleased })),
    },
    age_anchor_note_key: 'analytics.pending.age_anchor',
  };
}

export function toPendingItemsDto(out: { rows: readonly PendingItemOut[]; limit: number; nextCursor?: string | undefined; openRouteId?: 'staff.lab.order_results' | undefined }) {
  return {
    data: out.rows.map((r) => ({
      order_item_id: r.order_item_id, order_id: r.order_id, centre_id: r.centre_id,
      ...(r.processing_branch_id === undefined ? {} : { processing_branch_id: r.processing_branch_id }),
      department_id: r.department_id, test_id: r.test_id, test_code: r.test_code, test_label: r.test_label, priority: r.priority, item_status: r.item_status,
      age_seconds: r.age_seconds, ...(r.tat_target_seconds === undefined ? {} : { tat_target_seconds: r.tat_target_seconds }), is_overdue: r.is_overdue,
      ...(out.openRouteId ? { open_route_id: out.openRouteId } : {}), // only for a holder of lab.result.read
    })),
    page: { limit: out.limit, ...(out.nextCursor ? { next_cursor: out.nextCursor } : {}) },
  };
}

export function toInterfacesReportDto(
  m: ReportMeta,
  out: { instruments: readonly InstrumentOutRow[]; agents: { by_state: readonly { state: string; count: number }[]; agents: readonly {
    agent_id: string; centre_id: string; state: string; last_heartbeat_at: string; agent_version: string; queue_depth: number }[] } },
) {
  return {
    ...envelope('interfaces', m),
    instruments: out.instruments.map((r) => ({
      instrument_id: r.instrument_id,
      ...(r.instrument_code === undefined ? {} : { instrument_code: r.instrument_code }),
      ...(r.label === undefined ? {} : { label: r.label }),
      ...(r.is_active === undefined ? {} : { is_active: r.is_active }),
      centre_id: r.centre_id,
      messages: r.messages, patient_records: r.patient_records, qc_records: r.qc_records, unmatched: r.unmatched, quarantined: r.quarantined, duplicates: r.duplicates,
    })),
    agents: {
      by_state: out.agents.by_state.map((s) => ({ state: s.state, count: s.count })),
      agents: out.agents.agents.map((x) => ({
        agent_id: x.agent_id, centre_id: x.centre_id, state: x.state, last_heartbeat_at: x.last_heartbeat_at, agent_version: x.agent_version, queue_depth: x.queue_depth,
      })),
    },
  };
}

// ------------------------------------------------------------------ AN-T14 (TRD §5.1 DashboardDto, Freshness): explicit picks, no spread of service rows.
export const toFreshnessDto = (f: Freshness) => ({
  family: f.family, ...(f.refreshed_at ? { refreshed_at: f.refreshed_at } : {}), is_stale: f.is_stale, ...(f.stale_reason ? { stale_reason: f.stale_reason } : {}), live: f.live,
});

export function toDashboardDto(m: ReportMeta, out: import('../service/dashboard.service.js').DashboardOut) {
  return {
    ...envelope('dashboard', m),
    freshness: out.freshness.map(toFreshnessDto),
    tiles: Object.fromEntries(Object.entries(out.tiles).map(([k, t]) => [k, {
      value: t.value, ...(t.previous === undefined ? {} : { previous: t.previous, delta: t.delta }), ...(t.delta_bp === undefined ? {} : { delta_bp: t.delta_bp }), unit: t.unit,
    }])),
    series: { days: out.series.map((d) => ({ business_date: d.business_date, net_sales_paisa: d.net_sales_paisa, patient_visits: d.patient_visits, net_orders: d.net_orders })) },
    department_top: out.departmentTop.map((r) => ({
      ...(r.department_id ? { department_id: r.department_id } : {}), label: r.label, is_multiple: r.is_multiple, net_paisa: r.net_paisa, share_bp: r.share_bp,
    })),
  };
}
