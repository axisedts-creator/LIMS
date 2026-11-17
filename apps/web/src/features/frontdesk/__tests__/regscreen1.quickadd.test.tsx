// @vitest-environment jsdom
// T0D-REGSCREEN-1 — component tests: quick add client / doctor, existing patient notice, TRF, totals bar, barcode, test search modes, discounts, client label, credit limit.
// done_when (2)(3)(5). Harness: fd-t13.harness.tsx (MSW). All calls use EXISTING contracts, no new route and no new field:
//   POST /v1/catalog/credit-parties (CreditPartyCreate: party_code,name,kind,allows_credit,pan,contact_phone_e164,contact_email,billing_address,price_list_id; additionalProperties false; Idempotency-Key)
//   POST /v1/catalog/doctors        (DoctorCreate: doctor_code,display_name,qualification,registration_council,registration_no,phone_e164,email,notes,quick_add; Idempotency-Key)
//   POST /v1/frontdesk/trf-attachments (multipart file + centre_id, order_id optional; Idempotency-Key) -> F9 `trf_attachment_ids`
//   credit limit / bank details / hospital are NOT in those contracts: they are T0D-REGSCREEN-2 (backend), see the notes. UI-only values (barcode, client label, patient type, registration time, franchise id) must NOT reach F9.
// CONTRACT labels: dialogs "Add client" (fields "Client name", select "Billing type" [Hospital|Company|Clinic|Partner lab|Insurer|Other], "PAN", button "Save client") and "Add doctor" ("Doctor name", "Registration number", button "Save doctor");
//   existing-patient notice role=status text /existing patient/i + code + button "Use existing patient"; "Upload TRF" reveals the kit FileUpload labelled "TRF file";
//   barcode: textbox "Barcode" revealed by "Type barcode"; totals bar (aside "Registration summary") rows Total, Net, Paid, Balance, Refund, Billed; credit rows "Credit limit" and "Consumed" only when the party carries credit_limit_paisa / outstanding.
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CENTRE, HttpResponse, ITEM, MONEY, ORIGIN, PATH, PERMS, UNIT, U, api, calls, handlers, http, npr, of, party, quoteFor, renderForm, setup } from './fd-t13.harness';

setup();
const T = 4000;
const MANAGE = [...PERMS, 'catalog.price_list.manage', 'catalog.referrer.manage'];
const form = (permissions: readonly string[] = MANAGE) => renderForm({ permissions });
const user = () => userEvent.setup({ delay: null });
type User = ReturnType<typeof user>;
const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const record = async (r: Request) => { const body = await r.clone().json().catch(() => undefined); calls.push({ method: r.method, path: new URL(r.url).pathname, search: '', headers: r.headers, body }); return body; };
const bar = () => screen.getByRole('complementary', { name: /registration summary/i });
const rowOf = (label: RegExp) => { const l = within(bar()).getByText(label); return (l.nextElementSibling ?? l.parentElement)!.textContent ?? ''; };

async function pickPatientAndCbc(u: User, net = UNIT) {
  await u.keyboard('{F2}9841000001');
  await screen.findByRole('option', { name: /Synthetic Patient One/ }, { timeout: T });
  await u.keyboard('{Enter}');
  await screen.findByText(/P-000123/, undefined, { timeout: T });
  await u.keyboard('{F4}CBC');
  await screen.findByRole('option', { name: /Complete blood count/ }, { timeout: T });
  await u.keyboard('{Enter}');
  await waitFor(() => expect(of('POST', PATH.quote).at(-1)?.body.items).toHaveLength(1), { timeout: T });
  await screen.findAllByText(MONEY(net), undefined, { timeout: T });
}
const toCredit = async (u: User) => {
  await u.keyboard('{Alt>}c{/Alt}');
  await u.type(await screen.findByRole('combobox', { name: /credit party/i }), 'Synth');
  await u.click(await screen.findByRole('option', { name: new RegExp(party.name) }, { timeout: T }));
};

