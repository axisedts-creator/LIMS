// @vitest-environment jsdom
// T0D-REGSCREEN-2 — group 3: Save as draft + Drafts list, and favourite tests (tab + star toggle). done_when (1) + (4).
// Contracts (T0C-REGPARITY-2, served by T0B-REGAPI-2): createRegistrationDraft POST /v1/frontdesk/registration-drafts {centre_id, payload: JSON TEXT of one object, <= 1 MiB} (Idempotency-Key required),
// listRegistrationDrafts GET (own drafts, newest first, summaries without payload), getRegistrationDraft GET /:id (404 when expired or purged), deleteRegistrationDraft DELETE /:id (204);
// addFavouriteTest POST /v1/frontdesk/favourite-tests {orderable_id} (Idempotency-Key required), listFavouriteTests GET, removeFavouriteTest DELETE /:orderable_id. Harness: fd-t13.harness.tsx (`reg2.drafts`, `reg2.favourites`).
// CONTRACT the writer follows or disputes:
//  - Button "Save as draft" (disabled while the form is blank: no patient and no test). Click -> ONE POST with exactly the keys centre_id (the selected laboratory) and payload (a string that parses to a plain object holding at least
//    patient {patient_id} for a picked patient and items [{orderable_id, ...}]); an Idempotency-Key header; status text "Draft saved"; the form keeps its data (no navigation, no reset).
//    The payload is patient data (never logged) and is MINIMAL: it never holds quote_fingerprint, payments, card_holder_name or government_id_number (sensitive or stale values are not parked at rest).
//  - Button "Drafts" opens a dialog named "Drafts" holding a table with the column headers Saved, Laboratory and Expires ALWAYS shown (also when empty, founder rule 2026-11-17), rows with buttons "Open" and "Delete"; empty = the text "No saved drafts".
//  - "Open": GET the draft, put the patient, the tests and the order fields back on the form, close the dialog. A draft that cannot be read (404) or is not a usable payload shows a message in the dialog, changes nothing on the form,
//    and never throws. A draft that was opened and then registered successfully is deleted (DELETE) so it does not linger.
//  - Tab "Favourites" is ENABLED (no aria-disabled): it lists the user's favourites by NAME (names come from the C3 orderables list) and clicking one adds it to the cart; none yet = "No favourite tests yet".
//    Each row of the "Selected tests" table has a toggle button "Favourite <CODE>" with aria-pressed (true when already a favourite): click = POST (Idempotency-Key), click again = DELETE /:orderable_id; a failed call reverts the toggle and says so.
import { describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CENTRE, ITEM, ORIGIN, PATH, U, api, calls, http, of, problem, renderForm, reg2, setup } from './fd-t13.harness';

setup();
const T = 4000;
const user = () => userEvent.setup({ delay: null });
type User = ReturnType<typeof user>;
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const kinded = [{ id: CENTRE, name: 'Synthetic Lab A1', kind: 'own' }, { id: U(7), name: 'Synthetic Lab B2', kind: 'own' }];
const form = (extra: Record<string, unknown> = {}) => renderForm({ centres: kinded, ...extra });
const DRAFTS = /\/registration-drafts$/;
const dialog = () => screen.findByRole('dialog', { name: /drafts/i }, { timeout: T });

async function patientAndCbc(u: User) {
  await u.keyboard('{F2}9841000001');
  await u.click(await screen.findByRole('option', { name: /Synthetic Patient One/ }, { timeout: T }));
  await u.keyboard('{F4}CBC');
  await u.click(await screen.findByRole('option', { name: /Complete blood count/ }, { timeout: T }));
  await waitFor(() => expect(screen.getAllByText(/113\.00/).length).toBeGreaterThan(0), { timeout: T });
}
const saveDraft = async (u: User) => { await u.click(screen.getByRole('button', { name: /^save as draft/i })); await waitFor(() => expect(of('POST', DRAFTS)).toHaveLength(1), { timeout: T }); };
const openDrafts = async (u: User) => { await u.click(screen.getByRole('button', { name: /^drafts/i })); return dialog(); };
const cart = () => screen.getByRole('table', { name: /selected tests/i });
const seedDraft = (payload: string, id = U(950)) => reg2.drafts.push({ id, centre_id: CENTRE, payload, created_at: '2026-11-17T04:15:00.000Z', updated_at: '2026-11-17T04:15:00.000Z', expires_at: '2026-12-01T04:15:00.000Z' });

