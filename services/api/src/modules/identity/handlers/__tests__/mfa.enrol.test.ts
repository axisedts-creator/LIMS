// T7 startMfaEnrolment + completeMfaEnrolment: AC-A3.1-3, SS3/SS7, D-215 (platform_mfa_enrolled), AU-T21, AU-T22 / P-42 (completeMfaEnrolment), AU-T20-style isolation.
// Behaviour via createStartMfaEnrolment / createCompleteMfaEnrolment (seams: mfa.helpers.ts header) against the GoTrue fake with real TOTP generated from the returned secret.
// Expected now: fail (both handlers are the common.internal stub and export no factory).
import { describe, expect, it } from 'vitest';
import { GoTrueError } from '../../gotrue/gateway.js';
import { LimsError, badCode, idN, MEMB_A, otherWrites, rejection, SECRET_RE, STAFF_ID, TENANT_A, totp, type MfaWorld, makeMfaWorld } from './mfa.helpers.js';
import { createCompleteMfaEnrolment } from '../completeMfaEnrolment.js';
import { createStartMfaEnrolment } from '../startMfaEnrolment.js';

const start = async (w: MfaWorld, token: string | undefined, body: unknown = {}, hc: Record<string, unknown> = {}) => {
  const { hctx, commitOnError } = w.makeHctx({ operationId: 'startMfaEnrolment', ...hc }); const h: any = createStartMfaEnrolment(w.deps as any);
  return { p: h(w.req({ ...(token ? { token } : {}), body }), hctx), commitOnError };
};
const complete = async (w: MfaWorld, token: string | undefined, factorId: string, code: unknown, hc: Record<string, unknown> = {}) => {
  const { hctx, commitOnError } = w.makeHctx({ operationId: 'completeMfaEnrolment', ...hc }); const h: any = createCompleteMfaEnrolment(w.deps as any);
  return { p: h(w.req({ ...(token ? { token } : {}), body: { code }, params: { factor_id: factorId } }), hctx), commitOnError };
};
const okStart = async (w: MfaWorld, token: string, body: unknown = {}) => (await start(w, token, body)).p;
const okComplete = async (w: MfaWorld, token: string, factorId: string, code: string) => { const r = await complete(w, token, factorId, code); return Object.assign(await r.p, { commitOnError: r.commitOnError }); };
const failComplete = async (w: MfaWorld, token: string | undefined, factorId: string, code: unknown, hc: Record<string, unknown> = {}) => { const r = await complete(w, token, factorId, code, hc); return Object.assign(await rejection(r.p), { __c: r.commitOnError }); };

