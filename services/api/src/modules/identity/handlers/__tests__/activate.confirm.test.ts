// T0B-ACTIVATE-1 / LD-299: confirmEmailToken tenant status rule. Live fault (staging tenant metrolabs, 2026-11-16): the invite link of a tenant that is still
// provisioning answered auth.invite_invalid, so the first administrator could never accept and activateTenant (needs an accepted tenant_admin) could never pass.
// Rule under test: type invite is usable when tenant_status is provisioning OR active; type recovery still needs active; exactly one membership, not locked,
// membership invited or active. Every other case answers the SAME type specific 400 and writes nothing (01-PRD AC-A7.2 / AC-A8.2, 07-SECURITY AU-T6).
// Expected now: the "provisioning invite" tests fail (handler answers auth.invite_invalid); the refusal tests pass and stay as guards.
import { describe, expect, it } from 'vitest';
import { MEMB_A, TENANT_A, errBody, makeWorld, otherWrites, rejection, tenantRow } from './recovery.helpers.js';
import { createConfirmEmailToken } from '../confirmEmailToken.js';

type W = Awaited<ReturnType<typeof makeWorld>>;
const handler = (w: W) => createConfirmEmailToken(w.deps as any) as any;
const ALLOWED = ['insertSession', 'recordTenant'];
const PROV_INVITED = { tenant_status: 'provisioning', membership_status: 'invited' };

/** a fresh invitee (the fake sends invites to NEW addresses only) whose login-context row is `row`; or a recovery link of an existing user */
async function link(w: W, type: 'invite' | 'recovery', row: Record<string, unknown>) {
  if (type === 'recovery') {
    const u = await w.addUser({ row: tenantRow(row) }); await w.gw.sendRecovery(u.email, '/auth/confirm');
    return { ...u, hash: w.fake!.mailbox.latestTokenHash(u.email, 'recovery')! };
  }
  const email = `inv-${Math.random().toString(36).slice(2, 8)}@lims-test.example`;
  await w.gw.sendInvite(email, '/auth/confirm'); const f = await w.gw.adminFindUserByEmail(email);
  w.store.ctxRows.set(f!.userId, tenantRow(row));
  return { email, userId: f!.userId, hash: w.fake!.mailbox.latestTokenHash(email, 'invite')! };
}
const confirm = (w: W, hash: string, type: 'invite' | 'recovery') => w.call(handler(w), { body: { token_hash: hash, type } });
const INVALID = { invite: 'auth.invite_invalid', recovery: 'auth.reset_token_invalid' } as const;

describe('invite link of a tenant that is still provisioning (the live deadlock)', () => {
  it('membership invited + tenant provisioning -> 200 password_setup session bound to that tenant and membership; invite_link_opened event; one bindTenant', async () => {
    const w = await makeWorld(); const l = await link(w, 'invite', PROV_INVITED);
    const r = await confirm(w, l.hash, 'invite');
    expect(r.status).toBe(200);
    expect(r.body.session).toMatchObject({ kind: 'tenant_staff', state: 'password_setup', aal: 'aal1' });
    const [s] = w.store.committed('insertSession').map((x) => x.arg);
    expect(s).toMatchObject({ kind: 'tenant_staff', state: 'password_setup', tenantId: TENANT_A, membershipId: MEMB_A, userId: l.userId });
    expect(w.store.order.filter((x) => x.startsWith('bindTenant'))).toEqual([`bindTenant:${TENANT_A}`]);
    expect(w.store.eventsOf('invite_link_opened')).toHaveLength(1);
    expect(otherWrites(w.store, ALLOWED)).toEqual([]);
  });
  it('membership already active (link opened again after accepting) + tenant provisioning -> 200 as well', async () => {
    const w = await makeWorld(); const l = await link(w, 'invite', { tenant_status: 'provisioning', membership_status: 'active' });
    expect((await confirm(w, l.hash, 'invite')).status).toBe(200);
  });
  it('regression: invite + tenant active + membership invited -> still 200', async () => {
    const w = await makeWorld(); const l = await link(w, 'invite', { tenant_status: 'active', membership_status: 'invited' });
    expect((await confirm(w, l.hash, 'invite')).status).toBe(200);
  });
  it('the tenant status is read from the DEFINER row only: a body that names a tenant or a status is a validation failure before GoTrue', async () => {
    const w = await makeWorld(); const l = await link(w, 'invite', PROV_INVITED);
    for (const extra of [{ tenant_status: 'active' }, { tenant_id: TENANT_A }, { status: 'provisioning' }]) {
      const e = await rejection(w.call(handler(w), { body: { token_hash: l.hash, type: 'invite', ...extra } }));
      expect(e.code).toBe('common.validation_failed');
    }
    expect(w.calls).toHaveLength(0); expect(w.txCalls).toHaveLength(0);
  });
});

