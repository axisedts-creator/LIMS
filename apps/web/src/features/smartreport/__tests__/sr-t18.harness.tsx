// C14.T18 shared test harness (tester-owned; not a test file). MSW plays the API (key = "METHOD /path"); fixtures follow contracts/openapi/smartreport.yaml
// (SmartSummaryListItem, PageInfo) and contracts/openapi/identity.yaml (Centre, FeatureFlagList). Synthetic data only.
// Each test file registers three mocks pointing here:
//   vi.mock('next/navigation', async () => (await import('./sr-t18.harness')).navigationMock)
//   vi.mock('server-only', () => ({}))
//   vi.mock('@/core/session/server', async () => (await import('./sr-t18.harness')).sessionMock)
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
export const TOKEN = 'jwt-synthetic';
export const READ = ['smartreport.summary.read'];
export const ADMIN = [...READ, 'identity.settings.manage', 'identity.centre.read'];
export const PATH = '/smartreport/summaries';

const id = (n: number) => `01940e00-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const S1 = id(11), S2 = id(12), S3 = id(13);
export const CENTRE_A = id(101), CENTRE_B = id(102);

// ---------------------------------------------------------------- mocks
export const state = { permissions: [] as string[], token: TOKEN as string | undefined, search: '' };
export const sessionMock = {
  getAccessToken: async () => state.token,
  getShellSession: async () => ({ actor: { permissions: state.permissions, displayName: 'Synthetic Pathologist', membershipId: id(50), tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => PATH,
};
export const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() };
export const navigationMock = {
  useRouter: () => router,
  usePathname: () => PATH,
  useSearchParams: () => new URLSearchParams(state.search),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
};
/** Last client navigation as URL (push or replace), or undefined. */
export const lastNav = () => {
  const all = [...router.push.mock.calls, ...router.replace.mock.calls];
  const t = all.at(-1)?.[0];
  return t === undefined ? undefined : new URL(String(t), 'http://web.test');
};

// ---------------------------------------------------------------- fixtures
export const problem = (code: string, status: number) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code }, { status, headers: { 'content-type': 'application/problem+json' } });

export const item = (over: Record<string, unknown> = {}) => ({
  id: S1, order_id: id(201), centre_id: CENTRE_A, status: 'draft', built_at: '2026-01-15T04:30:00.000Z', health_score_band: 'good', deranged_count: 1, critical_count: 0,
  registration_no: 'SYN-000123', patient_display_name: 'Synthetic Patient A', version: 1, ...over,
});
/** Three drafts, oldest first (AC-14.1). */
export const THREE = [
  item({ id: S1, registration_no: 'SYN-000101', built_at: '2026-01-15T04:30:00.000Z', deranged_count: 1, critical_count: 0, health_score_band: 'good', patient_display_name: 'Synthetic Patient A' }),
  item({ id: S2, registration_no: 'SYN-000102', built_at: '2026-01-15T06:00:00.000Z', deranged_count: 4, critical_count: 2, health_score_band: 'needs_attention', centre_id: CENTRE_B, patient_display_name: 'Synthetic Patient B' }),
  item({ id: S3, registration_no: 'SYN-000103', built_at: '2026-01-16T09:15:00.000Z', deranged_count: 0, critical_count: 0, health_score_band: undefined, patient_display_name: undefined }),
];
export const CENTRES = { data: [
  { centre_id: CENTRE_A, code: 'KTM-01', name: 'Kathmandu Main', branch_id: id(301), kind: 'own', is_active: true, version: 1 },
  { centre_id: CENTRE_B, code: 'PKR-02', name: 'Pokhara Lakeside', branch_id: id(301), kind: 'franchise', is_active: true, version: 1 },
] };
export const FLAGS_OFF = { data: [{ code: 'smart_report', description: 'Smart report', scope: 'tenant', settable_by: 'tenant', is_enabled: false, approval_ref_present: false, version: 1 }] };
export const FLAGS_ON = { data: [{ code: 'smart_report', description: 'Smart report', scope: 'tenant', settable_by: 'tenant', is_enabled: true, approval_ref_present: false, version: 1 }] };

// ---------------------------------------------------------------- MSW
export interface Call { method: string; url: URL; headers: Headers }
export const calls: Call[] = [];
export const routes: Record<string, (c: Call) => Response | Promise<Response>> = {};
export const api = setupServer(
  http.all(`${ORIGIN}/v1/*`, async ({ request }) => {
    const url = new URL(request.url);
    const call: Call = { method: request.method, url, headers: request.headers };
    calls.push(call);
    const h = routes[`${request.method} ${url.pathname}`];
    return h ? h(call) : problem('common.dependency_unavailable', 503);
  }),
);
export const json = (b: unknown, status = 200) => () => HttpResponse.json(b as never, { status });
export const LIST = '/v1/smartreport/summaries';
export const CENTRES_PATH = '/v1/identity/centres';
export const FLAGS_PATH = '/v1/identity/feature-flags';

export function resetApi(permissions: string[] = READ) {
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  state.permissions = permissions; state.token = TOKEN; state.search = '';
  router.push.mockClear(); router.replace.mockClear(); router.refresh.mockClear();
  routes[`GET ${CENTRES_PATH}`] = json(CENTRES);
  routes[`GET ${FLAGS_PATH}`] = json(FLAGS_ON);
}
export const mountList = (rows: unknown[] = THREE, page: Record<string, unknown> = { limit: 50 }) => { routes[`GET ${LIST}`] = json({ data: rows, page }); };
export const listCalls = () => calls.filter((c) => c.method === 'GET' && c.url.pathname === LIST);
export const apiCalls = () => calls.filter((c) => c.url.pathname.startsWith('/v1/'));

// ---------------------------------------------------------------- pages
const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'app', '(staff)', 'smartreport');
export const appFile = (...p: string[]) => join(APP, ...p);
export const importPage = async (rel: string) => (await import(/* @vite-ignore */ `../../../app/(staff)/smartreport/${rel}`)) as { default: (p: any) => Promise<any> };
export const QUEUE_PAGE = 'summaries/page';
export async function showQueue(searchParams: Record<string, string> = {}) {
  state.search = new URLSearchParams(searchParams).toString();
  const { default: Page } = await importPage(QUEUE_PAGE);
  const el = await Page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) });
  return render(<ToastProvider>{el}</ToastProvider>);
}
/** Renders, or returns the thrown message when the page refuses. A MISSING module is never a "refusal": it rethrows. */
export async function showOrThrown(searchParams: Record<string, string> = {}): Promise<string | undefined> {
  try { await showQueue(searchParams); return undefined; } catch (e) {
    const m = String((e as Error)?.message);
    if (/Cannot find module|Failed to (load|resolve)|does not exist/.test(m)) throw e;
    return m;
  }
}

// ---------------------------------------------------------------- DOM helpers
export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export const pageText = () => norm(document.body.textContent);
export async function axeClean() {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
}
export const queueGrid = () => {
  const g = screen.queryAllByRole('grid', { name: /smart summaries/i });
  if (!g.length) throw new Error(`no table named /smart summaries/; tables: ${JSON.stringify(screen.queryAllByRole('grid').map((x) => x.getAttribute('aria-label')))}`);
  return g[0]!;
};
export const headersOf = (g: HTMLElement) => within(g).getAllByRole('columnheader').map((h) => norm(h.textContent));
export const dataRows = (g: HTMLElement) => within(g).getAllByRole('row').slice(1);
export const rowTexts = (g: HTMLElement) => dataRows(g).map((r) => norm(r.textContent));
/** The row that currently holds (or contains) keyboard focus, as an index into dataRows. */
/** Kit Select (react-aria): trigger is a button named "<label> <value>", options render in a listbox. */
export async function pick(label: RegExp, option: RegExp) {
  const { default: userEvent } = await import('@testing-library/user-event');
  await userEvent.click(screen.getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}
export const focusedRowIndex = (g: HTMLElement) => dataRows(g).findIndex((r) => r === document.activeElement || r.contains(document.activeElement));
