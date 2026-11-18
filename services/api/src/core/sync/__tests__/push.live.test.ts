// T0B-SYNC-2 done_when (2), (3), (6), (7 metrics): pushSyncBatch against a real PG17 (RLS on). Adapters are the test adapters of helpers2.ts (the real ones come in T0B-SYNC-3/4).
// Fails today: createSyncPart2Handlers does not exist (module load error).
import { describe, expect, it } from 'vitest';
import { A1, A2, B1, TENANT_A, USER, ADAPTERS, code, collect, devicePush, effects, engine, enter, entered, iso, ledger, newDevice, NOW, okBody, op, ownerRows, receipt, uid, verify, wipe, revoke, AADM, createSyncPart2Handlers, syncPart2Handlers, fire2 } from './helpers2.js';

const T = 120_000;
const H = engine();
const results = (o: any): any[] => okBody(o).results;
const byId = (o: any): Record<string, any> => Object.fromEntries(results(o).map((r) => [r.op_id, r]));
const sumInc = (m: any[], name: string, status?: string): number => m.filter((x) => x.kind === 'inc' && x.name === name && (status === undefined || x.labels?.status === status)).reduce((a, x) => a + (x.v ?? 1), 0);

describe('limits are enforced before any work (done_when 2)', () => {
  it('51 operations: sync.batch_too_large for the whole request, nothing written, no adapter called', async () => {
    const dev = await newDevice(A1);
    const ops = Array.from({ length: 51 }, () => enter());
    const before = entered.length;
    const o = await devicePush(H, A1, dev, ops);
    expect(code(o)).toBe('sync.batch_too_large');
    expect(await ledger(ops.map((x) => x.op_id))).toEqual([]);
    expect(entered.length).toBe(before);
  }, T);
  it('exactly 50 operations are accepted', async () => {
    const dev = await newDevice(A1);
    const ops = Array.from({ length: 50 }, (_, i) => enter({}, new Date(NOW.getTime() - 3_600_000 + i * 1000)));
    const rs = results(await devicePush(H, A1, dev, ops));
    expect(rs).toHaveLength(50);
    expect(rs.every((r) => r.status === 'accepted')).toBe(true);
  }, T);
  it('more than 1 MB (1048576 bytes) in one request: sync.batch_too_large, nothing written', async () => {
    const dev = await newDevice(A1);
    const big = enter({ payload: { tag: 'x'.repeat(1_100_000) } });
    const o = await devicePush(H, A1, dev, [big]);
    expect(code(o)).toBe('sync.batch_too_large');
    expect(await ledger([big.op_id])).toEqual([]);
  }, T);
  it('the limits come from settings (maxBatchOperations, maxBatchBytes)', async () => {
    const dev = await newDevice(A1);
    const h = engine({ maxBatchOperations: 2, maxBatchBytes: 2000 });
    expect(code(await devicePush(h, A1, dev, [enter(), enter(), enter()]))).toBe('sync.batch_too_large');
    expect(code(await devicePush(h, A1, dev, [enter({ payload: { tag: 'y'.repeat(3000) } })]))).toBe('sync.batch_too_large');
    expect(results(await devicePush(h, A1, dev, [enter(), enter()])).map((r) => r.status)).toEqual(['accepted', 'accepted']);
  }, T);
  it('an empty batch, a missing device id, a non object payload and an unknown op_type are common.validation_failed and write nothing', async () => {
    const dev = await newDevice(A1);
    const bad = enter({ payload: [] as any });
    const unk = op('patient.delete');
    expect(code(await devicePush(H, A1, dev, []))).toBe('common.validation_failed');
    expect(code(await devicePush(H, A1, 'not-a-uuid', [enter()]))).toBe('common.validation_failed');
    expect(code(await devicePush(H, A1, dev, [bad]))).toBe('common.validation_failed');
    expect(code(await devicePush(H, A1, dev, [unk]))).toBe('common.validation_failed');
    expect(await ledger([bad.op_id, unk.op_id])).toEqual([]);
  }, T);
});

