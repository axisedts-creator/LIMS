// C2.T26 shared test harness (tester-owned; not a test file). MSW plays the identity API (contracts/openapi/identity.yaml, /v1/identity/platform/*).
// Each test file registers these mocks pointing here:
//   vi.mock('next/navigation', async () => (await import('./t26.harness')).navigationMock)
//   vi.mock('next/cache', async () => (await import('./t26.harness')).cacheMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t26.harness')).sessionMock)
// Synthetic data only.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

export const ORIGIN = 'http://api.t26.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
export const P = '/v1/identity/platform';
export const TOKEN = 'jwt-synthetic-t26';

// ---------------------------------------------------------------- ids + permission sets
const id = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
export const T_ALPHA = id(1);
export const T_BETA = id(2);
export const T_GAMMA = id(3);
export const DL_1 = id(11);
export const DL_2 = id(12);
export const SS_1 = id(21);
export const SS_2 = id(22);
export const AN_1 = id(31);
export const AN_2 = id(32);
export const STAFF_1 = id(41);
export const STAFF_2 = id(42);
export const SESS_1 = id(51);
export const SUPER = ['platform.tenant.read', 'platform.tenant.manage', 'platform.support_session.open', 'platform.dead_letter.manage', 'platform.staff.manage'];
export const SUPPORT = ['platform.tenant.read', 'platform.support_session.open'];

// ---------------------------------------------------------------- mocks (module-level state shared with the test files)
export const state = { permissions: [] as string[], kind: 'platform' as string, aal: 'aal2', token: TOKEN as string | undefined };
export const sessionMock = {
  getAccessToken: async () => state.token,
  getShellSession: async () => ({
    sessionId: id(900), kind: state.kind, aal: state.aal,
    idleExpiresAt: '2099-01-01T00:00:00.000Z', absoluteExpiresAt: '2099-01-01T08:00:00.000Z',
    actor: { displayName: 'Synthetic Platform Admin', tenantCode: '', roles: [], permissions: state.permissions },
  }),
  getRequestPathname: async () => '/platform',
};
export const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
export const navigationMock = {
  useRouter: () => router,
  usePathname: () => '/platform',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
};
export const cacheMock = { revalidatePath: () => undefined, revalidateTag: () => undefined, unstable_noStore: () => undefined };
export const lastNav = () => {
  const t = [...router.push.mock.calls, ...router.replace.mock.calls].at(-1)?.[0];
  return t === undefined ? undefined : String(t);
};

