// @vitest-environment jsdom
// HC-T18 — Schedule / Assign / Cancel dialogs (04-UI-UX §2.1; 01-PRD US-03-1, US-03-2, US-03-3, US-03-4, US-03-5 (UI side), US-03-6, US-03-8, US-03-10; TRD §5.1 H3, H5, H6, H12).
// ASSUMED contract (spec fixes folders + kit components; dispute via writer if wrong):
//   * components/ScheduleDialog.tsx  exports `ScheduleDialog({ visit, boardDate, isOpen, onClose })`  — Dialog size=md "Schedule visit"; fields (by label): Date, From, To, Address, Landmark,
//       Latitude, Longitude, Note for phlebotomist; submit button "Schedule". `visit` is VisitSummaryDto or VisitDetailDto (prefills `address`, `note_for_phlebotomist`, window when present).
//   * components/AssignDialog.tsx    exports `AssignDialog({ visit, centreId, boardDate, isOpen, onClose })` — Dialog "Assign visit"; loads H12 (GET /phlebotomists?centre_id&route_date) on open;
//       fields: Phlebotomist (Select), Route date (DatePicker; read-only when the visit has a window), Position (IntegerField 1..60); submit button "Assign".
//   * components/CancelVisitDialog.tsx exports `CancelVisitDialog({ visit, reasons, isOpen, onClose })` — the §2.1 Cancel ConfirmDialog (also used by HC-T19's visit page).
//   * every write goes through features/homecollection/server/actions.ts (server actions) -> API with Bearer, If-Match = visit.version and an Idempotency-Key; success => toast, router.refresh(), onClose().
//   * a retry of the SAME submission after a failure re-sends the SAME Idempotency-Key (US-03-5: replay, not a second order).
//   * server errors are shown as plain sentences (copy from §2.1 where it gives it), never as a problem code.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { API, CENTRE, DATE, U, V1, V2, V3, A1, axeClean, fill, isEnabled, kathmandu, noRawCodes, pick, problem, recorder, userEvent, wrap, type Call } from './hc-t18.helpers';

const refresh = vi.hoisted(() => vi.fn());
const onClose = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/homecollection/dispatch',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['homecollection.visit.read', 'homecollection.visit.assign'], displayName: 'Synthetic Dispatcher', tenantCode: 'syn', roles: [], membershipId: U(9) } }),
  getRequestPathname: async () => '/homecollection/dispatch',
}));

