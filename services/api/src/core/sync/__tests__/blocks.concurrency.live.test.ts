// T0B-SYNC-1 done_when (3) CONCURRENT BLOCK RESERVATION PROOF: blocks never overlap even under concurrent requests from 20 devices (and more), per tenant and series, and never
// overlap a number an ONLINE allocator hands out meanwhile. Live PG17, every request on its own connection and transaction (RLS on). No retries here: a deadlock or a
// serialization failure surfaced to the caller is a failure of the implementation (the counter row lock must serialise requests).
import { describe, expect, it } from 'vitest';
import { A1, A2, B1, TENANT_A, TENANT_B, counter, newDevice, ownerRows, reserve, setCounters, type Who } from './helpers.js';

const T = 300_000;
const ranges = (rows: any[]) => rows.map((r) => [Number(r.from_value), Number(r.to_value)] as const).sort((a, b) => a[0] - b[0]);
const disjoint = (rs: ReadonlyArray<readonly [number, number]>) => { for (let i = 1; i < rs.length; i++) if (rs[i]![0] <= rs[i - 1]![1]) return false; return true; };
const contiguous = (rs: ReadonlyArray<readonly [number, number]>) => { for (let i = 1; i < rs.length; i++) if (rs[i]![0] !== rs[i - 1]![1] + 1) return false; return true; };
const mk = async (n: number, who: Who) => Promise.all(Array.from({ length: n }, () => newDevice(who)));

describe('20 devices reserve at the same moment', () => {
  it('20 simultaneous lab_code blocks of 50: all succeed, ranges disjoint AND gap free, counter = start + 1000, 20 rows', async () => {
    await setCounters(TENANT_A, { lab: 10_000 });
    const devs = [...(await mk(10, A1)), ...(await mk(10, A2))];
    const outs = await Promise.all(devs.map((d, i) => reserve(i < 10 ? A1 : A2, d, 'lab_code', 50)));
    expect(outs.map((o) => o.error?.message ?? o.reply!.status)).toEqual(Array(20).fill(201));
    const rs = ranges(outs.map((o) => o.reply!.body.block));
    expect(disjoint(rs)).toBe(true); expect(contiguous(rs)).toBe(true);
    expect(rs[0]![0]).toBe(10_001); expect(rs[19]![1]).toBe(11_000);
    expect(await counter(TENANT_A, 'lab_code')).toBe(11_000);
    const db = await ownerRows('SELECT from_value, to_value, device_id FROM core.number_block WHERE device_id = ANY($1::uuid[])', [devs]);
    expect(db).toHaveLength(20);
    expect(new Set(db.map((r) => r.device_id)).size).toBe(20);
  }, T);

  it('20 devices x both series at once (40 requests): each series is disjoint and gap free on its own counter', async () => {
    await setCounters(TENANT_A, { lab: 0, patient: 0 });
    const devs = await mk(20, A1);
    const outs = await Promise.all(devs.flatMap((d) => [reserve(A1, d, 'lab_code', 30), reserve(A1, d, 'patient_id', 20)]));
    expect(outs.filter((o) => o.error)).toEqual([]);
    const lab = ranges(outs.filter((o) => o.reply!.body.block.series === 'lab_code').map((o) => o.reply!.body.block));
    const pat = ranges(outs.filter((o) => o.reply!.body.block.series === 'patient_id').map((o) => o.reply!.body.block));
    expect([lab.length, pat.length]).toEqual([20, 20]);
    expect(disjoint(lab) && contiguous(lab)).toBe(true); expect(disjoint(pat) && contiguous(pat)).toBe(true);
    expect([lab[0]![0], lab[19]![1], pat[0]![0], pat[19]![1]]).toEqual([1, 600, 1, 400]);
    expect([await counter(TENANT_A, 'lab_code'), await counter(TENANT_A, 'patient_id')]).toEqual([600, 400]);
  }, T);

  it('one device asking 20 times at once gets 20 disjoint blocks (a retry storm after an outage never hands out the same numbers twice)', async () => {
    await setCounters(TENANT_A, { patient: 500 });
    const [d] = await mk(1, A1);
    const outs = await Promise.all(Array.from({ length: 20 }, () => reserve(A1, d!, 'patient_id', 10)));
    expect(outs.filter((o) => o.error)).toEqual([]);
    const rs = ranges(outs.map((o) => o.reply!.body.block));
    expect(disjoint(rs) && contiguous(rs)).toBe(true);
    expect([rs[0]![0], rs[19]![1]]).toEqual([501, 700]);
  }, T);

  it('two tenants at once do not serialise onto or leak into each other: each gets a contiguous run from its OWN counter', async () => {
    await setCounters(TENANT_A, { lab: 2000 }); await setCounters(TENANT_B, { lab: 7000 });
    const da = await mk(10, A1), db = await mk(10, B1);
    const outs = await Promise.all([...da.map((d) => reserve(A1, d, 'lab_code', 25)), ...db.map((d) => reserve(B1, d, 'lab_code', 25))]);
    expect(outs.filter((o) => o.error)).toEqual([]);
    const a = ranges(outs.slice(0, 10).map((o) => o.reply!.body.block)), b = ranges(outs.slice(10).map((o) => o.reply!.body.block));
    expect(disjoint(a) && contiguous(a) && disjoint(b) && contiguous(b)).toBe(true);
    expect([a[0]![0], a[9]![1], b[0]![0], b[9]![1]]).toEqual([2001, 2250, 7001, 7250]);
    expect([await counter(TENANT_A, 'lab_code'), await counter(TENANT_B, 'lab_code')]).toEqual([2250, 7250]);
  }, T);

  it('mixed with ONLINE allocations (the lab barcode allocator statement) no online number falls inside any block', async () => {
    await setCounters(TENANT_A, { lab: 40_000 });
    const devs = await mk(20, A1);
    const online = Array.from({ length: 30 }, () => ownerRows('UPDATE lab.barcode_counters SET last_value = last_value + 1 WHERE tenant_id = $1 RETURNING last_value', [TENANT_A]).then((r) => Number(r[0].last_value)));
    const blocks = devs.map((d) => reserve(A1, d, 'lab_code', 20));
    const [onlineVals, outs] = [await Promise.all(online), await Promise.all(blocks)];
    expect(outs.filter((o) => o.error)).toEqual([]);
    const rs = ranges(outs.map((o) => o.reply!.body.block));
    expect(disjoint(rs)).toBe(true);
    for (const v of onlineVals) expect(rs.some(([f, t]) => v >= f && v <= t), `online ${v} inside a block`).toBe(false);
    expect(new Set(onlineVals).size).toBe(30);
    expect(await counter(TENANT_A, 'lab_code')).toBe(40_000 + 30 + 400);
  }, T);

  it('the database refuses an overlapping block even when the service is bypassed (safety net under the counter): a direct insert inside an issued range fails', async () => {
    await setCounters(TENANT_A, { lab: 90_000 });
    const [d] = await mk(1, A1);
    const b = (await reserve(A1, d!, 'lab_code', 100)).reply!.body.block;
    await expect(ownerRows(`INSERT INTO core.number_block (id, tenant_id, device_id, series, from_value, to_value, created_by, updated_by)
      VALUES (gen_random_uuid(), $1, $2, 'lab_code', $3, $4, $5, $5)`, [TENANT_A, d, b.from_value + 10, b.from_value + 20, A2.userId])).rejects.toThrow(/number_block_overlap/);
  }, T);
});
