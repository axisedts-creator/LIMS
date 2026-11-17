// Self-check of the T-22 fake (validateDb.ts): the fixture must behave like Postgres or the T-22 assertions mean nothing.
import { describe, expect, it } from 'vitest';
import { IMPORT_ID, TENANT_A, TENANT_B, makeRunner, makeValidateDb, seedCatalog, seedImport, uid } from './validateDb.js';
import { priceWorkbook, prow } from './workbooks.js';

const CAT = [{ id: uid(1), code: 'A1' }];
const setup = async () => {
  const db = makeValidateDb();
  seedCatalog(db, TENANT_A, { orderables: CAT, versions: [{ version_no: 1, status: 'published', items: { A1: 10000 } }] });
  seedImport(db, TENANT_A, await priceWorkbook([prow('A1', 100)]));
  return db;
};
const issue = (seq: number, over: Record<string, unknown> = {}) => ({ tenant_id: TENANT_A, import_id: IMPORT_ID, seq, severity: 'error', sheet: 'Prices', issue_code: 'row.price_invalid', message: 'm', created_by: uid(1), expires_at: new Date(), ...over });
const INS = 'INSERT INTO catalog.import_issues (tenant_id, import_id, seq, severity, sheet, row_no, column_key, issue_code, message, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)';
const vals = (r: any) => [r.tenant_id, r.import_id, r.seq, r.severity, r.sheet, 2, 'unit_price_npr', r.issue_code, r.message, r.created_by, r.expires_at];

describe('validateDb fake', () => {
  it('node-pg types: bigint price and count(*) are strings, bytea is a Buffer, timestamptz a Date', async () => {
    const db = await setup(); const tx = db.begin(TENANT_A);
    const it = await tx.query('SELECT unit_price_paisa FROM catalog.price_list_items WHERE tenant_id = $1', [TENANT_A]);
    expect(it.rows[0]!.unit_price_paisa).toBe('10000');
    expect((await tx.query('SELECT count(*) AS n FROM catalog.orderables WHERE tenant_id = $1', [TENANT_A])).rows[0]!.n).toBe('1');
    const f = (await tx.query('SELECT content, expires_at FROM catalog.files WHERE tenant_id = $1', [TENANT_A])).rows[0]!;
    expect(Buffer.isBuffer(f.content)).toBe(true); expect(f.expires_at).toBeInstanceOf(Date);
  });

  it('RLS: other tenants are invisible; writes for another tenant fail 42501; price/orderable tables are read-only', async () => {
    const db = await setup(); const tx = db.begin(TENANT_B);
    expect((await tx.query('SELECT id FROM catalog.imports WHERE tenant_id = $1', [TENANT_A])).rows).toEqual([]);
    await expect(tx.query(INS, vals(issue(1, { tenant_id: TENANT_A })))).rejects.toMatchObject({ code: '42501' });
    const a = db.begin(TENANT_A);
    await expect(a.query('UPDATE catalog.price_list_items SET unit_price_paisa = 1 WHERE tenant_id = $1', [TENANT_A])).rejects.toMatchObject({ code: '42501' });
    await expect(a.query('DELETE FROM catalog.orderables WHERE tenant_id = $1', [TENANT_A])).rejects.toMatchObject({ code: '42501' });
    await expect(a.query('SELECT * FROM catalog.catalog_state WHERE tenant_id = $1', [TENANT_A])).rejects.toThrow(/unsupported/);
  });

  it('constraints: status enum, issue code/message/sheet checks, PK; commit applies, rollback discards, own writes are visible inside the tx only', async () => {
    const db = await setup(); const tx = db.begin(TENANT_A);
    await expect(tx.query('UPDATE catalog.imports SET status = $1 WHERE tenant_id = $2 AND id = $3', ['bogus', TENANT_A, IMPORT_ID])).rejects.toMatchObject({ code: '23514' });
    await expect(tx.query(INS, vals(issue(1, { issue_code: 'BAD CODE' })))).rejects.toMatchObject({ code: '23514' });
    await expect(tx.query(INS, vals(issue(1, { message: 'x'.repeat(301) })))).rejects.toMatchObject({ code: '23514' });
    await expect(tx.query(INS, vals(issue(1, { sheet: 'x'.repeat(32) })))).rejects.toMatchObject({ code: '23514' });
    await tx.query(INS, vals(issue(1)));
    await expect(tx.query(INS, vals(issue(1)))).rejects.toMatchObject({ code: '23505' });
    await tx.query('UPDATE catalog.imports SET status = $1, version = version + 1 WHERE tenant_id = $2 AND id = $3', ['scanning', TENANT_A, IMPORT_ID]);
    expect((await tx.query('SELECT status, version FROM catalog.imports WHERE tenant_id = $1 AND id = $2', [TENANT_A, IMPORT_ID])).rows[0]).toEqual({ status: 'scanning', version: 2 });
    expect(db.rows('imports')[0]!.status).toBe('uploaded'); expect(db.rows('import_issues')).toHaveLength(0);   // private until commit
    tx.rollback();
    expect(db.rows('imports')[0]!.status).toBe('uploaded');
    const t2 = db.begin(TENANT_A);
    await t2.query(INS, vals(issue(1)));
    await t2.query('UPDATE catalog.imports SET status = $1 WHERE tenant_id = $2 AND id = $3', ['invalid', TENANT_A, IMPORT_ID]);
    t2.commit();
    expect(db.rows('imports')[0]!.status).toBe('invalid'); expect(db.rows('import_issues')).toHaveLength(1);
  });

  it('runner: ctx.tx commits on resolve and rolls back on throw; ctx.db.tx commits independently of a later throw', async () => {
    const db = await setup();
    const set = (c: any, s: string) => c.tx.query('UPDATE catalog.imports SET status = $1 WHERE tenant_id = $2 AND id = $3', [s, TENANT_A, IMPORT_ID]);
    const r = makeRunner(db, async (_p, c) => { await set(c, 'validating'); await c.db.tx((c2: any) => set(c2, 'scanning')); throw new Error('boom'); });
    await expect(r.run({})).rejects.toThrow('boom');
    expect(db.rows('imports')[0]!.status).toBe('scanning');           // independent commit survived, task tx rolled back
    await makeRunner(db, async (_p, c) => { await set(c, 'validated'); }).run({});
    expect(db.rows('imports')[0]!.status).toBe('validated');
  });
});
