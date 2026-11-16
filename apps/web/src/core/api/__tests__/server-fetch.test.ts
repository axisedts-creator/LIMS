// T0A-CLIENTIP-1 / LD-296: serverFetch (core/api/server-fetch.ts) forwards the real client ip and browser user agent.
//   (1) x-forwarded-for = first entry of the incoming header (bare IP literal only), user-agent = the browser's (trimmed, <= 512); missing -> not sent.
//   (2) KEY ON READS (done_when 2): X-Lims-Bff-Key via readBffKey, cached after the first success; if readBffKey throws serverFetch keeps working without the key.
//       NOTE for the writer: if reading services/api/src/core/openapi.ts + claims-resolver.ts shows a verified BFF kind changes anything beyond the client
//       address for a bearer request, do NOT send the key (the brief says: write a CR + notes). Then the "KEY ON READS" describe below is the part that
//       changes with a lead ruling; do not weaken it silently.
//   Never copies the incoming cookie / authorization, never logs a secret.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ current: undefined as unknown as Headers, fail: false }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => {
    if (h.fail) throw new Error('headers() was called outside a request scope');
    return h.current;
  },
}));
vi.mock('../../session/server', () => ({ getAccessToken: async () => 'JWT-SENTINEL-abc' }));

const KEY = 'bff-key-serverfetch-synthetic-0123456789';
const KEY2 = 'bff-key-serverfetch-ROTATED-9876543210';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15';
let fetchMock: ReturnType<typeof vi.fn>;
let serverFetch: typeof import('../server-fetch').serverFetch;

const sent = (i = 0) => new Headers((fetchMock.mock.calls[i]![1] as RequestInit).headers);
const incoming = (o: Record<string, string>) => { h.current = new Headers(o); };

