// @vitest-environment jsdom
// T0D-REGSCREEN-1 — every web-only ElabAssist registration item is on the one-screen form (LD-310; founder request 2026-11-17 04:49 NPT). Harness: fd-t13.harness.tsx.
// done_when (1)(2)(3)(4)(5). CONTRACT the writer follows or disputes (jsdom has no layout, so it is DOM + labels):
//  - DOM: ONE `.lims-reg-layout` holding exactly three `[data-reg-column]` = "context" (Patient h2), "tests" (Tests h2), "payment" (Billing h2). The `aside[aria-label="Registration summary"]` stays AFTER the layout and is the fixed totals bar.
//  - Labels (RegExp, case-insensitive): "Patient type" (read-only, derived from the credit party kind), "Laboratory" + "Franchise centre" (kit Select: button + role=option; Laboratory lists centres whose kind is not
//    'franchise', Franchise centre lists kind 'franchise'; Centre gets optional `kind` from identity enum own|franchise|home_collection; chosen franchise centre wins as centre_id),
//    "Registration date and time" (read-only, value = now in Asia/Kathmandu), "Client label" (credit only, required, prefilled with the party name), buttons "Add client" (credit only) and "Add doctor",
//    "Upload TRF", "Generate barcode", "Capture barcode", "Type barcode", radiogroup "Search tests by" (Name | Short name | Both), tab "Favourites" (aria-disabled, no API), textboxes "Discount percent" and "Discount amount" (registration level).
//  - A button "More" (aria-expanded=false by default, aria-controls=region) hides the rare items: "Buyer PAN" (F9 `buyer_pan`), "Downtime back-entry" switch. Visit type, Referrer + Self chip, Collection mode (Walk-in) stay outside it.
//  - The totals bar rows are tested in regscreen1.quickadd.test.tsx.
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CENTRE, HttpResponse, PATH, PERMS, UNIT, U, handlers, of, party, quoteFor, renderForm, setup } from './fd-t13.harness';

setup();
const T = 4000;
const FRANCHISE = U(8);
const kinded = [{ id: CENTRE, name: 'Synthetic Lab A1', kind: 'own' }, { id: U(7), name: 'Synthetic Lab B2', kind: 'own' }, { id: FRANCHISE, name: 'Synthetic Franchise F1', kind: 'franchise' }];
// Add client / Add doctor need catalog.price_list.manage / catalog.referrer.manage (createCreditParty / createDoctor x-permission); the server enforces, the UI hides the buttons without them.
const form = (extra: Record<string, unknown> = {}) => renderForm({ centres: kinded, permissions: [...PERMS, 'catalog.price_list.manage', 'catalog.referrer.manage'], ...extra });
const isReadOnly = (el: HTMLElement) => (el as HTMLInputElement).readOnly === true || el.getAttribute('aria-readonly') === 'true' || el.tagName === 'OUTPUT';
const one = (rx: RegExp) => screen.getAllByLabelText(rx)[0] as HTMLElement;
const user = () => userEvent.setup({ delay: null });

