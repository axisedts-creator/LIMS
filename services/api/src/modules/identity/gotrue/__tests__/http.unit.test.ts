// gateway.http.ts with a stubbed fetch: behaviour that must hold regardless of the exact GoTrue paths (those are mapping.md + live tests).
// Required factory: createHttpGoTrueGateway({ url, serviceKey, fetch?: typeof fetch, timeoutMs?: number /* default 3000 */ }).
// Outage / timeout / open circuit throw LimsError('common.dependency_unavailable'); 4xx auth failures map to {ok:false}.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { createHttpGoTrueGateway } from '../gateway.http.js';

const SERVICE_KEY = 'svc-key-SECRET-0123456789';
const UID = '0190a000-0000-7000-8000-00000000a001';
const SID = '0190a000-0000-7000-8000-00000000b001';
const jwt = (c: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(c)).toString('base64url')}.s`;
const EXP = Math.floor(Date.now() / 1000) + 3600;
const tokenBody = (aal = 'aal1') => ({
  access_token: jwt({ sub: UID, session_id: SID, aal, role: 'authenticated', aud: 'authenticated', iat: EXP - 3600, exp: EXP }),
  refresh_token: 'rt-1', token_type: 'bearer', expires_in: 3600, expires_at: EXP, user: { id: UID },
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Fetch = typeof fetch;
const headerOf = (init: RequestInit | undefined, name: string): string | null => new Headers(init?.headers).get(name);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('token mapping', () => {
  it('signIn ok: userId/sessionId/aal/expiresAt come from the response + JWT claims', async () => {
    const f = vi.fn<Fetch>(async () => json(200, tokenBody('aal2')));
    const g = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: f });
    const r = await g.signInWithPassword('a@b.example', 'pw');
    expect(r).toEqual({ ok: true, tokens: expect.objectContaining({ userId: UID, sessionId: SID, aal: 'aal2', expiresAt: EXP, refreshToken: 'rt-1' }) });
  });
  it.each([400, 401, 422])('signIn %i → {ok:false}', async (status) => {
    const g = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: async () => json(status, { error_code: 'invalid_credentials', msg: 'x' }) });
    expect(await g.signInWithPassword('a@b.example', 'pw')).toEqual({ ok: false });
  });
  it.each([500, 502, 503])('signIn %i is an OUTAGE → throws dependency_unavailable, never {ok:false}', async (status) => {
    const g = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: async () => json(status, {}) });
    const e = await g.signInWithPassword('a@b.example', 'pw').catch((x: unknown) => x);
    expect(isLimsError(e, 'common.dependency_unavailable')).toBe(true);
  });
  it('access token without session_id claim is rejected (08 R10.6), not returned', async () => {
    const body = tokenBody(); body.access_token = jwt({ sub: UID, aal: 'aal1', exp: EXP });
    const g = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: async () => json(200, body) });
    const r = await g.signInWithPassword('a@b.example', 'pw').catch((x: unknown) => x);
    expect(r === Object(r) && (r as { ok?: boolean }).ok === true).toBe(false);
  });
  it('missing aal claim = aal1', async () => {
    const body = tokenBody(); body.access_token = jwt({ sub: UID, session_id: SID, exp: EXP });
    const g = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: async () => json(200, body) });
    const r = await g.signInWithPassword('a@b.example', 'pw');
    expect(r.ok && r.tokens.aal).toBe('aal1');
  });
});

describe('service-key confinement (CR-C2-014, REQ-SEC-029/030)', () => {
  it('user-level calls never carry the service key; admin calls always do', async () => {
    const f = vi.fn<Fetch>(async () => json(200, tokenBody()));
    const g = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: f });
    await g.signInWithPassword('a@b.example', 'pw');
    await g.refresh('rt');
    await g.signOut('user-access-token', 'local').catch(() => undefined);
    await g.mfaListFactors('user-access-token').catch(() => undefined);
    for (const [, init] of f.mock.calls) {
      const wire = JSON.stringify([...new Headers(init?.headers).entries()]) + String(init?.body ?? '');
      expect(wire).not.toContain(SERVICE_KEY);
    }
    f.mockClear(); f.mockImplementation(async () => json(200, { id: UID }));
    await g.adminSignOutUser(UID).catch(() => undefined);
    await g.adminUpdatePassword(UID, 'Abcdef-12345').catch(() => undefined);
    await g.adminCreateUser({ email: 'a@b.example', emailConfirm: true }).catch(() => undefined);
    expect(f.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [, init] of f.mock.calls) expect(headerOf(init, 'authorization')).toBe(`Bearer ${SERVICE_KEY}`);
  });
  it('user-token calls send that token as the bearer', async () => {
    const f = vi.fn<Fetch>(async () => json(200, []));
    const g = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: f });
    await g.mfaListFactors('user-access-token').catch(() => undefined);
    expect(headerOf(f.mock.calls[0]![1], 'authorization')).toBe('Bearer user-access-token');
  });
  it('errors and their serialisation never contain the service key, request body password, or response body', async () => {
    const g = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: async () => json(500, { msg: 'boom-RESPONSE-BODY' }) });
    const e = await g.adminUpdatePassword(UID, 'Sup3r-secret-pw!').catch((x: unknown) => x);
    const s = String((e as Error).message) + String((e as Error).stack) + JSON.stringify(e);
    for (const bad of [SERVICE_KEY, 'Sup3r-secret-pw!']) expect(s).not.toContain(bad);
  });
});

describe('timeout 3 s, retry, circuit (02-TRD s8)', () => {
  const never: Fetch = (_u, init) => new Promise((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); });

  it('a call that never answers is aborted at 3000 ms → dependency_unavailable', async () => {
    const g = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: never });
    const p = g.adminSignOutUser(UID).catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(2999);
    let settled = false; void p.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(isLimsError(await p, 'common.dependency_unavailable')).toBe(true);
  });
  it('refresh: ONE retry after 200 ms on a network error only', async () => {
    let n = 0;
    const f = vi.fn<Fetch>(async () => { if (n++ === 0) throw new TypeError('fetch failed'); return json(200, tokenBody()); });
    const g = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: f });
    const p = g.refresh('rt');
    await vi.advanceTimersByTimeAsync(199); expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect((await p).ok).toBe(true); expect(f).toHaveBeenCalledTimes(2);
  });
  it('refresh: a second network error is not retried again; 4xx / 5xx are not retried', async () => {
    const f1 = vi.fn<Fetch>(async () => { throw new TypeError('fetch failed'); });
    const g1 = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: f1 });
    const p1 = g1.refresh('rt').catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(5000);
    expect(isLimsError(await p1, 'common.dependency_unavailable')).toBe(true); expect(f1).toHaveBeenCalledTimes(2);

    const f2 = vi.fn<Fetch>(async () => json(400, { error_code: 'refresh_token_not_found' }));
    const g2 = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: f2 });
    expect(await g2.refresh('rt')).toMatchObject({ ok: false, reason: expect.stringMatching(/^(invalid|revoked|reused)$/) });
    expect(f2).toHaveBeenCalledTimes(1);

    const f3 = vi.fn<Fetch>(async () => json(503, {}));
    const g3 = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: f3 });
    await g3.refresh('rt').catch(() => undefined);
    expect(f3).toHaveBeenCalledTimes(1);
  });
  it('non-refresh calls are never retried', async () => {
    const f = vi.fn<Fetch>(async () => { throw new TypeError('fetch failed'); });
    const g = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: f });
    const p = g.adminSignOutUser(UID).catch((x: unknown) => x);
    await vi.advanceTimersByTimeAsync(5000); await p;
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('5 consecutive failures open the circuit for 30 s: no fetch, dependency_unavailable; then a probe goes through', async () => {
    let ok = false;
    const f = vi.fn<Fetch>(async () => (ok ? json(200, {}) : json(503, {})));
    const g = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: f });
    for (let i = 0; i < 5; i++) await g.adminSignOutUser(UID).catch(() => undefined);
    expect(f).toHaveBeenCalledTimes(5);
    const e = await g.adminSignOutUser(UID).catch((x: unknown) => x);
    expect(isLimsError(e, 'common.dependency_unavailable')).toBe(true); expect(f).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(isLimsError(await g.adminSignOutUser(UID).catch((x: unknown) => x), 'common.dependency_unavailable')).toBe(true);
    expect(f).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1_500); ok = true;
    await expect(g.adminSignOutUser(UID)).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledTimes(6);
  });
  it('wrong-password 400s and a success in between do not count toward the circuit', async () => {
    let n = 0;
    const f = vi.fn<Fetch>(async () => (n++ < 20 ? json(400, { error_code: 'invalid_credentials' }) : json(200, tokenBody())));
    const g = createHttpGoTrueGateway({ url: 'http://gotrue:9999', serviceKey: SERVICE_KEY, fetch: f });
    for (let i = 0; i < 20; i++) expect(await g.signInWithPassword('a@b.example', 'bad')).toEqual({ ok: false });
    expect((await g.signInWithPassword('a@b.example', 'good')).ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(21);
  });
});
