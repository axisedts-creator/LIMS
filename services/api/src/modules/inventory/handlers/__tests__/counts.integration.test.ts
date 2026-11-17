// C12.T-14 integration + probes for #63-#68 on the migrated database as role lims_api with RLS on (REAL T-03 repositories, handlers/index.ts, T-04 scope service, T-05 ledger).
// Harness: tests/db/c12-t14/run.sh (clone of c12-t13: pinned image, migrations, seeds, inventory DDL, exports LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL / LIMS_C12T03_REQUIRE_DB=1).
// Fixtures: tests/db/c12-t03/fixtures.sql (stores 1001 / 1002, counts 8901 open (store 1001) 8902 posted (1002) 8903 cancelled (1001), lines 8921 8922; tenant B store 1101, count 8911 open, line 8931)
//   + EXTRAS below (ids 15xxx, committed once with the superuser, ON CONFLICT DO NOTHING).
// Each test = one request-shaped transaction that is ROLLED BACK; every handler call runs inside a SAVEPOINT. The race tests commit (fresh documents, own stores / lots) and never touch other fixtures.
// Without the URLs the DB tests skip, except under LIMS_C12T03_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails.
// EXTRAS (tenant A): stores K1 (BR1, the counted store) K2 (BR2) K3 (BR1, empty) K4 / K5 / K6 (BR1, race stores), all is_default_consumption = false.
//   items KR (reagent, lot tracked) KC (consumable, NOT lot tracked) KK (kit, lot tracked) KZ (reagent, only a zero row) KN (reagent, lot LN has no row at K1). Reason adjustment/found_stock.
//   Balances at K1: KR/LA 10 units worth 1000 (100 paisa each), KR/LB 20 worth 4000, KC unlotted 5 worth 500, KK/LK 8 worth 800, KZ/LZ 0 / 0 (a zero row never becomes a count line). K2: KR/LA 7 worth 700.
//   K5: KR/LP 10 worth 1000. K6: KR/LQ 10 worth 1000.
// TIME. T0 = three hours ago; the count is opened with the frozen clock at(0); movements are posted through the REAL ledger with occurred_at = at(minutes) so "movements up to counted_at" is exact.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ledger from '../../service/ledger.service.js';
import {
  A, ADJUST, B, BOOK_KEYS, BR1, BR2, COST, COUNT_KEYS, COUNT_NO, LEAK, LINE_KEYS, MANAGE, READ, SUMMARY_KEYS, SYS, addDays, call, cLine, expectLims, ifm, makeLeadCtx, onlyKeys, openBody, postBody, qty,
  recBody, uid, ymdIn, type LotOpts,
} from './counts.helpers.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

// fixtures (T-03)
const MAIN = uid(1001), CNT_OPEN = uid(8901), CNT_POSTED = uid(8902), CNT_CANCELLED = uid(8903), MAIN_B = uid(1101), CNT_B = uid(8911);
// extras
const KT = 'Asia/Kathmandu';
const K1 = uid(15001), K2 = uid(15002), K3 = uid(15003), K4 = uid(15004), K5 = uid(15005), K6 = uid(15006), K7 = uid(15007);
const KR = uid(15101), KC = uid(15102), KK = uid(15103), KZ = uid(15104), KN = uid(15105);
const LA = uid(15201), LB = uid(15202), LK = uid(15203), LZ = uid(15204), LN = uid(15205), LP = uid(15206), LQ = uid(15207), LR = uid(15208);
const BR1_ONLY: LotOpts = { all: false, branchIds: [BR1] };
const BR2_ONLY: LotOpts = { all: false, branchIds: [BR2] };
const KEEP: LotOpts = { permissions: [READ, MANAGE] };            // blind: no stock.adjust
const LEAD_COST: LotOpts = { permissions: [READ, MANAGE, ADJUST, COST] };
const T0 = Date.now() - 3 * 3_600_000;
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

const lots: [string, string, string][] = [[LA, KR, 'T14-LA'], [LB, KR, 'T14-LB'], [LK, KK, 'T14-LK'], [LZ, KZ, 'T14-LZ'], [LN, KR, 'T14-LN'], [LP, KR, 'T14-LP'], [LQ, KR, 'T14-LQ'], [LR, KR, 'T14-LR']];
// id, store, item, lot, qty, value
const balances: [string, string, string, string | null, number, number][] = [
  [uid(15501), K1, KR, LA, 10, 1000], [uid(15502), K1, KR, LB, 20, 4000], [uid(15503), K1, KC, null, 5, 500], [uid(15504), K1, KK, LK, 8, 800], [uid(15505), K1, KZ, LZ, 0, 0],
  [uid(15506), K2, KR, LA, 7, 700], [uid(15507), K5, KR, LP, 10, 1000], [uid(15508), K6, KR, LQ, 10, 1000], [uid(15509), K7, KR, LR, 10, 1000],
];
const q = (v: string | null) => (v === null ? 'NULL' : `'${v}'`);
const EXTRAS = `
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT set_config('request.jwt.claims', '{"tenant_id":"${A}","sub":"${SYS}","actor_type":"system"}', true);
INSERT INTO inventory.g_cs_reasons (id, reason_group, code, display) VALUES ('${uid(15601)}', 'adjustment', 'found_stock', 'Found stock'), ('${uid(15602)}', 'count_variance', 'count_variance', 'Count variance') ON CONFLICT DO NOTHING;
INSERT INTO inventory.stores (id, tenant_id, branch_id, store_code, name, store_kind, is_default_consumption, is_active, created_by, updated_by) VALUES
  ('${K1}', '${A}', '${BR1}', 'T14-K1', 'Store T14-K1', 'main', false, true, '${SYS}', '${SYS}'), ('${K2}', '${A}', '${BR2}', 'T14-K2', 'Store T14-K2', 'main', false, true, '${SYS}', '${SYS}'),
  ('${K3}', '${A}', '${BR1}', 'T14-K3', 'Store T14-K3', 'bench', false, true, '${SYS}', '${SYS}'), ('${K4}', '${A}', '${BR1}', 'T14-K4', 'Store T14-K4', 'bench', false, true, '${SYS}', '${SYS}'),
  ('${K5}', '${A}', '${BR1}', 'T14-K5', 'Store T14-K5', 'bench', false, true, '${SYS}', '${SYS}'), ('${K6}', '${A}', '${BR1}', 'T14-K6', 'Store T14-K6', 'bench', false, true, '${SYS}', '${SYS}'),
  ('${K7}', '${A}', '${BR1}', 'T14-K7', 'Store T14-K7', 'bench', false, true, '${SYS}', '${SYS}')
  ON CONFLICT DO NOTHING;
INSERT INTO inventory.items (id, tenant_id, item_code, name, category, base_uom_code, is_lot_tracked, requires_expiry, open_stability_days, created_by, updated_by) VALUES
  ('${KR}', '${A}', 'T14-KR', 'T14 reagent', 'reagent', 'test', true, false, NULL, '${SYS}', '${SYS}'), ('${KC}', '${A}', 'T14-KC', 'T14 consumable', 'consumable', 'test', false, false, NULL, '${SYS}', '${SYS}'),
  ('${KK}', '${A}', 'T14-KK', 'T14 kit', 'kit', 'test', true, false, NULL, '${SYS}', '${SYS}'), ('${KZ}', '${A}', 'T14-KZ', 'T14 zero', 'reagent', 'test', true, false, NULL, '${SYS}', '${SYS}'),
  ('${KN}', '${A}', 'T14-KN', 'T14 new', 'reagent', 'test', true, false, NULL, '${SYS}', '${SYS}') ON CONFLICT DO NOTHING;
INSERT INTO inventory.lots (id, tenant_id, item_id, lot_no, expiry_on, status, status_reason_code, created_by, updated_by) VALUES
${lots.map((l) => `  ('${l[0]}', '${A}', '${l[1]}', '${l[2]}', '${addDays(ymdIn(KT), 90)}', 'available', NULL, '${SYS}', '${SYS}')`).join(',\n')} ON CONFLICT DO NOTHING;
INSERT INTO inventory.stock_balances (id, tenant_id, store_id, item_id, lot_id, qty_base, value_paisa, last_movement_at, created_by, updated_by) VALUES
${balances.map((b) => `  ('${b[0]}', '${A}', '${b[1]}', '${b[2]}', ${q(b[3])}, ${b[4]}, ${b[5]}, now(), '${SYS}', '${SYS}')`).join(',\n')} ON CONFLICT DO NOTHING;
COMMIT;`;

