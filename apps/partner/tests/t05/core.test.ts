// C13.T05 — partner BFF core: session.ts, auth-guard.ts, api.ts, csrf.ts (02-TRD §3.6/§3.8, 04-UI-UX §4.10 F1, 03-APP-FLOW §6).
// ACs: US-03.1 (cookie name/flags, no JWT in browser), US-03.2/03.3 (kind bound by partner BFF key), US-03.5 (session ended -> /auth/login?reason=session),
//      US-02.7 (mfa_enrolment_required blocks every data page), REQ-SEC-091 (Origin + Sec-Fetch-Site), AB13 (staff session through the partner BFF).
// ASSUMED contract (names not fixed by the spec; see actions.test.ts header):
//   src/core/session.ts      PARTNER_SESSION_COOKIE, partnerSessionCookieOptions, readPartnerSessionId(cookieHeader),
//                            resolvePartnerSession({touch}) -> { ok:true, session, accessToken } | { ok:false, status, problem }
//                            (POST ${LIMS_PARTNER_BFF_API_URL}/v1/identity/auth/session/resolve with X-Lims-Bff-Key + cookie __Host-lims_sid (bffSession wire name); browser cookie stays __Host-lims_psid; 'server-only')
//   src/core/auth-guard.ts   requirePartnerSession() -> { session, accessToken } for state 'active', else redirect() (throws)
//   src/core/api.ts          partnerApi(path, { method?, body?, headers? }) -> { ok, status, data?, problem? }; path must be /v1/partners/**
//   src/core/csrf.ts         checkCsrf({ method, headers }) -> { ok:true } | { ok:false, status:403, code:'auth.csrf_failed' }
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH, BFF_COOKIE, BFF_KEY, COOKIE, JWT, NEW_TOKEN, ORIGIN, SID, headerStore, installFetch, jar, json, networkError, problem, reply, resetApi, resolved, restoreFetch, run,
  seen, setEnv,
} from './harness';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => (await import('./harness')).headersMock);
vi.mock('next/navigation', async () => (await import('./harness')).navigationMock);

const RESOLVE = `${AUTH}/session/resolve`;
const resolveCalls = () => seen.filter((s) => s.path === RESOLVE);

let S: typeof import('../../src/core/session');
let G: typeof import('../../src/core/auth-guard');
let P: typeof import('../../src/core/api');
let C: typeof import('../../src/core/csrf');
beforeAll(async () => {
  setEnv();
  installFetch();
  S = await import('../../src/core/session');
  G = await import('../../src/core/auth-guard');
  P = await import('../../src/core/api');
  C = await import('../../src/core/csrf');
});
afterAll(() => restoreFetch());
beforeEach(() => resetApi());

