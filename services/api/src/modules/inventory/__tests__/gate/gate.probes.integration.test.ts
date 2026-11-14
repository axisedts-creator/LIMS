// C12.T-26 chunk gate, part 2: cross-tenant probes P-T1 .. P-T5 for EVERY operation (AC-22.1, AC-22.3) and the integrity grants IT-1 (07-SECURITY §6.1, §6.4).
// Real migrated database as role lims_api with RLS on (harness tests/db/c12-t26/run.sh). Tenant-B rows are seeded with the superuser (gate.helpers.ts seedTenantB). Each probe = one request-shaped
// transaction that is ROLLED BACK; tenant B is snapshotted THROUGH RLS (claims of B) inside the same transaction, so an uncommitted write into B is seen.
// Without the URLs the DB tests skip, except under LIMS_C12T03_REQUIRE_DB=1 (run.sh) where the "database is provided" test fails.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN_URL, API_URL, A, B, B_IDS, applyFixtures, LimsError, OPERATIONS, buildRequest, claims, live, put, seedTenantB, snapshotB, tableOfField, tenantTables, withSession, type Operation,
} from './gate.helpers.js';

let api: pg.Pool;
let admin: pg.Pool;
let tables: string[] = [];
let seedFailures: string[] = [];
const aIds = new Map<string, string>(); // first tenant-A row id per table (bulk mixing, P-T4)

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 6 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await applyFixtures(admin);
  seedFailures = await seedTenantB(admin);
  tables = await tenantTables(admin);
  for (const t of ['inventory.stores', 'inventory.items', 'inventory.lots', 'inventory.suppliers', 'inventory.item_packs', 'inventory.transfers', 'instruments.instruments', 'catalog.tests', 'core.branches']) {
    const r = await admin.query(`SELECT id FROM ${t} WHERE tenant_id = $1 ORDER BY id LIMIT 1`, [A]);
    if (r.rows[0]) aIds.set(t, r.rows[0].id);
  }
}, 240_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-26 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => { if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true); });
  it.skipIf(!live)('every id-bearing table has a tenant-B row, so a probe proves RLS and not just "id unknown" (seed failures are listed)', () => { expect(seedFailures).toEqual([]); });
  it.skipIf(!live)('P-T5 prerequisite: the 32 tenant tables + event_inbox are found', () => { expect(tables.length).toBeGreaterThanOrEqual(33); expect(tables).toContain('event_inbox'); });
});

const allB = () => [...B_IDS.values(), B, 'T26-B-BARCODE-0001'];
const leaks = (body: unknown) => { const s = JSON.stringify(body ?? null); return allB().filter((id) => s.includes(id)); };
const named = (o: Operation) => `#${o.n} ${o.op}`;

// ============================================================================================================================ P-T1 / P-T3 (AC-22.1): tenant B ids on every operation
describe.skipIf(!live)('P-T1 / P-T3 AC-22.1: a tenant-A user using tenant-B ids gets 404 common.not_found, no B data, no change in B (every one of the 93 operations)', () => {
  for (const o of OPERATIONS) {
    it(named(o), () => withSession(api, async (s) => {
      const { req, bIds } = buildRequest(o, 'B', aIds);
      const before = await snapshotB(s, tables);
      let body: unknown; let err: unknown;
      try { body = (await s.go(o.op, req)).body; } catch (e) { err = e; }
      if (bIds > 0) {
        expect(err, `${named(o)} must reject tenant-B ids (request ${JSON.stringify(req)})`).toBeInstanceOf(LimsError);
        expect({ code: (err as LimsError).code, status: (err as LimsError).statusCode }, `${named(o)}: ${(err as Error).message} ${JSON.stringify((err as LimsError).detail ?? null)} request ${JSON.stringify(req)}`).toEqual({ code: 'common.not_found', status: 404 });
        expect(leaks((err as LimsError).detail)).toEqual([]);
      } else {
        // no id-bearing input (list / create-without-refs / settings): the call may succeed, but it must not carry or touch tenant B
        if (err) expect(err, `${named(o)} threw ${(err as Error).stack}`).toBeInstanceOf(LimsError);
        expect(leaks(body)).toEqual([]);
      }
      expect(await snapshotB(s, tables), `${named(o)} changed tenant B`).toBe(before);
    }));
  }
});

// ============================================================================================================================ P-T2: lists with B data present
describe.skipIf(!live)('P-T2 list endpoints with B data present return zero B rows', () => {
  for (const o of OPERATIONS.filter((x) => x.method === 'GET' && !x.params.some((p) => p.in === 'path') && !/export|report|lookup|fefo/i.test(x.op))) {
    it(named(o), () => withSession(api, async (s) => {
      const { req } = buildRequest({ ...o, params: o.params.filter((p) => !(p.in === 'query' && !p.required && tableOfField(String(p.name)))) }, 'A', aIds); // no optional filter id: the whole visible list
      const r = await s.go(o.op, req);
      expect(r.status).toBe(200);
      expect(leaks(r.body)).toEqual([]);
    }));
  }
});

