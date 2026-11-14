// C12.T-11 integration + probes for #80-#89 on the migrated database as role lims_api with RLS on (REAL T-03 repositories, handlers/index.ts, T-04 scope service). The tax rate comes from a FAKE
// CatalogPort.getTaxRate (purchasing.helpers.ts makePoCtx: VAT 1300 bp, LOCALTAX 500 bp, anything else => catalog.tax_config_missing); C3 itself is not under test.
// Harness: tests/db/c12-t11/run.sh (clone of c12-t13: pinned image, migrations, seeds, inventory DDL, exports LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL / LIMS_C12T03_REQUIRE_DB=1).
// Fixtures: tests/db/c12-t03/fixtures.sql (tenant A items 2001 / packs 2201 BOX 400, cs_tax_codes LOCALTAX active + OLDTAX inactive, settings 9601 po_self_approval_allowed = false, store 1003 inactive,
//   tenant B: store 1101, supplier 3101, item 2101, pack 2301, PO 8401) + EXTRAS below (ids 16xxx, committed once with the superuser, ON CONFLICT DO NOTHING).
// Each test = one request-shaped transaction that is ROLLED BACK; every handler call runs inside a SAVEPOINT. The race tests commit (fresh POs in store P1) and never touch other fixtures.
// Without the URLs the DB tests skip, except under LIMS_C12T03_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails.
// EXTRAS (tenant A): stores P1 (BR1) P2 (BR2) P3 (BR1) R1 (BR1, reorder); suppliers SA SB SIN (inactive); items I1 (packs K1 BOX 400 default, K2 KIT 100; no default tax) I2 (pack K3, default tax LOCALTAX) IIN (inactive) I3;
//   supplier items (SA,I1,K1) price 5000 no tax | (SA,I1,K2) 1200 LOCALTAX | (SA,I2,K3) 700. Tax code NORATE is active in the tenant coded set but C3 has no rate for it. Reasons po_cancel / po_close.
//   State POs (store P1, supplier SA, creator = system actor): PD draft (2 lines) PE draft with ZERO current lines PA approved PS sent PP partially_received (line: 100 of 400 received) PP2 partially_received (line 1
//   fully received, line 2 open) PR received PC closed PX cancelled; PB2 draft in P2 (BR2); PO-OPEN draft in R1 for item Q7.
//   Reorder (store R1): Q1 level 500 qty 900 stock 100 pref SA, default pack 400 + bigger non-default pack 1000 => 3 packs of 400 | Q2 level 500 qty 600 stock 0 pref SA, default pack INACTIVE (400), active packs 100 / 250 => 3 packs of 250 |
//   Q3 level 100 qty 100 stock 20 pref SB, pack 50 => exactly 2 packs | Q4 pref SA, no supplier item => no_pack | Q5 no preferred supplier | Q6 stock 1000 >= level => not_below_reorder | Q7 below, but an open draft PO exists.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import {
  A, B, BR1, BR2, COST, LEAK, LINE_KEYS, MONEY_KEY, PO_APPROVE, PO_KEYS, PO_MANAGE, PO_NO, PRINT_KEYS, PRINT_LINE_KEYS, READ, SUMMARY_KEYS, SYS, call, cancelBody, closeBody, expectLims, hdr, idem, ifm, makePoCtx, newPo,
  onlyKeys, poLine, reorderBody, rej, sentBody, uid, type PoOpts,
} from './purchasing.helpers.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

// fixtures (T-03)
const SUP_B = uid(3101), ITEM_B = uid(2101), PACK_B = uid(2301), STORE_B = uid(1101), PO_B = uid(8401), OLD_STORE = uid(1003);
// extras
const P1 = uid(16001), P2 = uid(16002), P3 = uid(16003), R1 = uid(16004);
const SA = uid(16301), SB = uid(16302), SIN = uid(16303);
const I1 = uid(16101), I2 = uid(16102), IIN = uid(16103), I3 = uid(16104);
const K1 = uid(16201), K2 = uid(16202), K3 = uid(16203), K4 = uid(16204), K5 = uid(16205);
const Q = [1, 2, 3, 4, 5, 6, 7].map((n) => uid(16110 + n)); // Q1..Q7
const [Q1, Q2, Q3, Q4, Q5, Q6, Q7] = Q as [string, string, string, string, string, string, string];
const QD = uid(16211), QB = uid(16212), QX = uid(16213), Q2A = uid(16214), Q2B = uid(16215), Q3P = uid(16216), Q4P = uid(16217), Q5P = uid(16218), Q6P = uid(16219), Q7P = uid(16220);
const PD = uid(16410), PE = uid(16417), PA = uid(16419), PS = uid(16418), PP = uid(16411), PP2 = uid(16412), PR = uid(16413), PC = uid(16414), PX = uid(16415), PB2 = uid(16416), POPEN = uid(16421), PG = uid(16422), GG = uid(16720);
const L_PD1 = uid(16509), L_PD2 = uid(16510), L_PP = uid(16511), L_PP2a = uid(16512), L_PP2b = uid(16513), L_PA = uid(16519);
const APPROVER = uid(16900), OTHER = uid(16901);
const KT = 'Asia/Kathmandu';
const BR1_ONLY: PoOpts = { all: false, branchIds: [BR1] };
const BR2_ONLY: PoOpts = { all: false, branchIds: [BR2] };
const NO_COST: PoOpts = { permissions: [READ, PO_MANAGE, PO_APPROVE] };
const MANAGE_ONLY: PoOpts = { permissions: [READ, PO_MANAGE, COST] };

type V = string | number | boolean | null | { sql: string };
const lit = (v: V): string => (v === null ? 'NULL' : typeof v === 'object' ? v.sql : typeof v === 'number' || typeof v === 'boolean' ? String(v) : `'${v.replace(/'/g, "''")}'`);
const ins = (table: string, row: Record<string, V>): string => {
  const r: Record<string, V> = { tenant_id: A, ...row };
  if (!('created_by' in r) && !table.endsWith('g_cs_reasons')) { r['created_by'] = SYS; r['updated_by'] = SYS; }
  return `INSERT INTO inventory.${table} (${Object.keys(r).join(', ')}) VALUES (${Object.values(r).map(lit).join(', ')}) ON CONFLICT DO NOTHING;`;
};
const store = (id: string, br: string, code: string, extra: Record<string, V> = {}) => ins('stores', { id, branch_id: br, store_code: code, name: `Store ${code}`, store_kind: 'main', is_default_consumption: false, is_active: true, ...extra });
const item = (id: string, code: string, extra: Record<string, V> = {}) => ins('items', { id, item_code: code, name: `T11 ${code}`, category: 'reagent', base_uom_code: 'test', is_lot_tracked: false, requires_expiry: false, ...extra });
const pack = (id: string, itemId: string, code: string, q: number, dflt: boolean, active = true) => ins('item_packs', { id, item_id: itemId, pack_code: code, label: `Pack ${code}`, uom_code: 'box', qty_in_base: q, is_purchase_default: dflt, is_active: active });
const sitem = (n: number, sup: string, itemId: string, packId: string, price: number | null, tax: string | null = null) =>
  ins('supplier_items', { id: uid(16600 + n), supplier_id: sup, item_id: itemId, pack_id: packId, last_unit_price_paisa: price, default_tax_code: tax });
const sis = (n: number, st: string, itemId: string, level: number, q: number, pref: string | null) =>
  ins('store_item_settings', { id: uid(16700 + n), store_id: st, item_id: itemId, reorder_level_base: level, reorder_qty_base: q, preferred_supplier_id: pref, is_active: true });
const bal = (n: number, st: string, itemId: string, qty: number) =>
  ins('stock_balances', { id: uid(16800 + n), store_id: st, item_id: itemId, lot_id: null, qty_base: qty, value_paisa: qty * 10, last_movement_at: { sql: 'now()' } });
const poRow = (id: string, no: string, st: string, br: string, status: string, extra: Record<string, V> = {}) => {
  const life: Record<string, V> = status === 'draft' ? {} : { approved_at: { sql: "now() - interval '1 day'" }, approved_by: SYS };
  if (status === 'sent') Object.assign(life, { sent_at: { sql: "now() - interval '1 day'" }, sent_by: SYS, sent_channel: 'email' });
  if (status === 'closed') Object.assign(life, { closed_at: { sql: 'now()' }, closed_by: SYS, close_reason_code: 'short_supply' });
  if (status === 'cancelled') Object.assign(life, { cancelled_at: { sql: 'now()' }, cancelled_by: SYS, cancel_reason_code: 'duplicate' });
  return ins('purchase_orders', { id, po_no: no, branch_id: br, store_id: st, supplier_id: SA, status, source: 'manual', ...life, ...extra });
};
const poLineRow = (id: string, po: string, n: number, itemId: string, packId: string, snap: number, recv = 0, o: Record<string, V> = {}) =>
  ins('purchase_order_lines', { id, po_id: po, line_no: n, item_id: itemId, pack_id: packId, qty_packs: 1, qty_in_base_snapshot: snap, qty_base: snap, unit_price_paisa: 1000, discount_paisa: 0, tax_code: null, tax_rate_bp: 0,
    net_paisa: 1000, vat_paisa: 0, line_total_paisa: 1000, received_qty_base: recv, ...o });
