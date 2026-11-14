// C6-T04 — self-check of the in-memory Postgres fake (consumers.helpers.ts), so a consumer test cannot pass or fail because the fake is wrong.
import { describe, expect, it } from 'vitest';
import { ITEM_CBC, ITEM_OUT, ORDER, TENANT_A, TENANT_B, idN, makeDb, rejection, seededShell } from './consumers.helpers.js';

describe('consumers.helpers makeDb', () => {
  it('plain INSERT on a unique key -> 23505; ON CONFLICT DO NOTHING / DO UPDATE behave', async () => {
    const { db, LAB } = seededShell();
    const ins = `INSERT INTO reporting.reports (id, tenant_id, centre_id, branch_id, order_id, patient_id, family, order_source, registered_at, registration_no, centre_code, created_by, updated_by)
      VALUES ($1, $2, $3, $3, $4, $3, 'laboratory', 'front_desk', now(), 'R1', 'C1', $3, $3)`;
    const vals = [idN(0x9991), TENANT_A, idN(1), ORDER];
    expect((await rejection(db.tx.query(ins, vals))).code).toBe('23505');
    await db.tx.query(`${ins} ON CONFLICT (tenant_id, order_id, family) DO NOTHING`, vals);
    expect(db.reports()).toHaveLength(2);
    const { rows } = await db.tx.query(`${ins} ON CONFLICT (tenant_id, order_id, family) DO UPDATE SET registration_no = EXCLUDED.registration_no, version = reports.version + 1 RETURNING id`, vals);
    expect(rows[0]!.id).toBe(LAB);
    expect(db.reports().find((r) => r['id'] === LAB)).toMatchObject({ registration_no: 'R1', version: 2 });
  });

  it('SELECT/UPDATE: = ANY, OR groups, IS NULL, col + 1, RETURNING, tenant isolation (rls) and rls:false', async () => {
    const { db } = seededShell({}, {});
    const sel = await db.tx.query('SELECT * FROM reporting.report_order_items WHERE tenant_id = $1 AND order_item_id = ANY($2::uuid[]) AND (specimen_hint_seq IS NULL OR specimen_hint_seq < $3) ORDER BY id', [TENANT_A, [ITEM_CBC, ITEM_OUT], 4]);
    expect(sel.rows).toHaveLength(2);
    const upd = await db.tx.query('UPDATE reporting.report_order_items SET approved_results = approved_results + 1, specimen_hint = $3 WHERE tenant_id = $1 AND order_item_id = $2 RETURNING id', [TENANT_A, ITEM_CBC, 'rejected']);
    expect(upd.rows).toHaveLength(1);
    expect(db.items().find((r) => r['order_item_id'] === ITEM_CBC)).toMatchObject({ approved_results: 1, specimen_hint: 'rejected' });
    expect((await db.tx.query('UPDATE reporting.report_order_items SET approved_results = 9 WHERE tenant_id = $1 AND order_item_id = $2', [TENANT_B, ITEM_CBC])).rows).toHaveLength(0);
    expect(db.items().find((r) => r['order_item_id'] === ITEM_CBC)!['approved_results']).toBe(1);
    const open = seededShell({}, { rls: false }).db;                         // without RLS, a missing tenant predicate would hit every tenant
    await open.tx.query('UPDATE reporting.report_order_items SET approved_results = 9 WHERE order_item_id = $1', [ITEM_CBC]);
    expect(open.items().find((r) => r['order_item_id'] === ITEM_CBC)!['approved_results']).toBe(9);
  });

  it('INSERT for a foreign tenant -> 42501 under rls; child without parent -> 23503; app.enqueue_job is recorded', async () => {
    const { db, LAB } = seededShell();
    const e1 = await rejection(db.tx.query('INSERT INTO reporting.settings (id, tenant_id, created_by, updated_by) VALUES ($1, $2, $3, $3)', [idN(5), TENANT_B, idN(6)]));
    expect(e1.code).toBe('42501');
    const e2 = await rejection(db.tx.query('INSERT INTO reporting.report_order_items (id, tenant_id, report_id) VALUES ($1, $2, $3)', [idN(7), TENANT_A, idN(0xdead)]));
    expect(e2.code).toBe('23503');
    await db.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3, now() + interval \'30 seconds\', $4)', ['reporting.assemble_report', JSON.stringify({ tenant_id: TENANT_A, report_id: LAB }), `assemble:${LAB}`, 10]);
    expect(db.jobs).toHaveLength(1);
    expect(db.jobs[0]).toMatchObject({ identifier: 'reporting.assemble_report', jobKey: `assemble:${LAB}`, payload: { tenant_id: TENANT_A, report_id: LAB }, maxAttempts: 10 });
    expect(String(db.jobs[0]!.runAt)).toMatch(/30/);
  });

  it('unsupported SQL shapes fail loudly instead of silently matching nothing', async () => {
    const { db } = seededShell();
    expect((await rejection(db.tx.query('SELECT r.id FROM reporting.reports r JOIN reporting.report_order_items i ON i.report_id = r.id WHERE r.tenant_id = $1', [TENANT_A]))).message).toMatch(/FAKE-UNSUPPORTED-SQL/);
    expect((await rejection(db.tx.query('SELECT * FROM reporting.reports WHERE tenant_id = $1 AND lower(family) = $2', [TENANT_A, 'x']))).message).toMatch(/FAKE-UNSUPPORTED-SQL/);
  });
});
