// C10.T-22 shared test harness (tester-owned; not a test file). Builds on t20.harness (MSW fake C10 API, session/navigation mocks, kit helpers) and adds the report endpoints
// (contracts/openapi/micro.yaml: submitCultureReport M14, listCultureReportVersions M15, getCultureReportVersion M16, reopenCulture M17) and C5's listLabCodedSet.
// Each test file registers:
//   vi.mock('next/navigation', async () => (await import('./t22.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t22.harness')).sessionMock)
// CONTRACT PINNED BY THESE TESTS (writer: make these exist; names are mine, data shapes are the spec's):
//   features/micro/server/listLabCodedSet.server.ts   export async function listLabCodedSet(setName): Promise<{ code: string; display: string }[]>   (server-only)
//        GET /v1/lab/coded-sets/{set_name} (C5, lab.yaml listLabCodedSet); set_name is checked against the four lab sets BEFORE any request; for 'amendment_reasons' the BFF removes the
//        system codes module_phase_progression, module_preliminary_update, supplementary_report (08 A17 D-62) and inactive codes; any failure -> [] (the dialog stays usable); no logging.
//   CultureScreen (T-20) wires the stubs of its header and Reports tab (04-UI-UX §3.4, 03-APP-FLOW §4.6):
//        buttons "Preliminary report" / "Final report" / "Reopen for amendment" are enabled where the state allows (T-20 ALLOWED table) and open
//        - Drawer (role dialog) named exactly "Preliminary report" / "Final report": fields "Outcome" (final only; CodedSelect over GET /v1/micro/coded-sets/culture_outcomes), "Summary" (TextArea, 4000),
//          "Comments" (TextArea, 4000), "Notify as critical" (Checkbox), "Reason for early final" (TextArea, 500; only when outcome = no_growth and now < final_due_at), "Amendment reason" (read-only text, only when
//          the culture is amending), button "Regenerate", submit "Send for verification" (Ctrl+Enter);
//        - ConfirmDialog "Reopen for amendment" (requireReason: Select "Reason", TextField "Details", confirm "Reopen").
//        Reports tab: DataTable of culture.report_versions (ReportVersionSummaryDto[]); row action "View" -> Drawer (dialog named /preliminary report|final report/i, NO "Send for verification") showing
//        the snapshot fetched with GET /v1/micro/cultures/{id}/report-versions/{version_no}.
//   culture.report_versions (ReportVersionSummaryDto[]), culture.last_report_phase, culture.outcome_code, culture.amendment_reason_code/_text, culture.lab_result {result_id,status,version_no},
//   culture.permissions_hint.can_amend_approved are read from CultureDetailDto (the writer adds the missing optional fields to server/types.ts).
//   Writes go through server actions: M14 Idempotency-Key (one per drawer opening, reused on retry), M17 If-Match "<culture.version>". Synthetic data only.
import { http, HttpResponse } from 'msw';
import { screen, within } from '@testing-library/react';
import { CODED, ID, ORIGIN, api, code, culture, incubating, isolate, obs, problem } from './t20.harness';

export * from './t20.harness';

export const SUBMIT = /\/v1\/micro\/cultures\/[^/]+\/report-versions$/;
export const VERSION = /\/v1\/micro\/cultures\/[^/]+\/report-versions\/\d+$/;
export const REOPEN = /\/v1\/micro\/cultures\/[^/]+\/reopen$/;
export const LAB_REASONS = /\/v1\/lab\/coded-sets\/amendment_reasons$/;
export const PERM_AMEND = ['micro.culture.read', 'micro.culture.work', 'lab.result.amend', 'frontdesk.patient.read', 'lab.specimen.read'];
export const SYSTEM_CODES = ['module_phase_progression', 'module_preliminary_update', 'supplementary_report'] as const;

// ---- C5 amendment_reasons: global + tenant, the three system codes included (the BFF must strip them)
export const amendCode = (c: string, display: string, over: Record<string, unknown> = {}) => ({ code: c, display, sort_order: 10, is_active: true, source: 'global', ...over });
export const AMEND_REASONS = [
  amendCode('syn_transcription_error', 'Synthetic transcription error'),
  amendCode('syn_new_information', 'Synthetic new information', { source: 'tenant' }),
  amendCode('syn_retired_reason', 'Synthetic retired reason', { is_active: false }),
  amendCode('module_phase_progression', 'Preliminary to final'),
  amendCode('module_preliminary_update', 'Updated preliminary'),
  amendCode('supplementary_report', 'Supplementary report'),
];
export const labReasonsHandler = (rows: unknown[] = AMEND_REASONS) => http.get(`${ORIGIN}/v1/lab/coded-sets/amendment_reasons`, () => HttpResponse.json({ data: rows }));

// ---- culture_outcomes (05-SCHEMA §3 [CONV] starter set; result_flag / requires_isolate)
CODED['culture_outcomes'] = [
  code('no_growth', { display: 'No growth', result_flag: 'N', requires_isolate: false }),
  code('growth_reported', { display: 'Growth — see isolates', result_flag: 'A', requires_isolate: true }),
  code('normal_flora', { display: 'Normal flora only', result_flag: 'N', requires_isolate: false }),
];

