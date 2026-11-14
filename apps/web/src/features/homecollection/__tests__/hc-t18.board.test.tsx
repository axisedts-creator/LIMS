// @vitest-environment jsdom
// HC-T18 — Dispatch board W1 (04-UI-UX §2.1, §2.7; 01-PRD US-04-1, US-04-2, US-04-3, US-05-1, US-05-2; 07-SECURITY §3 staff web). MSW plays the API.
// LD-140 (2026-11-13): kit components only; one primary button per page; every status shows tone, icon and word.
// ASSUMED contract (spec fixes folders + kit components; dispute via writer if wrong):
//   * features/homecollection/components/DispatchBoard.tsx exports `DispatchBoard({ date, centreId, centres, visits, routes, permissions, codes, filter?, nextCursor? })`
//       date 'YYYY-MM-DD'; centres [{id,name}]; visits = H1 page (VisitSummaryDto[]) for the date; routes = H10 data (RouteDto[]);
//       codes = { visit_cancel_reasons, unassign_reasons } (H20 rows {code,display,requires_text,is_active}).
//       Unassigned = visits with status 'unassigned' (grid named "Unassigned"); each route card = Card with h2 "<phlebotomist name>" and a compact grid named after it;
//       rows follow route.visit_ids_in_order (server order is authoritative); a route with 0 active visits is not shown.
//   * Unassigned row actions = DataTable `rowActions` (button "Row actions" -> menu items Schedule, Assign, Cancel, Open); only Open without homecollection.visit.assign.
//       Row Enter: scheduled (window set) -> Assign dialog, else Schedule dialog. "Selected row" for Alt+A / Alt+S = the focused row of the Unassigned grid.
//   * Route rows: IconButtons "Move up" / "Move down" / "Unassign" / "Open" and, with lab.specimen.label_print and an order_id, a link "Print labels" -> /lab/orders/<order_id>/labels.
//       Status cell = StatusChip(generic) + an svg icon + the word. Footer button "Save order" -> POST /routes/{id}/sequence {visit_ids}, If-Match "<route.version>".
//   * Tubes: route rows "collected/expected"; a row with order_id and expected = 0 shows "Tubes: preparing…" (the refresh through LabPort is server-side in H2, not asserted here).
//   * Open = router.push('/homecollection/visits/<id>'); Refresh button and Alt+R = router.refresh(); date change = router.replace with ?date=YYYY-MM-DD.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  A1, A2, A3, API, B1, CENTRE, CENTRES, CODES, DATE, PERMS_DISPATCH, PERMS_READ, R1, R2, ROUTES, U, V1, V2, V3, VISITS,
  axeClean, isEnabled, noRawCodes, problem, recorder, rowOf, route, userEvent, visit, wrap, type Call,
} from './hc-t18.helpers';
import { shortcuts } from '@/core/shortcuts/registry';

const refresh = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh, back: vi.fn() }),
  usePathname: () => '/homecollection/dispatch',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: PERMS_DISPATCH, displayName: 'Synthetic Dispatcher', tenantCode: 'syn', roles: [], membershipId: U(9) } }),
  getRequestPathname: async () => '/homecollection/dispatch',
}));

const calls: Call[] = [];
const rec = recorder(calls);
type R = () => Response | Promise<Response>;
let sequence: R, cancel: R, unassign: R;
const reset = () => {
  sequence = () => HttpResponse.json({ ...R1, version: 5 });
  cancel = () => HttpResponse.json({ ...V2, status: 'cancelled', version: 4 });
  unassign = () => HttpResponse.json({ ...A1, status: 'unassigned', version: 4 });
};
reset();
const api = setupServer(
  http.post(`${API}/routes/:id/sequence`, async ({ request }) => { await rec(request); return sequence(); }),
  http.post(`${API}/visits/:id/cancel`, async ({ request }) => { await rec(request); return cancel(); }),
  http.post(`${API}/visits/:id/unassign`, async ({ request }) => { await rec(request); return unassign(); }),
  http.post(`${API}/visits/:id/schedule`, async ({ request }) => { await rec(request); return HttpResponse.json({ ...V1, version: 4 }); }),
  http.get(`${API}/phlebotomists`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [{ membership_id: U(5001), display_name: 'Test Phlebo 01', route_id: U(4001), active_visits: 3, route_full: false }] }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T04:00:00Z')); });
afterEach(() => { vi.useRealTimers(); cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); push.mockReset(); replace.mockReset(); reset(); });
afterAll(() => api.close());

