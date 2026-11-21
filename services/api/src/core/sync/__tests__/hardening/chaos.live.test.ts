// T0B-SYNC-5 done_when (2) CHAOS (+ the counters of done_when 4): kill the transaction in the middle of a batch, deliver every batch twice, deliver batches out of order, send the same op_id
// from two devices, send a payload that changed after the first delivery, send a batch just under and just over the limits. The end state must be correct and every refusal a closed code.
// Live PG17 (throwaway container only), real pushSyncBatch engine, RLS on, synthetic adapters (./kit.ts).
// HONEST STATUS: guards the engine of T0B-SYNC-2..4 (no production change allowed here, done_when 6); expected to pass on a correct engine, fails on any regression.
import { beforeAll, describe, expect, it } from 'vitest';
import { createMetrics } from '../../../observability/metrics.js';
import { A1, A2, NOW, chaos, closedCodes, code, devicePush, engine, ensureS5, enter as helperEnter, eventsOf, iso, ledgerOf, newDevice, okBody, ownerRows, receiptNos, syncEngine, uid, uuidFor } from './kit.js';

const T = 600_000;
const run = `ch${uid().slice(-8)}`;
const at = (minutesBefore: number): string => iso(new Date(NOW.getTime() - minutesBefore * 60_000));
const enterOp = (o: Record<string, unknown> = {}, minutesBefore = 60): any => ({ op_id: uid(), op_type: 'result.enter', payload: { value: 1 }, device_created_at: at(minutesBefore), ...o });
const receiptOp = (minutesBefore = 50): any => ({ op_id: uid(), op_type: 'billing.record_receipt', entity_id: uuidFor(`${run}-ord-${uid()}`), payload: { amount_received_paisa: 5000 }, device_created_at: at(minutesBefore) });
const results = (o: any): any[] => okBody(o).results;
const nums = (rs: any[]): number[] => rs.filter((r) => r.number_mappings).map((r) => Number(r.number_mappings[0].final_number.slice(4)));
beforeAll(ensureS5);

