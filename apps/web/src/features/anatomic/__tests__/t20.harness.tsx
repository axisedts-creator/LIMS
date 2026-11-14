// C11.T-20 shared harness (tester-owned; not a test file). Re-uses the T-19 MSW server + session/router mocks and adds the material / stain / image / movement / label fixtures and default handlers.
// Each test file registers the same three mocks as T-19 (vi.mock is hoisted, so the factories import this lazily):
//   vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock)
// and calls `beforeEach(() => api.use(...t20Defaults))` (api.resetHandlers() in afterEach removes them again).
// CONTRACT PINNED BY THE T-20 TESTS (writer: make these exist; names are mine, data shapes are contracts/openapi/anatomic.yaml):
//   CaseWorkspace (T-19 seam) gains working tabs named "Blocks & slides", "Stains", "Images" (04-UI-UX §4.2.3-5); data comes from detail.blocks/slides/stain_orders/images.
//   app/(staff)/anatomic/tracking/page.tsx                      default async Page({ searchParams: Promise<{ tab?: string }> })      (04-UI-UX §4.5)
//   app/(staff)/anatomic/cases/[case_id]/labels/page.tsx        default async Page({ params: Promise<{ case_id }>, searchParams: Promise<{ kind?, ids? }> })  (04-UI-UX §4.3)
//   app/(staff)/anatomic/images/[image_id]/content/route.ts     export async function GET(req, { params: Promise<{ image_id }> })     (BFF image stream, 04-UI-UX §4.2.5, D-67)
//   Shortcut page id 'staff.anatomic.tracking' (Alt+V); the labels page itself has no shortcuts (Alt+L lives on the case page).
// Synthetic data only.
import { http, HttpResponse } from 'msw';
export { ID, ORIGIN, PERM_NONE, PERM_READ, PERM_WORK, api, detail, hit, hits, navigationMock, page, part, problem, resetHits, router, sessionMock, state, summary } from './t19.harness';
import { ID, ORIGIN, api, detail, page, problem } from './t19.harness';

export const IDEM_RE = /^[A-Za-z0-9_-]{16,64}$/;

// ---------------------------------------------------------------- fixtures (schemas Block, Slide, StainOrder, Image, Movement, label)
export const block = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(200 + n), part_id: ID(101), label: `SP26-000042-A${n}`, seq: n, location_status: 'in_lab', slide_count: 0, version: 1, ...over,
});
export const slide = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(300 + n), label: `SP26-000042-A1-S${n}`, block_id: ID(201), part_id: ID(101), stain_code: 'HE', stain_display: 'Haematoxylin & Eosin', status: 'ready', location_status: 'in_lab',
  include_in_report: false, version: 1, ...over,
});
export const stainOrder = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(400 + n), stain_code: 'PAS', stain_display: 'Periodic acid-Schiff', stain_kind: 'special', block_id: ID(201), block_label: 'SP26-000042-A1', status: 'requested',
  requested_at: '2026-11-10T07:00:00.000Z', requested_by_display_name: 'Synthetic Tech', version: 1, ...over,
});
export const image = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(500 + n), kind: 'gross', part_id: ID(101), caption: `Synthetic caption ${n}`, state: 'ready', mime_type: 'image/png', width_px: 64, height_px: 64,
  created_at: '2026-11-10T08:00:00.000Z', is_active: true, version: 1, ...over,
});
export const movement = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(600 + n), movement: 'stored', location_text: 'Synthetic cabinet 3', at: '2026-11-10T09:00:00.000Z', by_display_name: 'Synthetic Tech', ...over,
});
export const stainRow = (code: string, kind: 'routine' | 'special' | 'ihc', over: Record<string, unknown> = {}) => ({ id: ID(700), code, display: `Synthetic ${code}`, kind, sort_order: 1, is_active: true, version: 1, ...over });

/** A worked case that has material. 3 blocks (A1..A3) on part A, slides, one stain order, images are added per test. */
export const workedCase = (over: Record<string, unknown> = {}) =>
  detail({
    accession_no: 'SP26-000042', status: 'in_processing', allowed_actions: ['markAnatomicCaseReady', 'cancelAnatomicCase'],
    blocks: [block(1, { slide_count: 2 }), block(2), block(3)],
    slides: [slide(1), slide(2, { status: 'pending_stain', stain_code: 'PAS', stain_display: 'Periodic acid-Schiff' })],
    stain_orders: [stainOrder(1)], images: [],
    ...over,
  });

