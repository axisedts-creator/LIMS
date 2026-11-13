// C12.T-08 integration + probes for #11-#25 on the migrated database as role lims_api with RLS on (REAL T-03 repositories, handlers/index.ts, T-04 scope service).
// Harness: tests/db/c12-t08/run.sh (clone of c12-t07: pinned image, migrations, seeds, inventory DDL, exports LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL / LIMS_C12T03_REQUIRE_DB=1).
// Fixtures: tests/db/c12-t03/fixtures.sql (see its header: stores 1001 MAIN-A default / 1002 BENCH-A / 1003 OLD-A inactive, tenant B 1101 1102; suppliers 3001-3003, B 3101; supplier item 3201
//   (3001 x 2001 x 2201, price 50000); store item settings 3401 (1001,2001 reorder 100 / qty 400) 3402 (1001,2002 none) 3403 (1002,2001 inactive), B 3501; bindings 9401 (inst 421 -> 1001) 9402 (422 -> 1002 INACTIVE),
//   B 9411; balances 5001 (1001, qty 100) 5002 (1001, qty 0) 5004 (1002, qty 20); instruments 421 422, B 431) + EXTRAS below, committed once with the superuser (ids 12xxx, ON CONFLICT DO NOTHING).
// Each test = one request-shaped transaction that is ROLLED BACK; every handler call runs inside a SAVEPOINT. The few race tests commit and clean up through the admin pool.
// Without the URLs the DB tests skip, except under LIMS_C12T03_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  A, B, BINDING_KEYS, BR1, BR2, BR_B, COST, LEAK, MANAGE, READ, SETTING_KEYS, STORE_KEYS, SUPPLIER_ITEM_KEYS, SUPPLIER_KEYS, SUPPLIER_SUMMARY_KEYS, SYS, TARGET_KEYS, TASK,
  call, expectLims, ifm, makeCtx, newStore, newSupplier, onlyKeys, putSetting, putSupplierItemBody, rej, uid, type Opts,
} from './masters.helpers.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

// fixtures
const MAIN = uid(1001), BENCH = uid(1002), OLD = uid(1003), MAIN_B = uid(1101), BENCH_B = uid(1102);
const GLU = uid(2001), CTRL = uid(2002), TIPS = uid(2003), GLU_B = uid(2101), BOX = uid(2201), KIT = uid(2202), BOX_B = uid(2301);
const SUP1 = uid(3001), SUP2 = uid(3002), SUP3 = uid(3003), SUP_B = uid(3101), SI = uid(3201), SET_1 = uid(3401), SET_2 = uid(3402), SET_B = uid(3501);
const IN1 = uid(421), IN2 = uid(422), IN_B = uid(431), BIND1 = uid(9401), BIND2 = uid(9402), BIND_B = uid(9411);
// extras (this file)
const ST_BR2 = uid(12001), ST_BR2B = uid(12002), ST_NEG = uid(12003), ST_ZERO = uid(12004), ST_BOUND = uid(12005), IN3 = uid(423), BR_INACTIVE = '01a1a98a-ac40-7000-8000-00000000a103';
const BR1_ONLY: Opts = { all: false, branchIds: [BR1] };

const EXTRAS = `
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT set_config('request.jwt.claims', '{"tenant_id":"${A}","sub":"${SYS}","actor_type":"system"}', true);
INSERT INTO core.branches (id, tenant_id, branch_code, name, is_active, created_by, updated_by) VALUES ('${BR_INACTIVE}', '${A}', 'A-B3', 'Alpha Closed Branch (SYNTHETIC)', false, '${SYS}', '${SYS}') ON CONFLICT DO NOTHING;
INSERT INTO inventory.stores (id, tenant_id, branch_id, store_code, name, store_kind, is_default_consumption, is_active, created_by, updated_by) VALUES
  ('${ST_BR2}', '${A}', '${BR2}', 'BR2-MAIN', 'Store BR2-MAIN', 'main', true, true, '${SYS}', '${SYS}'),
  ('${ST_BR2B}', '${A}', '${BR2}', 'BR2-BENCH', 'Store BR2-BENCH', 'bench', false, true, '${SYS}', '${SYS}'),
  ('${ST_NEG}', '${A}', '${BR1}', 'NEG-A', 'Store NEG-A', 'other', false, true, '${SYS}', '${SYS}'),
  ('${ST_ZERO}', '${A}', '${BR1}', 'ZERO-A', 'Store ZERO-A', 'other', false, true, '${SYS}', '${SYS}'),
  ('${ST_BOUND}', '${A}', '${BR1}', 'BOUND-A', 'Store BOUND-A', 'other', false, true, '${SYS}', '${SYS}') ON CONFLICT DO NOTHING;
INSERT INTO inventory.stock_balances (id, tenant_id, store_id, item_id, lot_id, qty_base, value_paisa, last_movement_at, created_by, updated_by) VALUES
  ('${uid(12101)}', '${A}', '${ST_NEG}', '${TIPS}', NULL, -3, 0, now(), '${SYS}', '${SYS}'),
  ('${uid(12102)}', '${A}', '${ST_ZERO}', '${GLU}', '${uid(4002)}', 0, 0, now(), '${SYS}', '${SYS}') ON CONFLICT DO NOTHING;
INSERT INTO instruments.instruments (id, tenant_id, centre_id, agent_id, instrument_code, display_name, vendor, model, protocol, driver_code, transport, timezone, state, created_by, updated_by) VALUES
  ('${IN3}', '${A}', '01a1a98a-ac40-7000-8000-00000000a201', '${uid(1423)}', 'IN-A3', 'Instrument IN-A3', 'Synthetic', 'SX-1', 'astm', 'astm_generic_e1394', '{"kind":"tcp_client"}', 'Asia/Kathmandu', 'draft', '${SYS}', '${SYS}') ON CONFLICT DO NOTHING;
INSERT INTO core.g_task_registry (identifier, module, kind, scope, max_attempts) VALUES ('${TASK}', 'inventory', 'task', 'per_tenant', 10) ON CONFLICT DO NOTHING;
COMMIT;`;

let api: pg.Pool;
let admin: pg.Pool;
beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 6 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c12-t03/fixtures.sql', import.meta.url)), 'utf8'));
  await admin.query(EXTRAS);
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-08 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

interface Job { task: string; payload: any; key: string }
interface Sess {
  call(t: string, op: string, req?: Parameters<typeof call>[2], o?: Opts): Promise<{ status: number; body: any }>;
  sql(t: string, text: string, v?: unknown[]): Promise<any[]>;
  jobs: Job[];
  roleCalls: any[];
  logs: unknown[];
}
const claims = (t: string) => JSON.stringify({ tenant_id: t, sub: SYS, actor_type: 'system' });
async function session<T>(fn: (s: Sess) => Promise<T>): Promise<T> {
  const client = await api.connect();
  let n = 0;
  const jobs: Job[] = [];
  const roleCalls: any[] = [];
  const logs: unknown[] = [];
  const tx = { query: (t: string, v?: unknown[]) => {
    if (/enqueue_job/i.test(t)) jobs.push({ task: String(v?.[0]), payload: JSON.parse(String(v?.[1] ?? '{}')), key: String(v?.[2]) });
    return client.query(t, v);
  } };
  const s: Sess = {
    jobs, roleCalls, logs,
    async sql(t, text, v) { await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]); return (await client.query(text, v)).rows; },
    async call(t, op, req, o) {
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]);
      const st = makeCtx(tx, t, o ?? {});
      const sp = `t08_h${++n}`;
      await client.query(`SAVEPOINT ${sp}`);
      try { const r = await call(op, st.ctx, req); roleCalls.push(...st.roleCalls); logs.push(...st.logs); await client.query(`RELEASE SAVEPOINT ${sp}`); return r; }
      catch (e) { roleCalls.push(...st.roleCalls); logs.push(...st.logs); await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
    },
  };
  try { await client.query('BEGIN'); return await fn(s); } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}
const run = (name: string, fn: (s: Sess) => Promise<void>) => it(name, () => session(fn));

