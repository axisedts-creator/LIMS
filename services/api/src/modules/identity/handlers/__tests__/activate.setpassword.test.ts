// T0B-ACTIVATE-1 / LD-299: setPasswordFromSetup for the first administrator of a tenant that is still provisioning.
// The handler itself must keep working unchanged (no tenant status test, MFA rules and rate limit as before, platform path untouched; LD-299 item 6).
// The invitation status rule (pending or sent) lives in the repository: see repository/__tests__/mfa.repo.accept-invitation.test.ts.
// These are GUARDS: they pass on main today and must still pass after the fix (a writer who adds a tenant status test to this handler breaks them).
import { describe, expect, it } from 'vitest';
import { GOOD_PW, MEMB_A, TENANT_A, makeWorld, otherWrites, platformRow, rejection, tenantRow } from './recovery.helpers.js';
import { createSetPasswordFromSetup } from '../setPasswordFromSetup.js';

type W = Awaited<ReturnType<typeof makeWorld>>;
const handler = (w: W) => createSetPasswordFromSetup(w.deps as any) as any;
const PROV = { tenant_status: 'provisioning', membership_status: 'invited' };
const ALLOWED = ['updateSession', 'revokeOtherSessions', 'acceptInvitation', 'recordTenant', 'recordTenantless', 'enqueue'];

describe('first administrator of a provisioning tenant sets the password', () => {
  it('200, state active (no MFA rule), the invitation accept is asked for THIS tenant and membership, event invite_accepted, password changed in GoTrue', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession({ row: tenantRow(PROV), invite: true });
    const r = await w.call(handler(w), { token: s.token, body: { new_password: GOOD_PW } });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ kind: 'tenant_staff', state: 'active' });
    expect(w.store.committed('acceptInvitation').map((x) => x.arg)).toEqual([expect.objectContaining({ membershipId: MEMB_A, userId: s.userId })]);
    expect(w.tx.bindTenant).toHaveBeenCalledTimes(1); expect(w.store.order).toContain(`bindTenant:${TENANT_A}`);
    expect(w.store.eventsOf('invite_accepted')).toHaveLength(1); expect(w.store.eventsOf('password_reset_completed')).toHaveLength(0);
    expect((await w.gw.signInWithPassword(s.email, GOOD_PW)).ok).toBe(true);
    expect(otherWrites(w.store, ALLOWED)).toEqual([]);
  });
  it('MFA rules as login, unchanged: role needs MFA -> mfa_enrolment_required; verified factor -> mfa_pending', async () => {
    const a = await makeWorld(); const sa = await a.addSetupSession({ row: tenantRow({ ...PROV, mfa_required: true }), invite: true });
    expect((await a.call(handler(a), { token: sa.token, body: { new_password: GOOD_PW } })).body.state).toBe('mfa_enrolment_required');
    const b = await makeWorld(); const sb = await b.addSetupSession({ row: tenantRow({ ...PROV, has_verified_factor: true }), invite: true });
    expect((await b.call(handler(b), { token: sb.token, body: { new_password: GOOD_PW } })).body.state).toBe('mfa_pending');
  });
  it('the login rate tier is still consumed exactly once per attempt (no change to rate limits)', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession({ row: tenantRow(PROV), invite: true });
    await w.call(handler(w), { token: s.token, body: { new_password: GOOD_PW } });
    expect(w.lim.calls.filter((c) => c.m === 'consumeAttempt')).toHaveLength(1);
  });
  it('no invitation to accept (a recovery) -> still 200 with event password_reset_completed; membership activation is the repository job and only follows an accepted invitation', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession({ row: tenantRow(PROV) });   // no pending invitation in the store
    const r = await w.call(handler(w), { token: s.token, body: { new_password: GOOD_PW } });
    expect(r.status).toBe(200); expect(w.store.eventsOf('password_reset_completed')).toHaveLength(1); expect(w.store.eventsOf('invite_accepted')).toHaveLength(0);
  });
  it('a weak password is refused before GoTrue and before the invitation accept: nothing kept, invitation still open for a retry', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession({ row: tenantRow(PROV), invite: true });
    const e = await rejection(w.call(handler(w), { token: s.token, body: { new_password: 'short' } }));
    expect(e.code).toBe('auth.password_policy_violation'); expect(w.store.committed()).toHaveLength(0);
    expect(w.store.pendingInvites.has(MEMB_A)).toBe(true);
  });
  it('an expired setup session (15 min) cannot accept the invitation: auth.session_expired, nothing written', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession({ row: tenantRow(PROV), invite: true, absoluteInMs: 1000 });
    w.advance(2000);
    expect((await rejection(w.call(handler(w), { token: s.token, body: { new_password: GOOD_PW } }))).code).toBe('auth.session_expired');
    expect(w.store.committed()).toHaveLength(0); expect(w.store.pendingInvites.has(MEMB_A)).toBe(true);
  });
});

describe('platform staff path is untouched (LD-299 item 6)', () => {
  it('a platform setup session still goes through acceptInvitation with no tenant, no bindTenant, state mfa_enrolment_required', async () => {
    const w = await makeWorld(); const s = await w.addSetupSession({ kind: 'platform', row: platformRow({ has_verified_factor: false }) });
    const r = await w.call(handler(w), { token: s.token, body: { new_password: GOOD_PW } });
    expect(r.body).toMatchObject({ kind: 'platform', state: 'mfa_enrolment_required' });
    expect(w.tx.bindTenant).not.toHaveBeenCalled();
    expect(w.store.committed('acceptInvitation').map((x) => x.arg.tenantId ?? null)).toEqual([null]);
  });
});
