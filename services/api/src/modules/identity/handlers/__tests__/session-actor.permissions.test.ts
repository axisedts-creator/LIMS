// AUTH-ACTOR-2 (LD-222, AUTH-SENSITIVE; C2 02-TRD SessionState + s7.4; 01-PRD platform roles; C0 CR T0D-14; 08 A28.1). The six handlers that answer SessionState / LoginResult:
//   loginStaff, resolveSession, verifyMfaChallenge, completeMfaEnrolment, setPasswordFromSetup, confirmEmailToken  (loginPartner / resolveSession-partner / patient / mobile: report-only, not tested here)
// RULES under test: body.actor (SessionState.actor) is present in all six; body.actor.permissions is present ONLY when the session state is 'active' (tenant: the membershipPermissions read inside the
// request's tenant-bound tx; platform: permissionsOfRoles(actor roles)); never in password_setup / mfa_pending / mfa_enrolment_required; a failed read is common.internal and never an empty list;
// setPasswordFromSetup / confirmEmailToken load the actor BEFORE any write that cannot be undone; the list is never logged.
// Seams (fixed in the helper files, additive; the writer matches them or raises a dispute):
//   repo.membershipPermissions(tx, { tenantId, membershipId }) -> string[]   on AuthRepo, SessionRepo / MfaRepo (fakes: auth.helpers makeRepo().perms, session.helpers store.perms, mfa.helpers store.perms, recovery.helpers store.perms)
//   repo.sessionActor(tx, { userId, tenantId|null, membershipId|null }) on the setPasswordFromSetup / confirmEmailToken repo too (recovery.helpers store.actor)
//   loadSessionActor(lookup, key, log, requestId, perms?: { state, tenantPermissions(membershipId) })  (service/__tests__/session-actor.permissions.test.ts)
// Expected now: every body test fails (no `permissions`; setPasswordFromSetup / confirmEmailToken bodies have no `actor` at all).
import { describe, expect, it } from 'vitest';
import { permissionsOfRoles } from '../../domain/permission-set.js';
import { createAuthService } from '../../service/auth.service.js';
import { EMAIL, PASSWORD, SUB, TENANT_PERMS, makeWorld as makeAuthWorld, platformRow, tenantActorRow, tenantRow, type WorldT } from '../../service/__tests__/auth.helpers.js';
import { createResolveSession } from '../resolveSession.js';
import { createCompleteMfaEnrolment } from '../completeMfaEnrolment.js';
import { createConfirmEmailToken } from '../confirmEmailToken.js';
import { createSetPasswordFromSetup } from '../setPasswordFromSetup.js';
import { createStartMfaEnrolment } from '../startMfaEnrolment.js';
import { createVerifyMfaChallenge } from '../verifyMfaChallenge.js';
import { GOOD_PW, MEMB_A, TENANT_A, makeWorld as makeRecoveryWorld, rejection, type World } from './recovery.helpers.js';
import { makeMfaWorld, totp, type MfaWorld } from './mfa.helpers.js';
import { makeSessionWorld, type SessionWorld } from './session.helpers.js';

const PLATFORM_PERMS = permissionsOfRoles(['platform_support']);
const TENANT_ACTOR = { display_name: 'Ana Demo', roles: ['lab_manager', 'technician'], tenant_code: 'lab_a' };
const PLATFORM_ACTOR = { display_name: 'Sam Staff', roles: ['platform_support'] };
const NOT_ACTIVE = ['password_setup', 'mfa_pending', 'mfa_enrolment_required'];
const GOOD = { email: EMAIL, password: PASSWORD };
const SENTINELS = ['zz.sentinel.alpha', 'zz.sentinel.beta'];
const boom = () => { throw new Error('connection reset by peer'); };
const logged = (w: { log: { info: { mock: { calls: unknown[] } }; warn: { mock: { calls: unknown[] } }; error: { mock: { calls: unknown[] } } } }) => JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls]);
const sameTx = (a: { tx: unknown }, b: { tx: unknown }) => a.tx === b.tx && a.tx !== undefined;

// ================================================================================================================================ loginStaff
const loginStaff = (w: WorldT) => { const k = w.makeCtx(); return { ...k, run: () => createAuthService(w.deps as any).loginStaff(k.ctx, GOOD as any) as Promise<any> }; };

