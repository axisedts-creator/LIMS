// Explicit field allow-lists for the report bodies (02-TRD §3.2 mappers, §5.1; 07-SECURITY REQ-SEC-081, P13).
// Nothing is spread from a service/SQL row: a column that is not listed here cannot reach a response. No field is named "commission".
import type { Period } from '../domain/period.js';
import type { Scope } from '../domain/scope.js';
import { RELEASE_COLS, DELIVERY_COLS, RESULT_COLS } from '../domain/columns.js';
import {
  INCOME_MONEY, type DeliveryOutRow, type DeliveryTotals, type DepartmentOutRow, type DepartmentTotals, type IncomeOutRow, type IncomeTotals,
  type InstrumentOutRow, type QualityOut, type ReleaseOutRow, type ReleaseTotals, type TestsDoneRow, type TestsDoneTotals,
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
