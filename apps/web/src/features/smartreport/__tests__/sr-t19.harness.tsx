// C14.T19 shared test harness (tester-owned; not a test file). Builds on the T20 harness (MSW as the API, session/navigation mocks, DOM helpers).
// Each T19 test file registers the same three mocks as T20:
//   vi.mock('next/navigation', async () => (await import('./sr-t20.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./sr-t20.harness')).sessionMock)
// Synthetic data only. Fixtures follow contracts/openapi/smartreport.yaml (SmartSummaryView, CodedSet, Problem).
import { json, routes, show } from './sr-t20.harness';

export * from './sr-t20.harness';

const uid = (n: number) => `01940e00-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const SUMMARY_ID = uid(512);
export const NEWER_ID = uid(513);
export const ORDER_ID = uid(900);
export const CENTRE_ID = uid(901);
export const LIB_ID = uid(902);
export const APPROVER = ['smartreport.summary.read', 'smartreport.summary.approve'];
export const APPROVER_RESULTS = [...APPROVER, 'lab.result.read'];
export const READER = ['smartreport.summary.read'];
export const SUMMARY_PAGE = 'summaries/[summary_id]/page';
export const SUMMARY_URL = `/v1/smartreport/summaries/${SUMMARY_ID}`;
export const APPROVE_URL = `${SUMMARY_URL}/approve`;
export const REJECT_URL = `${SUMMARY_URL}/reject`;
export const REASONS_URL = '/v1/smartreport/coded-sets/summary_reject_reasons';

export const REASONS = { set_code: 'summary_reject_reasons', items: [
  { code: 'wording_problem', display: 'Wording not appropriate', sort_order: 10, is_active: true },
  { code: 'library_error', display: 'Library rule or text error', sort_order: 20, is_active: true },
  { code: 'not_appropriate_for_patient', display: 'Not appropriate for this patient', sort_order: 30, is_active: true },
  { code: 'results_under_review', display: 'Results under review', sort_order: 40, is_active: true },
  { code: 'other', display: 'Other', sort_order: 90, is_active: true },
] };

const A1 = uid(701), A2 = uid(702), R1 = uid(801), R2 = uid(802), R3 = uid(803);
export const ANALYTES = { ALT: A1, HB: A2 };

/** SmartSummaryView (contract example shape) for a draft; every test overrides what it needs. */
export const summaryView = (over: Record<string, unknown> = {}) => ({
  id: SUMMARY_ID, order_id: ORDER_ID, centre_id: CENTRE_ID, status: 'draft', library_version_id: LIB_ID, template_library_version: 3, formula_version: 'hs-1', language: 'en',
  built_at: '2026-01-15T04:30:00.000Z', report_version_nos: [1], registration_no: 'SYN-000123', patient_display_name: 'Synthetic Patient A',
  health_score: { value: 81, band: 'good', formula_version: 'hs-1', panels_scored: 3, explanation_text: 'Synthetic explanation of the score.' },
  panels: [
    { panel_code: 'liver', display_name: 'Liver', status: 'out_of_range', result_ids: [R1] },
    { panel_code: 'blood', display_name: 'Blood count', status: 'in_range', result_ids: [R2] },
  ],
  deranged: [{ result_id: R1, analyte_id: A1, analyte_name: 'Synthetic ALT', direction: 'high', severity: 'out_of_range', template_block_id: uid(10), text: 'Your Synthetic ALT result is above the reference range.' }],
  advice: [{ template_block_id: uid(11), text: 'Synthetic advice: discuss liver results with your doctor.' }],
  follow_ups: [{ rule_id: uid(20), suggested_test_code: 'SYN-LFT', suggested_test_name: 'Synthetic LFT', interval_days: 90, text: 'Consider a repeat Synthetic LFT in 90 days.' }],
  trends: [{ analyte_id: A1, analyte_name: 'Synthetic ALT', unit_code: 'UL', direction: 'worsened', point_result_ids: [R3, R1], points: [
    { result_id: R3, approved_at: '2025-09-01T04:30:00.000Z', value_numeric: '41.5' }, { result_id: R1, approved_at: '2026-01-10T04:30:00.000Z', value_numeric: '63.25' },
  ] }],
  disclaimer_block_id: uid(12), disclaimer_text: 'Synthetic disclaimer: this summary is not a diagnosis.',
  counts: { deranged: 1, critical: 0, unmapped_results: 2, ignored_duplicates: 1 }, llm: { enabled: false, use_llm_text: false },
  review_inputs: [
    { result_id: R1, analyte_id: A1, analyte_name: 'Synthetic ALT', value_text: '63.25', unit_code: 'UL', flag: 'H', ref_range_text: '7 - 40', band_status: 'out_of_range', group_code: 'liver' },
    { result_id: R2, analyte_id: A2, analyte_name: 'Synthetic Haemoglobin', value_text: '13.8', unit_code: 'GDL', ref_range_text: '12 - 16', band_status: 'in_range', group_code: 'blood' },
  ],
  reviews: [] as unknown[], version: 4, ...over,
});

export const approvedView = (over: Record<string, unknown> = {}) => summaryView({
  status: 'approved', version: 5, approved_at: '2026-01-15T05:10:00.000Z', approved_by_membership_id: uid(50), approved_by_display_name: 'Synthetic Pathologist',
  reviews: [{ action: 'approved', actor_display_name: 'Synthetic Pathologist', at: '2026-01-15T05:10:00.000Z' }], ...over,
});

/** Registers the reads the SR-02 page may make. Override single routes afterwards. */
export function mountSummary(view: Record<string, unknown> = summaryView()) {
  routes[`GET ${SUMMARY_URL}`] = json(view);
  routes[`GET ${REASONS_URL}`] = json(REASONS);
}
export const showSummary = (id = SUMMARY_ID) => show(SUMMARY_PAGE, { summary_id: id });
