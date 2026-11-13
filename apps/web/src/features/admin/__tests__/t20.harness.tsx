// C2.T20 shared harness (tester-owned; not a test file). MSW plays the identity API (contracts/openapi/identity.yaml); synthetic data only.
// Each test file registers:
//   vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock)
// ASSUMED seams (writer: dispute if wrong): pages are async server components `Page({searchParams, params})` at
// app/(staff)/admin/<route>/page.tsx; they read perms from getShellSession().actor.permissions and refuse (notFound/throw or a
// permission message) BEFORE any API call; reads/writes go through core/api/server-fetch (Bearer, LIMS_ORIGIN_API).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

export const ORIGIN = 'http://api.t20.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
export const ID = '/v1/identity';
export const TOKEN = 'jwt-synthetic-t20';

const u = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
export const ME_M = u(1); // signed-in admin's membership
export const USER_M = u(2);
export const USER_M2 = u(3);
export const ROLE_ADMIN = u(10);
export const ROLE_FD = u(11);
export const ROLE_LAB = u(12);
export const BRANCH_1 = u(20);
export const CENTRE_A1 = u(30);
export const CENTRE_A2 = u(31);
export const AUDIT_1 = u(40);
export const EXPORT_1 = u(50);
export const EXPORT_2 = u(51);
export const SESSION_1 = u(60);
export const SESSION_2 = u(61);
export const SUPPORT_1 = u(70);
export const NOW = '2026-11-11T08:00:00.000Z';

export const ALL_ADMIN_PERMS = [
  'identity.self.manage', 'identity.user.read', 'identity.user.manage', 'identity.role.manage', 'identity.centre.read',
  'identity.centre.manage', 'identity.settings.manage', 'identity.session.revoke', 'audit.log.read', 'audit.log.export',
  'lab.result.approve',
];

export const state = { permissions: [...ALL_ADMIN_PERMS] as string[], token: TOKEN as string | undefined };
export const sessionMock = {
  getAccessToken: async () => state.token,
  getShellSession: async () => ({ actor: { permissions: state.permissions, displayName: 'Synthetic Admin', membershipId: ME_M, tenantCode: 'syn', roles: ['lab_admin'] } }),
  getRequestPathname: async () => '/admin',
};
export const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
export const navigationMock = {
  useRouter: () => router,
  usePathname: () => '/admin',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
};
export const lastNav = () => {
  const t = [...router.push.mock.calls, ...router.replace.mock.calls].at(-1)?.[0];
  return t === undefined ? undefined : String(t);
};

