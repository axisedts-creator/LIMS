// C11.T-23 shared harness (tester-owned; not a test file). Re-uses the T-19 MSW server + session/router mocks (via t20.harness) and adds configuration fixtures and default handlers.
// Each test file registers the same three mocks as T-19/T-20/T-22 (vi.mock is hoisted, so the factories import this lazily):
//   vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock)
// and call `beforeEach(() => api.use(...t23Defaults))` (api.resetHandlers() in afterEach removes them again).
// CONTRACT PINNED BY THE T-23 TESTS (writer: make these exist; names are mine, data shapes are contracts/openapi/anatomic.yaml; LD-140 binds: kit components, one primary button per page, status = tone + icon + word):
//   app/(staff)/anatomic/config/page.tsx                          default async Page({ searchParams: Promise<{ tab?, set? }> })   (04-UI-UX §4.7)
//       tab ids: settings (default; unknown values fall back) | stains | test-profiles | assays | coded-lists | templates | text-templates. Kit Tabs named Settings, Stains, Test profiles, Assays, Coded lists,
//       Synoptic templates, Text templates; choosing one calls router.push('/anatomic/config?tab=<id>'). The server page loads only the active tab's data (GET /settings + GET /stains | /test-profiles + /catalog/tests |
//       /assays | /coded-sets/{set}/values (set = diagnoses default | cytology_adequacy | cancel_reasons) | /synoptic-templates | /text-templates; every list asks include_inactive=true where the contract has it).
//       Without 'anatomic.config.manage' in the session: no-access state (text matches /permission/), no tabs, no write request ever (AC-14.4 UI side; the API enforces the 403 too).
//   app/(staff)/anatomic/config/templates/[template_id]/page.tsx  default async Page({ params: Promise<{ template_id }> })       template_id = a UUID (GET /synoptic-templates/{id}) or the literal 'new' (blank builder, no GET).
//       anything else -> notFound() without an API call; 400/404 -> notFound(); 403 or no config.manage -> no-access state; other failures reject (error.tsx).
//   Help keys 'anatomic.config' and 'anatomic.config.template' -> features/anatomic/help/<key>.ts. No Alt+ shortcuts registered by these pages.
//   Test profiles tab also loads GET /synoptic-templates?status=published (picker of default templates). Assay drawer seams: textboxes "Code" and "Name" (assay), button [Add target] -> an element [data-target="<code>"] with
//       textboxes "Target code" / "Target name", switch "Quantitative", textbox "Unit code", spinbutton "Decimals", switch "Active" (the target's own controls come BEFORE its values) and button [Add value] ->
//       [data-value="<code>"] with textboxes "Value code" / "Value display", checkbox "Abnormal", switch "Active". Saved codes are read-only and have no Remove/Delete button. Add buttons: [Add stain], [Add assay],
//       [Add code|value|diagnosis], [Add (text) template]; row buttons "Edit ..." (or Publish / New version / Retire on the synoptic list: plain buttons, no Menu); drawer footer button "Save". Synoptic list: Publish/Retire
//       read the template's version with a GET first (list rows carry no version) and ask in a ConfirmDialog whose confirm button is named like the action.
//   Masters are a list + right Drawer (role dialog) + per-section Save; every write goes through a server action (no fetch in components). Writes: PUT carries If-Match "<version>" and NO Idempotency-Key;
//   POST carries Idempotency-Key (IDEM_RE) and, where the contract says so, no If-Match; request bodies hold ONLY the contract's declared fields (additionalProperties:false) and omit empty optionals.
//   Errors: 403 auth.mfa_required -> dialog text 'This action needs two-factor verification.' + [Verify now]; 409 common.version_conflict -> Banner 'This record was changed by someone else. Reload to see the latest version.' + [Reload]
//   (copy adapted from 04-UI-UX §2 anatomic.common.conflict); 403 auth.forbidden -> text matching /permission/; 400 common.validation_failed -> the server's message is shown (detail or errors[].message).
// Synthetic data only.
import { http, HttpResponse } from 'msw';
export { IDEM_RE, ID, ORIGIN, PERM_NONE, PERM_READ, PERM_WORK, api, detail, hit, hits, navigationMock, page, problem, resetHits, router, sessionMock, state, summary } from './t20.harness';
import { ID, ORIGIN, api, page } from './t20.harness';

/** 03-APP-FLOW / AC-14.4: config.manage is the only extra permission; a lab_technologist has PERM_WORK without it. */
export const PERM_CONFIG = ['anatomic.case.read', 'anatomic.config.manage', 'catalog.test.read'];

