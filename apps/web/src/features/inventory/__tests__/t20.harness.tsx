// C12.T-20 shared test harness (tester-owned; not a test file). MSW plays the C12 API (contracts/openapi/inventory.yaml); BFF server code runs for real.
// Each test file registers three mocks pointing here (vi.mock is hoisted, so the factories import this lazily):
//   vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock)
// CONTRACT PINNED BY THESE TESTS (writer: make these exports exist; data shapes are the spec's, the seams are mine):
//   features/inventory/nav.manifest.ts                 export const navManifest: NavManifest (module 'inventory', group 'inventory', 15 entries = 04-UI-UX §1 table, route ids from CR-C12-002)
//   app/(staff)/inventory/page.tsx                     default async Page({ searchParams })  S1 home
//   app/(staff)/inventory/alerts/page.tsx              default async Page({ searchParams })  S16; query params ?status=<csv> ?alert_kind=<kind> ?store_id=<id> are passed through to GET /alerts
//   app/(staff)/inventory/settings/page.tsx            default async Page({ searchParams })  S18
//   app/(staff)/inventory/{,alerts/,settings/}{loading,error}.tsx   (checked statically only)
//   S1 data: GET /alerts (a count may come from one call or one call per kind), GET /consumption-facts?status=unresolved, GET /settings (expiry_alert_days, consumption_enabled_at).
//   S16 data: GET /alerts, labels from GET /stores (store_code) and GET /items (item_code); ack = POST /alerts/{id}/acknowledge with If-Match "<version>".
//   S18: GET /settings, PUT /settings (If-Match "<version>", body = SettingsUpdate without `version`; over-receipt % and reconciliation % are shown as percent and sent as basis points).
//   Any other GET under /v1/inventory/ (set-up checklist sources) answers an empty page.
// Synthetic data only.
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ID, ORIGIN, hits, itemSummary, page, store } from './t21.harness';

export { ID, IDEM_RE, ORIGIN, PERM_MANAGE, PERM_NONE, PERM_READ, hit, hits, page, problem, router, state, sessionMock, navigationMock, store, itemSummary } from './t21.harness';
export const resetHits = () => { hits.length = 0; };

export const alert = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(1000 + n), alert_kind: 'below_reorder', status: 'open', store_id: ID(301), item_id: ID(11), first_raised_at: '2026-11-10T04:30:00.000Z', last_raised_at: '2026-11-12T04:30:00.000Z', occurrences: 1, details: [], version: 1, ...over,
});
export const fact = (n: number, over: Record<string, unknown> = {}) => ({ id: ID(1500 + n), status: 'unresolved', fact_kind: 'test', occurred_at: '2026-11-12T04:30:00.000Z', version: 1, ...over });
export const settings = (over: Record<string, unknown> = {}) => ({
  consumption_enabled_at: '2026-11-01T04:30:00.000Z', vat_in_cost: true, po_self_approval_allowed: false, grn_without_po_allowed: true, over_receipt_tolerance_bp: 250, expiry_alert_days: 30,
  default_consumption_store_id: ID(301), count_locks_store: false, per_day_requires_activity: true, reconciliation_gap_alert_bp: 200, backdate_max_days: 7,
  po_no_pattern: 'PO-{fy}-{seq:5}', grn_no_pattern: 'GRN-{fy}-{seq:5}', transfer_no_pattern: 'TRF-{fy}-{seq:5}', count_no_pattern: 'CNT-{fy}-{seq:5}', doc_no_pattern: 'DOC-{fy}-{seq:5}', version: 4, ...over,
});

/** Mutable fixtures; tests assign. */
export const db = { alerts: [] as any[], facts: [] as any[], settings: settings() as any };
export const resetDb = () => { db.alerts = []; db.facts = []; db.settings = settings(); };

const csv = (u: URL, k: string) => (u.searchParams.get(k) ?? '').split(',').filter(Boolean);
export const api = setupServer(
  http.get(`${ORIGIN}/v1/inventory/alerts`, ({ request }) => {
    const u = new URL(request.url);
    const st = csv(u, 'status'); const kinds = csv(u, 'alert_kind'); const sid = u.searchParams.get('store_id');
    const wanted = st.length ? st : ['open', 'acknowledged']; // API default (TRD #90)
    return page(db.alerts.filter((a) => wanted.includes(a.status) && (!kinds.length || kinds.includes(a.alert_kind)) && (!sid || a.store_id === sid)));
  }),
  http.post(`${ORIGIN}/v1/inventory/alerts/:id/acknowledge`, ({ params }) => HttpResponse.json({ ...db.alerts.find((a) => a.id === params['id']), status: 'acknowledged', version: 2 })),
  http.get(`${ORIGIN}/v1/inventory/consumption-facts`, ({ request }) => {
    const st = csv(new URL(request.url), 'status');
    return page(db.facts.filter((f) => !st.length || st.includes(f.status)));
  }),
  http.get(`${ORIGIN}/v1/inventory/settings`, () => HttpResponse.json(db.settings)),
  http.put(`${ORIGIN}/v1/inventory/settings`, async ({ request }) => HttpResponse.json({ ...db.settings, ...((await request.json()) as object), version: db.settings.version + 1 })),
  http.get(`${ORIGIN}/v1/inventory/stores`, () => page([store(1), store(2, { store_kind: 'bench', is_default_consumption: false })])),
  http.get(`${ORIGIN}/v1/inventory/items`, () => page([itemSummary(1)])),
  http.get(`${ORIGIN}/v1/inventory/*`, () => page([])),
);
api.events.on('request:start', async ({ request }) => {
  const u = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
  let json: any;
  try { json = body && (request.headers.get('content-type') ?? '').includes('json') ? JSON.parse(body) : undefined; } catch { /* not json */ }
  hits.push({ method: request.method, path: u.pathname, search: u.search, headers: request.headers, body, json });
});
