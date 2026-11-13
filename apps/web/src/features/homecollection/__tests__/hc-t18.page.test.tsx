// @vitest-environment jsdom
// HC-T18 — route page app/(staff)/homecollection/dispatch/page.tsx (04-UI-UX §2.1, §2.6; TRD H1, H10, H20; 07-SECURITY §3 + abuse cases AB7/AB9/AB18 at the UI boundary). MSW plays the API.
// ASSUMED contract: default export async `Page({ searchParams })` (Promise of a record, Next 16). It
//   * 404s (notFound) without homecollection.visit.read BEFORE any API call; renders PermissionDenied on an API 403; lets 5xx reach error.tsx;
//   * reads centres from GET /v1/identity/centres (failure tolerated), date (default today in Asia/Kathmandu) and centre_id (default: first centre) from a WHITELISTED query;
//   * calls H1 (route_date, centre_id + whitelisted status/kind/has_open_flags/cursor), H10 (route_date, centre_id) and — only with homecollection.visit.assign —
//     H20 reasons for visit_cancel_reasons and unassign_reasons;
//   * passes <DispatchBoard date centreId centres visits routes permissions codes filter nextCursor/> with fields re-built from an allow-list (nothing else the API sends reaches the browser).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { A1, API, CENTRE, CODES, DATE, ORIGIN, PERMS_DISPATCH, PERMS_READ, R1, U, V1, V2, problem, recorder, wrap, type Call } from './hc-t18.helpers';

const perms = vi.hoisted(() => ({ current: [] as string[] }));
const captured = vi.hoisted(() => ({ props: undefined as any }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/homecollection/dispatch',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: perms.current, displayName: 'Synthetic Dispatcher', tenantCode: 'syn', roles: [], membershipId: U(9) } }),
  getRequestPathname: async () => '/homecollection/dispatch',
}));
vi.mock('@/features/homecollection/components/DispatchBoard', () => ({ DispatchBoard: (p: unknown) => { captured.props = p; return <div data-testid="board" />; } }));

