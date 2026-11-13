// @vitest-environment jsdom
// C16.T-B6 — W4 Slot templates & blackouts (04-UI-UX §3 W4, §9.2 WeekdayTimeRangeEditor). ACs: US-EN-16.1 (end ≤ start, slot_minutes ∉ [5,240], capacity ∉ [1,100]
// are refused — the UI refuses first, the server's 400 is still shown), 16.2 (overlap → 400 at /start_local shown on the form), 16.3 (capacity cut below booked →
// save succeeds, warning Banner, nothing cancelled), 16.4 (blackout result lists affected bookings, they stay confirmed).
// Contract: see t-b6.harness.tsx header (ASSUMED). The form is a Drawer (dialog role); time zone Asia/Kathmandu.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as H from './t-b6.harness';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }), usePathname: () => '/engagement/slots', useSearchParams: () => new URLSearchParams() }));
vi.mock('server-only', () => ({}));
afterEach(cleanup);

type U = ReturnType<typeof userEvent.setup>;
const grid = (re: RegExp) => screen.getByRole('grid', { name: re });
const openTemplateForm = async (user: U) => { await user.click(screen.getByRole('button', { name: /new template/i })); return screen.findByRole('dialog'); };
const openBlackoutForm = async (user: U) => { await user.click(screen.getByRole('button', { name: /add blackout/i })); return screen.findByRole('dialog'); };
const fill = async (user: U, scope: HTMLElement, label: RegExp, value: string) => {
  // T-B6-ruling: kit DateFieldBase adds a button aria-label "Open calendar for {label}" → match the field itself (input/textarea), not the button.
  const f = within(scope).getByLabelText(label, { selector: 'input,textarea' });
  await user.clear(f);
  if (value) await user.type(f, value);
  await user.tab(); // commit pickers on blur
};
const save = (d: HTMLElement) => within(d).getByRole('button', { name: /^(save|create|add)/i });
const chip = (d: HTMLElement, name: RegExp) => [...within(d).queryAllByRole('button'), ...within(d).queryAllByRole('checkbox')].find((e) => name.test(H.norm(e.textContent) || e.getAttribute('aria-label') || ''))!;
const on = (e: Element) => e.getAttribute('aria-pressed') === 'true' || e.getAttribute('aria-checked') === 'true' || (e as HTMLInputElement).checked === true;
const hasInvalid = (d: HTMLElement) => within(d).queryAllByRole('alert').length > 0 || d.querySelectorAll('[aria-invalid="true"]').length > 0 || /invalid|required|must|at least|after|between|at most/i.test(H.norm(d.textContent));

describe('W4 templates table', () => {
  it('columns: Centre, Type, Days, Hours, Slot (min), Capacity, Effective, Active', async () => {
    await H.showSlots();
    const heads = within(grid(/template/i)).getAllByRole('columnheader').map((h) => H.norm(h.textContent)).filter(Boolean);
    for (const c of [/^centre/i, /^type/i, /^days/i, /^hours/i, /^slot/i, /^capacity/i, /^effective/i, /^active/i]) expect(heads.some((h) => c.test(h)), String(c)).toBe(true);
  });

  it('a row shows the centre, type, hours as 07:00–11:00, slot minutes, capacity, effective dates and an Active/Inactive chip', async () => {
    await H.showSlots();
    const r = H.dataRows(grid(/template/i)).map((x) => H.norm(x.textContent));
    expect(r[0]).toContain('Synthetic Centre A');
    expect(r[0]).toMatch(/centre visit/i);
    expect(r[0]).toContain('07:00–11:00');
    expect(r[0]).toMatch(/\b15\b/);
    expect(r[0]).toMatch(/\b3\b/);
    expect(r[1]).toMatch(/home collection/i);
    expect(r[1]).toContain('06:30–09:30');
    expect(H.hasChip(/^active$/i)).toBe(true);
    expect(H.hasChip(/^inactive$/i)).toBe(true);
  });

  it('Days render as seven Mon–Sun chips per row with the selected ones marked in text/aria (not colour only)', async () => {
    await H.showSlots();
    const first = H.dataRows(grid(/template/i))[0]!;
    const t = H.norm(first.textContent);
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) expect(t).toContain(d);
    expect(first.querySelectorAll('.lims-chip').length).toBeGreaterThanOrEqual(5);
  });
});