describe('startMfaEnrolment (SS3 state -> secret shown once)', () => {
  it.each(['mfa_enrolment_required', 'active'])('session in %s -> 200 {factor_id, otpauth_uri, secret_base32}; GoTrue enrolled with the session access token; mirror row `unverified` inserted for the session user/tenant', async (state) => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state });
    const r = await okStart(w, a.token, { friendly_name: 'Work phone' });
    expect(r.status).toBe(200); expect(Object.keys(r.body).sort()).toEqual(expect.arrayContaining(['factor_id', 'otpauth_uri', 'secret_base32']));
    expect(r.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\//); expect(r.body.secret_base32).toMatch(SECRET_RE);
    const enr = w.calls.find((c) => c.method === 'mfaEnrollTotp')!; expect(enr.args[0]).toBe(a.row.accessToken); expect(enr.args[1]).toBe('Work phone');
    const ins = w.store.committed('insertFactor').map((x) => x.arg); expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ tenantId: TENANT_A, userId: a.userId, friendlyName: 'Work phone', id: r.body.factor_id }); expect(ins[0].gotrueFactorId).not.toBe(r.body.factor_id);
    expect(w.store.factors.find((f) => f.id === r.body.factor_id)!.status).toBe('unverified');
    expect(w.store.committed('recordTenant').concat(w.store.committed('recordTenantless'))).toHaveLength(0);   // no auth event type exists for "started"
  });
  it('the secret and the otpauth URI are returned once and appear in no write, no log line, no job; the success body carries no session token', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' }); const r = await okStart(w, a.token);
    const hay = JSON.stringify([w.store.writes.map((x) => x.arg), w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls, w.tx.query.mock.calls]);
    expect(hay).not.toContain(r.body.secret_base32); expect(hay).not.toContain(r.body.otpauth_uri); expect(hay).not.toContain(a.token); expect(JSON.stringify(r.body)).not.toMatch(/access_token|refresh_token|session_token/);
  });
  it('removes any `unverified` factor first (GoTrue adminDeleteFactor BEFORE mfaEnrollTotp + mirror removal_reason re_enrol); a verified factor is untouched', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' });
    const first = await okStart(w, a.token); const stale = w.store.factors.find((f) => f.id === first.body.factor_id)!; const staleGotrue = stale.gotrueFactorId;
    const second = await okStart(w, a.token);
    expect(second.body.factor_id).not.toBe(first.body.factor_id);
    const del = w.calls.findIndex((c) => c.method === 'adminDeleteFactor'); const enr = w.calls.map((c) => c.method).lastIndexOf('mfaEnrollTotp');
    expect(del).toBeGreaterThan(-1); expect(del).toBeLessThan(enr); expect(w.calls[del]!.args).toEqual([a.userId, staleGotrue]);
    expect(w.store.committed('removeFactor').map((x) => x.arg)).toEqual([expect.objectContaining({ id: first.body.factor_id, reason: 're_enrol', userId: a.userId, tenantId: TENANT_A })]);
    expect(w.store.factors.filter((f) => !f.removedReason && f.status === 'unverified')).toHaveLength(1);
  });
  it('re-enrol after a lost GoTrue delete: adminDeleteFactor -> GoTrue 404 (factor already gone) is treated as removed; enrolment succeeds and the stale mirror row is marked `removed`', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' });
    const first = await okStart(w, a.token); const stale = w.store.factors.find((f) => f.id === first.body.factor_id)!;
    (w.deps.gotrue as any).adminDeleteFactor = async () => { throw new GoTrueError('adminDeleteFactor', 404, 'mfa_factor_not_found'); };
    const second = await okStart(w, a.token);
    expect(second.status).toBe(200); expect(second.body.factor_id).not.toBe(first.body.factor_id); expect(stale.removedReason).toBe('re_enrol');
    expect(w.store.factors.filter((f) => !f.removedReason && f.status === 'unverified')).toHaveLength(1);
  });
  it('x-rate-limit-tier login: a rejecting consumeAttempt -> 429 common.rate_limited; GoTrue not called; nothing written', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' }); const g = w.calls.length;
    (w.deps.limits as any).consumeAttempt = async () => { throw Object.assign(new LimsError('common.rate_limited'), { retryAfterSeconds: 7 }); };
    const e = await rejection((await start(w, a.token)).p); expect(e.code).toBe('common.rate_limited'); expect(e.statusCode).toBe(429);
    expect(w.calls.length).toBe(g); expect(w.store.committed()).toEqual([]);
  });
  it('409 common.version_conflict when the user already has a verified factor (OpenAPI); GoTrue not called, nothing written', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'active', verifiedFactor: true });
    const e = await rejection((await start(w, a.token)).p); expect(e.code).toBe('common.version_conflict'); expect(e.statusCode).toBe(409);
    expect(w.calls.filter((c) => c.method === 'mfaEnrollTotp' || c.method === 'adminDeleteFactor')).toHaveLength(0); expect(w.store.committed()).toEqual([]);
  });
  it.each(['mfa_pending', 'password_setup'])('session in %s -> 409 common.version_conflict (handler checks state); nothing written', async (state) => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state });
    const e = await rejection((await start(w, a.token)).p); expect(e.code).toBe('common.version_conflict'); expect(w.store.committed()).toEqual([]); expect(w.calls.filter((c) => c.method === 'mfaEnrollTotp')).toHaveLength(0);
  });
  it('platform staff: tenant-less mirror row (tenantId null), no bindTenant (D-215 / 08 A28.1)', async () => {
    const w = await makeMfaWorld({ kind: 'platform' }); const a = await w.addSession({ state: 'mfa_enrolment_required' }); await okStart(w, a.token);
    expect(w.tx.bindTenant).not.toHaveBeenCalled(); expect(w.store.committed('insertFactor').map((x) => x.arg)).toEqual([expect.objectContaining({ tenantId: null, userId: a.userId })]);
  });
  it('AU-T21: tenant kinds bindTenant(session.tenant_id) once, after sessionByToken and before any factor read/write', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' }); await okStart(w, a.token);
    const o = w.store.order; const i = o.indexOf(`bindTenant:${TENANT_A}`); expect(o.indexOf('sessionByToken')).toBeLessThan(i); expect(w.tx.bindTenant).toHaveBeenCalledTimes(1);
    for (const m of ['loadSession', 'factors', 'insertFactor']) expect(o.indexOf(m), m).toBeGreaterThan(i);
  });
  it('GoTrue enrolment failure -> 503 common.dependency_unavailable and no mirror row', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' }); (w.deps.gotrue as any).mfaEnrollTotp = async () => { throw new Error('ECONNRESET'); };
    const e = await rejection((await start(w, a.token)).p); expect(e.code).toBe('common.dependency_unavailable'); expect(w.store.factors).toHaveLength(0); expect(w.store.committed('insertFactor')).toHaveLength(0);
  });
  it('cookie rules: unknown / malformed / revoked token -> 401 auth.session_expired; partner key on a staff session -> 401 auth.session_expired (AU-T13); nothing written', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' });
    expect((await rejection((await start(w, 'short')).p)).code).toBe('auth.session_expired');
    expect((await rejection((await start(w, a.token, {}, { bffKey: 'partner' })).p)).code).toBe('auth.session_expired');
    w.store.byId(a.row.sessionId)!.state = 'revoked'; expect((await rejection((await start(w, a.token)).p)).code).toBe('auth.session_expired');
    expect(w.store.committed()).toEqual([]); expect(w.calls.filter((c) => c.method === 'mfaEnrollTotp')).toHaveLength(0);
  });
  it.each([[{ friendly_name: '' }], [{ friendly_name: 'x'.repeat(41) }], [{ friendly_name: 5 }], [{ friendly_name: 'ok', tenant_id: TENANT_A }], [{ factor_type: 'phone' }], ['x'], [[]]])('body %j -> 400 common.validation_failed before any tx', async (body) => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' });
    const e = await rejection((await start(w, a.token, body)).p); expect(e.code).toBe('common.validation_failed'); expect(w.txCalls).toHaveLength(0); expect(w.calls.filter((c) => c.method === 'mfaEnrollTotp')).toHaveLength(0);
  });
});

