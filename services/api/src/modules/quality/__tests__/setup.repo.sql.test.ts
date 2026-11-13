// C9 T-06 — the REAL repo (createSetupRepo) driven with a recording tx (no database): every statement is tenant-scoped and parameterised (REQ-SEC-022/024/082).
// RLS itself (tenants A/B on the real DDL) is proven by db/tests once C0 merges the quality DDL; this guards the explicit `tenant_id = $n` predicate of 02-CV §5.13.
import { describe, expect, it } from 'vitest';
import { createSetupRepo } from '../repository/setup.repo.js';
import { INS, LOT, LVL, MAP, MAT, TENANT_A, USER, type Row } from './setup.helpers.js';

const rec = () => {
  const q: Array<{ text: string; values: unknown[] }> = [];
  return { q, tx: { async query(text: string, values: unknown[] = []) { q.push({ text, values }); return { rows: [], rowCount: 0 }; } } };
};
const INJ = `x'; DROP TABLE quality.control_lots; --`;
const mat = { id: MAT(1), code: 'MCS-SYN', name: INJ, manufacturer: INJ, matrix: INJ, created_by: USER, updated_by: USER };
const lvl = { id: LVL(1), material_id: MAT(1), level_code: '1', display_name: INJ, sort_order: 1, created_by: USER, updated_by: USER };
const lot = { id: LOT(1), level_id: LVL(1), material_id: MAT(1), lot_no: INJ, expires_on: '2027-01-01', created_by: USER, updated_by: USER };
const map = { id: MAP(1), instrument_id: INS(1), control_id_raw: INJ, control_lot_raw: INJ, lot_id: LOT(1), created_by: USER, updated_by: USER };
const CALLS: Record<string, (r: any, tx: any) => Promise<unknown>> = {
  listMaterials: (r, tx) => r.listMaterials(tx, TENANT_A, { isActive: true, q: '50%_off\\', sort: 'code', limit: 50 }),
  insertMaterial: (r, tx) => r.insertMaterial(tx, TENANT_A, mat),
  findMaterial: (r, tx) => r.findMaterial(tx, TENANT_A, MAT(1)),
  updateMaterial: (r, tx) => r.updateMaterial(tx, TENANT_A, MAT(1), 1, { name: INJ, manufacturer: null, updated_by: USER }),
  listLevels: (r, tx) => r.listLevels(tx, TENANT_A, [MAT(1), MAT(2)]),
  insertLevel: (r, tx) => r.insertLevel(tx, TENANT_A, lvl),
  findLevel: (r, tx) => r.findLevel(tx, TENANT_A, LVL(1)),
  updateLevel: (r, tx) => r.updateLevel(tx, TENANT_A, LVL(1), 1, { display_name: INJ, sort_order: 2, is_active: false, updated_by: USER }),
  listLotsByMaterials: (r, tx) => r.listLotsByMaterials(tx, TENANT_A, [MAT(1)]),
  listLots: (r, tx) => r.listLots(tx, TENANT_A, { materialId: MAT(1), levelId: LVL(1), isActive: true, expiresOnTo: '2027-01-01', sort: 'expires_on', limit: 50 }),
  insertLot: (r, tx) => r.insertLot(tx, TENANT_A, lot),
  findLot: (r, tx) => r.findLot(tx, TENANT_A, LOT(1)),
  updateLot: (r, tx) => r.updateLot(tx, TENANT_A, LOT(1), 1, { expires_on: '2028-01-01', is_active: false, updated_by: USER }),
  listMaps: (r, tx) => r.listMaps(tx, TENANT_A, { instrumentId: INS(1), lotId: LOT(1), isActive: true, limit: 50 }),
  insertMap: (r, tx) => r.insertMap(tx, TENANT_A, map),
  findMap: (r, tx) => r.findMap(tx, TENANT_A, MAP(1)),
  updateMap: (r, tx) => r.updateMap(tx, TENANT_A, MAP(1), 1, { is_active: false, updated_by: USER }),
  listInstrumentLabels: (r, tx) => r.listInstrumentLabels(tx, TENANT_A, [INS(1)]),
};

