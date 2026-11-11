// T7 verifyMfaChallenge: AC-A2.1-3, SS2/SS5/SS6, AU-T3, AU-T13, AU-T21, AU-T22 / P-42, E-9. Behaviour via createVerifyMfaChallenge(deps) (seams: mfa.helpers.ts header) against the
// in-memory GoTrue fake with REAL TOTP (the code is generated from the enrolment secret) and an identityAuthTx envelope that commits only when the callback returns.
// Expected now: fail (handlers/verifyMfaChallenge.ts is the common.internal stub and exports no createVerifyMfaChallenge).
import { describe, expect, it } from 'vitest';
import { LimsError, badCode, EMAIL, hmacHex, otherWrites, rejection, sha256, tokenN, totp, type MfaWorld, makeMfaWorld, STAFF_ID, TENANT_A, MEMB_A } from './mfa.helpers.js';
import { createVerifyMfaChallenge } from '../verifyMfaChallenge.js';

const run = async (w: MfaWorld, token: string | undefined, code: unknown, hc: Record<string, unknown> = {}) => {
  const { hctx, commitOnError } = w.makeHctx(hc);
  const h: any = createVerifyMfaChallenge(w.deps as any);
  return { hctx, commitOnError, p: h(w.req({ ...(token ? { token } : {}), body: { code } }), hctx) };
};
const ok = async (w: MfaWorld, token: string, code: string) => { const r = await run(w, token, code); return Object.assign(await r.p, { commitOnError: r.commitOnError }); };
const fail = async (w: MfaWorld, token: string | undefined, code: unknown, hc: Record<string, unknown> = {}) => { const r = await run(w, token, code, hc); return Object.assign(await rejection(r.p), { __c: r.commitOnError }); };

describe('AC-A2.2 / SS5: valid TOTP on mfa_pending -> active, aal2', () => {
  it('200 SessionState {state active, aal aal2}; row updated; events mfa_verified + login_succeeded; membership last_login_at touched; tokens replaced; no commitOnError', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true });
    const oldAccess = a.row.accessToken;
    const r = await ok(w, a.token, totp(a.secret!));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ session_id: a.row.sessionId, kind: 'tenant_staff', state: 'active', aal: 'aal2' });
    expect(typeof r.body.idle_expires_at).toBe('string'); expect(typeof r.body.absolute_expires_at).toBe('string');
    const s = w.store.byId(a.row.sessionId)!;
    expect(s.state).toBe('active'); expect(s.aal).toBe('aal2');
    expect(s.accessToken).not.toBe(oldAccess);   // the new aal2 GoTrue token pair is what is stored
    expect(JSON.parse(Buffer.from(s.accessToken.split('.')[1]!, 'base64url').toString()).aal).toBe('aal2');
    expect(w.store.eventsOf('mfa_verified')).toHaveLength(1); expect(w.store.eventsOf('login_succeeded')).toHaveLength(1);
    expect(w.store.eventsOf('mfa_verified')[0]).toMatchObject({ tenantId: TENANT_A, membershipId: MEMB_A, userId: a.userId, sessionId: a.row.sessionId, requestId: expect.any(String), clientIp: '203.0.113.9' });
    expect(w.store.committed('touchMembershipLogin').map((x) => x.arg)).toEqual([expect.objectContaining({ tenantId: TENANT_A, membershipId: MEMB_A })]);
    expect(r.commitOnError).not.toHaveBeenCalled();
    expect(JSON.stringify(r.body)).not.toMatch(/access_token|refresh_token|eyJ/);
  });
  it('platform staff: platform session path, events carry platformStaffId and are tenant-less, no bindTenant, no membership touch', async () => {
    const w = await makeMfaWorld({ kind: 'platform' }); const a = await w.addSession({ verifiedFactor: true });
    const r = await ok(w, a.token, totp(a.secret!));
    expect(r.body).toMatchObject({ kind: 'platform', state: 'active', aal: 'aal2' });
    expect(w.tx.bindTenant).not.toHaveBeenCalled();
    expect(w.store.committed('recordTenant')).toHaveLength(0);
    expect(w.store.committed('recordTenantless').map((x) => x.arg.eventType).sort()).toEqual(['login_succeeded', 'mfa_verified']);
    expect(w.store.committed('recordTenantless')[0]!.arg).toMatchObject({ platformStaffId: STAFF_ID, userId: a.userId });
    expect(w.store.committed('touchMembershipLogin')).toHaveLength(0);
  });
  it('several verified factors: the most recently verified one is challenged [CONV]', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true });
    w.store.factors.push({ id: 'f-old', tenantId: TENANT_A, userId: a.userId, gotrueFactorId: '00000000-0000-4000-8000-0000000000aa', status: 'verified', verifiedAt: new Date(0), friendlyName: null });
    await ok(w, a.token, totp(a.secret!));
    expect(w.calls.find((c) => c.method === 'mfaChallengeAndVerify')!.args[1]).toBe(a.gotrueFactorId);
  });
});

