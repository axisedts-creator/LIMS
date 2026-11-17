// @vitest-environment jsdom
// T0D-ACCT-1 — lab accounting screens (LD-313, LD-310, founder 2026-11-17 04:49 / 04:57 NPT). Component tests with MSW, empty and filled data, reversal,
// running balance, permission states, catalogue text. Synthetic data only.
// ASSUMED prop contract (the spec fixes only names/paths; dispute through the writer note if wrong). All under apps/web/src/features/billing/components/accounts/:
//   AccountEntriesScreen({entries, particulars, parties, centres, members, permissions, filters?})   route billing/accounts/entries  (rows = AccountLedgerEntry)
//   AccountLedgerScreen({statement|null, party|null, parties, from, to, particulars, permissions})    route billing/accounts/ledger   (statement = AccountStatement)
//   PocketLedgerScreen({statement|null, ownerId, currentMembershipId, owners, from, to, particulars, permissions})  route billing/accounts/pocket
//   AccountSummaryScreen({summaries, parties, permissions})                                           route billing/accounts/summary  (summaries = AccountSummary[])
//   AccountMastersScreen({groups, particulars, permissions})                                          route billing/accounts/masters
//   AccountReceiptView({entry, party, particular, centre})                                            printable receipt layout (receipt number)
// parties = [{id, kind: 'credit_party'|'franchise'|'user_pocket'|'laboratory', name, centre_name?, franchise_name?, address?, joined_on?, contact_person?, phone?, email?, pan?}]
// Text comes from the message catalogue (apps/web/src/core/i18n/messages.ts, keys billing.accounts.*); money = paisa shown as rupees; every empty table keeps headers.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/billing/accounts/entries',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Accountant', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/billing/accounts/entries',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const CENTRE = U(3), CLIENT = U(4), FRANCHISE = U(5), PART_FEE = U(10), PART_BANK = U(11), GRP = U(20), ME = U(90), OTHER = U(91);
const E1 = U(101), E2 = U(102), E3 = U(103), E4 = U(104);

const READ = ['billing.account.read'];
const CREATE = ['billing.account.read', 'billing.account_entry.create'];
const FULL = ['billing.account.read', 'billing.account.manage', 'billing.account_entry.create', 'billing.account_entry.reverse'];

const centres = [{ id: CENTRE, name: 'Synthetic Centre A1' }];
const parties = [
  { id: CLIENT, kind: 'credit_party', name: 'Synthetic Client Alpha', centre_name: 'Synthetic Centre A1', address: 'Synthetic Road 1', joined_on: '2025-04-14', contact_person: 'Synthetic Contact', phone: '9800000000', email: 'alpha@example.test', pan: '123456789' },
  { id: FRANCHISE, kind: 'franchise', name: 'Synthetic Franchise Beta', centre_name: 'Synthetic Centre A1', franchise_name: 'Synthetic Franchise Beta', address: 'Synthetic Marg 2', joined_on: '2024-01-20', contact_person: 'Synthetic Owner', phone: '9811111111', email: 'beta@example.test', pan: '987654321' },
  { id: ME, kind: 'user_pocket', name: 'Synthetic Accountant' },
];
const particulars = [
  { id: PART_FEE, account_group_id: GRP, code: 'COLLECTION', name: 'Synthetic Collection', is_active: true, version: 1 },
  { id: PART_BANK, account_group_id: GRP, code: 'BANK_DEPOSIT', name: 'Synthetic Bank Deposit', is_active: true, version: 1 },
];
const members = [{ id: ME, name: 'Synthetic Accountant' }, { id: OTHER, name: 'Synthetic Cashier' }];