// ---------------------------------------------------------------- fixtures (contracts/openapi/identity.yaml)
export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status, headers: { 'content-type': 'application/problem+json' } });
export const page = (data: unknown[], more = false) => ({ data, page: { limit: 50, ...(more ? { next_cursor: 'cur-2' } : {}) } });
export const RR = (id: string, code: string, name: string) => ({ role_id: id, code, name });
export const userSummary = (over: Record<string, unknown> = {}) => ({
  membership_id: USER_M, display_name: 'Synthetic Sita Rai', email_masked: 'te***@example.test', status: 'active', is_locked: false,
  roles: [RR(ROLE_FD, 'front_desk', 'Front desk')], all_centres: false, centre_count: 2, mfa_enrolled: true, last_login_at: '2026-11-10T09:00:00.000Z', version: 4, ...over,
});
export const userDetail = (over: Record<string, unknown> = {}) => ({ ...userSummary(), phone_masked: '+97798******21', branch_ids: [BRANCH_1], centre_ids: [CENTRE_A1, CENTRE_A2], ...over });
export const role = (over: Record<string, unknown> = {}) => ({
  role_id: ROLE_FD, code: 'front_desk', name: 'Front desk', is_default: true, mfa_required: false, permission_codes: ['frontdesk.order.read'], member_count: 3, is_active: true, version: 2, ...over,
});
export const PERMISSIONS = [
  { code: 'frontdesk.order.read', privileged: false, module: 'frontdesk', phase: '1', assignable: true },
  { code: 'lab.specimen.receive', privileged: false, module: 'lab', phase: '1', assignable: true },
  { code: 'lab.result.approve', privileged: true, module: 'lab', phase: '1', assignable: true },
  { code: 'identity.role.manage', privileged: true, module: 'identity', phase: '1', assignable: true },
  { code: 'platform.tenant.manage', privileged: true, module: 'platform', phase: '1', assignable: false },
];
export const branch = (over: Record<string, unknown> = {}) => ({ branch_id: BRANCH_1, code: 'B0001', name: 'Synthetic Main Lab', is_processing_lab: true, is_active: true, version: 1, address_text: 'Synthetic Road 1', phone: '014000000', ...over });
export const centre = (over: Record<string, unknown> = {}) => ({ centre_id: CENTRE_A1, code: 'C000000001', name: 'Synthetic Centre A1', branch_id: BRANCH_1, kind: 'own', is_active: true, version: 1, ...over });
export const settings = (over: Record<string, unknown> = {}) => ({
  calendar_display: 'AD', timezone: 'Asia/Kathmandu', idle_timeout_minutes: 15, absolute_session_hours: 12, password_min_length: 12, support_access_mode: 'notify',
  report_link_ttl_days: 30, release_requires_payment: true, partial_release_allowed: false, letterhead_default: 'with', numbering_prefix: '', display_name: 'Synthetic Lab',
  legal_name_snapshot: 'Synthetic Lab Pvt Ltd', retention_clinical_years: 5, retention_audit_years: 5, retention_raw_instrument_years: 1,
  invoice_no_pattern: '{fy}-{seq:6}', registration_no_pattern: '{branch}-{seq:6}', version: 7, ...over,
});
export const sessionSummary = (over: Record<string, unknown> = {}) => ({
  session_id: SESSION_1, membership_id: USER_M, display_name: 'Synthetic Sita Rai', state: 'active', aal: 'aal2', created_at: '2026-11-11T05:00:00.000Z', last_seen_at: '2026-11-11T07:55:00.000Z',
  idle_expires_at: '2026-11-11T08:25:00.000Z', absolute_expires_at: '2026-11-11T17:00:00.000Z', client_ip_masked: '203.0.113.x', user_agent_family: 'Firefox', is_support: false, ...over,
});
export const auditSummary = (over: Record<string, unknown> = {}) => ({
  audit_id: AUDIT_1, occurred_at: '2026-11-11T07:00:00.000Z', table: 'frontdesk.orders', action: 'update', row_id: u(99), actor: { type: 'user', membership_id: USER_M, display_name: 'Synthetic Sita Rai' },
  changed_columns: ['status', 'total_paisa'], ...over,
});
export const auditExport = (over: Record<string, unknown> = {}) => ({
  export_id: EXPORT_1, source: 'audit_log', status: 'ready', requested_by_membership_id: ME_M, range_from: '2026-11-01T00:00:00.000Z', range_to: '2026-11-08T00:00:00.000Z',
  row_count: 1200, ready_at: '2026-11-11T07:30:00.000Z', expires_at: '2026-11-12T07:30:00.000Z', downloads_remaining: 3, created_at: '2026-11-11T07:29:00.000Z', version: 1, ...over,
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
export function resetApi(permissions: string[] = ALL_ADMIN_PERMS) {
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  state.permissions = [...permissions];
  state.token = TOKEN;
  router.push.mockClear(); router.replace.mockClear(); router.refresh.mockClear();
  // lookups most screens need
  routes[`GET ${ID}/roles`] = () => HttpResponse.json({ data: [role({ role_id: ROLE_ADMIN, code: 'lab_admin', name: 'Lab admin', mfa_required: true, permission_codes: ['identity.role.manage'] }), role(), role({ role_id: ROLE_LAB, code: 'lab_tech', name: 'Lab technician', permission_codes: ['lab.specimen.receive'], is_default: false })] });
  routes[`GET ${ID}/centres`] = () => HttpResponse.json({ data: [centre(), centre({ centre_id: CENTRE_A2, code: 'C000000002', name: 'Synthetic Centre A2' })] });
  routes[`GET ${ID}/branches`] = () => HttpResponse.json({ data: [branch()] });
  routes[`GET ${ID}/permissions`] = () => HttpResponse.json({ data: PERMISSIONS });
}
export const json = (b: unknown, status = 200) => () => HttpResponse.json(b as never, { status });
export const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.url.pathname === path);
export const bodyOf = (c: Call | undefined) => JSON.parse(c?.body ?? 'null');
export const apiCallCount = () => calls.length;

// ---------------------------------------------------------------- pages
type SP = Record<string, string | string[] | undefined>;
export const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'app', '(staff)', 'admin');
export const FEATURE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const appFile = (...p: string[]) => join(APP, ...p);
export async function importPage(rel: string) {
  return (await import(/* @vite-ignore */ `../../../app/(staff)/admin/${rel}/page`)) as { default: (p: any) => Promise<any> };
}
export async function show(rel: string, props: { searchParams?: SP; params?: Record<string, string> } = {}) {
  const { default: Page } = await importPage(rel);
  const el = await Page({ searchParams: Promise.resolve(props.searchParams ?? {}), params: Promise.resolve(props.params ?? {}) });
  return render(<ToastProvider>{el}</ToastProvider>);
}
/** Renders, or returns the refusal message when the page refuses by throwing. A MISSING module is never a "refusal": it rethrows. */
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
