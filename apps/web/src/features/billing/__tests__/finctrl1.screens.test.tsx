// @vitest-environment jsdom
// T0D-FINCTRL-1 — accounting control screens (LD-321, LD-310 founder blanket authority, LD-353 UI rules): discount reasons, slabs per party, per user
// limits, authorities; Hold and Release on the account entries; fiscal year filter; previous outstanding cash, deposit and carried forward on the daily
// collection. Component tests through the real BFF (server actions -> serverFetch -> MSW). Synthetic data only.
// ASSUMED prop contract (the spec fixes only names, paths and fields; the writer may dispute through the ruling path). Under apps/web/src/features/billing/components/:
//   discounts/DiscountReasonsScreen({reasons, permissions, failure?})                     route billing/discounts/reasons      (reasons = DiscountReason[])
//   discounts/DiscountSlabsScreen({slabs, parties, permissions, filters?, failure?})      route billing/discounts/slabs        (parties = {kind, id, name}[], kind = credit_party|partner|doctor|franchise)
//   discounts/DiscountLimitsScreen({limits, members, permissions, failure?})              route billing/discounts/limits       (members = {id, name}[], id = user id)
//   discounts/DiscountAuthoritiesScreen({authorities, members, permissions, failure?})    route billing/discounts/authorities
//   accounts/AccountEntriesScreen: existing props; adds Hold / Release in the Entry Status cell, a held badge, a held total and two filters (fiscal year, status held).
//   transfers/DailyCollectionScreen: existing props + sessions?: CashSessionDto[] (from getDailyCash().sessions; the screen uses the ones of centreId).
// PINNED SEMANTICS (tester choice, flagged in the notes):
//   - view permission billing.discount_policy.read (route floor), change permission billing.discount_policy.manage; Hold/Release reuse billing.account.manage.
//   - percent typed as percent ("5", "12.5", at most 2 decimals, 0..100) and sent as discount_bp (500, 1250); rupees typed with at most 2 decimals, sent as paisa integers.
//   - no row has Delete; "Deactivate" is PATCH/POST/PUT per the contract, with If-Match = the row version; an inactive row offers no Deactivate.
//   - authorities have no edit operation in the contract: create and deactivate only.
//   - one toggle per entry row: Hold (enabled only for status submitted) or, on a held row, Release. Reverse is blocked on a held row (reason held_first).
//   - held total = sum of amount_paisa of the held entries in the list; carried forward = max(0, previous outstanding + cash row of the summary - deposit).
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
  usePathname: () => '/billing/discounts/reasons',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Accountant', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/billing/discounts/reasons',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const CENTRE = U(3), CENTRE2 = U(6), CLIENT = U(4), CLIENT2 = U(7), DOCTOR = U(8), FRANCHISE = U(5), PART_FEE = U(10), PART_BANK = U(11), GRP = U(20), ME = U(90), OTHER = U(91), THIRD = U(92);
const R1 = U(501), R2 = U(502), R3 = U(503), S1 = U(511), S2 = U(512), S3 = U(513), L1 = U(521), L2 = U(522), A1 = U(531), A2 = U(532);
const E1 = U(101), E2 = U(102), E3 = U(103), E4 = U(104), E5 = U(105);

const READ = ['billing.discount_policy.read'];
const MANAGE = ['billing.discount_policy.read', 'billing.discount_policy.manage'];
const ACCT_READ = ['billing.account.read'];
const ACCT_MANAGE = ['billing.account.read', 'billing.account.manage', 'billing.account_entry.reverse'];

const ts = '2026-11-01T04:00:00.000Z';
const reasons = [
  { id: R1, code: 'PARTNER_FAMILY', name: 'Synthetic Partner Family', is_active: true, display_order: 1, version: 2, created_at: ts, updated_at: ts },
  { id: R2, code: 'REGULAR_PATIENT', name: 'Synthetic Regular Patient', is_active: true, display_order: 2, version: 1, created_at: ts, updated_at: ts },
  { id: R3, code: 'OLD_REASON', name: 'Synthetic Old Reason', is_active: false, display_order: 3, version: 4, created_at: ts, updated_at: ts },
];
const parties = [
  { kind: 'credit_party', id: CLIENT, name: 'Synthetic Client Alpha' },
  { kind: 'credit_party', id: CLIENT2, name: 'Synthetic Client Gamma' },
  { kind: 'doctor', id: DOCTOR, name: 'Synthetic Doctor Delta' },
  { kind: 'franchise', id: FRANCHISE, name: 'Synthetic Franchise Beta' },
];
const slab = (o: Record<string, unknown> = {}) => ({
  id: S1, party_kind: 'credit_party', party_id: CLIENT, amount_from_paisa: 0, amount_to_paisa: 100000, discount_bp: 500, effective_from: '2026-11-17', is_active: true, version: 3, created_at: ts, updated_at: ts, ...o,
});
const slabs = [
  slab(),
  slab({ id: S2, party_kind: 'doctor', party_id: DOCTOR, amount_from_paisa: 100000, amount_to_paisa: 500050, discount_bp: 1250, effective_from: '2026-10-01', effective_to: '2026-12-30', version: 1 }),
  slab({ id: S3, party_id: CLIENT2, discount_bp: 250, is_active: false, version: 5 }),
];
const members = [{ id: ME, name: 'Synthetic Accountant' }, { id: OTHER, name: 'Synthetic Cashier' }, { id: THIRD, name: 'Synthetic Clerk' }];
const limit = (o: Record<string, unknown> = {}) => ({ id: L1, user_id: OTHER, max_discount_bp: 500, max_discount_paisa: 100000, is_active: true, version: 3, created_at: ts, updated_at: ts, ...o });
const limits = [limit(), limit({ id: L2, user_id: THIRD, max_discount_bp: 1000, max_discount_paisa: 250075, is_active: false, version: 2 })];
const authority = (o: Record<string, unknown> = {}) => ({ id: A1, user_id: ME, max_discount_bp: 2000, max_discount_paisa: 500000, is_active: true, version: 2, created_at: ts, updated_at: ts, ...o });
const authorities = [authority(), authority({ id: A2, user_id: OTHER, max_discount_bp: 750, max_discount_paisa: 120000, is_active: false, version: 5 })];

