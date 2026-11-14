// @vitest-environment jsdom
// HC-T20 — route pages app/(staff)/homecollection/{handovers,devices,settings}/page.tsx (04-UI-UX §2.3–2.6; TRD H13, H16, H18, H20; 07-SECURITY §3, abuse cases at the UI boundary,
// REQ-SEC-017 centre scoping, privileged ops). MSW plays the API.
// ASSUMED contract (same shape as HC-T18's dispatch page): default export async `Page({ searchParams })` (Promise of a record, Next 16).
//   * 404 (notFound) without the page's permission BEFORE any API call: handovers = homecollection.handover.receive, devices = homecollection.device.manage, settings = homecollection.settings.manage;
//     PermissionDenied on an API 403; a 5xx is thrown to error.tsx.
//   * handovers: centres from GET /v1/identity/centres (failure tolerated); H13 with status (whitelist pending|confirmed|discrepancy, csv; default "pending") and
//     to_centre_id (query centre_id, uuid; default first centre); renders <HandoversView handovers centres centreId status permissions nextCursor/>.
//   * devices: H16 (whitelisted status ∈ active|signed_off|wipe_requested|wiped); H20 reasons set=wipe_reasons and H18 for min_app_version (both tolerated on failure);
//     renders <DevicesView devices codes={{wipe_reasons}} minAppVersion permissions nextCursor/>.
//   * settings: H18; renders <SettingsForm settings/>.
//   * every field is re-built from an allow-list: nothing else the API sends reaches the browser.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { API, CENTRE, DEVICES, HV1, HV2, ORIGIN, P_DEVICE, P_RECEIVE, P_SETTINGS, SETTINGS, U, WIPE_REASONS, problem, recorder, wrap, type Call } from './hc-t20.helpers';

const perms = vi.hoisted(() => ({ current: [] as string[] }));
const captured = vi.hoisted(() => ({ props: undefined as any }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/homecollection/handovers',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: perms.current, displayName: 'Synthetic Staff', tenantCode: 'syn', roles: [], membershipId: U(9) } }),
  getRequestPathname: async () => '/homecollection/x',
}));
vi.mock('@/features/homecollection/components/HandoversView', () => ({ HandoversView: (p: unknown) => { captured.props = p; return <div data-testid="view" />; } }));
vi.mock('@/features/homecollection/components/DevicesView', () => ({ DevicesView: (p: unknown) => { captured.props = p; return <div data-testid="view" />; } }));
vi.mock('@/features/homecollection/components/SettingsForm', () => ({ SettingsForm: (p: unknown) => { captured.props = p; return <div data-testid="view" />; } }));

