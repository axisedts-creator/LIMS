// T0B-ACTIVATE-1 / LD-299: the whole first administrator chain, in order: provision -> open invite link -> set password -> activate -> login.
// REAL: tenant.service (provision, activate readiness gate), confirmEmailToken, setPasswordFromSetup, auth.service loginStaff, the fake GoTrue gateway (real token flow).
// FAKE: the database (tenant.helpers fake repo + recovery.helpers session store), bridged by `loginContextOf` which projects the fake tenant and membership rows
// into the app.identity_login_context row the way the DEFINER does. Real SQL of the invitation accept is in repository/__tests__/mfa.repo.accept-invitation.test.ts.
// SEAM: the invitation e-mail is the worker + Supabase template job (nonblocking CR, LD-299 item 7): here provisioning asks the fake gateway for the invite mail, whose
// link is /auth/confirm with token_hash and type=invite; the test opens it exactly like the browser page does.
// Expected now: fails at "open invite link" (auth.invite_invalid, tenant provisioning) - the deadlock.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAuthService } from '../../service/auth.service.js';
import { createTenantService } from '../../service/tenant.service.js';
import { PROVISION, makeCtx, makeRepo, nextId, rejection as trejection, type FakeRepo } from '../../service/__tests__/tenant.helpers.js';
import { makeWorld as makeAuthWorld, tenantRow } from '../../service/__tests__/auth.helpers.js';
import { GOOD_PW, makeWorld } from './recovery.helpers.js';
import { createConfirmEmailToken } from '../confirmEmailToken.js';
import { createSetPasswordFromSetup } from '../setPasswordFromSetup.js';

const EMAIL = PROVISION.firstAdmin.email.trim().toLowerCase();

/** the DEFINER view of the fake database for one GoTrue user */
function loginContextOf(f: FakeRepo, sub: string) {
  for (const { tenant, data } of f.world.values()) {
    const m = data.members.find((x) => x.user_id === sub);
    if (m) return tenantRow({ tenant_id: tenant.id, tenant_status: tenant.status, membership_id: m.id, membership_status: m.status, membership_locked: false, mfa_required: false, has_verified_factor: false });
  }
  return tenantRow({ membership_count: 0, tenant_id: null, tenant_status: null, membership_id: null, membership_status: null, membership_locked: null });
}

async function chainWorld() {
  const w = await makeWorld();                                   // fake GoTrue + session store + limits (T9 world)
  const f = makeRepo({ tenants: [] });                           // fake tenant database
  const gotrue = { async adminCreateUser(i: { email: string }) {   // provisioning creates the user AND the invite mail (fake gateway: invite to a new address)
    await w.gw.sendInvite(i.email, '/auth/confirm'); return { userId: (await w.gw.adminFindUserByEmail(i.email))!.userId }; } };
  const svc = createTenantService({ repo: f.repo, gotrue, emailHmac: (e: string) => Buffer.from(e), userExists: async () => false, newId: nextId } as never) as any;
  w.store.setDefaultRow((sub) => loginContextOf(f, sub));
  // invitation accept as the repository does it for the tenant branch: pending or sent, unexpired -> accepted, membership invited -> active + accepted_at
  const repo = { ...w.store.repo, async acceptInvitation(_tx: unknown, a: { tenantId: string | null; membershipId: string | null; at: Date }) {
    const d = f.data(a.tenantId!); const inv = d.invitations.find((i: any) => i.membershipId === a.membershipId && i.expiresAt.getTime() > a.at.getTime() && i.status !== 'accepted');
    const m = d.members.find((x) => x.id === a.membershipId);
    if (!inv || !m || m.status !== 'invited') return false;
    (inv as any).status = 'accepted'; m.status = 'active'; m.accepted = true; return true;
  } };
  const deps = { ...(w.deps as any), repo };
  const aw = makeAuthWorld({ rows: (sub: string) => loginContextOf(f, sub) });
  const auth = createAuthService({ ...aw.deps, gotrue: { signInWithPassword: (e: string, p: string) => w.gw.signInWithPassword(e, p) } } as any) as any;
  const login = () => auth.loginStaff(aw.makeCtx().ctx, { email: EMAIL, password: GOOD_PW });
  return { w, f, svc, deps, aw, login, ctx: () => makeCtx(f).ctx };
}

