// C2.T12 — BFF server actions behind AU-1..AU-7 (node env, MSW stands in for /v1/identity/auth/*).
// ACs: AC-A1.1 (cookie attrs, no JWT in browser), AC-A2.1/2.2/2.3, AC-A3.1/3.2, AC-A7.1/7.2/7.3, AC-A8.1/8.2; 03-APP-FLOW §3.1, §3.6, §3.7.
// ASSUMED contract (the implementer may not deviate without a CR/ruling):
//   features/admin/auth/actions.ts ('use server') exports, each taking FormData unless noted:
//     loginStaffAction({email,password,next?}), verifyMfaAction({code}), startMfaEnrolmentAction({friendly_name?}),
//     completeMfaEnrolmentAction({factor_id,code}), requestRecoveryAction({email}), setPasswordAction({new_password,confirm_password}),
//     confirmTokenAction({token_hash,type}) (plain object arg), logoutAction().
//   Success that moves the user = next/navigation redirect() (throws). Failure/no-move = returned { ok:false, code, retryAfterSeconds? } where
//   code is the API problem code (or common.validation_failed for client-side rejections made BEFORE any API call).
//   Plain success = { ok:true } (+ for startMfaEnrolment: factor_id, secret_base32, qr_svg_base64 (data-URI source), otpauth_uri).
//   BFF calls the API with X-Lims-Bff-Key (file LIMS_WEB_BFF_KEY_FILE), forwards the client IP as X-Forwarded-For (§3.1), and forwards the
//   opaque cookie as `cookie: __Host-lims_sid=<v>` on bffSession operations. The session token goes ONLY into the cookie (never a redirect URL).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH, BFF_KEY, CLIENT_IP, FACTOR, NEW_TOKEN, SID, api, apiCalls, form, headersMock, jar, json, navigationMock, problem, reply, resetApi, run, seen, sessionState, setEnv,
} from './t12.harness';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => (await import('./t12.harness')).headersMock);
vi.mock('next/navigation', async () => (await import('./t12.harness')).navigationMock);

type A = typeof import('../actions');
let A: A;
beforeAll(async () => {
  setEnv();
  api.listen({ onUnhandledRequest: 'error' });
  A = (await import('../actions')) as A;
});
beforeEach(() => resetApi());
afterEach(() => api.resetHandlers());
afterAll(() => api.close());
void headersMock; void navigationMock;

const ok = (state: string, absoluteMs?: number) => () => json(200, { session_token: NEW_TOKEN, session: sessionState(state, absoluteMs) });
const LOGIN = form({ email: 'user@example.test', password: 'Correct-horse-battery-1' });

