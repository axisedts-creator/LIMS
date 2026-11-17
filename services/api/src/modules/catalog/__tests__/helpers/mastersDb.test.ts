// Self-check of the T-04 SQL fake (helpers/mastersDb.ts): if the fake is wrong, every masters test is meaningless.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, USER } from './catalogDb.js';
import { dept, ID, makeMastersDb } from './mastersDb.js';

const INS = `INSERT INTO catalog.departments (id, tenant_id, code, name, report_order, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`;
const ins = (id: string, tenant: string, code: string, name = 'N') => [id, tenant, code, name, 10, USER, USER];

describe('mastersDb fake', () => {
  it('INSERT applies defaults, returns the row, commit publishes it; ROLLBACK discards', async () => {
    const db = makeMastersDb();
    const r = await db.run((c) => c.tx.query(INS, ins(ID(1), TENANT_A, 'A1')));
    expect(r.rows[0]).toMatchObject({ code: 'A1', version: 1, is_active: true });
    expect(r.rows[0].created_at).toBeInstanceOf(Date);
    expect(db.rows('departments')).toHaveLength(1);
    await expect(db.run(async (c) => { await c.tx.query(INS, ins(ID(2), TENANT_A, 'A2')); throw new Error('x'); })).rejects.toThrow('x');
    expect(db.rows('departments')).toHaveLength(1);
  });

  it('constraints: UNIQUE(tenant, code) 23505 per tenant only, CHECK 23514, NOT NULL 23502, RLS 42501, FK 23503, DELETE 42501', async () => {
    const db = makeMastersDb({ rows: { departments: [dept(1, TENANT_A, { code: 'DUP' })] } });
    await expect(db.run((c) => c.tx.query(INS, ins(ID(9), TENANT_A, 'DUP')))).rejects.toMatchObject({ code: '23505' });
    await expect(db.run((c) => c.tx.query(INS, ins(ID(9), TENANT_B, 'DUP'), ), { tenantId: TENANT_B })).resolves.toBeTruthy();
    await expect(db.run((c) => c.tx.query(INS, ins(ID(8), TENANT_A, 'bad code')))).rejects.toMatchObject({ code: '23514' });
    await expect(db.run((c) => c.tx.query(INS, [ID(7), TENANT_A, 'OK', 'N', 10000, USER, USER]))).rejects.toMatchObject({ code: '23514' });
    await expect(db.run((c) => c.tx.query(INS, [ID(7), TENANT_A, 'OK', null, 10, USER, USER]))).rejects.toMatchObject({ code: '23502' });
    await expect(db.run((c) => c.tx.query(INS, ins(ID(6), TENANT_B, 'X')))).rejects.toMatchObject({ code: '42501' });
    await expect(db.run((c) => c.tx.query('INSERT INTO catalog.containers (id, tenant_id, code, name, default_specimen_type_id, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [ID(5), TENANT_A, 'C', 'N', ID(0x999), USER, USER]))).rejects.toMatchObject({ code: '23503' });
    await expect(db.run((c) => c.tx.query('DELETE FROM catalog.departments WHERE id = $1', [ID(1)]))).rejects.toMatchObject({ code: '42501' });
  });

  it('SELECT: tenant-scoped (RLS), WHERE with AND/OR/IN/ANY/tuples, ORDER BY, LIMIT/OFFSET, count(*)', async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => dept(n, TENANT_A, n === 2 ? { is_active: false } : {}));
    const db = makeMastersDb({ rows: { departments: [...rows, dept(9, TENANT_B)] } });
    const q = (sql: string, v: unknown[] = []) => db.run((c) => c.tx.query(sql, v)).then((r) => r.rows.map((x: any) => x.code ?? x.count));
    expect(await q('SELECT * FROM catalog.departments')).toHaveLength(5);
    expect(await q('SELECT * FROM catalog.departments d WHERE d.is_active = $1 AND tenant_id = $2 ORDER BY d.code DESC LIMIT $3', [true, TENANT_A, 2])).toEqual(['DEPT5', 'DEPT4']);
    expect(await q('SELECT * FROM catalog.departments WHERE (code, id) > ($1, $2) ORDER BY code, id', ['DEPT3', ID(0xfffff)])).toEqual(['DEPT4', 'DEPT5']);   // DEPT3 row (id 0x103) is NOT > (DEPT3, 0xfffff)
    expect(await q('SELECT * FROM catalog.departments WHERE code > $1 OR (code = $1 AND id > $2) ORDER BY code', ['DEPT4', ID(0xfffff)])).toEqual(['DEPT5']);
    expect(await q('SELECT * FROM catalog.departments WHERE code IN ($1, $2) ORDER BY code', ['DEPT1', 'DEPT3'])).toEqual(['DEPT1', 'DEPT3']);
    expect(await q('SELECT * FROM catalog.departments WHERE id = ANY($1) ORDER BY code', [[rows[0]!.id, rows[4]!.id]])).toEqual(['DEPT1', 'DEPT5']);
    expect(await q('SELECT * FROM catalog.departments WHERE report_heading IS NULL ORDER BY code LIMIT 1 OFFSET 1')).toEqual(['DEPT2']);
    expect(await q('SELECT count(*) FROM catalog.departments WHERE is_active = false')).toEqual(['1']);
  });

  it('UPDATE: lock then re-evaluate — of two concurrent `version = $n` updates exactly one matches (no lost update); WHERE-less UPDATE is refused', async () => {
    const db = makeMastersDb({ rows: { departments: [dept(1, TENANT_A)] } });
    const upd = (name: string) => db.run((c) => c.tx.query('UPDATE catalog.departments SET name = $1, version = version + 1, updated_at = now() WHERE tenant_id = $2 AND id = $3 AND version = $4 RETURNING *', [name, TENANT_A, dept(1, TENANT_A).id, 1]));
    const [a, b] = await Promise.all([upd('one'), upd('two')]);
    expect([a.rows.length, b.rows.length].sort()).toEqual([0, 1]);
    expect(db.rows('departments')[0]).toMatchObject({ version: 2 });
    await expect(db.run((c) => c.tx.query('UPDATE catalog.departments SET name = $1', ['x']))).rejects.toThrow(/unsupported UPDATE/);
  });

  it('concurrent INSERT of the same code: second waits for the first, then 23505', async () => {
    const db = makeMastersDb();
    const res = await Promise.allSettled([db.run((c) => c.tx.query(INS, ins(ID(1), TENANT_A, 'RACE'))), db.run((c) => c.tx.query(INS, ins(ID(2), TENANT_A, 'RACE')))]);
    expect(res.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('23505');
  });

  it('non-masters SQL is delegated to the T-03 fake (catalog_state, event_log); unknown SQL throws', async () => {
    const db = makeMastersDb({ catalog: { state: { [TENANT_A]: { rootId: '01a1a98a-ac40-7000-8000-00000000c3a0', revision: 5 } } } });
    const r = await db.run((c) => c.tx.query('UPDATE catalog.catalog_state SET catalog_revision = catalog_revision + 1 WHERE tenant_id = $1 RETURNING catalog_revision', [TENANT_A]));
    expect(r.rows[0].catalog_revision).toBe('6');
    await expect(db.run((c) => c.tx.query('SELECT 1 FROM nowhere', []))).rejects.toThrow(/unsupported SQL/);
  });
});
