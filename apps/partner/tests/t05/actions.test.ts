// C13.T05 — partner BFF server actions behind PA-1..PA-6 (node env, fetch fake stands in for C2 /v1/identity/auth/*).
// ACs: US-03.1 (cookie __Host-lims_psid, no JWT in browser), US-03.2/03.3 (generic auth.login_failed, kind bound by partner BFF key),
//      US-03.4 (429 common.rate_limited relayed, client IP forwarded), US-03.5 (session ended -> /auth/login?reason=session),
//      US-02.7 (new partner admin must enrol TOTP: mfa_enrolment_required -> /auth/mfa/enrol), REQ-SEC-091 (Origin/Sec-Fetch-Site on POST).
// ASSUMED contract (names not fixed by the spec; the implementer may not deviate without a CR/ruling — mirrors C2.T12 for the staff BFF):
//   src/app/(auth)/auth/actions.ts ('use server') exports, each taking FormData unless noted:
//     loginPartnerAction({email,password,next?}), verifyMfaAction({code}), startMfaEnrolmentAction({friendly_name?}),
//     completeMfaEnrolmentAction({factor_id,code}), setPasswordAction({new_password,confirm_password}), logoutAction().
//   Success that moves the user = next/navigation redirect() (throws). Failure/no-move = returned { ok:false, code, retryAfterSeconds? }
//   where code is the API problem code (or common.validation_failed for rejections made BEFORE any API call, auth.csrf_failed for CSRF).
//   Plain success = { ok:true } (+ for startMfaEnrolment: factor_id, secret_base32, qr_svg_base64, otpauth_uri).
//   The BFF calls C2 with X-Lims-Bff-Key (file LIMS_PARTNER_BFF_KEY_FILE) on LIMS_PARTNER_BFF_API_URL, forwards the client IP as
//   X-Forwarded-For, forwards the opaque cookie as `cookie: __Host-lims_sid=<v>` (bffSession wire name) on bffSession operations, and checks Origin against
//   LIMS_ORIGIN_PARTNER. The session token goes ONLY into the cookie (never a redirect URL, never a return value).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH, BFF_COOKIE, BFF_KEY, CLIENT_IP, COOKIE, FACTOR, JWT, NEW_TOKEN, ORIGIN, SID, apiCalls, form, headerStore, installFetch, jar, json, networkError,
  problem, reply, resetApi, restoreFetch, run, seen, sessionState, setEnv,
} from './harness';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => (await import('./harness')).headersMock);
vi.mock('next/navigation', async () => (await import('./harness')).navigationMock);

type A = typeof import('../../src/app/(auth)/auth/actions');
let A: A;
beforeAll(async () => {
  setEnv();
  installFetch();
  A = (await import('../../src/app/(auth)/auth/actions')) as A;
});
beforeEach(() => resetApi());
afterEach(() => vi.restoreAllMocks());
afterAll(() => restoreFetch());

const LOGIN_PATH = '/partner/login';
const ok = (state: string, absoluteMs?: number) => () => json(200, { session_token: NEW_TOKEN, session: sessionState(state, absoluteMs) });
const LOGIN = form({ email: 'admin@partner-x.invalid', password: 'Correct-horse-battery-1' });
const noJwtOrToken = (v: unknown) => {
  const s = JSON.stringify(v ?? null);
  expect(s).not.toContain(NEW_TOKEN);
  expect(s).not.toContain(JWT);
  expect(s).not.toContain('eyJ');
};

