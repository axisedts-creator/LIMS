// @vitest-environment jsdom
// T0D-UILIST-2 (LD-353 template 1 LIST, rules 3, 5, 6, 8; done_when 5 and 7) — billing: /credit-parties, /registers, /audit-trail, /cbms, /worklist.
// Each page renders twice (no rows, one row) and: PageHeader title = menu label; exactly ONE FilterBar (these screens had none); table header row inside the scroll box also when empty with ONE EmptyState
// in the body; money columns right aligned with NPR in the header and two decimals; API 500 keeps the title and the filters with an ErrorState (reference + Retry); 501 operation_pending = NotAvailable
// with the header row. Not pinned (notes): the other worklist tabs, /billing/dues, /billing/daily-cash, the settings form (T0D-PRINTCFG-1), discounts (T0D-FINCTRL-1).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { http } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { REF, U, expectCellTitles, expectEmptyState, expectErrorState, expectFilterBars, expectHeader, expectMoneyColumn, expectNotAvailable, expectTable, npr, page, problem } from '@/__tests__/uilist2.helpers';

const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/billing/credit-parties',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['billing.invoice.read', 'billing.credit_party.read', 'billing.credit_party.manage', 'billing.data.export', 'billing.settings.manage', 'billing.refund.approve'], displayName: 'Synthetic Finance', membershipId: '01950c12-0000-7000-8000-000000000900', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/billing/credit-parties',
}));

const actor = { membership_id: U(90), display_name: 'Synthetic Cashier' };
interface Case { path: string; file: string; main: string; row: unknown; empty: RegExp; heads: string[]; money: RegExp[]; titled?: RegExp; others?: string[] }
const CASES: Case[] = [
  {
    path: '/billing/credit-parties', file: 'credit-parties/page', main: '/v1/billing/credit-parties', empty: /no credit parties/i, heads: ['Code', 'Name', 'Credit days', 'Lock'], money: [/^Limit\b/i, /^Used\b/i],
    row: { id: U(7), code: 'SYN-CP-1', name: 'Synthetic Corp', credit_limit_paisa: 50000000, credit_days: 30, is_locked: false, outstanding: npr(1234567), version: 1 },
  },
  {
    path: '/billing/registers', file: 'registers/page', main: '/v1/billing/registers/sales', empty: /no entries/i, heads: ['B.S. date', 'A.D. date', 'Invoice no', 'Buyer', 'Status'], money: [/^Total\b/i, /^Taxable\b/i, /^VAT\b/i],
    others: ['/v1/billing/registers/cancelled-invoices', '/v1/billing/registers/credit-notes'], titled: /^Buyer$/i,
    row: { sn: 1, invoice_date_bs: '2083-07-21', invoice_date_ad: '2026-11-07', invoice_no: 'INV/2083-84/000042', buyer_name: 'Synthetic Buyer', buyer_pan: '123456789', total: npr(113000), exempt: npr(0), taxable: npr(100000), vat: npr(13000), other_tax: npr(0), status: 'issued' },
  },
  {
    path: '/billing/audit-trail', file: 'audit-trail/page', main: '/v1/billing/audit-trail', empty: /no activity/i, heads: ['Time', 'User', 'Action', 'Document', 'Details'], money: [], titled: /^Action$/i,
    row: { occurred_at: '2026-11-07T04:00:00.000Z', actor, action: 'invoice.cancelled', entity_type: 'invoice', entity_id: U(1), summary: 'Synthetic summary' },
  },
  {
    path: '/billing/cbms', file: 'cbms/page', main: '/v1/billing/cbms/documents', empty: /no documents/i, heads: ['Kind', 'Document no', 'State', 'Attempts'], money: [], titled: /^Last outcome$/i,
    row: { document_kind: 'invoice', document_id: U(1), document_no: 'INV/2083-84/000042', cbms_state: 'pending', attempts: 1, last_attempt_at: '2026-11-07T04:00:00.000Z', last_outcome: 'not_configured' },
  },
  {
    path: '/billing/worklist', file: 'worklist/page', main: '/v1/billing/credit-note-tasks', empty: /no credit notes/i, heads: ['Invoice', 'Cause', 'Lines', 'Created'], money: [],
    others: ['/v1/billing/finance-review-items', '/v1/billing/refund-requests'],
    row: { id: U(8), order_id: U(5), invoice_id: U(1), invoice_line_ids: [U(10)], cause: 'test_cancelled', status: 'open', created_at: '2026-11-07T04:00:00.000Z' },
  },
];

const api = setupServer();
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());
const serve = (c: Case, main: () => Response) => api.use(
  http.get(`${ORIGIN}${c.main}`, main),
  ...(c.others ?? []).map((p) => http.get(`${ORIGIN}${p}`, () => page([]))),
  http.all(`${ORIGIN}/v1/*`, () => page([])),
);
async function show(c: Case) {
  const mod = await import(/* @vite-ignore */ `../../../app/(staff)/billing/${c.file}.tsx`);
  const tree = await (mod.default as (p: never) => Promise<never>)({ searchParams: Promise.resolve({}), params: Promise.resolve({}) } as never).catch((e: unknown) => { throw new Error(`the page threw to the error page instead of keeping its title with an ErrorState: ${String(e)}`); });
  return render(<ToastProvider>{tree}</ToastProvider>);
}

describe.each(CASES)('$path', (c) => {
  it('no rows: menu title, ONE FilterBar, header row in the scroll box, one EmptyState in the body', async () => {
    serve(c, () => page([]));
    const { container } = await show(c);
    expectHeader(container, c.path);
    expectFilterBars(container, c.path, 1);
    expectTable(container, c.path, { min: c.heads.length, headers: c.heads });
    expectEmptyState(container, c.path, { title: c.empty });
  });

  it('one row: ONE FilterBar, the row sits under the header, no EmptyState; money columns right aligned with NPR in the header', async () => {
    serve(c, () => page([c.row]));
    const { container } = await show(c);
    expectHeader(container, c.path);
    expectFilterBars(container, c.path, 1);
    expectTable(container, c.path, { min: c.heads.length, headers: c.heads });
    expect(container.querySelectorAll('tbody tr, [role="row"]').length, `${c.path}: a body row`).toBeGreaterThanOrEqual(2);
    for (const m of c.money) expectMoneyColumn(container, c.path, m);
    if (c.titled) expectCellTitles(container, c.path, c.titled);
    expect(container.querySelectorAll('.lims-state').length).toBe(0);
  });

  it('API 500: title and the filter row stay, ErrorState with reference and Retry', async () => {
    serve(c, () => problem(500, 'common.internal'));
    const { container } = await show(c);
    expectErrorState(container, c.path, { filters: 1 });
    expect(container.textContent).toContain(REF);
  });

  it('API 501 operation_pending: NotAvailable keeps the title and the header row', async () => {
    serve(c, () => problem(501, 'operation_pending'));
    const { container } = await show(c);
    expectNotAvailable(container, c.path, { table: true });
  });
});