describe('AC-A2.3 / SS6 / AU-T3: invalid codes', () => {
  it('each wrong code -> 401 auth.mfa_invalid; mfa_failed_attempts +1 and the mfa_challenge_failed event are COMMITTED (P-42); account counter +1; commitOnError exactly once; nothing else survives', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true });
    for (let i = 1; i <= 4; i++) {
      const e = await fail(w, a.token, badCode(a.secret!));
      expect(e.code).toBe('auth.mfa_invalid'); expect(e.statusCode).toBe(401); expect(e.__c).toHaveBeenCalledTimes(1);
      expect(w.store.byId(a.row.sessionId)!.mfaFailedAttempts).toBe(i);
      expect(w.store.byId(a.row.sessionId)!.state).toBe('mfa_pending');
      expect(w.store.eventsOf('mfa_challenge_failed')).toHaveLength(i);
      expect(w.store.committed('updateSession').at(-1)!.arg.patch).toMatchObject({ mfaFailedAttempts: i });
      expect(w.lim.calls.filter((c) => c.m === 'recordAccountFailure' && c.key === hmacHex(a.email))).toHaveLength(i);
    }
    expect(otherWrites(w.store, ['updateSession', 'recordTenant'])).toEqual([]);   // no session activation, no last_login_at, no job, no mfa_verified
    expect(w.store.eventsOf('mfa_verified')).toHaveLength(0); expect(w.store.committed('touchMembershipLogin')).toHaveLength(0); expect(w.store.committed('enqueue')).toHaveLength(0);
  });
  it('the 5th invalid code revokes the session (reason mfa_failed) + session_revoked event + sign-out job, all committed; still 401 auth.mfa_invalid', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true });
    for (let i = 0; i < 4; i++) await fail(w, a.token, badCode(a.secret!));
    const e = await fail(w, a.token, badCode(a.secret!));
    expect(e.code).toBe('auth.mfa_invalid'); expect(e.__c).toHaveBeenCalledTimes(1);
    const s = w.store.byId(a.row.sessionId)!; expect(s.state).toBe('revoked'); expect(s.revokeReason).toBe('mfa_failed'); expect(s.mfaFailedAttempts).toBe(5);
    expect(w.store.eventsOf('mfa_challenge_failed')).toHaveLength(5);
    expect(w.store.eventsOf('session_revoked')).toHaveLength(1); expect(w.store.eventsOf('session_revoked')[0]).toMatchObject({ reasonCode: 'mfa_failed', sessionId: a.row.sessionId });
    const job = w.store.committed('enqueue').map((x) => x.arg); expect(job).toHaveLength(1);
    expect(job[0]).toMatchObject({ identifier: 'identity.gotrue_signout', payload: expect.objectContaining({ user_id: a.userId }) }); expect(job[0].jobKey).toMatch(/^signout:/);
    expect(w.lim.calls.filter((c) => c.m === 'recordAccountFailure')).toHaveLength(5);
  });
  it('a 6th request -> 401 auth.session_expired (the revoked session is not found), even with the CORRECT code; no GoTrue call, no write', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true });
    for (let i = 0; i < 5; i++) await fail(w, a.token, badCode(a.secret!));
    const before = w.store.writes.length; const g = w.calls.length;
    const e = await fail(w, a.token, totp(a.secret!));
    expect(e.code).toBe('auth.session_expired'); expect(e.statusCode).toBe(401); expect(w.store.writes.length).toBe(before); expect(w.calls.length).toBe(g);
  });
  it('failure at attempt 5 must roll back nothing it should keep: the same transaction that threw 401 COMMITTED (envelope sees a return, not a throw)', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true, attempts: 4 });
    await fail(w, a.token, badCode(a.secret!));
    expect(w.store.writes.filter((x) => !x.committed)).toEqual([]);
  });
  it('a GoTrue outage is not a wrong code: 503 common.dependency_unavailable, attempts and counters unchanged, no event', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true });
    (w.deps.gotrue as any).mfaChallengeAndVerify = async () => { throw new Error('ECONNREFUSED'); };
    const e = await fail(w, a.token, '123456'); expect(e.code).toBe('common.dependency_unavailable');
    expect(w.store.byId(a.row.sessionId)!.mfaFailedAttempts).toBe(0); expect(w.store.committed()).toEqual([]); expect(w.lim.calls.filter((c) => c.m === 'recordAccountFailure')).toEqual([]);
  });
  it('platform staff failures: tenant-less events with platformStaffId; revoke at 5 goes through the platform session path (kind platform, tenantId null)', async () => {
    const w = await makeMfaWorld({ kind: 'platform' }); const a = await w.addSession({ verifiedFactor: true });
    for (let i = 0; i < 5; i++) await fail(w, a.token, badCode(a.secret!));
    expect(w.store.committed('recordTenant')).toHaveLength(0); expect(w.tx.bindTenant).not.toHaveBeenCalled();
    expect(w.store.eventsOf('mfa_challenge_failed')).toHaveLength(5); expect(w.store.eventsOf('mfa_challenge_failed')[0]).toMatchObject({ platformStaffId: STAFF_ID });
    expect(w.store.committed('updateSession').at(-1)!.arg.ref).toMatchObject({ kind: 'platform', tenantId: null }); expect(w.store.byId(a.row.sessionId)!.state).toBe('revoked');
  });
});