describe('loginStaff: permissions only for an active tenant session', () => {
  it('tenant, state active: actor.permissions = the membershipPermissions read for (tenant, membership), read in the SAME tx as the actor lookup', async () => {
    const w = makeAuthWorld({ rows: { [SUB]: tenantRow() } }); const r = await loginStaff(w).run();
    expect(r.body.session).toMatchObject({ kind: 'tenant_staff', state: 'active' });
    expect(r.body.session.actor).toEqual({ ...TENANT_ACTOR, permissions: TENANT_PERMS });
    expect(w.repo.perms.calls).toHaveLength(1); expect(w.repo.perms.calls[0]).toMatchObject({ tenantId: TENANT_A, membershipId: MEMB_A });
    expect(sameTx(w.repo.perms.calls[0]!, w.repo.actor.calls[0]!)).toBe(true);
    expect(w.repo.writes.map((x) => x.m)).not.toContain('membershipPermissions');   // a read, never a write
  });
  it('tenant, mfa_pending (verified factor) and mfa_enrolment_required: actor yes, permissions key absent, no read at all', async () => {
    for (const [o, state] of [[{ mfa_required: true, has_verified_factor: true }, 'mfa_pending'], [{ mfa_required: true, has_verified_factor: false }, 'mfa_enrolment_required']] as const) {
      const w = makeAuthWorld({ rows: { [SUB]: tenantRow(o) } }); const r = await loginStaff(w).run();
      expect(r.body.session.state).toBe(state); expect(r.body.session.actor).toEqual(TENANT_ACTOR); expect(Object.keys(r.body.session.actor)).not.toContain('permissions');
      expect(w.repo.perms.calls).toHaveLength(0);
    }
  });
  it('platform login is never active (aal1): actor yes, permissions key absent, no read', async () => {
    for (const has_verified_factor of [false, true]) {
      const w = makeAuthWorld({ rows: { [SUB]: platformRow({ has_verified_factor }) } }); const r = await loginStaff(w).run();
      expect(NOT_ACTIVE).toContain(r.body.session.state); expect(r.body.session.actor).toEqual(PLATFORM_ACTOR); expect(Object.keys(r.body.session.actor)).not.toContain('permissions');
      expect(w.repo.perms.calls).toHaveLength(0);
    }
  });
  it('a failed read for an active tenant login is common.internal: no 200, commitOnError not called, nothing of the login survives, the list is not in the log', async () => {
    const w = makeAuthWorld({ rows: { [SUB]: tenantRow() } }); w.repo.perms.impl = boom; const k = loginStaff(w);
    const e = await rejection(k.run());
    expect(e.code).toBe('common.internal'); expect(k.commitOnError).not.toHaveBeenCalled();
    expect(logged(w)).not.toMatch(/lab\.result/);
  });
  it('a read that yields a non-array is the same failure (never permissions: [])', async () => {
    const w = makeAuthWorld({ rows: { [SUB]: tenantRow() } }); w.repo.perms.impl = () => undefined;
    expect((await rejection(loginStaff(w).run())).code).toBe('common.internal');
  });
  it('a failed or blocked login does no permission read (no extra DB read, no oracle)', async () => {
    const w = makeAuthWorld({ rows: { [SUB]: tenantRow() } }); const k = w.makeCtx();
    await rejection(createAuthService(w.deps as any).loginStaff(k.ctx, { email: EMAIL, password: 'wrong-password' } as any));
    for (const o of [{ membership_status: 'deactivated' }, { membership_locked: true }, { tenant_status: 'suspended' }]) { const b = makeAuthWorld({ rows: { [SUB]: tenantRow(o) } }); await rejection(loginStaff(b).run()); expect(b.repo.perms.calls).toHaveLength(0); }
    expect(w.repo.perms.calls).toHaveLength(0);
  });
  it('the permission list never reaches the log of a successful login', async () => {
    const w = makeAuthWorld({ rows: { [SUB]: tenantRow() } }); w.repo.perms.impl = () => SENTINELS; await loginStaff(w).run();
    expect(logged(w)).not.toContain('zz.sentinel');
  });
});

// ================================================================================================================================ resolveSession
const resolve = async (w: SessionWorld, a: { token: string; key?: string }) => {
  const { hctx, commitOnError } = w.makeHctx(a.key ? { bffKey: a.key } : {});
  return { commitOnError, run: () => createResolveSession(w.deps as any)(w.req({ token: a.token, body: { touch: false } }) as any, hctx) as Promise<any> };
};