const entry = (o: Record<string, unknown> = {}) => ({
  id: E1, centre_id: CENTRE, party_kind: 'credit_party', party_id: CLIENT, entry_date: '2026-11-07', account_particular_id: PART_FEE, entry_type: 'credit', amount_paisa: 150050,
  payment_mode: 'cash', comments: 'Synthetic comment', status: 'submitted', receipt_no: 'ACC-000001', created_by: ME, last_modified_by: ME, created_at: ts, fiscal_year_label: '2083/84', ...o,
});
const entries = [
  entry(), // submitted: can be held
  entry({ id: E2, receipt_no: 'ACC-000002', status: 'held', amount_paisa: 50000, held_reason: 'Cheque not cleared', held_by: ME, held_at: ts }),
  entry({ id: E3, receipt_no: 'ACC-000003', status: 'held', amount_paisa: 120050, entry_type: 'debit', held_reason: 'Awaiting bank', held_by: ME, held_at: ts }),
  entry({ id: E4, receipt_no: 'ACC-000004', status: 'approved' }), // cannot be held
  entry({ id: E5, receipt_no: 'ACC-000005', status: 'reversed' }), // cannot be held
];
const acctParties = [{ id: CLIENT, kind: 'credit_party', name: 'Synthetic Client Alpha' }, { id: FRANCHISE, kind: 'franchise', name: 'Synthetic Franchise Beta' }];
const particulars = [
  { id: PART_FEE, account_group_id: GRP, code: 'COLLECTION', name: 'Synthetic Collection', is_active: true, version: 1 },
  { id: PART_BANK, account_group_id: GRP, code: 'BANK_DEPOSIT', name: 'Synthetic Bank Deposit', is_active: true, version: 1 },
];
const centres = [{ id: CENTRE, name: 'Synthetic Centre A1' }, { id: CENTRE2, name: 'Synthetic Centre B2' }];

const problem = (status: number, code: string, errors?: { path: string; code: string; message: string }[]) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'Synthetic failure', status, code, request_id: '01933b6f-0a11-7e2b-8c55-1d2e3f405162', ...(errors ? { errors } : {}) }, { status });

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const writes = () => calls.filter((c) => c.method !== 'GET');
let latency = 0;
let nextFailure: Response | undefined;
const answer = (body: unknown, status = 200) => async ({ request }: { request: Request }) => {
  await rec(request);
  await delay(latency);
  if (nextFailure) { const f = nextFailure; nextFailure = undefined; return f; }
  return HttpResponse.json(body as never, { status });
};
const api = setupServer(
  http.post(`${ORIGIN}/v1/billing/discount-reasons`, answer(reasons[0], 201)),
  http.patch(`${ORIGIN}/v1/billing/discount-reasons/:id`, answer(reasons[0])),
  http.post(`${ORIGIN}/v1/billing/discount-slabs`, answer(slabs[0], 201)),
  http.patch(`${ORIGIN}/v1/billing/discount-slabs/:id`, answer(slabs[0])),
  http.post(`${ORIGIN}/v1/billing/discount-slabs/:id/deactivate`, answer({ ...slabs[0], is_active: false })),
  http.put(`${ORIGIN}/v1/billing/discount-limits/:userId`, answer(limits[0])),
  http.post(`${ORIGIN}/v1/billing/discount-authorities`, answer(authorities[0], 201)),
  http.post(`${ORIGIN}/v1/billing/discount-authorities/:id/deactivate`, answer({ ...authorities[0], is_active: false })),
  http.post(`${ORIGIN}/v1/billing/account-ledger-entries/:id/hold`, answer(entry({ status: 'held' }))),
  http.post(`${ORIGIN}/v1/billing/account-ledger-entries/:id/release`, answer(entry({ status: 'submitted' }))),
  http.all(`${ORIGIN}/v1/billing/*`, async ({ request }) => { await rec(request); return HttpResponse.json({}, { status: 200 }); }),
);
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; latency = 0; nextFailure = undefined; push.mockReset(); refresh.mockReset(); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const mod = async <T,>(p: string) => (await import(/* @vite-ignore */ `../components/${p}`)) as T;
const money = (rupees: string) => new RegExp(`((NPR|Rs\\.)\\s?)?${rupees.replace(/[.,]/g, '\\$&')}`);
const AD = /\d{2}\/\d{2}\/\d{4}/;
const BS = /\d{4}-\d{2}-\d{2}/;
const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent!.trim());
const names = () => headers().map((h) => h.replace(/\s*\(NPR\)$/, '').replace(/\s*\(%\)$/, ''));
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
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const quiet = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const descOf = (el: HTMLElement) => reasonOf(el);
const typeInto = async (user: ReturnType<typeof userEvent.setup>, el: HTMLElement, v: string) => { await user.clear(el); if (v) await user.type(el, v); };

const REASON_COLUMNS = ['Code', 'Name', 'Active'];
const SLAB_COLUMNS = ['Party Type', 'Party', 'From Amount', 'To Amount', 'Discount Percent', 'Effective From', 'Effective To', 'Active'];
const LIMIT_COLUMNS = ['User', 'Max Percent', 'Max Amount Per Bill', 'Active'];

/** The ElabAssist columns come first and unchanged; the only addition is a trailing Action column. */
const expectColumns = (cols: string[]) => {
  expect(names().slice(0, cols.length)).toEqual(cols);
  expect(names().slice(cols.length)).toEqual(['Action']);
};