const calls: Call[] = [];
const rec = recorder(calls);
type R = () => Response | Promise<Response>;
let visits: R, routes: R, centres: R;
const reset = () => {
  visits = () => HttpResponse.json({ data: [V1, V2, A1], page: { limit: 50 } });
  routes = () => HttpResponse.json({ data: [R1] });
  centres = () => HttpResponse.json({ data: [{ id: CENTRE, name: 'HC-A1' }, { id: U(7), name: 'HC-A2' }] });
};
reset();
const api = setupServer(
  http.get(`${API}/visits`, async ({ request }) => { await rec(request); return visits(); }),
  http.get(`${API}/routes`, async ({ request }) => { await rec(request); return routes(); }),
  http.get(`${API}/reasons`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: CODES[new URL(request.url).searchParams.get('set') as keyof typeof CODES] ?? [] }); }),
  http.get(`${ORIGIN}/v1/identity/centres`, async ({ request }) => { await rec(request); return centres(); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T19:00:00Z')); }); // 14/11/2026 00:45 in Kathmandu
afterEach(() => { vi.useRealTimers(); cleanup(); api.resetHandlers(); calls.length = 0; captured.props = undefined; perms.current = []; reset(); });
afterAll(() => api.close());

const page = async (sp: Record<string, string | string[] | undefined> = {}) => {
  const path = '../../../app/(staff)/homecollection/dispatch/page'; // variable path: a missing file fails each test, not the whole suite
  const mod = (await import(/* @vite-ignore */ path)) as { default: (p: any) => Promise<any> };
  const el = await mod.default({ searchParams: Promise.resolve(sp) });
  wrap(el);
};
const to = (path: string) => calls.filter((c) => c.url.pathname.endsWith(path));

describe('permission gate (AB18-style probe at the UI)', () => {
  it.each([[[]], [['homecollection.handover.receive']], [['frontdesk.registration.create']]])('without homecollection.visit.read (%j): notFound, and NOT ONE API call', async (p) => {
    perms.current = p as string[];
    await expect(page()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });
  it('API 403 on H1 -> PermissionDenied view, no board', async () => {
    perms.current = PERMS_DISPATCH;
    visits = () => problem('auth.forbidden', 403);
    await page();
    expect(screen.queryByTestId('board')).toBeNull();
    expect(document.body.textContent).toMatch(/permission|not allowed|access/i);
    expect(document.body.textContent).not.toMatch(/auth\.forbidden/);
  });
  it('API 500 on H1 is thrown to error.tsx (not swallowed into an empty board)', async () => {
    perms.current = PERMS_DISPATCH;
    visits = () => problem('common.internal', 500);
    await expect(page()).rejects.toMatchObject({ status: 500 }); // the ApiError itself, so error.tsx shows the request id
  });
});

describe('API calls (TRD H1, H10, H20)', () => {
  it('defaults: date = today in Asia/Kathmandu (not UTC), centre = first centre; H1 and H10 carry route_date + centre_id; reasons fetched for both sets', async () => {
    perms.current = PERMS_DISPATCH;
    await page();
    expect(to('/visits')[0]!.url.searchParams.get('route_date')).toBe('2026-11-14');
    expect(to('/visits')[0]!.url.searchParams.get('centre_id')).toBe(CENTRE);
    expect(to('/routes')[0]!.url.searchParams.get('route_date')).toBe('2026-11-14');
    expect(to('/routes')[0]!.url.searchParams.get('centre_id')).toBe(CENTRE);
    expect(to('/reasons').map((c) => c.url.searchParams.get('set')).sort()).toEqual(['unassign_reasons', 'visit_cancel_reasons']);
    expect(captured.props.date).toBe('2026-11-14');
    expect(captured.props.centreId).toBe(CENTRE);
    expect(captured.props.centres).toEqual([{ id: CENTRE, name: 'HC-A1' }, { id: U(7), name: 'HC-A2' }]);
  });
  it('?date and ?centre_id are honoured when valid; whitelisted filters are forwarded to H1', async () => {
    perms.current = PERMS_DISPATCH;
    await page({ date: DATE, centre_id: U(7), status: 'unassigned,assigned', kind: 'booking', has_open_flags: 'true' });
    const q = to('/visits')[0]!.url.searchParams;
    expect(q.get('route_date')).toBe(DATE);
    expect(q.get('centre_id')).toBe(U(7));
    expect(q.get('status')).toBe('unassigned,assigned');
    expect(q.get('kind')).toBe('booking');
    expect(q.get('has_open_flags')).toBe('true');
    expect(captured.props.date).toBe(DATE);
  });
  it('hostile query: bad date, non-uuid centre, unknown status, unknown params, array values are dropped — never forwarded into the API URL', async () => {
    perms.current = PERMS_DISPATCH;
    await page({ date: '2026-13-45', centre_id: '../../admin', status: 'unassigned,drop table', kind: ['booking', 'x'], sort: 'evil', limit: '99999', phlebotomist_membership_id: U(5001), foo: 'bar' });
    const q = to('/visits')[0]!.url.searchParams;
    expect(q.get('route_date')).toBe('2026-11-14');
    expect(q.get('centre_id')).toBe(CENTRE);
    expect(q.get('status')).toBeNull();
    expect(q.get('kind')).toBeNull();
    for (const k of ['sort', 'foo', 'phlebotomist_membership_id']) expect(q.has(k), k).toBe(false);
    expect(Number(q.get('limit') ?? 50)).toBeLessThanOrEqual(200);
    expect(to('/visits')[0]!.url.search).not.toMatch(/admin|drop|evil/);
  });
  it('a dispatcher without visit.assign (read-only) gets no reasons call and no write props', async () => {
    perms.current = PERMS_READ;
    await page();
    expect(to('/reasons')).toHaveLength(0);
    expect(captured.props.permissions).toEqual(PERMS_READ);
  });
  it('centres failure (identity 403) does not break the board: centre_id from the query is used', async () => {
    perms.current = PERMS_DISPATCH;
    centres = () => problem('auth.forbidden', 403);
    await page({ centre_id: CENTRE });
    expect(captured.props.centreId).toBe(CENTRE);
    expect(Array.isArray(captured.props.centres)).toBe(true);
  });
  it('passes the actor permissions (for Print labels / assign gating) and the cursor for the next H1 page', async () => {
    perms.current = PERMS_DISPATCH;
    visits = () => HttpResponse.json({ data: [V1], page: { limit: 50, next_cursor: 'c2' } });
    await page();
    expect(captured.props.permissions).toEqual(PERMS_DISPATCH);
    expect(captured.props.nextCursor).toBe('c2');
  });
});

describe('allow-list: nothing but the documented fields reaches the browser (07-SECURITY §3; no phone on the board — H21 is the only reveal)', () => {
  it('extra / sensitive fields in an H1 row, H10 row or reasons row are stripped before they reach the client component', async () => {
    perms.current = PERMS_DISPATCH;
    visits = () => HttpResponse.json({ data: [{ ...V1, phone_e164: '+9779800000000', raw_address: 'Ward 1 synthetic', internal_note: 'secret', idempotency_key: 'k' }] });
    routes = () => HttpResponse.json({ data: [{ ...R1, device_id: U(8888), gps: { lat: 1 } }] });
    await page();
    const dump = JSON.stringify(captured.props);
    for (const w of ['9779800000000', 'raw_address', 'internal_note', 'idempotency_key', 'device_id', 'gps']) expect(dump, w).not.toContain(w);
    expect(captured.props.visits[0].patient_display_name).toBe(V1.patient_display_name);
    expect(captured.props.visits[0].id).toBe(V1.id);
    expect(captured.props.routes[0].visit_ids_in_order).toEqual(R1.visit_ids_in_order);
  });
  it('an unknown visit status / flag kind from the API is passed through as text, not dropped (x-extensible enums, CV §4.11)', async () => {
    perms.current = PERMS_DISPATCH;
    visits = () => HttpResponse.json({ data: [{ ...V1, open_flag_kinds: ['future_flag_kind'] }] });
    await page();
    expect(captured.props.visits[0].open_flag_kinds).toEqual(['future_flag_kind']);
  });
});
