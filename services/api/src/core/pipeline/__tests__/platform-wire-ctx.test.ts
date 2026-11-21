// PLATFORM-WIRE-1 (LD-267, LD-241; CR-C2-004, CR-C2-T21; C2 02-TRD 5.10 + 7.2 step 3). Rig level (same rig as platform-ctx.test.ts).
// T0D-PLATFORM-CTX-1 gave the handler context platformRole + aal only. The platform services also need ctx.platformStaffId
// (claims.platform_staff_id), ctx.platformSessionId (claims.lims_session_id) and ctx.db.withTenantScope. Rule under test: ONLY a platform
// session (scope 'platform', actor_type 'user', no tenant_id, platform_ role) gets the three; a missing / invalid claim leaves the field
// ABSENT (no key at all); no value ever comes from the request. Behaviour of withTenantScope itself: platform-wire-scope.test.ts (boot rig).
import { describe, expect, it } from 'vitest';
import { claimsA, makeRig, REQ_ID, SUB, TENANT_A } from './helpers.js';

const STAFF = '0190a000-0000-7000-8000-00000000c001';
const PSID = '0190a000-0000-7000-8000-00000000c0d1';
const EVIL = '0190a000-0000-7000-8000-00000000e711';
const platformClaims = (over: Record<string, unknown> = {}) =>
  ({ sub: SUB, actor_type: 'user', scope: 'platform', platform_staff_id: STAFF, platform_role: 'platform_superadmin', aal: 'aal2', lims_session_id: PSID, ...over }) as any;
const platformOp = { module: 'identity', operationId: 'provisionTenant', method: 'POST', routeTemplate: '/v1/identity/platform/tenants', context: 'platform' };
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

async function ctxFor(claims: Record<string, unknown>, over: Record<string, unknown> = {}) {
  let ctx: any;
  const rig = makeRig();
  const r = await rig.run({
    claims, ...over,
    handler: async (_r: any, c: any) => { ctx = c; await c.ports.IdentityPort.assertRole(c, {}); return { status: 200, body: {} }; },
  });
  return { ctx, r, rig };
}

describe('platform session: the three fields come from the verified claims', () => {
  it('superadmin aal2 -> platformStaffId = claims.platform_staff_id, platformSessionId = claims.lims_session_id, db.withTenantScope is a function', async () => {
    const { ctx, r } = await ctxFor(platformClaims(), { op: platformOp });
    expect(r.status).toBe(200);
    expect(ctx.platformStaffId).toBe(STAFF);
    expect(ctx.platformSessionId).toBe(PSID);
    expect(typeof ctx.db.withTenantScope).toBe('function');
  });

  it('platform_support aal1 gets the same fields (role and aal do not gate them; PlatformAuthz does)', async () => {
    const { ctx } = await ctxFor(platformClaims({ platform_role: 'platform_support', aal: 'aal1' }), { op: platformOp });
    expect(ctx.platformRole).toBe('platform_support');
    expect(ctx.platformStaffId).toBe(STAFF);
    expect(ctx.platformSessionId).toBe(PSID);
    expect(typeof ctx.db.withTenantScope).toBe('function');
  });

  it('the fields are set for every platform operation context, not only provisionTenant', async () => {
    for (const operationId of ['listTenants', 'getTenant', 'listPlatformIrdAnnexes', 'listPlatformSupportSessions', 'listDeadLetters', 'listPlatformStaff']) {
      const { ctx } = await ctxFor(platformClaims(), { op: { ...platformOp, operationId, method: 'GET' } });
      expect(ctx.platformStaffId, operationId).toBe(STAFF);
      expect(ctx.platformSessionId, operationId).toBe(PSID);
    }
  });

  it('existing keys are unchanged: actor, tenantId, platformRole, aal, tx, db.tx and db.identityAuthTx are still there; ctx and ctx.db stay frozen', async () => {
    const { ctx } = await ctxFor(platformClaims(), { op: platformOp });
    expect(ctx.actor).toMatchObject({ type: 'user', id: SUB });
    expect(ctx.tenantId).toBeUndefined();
    expect(ctx.platformRole).toBe('platform_superadmin');
    expect(ctx.aal).toBe('aal2');
    expect(typeof ctx.tx.query).toBe('function');
    expect(typeof ctx.db.tx).toBe('function');
    expect(typeof ctx.db.identityAuthTx).toBe('function');
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.db)).toBe(true);
  });

  it('request input never supplies them: params/query/headers/body naming platformStaffId / platform_staff_id / platformSessionId win nothing', async () => {
    const evil = { platformStaffId: EVIL, platform_staff_id: EVIL, platformSessionId: EVIL, platform_session_id: EVIL, lims_session_id: EVIL, 'x-platform-staff-id': EVIL };
    const { ctx } = await ctxFor(platformClaims(), { op: platformOp, req: { params: evil, query: evil, headers: evil, body: evil } });
    expect(ctx.platformStaffId).toBe(STAFF);
    expect(ctx.platformSessionId).toBe(PSID);
  });

  it('request input cannot give a platform session the fields it lacks (claims without them stay without them)', async () => {
    const { platform_staff_id: _a, lims_session_id: _b, ...bare } = platformClaims();
    const evil = { platformStaffId: EVIL, platformSessionId: EVIL };
    const { ctx } = await ctxFor(bare, { op: platformOp, req: { params: evil, query: evil, headers: evil, body: evil } });
    expect(has(ctx, 'platformStaffId')).toBe(false);
    expect(has(ctx, 'platformSessionId')).toBe(false);
  });

  it('the claims object is not changed by building the context', async () => {
    const c = platformClaims();
    const before = JSON.stringify(c);
    await ctxFor(c, { op: platformOp });
    expect(JSON.stringify(c)).toBe(before);
  });

  it('each request gets its own values (two platform sessions interleaved: no bleed)', async () => {
    const STAFF2 = '0190a000-0000-7000-8000-00000000c002';
    const PSID2 = '0190a000-0000-7000-8000-00000000c0d2';
    const seen: Array<[string, string]> = [];
    const rig = makeRig();
    const run = (c: any) => rig.run({
      claims: c, op: platformOp,
      handler: async (_r: any, ctx: any) => { await new Promise((r) => setTimeout(r, 5)); seen.push([ctx.platformStaffId, ctx.platformSessionId]); await ctx.ports.IdentityPort.assertRole(ctx, {}); return { status: 200, body: {} }; },
    });
    await Promise.all([run(platformClaims()), run(platformClaims({ platform_staff_id: STAFF2, lims_session_id: PSID2 }))]);
    expect(seen).toHaveLength(2);
    expect(seen).toContainEqual([STAFF, PSID]);
    expect(seen).toContainEqual([STAFF2, PSID2]);
  });
});

