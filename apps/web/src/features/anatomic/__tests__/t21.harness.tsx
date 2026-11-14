// C11.T-21 shared harness (tester-owned; not a test file). Re-uses the T-19/T-20 MSW server + session/router mocks and adds the report fixtures and default handlers.
// Each test file registers the same three mocks as T-19/T-20 (vi.mock is hoisted, so the factories import this lazily):
//   vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock)
// and calls `beforeEach(() => api.use(...t21Defaults))` (api.resetHandlers() in afterEach removes them again).
// CONTRACT PINNED BY THE T-21 TESTS (writer: make these exist; names are mine, data shapes are contracts/openapi/anatomic.yaml):
//   CaseWorkspace (T-19 seam) gets a working tab named "Report" (Alt+R) that replaces the T-19/T-20 placeholder; code lives in features/anatomic/components/report/* (plan row T-21).
//   Page shortcuts on 'staff.anatomic.case': Alt+S saves the draft (report tab), Alt+U opens the Sign out dialog (04-UI-UX §3).
//   Data the tab loads (all through the BFF to the real API paths; the tests do not care whether the page or the tab fetches, only that the paths below are used):
//     GET  /v1/anatomic/cases/{id}/report-draft          404 = no draft (EmptyState "No report draft yet." + [Start report])      R1
//     PUT  /v1/anatomic/cases/{id}/report-draft          If-Match = draft version ("0" creates); NO Idempotency-Key (x-idempotency none)   R2
//     POST /v1/anatomic/cases/{id}/sign-out              If-Match = draft version, Idempotency-Key, body {attest:true}              R3
//     POST /v1/anatomic/cases/{id}/changes               If-Match = case version, Idempotency-Key, {reason_code, reason_text?}      R4
//     POST /v1/anatomic/cases/{id}/changes/discard       If-Match = draft version, Idempotency-Key                                  R5
//     GET  /v1/anatomic/cases/{id}/versions[/{n}]        list (newest first) / full snapshot                                        R6/R7
//     POST /v1/anatomic/cases/{id}/addenda               Idempotency-Key, {kind, text, stain_order_ids?, addon_case_item_id?}       R8
//     PUT  /v1/anatomic/addenda/{id}                     If-Match = addendum version                                                R9
//     POST /v1/anatomic/addenda/{id}/sign                If-Match, Idempotency-Key, {attest:true}                                   R10
//     GET  /v1/anatomic/synoptic-templates?status=published&case_kind=…  (summaries) + GET /synoptic-templates/{id} (definition)    K13/K14
//     GET  /v1/lab/coded-sets/amendment_reasons          C5 BFF listLabCodedSet (04-UI-UX §4.2.7)
//     GET  /v1/anatomic/coded-sets/diagnoses/values?q=   diagnosis code search
//     GET  /v1/anatomic/settings                         max_report_images
//   Addenda come from CaseDetail.addenda (harness detail() already has `addenda: []`); versions from the list endpoint.
//   Text in test ids: ErrorSummary is the kit's (data-testid="error-summary", anchors that focus the field).
// Synthetic data only.
import { http, HttpResponse } from 'msw';
export { ID, IDEM_RE, ORIGIN, PERM_NONE, PERM_READ, PERM_WORK, api, block, detail, hit, hits, image, navigationMock, page, part, problem, resetHits, router, sessionMock, slide, stainOrder, state, summary, workedCase } from './t20.harness';
export { template } from './t19.harness';
import { ID, ORIGIN, block, detail, image, page, part, slide, stainOrder, t20Defaults } from './t20.harness';

export const PERM_SIGN = ['anatomic.case.read', 'frontdesk.patient.read', 'lab.result.read', 'anatomic.case.work', 'anatomic.case.signout'];

// ---------------------------------------------------------------- fixtures (schemas ReportDraft, ReportVersion(Summary), SynopticTemplate(Summary), Addendum, SignOutResult)
export const draft = (over: Record<string, unknown> = {}) => ({
  case_id: ID(1), kind: 'initial', gross_text: '', microscopy_text: '', impression_text: '', comment_text: '', is_critical: false,
  synoptic: [], image_ids: [], ancillary: [], diagnosis_codes: [],
  updated_at: '2026-11-12T08:00:00.000Z', updated_by_display_name: 'Synthetic Pathologist', version: 2, ...over,
});

