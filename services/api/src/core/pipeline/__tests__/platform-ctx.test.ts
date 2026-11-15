// T0D-PLATFORM-CTX-1 (LD-241, CR-C2-004; C2 02-TRD 5.10 + 7.2 step 3): buildCtx hands platformRole and aal to the handler context
// for a PLATFORM session only (claims.scope 'platform' AND a platform_role starting with 'platform_'); every other session kind
// gets neither key (not even as undefined: stage08-handler-context.test.ts pins the exact member list of a tenant request).
// Claim shapes copy the identity claims resolver output (identity/claims/resolver.ts:104-107).
import { describe, expect, it } from 'vitest';
import { claimsA, makeRig, REQ_ID, SUB, TENANT_A } from './helpers.js';

const STAFF = '0190a000-0000-7000-8000-00000000c001';
const platformClaims = (over: Record<string, unknown> = {}) =>
  ({ sub: SUB, actor_type: 'user', scope: 'platform', platform_staff_id: STAFF, platform_role: 'platform_superadmin', aal: 'aal2', lims_session_id: REQ_ID, ...over }) as any;
const platformOp = { module: 'identity', operationId: 'listTenants', method: 'GET', routeTemplate: '/v1/identity/platform/tenants', context: 'platform' };

async function ctxFor(claims: Record<string, unknown>, over: Record<string, unknown> = {}) {
  let ctx: any;
  const rig = makeRig();
  const r = await rig.run({
    claims, ...over,
    handler: async (_r: any, c: any) => { ctx = c; await c.ports.IdentityPort.assertRole(c, {}); return { status: 200, body: {} }; },
  });
  return { ctx, r };
}
const has = (ctx: object, k: string) => Object.prototype.hasOwnProperty.call(ctx, k);

describe('platform session: platformRole and aal come from the verified claims', () => {
  it('platform_superadmin + aal2 -> ctx.platformRole and ctx.aal carry exactly the claim values', async () => {
    const { ctx, r } = await ctxFor(platformClaims(), { op: platformOp });
    expect(r.status).toBe(200);
    expect(ctx.platformRole).toBe('platform_superadmin');
    expect(ctx.aal).toBe('aal2');
  });

  it('platform_support + aal1 -> platformRole platform_support, aal aal1 (no upgrade, no default)', async () => {
    const { ctx } = await ctxFor(platformClaims({ platform_role: 'platform_support', aal: 'aal1' }), { op: platformOp });
    expect(ctx.platformRole).toBe('platform_support');
    expect(ctx.aal).toBe('aal1');
  });

  it('platform claims without an aal claim -> platformRole set, aal NOT invented (PlatformAuthz then refuses privileged codes)', async () => {
    const { aal: _drop, ...noAal } = platformClaims();
    const { ctx } = await ctxFor(noAal, { op: platformOp });
    expect(ctx.platformRole).toBe('platform_superadmin');
    expect(ctx.aal).toBeUndefined();
  });

  it('the rest of the context is unchanged for a platform request: actor is the staff user, no tenant, same request id', async () => {
    const { ctx } = await ctxFor(platformClaims(), { op: platformOp });
    expect(ctx.actor).toMatchObject({ type: 'user', id: SUB });
    expect(ctx.tenantId).toBeUndefined();
    expect(ctx.requestId).toBe(REQ_ID);
    expect(Object.isFrozen(ctx)).toBe(true);
  });
});

