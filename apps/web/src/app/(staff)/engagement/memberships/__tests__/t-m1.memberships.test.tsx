// @vitest-environment jsdom
// T-M1 — Staff web W10 Memberships (04-UI-UX §3 W10 + §2.4 BarcodeInput; ACs US-EN-17.1, 17.2, 17.4; 07-SECURITY card token = secret, aal2 plan writes; LD-140 design rules).
// done_when "BarcodeInput pattern test". Plans are written at aal2: the shell prompts MFA on `auth.mfa_required` (not tested here: shell behaviour, T-M1 only forwards the 403).
// ASSUMED module/prop contract (spec fixes only the folder + kit components; dispute via writer if wrong). All files under apps/web/src/app/(staff)/engagement/memberships/:
//   MembershipsView.tsx  export MembershipsView({ plans, priceLists, permissions, searchPatients })
//       plans: MembershipPlan[] (TRD §5: id, code, display_name, description?, price_list_id, validity_days, is_active, version); priceLists: {id, display}[] (C3 lists via BFF, feeds the Price list select);
//       permissions: readonly string[] ('engagement.membership.read' | 'engagement.membership.enrol' | 'engagement.membership_plan.manage'); searchPatients(query, signal) => Promise<{id, display}[]> (C4 lookup).
//   Two tabs (role=tab): "Lookup & enrol" (default) and "Plans".
//   page.tsx default async server component; lists M1a GET /v1/engagement/membership-plans. actions.ts 'use server' actions -> serverFetch -> MSW observes /v1/engagement/... (idempotent writes send Idempotency-Key; update/cancel send If-Match "<version>").
//   Lookup tab: BarcodeInput labelled "Scan or type a membership card" -> POST /memberships/lookup with body {card_token} (26 chars) or {card_no} (MB + 8 digits), never in a URL. Result = a region named "Membership card" showing
//     plan name, card number, validity (two dates) and a status word; the card token is never displayed. Button "Cancel membership" inside that region only for status active and engagement.membership.enrol.
//     Cancel: confirm dialog with a reason select (button named /reason/, options "Patient request" | "Staff error" | "Other") and a confirm button "Cancel membership" -> POST /memberships/:id/cancel {reason_code} + If-Match.
//   Enrol form (needs engagement.membership.enrol): combobox "Patient", select button "Plan" (ACTIVE plans only), textbox "Valid from" (DD/MM/YYYY, today ... +30 d), button "Enrol patient" -> POST /memberships {patient_id, plan_id, valid_from: YYYY-MM-DD}.
//   Plans tab: table Code · Name · Validity (days) · Price list (display name) · Status (text Active/Inactive); button "New plan" and per-row "Edit <code>" only with engagement.membership_plan.manage; drawer (role dialog) titled
//     "New plan" / "Edit plan" with textboxes Code, Name, Description, select button "Price list", textbox "Validity days", checkbox "Active", and ONE save button "Save" -> POST /membership-plans | PUT /membership-plans/:id (If-Match).
//   Copy chosen by this tester (dispute if the spec wording differs): 404 "No membership found for this card"; 409 overlap "This patient already has an active membership"; 409 plan_inactive "This plan is no longer active".
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh, back: vi.fn() }),
  usePathname: () => '/engagement/memberships',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['engagement.membership.read', 'engagement.membership.enrol', 'engagement.membership_plan.manage'], displayName: 'Synthetic Front Desk', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/engagement/memberships',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const PAT = U(1), PLAN_GOLD = U(21), PLAN_OLD = U(22), PL1 = U(31), PL2 = U(32), M_ID = U(41);
