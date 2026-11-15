// SESSION-ACTOR-1 (LD-208): every 200 body of loginStaff, loginPartner, openMobileSession (staff form) and resolveSession carries
// session.actor { display_name, roles, tenant_code only for a tenant session } built from app.identity_session_actor; no row => common.internal, never a 200 without actor.
// Seams (the writer must match them): repo.sessionActor(tx, { userId, tenantId: string|null, membershipId: string|null }) -> one row { display_name, role_codes, tenant_code } | undefined
//   on BOTH the auth repo (AuthRepo, auth-events.repo.ts) and the session repo (SessionRepo, mfa.repo.ts); the service maps role_codes -> roles. Fakes: auth.helpers.ts / session.helpers.ts (`actor`).
// Expected now: every success-path test fails (the body has no `actor`); the fail-closed tests fail because a 200 is returned without actor.
import { describe, expect, it } from 'vitest';
import { createAuthService } from '../../service/auth.service.js';
import { createLoginPartner } from '../loginPartner.js';
import { createOpenMobileSession } from '../openMobileSession.js';
import { createResolveSession } from '../resolveSession.js';
import { permissionsOfRoles } from '../../domain/permission-set.js';
import { ACCESS, EMAIL, PASSWORD, REFRESH, STAFF_ID, SUB, TENANT_PERMS, platformActorRow, platformRow, tenantActorRow, tenantRow, type WorldT } from '../../service/__tests__/auth.helpers.js';
import { APP_INSTANCE, MEMB_A, TENANT_A, loginRunner, makeWorld, partnerRow, rejection, staffRow } from './kinds.helpers.js';
import { makeSessionWorld, type SessionWorld } from './session.helpers.js';

const GOOD = { email: EMAIL, password: PASSWORD };
const MOBILE_BODY = { ...GOOD, app_instance_id: APP_INSTANCE, app_platform: 'android' };
/** the only keys an actor may ever carry (contracts/openapi/identity.yaml SessionState.actor; support_session is never filled here) */
const ACTOR_KEYS = ['display_name', 'roles', 'tenant_code'];
/** LD-222: ONLY an ACTIVE body (decided by the RESPONSE state) may also carry `permissions`; pre-MFA / partner bodies keep ACTOR_KEYS */
const ACTIVE_KEYS = [...ACTOR_KEYS, 'permissions'];
const TENANT_ACTOR = { display_name: 'Ana Demo', roles: ['lab_manager', 'technician'], tenant_code: 'lab_a' };
const PLATFORM_ACTOR = { display_name: 'Sam Staff', roles: ['platform_support'] };
/** exact lists: tenant = the membershipPermissions fake seam (TENANT_PERMS); platform = permissionsOfRoles(actor roles) */
const PLATFORM_PERMS = permissionsOfRoles(['platform_support']);
/** extra columns a (buggy or future) DEFINER row could carry: none of them may reach the body */
const HOSTILE = { email: 'leak.me@example.test', user_id: 'USER-ID-LEAK', membership_id: 'MEMB-ID-LEAK', id: 'ID-LEAK', access_token: 'TOKEN-LEAK', password_hash: 'HASH-LEAK' };

const loginStaff = (w: WorldT, c: Record<string, unknown> = {}) => { const k = w.makeCtx(c); return { ...k, run: () => createAuthService(w.deps as any).loginStaff(k.ctx, GOOD as any) }; };
const runPartner = (w: WorldT) => { const r = loginRunner(w, 'partner'); return { ...r, call: () => createLoginPartner(w.deps as any)(r.req(GOOD) as any, r.hctx) }; };
function mobile(row = staffRow()) {
  const w = makeWorld({ rows: { [SUB]: row } });
  const deps = { ...w.deps, now: () => new Date(w.clock.ms), repo: { ...w.deps.repo, async membershipHasPermission() { return true; } } };
  const r = loginRunner(w, undefined);
  return { w, r, call: () => createOpenMobileSession(deps as any)(r.req(MOBILE_BODY) as any, r.hctx) };
}
const keys = (o: object) => Object.keys(o).sort();
const logged = (w: { log: { info: { mock: { calls: unknown[] } }; warn: { mock: { calls: unknown[] } }; error: { mock: { calls: unknown[] } } } }) => JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls]);