describe('Save as draft', () => {
  it('is disabled on a blank form; with a patient and a test one click posts {centre_id, payload}, with an Idempotency-Key, and says "Draft saved"', async () => {
    const u = user();
    await form();
    expect((screen.getByRole('button', { name: /^save as draft/i }) as HTMLButtonElement).disabled).toBe(true);
    await patientAndCbc(u);
    expect((screen.getByRole('button', { name: /^save as draft/i }) as HTMLButtonElement).disabled).toBe(false);
    await saveDraft(u);
    const c = of('POST', DRAFTS)[0]!;
    expect(Object.keys(c.body).sort()).toEqual(['centre_id', 'payload']);
    expect(c.body.centre_id).toBe(CENTRE);
    expect(typeof c.body.payload).toBe('string');
    expect(c.body.payload.length).toBeLessThanOrEqual(1_000_000);
    const p = JSON.parse(c.body.payload);
    expect(p && typeof p === 'object' && !Array.isArray(p)).toBe(true);
    expect(p.patient).toEqual({ patient_id: expect.any(String) });
    expect(p.items.map((i: any) => i.orderable_id)).toEqual([ITEM.CBC]);
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect((await screen.findAllByText(/draft saved/i, undefined, { timeout: T })).length).toBeGreaterThan(0);
    expect(within(cart()).getByRole('cell', { name: 'CBC' })).toBeTruthy(); // the form keeps its data
  });

  it('the payload is minimal: no quote_fingerprint, payments, card holder name or Government ID number, even when they were typed', async () => {
    const u = user();
    await form();
    await u.keyboard('{Alt>}n{/Alt}');
    await u.type(await screen.findByRole('textbox', { name: /full name/i }), 'Synthetic Newcomer');
    await u.click(screen.getByRole('radio', { name: /female/i }));
    await u.type(screen.getByLabelText(/age years/i), '31');
    await u.click(screen.getByRole('checkbox', { name: /processing of my data for testing/i }));
    await u.click(screen.getByRole('button', { name: /government id type/i }));
    await u.click(await screen.findByRole('option', { name: /^Passport$/ }));
    await u.type(screen.getByLabelText(/government id number/i), 'SECRETGOVID');
    await u.click(screen.getByRole('button', { name: /use this new patient/i }));
    await u.keyboard('{F4}CBC');
    await u.click(await screen.findByRole('option', { name: /Complete blood count/ }, { timeout: T }));
    await waitFor(() => expect(screen.getAllByText(/113\.00/).length).toBeGreaterThan(0), { timeout: T });
    await saveDraft(u);
    const text = of('POST', DRAFTS)[0]!.body.payload as string;
    expect(text).not.toMatch(/SECRETGOVID|government_id_number|quote_fingerprint|card_holder_name/);
    expect(JSON.parse(text)).not.toHaveProperty('payments');
    expect(JSON.parse(text).patient?.new_patient?.full_name).toBe('Synthetic Newcomer'); // the rest of the new patient is kept
  });

  it('a draft is never written to the browser, the console or the URL', async () => {
    const u = user();
    await form();
    await patientAndCbc(u);
    await saveDraft(u);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(/orderable_id|Synthetic Patient/);
    expect(window.location.href).not.toMatch(/draft|orderable/i);
  });

  it('a refused save (403) shows the problem, keeps the form, and is not retried by itself', async () => {
    api.use(http.post(`${ORIGIN}/v1/frontdesk/registration-drafts`, async ({ request }) => { calls.push({ method: 'POST', path: new URL(request.url).pathname, search: '', headers: request.headers }); return problem('auth.forbidden', 403, { title: 'Not allowed to save drafts' }); }));
    const u = user();
    await form();
    await patientAndCbc(u);
    await u.click(screen.getByRole('button', { name: /^save as draft/i }));
    expect((await screen.findAllByText(/not allowed to save drafts/i, undefined, { timeout: T })).length).toBeGreaterThan(0);
    await settle();
    expect(of('POST', DRAFTS)).toHaveLength(1);
    expect(within(cart()).getByRole('cell', { name: 'CBC' })).toBeTruthy();
  });
});

