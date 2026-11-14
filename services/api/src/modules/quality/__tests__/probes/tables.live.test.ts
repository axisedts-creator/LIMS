// C9 T-25 — live-DB table probes (07-SECURITY §5 S-02 RLS half, S-05, S-06, S-20, S-21; REQ-SEC-011/012/014/015/016/040/041/042/044; 08 A17 P-16/P-18(c)). Real PG17 with the C0 `quality` DDL applied.
// Needs LIMS_TEST_DATABASE_URL (role lims_api, RLS on) + LIMS_TEST_ADMIN_DATABASE_URL (superuser). Without them the file skips, except under LIMS_T25_REQUIRE_DB=1 where "database is provided" fails.
// Generic over the catalog (no stale hand list): the 26 tables of 05-SCHEMA §1 must be exactly what schema `quality` contains; the 24 tenant tables are each probed.
// Seeding: superuser tx with session_replication_role = replica (FKs/triggers off), NOT NULL columns auto-filled, ON CONFLICT DO NOTHING (re-runnable on a shared database).
// ASSUMED: claims JSON { tenant_id, sub, actor_type, [centre_id] } as lab/micro probes; centre-restricted actors = `device` + centre_id (app.current_centre_ids()); the view column is `tenant_id`.
// Fails now (with a database): the `quality` schema has no tables until C0 merges the DDL — the catalog test names the difference.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { A_TABLES, CENTRE_A1, CENTRE_A2, CENTRE_B1, CENTRE_TABLES, G_CS_TABLES, T, TENANT_A, TENANT_B, TENANT_TABLES, admin, api, buildRow, claimsOf, closePools, insertSql, live, owner, requireDb,
  uid, withClaims, type Row } from './kit.js';
import type pg from 'pg';

afterAll(async () => { await closePools(); });
describe('harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T25_REQUIRE_DB=1)', () => { if (requireDb) expect(live).toBe(true); });
});

const centreOf = (side: 'a' | 'b', table: string) => (CENTRE_TABLES as readonly string[]).includes(table) ? { centre_id: side === 'a' ? CENTRE_A1 : CENTRE_B1 } : {};
async function seed(table: string, given: Row): Promise<void> {
  const c = await admin().connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    const row = await buildRow(c, table, given);
    const q = insertSql(table, row, ' ON CONFLICT DO NOTHING');
    await c.query(q.text, q.values);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}
/** run one statement inside a savepoint; report the SQLSTATE or the affected rows (a failed statement does not poison the surrounding tx). */
async function attempt(c: pg.PoolClient, text: string, values: unknown[] = []): Promise<{ code?: string; rowCount?: number; rows?: any[] }> {
  await c.query('SAVEPOINT p');
  try { const r = await c.query(text, values); await c.query('RELEASE SAVEPOINT p'); return { rowCount: r.rowCount ?? 0, rows: r.rows }; }
  catch (e: any) { await c.query('ROLLBACK TO SAVEPOINT p'); return { code: e.code }; }
}
const snapshot = async (table: string, tenant: string) => (await owner(`SELECT count(*)::int AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS h FROM ${table} t WHERE t.tenant_id = $1`, [tenant]))[0];
const DENIED = new Set(['42501']);            // insufficient_privilege (RLS WITH CHECK violation and missing grant share it)
const asA = <R>(fn: (c: pg.PoolClient) => Promise<R>, extra: Row = {}) => withClaims(api(), claimsOf(TENANT_A, extra), fn, false);