describe('loginStaffAction (AU-1, AC-A1.1)', () => {
  it('calls POST /auth/login with the BFF key, client IP and credentials only', async () => {
    reply['/login'] = ok('active');
    await run(() => A.loginStaffAction(LOGIN));
    const [c] = apiCalls('/login');
    expect(c?.method).toBe('POST');
    expect(c?.headers.get('x-lims-bff-key')).toBe(BFF_KEY);
    expect(c?.headers.get('x-forwarded-for')).toBe(CLIENT_IP);
    expect(c?.body).toEqual({ email: 'user@example.test', password: 'Correct-horse-battery-1' });
  });

  it('sets __Host-lims_sid = session_token with HttpOnly, Secure, SameSite=Lax, Path=/, no Domain, Max-Age ≈ absolute timeout; redirects home without the token in the URL', async () => {
    reply['/login'] = ok('active', 8 * 3600_000);
    const r = await run(() => A.loginStaffAction(LOGIN));
    expect(r.redirect).toBe('/');
    expect(jar.set).toHaveLength(1);
    const [c] = jar.set;
    expect(c?.name).toBe('__Host-lims_sid');
    expect(c?.value).toBe(NEW_TOKEN);
    expect(c?.opts).toMatchObject({ httpOnly: true, secure: true, path: '/' });
    expect(String(c?.opts.sameSite).toLowerCase()).toBe('lax');
    expect(c?.opts.domain).toBeUndefined();
    expect(Math.abs(Number(c?.opts.maxAge) - 8 * 3600)).toBeLessThan(10);
    expect(r.redirect).not.toContain(NEW_TOKEN);
  });

  it('routes by session state: mfa_pending -> /auth/mfa, mfa_enrolment_required -> /auth/mfa/enrol (AC-A2.1, AC-A3.1); cookie still set', async () => {
    reply['/login'] = ok('mfa_pending');
    expect((await run(() => A.loginStaffAction(LOGIN))).redirect).toBe('/auth/mfa');
    expect(jar.set[0]?.value).toBe(NEW_TOKEN);
    jar.set.length = 0;
    reply['/login'] = ok('mfa_enrolment_required');
    expect((await run(() => A.loginStaffAction(LOGIN))).redirect).toBe('/auth/mfa/enrol');
    expect(jar.set[0]?.value).toBe(NEW_TOKEN);
  });

  it.each([
    ['auth.login_failed', 401], ['auth.step_up_required', 401], ['common.rate_limited', 429], ['auth.account_locked', 403],
    ['identity.membership_inactive', 403], ['identity.tenant_suspended', 403], ['identity.platform_ip_denied', 403], ['common.dependency_unavailable', 503],
  ])('returns { ok:false, code: %s } and sets no cookie, no redirect', async (code, status) => {
    reply['/login'] = () => json(status, problem(code, status), status === 429 ? { 'retry-after': '120' } : {});
    const r = await run(() => A.loginStaffAction(LOGIN));
    expect(r.redirect).toBeUndefined();
    expect(r.result).toMatchObject({ ok: false, code });
    expect(jar.set).toHaveLength(0);
  });

  it('passes Retry-After through as retryAfterSeconds on common.rate_limited', async () => {
    reply['/login'] = () => json(429, problem('common.rate_limited', 429), { 'retry-after': '120' });
    expect((await run(() => A.loginStaffAction(LOGIN))).result).toMatchObject({ code: 'common.rate_limited', retryAfterSeconds: 120 });
  });

  it('maps an unreachable API to common.dependency_unavailable', async () => {
    reply['/login'] = () => HttpResponse_networkError();
    expect((await run(() => A.loginStaffAction(LOGIN))).result).toMatchObject({ ok: false, code: 'common.dependency_unavailable' });
  });

  it('rejects empty / over-long input before calling the API (email ≤254, password 1–128)', async () => {
    for (const bad of [{ email: '', password: 'x' }, { email: 'a@example.test', password: '' }, { email: 'a@example.test', password: 'p'.repeat(129) }, { email: `${'a'.repeat(250)}@example.test`, password: 'x' }]) {
      expect((await run(() => A.loginStaffAction(form(bad)))).result).toMatchObject({ ok: false, code: 'common.validation_failed' });
    }
    expect(seen).toHaveLength(0);
  });

  it('never logs the password (console spies)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    reply['/login'] = () => json(401, problem('auth.login_failed', 401));
    await run(() => A.loginStaffAction(LOGIN));
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain('Correct-horse-battery-1');
  });

  describe('post-login `next` (03-APP-FLOW §3.6: validated against routes.yaml, no open redirect)', () => {
    beforeEach(() => { reply['/login'] = ok('active'); });
    it('honours a known staff route', async () => {
      expect((await run(() => A.loginStaffAction(form({ email: 'user@example.test', password: 'pw', next: '/analytics/reports' })))).redirect).toBe('/analytics/reports');
    });
    it.each(['https://evil.test/', '//evil.test', '/\\evil.test', 'javascript:alert(1)', '/not-a-route', '/auth/../../evil', '/analytics/reports\r\nSet-Cookie: x=1'])(
      'falls back to / for %j', async (next) => {
        expect((await run(() => A.loginStaffAction(form({ email: 'user@example.test', password: 'pw', next })))).redirect).toBe('/');
      });
  });
});

