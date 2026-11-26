// CR TENANT-LOGO-1: app/(staff)/tenant-logo/route.ts, the same-origin address of the signed-in lab's own logo.
// Tenant separation is the point: the handler takes NO input from the browser (no path id, no query, no header), so the only thing that
// selects a tenant is the session's bearer token, which the API turns into the tenant. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const state = { token: 'jwt-synthetic-alpha' as string | undefined };
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => state.token }));

const ORIGIN = 'http://api.tenantlogo.test';
const API_PATH = '/v1/identity/me/tenant-logo/content';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
let fetchMock: ReturnType<typeof vi.fn>;
const upstream = (r: () => Response | Promise<Response>) => { fetchMock = vi.fn(async () => r()); vi.stubGlobal('fetch', fetchMock); };
const load = async () => (await import('@/app/(staff)/tenant-logo/route')).GET;

beforeEach(() => { state.token = 'jwt-synthetic-alpha'; process.env.LIMS_ORIGIN_API = ORIGIN; upstream(() => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })); });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.LIMS_ORIGIN_API; });

describe('GET /tenant-logo', () => {
  it('asks the API for the caller own tenant logo with the session token, and nothing else', async () => {
    const res = await (await load())();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(`${ORIGIN}${API_PATH}`);                       // fixed address: no id, no query
    expect(init.headers).toEqual({ authorization: 'Bearer jwt-synthetic-alpha' });
    expect(init.redirect).toBe('error'); expect(init.cache).toBe('no-store');
    expect(res.status).toBe(200); expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });
  it('the handler takes no arguments: a request cannot name a tenant or an asset', async () => {
    const GET = await load();
    expect(GET.length).toBe(0);
    await (GET as (...a: unknown[]) => Promise<Response>)(new Request('http://web.test/tenant-logo?t=synthetic_beta&tenant_id=x&asset_id=y', { headers: { 'x-tenant-id': 'synthetic_beta' } }), { params: Promise.resolve({ asset_id: 'y' }) });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${ORIGIN}${API_PATH}`);
    expect(fetchMock.mock.calls[0]![1].headers).toEqual({ authorization: 'Bearer jwt-synthetic-alpha' });
    const src = readFileSync(fileURLToPath(new URL('../../../app/(staff)/tenant-logo/route.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/export async function GET\(\)/); expect(src).not.toMatch(/searchParams|params\b|req\.|request\./);
  });
  it('a different session sends a different token (the tenant follows the session, not the address)', async () => {
    state.token = 'jwt-synthetic-beta'; await (await load())();
    expect(fetchMock.mock.calls[0]![1].headers).toEqual({ authorization: 'Bearer jwt-synthetic-beta' });
  });
  it('image headers: content type passed on, nosniff, private browser cache only, varies by cookie', async () => {
    const res = await (await load())();
    expect(res.headers.get('content-type')).toBe('image/png'); expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300'); expect(res.headers.get('vary')).toBe('cookie');
    expect(res.headers.get('cache-control')).not.toMatch(/public|s-maxage/);
  });
  it('no session -> 401 and the API is not called', async () => {
    state.token = undefined; const res = await (await load())();
    expect(res.status).toBe(401); expect(fetchMock).not.toHaveBeenCalled(); expect(await res.text()).toBe('');
  });
  it.each([403, 404, 422])('API %i (forbidden / no logo / not scanned) -> same status, empty body, never cached', async (status) => {
    upstream(() => new Response(JSON.stringify({ code: 'x', detail: 'internal detail' }), { status, headers: { 'content-type': 'application/problem+json' } }));
    const res = await (await load())();
    expect(res.status).toBe(status); expect(await res.text()).toBe(''); expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it.each([
    ['API 500', () => new Response('boom', { status: 500 })],
    ['a 200 that is not PNG or JPEG (HTML)', () => new Response('<script>alert(1)</script>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['a 200 SVG', () => new Response('<svg onload="alert(1)"/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } })],
    ['a 200 without a content type', () => new Response(PNG, { status: 200 })],
  ])('%s -> 502 with an empty body (nothing but PNG / JPEG is ever passed to the browser)', async (_n, r) => {
    upstream(r as () => Response); const res = await (await load())();
    expect(res.status).toBe(502); expect(await res.text()).toBe('');
  });
  it('API unreachable -> 502, no exception', async () => {
    fetchMock = vi.fn(async () => { throw new TypeError('fetch failed'); }); vi.stubGlobal('fetch', fetchMock);
    const res = await (await load())(); expect(res.status).toBe(502);
  });
  it('API origin not configured -> 500, the API is not called', async () => {
    delete process.env.LIMS_ORIGIN_API; const res = await (await load())();
    expect(res.status).toBe(500); expect(fetchMock).not.toHaveBeenCalled();
  });
});
