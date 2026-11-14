// @vitest-environment jsdom
// HC-T20 — W4 Phlebotomy phones (04-UI-UX §2.4; 03-APP-FLOW §2.4; 01-PRD US-13-5 (admin side); TRD H16, H17; 07-SECURITY REQ-SEC-050/051, 073/140, AB13). MSW plays the API.
// ASSUMED contract (spec fixes folders + kit components; dispute via the writer if wrong):
//   * components/DevicesView.tsx exports `DevicesView({ devices, codes, minAppVersion?, permissions, nextCursor? })` — devices = H16 rows (DeviceDto[]);
//       codes = { wipe_reasons: CodedValue[] } (H20 set wipe_reasons); minAppVersion = the tenant setting (semver) or undefined when unknown.
//       DataTable columns: Phlebotomist · Model/platform · App version · Status · Last seen · Last upload · Last route download. Status = StatusChip(generic) + svg icon + word:
//       Active (info), Signed off (neutral), Wipe requested (warning), Wiped (neutral). Chip "Update required" (warning) next to an app_version below minAppVersion (numeric semver compare).
//       Row action (DataTable rowActions, "Row actions" menu) "Wipe on next connection" -> ConfirmDialog tone=danger with reasons from codes.wipe_reasons; not offered for wiped rows.
//   * the write goes through features/homecollection/server/actions.ts -> POST /devices/{id}/wipe { reason_code, reason_text? } with Bearer, If-Match = device.version, Idempotency-Key.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { API, D1, D2, DEVICES, P_DEVICE, U, WIPE_REASONS, axeClean, kathmandu, noRawCodes, problem, recorder, rowOf, userEvent, wrap, type Call } from './hc-t20.helpers';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/homecollection/devices',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['homecollection.device.manage'], displayName: 'Synthetic Admin', tenantCode: 'syn', roles: [], membershipId: U(9) } }),
  getRequestPathname: async () => '/homecollection/devices',
}));

const calls: Call[] = [];
const rec = recorder(calls);
type R = () => Response | Promise<Response>;
let wipe: R;
const reset = () => { wipe = () => HttpResponse.json({ ...D1, status: 'wipe_requested', version: 4, wipe_requested_at: '2026-11-14T04:00:00.000Z' }); };
reset();
const api = setupServer(http.post(`${API}/devices/:id/wipe`, async ({ request }) => { await rec(request); return wipe(); }));
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-14T04:00:00Z')); });
afterEach(() => { vi.useRealTimers(); cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); reset(); });
afterAll(() => api.close());

const posts = () => calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/wipe'));
const view = async (o: { devices?: unknown[]; min?: string | undefined; permissions?: string[] } = {}) => {
  const path = '../components/DevicesView';
  const { DevicesView } = (await import(/* @vite-ignore */ path)) as { DevicesView: (p: any) => any };
  return wrap(<DevicesView devices={(o.devices ?? DEVICES) as never} codes={{ wipe_reasons: WIPE_REASONS }} minAppVersion={'min' in o ? o.min : '1.10.0'} permissions={o.permissions ?? P_DEVICE} />);
};
const grid = () => screen.getByRole('grid');
const liveText = () => [...screen.queryAllByRole('status'), ...screen.queryAllByRole('alert')].map((e) => e.textContent).join(' ');
const openWipe = async (who: string) => {
  await userEvent.click(within(rowOf(grid(), who)).getByRole('button', { name: /row actions/i }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /wipe on next connection/i }));
  return screen.findByRole('dialog');
};
const cellOf = (who: string, text: RegExp | string) => within(rowOf(grid(), who)).getByText(text).closest('[role="gridcell"], td') as HTMLElement;

