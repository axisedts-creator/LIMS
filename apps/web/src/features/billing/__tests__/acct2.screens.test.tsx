// @vitest-environment jsdom
// T0D-ACCT-2 — Expense, Expense Type, Cash Transfer (All / Sent / Received / Pending; accept, reject, cancel) and the daily collection summary.
// LD-313, LD-310 (founder blanket authority), ElabAssist fields from the read only walk. Component tests with MSW. Synthetic data only.
// ASSUMED prop contract (the spec fixes only names and paths; the writer may dispute through the ruling path). Under apps/web/src/features/billing/components/:
//   expenses/ExpensesScreen({expenses, types, centres, permissions})                       route billing/expenses          (expenses = Expense[], types = ExpenseType[])
//   expenses/ExpenseTypesScreen({types, particulars, permissions})                         route billing/expenses/types
//   transfers/CashTransfersScreen({transfers, centres, members, currentMembershipId, currentCentreIds, tab, permissions})   route billing/cash-transfers
//        tab = 'all'|'sent'|'received'|'pending' (URL ?tab=; the page maps it to the API query); the receiver is the current user (to_kind user) or a user of the centre (to_kind centre)
//   transfers/DailyCollectionScreen({summary|null, centres, centreId, day, particulars, permissions})   shown on billing/daily-cash
// Text comes from the message catalogue (core/i18n/messages.ts, keys billing.expenses.* / billing.expense_types.* / billing.transfers.* / billing.daily_summary.*; the key list is in acct2.source.test.ts).
// Money = paisa shown as rupees, dates = AD with BS. Every empty table keeps its headers (T0D-EMPTYTBL-1). Expense time is typed in Asia/Kathmandu (UTC+05:45) and sent as UTC.
// PINNED SEMANTICS (not in the spec, tester choice, flagged in the notes):
//   - pocket balance for a transfer = GET /v1/billing/account-summary?party_kind=user_pocket&party_id=<user membership id OR centre id> (T0B-ACCT-2 pins pockets that way); a credit side balance is cash held.
//   - the balance warning does not block the request: the API refuses an overdraw unless the tenant allows negative pockets.
//   - accept, reject and cancel of a transfer carry no body (the contract has no request body for them); the remark of the transfer is shown, never invented.
//   - deposit = POST account-ledger-entries debit on the centre pocket (user_pocket, party_id = centre), particular code BANK_DEPOSIT, payment_mode cash, entry_date = the day.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/billing/expenses',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Accountant', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/billing/expenses',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const CENTRE = U(3), CENTRE2 = U(6), GRP = U(20), PART_RENT = U(10), PART_BANK = U(11), ME = U(90), OTHER = U(91), THIRD = U(92);
const TYPE_RENT = U(30), TYPE_TEA = U(31), TYPE_OLD = U(32);
const EX1 = U(201), EX2 = U(202), EX3 = U(203);
const TR1 = U(301), TR2 = U(302), TR3 = U(303), TR4 = U(304), TR5 = U(305);

const READ = ['billing.account.read'];
const EXPENSE = ['billing.account.read', 'billing.expense.manage'];
const MASTERS = ['billing.account.read', 'billing.account.manage'];
const TRANSFER = ['billing.account.read', 'billing.cash_transfer.manage'];
const DECIDE = ['billing.account.read', 'billing.cash_transfer.manage', 'billing.cash_transfer.decide'];
const DEPOSIT = ['billing.account.read', 'billing.account_entry.create'];