describe('createSetupRepo: SQL hygiene', () => {
  it('the probe table covers every method of the repo (a new method cannot dodge the checks)', () => { expect(Object.keys(createSetupRepo()).sort()).toEqual(Object.keys(CALLS).sort()); });
  it.each(Object.keys(CALLS))('%s: every statement names tenant_id, binds the tenant id as a parameter, and carries no request value in the SQL text', async (name) => {
    const { q, tx } = rec(); await CALLS[name]!(createSetupRepo(), tx).catch(() => undefined);
    expect(q.length, 'no SQL issued').toBeGreaterThan(0);
    for (const s of q) {
      expect(s.text, s.text).toMatch(/tenant_id/); expect(s.values, s.text).toContain(TENANT_A);
      expect(s.text).toMatch(/\$1/); expect(s.text).not.toMatch(/DROP TABLE|MCS-SYN|SIM-|[0-9a-f]{8}-[0-9a-f]{4}-7/);
      expect(s.text, 'schema-qualified').not.toMatch(/\bFROM\s+(?!quality\.|instruments\.|\()\w+/i);
    }
  });
  it.each(Object.keys(CALLS).filter((n) => /^(update|insert)/.test(n)))('%s: write statements never take tenant_id / created_by from anywhere but the arguments (tenant is a parameter, no default)', async (name) => {
    const { q, tx } = rec(); await CALLS[name]!(createSetupRepo(), tx).catch(() => undefined);
    for (const s of q) expect(s.values.filter((v) => v === TENANT_A).length).toBeGreaterThanOrEqual(1);
  });
  it('update* are version-checked in SQL (WHERE version = $n) so a concurrent writer yields no row, not an overwrite', async () => {
    for (const n of ['updateMaterial', 'updateLevel', 'updateLot', 'updateMap']) {
      const { q, tx } = rec(); await CALLS[n]!(createSetupRepo(), tx).catch(() => undefined);
      expect(q[0]!.text, n).toMatch(/version\s*=\s*\$\d+/i); expect(q[0]!.text, n).toMatch(/version\s*=\s*version\s*\+\s*1|version\s*=\s*\$\d+\s*\+\s*1/i);
    }
  });
  it('listMaterials: the q prefix is bound (never concatenated) and LIKE metacharacters are escaped (REQ-SEC-082)', async () => {
    const { q, tx } = rec(); await CALLS['listMaterials']!(createSetupRepo(), tx);
    const bound = q.flatMap((s) => s.values).filter((v): v is string => typeof v === 'string' && v.includes('off'));
    expect(bound.length).toBeGreaterThan(0); for (const v of bound) { expect(v).toContain('\\%'); expect(v).toContain('\\_'); expect(v).toContain('\\\\'); }
    expect(q[0]!.text).not.toContain('off'); expect(q[0]!.text).toMatch(/LIKE|ILIKE|starts_with|left\(/i);
  });
  it('lists are keyset-paged with an id tie-breaker and limit+1 look-ahead (02-CV §4.3): ORDER BY ends with id; LIMIT is a parameter', async () => {
    for (const n of ['listMaterials', 'listLots', 'listMaps']) {
      const { q, tx } = rec(); await CALLS[n]!(createSetupRepo(), tx);
      expect(q[0]!.text, n).toMatch(/ORDER BY[^;]*\bid\b/i); expect(q[0]!.text, n).toMatch(/LIMIT\s+\$\d+/i);
    }
  });
  it('a malformed cursor is common.invalid_cursor, not a SQL error', async () => {
    const { tx } = rec(); const repo: any = createSetupRepo();
    for (const c of ['%%%', 'x'.repeat(600), '{"a":1}']) await expect(repo.listMaterials(tx, TENANT_A, { isActive: true, sort: 'code', cursor: c, limit: 5 })).rejects.toMatchObject({ code: 'common.invalid_cursor' });
  });
});
