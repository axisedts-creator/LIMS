// Report registry (02-TRD §3.3). Frozen data. D-44/B13: per-referrer money (net_billed_paisa) lives only in referral_incentive.
import { LimsError } from '../../../core/errors.js';
import type { AnalyticsPermission } from '../permissions.js';
import type { Family } from './families.js';

export interface ReportDef {
  readonly code: string;
  readonly permission: AnalyticsPermission; // gate of the report; export/schedule actions have their own permissions
  readonly families: readonly Family[];
  readonly liveSources: readonly string[];
  readonly exportable: boolean;
  readonly schedulable: boolean;
  readonly flag?: string;
  readonly exportColumns: readonly string[]; // [CONV] wire names (snake_case) of the export table; money as *_paisa, ratios *_bp, durations *_seconds
}

const DASH = 'analytics.dashboard.read';
const KL = ['key', 'label'];

const def = (
  code: string, permission: AnalyticsPermission, families: Family[], exportColumns: string[],
  o: { liveSources?: string[]; schedulable?: boolean; flag?: string } = {},
): [string, ReportDef] => [code, Object.freeze({
  code, permission,
  families: Object.freeze(families),
  liveSources: Object.freeze(o.liveSources ?? []),
  exportable: true,
  schedulable: o.schedulable ?? true,
  ...(o.flag ? { flag: o.flag } : {}),
  exportColumns: Object.freeze(exportColumns),
})];

const ENTRIES = [
  def('dashboard', DASH, ['orders', 'centre_volume', 'income', 'collections', 'results', 'report_backlog'],
    ['metric', 'label', 'value', 'previous_value', 'delta_bp'], { liveSources: ['pending_items'] }),
  def('income', DASH, ['income'], [...KL, 'label_bs', 'invoices_issued', 'invoices_cancelled', 'gross_paisa', 'discount_paisa', 'exempt_paisa',
    'taxable_paisa', 'vat_paisa', 'other_tax_paisa', 'invoiced_paisa', 'credit_notes_paisa', 'net_sales_paisa']),
  def('department_income', DASH, ['department_income'], [...KL, 'gross_paisa', 'discount_paisa', 'net_paisa', 'share_bp']),
  def('collections', 'analytics.collections.read', ['collections'], [...KL, 'gross_collected_paisa', 'reversed_paisa', 'net_collected_paisa']),
  def('volume', DASH, ['orders', 'centre_volume'], [...KL, 'orders_registered', 'orders_cancelled', 'net_orders']),
  def('top_referrers', DASH, ['referrer_volume'], [...KL, 'orders_registered', 'orders_cancelled', 'net_orders', 'share_bp']), // volume only (D-44)
  def('top_centres', DASH, ['centre_volume', 'income'], [...KL, 'orders_registered', 'net_orders', 'net_sales_paisa']),
  def('referral_incentive', 'analytics.referral_report.read', ['referrer_volume', 'referrer_billing'],
    [...KL, 'orders_registered', 'net_billed_paisa'], { flag: 'referralIncentiveReportEnabled' }),
  def('tests_done', DASH, ['results'], [...KL, 'tests_verified', 'tests_approved', 'tests_amended']),
  def('tat', DASH, ['tat'], ['segment', ...KL, 'n', 'median_seconds', 'p90_seconds', 'max_seconds', 'anomalies']),
  def('pending_tests', DASH, ['report_backlog'], [...KL, 'pending_count', 'oldest_pending_seconds'], { liveSources: ['pending_items'] }), // no patient identifiers
  def('quality_indicators', DASH, ['rejections', 'specimens', 'critical_values'],
    [...KL, 'specimens_received', 'specimens_rejected', 'rejection_rate_bp', 'critical_values_detected']),
  def('delivery', DASH, ['deliveries', 'releases'], [...KL, 'reports_released', 'deliveries_created', 'deliveries_delivered', 'deliveries_failed']),
  def('interfaces', DASH, ['interface_messages'], [...KL, 'messages_received', 'messages_failed', 'error_rate_bp'],
    { liveSources: ['agent_status'], schedulable: false }),
];

export const REPORT_REGISTRY: Readonly<Record<string, ReportDef>> = Object.freeze(Object.fromEntries(ENTRIES));
export const REPORT_CODES: readonly string[] = Object.freeze(ENTRIES.map(([code]) => code));

/** requiredPermission on the staff recipient of every scheduled pack (08 A7.6); other report permissions only decide omission. */
export const SCHEDULE_REQUIRED_PERMISSION = 'analytics.dashboard.read' as const;

/** Exact, case-sensitive; unknown (incl. prototype keys, non-strings) -> 404 analytics.report_unknown. */
export function getReport(code: string): ReportDef {
  if (typeof code !== 'string' || !Object.hasOwn(REPORT_REGISTRY, code)) throw new LimsError('analytics.report_unknown');
  return REPORT_REGISTRY[code]!;
}