describe('the device must be active and belong to the signed in user (done_when 2)', () => {
  it('unknown id, another user\'s device and another tenant\'s device are all sync.device_unknown (no oracle); nothing runs', async () => {
    const dev = await newDevice(A1);
    const o1 = enter(), o2 = enter(), o3 = enter();
    expect(code(await devicePush(H, A1, uid(), [o1]))).toBe('sync.device_unknown');
    expect(code(await devicePush(H, A2, dev, [o2]))).toBe('sync.device_unknown');
    expect(code(await devicePush(H, B1, dev, [o3]))).toBe('sync.device_unknown');
    expect(await ledger([o1.op_id, o2.op_id, o3.op_id])).toEqual([]);
  }, T);
  it('revoked device: sync.device_revoked, wipe pending: sync.wipe_required, both before any operation is read', async () => {
    const d1 = await newDevice(A1), d2 = await newDevice(A1);
    await revoke(AADM, d1); await wipe(AADM, d2);
    const a = enter(), b = enter();
    const before = entered.length;
    expect(code(await devicePush(H, A1, d1, [a]))).toBe('sync.device_revoked');
    expect(code(await devicePush(H, A1, d2, [b]))).toBe('sync.wipe_required');
    expect(await ledger([a.op_id, b.op_id])).toEqual([]);
    expect(entered.length).toBe(before);
  }, T);
  it('needs sync.use (auth.forbidden otherwise) and a staff user actor', async () => {
    const dev = await newDevice(A1);
    const o = await devicePush(H, A1, dev, [enter()], { grants: { codes: [] } });
    expect(code(o)).toBe('auth.forbidden'); expect(o.asserted).toContain('sync.use');
    expect(code(await devicePush(H, { ...A1, type: 'patient' }, dev, [enter()]))).toBe('auth.forbidden');
  }, T);
  it('a successful push touches the device (last_sync_at = server time)', async () => {
    const dev = await newDevice(A1);
    okBody(await devicePush(H, A1, dev, [enter()]));
    const r = await ownerRows('SELECT last_sync_at FROM core.sync_device WHERE id = $1', [dev]);
    expect(new Date(r[0].last_sync_at).toISOString()).toBe(NOW.toISOString());
  }, T);
});

describe('order and isolation of operations (done_when 2)', () => {
  it('operations run in device_created_at then op_id order, whatever the order sent; results come back in the order sent', async () => {
    const dev = await newDevice(A1);
    const t = (m: number) => new Date(NOW.getTime() - 7_200_000 + m * 60_000);
    const [lo, hi] = [uid(), uid()].sort();
    const a = enter({ op_id: hi! }, t(5)), b = enter({ op_id: lo! }, t(5)), c = enter({}, t(1)), d = enter({}, t(9));
    entered.length = 0;
    const sent = [d, a, c, b];
    const rs = results(await devicePush(H, A1, dev, sent));
    expect(entered).toEqual([c.op_id, b.op_id, a.op_id, d.op_id]);
    expect(rs.map((r) => r.op_id)).toEqual(sent.map((x) => x.op_id));
  }, T);
  it('one bad operation never fails the batch: each operation has its own transaction, a failed one leaves no effect', async () => {
    const dev = await newDevice(A1);
    const t = (m: number) => new Date(NOW.getTime() - 3_600_000 + m * 1000);
    const ok1 = enter({ payload: { tag: 'ok1' } }, t(1)), locked = enter({ payload: { tag: 'l', fail: 'lab.result_locked' } }, t(2)), boom = enter({ payload: { tag: 'b', boom: true } }, t(3));
    const inv = enter({ payload: { tag: 'i', invalid: true } }, t(4)), outside = enter({ payload: { tag: 'o', fail: 'common.rate_limited' } }, t(5)), ok2 = enter({ payload: { tag: 'ok2' } }, t(6));
    const o = await devicePush(H, A1, dev, [ok1, locked, boom, inv, outside, ok2]);
    expect(o.reply!.status).toBe(200);
    const r = byId(o);
    expect([r[ok1.op_id].status, r[ok2.op_id].status]).toEqual(['accepted', 'accepted']);
    expect(r[locked.op_id]).toMatchObject({ status: 'rejected', error_code: 'lab.result_locked' });
    expect(r[boom.op_id]).toMatchObject({ status: 'rejected', error_code: 'common.internal' });
    expect(r[inv.op_id]).toMatchObject({ status: 'rejected', error_code: 'common.validation_failed' });
    expect(r[outside.op_id]).toMatchObject({ status: 'rejected', error_code: 'common.internal' });   // closed list: a registry code outside SyncErrorCode never reaches the client
    expect(JSON.stringify(o.reply!.body) + o.logs.join('\n')).not.toMatch(/secret-detail/);
    const fx = await effects([ok1, locked, boom, inv, outside, ok2].map((x) => x.op_id));
    expect(fx.map((x) => x.tag).sort()).toEqual(['ok1', 'ok2']);          // rolled back for every rejected operation
    const l = await ledger([ok1, locked, boom, inv, outside, ok2].map((x) => x.op_id));
    expect(l).toHaveLength(6);                                             // every operation, rejected ones too, has a ledger row
    expect(Object.fromEntries(l.map((x) => [x.op_id, [x.status, x.error_code]]))).toMatchObject({
      [locked.op_id]: ['rejected', 'lab.result_locked'], [boom.op_id]: ['rejected', 'common.internal'], [ok1.op_id]: ['accepted', null] });
  }, T);
  it('an operation type without an adapter is rejected per operation with sync.op_type_not_available (never accepted, never a server error)', async () => {
    const dev = await newDevice(A1);
    const ops = [op('registration.create_order'), op('billing.record_receipt', { entity_id: uid() }), op('collection.mark_collected', { base_version: 1, entity_id: uid() }), op('accession.receive', { base_version: 1, entity_id: uid() }),
      op('result.enter'), op('result.verify', { base_version: 1, entity_id: uid() }), op('report.print_marker', { entity_id: uid() }), op('daily_cash.close', { base_version: 1, entity_id: uid() })];
    const o = await devicePush(syncPart2Handlers, A1, dev, ops);
    expect(o.reply!.status).toBe(200);
    for (const r of results(o)) expect(r, r.op_id).toMatchObject({ status: 'rejected', error_code: 'sync.op_type_not_available' });
    const l = await ledger(ops.map((x) => x.op_id));
    expect(l.map((x) => [x.status, x.error_code])).toEqual(ops.map(() => ['rejected', 'sync.op_type_not_available']));
  }, T);
  it('a type with an adapter next to a type without: the first works, the second is rejected, the batch is 200', async () => {
    const dev = await newDevice(A1);
    const good = enter(), none = op('daily_cash.close', { base_version: 1, entity_id: uid() });
    const r = byId(await devicePush(H, A1, dev, [good, none]));
    expect(r[good.op_id]!.status).toBe('accepted'); expect(r[none.op_id]).toMatchObject({ status: 'rejected', error_code: 'sync.op_type_not_available' });
  }, T);
});

