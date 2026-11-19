// T0A-CLIENTIP-1 / LD-296: c2Resolver (core/session/c2.ts) forwards the real client ip and browser user agent on resolveSession,
// next to the BFF key and the opaque session cookie. Missing values are not sent. Nothing else from the incoming request is copied.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ current: undefined as unknown as Headers, fail: false }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => {
    if (h.fail) throw new Error('headers() was called outside a request scope');
    return h.current;
  },
}));
import { c2Resolver } from '../c2';

const SID = 'S'.padEnd(43, '0');
const KEY = 'synthetic-web-bff-key-0123456789';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
const OK_BODY = { access_token: 'ACCESS', session: { session_id: '0190a000-0000-7000-8000-000000000001', kind: 'tenant_staff', state: 'mfa_pending', aal: 'aal1',
  idle_expires_at: '2026-11-16T07:00:00.000Z', absolute_expires_at: '2026-11-16T15:00:00.000Z', actor: { display_name: 'Ana Demo', tenant_code: 'lab_a', roles: [] } } };
let fetchMock: ReturnType<typeof vi.fn>;
const sent = () => new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers);
const incoming = (o: Record<string, string>) => { h.current = new Headers(o); };
const resolve = () => c2Resolver.resolve(SID, { touch: false });

beforeEach(() => {
  h.fail = false;
  incoming({});
  process.env.LIMS_CORE_ENV = 'ci'; process.env.LIMS_WEB_BFF_KEY = KEY; process.env.LIMS_ORIGIN_API = 'https://api.lims-test.invalid';
  delete process.env.LIMS_WEB_BFF_KEY_FILE;
  fetchMock = vi.fn(async () => new Response(JSON.stringify(OK_BODY), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('c2Resolver forwards the client context', () => {
  it('sends x-forwarded-for (first entry) and the browser user agent, keeping the BFF key and the session cookie', async () => {
    incoming({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': UA });
    const r = await resolve();
    expect(r.ok).toBe(true);
    const s = sent();
    expect(s.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(s.get('user-agent')).toBe(UA);
    expect(s.get('x-lims-bff-key')).toBe(KEY);
    expect(s.get('cookie')).toBe(`__Host-lims_sid=${encodeURIComponent(SID)}`);
    expect(s.get('content-type')).toBe('application/json');
  });
  it('x-real-ip fallback; user agent truncated to 512', async () => {
    incoming({ 'x-real-ip': '198.51.100.9', 'user-agent': 'q'.repeat(900) });
    await resolve();
    expect(sent().get('x-forwarded-for')).toBe('198.51.100.9');
    expect(sent().get('user-agent')).toBe('q'.repeat(512));
  });
  it.each(['not-an-ip', '203.0.113.7:443', '[2001:db8::1]:443'])('junk first entry %j -> x-forwarded-for not sent', async (xff) => {
    incoming({ 'x-forwarded-for': xff, 'user-agent': UA });
    await resolve();
    expect(sent().has('x-forwarded-for')).toBe(false);
  });
  it('missing values are not sent', async () => {
    await resolve();
    expect(sent().has('x-forwarded-for')).toBe(false);
    expect(sent().has('user-agent')).toBe(false);
  });
  it('outside a request scope (headers() throws, e.g. middleware) -> still resolves, without the two headers', async () => {
    h.fail = true;
    const r = await resolve();
    expect(r.ok).toBe(true);
    expect(sent().has('x-forwarded-for')).toBe(false);
    expect(sent().has('user-agent')).toBe(false);
    expect(sent().get('x-lims-bff-key')).toBe(KEY);
  });
  it('the browser cookie (the sid) is not copied from the incoming headers; only the sid argument is forwarded as cookie', async () => {
    incoming({ 'x-forwarded-for': '203.0.113.7', cookie: '__Host-lims_sid=OTHER-SECRET; other=1', authorization: 'Bearer BROWSER-SECRET' });
    await resolve();
    const s = sent();
    expect(s.get('cookie')).toBe(`__Host-lims_sid=${encodeURIComponent(SID)}`);
    expect(s.has('authorization')).toBe(false);
    expect([...s.values()].join('|')).not.toMatch(/OTHER-SECRET|BROWSER-SECRET/);
  });
  it('a request-scope failure never turns a good session into 503 (fail-soft)', async () => {
    h.fail = true;
    const r = await resolve();
    expect(r).toMatchObject({ ok: true });
  });
  it('nothing is logged', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    incoming({ 'x-forwarded-for': '203.0.113.7', 'user-agent': UA });
    await resolve();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
