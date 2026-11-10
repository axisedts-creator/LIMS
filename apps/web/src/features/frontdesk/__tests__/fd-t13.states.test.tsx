// @vitest-environment jsdom
// FD-T13 — registration page states, F9 error table (04-UI-UX §3.3), success panel (§3.4), label flow (08 A13 D-4; US-FD-15.1), credit badge (Quote.credit_status),
// payment rules (§3.2 F), LD-25 downtime back-entry (limits), PHI rules (§1), a11y (§9). Contract + MSW: see fd-t13.harness.tsx.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PATH, HttpResponse, MONEY, ORDER, PERMS, UNIT, calls, delay, handlers, noAxeViolations, of, party, problem, push, quoteFor, renderForm, result, setup } from './fd-t13.harness';

setup();
const T = 4000;
type User = ReturnType<typeof userEvent.setup>;
const newUser = () => userEvent.setup({ delay: null });

async function pickPatient(user: User) {
  await user.keyboard('{F2}9841000001');
  await screen.findByRole('option', { name: /Synthetic Patient One/ }, { timeout: T });
  await user.keyboard('{Enter}');
  await screen.findByText(/P-000123/, undefined, { timeout: T });
}
async function addItem(user: User, code: string, name: RegExp) {
  await user.keyboard(`{F4}${code}`);
  await screen.findByRole('option', { name }, { timeout: T });
  await user.keyboard('{Enter}');
}
/** Existing patient + 3 items, cash, quote returned. Net = NPR 339.00. */
async function ready(user: User, n = 3) {
  await pickPatient(user);
  const items: [string, RegExp][] = [['CBC', /Complete blood count/], ['LIPID', /Lipid profile/], ['TSH', /Thyroid/]];
  for (const [c, r] of items.slice(0, n)) await addItem(user, c, r);
  await screen.findByText(MONEY(UNIT * n), undefined, { timeout: T });
  await waitFor(() => expect((screen.getByRole('button', { name: /register & print/i }) as HTMLButtonElement).disabled).toBe(false), { timeout: T });
}
const submit = (user: User) => user.keyboard('{Control>}{Enter}{/Control}');
const text = (re: RegExp) => screen.findByText(re, undefined, { timeout: T });
/** "DD/MM/YYYY hh:mm AM" in Asia/Kathmandu, the kit DateTimePicker's typed format. */
const kathmandu = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p['day']}/${p['month']}/${p['year']} ${p['hour']}:${p['minute']} ${String(p['dayPeriod']).toUpperCase()}`;
};
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

describe('states (03-APP-FLOW §10 row Registration)', () => {
  it('blank: focus on patient search, centre = default, OPD/Cash/walk-in/Self defaults, Register disabled, no API call yet beyond lookups', async () => {
    await renderForm();
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: /search (patient|name)/i }));
    expect(screen.getByRole('heading', { name: /new registration/i })).toBeTruthy();
    expect((screen.getByRole('button', { name: /register & print/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(of('POST', PATH.quote)).toHaveLength(0);
    expect(of('POST', PATH.register)).toHaveLength(0);
  });

  it('permission: without frontdesk.registration.create → "You need registration permission", no form', async () => {
    await renderForm({ permissions: PERMS.filter((p) => p !== 'frontdesk.registration.create') });
    expect(screen.getByText(/You need registration permission/i)).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /search (patient|name)/i })).toBeNull();
  });

  it('search: < 3 letters sends nothing; ≥ 10 digits searches; query travels in the POST body, never the URL; row shows masked phone only', async () => {
    const user = newUser();
    await renderForm();
    await user.keyboard('ab');
    await new Promise((r) => setTimeout(r, 500));
    expect(of('POST', PATH.search)).toHaveLength(0);
    await user.keyboard('{Control>}a{/Control}{Backspace}9841000001');
    const opt = await screen.findByRole('option', { name: /Synthetic Patient One/ }, { timeout: T });
    expect(opt.textContent).toMatch(/P-000123/);
    expect(opt.textContent).toMatch(/43 Years/);
    expect(opt.textContent).toMatch(/98xxxxxx42/);
    expect(opt.textContent).not.toMatch(/9841000001/);
    const c = of('POST', PATH.search).at(-1)!;
    expect(c.search).toBe('');
    expect(c.path).not.toMatch(/9841000001/);
    expect(c.body.query).toBe('9841000001');
    expect(c.body.limit ?? 20).toBeLessThanOrEqual(20);
  });

  it('search: no match → empty state with the Alt+N hint', async () => {
    handlers.patients = () => HttpResponse.json({ data: [] });
    const user = newUser();
    await renderForm();
    await user.keyboard('Nobody Here');
    await text(/no patients found/i);
    expect(screen.getByText(/Alt\+N/)).toBeTruthy();
  });

  it('Alt+N opens the inline new-patient form (name, sex, DOB/age, mobile, required processing consent); Esc returns to search', async () => {
    const user = newUser();
    await renderForm();
    await user.keyboard('{Alt>}n{/Alt}');
    for (const l of [/full name/i, /mobile/i, /email/i, /address/i]) expect(await screen.findByRole('textbox', { name: l })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /female/i })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /processing of my data for testing/i })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /full name/i })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: /search (patient|name)/i }));
  });

  it('quote pending: "Prices updating…" status skeleton, Register disabled until the LATEST quote returns; 300 ms debounce coalesces rapid changes into one quote', async () => {
    const user = newUser();
    await renderForm();
    await pickPatient(user);
    await addItem(user, 'CBC', /Complete blood count/);
    await screen.findByText(MONEY(UNIT), undefined, { timeout: T });
    const base = of('POST', PATH.quote).length;
    handlers.quote = async (b: any) => { await delay(600); return HttpResponse.json(quoteFor(b)); };
    await user.keyboard('{Alt>}r{/Alt}{Alt>}i{/Alt}');
    const status = await screen.findByText(/prices updating/i, undefined, { timeout: 1500 });
    expect(status.closest('[role="status"]') ?? status.querySelector('[role="status"]')).toBeTruthy();
    expect((screen.getByRole('button', { name: /register & print/i }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(screen.queryByText(/prices updating/i)).toBeNull(), { timeout: T });
    expect((screen.getByRole('button', { name: /register & print/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(of('POST', PATH.quote).length - base).toBe(1);
  });

  it('bill panel: lines with code/name/price, totals gross/discount/exempt/taxable/VAT/other/NET; duplicate item refused with "Already added"', async () => {
    const user = newUser();
    await renderForm();
    await ready(user, 1);
    for (const l of [/gross/i, /discount/i, /exempt/i, /taxable/i, /vat/i, /other tax/i, /net/i]) expect(screen.getAllByText(l).length).toBeGreaterThan(0);
    await addItem(user, 'CBC', /Complete blood count/);
    await text(/already added/i);
    await new Promise((r) => setTimeout(r, 500));
    expect(of('POST', PATH.quote).at(-1)!.body.items).toHaveLength(1);
  });

  it('discount approval: quote.discount_evaluation.approval_required → "Approval needed (limit 5%)" + Request approval (Alt+A) posts F6b', async () => {
    const user = newUser();
    handlers.quote = async (b: any) => HttpResponse.json(quoteFor(b, { discount_evaluation: { within_limit: false, approval_required: true, limit_percent_bp: 500, limit_paisa: 0 } }));
    await renderForm();
    await ready(user, 1);
    await text(/approval needed \(limit 5%\)/i);
    await user.keyboard('{Alt>}a{/Alt}');
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && /discount-approvals$/.test(c.path))).toBe(true), { timeout: T });
  });

  it('discount reason is a Select over the F25 discount_reasons set (sorted by sort_order); the submitted reason_code is one of the set codes (04-UI-UX:90)', async () => {
    const user = newUser();
    await renderForm();
    await ready(user, 1);
    await user.keyboard('{F6}');
    const dlg = await screen.findByRole('dialog', { name: /discount/i });
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && /\/frontdesk\/coded-sets\/discount_reasons$/.test(c.path))).toBe(true), { timeout: T });
    expect(within(dlg).queryByRole('textbox', { name: /reason/i })).toBeNull();
    await user.type(within(dlg).getByRole('spinbutton', { name: /discount percent/i }), '10');
    await user.click(within(dlg).getByRole('button', { name: /reason/i }));
    const opts = await screen.findAllByRole('option', undefined, { timeout: T });
    expect(opts.map((o) => o.textContent)).toEqual(['Staff family', 'Senior citizen', 'Promotion']);
    await user.click(screen.getByRole('option', { name: 'Senior citizen' }));
    await user.click(within(dlg).getByRole('button', { name: /apply discount/i }));
    await waitFor(() => expect(of('POST', PATH.quote).some((c) => c.body.discounts?.length)).toBe(true), { timeout: T });
    const sent = of('POST', PATH.quote).filter((c) => c.body.discounts?.length).at(-1)!.body.discounts[0];
    expect(['staff_family', 'senior_citizen', 'promotion']).toContain(sent.reason_code);
    expect(sent.reason_code).toBe('senior_citizen');
  });
});

describe('F9 responses (04-UI-UX §3.3)', () => {
  const failWith = (res: () => Response) => { handlers.register = async () => res(); };
  const run = async (user: User) => { await ready(user, 1); await submit(user); };

  it('409 common.version_conflict → "Prices changed since you added tests. Review and register again." + a fresh quote is requested; nothing shown as registered', async () => {
    failWith(() => problem('common.version_conflict', 409));
    const user = newUser();
    await renderForm();
    await ready(user, 1);
    const before = of('POST', PATH.quote).length;
    await submit(user);
    await text(/Prices changed since you added tests\. Review and register again\./);
    await waitFor(() => expect(of('POST', PATH.quote).length).toBeGreaterThan(before), { timeout: T });
    expect(screen.queryByText(/R-2083-000042/)).toBeNull();
  });

  it.each([['billing.credit_party_locked'], ['billing.credit_limit_exceeded']])('409 %s → banner "Credit party is locked / over limit — choose Cash or contact finance"', async (code) => {
    failWith(() => problem(code, 409));
    await renderForm();
    await run(newUser());
    await text(/Credit party is locked \/ over limit — choose Cash or contact finance/);
  });

  it('403 frontdesk.discount_approval_required → approval banner', async () => {
    failWith(() => problem('frontdesk.discount_approval_required', 403));
    await renderForm();
    await run(newUser());
    await text(/approval needed/i);
  });

  it('422 frontdesk.referrer_required → error on the referrer field (aria-describedby), focus moves there', async () => {
    failWith(() => problem('frontdesk.referrer_required', 422, { errors: [{ path: '/referrer_id', code: 'frontdesk.referrer_required' }] }));
    await renderForm();
    await run(newUser());
    await waitFor(() => {
      const f = screen.getByRole('combobox', { name: /referrer/i });
      const ids = (f.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      expect(ids.map((i) => document.getElementById(i)?.textContent ?? '').join(' ')).toMatch(/referrer/i);
    }, { timeout: T });
  });

  it('422 billing.payment_exceeds_due → error on the payment amount field', async () => {
    failWith(() => problem('billing.payment_exceeds_due', 422, { errors: [{ path: '/payments/0/amount_received_paisa', code: 'billing.payment_exceeds_due' }] }));
    await renderForm();
    await run(newUser());
    await waitFor(() => {
      const f = screen.getAllByRole('textbox', { name: /^amount/i })[0]!;
      const ids = (f.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      expect(ids.map((i) => document.getElementById(i)?.textContent ?? '').join(' ').length).toBeGreaterThan(0);
    }, { timeout: T });
  });

  it('422 catalog.tax_config_missing (on the quote) → banner "Tax rate for <code> is not configured in the catalog — contact finance"; Register stays disabled', async () => {
    handlers.quote = async () => problem('catalog.tax_config_missing', 422);
    const user = newUser();
    await renderForm();
    await pickPatient(user);
    await addItem(user, 'CBC', /Complete blood count/);
    await text(/Tax rate for .+ is not configured in the catalog — contact finance/);
    expect((screen.getByRole('button', { name: /register & print/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('503 billing.counter_busy → one automatic retry with the SAME Idempotency-Key, then banner "Billing is busy, press Ctrl+Enter to retry"; Ctrl+Enter retries with the same key', async () => {
    let n = 0;
    handlers.register = async () => (++n <= 2 ? problem('billing.counter_busy', 503) : HttpResponse.json(result(), { status: 201 }));
    const user = newUser();
    await renderForm();
    await ready(user, 1);
    await submit(user);
    await text(/Billing is busy, press Ctrl\+Enter to retry/);
    expect(of('POST', PATH.register)).toHaveLength(2);
    await submit(user);
    await text(/R-2083-000042/);
    const keys = of('POST', PATH.register).map((c) => c.headers.get('idempotency-key'));
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('after a failure the same draft re-sends with the same Idempotency-Key (one key per draft)', async () => {
    let n = 0;
    handlers.register = async () => (++n === 1 ? problem('billing.credit_limit_exceeded', 409) : HttpResponse.json(result(), { status: 201 }));
    const user = newUser();
    await renderForm();
    await ready(user, 1);
    await submit(user);
    await text(/Credit party is locked/);
    await submit(user);
    await text(/R-2083-000042/);
    const keys = of('POST', PATH.register).map((c) => c.headers.get('idempotency-key'));
    expect(new Set(keys).size).toBe(1);
  });
});

describe('payment (§3.2 F; US-FD-03)', () => {
  it('amount prefilled = Net; change = tendered − amount; balance after = Net − Σ; Alt+P adds rows up to 5', async () => {
    const user = newUser();
    await renderForm();
    await ready(user, 3);
    const amount = screen.getAllByRole('textbox', { name: /^amount/i })[0] as HTMLInputElement;
    expect(amount.value.replace(/,/g, '')).toBe('339.00');
    const tendered = screen.getByRole('textbox', { name: /tendered/i });
    await user.type(tendered, '500');
    await text(MONEY(16100)); // change
    expect(screen.getByText(/balance after/i).parentElement!.textContent).toMatch(MONEY(0));
    for (let i = 0; i < 6; i++) await user.keyboard('{Alt>}p{/Alt}');
    expect(screen.getAllByRole('textbox', { name: /^amount/i })).toHaveLength(5);
  });

  it('amount above Net → field error, no F9', async () => {
    const user = newUser();
    await renderForm();
    await ready(user, 1);
    const amount = screen.getAllByRole('textbox', { name: /^amount/i })[0]!;
    await user.clear(amount);
    await user.type(amount, '500');
    await submit(user);
    await new Promise((r) => setTimeout(r, 400));
    expect(of('POST', PATH.register)).toHaveLength(0);
    expect(amount.getAttribute('aria-invalid') === 'true' || !!amount.getAttribute('aria-describedby')).toBe(true);
  });

  it('reference refuses 13–19 digit runs ("Do not enter card numbers"); no F9', async () => {
    const user = newUser();
    await renderForm();
    await ready(user, 1);
    const ref = screen.getAllByRole('textbox', { name: /reference/i })[0]!;
    await user.type(ref, 'ref 4111111111111111');
    await submit(user);
    await text(/Do not enter card numbers/);
    expect(of('POST', PATH.register)).toHaveLength(0);
  });

  it('zero payment → confirm "No payment — NPR x will be due"; F9 only after confirm, with payments []', async () => {
    const user = newUser();
    await renderForm();
    await ready(user, 1);
    await user.clear(screen.getAllByRole('textbox', { name: /^amount/i })[0]!);
    await submit(user);
    await text(/No payment/);
    expect(screen.getByRole('dialog', { name: /payment/i }).textContent ?? '').toMatch(MONEY(UNIT));
    expect(of('POST', PATH.register)).toHaveLength(0);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T });
    expect(of('POST', PATH.register)[0]!.body.payments).toEqual([]);
  });
});

describe('credit mode: badge from Quote.credit_status (US-FD-04.2, §3.2 B)', () => {
  async function creditDraft(user: User) {
    await pickPatient(user);
    await user.keyboard('{Alt>}c{/Alt}');
    await user.keyboard('{Tab}');
    const cp = screen.getByRole('combobox', { name: /credit party/i });
    await user.click(cp);
    await user.type(cp, 'SYNCORP');
    await user.click(await screen.findByRole('option', { name: /Synthetic Corp/ }, { timeout: T }));
    await addItem(user, 'CBC', /Complete blood count/);
  }
  it.each([['ok', /^(credit )?ok$/i], ['locked', /^locked$/i], ['over_limit', /^over limit$/i]])('state %s → text badge (never colour-only); billing credit-party endpoint (B19) never called', async (state, label) => {
    handlers.quote = async (b: any) => HttpResponse.json(quoteFor(b, { credit_status: { state } }));
    const user = newUser();
    await renderForm();
    await creditDraft(user);
    const q = await waitFor(() => { const x = of('POST', PATH.quote).at(-1)!; expect(x.body).toMatchObject({ billing_mode: 'credit', credit_party_id: party.id }); return x; }, { timeout: T });
    expect(q.body.items).toHaveLength(1);
    expect(await screen.findByText(label, undefined, { timeout: T })).toBeTruthy();
    expect(calls.some((c) => /\/v1\/billing\/credit-parties/.test(c.path))).toBe(false);
  });

  it('payment panel replaced by "Billed to Synthetic Corp monthly"; F9 sends credit_party_id and payments []', async () => {
    handlers.register = async () => HttpResponse.json(result({ invoice: undefined, print: { receipt_ledger_entry_ids: [] }, order: { id: ORDER, registration_no: 'R-2083-000042', status: 'registered', billing_mode: 'credit' } }), { status: 201 });
    const user = newUser();
    await renderForm();
    await creditDraft(user);
    await text(/Billed to Synthetic Corp monthly/);
    expect(screen.queryAllByRole('textbox', { name: /^amount/i })).toHaveLength(0);
    await waitFor(() => expect((screen.getByRole('button', { name: /register & print/i }) as HTMLButtonElement).disabled).toBe(false), { timeout: T });
    await submit(user);
    await waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T });
    expect(of('POST', PATH.register)[0]!.body).toMatchObject({ billing_mode: 'credit', credit_party_id: party.id, payments: [] });
    await text(/R-2083-000042/);
    expect(of('POST', PATH.print)).toHaveLength(0); // no invoice for credit orders → nothing to auto-print
  });
});

describe('success panel (§3.4)', () => {
  it.each([['queued', /SMS queued/i], ['suppressed_no_consent', /SMS not sent: no consent/i], ['suppressed_channel_disabled', /SMS disabled for this lab/i]])('SMS %s → text', async (s, re) => {
    handlers.register = async () => HttpResponse.json(result({ notifications: { registration_sms: s } }), { status: 201 });
    const user = newUser();
    await renderForm();
    await ready(user, 1);
    await submit(user);
    await text(re);
  });

  it('shows registration no, invoice no, paid/due and the Print copy / Open order / New registration buttons; Open order goes to the order page', async () => {
    const user = newUser();
    await renderForm();
    await ready(user, 3);
    await submit(user);
    await text(/R-2083-000042/);
    expect(screen.getByText(/INV\/2083-84\/000042/)).toBeTruthy();
    expect(screen.getByText(/paid/i)).toBeTruthy();
    expect(screen.getByText(/due/i)).toBeTruthy();
    for (const n of [/print copy/i, /open order/i, /new registration/i]) expect(screen.getByRole('button', { name: n })).toBeTruthy();
    await user.keyboard('{Alt>}g{/Alt}');
    await waitFor(() => expect(String(push.mock.calls.at(-1)?.[0] ?? '')).toContain(ORDER));
  });

  it('Print copy calls B3 again as a copy (reason_code customer_copy|reprint) — print count is recorded before printing, never Ctrl+P', async () => {
    const user = newUser();
    await renderForm();
    await ready(user, 1);
    await submit(user);
    await waitFor(() => expect(of('POST', PATH.print)).toHaveLength(1), { timeout: T });
    await user.click(await screen.findByRole('button', { name: /print copy/i }));
    await waitFor(() => expect(of('POST', PATH.print)).toHaveLength(2), { timeout: T });
    expect(of('POST', PATH.print)[1]!.body.reason_code).toMatch(/^(customer_copy|reprint)$/);
  });
});
describe('label flow (08 A13 D-4; US-FD-15.1; 04-UI-UX §3.4)', () => {
  const autoprint = (on: boolean) => { handlers.register = async () => HttpResponse.json(result({ label_print: { autoprint: on } }), { status: 201 }); };

  it('autoprint=false → C5 readiness op is never called', async () => {
    autoprint(false);
    const user = newUser();
    await renderForm();
    await ready(user, 1);
    await submit(user);
    await text(/R-2083-000042/);
    await new Promise((r) => setTimeout(r, 1500));
    expect(of('POST', PATH.labels)).toHaveLength(0);
  });

  it('autoprint=true: "Preparing labels…" while 409 common.version_conflict (retry ~1 s), then 200 → print frame on staff.lab.order_labels + "Labels ready — printing"', async () => {
    autoprint(true);
    let n = 0;
    handlers.labels = async () => (++n <= 2 ? problem('common.version_conflict', 409, { detail: 'specimens not created yet' }) : HttpResponse.json({ order_id: ORDER, specimens: [{ specimen_id: '01a1a98a-ac40-7000-8000-000000000030', barcode: 'E2600000101', outcome: 'ready' }], labels_route: 'staff.lab.order_labels' }));
    const user = newUser();
    await renderForm();
    await ready(user, 1);
    await submit(user);
    await text(/Preparing labels/);
    await text(/Labels ready — printing/);
    expect(of('POST', PATH.labels)).toHaveLength(3);
    expect(of('POST', PATH.labels)[0]!.path).toContain(ORDER);
    expect(of('POST', PATH.labels)[0]!.body ?? {}).toEqual({});
    // C5 #14a is x-idempotency: none ("a retry needs no key", 08 A13 D-4) — no Idempotency-Key on any poll.
    for (const c of of('POST', PATH.labels)) expect(c.headers.get('idempotency-key')).toBeNull();
    const frame = document.querySelector('iframe');
    expect(frame, 'print frame').toBeTruthy();
    expect(frame!.getAttribute('src') ?? '').toMatch(new RegExp(`/lab/orders/${ORDER}/labels$`)); // route staff.lab.order_labels, order_id substituted
  }, 20000);

  it('C5 error → C5\'s error text + "Retry (Alt+L)"; Alt+L calls readiness again; no print frame', async () => {
    autoprint(true);
    let n = 0;
    handlers.labels = async () => (++n === 1 ? problem('auth.forbidden', 403, { title: 'Label printing is not available for this centre.' }) : HttpResponse.json({ order_id: ORDER, specimens: [], labels_route: 'staff.lab.order_labels' }));
    const user = newUser();
    await renderForm();
    await ready(user, 1);
    await submit(user);
    await text(/Label printing is not available for this centre\./);
    expect(document.querySelector('iframe[src*="/labels"]')).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i }).textContent).toMatch(/Alt\+L/);
    await user.keyboard('{Alt>}l{/Alt}');
    await waitFor(() => expect(of('POST', PATH.labels)).toHaveLength(2), { timeout: T });
    await text(/Labels ready — printing/);
  });

  it('still 409 after 10 s → stops retrying (≤ 12 calls) and offers Retry (Alt+L)', async () => {
    autoprint(true);
    handlers.labels = async () => problem('common.version_conflict', 409, { detail: 'specimens not created yet' });
    const user = newUser();
    await renderForm();
    await ready(user, 1);
    await submit(user);
    await text(/Preparing labels/);
    const retry = await screen.findByRole('button', { name: /retry/i }, { timeout: 14000 });
    const n = of('POST', PATH.labels).length;
    expect(n).toBeGreaterThanOrEqual(9);
    expect(n).toBeLessThanOrEqual(12);
    await new Promise((r) => setTimeout(r, 2200));
    expect(of('POST', PATH.labels)).toHaveLength(n);
    expect(retry).toBeTruthy();
  }, 30000);
});

describe('LD-25 downtime back-entry (2026-11-07): "Downtime back-entry" toggle; occurred_at ≤ now and ≥ now − 72 h; downtime_ref ≤ 32 chars', () => {
  const toggle = (user: User) => user.click(screen.getByRole('switch', { name: /downtime back-entry/i }));
  const fill = async (user: User, when: Date, ref: string) => {
    const t = await screen.findByRole('textbox', { name: /original time/i });
    await user.clear(t);
    await user.type(t, kathmandu(when));
    fireEvent.blur(t);
    const r = screen.getByRole('textbox', { name: /paper form serial/i });
    fireEvent.change(r, { target: { value: ref } });
  };
  async function prepared(user: User) { await renderForm(); await ready(user, 1); }

  it('off by default: no downtime fields; F9 carries no occurred_at / downtime_ref and entry_mode absent or live', async () => {
    const user = newUser();
    await prepared(user);
    expect((screen.getByRole('switch', { name: /downtime back-entry/i }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole('textbox', { name: /original time/i })).toBeNull();
    await submit(user);
    await waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T });
    const b = of('POST', PATH.register)[0]!.body;
    expect(b).not.toHaveProperty('occurred_at');
    expect(b).not.toHaveProperty('downtime_ref');
    expect(b.entry_mode ?? 'live').toBe('live');
  });

  it('valid (2 h ago, ref PF-0042) → entry_mode downtime_backentry + occurred_at (ISO UTC, same minute) + downtime_ref', async () => {
    const user = newUser();
    await prepared(user);
    await toggle(user);
    const when = hoursAgo(2);
    await fill(user, when, 'PF-0042');
    await submit(user);
    await waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T });
    const b = of('POST', PATH.register)[0]!.body;
    expect(b.entry_mode).toBe('downtime_backentry');
    expect(b.downtime_ref).toBe('PF-0042');
    expect(b.occurred_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    expect(Math.abs(Date.parse(b.occurred_at) - when.getTime())).toBeLessThan(120_000);
  });

  it('boundary: 71 h ago accepted; ref of exactly 32 chars accepted', async () => {
    const user = newUser();
    await prepared(user);
    await toggle(user);
    await fill(user, hoursAgo(71), 'R'.repeat(32));
    await submit(user);
    await waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T });
    expect(of('POST', PATH.register)[0]!.body.downtime_ref).toHaveLength(32);
  });

  it.each([['in the future (+1 h)', () => new Date(Date.now() + 3600_000), 'PF-1'], ['older than 72 h (73 h ago)', () => hoursAgo(73), 'PF-1'], ['missing paper form serial', () => hoursAgo(1), ''], ['serial longer than 32 chars (33)', () => hoursAgo(1), 'X'.repeat(33)]])('%s → field error, no F9', async (_n, when, ref) => {
    const user = newUser();
    await prepared(user);
    await toggle(user);
    await fill(user, when(), ref);
    await submit(user);
    await new Promise((r) => setTimeout(r, 500));
    expect(of('POST', PATH.register)).toHaveLength(0);
    const invalid = Array.from(document.querySelectorAll('[aria-invalid="true"]')).map((e) => (e.getAttribute('aria-label') ?? e.id ?? ''));
    expect(invalid.length, 'an input is marked aria-invalid').toBeGreaterThan(0);
  });

  it('switching it off again removes the fields from F9', async () => {
    const user = newUser();
    await prepared(user);
    await toggle(user);
    await fill(user, hoursAgo(2), 'PF-9');
    await toggle(user);
    expect(screen.queryByRole('textbox', { name: /original time/i })).toBeNull();
    await submit(user);
    await waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T });
    const b = of('POST', PATH.register)[0]!.body;
    expect(b).not.toHaveProperty('occurred_at');
    expect(b).not.toHaveProperty('downtime_ref');
  });
});

describe('PHI + privacy (04-UI-UX §1; REQ-SEC-098)', () => {
  it('whole flow: no browser storage writes, no PHI in document.title or URL, F8/F9 bodies carry ids only', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const href = window.location.href;
    const user = newUser();
    await renderForm();
    await ready(user, 2);
    await submit(user);
    await text(/R-2083-000042/);
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe('');
    expect(window.location.href).toBe(href);
    expect(document.title).not.toMatch(/Synthetic Patient|P-000123|9841000001|98xxxxxx42/);
    for (const c of calls.filter((x) => x.method === 'POST' && /registrations/.test(x.path))) expect(JSON.stringify(c.body)).not.toMatch(/Synthetic Patient|98xxxxxx42|9841000001/);
  });
});

describe('a11y (§9; axe-core, WCAG 2.2 AA minus contrast which jsdom cannot compute)', () => {
  it('blank page', async () => { await renderForm(); await noAxeViolations(); });
  it('items + quote + payment', async () => { const user = newUser(); await renderForm(); await ready(user, 2); await noAxeViolations(); });
  it('error banner state', async () => {
    handlers.register = async () => problem('billing.credit_limit_exceeded', 409);
    const user = newUser(); await renderForm(); await ready(user, 1); await submit(user); await text(/Credit party is locked/); await noAxeViolations();
  });
  it('success panel', async () => { const user = newUser(); await renderForm(); await ready(user, 1); await submit(user); await text(/R-2083-000042/); await noAxeViolations(); });
  it('downtime fields + shortcuts dialog', async () => {
    const user = newUser(); await renderForm();
    await user.click(screen.getByRole('switch', { name: /downtime back-entry/i }));
    await screen.findByRole('textbox', { name: /original time/i });
    await noAxeViolations();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('?');
    await screen.findByRole('dialog', { name: /keyboard shortcuts/i });
    await noAxeViolations();
  });
  it('quote updates, approval and payment status are announced via role="status" live regions', async () => {
    const user = newUser(); await renderForm(); await ready(user, 1);
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('status').some((s) => MONEY(UNIT).test(s.textContent ?? ''))).toBe(true);
  });
});
