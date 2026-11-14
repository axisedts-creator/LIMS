// C10 T-25 — live-DB security probes (07-SECURITY §5 S-04, S-08, S-20 live half, S-26, S-28, S-29; 05-SCHEMA §4, §10 items 2 and 11).
// Needs the micro DDL + RLS applied (C0 prerequisite, as T-05/T-07/T-17): LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser.
// Without them the file skips, except under LIMS_T25_REQUIRE_DB=1 where "database is provided" fails.
// Generic over the catalog: every base table of schema `micro` that has a tenant_id column is probed (no hand-kept table list that could go stale).
// Seeding: admin tx with session_replication_role=replica (FKs/triggers off) and NOT-NULL columns auto-filled; text CHECK ... IN (...) columns take the first allowed literal.
// ASSUMED: claims are set with set_config('request.jwt.claims', {tenant_id, sub, actor_type, membership_id?, centre_id?}) as in culture.reads.integration.test.ts; centre scope of
// staff = core.memberships.all_centres. Synthetic data only.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkCtx, run, READ, LAB_READ } from '../../handlers/__tests__/helpers/cultureReads.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const REQUIRE = process.env['LIMS_T25_REQUIRE_DB'] === '1';

const A = '01a1a98a-ac40-7000-8000-00000000a025';
const B = '01a1a98a-ac40-7000-8000-00000000b025';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const RUN = Date.now();
let seqN = 0;
const uid = () => `0190c60c-0000-7000-8000-${(RUN % 0xffffffff).toString(16).padStart(8, '0')}${(++seqN).toString(16).padStart(4, '0')}`;
const W = { centreA1: uid(), centreB1: uid(), user: uid(), memA: uid(), memB: uid(), patient: uid(), test: uid(), cultureA: uid(), cultureB: uid(), cultureFinal: uid(), orderA: uid(), orderB: uid() };
const PLANT_BARCODE = 'SYNTHBC25PLANT';

let api: pg.Pool;
let admin: pg.Pool;
const q = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;