// ───────────────────────── Discount Reason ─────────────────────────
describe('billing/discounts/reasons — Discount Reason list, create, edit, deactivate', () => {
  const load = async () => (await mod<{ DiscountReasonsScreen: any }>('discounts/DiscountReasonsScreen')).DiscountReasonsScreen;
  const props = (o: Record<string, unknown> = {}) => ({ reasons, permissions: MANAGE, ...o });

  it('heading from the catalogue; columns Code, Name, Active (+ Action); filled rows show code, name and Active as text', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    expect(screen.getByRole('heading', { name: t('billing.discounts.reasons.title') })).toBeTruthy();
    expect(t('billing.discounts.reasons.title')).not.toBe('billing.discounts.reasons.title');
    expectColumns(REASON_COLUMNS);
    const row = rowOf(/PARTNER_FAMILY/);
    expect(row.textContent).toContain('Synthetic Partner Family');
    expect(row.textContent).toContain(t('billing.discounts.active.yes'));
    expect(rowOf(/OLD_REASON/).textContent).toContain(t('billing.discounts.active.no'));
  });

  it('empty list keeps every header, a catalogue message row and 4 inert placeholder rows', async () => {
    const S = await load();
    wrap(<S {...props({ reasons: [] })} />);
    expectColumns(REASON_COLUMNS);
    expect(screen.getByText(t('billing.discounts.reasons.empty'))).toBeTruthy();
    expect(t('billing.discounts.reasons.empty')).not.toBe('billing.discounts.reasons.empty');
    expect(placeholders()).toBe(4);
  });

  it('Add New creates a reason: POST code + name with Idempotency-Key, then refreshes; no display_order is invented', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: re('billing.discounts.reasons.new') }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(/^code/i), 'SYN_FRIEND');
    await user.type(within(dlg).getByLabelText(/^name/i), 'Synthetic Friend');
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(writes().length).toBe(1));
    const c = writes()[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/v1/billing/discount-reasons');
    expect(c.headers.get('idempotency-key')).toMatch(KEY);
    expect(c.body).toEqual({ code: 'SYN_FRIEND', name: 'Synthetic Friend' });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('blank name, blank code, lower case code, a code with spaces and a 33 character code send nothing and mark the field', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: re('billing.discounts.reasons.new') }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await quiet();
    expect(writes()).toEqual([]);
    expect(within(dlg).getByLabelText(/^code/i).getAttribute('aria-invalid')).toBe('true');
    await user.type(within(dlg).getByLabelText(/^name/i), 'Synthetic Friend');
    for (const bad of ['syn_friend', 'SYN FRIEND', 'A'.repeat(33), '   ']) {
      await typeInto(user, within(dlg).getByLabelText(/^code/i), bad);
      await user.click(within(dlg).getByRole('button', { name: /^save/i }));
      await quiet(30);
      expect(writes(), `code "${bad}"`).toEqual([]);
    }
  });

  it('a server error on the code (duplicate) is shown on the Code field and the form stays open with its values', async () => {
    nextFailure = problem(400, 'common.validation_failed', [{ path: '/code', code: 'common.validation_failed', message: 'Code SYN_FRIEND already exists' }]);
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: re('billing.discounts.reasons.new') }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(/^code/i), 'SYN_FRIEND');
    await user.type(within(dlg).getByLabelText(/^name/i), 'Synthetic Friend');
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(within(dlg).getByLabelText(/^code/i).getAttribute('aria-invalid')).toBe('true'));
    expect(descOf(within(dlg).getByLabelText(/^code/i))).toContain('Code SYN_FRIEND already exists');
    expect((within(dlg).getByLabelText(/^code/i) as HTMLInputElement).value).toBe('SYN_FRIEND');
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Edit shows the code read only, PATCHes only the name with If-Match = the row version; never the code', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(within(rowOf(/PARTNER_FAMILY/)).getByRole('button', { name: re('billing.discounts.edit') }));
    const dlg = await screen.findByRole('dialog');
    const code = within(dlg).queryByLabelText(/^code/i) as HTMLInputElement | null;
    if (code) expect(code.readOnly || code.disabled).toBe(true);
    const name = within(dlg).getByLabelText(/^name/i);
    await typeInto(user, name, 'Synthetic Partner Kin');
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(writes().length).toBe(1));
    const c = writes()[0]!;
    expect(c.method).toBe('PATCH');
    expect(c.url.pathname).toBe(`/v1/billing/discount-reasons/${R1}`);
    expect(c.headers.get('if-match')).toMatch(/^"?2"?$/);
    expect(c.body).toEqual({ name: 'Synthetic Partner Kin' });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('Deactivate asks to confirm, then PATCHes is_active=false with If-Match; an inactive row offers no Deactivate; there is no Delete anywhere', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull();
    expect(within(rowOf(/OLD_REASON/)).queryByRole('button', { name: re('billing.discounts.deactivate') })).toBeNull();
    await user.click(within(rowOf(/REGULAR_PATIENT/)).getByRole('button', { name: re('billing.discounts.deactivate') }));
    await quiet(40);
    expect(writes()).toEqual([]); // first click only asks
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: re('billing.discounts.deactivate_confirm') }));
    await waitFor(() => expect(writes().length).toBe(1));
    const c = writes()[0]!;
    expect(c.method).toBe('PATCH');
    expect(c.url.pathname).toBe(`/v1/billing/discount-reasons/${R2}`);
    expect(c.headers.get('if-match')).toMatch(/^"?1"?$/);
    expect(c.body).toEqual({ is_active: false });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('without billing.discount_policy.manage Add New, Edit and Deactivate are disabled with a visible reason; the list is still readable', async () => {
    const S = await load();
    wrap(<S {...props({ permissions: READ })} />);
    expect(rowOf(/PARTNER_FAMILY/)).toBeTruthy();
    expectBlockedWithReason(screen.getByRole('button', { name: re('billing.discounts.reasons.new') }), 'billing.discounts.reason.no_manage');
    expectBlockedWithReason(within(rowOf(/PARTNER_FAMILY/)).getByRole('button', { name: re('billing.discounts.edit') }), 'billing.discounts.reason.no_manage');
    expectBlockedWithReason(within(rowOf(/PARTNER_FAMILY/)).getByRole('button', { name: re('billing.discounts.deactivate') }), 'billing.discounts.reason.no_manage');
  });

  it('double click on Save sends ONE request; the button is disabled while pending', async () => {
    latency = 250;
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: re('billing.discounts.reasons.new') }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(/^code/i), 'SYN_FRIEND');
    await user.type(within(dlg).getByLabelText(/^name/i), 'Synthetic Friend');
    const save = within(dlg).getByRole('button', { name: /^save/i });
    await user.dblClick(save);
    expect(isDisabled(save)).toBe(true);
    await quiet(450);
    expect(writes().length).toBe(1);
  });

  it('is accessible (axe) with and without the dialog', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await noAxeViolations();
    await user.click(screen.getByRole('button', { name: re('billing.discounts.reasons.new') }));
    await screen.findByRole('dialog');
    await noAxeViolations();
  });
});

