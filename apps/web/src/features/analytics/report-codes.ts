// AN-T20: report codes (05-SCHEMA §analytics.g_cs_report_codes seed order) with display names and the session permission that reads each one.
// Plain module: used by server pages and client components alike.
export interface ReportCode { code: string; label: string; permission: string; schedulable: boolean }

const BASE_CODES: readonly ReportCode[] = [
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

// ------------------------------------------------------------------ T0D-MISREPORTS-1 (LD-321, LD-342 / A39, LD-357)
// The 11 MIS definitions of contracts/openapi/analytics.yaml x-report-definitions, copied verbatim (code, title, permission, params, columns).
// The *_id columns are left out: ids are never printed (07-SECURITY). Every definition is exportable and schedulable in the contract.
// A39-3: the commission / TDS words live only in the two_level_commission and tds rows below (web catalogue label).
export type MisColType = 'string' | 'integer' | 'integer_paisa' | 'basis_points' | 'date' | 'datetime';
export interface MisColumn { name: string; title: string; type: MisColType }
export interface MisReport { code: string; title: string; permission: string; params: readonly string[]; columns: readonly MisColumn[] }
const col = (name: string, type: MisColType, title: string): MisColumn => ({ name, type, title });
const P = ['business_date_from', 'business_date_to', 'centre_id'] as const;
export const MIS_REPORTS: readonly MisReport[] = [
  { code: 'bill_of_the_day', title: 'Bill of the Day', permission: 'analytics.collections.read', params: [...P, 'party_id'],
    columns: [col('invoice_number', 'string', 'Invoice number'), col('billed_at', 'datetime', 'Billed at'), col('business_date', 'date', 'Business date'), col('gross_paisa', 'integer_paisa', 'Gross'), col('discount_paisa', 'integer_paisa', 'Discount'), col('net_paisa', 'integer_paisa', 'Net'), col('paid_paisa', 'integer_paisa', 'Paid'), col('due_paisa', 'integer_paisa', 'Due')] },
  { code: 'two_level_commission', title: 'Two level commission', permission: 'analytics.referral_report.read', params: [...P, 'party_id'],
    columns: [col('parent_party_name', 'string', 'Parent party name'), col('party_name', 'string', 'Sub party name'), col('level', 'integer', 'Level'), col('orders_registered', 'integer', 'Orders'), col('net_billed_paisa', 'integer_paisa', 'Net billed'), col('commission_bp', 'basis_points', 'Commission rate'), col('commission_paisa', 'integer_paisa', 'Commission')] },
  { code: 'sales_representative', title: 'Sales representative', permission: 'analytics.dashboard.read', params: [...P, 'representative_id', 'party_id'],
    columns: [col('representative_name', 'string', 'Representative name'), col('designation_level', 'integer', 'Designation level'), col('parties_count', 'integer', 'Parties'), col('orders_registered', 'integer', 'Orders'), col('net_paisa', 'integer_paisa', 'Net'), col('collected_paisa', 'integer_paisa', 'Collected')] },
  { code: 'consultant', title: 'Consultant', permission: 'analytics.dashboard.read', params: [...P, 'referrer_id', 'department_id'],
    columns: [col('referrer_name', 'string', 'Consultant name'), col('orders_registered', 'integer', 'Orders'), col('tests_count', 'integer', 'Tests')] },
  { code: 'collection_boy', title: 'Collection boy', permission: 'analytics.collections.read', params: [...P, 'collector_id'],
    columns: [col('collector_name', 'string', 'Collector name'), col('collections_count', 'integer', 'Collections'), col('pickups_count', 'integer', 'Pickups'), col('collected_paisa', 'integer_paisa', 'Collected'), col('last_activity_at', 'datetime', 'Last activity')] },
  { code: 'repeated_patient', title: 'Repeated patient', permission: 'analytics.dashboard.read', params: [...P, 'min_repeat_count'],
    columns: [col('patient_number', 'string', 'Patient number'), col('visit_count', 'integer', 'Visits'), col('first_visit_date', 'date', 'First visit'), col('last_visit_date', 'date', 'Last visit'), col('net_paisa', 'integer_paisa', 'Net')] },
  { code: 'repeated_test', title: 'Repeated test', permission: 'analytics.dashboard.read', params: [...P, 'department_id', 'min_repeat_count'],
    columns: [col('test_code', 'string', 'Test code'), col('test_name', 'string', 'Test'), col('test_count', 'integer', 'Tests'), col('patients_count', 'integer', 'Patients'), col('repeat_patients_count', 'integer', 'Repeat patients')] },
  { code: 'ipd_opd', title: 'IPD and OPD', permission: 'analytics.dashboard.read', params: [...P, 'visit_type', 'referrer_id', 'party_id'],
    columns: [col('business_date', 'date', 'Business date'), col('visit_type', 'string', 'Patient type'), col('orders_registered', 'integer', 'Orders'), col('tests_count', 'integer', 'Tests'), col('gross_paisa', 'integer_paisa', 'Gross'), col('net_paisa', 'integer_paisa', 'Net')] },
  { code: 'tds', title: 'TDS', permission: 'analytics.referral_report.read', params: [...P, 'party_id'],
    columns: [col('party_name', 'string', 'Party name'), col('period_from', 'date', 'Period from'), col('period_to', 'date', 'Period to'), col('commission_payable_paisa', 'integer_paisa', 'Commission payable'), col('tds_bp', 'basis_points', 'TDS rate'), col('tds_withheld_paisa', 'integer_paisa', 'TDS withheld'), col('net_payable_paisa', 'integer_paisa', 'Net payable')] },
  { code: 'party_billing', title: 'Party billing', permission: 'analytics.collections.read', params: [...P, 'party_id'],
    columns: [col('party_name', 'string', 'Party name'), col('billing_mode', 'string', 'Billing mode'), col('orders_registered', 'integer', 'Orders'), col('gross_paisa', 'integer_paisa', 'Gross'), col('discount_paisa', 'integer_paisa', 'Discount'), col('net_paisa', 'integer_paisa', 'Net'), col('paid_paisa', 'integer_paisa', 'Paid'), col('outstanding_paisa', 'integer_paisa', 'Outstanding')] },
  { code: 'outsource', title: 'Outsource and inter lab transfer', permission: 'analytics.dashboard.read', params: [...P, 'department_id'],
    columns: [col('processing_lab_name', 'string', 'Processing lab name'), col('tests_sent', 'integer', 'Tests sent'), col('tests_resulted', 'integer', 'Tests resulted')] },
];
/** Behind the A39 gate (flag referralIncentiveReportEnabled + analytics.referral_report.read, aal2). */
export const MIS_GATED: readonly string[] = ['two_level_commission', 'tds'];
export const misSlug = (code: string) => code.replace(/_/g, '-');
/** Where a definition opens: Bill of the Day has its own billing screen, the ten others use /analytics/reports/[reportCode]. */
export const misHref = (code: string) => (code === 'bill_of_the_day' ? '/billing/bill-of-the-day' : `/analytics/reports/${misSlug(code)}`);
export const misBySlug = (slug: string) => MIS_REPORTS.find((r) => r.code !== 'bill_of_the_day' && misSlug(r.code) === slug);

export const REPORT_CODES: readonly ReportCode[] = [...BASE_CODES, ...MIS_REPORTS.map((r) => ({ code: r.code, label: r.title, permission: r.permission, schedulable: true }))];

export const reportLabel = (code: string): string => REPORT_CODES.find((r) => r.code === code)?.label ?? code.replace(/_/g, ' ');

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
