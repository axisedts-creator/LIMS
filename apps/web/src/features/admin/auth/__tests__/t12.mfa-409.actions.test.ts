// AUTH-MFA-PERSIST-1 (LD-248) BFF side of the 409 recovery.
// ASSUMED contract: features/admin/auth/actions.ts ('use server') exports refreshSessionStateAction() (no argument): POST /v1/identity/auth/session/resolve with {touch:false} and the
// session cookie (sessionCall rules: no cookie -> redirect /auth/login; 401 auth.session_expired -> cookie cleared + redirect /auth/session-expired). It returns ONLY { ok:true, state } or
// { ok:false, code } to the browser: the access token, expiry and actor of the resolve reply never leave the server (E1 / REQ-SEC).
// Expected now: fail (refreshSessionStateAction does not exist).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BFF_KEY, SID, api, apiCalls, form, headersMock, jar, json, navigationMock, problem, reply, resetApi, run, seen, sessionState, setEnv } from './t12.harness';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => (await import('./t12.harness')).headersMock);
vi.mock('next/navigation', async () => (await import('./t12.harness')).navigationMock);

type A = typeof import('../actions');
let A: A;
beforeAll(async () => { setEnv(); api.listen({ onUnhandledFrame: 'error' }); A = (await import('../actions')) as A; });
beforeEach(() => resetApi());
afterEach(() => api.resetHandlers());
afterAll(() => api.close());
void headersMock; void navigationMock;

const ACCESS = 'ACCESS-TOKEN-SENTINEL-do-not-leak';
const resolved = (state: string) => () => json(200, { access_token: ACCESS, access_expires_at: new Date(Date.now() + 3600_000).toISOString(), session: sessionState(state) });

describe('startMfaEnrolmentAction: the 409 reaches the page as a code', () => {
  it('409 common.version_conflict -> { ok:false, code:"common.version_conflict" } (no redirect, no cookie change)', async () => {
    reply['/mfa/enrolment'] = () => json(409, problem('common.version_conflict', 409));
    const r = await run(() => A.startMfaEnrolmentAction(form({ friendly_name: 'Authenticator' })));
    expect(r.result).toMatchObject({ ok: false, code: 'common.version_conflict' }); expect(r.redirect).toBeUndefined(); expect(jar.cleared).toHaveLength(0);
  });
});

describe('refreshSessionStateAction (AUTH-MFA-PERSIST-1)', () => {
  it.each(['mfa_pending', 'active', 'mfa_enrolment_required'])('state %s: POSTs session/resolve {touch:false} with the BFF key and the cookie; returns { ok:true, state } and nothing else', async (state) => {
    reply['/session/resolve'] = resolved(state);
    const r = await run(() => (A as any).refreshSessionStateAction());
    const [c] = apiCalls('/session/resolve'); expect(c?.method).toBe('POST'); expect(c?.body).toEqual({ touch: false });
    expect(c?.headers.get('x-lims-bff-key')).toBe(BFF_KEY); expect(c?.headers.get('cookie')).toContain(`__Host-lims_sid=${SID}`);
    expect(r.result).toEqual({ ok: true, state }); expect(JSON.stringify(r.result)).not.toContain(ACCESS); expect(jar.set).toHaveLength(0);
  });
  it('401 auth.session_expired -> cookie cleared and redirect to /auth/session-expired (same as every cookie-bound action)', async () => {
    reply['/session/resolve'] = () => json(401, problem('auth.session_expired', 401));
    const r = await run(() => (A as any).refreshSessionStateAction()); expect(r.redirect).toBe('/auth/session-expired'); expect(jar.cleared).toContain('__Host-lims_sid');
  });
  it('no session cookie -> redirect /auth/login and no API call', async () => {
    jar.current = undefined; const r = await run(() => (A as any).refreshSessionStateAction()); expect(r.redirect).toBe('/auth/login'); expect(seen).toHaveLength(0);
  });
  it('API 503 -> { ok:false, code } (never a thrown error, never the token)', async () => {
    reply['/session/resolve'] = () => json(503, problem('common.dependency_unavailable', 503));
    const r = await run(() => (A as any).refreshSessionStateAction()); expect(r.result).toMatchObject({ ok: false, code: 'common.dependency_unavailable' }); expect(JSON.stringify(r.result)).not.toContain(ACCESS);
  });
});