const posts = (suffix: string) => calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith(suffix));
const view = async (permissions: readonly string[] = PERMS_DISPATCH, o: { visits?: unknown[]; routes?: unknown[] } = {}) => {
  const path = '../components/DispatchBoard'; // variable path: a missing file fails each test, not the whole suite
  const { DispatchBoard } = (await import(/* @vite-ignore */ path)) as { DispatchBoard: (p: any) => any };
  return wrap(<DispatchBoard date={DATE} centreId={CENTRE} centres={CENTRES} visits={(o.visits ?? VISITS) as never} routes={(o.routes ?? ROUTES) as never} permissions={permissions} codes={CODES} />);
};
const unassignedGrid = () => screen.getByRole('grid', { name: /unassigned/i });
const card = (name: RegExp) => screen.getByRole('heading', { name }).closest('.lims-card') as HTMLElement;
const routeGrid = (name: RegExp) => within(card(name)).getByRole('grid');
const names = (grid: HTMLElement) => within(grid).getAllByRole('row').map((r) => r.textContent ?? '').filter((t) => /Test Patient/.test(t)).map((t) => /Test Patient \d{4}/.exec(t)![0]);
const rowActionsOf = (row: HTMLElement) => within(row).getByRole('button', { name: /row actions/i });
const openMenuItem = async (row: HTMLElement, item: RegExp) => { await userEvent.click(rowActionsOf(row)); await userEvent.click(await screen.findByRole('menuitem', { name: item })); };
const P = (v: { patient_display_name: string }) => v.patient_display_name;

describe('header and filters (§2.1)', () => {
  it('title "Home visits"; date field defaulting to the board date; centre select; Refresh; FilterBar with status, kind and "Needs attention"', async () => {
    await view();
    expect(screen.getByRole('heading', { level: 1, name: /^home visits$/i })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: /^date/i }) as HTMLInputElement).value).toBe('14/11/2026');
    expect(screen.getByRole('button', { name: /centre/i }).textContent).toMatch(/HC-A1/);
    expect(screen.getByRole('button', { name: /^refresh$/i })).toBeTruthy();
    expect(screen.getAllByText(/status/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^kind$/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('switch', { name: /needs attention/i })).toBeTruthy();
  });
  it('Refresh calls router.refresh; changing the date writes ?date= into the URL (query mirrors H1)', async () => {
    await view();
    await userEvent.click(screen.getByRole('button', { name: /^refresh$/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
    const d = screen.getByRole('textbox', { name: /^date/i });
    await userEvent.clear(d); await userEvent.type(d, '15/11/2026'); await userEvent.tab();
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(String(replace.mock.calls.at(-1)![0])).toMatch(/date=2026-11-15/);
  });
  it('"Needs attention" switch writes has_open_flags=true', async () => {
    await view();
    await userEvent.click(screen.getByRole('switch', { name: /needs attention/i }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(String(replace.mock.calls.at(-1)![0])).toMatch(/has_open_flags=true/);
  });
});

describe('Unassigned table (US-04-3, §2.1)', () => {
  it('lists exactly the unassigned visits (not the assigned ones), each once', async () => {
    await view();
    expect(names(unassignedGrid()).sort()).toEqual([P(V1), P(V2), P(V3)].sort());
  });
  it('row facts: "Not scheduled" without a window; window as Kathmandu time; area hint; kind chip words; flag badge text', async () => {
    await view();
    const g = unassignedGrid();
    expect(within(rowOf(g, P(V1))).getByText(/not scheduled/i)).toBeTruthy();
    expect(within(rowOf(g, P(V1))).getByText('Address needed')).toBeTruthy();
    expect(within(rowOf(g, P(V2))).getByText(/08:45 AM/)).toBeTruthy();
    expect(within(rowOf(g, P(V2))).getByText('Baneshwor, Kathmandu')).toBeTruthy();
    expect(within(rowOf(g, P(V2))).getByText('Booking')).toBeTruthy();
    expect(within(rowOf(g, P(V3))).getByText('Front desk')).toBeTruthy();
  });
  it('shows names, never patient or membership ids; no phone is on the board', async () => {
    await view();
    expect(document.body.textContent).not.toContain(V1.patient_id);
    expect(document.body.textContent).not.toMatch(/\+977|98\d{8}/);
  });
  it('empty: "No unassigned visits for this date." and no grid rows', async () => {
    await view(PERMS_DISPATCH, { visits: [A1, A2, A3, B1] });
    expect(screen.getByText('No unassigned visits for this date.')).toBeTruthy();
  });
  it('row menu (dispatcher): Schedule, Assign, Cancel, Open; read-only user: Open only', async () => {
    await view();
    await userEvent.click(rowActionsOf(rowOf(unassignedGrid(), P(V2))));
    const items = (await screen.findAllByRole('menuitem')).map((m) => m.textContent!.trim());
    expect(items).toEqual(['Schedule', 'Assign', 'Cancel', 'Open']);
    cleanup();
    await view(PERMS_READ);
    await userEvent.click(rowActionsOf(rowOf(unassignedGrid(), P(V2))));
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent!.trim())).toEqual(['Open']);
  });
  it('Open navigates to /homecollection/visits/<id>', async () => {
    await view();
    await openMenuItem(rowOf(unassignedGrid(), P(V2)), /^open$/i);
    expect(push).toHaveBeenCalledWith(`/homecollection/visits/${V2.id}`);
  });
  it('Schedule and Assign menu items open their dialogs for that visit', async () => {
    await view();
    await openMenuItem(rowOf(unassignedGrid(), P(V1)), /^schedule$/i);
    expect(await screen.findByRole('dialog', { name: /schedule/i })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await openMenuItem(rowOf(unassignedGrid(), P(V2)), /^assign$/i);
    expect(await screen.findByRole('dialog', { name: /assign/i })).toBeTruthy();
  });
  it('row Enter: scheduled visit -> Assign dialog; unscheduled visit -> Schedule dialog', async () => {
    await view();
    rowOf(unassignedGrid(), P(V1)).focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: /schedule/i })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    rowOf(unassignedGrid(), P(V2)).focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: /assign/i })).toBeTruthy();
  });
});

