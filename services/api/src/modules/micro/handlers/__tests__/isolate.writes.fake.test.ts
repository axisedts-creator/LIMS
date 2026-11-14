// C10 T-09 — self-check of the test-side fake helpers/isolateWrites.ts (the counter upsert and the isolates rules). These tests pass now: they prove the fake is a faithful stand-in,
// so the failing behaviour tests in isolate.writes.test.ts fail for the handler stubs, not for the fake. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { isolateTx, type World } from './helpers/isolateWrites.js';

const T = '01a1a98a-ac40-7000-8000-00000000a001';
const S1 = '0190c608-0000-7000-8000-000000000901';
const C1 = '0190c608-0000-7000-8000-000000001001';
const UP = `INSERT INTO micro.specimen_isolate_counters (tenant_id, specimen_id, last_seq, created_by, updated_by) VALUES ($1, $2, 1, $3, $3)
  ON CONFLICT (tenant_id, specimen_id) DO UPDATE SET last_seq = specimen_isolate_counters.last_seq + 1, updated_by = $3 RETURNING last_seq`;
const world = (status = 'incubating'): World => ({ cultures: [{ id: C1, tenant_id: T, status, specimen_id: S1, version: 1 }], isolates: [], specimen_isolate_counters: [], culture_plates: [] });
const INS = `INSERT INTO micro.isolates (id, tenant_id, centre_id, culture_id, specimen_id, isolate_seq, status, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, 'pending_id', $7, $7) RETURNING *`;
const ins = (tx: any, id: string, seq: number) => tx.query(INS, [id, T, T, C1, S1, seq, T]);

describe('C10-T09 fake self-check (isolateWrites)', () => {
  it('counter upsert: absent row -> 1, then 2, 3; atomic read-modify-write returns the new value', async () => {
    const { tx, world: w } = isolateTx(world());
    const got: number[] = [];
    for (let i = 0; i < 3; i++) got.push((await tx.query(UP, [T, S1, T])).rows[0].last_seq);
    expect(got).toEqual([1, 2, 3]);
    expect(w['specimen_isolate_counters']).toHaveLength(1);
  });
  it('20 interleaved upserts give 1..20 once each', async () => {
    const { tx } = isolateTx(world());
    const out = await Promise.all(Array.from({ length: 20 }, () => tx.query(UP, [T, S1, T]).then((r) => r.rows[0]!.last_seq)));
    expect(out.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
  it('counter CHECK 0..99: the 100th increment is 23514; any other statement on the counter table throws a dialect error', async () => {
    const w = world(); w['specimen_isolate_counters'] = [{ tenant_id: T, specimen_id: S1, last_seq: 99 }];
    const { tx } = isolateTx(w);
    await expect(tx.query(UP, [T, S1, T])).rejects.toMatchObject({ code: '23514' });
    await expect(tx.query('SELECT max(last_seq) FROM micro.specimen_isolate_counters WHERE tenant_id = $1', [T])).rejects.toThrow(/fake dialect/);
    await expect(tx.query('UPDATE micro.specimen_isolate_counters SET last_seq = 0 WHERE tenant_id = $1', [T])).rejects.toThrow(/fake dialect/);
    await expect(tx.query('INSERT INTO micro.specimen_isolate_counters (tenant_id, specimen_id) VALUES ($1, $2)', [T, S1])).rejects.toThrow(/fake dialect/);
  });
  it('isolates: defaults applied; the second insert of the same (tenant, specimen, seq) is 23505 and the table is restored', async () => {
    const { tx, world: w } = isolateTx(world());
    const r = await ins(tx, '0190c608-0000-7000-8000-000000003001', 1);
    expect(r.rows[0]).toMatchObject({ is_reportable: true, version: 1, status: 'pending_id', isolate_seq: 1 });
    await expect(ins(tx, '0190c608-0000-7000-8000-000000003002', 1)).rejects.toMatchObject({ code: '23505' });
    expect(w['isolates']).toHaveLength(1);
    await ins(tx, '0190c608-0000-7000-8000-000000003002', 2);
    expect(w['isolates']).toHaveLength(2);
  });
  it('isolates: final lock on INSERT and UPDATE (P0001 immutable_row), identified / withdrawn CHECKs (23514), unknown culture FK (23503)', async () => {
    const f = isolateTx(world('final_submitted'));
    await expect(ins(f.tx, '0190c608-0000-7000-8000-000000003001', 1)).rejects.toMatchObject({ code: 'P0001', message: 'immutable_row' });
    const { tx, world: w } = isolateTx(world());
    await ins(tx, '0190c608-0000-7000-8000-000000003001', 1);
    await expect(tx.query(`UPDATE micro.isolates SET status = 'identified' WHERE tenant_id = $1 AND id = $2`, [T, '0190c608-0000-7000-8000-000000003001'])).rejects.toMatchObject({ code: '23514' });
    await expect(tx.query(`UPDATE micro.isolates SET status = 'withdrawn' WHERE tenant_id = $1 AND id = $2`, [T, '0190c608-0000-7000-8000-000000003001'])).rejects.toMatchObject({ code: '23514' });
    expect(w['isolates']![0]).toMatchObject({ status: 'pending_id' });
    w['cultures']![0]!['status'] = 'final_submitted';
    await expect(tx.query(`UPDATE micro.isolates SET colony_description = 'x' WHERE tenant_id = $1 AND id = $2`, [T, '0190c608-0000-7000-8000-000000003001'])).rejects.toMatchObject({ code: 'P0001' });
    const orphan = isolateTx(world());
    await expect(orphan.tx.query(INS, ['0190c608-0000-7000-8000-000000003009', T, T, '0190c608-0000-7000-8000-0000000010ff', S1, 1, T])).rejects.toMatchObject({ code: '23503' });
  });
  it('a naive SELECT max + 1 numbering collides under interleaving (proves the fake catches it)', async () => {
    const { tx } = isolateTx(world());
    const naive = async (id: string) => { const m = (await tx.query('SELECT max(isolate_seq) FROM micro.isolates WHERE tenant_id = $1 AND specimen_id = $2', [T, S1])).rows[0]!['max'] ?? 0; await ins(tx, id, Number(m) + 1); };
    const out = await Promise.allSettled([1, 2, 3].map((n) => naive(`0190c608-0000-7000-8000-00000000300${n}`)));
    expect(out.filter((o) => o.status === 'rejected').length).toBeGreaterThan(0);
  });
});