const centres = [{ id: CENTRE, name: 'Synthetic Centre A1' }, { id: CENTRE2, name: 'Synthetic Centre B2' }];
const members = [{ id: ME, name: 'Synthetic Accountant' }, { id: OTHER, name: 'Synthetic Cashier' }, { id: THIRD, name: 'Synthetic Clerk' }];
const particulars = [
  { id: PART_RENT, account_group_id: GRP, code: 'RENT', name: 'Synthetic Rent', is_active: true, version: 1 },
  { id: PART_BANK, account_group_id: GRP, code: 'BANK_DEPOSIT', name: 'Synthetic Bank Deposit', is_active: true, version: 1 },
];
const types = [
  { id: TYPE_RENT, name: 'Synthetic Rent Type', account_particular_id: PART_RENT, is_active: true, version: 2, created_at: '2026-10-01T04:00:00.000Z', updated_at: '2026-10-01T04:00:00.000Z' },
  { id: TYPE_TEA, name: 'Synthetic Tea Type', account_particular_id: PART_RENT, is_active: true, version: 1, created_at: '2026-10-01T04:00:00.000Z', updated_at: '2026-10-01T04:00:00.000Z' },
  { id: TYPE_OLD, name: 'Synthetic Old Type', account_particular_id: PART_RENT, is_active: false, version: 3, created_at: '2026-10-01T04:00:00.000Z', updated_at: '2026-10-02T04:00:00.000Z' },
];
const expense = (o: Record<string, unknown> = {}) => ({
  id: EX1, centre_id: CENTRE, expense_at: '2026-11-07T04:45:00.000Z', expense_type_id: TYPE_RENT, amount_paisa: 150050, description: 'Synthetic rent for November', version: 1, created_by: ME, created_at: '2026-11-07T05:00:00.000Z', ...o,
});
const expenses = [
  expense(),
  expense({ id: EX2, expense_type_id: TYPE_TEA, amount_paisa: 25000, description: 'Synthetic tea', centre_id: CENTRE2 }),
  expense({ id: EX3, amount_paisa: 70000, description: 'Synthetic duplicate', cancelled_at: '2026-11-08T04:00:00.000Z', cancel_reason_text: 'Entered twice by mistake' }),
];
const transfer = (o: Record<string, unknown> = {}) => ({
  id: TR1, from_kind: 'user', from_id: OTHER, to_kind: 'user', to_id: ME, amount_paisa: 500000, status: 'pending', remark: 'Synthetic hand over', version: 1, created_by: OTHER, created_at: '2026-11-07T04:15:00.000Z', ...o,
});
const transfers = [
  transfer(), // I am the receiver
  transfer({ id: TR2, from_id: ME, to_id: OTHER, created_by: ME, amount_paisa: 120000, remark: 'Synthetic own request' }), // I created it
  transfer({ id: TR3, amount_paisa: 75000, status: 'accepted', decided_by: ME, decided_at: '2026-11-07T05:00:00.000Z', version: 2, remark: 'Synthetic done' }),
  transfer({ id: TR4, to_id: THIRD, amount_paisa: 30000, remark: 'Synthetic for someone else' }), // not for me
  transfer({ id: TR5, to_kind: 'centre', to_id: CENTRE, amount_paisa: 99000, remark: 'Synthetic to my centre' }), // I belong to the centre
];

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const posts = () => calls.filter((c) => c.method !== 'GET');
const BAL: Record<string, { paisa: number; side: 'credit' | 'debit' }> = { [OTHER]: { paisa: 20000, side: 'credit' }, [ME]: { paisa: 500000, side: 'credit' }, [CENTRE]: { paisa: 0, side: 'credit' } };
let latency = 0;
const api = setupServer(
  http.get(`${ORIGIN}/v1/billing/account-summary`, async ({ request }) => {
    await rec(request);
    const id = new URL(request.url).searchParams.get('party_id')!;
    const b = BAL[id] ?? { paisa: 0, side: 'credit' as const };
    return HttpResponse.json({ party_kind: 'user_pocket', party_id: id, credit_limit_paisa: 0, outstanding_paisa: b.paisa, outstanding_side: b.side, is_blocked: false });
  }),
  http.post(`${ORIGIN}/v1/billing/expenses`, async ({ request }) => { await rec(request); await delay(latency); return HttpResponse.json(expense({ id: U(210) }), { status: 201 }); }),
  http.post(`${ORIGIN}/v1/billing/expenses/:id/cancel`, async ({ request }) => { await rec(request); await delay(latency); return HttpResponse.json(expense({ cancelled_at: '2026-11-09T04:00:00.000Z' }), { status: 200 }); }),
  http.post(`${ORIGIN}/v1/billing/expense-types`, async ({ request }) => { await rec(request); await delay(latency); return HttpResponse.json(types[0], { status: 201 }); }),
  http.patch(`${ORIGIN}/v1/billing/expense-types/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(types[0], { status: 200 }); }),
  http.post(`${ORIGIN}/v1/billing/cash-transfers`, async ({ request }) => { await rec(request); await delay(latency); return HttpResponse.json(transfer({ id: U(310) }), { status: 201 }); }),
  http.post(`${ORIGIN}/v1/billing/cash-transfers/:id/:action`, async ({ request }) => { await rec(request); await delay(latency); return HttpResponse.json(transfer({ status: 'accepted' }), { status: 200 }); }),
  http.post(`${ORIGIN}/v1/billing/account-ledger-entries`, async ({ request }) => { await rec(request); await delay(latency); return HttpResponse.json({ id: U(320), receipt_no: 'ACC-000010' }, { status: 201 }); }),
  http.all(`${ORIGIN}/v1/billing/*`, async ({ request }) => { await rec(request); return HttpResponse.json({}, { status: 200 }); }),
);
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; latency = 0; push.mockReset(); refresh.mockReset(); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const mod = async <T,>(p: string) => (await import(/* @vite-ignore */ `../components/${p}`)) as T;
const money = (rupees: string) => new RegExp(`(NPR|Rs\\.)\\s?${rupees.replace(/[.,]/g, '\\$&')}`);
const AD = /\d{2}\/\d{2}\/\d{4}/;
const BS = /\d{4}-\d{2}-\d{2}/;
const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent!.trim());
const placeholders = () => document.querySelectorAll('.lims-row-placeholder[aria-hidden="true"]').length;
const re = (key: string) => new RegExp(t(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const reasonOf = (el: HTMLElement) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true';
const expectBlockedWithReason = (btn: HTMLElement, key: string) => {
  expect(t(key), `catalogue key ${key} must exist`).not.toBe(key);
  expect(isDisabled(btn), 'button is disabled').toBe(true);
  expect(reasonOf(btn), 'visible reason linked by aria-describedby').toContain(t(key));
  expect(document.body.textContent).toContain(t(key));
};
const pick = async (user: ReturnType<typeof userEvent.setup>, scope: HTMLElement, label: RegExp, option: RegExp) => {
  await user.click(within(scope).getByRole('button', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
};
const rowOf = (text: RegExp) => screen.getAllByRole('row').find((r) => text.test(r.textContent!))!;

const EXPENSE_COLUMNS = ['Date Time', 'Expense Type', 'Amount', 'Lab Name', 'Description', 'Status', 'Action'];
const TYPE_COLUMNS = ['Expense Type', 'Account Particular', 'Status', 'Action'];
const TRANSFER_COLUMNS = ['Date', 'From', 'To', 'Amount', 'Status', 'Remark', 'Action'];
const DAILY_COLUMNS = ['Payment Mode', 'Entries', 'Amount'];

// ───────────────────────── Expense ─────────────────────────
describe('billing/expenses — Expense list and New expense form', () => {
  const load = async () => (await mod<{ ExpensesScreen: any }>('expenses/ExpensesScreen')).ExpensesScreen;
  const props = (o: Record<string, unknown> = {}) => ({ expenses, types, centres, permissions: EXPENSE, ...o });

  it('columns are the ElabAssist Expense columns plus status and action, from the catalogue, under a page heading', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    expect(headers()).toEqual(EXPENSE_COLUMNS);
    expect(screen.getByRole('heading', { name: t('billing.expenses.title') })).toBeTruthy();
    expect(t('billing.expenses.title')).not.toBe('billing.expenses.title');
  });

  it('filled row: type and centre names resolved, rupees from paisa, AD with BS, description, status as text; time shown in Kathmandu', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    const row = rowOf(/Synthetic rent for November/);
    const text = row.textContent!;
    expect(text).toContain('Synthetic Rent Type');
    expect(text).toContain('Synthetic Centre A1');
    expect(text).toMatch(money('1,500.50'));
    expect(text).not.toMatch(/150050|1500\.5\b/);
    expect(text).toMatch(AD);
    expect(text).toMatch(BS);
    expect(text).toMatch(/10:30/); // 2026-11-07T04:45Z = 10:30 NPT
    expect(text).toMatch(/active/i);
    const cells = within(row).getAllByRole('gridcell').length ? within(row).getAllByRole('gridcell') : within(row).getAllByRole('cell');
    expect(cells[headers().indexOf('Amount')]!.className).toMatch(/lims-align-end/);
    expect(rowOf(/Synthetic tea/).textContent).toContain('Synthetic Centre B2');
  });

  it('a cancelled expense shows its status and its reason, and cannot be cancelled again (disabled, visible reason)', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    const row = rowOf(/Synthetic duplicate/);
    expect(row.textContent).toMatch(/cancelled/i);
    expect(row.textContent).toContain('Entered twice by mistake');
    expectBlockedWithReason(within(row).getByRole('button', { name: re('billing.expenses.cancel') }), 'billing.expenses.reason.already_cancelled');
  });

  it('empty list keeps all headers, a catalogue message row and 4 inert placeholder rows', async () => {
    const S = await load();
    wrap(<S {...props({ expenses: [] })} />);
    expect(headers()).toEqual(EXPENSE_COLUMNS);
    expect(screen.getByText(t('billing.expenses.empty'))).toBeTruthy();
    expect(t('billing.expenses.empty')).not.toBe('billing.expenses.empty');
    expect(placeholders()).toBe(4);
  });

  it('Search sits in a labelled search region; picking a centre and pressing Search pushes the URL with the API query name', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    const bar = screen.getByRole('search');
    await pick(user, bar, /lab name|centre/i, /Synthetic Centre B2/);
    await user.click(within(bar).getByRole('button', { name: /search/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(String(push.mock.calls.at(-1)![0])).toContain(`centre_id=${CENTRE2}`);
  });

  it('there is no Delete anywhere: rows offer Cancel (with a reason), never Delete', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull();
    expect(screen.getAllByRole('button', { name: re('billing.expenses.cancel') }).length).toBeGreaterThanOrEqual(2);
  });

  it('New expense opens the form with date time, expense type, amount, lab name, description, Save and Cancel', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: re('billing.expenses.new') }));
    const dlg = await screen.findByRole('dialog');
    for (const l of [/date/i, /expense type/i, /amount/i, /lab name/i, /description/i]) expect(within(dlg).getAllByText(l).length, String(l)).toBeGreaterThan(0);
    expect(within(dlg).getByRole('button', { name: /^save/i })).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: /^cancel$/i })).toBeTruthy(); // closes the form (ElabAssist Cancel), not an expense cancellation
  });

  it('Save sends the time as UTC, paisa as an integer, Idempotency-Key, no PUT/PATCH/DELETE; then refreshes', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: re('billing.expenses.new') }));
    const dlg = await screen.findByRole('dialog');
    await pick(user, dlg, /expense type/i, /Synthetic Rent Type/);
    await pick(user, dlg, /lab name/i, /Synthetic Centre A1/);
    fireEvent.change(within(dlg).getByLabelText(/date/i), { target: { value: '2026-11-07T10:30' } });
    await user.type(within(dlg).getByLabelText(/amount/i), '1500.50');
    await user.type(within(dlg).getByLabelText(/description/i), 'Synthetic rent for November');
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(posts().length).toBe(1));
    const c = posts()[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/v1/billing/expenses');
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(c.body).toEqual({ centre_id: CENTRE, expense_at: '2026-11-07T04:45:00.000Z', expense_type_id: TYPE_RENT, amount_paisa: 150050, description: 'Synthetic rent for November' });
    expect(Number.isInteger(c.body.amount_paisa)).toBe(true);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('only active expense types are offered in the form', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: re('billing.expenses.new') }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /expense type/i }));
    expect(await screen.findByRole('option', { name: /Synthetic Rent Type/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Synthetic Old Type/ })).toBeNull();
  });

  it('Save with nothing filled sends no request and shows field errors; zero, negative and 3 decimal amounts are refused', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: re('billing.expenses.new') }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts()).toEqual([]);
    expect(within(dlg).getAllByText(/required|choose|enter/i).length).toBeGreaterThan(0);
    await pick(user, dlg, /expense type/i, /Synthetic Rent Type/);
    await pick(user, dlg, /lab name/i, /Synthetic Centre A1/);
    fireEvent.change(within(dlg).getByLabelText(/date/i), { target: { value: '2026-11-07T10:30' } });
    for (const bad of ['0', '-5', '10.505']) {
      const amount = within(dlg).getByLabelText(/amount/i);
      await user.clear(amount);
      await user.type(amount, bad);
      await user.click(within(dlg).getByRole('button', { name: /^save/i }));
      await new Promise((r) => setTimeout(r, 30));
      expect(posts(), `amount ${bad}`).toEqual([]);
    }
  });

  it('double click on Save sends ONE request and the button is disabled while it is pending', async () => {
    latency = 250;
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: re('billing.expenses.new') }));
    const dlg = await screen.findByRole('dialog');
    await pick(user, dlg, /expense type/i, /Synthetic Rent Type/);
    await pick(user, dlg, /lab name/i, /Synthetic Centre A1/);
    fireEvent.change(within(dlg).getByLabelText(/date/i), { target: { value: '2026-11-07T10:30' } });
    await user.type(within(dlg).getByLabelText(/amount/i), '100');
    const save = within(dlg).getByRole('button', { name: /^save/i });
    await user.dblClick(save);
    expect(isDisabled(save)).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(posts().length).toBe(1);
  });

  it('Cancel expense asks for a reason: blank, whitespace and 501 characters send nothing; a reason POSTs reason_text with Idempotency-Key then refreshes', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(within(rowOf(/Synthetic rent for November/)).getByRole('button', { name: re('billing.expenses.cancel') }));
    const dlg = await screen.findByRole('dialog');
    const confirm = () => within(dlg).getByRole('button', { name: re('billing.expenses.cancel_confirm') });
    const box = within(dlg).getByLabelText(re('billing.expenses.cancel_reason'));
    await user.click(confirm());
    await new Promise((r) => setTimeout(r, 40));
    expect(posts()).toEqual([]);
    await user.type(box, '    ');
    await user.click(confirm());
    await new Promise((r) => setTimeout(r, 40));
    expect(posts()).toEqual([]);
    await user.clear(box);
    await user.click(box);
    await user.paste('x'.repeat(501));
    await user.click(confirm());
    await new Promise((r) => setTimeout(r, 40));
    expect(posts()).toEqual([]);
    await user.clear(box);
    await user.type(box, 'Entered twice');
    await user.click(confirm());
    await waitFor(() => expect(posts().length).toBe(1));
    expect(posts()[0]!.method).toBe('POST');
    expect(posts()[0]!.url.pathname).toBe(`/v1/billing/expenses/${EX1}/cancel`);
    expect(posts()[0]!.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(posts()[0]!.body).toEqual({ reason_text: 'Entered twice' });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('double click on the cancel confirmation sends ONE request', async () => {
    latency = 250;
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(within(rowOf(/Synthetic rent for November/)).getByRole('button', { name: re('billing.expenses.cancel') }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(re('billing.expenses.cancel_reason')), 'Entered twice');
    const confirm = within(dlg).getByRole('button', { name: re('billing.expenses.cancel_confirm') });
    await user.dblClick(confirm);
    expect(isDisabled(confirm)).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(posts().length).toBe(1);
  });

  it('permissions: read only user sees the list; New expense and Cancel are disabled with a visible reason', async () => {
    const S = await load();
    wrap(<S {...props({ permissions: READ })} />);
    expect(screen.getAllByRole('row').length).toBeGreaterThan(3);
    expectBlockedWithReason(screen.getByRole('button', { name: re('billing.expenses.new') }), 'billing.expenses.reason.no_manage');
    for (const b of screen.getAllByRole('button', { name: re('billing.expenses.cancel') })) expect(isDisabled(b)).toBe(true);
    expect(reasonOf(screen.getAllByRole('button', { name: re('billing.expenses.cancel') })[0]!)).toContain(t('billing.expenses.reason.no_manage'));
    expect(posts()).toEqual([]);
  });

  it('no accessibility violations (filled and with the form open)', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await noAxeViolations();
    await user.click(screen.getByRole('button', { name: re('billing.expenses.new') }));
    await screen.findByRole('dialog');
    await noAxeViolations();
  });
});