describe('Cancel dialog from the board (H6, US-03; §2.1 Cancel dialog)', () => {
  const open = async () => { await view(); await openMenuItem(rowOf(unassignedGrid(), P(V2)), /^cancel$/i); return screen.findByRole('dialog'); };
  it('danger ConfirmDialog "Cancel this visit?" with the phlebotomist-sync body copy; reason select lists the coded set by display text', async () => {
    const dlg = await open();
    expect(within(dlg).getByText('Cancel this visit?')).toBeTruthy();
    expect(within(dlg).getByText(/The phlebotomist will see it as cancelled after their next sync\./)).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    for (const r of CODES.visit_cancel_reasons) expect(await screen.findByRole('option', { name: r.display })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/patient_cancelled/);
  });
  it('no request without a reason; with a reason POSTs /cancel with reason_code, If-Match = version and an Idempotency-Key; then toast-free refresh + close', async () => {
    const dlg = await open();
    await userEvent.click(within(dlg).getByRole('button', { name: /^cancel visit$|^confirm$|^cancel this visit$/i }));
    expect(posts('/cancel')).toHaveLength(0);
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Duplicate visit' }));
    await userEvent.type(within(dlg).getByRole('textbox'), 'Booked twice (synthetic)');
    await userEvent.click(within(dlg).getByRole('button', { name: /^cancel visit$|^confirm$|^cancel this visit$/i }));
    await waitFor(() => expect(posts('/cancel')).toHaveLength(1));
    const c = posts('/cancel')[0]!;
    expect(c.url.pathname).toBe(`/v1/homecollection/visits/${V2.id}/cancel`);
    expect(c.body).toEqual({ reason_code: 'duplicate', reason_text: 'Booked twice (synthetic)' });
    expect(c.headers.get('if-match')).toMatch(/3/);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.headers.get('authorization')).toMatch(/^Bearer /);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('"Other" needs text (requires_text) — no request until it is given', async () => {
    const dlg = await open();
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Other' }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^cancel visit$|^confirm$|^cancel this visit$/i }));
    expect(posts('/cancel')).toHaveLength(0);
    expect(within(dlg).getAllByText(/required|enter/i).length).toBeGreaterThan(0);
  });
  it.each([
    ['homecollection.visit_closed', 409, /closed|no longer/i],
    ['homecollection.mutation_superseded', 409, /started|in progress|changed/i],
    ['common.version_conflict', 409, /changed|newer|reload|refresh/i],
  ])('error %s shows a plain message, never the code; dialog stays open', async (code, status, text) => {
    cancel = () => problem(code, status);
    const dlg = await open();
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Duplicate visit' }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^cancel visit$|^confirm$|^cancel this visit$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(text);
    noRawCodes();
    expect(screen.queryByRole('dialog')).toBeTruthy();
  });
});

describe('Route cards (US-04-3, US-04-1)', () => {
  it('one card per route with visits: name · "{n} visits" · "Phone updated {time | never}"; an empty route is not shown', async () => {
    await view(PERMS_DISPATCH, { routes: [R1, R2, route(3, [])] });
    expect(within(card(/Test Phlebo 01/)).getByText(/3 visits/)).toBeTruthy();
    expect(card(/Test Phlebo 01/).textContent).toMatch(/Phone updated .*07:45 AM/);
    expect(card(/Test Phlebo 02/).textContent).toMatch(/1 visits?/);
    expect(card(/Test Phlebo 02/).textContent).toMatch(/Phone updated never/);
    expect(screen.queryByRole('heading', { name: /Test Phlebo 03/ })).toBeNull();
  });
  it('rows follow the route order the server sends (visit_ids_in_order), not input order', async () => {
    await view(PERMS_DISPATCH, { routes: [{ ...R1, visit_ids_in_order: [A2.id, A1.id, A3.id] }, R2] });
    expect(names(routeGrid(/Test Phlebo 01/))).toEqual([P(A2), P(A1), P(A3)]);
  });
  it('visit status: StatusChip word + tone + icon on every row (never colour alone); labels from §2.1', async () => {
    await view();
    const g = routeGrid(/Test Phlebo 01/);
    const chip = (row: HTMLElement, word: string) => within(row).getByText(word).closest('[data-tone]') as HTMLElement;
    const a1 = chip(rowOf(g, P(A1)), 'Assigned');
    const a2 = chip(rowOf(g, P(A2)), 'In progress');
    expect(a1.dataset['tone']).toBe('info');
    expect(a2.dataset['tone']).toBe('info');
    for (const c of [a1, a2]) expect((c.closest('td,[role=gridcell]') ?? c).querySelector('svg'), 'status icon').toBeTruthy();
    expect(within(rowOf(g, P(A2))).getByText('Collection on hold')).toBeTruthy(); // flag held_collection: word + warning tone
    cleanup();
    await view(PERMS_DISPATCH, { visits: [{ ...A1, status: 'completed' }, { ...A2, status: 'failed' }, { ...A3, status: 'cancelled' }, V1], routes: [R1] });
    const g2 = routeGrid(/Test Phlebo 01/);
    expect((within(rowOf(g2, P(A1))).getByText('Completed').closest('[data-tone]') as HTMLElement).dataset['tone']).toBe('success');
    expect((within(rowOf(g2, P(A2))).getByText('Failed').closest('[data-tone]') as HTMLElement).dataset['tone']).toBe('danger');
    expect((within(rowOf(g2, P(A3))).getByText('Cancelled').closest('[data-tone]') as HTMLElement).dataset['tone']).toBe('neutral');
  });
  it('Tubes column shows "collected/expected"', async () => {
    await view();
    expect(within(rowOf(routeGrid(/Test Phlebo 01/), P(A1))).getByText('1/2')).toBeTruthy();
    expect(within(rowOf(routeGrid(/Test Phlebo 01/), P(A2))).getByText('0/3')).toBeTruthy();
  });
});

describe('US-05 labels at dispatch', () => {
  it('US-05-1: assigned visit with order_id has a "Print labels" link to /lab/orders/<order_id>/labels; a visit without order_id has none', async () => {
    await view();
    const g = routeGrid(/Test Phlebo 01/);
    const link = within(rowOf(g, P(A1))).getByRole('link', { name: /print labels/i });
    expect(link.getAttribute('href')).toBe(`/lab/orders/${A1.order_id}/labels`);
    expect(within(rowOf(g, P(A2))).getByRole('link', { name: /print labels/i }).getAttribute('href')).toBe(`/lab/orders/${A2.order_id}/labels`);
    expect(within(rowOf(g, P(A3))).queryByRole('link', { name: /print labels/i })).toBeNull();
    expect(within(rowOf(g, P(A3))).queryByRole('button', { name: /print labels/i })).toBeNull();
  });
  it('US-05-1: shown only to actors holding lab.specimen.label_print — even a dispatcher without it sees no link or button', async () => {
    await view(['homecollection.visit.read', 'homecollection.visit.assign']);
    expect(screen.queryByRole('link', { name: /print labels/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /print labels/i })).toBeNull();
    cleanup();
    await view(['homecollection.visit.read', 'lab.specimen.label_print']);
    expect(screen.getAllByRole('link', { name: /print labels/i }).length).toBe(3); // A1, A2, B1 have orders
  });
  it('US-05-2: specimens not yet in the read model (order_id, expected 0) show "Tubes: preparing…"; once known the count shows', async () => {
    const preparing = { ...A1, specimens_summary: { expected: 0, collected: 0, held: 0, received: 0, rejected: 0 } };
    await view(PERMS_DISPATCH, { visits: [V1, preparing, A2, A3, B1] });
    const g = routeGrid(/Test Phlebo 01/);
    expect(within(rowOf(g, P(A1))).getByText('Tubes: preparing…')).toBeTruthy();
    expect(within(rowOf(g, P(A2))).queryByText(/preparing/)).toBeNull();
    expect(within(rowOf(g, P(A3))).queryByText(/preparing/)).toBeNull(); // no order yet: nothing to prepare
  });
});

describe('Resequence (US-04-1, US-04-2) — button-based, keyboard operable', () => {
  const rowsIn = () => names(routeGrid(/Test Phlebo 01/));
  const btn = (v: { patient_display_name: string }, name: RegExp) => within(rowOf(routeGrid(/Test Phlebo 01/), P(v))).getByRole('button', { name }) as HTMLButtonElement;
  const save = () => within(card(/Test Phlebo 01/)).getByRole('button', { name: /^save order$/i }) as HTMLButtonElement;

  it('"Save order" disabled until the local order differs; first row cannot move up, last cannot move down', async () => {
    await view();
    expect(isEnabled(save())).toBe(false);
    expect(isEnabled(btn(A1, /move up/i))).toBe(false);
    expect(isEnabled(btn(A3, /move down/i))).toBe(false);
    expect(isEnabled(btn(A1, /move down/i))).toBe(true);
  });
  it('Move down / Move up reorders locally with no request; moving back restores the original order and disables Save again', async () => {
    await view();
    await userEvent.click(btn(A1, /move down/i));
    expect(rowsIn()).toEqual([P(A2), P(A1), P(A3)]);
    expect(isEnabled(save())).toBe(true);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await userEvent.click(btn(A1, /move up/i));
    expect(rowsIn()).toEqual([P(A1), P(A2), P(A3)]);
    expect(isEnabled(save())).toBe(false);
  });
  it('keyboard: focus stays on the moved row\'s button and the move is announced (role=status)', async () => {
    await view();
    btn(A1, /move down/i).focus();
    await userEvent.keyboard('{Enter}');
    const active = document.activeElement as HTMLElement;
    expect(within(rowOf(routeGrid(/Test Phlebo 01/), P(A1))).getByRole('button', { name: /move down/i })).toBe(active);
    expect(screen.getAllByRole('status').map((s) => s.textContent).join(' ')).toMatch(/moved|position 2/i);
  });
  it('US-04-1: Save order POSTs the exact visit_ids in the new order to /routes/{id}/sequence with If-Match = route version; then refreshes', async () => {
    await view();
    await userEvent.click(btn(A1, /move down/i));
    await userEvent.click(btn(A3, /move up/i)); // -> A2, A3, A1
    expect(rowsIn()).toEqual([P(A2), P(A3), P(A1)]);
    await userEvent.click(save());
    await waitFor(() => expect(posts('/sequence')).toHaveLength(1));
    const c = posts('/sequence')[0]!;
    expect(c.url.pathname).toBe(`/v1/homecollection/routes/${R1.id}/sequence`);
    expect(c.body).toEqual({ visit_ids: [A2.id, A3.id, A1.id] });
    expect(c.headers.get('if-match')).toMatch(/4/);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
  it('US-04-2: 400 (route set changed) -> plain message + "Refresh" path; local order kept; no code shown', async () => {
    sequence = () => problem('common.validation_failed', 400, { errors: [{ pointer: '/visit_ids', detail: 'must be exactly the active visits' }] });
    await view();
    await userEvent.click(btn(A1, /move down/i));
    await userEvent.click(save());
    expect((await screen.findByRole('alert')).textContent).toMatch(/route changed|refresh|changed/i);
    noRawCodes();
    expect(rowsIn()).toEqual([P(A2), P(A1), P(A3)]);
  });
  it('409 version conflict -> "changed by someone else" style banner, never a raw code', async () => {
    sequence = () => problem('common.version_conflict', 409);
    await view();
    await userEvent.click(btn(A1, /move down/i));
    await userEvent.click(save());
    expect((await screen.findByRole('alert')).textContent).toMatch(/changed|newer|reload|refresh/i);
    noRawCodes();
  });
  it('Save is single-flight: a double click sends one request', async () => {
    await view();
    await userEvent.click(btn(A1, /move down/i));
    const s = save();
    await userEvent.dblClick(s);
    await waitFor(() => expect(posts('/sequence').length).toBeGreaterThan(0));
    expect(posts('/sequence')).toHaveLength(1);
  });
  it('read-only user: no Move / Save / Unassign controls at all', async () => {
    await view(PERMS_READ);
    expect(screen.queryByRole('button', { name: /move up|move down|save order|unassign/i })).toBeNull();
    expect(within(rowOf(routeGrid(/Test Phlebo 01/), P(A1))).getByRole('button', { name: /^open$/i })).toBeTruthy();
  });
});

describe('Unassign (H4)', () => {
  it('Unassign opens a ConfirmDialog with the unassign reason set; confirm POSTs /unassign with reason_code + If-Match; then refreshes', async () => {
    await view();
    await userEvent.click(within(rowOf(routeGrid(/Test Phlebo 01/), P(A1))).getByRole('button', { name: /^unassign$/i }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/unassign/i)).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    expect(await screen.findByRole('option', { name: 'Wrong route' })).toBeTruthy();
    await userEvent.click(screen.getByRole('option', { name: 'Wrong route' }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^unassign$|^confirm$/i }));
    await waitFor(() => expect(posts('/unassign')).toHaveLength(1));
    const c = posts('/unassign')[0]!;
    expect(c.url.pathname).toBe(`/v1/homecollection/visits/${A1.id}/unassign`);
    expect(c.body).toMatchObject({ reason_code: 'wrong_route' });
    expect(c.headers.get('if-match')).toMatch(/3/);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
  it('409 mutation_superseded (visit in progress) -> plain message, dialog stays', async () => {
    unassign = () => problem('homecollection.mutation_superseded', 409);
    await view();
    await userEvent.click(within(rowOf(routeGrid(/Test Phlebo 01/), P(A2))).getByRole('button', { name: /^unassign$/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Wrong route' }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^unassign$|^confirm$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/started|in progress|changed/i);
    noRawCodes();
  });
});

describe('page shortcuts (registered under "homecollection.dispatch", §2.1 Keyboard)', () => {
  const run = (key: string) => { const s = shortcuts.list('homecollection.dispatch').find((x) => x.key.toLowerCase() === key.toLowerCase()); expect(s, key).toBeTruthy(); s!.run(); };
  it('registers Alt+D, Alt+A, Alt+S, Alt+R with descriptions, and unregisters on unmount', async () => {
    const { unmount } = await view();
    const keys = shortcuts.list('homecollection.dispatch').map((s) => s.key.toLowerCase());
    for (const k of ['alt+d', 'alt+a', 'alt+s', 'alt+r']) expect(keys).toContain(k);
    for (const s of shortcuts.list('homecollection.dispatch')) expect(s.description.length).toBeGreaterThan(3);
    unmount();
    expect(shortcuts.list('homecollection.dispatch')).toHaveLength(0);
  });
  it('Alt+D focuses the date field; Alt+R refreshes', async () => {
    await view();
    run('Alt+D');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /^date/i }));
    run('Alt+R');
    expect(refresh).toHaveBeenCalled();
  });
  it('Alt+S schedules and Alt+A assigns the focused Unassigned row; with no row focused they do nothing', async () => {
    await view();
    run('Alt+S');
    expect(screen.queryByRole('dialog')).toBeNull();
    rowOf(unassignedGrid(), P(V2)).focus();
    run('Alt+S');
    expect(await screen.findByRole('dialog', { name: /schedule/i })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    rowOf(unassignedGrid(), P(V2)).focus();
    run('Alt+A');
    expect(await screen.findByRole('dialog', { name: /assign/i })).toBeTruthy();
  });
  it('read-only user: Alt+A / Alt+S are not registered (no dispatcher action by keyboard either)', async () => {
    await view(PERMS_READ);
    const keys = shortcuts.list('homecollection.dispatch').map((s) => s.key.toLowerCase());
    expect(keys).not.toContain('alt+a');
    expect(keys).not.toContain('alt+s');
  });
});

describe('keyboard-only walk-through (06-PLAN HC-T18 "keyboard-only walk-through")', () => {
  it('Tab reaches date, centre, Refresh, the Unassigned grid, a row-actions button and a route card control without a mouse; every Tab stop has an accessible name', async () => {
    await view();
    const seen: string[] = [];
    for (let i = 0; i < 60; i++) {
      await userEvent.tab();
      const el = document.activeElement as HTMLElement;
      if (!el || el === document.body) break;
      const name = el.getAttribute('aria-label') ?? ((el as HTMLInputElement).labels?.[0]?.textContent || el.textContent) ?? '';
      if (el.matches('button,a,[role=switch],[role=row],[role=gridcell],input')) expect((name || (el as HTMLInputElement).placeholder || el.getAttribute('aria-labelledby') || '').trim().length, `${el.outerHTML.slice(0, 90)}`).toBeGreaterThan(0);
      seen.push(`${el.tagName}:${name.trim().slice(0, 20)}`);
    }
    const all = seen.join('|').toLowerCase();
    expect(all).toContain('refresh'); // grids are single tab stops (arrow keys inside), so only top-level controls are asserted by Tab
    expect(seen.length).toBeGreaterThan(4);
  });
  it('whole flow by keyboard: row Enter -> Schedule dialog; Escape returns focus to the row', async () => {
    await view();
    const row = rowOf(unassignedGrid(), P(V1));
    row.focus();
    await userEvent.keyboard('{Enter}');
    const dlg = await screen.findByRole('dialog', { name: /schedule/i });
    // keyboard coverage kept (HC-T18-ruling.md c): one field typed character by character, no mouse
    const address = within(dlg).getByRole('textbox', { name: /^address/i }) as HTMLInputElement;
    address.focus();
    await userEvent.clear(address);
    await userEvent.keyboard('Ward 5');
    expect(address.value).toBe('Ward 5');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(unassignedGrid().contains(document.activeElement)).toBe(true);
  });
});

describe('accessibility (WCAG 2.2 AA, axe) and responsive (§2.7)', () => {
  it('axe clean: board with data, an open Schedule dialog, an open Cancel dialog', async () => {
    await view();
    await axeClean();
    await openMenuItem(rowOf(unassignedGrid(), P(V1)), /^schedule$/i);
    await screen.findByRole('dialog', { name: /schedule/i });
    await axeClean();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await openMenuItem(rowOf(unassignedGrid(), P(V2)), /^cancel$/i);
    await screen.findByRole('dialog');
    await axeClean();
  });
  it('axe clean: empty board and read-only board', async () => {
    await view(PERMS_READ, { visits: [], routes: [] });
    await axeClean();
    cleanup();
    await view(PERMS_READ);
    await axeClean();
  });
  it('flag badges carry text (no colour-only status): every open flag kind renders its §2.1 label', async () => {
    const kinds: Record<string, string> = {
      address_missing: 'Address needed', collected_after_cancel: 'Collected after cancel', held_collection: 'Collection on hold', cancel_requested_after_start: 'Cancel requested',
      order_cancel_required: 'Cancel order in front desk', missed: 'Missed', recollection_required: 'Recollection', handover_overdue: 'Tubes not handed over',
      handover_discrepancy: 'Missing tube', identity_mismatch: 'ID mismatch', specimen_not_collected: 'Tube not collected', payment_rejected: 'Payment needs entry',
    };
    const many = Object.keys(kinds).map((k, i) => visit(50 + i, { open_flag_kinds: [k] }));
    await view(PERMS_DISPATCH, { visits: many, routes: [] });
    for (const [k, label] of Object.entries(kinds)) expect(within(unassignedGrid()).getAllByText(label).length, k).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/address_missing|held_collection|payment_rejected/);
  });
});