describe('resolveSession: permissions only for an active session, read in the request tx', () => {
  it('tenant_staff active: actor.permissions = the read for (tenant, membership of the stored session), same tx as the actor lookup, still no write', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession(); const out = await (await resolve(w, { token })).run();
    expect(out.body.session.state).toBe('active'); expect(out.body.session.actor).toEqual({ ...TENANT_ACTOR, permissions: TENANT_PERMS });
    expect(w.store.perms.calls).toHaveLength(1); expect(w.store.perms.calls[0]).toMatchObject({ tenantId: TENANT_A, membershipId: MEMB_A });
    expect(sameTx(w.store.perms.calls[0]!, w.store.actor.calls[0]!)).toBe(true);
    expect(w.store.committed()).toHaveLength(0);
  });
  it('platform active: actor.permissions = permissionsOfRoles(actor roles), contains platform.tenant.read, no tenant read', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ kind: 'platform' }); const out = await (await resolve(w, { token })).run();
    expect(out.body.session.actor).toEqual({ ...PLATFORM_ACTOR, permissions: PLATFORM_PERMS }); expect(out.body.session.actor.permissions).toContain('platform.tenant.read');
    expect(w.store.perms.calls).toHaveLength(0);
  });
  it.each(NOT_ACTIVE)('state %s (tenant and platform): actor yes, permissions key absent, no read', async (state) => {
    const w = await makeSessionWorld();
    for (const kind of ['tenant_staff', 'platform'] as const) {
      const { token } = w.addSession({ kind, state }); const out = await (await resolve(w, { token })).run();
      expect(out.body.session.state).toBe(state); expect(out.body.session.actor.display_name).toBeTruthy(); expect(Object.keys(out.body.session.actor)).not.toContain('permissions');
    }
    expect(w.store.perms.calls).toHaveLength(0);
  });
  it('a failed read is common.internal: nothing committed, commitOnError not called, and the GoTrue refresh never ran (no rotated refresh token is lost)', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ accessExpiresAt: new Date(w.clock.ms + 30_000) });   // inside the 120 s refresh window
    w.store.perms.impl = boom; const { run, commitOnError } = await resolve(w, { token }); const e = await rejection(run());
    expect(e.code).toBe('common.internal'); expect(w.store.committed()).toHaveLength(0); expect(commitOnError).not.toHaveBeenCalled(); expect(w.gw.calls).toHaveLength(0);
    expect(logged(w)).not.toMatch(/lab\.result/);
  });
  it('a dead, unknown or wrong-family session answers its 401 BEFORE any permission read', async () => {
    const w = await makeSessionWorld(); const revoked = w.addSession({ state: 'revoked' }); const live = w.addSession({ kind: 'platform' });
    for (const [t, k] of [[revoked.token, undefined], ['x'.repeat(43), undefined], [live.token, 'partner']] as const) {
      expect((await rejection((await resolve(w, { token: t, ...(k ? { key: k } : {}) })).run())).code).toBe('auth.session_expired');
    }
    expect(w.store.perms.calls).toHaveLength(0);
  });
  it('exactly one permission read per 200, also when the access token is refreshed', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ accessExpiresAt: new Date(w.clock.ms + 30_000) }); await (await resolve(w, { token })).run();
    expect(w.store.perms.calls).toHaveLength(1);
  });
});

// ================================================================================================================================ verifyMfaChallenge / completeMfaEnrolment
const verify = async (w: MfaWorld, token: string, code: string) => { const { hctx, commitOnError } = w.makeHctx({ operationId: 'verifyMfaChallenge' }); return { commitOnError, run: () => (createVerifyMfaChallenge(w.deps as any) as any)(w.req({ token, body: { code } }), hctx) as Promise<any> }; };
const start = async (w: MfaWorld, token: string) => { const { hctx } = w.makeHctx({ operationId: 'startMfaEnrolment' }); return (createStartMfaEnrolment(w.deps as any) as any)(w.req({ token, body: {} }), hctx); };
const complete = async (w: MfaWorld, token: string, factorId: string, code: string) => {
  const { hctx, commitOnError } = w.makeHctx({ operationId: 'completeMfaEnrolment' });
  return { commitOnError, run: () => (createCompleteMfaEnrolment(w.deps as any) as any)(w.req({ token, body: { code }, params: { factor_id: factorId } }), hctx) as Promise<any> };
};
async function enrolling(kind: 'platform' | 'tenant_staff', state = 'mfa_enrolment_required') {
  const w = await makeMfaWorld({ kind }); const a = await w.addSession({ state }); const s = await start(w, a.token); return { w, a, s, code: () => totp(s.body.secret_base32) };
}
const verifies = (w: MfaWorld) => w.calls.filter((c) => c.method === 'mfaChallengeAndVerify');

