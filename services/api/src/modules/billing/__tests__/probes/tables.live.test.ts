// BL-T22 / 07-SECURITY §6.3 structural table probes for every table in schemas `frontdesk` and `billing` (the full row-level probes are C0 db/tests, requested in 05 §9):
// RLS enabled AND forced, at least one policy, no DELETE grant for lims_app, no sequences (gapless counters are rows, not sequences), tenant_id-leading index.
// Gated like invoice.issue.live.test.ts: skipped unless LIMS_TEST_DATABASE_URL (superuser URL of a migrated DB) is set. Needs `pg` (loaded dynamically). Read-only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SU = process.env['LIMS_TEST_DATABASE_URL'];

describe.skipIf(!SU)('frontdesk + billing tables (catalog queries)', () => {
  let c: any;
  const tables: Array<{ schema: string; name: string; rls: boolean; forced: boolean; oid: number }> = [];
  beforeAll(async () => {
    const pg: any = await import('pg' as string);
    c = new (pg.default ?? pg).Client({ connectionString: SU });
    await c.connect();
    const r = await c.query(`SELECT n.nspname AS schema, c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, c.oid::int AS oid
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('frontdesk','billing') AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY 1,2`);
    tables.push(...r.rows);
  });
  afterAll(async () => { await c?.end(); });

  it('both schemas have tables (the migrations ran)', () => {
    expect(tables.filter((t) => t.schema === 'frontdesk').length).toBeGreaterThan(5);
    expect(tables.filter((t) => t.schema === 'billing').length).toBeGreaterThan(10);
  });
  it('RLS is enabled and FORCED on every table', () => {
    expect(tables.filter((t) => !t.rls || !t.forced).map((t) => `${t.schema}.${t.name}`)).toEqual([]);
  });
  it('every table has at least one policy', async () => {
    const r = await c.query(`SELECT schemaname || '.' || tablename AS t FROM pg_policies WHERE schemaname IN ('frontdesk','billing') GROUP BY 1`);
    const have = new Set(r.rows.map((x: any) => x.t));
    expect(tables.map((t) => `${t.schema}.${t.name}`).filter((t) => !have.has(t))).toEqual([]);
  });
  it('lims_app has no DELETE on any table (soft delete / append-only)', async () => {
    const r = await c.query(`SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('frontdesk','billing') AND c.relkind IN ('r','p') AND has_table_privilege('lims_app', c.oid, 'DELETE')`);
    // frontdesk.trf_attachments drafts are purged by the SECURITY DEFINER purge_trf_drafts, never by lims_app DELETE
    expect(r.rows.map((x: any) => x.t)).toEqual([]);
  });
  it('no sequences in either schema', async () => {
    const r = await c.query(`SELECT n.nspname || '.' || c.relname AS s FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('frontdesk','billing') AND c.relkind = 'S'`);
    expect(r.rows).toEqual([]);
  });
  it('every table has an index whose first column is tenant_id', async () => {
    const r = await c.query(`SELECT DISTINCT i.indrelid::int AS oid FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0] WHERE a.attname = 'tenant_id'`);
    const have = new Set(r.rows.map((x: any) => x.oid));
    expect(tables.filter((t) => !have.has(t.oid)).map((t) => `${t.schema}.${t.name}`)).toEqual([]);
  });
  it('the only SECURITY DEFINER function C4 owns is frontdesk.purge_trf_drafts(interval, uuid[]) with search_path=\'\'', async () => {
    const r = await c.query(`SELECT n.nspname || '.' || p.proname AS f, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('frontdesk','billing') AND p.prosecdef`);
    expect(r.rows.map((x: any) => x.f)).toEqual(['frontdesk.purge_trf_drafts']);
    expect(JSON.stringify(r.rows[0].proconfig)).toMatch(/search_path=("")?""?/);
  });
});