const entry = (o: Record<string, unknown> = {}) => ({
  id: E1, centre_id: CENTRE, party_kind: 'credit_party', party_id: CLIENT, entry_date: '2026-11-07', account_particular_id: PART_FEE, entry_type: 'credit', amount_paisa: 150050,
  payment_mode: 'bank_transfer', bank_name: 'Synthetic Bank', reference_no: 'REF-0001', payment_details: 'Synthetic transfer', comments: 'Synthetic comment', status: 'submitted',
  receipt_no: 'ACC-000001', created_by: ME, last_modified_by: ME, created_at: '2026-11-07T04:00:00.000Z', ...o,
});
const entries = [
  entry(),
  entry({ id: E2, entry_type: 'debit', amount_paisa: 2000000, receipt_no: 'ACC-000002', party_kind: 'franchise', party_id: FRANCHISE, payment_mode: 'cash', bank_name: undefined, reference_no: undefined, payment_details: undefined, comments: undefined, last_modified_by: OTHER, status: 'approved' }),
  entry({ id: E3, receipt_no: 'ACC-000003', status: 'reversed' }),
  entry({ id: E4, receipt_no: 'ACC-000004', entry_type: 'debit', reverses_entry_id: E3, status: 'submitted' }),
];

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const api = setupServer(
  http.post(`${ORIGIN}/v1/billing/account-ledger-entries`, async ({ request }) => { await rec(request); return HttpResponse.json(entry({ id: U(110), receipt_no: 'ACC-000009' }), { status: 201 }); }),
  http.post(`${ORIGIN}/v1/billing/account-ledger-entries/:id/reverse`, async ({ request }) => { await rec(request); return HttpResponse.json(entry({ id: U(111), reverses_entry_id: E1, entry_type: 'debit' }), { status: 201 }); }),
  http.post(`${ORIGIN}/v1/billing/account-groups`, async ({ request }) => { await rec(request); return HttpResponse.json({ id: U(21), code: 'NEW', name: 'New group', nature: 'income', is_active: true, version: 1, created_at: '2026-11-07T04:00:00.000Z', updated_at: '2026-11-07T04:00:00.000Z' }, { status: 201 }); }),
  http.post(`${ORIGIN}/v1/billing/account-particulars`, async ({ request }) => { await rec(request); return HttpResponse.json(particulars[0], { status: 201 }); }),
  http.patch(`${ORIGIN}/v1/billing/account-groups/:id`, async ({ request }) => { await rec(request); return HttpResponse.json({}, { status: 200 }); }),
  http.patch(`${ORIGIN}/v1/billing/account-particulars/:id`, async ({ request }) => { await rec(request); return HttpResponse.json({}, { status: 200 }); }),
  http.all(`${ORIGIN}/v1/billing/*`, async ({ request }) => { await rec(request); return HttpResponse.json({}, { status: 200 }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); refresh.mockReset(); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const mod = async <T,>(p: string) => (await import(/* @vite-ignore */ `../components/accounts/${p}`)) as T;
const money = (rupees: string) => new RegExp(`(NPR|Rs\\.)\\s?${rupees.replace(/[.,]/g, '\\$&')}`);
const AD = /\d{2}\/\d{2}\/\d{4}/;
const BS = /\d{4}-\d{2}-\d{2}/;
const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent!.trim());
const placeholders = () => document.querySelectorAll('.lims-row-placeholder[aria-hidden="true"]').length;
const reasonOf = (el: HTMLElement) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
const expectBlockedWithReason = (btn: HTMLElement, key: string) => {
  expect(t(key), `catalogue key ${key} must exist`).not.toBe(key);
  expect((btn as HTMLButtonElement).disabled || btn.getAttribute('aria-disabled') === 'true', 'button is disabled').toBe(true);
  expect(reasonOf(btn), 'visible reason linked by aria-describedby').toContain(t(key));
  expect(document.body.textContent).toContain(t(key));
};
const pick = async (user: ReturnType<typeof userEvent.setup>, scope: HTMLElement, label: RegExp, option: RegExp) => {
  await user.click(within(scope).getByRole('button', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
};
/** Records every iframe (PrintFrame) added to the page, because PrintFrame removes it right after printing. */
const watchIframes = () => {
  const titles: string[] = [];
  const mo = new MutationObserver((ms) => { for (const m of ms) m.addedNodes.forEach((n) => { if (n instanceof HTMLIFrameElement) titles.push(n.title); }); });
  mo.observe(document.body, { childList: true, subtree: true });
  return { titles, stop: () => mo.disconnect() };
};

const VIEW_ACCOUNT_COLUMNS = ['Laboratory', 'Client', 'Franchise', 'Entry Date', 'Particulars', 'Credited', 'Debited', 'Comments', 'Payment Mode', 'Reference Number', 'Bank Details', 'Payment Details', 'Last Modified By', 'Entry Status', 'Download Receipt'];
const SUMMARY_COLUMNS = ['Center', 'Client Name', 'Franchise', 'Address', 'Joining Date', 'Contact Person', 'Contact No', 'Email', 'PAN No', 'Credit Limit', 'Outstanding Amount', 'Debit/Credit', 'Is Blocked'];

const entriesProps = (o: Record<string, unknown> = {}) => ({ entries, particulars, parties, centres, members, permissions: FULL, ...o });
const stmtRow = (o: Record<string, unknown>) => ({ entry_id: E1, entry_date: '2026-11-07', receipt_no: 'ACC-000001', entry_type: 'credit', account_particular_id: PART_FEE, status: 'submitted', credit_paisa: 0, debit_paisa: 0, balance_paisa: 0, balance_side: 'credit', ...o });
const statement = (o: Record<string, unknown> = {}) => ({
  party_kind: 'credit_party', party_id: CLIENT, from: '2026-11-01', to: '2026-11-30', opening_balance_paisa: 100000, opening_balance_side: 'credit',
  rows: [
    stmtRow({ entry_id: E1, receipt_no: 'ACC-000001', entry_type: 'credit', credit_paisa: 150050, balance_paisa: 250050, balance_side: 'credit' }),
    stmtRow({ entry_id: E2, receipt_no: 'ACC-000002', entry_date: '2026-11-09', entry_type: 'debit', debit_paisa: 400000, balance_paisa: 149950, balance_side: 'debit' }),
  ],
  closing_balance_paisa: 149950, closing_balance_side: 'debit', total_credit_paisa: 150050, total_debit_paisa: 400000, ...o,
});

// ───────────────────────── Account Entry / View Account ─────────────────────────
describe('billing/accounts/entries — View Account list + Account Entry form', () => {
  const load = async () => (await mod<{ AccountEntriesScreen: any }>('AccountEntriesScreen')).AccountEntriesScreen;

  it('columns are exactly the ElabAssist View Account columns, in order, from the catalogue', async () => {
    const S = await load();
    wrap(<S {...entriesProps()} />);
    expect(headers()).toEqual(VIEW_ACCOUNT_COLUMNS);
    expect(screen.getByRole('heading', { name: t('billing.accounts.entries.title') })).toBeTruthy();
    expect(t('billing.accounts.entries.title')).not.toBe('billing.accounts.entries.title');
  });

  it('filled row: names resolved, credit and debit in separate right aligned columns, rupees from paisa, AD with BS, status as text', async () => {
    const S = await load();
    wrap(<S {...entriesProps()} />);
    const row1 = screen.getByText('ACC-000001').closest('tr') ?? screen.getAllByRole('row').find((r) => /Synthetic Client Alpha/.test(r.textContent!))!;
    const cells = within(row1).getAllByRole('gridcell').length ? within(row1).getAllByRole('gridcell') : within(row1).getAllByRole('cell');
    const text = row1.textContent!;
    expect(text).toContain('Synthetic Centre A1');
    expect(text).toContain('Synthetic Client Alpha');
    expect(text).toContain('Synthetic Collection');
    expect(text).toMatch(money('1,500.50'));
    expect(text).not.toMatch(/150050|1500\.5\b/); // never raw paisa
    expect(text).toMatch(AD);
    expect(text).toMatch(BS); // BS beside AD
    expect(text).toContain('Synthetic comment');
    expect(text).toContain('Bank transfer');
    expect(text).toContain('REF-0001');
    expect(text).toContain('Synthetic Bank');
    expect(text).toContain('Synthetic transfer');
    expect(text).toContain('Synthetic Accountant');
    expect(text).toMatch(/submitted/i);
    // credit in Credited column, nothing in Debited
    const idx = (h: string) => headers().indexOf(h);
    expect(cells[idx('Credited')]!.textContent).toMatch(money('1,500.50'));
    expect(cells[idx('Debited')]!.textContent).not.toMatch(/\d/);
    expect(cells[idx('Credited')]!.className).toMatch(/lims-align-end/);
    expect(cells[idx('Debited')]!.className).toMatch(/lims-align-end/);
    // franchise entry
    const row2 = screen.getAllByRole('row').find((r) => /Synthetic Franchise Beta/.test(r.textContent!) && /ACC-000002|20,000\.00/.test(r.textContent!))!;
    expect(row2.textContent).toMatch(money('20,000.00'));
    expect(row2.textContent).toMatch(/approved/i);
    expect(row2.textContent).toContain('Synthetic Cashier');
  });

  it('empty list keeps all 15 headers, a catalogue message row and 4 inert placeholder rows (T0D-EMPTYTBL-1)', async () => {
    const S = await load();
    wrap(<S {...entriesProps({ entries: [] })} />);
    expect(headers()).toEqual(VIEW_ACCOUNT_COLUMNS);
    expect(screen.getByText(t('billing.accounts.entries.empty'))).toBeTruthy();
    expect(t('billing.accounts.entries.empty')).not.toBe('billing.accounts.entries.empty');
    expect(placeholders()).toBe(4);
  });

  it('filters: centre, party, particular, type, status, date range inside a labelled search region', async () => {
    const S = await load();
    wrap(<S {...entriesProps()} />);
    const bar = screen.getByRole('search');
    for (const l of [/centre|laboratory/i, /party|client/i, /particular/i, /type/i, /status/i, /from/i, /to\b/i]) expect(within(bar).getAllByText(l).length, String(l)).toBeGreaterThan(0);
  });

  it('applying a filter pushes the URL with the API query names', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...entriesProps()} />);
    const bar = screen.getByRole('search');
    await pick(user, bar, /status/i, /submitted/i);
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(String(push.mock.calls.at(-1)![0])).toMatch(/status=submitted/);
  });

  it('a New entry button opens the Account Entry form with every ElabAssist field and Submit + Search', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...entriesProps()} />);
    await user.click(screen.getByRole('button', { name: new RegExp(t('billing.accounts.entries.new'), 'i') }));
    const dlg = await screen.findByRole('dialog');
    for (const l of [/laboratory/i, /client/i, /franchise/i, /entry date/i, /particulars/i, /amount/i, /type/i, /comments/i, /payment mode/i, /bank/i, /payment details/i, /reference/i]) {
      expect(within(dlg).getAllByText(l).length, String(l)).toBeGreaterThan(0);
    }
    expect(within(dlg).getByRole('button', { name: /submit/i })).toBeTruthy();
    expect(screen.getByRole('search')).toBeTruthy(); // Search stays on the page filters
  });

  it('Submit sends paisa as an integer, party_kind from the picked client, Idempotency-Key; no PUT/PATCH/DELETE', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...entriesProps()} />);
    await user.click(screen.getByRole('button', { name: new RegExp(t('billing.accounts.entries.new'), 'i') }));
    const dlg = await screen.findByRole('dialog');
    await pick(user, dlg, /laboratory/i, /Synthetic Centre A1/);
    await pick(user, dlg, /client/i, /Synthetic Client Alpha/);
    await pick(user, dlg, /particulars/i, /Synthetic Collection/);
    await pick(user, dlg, /^type|type\b/i, /credit/i);
    await pick(user, dlg, /payment mode/i, /bank transfer/i);
    await user.type(within(dlg).getByLabelText(/entry date/i), '2026-11-07');
    await user.type(within(dlg).getByLabelText(/amount/i), '1500.50');
    await user.type(within(dlg).getByLabelText(/bank/i), 'Synthetic Bank');
    await user.click(within(dlg).getByRole('button', { name: /submit/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/v1/billing/account-ledger-entries');
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(c.body).toMatchObject({ centre_id: CENTRE, party_kind: 'credit_party', party_id: CLIENT, entry_date: '2026-11-07', account_particular_id: PART_FEE, entry_type: 'credit', amount_paisa: 150050, payment_mode: 'bank_transfer', bank_name: 'Synthetic Bank' });
    expect(Number.isInteger(c.body.amount_paisa)).toBe(true);
    expect(calls.filter((x) => ['PUT', 'PATCH', 'DELETE'].includes(x.method))).toEqual([]);
  });

  it('Submit with nothing picked sends no request and shows field errors', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...entriesProps()} />);
    await user.click(screen.getByRole('button', { name: new RegExp(t('billing.accounts.entries.new'), 'i') }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /submit/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
    expect(within(dlg).getAllByText(/required|choose|enter/i).length).toBeGreaterThan(0);
  });

  it('amount of zero or negative or more than 2 decimals is refused client side (no request)', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...entriesProps()} />);
    await user.click(screen.getByRole('button', { name: new RegExp(t('billing.accounts.entries.new'), 'i') }));
    const dlg = await screen.findByRole('dialog');
    await pick(user, dlg, /laboratory/i, /Synthetic Centre A1/);
    await pick(user, dlg, /client/i, /Synthetic Client Alpha/);
    await pick(user, dlg, /particulars/i, /Synthetic Collection/);
    await pick(user, dlg, /^type|type\b/i, /credit/i);
    await pick(user, dlg, /payment mode/i, /cash/i);
    await user.type(within(dlg).getByLabelText(/entry date/i), '2026-11-07');
    await user.type(within(dlg).getByLabelText(/amount/i), '0');
    await user.click(within(dlg).getByRole('button', { name: /submit/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
  });

  it('reversal only: no Edit or Delete control anywhere; each live row has a Reverse action', async () => {
    const S = await load();
    wrap(<S {...entriesProps()} />);
    expect(screen.queryByRole('button', { name: /^(edit|delete|remove|update)\b/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /^(edit|delete|remove)\b/i })).toBeNull();
    expect(screen.getAllByRole('button', { name: new RegExp(t('billing.accounts.entries.reverse'), 'i') }).length).toBeGreaterThanOrEqual(2);
  });

  it('Reverse asks for a reason: blank reason sends nothing; with a reason POSTs reason_text with Idempotency-Key then refreshes', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...entriesProps()} />);
    const row = screen.getAllByRole('row').find((r) => /ACC-000001|1,500\.50/.test(r.textContent!) && /Synthetic Client Alpha/.test(r.textContent!) && !/reversed/i.test(r.textContent!))!;
    await user.click(within(row).getByRole('button', { name: new RegExp(t('billing.accounts.entries.reverse'), 'i') }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: new RegExp(t('billing.accounts.entries.reverse_confirm'), 'i') }));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]); // reason required
    expect(within(dlg).getAllByText(/reason/i).length).toBeGreaterThan(0);
    await user.type(within(dlg).getByLabelText(new RegExp(t('billing.accounts.entries.reverse_reason'), 'i')), 'Wrong client picked');
    await user.click(within(dlg).getByRole('button', { name: new RegExp(t('billing.accounts.entries.reverse_confirm'), 'i') }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe(`/v1/billing/account-ledger-entries/${E1}/reverse`);
    expect(calls[0]!.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(calls[0]!.body).toEqual({ reason_text: 'Wrong client picked' });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('a whitespace only reason is refused; a 501 character reason is refused (contract maxLength 500)', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...entriesProps()} />);
    const row = screen.getAllByRole('row').find((r) => /Synthetic Client Alpha/.test(r.textContent!) && /ACC-000001|1,500\.50/.test(r.textContent!))!;
    await user.click(within(row).getByRole('button', { name: new RegExp(t('billing.accounts.entries.reverse'), 'i') }));
    const dlg = await screen.findByRole('dialog');
    const box = within(dlg).getByLabelText(new RegExp(t('billing.accounts.entries.reverse_reason'), 'i'));
    await user.type(box, '    ');
    await user.click(within(dlg).getByRole('button', { name: new RegExp(t('billing.accounts.entries.reverse_confirm'), 'i') }));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
    await user.clear(box);
    await user.click(box);
    await user.paste('x'.repeat(501));
    await user.click(within(dlg).getByRole('button', { name: new RegExp(t('billing.accounts.entries.reverse_confirm'), 'i') }));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
  });

  it('already reversed entries and reversal entries cannot be reversed again (disabled with a visible reason)', async () => {
    const S = await load();
    wrap(<S {...entriesProps()} />);
    const reversedRow = screen.getAllByRole('row').find((r) => /ACC-000003/.test(r.textContent!) || (/reversed/i.test(r.textContent!) && /Synthetic Client Alpha/.test(r.textContent!)))!;
    expectBlockedWithReason(within(reversedRow).getByRole('button', { name: new RegExp(t('billing.accounts.entries.reverse'), 'i') }), 'billing.accounts.reason.already_reversed');
    const reversalRow = screen.getAllByRole('row').find((r) => /ACC-000004/.test(r.textContent!))!;
    expectBlockedWithReason(within(reversalRow).getByRole('button', { name: new RegExp(t('billing.accounts.entries.reverse'), 'i') }), 'billing.accounts.reason.is_reversal');
  });

  it('permissions: read only user sees the list but New entry and Reverse are disabled with a visible reason', async () => {
    const S = await load();
    wrap(<S {...entriesProps({ permissions: READ })} />);
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    expectBlockedWithReason(screen.getByRole('button', { name: new RegExp(t('billing.accounts.entries.new'), 'i') }), 'billing.accounts.reason.no_create');
    const reverse = screen.getAllByRole('button', { name: new RegExp(t('billing.accounts.entries.reverse'), 'i') });
    for (const b of reverse) expect((b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true').toBe(true);
    expectBlockedWithReason(reverse[0]!, 'billing.accounts.reason.no_reverse');
  });

  it('permissions: create without reverse can add entries but not reverse', async () => {
    const S = await load();
    wrap(<S {...entriesProps({ permissions: CREATE })} />);
    const neu = screen.getByRole('button', { name: new RegExp(t('billing.accounts.entries.new'), 'i') });
    expect((neu as HTMLButtonElement).disabled).toBe(false);
    expect(neu.getAttribute('aria-disabled')).not.toBe('true');
    expectBlockedWithReason(screen.getAllByRole('button', { name: new RegExp(t('billing.accounts.entries.reverse'), 'i') })[0]!, 'billing.accounts.reason.no_reverse');
  });

  it('Download Receipt per row opens a print frame titled with the receipt number', async () => {
    const S = await load();
    const user = userEvent.setup();
    const w = watchIframes();
    wrap(<S {...entriesProps()} />);
    const row = screen.getAllByRole('row').find((r) => /Synthetic Client Alpha/.test(r.textContent!) && /ACC-000001|1,500\.50/.test(r.textContent!))!;
    await user.click(within(row).getByRole('button', { name: /download receipt/i }) );
    await waitFor(() => expect(w.titles.join('|')).toMatch(/ACC-000001/));
    w.stop();
  });

  it('axe: populated and empty, form dialog open', async () => {
    const S = await load();
    const user = userEvent.setup();
    const a = wrap(<S {...entriesProps()} />);
    await noAxeViolations();
    a.unmount();
    const b = wrap(<S {...entriesProps({ entries: [] })} />);
    await noAxeViolations();
    b.unmount();
    wrap(<S {...entriesProps()} />);
    await user.click(screen.getByRole('button', { name: new RegExp(t('billing.accounts.entries.new'), 'i') }));
    await screen.findByRole('dialog');
    await noAxeViolations();
  });
});

