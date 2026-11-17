// T0B-TESTMGMT-1 / 07-SECURITY §6.3 table probes for the two tables of migration 20261117170000 (catalog.test_categories, catalog.test_stage_tat_targets), as the real lims_api login under RLS,
// owner-side truth via the superuser (the catalog twin of frontdesk tables.live; the full pgTAP version is db/tests/catalog/T0C-TESTMGMT-1_test_management_parity.test.sql).
//   structure  RLS enabled + FORCED, select / insert / update policies on the tenant, lims_app has SELECT, INSERT, UPDATE only (never DELETE / TRUNCATE), tenant_id leading index, no sequence
//   isolation  with A's claims: SELECT sees zero B rows; INSERT of a B row fails 42501; UPDATE / DELETE of B rows change nothing
//   integrity  CHECKs, unique keys and composite tenant FKs refuse bad rows even when the service is bypassed (the DB is the backstop, the service validates first)
//   claims     partner / portal / patient actors see no row
import { beforeAll, describe, expect, it } from 'vitest';
import { appTx, superTx } from '../testmgmt/helpers.js';
import { NEW_TABLES, T, TENANT_A, TENANT_B, objs, snapshot, uid, type Objs } from './testmgmt.kit.js';

let A: Objs; let B: Objs;
beforeAll(async () => { A = await objs(TENANT_A); B = await objs(TENANT_B); }, T);

const dbError = async (tenant: string, sql: string, values: unknown[] = []): Promise<any> => {
  try { await appTx(tenant, (tx) => tx.query(sql, values)); } catch (e) { return e; }
  throw new Error(`expected a database error: ${sql}`);
};
const rowOf = async (table: string, where: string, values: unknown[]) => (await superTx(async (tx) => (await tx.query(`SELECT to_jsonb(x) AS j FROM catalog.${table} x WHERE ${where} LIMIT 1`, values)).rows))[0]?.j;

describe('structure (catalog queries)', () => {
  it('both tables exist; RLS is enabled AND forced on every table of schema catalog; each new table has select, insert and update policies and no delete policy', async () => {
    const all = await superTx(async (tx) => (await tx.query(`SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'catalog' AND c.relkind IN ('r','p') AND NOT c.relispartition`)).rows);
    for (const t of NEW_TABLES) expect(all.map((x: any) => x.relname), t).toContain(t);
    // 05-SCHEMA §global tables: g_* reference tables are global (no tenant_id, no RLS by design); every tenant table must be RLS enabled + forced.
    expect(all.filter((x: any) => !x.relname.startsWith('g_') && (!x.rls || !x.forced)).map((x: any) => x.relname)).toEqual([]);
    const pol = await superTx(async (tx) => (await tx.query(`SELECT tablename, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'catalog' AND tablename = ANY($1)`, [[...NEW_TABLES]])).rows);
    for (const t of NEW_TABLES) {
      const mine = pol.filter((p: any) => p.tablename === t);
      expect(mine.map((p: any) => p.cmd).sort(), t).toEqual(['INSERT', 'SELECT', 'UPDATE']);
      for (const p of mine) expect(`${p.qual ?? ''}${p.with_check ?? ''}`, `${t} ${p.cmd}`).toMatch(/current_tenant_id/);
    }
  });
  it('grants: lims_app has SELECT, INSERT, UPDATE and never DELETE / TRUNCATE on the new tables (deactivate, never delete)', async () => {
    const r = await superTx(async (tx) => (await tx.query(`SELECT c.relname, has_table_privilege('lims_app', c.oid, 'DELETE') AS del, has_table_privilege('lims_app', c.oid, 'TRUNCATE') AS trunc,
      has_table_privilege('lims_app', c.oid, 'UPDATE') AS upd, has_table_privilege('lims_app', c.oid, 'INSERT') AS ins, has_table_privilege('lims_app', c.oid, 'SELECT') AS sel
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'catalog' AND c.relname = ANY($1)`, [[...NEW_TABLES]])).rows);
    expect(r).toHaveLength(2);
    for (const x of r) { expect([x.del, x.trunc], x.relname).toEqual([false, false]); expect([x.sel, x.ins, x.upd], x.relname).toEqual([true, true, true]); }
  });
  it('each new table has an index whose first column is tenant_id and an audit trigger; no sequences in the schema', async () => {
    const r = await superTx(async (tx) => (await tx.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'catalog' AND c.relname = ANY($1)
      AND EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE i.indrelid = c.oid AND a.attname = 'tenant_id')
      AND EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND NOT g.tgisinternal AND g.tgname LIKE '%audit%')`, [[...NEW_TABLES]])).rows);
    expect(r.map((x: any) => x.relname).sort()).toEqual([...NEW_TABLES].sort());
    expect(await superTx(async (tx) => (await tx.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'catalog' AND c.relkind = 'S'`)).rows)).toEqual([]);
  });
});