beforeEach(async () => {
  vi.resetModules(); // the BFF key is cached per module instance
  h.fail = false;
  incoming({});
  for (const k of ['LIMS_WEB_BFF_KEY', 'LIMS_WEB_BFF_KEY_FILE']) delete process.env[k];
  process.env.LIMS_CORE_ENV = 'ci';
  process.env.LIMS_ORIGIN_API = 'https://api.lims-test.invalid';
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  ({ serverFetch } = await import('../server-fetch'));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('client address and user agent', () => {
  it('sends x-forwarded-for (first entry) and the browser user agent; the bearer token is still sent', async () => {
    incoming({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': UA });
    await expect(serverFetch('/v1/lab/orders')).resolves.toEqual({ ok: true });
    const s = sent();
    expect(s.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(s.get('user-agent')).toBe(UA);
    expect(s.get('authorization')).toBe('Bearer JWT-SENTINEL-abc');
  });
  it('x-real-ip fallback', async () => {
    incoming({ 'x-real-ip': '198.51.100.9', 'user-agent': UA });
    await serverFetch('/v1/lab/orders');
    expect(sent().get('x-forwarded-for')).toBe('198.51.100.9');
  });
  it('IPv6 client', async () => {
    incoming({ 'x-forwarded-for': '2001:db8::1, 10.0.0.1' });
    await serverFetch('/v1/lab/orders');
    expect(sent().get('x-forwarded-for')).toBe('2001:db8::1');
  });
  it('user agent longer than 512 characters is truncated', async () => {
    incoming({ 'user-agent': 'z'.repeat(2000) });
    await serverFetch('/v1/lab/orders');
    expect(sent().get('user-agent')).toBe('z'.repeat(512));
  });
  it.each(['not-an-ip', '203.0.113.7:443', 'unknown'])('junk first entry %j -> x-forwarded-for not sent', async (xff) => {
    incoming({ 'x-forwarded-for': xff, 'user-agent': UA });
    await serverFetch('/v1/lab/orders');
    expect(sent().has('x-forwarded-for')).toBe(false);
    expect(sent().get('user-agent')).toBe(UA);
  });
  it('missing values are simply not sent (no empty header, no "undefined")', async () => {
    await serverFetch('/v1/lab/orders');
    const s = sent();
    expect(s.has('x-forwarded-for')).toBe(false);
    expect(s.has('user-agent')).toBe(false);
    expect([...s.values()].join('|')).not.toMatch(/undefined/);
  });
  it('outside a request scope (headers() throws) the call still works, without the two headers', async () => {
    h.fail = true;
    await expect(serverFetch('/v1/lab/orders')).resolves.toEqual({ ok: true });
    expect(sent().has('x-forwarded-for')).toBe(false);
    expect(sent().has('user-agent')).toBe(false);
  });
  it('a caller-supplied header in init.headers is kept (existing behaviour)', async () => {
    incoming({ 'x-forwarded-for': '203.0.113.7' });
    await serverFetch('/v1/lab/orders', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' }, body: '{}' });
    const s = sent();
    expect(s.get('idempotency-key')).toBe('k-1');
    expect(s.get('content-type')).toBe('application/json');
    expect(s.get('x-forwarded-for')).toBe('203.0.113.7');
  });
  it('the incoming cookie, authorization and bff key are never copied onto the API call', async () => {
    incoming({ 'x-forwarded-for': '203.0.113.7', cookie: '__Host-lims_sid=SECRET-SID', authorization: 'Bearer BROWSER-SECRET', 'x-lims-bff-key': 'BROWSER-FORGED-KEY' });
    process.env.LIMS_WEB_BFF_KEY = KEY;
    await serverFetch('/v1/lab/orders');
    const s = sent();
    expect(s.has('cookie')).toBe(false);
    expect(s.get('authorization')).toBe('Bearer JWT-SENTINEL-abc');
    expect(s.get('x-lims-bff-key')).not.toBe('BROWSER-FORGED-KEY');
    expect([...s.values()].join('|')).not.toMatch(/SECRET-SID|BROWSER-SECRET|BROWSER-FORGED-KEY/);
  });
  it('nothing is logged (no key, token, cookie or user agent)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    process.env.LIMS_WEB_BFF_KEY = KEY;
    incoming({ 'x-forwarded-for': '203.0.113.7', 'user-agent': UA, cookie: '__Host-lims_sid=SECRET-SID' });
    await serverFetch('/v1/lab/orders');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe('KEY ON READS (done_when 2): X-Lims-Bff-Key through readBffKey, cached', () => {
  it('sends X-Lims-Bff-Key when a key is configured (env fallback, LIMS_CORE_ENV=ci)', async () => {
    process.env.LIMS_WEB_BFF_KEY = KEY;
    incoming({ 'x-forwarded-for': '203.0.113.7' });
    await serverFetch('/v1/lab/orders');
    expect(sent().get('x-lims-bff-key')).toBe(KEY);
  });
  it('sends the key from LIMS_WEB_BFF_KEY_FILE (file wins)', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'clientip1-')), 'bff.key');
    writeFileSync(f, `${KEY}\n`);
    process.env.LIMS_WEB_BFF_KEY_FILE = f;
    process.env.LIMS_WEB_BFF_KEY = 'ignored-env-key';
    await serverFetch('/v1/lab/orders');
    expect(sent().get('x-lims-bff-key')).toBe(KEY);
  });
  it('the key is cached after the first successful read (same as c2.ts)', async () => {
    process.env.LIMS_WEB_BFF_KEY = KEY;
    await serverFetch('/v1/lab/orders');
    process.env.LIMS_WEB_BFF_KEY = KEY2;
    await serverFetch('/v1/lab/orders');
    expect(sent(0).get('x-lims-bff-key')).toBe(KEY);
    expect(sent(1).get('x-lims-bff-key')).toBe(KEY);
  });
  it('readBffKey throws (no key configured: dev / test) -> serverFetch still works, no key header, address and agent still sent', async () => {
    incoming({ 'x-forwarded-for': '203.0.113.7', 'user-agent': UA });
    await expect(serverFetch('/v1/lab/orders')).resolves.toEqual({ ok: true });
    const s = sent();
    expect(s.has('x-lims-bff-key')).toBe(false);
    expect(s.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(s.get('user-agent')).toBe(UA);
    expect(s.get('authorization')).toBe('Bearer JWT-SENTINEL-abc');
  });
  it('a failed read is not cached: the key is sent once it becomes available', async () => {
    await serverFetch('/v1/lab/orders');
    expect(sent(0).has('x-lims-bff-key')).toBe(false);
    process.env.LIMS_WEB_BFF_KEY = KEY;
    await serverFetch('/v1/lab/orders');
    expect(sent(1).get('x-lims-bff-key')).toBe(KEY);
  });
  it('production-like env (LIMS_CORE_ENV=production, env key only) fails closed in readBffKey -> no key header, call still works', async () => {
    process.env.LIMS_CORE_ENV = 'production';
    process.env.LIMS_WEB_BFF_KEY = KEY;
    await expect(serverFetch('/v1/lab/orders')).resolves.toEqual({ ok: true });
    expect(sent().has('x-lims-bff-key')).toBe(false);
  });
});

describe('existing behaviour unchanged', () => {
  it('non-2xx still throws ApiError with the problem code', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ type: 'urn:lims:error:auth.forbidden', title: 'Forbidden', status: 403, code: 'auth.forbidden' }), { status: 403, headers: { 'content-type': 'application/problem+json' } }));
    const { ApiError } = await import('../server-fetch');
    await expect(serverFetch('/v1/lab/orders')).rejects.toBeInstanceOf(ApiError);
  });
  it('x-request-id, traceparent, accept and redirect:error are still set', async () => {
    await serverFetch('/v1/lab/orders');
    const s = sent();
    expect(s.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(s.get('accept')).toBe('application/json');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).redirect).toBe('error');
  });
});
