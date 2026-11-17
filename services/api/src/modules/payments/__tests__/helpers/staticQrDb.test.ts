// Self-test of the PG-T16 fake (helpers/staticQrDb.ts): it must behave like the 05-SCHEMA table and the C4 view, otherwise the service tests prove nothing.
import { describe, expect, it } from 'vitest';
import { CENTRE_1, CENTRE_B, TENANT_A, TENANT_B, USER, makeStaticQrDb, viewRow, type StaticQrDb } from './staticQrDb.js';

const ID = (n: number): string => `01930000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ins = (db: StaticQrDb, o: Record<string, unknown> = {}, tenantId = TENANT_A) => db.run((ctx) => ctx.tx.query(
  `INSERT INTO payments.static_qr_reconciliations (id, tenant_id, business_date, centre_id, system_entries, system_total_paisa, statement_total_paisa, statement_reference, status, note, reconciled_by, created_by, updated_by)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $11) RETURNING *`,
  [o['id'] ?? ID(1), o['tenant_id'] ?? tenantId, o['date'] ?? '2026-11-10', o['centre'] ?? null, 2, o['system'] ?? 1000, o['statement'] ?? 1000, o['ref'] ?? 'STMT-1', o['status'] ?? 'matched', o['note'] ?? null, USER]), { tenantId });
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'none'; } catch (e) { return String((e as any).code ?? (e as Error).message); } };

describe('staticQrDb fake', () => {
  it('SUM over the view: tenant RLS, method + date predicates, numeric -> string, COALESCE on empty', async () => {
    const db = makeStaticQrDb({ view: [
      viewRow({ business_date: '2026-11-10', payment_method_code: 'fonepay_qr', entries: 2, net_collected_paisa: 700 }),
      viewRow({ business_date: '2026-11-10', payment_method_code: 'fonepay_qr', entries: 1, net_collected_paisa: 300, centre_id: null }),
      viewRow({ business_date: '2026-11-10', payment_method_code: 'cash', entries: 9, net_collected_paisa: 9000 }),
      viewRow({ business_date: '2026-11-10', payment_method_code: 'fonepay_qr', entries: 5, net_collected_paisa: 5000, tenant_id: TENANT_B }),
    ] });
    const q = (t: string, vals: unknown[], tenantId = TENANT_A) => db.run((ctx) => ctx.tx.query(t, vals), { tenantId });
    const sql = 'SELECT COALESCE(SUM(net_collected_paisa), 0) AS total, COALESCE(SUM(entries), 0) AS n FROM billing.v_pub_payment_collection WHERE tenant_id = $1 AND business_date = $2 AND payment_method_code = $3';
    expect((await q(sql, [TENANT_A, '2026-11-10', 'fonepay_qr'])).rows).toEqual([{ total: '1000', n: '3' }]);
    expect((await q(sql, [TENANT_B, '2026-11-10', 'fonepay_qr'], TENANT_B)).rows).toEqual([{ total: '5000', n: '5' }]);
    expect((await q(sql, [TENANT_A, '2026-11-09', 'fonepay_qr'])).rows).toEqual([{ total: '0', n: '0' }]);
    expect((await q(`${sql} AND centre_id = $4`, [TENANT_A, '2026-11-10', 'fonepay_qr', CENTRE_1])).rows).toEqual([{ total: '700', n: '2' }]);
    expect(await code(q('DELETE FROM billing.v_pub_payment_collection', []))).toMatch(/unsupported/);
  });

  it('worksheet table: generated column, bigint strings, CHECKs, partial uniques, FK, RLS', async () => {
    const db = makeStaticQrDb();
    const r = (await ins(db, { statement: 900, status: 'accepted_with_difference', note: 'bank fee' })).rows[0]!;
    expect(r.difference_paisa).toBe('-100'); expect(r.system_total_paisa).toBe('1000'); expect(r.business_date).toBeInstanceOf(Date); expect(r.system_entries).toBe(2);
    expect(await code(ins(db, { id: ID(2), statement: 900, status: 'matched' }))).toBe('23514');                                 // matched while totals differ
    expect(await code(ins(db, { id: ID(2), statement: 900, status: 'accepted_with_difference' }))).toBe('23514');                  // difference without note
    expect(await code(ins(db, { id: ID(2), ref: '' }))).toBe('23514');
    expect(await code(ins(db, { id: ID(2), date: '2026-11-10' }))).toBe('23505');                                                // second "all centres" worksheet for the date
    expect(await code(ins(db, { id: ID(2), date: '2026-11-11' }))).toBe('none');
    expect(await code(ins(db, { id: ID(3), date: '2026-11-10', centre: CENTRE_1 }))).toBe('none');                                // a centre worksheet next to the "all" one
    expect(await code(ins(db, { id: ID(4), date: '2026-11-10', centre: CENTRE_1 }))).toBe('23505');
    expect(await code(ins(db, { id: ID(5), date: '2026-11-12', centre: CENTRE_B }))).toBe('23503');                                // centre of another tenant
    expect(await code(ins(db, { id: ID(6), tenant_id: TENANT_B }, TENANT_A))).toBe('42501');
    expect(await code(db.run((ctx) => ctx.tx.query('INSERT INTO payments.static_qr_reconciliations (id, tenant_id, difference_paisa) VALUES ($1, $2, 5)', [ID(7), TENANT_A])))).toBe('428C9');
    const other = await db.run((ctx) => ctx.tx.query('SELECT * FROM payments.static_qr_reconciliations', []), { tenantId: TENANT_B });
    expect(other.rows).toEqual([]);                                                                                                // RLS
  });

  it('rollback discards writes; committed writes are visible to the next transaction', async () => {
    const db = makeStaticQrDb();
    await db.run(async (ctx) => {
      await ctx.tx.query(`INSERT INTO payments.static_qr_reconciliations (id, tenant_id, business_date, system_entries, system_total_paisa, statement_total_paisa, statement_reference, status, reconciled_by, created_by, updated_by)
        VALUES ($1, $2, $3, 0, 0, 0, 'R', 'matched', $4, $4, $4)`, [ID(1), TENANT_A, '2026-11-10', USER]);
    }, { rollback: true });
    expect(db.worksheets()).toHaveLength(0);
    await ins(db, { id: ID(2) });
    expect(db.worksheets()).toHaveLength(1);
  });
});