describe('layout in the DOM: three columns', () => {
  it('exactly three [data-reg-column] inside the one .lims-reg-layout, holding Patient, Tests, Billing in that order', async () => {
    await form();
    const layouts = document.querySelectorAll('.lims-reg-layout');
    expect(layouts).toHaveLength(1);
    const cols = [...layouts[0]!.querySelectorAll(':scope > [data-reg-column]')];
    expect(cols.map((c) => c.getAttribute('data-reg-column'))).toEqual(['context', 'tests', 'payment']);
    expect(layouts[0]!.querySelectorAll('[data-reg-column]')).toHaveLength(3); // no fourth, no nested column
    ['Patient', 'Tests', 'Billing'].forEach((h, i) => expect(cols[i]!.contains(screen.getByRole('heading', { level: 2, name: h })), `${h} in column ${i}`).toBe(true));
    const bar = screen.getByRole('complementary', { name: /registration summary/i });
    expect(layouts[0]!.contains(bar)).toBe(false);
    expect(layouts[0]!.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('payment rows (Method, Amount) sit in the payment column; the cart table is inside the .lims-reg-tests-list box', async () => {
    const u = user();
    await form();
    const pay = document.querySelector('[data-reg-column="payment"]') as HTMLElement;
    expect(within(pay).getAllByLabelText(/^amount/i).length).toBeGreaterThan(0);
    expect(within(pay).getByRole('button', { name: /^(?!add method).*method/i })).toBeTruthy();
    await u.keyboard('{F4}CBC');
    await u.click(await screen.findByRole('option', { name: /Complete blood count/ }, { timeout: T }));
    const box = document.querySelector('.lims-reg-tests-list') as HTMLElement;
    expect(box, '.lims-reg-tests-list').toBeTruthy();
    expect(within(box).getByRole('grid', { name: /selected tests/i })).toBeTruthy();
    expect(document.querySelector('[data-reg-column="tests"]')!.contains(box)).toBe(true);
  });
});

describe('web-only items are on the screen, each by label', () => {
  it.each([
    ['Patient type', /patient type/i],
    ['Registration date and time', /registration date/i],
    ['Search tests by', /search tests by/i],
    ['Discount percent', /discount percent/i],
    ['Discount amount', /discount amount/i],
  ])('field "%s"', async (_n, rx) => {
    await form();
    expect(screen.getAllByLabelText(rx).length).toBeGreaterThan(0);
  });

  it.each([['Add doctor'], ['Upload TRF'], ['Generate barcode'], ['Capture barcode'], ['Type barcode'], ['More']])('button "%s"', async (n) => {
    await form();
    expect(screen.getByRole('button', { name: new RegExp(`^${n}`, 'i') })).toBeTruthy();
  });

  it('Laboratory and Franchise centre selectors: Laboratory offers own centres only, Franchise centre offers franchise centres only', async () => {
    const u = user();
    await form();
    await u.click(screen.getByRole('button', { name: /laboratory/i }));
    const labs = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(labs).toEqual(expect.arrayContaining(['Synthetic Lab A1', 'Synthetic Lab B2']));
    expect(labs).not.toContain('Synthetic Franchise F1');
    await u.keyboard('{Escape}');
    await u.click(screen.getByRole('button', { name: /franchise centre/i }));
    const fr = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(fr).toContain('Synthetic Franchise F1');
    expect(fr).not.toContain('Synthetic Lab A1');
  });

  it('a chosen franchise centre becomes centre_id of the quote; the laboratory is the default', async () => {
    const u = user();
    await form();
    await u.keyboard('{F2}9841000001');
    await u.click(await screen.findByRole('option', { name: /Synthetic Patient One/ }, { timeout: T }));
    await u.keyboard('{F4}CBC');
    await u.click(await screen.findByRole('option', { name: /Complete blood count/ }, { timeout: T }));
    await waitFor(() => expect(of('POST', PATH.quote).at(-1)?.body.centre_id).toBe(CENTRE), { timeout: T });
    await u.click(screen.getByRole('button', { name: /franchise centre/i }));
    await u.click(await screen.findByRole('option', { name: /Synthetic Franchise F1/ }));
    await waitFor(() => expect(of('POST', PATH.quote).at(-1)?.body.centre_id).toBe(FRANCHISE), { timeout: T });
  });

  it('Registration date and time is read only and shows a date and a time (Asia/Kathmandu)', async () => {
    await form();
    const el = one(/registration date/i);
    expect(isReadOnly(el)).toBe(true);
    const v = (el as HTMLInputElement).value ?? el.textContent ?? '';
    expect(v).toMatch(/\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/);
    expect(v).toMatch(/\d{1,2}:\d{2}/);
  });

  it('Patient type is read only and derived from the credit party: cash shows walk-in/cash, a company party shows company', async () => {
    const u = user();
    await form();
    const pt = () => one(/patient type/i);
    expect(isReadOnly(pt())).toBe(true);
    expect(((pt() as HTMLInputElement).value ?? pt().textContent ?? '')).toMatch(/walk-?in|cash|self/i);
    await u.keyboard('{Alt>}c{/Alt}');
    await u.click(await screen.findByRole('combobox', { name: /credit party/i }));
    await u.type(screen.getByRole('combobox', { name: /credit party/i }), 'Synth');
    await u.click(await screen.findByRole('option', { name: new RegExp(party.name) }, { timeout: T }));
    await waitFor(() => expect(((pt() as HTMLInputElement).value ?? pt().textContent ?? '')).toMatch(/company/i), { timeout: T });
  });

  it('Client label appears for credit only, is required, and is prefilled with the party name', async () => {
    const u = user();
    await form();
    expect(screen.queryAllByLabelText(/client label/i)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^add client/i })).toBeNull();
    await u.keyboard('{Alt>}c{/Alt}');
    const label = await screen.findByRole('textbox', { name: /client label/i });
    expect(label.hasAttribute('required') || label.getAttribute('aria-required') === 'true').toBe(true);
    expect(screen.getByRole('button', { name: /^add client/i })).toBeTruthy();
    await u.type(screen.getByRole('combobox', { name: /credit party/i }), 'Synth');
    await u.click(await screen.findByRole('option', { name: new RegExp(party.name) }, { timeout: T }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: /client label/i }) as HTMLInputElement).value).toBe(party.name), { timeout: T });
  });

  // T0D-REGSCREEN-2 (LD-310): the favourites API now exists (listFavouriteTests), so the placeholder tab became a live tab; the full behaviour is pinned in regscreen2.drafts.test.tsx.
  it('Favourites is a live tab now (T0D-REGSCREEN-2), the All tests tab is the one selected at first', async () => {
    await form();
    const fav = screen.getByRole('tab', { name: /favourites/i });
    expect(fav.getAttribute('aria-disabled') === 'true' || (fav as HTMLButtonElement).disabled).toBe(false);
    expect(fav.getAttribute('aria-selected')).toBe('false');
    expect(screen.getAllByRole('tab').some((t) => t !== fav && t.getAttribute('aria-selected') === 'true')).toBe(true);
  });

  it('payment methods come from the configuration (Card and eSewa), not only Cash', async () => {
    const u = user();
    await form();
    const method = await screen.findByRole('button', { name: /^(?!add method).*method/i }); // not the "Add method" button
    await waitFor(() => expect(of('GET', /payment_methods$/).length).toBeGreaterThan(0), { timeout: T });
    await u.click(method);
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(names).toEqual(expect.arrayContaining(['Cash', 'Card', 'eSewa']));
  });
});