describe('session.ts', () => {
  it('cookie is __Host-lims_psid with HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain (US-03.1, TRD §3.8 item 2)', () => {
    expect(S.PARTNER_SESSION_COOKIE).toBe('__Host-lims_psid');
    expect(S.partnerSessionCookieOptions).toMatchObject({ httpOnly: true, secure: true, path: '/' });
    expect(String(S.partnerSessionCookieOptions.sameSite).toLowerCase()).toBe('lax');
    expect((S.partnerSessionCookieOptions as Record<string, unknown>).domain).toBeUndefined();
  });

  it('readPartnerSessionId reads only __Host-lims_psid (staff __Host-lims_sid, unprefixed lims_psid and look-alikes are ignored)', () => {
    expect(S.readPartnerSessionId(`a=1; ${COOKIE}=abc123; b=2`)).toBe('abc123');
    expect(S.readPartnerSessionId('__Host-lims_sid=staff-token')).toBeUndefined();
    expect(S.readPartnerSessionId('lims_psid=x')).toBeUndefined();
    expect(S.readPartnerSessionId(`x${COOKIE}=x`)).toBeUndefined();
    expect(S.readPartnerSessionId(`${COOKIE}=`)).toBeUndefined();
    expect(S.readPartnerSessionId(undefined)).toBeUndefined();
  });

  it('resolvePartnerSession POSTs {touch} to C2 /auth/session/resolve with the partner BFF key and the opaque cookie; returns session + access token', async () => {
    reply[RESOLVE] = () => json(200, resolved('active'));
    const r = await S.resolvePartnerSession({ touch: true });
    const [c] = resolveCalls();
    expect(c?.method).toBe('POST');
    expect(c?.body).toEqual({ touch: true });
    expect(c?.headers.get('x-lims-bff-key')).toBe(BFF_KEY);
    expect(c?.headers.get('cookie')).toContain(`${BFF_COOKIE}=${SID}`);
    expect(c?.headers.get('cookie')).not.toContain(COOKIE);
    expect(c?.headers.get('x-lims-origin')).toBeNull(); // kind is bound by the key, never by a client header (08 R10)
    expect(r).toMatchObject({ ok: true, accessToken: JWT });
  });

  it('touch:false for background polling (X-Lims-Background: 1), touch:true otherwise (TRD §5.4)', async () => {
    reply[RESOLVE] = () => json(200, resolved('active'));
    await S.resolvePartnerSession({ touch: true });
    headerStore.set('x-lims-background', '1');
    await S.resolvePartnerSession({ touch: false });
    expect(resolveCalls().map((c) => (c.body as { touch: boolean }).touch)).toEqual([true, false]);
  });

  it('no cookie -> { ok:false, 401 auth.unauthenticated } without calling the API', async () => {
    jar.current = undefined;
    const r = await S.resolvePartnerSession({ touch: true });
    expect(r).toMatchObject({ ok: false, status: 401, problem: { code: 'auth.unauthenticated' } });
    expect(seen).toHaveLength(0);
  });

  it('relays C2 401 auth.session_expired unchanged; API 5xx / unreachable -> 503 common.dependency_unavailable', async () => {
    reply[RESOLVE] = () => json(401, problem('auth.session_expired', 401));
    expect(await S.resolvePartnerSession({ touch: true })).toMatchObject({ ok: false, status: 401, problem: { code: 'auth.session_expired' } });
    reply[RESOLVE] = () => json(500, problem('common.internal', 500));
    expect(await S.resolvePartnerSession({ touch: true })).toMatchObject({ ok: false, status: 503, problem: { code: 'common.dependency_unavailable' } });
    reply[RESOLVE] = () => networkError();
    expect(await S.resolvePartnerSession({ touch: true })).toMatchObject({ ok: false, status: 503, problem: { code: 'common.dependency_unavailable' } });
  });

  it('never leaks the BFF key or the cookie value in what it returns', async () => {
    reply[RESOLVE] = () => json(200, resolved('active'));
    const s = JSON.stringify(await S.resolvePartnerSession({ touch: true }));
    expect(s).not.toContain(BFF_KEY);
    expect(s).not.toContain(SID);
  });
});

describe('auth-guard.ts requirePartnerSession (every (app) route)', () => {
  it('active partner session -> returns { session, accessToken }', async () => {
    reply[RESOLVE] = () => json(200, resolved('active'));
    const r = await run(() => G.requirePartnerSession());
    expect(r.redirect).toBeUndefined();
    expect(r.result).toMatchObject({ accessToken: JWT });
  });

  it('no cookie -> redirect /auth/login (no reason banner), no API call', async () => {
    jar.current = undefined;
    expect((await run(() => G.requirePartnerSession())).redirect).toBe('/auth/login');
    expect(seen).toHaveLength(0);
  });

  it('US-03.5: C2 401 auth.session_expired (idle/absolute timeout, revoked, deactivated) -> redirect /auth/login?reason=session', async () => {
    reply[RESOLVE] = () => json(401, problem('auth.session_expired', 401));
    expect((await run(() => G.requirePartnerSession())).redirect).toBe('/auth/login?reason=session');
  });

  it.each([
    ['mfa_pending', '/auth/mfa'],
    ['mfa_enrolment_required', '/auth/mfa/enrol'],
    ['password_setup', '/auth/set-password'],
  ])('state %s -> redirect %s and the access token is never handed to the page (US-02.7: no data page before TOTP enrolment)', async (state, to) => {
    reply[RESOLVE] = () => json(200, resolved(state));
    const r = await run(() => G.requirePartnerSession());
    expect(r.redirect).toBe(to);
    expect(r.result).toBeUndefined();
  });

  it('AB13: a resolved session whose kind is not "partner" (staff session replayed through the partner BFF) is rejected -> /auth/login?reason=session', async () => {
    reply[RESOLVE] = () => json(200, { ...resolved('active'), session: { ...resolved('active').session, kind: 'tenant_staff' } });
    const r = await run(() => G.requirePartnerSession());
    expect(r.redirect).toBe('/auth/login?reason=session');
    expect(r.result).toBeUndefined();
  });

  it('C2 non-401 failures (503) do not look like a sign-out: the guard throws instead of redirecting to login', async () => {
    reply[RESOLVE] = () => json(500, problem('common.internal', 500));
    await expect(G.requirePartnerSession()).rejects.toThrow();
  });
});