const EXTRAS = `
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT set_config('request.jwt.claims', '{"tenant_id":"${A}","sub":"${SYS}","actor_type":"system"}', true);
INSERT INTO inventory.g_cs_reasons (id, reason_group, code, display) VALUES
  ('${uid(16901)}', 'po_cancel', 'no_longer_needed', 'No longer needed'), ('${uid(16902)}', 'po_cancel', 'duplicate', 'Duplicate'), ('${uid(16903)}', 'po_close', 'short_supply', 'Short supply'),
  ('${uid(16904)}', 'po_close', 'item_discontinued', 'Item discontinued'), ('${uid(16905)}', 'po_close', 'other', 'Other'), ('${uid(16906)}', 'wastage', 'spillage', 'Spillage') ON CONFLICT DO NOTHING;
${ins('cs_tax_codes', { id: uid(16911), code: 'NORATE', display: 'NORATE', is_active: true })}
${[store(P1, BR1, 'T11-P1'), store(P2, BR2, 'T11-P2'), store(P3, BR1, 'T11-P3'), store(R1, BR1, 'T11-R1')].join('\n')}
${[SA, SB, SIN].map((id, i) => ins('suppliers', { id, supplier_code: ['T11-SA', 'T11-SB', 'T11-SIN'][i] as string, name: ['T11 Alpha', 'T11 Beta', 'T11 Old'][i] as string, is_active: i < 2, address_text: 'Synthetic street 1', email: 'syn@example.test', phone_display: '000-000' })).join('\n')}
${[item(I1, 'T11-I1', { is_lot_tracked: true, requires_expiry: true }), item(I2, 'T11-I2', { default_tax_code: 'LOCALTAX' }), item(IIN, 'T11-IIN', { is_active: false }), item(I3, 'T11-I3'),
   ...Q.map((id, i) => item(id, `T11-Q${i + 1}`))].join('\n')}
${[pack(K1, I1, 'BOX', 400, true), pack(K2, I1, 'KIT', 100, false), pack(K3, I2, 'BX', 10, true), pack(K4, IIN, 'BX', 10, true), pack(K5, I3, 'BX', 20, true),
   pack(QD, Q1, 'D', 400, true), pack(QB, Q1, 'B', 1000, false), pack(QX, Q2, 'X', 400, true, false), pack(Q2A, Q2, 'A', 100, false), pack(Q2B, Q2, 'B', 250, false), pack(Q3P, Q3, 'P', 50, true),
   pack(Q4P, Q4, 'P', 10, true), pack(Q5P, Q5, 'P', 10, true), pack(Q6P, Q6, 'P', 10, true), pack(Q7P, Q7, 'P', 10, true)].join('\n')}
${[sitem(1, SA, I1, K1, 5000), sitem(2, SA, I1, K2, 1200, 'LOCALTAX'), sitem(3, SA, I2, K3, 700), sitem(4, SA, Q1, QD, 100), sitem(5, SA, Q1, QB, 230), sitem(6, SA, Q2, QX, 150), sitem(7, SA, Q2, Q2A, 40),
   sitem(8, SA, Q2, Q2B, 95), sitem(9, SB, Q3, Q3P, 300), sitem(10, SA, Q5, Q5P, 10), sitem(11, SA, Q6, Q6P, 10), sitem(12, SA, Q7, Q7P, 10)].join('\n')}
${[sis(1, R1, Q1, 500, 900, SA), sis(2, R1, Q2, 500, 600, SA), sis(3, R1, Q3, 100, 100, SB), sis(4, R1, Q4, 500, 100, SA), sis(5, R1, Q5, 500, 100, null), sis(6, R1, Q6, 500, 100, SA), sis(7, R1, Q7, 500, 100, SA)].join('\n')}
${[bal(1, R1, Q1, 100), bal(3, R1, Q3, 20), bal(6, R1, Q6, 1000), bal(7, R1, Q7, 10)].join('\n')}
${[poRow(PD, 'T11-PD', P1, BR1, 'draft'), poRow(PE, 'T11-PE', P1, BR1, 'draft'), poRow(PA, 'T11-PA', P1, BR1, 'approved'), poRow(PS, 'T11-PS', P1, BR1, 'sent'), poRow(PP, 'T11-PP', P1, BR1, 'partially_received'),
   poRow(PP2, 'T11-PP2', P1, BR1, 'partially_received'), poRow(PR, 'T11-PR', P1, BR1, 'received'), poRow(PC, 'T11-PC', P1, BR1, 'closed'), poRow(PX, 'T11-PX', P1, BR1, 'cancelled'),
   poRow(PB2, 'T11-PB2', P2, BR2, 'draft'), poRow(POPEN, 'T11-POPEN', R1, BR1, 'draft'), poRow(PG, 'T11-PG', P1, BR1, 'approved')].join('\n')}
${ins('goods_receipts', { id: GG, grn_no: 'GR260016001', kind: 'purchase', store_id: P1, supplier_id: SA, po_id: PG, status: 'posted', received_at: { sql: 'now()' }, posted_at: { sql: 'now()' }, posted_by: SYS })}
${[poLineRow(L_PD1, PD, 1, I1, K1, 400), poLineRow(L_PD2, PD, 2, I1, K2, 100), poLineRow(uid(16517), PE, 1, I1, K1, 400, 0, { removed_at: { sql: 'now()' }, removed_by: SYS }), poLineRow(L_PA, PA, 1, I1, K1, 400),
   poLineRow(uid(16518), PS, 1, I1, K1, 400), poLineRow(L_PP, PP, 1, I1, K1, 400, 100), poLineRow(L_PP2a, PP2, 1, I1, K1, 400, 400), poLineRow(L_PP2b, PP2, 2, I1, K2, 100, 0),
   poLineRow(uid(16514), PR, 1, I1, K1, 400, 400), poLineRow(uid(16515), PC, 1, I1, K1, 400, 400), poLineRow(uid(16520), PX, 1, I1, K1, 400), poLineRow(uid(16516), PB2, 1, I1, K1, 400),
   poLineRow(uid(16521), POPEN, 1, Q7, Q7P, 10), poLineRow(uid(16522), PG, 1, I1, K1, 400)].join('\n')}
COMMIT;`;

const hasTrigger = live && await (async () => {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  try { await c.connect(); return (await c.query("SELECT 1 FROM pg_proc WHERE proname = 'tg_line_guard'")).rowCount === 1; } catch { return false; } finally { await c.end().catch(() => undefined); }
})();

let api: pg.Pool;
let admin: pg.Pool;
beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 10 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c12-t03/fixtures.sql', import.meta.url)), 'utf8'));
  await admin.query(EXTRAS);
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-11 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

interface Sess {
  call(t: string, op: string, req?: Parameters<typeof call>[2], o?: PoOpts): Promise<{ status: number; body: any }>;
  sql(t: string, text: string, v?: unknown[]): Promise<any[]>;
  raw(text: string, v?: unknown[]): Promise<any[]>; // no claims statement first: usable inside an aborted transaction (ROLLBACK TO SAVEPOINT)
  roleCalls: any[];
  taxCalls: { taxCode: string; on: string }[];
}
const claims = (t: string) => JSON.stringify({ tenant_id: t, sub: SYS, actor_type: 'system' });
type Client = pg.PoolClient;
function sessionOn(client: Client): Sess {
  let n = 0;
  const roleCalls: any[] = [];
  const taxCalls: { taxCode: string; on: string }[] = [];
  const tx = { query: (t: string, v?: unknown[]) => client.query(t, v) };
  return {
    roleCalls, taxCalls,
    async raw(text, v) { return (await client.query(text, v)).rows; },
    async sql(t, text, v) { await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]); return (await client.query(text, v)).rows; },
    async call(t, op, req, o) {
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]);
      const st = makePoCtx(tx, t, o ?? {});
      const sp = `t11_h${++n}`;
      await client.query(`SAVEPOINT ${sp}`);
      try { const r = await call(op, st.ctx, req); roleCalls.push(...st.roleCalls); taxCalls.push(...st.taxCalls); await client.query(`RELEASE SAVEPOINT ${sp}`); return r; }
      catch (e) { roleCalls.push(...st.roleCalls); taxCalls.push(...st.taxCalls); await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
    },
  };
}
async function session<T>(fn: (s: Sess) => Promise<T>): Promise<T> {
  const client = await api.connect();
  try { await client.query('BEGIN'); return await fn(sessionOn(client)); } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}
const run = (name: string, fn: (s: Sess) => Promise<void>) => it(name, () => session(fn));
async function committed<T>(fn: (s: Sess) => Promise<T>): Promise<T> {
  const client = await api.connect();
  try { await client.query('BEGIN'); const r = await fn(sessionOn(client)); await client.query('COMMIT'); return r; } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
}

// ------------------------------------------------------------------ small helpers
const nf = (p: Promise<unknown>) => expectLims(p, 'common.not_found', 404);
const forbidden = (p: Promise<unknown>) => expectLims(p, 'auth.forbidden', 403);
const invalid = (p: Promise<unknown>) => expectLims(p, 'inventory.po_invalid_transition', 409);
const L1 = (over: Record<string, unknown> = {}) => poLine(I1, K1, '1', { unit_price_paisa: 1000, ...over });
const mk = async (s: Sess, lines: Record<string, unknown>[] = [L1()], o?: PoOpts, over: Record<string, unknown> = {}, supplier = SA, st = P1) =>
  (await s.call(A, 'createPurchaseOrder', { headers: idem(), body: newPo(supplier, st, lines, over) }, o)).body;
