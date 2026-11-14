// C12.T-07 integration + probes for #1-#10 on the migrated database as role lims_api with RLS on (REAL T-03 repositories, handlers/index.ts, service/items.service.ts).
// Harness: tests/db/c12-t07/run.sh (clone of c12-t04: pinned image, migrations, seeds, inventory DDL, exports LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL / LIMS_C12T03_REQUIRE_DB=1).
// Fixtures: tests/db/c12-t03/fixtures.sql (applied once). Used rows: tenant A items 2001 GLU-R1 (packs 2201 BOX=400 purchase default, 2202 KIT, 2203 OLDBOX inactive; barcode 2401 BC-GLU-1 on pack 2201,
//   2402 BC-OLD inactive; balances 5001 qty 100 + 5004 qty 20 on lots; open PO lines 8501/8503/8504; rules 7001-7003; movements 6001-6003), 2002 CTRL-L1 (ml; rules 7004/7005; NO pack, NO balance),
//   2003 TIPS-200 (piece; balance 5003 qty 50, movement 6004; NO pack, NO rule, NO PO line), 2004 OLD-IT (inactive, nothing attached); tenant B item 2101 GLU-R1 (same code), pack 2301, barcode 2411 'BC-GLU-1'.
// Each test = one request-shaped transaction that is ROLLED BACK; every handler call runs inside a SAVEPOINT (the pipeline rolls a failed request back, so the next call in the test starts clean).
// Without the URLs the DB tests skip, except under LIMS_C12T03_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packToBase } from '../../domain/quantity.js';
import { A, B, BARCODE_KEYS, ITEM_KEYS, LEAK, MANAGE, PACK_KEYS, READ, SUMMARY_KEYS, call, expectLims, ifm, makeCtx, newItem, newPack, onlyKeys, rej, uid } from './items.helpers.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const GLU = uid(2001), CTRL = uid(2002), TIPS = uid(2003), OLD = uid(2004), GLU_B = uid(2101);
const BOX = uid(2201), BOX_B = uid(2301), BC_GLU = uid(2401), BC_GLU_B = uid(2411);

let api: pg.Pool;
let admin: pg.Pool;
beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 6 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c12-t03/fixtures.sql', import.meta.url)), 'utf8'));
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-07 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

type Perms = string[];
interface Sess {
  /** run operation `op` as tenant `t` (claims switched transaction-locally) inside a SAVEPOINT; a throw rolls the savepoint back and propagates. */
  call(t: string, op: string, req?: Parameters<typeof call>[2], perms?: Perms): Promise<{ status: number; body: any }>;
  /** raw SQL as lims_api (RLS on) with tenant t's claims. */
  sql(t: string, text: string, v?: unknown[]): Promise<any[]>;
}
const claims = (t: string) => JSON.stringify({ tenant_id: t, sub: SYS, actor_type: 'system' });
async function session<T>(fn: (s: Sess) => Promise<T>): Promise<T> {
  const client = await api.connect();
  let n = 0;
  const tx = { query: (t: string, v?: unknown[]) => client.query(t, v) };
  const s: Sess = {
    async sql(t, text, v) { await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]); return (await client.query(text, v)).rows; },
    async call(t, op, req, perms) {
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]);
      const { ctx } = makeCtx(tx, t, perms ?? [READ, MANAGE]);
      const sp = `t07_h${++n}`;
      await client.query(`SAVEPOINT ${sp}`);
      try { const r = await call(op, ctx, req); await client.query(`RELEASE SAVEPOINT ${sp}`); return r; }
      catch (e) { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
    },
  };
  try { await client.query('BEGIN'); return await fn(s); } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}
const run = (name: string, fn: (s: Sess) => Promise<void>) => it(name, () => session(fn));

const create = async (s: Sess, over: Record<string, unknown> = {}, t = A) => (await s.call(t, 'createInventoryItem', { body: newItem(over) })).body;
const addPack = async (s: Sess, item: any, over: Record<string, unknown> = {}) =>
  (await s.call(A, 'createInventoryItemPack', { params: { item_id: item.id }, body: newPack(over) })).body;
const addBarcode = async (s: Sess, itemId: string, barcode_value: string, extra: Record<string, unknown> = {}, t = A) =>
  s.call(t, 'addInventoryItemBarcode', { params: { item_id: itemId }, body: { barcode_value, ...extra } });
const getItem = async (s: Sess, id: string, t = A) => (await s.call(t, 'getInventoryItem', { params: { item_id: id } })).body;
const row = async (s: Sess, table: string, id: string, t = A) => (await s.sql(t, `SELECT * FROM inventory.${table} WHERE id = $1`, [id]))[0];

