// C12.T-21 shared test harness (tester-owned; not a test file). MSW plays the C12 API (contracts/openapi/inventory.yaml) plus two read-only neighbours; BFF server code runs for real.
// Each test file registers three mocks pointing here (vi.mock is hoisted, so the factories import this lazily):
//   vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock)
// CONTRACT PINNED BY THESE TESTS (writer: make these exports exist; the data shapes are the spec's, the seams are mine):
//   app/(staff)/inventory/items/page.tsx               default async Page({ searchParams: Promise<Record<string,string|string[]|undefined>> })   S2 (04-UI-UX §3; route staff.inventory.items)
//   app/(staff)/inventory/items/[item_id]/page.tsx     default async Page({ params: Promise<{ item_id }>, searchParams })                          S3 (route staff.inventory.item); 404 from GET -> notFound()
//   app/(staff)/inventory/stores/page.tsx              default async Page({ searchParams })  Tabs "Stores" | "Analysers" (S4 + S14); ?store=<id> opens the store drawer (tabs "Details" | "Reorder settings"); ?tab=analysers
//   app/(staff)/inventory/suppliers/page.tsx           default async Page({ searchParams })  S5; ?supplier=<id> opens the supplier drawer (tabs "Details" | "Items")
//   app/(staff)/inventory/{items,stores,suppliers}/{loading,error}.tsx   (T-20 pattern; checked statically only)
//   Data sources: items = GET /items (+ GET /items/{id}); uom/tax pickers = GET /coded-sets/uom | tax_codes; branches (store create) = GET /v1/identity/branches;
//   analyser labels = GET /v1/instruments/instruments (display_name, instrument_code), falling back to the id text if that call fails.
//   Writes go through the BFF to the API with: Idempotency-Key (UUIDv7-ish, 16-64 url-safe chars) where the operation says `required`, If-Match `"<version>"` where the row exists. Never a token in the browser.
//   Success/failure feedback: kit Toast (ToastProvider) and Banner tone="danger" with the registry title + request_id; Drawer closes on success.
// Synthetic data only.
import { vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;

export const state = { permissions: [] as string[], token: 'jwt-synthetic' as string | undefined, path: '/inventory/items' };
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
export const PERM_MANAGE = ['inventory.item.read', 'inventory.master.manage'];
export const PERM_NONE: string[] = [];

export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, request_id: 'req-syn-0001', ...extra }, { status });

// ---------------------------------------------------------------- fixtures (schemas ItemSummary, Item, Pack, Barcode, Store, StoreItemSetting, Supplier, SupplierItem, Binding)
export const itemSummary = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(10 + n), item_code: `GLU-R${n}`, name: `Synthetic glucose reagent ${n}`, category: 'reagent', base_uom_code: 'test', is_lot_tracked: true, requires_expiry: true, is_active: true, version: 1, ...over,
});
export const pack = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(100 + n), item_id: ID(11), pack_code: n === 1 ? 'BOX' : `PK${n}`, label: `Box of 400`, uom_code: 'box', qty_in_base: '400', is_purchase_default: n === 1, is_active: true, version: 1, ...over,
});
export const barcode = (n: number, over: Record<string, unknown> = {}) => ({ id: ID(200 + n), item_id: ID(11), pack_id: ID(101), barcode_value: `SYN-BC-000${n}`, is_active: true, version: 1, ...over });
export const item = (over: Record<string, unknown> = {}) => ({
  ...itemSummary(1), manufacturer: 'Synthetic Maker', catalogue_no: 'CAT-0001', storage_condition: 'refrigerated', open_stability_days: 30, notes: 'Synthetic note.',
  packs: [], barcodes: [], updated_at: '2026-11-10T04:30:00.000Z', version: 3, ...over,
});
export const store = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(300 + n), branch_id: ID(401), branch_name: 'Synthetic Branch BR-1', store_code: `BR1-ST${n}`, name: `Synthetic store ${n}`, store_kind: 'main', is_default_consumption: n === 1, is_active: true, version: 1, ...over,
});
export const setting = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(500 + n), store_id: ID(301), item_id: ID(10 + n), is_stocked: true, is_active: true, version: 2, reorder_level_base: '100', reorder_qty_base: '400', ...over,
});
export const supplier = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(600 + n), supplier_code: `SUP-0${n}`, name: `Synthetic supplier ${n}`, pan_text: 'SYNPAN0001', phone_display: '01-5550000', is_active: true, version: 1, updated_at: '2026-11-10T04:30:00.000Z', ...over,
});
export const supplierItem = (over: Record<string, unknown> = {}) => ({
  id: ID(700), supplier_id: ID(601), item_id: ID(11), pack_id: ID(101), supplier_item_code: 'SYN-CODE-1', last_unit_price_paisa: 450000, lead_time_days: 7, is_active: true, version: 1, ...over,
});
export const binding = (n: number, over: Record<string, unknown> = {}) => ({ id: ID(800 + n), instrument_id: ID(900 + n), store_id: ID(301), is_active: true, version: 1, since: '2026-11-01T04:30:00.000Z', ...over });
export const instrument = (n: number, over: Record<string, unknown> = {}) => ({ id: ID(900 + n), instrument_code: `SIM-CHEM-${n}`, display_name: `Synthetic chemistry analyser ${n}`, vendor: 'Synthetic', model: 'SYN-100', state: 'live', version: 1, ...over });
export const branch = (n: number, over: Record<string, unknown> = {}) => ({ branch_id: ID(400 + n), code: `BR-${n}`, name: `Synthetic Branch BR-${n}`, is_processing_lab: false, is_active: true, version: 1, ...over });

