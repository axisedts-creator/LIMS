// T9 setPasswordFromSetup (03-APP-FLOW s3.7, SS8; 01-PRD AC-A7.3, AC-A8.1, AC-A6.1-3; 07-SECURITY AU-T4, AU-T11, AU-T21; 08 A25 D-212).
// Expected now: fail (handlers/setPasswordFromSetup.ts is a stub; no createSetPasswordFromSetup).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GOOD_PW, MEMB_A, PW_SENTINEL, TENANT_A, hmacHex, makeWorld, norm, otherWrites, platformRow, rejection, tenantRow } from './recovery.helpers.js';
import { LimsError } from '../../../../core/errors.js';
import { createSetPasswordFromSetup } from '../setPasswordFromSetup.js';

type W = Awaited<ReturnType<typeof makeWorld>>;
const handler = (w: W) => createSetPasswordFromSetup(w.deps as any) as any;
const set = (w: W, token: string, pw: string) => w.call(handler(w), { token, body: { new_password: pw } });
const upd = (w: W) => w.calls.filter((c) => c.method === 'adminUpdatePassword');

describe('AC-A7.3 / AU-T11: valid setup session + compliant password', () => {
  it('GoTrue password updated; the user can sign in with it and no longer with the old one; response = SessionState', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession(); const r = await set(w, s.token, GOOD_PW);
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ kind: 'tenant_staff', state: 'active', aal: 'aal1', session_id: s.row.sessionId });
    expect(Date.parse(r.body.idle_expires_at)).not.toBeNaN(); expect(Date.parse(r.body.absolute_expires_at)).not.toBeNaN();
    expect(upd(w)).toEqual([{ method: 'adminUpdatePassword', args: [s.userId, GOOD_PW] }]);
    expect((await w.gw.signInWithPassword(s.email, GOOD_PW)).ok).toBe(true); expect((await w.gw.signInWithPassword(s.email, s.password)).ok).toBe(false);
  });
  it('all OTHER sessions of the user are revoked (reason password_change), the setup session is not; one identity.gotrue_signout job per revoked session, key signout:<session_id>:password_change; no user-wide GoTrue sign-out (it would kill the live setup tokens)', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession(); const o1 = await w.addOtherSession(s.userId, s.email, s.password); const o2 = await w.addOtherSession(s.userId, s.email, s.password, { state: 'mfa_pending' });
    const other = await w.addSetupSession(); await set(w, s.token, GOOD_PW);
    expect(o1.state).toBe('revoked'); expect(o1.revokeReason).toBe('password_change'); expect(o2.state).toBe('revoked'); expect(s.row.state).not.toBe('revoked'); expect(other.row.state).toBe('password_setup');
    const jobs = w.store.committed('enqueue').map((x) => x.arg).filter((a: any) => a.identifier === 'identity.gotrue_signout');
    expect(jobs.map((j: any) => j.jobKey).sort()).toEqual([`signout:${o1.sessionId}:password_change`, `signout:${o2.sessionId}:password_change`].sort());
    expect(w.calls.filter((c) => c.method === 'adminSignOutUser' || c.method === 'signOut')).toEqual([]);
    expect(w.store.committed('revokeOtherSessions')[0]!.arg).toMatchObject({ userId: s.userId, exceptSessionId: s.row.sessionId, reason: 'password_change', tenantId: TENANT_A });
  });
  it('the account failure counter is cleared under the HMAC key of the normalised e-mail', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession(); await w.lim.limits.recordAccountFailure(hmacHex(norm(s.email))); await w.lim.limits.recordAccountFailure(hmacHex(norm(s.email)));
    await set(w, s.token, GOOD_PW); expect((await w.lim.limits.accountState(hmacHex(norm(s.email)))).failures).toBe(0);
    expect(w.lim.calls.filter((c) => c.m === 'clearAccountFailures').map((c) => c.key)).toEqual([hmacHex(norm(s.email))]);
  });
  it('event password_reset_completed (recovery) for a membership with no pending invitation; invitation untouched; NOT invite_accepted', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession(); await set(w, s.token, GOOD_PW);
    expect(w.store.eventsOf('password_reset_completed')).toHaveLength(1); expect(w.store.eventsOf('password_reset_completed')[0]).toMatchObject({ tenantId: TENANT_A, membershipId: MEMB_A, userId: s.userId, sessionId: s.row.sessionId });
    expect(w.store.eventsOf('invite_accepted')).toHaveLength(0);
  });
  it('D-212: bindTenant(session tenant) ONCE before any tenant write (acceptInvitation / updateSession / revoke / events); tenant read only from the session lookup, never the body', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession(); const { hctx } = w.makeHctx(); await handler(w)(w.req({ token: s.token, body: { new_password: GOOD_PW } }), hctx);
    const o = w.store.order; const b = o.indexOf(`bindTenant:${TENANT_A}`); expect(b).toBeGreaterThanOrEqual(0); expect(o.filter((x) => x.startsWith('bindTenant'))).toHaveLength(1);
    for (const m of ['acceptInvitation', 'updateSession', 'revokeOtherSessions', 'recordTenant']) { const i = o.indexOf(m); if (i >= 0) expect(i, m).toBeGreaterThan(b); }
    expect(w.txCalls).toHaveLength(1); expect(w.txCalls[0]).toMatchObject({ operation: { module: 'identity', operationId: 'setPasswordFromSetup', context: 'identity_auth' } });
  });
  it('the new password never reaches logs, events, enqueue payloads, repo patches or errors', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession(); await set(w, s.token, PW_SENTINEL);
    const all = JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls, w.store.writes.map((x) => x.arg), w.txCalls, w.tx.query.mock.calls]); expect(all).not.toContain(PW_SENTINEL);
    const w2 = await makeWorld(); const s2 = await w2.addSetupSession(); const e = await rejection(set(w2, s2.token, 'shortPW-sen')); expect(JSON.stringify([e.message, e.detail, e.errors, w2.log.warn.mock.calls])).not.toContain('shortPW-sen');   // 11 code points < 12 floor (AC-A6.1), ruling T9-ruling.md
  });
});

