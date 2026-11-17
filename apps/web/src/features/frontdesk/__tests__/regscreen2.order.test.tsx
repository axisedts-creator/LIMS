// @vitest-environment jsdom
// T0D-REGSCREEN-2 — group 2 of the backend backed items: the ORDER side (collection, More fold texts, insurance, ICD per test, coupon, card holder, visiting charge, reward points, number preview).
// done_when (1) + (4); contracts T0C-REGPARITY-2 (CreateRegistrationRequest, RegistrationDraft = the F8 quote input, PaymentInput, RegistrationNumberPreview, PatientRewards, IcdCode). Harness: fd-t13.harness.tsx (MSW + `reg2`).
// CONTRACT the writer follows or disputes. Labels are RegExp, case-insensitive; "More" is the existing fold button (aria-expanded, aria-controls) and tests open it before they look for anything that may live in it.
//  - Collection: "Collection date and time" (kit DateTimePicker textbox, typed DD/MM/YYYY hh:mm AM in Asia/Kathmandu, like "Original time") -> collection_at (ISO UTC; ABSENT when untouched; a future time is refused with a message),
//    "Collected by" textbox (free text, max 200) -> collected_by_name, switch "Sample not collected" -> sample_not_collected:true and then "Sample remark" (required, max 500) -> sample_remark. All four are absent from F9 when unused.
//  - Inside the More fold (done_when 1, fixed): "Clinical history" and "Patient history" (textareas, max 4000), "MR number" (max 64). Elsewhere on the screen (fold or not): "External reference" (64), "Insurance code" (64), "Insurance claim amount" (MoneyField).
//    F9 keys: clinical_history, patient_history, mr_number, external_reference, insurance_code, insurance_claim_amount_paisa. Health text is D-27a: never in the quote (F8), console, storage, URL.
//  - ICD: each row of the "Selected tests" table has a Combobox "<CODE> ICD code" fed by GET /v1/frontdesk/icd-codes (ACTIVE codes only; free text that is not in the master is not accepted) and a button whose name matches /apply .*to all/i
//    that copies that row's code to every row. icd_code rides in items[] of BOTH the quote and F9; absent when none.
//  - Coupon: textbox "Coupon code" + button "Apply coupon"; the code is upper cased and checked against the contract pattern; it is sent as coupon_code in the quote and F9. The server decides validity (front desk may not list coupons):
//    a quote refused with an error at /coupon_code leaves the "Applied coupons" list empty and shows the message; an accepted one lists "<CODE>" with the amount = quote totals.discount (money text) and a button "Remove coupon <CODE>".
//  - Payment row: "Card holder name" (max 100; only while the method is Card) and "Payment remark" (max 300) -> payments[i].card_holder_name / payment_remark; a name typed under Card is dropped when the method changes to Cash.
//  - "Visiting charge" MoneyField -> visiting_charge_paisa (quote AND F9; absent when empty or 0).
//  - Rewards: after an existing patient is picked and the actor has frontdesk.patient.read, GET /v1/frontdesk/patients/:id/rewards -> text "Reward points" with the balance and integer field "Redeem points" (max = balance, error naming "balance" above it)
//    -> redeem_reward_points in quote and F9. A new patient, no permission, or a failed read: no field, no noise.
//  - Number preview: read-only outputs/textboxes "Next lab number" and "Next bill receipt number" from GET /v1/frontdesk/registrations/number-preview?centre_id=<selected laboratory>, plus the label text the API returns
//    ("Assigned when saved"); refetched when the laboratory changes; never sent in F9; an empty receipt number shows no "null"/"undefined".
//  - UI-only values never reach the wire; F8 carries only RegistrationDraft keys, F9 only CreateRegistrationRequest keys.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CENTRE, HttpResponse, MONEY, ORIGIN, PATH, PERMS, UNIT, U, api, calls, handlers, http, npr, of, problem, quoteFor, renderForm, reg2, setup } from './fd-t13.harness';