const row = async (s: Sess, table: string, id: string, t = A) => (await s.sql(t, `SELECT * FROM inventory.${table} WHERE id = $1`, [id]))[0];
const defaults = async (s: Sess, branch: string) => (await s.sql(A, 'SELECT id FROM inventory.stores WHERE branch_id = $1 AND is_default_consumption AND is_active ORDER BY id', [branch])).map((r) => r.id);
const mkStore = async (s: Sess, over: Record<string, unknown> = {}, o?: Opts) => (await s.call(A, 'createInventoryStore', { body: newStore(over) }, o)).body;
const getStore = async (s: Sess, id: string, o?: Opts) => (await s.call(A, 'getInventoryStore', { params: { store_id: id } }, o)).body;
const ids = (r: { body: { data: any[] } }) => r.body.data.map((x) => x.id);
const nf = (p: Promise<unknown>) => expectLims(p, 'common.not_found', 404);
const noJobs = (s: Sess) => expect(s.jobs.filter((j) => j.task === TASK)).toEqual([]);
const oneJob = (s: Sess, key: string) => {
  const j = s.jobs.filter((x) => x.task === TASK);
  expect(j.map((x) => x.key)).toEqual([key]);
  expect(j[0]!.payload.tenant_id).toBe(A);
};

// ======================================================================================================== #12 / #13 stores
describe.skipIf(!live)('T-08 #12/#13 create + read a store (AC-03.1)', () => {
  run('AC-03.1 create BR1-MAIN as default consumption: 201 Store, contract keys only, branch_name from core, active, version 1; it becomes the ONLY default of BR-1 (the fixture default is cleared)', async (s) => {
    expect(await defaults(s, BR1)).toEqual([MAIN]);
    const r = await s.call(A, 'createInventoryStore', { body: newStore({ store_code: 'BR1-MAIN', name: 'Main store', store_kind: 'main', is_default_consumption: true }) });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ branch_id: BR1, branch_name: 'Alpha Main Branch (SYNTHETIC)', store_code: 'BR1-MAIN', name: 'Main store', store_kind: 'main', is_default_consumption: true, is_active: true, version: 1 });
    expect(onlyKeys(r.body, STORE_KEYS)).toEqual([]);
    expect(Object.keys(r.body).filter((k) => LEAK.test(k))).toEqual([]);
    expect(await defaults(s, BR1)).toEqual([r.body.id]);
    expect((await row(s, 'stores', MAIN)).is_default_consumption).toBe(false);
    expect((await row(s, 'stores', r.body.id))).toMatchObject({ tenant_id: A, created_by: SYS, updated_by: SYS });
    expect(await getStore(s, r.body.id)).toEqual(r.body);
  });
  run('create without is_default_consumption: false, and the existing default of the branch is untouched', async (s) => {
    const st = await mkStore(s, { store_code: 'PLAIN-1' });
    expect(st.is_default_consumption).toBe(false);
    expect(await defaults(s, BR1)).toEqual([MAIN]);
  });
  run('the single-default rule is per branch: a new default in BR-2 moves only BR-2\'s flag', async (s) => {
    expect(await defaults(s, BR2)).toEqual([ST_BR2]);
    const st = await mkStore(s, { branch_id: BR2, store_code: 'BR2-NEW', is_default_consumption: true });
    expect(await defaults(s, BR2)).toEqual([st.id]);
    expect(await defaults(s, BR1)).toEqual([MAIN]);
  });
  run('unknown branch, inactive branch and a branch of tenant B are each a 400 at /branch_id (P-1), nothing written', async (s) => {
    for (const branch_id of [uid(999999), BR_INACTIVE, BR_B]) {
      const e = await expectLims(s.call(A, 'createInventoryStore', { body: newStore({ store_code: 'BADBR', branch_id }) }), 'common.validation_failed', 400);
      expect(JSON.stringify(e.errors)).toContain('branch_id');
    }
    expect(await s.sql(A, "SELECT 1 FROM inventory.stores WHERE store_code = 'BADBR'")).toEqual([]);
  });
  run('duplicate store_code: 409 inventory.code_duplicate (any branch, also an inactive store owns its code); tenant B\'s code is simply creatable (no oracle); lower case is a 400', async (s) => {
    await expectLims(s.call(A, 'createInventoryStore', { body: newStore({ store_code: 'MAIN-A' }) }), 'inventory.code_duplicate', 409);
    await expectLims(s.call(A, 'createInventoryStore', { body: newStore({ store_code: 'BR2-MAIN' }) }), 'inventory.code_duplicate', 409);
    await expectLims(s.call(A, 'createInventoryStore', { body: newStore({ store_code: 'OLD-A' }) }), 'inventory.code_duplicate', 409);
    expect((await s.call(A, 'createInventoryStore', { body: newStore({ store_code: 'MAIN-B' }) })).status).toBe(201);
    await expectLims(s.call(A, 'createInventoryStore', { body: newStore({ store_code: 'main-a' }) }), 'common.validation_failed', 400);
    expect((await s.sql(A, "SELECT count(*)::int AS n FROM inventory.stores WHERE store_code = 'MAIN-A'"))[0].n).toBe(1);
  });
  run('hostile text is bound, not interpolated: stored and returned verbatim, tables survive', async (s) => {
    const name = `Robert'); DROP TABLE inventory.stores;-- <script>alert(1)</script> é`;
    const st = await mkStore(s, { store_code: 'HOSTILE-1', name });
    expect((await getStore(s, st.id)).name).toBe(name);
    expect((await s.sql(A, 'SELECT count(*)::int AS n FROM inventory.stores'))[0].n).toBeGreaterThan(3);
  });
  run('#13 get: fixture store; unknown id 404; malformed id 404 or 400, never a 500', async (s) => {
    const st = await getStore(s, MAIN);
    expect(st).toMatchObject({ id: MAIN, branch_id: BR1, store_code: 'MAIN-A', store_kind: 'main', is_default_consumption: true, is_active: true, branch_name: 'Alpha Main Branch (SYNTHETIC)' });
    expect(onlyKeys(st, STORE_KEYS)).toEqual([]);
    await nf(s.call(A, 'getInventoryStore', { params: { store_id: uid(999999) } }));
    const e = await rej(s.call(A, 'getInventoryStore', { params: { store_id: "'; DROP TABLE inventory.stores; --" } }));
    expect((e as any).code).toMatch(/^common\.(not_found|validation_failed)$/);
  });
  it('race: two concurrent creates of one new store_code => exactly one 201, the other 409 inventory.code_duplicate (never a 500)', async () => {
    const code = `RC-${Date.now() % 100000}`;
    const open = async () => { const c = await api.connect(); await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]); return c; };
    const [c1, c2] = [await open(), await open()];
    try {
      const go = (c: pg.PoolClient) => call('createInventoryStore', makeCtx({ query: (t, v) => c.query(t, v) }, A).ctx, { body: newStore({ store_code: code }) });
      await go(c1);
      const p2 = go(c2).then((r) => ({ ok: r }), (e) => ({ err: e }));
      await new Promise((r) => setTimeout(r, 300));
      await c1.query('COMMIT');
      const r2: any = await p2;
      expect(r2.err?.code).toBe('inventory.code_duplicate');
      expect(r2.err?.statusCode).toBe(409);
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined); await c2.query('ROLLBACK').catch(() => undefined); c1.release(); c2.release();
      await admin.query('DELETE FROM inventory.stores WHERE store_code = $1', [code]);
    }
  }, 30_000);
});

