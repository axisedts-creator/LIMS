// C12.T-23 shared test harness (tester-owned; not a test file). MSW plays the C12 API (contracts/openapi/inventory.yaml) plus the C3/C7 read-only neighbours; BFF server code runs for real.
// Each test file registers three mocks pointing here (vi.mock is hoisted, so the factories import this lazily):
//   vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock)
// LD-140 (2026-11-13): kit components only, list + right Drawer + per-section Save, ONE primary button per page, every status shows tone + icon + word.
// CONTRACT PINNED BY THESE TESTS (writer: make these exports exist; data shapes are the spec's, the seams are mine):
//   app/(staff)/inventory/stock/page.tsx          default async Page({ searchParams })  S8 (route staff.inventory.stock). ?store=<id> picks the store (default: first visible store from GET /stores).
//                                                 Row actions (buttons inside the row): "Issue", "Transfer", "Wastage", "Movements" (hidden without inventory.stock.manage). "Issue" opens a Drawer (role dialog) titled "Issue stock".
//   app/(staff)/inventory/wastage/page.tsx        S10, Tabs "Wastage" | "Adjustment" (only with inventory.stock.adjust) | "Expiry write-off"; ?store=<id>.
//   app/(staff)/inventory/transfers/page.tsx      S9 list + "New transfer" Drawer; ?transfer=<id> opens the detail Drawer (Dispatch / Receive / Cancel).
//   app/(staff)/inventory/counts/page.tsx         S11 list + "New count" Drawer.
//   app/(staff)/inventory/counts/[count_id]/page.tsx  S11 count entry: default async Page({ params: Promise<{count_id}>, searchParams }); GET 404 -> notFound().
//   app/(staff)/inventory/bench/page.tsx          S12 (route staff.inventory.bench; needs inventory.bench.record, else testid permission-denied); ?store=<id>.
//   app/(staff)/inventory/{stock,wastage,transfers,counts,bench}/{loading,error}.tsx  (checked statically only)
//   Data sources: stores = GET /stores (visible stores; bench stores listed first on S12); transfer targets = GET /stores?purpose=transfer_target; balances = GET /stock;
//   FEFO preview = GET /fefo-suggestions?store_id&item_id&qty_base; departments = GET /v1/catalog/departments; analysers = GET /v1/instruments/instruments;
//   tests/analytes = GET /v1/catalog/tests, GET /v1/catalog/tests/{id}/analytes; reason pickers = GET /coded-sets/{wastage|adjustment|transfer_discrepancy|calibration}.
//   Writes go through the BFF with Idempotency-Key where the operation says `required`, If-Match `"<version>"` where the row exists. Never a token in the browser.
//   Failures: kit Banner (role alert) with request_id; auth.mfa_required -> Banner mentioning "verif…" with the form kept open and values kept.
// Synthetic data only.
import { vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;

export const state = { permissions: [] as string[], token: 'jwt-synthetic' as string | undefined, path: '/inventory/stock' };
export const sessionMock = {
  getAccessToken: async () => state.token,
  getShellSession: async () => ({ actor: { permissions: state.permissions, displayName: 'Synthetic Storekeeper', membershipId: ID(900), tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => state.path,
};
export const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
export const navigationMock = {
  useRouter: () => router,
  usePathname: () => state.path,
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
};

export const ID = (n: number) => `01950c12-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const IDEM_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const PERM_READ = ['inventory.item.read'];
export const PERM_MANAGE = ['inventory.item.read', 'inventory.stock.manage'];
export const PERM_ADJUST = ['inventory.item.read', 'inventory.stock.manage', 'inventory.stock.adjust'];
export const PERM_BENCH = ['inventory.item.read', 'inventory.bench.record'];
export const PERM_BENCH_ADJUST = ['inventory.item.read', 'inventory.bench.record', 'inventory.stock.adjust'];
export const PERM_NONE: string[] = [];

const DAY = 86_400_000;
export const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
export const isoAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
export const isoIn = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, request_id: 'req-syn-0023', ...extra }, { status });

// ---------------------------------------------------------------- fixtures (schemas BalanceRow, FefoSuggestion, Container, Transfer, Count, CountLine, Fact, Store)
export const store = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(300 + n), branch_id: ID(401), branch_name: 'Synthetic Branch BR-1', store_code: `BR1-ST${n}`, name: `Synthetic store ${n}`, store_kind: 'main', is_default_consumption: n === 1, is_active: true, version: 1, ...over,
});
export const bench = (n: number, over: Record<string, unknown> = {}) => store(n, { store_code: `BR1-BENCH${n}`, name: `Synthetic bench ${n}`, store_kind: 'bench', is_default_consumption: false, ...over });
export const balance = (n: number, over: Record<string, unknown> = {}) => ({
  store_id: ID(301), item_id: ID(10 + n), item_code: `TIPS-${n}`, item_name: `Synthetic pipette tips ${n}`, lot_id: ID(20 + n), lot_no: `SYNLOT-00${n}`, expiry_on: inDays(200), lot_status: 'available',
  qty_base: '120', available_qty_base: '120', has_open_container: false, reorder_level_base: '50', ...over,
});
export const fefo = (n: number, take: string, avail: string, over: Record<string, unknown> = {}) => ({
  lot_id: ID(20 + n), lot_no: `SYNLOT-00${n}`, expiry_on: inDays(30 * n), has_open_container: n === 1, take_qty_base: take, available_qty_base: avail, ...over,
});
export const container = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(800 + n), store_id: ID(310), item_id: ID(11), lot_id: ID(21), lot_no: 'SYNLOT-001', instrument_id: ID(950), opened_at: isoAgo(48), open_expiry_at: isoIn(24 * 20), status: 'open', version: 2, ...over,
});
export const transfer = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(700 + n), transfer_no: `TRF-00000${n}`, from_store_id: ID(301), to_store_id: ID(321), status: 'draft', version: 1, notes: 'Synthetic note.',
  lines: [{ id: ID(710 + n), line_no: 1, item_id: ID(11), lot_id: ID(21), qty_base: '100' }], ...over,
});
export const countLine = (n: number, over: Record<string, unknown> = {}) => ({ id: ID(1000 + n), item_id: ID(10 + n), lot_id: ID(20 + n), book_qty_snapshot: n === 1 ? '37' : '58', version: 1, ...over });
export const count = (over: Record<string, unknown> = {}) => ({
  id: ID(900), count_no: 'CNT-000001', store_id: ID(301), status: 'open', snapshot_at: isoAgo(5), version: 4, lines: [countLine(1), countLine(2)], ...over,
});
export const countSummary = (n: number, over: Record<string, unknown> = {}) => ({ id: ID(900 + n), count_no: `CNT-00000${n}`, store_id: ID(301), status: 'open', snapshot_at: isoAgo(5), version: 1, ...over });
export const fact = (over: Record<string, unknown> = {}) => ({
  id: ID(1100), fact_kind: 'qc', source: 'manual', status: 'posted', occurred_at: isoAgo(1), business_date: inDays(0), multiplier: 3, rules_applied: 3, version: 1,
  movements: [1, 2, 3].map((n) => ({ id: ID(1110 + n), occurred_at: isoAgo(1), business_date: inDays(0), store_id: ID(310), item_id: ID(10 + n), movement_kind: 'consume_qc', qty_base: '-3', balance_qty_after: '10', doc_type: 'consumption_fact', doc_id: ID(1100) })),
  ...over,
});
export const stockDoc = (over: Record<string, unknown> = {}) => ({
  id: ID(1200), doc_no: 'ISS-000001', doc_kind: 'issue', store_id: ID(301), occurred_at: isoAgo(0), business_date: inDays(0), issued_to_kind: 'department', lines: [],
  movements: [
    { id: ID(1201), occurred_at: isoAgo(0), business_date: inDays(0), store_id: ID(301), item_id: ID(11), lot_id: ID(21), lot_no: 'SYNLOT-001', movement_kind: 'issue', qty_base: '-6', balance_qty_after: '114', doc_type: 'issue', doc_id: ID(1200) },
    { id: ID(1202), occurred_at: isoAgo(0), business_date: inDays(0), store_id: ID(301), item_id: ID(11), lot_id: ID(22), lot_no: 'SYNLOT-002', movement_kind: 'issue', qty_base: '-4', balance_qty_after: '56', doc_type: 'issue', doc_id: ID(1200) },
  ],
  version: 1, ...over,
});

// ---------------------------------------------------------------- fake API
export type Hit = { method: string; path: string; search: string; headers: Headers; body: string; json?: any };
export const hits: Hit[] = [];
export const hit = (method: string, pathRe: RegExp) => hits.filter((h) => h.method === method && pathRe.test(h.path));
export const page = <T,>(data: T[], next?: string) => HttpResponse.json({ data, page: { limit: 50, ...(next ? { next_cursor: next } : {}) } });

const codes = (...c: string[]) => c.map((code, i) => ({ code, display: code.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase()), sort_order: i + 1, is_active: true }));
const codedSets: Record<string, ReturnType<typeof codes>> = {
  wastage: codes('spillage', 'breakage', 'contamination'),
  adjustment: codes('count_variance', 'correction', 'found_stock'),
  transfer_discrepancy: codes('transit_loss', 'damaged_in_transit'),
  calibration: codes('scheduled_calibration', 'new_lot_calibration'),
};

/** Default handlers; tests override with api.use(...). Every request is logged first. */
export const api = setupServer(
  http.get(`${ORIGIN}/v1/inventory/stores`, ({ request }) =>
    new URL(request.url).searchParams.get('purpose') === 'transfer_target'
      ? page([1, 2, 3].map((n) => ({ id: ID(320 + n), store_code: `BR2-ST${n}`, name: `Synthetic remote store ${n}`, branch_id: ID(402), branch_name: 'Synthetic Branch BR-2' })))
      : page([store(1), store(2), bench(10)])),
  http.get(`${ORIGIN}/v1/inventory/stock`, () => page([balance(1), balance(2)])),
  http.get(`${ORIGIN}/v1/inventory/fefo-suggestions`, () => HttpResponse.json({ store_id: ID(301), item_id: ID(11), qty_base: '10', lines: [fefo(1, '6', '6'), fefo(2, '4', '60')], shortfall_qty_base: '0' })),
  http.get(`${ORIGIN}/v1/inventory/containers`, () => page([container(1)])),
  http.get(`${ORIGIN}/v1/inventory/transfers`, () => page([transfer(1, { status: 'dispatched', dispatched_at: isoAgo(3), version: 2 }), transfer(2, { status: 'draft' })])),
  http.get(`${ORIGIN}/v1/inventory/transfers/:id`, () => HttpResponse.json(transfer(1))),
  http.get(`${ORIGIN}/v1/inventory/stock-counts`, () => page([countSummary(1), countSummary(2, { status: 'posted', posted_at: isoAgo(1) })])),
  http.get(`${ORIGIN}/v1/inventory/stock-counts/:id`, () => HttpResponse.json(count())),
  // joins for CountLine / Container rows that carry ids only: ItemSummary (item_code, name) and Lot (lot_no, expiry_on)
  http.get(`${ORIGIN}/v1/inventory/items`, () => page([1, 2].map((n) => ({ id: ID(10 + n), item_code: `TIPS-${n}`, name: `Synthetic pipette tips ${n}`, category: 'consumable', base_uom_code: 'piece', is_lot_tracked: true, requires_expiry: true, is_active: true, version: 1 })))),
  http.get(`${ORIGIN}/v1/inventory/lots`, () => page([1, 2].map((n) => ({ id: ID(20 + n), item_id: ID(10 + n), lot_no: `SYNLOT-00${n}`, expiry_on: inDays(200), status: 'available', version: 1 })))),
  http.get(`${ORIGIN}/v1/inventory/settings`, () => HttpResponse.json({ backdate_max_days: 7, count_locks_store: false, version: 1 })),
  http.get(`${ORIGIN}/v1/inventory/coded-sets/:set`, ({ params }) => page(codedSets[String(params['set'])] ?? [])),
  http.get(`${ORIGIN}/v1/catalog/departments`, () => page([{ id: ID(60), code: 'BIOCHEM', name: 'Biochemistry', is_active: true, version: 1 }, { id: ID(61), code: 'HAEM', name: 'Haematology', is_active: true, version: 1 }])),
  http.get(`${ORIGIN}/v1/catalog/tests`, () => page([{ id: ID(70), code: 'GLU', name: 'Glucose', is_active: true, version: 1 }, { id: ID(71), code: 'CREA', name: 'Creatinine', is_active: true, version: 1 }])),
  http.get(`${ORIGIN}/v1/catalog/tests/:id/analytes`, () => page([{ id: ID(80), test_id: ID(70), code: 'GLU_F', name: 'Fasting glucose', sort_order: 1, is_active: true, version: 1 }])),
  http.get(`${ORIGIN}/v1/instruments/instruments`, () => page([{ id: ID(950), instrument_code: 'BIO-1', display_name: 'Synthetic chemistry analyser 1', state: 'live', version: 1 }, { id: ID(951), instrument_code: 'BIO-2', display_name: 'Synthetic chemistry analyser 2', state: 'live', version: 1 }])),
);
api.events.on('request:start', async ({ request }) => {
  const u = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
  let json: any;
  try { json = body && (request.headers.get('content-type') ?? '').includes('json') ? JSON.parse(body) : undefined; } catch { /* not json */ }
  hits.push({ method: request.method, path: u.pathname, search: u.search, headers: request.headers, body, json });
});
export const resetHits = () => { hits.length = 0; };