describe('the engine executes as the signed in user with the permissions the user has NOW (done_when 2, 8)', () => {
  it('the adapter sees the authenticated user, the op id as idempotency key, and each adapter permission is asserted per operation', async () => {
    const dev = await newDevice(A1);
    const a = enter(), b = receipt();
    const o = await devicePush(H, A1, dev, [a, b]);
    okBody(o);
    const fx = await effects([a.op_id, b.op_id]);
    expect(fx.map((x) => [x.actor_id, x.idempotency_key])).toEqual(expect.arrayContaining([[USER.a1, a.op_id], [USER.a1, b.op_id]]));
    expect(o.asserted).toEqual(expect.arrayContaining(['sync.use', 'lab.result.enter', 'billing.payment.record']));
  }, T);
  it('permission removed between offline work and sync: only that operation is rejected auth.forbidden, nothing executes for it, the rest goes on', async () => {
    const dev = await newDevice(A1);
    const a = enter({ payload: { tag: 'A' } }), b = receipt({ payload: { tag: 'B' } }), c = collect({ payload: { tag: 'C' } });
    const o = await devicePush(H, A1, dev, [a, b, c], { grants: { codes: (p) => p !== 'lab.result.enter' } });
    const r = byId(o);
    expect(r[a.op_id]).toMatchObject({ status: 'rejected', error_code: 'auth.forbidden' });
    expect(r[b.op_id]!.status).toBe('accepted'); expect(r[c.op_id]!.status).toBe('accepted');
    expect((await effects([a.op_id])).length).toBe(0);
    expect((await ledger([a.op_id]))[0]).toMatchObject({ status: 'rejected', error_code: 'auth.forbidden' });
  }, T);
});