const TOKEN = '0123456789ABCDEFGHJKMNPQRS'; // 26 chars, Crockford, no I L O U
const CARD_NO = 'MB26000001';
const READ = ['engagement.membership.read'];
const ENROL = ['engagement.membership.read', 'engagement.membership.enrol'];
const FULL = [...ENROL, 'engagement.membership_plan.manage'];
const plans = [
  { id: PLAN_GOLD, code: 'GOLD', display_name: 'Gold plan (synthetic)', description: 'Synthetic', price_list_id: PL1, validity_days: 365, is_active: true, version: 3 },
  { id: PLAN_OLD, code: 'OLDPLAN', display_name: 'Retired plan (synthetic)', price_list_id: PL2, validity_days: 180, is_active: false, version: 1 },
];
const priceLists = [{ id: PL1, display: 'Standard prices (synthetic)' }, { id: PL2, display: 'Member prices (synthetic)' }];
const membership = (o: Record<string, unknown> = {}) => ({ id: M_ID, patient_id: PAT, plan_id: PLAN_GOLD, plan_display_name: 'Gold plan (synthetic)', card_no: CARD_NO, card_token: TOKEN, valid_from: '2026-10-01', valid_to: '2027-10-01', status: 'active', version: 4, ...o });

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (status: number, code: string, title: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title, status, code }, { status });
let lookupResult: () => Response = () => HttpResponse.json(membership());
let enrolResult: () => Response = () => HttpResponse.json(membership({ id: U(42), valid_from: '2026-11-10', valid_to: '2027-11-10', card_no: 'MB26000002' }), { status: 201 });
let planResult: () => Response = () => HttpResponse.json({ ...plans[0], id: U(23), code: 'SILVER', version: 1 }, { status: 201 });
let cancelResult: () => Response = () => HttpResponse.json(membership({ status: 'cancelled', cancel_reason_code: 'patient_request', cancelled_at: '2026-11-05T04:15:00.000Z', version: 5 }));
const api = setupServer(
  http.get(`${ORIGIN}/v1/engagement/membership-plans`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: plans }); }),
  http.post(`${ORIGIN}/v1/engagement/membership-plans`, async ({ request }) => { await rec(request); return planResult(); }),
  http.put(`${ORIGIN}/v1/engagement/membership-plans/:id`, async ({ request }) => { await rec(request); return HttpResponse.json({ ...plans[0], display_name: 'Gold plan v2', version: 4 }); }),
  http.post(`${ORIGIN}/v1/engagement/memberships/lookup`, async ({ request }) => { await rec(request); return lookupResult(); }),
  http.post(`${ORIGIN}/v1/engagement/memberships`, async ({ request }) => { await rec(request); return enrolResult(); }),
  http.post(`${ORIGIN}/v1/engagement/memberships/:id/cancel`, async ({ request }) => { await rec(request); return cancelResult(); }),
);
const setItem = vi.spyOn(Storage.prototype, 'setItem');
const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  expect(setItem).not.toHaveBeenCalled(); // 04-UI-UX §1: nothing about patients / cards in browser storage
  const out = JSON.stringify(consoleSpies.flatMap((s) => s.mock.calls.map((c) => c.map(String))));
  expect(out).not.toContain(TOKEN); expect(out).not.toContain(CARD_NO); // scanned values are never logged (§2.4)
  cleanup(); api.resetHandlers(); calls.length = 0; replace.mockReset(); refresh.mockReset(); setItem.mockClear(); consoleSpies.forEach((s) => s.mockClear()); localStorage.clear(); sessionStorage.clear();
  lookupResult = () => HttpResponse.json(membership());
  enrolResult = () => HttpResponse.json(membership({ id: U(42), valid_from: '2026-11-10', valid_to: '2027-11-10', card_no: 'MB26000002' }), { status: 201 });
  planResult = () => HttpResponse.json({ ...plans[0], id: U(23), code: 'SILVER', version: 1 }, { status: 201 });
  cancelResult = () => HttpResponse.json(membership({ status: 'cancelled', cancel_reason_code: 'patient_request', cancelled_at: '2026-11-05T04:15:00.000Z', version: 5 }));
});
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const searchPatients = vi.fn(async () => [{ id: PAT, display: 'Synthetic Patient One (P-0001)' }]);
const load = async () => ((await import(/* @vite-ignore */ `../${'MembershipsView'}`)) as { MembershipsView: any }).MembershipsView;
const view = async (p: { plans?: unknown[]; permissions?: readonly string[] } = {}) => {
  const MembershipsView = await load();
  return wrap(<MembershipsView plans={p.plans ?? plans} priceLists={priceLists} permissions={p.permissions ?? FULL} searchPatients={searchPatients} />);
};
const scanBox = () => screen.getByRole('textbox', { name: 'Scan or type a membership card' });
const scan = async (text: string) => { await userEvent.type(scanBox(), `${text}{Enter}`); };
const lookups = () => calls.filter((c) => c.url.pathname === '/v1/engagement/memberships/lookup');
const card = () => screen.findByRole('region', { name: /membership card/i });
const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(d); // YYYY-MM-DD
const dmy = (d: Date) => ymd(d).split('-').reverse().join('/');
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

