// T9 / LD-99 / 08 A38: setPasswordFromSetup for the `platform` kind (03-APP-FLOW §3.7 SS8; 01-PRD AC-A8.1; 07-SECURITY AU-T11).
//  A38-1: other platform sessions are revoked (reason password_change) and the platform invitation is accepted (repo -> the two new DEFINERs).
//  A38-2: NO identity.gotrue_signout job (and no GoTrue sign-out) for the platform kind: it would kill the live setup session's GoTrue tokens needed for MFA enrolment.
//  A38-3: the session keeps its 15-minute absolute_expires_at. Tenant-staff behaviour is unchanged (one signout job per revoked session).
// New file: the existing recovery.setpassword.test.ts is not edited. Expected now: the "no gotrue_signout" tests fail (handler still enqueues {user_id} jobs for platform).
import { describe, expect, it } from 'vitest';
import { GOOD_PW, START, TENANT_A, makeWorld, platformRow, tenantRow } from './recovery.helpers.js';
import { createSetPasswordFromSetup } from '../setPasswordFromSetup.js';

type W = Awaited<ReturnType<typeof makeWorld>>;
const SIGNOUT = 'identity.gotrue_signout';
/** handler whose acceptInvitation sees platform invitations by user (what the repo does through invitation_accept_by_user) */
function platformHandler(w: W, hasInvitation: boolean) {
  const accepted: any[] = [];
  const repo = { ...w.deps.repo, acceptInvitation: async (_tx: unknown, a: any) => { accepted.push(a); return hasInvitation && a.tenantId === null; } };
  return { accepted, h: createSetPasswordFromSetup({ ...(w.deps as any), repo }) as any };
}
const set = (w: W, h: any, token: string) => w.call(h, { token, body: { new_password: GOOD_PW } });
const signoutJobs = (w: W) => w.store.committed('enqueue').map((x) => x.arg).filter((a: any) => a.identifier === SIGNOUT);

describe('A38 platform setPasswordFromSetup', () => {
  it('other platform sessions of the user -> revoked / password_change; the current session and the user\'s tenant session are not; invitation accepted', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession({ kind: 'platform', row: platformRow({ has_verified_factor: false }) });
    const o1 = await w.addOtherSession(s.userId, s.email, s.password, { kind: 'platform' }); const o2 = await w.addOtherSession(s.userId, s.email, s.password, { kind: 'platform', state: 'mfa_pending' });
    const t = await w.addOtherSession(s.userId, s.email, s.password, { kind: 'tenant_staff' });
    const { h, accepted } = platformHandler(w, true); const r = await set(w, h, s.token);
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ kind: 'platform', state: 'mfa_enrolment_required', session_id: s.row.sessionId });
    expect([o1.state, o2.state]).toEqual(['revoked', 'revoked']); expect([o1.revokeReason, o2.revokeReason]).toEqual(['password_change', 'password_change']);
    expect(s.row.state).toBe('mfa_enrolment_required'); expect(t.state).toBe('active');
    expect(w.store.committed('revokeOtherSessions')[0]!.arg).toMatchObject({ tenantId: null, userId: s.userId, exceptSessionId: s.row.sessionId, reason: 'password_change' });
    expect(accepted).toHaveLength(1); expect(accepted[0]).toMatchObject({ tenantId: null, membershipId: null, userId: s.userId });
    expect(w.store.eventsOf('invite_accepted')).toHaveLength(1); expect(w.store.committed('recordTenant')).toHaveLength(0); expect(w.tx.bindTenant).not.toHaveBeenCalled();
  });
  it('A38-2: NO identity.gotrue_signout job is enqueued for the platform kind, and no GoTrue sign-out is made (the setup session\'s tokens must survive for MFA enrolment)', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession({ kind: 'platform', row: platformRow({ has_verified_factor: false }) });
    const o1 = await w.addOtherSession(s.userId, s.email, s.password, { kind: 'platform' }); const o2 = await w.addOtherSession(s.userId, s.email, s.password, { kind: 'platform' });
    await set(w, platformHandler(w, true).h, s.token);
    expect(o1.state).toBe('revoked'); expect(o2.state).toBe('revoked');   // sessions were revoked ...
    expect(signoutJobs(w)).toEqual([]);                                   // ... without any sign-out job, per-session or user-wide
    expect(w.store.committed('enqueue').filter((x) => /signout/i.test(JSON.stringify(x.arg)))).toEqual([]);
    expect(w.calls.filter((c) => c.method === 'adminSignOutUser' || c.method === 'signOut')).toEqual([]);
    expect((await w.gw.signInWithPassword(s.email, GOOD_PW)).ok).toBe(true);
  });
  it('A38-3: the setup session keeps its 15-minute absolute_expires_at (no key for it in the session patch, response unchanged)', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession({ kind: 'platform', row: platformRow({ has_verified_factor: false }) }); const abs = s.row.absoluteExpiresAt.getTime();
    expect(abs).toBe(START.getTime() + 15 * 60_000);
    const r = await set(w, platformHandler(w, true).h, s.token);
    expect(Date.parse(r.body.absolute_expires_at)).toBe(abs); expect(w.store.byId(s.row.sessionId)!.absoluteExpiresAt.getTime()).toBe(abs);
    const patch = w.store.committed('updateSession')[0]!.arg.patch; expect(Object.keys(patch).filter((k) => /absolute|expires/i.test(k))).toEqual([]);
  });
  it('platform user with no other session and no invitation (recovery link): 200, nothing revoked, no sign-out job, event password_reset_completed (tenant-less)', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession({ kind: 'platform', row: platformRow({ has_verified_factor: true }) });
    const r = await set(w, platformHandler(w, false).h, s.token);
    expect(r.body).toMatchObject({ kind: 'platform', state: 'mfa_pending' }); expect(signoutJobs(w)).toEqual([]);
    expect(w.store.eventsOf('password_reset_completed')).toHaveLength(1); expect(w.store.eventsOf('invite_accepted')).toHaveLength(0);
  });
  it('another user\'s platform session is never revoked', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession({ kind: 'platform', row: platformRow() }); const other = await w.addSetupSession({ kind: 'platform', row: platformRow() });
    await set(w, platformHandler(w, true).h, s.token); expect(other.row.state).toBe('password_setup');
  });
});

describe('A38: tenant-staff behaviour unchanged', () => {
  it('one identity.gotrue_signout job per revoked tenant session, payload { user_id, tenant_id, session_id }, key signout:<session_id>:password_change', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession({ row: tenantRow() }); const o1 = await w.addOtherSession(s.userId, s.email, s.password); const o2 = await w.addOtherSession(s.userId, s.email, s.password, { state: 'mfa_pending' });
    await set(w, createSetPasswordFromSetup(w.deps as any), s.token);
    const jobs = signoutJobs(w); expect(jobs.map((j: any) => j.jobKey).sort()).toEqual([`signout:${o1.sessionId}:password_change`, `signout:${o2.sessionId}:password_change`].sort());
    for (const j of jobs as any[]) expect(j.payload).toEqual({ user_id: s.userId, tenant_id: TENANT_A, session_id: expect.any(String) });
    expect(o1.state).toBe('revoked'); expect(s.row.state).not.toBe('revoked');
  });
});
