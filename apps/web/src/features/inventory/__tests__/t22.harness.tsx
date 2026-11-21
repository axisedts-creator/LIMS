// C12.T-22 shared test harness (tester-owned; not a test file). MSW plays the C12 API (contracts/openapi/inventory.yaml) plus the C2 session; BFF server code runs for real.
// Each test file registers three mocks pointing here (vi.mock is hoisted, so the factories import this lazily):
//   vi.mock('next/navigation', async () => (await import('./t22.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t22.harness')).sessionMock)
// LD-140 (2026-11-13): kit components only, list + right Drawer, ONE primary button per page, every status shows tone + icon + word.
// CONTRACT PINNED BY THESE TESTS (writer: make these exports exist; data shapes are the spec's, the seams are mine):
//   app/(staff)/inventory/purchase-orders/page.tsx            default async Page({ searchParams: Promise })  S6 list (route staff.inventory.purchase_orders). Query: status, supplier (supplier_id), branch (branch_id), created_from, created_to -> API status/supplier_id/branch_id/created_at_from/created_at_to.
//                                                              "New PO" button (needs inventory.po.manage) opens a Drawer (role dialog) named "New purchase order" = the editor.
//                                                              ?po=<id> opens the Drawer for that PO: status draft -> editor named "Edit purchase order"; otherwise detail named "Purchase order <po_no>".
//   app/(staff)/inventory/purchase-orders/[po_id]/print/page.tsx   default async Page({ params: Promise<{po_id}> })  S6-P; GET /purchase-orders/{id}/print-view; needs inventory.cost.read (else testid permission-denied); 404 -> notFound().
//   app/(staff)/inventory/receipts/page.tsx                   default async Page({ searchParams })  S7 list (route staff.inventory.receipts). Query: status, store, supplier, po_id.
//                                                              "New receipt" button (needs inventory.stock.manage) opens Drawer "New receipt"; ?po=<id> opens it prefilled from that PO's open lines ("Receive against this PO"); ?grn=<id> opens Drawer "Goods receipt <grn_no>".
//   app/(staff)/inventory/{purchase-orders,receipts}/{loading,error}.tsx   (checked statically only)
//   Data sources: suppliers = GET /suppliers; stores = GET /stores; items = GET /items?q=<prefix> (Combobox "Item", active only); packs = GET /items/{id} (.packs);
//   tax codes = GET /coded-sets/tax_codes; PO cancel/close reasons = GET /coded-sets/reasons?reason_group=po_cancel|po_close (CONTRACT form; never /coded-sets/po_cancel).
//   Writes go through the BFF with Idempotency-Key where the operation says `required`, If-Match `"<version>"` where the row exists. Never a token in the browser.
//   Failures: kit Banner (role alert) with title + request_id; auth.mfa_required -> Banner mentioning "verif…" with the form/dialog kept open and the SAME Idempotency-Key reused on retry (03-APP-FLOW F-04 step 4).
// Synthetic data only.
import { vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;

export const state = { permissions: [] as string[], token: 'jwt-synthetic' as string | undefined, path: '/inventory/purchase-orders' };
export const sessionMock = {
  getAccessToken: async () => state.token,
  getShellSession: async () => ({ actor: { permissions: state.permissions, displayName: 'Synthetic Buyer', membershipId: ID(900), tenantCode: 'syn', roles: [] } }),
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
export const PERM_PO_MANAGE = ['inventory.item.read', 'inventory.po.manage', 'inventory.cost.read'];
export const PERM_PO_MANAGE_NO_COST = ['inventory.item.read', 'inventory.po.manage'];
export const PERM_PO_APPROVE = ['inventory.item.read', 'inventory.po.approve', 'inventory.cost.read'];
export const PERM_PO_ALL = ['inventory.item.read', 'inventory.po.manage', 'inventory.po.approve', 'inventory.cost.read'];
export const PERM_STOCK = ['inventory.item.read', 'inventory.stock.manage', 'inventory.cost.read'];
export const PERM_STOCK_ADJUST = ['inventory.item.read', 'inventory.stock.manage', 'inventory.stock.adjust', 'inventory.cost.read'];
export const PERM_NONE: string[] = [];

const DAY = 86_400_000;
export const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
export const isoAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, request_id: 'req-syn-0022', ...extra }, { status });