const get = (s: Sess, id: string, o?: PoOpts, t = A) => s.call(t, 'getPurchaseOrder', { params: { po_id: id } }, o);
const ver = async (s: Sess, id: string) => Number((await dbPo(s, id)).version);
const approve = async (s: Sess, id: string, o?: PoOpts, version?: number) => s.call(A, 'approvePurchaseOrder', { params: { po_id: id }, headers: hdr(version ?? await ver(s, id)) }, { actor: APPROVER, ...o });
const send = async (s: Sess, id: string, o?: PoOpts, body = sentBody()) => s.call(A, 'markPurchaseOrderSent', { params: { po_id: id }, headers: hdr(await ver(s, id)), body }, o);
const cancel = async (s: Sess, id: string, o?: PoOpts, body = cancelBody()) => s.call(A, 'cancelPurchaseOrder', { params: { po_id: id }, headers: hdr(await ver(s, id)), body }, o);
const close = async (s: Sess, id: string, o?: PoOpts, body: Record<string, unknown> = closeBody()) => s.call(A, 'closePurchaseOrder', { params: { po_id: id }, headers: hdr(await ver(s, id)), body }, o);
const replace = async (s: Sess, id: string, lines: Record<string, unknown>[], o?: PoOpts, over: Record<string, unknown> = {}, supplier = SA, st = P1) =>
  s.call(A, 'replacePurchaseOrderDraft', { params: { po_id: id }, headers: ifm(await ver(s, id)), body: newPo(supplier, st, lines, over) }, o);
const dbPo = async (s: Sess, id: string) => (await s.sql(A, 'SELECT * FROM inventory.purchase_orders WHERE tenant_id = $1 AND id = $2', [A, id]))[0];
const dbLines = (s: Sess, id: string) => s.sql(A, 'SELECT * FROM inventory.purchase_order_lines WHERE tenant_id = $1 AND po_id = $2 ORDER BY removed_at NULLS LAST, line_no, created_at', [A, id]);
const count = async (s: Sess, where = 'TRUE') => Number((await s.sql(A, `SELECT count(*)::int AS n FROM inventory.purchase_orders WHERE tenant_id = $1 AND ${where}`, [A]))[0].n);
const num = (v: unknown) => Number(v);
/** Independent oracle for AC-05.1 / 02-TRD §4.2 (BigInt, round half up on non-negative values). */
const rhu = (n: bigint, d: bigint) => (n * 2n + d) / (2n * d);
const oracle = (qtyPacks: string, price: number, disc: number, bp: number) => {
  const gross = Number(rhu(BigInt(Math.round(Number(qtyPacks) * 1000)) * BigInt(price), 1000n));
  const net = gross - disc; const vat = Number(rhu(BigInt(net) * BigInt(bp), 10000n));
  return { gross, net, vat, total: net + vat };
};
// Ruling C12.T-11: Po requires created_at (inventory.yaml Po / PoSummary), so shared LEAK (contains created_at) must not apply here.
const PO_LEAK = /tenant|created_by|updated_by/i;
const keysOk = (po: any) => { expect(onlyKeys(po, PO_KEYS)).toEqual([]); expect(JSON.stringify(po)).not.toMatch(PO_LEAK); for (const l of po.lines) expect(onlyKeys(l, LINE_KEYS)).toEqual([]); };