describe('verifyMfaAction (AU-2, AC-A2.2, AC-A2.3)', () => {
  it('POSTs {code} to /auth/mfa/verify forwarding the opaque cookie + BFF key; success -> redirect /', async () => {
    reply['/mfa/verify'] = () => json(200, sessionState('active'));
    const r = await run(() => A.verifyMfaAction(form({ code: '123456' })));
    const [c] = apiCalls('/mfa/verify');
    expect(c?.body).toEqual({ code: '123456' });
    expect(c?.headers.get('cookie')).toContain(`__Host-lims_sid=${SID}`);
    expect(c?.headers.get('x-lims-bff-key')).toBe(BFF_KEY);
    expect(r.redirect).toBe('/');
  });

  it('401 auth.mfa_invalid -> { ok:false, code } and the cookie is kept (more attempts allowed)', async () => {
    reply['/mfa/verify'] = () => json(401, problem('auth.mfa_invalid', 401));
    const r = await run(() => A.verifyMfaAction(form({ code: '000000' })));
    expect(r.result).toMatchObject({ ok: false, code: 'auth.mfa_invalid' });
    expect(jar.cleared).toHaveLength(0);
  });

  it('session revoked after the 5th failure (401 auth.session_expired) -> cookie cleared and redirect to AU-1 / AU-7', async () => {
    reply['/mfa/verify'] = () => json(401, problem('auth.session_expired', 401));
    const r = await run(() => A.verifyMfaAction(form({ code: '000000' })));
    expect(r.redirect).toMatch(/^\/auth\/(login|session-expired)(\?|$)/);
    expect(jar.cleared).toContain('__Host-lims_sid');
  });

  it.each(['12345', '1234567', 'abcdef', '12 456', '', '１２３４５６'])('rejects code %j before any API call (^[0-9]{6}$)', async (code) => {
    expect((await run(() => A.verifyMfaAction(form({ code })))).result).toMatchObject({ ok: false, code: 'common.validation_failed' });
    expect(seen).toHaveLength(0);
  });

  it('without a session cookie makes no API call and sends the user to /auth/login', async () => {
    jar.current = undefined;
    expect((await run(() => A.verifyMfaAction(form({ code: '123456' })))).redirect).toMatch(/^\/auth\/(login|session-expired)/);
    expect(seen).toHaveLength(0);
  });
});

describe('MFA enrolment (AU-3, AC-A3.1/3.2)', () => {
  it('startMfaEnrolmentAction POSTs friendly_name, forwards the cookie and returns QR + secret for DataUriImage / SecretRevealOnce', async () => {
    reply['/mfa/enrolment'] = () => json(200, { factor_id: FACTOR, otpauth_uri: 'otpauth://totp/LIMS:u?secret=ABCDEFGH', qr_svg_base64: 'PHN2Zy8+', secret_base32: 'ABCDEFGH' });
    const r = await run(() => A.startMfaEnrolmentAction(form({ friendly_name: 'Pixel 9' })));
    const [c] = apiCalls('/mfa/enrolment');
    expect(c?.body).toEqual({ friendly_name: 'Pixel 9' });
    expect(c?.headers.get('cookie')).toContain(`__Host-lims_sid=${SID}`);
    expect(r.result).toMatchObject({ ok: true, factor_id: FACTOR, secret_base32: 'ABCDEFGH', qr_svg_base64: 'PHN2Zy8+' });
  });

  it('qr_svg_base64 is optional (02-TRD §5.1): a 200 reply without it is still ok:true', async () => {
    reply['/mfa/enrolment'] = () => json(200, { factor_id: FACTOR, otpauth_uri: 'otpauth://totp/LIMS:u?secret=ABCDEFGH', secret_base32: 'ABCDEFGH' });
    const r = await run(() => A.startMfaEnrolmentAction(form({})));
    expect(r.result).toMatchObject({ ok: true, factor_id: FACTOR, secret_base32: 'ABCDEFGH' });
  });

  it('rejects a friendly_name over 40 characters before calling the API', async () => {
    expect((await run(() => A.startMfaEnrolmentAction(form({ friendly_name: 'x'.repeat(41) })))).result).toMatchObject({ ok: false, code: 'common.validation_failed' });
    expect(seen).toHaveLength(0);
  });

  it('completeMfaEnrolmentAction POSTs {code} to /auth/mfa/enrolment/{factor_id}/verify and returns { ok:true }', async () => {
    reply[`/mfa/enrolment/${FACTOR}/verify`] = () => json(200, sessionState('active'));
    const r = await run(() => A.completeMfaEnrolmentAction(form({ factor_id: FACTOR, code: '654321' })));
    expect(apiCalls(`/mfa/enrolment/${FACTOR}/verify`)[0]?.body).toEqual({ code: '654321' });
    expect(r.result).toMatchObject({ ok: true });
  });

  it('401 auth.mfa_invalid on completion is returned as { ok:false, code }', async () => {
    reply[`/mfa/enrolment/${FACTOR}/verify`] = () => json(401, problem('auth.mfa_invalid', 401));
    expect((await run(() => A.completeMfaEnrolmentAction(form({ factor_id: FACTOR, code: '654321' })))).result).toMatchObject({ ok: false, code: 'auth.mfa_invalid' });
  });

  it.each(['../logout', '..%2Flogout', `${FACTOR}/../../logout`, 'not-a-uuid', '', `${FACTOR}?x=1`])('SECURITY: factor_id %j is rejected before any API call (no path injection)', async (factor_id) => {
    expect((await run(() => A.completeMfaEnrolmentAction(form({ factor_id, code: '654321' })))).result).toMatchObject({ ok: false, code: 'common.validation_failed' });
    expect(seen).toHaveLength(0);
  });
});

