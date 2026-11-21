// @vitest-environment jsdom
// T0D-REGSCREEN-2 — group 1 of the backend backed registration items: the NEW PATIENT block (LD-310; founder blanket authority 2026-11-17 05:03 NPT; contracts T0C-REGPARITY-1 + T0B-REGAPI-1).
// done_when (1) title, external patient id, nationality, Government ID (type + number) in place of Aadhaar and Passport, province district municipality ward tole postal code, profile photo,
// additional fields from the lab custom field definitions; (3) India only items (Aadhaar, ABHA, Health ID) are NOT added; (4) component tests per group. Harness: fd-t13.harness.tsx (MSW + `reg2`).
// CONTRACT the writer follows or disputes (every name below is a NewPatient / NewPatientDraft key of contracts/openapi/frontdesk.yaml; F9 carries them in patient.new_patient):
//  - The fields live in the inline new-patient form (Alt+N, role=group "New patient"), same place as Full name. Labels (RegExp, case-insensitive):
//      "Title" kit Select, 19 options in this order and spelling: Mr Mrs Miss Ms Master Baby "Baby of" Dr Prof Capt Col Major Sri Smt Kumari Late Sister Reverend Other  (value = lower snake_case code: mr ... baby_of ... other).
//      "External patient ID" textbox (max 64), "Nationality" kit Select (country name -> ISO 3166-1 alpha-2, e.g. Nepal -> NP),
//      "Government ID type" kit Select: Citizenship | National ID | Passport | Driving licence | Voter ID | Other (codes citizenship national_id passport driving_licence voter_id other),
//      "Government ID number" input type=password autocomplete=off (sensitive, LD-310 (b): masked on screen, never logged, never stored in the browser, never saved in a draft),
//      address as FREE TEXT (no master data endpoint exists in the contracts): "Province", "District", "Municipality", "Ward", "Tole", "Postal code" (comboboxes fed by a static list are also fine: the tests only type or pick by label).
//      "Profile photo" kit FileUpload (accept image/png,image/jpeg, at most 2 MiB; uploaded with the existing uploadTrf action: multipart file + centre_id, NO order_id; the returned id -> profile_photo_attachment_id),
//      button "Capture photo" (camera; disabled when navigator.mediaDevices.getUserMedia does not exist, as in jsdom).
//      Custom fields: one control per ACTIVE definition from GET /v1/frontdesk/custom-field-definitions, labelled with its `label` (text|number|date|choice -> textbox | spinbutton | date | Select), sent as patient.new_patient.custom_fields [{code: field_key, value}].
//  - Only keys of the NewPatient contract are sent (the 13 new + the old ones); nothing UI-only. Empty optional fields are ABSENT, never "" (contract minLength 1).
//  - Client side rules that mirror the server (no round trip needed): type and number together or neither; Nepal (NP) postal code = exactly 5 digits; required custom field must be filled. A refused form sends nothing.
//  - NOT built (done_when 3): no Aadhaar, ABHA, Health ID control anywhere, and no separate Passport field (Passport is one Government ID type).
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CENTRE, ORIGIN, PATH, U, api, calls, handlers, http, of, problem, renderForm, reg2, setup } from './fd-t13.harness';

setup();
const T = 4000;
const user = () => userEvent.setup({ delay: null });
type User = ReturnType<typeof user>;
const NEW_PATIENT_KEYS = ['full_name', 'sex', 'birth_on', 'age', 'phone_e164', 'email', 'address_text', 'title', 'external_patient_id', 'nationality', 'government_id_type', 'government_id_number', 'address_province',
  'address_district', 'address_municipality', 'address_ward', 'address_tole', 'address_postal_code', 'profile_photo_attachment_id', 'custom_fields', 'consents', 'duplicate_override'];
const GOV_NO = '27-01-71-04512'; // synthetic
const TITLES = ['Mr', 'Mrs', 'Miss', 'Ms', 'Master', 'Baby', 'Baby of', 'Dr', 'Prof', 'Capt', 'Col', 'Major', 'Sri', 'Smt', 'Kumari', 'Late', 'Sister', 'Reverend', 'Other'];
const png = (bytes = 8) => new File([new Uint8Array(bytes)], 'face.png', { type: 'image/png' });