describe('loginPartnerAction (PA-1, US-03.1)', () => {
  it('calls C2 loginPartner (/auth/partner/login, never the staff /auth/login) with the partner BFF key, client IP and credentials only', async () => {
    reply[`${AUTH}${LOGIN_PATH}`] = ok('active');
    await run(() => A.loginPartnerAction(LOGIN));
    const [c] = apiCalls(LOGIN_PATH);
    expect(c?.method).toBe('POST');
    expect(c?.headers.get('x-lims-bff-key')).toBe(BFF_KEY);
    expect(c?.headers.get('x-forwarded-for')?.split(',')[0]?.trim()).toBe(CLIENT_IP);
    expect(c?.body).toEqual({ email: 'admin@partner-x.invalid', password: 'Correct-horse-battery-1' });
    expect(apiCalls('/login')).toHaveLength(0); // US-03.2/03.3: kind is bound by the key on the partner path, not by a staff endpoint
    expect(c?.headers.get('x-lims-origin')).toBeNull(); // 08 R10: never a client-chosen kind header
  });

  it('sets __Host-lims_psid = session_token: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, Max-Age ≈ absolute timeout; redirect / without the token', async () => {
    reply[`${AUTH}${LOGIN_PATH}`] = ok('active', 8 * 3600_000);
    const r = await run(() => A.loginPartnerAction(LOGIN));
    expect(r.redirect).toBe('/');
    expect(jar.set).toHaveLength(1);
    const [c] = jar.set;
    expect(c?.name).toBe(COOKIE);
    expect(c?.value).toBe(NEW_TOKEN);
    expect(c?.opts).toMatchObject({ httpOnly: true, secure: true, path: '/' });
    expect(String(c?.opts.sameSite).toLowerCase()).toBe('lax');
    expect(c?.opts.domain).toBeUndefined();
    expect(Math.abs(Number(c?.opts.maxAge) - 8 * 3600)).toBeLessThan(10);
    expect(r.redirect).not.toContain(NEW_TOKEN);
    expect(jar.set.some((x) => x.name === '__Host-lims_sid')).toBe(false); // never the staff cookie name
  });

  it('routes by session state: mfa_pending -> /auth/mfa, mfa_enrolment_required -> /auth/mfa/enrol (US-02.7), password_setup -> /auth/set-password; cookie set each time', async () => {
    for (const [state, to] of [['mfa_pending', '/auth/mfa'], ['mfa_enrolment_required', '/auth/mfa/enrol'], ['password_setup', '/auth/set-password']] as const) {
      jar.set.length = 0;
      reply[`${AUTH}${LOGIN_PATH}`] = ok(state);
      expect((await run(() => A.loginPartnerAction(LOGIN))).redirect).toBe(to);
      expect(jar.set[0]?.value).toBe(NEW_TOKEN);
    }
  });

  it('never returns the session token or a JWT to the browser (success has no result; failures carry only a code)', async () => {
    reply[`${AUTH}${LOGIN_PATH}`] = ok('active');
    const okRun = await run(() => A.loginPartnerAction(LOGIN));
    noJwtOrToken(okRun);
    reply[`${AUTH}${LOGIN_PATH}`] = () => json(401, problem('auth.login_failed', 401, { detail: 'internal hint', session_token: NEW_TOKEN }));
    const bad = await run(() => A.loginPartnerAction(LOGIN));
    noJwtOrToken(bad);
    expect(Object.keys(bad.result as object).sort()).toEqual(['code', 'ok']); // generic: nothing that hints the account exists elsewhere (US-03.2)
  });

  it.each([
    ['auth.login_failed', 401], ['auth.step_up_required', 401], ['common.rate_limited', 429], ['auth.account_locked', 403],
    ['identity.tenant_suspended', 403], ['partners.partner_inactive', 403], ['common.dependency_unavailable', 503],
  ])('returns { ok:false, code: %s } and sets no cookie, no redirect', async (code, status) => {
    reply[`${AUTH}${LOGIN_PATH}`] = () => json(status, problem(code, status), status === 429 ? { 'retry-after': '120' } : {});
    const r = await run(() => A.loginPartnerAction(LOGIN));
    expect(r.redirect).toBeUndefined();
    expect(r.result).toMatchObject({ ok: false, code });
    expect(jar.set).toHaveLength(0);
  });

  it('US-03.4: relays 429 common.rate_limited with Retry-After as retryAfterSeconds', async () => {
    reply[`${AUTH}${LOGIN_PATH}`] = () => json(429, problem('common.rate_limited', 429), { 'retry-after': '120' });
    expect((await run(() => A.loginPartnerAction(LOGIN))).result).toMatchObject({ ok: false, code: 'common.rate_limited', retryAfterSeconds: 120 });
  });

  it('maps an unreachable API to common.dependency_unavailable', async () => {
    reply[`${AUTH}${LOGIN_PATH}`] = () => networkError();
    expect((await run(() => A.loginPartnerAction(LOGIN))).result).toMatchObject({ ok: false, code: 'common.dependency_unavailable' });
  });

  it('rejects empty / over-long input before calling the API (email ≤254, password 1–128)', async () => {
    for (const bad of [{ email: '', password: 'x' }, { email: 'a@example.test', password: '' }, { email: 'a@example.test', password: 'p'.repeat(129) }, { email: `${'a'.repeat(250)}@example.test`, password: 'x' }]) {
      expect((await run(() => A.loginPartnerAction(form(bad)))).result).toMatchObject({ ok: false, code: 'common.validation_failed' });
    }
    expect(seen).toHaveLength(0);
  });

  it('never logs the password (console spies)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    reply[`${AUTH}${LOGIN_PATH}`] = () => json(401, problem('auth.login_failed', 401));
    await run(() => A.loginPartnerAction(LOGIN));
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain('Correct-horse-battery-1');
  });

  describe('post-login `next` (no open redirect)', () => {
    beforeEach(() => { reply[`${AUTH}${LOGIN_PATH}`] = ok('active'); });
    it('honours a known partner route', async () => {
      expect((await run(() => A.loginPartnerAction(form({ email: 'a@example.test', password: 'pw', next: '/manifests' })))).redirect).toBe('/manifests');
    });
    it.each(['https://evil.test/', '//evil.test', '/\\evil.test', 'javascript:alert(1)', '/auth/../../evil', '/manifests\r\nSet-Cookie: x=1'])(
      'falls back to / for %j', async (next) => {
        expect((await run(() => A.loginPartnerAction(form({ email: 'a@example.test', password: 'pw', next })))).redirect).toBe('/');
      });
  });
});

