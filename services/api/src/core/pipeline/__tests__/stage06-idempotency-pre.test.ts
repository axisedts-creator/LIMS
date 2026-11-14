// T0D-18 stage 6 (02-TRD §6.2 row 6, §6.6; AC-0D-4.1..4.3): begin() before the request transaction; replay short-circuits.
import { describe, expect, it } from 'vitest';
import { claimsA, count, LimsError, makeRig, op, REQ_ID, rejects, SUB } from './helpers.js';

const idemOp = (over: Record<string, unknown> = {}) => op({ idempotency: 'required', ...over });

describe('stage 6 idempotency (pre)', () => {
  it('hands begin() the operation, method, route template, params, query, body, key, VERIFIED claims, requestId, clientIp, userAgent', async () => {
    const rig = makeRig();
    rig.idem.beginResult = { action: 'proceed', handle: { tenantId: 't', actorId: SUB, key: 'k1' } };
    await rig.run({
      op: idemOp(), idempotencyKey: 'k1',
      req: { params: { id: 'p1' }, query: { q: '1' }, headers: {}, body: { name: 'x' } },
    });
    expect(rig.idem.begin).toHaveLength(1);
    const r = rig.idem.begin[0];
    expect(r).toMatchObject({
      method: 'POST', routeTemplate: '/v1/frontdesk/things', pathParams: { id: 'p1' }, query: { q: '1' }, body: { name: 'x' },
      idempotencyKey: 'k1', claims: claimsA, requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'vitest',
    });
    expect(r.operation).toMatchObject({ module: 'frontdesk', operationId: 'createThing', idempotency: 'required' });
  });

  it('is called BEFORE the request transaction opens (the claim is its own short transaction)', async () => {
    const rig = makeRig();
    rig.idem.beginResult = { action: 'proceed', handle: { key: 'k1' } };
    await rig.run({ op: idemOp(), idempotencyKey: 'k1' });
    expect(rig.order.indexOf('idem.begin')).toBeLessThan(rig.order.findIndex((o) => o.startsWith('handler')));
    expect(count(rig, /^BEGIN/i)).toBe(1); // the fake idempotency opens none; only the request transaction
  });

  it('x-idempotency none: begin() is still the single decision point and returns skip; handler runs', async () => {
    const rig = makeRig();
    const r = await rig.run({ op: op({ idempotency: 'none' }) });
    expect(r.status).toBe(201);
    expect(rig.idem.finish).toEqual([]);
  });

  it('replay: returns the stored status/body with Idempotent-Replayed: true; handler and request transaction never run', async () => {
    const rig = makeRig();
    rig.idem.beginResult = { action: 'replay', status: 201, body: { id: 'old' }, headers: { 'Idempotent-Replayed': 'true' } };
    const r = await rig.run({ op: idemOp(), idempotencyKey: 'k1' });
    expect(r).toMatchObject({ status: 201, body: { id: 'old' }, headers: { 'Idempotent-Replayed': 'true' } });
    expect(rig.order.some((o) => o.startsWith('handler'))).toBe(false);
    expect(count(rig, /^BEGIN/i)).toBe(0);
    expect(rig.idem.finish).toEqual([]);
    expect(rig.idem.release).toEqual([]);
  });

  it.each([
    ['common.idempotency_key_required', 400],
    ['common.idempotency_key_reused', 422],
    ['common.idempotency_in_progress', 409],
  ])('begin() throws %s -> rethrown unchanged (%i), handler not called, no transaction', async (code, status) => {
    const rigT = makeRig();
    rigT.idem.beginError = new LimsError(code);
    const e = await rejects(rigT.run({ op: idemOp(), idempotencyKey: 'k1' }));
    expect(e.code).toBe(code);
    expect(e.statusCode).toBe(status);
    expect(rigT.order.some((o) => o.startsWith('handler'))).toBe(false);
    expect(count(rigT, /^BEGIN/i)).toBe(0);
  });

  it('a public operation never reaches begin() with a handle (no claims): begin() is told so and the pipeline does not invent claims', async () => {
    const rig = makeRig({ handler: async () => ({ status: 200, body: {} }) });
    await rig.run({ op: op({ public: true, idempotency: 'none', context: undefined }), claims: undefined });
    expect(rig.idem.begin.every((b) => b.claims === undefined)).toBe(true);
  });

  it('after a replay the response of a non-replayed first call is unaffected (handler runs once for proceed)', async () => {
    let calls = 0;
    const rig = makeRig({ handler: async (_r, ctx) => { calls++; await ctx.ports.IdentityPort.assertRole(ctx, {}); return { status: 201, body: { id: 'n' } }; } });
    rig.idem.beginResult = { action: 'proceed', handle: { key: 'k1' } };
    await rig.run({ op: idemOp(), idempotencyKey: 'k1' });
    expect(calls).toBe(1);
  });
});

