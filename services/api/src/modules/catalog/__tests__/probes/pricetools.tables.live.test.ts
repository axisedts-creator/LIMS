// T0B-PRICETOOLS-1 / 07-SECURITY §6.3 table probes for the two tables of migration 20261117200000 (catalog.price_list_import_batch, catalog.price_list_import_error) and the dated assignments, as the real
// lims_api login under RLS, owner-side truth via the superuser (the full pgTAP version is db/tests/catalog/T0C-PRICETOOLS-1_price_list_tools.test.sql).
//   structure  RLS enabled + FORCED, policies on the tenant, lims_app grants: batch SELECT INSERT UPDATE; error SELECT INSERT (append only); never DELETE / TRUNCATE; tenant_id leading index; audit trigger on the batch
//   isolation  with A's claims: SELECT sees zero B rows; INSERT of a B row fails 42501; UPDATE / DELETE of B rows change nothing
//   integrity  CHECKs and composite tenant FKs refuse bad rows even when the service is bypassed; the overlap trigger refuses an overlapping assignment even when the service is bypassed
//   claims     partner / portal / patient actors see no row
import { beforeAll, describe, expect, it } from 'vitest';
import { appTx, superTx } from '../testmgmt/helpers.js';
import { NEW_TABLES, T, TENANT_A, TENANT_B, objs, snapshot, uid, type Objs } from './pricetools.kit.js';

let A: Objs; let B: Objs;
beforeAll(async () => { A = await objs(TENANT_A); B = await objs(TENANT_B); }, T);

const dbError = async (tenant: string, sql: string, values: unknown[] = []): Promise<any> => {
  try { await appTx(tenant, (tx) => tx.query(sql, values)); } catch (e) { return e; }
  throw new Error(`expected a database error: ${sql}`);
};
const rowOf = async (table: string, where: string, values: unknown[]) => (await superTx(async (tx) => (await tx.query(`SELECT to_jsonb(x) AS j FROM catalog.${table} x WHERE ${where} LIMIT 1`, values)).rows))[0]?.j;
const GRANTS: Record<string, { sel: boolean; ins: boolean; upd: boolean }> = { price_list_import_batch: { sel: true, ins: true, upd: true }, price_list_import_error: { sel: true, ins: true, upd: false } };

