// T0A-CLIENTIP-1 / LD-296: the login call (features/admin/auth/actions.ts `call`, used by every AU action) sends the real client ip and the
// BROWSER user agent (replacing node's) next to X-Lims-Bff-Key. SEC-ABUSE-1 / LD-237: the ip is x-vercel-forwarded-for, else x-real-ip, only when it is a bare literal;
// the client-supplied x-forwarded-for list is never read (its first element is attacker-chosen). The outgoing header to the API keeps the name x-forwarded-for.
// Same harness as t12.actions.test.ts (MSW stands in for /v1/identity/auth/*).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BFF_KEY, SID, api, apiCalls, form, headerStore, headersMock, json, navigationMock, reply, resetApi, run, sessionState, setEnv, NEW_TOKEN } from './t12.harness';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => (await import('./t12.harness')).headersMock);
vi.mock('next/navigation', async () => (await import('./t12.harness')).navigationMock);

type A = typeof import('../actions');
let A: A;
beforeAll(async () => {
  setEnv();
  api.listen({ onUnhandledFrame: 'error' });
  A = (await import('../actions')) as A;
});
beforeEach(() => resetApi());
afterEach(() => api.resetHandlers());
afterAll(() => api.close());
void headersMock; void navigationMock;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const LOGIN = form({ email: 'user@example.test', password: 'Correct-horse-battery-1' });
const login = async () => {
  reply['/login'] = () => json(200, { session_token: NEW_TOKEN, session: sessionState('active') });
  await run(() => A.loginStaffAction(LOGIN));
  const [c] = apiCalls('/login');
  expect(c).toBeDefined();
  return c!.headers;
};
const incoming = (o: Record<string, string>) => {
  for (const k of [...headerStore.keys()]) headerStore.delete(k);
  for (const [k, v] of Object.entries(o)) headerStore.set(k, v);
};

describe('loginStaffAction sends the client context', () => {
  it('browser user agent replaces node; x-vercel-forwarded-for (not a spoofed x-forwarded-for); BFF key kept', async () => {
    incoming({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '6.6.6.6, 10.0.0.1', 'user-agent': UA });
    const h = await login();
    expect(h.get('user-agent')).toBe(UA);
    expect(h.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(h.get('x-lims-bff-key')).toBe(BFF_KEY);
  });
  it('user agent is trimmed and capped at 512', async () => {
    incoming({ 'x-vercel-forwarded-for': '203.0.113.7', 'user-agent': `  ${'m'.repeat(700)}  ` });
    expect((await login()).get('user-agent')).toBe('m'.repeat(512));
  });
  it('x-real-ip fallback', async () => {
    incoming({ 'x-real-ip': '198.51.100.9', 'user-agent': UA });
    expect((await login()).get('x-forwarded-for')).toBe('198.51.100.9');
  });
  it('IPv6 client', async () => {
    incoming({ 'x-vercel-forwarded-for': '2001:db8::1', 'user-agent': UA });
    expect((await login()).get('x-forwarded-for')).toBe('2001:db8::1');
  });
  it.each(['203.0.113.7:51234', 'not-an-ip', '[2001:db8::1]:443', 'unknown'])('junk or port x-vercel-forwarded-for %j is NOT forwarded (the API would otherwise log it or fall back)', async (xff) => {
    incoming({ 'x-vercel-forwarded-for': xff, 'user-agent': UA });
    expect((await login()).has('x-forwarded-for')).toBe(false);
  });
  it('no incoming user agent -> the web adds none of its own (no fabricated value)', async () => {
    incoming({ 'x-vercel-forwarded-for': '203.0.113.7' });
    const ua = (await login()).get('user-agent');
    expect(ua === null || ua === 'node' || /^node/.test(ua)).toBe(true); // undici's own default may remain; the web must not invent a browser string
    expect(ua).not.toMatch(/Mozilla/);
  });
  it('every AU action carries it, a cookie-bound one included (mfa/verify)', async () => {
    incoming({ 'x-vercel-forwarded-for': '203.0.113.7', 'user-agent': UA });
    reply['/mfa/verify'] = () => json(200, { state: 'active' });
    await run(() => A.verifyMfaAction(form({ code: '123456' })));
    const [c] = apiCalls('/mfa/verify');
    expect(c?.headers.get('user-agent')).toBe(UA);
    expect(c?.headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(c?.headers.get('cookie')).toContain(SID);
  });
  it('the incoming cookie and authorization are never forwarded verbatim (only the sid the action reads)', async () => {
    incoming({ 'x-vercel-forwarded-for': '203.0.113.7', 'user-agent': UA, cookie: 'other=SECRET-COOKIE', authorization: 'Bearer BROWSER-SECRET' });
    const h = await login();
    expect(h.get('authorization')).toBeNull();
    expect([...h.values()].join('|')).not.toMatch(/SECRET-COOKIE|BROWSER-SECRET/);
  });
  it('request body is still only the credentials (the user agent is a header, not a field)', async () => {
    incoming({ 'x-vercel-forwarded-for': '203.0.113.7', 'user-agent': UA });
    await login();
    expect(apiCalls('/login')[0]?.body).toEqual({ email: 'user@example.test', password: 'Correct-horse-battery-1' });
  });
});