// ───────────────────────── Receipt ─────────────────────────
describe('receipt layout', () => {
  const load = async () => (await mod<{ AccountReceiptView: any }>('AccountReceiptView')).AccountReceiptView;
  it('printable receipt shows the receipt number, party, particular, amount in rupees and in words, mode, dual dates and the status', async () => {
    const R = await load();
    wrap(<R entry={entry()} party={parties[0]} particular={particulars[0]} centre={centres[0]} />);
    const doc = screen.getByRole('article');
    expect(doc.getAttribute('aria-label')).toMatch(/ACC-000001/);
    const text = doc.textContent!;
    expect(text).toContain('ACC-000001');
    expect(text).toContain('Synthetic Client Alpha');
    expect(text).toContain('Synthetic Collection');
    expect(text).toContain('Synthetic Centre A1');
    expect(text).toMatch(money('1,500.50'));
    expect(text).toMatch(/One Thousand Five Hundred Rupees and Fifty Paisa Only/);
    expect(text).toContain('Bank transfer');
    expect(text).toMatch(AD);
    expect(text).toMatch(BS);
    expect(text).not.toMatch(/IRD|tax invoice/i); // a ledger receipt is not a fiscal document
  });
  it('a reversed entry receipt says so in text', async () => {
    const R = await load();
    wrap(<R entry={entry({ status: 'reversed' })} party={parties[0]} particular={particulars[0]} centre={centres[0]} />);
    expect(screen.getByRole('article').textContent).toMatch(/reversed/i);
  });
});

