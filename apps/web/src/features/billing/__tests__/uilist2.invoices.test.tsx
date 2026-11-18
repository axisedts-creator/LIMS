// @vitest-environment jsdom
// T0D-UILIST-2 (LD-353 template 1 LIST, rules 3, 5, 6, 8; done_when 1 and 7) — /billing/invoices.
// Pinned: PageHeader title = menu label; ONE FilterBar with fiscal year, date range, centre, status, invoice no, credit party and Reset (the three filter rows become one);
// table header row inside .lims-table-scroll also when empty, ONE EmptyState in the body; Net right aligned with the currency in the header and two decimals;
// cut off text cells carry title; API 500 keeps the title and filters with an ErrorState (reference + Retry), 501 operation_pending = NotAvailable with the header row.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { REF, U, expectBarButton, expectCellTitles, expectEmptyState, expectErrorState, expectFilterBars, expectFilterLabels, expectHeader, expectMoneyColumn, expectNotAvailable, expectTable, npr, page, problem, props } from '@/__tests__/uilist2.helpers';

const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/billing/invoices',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['billing.invoice.read', 'billing.data.export'], displayName: 'Synthetic Finance', membershipId: '01950c12-0000-7000-8000-000000000900', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/billing/invoices',
}));

const P = '/billing/invoices';
const row = (o: Record<string, unknown> = {}) => ({ id: U(1), invoice_no: 'INV/2083-84/000042', invoice_seq: 42, fiscal_year_bs: '2083/84', invoice_kind: 'tax', status: 'issued', issued_at: '2026-11-07T04:00:00.000Z', invoice_date_bs: '2083-07-21', centre_id: U(3), order_id: U(5), buyer_name: 'Synthetic Buyer', net: npr(113000), cbms_state: 'not_required', print_count: 1, ...o });

const api = setupServer();
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());
const serve = (invoices: () => Response) => api.use(http.get(`${ORIGIN}/v1/billing/invoices`, invoices), http.all(`${ORIGIN}/v1/*`, () => page([])));
async function show() {
  const mod = await import(/* @vite-ignore */ '../../../app/(staff)/billing/invoices/page.tsx');
  const tree = await (mod.default as (p: never) => Promise<never>)(props).catch((e: unknown) => { throw new Error(`the page threw to the error page instead of keeping its title with an ErrorState: ${String(e)}`); });
  return render(<ToastProvider>{tree}</ToastProvider>);
}

describe(P, () => {
  it('no rows: menu title, ONE FilterBar with the six filters and Reset, header row, one EmptyState', async () => {
    serve(() => page([]));
    const { container } = await show();
    await screen.findByText(/no invoices/i);
    expectHeader(container, P);
    expectFilterBars(container, P, 1);
    expectFilterLabels(container, P, [/fiscal year/i, /date range/i, /centre/i, /status/i, /invoice no/i, /credit party/i]);
    expectBarButton(container, P, /reset/i);
    expectTable(container, P, { min: 8, headers: ['Invoice no', 'B.S. date', 'A.D. date', 'Buyer', 'Status', 'Prints', 'CBMS'] });
    expectEmptyState(container, P, { title: /no invoices/i });
  });

  it('one row: money right aligned with NPR in the header, titles on text cells, no EmptyState', async () => {
    serve(() => page([row()]));
    const { container } = await show();
    await screen.findByText('INV/2083-84/000042');
    expectHeader(container, P);
    expectFilterBars(container, P, 1);
    expectTable(container, P, { min: 8 });
    expectMoneyColumn(container, P, /^Net\b/i);
    expectCellTitles(container, P, /^Buyer$/i);
    expect(container.querySelectorAll('.lims-state').length).toBe(0);
  });

  it('API 500: title and filters stay, ErrorState with reference and Retry', async () => {
    serve(() => problem(500, 'common.internal'));
    const { container } = await show();
    expectErrorState(container, P, { filters: 1 });
    expect(container.textContent).toContain(REF);
  });

  it('API 501 operation_pending: NotAvailable keeps the title and the header row', async () => {
    serve(() => problem(501, 'operation_pending'));
    const { container } = await show();
    expectNotAvailable(container, P, { table: true });
  });
});
