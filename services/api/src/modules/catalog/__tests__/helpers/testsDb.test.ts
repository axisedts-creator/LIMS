// Self-check of the T-06 SQL fake (helpers/testsDb.ts + the LIKE/CASE/|| additions to helpers/mastersDb.ts). If this fails, the fake is wrong,
// not the implementation. Passes before any T-06 implementation exists.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B } from './catalogDb.js';
import { dept, spec as specimen, cont } from './mastersDb.js';
import { ID, makeTestsDb, pnl, tsr, tst, type Row } from './testsDb.js';

const D1 = dept(1, TENANT_A); const S1 = specimen(1, TENANT_A); const S2 = specimen(2, TENANT_A); const C1 = cont(1, TENANT_A);
const names = ['100% pure', 'Alpha_beta', 'AlphaXbeta', 'back\\slash', 'Plain'];
const seed = () => {
  const ts = names.map((n, i) => tst(i + 1, TENANT_A, D1.id, { code: `C${i + 1}`, name: n }));
  const other = tst(90, TENANT_B, dept(9, TENANT_B).id, { code: 'C1', name: '100% pure' });
  return makeTestsDb({
    rows: { departments: [D1, dept(9, TENANT_B)], specimen_types: [S1, S2], containers: [C1] },
    t6: { orderables: [...ts.map((t) => t.orderable), other.orderable], tests: [...ts.map((t) => t.test), other.test] },
  });
};
const q = (db: ReturnType<typeof seed>, text: string, values: unknown[] = [], tenant = TENANT_A) => db.run((ctx) => ctx.tx.query(text, values), { tenantId: tenant });
const rej = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection'); };

describe('expression additions', () => {
  it('LIKE … ESCAPE treats escaped % and _ literally; unescaped ones are wildcards; ILIKE ignores case; || concatenates', async () => {
    const db = seed();
    const name = async (pat: string, op = 'LIKE') => (await q(db, `SELECT * FROM catalog.orderables WHERE tenant_id = $1 AND name ${op} $2 ESCAPE '\\' ORDER BY code`, [TENANT_A, pat])).rows.map((r) => r.name);
    expect(await name('%\\%%')).toEqual(['100% pure']);
    expect(await name('%\\_%')).toEqual(['Alpha_beta']);
    expect(await name('Alpha_beta')).toEqual(['Alpha_beta', 'AlphaXbeta']);
    expect(await name('%\\\\%')).toEqual(['back\\slash']);
    expect(await name('%PLAIN%', 'ILIKE')).toEqual(['Plain']);
    expect(await name('%PLAIN%')).toEqual([]);
    const r = await q(db, `SELECT * FROM catalog.orderables WHERE tenant_id = $1 AND upper(code) LIKE $2 || '%' ESCAPE '\\'`, [TENANT_A, 'C']);
    expect(r.rows).toHaveLength(5);
  });
  it('ORDER BY accepts CASE / length() expressions', async () => {
    const db = seed();
    const r = await q(db, `SELECT * FROM catalog.orderables WHERE tenant_id = $1 ORDER BY CASE WHEN code = 'C3' THEN 0 ELSE 1 END, length(name) DESC, code`, [TENANT_A]);
    expect(r.rows.map((x) => x.code)).toEqual(['C3', 'C2', 'C4', 'C1', 'C5']);   // C3 first; then name length DESC (10, 10, 9, 5), ties by code
  });
});