let api: pg.Pool;
let admin: pg.Pool;
beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 8 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c12-t03/fixtures.sql', import.meta.url)), 'utf8'));
  await admin.query(EXTRAS);
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-14 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

interface Sess {
  call(t: string, op: string, req?: Parameters<typeof call>[2], o?: LotOpts): Promise<{ status: number; body: any }>;
  sql(t: string, text: string, v?: unknown[]): Promise<any[]>;
  /** consume through the REAL ledger (automatic consumption never waits on a count lock). */
  consume(store: string, item: string, lot: string | null, n: number, min: number): Promise<void>;
  /** goods receipt through the REAL ledger at occurred_at = at(min). */
  receive(store: string, item: string, lot: string | null, n: number, min: number): Promise<void>;
  roleCalls: any[];
}
const claims = (t: string) => JSON.stringify({ tenant_id: t, sub: SYS, actor_type: 'system' });
type Client = pg.PoolClient;
function sessionOn(client: Client): Sess {
  let n = 0;
  const roleCalls: any[] = [];
  const tx = { query: (t: string, v?: unknown[]) => client.query(t, v) };
  const setClaims = (t: string) => client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]);
  return {
    roleCalls,
    async sql(t, text, v) { await setClaims(t); return (await client.query(text, v)).rows; },
    async call(t, op, req, o) {
      await setClaims(t);
      const st = makeLeadCtx(tx, t, o ?? {});
      const sp = `t14_h${++n}`;
      await client.query(`SAVEPOINT ${sp}`);
      try { const r = await call(op, st.ctx, req); roleCalls.push(...st.roleCalls); await client.query(`RELEASE SAVEPOINT ${sp}`); return r; }
      catch (e) { roleCalls.push(...st.roleCalls); await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
    },
    async consume(store, item, lot, n, min) {
      await setClaims(A);
      const occurred = at(min);
      await ledger.post({ tx, tenantId: A, actorId: SYS }, {
        doc_type: 'consumption_fact', doc_id: uid(900000 + Math.floor(Math.random() * 90000)), occurred_at: occurred, business_date: ymdIn(KT, new Date(occurred)),
        movements: [{ store_id: store, item_id: item, lot_id: lot, kind: 'consume_fixed', qty_base: `-${n}` }],
      });
    },
    async receive(store, item, lot, n, min) {
      await setClaims(A);
      const occurred = at(min);
      await ledger.post({ tx, tenantId: A, actorId: SYS }, {
        doc_type: 'goods_receipt', doc_id: uid(900000 + Math.floor(Math.random() * 90000)), occurred_at: occurred, business_date: ymdIn(KT, new Date(occurred)),
        movements: [{ store_id: store, item_id: item, lot_id: lot, kind: 'receive', qty_base: `${n}`, value_hint: n * 100 }],
      });
    },
  };
}
async function session<T>(fn: (s: Sess) => Promise<T>): Promise<T> {
  const client = await api.connect();
  try { await client.query('BEGIN'); return await fn(sessionOn(client)); } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}
const run = (name: string, fn: (s: Sess) => Promise<void>) => it(name, () => session(fn));
/** A whole request transaction that COMMITS (race tests only). */
async function committed<T>(fn: (s: Sess) => Promise<T>): Promise<T> {
  const client = await api.connect();
  try { await client.query('BEGIN'); const r = await fn(sessionOn(client)); await client.query('COMMIT'); return r; } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
}

// ------------------------------------------------------------------ small helpers
const nf = (p: Promise<unknown>) => expectLims(p, 'common.not_found', 404);
const forbidden = (p: Promise<unknown>) => expectLims(p, 'auth.forbidden', 403);
const invalid = (p: Promise<unknown>) => expectLims(p, 'inventory.document_invalid_transition', 409);
const openC = async (s: Sess, store = K1, o?: LotOpts, over: Record<string, unknown> = {}) => (await s.call(A, 'openStockCount', { body: openBody(store, over) }, o)).body;
const getC = (s: Sess, id: string, o?: LotOpts, t = A, query: Record<string, unknown> = {}) => s.call(t, 'getStockCount', { params: { count_id: id }, query }, o);
const rec = (s: Sess, id: string, lines: Record<string, unknown>[], o?: LotOpts, t = A) => s.call(t, 'recordStockCountLines', { params: { count_id: id }, body: recBody(lines) }, o);
const dbCount = async (s: Sess, id: string, t = A) => (await s.sql(t, 'SELECT * FROM inventory.stock_counts WHERE id = $1', [id]))[0];
const dbLines = (s: Sess, id: string, t = A) => s.sql(t, 'SELECT * FROM inventory.stock_count_lines WHERE count_id = $1 ORDER BY created_at, id', [id]);
const dbLine = async (s: Sess, id: string, item: string, lot: string | null) => (await s.sql(A, 'SELECT * FROM inventory.stock_count_lines WHERE count_id = $1 AND item_id = $2 AND lot_id IS NOT DISTINCT FROM $3::uuid', [id, item, lot]))[0];
const version = async (s: Sess, id: string) => (await dbCount(s, id)).version as number;
const post = async (s: Sess, id: string, policy: 'skip' | 'zero' = 'skip', o?: LotOpts, v?: number) =>
  s.call(A, 'postStockCount', { params: { count_id: id }, headers: ifm(v ?? await version(s, id)), body: postBody(policy) }, o);
const cancelC = async (s: Sess, id: string, o?: LotOpts, v?: number) => s.call(A, 'cancelStockCount', { params: { count_id: id }, headers: ifm(v ?? await version(s, id)) }, o);
const lineOf = (body: any, item: string, lot: string | null) => (body.lines as any[]).find((l) => l.item_id === item && (l.lot_id ?? null) === lot);
const moves = async (s: Sess, doc: string) => (await s.sql(A, `SELECT movement_kind AS kind, store_id, item_id, lot_id, qty_base::text AS q, value_paisa::text AS v, reason_code, doc_type, doc_line_id FROM inventory.stock_movements
  WHERE tenant_id = $1 AND doc_id = $2 ORDER BY created_at, qty_base`, [A, doc])).map((m: any) => ({ ...m, qn: Number(m.q), vn: Number(m.v) }));
