// Explicit field allow-lists for the report bodies (02-TRD §3.2 mappers, §5.1; 07-SECURITY REQ-SEC-081, P13).
// Nothing is spread from a service/SQL row: a column that is not listed here cannot reach a response. No field is named "commission".
import type { Period } from '../domain/period.js';
import type { Scope } from '../domain/scope.js';
import { INCOME_MONEY, type DepartmentOutRow, type DepartmentTotals, type IncomeOutRow, type IncomeTotals } from '../service/reports.service.js';

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