const choose = async (u: User, label: RegExp, option: string | RegExp) => {
  await u.click(screen.getByRole('button', { name: label }));
  await u.click(await screen.findByRole('option', { name: option }));
};
const type = async (u: User, label: RegExp, v: string) => { const el = screen.getByRole('textbox', { name: label }); await u.clear(el); await u.type(el, v); };
/** Opens the new-patient form and fills the always required part. */
async function openNew(u: User) {
  await u.keyboard('{Alt>}n{/Alt}');
  await u.type(await screen.findByRole('textbox', { name: /full name/i }), 'Synthetic Newcomer');
  await u.click(screen.getByRole('radio', { name: /female/i }));
  await u.type(screen.getByLabelText(/age years/i), '31');
  await u.click(screen.getByRole('checkbox', { name: /processing of my data for testing/i }));
}
const useIt = async (u: User) => u.click(screen.getByRole('button', { name: /use this new patient/i }));
async function cbcAndRegister(u: User) {
  await u.keyboard('{F4}CBC');
  await u.click(await screen.findByRole('option', { name: /Complete blood count/ }, { timeout: T }));
  await waitFor(() => expect(screen.getAllByText(/113\.00/).length).toBeGreaterThan(0), { timeout: T });
  await u.keyboard('{Control>}{Enter}{/Control}');
}
const sent = () => of('POST', PATH.register)[0]?.body?.patient?.new_patient;
const registered = () => waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T });
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