const bal = async (s: Sess, store: string, item: string, lot: string | null) => {
  const r = (await s.sql(A, 'SELECT qty_base::text AS q, value_paisa::text AS v FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id IS NOT DISTINCT FROM $4::uuid', [A, store, item, lot]))[0];
  return r ? { q: Number(r.q), v: Number(r.v) } : { q: 0, v: 0 };
};
const count = async (s: Sess, table: string, where = 'true', v: unknown[] = []) => Number((await s.sql(A, `SELECT count(*) AS n FROM inventory.${table} WHERE tenant_id = $1 AND ${where}`, [A, ...v]))[0].n);
const stockSnapshot = async (s: Sess) => JSON.stringify([await s.sql(A, 'SELECT id, qty_base, value_paisa, version FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [A]), await count(s, 'stock_movements')]);
const negAlert = async (s: Sess, store: string, item: string) => count(s, 'alerts', "alert_kind = 'negative_stock' AND store_id = $2 AND item_id = $3 AND status <> 'resolved'", [store, item]);
/** open at the frozen clock at(0), record one line, return the count. */
async function openAt0(s: Sess, store = K1) { return openC(s, store, { now: at(0) }); }
const recordOne = (s: Sess, id: string, item: string, lot: string | null, counted: string, min: number, over: Record<string, unknown> = {}) => rec(s, id, [cLine(item, counted, lot, { counted_at: at(min), ...over })]);

// ======================================================================================================== #64 open (AC-19.1)
describe.skipIf(!live)('T-14 #64 openStockCount (AC-19.1)', () => {
  run('AC-19.1 open K1: 201, open, numbered, one line per NON-ZERO (item, lot) balance with book_qty_snapshot; the zero row is skipped; NO stock effect', async (s) => {
    const before = await stockSnapshot(s);
    const r = await s.call(A, 'openStockCount', { body: openBody(K1, { notes: 'Synthetic note' }) }, undefined);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ store_id: K1, status: 'open', version: 1, notes: 'Synthetic note' });
    expect(r.body.count_no).toMatch(COUNT_NO);
    expect(Math.abs(Date.parse(r.body.snapshot_at) - Date.now())).toBeLessThan(60_000);
    expect(r.body.lines).toHaveLength(4);
    expect(qty(lineOf(r.body, KR, LA).book_qty_snapshot)).toBe(10);
    expect(qty(lineOf(r.body, KR, LB).book_qty_snapshot)).toBe(20);
    expect(qty(lineOf(r.body, KC, null).book_qty_snapshot)).toBe(5);
    expect(qty(lineOf(r.body, KK, LK).book_qty_snapshot)).toBe(8);
    expect(lineOf(r.body, KZ, LZ)).toBeUndefined();
    for (const l of r.body.lines) { expect(l.counted_qty_base ?? null).toBeNull(); expect(onlyKeys(l, LINE_KEYS)).toEqual([]); }
    expect(onlyKeys(r.body, COUNT_KEYS)).toEqual([]);
    expect(Object.keys(r.body).filter((k) => LEAK.test(k))).toEqual([]);
    expect(await dbCount(s, r.body.id)).toMatchObject({ tenant_id: A, status: 'open', created_by: SYS, store_id: K1, version: 1 });
    const db = await dbLines(s, r.body.id);
    expect(db).toHaveLength(4);
    expect(db.every((l: any) => l.counted_qty_base === null && l.counted_at === null && l.tenant_id === A)).toBe(true);
    expect(await stockSnapshot(s)).toBe(before);
  });
  run('BLIND COUNT: a store keeper (no stock.adjust) gets the lines WITHOUT book_qty_snapshot / book_qty_at_count / variance_*; the snapshot is still stored', async (s) => {
    const r = await s.call(A, 'openStockCount', { body: openBody(K1) }, KEEP);
    expect(r.body.lines).toHaveLength(4);
    for (const l of r.body.lines) for (const k of BOOK_KEYS) expect(Object.keys(l)).not.toContain(k);
    expect(JSON.stringify(r.body)).not.toMatch(/"book_qty|"variance_/);
    const g = await getC(s, r.body.id, KEEP);
    for (const l of g.body.lines) for (const k of BOOK_KEYS) expect(Object.keys(l)).not.toContain(k);
    const lead = await getC(s, r.body.id);
    expect(qty(lineOf(lead.body, KR, LA).book_qty_snapshot)).toBe(10);
    expect((await dbLines(s, r.body.id)).map((l: any) => Number(l.book_qty_snapshot)).sort((a: number, b: number) => a - b)).toEqual([5, 8, 10, 20]);
  });
  run('scope_category = kit: only the kit line (LK); a category with no stock opens an empty count', async (s) => {
    const k = await openC(s, K1, undefined, { scope_category: 'kit' });
    expect(k.scope_category).toBe('kit');
    expect(k.lines.map((l: any) => l.item_id)).toEqual([KK]);
    await cancelC(s, k.id);
    const e = await openC(s, K1, undefined, { scope_category: 'control' });
    expect(e.status).toBe('open');
    expect(e.lines).toEqual([]);
  });
  run('a store with no stock opens an empty count (K3)', async (s) => { expect((await openC(s, K3)).lines).toEqual([]); });
  run('E7 a NEGATIVE unlotted row is counted too: consumption of 7 from KC (5 on hand) leaves -2; the line has book_qty_snapshot -2', async (s) => {
    await s.consume(K1, KC, null, 7, -30);
    expect(await bal(s, K1, KC, null)).toMatchObject({ q: -2 });
    const r = await openC(s, K1);
    expect(qty(lineOf(r, KC, null).book_qty_snapshot)).toBe(-2);
  });
  run('CR-C12-003 a second open count for the same store -> 409 inventory.count_already_open, no new rows; the fixture store 1001 already has an open count', async (s) => {
    await openC(s, K1);
    const before = [await count(s, 'stock_counts'), await count(s, 'stock_count_lines')];
    await expectLims(s.call(A, 'openStockCount', { body: openBody(K1) }), 'inventory.count_already_open', 409);
    await expectLims(s.call(A, 'openStockCount', { body: openBody(MAIN) }), 'inventory.count_already_open', 409);
    expect([await count(s, 'stock_counts'), await count(s, 'stock_count_lines')]).toEqual(before);
  });
  run('two different stores can be counted at once; after a cancel the store can be counted again with a greater count_no', async (s) => {
    const a = await openC(s, K1);
    const b = await openC(s, K2);
    expect(a.id).not.toBe(b.id);
    expect(a.count_no).not.toBe(b.count_no);
    await cancelC(s, a.id);
    const c = await openC(s, K1);
    expect(c.count_no > a.count_no).toBe(true);
  });
  run('P-B2 / P-B8 scope: unknown store -> 404; a BR2 store for a BR1-only user -> 404; a BR1 user without stock.manage -> 403; nothing is written', async (s) => {
    const before = await count(s, 'stock_counts');
    await nf(s.call(A, 'openStockCount', { body: openBody(uid(99001)) }));
    await nf(s.call(A, 'openStockCount', { body: openBody(K2) }, BR1_ONLY));
    await forbidden(s.call(A, 'openStockCount', { body: openBody(K1) }, { permissions: [READ] }));
    expect(await count(s, 'stock_counts')).toBe(before);
  });
  run('the permission is asserted for the STORE\'s branch: stock.manage with branchId BR1 for K1', async (s) => {
    await openC(s, K1);
    expect(s.roleCalls).toContainEqual({ permission: MANAGE, branchId: BR1 });
  });
});

// ======================================================================================================== #63 list / #65 get
describe.skipIf(!live)('T-14 #63 listStockCounts / #65 getStockCount', () => {
  run('#63 summaries with strict keys; status and store_id filters; fixture counts are visible; tenant B\'s count never', async (s) => {
    const c = await openC(s, K1);
    const all = await s.call(A, 'listStockCounts', { query: { limit: 200 } });
    expect(all.status).toBe(200);
    const ids = all.body.data.map((x: any) => x.id);
    expect(ids).toEqual(expect.arrayContaining([c.id, CNT_OPEN, CNT_POSTED, CNT_CANCELLED]));
    expect(ids).not.toContain(CNT_B);
    for (const x of all.body.data) { expect(onlyKeys(x, SUMMARY_KEYS)).toEqual([]); expect(Object.keys(x).filter((k) => LEAK.test(k))).toEqual([]); expect(x).not.toHaveProperty('lines'); }
    const open = await s.call(A, 'listStockCounts', { query: { status: 'open', limit: 200 } });
    expect(open.body.data.every((x: any) => x.status === 'open')).toBe(true);
    expect(open.body.data.map((x: any) => x.id)).toEqual(expect.arrayContaining([c.id, CNT_OPEN]));
    const posted = await s.call(A, 'listStockCounts', { query: { status: 'posted', limit: 200 } });
    expect(posted.body.data.map((x: any) => x.id)).toContain(CNT_POSTED);
    expect(posted.body.data.map((x: any) => x.id)).not.toContain(c.id);
    const byStore = await s.call(A, 'listStockCounts', { query: { store_id: K1, limit: 200 } });
    expect(byStore.body.data.map((x: any) => x.id)).toEqual([c.id]);
  });
  run('#63 paging: limit 1 -> one row, page.limit 1 and a next_cursor; the next page continues without repeating', async (s) => {
    await openC(s, K1);
    const p1 = await s.call(A, 'listStockCounts', { query: { status: 'open', limit: 1 } });
    expect(p1.body.data).toHaveLength(1);
    expect(p1.body.page.limit).toBe(1);
    expect(p1.body.page.next_cursor).toBeTruthy();
    const p2 = await s.call(A, 'listStockCounts', { query: { status: 'open', limit: 1, cursor: p1.body.page.next_cursor } });
    expect(p2.body.data).toHaveLength(1);
    expect(p2.body.data[0].id).not.toBe(p1.body.data[0].id);
  });
  run('P-B1 a BR1-only user: lists the BR1 count, not the BR2 count; GET of the BR2 count -> 404; list with the BR2 store_id -> empty or 404', async (s) => {
    const c1 = await openC(s, K1), c2 = await openC(s, K2);
    const l = await s.call(A, 'listStockCounts', { query: { status: 'open', limit: 200 } }, BR1_ONLY);
    expect(l.body.data.map((x: any) => x.id)).toContain(c1.id);
    expect(l.body.data.map((x: any) => x.id)).not.toContain(c2.id);
    await nf(getC(s, c2.id, BR1_ONLY));
    try { expect((await s.call(A, 'listStockCounts', { query: { store_id: K2 } }, BR1_ONLY)).body.data).toEqual([]); } catch (e) { expect((e as { code?: string }).code).toBe('common.not_found'); }
    expect((await getC(s, c1.id, BR1_ONLY)).status).toBe(200);
  });
  run('#65 returns the Count with its lines; limit / cursor page the lines (lines_page.next_cursor), the pages together are every line once', async (s) => {
    const c = await openC(s, K1);
    const g = await getC(s, c.id);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ id: c.id, status: 'open', store_id: K1 });
    expect(g.body.lines).toHaveLength(4);
    expect(onlyKeys(g.body, COUNT_KEYS)).toEqual([]);
    const p1 = await getC(s, c.id, undefined, A, { limit: 3 });
    expect(p1.body.lines).toHaveLength(3);
    expect(p1.body.lines_page.next_cursor).toBeTruthy();
    const p2 = await getC(s, c.id, undefined, A, { limit: 3, cursor: p1.body.lines_page.next_cursor });
    expect(p2.body.lines).toHaveLength(1);
    expect([...p1.body.lines, ...p2.body.lines].map((l: any) => l.id).sort()).toEqual(g.body.lines.map((l: any) => l.id).sort());
  });
  run('#65 a posted / cancelled fixture count is readable; unknown id -> 404; a keeper without item.read -> 403', async (s) => {
    expect((await getC(s, CNT_POSTED)).body.status).toBe('posted');
    expect((await getC(s, CNT_CANCELLED)).body.status).toBe('cancelled');
    await nf(getC(s, uid(99010)));
    await forbidden(getC(s, CNT_POSTED, { permissions: [MANAGE] }));
  });
});