// =============================================================================================================== AC-05.1 create: server totals, tax, exempt
describe.skipIf(!live)('T-11 #81createPurchaseOrder: AC-05.1 server-computed money (CatalogPort.getTaxRate, half-up), P-23, D-70', () => {
  run('golden: 2.500 packs x 1001 - 3 at VAT 13 % => gross 2503 (2502.5 half-up, not banker 2502), net 2500, vat 325, total 2825; header = line; shape, status, number, creator', async (s) => {
    const po = await mk(s, [poLine(I1, K1, '2.500', { unit_price_paisa: 1001, discount_paisa: 3 })], { actor: OTHER }, { expected_on: '2026-12-31', notes: 'synthetic note' });
    keysOk(po);
    expect(po).toMatchObject({ status: 'draft', source: 'manual', version: 1, branch_id: BR1, store_id: P1, supplier_id: SA, expected_on: '2026-12-31', notes: 'synthetic note' });
    expect(po.po_no).toMatch(PO_NO);
    const l = po.lines[0];
    expect(l).toMatchObject({ line_no: 1, item_id: I1, pack_id: K1, unit_price_paisa: 1001, discount_paisa: 3, tax_code: 'VAT', is_exempt: false, tax_rate_bp: 1300, net_paisa: 2500, vat_paisa: 325, line_total_paisa: 2825, is_closed_short: false });
    expect(num(l.qty_packs)).toBe(2.5); expect(num(l.qty_base)).toBe(1000); expect(num(l.received_qty_base)).toBe(0); expect(num(l.open_qty_base)).toBe(1000);
    expect(po).toMatchObject({ subtotal_paisa: 2503, discount_paisa: 3, net_paisa: 2500, vat_paisa: 325, total_paisa: 2825 });
    const row = await dbPo(s, po.id);
    expect(row.created_by).toBe(OTHER);
    expect(row.total_paisa).toBe('2825');
    const [dl] = await dbLines(s, po.id);
    expect(num(dl.qty_in_base_snapshot)).toBe(400); expect(num(dl.qty_base)).toBe(1000); expect(dl.tax_rate_bp).toBe(1300);
  });
  run('golden half-up on VAT: price 50 x 1300 bp = 6.5 => 7 (banker 6), total 57; price 4 => 0.52 => 1; price 3 => 0.39 => 0', async (s) => {
    const po = await mk(s, [L1({ unit_price_paisa: 50 }), L1({ unit_price_paisa: 4 }), L1({ unit_price_paisa: 3 })]);
    expect(po.lines.map((l: any) => [l.net_paisa, l.vat_paisa, l.line_total_paisa])).toEqual([[50, 7, 57], [4, 1, 5], [3, 0, 3]]);
    expect(po).toMatchObject({ net_paisa: 57, vat_paisa: 8, total_paisa: 65 });
  });
  run('oracle table: every line equals the independent computation; the header is the sum of the lines (subtotal = sum gross, discount, net, vat, total)', async (s) => {
    const cases: [string, string, number, number, string, string][] = [ // qty_packs, price, discount, bp, tax code, pack
      ['1', '50', 0, 1300, 'VAT', K1], ['2.500', '1001', 3, 1300, 'VAT', K1], ['0.333', '1000', 0, 1300, 'VAT', K2], ['1.005', '100', 0, 500, 'LOCALTAX', K1], ['7', '199', 5, 500, 'LOCALTAX', K2],
      ['12.345', '8888', 100, 1300, 'VAT', K1], ['0.001', '499', 0, 1300, 'VAT', K1], ['1', '4', 0, 1300, 'VAT', K2],
    ];
    const po = await mk(s, cases.map(([q, p, d, , t, pk]) => poLine(I1, pk, q, { unit_price_paisa: Number(p), discount_paisa: d, tax_code: t })));
    let sg = 0, sd = 0, sn = 0, sv = 0, st = 0;
    cases.forEach(([q, p, d, bp], i) => {
      const o = oracle(q, Number(p), d, bp); const l = po.lines[i];
      expect([l.net_paisa, l.vat_paisa, l.line_total_paisa, l.tax_rate_bp], `line ${i + 1}`).toEqual([o.net, o.vat, o.total, bp]);
      sg += o.gross; sd += d; sn += o.net; sv += o.vat; st += o.total;
    });
    expect(po).toMatchObject({ subtotal_paisa: sg, discount_paisa: sd, net_paisa: sn, vat_paisa: sv, total_paisa: st });
    expect(po.lines.map((l: any) => l.line_no)).toEqual(cases.map((_, i) => i + 1));
  });
  run('a rate of 0 bp keeps the tax code and vat 0 (rate 0 is not exempt)', async (s) => {
    const po = await mk(s, [L1({ tax_code: 'LOCALTAX' })], { rates: { VAT: 1300, LOCALTAX: 0 } });
    expect(po.lines[0]).toMatchObject({ tax_code: 'LOCALTAX', is_exempt: false, tax_rate_bp: 0, vat_paisa: 0, net_paisa: 1000, line_total_paisa: 1000 });
  });
  run('exempt line (D-70): is_exempt true, no tax_code => getTaxRate NEVER called; wire has is_exempt true and NO tax_code key (not null); tax_rate_bp 0, vat 0; stored tax_code NULL', async (s) => {
    const po = await mk(s, [L1({ is_exempt: true })], { rates: {} }); // an empty rate table: a call would fail with tax_config_missing
    expect(s.taxCalls).toEqual([]);
    const l = po.lines[0];
    expect(l.is_exempt).toBe(true); expect('tax_code' in l).toBe(false); expect(l).toMatchObject({ tax_rate_bp: 0, vat_paisa: 0, net_paisa: 1000, line_total_paisa: 1000 });
    const [dl] = await dbLines(s, po.id);
    expect(dl.tax_code).toBeNull(); expect(dl.tax_rate_bp).toBe(0);
    expect('tax_code' in (await get(s, po.id)).body.lines[0]).toBe(false);
  });
  run('exempt + taxed lines in one PO: the port is asked only for the taxed code(s), with `on` = the TENANT business date (2026-11-14T19:00Z is 2026-11-15 in Asia/Kathmandu)', async (s) => {
    const po = await mk(s, [L1({ is_exempt: true }), L1({ unit_price_paisa: 2000 })], { now: '2026-11-14T19:00:00.000Z' });
    expect(new Set(s.taxCalls.map((c) => `${c.taxCode}@${c.on}`))).toEqual(new Set(['VAT@2026-11-15']));
    expect(po.lines.map((l: any) => [l.is_exempt, l.vat_paisa])).toEqual([[true, 0], [false, 260]]);
  });
  run('tax code default chain: supplier item default_tax_code (LOCALTAX) > item default (LOCALTAX) > VAT; price defaults to the supplier item price', async (s) => {
    const po = await mk(s, [poLine(I1, K1, '1'), poLine(I1, K2, '1'), poLine(I2, K3, '1')]);
    expect(po.lines.map((l: any) => [l.unit_price_paisa, l.tax_code, l.tax_rate_bp])).toEqual([[5000, 'VAT', 1300], [1200, 'LOCALTAX', 500], [700, 'LOCALTAX', 500]]);
  });
  run('an explicit tax_code and an explicit price beat the defaults', async (s) => {
    const po = await mk(s, [poLine(I1, K2, '1', { tax_code: 'VAT', unit_price_paisa: 10 })]);
    expect(po.lines[0]).toMatchObject({ tax_code: 'VAT', unit_price_paisa: 10, tax_rate_bp: 1300 });
  });
  run('the rate is a SNAPSHOT: a later C3 rate change (VAT 2000 bp) does not change the stored line on read', async (s) => {
    const po = await mk(s);
    const again = (await get(s, po.id, { rates: { VAT: 2000 } })).body;
    expect(again.lines[0]).toMatchObject({ tax_rate_bp: 1300, vat_paisa: 130 }); expect(again.total_paisa).toBe(po.total_paisa);
  });
  run('catalog.tax_config_missing (NORATE: active in the tenant coded set, no C3 rate) is rethrown unchanged (the SAME LimsError object, 422, P-23); no PO, no line, no number consumed', async (s) => {
    const before = await count(s);
    const e = await expectLims(mk(s, [L1({ tax_code: 'NORATE' })]), 'catalog.tax_config_missing', 422);
    expect(e.statusCode).toBe(422); expect(await count(s)).toBe(before);
    const own = new LimsError('catalog.tax_config_missing', 'marker-from-c3');
    const e2 = await rej(mk(s, [L1()], { taxFailure: own }));
    expect(e2).toBe(own); expect(await count(s)).toBe(before);
  });
  run('any other port error (common.not_found) also passes through unchanged and writes nothing', async (s) => {
    const own = new LimsError('common.not_found');
    const before = await count(s);
    expect(await rej(mk(s, [L1()], { taxFailure: own }))).toBe(own); expect(await count(s)).toBe(before);
  });
  run('tax code inactive in the tenant set (OLDTAX) or not in it (NOSUCH) => 400 at /lines/0/tax_code even when C3 has a rate; the port is not asked for it', async (s) => {
    for (const code of ['OLDTAX', 'NOSUCH']) {
      const e: any = await rej(mk(s, [L1({ tax_code: code })], { rates: { VAT: 1300, OLDTAX: 700, NOSUCH: 900 } }));
      expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); expect(JSON.stringify(e.errors ?? e.detail ?? '')).toContain('/lines/0/tax_code');
    }
  });
  run('inactive item => 409 inventory.item_inactive; a pack that is not the item\'s pack => 422 inventory.uom_mismatch; nothing created', async (s) => {
    const before = await count(s);
    await expectLims(mk(s, [poLine(IIN, K4, '1', { unit_price_paisa: 1 })]), 'inventory.item_inactive', 409);
    await expectLims(mk(s, [poLine(I1, K3, '1', { unit_price_paisa: 1 })]), 'inventory.uom_mismatch', 422);
    expect(await count(s)).toBe(before);
  });
  run('inactive supplier / inactive store / unknown ids / tenant-B ids are refused with a 4xx LimsError (never a 500) and nothing is created in either tenant (P-T3)', async (s) => {
    const before = await count(s);
    const bad: [string, Record<string, unknown>[], string, string][] = [
      ['inactive supplier', [L1()], SIN, P1], ['inactive store', [L1()], SA, OLD_STORE], ['unknown supplier', [L1()], uid(16999), P1],
      ['B supplier', [L1()], SUP_B, P1], ['B item', [poLine(ITEM_B, K1, '1', { unit_price_paisa: 1 })], SA, P1], ['B pack', [poLine(I1, PACK_B, '1', { unit_price_paisa: 1 })], SA, P1], ['B store', [L1()], SA, STORE_B],
    ];
    for (const [name, lines, sup, st] of bad) {
      const e: any = await rej(mk(s, lines, undefined, {}, sup, st));
      expect(e instanceof LimsError, name).toBe(true); expect([400, 404, 409, 422], `${name}: ${e.code}`).toContain(e.statusCode);
    }
    expect((await rej(mk(s, [L1()], undefined, {}, SA, STORE_B)) as LimsError).statusCode).toBe(404); // a store outside the tenant is simply not found
    expect(await count(s)).toBe(before);
    expect(Number((await s.sql(B, 'SELECT count(*)::int AS n FROM inventory.purchase_orders WHERE supplier_id = $1', [SA]))[0].n)).toBe(0);
  });
  run('numbers: two creates give two different po_no values, consecutive in the sequence', async (s) => {
    const a = await mk(s), b = await mk(s);
    expect(a.po_no).toMatch(PO_NO); expect(b.po_no).toMatch(PO_NO); expect(a.po_no).not.toBe(b.po_no);
    expect(Number(b.po_no.slice(-6)) - Number(a.po_no.slice(-6))).toBe(1);
  });
  run('scope (P-B2 / P-B8): store in an invisible branch => 404 even without the permission; visible store without po.manage => 403 and the permission is asserted WITH branchId; with it => 201', async (s) => {
    await nf(mk(s, [L1()], BR1_ONLY, {}, SA, P2));
    await nf(mk(s, [L1()], { ...BR1_ONLY, permissions: [READ] }, {}, SA, P2));
    await forbidden(mk(s, [L1()], { ...BR1_ONLY, permissions: [READ] }));
    expect(s.roleCalls.some((r) => r.permission === PO_MANAGE && r.branchId === BR1)).toBe(true);
    expect((await s.call(A, 'createPurchaseOrder', { headers: idem(), body: newPo(SA, P1, [L1()]) }, BR1_ONLY)).status).toBe(201);
  });
  run('PE-3: without inventory.cost.read the Po carries no property ending in _paisa (header and lines) on create and get, but the server still computes and stores the money', async (s) => {
    const po = await mk(s, [L1()], NO_COST);
    expect(JSON.stringify(po).match(/"[a-z_]*_paisa[a-z0-9_]*"/g)).toBeNull();
    const g = (await get(s, po.id, NO_COST)).body;
    expect(JSON.stringify(g).match(/"[a-z_]*_paisa[a-z0-9_]*"/g)).toBeNull(); expect(g.lines[0].tax_rate_bp).toBe(1300);
    expect((await dbPo(s, po.id)).total_paisa).toBe('1130');
    const withCost = (await get(s, po.id)).body;
    expect(Object.keys(withCost).filter((k) => MONEY_KEY.test(k)).sort()).toEqual(['discount_paisa', 'net_paisa', 'subtotal_paisa', 'total_paisa', 'vat_paisa']);
  });
});

// =============================================================================================================== #82 / #80 reads
describe.skipIf(!live)('T-11 #82getPurchaseOrder and #80 listPurchaseOrders', () => {
  run('#82: a Po (strict keys); removed lines never shown; partial receipt shows received / open quantities; receipts is an array when present', async (s) => {
    const po = (await get(s, PP)).body;
    keysOk(po);
    expect(po.status).toBe('partially_received');
    expect(num(po.lines[0].received_qty_base)).toBe(100); expect(num(po.lines[0].open_qty_base)).toBe(300); expect(po.lines[0].is_closed_short).toBe(false);
    if ('receipts' in po) expect(Array.isArray(po.receipts)).toBe(true);
    expect((await get(s, PE)).body.lines).toEqual([]); // only a removed line remains
  });
  run('#82 scope: tenant B PO => 404; BR2 PO for a BR1 user => 404 (also without the permission, P-B8); no inventory.item.read => 403; BR2 user sees it', async (s) => {
    await nf(get(s, PO_B)); await nf(get(s, PB2, BR1_ONLY)); await nf(get(s, PB2, { ...BR1_ONLY, permissions: [] }));
    await forbidden(get(s, PD, { permissions: [] }));
    expect((await get(s, PB2, BR2_ONLY)).body.id).toBe(PB2);
    await nf(get(s, uid(16998)));
  });
  run('#80: rows are PoSummary (strict keys); filters status / supplier_id / branch_id / created_at range; BR1 user never sees the BR2 PO; tenant B PO never appears', async (s) => {
    const all = (await s.call(A, 'listPurchaseOrders', { query: { limit: 200 } })).body;
    expect(typeof all.page).toBe('object');
    for (const r of all.data) expect(onlyKeys(r, SUMMARY_KEYS)).toEqual([]);
    const ids = all.data.map((r: any) => r.id);
    expect(ids).toEqual(expect.arrayContaining([PD, PA, PS, PP, PR, PC, PX, PB2])); expect(ids).not.toContain(PO_B);
    const st = (await s.call(A, 'listPurchaseOrders', { query: { status: 'partially_received', limit: 200 } })).body.data;
    expect(st.length).toBeGreaterThanOrEqual(2); expect(st.every((r: any) => r.status === 'partially_received')).toBe(true);
    const sup = (await s.call(A, 'listPurchaseOrders', { query: { supplier_id: SB, limit: 200 } })).body.data; expect(sup.every((r: any) => r.supplier_id === SB)).toBe(true);
    const br2 = (await s.call(A, 'listPurchaseOrders', { query: { branch_id: BR2, limit: 200 } })).body.data; expect(br2.map((r: any) => r.id)).toEqual([PB2]);
    expect((await s.call(A, 'listPurchaseOrders', { query: { limit: 200 } }, BR1_ONLY)).body.data.map((r: any) => r.id)).not.toContain(PB2);
    const none = (await s.call(A, 'listPurchaseOrders', { query: { created_at_from: '2999-01-01T00:00:00Z', limit: 200 } })).body.data; expect(none).toEqual([]);
    const fut = (await s.call(A, 'listPurchaseOrders', { query: { created_at_to: '2000-01-01T00:00:00Z', limit: 200 } })).body.data; expect(fut).toEqual([]);
    expect((await s.call(B, 'listPurchaseOrders', { query: { limit: 200 } })).body.data.map((r: any) => r.id)).toEqual([PO_B]);
  });
  run('#80: limit + cursor pages are disjoint and complete; no inventory.cost.read => no total_paisa on rows', async (s) => {
    const full = (await s.call(A, 'listPurchaseOrders', { query: { limit: 200 } })).body.data.map((r: any) => r.id);
    const seen: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 100; i++) {
      const r = (await s.call(A, 'listPurchaseOrders', { query: { limit: 3, ...(cursor ? { cursor } : {}) } })).body;
      seen.push(...r.data.map((x: any) => x.id)); cursor = r.page.next_cursor; if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length); expect([...seen].sort()).toEqual([...full].sort());
    const nc = (await s.call(A, 'listPurchaseOrders', { query: { limit: 5 } }, NO_COST)).body.data;
    expect(nc.every((r: any) => !('total_paisa' in r))).toBe(true);
  });
});