describe('replay, duplicates and op_id reuse (done_when 2, 8)', () => {
  it('replaying a batch twice gives identical results (status duplicate), changes nothing and writes no second effect or ledger row', async () => {
    const dev = await newDevice(A1);
    const a = enter({ payload: { tag: 'a' } }), b = receipt({ payload: { tag: 'b', numbers: true, n: 7 } }), c = enter({ payload: { tag: 'c', fail: 'lab.result_locked' } });
    const ids = [a, b, c].map((x) => x.op_id);
    const first = results(await devicePush(H, A1, dev, [a, b, c]));
    const snap = JSON.stringify([await ledger(ids), await effects(ids)]);
    const second = results(await devicePush(H, A1, dev, [a, b, c]));
    const third = results(await devicePush(H, A1, dev, [c, b, a]));
    expect(first.map((r) => r.status)).toEqual(['accepted', 'accepted', 'rejected']);
    for (const again of [second, third]) for (const r of again) {
      const f = first.find((x) => x.op_id === r.op_id)!;
      expect(r.status, r.op_id).toBe('duplicate');
      expect({ ...r, status: undefined }, r.op_id).toEqual({ ...f, status: undefined });   // same entity, same number mappings, same error code of the first outcome
    }
    expect(JSON.stringify([await ledger(ids), await effects(ids)])).toBe(snap);
    expect(first[1].number_mappings).toEqual([{ document_type: 'receipt', provisional_number: 'OFF-5C0001-7', final_number: expect.stringMatching(/^RCP-2083-/) }]);
  }, T);
  it('the same op_id twice inside one batch: the second is duplicate and runs nothing', async () => {
    const dev = await newDevice(A1);
    const a = enter();
    const rs = results(await devicePush(H, A1, dev, [a, { ...a }]));
    expect(rs.map((r) => r.status)).toEqual(['accepted', 'duplicate']);
    expect((await effects([a.op_id]))).toHaveLength(1);
  }, T);
  it('a replay answers the stored result even when the permission is gone now or the device is another device of the same user', async () => {
    const d1 = await newDevice(A1), d2 = await newDevice(A1);
    const a = enter();
    okBody(await devicePush(H, A1, d1, [a]));
    expect(results(await devicePush(H, A1, d1, [a], { grants: { codes: (p) => p === 'sync.use' } }))[0].status).toBe('duplicate');
    expect(results(await devicePush(H, A1, d2, [a]))[0].status).toBe('duplicate');
  }, T);
  it('the same op_id with another payload hash is rejected sync.op_id_reused; the stored operation and its effect stay as they were', async () => {
    const dev = await newDevice(A1);
    const a = enter({ payload: { tag: 'original' } });
    okBody(await devicePush(H, A1, dev, [a]));
    const snap = JSON.stringify([await ledger([a.op_id]), await effects([a.op_id])]);
    const tampered = { ...a, payload: { tag: 'tampered' } };
    const other = { ...a, entity_id: uid() };
    const typed = { ...a, op_type: 'collection.mark_collected', base_version: 1, entity_id: uid() };
    for (const t of [tampered, other, typed]) expect(results(await devicePush(H, A1, dev, [t as any]))[0], JSON.stringify(t).slice(0, 60)).toMatchObject({ op_id: a.op_id, status: 'rejected', error_code: 'sync.op_id_reused' });
    expect(JSON.stringify([await ledger([a.op_id]), await effects([a.op_id])])).toBe(snap);
  }, T);
  it('the payload hash is canonical: the same content with another key order is a duplicate, not a reuse', async () => {
    const dev = await newDevice(A1);
    const a = enter({ payload: { tag: 't', nested: { a: 1, b: [1, 2, { c: 3, d: 4 }] }, z: true } });
    okBody(await devicePush(H, A1, dev, [a]));
    const reordered = { ...a, payload: { z: true, nested: { b: [1, 2, { d: 4, c: 3 }], a: 1 }, tag: 't' } };
    expect(results(await devicePush(H, A1, dev, [reordered]))[0].status).toBe('duplicate');
  }, T);
  it('another user of the tenant cannot read a result through a known op_id: it is sync.op_id_reused for them, the owner\'s row is untouched', async () => {
    const d1 = await newDevice(A1), d2 = await newDevice(A2);
    const a = enter({ payload: { tag: 'mine' } });
    okBody(await devicePush(H, A1, d1, [a]));
    const snap = JSON.stringify(await ledger([a.op_id]));
    expect(results(await devicePush(H, A2, d2, [a]))[0]).toMatchObject({ status: 'rejected', error_code: 'sync.op_id_reused' });
    expect(JSON.stringify(await ledger([a.op_id]))).toBe(snap);
  }, T);
});