// ======================================================================================================== #66 record lines (AC-19.2 inputs)
describe.skipIf(!live)('T-14 #66 recordStockCountLines', () => {
  run('by line_id: counted_qty_base, counted_at (default = ctx.now) and counted_by are stored; the response is { updated, lines }; NO stock effect', async (s) => {
    const c = await openC(s, K1);
    const la = lineOf(c, KR, LA);
    const before = await stockSnapshot(s);
    const r = await rec(s, c.id, [{ line_id: la.id, item_id: KR, lot_id: LA, counted_qty_base: '8' }], { now: at(120) });
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(1);
    expect(r.body.lines).toHaveLength(1);
    expect(r.body.lines[0]).toMatchObject({ id: la.id, item_id: KR, lot_id: LA });
    expect(qty(r.body.lines[0].counted_qty_base)).toBe(8);
    expect(Date.parse(r.body.lines[0].counted_at)).toBe(Date.parse(at(120)));
    expect(onlyKeys(r.body, ['updated', 'lines'])).toEqual([]);
    const db = await dbLine(s, c.id, KR, LA);
    expect(db).toMatchObject({ counted_by: SYS });
    expect(Number(db.counted_qty_base)).toBe(8);
    expect(Number(db.book_qty_snapshot)).toBe(10);
    expect(await stockSnapshot(s)).toBe(before);
  });
  run('without line_id the line is found by (item_id, lot_id); an unlotted line by item only; an explicit counted_at is stored; re-recording overwrites (latest wins); 0 is a valid count', async (s) => {
    const c = await openC(s, K1);
    const r1 = await recordOne(s, c.id, KR, LB, '19', 30, { reason_code: 'found_stock' });
    expect(r1.body.lines[0].id).toBe(lineOf(c, KR, LB).id);
    expect(r1.body.lines[0].reason_code).toBe('found_stock');
    expect(Date.parse(r1.body.lines[0].counted_at)).toBe(Date.parse(at(30)));
    await recordOne(s, c.id, KR, LB, '18', 40);
    expect(Number((await dbLine(s, c.id, KR, LB)).counted_qty_base)).toBe(18);
    await rec(s, c.id, [cLine(KC, '0')]);
    expect(Number((await dbLine(s, c.id, KC, null)).counted_qty_base)).toBe(0);
    expect((await dbLine(s, c.id, KC, null)).counted_at).not.toBeNull();
    expect(await dbLines(s, c.id)).toHaveLength(4);
  });
  run('a (item, lot) pair NOT in the snapshot creates a line: book_qty_snapshot = 0 when there is no balance (lot LN)', async (s) => {
    const c = await openC(s, K1);
    const r = await rec(s, c.id, [cLine(KR, '3', LN)]);
    expect(r.body.updated).toBe(1);
    expect(Number((await dbLine(s, c.id, KR, LN)).book_qty_snapshot)).toBe(0);
    expect(Number((await dbLine(s, c.id, KR, LN)).counted_qty_base)).toBe(3);
    expect(await dbLines(s, c.id)).toHaveLength(5);
  });
  run('a pair outside the count\'s scope_category that DOES have a balance gets book_qty_snapshot = the current balance (KR/LA = 10 in a kit-only count)', async (s) => {
    const c = await openC(s, K1, undefined, { scope_category: 'kit' });
    await rec(s, c.id, [cLine(KR, '9', LA)]);
    expect(Number((await dbLine(s, c.id, KR, LA)).book_qty_snapshot)).toBe(10);
  });
  run('atomic: one bad line (unknown item / lot of another item / unknown line_id / line of ANOTHER count) -> 404 and NOTHING of the request is applied', async (s) => {
    const c = await openC(s, K1);
    const la = lineOf(c, KR, LA);
    const snap = async () => JSON.stringify(await dbLines(s, c.id));
    const before = await snap();
    await nf(rec(s, c.id, [cLine(KR, '1', LA), cLine(uid(99020), '1')]));
    await nf(rec(s, c.id, [cLine(KR, '1', LA), cLine(KC, '1', LA)]));            // LA belongs to item KR
    await nf(rec(s, c.id, [cLine(KR, '1', LA), { line_id: uid(99021), item_id: KR, lot_id: LB, counted_qty_base: '1' }]));
    await nf(rec(s, c.id, [{ line_id: uid(8921), item_id: KR, lot_id: LA, counted_qty_base: '1' }])); // fixture line of count 8901
    expect(await snap()).toBe(before);
    expect(la.id).toBeTruthy();
  });
  run('a count that is not open (posted 8902, cancelled 8903) -> 409 inventory.document_invalid_transition, nothing changes', async (s) => {
    const before = JSON.stringify([await dbLines(s, CNT_POSTED), await dbLines(s, CNT_CANCELLED)]);
    await invalid(rec(s, CNT_POSTED, [cLine(KR, '1', LA)]));
    await invalid(rec(s, CNT_CANCELLED, [cLine(KR, '1', LA)]));
    expect(JSON.stringify([await dbLines(s, CNT_POSTED), await dbLines(s, CNT_CANCELLED)])).toBe(before);
  });
  run('scope + permission: BR2-only user on the K1 count -> 404; keeper without stock.manage -> 403; read-only never writes', async (s) => {
    const c = await openC(s, K1);
    const before = JSON.stringify(await dbLines(s, c.id));
    await nf(rec(s, c.id, [cLine(KR, '1', LA)], BR2_ONLY));
    await forbidden(rec(s, c.id, [cLine(KR, '1', LA)], { permissions: [READ] }));
    expect(JSON.stringify(await dbLines(s, c.id))).toBe(before);
  });
  run('a keeper records blind: the response lines carry no book / variance keys', async (s) => {
    const c = await openC(s, K1);
    const r = await rec(s, c.id, [cLine(KR, '8', LA)], KEEP);
    for (const k of BOOK_KEYS) expect(Object.keys(r.body.lines[0])).not.toContain(k);
    expect(qty(r.body.lines[0].counted_qty_base)).toBe(8);
  });
});