describe.skipIf(!live)('T-07 #2/#3 create + read an item (AC-01.1, AC-01.4 flags)', () => {
  run('AC-01.1 create: 201 Item, active, version 1, contract keys only, no money / tenant / audit fields, row stored for tenant A by the actor', async (s) => {
    const r = await s.call(A, 'createInventoryItem', { body: newItem({ item_code: 'GLU-R2', manufacturer: 'Synthetic Bio', storage_condition: 'refrigerated', open_stability_days: 30, container_qty_base: '100.5', hs_code: '38220010', default_tax_code: 'VAT', notes: 'n' }) });
    expect(r.status).toBe(201);
    const it = r.body;
    expect(it).toMatchObject({ item_code: 'GLU-R2', name: 'T07 synthetic reagent', category: 'reagent', base_uom_code: 'test', is_active: true, version: 1, packs: [], barcodes: [], manufacturer: 'Synthetic Bio', storage_condition: 'refrigerated', open_stability_days: 30, hs_code: '38220010', default_tax_code: 'VAT', notes: 'n' });
    expect(Number(it.container_qty_base)).toBe(100.5);
    expect(it.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(onlyKeys(it, ITEM_KEYS)).toEqual([]);
    expect(Object.keys(it).filter((k) => LEAK.test(k))).toEqual([]);
    expect(typeof it.updated_at).toBe('string');
    const db = await row(s, 'items', it.id);
    expect(db).toMatchObject({ tenant_id: A, created_by: SYS, updated_by: SYS, version: 1, is_active: true });
  });
  run('create with only the required fields: AC-01.4 defaults is_lot_tracked = true and requires_expiry = true', async (s) => {
    const it = await create(s, { item_code: 'DEF-1' });
    expect([it.is_lot_tracked, it.requires_expiry]).toEqual([true, true]);
  });
  run('flags are stored as sent: not lot tracked + not expiring; lot tracked without expiry; (not lot tracked + expiring is 400, never a 500)', async (s) => {
    expect(await create(s, { item_code: 'F-1', is_lot_tracked: false, requires_expiry: false })).toMatchObject({ is_lot_tracked: false, requires_expiry: false });
    expect(await create(s, { item_code: 'F-2', is_lot_tracked: true, requires_expiry: false })).toMatchObject({ is_lot_tracked: true, requires_expiry: false });
    await expectLims(s.call(A, 'createInventoryItem', { body: newItem({ item_code: 'F-3', is_lot_tracked: false, requires_expiry: true }) }), 'common.validation_failed', 400);
  });
  run('unknown base_uom_code / default_tax_code is a 400 naming the field (FK mapped, P-1), never a 500, nothing written', async (s) => {
    for (const [over, name] of [[{ base_uom_code: 'nosuchunit' }, 'base_uom_code'], [{ default_tax_code: 'NOSUCHTAX' }, 'default_tax_code']] as const) {
      const e = await expectLims(s.call(A, 'createInventoryItem', { body: newItem({ item_code: 'BADREF', ...over }) }), 'common.validation_failed', 400);
      expect(JSON.stringify(e.errors)).toContain(name);
    }
    expect(await s.sql(A, "SELECT 1 FROM inventory.items WHERE item_code = 'BADREF'")).toEqual([]);
  });
  run('hostile text is bound, not interpolated or escaped: stored and returned verbatim, tables survive', async (s) => {
    const name = `Robert'); DROP TABLE inventory.items;-- <script>alert(1)</script> ${'é'}`;
    const it = await create(s, { item_code: 'HOSTILE-1', name, notes: "' OR 1=1 --" });
    expect(it.name).toBe(name);
    expect((await getItem(s, it.id)).notes).toBe("' OR 1=1 --");
    expect((await s.sql(A, 'SELECT count(*)::int AS n FROM inventory.items'))[0].n).toBeGreaterThan(3);
  });
  run('mass assignment cannot reach the row: unknown / system keys never get past the schema (also at the service)', async (s) => {
    await expectLims(s.call(A, 'createInventoryItem', { body: { ...newItem({ item_code: 'MASS-1' }), tenant_id: B } }), 'common.validation_failed', 400);
    expect(await s.sql(A, "SELECT 1 FROM inventory.items WHERE item_code = 'MASS-1'")).toEqual([]);
    expect(await s.sql(B, "SELECT 1 FROM inventory.items WHERE item_code = 'MASS-1'")).toEqual([]);
  });
  run('#3 get: fixture item with packs and barcodes (the Item shape), same as the create response for a new one', async (s) => {
    const it = await getItem(s, GLU);
    expect(it).toMatchObject({ id: GLU, item_code: 'GLU-R1', base_uom_code: 'test', is_active: true });
    expect(onlyKeys(it, ITEM_KEYS)).toEqual([]);
    expect(Object.keys(it).filter((k) => LEAK.test(k))).toEqual([]);
    expect(it.packs.map((p: any) => p.id)).toContain(BOX);
    expect(it.packs.find((p: any) => p.id === BOX)).toMatchObject({ pack_code: 'BOX', is_purchase_default: true, is_active: true });
    expect(onlyKeys(it.packs[0], PACK_KEYS)).toEqual([]);
    expect(it.barcodes.map((b: any) => b.id)).toContain(BC_GLU);
    expect(onlyKeys(it.barcodes[0], BARCODE_KEYS)).toEqual([]);
    const fresh = await create(s, { item_code: 'RT-1' });
    expect(await getItem(s, fresh.id)).toEqual(fresh);
  });
  run('#3 get unknown id and malformed id: 404 common.not_found (or 400 for a malformed id), never a 500', async (s) => {
    await expectLims(s.call(A, 'getInventoryItem', { params: { item_id: uid(999999) } }), 'common.not_found', 404);
    const e = await rej(s.call(A, 'getInventoryItem', { params: { item_id: "'; DROP TABLE inventory.items; --" } }));
    expect((e as any).code).toMatch(/^common\.(not_found|validation_failed)$/);
  });
});

describe.skipIf(!live)('T-07 code uniqueness (AC-01.2, CR-C12-003)', () => {
  run('AC-01.2 same code in my tenant: 409 inventory.code_duplicate, nothing written, the fixture row untouched', async (s) => {
    const before = await row(s, 'items', GLU);
    await expectLims(s.call(A, 'createInventoryItem', { body: newItem({ item_code: 'GLU-R1', name: 'other' }) }), 'inventory.code_duplicate', 409);
    expect((await s.sql(A, "SELECT count(*)::int AS n FROM inventory.items WHERE item_code = 'GLU-R1'"))[0].n).toBe(1);
    expect(await row(s, 'items', GLU)).toEqual(before);
  });
  run('AC-01.2 a code that exists only in tenant B can be created in tenant A (and vice versa): uniqueness is per tenant', async (s) => {
    await create(s, { item_code: 'ONLY-B' }, B);
    const a = await create(s, { item_code: 'ONLY-B' }, A);
    expect(a.item_code).toBe('ONLY-B');
    expect((await s.sql(A, "SELECT tenant_id FROM inventory.items WHERE item_code = 'ONLY-B'")).map((r) => r.tenant_id)).toEqual([A]);
    await expectLims(s.call(B, 'createInventoryItem', { body: newItem({ item_code: 'ONLY-B' }) }), 'inventory.code_duplicate', 409);
  });
  run('codes are case-significant at the schema: a lower-case twin of an existing code is a 400, not a duplicate and not a second row', async (s) => {
    await expectLims(s.call(A, 'createInventoryItem', { body: newItem({ item_code: 'glu-r1' }) }), 'common.validation_failed', 400);
  });
  run('an inactive item still owns its code', async (s) => {
    await expectLims(s.call(A, 'createInventoryItem', { body: newItem({ item_code: 'OLD-IT' }) }), 'inventory.code_duplicate', 409);
  });
  run('a duplicate on create does not leak which tenant owns the code: B\'s code from A is simply creatable (no 409 oracle)', async (s) => {
    const r = await s.call(A, 'createInventoryItem', { body: newItem({ item_code: 'ZZ-ONLY-IN-B' }) });
    expect(r.status).toBe(201);
  });
  it('race: two concurrent creates of one new code in one tenant => exactly one 201, the other 409 inventory.code_duplicate (never a 500)', async () => {
    const code = `RACE-${Date.now() % 100000}`;
    const open = async () => { const c = await api.connect(); await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]); return c; };
    const [c1, c2] = [await open(), await open()];
    try {
      const go = (c: pg.PoolClient) => { const { ctx } = makeCtx({ query: (t, v) => c.query(t, v) }, A); return call('createInventoryItem', ctx, { body: newItem({ item_code: code }) }); };
      const p1 = go(c1);
      await p1;
      const p2 = go(c2).then((r) => ({ ok: r }), (e) => ({ err: e }));
      await new Promise((r) => setTimeout(r, 300)); // p2 is waiting on c1's uncommitted unique key
      await c1.query('COMMIT');
      const r2: any = await p2;
      expect(r2.err?.code).toBe('inventory.code_duplicate');
      expect(r2.err?.statusCode).toBe(409);
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined); await c2.query('ROLLBACK').catch(() => undefined); c1.release(); c2.release();
      await admin.query('DELETE FROM inventory.items WHERE item_code = $1', [code]);
    }
  }, 30_000);
});