describe.each(NEW_TABLES.map((t) => [t] as const))('catalog.%s: tenant A claims against tenant B rows', (t) => {
  it('SELECT sees zero rows of any other tenant', { timeout: T }, async () => {
    const r = await appTx(TENANT_A, async (tx) => ({ foreign: (await tx.query(`SELECT count(*)::int AS n FROM catalog.${t} WHERE tenant_id <> $1`, [TENANT_A])).rows[0].n,
      b: (await tx.query(`SELECT count(*)::int AS n FROM catalog.${t} WHERE tenant_id = $1`, [TENANT_B])).rows[0].n }));
    expect(r).toEqual({ foreign: 0, b: 0 });
  });
  it('INSERT of a row carrying tenant B\'s id fails (RLS WITH CHECK, 42501)', { timeout: T }, async () => {
    const j = (await rowOf(t, 'tenant_id = $1', [TENANT_B])) ?? {};
    const e = await dbError(TENANT_A, `INSERT INTO catalog.${t} SELECT * FROM jsonb_populate_record(NULL::catalog.${t}, $1::jsonb)`, [JSON.stringify({ ...j, id: uid(), tenant_id: TENANT_B })]);
    expect(e.code, e.message).toBe('42501');
  });
  it('UPDATE and DELETE of B rows change zero rows (or are refused) and B stays byte-identical; DELETE of A\'s own rows is refused (no grant)', { timeout: T }, async () => {
    const before = await snapshot(TENANT_B);
    for (const sql of [`UPDATE catalog.${t} SET tenant_id = tenant_id WHERE tenant_id = $1`, `DELETE FROM catalog.${t} WHERE tenant_id = $1`]) {
      try { const r = await appTx(TENANT_A, (tx) => tx.query(sql, [TENANT_B])); expect(r.rowCount, sql).toBe(0); } catch (e: any) { expect(e.code, `${sql}: ${e.message}`).toBe('42501'); }
    }
    expect(await snapshot(TENANT_B)).toEqual(before);
    expect((await dbError(TENANT_A, `DELETE FROM catalog.${t} WHERE tenant_id = $1`, [TENANT_A])).code).toBe('42501');
    expect(await rowOf(t, 'tenant_id = $1', [TENANT_A])).toBeTruthy();
  });
  it.each(['partner', 'portal', 'patient'])('actor_type %s sees no row and cannot insert', { timeout: T }, async (actorType) => {
    const claims = JSON.stringify({ tenant_id: TENANT_A, sub: '01a1b34e-1000-7eee-9d29-d7ca59a102b5', actor_type: actorType });
    const n = await appTx(TENANT_A, async (tx) => { await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims]); return (await tx.query(`SELECT count(*)::int AS n FROM catalog.${t}`)).rows[0].n; });
    expect(n).toBe(0);
    const row = await rowOf(t, 'tenant_id = $1', [TENANT_A]);
    const e = await (async () => { try { await appTx(TENANT_A, async (tx) => { await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims]);
      await tx.query(`INSERT INTO catalog.${t} SELECT * FROM jsonb_populate_record(NULL::catalog.${t}, $1::jsonb)`, [JSON.stringify({ ...row, id: uid() })]); }); } catch (x) { return x as any; } return undefined; })();
    expect(e?.code, 'a non-staff actor must not insert').toBe('42501');
  });
});