setup();
const T = 4000;
const user = () => userEvent.setup({ delay: null });
type User = ReturnType<typeof user>;
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const QUOTE_KEYS = ['patient', 'centre_id', 'visit_type', 'billing_mode', 'credit_party_id', 'referrer_id', 'priority', 'collection_mode', 'items', 'discounts', 'buyer_pan', 'coupon_code', 'visiting_charge_paisa', 'redeem_reward_points'];
const F9_KEYS = [...QUOTE_KEYS, 'quote_fingerprint', 'payments', 'trf_attachment_ids', 'discount_approval_id', 'collection_at', 'collected_by_membership_id', 'collected_by_name', 'sample_not_collected', 'sample_remark', 'remark_description',
  'clinical_history', 'patient_history', 'mr_number', 'external_reference', 'insurance_code', 'insurance_claim_amount_paisa', 'entry_mode', 'occurred_at', 'downtime_ref'];
const PAY_KEYS = ['method_code', 'amount_received_paisa', 'reference', 'tendered_paisa', 'card_holder_name', 'payment_remark'];
const kathmandu = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p['day']}/${p['month']}/${p['year']} ${p['hour']}:${p['minute']} ${String(p['dayPeriod']).toUpperCase()}`;
};
const kinded = [{ id: CENTRE, name: 'Synthetic Lab A1', kind: 'own' }, { id: U(7), name: 'Synthetic Lab B2', kind: 'own' }];
const form = (extra: Record<string, unknown> = {}) => renderForm({ centres: kinded, ...extra });

async function patientPicked(u: User) {
  await u.keyboard('{F2}9841000001');
  await u.click(await screen.findByRole('option', { name: /Synthetic Patient One/ }, { timeout: T }));
}
async function addTest(u: User, code: 'CBC' | 'TSH' | 'LIPID' = 'CBC', name: RegExp = /Complete blood count/) {
  await u.keyboard(`{F4}${code}`);
  await u.click(await screen.findByRole('option', { name }, { timeout: T }));
}
const net = (n = 1) => waitFor(() => expect(screen.getAllByText(MONEY(UNIT * n)).length).toBeGreaterThan(0), { timeout: T });
/** Existing patient + one CBC + a settled quote. */
async function ready(u: User) { await patientPicked(u); await addTest(u); await net(); }
const openMore = async (u: User) => {
  const more = screen.getByRole('button', { name: /^more/i });
  if (more.getAttribute('aria-expanded') !== 'true') await u.click(more);
  return document.getElementById(more.getAttribute('aria-controls') ?? '__none__') as HTMLElement;
};
const submit = async (u: User) => { await u.keyboard('{Control>}{Enter}{/Control}'); await waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T }); return of('POST', PATH.register)[0]!.body; };
const lastQuote = () => of('POST', PATH.quote).at(-1)!.body;
const choose = async (u: User, label: RegExp, option: string | RegExp) => { await u.click(screen.getByRole('button', { name: label })); await u.click(await screen.findByRole('option', { name: option })); };

describe('collection details', () => {
  it('Collection date and time + Collected by are sent as collection_at (ISO UTC, the typed minute in Kathmandu) and collected_by_name', async () => {
    const u = user();
    await form();
    await ready(u);
    const when = new Date(Date.now() - 2 * 3600_000);
    const t = screen.getByRole('textbox', { name: /collection date and time/i });
    await u.clear(t); await u.type(t, kathmandu(when)); fireEvent.blur(t);
    await u.type(screen.getByRole('textbox', { name: /collected by/i }), 'Synthetic Runner');
    // ruling 1: after a successful F9 the SuccessPanel replaces the form, so check maxlength before submit
    expect(Number((screen.getByRole('textbox', { name: /collected by/i }) as HTMLInputElement).getAttribute('maxlength'))).toBe(200);
    const b = await submit(u);
    expect(b.collection_at.slice(0, 16)).toBe(when.toISOString().slice(0, 16));
    expect(b.collected_by_name).toBe('Synthetic Runner');
  });

  it('untouched: none of collection_at, collected_by_name, sample_not_collected, sample_remark is sent', async () => {
    const u = user();
    await form();
    await ready(u);
    const b = await submit(u);
    for (const k of ['collection_at', 'collected_by_name', 'collected_by_membership_id', 'sample_not_collected', 'sample_remark']) expect(b, k).not.toHaveProperty(k);
  });

  it('a collection time in the future is refused with a message and nothing is sent', async () => {
    const u = user();
    await form();
    await ready(u);
    const t = screen.getByRole('textbox', { name: /collection date and time/i });
    await u.clear(t); await u.type(t, kathmandu(new Date(Date.now() + 48 * 3600_000))); fireEvent.blur(t);
    await u.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByText(/collection .*future|future/i, undefined, { timeout: T })).toBeTruthy();
    await settle();
    expect(of('POST', PATH.register)).toHaveLength(0);
  });

  it('Sample not collected asks for a remark (required, max 500) and sends sample_not_collected:true with sample_remark', async () => {
    const u = user();
    await form();
    await ready(u);
    expect(screen.queryAllByLabelText(/sample remark/i)).toHaveLength(0);
    await u.click(screen.getByRole('switch', { name: /sample not collected/i }));
    const remark = await screen.findByRole('textbox', { name: /sample remark/i });
    expect(remark.hasAttribute('required') || remark.getAttribute('aria-required') === 'true').toBe(true);
    expect(Number(remark.getAttribute('maxlength'))).toBe(500);
    await u.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByText(/sample remark/i, { selector: '[role="alert"], [id$="-error"], [data-error], p, span' })).toBeTruthy();
    await settle();
    expect(of('POST', PATH.register)).toHaveLength(0);
    await u.type(remark, 'Patient fainted, recollect tomorrow');
    const b = await submit(u);
    expect(b).toMatchObject({ sample_not_collected: true, sample_remark: 'Patient fainted, recollect tomorrow' });
  });

  it('turning the switch off again drops the remark from the request', async () => {
    const u = user();
    await form();
    await ready(u);
    await u.click(screen.getByRole('switch', { name: /sample not collected/i }));
    await u.type(await screen.findByRole('textbox', { name: /sample remark/i }), 'x');
    await u.click(screen.getByRole('switch', { name: /sample not collected/i }));
    const b = await submit(u);
    expect(b).not.toHaveProperty('sample_remark');
    expect(b.sample_not_collected === undefined || b.sample_not_collected === false).toBe(true);
  });
});

describe('More fold: histories, MR number, external reference, insurance', () => {
  it('Clinical history, Patient history and MR number live inside the More fold (hidden until opened)', async () => {
    const u = user();
    await form();
    const more = screen.getByRole('button', { name: /^more/i });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    const region = document.getElementById(more.getAttribute('aria-controls') ?? '__none__')!;
    expect(region.hidden || region.closest('[hidden]') !== null || region.getAttribute('aria-hidden') === 'true').toBe(true);
    await u.click(more);
    for (const l of [/clinical history/i, /patient history/i, /mr number/i]) expect(within(region).getByLabelText(l), String(l)).toBeTruthy();
  });

  it('all six texts are sent as contract keys (clinical_history, patient_history, mr_number, external_reference, insurance_code, insurance_claim_amount_paisa) and nothing else leaves the allow list', async () => {
    const u = user();
    await form();
    await ready(u);
    await openMore(u);
    await u.type(screen.getByLabelText(/clinical history/i), 'Fever for three days');
    await u.type(screen.getByLabelText(/patient history/i), 'Known asthma');
    await u.type(screen.getByLabelText(/mr number/i), 'MR-7788');
    await u.type(screen.getByLabelText(/external reference/i), 'EXT-55');
    await u.type(screen.getByLabelText(/insurance code/i), 'INS-9');
    await u.type(screen.getByLabelText(/insurance claim amount/i), '250');
    fireEvent.blur(screen.getByLabelText(/insurance claim amount/i));
    const b = await submit(u);
    expect(b).toMatchObject({ clinical_history: 'Fever for three days', patient_history: 'Known asthma', mr_number: 'MR-7788', external_reference: 'EXT-55', insurance_code: 'INS-9', insurance_claim_amount_paisa: 25000 });
    expect(Object.keys(b).filter((k) => !F9_KEYS.includes(k)), 'keys outside CreateRegistrationRequest').toEqual([]);
  });

  it('empty fields are absent (never ""), and the maxima match the contract (4000, 4000, 64, 64, 64)', async () => {
    const u = user();
    await form();
    await ready(u);
    await openMore(u);
    const max = (rx: RegExp) => Number(screen.getByLabelText(rx).getAttribute('maxlength'));
    expect([max(/clinical history/i), max(/patient history/i), max(/mr number/i), max(/external reference/i), max(/insurance code/i)]).toEqual([4000, 4000, 64, 64, 64]);
    const b = await submit(u);
    for (const k of ['clinical_history', 'patient_history', 'mr_number', 'external_reference', 'insurance_code', 'insurance_claim_amount_paisa']) expect(b, k).not.toHaveProperty(k);
  });

  it('health text (D-27a) is never in the quote, console, storage or URL; only F9 carries it', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const u = user();
    await form();
    await ready(u);
    await openMore(u);
    await u.type(screen.getByLabelText(/clinical history/i), 'SECRETCLINICAL');
    await u.type(screen.getByLabelText(/patient history/i), 'SECRETHISTORY');
    await settle(600);
    await submit(u);
    for (const q of of('POST', PATH.quote)) expect(Object.keys(q.body).filter((k) => !QUOTE_KEYS.includes(k)), 'F8 body keys').toEqual([]);
    expect(calls.filter((c) => /SECRET(CLINICAL|HISTORY)/.test(JSON.stringify(c.body ?? '') + c.search)).map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/frontdesk/registrations']);
    expect(spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c))).filter((l) => /SECRET(CLINICAL|HISTORY)/.test(l))).toEqual([]);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(/SECRET(CLINICAL|HISTORY)/);
    expect(window.location.href).not.toMatch(/SECRET/);
  });

  it('MR number and the patient External patient ID are two different things: typing the MR number adds no patient field', async () => {
    const u = user();
    await form();
    await ready(u);
    await openMore(u);
    await u.type(screen.getByLabelText(/mr number/i), 'MR-1');
    const b = await submit(u);
    expect(b.patient).toEqual({ patient_id: expect.any(String) });
  });
});

describe('ICD code per test, with apply to all', () => {
  const rows = () => within(screen.getByRole('table', { name: /selected tests/i }));
  async function twoTests(u: User) {
    await patientPicked(u);
    await addTest(u, 'CBC');
    await net(1);
    await addTest(u, 'TSH', /Thyroid stimulating hormone/);
    await net(2);
  }
  const pick = async (u: User, code: string, icd: RegExp) => {
    const cb = rows().getByRole('combobox', { name: new RegExp(`^${code} icd code`, 'i') });
    await u.click(cb); await u.type(cb, icd.source.replace(/\\/g, '').slice(0, 3));
    await u.click(await screen.findByRole('option', { name: icd }, { timeout: T }));
  };

  it('the codes come from the ICD master (active only); picking one for CBC sends icd_code on that item in the quote and in F9, the other item has none', async () => {
    reg2.icd = [...(reg2.icd as any[]), { id: U(79), code: 'Z99', description: 'Retired code', is_active: false, version: 1 }];
    const u = user();
    await form();
    await twoTests(u);
    await waitFor(() => expect(of('GET', /icd-codes$/).length).toBeGreaterThan(0), { timeout: T });
    const cb = rows().getByRole('combobox', { name: /^CBC icd code/i });
    await u.click(cb); await u.type(cb, 'A');
    const opts = (await screen.findAllByRole('option', undefined, { timeout: T })).map((o) => o.textContent ?? '');
    expect(opts.some((o) => /A09/.test(o) && /Gastroenteritis/.test(o))).toBe(true);
    expect(opts.some((o) => /Z99/.test(o))).toBe(false);
    await u.click(screen.getByRole('option', { name: /A09/ }));
    await waitFor(() => expect(lastQuote().items.find((i: any) => i.orderable_id !== undefined && i.icd_code)?.icd_code).toBe('A09'), { timeout: T });
    const b = await submit(u);
    expect(b.items.filter((i: any) => i.icd_code === 'A09')).toHaveLength(1);
    expect(b.items.filter((i: any) => !('icd_code' in i))).toHaveLength(1);
  });

  it('"Apply to all" copies the row ICD code to every row (quote and F9)', async () => {
    const u = user();
    await form();
    await twoTests(u);
    await pick(u, 'CBC', /E11\.9/);
    await u.click(rows().getAllByRole('button', { name: /apply .*to all/i })[0]!);
    await waitFor(() => expect(lastQuote().items.map((i: any) => i.icd_code)).toEqual(['E11.9', 'E11.9']), { timeout: T });
    const b = await submit(u);
    expect(b.items.map((i: any) => i.icd_code)).toEqual(['E11.9', 'E11.9']);
  });

  it('text that is not in the master is not accepted: no option, no icd_code on the wire', async () => {
    const u = user();
    await form();
    await ready(u);
    const cb = screen.getByRole('combobox', { name: /^CBC icd code/i });
    await u.click(cb); await u.type(cb, 'QQQ');
    await settle();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    const b = await submit(u);
    expect(b.items.every((i: any) => !('icd_code' in i))).toBe(true);
  });

  it('removing a test removes its ICD code with it; a quote body item carries only orderable_id, priority and icd_code', async () => {
    const u = user();
    await form();
    await twoTests(u);
    await pick(u, 'CBC', /A09/);
    await u.click(screen.getByRole('button', { name: /^remove CBC/i }));
    await waitFor(() => expect(lastQuote().items).toHaveLength(1), { timeout: T });
    expect(lastQuote().items[0]).not.toHaveProperty('icd_code');
    for (const i of lastQuote().items) expect(Object.keys(i).filter((k) => !['orderable_id', 'priority', 'icd_code'].includes(k))).toEqual([]);
  });
});

describe('coupon', () => {
  const withCoupon = () => { handlers.quote = async (b: any) => {
    if (b.coupon_code === 'BADCODE') return problem('common.validation_failed', 400, { title: 'Coupon is not valid', errors: [{ path: '/coupon_code', code: 'common.validation_failed' }] });
    const q = quoteFor(b);
    return HttpResponse.json(b.coupon_code === 'WELCOME10' ? { ...q, totals: { ...q.totals, discount: npr(1130), net: npr(q.totals.net.amount_paisa - 1130) } } : q);
  }; };
  const apply = async (u: User, code: string) => { await u.type(screen.getByRole('textbox', { name: /coupon code/i }), code); await u.click(screen.getByRole('button', { name: /apply coupon/i })); };

  it('an accepted coupon is upper cased, sent in the quote and F9, listed with its code and amount, and the net follows the server quote', async () => {
    withCoupon();
    const u = user();
    await form();
    await ready(u);
    await apply(u, 'welcome10');
    await waitFor(() => expect(lastQuote().coupon_code).toBe('WELCOME10'), { timeout: T });
    const list = await screen.findByRole('list', { name: /applied coupons/i }, { timeout: T });
    expect(within(list).getByText(/WELCOME10/)).toBeTruthy();
    expect(within(list).getByText(MONEY(1130))).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText(MONEY(UNIT - 1130)).length).toBeGreaterThan(0), { timeout: T });
    expect((await submit(u)).coupon_code).toBe('WELCOME10');
  });

  it('a coupon the server refuses is not listed, the message is shown, and coupon_code is not sent in F9', async () => {
    withCoupon();
    const u = user();
    await form();
    await ready(u);
    await apply(u, 'BADCODE');
    expect((await screen.findAllByText(/coupon is not valid/i, undefined, { timeout: T })).length).toBeGreaterThan(0);
    const list = screen.queryByRole('list', { name: /applied coupons/i });
    expect(list === null || within(list).queryAllByRole('listitem').length === 0).toBe(true);
    // the refused code is not kept in the request: clearing it lets the quote settle and the order register without it
    await u.clear(screen.getByRole('textbox', { name: /coupon code/i }));
    await waitFor(() => expect(lastQuote()).not.toHaveProperty('coupon_code'), { timeout: T });
    expect(await submit(u)).not.toHaveProperty('coupon_code');
  });

  it('Remove coupon takes it out of the list and out of the next quote', async () => {
    withCoupon();
    const u = user();
    await form();
    await ready(u);
    await apply(u, 'WELCOME10');
    await u.click(await screen.findByRole('button', { name: /remove coupon WELCOME10/i }, { timeout: T }));
    await waitFor(() => expect(lastQuote()).not.toHaveProperty('coupon_code'), { timeout: T });
    expect(screen.queryByText(/WELCOME10/)).toBeNull();
    expect(await submit(u)).not.toHaveProperty('coupon_code');
  });

  it('a code outside the contract pattern is refused on the spot (no quote carries it)', async () => {
    const u = user();
    await form();
    await ready(u);
    await apply(u, 'bad code!');
    expect((await screen.findAllByText(/coupon/i, { selector: '[role="alert"], [id$="-error"], [data-error], p, span' })).length).toBeGreaterThan(0);
    await settle();
    expect(of('POST', PATH.quote).some((q) => 'coupon_code' in q.body)).toBe(false);
    expect(Number(screen.getByRole('textbox', { name: /coupon code/i }).getAttribute('maxlength'))).toBe(32);
  });
});

describe('payment: card holder name and payment remark', () => {
  it('Card shows "Card holder name"; the name and the remark go to payments[0]; keys stay inside PaymentInput', async () => {
    const u = user();
    await form();
    await ready(u);
    expect(screen.queryAllByLabelText(/card holder name/i)).toHaveLength(0);
    await choose(u, /^(?!add method).*method/i, 'Card');
    await u.type(await screen.findByRole('textbox', { name: /card holder name/i }), 'Synthetic Holder');
    await u.type(screen.getByRole('textbox', { name: /payment remark/i }), 'POS slip 118');
    await u.type(screen.getByRole('textbox', { name: /^reference/i }), 'AUTH-1');
    // ruling 1: maxlength checked before submit (the form is replaced by the SuccessPanel after F9)
    expect(Number(screen.getByRole('textbox', { name: /card holder name/i }).getAttribute('maxlength'))).toBe(100);
    expect(Number(screen.getByRole('textbox', { name: /payment remark/i }).getAttribute('maxlength'))).toBe(300);
    const b = await submit(u);
    expect(b.payments[0]).toMatchObject({ method_code: 'card', card_holder_name: 'Synthetic Holder', payment_remark: 'POS slip 118', reference: 'AUTH-1' });
    expect(Object.keys(b.payments[0]).filter((k) => !PAY_KEYS.includes(k))).toEqual([]);
  });

  it('a card holder name typed under Card is NOT sent after the method is changed back to Cash', async () => {
    const u = user();
    await form();
    await ready(u);
    await choose(u, /^(?!add method).*method/i, 'Card');
    await u.type(await screen.findByRole('textbox', { name: /card holder name/i }), 'Synthetic Holder');
    await choose(u, /^(?!add method).*method/i, 'Cash');
    expect(screen.queryAllByLabelText(/card holder name/i)).toHaveLength(0);
    const b = await submit(u);
    expect(b.payments[0]).toMatchObject({ method_code: 'cash' });
    expect(b.payments[0]).not.toHaveProperty('card_holder_name');
  });

  it('the card holder name (personal data) is never logged, stored in the browser, or put into the quote', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const u = user();
    await form();
    await ready(u);
    await choose(u, /^(?!add method).*method/i, 'Card');
    await u.type(await screen.findByRole('textbox', { name: /card holder name/i }), 'SECRETHOLDER');
    await settle(600);
    await submit(u);
    expect(calls.filter((c) => JSON.stringify(c.body ?? '').includes('SECRETHOLDER')).map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/frontdesk/registrations']);
    expect(spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c))).filter((l) => l.includes('SECRETHOLDER'))).toEqual([]);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('SECRETHOLDER');
  });

  it('without a remark or name the keys are absent', async () => {
    const u = user();
    await form();
    await ready(u);
    const b = await submit(u);
    expect(b.payments[0]).not.toHaveProperty('payment_remark');
    expect(b.payments[0]).not.toHaveProperty('card_holder_name');
  });
});

describe('visiting charge', () => {
  it('"Visiting charge" is sent as visiting_charge_paisa in the quote and F9; the net comes from the server quote; empty or 0 sends nothing', async () => {
    handlers.quote = async (b: any) => { const q = quoteFor(b); const v = b.visiting_charge_paisa ?? 0; return HttpResponse.json({ ...q, totals: { ...q.totals, net: npr(q.totals.net.amount_paisa + v) } }); };
    const u = user();
    await form();
    await ready(u);
    expect(lastQuote()).not.toHaveProperty('visiting_charge_paisa');
    const f = screen.getByLabelText(/visiting charge/i);
    await u.type(f, '150'); fireEvent.blur(f);
    await waitFor(() => expect(lastQuote().visiting_charge_paisa).toBe(15000), { timeout: T });
    await waitFor(() => expect(screen.getAllByText(MONEY(UNIT + 15000)).length).toBeGreaterThan(0), { timeout: T });
    expect((await submit(u)).visiting_charge_paisa).toBe(15000);
  });

  it('clearing the field removes the key again', async () => {
    const u = user();
    await form();
    await ready(u);
    const f = screen.getByLabelText(/visiting charge/i);
    await u.type(f, '90'); fireEvent.blur(f);
    await waitFor(() => expect(lastQuote().visiting_charge_paisa).toBe(9000), { timeout: T });
    await u.clear(f); fireEvent.blur(f);
    await waitFor(() => expect(lastQuote()).not.toHaveProperty('visiting_charge_paisa'), { timeout: T });
    expect(await submit(u)).not.toHaveProperty('visiting_charge_paisa');
  });
});

describe('reward points', () => {
  const redeem = () => screen.getByRole('spinbutton', { name: /redeem points/i }) as HTMLInputElement;

  it('after an existing patient is picked the balance shows and the rewards read is made once, for that patient only', async () => {
    const u = user();
    await form();
    expect(of('GET', /\/rewards$/)).toHaveLength(0);
    await patientPicked(u);
    expect(await screen.findByText(/reward points/i, undefined, { timeout: T })).toBeTruthy();
    expect((await screen.findAllByText(/\b120\b/, undefined, { timeout: T })).length).toBeGreaterThan(0);
    expect(of('GET', /\/patients\/[^/]+\/rewards$/)).toHaveLength(1);
  });

  it('Redeem points is sent as redeem_reward_points in the quote and F9; 0 or empty sends nothing', async () => {
    const u = user();
    await form();
    await ready(u);
    await screen.findByText(/reward points/i, undefined, { timeout: T });
    expect(lastQuote()).not.toHaveProperty('redeem_reward_points');
    await u.type(redeem(), '50'); fireEvent.blur(redeem());
    await waitFor(() => expect(lastQuote().redeem_reward_points).toBe(50), { timeout: T });
    expect((await submit(u)).redeem_reward_points).toBe(50);
  });

  it('more points than the balance is refused with a message naming the balance; Register waits; nothing is sent', async () => {
    const u = user();
    await form();
    await ready(u);
    await screen.findByText(/reward points/i, undefined, { timeout: T });
    await u.type(redeem(), '121'); fireEvent.blur(redeem());
    expect((await screen.findAllByText(/balance/i, undefined, { timeout: T })).length).toBeGreaterThan(0);
    await u.keyboard('{Control>}{Enter}{/Control}');
    await settle();
    expect(of('POST', PATH.register)).toHaveLength(0);
    expect(of('POST', PATH.quote).some((q) => q.body.redeem_reward_points === 121)).toBe(false);
  });

  it('no frontdesk.patient.read: no rewards call and no field; a failed read: no field and no alert', async () => {
    const u = user();
    await form({ permissions: PERMS.filter((p) => p !== 'frontdesk.patient.read') });
    await u.keyboard('{F2}9841000001');
    await u.click(await screen.findByRole('option', { name: /Synthetic Patient One/ }, { timeout: T }));
    await settle();
    expect(of('GET', /\/rewards$/)).toHaveLength(0);
    expect(screen.queryAllByLabelText(/redeem points/i)).toHaveLength(0);
  });

  it('a rewards read that fails shows nothing and does not block registering', async () => {
    api.use(http.get(`${ORIGIN}/v1/frontdesk/patients/:id/rewards`, () => problem('common.internal', 500)));
    const u = user();
    await form();
    await ready(u);
    await settle();
    expect(screen.queryAllByLabelText(/redeem points/i)).toHaveLength(0);
    expect(screen.queryAllByRole('alert').filter((a) => (a.textContent ?? '').trim()), 'a visible alert').toEqual([]); // the page keeps one EMPTY role=alert live region
    await submit(u);
  });

  it('a NEW patient has no rewards: no read, no field', async () => {
    const u = user();
    await form();
    await u.keyboard('{Alt>}n{/Alt}');
    await screen.findByRole('textbox', { name: /full name/i });
    await settle();
    expect(of('GET', /\/rewards$/)).toHaveLength(0);
    expect(screen.queryAllByLabelText(/redeem points/i)).toHaveLength(0);
  });
});

describe('lab number and bill receipt number preview (clearly the NEXT number)', () => {
  it('shows the next lab number and next bill receipt number read only, with the API label; reads once for the default laboratory', async () => {
    await form();
    const lab = (await screen.findByLabelText(/next lab number/i, undefined, { timeout: T })) as HTMLInputElement;
    await waitFor(() => expect(lab.value ?? lab.textContent).toBe('R-2083-000124'), { timeout: T });
    const rc = screen.getByLabelText(/next bill receipt number/i) as HTMLInputElement;
    expect(rc.value ?? rc.textContent).toBe('2083/84-000077');
    for (const el of [lab, rc]) expect(el.readOnly === true || el.getAttribute('aria-readonly') === 'true' || el.tagName === 'OUTPUT').toBe(true);
    expect(screen.getAllByText(/assigned when saved/i).length).toBeGreaterThan(0);
    expect(of('GET', /number-preview$/)).toHaveLength(1);
    expect(new URLSearchParams(of('GET', /number-preview$/)[0]!.search).get('centre_id')).toBe(CENTRE);
  });

  it('changing the laboratory reads the preview again for that centre', async () => {
    const u = user();
    await form();
    await screen.findByLabelText(/next lab number/i, undefined, { timeout: T });
    await choose(u, /laboratory/i, 'Synthetic Lab B2');
    await waitFor(() => expect(of('GET', /number-preview$/).map((c) => new URLSearchParams(c.search).get('centre_id'))).toContain(U(7)), { timeout: T });
  });

  it('the previewed numbers are never sent in F9 or the quote', async () => {
    const u = user();
    await form();
    await ready(u);
    await screen.findByLabelText(/next lab number/i);
    await submit(u);
    expect(calls.filter((c) => /R-2083-000124|2083\/84-000077/.test(JSON.stringify(c.body ?? ''))).map((c) => c.path)).toEqual([]);
  });

  it('an empty receipt number (API fallback) shows no null/undefined text and still the "Assigned when saved" label', async () => {
    reg2.preview = { next_registration_no: 'R-2083-000124', next_receipt_no: '', next_receipt_no_label: 'Assigned when saved' };
    await form();
    await screen.findByLabelText(/next bill receipt number/i, undefined, { timeout: T });
    await settle();
    expect(document.body.textContent).not.toMatch(/\bnull\b|\bundefined\b/);
    expect(screen.getAllByText(/assigned when saved/i).length).toBeGreaterThan(0);
  });

  it('a failed preview read shows no alert and the form still registers', async () => {
    api.use(http.get(`${ORIGIN}/v1/frontdesk/registrations/number-preview`, () => problem('common.internal', 500)));
    const u = user();
    await form();
    await ready(u);
    await settle();
    expect(screen.queryAllByRole('alert').filter((a) => (a.textContent ?? '').trim()), 'a visible alert').toEqual([]); // the page keeps one EMPTY role=alert live region
    await submit(u);
  });
});