describe('provision -> open invite link -> set password -> activate -> login (the founder path, tenant metrolabs)', () => {
  it('a new tenant becomes active through the app alone and its first administrator can then log in', async () => {
    const c = await chainWorld();

    // 1 provision: tenant provisioning, admin invited, nothing accepted yet -> activation refused (the guard of AC-E1.3 stays)
    const p = await c.svc.provisionTenant(c.ctx(), PROVISION); const id = p.body.tenant_id as string;
    expect(c.f.tenant(id)!.status).toBe('provisioning'); expect(c.f.data(id).members[0]).toMatchObject({ status: 'invited', accepted: false });
    expect((await trejection(c.svc.activateTenant(c.ctx(), { tenantId: id, expectedVersion: p.version }))).code).toBe('identity.tenant_not_ready');

    // 2 open the invite link (/auth/confirm?token_hash=...&type=invite): password_setup session in the PROVISIONING tenant
    const hash = c.w.fake!.mailbox.latestTokenHash(EMAIL, 'invite');
    expect(hash).toBeTruthy();
    const opened = await c.w.call(createConfirmEmailToken(c.deps) as any, { body: { token_hash: hash, type: 'invite' } });
    expect(opened.status).toBe(200);
    expect(opened.body.session).toMatchObject({ kind: 'tenant_staff', state: 'password_setup' });
    expect(c.w.store.committed('insertSession')[0]!.arg).toMatchObject({ tenantId: id, state: 'password_setup' });

    // 3 set the password: invitation accepted (it is still `pending`: no worker ran), membership active with accepted_at
    const set = await c.w.call(createSetPasswordFromSetup(c.deps) as any, { token: opened.body.session_token, body: { new_password: GOOD_PW } });
    expect(set.status).toBe(200);
    expect(c.w.store.eventsOf('invite_accepted')).toHaveLength(1);
    expect(c.f.data(id).members[0]).toMatchObject({ status: 'active', accepted: true });
    expect(c.f.data(id).invitations[0]).toMatchObject({ status: 'accepted' });

    // 4 login stays refused while the tenant is provisioning (auth.service unchanged), and creates no session
    const before = c.aw.repo.by('insertSession').length;
    expect((await trejection(c.login())).code).toBe('identity.tenant_suspended');
    expect(c.aw.repo.by('insertSession')).toHaveLength(before);

    // 5 activate: the readiness gate now passes (accepted tenant_admin + active branch + active centre)
    const act = await c.svc.activateTenant(c.ctx(), { tenantId: id, expectedVersion: p.version });
    expect(act.body.status).toBe('active'); expect(c.f.tenant(id)!.status).toBe('active');

    // 6 login with the password just set: 200, tenant_staff session of the new tenant
    const out = await c.login();
    expect(out.status).toBe(200); expect(out.body.session).toMatchObject({ kind: 'tenant_staff' });
    expect(c.aw.repo.by('insertSession').at(-1)).toMatchObject({ tenantId: id, kind: 'tenant_staff' });
  });

  it('GUARD (passes today): from a setup session in the provisioning tenant, set password -> activate -> login works; this pins everything after the link step', async () => {
    const c = await chainWorld(); const p = await c.svc.provisionTenant(c.ctx(), PROVISION); const id = p.body.tenant_id as string;
    const member = c.f.data(id).members[0]!; const token = 'S' + 'a'.repeat(42); const at = new Date(c.w.clock.ms + 900_000);
    expect((await c.w.gw.verifyEmailToken(c.w.fake!.mailbox.latestTokenHash(EMAIL, 'invite')!, 'invite')).ok).toBe(true);   // what the link step does at GoTrue (confirms the address)
    // the session exactly as confirmEmailToken leaves it (password_setup, bound to the membership of the DEFINER row)
    await c.w.store.repo.insertSession({}, { id: 'a0a0a0a0-0000-7000-8000-000000000001', userId: member.user_id, tenantId: id, membershipId: member.id, kind: 'tenant_staff', platformStaffId: null,
      state: 'password_setup', aal: 'aal1', accessToken: 'x', refreshToken: 'y', tokenSha256: createHash('sha256').update(token).digest(), idleExpiresAt: at, absoluteExpiresAt: at });
    expect((await c.w.call(createSetPasswordFromSetup(c.deps) as any, { token, body: { new_password: GOOD_PW } })).status).toBe(200);
    expect(member).toMatchObject({ status: 'active', accepted: true });
    expect((await trejection(c.login())).code).toBe('identity.tenant_suspended');
    expect((await c.svc.activateTenant(c.ctx(), { tenantId: id, expectedVersion: p.version })).body.status).toBe('active');
    expect((await c.login()).status).toBe(200);
  });

  it('activation stays refused while the admin has NOT accepted (opening the link alone is not enough)', async () => {
    const c = await chainWorld(); const p = await c.svc.provisionTenant(c.ctx(), PROVISION); const id = p.body.tenant_id as string;
    const opened = await c.w.call(createConfirmEmailToken(c.deps) as any, { body: { token_hash: c.w.fake!.mailbox.latestTokenHash(EMAIL, 'invite'), type: 'invite' } });
    expect(opened.status).toBe(200);
    expect(c.f.data(id).members[0]).toMatchObject({ status: 'invited', accepted: false });
    expect((await trejection(c.svc.activateTenant(c.ctx(), { tenantId: id, expectedVersion: p.version }))).code).toBe('identity.tenant_not_ready');
  });

  it('the invite link of a SUSPENDED tenant is still refused (activation does not open the door for other states)', async () => {
    const c = await chainWorld(); const p = await c.svc.provisionTenant(c.ctx(), PROVISION); const id = p.body.tenant_id as string;
    c.f.tenant(id)!.status = 'suspended';
    const e = await trejection(c.w.call(createConfirmEmailToken(c.deps) as any, { body: { token_hash: c.w.fake!.mailbox.latestTokenHash(EMAIL, 'invite'), type: 'invite' } }));
    expect(e.code).toBe('auth.invite_invalid');
  });

  it('a recovery link of the still provisioning tenant is refused with the recovery code (type recovery requires an active tenant)', async () => {
    const c = await chainWorld(); const p = await c.svc.provisionTenant(c.ctx(), PROVISION); const id = p.body.tenant_id as string;
    c.f.data(id).members[0]!.status = 'active'; c.f.data(id).members[0]!.accepted = true;   // an accepted admin of a tenant not yet activated
    await c.w.gw.sendRecovery(EMAIL, '/auth/confirm');
    const e = await trejection(c.w.call(createConfirmEmailToken(c.deps) as any, { body: { token_hash: c.w.fake!.mailbox.latestTokenHash(EMAIL, 'recovery'), type: 'recovery' } }));
    expect(e.code).toBe('auth.reset_token_invalid');
  });
});