// ======================================================================================================== #11 list stores
describe.skipIf(!live)('T-08 #11 list stores: filters, paging, purpose=transfer_target', () => {
  run('default: my tenant only (tenant B never), Store keys only, branch_name present; filters branch_id / store_kind / is_active', async (s) => {
    const r = await s.call(A, 'listInventoryStores', { query: { limit: 200 } });
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(expect.arrayContaining([MAIN, BENCH, ST_BR2, ST_BR2B, ST_NEG, ST_ZERO]));
    expect(ids(r)).not.toContain(MAIN_B);
    expect(r.body.data.flatMap((x: any) => onlyKeys(x, STORE_KEYS))).toEqual([]);
    expect(typeof r.body.page).toBe('object');
    expect(ids(await s.call(A, 'listInventoryStores', { query: { branch_id: BR2, limit: 200 } })).sort()).toEqual([ST_BR2, ST_BR2B].sort());
    const bench = (await s.call(A, 'listInventoryStores', { query: { store_kind: 'bench', limit: 200 } })).body.data;
    expect(bench.every((x: any) => x.store_kind === 'bench')).toBe(true);
    expect(bench.map((x: any) => x.id)).toEqual(expect.arrayContaining([BENCH, ST_BR2B]));
    expect(ids(await s.call(A, 'listInventoryStores', { query: { is_active: false, limit: 200 } }))).toEqual([OLD]);
    expect(ids(await s.call(A, 'listInventoryStores', { query: { is_active: true, limit: 200 } }))).not.toContain(OLD);
  });
  run('tenant B sees only its own stores', async (s) => {
    const r = ids(await s.call(B, 'listInventoryStores', { query: { limit: 200 } }));
    expect(r).toEqual(expect.arrayContaining([MAIN_B, BENCH_B]));
    expect(r).not.toContain(MAIN);
  });
  run('limit + cursor: pages are disjoint, complete and stable; a forged cursor is a 400', async (s) => {
    const all = ids(await s.call(A, 'listInventoryStores', { query: { limit: 200 } }));
    expect(all.length).toBeGreaterThanOrEqual(7);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 30; i++) {
      const r = await s.call(A, 'listInventoryStores', { query: { limit: 2, ...(cursor ? { cursor } : {}) } });
      expect(r.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...ids(r));
      cursor = r.body.page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all);
    expect(((await rej(s.call(A, 'listInventoryStores', { query: { limit: 2, cursor: 'AAAA-forged_cursor' } }))) as any).code).toBe('common.validation_failed');
  });
  run('P-B5 purpose=transfer_target: every ACTIVE store of the tenant (all branches, even for a BR-1-only user), minimal fields only, no inactive, no other tenant', async (s) => {
    for (const o of [{}, BR1_ONLY]) {
      const r = await s.call(A, 'listInventoryStores', { query: { purpose: 'transfer_target', limit: 200 } }, o);
      expect(ids(r)).toEqual(expect.arrayContaining([MAIN, BENCH, ST_BR2, ST_BR2B]));
      expect(ids(r)).not.toContain(OLD);
      expect(ids(r)).not.toContain(MAIN_B);
      expect(r.body.data.flatMap((x: any) => onlyKeys(x, TARGET_KEYS))).toEqual([]);
      const t = r.body.data.find((x: any) => x.id === ST_BR2);
      expect(t).toMatchObject({ store_code: 'BR2-MAIN', branch_id: BR2, branch_name: 'Alpha East Branch (SYNTHETIC)' });
      expect(t).not.toHaveProperty('is_default_consumption');
      expect(t).not.toHaveProperty('version');
    }
  });
});

// ======================================================================================================== #14 update store
describe.skipIf(!live)('T-08 #14 update a store: version, default flag, store_not_empty (AC-03.1, AC-03.3, CR-C12-003)', () => {
  run('PATCH with the right If-Match: 200, fields changed, version + 1, others kept; no enqueue for a plain rename', async (s) => {
    const r = await s.call(A, 'updateInventoryStore', { params: { store_id: BENCH }, headers: ifm(1), body: { name: 'Renamed bench', store_kind: 'other' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: BENCH, store_code: 'BENCH-A', name: 'Renamed bench', store_kind: 'other', branch_id: BR1, is_default_consumption: false, is_active: true, version: 2 });
    expect(await getStore(s, BENCH)).toEqual(r.body);
    expect((await row(s, 'stores', BENCH)).updated_by).toBe(SYS);
    noJobs(s);
  });
  run('stale If-Match: 409 common.version_conflict, row unchanged, nothing enqueued; unknown store 404', async (s) => {
    await s.call(A, 'updateInventoryStore', { params: { store_id: BENCH }, headers: ifm(1), body: { name: 'v2' } });
    await expectLims(s.call(A, 'updateInventoryStore', { params: { store_id: BENCH }, headers: ifm(1), body: { name: 'v3', is_default_consumption: true } }), 'common.version_conflict', 409);
    expect((await getStore(s, BENCH)).name).toBe('v2');
    expect(await defaults(s, BR1)).toEqual([MAIN]);
    noJobs(s);
    await nf(s.call(A, 'updateInventoryStore', { params: { store_id: uid(999999) }, headers: ifm(1), body: { name: 'x' } }));
  });
  run('AC-03.1 marking a second store default in ONE call moves the flag (If-Match of the new default only); the old default is cleared; one job resolve:<tenant>:all is enqueued', async (s) => {
    const r = await s.call(A, 'updateInventoryStore', { params: { store_id: BENCH }, headers: ifm(1), body: { is_default_consumption: true } });
    expect(r.body).toMatchObject({ id: BENCH, is_default_consumption: true, version: 2 });
    expect(await defaults(s, BR1)).toEqual([BENCH]);
    expect((await row(s, 'stores', MAIN)).is_default_consumption).toBe(false);
    oneJob(s, `resolve:${A}:all`);
  });
  run('moving the default in BR-1 leaves BR-2\'s default alone', async (s) => {
    await s.call(A, 'updateInventoryStore', { params: { store_id: BENCH }, headers: ifm(1), body: { is_default_consumption: true } });
    expect(await defaults(s, BR2)).toEqual([ST_BR2]);
  });
  run('AC-03.3 deactivate a store with a non-zero balance (fixture 1001: qty 100; 1002: qty 20): 409 inventory.store_not_empty, still active, version unchanged, nothing enqueued', async (s) => {
    for (const id of [MAIN, BENCH]) {
      const before = await row(s, 'stores', id);
      await expectLims(s.call(A, 'updateInventoryStore', { params: { store_id: id }, headers: ifm(1), body: { is_active: false } }), 'inventory.store_not_empty', 409);
      expect(await row(s, 'stores', id)).toEqual(before);
    }
    noJobs(s);
  });
  run('a NEGATIVE unlotted balance is non-zero too: 409 inventory.store_not_empty', async (s) => {
    await expectLims(s.call(A, 'updateInventoryStore', { params: { store_id: ST_NEG }, headers: ifm(1), body: { is_active: false } }), 'inventory.store_not_empty', 409);
  });
  run('a store whose balance rows are all zero deactivates: 200 is_active false, version + 1; still readable; reactivation of the inactive fixture store works', async (s) => {
    const r = await s.call(A, 'updateInventoryStore', { params: { store_id: ST_ZERO }, headers: ifm(1), body: { is_active: false } });
    expect(r.body).toMatchObject({ id: ST_ZERO, is_active: false, version: 2 });
    expect((await getStore(s, ST_ZERO)).is_active).toBe(false);
    const back = await s.call(A, 'updateInventoryStore', { params: { store_id: OLD }, headers: ifm(1), body: { is_active: true } });
    expect(back.body).toMatchObject({ id: OLD, is_active: true, version: 2 });
  });
  run('E10 deactivating a zero-balance store deactivates its instrument bindings in the same transaction', async (s) => {
    await s.call(A, 'putInstrumentBinding', { params: { instrument_id: IN3 }, body: { store_id: ST_BOUND } });
    expect((await s.sql(A, 'SELECT count(*)::int AS n FROM inventory.instrument_bindings WHERE store_id = $1 AND is_active', [ST_BOUND]))[0].n).toBe(1);
    await s.call(A, 'updateInventoryStore', { params: { store_id: ST_BOUND }, headers: ifm(1), body: { is_active: false } });
    expect((await s.sql(A, 'SELECT count(*)::int AS n FROM inventory.instrument_bindings WHERE store_id = $1 AND is_active', [ST_BOUND]))[0].n).toBe(0);
  });
  it('race: two concurrent "make me the default" calls in one branch => never two defaults, no 500 (the loser either wins later or gets a 409)', async () => {
    const open = async () => { const c = await api.connect(); await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]); return c; };
    const [c1, c2] = [await open(), await open()];
    try {
      const go = (c: pg.PoolClient, id: string) => call('updateInventoryStore', makeCtx({ query: (t, v) => c.query(t, v) }, A).ctx, { params: { store_id: id }, headers: ifm(1), body: { is_default_consumption: true } });
      await go(c1, BENCH);
      const p2 = go(c2, ST_ZERO).then((r) => ({ ok: r }), (e) => ({ err: e }));
      await new Promise((r) => setTimeout(r, 300));
      await c1.query('COMMIT');
      const r2: any = await p2;
      if (r2.err) { expect(r2.err.statusCode).toBeGreaterThanOrEqual(400); expect(r2.err.statusCode).toBeLessThan(500); await c2.query('ROLLBACK'); } else await c2.query('COMMIT');
      const d = (await admin.query('SELECT id FROM inventory.stores WHERE branch_id = $1 AND is_default_consumption AND is_active', [BR1])).rows;
      expect(d).toHaveLength(1);
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined); await c2.query('ROLLBACK').catch(() => undefined); c1.release(); c2.release();
      // Ruling C12.T-08-ruling: the default-per-branch unique index is non-deferrable (05-SCHEMA.md:509-510), so reset in separate statements.
      await admin.query('UPDATE inventory.stores SET is_default_consumption = false WHERE id IN ($1, $2, $3)', [BENCH, MAIN, ST_ZERO]);
      await admin.query('UPDATE inventory.stores SET is_default_consumption = true WHERE id = $1', [MAIN]);
      await admin.query('UPDATE inventory.stores SET version = 1 WHERE id IN ($1, $2, $3)', [BENCH, MAIN, ST_ZERO]);
    }
  }, 30_000);
});

