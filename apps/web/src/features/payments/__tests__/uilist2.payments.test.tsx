// @vitest-environment jsdom
// T0D-UILIST-2 (LD-353 template 1 LIST, rules 3, 5, 6, 8; done_when 5 and 7) — payments: /payments/reconciliation and /payments/static-qr.
// Pinned: PageHeader title = menu label (Run now once, in the header); exactly ONE FilterBar (also on the Runs tab: it was only drawn on Open findings); table header row inside the scroll box also when
// empty with ONE EmptyState in the body; money columns right aligned with NPR in the header and two decimals; API 500 keeps the title and filters with an ErrorState (reference + Retry); 501
// operation_pending = NotAvailable with the header row. Not pinned (notes): /payments/review, /payments/refunds, /payments/settings, intent detail (not in done_when 5).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { REF, expectEmptyState, expectErrorState, expectFilterBars, expectHeader, expectMoneyColumn, expectNotAvailable, expectTable, page, problem, props } from '@/__tests__/uilist2.helpers';
import { npr, reconCodes, reconFindings, reconRuns, worksheets } from './rs-c15.fixtures';

const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/payments/reconciliation',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['payments.reconciliation.read', 'payments.intent.resolve', 'payments.intent.read'], displayName: 'Synthetic Finance', membershipId: '01950c12-0000-7000-8000-000000000900', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/payments/reconciliation',
}));

const api = setupServer();
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());
const codeSet = (set: string) => (set === 'finding_kinds' ? reconCodes.finding_kinds : set === 'finding_resolutions' ? reconCodes.finding_resolutions : []);
const serveRecon = (o: { runs?: () => Response; findings?: () => Response } = {}) => api.use(
  http.get(`${ORIGIN}/v1/payments/reconciliation-runs`, o.runs ?? (() => page([]))),
  http.get(`${ORIGIN}/v1/payments/reconciliation-findings`, o.findings ?? (() => page([]))),
  http.get(`${ORIGIN}/v1/payments/coded-sets/:set`, ({ params }) => HttpResponse.json({ data: codeSet(String(params['set'])) })),
  http.get(`${ORIGIN}/v1/payments/intents`, () => page([])),
  http.all(`${ORIGIN}/v1/*`, () => page([])),
);
const serveQr = (list: () => Response) => api.use(
  http.get(`${ORIGIN}/v1/payments/static-qr-reconciliations/preview`, () => HttpResponse.json({ system_entries: 12, system_total: npr(1500000) })),
  http.get(`${ORIGIN}/v1/payments/static-qr-reconciliations`, list),
  http.all(`${ORIGIN}/v1/*`, () => page([])),
);
async function show(file: string) {
  const mod = await import(/* @vite-ignore */ `../../../app/(staff)/payments/${file}.tsx`);
  const tree = await (mod.default as (p: never) => Promise<never>)(props).catch((e: unknown) => { throw new Error(`the page threw to the error page instead of keeping its title with an ErrorState: ${String(e)}`); });
  return render(<ToastProvider>{tree}</ToastProvider>);
}

describe('/payments/reconciliation', () => {
  const P = '/payments/reconciliation';
  const RUN_HEADS = ['Business date', 'Trigger', 'Status', 'Checked', 'Findings', 'Critical', 'Finished'];
  it('no runs: menu title, Run now once in the header, ONE FilterBar on the Runs tab, header row, one EmptyState', async () => {
    serveRecon();
    const { container } = await show('reconciliation/page');
    await screen.findByText(/no reconciliation runs/i);
    expectHeader(container, P, { action: 'Run now' });
    expectFilterBars(container, P, 1);
    expectTable(container, P, { min: RUN_HEADS.length, headers: RUN_HEADS });
    expectEmptyState(container, P, { title: /no reconciliation runs/i });
  });

  it('runs and findings: still ONE FilterBar after opening Open findings; Our amount and Provider amount right aligned with NPR in the header', async () => {
    serveRecon({ runs: () => page(reconRuns), findings: () => page(reconFindings) });
    const { container } = await show('reconciliation/page');
    await screen.findByText(/Completed/);
    expectFilterBars(container, P, 1);
    expectTable(container, P, { min: RUN_HEADS.length, headers: RUN_HEADS });
    await userEvent.setup({ delay: null }).click(screen.getByRole('tab', { name: /open findings/i }));
    // LD-353 FilterBar draws a Kind chip with the same text: assert the cell, scoped to the table.
    await waitFor(() => expect(within(container.querySelector('table')!).getByText('Missed settlement')).toBeTruthy());
    expectHeader(container, P, { action: 'Run now' });
    expectFilterBars(container, P, 1);
    expectMoneyColumn(container, P, /^Our amount\b/i);
    expectMoneyColumn(container, P, /^Provider amount\b/i);
  });

  it('no open findings: header row stays, one EmptyState in the body', async () => {
    serveRecon({ runs: () => page(reconRuns) });
    const { container } = await show('reconciliation/page');
    await screen.findByText(/Completed/);
    await userEvent.setup({ delay: null }).click(screen.getByRole('tab', { name: /open findings/i }));
    await screen.findByText(/no open findings/i);
    expectFilterBars(container, P, 1);
    expectTable(container, P, { min: 8, headers: ['Found', 'Severity', 'Kind', 'Our status'] });
    expectEmptyState(container, P, { title: /no open findings/i });
  });

  it('API 500: title and the filter row stay, ErrorState with reference and Retry', async () => {
    serveRecon({ runs: () => problem(500, 'common.internal') });
    const { container } = await show('reconciliation/page');
    expectErrorState(container, P, { filters: 1 });
    expect(container.textContent).toContain(REF);
  });

  it('API 501 operation_pending: NotAvailable keeps the title and the header row', async () => {
    serveRecon({ runs: () => problem(501, 'operation_pending') });
    const { container } = await show('reconciliation/page');
    expectNotAvailable(container, P, { table: true });
  });
});

describe('/payments/static-qr', () => {
  const P = '/payments/static-qr';
  const HEADS = ['Date', 'Centre', /^System\b/i, /^Statement\b/i, /^Difference\b/i, 'Status', 'By', 'Reference'];
  it('no worksheets: menu title, ONE FilterBar, header row, one EmptyState', async () => {
    serveQr(() => page([]));
    const { container } = await show('static-qr/page');
    await screen.findByText(/no worksheets/i);
    expectHeader(container, P);
    expectFilterBars(container, P, 1);
    expectTable(container, P, { min: HEADS.length, headers: HEADS });
    expectEmptyState(container, P, { title: /no worksheets/i });
  });

  it('two worksheets: System, Statement and Difference right aligned with NPR in the header and two decimals', async () => {
    serveQr(() => page(worksheets));
    const { container } = await show('static-qr/page');
    await screen.findByText('STMT-SYN-1');
    expectHeader(container, P);
    expectFilterBars(container, P, 1);
    for (const h of [/^System\b/i, /^Statement\b/i, /^Difference\b/i]) expectMoneyColumn(container, P, h);
  });

  it('API 500: title and filters stay, ErrorState', async () => {
    serveQr(() => problem(500, 'common.internal'));
    const { container } = await show('static-qr/page');
    expectErrorState(container, P, { filters: 1 });
  });

  it('API 501 operation_pending: NotAvailable keeps the title and the header row', async () => {
    serveQr(() => problem(501, 'operation_pending'));
    const { container } = await show('static-qr/page');
    expectNotAvailable(container, P, { table: true });
  });
});