describe('the transaction is killed in the middle of a batch', () => {
  it('nothing of the batch survives (no ledger row, no effect, no receipt number used); the re-sent batch lands every operation exactly once and the numbers are gap free', async () => {
    const series = `S5K-${run}`;
    const H = syncEngine(series);
    const dev = await newDevice(A1);
    const batch = [enterOp({}, 90), receiptOp(80), enterOp({ payload: { kill: true } }, 70), enterOp({}, 60), receiptOp(50)];
    const ids = batch.map((o) => o.op_id);
    chaos.kill = true;
    let killed: any;
    try { killed = await devicePush(H, A1, dev, batch); } finally { chaos.kill = false; }
    expect(killed.error).toBeTruthy();                                                   // the device got no answer (a dead connection), so it keeps the batch
    expect(await ledgerOf(ids)).toEqual([]);                                             // the one request transaction rolled back as a whole
    expect(await eventsOf(ids)).toEqual([]);
    expect(await receiptNos(series)).toEqual([]);
    expect((await ownerRows('SELECT last_sync_at FROM core.sync_device WHERE id = $1', [dev]))[0].last_sync_at).toBeNull();

    const again = results(await devicePush(H, A1, dev, batch));                          // the device re-sends the SAME batch
    expect(again.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted', 'accepted', 'accepted']);
    expect((await ledgerOf(ids))).toHaveLength(5);
    expect((await eventsOf(ids))).toHaveLength(5);
    expect(await receiptNos(series)).toEqual([1, 2]);                                    // the numbers of the killed attempt were given back: no gap
    expect(nums(again)).toEqual([1, 2]);
  }, T);

  it('a kill in the LAST operation of a batch of 50 leaves nothing either, and the replay is complete', async () => {
    const series = `S5K2-${run}`;
    const H = syncEngine(series);
    const dev = await newDevice(A1);
    const batch = Array.from({ length: 49 }, (_, i) => (i % 3 === 0 ? receiptOp(300 - i) : enterOp({}, 300 - i))).concat([enterOp({ payload: { kill: true } }, 5)]);
    const ids = batch.map((o) => o.op_id);
    chaos.kill = true;
    try { expect((await devicePush(H, A1, dev, batch)).error).toBeTruthy(); } finally { chaos.kill = false; }
    expect(await ledgerOf(ids)).toEqual([]); expect(await receiptNos(series)).toEqual([]);
    const again = results(await devicePush(H, A1, dev, batch));
    expect(again.every((r) => r.status === 'accepted')).toBe(true);
    expect(await receiptNos(series)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
  }, T);
});

describe('every batch is delivered twice', () => {
  it('the second delivery answers duplicate with the FIRST outcome (same entity, same number mapping), applies nothing and uses no number', async () => {
    const series = `S5D-${run}`;
    const H = syncEngine(series);
    const dev = await newDevice(A1);
    const batches = [0, 1, 2].map((b) => [enterOp({}, 200 - b * 10), receiptOp(190 - b * 10), receiptOp(185 - b * 10)]);
    const firsts: any[][] = [];
    for (const b of batches) firsts.push(results(await devicePush(H, A1, dev, b)));
    const ids = batches.flat().map((o) => o.op_id);
    const n = await receiptNos(series);
    expect(n).toEqual([1, 2, 3, 4, 5, 6]);
    for (const [i, b] of batches.entries()) {
      const second = results(await devicePush(H, A1, dev, b));
      expect(second.map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
      expect(second.map((r) => r.op_id)).toEqual(b.map((o) => o.op_id));
      expect(second.map((r) => r.number_mappings)).toEqual(firsts[i]!.map((r) => r.number_mappings));
      expect(second.map((r) => r.entity_id)).toEqual(firsts[i]!.map((r) => r.entity_id));
    }
    expect(await receiptNos(series)).toEqual(n);
    expect(await eventsOf(ids)).toHaveLength(ids.length);
    expect((await ledgerOf(ids)).every((r) => r.status === 'accepted')).toBe(true);        // the stored first outcome is never rewritten by a replay
  }, T);

  it('two copies of the same batch at the same moment: one applies, the other waits (429, retry_after) or answers duplicate; the end state is one application', async () => {
    const series = `S5C-${run}`;
    const H = syncEngine(series);
    const dev = await newDevice(A1);
    const batch = [receiptOp(120), enterOp({}, 110), receiptOp(100)];
    const ids = batch.map((o) => o.op_id);
    const outs = await Promise.all([devicePush(H, A1, dev, batch), devicePush(H, A1, dev, batch)]);
    const ok = outs.filter((o) => !o.error); const refused = outs.filter((o) => o.error);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const o of refused) { expect(code(o)).toBe('common.rate_limited'); expect((o.error as any).retryAfterSeconds).toBeGreaterThan(0); }
    const statuses = ok.flatMap((o) => results(o).map((r) => r.status));
    expect(statuses.filter((s) => s === 'accepted')).toHaveLength(3);
    expect(statuses.every((s) => s === 'accepted' || s === 'duplicate')).toBe(true);
    for (const o of refused) expect(okBody(await devicePush(H, A1, dev, batch)).results.every((r: any) => r.status === 'duplicate')).toBe(true);   // the retry after retry_after
    expect(await ledgerOf(ids)).toHaveLength(3); expect(await eventsOf(ids)).toHaveLength(3);
    expect(await receiptNos(series)).toEqual([1, 2]);
  }, T);
});

describe('batches arrive out of order', () => {
  it('a later batch delivered first: every operation lands once; receipt numbers follow server arrival order and stay gap free; results keep the order the device sent', async () => {
    const series = `S5O-${run}`;
    const H = syncEngine(series);
    const dev = await newDevice(A1);
    const early = [receiptOp(300), enterOp({}, 290), receiptOp(280)];
    const late = [receiptOp(100), enterOp({}, 90), receiptOp(80)];
    const rLate = results(await devicePush(H, A1, dev, late));                           // batch 2 first
    const rEarly = results(await devicePush(H, A1, dev, early));
    expect(rLate.every((r) => r.status === 'accepted') && rEarly.every((r) => r.status === 'accepted')).toBe(true);
    expect(nums(rLate)).toEqual([1, 2]); expect(nums(rEarly)).toEqual([3, 4]);           // arrival order, not device time order
    expect(await receiptNos(series)).toEqual([1, 2, 3, 4]);
    expect(await eventsOf([...early, ...late].map((o) => o.op_id))).toHaveLength(6);
  }, T);

  it('inside one batch the operations run in device_created_at order whatever order they were sent; results are returned in the order sent', async () => {
    const series = `S5I-${run}`;
    const H = syncEngine(series);
    const dev = await newDevice(A1);
    const a = receiptOp(30); const b = receiptOp(20); const c = receiptOp(10);
    const sent = [c, a, b];                                                              // reversed on the wire
    const rs = results(await devicePush(H, A1, dev, sent));
    expect(rs.map((r) => r.op_id)).toEqual(sent.map((o) => o.op_id));
    expect(Object.fromEntries(rs.map((r) => [r.op_id, Number(r.number_mappings[0].final_number.slice(4))]))).toEqual({ [a.op_id]: 1, [b.op_id]: 2, [c.op_id]: 3 });
  }, T);
});

describe('the same op_id from two devices, a changed payload', () => {
  it('same op_id and same payload from a second device of the same user: duplicate with the first outcome, applied once; the ledger keeps the first device', async () => {
    const series = `S5T-${run}`;
    const H = syncEngine(series);
    const [d1, d2] = [await newDevice(A1), await newDevice(A1)];
    const op = receiptOp(60);
    const first = results(await devicePush(H, A1, d1, [op]))[0];
    const second = results(await devicePush(H, A1, d2, [op]))[0];
    expect(first.status).toBe('accepted'); expect(second.status).toBe('duplicate');
    expect(second.number_mappings).toEqual(first.number_mappings);
    expect(await receiptNos(series)).toEqual([1]);
    const row = (await ownerRows('SELECT device_id FROM core.sync_operation WHERE op_id = $1', [op.op_id]));
    expect(row).toHaveLength(1); expect(row[0].device_id).toBe(d1);
  }, T);

  it('same op_id with ANOTHER payload from a second device, or the same payload from ANOTHER user: sync.op_id_reused, nothing applied, the first outcome untouched', async () => {
    const series = `S5U-${run}`;
    const H = syncEngine(series);
    const [d1, d2, d3] = [await newDevice(A1), await newDevice(A1), await newDevice(A2)];
    const op = receiptOp(60);
    const first = results(await devicePush(H, A1, d1, [op]))[0];
    const changed = { ...op, payload: { amount_received_paisa: 9999 } };
    const r2 = results(await devicePush(H, A1, d2, [changed]))[0];
    const r3 = results(await devicePush(H, A2, d3, [op]))[0];
    expect(r2).toMatchObject({ op_id: op.op_id, status: 'rejected', error_code: 'sync.op_id_reused' });
    expect(r3).toMatchObject({ op_id: op.op_id, status: 'rejected', error_code: 'sync.op_id_reused' });
    expect(await receiptNos(series)).toEqual([1]);
    const l = (await ledgerOf([op.op_id]));
    expect(l).toHaveLength(1); expect(l[0].status).toBe('accepted'); expect(l[0].result.number_mappings).toEqual(first.number_mappings);
  }, T);

  it('a payload that changed after the first delivery is refused sync.op_id_reused on every later delivery; the original payload still answers duplicate', async () => {
    const series = `S5P-${run}`;
    const H = syncEngine(series);
    const dev = await newDevice(A1);
    const op = enterOp({ payload: { value: 1 } });
    expect(results(await devicePush(H, A1, dev, [op]))[0].status).toBe('accepted');
    for (const tweak of [{ value: 2 }, { value: 1, extra: true }, {}]) {
      const r = results(await devicePush(H, A1, dev, [{ ...op, payload: tweak }]))[0];
      expect(r).toMatchObject({ status: 'rejected', error_code: 'sync.op_id_reused' });
    }
    expect(results(await devicePush(H, A1, dev, [{ ...op, payload: { value: 1 } }]))[0].status).toBe('duplicate');
    expect((await ownerRows('SELECT payload FROM core.sync_operation WHERE op_id = $1', [op.op_id]))[0].payload).toEqual({ value: 1 });
    expect(await eventsOf([op.op_id])).toHaveLength(1);
  }, T);

  it('key order inside the payload does not change the hash: a re-sent payload with its keys in another order is a duplicate, not a reuse', async () => {
    const H = syncEngine(`S5Q-${run}`);
    const dev = await newDevice(A1);
    const op = enterOp({ payload: { a: 1, b: { c: 2, d: 3 } } });
    expect(results(await devicePush(H, A1, dev, [op]))[0].status).toBe('accepted');
    expect(results(await devicePush(H, A1, dev, [{ ...op, payload: { b: { d: 3, c: 2 }, a: 1 } }]))[0].status).toBe('duplicate');
  }, T);
});

describe('batches just under and just over the limits', () => {
  it('50 operations are accepted, 51 are sync.batch_too_large and leave nothing behind', async () => {
    const H = syncEngine(`S5N-${run}`);
    const dev = await newDevice(A1);
    const fifty = Array.from({ length: 50 }, (_, i) => enterOp({}, 400 - i));
    const rs = results(await devicePush(H, A1, dev, fifty));
    expect(rs).toHaveLength(50); expect(rs.every((r) => r.status === 'accepted')).toBe(true);
    const over = Array.from({ length: 51 }, (_, i) => enterOp({}, 300 - i));
    const metrics: any[] = [];
    const o = await devicePush(H, A1, dev, over, { metrics });
    expect(code(o)).toBe('sync.batch_too_large');
    expect(await ledgerOf(over.map((x) => x.op_id))).toEqual([]);
    expect(metrics.some((m) => m.name === 'lims_core_sync_batches_total' && m.labels?.outcome === 'too_large')).toBe(true);
  }, T);

  it('a body of exactly 1 048 576 bytes is accepted, one byte more is sync.batch_too_large', async () => {
    const H = syncEngine(`S5B-${run}`);
    const dev = await newDevice(A1);
    const mk = (pad: number): any => enterOp({ payload: { pad: 'x'.repeat(pad) } });
    const size = (op: any): number => Buffer.byteLength(JSON.stringify({ device_id: dev, operations: [op] }));
    const probe = mk(0); const room = 1_048_576 - size(probe);
    const exact = { ...probe, payload: { pad: 'x'.repeat(room) } };
    expect(size(exact)).toBe(1_048_576);
    expect(results(await devicePush(H, A1, dev, [exact]))[0].status).toBe('accepted');
    const over = { ...enterOp({}), payload: { pad: 'x'.repeat(room + 1) } };
    expect(size(over)).toBe(1_048_577);
    const o = await devicePush(H, A1, dev, [over]);
    expect(code(o)).toBe('sync.batch_too_large');
    expect(await ledgerOf([over.op_id])).toEqual([]);
  }, T);
});

describe('every refusal is a closed error code', () => {
  it('invalid payload, unknown op type, permission gone, clock too far off, adapter bug, adapter throwing an unregistered code: all per operation, all closed, nothing leaks', async () => {
    const closed = await closedCodes();
    const H = engine();                                                                   // helpers2 test adapters: { invalid } { fail } { boom } switches
    const dev = await newDevice(A1);
    const mk = (payload: Record<string, unknown>, o: Record<string, unknown> = {}): any => helperEnter({ payload, ...o });
    // an OLD operation (25 h) is an outage, not skew (engine.ts: only a FUTURE device time or the x-device-time header counts): it is accepted; 25 h in the FUTURE is refused
    const ops = [mk({ invalid: true }), mk({ fail: 'foo.not_registered' }), mk({ boom: true }), mk({ fail: 'sync.result_locked' }),
      helperEnter({ payload: { tag: 'old' } }, new Date(NOW.getTime() - 25 * 3_600_000)), helperEnter({ payload: { tag: 'future' } }, new Date(NOW.getTime() + 25 * 3_600_000)), mk({ tag: 'fine' })];
    const o = await devicePush(H, A1, dev, ops);
    const rs = results(o);
    expect(rs.map((r) => r.error_code)).toEqual(['common.validation_failed', 'common.internal', 'common.internal', 'sync.result_locked', undefined, 'sync.clock_skew_too_large', undefined]);
    for (const r of rs) if (r.error_code) expect(closed.has(r.error_code)).toBe(true);
    expect(JSON.stringify(rs)).not.toMatch(/secret-detail|foo\.not_registered|boom/);
    expect(rs.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected', 'accepted', 'rejected', 'accepted']);   // one bad operation never fails the batch
    const skewed = await devicePush(H, A1, dev, [mk({ tag: 'hdr' })], { headers: { 'x-device-time': new Date(NOW.getTime() + 25 * 3_600_000).toISOString() } });
    expect(results(skewed)[0]).toMatchObject({ status: 'rejected', error_code: 'sync.clock_skew_too_large' });   // a device clock 25 h ahead (header) is refused too

    const denied = await devicePush(H, A1, dev, [mk({ tag: 'denied' })], { grants: { codes: ['sync.use'] } });
    expect(results(denied)[0]).toMatchObject({ status: 'rejected', error_code: 'auth.forbidden' });

    const none = await devicePush(syncEngine(`S5X-${run}`, {}), A1, dev, [{ op_id: uid(), op_type: 'nope.nothing', payload: {}, device_created_at: at(5) } as any]);
    expect(code(none)).toBe('common.validation_failed');                                  // not in the closed catalogue: the whole request is refused before any work
  }, T);

  it('a refused result is stored with its closed code and replays as the SAME refusal, never as a success', async () => {
    const H = engine();
    const dev = await newDevice(A1);
    const op = helperEnter({ payload: { fail: 'sync.result_locked' } });
    expect(results(await devicePush(H, A1, dev, [op]))[0]).toMatchObject({ status: 'rejected', error_code: 'sync.result_locked' });
    const l = await ledgerOf([op.op_id]);
    expect(l[0]).toMatchObject({ status: 'rejected', error_code: 'sync.result_locked' });
    const again = results(await devicePush(H, A1, dev, [op]))[0];
    expect(again.status).toBe('duplicate'); expect(again.error_code).toBe('sync.result_locked');
  }, T);
});

describe('accepted / duplicate / rejected / conflict counts reach the existing metrics path (done_when 4)', () => {
  it('a mixed batch and its replay move lims_core_sync_operations_total by status, rendered through createMetrics (names and labels are guarded by the registry)', async () => {
    const H = engine();
    const dev = await newDevice(A1);
    const metrics: any[] = [];
    const ops = [helperEnter({ payload: { tag: 'a' } }), helperEnter({ payload: { tag: 'b' } }), helperEnter({ payload: { fail: 'sync.result_locked' } }), helperEnter({ payload: { conflict: true }, entity_id: uid(), base_version: 2 })];
    okBody(await devicePush(H, A1, dev, ops, { metrics }));
    okBody(await devicePush(H, A1, dev, ops, { metrics }));                              // replay: every one a duplicate
    const reg = createMetrics();
    for (const m of metrics) { if (m.kind === 'inc') reg.inc(m.name, m.labels, m.v); else reg.set(m.name, m.v, m.labels); }
    const text = await reg.render();
    const value = (status: string): number => Number(new RegExp(`^lims_core_sync_operations_total\\{status="${status}"\\} (\\d+)`, 'm').exec(text)?.[1] ?? 0);
    expect(value('accepted')).toBe(2); expect(value('rejected')).toBe(1); expect(value('conflict')).toBe(1); expect(value('duplicate')).toBe(4);
    expect(text).toMatch(/^lims_core_sync_batches_total\{outcome="processed"\} 2$/m);
  }, T);
});