// ======================================================================================================== #67 post (AC-19.2, AC-19.3)
describe.skipIf(!live)('T-14 #67 postStockCount: variance and movements (AC-19.3)', () => {
  run('AC-19.3 base: LA counted 8 of 10 -> count_adjust_out -2; LB counted 23 of 20 -> count_adjust_in +3; KC counted 5 of 5 -> no movement; LK uncounted + skip -> untouched', async (s) => {
    const c = await openC(s, K1);
    await rec(s, c.id, [cLine(KR, '8', LA), cLine(KR, '23', LB), cLine(KC, '5')]);
    const before = await bal(s, K1, KK, LK);
    const r = await post(s, c.id, 'skip', LEAD_COST);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: c.id, status: 'posted' });
    expect(Date.parse(r.body.posted_at)).toBeGreaterThan(Date.now() - 60_000);
    expect(r.body.version).toBeGreaterThan(c.version);
    const ms = await moves(s, c.id);
    expect(ms).toHaveLength(2);
    const out = ms.find((m: any) => m.kind === 'count_adjust_out'), inn = ms.find((m: any) => m.kind === 'count_adjust_in');
    expect(out).toMatchObject({ store_id: K1, item_id: KR, lot_id: LA, qn: -2, vn: -200, reason_code: 'count_variance', doc_type: 'stock_count', doc_line_id: lineOf(c, KR, LA).id });
    expect(inn).toMatchObject({ store_id: K1, item_id: KR, lot_id: LB, qn: 3, reason_code: 'count_variance', doc_type: 'stock_count', doc_line_id: lineOf(c, KR, LB).id });
    expect(inn.vn).toBeGreaterThan(0);
    expect(await bal(s, K1, KR, LA)).toMatchObject({ q: 8, v: 800 });
    expect((await bal(s, K1, KR, LB)).q).toBe(23);
    expect(await bal(s, K1, KC, null)).toMatchObject({ q: 5, v: 500 });
    expect(await bal(s, K1, KK, LK)).toEqual(before);
    // lines: book_at_count / variance set at post; uncounted + skip stays null
    const la = lineOf(r.body, KR, LA);
    expect(qty(la.book_qty_at_count)).toBe(10);
    expect(qty(la.variance_qty_base)).toBe(-2);
    expect(la.variance_value_paisa).toBe(-200);
    expect(la.reason_code).toBe('count_variance');
    expect(qty(lineOf(r.body, KC, null).variance_qty_base)).toBe(0);
    const lk = lineOf(r.body, KK, LK);
    expect(lk.variance_qty_base ?? null).toBeNull();
    expect(lk.book_qty_at_count ?? null).toBeNull();
    const db = await dbLine(s, c.id, KR, LA);
    expect(Number(db.variance_qty_base)).toBe(-2);
    expect(Number(db.variance_value_paisa)).toBe(-200);
    expect(await dbCount(s, c.id)).toMatchObject({ status: 'posted', posted_by: SYS });
    expect(Object.keys(r.body).filter((k) => LEAK.test(k))).toEqual([]);
    expect(onlyKeys(r.body, COUNT_KEYS)).toEqual([]);
  });
  run('MONEY (02-TRD §6.3): variance_value_paisa appears only with inventory.cost.read; the other variance fields appear for a stock.adjust holder', async (s) => {
    const c = await openC(s, K1);
    await rec(s, c.id, [cLine(KR, '8', LA)]);
    const r = await post(s, c.id, 'skip');
    const la = lineOf(r.body, KR, LA);
    expect(Object.keys(la)).not.toContain('variance_value_paisa');
    expect(qty(la.variance_qty_base)).toBe(-2);
    expect(qty(la.book_qty_at_count)).toBe(10);
  });
  run('a line\'s own reason is used on the line and on the movement (found_stock); the default is count_variance', async (s) => {
    const c = await openC(s, K1);
    await rec(s, c.id, [cLine(KR, '11', LA, { reason_code: 'found_stock' }), cLine(KR, '19', LB)]);
    const r = await post(s, c.id);
    const ms = await moves(s, c.id);
    expect(ms.find((m: any) => m.lot_id === LA)).toMatchObject({ kind: 'count_adjust_in', reason_code: 'found_stock', qn: 1 });
    expect(ms.find((m: any) => m.lot_id === LB)).toMatchObject({ kind: 'count_adjust_out', reason_code: 'count_variance', qn: -1 });
    expect(lineOf(r.body, KR, LA).reason_code).toBe('found_stock');
  });
  run('a count with no counted line posts: no movements, no balance change; an empty count posts', async (s) => {
    const c = await openC(s, K1);
    const before = await stockSnapshot(s);
    expect((await post(s, c.id)).body.status).toBe('posted');
    expect(await stockSnapshot(s)).toBe(before);
    const e = await openC(s, K3);
    expect((await post(s, e.id)).body.status).toBe('posted');
  });
  run('a pair found on the shelf that is NOT in the ledger: LN counted 4 (book 0) -> count_adjust_in +4 into the lot row', async (s) => {
    const c = await openC(s, K1);
    await rec(s, c.id, [cLine(KR, '4', LN)]);
    await post(s, c.id);
    const ms = await moves(s, c.id);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: 'count_adjust_in', lot_id: LN, item_id: KR, qn: 4 });
    expect((await bal(s, K1, KR, LN)).q).toBe(4);
  });
  run('E7 a count line for the negative unlotted row counted 0 -> count_adjust_in +2 clears it (D-75): the row ends at qty 0', async (s) => {
    await s.consume(K1, KC, null, 7, -30);
    const c = await openC(s, K1);
    await rec(s, c.id, [cLine(KC, '0')]);
    await post(s, c.id);
    expect((await moves(s, c.id))[0]).toMatchObject({ kind: 'count_adjust_in', item_id: KC, lot_id: null, qn: 2 });
    expect(await bal(s, K1, KC, null)).toMatchObject({ q: 0, v: 0 });
  });
});

