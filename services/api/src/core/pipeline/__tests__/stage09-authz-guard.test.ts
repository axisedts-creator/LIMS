// T0D-18 stage 9 (02-TRD §6.2 row 9; AC-0D-2.4; 07-SECURITY AB-5; 08 A25 D-212): non-public operation returning < 400 without an
// IdentityPort.assertRole call -> dev/ci/staging 500 common.internal + log authz_not_asserted; production logs + counts only.
// The production path is covered here (a booted production app needs every port real; see T0D-18-tests.md).
import { describe, expect, it } from 'vitest';
import { count, lastTxEnd, logged, makeRig, op, rejects } from './helpers.js';

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

  it('assertRole that THROWS (forbidden) -> the error is rethrown, not replaced by common.internal', async () => {
    const rig = makeRig({ env: 'ci' });
    const forbidden = Object.assign(new Error('forbidden'), { code: 'auth.forbidden', statusCode: 403 });
    const e = await rejects(rig.run({ handler: async () => { throw forbidden; } }));
    expect(e.code).toBe('auth.forbidden');
    expect(e.statusCode).toBe(403);
  });
});