// ======================================================================================================== branch scope (AC-03.2, P-B1, P-B2, P-B5, P-B8)
describe.skipIf(!live)('T-08 branch scope: a BR-1-only user (AC-03.2, P-B1, P-B2, P-B8)', () => {
  run('AC-03.2 list stores: only BR-1 stores; asking for BR-2 explicitly gives an empty list; an all-centres user sees both (P-B4)', async (s) => {
    const mine = ids(await s.call(A, 'listInventoryStores', { query: { limit: 200 } }, BR1_ONLY));
    expect(mine).toEqual(expect.arrayContaining([MAIN, BENCH, ST_NEG]));
    expect(mine).not.toContain(ST_BR2);
    expect(mine).not.toContain(ST_BR2B);
    expect(ids(await s.call(A, 'listInventoryStores', { query: { branch_id: BR2, limit: 200 } }, BR1_ONLY))).toEqual([]);
    expect(ids(await s.call(A, 'listInventoryStores', { query: { limit: 200 } }))).toEqual(expect.arrayContaining([MAIN, ST_BR2]));
  });
  run('AC-03.2 GET a BR-2 store: 404 common.not_found, identical to the 404 of an unknown id (no oracle); a BR-1 store is readable', async (s) => {
    const shape = async (id: string) => { const e = await rej(s.call(A, 'getInventoryStore', { params: { store_id: id } }, BR1_ONLY)) as any; return [e.code, e.statusCode, e.detail, e.errors, e.message]; };
    expect(await shape(ST_BR2)).toEqual(['common.not_found', 404, ...(await shape(uid(999999))).slice(2)]);
    expect(await shape(ST_BR2)).toEqual(await shape(uid(999999)));
    expect((await getStore(s, MAIN, BR1_ONLY)).id).toBe(MAIN);
  });
  run('P-B2 actions on a BR-2 store: PATCH, item-settings list / put, binding put => 404; the rows are untouched, nothing enqueued', async (s) => {
    const before = JSON.stringify(await row(s, 'stores', ST_BR2));
    await nf(s.call(A, 'updateInventoryStore', { params: { store_id: ST_BR2 }, headers: ifm(1), body: { name: 'pwned', is_default_consumption: true } }, BR1_ONLY));
    await nf(s.call(A, 'listStoreItemSettings', { params: { store_id: ST_BR2 } }, BR1_ONLY));
    await nf(s.call(A, 'putStoreItemSetting', { params: { store_id: ST_BR2, item_id: GLU }, body: putSetting({ reorder_level_base: '5' }) }, BR1_ONLY));
    await nf(s.call(A, 'putInstrumentBinding', { params: { instrument_id: IN3 }, body: { store_id: ST_BR2 } }, BR1_ONLY));
    expect(JSON.stringify(await row(s, 'stores', ST_BR2))).toBe(before);
    expect(await s.sql(A, 'SELECT 1 FROM inventory.store_item_settings WHERE store_id = $1', [ST_BR2])).toEqual([]);
    expect(await s.sql(A, 'SELECT 1 FROM inventory.instrument_bindings WHERE instrument_id = $1', [IN3])).toEqual([]);
    noJobs(s);
  });
  run('P-B2 create a store in BR-2 as a BR-1-only user: refused 404 (the branch is not visible), nothing written; in BR-1 it works', async (s) => {
    await nf(s.call(A, 'createInventoryStore', { body: newStore({ store_code: 'PWN-BR2', branch_id: BR2 }) }, BR1_ONLY));
    expect(await s.sql(A, "SELECT 1 FROM inventory.stores WHERE store_code = 'PWN-BR2'")).toEqual([]);
    expect((await s.call(A, 'createInventoryStore', { body: newStore({ store_code: 'OK-BR1' }) }, BR1_ONLY)).status).toBe(201);
  });
  run('P-B8 order of checks: an invisible store is 404 even when the permission is ALSO missing; a visible store without the permission is 403 and assertRole carried the store\'s branch', async (s) => {
    await nf(s.call(A, 'getInventoryStore', { params: { store_id: ST_BR2 } }, { ...BR1_ONLY, permissions: [] }));
    await nf(s.call(A, 'updateInventoryStore', { params: { store_id: ST_BR2 }, headers: ifm(1), body: { name: 'x' } }, { ...BR1_ONLY, permissions: [READ] }));
    s.roleCalls.length = 0;
    await expectLims(s.call(A, 'getInventoryStore', { params: { store_id: MAIN } }, { ...BR1_ONLY, permissions: [] }), 'auth.forbidden', 403);
    expect(s.roleCalls).toContainEqual({ permission: READ, branchId: BR1 });
    s.roleCalls.length = 0;
    await expectLims(s.call(A, 'updateInventoryStore', { params: { store_id: MAIN }, headers: ifm(1), body: { name: 'x' } }, { ...BR1_ONLY, permissions: [READ] }), 'auth.forbidden', 403);
    expect(s.roleCalls).toContainEqual({ permission: MANAGE, branchId: BR1 });
    expect((await row(s, 'stores', MAIN)).name).toBe('Store MAIN-A');
  });
  run('#23 bindings list: a BR-1-only user sees bindings of BR-1 stores only', async (s) => {
    await s.call(A, 'putInstrumentBinding', { params: { instrument_id: IN3 }, body: { store_id: ST_BR2 } });
    const all = (await s.call(A, 'listInstrumentBindings', { query: { limit: 200 } })).body.data.map((b: any) => b.store_id);
    expect(all).toContain(ST_BR2);
    const mine = (await s.call(A, 'listInstrumentBindings', { query: { limit: 200 } }, BR1_ONLY)).body.data.map((b: any) => b.store_id);
    expect(mine).toContain(MAIN);
    expect(mine).not.toContain(ST_BR2);
    expect((await s.call(A, 'listInstrumentBindings', { query: { store_id: ST_BR2 } }, BR1_ONLY)).body.data).toEqual([]);
  });
  run('#24/#25 a binding whose store is in BR-2: deactivate by a BR-1-only user => 404, binding unchanged', async (s) => {
    await s.call(A, 'putInstrumentBinding', { params: { instrument_id: IN3 }, body: { store_id: ST_BR2 } });
    await nf(s.call(A, 'deactivateInstrumentBinding', { params: { instrument_id: IN3 }, headers: ifm(1) }, BR1_ONLY));
    expect((await s.sql(A, 'SELECT is_active FROM inventory.instrument_bindings WHERE instrument_id = $1', [IN3]))[0].is_active).toBe(true);
  });
  run('suppliers are tenant scope: a BR-1-only user lists and creates them', async (s) => {
    expect(ids(await s.call(A, 'listInventorySuppliers', { query: { limit: 200 } }, BR1_ONLY))).toEqual(expect.arrayContaining([SUP1, SUP2]));
    expect((await s.call(A, 'createInventorySupplier', { body: newSupplier() }, BR1_ONLY)).status).toBe(201);
  });
});

