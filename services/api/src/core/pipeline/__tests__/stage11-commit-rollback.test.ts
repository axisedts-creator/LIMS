// T0D-18 stage 11 (02-TRD §6.2 row 11, 08 A19 P-42): commit on status < 400; on >= 400 the transaction ROLLS BACK unless the handler
// called ctx.commitOnError() (explicit only). Whatever happens the connection goes back to the pool outside a transaction.
import { describe, expect, it } from 'vitest';
import { count, lastTxEnd, LimsError, makeRig, rejects } from './helpers.js';

const asserted = (status: number, body: unknown = {}) => async (_r: any, ctx: any) => {
  await ctx.ports.IdentityPort.assertRole(ctx, {});
  return { status, body };
};

describe('stage 11 commit / rollback', () => {
  it.each([200, 201, 202, 204, 302])('%i -> COMMIT, no ROLLBACK', async (status) => {
    const rig = makeRig({ handler: asserted(status) });
    await rig.run();
    expect(lastTxEnd(rig)).toBe('COMMIT');
    expect(count(rig, /^ROLLBACK$/)).toBe(0);
  });

  it.each([400, 401, 403, 404, 409, 422, 429, 500, 503])('%i result -> ROLLBACK, no COMMIT; the result is still returned', async (status) => {
    const rig = makeRig({ handler: async () => ({ status, body: { code: 'x' } }) });
    const r = await rig.run();
    expect(r).toMatchObject({ status, body: { code: 'x' } });
    expect(lastTxEnd(rig)).toBe('ROLLBACK');
    expect(count(rig, /^COMMIT/)).toBe(0);
  });

  it('thrown LimsError -> ROLLBACK, error rethrown unchanged', async () => {
    const rig = makeRig({ handler: async () => { throw new LimsError('common.not_found'); } });
    const e = await rejects(rig.run());
    expect(e.code).toBe('common.not_found');
    expect(lastTxEnd(rig)).toBe('ROLLBACK');
  });

  it('ctx.commitOnError() + 4xx result -> COMMIT (security counters, denied access-log rows survive)', async () => {
    const rig = makeRig({ handler: async (_r, ctx) => { ctx.commitOnError(); return { status: 403, body: {} }; } });
    const r = await rig.run();
    expect(r.status).toBe(403);
    expect(lastTxEnd(rig)).toBe('COMMIT');
  });

  it('ctx.commitOnError() + 5xx result -> COMMIT as well (explicit marker is honoured for every >= 400)', async () => {
    const rig = makeRig({ handler: async (_r, ctx) => { ctx.commitOnError(); return { status: 500, body: {} }; } });
    await rig.run();
    expect(lastTxEnd(rig)).toBe('COMMIT');
  });

  it('ctx.commitOnError() then a thrown LimsError -> COMMIT first, then the error is rethrown', async () => {
    const rig = makeRig({ handler: async (_r, ctx) => { ctx.commitOnError(); throw new LimsError('auth.forbidden'); } });
    const e = await rejects(rig.run());
    expect(e.code).toBe('auth.forbidden');
    expect(lastTxEnd(rig)).toBe('COMMIT');
  });

  it('commitOnError is per request: it does not leak into the next request', async () => {
    const rig = makeRig({ handler: async (_r, ctx) => { ctx.commitOnError(); return { status: 403, body: {} }; } });
    await rig.run();
    const rig2 = makeRig({ handler: async () => ({ status: 403, body: {} }) });
    await rig2.run();
    expect(lastTxEnd(rig2)).toBe('ROLLBACK');
  });

  it('commitOnError does NOT rescue a database error: a failing statement still rolls back and maps to its code', async () => {
    const rig = makeRig({ handler: async (_r, ctx) => { ctx.commitOnError(); throw Object.assign(new Error('boom'), { code: '57014' }); } });
    const e = await rejects(rig.run());
    expect(e.code).toBe('common.dependency_unavailable');
    expect(lastTxEnd(rig)).toBe('ROLLBACK');
  });

  it('the connection is back in the pool outside a transaction after every outcome (commit, rollback, throw)', async () => {
    const rig = makeRig({ handler: async () => ({ status: 404, body: {} }) });
    await rig.run();
    await rig.run({ handler: async () => { throw new LimsError('common.not_found'); } }).catch(() => undefined);
    await rig.run({ handler: asserted(200) });
    expect(rig.fake.state.releases).toBe(rig.fake.state.connects);
    expect(rig.fake.state.releasedInTx).toBe(0);
    expect(rig.inTx()).toBe(false);
  });
});