describe.skipIf(!live)('T-14 #67 variance uses movements up to counted_at (AC-19.2)', () => {
  /** LA = 10 at snapshot at(0); automatic consumption of 3 at at(60) and 2 at at(120) continues during the count (balance ends 5). */
  async function withConsumption(s: Sess) {
    const c = await openAt0(s);
    await s.consume(K1, KR, LA, 3, 60);
    await s.consume(K1, KR, LA, 2, 120);
    return c;
  }
  run('counted at at(30), BEFORE any consumption: book_at_count 10, variance 0 vs counted 10 -> no count movement; the later consumption stays (balance 5)', async (s) => {
    const c = await withConsumption(s);
    await recordOne(s, c.id, KR, LA, '10', 30);
    const r = await post(s, c.id);
    expect(qty(lineOf(r.body, KR, LA).book_qty_at_count)).toBe(10);
    expect(qty(lineOf(r.body, KR, LA).variance_qty_base)).toBe(0);
    expect(await moves(s, c.id)).toEqual([]);
    expect((await bal(s, K1, KR, LA)).q).toBe(5);
  });
  run('counted at at(90), after the first consumption only: book_at_count 7, counted 7 -> variance 0', async (s) => {
    const c = await withConsumption(s);
    await recordOne(s, c.id, KR, LA, '7', 90);
    const r = await post(s, c.id);
    expect(qty(lineOf(r.body, KR, LA).book_qty_at_count)).toBe(7);
    expect(qty(lineOf(r.body, KR, LA).variance_qty_base)).toBe(0);
    expect(await moves(s, c.id)).toEqual([]);
  });
  run('counted at at(150), after both: book_at_count 5, counted 4 -> count_adjust_out -1; balance 4', async (s) => {
    const c = await withConsumption(s);
    await recordOne(s, c.id, KR, LA, '4', 150);
    const r = await post(s, c.id);
    expect(qty(lineOf(r.body, KR, LA).book_qty_at_count)).toBe(5);
    expect(qty(lineOf(r.body, KR, LA).variance_qty_base)).toBe(-1);
    const ms = await moves(s, c.id);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: 'count_adjust_out', lot_id: LA, qn: -1 });
    expect((await bal(s, K1, KR, LA)).q).toBe(4);
  });
  run('boundary <=: a movement exactly AT counted_at is included (counted at at(120), book 5, counted 5 -> variance 0)', async (s) => {
    const c = await withConsumption(s);
    await recordOne(s, c.id, KR, LA, '5', 120);
    const r = await post(s, c.id);
    expect(qty(lineOf(r.body, KR, LA).book_qty_at_count)).toBe(5);
    expect(qty(lineOf(r.body, KR, LA).variance_qty_base)).toBe(0);
  });
  run('boundary <: a movement exactly AT snapshot_at is part of the snapshot, not added again (consume 1 at at(0) after opening; counted 10 at at(30) -> book 10, variance 0)', async (s) => {
    const c = await openAt0(s);
    await s.consume(K1, KR, LA, 1, 0);
    await recordOne(s, c.id, KR, LA, '10', 30);
    const r = await post(s, c.id);
    expect(qty(lineOf(r.body, KR, LA).book_qty_at_count)).toBe(10);
    expect(qty(lineOf(r.body, KR, LA).variance_qty_base)).toBe(0);
  });
  run('the formula uses occurred_at, and only the SAME (store, item, lot): consumption of LB at at(60) and of LA in another store does not move LA\'s book (counted 10 at at(150) -> variance 0)', async (s) => {
    const c = await openAt0(s);
    await s.consume(K1, KR, LB, 4, 60);
    await s.consume(K2, KR, LA, 2, 60);
    await recordOne(s, c.id, KR, LA, '10', 150);
    const r = await post(s, c.id);
    expect(qty(lineOf(r.body, KR, LA).book_qty_at_count)).toBe(10);
    expect(await moves(s, c.id)).toEqual([]);
  });
  run('T-14 review #1: a pair NOT in the snapshot that receives stock after snapshot_at (LN 0 at open, +10 at at(60)) and is recorded via #66 at at(90) with counted 10: book_qty_snapshot is the balance AS OF snapshot_at (0), so book_at_count 10, variance 0, NO count movement (movements are not double counted)', async (s) => {
    const c = await openAt0(s);
    await s.receive(K1, KR, LN, 10, 60);
    expect((await bal(s, K1, KR, LN)).q).toBe(10);
    await recordOne(s, c.id, KR, LN, '10', 90);
    expect(Number((await dbLine(s, c.id, KR, LN)).book_qty_snapshot)).toBe(0);
    const r = await post(s, c.id);
    expect(qty(lineOf(r.body, KR, LN).book_qty_at_count)).toBe(10);
    expect(qty(lineOf(r.body, KR, LN).variance_qty_base)).toBe(0);
    expect(await moves(s, c.id)).toEqual([]);
    expect((await bal(s, K1, KR, LN)).q).toBe(10);
  });
  run('a counted_at-less line defaults to the clock of the record call: consumption posted AFTER it does not change the line\'s book', async (s) => {
    const c = await openAt0(s);
    await rec(s, c.id, [cLine(KR, '10', LA)], { now: at(30) });
    await s.consume(K1, KR, LA, 4, 60);
    const r = await post(s, c.id);
    expect(qty(lineOf(r.body, KR, LA).book_qty_at_count)).toBe(10);
    expect(qty(lineOf(r.body, KR, LA).variance_qty_base)).toBe(0);
  });
});

describe.skipIf(!live)('T-14 #67 negative variance larger than the lot row (AC-19.3 / AC-19.4)', () => {
  run('counted 2 at at(30) (book 10 -> variance -8), consumption of 5 continued after: Q = 5 at posting -> count_adjust_out -5 on the lot row and -3 on the UNLOTTED row; negative_stock opens; the post does not fail', async (s) => {
    const c = await openAt0(s);
    await recordOne(s, c.id, KR, LA, '2', 30);
    await s.consume(K1, KR, LA, 5, 60);
    expect((await bal(s, K1, KR, LA)).q).toBe(5);
    const r = await post(s, c.id);
    expect(r.body.status).toBe('posted');
    const ms = await moves(s, c.id);
    expect(ms).toHaveLength(2);
    expect(ms.every((m: any) => m.kind === 'count_adjust_out' && m.item_id === KR && m.store_id === K1 && m.doc_type === 'stock_count')).toBe(true);
    const lot = ms.find((m: any) => m.lot_id === LA), unl = ms.find((m: any) => m.lot_id === null);
    expect(lot.qn).toBe(-5);
    expect(unl.qn).toBe(-3);
    expect((await bal(s, K1, KR, LA)).q).toBe(0);
    expect((await bal(s, K1, KR, null)).q).toBe(-3);
    expect(await negAlert(s, K1, KR)).toBe(1);
    expect(qty(lineOf(r.body, KR, LA).book_qty_at_count)).toBe(10);
    expect(qty(lineOf(r.body, KR, LA).variance_qty_base)).toBe(-8);
    expect(Number((await dbLine(s, c.id, KR, LA)).variance_qty_base)).toBe(-8);
  });
  run('v = Q exactly (-5 vs 5 left): lot row to 0, NO unlotted movement, NO negative_stock alert', async (s) => {
    const c = await openAt0(s);
    await recordOne(s, c.id, KR, LA, '5', 30);
    await s.consume(K1, KR, LA, 5, 60);
    await post(s, c.id);
    const ms = await moves(s, c.id);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ lot_id: LA, qn: -5 });
    expect(await bal(s, K1, KR, LA)).toMatchObject({ q: 0, v: 0 });
    expect(await negAlert(s, K1, KR)).toBe(0);
  });
  run('v < Q (-2 vs 10 left): a plain count_adjust_out on the lot row, no alert', async (s) => {
    const c = await openC(s, K1);
    await rec(s, c.id, [cLine(KR, '8', LA)]);
    await post(s, c.id);
    expect(await negAlert(s, K1, KR)).toBe(0);
    expect((await moves(s, c.id))).toHaveLength(1);
  });
});