// ======================================================================================================== #15 / #16 store item settings
describe.skipIf(!live)('T-08 #15/#16 store item settings', () => {
  run('#15 list: fixture rows of the store, contract keys only, no null on the wire; item_id filter; B\'s store is 404', async (s) => {
    const r = await s.call(A, 'listStoreItemSettings', { params: { store_id: MAIN }, query: { limit: 200 } });
    expect(ids(r)).toEqual(expect.arrayContaining([SET_1, SET_2]));
    const one = r.body.data.find((x: any) => x.id === SET_1);
    expect(one).toMatchObject({ store_id: MAIN, item_id: GLU, is_stocked: true, is_active: true, version: 1 });
    expect(Number(one.reorder_level_base)).toBe(100);
    expect(Number(one.reorder_qty_base)).toBe(400);
    expect(r.body.data.flatMap((x: any) => onlyKeys(x, SETTING_KEYS))).toEqual([]);
    expect(r.body.data.flatMap((x: any) => Object.values(x))).not.toContain(null);
    expect(r.body.data.find((x: any) => x.id === SET_2)).not.toHaveProperty('reorder_level_base');
    expect(ids(await s.call(A, 'listStoreItemSettings', { params: { store_id: MAIN }, query: { item_id: CTRL } }))).toEqual([SET_2]);
    await nf(s.call(A, 'listStoreItemSettings', { params: { store_id: MAIN_B } }));
  });
  run('#15 below_reorder=true: only rows whose on-hand quantity (store 1001, item 2001: 100) is under the reorder level; a row without a reorder level is never below', async (s) => {
    await s.call(A, 'putStoreItemSetting', { params: { store_id: MAIN, item_id: GLU }, headers: ifm(1), body: putSetting({ reorder_level_base: '150', reorder_qty_base: '400' }) });
    expect(ids(await s.call(A, 'listStoreItemSettings', { params: { store_id: MAIN }, query: { below_reorder: true } }))).toEqual([SET_1]);
    await s.call(A, 'putStoreItemSetting', { params: { store_id: MAIN, item_id: GLU }, headers: ifm(2), body: putSetting({ reorder_level_base: '50', reorder_qty_base: '400' }) });
    expect(ids(await s.call(A, 'listStoreItemSettings', { params: { store_id: MAIN }, query: { below_reorder: true } }))).toEqual([]);
  });
  run('#16 first PUT for a (store, item) needs no If-Match: 200 StoreItemSetting, version 1, active; stored exactly (0.5, 12 + 6 digits); preferred supplier echoed', async (s) => {
    const r = await s.call(A, 'putStoreItemSetting', { params: { store_id: MAIN, item_id: TIPS }, body: putSetting({ reorder_level_base: '0.5', reorder_qty_base: '999999999999.999999', max_level_base: '999999999999.999999', preferred_supplier_id: SUP2 }) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ store_id: MAIN, item_id: TIPS, is_stocked: true, is_active: true, version: 1, preferred_supplier_id: SUP2 });
    expect(onlyKeys(r.body, SETTING_KEYS)).toEqual([]);
    const db = (await s.sql(A, 'SELECT reorder_level_base::text AS l, reorder_qty_base::text AS q FROM inventory.store_item_settings WHERE id = $1', [r.body.id]))[0];
    expect(Number(db.l)).toBe(0.5);
    expect(db.q).toBe('999999999999.999999');
  });
  run('#16 reorder level 0 is allowed (>= 0)', async (s) => {
    expect((await s.call(A, 'putStoreItemSetting', { params: { store_id: MAIN, item_id: TIPS }, body: putSetting({ reorder_level_base: '0' }) })).status).toBe(200);
  });
  run('#16 an existing row: no If-Match => 428, stale => 409 common.version_conflict, right one => 200 version + 1; PUT REPLACES the optional fields (omitted reorder_qty_base is cleared)', async (s) => {
    await expectLims(s.call(A, 'putStoreItemSetting', { params: { store_id: MAIN, item_id: GLU }, body: putSetting() }), 'common.precondition_required', 428);
    await expectLims(s.call(A, 'putStoreItemSetting', { params: { store_id: MAIN, item_id: GLU }, headers: ifm(7), body: putSetting() }), 'common.version_conflict', 409);
    expect(Number((await row(s, 'store_item_settings', SET_1)).reorder_qty_base)).toBe(400);
    const r = await s.call(A, 'putStoreItemSetting', { params: { store_id: MAIN, item_id: GLU }, headers: ifm(1), body: putSetting({ reorder_level_base: '10', is_stocked: false }) });
    expect(r.body).toMatchObject({ id: SET_1, version: 2, is_stocked: false });
    expect(Number(r.body.reorder_level_base)).toBe(10);
    expect(r.body).not.toHaveProperty('reorder_qty_base');
    expect((await row(s, 'store_item_settings', SET_1)).reorder_qty_base).toBeNull();
  });
  run('#16 DB rules map to 400 at the field, never a 500: max below reorder level; unknown / other-tenant preferred supplier; reorder_qty "0"', async (s) => {
    const bad = async (body: Record<string, unknown>, path: string) => {
      const e = await expectLims(s.call(A, 'putStoreItemSetting', { params: { store_id: MAIN, item_id: TIPS }, body: putSetting(body) }), 'common.validation_failed', 400);
      expect(JSON.stringify(e.errors)).toContain(path);
    };
    await bad({ reorder_level_base: '10', max_level_base: '5' }, 'max_level_base');
    await bad({ preferred_supplier_id: uid(999999) }, 'preferred_supplier_id');
    await bad({ preferred_supplier_id: SUP_B }, 'preferred_supplier_id');
    await bad({ reorder_qty_base: '0' }, 'reorder_qty_base');
    expect((await s.call(A, 'putStoreItemSetting', { params: { store_id: MAIN, item_id: TIPS }, body: putSetting({ reorder_level_base: '5', max_level_base: '5' }) })).status).toBe(200);
    expect(await s.sql(A, 'SELECT 1 FROM inventory.store_item_settings WHERE store_id = $1 AND item_id = $2 AND reorder_level_base > 5', [MAIN, TIPS])).toEqual([]);
  });
  run('#16 unknown item and tenant-B item / store: 404, nothing written', async (s) => {
    await nf(s.call(A, 'putStoreItemSetting', { params: { store_id: MAIN, item_id: uid(999999) }, body: putSetting() }));
    await nf(s.call(A, 'putStoreItemSetting', { params: { store_id: MAIN, item_id: GLU_B }, body: putSetting() }));
    await nf(s.call(A, 'putStoreItemSetting', { params: { store_id: MAIN_B, item_id: GLU }, body: putSetting() }));
    expect(await s.sql(A, 'SELECT 1 FROM inventory.store_item_settings WHERE item_id = $1', [GLU_B])).toEqual([]);
  });
  it('race: two concurrent FIRST puts for one (store, item) => one 200; the other is 428 or 409 (never a 500, never two rows)', async () => {
    const open = async () => { const c = await api.connect(); await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]); return c; };
    const [c1, c2] = [await open(), await open()];
    try {
      const go = (c: pg.PoolClient) => call('putStoreItemSetting', makeCtx({ query: (t, v) => c.query(t, v) }, A).ctx, { params: { store_id: ST_BOUND, item_id: CTRL }, body: putSetting({ reorder_level_base: '3' }) });
      await go(c1);
      const p2 = go(c2).then((r) => ({ ok: r }), (e) => ({ err: e }));
      await new Promise((r) => setTimeout(r, 300));
      await c1.query('COMMIT');
      const r2: any = await p2;
      expect([428, 409]).toContain(r2.err?.statusCode);
      expect((await admin.query('SELECT 1 FROM inventory.store_item_settings WHERE store_id = $1 AND item_id = $2', [ST_BOUND, CTRL])).rows).toHaveLength(1);
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined); await c2.query('ROLLBACK').catch(() => undefined); c1.release(); c2.release();
      await admin.query('DELETE FROM inventory.store_item_settings WHERE store_id = $1 AND item_id = $2', [ST_BOUND, CTRL]);
    }
  }, 30_000);
});

