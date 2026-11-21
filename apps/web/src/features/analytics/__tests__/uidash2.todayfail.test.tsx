// @vitest-environment jsdom
// T0D-UIDASH-2 (4) Today FAILED READ state (review item 3; done_when (4) "empty and failed read states"). Synthetic data only.
// The failed-read UI of Today is the existing one pinned by an-t18: a failed dashboard read (API 5xx) makes the page reject, and the segment
// error boundary app/(staff)/analytics/error.tsx draws the kit ErrorState with Retry. This file pins that for the rebuilt Today: no figures,
// no money, no raw message or stack in the DOM, Retry calls reset(), the opaque digest is the only reference, and the empty period still draws.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['analytics.dashboard.read'], displayName: 'Synthetic Owner', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/analytics',
}));

const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
const problem = (code: string, status: number) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code }, { status });
const tile = (value: number, unit = 'count') => ({ value, unit });
const okBody = () => ({
  report_code: 'dashboard',
  period: { business_date_from: '2026-01-15', business_date_to: '2026-01-16', days: 1, label_ad: '15 Jan 2026', label_bs: '2082-10-01', timezone: 'Asia/Kathmandu' },
  scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] },
  freshness: [{ family: 'income', refreshed_at: '2026-01-15T04:30:00.000Z', is_stale: false, live: false }],
  generated_at: '2026-01-15T04:30:00.000Z',
  tiles: { patient_visits: tile(0), net_sales_paisa: tile(0, 'paisa'), net_collected_paisa: tile(0, 'paisa'), reports_pending: tile(0), results_approved: tile(0), pending_tests: tile(0) },
  series: { days: [] }, department_top: [],
});

let dash: () => Response | Promise<Response> = () => HttpResponse.json(okBody());
const api = setupServer(
  http.get(`${ORIGIN}/v1/analytics/dashboard`, () => dash()),
  http.get(`${ORIGIN}/v1/analytics/freshness`, () => HttpResponse.json({ data: okBody().freshness })),
  http.get(`${ORIGIN}/v1/analytics/filter-options`, () => HttpResponse.json({ centres: [], branches: [], departments: [], payment_methods: [], specimen_types: [] })),
  http.get(`${ORIGIN}/v1/analytics/*`, () => problem('common.dependency_unavailable', 503)),
);
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); dash = () => HttpResponse.json(okBody()); });
afterAll(() => api.close());

const page = async () => ((await import(/* @vite-ignore */ '../../../app/(staff)/analytics/page')) as { default: (p: { searchParams: Promise<Record<string, string>> }) => Promise<unknown> }).default;
const errorBoundary = async () => ((await import(/* @vite-ignore */ '../../../app/(staff)/analytics/error')) as { default: (p: { error: Error & { digest?: string }; reset: () => void }) => React.ReactElement }).default;

describe('Today failed read (API 5xx / unavailable)', () => {
  it.each([
    ['500 common.internal', () => problem('common.internal', 500)],
    ['503 common.dependency_unavailable', () => problem('common.dependency_unavailable', 503)],
  ])('%s: the page refuses to draw any figure (it rejects, so the error boundary renders) and leaks no raw message or stack', async (_n, res) => {
    dash = res;
    const Page = await page();
    let tree: unknown;
    let threw: unknown;
    try { tree = await Page({ searchParams: Promise.resolve({}) }); } catch (e) { threw = e; }
    expect(threw, 'a failed dashboard read must reject the page, never render a partial Today').toBeDefined();
    expect(tree).toBeUndefined();
    expect(String((threw as Error).message)).not.toMatch(/SELECT|stack|at \/|jwt-synthetic/);
  });

  it('the error boundary shows the kit ErrorState with Retry and the opaque reference only; Retry calls reset', async () => {
    const Boundary = await errorBoundary();
    const reset = vi.fn();
    const boom = Object.assign(new Error('SELECT * FROM secret_table at /srv/app.js:1'), { digest: 'abc123digest' });
    const { container } = render(<ToastProvider><Boundary error={boom} reset={reset} /></ToastProvider>);
    expect(container.querySelector('.lims-state.lims-tone-danger'), 'kit ErrorState').not.toBeNull();
    expect(container.textContent).toContain('abc123digest');
    expect(container.textContent).not.toMatch(/SELECT|secret_table|app\.js/);
    expect(container.textContent).not.toMatch(/Rs\.|NaN|Infinity/);
    await userEvent.setup().click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('a failed read draws no Today card at all (no pipeline, no Money, no charts, no tile)', async () => {
    const Boundary = await errorBoundary();
    const { container } = render(<ToastProvider><Boundary error={new Error('x')} reset={() => {}} /></ToastProvider>);
    expect(container.querySelectorAll('.lims-card, .lims-chart-card, .lims-stat, .lims-stepper')).toHaveLength(0);
  });

  it('after a good read (empty period) the same page draws the Today cards, so the failure above is the API, not the page', async () => {
    const Page = await page();
    const el = await Page({ searchParams: Promise.resolve({}) });
    const { container } = render(<ToastProvider>{el as React.ReactElement}</ToastProvider>);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('.lims-stepper')).not.toBeNull();
  });
});