describe.skipIf(!live)('catalog: schema quality is exactly 05-SCHEMA §1 and every tenant table is locked down', () => {
  it('26 tables = 24 tenant tables + the two g_cs_* coded sets', async () => {
    const names = (await owner(`SELECT format('%I.%I', schemaname, tablename) AS n FROM pg_tables WHERE schemaname = 'quality'`)).map((r) => r.n as string).sort();
    expect(names).toEqual([...TENANT_TABLES, ...G_CS_TABLES].sort());
  });
  it('ENABLE + FORCE ROW LEVEL SECURITY on every tenant table; tenant_id is NOT NULL with no default (REQ-SEC-011/026)', async () => {
    const rls = await owner(`SELECT format('%I.%I', n.nspname, c.relname) AS t, c.relrowsecurity AS on, c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'quality' AND c.relkind = 'r'`);
    for (const t of TENANT_TABLES) expect(rls.find((r) => r.t === t), t).toMatchObject({ on: true, forced: true });
    const cols = await owner(`SELECT table_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'quality' AND column_name = 'tenant_id'`);
    for (const t of TENANT_TABLES) expect(cols.find((r) => `quality.${r.table_name}` === t), t).toMatchObject({ is_nullable: 'NO', column_default: null });
  });
  it('no policy is USING (true) / WITH CHECK (true); every __tenant / __tenant_centre policy carries app.is_staff_or_system() (08 A17 P-16); centre policies cast ::uuid[] (08 A16.1)', async () => {
    const pol = await owner(`SELECT tablename, policyname, cmd, roles::text AS roles, coalesce(qual, '') AS qual, coalesce(with_check, '') AS wc FROM pg_policies WHERE schemaname = 'quality'`);
    expect(pol.length).toBeGreaterThan(20);
    for (const p of pol) {
      expect(p.qual.trim(), `${p.policyname} USING`).not.toBe('true');
      expect(p.wc.trim(), `${p.policyname} WITH CHECK`).not.toBe('true');
      expect(p.roles, `${p.policyname} is TO lims_app`).toContain('lims_app');
      if (/__tenant(_centre)?$/.test(p.policyname)) expect(`${p.qual} ${p.wc}`, p.policyname).toMatch(/is_staff_or_system/);
      if (/__tenant_centre$/.test(p.policyname)) expect(`${p.qual} ${p.wc}`, p.policyname).toMatch(/::uuid\[\]/);
    }
    expect(pol.filter((p) => p.cmd === 'DELETE').map((p) => p.policyname), 'the only DELETE policy (08 A17 P-18(c))').toEqual(['tat_items__delete__tenant']);
  });
  it('the three trigger functions exist, SECURITY INVOKER, search_path empty; no SECURITY DEFINER function in schema quality (S-18, REQ-SEC-019/020/021)', async () => {
    const fns = await owner(`SELECT p.proname, p.prosecdef, coalesce(p.proconfig::text, '') AS cfg FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'quality'`);
    for (const f of ['enforce_observation_exclusion', 'enforce_run_frozen', 'enforce_version_frozen']) expect(fns.map((x) => x.proname), f).toContain(f);
    for (const f of fns) { expect(f.prosecdef, `${f.proname} SECURITY DEFINER`).toBe(false); expect(f.cfg, f.proname).toMatch(/search_path=""|search_path=''/); }
  });
});