// ======================================================================================================== #17-#20 suppliers
describe.skipIf(!live)('T-08 #17-#20 suppliers (AC-04.1)', () => {
  run('AC-04.1 create SUP-NEW with name and PAN text: 201 Supplier, contract keys, active, version 1, no audit / tenant fields; stored for tenant A', async (s) => {
    const r = await s.call(A, 'createInventorySupplier', { body: newSupplier({ supplier_code: 'SUP-NEW', name: 'Gamma Traders', pan_text: 'PAN123456', contact_name: 'Synthetic Contact', phone_display: '01-5550000', email: 'sales@gamma.example', address_text: 'Synthetic Road 5', payment_terms_days: 30, notes: 'n' }) });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ supplier_code: 'SUP-NEW', name: 'Gamma Traders', pan_text: 'PAN123456', contact_name: 'Synthetic Contact', phone_display: '01-5550000', email: 'sales@gamma.example', payment_terms_days: 30, is_active: true, version: 1 });
    expect(onlyKeys(r.body, SUPPLIER_KEYS)).toEqual([]);
    expect(Object.keys(r.body).filter((k) => LEAK.test(k))).toEqual([]);
    expect(typeof r.body.updated_at).toBe('string');
    expect(await row(s, 'suppliers', r.body.id)).toMatchObject({ tenant_id: A, created_by: SYS, supplier_code: 'SUP-NEW' });
    expect((await s.call(A, 'getInventorySupplier', { params: { supplier_id: r.body.id } })).body).toEqual(r.body);
  });
  run('only code + name: stored without optional fields, no null on the wire', async (s) => {
    const r = await s.call(A, 'createInventorySupplier', { body: newSupplier() });
    expect(Object.values(r.body)).not.toContain(null);
    expect(r.body).not.toHaveProperty('pan_text');
  });
  run('07 §5 supplier contact data is personal data: never in a log line, and an error never echoes it', async (s) => {
    const body = newSupplier({ supplier_code: 'PII-1', contact_name: 'Pii Contact Zed', phone_display: '98-PII-7777', email: 'pii.zed@example.test', address_text: 'Pii Street 9', pan_text: 'PIIPAN99' });
    await s.call(A, 'createInventorySupplier', { body });
    const e = await rej(s.call(A, 'createInventorySupplier', { body }));
    expect((e as any).statusCode).toBe(409);
    const dump = JSON.stringify([s.logs, (e as any).detail, (e as any).errors, (e as any).message]);
    for (const v of ['Pii Contact Zed', '98-PII-7777', 'pii.zed@example.test', 'Pii Street 9', 'PIIPAN99']) expect(dump).not.toContain(v);
  });
  run('duplicate supplier_code: 409 inventory.code_duplicate (also an inactive supplier owns its code), nothing written', async (s) => {
    await expectLims(s.call(A, 'createInventorySupplier', { body: newSupplier({ supplier_code: 'SUP-01' }) }), 'inventory.code_duplicate', 409);
    await expectLims(s.call(A, 'createInventorySupplier', { body: newSupplier({ supplier_code: 'SUP-03' }) }), 'inventory.code_duplicate', 409);
    expect((await s.sql(A, "SELECT count(*)::int AS n FROM inventory.suppliers WHERE supplier_code = 'SUP-01'"))[0].n).toBe(1);
  });
  run('hostile text is bound, not interpolated', async (s) => {
    const name = `Robert'); DROP TABLE inventory.suppliers;-- <b>x</b>`;
    const r = await s.call(A, 'createInventorySupplier', { body: newSupplier({ supplier_code: 'HOSTILE', name }) });
    expect(r.body.name).toBe(name);
    expect((await s.sql(A, 'SELECT count(*)::int AS n FROM inventory.suppliers'))[0].n).toBeGreaterThan(3);
  });
  run('#19 get: fixture supplier; unknown id and tenant B\'s supplier are the same 404', async (s) => {
    const r = await s.call(A, 'getInventorySupplier', { params: { supplier_id: SUP1 } });
    expect(r.body).toMatchObject({ id: SUP1, supplier_code: 'SUP-01', name: 'Alpha Lab Supplies', is_active: true });
    expect(onlyKeys(r.body, SUPPLIER_KEYS)).toEqual([]);
    const shape = async (id: string) => { const e = await rej(s.call(A, 'getInventorySupplier', { params: { supplier_id: id } })) as any; return [e.code, e.statusCode, e.detail, e.errors, e.message]; };
    expect(await shape(SUP_B)).toEqual(await shape(uid(999999)));
    expect((await shape(SUP_B))[0]).toBe('common.not_found');
  });
  run('#17 list: my tenant only, SupplierSummary keys only (no contact / PAN fields); is_active filter; q is a case-insensitive NAME prefix with literal LIKE characters', async (s) => {
    const r = await s.call(A, 'listInventorySuppliers', { query: { limit: 200 } });
    expect(ids(r)).toEqual(expect.arrayContaining([SUP1, SUP2]));
    expect(ids(r)).not.toContain(SUP_B);
    expect(r.body.data.flatMap((x: any) => onlyKeys(x, SUPPLIER_SUMMARY_KEYS))).toEqual([]);
    expect(ids(await s.call(A, 'listInventorySuppliers', { query: { is_active: true, limit: 200 } }))).not.toContain(SUP3);
    expect(ids(await s.call(A, 'listInventorySuppliers', { query: { is_active: false, limit: 200 } }))).toEqual([SUP3]);
    expect(ids(await s.call(A, 'listInventorySuppliers', { query: { q: 'alpha', is_active: true } }))).toEqual([SUP1]);
    expect(ids(await s.call(A, 'listInventorySuppliers', { query: { q: 'ALPHA', is_active: false } }))).toEqual([SUP3]);
    expect(ids(await s.call(A, 'listInventorySuppliers', { query: { q: 'beta' } }))).toEqual([SUP2]);
    for (const q of ['%', '_', 'A%', '\\', "'; DROP TABLE inventory.suppliers; --"]) expect((await s.call(A, 'listInventorySuppliers', { query: { q } })).body.data, q).toEqual([]);
    expect((await s.sql(A, 'SELECT count(*)::int AS n FROM inventory.suppliers'))[0].n).toBe(3);
  });
  run('#17 limit + cursor: pages are disjoint and complete; tenant B sees only its own supplier', async (s) => {
    const all = ids(await s.call(A, 'listInventorySuppliers', { query: { limit: 200 } }));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await s.call(A, 'listInventorySuppliers', { query: { limit: 1, ...(cursor ? { cursor } : {}) } });
      seen.push(...ids(r));
      cursor = r.body.page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all);
    expect(ids(await s.call(B, 'listInventorySuppliers', { query: { limit: 200 } }))).toEqual([SUP_B]);
  });
  run('#20 PATCH with the right If-Match: 200, changed fields only, version + 1, supplier_code kept; stale => 409; unknown => 404', async (s) => {
    const r = await s.call(A, 'updateInventorySupplier', { params: { supplier_id: SUP1 }, headers: ifm(1), body: { name: 'Alpha Renamed', pan_text: 'NEWPAN1', payment_terms_days: 45 } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: SUP1, supplier_code: 'SUP-01', name: 'Alpha Renamed', pan_text: 'NEWPAN1', payment_terms_days: 45, version: 2 });
    expect((await s.call(A, 'getInventorySupplier', { params: { supplier_id: SUP1 } })).body).toEqual(r.body);
    await expectLims(s.call(A, 'updateInventorySupplier', { params: { supplier_id: SUP1 }, headers: ifm(1), body: { name: 'v3' } }), 'common.version_conflict', 409);
    await nf(s.call(A, 'updateInventorySupplier', { params: { supplier_id: uid(999999) }, headers: ifm(1), body: { name: 'x' } }));
  });
  run('#20 unset[] clears optional fields (no null on the wire); required fields stay', async (s) => {
    const c = (await s.call(A, 'createInventorySupplier', { body: newSupplier({ supplier_code: 'UNS-1', pan_text: 'PAN1', notes: 'N', contact_name: 'C' }) })).body;
    const r = await s.call(A, 'updateInventorySupplier', { params: { supplier_id: c.id }, headers: ifm(1), body: { unset: ['pan_text', 'notes'] } });
    expect(r.body).not.toHaveProperty('pan_text');
    expect(r.body).not.toHaveProperty('notes');
    expect(r.body).toMatchObject({ contact_name: 'C', name: c.name, version: 2 });
    expect(Object.values(r.body)).not.toContain(null);
  });
  it('race: two concurrent creates of one new supplier_code => exactly one 201, the other 409 inventory.code_duplicate', async () => {
    const code = `RS-${Date.now() % 100000}`;
    const open = async () => { const c = await api.connect(); await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]); return c; };
    const [c1, c2] = [await open(), await open()];
    try {
      const go = (c: pg.PoolClient) => call('createInventorySupplier', makeCtx({ query: (t, v) => c.query(t, v) }, A).ctx, { body: newSupplier({ supplier_code: code }) });
      await go(c1);
      const p2 = go(c2).then((r) => ({ ok: r }), (e) => ({ err: e }));
      await new Promise((r) => setTimeout(r, 300));
      await c1.query('COMMIT');
      const r2: any = await p2;
      expect(r2.err?.code).toBe('inventory.code_duplicate');
      expect(r2.err?.statusCode).toBe(409);
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined); await c2.query('ROLLBACK').catch(() => undefined); c1.release(); c2.release();
      await admin.query('DELETE FROM inventory.suppliers WHERE supplier_code = $1', [code]);
    }
  }, 30_000);
});