describe('title and identity fields', () => {
  it('Title offers the 19 ElabAssist titles in order; picking "Baby of" sends the code baby_of', async () => {
    const u = user();
    await renderForm();
    await u.keyboard('{Alt>}n{/Alt}');
    await u.click(await screen.findByRole('button', { name: /^title/i }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(TITLES);
    await u.click(screen.getByRole('option', { name: 'Baby of' }));
    await u.type(await screen.findByRole('textbox', { name: /full name/i }), 'Synthetic Newcomer');
    await u.click(screen.getByRole('radio', { name: /female/i }));
    await u.type(screen.getByLabelText(/age years/i), '31');
    await u.click(screen.getByRole('checkbox', { name: /processing of my data for testing/i }));
    await useIt(u);
    await cbcAndRegister(u);
    await registered();
    expect(sent().title).toBe('baby_of');
  });

  it('all the new patient fields are sent as contract keys: title, external id, nationality, Government ID, six address parts, nothing outside the NewPatient contract', async () => {
    const u = user();
    await renderForm();
    await openNew(u);
    await choose(u, /^title/i, 'Dr');
    await type(u, /external patient id/i, 'MR-0042');
    await choose(u, /nationality/i, /^Nepal$/);
    await choose(u, /government id type/i, /^Citizenship$/);
    await u.type(screen.getByLabelText(/government id number/i), GOV_NO);
    for (const [l, v] of [[/province/i, 'Bagmati'], [/district/i, 'Kathmandu'], [/municipality/i, 'Kathmandu Metropolitan'], [/ward/i, '10'], [/tole/i, 'Baneshwor'], [/postal code/i, '44600']] as const) await u.type(screen.getAllByLabelText(l)[0]!, v);
    await useIt(u);
    await cbcAndRegister(u);
    await registered();
    const p = sent();
    expect(p).toMatchObject({
      full_name: 'Synthetic Newcomer', sex: 'female', title: 'dr', external_patient_id: 'MR-0042', nationality: 'NP', government_id_type: 'citizenship', government_id_number: GOV_NO,
      address_province: 'Bagmati', address_district: 'Kathmandu', address_municipality: 'Kathmandu Metropolitan', address_ward: '10', address_tole: 'Baneshwor', address_postal_code: '44600',
    });
    expect(Object.keys(p).filter((k) => !NEW_PATIENT_KEYS.includes(k)), 'keys outside the NewPatient contract').toEqual([]);
  });

  it('empty optional fields are absent from new_patient, never empty strings', async () => {
    const u = user();
    await renderForm();
    await openNew(u);
    await useIt(u);
    await cbcAndRegister(u);
    await registered();
    const p = sent();
    for (const k of ['title', 'external_patient_id', 'nationality', 'government_id_type', 'government_id_number', 'address_province', 'address_district', 'address_municipality', 'address_ward', 'address_tole', 'address_postal_code', 'profile_photo_attachment_id', 'custom_fields']) expect(p, k).not.toHaveProperty(k);
    expect(Object.values(p).filter((v) => v === '')).toEqual([]);
  });

  it('Government ID type lists the Nepal types (and nothing India only); Passport is a type, not a separate field', async () => {
    const u = user();
    await renderForm();
    await u.keyboard('{Alt>}n{/Alt}');
    await u.click(await screen.findByRole('button', { name: /government id type/i }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Citizenship', 'National ID', 'Passport', 'Driving licence', 'Voter ID', 'Other']);
  });

  it('India only items are not on the screen: no Aadhaar, ABHA, Health ID, and no standalone Passport control (the new patient form and the whole page)', async () => {
    const u = user();
    await renderForm();
    await u.keyboard('{Alt>}n{/Alt}');
    await screen.findByRole('textbox', { name: /full name/i });
    await u.click(screen.getByRole('button', { name: /^more/i }));
    for (const rx of [/aadhaar|aadhar/i, /\babha\b/i, /health id/i, /ayushman/i]) {
      expect(screen.queryAllByLabelText(rx), String(rx)).toHaveLength(0);
      expect(screen.queryAllByRole('button', { name: rx }), String(rx)).toHaveLength(0);
      expect(document.body.textContent ?? '', String(rx)).not.toMatch(rx);
    }
    expect(screen.queryAllByLabelText(/^passport/i)).toHaveLength(0);
  });
});

describe('Government ID is sensitive (LD-310 (b), Nepal Individual Privacy Act 2018)', () => {
  it('the number input is masked (type=password, autocomplete off) and the value is not shown as text anywhere', async () => {
    const u = user();
    await renderForm();
    await u.keyboard('{Alt>}n{/Alt}');
    const el = (await screen.findByLabelText(/government id number/i)) as HTMLInputElement;
    expect(el.type).toBe('password');
    expect(el.getAttribute('autocomplete')).toMatch(/^(off|new-password)$/);
    await u.type(el, GOV_NO);
    expect(screen.queryByText(GOV_NO)).toBeNull();
    expect(document.body.innerHTML.replace(/value="[^"]*"/g, '')).not.toContain(GOV_NO);
  });

  it('the number never reaches console, localStorage, sessionStorage or the URL; it is sent only inside F9', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const u = user();
    await renderForm();
    await openNew(u);
    await choose(u, /government id type/i, /^Passport$/);
    await u.type(screen.getByLabelText(/government id number/i), GOV_NO);
    await useIt(u);
    await cbcAndRegister(u);
    await registered();
    expect(sent().government_id_number).toBe(GOV_NO);
    const logged = spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c)));
    expect(logged.filter((l) => l.includes(GOV_NO))).toEqual([]);
    expect(JSON.stringify({ ...localStorage })).not.toContain(GOV_NO);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(GOV_NO);
    expect(window.location.href).not.toContain(GOV_NO);
    // exactly one request carries it (F9); the quote (F8) and every other call must not
    expect(calls.filter((c) => JSON.stringify(c.body ?? '').includes(GOV_NO)).map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/frontdesk/registrations']);
  });

  it('type without number, and number without type, are refused with a message naming the field; nothing is sent', async () => {
    const u = user();
    await renderForm();
    await openNew(u);
    await choose(u, /government id type/i, /^Voter ID$/);
    await useIt(u);
    expect(await screen.findByText(/government id number/i, { selector: '[role="alert"], [id$="-error"], [data-error], p, span' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /use this new patient/i })).toBeTruthy(); // still on the form
    await u.type(screen.getByLabelText(/government id number/i), GOV_NO);
    await choose(u, /government id type/i, /^Other$/);
    await useIt(u);
    await settle();
    expect(of('POST', PATH.register)).toHaveLength(0);
  });
});

describe('address (free text; no master data endpoint exists)', () => {
  it('Nepal postal code must be exactly 5 digits; a bad one stays on the form with a message, a good one passes; other countries are free text', async () => {
    const u = user();
    await renderForm();
    await openNew(u);
    await choose(u, /nationality/i, /^Nepal$/);
    await u.type(screen.getAllByLabelText(/postal code/i)[0]!, '4460');
    await useIt(u);
    expect(await screen.findByText(/postal code/i, { selector: '[role="alert"], [id$="-error"], [data-error], p, span' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /use this new patient/i })).toBeTruthy();
    const pc = screen.getAllByLabelText(/postal code/i)[0] as HTMLInputElement;
    await u.clear(pc); await u.type(pc, '44600');
    await useIt(u);
    await waitFor(() => expect(screen.queryByRole('button', { name: /use this new patient/i })).toBeNull(), { timeout: T });
  });

  it('a non Nepal nationality accepts a non 5 digit postal code as typed', async () => {
    const u = user();
    await renderForm();
    await openNew(u);
    await choose(u, /nationality/i, /^India$/);
    await u.type(screen.getAllByLabelText(/postal code/i)[0]!, '110 001');
    await useIt(u);
    await cbcAndRegister(u);
    await registered();
    expect(sent()).toMatchObject({ nationality: 'IN', address_postal_code: '110 001' });
  });

  it('each address part respects its contract maximum (ward 20, province and district 100, municipality and tole 150, postal code 20)', async () => {
    const u = user();
    await renderForm();
    await u.keyboard('{Alt>}n{/Alt}');
    await screen.findByRole('textbox', { name: /full name/i });
    const max = (rx: RegExp) => Number((screen.getAllByLabelText(rx)[0] as HTMLInputElement).getAttribute('maxlength'));
    expect([max(/province/i), max(/district/i), max(/municipality/i), max(/ward/i), max(/tole/i), max(/postal code/i)]).toEqual([100, 100, 150, 20, 150, 20]);
    expect(max(/external patient id/i)).toBe(64);
    expect(Number((screen.getByLabelText(/government id number/i) as HTMLInputElement).getAttribute('maxlength'))).toBe(64);
  });
});

describe('external patient id (unique per tenant)', () => {
  it('a duplicate answered by the server (409) is shown on the screen, keeps the form and the typed data, and does not navigate', async () => {
    handlers.register = async () => problem('identity.code_duplicate', 409, { title: 'External patient ID is already used', errors: [{ path: '/patient/new_patient/external_patient_id', code: 'identity.code_duplicate' }] });
    const u = user();
    await renderForm();
    await openNew(u);
    await type(u, /external patient id/i, 'MR-0042');
    await useIt(u);
    await cbcAndRegister(u);
    await registered();
    expect((await screen.findAllByText(/already used/i, undefined, { timeout: T })).length).toBeGreaterThan(0);
    expect(of('POST', PATH.register)).toHaveLength(1); // no automatic retry
    expect(screen.getByRole('button', { name: /register & print/i })).toBeTruthy(); // the register screen is still there
  });
});

describe('profile photo (upload or capture, png or jpeg, at most 2 MiB)', () => {
  const att = { id: U(77), mime_type: 'image/png', size_bytes: 8, scan_state: 'clean', uploaded_at: '2026-11-17T04:15:00.000Z', uploaded_by: { membership_id: U(9), display_name: 'Synthetic Desk' }, original_filename: 'face.png' };
  const spy = () => {
    const seen: { form?: FormData; key: string | null; hits: number } = { key: null, hits: 0 };
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
      if (url.pathname !== '/v1/frontdesk/trf-attachments') return real(input, init);
      seen.hits++; seen.key = new Headers(init?.headers).get('idempotency-key'); seen.form = init?.body as FormData;
      return new Response(JSON.stringify(att), { status: 201, headers: { 'content-type': 'application/json' } });
    });
    return seen;
  };

  it('Profile photo accepts png and jpeg only; the file goes through the upload action with centre_id and an Idempotency-Key, no order_id; the id rides as profile_photo_attachment_id', async () => {
    const seen = spy();
    const u = user();
    await renderForm();
    await openNew(u);
    const input = (await screen.findByLabelText(/profile photo/i)) as HTMLInputElement;
    expect(input.accept).toMatch(/image\/png/);
    expect(input.accept).toMatch(/image\/jpeg/);
    expect(input.accept).not.toMatch(/pdf/);
    await u.upload(input, png());
    await waitFor(() => expect(seen.hits).toBe(1), { timeout: T });
    expect(seen.form!.get('centre_id')).toBe(CENTRE);
    expect(seen.form!.get('order_id')).toBeNull();
    expect(seen.key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await useIt(u);
    await cbcAndRegister(u);
    await registered();
    expect(sent().profile_photo_attachment_id).toBe(att.id);
  });

  it('a file over 2 MiB or of another type is refused on the spot with a message; nothing is uploaded', async () => {
    const seen = spy();
    const u = userEvent.setup({ delay: null, applyAccept: false });
    await renderForm();
    await u.keyboard('{Alt>}n{/Alt}');
    const input = await screen.findByLabelText(/profile photo/i);
    await u.upload(input, png(2 * 1024 * 1024 + 1));
    expect((await screen.findAllByText(/2 ?(MB|MiB)/i, undefined, { timeout: T })).length).toBeGreaterThan(0);
    await u.upload(input, new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' }));
    await settle();
    expect(seen.hits).toBe(0);
  });

  it('Capture photo is a button; without a camera API (jsdom) it is disabled', async () => {
    const u = user();
    await renderForm();
    await u.keyboard('{Alt>}n{/Alt}');
    const b = await screen.findByRole('button', { name: /capture photo/i });
    expect((b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true').toBe(true);
  });
});

describe('additional fields from the lab custom field definitions', () => {
  it('one control per ACTIVE definition (inactive ones are not shown), sent as custom_fields [{code, value}]', async () => {
    reg2.customFields = [...(reg2.customFields as unknown[]), { id: U(74), field_key: 'retired', label: 'Retired field', field_type: 'text', required: false, is_active: false, sort_order: 3, version: 1 }];
    const u = user();
    await renderForm();
    await openNew(u);
    expect(await screen.findByRole('textbox', { name: /employee number/i }, { timeout: T })).toBeTruthy();
    expect(screen.queryAllByLabelText(/retired field/i)).toHaveLength(0);
    await u.type(screen.getByRole('textbox', { name: /employee number/i }), 'E-17');
    await choose(u, /^shift/i, 'Night');
    await useIt(u);
    await cbcAndRegister(u);
    await registered();
    expect(sent().custom_fields).toEqual(expect.arrayContaining([{ code: 'employee_no', value: 'E-17' }, { code: 'shift', value: 'Night' }]));
    expect(sent().custom_fields).toHaveLength(2);
    expect(of('GET', /custom-field-definitions$/).length).toBeGreaterThan(0);
  });

  it('a required definition left empty blocks the form with a message naming it; filled, it passes', async () => {
    reg2.customFields = [{ ...(reg2.customFields as Record<string, unknown>[])[0], required: true }];
    const u = user();
    await renderForm();
    await openNew(u);
    await screen.findByRole('textbox', { name: /employee number/i }, { timeout: T });
    await useIt(u);
    expect(await screen.findByText(/employee number/i, { selector: '[role="alert"], [id$="-error"], [data-error], p, span' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /use this new patient/i })).toBeTruthy();
    await u.type(screen.getByRole('textbox', { name: /employee number/i }), 'E-9');
    await useIt(u);
    await waitFor(() => expect(screen.queryByRole('button', { name: /use this new patient/i })).toBeNull(), { timeout: T });
  });

  it('a lab with no definitions shows no extra section and no error', async () => {
    reg2.customFields = [];
    const u = user();
    await renderForm();
    await openNew(u);
    await settle();
    expect(screen.queryByText(/additional fields/i)).toBeNull();
    expect(screen.queryAllByRole('alert').filter((a) => (a.textContent ?? '').trim()), 'a visible alert').toEqual([]); // the page keeps one EMPTY role=alert live region
  });

  it('without registration permission to read definitions (403) the form still works and sends no custom_fields', async () => {
    api.use(http.get(`${ORIGIN}/v1/frontdesk/custom-field-definitions`, () => problem('auth.forbidden', 403)));
    const u = user();
    await renderForm();
    await openNew(u);
    await useIt(u);
    await cbcAndRegister(u);
    await registered();
    expect(sent()).not.toHaveProperty('custom_fields');
  });
});

describe('an existing patient keeps the old shape', () => {
  it('choosing an existing patient sends patient_id only: no new_patient and none of the 13 new patient keys', async () => {
    const u = user();
    await renderForm();
    await u.keyboard('{F2}9841000001');
    await u.click(await screen.findByRole('option', { name: /Synthetic Patient One/ }, { timeout: T }));
    await cbcAndRegister(u);
    await registered();
    expect(of('POST', PATH.register)[0]!.body.patient).toEqual({ patient_id: expect.any(String) });
  });
});