describe('loginStaff: platform login carries the platform actor (the live staging failure, request 01a1de0b-6c27-73c6-9a80-2556dc9350de)', () => {
  it('200 session.actor = { display_name, roles } mapped from role_codes; NO tenant_code key; looked up for (user, null, null)', async () => {
    const w = makeWorld({ rows: { [SUB]: platformRow({ has_verified_factor: false }) } }); const k = loginStaff(w);
    const r: any = await k.run();
    expect(r.status).toBe(200);
    expect(r.body.session).toMatchObject({ kind: 'platform', state: 'mfa_enrolment_required' });
    expect(r.body.session.actor).toEqual(PLATFORM_ACTOR);
    expect(keys(r.body.session.actor)).toEqual(['display_name', 'roles']);
    expect(w.repo.actor.calls).toHaveLength(1);
    expect(w.repo.actor.calls[0]).toMatchObject({ userId: SUB, tenantId: null, membershipId: null });
    expect(w.repo.writes.map((x) => x.m)).not.toContain('sessionActor');   // a read, not a write
  });
  it('actor is filled for every session state (mfa_pending too), not only the first one', async () => {
    const w = makeWorld({ rows: { [SUB]: platformRow({ has_verified_factor: true }) } });
    const r: any = await loginStaff(w).run();
    expect(r.body.session.state).toBe('mfa_pending'); expect(r.body.session.actor).toEqual(PLATFORM_ACTOR); expect(r.body.session.actor).not.toHaveProperty('permissions');
  });
  it('tenant_code is only for a tenant session: a platform row that (wrongly) carries a tenant_code does not put one in the body; no support_session either', async () => {
    const w = makeWorld({ rows: { [SUB]: platformRow() } }); w.repo.actor.impl = () => platformActorRow({ tenant_code: 'lab_a' });
    const r: any = await loginStaff(w).run();
    expect(r.body.session.actor).not.toHaveProperty('tenant_code'); expect(r.body.session.actor).not.toHaveProperty('support_session');
  });
});

describe('loginStaff: tenant login carries the tenant actor', () => {
  it('200 session.actor = { display_name, roles, tenant_code }; looked up for (user, tenant, membership) from app.identity_login_context', async () => {
    const w = makeWorld({ rows: { [SUB]: tenantRow() } });
    const r: any = await loginStaff(w).run();
    expect(r.status).toBe(200); expect(r.body.session).toMatchObject({ kind: 'tenant_staff', state: 'active' });
    expect(r.body.session.actor).toEqual({ ...TENANT_ACTOR, permissions: TENANT_PERMS });   // LD-222: active => permissions
    expect(w.repo.actor.calls).toHaveLength(1);
    expect(w.repo.actor.calls[0]).toMatchObject({ userId: SUB, tenantId: TENANT_A, membershipId: MEMB_A });
  });
  it('mfa_pending tenant session carries the actor too', async () => {
    const w = makeWorld({ rows: { [SUB]: tenantRow({ mfa_required: true, has_verified_factor: true }) } });
    const r: any = await loginStaff(w).run();
    expect(r.body.session.state).toBe('mfa_pending'); expect(r.body.session.actor).toEqual(TENANT_ACTOR); expect(r.body.session.actor).not.toHaveProperty('permissions');   // LD-222: no pre-MFA session learns its permission set
  });
  it('the tenant and membership of the lookup come from the DEFINER row, never from the request: a hostile input tenant is ignored', async () => {
    const w = makeWorld({ rows: { [SUB]: tenantRow() } }); const k = w.makeCtx();
    await createAuthService(w.deps as any).loginStaff(k.ctx, { ...GOOD, tenant_id: 'TENANT-FROM-INPUT', membership_id: 'MEMB-FROM-INPUT' } as any).catch(() => undefined);
    for (const c of w.repo.actor.calls) expect(c).toMatchObject({ tenantId: TENANT_A, membershipId: MEMB_A });
  });
});

describe('loginPartner and openMobileSession (staff form)', () => {
  it('loginPartner 200 carries { display_name, roles, tenant_code } for the partner membership', async () => {
    const w = makeWorld({ rows: { [SUB]: partnerRow() } }); const r = runPartner(w);
    const out: any = await r.call();
    expect(out.status).toBe(200); expect(out.body.session.kind).toBe('partner');
    expect(out.body.session.actor).toEqual(TENANT_ACTOR); expect(out.body.session.actor).not.toHaveProperty('permissions');   // LD-222: partner producers omit it
    expect(w.repo.actor.calls).toHaveLength(1); expect(w.repo.actor.calls[0]).toMatchObject({ userId: SUB, tenantId: TENANT_A, membershipId: MEMB_A });
  });
  it('openMobileSession 200 carries the actor inside body.session', async () => {
    const { w, call } = mobile();
    const out: any = await call();
    expect(out.status).toBe(200); expect(out.body.session.kind).toBe('staff_mobile');
    expect(out.body.session.actor).toEqual(TENANT_ACTOR); expect(out.body.session.actor).not.toHaveProperty('permissions');
    expect(w.repo.actor.calls).toHaveLength(1);
  });
});