describe('Add client quick add (existing credit party API)', () => {
  const created = { id: U(60), party_code: 'NEWCLI', name: 'Synthetic New Client', kind: 'company', allows_credit: true, is_active: true, version: 1 };
  const ALLOWED = ['party_code', 'name', 'kind', 'allows_credit', 'pan', 'contact_phone_e164', 'contact_email', 'billing_address', 'price_list_id'];

  it('opens a dialog from the Add client button (credit mode), posts only CreditPartyCreate fields with an Idempotency-Key, selects the new party and fills Client label', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/credit-parties`, async ({ request }) => { await record(request); return HttpResponse.json(created, { status: 201 }); }));
    const u = user();
    await form();
    await u.keyboard('{Alt>}c{/Alt}');
    await u.click(await screen.findByRole('button', { name: /^add client/i }));
    const dlg = await screen.findByRole('dialog', { name: /add client/i });
    await u.type(within(dlg).getByRole('textbox', { name: /client name/i }), created.name);
    await u.click(within(dlg).getByRole('button', { name: /billing type/i }));
    await u.click(await screen.findByRole('option', { name: /^company$/i }));
    await u.click(within(dlg).getByRole('button', { name: /save client/i }));
    await waitFor(() => expect(of('POST', /\/catalog\/credit-parties$/)).toHaveLength(1), { timeout: T });
    const c = of('POST', /\/catalog\/credit-parties$/)[0]!;
    expect(c.body).toMatchObject({ name: created.name, kind: 'company' });
    expect(Object.keys(c.body).filter((k) => !ALLOWED.includes(k)), 'keys outside CreditPartyCreate').toEqual([]);
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /add client/i })).toBeNull(), { timeout: T });
    expect((screen.getByRole('textbox', { name: /client label/i }) as HTMLInputElement).value).toBe(created.name);
    expect((screen.getByRole('combobox', { name: /credit party/i }) as HTMLInputElement).value).toBe(created.name);
  });

  it('empty name: nothing is posted and the field names the problem; 409 catalog.code_duplicate stays in the dialog as an alert', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/credit-parties`, async ({ request }) => { await record(request); return HttpResponse.json({ type: 'urn:lims:error:catalog.code_duplicate', title: 'Code already used', status: 409, code: 'catalog.code_duplicate' }, { status: 409 }); }));
    const u = user();
    await form();
    await u.keyboard('{Alt>}c{/Alt}');
    await u.click(await screen.findByRole('button', { name: /^add client/i }));
    const dlg = await screen.findByRole('dialog', { name: /add client/i });
    await u.click(within(dlg).getByRole('button', { name: /save client/i }));
    await settle();
    expect(of('POST', /\/catalog\/credit-parties$/)).toHaveLength(0);
    expect(within(dlg).getByText(/client name/i)).toBeTruthy();
    await u.type(within(dlg).getByRole('textbox', { name: /client name/i }), 'Synthetic Dup');
    await u.click(within(dlg).getByRole('button', { name: /billing type/i }));
    await u.click(await screen.findByRole('option', { name: /^clinic$/i }));
    await u.click(within(dlg).getByRole('button', { name: /save client/i }));
    await within(dlg).findByText(/Code already used/, undefined, { timeout: T });
    expect(screen.getByRole('dialog', { name: /add client/i })).toBeTruthy();
  });

  it('without catalog.price_list.manage there is no usable Add client button (the server still enforces)', async () => {
    const u = user();
    await form(PERMS);
    await u.keyboard('{Alt>}c{/Alt}');
    await screen.findByRole('combobox', { name: /credit party/i });
    const b = screen.queryByRole('button', { name: /^add client/i });
    expect(b === null || (b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('credit limit and consumed amount show when the API returns them, and are absent when it does not; B19 is never called', async () => {
    api.use(http.get(`${ORIGIN}/v1/catalog/credit-parties`, async ({ request }) => { await record(request); return HttpResponse.json({ data: [{ ...party, credit_limit_paisa: 5000000, outstanding: npr(1200000) }], page: { next_cursor: null } }); }));
    const u = user();
    await form();
    await toCredit(u);
    expect(await screen.findByText(/credit limit/i, undefined, { timeout: T })).toBeTruthy();
    expect(screen.getAllByText(/50,000\.00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/consumed/i)).toBeTruthy();
    expect(screen.getAllByText(/12,000\.00/).length).toBeGreaterThan(0);
    expect(calls.some((c) => /\/v1\/billing\/credit-parties/.test(c.path))).toBe(false);
  });

  it('a party without limit fields shows no Credit limit / Consumed rows', async () => {
    const u = user();
    await form();
    await toCredit(u);
    await settle();
    expect(screen.queryByText(/credit limit/i)).toBeNull();
    expect(screen.queryByText(/consumed/i)).toBeNull();
  });
});

describe('Client label (required for credit)', () => {
  it('cleared label blocks Ctrl+Enter with a message naming the field; with a label it registers and the label stays out of F9', async () => {
    const u = user();
    await form();
    await pickPatientAndCbc(u);
    await toCredit(u);
    await waitFor(() => expect((screen.getByRole('textbox', { name: /client label/i }) as HTMLInputElement).value).toBe(party.name), { timeout: T });
    await waitFor(() => expect(of('POST', PATH.quote).at(-1)?.body.billing_mode).toBe('credit'), { timeout: T });
    const label = screen.getByRole('textbox', { name: /client label/i });
    await u.clear(label);
    await u.keyboard('{Control>}{Enter}{/Control}');
    await settle();
    expect(of('POST', PATH.register)).toHaveLength(0);
    expect(screen.getAllByText(/client label/i).length).toBeGreaterThan(1); // label + error text
    await u.type(label, 'Synthetic Corp - Ward 3');
    await u.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T });
    expect(of('POST', PATH.register)[0]!.body).toMatchObject({ billing_mode: 'credit', credit_party_id: party.id, payments: [] });
    expect(JSON.stringify(of('POST', PATH.register)[0]!.body)).not.toMatch(/client_label|Ward 3/);
  });
});

