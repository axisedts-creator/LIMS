// @vitest-environment jsdom
// T0D-PARTYSET-1 — masked ID numbers and the doctor form (done_when 4, 7; 07-SECURITY: PAN / national id masked, reveal needs partners.party_id_number.read and is audited by the SERVER).
// Pages: app/(staff)/partners/[partner_id]/page.tsx (Overview) and app/(staff)/catalog/doctors/[doctor_id]/page.tsx (existing screens, extended).
// PINNED UI NAMES (tester choice; writer may dispute through the ruling path):
//   - partner Overview gains two rows: "PAN" (tax_number) and "National ID number" (national_id_number), each shows the value the API sent (already masked, '********0001') and a button
//     "Show PAN" / "Show National ID number" (shown only when the field exists). Click -> POST /v1/partners/admin/parties/partner/<id>/id-number { field: 'tax_number' | 'national_id_number' }; the full value replaces the
//     masked one and the button becomes "Hide PAN" / "Hide National ID number"; Hide (or leaving the tab and coming back, or any refresh) shows the masked value again.
//     The full value exists only in component state: never in localStorage / sessionStorage / the URL / a data- attribute / the document title; the DOM has no full value before the click.
//   - without partners.party_id_number.read the Show button is disabled with the visible reason t('partners.idnumber.reason.read') (names the code), linked by aria-describedby; no call is made.
//   - failures: 403 auth.mfa_required -> alert with t('partners.idnumber.mfa_required'); 403 auth.forbidden -> t('partners.idnumber.reason.read'); 404 -> t('partners.idnumber.not_found'); the value stays masked.
//   - the doctor form shows every new doctor field: "Speciality", "Hospital", "National ID number" (masked, with "Show National ID number" that posts to parties/doctor/<id>/id-number { field: 'national_id_number' }).
//     Save sends only changed fields: the masked national id is NEVER sent back unless the user typed a new value (format 1..32 letters, digits or '-'); clearing speciality / hospital / national id sends `unset`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { t } from '@/core/i18n/messages';
import { API, DOCTOR, P, PARTNER, PERM, ROUTE, TM, api, isDisabled, norm, openPage, prob, quiet, reasonOf } from './partyset1.harness';

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { API.reset(); TM.refresh.mockReset(); TM.push.mockClear(); TM.replace.mockClear(); localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const FULL = 'SYN000000001';
const PARTNER_PERMS = [PERM.partnerRead, PERM.partnerManage];
const reveals = () => API.find('POST', /id-number$/);
const openPartner = (extra: string[] = [PERM.idRead]) => openPage(ROUTE.partner, { perms: [...PARTNER_PERMS, ...extra], params: { partner_id: PARTNER } });
const openDoctor = (perms: string[] = [PERM.referrerRead, PERM.referrerManage, PERM.idRead]) => openPage(ROUTE.doctor, { perms, params: { doctor_id: P.doctor } });
const typeInto = async (user: ReturnType<typeof userEvent.setup>, el: HTMLElement, v: string) => { await user.clear(el); if (v) await user.type(el, v); };

describe('Masked ID numbers on the partner (done_when 4)', () => {
  it('shows PAN and National ID number masked (last four only) with a Show button each; the full value is nowhere in the DOM', async () => {
    await openPartner();
    await screen.findByText('********0001');
    expect(screen.getByText('********0002')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^show pan$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^show national id number$/i })).toBeTruthy();
    expect(document.documentElement.outerHTML).not.toContain(FULL);
    expect(reveals()).toHaveLength(0);
  });
  it('a partner without the fields shows no Show button for them (dash)', async () => {
    API.partner = { ...API.partner, tax_number: undefined, national_id_number: undefined };
    await openPartner();
    await screen.findByRole('tab', { name: /overview/i });
    expect(screen.queryByRole('button', { name: /^show /i })).toBeNull();
  });
  it('Show: one POST with the field name, the full value replaces the mask, the button turns into Hide; Hide masks again', async () => {
    const user = userEvent.setup();
    await openPartner();
    await user.click(await screen.findByRole('button', { name: /^show pan$/i }));
    await screen.findByText(FULL);
    expect(reveals()).toHaveLength(1);
    expect(reveals()[0]!.path).toBe(`/v1/partners/admin/parties/partner/${PARTNER}/id-number`);
    expect(reveals()[0]!.json).toEqual({ field: 'tax_number' });
    expect(screen.queryByText('********0001')).toBeNull();
    expect(screen.getByText('********0002')).toBeTruthy(); // the other field stays masked
    await user.click(screen.getByRole('button', { name: /^hide pan$/i }));
    await screen.findByText('********0001');
    expect(document.documentElement.outerHTML).not.toContain(FULL);
    await user.click(screen.getByRole('button', { name: /^show national id number$/i }));
    await waitFor(() => expect(reveals()).toHaveLength(2));
    expect(reveals()[1]!.json).toEqual({ field: 'national_id_number' });
  });
  it('every Show press goes to the server (so the server can audit it); nothing is cached between presses', async () => {
    const user = userEvent.setup();
    await openPartner();
    await user.click(await screen.findByRole('button', { name: /^show pan$/i }));
    await screen.findByText(FULL);
    await user.click(screen.getByRole('button', { name: /^hide pan$/i }));
    await user.click(screen.getByRole('button', { name: /^show pan$/i }));
    await waitFor(() => expect(reveals()).toHaveLength(2));
  });
  it('the full value never reaches localStorage, sessionStorage, the URL, the title or a data- attribute; leaving the tab re-masks it', async () => {
    const user = userEvent.setup();
    await openPartner();
    await user.click(await screen.findByRole('button', { name: /^show pan$/i }));
    await screen.findByText(FULL);
    expect(JSON.stringify({ ...localStorage })).not.toContain(FULL);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(FULL);
    expect(location.href).not.toContain(FULL);
    expect(document.title).not.toContain(FULL);
    expect([...document.querySelectorAll('*')].some((e) => [...e.attributes].some((a) => a.value.includes(FULL)))).toBe(false);
    await user.click(screen.getByRole('tab', { name: /users/i }));
    await user.click(screen.getByRole('tab', { name: /overview/i }));
    await screen.findByText('********0001');
    expect(document.documentElement.outerHTML).not.toContain(FULL);
  });
  it('without partners.party_id_number.read: Show is disabled with the visible reason (names the code), no call, even by keyboard', async () => {
    const user = userEvent.setup();
    await openPartner([]);
    const b = await screen.findByRole('button', { name: /^show pan$/i });
    expect(t('partners.idnumber.reason.read')).not.toBe('partners.idnumber.reason.read');
    expect(t('partners.idnumber.reason.read')).toContain('partners.party_id_number.read');
    expect(isDisabled(b)).toBe(true);
    expect(reasonOf(b)).toContain(t('partners.idnumber.reason.read'));
    expect(document.body.textContent).toContain(t('partners.idnumber.reason.read'));
    b.focus(); await user.keyboard('{Enter}'); await user.click(b).catch(() => undefined);
    await quiet();
    expect(reveals()).toHaveLength(0);
    expect(screen.getByText('********0001')).toBeTruthy();
  });
  it.each([
    ['MFA needed', prob(403, 'auth.mfa_required'), 'partners.idnumber.mfa_required'],
    ['forbidden', prob(403, 'auth.forbidden'), 'partners.idnumber.reason.read'],
    ['not found', prob(404, 'common.not_found'), 'partners.idnumber.not_found'],
  ])('%s: a plain catalogue message in an alert, the value stays masked, no raw code on screen', async (_n, res, key) => {
    const user = userEvent.setup();
    expect(t(key)).not.toBe(key);
    API.revealFail = res;
    await openPartner();
    await user.click(await screen.findByRole('button', { name: /^show pan$/i }));
    const alert = await screen.findByRole('alert');
    expect(norm(alert.textContent)).toContain(t(key));
    expect(screen.getByText('********0001')).toBeTruthy();
    expect(norm(document.body.textContent)).not.toMatch(/auth\.mfa_required|common\.not_found|urn:lims|\{"/);
  });
  it('a double press sends one reveal request at a time', async () => {
    const user = userEvent.setup();
    await openPartner();
    const b = await screen.findByRole('button', { name: /^show pan$/i });
    await user.click(b); await user.click(b).catch(() => undefined);
    await quiet(200);
    expect(reveals().length).toBeLessThanOrEqual(1);
  });
  it('has no axe violations masked and revealed', async () => {
    const user = userEvent.setup();
    await openPartner();
    await user.click(await screen.findByRole('button', { name: /^show pan$/i }));
    await screen.findByText(FULL);
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('Doctor form: every new field, masked national id (done_when 4)', () => {
  it('shows Speciality, Hospital and the masked National ID number with its Show button', async () => {
    await openDoctor();
    expect((await screen.findByLabelText(/^speciality/i) as HTMLInputElement).value).toBe('Pathology');
    expect((screen.getByLabelText(/^hospital/i) as HTMLInputElement).value).toBe('Synthetic General Hospital');
    expect((screen.getByLabelText(/^national id number/i) as HTMLInputElement).value).toBe('********0002');
    expect(screen.getByRole('button', { name: /^show national id number$/i })).toBeTruthy();
    expect(document.documentElement.outerHTML).not.toMatch(/SYN-NID-/);
  });
  it('Show posts to parties/doctor/<id>/id-number and shows the full value; Hide masks it again', async () => {
    const user = userEvent.setup();
    API.revealValue = 'SYN-NID-0002';
    await openDoctor();
    await user.click(await screen.findByRole('button', { name: /^show national id number$/i }));
    await waitFor(() => expect(reveals()).toHaveLength(1));
    expect(reveals()[0]!.path).toBe(`/v1/partners/admin/parties/doctor/${P.doctor}/id-number`);
    expect(reveals()[0]!.json).toEqual({ field: 'national_id_number' });
    await waitFor(() => expect((screen.getByLabelText(/^national id number/i) as HTMLInputElement).value).toBe('SYN-NID-0002'));
    await user.click(screen.getByRole('button', { name: /^hide national id number$/i }));
    expect((screen.getByLabelText(/^national id number/i) as HTMLInputElement).value).toBe('********0002');
  });
  it('without partners.party_id_number.read the Show button is disabled with the visible reason; no call', async () => {
    await openDoctor([PERM.referrerRead, PERM.referrerManage]);
    const b = await screen.findByRole('button', { name: /^show national id number$/i });
    expect(isDisabled(b)).toBe(true);
    expect(reasonOf(b)).toContain(t('partners.idnumber.reason.read'));
    expect(reveals()).toHaveLength(0);
  });
  it('a doctor without a national id shows an empty field and no Show button', async () => {
    API.doctor = { ...DOCTOR, national_id_number: undefined };
    await openDoctor();
    expect((await screen.findByLabelText(/^national id number/i) as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('button', { name: /^show national id number$/i })).toBeNull();
  });
  it('Save sends only the changed fields and NEVER the masked national id', async () => {
    const user = userEvent.setup();
    await openDoctor();
    await typeInto(user, await screen.findByLabelText(/^speciality/i), 'Biochemistry');
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(API.find('PATCH', /doctors\//)).toHaveLength(1));
    const c = API.find('PATCH', /doctors\//)[0]!;
    expect(c.json).toEqual({ speciality: 'Biochemistry' });
    expect(JSON.stringify(c.json)).not.toContain('********');
    expect(c.headers.get('if-match')).toMatch(/^"?3"?$/);
  });
  it('a typed national id is sent as the new full value; hospital and speciality cleared go to unset', async () => {
    const user = userEvent.setup();
    await openDoctor();
    await typeInto(user, await screen.findByLabelText(/^national id number/i), 'NID-998877');
    await typeInto(user, screen.getByLabelText(/^speciality/i), '');
    await typeInto(user, screen.getByLabelText(/^hospital/i), '');
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(API.find('PATCH', /doctors\//)).toHaveLength(1));
    const j = API.find('PATCH', /doctors\//)[0]!.json;
    expect(j.national_id_number).toBe('NID-998877');
    expect([...(j.unset as string[])].sort()).toEqual(['hospital', 'speciality']);
  });
  it('clearing the national id sends unset national_id_number', async () => {
    const user = userEvent.setup();
    await openDoctor();
    await typeInto(user, await screen.findByLabelText(/^national id number/i), '');
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(API.find('PATCH', /doctors\//)).toHaveLength(1));
    expect(API.find('PATCH', /doctors\//)[0]!.json).toEqual({ unset: ['national_id_number'] });
  });
  it.each([['a space', 'NID 123'], ['33 characters', 'A'.repeat(33)], ['a symbol', 'NID#123']])('a national id with %s is refused before any request', async (_n, v) => {
    const user = userEvent.setup();
    await openDoctor();
    const f = await screen.findByLabelText(/^national id number/i);
    await typeInto(user, f, v);
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await quiet();
    expect(API.find('PATCH', /doctors\//)).toHaveLength(0);
    expect(f.getAttribute('aria-invalid')).toBe('true');
  });
  it('speciality over 120 or hospital over 200 characters is refused before any request', async () => {
    const user = userEvent.setup();
    await openDoctor();
    await typeInto(user, await screen.findByLabelText(/^hospital/i), 'H'.repeat(201));
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await quiet();
    expect(API.find('PATCH', /doctors\//)).toHaveLength(0);
  });
  it('read-only doctor (no manage): the new fields are read-only text, the masked id and Show still work', async () => {
    await openDoctor([PERM.referrerRead, PERM.idRead]);
    const f = await screen.findByLabelText(/^speciality/i) as HTMLInputElement;
    expect(f.readOnly || f.disabled).toBe(true);
    expect((screen.getByLabelText(/^national id number/i) as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByRole('button', { name: /^show national id number$/i })).toBeTruthy();
    expect(within(document.body).queryByRole('button', { name: /^save/i })).toBeNull();
  });
});
