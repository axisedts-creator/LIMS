// C10 T-10 — self-check of the test-side fake helpers/astWrites.ts (SAVEPOINT / aborted-transaction emulation, ast_results + ast_panels rules). These tests pass now: they prove the fake is a
// faithful stand-in, so the failing behaviour tests in ast.writes.test.ts fail for the handler stubs, not for the fake. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { astTx, type World } from './helpers/astWrites.js';

const T = '01a1a98a-ac40-7000-8000-00000000a001';
const u = (n: number) => `0190c60a-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CUL = u(0x1001), ISO = u(0x3001);
const world = (status = 'incubating'): World => ({
  cultures: [{ id: CUL, tenant_id: T, status, version: 1 }], isolates: [{ id: ISO, tenant_id: T, culture_id: CUL, status: 'identified', version: 1 }],
  ast_results: [], ast_panels: [], ast_panel_antibiotics: [],
  g_cs_ast_interpretations: [{ standard: 'CLSI', code: 'S' }, { standard: 'CLSI', code: 'R' }, { standard: 'EUCAST', code: 'S' }],
});
const INS = (cols = 'id, tenant_id, centre_id, culture_id, isolate_id, antibiotic_code, method, source, created_by, updated_by', vals = "$1, $2, $2, $3, $4, $5, 'mic', 'manual', $2, $2") =>
  `INSERT INTO micro.ast_results (${cols}) VALUES (${vals}) RETURNING *`;
const ins = (tx: any, n: number, abx = 'syn_amp') => tx.query(INS(), [u(0x4000 + n), T, CUL, ISO, abx]);
/** Runs a statement that must fail inside its own savepoint (a failed statement aborts the whole tx in PostgreSQL), then rolls the savepoint back. */
const failing = async (tx: any, f: () => Promise<unknown>): Promise<any> => { await tx.query('SAVEPOINT chk'); try { await f(); } catch (e) { await tx.query('ROLLBACK TO SAVEPOINT chk'); return e; } throw new Error('expected rejection'); };

describe('C10-T10 fake self-check (astWrites)', () => {
  it('SAVEPOINT / ROLLBACK TO restores everything written since; RELEASE keeps it', async () => {
    const { tx, world: w } = astTx(world());
    await ins(tx, 1);
    await tx.query('SAVEPOINT ast_entry_1');
    await ins(tx, 2, 'syn_cip');
    await tx.query('ROLLBACK TO SAVEPOINT ast_entry_1');
    expect(w['ast_results']!.map((r) => r['antibiotic_code'])).toEqual(['syn_amp']);
    await tx.query('SAVEPOINT ast_entry_2'); await ins(tx, 3, 'syn_cip'); await tx.query('RELEASE SAVEPOINT ast_entry_2');
    expect(w['ast_results']).toHaveLength(2);
  });

  it('after a failing statement the transaction is aborted (25P02) until ROLLBACK TO; a savepoint makes the next entry possible, no savepoint does not', async () => {
    const a = astTx(world());
    await ins(a.tx, 1);
    await expect(ins(a.tx, 2)).rejects.toMatchObject({ code: '23505', constraint: 'ast_results__isolate_abx_method__uq' });
    await expect(ins(a.tx, 3, 'syn_cip')).rejects.toMatchObject({ code: '25P02' });
    const b = astTx(world());
    await ins(b.tx, 1);
    await b.tx.query('SAVEPOINT s1');
    await expect(ins(b.tx, 2)).rejects.toMatchObject({ code: '23505' });
    await b.tx.query('ROLLBACK TO SAVEPOINT s1');
    await ins(b.tx, 3, 'syn_cip');
    expect(b.world['ast_results']).toHaveLength(2);
  });

  it('only plain savepoint identifiers; handlers may not BEGIN / COMMIT / ROLLBACK; unknown savepoint is 3B001', async () => {
    const { tx } = astTx(world());
    await expect(tx.query('SAVEPOINT "a; DROP TABLE x"')).rejects.toThrow(/fake dialect/);
    for (const s of ['BEGIN', 'COMMIT', 'ROLLBACK']) await expect(tx.query(s)).rejects.toThrow(/fake dialect/);
    await expect(tx.query('ROLLBACK TO SAVEPOINT nope')).rejects.toMatchObject({ code: '3B001' });
  });

  it('ast_results rules: defaults (report_visibility shown), category needs value / standard (23514), category FK, final lock (P0001), culture / isolate FK (23503)', async () => {
    const { tx, world: w } = astTx(world());
    const r = await ins(tx, 1);
    expect(r.rows[0]).toMatchObject({ report_visibility: 'shown', off_panel: false, is_reportable: true, version: 1, raw_value: null });
    const upd = (set: string, id = u(0x4001)) => tx.query(`UPDATE micro.ast_results SET ${set} WHERE tenant_id = $1 AND id = $2`, [T, id]);
    for (const [set, name] of [["category_code = 'S', standard = 'CLSI', standard_version = '2026'", 'ast_results__category_needs_value__ck'],
      ["raw_value = '2', category_code = 'S'", 'ast_results__category_needs_std__ck'], ["raw_value = 'x', standard = 'unknown', standard_version = '1', category_code = 'S'", 'ast_results__unknown__ck'],
      ["report_visibility = 'hidden'", 'ast_results__visibility__ck']] as const) {
      const fresh = astTx(world()); await ins(fresh.tx, 1);
      await expect(fresh.tx.query(`UPDATE micro.ast_results SET ${set} WHERE tenant_id = $1 AND id = $2`, [T, u(0x4001)]), set).rejects.toMatchObject({ code: '23514', constraint: name });
      expect(fresh.world['ast_results']![0]).toMatchObject({ category_code: null, report_visibility: 'shown' });
    }
    expect(await failing(tx, () => upd("raw_value = '2', category_code = 'SDD', standard = 'CLSI', standard_version = '2026'"))).toMatchObject({ code: '23503', constraint: 'ast_results__category__fk' });
    const f = astTx(world('final_submitted'));
    await expect(ins(f.tx, 1)).rejects.toMatchObject({ code: 'P0001', message: 'immutable_row' });
    w['cultures']![0]!['status'] = 'final_submitted';
    expect(await failing(tx, () => upd("raw_value = '1'"))).toMatchObject({ code: 'P0001' });
    await expect(astTx(world()).tx.query(INS(), [u(1), T, u(0x10ff), ISO, 'syn_amp'])).rejects.toMatchObject({ code: '23503' });
  });

  it('INSERT ... ON CONFLICT DO NOTHING skips a duplicate (isolate, antibiotic, method) and keeps the first row', async () => {
    const { tx, world: w } = astTx(world());
    const sql = INS().replace(' RETURNING *', ' ON CONFLICT DO NOTHING RETURNING *');
    await tx.query(sql, [u(0x4001), T, CUL, ISO, 'syn_amp']);
    const r = await tx.query(sql, [u(0x4002), T, CUL, ISO, 'syn_amp']);
    expect(r.rows).toEqual([]);
    expect(w['ast_results']).toHaveLength(1);
  });

  it('ast_panels: a new version must supersede the old current row first (partial unique on code WHERE superseded_at IS NULL, 23505 with constraint); scope CHECK; null-method antibiotics may repeat', async () => {
    const w = world();
    const { tx } = astTx(w);
    const P = (id: string, v: number, extra = '') => tx.query(`INSERT INTO micro.ast_panels (id, tenant_id, code, version_no, display, default_method, created_by, updated_by${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ($1, $2, 'syn_panel', ${v}, 'x', 'mic', $2, $2${extra ? ", '" + extra.split('=')[1] + "'" : ''}) RETURNING *`, [id, T]);
    await P(u(0x5001), 1);
    expect(await failing(tx, () => P(u(0x5002), 2))).toMatchObject({ code: '23505', constraint: 'ast_panels__tenant_id_code__p_uq' });
    expect(await failing(tx, () => P(u(0x5002), 1))).toMatchObject({ code: '23505', constraint: 'ast_panels__tenant_id_code_version__uq' });
    await tx.query('UPDATE micro.ast_panels SET superseded_at = now() WHERE tenant_id = $1 AND id = $2', [T, u(0x5001)]);
    await P(u(0x5002), 2);
    expect(w['ast_panels']!.map((r) => r['version_no'])).toEqual([1, 2]);
    expect(await failing(tx, () => tx.query(`INSERT INTO micro.ast_panels (id, tenant_id, code, version_no, display, default_method, organism_code, organism_group_code, created_by, updated_by) VALUES ($1, $2, 'syn_other', 1, 'x', 'mic', 'a_b', 'c_d', $2, $2)`, [u(0x5003), T])))
      .toMatchObject({ code: '23514', constraint: 'ast_panels__scope__ck' });
    const A = (id: string, abx: string, m: string) => tx.query(`INSERT INTO micro.ast_panel_antibiotics (id, tenant_id, panel_id, antibiotic_code, sort_order, method, created_by, updated_by) VALUES ($1, $2, $3, $4, 0, ${m}, $2, $2)`, [id, T, u(0x5002), abx]);
    await A(u(0x6001), 'syn_amp', 'NULL'); await A(u(0x6002), 'syn_amp', 'NULL');
    await A(u(0x6003), 'syn_cip', "'mic'");
    expect(await failing(tx, () => A(u(0x6004), 'syn_cip', "'mic'"))).toMatchObject({ code: '23505' });
    expect(await failing(tx, () => tx.query(`INSERT INTO micro.ast_panel_antibiotics (id, tenant_id, panel_id, antibiotic_code, sort_order, created_by, updated_by) VALUES ($1, $2, $3, 'syn_x', 0, $2, $2)`, [u(0x6005), T, u(0x50ff)]))).toMatchObject({ code: '23503' });
  });

  it('SELECT honours IS NULL / IS NOT NULL / = TRUE|FALSE next to the equalities', async () => {
    const w = world();
    w['ast_panels'] = [{ id: u(1), tenant_id: T, code: 'a', superseded_at: null, is_active: true }, { id: u(2), tenant_id: T, code: 'b', superseded_at: new Date(), is_active: true }, { id: u(3), tenant_id: T, code: 'c', superseded_at: null, is_active: false }];
    const { tx } = astTx(w);
    const ids = async (where: string) => (await tx.query(`SELECT id FROM micro.ast_panels WHERE tenant_id = $1 AND ${where}`, [T])).rows.map((r: any) => r.id);
    expect(await ids('superseded_at IS NULL AND is_active = TRUE')).toEqual([u(1)]);
    expect(await ids('superseded_at IS NOT NULL')).toEqual([u(2)]);
    expect(await ids('is_active = FALSE')).toEqual([u(3)]);
  });
});