// ---- fixtures
export const isoAt = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * 3600_000).toISOString();
export const AST_ROW = (isolateSeq: number, abx: string, display: string, over: Record<string, unknown> = {}) => ({
  isolate_seq: isolateSeq, antibiotic_code: abx, antibiotic_display: display, method: 'mic', raw_value: '<=0.25', category_code: 'S', standard: 'CLSI', standard_version: 'M100-Ed36', ...over,
});
export const astResult = (n: number, abx: string, display: string, over: Record<string, unknown> = {}) => ({
  id: ID(400 + n), version: 1, antibiotic_code: abx, antibiotic_display: display, method: 'mic', suggestion_overridden: false, source: 'manual', is_reportable: true, report_visibility: 'shown', off_panel: false, panel_sort_order: n, ...over,
});
/** A growth culture: one identified isolate with a complete AST row and one row without a category (the drawer must flag it "Category missing"). */
export const growth = (over: Record<string, unknown> = {}) => incubating({
  status: 'growth_detected', observations: [obs(1)], final_due_at: isoAt(12),
  isolates: [isolate(1, { organism_code: 'synthetic_org', organism_display: 'Synthetic organism', quantity_text: '≥10^5 CFU/mL', ast: [astResult(1, 'syn_cef_a', 'Synthetic cefA', { raw_value: '0.25', category_code: 'S', standard: 'CLSI', standard_version: 'M100-Ed36' }), astResult(2, 'syn_gen_b', 'Synthetic genB', { raw_value: '18' })] })],
  ...over,
});
export const summaryDto = (n: number, over: Record<string, unknown> = {}) => ({
  version_no: n, report_phase: 'preliminary', version_kind: n === 1 ? 'initial' : 'update', flag: 'A', is_critical: false, signed_by_display: `Synthetic Signer ${n}`, signed_at: '2026-11-10T08:30:00.000Z', lab_status_at_submit: 'resulted', ...over,
});
export const versionDto = (n: number, over: Record<string, unknown> = {}) => ({
  ...summaryDto(n), culture_summary_text: `Synthetic summary for version ${n}\nsecond line`, lab_result_id: ID(80), lab_result_version_no: 1,
  isolates: [{ seq: 1, organism_code: 'synthetic_org', organism_display: 'Synthetic organism', growth_text: '≥10^5 CFU/mL' }],
  ast: [AST_ROW(1, 'syn_cef_a', 'Synthetic cefA'), AST_ROW(1, 'syn_gen_b', 'Synthetic genB', { method: 'zone_diameter', raw_value: '18', category_code: 'R', standard_version: 'M100-Ed36' })], ...over,
});
export const finalCulture = (over: Record<string, unknown> = {}) => growth({
  status: 'final_submitted', version: 9, current_report_version_no: 2, last_report_phase: 'final', outcome_code: 'growth_reported', lab_result: { result_id: ID(80), status: 'resulted', version_no: 1 },
  report_versions: [summaryDto(1), summaryDto(2, { report_phase: 'final', outcome_code: 'growth_reported', version_kind: 'update' })], ...over,
});
export const amending = (over: Record<string, unknown> = {}) => finalCulture({
  status: 'amending', version: 10, amendment_reason_code: 'syn_transcription_error', amendment_reason_text: 'Synthetic wrong isolate number', ...over,
});
export const approvedPreliminary = (over: Record<string, unknown> = {}) => growth({
  current_report_version_no: 1, last_report_phase: 'preliminary', lab_result: { result_id: ID(80), status: 'approved', version_no: 1 }, report_versions: [summaryDto(1)], permissions_hint: { can_amend_approved: false }, ...over,
});

// ---- fake report endpoints
export const submitOk = (n = 1, over: Record<string, unknown> = {}) => http.post(`${ORIGIN}/v1/micro/cultures/:id/report-versions`, () => HttpResponse.json(versionDto(n, over), { status: 201 }));
export const submitFail = (c: string, status: number, extra: Record<string, unknown> = {}) => http.post(`${ORIGIN}/v1/micro/cultures/:id/report-versions`, () => problem(c, status, extra));
export const useReports = () => api.use(
  labReasonsHandler(),
  submitOk(),
  http.get(`${ORIGIN}/v1/micro/cultures/:id/report-versions/:n`, ({ params }) => HttpResponse.json(versionDto(Number(params['n']), Number(params['n']) === 2 ? { report_phase: 'final', outcome_code: 'growth_reported' } : {}))),
  http.post(`${ORIGIN}/v1/micro/cultures/:id/reopen`, () => HttpResponse.json(amending())),
);
export { problem };

// ---- UI helpers
export const headerBtn = (name: RegExp) => screen.getAllByRole('button', { name })[0]!;
export const drawerOf = (name: RegExp) => screen.findByRole('dialog', { name });
export const submitBtn = (d: HTMLElement) => within(d).getByRole('button', { name: /^send for verification$/i });
export const describedText = (el: HTMLElement) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
export const optionNames = async (trigger: HTMLElement) => {
  const { default: userEvent } = await import('@testing-library/user-event');
  await userEvent.click(trigger);
  const list = await screen.findByRole('listbox');
  const names = within(list).getAllByRole('option').map((o) => o.textContent?.trim() ?? '');
  await userEvent.keyboard('{Escape}');
  return names;
};
export { culture };
