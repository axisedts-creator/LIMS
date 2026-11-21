// @vitest-environment jsdom
// T0D-UILIST-2 (LD-353 templates 1 LIST, rules 3, 5, 6, 8; done_when 2, 3, 4, 7; LD-358) — /billing/accounts/entries, /ledger, /pocket, /summary.
// Pinned: PageHeader title = menu label; ONE FilterBar per screen; entries: 13+ columns scroll inside the table box with a "Columns" chooser and a sticky first column, From and To dates the same
// control with the helper YYYY-MM-DD under each; ledger and pocket: ONE filter row (party, from, to, Show) and Print + Export CSV at the right of the HEADER only; pocket ledger that the API cannot
// serve (404 or 501) = NotAvailable; summary: reads the LIST operation listAccountSummaries (GET /v1/billing/account-summaries, LD-358; 501 operation_pending = NotAvailable), a search field in the
// FilterBar, header cells on one line (css), money right aligned with NPR in the header and two decimals. API 500 keeps the title (and filters) with an ErrorState.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { REF, U, expectBarButton, expectEmptyState, expectErrorState, expectFilterBars, expectFilterLabels, expectHeader, expectMoneyColumn, expectNotAvailable, expectTable, expectWideTable, headerActions, headerTexts, page, problem } from '@/__tests__/uilist2.helpers';

const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
const ME = U(90), CLIENT = U(4), CENTRE = U(3), PART = U(10), GRP = U(20);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/billing/accounts/entries',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['billing.account.read', 'billing.account.manage', 'billing.account_entry.create', 'billing.account_entry.reverse'], displayName: 'Synthetic Accountant', membershipId: '01a1a98a-ac40-7000-8000-000000000090', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/billing/accounts/entries',
}));

const entry = (o: Record<string, unknown> = {}) => ({
  id: U(101), centre_id: CENTRE, party_kind: 'credit_party', party_id: CLIENT, entry_date: '2026-11-07', account_particular_id: PART, entry_type: 'credit', amount_paisa: 150050, payment_mode: 'bank_transfer',
  bank_name: 'Synthetic Bank', reference_no: 'REF-0001', payment_details: 'Synthetic transfer', comments: 'Synthetic comment', status: 'submitted', receipt_no: 'ACC-000001', created_by: ME, last_modified_by: ME, created_at: '2026-11-07T04:00:00.000Z', ...o,
});
const particulars = [{ id: PART, account_group_id: GRP, code: 'COLLECTION', name: 'Synthetic Collection', is_active: true, version: 1 }];
const centres = [{ id: CENTRE, name: 'Synthetic Centre A1', kind: 'laboratory' }];
const credit = [{ id: CLIENT, name: 'Synthetic Client Alpha', credit_limit_paisa: 50000000, created_at: '2025-04-14T00:00:00.000Z' }];
const statement = () => ({
  party_kind: 'credit_party', party_id: CLIENT, from: '2026-11-01', to: '2026-11-30', opening_balance_paisa: 100000, opening_balance_side: 'credit',
  rows: [{ entry_id: U(101), entry_date: '2026-11-07', receipt_no: 'ACC-000001', entry_type: 'credit', account_particular_id: PART, status: 'submitted', credit_paisa: 150050, debit_paisa: 0, balance_paisa: 250050, balance_side: 'credit' }],
  closing_balance_paisa: 250050, closing_balance_side: 'credit', total_credit_paisa: 150050, total_debit_paisa: 0,
});
const summaryRow = () => ({ party_kind: 'credit_party', party_id: CLIENT, party_name: 'Synthetic Client Alpha', credit_limit_paisa: 50000000, outstanding_paisa: 1234567, outstanding_side: 'debit', is_blocked: false });