const calls: Call[] = [];
const rec = recorder(calls);
type R = () => Response | Promise<Response>;
const PH = [
  { membership_id: U(5001), display_name: 'Test Phlebo 01', route_id: U(4001), active_visits: 3, route_full: false },
  { membership_id: U(5002), display_name: 'Test Phlebo 02', active_visits: 0, route_full: false },
  { membership_id: U(5003), display_name: 'Test Phlebo 03', route_id: U(4003), active_visits: 40, route_full: true },
];
let schedule: R, assign: R, cancel: R, phlebos: R;
const reset = () => {
  schedule = () => HttpResponse.json({ ...V1, version: 4, status: 'unassigned' });
  assign = () => HttpResponse.json({ ...V2, version: 4, status: 'assigned', order_id: U(6003) });
  cancel = () => HttpResponse.json({ ...V2, version: 4, status: 'cancelled' });
  phlebos = () => HttpResponse.json({ data: PH });
};
reset();
const api = setupServer(
  http.post(`${API}/visits/:id/schedule`, async ({ request }) => { await rec(request); return schedule(); }),
  http.post(`${API}/visits/:id/assign`, async ({ request }) => { await rec(request); return assign(); }),
  http.post(`${API}/visits/:id/cancel`, async ({ request }) => { await rec(request); return cancel(); }),
  http.get(`${API}/phlebotomists`, async ({ request }) => { await rec(request); return phlebos(); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T04:00:00Z')); }); // 13/11/2026 09:45 AM Kathmandu
afterEach(() => { vi.useRealTimers(); cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); onClose.mockReset(); reset(); });
afterAll(() => api.close());

const posts = (suffix: string) => calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith(suffix));
const mod = async <T,>(name: string) => (await import(/* @vite-ignore */ `../components/${name}`)) as T;
const dlgOf = () => screen.findByRole('dialog');
const field = (dlg: HTMLElement, name: RegExp) => within(dlg).getByLabelText(name) as HTMLInputElement;

// ---------------------------------------------------------------- Schedule
const schedView = async (v: unknown = V1) => {
  const { ScheduleDialog } = await mod<{ ScheduleDialog: (p: any) => any }>('ScheduleDialog');
  wrap(<ScheduleDialog visit={v as never} boardDate={DATE} isOpen onClose={onClose} />);
  return dlgOf();
};
const submitSchedule = (dlg: HTMLElement) => userEvent.click(within(dlg).getByRole('button', { name: /^schedule$/i }));
/** Fills a valid schedule: 08:00–09:00 AM Kathmandu on the board date, address "Ward 5, Baneshwor (synthetic)". */
const fillValid = async (dlg: HTMLElement) => {
  await fill(field(dlg, /^from/i), '14/11/2026 08:00 AM');
  await fill(field(dlg, /^to/i), '14/11/2026 09:00 AM');
  await fill(field(dlg, /^address/i), 'Ward 5, Baneshwor (synthetic)');
};

describe('Schedule dialog (US-03-2, §2.1 table)', () => {
  it('Dialog size md titled "Schedule visit"; every §2.1 field is present; Note help text warns against test names', async () => {
    const dlg = await schedView();
    expect(within(dlg).getByRole('heading', { name: /schedule visit/i })).toBeTruthy();
    for (const l of [/^date/i, /^from/i, /^to/i, /^address/i, /^landmark/i, /^latitude/i, /^longitude/i, /^note for phlebotomist/i]) expect(field(dlg, l), String(l)).toBeTruthy();
    expect(within(dlg).getByText("Visible on the phlebotomist's phone. Don't write test names, results or diagnoses.")).toBeTruthy();
  });
  it('defaults: Date = board date; From 07:00 AM, To = From + 30 min (Asia/Kathmandu); empty address', async () => {
    const dlg = await schedView();
    expect(field(dlg, /^date/i).value).toBe('14/11/2026');
    expect(field(dlg, /^from/i).value).toBe('14/11/2026 07:00 AM');
    expect(field(dlg, /^to/i).value).toBe('14/11/2026 07:30 AM');
    expect(field(dlg, /^address/i).value).toBe('');
  });
  it('prefills from the visit: existing window, address, landmark, note, coordinates', async () => {
    const detail = { ...V2, address: { address_text: 'Ward 7, Baneshwor', landmark: 'Near the synthetic temple', latitude: '27.693400', longitude: '85.341200' }, note_for_phlebotomist: 'Ring the bell twice' };
    const dlg = await schedView(detail);
    expect(field(dlg, /^from/i).value).toBe(kathmandu(V2.window_start));
    expect(field(dlg, /^to/i).value).toBe(kathmandu(V2.window_end));
    expect(field(dlg, /^address/i).value).toBe('Ward 7, Baneshwor');
    expect(field(dlg, /^landmark/i).value).toBe('Near the synthetic temple');
    expect(field(dlg, /^note for phlebotomist/i).value).toBe('Ring the bell twice');
    expect(field(dlg, /^latitude/i).value).toMatch(/^27\.6934/);
  });
  it('limits: Address maxLength 500, Landmark 200, Note 500 (so a longer value cannot be typed or pasted)', async () => {
    const dlg = await schedView();
    expect(field(dlg, /^address/i).maxLength).toBe(500);
    expect(field(dlg, /^landmark/i).maxLength).toBe(200);
    expect(field(dlg, /^note for phlebotomist/i).maxLength).toBe(500);
  });
  it('US-03-2 submit: POST /schedule with window_start/window_end (UTC instants), address, landmark, note; If-Match = version, Idempotency-Key, Bearer; toast "Visit scheduled.", refresh, close', async () => {
    const dlg = await schedView();
    await fillValid(dlg);
    await fill(field(dlg, /^landmark/i), 'Opposite the synthetic school');
    await fill(field(dlg, /^note for phlebotomist/i), 'Gate is blue');
    await submitSchedule(dlg);
    await waitFor(() => expect(posts('/schedule')).toHaveLength(1));
    const c = posts('/schedule')[0]!;
    expect(c.url.pathname).toBe(`/v1/homecollection/visits/${V1.id}/schedule`);
    expect(new Date(c.body.window_start).toISOString()).toBe('2026-11-14T02:15:00.000Z');
    expect(new Date(c.body.window_end).toISOString()).toBe('2026-11-14T03:15:00.000Z');
    expect(c.body.address).toEqual({ address_text: 'Ward 5, Baneshwor (synthetic)', landmark: 'Opposite the synthetic school' });
    expect(c.body.note_for_phlebotomist).toBe('Gate is blue');
    expect(c.headers.get('if-match')).toMatch(/3/);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.headers.get('authorization')).toMatch(/^Bearer /);
    expect(await screen.findByText('Visit scheduled.')).toBeTruthy();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalled();
  });
  it('coordinates: both are sent as decimal strings; blank optional fields are omitted from the body (no nulls, no empty strings)', async () => {
    const dlg = await schedView();
    await fillValid(dlg);
    await fill(field(dlg, /^latitude/i), '27.6934');
    await fill(field(dlg, /^longitude/i), '85.3412');
    await submitSchedule(dlg);
    await waitFor(() => expect(posts('/schedule')).toHaveLength(1));
    const b = posts('/schedule')[0]!.body;
    expect(b.address.latitude).toMatch(/^27\.6934\d*$/);
    expect(b.address.longitude).toMatch(/^85\.3412\d*$/);
    expect(JSON.stringify(b)).not.toMatch(/null|""/);
    expect('note_for_phlebotomist' in b).toBe(false);
  });
  it('clearing a previously stored landmark/note sends `unset` (TRD H5), not an empty string', async () => {
    const detail = { ...V2, address: { address_text: 'Ward 7, Baneshwor', landmark: 'Near the synthetic temple' }, note_for_phlebotomist: 'Ring twice' };
    const dlg = await schedView(detail);
    await fill(field(dlg, /^landmark/i), '');
    await fill(field(dlg, /^note for phlebotomist/i), '');
    await submitSchedule(dlg);
    await waitFor(() => expect(posts('/schedule')).toHaveLength(1));
    const b = posts('/schedule')[0]!.body;
    expect([...b.unset].sort()).toEqual(['landmark', 'note_for_phlebotomist']);
    expect(b.address?.landmark).toBeUndefined();
  });

  describe('validation blocks the request and tells the user in words (PRD US-03-2; §2.1 table)', () => {
    const blocked = async (mut: (d: HTMLElement) => Promise<void>, text: RegExp) => {
      const dlg = await schedView();
      await fillValid(dlg);
      await mut(dlg);
      await submitSchedule(dlg);
      await waitFor(() => expect(within(dlg).getAllByText(text).length).toBeGreaterThan(0));
      expect(posts('/schedule')).toHaveLength(0);
      expect(onClose).not.toHaveBeenCalled();
    };
    it('To not after From', () => blocked((d) => fill(field(d, /^to/i), '14/11/2026 08:00 AM'), /after|later|before/i));
    it('window longer than 12 hours', () => blocked((d) => fill(field(d, /^to/i), '14/11/2026 08:15 PM'), /12 hours|12 h/i));
    it('window exactly 12 hours is accepted (boundary)', async () => {
      const dlg = await schedView();
      await fillValid(dlg);
      await fill(field(dlg, /^to/i), '14/11/2026 08:00 PM');
      await submitSchedule(dlg);
      await waitFor(() => expect(posts('/schedule')).toHaveLength(1));
    });
    it('blank / whitespace-only address', () => blocked((d) => fill(field(d, /^address/i), '   '), /required|enter|address/i));
    it('only one of latitude / longitude', () => blocked((d) => fill(field(d, /^latitude/i), '27.6934'), /both|longitude/i));
    it('latitude out of range (−90..90)', () => blocked(async (d) => { await fill(field(d, /^latitude/i), '91'); await fill(field(d, /^longitude/i), '85'); }, /90/));
    it('longitude out of range (−180..180)', () => blocked(async (d) => { await fill(field(d, /^latitude/i), '27'); await fill(field(d, /^longitude/i), '181'); }, /180/));
    it('date in the past (before today, Asia/Kathmandu)', () => blocked(async (d) => { await fill(field(d, /^from/i), '12/11/2026 08:00 AM'); await fill(field(d, /^to/i), '12/11/2026 09:00 AM'); }, /today|past|30 days/i));
    it('date more than 30 days ahead', () => blocked(async (d) => { await fill(field(d, /^from/i), '20/12/2026 08:00 AM'); await fill(field(d, /^to/i), '20/12/2026 09:00 AM'); }, /30 days/i));
  });

  it('server 400 validation_failed shows the problem next to the form (not as a code) and keeps the dialog open with the values', async () => {
    schedule = () => problem('common.validation_failed', 400, { errors: [{ pointer: '/window_end', detail: 'window_end must be after window_start' }] });
    const dlg = await schedView();
    await fillValid(dlg);
    await submitSchedule(dlg);
    await waitFor(() => expect(posts('/schedule')).toHaveLength(1));
    expect((await within(dlg).findAllByText(/after|check|window/i)).length).toBeGreaterThan(0);
    noRawCodes();
    expect(field(dlg, /^address/i).value).toBe('Ward 5, Baneshwor (synthetic)');
    expect(onClose).not.toHaveBeenCalled();
  });
  it.each([
    ['homecollection.visit_closed', 409, /closed|cancelled|completed|no longer/i],
    ['common.version_conflict', 409, /changed|newer|reload|refresh/i],
    ['common.internal', 500, /something went wrong|try again/i],
  ])('server error %s -> plain sentence in an alert, no code, dialog stays open', async (code, status, text) => {
    schedule = () => problem(code, status);
    const dlg = await schedView();
    await fillValid(dlg);
    await submitSchedule(dlg);
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(text);
    noRawCodes();
    expect(onClose).not.toHaveBeenCalled();
  });
  it('retry after a failure re-sends the SAME Idempotency-Key; a double click sends one request', async () => {
    let n = 0;
    schedule = () => (++n === 1 ? problem('common.internal', 500) : HttpResponse.json({ ...V1, version: 4 }));
    const dlg = await schedView();
    await fillValid(dlg);
    await submitSchedule(dlg);
    await within(dlg).findByRole('alert');
    await userEvent.dblClick(within(dlg).getByRole('button', { name: /^schedule$/i }));
    await waitFor(() => expect(posts('/schedule')).toHaveLength(2));
    const [a, b] = posts('/schedule');
    expect(a!.headers.get('idempotency-key')).toBeTruthy();
    expect(b!.headers.get('idempotency-key')).toBe(a!.headers.get('idempotency-key'));
  });
  it('submit is disabled while the request is in flight; Ctrl+Enter submits (kit default); Escape closes without a request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    schedule = async () => { await gate; return HttpResponse.json({ ...V1, version: 4 }); };
    const dlg = await schedView();
    await fillValid(dlg);
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(posts('/schedule')).toHaveLength(1));
    expect(isEnabled(within(dlg).getByRole('button', { name: /^schedule$/i }))).toBe(false);
    release();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
  it('Escape closes without a request', async () => {
    const dlg = await schedView();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posts('/schedule')).toHaveLength(0);
    void dlg;
  });
  it('axe clean (open, and with validation errors showing)', async () => {
    const dlg = await schedView();
    await axeClean();
    await fill(field(dlg, /^address/i), ' ');
    await submitSchedule(dlg);
    await waitFor(() => expect(within(dlg).getAllByText(/required|enter|address/i).length).toBeGreaterThan(0));
    await axeClean();
  });
});

