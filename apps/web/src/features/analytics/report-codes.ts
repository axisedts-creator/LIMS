// AN-T20: report codes (05-SCHEMA §analytics.g_cs_report_codes seed order) with display names and the session permission that reads each one.
// Plain module: used by server pages and client components alike.
export interface ReportCode { code: string; label: string; permission: string; schedulable: boolean }

export const REPORT_CODES: readonly ReportCode[] = [
  { code: 'dashboard', label: 'Dashboard', permission: 'analytics.dashboard.read', schedulable: true },
  { code: 'income', label: 'Income', permission: 'analytics.dashboard.read', schedulable: true },
  { code: 'department_income', label: 'Department income', permission: 'analytics.dashboard.read', schedulable: true },
  { code: 'collections', label: 'Collections', permission: 'analytics.collections.read', schedulable: true },
  { code: 'volume', label: 'Volume', permission: 'analytics.dashboard.read', schedulable: true },
  { code: 'top_referrers', label: 'Top referrers', permission: 'analytics.dashboard.read', schedulable: true },
  { code: 'top_centres', label: 'Top centres', permission: 'analytics.dashboard.read', schedulable: true },
  { code: 'referral_incentive', label: 'Referral business report', permission: 'analytics.referral_report.read', schedulable: true },
  { code: 'tests_done', label: 'Tests done', permission: 'analytics.dashboard.read', schedulable: true },
  { code: 'tat', label: 'Turnaround time (TAT)', permission: 'analytics.dashboard.read', schedulable: true },
  { code: 'pending_tests', label: 'Pending tests', permission: 'analytics.dashboard.read', schedulable: true },
  { code: 'quality_indicators', label: 'Quality indicators', permission: 'analytics.dashboard.read', schedulable: true },
  { code: 'delivery', label: 'Delivery', permission: 'analytics.dashboard.read', schedulable: true },
  { code: 'interfaces', label: 'Instrument interfaces', permission: 'analytics.dashboard.read', schedulable: false },
];

export const reportLabel = (code: string): string => REPORT_CODES.find((r) => r.code === code)?.label ?? code.replace(/_/g, ' ');

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