describe('W10 shell: tabs and permissions', () => {
  it('two tabs "Lookup & enrol" (selected by default) and "Plans"; the scanner field is focused on load', async () => {
    await view();
    expect(screen.getByRole('tab', { name: 'Lookup & enrol', selected: true })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Plans' })).toBeTruthy();
    expect(document.activeElement).toBe(scanBox());
  });
  it('read-only users (engagement.membership.read) can look up but get no Enrol form; Plans tab is a list without New plan / Edit', async () => {
    await view({ permissions: READ });
    expect(scanBox()).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^enrol patient$/i })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Plans' }));
    expect(screen.getByRole('row', { name: /GOLD/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new plan/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^edit /i })).toBeNull();
  });
  it('enrol holders without engagement.membership_plan.manage see the plans but cannot write them', async () => {
    await view({ permissions: ENROL });
    await userEvent.click(screen.getByRole('tab', { name: 'Plans' }));
    expect(screen.queryByRole('button', { name: /new plan/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^edit /i })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Lookup & enrol' }));
    expect(screen.getByRole('button', { name: /^enrol patient$/i })).toBeTruthy();
  });
  it('no axe violations on both tabs', async () => {
    await view();
    await noAxeViolations();
    await userEvent.click(screen.getByRole('tab', { name: 'Plans' }));
    await noAxeViolations();
  });
});

describe('BarcodeInput pattern /^[0-9A-Z]{26}$|^MB[0-9]{8}$/ (04-UI-UX W10)', () => {
  it('a 26-char token is looked up as {card_token}: POST /memberships/lookup, token only in the body, never in the URL', async () => {
    await view();
    await scan(TOKEN);
    await waitFor(() => expect(lookups()).toHaveLength(1));
    expect(lookups()[0]!.method).toBe('POST');
    expect(lookups()[0]!.body).toEqual({ card_token: TOKEN });
    expect(lookups()[0]!.url.search).toBe('');
    expect(calls.map((c) => c.url.href).join(' ')).not.toContain(TOKEN);
  });
  it('a typed card number MB + 8 digits is looked up as {card_no}', async () => {
    await view();
    await scan(CARD_NO);
    await waitFor(() => expect(lookups()).toHaveLength(1));
    expect(lookups()[0]!.body).toEqual({ card_no: CARD_NO });
  });
  it('lowercase input is upper-cased by the kit and accepted', async () => {
    await view();
    await scan(CARD_NO.toLowerCase());
    await waitFor(() => expect(lookups()).toHaveLength(1));
    expect(lookups()[0]!.body).toEqual({ card_no: CARD_NO });
  });
  it.each([['25 chars', TOKEN.slice(1)], ['27 chars', `${TOKEN}A`], ['MB + 7 digits', 'MB2600001'], ['MB + 9 digits', 'MB260000011'], ['MB + letters', 'MBABCDEFGH'], ['punctuation', `${TOKEN.slice(1)}-`], ['plain 10 digits', '2600000011'], ['quote injection', "MB26000001' OR 1=1"]])(
    'invalid value (%s) sends no request and marks the field invalid', async (_n, text) => {
      await view();
      await scan(text);
      expect(lookups()).toHaveLength(0);
      expect(scanBox().getAttribute('aria-invalid')).toBe('true');
    });
  it('the same scan twice within 1.5 s sends one request (kit duplicate guard)', async () => {
    await view();
    await scan(TOKEN); await scan(TOKEN);
    await waitFor(() => expect(lookups().length).toBeGreaterThanOrEqual(1));
    expect(lookups()).toHaveLength(1);
  });
  it('without engagement.membership.read there is no scanner at all', async () => {
    await view({ permissions: [] });
    expect(screen.queryByRole('textbox', { name: 'Scan or type a membership card' })).toBeNull();
  });
});

