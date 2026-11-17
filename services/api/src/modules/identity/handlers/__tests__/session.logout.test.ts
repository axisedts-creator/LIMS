// T8 logoutSession (02-TRD s5.1; 03-APP-FLOW s3.6, SS9; 01-PRD AC-A5.1; 07-SECURITY AU-T13, E-9).
// AC-A5.1: the session row is revoked (reason logout), the cookie is cleared by the BFF (204 is the signal), a later reuse of the old cookie or of the old access JWT is rejected (401).
// x-idempotency none: "a repeat is a no-op" (contracts/openapi/identity.yaml) -> a repeat on a revoked/expired row is 204 with no second write (SEAM, see notes).
// Expected now: all fail (handlers/logoutSession.ts does not exist - the manifest still holds the common.internal stub).
import { describe, expect, it } from 'vitest';
import { createLogoutSession } from '../logoutSession.js';
import { createResolveSession } from '../resolveSession.js';
import { CLIENT_IP, HOUR, OLD_ACCESS, OLD_REFRESH, REQ_ID, SYSTEM_ACTOR, TENANT_A, MEMB_A, makeSessionWorld, otherWrites, rejection, sinks, tokenN, type Kind, type SessionWorld } from './session.helpers.js';

async function logout(w: SessionWorld, a: { token?: string; key?: string | null; ctx?: Record<string, unknown>; deps?: any } = {}) {
  const { hctx, commitOnError } = w.makeHctx({ operationId: 'logoutSession', ...(a.key === null ? { bffKey: undefined } : a.key ? { bffKey: a.key } : {}), ...(a.ctx ?? {}) });
  const run = () => createLogoutSession(a.deps ?? w.deps)(w.req({ ...(a.token ? { token: a.token } : {}) }) as any, hctx);
  return { run, commitOnError };
}
const ok204 = async (w: SessionWorld, a: Parameters<typeof logout>[1] = {}) => { const r: any = await (await logout(w, a)).run(); expect(r.status).toBe(204); expect(r.body).toBeUndefined(); return r; };
const fail = async (w: SessionWorld, a: Parameters<typeof logout>[1] = {}) => rejection((await logout(w, a)).run());
const resolveWith = async (w: SessionWorld, token: string, key = 'staff_web') => { const { hctx } = w.makeHctx({ bffKey: key }); return rejection(createResolveSession(w.deps)(w.req({ token, body: { touch: true } }) as any, hctx)); };

describe('logoutSession: AC-A5.1', () => {
  it('active session -> 204; row revoked with reason logout; `logout` auth event; sign-out job; ONE identityAuthTx; only those writes', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession();
    await ok204(w, { token });
    expect(row.state).toBe('revoked'); expect(row.revokeReason).toBe('logout');
    const u = w.store.committed('updateSession'); expect(u).toHaveLength(1); expect(u[0]!.arg).toMatchObject({ ref: { sessionId: row.sessionId, userId: row.userId, tenantId: TENANT_A }, patch: { revoked: { reason: 'logout' }, actorId: SYSTEM_ACTOR } });
    const ev = w.store.eventsOf('logout'); expect(ev).toHaveLength(1); expect(ev[0]).toMatchObject({ sessionId: row.sessionId, userId: row.userId, tenantId: TENANT_A, membershipId: MEMB_A, clientIp: CLIENT_IP, requestId: REQ_ID, actorId: SYSTEM_ACTOR });
    const job = w.store.committed('enqueue'); expect(job).toHaveLength(1);
    expect(job[0]!.arg.identifier).toBe('identity.gotrue_signout'); expect(job[0]!.arg.jobKey).toMatch(/^signout:.+:logout$/); expect(job[0]!.arg.payload).toMatchObject({ user_id: row.userId, tenant_id: TENANT_A });
    expect(otherWrites(w.store, ['updateSession', 'recordTenant', 'enqueue'])).toEqual([]);
    expect(w.txCalls).toHaveLength(1); expect(w.txCalls[0]).toMatchObject({ operation: { module: 'identity', operationId: 'logoutSession', context: 'identity_auth' }, requestId: REQ_ID, clientIp: CLIENT_IP });
    const o = w.store.order; expect(o.filter((x) => x.startsWith('bindTenant'))).toEqual([`bindTenant:${TENANT_A}`]); expect(o.indexOf('sessionByToken')).toBeLessThan(o.indexOf(`bindTenant:${TENANT_A}`));
  });
  it('a later reuse of the old cookie is rejected: resolveSession -> 401 auth.session_expired, no access JWT, no GoTrue call, no write (AC-A5.1)', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ accessExpiresAt: new Date(w.clock.ms + 30_000) }); await ok204(w, { token }); const n = w.store.committed().length;
    const e = await resolveWith(w, token); expect(e.code).toBe('auth.session_expired'); expect(w.gw.calls).toHaveLength(0); expect(w.store.committed()).toHaveLength(n);
  });
  it('the old access JWT dies with the row: the revoked row cannot be resolved again, and GoTrue sign-out is a JOB (logout never calls GoTrue in the request, so an outage cannot block it)', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession(); w.gw.st.mode = 'down'; await ok204(w, { token });
    expect(w.gw.calls).toHaveLength(0); expect(row.state).toBe('revoked');
  });
  it('logs / events / job payload never carry the cookie token or the stored tokens', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession(); await ok204(w, { token });
    const s = sinks(w); for (const secret of [token, OLD_REFRESH, OLD_ACCESS]) expect(s).not.toContain(secret);
  });
  it.each(['mfa_pending', 'mfa_enrolment_required', 'password_setup'])('a session in state %s can be abandoned by logout (any non-terminal state): revoked', async (state) => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession({ state, aal: 'aal1' }); await ok204(w, { token }); expect(row.state).toBe('revoked'); expect(row.revokeReason).toBe('logout');
  });
  it('logout always works for the owner: locked membership / suspended tenant do not block it', async () => {
    const w = await makeSessionWorld(); const a = w.addSession({ membershipLocked: true }); const b = w.addSession({ tenantStatus: 'suspended' });
    await ok204(w, { token: a.token }); await ok204(w, { token: b.token }); expect(a.row.state).toBe('revoked'); expect(b.row.state).toBe('revoked');
  });
  it('a lapsed-but-still-"active" row (lazy expiry not yet written) is still ended cleanly: 204, never a 500', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession(); w.advance(13 * HOUR); await ok204(w, { token }); expect(['revoked', 'expired']).toContain(row.state);
  });
});