describe('verifyMfaChallenge: the 200 is active, so it carries permissions', () => {
  it('tenant: actor + permissions from the read (tenant, membership of the session), same tx as the actor lookup', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true }); const r = await (await verify(w, a.token, totp(a.secret!))).run();
    expect(r.status).toBe(200); expect(r.body.state).toBe('active'); expect(r.body.actor).toEqual({ ...TENANT_ACTOR, permissions: TENANT_PERMS });
    expect(w.store.perms.calls).toHaveLength(1); expect(w.store.perms.calls[0]).toMatchObject({ tenantId: TENANT_A, membershipId: MEMB_A });
    expect(w.store.actor.keys[0]).toMatchObject({ userId: a.userId, tenantId: TENANT_A, membershipId: MEMB_A });
  });
  it('platform: actor + permissionsOfRoles(actor roles), no tenant read', async () => {
    const w = await makeMfaWorld({ kind: 'platform' }); const a = await w.addSession({ verifiedFactor: true }); const r = await (await verify(w, a.token, totp(a.secret!))).run();
    expect(r.body.actor).toEqual({ ...PLATFORM_ACTOR, permissions: PLATFORM_PERMS }); expect(w.store.perms.calls).toHaveLength(0);
  });
  it('fail closed BEFORE the GoTrue code check: a failed read is common.internal, the code is not consumed, the session stays mfa_pending, nothing committed', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true }); w.store.perms.impl = boom;
    const { run, commitOnError } = await verify(w, a.token, totp(a.secret!)); const e = await rejection(run());
    expect(e.code).toBe('common.internal'); expect(verifies(w)).toHaveLength(0); expect(commitOnError).not.toHaveBeenCalled();
    expect(w.store.byId(a.row.sessionId)!.state).toBe('mfa_pending'); expect(w.store.committed()).toHaveLength(0);
    expect(logged(w)).not.toMatch(/lab\.result/);
  });
  it('a wrong code answers auth.mfa_invalid and its body carries no permissions', async () => {
    const w = await makeMfaWorld(); const a = await w.addSession({ verifiedFactor: true }); const e = await rejection((await verify(w, a.token, '000000')).run());
    expect(e.code).toBe('auth.mfa_invalid'); expect(JSON.stringify(e)).not.toMatch(/permissions|lab\.result/);
  });
});

describe('completeMfaEnrolment: the 200 is active, so it carries permissions (login-completing and voluntary enrolment)', () => {
  it.each(['mfa_enrolment_required', 'active'])('tenant, session state %s before the call: actor + permissions', async (state) => {
    const { w, a, s, code } = await enrolling('tenant_staff', state); const r = await (await complete(w, a.token, s.body.factor_id, code())).run();
    expect(r.status).toBe(200); expect(r.body.state).toBe('active'); expect(r.body.actor).toEqual({ ...TENANT_ACTOR, permissions: TENANT_PERMS });
    expect(w.store.perms.calls).toHaveLength(1); expect(w.store.perms.calls[0]).toMatchObject({ tenantId: TENANT_A, membershipId: MEMB_A });
  });
  it('platform: actor + permissionsOfRoles(actor roles) (platform.tenant.read among them), no tenant read', async () => {
    const { w, a, s, code } = await enrolling('platform'); const r = await (await complete(w, a.token, s.body.factor_id, code())).run();
    expect(r.body.actor).toEqual({ ...PLATFORM_ACTOR, permissions: PLATFORM_PERMS }); expect(r.body.actor.permissions).toContain('platform.tenant.read'); expect(w.store.perms.calls).toHaveLength(0);
  });
  it('tenant: a failed read is common.internal BEFORE the GoTrue code check: code not consumed, factor stays unverified, session stays enrolment-required, nothing committed', async () => {
    const { w, a, s, code } = await enrolling('tenant_staff'); w.store.perms.impl = boom;
    const c = await complete(w, a.token, s.body.factor_id, code()); const e = await rejection(c.run());
    expect(e.code).toBe('common.internal'); expect(verifies(w)).toHaveLength(0); expect(c.commitOnError).not.toHaveBeenCalled();
    expect(w.store.factors.find((f) => f.id === s.body.factor_id)!.status).toBe('unverified'); expect(w.store.byId(a.row.sessionId)!.state).toBe('mfa_enrolment_required');
    expect(w.store.committed('markFactorVerified')).toHaveLength(0); expect(logged(w)).not.toMatch(/lab\.result/);
  });
  it('platform: a broken tenant read cannot matter (the platform set comes from the registry, no tenant read is made): still a 200 with the registry set', async () => {
    const { w, a, s, code } = await enrolling('platform'); w.store.perms.impl = boom;
    const r = await (await complete(w, a.token, s.body.factor_id, code())).run(); expect(r.body.actor.permissions).toEqual(PLATFORM_PERMS);
  });
});