describe('completeMfaEnrolment - AC-A3.2 / SS7 / AC-A3.3', () => {
  it('correct code from the authenticator: factor verified, session active at aal2, events mfa_enrolled + login_succeeded (tenant events), response SessionState', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' }); const s = await okStart(w, a.token); const oldAccess = a.row.accessToken;
    const r = await okComplete(w, a.token, s.body.factor_id, totp(s.body.secret_base32));
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ session_id: a.row.sessionId, kind: 'tenant_staff', state: 'active', aal: 'aal2' });
    expect(w.store.factors.find((f) => f.id === s.body.factor_id)!.status).toBe('verified');
    expect(w.store.committed('markFactorVerified').map((x) => x.arg)).toEqual([expect.objectContaining({ id: s.body.factor_id, tenantId: TENANT_A, userId: a.userId })]);
    const row = w.store.byId(a.row.sessionId)!; expect(row.state).toBe('active'); expect(row.aal).toBe('aal2'); expect(row.accessToken).not.toBe(oldAccess);
    expect(JSON.parse(Buffer.from(row.accessToken.split('.')[1]!, 'base64url').toString()).aal).toBe('aal2');
    expect(w.store.eventsOf('mfa_enrolled')).toHaveLength(1); expect(w.store.eventsOf('mfa_enrolled')[0]).toMatchObject({ tenantId: TENANT_A, membershipId: MEMB_A, userId: a.userId, sessionId: a.row.sessionId });
    expect(w.store.eventsOf('login_succeeded')).toHaveLength(1);
    expect(w.store.committed('recordPlatformEvent')).toHaveLength(0);               // tenant factor changes are audit_log rows (trigger), never platform_events
    expect(r.commitOnError).not.toHaveBeenCalled(); expect(JSON.stringify(r.body)).not.toMatch(/access_token|refresh_token|eyJ/);
  });
  it('AC-A3.3: a voluntary enrolment from an `active` aal1 session verifies, raises it to aal2, writes mfa_enrolled and NOT login_succeeded', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'active' }); const s = await okStart(w, a.token);
    const r = await okComplete(w, a.token, s.body.factor_id, totp(s.body.secret_base32));
    expect(r.body).toMatchObject({ state: 'active', aal: 'aal2' }); expect(w.store.eventsOf('mfa_enrolled')).toHaveLength(1); expect(w.store.eventsOf('login_succeeded')).toHaveLength(0);
  });
  it('D-215: a PLATFORM staff enrolment writes platform_events `platform_mfa_enrolled` (target platform_staff = the staff id, actor = the staff id, no secret/e-mail in detail); mirror row tenant-less; events tenant-less with platformStaffId; no bindTenant', async () => {
    const w = await makeMfaWorld({ kind: 'platform' }); const a = await w.addSession({ state: 'mfa_enrolment_required' }); const s = await okStart(w, a.token);
    const r = await okComplete(w, a.token, s.body.factor_id, totp(s.body.secret_base32));
    expect(r.body).toMatchObject({ kind: 'platform', state: 'active', aal: 'aal2' }); expect(w.tx.bindTenant).not.toHaveBeenCalled();
    const pe = w.store.committed('recordPlatformEvent').map((x) => x.arg); expect(pe).toHaveLength(1);
    expect(pe[0]).toMatchObject({ eventType: 'platform_mfa_enrolled', targetType: 'platform_staff', targetId: STAFF_ID, actorPlatformStaffId: STAFF_ID, requestId: expect.any(String), clientIp: '203.0.113.9' });
    expect(JSON.stringify(pe[0].detail ?? {})).not.toMatch(new RegExp(`${s.body.secret_base32}|${a.email}|otpauth`));
    expect(w.store.committed('markFactorVerified').map((x) => x.arg)).toEqual([expect.objectContaining({ tenantId: null, userId: a.userId })]);
    expect(w.store.committed('recordTenant')).toHaveLength(0); expect(w.store.eventsOf('mfa_enrolled')[0]).toMatchObject({ platformStaffId: STAFF_ID });
  });
  it('platform_mfa_enrolled is written only on SUCCESS (not after a wrong code)', async () => {
    const w = await makeMfaWorld({ kind: 'platform' }); const a = await w.addSession({ state: 'mfa_enrolment_required' }); const s = await okStart(w, a.token);
    await failComplete(w, a.token, s.body.factor_id, badCode(s.body.secret_base32)); expect(w.store.committed('recordPlatformEvent')).toHaveLength(0);
  });
});