// =============================================================================================================== replace (D-71)
describe.skipIf(!live)('T-11 #83replacePurchaseOrderDraft: draft replace by soft removal (08 A17 D-71, 02-TRD §5.11, IT-1a)', () => {
  run('every current line gets removed_at / removed_by (never deleted); the request lines are inserted as new rows line_no 1..n; totals are recomputed over non-removed lines; supplier and store are changeable; version + 1', async (s) => {
    const before = await dbLines(s, PD);
    expect(before.map((l) => l.id).sort()).toEqual([L_PD1, L_PD2].sort());
    const r = await replace(s, PD, [poLine(I1, K1, '3', { unit_price_paisa: 100 }), poLine(I2, K3, '1', { is_exempt: true, unit_price_paisa: 55 })], { actor: OTHER }, { notes: 'replaced' }, SB, P3);
    expect(r.status).toBe(200); keysOk(r.body);
    expect(r.body).toMatchObject({ status: 'draft', supplier_id: SB, store_id: P3, branch_id: BR1, version: 2, notes: 'replaced', subtotal_paisa: 355, net_paisa: 355, vat_paisa: 39, total_paisa: 394 });
    expect(r.body.lines.map((l: any) => [l.line_no, l.item_id, l.id])).toEqual([[1, I1, expect.any(String)], [2, I2, expect.any(String)]]);
    expect(r.body.lines.map((l: any) => l.id)).not.toEqual(expect.arrayContaining([L_PD1])); expect('tax_code' in r.body.lines[1]).toBe(false);
    const all = await dbLines(s, PD);
    expect(all.length).toBe(4);
    const old = all.filter((l) => [L_PD1, L_PD2].includes(l.id));
    expect(old.every((l) => l.removed_at !== null && l.removed_by === OTHER)).toBe(true);
    expect(all.filter((l) => l.removed_at === null).map((l) => l.line_no).sort()).toEqual([1, 2]);
    expect((await get(s, PD)).body.lines.length).toBe(2);
    const again = await replace(s, PD, [L1({ unit_price_paisa: 7 })], undefined, {}, SB, P3); // a second replace re-uses line_no 1 (partial unique WHERE removed_at IS NULL)
    expect(again.body.lines.map((l: any) => l.line_no)).toEqual([1]); expect((await dbLines(s, PD)).length).toBe(5);
  });
  run('If-Match: a stale version => 409 common.version_conflict and nothing changes (lines still current)', async (s) => {
    await expectLims(s.call(A, 'replacePurchaseOrderDraft', { params: { po_id: PD }, headers: ifm(5), body: newPo(SA, P1, [L1()]) }), 'common.version_conflict', 409);
    expect((await dbLines(s, PD)).every((l) => l.removed_at === null)).toBe(true); expect(await ver(s, PD)).toBe(1);
  });
  run('atomic: a tax_config_missing during replace leaves the old lines untouched (no removed_at)', async (s) => {
    await expectLims(replace(s, PD, [L1({ tax_code: 'NORATE' })]), 'catalog.tax_config_missing', 422);
    expect((await dbLines(s, PD)).every((l) => l.removed_at === null)).toBe(true); expect(await ver(s, PD)).toBe(1);
  });
  run('a replace in a non-draft status => 409 inventory.po_invalid_transition (approved, sent, partially_received, received, closed, cancelled); nothing changes', async (s) => {
    for (const id of [PA, PS, PP, PR, PC, PX]) {
      await invalid(replace(s, id, [L1()]));
      expect((await dbLines(s, id)).every((l) => l.removed_at === null)).toBe(true);
    }
  });
  run('scope: tenant B PO => 404; BR2 PO as BR1 user => 404; moving the draft into a store of an invisible branch => 404 and nothing changes', async (s) => {
    await nf(s.call(A, 'replacePurchaseOrderDraft', { params: { po_id: PO_B }, headers: ifm(1), body: newPo(SA, P1, [L1()]) }));
    await nf(replace(s, PB2, [L1()], BR1_ONLY, {}, SA, P2));
    await nf(replace(s, PD, [L1()], BR1_ONLY, {}, SA, P2));
    expect((await dbPo(s, PD)).store_id).toBe(P1);
    await forbidden(replace(s, PD, [L1()], { ...BR1_ONLY, permissions: [READ] }));
  });
  it.skipIf(!hasTrigger)('IT-1a DB half: setting removed_at on a line of an APPROVED PO is refused by the database (tg_line_guard, P0001); IT-2: editing the header of an approved PO too', () => session(async (s) => {
    const e1: any = await admin.query('UPDATE inventory.purchase_order_lines SET removed_at = now(), removed_by = $2 WHERE id = $1', [L_PA, SYS]).catch((e) => e);
    expect(e1.code).toBe('P0001');
    const e2: any = await admin.query("UPDATE inventory.purchase_orders SET notes = 'tamper' WHERE id = $1", [PA]).catch((e) => e);
    expect(e2.code).toBe('P0001');
    void s;
  }));
});

// =============================================================================================================== state machine
describe.skipIf(!live)('T-11 #84approve (AC-05.2, AC-05.3, PE-1, PE-5, P-B2)', () => {
  run('a holder of inventory.po.approve (not the creator) approves: status approved, approved_at / approved_by set, version + 1; the content is then frozen (edit => 409 inventory.po_invalid_transition)', async (s) => {
    const before = await ver(s, PD);
    const r = await approve(s, PD);
    expect(r.status).toBe(200); keysOk(r.body);
    expect(r.body).toMatchObject({ status: 'approved', version: before + 1 }); expect(typeof r.body.approved_at).toBe('string');
    const row = await dbPo(s, PD);
    expect(row.status).toBe('approved'); expect(row.approved_by).toBe(APPROVER); expect(row.approved_at).not.toBeNull();
    await invalid(replace(s, PD, [L1()]));
    expect((await dbLines(s, PD)).every((l) => l.removed_at === null)).toBe(true);
    expect(s.roleCalls.some((r2) => r2.permission === PO_APPROVE && r2.branchId === BR1)).toBe(true);
  });
  run('AC-05.3 self-approval (default po_self_approval_allowed = false): the creator approving => 403 inventory.po_self_approval_forbidden, status unchanged; another user works', async (s) => {
    const mine = await mk(s, [L1()], { actor: OTHER });
    await expectLims(approve(s, mine.id, { actor: OTHER }), 'inventory.po_self_approval_forbidden', 403);
    expect((await dbPo(s, mine.id)).status).toBe('draft');
    expect((await approve(s, mine.id, { actor: APPROVER })).body.status).toBe('approved');
    await expectLims(approve(s, PD, { actor: SYS }), 'inventory.po_self_approval_forbidden', 403); // PD was created by the system actor
  });
  run('settings.po_self_approval_allowed = true lets the creator approve', async (s) => {
    await s.sql(A, 'UPDATE inventory.settings SET po_self_approval_allowed = true WHERE tenant_id = $1', [A]);
    const mine = await mk(s, [L1()], { actor: OTHER });
    expect((await approve(s, mine.id, { actor: OTHER })).body.status).toBe('approved');
  });
  run('PE-1 / PE-2: without inventory.po.approve => 403 auth.forbidden; at aal1 => 403 auth.mfa_required; a clerk with only po.manage cannot approve; unchanged in all cases', async (s) => {
    await forbidden(approve(s, PD, MANAGE_ONLY));
    await expectLims(approve(s, PD, { aal: 'aal1' }), 'auth.mfa_required', 403);
    await forbidden(approve(s, PD, { permissions: [READ] }));
    expect((await dbPo(s, PD)).status).toBe('draft');
  });
  run('P-B2 / P-B8: a BR2 PO for a BR1 user => 404 (also without the permission); visible PO without the permission => 403; tenant B PO => 404', async (s) => {
    await nf(approve(s, PB2, BR1_ONLY)); await nf(approve(s, PB2, { ...BR1_ONLY, permissions: [] })); await forbidden(approve(s, PD, { ...BR1_ONLY, permissions: [READ] }));
    await nf(s.call(A, 'approvePurchaseOrder', { params: { po_id: PO_B }, headers: hdr(1) }, { actor: APPROVER }));
    expect((await s.sql(B, 'SELECT status FROM inventory.purchase_orders WHERE id = $1', [PO_B]))[0].status).toBe('draft');
  });
  run('approving twice => 409 inventory.po_invalid_transition; a stale If-Match on a draft => 409 common.version_conflict; a draft with no current lines => 400 common.validation_failed', async (s) => {
    await approve(s, PD);
    await invalid(approve(s, PD));
    await expectLims(approve(s, PE, undefined, 7), 'common.version_conflict', 409);
    const e: any = await rej(approve(s, PE));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
    expect((await dbPo(s, PE)).status).toBe('draft');
  });
});