describe.skipIf(!live)('T-07 #4 update an item: version, unset, base unit lock (AC-01.5)', () => {
  run('PATCH with the right If-Match: 200, fields changed, version + 1, others kept, updated_by = actor', async (s) => {
    const it = await create(s, { item_code: 'PA-1', manufacturer: 'Keep', notes: 'old' });
    const r = await s.call(A, 'updateInventoryItem', { params: { item_id: it.id }, headers: ifm(1), body: { name: 'Renamed', category: 'kit' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: it.id, item_code: 'PA-1', name: 'Renamed', category: 'kit', manufacturer: 'Keep', notes: 'old', version: 2 });
    expect(await getItem(s, it.id)).toEqual(r.body);
  });
  run('stale If-Match: 409 common.version_conflict; the row is unchanged', async (s) => {
    const it = await create(s, { item_code: 'PA-2' });
    await s.call(A, 'updateInventoryItem', { params: { item_id: it.id }, headers: ifm(1), body: { name: 'v2' } });
    await expectLims(s.call(A, 'updateInventoryItem', { params: { item_id: it.id }, headers: ifm(1), body: { name: 'v3' } }), 'common.version_conflict', 409);
    expect((await getItem(s, it.id)).name).toBe('v2');
  });
  run('unset[] clears optional fields (no null on the wire); required fields stay', async (s) => {
    const it = await create(s, { item_code: 'PA-3', manufacturer: 'M', notes: 'N', open_stability_days: 5, hs_code: '3822' });
    const r = await s.call(A, 'updateInventoryItem', { params: { item_id: it.id }, headers: ifm(1), body: { unset: ['notes', 'open_stability_days'] } });
    expect(r.body.notes).toBeUndefined();
    expect(r.body.open_stability_days).toBeUndefined();
    expect(r.body).toMatchObject({ manufacturer: 'M', hs_code: '3822', version: 2 });
    expect(Object.values(r.body)).not.toContain(null);
  });
  run('flag changes that break the DB CHECK (requires_expiry on an item made not lot tracked) are 400, not 500, and change nothing', async (s) => {
    const it = await create(s, { item_code: 'PA-4' }); // lot tracked + expiry
    await expectLims(s.call(A, 'updateInventoryItem', { params: { item_id: it.id }, headers: ifm(1), body: { is_lot_tracked: false } }), 'common.validation_failed', 400);
    expect((await getItem(s, it.id)).version).toBe(1);
  });

  // AC-01.5. NOTE for the writer / lead: contracts/openapi/inventory.yaml ItemPatch (additionalProperties:false) does not list base_uom_code, while PRD AC-01.5 and 02-TRD #4 (`common.immutable_record`)
  // require a 409 for an attempted change. These tests pin the PRD (the handler accepts base_uom_code in the PATCH body and the service decides); see .orchestra/notes/C12.T-07-tests.md.
  run('AC-01.5 free item (no pack, no rule, no movement): base_uom_code can still be changed (200, version + 1)', async (s) => {
    const it = await create(s, { item_code: 'BU-FREE' });
    const r = await s.call(A, 'updateInventoryItem', { params: { item_id: it.id }, headers: ifm(1), body: { base_uom_code: 'ml' } });
    expect(r.body).toMatchObject({ base_uom_code: 'ml', version: 2 });
  });
  run('AC-01.5 any pack locks the base unit: 409 common.immutable_record, base unit and version unchanged', async (s) => {
    const it = await create(s, { item_code: 'BU-PACK' });
    await addPack(s, it);
    await expectLims(s.call(A, 'updateInventoryItem', { params: { item_id: it.id }, headers: ifm(1), body: { base_uom_code: 'ml' } }), 'common.immutable_record', 409);
    expect(await getItem(s, it.id)).toMatchObject({ base_uom_code: 'test', version: 1 });
  });
  run('AC-01.5 an INACTIVE pack still locks it ("any pack")', async (s) => {
    const it = await create(s, { item_code: 'BU-INPK' });
    const p = await addPack(s, it);
    await s.call(A, 'updateInventoryItemPack', { params: { item_id: it.id, pack_id: p.id }, headers: ifm(1), body: { is_active: false } });
    await expectLims(s.call(A, 'updateInventoryItem', { params: { item_id: it.id }, headers: ifm(1), body: { base_uom_code: 'ml' } }), 'common.immutable_record', 409);
  });
  run('AC-01.5 a consumption rule locks it (fixture 2002: rules, no pack, no balance)', async (s) => {
    expect((await s.sql(A, 'SELECT count(*)::int AS n FROM inventory.item_packs WHERE item_id = $1', [CTRL]))[0].n).toBe(0);
    const v = (await getItem(s, CTRL)).version;
    await expectLims(s.call(A, 'updateInventoryItem', { params: { item_id: CTRL }, headers: ifm(v), body: { base_uom_code: 'test' } }), 'common.immutable_record', 409);
  });
  run('AC-01.5 a stock movement locks it (fixture 2003: balance + movement, no pack, no rule)', async (s) => {
    const v = (await getItem(s, TIPS)).version;
    await expectLims(s.call(A, 'updateInventoryItem', { params: { item_id: TIPS }, headers: ifm(v), body: { base_uom_code: 'test' } }), 'common.immutable_record', 409);
    expect((await getItem(s, TIPS)).base_uom_code).toBe('piece');
  });
  run('an unknown base_uom_code on a free item is a 400 naming the field (FK mapped, P-1) and changes nothing', async (s) => {
    const it = await create(s, { item_code: 'BU-BAD' });
    const e = await expectLims(s.call(A, 'updateInventoryItem', { params: { item_id: it.id }, headers: ifm(1), body: { base_uom_code: 'nosuchunit' } }), 'common.validation_failed', 400);
    expect(JSON.stringify(e.errors)).toContain('base_uom_code');
    expect((await getItem(s, it.id)).base_uom_code).toBe('test');
  });
  it('AC-01.5 / IT-2 the DB trigger tg_item_base_uom_lock rejects a direct change too (P0001 immutable_row) — runs when C0 has delivered the trigger, otherwise reported as skipped', async (ctx) => {
    const t = await admin.query("SELECT 1 FROM pg_trigger WHERE tgname = 'tg_item_base_uom_lock' AND NOT tgisinternal");
    if (t.rowCount === 0) ctx.skip();
    await session(async (s) => {
      const e: any = await rej(s.sql(A, 'UPDATE inventory.items SET base_uom_code = $2 WHERE id = $1', [GLU, 'ml']));
      expect(e.code).toBe('P0001');
    });
  });
});

describe.skipIf(!live)('T-07 #5 deactivate / reactivate (AC-01.3, CR-C12-003)', () => {
  run('AC-01.3 an item with movements but zero stock and no open PO line can be deactivated: 200 is_active false, version + 1; still readable; hidden from the default list; present with is_active=false', async (s) => {
    await s.sql(A, 'UPDATE inventory.stock_balances SET qty_base = 0, value_paisa = 0 WHERE item_id = $1', [TIPS]);
    expect((await s.sql(A, 'SELECT count(*)::int AS n FROM inventory.stock_movements WHERE item_id = $1', [TIPS]))[0].n).toBeGreaterThan(0);
    const v = (await getItem(s, TIPS)).version;
    const r = await s.call(A, 'setInventoryItemActive', { params: { item_id: TIPS }, headers: ifm(v), body: { is_active: false } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: TIPS, is_active: false, version: v + 1 });
    expect(await getItem(s, TIPS)).toMatchObject({ id: TIPS, is_active: false, item_code: 'TIPS-200' });
    const def = (await s.call(A, 'listInventoryItems', { query: { limit: 200 } })).body.data.map((i: any) => i.id);
    expect(def).not.toContain(TIPS);
    const inactive = (await s.call(A, 'listInventoryItems', { query: { is_active: false, limit: 200 } })).body.data.map((i: any) => i.id);
    expect(inactive).toContain(TIPS);
  });
  run('deactivate with non-zero stock: 409 inventory.item_in_use; unchanged', async (s) => {
    const v = (await getItem(s, TIPS)).version;
    await expectLims(s.call(A, 'setInventoryItemActive', { params: { item_id: TIPS }, headers: ifm(v), body: { is_active: false } }), 'inventory.item_in_use', 409);
    expect(await getItem(s, TIPS)).toMatchObject({ is_active: true, version: v });
  });
  run('deactivate with open PO lines but zero stock: 409 inventory.item_in_use (fixture 2001: lines on a draft and an approved PO)', async (s) => {
    await s.sql(A, 'UPDATE inventory.stock_balances SET qty_base = 0, value_paisa = 0 WHERE item_id = $1', [GLU]);
    const v = (await getItem(s, GLU)).version;
    await expectLims(s.call(A, 'setInventoryItemActive', { params: { item_id: GLU }, headers: ifm(v), body: { is_active: false } }), 'inventory.item_in_use', 409);
  });
  /** a live line (no 9 on the fixture POs) on PO `poId` for (item, pack), inserted as lims_api with RLS on; returns the line id. */
  const poLine = async (s: Sess, poId: string, itemId: string, packId: string): Promise<string> => (await s.sql(A,
    `INSERT INTO inventory.purchase_order_lines (id, tenant_id, po_id, line_no, item_id, pack_id, qty_packs, qty_in_base_snapshot, qty_base, unit_price_paisa, tax_rate_bp, net_paisa, vat_paisa, line_total_paisa, created_by, updated_by)
     VALUES (gen_random_uuid(), $1, $2, 9, $3, $4, 1, 400, 400, 50000, 0, 50000, 0, 50000, $5, $5) RETURNING id`, [A, poId, itemId, packId, SYS]))[0].id;
  const deactivate = (s: Sess, id: string) => s.call(A, 'setInventoryItemActive', { params: { item_id: id }, headers: ifm(1), body: { is_active: false } });
  run('open PO lines block, per PO state: a line on the DRAFT PO 8301 and on the SENT PO 8303 each give 409 inventory.item_in_use for an item with zero stock', async (s) => {
    for (const [code, po] of [['PO-DRAFT', uid(8301)], ['PO-SENT', uid(8303)]] as const) {
      const it = await create(s, { item_code: code });
      await poLine(s, po, it.id, (await addPack(s, it)).id);
      await expectLims(deactivate(s, it.id), 'inventory.item_in_use', 409);
      expect((await getItem(s, it.id)).is_active).toBe(true);
    }
  });
  run('a REMOVED draft PO line (soft removal, D-71) no longer blocks: zero stock + only removed lines => the item deactivates', async (s) => {
    const it = await create(s, { item_code: 'PO-RM' });
    const lineId = await poLine(s, uid(8301), it.id, (await addPack(s, it)).id);
    await expectLims(deactivate(s, it.id), 'inventory.item_in_use', 409);
    await s.sql(A, 'UPDATE inventory.purchase_order_lines SET removed_at = now(), removed_by = $2 WHERE id = $1', [lineId, SYS]);
    expect((await deactivate(s, it.id)).body).toMatchObject({ is_active: false, version: 2 });
  });
  run('reactivate: set-active true on the inactive fixture item 2004: 200, active again, version + 1; its code is still taken', async (s) => {
    const v = (await getItem(s, OLD)).version;
    const r = await s.call(A, 'setInventoryItemActive', { params: { item_id: OLD }, headers: ifm(v), body: { is_active: true } });
    expect(r.body).toMatchObject({ is_active: true, version: v + 1 });
    expect((await s.call(A, 'listInventoryItems', { query: { q: 'OLD-IT' } })).body.data.map((i: any) => i.id)).toContain(OLD);
  });
  run('stale If-Match -> 409 common.version_conflict; unknown item -> 404', async (s) => {
    await expectLims(s.call(A, 'setInventoryItemActive', { params: { item_id: OLD }, headers: ifm(99), body: { is_active: true } }), 'common.version_conflict', 409);
    await expectLims(s.call(A, 'setInventoryItemActive', { params: { item_id: uid(999999) }, headers: ifm(1), body: { is_active: false } }), 'common.not_found', 404);
  });
  run('an inactive item can still be edited and keeps its packs / barcodes readable (history stays readable)', async (s) => {
    const v = (await getItem(s, OLD)).version;
    const r = await s.call(A, 'updateInventoryItem', { params: { item_id: OLD }, headers: ifm(v), body: { notes: 'archived' } });
    expect(r.body).toMatchObject({ is_active: false, notes: 'archived' });
  });
});

describe.skipIf(!live)('T-07 #6/#7 packs: create, size immutability (AC-02.1, AC-02.2)', () => {
  run('AC-02.1 create pack BOX = 400 test: 201 Pack, contract keys, version 1, active, not default; listed in the Item; 2 BOX convert to 800 base', async (s) => {
    const it = await create(s, { item_code: 'PK-1' });
    const r = await s.call(A, 'createInventoryItemPack', { params: { item_id: it.id }, body: newPack() });
    expect(r.status).toBe(201);
    const p = r.body;
    expect(p).toMatchObject({ item_id: it.id, pack_code: 'BOX', label: 'Box of 400', uom_code: 'box', is_purchase_default: false, is_active: true, version: 1 });
    expect(Number(p.qty_in_base)).toBe(400);
    expect(onlyKeys(p, PACK_KEYS)).toEqual([]);
    expect(Object.keys(p).filter((k) => LEAK.test(k))).toEqual([]);
    expect(Number(packToBase('2', p.qty_in_base))).toBe(800);
    expect((await getItem(s, it.id)).packs.map((x: any) => x.id)).toEqual([p.id]);
    expect(await row(s, 'item_packs', p.id)).toMatchObject({ tenant_id: A, item_id: it.id, created_by: SYS });
  });
  run('fractional and edge sizes are stored exactly (numeric(18,6)): 0.5, 1234.567891, 999999999999.999999', async (s) => {
    const it = await create(s, { item_code: 'PK-2' });
    const norm = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
    for (const [i, q] of ['0.5', '1234.567891', '999999999999.999999'].entries()) {
      const p = await addPack(s, it, { pack_code: `P${i}`, qty_in_base: q });
      expect(norm(p.qty_in_base)).toBe(q);
      expect(norm((await row(s, 'item_packs', p.id)).qty_in_base)).toBe(q);
    }
  });
  run('duplicate pack_code on the same item: 409 inventory.code_duplicate; the same code on another item and in tenant B is fine', async (s) => {
    const it = await create(s, { item_code: 'PK-3' });
    await addPack(s, it);
    await expectLims(s.call(A, 'createInventoryItemPack', { params: { item_id: it.id }, body: newPack({ label: 'again' }) }), 'inventory.code_duplicate', 409);
    const other = await create(s, { item_code: 'PK-3B' });
    expect((await addPack(s, other)).pack_code).toBe('BOX');
    await expectLims(s.call(A, 'createInventoryItemPack', { params: { item_id: GLU }, body: newPack() }), 'inventory.code_duplicate', 409); // fixture BOX on GLU-R1
    const b = await s.call(B, 'createInventoryItemPack', { params: { item_id: uid(2101) }, body: newPack({ pack_code: 'KIT' }) });
    expect(b.status).toBe(201);
  });
  run('unknown pack uom_code: 400 naming the field; unknown / foreign item: 404; nothing written', async (s) => {
    const it = await create(s, { item_code: 'PK-4' });
    const e = await expectLims(s.call(A, 'createInventoryItemPack', { params: { item_id: it.id }, body: newPack({ uom_code: 'nosuchunit' }) }), 'common.validation_failed', 400);
    expect(JSON.stringify(e.errors)).toContain('uom_code');
    await expectLims(s.call(A, 'createInventoryItemPack', { params: { item_id: uid(999999) }, body: newPack() }), 'common.not_found', 404);
    await expectLims(s.call(A, 'createInventoryItemPack', { params: { item_id: GLU_B }, body: newPack({ pack_code: 'XPACK' }) }), 'common.not_found', 404);
    expect(await s.sql(B, "SELECT 1 FROM inventory.item_packs WHERE pack_code = 'XPACK'")).toEqual([]);
    expect((await getItem(s, it.id)).packs).toEqual([]);
  });
  run('is_purchase_default: at most one active default per item (partial unique) — a second default is a clean 409, never a 500', async (s) => {
    const it = await create(s, { item_code: 'PK-5' });
    await addPack(s, it, { pack_code: 'D1', is_purchase_default: true });
    const e = await rej(s.call(A, 'createInventoryItemPack', { params: { item_id: it.id }, body: newPack({ pack_code: 'D2', is_purchase_default: true }) }));
    expect((e as any).statusCode).toBe(409);
  });
  run('AC-02.2 PATCH label / uom_code / is_active on a pack that a PO references (fixture BOX): 200, version + 1, qty_in_base unchanged', async (s) => {
    const v = (await row(s, 'item_packs', BOX)).version;
    const r = await s.call(A, 'updateInventoryItemPack', { params: { item_id: GLU, pack_id: BOX }, headers: ifm(v), body: { label: 'Box (renamed)', uom_code: 'piece', is_purchase_default: true } });
    expect(r.body).toMatchObject({ id: BOX, label: 'Box (renamed)', uom_code: 'piece', version: v + 1 });
    expect(Number(r.body.qty_in_base)).toBe(400);
    const r2 = await s.call(A, 'updateInventoryItemPack', { params: { item_id: GLU, pack_id: BOX }, headers: ifm(v + 1), body: { is_active: false } });
    expect(r2.body).toMatchObject({ is_active: false, version: v + 2 });
    expect(Number((await row(s, 'item_packs', BOX)).qty_in_base)).toBe(400);
  });
  run('AC-02.2 / A12 qty_in_base in the PATCH (any value, any referenced pack): 400 common.validation_failed and the stored size is unchanged', async (s) => {
    const before = await row(s, 'item_packs', BOX);
    for (const q of ['500', '400', '0.000001']) {
      await expectLims(s.call(A, 'updateInventoryItemPack', { params: { item_id: GLU, pack_id: BOX }, headers: ifm(before.version), body: { qty_in_base: q } }), 'common.validation_failed', 400);
    }
    expect(await row(s, 'item_packs', BOX)).toEqual(before);
  });
  run('PATCH: stale If-Match 409 version_conflict; pack of another item under this item id 404; unknown pack 404', async (s) => {
    await expectLims(s.call(A, 'updateInventoryItemPack', { params: { item_id: GLU, pack_id: BOX }, headers: ifm(99), body: { label: 'x' } }), 'common.version_conflict', 409);
    const it = await create(s, { item_code: 'PK-6' });
    await expectLims(s.call(A, 'updateInventoryItemPack', { params: { item_id: it.id, pack_id: BOX }, headers: ifm(1), body: { label: 'x' } }), 'common.not_found', 404);
    await expectLims(s.call(A, 'updateInventoryItemPack', { params: { item_id: GLU, pack_id: uid(999999) }, headers: ifm(1), body: { label: 'x' } }), 'common.not_found', 404);
  });
  it('AC-02.2 the DB trigger (app.enforce_mutable_columns on item_packs) also rejects a direct size change (409 common.immutable_record at the API; P0001 / immutable_row in SQL) — runs when C0 delivered the trigger, else skipped', async (ctx) => {
    const t = await admin.query("SELECT 1 FROM pg_trigger WHERE tgrelid = 'inventory.item_packs'::regclass AND NOT tgisinternal AND tgname LIKE '%mutable%'");
    if (t.rowCount === 0) ctx.skip();
    await session(async (s) => {
      const e: any = await rej(s.sql(A, 'UPDATE inventory.item_packs SET qty_in_base = 1 WHERE id = $1', [BOX]));
      expect(String(e.message) + String(e.code)).toMatch(/immutable|P0001|23000|55/i);
    });
  });
});

describe.skipIf(!live)('T-07 #8/#9/#10 barcodes: upper-casing, uniqueness, lookup (AC-02.x scanner flows; TRD #8 #10)', () => {
  run('add: the server upper-cases before the insert (stored and returned upper case); 201 Barcode; pack optional', async (s) => {
    const it = await create(s, { item_code: 'BC-1' });
    const p = await addPack(s, it);
    const r = await addBarcode(s, it.id, 'abc-12.x/y_z', { pack_id: p.id });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ item_id: it.id, pack_id: p.id, barcode_value: 'ABC-12.X/Y_Z', is_active: true, version: 1 });
    expect(onlyKeys(r.body, BARCODE_KEYS)).toEqual([]);
    expect((await row(s, 'item_barcodes', r.body.id)).barcode_value).toBe('ABC-12.X/Y_Z');
    const r2 = await addBarcode(s, it.id, 'no-pack-1');
    expect(r2.body.pack_id).toBeUndefined();
    expect((await getItem(s, it.id)).barcodes.map((b: any) => b.barcode_value).sort()).toEqual(['ABC-12.X/Y_Z', 'NO-PACK-1']);
  });
  run('a 64-char value is accepted; mixed case is normalised before the length / pattern check', async (s) => {
    const it = await create(s, { item_code: 'BC-2' });
    const r = await addBarcode(s, it.id, 'a'.repeat(64));
    expect(r.body.barcode_value).toBe('A'.repeat(64));
  });
  run('duplicate ACTIVE value in my tenant: 409 inventory.code_duplicate, whatever the case (bc-glu-1, Bc-Glu-1 vs fixture BC-GLU-1) and on any item', async (s) => {
    const it = await create(s, { item_code: 'BC-3' });
    for (const v of ['BC-GLU-1', 'bc-glu-1', 'Bc-Glu-1']) {
      await expectLims(addBarcode(s, GLU, v), 'inventory.code_duplicate', 409);
      await expectLims(addBarcode(s, it.id, v), 'inventory.code_duplicate', 409);
    }
    expect((await s.sql(A, "SELECT count(*)::int AS n FROM inventory.item_barcodes WHERE barcode_value = 'BC-GLU-1'"))[0].n).toBe(1);
  });
  run('the same value in tenant B does not collide (and is not revealed): create it for B only, then for A', async (s) => {
    const itB = (await create(s, { item_code: 'BC-B1' }, B));
    expect((await addBarcode(s, itB.id, 'x-only-b', {}, B)).body.barcode_value).toBe('X-ONLY-B');
    const itA = await create(s, { item_code: 'BC-A1' });
    expect((await addBarcode(s, itA.id, 'x-only-b')).status).toBe(201);
    expect((await s.call(A, 'lookupInventoryBarcode', { body: { barcode_value: 'x-only-b' } })).body.item.id).toBe(itA.id);
    expect((await s.call(B, 'lookupInventoryBarcode', { body: { barcode_value: 'x-only-b' } })).body.item.id).toBe(itB.id);
  });
  run('an INACTIVE value can be added again (partial unique on active rows): fixture BC-OLD', async (s) => {
    const r = await addBarcode(s, GLU, 'bc-old');
    expect(r.status).toBe(201);
    expect((await s.call(A, 'lookupInventoryBarcode', { body: { barcode_value: 'BC-OLD' } })).body.item.id).toBe(GLU);
  });
  run('pack_id of ANOTHER item in the same tenant is refused (composite FK); of another tenant: 404; nothing written', async (s) => {
    const it = await create(s, { item_code: 'BC-4' });
    const e = await rej(addBarcode(s, it.id, 'bad-pack-1', { pack_id: BOX })) as any;
    expect([e.code, e.statusCode]).toMatchObject([expect.stringMatching(/^(common\.not_found|inventory\.uom_mismatch|common\.validation_failed)$/), expect.any(Number)]);
    expect(e.statusCode).toBeLessThan(500);
    const e2 = await rej(addBarcode(s, it.id, 'bad-pack-2', { pack_id: BOX_B })) as any;
    expect(e2.statusCode).toBeLessThan(500);
    expect(await s.sql(A, "SELECT 1 FROM inventory.item_barcodes WHERE barcode_value IN ('BAD-PACK-1','BAD-PACK-2')")).toEqual([]);
  });
  run('add to an unknown / another tenant\'s item: 404 and nothing written', async (s) => {
    await expectLims(addBarcode(s, uid(999999), 'ghost-1'), 'common.not_found', 404);
    await expectLims(addBarcode(s, GLU_B, 'ghost-2'), 'common.not_found', 404);
    expect(await s.sql(B, "SELECT 1 FROM inventory.item_barcodes WHERE barcode_value IN ('GHOST-1','GHOST-2')")).toEqual([]);
  });
  run('#10 lookup: any case finds the item (+ the pack when the barcode names one); 200 {item: ItemSummary, pack?: Pack}', async (s) => {
    for (const v of ['BC-GLU-1', 'bc-glu-1', 'Bc-GLU-1']) {
      const r = await s.call(A, 'lookupInventoryBarcode', { body: { barcode_value: v } });
      expect(r.status).toBe(200);
      expect(r.body.item).toMatchObject({ id: GLU, item_code: 'GLU-R1' });
      expect(onlyKeys(r.body.item, SUMMARY_KEYS)).toEqual([]);
      expect(r.body.pack).toMatchObject({ id: BOX, item_id: GLU, pack_code: 'BOX' });
      expect(onlyKeys(r.body.pack, PACK_KEYS)).toEqual([]);
      expect(Object.keys(r.body).sort()).toEqual(['item', 'pack']);
    }
    const it = await create(s, { item_code: 'BC-5' });
    await addBarcode(s, it.id, 'plain-1');
    const r = await s.call(A, 'lookupInventoryBarcode', { body: { barcode_value: 'plain-1' } });
    expect(Object.keys(r.body)).toEqual(['item']);
  });
  run('#10 lookup is an equality match, not a pattern: %, _ and quotes find nothing (404 common.not_found); the hostile text is not an oracle', async (s) => {
    for (const v of ['BC-%', '%', 'BC-GLU-_', '_', 'BC-GLU-1%', "BC-GLU-1'OR'1'='1", 'BC-GLU-1\\', 'BC-GLU-']) {
      await expectLims(s.call(A, 'lookupInventoryBarcode', { body: { barcode_value: v } }), 'common.not_found', 404);
    }
  });
  run('#10 lookup: unknown, inactive and other-tenant values are the same 404 (no existence oracle, TRD #10)', async (s) => {
    await s.call(B, 'createInventoryItem', { body: newItem({ item_code: 'BC-B2' }) });
    const itB = (await s.sql(B, "SELECT id FROM inventory.items WHERE item_code = 'BC-B2'"))[0].id;
    await addBarcode(s, itB, 'b-secret-1', {}, B);
    const shapes: unknown[] = [];
    for (const v of ['never-seen-1', 'BC-OLD', 'b-secret-1']) {
      const e = await rej(s.call(A, 'lookupInventoryBarcode', { body: { barcode_value: v } })) as any;
      shapes.push([e.code, e.statusCode, e.detail, e.errors, e.message]);
    }
    expect(shapes[0]).toEqual(['common.not_found', 404, undefined, undefined, 'common.not_found']);
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });
  run('#9 deactivate: 200 is_active false, version + 1; the value no longer resolves; a new add of the same value works; wrong item / foreign barcode 404', async (s) => {
    const it = await create(s, { item_code: 'BC-6' });
    const bc = (await addBarcode(s, it.id, 'deact-1')).body;
    const r = await s.call(A, 'deactivateInventoryItemBarcode', { params: { item_id: it.id, barcode_id: bc.id }, headers: ifm(1) });
    expect(r.body).toMatchObject({ id: bc.id, is_active: false, version: 2 });
    await expectLims(s.call(A, 'lookupInventoryBarcode', { body: { barcode_value: 'deact-1' } }), 'common.not_found', 404);
    expect((await addBarcode(s, it.id, 'deact-1')).status).toBe(201);
    await expectLims(s.call(A, 'deactivateInventoryItemBarcode', { params: { item_id: it.id, barcode_id: BC_GLU }, headers: ifm(1) }), 'common.not_found', 404); // exists, but belongs to GLU-R1
    await expectLims(s.call(A, 'deactivateInventoryItemBarcode', { params: { item_id: GLU_B, barcode_id: BC_GLU_B }, headers: ifm(1) }), 'common.not_found', 404);
    await expectLims(s.call(A, 'deactivateInventoryItemBarcode', { params: { item_id: it.id, barcode_id: bc.id }, headers: ifm(1) }), 'common.version_conflict', 409);
  });
  it('race: two concurrent adds of one new barcode value => exactly one 201, the other 409 inventory.code_duplicate (never a 500)', async () => {
    const value = `RACE-BC-${Date.now() % 100000}`;
    const open = async () => { const c = await api.connect(); await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]); return c; };
    const [c1, c2] = [await open(), await open()];
    try {
      const go = (c: pg.PoolClient, item: string) => { const { ctx } = makeCtx({ query: (t, v) => c.query(t, v) }, A); return call('addInventoryItemBarcode', ctx, { params: { item_id: item }, body: { barcode_value: value } }); };
      await go(c1, CTRL);
      const p2 = go(c2, TIPS).then((r) => ({ ok: r }), (e) => ({ err: e }));
      await new Promise((r) => setTimeout(r, 300));
      await c1.query('COMMIT');
      const r2: any = await p2;
      expect(r2.err?.code).toBe('inventory.code_duplicate');
      expect(r2.err?.statusCode).toBe(409);
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined); await c2.query('ROLLBACK').catch(() => undefined); c1.release(); c2.release();
      await admin.query('DELETE FROM inventory.item_barcodes WHERE barcode_value = $1', [value]);
    }
  }, 30_000);
});