describe('api.ts partnerApi (BFF -> /v1/partners/*)', () => {
  const ME = '/v1/partners/me';
  beforeEach(() => { reply[RESOLVE] = () => json(200, resolved('active')); });

  it('GET: resolves the session (touch:true), sends Authorization: Bearer <access JWT>, X-Request-Id and traceparent, never the cookie; returns data without the JWT', async () => {
    reply[ME] = () => json(200, { partner: { id: 'p1', name: 'Partner X' } });
    const r = await P.partnerApi(ME);
    const call = seen.find((s) => s.path === ME);
    expect(call?.method).toBe('GET');
    expect(call?.headers.get('authorization')).toBe(`Bearer ${JWT}`);
    expect(call?.headers.get('x-request-id')).toBeTruthy();
    expect(call?.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(call?.headers.get('cookie')).toBeNull();
    expect(resolveCalls()[0]?.body).toEqual({ touch: true });
    expect(r).toMatchObject({ ok: true, status: 200, data: { partner: { name: 'Partner X' } } });
    expect(JSON.stringify(r)).not.toContain(JWT);
  });

  it('forwards a problem+json body for API errors (e.g. 403 partners.partner_inactive) as { ok:false, problem }', async () => {
    reply[ME] = () => json(403, problem('partners.partner_inactive', 403));
    expect(await P.partnerApi(ME)).toMatchObject({ ok: false, status: 403, problem: { code: 'partners.partner_inactive' } });
  });

  it('403 auth.mfa_required -> redirect /auth/mfa; 403 identity.mfa_enrolment_required -> redirect /auth/mfa/enrol', async () => {
    reply[ME] = () => json(403, problem('auth.mfa_required', 403));
    expect((await run(() => P.partnerApi(ME))).redirect).toMatch(/^\/auth\/mfa(\?|$)/);
    reply[ME] = () => json(403, problem('identity.mfa_enrolment_required', 403));
    expect((await run(() => P.partnerApi(ME))).redirect).toMatch(/^\/auth\/mfa\/enrol(\?|$)/);
  });

  it('401 auth.session_expired from the resolver or the API -> redirect /auth/login?reason=session', async () => {
    reply[RESOLVE] = () => json(401, problem('auth.session_expired', 401));
    expect((await run(() => P.partnerApi(ME))).redirect).toBe('/auth/login?reason=session');
    reply[RESOLVE] = () => json(200, resolved('active'));
    reply[ME] = () => json(401, problem('auth.session_expired', 401));
    expect((await run(() => P.partnerApi(ME))).redirect).toBe('/auth/login?reason=session');
  });

  it('state-changing call: JSON body + Idempotency-Key/If-Match passed through; a cross-origin caller is rejected before the API is touched (REQ-SEC-091)', async () => {
    reply['/v1/partners/manifests'] = () => json(201, { id: 'm1' });
    await P.partnerApi('/v1/partners/manifests', { method: 'POST', body: { receiving_centre_id: 'c1' }, headers: { 'Idempotency-Key': 'k-1' } });
    const call = seen.find((s) => s.path === '/v1/partners/manifests');
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('idempotency-key')).toBe('k-1');
    expect(call?.body).toEqual({ receiving_centre_id: 'c1' });
    seen.length = 0;
    headerStore.set('origin', 'https://evil.test');
    const r = await run(() => P.partnerApi('/v1/partners/manifests', { method: 'POST', body: {} }));
    expect(r.result).toMatchObject({ ok: false, status: 403, problem: { code: 'auth.csrf_failed' } });
    expect(seen).toHaveLength(0);
  });

  it.each(['http://evil.test/v1/partners/me', '//evil.test/v1/partners/me', '/v1/identity/auth/logout', '/v1/partners/../identity/auth/logout', '/v1/partners/me\r\nX: y', 'v1/partners/me'])(
    'SSRF/path guard: refuses %j (only /v1/partners/** on the configured API) without any network call', async (path) => {
      await expect(P.partnerApi(path)).rejects.toThrow();
      expect(seen).toHaveLength(0);
    });

  it('X-Lims-Background: 1 on the incoming request -> resolve with touch:false', async () => {
    reply[ME] = () => json(200, {});
    headerStore.set('x-lims-background', '1');
    await P.partnerApi(ME);
    expect(resolveCalls()[0]?.body).toEqual({ touch: false });
  });
});

