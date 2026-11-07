// Self-check of the T-06 SQL fake (helpers/testsDb.ts + the LIKE/CASE/|| additions to helpers/mastersDb.ts). If this fails, the fake is wrong,
// not the implementation. Passes before any T-06 implementation exists.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B } from './catalogDb.js';
import { dept, spec as specimen, cont } from './mastersDb.js';
import { ID, ana, anv, makeTestsDb, pnl, tat, tsr, tst, type Row } from './testsDb.js';

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
  it('ORDER BY accepts `col COLLATE "C"` (code-point order, as the repo tie-break needs)', async () => {
    const db = seed();
    const r = await q(db, `SELECT * FROM catalog.orderables WHERE tenant_id = $1 ORDER BY LENGTH(code), code COLLATE "C" DESC`, [TENANT_A]);
    expect(r.rows.map((x) => x.code)).toEqual(['C5', 'C4', 'C3', 'C2', 'C1']);
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
    const db = makeTestsDb({ rows: { departments: [D1] }, t6: { orderables: [p.orderable, t.orderable], panels: [p.panel], tests: [t.test],
      g_value_sets: [{ id: ID(0x5001), code: 'G_SET', display: 'g', is_ordered: true }] } });
    expect((await rej(q(db, 'DELETE FROM catalog.orderables WHERE tenant_id = $1', [TENANT_A]))).code).toBe('42501');
    // T-12: panels became writable; the value sets stay seed-only (their writers are T-05).
    expect((await rej(q(db, 'UPDATE catalog.g_value_sets SET display = $1 WHERE code = $2', ['x', 'G_SET']))).message).toMatch(/unsupported/);
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

describe('T-12 additions: panels / panel_members', () => {
  const p1 = pnl(1, TENANT_A, { code: 'P1' }); const p2 = pnl(2, TENANT_A, { code: 'P2' }); const t1 = tst(1, TENANT_A, D1.id, { code: 'T1' });
  const pb = pnl(9, TENANT_B, { code: 'PB' });
  const mk = (members: Row[] = []) => makeTestsDb({ rows: { departments: [D1, dept(9, TENANT_B)] }, t6: {
    orderables: [p1.orderable, p2.orderable, t1.orderable, pb.orderable], tests: [t1.test], panels: [p1.panel, p2.panel, pb.panel], panel_members: members } });
  const insM = (db: ReturnType<typeof mk>, panel: string, member: string, sort = 1, tenant = TENANT_A) =>
    q(db, 'INSERT INTO catalog.panel_members (tenant_id, panel_id, member_orderable_id, sort_order, created_by) VALUES ($1, $2, $3, $4, $5)', [tenant, panel, member, sort, ID(1)], tenant);

  it('panel_members: insert / select / delete (allowed) with PK 23505, not-self CHECK 23514, FK 23503, RLS 42501; rows are private to a tx until COMMIT', async () => {
    const db = mk();
    await insM(db, p1.panel.id, t1.test.id, 2);
    await insM(db, p1.panel.id, p2.panel.id, 1);
    expect((await rej(insM(db, p1.panel.id, t1.test.id))).constraint).toBe('panel_members__pk');
    expect((await rej(insM(db, p1.panel.id, p1.panel.id))).constraint).toBe('panel_members__not_self__ck');
    expect((await rej(insM(db, ID(0xdead), t1.test.id))).constraint).toBe('panel_members__panel__fk');
    expect((await rej(insM(db, p2.panel.id, ID(0xdead)))).constraint).toBe('panel_members__member__fk');
    expect((await rej(insM(db, pb.panel.id, t1.test.id, 1, TENANT_B))).constraint).toBe('panel_members__member__fk');      // a member of another tenant is invisible
    expect((await rej(insM(db, p1.panel.id, p2.panel.id, 1, TENANT_B))).code).toBe('23503');                              // tenant B cannot see panel P1
    const rows = (await q(db, 'SELECT * FROM catalog.panel_members WHERE tenant_id = $1 AND panel_id = $2 ORDER BY sort_order', [TENANT_A, p1.panel.id])).rows;
    expect(rows.map((r) => r.member_orderable_id)).toEqual([p2.panel.id, t1.test.id]);
    expect((await q(db, 'SELECT * FROM catalog.panel_members WHERE tenant_id = $1', [TENANT_A], TENANT_B)).rows).toHaveLength(0);     // RLS: B sees none of A's rows
    await q(db, 'DELETE FROM catalog.panel_members WHERE tenant_id = $1 AND panel_id = $2', [TENANT_A, p1.panel.id]);
    expect(db.rows('panel_members')).toHaveLength(0);
  });
  it('panels: UPDATE works (version, is_active); panel_kind CHECK 23514; INSERT needs the orderable (23503) and a unique id (23505); DELETE 42501', async () => {
    const db = mk();
    const r = await q(db, 'UPDATE catalog.panels SET version = version + 1, is_active = $3 WHERE tenant_id = $1 AND id = $2 RETURNING version', [TENANT_A, p1.panel.id, false]);
    expect(r.rows[0].version).toBe(2);
    expect(db.row('panels', p1.panel.id)).toMatchObject({ version: 2, is_active: false });
    expect((await rej(q(db, 'UPDATE catalog.panels SET panel_kind = $3 WHERE tenant_id = $1 AND id = $2', [TENANT_A, p1.panel.id, 'bundle']))).code).toBe('23514');
    const ins = (id: string) => q(db, 'INSERT INTO catalog.panels (id, tenant_id, panel_kind, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)', [id, TENANT_A, 'clinical', ID(1)]);
    expect((await rej(ins(ID(0xbeef)))).code).toBe('23503');                         // no orderables row of kind panel with that id
    expect((await rej(ins(t1.test.id))).code).toBe('23503');                         // an orderable of kind test is not a panel
    expect((await rej(ins(p2.panel.id))).code).toBe('23505');
    expect((await rej(q(db, 'DELETE FROM catalog.panels WHERE tenant_id = $1', [TENANT_A]))).code).toBe('42501');
  });
});

describe('T-07 additions: analytes / analyte_versions constraints + the two version triggers', () => {
  const t = tst(1, TENANT_A, D1.id);
  const A1 = ana(1, TENANT_A, t.test.id, { code: 'HB' });
  const draftRow = anv(1, TENANT_A, A1.id, { version_no: 1, status: 'draft', decimals: 1, unit_code: 'g_dl', effective_from: null, published_at: null, change_reason: null });
  const pubRow = anv(2, TENANT_A, A1.id, { version_no: 2, status: 'published', decimals: 1, unit_code: 'g_dl' });
  const mk = (versions: Row[]) => makeTestsDb({ rows: { departments: [D1] }, t6: { orderables: [t.orderable], tests: [t.test], analytes: [A1], analyte_versions: versions,
    g_value_sets: [{ id: ID(0x5001), code: 'G_SET', display: 'g', is_ordered: true }], cs_value_sets: [{ id: ID(0x5003), tenant_id: TENANT_B, code: 'B_SET', display: 'b', is_ordered: true }] } });
  const upd = (db: ReturnType<typeof mk>, id: string, set: string) => q(db, `UPDATE catalog.analyte_versions SET ${set} WHERE tenant_id = $1 AND id = $2`, [TENANT_A, id]);

  it('P0001 immutable_row: clinical columns of a published row cannot change; status/effective_to/updated_*/version can; illegal transitions are refused', async () => {
    const db = mk([draftRow, pubRow]);
    for (const set of ["unit_code = 'mg_dl'", 'decimals = 3', "change_reason = 'x'", "status = 'draft'"]) expect((await rej(upd(db, pubRow.id, set))).code, set).toBe('P0001');
    await upd(db, pubRow.id, "effective_to = '2027-01-01T00:00:00.000Z', version = 2, updated_by = '" + ID(7) + "'");
    expect(db.row('analyte_versions', pubRow.id)).toMatchObject({ version: 2 });
    await upd(db, pubRow.id, "status = 'superseded'");
    expect((await rej(upd(db, pubRow.id, "status = 'published'"))).code).toBe('P0001');       // nothing out of superseded
    expect((await rej(upd(db, draftRow.id, "status = 'superseded', effective_from = '2026-01-01T00:00:00.000Z'"))).code).toBe('P0001');
  });
  it('a draft is editable; draft -> published needs the published_* fields (CHECK 23514); draft -> discarded is legal and final', async () => {
    const db = mk([draftRow]);
    await upd(db, draftRow.id, "unit_code = 'mg_dl'");
    expect((await rej(upd(db, draftRow.id, "status = 'published'"))).code).toBe('23514');
    await upd(db, draftRow.id, "status = 'discarded'");
    expect((await rej(upd(db, draftRow.id, "status = 'draft'"))).code).toBe('P0001');
  });
  it('one draft per analyte and one row per version_no (23505); CHECKs 23514; FK 23503; DELETE 42501', async () => {
    const db = mk([draftRow, pubRow]);
    const ins = (cols: string, vals: string, v: unknown[]) => q(db, `INSERT INTO catalog.analyte_versions (${cols}) VALUES (${vals})`, v);
    const base = (n: number, over: Row = {}) => ({ id: ID(0x9000 + n), tenant_id: TENANT_A, analyte_id: A1.id, version_no: 3, status: 'draft', result_type: 'numeric', decimals: 1, created_by: ID(1), updated_by: ID(1), ...over });
    const put = (r: Row) => ins('id, tenant_id, analyte_id, version_no, status, result_type, decimals, method_id, created_by, updated_by', '$1, $2, $3, $4, $5, $6, $7, $8, $9, $10',
      [r.id, r.tenant_id, r.analyte_id, r.version_no, r.status, r.result_type, r.decimals ?? null, r.method_id ?? null, r.created_by, r.updated_by]);
    expect((await rej(put(base(1)))).constraint).toBe('analyte_versions__tenant_id_analyte_id__draft__p_uq');
    expect((await rej(put(base(2, { version_no: 2, status: 'discarded' })))).constraint).toBe('analyte_versions__tenant_id_analyte_id_version_no__uq');
    expect((await rej(put(base(3, { version_no: 3, status: 'discarded', result_type: 'numeric', decimals: null })))).code).toBe('23514');
    expect((await rej(put(base(4, { version_no: 3, status: 'discarded', analyte_id: ID(0xdead) })))).code).toBe('23503');
    expect((await rej(put(base(5, { version_no: 3, status: 'discarded', method_id: ID(0xdead) })))).code).toBe('23503');
    expect((await rej(q(db, 'DELETE FROM catalog.analyte_versions WHERE tenant_id = $1', [TENANT_A]))).code).toBe('42501');
  });
  it('analytes: UNIQUE(tenant, code) 23505, code CHECK 23514, FK test 23503; global value sets are visible to every tenant, tenant sets only to their own', async () => {
    const db = mk([]);
    const ins = (id: string, code: string, test: string) => q(db, 'INSERT INTO catalog.analytes (id, tenant_id, test_id, code, name, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, TENANT_A, test, code, 'n', ID(1), ID(1)]);
    expect((await rej(ins(ID(0x9100), 'HB', t.test.id))).code).toBe('23505');
    expect((await rej(ins(ID(0x9101), 'hb2', t.test.id))).code).toBe('23514');
    expect((await rej(ins(ID(0x9102), 'NEW', ID(0xdead)))).code).toBe('23503');
    await ins(ID(0x9103), 'NEW', t.test.id);
    expect((await q(db, 'SELECT * FROM catalog.g_value_sets WHERE code = $1', ['G_SET'])).rows).toHaveLength(1);
    expect((await q(db, 'SELECT * FROM catalog.g_value_sets WHERE code = $1', ['G_SET'], TENANT_B)).rows).toHaveLength(1);
    expect((await q(db, 'SELECT * FROM catalog.cs_value_sets WHERE tenant_id = $1 AND code = $2', [TENANT_A, 'B_SET'])).rows).toHaveLength(0);
    expect((await rej(q(db, 'UPDATE catalog.g_value_sets SET display = $1 WHERE code = $2', ['x', 'G_SET']))).message).toMatch(/unsupported/);
  });
});

describe('T-14 additions: tat_targets', () => {
  const t = tst(1, TENANT_A, D1.id, { code: 'CBC' });
  const tb = tst(2, TENANT_B, dept(9, TENANT_B).id, { code: 'CBC' });
  const mk = () => makeTestsDb({ rows: { departments: [D1, dept(9, TENANT_B)] }, t6: { orderables: [t.orderable, tb.orderable], tests: [t.test, tb.test],
    tat_targets: [tat(1, TENANT_A, t.test.id), tat(2, TENANT_B, tb.test.id)] } });
  const INS = 'INSERT INTO catalog.tat_targets (id, tenant_id, test_id, priority, segment, target_seconds, effective_from, effective_to, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)';
  const ins = (db: ReturnType<typeof mk>, o: { id?: string; test?: string; priority?: string; segment?: string; sec?: unknown; from?: string; to?: string | null; tenant?: string } = {}) =>
    q(db, INS, [o.id ?? ID(0xa001), o.tenant ?? TENANT_A, o.test ?? t.test.id, o.priority ?? 'urgent', o.segment ?? 'within_lab', o.sec ?? 3600, o.from ?? '2026-02-01T00:00:00.000Z', o.to ?? null, ID(1)]);

  it('RLS reads, count(*), the seed row loads with its defaults (segment, version, is_active, audit columns)', async () => {
    const db = mk();
    expect((await q(db, 'SELECT * FROM catalog.tat_targets WHERE tenant_id = $1', [TENANT_A])).rows.map((r) => r.id)).toEqual([ID(0x9001)]);
    expect((await q(db, 'SELECT count(*) FROM catalog.tat_targets', [], TENANT_B)).rows[0]!.count).toBe('1');
    expect(db.rows('tat_targets', TENANT_A)[0]).toMatchObject({ priority: 'routine', segment: 'within_lab', target_seconds: 14400, effective_to: null, version: 1, is_active: true });
  });

  it('partial UNIQUE (tenant, test, priority) WHERE effective_to IS NULL: a second open row -> 23505; a closed row, another priority or another test is fine; ending first then inserting works', async () => {
    const db = mk();
    expect((await rej(ins(db, { priority: 'routine' }))).constraint).toBe('tat_targets__open__p_uq');
    await ins(db, { priority: 'routine', id: ID(0xa002), from: '2025-01-01T00:00:00.000Z', to: '2025-06-01T00:00:00.000Z' });
    await ins(db, { priority: 'urgent', id: ID(0xa003) });
    await db.run(async (ctx) => {
      await ctx.tx.query('UPDATE catalog.tat_targets SET effective_to = $1 WHERE tenant_id = $2 AND id = $3', ['2026-03-01T00:00:00.000Z', TENANT_A, ID(0x9001)]);
      await ctx.tx.query(INS, [ID(0xa004), TENANT_A, t.test.id, 'routine', 'within_lab', 7200, '2026-03-01T00:00:00.000Z', null, ID(1)]);
    });
    expect(db.rows('tat_targets', TENANT_A).filter((r) => r.priority === 'routine' && r.effective_to == null).map((r) => r.id)).toEqual([ID(0xa004)]);
  });

  it('CHECKs 23514 (priority, segment, 60..2592000 integer seconds, window), FK test 23503 (also another tenant\'s test), RLS 42501, duplicate id 23505, DELETE 42501', async () => {
    const db = mk();
    for (const bad of [{ priority: 'normal' }, { segment: 'any' }, { sec: 59 }, { sec: 2592001 }, { sec: 1.5 }, { sec: '3600' }, { priority: 'routine', from: '2026-02-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }]) {
      expect((await rej(ins(db, bad as never))).code, JSON.stringify(bad)).toBe('23514');
    }
    await ins(db, { priority: 'routine', id: ID(0xa010), sec: 60, from: '2025-01-01T00:00:00.000Z', to: '2025-01-01T00:00:00.000Z' });          // zero-length window and 60 s are legal
    expect((await rej(ins(db, { test: ID(0xdead) }))).code).toBe('23503');
    expect((await rej(ins(db, { test: tb.test.id }))).code).toBe('23503');
    expect((await rej(ins(db, { tenant: TENANT_B }))).code).toBe('42501');
    expect((await rej(ins(db, { id: ID(0x9001), priority: 'urgent' }))).code).toBe('23505');
    expect((await rej(q(db, 'DELETE FROM catalog.tat_targets WHERE tenant_id = $1', [TENANT_A]))).code).toBe('42501');
  });
});