// ───────────────────────── Ledger (party statement) ─────────────────────────
describe('billing/accounts/ledger — party ledger statement', () => {
  const load = async () => (await mod<{ AccountLedgerScreen: any }>('AccountLedgerScreen')).AccountLedgerScreen;
  const props = (o: Record<string, unknown> = {}) => ({ statement: statement(), party: parties[0], parties, from: '2026-11-01', to: '2026-11-30', particulars, permissions: READ, ...o });

  it('pick a party and dates: a labelled search region with party, from, to', async () => {
    const S = await load();
    wrap(<S {...props({ statement: null, party: null })} />);
    const bar = screen.getByRole('search');
    for (const l of [/party|client/i, /from/i, /to\b/i]) expect(within(bar).getAllByText(l).length, String(l)).toBeGreaterThan(0);
    expect(headers().length).toBeGreaterThanOrEqual(6); // headers are drawn before a party is chosen
    expect(screen.getByText(t('billing.accounts.ledger.pick_party'))).toBeTruthy();
    expect(t('billing.accounts.ledger.pick_party')).not.toBe('billing.accounts.ledger.pick_party');
  });

  it('shows opening balance, every row with a running balance, closing balance and totals; credit and debit in separate right aligned columns', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    for (const h of ['Date', 'Receipt', 'Particulars', 'Credit', 'Debit', 'Balance']) expect(headers().some((x) => new RegExp(`^${h}`, 'i').test(x)), h).toBe(true);
    const text = document.body.textContent!;
    expect(text).toContain(t('billing.accounts.ledger.opening'));
    expect(text).toContain(t('billing.accounts.ledger.closing'));
    expect(text).toContain(t('billing.accounts.ledger.total_credit'));
    expect(text).toContain(t('billing.accounts.ledger.total_debit'));
    const opening = screen.getAllByRole('row').find((r) => r.textContent!.includes(t('billing.accounts.ledger.opening')))!;
    expect(opening.textContent).toMatch(money('1,000.00'));
    expect(opening.textContent).toMatch(/credit|Cr/i);
    const r1 = screen.getAllByRole('row').find((r) => r.textContent!.includes('ACC-000001'))!;
    const r2 = screen.getAllByRole('row').find((r) => r.textContent!.includes('ACC-000002'))!;
    expect(r1.textContent).toMatch(money('1,500.50'));
    expect(r1.textContent).toMatch(money('2,500.50')); // running balance after row 1
    expect(r1.textContent).toMatch(/credit|Cr/i);
    expect(r2.textContent).toMatch(money('4,000.00'));
    expect(r2.textContent).toMatch(money('1,499.50')); // running balance after row 2
    expect(r2.textContent).toMatch(/debit|Dr/i);
    expect(r1.textContent).toMatch(AD);
    const cells = within(r1).getAllByRole('gridcell').length ? within(r1).getAllByRole('gridcell') : within(r1).getAllByRole('cell');
    const ci = headers().findIndex((h) => /^credit/i.test(h)), di = headers().findIndex((h) => /^debit/i.test(h)), bi = headers().findIndex((h) => /^balance/i.test(h));
    expect(cells[ci]!.textContent).toMatch(money('1,500.50'));
    expect(cells[di]!.textContent).not.toMatch(/\d/);
    for (const i of [ci, di, bi]) expect(cells[i]!.className).toMatch(/lims-align-end/);
    const closing = screen.getAllByRole('row').find((r) => r.textContent!.includes(t('billing.accounts.ledger.closing')))!;
    expect(closing.textContent).toMatch(money('1,499.50'));
    expect(closing.textContent).toMatch(/debit|Dr/i);
    const totals = document.body.textContent!;
    expect(totals).toMatch(money('1,500.50'));
    expect(totals).toMatch(money('4,000.00'));
  });

  it('lakh grouping on large balances', async () => {
    const S = await load();
    wrap(<S {...props({ statement: statement({ opening_balance_paisa: 123456789 }) })} />);
    expect(document.body.textContent).toMatch(money('12,34,567.89'));
  });

  it('empty period still draws headers, opening and closing balance and 4 placeholder rows', async () => {
    const S = await load();
    wrap(<S {...props({ statement: statement({ rows: [], total_credit_paisa: 0, total_debit_paisa: 0, closing_balance_paisa: 100000, closing_balance_side: 'credit' }) })} />);
    expect(headers().length).toBeGreaterThanOrEqual(6);
    expect(document.body.textContent).toContain(t('billing.accounts.ledger.opening'));
    expect(document.body.textContent).toContain(t('billing.accounts.ledger.closing'));
    expect(screen.getByText(t('billing.accounts.ledger.empty'))).toBeTruthy();
    expect(placeholders()).toBe(4);
  });

  it('reversed and reversal rows are shown with their status text, not hidden', async () => {
    const S = await load();
    wrap(<S {...props({ statement: statement({ rows: [stmtRow({ entry_id: E3, receipt_no: 'ACC-000003', status: 'reversed', credit_paisa: 100, balance_paisa: 100 }), stmtRow({ entry_id: E4, receipt_no: 'ACC-000004', reverses_entry_id: E3, entry_type: 'debit', debit_paisa: 100, balance_paisa: 0 })] }) })} />);
    expect(screen.getAllByRole('row').find((r) => r.textContent!.includes('ACC-000003'))!.textContent).toMatch(/reversed/i);
    expect(screen.getAllByRole('row').find((r) => r.textContent!.includes('ACC-000004'))!.textContent).toMatch(/reversal|reverses|ACC-000003|reversed/i);
  });

  it('Print opens a print frame; CSV export downloads rupees (not paisa) with a header row and neutralises spreadsheet formulas', async () => {
    const S = await load();
    const user = userEvent.setup();
    const w = watchIframes();
    let blob: Blob | undefined;
    (URL as any).createObjectURL = vi.fn((b: Blob) => { blob = b; return 'blob:synthetic'; });
    (URL as any).revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const evil = [{ id: PART_FEE, account_group_id: GRP, code: 'X', name: '=HYPERLINK("http://evil.test","x")', is_active: true, version: 1 }];
    wrap(<S {...props({ particulars: evil })} />);
    await user.click(screen.getByRole('button', { name: /print/i }));
    await waitFor(() => expect(w.titles.join('|')).toMatch(/ledger/i));
    w.stop();
    await user.click(screen.getByRole('button', { name: /csv/i }));
    await waitFor(() => expect(blob).toBeTruthy());
    const csv = await new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.readAsText(blob!); });
    const lines = csv.replace(/^﻿/, '').trim().split(/\r?\n/);
    expect(lines[0]).toMatch(/credit/i);
    expect(lines[0]).toMatch(/debit/i);
    expect(lines[0]).toMatch(/balance/i);
    expect(csv).toMatch(/1500\.50/);
    expect(csv).toMatch(/4000\.00/);
    expect(csv).not.toMatch(/150050|400000/);
    expect(csv).toContain('ACC-000001');
    expect(csv).not.toMatch(/(^|[,\n])"?=HYPERLINK/); // formula injection: the cell must not start with =
  });

  it('Print and CSV need data to export: with no party picked both are disabled with a visible reason, not hidden', async () => {
    const S = await load();
    wrap(<S {...props({ statement: null, party: null })} />);
    expectBlockedWithReason(screen.getByRole('button', { name: /print/i }), 'billing.accounts.reason.pick_party_first');
    expect((screen.getByRole('button', { name: /csv/i }) as HTMLButtonElement).disabled || screen.getByRole('button', { name: /csv/i }).getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('axe: populated and empty', async () => {
    const S = await load();
    const a = wrap(<S {...props()} />);
    await noAxeViolations();
    a.unmount();
    wrap(<S {...props({ statement: null, party: null })} />);
    await noAxeViolations();
  });
});

// ───────────────────────── Pocket ledger ─────────────────────────
describe('billing/accounts/pocket — pocket ledger', () => {
  const load = async () => (await mod<{ PocketLedgerScreen: any }>('PocketLedgerScreen')).PocketLedgerScreen;
  const props = (o: Record<string, unknown> = {}) => ({ statement: statement({ party_kind: 'user_pocket', party_id: ME }), ownerId: ME, currentMembershipId: ME, owners: members, from: '2026-11-01', to: '2026-11-30', particulars, permissions: READ, ...o });

  it('own pocket: running balance table with headers and money; titled as my pocket', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    expect(document.body.textContent).toContain(t('billing.accounts.pocket.mine'));
    expect(t('billing.accounts.pocket.mine')).not.toBe('billing.accounts.pocket.mine');
    expect(screen.getAllByRole('row').find((r) => r.textContent!.includes('ACC-000001'))!.textContent).toMatch(money('2,500.50'));
    for (const h of ['Credit', 'Debit', 'Balance']) expect(headers().some((x) => new RegExp(`^${h}`, 'i').test(x)), h).toBe(true);
  });

  it('without billing.account.manage there is no way to pick another user and no list of owners', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    expect(screen.queryByRole('button', { name: /^(user|owner|pocket of)/i })).toBeNull();
    expect(document.body.textContent).not.toContain('Synthetic Cashier');
  });

  it('with billing.account.manage the user can pick another user and the URL carries that owner', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props({ permissions: FULL })} />);
    const bar = screen.getByRole('search');
    await pick(user, bar, /user|owner|pocket/i, /Synthetic Cashier/);
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(String(push.mock.calls.at(-1)![0])).toContain(OTHER);
  });

  it("another user's pocket without the permission shows a not-allowed message and none of that user's rows", async () => {
    const S = await load();
    wrap(<S {...props({ ownerId: OTHER, statement: null, permissions: READ })} />);
    expect(document.body.textContent).toContain(t('billing.accounts.pocket.not_allowed'));
    expect(t('billing.accounts.pocket.not_allowed')).not.toBe('billing.accounts.pocket.not_allowed');
    expect(document.body.textContent).not.toContain('ACC-000001');
  });

  it('empty pocket draws headers and placeholders', async () => {
    const S = await load();
    wrap(<S {...props({ statement: statement({ party_kind: 'user_pocket', party_id: ME, rows: [], total_credit_paisa: 0, total_debit_paisa: 0, opening_balance_paisa: 0, closing_balance_paisa: 0 }) })} />);
    expect(headers().length).toBeGreaterThanOrEqual(6);
    expect(placeholders()).toBe(4);
  });
});