// ───────────────────────── Discount slab per party ─────────────────────────
describe('billing/discounts/slabs — Discount slab per party', () => {
  const load = async () => (await mod<{ DiscountSlabsScreen: any }>('discounts/DiscountSlabsScreen')).DiscountSlabsScreen;
  const props = (o: Record<string, unknown> = {}) => ({ slabs, parties, permissions: MANAGE, ...o });
  const openNew = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: re('billing.discounts.slabs.new') }));
    return screen.findByRole('dialog');
  };
  const fill = async (user: ReturnType<typeof userEvent.setup>, dlg: HTMLElement, v: { from?: string; to?: string; pct?: string; eff?: string; end?: string } = {}) => {
    await pick(user, dlg, /^party type/i, /credit party|client/i);
    await pick(user, dlg, /^party(?! type)/i, /Synthetic Client Alpha/);
    await typeInto(user, within(dlg).getByLabelText(/from amount/i), v.from ?? '0');
    await typeInto(user, within(dlg).getByLabelText(/to amount/i), v.to ?? '1000');
    await typeInto(user, within(dlg).getByLabelText(/discount percent/i), v.pct ?? '5');
    await typeInto(user, within(dlg).getByLabelText(/effective from/i), v.eff ?? '2026-11-17');
    if (v.end) await typeInto(user, within(dlg).getByLabelText(/effective to/i), v.end);
  };

  it('heading and columns are exactly the brief columns (+ Action); percent shown as percent, money as rupees from paisa, AD with BS beside', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    expect(screen.getByRole('heading', { name: t('billing.discounts.slabs.title') })).toBeTruthy();
    expectColumns(SLAB_COLUMNS);
    const a = rowOf(/Synthetic Client Alpha/).textContent!;
    expect(a).toMatch(/\b5(\.0{1,2})?\s?%/);
    expect(a).not.toMatch(/\b500\b/); // basis points never shown
    expect(a).toMatch(money('0.00'));
    expect(a).toMatch(money('1,000.00'));
    expect(a).toMatch(AD);
    expect(a).toMatch(BS);
    expect(a).toContain(t('billing.discounts.slabs.open_ended')); // no Effective To
    const d = rowOf(/Synthetic Doctor Delta/).textContent!;
    expect(d).toMatch(/12\.5(0)?\s?%/);
    expect(d).toMatch(money('1,000.00'));
    expect(d).toMatch(money('5,000.50'));
    expect(d).not.toContain(t('billing.discounts.slabs.open_ended'));
    expect(rowOf(/Synthetic Client Gamma/).textContent).toContain(t('billing.discounts.active.no'));
  });

  it('money and percent cells are right aligned', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    const row = rowOf(/Synthetic Client Alpha/);
    const cells = within(row).getAllByRole('gridcell').length ? within(row).getAllByRole('gridcell') : within(row).getAllByRole('cell');
    for (const c of ['From Amount', 'To Amount', 'Discount Percent']) expect(cells[names().indexOf(c)]!.className, c).toMatch(/lims-align-end/);
  });

  it('empty list keeps all eight headers, a catalogue message row and 4 inert placeholder rows', async () => {
    const S = await load();
    wrap(<S {...props({ slabs: [] })} />);
    expectColumns(SLAB_COLUMNS);
    expect(screen.getByText(t('billing.discounts.slabs.empty'))).toBeTruthy();
    expect(placeholders()).toBe(4);
  });

  it('the party filter pushes the API query names party_kind and party_id', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    const bar = screen.getByRole('search');
    await pick(user, bar, /^party type/i, /credit party|client/i);
    await pick(user, bar, /^party(?! type)/i, /Synthetic Client Alpha/);
    await user.click(within(bar).getByRole('button', { name: /search/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    const url = String(push.mock.calls.at(-1)![0]);
    expect(url).toContain('party_kind=credit_party');
    expect(url).toContain(`party_id=${CLIENT}`);
  });

  it('New slab: percent 5 is sent as 500 bp, rupees as integer paisa, dates as ISO, no effective_to when blank; Idempotency-Key; then refresh', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    const dlg = await openNew(user);
    await fill(user, dlg, { from: '0', to: '1000.50', pct: '5', eff: '2026-11-17' });
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(writes().length).toBe(1));
    const c = writes()[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/v1/billing/discount-slabs');
    expect(c.headers.get('idempotency-key')).toMatch(KEY);
    expect(c.body).toEqual({ party_kind: 'credit_party', party_id: CLIENT, amount_from_paisa: 0, amount_to_paisa: 100050, discount_bp: 500, effective_from: '2026-11-17' });
    expect(Number.isInteger(c.body.discount_bp) && Number.isInteger(c.body.amount_to_paisa)).toBe(true);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('percent 12.5 is sent as 1250 bp and an Effective To is sent when typed', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    const dlg = await openNew(user);
    await fill(user, dlg, { pct: '12.5', end: '2026-12-30' });
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]!.body.discount_bp).toBe(1250);
    expect(writes()[0]!.body.effective_to).toBe('2026-12-30');
  });

  it('the Party list only offers parties of the chosen Party Type', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    const dlg = await openNew(user);
    await pick(user, dlg, /^party type/i, /doctor/i);
    await user.click(within(dlg).getByRole('button', { name: /^party(?! type)/i }));
    expect(await screen.findByRole('option', { name: /Synthetic Doctor Delta/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Synthetic Client Alpha/ })).toBeNull();
  });

  it('bad input sends nothing and marks the field: empty form, To not above From, percent over 100, 3 decimal percent, negative, 3 decimal rupees, bad dates, end before start', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    const dlg = await openNew(user);
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await quiet();
    expect(writes()).toEqual([]);
    await fill(user, dlg);
    const cases: [string, Record<string, string>][] = [
      ['to equals from', { from: '100', to: '100' }],
      ['to below from', { from: '100', to: '50' }],
      ['percent 101', { pct: '101' }],
      ['percent 5.255', { pct: '5.255' }],
      ['percent -1', { pct: '-1' }],
      ['percent text', { pct: 'abc' }],
      ['from -5', { from: '-5' }],
      ['to 10.505', { to: '10.505' }],
      ['date not ISO', { eff: '17/11/2026' }],
      ['impossible date', { eff: '2026-02-31' }],
      ['end before start', { eff: '2026-11-17', end: '2026-11-01' }],
    ];
    for (const [label, v] of cases) {
      await fill(user, dlg, { from: '0', to: '1000', pct: '5', eff: '2026-11-17', ...v });
      await user.click(within(dlg).getByRole('button', { name: /^save/i }));
      await quiet(30);
      expect(writes(), label).toEqual([]);
      expect(dlg.querySelector('[aria-invalid="true"]'), `${label}: a field is marked invalid`).toBeTruthy();
      await typeInto(user, within(dlg).getByLabelText(/effective to/i), '');
    }
  });

  it('an overlapping slab: the server error is shown on the From Amount field, the form stays open with what was typed, nothing refreshes', async () => {
    nextFailure = problem(400, 'common.validation_failed', [{ path: '/amount_from_paisa', code: 'common.validation_failed', message: 'Overlaps an active slab of this party' }]);
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    const dlg = await openNew(user);
    await fill(user, dlg, { from: '0', to: '1000', pct: '5' });
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(within(dlg).getByLabelText(/from amount/i).getAttribute('aria-invalid')).toBe('true'));
    expect(descOf(within(dlg).getByLabelText(/from amount/i))).toContain('Overlaps an active slab of this party');
    expect(within(dlg).getByLabelText(/to amount/i).getAttribute('aria-invalid')).not.toBe('true');
    expect((within(dlg).getByLabelText(/to amount/i) as HTMLInputElement).value).toBe('1000');
    expect((within(dlg).getByLabelText(/discount percent/i) as HTMLInputElement).value).toBe('5');
    expect(refresh).not.toHaveBeenCalled();
    // correcting and saving again works with a fresh request
    await typeInto(user, within(dlg).getByLabelText(/from amount/i), '1000');
    await typeInto(user, within(dlg).getByLabelText(/to amount/i), '2000');
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(writes().length).toBe(2));
    expect(writes()[1]!.headers.get('idempotency-key')).not.toBe(writes()[0]!.headers.get('idempotency-key'));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('a server error on /amount_to_paisa is shown on To Amount, and on /effective_to on Effective To', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    const dlg = await openNew(user);
    await fill(user, dlg);
    nextFailure = problem(400, 'common.validation_failed', [{ path: '/amount_to_paisa', code: 'common.validation_failed', message: 'To must be above From' }, { path: '/effective_to', code: 'common.validation_failed', message: 'End before start' }]);
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(within(dlg).getByLabelText(/to amount/i).getAttribute('aria-invalid')).toBe('true'));
    expect(descOf(within(dlg).getByLabelText(/to amount/i))).toContain('To must be above From');
    expect(descOf(within(dlg).getByLabelText(/effective to/i))).toContain('End before start');
  });

  it('an error without a field (403) is shown as a message, not on a field, and the form stays open', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    const dlg = await openNew(user);
    await fill(user, dlg);
    nextFailure = problem(403, 'auth.forbidden');
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(document.querySelector('[role="alert"], [role="status"]')).toBeTruthy());
    expect(dlg.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Edit: party is locked and never sent; PATCH with If-Match = version and only the editable fields', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(within(rowOf(/Synthetic Client Alpha/)).getByRole('button', { name: re('billing.discounts.edit') }));
    const dlg = await screen.findByRole('dialog');
    expect((within(dlg).getByLabelText(/discount percent/i) as HTMLInputElement).value).toBe('5');
    expect((within(dlg).getByLabelText(/to amount/i) as HTMLInputElement).value).toMatch(/^1000(\.00)?$/);
    await typeInto(user, within(dlg).getByLabelText(/discount percent/i), '7.5');
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(writes().length).toBe(1));
    const c = writes()[0]!;
    expect(c.method).toBe('PATCH');
    expect(c.url.pathname).toBe(`/v1/billing/discount-slabs/${S1}`);
    expect(c.headers.get('if-match')).toMatch(/^"?3"?$/);
    expect(c.body.discount_bp).toBe(750);
    for (const k of ['party_kind', 'party_id', 'is_active']) expect(c.body, k).not.toHaveProperty(k);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('Deactivate asks to confirm, then POSTs /deactivate with If-Match; an inactive slab offers no Deactivate; there is no Delete', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull();
    expect(within(rowOf(/Synthetic Client Gamma/)).queryByRole('button', { name: re('billing.discounts.deactivate') })).toBeNull();
    await user.click(within(rowOf(/Synthetic Doctor Delta/)).getByRole('button', { name: re('billing.discounts.deactivate') }));
    await quiet(40);
    expect(writes()).toEqual([]);
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: re('billing.discounts.deactivate_confirm') }));
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]!.method).toBe('POST');
    expect(writes()[0]!.url.pathname).toBe(`/v1/billing/discount-slabs/${S2}/deactivate`);
    expect(writes()[0]!.headers.get('if-match')).toMatch(/^"?1"?$/);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('a version conflict on Edit shows a message and keeps the form (no silent overwrite)', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(within(rowOf(/Synthetic Client Alpha/)).getByRole('button', { name: re('billing.discounts.edit') }));
    const dlg = await screen.findByRole('dialog');
    await typeInto(user, within(dlg).getByLabelText(/discount percent/i), '6');
    nextFailure = problem(409, 'common.version_conflict');
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(document.querySelector('[role="alert"], [role="status"]')).toBeTruthy());
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('without the manage permission every write control is disabled with a visible reason', async () => {
    const S = await load();
    wrap(<S {...props({ permissions: READ })} />);
    expectBlockedWithReason(screen.getByRole('button', { name: re('billing.discounts.slabs.new') }), 'billing.discounts.reason.no_manage');
    expectBlockedWithReason(within(rowOf(/Synthetic Client Alpha/)).getByRole('button', { name: re('billing.discounts.edit') }), 'billing.discounts.reason.no_manage');
    expectBlockedWithReason(within(rowOf(/Synthetic Client Alpha/)).getByRole('button', { name: re('billing.discounts.deactivate') }), 'billing.discounts.reason.no_manage');
  });

  it('is accessible (axe) with the form open', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await noAxeViolations();
    await openNew(user);
    await noAxeViolations();
  });
});

