// T-18 fixture self-check: the SQL fake in taxDb.ts enforces what 05-SCHEMA says it does, so a service test that passes is not passing against a permissive fake.
import { describe, expect, it } from 'vitest';
import { ROOT_A, TENANT_B } from './catalogDb.js';
import { ID } from './mastersDb.js';
import { TENANT_A, dept, makeTaxDb, orderable, srule, trule, ttype } from './taxDb.js';

const A = TENANT_A;
const USERID = '0190c300-0000-7000-8000-0000000000ff';
const mk = (rows: Record<string, any[]> = {}) => makeTaxDb({ rows: { departments: [dept(1, A)], orderables: [orderable(1, A)], ...rows } as never, catalog: { state: { [A]: { rootId: ROOT_A, revision: 1 } } } });
const sql = (db: ReturnType<typeof mk>, text: string, values: unknown[] = [], tenantId = A) => db.run((c) => c.tx.query(text, values), { tenantId });
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'none'; };
const ins = (table: string, cols: Record<string, unknown>) => {
  const k = Object.keys(cols);
  return [`INSERT INTO catalog.${table} (${k.join(', ')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(cols)] as const;
};
const base = { tenant_id: A, effective_from: '2026-01-01T00:00:00.000Z', created_by: USERID, updated_by: USERID };

describe('taxDb fake (T-18 fixture)', () => {
  it('seeds the global VAT row (1300 bp), visible to every tenant, read-only', async () => {
    const db = mk();
    expect((await sql(db, 'SELECT code, rate_bp FROM catalog.g_tax_types WHERE code = $1', ['VAT'], TENANT_B)).rows).toMatchObject([{ code: 'VAT', rate_bp: 1300 }]);
    expect(await code(sql(db, 'UPDATE catalog.g_tax_types SET rate_bp = $1 WHERE code = $2', [0, 'VAT']))).toBe('42501');
    expect(await code(sql(db, ...ins('g_tax_types', { id: ID(1), code: 'X', display: 'x', rate_bp: 1 })))).toBe('42501');
  });
  it('surcharge_rules: scope/key and kind/amount CHECKs, FK to department, mutable columns, RLS, no DELETE', async () => {
    const db = mk({ surcharge_rules: [srule(1, A)] });
    const ok = { ...base, id: ID(0x50), scope: 'all', amount_kind: 'flat', amount_paisa: 5 };
    expect(await code(sql(db, ...ins('surcharge_rules', { ...ok, scope: 'department' })))).toBe('23514');
    expect(await code(sql(db, ...ins('surcharge_rules', { ...ok, amount_kind: 'percent' })))).toBe('23514');
    expect(await code(sql(db, ...ins('surcharge_rules', { ...ok, amount_paisa: 0 })))).toBe('23514');
    expect(await code(sql(db, ...ins('surcharge_rules', { ...ok, scope: 'department', department_id: ID(0x999) })))).toBe('23503');
    expect(await code(sql(db, ...ins('surcharge_rules', { ...ok, tenant_id: TENANT_B })))).toBe('42501');
    expect(await code(sql(db, ...ins('surcharge_rules', ok)))).toBe('none');
    expect(await code(sql(db, 'UPDATE catalog.surcharge_rules SET amount_paisa = $1 WHERE id = $2', [9, srule(1, A).id]))).toBe('P0001');
    expect(await code(sql(db, 'UPDATE catalog.surcharge_rules SET effective_to = $1 WHERE id = $2', ['2026-12-01T00:00:00.000Z', srule(1, A).id]))).toBe('none');
    expect(await code(sql(db, 'DELETE FROM catalog.surcharge_rules WHERE id = $1', [srule(1, A).id]))).toBe('42501');
  });
  it('tax_rules: one open rule per (scope, key), other_tax_code must be an ACTIVE tenant type, window CHECK, mutable columns', async () => {
    const db = mk({ tax_rules: [trule(1, A)], cs_tax_types: [ttype(1, A, 'HST'), ttype(2, A, 'OLD', { is_active: false })] });
    const ok = { ...base, id: ID(0x60), scope: 'tenant_default', vat_treatment: 'taxable' };
    const ord = { ...ok, scope: 'orderable', orderable_id: orderable(1, A).id };
    expect(await code(sql(db, ...ins('tax_rules', ok)))).toBe('23505');
    expect(await code(sql(db, ...ins('tax_rules', { ...ord, other_tax_code: 'NOPE' })))).toBe('23503');
    expect(await code(sql(db, ...ins('tax_rules', { ...ord, other_tax_code: 'OLD' })))).toBe('23503');
    expect(await code(sql(db, ...ins('tax_rules', { ...ord, effective_to: '2025-01-01T00:00:00.000Z' })))).toBe('23514');
    expect(await code(sql(db, ...ins('tax_rules', { ...ord, other_tax_code: 'HST', hs_code: '9018' })))).toBe('none');
    expect(await code(sql(db, 'UPDATE catalog.tax_rules SET vat_treatment = $1 WHERE id = $2', ['taxable', trule(1, A).id]))).toBe('P0001');
    expect(await code(sql(db, 'UPDATE catalog.tax_rules SET effective_to = $1 WHERE id = $2', ['2026-06-01T00:00:00.000Z', trule(1, A).id]))).toBe('none');
    expect(await code(sql(db, ...ins('tax_rules', { ...ok, id: ID(0x62) })))).toBe('none');
  });
  it('cs_tax_types: VAT code refused, one open version per code, strict window, rate immutable', async () => {
    const db = mk({ cs_tax_types: [ttype(1, A, 'HST')] });
    const ok = { ...base, id: ID(0x70), code: 'NEW', display: 'New', sort_order: 100 };
    expect(await code(sql(db, ...ins('cs_tax_types', { ...ok, code: 'VAT' })))).toBe('23514');
    expect(await code(sql(db, ...ins('cs_tax_types', { ...ok, code: 'HST', effective_from: '2026-02-01T00:00:00.000Z' })))).toBe('23505');
    expect(await code(sql(db, ...ins('cs_tax_types', { ...ok, rate_bp: 10001 })))).toBe('23514');
    expect(await code(sql(db, ...ins('cs_tax_types', { ...ok, effective_to: '2026-01-01T00:00:00.000Z' })))).toBe('23514');
    expect(await code(sql(db, ...ins('cs_tax_types', ok)))).toBe('none');
    expect(await code(sql(db, 'UPDATE catalog.cs_tax_types SET rate_bp = $1 WHERE id = $2', [1, ttype(1, A, 'HST').id]))).toBe('P0001');
    expect(await code(sql(db, 'UPDATE catalog.cs_tax_types SET effective_to = $1 WHERE id = $2', ['2026-06-01T00:00:00.000Z', ttype(1, A, 'HST').id]))).toBe('none');
  });
  it('other tenants\' rows are invisible; departments come from the masters fake', async () => {
    const db = mk({ tax_rules: [trule(9, TENANT_B)] });
    expect((await sql(db, 'SELECT id FROM catalog.tax_rules WHERE tenant_id = $1', [A])).rows).toEqual([]);
    expect(await code(sql(db, ...ins('tax_rules', { ...base, id: ID(0x61), scope: 'department', department_id: dept(1, A).id, vat_treatment: 'exempt' })))).toBe('none');
  });
});
