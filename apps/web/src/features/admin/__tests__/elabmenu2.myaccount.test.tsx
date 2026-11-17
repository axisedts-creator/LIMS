// @vitest-environment jsdom
// T0D-ELABMENU-2 (LD-340; founder 2026-11-17 20:50 NPT: "no profile section from where we can sign out"). /admin/me on staging: getMe,
// listOwnMfaFactors, listOwnSessions answered 401 (API side: the self handlers never got the caller's session id; see
// core/pipeline/__tests__/self-session-ctx.test.ts). Web side rules proved here, against the contract wire (MSW):
//  1. the three calls go out like the working listRoles call: Bearer from the server session, GET, no query that names another user.
//  2. an administrator gets Profile, MFA factors and own sessions on the screen.
//  3. a refused or failed read is NEVER shown as empty data: a 401 on factors must not look like "no two-step factor / Set up";
//     a 401 on sessions must not look like "no sessions"; getMe failing keeps "Could not load your account".
//  4. auth.step_up_required shows a step up prompt (link to /auth/mfa), not a failed page.
//  5. no permission identity.self.manage -> no API call at all (unchanged).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ID, ME_M, SESSION_1, SESSION_2, TOKEN, NOW, api, calls, callsTo, resetApi, routes, json, problem, page, sessionSummary, show, pageText, norm,
} from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
beforeEach(() => {
  resetApi();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
  routes[`GET ${ID}/me`] = json({ membership_id: ME_M, display_name: 'Synthetic Admin', email: 'synthetic.admin@example.test', roles: [{ role_id: 'r1', code: 'lab_admin', name: 'Lab admin' }], permissions: ['identity.self.manage'], centre_scope: { all: true, centre_ids: [] }, mfa: { enrolled: true, level: 'aal2' }, last_login_at: '2026-11-10T09:00:00.000Z' });
  routes[`GET ${ID}/me/sessions`] = json(page([sessionSummary({ session_id: SESSION_1, membership_id: ME_M, user_agent_family: 'Firefox' }), sessionSummary({ session_id: SESSION_2, membership_id: ME_M, user_agent_family: 'Chrome' })]));
  routes[`GET ${ID}/me/mfa-factors`] = json({ data: [{ factor_id: 'f1', friendly_name: 'Authenticator', status: 'verified', verified_at: '2026-11-01T00:00:00.000Z' }] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const tab = async (name: string) => { await userEvent.setup({ advanceTimers: () => undefined }).click(screen.getByRole('tab', { name })); };

describe('the three calls go out like the working listRoles call', () => {
  it('one visit: GET /me, /me/sessions, /me/mfa-factors (and /roles) each carry the server session Bearer; nothing names another user or session', async () => {
    await show('me');
    for (const p of ['/me', '/me/sessions', '/me/mfa-factors', '/roles']) {
      const c = callsTo('GET', `${ID}${p}`);
      expect(c, p).toHaveLength(1);
      expect(c[0]!.headers.get('authorization'), p).toBe(`Bearer ${TOKEN}`);
    }
    for (const c of calls) for (const k of ['user_id', 'membership_id', 'session_id', 'sub']) expect(c.url.searchParams.has(k), `${c.url.pathname} ?${k}`).toBe(false);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
  it('the own-sessions call asks for a bounded page (limit <= 50)', async () => {
    await show('me');
    const lim = Number(callsTo('GET', `${ID}/me/sessions`)[0]!.url.searchParams.get('limit'));
    expect(lim).toBeGreaterThan(0); expect(lim).toBeLessThanOrEqual(50);
  });
});

describe('an administrator sees the profile, the two-step factors and the own sessions', () => {
  it('Profile: name, email, role, centre access', async () => {
    await show('me');
    for (const t of ['My account', 'Synthetic Admin', 'synthetic.admin@example.test', 'Lab admin', 'All centres']) expect(pageText()).toContain(t);
  });
  it('Security: the verified factor is listed and Status On (no "Set up")', async () => {
    await show('me');
    await tab('Security');
    expect(pageText()).toContain('Authenticator');
    expect(pageText()).toMatch(/Status:\s*On/);
    expect(screen.queryByRole('link', { name: /set up/i })).toBeNull();
  });
  it('Sessions: both own sessions are listed', async () => {
    await show('me');
    await tab('Sessions');
    expect(pageText()).toContain('Firefox'); expect(pageText()).toContain('Chrome');
  });
});

describe('a refused or failed read is never shown as empty data (the 401 must not hide as "no factors" / "no sessions")', () => {
  it('listOwnMfaFactors 401: the page says it could not load the factors; no "Set up" two-step link, no "Status: On" with an empty list', async () => {
    routes[`GET ${ID}/me/mfa-factors`] = () => problem('auth.unauthenticated', 401);
    await show('me');
    await tab('Security');
    expect(pageText()).toMatch(/could not load/i);
    expect(screen.queryByRole('link', { name: /set up/i })).toBeNull();
  });
  it('listOwnSessions 401: the page says it could not load the sessions; the list is not presented as empty', async () => {
    routes[`GET ${ID}/me/sessions`] = () => problem('auth.unauthenticated', 401);
    await show('me');
    await tab('Sessions');
    expect(pageText()).toMatch(/could not load/i);
    expect(pageText()).not.toMatch(/no (active )?sessions/i);
  });
  it('getMe 401: "Could not load your account" (unchanged), no profile data, no other call is rendered as success', async () => {
    routes[`GET ${ID}/me`] = () => problem('auth.unauthenticated', 401);
    await show('me');
    expect(pageText()).toMatch(/could not load your account/i);
    expect(screen.queryAllByRole('tab')).toEqual([]);
  });
  it('a 503 on the factors read is also a load failure, not an empty list', async () => {
    routes[`GET ${ID}/me/mfa-factors`] = () => problem('common.dependency_unavailable', 503);
    await show('me');
    await tab('Security');
    expect(pageText()).toMatch(/could not load/i);
    expect(screen.queryByRole('link', { name: /set up/i })).toBeNull();
  });
  it('the request id of the failure is shown for support when the API sent one', async () => {
    routes[`GET ${ID}/me/sessions`] = () => problem('auth.unauthenticated', 401, { request_id: 'req-elab2-0001' });
    await show('me');
    await tab('Sessions');
    expect(pageText()).toContain('req-elab2-0001');
  });
});

describe('step up: the web shows the prompt instead of a failed page', () => {
  it.each(['sessions', 'mfa-factors'])('/me/%s answers 401 auth.step_up_required -> a link to /auth/mfa (verify again), the rest of the page still works', async (p) => {
    routes[`GET ${ID}/me/${p}`] = () => problem('auth.step_up_required', 401);
    await show('me');
    expect(pageText()).toContain('Synthetic Admin');
    await tab(p === 'sessions' ? 'Sessions' : 'Security');
    const link = screen.getByRole('link', { name: /verify|two-step|step/i });
    expect(link.getAttribute('href') ?? '').toMatch(/^\/auth\/mfa(\?|$)/);
    expect(norm(pageText())).not.toMatch(/could not load your account/i);
  });
});

describe('permission gate unchanged', () => {
  it('without identity.self.manage: Denied, no API call at all', async () => {
    resetApi(['identity.user.read']);
    await show('me').catch(() => undefined);
    expect(calls).toEqual([]);
  });
});