describe('a missing or invalid claim leaves the field absent (no key at all), the operation then fails closed in the service as today', () => {
  const BAD: unknown[][] = [undefined, null, '', ' ', 42, true, {}, [STAFF], 'not-a-uuid', ` ${STAFF}`, `${STAFF} `, `${STAFF}00`, STAFF.slice(1), '__proto__', 'constructor'].map((v) => [v]);
  it.each(BAD)('platform_staff_id %j -> no platformStaffId; the other fields are unaffected', async (bad) => {
    const claims = platformClaims({ platform_staff_id: bad });
    if (bad === undefined) delete claims.platform_staff_id;
    const { ctx } = await ctxFor(claims, { op: platformOp });
    expect(has(ctx, 'platformStaffId')).toBe(false);
    expect(ctx.platformSessionId).toBe(PSID);
    expect(typeof ctx.db.withTenantScope).toBe('function');
  });
  it.each(BAD)('lims_session_id %j -> no platformSessionId; the other fields are unaffected', async (bad) => {
    const claims = platformClaims({ lims_session_id: bad });
    if (bad === undefined) delete claims.lims_session_id;
    const { ctx } = await ctxFor(claims, { op: platformOp });
    expect(has(ctx, 'platformSessionId')).toBe(false);
    expect(ctx.platformStaffId).toBe(STAFF);
    expect(typeof ctx.db.withTenantScope).toBe('function');
  });
  it('no value is invented: a platform session without an aal claim still has no aal, staff id and session id stay as claimed', async () => {
    const { aal: _drop, ...noAal } = platformClaims();
    const { ctx } = await ctxFor(noAal, { op: platformOp });
    expect(ctx.aal).toBeUndefined();
    expect(ctx.platformStaffId).toBe(STAFF);
  });
});