describe('Lookup result (US-EN-17.4)', () => {
  it('card panel: plan name, card number, both validity dates, status as a word; the card token is NOT shown; the patient id is not shown as free text either', async () => {
    await view();
    await scan(TOKEN);
    const c = await card();
    expect(within(c).getByText('Gold plan (synthetic)')).toBeTruthy();
    expect(within(c).getByText(CARD_NO)).toBeTruthy();
    expect(c.textContent).toMatch(/01\/10\/2026|2026-10-01|1 Oct 2026/);
    expect(c.textContent).toMatch(/01\/10\/2027|2027-10-01|1 Oct 2027/);
    expect(within(c).getByText(/^active$/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain(TOKEN);
  });
  it('cancelled / expired cards show their status word and offer no Cancel action', async () => {
    for (const status of ['cancelled', 'expired']) {
      lookupResult = () => HttpResponse.json(membership({ status, ...(status === 'cancelled' ? { cancelled_at: '2026-11-01T00:00:00.000Z', cancel_reason_code: 'other' } : {}) }));
      const { unmount } = await view();
      await scan(TOKEN);
      const c = await card();
      expect(within(c).getByText(new RegExp(`^${status}$`, 'i'))).toBeTruthy();
      expect(within(c).queryByRole('button', { name: /cancel membership/i })).toBeNull();
      unmount(); calls.length = 0;
    }
  });
  it('404 -> "No membership found for this card"; the scan field is ready for the next scan', async () => {
    lookupResult = () => problem(404, 'common.not_found', 'Not found');
    await view();
    await scan(TOKEN);
    expect(await screen.findByText('No membership found for this card')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /membership card/i })).toBeNull();
    expect((scanBox() as HTMLInputElement).value).toBe('');
  });
  it('403 auth.forbidden is shown as a permission message, not as "not found"', async () => {
    lookupResult = () => problem(403, 'auth.forbidden', 'Forbidden');
    await view();
    await scan(TOKEN);
    expect(await screen.findByText(/not allowed|permission|forbidden/i)).toBeTruthy();
    expect(screen.queryByText('No membership found for this card')).toBeNull();
  });
});