// ================================================================================================================================ setPasswordFromSetup
type W = World;
const handler = (w: W, over: Record<string, unknown> = {}) => createSetPasswordFromSetup({ ...w.deps, ...over } as any) as any;
const setPw = (w: W, token: string, over: Record<string, unknown> = {}) => w.call(handler(w, over), { token, body: { new_password: GOOD_PW } });
/** GoTrue update that leaves a mark in store.order, so the tests can say what happened before the irreversible step */
const marked = (w: W) => ({ gotrue: { adminUpdatePassword: async (u: string, p: string) => { w.store.order.push('gotrue:adminUpdatePassword'); return w.gotrue.adminUpdatePassword(u, p); } } });
const pwUpdates = (w: W) => w.calls.filter((c) => c.method === 'adminUpdatePassword');
const idx = (w: W, m: string) => w.store.order.indexOf(m);

describe('setPasswordFromSetup: the 200 body carries actor (it did not) and permissions only when the new state is active', () => {
  it('tenant, new state active: actor + permissions; keys (userId, tenant, membership) come from the SESSION row, never the request', async () => {
    const w = await makeRecoveryWorld(); const s = await w.addSetupSession(); const r = await setPw(w, s.token);
    expect(r.status).toBe(200); expect(r.body.state).toBe('active'); expect(r.body.actor).toEqual({ ...TENANT_ACTOR, permissions: TENANT_PERMS });
    expect(w.store.actor.calls).toHaveLength(1); expect(w.store.actor.calls[0]).toMatchObject({ userId: s.userId, tenantId: TENANT_A, membershipId: MEMB_A });
    expect(w.store.perms.calls).toHaveLength(1); expect(w.store.perms.calls[0]).toMatchObject({ tenantId: TENANT_A, membershipId: MEMB_A }); expect(sameTx(w.store.perms.calls[0]!, w.store.actor.calls[0]!)).toBe(true);
  });
  it.each([
    ['tenant, verified factor -> mfa_pending', { row: tenantRow({ has_verified_factor: true }) }, 'mfa_pending'],
    ['tenant, mfa required -> mfa_enrolment_required', { row: tenantRow({ mfa_required: true }) }, 'mfa_enrolment_required'],
  ])('%s: actor yes, NO permissions key, no read', async (_n, o, state) => {
    const w = await makeRecoveryWorld(); const s = await w.addSetupSession(o as any); const r = await setPw(w, s.token);
    expect(r.body.state).toBe(state); expect(r.body.actor).toEqual(TENANT_ACTOR); expect(Object.keys(r.body.actor)).not.toContain('permissions'); expect(w.store.perms.calls).toHaveLength(0);
  });
  it('platform (always MFA, A28.1): actor { display_name, roles } looked up for (user, null, null); NO permissions key; no tenant read', async () => {
    const w = await makeRecoveryWorld(); const s = await w.addSetupSession({ kind: 'platform' }); const r = await setPw(w, s.token);
    expect(NOT_ACTIVE).toContain(r.body.state); expect(r.body.actor).toEqual(PLATFORM_ACTOR);
    expect(w.store.actor.calls[0]).toMatchObject({ userId: s.userId, tenantId: null, membershipId: null }); expect(w.store.perms.calls).toHaveLength(0);
  });
  it('only display_name / roles / tenant_code / permissions leave: a hostile actor row cannot add an e-mail, id or token', async () => {
    const w = await makeRecoveryWorld(); const s = await w.addSetupSession(); w.store.actor.impl = () => tenantActorRow({ email: 'leak.me@example.test', user_id: 'USER-ID-LEAK', access_token: 'TOKEN-LEAK' });
    const r = await setPw(w, s.token); expect(Object.keys(r.body.actor).sort()).toEqual(['display_name', 'permissions', 'roles', 'tenant_code']);
    for (const bad of ['leak.me', 'USER-ID-LEAK', 'TOKEN-LEAK', s.email, s.userId, s.token]) expect(JSON.stringify(r.body)).not.toContain(bad);
  });
});