describe('requestRecoveryAction (AU-4, AC-A7.1)', () => {
  it('POSTs {email} to /auth/password/recover (no cookie needed) and returns the SAME { ok:true } for any API 202 body', async () => {
    reply['/password/recover'] = () => json(202, {});
    const a = await run(() => A.requestRecoveryAction(form({ email: 'exists@example.test' })));
    const b = await run(() => A.requestRecoveryAction(form({ email: 'nobody@example.test' })));
    expect(apiCalls('/password/recover').map((c) => c.body)).toEqual([{ email: 'exists@example.test' }, { email: 'nobody@example.test' }]);
    expect(a.result).toEqual({ ok: true });
    expect(b.result).toEqual(a.result);
    expect(jar.set).toHaveLength(0);
  });

  it('does not reveal account existence even when the API throttles: still { ok:true } for 429 and 5xx (copy is always "If an account exists…")', async () => {
    for (const status of [429, 500, 503]) {
      reply['/password/recover'] = () => json(status, problem('common.rate_limited', status));
      expect((await run(() => A.requestRecoveryAction(form({ email: 'x@example.test' })))).result).toEqual({ ok: true });
    }
  });
});

describe('confirmTokenAction (/auth/confirm landing, AC-A7.2, AC-A8.1/8.2)', () => {
  it.each(['recovery', 'invite'] as const)('type=%s: POST /auth/token/confirm, sets the session cookie, redirects to /auth/set-password with a CLEAN url', async (type) => {
    reply['/token/confirm'] = ok('password_setup', 3600_000);
    const r = await run(() => A.confirmTokenAction({ token_hash: 'pkce_abc123', type }));
    expect(apiCalls('/token/confirm')[0]?.body).toEqual({ token_hash: 'pkce_abc123', type });
    expect(jar.set[0]).toMatchObject({ name: '__Host-lims_sid', value: NEW_TOKEN });
    expect(jar.set[0]?.opts).toMatchObject({ httpOnly: true, secure: true, path: '/' });
    expect(r.redirect).toBe('/auth/set-password');
  });

  it.each([['recovery', 'auth.reset_token_invalid'], ['invite', 'auth.invite_invalid']] as const)('400 %s -> { ok:false, code: %s }, no cookie', async (type, code) => {
    reply['/token/confirm'] = () => json(400, problem(code, 400));
    const r = await run(() => A.confirmTokenAction({ token_hash: 'used', type }));
    expect(r.result).toMatchObject({ ok: false, code });
    expect(jar.set).toHaveLength(0);
  });

  it('SECURITY: unknown type or empty / >256-char token_hash is rejected before any API call', async () => {
    for (const a of [{ token_hash: 'x', type: 'magiclink' }, { token_hash: '', type: 'recovery' }, { token_hash: 'h'.repeat(257), type: 'invite' }]) {
      expect((await run(() => A.confirmTokenAction(a as never))).result).toMatchObject({ ok: false });
    }
    expect(seen).toHaveLength(0);
  });
});