describe('what must stay refused (no widening, no oracle)', () => {
  it('RECOVERY link of a provisioning tenant -> 400 auth.reset_token_invalid, no session, no bindTenant, no write', async () => {
    const w = await makeWorld(); const l = await link(w, 'recovery', { tenant_status: 'provisioning', membership_status: 'active' });
    const e = await rejection(confirm(w, l.hash, 'recovery'));
    expect(e.code).toBe('auth.reset_token_invalid'); expect(e.statusCode).toBe(400);
    expect(w.tx.bindTenant).not.toHaveBeenCalled(); expect(w.store.committed()).toHaveLength(0);
  });
  it.each(['suspended', 'offboarded'])('invite link of a %s tenant -> 400 auth.invite_invalid, nothing written', async (tenant_status) => {
    const w = await makeWorld(); const l = await link(w, 'invite', { tenant_status, membership_status: 'invited' });
    const e = await rejection(confirm(w, l.hash, 'invite'));
    expect(e.code).toBe('auth.invite_invalid'); expect(e.statusCode).toBe(400);
    expect(w.tx.bindTenant).not.toHaveBeenCalled(); expect(w.store.committed()).toHaveLength(0);
  });
  it.each([
    ['membership locked', { membership_locked: true }],
    ['membership lock unknown (null)', { membership_locked: null }],
    ['two memberships', { membership_count: 2 }],
    ['no membership', { membership_count: 0, tenant_id: null, membership_id: null }],
    ['membership deactivated', { membership_status: 'deactivated' }],
    ['membership status missing', { membership_status: null }],
    ['unknown tenant status', { tenant_status: 'draft' }],
    ['tenant status missing', { tenant_status: null }],
  ])('invite link of a PROVISIONING tenant with %s -> 400 auth.invite_invalid, nothing written', async (_n, over) => {
    const w = await makeWorld(); const l = await link(w, 'invite', { ...PROV_INVITED, ...over });
    const e = await rejection(confirm(w, l.hash, 'invite'));
    expect(e.code).toBe('auth.invite_invalid');
    expect(w.tx.bindTenant).not.toHaveBeenCalled(); expect(w.store.committed()).toHaveLength(0);
  });
  it('NO ORACLE: the refusal for a provisioning tenant with a locked member is byte identical to the refusal of an unknown link', async () => {
    const w = await makeWorld(); const l = await link(w, 'invite', { ...PROV_INVITED, membership_locked: true });
    const known = await rejection(confirm(w, l.hash, 'invite'));
    const w2 = await makeWorld(); const unknown = await rejection(confirm(w2, 'x'.repeat(43), 'invite'));
    expect(errBody(known)).toBe(errBody(unknown));
  });
  it('a provisioning invite link is single use: the second open of the same token is auth.invite_invalid and creates no second session', async () => {
    const w = await makeWorld(); const l = await link(w, 'invite', PROV_INVITED);
    expect((await confirm(w, l.hash, 'invite')).status).toBe(200);
    expect((await rejection(confirm(w, l.hash, 'invite'))).code).toBe('auth.invite_invalid');
    expect(w.store.committed('insertSession')).toHaveLength(1);
  });
  it('the invite code and the recovery code stay type specific for a provisioning tenant (a recovery token presented as invite is invalid)', async () => {
    const w = await makeWorld(); const l = await link(w, 'recovery', { tenant_status: 'provisioning', membership_status: 'active' });
    const e = await rejection(confirm(w, l.hash, 'invite'));
    expect(e.code).toBe(INVALID.invite);
    expect(w.store.committed()).toHaveLength(0);
  });
});

describe('platform staff invite path is untouched (LD-299 item 6)', () => {
  it('a platform staff invite link still opens a kind platform setup session: no bindTenant, insertPlatformSession, tenant-less event', async () => {
    const w = await makeWorld();
    const email = `staff-${Math.random().toString(36).slice(2, 8)}@lims-test.example`;
    await w.gw.sendInvite(email, '/auth/confirm'); const f = await w.gw.adminFindUserByEmail(email);
    const { platformRow } = await import('./recovery.helpers.js'); w.store.ctxRows.set(f!.userId, platformRow());
    const r = await confirm(w, w.fake!.mailbox.latestTokenHash(email, 'invite')!, 'invite');
    expect(r.body.session).toMatchObject({ kind: 'platform', state: 'password_setup' });
    expect(w.tx.bindTenant).not.toHaveBeenCalled(); expect(w.store.committed('insertPlatformSession')).toHaveLength(1);
  });
});
