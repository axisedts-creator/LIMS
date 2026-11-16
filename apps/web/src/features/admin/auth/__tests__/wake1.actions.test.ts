// T0D-WAKE-1 (LD-277, audit RS-07): the sign-in, MFA and password server actions tell "no answer" (timeout / connection failure) from "answered".
// CONTRACT chosen by the tester (writer: follow it, or dispute in .orchestra/notes):
//   no answer -> returned { ok:false, code:'common.dependency_unavailable', waking:true }: no redirect, no cookie set or cleared, no session-expired.
//   an HTTP answer (401/4xx/5xx) -> exactly today's result, with NO `waking`. Timeout per call <= 8000 ms. requestRecoveryAction still reveals nothing.
import { HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, form, jar, json, problem, reply, resetApi, run, sessionState, setEnv } from './t12.harness';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => (await import('./t12.harness')).headersMock);
vi.mock('next/navigation', async () => (await import('./t12.harness')).navigationMock);

let A: typeof import('../actions');
beforeAll(async () => {
  setEnv();
  api.listen({ onUnhandledRequest: 'error' });
  A = await import('../actions');
});
beforeEach(() => resetApi());
afterEach(() => {
  api.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => api.close());

const LOGIN = () => form({ email: 'user@example.test', password: 'Correct-horse-battery-1' });
const MFA = () => form({ code: '123456' });
const PW = () => form({ new_password: 'Correct-horse-battery-1', confirm_password: 'Correct-horse-battery-1' });
const flag = (r: unknown) => (r as { waking?: boolean }).waking;
const ACTIONS: [string, string, () => Promise<unknown>][] = [
  ['loginStaffAction', '/login', () => A.loginStaffAction(LOGIN())],
  ['verifyMfaAction', '/mfa/verify', () => A.verifyMfaAction(MFA())],
  ['setPasswordAction', '/password/set', () => A.setPasswordAction(PW())],
];
const NO_ANSWER: [string, () => void][] = [
  ['a timeout', () => void vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))],
  ['a connection failure', () => void vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))],
];

describe.each(ACTIONS)('%s', (_name, path, call) => {
  it.each(NO_ANSWER)('%s -> { ok:false, dependency_unavailable, waking:true }; no redirect, no cookie change', async (_n, fail) => {
    fail();
    const r = await run(call);
    expect(r.redirect).toBeUndefined();
    expect(r.result).toMatchObject({ ok: false, code: 'common.dependency_unavailable', waking: true });
    expect(jar.set).toEqual([]);
    expect(jar.cleared).toEqual([]);
  });

  it('a 503 answer is NOT waking (current behaviour: dependency_unavailable, no flag)', async () => {
    reply[path] = () => json(503, problem('common.dependency_unavailable', 503));
    const r = await run(call);
    expect(r.result).toMatchObject({ ok: false, code: 'common.dependency_unavailable' });
    expect(flag(r.result)).toBeUndefined();
  });

  it('a 500 answer without a problem body is NOT waking', async () => {
    reply[path] = () => new HttpResponse('boom', { status: 500 });
    const r = await run(call);
    expect(r.result).toMatchObject({ ok: false });
    expect(flag(r.result)).toBeUndefined();
  });

  it('the call timeout is set and stays at or below 8000 ms', async () => {
    reply[path] = () => json(200, { session_token: 'tok-abcdefghijklmnopqrstuvwxyz0123456789', session: sessionState('active') });
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await run(call);
    expect(spy).toHaveBeenCalled();
    for (const [ms] of spy.mock.calls) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(8000);
    }
  });
});

describe('an HTTP 401 still means signed out', () => {
  it('verifyMfaAction: 401 auth.session_expired -> cookie cleared, redirect to the sign-in screen (not waking)', async () => {
    reply['/mfa/verify'] = () => json(401, problem('auth.session_expired', 401));
    const r = await run(() => A.verifyMfaAction(MFA()));
    expect(r.redirect).toBe('/auth/login?mfa_failed=1');
    expect(jar.cleared).toContain('__Host-lims_sid');
  });
  it('setPasswordAction: 401 auth.session_expired -> redirect to /auth/session-expired', async () => {
    reply['/password/set'] = () => json(401, problem('auth.session_expired', 401));
    expect((await run(() => A.setPasswordAction(PW()))).redirect).toBe('/auth/session-expired');
  });
  it('loginStaffAction: 401 auth.login_failed keeps its code, no waking', async () => {
    reply['/login'] = () => json(401, problem('auth.login_failed', 401));
    const r = await run(() => A.loginStaffAction(LOGIN()));
    expect(r.result).toMatchObject({ ok: false, code: 'auth.login_failed' });
    expect(flag(r.result)).toBeUndefined();
  });
});

it('requestRecoveryAction on no answer still reveals nothing: { ok:true } (AC-A7.1)', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
  expect((await run(() => A.requestRecoveryAction(form({ email: 'user@example.test' })))).result).toEqual({ ok: true });
});