describe('fail closed: no actor row => common.internal, never a 200 without actor', () => {
  it.each([['platform', platformRow()], ['tenant', tenantRow()]])('loginStaff %s: no row -> LimsError common.internal, a log line names the missing actor, commitOnError not called', async (_n, row) => {
    const w = makeWorld({ rows: { [SUB]: row as any } }); w.repo.actor.impl = () => undefined;
    const k = loginStaff(w); const e = await rejection(k.run());
    expect(e.code).toBe('common.internal');
    expect(k.commitOnError).not.toHaveBeenCalled();   // the transaction rolls back: nothing of this login survives
    expect(logged(w)).toMatch(/actor/i);
    expect(JSON.stringify(e)).not.toContain(SUB);
  });
  it('loginStaff: a lookup that returns null (not undefined) is the same no-row case', async () => {
    const w = makeWorld({ rows: { [SUB]: tenantRow() } }); w.repo.actor.impl = () => null;
    expect((await rejection(loginStaff(w).run())).code).toBe('common.internal');
  });
  it('loginPartner: no row -> common.internal and no transaction commits (no session survives)', async () => {
    const w = makeWorld({ rows: { [SUB]: partnerRow() } }); w.repo.actor.impl = () => undefined; const r = runPartner(w);
    expect((await rejection(r.call())).code).toBe('common.internal');
    expect(r.committedTxs.size).toBe(0); expect(r.committed()).toHaveLength(0);
  });
  it('openMobileSession: no row -> common.internal and no transaction commits', async () => {
    const { w, r, call } = mobile(); w.repo.actor.impl = () => undefined;
    expect((await rejection(call())).code).toBe('common.internal');
    expect(r.committedTxs.size).toBe(0);
  });
  it('a DB error in the lookup is not swallowed into a 200 without actor', async () => {
    const w = makeWorld({ rows: { [SUB]: tenantRow() } }); w.repo.actor.impl = () => { throw new Error('connection reset'); };
    const e = await rejection(loginStaff(w).run()); expect(e).toBeInstanceOf(Error);
  });
});

describe('nothing sensitive in the actor', () => {
  it('loginStaff: only display_name / roles / tenant_code survive even if the row carries e-mail, ids and tokens; the body holds no e-mail, id or GoTrue token', async () => {
    const w = makeWorld({ rows: { [SUB]: tenantRow() } }); w.repo.actor.impl = () => tenantActorRow(HOSTILE);
    const r: any = await loginStaff(w).run();
    expect(r.body.session.state).toBe('active');
    expect(keys(r.body.session.actor).every((x) => ACTIVE_KEYS.includes(x))).toBe(true);
    expect(r.body.session.actor.permissions).toEqual(TENANT_PERMS);   // from the permission source, never from extra columns of the actor row
    const text = JSON.stringify(r.body);
    for (const bad of [EMAIL, HOSTILE.email, HOSTILE.user_id, HOSTILE.membership_id, HOSTILE.id, HOSTILE.access_token, HOSTILE.password_hash, SUB, MEMB_A, TENANT_A, STAFF_ID, ACCESS, REFRESH, PASSWORD]) expect(text).not.toContain(bad);
  });
  it('platform body: same (no platform_staff id, no user id, no e-mail)', async () => {
    const w = makeWorld({ rows: { [SUB]: platformRow() } }); w.repo.actor.impl = () => platformActorRow(HOSTILE);
    const r: any = await loginStaff(w).run();
    expect(keys(r.body.session.actor)).toEqual(['display_name', 'roles']);
    const text = JSON.stringify(r.body); for (const bad of [EMAIL, HOSTILE.email, HOSTILE.user_id, SUB, STAFF_ID, ACCESS, REFRESH]) expect(text).not.toContain(bad);
  });
  it('the log lines of a successful login never carry the actor (display name) or the role list', async () => {
    const w = makeWorld({ rows: { [SUB]: tenantRow() } }); await loginStaff(w).run();
    expect(logged(w)).not.toContain('Ana Demo');
  });
  it('a failed login (wrong password) does no actor lookup at all: no extra DB read, no oracle', async () => {
    const w = makeWorld({ rows: { [SUB]: tenantRow() } }); const k = w.makeCtx();
    await rejection(createAuthService(w.deps as any).loginStaff(k.ctx, { email: EMAIL, password: 'wrong-password' } as any));
    expect(w.repo.actor.calls).toHaveLength(0);
  });
  it('a blocked login (deactivated / locked membership) does no actor lookup either', async () => {
    for (const o of [{ membership_status: 'deactivated' }, { membership_locked: true }, { tenant_status: 'suspended' }]) {
      const w = makeWorld({ rows: { [SUB]: tenantRow(o) } }); await rejection(loginStaff(w).run());
      expect(w.repo.actor.calls).toHaveLength(0);
    }
  });
});