describe('ledger row, time and clock skew (done_when 6)', () => {
  const skewed = async (header: string | undefined, ops: any[], h = H) => {
    const dev = await newDevice(A1);
    return devicePush(h, A1, dev, ops, header === undefined ? {} : { headers: { 'x-device-time': header } });
  };
  it('device_created_at and server_received_at are both stored; the server time is the transaction time, the device time is kept as sent', async () => {
    const old = new Date(NOW.getTime() - 3 * 86_400_000);       // an outage of 3 days is normal: age alone is NOT skew
    const a = enter({ payload: { tag: 'a' } }, old);
    const r = results(await skewed(iso(NOW), [a]))[0];
    expect(r).toMatchObject({ status: 'accepted', skew_flag: false });
    const l = (await ledger([a.op_id]))[0];
    expect(new Date(l.device_created_at).toISOString()).toBe(old.toISOString());
    expect(new Date(l.server_received_at).toISOString()).toBe(NOW.toISOString());
    expect(l).toMatchObject({ tenant_id: TENANT_A, user_id: USER.a1, op_type: 'result.enter', status: 'accepted', skew_flag: false });
    expect(l.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(l.payload).toEqual({ tag: 'a' });
    expect(l.result).toMatchObject({ op_id: a.op_id, status: 'accepted' });
  }, T);
  it('no header: no skew is known, an old operation is not flagged', async () => {
    const a = enter({}, new Date(NOW.getTime() - 5 * 86_400_000));
    expect(results(await skewed(undefined, [a]))[0]).toMatchObject({ status: 'accepted', skew_flag: false });
  }, T);
  it('device clock 10 minutes ahead or behind (limit 5): accepted with skew_flag true on the result and the ledger; a malformed header is ignored', async () => {
    for (const sign of [1, -1]) {
      const a = enter();
      expect(results(await skewed(iso(new Date(NOW.getTime() + sign * 600_000)), [a]))[0]).toMatchObject({ status: 'accepted', skew_flag: true });
      expect((await ledger([a.op_id]))[0].skew_flag).toBe(true);
    }
    const m = enter();
    expect(results(await skewed('yesterday-ish', [m]))[0]).toMatchObject({ status: 'accepted', skew_flag: false });
  }, T);
  it('4 minutes is inside the limit; the limit is a setting (skewFlagMs)', async () => {
    expect(results(await skewed(iso(new Date(NOW.getTime() + 240_000)), [enter()]))[0].skew_flag).toBe(false);
    expect(results(await skewed(iso(new Date(NOW.getTime() + 120_000)), [enter()], engine({ skewFlagMs: 60_000 })))[0].skew_flag).toBe(true);
  }, T);
  it('an operation dated in the future (beyond the limit) is flagged even without a header', async () => {
    const a = enter({}, new Date(NOW.getTime() + 600_000));
    expect(results(await skewed(undefined, [a]))[0]).toMatchObject({ status: 'accepted', skew_flag: true });
  }, T);
  it('beyond 24 hours: every operation is rejected sync.clock_skew_too_large, nothing executes; just under 24 hours is only flagged', async () => {
    const a = enter({ payload: { tag: 'late' } }), b = receipt();
    const rs = results(await skewed(iso(new Date(NOW.getTime() + 25 * 3_600_000)), [a, b]));
    expect(rs.map((r) => [r.status, r.error_code])).toEqual([['rejected', 'sync.clock_skew_too_large'], ['rejected', 'sync.clock_skew_too_large']]);
    expect(await effects([a.op_id, b.op_id])).toEqual([]);
    expect((await ledger([a.op_id]))[0]).toMatchObject({ status: 'rejected', error_code: 'sync.clock_skew_too_large' });
    const c = enter();
    expect(results(await skewed(iso(new Date(NOW.getTime() - 23 * 3_600_000)), [c]))[0]).toMatchObject({ status: 'accepted', skew_flag: true });
    const future = enter({}, new Date(NOW.getTime() + 25 * 3_600_000));
    expect(results(await skewed(undefined, [future]))[0]).toMatchObject({ status: 'rejected', error_code: 'sync.clock_skew_too_large' });
  }, T);
});

describe('metrics (done_when 7)', () => {
  it('counts accepted, duplicate, rejected and conflict operations per status', async () => {
    const dev = await newDevice(A1);
    const a = enter(), bad = enter({ payload: { fail: 'lab.result_locked' } }), cf = verify({ payload: { conflict: true } });
    okBody(await devicePush(H, A1, dev, [a]));
    const metrics: any[] = [];
    okBody(await devicePush(H, A1, dev, [a, bad, cf, enter()], { metrics }));
    expect(sumInc(metrics, 'lims_core_sync_operations_total', 'duplicate')).toBe(1);
    expect(sumInc(metrics, 'lims_core_sync_operations_total', 'rejected')).toBe(1);
    expect(sumInc(metrics, 'lims_core_sync_operations_total', 'conflict')).toBe(1);
    expect(sumInc(metrics, 'lims_core_sync_operations_total', 'accepted')).toBe(1);
    expect(JSON.stringify(metrics)).not.toMatch(new RegExp(`${a.op_id}|${USER.a1}|${dev}`));      // no id label (low cardinality, no personal data)
  }, T);
});
export { fire2, createSyncPart2Handlers, ADAPTERS };
