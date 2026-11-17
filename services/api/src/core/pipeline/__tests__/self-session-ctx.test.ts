// T0D-ELABMENU-2 (LD-340). Staging: getMe / listOwnMfaFactors / listOwnSessions answered 401 for a signed in admin while listRoles answered 200.
// Cause under test: the identity self handlers (handlers/self.http.ts bindSelf) fail closed unless ctx.sessionId is a string, but the pipeline
// (stage 8, buildCtx) only ever sets ctx.platformSessionId (platform session) and never a session id for a tenant / partner session, although the
// claimsResolver puts claims.lims_session_id into every tenant and partner claim set. So every self service call is refused with auth.unauthenticated.
// Rule under test: a tenant (actor_type user) or partner session gets ctx.sessionId = claims.lims_session_id (verified claims ONLY, UUID only);
// a missing / invalid claim leaves the key ABSENT (no key at all, so stage08's member list for claims without it is unchanged); nothing from the
// request (params, query, headers, body) ever supplies it. Same rig as platform-wire-ctx.test.ts.
import { describe, expect, it } from 'vitest';
import { claimsA, makeRig, MEMBERSHIP, SUB, TENANT_A } from './helpers.js';

const SID = '0190a000-0000-7000-8000-00000000c0d1';
const EVIL = '0190a000-0000-7000-8000-00000000e711';
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const meOp = { module: 'identity', operationId: 'getMe', method: 'GET', routeTemplate: '/v1/identity/me', context: 'tenant' };
const staff = (over: Record<string, unknown> = {}) => ({ ...claimsA, aal: 'aal2', lims_session_id: SID, session_state: 'active', ...over }) as any;
const partner = (over: Record<string, unknown> = {}) => ({ sub: SUB, tenant_id: TENANT_A, membership_id: MEMBERSHIP, actor_type: 'partner', partner_role: 'referrer', aal: 'aal1', lims_session_id: SID, session_state: 'active', ...over }) as any;

async function ctxFor(claims: Record<string, unknown>, over: Record<string, unknown> = {}) {
  let ctx: any;
  const rig = makeRig();
  const r = await rig.run({
    claims, op: meOp, ...over,
    handler: async (_r: any, c: any) => { ctx = c; await c.ports.IdentityPort.assertRole(c, {}); return { status: 200, body: {} }; },
  });
  return { ctx, r };
}

describe('a tenant staff session: ctx.sessionId = claims.lims_session_id (the value the self handlers need)', () => {
  it('admin aal2 -> ctx.sessionId is the session of the verified claims; tenantId and actor are unchanged', async () => {
    const { ctx, r } = await ctxFor(staff());
    expect(r.status).toBe(200);
    expect(ctx.sessionId).toBe(SID);
    expect(ctx.tenantId).toBe(TENANT_A);
    expect(ctx.actor).toMatchObject({ type: 'user', id: SUB, membershipId: MEMBERSHIP });
  });

  it('aal1 staff gets it too (aal is the operation\'s own rule, not a condition for knowing the own session)', async () => {
    const { ctx } = await ctxFor(staff({ aal: 'aal1' }));
    expect(ctx.sessionId).toBe(SID);
  });

  it('it is set for every one of the three self read operations, not only getMe', async () => {
    for (const [operationId, routeTemplate] of [['getMe', '/v1/identity/me'], ['listOwnSessions', '/v1/identity/me/sessions'], ['listOwnMfaFactors', '/v1/identity/me/mfa-factors']] as const) {
      const { ctx } = await ctxFor(staff(), { op: { ...meOp, operationId, routeTemplate } });
      expect(ctx.sessionId, operationId).toBe(SID);
    }
  });

  it('ctx stays frozen and carries no platform member (a tenant session is not a platform session)', async () => {
    const { ctx } = await ctxFor(staff());
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.keys(ctx).filter((k) => /^platform/.test(k))).toEqual([]);
    expect(has(ctx.db, 'withTenantScope')).toBe(false);
  });

  it('the claims object is not changed by building the context', async () => {
    const c = staff();
    const before = JSON.stringify(c);
    await ctxFor(c);
    expect(JSON.stringify(c)).toBe(before);
  });

  it('each request gets its own session id (two sessions of two users interleaved: no bleed)', async () => {
    const SID2 = '0190a000-0000-7000-8000-00000000c0d2';
    const seen: string[] = [];
    const rig = makeRig();
    const run = (c: any) => rig.run({
      claims: c, op: meOp,
      handler: async (_r: any, ctx: any) => { await new Promise((r) => setTimeout(r, 5)); seen.push(ctx.sessionId); await ctx.ports.IdentityPort.assertRole(ctx, {}); return { status: 200, body: {} }; },
    });
    await Promise.all([run(staff()), run(staff({ lims_session_id: SID2 }))]);
    expect(seen.sort()).toEqual([SID, SID2].sort());
  });
});

