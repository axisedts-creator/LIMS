// T0D-TESTMGMT-1 shared harness: synthetic fixtures + an MSW stand-in for the catalog API (contracts/openapi/catalog.yaml after T0C-TESTMGMT-1).
// Pages are rendered through their default exports (async server components) exactly like cattests1; no component or file names are pinned.
// Synthetic data only. Every non-GET request is recorded in `calls` so tests can pin method, path, headers and body.
import { render } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

export const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;

type TMState = {
  nav: { search: string; path: string };
  session: { permissions: string[] };
  navLog: string[];
  push: { mockClear: () => void; mock: { calls: unknown[][] } };
  replace: { mockClear: () => void };
  refresh: { mockReset: () => void; mockClear: () => void };
};
export const TM = (globalThis as unknown as { __TM: TMState }).__TM;

export const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000f${String(n).padStart(4, '0')}`;
export const READ = ['catalog.test.read'];
export const MANAGE = ['catalog.test.read', 'catalog.test.manage'];
export const PUBLISH = [...MANAGE, 'catalog.reference_range.publish'];

const AT = '2026-11-06T09:30:00.000Z';
const base = (n: number, o: Record<string, unknown> = {}) => ({ id: ID(n), is_active: true, version: 1, created_at: AT, updated_at: AT, ...o });
export const HAEM = base(1, { code: 'HAEM', name: 'Hematology', report_order: 10 });
export const BIOC = base(2, { code: 'BIOC', name: 'Biochemistry', report_order: 20 });
export const EDTA = base(11, { code: 'EDTA_WB', name: 'EDTA whole blood', report_label: 'EDTA WHOLE BLOOD' });
export const SERUM = base(12, { code: 'SERUM', name: 'Serum', report_label: 'SERUM' });
export const CAT1 = base(21, { department_id: HAEM.id, name: 'Routine haematology', display_order: 10, print_footer: false });
export const CAT2 = base(22, { department_id: BIOC.id, name: 'Lipid studies', display_order: 20, print_footer: true, footer_text: 'Fasting sample advised.' });
export const UNIT = base(31, { code: 'g_dL', display: 'g/dL' });
export const METHOD = base(41, { code: 'SLS', name: 'SLS haemoglobin', is_active: true });
export const VSET = base(51, { code: 'POSNEG', display: 'Positive/Negative', is_ordered: false, values: [] });

/** An analyte (parameter) of a test, in the shape of GET /v1/catalog/tests/{id}.analytes[]. */
export const analyte = (n: number, code: string, name: string, o: Record<string, unknown> = {}, cv: Record<string, unknown> = {}) => ({
  id: ID(n), code, name, print_name: name, report_subheading: '', sort_order: n * 10, is_active: true, version: 2, draft_version_id: null,
  current_version: { id: ID(n + 500), version_no: 1, status: 'published', result_type: 'numeric', unit_code: 'g_dL', decimals: 1, version: 1, ...cv },
  ...o,
});
export const A_HB = analyte(61, 'HB', 'Haemoglobin', { report_subheading: 'Red cell indices' });
export const A_RBC = analyte(62, 'RBC', 'Red blood cell count', { report_subheading: 'Red cell indices' });
export const A_MCV = analyte(63, 'MCV', 'Mean corpuscular volume', {}, { formula_expression: 'HB/RBC' });

type Rec = Record<string, any>;
export const testDetail = (n: number, code: string, name: string, o: Rec = {}) => ({
  id: ID(100 + n), code, name, department_id: HAEM.id, workflow_type: 'standard', report_order: 100, is_orderable: true, is_active: true,
  uses_existing_material: false, version: 3, short_name: code.toLowerCase(), display_name: `${name}, EDTA(${code})`, tags: [], category_id: CAT1.id,
  specimen_requirements: [{ specimen_type_id: EDTA.id, is_preferred: true }], analytes: [] as Rec[], tat_targets: [] as Rec[], stage_targets: [] as Rec[],
  ...o,
});
export const summary = (t: Rec) => ({
  id: t['id'], kind: 'test', code: t['code'], name: t['name'], department_id: t['department_id'], department_code: t['department_id'] === HAEM.id ? 'HAEM' : 'BIOC',
  workflow_type: t['workflow_type'], is_orderable: t['is_orderable'], is_active: t['is_active'], revision: 1,
  ...(t['short_name'] ? { short_name: t['short_name'] } : {}), ...(t['display_name'] ? { display_name: t['display_name'] } : {}),
  ...(t['category_id'] ? { category_id: t['category_id'], category_name: 'Routine haematology' } : {}),
  default_price_paisa: 25000,
});

export type Call = { method: string; path: string; search: string; headers: Headers; body: any };
export const calls: Call[] = [];
export const callsTo = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path));

export const S = {
  tests: [] as Rec[],
  analytes: {} as Record<string, Rec>, // by id, for GET /analytes/{id}
  rangeSets: {} as Record<string, Rec[]>, // by analyte id (reference-range-sets)
  criticalSets: {} as Record<string, Rec[]>,
  categories: [] as Rec[],
  panels: [] as Rec[],
  panelDetail: {} as Record<string, Rec>,
  commentCodes: [] as Rec[],
  units: [UNIT] as Rec[],
  specimens: [EDTA, SERUM] as Rec[],
  formula: ((_expr: string) => ({ valid: true, input_analyte_codes: [], dependency_order: [], chain_depth: 0, errors: [] })) as (expr: string) => Rec,
  failNext: undefined as undefined | { method: string; re: RegExp; status: number; code: string; errors?: Rec[] },
};
export function reset() {
  S.tests = []; S.analytes = {}; S.rangeSets = {}; S.criticalSets = {}; S.categories = [CAT1, CAT2]; S.panels = []; S.panelDetail = {}; S.commentCodes = [];
  S.units = [UNIT]; S.specimens = [EDTA, SERUM]; S.failNext = undefined;
  S.formula = () => ({ valid: true, input_analyte_codes: [], dependency_order: [], chain_depth: 0, errors: [] });
  calls.length = 0; TM.navLog.length = 0; TM.push.mockClear(); TM.replace.mockClear(); TM.refresh.mockReset(); TM.nav.search = ''; TM.nav.path = '/catalog/tests';
  TM.session.permissions = MANAGE;
}
export const loadTests = (...tests: Rec[]) => {
  S.tests = tests;
  for (const t of tests) for (const a of t['analytes'] as Rec[]) S.analytes[a['id']] = { ...a, versions: [a['current_version']] };
};

const page = (data: unknown[]) => HttpResponse.json({ data, page: { limit: 200 } });
const prob = (status: number, code: string, extra: Rec = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'x', status, code, ...extra }, { status });

export const api = setupServer(
  http.all(`${ORIGIN}/*`, async ({ request }) => {
    const u = new URL(request.url);
    let body: any;
    if (request.method !== 'GET') body = await request.clone().json().catch(() => undefined);
    calls.push({ method: request.method, path: u.pathname, search: u.search, headers: request.headers, body });
    const m = request.method;
    const p = u.pathname;
    const f = S.failNext;
    if (f && f.method === m && f.re.test(p)) { S.failNext = undefined; return prob(f.status, f.code, f.errors ? { errors: f.errors } : {}); }
    const id = (re: RegExp) => re.exec(p)?.[1];

    if (m === 'GET') {
      if (p === '/v1/catalog/tests') {
        const limit = Number(u.searchParams.get('limit') ?? 50);
        const cur = u.searchParams.get('cursor');
        const off = cur ? Number(cur.slice(1)) : 0;
        const rows = S.tests.map(summary);
        const more = rows.length > off + limit;
        return HttpResponse.json({ data: rows.slice(off, off + limit), page: { limit, ...(more ? { next_cursor: `c${off + limit}` } : {}) } });
      }
      let x = id(/^\/v1\/catalog\/tests\/([^/]+)$/);
      if (x) { const t = S.tests.find((r) => r['id'] === x); return t ? HttpResponse.json(t) : prob(404, 'common.not_found'); }
      x = id(/^\/v1\/catalog\/analytes\/([^/]+)$/);
      if (x) return S.analytes[x] ? HttpResponse.json(S.analytes[x]) : prob(404, 'common.not_found');
      x = id(/^\/v1\/catalog\/analytes\/([^/]+)\/reference-range-sets$/);
      if (x) return page(S.rangeSets[x] ?? []);
      x = id(/^\/v1\/catalog\/analytes\/([^/]+)\/critical-limit-sets$/);
      if (x) return page(S.criticalSets[x] ?? []);
      if (p === '/v1/catalog/departments') return page([HAEM, BIOC]);
      if (p === '/v1/catalog/specimen-types') return page(S.specimens);
      if (p === '/v1/catalog/units') return page(S.units);
      if (p === '/v1/catalog/methods') return page([METHOD]);
      if (p === '/v1/catalog/value-sets') return page([VSET]);
      if (p === '/v1/catalog/test-categories') return page(S.categories);
      if (p === '/v1/catalog/panels') return page(S.panels);
      x = id(/^\/v1\/catalog\/panels\/([^/]+)$/);
      if (x) return S.panelDetail[x] ? HttpResponse.json(S.panelDetail[x]) : prob(404, 'common.not_found');
      if (p === '/v1/catalog/comment-codes') return page(S.commentCodes);
      return page([]); // containers, centres, price lists, ... when a screen reads them
    }
    if (m === 'POST' && p === '/v1/catalog/orderables/resolve') return HttpResponse.json({ tests: S.tests.filter((t) => (body?.orderable_ids ?? []).includes(t['id'])).map((t) => ({ id: t['id'], code: t['code'], name: t['name'], is_active: true })), orderables: [], specimen_requirements: [], catalog_revision: 1 });
    if (m === 'POST' && p === '/v1/catalog/formulas/validate') return HttpResponse.json(S.formula(String(body?.expression ?? '')));
    if (m === 'POST' && p === '/v1/catalog/tests') return HttpResponse.json({ ...testDetail(900, String(body?.code ?? 'NEW'), String(body?.name ?? 'New')), ...body, id: ID(1900) }, { status: 201 });
    if (m === 'POST' && /\/analytes$/.test(p)) return HttpResponse.json({ ...analyte(900, String(body?.code ?? 'NEW'), String(body?.name ?? 'New')), id: ID(1901) }, { status: 201 });
    if (m === 'POST' && p === '/v1/catalog/test-categories') return HttpResponse.json({ ...CAT1, ...body, id: ID(1902), version: 1 }, { status: 201 });
    if (m === 'PATCH' || m === 'PUT' || m === 'POST') return HttpResponse.json({ ok: true, ...(body && typeof body === 'object' ? body : {}), id: ID(1999), version: 9, status: 'published', bands: body?.bands ?? [] });
    return prob(500, 'test.unmocked');
  }),
);

type Sp = Record<string, string>;
const PAGES = {
  tests: () => import('@/app/(staff)/catalog/tests/page'),
  test: () => import('@/app/(staff)/catalog/tests/[test_id]/page'),
  units: () => import('@/app/(staff)/catalog/units/page'),
  specimens: () => import('@/app/(staff)/catalog/specimens/page'),
  'comment-codes': () => import('@/app/(staff)/catalog/comment-codes/page'),
  panels: () => import('@/app/(staff)/catalog/panels/page'),
  panel: () => import('@/app/(staff)/catalog/panels/[panel_id]/page'),
} as const;
const PATHS: Record<keyof typeof PAGES, string> = { tests: '/catalog/tests', test: '/catalog/tests/x', units: '/catalog/units', specimens: '/catalog/specimens', 'comment-codes': '/catalog/comment-codes', panels: '/catalog/panels', panel: '/catalog/panels/x' };
/** Render a catalog page like Next does: the server page gets parsed params + search params, client parts read useSearchParams. */
export async function show(route: keyof typeof PAGES, opts: { params?: Sp; search?: string } = {}) {
  const search = (opts.search ?? '').replace(/^\?/, '');
  TM.nav.search = search;
  TM.nav.path = route === 'test' && opts.params?.['test_id'] ? `/catalog/tests/${opts.params['test_id']}` : route === 'panel' && opts.params?.['panel_id'] ? `/catalog/panels/${opts.params['panel_id']}` : PATHS[route];
  const mod = (await PAGES[route]()) as { default: (p: any) => Promise<React.ReactNode> };
  const ui = await mod.default({ params: Promise.resolve(opts.params ?? {}), searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(search))) });
  return render(<ToastProvider>{ui}</ToastProvider>);
}
/** The address the page navigated to, from the last router.push/replace. */
export const lastAddress = (): URL | undefined => { const a = TM.navLog.at(-1); return a ? new URL(a, 'http://x') : undefined; };