describe.skipIf(!live)('T-11 #85mark-sent (AC-05.4)', () => {
  run('approved => sent with channel email + reference; sent_at set, sent_by = actor; status sent; recorded only (no other state changes, version + 1)', async (s) => {
    const v = await ver(s, PA);
    const r = await send(s, PA, { actor: OTHER }, sentBody({ sent_channel: 'email', sent_reference: 'MAIL-123' }));
    expect(r.status).toBe(200); keysOk(r.body);
    expect(r.body).toMatchObject({ status: 'sent', sent_channel: 'email', sent_reference: 'MAIL-123', version: v + 1 }); expect(typeof r.body.sent_at).toBe('string');
    const row = await dbPo(s, PA); expect(row.sent_by).toBe(OTHER); expect(row.sent_channel).toBe('email');
  });
  run('reference is optional; a manager without po.approve can mark sent; the other channels work', async (s) => {
    for (const ch of ['phone', 'in_person', 'portal', 'other']) {
      const mine = await mk(s, [L1()], { actor: OTHER }); await approve(s, mine.id);
      const r = await send(s, mine.id, MANAGE_ONLY, { sent_channel: ch } as never);
      expect(r.body.sent_channel).toBe(ch); expect('sent_reference' in r.body).toBe(false);
    }
  });
  run('forbidden: draft, sent, partially_received, received, closed, cancelled => 409 inventory.po_invalid_transition; no po.manage => 403; BR2 PO as BR1 => 404', async (s) => {
    for (const id of [PD, PS, PP, PR, PC, PX]) await invalid(send(s, id));
    await forbidden(send(s, PA, { permissions: [READ] })); await nf(send(s, PB2, BR1_ONLY));
    await expectLims(s.call(A, 'markPurchaseOrderSent', { params: { po_id: PA }, headers: ifm(9), body: sentBody() }), 'common.version_conflict', 409);
    expect((await dbPo(s, PA)).status).toBe('approved');
  });
});

describe.skipIf(!live)('T-11 #86cancel (AC-05.5, PE-1)', () => {
  run('draft: po.manage + reason code => cancelled; cancelled_at / cancelled_by / reason stored; a clerk without po.approve may cancel a draft', async (s) => {
    const r = await cancel(s, PD, { ...MANAGE_ONLY, actor: OTHER }, cancelBody({ reason_code: 'duplicate', reason_text: 'entered twice' }));
    expect(r.status).toBe(200); keysOk(r.body);
    expect(r.body).toMatchObject({ status: 'cancelled', cancel_reason_code: 'duplicate', cancel_reason_text: 'entered twice' }); expect(typeof r.body.cancelled_at).toBe('string');
    const row = await dbPo(s, PD); expect(row.cancelled_by).toBe(OTHER); expect(row.cancel_reason_code).toBe('duplicate');
  });
  run('approved / sent: ALSO needs inventory.po.approve (asserted for the PO branch, privileged: aal1 => auth.mfa_required); manager only => 403 auth.forbidden; both => cancelled', async (s) => {
    for (const id of [PA, PS]) {
      await forbidden(cancel(s, id, MANAGE_ONLY));
      await expectLims(cancel(s, id, { aal: 'aal1' }), 'auth.mfa_required', 403);
      expect((await dbPo(s, id)).status).not.toBe('cancelled');
      s.roleCalls.length = 0;
      const r = await cancel(s, id);
      expect(r.body.status).toBe('cancelled');
      expect(s.roleCalls.some((x) => x.permission === PO_APPROVE && x.branchId === BR1)).toBe(true);
      expect(s.roleCalls.some((x) => x.permission === PO_MANAGE && x.branchId === BR1)).toBe(true);
    }
  });
  run('a draft cancel does NOT ask for po.approve', async (s) => {
    await cancel(s, PD, MANAGE_ONLY);
    expect(s.roleCalls.some((x) => x.permission === PO_APPROVE)).toBe(false);
  });
  run('a PO with a posted receipt (partially_received / received) cannot be cancelled => 409 inventory.po_invalid_transition; closed / cancelled too (AC-05.7)', async (s) => {
    for (const id of [PP, PR, PC]) { await invalid(cancel(s, id)); expect((await dbPo(s, id)).status).not.toBe('cancelled'); }
    await invalid(cancel(s, PX));
    expect((await dbPo(s, PX)).status).toBe('cancelled');
  });
  run('an approved PO with a posted receipt (03-APP-FLOW §3.1 P7: no posted GRN references the PO) cannot be cancelled even though Σ received_qty_base is 0 => 409 inventory.po_invalid_transition; stays approved (AC-05.5)', async (s) => {
    await invalid(cancel(s, PG));
    expect((await dbPo(s, PG)).status).toBe('approved');
  });
  run('reason code must belong to reason group po_cancel: unknown, other group (spillage = wastage) and a po_close code => 422 inventory.reason_required; nothing changes', async (s) => {
    for (const code of ['not_a_reason', 'spillage', 'short_supply']) await expectLims(cancel(s, PD, undefined, cancelBody({ reason_code: code })), 'inventory.reason_required', 422);
    expect((await dbPo(s, PD)).status).toBe('draft');
    expect((await cancel(s, PD, undefined, cancelBody({ reason_code: 'no_longer_needed' }))).body.status).toBe('cancelled');
  });
  run('scope: BR2 PO as BR1 => 404; tenant B => 404; stale If-Match => 409 common.version_conflict', async (s) => {
    await nf(cancel(s, PB2, BR1_ONLY)); await nf(s.call(A, 'cancelPurchaseOrder', { params: { po_id: PO_B }, headers: hdr(1), body: cancelBody() }));
    await expectLims(s.call(A, 'cancelPurchaseOrder', { params: { po_id: PD }, headers: hdr(8), body: cancelBody() }), 'common.version_conflict', 409);
  });
});

describe.skipIf(!live)('T-11 #87close (AC-05.6)', () => {
  run('partially received + reason short_supply => closed; the OPEN line is closed-short, the fully received line is not; closed_at / closed_by / reason stored', async (s) => {
    const r = await close(s, PP2, { actor: OTHER }, closeBody({ reason_code: 'short_supply', reason_text: 'supplier short' }));
    expect(r.status).toBe(200); keysOk(r.body);
    expect(r.body).toMatchObject({ status: 'closed', close_reason_code: 'short_supply', close_reason_text: 'supplier short' }); expect(typeof r.body.closed_at).toBe('string');
    const byId = Object.fromEntries(r.body.lines.map((l: any) => [l.id, l]));
    expect(byId[L_PP2a].is_closed_short).toBe(false); expect(byId[L_PP2b].is_closed_short).toBe(true);
    const lines = await dbLines(s, PP2);
    expect(lines.find((l) => l.id === L_PP2b).is_closed_short).toBe(true); expect(lines.find((l) => l.id === L_PP2a).is_closed_short).toBe(false);
    expect((await dbPo(s, PP2)).closed_by).toBe(OTHER);
  });
  run('open quantity > 0 needs a reason: none => 422 inventory.reason_required; a code outside po_close (duplicate = po_cancel) => 422; unchanged', async (s) => {
    await expectLims(close(s, PP, undefined, {}), 'inventory.reason_required', 422);
    await expectLims(close(s, PP, undefined, closeBody({ reason_code: 'duplicate' })), 'inventory.reason_required', 422);
    await expectLims(close(s, PP, undefined, closeBody({ reason_code: 'not_a_reason' })), 'inventory.reason_required', 422);
    expect((await dbPo(s, PP)).status).toBe('partially_received'); expect((await dbLines(s, PP))[0].is_closed_short).toBe(false);
  });
  run('received (open quantity 0) closes without a reason; nothing is marked closed-short', async (s) => {
    const r = await close(s, PR, undefined, {});
    expect(r.body.status).toBe('closed'); expect(r.body.lines.every((l: any) => l.is_closed_short === false)).toBe(true);
  });
  run('forbidden: draft, approved, sent, closed, cancelled => 409 inventory.po_invalid_transition (a close of an unreceived PO is a cancel)', async (s) => {
    for (const id of [PD, PA, PS, PC, PX]) await invalid(close(s, id));
  });
  run('scope and gates: no po.manage => 403; BR2 PO as BR1 => 404; stale If-Match => 409', async (s) => {
    await forbidden(close(s, PP, { permissions: [READ] })); await nf(close(s, PB2, BR1_ONLY));
    await expectLims(s.call(A, 'closePurchaseOrder', { params: { po_id: PP }, headers: hdr(9), body: closeBody() }), 'common.version_conflict', 409);
  });
});