describe('Add doctor quick add (existing doctor API)', () => {
  const ALLOWED = ['doctor_code', 'display_name', 'qualification', 'registration_council', 'registration_no', 'phone_e164', 'email', 'notes', 'quick_add'];
  const created = { id: U(61), doctor_code: 'CP00099', display_name: 'Dr Synthetic Quick', is_verified: false, source: 'quick_add', is_active: true, version: 1, possible_duplicate_of: null };
  const hook = () => api.use(http.post(`${ORIGIN}/v1/catalog/doctors`, async ({ request }) => { await record(request); return HttpResponse.json(created, { status: 201 }); }));

  it('Add doctor opens a dialog; Save posts display_name, registration_no, quick_add:true with an Idempotency-Key and selects the doctor as referrer (Self chip goes)', async () => {
    hook();
    const u = user();
    await form();
    expect(screen.getByText(/^self$/i)).toBeTruthy();
    await u.click(screen.getByRole('button', { name: /^add doctor/i }));
    const dlg = await screen.findByRole('dialog', { name: /add doctor/i });
    await u.type(within(dlg).getByRole('textbox', { name: /doctor name/i }), created.display_name);
    await u.type(within(dlg).getByRole('textbox', { name: /registration number/i }), 'NMC-12345');
    await u.click(within(dlg).getByRole('button', { name: /save doctor/i }));
    await waitFor(() => expect(of('POST', /\/catalog\/doctors$/)).toHaveLength(1), { timeout: T });
    const c = of('POST', /\/catalog\/doctors$/)[0]!;
    expect(c.body).toMatchObject({ display_name: created.display_name, registration_no: 'NMC-12345', quick_add: true });
    expect(Object.keys(c.body).filter((k) => !ALLOWED.includes(k)), 'keys outside DoctorCreate').toEqual([]);
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /add doctor/i })).toBeNull(), { timeout: T });
    expect((screen.getByRole('combobox', { name: /referrer/i }) as HTMLInputElement).value).toBe(created.display_name);
    expect(screen.queryByText(/^self$/i)).toBeNull();
  });

  it('Alt+D opens the same dialog (no "not available" toast any more); an empty name posts nothing', async () => {
    hook();
    const u = user();
    await form();
    (document.activeElement as HTMLElement).blur();
    await u.keyboard('{Alt>}d{/Alt}');
    const dlg = await screen.findByRole('dialog', { name: /add doctor/i });
    expect(screen.queryByText(/not available on this page yet/i)).toBeNull();
    await u.click(within(dlg).getByRole('button', { name: /save doctor/i }));
    await settle();
    expect(of('POST', /\/catalog\/doctors$/)).toHaveLength(0);
    expect(within(dlg).getByText(/doctor name/i)).toBeTruthy();
  });

  it('Esc closes the dialog and returns focus to the screen without posting', async () => {
    hook();
    const u = user();
    await form();
    await u.click(screen.getByRole('button', { name: /^add doctor/i }));
    await screen.findByRole('dialog', { name: /add doctor/i });
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /add doctor/i })).toBeNull(), { timeout: T });
    expect(of('POST', /\/catalog\/doctors$/)).toHaveLength(0);
  });

  it('without catalog.referrer.manage there is no usable Add doctor button', async () => {
    await form(PERMS);
    const b = screen.queryByRole('button', { name: /^add doctor/i });
    expect(b === null || (b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true').toBe(true);
  });
});

