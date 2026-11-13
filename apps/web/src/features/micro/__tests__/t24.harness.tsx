// C10.T-24 shared test harness (tester-owned; not a test file). MSW plays the C10 API (contracts/openapi/micro.yaml); the BFF server actions run for real.
// Each test file registers three mocks pointing here (vi.mock is hoisted, so the factories import this lazily):
//   vi.mock('next/navigation', async () => (await import('./t24.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t24.harness')).sessionMock)
// CONTRACT PINNED BY THESE TESTS (writer: make these exports exist; names are mine, the data shapes are the spec's):
//   components/breakpoints/BreakpointSetsScreen   ({ sets: BreakpointSetDto[], permissions: string[] })     — list + import dialog (04-UI-UX §6.1)
//   components/breakpoints/BreakpointSetDetail    ({ set, issues, rows, permissions })                      — detail (04-UI-UX §6.2); polls via server action
//   components/settings/MicroSettingsScreen       ({ settings: MicroSettingsDto, permissions: string[] })   — five tabs (04-UI-UX §5); tab data loads via server actions
// Synthetic data only. No real vendor breakpoint values: numbers below are arbitrary test digits.
import { vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;

export const state = { permissions: [] as string[], token: 'jwt-synthetic' as string | undefined };
export const sessionMock = {
  getAccessToken: async () => state.token,
  getShellSession: async () => ({ actor: { permissions: state.permissions, displayName: 'Synthetic Manager', membershipId: ID(900), tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/micro/breakpoint-sets',
};
export const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
export const navigationMock = {
  useRouter: () => router,
  usePathname: () => '/micro/breakpoint-sets',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
};

export const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000c${String(n).padStart(4, '0')}`;
export const PERM_BP = ['micro.culture.read', 'micro.breakpoint.manage'];
export const PERM_CFG = ['micro.culture.read', 'micro.config.manage'];
export const PERM_READ_ONLY = ['micro.culture.read'];

export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status });

// ---------------------------------------------------------------- fixtures (contracts/openapi/micro.yaml schemas)
export const setDto = (over: Record<string, unknown> = {}) => ({
  id: ID(1), version: 2, standard: 'CLSI', standard_version: '2099-test', title: 'Synthetic zone table', licence_attestation_text: 'Synthetic attestation: test data only, licensed for this laboratory.',
  status: 'validated', file_sha256: 'ab'.repeat(32), file_bytes: 2048, row_count: 12, band_count: 30, error_count: 0, warning_count: 1,
  intended_effective_from: '2026-12-01T00:00:00.000Z', imported_by_display: 'Synthetic Importer', created_at: '2026-11-10T04:00:00.000Z', ...over,
});
export const issueDto = (over: Record<string, unknown> = {}) => ({ line_no: 7, severity: 'error', code: 'row.category_invalid', field: 'category', message: 'Category not allowed for this standard.', ...over });
export const band = (n: number, over: Record<string, unknown> = {}) => ({ id: ID(500 + n), band_no: n, category_code: 'S', lower_inclusive: true, upper_inclusive: false, ...over });
export const rowDto = (n: number, over: Record<string, unknown> = {}) => ({ id: ID(100 + n), line_no: n + 1, organism_scope: 'organism', organism_code: 'synthetic_org', antibiotic_code: 'synthetic_abx', method: 'zone_diameter', bands: [band(1, { category_code: 'S', lower_value: '22', lower_inclusive: true }), band(2, { category_code: 'R', upper_value: '17', upper_inclusive: true })], ...over });
export const settingsDto = (over: Record<string, unknown> = {}) => ({
  id: ID(2), version: 3, manual_ast_standard: 'CLSI', zone_suggestion_enabled: true, mic_suggestion_enabled: false, default_final_no_growth_hours: 48, early_final_requires_reason: true, recent_window_days: 7, is_active: true, ...over,
});
export const code = (c: string, over: Record<string, unknown> = {}) => ({ code: c, display: `Synthetic ${c}`, sort_order: 10, is_active: true, source: 'global', ...over });

// ---------------------------------------------------------------- fake API
export type Hit = { method: string; path: string; search: string; headers: Headers; body: string; json?: any };
export const hits: Hit[] = [];
export const hit = (method: string, pathRe: RegExp) => hits.filter((h) => h.method === method && pathRe.test(h.path));
export const page = <T,>(data: T[]) => HttpResponse.json({ data, page: { limit: 50 } });

/** Default handlers; tests override with api.use(...). Every request is logged first (see `record`). */
export const api = setupServer(
  http.get(`${ORIGIN}/v1/micro/breakpoint-sets`, () => page([setDto()])),
  http.get(`${ORIGIN}/v1/micro/breakpoint-sets/:id`, () => HttpResponse.json(setDto())),
  http.get(`${ORIGIN}/v1/micro/breakpoint-sets/:id/issues`, () => page([issueDto()])),
  http.get(`${ORIGIN}/v1/micro/breakpoint-sets/:id/rows`, () => page([rowDto(1)])),
  http.get(`${ORIGIN}/v1/micro/settings`, () => HttpResponse.json(settingsDto())),
  http.get(`${ORIGIN}/v1/micro/coded-sets/:name`, () => page([code('synthetic_org', { snomed_ct_concept_id: undefined })])),
  http.get(`${ORIGIN}/v1/micro/plating-protocols`, () => page([])),
  http.get(`${ORIGIN}/v1/micro/ast-panels`, () => page([])),
  http.get(`${ORIGIN}/v1/micro/instrument-vocab-maps`, () => page([])),
  http.get(`${ORIGIN}/v1/micro/instrument-ast-defaults`, () => page([])),
  http.get(`${ORIGIN}/v1/instruments/instruments`, () => page([])),
  http.get(`${ORIGIN}/v1/catalog/tests`, () => page([])),
);
api.events.on('request:start', async ({ request }) => {
  const u = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
  let json: any;
  try { json = body && (request.headers.get('content-type') ?? '').includes('json') ? JSON.parse(body) : undefined; } catch { /* multipart etc. */ }
  hits.push({ method: request.method, path: u.pathname, search: u.search, headers: request.headers, body, json });
});
export const resetHits = () => { hits.length = 0; };