describe('Cancel (M5)', () => {
  const open = async () => {
    await view();
    await scan(TOKEN);
    const c = await card();
    await userEvent.click(within(c).getByRole('button', { name: /^cancel membership$/i }));
    return screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
  };
  it('active card: Cancel membership -> confirm dialog with a reason; nothing is sent before confirming; POST /memberships/:id/cancel {reason_code} with If-Match = version', async () => {
    const dlg = await open();
    expect(calls.filter((c) => /cancel/.test(c.url.pathname))).toHaveLength(0);
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Patient request' }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^cancel membership$/i }));
    await waitFor(() => expect(calls.filter((c) => /cancel/.test(c.url.pathname))).toHaveLength(1));
    const c = calls.find((x) => /cancel/.test(x.url.pathname))!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe(`/v1/engagement/memberships/${M_ID}/cancel`);
    expect(c.body).toEqual({ reason_code: 'patient_request' });
    expect(c.headers.get('if-match')).toBe('"4"');
    expect(await within(await card()).findByText(/^cancelled$/i)).toBeTruthy();
  });
  it('confirming without a reason is blocked in the form (no request)', async () => {
    const dlg = await open();
    await userEvent.click(within(dlg).getByRole('button', { name: /^cancel membership$/i }));
    expect(await within(dlg).findByText(/reason.*required|select a reason|choose a reason/i)).toBeTruthy();
    expect(calls.filter((c) => /cancel/.test(c.url.pathname))).toHaveLength(0);
  });
  it('409 common.version_conflict shows the spec Banner "Someone else changed this. Reload to see the latest." with [Reload]', async () => {
    cancelResult = () => problem(409, 'common.version_conflict', 'Version conflict');
    const dlg = await open();
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Staff error' }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^cancel membership$/i }));
    expect(await screen.findByText('Someone else changed this. Reload to see the latest.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /^reload$/i }));
    expect(refresh).toHaveBeenCalled();
  });
  it('without engagement.membership.enrol the card panel has no Cancel action', async () => {
    await view({ permissions: READ });
    await scan(TOKEN);
    expect(within(await card()).queryByRole('button', { name: /cancel membership/i })).toBeNull();
  });
});

describe('Enrol patient (M2, US-EN-17.2)', () => {
  const fill = async (opts: { date?: string; patient?: boolean; plan?: string | null } = {}) => {
    if (opts.patient !== false) {
      await userEvent.type(screen.getByRole('combobox', { name: /patient/i }), 'syn');
      await userEvent.click(await screen.findByRole('option', { name: /Synthetic Patient One/ }));
    }
    if (opts.plan !== null) {
      await userEvent.click(screen.getByRole('button', { name: /plan/i }));
      await userEvent.click(await screen.findByRole('option', { name: opts.plan ?? 'Gold plan (synthetic)' }));
    }
    const d = screen.getByRole('textbox', { name: /valid from/i });
    await userEvent.clear(d);
    await userEvent.type(d, opts.date ?? dmy(inDays(5)));
  };
  const submit = () => userEvent.click(screen.getByRole('button', { name: /^enrol patient$/i }));
  const enrols = () => calls.filter((c) => c.method === 'POST' && c.url.pathname === '/v1/engagement/memberships');

  it('valid input -> POST /memberships {patient_id, plan_id, valid_from YYYY-MM-DD} only, with Idempotency-Key; the new card is shown (number and dates, not the token)', async () => {
    await view();
    const date = inDays(5);
    await fill({ date: dmy(date) });
    await submit();
    await waitFor(() => expect(enrols()).toHaveLength(1));
    const c = enrols()[0]!;
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(Object.keys(c.body).sort()).toEqual(['patient_id', 'plan_id', 'valid_from']);
    expect(c.body).toEqual({ patient_id: PAT, plan_id: PLAN_GOLD, valid_from: ymd(date) });
    expect(await screen.findByText('MB26000002')).toBeTruthy();
    expect(document.body.textContent).not.toContain(TOKEN);
  });
  it('inactive plans are not offered', async () => {
    await view();
    await userEvent.click(screen.getByRole('button', { name: /plan/i }));
    expect(await screen.findByRole('option', { name: 'Gold plan (synthetic)' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Retired plan (synthetic)' })).toBeNull();
  });
  it('valid from window today … +30 days: today and +30 pass; yesterday and +31 are refused in the form with no request', async () => {
    await view();
    await fill({ date: dmy(inDays(-1)) }); await submit();
    expect(await screen.findByText(/today|30 days/i)).toBeTruthy();
    expect(enrols()).toHaveLength(0);
    cleanup(); calls.length = 0;
    await view();
    await fill({ date: dmy(inDays(31)) }); await submit();
    expect(await screen.findByText(/today|30 days/i)).toBeTruthy();
    expect(enrols()).toHaveLength(0);
    cleanup();
    await view();
    await fill({ date: dmy(inDays(30)) }); await submit();
    await waitFor(() => expect(enrols()).toHaveLength(1));
  });
  it('missing patient or plan is refused in the form (no request)', async () => {
    await view();
    await fill({ patient: false }); await submit();
    expect(await screen.findByText(/patient.*required|select a patient/i)).toBeTruthy();
    expect(enrols()).toHaveLength(0);
    cleanup(); calls.length = 0;
    await view();
    await fill({ plan: null }); await submit();
    expect(await screen.findByText(/plan.*required|select a plan/i)).toBeTruthy();
    expect(enrols()).toHaveLength(0);
  });
  it('409 engagement.membership_overlap -> "This patient already has an active membership"; the form stays filled', async () => {
    enrolResult = () => problem(409, 'engagement.membership_overlap', 'Membership already active');
    await view();
    await fill(); await submit();
    expect(await screen.findByText('This patient already has an active membership')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: /valid from/i }) as HTMLInputElement).value).not.toBe('');
  });
  it('409 engagement.plan_inactive -> "This plan is no longer active"', async () => {
    enrolResult = () => problem(409, 'engagement.plan_inactive', 'Membership plan inactive');
    await view();
    await fill(); await submit();
    expect(await screen.findByText('This plan is no longer active')).toBeTruthy();
  });
  it('double-click on Enrol sends exactly one request (one Idempotency-Key)', async () => {
    await view();
    await fill();
    await userEvent.dblClick(screen.getByRole('button', { name: /^enrol patient$/i }));
    await waitFor(() => expect(enrols().length).toBeGreaterThanOrEqual(1));
    expect(enrols()).toHaveLength(1);
  });
});

describe('Plans tab (M1a / M1b, US-EN-17.1)', () => {
  const tab = async (permissions: readonly string[] = FULL) => { await view({ permissions }); await userEvent.click(screen.getByRole('tab', { name: 'Plans' })); };
  const newPlan = async () => { await userEvent.click(screen.getByRole('button', { name: /new plan/i })); return screen.findByRole('dialog', { name: /new plan/i }); };
  const fillPlan = async (dlg: HTMLElement, o: { code?: string; name?: string; validity?: string; pl?: string | null } = {}) => {
    await userEvent.type(within(dlg).getByRole('textbox', { name: /^code/i }), o.code ?? 'SILVER');
    await userEvent.type(within(dlg).getByRole('textbox', { name: /^name/i }), o.name ?? 'Silver plan (synthetic)');
    if (o.pl !== null) { await userEvent.click(within(dlg).getByRole('button', { name: /price list/i })); await userEvent.click(await screen.findByRole('option', { name: o.pl ?? 'Standard prices (synthetic)' })); }
    const v = within(dlg).getByRole('textbox', { name: /validity/i }); await userEvent.clear(v); await userEvent.type(v, o.validity ?? '365');
  };
  const writes = () => calls.filter((c) => /membership-plans/.test(c.url.pathname) && c.method !== 'GET');

  it('list columns Code · Name · Validity (days) · Price list · Status; price list shown by name, status as a word for active AND inactive plans', async () => {
    await tab();
    for (const h of ['Code', 'Name', 'Validity', 'Price list', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`) })).toBeTruthy();
    const gold = screen.getByRole('row', { name: /GOLD/ });
    expect(within(gold).getByText('Gold plan (synthetic)')).toBeTruthy();
    expect(within(gold).getByText('365')).toBeTruthy();
    expect(within(gold).getByText('Standard prices (synthetic)')).toBeTruthy();
    expect(within(gold).getByText(/^active$/i)).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /OLDPLAN/ })).getByText(/^inactive$/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain(PL1); // ids are never shown
  });
  it('empty list shows an empty state, not a blank table', async () => {
    await view({ plans: [] });
    await userEvent.click(screen.getByRole('tab', { name: 'Plans' }));
    expect(screen.getByText(/no (membership )?plans/i)).toBeTruthy();
  });
  it('New plan drawer fields: Code, Name (max 60), Description (max 300), Price list, Validity days, Active; exactly one primary Save', async () => {
    await tab();
    const dlg = await newPlan();
    expect((within(dlg).getByRole('textbox', { name: /^name/i }) as HTMLInputElement).maxLength).toBe(60);
    expect((within(dlg).getByRole('textbox', { name: /description/i }) as HTMLTextAreaElement).maxLength).toBe(300);
    expect(within(dlg).getByRole('checkbox', { name: /active/i })).toBeTruthy();
    expect(within(dlg).getAllByRole('button', { name: /^save$/i })).toHaveLength(1);
    await noAxeViolations();
  });
  it('valid input -> POST /membership-plans with Idempotency-Key and exactly {code, display_name, price_list_id, validity_days, is_active} (+ description only when typed); list refreshes', async () => {
    await tab();
    const dlg = await newPlan();
    await fillPlan(dlg);
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const c = writes()[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/v1/engagement/membership-plans');
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(c.body).toEqual({ code: 'SILVER', display_name: 'Silver plan (synthetic)', price_list_id: PL1, validity_days: 365, is_active: true });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
  it.each([['lowercase code', { code: 'silver' }], ['one-char code', { code: 'S' }], ['validity 29', { validity: '29' }], ['validity 1096', { validity: '1096' }], ['validity text', { validity: 'abc' }], ['no price list', { pl: null }]] as const)(
    'form refuses %s: message shown, no request', async (_n, o) => {
      await tab();
      const dlg = await newPlan();
      await fillPlan(dlg, o as any);
      await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
      await waitFor(() => expect(within(dlg).queryAllByText(/required|must|between|30|1095|uppercase|letters|digits|invalid/i).length + within(dlg).queryAllByRole('alert').length).toBeGreaterThan(0));
      expect(writes()).toHaveLength(0);
      expect(screen.getByRole('dialog', { name: /new plan/i })).toBeTruthy();
    });
  it('server 400 common.validation_failed (price list unknown / inactive / not published) is shown in the drawer, which stays open with the input kept', async () => {
    planResult = () => HttpResponse.json({ type: 'urn:lims:error:common.validation_failed', title: 'Request validation failed', status: 400, code: 'common.validation_failed', errors: [{ path: '/price_list_id', code: 'common.field_invalid', message: 'Price list is not available' }] }, { status: 400 });
    await tab();
    const dlg = await newPlan();
    await fillPlan(dlg);
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    expect(await within(dlg).findByText(/price list/i, { selector: ':not(label):not(button):not([role=option])' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: /new plan/i })).toBeTruthy();
    expect((within(dlg).getByRole('textbox', { name: /^code/i }) as HTMLInputElement).value).toBe('SILVER');
  });
  it('server 403 auth.mfa_required is forwarded, never shown as a success: no "created" toast, drawer stays open with the input', async () => {
    planResult = () => problem(403, 'auth.mfa_required', 'Multi-factor authentication required');
    await tab();
    const dlg = await newPlan();
    await fillPlan(dlg);
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(screen.queryByText(/plan (created|saved)|saved/i)).toBeNull();
    expect(screen.getByRole('dialog', { name: /new plan/i })).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
  it('Edit <code> -> drawer prefilled; Save -> PUT /membership-plans/:id with If-Match = version and the same five/six fields', async () => {
    await tab();
    await userEvent.click(screen.getByRole('button', { name: /^edit GOLD$/i }));
    const dlg = await screen.findByRole('dialog', { name: /edit plan/i });
    expect((within(dlg).getByRole('textbox', { name: /^name/i }) as HTMLInputElement).value).toBe('Gold plan (synthetic)');
    const n = within(dlg).getByRole('textbox', { name: /^name/i }); await userEvent.clear(n); await userEvent.type(n, 'Gold plan v2');
    await userEvent.click(within(dlg).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const c = writes()[0]!;
    expect(c.method).toBe('PUT');
    expect(c.url.pathname).toBe(`/v1/engagement/membership-plans/${PLAN_GOLD}`);
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(c.body).toMatchObject({ code: 'GOLD', display_name: 'Gold plan v2', price_list_id: PL1, validity_days: 365, is_active: true });
    for (const k of ['id', 'version', 'tenant_id']) expect(c.body, k).not.toHaveProperty(k);
  });
});