describe('integrity: the database refuses bad rows even when the service is bypassed', () => {
  const ins = (table: string, row: Record<string, unknown>) => dbError(TENANT_A, `INSERT INTO catalog.${table} SELECT * FROM jsonb_populate_record(NULL::catalog.${table}, $1::jsonb)`, [JSON.stringify(row)]);
  it('test_categories: duplicate name per department (case-insensitive) 23505, bad length / order 23514, a department of another tenant 23503', { timeout: T }, async () => {
    const base = await rowOf('test_categories', 'tenant_id = $1', [TENANT_A]);
    expect((await ins('test_categories', { ...base, id: uid(), name: String(base.name).toUpperCase() })).code).toBe('23505');
    expect((await ins('test_categories', { ...base, id: uid(), name: 'ok1', display_order: 10000 })).code).toBe('23514');
    expect((await ins('test_categories', { ...base, id: uid(), name: '' })).code).toBe('23514');
    expect((await ins('test_categories', { ...base, id: uid(), name: 'ok2', footer_text: '' })).code).toBe('23514');
    expect((await ins('test_categories', { ...base, id: uid(), name: 'ok3', department_id: B.w.dept.id })).code).toBe('23503');
  });
  it('test_stage_tat_targets: one row per (tenant, test, stage) 23505, unknown stage / minutes out of range 23514, a test of another tenant 23503', { timeout: T }, async () => {
    const base = await rowOf('test_stage_tat_targets', 'tenant_id = $1', [TENANT_A]);
    expect((await ins('test_stage_tat_targets', { ...base, id: uid() })).code).toBe('23505');
    expect((await ins('test_stage_tat_targets', { ...base, id: uid(), stage: 'billing' })).code).toBe('23514');
    expect((await ins('test_stage_tat_targets', { ...base, id: uid(), target_minutes: -1 })).code).toBe('23514');
    expect((await ins('test_stage_tat_targets', { ...base, id: uid(), target_minutes: 43201 })).code).toBe('23514');
    expect((await ins('test_stage_tat_targets', { ...base, id: uid(), test_id: B.test.id })).code).toBe('23503');
  });
  // the CHECKs of the new columns of catalog.tests / analytes / reference_ranges are covered row by row in db/tests/catalog/T0C-TESTMGMT-1_test_management_parity.test.sql; the service
  // rules above them are proved in tests.rules.test.ts / analytes.test.ts / ranges.test.ts (each asserts "no write statement" for a rejected input)
  it('reference_ranges and analyte_versions: the widened CHECKs accept the new values and still refuse the rest', { timeout: T }, async () => {
    const defs = await superTx(async (tx) => (await tx.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace = 'catalog'::regnamespace
      AND conname IN ('analyte_versions__result_type__ck', 'reference_ranges__sex__ck', 'reference_ranges__age_low_unit__ck', 'reference_ranges__age_high_unit__ck', 'critical_limits__sex__ck')`)).rows);
    const d = Object.fromEntries(defs.map((x: any) => [x.conname, x.def as string]));
    for (const v of ['numeric', 'text', 'ordinal', 'coded', 'attachment', 'narrative', 'boolean', 'test_footer', 'space', 'graph', 'html_descriptive']) expect(d['analyte_versions__result_type__ck'], v).toContain(`'${v}'`);
    for (const k of ['reference_ranges__sex__ck', 'critical_limits__sex__ck']) for (const v of ['any', 'male', 'female', 'third_gender']) expect(d[k], `${k} ${v}`).toContain(`'${v}'`);
    for (const k of ['reference_ranges__age_low_unit__ck', 'reference_ranges__age_high_unit__ck']) for (const v of ['hour', 'day', 'week', 'month', 'year']) expect(d[k], `${k} ${v}`).toContain(`'${v}'`);
  });
});