describe.skipIf(!live)('S-05 every tenant table: tenant A claims vs tenant B rows', () => {
  beforeAll(async () => {
    for (const t of TENANT_TABLES) for (const [side, tenant] of [['a', TENANT_A], ['b', TENANT_B]] as const) await seed(t, { id: uid(), tenant_id: tenant, ...centreOf(side, t) });
  }, T);

  it.each(TENANT_TABLES.map((t) => [t] as const))('%s: A sees zero B rows; INSERT tenant_id=B fails; UPDATE / DELETE of B rows affect 0 rows; B unchanged (owner check)', { timeout: T }, async (t) => {
    const before = await snapshot(t, TENANT_B);
    expect(before.n, `B has seeded rows in ${t}`).toBeGreaterThan(0);
    await asA(async (c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [TENANT_B])).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id <> $1`, [TENANT_A])).rows[0].n).toBe(0);
      const own = await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [TENANT_A]);
      expect(own.rows[0].n, `A control: A sees its own rows of ${t}`).toBeGreaterThan(0);
      const forged = await admin().connect();
      let row: Row;
      try { await forged.query('BEGIN'); await forged.query("SET LOCAL session_replication_role = 'replica'"); row = await buildRow(forged, t, { id: uid(), tenant_id: TENANT_B, ...centreOf('b', t) }); await forged.query('ROLLBACK'); } finally { forged.release(); }
      const ins = insertSql(t, row);
      const i = await attempt(c, ins.text, ins.values);
      expect(DENIED.has(i.code ?? ''), `INSERT of a B row under A claims must be refused (got ${JSON.stringify(i)})`).toBe(true);
      const u = await attempt(c, `UPDATE ${t} SET tenant_id = tenant_id WHERE tenant_id = $1`, [TENANT_B]);
      expect(u.code === undefined ? u.rowCount : 0, `UPDATE of B rows: ${JSON.stringify(u)}`).toBe(0);
      if (u.code !== undefined) expect(DENIED.has(u.code)).toBe(true);
      const d = await attempt(c, `DELETE FROM ${t} WHERE tenant_id = $1`, [TENANT_B]);
      expect(d.code === undefined ? d.rowCount : 0, `DELETE of B rows: ${JSON.stringify(d)}`).toBe(0);
      if (d.code !== undefined) expect(DENIED.has(d.code)).toBe(true);
    });
    expect(await snapshot(t, TENANT_B), 'B rows byte-identical after the probe').toEqual(before);
  });

  describe.each(['partner', 'portal', 'patient'])('sub-case (08 A17 P-16): actor_type %s of tenant A', (actorType) => {
    it.each(TENANT_TABLES.map((t) => [t] as const))('%s: reads 0 rows (A has rows) and cannot insert', { timeout: T }, async (t) => {
      const own = (await snapshot(t, TENANT_A)).n;
      expect(own, `A has seeded rows in ${t}`).toBeGreaterThan(0);
      await withClaims(api(), claimsOf(TENANT_A, { actor_type: actorType, partner_role: 'partner_admin' }), async (c) => {
        expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, `${actorType} sees rows of ${t}`).toBe(0);
        const forged = await admin().connect();
        let row: Row;
        try { await forged.query('BEGIN'); await forged.query("SET LOCAL session_replication_role = 'replica'"); row = await buildRow(forged, t, { id: uid(), tenant_id: TENANT_A, ...centreOf('a', t) }); await forged.query('ROLLBACK'); } finally { forged.release(); }
        const ins = insertSql(t, row);
        const i = await attempt(c, ins.text, ins.values);
        expect(DENIED.has(i.code ?? ''), `${actorType} INSERT into ${t}: ${JSON.stringify(i)}`).toBe(true);
      }, false);
    });
  });
});

describe.skipIf(!live)('S-02 (RLS half) the three TAT tables are centre-scoped: a device of centre A1 sees no centre-A2 row and cannot write one', () => {
  beforeAll(async () => { for (const t of CENTRE_TABLES) { await seed(t, { id: uid(), tenant_id: TENANT_A, centre_id: CENTRE_A1 }); await seed(t, { id: uid(), tenant_id: TENANT_A, centre_id: CENTRE_A2 }); } }, T);
  it.each(CENTRE_TABLES.map((t) => [t] as const))('%s', { timeout: T }, async (t) => {
    const device = (centre: string) => claimsOf(TENANT_A, { actor_type: 'device', centre_id: centre });
    await withClaims(api(), device(CENTRE_A1), async (c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE centre_id = $1`, [CENTRE_A2])).rows[0].n, 'A2 rows visible to an A1 device').toBe(0);
      expect((await c.query(`SELECT count(*)::int AS n FROM ${t} WHERE centre_id = $1`, [CENTRE_A1])).rows[0].n, 'control: A1 rows visible').toBeGreaterThan(0);
      const forged = await admin().connect();
      let row: Row;
      try { await forged.query('BEGIN'); await forged.query("SET LOCAL session_replication_role = 'replica'"); row = await buildRow(forged, t, { id: uid(), tenant_id: TENANT_A, centre_id: CENTRE_A2 }); await forged.query('ROLLBACK'); } finally { forged.release(); }
      const ins = insertSql(t, row);
      expect(DENIED.has((await attempt(c, ins.text, ins.values)).code ?? ''), 'insert into another centre').toBe(true);
    }, false);
    await withClaims(api(), claimsOf(TENANT_A), async (c) => {   // control: system actor of tenant A (all centres) sees both
      const r = await c.query(`SELECT count(DISTINCT centre_id)::int AS n FROM ${t} WHERE centre_id = ANY($1::uuid[])`, [[CENTRE_A1, CENTRE_A2]]);
      expect(r.rows[0].n).toBe(2);
    }, false);
  });
});