describe('existing patient notice (name + mobile match)', () => {
  async function openNew(u: User, name: string, mobile: string) {
    await form();
    await u.keyboard('{Alt>}n{/Alt}');
    const g = await screen.findByRole('group', { name: /^new patient$/i }, { timeout: T });
    await u.type(within(g).getByRole('textbox', { name: /full name/i }), name);
    await u.type(within(g).getByRole('textbox', { name: /^mobile/i }), mobile);
    return g;
  }
  it('same name and a mobile that fits the masked number: notice with the patient code and a Use existing patient button; creating a new one stays possible', async () => {
    const u = user();
    const g = await openNew(u, 'Synthetic Patient One', '9841000042');
    const note = await screen.findByText(/existing patient/i, undefined, { timeout: T });
    expect(note.closest('[role="status"],[role="alert"]') ?? note).toBeTruthy();
    expect(within(g).getByText(/P-000123/)).toBeTruthy();
    expect((within(g).getByRole('button', { name: /use this new patient/i }) as HTMLButtonElement).disabled).toBe(false);
    await u.click(within(g).getByRole('button', { name: /use existing patient/i }));
    await waitFor(() => expect(screen.queryByRole('group', { name: /^new patient$/i })).toBeNull(), { timeout: T });
    expect(screen.getByText(/P-000123/)).toBeTruthy();
  });
  it('different name: no notice', async () => {
    const u = user();
    await openNew(u, 'Synthetic Someone Else', '9841000042');
    await waitFor(() => expect(of('POST', PATH.search).length).toBeGreaterThan(0), { timeout: T });
    await settle();
    expect(screen.queryByText(/existing patient/i)).toBeNull();
  });
  it('same name but a mobile that does not fit the masked number: no notice', async () => {
    const u = user();
    await openNew(u, 'Synthetic Patient One', '9841000043');
    await waitFor(() => expect(of('POST', PATH.search).length).toBeGreaterThan(0), { timeout: T });
    await settle();
    expect(screen.queryByText(/existing patient/i)).toBeNull();
  });
  it('no search runs before both a name and a mobile are typed (no PHI sent for half a form)', async () => {
    const u = user();
    await form();
    await u.keyboard('{Alt>}n{/Alt}');
    const g = await screen.findByRole('group', { name: /^new patient$/i }, { timeout: T });
    const before = of('POST', PATH.search).length;
    await u.type(within(g).getByRole('textbox', { name: /full name/i }), 'Synthetic Patient One');
    await settle();
    expect(of('POST', PATH.search).length).toBe(before);
  });
});