describe('no other session kind gets platformStaffId, platformSessionId or db.withTenantScope (the keys do not exist at all)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['tenant staff aal1', { ...claimsA }],
    ['tenant staff carrying stray platform keys (scope absent)', { ...claimsA, aal: 'aal2', platform_role: 'platform_superadmin', platform_staff_id: STAFF, lims_session_id: PSID }],
    ['tenant staff carrying scope=platform + staff id but no platform_role', { ...claimsA, aal: 'aal2', scope: 'platform', platform_staff_id: STAFF, lims_session_id: PSID }],
    ['tenant staff carrying scope=platform + platform_role + staff id but WITH tenant_id', { ...claimsA, aal: 'aal2', scope: 'platform', platform_role: 'platform_superadmin', platform_staff_id: STAFF, lims_session_id: PSID }],
    ['patient with stray platform keys', { sub: SUB, tenant_id: TENANT_A, actor_type: 'patient', aal: 'aal2', scope: 'platform', platform_role: 'platform_superadmin', platform_staff_id: STAFF, lims_session_id: PSID }],
    ['partner with stray platform keys', { sub: SUB, tenant_id: TENANT_A, actor_type: 'partner', platform_role: 'platform_superadmin', platform_staff_id: STAFF, lims_session_id: PSID }],
    ['device with stray platform keys', { sub: SUB, tenant_id: TENANT_A, actor_type: 'device', platform_staff_id: STAFF, lims_session_id: PSID }],
    ['support-session claims (scope support carries platform_staff_id and lims_session_id by design)', { sub: SUB, tenant_id: TENANT_A, actor_type: 'user', scope: 'support', support_session_id: PSID, support_scope: 'read', platform_staff_id: STAFF, aal: 'aal2', lims_session_id: PSID }],
    ['support-session claims with a stray platform_role', { sub: SUB, tenant_id: TENANT_A, actor_type: 'user', scope: 'support', support_session_id: PSID, support_scope: 'read', platform_staff_id: STAFF, aal: 'aal2', lims_session_id: PSID, platform_role: 'platform_superadmin' }],
    ['platform scope but no platform_role', (({ platform_role: _r, ...rest }) => rest)(platformClaims())],
    ['platform scope with a platform_role without the platform_ prefix', platformClaims({ platform_role: 'tenant_admin' })],
    ['platform scope with platform_role of the wrong type', platformClaims({ platform_role: ['platform_superadmin'] })],
    ['platform scope + platform_ role but actor_type system', platformClaims({ actor_type: 'system' })],
    ['platform scope + platform_ role but actor_type device', platformClaims({ actor_type: 'device' })],
    ['platform scope + platform_ role but actor_type patient', platformClaims({ actor_type: 'patient' })],
    ['platform scope + platform_ role but actor_type partner', platformClaims({ actor_type: 'partner' })],
  ];
  it.each(cases)('%s', async (_n, claims) => {
    const { ctx } = await ctxFor(claims);
    for (const k of ['platformStaffId', 'platformSessionId']) {
      expect(has(ctx, k), k).toBe(false);
      expect(ctx[k], k).toBeUndefined();
    }
    expect(has(ctx.db, 'withTenantScope'), 'db.withTenantScope').toBe(false);
    expect(ctx.db.withTenantScope).toBeUndefined();
  });

  it('request input never supplies them for a tenant session either', async () => {
    const evil = { platformStaffId: EVIL, platformSessionId: EVIL, platform_staff_id: EVIL, lims_session_id: EVIL, withTenantScope: 'x' };
    const { ctx } = await ctxFor({ ...claimsA }, { req: { params: evil, query: evil, headers: evil, body: evil } });
    expect(has(ctx, 'platformStaffId')).toBe(false);
    expect(has(ctx, 'platformSessionId')).toBe(false);
    expect(has(ctx.db, 'withTenantScope')).toBe(false);
  });

  it('a public operation (no claims, no transaction) gets none of them', async () => {
    let ctx: any;
    const rig = makeRig();
    await rig.run({ claims: undefined, op: { ...platformOp, operationId: 'getPublicThing', public: true, context: 'public' }, handler: async (_r: any, c: any) => { ctx = c; return { status: 200, body: {} }; } });
    expect(has(ctx, 'platformStaffId')).toBe(false);
    expect(has(ctx, 'platformSessionId')).toBe(false);
    expect(has(ctx.db, 'withTenantScope')).toBe(false);
  });
});

describe('the stage 8 member list for a tenant request is unchanged by this task (pinned again here so a leak of the new keys is caught in this file too)', () => {
  it('tenant request ctx has no platform member of any kind', async () => {
    const { ctx } = await ctxFor({ ...claimsA });
    expect(Object.keys(ctx).filter((k) => /^platform/.test(k))).toEqual([]);
    expect(Object.keys(ctx.db).sort()).toEqual(['identityAuthTx', 'tx']);
    expect(ctx.requestId).toBe(REQ_ID);
  });
});