describe.skipIf(!live)('T-14 #67 uncounted policy', () => {
  run('skip: lines never counted are left alone (no movement, balance unchanged, variance stays null)', async (s) => {
    const c = await openC(s, K1);
    await rec(s, c.id, [cLine(KR, '10', LA)]);
    const before = JSON.stringify([await bal(s, K1, KR, LB), await bal(s, K1, KC, null), await bal(s, K1, KK, LK)]);
    const r = await post(s, c.id, 'skip');
    expect(await moves(s, c.id)).toEqual([]);
    expect(JSON.stringify([await bal(s, K1, KR, LB), await bal(s, K1, KC, null), await bal(s, K1, KK, LK)])).toBe(before);
    expect((await dbLine(s, c.id, KR, LB)).variance_qty_base).toBeNull();
    expect(lineOf(r.body, KR, LB).variance_qty_base ?? null).toBeNull();
  });
  run('zero: uncounted lines are counted as 0 AT POST TIME: LK 8 with 1 consumed after the snapshot (book 7) -> count_adjust_out -7; LB -20; KC -5; the counted LA is untouched', async (s) => {
    const c = await openAt0(s);
    await s.consume(K1, KK, LK, 1, 60);
    await rec(s, c.id, [cLine(KR, '10', LA, { counted_at: at(30) })]);
    const r = await post(s, c.id, 'zero');
    const ms = await moves(s, c.id);
    expect(ms).toHaveLength(3);
    expect(ms.find((m: any) => m.lot_id === LK)).toMatchObject({ kind: 'count_adjust_out', qn: -7 });
    expect(ms.find((m: any) => m.lot_id === LB)).toMatchObject({ kind: 'count_adjust_out', qn: -20 });
    expect(ms.find((m: any) => m.item_id === KC)).toMatchObject({ kind: 'count_adjust_out', lot_id: null, qn: -5 });
    expect(await bal(s, K1, KK, LK)).toMatchObject({ q: 0, v: 0 });
    expect((await bal(s, K1, KR, LB)).q).toBe(0);
    expect((await bal(s, K1, KR, LA)).q).toBe(10);
    expect(qty(lineOf(r.body, KK, LK).book_qty_at_count)).toBe(7);
    expect(qty(lineOf(r.body, KK, LK).variance_qty_base)).toBe(-7);
    expect(qty(lineOf(r.body, KK, LK).counted_qty_base)).toBe(0);
  });
  run('zero never touches a line that WAS counted, and an already-zero balance writes nothing (zero row KZ is no line)', async (s) => {
    const c = await openC(s, K1);
    await rec(s, c.id, [cLine(KR, '20', LB), cLine(KR, '10', LA), cLine(KC, '5'), cLine(KK, '8', LK)]);
    await post(s, c.id, 'zero');
    expect(await moves(s, c.id)).toEqual([]);
  });
});

// ======================================================================================================== #67 / #68 gates, transitions
describe.skipIf(!live)('T-14 #67 / #68 privilege, scope, transitions (PE-1, PE-2, P-B2, AC-19.4)', () => {
  run('PE-2 a keeper (stock.manage, no stock.adjust) -> 403 auth.forbidden; PE-1 aal1 -> 403 auth.mfa_required; nothing changes and the count stays open', async (s) => {
    const c = await openC(s, K1);
    await rec(s, c.id, [cLine(KR, '8', LA)]);
    const before = await stockSnapshot(s);
    await forbidden(post(s, c.id, 'skip', KEEP));
    await expectLims(post(s, c.id, 'skip', { aal: 'aal1' }), 'auth.mfa_required', 403);
    expect(await stockSnapshot(s)).toBe(before);
    expect((await dbCount(s, c.id)).status).toBe('open');
  });
  run('the privileged permission is asserted for the count\'s store branch: assertRole({ permission: stock.adjust, branchId: BR1 })', async (s) => {
    const c = await openC(s, K1);
    s.roleCalls.length = 0;
    await post(s, c.id);
    expect(s.roleCalls).toContainEqual({ permission: ADJUST, branchId: BR1 });
  });
  run('P-B2 / P-B8 a BR2-only user cannot post / cancel / record the K1 count and a BR1-only user cannot touch the K2 count: 404, no change', async (s) => {
    const c1 = await openC(s, K1), c2 = await openC(s, K2);
    const before = await stockSnapshot(s);
    await nf(post(s, c1.id, 'skip', BR2_ONLY));
    await nf(cancelC(s, c1.id, BR2_ONLY));
    await nf(post(s, c2.id, 'skip', BR1_ONLY));
    await nf(cancelC(s, c2.id, BR1_ONLY));
    await nf(rec(s, c2.id, [cLine(KR, '1', LA)], BR1_ONLY));
    expect(await stockSnapshot(s)).toBe(before);
    expect([(await dbCount(s, c1.id)).status, (await dbCount(s, c2.id)).status]).toEqual(['open', 'open']);
  });
  run('post twice: the second is 409 inventory.document_invalid_transition and writes nothing more; then record / cancel on the posted count are 409 too', async (s) => {
    const c = await openC(s, K1);
    await rec(s, c.id, [cLine(KR, '8', LA)]);
    const p = await post(s, c.id);
    const n = (await moves(s, c.id)).length;
    await invalid(s.call(A, 'postStockCount', { params: { count_id: c.id }, headers: ifm(p.body.version), body: postBody('skip') }));
    await invalid(rec(s, c.id, [cLine(KR, '9', LA)]));
    await invalid(cancelC(s, c.id, undefined, p.body.version));
    expect((await moves(s, c.id)).length).toBe(n);
    expect((await dbCount(s, c.id)).status).toBe('posted');
  });
  run('fixture counts: posting / cancelling the posted 8902 and the cancelled 8903 -> 409 inventory.document_invalid_transition (the transition beats a stale If-Match)', async (s) => {
    for (const id of [CNT_POSTED, CNT_CANCELLED]) {
      await invalid(s.call(A, 'postStockCount', { params: { count_id: id }, headers: ifm(999), body: postBody('skip') }));
      await invalid(s.call(A, 'cancelStockCount', { params: { count_id: id }, headers: ifm(999) }));
    }
  });
  run('stale If-Match on an open count -> 409 common.version_conflict for post and cancel; no movement, count stays open', async (s) => {
    const c = await openC(s, K1);
    await rec(s, c.id, [cLine(KR, '8', LA)]);
    const before = await stockSnapshot(s);
    await expectLims(post(s, c.id, 'skip', undefined, 999), 'common.version_conflict', 409);
    await expectLims(cancelC(s, c.id, undefined, 999), 'common.version_conflict', 409);
    expect(await stockSnapshot(s)).toBe(before);
    expect((await dbCount(s, c.id)).status).toBe('open');
  });
  run('#68 cancel: open -> cancelled, version + 1, cancelled_at / by set, NO stock effect, lines kept; the store can be counted again; cancel after cancel -> 409; post after cancel -> 409', async (s) => {
    const c = await openC(s, K1);
    await rec(s, c.id, [cLine(KR, '1', LA)]);
    const before = await stockSnapshot(s);
    const v0 = await version(s, c.id);
    const r = await cancelC(s, c.id, KEEP);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: c.id, status: 'cancelled', version: v0 + 1 });
    expect(Date.parse(r.body.cancelled_at)).toBeGreaterThan(Date.now() - 60_000);
    expect(await dbCount(s, c.id)).toMatchObject({ status: 'cancelled', cancelled_by: SYS });
    expect(await dbLines(s, c.id)).toHaveLength(4);
    expect(await stockSnapshot(s)).toBe(before);
    await invalid(cancelC(s, c.id, undefined, r.body.version));
    await invalid(post(s, c.id, 'skip', undefined, r.body.version));
    expect((await openC(s, K1)).status).toBe('open');
  });
  run('#68 needs stock.manage for the branch (a read-only user -> 403)', async (s) => {
    const c = await openC(s, K1);
    await forbidden(cancelC(s, c.id, { permissions: [READ] }));
    expect((await dbCount(s, c.id)).status).toBe('open');
  });
});

describe.skipIf(!live)('T-14 AC-19.4 count_locks_store (the count side)', () => {
  const lock = (s: Sess, on = true) => s.sql(A, 'UPDATE inventory.settings SET count_locks_store = $2 WHERE tenant_id = $1', [A, on]);
  const draft = async (s: Sess) => (await s.call(A, 'createTransfer', { body: { from_store_id: K1, to_store_id: K2, lines: [{ item_id: KR, lot_id: LA, qty: '1' }] } }, KEEP)).body;
  const dispatchT = (s: Sess, t: { id: string; version: number }) => s.call(A, 'dispatchTransfer', { params: { transfer_id: t.id }, headers: ifm(t.version) }, KEEP);
  run('lock on + open count: a manual dispatch from the store -> 409 inventory.store_locked_for_count; AUTOMATIC consumption is never blocked; posting the count itself is not blocked; afterwards the dispatch works', async (s) => {
    await lock(s);
    const t = await draft(s);
    const c = await openC(s, K1);
    await expectLims(dispatchT(s, t), 'inventory.store_locked_for_count', 409);
    await s.consume(K1, KR, LA, 1, 30);                       // automatic consumption: no throw
    expect((await bal(s, K1, KR, LA)).q).toBe(9);
    await rec(s, c.id, [cLine(KR, '8', LA)]);
    expect((await post(s, c.id)).body.status).toBe('posted');  // count_adjust_* is not a manual movement
    expect((await dispatchT(s, t)).body.status).toBe('dispatched');
  });
  run('lock on: cancelling the count lifts the lock', async (s) => {
    await lock(s);
    const t = await draft(s);
    const c = await openC(s, K1);
    await expectLims(dispatchT(s, t), 'inventory.store_locked_for_count', 409);
    await cancelC(s, c.id);
    expect((await dispatchT(s, t)).body.status).toBe('dispatched');
  });
  run('lock off (default): an open count does not block the dispatch', async (s) => {
    await lock(s, false);
    const t = await draft(s);
    await openC(s, K1);
    expect((await dispatchT(s, t)).body.status).toBe('dispatched');
  });
});