// ---------------------------------------------------------------- fixtures (fields per contracts/openapi/identity.yaml)
export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, request_id: 'req-t26-0001', ...extra }, { status, headers: { 'content-type': 'application/problem+json' } });
export const tenantDto = (tenant_id: string, code: string, status: string, over: Record<string, unknown> = {}) => ({
  tenant_id, code, legal_name: `${code} Legal Pvt. Ltd.`, display_name: `Synthetic ${code}`, status, timezone: 'Asia/Kathmandu',
  created_at: '2026-10-01T04:00:00.000Z', version: 3, ...over,
});
export const tenantDetail = (tenant_id: string, code: string, status: string, over: Record<string, unknown> = {}) => ({
  ...tenantDto(tenant_id, code, status), counts: { users: 7, branches: 2, centres: 3 }, annex_readiness: 'incomplete',
  status_history: [
    { to_status: 'provisioning', occurred_at: '2026-10-01T04:00:00.000Z' },
    { from_status: 'provisioning', to_status: 'active', occurred_at: '2026-10-02T04:00:00.000Z' },
  ], ...over,
});
export const deadLetter = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(10 + n), tenant_id: T_ALPHA, task_identifier: 'identity.gotrue_signout', last_error_code: 'common.dependency_unavailable',
  last_error_message_redacted: 'upstream timed out for user [redacted]', attempts: 5, first_failed_at: '2026-11-09T04:00:00.000Z', dead_at: '2026-11-09T05:00:00.000Z',
  state: 'open', version: 4, ...over,
});
export const supportSession = (n: number, over: Record<string, unknown> = {}) => ({
  support_session_id: id(20 + n), tenant_id: T_ALPHA, platform_staff_id: STAFF_1, platform_staff_display_name: 'Synthetic Support One', scope: 'read_only',
  reason_text: 'Investigating a stuck report, no patient details', ticket_ref: 'TCK-1001', duration_minutes: 30, status: 'active',
  requested_at: '2026-11-11T04:00:00.000Z', started_at: '2026-11-11T04:00:00.000Z', expires_at: '2099-01-01T04:30:00.000Z', version: 1, ...over,
});
export const annex = (n: number, tenant_id: string | undefined, annex_code: string, status: string, over: Record<string, unknown> = {}) => ({
  record_id: id(30 + n), ...(tenant_id ? { tenant_id } : {}), annex_code, status, version: 2, ...over,
});
export const staffDto = (n: number, over: Record<string, unknown> = {}) => ({
  platform_staff_id: id(40 + n), display_name: `Synthetic Staff ${n}`, email_masked: `st***${n}@example.test`, role_code: 'platform_support',
  allowed_cidrs: ['203.0.113.0/24'], is_active: true, last_login_at: '2026-11-10T04:00:00.000Z', version: 1, ...over,
});
export const authEvent = (n: number, over: Record<string, unknown> = {}) => ({
  auth_event_id: id(60 + n), tenant_id: T_ALPHA, event_type: 'login_failed', reason_code: 'auth.login_failed', client_ip: '203.0.113.77',
  user_agent: 'Firefox 140', occurred_at: '2026-11-10T04:00:00.000Z', ...over,
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
export const json = (b: unknown, status = 200) => () => HttpResponse.json(b as never, { status });
export const page = (data: unknown[], next?: string) => ({ data, page: { limit: 50, ...(next ? { next_cursor: next } : {}) } });
export function resetApi(permissions: string[] = SUPER, kind = 'platform') {
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  state.permissions = permissions; state.kind = kind; state.aal = 'aal2'; state.token = TOKEN;
  router.push.mockClear(); router.replace.mockClear(); router.refresh.mockClear();
}
export const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.url.pathname === path);
export const apiCalls = () => calls.length;
export const bodyOf = (c: Call | undefined) => JSON.parse(c?.body ?? 'null');

// ---------------------------------------------------------------- pages
type SP = Record<string, string | string[] | undefined>;
export const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'app', '(platform)', 'platform');
export const LAYOUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'app', '(platform)', 'layout.tsx');
export const appFile = (...p: string[]) => join(APP, ...p);
export async function importPage(rel: string) {
  return (await import(/* @vite-ignore */ `../../../app/(platform)/platform/${rel}`)) as { default: (p: any) => Promise<any> };
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
export async function showLayout(children = <div>CHILD-CONTENT</div>) {
  const rel = 'layout'; // variable specifier: a missing file must fail at run time (red test), not at transform time
  const { default: Layout } = (await import(/* @vite-ignore */ `../../../app/(platform)/${rel}`)) as { default: (p: any) => Promise<any> };
  return render(<ToastProvider>{await Layout({ children })}</ToastProvider>);
}
export const has = (...p: string[]) => existsSync(appFile(...p));
export const read = (...p: string[]) => readFileSync(appFile(...p), 'utf8');

// ---------------------------------------------------------------- DOM helpers
export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export const pageText = () => norm(document.body.textContent) + ' ' + [...document.body.querySelectorAll('[title],[aria-label]')].map((e) => `${e.getAttribute('title') ?? ''} ${e.getAttribute('aria-label') ?? ''}`).join(' ');
export function gridNamed(re: RegExp) {
  const g = screen.queryAllByRole('grid', { name: re });
  if (!g.length) throw new Error(`no table named ${re}; tables: ${JSON.stringify(screen.queryAllByRole('grid').map((x) => x.getAttribute('aria-label')))}`);
  return g[0]!;
}
export const headersOf = (g: HTMLElement) => within(g).getAllByRole('columnheader').map((h) => norm(h.textContent));
export const rowTexts = (g: HTMLElement) => within(g).getAllByRole('row').slice(1).map((r) => norm(r.textContent));
export async function axeClean() {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
}
export const dialog = () => screen.getByRole('dialog');
