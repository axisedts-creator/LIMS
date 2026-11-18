// T0B-SYNC-4 engine extension (pinned in ./doubles4.ts header): SyncAdapter.execute may return { outcome: 'rejected', errorCode } = a per operation rejection that KEEPS the writes of the
// adapter itself (the alert to the lab manager, the recall flags). A plain throw keeps rolling everything back. Real engine + real PG17 (RLS on), a fake adapter only.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../errors.js';
import { A1, devicePush, effects, engine, ledger, newDevice, okBody, op, uid } from '../helpers2.js';

const T = 120_000;
const fake = (opType: string, permission: string, how: (op: any) => any): any => ({
  opType, permission, validate() {},
  async execute(ctx: any, o: any) {
    await ctx.tx.query(`INSERT INTO sync2_test.effect (tenant_id, op_id, op_type, entity_id, actor_id, idempotency_key, tag) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ctx.tenantId, o.opId, opType, o.entityId ?? null, ctx.actor.id, o.idempotencyKey, o.payload?.tag ?? null]);
    return how(o);
  },
});
const one = (o: any): any => okBody(o).results[0];

describe('execute returning { outcome: "rejected", errorCode } (T0B-SYNC-4 engine extension)', () => {
  it('the operation is rejected with the closed code, the adapter writes are KEPT, the batch is 200 and the ledger row says rejected', async () => {
    const H = engine({}, [fake('result.verify', 'lab.result.verify', () => ({ outcome: 'rejected', errorCode: 'sync.verification_policy_failed' }))]);
    const dev = await newDevice(A1);
    const r = op('result.verify', { base_version: 2, entity_id: uid(), payload: { tag: 'kept' } });
    const o = await devicePush(H, A1, dev, [r]);
    expect(o.reply!.status).toBe(200);
    expect(one(o)).toMatchObject({ op_id: r.op_id, status: 'rejected', error_code: 'sync.verification_policy_failed' });
    expect((await effects([r.op_id])).map((x) => x.tag)).toEqual(['kept']);   // the alert / recall writes of an adapter survive its own rejection
    const [l] = await ledger([r.op_id]);
    expect(l).toMatchObject({ status: 'rejected', error_code: 'sync.verification_policy_failed' });
  }, T);

  it('a code outside the closed SyncErrorCode list never reaches the client: common.internal (and the writes are kept, the adapter decided)', async () => {
    const H = engine({}, [fake('result.verify', 'lab.result.verify', () => ({ outcome: 'rejected', errorCode: 'lab.not_in_the_closed_list' }))]);
    const dev = await newDevice(A1);
    const r = op('result.verify', { base_version: 2, entity_id: uid() });
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'rejected', error_code: 'common.internal' });
  }, T);

  it('replay: the same op id answers duplicate with the first outcome and the adapter does not run again', async () => {
    const H = engine({}, [fake('result.verify', 'lab.result.verify', () => ({ outcome: 'rejected', errorCode: 'sync.offline_not_allowed' }))]);
    const dev = await newDevice(A1);
    const r = op('result.verify', { base_version: 2, entity_id: uid(), payload: { tag: 'once' } });
    await devicePush(H, A1, dev, [r]);
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'duplicate', error_code: 'sync.offline_not_allowed' });
    expect(await effects([r.op_id])).toHaveLength(1);
  }, T);

  it('a thrown LimsError still rolls the whole operation back (SYNC-2/3 behaviour is unchanged) and the next operation of the batch runs', async () => {
    const H = engine({}, [fake('result.verify', 'lab.result.verify', () => { throw new LimsError('lab.verifier_not_distinct'); }), fake('result.enter', 'lab.result.enter', () => ({}))]);
    const dev = await newDevice(A1);
    const bad = op('result.verify', { base_version: 2, entity_id: uid(), payload: { tag: 'gone' } }), good = op('result.enter', { payload: { tag: 'there' } });
    const rs = okBody(await devicePush(H, A1, dev, [bad, good])).results;
    expect(rs[0]).toMatchObject({ status: 'rejected', error_code: 'lab.verifier_not_distinct' }); expect(rs[1].status).toBe('accepted');
    expect((await effects([bad.op_id, good.op_id])).map((x) => x.tag)).toEqual(['there']);
  }, T);
});