describe('setPasswordFromSetup: the actor and the permissions are loaded BEFORE the irreversible GoTrue password change (the live 500 after a committed change)', () => {
  it('order: sessionActor (and the permission read) precede gotrue.adminUpdatePassword and acceptInvitation', async () => {
    const w = await makeRecoveryWorld(); const s = await w.addSetupSession({ invite: true }); await setPw(w, s.token, marked(w));
    const g = idx(w, 'gotrue:adminUpdatePassword'); expect(g).toBeGreaterThanOrEqual(0);
    expect(idx(w, 'sessionActor')).toBeGreaterThanOrEqual(0); expect(idx(w, 'sessionActor')).toBeLessThan(g);
    expect(idx(w, 'membershipPermissions')).toBeGreaterThanOrEqual(0); expect(idx(w, 'membershipPermissions')).toBeLessThan(g);
    expect(idx(w, 'sessionActor')).toBeLessThan(idx(w, 'acceptInvitation'));
  });
  it('no actor row: common.internal and GoTrue is NEVER called (the old password still works, the invitation is not accepted, nothing committed)', async () => {
    const w = await makeRecoveryWorld(); const s = await w.addSetupSession({ invite: true }); w.store.actor.impl = () => undefined;
    const e = await rejection(setPw(w, s.token, marked(w)));
    expect(e.code).toBe('common.internal'); expect(pwUpdates(w)).toEqual([]); expect(w.store.committed()).toHaveLength(0); expect(w.store.committed('acceptInvitation')).toHaveLength(0);
    expect((await w.gw.signInWithPassword(s.email, s.password)).ok).toBe(true);
  });
  it('failed permission read for a tenant that ends active: common.internal, GoTrue NEVER called, old password still works, nothing committed, list not logged', async () => {
    const w = await makeRecoveryWorld(); const s = await w.addSetupSession({ invite: true }); w.store.perms.impl = boom;
    const e = await rejection(setPw(w, s.token, marked(w)));
    expect(e.code).toBe('common.internal'); expect(pwUpdates(w)).toEqual([]); expect(w.store.committed()).toHaveLength(0);
    expect((await w.gw.signInWithPassword(s.email, s.password)).ok).toBe(true); expect(logged(w)).not.toMatch(/lab\.result/);
  });
  it('a dead / unknown / wrong-state session answers its 401/409 before any actor or permission read', async () => {
    const w = await makeRecoveryWorld(); const s = await w.addSetupSession({ state: 'active' });
    await rejection(setPw(w, s.token)); await rejection(setPw(w, 'x'.repeat(43)));
    expect(w.store.actor.calls).toHaveLength(0); expect(w.store.perms.calls).toHaveLength(0);
  });
  it('the permission list never reaches the log of a successful set-password', async () => {
    const w = await makeRecoveryWorld(); const s = await w.addSetupSession(); w.store.perms.impl = () => SENTINELS; await setPw(w, s.token);
    expect(logged(w)).not.toContain('zz.sentinel');
  });
});

// ================================================================================================================================ confirmEmailToken
const confirm = (w: W, hash: string, type: 'recovery' | 'invite' = 'recovery') => w.call(createConfirmEmailToken(w.deps as any) as any, { body: { token_hash: hash, type } });
const recoveryLink = async (w: W, row?: any) => { const u = await w.addUser(row ? { row } : {}); await w.gw.sendRecovery(u.email, '/auth/confirm'); return { ...u, hash: w.fake!.mailbox.latestTokenHash(u.email, 'recovery')! }; };