// ───────────────────────── Expense Type ─────────────────────────
describe('billing/expenses/types — Expense Type master', () => {
  const load = async () => (await mod<{ ExpenseTypesScreen: any }>('expenses/ExpenseTypesScreen')).ExpenseTypesScreen;
  const props = (o: Record<string, unknown> = {}) => ({ types, particulars, permissions: MASTERS, ...o });

  it('columns, heading, resolved particular, status as text; empty keeps headers and 4 placeholders', async () => {
    const S = await load();
    const { unmount } = wrap(<S {...props()} />);
    expect(headers()).toEqual(TYPE_COLUMNS);
    expect(screen.getByRole('heading', { name: t('billing.expense_types.title') })).toBeTruthy();
    expect(rowOf(/Synthetic Rent Type/).textContent).toContain('Synthetic Rent');
    expect(rowOf(/Synthetic Old Type/).textContent).toMatch(/inactive/i);
    unmount();
    wrap(<S {...props({ types: [] })} />);
    expect(headers()).toEqual(TYPE_COLUMNS);
    expect(screen.getByText(t('billing.expense_types.empty'))).toBeTruthy();
    expect(placeholders()).toBe(4);
  });

  it('Add New creates a type: POST name + account_particular_id with Idempotency-Key; blank name sends nothing', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: re('billing.expense_types.new') }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await new Promise((r) => setTimeout(r, 40));
    expect(posts()).toEqual([]);
    await user.type(within(dlg).getByLabelText(/expense type|name/i), 'Synthetic Courier');
    await pick(user, dlg, /particular/i, /Synthetic Rent/);
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(posts().length).toBe(1));
    expect(posts()[0]!.url.pathname).toBe('/v1/billing/expense-types');
    expect(posts()[0]!.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(posts()[0]!.body).toMatchObject({ name: 'Synthetic Courier', account_particular_id: PART_RENT });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('Update renames with If-Match = the row version and PATCH; no Delete button exists', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull();
    await user.click(within(rowOf(/Synthetic Rent Type/)).getByRole('button', { name: re('billing.expense_types.edit') }));
    const dlg = await screen.findByRole('dialog');
    const name = within(dlg).getByLabelText(/expense type|name/i);
    await user.clear(name);
    await user.type(name, 'Synthetic Rent Renamed');
    await user.click(within(dlg).getByRole('button', { name: /^(save|update)/i }));
    await waitFor(() => expect(posts().length).toBe(1));
    expect(posts()[0]!.method).toBe('PATCH');
    expect(posts()[0]!.url.pathname).toBe(`/v1/billing/expense-types/${TYPE_RENT}`);
    expect(posts()[0]!.headers.get('if-match')).toMatch(/"?2"?/);
    expect(posts()[0]!.body.name).toBe('Synthetic Rent Renamed');
  });

  it('Deactivate sends is_active=false with If-Match (after a confirm step if one is shown); an inactive row offers no Deactivate', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    expect(within(rowOf(/Synthetic Old Type/)).queryByRole('button', { name: re('billing.expense_types.deactivate') })).toBeNull();
    await user.click(within(rowOf(/Synthetic Tea Type/)).getByRole('button', { name: re('billing.expense_types.deactivate') }));
    const dlg = screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog');
    if (dlg) await user.click(within(dlg).getByRole('button', { name: /confirm|deactivate|yes/i }));
    await waitFor(() => expect(posts().length).toBe(1));
    expect(posts()[0]!.method).toBe('PATCH');
    expect(posts()[0]!.body).toEqual({ is_active: false });
    expect(posts()[0]!.headers.get('if-match')).toBeTruthy();
  });

  it('double click on Save sends ONE request', async () => {
    latency = 250;
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: re('billing.expense_types.new') }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(/expense type|name/i), 'Synthetic Courier');
    await pick(user, dlg, /particular/i, /Synthetic Rent/);
    const save = within(dlg).getByRole('button', { name: /^save/i });
    await user.dblClick(save);
    expect(isDisabled(save)).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(posts().length).toBe(1);
  });

  it('permissions: without billing.account.manage the list shows but Add New, Update and Deactivate are disabled with a visible reason', async () => {
    const S = await load();
    wrap(<S {...props({ permissions: READ })} />);
    expectBlockedWithReason(screen.getByRole('button', { name: re('billing.expense_types.new') }), 'billing.expense_types.reason.no_manage');
    for (const b of screen.getAllByRole('button', { name: new RegExp(`${t('billing.expense_types.edit')}|${t('billing.expense_types.deactivate')}`, 'i') })) {
      expect(isDisabled(b)).toBe(true);
      expect(reasonOf(b)).toContain(t('billing.expense_types.reason.no_manage'));
    }
    expect(posts()).toEqual([]);
  });
});