export const field = (key: string, type: string, label: string, over: Record<string, unknown> = {}) => ({ key, label, type, required: false, ...over });
export const synDefinition = (over: Record<string, unknown> = {}) => ({
  schema_version: 1, title: 'Synthetic breast panel', applies_to_case_kinds: ['histology'],
  sections: [
    { key: 'tumour', heading: 'Tumour', fields: [
      field('site', 'text', 'Tumour site', { required: true, max_length: 50 }),
      field('notes', 'long_text', 'Tumour notes', { max_length: 500 }),
      field('size_mm', 'integer', 'Size (mm)', { min: '0', max: '300' }),
      field('weight', 'decimal', 'Weight', { decimals: 2, min: '0', max: '9', unit_text: 'g' }),
      field('multifocal', 'boolean', 'Multifocal'),
      field('grade', 'single_select', 'Grade', { required: true, options: [{ code: 'g1', display: 'Grade 1' }, { code: 'g2', display: 'Grade 2' }, { code: 'g3', display: 'Grade 3' }] }),
      field('margins', 'multi_select', 'Margins involved', { options: [{ code: 'sup', display: 'Superficial' }, { code: 'deep', display: 'Deep' }] }),
      field('excised_on', 'date', 'Excised on'),
      field('necrosis_extent', 'text', 'Necrosis extent', { required: true, show_if: { field_key: 'multifocal', equals: true } }),
    ] },
  ],
  ...over,
});
export const synSummary = (n: number, over: Record<string, unknown> = {}) => ({ id: ID(1000 + n), template_key: n === 1 ? 'breast_panel' : `panel_${n}`, version_no: 1, status: 'published', title: n === 1 ? 'Synthetic breast panel' : `Synthetic panel ${n}`, applies_to_case_kinds: ['histology'], published_at: '2026-11-01T00:00:00.000Z', ...over });
export const synTemplate = (n = 1, def: Record<string, unknown> = synDefinition(), over: Record<string, unknown> = {}) => ({ ...synSummary(n), definition: def, version: 1, ...over });
export const synInstance = (n = 1, values: Record<string, unknown> = {}) => ({ template_id: ID(1000 + n), template_key: n === 1 ? 'breast_panel' : `panel_${n}`, template_version: 1, title: n === 1 ? 'Synthetic breast panel' : `Synthetic panel ${n}`, values });

export const versionSummary = (n: number, over: Record<string, unknown> = {}) => ({
  version_no: n, version_kind: n === 1 ? 'original' : 'revision', scope: 'full', signed_at: '2026-11-12T09:00:00.000Z', signed_by_display_name: 'Synthetic Pathologist',
  submissions: [{ case_item_id: ID(10), order_item_id: ID(11), item_version_no: n, lab_status_at_submit: 'pending' }], ...over,
});
export const versionFull = (n: number, over: Record<string, unknown> = {}) => ({
  ...versionSummary(n), clinical_history_text: 'Synthetic history.', gross_text: 'Synthetic signed gross.', microscopy_text: 'Synthetic signed microscopy.', impression_text: 'Synthetic signed impression.', comment_text: '',
  synoptic: [{ template_key: 'breast_panel', template_version: 1, title: 'Synthetic breast panel', sections: [{ heading: 'Tumour', items: [{ label: 'Tumour site', value: 'Synthetic site' }] }] }],
  images: [], specimen_parts: [{ letter: 'A', site_text: 'Synthetic site 1' }], slides: [{ label: 'SP26-000042-A1-S1', stain_display: 'Haematoxylin & Eosin' }], ancillary: [], molecular: [], addenda: [], diagnosis_codes: [{ code: 'D001', display: 'Synthetic diagnosis one', system: 'synthetic' }], ...over,
});
export const addendum = (n: number, over: Record<string, unknown> = {}) => ({ id: ID(1100 + n), kind: 'ihc', text: `Synthetic addendum text ${n}`, stain_order_ids: [], status: 'draft', version: 1, ...over });
export const reasons = [
  { code: 'transcription_error', display: 'Transcription error', sort_order: 1, is_active: true },
  { code: 'new_information', display: 'New clinical information', sort_order: 2, is_active: true },
  { code: 'retired_reason', display: 'Retired reason', sort_order: 3, is_active: false },
  { code: 'module_phase_progression', display: 'Phase progression (system)', sort_order: 4, is_active: true },
  { code: 'module_preliminary_update', display: 'Preliminary update (system)', sort_order: 5, is_active: true },
  { code: 'supplementary_report', display: 'Supplementary report (system)', sort_order: 6, is_active: true },
];

/** A case at the reporting stage: 1 histology part (A) with gross, 2 ready images, 1 completed special stain, 1 slide included in the report; one open draft is served by default. */
export const reportCase = (over: Record<string, unknown> = {}) =>
  detail({
    accession_no: 'SP26-000042', status: 'ready_for_reporting', allowed_actions: ['signOutAnatomicCase', 'cancelAnatomicCase'], version: 7,
    parts: [part(1, { gross: { part_id: ID(101), gross_text: 'Synthetic gross of part A.', is_complete: true, grossed_by_display_name: 'Synthetic Grosser', updated_at: '2026-11-10T06:00:00.000Z', version: 2 } })],
    blocks: [block(1)], slides: [slide(1, { include_in_report: true, finding_text: 'Synthetic finding' }), slide(2, { include_in_report: false })],
    stain_orders: [stainOrder(1, { status: 'completed', stain_code: 'PAS', stain_display: 'Periodic acid-Schiff', block_label: 'SP26-000042-A1' }), stainOrder(2, { status: 'requested', stain_code: 'CK7', stain_display: 'Cytokeratin 7' })],
    images: [image(1, { caption: 'Synthetic caption 1' }), image(2, { caption: 'Synthetic caption 2' }), image(3, { caption: 'Synthetic processing image', state: 'processing' })],
    open_draft: { kind: 'initial', version: 2, updated_at: '2026-11-12T08:00:00.000Z' },
    ...over,
  });