describe('completeMfaEnrolment - failures: AC-A2.3-style counter, P-42, AU-T22', () => {
  it('each wrong code -> 401 auth.mfa_invalid; mfa_failed_attempts +1, mfa_challenge_failed event and account counter COMMITTED; commitOnError once; factor stays unverified; nothing else survives', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' }); const s = await okStart(w, a.token); const before = w.store.committed().length;
    for (let i = 1; i <= 4; i++) {
      const e = await failComplete(w, a.token, s.body.factor_id, badCode(s.body.secret_base32));
      expect(e.code).toBe('auth.mfa_invalid'); expect(e.statusCode).toBe(401); expect(e.__c).toHaveBeenCalledTimes(1);
      expect(w.store.byId(a.row.sessionId)!.mfaFailedAttempts).toBe(i); expect(w.store.byId(a.row.sessionId)!.state).toBe('mfa_enrolment_required');
      expect(w.store.eventsOf('mfa_challenge_failed')).toHaveLength(i); expect(w.lim.calls.filter((c) => c.m === 'recordAccountFailure')).toHaveLength(i);
    }
    expect(w.store.factors.find((f) => f.id === s.body.factor_id)!.status).toBe('unverified');
    expect(otherWrites(w.store, ['insertFactor', 'updateSession', 'recordTenant'])).toEqual([]);
    expect(w.store.committed('markFactorVerified')).toHaveLength(0); expect(w.store.eventsOf('mfa_enrolled')).toHaveLength(0); expect(w.store.committed().length).toBeGreaterThan(before);
  });
  it('the 5th failure revokes the enrolment session (mfa_failed) with session_revoked + sign-out job, all committed; still 401 auth.mfa_invalid; the 6th request -> 401 auth.session_expired', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' }); const s = await okStart(w, a.token);
    for (let i = 0; i < 4; i++) await failComplete(w, a.token, s.body.factor_id, badCode(s.body.secret_base32));
    const e = await failComplete(w, a.token, s.body.factor_id, badCode(s.body.secret_base32)); expect(e.code).toBe('auth.mfa_invalid');
    const row = w.store.byId(a.row.sessionId)!; expect(row.state).toBe('revoked'); expect(row.revokeReason).toBe('mfa_failed'); expect(row.mfaFailedAttempts).toBe(5);
    expect(w.store.eventsOf('mfa_challenge_failed')).toHaveLength(5); expect(w.store.eventsOf('session_revoked')[0]).toMatchObject({ reasonCode: 'mfa_failed' });
    expect(w.store.committed('enqueue').map((x) => x.arg)).toEqual([expect.objectContaining({ identifier: 'identity.gotrue_signout', payload: expect.objectContaining({ user_id: a.userId }) })]);
    const g = w.calls.length; expect((await failComplete(w, a.token, s.body.factor_id, totp(s.body.secret_base32))).code).toBe('auth.session_expired'); expect(w.calls.length).toBe(g);
  });
  it('platform staff: failures are tenant-less with platformStaffId; the 5th revokes through the platform session path', async () => {
    const w = await makeMfaWorld({ kind: 'platform' }); const a = await w.addSession({ state: 'mfa_enrolment_required' }); const s = await okStart(w, a.token);
    for (let i = 0; i < 5; i++) await failComplete(w, a.token, s.body.factor_id, badCode(s.body.secret_base32));
    expect(w.store.committed('recordTenant')).toHaveLength(0); expect(w.store.eventsOf('mfa_challenge_failed')).toHaveLength(5); expect(w.store.byId(a.row.sessionId)!.state).toBe('revoked');
    expect(w.store.committed('updateSession').at(-1)!.arg.ref).toMatchObject({ kind: 'platform', tenantId: null });
  });
  it('GoTrue outage during verify is not a wrong code: 503, counters and attempts unchanged, nothing committed', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' }); const s = await okStart(w, a.token); const n = w.store.committed().length;
    (w.deps.gotrue as any).mfaChallengeAndVerify = async () => { throw new Error('ECONNREFUSED'); };
    expect((await failComplete(w, a.token, s.body.factor_id, '123456')).code).toBe('common.dependency_unavailable');
    expect(w.store.committed().length).toBe(n); expect(w.store.byId(a.row.sessionId)!.mfaFailedAttempts).toBe(0);
  });
});