describe('structure (catalog queries)', () => {
  it('both tables exist; RLS is enabled AND forced; select / insert policies on the tenant (batch also update), never a delete policy', async () => {
    const all = await superTx(async (tx) => (await tx.query(`SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'catalog' AND c.relkind IN ('r','p') AND NOT c.relispartition`)).rows);
    for (const t of NEW_TABLES) expect(all.map((x: any) => x.relname), t).toContain(t);
    expect(all.filter((x: any) => !x.relname.startsWith('g_') && (!x.rls || !x.forced)).map((x: any) => x.relname)).toEqual([]);
    const pol = await superTx(async (tx) => (await tx.query(`SELECT tablename, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'catalog' AND tablename = ANY($1)`, [[...NEW_TABLES]])).rows);
    expect(pol.filter((p: any) => p.tablename === 'price_list_import_batch').map((p: any) => p.cmd).sort()).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(pol.filter((p: any) => p.tablename === 'price_list_import_error').map((p: any) => p.cmd).sort()).toEqual(['INSERT', 'SELECT']);
    for (const p of pol) expect(`${p.qual ?? ''}${p.with_check ?? ''}`, `${p.tablename} ${p.cmd}`).toMatch(/current_tenant_id/);
  });
  it('grants: the upload history is never deleted; the error table is append only (no UPDATE either)', async () => {
    const r = await superTx(async (tx) => (await tx.query(`SELECT c.relname, has_table_privilege('lims_app', c.oid, 'DELETE') AS del, has_table_privilege('lims_app', c.oid, 'TRUNCATE') AS trunc,
      has_table_privilege('lims_app', c.oid, 'UPDATE') AS upd, has_table_privilege('lims_app', c.oid, 'INSERT') AS ins, has_table_privilege('lims_app', c.oid, 'SELECT') AS sel
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'catalog' AND c.relname = ANY($1)`, [[...NEW_TABLES]])).rows);
    expect(r).toHaveLength(2);
    for (const x of r) { expect([x.del, x.trunc], x.relname).toEqual([false, false]); expect({ sel: x.sel, ins: x.ins, upd: x.upd }, x.relname).toEqual(GRANTS[x.relname]); }
  });
  it('each new table has an index whose first column is tenant_id; the batch has an audit trigger', async () => {
    const r = await superTx(async (tx) => (await tx.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'catalog' AND c.relname = ANY($1)
      AND EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE i.indrelid = c.oid AND a.attname = 'tenant_id')`, [[...NEW_TABLES]])).rows);
    expect(r.map((x: any) => x.relname).sort()).toEqual([...NEW_TABLES].sort());
    const trg = await superTx(async (tx) => (await tx.query(`SELECT 1 FROM pg_trigger g WHERE g.tgrelid = 'catalog.price_list_import_batch'::regclass AND NOT g.tgisinternal AND g.tgname LIKE '%audit%'`)).rows);
    expect(trg.length).toBeGreaterThanOrEqual(1);
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

describe('error rows are append only: even tenant A cannot change one', () => {
  it('UPDATE of an own error row is refused (42501, no grant); the row is unchanged', { timeout: T }, async () => {
    const before = await rowOf('price_list_import_error', 'tenant_id = $1', [TENANT_A]);
    expect(before, 'the kit created an error row').toBeTruthy();
    expect((await dbError(TENANT_A, `UPDATE catalog.price_list_import_error SET message = 'tampered' WHERE tenant_id = $1`, [TENANT_A])).code).toBe('42501');
    expect((await rowOf('price_list_import_error', 'id = $1', [before.id])).message).toBe(before.message);
  });
});

describe('integrity: the database refuses bad rows even when the service is bypassed', () => {
  const ins = (table: string, row: Record<string, unknown>) => dbError(TENANT_A, `INSERT INTO catalog.${table} SELECT * FROM jsonb_populate_record(NULL::catalog.${table}, $1::jsonb)`, [JSON.stringify(row)]);
  it('price_list_import_batch: bad status / row count / hash / file ref / summary 23514, a list of another tenant 23503', { timeout: T }, async () => {
    const base = await rowOf('price_list_import_batch', 'tenant_id = $1', [TENANT_A]);
    expect((await ins('price_list_import_batch', { ...base, id: uid(), status: 'published' })).code).toBe('23514');
    expect((await ins('price_list_import_batch', { ...base, id: uid(), row_count: 5001 })).code).toBe('23514');
    expect((await ins('price_list_import_batch', { ...base, id: uid(), file_sha256: 'XYZ' })).code).toBe('23514');
    expect((await ins('price_list_import_batch', { ...base, id: uid(), file_ref: '' })).code).toBe('23514');
    expect((await ins('price_list_import_batch', { ...base, id: uid(), summary: [] })).code).toBe('23514');
    expect((await ins('price_list_import_batch', { ...base, id: uid(), price_list_id: B.list.id })).code).toBe('23503');
  });
  it('price_list_import_error: row_no 0, an empty column, a 301 character message 23514, a batch of another tenant 23503', { timeout: T }, async () => {
    const base = await rowOf('price_list_import_error', 'tenant_id = $1', [TENANT_A]);
    expect((await ins('price_list_import_error', { ...base, id: uid(), row_no: 0 })).code).toBe('23514');
    expect((await ins('price_list_import_error', { ...base, id: uid(), column_name: '' })).code).toBe('23514');
    expect((await ins('price_list_import_error', { ...base, id: uid(), message: 'x'.repeat(301) })).code).toBe('23514');
    expect((await ins('price_list_import_error', { ...base, id: uid(), batch_id: B.batch.id })).code).toBe('23503');
  });
  it('price_list_assignments: an overlapping period of one party is refused by the trigger (23505), an inverted window by the check (23514), even when the service is bypassed', { timeout: T }, async () => {
    const base = await rowOf('price_list_assignments', 'price_list_id = $1', [A.list.id]);
    expect(base, 'the kit list has an assignment (open ended from its creation)').toBeTruthy();
    const over = await ins('price_list_assignments', { ...base, id: uid(), effective_from: '2030-01-01T00:00:00Z', effective_to: '2030-02-01T00:00:00Z' });
    expect(over.code, over.message).toBe('23505');
    expect((await ins('price_list_assignments', { ...base, id: uid(), effective_from: '2031-01-01T00:00:00Z', effective_to: '2030-12-01T00:00:00Z' })).code).toBe('23514');
  });
});