// ───────────────────────── Discount limits and authorities ─────────────────────────
describe('billing/discounts/limits — Discount Limit per user', () => {
  const load = async () => (await mod<{ DiscountLimitsScreen: any }>('discounts/DiscountLimitsScreen')).DiscountLimitsScreen;
  const props = (o: Record<string, unknown> = {}) => ({ limits, members, permissions: MANAGE, ...o });

  it('columns User, Max Percent, Max Amount Per Bill, Active (+ Action); user name resolved, percent as percent, rupees from paisa', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    expect(screen.getByRole('heading', { name: t('billing.discounts.limits.title') })).toBeTruthy();
    expectColumns(LIMIT_COLUMNS);
    const a = rowOf(/Synthetic Cashier/).textContent!;
    expect(a).toMatch(/\b5(\.0{1,2})?\s?%/);
    expect(a).toMatch(money('1,000.00'));
    expect(a).not.toMatch(/100000|\b500\b/);
    const b = rowOf(/Synthetic Clerk/).textContent!;
    expect(b).toMatch(/\b10(\.0{1,2})?\s?%/);
    expect(b).toMatch(money('2,500.75'));
    expect(b).toContain(t('billing.discounts.active.no'));
  });

  it('empty list keeps the four headers and 4 placeholders', async () => {
    const S = await load();
    wrap(<S {...props({ limits: [] })} />);
    expectColumns(LIMIT_COLUMNS);
    expect(screen.getByText(t('billing.discounts.limits.empty'))).toBeTruthy();
    expect(placeholders()).toBe(4);
  });

  it('Add New for a user without a row: PUT /discount-limits/{user_id}, percent as bp, paisa integer, NO If-Match', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: re('billing.discounts.limits.new') }));
    const dlg = await screen.findByRole('dialog');
    await pick(user, dlg, /^user/i, /Synthetic Accountant/);
    await user.type(within(dlg).getByLabelText(/max percent/i), '2.5');
    await user.type(within(dlg).getByLabelText(/max amount per bill/i), '750.25');
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(writes().length).toBe(1));
    const c = writes()[0]!;
    expect(c.method).toBe('PUT');
    expect(c.url.pathname).toBe(`/v1/billing/discount-limits/${ME}`);
    expect(c.headers.get('if-match')).toBeNull();
    expect(c.body).toMatchObject({ max_discount_bp: 250, max_discount_paisa: 75025 });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('Edit keeps the user fixed and sends If-Match = the row version', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(within(rowOf(/Synthetic Cashier/)).getByRole('button', { name: re('billing.discounts.edit') }));
    const dlg = await screen.findByRole('dialog');
    expect((within(dlg).getByLabelText(/max percent/i) as HTMLInputElement).value).toBe('5');
    await typeInto(user, within(dlg).getByLabelText(/max percent/i), '6');
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(writes().length).toBe(1));
    const c = writes()[0]!;
    expect(c.method).toBe('PUT');
    expect(c.url.pathname).toBe(`/v1/billing/discount-limits/${OTHER}`);
    expect(c.headers.get('if-match')).toMatch(/^"?3"?$/);
    expect(c.body).toMatchObject({ max_discount_bp: 600, max_discount_paisa: 100000 });
  });

  it('Deactivate (confirm first) PUTs the same ceilings with is_active=false and If-Match; inactive rows offer none; no Delete', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull();
    expect(within(rowOf(/Synthetic Clerk/)).queryByRole('button', { name: re('billing.discounts.deactivate') })).toBeNull();
    await user.click(within(rowOf(/Synthetic Cashier/)).getByRole('button', { name: re('billing.discounts.deactivate') }));
    await quiet(40);
    expect(writes()).toEqual([]);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: re('billing.discounts.deactivate_confirm') }));
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]!.method).toBe('PUT');
    expect(writes()[0]!.headers.get('if-match')).toMatch(/^"?3"?$/);
    expect(writes()[0]!.body).toEqual({ max_discount_bp: 500, max_discount_paisa: 100000, is_active: false });
  });

  it('percent over 100, 3 decimals, negative amount and a missing user send nothing', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: re('billing.discounts.limits.new') }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await quiet();
    expect(writes()).toEqual([]);
    await pick(user, dlg, /^user/i, /Synthetic Accountant/);
    for (const [pct, amt] of [['101', '10'], ['1.255', '10'], ['5', '-1'], ['5', '10.005'], ['', '10']] as const) {
      await typeInto(user, within(dlg).getByLabelText(/max percent/i), pct);
      await typeInto(user, within(dlg).getByLabelText(/max amount per bill/i), amt);
      await user.click(within(dlg).getByRole('button', { name: /^save/i }));
      await quiet(30);
      expect(writes(), `${pct} / ${amt}`).toEqual([]);
    }
  });

  it('without the manage permission the write controls are disabled with a visible reason', async () => {
    const S = await load();
    wrap(<S {...props({ permissions: READ })} />);
    expectBlockedWithReason(screen.getByRole('button', { name: re('billing.discounts.limits.new') }), 'billing.discounts.reason.no_manage');
    expectBlockedWithReason(within(rowOf(/Synthetic Cashier/)).getByRole('button', { name: re('billing.discounts.edit') }), 'billing.discounts.reason.no_manage');
  });
});