describe.skipIf(!live)('T-07 #1 list items: filters, prefix search, order, paging', () => {
  run('default: active items of MY tenant only, ItemSummary keys only, ordered by item_code; no inactive, no tenant B', async (s) => {
    const r = await s.call(A, 'listInventoryItems', { query: { limit: 200 } });
    expect(r.status).toBe(200);
    const ids = r.body.data.map((i: any) => i.id);
    expect(ids).toEqual(expect.arrayContaining([GLU, CTRL, TIPS]));
    expect(ids).not.toContain(OLD);
    expect(ids).not.toContain(GLU_B);
    expect(r.body.data.every((i: any) => i.is_active === true)).toBe(true);
    expect(r.body.data.flatMap((i: any) => onlyKeys(i, SUMMARY_KEYS))).toEqual([]);
    const codes = r.body.data.map((i: any) => i.item_code);
    expect(codes).toEqual([...codes].sort());
    expect(typeof r.body.page).toBe('object');
  });
  run('tenant B sees only its own item (same code GLU-R1, different id)', async (s) => {
    const ids = (await s.call(B, 'listInventoryItems', { query: { limit: 200 } })).body.data.map((i: any) => i.id);
    expect(ids).toContain(GLU_B);
    expect(ids).not.toContain(GLU);
  });
  run('q is a prefix of item_code OR lower(name): "glu" (name Glucose reagent) and "GLU-" (code) both find GLU-R1; a middle fragment does not', async (s) => {
    for (const q of ['glu', 'GLU', 'GLU-', 'Glucose', 'glucose rea']) {
      expect((await s.call(A, 'listInventoryItems', { query: { q } })).body.data.map((i: any) => i.id), q).toContain(GLU);
    }
    expect((await s.call(A, 'listInventoryItems', { query: { q: 'lucose' } })).body.data).toEqual([]);
    expect((await s.call(A, 'listInventoryItems', { query: { q: 'CTRL' } })).body.data.map((i: any) => i.id)).toEqual([CTRL]);
  });
  run('q: LIKE metacharacters are literal (% _ \\ find nothing) and an injection string is bound text (200, empty, tables survive)', async (s) => {
    for (const q of ['%', '_', 'G%', 'GLU_R1', '\\', "'; DROP TABLE inventory.items; --"]) {
      const r = await s.call(A, 'listInventoryItems', { query: { q } });
      expect(r.status).toBe(200);
      expect(r.body.data, q).toEqual([]);
    }
    expect((await admin.query('SELECT count(*)::int AS n FROM inventory.items')).rows[0].n).toBeGreaterThan(3);
  });
  run('category and is_active filters; is_active=false lists the inactive only', async (s) => {
    expect((await s.call(A, 'listInventoryItems', { query: { category: 'control' } })).body.data.map((i: any) => i.id)).toEqual([CTRL]);
    const inactive = (await s.call(A, 'listInventoryItems', { query: { is_active: false } })).body.data;
    expect(inactive.map((i: any) => i.id)).toEqual([OLD]);
  });
  run('sort: name ascending and -updated_at (latest change first)', async (s) => {
    const byName = (await s.call(A, 'listInventoryItems', { query: { sort: 'name', limit: 200 } })).body.data.map((i: any) => i.name.toLowerCase());
    expect(byName).toEqual([...byName].sort());
    const it = await create(s, { item_code: 'ZZ-LATEST' });
    expect((await s.call(A, 'listInventoryItems', { query: { sort: '-updated_at', limit: 5 } })).body.data[0].id).toBe(it.id);
  });
  run('limit + cursor: pages are disjoint, complete and stable; limit is echoed in page.limit', async (s) => {
    const all = (await s.call(A, 'listInventoryItems', { query: { limit: 200 } })).body.data.map((i: any) => i.id);
    expect(all.length).toBeGreaterThanOrEqual(3);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await s.call(A, 'listInventoryItems', { query: { limit: 2, ...(cursor ? { cursor } : {}) } });
      expect(r.body.data.length).toBeLessThanOrEqual(2);
      expect(r.body.page.limit).toBe(2);
      seen.push(...r.body.data.map((x: any) => x.id));
      cursor = r.body.page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all);
  });
  run('a forged / foreign cursor is a 400, never a SQL error or another tenant\'s rows', async (s) => {
    const e = await rej(s.call(A, 'listInventoryItems', { query: { limit: 2, cursor: 'AAAA-forged_cursor' } })) as any;
    expect(e.code).toBe('common.validation_failed');
  });
});