describe('state, kind and cookie rules', () => {
  it.each(['active', 'mfa_enrolment_required', 'password_setup'])('session in %s -> 409 common.version_conflict; GoTrue not called, nothing written', async (state) => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true, state });
    const e = await fail(w, a.token, totp(a.secret!)); expect(e.code).toBe('common.version_conflict'); expect(e.statusCode).toBe(409);
    expect(w.calls.filter((c) => c.method === 'mfaChallengeAndVerify')).toHaveLength(0); expect(w.store.committed()).toEqual([]);
  });
  it('E-9: unknown token of valid format, malformed token and revoked session all -> 401 auth.session_expired with the same body; no write, no GoTrue call', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true }); w.store.byId(a.row.sessionId)!.state = 'revoked';
    const codes: string[] = []; const bodies: string[] = [];
    for (const t of [tokenN(0x99999), 'short', 'x'.repeat(200), a.token]) { const e = await fail(w, t, '123456'); codes.push(e.code); bodies.push(JSON.stringify({ c: e.code, s: e.statusCode, d: e.detail })); }
    expect(new Set(codes)).toEqual(new Set(['auth.session_expired'])); expect(new Set(bodies).size).toBe(1);
    expect(w.store.committed()).toEqual([]); expect(w.calls.filter((c) => c.method === 'mfaChallengeAndVerify')).toHaveLength(0);
  });
  it('no cookie / cookie without __Host-lims_sid -> 401 (auth.session_expired or auth.unauthenticated); no lookup, no write', async () => {
    const w = await makeMfaWorld(); await w.addSession({ verifiedFactor: true });
    const { hctx } = w.makeHctx(); const h: any = createVerifyMfaChallenge(w.deps as any);
    for (const headers of [{}, { cookie: 'a=b' }, { cookie: '__lims_sid=' + tokenN(1) }]) {
      const e = await rejection(h({ params: {}, query: {}, headers, body: { code: '123456' } }, hctx));
      expect(['auth.session_expired', 'auth.unauthenticated']).toContain(e.code); expect(e.statusCode).toBe(401);
    }
    expect(w.store.committed()).toEqual([]);
  });
  it('AU-T13: a tenant_staff / platform session presented with the partner BFF key (or no key) -> 401 auth.session_expired, session untouched, GoTrue not called', async () => {
    for (const bffKey of ['partner', undefined, 'portal']) {
      const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true });
      const e = await fail(w, a.token, totp(a.secret!), { bffKey }); expect(e.code).toBe('auth.session_expired');
      expect(w.store.byId(a.row.sessionId)!.state).toBe('mfa_pending'); expect(w.store.committed()).toEqual([]); expect(w.calls.filter((c) => c.method === 'mfaChallengeAndVerify')).toHaveLength(0);
    }
  });
  it('AU-T21: tenant kinds look the session up first (DEFINER), then bindTenant(session.tenant_id) ONCE, and only then load/update/insert; the tenant comes from the row, never from the request', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true });
    const { hctx } = w.makeHctx(); const h: any = createVerifyMfaChallenge(w.deps as any);
    await h(w.req({ token: a.token, body: { code: totp(a.secret!) }, headers: { 'x-tenant-id': '0190a000-0000-7000-8000-0000000000a2' } }), hctx);
    const o = w.store.order; const i = o.indexOf(`bindTenant:${TENANT_A}`);
    expect(o.indexOf('sessionByToken')).toBeLessThan(i); expect(w.tx.bindTenant).toHaveBeenCalledTimes(1); expect(w.tx.bindTenant).toHaveBeenCalledWith(TENANT_A);
    for (const m of ['loadSession', 'factors', 'updateSession', 'recordTenant']) expect(o.indexOf(m), m).toBeGreaterThan(i);
  });
});