const seen: string[] = [];
const api = setupServer();
beforeAll(() => { api.listen({ onUnhandledFrame: 'error' }); api.events.on('request:start', ({ request }) => { seen.push(new URL(request.url).pathname); }); });
beforeEach(() => { seen.length = 0; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());
/** path -> answer; every other /v1 read answers an empty page (lookups: users, centres, credit parties, particulars). */
const serve = (o: Record<string, () => Response>) => api.use(
  ...Object.entries(o).map(([p, h]) => http.get(`${ORIGIN}${p}`, h)),
  http.get(`${ORIGIN}/v1/billing/account-particulars`, () => page(particulars)),
  http.get(`${ORIGIN}/v1/identity/centres`, () => page(centres)),
  http.get(`${ORIGIN}/v1/billing/credit-parties`, () => page(credit)),
  http.all(`${ORIGIN}/v1/*`, () => page([])),
);
async function show(file: string, sp: Record<string, string> = {}) {
  const mod = await import(/* @vite-ignore */ `../../../app/(staff)/billing/accounts/${file}.tsx`);
  const tree = await (mod.default as (p: never) => Promise<never>)({ searchParams: Promise.resolve(sp), params: Promise.resolve({}) } as never).catch((e: unknown) => { throw new Error(`the page threw to the error page instead of keeping its title with an ErrorState: ${String(e)}`); });
  return render(<ToastProvider>{tree}</ToastProvider>);
}
const q = (root: ParentNode, sel: string) => [...root.querySelectorAll(sel)];
const txt = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** The From and To date fields of the bar are the same control and both carry the YYYY-MM-DD helper UNDER the control (done_when 2). */
function expectEqualDates(root: ParentNode, path: string) {
  const fields = q(root, '.lims-filter-bar .lims-field').filter((f) => /^(from|to)\b/i.test(txt(f.querySelector('.lims-label'))));
  expect(fields.length, `${path}: a From and a To field`).toBe(2);
  const [from, to] = fields as [Element, Element];
  expect(to.className, `${path}: From and To fields have the same class`).toBe(from.className);
  const ctl = (f: Element) => f.querySelector('input, [role="group"], select')!;
  expect(ctl(to).className, `${path}: From and To controls are the same size class`).toBe(ctl(from).className);
  expect(ctl(to).getAttribute('maxlength'), `${path}: same max length`).toBe(ctl(from).getAttribute('maxlength'));
  for (const f of fields) {
    const help = f.querySelector('.lims-description');
    expect(txt(help), `${path}: "${txt(f.querySelector('.lims-label'))}" has the helper text`).toMatch(/YYYY-MM-DD/);
    expect(ctl(f).compareDocumentPosition(help!) & Node.DOCUMENT_POSITION_FOLLOWING, `${path}: the helper sits under the control`).toBeTruthy();
  }
}
/** Print and Export CSV: in the header actions at the right, nowhere else (done_when 3). */
function expectPrintCsvInHeader(root: ParentNode, path: string) {
  const acts = headerActions(root);
  expect(acts.some((a) => /print/i.test(a)), `${path}: Print in the header ${JSON.stringify(acts)}`).toBe(true);
  expect(acts.some((a) => /csv/i.test(a)), `${path}: Export CSV in the header ${JSON.stringify(acts)}`).toBe(true);
  const outside = q(root, 'button, a').filter((b) => /print|csv/i.test(txt(b)) && !b.closest('.lims-page-header'));
  expect(outside.map(txt), `${path}: no second Print / CSV group outside the header`).toEqual([]);
}

describe('/billing/accounts/entries', () => {
  const P = '/billing/accounts/entries';
  it('no rows: menu title, ONE filter row, From/To equal with the helper, 13+ columns with chooser and sticky first, one EmptyState', async () => {
    serve({ '/v1/billing/account-ledger-entries': () => page([]) });
    const { container } = await show('entries/page');
    await screen.findByText(/no entries|no account entries/i);
    expectHeader(container, P);
    expectFilterBars(container, P, 1);
    expectEqualDates(container, P);
    expectBarButton(container, P, /reset/i);
    expectTable(container, P, { min: 13, headers: ['Entry Date', /^Credited\b/i, /^Debited\b/i] });
    expectWideTable(container, P, 13);
    expectEmptyState(container, P);
  });

  it('one credit and one debit row: Credited and Debited right aligned, NPR in the header, two decimals', async () => {
    serve({ '/v1/billing/account-ledger-entries': () => page([entry(), entry({ id: U(102), entry_type: 'debit', amount_paisa: 2000000, receipt_no: 'ACC-000002' })]) });
    const { container } = await show('entries/page');
    await screen.findByText('ACC-000001');
    expectFilterBars(container, P, 1);
    expectWideTable(container, P, 13);
    expectMoneyColumn(container, P, /^Credited\b/i);
    expectMoneyColumn(container, P, /^Debited\b/i);
    expect(container.querySelectorAll('.lims-state').length).toBe(0);
  });

  it('API 500: title and filters stay, ErrorState with reference and Retry', async () => {
    serve({ '/v1/billing/account-ledger-entries': () => problem(500, 'common.internal') });
    const { container } = await show('entries/page');
    expectErrorState(container, P, { filters: 1 });
    expect(container.textContent).toContain(REF);
  });
});

describe('/billing/accounts/ledger', () => {
  const P = '/billing/accounts/ledger';
  it('no party yet: menu title, ONE filter row (party, from, to, Show), Print and Export CSV in the header, table header row, one EmptyState', async () => {
    serve({});
    const { container } = await show('ledger/page');
    expectHeader(container, P);
    expectFilterBars(container, P, 1);
    expectFilterLabels(container, P, [/party/i, /^from/i, /^to/i]);
    expectBarButton(container, P, /show/i);
    expectEqualDates(container, P);
    expectPrintCsvInHeader(container, P);
    expectTable(container, P, { min: 6, headers: ['Date', 'Particulars', 'Status'] });
    expectEmptyState(container, P);
  });

  it('with a statement: money right aligned with NPR in the header, same single header actions', async () => {
    serve({ '/v1/billing/account-statement': () => HttpJson(statement()) });
    const { container } = await show('ledger/page', { party_kind: 'credit_party', party_id: CLIENT, from: '2026-11-01', to: '2026-11-30' });
    await screen.findByText('ACC-000001');
    expectHeader(container, P);
    expectFilterBars(container, P, 1);
    expectPrintCsvInHeader(container, P);
    for (const h of [/^Credit\b/i, /^Debit\b/i, /^Balance\b/i]) expectMoneyColumn(container, P, h);
  });

  it('API 500 on the statement: title and filters stay, ErrorState', async () => {
    serve({ '/v1/billing/account-statement': () => problem(500, 'common.internal') });
    const { container } = await show('ledger/page', { party_kind: 'credit_party', party_id: CLIENT });
    expectErrorState(container, P, { filters: 1 });
  });
});

describe('/billing/accounts/pocket', () => {
  const P = '/billing/accounts/pocket';
  it('statement served: ONE filter row, Print and Export CSV in the header, table header and money columns with NPR', async () => {
    serve({ '/v1/billing/account-statement': () => HttpJson({ ...statement(), party_kind: 'user_pocket', party_id: ME }) });
    const { container } = await show('pocket/page');
    await screen.findByText('ACC-000001');
    expectHeader(container, P);
    expectFilterBars(container, P, 1);
    expectFilterLabels(container, P, [/^from/i, /^to/i]);
    expectBarButton(container, P, /show/i);
    expectEqualDates(container, P);
    expectPrintCsvInHeader(container, P);
    expectMoneyColumn(container, P, /^Credit\b/i);
  });

  it.each([[404, 'common.not_found'], [501, 'operation_pending']] as const)('pocket ledger answered %s: the NotAvailable state with the menu title, no red alert', async (status, code) => {
    serve({ '/v1/billing/account-statement': () => problem(status, code) });
    const { container } = await show('pocket/page');
    expectNotAvailable(container, P, { table: true });
  });
});

describe('/billing/accounts/summary', () => {
  const P = '/billing/accounts/summary';
  const LIST = '/v1/billing/account-summaries';
  it('no rows: menu title, ONE FilterBar with a search field, header row on one line, one EmptyState, list operation used', async () => {
    serve({ [LIST]: () => page([]) });
    const { container } = await show('summary/page');
    await screen.findByText(/no (accounts|parties|summaries)|nothing/i).catch(() => undefined);
    expectHeader(container, P);
    expectFilterBars(container, P, 1);
    expect(q(container, '.lims-filter-bar .lims-filter-search input').length, `${P}: a search field in the FilterBar`).toBe(1);
    expectTable(container, P, { min: 10, headers: ['Client Name', /^Credit Limit\b/i, /^Outstanding Amount\b/i, 'Is Blocked'] });
    expectEmptyState(container, P);
    expect(seen, 'one list read (LD-358), not one account-summary call per party').toContain('/v1/billing/account-summaries');
    expect(seen).not.toContain('/v1/billing/account-summary');
  });

  it('one row: Credit limit and Outstanding right aligned with NPR in the header and two decimals; the party name is in the table', async () => {
    serve({ [LIST]: () => page([summaryRow()]) });
    const { container } = await show('summary/page');
    await screen.findByText('Synthetic Client Alpha');
    expectFilterBars(container, P, 1);
    expectMoneyColumn(container, P, /^Credit limit\b/i);
    expectMoneyColumn(container, P, /^Outstanding\b/i);
    expect(headerTexts(container).every((h) => !/\n/.test(h)), 'no header with a line break').toBe(true);
    expect(container.querySelectorAll('.lims-state').length).toBe(0);
  });

  it('list operation still 501 operation_pending: NotAvailable keeps the title and the header row (LD-358)', async () => {
    serve({ [LIST]: () => problem(501, 'operation_pending') });
    const { container } = await show('summary/page');
    expectNotAvailable(container, P, { table: true });
  });

  it('API 500: title and filters stay, ErrorState', async () => {
    serve({ [LIST]: () => problem(500, 'common.internal') });
    const { container } = await show('summary/page');
    expectErrorState(container, P, { filters: 1 });
  });
});

const HttpJson = (body: unknown) => HttpResponse.json(body as never);