// -------------------------------------------------------------------------------------------------------------------------------- resolveSession
const resolve = async (w: SessionWorld, a: { token: string; key?: string }) => {
  const { hctx, commitOnError } = w.makeHctx(a.key ? { bffKey: a.key } : {});
  return { commitOnError, run: () => createResolveSession(w.deps as any)(w.req({ token: a.token, body: { touch: false } }) as any, hctx) };
};

describe('resolveSession: the 200 body carries the actor', () => {
  it('tenant_staff: session.actor = { display_name, roles, tenant_code }; lookup for (session user, tenant, membership) of the stored session; still no write', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession();
    const out: any = await (await resolve(w, { token })).run();
    expect(out.status).toBe(200); expect(out.body.session.kind).toBe('tenant_staff');
    expect(out.body.session.actor).toEqual({ ...TENANT_ACTOR, permissions: TENANT_PERMS });
    expect(w.store.actor.calls).toHaveLength(1);
    expect(w.store.actor.calls[0]).toMatchObject({ userId: row.userId, tenantId: TENANT_A, membershipId: MEMB_A });
    expect(w.store.committed()).toHaveLength(0);
  });
  it('platform: session.actor = { display_name, roles } (no tenant_code); lookup for (user, null, null)', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession({ kind: 'platform' });
    const out: any = await (await resolve(w, { token })).run();
    expect(out.body.session.actor).toEqual({ ...PLATFORM_ACTOR, permissions: PLATFORM_PERMS }); expect(keys(out.body.session.actor)).toEqual(['display_name', 'permissions', 'roles']);
    expect(w.store.actor.calls[0]).toMatchObject({ userId: row.userId, tenantId: null, membershipId: null });
  });
  it('partner (partner BFF key): actor with tenant_code', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ kind: 'partner' });
    const out: any = await (await resolve(w, { token, key: 'partner' })).run();
    expect(out.body.session.actor).toEqual(TENANT_ACTOR); expect(out.body.session.actor).not.toHaveProperty('permissions');   // LD-222: partner omits it
  });
  it('a touch / access refresh does not change the actor lookup count: exactly one lookup per 200', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ accessExpiresAt: new Date(w.clock.ms + 30_000) });   // inside the 120 s refresh window
    const { run } = await resolve(w, { token }); await run();
    expect(w.store.actor.calls).toHaveLength(1);
  });
  it('actor carries only display_name / roles / tenant_code; no e-mail, id or token from the row or the stored session', async () => {
    const w = await makeSessionWorld(); const { token, row } = w.addSession(); w.store.actor.impl = () => tenantActorRow(HOSTILE);
    const out: any = await (await resolve(w, { token })).run();
    expect(keys(out.body.session.actor).every((x) => ACTIVE_KEYS.includes(x))).toBe(true);
    expect(out.body.session.actor.permissions).toEqual(TENANT_PERMS);
    const text = JSON.stringify(out.body.session);
    for (const bad of [row.email, HOSTILE.email, HOSTILE.user_id, HOSTILE.membership_id, HOSTILE.id, HOSTILE.access_token, row.userId, MEMB_A, TENANT_A, row.refreshToken]) expect(text).not.toContain(bad);
  });
});

describe('resolveSession: fail closed and no oracle', () => {
  it('no actor row -> common.internal, nothing committed, commitOnError not called, a log line names the missing actor', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession(); w.store.actor.impl = () => undefined;
    const { run, commitOnError } = await resolve(w, { token }); const e = await rejection(run());
    expect(e.code).toBe('common.internal'); expect(w.store.committed()).toHaveLength(0); expect(commitOnError).not.toHaveBeenCalled();
    expect(logged(w)).toMatch(/actor/i);
  });
  it('platform session with no actor row (inactive staff) -> common.internal as well', async () => {
    const w = await makeSessionWorld(); const { token } = w.addSession({ kind: 'platform' }); w.store.actor.impl = () => undefined;
    expect((await rejection((await resolve(w, { token })).run())).code).toBe('common.internal');
  });
  it('a dead, unknown or wrong-family session answers its 401 BEFORE any actor lookup', async () => {
    const w = await makeSessionWorld();
    const revoked = w.addSession({ state: 'revoked' }); const live = w.addSession({ kind: 'platform' });
    expect((await rejection((await resolve(w, { token: revoked.token })).run())).code).toBe('auth.session_expired');
    expect((await rejection((await resolve(w, { token: 'x'.repeat(43) })).run())).code).toBe('auth.session_expired');
    expect((await rejection((await resolve(w, { token: live.token, key: 'partner' })).run())).code).toBe('auth.session_expired');   // platform token on the partner key
    expect(w.store.actor.calls).toHaveLength(0);
  });
});
