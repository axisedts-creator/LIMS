// T0D-UI-R04 shared harness (tester-owned; not a test file). Synthetic data only.
// Each jsdom test file registers these mocks (vi.mock is hoisted, so they live in the test files):
//   vi.mock('next/navigation', async () => (await import('./r04.harness')).navigationMock)
//   vi.mock('next/link', async () => (await import('./r04.harness')).linkMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./r04.harness')).sessionMock)
//   vi.mock('@/core/session/actions', async () => (await import('./r04.harness')).actionsMock)
//   vi.mock('@/core/nav/generated', async () => (await import('./r04.harness')).generatedMock)
import { createElement } from 'react';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;

afterEach(cleanup);
const g = globalThis as any;
g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
g.matchMedia ??= (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
if (typeof HTMLElement !== 'undefined') (HTMLElement.prototype as any).scrollIntoView ??= () => {};

export const user = () => userEvent.setup();

// ---------------------------------------------------------------- mocks
export const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
export const nav = { pathname: '/lab/worklist' };
export const navigationMock = {
  useRouter: () => router,
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
};
export const linkMock = {
  default: ({ href, children, prefetch: _p, ...rest }: any) => createElement('a', { href: typeof href === 'string' ? href : href?.pathname, ...rest }, children),
};
export const state = { token: 'jwt-synthetic' as string | undefined };
export const sessionMock = {
  getAccessToken: async () => state.token,
  getShellSession: async () => undefined,
  getRequestPathname: async () => nav.pathname,
};
export const actionsMock = { keepAlive: async () => ({ ok: true }) };

// ---------------------------------------------------------------- nav fixtures (one entry per rail group, plus a gated pair in Lab)
type E = { id: string; label: string; permission: string; group: string; order: number; path: string; routeId: string; module: string; icon?: string };
const e = (module: string, id: string, label: string, permission: string, group: string, order: number, path: string): E =>
  ({ id: `${module}.${id}`, label, permission, group, order, path, routeId: `staff.${module}.${id}`, module });
// Deliberately NOT in rail order: platform first. The shell must group + order by the 8 rail groups, not by input order.
export const ENTRIES: E[] = [
  e('platform', 'tenants', 'Tenants', 'p.plat.read', 'platform', 10, '/platform/tenants'),
  e('frontdesk', 'register', 'Register', 'p.fd.register', 'front_desk', 10, '/frontdesk/register'),
  e('frontdesk', 'accession', 'Accession', 'p.fd.accession', 'front_desk', 20, '/frontdesk/accession'),
  e('lab', 'worklist', 'Worklist', 'p.lab.worklist', 'laboratory', 10, '/lab/worklist'),
  e('lab', 'results', 'Results', 'p.lab.results', 'laboratory', 20, '/lab/results'),
  e('reporting', 'worklist', 'Report queue', 'p.rep.read', 'reporting', 10, '/reporting/worklist'),
  e('billing', 'daily_cash', 'Daily cash', 'p.bill.read', 'billing', 10, '/billing/daily-cash'),
  e('catalog', 'home', 'Test catalogue', 'p.cat.read', 'catalog', 10, '/catalog'),
  e('instruments', 'agents', 'Agents', 'p.ins.read', 'instruments', 10, '/instruments/agents'),
  e('admin', 'users', 'Users', 'p.adm.users', 'admin', 10, '/admin/users'),
];
export const ALL_PERMS = ENTRIES.map((x) => x.permission);
export const generatedMock = {
  navEntries: ENTRIES,
  staffRoutes: ENTRIES.map((x) => ({ id: x.routeId, path: x.path, permission: x.permission })),
};
/** Rail order the user must see: group label -> entry labels. */
export const EXPECTED_RAIL: [string, string[]][] = [
  ['Front desk', ['Register', 'Accession']],
  ['Lab', ['Worklist', 'Results']],
  ['Reports', ['Report queue']],
  ['Accounts', ['Daily cash']],
  ['Catalog', ['Test catalogue']],
  ['Instruments', ['Agents']],
  ['People & access', ['Users']],
  ['Settings', ['Tenants']],
];

export const FUTURE = new Date(Date.now() + 6 * 3600_000).toISOString();
export const session = (permissions: string[], over: Record<string, unknown> = {}) => ({
  sessionId: 'sess-synthetic', kind: 'staff', aal: 'aal1', idleExpiresAt: FUTURE, absoluteExpiresAt: FUTURE,
  actor: { displayName: 'Synthetic Technologist', tenantCode: 'syn', roles: ['synthetic_role'], permissions, membershipId: '01a1a98a-ac40-7000-8000-000000000900' },
  ...over,
});
export const CENTRES = {
  options: [{ id: '0193a5c0-0000-7000-8000-000000000040', name: 'Synthetic Centre A' }, { id: '0193a5c0-0000-7000-8000-000000000041', name: 'Synthetic Centre B' }],
  activeId: '0193a5c0-0000-7000-8000-000000000040',
};

export async function seriousViolations(root: Element = document.body): Promise<string[]> {
  const r = await axe.run(root, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id} [${v.impact}]: ${v.help} (${v.nodes.length} nodes)`);
}

// ---------------------------------------------------------------- fake API (BFF search targets only; contracts/openapi/frontdesk.yaml + lab.yaml)
export const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000d${String(n).padStart(4, '0')}`;
export const patient = (n: number, full_name: string) =>
  ({ id: ID(n), patient_code: `P-${String(n).padStart(6, '0')}`, full_name, sex: 'female', age_display: '43 Years', phone_masked: '98xxxxxx00', last_visit_at: '2026-11-05T04:15:00.000Z', is_anonymised: false });
export const specimen = (n: number, over: Record<string, unknown> = {}) => ({
  id: ID(400 + n), version: 1, barcode: 'E2600000101', order_id: ID(200 + n), registration_no: `R26110${String(n).padStart(4, '0')}`, specimen_type_code: 'SYN_URINE',
  container_code: 'SYN_CODE', status: 'received', priority: 'SYN_CODE', centre_id: ID(2), is_active: true, collection_barcode_unverified: false, label_print_count: 1, tests: [], ...over,
});
export type Hit = { method: string; path: string; search: string; headers: Headers; json?: any };
export const hits: Hit[] = [];
export const resetHits = () => { hits.length = 0; };
export const calls = (pathRe: RegExp) => hits.filter((h) => pathRe.test(h.path));
export const PATIENT_SEARCH = /\/v1\/frontdesk\/patients\/search$/;
export const SPECIMEN_LOOKUP = /\/v1\/lab\/specimens\/lookup$/;
export const api = setupServer(
  http.post(`${ORIGIN}/v1/frontdesk/patients/search`, () => HttpResponse.json({ data: [patient(1, 'Demo Patient A'), patient(2, 'Demo Patient B')] })),
  http.post(`${ORIGIN}/v1/lab/specimens/lookup`, () => HttpResponse.json(specimen(1))),
);
api.events.on('request:start', async ({ request }) => {
  const u = new URL(request.url);
  const text = request.method === 'GET' ? '' : await request.clone().text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* not json */ }
  hits.push({ method: request.method, path: u.pathname, search: u.search, headers: request.headers, json });
});
export const problem = (code: string, status: number) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: `LEAK-${code}`, status, code, detail: 'LEAK-detail' }, { status });