describe.skipIf(!live)('S-06 grants for lims_app', () => {
  it('DELETE is granted on quality.tat_items only; UPDATE is not granted on the append-only tables nor on qc_plan_versions', async () => {
    const all = [...TENANT_TABLES, ...G_CS_TABLES];
    const priv = await owner(`SELECT t, has_table_privilege('lims_app', t, 'DELETE') AS del, has_table_privilege('lims_app', t, 'UPDATE') AS upd FROM unnest($1::text[]) AS t`, [all]);
    for (const r of priv) {
      expect(r.del, `${r.t} DELETE`).toBe(r.t === 'quality.tat_items');
      if ([...A_TABLES, 'quality.qc_plan_versions'].includes(r.t)) expect(r.upd, `${r.t} UPDATE`).toBe(false);
    }
  });
});

describe.skipIf(!live)('S-20 quality.v_pub_qc_summary is a security-invoker view: tenant A claims see only A rows', () => {
  it('reloptions has security_invoker=true; no row of another tenant is visible', async () => {
    const o = await owner(`SELECT coalesce(reloptions::text, '') AS o FROM pg_class WHERE oid = 'quality.v_pub_qc_summary'::regclass`);
    expect(o[0].o).toMatch(/security_invoker=(true|on)/);
    await asA(async (c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM quality.v_pub_qc_summary WHERE tenant_id <> $1`, [TENANT_A])).rows[0].n).toBe(0);
    });
  });
});

describe.skipIf(!live)('S-21 purge probe on quality.tat_items (08 A17 P-18(c))', () => {
  it('DELETE under user claims affects 0 rows; under system claims only rows with expires_at < now() go', async () => {
    const past = uid(), future = uid();
    await seed('quality.tat_items', { id: past, tenant_id: TENANT_A, centre_id: CENTRE_A1, expires_at: new Date('2020-01-01T00:00:00Z') });
    await seed('quality.tat_items', { id: future, tenant_id: TENANT_A, centre_id: CENTRE_A1, expires_at: new Date('2099-01-01T00:00:00Z') });
    await withClaims(api(), claimsOf(TENANT_A, { actor_type: 'user', membership_id: uid() }), async (c) => {
      const r = await attempt(c, 'DELETE FROM quality.tat_items');
      expect(r.code === undefined ? r.rowCount : 0, JSON.stringify(r)).toBe(0);
    }, false);
    expect((await owner('SELECT count(*)::int AS n FROM quality.tat_items WHERE id = ANY($1::uuid[])', [[past, future]]))[0].n).toBe(2);
    await withClaims(api(), claimsOf(TENANT_A), async (c) => { await c.query('DELETE FROM quality.tat_items'); });
    const left = (await owner('SELECT id FROM quality.tat_items WHERE id = ANY($1::uuid[])', [[past, future]])).map((r) => r.id);
    expect(left).toEqual([future]);
  });
});