describe('csrf.ts checkCsrf (REQ-SEC-091: Origin = partner origin and Sec-Fetch-Site same-origin on every non-GET)', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  const REJECT = { ok: false, status: 403, code: 'auth.csrf_failed' };

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s with the partner Origin + same-origin -> ok', (method) => {
    expect(C.checkCsrf({ method, headers: h({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' }) })).toEqual({ ok: true });
  });

  it('matching Origin without Sec-Fetch-Site is ok (older browsers); lower-case method is treated as the same verb', () => {
    expect(C.checkCsrf({ method: 'post', headers: h({ origin: ORIGIN }) })).toEqual({ ok: true });
  });

  it.each([
    ['foreign origin', { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' }],
    ['foreign origin, forged same-origin hint', { origin: 'https://evil.test', 'sec-fetch-site': 'same-origin' }],
    ['staff origin', { origin: 'https://staff.t05.test', 'sec-fetch-site': 'cross-site' }],
    ['origin with extra path (not an exact origin)', { origin: `${ORIGIN}/x` }],
    ['origin with port', { origin: `${ORIGIN}:8443` }],
    ['http downgrade of the partner origin', { origin: ORIGIN.replace('https:', 'http:') }],
    ['userinfo trick', { origin: 'https://partner.t05.test@evil.test' }],
    ['null origin', { origin: 'null' }],
    ['missing origin', {}],
    ['right origin but cross-site fetch metadata', { origin: ORIGIN, 'sec-fetch-site': 'cross-site' }],
    ['right origin but same-site fetch metadata', { origin: ORIGIN, 'sec-fetch-site': 'same-site' }],
    ['right origin but none (user-initiated nav) on POST', { origin: ORIGIN, 'sec-fetch-site': 'none' }],
  ])('POST rejected: %s', (_n, headers) => {
    expect(C.checkCsrf({ method: 'POST', headers: h(headers) })).toEqual(REJECT);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('%s is not state-changing: no Origin needed', (method) => {
    expect(C.checkCsrf({ method, headers: h({}) })).toEqual({ ok: true });
  });

  it('fails closed when LIMS_ORIGIN_PARTNER is unset (never "any origin")', () => {
    const saved = process.env.LIMS_ORIGIN_PARTNER;
    delete process.env.LIMS_ORIGIN_PARTNER;
    try {
      let out: unknown;
      try { out = C.checkCsrf({ method: 'POST', headers: h({ origin: ORIGIN }) }); } catch { out = REJECT; }
      expect(out).toEqual(REJECT);
    } finally {
      process.env.LIMS_ORIGIN_PARTNER = saved;
    }
  });
});

void NEW_TOKEN;