describe('billing/discounts/authorities — Discount Authority', () => {
  const load = async () => (await mod<{ DiscountAuthoritiesScreen: any }>('discounts/DiscountAuthoritiesScreen')).DiscountAuthoritiesScreen;
  const props = (o: Record<string, unknown> = {}) => ({ authorities, members, permissions: MANAGE, ...o });

  it('columns User, Max Percent, Max Amount Per Bill, Active (+ Action); values shown as percent and rupees', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    expect(screen.getByRole('heading', { name: t('billing.discounts.authorities.title') })).toBeTruthy();
    expectColumns(LIMIT_COLUMNS);
    const a = rowOf(/Synthetic Accountant/).textContent!;
    expect(a).toMatch(/\b20(\.0{1,2})?\s?%/);
    expect(a).toMatch(money('5,000.00'));
    expect(rowOf(/Synthetic Cashier/).textContent).toMatch(/7\.5(0)?\s?%/);
    expect(rowOf(/Synthetic Cashier/).textContent).toContain(t('billing.discounts.active.no'));
  });

  it('empty list keeps the four headers and 4 placeholders', async () => {
    const S = await load();
    wrap(<S {...props({ authorities: [] })} />);
    expectColumns(LIMIT_COLUMNS);
    expect(screen.getByText(t('billing.discounts.authorities.empty'))).toBeTruthy();
    expect(placeholders()).toBe(4);
  });

  it('Add New POSTs user_id, max_discount_bp, max_discount_paisa with Idempotency-Key', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(screen.getByRole('button', { name: re('billing.discounts.authorities.new') }));
    const dlg = await screen.findByRole('dialog');
    await pick(user, dlg, /^user/i, /Synthetic Clerk/);
    await user.type(within(dlg).getByLabelText(/max percent/i), '15');
    await user.type(within(dlg).getByLabelText(/max amount per bill/i), '3000');
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(writes().length).toBe(1));
    const c = writes()[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/v1/billing/discount-authorities');
    expect(c.headers.get('idempotency-key')).toMatch(KEY);
    expect(c.body).toEqual({ user_id: THIRD, max_discount_bp: 1500, max_discount_paisa: 300000 });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('there is no Edit (the contract has no update): rows offer Deactivate only; confirm, then POST /deactivate with If-Match; inactive rows offer nothing; no Delete', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    expect(screen.queryByRole('button', { name: re('billing.discounts.edit') })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull();
    expect(within(rowOf(/Synthetic Cashier/)).queryByRole('button', { name: re('billing.discounts.deactivate') })).toBeNull();
    await user.click(within(rowOf(/Synthetic Accountant/)).getByRole('button', { name: re('billing.discounts.deactivate') }));
    await quiet(40);
    expect(writes()).toEqual([]);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: re('billing.discounts.deactivate_confirm') }));
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]!.method).toBe('POST');
    expect(writes()[0]!.url.pathname).toBe(`/v1/billing/discount-authorities/${A1}/deactivate`);
    expect(writes()[0]!.headers.get('if-match')).toMatch(/^"?2"?$/);
  });

  it('without the manage permission Add New and Deactivate are disabled with a visible reason', async () => {
    const S = await load();
    wrap(<S {...props({ permissions: READ })} />);
    expectBlockedWithReason(screen.getByRole('button', { name: re('billing.discounts.authorities.new') }), 'billing.discounts.reason.no_manage');
    expectBlockedWithReason(within(rowOf(/Synthetic Accountant/)).getByRole('button', { name: re('billing.discounts.deactivate') }), 'billing.discounts.reason.no_manage');
  });
});

