// C10.T-19 shared test harness (tester-owned; not a test file). MSW plays the C10 API (contracts/openapi/micro.yaml), C5 lab lookup (lab.yaml) and C2 centres
// (identity.yaml); the BFF server functions run for real. Each test file registers three mocks pointing here:
//   vi.mock('next/navigation', async () => (await import('./t19.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t19.harness')).sessionMock)
// CONTRACT PINNED BY THESE TESTS (writer: make these exports exist; names are mine, the data shapes are the spec's):
//   app/(staff)/micro/worklist/page.tsx   default async Page({ searchParams: Promise<Record<string,string|string[]|undefined>> })   (04-UI-UX §2)
//   app/(staff)/micro/worklist/{loading,error}.tsx   loading = kit LoadingSkeleton; error = 'use client' ErrorState + Retry, never error.message
//   features/micro/components/worklist/WorklistScreen   ({ tab, cultures: CultureSummaryDto[], counts: Partial<Record<TabId, number>>, centres: Centre[] | null,
//        specimens: Record<specimen_id, { registration_no?: string; barcode?: string }>, nextCursor?: string, recentWindowDays: number, permissions: string[] })
//        TabId = 'setup' | 'incubating' | 'workup' | 'amending' | 'recent'; centres === null hides the Centre filter (403 on listCentres).
//   features/micro/server/{listCultures,lookupSpecimenByBarcode,getSpecimen,listCentres}.server.ts  (server-only; ids validated as UUID before reaching a path)
//   Scan = a server action reachable from the screen: lookup (POST /v1/lab/specimens/lookup {barcode}) -> GET /v1/micro/cultures?specimen_id=… -> navigate / chooser / info banner.
//   Shortcut page id: 'staff.micro.worklist' or 'micro.worklist' (spec silent; both accepted).
// Synthetic data only.
import { vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;

export const state = { permissions: [] as string[], token: 'jwt-synthetic' as string | undefined };
export const sessionMock = {
  getAccessToken: async () => state.token,
  getShellSession: async () => ({ actor: { permissions: state.permissions, displayName: 'Synthetic Technologist', membershipId: ID(900), tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/micro/worklist',
};
export const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
export const navigationMock = {
  useRouter: () => router,
  usePathname: () => '/micro/worklist',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
};

export const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000c${String(n).padStart(4, '0')}`;
export const PERM_READ = ['micro.culture.read', 'lab.specimen.read', 'identity.centre.read'];

export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status });

// ---------------------------------------------------------------- fixtures (CultureSummaryDto, SpecimenDto, centre)
export const culture = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(n), version: 1, status: 'awaiting_setup', order_id: ID(200 + n), order_item_id: ID(300 + n), specimen_id: ID(400 + n), patient_id: ID(500 + n), centre_id: ID(2),
  test_id: ID(600 + n), test_code: `SYN${n}`, test_name: `Synthetic culture ${n}`, specimen_type_code: 'SYN_URINE', specimen_site_code: 'syn_site',
  received_at: '2026-11-10T04:15:00.000Z', is_read_overdue: false, current_report_version_no: 0, chain_cancelled: false, open_instrument_record_count: 0,
  barcode: `E26000${String(n).padStart(4, '0')}`, ...over,
});
export const specimen = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(400 + n), version: 1, barcode: `E26000${String(n).padStart(4, '0')}`, order_id: ID(200 + n), registration_no: `R26110${String(n).padStart(4, '0')}`,
  specimen_type_code: 'SYN_URINE', container_code: 'SYN_CODE', status: 'received', priority: 'SYN_CODE', centre_id: ID(2), is_active: true, collection_barcode_unverified: false, label_print_count: 1, tests: [], ...over,
});
export const centre = (n: number, name: string) => ({ centre_id: ID(n), code: `C00000000${n}`, name, branch_id: ID(30), kind: 'own', address_text: 'Synthetic street', is_active: true });

// ---------------------------------------------------------------- fake API
export type Hit = { method: string; path: string; search: string; headers: Headers; body: string; json?: any };
export const hits: Hit[] = [];
export const hit = (method: string, pathRe: RegExp) => hits.filter((h) => h.method === method && pathRe.test(h.path));
export const page = <T,>(data: T[], extra: Record<string, unknown> = {}) => HttpResponse.json({ data, page: { limit: 50, ...extra } });

/** Honest list handler: filters `cultures` by the `status` and `specimen_id` query so a BFF may filter server-side OR client-side. */
export const cultureList = (all: any[]) => http.get(`${ORIGIN}/v1/micro/cultures`, ({ request }) => {
  const q = new URL(request.url).searchParams;
  const st = q.get('status')?.split(',');
  const sp = q.get('specimen_id');
  const out = all.filter((c) => (!st || st.includes(c.status)) && (!sp || c.specimen_id === sp));
  return page(out, q.get('include_total') === 'true' ? { total: out.length } : {});
});

/** Default handlers; tests override with api.use(...). Every request is logged first (see `record`). */
export const api = setupServer(
  http.get(`${ORIGIN}/v1/micro/cultures`, ({ request }) => page([culture(1)], new URL(request.url).searchParams.get('include_total') === 'true' ? { total: 1 } : {})),
  http.post(`${ORIGIN}/v1/lab/specimens/lookup`, () => HttpResponse.json(specimen(1))),
  http.get(`${ORIGIN}/v1/lab/specimens/:id`, ({ params }) => HttpResponse.json(specimen(Number(String(params['id']).slice(-4)) - 400))),
  http.get(`${ORIGIN}/v1/identity/centres`, () => page([centre(2, 'Synthetic Centre A1'), centre(3, 'Synthetic Centre B2')])),
  http.get(`${ORIGIN}/v1/micro/settings`, () => HttpResponse.json({ id: ID(9), version: 1, manual_ast_standard: 'CLSI', zone_suggestion_enabled: true, mic_suggestion_enabled: false, default_final_no_growth_hours: 48, early_final_requires_reason: true, recent_window_days: 7, is_active: true })),
);
api.events.on('request:start', async ({ request }) => {
  const u = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
  let json: any;
  try { json = body && (request.headers.get('content-type') ?? '').includes('json') ? JSON.parse(body) : undefined; } catch { /* not json */ }
  hits.push({ method: request.method, path: u.pathname, search: u.search, headers: request.headers, body, json });
});
export const resetHits = () => { hits.length = 0; };
