// @vitest-environment jsdom
// HC-T19 — visit detail W2 (04-UI-UX §2.2; TRD H2/H7/H8/H21; 01-PRD US-16-1, US-16-2 (UI side), flags; 07-SECURITY §3 "H2 and H21 phone reveal audited", REQ-SEC-096/097).
// ASSUMED contract (dispute via the writer if wrong):
//   * components/VisitDetailView.tsx exports `VisitDetailView({ visit, permissions, codes })` — `visit` = VisitDetailDto (TRD §5.3), `permissions` = actor permission keys,
//     `codes` = { review_reasons, flag_resolutions, visit_cancel_reasons, unassign_reasons, revisit_reasons } (H20 rows). Client component; every write goes through server actions.
//   * `<h1>` "Home visit" + status chip (word + icon). Cards (h2): "Patient and address", "Schedule", "Tubes", "On hold" (only with held collections), "Payments", "Needs attention", "Timeline".
//   * Phone row: masked "••••" until the "Show phone" IconButton (accessible name /show phone/i) is pressed -> ONE `POST /visits/{id}/phone-reveal` with body {} per press (H21; the access-log row is
//     written by the API). The number is only in the DOM after that. Failure -> plain words, still masked. Absent number -> "No phone number on file."
//   * "Patient and address" card, Show phone, Review, Resolve and all header actions need `homecollection.visit.assign`; "Print labels" also `lab.specimen.label_print` + order_id.
//   * header actions by status (hidden in closed states): unassigned = Schedule, Assign, Cancel; assigned = Schedule, Reassign, Unassign, Cancel; Create revisit for failed or completed+partial;
//     "Open order" link -> /frontdesk/orders/{order_id} (routes.yaml staff.frontdesk.order); "Print labels" link -> /lab/orders/{order_id}/labels.
//   * Needs attention: each flag as word + tone icon (labels.ts FLAG); open flags have "Resolve" -> ConfirmDialog with homecollection.flag_resolutions -> H8 POST /visits/{id}/flags/{flag_id}/resolve
//     { resolution_code, note? } with Idempotency-Key + If-Match = flag.version.
//   * Create revisit -> ConfirmDialog with revisit_reasons -> H7 POST /visits/{id}/revisits { reason_code, reason_text? } (Idempotency-Key, If-Match = visit.version); on 201 router.push to the NEW visit.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { API, CODES19, ORDER_ID, PERMS_REVIEW, PHONE, U, VISIT_ID, axeClean, detail, isEnabled, noRawCodes, pick, problem, recorder, userEvent, wrap, type Call } from './hc-t19.helpers';

const refresh = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => `/homecollection/visits/x`,
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: PERMS_REVIEW, displayName: 'Synthetic Dispatcher', tenantCode: 'syn', roles: [], membershipId: U(9) } }),
  getRequestPathname: async () => `/homecollection/visits/${VISIT_ID}`,
}));