describe('CSRF on every action (REQ-SEC-091, AB: cross-origin POST)', () => {
  const calls: Array<[string, () => Promise<unknown>]> = [
    ['loginPartnerAction', () => A.loginPartnerAction(LOGIN)],
    ['verifyMfaAction', () => A.verifyMfaAction(form({ code: '123456' }))],
    ['startMfaEnrolmentAction', () => A.startMfaEnrolmentAction(form({}))],
    ['completeMfaEnrolmentAction', () => A.completeMfaEnrolmentAction(form({ factor_id: FACTOR, code: '123456' }))],
    ['setPasswordAction', () => A.setPasswordAction(form({ new_password: 'Correct-horse-battery-1', confirm_password: 'Correct-horse-battery-1' }))],
    ['logoutAction', () => A.logoutAction()],
  ];
  const bad: Array<[string, (h: Headers) => void]> = [
    ['foreign Origin', (h) => h.set('origin', 'https://evil.test')],
    ['Origin of the staff app', (h) => h.set('origin', 'https://staff.t05.test')],
    ['Origin with the partner host as prefix of another host', (h) => h.set('origin', `${ORIGIN}.evil.test`)],
    ['missing Origin', (h) => h.delete('origin')],
    ['Origin "null"', (h) => h.set('origin', 'null')],
    ['Sec-Fetch-Site cross-site', (h) => h.set('sec-fetch-site', 'cross-site')],
    ['Sec-Fetch-Site same-site (sibling subdomain)', (h) => h.set('sec-fetch-site', 'same-site')],
  ];
  for (const [name, call] of calls) {
    it.each(bad)(`${name}: %s -> { ok:false, code: auth.csrf_failed }, no API call, no cookie change`, async (_n, mutate) => {
      mutate(headerStore);
      const r = await run(call);
      expect(r.result).toMatchObject({ ok: false, code: 'auth.csrf_failed' });
      expect(seen).toHaveLength(0);
      expect(jar.set).toHaveLength(0);
      expect(jar.cleared).toHaveLength(0);
    });
  }
  it('a matching Origin without Sec-Fetch-Site (older browsers) is accepted', async () => {
    headerStore.delete('sec-fetch-site');
    reply[`${AUTH}${LOGIN_PATH}`] = ok('active');
    expect((await run(() => A.loginPartnerAction(LOGIN))).redirect).toBe('/');
  });
});