// ───────────────────────── Cash Transfer ─────────────────────────
describe('billing/cash-transfers — All, Sent, Received, Pending; New transfer; accept, reject, cancel', () => {
  const load = async () => (await mod<{ CashTransfersScreen: any }>('transfers/CashTransfersScreen')).CashTransfersScreen;
  const props = (o: Record<string, unknown> = {}) => ({ transfers, centres, members, currentMembershipId: ME, currentCentreIds: [CENTRE], tab: 'all', permissions: DECIDE, ...o });
  const act = (row: HTMLElement, key: string) => within(row).getByRole('button', { name: re(key) });

  it('columns, heading, four tabs with the current one selected; names resolved, rupees from paisa, status and remark as text', async () => {
    const S = await load();
    wrap(<S {...props({ tab: 'pending' })} />);
    expect(headers()).toEqual(TRANSFER_COLUMNS);
    expect(screen.getByRole('heading', { name: t('billing.transfers.title') })).toBeTruthy();
    const tabs = screen.getAllByRole('tab').map((x) => x.textContent!.trim());
    expect(tabs).toEqual(['all', 'sent', 'received', 'pending'].map((k) => t(`billing.transfers.tab.${k}`)));
    expect(screen.getByRole('tab', { name: t('billing.transfers.tab.pending') }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: t('billing.transfers.tab.all') }).getAttribute('aria-selected')).toBe('false');
    const row = rowOf(/5,000\.00/);
    expect(row.textContent).toContain('Synthetic Cashier');
    expect(row.textContent).toContain('Synthetic Accountant');
    expect(row.textContent).toMatch(/pending/i);
    expect(row.textContent).toContain('Synthetic hand over');
    expect(row.textContent).toMatch(AD);
    expect(row.textContent).not.toMatch(/500000/);
    expect(rowOf(/990\.00/).textContent).toContain('Synthetic Centre A1');
  });

  it('clicking a tab pushes the URL with tab=<name>', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('tab', { name: t('billing.transfers.tab.sent') }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(String(push.mock.calls.at(-1)![0])).toMatch(/tab=sent/);
  });

  it('empty list keeps all headers, the tabs, a catalogue message row and 4 inert placeholder rows', async () => {
    const S = await load();
    wrap(<S {...props({ transfers: [] })} />);
    expect(headers()).toEqual(TRANSFER_COLUMNS);
    expect(screen.getAllByRole('tab').length).toBe(4);
    expect(screen.getByText(t('billing.transfers.empty'))).toBeTruthy();
    expect(placeholders()).toBe(4);
  });

  it('Search sits in a labelled search region', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    expect(within(screen.getByRole('search')).getByRole('button', { name: /search/i })).toBeTruthy();
  });

  it('action states per row: receiver can Accept and Reject; creator cannot (own transfer) but can Cancel; others get a visible reason', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    const mineToDecide = rowOf(/5,000\.00/);
    expect(isDisabled(act(mineToDecide, 'billing.transfers.accept'))).toBe(false);
    expect(isDisabled(act(mineToDecide, 'billing.transfers.reject'))).toBe(false);
    expectBlockedWithReason(act(mineToDecide, 'billing.transfers.cancel'), 'billing.transfers.reason.not_creator');
    const centreRow = rowOf(/990\.00/); // receiver through my centre
    expect(isDisabled(act(centreRow, 'billing.transfers.accept'))).toBe(false);
    const own = rowOf(/1,200\.00/);
    expectBlockedWithReason(act(own, 'billing.transfers.accept'), 'billing.transfers.reason.own_transfer');
    expectBlockedWithReason(act(own, 'billing.transfers.reject'), 'billing.transfers.reason.own_transfer');
    expect(isDisabled(act(own, 'billing.transfers.cancel'))).toBe(false);
    const other = rowOf(/300\.00/);
    expectBlockedWithReason(act(other, 'billing.transfers.accept'), 'billing.transfers.reason.not_receiver');
    const done = rowOf(/750\.00/);
    expectBlockedWithReason(act(done, 'billing.transfers.accept'), 'billing.transfers.reason.not_pending');
    expectBlockedWithReason(act(done, 'billing.transfers.reject'), 'billing.transfers.reason.not_pending');
    expectBlockedWithReason(act(done, 'billing.transfers.cancel'), 'billing.transfers.reason.not_pending');
  });

  it('Accept needs a confirm step: the first click sends nothing and shows both pocket balances; Confirm POSTs /accept with Idempotency-Key and no body', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(act(rowOf(/5,000\.00/), 'billing.transfers.accept'));
    const dlg = await screen.findByRole('dialog');
    await new Promise((r) => setTimeout(r, 60));
    expect(posts()).toEqual([]);
    expect(dlg.textContent).toMatch(money('5,000.00')); // the amount to accept
    expect(dlg.textContent).toContain(t('billing.transfers.balance_sender'));
    expect(dlg.textContent).toContain(t('billing.transfers.balance_receiver'));
    await waitFor(() => expect(dlg.textContent).toMatch(money('200.00'))); // sender (OTHER) pocket
    expect(dlg.textContent).toMatch(money('5,000.00')); // receiver (ME) pocket is also 5,000.00
    const reads = calls.filter((c) => c.method === 'GET').map((c) => `${c.url.searchParams.get('party_kind')}:${c.url.searchParams.get('party_id')}`);
    expect(reads).toEqual(expect.arrayContaining([`user_pocket:${OTHER}`, `user_pocket:${ME}`]));
    await user.click(within(dlg).getByRole('button', { name: re('billing.transfers.accept_confirm') }));
    await waitFor(() => expect(posts().length).toBe(1));
    expect(posts()[0]!.method).toBe('POST');
    expect(posts()[0]!.url.pathname).toBe(`/v1/billing/cash-transfers/${TR1}/accept`);
    expect(posts()[0]!.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(posts()[0]!.body === undefined || Object.keys(posts()[0]!.body).length === 0).toBe(true);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('closing the accept confirmation with Cancel sends nothing', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(act(rowOf(/5,000\.00/), 'billing.transfers.accept'));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /^cancel$|^close$|back/i }));
    await new Promise((r) => setTimeout(r, 60));
    expect(posts()).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('double click on the Accept confirmation sends ONE request and the button is disabled while pending', async () => {
    latency = 250;
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(act(rowOf(/5,000\.00/), 'billing.transfers.accept'));
    const dlg = await screen.findByRole('dialog');
    const confirm = within(dlg).getByRole('button', { name: re('billing.transfers.accept_confirm') });
    await user.dblClick(confirm);
    expect(isDisabled(confirm)).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(posts().length).toBe(1);
  });

  it('a failed accept (409 already decided) shows the error, re-enables the dialog and does not refresh as if it worked', async () => {
    api.use(http.post(`${ORIGIN}/v1/billing/cash-transfers/:id/accept`, async ({ request }) => { await rec(request); return HttpResponse.json({ type: 'about:blank', title: 'Immutable', status: 409, code: 'common.immutable_record' }, { status: 409 }); }));
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(act(rowOf(/5,000\.00/), 'billing.transfers.accept'));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: re('billing.transfers.accept_confirm') }));
    await waitFor(() => expect(posts().length).toBe(1));
    await waitFor(() => expect(document.querySelector('[role="alert"], [role="status"]')).toBeTruthy());
    expect(isDisabled(within(screen.getByRole('dialog')).getByRole('button', { name: re('billing.transfers.accept_confirm') }))).toBe(false);
  });

  it('Reject asks to confirm, then POSTs /reject (no body); the transfer remark is shown, never invented', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(act(rowOf(/5,000\.00/), 'billing.transfers.reject'));
    const dlg = await screen.findByRole('dialog');
    await new Promise((r) => setTimeout(r, 40));
    expect(posts()).toEqual([]);
    expect(dlg.textContent).toContain('Synthetic hand over');
    await user.click(within(dlg).getByRole('button', { name: re('billing.transfers.reject_confirm') }));
    await waitFor(() => expect(posts().length).toBe(1));
    expect(posts()[0]!.url.pathname).toBe(`/v1/billing/cash-transfers/${TR1}/reject`);
    expect(posts()[0]!.headers.get('idempotency-key')).toBeTruthy();
    expect(posts()[0]!.body === undefined || Object.keys(posts()[0]!.body).length === 0).toBe(true);
  });

  it('the sender cancels a pending transfer after a confirm: POST /cancel with Idempotency-Key', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(act(rowOf(/1,200\.00/), 'billing.transfers.cancel'));
    const dlg = await screen.findByRole('dialog');
    await new Promise((r) => setTimeout(r, 40));
    expect(posts()).toEqual([]);
    await user.click(within(dlg).getByRole('button', { name: re('billing.transfers.cancel_confirm') }));
    await waitFor(() => expect(posts().length).toBe(1));
    expect(posts()[0]!.url.pathname).toBe(`/v1/billing/cash-transfers/${TR2}/cancel`);
    expect(posts()[0]!.headers.get('idempotency-key')).toBeTruthy();
  });

  it('permissions: manage without decide cannot Accept or Reject (reason shown); read only cannot create, cancel, accept or reject', async () => {
    const S = await load();
    const { unmount } = wrap(<S {...props({ permissions: TRANSFER })} />);
    expectBlockedWithReason(act(rowOf(/5,000\.00/), 'billing.transfers.accept'), 'billing.transfers.reason.no_decide');
    expectBlockedWithReason(act(rowOf(/5,000\.00/), 'billing.transfers.reject'), 'billing.transfers.reason.no_decide');
    expect(isDisabled(screen.getByRole('button', { name: re('billing.transfers.new') }))).toBe(false);
    unmount();
    wrap(<S {...props({ permissions: READ })} />);
    expectBlockedWithReason(screen.getByRole('button', { name: re('billing.transfers.new') }), 'billing.transfers.reason.no_manage');
    expectBlockedWithReason(act(rowOf(/1,200\.00/), 'billing.transfers.cancel'), 'billing.transfers.reason.no_manage');
    expect(posts()).toEqual([]);
  });

  describe('New transfer', () => {
    const open = async () => {
      const S = await load();
      const user = userEvent.setup();
      wrap(<S {...props()} />);
      await user.click(screen.getByRole('button', { name: re('billing.transfers.new') }));
      const dlg = await screen.findByRole('dialog');
      return { user, dlg };
    };
    const fill = async (user: ReturnType<typeof userEvent.setup>, dlg: HTMLElement, from: RegExp, to: RegExp, amount: string) => {
      await pick(user, dlg, /^from\b/i, from);
      await pick(user, dlg, /^to\b/i, to);
      await user.type(within(dlg).getByLabelText(/amount/i), amount);
    };

    it('shows the sender and the receiver pocket balance BEFORE the user confirms; no request is sent by looking', async () => {
      const { user, dlg } = await open();
      await pick(user, dlg, /^from\b/i, /Synthetic Accountant/);
      await pick(user, dlg, /^to\b/i, /Synthetic Cashier/);
      await waitFor(() => expect(dlg.textContent).toContain(t('billing.transfers.balance_sender')));
      expect(dlg.textContent).toContain(t('billing.transfers.balance_receiver'));
      await waitFor(() => expect(dlg.textContent).toMatch(money('5,000.00'))); // sender (ME)
      await waitFor(() => expect(dlg.textContent).toMatch(money('200.00'))); // receiver (OTHER)
      const reads = calls.filter((c) => c.method === 'GET').map((c) => `${c.url.searchParams.get('party_kind')}:${c.url.searchParams.get('party_id')}`);
      expect(reads).toEqual(expect.arrayContaining([`user_pocket:${ME}`, `user_pocket:${OTHER}`]));
      expect(posts()).toEqual([]);
    });

    it('a centre pocket is read with the centre id (party_kind user_pocket)', async () => {
      const { user, dlg } = await open();
      await pick(user, dlg, /^from\b/i, /Synthetic Accountant/);
      await pick(user, dlg, /^to\b/i, /Synthetic Centre A1/);
      await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.url.searchParams.get('party_id') === CENTRE && c.url.searchParams.get('party_kind') === 'user_pocket')).toBe(true));
    });

    it('amount above the sender pocket balance shows the warning (does not block: the API decides); an amount within it shows none', async () => {
      const { user, dlg } = await open();
      await fill(user, dlg, /Synthetic Cashier/, /Synthetic Accountant/, '300.00'); // OTHER holds 200.00
      await waitFor(() => expect(dlg.textContent).toMatch(money('200.00')));
      await waitFor(() => expect(dlg.textContent).toContain(t('billing.transfers.balance_warning')));
      expect(isDisabled(within(dlg).getByRole('button', { name: re('billing.transfers.submit') }))).toBe(false);
      const amount = within(dlg).getByLabelText(/amount/i);
      await user.clear(amount);
      await user.type(amount, '150.00');
      await waitFor(() => expect(dlg.textContent).not.toContain(t('billing.transfers.balance_warning')));
    });

    it('Request sends kinds, ids, paisa integer, remark and Idempotency-Key; then refreshes', async () => {
      const { user, dlg } = await open();
      await fill(user, dlg, /Synthetic Accountant/, /Synthetic Centre A1/, '1500.50');
      await user.type(within(dlg).getByLabelText(/remark/i), 'Synthetic hand over');
      await user.click(within(dlg).getByRole('button', { name: re('billing.transfers.submit') }));
      await waitFor(() => expect(posts().length).toBe(1));
      expect(posts()[0]!.method).toBe('POST');
      expect(posts()[0]!.url.pathname).toBe('/v1/billing/cash-transfers');
      expect(posts()[0]!.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(posts()[0]!.body).toEqual({ from_kind: 'user', from_id: ME, to_kind: 'centre', to_id: CENTRE, amount_paisa: 150050, remark: 'Synthetic hand over' });
      await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it('nothing picked, same sender and receiver, zero, negative and 3 decimal amounts: no request is sent', async () => {
      const { user, dlg } = await open();
      await user.click(within(dlg).getByRole('button', { name: re('billing.transfers.submit') }));
      await new Promise((r) => setTimeout(r, 40));
      expect(posts()).toEqual([]);
      expect(within(dlg).getAllByText(/required|choose|enter/i).length).toBeGreaterThan(0);
      await fill(user, dlg, /Synthetic Accountant/, /Synthetic Accountant/, '10');
      await user.click(within(dlg).getByRole('button', { name: re('billing.transfers.submit') }));
      await new Promise((r) => setTimeout(r, 40));
      expect(posts()).toEqual([]);
      expect(dlg.textContent).toContain(t('billing.transfers.same_party'));
      await pick(user, dlg, /^to\b/i, /Synthetic Cashier/);
      for (const bad of ['0', '-5', '10.505']) {
        const amount = within(dlg).getByLabelText(/amount/i);
        await user.clear(amount);
        await user.type(amount, bad);
        await user.click(within(dlg).getByRole('button', { name: re('billing.transfers.submit') }));
        await new Promise((r) => setTimeout(r, 30));
        expect(posts(), `amount ${bad}`).toEqual([]);
      }
    });

    it('double click on Request sends ONE request and the button is disabled while it is pending', async () => {
      latency = 250;
      const { user, dlg } = await open();
      await fill(user, dlg, /Synthetic Accountant/, /Synthetic Cashier/, '100');
      const submit = within(dlg).getByRole('button', { name: re('billing.transfers.submit') });
      await user.dblClick(submit);
      expect(isDisabled(submit)).toBe(true);
      await new Promise((r) => setTimeout(r, 400));
      expect(posts().length).toBe(1);
    });
  });

  it('no accessibility violations (filled, with a confirm dialog open)', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await noAxeViolations();
    await user.click(act(rowOf(/5,000\.00/), 'billing.transfers.accept'));
    await screen.findByRole('dialog');
    await noAxeViolations();
  });
});