// ---------------------------------------------------------------- fixtures (schemas Settings, Stain, TestProfile, Assay, CodedValue, TextTemplate, SynopticTemplate*)
export const settings = (over: Record<string, unknown> = {}) => ({
  auto_accession_on_receipt: true, require_gross_complete_for_processing: true, default_routine_stain_code: 'HE', max_images_per_case: 20, max_report_images: 4, version: 3, ...over,
});
export const stain = (code: string, kind: 'routine' | 'special' | 'ihc', over: Record<string, unknown> = {}) => ({
  id: ID(1300 + (['HE', 'PAS', 'CK7', 'PAP', 'NEW'].indexOf(code) + 1)), code, display: `Synthetic ${code}`, kind, sort_order: 1, is_active: true, version: 2, ...over,
});
export const stains = () => [stain('HE', 'routine'), stain('PAS', 'special'), stain('CK7', 'ihc', { sort_order: 5, is_active: false }), stain('PAP', 'routine', { sort_order: 2 })];

export const TEST_X = ID(1400);
export const TEST_Y = ID(1401);
export const profile = (over: Record<string, unknown> = {}) => ({
  test_id: TEST_X, test_name: 'Synthetic biopsy', case_kind: 'histology', is_addon: false, requires_gross: true, default_stain_code: 'HE', default_synoptic_template_keys: ['syn_colon'], is_active: true, version: 4, ...over,
});
export const catalogTest = (id: string, code: string, name: string, workflow_type = 'anatomic') => ({ id, kind: 'test', code, name, department_id: ID(38), department_code: 'ANAT', workflow_type, is_orderable: true, is_active: true, revision: 1 });

export const assayValue = (code: string, display: string, is_abnormal: boolean, over: Record<string, unknown> = {}) => ({ code, display, is_abnormal, sort_order: 1, is_active: true, ...over });
export const assayRow = (over: Record<string, unknown> = {}) => ({
  id: ID(1500), code: 'SYN_PCR_A', display: 'Synthetic PCR A', method_text_default: 'Synthetic real-time PCR', is_active: true, version: 5,
  targets: [
    { id: ID(1510), code: 'T1', display: 'Target one', allows_quantitative: true, unit_code: 'copies_per_ml', decimals: 0, sort_order: 1, is_active: true,
      result_values: [assayValue('detected', 'Detected', true), assayValue('not_detected', 'Not detected', false)] },
    { id: ID(1511), code: 'T2', display: 'Target two', allows_quantitative: false, sort_order: 2, is_active: true, result_values: [assayValue('positive', 'Positive', true)] },
  ],
  ...over,
});

export const coded = (code: string, display: string, over: Record<string, unknown> = {}) => ({ code, display, system: 'local', sort_order: 1, is_active: true, version: 2, ...over });
export const textTpl = (n: number, code: string, over: Record<string, unknown> = {}) => ({ id: ID(1600 + n), short_code: code, section: 'gross', title: `Synthetic ${code}`, body: `Synthetic body ${code}.`, is_active: true, version: 2, ...over });

// ---- synoptic templates
export type Def = { schema_version: 1; title: string; applies_to_case_kinds: string[]; sections: { key: string; heading: string; fields: Record<string, unknown>[] }[] };
/** A valid definition: 2 sections, 5 fields (AC-08.1 shape). show_if on `nodes_n` points at the earlier single_select `grade`. */
export const definition = (over: Partial<Def> = {}): Def => ({
  schema_version: 1, title: 'Synthetic colon checklist', applies_to_case_kinds: ['histology'],
  sections: [
    { key: 'tumour', heading: 'Tumour', fields: [
      { key: 'site', label: 'Tumour site', type: 'text', required: true, max_length: 100 },
      { key: 'size_mm', label: 'Tumour size', type: 'decimal', required: true, unit_text: 'mm', min: '0', max: '300', decimals: 1 },
      { key: 'grade', label: 'Grade', type: 'single_select', required: false, options: [{ code: 'g1', display: 'Well differentiated' }, { code: 'g2', display: 'Moderately differentiated' }] },
    ] },
    { key: 'nodes', heading: 'Lymph nodes', fields: [
      { key: 'nodes_sampled', label: 'Nodes sampled', type: 'boolean', required: false },
      { key: 'nodes_n', label: 'Nodes positive', type: 'integer', required: false, min: '0', show_if: { field_key: 'nodes_sampled', equals: true } },
    ] },
  ],
  ...over,
});
export const TPL = ID(1700);
export const tplSummary = (n: number, key: string, status: 'draft' | 'published' | 'retired', over: Record<string, unknown> = {}) => ({
  id: ID(1700 + n), template_key: key, version_no: 1, status, title: `Synthetic ${key}`, applies_to_case_kinds: ['histology'], ...(status === 'draft' ? {} : { published_at: '2026-11-01T08:30:00.000Z' }), ...over,
});
export const tpl = (over: Record<string, unknown> = {}, def: Def = definition()) => ({
  id: TPL, template_key: 'syn_colon', version_no: 1, status: 'draft', title: def.title, applies_to_case_kinds: def.applies_to_case_kinds, definition: def, version: 6, ...over,
});