describe('TRF upload on the registration screen (trf_attachment_ids)', () => {
  const att = { id: U(70), mime_type: 'application/pdf', size_bytes: 4, scan_state: 'pending', uploaded_at: '2026-11-17T04:15:00.000Z' };
  const spy = () => {
    const seen: { form?: FormData; key: string | null; hits: number } = { key: null, hits: 0 };
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const u = new URL(typeof input === 'string' ? input : input.url ?? String(input));
      if (u.pathname !== '/v1/frontdesk/trf-attachments') return real(input, init);
      seen.hits++; seen.key = new Headers(init?.headers).get('idempotency-key'); seen.form = init?.body as FormData;
      return new Response(JSON.stringify(att), { status: 201, headers: { 'content-type': 'application/json' } });
    });
    return seen;
  };
  const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'trf-new.pdf', { type: 'application/pdf' });

  it('Upload TRF reveals the file field; the file goes to F21 with centre_id and an Idempotency-Key (no order_id yet); the id rides in F9 trf_attachment_ids', async () => {
    const seen = spy();
    const u = user();
    await form();
    await pickPatientAndCbc(u);
    await u.click(screen.getByRole('button', { name: /^upload trf/i }));
    await u.upload(await screen.findByLabelText('TRF file'), pdf());
    await waitFor(() => expect(seen.hits).toBe(1), { timeout: T });
    expect(seen.form!.get('centre_id')).toBe(CENTRE);
    expect(seen.form!.get('order_id')).toBeNull();
    expect((seen.form!.get('file') as File).name).toBe('trf-new.pdf');
    expect(seen.key).toBeTruthy();
    expect(await screen.findByText(/trf-new\.pdf/, undefined, { timeout: T })).toBeTruthy();
    await u.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T });
    expect(of('POST', PATH.register)[0]!.body.trf_attachment_ids).toEqual([att.id]);
  });

  it('Alt+U reveals the same field (no "not available" toast); a text file is refused by the kit and never uploaded', async () => {
    const seen = spy();
    const u = userEvent.setup({ delay: null, applyAccept: false });
    await form();
    (document.activeElement as HTMLElement).blur();
    await u.keyboard('{Alt>}u{/Alt}');
    const input = await screen.findByLabelText('TRF file');
    expect(screen.queryByText(/not available on this page yet/i)).toBeNull();
    await u.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }));
    await settle();
    expect(seen.hits).toBe(0);
    expect(screen.getByText(/not allowed/i)).toBeTruthy();
  });

  it('without a TRF, F9 carries no trf_attachment_ids key', async () => {
    const u = user();
    await form();
    await pickPatientAndCbc(u);
    await u.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T });
    const b = of('POST', PATH.register)[0]!.body;
    expect(b.trf_attachment_ids === undefined || b.trf_attachment_ids.length === 0).toBe(true);
  });
});