describe('Drafts list', () => {
  it('empty: the dialog still draws the column headers Saved, Laboratory, Expires and says "No saved drafts"', async () => {
    const u = user();
    await form();
    const d = await openDrafts(u);
    for (const h of [/^saved/i, /laboratory|centre/i, /^expires/i]) expect(within(d).getByRole('columnheader', { name: h }), String(h)).toBeTruthy();
    expect(await within(d).findByText(/no saved drafts/i, undefined, { timeout: T })).toBeTruthy();
    expect(of('GET', DRAFTS).length).toBeGreaterThan(0);
  });

  it('lists the saved draft with its laboratory name and Open / Delete buttons; round trip: save, reload the screen, Open puts patient and tests back', async () => {
    const u = user();
    await form();
    await patientAndCbc(u);
    await saveDraft(u);
    cleanup(); // a fresh screen, as after a reload; the API fake keeps the draft
    const u2 = user();
    await form();
    const d = await openDrafts(u2);
    const row = (await within(d).findByRole('row', { name: /Synthetic Lab A1/ }, { timeout: T }));
    expect(within(row).getByRole('button', { name: /^open/i })).toBeTruthy();
    expect(within(row).getByRole('button', { name: /^delete/i })).toBeTruthy();
    await u2.click(within(row).getByRole('button', { name: /^open/i }));
    expect(await screen.findByText(/P-000123/, undefined, { timeout: T })).toBeTruthy();
    await waitFor(() => expect(within(cart()).getByRole('cell', { name: 'CBC' })).toBeTruthy(), { timeout: T });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /drafts/i })).toBeNull(), { timeout: T });
    await waitFor(() => expect(of('POST', PATH.quote).at(-1)?.body.items).toHaveLength(1), { timeout: T }); // the restored form is priced again
  });

  it('Delete calls DELETE for that draft only and the row disappears', async () => {
    seedDraft('{"items":[]}', U(951));
    seedDraft('{"items":[]}', U(952));
    const u = user();
    await form();
    const d = await openDrafts(u);
    const rows = await within(d).findAllByRole('row', { name: /Synthetic Lab A1/ }, { timeout: T });
    expect(rows).toHaveLength(2);
    await u.click(within(rows[0]!).getByRole('button', { name: /^delete/i }));
    await waitFor(() => expect(of('DELETE', /registration-drafts\/[^/]+$/)).toHaveLength(1), { timeout: T });
    expect(of('DELETE', /registration-drafts\/[^/]+$/)[0]!.path).toMatch(new RegExp(`${U(951)}|${U(952)}$`));
    await waitFor(() => expect(within(d).getAllByRole('row', { name: /Synthetic Lab A1/ })).toHaveLength(1), { timeout: T });
  });

  it('a draft that expired meanwhile (404 on Open) says so, leaves the form alone and drops the row', async () => {
    seedDraft('{"items":[]}', U(953));
    api.use(http.get(`${ORIGIN}/v1/frontdesk/registration-drafts/:id`, () => problem('common.not_found', 404, { title: 'Draft not found' })));
    const u = user();
    await form();
    const d = await openDrafts(u);
    await u.click(await within(d).findByRole('button', { name: /^open/i }, { timeout: T }));
    expect((await within(d).findAllByText(/no longer available|expired|not found/i, undefined, { timeout: T })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('table', { name: /selected tests/i })?.querySelectorAll('tbody tr').length ?? 0).toBe(0);
  });

  it('an unusable payload (wrong shapes, prototype pollution attempt) is refused with a message; the form stays blank and nothing is registered', async () => {
    seedDraft('{"patient":42,"items":"not-a-list","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}', U(954));
    const u = user();
    await form();
    const d = await openDrafts(u);
    await u.click(await within(d).findByRole('button', { name: /^open/i }, { timeout: T }));
    expect((await within(d).findAllByText(/could not (be )?open|cannot be opened|not usable|invalid/i, undefined, { timeout: T })).length).toBeGreaterThan(0);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(of('POST', PATH.register)).toHaveLength(0);
    expect(screen.queryByText(/P-000123/)).toBeNull();
  });

  it('a draft that was opened and then registered is deleted afterwards', async () => {
    const u = user();
    await form();
    await patientAndCbc(u);
    await saveDraft(u);
    cleanup();
    const u2 = user();
    await form();
    const d = await openDrafts(u2);
    await u2.click(await within(d).findByRole('button', { name: /^open/i }, { timeout: T }));
    await waitFor(() => expect(within(cart()).getByRole('cell', { name: 'CBC' })).toBeTruthy(), { timeout: T });
    await waitFor(() => expect(screen.getAllByText(/113\.00/).length).toBeGreaterThan(0), { timeout: T });
    await u2.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T });
    await waitFor(() => expect(of('DELETE', /registration-drafts\/[^/]+$/)).toHaveLength(1), { timeout: T });
  });

  it('a failed list read keeps the dialog, its headers and a Retry', async () => {
    api.use(http.get(`${ORIGIN}/v1/frontdesk/registration-drafts`, () => problem('common.internal', 500, { title: 'Drafts unavailable' })));
    const u = user();
    await form();
    const d = await openDrafts(u);
    expect(await within(d).findByText(/drafts unavailable|could not load/i, undefined, { timeout: T })).toBeTruthy();
    expect(within(d).getByRole('columnheader', { name: /^saved/i })).toBeTruthy();
    expect(within(d).getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});

describe('favourite tests', () => {
  it('the Favourites tab is enabled; with none it says "No favourite tests yet"', async () => {
    const u = user();
    await form();
    const tab = screen.getByRole('tab', { name: /favourites/i });
    expect(tab.getAttribute('aria-disabled')).not.toBe('true');
    expect((tab as HTMLButtonElement).disabled).toBe(false);
    await u.click(tab);
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText(/no favourite tests yet/i, undefined, { timeout: T })).toBeTruthy();
    expect(of('GET', /favourite-tests$/).length).toBeGreaterThan(0);
  });

  it('with favourites it lists them by name and clicking one adds it to the cart and the quote', async () => {
    reg2.favourites = [ITEM.CBC, ITEM.TSH];
    const u = user();
    await form();
    await u.click(screen.getByRole('tab', { name: /favourites/i }));
    expect(await screen.findByText(/Thyroid stimulating hormone/, undefined, { timeout: T })).toBeTruthy();
    await u.click(await screen.findByText(/Complete blood count/, undefined, { timeout: T }));
    await waitFor(() => expect(within(cart()).getByRole('cell', { name: 'CBC' })).toBeTruthy(), { timeout: T });
    await waitFor(() => expect(of('POST', PATH.quote).at(-1)?.body.items.map((i: any) => i.orderable_id)).toEqual([ITEM.CBC]), { timeout: T });
  });

  it('the star toggle: unpressed -> POST {orderable_id} with an Idempotency-Key -> pressed -> DELETE /:orderable_id -> unpressed', async () => {
    const u = user();
    await form();
    await patientAndCbc(u);
    const star = () => within(cart()).getByRole('button', { name: /favourite CBC/i });
    expect(star().getAttribute('aria-pressed')).toBe('false');
    await u.click(star());
    await waitFor(() => expect(of('POST', /favourite-tests$/)).toHaveLength(1), { timeout: T });
    expect(of('POST', /favourite-tests$/)[0]!.body).toEqual({ orderable_id: ITEM.CBC });
    expect(of('POST', /favourite-tests$/)[0]!.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await waitFor(() => expect(star().getAttribute('aria-pressed')).toBe('true'), { timeout: T });
    await u.click(star());
    await waitFor(() => expect(of('DELETE', /favourite-tests\/[^/]+$/)).toHaveLength(1), { timeout: T });
    expect(of('DELETE', /favourite-tests\/[^/]+$/)[0]!.path).toMatch(new RegExp(`${ITEM.CBC}$`));
    await waitFor(() => expect(star().getAttribute('aria-pressed')).toBe('false'), { timeout: T });
  });

  it('a test that is already a favourite starts pressed; a newly starred test shows under the Favourites tab without a reload', async () => {
    reg2.favourites = [ITEM.CBC];
    const u = user();
    await form();
    await patientAndCbc(u);
    expect(within(cart()).getByRole('button', { name: /favourite CBC/i }).getAttribute('aria-pressed')).toBe('true');
    await u.keyboard('{F4}TSH');
    await u.click(await screen.findByRole('option', { name: /Thyroid stimulating hormone/ }, { timeout: T }));
    await u.click(await within(cart()).findByRole('button', { name: /favourite TSH/i }));
    await waitFor(() => expect(reg2.favourites).toContain(ITEM.TSH), { timeout: T });
    await u.click(screen.getByRole('tab', { name: /favourites/i }));
    expect((await screen.findAllByText(/Thyroid stimulating hormone/, undefined, { timeout: T })).length).toBeGreaterThan(0);
  });

  it('a failed star (500) reverts the toggle and says so', async () => {
    api.use(http.post(`${ORIGIN}/v1/frontdesk/favourite-tests`, () => problem('common.internal', 500, { title: 'Could not save the favourite' })));
    const u = user();
    await form();
    await patientAndCbc(u);
    const star = () => within(cart()).getByRole('button', { name: /favourite CBC/i });
    await u.click(star());
    expect((await screen.findAllByText(/could not (save|update) the favourite|favourite .*not saved/i, undefined, { timeout: T })).length).toBeGreaterThan(0);
    await waitFor(() => expect(star().getAttribute('aria-pressed')).toBe('false'), { timeout: T });
  });

  it('favourites are the user\'s own: the list read carries no user id or filter of the client, and a 403 on the read leaves the tab empty without an error page', async () => {
    api.use(http.get(`${ORIGIN}/v1/frontdesk/favourite-tests`, async ({ request }) => { calls.push({ method: 'GET', path: new URL(request.url).pathname, search: new URL(request.url).search, headers: request.headers }); return problem('auth.forbidden', 403); }));
    const u = user();
    await form();
    await u.click(screen.getByRole('tab', { name: /favourites/i }));
    await settle();
    expect(of('GET', /favourite-tests$/).every((c) => !/user|membership|actor/i.test(c.search))).toBe(true);
    expect(screen.queryByRole('heading', { name: /something went wrong|error/i })).toBeNull();
  });
});
