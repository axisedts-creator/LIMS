// C16.T-B6 shared harness (tester-owned, not a test file). Synthetic data only. Fixtures follow contracts/openapi/engagement.yaml
// (StaffBooking, StaffBookingDetail, StaffSlot, SlotTemplate, SlotBlackout, StaffBookableItem, Queue — snake_case, `id` not `*_id`).
//
// ASSUMED CONTRACT (spec gives screens, not component props — a dispute may refine it). All components are NAMED exports, client components
// in features/engagement/components/, props injected, no fetch inside the component except through `actions` (BFF server actions):
//   BookingsList.tsx   BookingsList({ centres, workingCentreId, today, rows, queues, cancelReasons, actions })      W1
//     rows: StaffBooking & { patient_name?: string | null }   (name fetched server-side from C4; null/absent => "—")
//     actions: listBookings(query): Promise<Row[]>  query = { centre_id, booking_kind?, status[], slot_start_from, slot_start_to, sort }
//              checkIn(booking, { issue_token, queue_id?, priority? }): Promise<void>      cancel(booking, { reason_code }): Promise<void>
//   BookingDetail.tsx  BookingDetail({ booking, timeline, queues, cancelReasons, actions })                          W2
//     timeline: { status, at, actor_kind }[]; actions: checkIn / cancel as above
//   BookingNew.tsx     BookingNew({ centres, workingCentreId, today, bookableItems, actions })                      W3
//     actions: searchPatients(q): Promise<{id, name, patient_code, age, sex}[]>   listSlots({centre_id, booking_kind, date}): Promise<StaffSlot[]>
//              create(body): Promise<StaffBooking>   body = createBookingForPatient request { patient_id, booking_kind, centre_id?, slot_start, orderable_ids, home_address? }
//   SlotsAdmin.tsx     SlotsAdmin({ centres, workingCentreId, today, templates, blackouts, actions })                W4
//     actions: createTemplate(body)/updateTemplate(template, body) => SlotTemplate & { affected: { overbooked_slots } }   deactivateTemplate(template)
//              createBlackout(body) => SlotBlackout & { affected: { future_bookings } }                         deactivateBlackout(blackout)
//   BookableCatalogue.tsx BookableCatalogue({ items, actions })                                                    W5
//     actions: setActive(item, is_active) (inline Switch save)   searchCatalog(q): Promise<{orderable_id, orderable_kind, code, display_name}[]>
//              add({ orderable_id, orderable_kind, booking_kinds, is_active }) refresh(): Promise<void>
//   Page registry ids for shortcuts = route ids in contracts/routes.yaml: staff.engagement.bookings / .slots / .bookable.
import { expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { ToastProvider } from '@lims/ui/components/Toast';

export const id = (n: number) => `01950c16-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const CENTRE = id(1), CENTRE2 = id(2);
export const TODAY = '2026-01-15'; // fake "today" in Asia/Kathmandu (UTC+05:45)
export const TODAY_START_UTC = '2026-01-14T18:15:00.000Z'; // 2026-01-15 00:00 Asia/Kathmandu
export const Q1 = id(11), Q2 = id(12);
export const centres = () => [
  { id: CENTRE, display_name: 'Synthetic Centre A', is_home_collection: false },
  { id: CENTRE2, display_name: 'Synthetic Home Hub', is_home_collection: true },
];
export const queues = () => [
  { id: Q1, centre_id: CENTRE, code: 'registration', display_name: 'A — Registration', token_prefix: 'A', sort_order: 0, is_active: true, version: 1 },
  { id: Q2, centre_id: CENTRE, code: 'sample', display_name: 'B — Sample collection', token_prefix: 'B', sort_order: 1, is_active: true, version: 1 },
];
export const cancelReasons = () => [
  { code: 'patient_request', label: 'Patient request' },
  { code: 'lab_unavailable', label: 'Lab unavailable' },
];
const item = (n: number, name: string, price?: number) => ({ orderable_id: id(200 + n), display_name: name, ...(price ? { indicative_price: { amount_paisa: price, currency: 'NPR' } } : {}) });
/** B1 confirmed centre visit (07:15 Kathmandu), B2 checked-in with order + token, B3 cancelled, B4 home collection without patient name. */
export const booking = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(100 + n), booking_no: `BK2600000${n}`, booking_kind: 'centre_visit', centre_id: CENTRE, centre_display_name: 'Synthetic Centre A',
  slot_start: '2026-01-15T01:30:00.000Z', slot_end: '2026-01-15T01:45:00.000Z', status: 'confirmed',
  items: [item(1, 'Synthetic CBC', 35000), item(2, 'Synthetic Lipid Panel', 90000)], created_via: 'staff', version: 1,
  patient_id: id(300 + n), account_present: false, patient_name: `Sunita Synthetic ${n}`, ...over,
});
export const bookings = () => [
  booking(1),
  booking(2, { status: 'checked_in', created_via: 'app', account_present: true, order_id: id(500), queue_token_id: id(600), checked_in_at: '2026-01-15T01:40:00.000Z', slot_start: '2026-01-15T02:00:00.000Z', slot_end: '2026-01-15T02:15:00.000Z' }),
  booking(3, { status: 'cancelled', cancel_reason_code: 'patient_request', cancelled_by_kind: 'staff', slot_start: '2026-01-15T03:00:00.000Z', slot_end: '2026-01-15T03:15:00.000Z' }),
  booking(4, { booking_kind: 'home_collection', patient_name: null, slot_start: '2026-01-15T04:00:00.000Z', slot_end: '2026-01-15T04:15:00.000Z', items: [item(3, 'Synthetic HbA1c')] }),
];
export const timeline = () => [
  { status: 'confirmed', at: '2026-01-14T05:00:00.000Z', actor_kind: 'staff' },
  { status: 'checked_in', at: '2026-01-15T01:40:00.000Z', actor_kind: 'staff' },
];
export const slot = (n: number, over: Record<string, unknown> = {}) => ({
  slot_start: `2026-01-16T0${n}:30:00.000Z`, slot_end: `2026-01-16T0${n}:45:00.000Z`, remaining: 2, booking_kind: 'centre_visit', centre_id: CENTRE, capacity: 3, booked: 1, overbooked: false, ...over,
});
/** 07:15 (2 of 3 left), 08:15 full-but-overbooked (disabled), 09:15 (1 of 3 left) in Kathmandu time. */
export const slots = () => [slot(1), slot(2, { remaining: 0, capacity: 3, booked: 4, overbooked: true }), slot(3, { remaining: 1, booked: 2 })];
export const patients = () => [
  { id: id(301), name: 'Sunita Synthetic', patient_code: 'P-000101', age: 34, sex: 'F' },
  { id: id(302), name: 'Sunil Synthetic', patient_code: 'P-000102', age: 41, sex: 'M' },
];
export const bookableItems = () => [
  { orderable_id: id(201), kind: 'test', code: 'CBC', display_name: 'Synthetic CBC', booking_kinds: ['centre_visit', 'home_collection'], indicative_price: { amount_paisa: 35000, currency: 'NPR' }, synced_at: '2026-01-14T21:00:00.000Z', is_active: true, version: 1 },
  { orderable_id: id(202), kind: 'panel', code: 'LIPID', display_name: 'Synthetic Lipid Panel', booking_kinds: ['centre_visit'], indicative_price: { amount_paisa: 90000, currency: 'NPR' }, synced_at: '2026-01-14T21:00:00.000Z', is_active: true, version: 1 },
  { orderable_id: id(203), kind: 'test', code: 'HBA1C', display_name: 'Synthetic HbA1c', booking_kinds: ['home_collection'], synced_at: '2026-01-14T21:00:00.000Z', is_active: false, version: 3 },
];
export const templates = () => [
  { id: id(401), centre_id: CENTRE, booking_kind: 'centre_visit', weekdays: [1, 2, 3, 4, 5], start_local: '07:00', end_local: '11:00', slot_minutes: 15, capacity: 3, effective_from: '2026-01-01', is_active: true, version: 1 },
  { id: id(402), centre_id: CENTRE2, booking_kind: 'home_collection', weekdays: [6], start_local: '06:30', end_local: '09:30', slot_minutes: 30, capacity: 5, effective_from: '2026-01-01', effective_to: '2026-06-30', is_active: false, version: 2 },
];
export const blackouts = () => [
  { id: id(451), centre_id: CENTRE, booking_kind: 'centre_visit', starts_at: '2026-02-01T00:00:00.000Z', ends_at: '2026-02-02T00:00:00.000Z', reason_code: 'holiday', note: 'Synthetic festival', is_active: true, version: 1 },
];

export function bookingsActions(over: Record<string, unknown> = {}) {
  return {
    listBookings: vi.fn(async (_q: unknown) => bookings()),
    checkIn: vi.fn(async (_b: unknown, _body: unknown) => {}),
    cancel: vi.fn(async (_b: unknown, _body: unknown) => {}),
    ...over,
  };
}
export function newBookingActions(over: Record<string, unknown> = {}) {
  return {
    searchPatients: vi.fn(async (_q: string) => patients()),
    listSlots: vi.fn(async (_q: unknown) => slots()),
    create: vi.fn(async (_body: unknown) => booking(9, { booking_no: 'BK260000123' })),
    ...over,
  };
}
export function slotsActions(over: Record<string, unknown> = {}) {
  return {
    createTemplate: vi.fn(async (b: any) => ({ ...templates()[0], ...b, id: id(499), version: 1, affected: { overbooked_slots: 0 } })),
    updateTemplate: vi.fn(async (t: any, b: any) => ({ ...t, ...b, version: t.version + 1, affected: { overbooked_slots: 0 } })),
    deactivateTemplate: vi.fn(async (_t: unknown) => {}),
    createBlackout: vi.fn(async (b: any) => ({ ...blackouts()[0], ...b, id: id(498), affected: { future_bookings: 0 } })),
    deactivateBlackout: vi.fn(async (_b: unknown) => {}),
    ...over,
  };
}
export function catalogueActions(over: Record<string, unknown> = {}) {
  return {
    setActive: vi.fn(async (_i: unknown, _active: boolean) => {}),
    searchCatalog: vi.fn(async (_q: string) => [{ orderable_id: id(210), orderable_kind: 'test', code: 'TSH', display_name: 'Synthetic TSH' }]),
    add: vi.fn(async (_b: unknown) => {}),
    refresh: vi.fn(async () => {}),
    ...over,
  };
}

// Template-literal path on purpose: a missing component fails only its own tests (static literals fail the whole suite at transform time).
const load = async (file: string, name: string) => ((await import(/* @vite-ignore */ `../components/${file}`)) as Record<string, (p: any) => any>)[name]!;
export async function showBookings(actions = bookingsActions(), props: Record<string, unknown> = {}) {
  const C = await load('BookingsList', 'BookingsList');
  const view = render(<ToastProvider><C centres={centres()} workingCentreId={CENTRE} today={TODAY} rows={bookings()} queues={queues()} cancelReasons={cancelReasons()} actions={actions} {...props} /></ToastProvider>);
  return { ...view, actions };
}
export async function showDetail(actions = bookingsActions(), props: Record<string, unknown> = {}) {
  const C = await load('BookingDetail', 'BookingDetail');
  const view = render(<ToastProvider><C booking={bookings()[0]} timeline={timeline()} queues={queues()} cancelReasons={cancelReasons()} actions={actions} {...props} /></ToastProvider>);
  return { ...view, actions };
}
export async function showNew(actions = newBookingActions(), props: Record<string, unknown> = {}) {
  const C = await load('BookingNew', 'BookingNew');
  const view = render(<ToastProvider><C centres={centres()} workingCentreId={CENTRE} today={TODAY} bookableItems={bookableItems()} actions={actions} {...props} /></ToastProvider>);
  return { ...view, actions };
}
export async function showSlots(actions = slotsActions(), props: Record<string, unknown> = {}) {
  const C = await load('SlotsAdmin', 'SlotsAdmin');
  const view = render(<ToastProvider><C centres={centres()} workingCentreId={CENTRE} today={TODAY} templates={templates()} blackouts={blackouts()} actions={actions} {...props} /></ToastProvider>);
  return { ...view, actions };
}
export async function showCatalogue(actions = catalogueActions(), props: Record<string, unknown> = {}) {
  const C = await load('BookableCatalogue', 'BookableCatalogue');
  const view = render(<ToastProvider><C items={bookableItems()} actions={actions} {...props} /></ToastProvider>);
  return { ...view, actions };
}

export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export const pageText = () => norm(document.body.textContent);
export async function axeClean() {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
}
/** Kit Select (react-aria): trigger is a button named "<label> <value>", options render in a listbox. */
export async function pick(user: ReturnType<typeof userEvent.setup>, label: RegExp, option: RegExp) {
  await user.click(screen.getByRole('button', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}
export const dataRows = (g: HTMLElement) => within(g).getAllByRole('row').slice(1);
export const rowOf = (g: HTMLElement, re: RegExp) => dataRows(g).find((r) => re.test(norm(r.textContent)));
export const chips = () => Array.from(document.querySelectorAll('.lims-chip')).map((c) => ({ text: norm(c.textContent), tone: c.getAttribute('data-tone') ?? '' }));
export const hasChip = (re: RegExp) => chips().some((c) => re.test(c.text) && /^(neutral|info|success|warning|danger|critical)$/.test(c.tone));
export const SHORTCUT_BOOKINGS = 'staff.engagement.bookings';
export const shortcut = async (page: string, re: RegExp) => (await import('@/core/shortcuts/registry')).shortcuts.list(page).find((s) => re.test(s.key));