describe('verifyMfaAction (PA-2, US-02.7 / US-03.1 for admins)', () => {
  it('POSTs {code} to /auth/mfa/verify forwarding the opaque partner cookie + partner BFF key; success -> redirect /', async () => {
    reply[`${AUTH}/mfa/verify`] = () => json(200, sessionState('active'));
    const r = await run(() => A.verifyMfaAction(form({ code: '123456' })));
    const [c] = apiCalls('/mfa/verify');
    expect(c?.body).toEqual({ code: '123456' });
    expect(c?.headers.get('cookie')).toContain(`${BFF_COOKIE}=${SID}`);
    expect(c?.headers.get('cookie')).not.toContain(COOKIE);
    expect(c?.headers.get('x-lims-bff-key')).toBe(BFF_KEY);
    expect(r.redirect).toBe('/');
  });

  it('401 auth.mfa_invalid -> { ok:false, code } and the cookie is kept (more attempts allowed)', async () => {
    reply[`${AUTH}/mfa/verify`] = () => json(401, problem('auth.mfa_invalid', 401));
    const r = await run(() => A.verifyMfaAction(form({ code: '000000' })));
    expect(r.result).toMatchObject({ ok: false, code: 'auth.mfa_invalid' });
    expect(jar.cleared).toHaveLength(0);
  });

  it('US-03.5 shape: 401 auth.session_expired (e.g. revoked after the 5th failure) -> cookie cleared, redirect /auth/login?reason=session', async () => {
    reply[`${AUTH}/mfa/verify`] = () => json(401, problem('auth.session_expired', 401));
    const r = await run(() => A.verifyMfaAction(form({ code: '000000' })));
    expect(r.redirect).toBe('/auth/login?reason=session');
    expect(jar.cleared).toContain(COOKIE);
  });

  it('409 common.version_conflict (session not in mfa_pending) -> redirect / (guard re-routes by state)', async () => {
    reply[`${AUTH}/mfa/verify`] = () => json(409, problem('common.version_conflict', 409));
    expect((await run(() => A.verifyMfaAction(form({ code: '123456' })))).redirect).toBe('/');
  });

  it.each(['', '12345', '1234567', 'abcdef', '12 456', '１２３４５６'])('rejects code %j before any API call (^[0-9]{6}$)', async (code) => {
    expect((await run(() => A.verifyMfaAction(form({ code })))).result).toMatchObject({ ok: false, code: 'common.validation_failed' });
    expect(seen).toHaveLength(0);
  });

  it('without a session cookie: redirect /auth/login, no API call', async () => {
    jar.current = undefined;
    expect((await run(() => A.verifyMfaAction(form({ code: '123456' })))).redirect).toBe('/auth/login');
    expect(seen).toHaveLength(0);
  });
});

describe('MFA enrolment (PA-3, US-02.7: invited partner admin must enrol before any data page)', () => {
  it('startMfaEnrolmentAction -> POST /auth/mfa/enrolment with cookie + key; returns factor_id, secret, qr (data) and otpauth uri', async () => {
    reply[`${AUTH}/mfa/enrolment`] = () => json(200, { factor_id: FACTOR, otpauth_uri: 'otpauth://totp/Lab:admin@partner-x.invalid?secret=ABCDEFGH', qr_svg_base64: 'PHN2Zy8+', secret_base32: 'ABCDEFGH' });
    const r = await run(() => A.startMfaEnrolmentAction(form({ friendly_name: 'Phone' })));
    const [c] = apiCalls('/mfa/enrolment');
    expect(c?.body).toEqual({ friendly_name: 'Phone' });
    expect(c?.headers.get('cookie')).toContain(`${BFF_COOKIE}=${SID}`);
    expect(c?.headers.get('cookie')).not.toContain(COOKIE);
    expect(c?.headers.get('x-lims-bff-key')).toBe(BFF_KEY);
    expect(r.result).toMatchObject({ ok: true, factor_id: FACTOR, secret_base32: 'ABCDEFGH', qr_svg_base64: 'PHN2Zy8+' });
  });

  it('completeMfaEnrolmentAction -> POST /auth/mfa/enrolment/{factor_id}/verify; success -> redirect /', async () => {
    reply[`${AUTH}/mfa/enrolment/${FACTOR}/verify`] = () => json(200, sessionState('active'));
    const r = await run(() => A.completeMfaEnrolmentAction(form({ factor_id: FACTOR, code: '123456' })));
    expect(apiCalls(`/mfa/enrolment/${FACTOR}/verify`)[0]?.body).toEqual({ code: '123456' });
    expect(r.redirect).toBe('/');
  });

  it('wrong code -> { ok:false, code: auth.mfa_invalid }, cookie kept', async () => {
    reply[`${AUTH}/mfa/enrolment/${FACTOR}/verify`] = () => json(401, problem('auth.mfa_invalid', 401));
    expect((await run(() => A.completeMfaEnrolmentAction(form({ factor_id: FACTOR, code: '000000' })))).result).toMatchObject({ ok: false, code: 'auth.mfa_invalid' });
    expect(jar.cleared).toHaveLength(0);
  });

  it.each(['../logout', `${FACTOR}/../../logout`, 'not-a-uuid', '', `${FACTOR}%2f..`])('rejects factor_id %j (path injection) before any API call', async (factor_id) => {
    expect((await run(() => A.completeMfaEnrolmentAction(form({ factor_id, code: '123456' })))).result).toMatchObject({ ok: false, code: 'common.validation_failed' });
    expect(seen).toHaveLength(0);
  });

  it('401 auth.session_expired -> cookie cleared, redirect /auth/login?reason=session', async () => {
    reply[`${AUTH}/mfa/enrolment`] = () => json(401, problem('auth.session_expired', 401));
    const r = await run(() => A.startMfaEnrolmentAction(form({})));
    expect(r.redirect).toBe('/auth/login?reason=session');
    expect(jar.cleared).toContain(COOKIE);
  });
});