describe('a partner session gets it as well (the self operations accept actor type user and partner)', () => {
  it('partner -> ctx.sessionId = claims.lims_session_id', async () => {
    const { ctx } = await ctxFor(partner());
    expect(ctx.sessionId).toBe(SID);
    expect(ctx.actor).toMatchObject({ type: 'partner', id: SUB });
  });
});

describe('a missing or invalid claim leaves the key absent (no key at all): the self handler then still answers 401, never a guessed "current" session', () => {
  const BAD: unknown[][] = [null, '', ' ', 42, true, {}, [SID], 'not-a-uuid', ` ${SID}`, `${SID} `, `${SID}00`, SID.slice(1), '__proto__', 'constructor'].map((v) => [v]);
  it.each(BAD)('lims_session_id %j -> no sessionId', async (bad) => {
    const { ctx } = await ctxFor(staff({ lims_session_id: bad }));
    expect(has(ctx, 'sessionId')).toBe(false);
    expect(ctx.sessionId).toBeUndefined();
  });
  it('lims_session_id missing -> no sessionId (and the member list of such a request is exactly as before)', async () => {
    const { lims_session_id: _drop, ...bare } = staff();
    const { ctx } = await ctxFor(bare);
    expect(has(ctx, 'sessionId')).toBe(false);
  });
  it('claims-less contexts (public operation, no transaction) never get one', async () => {
    let ctx: any;
    const rig = makeRig();
    await rig.run({ claims: undefined, op: { ...meOp, operationId: 'getPublicThing', public: true, context: 'public' }, handler: async (_r: any, c: any) => { ctx = c; return { status: 200, body: {} }; } });
    expect(has(ctx, 'sessionId')).toBe(false);
  });
});

describe('no value ever comes from the request', () => {
  const evil = { sessionId: EVIL, session_id: EVIL, lims_session_id: EVIL, 'x-session-id': EVIL, platformSessionId: EVIL };
  const req = { params: evil, query: evil, headers: evil, body: evil };
  it('a session with a claim keeps the claim\'s id whatever params / query / headers / body say', async () => {
    const { ctx } = await ctxFor(staff(), { req });
    expect(ctx.sessionId).toBe(SID);
  });
  it('a session without a claim does not get the request\'s id', async () => {
    const { lims_session_id: _drop, ...bare } = staff();
    const { ctx } = await ctxFor(bare, { req });
    expect(has(ctx, 'sessionId')).toBe(false);
  });
});

describe('other session kinds: a device is not a self service caller and gets no session id', () => {
  it('device claims carrying a lims_session_id -> no sessionId (bindSelf accepts only user / partner and needs none of it)', async () => {
    const { ctx } = await ctxFor({ sub: SUB, tenant_id: TENANT_A, actor_type: 'device', lims_session_id: SID } as any);
    expect(has(ctx, 'sessionId')).toBe(false);
  });
  it('platform session (no tenant): ctx.platformSessionId stays the platform path; no tenant sessionId is added', async () => {
    const platform = { sub: SUB, actor_type: 'user', scope: 'platform', platform_staff_id: '0190a000-0000-7000-8000-00000000c001', platform_role: 'platform_superadmin', aal: 'aal2', lims_session_id: SID } as any;
    const { ctx } = await ctxFor(platform, { op: { ...meOp, operationId: 'listTenants', routeTemplate: '/v1/identity/platform/tenants', context: 'platform' } });
    expect(ctx.platformSessionId).toBe(SID);
    expect(has(ctx, 'sessionId')).toBe(false);
  });
});
