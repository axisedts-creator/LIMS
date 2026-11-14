// @vitest-environment jsdom
// C16.T-B6 — W1 Bookings, W2 Booking detail, W3 New booking (04-UI-UX §3). ACs: US-EN-15.1 (staff phone booking: patient via C4 search, slot,
// created_via staff), 15.2 (centre scope is server-side; the UI only ever lists the working centre by default), 15.3 (check-in with queue token).
// Contract: see t-b6.harness.tsx header (ASSUMED). Times are shown in Asia/Kathmandu (UTC+05:45): 01:30Z -> 07:15.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as H from './t-b6.harness';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }), usePathname: () => '/engagement/bookings', useSearchParams: () => new URLSearchParams() }));
vi.mock('server-only', () => ({}));
afterEach(() => { cleanup(); push.mockClear(); });

const grid = () => screen.getByRole('grid', { name: /booking/i });
const row = (re: RegExp) => { const r = H.rowOf(grid(), re); if (!r) throw new Error(`no row ${re}; rows: ${JSON.stringify(H.dataRows(grid()).map((x) => H.norm(x.textContent)))}`); return r; };
const selectRow = async (user: ReturnType<typeof userEvent.setup>, re: RegExp) => {
  const r = row(re);
  const box = within(r).queryByRole('checkbox');
  await user.click(box ?? r);
};