// ---------------------------------------------------------------- default handlers (every request is already logged by the T-19 harness)
const created = (body: unknown) => HttpResponse.json(body as never, { status: 201 });
export const t20Defaults = [
  http.get(`${ORIGIN}/v1/anatomic/stains`, () => page([stainRow('HE', 'routine'), stainRow('PAS', 'special'), stainRow('CK7', 'ihc')])),
  http.get(`${ORIGIN}/v1/anatomic/coded-sets/:set/values`, ({ params }) =>
    page(params['set'] === 'cytology_adequacy' ? [{ code: 'SATISF', display: 'Satisfactory', is_active: true }] : [{ code: 'HE', display: 'Synthetic HE', is_active: true }, { code: 'PAS', display: 'Synthetic PAS', is_active: true }])),
  http.post(`${ORIGIN}/v1/anatomic/cases/:id/blocks`, () => created({ blocks: [block(4)] })),
  http.post(`${ORIGIN}/v1/anatomic/cases/:id/slides`, () => created({ slides: [slide(3)] })),
  http.post(`${ORIGIN}/v1/anatomic/slides/bulk-mark-ready`, async ({ request }) => {
    const b = (await request.clone().json()) as { ids: string[] };
    return HttpResponse.json({ results: b.ids.map((id) => ({ id, outcome: 'updated' })) });
  }),
  http.put(`${ORIGIN}/v1/anatomic/slides/:id/assessment`, () => HttpResponse.json(slide(1, { adequacy_code: 'SATISF', include_in_report: true, version: 2 }))),
  http.post(`${ORIGIN}/v1/anatomic/cases/:id/stain-orders`, () => created(stainOrder(2))),
  http.post(`${ORIGIN}/v1/anatomic/stain-orders/:id/start`, () => HttpResponse.json(stainOrder(1, { status: 'in_progress', version: 2 }))),
  http.post(`${ORIGIN}/v1/anatomic/stain-orders/:id/complete`, () => HttpResponse.json({ stain_order: stainOrder(1, { status: 'completed', version: 3 }), slides: [slide(3)] })),
  http.post(`${ORIGIN}/v1/anatomic/stain-orders/:id/cancel`, () => HttpResponse.json(stainOrder(1, { status: 'cancelled', version: 2 }))),
  http.post(`${ORIGIN}/v1/anatomic/stain-orders/:id/link-addon`, () => HttpResponse.json(stainOrder(1, { addon_order_item_id: ID(12), version: 2 }))),
  http.post(`${ORIGIN}/v1/anatomic/movements`, async ({ request }) => {
    const b = (await request.clone().json()) as { object_ids: string[] };
    return HttpResponse.json({ results: b.object_ids.map((id) => ({ id, outcome: 'recorded' })) });
  }),
  http.get(`${ORIGIN}/v1/anatomic/blocks`, () => page([])),
  http.get(`${ORIGIN}/v1/anatomic/blocks/:id/movements`, () => page([movement(1)])),
  http.get(`${ORIGIN}/v1/anatomic/slides/:id/movements`, () => page([movement(2)])),
  http.get(`${ORIGIN}/v1/anatomic/cases/:id/labels`, () => HttpResponse.json({ labels: [] })),
  http.post(`${ORIGIN}/v1/anatomic/cases/:id/images`, () => created(image(9, { state: 'processing' }))),
  http.put(`${ORIGIN}/v1/anatomic/images/:id`, () => HttpResponse.json(image(1, { version: 2 }))),
  http.post(`${ORIGIN}/v1/anatomic/images/:id/deactivate`, () => HttpResponse.json(image(1, { is_active: false, version: 2 }))),
];

export const labelsFor = (kind: 'block' | 'slide', labels: string[]) => ({ labels: labels.map((label, i) => ({ object_kind: kind, object_id: ID(800 + i), label, line2: `Synthetic line ${i + 1}` })) });