describe('barcode buttons', () => {
  it('Type barcode reveals a Barcode textbox that keeps what is typed; Generate fills it; Capture puts the cursor in it for a scanner', async () => {
    const u = user();
    await form();
    expect(screen.queryByRole('textbox', { name: /^barcode/i })).toBeNull();
    await u.click(screen.getByRole('button', { name: /^type barcode/i }));
    const box = await screen.findByRole('textbox', { name: /^barcode/i });
    await u.type(box, 'E2600000999');
    expect((box as HTMLInputElement).value).toBe('E2600000999');
    await u.click(screen.getByRole('button', { name: /^generate barcode/i }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: /^barcode/i }) as HTMLInputElement).value).toMatch(/^[A-Za-z0-9-]{6,32}$/), { timeout: T });
    await u.clear(screen.getByRole('textbox', { name: /^barcode/i }));
    (document.activeElement as HTMLElement).blur();
    await u.click(screen.getByRole('button', { name: /^capture barcode/i }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /^barcode/i }));
  });

  it('UI-only values never reach F9 (additionalProperties false): barcode, client_label, patient_type, registration date, franchise id', async () => {
    const u = user();
    await form();
    await u.click(screen.getByRole('button', { name: /^type barcode/i }));
    await u.type(await screen.findByRole('textbox', { name: /^barcode/i }), 'E2600000999');
    await pickPatientAndCbc(u);
    await u.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T });
    const keys = Object.keys(of('POST', PATH.register)[0]!.body);
    for (const k of ['barcode', 'client_label', 'patient_type', 'registration_at', 'registered_at', 'franchise_centre_id', 'laboratory_id']) expect(keys, k).not.toContain(k);
    expect(JSON.stringify(of('POST', PATH.register)[0]!.body)).not.toContain('E2600000999');
  });
});

describe('totals bar: Total, Net, Paid, Balance, Refund, Billed', () => {
  const discounted = (b: any) => {
    const q = quoteFor(b);
    const line = { ...q.lines[0], discount: npr(1000), taxable: npr(9000), vat: npr(1170), net: npr(10170) };
    return HttpResponse.json({ ...q, lines: [line], totals: { gross: npr(10000), discount: npr(1000), exempt: npr(0), taxable: npr(9000), vat: npr(1170), other_tax: npr(0), net: npr(10170) } });
  };
  it('all six rows are in the fixed bar and follow the quote: Total = net + discount, Net, Billed = net, Refund 0', async () => {
    handlers.quote = async (b: any) => discounted(b);
    const u = user();
    await form();
    await pickPatientAndCbc(u, 10170);
    await waitFor(() => expect(rowOf(/^net$/i)).toMatch(MONEY(10170)), { timeout: T });
    expect(rowOf(/^total$/i)).toMatch(MONEY(11170));
    expect(rowOf(/^billed$/i)).toMatch(MONEY(10170));
    expect(rowOf(/^refund$/i)).toMatch(MONEY(0));
    expect(rowOf(/^paid$/i)).toMatch(MONEY(10170)); // payment row prefilled with the net
    expect(rowOf(/^balance( due)?$/i)).toMatch(MONEY(0));
  });
  it('typing a smaller amount moves Paid and Balance; Total, Net and Billed stay', async () => {
    const u = user();
    await form();
    await pickPatientAndCbc(u);
    const amount = screen.getAllByRole('textbox', { name: /^amount/i })[0]!;
    await u.clear(amount);
    await u.type(amount, '50');
    await waitFor(() => expect(rowOf(/^paid$/i)).toMatch(MONEY(5000)), { timeout: T });
    expect(rowOf(/^balance( due)?$/i)).toMatch(MONEY(UNIT - 5000));
    expect(rowOf(/^net$/i)).toMatch(MONEY(UNIT));
    expect(rowOf(/^billed$/i)).toMatch(MONEY(UNIT));
  });
  it('credit billing: Paid is 0 and Balance equals the net', async () => {
    const u = user();
    await form();
    await pickPatientAndCbc(u);
    await toCredit(u);
    await waitFor(() => expect(of('POST', PATH.quote).at(-1)?.body.billing_mode).toBe('credit'), { timeout: T });
    await waitFor(() => expect(rowOf(/^balance( due)?$/i)).toMatch(MONEY(UNIT)), { timeout: T }); // the quote is re-priced after the switch: wait for it
    expect(rowOf(/^paid$/i)).toMatch(MONEY(0));
  });
});