describe('table (§2.4)', () => {
  it('title "Phlebotomy phones"; the seven columns; one row per device with phlebotomist, model and platform', async () => {
    await view();
    expect(screen.getByRole('heading', { level: 1, name: /phlebotomy phones/i })).toBeTruthy();
    for (const h of ['Phlebotomist', 'Model', 'App version', 'Status', 'Last seen', 'Last upload', 'Last route download']) expect(within(grid()).getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    const r = rowOf(grid(), 'Test Phlebo 01');
    expect(r.textContent).toContain('Synthetic Phone 1');
    expect(r.textContent).toMatch(/android/i);
    expect(rowOf(grid(), 'Test Phlebo 03').textContent).toMatch(/ios/i);
  });
  it('times come from last_seen / last_push / last_snapshot, in Asia/Kathmandu', async () => {
    await view({ devices: [D1] });
    const t = rowOf(grid(), 'Test Phlebo 01').textContent!;
    expect(t).toContain(kathmandu(D1.last_seen_at).slice(0, 16));
    expect(t).toContain(kathmandu(D1.last_push_at).slice(0, 16));
    expect(t).toContain(kathmandu(D1.last_snapshot_at).slice(0, 16));
  });
  it('a device that never uploaded shows a dash / "Never", not "Invalid Date" or "undefined"', async () => {
    const { last_push_at, last_snapshot_at, last_seen_at, ...bare } = D1;
    await view({ devices: [bare] });
    expect(document.body.textContent).not.toMatch(/Invalid Date|undefined|null|NaN/);
  });
  it('status shows tone, icon and word: Active (info), Signed off (neutral), Wipe requested (warning), Wiped (neutral)', async () => {
    await view();
    for (const [who, word, tone] of [['Test Phlebo 01', 'Active', 'info'], ['Test Phlebo 02', 'Signed off', 'neutral'], ['Test Phlebo 03', 'Wipe requested', 'warning'], ['Test Phlebo 04', 'Wiped', 'neutral']] as const) {
      const cell = cellOf(who, word);
      expect(cell.querySelector('svg'), `${word} icon`).toBeTruthy();
      expect(cell.innerHTML, `${word} tone`).toMatch(new RegExp(tone));
    }
  });
  it('"Update required" (warning) only for an app below the minimum — numeric semver: 1.9.0 < 1.10.0 < 1.12.0', async () => {
    await view();
    expect(within(rowOf(grid(), 'Test Phlebo 02')).getByText(/update required/i).closest('[role="gridcell"], td')!.innerHTML).toMatch(/warning/);
    expect(within(rowOf(grid(), 'Test Phlebo 01')).queryByText(/update required/i)).toBeNull();
  });
  it('minimum unknown (tenant setting not readable) -> no "Update required" anywhere, table still renders', async () => {
    await view({ min: undefined });
    expect(screen.queryByText(/update required/i)).toBeNull();
    expect(rowOf(grid(), 'Test Phlebo 01')).toBeTruthy();
  });
  it('empty: "No phones registered yet. Phones appear after the first sign-in."', async () => {
    await view({ devices: [] });
    expect(document.body.textContent).toContain('No phones registered yet. Phones appear after the first sign-in.');
  });
  it('never shows a device id, membership id or sequence number (nothing the admin does not need)', async () => {
    await view();
    for (const d of DEVICES) { expect(document.body.textContent).not.toContain(d.id); expect(document.body.textContent).not.toContain(d.membership_id); }
    expect(document.body.textContent).not.toMatch(/max_device_seq|device_seq/);
  });
  it('a11y + no raw codes', async () => { await view(); await axeClean(); noRawCodes(); });
});

describe('wipe on next connection (H17, US-13-5)', () => {
  it('the row action is offered for active and signed-off phones; not for a wiped phone', async () => {
    await view();
    for (const who of ['Test Phlebo 01', 'Test Phlebo 02']) {
      await userEvent.click(within(rowOf(grid(), who)).getByRole('button', { name: /row actions/i }));
      expect(await screen.findByRole('menuitem', { name: /wipe on next connection/i })).toBeTruthy();
      await userEvent.keyboard('{Escape}');
    }
    const wiped = within(rowOf(grid(), 'Test Phlebo 04')).queryByRole('button', { name: /row actions/i });
    if (wiped) { await userEvent.click(wiped); expect(screen.queryByRole('menuitem', { name: /wipe on next connection/i })).toBeNull(); }
  });
  it('without homecollection.device.manage there is no wipe action at all', async () => {
    await view({ permissions: [] });
    expect(screen.queryByRole('menuitem', { name: /wipe/i })).toBeNull();
    expect(within(rowOf(grid(), 'Test Phlebo 01')).queryByRole('button', { name: /wipe/i })).toBeNull();
  });
  it('the dialog is danger-toned, explains what happens, links to Admin → Users, and lists the coded wipe reasons (H20)', async () => {
    await view();
    const dlg = await openWipe('Test Phlebo 01');
    expect(within(dlg).getByRole('heading', { name: /wipe/i })).toBeTruthy();
    expect(dlg.textContent).toContain('The phone uploads any pending changes, then erases all home-collection data.');
    expect(dlg.textContent).toContain("To block the phone immediately, also revoke the user's sessions in Admin → Users.");
    const link = within(dlg).getByRole('link', { name: /admin|users/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/admin/users/${D1.membership_id}`); // routes.yaml staff.admin.user = /admin/users/{membership_id} (review HC-T20)
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    for (const r of WIPE_REASONS) expect(await screen.findByRole('option', { name: r.display })).toBeTruthy();
    expect(dlg.innerHTML).toMatch(/danger/);
  });
  it('confirming without a reason posts nothing and says a reason is required', async () => {
    await view();
    const dlg = await openWipe('Test Phlebo 01');
    await userEvent.click(within(dlg).getByRole('button', { name: /wipe/i }));
    expect(posts()).toHaveLength(0);
    expect(dlg.textContent).toMatch(/required|choose|select/i);
  });
  it('with a reason: POST /devices/{id}/wipe { reason_code } with Bearer, If-Match = device.version, Idempotency-Key; toast, refresh, dialog closes', async () => {
    await view();
    const dlg = await openWipe('Test Phlebo 01');
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Lost' }));
    await userEvent.click(within(dlg).getByRole('button', { name: /wipe/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const c = posts()[0]!;
    expect(c.url.pathname).toBe(`/v1/homecollection/devices/${D1.id}/wipe`);
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(c.headers.get('if-match')).toMatch(/3/);
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_.:-]{8,200}$/);
    expect(c.body.reason_code).toBe('lost');
    expect(Object.keys(c.body).every((k) => ['reason_code', 'reason_text'].includes(k))).toBe(true);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // ruling HC-T20: scoped to the toast region; the table legitimately renders "Wipe requested" (D3)
    expect(liveText()).toMatch(/wipe (is )?(requested|scheduled)|will be wiped|wipe requested/i);
  });
  it('"Other" needs a typed detail (≤ 500 chars) which is sent as reason_text', async () => {
    await view();
    const dlg = await openWipe('Test Phlebo 02');
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Other' }));
    await userEvent.click(within(dlg).getByRole('button', { name: /wipe/i }));
    expect(posts()).toHaveLength(0); // detail missing
    const text = within(dlg).getByLabelText(/details/i) as HTMLInputElement;
    expect(text.maxLength).toBe(500);
    await userEvent.type(text, 'Phone returned to the synthetic vendor');
    await userEvent.click(within(dlg).getByRole('button', { name: /wipe/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ reason_code: 'other', reason_text: 'Phone returned to the synthetic vendor' });
    expect(posts()[0]!.url.pathname).toContain(D2.id);
  });
  it('a retry after a 5xx re-sends the same Idempotency-Key (REQ-SEC-050/051); the dialog stays open', async () => {
    wipe = () => problem('common.internal', 500);
    await view();
    const dlg = await openWipe('Test Phlebo 01');
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Stolen' }));
    await userEvent.click(within(dlg).getByRole('button', { name: /wipe/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    noRawCodes();
    expect(screen.getByRole('dialog')).toBeTruthy();
    wipe = () => HttpResponse.json({ ...D1, status: 'wipe_requested', version: 4 });
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /wipe/i }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]!.headers.get('idempotency-key')).toBe(posts()[0]!.headers.get('idempotency-key'));
  });
  it('409 (already wiped / stale) -> a plain sentence, no raw code, no success toast', async () => {
    wipe = () => problem('common.version_conflict', 409);
    await view({ devices: [D1] }); // ruling HC-T20: no row shows the "Wipe requested" status word
    const dlg = await openWipe('Test Phlebo 01');
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Lost' }));
    await userEvent.click(within(dlg).getByRole('button', { name: /wipe/i }));
    await waitFor(() => expect(document.body.textContent).toMatch(/already|changed|reload|refresh/i));
    noRawCodes();
    // scoped to toast/alert regions + dialog; also no optimistic status flip on the row
    const msg = liveText() + ' ' + (screen.queryByRole('dialog')?.textContent ?? '');
    expect(msg).not.toMatch(/wipe (is )?(requested|scheduled)|will be wiped/i);
    expect(within(rowOf(grid(), 'Test Phlebo 01')).getByText('Active')).toBeTruthy();
  });
  it('a double click on the confirm button is single-flight: one POST', async () => {
    await view();
    const dlg = await openWipe('Test Phlebo 01');
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Lost' }));
    await userEvent.dblClick(within(dlg).getByRole('button', { name: /wipe/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts()).toHaveLength(1);
  });
});
