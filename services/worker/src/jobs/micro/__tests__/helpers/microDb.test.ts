import { expect, it } from 'vitest';
import { SET_ID, TENANT_A, makeWorld } from './microDb.js';
it('fake works', async () => {
  const { ctxFor, w, set } = makeWorld();
  const { ctx, commit, rollback } = ctxFor();
  const q = (t: string, p: unknown[] = []) => (ctx as any).tx.query(t, p);
  expect((await q('SELECT * FROM micro.breakpoint_sets WHERE id = $1 AND tenant_id = $2', [SET_ID, TENANT_A])).rowCount).toBe(1);
  await q("UPDATE micro.breakpoint_sets SET status = 'validating', validation_started_at = now() WHERE id = $1 AND status = 'uploaded'", [SET_ID]);
  expect(set().status).toBe('validating');
  await expect(q("UPDATE micro.breakpoint_sets SET status = 'validating' WHERE id = $1", [SET_ID])).rejects.toMatchObject({ code: 'P0001' });
  await q('INSERT INTO micro.breakpoint_rows (id, tenant_id, set_id, line_no, organism_scope, antibiotic_code, method, created_by) VALUES ($1,$2,$3,2,\'any\',\'a\',\'mic\',$4)', ['r1', TENANT_A, SET_ID, 'u']);
  await q('INSERT INTO micro.breakpoint_bands (id, tenant_id, set_id, row_id, band_no, category_code, upper_value, created_by) VALUES ($1,$2,$3,$4,1,\'S\',$5,$6),($7,$2,$3,$4,2,\'R\',$8,$6)', ['b1', TENANT_A, SET_ID, 'r1', '2', 'u', 'b2', '4']);
  expect(w.bands).toHaveLength(2);
  await expect(q('INSERT INTO micro.breakpoint_rows (id, tenant_id, set_id, line_no, organism_scope, antibiotic_code, method, created_by) VALUES ($1,$2,$3,2,\'any\',\'a\',\'mic\',$4)', ['r2', TENANT_A, SET_ID, 'u'])).rejects.toMatchObject({ code: '23505' });
  rollback(); commit();
  expect(w.rows).toHaveLength(0);
  expect(set().status).toBe('uploaded');
  expect((await q('SELECT code, is_active FROM micro.g_cs_organisms')).rowCount).toBe(2);
});