describe('setPasswordAction (PA-6; invitation accept -> US-02.7)', () => {
  const PW = 'Correct-horse-battery-1';
  it('POSTs {new_password} to /auth/password/set; session state mfa_enrolment_required -> /auth/mfa/enrol (a new partner admin enrols TOTP first), active -> /', async () => {
    reply[`${AUTH}/password/set`] = () => json(200, sessionState('mfa_enrolment_required'));
    const r = await run(() => A.setPasswordAction(form({ new_password: PW, confirm_password: PW })));
    const [c] = apiCalls('/password/set');
    expect(c?.body).toEqual({ new_password: PW });
    expect(c?.headers.get('cookie')).toContain(`${BFF_COOKIE}=${SID}`);
    expect(c?.headers.get('cookie')).not.toContain(COOKIE);
    expect(r.redirect).toBe('/auth/mfa/enrol');
    reply[`${AUTH}/password/set`] = () => json(200, sessionState('active'));
    expect((await run(() => A.setPasswordAction(form({ new_password: PW, confirm_password: PW })))).redirect).toBe('/');
    reply[`${AUTH}/password/set`] = () => json(200, sessionState('mfa_pending'));
    expect((await run(() => A.setPasswordAction(form({ new_password: PW, confirm_password: PW })))).redirect).toBe('/auth/mfa');
  });

  it('mismatching confirmation or over-long password is rejected before any API call', async () => {
    expect((await run(() => A.setPasswordAction(form({ new_password: PW, confirm_password: `${PW}x` })))).result).toMatchObject({ ok: false, code: 'common.validation_failed' });
    expect((await run(() => A.setPasswordAction(form({ new_password: 'p'.repeat(129), confirm_password: 'p'.repeat(129) })))).result).toMatchObject({ ok: false, code: 'common.validation_failed' });
    expect(seen).toHaveLength(0);
  });

  it.each([['auth.password_policy_violation', 422], ['auth.password_breached', 422]])('maps %s to { ok:false, code } without moving', async (code, status) => {
    reply[`${AUTH}/password/set`] = () => json(status, problem(code, status));
    const r = await run(() => A.setPasswordAction(form({ new_password: PW, confirm_password: PW })));
    expect(r.result).toMatchObject({ ok: false, code });
    expect(r.redirect).toBeUndefined();
  });
});

describe('logoutAction (US-03.5 / PX-1 Sign out)', () => {
  it('POSTs /auth/logout with cookie + key, clears __Host-lims_psid, redirects /auth/login', async () => {
    reply[`${AUTH}/logout`] = () => json(204, null);
    const r = await run(() => A.logoutAction());
    const [c] = apiCalls('/logout');
    expect(c?.headers.get('cookie')).toContain(`${BFF_COOKIE}=${SID}`);
    expect(c?.headers.get('cookie')).not.toContain(COOKIE);
    expect(c?.headers.get('x-lims-bff-key')).toBe(BFF_KEY);
    expect(jar.cleared).toContain(COOKIE);
    expect(r.redirect).toBe('/auth/login');
  });

  it.each([['API 500', () => json(500, problem('common.internal', 500))], ['API unreachable', () => networkError()], ['401 session_expired', () => json(401, problem('auth.session_expired', 401))]])(
    'still clears the cookie and redirects when %s', async (_n, h) => {
      reply[`${AUTH}/logout`] = h as never;
      const r = await run(() => A.logoutAction());
      expect(jar.cleared).toContain(COOKIE);
      expect(r.redirect).toBe('/auth/login');
    });
});