describe('setPasswordAction (AU-5, AC-A7.3, AC-A8.1)', () => {
  const NEW = 'a-long-new-passphrase-2026';
  it('POSTs {new_password} only (never confirm_password) with the cookie; active -> /', async () => {
    reply['/password/set'] = () => json(200, sessionState('active'));
    const r = await run(() => A.setPasswordAction(form({ new_password: NEW, confirm_password: NEW })));
    expect(apiCalls('/password/set')[0]?.body).toEqual({ new_password: NEW });
    expect(apiCalls('/password/set')[0]?.headers.get('cookie')).toContain(`__Host-lims_sid=${SID}`);
    expect(r.redirect).toBe('/');
  });

  it('roles require MFA -> continues to /auth/mfa/enrol (AC-A8.1)', async () => {
    reply['/password/set'] = () => json(200, sessionState('mfa_enrolment_required'));
    expect((await run(() => A.setPasswordAction(form({ new_password: NEW, confirm_password: NEW })))).redirect).toBe('/auth/mfa/enrol');
  });

  it.each([['auth.password_policy_violation', 422], ['auth.password_breached', 422]])('%s -> { ok:false, code }', async (code, status) => {
    reply['/password/set'] = () => json(status, problem(code, status));
    expect((await run(() => A.setPasswordAction(form({ new_password: NEW, confirm_password: NEW })))).result).toMatchObject({ ok: false, code });
  });

  it('mismatched confirmation is rejected before any API call', async () => {
    expect((await run(() => A.setPasswordAction(form({ new_password: NEW, confirm_password: `${NEW}x` })))).result).toMatchObject({ ok: false, code: 'common.validation_failed' });
    expect(seen).toHaveLength(0);
  });

  it('expired setup session (401 auth.session_expired) clears the cookie and redirects to /auth/session-expired', async () => {
    reply['/password/set'] = () => json(401, problem('auth.session_expired', 401));
    const r = await run(() => A.setPasswordAction(form({ new_password: NEW, confirm_password: NEW })));
    expect(r.redirect).toMatch(/^\/auth\/session-expired/);
    expect(jar.cleared).toContain('__Host-lims_sid');
  });

  it('never logs the new password', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    reply['/password/set'] = () => json(422, problem('auth.password_breached', 422));
    await run(() => A.setPasswordAction(form({ new_password: NEW, confirm_password: NEW })));
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(NEW);
  });
});

describe('logoutAction (AU-6, 03-APP-FLOW §3.6)', () => {
  it('POST /auth/logout with the cookie, clears __Host-lims_sid, redirects to /auth/login?logged_out=1', async () => {
    reply['/logout'] = () => new Response(null, { status: 204 });
    const r = await run(() => A.logoutAction());
    expect(apiCalls('/logout')[0]?.headers.get('cookie')).toContain(`__Host-lims_sid=${SID}`);
    expect(jar.cleared).toContain('__Host-lims_sid');
    expect(r.redirect).toBe('/auth/login?logged_out=1');
  });

  it('still clears the cookie and redirects when the API fails (never leaves a live cookie behind)', async () => {
    reply['/logout'] = () => json(500, problem('common.internal', 500));
    const r = await run(() => A.logoutAction());
    expect(jar.cleared).toContain('__Host-lims_sid');
    expect(r.redirect).toBe('/auth/login?logged_out=1');
  });
});

// every API call the auth actions make must target /v1/identity/auth/* only (never GoTrue, never a caller-chosen host)
describe('transport', () => {
  it('only ever calls LIMS_ORIGIN_API under /v1/identity/auth/ (msw onUnhandledRequest=error would fail otherwise)', async () => {
    reply['/login'] = ok('active');
    await run(() => A.loginStaffAction(LOGIN));
    for (const s of seen) expect(s.path.startsWith(AUTH + '/')).toBe(true);
  });
});

function HttpResponse_networkError(): Response {
  return Response.error();
}
