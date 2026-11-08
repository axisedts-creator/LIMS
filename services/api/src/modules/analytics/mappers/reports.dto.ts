// Explicit field allow-lists for the report bodies (02-TRD §3.2 mappers, §5.1; 07-SECURITY REQ-SEC-081, P13).
// Nothing is spread from a service/SQL row: a column that is not listed here cannot reach a response. No field is named "commission".
import type { Period } from '../domain/period.js';
import type { Scope } from '../domain/scope.js';
import {
  INCOME_MONEY, VOLUME_MONEY, type CollectionsOutRow, type CollectionsTotals, type DepartmentOutRow, type DepartmentTotals, type IncomeOutRow, type IncomeTotals,
  type TopCentreOutRow, type TopReferrerOutRow, type VolumeOutRow, type VolumeTotals,
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