describe('tables, RLS and constraints', () => {
  it('sees only its own tenant; count(*) works; the T-03 revision stamp UPDATE lands on the orderable', async () => {
    const db = seed();
    expect((await q(db, 'SELECT count(*) FROM catalog.orderables WHERE is_active = true')).rows[0].count).toBe('5');
    await q(db, 'UPDATE catalog.orderables SET revision = $1 WHERE id = $2', [418, ID(0x1001)]);
    expect(db.orderableRevision(ID(0x1001))).toBe(418);
  });
  it('INSERT with a foreign tenant_id -> 42501; duplicate code -> 23505; bad code -> 23514; unknown department -> 23503; test without orderable -> 23503', async () => {
    const db = seed();
    const ins = (o: Row) => q(db, 'INSERT INTO catalog.orderables (id, tenant_id, kind, code, name, department_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)',
      [o['id'] ?? db.newId(), o['tenant_id'] ?? TENANT_A, 'test', o['code'] ?? 'NEW', 'n', o['dept'] ?? D1.id, ID(1)]);
    expect((await rej(ins({ tenant_id: TENANT_B }))).code).toBe('42501');
    expect((await rej(ins({ code: 'C1' }))).code).toBe('23505');
    expect((await rej(ins({ code: 'bad code' }))).code).toBe('23514');
    expect((await rej(ins({ dept: dept(9, TENANT_B).id }))).code).toBe('23503');
    expect((await rej(q(db, 'INSERT INTO catalog.tests (id, tenant_id, workflow_type, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)', [db.newId(), TENANT_A, 'standard', ID(1)]))).code).toBe('23503');
    expect((await ins({ code: 'OK-1' })).rows).toEqual([]);
  });
  it('test_specimen_types: multi-row insert, one preferred per test (partial unique), FK to masters, DELETE allowed, rollback discards', async () => {
    const t = tst(1, TENANT_A, D1.id);
    const db = makeTestsDb({ rows: { departments: [D1], specimen_types: [S1, S2, specimen(3, TENANT_B)], containers: [C1] }, t6: { orderables: [t.orderable], tests: [t.test] } });
    const ins = (rows: Array<[string, boolean]>, tenant = TENANT_A) => q(db, `INSERT INTO catalog.test_specimen_types (tenant_id, test_id, specimen_type_id, is_preferred, created_by) VALUES ${rows.map((_, i) => `($1, $2, $${3 + 2 * i}, $${4 + 2 * i}, $${3 + 2 * rows.length})`).join(', ')}`,
      [tenant, t.test.id, ...rows.flatMap(([s, p]) => [s, p]), ID(1)]);
    expect((await rej(ins([[S1.id, true], [S2.id, true]]))).constraint).toBe('test_specimen_types__tenant_id_test_id__preferred__p_uq');
    expect(db.rows('test_specimen_types')).toHaveLength(0);                       // statement-level atomic
    await ins([[S1.id, true], [S2.id, false]]);
    expect(db.rows('test_specimen_types')).toHaveLength(2);
    expect((await rej(ins([[S1.id, false]]))).constraint).toBe('test_specimen_types__pk');
    expect((await rej(ins([[specimen(3, TENANT_B).id, false]]))).constraint).toBe('test_specimen_types__type__fk');
    await rej(db.run((ctx) => ctx.tx.query('DELETE FROM catalog.test_specimen_types WHERE tenant_id = $1 AND test_id = $2', [TENANT_A, t.test.id]), { rollback: true }));
    expect(db.rows('test_specimen_types')).toHaveLength(2);
    await q(db, 'DELETE FROM catalog.test_specimen_types WHERE tenant_id = $1 AND test_id = $2', [TENANT_A, t.test.id]);
    expect(db.rows('test_specimen_types')).toHaveLength(0);
    await ins([[S2.id, true]]);                                                    // preferred slot is free again
  });
  it('no DELETE on orderables/tests (42501); seed-only tables refuse writes; panels/analytes are readable', async () => {
    const p = pnl(1, TENANT_A, { panel_kind: 'package' });
    const t = tst(2, TENANT_A, D1.id);
    const db = makeTestsDb({ rows: { departments: [D1] }, t6: { orderables: [p.orderable, t.orderable], panels: [p.panel], tests: [t.test] } });
    expect((await rej(q(db, 'DELETE FROM catalog.orderables WHERE tenant_id = $1', [TENANT_A]))).code).toBe('42501');
    expect((await rej(q(db, 'UPDATE catalog.panels SET panel_kind = $1 WHERE id = $2', ['clinical', p.panel.id]))).message).toMatch(/unsupported/);
    expect((await q(db, 'SELECT * FROM catalog.panels WHERE tenant_id = $1', [TENANT_A])).rows[0].panel_kind).toBe('package');
  });
  it('lock-then-re-evaluate: two txs updating the same row with the same version -> the second matches 0 rows', async () => {
    const db = seed();
    const bump = () => db.run(async (ctx) => (await ctx.tx.query('UPDATE catalog.tests SET version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING version', [TENANT_A, ID(0x1001), 1])).rows.length);
    const res = await Promise.all([bump(), bump()]);
    expect(res.sort()).toEqual([0, 1]);
    expect(db.row('tests', ID(0x1001))!.version).toBe(2);
  });
  it('analytes / versions seeds are readable and tsr() rows load', async () => {
    const t = tst(1, TENANT_A, D1.id);
    const db = makeTestsDb({ rows: { departments: [D1], specimen_types: [S1] }, t6: { orderables: [t.orderable], tests: [t.test], test_specimen_types: [tsr(t.test.id, S1.id, TENANT_A, { is_preferred: true })] } });
    expect((await q(db, 'SELECT * FROM catalog.test_specimen_types WHERE tenant_id = $1 AND test_id = $2', [TENANT_A, t.test.id])).rows).toHaveLength(1);
  });
});