// ───────────────────────── Hold and Release on the account entries ─────────────────────────
describe('billing/accounts/entries — Hold, Release, held badge, held total, fiscal year filter', () => {
  const load = async () => (await mod<{ AccountEntriesScreen: any }>('accounts/AccountEntriesScreen')).AccountEntriesScreen;
  const props = (o: Record<string, unknown> = {}) => ({ entries, particulars, parties: acctParties, centres, members, permissions: ACCT_MANAGE, ...o });
  const holdBtn = (row: HTMLElement) => within(row).getByRole('button', { name: re('billing.accounts.entries.hold') });
  const releaseBtn = (row: HTMLElement) => within(row).getByRole('button', { name: re('billing.accounts.entries.release') });

  it('a held entry shows a Held badge and its reason; the other statuses show no held badge', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    const held = rowOf(/ACC-000002/);
    expect(within(held).getByText(t('billing.accounts.status.held'))).toBeTruthy();
    expect(t('billing.accounts.status.held')).not.toBe('billing.accounts.status.held');
    expect(held.textContent).toContain('Cheque not cleared');
    expect(within(rowOf(/ACC-000001/)).queryByText(t('billing.accounts.status.held'))).toBeNull();
  });

  it('a separate held total: the sum of the held entries, in rupees from paisa, with its own label (always shown)', async () => {
    const S = await load();
    const { unmount } = wrap(<S {...props()} />);
    const label = screen.getByText(t('billing.accounts.entries.held_total'));
    expect(t('billing.accounts.entries.held_total')).not.toBe('billing.accounts.entries.held_total');
    expect(label.parentElement!.textContent).toMatch(money('1,700.50')); // 500.00 + 1,200.50
    unmount();
    wrap(<S {...props({ entries: [entries[0], entries[3]] })} />);
    expect(screen.getByText(t('billing.accounts.entries.held_total')).parentElement!.textContent).toMatch(money('0.00'));
  });

  it('only a submitted entry can be held: Hold is disabled with a visible reason on approved and reversed rows; Release replaces Hold on a held row', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    expect(isDisabled(holdBtn(rowOf(/ACC-000001/)))).toBe(false);
    expectBlockedWithReason(holdBtn(rowOf(/ACC-000004/)), 'billing.accounts.reason.not_submitted');
    expectBlockedWithReason(holdBtn(rowOf(/ACC-000005/)), 'billing.accounts.reason.not_submitted');
    expect(within(rowOf(/ACC-000002/)).queryByRole('button', { name: re('billing.accounts.entries.hold') })).toBeNull();
    expect(isDisabled(releaseBtn(rowOf(/ACC-000002/)))).toBe(false);
    expect(within(rowOf(/ACC-000001/)).queryByRole('button', { name: re('billing.accounts.entries.release') })).toBeNull();
  });

  it('a held entry cannot be reversed: Reverse is disabled with the held_first reason (release first)', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    expectBlockedWithReason(within(rowOf(/ACC-000002/)).getByRole('button', { name: re('billing.accounts.entries.reverse') }), 'billing.accounts.reason.held_first');
  });

  it('without billing.account.manage Hold and Release are disabled with the no_hold reason (shown, not hidden)', async () => {
    const S = await load();
    wrap(<S {...props({ permissions: ACCT_READ })} />);
    expectBlockedWithReason(holdBtn(rowOf(/ACC-000001/)), 'billing.accounts.reason.no_hold');
    expectBlockedWithReason(releaseBtn(rowOf(/ACC-000002/)), 'billing.accounts.reason.no_hold');
  });

  it('Hold asks for a reason: blank, whitespace and 501 characters send nothing; a reason POSTs {reason} to /hold with Idempotency-Key, then refreshes', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(holdBtn(rowOf(/ACC-000001/)));
    const dlg = await screen.findByRole('dialog');
    const confirm = () => within(dlg).getByRole('button', { name: re('billing.accounts.entries.hold_confirm') });
    const box = within(dlg).getByLabelText(re('billing.accounts.entries.hold_reason'));
    await user.click(confirm());
    await quiet(40);
    expect(writes()).toEqual([]);
    await user.type(box, '    ');
    await user.click(confirm());
    await quiet(40);
    expect(writes()).toEqual([]);
    await user.clear(box);
    fireEvent.change(box, { target: { value: 'x'.repeat(501) } });
    await user.click(confirm());
    await quiet(40);
    expect(writes()).toEqual([]);
    fireEvent.change(box, { target: { value: 'Cheque not cleared' } });
    await user.click(confirm());
    await waitFor(() => expect(writes().length).toBe(1));
    const c = writes()[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe(`/v1/billing/account-ledger-entries/${E1}/hold`);
    expect(c.headers.get('idempotency-key')).toMatch(KEY);
    expect(c.body).toEqual({ reason: 'Cheque not cleared' });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('Release asks for a reason and POSTs {reason} to /release with Idempotency-Key, then refreshes', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(releaseBtn(rowOf(/ACC-000002/)));
    const dlg = await screen.findByRole('dialog');
    const box = within(dlg).getByLabelText(re('billing.accounts.entries.hold_reason'));
    await user.click(within(dlg).getByRole('button', { name: re('billing.accounts.entries.release_confirm') }));
    await quiet(40);
    expect(writes()).toEqual([]);
    await user.type(box, 'Cheque cleared');
    await user.click(within(dlg).getByRole('button', { name: re('billing.accounts.entries.release_confirm') }));
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]!.url.pathname).toBe(`/v1/billing/account-ledger-entries/${E2}/release`);
    expect(writes()[0]!.headers.get('idempotency-key')).toMatch(KEY);
    expect(writes()[0]!.body).toEqual({ reason: 'Cheque cleared' });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('a refused hold (immutable record) shows a message, keeps the list and does not refresh; double click sends ONE request', async () => {
    latency = 200;
    nextFailure = problem(409, 'common.immutable_record');
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    await user.click(holdBtn(rowOf(/ACC-000001/)));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(re('billing.accounts.entries.hold_reason')), 'Cheque not cleared');
    const confirm = within(dlg).getByRole('button', { name: re('billing.accounts.entries.hold_confirm') });
    await user.dblClick(confirm);
    await waitFor(() => expect(document.querySelector('[role="alert"], [role="status"]')).toBeTruthy());
    expect(writes().length).toBe(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('the Status filter offers Held and the fiscal year filter pushes fiscal_year_label; a malformed fiscal year is not pushed', async () => {
    const S = await load();
    const user = userEvent.setup();
    wrap(<S {...props()} />);
    const bar = screen.getAllByRole('search')[0]!;
    await pick(user, bar, /status/i, new RegExp(`^${t('billing.accounts.status.held')}$`, 'i'));
    expect(String(push.mock.calls.at(-1)![0])).toContain('status=held');
    const fy = within(bar).getByLabelText(re('billing.accounts.filter.fiscal_year'));
    expect(t('billing.accounts.filter.fiscal_year')).not.toBe('billing.accounts.filter.fiscal_year');
    await user.type(fy, '2083');
    await user.click(within(bar).getByRole('button', { name: /search/i }));
    expect(String(push.mock.calls.at(-1)![0])).not.toContain('fiscal_year_label');
    await typeInto(user, fy, '2083/84');
    await user.click(within(bar).getByRole('button', { name: /search/i }));
    expect(decodeURIComponent(String(push.mock.calls.at(-1)![0]))).toContain('fiscal_year_label=2083/84');
  });

  it('the existing columns are unchanged (hold sits inside Entry Status, no new column) and the page is accessible', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    expect(names()).toEqual(['Laboratory', 'Client', 'Franchise', 'Entry Date', 'Particulars', 'Credited', 'Debited', 'Comments', 'Payment Mode', 'Reference Number', 'Bank Details', 'Payment Details', 'Last Modified By', 'Entry Status', 'Download Receipt']);
    await noAxeViolations();
  });
});