// ───────────────────────── Account summary ─────────────────────────
describe('billing/accounts/summary — Account Summary', () => {
  const load = async () => (await mod<{ AccountSummaryScreen: any }>('AccountSummaryScreen')).AccountSummaryScreen;
  const summaries = [
    { party_kind: 'credit_party', party_id: CLIENT, credit_limit_paisa: 50000000, outstanding_paisa: 1234567, outstanding_side: 'debit', is_blocked: false },
    { party_kind: 'franchise', party_id: FRANCHISE, credit_limit_paisa: 0, outstanding_paisa: 500000, outstanding_side: 'credit', is_blocked: true },
  ];
  const props = (o: Record<string, unknown> = {}) => ({ summaries, parties, permissions: READ, ...o });

  it('columns are exactly the ElabAssist Account Summary columns, in order', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    expect(headers()).toEqual(SUMMARY_COLUMNS);
  });

  it('filled rows: party details joined, money right aligned in rupees with lakh grouping, text Debit/Credit and Is Blocked', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    const a = screen.getAllByRole('row').find((r) => r.textContent!.includes('Synthetic Client Alpha'))!;
    for (const x of ['Synthetic Centre A1', 'Synthetic Road 1', 'Synthetic Contact', '9800000000', 'alpha@example.test', '123456789']) expect(a.textContent).toContain(x);
    expect(a.textContent).toMatch(AD); // joining date
    expect(a.textContent).toMatch(money('5,00,000.00')); // credit limit
    expect(a.textContent).toMatch(money('12,345.67')); // outstanding
    expect(a.textContent).toMatch(/debit/i);
    const cells = within(a).getAllByRole('gridcell').length ? within(a).getAllByRole('gridcell') : within(a).getAllByRole('cell');
    expect(cells[headers().indexOf('Credit Limit')]!.className).toMatch(/lims-align-end/);
    expect(cells[headers().indexOf('Outstanding Amount')]!.className).toMatch(/lims-align-end/);
    expect(cells[headers().indexOf('Is Blocked')]!.textContent).toMatch(/^(No|Not blocked)/i);
    const b = screen.getAllByRole('row').find((r) => r.textContent!.includes('Synthetic Franchise Beta'))!;
    expect(b.textContent).toMatch(/credit/i);
    expect(within(b).getAllByRole('gridcell')[headers().indexOf('Is Blocked')]!.textContent).toMatch(/^(Yes|Blocked)/i);
  });

  it('each party links to its ledger with party_kind and party_id', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    const link = screen.getAllByRole('link').find((a) => /Synthetic Client Alpha|ledger/i.test(a.textContent ?? '') && /accounts\/ledger/.test(a.getAttribute('href') ?? ''))!;
    const u = new URL(link.getAttribute('href')!, 'http://x.test');
    expect(u.pathname).toBe('/billing/accounts/ledger');
    expect(u.searchParams.get('party_kind')).toBe('credit_party');
    expect(u.searchParams.get('party_id')).toBe(CLIENT);
  });

  it('empty summary keeps all 13 headers and 4 placeholders', async () => {
    const S = await load();
    wrap(<S {...props({ summaries: [] })} />);
    expect(headers()).toEqual(SUMMARY_COLUMNS);
    expect(placeholders()).toBe(4);
  });

  // Reviewer item 1: props `failed?: number`, `truncated?: boolean`; kit Banner (data-tone=warning) with catalogue key billing.accounts.summary.partial ("{n} parties could not be loaded; reload to try again").
  it('partial state: failed > 0 shows a warning banner with the count, rows still render', async () => {
    const S = await load();
    wrap(<S {...props({ failed: 3, truncated: false })} />);
    expect(t('billing.accounts.summary.partial'), 'catalogue key must exist').not.toBe('billing.accounts.summary.partial');
    expect(t('billing.accounts.summary.partial')).toContain('{n}');
    const banner = document.querySelector('.lims-banner[data-tone="warning"]') as HTMLElement;
    expect(banner, 'warning Banner').toBeTruthy();
    expect(banner.textContent).toContain(t('billing.accounts.summary.partial').replace('{n}', '3'));
    expect(headers()).toEqual(SUMMARY_COLUMNS);
    expect(screen.getAllByRole('row').some((r) => r.textContent!.includes('Synthetic Client Alpha'))).toBe(true);
  });

  it('partial state: truncated alone also shows the warning banner', async () => {
    const S = await load();
    wrap(<S {...props({ failed: 0, truncated: true })} />);
    expect(document.querySelector('.lims-banner[data-tone="warning"]')).toBeTruthy();
  });

  // Reviewer round 2 item 1: truncated gets its own warning Banner (key billing.accounts.summary.truncated); the "{n} parties could not be loaded" Banner only when failed > 0.
  it('truncated with failed 0 shows the truncated text and NOT the "0 parties" text', async () => {
    const S = await load();
    wrap(<S {...props({ failed: 0, truncated: true })} />);
    const truncated = t('billing.accounts.summary.truncated');
    expect(truncated, 'catalogue key must exist').not.toBe('billing.accounts.summary.truncated');
    expect(truncated).toBe('Only the first 200 clients and franchises are shown.');
    const banners = Array.from(document.querySelectorAll('.lims-banner[data-tone="warning"]')) as HTMLElement[];
    expect(banners.some((b) => b.textContent!.includes(truncated))).toBe(true);
    const text = document.body.textContent!;
    expect(text).not.toContain(t('billing.accounts.summary.partial').replace('{n}', '0'));
    expect(text).not.toMatch(/\b0 parties could not be loaded/);
  });

  it('failed > 0 and truncated true shows both warning banners', async () => {
    const S = await load();
    wrap(<S {...props({ failed: 2, truncated: true })} />);
    const text = Array.from(document.querySelectorAll('.lims-banner[data-tone="warning"]')).map((b) => b.textContent).join('|');
    expect(text).toContain(t('billing.accounts.summary.partial').replace('{n}', '2'));
    expect(text).toContain(t('billing.accounts.summary.truncated'));
  });

  it('failed > 0 and truncated false does not show the truncated text', async () => {
    const S = await load();
    wrap(<S {...props({ failed: 2, truncated: false })} />);
    expect(document.body.textContent).not.toContain(t('billing.accounts.summary.truncated'));
  });

  it('no banner when nothing failed and nothing was cut (props omitted or zero)', async () => {
    const S = await load();
    const a = wrap(<S {...props()} />);
    expect(document.querySelector('.lims-banner')).toBeNull();
    a.unmount();
    wrap(<S {...props({ failed: 0, truncated: false })} />);
    expect(document.querySelector('.lims-banner')).toBeNull();
  });

  it('axe: partial banner state', async () => {
    const S = await load();
    wrap(<S {...props({ failed: 2, truncated: true })} />);
    await noAxeViolations();
  });

  it('a summary whose party is unknown still renders (name falls back to a dash), never throws', async () => {
    const S = await load();
    wrap(<S {...props({ summaries: [{ ...summaries[0], party_id: U(777) }] })} />);
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
  });

  it('axe: populated and empty', async () => {
    const S = await load();
    const a = wrap(<S {...props()} />);
    await noAxeViolations();
    a.unmount();
    wrap(<S {...props({ summaries: [] })} />);
    await noAxeViolations();
  });
});