// ---------------------------------------------------------------- fake API
export type Hit = { method: string; path: string; search: string; headers: Headers; body: string; json?: any };
export const hits: Hit[] = [];
export const hit = (method: string, pathRe: RegExp) => hits.filter((h) => h.method === method && pathRe.test(h.path));
export const page = <T,>(data: T[], next?: string) => HttpResponse.json({ data, page: { limit: 50, ...(next ? { next_cursor: next } : {}) } });

const uom = [{ code: 'test', display: 'test', uom_kind: 'count', sort_order: 1, is_active: true }, { code: 'mL', display: 'mL', uom_kind: 'volume', sort_order: 2, is_active: true }, { code: 'box', display: 'box', uom_kind: 'count', sort_order: 3, is_active: true }];
const tax = [{ code: 'VAT', display: 'VAT 13%', sort_order: 1, is_active: true }];

/** Default handlers; tests override with api.use(...). Every request is logged first. */
export const api = setupServer(
  http.get(`${ORIGIN}/v1/inventory/items`, () => page([itemSummary(1), itemSummary(2, { is_active: false, category: 'kit' })])),
  http.get(`${ORIGIN}/v1/inventory/items/:id`, () => HttpResponse.json(item())),
  http.get(`${ORIGIN}/v1/inventory/coded-sets/:set`, ({ params }) => page(params['set'] === 'uom' ? uom : params['set'] === 'tax_codes' ? tax : [])),
  http.get(`${ORIGIN}/v1/inventory/stores`, () => page([store(1), store(2, { store_kind: 'bench', is_default_consumption: false })])),
  http.get(`${ORIGIN}/v1/inventory/stores/:id`, () => HttpResponse.json(store(1))),
  http.get(`${ORIGIN}/v1/inventory/stores/:id/item-settings`, () => page([setting(1), setting(2, { reorder_level_base: undefined, reorder_qty_base: undefined, version: 1, id: ID(502) })])),
  http.get(`${ORIGIN}/v1/inventory/suppliers`, () => page([supplier(1), supplier(2, { is_active: false })])),
  http.get(`${ORIGIN}/v1/inventory/suppliers/:id`, () => HttpResponse.json(supplier(1, { contact_name: 'Synthetic Contact', email: 'contact@example.test', address_text: 'Synthetic street 1', payment_terms_days: 30, notes: 'Synthetic.' }))),
  http.get(`${ORIGIN}/v1/inventory/suppliers/:id/items`, () => page([supplierItem()])),
  http.get(`${ORIGIN}/v1/inventory/instrument-bindings`, () => page([binding(1)])),
  http.get(`${ORIGIN}/v1/instruments/instruments`, () => page([instrument(1), instrument(2)])),
  http.get(`${ORIGIN}/v1/identity/branches`, () => HttpResponse.json({ data: [branch(1), branch(2)] })),
);
api.events.on('request:start', async ({ request }) => {
  const u = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
  let json: any;
  try { json = body && (request.headers.get('content-type') ?? '').includes('json') ? JSON.parse(body) : undefined; } catch { /* not json */ }
  hits.push({ method: request.method, path: u.pathname, search: u.search, headers: request.headers, body, json });
});
export const resetHits = () => { hits.length = 0; };
