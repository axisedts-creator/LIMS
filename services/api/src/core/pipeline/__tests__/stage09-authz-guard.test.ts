// T0D-18 stage 9 (02-TRD §6.2 row 9; AC-0D-2.4; 07-SECURITY AB-5; 08 A25 D-212): non-public operation returning < 400 without an
// IdentityPort.assertRole call -> dev/ci/staging 500 common.internal + log authz_not_asserted; production logs + counts only.
// The production path is covered here (a booted production app needs every port real; see T0D-18-tests.md).
import { describe, expect, it } from 'vitest';
import { count, lastTxEnd, logged, makeRig, op, rejects, SUB } from './helpers.js';
import { PlatformAuthz } from '../../../modules/identity/platform/authz.js';

const silent = async () => ({ status: 200, body: { ok: true } });

describe('stage 9 authz guard', () => {
  it.each(['dev', 'ci', 'staging'])('%s: 2xx without assertRole -> 500 common.internal, log authz_not_asserted{operationId}, metric counted, ROLLBACK', async (env) => {
    const rig = makeRig({ env, handler: silent });
    const e = await rejects(rig.run());
    expect(e.code).toBe('common.internal');
    expect(e.statusCode).toBe(500);
    const l = logged(rig, 'authz_not_asserted');
    expect(l).toHaveLength(1);
    expect(l[0]!.obj.operationId).toBe('createThing');
    expect(rig.incs).toContainEqual(['lims_core_authz_not_asserted_total', { operation_id: 'createThing' }]);
    expect(lastTxEnd(rig)).toBe('ROLLBACK'); // the handler's writes must not survive a response the core replaced
  });

  it('production: the 2xx response is kept and committed; only log + metric', async () => {
    const rig = makeRig({ env: 'production', handler: silent });
    const r = await rig.run();
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(logged(rig, 'authz_not_asserted')).toHaveLength(1);
    expect(rig.incs).toContainEqual(['lims_core_authz_not_asserted_total', { operation_id: 'createThing' }]);
    expect(lastTxEnd(rig)).toBe('COMMIT');
  });

  it('assertRole called (through ctx.ports.IdentityPort) -> response kept, nothing logged', async () => {
    const rig = makeRig({ env: 'ci' });
    const r = await rig.run();
    expect(r.status).toBe(201);
    expect(rig.assertRoleCalls).toHaveLength(1);
    expect(logged(rig, 'authz_not_asserted')).toEqual([]);
  });

  it('assertRole is passed the request context as first argument (same tx as the handler)', async () => {
    const rig = makeRig({ env: 'ci' });
    let handlerTx: unknown;
    await rig.run({ handler: async (_r: any, ctx: any) => { handlerTx = ctx.tx; await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'x.y' }); return { status: 200, body: {} }; } });
    expect(rig.assertRoleCalls[0][0].tx).toBe(handlerTx);
    expect(rig.assertRoleCalls[0][1]).toEqual({ permission: 'x.y' });
  });

  it('public operation (x-public): no assertRole needed', async () => {
    const rig = makeRig({ env: 'ci', handler: silent });
    const r = await rig.run({ op: op({ public: true, context: undefined }), claims: undefined });
    expect(r.status).toBe(200);
    expect(logged(rig, 'authz_not_asserted')).toEqual([]);
  });

  it('x-context identity_auth operations (they carry x-public) are exempt', async () => {
    const rig = makeRig({ env: 'ci', handler: silent });
    const r = await rig.run({ op: op({ public: true, identityAuth: true, context: 'identity_auth', module: 'identity' }), claims: undefined });
    expect(r.status).toBe(200);
    expect(logged(rig, 'authz_not_asserted')).toEqual([]);
  });

  it.each([400, 404, 409, 422, 500])('a %i result without assertRole does not trigger the guard (it only guards < 400)', async (status) => {
    const rig = makeRig({ env: 'ci', handler: async () => ({ status, body: {} }) });
    const r = await rig.run();
    expect(r.status).toBe(status);
    expect(logged(rig, 'authz_not_asserted')).toEqual([]);
  });

  it('the asserted flag is per request: request 1 asserting does not satisfy request 2', async () => {
    const rig = makeRig({ env: 'ci' });
    await rig.run();
    const second = makeRig({ env: 'ci', handler: silent });
    expect((await rejects(second.run())).code).toBe('common.internal');
    expect(count(rig, /^COMMIT/)).toBe(1);
  });

  it('a handler cannot flip the flag by writing to ctx (frozen) or by calling a different IdentityPort method', async () => {
    const rig = makeRig({ env: 'ci' });
    const e = await rejects(rig.run({
      handler: async (_r: any, ctx: any) => {
        try { ctx.asserted = true; } catch { /* frozen */ }
        await ctx.ports.IdentityPort.getActor(ctx);
        return { status: 200, body: {} };
      },
    }));
    expect(e.code).toBe('common.internal');
  });

  // LD-271 option A (PLATFORM-WIRE-1): PlatformAuthz.assertPlatform is the stage 9 assertion for platform operations, only after it passed.
  describe('platform session (LD-271 option A)', () => {
    const platformClaims = { sub: SUB, actor_type: 'user', scope: 'platform', platform_staff_id: '0190a000-0000-7000-8000-00000000c001', platform_role: 'platform_superadmin', aal: 'aal2', lims_session_id: '0190a000-0000-7000-8000-00000000c0d1' } as any;
    const platformOp = op({ module: 'identity', operationId: 'listTenants', method: 'GET', routeTemplate: '/v1/identity/platform/tenants', context: 'platform' });
    const ok = { status: 200, body: {} };

    it.each(['dev', 'ci', 'staging'])('%s: handler that never calls assertPlatform -> 500 common.internal + authz_not_asserted', async (env) => {
      const rig = makeRig({ env });
      const e = await rejects(rig.run({ op: platformOp, claims: platformClaims, handler: async () => ok }));
      expect(e.code).toBe('common.internal');
      expect(logged(rig, 'authz_not_asserted')).toHaveLength(1);
      expect(lastTxEnd(rig)).toBe('ROLLBACK');
    });

    it('handler that calls assertPlatform and passes -> 2xx kept, nothing logged', async () => {
      const rig = makeRig({ env: 'ci' });
      const r = await rig.run({ op: platformOp, claims: platformClaims, handler: async (_r: any, ctx: any) => { PlatformAuthz.assertPlatform(ctx, 'platform.tenant.read'); return ok; } });
      expect(r.status).toBe(200);
      expect(logged(rig, 'authz_not_asserted')).toEqual([]);
    });

    it('assertPlatform throws (forbidden) and the handler swallows it and returns 2xx -> still 500 (a throw marks nothing)', async () => {
      const rig = makeRig({ env: 'ci' });
      let thrown: any;
      const e = await rejects(rig.run({
        op: platformOp,
        claims: { ...platformClaims, platform_role: 'platform_support' },
        handler: async (_r: any, ctx: any) => {
          try { PlatformAuthz.assertPlatform(ctx, 'platform.tenant.manage'); } catch (x) { thrown = x; }
          return ok;
        },
      }));
      expect(thrown?.code).toBe('auth.forbidden');
      expect(e.code).toBe('common.internal');
      expect(logged(rig, 'authz_not_asserted')).toHaveLength(1);
    });

    it('missing aal2 on a privileged permission throws auth.mfa_required and marks nothing', async () => {
      const rig = makeRig({ env: 'ci' });
      let thrown: any;
      const e = await rejects(rig.run({
        op: platformOp,
        claims: { ...platformClaims, aal: 'aal1' },
        handler: async (_r: any, ctx: any) => {
          try { PlatformAuthz.assertPlatform(ctx, 'platform.tenant.manage'); } catch (x) { thrown = x; }
          return ok;
        },
      }));
      expect(thrown?.code).toBe('auth.mfa_required');
      expect(e.code).toBe('common.internal');
    });

    it('a tenant session cannot be marked through assertPlatform (not bound): stays 500 even if the call is made', async () => {
      const rig = makeRig({ env: 'ci' });
      const e = await rejects(rig.run({
        handler: async (_r: any, ctx: any) => { try { PlatformAuthz.assertPlatform(ctx, 'platform.tenant.read'); } catch { /* forbidden */ } return ok; },
      }));
      expect(e.code).toBe('common.internal');
    });
  });

  it('assertRole that THROWS (forbidden) -> the error is rethrown, not replaced by common.internal', async () => {
    const rig = makeRig({ env: 'ci' });
    const forbidden = Object.assign(new Error('forbidden'), { code: 'auth.forbidden', statusCode: 403 });
    const e = await rejects(rig.run({ handler: async () => { throw forbidden; } }));
    expect(e.code).toBe('auth.forbidden');
    expect(e.statusCode).toBe(403);
  });
});