const calls: Call[] = [];
const rec = recorder(calls);
type R = () => Response | Promise<Response>;
let handovers: R, devices: R, settings: R, reasons: R, centres: R;
const reset = () => {
  handovers = () => HttpResponse.json({ data: [HV1, HV2], page: { limit: 50 } });
  devices = () => HttpResponse.json({ data: DEVICES, page: { limit: 50 } });
  settings = () => HttpResponse.json(SETTINGS);
  reasons = () => HttpResponse.json({ data: WIPE_REASONS });
  centres = () => HttpResponse.json({ data: [{ id: CENTRE, name: 'HC-A1' }, { id: U(7), name: 'HC-A2' }] });
};
reset();
const api = setupServer(
  http.get(`${API}/handovers`, async ({ request }) => { await rec(request); return handovers(); }),
  http.get(`${API}/devices`, async ({ request }) => { await rec(request); return devices(); }),
  http.get(`${API}/settings`, async ({ request }) => { await rec(request); return settings(); }),
  http.get(`${API}/reasons`, async ({ request }) => { await rec(request); return reasons(); }),
  http.get(`${ORIGIN}/v1/identity/centres`, async ({ request }) => { await rec(request); return centres(); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-14T04:00:00Z')); });
afterEach(() => { vi.useRealTimers(); cleanup(); api.resetHandlers(); calls.length = 0; captured.props = undefined; perms.current = []; reset(); });
afterAll(() => api.close());

const page = async (folder: 'handovers' | 'devices' | 'settings', sp: Record<string, string | string[] | undefined> = {}) => {
  const path = `../../../app/(staff)/homecollection/${folder}/page`; // variable path: a missing file fails each test, not the whole suite
  const mod = (await import(/* @vite-ignore */ path)) as { default: (p: any) => Promise<any> };
  wrap(await mod.default({ searchParams: Promise.resolve(sp) }));
};
const to = (path: string) => calls.filter((c) => c.url.pathname.endsWith(path));
const GATES = [['handovers', P_RECEIVE], ['devices', P_DEVICE], ['settings', P_SETTINGS]] as const;

describe('permission gate (privilege-escalation probe at the UI; 07-SECURITY §6.5)', () => {
  it.each(GATES)('%s: a user without the page permission gets notFound and NOT ONE API call — even with the other two HC permissions and dispatch rights', async (folder, own) => {
    for (const p of [[], ['homecollection.visit.read', 'homecollection.visit.assign', ...GATES.flatMap(([, g]) => g).filter((g) => !own.includes(g))]]) {
      perms.current = p;
      await expect(page(folder)).rejects.toThrow('NEXT_NOT_FOUND');
      expect(calls).toHaveLength(0);
    }
  });
  it.each(GATES)('%s: API 403 -> PermissionDenied view, no component; no problem code', async (folder, own) => {
    perms.current = own as string[];
    handovers = devices = settings = () => problem('auth.forbidden', 403);
    await page(folder);
    expect(screen.queryByTestId('view')).toBeNull();
    expect(document.body.textContent).toMatch(/permission|not allowed|access/i);
    expect(document.body.textContent).not.toMatch(/auth\.forbidden/);
  });
  it('privileged ops: 403 auth.mfa_required on devices/settings is a plain "confirm it is you" style message, not a crash or a raw code', async () => {
    for (const [folder, own] of [['devices', P_DEVICE], ['settings', P_SETTINGS]] as const) {
      perms.current = own as string[];
      devices = settings = () => problem('auth.mfa_required', 403);
      await page(folder);
      expect(document.body.textContent).not.toMatch(/auth\.mfa_required/);
      expect(screen.queryByTestId('view')).toBeNull();
      cleanup();
    }
  });
  it.each(GATES)('%s: API 500 is thrown to error.tsx with its request id (not swallowed into an empty view)', async (folder, own) => {
    perms.current = own as string[];
    handovers = devices = settings = () => problem('common.internal', 500);
    await expect(page(folder)).rejects.toMatchObject({ status: 500 });
  });
});

describe('handovers page (H13)', () => {
  it('defaults: status=pending (Waiting), to_centre_id = first centre; passes centres, permissions and the cursor', async () => {
    perms.current = P_RECEIVE;
    handovers = () => HttpResponse.json({ data: [HV1], page: { limit: 50, next_cursor: 'c2' } });
    await page('handovers');
    const q = to('/handovers')[0]!.url.searchParams;
    expect(q.get('status')).toBe('pending');
    expect(q.get('to_centre_id')).toBe(CENTRE);
    expect(captured.props.status).toBe('pending');
    expect(captured.props.centreId).toBe(CENTRE);
    expect(captured.props.centres).toEqual([{ id: CENTRE, name: 'HC-A1' }, { id: U(7), name: 'HC-A2' }]);
    expect(captured.props.permissions).toEqual(P_RECEIVE);
    expect(captured.props.nextCursor).toBe('c2');
  });
  it('?status and ?centre_id are honoured when valid (centre scoping is the API\'s; the page only asks for one centre)', async () => {
    perms.current = P_RECEIVE;
    await page('handovers', { status: 'pending,discrepancy', centre_id: U(7) });
    const q = to('/handovers')[0]!.url.searchParams;
    expect(q.get('status')).toBe('pending,discrepancy');
    expect(q.get('to_centre_id')).toBe(U(7));
  });
  it('hostile query (cross-centre probe, injection, unknown params, arrays, huge limit) is dropped, never forwarded', async () => {
    perms.current = P_RECEIVE;
    await page('handovers', { status: 'confirmed;drop', centre_id: '../../admin', to_centre_id: U(99), handed_over_from: 'x', limit: '99999', sort: 'evil', foo: ['a', 'b'] });
    const q = to('/handovers')[0]!.url.searchParams;
    expect(q.get('status')).toBe('pending');
    expect(q.get('to_centre_id')).toBe(CENTRE);
    for (const k of ['sort', 'foo', 'handed_over_from']) expect(q.has(k), k).toBe(false);
    expect(Number(q.get('limit') ?? 50)).toBeLessThanOrEqual(200);
    expect(to('/handovers')[0]!.url.search).not.toMatch(/admin|drop|evil/);
  });
  it('centres failure (identity 403) does not break the page: the query centre is used', async () => {
    perms.current = P_RECEIVE;
    centres = () => problem('auth.forbidden', 403);
    await page('handovers', { centre_id: CENTRE });
    expect(captured.props.centreId).toBe(CENTRE);
    expect(Array.isArray(captured.props.centres)).toBe(true);
  });
  it('allow-list: only the summary fields reach the browser (no items, no visit ids, no internals)', async () => {
    perms.current = P_RECEIVE;
    handovers = () => HttpResponse.json({ data: [{ ...HV1, items: [{ barcode: 'LEAK0001', visit_id: U(8201) }], visit_ids: [U(8201)], internal_note: 'secret', mutation_id: 'm1' }] });
    await page('handovers');
    const dump = JSON.stringify(captured.props);
    for (const w of ['LEAK0001', U(8201), 'internal_note', 'secret', 'mutation_id']) expect(dump, w).not.toContain(w);
    expect(captured.props.handovers[0].id).toBe(HV1.id);
    expect(captured.props.handovers[0].from.display_name).toBe('Test Phlebo 01');
  });
  it('the page makes no call to any visit endpoint (receivers have no visit access, D-125)', async () => {
    perms.current = P_RECEIVE;
    await page('handovers');
    expect(calls.every((c) => !/\/visits|\/routes/.test(c.url.pathname))).toBe(true);
  });
});

describe('devices page (H16, H20, H18)', () => {
  it('calls H16, H20 set=wipe_reasons and H18; passes devices, codes.wipe_reasons, minAppVersion, permissions', async () => {
    perms.current = P_DEVICE;
    await page('devices');
    expect(to('/devices')).toHaveLength(1);
    expect(to('/reasons')[0]!.url.searchParams.get('set')).toBe('wipe_reasons');
    expect(captured.props.devices).toHaveLength(4);
    expect(captured.props.codes.wipe_reasons.map((r: { code: string }) => r.code)).toEqual(WIPE_REASONS.map((r) => r.code));
    expect(captured.props.minAppVersion).toBe('1.10.0');
    expect(captured.props.permissions).toEqual(P_DEVICE);
  });
  it('H18 / H20 refused (device managers need not hold settings.manage / visit.read): the table still renders; minAppVersion is simply unknown', async () => {
    perms.current = P_DEVICE;
    settings = () => problem('auth.forbidden', 403);
    reasons = () => problem('auth.forbidden', 403);
    await page('devices');
    expect(captured.props.devices).toHaveLength(4);
    expect(captured.props.minAppVersion).toBeUndefined();
  });
  it('whitelisted ?status is forwarded; hostile / unknown params are dropped', async () => {
    perms.current = P_DEVICE;
    await page('devices', { status: 'wipe_requested', membership_id: 'x', sort: 'evil' });
    expect(to('/devices')[0]!.url.searchParams.get('status')).toBe('wipe_requested');
    cleanup(); calls.length = 0;
    await page('devices', { status: 'active,drop table', foo: 'bar', limit: '99999' });
    const q = to('/devices')[0]!.url.searchParams;
    expect(q.get('status')).toBeNull();
    expect(q.has('foo')).toBe(false);
    expect(Number(q.get('limit') ?? 50)).toBeLessThanOrEqual(200);
  });
  it('allow-list: tokens, hardware ids and sequence numbers never reach the browser', async () => {
    perms.current = P_DEVICE;
    devices = () => HttpResponse.json({ data: [{ ...DEVICES[0], push_token: 'tok-leak', imei: '3500000000', session_token: 'st-leak', key_material: 'k' }] });
    await page('devices');
    const dump = JSON.stringify(captured.props);
    for (const w of ['tok-leak', '3500000000', 'st-leak', 'key_material', 'max_device_seq_received']) expect(dump, w).not.toContain(w);
    expect(captured.props.devices[0].id).toBe(DEVICES[0]!.id);
    expect(captured.props.devices[0].app_version).toBe('1.12.0');
  });
});

describe('settings page (H18)', () => {
  it('calls H18 and passes the settings (all §11.2 keys + version) to the form', async () => {
    perms.current = P_SETTINGS;
    await page('settings');
    expect(to('/settings')).toHaveLength(1);
    expect(captured.props.settings.version).toBe(7);
    expect(captured.props.settings.payment_methods).toEqual(SETTINGS.payment_methods);
    expect(captured.props.settings.sync_interval_seconds).toBe(300);
  });
  it('allow-list: an extra field in the settings response is stripped', async () => {
    perms.current = P_SETTINGS;
    settings = () => HttpResponse.json({ ...SETTINGS, internal_flag: 'leak', tenant_secret: 'leak' });
    await page('settings');
    expect(JSON.stringify(captured.props)).not.toContain('leak');
  });
});