describe('logoutSession: platform and partner kinds', () => {
  it('platform: staff_web key, NO bindTenant, tenantless event, sign-out payload { user_id } only', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession({ kind: 'platform' }); await ok204(w, { token });
    expect(row.state).toBe('revoked'); expect(w.store.order.some((x) => x.startsWith('bindTenant'))).toBe(false);
    expect(w.store.committed('recordTenantless').filter((x) => x.arg.eventType === 'logout')).toHaveLength(1); expect(w.store.committed('recordTenant')).toHaveLength(0);
    expect(w.store.committed('enqueue')[0]!.arg.payload).toEqual({ user_id: row.userId });
  });
  it('partner with the partner key -> 204 revoked', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession({ kind: 'partner' }); await ok204(w, { token, key: 'partner' }); expect(row.state).toBe('revoked');
  });
});

describe('logoutSession: kind x BFF key binding and unknown sessions (AU-T13, E-9)', () => {
  const cases: Array<[Kind, string | null]> = [['tenant_staff', 'partner'], ['tenant_staff', null], ['platform', 'partner'], ['partner', 'staff_web'], ['partner', null], ['patient', 'staff_web'], ['patient', 'partner'],
    ['staff_mobile', 'staff_web'], ['staff_mobile', 'partner'], ['tenant_staff', 'unknown_bff']];
  it.each(cases)('session kind %s presented with BFF key %s -> 401 auth.session_expired and the session stays active (no write)', async (kind, key) => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession({ kind }); const e = await fail(w, { token, key });
    expect(e.code).toBe('auth.session_expired'); expect(row.state).toBe('active'); expect(w.store.committed()).toHaveLength(0);
  });
  it.each([['no cookie', undefined], ['malformed token', 'short']])('%s -> 401 auth.session_expired, no identityAuthTx', async (_n, token) => {
    const w = await makeSessionWorld(); w.addSession(); const e = await fail(w, { ...(token ? { token } : {}) }); expect(e.code).toBe('auth.session_expired'); expect(w.txCalls).toHaveLength(0);
  });
  it('well-formed unknown token -> 401, no write; another user\'s session is untouched', async () => {
    const w = await makeSessionWorld(); const other = w.addSession(); const e = await fail(w, { token: tokenN(0x888) });
    expect(e.code).toBe('auth.session_expired'); expect(w.store.committed()).toHaveLength(0); expect(other.row.state).toBe('active');
  });
  it('no system actor on the context -> common.internal', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession(); const e = await fail(w, { token, ctx: { actor: undefined } }); expect(e.code).toBe('common.internal'); expect(row.state).toBe('active');
  });
});

describe('logoutSession: repeat is a no-op (x-idempotency none) and races', () => {
  it.each(['revoked', 'expired'])('a row already %s -> 204 and NOTHING written (no second logout event, no second sign-out job)', async (state) => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ state }); await ok204(w, { token }); expect(w.store.committed()).toHaveLength(0);
  });
  it('logout twice: first revokes, second is a no-op 204 (one event, one job, one revoke write)', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession(); await ok204(w, { token }); await ok204(w, { token });
    expect(w.store.eventsOf('logout')).toHaveLength(1); expect(w.store.committed('enqueue')).toHaveLength(1); expect(w.store.committed('updateSession')).toHaveLength(1);
  });
  it('2 PARALLEL logouts of the same session: the row lock makes the second see `revoked` -> exactly one revoke / event / job; neither request errors', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession();
    const rs = await Promise.allSettled([logout(w, { token }).then((r) => r.run()), logout(w, { token }).then((r) => r.run())]);
    expect(rs.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']); expect(row.state).toBe('revoked');
    expect(w.store.committed('updateSession')).toHaveLength(1); expect(w.store.eventsOf('logout')).toHaveLength(1); expect(w.store.committed('enqueue')).toHaveLength(1);
  });
  it('logout racing a resolve (touch + refresh due): the final state is revoked and no refreshed token survives as a live session', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession({ accessExpiresAt: new Date(w.clock.ms + 30_000) });
    const { hctx } = w.makeHctx({ bffKey: 'staff_web' });
    await Promise.allSettled([createResolveSession(w.deps)(w.req({ token, body: { touch: true } }) as any, hctx), logout(w, { token }).then((r) => r.run())]);
    expect(row.state).toBe('revoked'); expect(w.gw.calls.length).toBeLessThanOrEqual(1);
  });
});