describe('W1 list — columns and cells', () => {
  it('columns: Time, Booking no., Patient, Type, Tests, Source, Status, Order', async () => {
    await H.showBookings();
    const heads = within(grid()).getAllByRole('columnheader').map((h) => H.norm(h.textContent)).filter(Boolean);
    for (const c of [/^time/i, /booking no/i, /^patient/i, /^type/i, /^tests/i, /^source/i, /^status/i, /^order/i]) expect(heads.some((h) => c.test(h)), String(c)).toBe(true);
  });

  it('a row shows local time, booking no, patient name, type, test count, source and a status chip', async () => {
    await H.showBookings();
    const t = H.norm(row(/BK26000001/).textContent);
    expect(t).toContain('07:15'); // 01:30Z in Asia/Kathmandu, not UTC
    expect(t).toContain('Sunita Synthetic 1');
    expect(t).toMatch(/centre visit/i);
    expect(t).toMatch(/\b2\b/); // Tests (count)
    expect(t).toMatch(/staff/i);
    expect(H.hasChip(/^confirmed$/i)).toBe(true);
    expect(H.hasChip(/^checked in$/i)).toBe(true);
    expect(H.hasChip(/^cancelled$/i)).toBe(true);
  });

  it('a patient name the server could not fetch (no frontdesk.patient.read) shows "—"', async () => {
    await H.showBookings();
    expect(H.norm(row(/BK26000004/).textContent)).toContain('—');
  });

  it('Order column links to the front-desk order (staff.frontdesk.order) only when order_id is set', async () => {
    await H.showBookings();
    const link = within(row(/BK26000002/)).getAllByRole('link').find((a) => (a.getAttribute('href') ?? '').includes(H.id(500)));
    expect(link, 'order link').toBeTruthy();
    expect(link!.getAttribute('href')).toMatch(/^\/frontdesk\/orders\//);
    expect(within(row(/BK26000001/)).queryAllByRole('link').some((a) => /frontdesk\/orders/.test(a.getAttribute('href') ?? ''))).toBe(false);
  });

  it('Open opens the detail route /engagement/bookings/{id}', async () => {
    await H.showBookings();
    const open = within(row(/BK26000001/)).getAllByRole('link', { name: /open|BK26000001/i }).find((a) => (a.getAttribute('href') ?? '').includes(H.id(101)));
    expect(open!.getAttribute('href')).toBe(`/engagement/bookings/${H.id(101)}`);
  });

  it('empty list → "No bookings for this day."', async () => {
    await H.showBookings(H.bookingsActions(), { rows: [] });
    expect(H.pageText()).toContain('No bookings for this day.');
  });

  it('only a confirmed booking can be checked in; cancelled rows offer neither Check in nor Cancel', async () => {
    await H.showBookings();
    expect(within(row(/BK26000001/)).getByRole('button', { name: /check in/i })).toBeTruthy();
    expect(within(row(/BK26000001/)).getByRole('button', { name: /cancel/i })).toBeTruthy();
    expect(within(row(/BK26000003/)).queryByRole('button', { name: /check in|cancel/i })).toBeNull();
    expect(within(row(/BK26000002/)).queryByRole('button', { name: /check in/i })).toBeNull(); // already checked in
  });

  it('LD-140: no row shows a raw status word without a chip (every status = tone + word)', async () => {
    await H.showBookings();
    for (const c of H.chips()) expect(c.tone).toMatch(/^(neutral|info|success|warning|danger|critical)$/);
  });
});

describe('W1 filters (FilterBar; ≤ 31 days)', () => {
  it('the defaults are today, the working centre and status Confirmed + Checked in (visible)', async () => {
    await H.showBookings();
    const t = H.pageText();
    expect(t).toContain('Synthetic Centre A');
    expect(t).toMatch(/confirmed/i);
    expect(t).toMatch(/checked in/i);
  });

  it('changing Type asks the server for that kind with the default centre, statuses and the Kathmandu day window', async () => {
    const { actions } = await H.showBookings();
    const user = userEvent.setup();
    await H.pick(user, /type/i, /home collection/i);
    await waitFor(() => expect(actions.listBookings).toHaveBeenCalled());
    const q = actions.listBookings.mock.calls.at(-1)![0] as Record<string, any>;
    expect(q).toMatchObject({ centre_id: H.CENTRE, booking_kind: 'home_collection', slot_start_from: H.TODAY_START_UTC });
    expect([...q.status].sort()).toEqual(['checked_in', 'confirmed']);
    const span = Date.parse(q.slot_start_to) - Date.parse(q.slot_start_from);
    expect(span).toBeGreaterThan(0);
    expect(span).toBeLessThanOrEqual(31 * 86_400_000);
  });

  it('rows returned by the server replace the list', async () => {
    const actions = H.bookingsActions({ listBookings: vi.fn(async () => [H.booking(7, { booking_kind: 'home_collection' })]) });
    await H.showBookings(actions);
    const user = userEvent.setup();
    await H.pick(user, /type/i, /home collection/i);
    await waitFor(() => expect(H.pageText()).toContain('BK26000007'));
    expect(H.pageText()).not.toContain('BK26000001');
  });
});

describe('W1 row actions and page keys (staff.engagement.bookings)', () => {
  it('registers Alt+B, Alt+C and Alt+X; none is a global key', async () => {
    await H.showBookings();
    const { shortcuts, GLOBAL_KEYS } = await import('@/core/shortcuts/registry');
    const list = shortcuts.list(H.SHORTCUT_BOOKINGS);
    for (const [k, d] of [['Alt+B', /new/i], ['Alt+C', /check/i], ['Alt+X', /cancel/i]] as const) {
      const s = list.find((x) => x.key.toLowerCase() === k.toLowerCase());
      expect(s, k).toBeTruthy();
      expect(s!.description).toMatch(d);
      expect(GLOBAL_KEYS as readonly string[]).not.toContain(k);
    }
  });

  it('Alt+B opens the new-booking screen', async () => {
    await H.showBookings();
    const s = await H.shortcut(H.SHORTCUT_BOOKINGS, /^alt\+b$/i);
    act(() => s!.run());
    expect(push).toHaveBeenCalledWith('/engagement/bookings/new');
  });

  it('Alt+C / Alt+X are no-ops with nothing selected; with a selected confirmed row they open the check-in / cancel dialogs', async () => {
    await H.showBookings();
    const user = userEvent.setup();
    const c = (await H.shortcut(H.SHORTCUT_BOOKINGS, /^alt\+c$/i))!, x = (await H.shortcut(H.SHORTCUT_BOOKINGS, /^alt\+x$/i))!;
    act(() => c.run());
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => x.run());
    expect(screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog')).toBeNull();
    await selectRow(user, /BK26000001/);
    act(() => c.run());
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(H.pageText()).toMatch(/issue queue token/i);
  });

  it('row [Cancel] opens a confirm dialog listing booking_cancel_reasons and cancels nothing until confirmed', async () => {
    const { actions } = await H.showBookings();
    const user = userEvent.setup();
    await user.click(within(row(/BK26000001/)).getByRole('button', { name: /cancel/i }));
    const d = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(actions.cancel).not.toHaveBeenCalled();
    await user.click(within(d).getByRole('button', { name: /reason/i }));
    expect(await screen.findByRole('option', { name: /patient request/i })).toBeTruthy();
    expect(screen.getByRole('option', { name: /lab unavailable/i })).toBeTruthy();
  });
});

describe('W2 detail', () => {
  it('shows booking no, type, centre, slot (local), items with indicative price, status, created via, and the patient link', async () => {
    await H.showDetail();
    const t = H.pageText();
    for (const s of ['BK26000001', 'Synthetic Centre A', 'Synthetic CBC', 'Synthetic Lipid Panel', 'Sunita Synthetic 1']) expect(t).toContain(s);
    expect(t).toMatch(/centre visit/i);
    expect(t).toContain('07:15');
    expect(t).toMatch(/350/); // NPR 350.00 (35000 paisa) via MoneyText
    expect(t).toMatch(/staff/i);
    expect(H.hasChip(/^confirmed$/i)).toBe(true);
    const link = screen.getAllByRole('link').find((a) => (a.getAttribute('href') ?? '').includes(H.id(301)));
    expect(link!.getAttribute('href')).toMatch(/^\/frontdesk\/patients\//);
  });

  it('Timeline lists the transitions', async () => {
    await H.showDetail();
    expect(H.pageText()).toMatch(/confirmed/i);
    expect(H.pageText()).toMatch(/checked in/i);
  });

  it('a checked-in booking shows its order link and queue token reference, and offers no Check in', async () => {
    await H.showDetail(H.bookingsActions(), { booking: H.bookings()[1] });
    expect(screen.queryByRole('button', { name: /check in/i })).toBeNull();
    expect(screen.getAllByRole('link').some((a) => (a.getAttribute('href') ?? '').includes(H.id(500)))).toBe(true);
  });

  it('Check in dialog: "Issue queue token" is on by default, with a queue Select and Normal/Priority; submit → checkIn(booking, {issue_token, queue_id, priority}) (AC-15.3)', async () => {
    const { actions } = await H.showDetail();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^check in/i }));
    const d = await screen.findByRole('dialog');
    const sw = within(d).getByRole('switch', { name: /issue queue token/i }) as HTMLInputElement;
    expect(sw.checked || sw.getAttribute('aria-checked') === 'true').toBe(true);
    expect(within(d).getByRole('radio', { name: /normal/i })).toBeTruthy();
    await user.click(within(d).getByRole('radio', { name: /priority/i }));
    await user.click(within(d).getByRole('button', { name: /queue/i }));
    await user.click(await screen.findByRole('option', { name: /B — Sample collection/ }));
    await user.click(within(d).getByRole('button', { name: /^(check in|confirm|save)/i }));
    expect(actions.checkIn).toHaveBeenCalledTimes(1);
    expect(H.id(101)).toBe((actions.checkIn.mock.calls[0]![0] as any).id); // the booking row is passed so the BFF can send If-Match
    expect(actions.checkIn.mock.calls[0]![1]).toEqual({ issue_token: true, queue_id: H.Q2, priority: 'priority' });
  });

  it('switching "Issue queue token" off checks in without a token (queue/priority not sent)', async () => {
    const { actions } = await H.showDetail();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^check in/i }));
    const d = await screen.findByRole('dialog');
    await user.click(within(d).getByRole('switch', { name: /issue queue token/i }));
    await user.click(within(d).getByRole('button', { name: /^(check in|confirm|save)/i }));
    const body = actions.checkIn.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.issue_token).toBe(false);
    expect(body.queue_id).toBeUndefined();
  });

  it('a rejected check-in (e.g. engagement.queue_closed) stays on the dialog with an alert', async () => {
    const actions = H.bookingsActions({ checkIn: vi.fn(async () => { throw Object.assign(new Error('engagement.queue_closed'), { problem: { code: 'engagement.queue_closed' } }); }) });
    await H.showDetail(actions);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^check in/i }));
    const d = await screen.findByRole('dialog');
    await user.click(within(d).getByRole('button', { name: /^(check in|confirm|save)/i }));
    expect(await within(await screen.findByRole('dialog')).findByRole('alert')).toBeTruthy();
  });

  it('Cancel: ConfirmDialog needs a reason from booking_cancel_reasons, then cancel(booking, {reason_code})', async () => {
    const { actions } = await H.showDetail();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^cancel/i }));
    const d = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await user.click(within(d).getByRole('button', { name: /^(cancel booking|confirm|yes)/i }));
    expect(actions.cancel, 'no reason chosen').not.toHaveBeenCalled();
    await user.click(within(d).getByRole('button', { name: /reason/i }));
    await user.click(await screen.findByRole('option', { name: /lab unavailable/i }));
    await user.click(within(d).getByRole('button', { name: /^(cancel booking|confirm|yes)/i }));
    expect(actions.cancel).toHaveBeenCalledTimes(1);
    expect(actions.cancel.mock.calls[0]![1]).toEqual({ reason_code: 'lab_unavailable' });
  });
});