describe('AC-A8.1: invitation acceptance and the MFA rule (SS8)', () => {
  it('invitation link: acceptInvitation(membership) called under the bound tenant -> event invite_accepted (not password_reset_completed)', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession({ invite: true }); await set(w, s.token, GOOD_PW);
    expect(w.store.committed('acceptInvitation')).toHaveLength(1); expect(w.store.committed('acceptInvitation')[0]!.arg).toMatchObject({ tenantId: TENANT_A, membershipId: MEMB_A, userId: s.userId });
    expect(w.store.eventsOf('invite_accepted')).toHaveLength(1); expect(w.store.eventsOf('password_reset_completed')).toHaveLength(0);
  });
  it.each([
    ['roles require MFA, no verified factor', { mfa_required: true, has_verified_factor: false }, 'mfa_enrolment_required'],
    ['no MFA required, no factor', { mfa_required: false, has_verified_factor: false }, 'active'],
    ['a verified factor already exists', { mfa_required: true, has_verified_factor: true }, 'mfa_pending'],
    ['verified factor, role no longer requires MFA', { mfa_required: false, has_verified_factor: true }, 'mfa_pending'],
  ])('%s -> session state %s (user must enrol/verify before the shell); aal stays aal1', async (_n, o, state) => {
    const w = await makeWorld(); const s = await w.addSetupSession({ row: tenantRow(o as any), invite: true }); const r = await set(w, s.token, GOOD_PW);
    expect(r.body).toMatchObject({ state, aal: 'aal1' }); expect(w.store.byId(s.row.sessionId)!.state).toBe(state);
  });
  it('platform staff setup session: no bindTenant, platform MFA rule applies (-> mfa_enrolment_required), other platform sessions revoked, event is tenant-less', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession({ kind: 'platform', row: platformRow({ has_verified_factor: false }) }); const o = await w.addOtherSession(s.userId, s.email, s.password, { kind: 'platform' });
    const r = await set(w, s.token, GOOD_PW); expect(r.body).toMatchObject({ kind: 'platform', state: 'mfa_enrolment_required' }); expect(w.tx.bindTenant).not.toHaveBeenCalled(); expect(o.state).toBe('revoked');
    expect(w.store.committed('recordTenant')).toHaveLength(0); expect(w.store.committed('revokeOtherSessions')[0]!.arg.tenantId).toBeNull();
  });
});

describe('AU-T4 / AC-A6.x: password policy before GoTrue', () => {
  const NINE_DEV = 'पासवर्ड-बहुत-लंबा-१२३४५६७८९'; // > 72 UTF-8 bytes, > 12 code points
  const cases: Array<[string, string, string, (p: Buffer) => boolean]> = [
    ['11 characters', 'Abcdefghij1', 'auth.password_policy_violation', () => false],
    ['73 bytes (Devanagari)', NINE_DEV.repeat(2), 'auth.password_policy_violation', () => false],
    ['breached (local SHA-1 list)', 'Correct-Horse-Battery-9', 'auth.password_breached', (h) => h.equals(createHash('sha1').update('Correct-Horse-Battery-9', 'utf8').digest())],
  ];
  it('sanity: the Devanagari sample is really > 72 bytes', () => { expect(Buffer.byteLength(NINE_DEV.repeat(2), 'utf8')).toBeGreaterThan(72); expect([...'Abcdefghij1'].length).toBe(11); });
  it.each(cases)('%s -> 422 %s; GoTrue never called; session stays password_setup; nothing revoked; no event', async (_n, pw, code, br) => {
    const w = await makeWorld({ breached: br }); const s = await w.addSetupSession(); const other = await w.addOtherSession(s.userId, s.email, s.password);
    const e = await rejection(set(w, s.token, pw)); expect(e.code).toBe(code); expect(e.statusCode).toBe(422);
    expect(upd(w)).toHaveLength(0); expect(w.store.byId(s.row.sessionId)!.state).toBe('password_setup'); expect(other.state).toBe('active'); expect(w.store.committed()).toHaveLength(0);
    expect((await w.gw.signInWithPassword(s.email, s.password)).ok).toBe(true);
  });
  it('the breached lookup runs only for policy-valid passwords and with the SHA-1 of the UTF-8 bytes', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession(); await rejection(set(w, s.token, 'short')); expect(w.breached.isBreached).not.toHaveBeenCalled();
    await set(w, s.token, GOOD_PW); expect(w.breachedSeen).toHaveLength(1); expect(w.breachedSeen[0]!.equals(createHash('sha1').update(GOOD_PW, 'utf8').digest())).toBe(true);
  });
  it('a failing breached lookup fails closed: 503/5xx, GoTrue not called', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession(); w.breached.isBreached.mockRejectedValueOnce(new Error('db down'));
    await rejection(set(w, s.token, GOOD_PW)); expect(upd(w)).toHaveLength(0); expect(w.store.committed()).toHaveLength(0);
  });
});