describe.skipIf(!live)('T-11 AC-05.7the whole forbidden-transition matrix of 03-APP-FLOW §3.1 returns 409 inventory.po_invalid_transition, with the row untouched', () => {
  const allowed: Record<string, string[]> = {
    draft: ['approve', 'replace', 'cancel'], approved: ['send', 'cancel'], sent: ['cancel'], partially_received: ['close'], received: ['close'], closed: [], cancelled: [],
  };
  const pos: Record<string, string> = { draft: PD, approved: PA, sent: PS, partially_received: PP, received: PR, closed: PC, cancelled: PX };
  const ops: Record<string, (s: Sess, id: string) => Promise<unknown>> = {
    approve: (s, id) => approve(s, id), send: (s, id) => send(s, id), cancel: (s, id) => cancel(s, id), close: (s, id) => close(s, id, undefined, closeBody()), replace: (s, id) => replace(s, id, [L1()]),
  };
  for (const [status, id] of Object.entries(pos)) {
    run(`${status}: ${Object.keys(ops).filter((o) => !(allowed[status] as string[]).includes(o)).join(', ') || '(none)'} are refused`, async (s) => {
      const before = await dbPo(s, id);
      for (const [op, fn] of Object.entries(ops)) {
        if ((allowed[status] as string[]).includes(op)) continue;
        await invalid(fn(s, id));
        const after = await dbPo(s, id);
        expect([after.status, after.version], `${status} + ${op}`).toEqual([before.status, before.version]);
      }
    });
  }
});

// =============================================================================================================== #88 reorder (AC-20.4)
describe.skipIf(!live)('T-11 #88createPurchaseOrdersFromReorder (AC-20.4)', () => {
  const lineOf = (po: any, itemId: string) => po.lines.find((l: any) => l.item_id === itemId);
  run('one draft PO per preferred supplier; qty = reorder_qty_base rounded UP to whole packs of the chosen supplier item (default pack if active, else the largest active qty_in_base)', async (s) => {
    const r = await s.call(A, 'createPurchaseOrdersFromReorder', { headers: idem(), body: reorderBody(R1) });
    expect(r.status).toBe(201);
    expect(onlyKeys(r.body, ['created', 'skipped'])).toEqual([]);
    for (const c of r.body.created) { expect(onlyKeys(c, SUMMARY_KEYS)).toEqual([]); expect(c).toMatchObject({ status: 'draft', source: 'reorder', store_id: R1, branch_id: BR1 }); }
    expect(r.body.created.map((c: any) => c.supplier_id).sort()).toEqual([SA, SB].sort());
    const pos: any[] = [];
    for (const c of r.body.created) pos.push((await get(s, c.id)).body); // sequential: one session/client, SAVEPOINTs must not interleave (ruling)
    const poA = pos.find((p: any) => p.supplier_id === SA), poB = pos.find((p: any) => p.supplier_id === SB);
    expect(poA.lines.length).toBe(2); expect(poB.lines.length).toBe(1);
    const l1 = lineOf(poA, Q1), l2 = lineOf(poA, Q2), l3 = lineOf(poB, Q3);
    expect([l1.pack_id, num(l1.qty_packs), num(l1.qty_base), l1.unit_price_paisa]).toEqual([QD, 3, 1200, 100]); // 900 / 400 = 2.25 => 3 packs of the DEFAULT pack, not the bigger 1000 pack
    expect([l2.pack_id, num(l2.qty_packs), num(l2.qty_base), l2.unit_price_paisa]).toEqual([Q2B, 3, 750, 95]); // default pack inactive => largest active (250): 600 / 250 = 2.4 => 3
    expect([l3.pack_id, num(l3.qty_packs), num(l3.qty_base), l3.unit_price_paisa]).toEqual([Q3P, 2, 100, 300]); // exactly 2 packs: no extra pack on an exact multiple
    for (const l of [l1, l2, l3]) expect([l.tax_code, l.tax_rate_bp, l.is_exempt]).toEqual(['VAT', 1300, false]);
    expect(poA.total_paisa).toBe(Math.round(3 * 100 * 1.13) + Math.round(3 * 95 * 1.13)); // net 300 + 285, vat 39 + 37 (half-up of 38.999.. / 37.05)
    expect(new Set(pos.map((p: any) => p.po_no)).size).toBe(2);
    expect(r.body.created.length).toBe(2);
  });
  run('skipped[] names every item not ordered with its reason: no_pack (preferred supplier, no active supplier item), no_preferred_supplier, not_below_reorder, open_po_exists', async (s) => {
    const r = await s.call(A, 'createPurchaseOrdersFromReorder', { headers: idem(), body: reorderBody(R1) });
    const sk = Object.fromEntries(r.body.skipped.map((x: any) => [x.item_id, x.reason]));
    for (const x of r.body.skipped) expect(onlyKeys(x, ['item_id', 'reason'])).toEqual([]);
    expect(sk[Q4]).toBe('no_pack'); expect(sk[Q5]).toBe('no_preferred_supplier'); expect(sk[Q6]).toBe('not_below_reorder'); expect(sk[Q7]).toBe('open_po_exists');
    for (const ordered of [Q1, Q2, Q3]) expect(sk[ordered]).toBeUndefined();
  });
  run('a second run finds the items on open drafts: nothing created, no empty PO, every item skipped (open_po_exists for Q1-Q3)', async (s) => {
    await s.call(A, 'createPurchaseOrdersFromReorder', { headers: idem(), body: reorderBody(R1) });
    const before = await count(s, `store_id = '${R1}'`);
    const r = await s.call(A, 'createPurchaseOrdersFromReorder', { headers: idem('syn-key-2'), body: reorderBody(R1) });
    expect(r.status).toBe(201);
    expect(r.body.created).toEqual([]); expect(await count(s, `store_id = '${R1}'`)).toBe(before);
    const sk = Object.fromEntries(r.body.skipped.map((x: any) => [x.item_id, x.reason]));
    expect([sk[Q1], sk[Q2], sk[Q3]]).toEqual(['open_po_exists', 'open_po_exists', 'open_po_exists']);
  });
  run('item_ids narrows the run: only Q1 is ordered (one PO, one line) and the other items are not reported', async (s) => {
    const r = await s.call(A, 'createPurchaseOrdersFromReorder', { headers: idem(), body: reorderBody(R1, { item_ids: [Q1] }) });
    expect(r.body.created.length).toBe(1);
    const po = (await get(s, r.body.created[0].id)).body;
    expect(po.lines.map((l: any) => l.item_id)).toEqual([Q1]); expect(r.body.skipped).toEqual([]); // only the requested items are judged
    const none = await s.call(A, 'createPurchaseOrdersFromReorder', { headers: idem('syn-key-3'), body: reorderBody(R1, { item_ids: [Q6] }) });
    expect(none.body.created).toEqual([]); expect(none.body.skipped).toEqual([{ item_id: Q6, reason: 'not_below_reorder' }]);
  });
  run('a tax_config_missing from the port aborts the whole run: no PO of the run exists afterwards (P-23)', async (s) => {
    const before = await count(s, `store_id = '${R1}'`);
    await expectLims(s.call(A, 'createPurchaseOrdersFromReorder', { headers: idem(), body: reorderBody(R1) }, { rates: {} }), 'catalog.tax_config_missing', 422);
    expect(await count(s, `store_id = '${R1}'`)).toBe(before);
  });
  run('scope: no po.manage => 403 (asserted for the store branch); a BR2-only user on a BR1 store => 404; tenant B store => 404; PE-3: no cost.read => no total_paisa on created rows', async (s) => {
    await forbidden(s.call(A, 'createPurchaseOrdersFromReorder', { headers: idem(), body: reorderBody(R1) }, { permissions: [READ] }));
    expect(s.roleCalls.some((r) => r.permission === PO_MANAGE && r.branchId === BR1)).toBe(true);
    await nf(s.call(A, 'createPurchaseOrdersFromReorder', { headers: idem(), body: reorderBody(R1) }, BR2_ONLY));
    await nf(s.call(A, 'createPurchaseOrdersFromReorder', { headers: idem(), body: reorderBody(STORE_B) }));
    const r = await s.call(A, 'createPurchaseOrdersFromReorder', { headers: idem(), body: reorderBody(R1) }, NO_COST);
    expect(r.body.created.length).toBe(2); expect(r.body.created.every((c: any) => !('total_paisa' in c))).toBe(true);
  });
  run('items outside the tenant in item_ids are not ordered and create nothing in either tenant', async (s) => {
    const before = await count(s);
    const e: any = await s.call(A, 'createPurchaseOrdersFromReorder', { headers: idem(), body: reorderBody(R1, { item_ids: [ITEM_B] }) }).catch((x) => x);
    if (e instanceof LimsError) expect([400, 404, 422]).toContain(e.statusCode); else expect(e.body.created).toEqual([]);
    expect(await count(s)).toBe(before);
  });
});