/** Signed out, C5 result not approved -> [Revise]. */
export const signedCase = (over: Record<string, unknown> = {}) =>
  reportCase({ status: 'signed_out', current_version_no: 1, signed_out_at: '2026-11-12T09:00:00.000Z', allowed_actions: ['startAnatomicCaseChange', 'createAnatomicAddendum'], open_draft: undefined, ...over });
export const approvedItems = (status: string) => [{ case_item_id: ID(10), order_item_id: ID(11), test_id: ID(12), test_name: 'Synthetic biopsy', role: 'primary', is_active: true, lab_status: status }];
export const addonItem = { case_item_id: ID(20), order_item_id: ID(21), test_id: ID(22), test_name: 'Synthetic add-on IHC panel', role: 'addon', is_active: true, lab_status: 'pending' };

// ---------------------------------------------------------------- default handlers (every request is already logged by the T-19 harness)
const base = `${ORIGIN}/v1/anatomic`;
const verOf = (h: string | null) => Number((h ?? '"0"').replace(/"/g, '')) || 0;
export const signResult = (c: Record<string, unknown> = signedCase()) => ({ case: c, report_version: versionSummary(1) });
export const t21Defaults = [
  http.get(`${base}/cases/:id/report-draft`, () => HttpResponse.json(draft())),
  http.put(`${base}/cases/:id/report-draft`, async ({ request }) => {
    const b = (await request.clone().json()) as Record<string, unknown>;
    const v = verOf(request.headers.get('if-match'));
    return HttpResponse.json(draft({ ...b, version: v + 1 }), { status: v === 0 ? 201 : 200 });
  }),
  http.post(`${base}/cases/:id/sign-out`, () => HttpResponse.json(signResult())),
  http.post(`${base}/cases/:id/changes`, async ({ request }) => {
    const b = (await request.clone().json()) as { reason_code: string; reason_text?: string };
    return HttpResponse.json(draft({ kind: 'revision', change_reason_code: b.reason_code, ...(b.reason_text ? { change_reason_text: b.reason_text } : {}), gross_text: 'Synthetic signed gross.', impression_text: 'Synthetic signed impression.', version: 1 }), { status: 201 });
  }),
  http.post(`${base}/cases/:id/changes/discard`, () => new HttpResponse(null, { status: 204 })),
  http.get(`${base}/cases/:id/versions`, () => HttpResponse.json({ data: [] })),
  http.get(`${base}/cases/:id/versions/:n`, ({ params }) => HttpResponse.json(versionFull(Number(params['n'])))),
  http.post(`${base}/cases/:id/addenda`, async ({ request }) => {
    const b = (await request.clone().json()) as Record<string, unknown>;
    return HttpResponse.json(addendum(1, b), { status: 201 });
  }),
  http.put(`${base}/addenda/:id`, async ({ request }) => {
    const b = (await request.clone().json()) as Record<string, unknown>;
    return HttpResponse.json(addendum(1, { ...b, version: verOf(request.headers.get('if-match')) + 1 }));
  }),
  http.post(`${base}/addenda/:id/sign`, () => HttpResponse.json({ case: signedCase(), report_version: versionSummary(2, { version_kind: 'addendum' }) })),
  http.get(`${base}/synoptic-templates`, () => page([synSummary(1), synSummary(2)])),
  http.get(`${base}/synoptic-templates/:id`, ({ params }) => HttpResponse.json(synTemplate(Number(String(params['id']).slice(-12)) - 1000))), // ID(1000 + n) -> template n
  http.get(`${ORIGIN}/v1/lab/coded-sets/amendment_reasons`, () => HttpResponse.json({ data: reasons })),
  http.get(`${base}/coded-sets/diagnoses/values`, ({ request }) => {
    const q = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase();
    return page([{ code: 'D001', display: 'Synthetic diagnosis one', system: 'synthetic', is_active: true }, { code: 'D002', display: 'Synthetic diagnosis two', system: 'synthetic', is_active: true }].filter((r) => !q || r.display.toLowerCase().includes(q) || r.code.toLowerCase().includes(q)));
  }),
  http.get(`${base}/settings`, () => HttpResponse.json({ auto_accession_on_receipt: true, require_gross_complete_for_processing: false, default_routine_stain_code: 'HE', max_images_per_case: 50, max_report_images: 24, version: 1 })),
  ...t20Defaults,
];