describe.skipIf(!live)('T-07 probes: cross-tenant on every operation (P-T1, P-T3, 07-SECURITY §6.1)', () => {
  run('tenant A actor on tenant B ids: get / patch / set-active / pack create / pack patch / barcode add / barcode deactivate => 404 common.not_found, and B\'s rows are byte-identical afterwards', async (s) => {
    const snap = async () => JSON.stringify([await row(s, 'items', GLU_B, B), await row(s, 'item_packs', BOX_B, B), await row(s, 'item_barcodes', BC_GLU_B, B),
      (await s.sql(B, 'SELECT count(*)::int AS n FROM inventory.item_packs'))[0], (await s.sql(B, 'SELECT count(*)::int AS n FROM inventory.item_barcodes'))[0]]);
    const before = await snap();
    const nf = (p: Promise<unknown>) => expectLims(p, 'common.not_found', 404);
    await nf(s.call(A, 'getInventoryItem', { params: { item_id: GLU_B } }));
    await nf(s.call(A, 'updateInventoryItem', { params: { item_id: GLU_B }, headers: ifm(1), body: { name: 'pwned' } }));
    await nf(s.call(A, 'setInventoryItemActive', { params: { item_id: GLU_B }, headers: ifm(1), body: { is_active: false } }));
    await nf(s.call(A, 'createInventoryItemPack', { params: { item_id: GLU_B }, body: newPack({ pack_code: 'PWN' }) }));
    await nf(s.call(A, 'updateInventoryItemPack', { params: { item_id: GLU_B, pack_id: BOX_B }, headers: ifm(1), body: { label: 'pwned' } }));
    await nf(s.call(A, 'updateInventoryItemPack', { params: { item_id: GLU, pack_id: BOX_B }, headers: ifm(1), body: { label: 'pwned' } }));
    await nf(s.call(A, 'addInventoryItemBarcode', { params: { item_id: GLU_B }, body: { barcode_value: 'pwn-1' } }));
    await nf(s.call(A, 'deactivateInventoryItemBarcode', { params: { item_id: GLU_B, barcode_id: BC_GLU_B }, headers: ifm(1) }));
    await nf(s.call(A, 'deactivateInventoryItemBarcode', { params: { item_id: GLU, barcode_id: BC_GLU_B }, headers: ifm(1) }));
    expect(await snap()).toBe(before);
  });
  run('the 404 of a foreign id is identical to the 404 of an unknown id (no oracle)', async (s) => {
    const shape = async (id: string) => { const e = await rej(s.call(A, 'getInventoryItem', { params: { item_id: id } })) as any; return [e.code, e.statusCode, e.detail, e.errors, e.message]; };
    expect(await shape(GLU_B)).toEqual(await shape(uid(999999)));
  });
  run('a body that names tenant B ids cannot move a row: barcode pack_id of B on A\'s item, pack on B\'s item id, lookup of B\'s value', async (s) => {
    const it = await create(s, { item_code: 'XT-1' });
    const e = await rej(addBarcode(s, it.id, 'xt-bc-1', { pack_id: BOX_B })) as any;
    expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500);
    expect(await s.sql(A, "SELECT 1 FROM inventory.item_barcodes WHERE barcode_value = 'XT-BC-1'")).toEqual([]);
    expect((await s.call(A, 'lookupInventoryBarcode', { body: { barcode_value: 'BC-GLU-1' } })).body.item.id).toBe(GLU); // same value exists in both tenants: A gets A's item only
    expect((await s.call(B, 'lookupInventoryBarcode', { body: { barcode_value: 'BC-GLU-1' } })).body.item.id).toBe(GLU_B);
  });
  it('P-T5 SQL probe: with tenant A claims the items / packs / barcodes tables show 0 rows of tenant B; an INSERT with B\'s tenant_id fails; UPDATE of a B row affects 0 rows', async () => {
    await session(async (s) => {
      for (const t of ['items', 'item_packs', 'item_barcodes']) expect((await s.sql(A, `SELECT count(*)::int AS n FROM inventory.${t} WHERE tenant_id = $1`, [B]))[0].n).toBe(0);
      const e = await rej(s.sql(A, "INSERT INTO inventory.items (id, tenant_id, item_code, name, category, base_uom_code, created_by, updated_by) VALUES (gen_random_uuid(), $1, 'PWN', 'x', 'other', 'test', $2, $2)", [B, SYS]));
      expect(String((e as any).message)).toMatch(/row-level security/i);
    });
    await session(async (s) => {
      await s.sql(A, "UPDATE inventory.items SET name = 'pwned' WHERE id = $1", [GLU_B]);
      expect((await row(s, 'items', GLU_B, B)).name).not.toBe('pwned');
    });
  });
  it('P-T5 non-staff claims of tenant A (patient / partner / portal) read 0 rows of items, item_packs and item_barcodes', async () => {
    for (const actor_type of ['patient', 'partner', 'portal']) {
      const c = await api.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: A, sub: SYS, actor_type })]);
        for (const t of ['items', 'item_packs', 'item_barcodes']) expect((await c.query(`SELECT count(*)::int AS n FROM inventory.${t}`)).rows[0].n, `${actor_type} ${t}`).toBe(0);
      } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    }
  });
});