// ---------------------------------------------------------------- fixtures (schemas Po, PoSummary, PoPrintView, Grn, GrnSummary, ItemSummary, Item, Pack, SupplierSummary, Store)
export const supplier = (n: number, over: Record<string, unknown> = {}) => ({ id: ID(500 + n), supplier_code: `SUP-0${n}`, name: `Synthetic Supplier ${n}`, is_active: true, version: 1, ...over });
export const store = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(300 + n), branch_id: ID(401), branch_name: 'Synthetic Branch BR-1', store_code: `BR1-ST${n}`, name: `Synthetic store ${n}`, store_kind: 'main', is_default_consumption: n === 1, is_active: true, version: 1, ...over,
});
export const pack = (n: number, itemN: number, over: Record<string, unknown> = {}) => ({
  id: ID(100 * itemN + n), item_id: ID(10 + itemN), pack_code: n === 1 ? 'BOX' : 'CASE', label: n === 1 ? 'BOX (400 test)' : 'CASE (2000 test)', uom_code: 'box', qty_in_base: n === 1 ? '400' : '2000', is_purchase_default: n === 1, is_active: true, version: 1, ...over,
});
export const itemSummary = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(10 + n), item_code: n === 1 ? 'GLU-R1' : `TIPS-${n}`, name: n === 1 ? 'Synthetic glucose reagent' : `Synthetic pipette tips ${n}`, category: 'reagent', base_uom_code: 'test',
  is_lot_tracked: true, requires_expiry: true, is_active: true, version: 1, ...over,
});
export const item = (n: number, over: Record<string, unknown> = {}) => ({ ...itemSummary(n), packs: [pack(1, n), pack(2, n)], barcodes: [], updated_at: isoAgo(24), ...over });

export const poLine = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(610 + n), line_no: n, item_id: ID(10 + n), pack_id: ID(100 * n + 1), qty_packs: '2', qty_base: '800', unit_price_paisa: 125000, discount_paisa: 0, tax_code: 'VAT', is_exempt: false, tax_rate_bp: 1300,
  net_paisa: 250000, vat_paisa: 32500, line_total_paisa: 282500, received_qty_base: '0', open_qty_base: '800', is_closed_short: false, ...over,
});
export const po = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(600 + n), po_no: `PO-00000${n}`, branch_id: ID(401), store_id: ID(301), supplier_id: ID(501), status: 'draft', source: 'manual', expected_on: inDays(10), notes: 'Synthetic note.',
  subtotal_paisa: 250000, discount_paisa: 0, net_paisa: 250000, vat_paisa: 32500, total_paisa: 282500, created_at: isoAgo(48), version: 1, lines: [poLine(1)], receipts: [], ...over,
});
export const poSummary = (n: number, over: Record<string, unknown> = {}) => {
  const { lines: _l, receipts: _r, notes: _n, ...s } = po(n);
  return { ...s, ...over };
};
export const grnLine = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(710 + n), line_no: n, item_id: ID(10 + n), pack_id: ID(100 * n + 1), qty_packs: '1', qty_base: '400', is_exempt: false, po_line_id: ID(610 + n), lot_no: 'L-SYN-00' + n, expiry_on: '2027-06-30',
  unit_price_paisa: 125000, net_paisa: 125000, vat_paisa: 16250, line_total_paisa: 141250, ...over,
});
export const grn = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(700 + n), grn_no: `GRN-00000${n}`, kind: 'purchase', store_id: ID(301), supplier_id: ID(501), po_id: ID(602), status: 'draft', received_at: isoAgo(1), notes: 'Synthetic note.',
  net_paisa: 125000, vat_paisa: 16250, total_paisa: 141250, version: 1, lines: [grnLine(1)], ...over,
});
export const grnSummary = (n: number, over: Record<string, unknown> = {}) => {
  const { lines: _l, notes: _n, ...s } = grn(n);
  return { ...s, ...over };
};
export const printView = (over: Record<string, unknown> = {}) => ({
  is_draft: false, tenant_display_name: 'Synthetic Lab Pvt Ltd', branch_name: 'Synthetic Branch BR-1', po_no: 'PO-000002', status: 'approved', created_at: isoAgo(48), expected_on: inDays(10),
  supplier: { supplier_code: 'SUP-01', name: 'Synthetic Supplier 1', pan_text: 'SYN123456', address_text: 'Synthetic Street 1' },
  lines: [{ line_no: 1, item_code: 'GLU-R1', item_name: 'Synthetic glucose reagent', pack_label: 'BOX (400 test)', qty_packs: '2', unit_price_paisa: 125000, discount_paisa: 0, tax_code: 'VAT', is_exempt: false, line_total_paisa: 282500 }],
  subtotal_paisa: 250000, discount_paisa: 0, net_paisa: 250000, vat_paisa: 32500, total_paisa: 282500, ...over,
});