describe('completeMfaEnrolment - isolation, state, validation', () => {
  it('a factor_id of ANOTHER user / tenant / a random uuid -> 404 common.not_found (same for all three); GoTrue not called, no counter, nothing written', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' }); const b = await w.addSession({ state: 'mfa_enrolment_required', tenantId: idN(0xa2) });
    const sb = await okStart(w, b.token); const sa = await okStart(w, a.token); const n = w.store.committed().length; const g = w.calls.length;
    const codes: string[] = [];
    for (const id of [sb.body.factor_id, idN(0x7777), '00000000-0000-4000-8000-000000000000']) { const e = await failComplete(w, a.token, id, totp(sa.body.secret_base32)); codes.push(e.code); expect(e.statusCode).toBe(404); }
    expect(new Set(codes)).toEqual(new Set(['common.not_found'])); expect(w.calls.length).toBe(g); expect(w.store.committed().length).toBe(n);
    expect(w.store.factors.find((f) => f.id === sb.body.factor_id)!.status).toBe('unverified');
  });
  it('a non-uuid factor_id -> 400 common.validation_failed before any tx', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' });
    const e = await failComplete(w, a.token, 'not-a-uuid', '123456'); expect(e.code).toBe('common.validation_failed'); expect(w.txCalls).toHaveLength(0);
  });
  it.each(['mfa_pending', 'password_setup'])('session in %s -> 404 common.not_found (OpenAPI declares no 409; same answer as an unusable factor); nothing written, GoTrue not called', async (state) => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state, verifiedFactor: true }); const n = w.store.committed().length; const g = w.calls.length;
    const e = await failComplete(w, a.token, w.store.factors[0]!.id, '123456'); expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404); expect(w.store.committed().length).toBe(n); expect(w.calls.length).toBe(g);
  });
  it('x-rate-limit-tier login: a rejecting consumeAttempt -> 429 common.rate_limited; GoTrue not called; nothing written', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' }); const s = await okStart(w, a.token); const n = w.store.committed().length; const g = w.calls.length;
    (w.deps.limits as any).consumeAttempt = async () => { throw Object.assign(new LimsError('common.rate_limited'), { retryAfterSeconds: 7 }); };
    const e = await failComplete(w, a.token, s.body.factor_id, totp(s.body.secret_base32)); expect(e.code).toBe('common.rate_limited'); expect(e.statusCode).toBe(429);
    expect(w.calls.length).toBe(g); expect(w.store.committed().length).toBe(n);
  });
  it('cookie rules: unknown / malformed token, partner key -> 401 auth.session_expired; nothing written', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' }); const s = await okStart(w, a.token); const n = w.store.committed().length;
    expect((await failComplete(w, 'short', s.body.factor_id, '123456')).code).toBe('auth.session_expired');
    expect((await failComplete(w, a.token, s.body.factor_id, '123456', { bffKey: 'partner' })).code).toBe('auth.session_expired'); expect(w.store.committed().length).toBe(n);
  });
  it.each([[undefined], [''], ['12345'], ['1234567'], ['abcdef'], [123456]])('code %j -> 400 common.validation_failed before any tx', async (code) => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' }); const s = await okStart(w, a.token); const t = w.txCalls.length;
    const e = await failComplete(w, a.token, s.body.factor_id, code); expect(e.code).toBe('common.validation_failed'); expect(w.txCalls.length).toBe(t);
  });
  it('AU-T21: bindTenant(session.tenant_id) once, after sessionByToken and before any factor / session / event write', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' }); const s = await okStart(w, a.token); w.store.order.length = 0;
    await okComplete(w, a.token, s.body.factor_id, totp(s.body.secret_base32)); const o = w.store.order; const i = o.indexOf(`bindTenant:${TENANT_A}`);
    expect(o.indexOf('sessionByToken')).toBeLessThan(i); expect(w.tx.bindTenant).toHaveBeenCalledTimes(1);
    for (const m of ['loadSession', 'factors', 'markFactorVerified', 'updateSession', 'recordTenant']) expect(o.indexOf(m), m).toBeGreaterThan(i);
  });
  it('hygiene: the code, secret, session token, GoTrue tokens and e-mail are in no log line and no event / job argument', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ state: 'mfa_enrolment_required' }); const s = await okStart(w, a.token); const bad = badCode(s.body.secret_base32); const old = [a.row.accessToken, a.row.refreshToken];
    await failComplete(w, a.token, s.body.factor_id, bad); const good = totp(s.body.secret_base32); await okComplete(w, a.token, s.body.factor_id, good);
    const hay = JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls, w.store.writes.filter((x) => x.m !== 'updateSession' && x.m !== 'insertFactor').map((x) => x.arg)]);
    for (const secret of [bad, good, s.body.secret_base32, a.token, a.email, ...old]) expect(hay).not.toContain(secret);
  });
});