// ───────────────────────── Daily Payment Collection ─────────────────────────
describe('billing/daily-cash — daily collection summary and deposit', () => {
  const load = async () => (await mod<{ DailyCollectionScreen: any }>('transfers/DailyCollectionScreen')).DailyCollectionScreen;
  const summary = (o: Record<string, unknown> = {}) => ({
    centre_id: CENTRE, day: '2026-11-17', rows: [{ payment_mode: 'cash', entry_count: 2, total_paisa: 300000 }, { payment_mode: 'bank_transfer', entry_count: 1, total_paisa: 150000 }], total_paisa: 450000, ...o,
  });
  const props = (o: Record<string, unknown> = {}) => ({ summary: summary(), centres, centreId: CENTRE, day: '2026-11-17', particulars, permissions: DEPOSIT, ...o });

  it('columns, heading, one row per payment mode with entry count and rupees, and the total', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    expect(headers()).toEqual(DAILY_COLUMNS);
    expect(screen.getByRole('heading', { name: t('billing.daily_summary.title') })).toBeTruthy();
    const cash = rowOf(/\bcash\b/i);
    expect(cash.textContent).toMatch(money('3,000.00'));
    expect(cash.textContent).toMatch(/\b2\b/);
    expect(cash.textContent).not.toMatch(/300000/);
    expect(rowOf(/bank transfer/i).textContent).toMatch(money('1,500.00'));
    expect(document.body.textContent).toContain(t('billing.daily_summary.total'));
    expect(document.body.textContent).toMatch(money('4,500.00'));
  });

  it('a refund only day shows a negative amount, not a blank or a crash (LD-334)', async () => {
    const S = await load();
    wrap(<S {...props({ summary: summary({ rows: [{ payment_mode: 'cash', entry_count: -1, total_paisa: -50000 }], total_paisa: -50000 }) })} />);
    expect(rowOf(/\bcash\b/i).textContent).toMatch(/[-−]\s?((NPR|Rs\.)\s?)?500\.00|(NPR|Rs\.)\s?[-−]\s?500\.00/);
  });

  it('no summary (null) or no rows keeps the headers, a catalogue message row and 4 placeholders', async () => {
    const S = await load();
    const { unmount } = wrap(<S {...props({ summary: null })} />);
    expect(headers()).toEqual(DAILY_COLUMNS);
    expect(screen.getByText(t('billing.daily_summary.empty'))).toBeTruthy();
    expect(placeholders()).toBe(4);
    unmount();
    wrap(<S {...props({ summary: summary({ rows: [], total_paisa: 0 }) })} />);
    expect(headers()).toEqual(DAILY_COLUMNS);
    expect(screen.getByText(t('billing.daily_summary.empty'))).toBeTruthy();
  });

  it('centre and day are picked in a labelled search region; Search pushes centre_id and day', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    const bar = screen.getByRole('search');
    await pick(user, bar, /lab name|centre/i, /Synthetic Centre B2/);
    fireEvent.change(within(bar).getByLabelText(/date|day/i), { target: { value: '2026-11-16' } });
    await user.click(within(bar).getByRole('button', { name: /search/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    const url = String(push.mock.calls.at(-1)![0]);
    expect(url).toContain(`centre_id=${CENTRE2}`);
    expect(url).toContain('day=2026-11-16');
  });

  it('Save deposit posts a debit on the centre pocket: paisa integer, day as entry date, BANK_DEPOSIT particular, Idempotency-Key; refreshes', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.type(screen.getByLabelText(re('billing.daily_summary.deposit')), '2000.00');
    await user.click(screen.getByRole('button', { name: re('billing.daily_summary.save') }));
    await waitFor(() => expect(posts().length).toBe(1));
    expect(posts()[0]!.method).toBe('POST');
    expect(posts()[0]!.url.pathname).toBe('/v1/billing/account-ledger-entries');
    expect(posts()[0]!.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(posts()[0]!.body).toMatchObject({ centre_id: CENTRE, party_kind: 'user_pocket', party_id: CENTRE, entry_date: '2026-11-17', account_particular_id: PART_BANK, entry_type: 'debit', amount_paisa: 200000, payment_mode: 'cash' });
    expect(Number.isInteger(posts()[0]!.body.amount_paisa)).toBe(true);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('Save is blocked while the Lab or Day controls differ from the loaded summary: no deposit is posted to the wrong centre or day until Search is pressed', async () => {
    const S = await load();
    const user = userEvent.setup();
    const { unmount } = wrap(<S {...props()} />);
    await user.type(screen.getByLabelText(re('billing.daily_summary.deposit')), '500');
    await pick(user, screen.getByRole('search'), /lab name|centre/i, /Synthetic Centre B2/);
    const save = () => screen.getByRole('button', { name: re('billing.daily_summary.save') });
    expectBlockedWithReason(save(), 'billing.daily_summary.reason.search_first');
    await user.click(save());
    await new Promise((r) => setTimeout(r, 30));
    expect(posts()).toEqual([]);
    unmount();
    wrap(<S {...props()} />);
    await user.type(screen.getByLabelText(re('billing.daily_summary.deposit')), '500');
    fireEvent.change(within(screen.getByRole('search')).getByLabelText(/date|day/i), { target: { value: '2026-11-16' } });
    expectBlockedWithReason(save(), 'billing.daily_summary.reason.search_first');
    await user.click(save());
    await new Promise((r) => setTimeout(r, 30));
    expect(posts()).toEqual([]);
  });

  it('empty, zero, negative and 3 decimal deposits send nothing', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    const box = screen.getByLabelText(re('billing.daily_summary.deposit'));
    for (const bad of ['', '0', '-5', '10.505']) {
      await user.clear(box);
      if (bad) await user.type(box, bad);
      await user.click(screen.getByRole('button', { name: re('billing.daily_summary.save') }));
      await new Promise((r) => setTimeout(r, 30));
      expect(posts(), `deposit "${bad}"`).toEqual([]);
    }
  });

  it('double click on Save sends ONE request and the button is disabled while it is pending', async () => {
    latency = 250;
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.type(screen.getByLabelText(re('billing.daily_summary.deposit')), '100');
    const save = screen.getByRole('button', { name: re('billing.daily_summary.save') });
    await user.dblClick(save);
    expect(isDisabled(save)).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(posts().length).toBe(1);
  });

  it('permissions: without billing.account_entry.create the totals show but deposit and Save are disabled with a visible reason; without the BANK_DEPOSIT particular the reason says so', async () => {
    const S = await load();
    const { unmount } = wrap(<S {...props({ permissions: READ })} />);
    expect(rowOf(/\bcash\b/i)).toBeTruthy();
    expectBlockedWithReason(screen.getByRole('button', { name: re('billing.daily_summary.save') }), 'billing.daily_summary.reason.no_create');
    expect(isDisabled(screen.getByLabelText(re('billing.daily_summary.deposit')))).toBe(true);
    unmount();
    wrap(<S {...props({ particulars: [particulars[0]] })} />);
    expectBlockedWithReason(screen.getByRole('button', { name: re('billing.daily_summary.save') }), 'billing.daily_summary.reason.no_particular');
    expect(posts()).toEqual([]);
  });

  it('no accessibility violations', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    await noAxeViolations();
  });
});