const calls: Call[] = [];
const rec = recorder(calls);
type R = () => Response | Promise<Response>;
let reveal: R, resolve: R, revisit: R;
const reset = () => {
  reveal = () => HttpResponse.json({ phone_e164: PHONE });
  resolve = () => HttpResponse.json({ id: U(8101), version: 2, kind: 'held_collection', status: 'resolved', created_at: '2026-11-14T03:20:00.000Z', resolution_code: 'handled' });
  revisit = () => HttpResponse.json(detail({ id: U(1043), kind: 'revisit', status: 'unassigned', parent_visit_id: VISIT_ID }), { status: 201 });
};
reset();
const api = setupServer(
  http.post(`${API}/visits/:id/phone-reveal`, async ({ request }) => { await rec(request); return reveal(); }),
  http.post(`${API}/visits/:id/flags/:flag/resolve`, async ({ request }) => { await rec(request); return resolve(); }),
  http.post(`${API}/visits/:id/revisits`, async ({ request }) => { await rec(request); return revisit(); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-14T05:00:00Z')); });
afterEach(() => { vi.useRealTimers(); cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); push.mockReset(); reset(); });
afterAll(() => api.close());

const posts = (suffix: string) => calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith(suffix));
const view = async (visit: Record<string, unknown> = detail(), permissions: string[] = PERMS_REVIEW) => {
  const path = '../components/VisitDetailView'; // variable path: a missing file fails each test, not the whole suite
  const { VisitDetailView } = (await import(/* @vite-ignore */ path)) as { VisitDetailView: (p: any) => any };
  wrap(<VisitDetailView visit={visit as never} permissions={permissions} codes={CODES19} />);
};
/** The Card whose h2 matches. */
const card = (name: RegExp | string) => screen.getByRole('heading', { level: 2, name }).closest('.lims-card') as HTMLElement;
const btn = (name: RegExp, scope: HTMLElement | Document = document) => within(scope as HTMLElement).queryByRole('button', { name });
const act = (name: RegExp) => screen.queryByRole('button', { name }) ?? screen.queryByRole('link', { name });
const text = () => document.body.textContent ?? '';

describe('layout (§2.2)', () => {
  it('h1 "Home visit", status chip with word, kind, patient name, window (Asia/Kathmandu), phlebotomist; one h1 only', async () => {
    await view();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Home visit' })).toBeTruthy();
    expect(text()).toContain('Assigned');
    expect(text()).toContain('Booking');
    expect(text()).toContain('Test Patient 0042');
    expect(text()).toContain('Test Phlebo 01');
    expect(text()).toMatch(/08:45\s*AM/); // 03:00Z = 08:45 Kathmandu
  });
  it('every card of §2.2 is present for a dispatcher with a held collection', async () => {
    await view();
    for (const n of ['Patient and address', 'Schedule', 'Tubes', 'On hold', 'Payments', 'Needs attention']) expect(screen.getByRole('heading', { level: 2, name: n }), n).toBeTruthy();
    expect(screen.getByText(/timeline/i)).toBeTruthy();
  });
  it('Patient and address: name, address, landmark, coordinates, note; Schedule: route date, sequence, phlebotomist', async () => {
    await view();
    const p = card('Patient and address');
    for (const w of ['Test Patient 0042', 'Ward 5, Baneshwor (synthetic)', 'Near the synthetic temple', '27.6934', '85.3412', 'Ring the bell twice']) expect(p.textContent, w).toContain(w);
    const s = card('Schedule');
    expect(s.textContent).toContain('Test Phlebo 01');
    expect(s.textContent).toMatch(/\b2\b/); // sequence
  });
  it('Tubes table: specimen type, container, lab status, collection chip words (Applied / On hold), scan method ("Typed — not verified" for an unverified typed barcode)', async () => {
    await view();
    const t = within(card('Tubes')).getByRole('table');
    for (const h of [/specimen type/i, /container/i, /lab status/i, /collected at/i, /collection/i, /scan/i]) expect(within(t).getAllByRole('columnheader').some((c) => h.test(c.textContent ?? '')), String(h)).toBe(true);
    expect(within(t).getAllByRole('row')).toHaveLength(1 + 3);
    expect(t.textContent).toMatch(/Applied/);
    expect(t.textContent).toMatch(/On hold/);
    expect(t.textContent).toContain('Typed — not verified');
    expect(t.textContent).toMatch(/Camera/);
    expect(t.textContent).toMatch(/Scanner/);
  });
  it('Payments: method, amount as money (Rs. 1,200.00), captured time; "Open billing" links to the front-desk order page', async () => {
    await view();
    const p = card('Payments');
    expect(p.textContent).toMatch(/Cash/i);
    expect(p.textContent).toContain('Rs. 1,200.00');
    expect(within(p).getByRole('link', { name: /open billing/i }).getAttribute('href')).toMatch(new RegExp(`/frontdesk/orders/${ORDER_ID}$`));
  });
  it('Timeline lists transitions, assignments by actor names; Needs attention shows each flag as WORD + icon (never colour alone) and resolved flags as resolved', async () => {
    await view();
    expect(text()).toContain('Test Dispatcher 07');
    const n = card('Needs attention');
    expect(n.textContent).toContain('Collection on hold');
    expect(n.textContent).toContain('Address needed');
    expect(n.textContent).toMatch(/resolved/i);
    expect(n.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2);
  });
  it('an unknown flag kind is shown as readable text; no problem code or internal identifier is ever shown', async () => {
    await view(detail({ flags: [{ id: U(8199), version: 1, kind: 'future_flag', status: 'open', created_at: '2026-11-14T03:20:00.000Z' }] }));
    expect(card('Needs attention').textContent).toContain('Future flag');
    noRawCodes();
    expect(text()).not.toMatch(/mutation_superseded|barcode_mismatch|held_collection|front_desk/);
  });
  it('On hold card is absent when no collection is held; Tubes card shows an empty state, not a broken table, when there are no specimens', async () => {
    await view(detail({ collections: [], specimens: [], flags: [], open_flag_kinds: [] }));
    expect(screen.queryByRole('heading', { level: 2, name: 'On hold' })).toBeNull();
    expect(within(card('Tubes')).queryByRole('table') ?? card('Tubes')).toBeTruthy();
  });
  it('axe clean', async () => {
    await view();
    await axeClean();
  });
});

describe('permissions: only visit.assign holders see the patient card, phone reveal and write controls (§2.2, 07-SECURITY H2/H21)', () => {
  it('read-only actor: no patient-and-address card, no Show phone, no Review, no Resolve, no header actions; page still renders status and tubes', async () => {
    await view(detail(), ['homecollection.visit.read']);
    expect(screen.queryByRole('heading', { level: 2, name: 'Patient and address' })).toBeNull();
    expect(act(/show phone/i)).toBeNull();
    for (const n of [/^review$/i, /^resolve$/i, /^schedule$/i, /^assign$/i, /^reassign$/i, /^unassign$/i, /^cancel/i, /create revisit/i, /print labels/i]) expect(act(n), String(n)).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Tubes' })).toBeTruthy();
    expect(text()).not.toContain('Baneshwor');
  });
});

describe('US-16-2: phone reveal (H21)', () => {
  it('the number is not in the DOM on load; the phone row is masked "••••" and no request has been made', async () => {
    await view();
    expect(text()).not.toContain('9779800000042');
    expect(card('Patient and address').textContent).toContain('••••');
    expect(calls).toHaveLength(0);
  });
  it('"Show phone" -> exactly one POST /phone-reveal with {} and Bearer; then the number is shown', async () => {
    await view();
    await userEvent.click(screen.getByRole('button', { name: /show phone/i }));
    await waitFor(() => expect(text()).toContain(PHONE));
    expect(posts('/phone-reveal')).toHaveLength(1);
    expect(posts('/phone-reveal')[0]!.url.pathname).toBe(`/v1/homecollection/visits/${VISIT_ID}/phone-reveal`);
    expect(posts('/phone-reveal')[0]!.body ?? {}).toEqual({});
    expect(posts('/phone-reveal')[0]!.headers.get('authorization')).toMatch(/^Bearer /);
  });
  it('double click is single-flight: one request, one access-log row', async () => {
    await view();
    const b = screen.getByRole('button', { name: /show phone/i });
    await userEvent.dblClick(b);
    await waitFor(() => expect(text()).toContain(PHONE));
    expect(posts('/phone-reveal')).toHaveLength(1);
  });
  it('the number is never put in a URL, a toast, router state or an attribute (text content of the phone row only)', async () => {
    await view();
    await userEvent.click(screen.getByRole('button', { name: /show phone/i }));
    await waitFor(() => expect(text()).toContain(PHONE));
    expect(push).not.toHaveBeenCalled();
    expect(document.body.innerHTML.split(PHONE).length - 1).toBe(1);
    expect(document.querySelector('[title*="977"], [aria-label*="977"], [href*="977"], [data-phone]')).toBeNull();
  });
  it('403 auth.forbidden -> plain words, the number stays masked, no code shown', async () => {
    reveal = () => problem('auth.forbidden', 403);
    await view();
    await userEvent.click(screen.getByRole('button', { name: /show phone/i }));
    await waitFor(() => expect(text()).toMatch(/do not have permission|don't have permission/i));
    expect(text()).not.toContain(PHONE);
    noRawCodes();
  });
  it('patient without a phone (response has no phone_e164) -> "No phone number on file."', async () => {
    reveal = () => HttpResponse.json({});
    await view();
    await userEvent.click(screen.getByRole('button', { name: /show phone/i }));
    await waitFor(() => expect(text()).toContain('No phone number on file.'));
  });
  it('5xx -> plain-words retry text; the button works again', async () => {
    reveal = () => problem('common.internal', 500);
    await view();
    await userEvent.click(screen.getByRole('button', { name: /show phone/i }));
    await waitFor(() => expect(text()).toMatch(/something went wrong|try again/i));
    expect(isEnabled(screen.getByRole('button', { name: /show phone/i }))).toBe(true);
    reveal = () => HttpResponse.json({ phone_e164: PHONE });
    await userEvent.click(screen.getByRole('button', { name: /show phone/i }));
    await waitFor(() => expect(text()).toContain(PHONE));
    expect(posts('/phone-reveal')).toHaveLength(2);
  });
});

describe('header actions by state (§2.2) and links', () => {
  const names = { schedule: /^schedule$/i, assign: /^assign$/i, reassign: /^reassign$/i, unassign: /^unassign$/i, cancel: /^cancel( visit)?$/i, revisit: /create revisit/i };
  const has = (n: RegExp) => act(n) !== null;
  it('unassigned: Schedule, Assign, Cancel; no Reassign / Unassign / Create revisit', async () => {
    await view(detail({ status: 'unassigned', phlebotomist: undefined, route_id: undefined, route_date: undefined, route_sequence: undefined }));
    expect([has(names.schedule), has(names.assign), has(names.cancel)]).toEqual([true, true, true]);
    expect([has(names.reassign), has(names.unassign), has(names.revisit)]).toEqual([false, false, false]);
  });
  it('assigned: Schedule, Reassign, Unassign, Cancel; no plain Assign', async () => {
    await view();
    expect([has(names.schedule), has(names.reassign), has(names.unassign), has(names.cancel)]).toEqual([true, true, true, true]);
    expect(has(names.assign)).toBe(false);
  });
  it.each(['completed', 'failed', 'cancelled'])('%s (closed): no Schedule / Assign / Reassign / Unassign / Cancel', async (status) => {
    await view(detail({ status, outcome: 'collected' }));
    for (const n of [names.schedule, names.assign, names.reassign, names.unassign, names.cancel]) expect(has(n), String(n)).toBe(false);
  });
  it.each([
    ['failed', 'none', true], ['completed', 'partial', true], ['completed', 'collected', false], ['assigned', undefined, false], ['cancelled', undefined, false], ['unassigned', undefined, false],
  ])('Create revisit: status %s outcome %s -> %s (US-11-3: only a failed visit or a partial completion)', async (status, outcome, shown) => {
    await view(detail({ status, ...(outcome ? { outcome } : {}) }));
    expect(has(names.revisit)).toBe(shown);
  });
  it('"Open order" links to the front-desk order page; hidden when the visit has no order', async () => {
    await view();
    expect((screen.getByRole('link', { name: /open order/i }) as HTMLAnchorElement).getAttribute('href')).toMatch(new RegExp(`/frontdesk/orders/${ORDER_ID}$`));
    cleanup();
    await view(detail({ order_id: undefined }));
    expect(screen.queryByRole('link', { name: /open order/i })).toBeNull();
  });
  it('"Print labels" links to /lab/orders/<order_id>/labels only with lab.specimen.label_print and an order', async () => {
    await view();
    expect(screen.getByRole('link', { name: /print labels/i }).getAttribute('href')).toMatch(new RegExp(`/lab/orders/${ORDER_ID}/labels$`));
    cleanup();
    await view(detail(), ['homecollection.visit.read', 'homecollection.visit.assign']);
    expect(screen.queryByRole('link', { name: /print labels/i })).toBeNull();
    cleanup();
    await view(detail({ order_id: undefined }));
    expect(screen.queryByRole('link', { name: /print labels/i })).toBeNull();
  });
  it('Cancel opens the shared §2.1 cancel dialog (title "Cancel this visit?" and the order/bill line for an assigned booking)', async () => {
    await view();
    await userEvent.click(act(names.cancel)!);
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('Cancel this visit?')).toBeTruthy();
    expect(within(dlg).getByText('The order and bill in front desk are not cancelled automatically.')).toBeTruthy();
  });
  it('Schedule opens the shared schedule dialog', async () => {
    await view();
    await userEvent.click(act(names.schedule)!);
    expect(within(await screen.findByRole('dialog')).getByRole('heading', { name: /schedule visit/i })).toBeTruthy();
  });
});

describe('Needs attention: Resolve (H8)', () => {
  const open = async () => {
    await view();
    await userEvent.click(btn(/^resolve$/i, card('Needs attention'))!);
    return screen.findByRole('dialog');
  };
  it('only open flags have Resolve (one of the two fixture flags is resolved)', async () => {
    await view();
    expect(within(card('Needs attention')).getAllByRole('button', { name: /^resolve$/i })).toHaveLength(1);
  });
  it('without a reason nothing is sent; with a reason POST /flags/{id}/resolve { resolution_code }, Idempotency-Key, If-Match = flag version; toast, refresh, dialog closes', async () => {
    const dlg = await open();
    const ok = () => within(dlg).getByRole('button', { name: /^resolve$|^confirm$/i });
    await userEvent.click(ok());
    expect(posts('/resolve')).toHaveLength(0);
    await pick(dlg, 'Handled', /reason/i);
    await userEvent.click(ok());
    await waitFor(() => expect(posts('/resolve')).toHaveLength(1));
    const c = posts('/resolve')[0]!;
    expect(c.url.pathname).toBe(`/v1/homecollection/visits/${VISIT_ID}/flags/${U(8101)}/resolve`);
    expect(c.body).toEqual({ resolution_code: 'handled' });
    expect(c.headers.get('if-match')).toMatch(/1/);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('"Other" needs text: nothing is sent until it is entered; the text goes as `note` (≤ 500)', async () => {
    const dlg = await open();
    await pick(dlg, 'Other', /reason/i);
    const ok = within(dlg).getByRole('button', { name: /^resolve$|^confirm$/i });
    await userEvent.click(ok);
    expect(posts('/resolve')).toHaveLength(0);
    const box = within(dlg).getByRole('textbox') as HTMLInputElement | HTMLTextAreaElement;
    expect(box.maxLength).toBe(500);
    await userEvent.type(box, 'Called the patient (synthetic)');
    await userEvent.click(ok);
    await waitFor(() => expect(posts('/resolve')).toHaveLength(1));
    expect(posts('/resolve')[0]!.body).toEqual({ resolution_code: 'other', note: 'Called the patient (synthetic)' });
  });
  it('409 common.version_conflict (already resolved) -> plain words, dialog stays; no code shown', async () => {
    resolve = () => problem('common.version_conflict', 409);
    const dlg = await open();
    await pick(dlg, 'Handled', /reason/i);
    await userEvent.click(within(dlg).getByRole('button', { name: /^resolve$|^confirm$/i }));
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(/changed|reload|already/i);
    noRawCodes();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('Create revisit (H7, US-11-3 UI side)', () => {
  const open = async () => {
    await view(detail({ status: 'failed', outcome: 'none' }));
    await userEvent.click(screen.getByRole('button', { name: /create revisit/i }));
    return screen.findByRole('dialog');
  };
  it('reason required; POST /revisits { reason_code } with Idempotency-Key and If-Match = visit version; on 201 navigates to the NEW visit', async () => {
    const dlg = await open();
    const ok = () => within(dlg).getByRole('button', { name: /^create revisit$|^confirm$|^create$/i });
    await userEvent.click(ok());
    expect(posts('/revisits')).toHaveLength(0);
    await pick(dlg, 'Failed visit', /reason/i);
    await userEvent.click(ok());
    await waitFor(() => expect(posts('/revisits')).toHaveLength(1));
    const c = posts('/revisits')[0]!;
    expect(c.url.pathname).toBe(`/v1/homecollection/visits/${VISIT_ID}/revisits`);
    expect(c.body).toEqual({ reason_code: 'failed_visit' });
    expect(c.headers.get('if-match')).toMatch(/5/);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/homecollection/visits/${U(1043)}`));
  });
  it('409 homecollection.visit_closed -> plain words ("closed"), no navigation, no code', async () => {
    revisit = () => problem('homecollection.visit_closed', 409);
    const dlg = await open();
    await pick(dlg, 'Failed visit', /reason/i);
    await userEvent.click(within(dlg).getByRole('button', { name: /^create revisit$|^confirm$|^create$/i }));
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(/closed/i);
    expect(push).not.toHaveBeenCalled();
    noRawCodes();
  });
  it('retry after a failure re-sends the SAME Idempotency-Key (replay, not a second visit)', async () => {
    revisit = () => problem('common.internal', 500);
    const dlg = await open();
    await pick(dlg, 'Failed visit', /reason/i);
    const ok = within(dlg).getByRole('button', { name: /^create revisit$|^confirm$|^create$/i });
    await userEvent.click(ok);
    await within(dlg).findByRole('alert');
    await userEvent.click(ok);
    await waitFor(() => expect(posts('/revisits')).toHaveLength(2));
    expect(posts('/revisits')[1]!.headers.get('idempotency-key')).toBe(posts('/revisits')[0]!.headers.get('idempotency-key'));
  });
});
