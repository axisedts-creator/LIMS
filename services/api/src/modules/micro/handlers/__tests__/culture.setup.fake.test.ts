// C10 T-08 — self-check of helpers/cultureWrites.ts (the in-memory tx behind culture.setup.test.ts): a fake that is wrong makes the real tests pass or fail for the wrong reason.
import { describe, expect, it } from 'vitest';
import { fakeTx, NOW, type World } from './helpers/cultureWrites.js';

const T = '01a1a98a-ac40-7000-8000-00000000a001';
const u = (n: number) => `0190c608-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const world = (status = 'incubating'): World => ({
  cultures: [{ id: u(1), tenant_id: T, status, version: 4 }], culture_plates: [], culture_observations: [], culture_transitions: [], isolates: [],
});
const INS_PLATE = `INSERT INTO micro.culture_plates (id, tenant_id, centre_id, culture_id, plate_no, media_code, planted_at, created_by, updated_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`;
const plate = (id: number, no: number) => [u(id), T, u(9), u(1), no, 'syn_blood', NOW, u(7)];

describe('C10-T08 fake tx self-check', () => {
  it('INSERT applies column defaults, returns the row; max(plate_no) and WHERE equalities see it; a duplicate plate_no is 23505', async () => {
    const w = world(); const { tx } = fakeTx(w);
    const r = await tx.query(INS_PLATE, plate(10, 1));
    expect(r.rows[0]).toMatchObject({ plate_no: 1, status: 'active', version: 1, parent_plate_id: null });
    await tx.query(INS_PLATE, plate(11, 2));
    expect((await tx.query('SELECT coalesce(max(plate_no), 0) AS max_no FROM micro.culture_plates WHERE tenant_id = $1 AND culture_id = $2', [T, u(1)])).rows[0]).toMatchObject({ max_no: 2 });
    expect((await tx.query('SELECT * FROM micro.culture_plates WHERE tenant_id = $1 AND culture_id = $2 AND id = $3', [T, u(1), u(11)])).rows).toHaveLength(1);
    expect((await tx.query('SELECT * FROM micro.culture_plates WHERE tenant_id = $1 AND culture_id = $2 AND id = ANY($3::uuid[])', [T, u(1), [u(10), u(11)]])).rows).toHaveLength(2);
    expect((await tx.query('SELECT * FROM micro.culture_plates WHERE tenant_id = $1', [u(55)])).rows).toEqual([]);
    await expect(tx.query(INS_PLATE, plate(12, 2))).rejects.toMatchObject({ code: '23505' });
  });

  it('multi-row VALUES and ON CONFLICT DO NOTHING', async () => {
    const w = world(); const { tx } = fakeTx(w);
    await tx.query(`INSERT INTO micro.culture_plates (id, tenant_id, centre_id, culture_id, plate_no, media_code, planted_at, created_by, updated_by) VALUES ($1,$2,$3,$4,1,$5,now(),$6,$6),($7,$2,$3,$4,2,$5,now(),$6,$6)`,
      [u(10), T, u(9), u(1), 'syn_blood', u(7), u(11)]);
    expect(w['culture_plates']!.map((p) => p['plate_no'])).toEqual([1, 2]);
    const dup = await tx.query(`INSERT INTO micro.culture_plates (id, tenant_id, centre_id, culture_id, plate_no, media_code, planted_at, created_by, updated_by) VALUES ($1,$2,$3,$4,2,$5,now(),$6,$6) ON CONFLICT DO NOTHING RETURNING id`,
      [u(12), T, u(9), u(1), 'syn_blood', u(7)]);
    expect(dup.rows).toEqual([]);
  });

  it('UPDATE applies $n, now(), col + 1 and the WHERE equalities (version guard returns no row when it does not match)', async () => {
    const w = world(); const { tx } = fakeTx(w);
    const miss = await tx.query('UPDATE micro.cultures SET status = $3, version = version + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND version = $4 RETURNING *', [T, u(1), 'growth_detected', 3]);
    expect(miss.rows).toEqual([]);
    const hit = await tx.query('UPDATE micro.cultures SET status = $3, version = version + 1, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND version = $4 RETURNING *', [T, u(1), 'growth_detected', 4]);
    expect(hit.rows[0]).toMatchObject({ status: 'growth_detected', version: 5, updated_at: NOW });
    expect(w['cultures']![0]).toMatchObject({ status: 'growth_detected', version: 5 });
  });

  it('emulated database rules: cultures_guard, tg_child_final_lock, FKs, the observation CHECKs', async () => {
    const w = world('awaiting_setup'); const { tx } = fakeTx(w);
    await expect(tx.query('UPDATE micro.cultures SET status = $3 WHERE tenant_id = $1 AND id = $2', [T, u(1), 'growth_detected'])).rejects.toMatchObject({ code: 'P0001', message: 'culture_invalid_transition' });
    const f = world('final_submitted'); const ftx = fakeTx(f).tx;
    await expect(ftx.query(INS_PLATE, plate(10, 1))).rejects.toMatchObject({ code: 'P0001', message: 'immutable_row' });
    await expect(tx.query(`INSERT INTO micro.culture_plates (id, tenant_id, centre_id, culture_id, plate_no, media_code, planted_at, parent_plate_id, created_by, updated_by) VALUES ($1,$2,$3,$4,1,'m',now(),$5,$6,$6)`,
      [u(10), T, u(9), u(1), u(99), u(7)])).rejects.toMatchObject({ code: '23503' });
    const OBS = 'INSERT INTO micro.culture_observations (id, tenant_id, centre_id, culture_id, kind, finding_text, growth_code, observed_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8)';
    await expect(tx.query(OBS, [u(20), T, u(9), u(1), 'plate_read', null, 'no_growth', u(7)])).rejects.toMatchObject({ code: '23514' });   // plate_read needs plate_id
    await expect(tx.query(OBS, [u(21), T, u(9), u(1), 'gram_stain', null, null, u(7)])).rejects.toMatchObject({ code: '23514' });         // finding_text required
    await tx.query(OBS, [u(22), T, u(9), u(1), 'gram_stain', 'Synthetic finding', null, u(7)]);
    expect(w['culture_observations']).toHaveLength(1);
  });

  it('a dialect it does not know throws instead of answering', async () => {
    const { tx } = fakeTx(world());
    await expect(tx.query('INSERT INTO micro.culture_plates (id) SELECT id FROM micro.cultures')).rejects.toThrow(/fake dialect/);
    await expect(tx.query('WITH x AS (SELECT 1) SELECT * FROM x')).rejects.toThrow(/fake dialect/);
  });
});