// ============================================================================================================================ P-T4 (AC-22.3): bulk inputs mixing A and B ids
describe.skipIf(!live)('P-T4 AC-22.3 bulk inputs mixing A and B ids: B ids give common.not_found and NOTHING of the A ids is applied (documents are atomic)', () => {
  const bulk = OPERATIONS.filter((o) => o.body && mixable(buildRequest(o, 'B', aIds).req.body).length > 0);
  function mixable(body: unknown): { arr: any[]; at: string }[] {
    const out: { arr: any[]; at: string }[] = [];
    const walk = (v: unknown, at: string) => {
      if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && Object.keys(v[0]).some((k) => tableOfField(k))) out.push({ arr: v, at });
      else if (Array.isArray(v) && v.length && typeof v[0] === 'string') out.push({ arr: v, at });
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    };
    walk(body, '$');
    return out;
  }
  it('there are bulk operations to probe (lines[] / lot_ids[] / item_ids[] bodies)', () => expect(bulk.length).toBeGreaterThanOrEqual(8));
  for (const o of bulk) {
    it(named(o), () => withSession(api, async (s) => {
      const b = buildRequest(o, 'B', aIds); const a = buildRequest(o, 'A', aIds);
      // [A element, B element] in every id-bearing array of the body
      const mix = (bv: any, av: any): any => Array.isArray(bv) ? (bv.length && av?.length ? [av[0], bv[0]] : bv) : (bv && typeof bv === 'object' ? Object.fromEntries(Object.entries(bv).map(([k, x]) => [k, mix(x, av?.[k])])) : bv);
      const body = mix(b.req.body, a.req.body);
      const counts = async () => JSON.stringify(await s.sql(A, `SELECT (SELECT count(*) FROM inventory.stock_movements WHERE tenant_id = $1) AS m, (SELECT count(*) FROM inventory.stock_documents WHERE tenant_id = $1) AS d,
        (SELECT count(*) FROM inventory.goods_receipts WHERE tenant_id = $1) AS g, (SELECT count(*) FROM inventory.purchase_orders WHERE tenant_id = $1) AS p, (SELECT count(*) FROM inventory.transfers WHERE tenant_id = $1) AS t,
        (SELECT coalesce(sum(qty_base), 0) FROM inventory.stock_balances WHERE tenant_id = $1) AS q`, [A]));
      const beforeA = await counts(); const beforeB = await snapshotB(s, tables);
      const err = await s.go(o.op, { ...b.req, body }).then(() => undefined, (e) => e as LimsError);
      expect(err, `${named(o)} must reject a body that contains a tenant-B id`).toBeInstanceOf(LimsError);
      expect({ code: err!.code, status: err!.statusCode }, `${named(o)}: ${err!.message} ${JSON.stringify(err!.detail ?? null)} body ${JSON.stringify(body)}`).toEqual({ code: 'common.not_found', status: 404 });
      expect(await counts(), `${named(o)} applied part of the A lines`).toBe(beforeA);
      expect(await snapshotB(s, tables)).toBe(beforeB);
    }));
  }
});