describe('nothing LIMS already has is removed (done_when 4)', () => {
  it('Visit type OPD/IPD, Referrer with the Self chip, Collection mode Walk-in, Urgent switch, Shortcuts stay outside the More fold', async () => {
    await form();
    const more = screen.getByRole('button', { name: /^more/i });
    const region = document.getElementById(more.getAttribute('aria-controls') ?? '__none__');
    for (const el of [screen.getByRole('radio', { name: /^opd$/i }), screen.getByRole('radio', { name: /^ipd$/i }), screen.getByRole('combobox', { name: /referrer/i }), screen.getByText(/^self$/i), screen.getByRole('button', { name: /collection mode/i }), screen.getByRole('switch', { name: /urgent order/i })]) {
      expect(region?.contains(el) ?? false).toBe(false);
    }
    expect(screen.getByRole('button', { name: /^shortcuts/i })).toBeTruthy();
  });

  it('the More fold is collapsed by default, holds Buyer PAN and Downtime back-entry, and opens on click', async () => {
    const u = user();
    await form();
    const more = screen.getByRole('button', { name: /^more/i });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    const region = document.getElementById(more.getAttribute('aria-controls') ?? '__none__') as HTMLElement | null;
    expect(region, 'aria-controls must point at the fold region').toBeTruthy();
    expect(region!.hidden || region!.closest('[hidden]') !== null || region!.getAttribute('aria-hidden') === 'true', 'collapsed fold is hidden').toBe(true);
    await u.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(region!.hidden).toBe(false);
    expect(within(region!).getByRole('textbox', { name: /buyer pan/i })).toBeTruthy();
    expect(within(region!).getByRole('switch', { name: /downtime back-entry/i })).toBeTruthy();
  });

  it('downtime back-entry still adds Original time and Paper form serial (in the fold)', async () => {
    const u = user();
    await form();
    await u.click(screen.getByRole('button', { name: /^more/i }));
    await u.click(screen.getByRole('switch', { name: /downtime back-entry/i }));
    expect(await screen.findByText(/original time/i)).toBeTruthy();
    expect(screen.getByRole('textbox', { name: /paper form serial/i })).toBeTruthy();
  });

  it('Buyer PAN typed in the fold is sent as buyer_pan in F9 (contract field), absent when empty', async () => {
    const u = user();
    handlers.quote = async (b: any) => HttpResponse.json(quoteFor(b));
    await form();
    await u.keyboard('{F2}9841000001');
    await u.click(await screen.findByRole('option', { name: /Synthetic Patient One/ }, { timeout: T }));
    await u.keyboard('{F4}CBC');
    await u.click(await screen.findByRole('option', { name: /Complete blood count/ }, { timeout: T }));
    await waitFor(() => expect(screen.getAllByText(/113\.00/).length).toBeGreaterThan(0), { timeout: T });
    await u.click(screen.getByRole('button', { name: /^more/i }));
    await u.type(screen.getByRole('textbox', { name: /buyer pan/i }), '123456789');
    await u.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T });
    expect(of('POST', PATH.register)[0]!.body).toMatchObject({ buyer_pan: '123456789', payments: [{ method_code: 'cash', amount_received_paisa: UNIT }] });
  });
});