// ---------------------------------------------------------------- Assign
const assignView = async (v: unknown = V2) => {
  const { AssignDialog } = await mod<{ AssignDialog: (p: any) => any }>('AssignDialog');
  wrap(<AssignDialog visit={v as never} centreId={CENTRE} boardDate={DATE} isOpen onClose={onClose} />);
  const dlg = await dlgOf();
  await within(dlg).findByRole('button', { name: /phlebotomist/i });
  return dlg;
};
const submitAssign = (dlg: HTMLElement) => userEvent.click(within(dlg).getByRole('button', { name: /^assign$/i }));
const choose = (dlg: HTMLElement, name: RegExp) => pick(dlg, name, /phlebotomist/i);

describe('Assign dialog (US-03-3, US-03-6, US-03-8, US-03-10; H12 + H3)', () => {
  it('loads H12 for the centre and route date; options read "{name} — {n} visits today"; a full route/day is disabled with "(route full)" and cannot be chosen', async () => {
    const dlg = await assignView();
    const h12 = calls.find((c) => c.method === 'GET' && c.url.pathname.endsWith('/phlebotomists'))!;
    expect(h12.url.searchParams.get('centre_id')).toBe(CENTRE);
    expect(h12.url.searchParams.get('route_date')).toBe(DATE);
    await userEvent.click(within(dlg).getByRole('button', { name: /phlebotomist/i }));
    expect(await screen.findByRole('option', { name: 'Test Phlebo 01 — 3 visits today' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Test Phlebo 02 — 0 visits today' })).toBeTruthy();
    const full = screen.getByRole('option', { name: /Test Phlebo 03.*\(route full\)/ });
    expect(full.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(full);
    expect(within(dlg).getByRole('button', { name: /phlebotomist/i }).textContent).not.toMatch(/Phlebo 03/);
  });
  it('Route date = the visit window date and read-only when a window is set; editable (default board date) when not; Position has min 1 / max 60 and is empty by default', async () => {
    let dlg = await assignView(V2);
    const rd = field(dlg, /^route date/i);
    expect(rd.value).toBe('14/11/2026');
    expect(rd.readOnly || rd.disabled || rd.getAttribute('aria-readonly') === 'true').toBe(true);
    const pos = within(dlg).getByRole('spinbutton', { name: /position/i }) as HTMLInputElement;
    expect(pos.value).toBe('');
    expect(Number(pos.getAttribute('aria-valuemin') ?? pos.min)).toBe(1);
    expect(Number(pos.getAttribute('aria-valuemax') ?? pos.max)).toBe(60);
    cleanup();
    dlg = await assignView(V1);
    const rd2 = field(dlg, /^route date/i);
    expect(rd2.value).toBe('14/11/2026');
    expect(rd2.readOnly || rd2.disabled).toBe(false);
  });
  it('info banner "Assigning registers the order and issues the bill in front desk." for booking visits only', async () => {
    await assignView(V2);
    expect(screen.getByText('Assigning registers the order and issues the bill in front desk.')).toBeTruthy();
    cleanup();
    await assignView(V3);
    expect(screen.queryByText('Assigning registers the order and issues the bill in front desk.')).toBeNull();
  });
  it('US-03-3 submit: POST /assign { phlebotomist_membership_id, route_date } (route_sequence omitted when blank) with If-Match = version, Idempotency-Key, Bearer; refresh + close', async () => {
    const dlg = await assignView();
    await choose(dlg, /Test Phlebo 01/);
    await submitAssign(dlg);
    await waitFor(() => expect(posts('/assign')).toHaveLength(1));
    const c = posts('/assign')[0]!;
    expect(c.url.pathname).toBe(`/v1/homecollection/visits/${V2.id}/assign`);
    expect(c.body).toEqual({ phlebotomist_membership_id: U(5001), route_date: DATE });
    expect(c.headers.get('if-match')).toMatch(/3/);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.headers.get('authorization')).toMatch(/^Bearer /);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalled();
  });
  it('Position is sent as an integer route_sequence', async () => {
    const dlg = await assignView();
    await choose(dlg, /Test Phlebo 02/);
    await userEvent.type(within(dlg).getByRole('spinbutton', { name: /position/i }), '2');
    await submitAssign(dlg);
    await waitFor(() => expect(posts('/assign')).toHaveLength(1));
    expect(posts('/assign')[0]!.body).toEqual({ phlebotomist_membership_id: U(5002), route_date: DATE, route_sequence: 2 });
  });
  it('Assign is blocked until a phlebotomist is chosen; Position outside 1..60 blocks the request', async () => {
    const dlg = await assignView();
    await submitAssign(dlg);
    expect(posts('/assign')).toHaveLength(0);
    await choose(dlg, /Test Phlebo 01/);
    await userEvent.type(within(dlg).getByRole('spinbutton', { name: /position/i }), '61');
    await submitAssign(dlg);
    expect(posts('/assign')).toHaveLength(0);
  });
  it.each([
    ['common.validation_failed', 400, { errors: [{ pointer: '/phlebotomist_membership_id', detail: 'route full' }] }, "This phlebotomist's route is full for that day."],
    ['homecollection.visit_incomplete', 422, {}, 'Add an address and a time window first.'],
    ['homecollection.phlebotomist_not_eligible', 422, {}, "This person can't take visits for this centre."],
    ['frontdesk.consent_required', 422, {}, "The patient's consent is missing in front desk. Ask front desk to complete registration."],
    ['catalog.no_price', 422, {}, 'A booked test has no price. Ask the lab manager to fix the price list.'],
    ['catalog.test_inactive', 422, {}, 'A booked test is no longer offered.'],
  ] as const)('US-03-4 error %s (HTTP %d, %j) -> §2.1 copy "%s", nothing closes, no code shown', async (code, status, extra, copy) => {
    assign = () => problem(code, status, extra as Record<string, unknown>);
    const dlg = await assignView();
    await choose(dlg, /Test Phlebo 01/);
    await submitAssign(dlg);
    expect(await within(dlg).findByText(copy)).toBeTruthy();
    noRawCodes();
    expect(onClose).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
  it('closed visit / version conflict / generic failure -> plain sentences in an alert', async () => {
    for (const [code, status, text] of [['homecollection.visit_closed', 409, /closed|cancelled|completed|no longer/i], ['common.version_conflict', 409, /changed|newer|reload|refresh/i], ['common.internal', 500, /something went wrong|try again/i]] as const) {
      assign = () => problem(code, status);
      const dlg = await assignView();
      await choose(dlg, /Test Phlebo 01/);
      await submitAssign(dlg);
      expect((await within(dlg).findByRole('alert')).textContent, code).toMatch(text);
      noRawCodes();
      cleanup(); calls.length = 0;
    }
  });
  it('US-03-5 (UI): retry after a failure re-sends the SAME Idempotency-Key (server replays); double click sends one request', async () => {
    let n = 0;
    assign = () => (++n === 1 ? problem('common.internal', 500) : HttpResponse.json({ ...V2, version: 4, status: 'assigned' }));
    const dlg = await assignView();
    await choose(dlg, /Test Phlebo 01/);
    await submitAssign(dlg);
    await within(dlg).findByRole('alert');
    await userEvent.dblClick(within(dlg).getByRole('button', { name: /^assign$/i }));
    await waitFor(() => expect(posts('/assign')).toHaveLength(2));
    const [a, b] = posts('/assign');
    expect(b!.headers.get('idempotency-key')).toBe(a!.headers.get('idempotency-key'));
  });
  it('a changed choice after a failure is a NEW submission (new Idempotency-Key) — never reuse a key with a different body (idempotency_key_reused)', async () => {
    let n = 0;
    assign = () => (++n === 1 ? problem('homecollection.phlebotomist_not_eligible', 422) : HttpResponse.json({ ...V2, version: 4, status: 'assigned' }));
    const dlg = await assignView();
    await choose(dlg, /Test Phlebo 01/);
    await submitAssign(dlg);
    await within(dlg).findByText(/can't take visits/i);
    await choose(dlg, /Test Phlebo 02/);
    await submitAssign(dlg);
    await waitFor(() => expect(posts('/assign')).toHaveLength(2));
    const [a, b] = posts('/assign');
    expect(b!.body.phlebotomist_membership_id).toBe(U(5002));
    expect(b!.headers.get('idempotency-key')).not.toBe(a!.headers.get('idempotency-key'));
  });
  it('H12 failure: plain message, Assign disabled, no request', async () => {
    phlebos = () => problem('common.internal', 500);
    const { AssignDialog } = await mod<{ AssignDialog: (p: any) => any }>('AssignDialog');
    wrap(<AssignDialog visit={V2 as never} centreId={CENTRE} boardDate={DATE} isOpen onClose={onClose} />);
    const dlg = await dlgOf();
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(/couldn't load|try again|something went wrong/i);
    noRawCodes();
    expect(isEnabled(within(dlg).getByRole('button', { name: /^assign$/i }))).toBe(false);
  });
  it('reassign of an already assigned visit (US-03-7) uses the same dialog and endpoint, preselecting nobody', async () => {
    const dlg = await assignView(A1);
    expect(within(dlg).getByRole('button', { name: /phlebotomist/i }).textContent).not.toMatch(/Test Phlebo 0\d —/);
    await choose(dlg, /Test Phlebo 02/);
    await submitAssign(dlg);
    await waitFor(() => expect(posts('/assign')).toHaveLength(1));
    expect(posts('/assign')[0]!.url.pathname).toBe(`/v1/homecollection/visits/${A1.id}/assign`);
  });
  it('axe clean (open; with an error showing)', async () => {
    const dlg = await assignView();
    await axeClean();
    assign = () => problem('homecollection.visit_incomplete', 422);
    await choose(dlg, /Test Phlebo 01/);
    await submitAssign(dlg);
    await within(dlg).findByText('Add an address and a time window first.');
    await axeClean();
  });
});

// ---------------------------------------------------------------- Cancel (standalone)
describe('CancelVisitDialog (§2.1; shared with HC-T19)', () => {
  const REASONS = [{ code: 'duplicate', display: 'Duplicate visit', requires_text: false, is_active: true }, { code: 'other', display: 'Other', requires_text: true, is_active: true }];
  const cview = async (v: unknown) => {
    const { CancelVisitDialog } = await mod<{ CancelVisitDialog: (p: any) => any }>('CancelVisitDialog');
    wrap(<CancelVisitDialog visit={v as never} reasons={REASONS} isOpen onClose={onClose} />);
    return dlgOf();
  };
  const EXTRA = 'The order and bill in front desk are not cancelled automatically.';
  it('assigned BOOKING visit: extra line about the order and bill; unassigned booking and assigned front-desk visits do not show it', async () => {
    const dlg = await cview({ ...V2, status: 'assigned', order_id: U(6003) });
    expect(within(dlg).getByText(EXTRA)).toBeTruthy();
    cleanup();
    expect(within(await cview(V2)).queryByText(EXTRA)).toBeNull();
    cleanup();
    expect(within(await cview({ ...V3, status: 'assigned' })).queryByText(EXTRA)).toBeNull();
  });
  it('confirm without reason sends nothing; with reason + text POSTs /cancel; then closes and refreshes', async () => {
    const dlg = await cview(V2);
    const ok = () => within(dlg).getByRole('button', { name: /^cancel visit$|^confirm$|^cancel this visit$/i });
    await userEvent.click(ok());
    expect(posts('/cancel')).toHaveLength(0);
    await pick(dlg, 'Other', /reason/i);
    await userEvent.click(ok());
    expect(posts('/cancel')).toHaveLength(0); // "Other" requires text
    await userEvent.type(within(dlg).getByRole('textbox'), 'Patient travelled (synthetic)');
    await userEvent.click(ok());
    await waitFor(() => expect(posts('/cancel')).toHaveLength(1));
    expect(posts('/cancel')[0]!.body).toEqual({ reason_code: 'other', reason_text: 'Patient travelled (synthetic)' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalled();
  });
  it('free text is limited to 500 characters; axe clean', async () => {
    const dlg = await cview(V2);
    expect((within(dlg).getByRole('textbox') as HTMLTextAreaElement | HTMLInputElement).maxLength).toBe(500);
    await axeClean();
  });
});