// ============================================================================================================================ P-T5: SQL probes per table
describe.skipIf(!live)('P-T5 SQL probes on every tenant table as lims_api with the claims of tenant A', () => {
  const attempt = async (c: pg.PoolClient, sql: string, v: unknown[] = []) => {
    await c.query('SAVEPOINT p'); try { const r = await c.query(sql, v); await c.query('RELEASE SAVEPOINT p'); return { ok: true as const, rows: r.rows, count: r.rowCount ?? 0 }; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT p'); return { ok: false as const, code: (e as { code?: string }).code ?? '', message: (e as Error).message }; }
  };
  it('SELECT sees 0 tenant-B rows and exactly the tenant-A rows; INSERT of a B row is refused; UPDATE / DELETE of B rows affect 0 rows (RLS-denied or no privilege) - for all tables', async () => {
    const failures: string[] = [];
    await withSession(api, async (s) => {
      const c = s.client;
      for (const t of tables) {
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]);
        const bRows = (await admin.query(`SELECT to_jsonb(x) AS j FROM inventory.${t} x WHERE tenant_id = $1 LIMIT 1`, [B])).rows[0]?.j;
        const aTotal = Number((await admin.query(`SELECT count(*) AS n FROM inventory.${t} WHERE tenant_id = $1`, [A])).rows[0].n);
        const all = await attempt(c, `SELECT count(*)::int AS n, count(*) FILTER (WHERE tenant_id = $1)::int AS b FROM inventory.${t}`, [B]);
        if (!all.ok) { failures.push(`${t}: SELECT failed ${all.message}`); continue; }
        if (all.rows[0].b !== 0) failures.push(`${t}: SELECT sees ${all.rows[0].b} tenant-B rows`);
        if (all.rows[0].n !== aTotal) failures.push(`${t}: SELECT sees ${all.rows[0].n} rows, tenant A owns ${aTotal}`);
        if (bRows) {
          const ins = await attempt(c, `INSERT INTO inventory.${t} SELECT * FROM jsonb_populate_record(NULL::inventory.${t}, $1::jsonb)`, [JSON.stringify(bRows)]);
          if (ins.ok) failures.push(`${t}: INSERT of a tenant-B row succeeded`);
        }
        const upd = await attempt(c, `UPDATE inventory.${t} SET tenant_id = tenant_id WHERE tenant_id = $1`, [B]);
        if (upd.ok && upd.count !== 0) failures.push(`${t}: UPDATE changed ${upd.count} tenant-B rows`);
        const del = await attempt(c, `DELETE FROM inventory.${t} WHERE tenant_id = $1`, [B]);
        if (del.ok && del.count !== 0) failures.push(`${t}: DELETE removed ${del.count} tenant-B rows`);
      }
    });
    expect(failures).toEqual([]);
  });
  it('partner, portal and patient claims of tenant A read 0 rows of every table (P-16 generated probe; claim shape { tenant_id, sub, actor_type })', async () => {
    const failures: string[] = [];
    await withSession(api, async (s) => {
      for (const actor of ['partner', 'portal', 'patient']) {
        await s.client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A, actor)]);
        for (const t of tables) {
          await s.client.query('SAVEPOINT q');
          try { const n = Number((await s.client.query(`SELECT count(*) AS n FROM inventory.${t}`)).rows[0].n); if (n !== 0) failures.push(`${actor}: ${t} shows ${n} rows`); await s.client.query('RELEASE SAVEPOINT q'); }
          catch { await s.client.query('ROLLBACK TO SAVEPOINT q'); /* no privilege = 0 rows read */ }
        }
      }
    });
    expect(failures).toEqual([]);
  });
  it('alerts: a user actor\'s DELETE and app.purge_inventory_alerts() delete 0 rows; the system actor deletes only A\'s rows with expires_at < now()', async () => {
    await withSession(api, async (s) => {
      const seed = await admin.connect();
      try {
        await seed.query('BEGIN'); await seed.query('SET LOCAL session_replication_role = replica');
        const past = new Date(Date.now() - 86_400_000).toISOString();
        for (const t of [A, B]) expect(await put(seed, 'inventory.alerts', [{ id: randomUUID(), tenant_id: t, dedupe_key: `t26-exp-${t}`, status: 'resolved', first_raised_at: past, last_raised_at: past, expires_at: past, resolved_at: past }])).toBeNull();
        await seed.query('COMMIT');
      } finally { seed.release(); }
      const user = await s.client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A, 'user')]).then(() => s.client.query(`DELETE FROM inventory.alerts WHERE tenant_id = $1`, [A]).then((r) => r.rowCount, () => 0));
      expect(user).toBe(0);
      await s.client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A, 'user')]);
      await s.client.query('SAVEPOINT pg'); const viaFn = await s.client.query('SELECT app.purge_inventory_alerts() AS n').then((r) => Number(r.rows[0].n ?? 0), () => 0); await s.client.query('ROLLBACK TO SAVEPOINT pg');
      expect(viaFn).toBe(0);
      await s.client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A, 'system')]);
      const sys = await s.client.query(`DELETE FROM inventory.alerts WHERE expires_at < now()`);
      expect(sys.rowCount).toBeGreaterThanOrEqual(1);
      expect((await admin.query(`SELECT count(*)::int AS n FROM inventory.alerts WHERE tenant_id = $1 AND dedupe_key = 't26-exp-' || $1`, [B])).rows[0].n).toBe(1); // B's expired alert survives
    });
  });
});

// ============================================================================================================================ IT-1: privileges
describe.skipIf(!live)('IT-1 has_table_privilege(lims_api): ledger tables are append-only; DELETE is false on every inventory table except alerts', () => {
  const priv = async (t: string, p: string) => (await admin.query('SELECT has_table_privilege($1, $2, $3) AS ok', ['lims_api', `inventory.${t}`, p])).rows[0].ok as boolean;
  for (const t of ['stock_movements', 'stock_documents', 'stock_document_lines']) it(`${t}: no UPDATE, no DELETE`, async () => { expect(await priv(t, 'UPDATE')).toBe(false); expect(await priv(t, 'DELETE')).toBe(false); });
  it('DELETE = false on every inventory table (incl. purchase_order_lines, goods_receipt_lines, transfer_lines - D-71) except alerts, where it is true', async () => {
    const all = (await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'inventory' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.table_name as string);
    const deletable: string[] = [];
    for (const t of all) if (await priv(t, 'DELETE')) deletable.push(t);
    expect(deletable).toEqual(['alerts']);
    for (const t of ['purchase_order_lines', 'goods_receipt_lines', 'transfer_lines']) expect(all).toContain(t);
  });
});
