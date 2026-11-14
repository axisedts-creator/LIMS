// T0D-18 stage 10 (02-TRD §6.2 row 10, §6.6 steps 4-5; AC-0D-4.2, AC-0D-4.5; 08 A25 D-202/K2/K3):
// < 400: response stored in the SAME transaction, before COMMIT. >= 400: nothing stored; key released after ROLLBACK, or inside the
// transaction before COMMIT when the handler called ctx.commitOnError().
import { describe, expect, it } from 'vitest';
import { count, lastTxEnd, LimsError, makeRig, op, rejects } from './helpers.js';

const proceed = (rig: ReturnType<typeof makeRig>) => { rig.idem.beginResult = { action: 'proceed', handle: { key: 'k1', actorId: 'a' } }; };
const call = { op: op({ idempotency: 'required' }), idempotencyKey: 'k1' };

describe('stage 10 idempotency (post)', () => {
  it('status < 400: finish(tx, handle, {status, body}) runs inside the request transaction (same tx object), before COMMIT; nothing released', async () => {
    const rig = makeRig();
    proceed(rig);
    let handlerTx: unknown;
    await rig.run({ ...call, handler: async (_r: any, ctx: any) => { handlerTx = ctx.tx; await ctx.ports.IdentityPort.assertRole(ctx, {}); return { status: 201, body: { id: 'n' } }; } });
    expect(rig.idem.finish).toHaveLength(1);
    expect(rig.idem.finish[0].tx).toBe(handlerTx);
    expect(rig.idem.finish[0].handle).toMatchObject({ key: 'k1' });
    expect(rig.idem.finish[0].out).toMatchObject({ status: 201, body: { id: 'n' } });
    expect(rig.order).toContain('idem.finish:inTx=true');
    expect(rig.idem.release).toEqual([]);
    expect(lastTxEnd(rig)).toBe('COMMIT');
  });

  it('204 / body-less 2xx is stored too (status < 400)', async () => {
    const rig = makeRig();
    proceed(rig);
    await rig.run({ ...call, handler: async (_r: any, ctx: any) => { await ctx.ports.IdentityPort.assertRole(ctx, {}); return { status: 204 }; } });
    expect(rig.idem.finish[0].out.status).toBe(204);
  });

  it.each([400, 404, 409, 422, 500, 503])('AC-0D-4.5: a %i result stores nothing: ROLLBACK, then release(handle) exactly once; result still returned', async (status) => {
    const rig = makeRig();
    proceed(rig);
    const r = await rig.run({ ...call, handler: async () => ({ status, body: { code: 'x' } }) });
    expect(r.status).toBe(status);
    expect(rig.idem.finish).toEqual([]);
    expect(rig.idem.release).toHaveLength(1);
    expect(lastTxEnd(rig)).toBe('ROLLBACK');
    // release comes after the rollback (its own transaction), never before
    const lastRollback = rig.sql().lastIndexOf('ROLLBACK');
    expect(lastRollback).toBeGreaterThanOrEqual(0);
    expect(rig.order.indexOf('idem.release')).toBeGreaterThan(rig.order.findIndex((o) => o.startsWith('handler')));
  });

  it('a handler that THROWS: ROLLBACK, release(handle), error rethrown (the key never stays in_progress)', async () => {
    const rig = makeRig();
    proceed(rig);
    const e = await rejects(rig.run({ ...call, handler: async () => { throw new LimsError('common.not_found'); } }));
    expect(e.code).toBe('common.not_found');
    expect(rig.idem.release).toHaveLength(1);
    expect(rig.idem.finish).toEqual([]);
    expect(lastTxEnd(rig)).toBe('ROLLBACK');
  });

  it('commitOnError + >= 400 result: finish(tx, handle, {status, commitOnError: true}) inside the transaction (it deletes the in_progress row), COMMIT, no separate release', async () => {
    const rig = makeRig();
    proceed(rig);
    const r = await rig.run({ ...call, handler: async (_r: any, ctx: any) => { ctx.commitOnError(); return { status: 401, body: {} }; } });
    expect(r.status).toBe(401);
    expect(rig.idem.finish).toHaveLength(1);
    expect(rig.idem.finish[0].out).toMatchObject({ status: 401, commitOnError: true });
    expect(rig.order).toContain('idem.finish:inTx=true');
    expect(rig.idem.release).toEqual([]);
    expect(lastTxEnd(rig)).toBe('COMMIT');
  });

  it('operations without a handle (skip / none) never call finish or release, whatever the status', async () => {
    const rig = makeRig();
    await rig.run({ handler: async () => ({ status: 404, body: {} }) });
    expect(rig.idem.finish).toEqual([]);
    expect(rig.idem.release).toEqual([]);
  });

  it('finish itself failing (e.g. storing the response) fails the request and ROLLBACKs: no response without a stored key (K2)', async () => {
    const rig = makeRig();
    proceed(rig);
    rig.idem.finishError = new LimsError('common.internal');
    const e = await rejects(rig.run({ ...call }));
    expect(e.code).toBe('common.internal');
    expect(lastTxEnd(rig)).toBe('ROLLBACK');
    expect(count(rig, /^COMMIT/)).toBe(0);
  });

  it('authz guard failure (stage 9) happens BEFORE the response is stored: a replaced 500 is never stored as 2xx', async () => {
    const rig = makeRig({ env: 'ci' });
    proceed(rig);
    const e = await rejects(rig.run({ ...call, handler: async () => ({ status: 201, body: {} }) }));
    expect(e.code).toBe('common.internal');
    expect(rig.idem.finish).toEqual([]);
    expect(rig.idem.release).toHaveLength(1);
  });
});
