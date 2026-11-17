// AN-T20 shared test harness (tester-owned; not a test file). MSW plays the API (method-aware); fixtures follow contracts/openapi/analytics.yaml
// (ExportDto, ScheduleDto/ScheduleDetailDto, ReportRunDto, ReferralIncentiveReport). Synthetic data only.
// Each test file registers three mocks pointing here:
//   vi.mock('next/navigation', async () => (await import('./an-t20.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./an-t20.harness')).sessionMock)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

export const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
process.env['LIMS_ANALYTICS_PDF_ENABLED'] = 'false';

export const TOKEN = 'jwt-synthetic';
export const CENTRE_A = '01a1a98a-ac40-7000-8000-000000000002';
export const CENTRE_B = '01a1a98a-ac40-7000-8000-000000000003';
export const BRANCH = '01a1a98a-ac40-7000-8000-000000000004';
export const REF_1 = '01a1a98a-ac40-7000-8000-000000000011';
export const REF_2 = '01a1a98a-ac40-7000-8000-000000000012';
export const SCHED_ID = '01a1a98a-ac40-7000-8000-000000000040';
export const RUN_ID = '01a1a98a-ac40-7000-8000-000000000050';
export const OWNER_M = '01a1a98a-ac40-7000-8000-0000000000a1'; // the signed-in user's membership
export const MEMBER_2 = '01a1a98a-ac40-7000-8000-0000000000a2';
export const MEMBER_3 = '01a1a98a-ac40-7000-8000-0000000000a3';
export const exportId = (n: number) => `01a1a98a-ac40-7000-8000-0000000001${String(n).padStart(2, '0')}`;

// ---------------------------------------------------------------- mocks (module-level state shared with the test files)
export const state = { permissions: [] as string[], token: TOKEN as string | undefined };
export const sessionMock = {
  getAccessToken: async () => state.token,
  getShellSession: async () => ({ actor: { permissions: state.permissions, displayName: 'Synthetic Owner', membershipId: OWNER_M, tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/analytics',
};
export const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
export const navigationMock = {
  useRouter: () => router,
  usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
};
/** Last router.push/replace target (string), or undefined. */
export const lastNav = () => {
  const all = [...router.push.mock.calls, ...router.replace.mock.calls];
  const t = all.at(-1)?.[0];
  return typeof t === 'string' ? t : t === undefined ? undefined : String(t);
};

// ---------------------------------------------------------------- fixtures
export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status });
export const PERIOD = { business_date_from: '2026-01-01', business_date_to: '2026-01-16', days: 15, label_ad: '01 Jan – 15 Jan 2026', label_bs: '2082-09-17 – 2082-10-01', timezone: 'Asia/Kathmandu' };
export const FRESH = [{ family: 'referrer_billing', refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: false }];

export const exportDto = (n: number, over: Record<string, unknown> = {}) => ({
  id: exportId(n), report_code: 'income', format: 'xlsx', status: 'ready',
  params: { bs_month: '2083-07', centre_id: [CENTRE_A], group_by: 'day' },
  requested_at: '2026-11-09T04:30:00.000Z', ready_at: '2026-11-09T04:30:20.000Z', expires_at: '2026-11-10T04:30:20.000Z',
  row_count: 1234, size_bytes: 2048, downloads_used: 1, downloads_allowed: 3, ...over,
});

export const FILTER_OPTIONS = {
  centres: [{ id: CENTRE_A, label: 'Synthetic Centre A', branch_id: BRANCH, is_active: true }, { id: CENTRE_B, label: 'Synthetic Centre B', branch_id: BRANCH, is_active: true }],
  branches: [{ id: BRANCH, label: 'Synthetic Branch North', is_active: true }],
  departments: [], payment_methods: [], specimen_types: [],
  recipients: [{ membership_id: OWNER_M, display_name: 'Synthetic Owner' }, { membership_id: MEMBER_2, display_name: 'Synthetic Manager Two' }, { membership_id: MEMBER_3, display_name: 'Synthetic Manager Three' }],
};

export const scheduleDto = (over: Record<string, unknown> = {}) => ({
  id: SCHED_ID, version: 3, name: 'Daily MIS', report_codes: ['dashboard', 'income', 'volume'], frequency: 'daily', send_time_local: '07:00',
  period_rule: 'previous_business_day', scope: { all_centres: true, centre_ids: [] }, recipient_membership_ids: [OWNER_M, MEMBER_2], is_active: true,
  next_run_at: '2026-11-11T01:15:00.000Z', created_at: '2026-11-01T04:00:00.000Z', owner_membership_id: OWNER_M, ...over,
});

// ---------------------------------------------------------------- MSW (key = "METHOD /path"; unknown routes answer 503 so a missing read never looks like data)
export interface Call { method: string; url: URL; headers: Headers; body?: string }
export const calls: Call[] = [];
export const routes: Record<string, (c: Call) => Response | Promise<Response>> = {};
export const api = setupServer(
  http.all(`${ORIGIN}/v1/*`, async ({ request }) => {
    const url = new URL(request.url);
    const call: Call = { method: request.method, url, headers: request.headers, ...(request.method !== 'GET' ? { body: await request.clone().text() } : {}) };
    calls.push(call);
    const h = routes[`${request.method} ${url.pathname}`];
    return h ? h(call) : problem('common.dependency_unavailable', 503);
  }),
);
export function resetApi(permissions: string[] = []) {
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  state.permissions = permissions;
  state.token = TOKEN;
  router.push.mockClear(); router.replace.mockClear(); router.refresh.mockClear();
  routes['GET /v1/analytics/filter-options'] = () => HttpResponse.json(FILTER_OPTIONS);
}
export const json = (b: unknown, status = 200) => () => HttpResponse.json(b as never, { status });
export const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.url.pathname === path);
export const bodyOf = (c: Call | undefined) => JSON.parse(c?.body ?? 'null');