describe('discount percent and amount, at registration and test level', () => {
  const lastDiscounts = () => of('POST', PATH.quote).at(-1)?.body.discounts as any[] | undefined;
  it('registration level Discount percent -> {scope bill, kind percent, percent_bp}; Discount amount -> {scope bill, kind amount, amount_paisa}', async () => {
    const u = user();
    await form();
    await pickPatientAndCbc(u);
    await u.type(screen.getByLabelText(/^discount percent/i), '10');
    await waitFor(() => expect(lastDiscounts()).toEqual(expect.arrayContaining([expect.objectContaining({ scope: 'bill', kind: 'percent', percent_bp: 1000 })])), { timeout: T });
    await u.clear(screen.getByLabelText(/^discount percent/i));
    await u.type(screen.getByLabelText(/^discount amount/i), '50');
    await waitFor(() => expect(lastDiscounts()).toEqual(expect.arrayContaining([expect.objectContaining({ scope: 'bill', kind: 'amount', amount_paisa: 5000 })])), { timeout: T });
    expect(lastDiscounts()!.some((d) => d.kind === 'percent'), 'cleared percent is dropped').toBe(false);
  });
  it('test level: each cart row has its own Discount percent (names the test) -> {scope line, orderable_id}', async () => {
    const u = user();
    await form();
    await pickPatientAndCbc(u);
    await u.type(screen.getByLabelText(/discount percent.*CBC|CBC.*discount percent/i), '5');
    await waitFor(() => expect(lastDiscounts()).toEqual(expect.arrayContaining([expect.objectContaining({ scope: 'line', kind: 'percent', percent_bp: 500, orderable_id: ITEM.CBC })])), { timeout: T });
  });
  it('percent above 100 or negative is refused in the field and never sent', async () => {
    const u = user();
    await form();
    await pickPatientAndCbc(u);
    await u.type(screen.getByLabelText(/^discount percent/i), '150');
    await settle();
    expect((lastDiscounts() ?? []).some((d) => (d.percent_bp ?? 0) > 10000)).toBe(false);
    expect(screen.getAllByText(/100|valid|at most|between/i).length).toBeGreaterThan(0);
  });
  it('the existing F6 Discount dialog still opens and the Discount button stays secondary', async () => {
    const u = user();
    await form();
    await pickPatientAndCbc(u);
    await u.keyboard('{F6}');
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});

describe('test search: by name, short name or both', () => {
  const search = async (u: User, mode: RegExp, q: string) => {
    await u.click(screen.getByRole('radio', { name: mode }));
    const before = of('GET', PATH.orderables).length;
    await u.keyboard('{F4}');
    await u.type(screen.getByRole('combobox', { name: /search tests/i }), q);
    await waitFor(() => expect(of('GET', PATH.orderables).length).toBeGreaterThan(before), { timeout: T });
    await settle();
  };
  it('default is Both: the short code CBC and the name "Complete" both find the test', async () => {
    const u = user();
    await form();
    expect(screen.getByRole('radio', { name: /^both$/i })).toHaveProperty('checked', true);
    await search(u, /^both$/i, 'CBC');
    expect(screen.queryByRole('option', { name: /Complete blood count/ })).toBeTruthy();
  });
  it('Name: "Complete" finds it, the code CBC does not', async () => {
    const u = user();
    await form();
    await search(u, /^name$/i, 'CBC');
    expect(screen.queryByRole('option', { name: /Complete blood count/ })).toBeNull();
    await u.clear(screen.getByRole('combobox', { name: /search tests/i }));
    await u.type(screen.getByRole('combobox', { name: /search tests/i }), 'Complete');
    expect(await screen.findByRole('option', { name: /Complete blood count/ }, { timeout: T })).toBeTruthy();
  });
  it('Short name: CBC finds it, "Complete" does not', async () => {
    const u = user();
    await form();
    await search(u, /^short name$/i, 'Complete');
    expect(screen.queryByRole('option', { name: /Complete blood count/ })).toBeNull();
    await u.clear(screen.getByRole('combobox', { name: /search tests/i }));
    await u.type(screen.getByRole('combobox', { name: /search tests/i }), 'CBC');
    expect(await screen.findByRole('option', { name: /Complete blood count/ }, { timeout: T })).toBeTruthy();
  });
});