// ======================================================================================================== #21 / #22 supplier items
describe.skipIf(!live)('T-08 #21/#22 supplier items (AC-04.2)', () => {
  const put = (s: Sess, sup: string, item: string, pack: string, body: Record<string, unknown>, headers?: Record<string, string>, o?: Opts) =>
    s.call(A, 'putSupplierItem', { params: { supplier_id: sup, item_id: item, pack_id: pack }, body: putSupplierItemBody(body), ...(headers ? { headers } : {}) }, o);
  const WITH_COST: Opts = { permissions: [READ, MANAGE, COST] };

  run('AC-04.2 set (SUP-01, GLU-R1, BOX): last price 450000 paisa, lead time 7 days => 200 SupplierItem, version + 1, stored; the supplier-item list returns it (with inventory.cost.read)', async (s) => {
    const r = await put(s, SUP1, GLU, BOX, { last_unit_price_paisa: 450000, lead_time_days: 7 }, ifm(1), WITH_COST);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: SI, supplier_id: SUP1, item_id: GLU, pack_id: BOX, last_unit_price_paisa: 450000, lead_time_days: 7, is_active: true, version: 2 });
    expect(onlyKeys(r.body, SUPPLIER_ITEM_KEYS)).toEqual([]);
    const db = await row(s, 'supplier_items', SI);
    expect([Number(db.last_unit_price_paisa), db.lead_time_days]).toEqual([450000, 7]);
    const l = (await s.call(A, 'listSupplierItems', { params: { supplier_id: SUP1 }, query: { limit: 200 } }, WITH_COST)).body.data;
    expect(l.find((x: any) => x.id === SI)).toMatchObject({ pack_id: BOX, last_unit_price_paisa: 450000, lead_time_days: 7 });
  });
  run('cost allowlist (REQ-SEC-081): without inventory.cost.read the price never reaches the wire (put response and list), the rest does; the row still stores it', async (s) => {
    const r = await put(s, SUP1, GLU, BOX, { last_unit_price_paisa: 450000, lead_time_days: 7 }, ifm(1));
    expect(r.body).not.toHaveProperty('last_unit_price_paisa');
    expect(r.body.lead_time_days).toBe(7);
    expect(JSON.stringify(r.body)).not.toContain('450000');
    const l = await s.call(A, 'listSupplierItems', { params: { supplier_id: SUP1 }, query: { limit: 200 } });
    expect(JSON.stringify(l.body)).not.toMatch(/paisa/);
    expect(Number((await row(s, 'supplier_items', SI)).last_unit_price_paisa)).toBe(450000);
  });
  run('first PUT of a new (supplier, item, pack) needs no If-Match: 200, version 1; price 0 and lead time 0 / 365 are valid; default_tax_code accepts a global code and an active tenant code', async (s) => {
    const r = await put(s, SUP1, GLU, KIT, { supplier_item_code: 'KIT-9', last_unit_price_paisa: 0, lead_time_days: 365, default_tax_code: 'VAT' }, undefined, WITH_COST);
    expect(r.body).toMatchObject({ supplier_id: SUP1, item_id: GLU, pack_id: KIT, supplier_item_code: 'KIT-9', last_unit_price_paisa: 0, lead_time_days: 365, default_tax_code: 'VAT', version: 1, is_active: true });
    expect((await put(s, SUP2, GLU, BOX, { default_tax_code: 'LOCALTAX', lead_time_days: 0 })).status).toBe(200);
  });
  run('unknown or inactive tax code is a 400 at /default_tax_code (FK / coded set, P-1); nothing written', async (s) => {
    for (const default_tax_code of ['NOSUCH', 'OLDTAX']) {
      const e = await expectLims(put(s, SUP1, GLU, KIT, { default_tax_code }), 'common.validation_failed', 400);
      expect(JSON.stringify(e.errors)).toContain('default_tax_code');
    }
    expect(await s.sql(A, 'SELECT 1 FROM inventory.supplier_items WHERE supplier_id = $1 AND pack_id = $2', [SUP1, KIT])).toEqual([]);
  });
  run('an existing row: no If-Match => 428, stale => 409, right => 200; PUT REPLACES the optional fields (omitted price is cleared); is_active:false deactivates (row kept)', async (s) => {
    await expectLims(put(s, SUP1, GLU, BOX, {}), 'common.precondition_required', 428);
    await expectLims(put(s, SUP1, GLU, BOX, {}, ifm(5)), 'common.version_conflict', 409);
    expect(Number((await row(s, 'supplier_items', SI)).last_unit_price_paisa)).toBe(50000);
    const r = await put(s, SUP1, GLU, BOX, { is_active: false }, ifm(1));
    expect(r.body).toMatchObject({ id: SI, is_active: false, version: 2 });
    expect((await row(s, 'supplier_items', SI)).last_unit_price_paisa).toBeNull();
  });
  run('a pack of ANOTHER item => 422 inventory.uom_mismatch; nothing written', async (s) => {
    await expectLims(put(s, SUP1, CTRL, BOX, {}), 'inventory.uom_mismatch', 422);
    expect(await s.sql(A, 'SELECT 1 FROM inventory.supplier_items WHERE item_id = $1', [CTRL])).toEqual([]);
  });
  run('probes: unknown supplier / tenant-B supplier / tenant-B item => 404; a tenant-B pack answers exactly like an unknown pack (no oracle, never a 5xx); nothing written', async (s) => {
    await nf(put(s, uid(999999), GLU, BOX, {}));
    await nf(put(s, SUP_B, GLU, BOX, {}));
    await nf(put(s, SUP1, GLU_B, BOX_B, {}));
    const shape = async (pack: string) => { const e = await rej(put(s, SUP1, GLU, pack, {})) as any; return [e.code, e.statusCode, e.detail, e.errors, e.message]; };
    const foreign = await shape(BOX_B);
    expect(foreign).toEqual(await shape(uid(999999)));
    expect(foreign[1]).toBeLessThan(500);
    expect((await s.sql(A, 'SELECT count(*)::int AS n FROM inventory.supplier_items'))[0].n).toBe(1);
  });
  run('#21 list: items of the supplier only, contract keys; item_id filter; tenant B\'s supplier is 404', async (s) => {
    await put(s, SUP1, GLU, KIT, {});
    const l = await s.call(A, 'listSupplierItems', { params: { supplier_id: SUP1 }, query: { limit: 200 } });
    expect(l.body.data.map((x: any) => x.pack_id).sort()).toEqual([BOX, KIT].sort());
    expect(l.body.data.flatMap((x: any) => onlyKeys(x, SUPPLIER_ITEM_KEYS))).toEqual([]);
    expect((await s.call(A, 'listSupplierItems', { params: { supplier_id: SUP1 }, query: { item_id: CTRL } })).body.data).toEqual([]);
    expect((await s.call(A, 'listSupplierItems', { params: { supplier_id: SUP1 }, query: { item_id: GLU } })).body.data).toHaveLength(2);
    expect((await s.call(A, 'listSupplierItems', { params: { supplier_id: SUP2 } })).body.data).toEqual([]);
    await nf(s.call(A, 'listSupplierItems', { params: { supplier_id: SUP_B } }));
  });
});

