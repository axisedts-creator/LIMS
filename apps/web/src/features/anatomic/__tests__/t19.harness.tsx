// C11.T-19 shared test harness (tester-owned; not a test file). MSW plays the C11 API (contracts/openapi/anatomic.yaml); BFF server code runs for real.
// Each test file registers three mocks pointing here (vi.mock is hoisted, so the factories import this lazily):
//   vi.mock('next/navigation', async () => (await import('./t19.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t19.harness')).sessionMock)
// CONTRACT PINNED BY THESE TESTS (writer: make these exports exist; names are mine, the data shapes are the spec's):
//   app/(staff)/anatomic/page.tsx                    default async Page({ searchParams: Promise<Record<string, string|string[]|undefined>> })  (04-UI-UX §4.1)
//   app/(staff)/anatomic/cases/[case_id]/page.tsx    default async Page({ params: Promise<{ case_id }> })                                       (04-UI-UX §4.2)
//   app/(staff)/anatomic/{loading,error}.tsx         loading = LoadingSkeleton; error = 'use client' ErrorState "We couldn't load cases." + reference + Retry
//   features/anatomic/components/WorklistScreen      ({ queue, cases: CaseSummary[], nextCursor?: string, permissions: string[] })
//   features/anatomic/components/CaseWorkspace       ({ detail: CaseDetail, permissions: string[], templates?: TextTemplate[] })  — header, banners, Overview + Parts tabs
//   Shortcut page ids (registry): 'staff.anatomic.worklist' and 'staff.anatomic.case' (= routeIds of 04-UI-UX §1 / routes.yaml)
//   Help keys (04-UI-UX header): helpKey 'anatomic.worklist' and 'anatomic.case' -> features/anatomic/help/<key>.ts
// Synthetic data only.
import { vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;

export const state = { permissions: [] as string[], token: 'jwt-synthetic' as string | undefined };
export const sessionMock = {
  getAccessToken: async () => state.token,
  getShellSession: async () => ({ actor: { permissions: state.permissions, displayName: 'Synthetic Pathologist', membershipId: ID(900), tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/anatomic',
};
export const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
export const navigationMock = {
  useRouter: () => router,
  usePathname: () => '/anatomic',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
};

export const ID = (n: number) => `01950c11-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const PERM_READ = ['anatomic.case.read', 'frontdesk.patient.read', 'lab.result.read'];
export const PERM_WORK = [...PERM_READ, 'anatomic.case.work'];
export const PERM_NONE: string[] = [];

export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status });

// ---------------------------------------------------------------- fixtures (contracts/openapi/anatomic.yaml schemas: CaseSummary, CaseDetail, Part, GrossRecord)
export const flags = (over: Record<string, unknown> = {}) => ({ profile_missing: false, specimen_rejected: false, open_change: false, pending_stain_orders: 0, parts_missing_site: false, ...over });
export const summary = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(n), accession_no: `SP26-${String(n).padStart(6, '0')}`, case_kind: 'histology', status: 'received', priority: 'routine', centre_id: ID(2), order_id: ID(3), patient_id: ID(4),
  patient: { display_name: `Synthetic Patient ${n}`, sex: 'F', age_text: '41 y', patient_code: `PC-${n}` }, test_names: ['Synthetic biopsy'], part_count: 1,
  received_at: '2026-11-10T04:15:00.000Z', flags: flags(), version: 1, ...over,
});
export const part = (n: number, over: Record<string, unknown> = {}) => ({ id: ID(100 + n), letter: String.fromCharCode(64 + n), site_text: `Synthetic site ${n}`, description_text: `Synthetic description ${n}`, specimen_state: 'received', version: 3, ...over });
export const gross = (n: number, over: Record<string, unknown> = {}) => ({ part_id: ID(100 + n), gross_text: 'Synthetic gross text.', pieces_count: 2, dimensions_mm: ['12.5', '8'], weight_g: '1.25', is_complete: false, grossed_by_display_name: 'Synthetic Grosser', updated_at: '2026-11-10T06:00:00.000Z', version: 2, ...over });
export const detail = (over: Record<string, unknown> = {}) => ({
  ...summary(1, { status: 'accessioned', accessioned_at: '2026-11-10T05:00:00.000Z', assigned_pathologist: { membership_id: ID(5), display_name: 'Synthetic Doctor' } }),
  clinical_history_text: 'Synthetic history.', current_version_no: 0, parts: [part(1)], blocks: [], slides: [], stain_orders: [], images: [],
  items: [{ case_item_id: ID(10), order_item_id: ID(11), test_id: ID(12), test_name: 'Synthetic biopsy', role: 'primary', is_active: true, lab_status: 'pending' }],
  molecular_rev: 0, molecular_results: [], addenda: [], transitions: [{ from_status: 'received', to_status: 'accessioned', at: '2026-11-10T05:00:00.000Z', by_display_name: 'Synthetic Tech' }],
  allowed_actions: ['startAnatomicProcessing', 'cancelAnatomicCase'], ...over,
});
export const template = (code: string, body: string, over: Record<string, unknown> = {}) => ({ id: ID(400), short_code: code, section: 'gross', title: `Synthetic ${code}`, body, is_active: true, version: 1, ...over });

// ---------------------------------------------------------------- fake API
export type Hit = { method: string; path: string; search: string; headers: Headers; body: string; json?: any };
export const hits: Hit[] = [];
export const hit = (method: string, pathRe: RegExp) => hits.filter((h) => h.method === method && pathRe.test(h.path));
export const page = <T,>(data: T[], next?: string) => HttpResponse.json({ data, page: { limit: 50, ...(next ? { next_cursor: next } : {}) } });

/** Default handlers; tests override with api.use(...). Every request is logged first. */
export const api = setupServer(
  http.get(`${ORIGIN}/v1/anatomic/cases`, () => page([summary(1)])),
  http.post(`${ORIGIN}/v1/anatomic/cases/lookup`, () => HttpResponse.json({ object_kind: 'case', case_id: ID(1) })),
  http.get(`${ORIGIN}/v1/anatomic/cases/:id`, () => HttpResponse.json(detail())),
  http.get(`${ORIGIN}/v1/anatomic/text-templates`, () => page([])),
  http.get(`${ORIGIN}/v1/anatomic/assignees`, () => page([{ membership_id: ID(5), display_name: 'Synthetic Doctor' }])),
  http.post(`${ORIGIN}/v1/anatomic/cases/:id/accession`, () => HttpResponse.json(detail({ accession_no: 'SP26-000777' }))),
  http.post(`${ORIGIN}/v1/anatomic/cases/:id/start-processing`, () => HttpResponse.json(detail({ status: 'in_processing' }))),
  http.post(`${ORIGIN}/v1/anatomic/cases/:id/mark-ready`, () => HttpResponse.json(detail({ status: 'ready_for_reporting' }))),
  http.post(`${ORIGIN}/v1/anatomic/cases/:id/cancel`, () => HttpResponse.json(detail({ status: 'cancelled' }))),
  http.post(`${ORIGIN}/v1/anatomic/cases/:id/parts`, () => HttpResponse.json(part(2), { status: 201 })),
  http.put(`${ORIGIN}/v1/anatomic/cases/:id/parts/:pid`, () => HttpResponse.json(part(1, { version: 4 }))),
  http.put(`${ORIGIN}/v1/anatomic/cases/:id/parts/:pid/gross`, () => HttpResponse.json(gross(1, { version: 3 }))),
);
api.events.on('request:start', async ({ request }) => {
  const u = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
  let json: any;
  try { json = body && (request.headers.get('content-type') ?? '').includes('json') ? JSON.parse(body) : undefined; } catch { /* multipart etc. */ }
  hits.push({ method: request.method, path: u.pathname, search: u.search, headers: request.headers, body, json });
});
export const resetHits = () => { hits.length = 0; };
