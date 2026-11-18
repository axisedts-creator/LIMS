// @vitest-environment jsdom
// T0D-UILIST-1 (LD-353 template 1 LIST, rules 5, 6, 8; done_when 6, 7) — smart report lists: /smartreport/summaries and /smartreport/library.
// Pinned: PageHeader title = menu label; one FilterBar on summaries; table header row in the scroll box also when empty, one EmptyState in the body;
// the API failing (500) no longer throws to the error page: the page keeps its title and filters and shows an ErrorState with reference and Retry;
// 501 operation_pending = NotAvailable that keeps the title and the table header row. Wording list (/smartreport/wording) not pinned: lower value, same kit parts.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectEmptyState, expectErrorState, expectFilterBars, expectHeader, expectNotAvailable, expectTable } from '@/__tests__/uilist1.helpers';

const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
const perms = vi.hoisted(() => ({ list: ['smartreport.summary.read', 'smartreport.template.manage'] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/smartreport/summaries',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: perms.list, displayName: 'Synthetic Pathologist', membershipId: '01950c12-0000-7000-8000-000000000900', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/smartreport/summaries',
}));

const id = (n: number) => `01940e00-0000-7000-8000-${String(n).padStart(12, '0')}`;
const REF = 'req-synthetic-sr';
const problem = (status: number, code: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, request_id: REF }, { status, headers: { 'content-type': 'application/problem+json' } });
const row = { id: id(11), order_id: id(201), centre_id: id(101), status: 'draft', built_at: '2026-01-15T04:30:00.000Z', health_score_band: 'good', deranged_count: 1, critical_count: 0, registration_no: 'SYN-000101', patient_display_name: 'Synthetic Patient A', version: 1 };
const version = { id: id(21), version_no: 3, status: 'approved', language: 'en', approved_by_display_name: 'Synthetic Approver', approved_at: '2026-01-10T04:30:00.000Z', updated_at: '2026-01-11T04:30:00.000Z', version: 2 };

const api = setupServer();
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());
const list = (path: string, reply: () => Response) => api.use(
  http.get(`${ORIGIN}${path}`, reply),
  http.get(`${ORIGIN}/v1/identity/centres`, () => HttpResponse.json({ data: [{ centre_id: id(101), code: 'KTM-01', name: 'Kathmandu Main', branch_id: id(301), kind: 'own', is_active: true, version: 1 }] })),
  http.get(`${ORIGIN}/v1/identity/feature-flags`, () => HttpResponse.json({ data: [] })),
);
const props = { searchParams: Promise.resolve({}), params: Promise.resolve({}) } as never;
async function show(file: string) {
  const mod = await import(/* @vite-ignore */ `../../../app/(staff)/smartreport/${file}.tsx`);
  // a throw here IS the founder's error page: say so instead of a bare stack
  const tree = await (mod.default as (p: never) => Promise<never>)(props).catch((e: unknown) => { throw new Error(`the page threw to the error page instead of keeping its title with an ErrorState: ${String(e)}`); });
  return render(<ToastProvider>{tree}</ToastProvider>);
}

const SUM = '/v1/smartreport/summaries';
describe('/smartreport/summaries', () => {
  it('no rows: menu title, one FilterBar, table header row, one EmptyState', async () => {
    list(SUM, () => HttpResponse.json({ data: [], page: { limit: 50 } }));
    const { container } = await show('summaries/page');
    await screen.findByText(/no summaries waiting for review/i);
    expectHeader(container, '/smartreport/summaries', { noAction: true });
    expectFilterBars(container, '/smartreport/summaries', 1);
    expectTable(container, '/smartreport/summaries', { min: 6, headers: ['Built', 'Registration no.', 'Patient', 'Status'] });
    expectEmptyState(container, '/smartreport/summaries', { title: /no summaries/i });
  });

  it('one row: same header and one filter row; the row sits under the header', async () => {
    list(SUM, () => HttpResponse.json({ data: [row], page: { limit: 50 } }));
    const { container } = await show('summaries/page');
    await screen.findByText('SYN-000101');
    expectHeader(container, '/smartreport/summaries', { noAction: true });
    expectFilterBars(container, '/smartreport/summaries', 1);
    expectTable(container, '/smartreport/summaries', { min: 6, headers: ['Registration no.', 'Findings'] });
    expect(container.querySelectorAll('.lims-state:not(.lims-tone-danger)').length).toBe(0);
  });

  it('API 500: the page keeps its title and filters and shows an ErrorState with reference and Retry (no throw to the error page)', async () => {
    list(SUM, () => problem(500, 'common.internal'));
    const { container } = await show('summaries/page');
    expectErrorState(container, '/smartreport/summaries', { filters: 1 });
    expect(container.textContent).toContain(REF);
  });

  it('API 501 operation_pending: NotAvailable keeps the title and the table header row', async () => {
    list(SUM, () => problem(501, 'operation_pending'));
    const { container } = await show('summaries/page');
    expectNotAvailable(container, '/smartreport/summaries', { table: true });
  });
});

const LIB = '/v1/smartreport/library-versions';
describe('/smartreport/library', () => {
  it('no rows: menu title, one primary action in the header only, table header, one EmptyState', async () => {
    list(LIB, () => HttpResponse.json({ data: [], page: { limit: 50 } }));
    const { container } = await show('library/page');
    await screen.findByText(/no library yet/i);
    expectHeader(container, '/smartreport/library', { action: 'New draft' });
    expectTable(container, '/smartreport/library', { min: 5, headers: ['Version', 'Status', 'Language', 'Updated'] });
    expectEmptyState(container, '/smartreport/library', { title: /no library/i });
  });

  it('one row: header and table with the row; no EmptyState', async () => {
    list(LIB, () => HttpResponse.json({ data: [version], page: { limit: 50 } }));
    const { container } = await show('library/page');
    await screen.findByText('v3');
    expectHeader(container, '/smartreport/library', { action: 'New draft' });
    expectTable(container, '/smartreport/library', { min: 5, headers: ['Version', 'Approved by'] });
    expect(container.querySelectorAll('.lims-state').length).toBe(0);
  });

  it('API 500: the page keeps its title and shows an ErrorState with Retry', async () => {
    list(LIB, () => problem(500, 'common.internal'));
    const { container } = await show('library/page');
    expectErrorState(container, '/smartreport/library');
  });
});