// ======================================================================================================== #23-#25 bindings
describe.skipIf(!live)('T-08 #23-#25 instrument bindings (AC-17.1) and the resolve_unresolved enqueue', () => {
  const bind = (s: Sess, instrument: string, store: string, headers?: Record<string, string>, o?: Opts) =>
    s.call(A, 'putInstrumentBinding', { params: { instrument_id: instrument }, body: { store_id: store }, ...(headers ? { headers } : {}) }, o);
  const active = async (s: Sess, instrument: string) => s.sql(A, 'SELECT store_id FROM inventory.instrument_bindings WHERE instrument_id = $1 AND is_active', [instrument]);

  run('AC-17.1 bind instrument IN-A3 to BENCH-A: 200 Binding, active, version 1, contract keys; the one active binding of the instrument points at BENCH-A; ONE job inventory.resolve_unresolved, key resolve:<tenant>:<instrument>, payload.tenant_id', async (s) => {
    const r = await bind(s, IN3, BENCH);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ instrument_id: IN3, store_id: BENCH, is_active: true, version: 1 });
    expect(onlyKeys(r.body, BINDING_KEYS)).toEqual([]);
    expect(await active(s, IN3)).toEqual([{ store_id: BENCH }]);
    oneJob(s, `resolve:${A}:${IN3}`);
  });
  run('re-binding an instrument that already has an active binding: needs If-Match (428 without, 409 stale); with it, exactly ONE active binding remains and it points at the new store; the job is enqueued again', async (s) => {
    await expectLims(bind(s, IN1, BENCH), 'common.precondition_required', 428);
    await expectLims(bind(s, IN1, BENCH, ifm(9)), 'common.version_conflict', 409);
    expect(await active(s, IN1)).toEqual([{ store_id: MAIN }]);
    noJobs(s);
    const r = await bind(s, IN1, BENCH, ifm(1));
    expect(r.body).toMatchObject({ instrument_id: IN1, store_id: BENCH, is_active: true });
    expect(await active(s, IN1)).toEqual([{ store_id: BENCH }]);
    oneJob(s, `resolve:${A}:${IN1}`);
  });
  run('refusals enqueue nothing and change nothing: unknown instrument, tenant-B instrument, tenant-B store, unknown store => 404', async (s) => {
    const before = JSON.stringify(await s.sql(A, 'SELECT * FROM inventory.instrument_bindings ORDER BY id'));
    await nf(bind(s, uid(999999), BENCH));
    await nf(bind(s, IN_B, BENCH));
    await nf(bind(s, IN3, MAIN_B));
    await nf(bind(s, IN3, uid(999999)));
    expect(JSON.stringify(await s.sql(A, 'SELECT * FROM inventory.instrument_bindings ORDER BY id'))).toBe(before);
    noJobs(s);
  });
  run('#25 deactivate: 200 is_active false, version + 1; the instrument has no active binding afterwards; no job; stale => 409, unknown => 404', async (s) => {
    await expectLims(s.call(A, 'deactivateInstrumentBinding', { params: { instrument_id: IN1 }, headers: ifm(9) }), 'common.version_conflict', 409);
    const r = await s.call(A, 'deactivateInstrumentBinding', { params: { instrument_id: IN1 }, headers: ifm(1) });
    expect(r.body).toMatchObject({ id: BIND1, instrument_id: IN1, store_id: MAIN, is_active: false, version: 2 });
    expect(onlyKeys(r.body, BINDING_KEYS)).toEqual([]);
    expect(await active(s, IN1)).toEqual([]);
    noJobs(s);
    await nf(s.call(A, 'deactivateInstrumentBinding', { params: { instrument_id: uid(999999) }, headers: ifm(1) }));
  });
  run('#23 list: my tenant only; store_id filter; contract keys; tenant B\'s binding never', async (s) => {
    const r = await s.call(A, 'listInstrumentBindings', { query: { limit: 200 } });
    expect(ids(r)).toContain(BIND1);
    expect(ids(r)).not.toContain(BIND_B);
    expect(r.body.data.flatMap((x: any) => onlyKeys(x, BINDING_KEYS))).toEqual([]);
    expect(ids(await s.call(A, 'listInstrumentBindings', { query: { store_id: MAIN } }))).toEqual([BIND1]);
    expect(ids(await s.call(B, 'listInstrumentBindings', { query: { limit: 200 } }))).toEqual([BIND_B]);
    expect(await s.sql(A, 'SELECT 1 FROM inventory.instrument_bindings WHERE id = $1', [BIND2])).toHaveLength(1);
  });
  run('enqueue seam: with the C0 wrapper the job really goes through app.enqueue_job (registered task, per_tenant claims match payload.tenant_id) — the request does not fail', async (s) => {
    const r = await bind(s, IN3, BENCH);
    expect(r.status).toBe(200);
    expect(s.jobs.map((j) => j.task)).toContain(TASK);
  });
});

// ======================================================================================================== cross-tenant probes (P-T1, P-T3, P-T5)
describe.skipIf(!live)('T-08 probes: cross-tenant on every operation (07-SECURITY §6.1)', () => {
  run('tenant A actor on tenant B ids: get / patch / settings list+put / supplier get+patch / supplier items list+put / binding put+deactivate => 404 common.not_found; B\'s rows are byte-identical afterwards; nothing enqueued', async (s) => {
    const snap = async () => JSON.stringify(await Promise.all(['stores', 'store_item_settings', 'suppliers', 'supplier_items', 'instrument_bindings'].map((t) => s.sql(B, `SELECT * FROM inventory.${t} WHERE tenant_id = $1 ORDER BY id`, [B]))));
    const before = await snap();
    await nf(s.call(A, 'getInventoryStore', { params: { store_id: MAIN_B } }));
    await nf(s.call(A, 'updateInventoryStore', { params: { store_id: MAIN_B }, headers: ifm(1), body: { name: 'pwned', is_default_consumption: true } }));
    await nf(s.call(A, 'updateInventoryStore', { params: { store_id: MAIN_B }, headers: ifm(1), body: { is_active: false } }));
    await nf(s.call(A, 'listStoreItemSettings', { params: { store_id: MAIN_B } }));
    await nf(s.call(A, 'putStoreItemSetting', { params: { store_id: MAIN_B, item_id: GLU_B }, headers: ifm(1), body: putSetting({ reorder_level_base: '1' }) }));
    await nf(s.call(A, 'getInventorySupplier', { params: { supplier_id: SUP_B } }));
    await nf(s.call(A, 'updateInventorySupplier', { params: { supplier_id: SUP_B }, headers: ifm(1), body: { name: 'pwned' } }));
    await nf(s.call(A, 'listSupplierItems', { params: { supplier_id: SUP_B } }));
    await nf(s.call(A, 'putSupplierItem', { params: { supplier_id: SUP_B, item_id: GLU_B, pack_id: BOX_B }, headers: ifm(1), body: putSupplierItemBody({ last_unit_price_paisa: 1 }) }));
    await nf(s.call(A, 'putInstrumentBinding', { params: { instrument_id: IN_B }, headers: ifm(1), body: { store_id: BENCH_B } }));
    await nf(s.call(A, 'putInstrumentBinding', { params: { instrument_id: IN1 }, headers: ifm(1), body: { store_id: MAIN_B } }));
    await nf(s.call(A, 'deactivateInstrumentBinding', { params: { instrument_id: IN_B }, headers: ifm(1) }));
    expect(await snap()).toBe(before);
    noJobs(s);
  });
  run('the 404 of a foreign store id is identical to the 404 of an unknown id (no oracle)', async (s) => {
    const shape = async (id: string) => { const e = await rej(s.call(A, 'getInventoryStore', { params: { store_id: id } })) as any; return [e.code, e.statusCode, e.detail, e.errors, e.message]; };
    expect(await shape(MAIN_B)).toEqual(await shape(uid(999999)));
  });
  run('a body that names tenant-B ids cannot move a row: preferred_supplier_id / store_id of B', async (s) => {
    const e = await rej(s.call(A, 'putStoreItemSetting', { params: { store_id: MAIN, item_id: TIPS }, body: putSetting({ preferred_supplier_id: SUP_B }) })) as any;
    expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500);
    expect(await s.sql(A, 'SELECT 1 FROM inventory.store_item_settings WHERE preferred_supplier_id = $1', [SUP_B])).toEqual([]);
  });
  it('P-T5 SQL probe: with tenant A claims the five tables show 0 rows of tenant B; an INSERT with B\'s tenant_id fails RLS; UPDATE of a B row affects 0 rows', async () => {
    await session(async (s) => {
      for (const t of ['stores', 'store_item_settings', 'suppliers', 'supplier_items', 'instrument_bindings']) expect((await s.sql(A, `SELECT count(*)::int AS n FROM inventory.${t} WHERE tenant_id = $1`, [B]))[0].n, t).toBe(0);
      const e = await rej(s.sql(A, "INSERT INTO inventory.suppliers (id, tenant_id, supplier_code, name, created_by, updated_by) VALUES (gen_random_uuid(), $1, 'PWN', 'x', $2, $2)", [B, SYS]));
      expect(String((e as any).message)).toMatch(/row-level security/i);
    });
    await session(async (s) => {
      await s.sql(A, "UPDATE inventory.stores SET name = 'pwned' WHERE id = $1", [MAIN_B]);
      expect((await row(s, 'stores', MAIN_B, B)).name).not.toBe('pwned');
    });
  });
});