describe('session gate', () => {
  it('unknown token -> 401 auth.session_expired, nothing written, GoTrue not called; revoked / expired session the same', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession({ state: 'revoked' }); const e1 = await rejection(set(w, 'U'.repeat(43), GOOD_PW)); const e2 = await rejection(set(w, s.token, GOOD_PW));
    expect(e1.code).toBe('auth.session_expired'); expect(e2.code).toBe('auth.session_expired'); expect(upd(w)).toHaveLength(0); expect(w.store.committed()).toHaveLength(0);
  });
  it('missing cookie -> 401 auth.session_expired', async () => { const w = await makeWorld(); expect((await rejection(w.call(handler(w), { body: { new_password: GOOD_PW } }))).code).toBe('auth.session_expired'); });
  it('password_setup lapsed (absolute 15 min passed) -> 401 auth.session_expired, password not changed', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession(); w.advance(16 * 60_000); const e = await rejection(set(w, s.token, GOOD_PW)); expect(e.code).toBe('auth.session_expired'); expect(upd(w)).toHaveLength(0);
  });
  it.each(['active', 'mfa_pending', 'mfa_enrolment_required'])('a session in state %s cannot use setPasswordFromSetup (only password_setup): rejected, password unchanged', async (state) => {
    const w = await makeWorld(); const s = await w.addSetupSession({ state }); const e = await rejection(set(w, s.token, GOOD_PW)); expect(e).toBeInstanceOf(LimsError); expect([401, 403, 409]).toContain(e.statusCode);
    expect(upd(w)).toHaveLength(0); expect(w.store.committed()).toHaveLength(0);
  });
  it('a second set-password with the same token after success is rejected (state moved on) and GoTrue is called once only', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession(); await set(w, s.token, GOOD_PW); await rejection(set(w, s.token, `${GOOD_PW}-again`)); expect(upd(w)).toHaveLength(1);
  });
  it('the session token is looked up as sha256(cookie token); a token-reused flag -> 401', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession(); s.row.tokenReused = true; expect((await rejection(set(w, s.token, GOOD_PW))).code).toBe('auth.session_expired'); expect(upd(w)).toHaveLength(0);
  });
});

describe('dependency failure and validation', () => {
  it('GoTrue outage on adminUpdatePassword -> 503 common.dependency_unavailable; the tx rolls back: session still password_setup, others not revoked, no event/job', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession(); const o = await w.addOtherSession(s.userId, s.email, s.password);
    const h = createSetPasswordFromSetup({ ...(w.deps as any), gotrue: { adminUpdatePassword: async () => { throw new LimsError('common.dependency_unavailable'); } } }) as any;
    const e = await rejection(h(w.req({ token: s.token, body: { new_password: GOOD_PW } }), w.makeHctx().hctx)); expect(e.code).toBe('common.dependency_unavailable');
    expect(w.store.byId(s.row.sessionId)!.state).toBe('password_setup'); expect(o.state).toBe('active'); expect(otherWrites(w.store, [])).toEqual([]);
  });
  it.each([[{}], [{ new_password: '' }], [{ new_password: 'x'.repeat(129) }], [{ new_password: 5 }], [{ new_password: GOOD_PW, tenant_id: TENANT_A }], [{ new_password: GOOD_PW, state: 'active' }], [undefined]])('body %j -> 400 common.validation_failed before any identityAuthTx', async (body) => {
    const w = await makeWorld(); const s = await w.addSetupSession(); const e = await rejection(w.call(handler(w), { token: s.token, body })); expect(e.code).toBe('common.validation_failed'); expect(w.txCalls).toHaveLength(0); expect(upd(w)).toHaveLength(0);
  });
});