describe('request validation (OpenAPI MfaCodeRequest: only `code`, ^[0-9]{6}$) - before any transaction', () => {
  it.each([[undefined], [null], [''], ['12345'], ['1234567'], ['12345a'], [' 12345'], ['１２３４５６'], [123456], [['123456']], [{ code: '123456' }]])('code %j -> 400 common.validation_failed; no tx, no GoTrue call', async (code) => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true });
    const e = await fail(w, a.token, code); expect(e.code).toBe('common.validation_failed'); expect(w.txCalls).toHaveLength(0); expect(w.calls.filter((c) => c.method === 'mfaChallengeAndVerify')).toHaveLength(0);
  });
  it.each([[{ code: '123456', tenant_id: TENANT_A }], [{ code: '123456', aal: 'aal2' }], [{ code: '123456', state: 'active' }], [{ code: '123456', factor_id: 'x' }], ['123456'], [null], [[]]])('forged / malformed body %j -> 400 common.validation_failed', async (body) => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true });
    const { hctx } = w.makeHctx(); const h: any = createVerifyMfaChallenge(w.deps as any);
    const e = await rejection(h(w.req({ token: a.token, body }), hctx)); expect(e.code).toBe('common.validation_failed'); expect(w.txCalls).toHaveLength(0); expect(w.store.committed()).toEqual([]);
  });
});

describe('hygiene', () => {
  it('the code, the session token, the e-mail and GoTrue tokens appear in no log line and no event / job / counter argument', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true }); const code = badCode(a.secret!);
    const oldTokens = [a.row.accessToken, a.row.refreshToken];
    await fail(w, a.token, code); const good = totp(a.secret!); await ok(w, a.token, good);
    const hay = JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls, w.store.writes.filter((x) => x.m !== 'updateSession').map((x) => x.arg), w.lim.calls]);
    for (const secret of [code, good, a.token, sha256(a.token).toString('hex'), a.email, ...oldTokens, a.secret!]) expect(hay).not.toContain(secret);
    expect(hay).not.toContain(w.store.byId(a.row.sessionId)!.accessToken);
  });
  it('the error body carries no detail that echoes the code or the e-mail', async () => {
    const w = await makeMfaWorld({ email: EMAIL }); const a = await w.addSession({ verifiedFactor: true, email: EMAIL }); const code = badCode(a.secret!);
    const e = await fail(w, a.token, code); expect(JSON.stringify({ m: e.message, d: e.detail, f: e.errors })).not.toMatch(new RegExp(`${code}|ana\\.demo`));
  });
});

describe('x-rate-limit-tier: login (LD-10, 02-CV 10.3): per-account consumeAttempt on every verifyMfaChallenge', () => {
  it('consumes one attempt keyed hmac(email) before any GoTrue call', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true }); const g = w.calls.length;
    await ok(w, a.token, totp(a.secret!));
    expect(w.lim.calls.filter((c) => c.m === 'consumeAttempt').map((c) => c.key)).toEqual([hmacHex(a.email)]);
    expect(w.calls.length).toBeGreaterThan(g);
  });
  it('a rejecting consumeAttempt -> 429 common.rate_limited with Retry-After; GoTrue not called; nothing written', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true }); const g = w.calls.length;
    (w.deps.limits as any).consumeAttempt = async () => { throw Object.assign(new LimsError('common.rate_limited'), { retryAfterSeconds: 42 }); };
    const e = await fail(w, a.token, totp(a.secret!));
    expect(e.code).toBe('common.rate_limited'); expect(e.statusCode).toBe(429); expect(e.retryAfterSeconds).toBe(42);
    expect(w.calls.length).toBe(g); expect(w.store.committed('updateSession')).toEqual([]); expect(w.store.byId(a.row.sessionId)!.state).toBe('mfa_pending');
  });
});