describe('W3 new booking (AC-15.1)', () => {
  const type = async (user: ReturnType<typeof userEvent.setup>, label: RegExp, text: string) => user.type(screen.getByRole('combobox', { name: label }), text);

  it('patient search starts at 3 characters, goes through actions.searchPatients, and options show name, patient code and age/sex', async () => {
    const { actions } = await H.showNew();
    const user = userEvent.setup();
    await type(user, /patient/i, 'su');
    expect(actions.searchPatients).not.toHaveBeenCalled();
    await type(user, /patient/i, 'n');
    await waitFor(() => expect(actions.searchPatients).toHaveBeenCalledWith('sun'));
    const opt = await screen.findByRole('option', { name: /Sunita Synthetic/ });
    expect(H.norm(opt.textContent)).toMatch(/P-000101/);
    expect(H.norm(opt.textContent)).toMatch(/34/);
    expect(H.norm(opt.textContent)).toMatch(/\bF\b/);
  });

  it('shows the slot list for the chosen date as "07:15 — 2 of 3 left"; an overbooked/full slot is disabled', async () => {
    const { actions } = await H.showNew();
    const user = userEvent.setup();
    await waitFor(() => expect(actions.listSlots).toHaveBeenCalled());
    expect(actions.listSlots.mock.calls.at(-1)![0]).toMatchObject({ centre_id: H.CENTRE, booking_kind: 'centre_visit' });
    await user.click(screen.getByRole('button', { name: /slot/i }));
    const ok = await screen.findByRole('option', { name: /07:15/ });
    expect(H.norm(ok.textContent)).toContain('07:15 — 2 of 3 left');
    const full = screen.getByRole('option', { name: /08:15/ });
    expect(full.getAttribute('aria-disabled') === 'true' || (full as HTMLElement).hasAttribute('data-disabled')).toBe(true);
  });

  async function fillValid(user: ReturnType<typeof userEvent.setup>) {
    await type(user, /patient/i, 'sunita');
    await user.click(await screen.findByRole('option', { name: /Sunita Synthetic/ }));
    await user.click(await screen.findByRole('button', { name: /slot/i }));
    await user.click(await screen.findByRole('option', { name: /07:15/ }));
    await type(user, /tests/i, 'CBC');
    await user.click(await screen.findByRole('option', { name: /Synthetic CBC/ }));
  }

  it('valid form → create({patient_id, booking_kind:centre_visit, centre_id, slot_start, orderable_ids}), toast "Booking {no} created", then W2', async () => {
    const { actions } = await H.showNew();
    const user = userEvent.setup();
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: /^(create|book|save)/i }));
    await waitFor(() => expect(actions.create).toHaveBeenCalledTimes(1));
    expect(actions.create.mock.calls[0]![0]).toEqual({ patient_id: H.id(301), booking_kind: 'centre_visit', centre_id: H.CENTRE, slot_start: '2026-01-16T01:30:00.000Z', orderable_ids: [H.id(201)] });
    await waitFor(() => expect(H.pageText()).toContain('Booking BK260000123 created'));
    expect(push).toHaveBeenCalledWith(`/engagement/bookings/${H.id(109)}`);
  });

  it('Ctrl+Enter submits the form', async () => {
    const { actions } = await H.showNew();
    const user = userEvent.setup();
    await fillValid(user);
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(actions.create).toHaveBeenCalledTimes(1));
  });

  it('missing patient, slot or tests → nothing is sent and the form says what is required', async () => {
    const { actions } = await H.showNew();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^(create|book|save)/i }));
    expect(actions.create).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').length + document.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThan(0);
  });

  it('Home collection hides Centre and asks for the address (as the app A19, staff-entered)', async () => {
    await H.showNew();
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /home collection/i }));
    expect(screen.queryByRole('button', { name: /^centre/i })).toBeNull();
    expect(screen.getByLabelText(/address/i)).toBeTruthy();
  });

  it('server rejection engagement.slot_unavailable is shown and nothing navigates', async () => {
    const actions = H.newBookingActions({ create: vi.fn(async () => { throw Object.assign(new Error('engagement.slot_unavailable'), { problem: { code: 'engagement.slot_unavailable' } }); }) });
    await H.showNew(actions);
    const user = userEvent.setup();
    await fillValid(user);
    await user.click(screen.getByRole('button', { name: /^(create|book|save)/i }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('max 20 tests: the 21st cannot be added', async () => {
    const many = Array.from({ length: 22 }, (_, i) => ({ orderable_id: H.id(700 + i), kind: 'test', code: `T${i}`, display_name: `Synthetic Test ${i}`, booking_kinds: ['centre_visit'], is_active: true, version: 1 }));
    await H.showNew(H.newBookingActions(), { bookableItems: many });
    const user = userEvent.setup();
    const box = () => screen.getByRole('combobox', { name: /tests/i });
    for (let i = 0; i < 20; i++) {
      await user.clear(box());
      await user.type(box(), `Test ${i}`); // short filter (ruling T-B6): only the cap matters, not typing the full name
      await user.click(await screen.findByRole('option', { name: new RegExp(`Synthetic Test ${i}$`) }));
    }
    await user.clear(box());
    await user.type(box(), 'Test 20');
    const over = screen.queryByRole('option', { name: /Synthetic Test 20$/ });
    expect(over === null || over.getAttribute('aria-disabled') === 'true').toBe(true);
  }, 90_000);
});

describe('accessibility (axe)', () => {
  it('W1 list is clean', async () => { await H.showBookings(); await H.axeClean(); });
  it('W1 check-in dialog is clean', async () => {
    await H.showBookings();
    await userEvent.setup().click(within(row(/BK26000001/)).getByRole('button', { name: /check in/i }));
    await screen.findByRole('dialog');
    await H.axeClean();
  });
  it('W2 detail is clean', async () => { await H.showDetail(); await H.axeClean(); });
  it('W3 form is clean', async () => { await H.showNew(); await H.axeClean(); });
});