// ───────────────────────── Masters ─────────────────────────
describe('billing/accounts/masters — account groups and particulars', () => {
  const load = async () => (await mod<{ AccountMastersScreen: any }>('AccountMastersScreen')).AccountMastersScreen;
  const groups = [{ id: GRP, code: 'INCOME', name: 'Synthetic Income', nature: 'income', is_active: true, version: 2, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' }, { id: U(22), code: 'OLD', name: 'Synthetic Old Group', nature: 'expense', is_active: false, version: 4, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z' }];
  const props = (o: Record<string, unknown> = {}) => ({ groups, particulars, permissions: FULL, ...o });

  it('two tables (groups, particulars) with headers; names, codes and active state as text', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    expect(screen.queryAllByRole('table').length + screen.queryAllByRole('grid').length).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).toContain('Synthetic Income');
    expect(document.body.textContent).toContain('INCOME');
    expect(document.body.textContent).toContain('Synthetic Collection');
    expect(document.body.textContent).toContain('COLLECTION');
    expect(document.body.textContent).toMatch(/inactive/i);
    expect(document.body.textContent).toContain(t('billing.accounts.masters.groups'));
    expect(document.body.textContent).toContain(t('billing.accounts.masters.particulars'));
  });

  it('empty masters keep headers and placeholders in both tables', async () => {
    const S = await load();
    wrap(<S {...props({ groups: [], particulars: [] })} />);
    expect(screen.getAllByRole('columnheader').length).toBeGreaterThanOrEqual(6);
    expect(placeholders()).toBe(8);
  });

  it('create group: POST /v1/billing/account-groups with code, name, nature and an Idempotency-Key', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: new RegExp(t('billing.accounts.masters.new_group'), 'i') }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(/code/i), 'NEW');
    await user.type(within(dlg).getByLabelText(/^name/i), 'New group');
    await pick(user, dlg, /nature/i, /income/i);
    await user.click(within(dlg).getByRole('button', { name: /save|create|submit/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe('/v1/billing/account-groups');
    expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy();
    expect(calls[0]!.body).toMatchObject({ code: 'NEW', name: 'New group', nature: 'income' });
  });

  it('a code that breaks ^[A-Z0-9_]{1,32}$ is refused before any request', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: new RegExp(t('billing.accounts.masters.new_group'), 'i') }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(/code/i), 'bad code!');
    await user.type(within(dlg).getByLabelText(/^name/i), 'x');
    await user.click(within(dlg).getByRole('button', { name: /save|create|submit/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
  });

  it('edit renames with If-Match = the row version; code and nature are not editable after create', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    const row = screen.getAllByRole('row').find((r) => r.textContent!.includes('Synthetic Income'))!;
    await user.click(within(row).getByRole('button', { name: new RegExp(t('billing.accounts.masters.edit'), 'i') }));
    const dlg = await screen.findByRole('dialog');
    const code = within(dlg).queryByLabelText(/code/i) as HTMLInputElement | null;
    if (code) expect(code.readOnly || code.disabled).toBe(true);
    const name = within(dlg).getByLabelText(/^name/i);
    await user.clear(name);
    await user.type(name, 'Synthetic Income Renamed');
    await user.click(within(dlg).getByRole('button', { name: /save|update|submit/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url.pathname).toBe(`/v1/billing/account-groups/${GRP}`);
    expect(calls[0]!.headers.get('if-match')).toMatch(/"?2"?/);
    expect(calls[0]!.body.name).toBe('Synthetic Income Renamed');
    expect(calls[0]!.body).not.toHaveProperty('code');
    expect(calls[0]!.body).not.toHaveProperty('nature');
  });

  it('deactivate sends is_active=false with If-Match; there is no Delete', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull();
    const row = screen.getAllByRole('row').find((r) => r.textContent!.includes('Synthetic Income'))!;
    await user.click(within(row).getByRole('button', { name: new RegExp(t('billing.accounts.masters.deactivate'), 'i') }));
    const dlg = screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog');
    if (dlg) await user.click(within(dlg).getByRole('button', { name: /confirm|deactivate|yes/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.body).toMatchObject({ is_active: false });
    expect(calls[0]!.headers.get('if-match')).toBeTruthy();
  });

  it('an inactive row offers Activate instead of Deactivate', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    const row = screen.getAllByRole('row').find((r) => r.textContent!.includes('Synthetic Old Group'))!;
    expect(within(row).queryByRole('button', { name: new RegExp(t('billing.accounts.masters.deactivate'), 'i') })).toBeNull();
    expect(within(row).getByRole('button', { name: /activate|reactivate/i })).toBeTruthy();
  });

  it('create particular needs a group and posts account_group_id', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: new RegExp(t('billing.accounts.masters.new_particular'), 'i') }));
    const dlg = await screen.findByRole('dialog');
    await pick(user, dlg, /group/i, /Synthetic Income/);
    await user.type(within(dlg).getByLabelText(/code/i), 'FEES');
    await user.type(within(dlg).getByLabelText(/^name/i), 'Synthetic Fees');
    await user.click(within(dlg).getByRole('button', { name: /save|create|submit/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url.pathname).toBe('/v1/billing/account-particulars');
    expect(calls[0]!.body).toMatchObject({ account_group_id: GRP, code: 'FEES', name: 'Synthetic Fees' });
  });

  it('permissions: without billing.account.manage the lists show but New, Edit and Deactivate are disabled with a visible reason', async () => {
    const S = await load();
    wrap(<S {...props({ permissions: READ })} />);
    expect(document.body.textContent).toContain('Synthetic Income');
    expectBlockedWithReason(screen.getByRole('button', { name: new RegExp(t('billing.accounts.masters.new_group'), 'i') }), 'billing.accounts.reason.no_manage');
    for (const b of screen.getAllByRole('button', { name: new RegExp(`${t('billing.accounts.masters.edit')}|${t('billing.accounts.masters.deactivate')}`, 'i') })) {
      expect((b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true').toBe(true);
    }
  });

  it('axe: populated and empty', async () => {
    const S = await load();
    const a = wrap(<S {...props()} />);
    await noAxeViolations();
    a.unmount();
    wrap(<S {...props({ groups: [], particulars: [] })} />);
    await noAxeViolations();
  });
});