// =============================================================================================================== #89 print view
describe.skipIf(!live)('T-11 #89getPurchaseOrderPrintView', () => {
  run('draft => is_draft true; approved => false; strict keys; tenant display name from ctx.core.tenant; supplier block has no contact data; lines carry code / name / pack label and no removed lines', async (s) => {
    const dn = (await s.sql(A, 'SELECT display_name FROM core.tenants WHERE id = $1', [A]))[0].display_name;
    const d = (await s.call(A, 'getPurchaseOrderPrintView', { params: { po_id: PD } })).body;
    expect(onlyKeys(d, PRINT_KEYS)).toEqual([]); expect(d.is_draft).toBe(true); expect(d.status).toBe('draft'); expect(d.tenant_display_name).toBe(dn);
    expect(typeof d.branch_name).toBe('string'); expect(d.branch_name.length).toBeGreaterThan(0);
    expect(d.supplier).toMatchObject({ supplier_code: 'T11-SA', name: 'T11 Alpha' }); expect(onlyKeys(d.supplier, ['supplier_code', 'name', 'pan_text', 'address_text'])).toEqual([]);
    expect(JSON.stringify(d)).not.toMatch(/syn@example|000-000|created_by|tenant_id/);
    expect(d.lines.length).toBe(2);
    for (const l of d.lines) expect(onlyKeys(l, PRINT_LINE_KEYS)).toEqual([]);
    expect(d.lines[0]).toMatchObject({ line_no: 1, item_code: 'T11-I1', item_name: 'T11 T11-I1', pack_label: 'Pack BOX', unit_price_paisa: 1000, discount_paisa: 0, is_exempt: true, line_total_paisa: 1000 }); // fixture lines have tax_code NULL = exempt (D-70)
    expect('tax_code' in d.lines[0]).toBe(false);
    expect((await s.call(A, 'getPurchaseOrderPrintView', { params: { po_id: PA } })).body.is_draft).toBe(false);
    expect((await s.call(A, 'getPurchaseOrderPrintView', { params: { po_id: PE } })).body.lines).toEqual([]);
  });
  run('totals and exempt lines on the printout match the Po: exempt line has is_exempt true and no tax_code key', async (s) => {
    const po = await mk(s, [L1({ unit_price_paisa: 50 }), L1({ is_exempt: true, unit_price_paisa: 20 })]);
    const p = (await s.call(A, 'getPurchaseOrderPrintView', { params: { po_id: po.id } })).body;
    expect([p.subtotal_paisa, p.discount_paisa, p.net_paisa, p.vat_paisa, p.total_paisa]).toEqual([po.subtotal_paisa, po.discount_paisa, po.net_paisa, po.vat_paisa, po.total_paisa]);
    expect('tax_code' in p.lines[1]).toBe(false); expect(p.lines[1].is_exempt).toBe(true); expect(p.lines[0].tax_code).toBe('VAT');
  });
  run('needs inventory.cost.read AND inventory.item.read: either missing => 403 auth.forbidden; BR2 PO as BR1 => 404 (before the permission); tenant B => 404', async (s) => {
    await forbidden(s.call(A, 'getPurchaseOrderPrintView', { params: { po_id: PD } }, { permissions: [READ, PO_MANAGE] }));
    await forbidden(s.call(A, 'getPurchaseOrderPrintView', { params: { po_id: PD } }, { permissions: [COST] }));
    await nf(s.call(A, 'getPurchaseOrderPrintView', { params: { po_id: PB2 } }, { ...BR1_ONLY, permissions: [] }));
    await nf(s.call(A, 'getPurchaseOrderPrintView', { params: { po_id: PO_B } }));
  });
});

// =============================================================================================================== tenant probes
describe.skipIf(!live)('T-11 probes:tenant isolation and server authority', () => {
  run('P-T5: under tenant A claims no tenant B PO or line is visible; under B claims no A PO is visible; a B-tenant insert from A claims is refused', async (s) => {
    expect(Number((await s.sql(A, 'SELECT count(*)::int AS n FROM inventory.purchase_orders WHERE tenant_id = $1', [B]))[0].n)).toBe(0);
    expect(Number((await s.sql(A, 'SELECT count(*)::int AS n FROM inventory.purchase_order_lines WHERE tenant_id = $1', [B]))[0].n)).toBe(0);
    expect(Number((await s.sql(B, 'SELECT count(*)::int AS n FROM inventory.purchase_orders WHERE tenant_id = $1', [A]))[0].n)).toBe(0);
    await s.raw('SAVEPOINT p_t5');
    await expect(s.raw(`INSERT INTO inventory.purchase_orders (id, tenant_id, po_no, branch_id, store_id, supplier_id, created_by, updated_by) VALUES ($1, $2, 'T11-X', $3, $4, $5, $6, $6)`, [uid(16990), B, BR1, P1, SA, SYS])).rejects.toBeTruthy();
    await s.raw('ROLLBACK TO SAVEPOINT p_t5');
  });
  run('IT-1: lims_api cannot DELETE purchase_order_lines or purchase_orders (D-71: lines are soft-removed only)', async (s) => {
    const r = await s.sql(A, `SELECT has_table_privilege(current_user, 'inventory.purchase_order_lines', 'DELETE') AS l, has_table_privilege(current_user, 'inventory.purchase_orders', 'DELETE') AS h`);
    expect(r[0]).toEqual({ l: false, h: false });
  });
  run('P-T3: a B-tenant PO id handed to every PO-id operation is 404 and the B row is unchanged', async (s) => {
    const o = { actor: APPROVER };
    const tries: [string, Record<string, unknown>][] = [
      ['getPurchaseOrder', {}], ['replacePurchaseOrderDraft', { headers: ifm(1), body: newPo(SA, P1, [L1()]) }], ['approvePurchaseOrder', { headers: hdr(1) }], ['markPurchaseOrderSent', { headers: hdr(1), body: sentBody() }],
      ['cancelPurchaseOrder', { headers: hdr(1), body: cancelBody() }], ['closePurchaseOrder', { headers: hdr(1), body: closeBody() }], ['getPurchaseOrderPrintView', {}],
    ];
    for (const [op, req] of tries) await nf(s.call(A, op, { params: { po_id: PO_B }, ...req }, o));
    expect((await s.sql(B, 'SELECT status, version FROM inventory.purchase_orders WHERE id = $1', [PO_B]))[0]).toEqual({ status: 'draft', version: 1 });
  });
});

// =============================================================================================================== races (committed)
describe.skipIf(!live)('T-11 races(committed transactions, own POs in store P1)', () => {
  const newDraft = () => committed((s) => mk(s, [L1()], { actor: OTHER }));
  it('4 concurrent approvals of one draft (same If-Match): exactly one succeeds; the others are 409 inventory.po_invalid_transition; approved once', async () => {
    const po = await newDraft();
    const rs = await Promise.allSettled([1, 2, 3, 4].map(() => committed((s) => s.call(A, 'approvePurchaseOrder', { params: { po_id: po.id }, headers: hdr(po.version) }, { actor: APPROVER }))));
    expect(rs.filter((r) => r.status === 'fulfilled').length).toBe(1);
    for (const r of rs) if (r.status === 'rejected') { expect(r.reason.code).toBe('inventory.po_invalid_transition'); expect(r.reason.statusCode).toBe(409); }
    const row = (await admin.query('SELECT status, version FROM inventory.purchase_orders WHERE id = $1', [po.id])).rows[0];
    expect(row).toEqual({ status: 'approved', version: po.version + 1 });
  });
  it('approve and cancel race on one draft: exactly one wins and the final status matches the winner (never approved AND cancelled)', async () => {
    const po = await newDraft();
    const rs = await Promise.allSettled([
      committed((s) => s.call(A, 'approvePurchaseOrder', { params: { po_id: po.id }, headers: hdr(po.version) }, { actor: APPROVER })),
      committed((s) => s.call(A, 'cancelPurchaseOrder', { params: { po_id: po.id }, headers: hdr(po.version), body: cancelBody() })),
    ]);
    expect(rs.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const lose = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(['inventory.po_invalid_transition', 'common.version_conflict']).toContain(lose.reason.code);
    const win = rs.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>;
    expect((await admin.query('SELECT status FROM inventory.purchase_orders WHERE id = $1', [po.id])).rows[0].status).toBe(win.value.body.status);
  });
  it('3 concurrent replaces with the same If-Match: exactly one wins (the others 409 common.version_conflict); exactly the winner\'s lines are current', async () => {
    const po = await newDraft();
    const rs = await Promise.allSettled([1, 2, 3].map((n) => committed((s) => s.call(A, 'replacePurchaseOrderDraft', { params: { po_id: po.id }, headers: ifm(po.version), body: newPo(SA, P1, Array.from({ length: n }, () => L1())) }))));
    expect(rs.filter((r) => r.status === 'fulfilled').length).toBe(1);
    for (const r of rs) if (r.status === 'rejected') expect(r.reason.code).toBe('common.version_conflict');
    const win = rs.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>;
    const cur = (await admin.query('SELECT line_no FROM inventory.purchase_order_lines WHERE po_id = $1 AND removed_at IS NULL ORDER BY line_no', [po.id])).rows.map((r) => r.line_no);
    expect(cur).toEqual(win.value.body.lines.map((l: any) => l.line_no));
  });
  it('8 concurrent creates: all succeed with 8 distinct, well-formed po_no values', async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, () => committed((s) => mk(s, [L1()]))));
    const nos = rs.map((r) => r.po_no);
    expect(new Set(nos).size).toBe(8); for (const n of nos) expect(n).toMatch(PO_NO);
  });
});