describe('W4 template form (Drawer + WeekdayTimeRangeEditor)', () => {
  it('opens as a drawer with the spec defaults: working centre, Centre visit, Mon–Fri, 07:00–11:00, slot 15, capacity 3, effective from today', async () => {
    await H.showSlots();
    const d = await openTemplateForm(userEvent.setup());
    expect(H.norm(d.textContent)).toContain('Synthetic Centre A');
    expect((within(d).getByRole('radio', { name: /centre visit/i }) as HTMLInputElement).checked).toBe(true);
    const sel = ['mon', 'tue', 'wed', 'thu', 'fri'].map((x) => on(chip(d, new RegExp(`^${x}`, 'i'))));
    expect(sel).toEqual([true, true, true, true, true]);
    expect(on(chip(d, /^sat/i))).toBe(false);
    expect(on(chip(d, /^sun/i))).toBe(false);
    expect((within(d).getByLabelText(/start/i) as HTMLInputElement).value).toBe('07:00');
    expect((within(d).getByLabelText(/^end/i) as HTMLInputElement).value).toBe('11:00');
    expect((within(d).getByLabelText(/slot length|slot \(min/i) as HTMLInputElement).value).toBe('15');
    expect((within(d).getByLabelText(/capacity/i) as HTMLInputElement).value).toBe('3');
  });

  it('the home-collection centre is listed with "(Home collection)"', async () => {
    await H.showSlots();
    const user = userEvent.setup();
    const d = await openTemplateForm(user);
    await user.click(within(d).getByRole('button', { name: /centre/i }));
    expect(await screen.findByRole('option', { name: /Synthetic Home Hub \(Home collection\)/ })).toBeTruthy();
  });

  it('saving the defaults → createTemplate with ISO weekdays 1–5, HH:MM strings, and no effective_to', async () => {
    const { actions } = await H.showSlots();
    const d = await openTemplateForm(userEvent.setup());
    await userEvent.setup().click(save(d));
    await waitFor(() => expect(actions.createTemplate).toHaveBeenCalledTimes(1));
    expect(actions.createTemplate.mock.calls[0]![0]).toEqual({ centre_id: H.CENTRE, booking_kind: 'centre_visit', weekdays: [1, 2, 3, 4, 5], start_local: '07:00', end_local: '11:00', slot_minutes: 15, capacity: 3, effective_from: H.TODAY });
  });

  it('toggling Sat on and Mon off sends weekdays [2,3,4,5,6]', async () => {
    const { actions } = await H.showSlots();
    const user = userEvent.setup();
    const d = await openTemplateForm(user);
    await user.click(chip(d, /^sat/i));
    await user.click(chip(d, /^mon/i));
    await user.click(save(d));
    await waitFor(() => expect(actions.createTemplate).toHaveBeenCalled());
    expect((actions.createTemplate.mock.calls[0]![0] as any).weekdays).toEqual([2, 3, 4, 5, 6]);
  });

  it('no weekday selected → refused (the editor does not validate, the form does)', async () => {
    const { actions } = await H.showSlots();
    const user = userEvent.setup();
    const d = await openTemplateForm(user);
    for (const x of ['mon', 'tue', 'wed', 'thu', 'fri']) await user.click(chip(d, new RegExp(`^${x}`, 'i')));
    await user.click(save(d));
    expect(actions.createTemplate).not.toHaveBeenCalled();
    expect(hasInvalid(d)).toBe(true);
  });

  it.each([
    ['end equal to start', { end: '07:00' }],
    ['end before start', { end: '06:00' }],
    ['slot length 4', { slot: '4' }],
    ['slot length 241', { slot: '241' }],
    ['slot length 17 (not a multiple of 5)', { slot: '17' }],
    ['capacity 0', { cap: '0' }],
    ['capacity 101', { cap: '101' }],
  ])('rejects %s without calling the API (AC-16.1)', async (_n, v: { end?: string; slot?: string; cap?: string }) => {
    const { actions } = await H.showSlots();
    const user = userEvent.setup();
    const d = await openTemplateForm(user);
    if (v.end) fireEvent.change(within(d).getByLabelText(/^end/i), { target: { value: v.end } });
    if (v.slot) await fill(user, d, /slot length|slot \(min/i, v.slot);
    if (v.cap) await fill(user, d, /capacity/i, v.cap);
    await user.click(save(d));
    expect(actions.createTemplate).not.toHaveBeenCalled();
    expect(hasInvalid(d)).toBe(true);
  });

  it('Effective to before Effective from is rejected', async () => {
    const { actions } = await H.showSlots();
    const user = userEvent.setup();
    const d = await openTemplateForm(user);
    await fill(user, d, /effective to/i, '01/01/2026'); // from = today 15/01/2026
    await user.click(save(d));
    expect(actions.createTemplate).not.toHaveBeenCalled();
    expect(hasInvalid(d)).toBe(true);
  });

  it('a server overlap rejection (common.validation_failed at /start_local, AC-16.2) is shown and the drawer stays open', async () => {
    const actions = H.slotsActions({ createTemplate: vi.fn(async () => { throw Object.assign(new Error('common.validation_failed'), { problem: { code: 'common.validation_failed', errors: [{ pointer: '/start_local' }] } }); }) });
    await H.showSlots(actions);
    const user = userEvent.setup();
    const d = await openTemplateForm(user);
    await user.click(save(d));
    expect(await within(await screen.findByRole('dialog')).findByRole('alert')).toBeTruthy();
  });

  it('a save that leaves overbooked slots shows the warning Banner with the count and still succeeds (AC-16.3)', async () => {
    const actions = H.slotsActions({ updateTemplate: vi.fn(async (t: any, b: any) => ({ ...t, ...b, version: t.version + 1, affected: { overbooked_slots: 4 } })) });
    await H.showSlots(actions);
    const user = userEvent.setup();
    await user.click(within(H.dataRows(grid(/template/i))[0]!).getByRole('button', { name: /edit/i }));
    const d = await screen.findByRole('dialog');
    expect((within(d).getByLabelText(/capacity/i) as HTMLInputElement).value).toBe('3');
    await fill(user, d, /capacity/i, '1');
    await user.click(save(d));
    await waitFor(() => expect(actions.updateTemplate).toHaveBeenCalledTimes(1));
    expect(H.id(401)).toBe((actions.updateTemplate.mock.calls[0]![0] as any).id); // row passed so the BFF can send If-Match
    expect((actions.updateTemplate.mock.calls[0]![1] as any).capacity).toBe(1);
    await waitFor(() => expect(H.pageText()).toContain('4 future slots now have more bookings than capacity. Review them in Bookings.'));
  });

  it('no overbooked slots → no warning', async () => {
    await H.showSlots();
    const user = userEvent.setup();
    const d = await openTemplateForm(user);
    await user.click(save(d));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(H.pageText()).not.toMatch(/more bookings than capacity/);
  });

  it('[Deactivate] on an active template calls deactivateTemplate(row); the inactive row has no Deactivate', async () => {
    const { actions } = await H.showSlots();
    const user = userEvent.setup();
    const rows = H.dataRows(grid(/template/i));
    expect(within(rows[1]!).queryByRole('button', { name: /deactivate/i })).toBeNull();
    await user.click(within(rows[0]!).getByRole('button', { name: /deactivate/i }));
    const dlg = screen.queryByRole('alertdialog') ?? screen.queryByRole('dialog');
    if (dlg) await user.click(within(dlg).getByRole('button', { name: /^(deactivate|confirm|yes)/i }));
    await waitFor(() => expect(actions.deactivateTemplate).toHaveBeenCalledTimes(1));
    expect(H.id(401)).toBe((actions.deactivateTemplate.mock.calls[0]![0] as any).id);
  });
});

describe('W4 blackouts (AC-16.4)', () => {
  it('table lists the blackout with centre, period, reason and note', async () => {
    await H.showSlots();
    const t = H.norm(H.dataRows(grid(/blackout/i))[0]!.textContent);
    expect(t).toContain('Synthetic Centre A');
    expect(t).toMatch(/holiday/i);
    expect(t).toContain('Synthetic festival');
  });

  async function fillValid(user: U, d: HTMLElement) {
    await fill(user, d, /from/i, '01/02/2026 09:00 AM');
    await fill(user, d, /^to|to$/i, '02/02/2026 06:00 PM');
    await user.click(within(d).getByRole('button', { name: /reason/i }));
    await user.click(await screen.findByRole('option', { name: /maintenance/i }));
  }

  it('valid → createBlackout with UTC instants (Kathmandu 09:00 = 03:15Z), reason_code, centre_id', async () => {
    const { actions } = await H.showSlots();
    const user = userEvent.setup();
    const d = await openBlackoutForm(user);
    await fillValid(user, d);
    await user.click(save(d));
    await waitFor(() => expect(actions.createBlackout).toHaveBeenCalledTimes(1));
    expect(actions.createBlackout.mock.calls[0]![0]).toMatchObject({ centre_id: H.CENTRE, starts_at: '2026-02-01T03:15:00.000Z', ends_at: '2026-02-02T12:15:00.000Z', reason_code: 'maintenance' });
  });

  it('shows "{n} existing bookings fall in this period — they are not cancelled automatically."', async () => {
    const actions = H.slotsActions({ createBlackout: vi.fn(async (b: any) => ({ ...H.blackouts()[0], ...b, id: H.id(498), affected: { future_bookings: 7 } })) });
    await H.showSlots(actions);
    const user = userEvent.setup();
    const d = await openBlackoutForm(user);
    await fillValid(user, d);
    await user.click(save(d));
    await waitFor(() => expect(H.pageText()).toContain('7 existing bookings fall in this period — they are not cancelled automatically.'));
  });

  it.each([
    ['period longer than 31 days', '01/02/2026 09:00 AM', '15/03/2026 09:00 AM', 'x'],
    ['to before from', '02/02/2026 09:00 AM', '01/02/2026 09:00 AM', 'x'],
    ['note over 200 characters', '01/02/2026 09:00 AM', '02/02/2026 09:00 AM', 'n'.repeat(201)],
  ])('rejects %s without calling the API', async (_n, from, to, note) => {
    const { actions } = await H.showSlots();
    const user = userEvent.setup();
    const d = await openBlackoutForm(user);
    await fill(user, d, /from/i, from);
    await fill(user, d, /^to|to$/i, to);
    await user.click(within(d).getByRole('button', { name: /reason/i }));
    await user.click(await screen.findByRole('option', { name: /holiday/i }));
    await fill(user, d, /note/i, note);
    await user.click(save(d));
    expect(actions.createBlackout).not.toHaveBeenCalled();
    expect(hasInvalid(d)).toBe(true);
  });
});

describe('accessibility (axe) and LD-140', () => {
  it('page is clean', async () => { await H.showSlots(); await H.axeClean(); });
  it('template drawer is clean', async () => { await H.showSlots(); await openTemplateForm(userEvent.setup()); await H.axeClean(); });
  it('blackout form is clean', async () => { await H.showSlots(); await openBlackoutForm(userEvent.setup()); await H.axeClean(); });
  it('keyboard: the weekday chips in the drawer are reachable with Tab and toggle with Space', async () => {
    await H.showSlots();
    const user = userEvent.setup();
    const d = await openTemplateForm(user);
    const sat = chip(d, /^sat/i);
    sat.focus();
    expect(document.activeElement).toBe(sat);
    await user.keyboard(' ');
    expect(on(chip(d, /^sat/i))).toBe(true);
  });
});