// ───────────────────────── Daily collection: previous outstanding, deposit, carried forward ─────────────────────────
describe('billing/daily-cash — Previous Outstanding Cash, Deposit, carried forward', () => {
  const load = async () => (await mod<{ DailyCollectionScreen: any }>('transfers/DailyCollectionScreen')).DailyCollectionScreen;
  const session = (o: Record<string, unknown> = {}) => ({ id: U(601), opened_by: { id: ME, name: 'Synthetic Accountant' }, centre_id: CENTRE, status: 'closed', opened_at: ts, rows: [], previous_outstanding_cash_paisa: 250000, deposit_paisa: 100000, version: 2, ...o });
  const summary = { centre_id: CENTRE, day: '2026-11-07', rows: [{ payment_mode: 'cash', entry_count: 3, total_paisa: 400000 }, { payment_mode: 'card', entry_count: 1, total_paisa: 99999 }], total_paisa: 499999 };
  const props = (o: Record<string, unknown> = {}) => ({ summary, centres, centreId: CENTRE, day: '2026-11-07', particulars, permissions: ['billing.account.read', 'billing.account_entry.create'], sessions: [session()], ...o });
  const figure = (key: string) => screen.getByText(t(key)).parentElement!.textContent!;

  it('shows the three labelled figures: Previous Outstanding Cash, Deposit and the carried forward amount (previous + cash collected - deposit)', async () => {
    const S = await load();
    wrap(<S {...props()} />);
    for (const k of ['previous_outstanding', 'deposited', 'carried_forward']) expect(t(`billing.daily_summary.${k}`), k).not.toBe(`billing.daily_summary.${k}`);
    expect(new Set(['previous_outstanding', 'deposited', 'carried_forward'].map((k) => t(`billing.daily_summary.${k}`))).size).toBe(3);
    expect(figure('billing.daily_summary.previous_outstanding')).toMatch(money('2,500.00'));
    expect(figure('billing.daily_summary.deposited')).toMatch(money('1,000.00'));
    expect(figure('billing.daily_summary.carried_forward')).toMatch(money('5,500.00')); // 2,500.00 + 4,000.00 cash - 1,000.00; the card row is not cash
  });

  it('only the sessions of the selected centre count; several sessions of the centre add up', async () => {
    const S = await load();
    wrap(<S {...props({ sessions: [session(), session({ id: U(602), previous_outstanding_cash_paisa: 10050, deposit_paisa: 5000 }), session({ id: U(603), centre_id: CENTRE2, previous_outstanding_cash_paisa: 999900, deposit_paisa: 777700 })] })} />);
    expect(figure('billing.daily_summary.previous_outstanding')).toMatch(money('2,600.50'));
    expect(figure('billing.daily_summary.deposited')).toMatch(money('1,050.00'));
    expect(document.body.textContent).not.toMatch(/9,999\.00|7,777\.00/);
  });

  it('no session yet: the figures are still shown, as 0.00 (no blank, no crash); the carried forward never goes below zero', async () => {
    const S = await load();
    const { unmount } = wrap(<S {...props({ sessions: [], summary: { ...summary, rows: [], total_paisa: 0 } })} />);
    for (const k of ['previous_outstanding', 'deposited', 'carried_forward']) expect(figure(`billing.daily_summary.${k}`), k).toMatch(money('0.00'));
    unmount();
    wrap(<S {...props({ sessions: [session({ previous_outstanding_cash_paisa: 0, deposit_paisa: 900000 })] })} />);
    expect(figure('billing.daily_summary.carried_forward')).toMatch(money('0.00'));
    expect(figure('billing.daily_summary.carried_forward')).not.toContain('-');
  });

  it('sessions null (the read was refused, e.g. no billing.cash_report.read): the three figures show "—", never an invented 0.00 or a computed carried forward', async () => {
    const S = await load();
    wrap(<S {...props({ sessions: null })} />);
    for (const k of ['previous_outstanding', 'deposited', 'carried_forward']) {
      const txt = figure(`billing.daily_summary.${k}`);
      expect(txt, k).toContain('—');
      expect(txt, k).not.toMatch(/\d[\d,]*\.\d{2}/); // no money figure at all (cash total 4,000.00 must not leak into carried forward)
    }
    expect(screen.getByRole('heading', { name: t('billing.daily_summary.title') })).toBeTruthy();
  });

  it('sessions is optional: the existing screen still renders without it (existing callers)', async () => {
    const S = await load();
    const p = props(); delete (p as Record<string, unknown>)['sessions'];
    wrap(<S {...p} />);
    expect(screen.getByRole('heading', { name: t('billing.daily_summary.title') })).toBeTruthy();
  });
});
