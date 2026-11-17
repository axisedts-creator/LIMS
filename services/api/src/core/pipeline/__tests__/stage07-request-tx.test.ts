// T0D-18 stage 7 (02-TRD §6.2 row 7, §6.4; AC-0D-2.3): requestTx() opens the transaction with the VERIFIED claims, request id,
// client ip and user agent; public operations without a tenant get no transaction; the whole request is retried on 40001/40P01.
import { describe, expect, it } from 'vitest';
import { claimsA, claimsB, count, makeRig, op, pgError, REQ_ID, TENANT_A, TENANT_B } from './helpers.js';

describe('stage 7 request transaction', () => {
  it('opens ONE transaction whose first context statement carries the claims verbatim, request id, client ip, user agent', async () => {
    const rig = makeRig();
    await rig.run();
    expect(count(rig, /^BEGIN/i)).toBe(1);
    expect(rig.fake.openingClaims()).toEqual(claimsA);
    const open = rig.fake.log.find((l) => /request\.jwt\.claims/.test(l.text))!;
    expect(open.values.slice(1, 4)).toEqual([REQ_ID, '203.0.113.9', 'vitest']);
  });

  it('the operation (module, operationId, context) is passed to the transaction layer', async () => {
    const rig = makeRig();
    let seen: any;
    await rig.run({ handler: async (_r: any, ctx: any) => { seen = ctx.tx.operation; await ctx.ports.IdentityPort.assertRole(ctx, {}); return { status: 200, body: {} }; } });
    expect(seen).toMatchObject({ module: 'frontdesk', operationId: 'createThing', context: 'tenant' });
  });

  it('handler runs INSIDE the transaction; COMMIT comes after it', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.order).toContain('handler:inTx=true');
    expect(rig.inTx()).toBe(false);
  });

  it('AC-0D-2.3: two concurrent requests of tenants A and B over ONE server connection each see their own tenant, none outside', async () => {
    const rig = makeRig({ servers: 1 });
    const seen: Record<string, string | null> = {};
    const h = (name: string) => async (_r: any, ctx: any) => {
      seen[name] = (await ctx.tx.query('SELECT app.current_tenant_id() AS tenant_id')).rows[0].tenant_id;
      await ctx.ports.IdentityPort.assertRole(ctx, {});
      return { status: 200, body: {} };
    };
    await Promise.all([rig.run({ claims: claimsA, handler: h('a') }), rig.run({ claims: claimsB, handler: h('b') })]);
    expect(seen).toEqual({ a: TENANT_A, b: TENANT_B });
    expect(await rig.fake.tenantOutsideTx()).toBeNull();
  });

  it('public operation without tenant: NO database transaction, no connection taken from the pool', async () => {
    const rig = makeRig({ handler: async (_r, ctx) => { expect(ctx.tx).toBeUndefined(); expect(ctx.tenantId).toBeUndefined(); return { status: 200, body: {} }; } });
    await rig.run({ op: op({ public: true, context: undefined }), claims: undefined });
    expect(rig.fake.state.connects).toBe(0);
    expect(count(rig, /^BEGIN/i)).toBe(0);
  });

  it('serialization failure (40001) before commit: the whole handler is retried in a new transaction; idempotency begin is NOT repeated', async () => {
    const rig = makeRig();
    let runs = 0;
    rig.idem.beginResult = { action: 'proceed', handle: { key: 'k1' } };
    const r = await rig.run({
      op: op({ idempotency: 'required' }), idempotencyKey: 'k1',
      handler: async (_q: any, ctx: any) => {
        runs++;
        if (runs === 1) throw pgError('40001');
        await ctx.ports.IdentityPort.assertRole(ctx, {});
        return { status: 201, body: { id: 'x' } };
      },
    });
    expect(r.status).toBe(201);
    expect(runs).toBe(2);
    expect(rig.idem.begin).toHaveLength(1);
    expect(count(rig, /^BEGIN/i)).toBe(2);
  });

  it('claims are taken from the call (stage 4 result), never from request headers/body', async () => {
    const rig = makeRig();
    await rig.run({ req: { params: {}, query: {}, headers: { 'x-tenant-id': TENANT_B, authorization: 'x' }, body: { tenant_id: TENANT_B } } });
    expect(rig.fake.openingClaims().tenant_id).toBe(TENANT_A);
  });
});