// ---------------------------------------------------------------- default handlers (every request is already logged by the T-19 harness)
const created = (body: unknown) => HttpResponse.json(body as never, { status: 201 });
const echo = (base: Record<string, unknown>) => async ({ request }: { request: Request }) => HttpResponse.json({ ...base, ...((await request.clone().json()) as object), version: Number(base['version'] ?? 1) + 1 });
export const t23Defaults = [
  http.get(`${ORIGIN}/v1/anatomic/settings`, () => HttpResponse.json(settings())),
  http.put(`${ORIGIN}/v1/anatomic/settings`, echo(settings())),
  http.get(`${ORIGIN}/v1/anatomic/stains`, () => page(stains())),
  http.post(`${ORIGIN}/v1/anatomic/stains`, async ({ request }) => created({ ...stain('NEW', 'special'), ...((await request.clone().json()) as object), is_active: true, version: 1 })),
  http.put(`${ORIGIN}/v1/anatomic/stains/:id`, async ({ request }) => HttpResponse.json({ ...stain('HE', 'routine'), ...((await request.clone().json()) as object), version: 3 })),
  http.get(`${ORIGIN}/v1/anatomic/test-profiles`, () => page([profile()])),
  http.put(`${ORIGIN}/v1/anatomic/test-profiles/:id`, async ({ request, params }) => HttpResponse.json({ ...profile(), test_id: params['id'], ...((await request.clone().json()) as object), version: 5 })),
  http.get(`${ORIGIN}/v1/catalog/tests`, ({ request }) => {
    const wf = new URL(request.url).searchParams.get('workflow_type');
    return page(wf === 'molecular' ? [catalogTest(TEST_Y, 'SYN_MOL', 'Synthetic panel', 'molecular')] : [catalogTest(TEST_X, 'SYN_BX', 'Synthetic biopsy')]);
  }),
  http.get(`${ORIGIN}/v1/anatomic/assays`, () => page([assayRow()])),
  http.post(`${ORIGIN}/v1/anatomic/assays`, async ({ request }) => created({ ...assayRow(), ...((await request.clone().json()) as object), id: ID(1501), version: 1 })),
  http.put(`${ORIGIN}/v1/anatomic/assays/:id`, async ({ request }) => HttpResponse.json({ ...assayRow(), ...((await request.clone().json()) as object), version: 6 })),
  http.get(`${ORIGIN}/v1/anatomic/coded-sets/:set/values`, ({ params }) =>
    page(params['set'] === 'diagnoses' ? [coded('LOC-0000', 'Synthetic old diagnosis', { is_active: false }), coded('LOC-0002', 'Synthetic diagnosis two')] : [coded('SATISF', 'Satisfactory')])),
  http.put(`${ORIGIN}/v1/anatomic/coded-sets/:set/values/:code`, async ({ request, params }) => HttpResponse.json({ ...coded(String(params['code']), 'x'), ...((await request.clone().json()) as object), version: 1 })),
  http.get(`${ORIGIN}/v1/anatomic/text-templates`, () => page([textTpl(1, 'nad'), textTpl(2, 'old', { is_active: false, section: 'comment' })])),
  http.post(`${ORIGIN}/v1/anatomic/text-templates`, async ({ request }) => created({ ...textTpl(9, 'new'), ...((await request.clone().json()) as object), is_active: true, version: 1 })),
  http.put(`${ORIGIN}/v1/anatomic/text-templates/:id`, async ({ request }) => HttpResponse.json({ ...textTpl(1, 'nad'), ...((await request.clone().json()) as object), version: 3 })),
  http.get(`${ORIGIN}/v1/anatomic/synoptic-templates`, () => page([tplSummary(0, 'syn_colon', 'draft'), tplSummary(1, 'syn_breast', 'published'), tplSummary(2, 'syn_old', 'retired')])),
  http.get(`${ORIGIN}/v1/anatomic/synoptic-templates/:id`, ({ params }) => HttpResponse.json(tpl({ id: params['id'] }))),
  http.post(`${ORIGIN}/v1/anatomic/synoptic-templates`, async ({ request }) => {
    const b = (await request.clone().json()) as { template_key: string; definition: Def };
    return created(tpl({ id: ID(1799), template_key: b.template_key, title: b.definition.title, applies_to_case_kinds: b.definition.applies_to_case_kinds, definition: b.definition, version: 1 }, b.definition));
  }),
  http.put(`${ORIGIN}/v1/anatomic/synoptic-templates/:id`, async ({ request, params }) => {
    const b = (await request.clone().json()) as { definition: Def };
    return HttpResponse.json(tpl({ id: params['id'], title: b.definition.title, definition: b.definition, version: 7 }, b.definition));
  }),
  http.post(`${ORIGIN}/v1/anatomic/synoptic-templates/:id/publish`, ({ params }) => HttpResponse.json(tpl({ id: params['id'], status: 'published', published_at: '2026-11-13T08:00:00.000Z', version: 7 }))),
  http.post(`${ORIGIN}/v1/anatomic/synoptic-templates/:id/retire`, ({ params }) => HttpResponse.json(tpl({ id: params['id'], status: 'retired', version: 8 }))),
  http.post(`${ORIGIN}/v1/anatomic/synoptic-templates/:id/new-version`, () => created(tpl({ id: ID(1750), version_no: 2, status: 'draft', version: 1 }))),
];
void api;