type Row = Record<string, any>;
async function checkLiterals(c: pg.PoolClient, schema: string, name: string): Promise<Record<string, string>> {
  const defs = (await c.query(`SELECT pg_get_constraintdef(con.oid) AS d FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE con.contype = 'c' AND n.nspname = $1 AND t.relname = $2`, [schema, name])).rows as { d: string }[];
  const out: Record<string, string> = {};
  for (const { d } of defs) for (const m of d.matchAll(/\(?(\w+)\)?(?:::text)? = ANY \(\(?ARRAY\['([^']+)'/g)) out[m[1]!] = m[2]!;
  return out;
}
/** complete row for `table`: `given` + every NOT NULL column without a default auto-filled (first literal of a text CHECK IN list) */
async function buildRow(c: pg.PoolClient, table: string, given: Row): Promise<Row> {
  const [schema, name] = table.split('.') as [string, string];
  const cols = (await c.query(`SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
    AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER' AND is_identity = 'NO'`, [schema, name])).rows as { column_name: string; udt_name: string }[];
  const lit = await checkLiterals(c, schema, name);
  const row: Row = { ...given };
  for (const { column_name, udt_name } of cols) {
    if (column_name in row) continue;
    row[column_name] = lit[column_name] ?? (udt_name === 'uuid' ? uid() : /^(int|numeric|float)/.test(udt_name) ? 1 : udt_name === 'bool' ? false : /^timestamp/.test(udt_name) ? new Date('2026-11-01T04:00:00Z')
      : udt_name === 'date' ? '2026-11-01' : /^jsonb?$/.test(udt_name) ? '[]' : `syn_${++seqN}`);
  }
  return row;
}
const insertSql = (table: string, row: Row, tail = '') => {
  const keys = Object.keys(row);
  return { text: `INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})${tail}`,
    values: keys.map((k) => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date) ? JSON.stringify(row[k]) : row[k])) };
};
async function seedRow(table: string, given: Row): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL session_replication_role = 'replica'");
    const { text, values } = insertSql(table, await buildRow(c, table, given), ' ON CONFLICT DO NOTHING');
    await c.query(text, values);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

/** run `fn` on lims_api inside a tx carrying these claims; always rolled back */
async function asClaims<T>(claims: Row, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await api.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    return await fn(c);
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}
const userA = (): Row => ({ tenant_id: A, sub: SYS, actor_type: 'user', membership_id: W.memA });
const attempt = async (c: pg.PoolClient, text: string, values: unknown[] = []) => {
  await c.query('SAVEPOINT p');
  try { const r = await c.query(text, values); return { rowCount: r.rowCount ?? 0, rows: r.rows, error: undefined as any }; }
  catch (error: any) { await c.query('ROLLBACK TO SAVEPOINT p'); return { rowCount: 0, rows: [], error }; }
};

let tenantTables: string[] = [];
let centreTables: string[] = [];
const unseeded: string[] = [];

const centreOf = (tenant: string) => (tenant === A ? W.centreA1 : W.centreB1);
const FIXED: Record<string, Row> = {
  'micro.cultures': {}, 'micro.instrument_records': { match_status: 'pending_match', record_kind: 'ast' },
};

/** known columns of a tenant's probe row for `t`: that tenant's centre and culture where the table has them */
async function probeGiven(t: string, tenant: string): Promise<Row> {
  const given: Row = { tenant_id: tenant, ...FIXED[t] };
  if (centreTables.includes(t)) given['centre_id'] = centreOf(tenant);
  const cols = (await q('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', ['micro', t.split('.')[1]])).map((r) => r.column_name);
  if (cols.includes('culture_id')) given['culture_id'] = tenant === A ? W.cultureA : W.cultureB;
  return given;
}

beforeAll(async () => {
  if (!live) { if (REQUIRE) throw new Error('database is provided: set LIMS_TEST_DATABASE_URL (lims_api) and LIMS_TEST_ADMIN_DATABASE_URL (superuser)'); return; }
  api = new pg.Pool({ connectionString: API_URL, max: 4 }); admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await seedRow('core.tenants', { id: t });
  await seedRow('core.collection_centres', { tenant_id: A, id: W.centreA1 });
  await seedRow('core.collection_centres', { tenant_id: B, id: W.centreB1 });
  await seedRow('core.users', { tenant_id: A, id: W.user, display_name: 'Synthetic Tech' });
  await seedRow('core.memberships', { tenant_id: A, id: W.memA, user_id: W.user, actor_type: 'user', status: 'active', is_active: true, all_centres: true });
  await seedRow('core.memberships', { tenant_id: B, id: W.memB, user_id: W.user, actor_type: 'user', status: 'active', is_active: true, all_centres: true });
  await seedRow('frontdesk.patients', { tenant_id: A, id: W.patient });
  await seedRow('frontdesk.patients', { tenant_id: B, id: W.patient });
  await seedRow('catalog.tests', { tenant_id: A, id: W.test });
  await seedRow('catalog.tests', { tenant_id: B, id: W.test });

  tenantTables = (await q(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.table_schema = 'micro' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`)).map((r) => `micro.${r.table_name}`);
  centreTables = (await q(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.table_schema = 'micro' AND c.column_name = 'centre_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`)).map((r) => `micro.${r.table_name}`);

  const cul = (id: string, tenant: string, order: string, status: string, extra: Row = {}) => seedRow('micro.cultures', { id, tenant_id: tenant, centre_id: centreOf(tenant), order_id: order, order_item_id: uid(),
    specimen_id: uid(), patient_id: W.patient, test_id: W.test, specimen_type_code: 'urine', status, received_at: new Date('2026-11-01T04:00:00Z'), last_specimen_seq: 1, created_by: SYS, updated_by: SYS, ...extra });
  await cul(W.cultureA, A, W.orderA, 'awaiting_setup', { barcode_snapshot: PLANT_BARCODE });
  await cul(W.cultureB, B, W.orderB, 'awaiting_setup', { barcode_snapshot: 'SYNTHBC25OTHER' });
  await cul(W.cultureFinal, A, W.orderA, 'final_submitted', { outcome_code: 'syn_positive', current_report_version_no: 1, last_report_phase: 'final' });
  // every other tenant table: one row for A (centre A1) and one for B (centre B1), pointing at that tenant's culture where there is a culture_id
  for (const t of tenantTables) {
    if (t === 'micro.cultures') continue;
    for (const tenant of [A, B]) {
      try { await seedRow(t, await probeGiven(t, tenant)); } catch { unseeded.push(`${t}:${tenant === A ? 'A' : 'B'}`); }
    }
  }
});
afterAll(async () => { await api?.end(); await admin?.end(); });

describe.skipIf(!live && !REQUIRE)('T-25 live DB probes', () => {
  it('discovers the micro tenant tables (05-SCHEMA §1: 30+ owned tenant tables)', () => {
    expect(tenantTables.length).toBeGreaterThanOrEqual(25);
    expect(tenantTables).toContain('micro.cultures');
    expect(tenantTables.some((t) => t.includes('.g_'))).toBe(false);
  });

  it('every tenant table got a tenant-B probe row (else S-26 would be vacuous for it)', () => expect(unseeded).toEqual([]));

  // ---------------------------------------------------------------- S-26
  it('S-26: tenant A claims — SELECT sees 0 B rows, INSERT with B tenant_id fails, UPDATE of B rows affects 0 rows (every table)', async () => {
    const problems: string[] = [];
    for (const t of tenantTables) {
      const adminSeesB = Number((await q(`SELECT count(*) AS n FROM ${t} WHERE tenant_id = $1`, [B]))[0].n);
      // complete tenant-B row, so only the RLS WITH CHECK can reject it (not NOT NULL / CHECK constraints)
      const rowB = await (async () => { const c = await admin.connect(); try { return await buildRow(c, t, await probeGiven(t, B)); } finally { c.release(); } })();
      await asClaims(userA(), async (c) => {
        const sel = await attempt(c, `SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [B]);
        if (sel.error || sel.rows[0].n !== 0) problems.push(`${t}: SELECT of B rows -> ${sel.error?.code ?? sel.rows[0].n}`);
        const own = await attempt(c, `SELECT count(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [A]);
        if (adminSeesB > 0 && !own.error && own.rows[0].n === 0 && !t.endsWith('event_inbox')) problems.push(`${t}: user A cannot see its own rows (positive control)`);
        const upd = await attempt(c, `UPDATE ${t} SET tenant_id = tenant_id WHERE tenant_id = $1`, [B]);
        if (upd.rowCount !== 0) problems.push(`${t}: UPDATE of B rows affected ${upd.rowCount}`);
        const ins = await attempt(c, insertSql(t, rowB).text, insertSql(t, rowB).values);
        // 42501 = RLS WITH CHECK violation; also require the RLS message so a missing INSERT grant (also 42501) cannot pass
        if (ins.error?.code !== '42501' || !/row-level security/i.test(ins.error?.message ?? '')) problems.push(`${t}: INSERT with B tenant_id -> ${ins.error?.code ?? 'succeeded'}`);
      });
    }
    expect(problems).toEqual([]);
  });

  it('S-26: with no claims at all no tenant row is readable', async () => {
    const problems: string[] = [];
    for (const t of tenantTables) {
      const c = await api.connect();
      try {
        const r = await attempt(c, `SELECT count(*)::int AS n FROM ${t}`);
        if (!r.error && r.rows[0].n !== 0) problems.push(`${t}: ${r.rows[0].n} rows without claims`);
      } finally { c.release(); }
    }
    expect(problems).toEqual([]);
  });

  // ---------------------------------------------------------------- S-28
  it.each(['partner', 'portal', 'patient'])('S-28: %s claims of tenant A read 0 rows of every micro tenant table', async (actor) => {
    const problems: string[] = [];
    for (const t of tenantTables) await asClaims({ tenant_id: A, sub: SYS, actor_type: actor }, async (c) => {
      const r = await attempt(c, `SELECT count(*)::int AS n FROM ${t}`);
      if (!r.error && r.rows[0].n !== 0) problems.push(`${t}: ${r.rows[0].n} rows`);
    });
    expect(problems).toEqual([]);
  });

  it('S-28: device claims (centre_id = A1) read 0 rows of every centre-scoped table', async () => {
    const problems: string[] = [];
    for (const t of centreTables) await asClaims({ tenant_id: A, sub: SYS, actor_type: 'device', centre_id: W.centreA1 }, async (c) => {
      const r = await attempt(c, `SELECT count(*)::int AS n FROM ${t}`);
      if (!r.error && r.rows[0].n !== 0) problems.push(`${t}: ${r.rows[0].n} rows`);
    });
    expect(problems).toEqual([]);
  });

  // ---------------------------------------------------------------- S-04 / REQ-SEC-026
  it('S-04: every foreign key from a micro tenant table into a tenant-scoped parent is composite and includes tenant_id', async () => {
    const fks = await q(`SELECT con.conname, t.relname AS child, p.relname AS parent, pn.nspname AS pschema, con.conkey, con.confkey, con.conrelid, con.confrelid
      FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class p ON p.oid = con.confrelid JOIN pg_namespace pn ON pn.oid = p.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'micro'`);
    expect(fks.length).toBeGreaterThan(20);
    const bad: string[] = [];
    for (const f of fks) {
      const parentHasTenant = (await q(`SELECT 1 FROM pg_attribute WHERE attrelid = $1 AND attname = 'tenant_id' AND NOT attisdropped`, [f.confrelid])).length > 0;
      if (!parentHasTenant) continue;
      const names = async (rel: string, keys: number[]) => (await q(`SELECT attname FROM pg_attribute WHERE attrelid = $1 AND attnum = ANY($2)`, [rel, keys])).map((r) => r.attname);
      const [childCols, parentCols] = [await names(f.conrelid, f.conkey), await names(f.confrelid, f.confkey)];
      if (!childCols.includes('tenant_id') || !parentCols.includes('tenant_id')) bad.push(`${f.child}.${f.conname} -> ${f.pschema}.${f.parent}`);
    }
    expect(bad).toEqual([]);
  });

  it('S-04: a child row of tenant A referencing a parent culture of tenant B is rejected by the database (23503)', async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SAVEPOINT s');
      const given: Row = { id: uid(), tenant_id: A, centre_id: W.centreA1, culture_id: W.cultureB, plate_no: 7, media_code: 'syn_blood', planted_at: new Date('2026-11-06T04:00:00Z'),
        status: 'active', created_by: SYS, updated_by: SYS };
      const keys = Object.keys(given);
      const err = await c.query(`INSERT INTO micro.culture_plates (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => given[k])).then(() => undefined, (e) => e);
      expect(err?.code, 'composite FK (tenant_id, culture_id) must reject the foreign parent').toBe('23503');
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });

  // ---------------------------------------------------------------- S-08
  it('S-08: lims_app has no UPDATE on append-only tables and no DELETE anywhere in micro except instrument_records', async () => {
    const all = (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'micro' AND table_type = 'BASE TABLE'`)).map((r) => r.table_name as string);
    const priv = async (t: string, p: string) => (await q('SELECT has_table_privilege($1, $2, $3) AS ok', ['lims_app', `micro.${t}`, p]))[0].ok as boolean;
    const bad: string[] = [];
    for (const t of all) if (t !== 'instrument_records' && await priv(t, 'DELETE')) bad.push(`DELETE on ${t}`);
    for (const t of ['report_versions', 'culture_transitions', 'culture_observations', 'breakpoint_rows', 'breakpoint_bands', 'breakpoint_import_issues', 'event_inbox'])
      if (all.includes(t) && await priv(t, 'UPDATE')) bad.push(`UPDATE on ${t}`);
    for (const t of all.filter((x) => x.startsWith('g_'))) for (const p of ['INSERT', 'UPDATE', 'DELETE']) if (await priv(t, p)) bad.push(`${p} on ${t} (global G table)`);
    expect(all).toContain('instrument_records');
    expect(await priv('instrument_records', 'DELETE')).toBe(true);
    expect(bad).toEqual([]);
  });

  it('S-08: instrument_records DELETE affects 0 rows under user claims and only expired rows under system claims', async () => {
    const mk = (expires: Date) => ({ id: uid(), expires });
    const past = mk(new Date('2020-01-01T00:00:00Z')), future = mk(new Date('2099-01-01T00:00:00Z'));
    for (const r of [past, future]) await seedRow('micro.instrument_records', { id: r.id, tenant_id: A, centre_id: W.centreA1, culture_id: W.cultureA, match_status: 'ignored', record_kind: 'ast',
      received_at: new Date('2026-11-05T04:00:00Z'), expires_at: r.expires });
    await asClaims(userA(), async (c) => {
      const r = await attempt(c, 'DELETE FROM micro.instrument_records WHERE id = ANY($1)', [[past.id, future.id]]);
      expect(r.rowCount, 'user actor: 0 rows').toBe(0);
    });
    await asClaims({ tenant_id: A, sub: SYS, actor_type: 'system' }, async (c) => {
      const r = await attempt(c, 'DELETE FROM micro.instrument_records WHERE id = ANY($1) RETURNING id', [[past.id, future.id]]);
      expect(r.error).toBeUndefined();
      expect(r.rows.map((x: Row) => x.id), 'system actor: only the expired row').toEqual([past.id]);
    });
  });

  // ---------------------------------------------------------------- S-29
  it('S-29: on a final_submitted culture direct SQL INSERT/UPDATE of isolates, ast_results, culture_plates and INSERT of culture_observations fail with P0001', async () => {
    const c = await admin.connect();
    const base = { tenant_id: A, centre_id: W.centreA1, culture_id: W.cultureFinal };
    const fail = async (table: string, text: string, values: unknown[]) => {
      await c.query('SAVEPOINT x');
      const err = await c.query(text, values).then(() => undefined, (e) => e);
      await c.query('ROLLBACK TO SAVEPOINT x');
      expect(err?.code, `${table}: ${text.slice(0, 40)}`).toBe('P0001');
    };
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL session_replication_role = 'replica'");
      const plate = uid(), iso = uid();
      await c.query(`INSERT INTO micro.culture_plates (id, tenant_id, centre_id, culture_id, plate_no, media_code, planted_at, status, created_by, updated_by) VALUES ($1,$2,$3,$4,1,'syn_blood',now(),'active',$5,$5)`, [plate, A, W.centreA1, W.cultureFinal, SYS]);
      await c.query(`INSERT INTO micro.isolates (id, tenant_id, centre_id, culture_id, specimen_id, isolate_seq, plate_id, status, organism_code, organism_source, identified_at, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,1,$6,'identified','syn_org','manual',now(),$7,$7)`, [iso, A, W.centreA1, W.cultureFinal, uid(), plate, SYS]);
      await c.query(`INSERT INTO micro.ast_results (id, tenant_id, centre_id, culture_id, isolate_id, antibiotic_code, method, raw_value, source, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,'syn_abx','mic','<=0.25','manual',$6,$6)`, [uid(), A, W.centreA1, W.cultureFinal, iso, SYS]);
      await c.query("SET LOCAL session_replication_role = 'origin'");   // triggers on again: the final lock (micro.tg_child_final_lock) must fire
      await fail('isolates', 'UPDATE micro.isolates SET updated_by = updated_by WHERE culture_id = $1', [W.cultureFinal]);
      await fail('ast_results', 'UPDATE micro.ast_results SET updated_by = updated_by WHERE culture_id = $1', [W.cultureFinal]);
      await fail('culture_plates', 'UPDATE micro.culture_plates SET updated_by = updated_by WHERE culture_id = $1', [W.cultureFinal]);
      await fail('culture_plates', `INSERT INTO micro.culture_plates (id, tenant_id, centre_id, culture_id, plate_no, media_code, planted_at, status, created_by, updated_by) VALUES ($1,$2,$3,$4,2,'syn_blood',now(),'active',$5,$5)`, [uid(), A, W.centreA1, W.cultureFinal, SYS]);
      await fail('isolates', `INSERT INTO micro.isolates (id, tenant_id, centre_id, culture_id, specimen_id, isolate_seq, plate_id, status, organism_code, organism_source, identified_at, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5,2,$6,'identified','syn_org','manual',now(),$7,$7)`, [uid(), A, W.centreA1, W.cultureFinal, uid(), plate, SYS]);
      await fail('ast_results', `INSERT INTO micro.ast_results (id, tenant_id, centre_id, culture_id, isolate_id, antibiotic_code, method, raw_value, source, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,'syn_abx2','mic','1','manual',$6,$6)`, [uid(), A, W.centreA1, W.cultureFinal, iso, SYS]);
      await fail('culture_observations', `INSERT INTO micro.culture_observations (id, tenant_id, centre_id, culture_id, plate_id, kind, growth_code, observed_at, recorded_by_membership_id, created_by) VALUES ($1,$2,$3,$4,$5,'plate_read','syn_growth',now(),$6,$7)`, [uid(), A, W.centreA1, W.cultureFinal, plate, W.memA, SYS]);
      void base;
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });

  // ---------------------------------------------------------------- S-17
  it('S-17: assignMicroInstrumentRecord to a REAL culture of tenant B, or with a tenant-B record id, is 404 common.not_found and changes nothing', async () => {
    const rec = uid(), recB = uid();
    await seedRow('micro.instrument_records', { id: rec, tenant_id: A, centre_id: W.centreA1, culture_id: null, match_status: 'pending_match', record_kind: 'ast', received_at: new Date('2026-11-05T04:00:00Z') });
    await seedRow('micro.instrument_records', { id: recB, tenant_id: B, centre_id: W.centreB1, culture_id: null, match_status: 'pending_match', record_kind: 'ast', received_at: new Date('2026-11-05T04:00:00Z') });
    const version = async (id: string) => (await q('SELECT version FROM micro.instrument_records WHERE id = $1', [id]))[0]?.version ?? 1;
    const attemptAssign = async (recordId: string, cultureId: string) => {
      const c = await api.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(userA())]);
        const { ctx } = mkCtx({ tenantId: A, tx: c, grants: ['micro.culture.work', READ], actor: { type: 'user', id: SYS, membershipId: W.memA }, centreScope: { all: true, centreIds: [] } });
        const err = await run('assignMicroInstrumentRecord', { params: { record_id: recordId }, headers: { 'idempotency-key': `syn-s17-${recordId.slice(-4)}${seqN}`, 'if-match': `"${await version(recordId)}"` }, body: { culture_id: cultureId } }, ctx).then(() => undefined, (e: any) => e);
        await c.query('ROLLBACK');
        return err;
      } finally { c.release(); }
    };
    expect((await attemptAssign(rec, W.cultureB))?.code, 'foreign culture').toBe('common.not_found');
    expect((await attemptAssign(recB, W.cultureA))?.code, 'foreign record').toBe('common.not_found');
    const after = await q('SELECT id, match_status, culture_id FROM micro.instrument_records WHERE id = ANY($1)', [[rec, recB]]);
    for (const r of after) { expect(r.match_status).toBe('pending_match'); expect(r.culture_id).toBeNull(); }
  });

  // ---------------------------------------------------------------- S-20 (live half)
  it('S-20: reading and failing on a culture with a planted barcode logs / meters / errors nothing containing it', async () => {
    const captured: unknown[] = [];
    const sink = (...a: unknown[]) => { captured.push(a); };
    const c = await api.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(userA())]);
      const { ctx } = mkCtx({ tenantId: A, tx: c, grants: [READ, LAB_READ], centreScope: { all: true, centreIds: [] }, tests: { [W.test]: { code: 'SYN', name: 'Synthetic Urine Culture' } } });
      ctx.log = { info: sink, warn: sink, error: sink, debug: sink, child() { return this; } }; ctx.metrics = { inc: sink, observe: sink };
      const bodies: unknown[] = [];
      for (const [op, req] of [['getCulture', { params: { culture_id: W.cultureA } }], ['listCultures', { query: { order_id: W.orderA } }], ['getCulture', { params: { culture_id: W.cultureB } }]] as const) {
        const r = await run(op, req, ctx).then((x) => x.body, (e: any) => ({ code: e.code, message: e.message, detail: e.detail, errors: e.errors }));
        bodies.push(r);
      }
      expect(JSON.stringify(captured)).not.toContain(PLANT_BARCODE);
      expect(JSON.stringify(captured)).not.toContain('SYNTHBC25OTHER');
      expect(JSON.stringify(bodies[2]), 'B culture is just not_found, no data of B').not.toContain('SYNTHBC25OTHER');
      expect((bodies[2] as Row).code, 'tenant B id -> 404 identical to missing').toBe('common.not_found');
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });
});