// ---------------------------------------------------------------- pages
type SP = Record<string, string | string[] | undefined>;
export const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'app', '(staff)', 'analytics');
export const appFile = (...p: string[]) => join(APP, ...p);
/** Imports app/(staff)/analytics/<rel> (no extension); a missing file fails with the module-not-found error. */
export async function importPage(rel: string) {
  return (await import(/* @vite-ignore */ `../../../app/(staff)/analytics/${rel}`)) as { default: (p: any) => Promise<any>; GET?: (req: Request, ctx: any) => Promise<Response> };
}
export async function show(rel: string, props: { searchParams?: SP; params?: Record<string, string> } = {}) {
  const { default: Page } = await importPage(rel);
  const el = await Page({ searchParams: Promise.resolve(props.searchParams ?? {}), params: Promise.resolve(props.params ?? {}) });
  return render(<ToastProvider>{el}</ToastProvider>);
}
/** Renders, or returns the error message when the page refuses by throwing. A MISSING module is never a "refusal": it rethrows. */
export async function showOrThrown(rel: string, props: Parameters<typeof show>[1] = {}): Promise<string | undefined> {
  try { await show(rel, props); return undefined; } catch (e) {
    const m = String((e as Error)?.message);
    if (/Cannot find module|Failed to (load|resolve)|does not exist/.test(m)) throw e;
    return m;
  }
}
export const read = (...p: string[]) => readFileSync(appFile(...p), 'utf8');
export const has = (...p: string[]) => existsSync(appFile(...p));

// ---------------------------------------------------------------- DOM helpers
export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export function gridNamed(re: RegExp) {
  const g = screen.queryAllByRole('grid', { name: re });
  if (!g.length) throw new Error(`no table named ${re}; tables: ${JSON.stringify(screen.queryAllByRole('grid').map((x) => x.getAttribute('aria-label')))}`);
  return g[0]!;
}
export const headersOf = (g: HTMLElement) => within(g).getAllByRole('columnheader').map((h) => norm(h.textContent));
export const dataRows = (g: HTMLElement) => within(g).getAllByRole('row').slice(1);
export const rowTexts = (g: HTMLElement) => dataRows(g).map((r) => norm(r.textContent));
export const pageText = () => norm(document.body.textContent) + ' ' + [...document.body.querySelectorAll('[title],[aria-label]')].map((e) => `${e.getAttribute('title') ?? ''} ${e.getAttribute('aria-label') ?? ''}`).join(' ');
export async function axeClean() {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
}