// ======================================================================================================== tenant probes (P-T1..P-T4)
describe.skipIf(!live)('T-14 probes: cross-tenant (07-SECURITY P-T1..P-T4)', () => {
  const snapB = async (s: Sess) => JSON.stringify([await dbCount(s, CNT_B, B), await dbLines(s, CNT_B, B), await s.sql(B, 'SELECT count(*) AS n FROM inventory.stock_movements WHERE tenant_id = $1', [B]),
    await s.sql(B, 'SELECT id, qty_base, value_paisa, version FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [B])]);
  run('tenant A with tenant B\'s count id: get / record / post / cancel -> 404, no row change in B', async (s) => {
    const before = await snapB(s);
    const bv = (await dbCount(s, CNT_B, B)).version;
    await nf(getC(s, CNT_B));
    await nf(rec(s, CNT_B, [cLine(KR, '1', LA)]));
    await nf(s.call(A, 'postStockCount', { params: { count_id: CNT_B }, headers: ifm(bv), body: postBody('zero') }));
    await nf(s.call(A, 'cancelStockCount', { params: { count_id: CNT_B }, headers: ifm(bv) }));
    expect(await snapB(s)).toBe(before);
  });
  run('tenant B reads its own count (its lines only); A\'s counts are 404 for B; B cannot post / cancel them', async (s) => {
    const g = await getC(s, CNT_B, undefined, B);
    expect(g.body.id).toBe(CNT_B);
    expect(g.body.lines.map((l: any) => l.id)).toEqual([uid(8931)]);
    await nf(getC(s, CNT_OPEN, undefined, B));
    await nf(s.call(B, 'postStockCount', { params: { count_id: CNT_OPEN }, headers: ifm(1), body: postBody('skip') }));
    await nf(s.call(B, 'cancelStockCount', { params: { count_id: CNT_OPEN }, headers: ifm(1) }));
  });
  run('P-T3 open in A for a B store -> 404; record a B item / lot into an A count -> 404, nothing written', async (s) => {
    const before = await count(s, 'stock_counts');
    await nf(s.call(A, 'openStockCount', { body: openBody(MAIN_B) }));
    expect(await count(s, 'stock_counts')).toBe(before);
    const c = await openC(s, K1);
    const lines = JSON.stringify(await dbLines(s, c.id));
    await nf(rec(s, c.id, [cLine(uid(2101), '1', uid(4101))]));
    await nf(rec(s, c.id, [cLine(KR, '1', uid(4101))]));
    expect(JSON.stringify(await dbLines(s, c.id))).toBe(lines);
  });
  run('P-T2 list as A never shows B\'s count, even when asking for B\'s store; list as B shows only B\'s', async (s) => {
    const a = await s.call(A, 'listStockCounts', { query: { limit: 200 } });
    expect(a.body.data.map((c: any) => c.id)).not.toContain(CNT_B);
    try { expect((await s.call(A, 'listStockCounts', { query: { store_id: MAIN_B } })).body.data).toEqual([]); } catch (e) { expect((e as { code?: string }).code).toBe('common.not_found'); }
    const b = await s.call(B, 'listStockCounts', { query: { limit: 200 } });
    expect(b.body.data.map((c: any) => c.id)).toEqual([CNT_B]);
  });
  run('a count posted in A writes only A rows: every movement of the document carries tenant A', async (s) => {
    const c = await openC(s, K1);
    await rec(s, c.id, [cLine(KR, '8', LA)]);
    await post(s, c.id);
    expect((await s.sql(A, 'SELECT DISTINCT tenant_id FROM inventory.stock_movements WHERE doc_id = $1', [c.id])).map((r: any) => r.tenant_id)).toEqual([A]);
  });
});

// ======================================================================================================== races (committed)
describe.skipIf(!live)('T-14 races (committed transactions)', () => {
  const attempt = <T>(fn: (s: Sess) => Promise<T>) => committed(fn).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, code: (e as { code?: string }).code ?? String(e) }));
  const open = (store: string) => committed((s) => openC(s, store));
  it('two opens of the SAME store at once: exactly one 201, the loser is 409 inventory.count_already_open; ONE open count exists', async () => {
    const rs = await Promise.all([attempt((s) => openC(s, K4)), attempt((s) => openC(s, K4))]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect((rs.find((r) => !r.ok) as { code: string }).code).toBe('inventory.count_already_open');
    expect(Number((await admin.query("SELECT count(*) AS n FROM inventory.stock_counts WHERE store_id = $1 AND status = 'open'", [K4])).rows[0].n)).toBe(1);
  });
  it('two posts of the SAME count at once: exactly one wins (409 for the loser); ONE count_adjust_out exists and the lot is 10 - 6 = 4', async () => {
    const c = await open(K5);
    await committed((s) => rec(s, c.id, [cLine(KR, '4', LP)]));
    const rs = await Promise.all([attempt((s) => post(s, c.id)), attempt((s) => post(s, c.id))]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(['inventory.document_invalid_transition', 'common.version_conflict']).toContain((rs.find((r) => !r.ok) as { code: string }).code);
    expect((await admin.query("SELECT count(*) AS n FROM inventory.stock_movements WHERE doc_id = $1 AND movement_kind = 'count_adjust_out'", [c.id])).rows[0].n).toBe('1');
    expect(Number((await admin.query('SELECT qty_base::text AS q FROM inventory.stock_balances WHERE store_id = $1 AND lot_id = $2', [K5, LP])).rows[0].q)).toBe(4);
  });
  it('post and cancel of the SAME count at once: exactly one wins; movements exist iff it was posted', async () => {
    const c = await open(K6);
    await committed((s) => rec(s, c.id, [cLine(KR, '4', LQ)]));
    const rs = await Promise.all([attempt((s) => post(s, c.id)), attempt((s) => cancelC(s, c.id))]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    const st = (await admin.query('SELECT status FROM inventory.stock_counts WHERE id = $1', [c.id])).rows[0].status;
    const n = Number((await admin.query('SELECT count(*) AS n FROM inventory.stock_movements WHERE doc_id = $1', [c.id])).rows[0].n);
    expect(['posted', 'cancelled']).toContain(st);
    expect(n).toBe(st === 'posted' ? 1 : 0);
    expect(Number((await admin.query('SELECT qty_base::text AS q FROM inventory.stock_balances WHERE store_id = $1 AND lot_id = $2', [K6, LQ])).rows[0].q)).toBe(st === 'posted' ? 4 : 10);
  });
  it('a count post racing automatic consumption of the same lot never fails and never leaves the lot row negative', async () => {
    const c = await open(K7);
    await committed((s) => rec(s, c.id, [cLine(KR, '0', LR)]));
    const [p, k] = await Promise.all([attempt((s) => post(s, c.id)), attempt((s) => s.consume(K7, KR, LR, 12, 30))]);
    expect(p.ok).toBe(true);
    expect(k.ok).toBe(true);
    expect(Number((await admin.query('SELECT qty_base::text AS q FROM inventory.stock_balances WHERE store_id = $1 AND lot_id = $2', [K7, LR])).rows[0].q)).toBeGreaterThanOrEqual(0);
  });
});