// ---------------------------------------------------------------- fake API
export type Hit = { method: string; path: string; search: string; headers: Headers; body: string; json?: any };
export const hits: Hit[] = [];
export const hit = (method: string, pathRe: RegExp) => hits.filter((h) => h.method === method && pathRe.test(h.path));
export const page = <T,>(data: T[], next?: string) => HttpResponse.json({ data, page: { limit: 50, ...(next ? { next_cursor: next } : {}) } });

const reasons: Record<string, { code: string; display: string }[]> = {
  po_cancel: [{ code: 'no_longer_needed', display: 'No longer needed' }, { code: 'supplier_unavailable', display: 'Supplier unavailable' }, { code: 'price_changed', display: 'Price changed' }],
  po_close: [{ code: 'short_supply', display: 'Short supply' }, { code: 'item_discontinued', display: 'Item discontinued' }, { code: 'no_longer_needed', display: 'No longer needed' }],
};

/** Default handlers; tests override with api.use(...). Every request is logged first. */
export const api = setupServer(
  http.get(`${ORIGIN}/v1/inventory/suppliers`, () => page([supplier(1), supplier(2)])),
  http.get(`${ORIGIN}/v1/inventory/suppliers/:id/items`, () => page([])), // supplier items: last price / default pack / tax defaults (F-04 step 2); tests override
  http.get(`${ORIGIN}/v1/inventory/stores`, () => page([store(1), store(2)])),
  http.get(`${ORIGIN}/v1/inventory/items`, ({ request }) => {
    const q = (new URL(request.url).searchParams.get('q') ?? '').toUpperCase();
    return page([itemSummary(1), itemSummary(2)].filter((i) => !q || i.item_code.startsWith(q) || i.name.toUpperCase().startsWith(q)));
  }),
  http.get(`${ORIGIN}/v1/inventory/items/:id`, ({ params }) => HttpResponse.json(item(Number(String(params['id']).slice(-2)) - 10 || 1))),
  http.get(`${ORIGIN}/v1/inventory/coded-sets/:set`, ({ params, request }) => {
    const set = String(params['set']);
    if (set === 'tax_codes') return page([{ code: 'VAT', display: 'VAT', sort_order: 1, is_active: true }, { code: 'EXC', display: 'Excise', sort_order: 2, is_active: true }]);
    if (set === 'reasons') return page((reasons[new URL(request.url).searchParams.get('reason_group') ?? ''] ?? []).map((r, i) => ({ ...r, sort_order: i + 1, is_active: true })));
    return HttpResponse.json({ type: 'urn:lims:error:common.not_found', title: 'common.not_found', status: 404, code: 'common.not_found' }, { status: 404 }); // /coded-sets/po_cancel is NOT the contract path
  }),
  http.get(`${ORIGIN}/v1/inventory/purchase-orders`, () => page([poSummary(1), poSummary(2, { status: 'approved', version: 2 }), poSummary(3, { status: 'partially_received', version: 4 })])),
  http.get(`${ORIGIN}/v1/inventory/purchase-orders/:id`, ({ params }) => HttpResponse.json(po(Number(String(params['id']).slice(-3)) - 600 || 1))),
  http.get(`${ORIGIN}/v1/inventory/purchase-orders/:id/print-view`, () => HttpResponse.json(printView())),
  http.get(`${ORIGIN}/v1/inventory/goods-receipts`, () => page([grnSummary(1, { status: 'posted', posted_at: isoAgo(1), version: 2 }), grnSummary(2)])),
  http.get(`${ORIGIN}/v1/inventory/goods-receipts/:id`, ({ params }) => HttpResponse.json(grn(Number(String(params['id']).slice(-3)) - 700 || 1))),
);
api.events.on('request:start', async ({ request }) => {
  const u = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
  let json: any;
  try { json = body && (request.headers.get('content-type') ?? '').includes('json') ? JSON.parse(body) : undefined; } catch { /* not json */ }
  hits.push({ method: request.method, path: u.pathname, search: u.search, headers: request.headers, body, json });
});
export const resetHits = () => { hits.length = 0; };
