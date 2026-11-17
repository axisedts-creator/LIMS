// T0D-TESTMGMT-1 shared kit (tester-owned): synthetic fixtures, an MSW stand-in for the catalog API (contracts/openapi/catalog.yaml after
// T0B-TESTMGMT-1), a call recorder and page mounting exactly as Next would (server page default export + client parts reading useSearchParams).
// Synthetic data only. No component or file name of the implementation is pinned; only routes (unchanged), address-bar state and API calls.
//
// PINNED SCREEN ADDRESSES (no route is added or removed; rs-c2.static pins routes.yaml):
//   /catalog/tests?view=details[&test=<id>][&form=new|edit|copy][&parameter=new|<analyte_id>]   two-pane Test Details + both forms
//   /catalog/tests?view=categories | popular | complete                                         category, popular test and complete test list screens
//   /catalog/tests/<id>?tab=ranges&analyte=<analyte_id>                                          reference range manager (existing route)
//   /catalog/panels/<id>                                                                         profile / package two-list picker (existing route)
//   /catalog/comment-codes (notes), /catalog/units, /catalog/specimens                          existing routes, compact density
import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

export const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
export const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000f${String(n).padStart(4, '0')}`;

export const tm = (): { search: string; pathname: string; permissions: string[]; navLog: string[] } =>
  ((globalThis as any).__TM ??= { search: '', pathname: '/catalog/tests', permissions: ['catalog.test.read', 'catalog.test.manage'], navLog: [] });
export const READ = ['catalog.test.read'];
export const MANAGE = ['catalog.test.read', 'catalog.test.manage'];
export const PUBLISH = [...MANAGE, 'catalog.reference_range.publish'];

const iso = '2026-11-05T04:15:00.000Z';
const base = { version: 1, created_at: iso, updated_at: iso };
export const HAEM = { id: ID(1), code: 'HAEM', name: 'Hematology', report_order: 10, is_active: true, ...base };
export const BIOC = { id: ID(2), code: 'BIOC', name: 'Biochemistry', report_order: 20, is_active: true, ...base };
export const EDTA = { id: ID(11), code: 'EDTA_WB', name: 'EDTA whole blood', report_label: 'EDTA WB', is_active: true, ...base };
export const SERUM = { id: ID(12), code: 'SERUM', name: 'Serum', report_label: 'SERUM', is_active: true, ...base };
export const CAT_A = { id: ID(21), department_id: HAEM.id, name: 'Routine haematology', display_order: 10, print_footer: true, footer_text: 'Synthetic footer', is_active: true, version: 2 };
export const CAT_B = { id: ID(22), department_id: BIOC.id, name: 'Lipid studies', display_order: 20, print_footer: false, is_active: true, version: 1 };
export const UNIT_GDL = { id: ID(31), code: 'g_dL', name: 'g/dL', is_active: true, ...base };
export const VALUE_SET = { id: ID(41), code: 'URINE_GRADE', name: 'Urine grade', is_active: true, ...base };

export type Analyte = ReturnType<typeof analyte>;
export const analyte = (n: number, code: string, name: string, o: Record<string, unknown> = {}) => ({
  id: ID(300 + n), test_id: ID(101), code, name, print_name: name, report_subheading: n <= 2 ? 'Red cells' : 'White cells', sort_order: n * 10, is_reportable: true,
  is_active: true, version: 3, draft_version_id: null,
  current_version: { id: ID(400 + n), analyte_id: ID(300 + n), version_no: 1, status: 'published', result_type: 'numeric', unit_code: 'g_dL', decimals: 1, version: 3 },
  ...o,
});
export const HB = analyte(1, 'HB', 'Hemoglobin');
export const RBC = analyte(2, 'RBC', 'Red blood cells');
export const WBC = analyte(3, 'WBC', 'White blood cells');
export const SPACE = analyte(4, 'SP1', 'Space', { current_version: { ...HB.current_version, id: ID(404), analyte_id: ID(304), result_type: 'space' } });

export const testDetail = (n: number, code: string, name: string, dept = HAEM, o: Record<string, unknown> = {}) => ({
  id: ID(100 + n), code, name, department_id: dept.id, workflow_type: 'standard', report_order: 100, is_orderable: true, is_active: true, uses_existing_material: false,
  specimen_requirements: [{ specimen_type_id: EDTA.id, is_preferred: true }], analytes: [] as unknown[], tat_targets: [], version: 4,
  short_name: code, display_name: `${name.toUpperCase()}, EDTA WB(${code})`, tags: [code.toLowerCase()], barcode_text: code, loyalty_points: 0, display_order: 10,
  report_type: 'four_column', processing_type: 'local', is_popular: false, category_id: CAT_A.id, stage_targets: [], ...o,
});
export const T_CBC = testDetail(1, 'CBC', 'Complete blood count', HAEM, { tags: ['anaemia', 'blood'], analytes: [HB, RBC, WBC], is_popular: true });
export const T_GLU = testDetail(2, 'GLU', 'Glucose fasting', BIOC, { tags: ['sugar'], category_id: CAT_B.id });
export const T_TSH = testDetail(3, 'TSH', 'Thyroid stimulating hormone', BIOC, { tags: ['thyroid'], category_id: CAT_B.id });
export const T_EMPTY = testDetail(4, 'EMP', 'Empty test', HAEM, { analytes: [] });
export let TESTS: ReturnType<typeof testDetail>[] = [T_CBC, T_GLU, T_TSH, T_EMPTY];
export const setTests = (t: typeof TESTS) => { TESTS = t; };

const summary = (t: ReturnType<typeof testDetail>) => ({
  id: t.id, kind: 'test', code: t.code, name: t.name, department_id: t.department_id, department_code: t.department_id === HAEM.id ? 'HAEM' : 'BIOC', workflow_type: 'standard',
  is_orderable: true, is_active: t.is_active, revision: 1, category_id: t.category_id, category_name: t.category_id === CAT_A.id ? CAT_A.name : CAT_B.name,
  short_name: t.short_name, display_name: t.display_name, default_price_paisa: 50000,
  is_popular: t.is_popular, // API GAP: not on OrderableSummary today; the Popular screen needs it (see notes)
});

export const PANEL = { id: ID(800), kind: 'panel', code: 'LIPID', name: 'Lipid profile', department_id: BIOC.id, department_code: 'BIOC', panel_kind: 'clinical', workflow_type: 'standard', is_orderable: true, is_active: true, revision: 1, members: [{ kind: 'test', orderable_id: T_GLU.id, sort_order: 1 }], version: 6 };

export interface Call { method: string; path: string; search: string; headers: Headers; body: any }
export const calls: Call[] = [];
export const mutations = () => calls.filter((c) => c.method !== 'GET');
export const to = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path));
const prob = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'x', status, code, ...extra }, { status });
export const problem = prob;

/** Per-test overrides: key "METHOD /path-regex-source" → response factory. */
export const overrides = new Map<string, (c: Call) => Response>();
const rec = (fallback: (c: Call) => Response) => async ({ request }: { request: Request }) => {
  const u = new URL(request.url);
  const c: Call = { method: request.method, path: u.pathname, search: u.search, headers: request.headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.clone().json().catch(() => undefined) };
  calls.push(c);
  for (const [k, f] of overrides) { const [m, src] = k.split(' ', 2) as [string, string]; if (m === c.method && new RegExp(src).test(c.path)) return f(c); }
  return fallback(c);
};
const page = (data: unknown[]) => HttpResponse.json({ data, page: { limit: 200 } });

export const rangeSet = (status: string, bands: unknown[], o: Record<string, unknown> = {}) => ({ id: ID(600), analyte_id: HB.id, version_no: 2, status, bands, version: 5, ...o });
export const BAND_M = { sex: 'male', kind: 'numeric', sort_order: 1, age_low: { value: 18, unit: 'year' }, age_high: { value: 60, unit: 'year' }, low: '13.0', high: '17.0', default_range: true, display_text: 'Adult male', auto_approved_low: '12.0', auto_approved_high: '18.0' };
export const BAND_F = { sex: 'female', kind: 'numeric', sort_order: 2, age_low: { value: 18, unit: 'year' }, age_high: { value: 60, unit: 'year' }, low: '12.0', high: '15.5' };
export let RANGE_SETS: unknown[] = [];
export let CRIT_SETS: unknown[] = [];
export const setSets = (r: unknown[], c: unknown[] = []) => { RANGE_SETS = r; CRIT_SETS = c; };

export const api = setupServer(
  http.get(`${ORIGIN}/v1/catalog/tests`, rec((c) => {
    const q = new URLSearchParams(c.search);
    const limit = Number(q.get('limit') ?? 50);
    const off = q.get('cursor') ? Number(String(q.get('cursor')).slice(1)) : 0;
    const rows = TESTS.filter((t) => (q.get('is_active') === 'all' || t.is_active) && (!q.get('category_id') || t.category_id === q.get('category_id')));
    const data = rows.slice(off, off + limit).map(summary);
    return HttpResponse.json({ data, page: { limit, ...(rows.length > off + limit ? { next_cursor: `c${off + limit}` } : {}) } });
  })),
  http.post(`${ORIGIN}/v1/catalog/tests`, rec((c) => HttpResponse.json({ ...testDetail(90, c.body?.code ?? 'NEW', c.body?.name ?? 'New'), ...c.body, id: ID(190) }, { status: 201 }))),
  http.get(`${ORIGIN}/v1/catalog/tests/:id`, rec((c) => { const t = TESTS.find((x) => c.path.endsWith(x.id)); return t ? HttpResponse.json(t) : prob(404, 'common.not_found'); })),
  http.patch(`${ORIGIN}/v1/catalog/tests/:id`, rec((c) => HttpResponse.json({ ...(TESTS.find((x) => c.path.endsWith(x.id)) ?? T_CBC), ...c.body, version: 5 }))),
  http.put(`${ORIGIN}/v1/catalog/tests/:id/tat-targets`, rec(() => HttpResponse.json({ targets: [], stage_targets: [] }))),
  http.put(`${ORIGIN}/v1/catalog/tests/:id/specimen-requirements`, rec(() => HttpResponse.json({ data: [] }))),
  http.post(`${ORIGIN}/v1/catalog/tests/:id/analytes`, rec((c) => HttpResponse.json({ ...analyte(9, String(c.body?.code ?? 'NEW'), String(c.body?.name ?? 'New')), id: ID(399) }, { status: 201 }))),
  http.get(`${ORIGIN}/v1/catalog/analytes/:id`, rec((c) => {
    const a = [HB, RBC, WBC, SPACE].find((x) => c.path.endsWith(x.id));
    return a ? HttpResponse.json({ ...a, versions: [a.current_version] }) : prob(404, 'common.not_found');
  })),
  http.patch(`${ORIGIN}/v1/catalog/analytes/:id`, rec((c) => HttpResponse.json({ ...HB, ...c.body, version: 4 }))),
  http.post(`${ORIGIN}/v1/catalog/analytes/:id/versions`, rec(() => HttpResponse.json({ ...HB.current_version, id: ID(450), status: 'draft', version_no: 2 }, { status: 201 }))),
  http.patch(`${ORIGIN}/v1/catalog/analyte-versions/:id`, rec((c) => HttpResponse.json({ ...HB.current_version, status: 'draft', ...c.body, version: 4 }))),
  http.post(`${ORIGIN}/v1/catalog/formulas/validate`, rec(() => HttpResponse.json({ valid: true, input_analyte_codes: ['HB'], dependency_order: ['HB'], chain_depth: 1, errors: [] }))),
  http.get(`${ORIGIN}/v1/catalog/analytes/:id/reference-range-sets`, rec(() => HttpResponse.json({ data: RANGE_SETS }))),
  http.get(`${ORIGIN}/v1/catalog/analytes/:id/critical-limit-sets`, rec(() => HttpResponse.json({ data: CRIT_SETS }))),
  http.post(`${ORIGIN}/v1/catalog/analytes/:id/reference-range-sets`, rec(() => HttpResponse.json(rangeSet('draft', []), { status: 201 }))),
  http.put(`${ORIGIN}/v1/catalog/reference-range-sets/:id/bands`, rec((c) => HttpResponse.json(rangeSet('draft', c.body?.bands ?? [])))),
  http.post(`${ORIGIN}/v1/catalog/reference-range-sets/:id/publish`, rec(() => HttpResponse.json(rangeSet('published', [BAND_M])))),
  http.put(`${ORIGIN}/v1/catalog/critical-limit-sets/:id/bands`, rec((c) => HttpResponse.json({ ...rangeSet('draft', c.body?.bands ?? []), id: ID(700) }))),
  http.post(`${ORIGIN}/v1/catalog/reference-ranges/preview`, rec(() => HttpResponse.json({ matched: false }))),
  http.get(`${ORIGIN}/v1/catalog/panels/:id`, rec(() => HttpResponse.json(PANEL))),
  http.put(`${ORIGIN}/v1/catalog/panels/:id/members`, rec((c) => HttpResponse.json({ ...PANEL, members: c.body?.members ?? [], version: 7 }))),
  http.get(`${ORIGIN}/v1/catalog/test-categories`, rec(() => page([CAT_A, CAT_B]))),
  http.post(`${ORIGIN}/v1/catalog/test-categories`, rec((c) => HttpResponse.json({ ...CAT_A, ...c.body, id: ID(23), version: 1 }, { status: 201 }))),
  http.patch(`${ORIGIN}/v1/catalog/test-categories/:id`, rec((c) => HttpResponse.json({ ...CAT_A, ...c.body, version: 3 }))),
  http.get(`${ORIGIN}/v1/catalog/departments`, rec(() => page([HAEM, BIOC]))),
  http.get(`${ORIGIN}/v1/catalog/specimen-types`, rec(() => page([EDTA, SERUM]))),
  http.get(`${ORIGIN}/v1/catalog/units`, rec(() => page([UNIT_GDL]))),
  http.get(`${ORIGIN}/v1/catalog/value-sets`, rec(() => page([VALUE_SET]))),
  http.get(`${ORIGIN}/v1/catalog/*`, rec(() => page([]))), // methods, containers, comment codes, panels, ... when a screen reads them
);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; overrides.clear(); tm().navLog.length = 0; tm().search = ''; setTests([T_CBC, T_GLU, T_TSH, T_EMPTY]); setSets([]); tm().permissions = MANAGE; });
afterAll(() => api.close());

type Sp = Record<string, string>;
type PageFn = (p: { searchParams: Promise<Sp>; params?: Promise<Record<string, string>> }) => Promise<React.ReactNode>;
async function mount(load: () => Promise<{ default: unknown }>, pathname: string, search: string, params?: Record<string, string>) {
  tm().pathname = pathname; tm().search = search.replace(/^\?/, '');
  const Page = (await load()).default as PageFn;
  const ui = await Page({ searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(tm().search))), ...(params ? { params: Promise.resolve(params) } : {}) });
  return render(<ToastProvider>{ui}</ToastProvider>);
}
export const mountTests = (search = '') => mount(() => import('@/app/(staff)/catalog/tests/page'), '/catalog/tests', search);
export const mountTest = (id: string, search = '') => mount(() => import('@/app/(staff)/catalog/tests/[test_id]/page'), `/catalog/tests/${id}`, search, { test_id: id });
export const mountPanel = (id: string, search = '') => mount(() => import('@/app/(staff)/catalog/panels/[panel_id]/page'), `/catalog/panels/${id}`, search, { panel_id: id });
export const mountUnits = () => mount(() => import('@/app/(staff)/catalog/units/page'), '/catalog/units', '');
export const mountNotes = () => mount(() => import('@/app/(staff)/catalog/comment-codes/page'), '/catalog/comment-codes', '');
export const mountSpecimens = () => mount(() => import('@/app/(staff)/catalog/specimens/page'), '/catalog/specimens', '');
