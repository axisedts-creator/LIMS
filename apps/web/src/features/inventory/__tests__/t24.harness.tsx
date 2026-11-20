// C12.T-24 shared test harness (tester-owned; not a test file). MSW plays the C12 API (contracts/openapi/inventory.yaml), the C2 /me endpoint and the C3/C7 read-only neighbours; BFF server code runs for real.
// Each test file registers three mocks pointing here (vi.mock is hoisted, so the factories import this lazily):
//   vi.mock('next/navigation', async () => (await import('./t24.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t24.harness')).sessionMock)
// LD-140 (2026-11-13): kit components only, list + right Drawer + per-section Save, ONE primary button per page, every status shows tone + icon + word.
// CONTRACT PINNED BY THESE TESTS (writer: make these exports exist; data shapes are the spec's, the seams are mine):
//   app/(staff)/inventory/rules/page.tsx        default async Page({ searchParams: Promise })  S13 (route staff.inventory.rules, needs inventory.item.read; else testid permission-denied, no API call).
//        Query: kind -> rule_kind, test -> test_id, analyser -> instrument_id, item -> item_id, history=1 -> current_only=false (default: current_only=true is sent or omitted).
//        Grid columns: Kind, Test, Analyte, Analyser ("Any analyser" when null), Item, Quantity, Effective from, Status (Current / Superseded / Inactive: tone + icon + word).
//        Names are joined client/BFF side: tests = GET /v1/catalog/tests, analytes = GET /v1/catalog/tests/{id}/analytes, analysers = GET /v1/instruments/instruments, items = GET /v1/inventory/items.
//        "New rule" button (needs inventory.master.manage; the page's ONE primary button) opens a Drawer (role dialog) named "New consumption rule" = the create form.
//        Row buttons (need inventory.master.manage): "Change quantity" (current rows only) -> dialog with the supersede copy; "Deactivate" (current rows only).
//   app/(staff)/inventory/unresolved/page.tsx   default async Page({ searchParams })  S15 (route staff.inventory.unresolved, needs inventory.item.read). GET /consumption-facts?status=unresolved.
//        Grid columns: Occurred, Kind, Analyser, Test, Reason (text "No store found"). Row buttons (need inventory.master.manage): "Post to store…" (Select store -> POST /resolve) and "Dismiss" (Select reason from /coded-sets/reasons?reason_group=fact_dismiss -> POST /dismiss).
//   app/(staff)/inventory/reports/page.tsx     default async Page({ searchParams })  S17 (route staff.inventory.reports, needs inventory.item.read). Query: report=<report_code> (default daily_consumption), from / to = YYYY-MM-DD
//        (default: the last 30 days) -> business_date_from / business_date_to, store -> store_id, analyser -> instrument_id, test -> test_id, item -> item_id, as_of (valuation), within_days (expiry).
//        Tabs (kit Tabs, role tab): Daily consumption | Analyser-wise | Cost per test (needs inventory.cost.read) | Wastage | Expiry | Valuation | Reconciliation (only when GET /v1/identity/me .centre_scope.all === true; fails closed).
//        "Export CSV" = a link (role link, name /export csv/i) to /inventory/reports/<report_code>/export?<same query>, rendered only with inventory.report.export (cost_per_test additionally needs inventory.cost.read).
//   app/(staff)/inventory/reports/[report_code]/export/route.ts   export async function GET(req: Request, ctx: { params: Promise<{ report_code: string }> }): Response
//        BFF proxy to GET /v1/inventory/reports/{code}/export.csv with the SAME query string and the session Bearer (never reaches the browser). Passes through 200 text/csv (+ attachment content-disposition), maps upstream 403/404/422
//        to the same status with an EMPTY body (no upstream text echoed), anything else non-2xx to 502; unknown report_code -> 400 without calling the API; no token -> 401.
//   app/(staff)/inventory/{rules,unresolved,reports}/{loading,error}.tsx  (checked statically only)
//   Writes go through the BFF with Idempotency-Key where the operation says `required`. Never a token in the browser.
//   Failures: kit Banner (role alert) with title + request_id; auth.mfa_required -> Banner mentioning "verif…" with the form kept open.
// Synthetic data only.
import { vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;

export const state = { permissions: [] as string[], token: 'jwt-synthetic' as string | undefined, path: '/inventory/rules', allCentres: true };
export const sessionMock = {
  getAccessToken: async () => state.token,
  getShellSession: async () => ({ actor: { permissions: state.permissions, displayName: 'Synthetic Lab Manager', membershipId: ID(900), tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => state.path,
};
export const router: Record<'push' | 'replace' | 'refresh' | 'back', ReturnType<typeof vi.fn>> = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
export const navigationMock: { useRouter: () => typeof router; usePathname: () => string; useSearchParams: () => URLSearchParams; notFound: () => never; redirect: (to: string) => never } = {
  useRouter: () => router,
  usePathname: () => state.path,
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
};

export const ID = (n: number) => `01950c12-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const IDEM_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const PERM_READ = ['inventory.item.read'];
export const PERM_MANAGE = ['inventory.item.read', 'inventory.master.manage'];
export const PERM_COST = ['inventory.item.read', 'inventory.cost.read'];
export const PERM_EXPORT = ['inventory.item.read', 'inventory.report.export'];
export const PERM_EXPORT_COST = ['inventory.item.read', 'inventory.report.export', 'inventory.cost.read'];
export const PERM_NONE: string[] = [];

export const isoAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
export const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, request_id: 'req-syn-0024', ...extra }, { status });

// ---------------------------------------------------------------- fixtures (schemas Rule, Fact, ReportResult, ColumnMeta, ReportRow)
export const rule = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(800 + n), rule_kind: 'per_test', test_id: ID(70), instrument_id: ID(950), item_id: ID(11), qty_base: '1', entered_qty: '1', effective_from: isoAgo(72), is_active: true, version: 1, ...over,
});
export const fact = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(850 + n), fact_kind: 'test', source: 'event', status: 'unresolved', instrument_id: ID(950), test_id: ID(70), occurred_at: isoAgo(5), business_date: dayAgo(0), multiplier: 1, rules_applied: 1, movements: [], version: 1, ...over,
});
export const col = (key: string, label: string, is_cost = false) => ({ key, label, is_cost });

const baseParams = { business_date_from: dayAgo(30), business_date_to: dayAgo(0) };
export const reportFixtures: Record<string, any> = {
  daily_consumption: {
    report_code: 'daily_consumption', params: baseParams,
    columns: [col('business_date', 'Date'), col('item_code', 'Item'), col('movement_kind', 'Kind'), col('qty_consumed', 'Quantity'), col('value_consumed_paisa', 'Value', true)],
    rows: [
      { business_date: dayAgo(2), item_code: 'GLU-R1', item_name: 'Synthetic glucose reagent', movement_kind: 'consume_test', qty_consumed: '12', value_consumed_paisa: 30000 },
      { business_date: dayAgo(1), item_code: 'GLU-R1', item_name: 'Synthetic glucose reagent', movement_kind: 'consume_qc', qty_consumed: '3', value_consumed_paisa: 7500 },
    ],
    totals: { qty_consumed: '15', value_consumed_paisa: 37500 }, generated_at: isoAgo(0), truncated: false,
  },
  analyser_consumption: {
    report_code: 'analyser_consumption', params: baseParams,
    columns: [col('instrument_label', 'Analyser'), col('item_code', 'Item'), col('movement_kind', 'Kind'), col('qty_consumed', 'Quantity'), col('value_consumed_paisa', 'Value', true)],
    rows: [{ instrument_id: ID(950), instrument_label: 'BIO-1', item_code: 'GLU-R1', movement_kind: 'consume_test', qty_consumed: '12', value_consumed_paisa: 30000, tests: [{ test_id: ID(70), test_code: 'GLU', tests_counted: 12, rerun_events: 1, qc_events: 3 }] }],
    totals: { qty_consumed: '12', value_consumed_paisa: 30000 }, generated_at: isoAgo(0), truncated: false,
  },
  cost_per_test: {
    report_code: 'cost_per_test', params: baseParams,
    columns: [col('test_code', 'Test'), col('instrument_label', 'Analyser'), col('tests_counted', 'Tests'), col('cpt_direct_paisa', 'Direct CPT', true), col('cpt_loaded_paisa', 'Loaded CPT', true), col('cpt_standard_paisa', 'Standard CPT', true)],
    rows: [
      { test_id: ID(70), test_code: 'GLU', instrument_id: ID(950), instrument_label: 'BIO-1', tests_counted: 12, direct_value_paisa: 30000, fixed_share_paisa: 6000, cpt_direct_paisa: 2500, cpt_loaded_paisa: 3000, cpt_standard_paisa: 2800, standard_is_complete: true,
        breakdown: [{ movement_kind: 'consume_test', value_paisa: 27000 }, { movement_kind: 'consume_qc', value_paisa: 3000 }] },
      { test_id: ID(71), test_code: 'CREA', instrument_id: ID(950), instrument_label: 'BIO-1', tests_counted: 8, direct_value_paisa: 16000, fixed_share_paisa: 4000, cpt_direct_paisa: 2000, cpt_loaded_paisa: 2500, cpt_standard_paisa: 2200, standard_is_complete: false, breakdown: [] },
    ],
    totals: { tests_counted: 20 }, generated_at: isoAgo(0), truncated: false,
  },
  wastage: {
    report_code: 'wastage', params: baseParams,
    columns: [col('category', 'Category'), col('item_code', 'Item'), col('qty', 'Quantity'), col('value_paisa', 'Value', true)],
    rows: [
      { category: 'wastage', item_code: 'GLU-R1', qty: '2', value_paisa: 5000 },
      { category: 'expiry_writeoff', item_code: 'GLU-R1', qty: '5', value_paisa: 12500 },
      { category: 'count_variance', item_code: 'TIPS-2', qty: '1', value_paisa: 100 },
    ],
    totals: { qty: '8', value_paisa: 17600 }, generated_at: isoAgo(0), truncated: false,
  },
  expiry: {
    report_code: 'expiry', params: { ...baseParams, within_days: 30 },
    columns: [col('store_code', 'Store'), col('item_code', 'Item'), col('lot_no', 'Lot'), col('expiry_on', 'Expiry'), col('days_to_expiry', 'Days to expiry'), col('qty_base', 'On hand')],
    rows: [
      { store_code: 'BR1-ST1', item_code: 'GLU-R1', lot_no: 'L-SYN-001', expiry_on: dayAgo(-10), days_to_expiry: 10, qty_base: '400', lot_status: 'available' },
      { store_code: 'BR1-ST1', item_code: 'GLU-R1', lot_no: 'L-SYN-000', expiry_on: dayAgo(3), days_to_expiry: -3, qty_base: '20', lot_status: 'available' },
    ],
    totals: { qty_base: '420' }, generated_at: isoAgo(0), truncated: false,
  },
  stock_valuation: {
    report_code: 'stock_valuation', params: { ...baseParams, as_of: isoAgo(0) },
    columns: [col('store_code', 'Store'), col('item_code', 'Item'), col('lot_no', 'Lot'), col('qty_base', 'Quantity'), col('value_paisa', 'Value', true)],
    rows: [{ store_code: 'BR1-ST1', item_code: 'GLU-R1', lot_no: 'L-SYN-001', qty_base: '400', value_paisa: 100000 }],
    totals: { qty_base: '400', value_paisa: 100000 }, generated_at: isoAgo(0), truncated: false,
  },
  consumption_reconciliation: {
    report_code: 'consumption_reconciliation', params: baseParams,
    columns: [col('business_date', 'Date'), col('test_code', 'Test'), col('tests_counted', 'C12 verified'), col('lab_results_verified', 'Lab verified'), col('diff', 'Difference')],
    rows: [
      { business_date: dayAgo(1), test_id: ID(70), test_code: 'GLU', tests_counted: 98, lab_results_verified: 100, diff: -2, diff_bp: 200 },
      { business_date: dayAgo(1), instrument_id: ID(950), instrument_label: 'BIO-1', qc_events: 6, instrument_qc_records: 7, diff: -1 },
    ],
    totals: {}, generated_at: isoAgo(0), truncated: false,
  },
};
/** Cost cells are dropped by the API for callers without inventory.cost.read (AC-21.9); the fixture mirrors that. */
export const withoutCost = (r: any) => {
  const cost = new Set<string>(r.columns.filter((c: any) => c.is_cost).map((c: any) => c.key));
  const strip = (o: any) => Object.fromEntries(Object.entries(o).filter(([k]) => !cost.has(k) && !/_paisa$/.test(k)));
  return { ...r, columns: r.columns.filter((c: any) => !c.is_cost), rows: r.rows.map(strip), totals: strip(r.totals) };
};

// ---------------------------------------------------------------- fake API
export type Hit = { method: string; path: string; search: string; headers: Headers; body: string; json?: any };
export const hits: Hit[] = [];
export const hit = (method: string, pathRe: RegExp) => hits.filter((h) => h.method === method && pathRe.test(h.path));
export const page = <T,>(data: T[], next?: string) => HttpResponse.json({ data, page: { limit: 50, ...(next ? { next_cursor: next } : {}) } });

const reasonSets: Record<string, { code: string; display: string }[]> = {
  fact_dismiss: [{ code: 'not_consumed', display: 'Not consumed' }, { code: 'duplicate_entry', display: 'Duplicate entry' }, { code: 'test_instrument', display: 'Test instrument' }, { code: 'other', display: 'Other' }],
};
const store = (n: number) => ({ id: ID(300 + n), branch_id: ID(401), branch_name: 'Synthetic Branch BR-1', store_code: `BR1-ST${n}`, name: `Synthetic store ${n}`, store_kind: 'main', is_default_consumption: n === 1, is_active: true, version: 1 });
export const itemSummary = (n: number) => ({ id: ID(10 + n), item_code: n === 1 ? 'GLU-R1' : `TIPS-${n}`, name: n === 1 ? 'Synthetic glucose reagent' : `Synthetic pipette tips ${n}`, category: 'reagent', base_uom_code: 'test', is_lot_tracked: true, requires_expiry: true, is_active: true, version: 1 });
const packs = (n: number) => [{ id: ID(100 * n + 1), item_id: ID(10 + n), pack_code: 'BOX', label: 'BOX (400 test)', uom_code: 'box', qty_in_base: '400', is_purchase_default: true, is_active: true, version: 1 }];

/** Default handlers; tests override with api.use(...). Every request is logged first. */
export const api = setupServer(
  http.get(`${ORIGIN}/v1/identity/me`, () => HttpResponse.json({ display_name: 'Synthetic Lab Manager', email: 'syn@example.test', roles: [], centre_scope: { all: state.allCentres, centre_ids: [] }, mfa: { enrolled: true, level: 'aal2' } })),
  http.get(`${ORIGIN}/v1/inventory/stores`, () => page([store(1), store(2)])),
  http.get(`${ORIGIN}/v1/inventory/items`, ({ request }) => {
    const q = (new URL(request.url).searchParams.get('q') ?? '').toUpperCase();
    return page([itemSummary(1), itemSummary(2)].filter((i) => !q || i.item_code.startsWith(q) || i.name.toUpperCase().startsWith(q)));
  }),
  http.get(`${ORIGIN}/v1/inventory/items/:id`, ({ params }) => { const n = Number(String(params['id']).slice(-2)) - 10 || 1; return HttpResponse.json({ ...itemSummary(n), packs: packs(n), barcodes: [], updated_at: isoAgo(24) }); }),
  http.get(`${ORIGIN}/v1/inventory/coded-sets/:set`, ({ params, request }) => {
    if (String(params['set']) === 'reasons') return page((reasonSets[new URL(request.url).searchParams.get('reason_group') ?? ''] ?? []).map((r, i) => ({ ...r, sort_order: i + 1, is_active: true })));
    return HttpResponse.json({ type: 'urn:lims:error:common.not_found', title: 'common.not_found', status: 404, code: 'common.not_found' }, { status: 404 });
  }),
  http.get(`${ORIGIN}/v1/catalog/tests`, () => page([{ id: ID(70), code: 'GLU', name: 'Glucose', is_active: true, version: 1 }, { id: ID(71), code: 'CREA', name: 'Creatinine', is_active: true, version: 1 }])),
  http.get(`${ORIGIN}/v1/catalog/tests/:id/analytes`, () => page([{ id: ID(80), test_id: ID(70), code: 'GLU_F', name: 'Fasting glucose', sort_order: 1, is_active: true, version: 1 }])),
  http.get(`${ORIGIN}/v1/instruments/instruments`, () => page([{ id: ID(950), instrument_code: 'BIO-1', display_name: 'Synthetic chemistry analyser 1', state: 'live', version: 1 }, { id: ID(951), instrument_code: 'BIO-2', display_name: 'Synthetic chemistry analyser 2', state: 'live', version: 1 }])),
  http.get(`${ORIGIN}/v1/inventory/consumption-rules`, () => page([rule(1), rule(2, { rule_kind: 'per_analyte', analyte_id: ID(80), instrument_id: undefined, qty_base: '2', entered_qty: '2' })])),
  http.get(`${ORIGIN}/v1/inventory/consumption-facts`, () => page([fact(1), fact(2, { fact_kind: 'qc', test_id: ID(71), instrument_id: undefined })])),
  http.get(`${ORIGIN}/v1/inventory/reports/:code`, ({ params }) => HttpResponse.json(reportFixtures[String(params['code'])] ?? { type: 'urn:lims:error:common.not_found', status: 404, code: 'common.not_found' }, { status: reportFixtures[String(params['code'])] ? 200 : 404 })),
);
api.events.on('request:start', async ({ request }) => {
  const u = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
  let json: any;
  try { json = body && (request.headers.get('content-type') ?? '').includes('json') ? JSON.parse(body) : undefined; } catch { /* not json */ }
  hits.push({ method: request.method, path: u.pathname, search: u.search, headers: request.headers, body, json });
});
export const resetHits = () => { hits.length = 0; };