describe('no other session kind gets platformRole or aal on the context (the keys do not exist at all)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['tenant staff aal1', { ...claimsA }],
    ['tenant staff aal2', { ...claimsA, aal: 'aal2' }],
    ['tenant staff carrying a stray platform_role (scope absent)', { ...claimsA, aal: 'aal2', platform_role: 'platform_superadmin' }],
    ['tenant staff carrying scope=platform but no platform_role', { ...claimsA, aal: 'aal2', scope: 'platform' }],
    ['patient', { sub: SUB, tenant_id: TENANT_A, actor_type: 'patient', aal: 'aal2' }],
    ['patient with stray platform_role + scope', { sub: SUB, tenant_id: TENANT_A, actor_type: 'patient', aal: 'aal2', scope: 'platform', platform_role: 'platform_superadmin' }],
    ['partner', { sub: SUB, tenant_id: TENANT_A, actor_type: 'partner', aal: 'aal2' }],
    ['partner with stray platform_role (scope absent)', { sub: SUB, tenant_id: TENANT_A, actor_type: 'partner', platform_role: 'platform_superadmin' }],
    ['device', { sub: SUB, tenant_id: TENANT_A, actor_type: 'device', aal: 'aal2' }],
    ['support-session claims (scope support; the resolver gives them no platform_role)', { sub: SUB, tenant_id: TENANT_A, actor_type: 'user', scope: 'support', support_session_id: STAFF, support_scope: 'read', platform_staff_id: STAFF, aal: 'aal2' }],
    ['support-session claims with a stray platform_role', { sub: SUB, tenant_id: TENANT_A, actor_type: 'user', scope: 'support', support_session_id: STAFF, support_scope: 'read', platform_staff_id: STAFF, aal: 'aal2', platform_role: 'platform_superadmin' }],
  ];
  it.each(cases)('%s', async (_n, claims) => {
    const { ctx } = await ctxFor(claims);
    expect(has(ctx, 'platformRole')).toBe(false);
    expect(has(ctx, 'aal')).toBe(false);
    expect(ctx.platformRole).toBeUndefined();
    expect(ctx.aal).toBeUndefined();
  });

  it('request input never supplies them: headers/query/body/params named platform_role/platformRole/aal are ignored for a tenant session', async () => {
    const evil = { platform_role: 'platform_superadmin', platformRole: 'platform_superadmin', aal: 'aal2', 'x-platform-role': 'platform_superadmin' };
    const { ctx } = await ctxFor({ ...claimsA }, { req: { params: evil, query: evil, headers: evil, body: evil } });
    expect(has(ctx, 'platformRole')).toBe(false);
    expect(has(ctx, 'aal')).toBe(false);
  });
});

describe('platform claims that are not a valid platform session get neither field', () => {
  it('scope platform but platform_role missing -> neither platformRole nor aal', async () => {
    const { platform_role: _drop, ...noRole } = platformClaims();
    const { ctx } = await ctxFor(noRole, { op: platformOp });
    expect(has(ctx, 'platformRole')).toBe(false);
    expect(has(ctx, 'aal')).toBe(false);
  });
  it.each(['tenant_admin', 'superadmin', 'PLATFORM_SUPERADMIN', 'Platform_support', 'platform', ' platform_support', '', '__proto__', 'constructor', 42, null, ['platform_support'], { startsWith: 'platform_' }])(
    'scope platform with platform_role %j (no platform_ prefix or not a string) -> neither field', async (role) => {
      const { ctx } = await ctxFor(platformClaims({ platform_role: role }), { op: platformOp });
      expect(has(ctx, 'platformRole')).toBe(false);
      expect(has(ctx, 'aal')).toBe(false);
    });
  it.each(['user', 'system', 'device', 'patient', 'partner', 'portal'])('platform scope + platform_ role but actor_type %s still follows the claims, never a request: the context actor type is the claims value', async (t) => {
    // PlatformAuthz (not buildCtx) refuses a non-user actor; here only the actor type must stay the claims' own
    const { ctx } = await ctxFor(platformClaims({ actor_type: t }), { op: platformOp });
    expect(ctx.actor.type).toBe(t);
  });
});

describe('the claims object is not changed by building the context', () => {
  it('platform claims keep their shape', async () => {
    const c = platformClaims();
    const before = JSON.stringify(c);
    await ctxFor(c, { op: platformOp });
    expect(JSON.stringify(c)).toBe(before);
  });
});
