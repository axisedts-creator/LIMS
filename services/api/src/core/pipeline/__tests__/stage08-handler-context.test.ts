// T0D-18 stage 8 (02-TRD §6.2 row 8, §6.3; AC-0D-6.1; LD-133): the handler gets the FULL HandlerContext with exactly the §6.3 members.
import { describe, expect, it } from 'vitest';
import { claimsA, count, makeRig, MEMBERSHIP, op, pgError, REQ_ID, SUB, TENANT_A } from './helpers.js';

const MEMBERS = [
  'tenantId', 'actor', 'requestId', 'tx', 'now', 'ports', 'db', 'core', 'audit', 'events', 'rateLimit', 'uploads', 'files', 'storage',
  'log', 'services', 'operationId', 'clientIp', 'download', 'commitOnError', 'noRetry',
];

async function capture(over: Record<string, unknown> = {}, rigOpts: Parameters<typeof makeRig>[0] = {}) {
  let ctx: any;
  const rig = makeRig(rigOpts);
  await rig.run({ handler: async (_r: any, c: any) => { ctx = c; await c.ports.IdentityPort.assertRole(c, {}); return { status: 200, body: {} }; }, ...over });
  return { ctx, rig };
}

describe('stage 8 handler context', () => {
  it('has exactly the 02-TRD §6.3 members (no more, no fewer)', async () => {
    const { ctx } = await capture();
    expect(Object.keys(ctx).sort()).toEqual([...MEMBERS].sort());
  });

  it('RequestContext part: tenantId, actor, requestId from the verified claims; tx is the request transaction; now() is the transaction time', async () => {
    const { ctx } = await capture();
    expect(ctx.tenantId).toBe(TENANT_A);
    expect(ctx.actor).toMatchObject({ type: 'user', id: SUB, membershipId: MEMBERSHIP });
    expect(ctx.requestId).toBe(REQ_ID);
    expect(typeof ctx.tx.query).toBe('function');
    expect(typeof ctx.now()).toBe('string');
    expect(ctx.now()).toBe(ctx.tx.startedAt.toISOString());
  });

  it('clientIp, operationId, log come from the call; services is the module\'s own createServices result', async () => {
    const { ctx, rig } = await capture();
    expect(ctx.clientIp).toBe('203.0.113.9');
    expect(ctx.operationId).toBe('createThing');
    expect(ctx.log).toBe(rig.rec.log);
    expect(ctx.services).toBe(rig.services.frontdesk);
  });

  it('shared core pieces are handed through unchanged: core, events, uploads, files, storage, download', async () => {
    const { ctx, rig } = await capture();
    for (const k of ['core', 'events', 'uploads', 'files', 'storage', 'download'] as const) expect(ctx[k], k).toBe(rig.shared[k]);
  });

  it('ports: ctx.ports is the registry view of THIS module; AC-0D-6.1 the fake CatalogPort is reachable', async () => {
    const { ctx } = await capture();
    expect(ctx.ports.CatalogPort).toBeDefined();
    expect(typeof ctx.ports.IdentityPort.assertRole).toBe('function');
  });

  it('ctx.db.tx(fn) runs fn in a SAVEPOINT of the request transaction; a throw rolls back to it and the request goes on', async () => {
    let inner = 0;
    const rig = makeRig();
    const r = await rig.run({
      handler: async (_q: any, ctx: any) => {
        await ctx.db.tx(async () => { inner++; });
        await ctx.db.tx(async () => { throw new Error('inner'); }).catch(() => undefined);
        await ctx.ports.IdentityPort.assertRole(ctx, {});
        return { status: 200, body: {} };
      },
    });
    expect(r.status).toBe(200);
    expect(inner).toBe(1);
    expect(count(rig, /^SAVEPOINT s1/)).toBe(1);
    expect(count(rig, /^ROLLBACK TO SAVEPOINT s2/)).toBe(1);
    expect(count(rig, /^COMMIT/)).toBe(1);
    expect(count(rig, /^BEGIN/)).toBe(1);
  });

  it('ctx.rateLimit.consume(tier, key) goes to the limiter (handler-driven tiers)', async () => {
    const { ctx, rig } = await capture();
    rig.rl.calls.length = 0;
    await ctx.rateLimit.consume('login', 'a:someone');
    expect(rig.rl.calls).toEqual([['login', 'a:someone']]);
  });

  it('ctx.audit.access exists and is bound to the request (takes only the entry)', async () => {
    const { ctx } = await capture();
    expect(typeof ctx.audit.access).toBe('function');
    expect(ctx.audit.access.length).toBeLessThanOrEqual(1);
  });

  it('the context is frozen and per request: a second request gets a different object and its own tx', async () => {
    const a = await capture();
    const b = await capture();
    expect(Object.isFrozen(a.ctx)).toBe(true);
    expect(a.ctx).not.toBe(b.ctx);
    expect(a.ctx.tx).not.toBe(b.ctx.tx);
  });

  it('a transaction kept past its request cannot be used (no leak to a reused server connection)', async () => {
    const { ctx } = await capture();
    await expect(ctx.tx.query('SELECT 1')).rejects.toMatchObject({ code: 'common.internal' });
  });

  it('public operation: handler gets the context without tx/tenantId but with log, clientIp, operationId, ports, services, rateLimit', async () => {
    let ctx: any;
    const rig = makeRig({ handler: async (_r, c) => { ctx = c; return { status: 200, body: {} }; } });
    await rig.run({ op: op({ public: true, context: undefined }), claims: undefined });
    expect(ctx.tx).toBeUndefined();
    expect(ctx.tenantId).toBeUndefined();
    for (const k of ['log', 'clientIp', 'operationId', 'ports', 'services', 'rateLimit', 'commitOnError', 'noRetry']) expect(ctx[k], k).toBeDefined();
  });

  it('AC-0D-2.7: ctx.noRetry() -> a 40001 in this request is not retried and ends 503 common.dependency_unavailable', async () => {
    const rig = makeRig();
    let runs = 0;
    const e: any = await rig.run({
      handler: async (_q: any, ctx: any) => { runs++; ctx.noRetry(); throw pgError('40001'); },
    }).catch((x) => x);
    expect(runs).toBe(1);
    expect(e.code).toBe('common.dependency_unavailable');
    expect(e.statusCode).toBe(503);
  });

  it('handler result headers/body/status are returned unchanged', async () => {
    const rig = makeRig({ handler: async (_r, ctx) => { await ctx.ports.IdentityPort.assertRole(ctx, {}); return { status: 201, body: { a: 1 }, headers: { 'x-h': 'v' } }; } });
    expect(await rig.run()).toMatchObject({ status: 201, body: { a: 1 }, headers: { 'x-h': 'v' } });
  });

  it('claims keep their own shape: claimsA is not mutated by building the context', async () => {
    const before = JSON.stringify(claimsA);
    await capture();
    expect(JSON.stringify(claimsA)).toBe(before);
  });
});