describe('confirmEmailToken: the body carries actor (it did not) and NEVER permissions (the session is password_setup)', () => {
  it('tenant: session.actor = { display_name, roles, tenant_code }; looked up for (user, tenant, membership) of the DEFINER row; the permission read is not made', async () => {
    const w = await makeRecoveryWorld(); const l = await recoveryLink(w); const r = await confirm(w, l.hash);
    expect(r.status).toBe(200); expect(r.body.session).toMatchObject({ kind: 'tenant_staff', state: 'password_setup' });
    expect(r.body.session.actor).toEqual(TENANT_ACTOR); expect(Object.keys(r.body.session.actor)).not.toContain('permissions'); expect(JSON.stringify(r.body)).not.toContain('permissions');
    expect(w.store.actor.calls).toHaveLength(1); expect(w.store.actor.calls[0]).toMatchObject({ userId: l.userId, tenantId: TENANT_A, membershipId: MEMB_A });
    expect(w.store.perms.calls).toHaveLength(0);
  });
  it('platform: session.actor = { display_name, roles } for (user, null, null); no permissions; no tenant read', async () => {
    const w = await makeRecoveryWorld(); const l = await recoveryLink(w, platformRow()); const r = await confirm(w, l.hash);
    expect(r.body.session).toMatchObject({ kind: 'platform', state: 'password_setup' }); expect(r.body.session.actor).toEqual(PLATFORM_ACTOR);
    expect(w.store.actor.calls[0]).toMatchObject({ userId: l.userId, tenantId: null, membershipId: null }); expect(w.store.perms.calls).toHaveLength(0);
  });
  it('the invite type carries the actor too', async () => {
    const w = await makeRecoveryWorld(); const email = `inv-${Math.random().toString(36).slice(2, 8)}@lims-test.example`; await w.gw.sendInvite(email, '/auth/confirm');
    const f = await w.gw.adminFindUserByEmail(email); w.store.ctxRows.set(f!.userId, tenantRow());
    const r = await confirm(w, w.fake!.mailbox.latestTokenHash(email, 'invite')!, 'invite'); expect(r.body.session.actor).toEqual(TENANT_ACTOR);
  });
  it('actor is loaded after the DEFINER context read and BEFORE every DB write of the request (insertSession / insertPlatformSession / auth event)', async () => {
    for (const row of [undefined, platformRow()]) {
      const w = await makeRecoveryWorld(); const l = await recoveryLink(w, row); await confirm(w, l.hash);
      const a = idx(w, 'sessionActor'); expect(a).toBeGreaterThan(idx(w, 'loginContext'));
      for (const m of ['insertSession', 'insertPlatformSession', 'recordTenant', 'recordTenantless']) { const i = idx(w, m); if (i >= 0) expect(a, m).toBeLessThan(i); }
    }
  });
  it('no actor row: common.internal, nothing committed (no session, no event)', async () => {
    for (const row of [undefined, platformRow()]) {
      const w = await makeRecoveryWorld(); const l = await recoveryLink(w, row); w.store.actor.impl = () => undefined;
      const e = await rejection(confirm(w, l.hash)); expect(e.code).toBe('common.internal');
      expect(w.store.committed()).toHaveLength(0); expect(w.store.sessions.size).toBe(0);
    }
  });
  it('an invalid link answers its same 400 and does no actor lookup: unknown / reused token, and an unusable account (suspended tenant)', async () => {
    const w = await makeRecoveryWorld(); const l = await recoveryLink(w); await confirm(w, l.hash); w.store.actor.calls.length = 0;
    expect((await rejection(confirm(w, l.hash))).code).toBe('auth.reset_token_invalid');
    expect((await rejection(confirm(w, 'x'.repeat(43)))).code).toBe('auth.reset_token_invalid');
    const w2 = await makeRecoveryWorld(); const l2 = await recoveryLink(w2, tenantRow({ tenant_status: 'suspended' }));
    expect((await rejection(confirm(w2, l2.hash))).code).toBe('auth.reset_token_invalid');
    expect(w.store.actor.calls).toHaveLength(0); expect(w2.store.actor.calls).toHaveLength(0);
  });
  it('the body holds no e-mail or id beyond what SessionState defines', async () => {
    const w = await makeRecoveryWorld(); const l = await recoveryLink(w); w.store.actor.impl = () => tenantActorRow({ email: 'leak.me@example.test', user_id: 'USER-ID-LEAK' });
    const r = await confirm(w, l.hash); expect(Object.keys(r.body.session.actor).sort()).toEqual(['display_name', 'roles', 'tenant_code']);
    for (const bad of ['leak.me', 'USER-ID-LEAK', l.email, l.userId, String(TENANT_A), String(MEMB_A)]) expect(JSON.stringify(r.body)).not.toContain(bad);
  });
});
