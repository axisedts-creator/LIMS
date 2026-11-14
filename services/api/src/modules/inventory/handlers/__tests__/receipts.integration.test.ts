// C12.T-12 integration + probes for #49-#55 on the migrated database as role lims_api with RLS on (REAL T-03 repositories, handlers/index.ts, T-04 scope service, T-05 ledger, T-11 purchasing for PO read-back).
// The tax rate comes from a FAKE CatalogPort.getTaxRate (receipts.helpers.ts -> makePoCtx: VAT 1300 bp, LOCALTAX 500 bp, anything else => catalog.tax_config_missing); C3 itself is not under test.
// Harness: tests/db/c12-t12/run.sh (clone of c12-t11: pinned image, migrations, seeds, inventory DDL, exports LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL / LIMS_C12T03_REQUIRE_DB=1).
// Fixtures: tests/db/c12-t03/fixtures.sql (store 1001 MAIN-A with open count 8901, draft GRN 8001 with lines 8201 / 8203 and REMOVED 8202, posted GRN 8002, tenant B: store 1101, supplier 3101, item 2101, pack 2301,
//   lot 4101, draft GRN 8101, cs_tax_codes LOCALTAX) + EXTRAS below (ids 17xxx, committed once with the superuser, ON CONFLICT DO NOTHING).
// Each test = one request-shaped transaction that is ROLLED BACK; every handler call runs inside a SAVEPOINT. The race tests commit (own store G3 / fresh rows) and never touch other fixtures.
// Without the URLs the DB tests skip, except under LIMS_C12T03_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails.
// EXTRAS (tenant A): stores G1 (BR1) G2 (BR2) G3 (BR1, races); suppliers SA SB SIN (inactive) SX (name starts with '='); items H1 (lot tracked + expiry; packs K1 BOX 400, K2 KIT 100) H2 (unlotted, pack K3 = 10,
//   default tax LOCALTAX) H3 (lot tracked, expiry optional; pack K4 = 20) H4 (unlotted; pack K5 = 10; reorder level 500, balance 100, OPEN below_reorder alert in G1); supplier items (SA,H1,K1) 5000 | (SA,H1,K2) 1200
//   LOCALTAX | (SA,H2,K3) 700 | (SA,H3,K4) 300; tax code NORATE (no C3 rate). POs in G1 (supplier SA): POS sent (line H1 2 BOX = 800) POA approved (2 BOX; one REMOVED line) POM approved (H1 1 BOX + H3 1 BOX) PD draft
//   PR received PC closed PX cancelled PP partially_received (100 of 400); PB2 sent in G2 / BR2. Export fixtures (fixed posted_at, window [2026-03-01, 2026-04-01)): X0 posted exactly at the window start (G1), X1 (G1, 5 lines,
//   supplier name '=...', lot numbers that start with = + - @ '), X2 (G2 / BR2), X3 posted exactly at the window end (excluded), X7 one second before the start (excluded), X4 draft, X5 cancelled, X6 tenant B posted (excluded).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import {
  A, ADJUST, B, BR1, BR2, COST, COST_FIELD, CSV_COLUMNS, EXPORT, GRN_KEYS, GRN_LINE_KEYS, GRN_NO, GRN_SUMMARY_KEYS, LEAK, MANAGE, MOVEMENT_KEYS, PO_MANAGE, READ, SYS, addDays, bodyText, call, cancelGrnBody,
  csvObjects, deepKeys, expectLims, gLine, hdr, headerOf, idem, ifm, makeGrnCtx, onlyKeys, openingGrn, qty, rej, replaceBody, uid, window, ymdIn, type PoOpts,
} from './receipts.helpers.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

// fixtures (T-03)
const MAIN = uid(1001), GRN_FX = uid(8001), GRN_FX_L1 = uid(8201), GRN_FX_L3 = uid(8203), STORE_B = uid(1101), SUP_B = uid(3101), ITEM_B = uid(2101), PACK_B = uid(2301), GRN_B = uid(8101);
// extras
const KT = 'Asia/Kathmandu', TODAY = ymdIn(KT);
const G1 = uid(17001), G2 = uid(17002), G3 = uid(17003);
const SA = uid(17301), SB = uid(17302), SIN = uid(17303), SX = uid(17304);
const H1 = uid(17101), H2 = uid(17102), H3 = uid(17103), H4 = uid(17104);
const K1 = uid(17201), K2 = uid(17202), K3 = uid(17203), K4 = uid(17204), K5 = uid(17205);
const POS = uid(17410), POA = uid(17411), POM = uid(17412), PD = uid(17413), PR = uid(17414), PC = uid(17415), PX = uid(17416), PP = uid(17417), PB2 = uid(17418);
const L_POS = uid(17510), L_POA = uid(17511), L_POM1 = uid(17512), L_POM2 = uid(17513), L_PD = uid(17514), L_PR = uid(17515), L_PC = uid(17516), L_PX = uid(17517), L_PP = uid(17518), L_PB2 = uid(17519), L_POA_REMOVED = uid(17520);
const OTHER = uid(17900);
const BR1_ONLY: PoOpts = { all: false, branchIds: [BR1] };
const BR2_ONLY: PoOpts = { all: false, branchIds: [BR2] };
const NO_COST: PoOpts = { permissions: [READ, MANAGE, ADJUST, PO_MANAGE, EXPORT] };
const NO_ADJUST: PoOpts = { permissions: [READ, MANAGE, COST] };
const READ_ONLY: PoOpts = { permissions: [READ] };

type V = string | number | boolean | null | { sql: string };
const lit = (v: V): string => (v === null ? 'NULL' : typeof v === 'object' ? v.sql : typeof v === 'number' || typeof v === 'boolean' ? String(v) : `'${v.replace(/'/g, "''")}'`);
const ins = (table: string, row: Record<string, V>): string => {
  const r: Record<string, V> = { tenant_id: A, ...row };
  if (!('created_by' in r) && !table.endsWith('g_cs_reasons')) { r['created_by'] = SYS; r['updated_by'] = SYS; }
  return `INSERT INTO inventory.${table} (${Object.keys(r).join(', ')}) VALUES (${Object.values(r).map(lit).join(', ')}) ON CONFLICT DO NOTHING;`;
};
const store = (id: string, br: string, code: string) => ins('stores', { id, branch_id: br, store_code: code, name: `Store ${code}`, store_kind: 'main', is_default_consumption: false, is_active: true });
const item = (id: string, code: string, extra: Record<string, V> = {}) => ins('items', { id, item_code: code, name: `T12 ${code}`, category: 'reagent', base_uom_code: 'test', is_lot_tracked: false, requires_expiry: false, ...extra });
const pack = (id: string, itemId: string, code: string, q: number, dflt: boolean) => ins('item_packs', { id, item_id: itemId, pack_code: code, label: `Pack ${code}`, uom_code: 'box', qty_in_base: q, is_purchase_default: dflt, is_active: true });
const sitem = (n: number, sup: string, itemId: string, packId: string, price: number, tax: string | null = null) =>
  ins('supplier_items', { id: uid(17600 + n), supplier_id: sup, item_id: itemId, pack_id: packId, last_unit_price_paisa: price, default_tax_code: tax });
const poRow = (id: string, no: string, st: string, br: string, status: string) => {
  const life: Record<string, V> = status === 'draft' ? {} : { approved_at: { sql: "now() - interval '1 day'" }, approved_by: SYS };
  if (status === 'sent') Object.assign(life, { sent_at: { sql: "now() - interval '1 day'" }, sent_by: SYS, sent_channel: 'email' });
  if (status === 'closed') Object.assign(life, { closed_at: { sql: 'now()' }, closed_by: SYS, close_reason_code: 'short_supply' });
  if (status === 'cancelled') Object.assign(life, { cancelled_at: { sql: 'now()' }, cancelled_by: SYS, cancel_reason_code: 'duplicate' });
  return ins('purchase_orders', { id, po_no: no, branch_id: br, store_id: st, supplier_id: SA, status, source: 'manual', ...life });
};
const pol = (id: string, po: string, n: number, itemId: string, packId: string, packs: number, snap: number, recv = 0, o: Record<string, V> = {}) =>
  ins('purchase_order_lines', { id, po_id: po, line_no: n, item_id: itemId, pack_id: packId, qty_packs: packs, qty_in_base_snapshot: snap, qty_base: packs * snap, unit_price_paisa: 1000, discount_paisa: 0, tax_code: null, tax_rate_bp: 0,
    net_paisa: 1000 * packs, vat_paisa: 0, line_total_paisa: 1000 * packs, received_qty_base: recv, ...o });
const lotRow = (id: string, itemId: string, no: string) => ins('lots', { id, item_id: itemId, lot_no: no, expiry_on: '2027-06-30', status: 'available' });
const grnRow = (id: string, no: string, st: string, sup: string, status: string, receivedAt: string, postedAt: string | null, o: Record<string, V> = {}) =>
  ins('goods_receipts', { id, grn_no: no, kind: 'purchase', store_id: st, supplier_id: sup, status, received_at: receivedAt, posted_at: postedAt, posted_by: postedAt ? SYS : null, net_paisa: 1000, vat_paisa: 0, total_paisa: 1000, ...o });
const grnLine = (id: string, grn: string, n: number, itemId: string, packId: string, lot: string, lotNo: string, o: Record<string, V> = {}) =>
  ins('goods_receipt_lines', { id, grn_id: grn, line_no: n, item_id: itemId, pack_id: packId, qty_packs: 1, qty_in_base_snapshot: 400, qty_base: 400, lot_no: lotNo, expiry_on: '2027-06-30', lot_id: lot, unit_price_paisa: 1000, discount_paisa: 0,
    tax_code: null, tax_rate_bp: 0, net_paisa: 1000, vat_paisa: 0, line_total_paisa: 1000, capitalised_value_paisa: 1000, ...o });
const LOTS: [string, string, string][] = [[uid(17220), H1, 'T12-X0L'], [uid(17221), H1, '=SUM(1+1)'], [uid(17222), H1, '+1+1'], [uid(17223), H1, '-2+3'], [uid(17224), H1, '@SUM(A1)'], [uid(17225), H1, "'quoted"],
  [uid(17226), H1, 'T12-X2L'], [uid(17227), H1, 'T12-X3L'], [uid(17228), H1, 'T12-X7L'], [uid(17229), H1, 'T12-X4L'], [uid(17230), H1, 'T12-X5L']];
const [LX0, LX1, LX2, LX3, LX4, LX5, LX6, LX7, LX8, LX9, LX10] = LOTS.map((l) => l[0]) as [string, string, string, string, string, string, string, string, string, string, string];
const EXTRAS = `
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT set_config('request.jwt.claims', '{"tenant_id":"${A}","sub":"${SYS}","actor_type":"system"}', true);
INSERT INTO inventory.g_cs_reasons (id, reason_group, code, display) VALUES
  ('${uid(17901)}', 'po_cancel', 'no_longer_needed', 'No longer needed'), ('${uid(17902)}', 'po_cancel', 'duplicate', 'Duplicate'), ('${uid(17903)}', 'po_close', 'short_supply', 'Short supply') ON CONFLICT DO NOTHING;
${ins('cs_tax_codes', { id: uid(17911), code: 'NORATE', display: 'NORATE', is_active: true })}
${[store(G1, BR1, 'T12-G1'), store(G2, BR2, 'T12-G2'), store(G3, BR1, 'T12-G3')].join('\n')}
${[[SA, 'T12-SA', 'T12 Alpha', true], [SB, 'T12-SB', 'T12 Beta', true], [SIN, 'T12-SIN', 'T12 Old', false], [SX, 'T12-SX', '=HYPERLINK("http://x.example")', true]]
  .map(([id, code, name, act]) => ins('suppliers', { id: id as string, supplier_code: code as string, name: name as string, is_active: act as boolean, address_text: 'Synthetic street 1', email: 'syn@example.test', phone_display: '000-000' })).join('\n')}
${[item(H1, 'T12-H1', { is_lot_tracked: true, requires_expiry: true }), item(H2, 'T12-H2', { default_tax_code: 'LOCALTAX' }), item(H3, 'T12-H3', { is_lot_tracked: true, requires_expiry: false }), item(H4, 'T12-H4')].join('\n')}
${[pack(K1, H1, 'BOX', 400, true), pack(K2, H1, 'KIT', 100, false), pack(K3, H2, 'BX', 10, true), pack(K4, H3, 'BX', 20, true), pack(K5, H4, 'BX', 10, true)].join('\n')}
${[sitem(1, SA, H1, K1, 5000), sitem(2, SA, H1, K2, 1200, 'LOCALTAX'), sitem(3, SA, H2, K3, 700), sitem(4, SA, H3, K4, 300)].join('\n')}
${ins('store_item_settings', { id: uid(17701), store_id: G1, item_id: H4, reorder_level_base: 500, reorder_qty_base: 600, preferred_supplier_id: SA, is_active: true })}
${ins('stock_balances', { id: uid(17801), store_id: G1, item_id: H4, lot_id: null, qty_base: 100, value_paisa: 1000, last_movement_at: { sql: 'now()' } })}
${ins('alerts', { id: uid(17851), alert_kind: 'below_reorder', store_id: G1, item_id: H4, dedupe_key: `below_reorder:${G1}:${H4}`, status: 'open', first_raised_at: { sql: 'now()' }, last_raised_at: { sql: 'now()' }, occurrences: 1 })}
${[poRow(POS, 'T12-POS', G1, BR1, 'sent'), poRow(POA, 'T12-POA', G1, BR1, 'approved'), poRow(POM, 'T12-POM', G1, BR1, 'approved'), poRow(PD, 'T12-PD', G1, BR1, 'draft'), poRow(PR, 'T12-PR', G1, BR1, 'received'),
   poRow(PC, 'T12-PC', G1, BR1, 'closed'), poRow(PX, 'T12-PX', G1, BR1, 'cancelled'), poRow(PP, 'T12-PP', G1, BR1, 'partially_received'), poRow(PB2, 'T12-PB2', G2, BR2, 'sent')].join('\n')}
${[pol(L_POS, POS, 1, H1, K1, 2, 400), pol(L_POA, POA, 1, H1, K1, 2, 400), pol(L_POA_REMOVED, POA, 2, H1, K1, 1, 400, 0, { removed_at: { sql: 'now()' }, removed_by: SYS }), pol(L_POM1, POM, 1, H1, K1, 1, 400), pol(L_POM2, POM, 2, H3, K4, 1, 20),
   pol(L_PD, PD, 1, H1, K1, 1, 400), pol(L_PR, PR, 1, H1, K1, 1, 400, 400), pol(L_PC, PC, 1, H1, K1, 1, 400, 400), pol(L_PX, PX, 1, H1, K1, 1, 400), pol(L_PP, PP, 1, H1, K1, 1, 400, 100), pol(L_PB2, PB2, 1, H1, K1, 1, 400)].join('\n')}
${LOTS.map(([id, it, no]) => lotRow(id, it, no)).join('\n')}
${[grnRow(uid(17610), 'GR260017010', G1, SA, 'posted', '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z'),
   grnRow(uid(17611), 'GR260017011', G1, SX, 'posted', '2026-03-10T10:00:00Z', '2026-03-10T10:00:00Z', { net_paisa: 6500, vat_paisa: 325, total_paisa: 6825 }),
   grnRow(uid(17612), 'GR260017012', G2, SA, 'posted', '2026-03-15T00:00:00Z', '2026-03-15T00:00:00Z'),
   grnRow(uid(17613), 'GR260017013', G1, SA, 'posted', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z'),
   grnRow(uid(17614), 'GR260017014', G1, SA, 'posted', '2026-02-28T23:59:59Z', '2026-02-28T23:59:59Z'),
   grnRow(uid(17615), 'GR260017015', G1, SA, 'draft', '2026-03-12T00:00:00Z', null),
   grnRow(uid(17616), 'GR260017016', G1, SA, 'cancelled', '2026-03-12T00:00:00Z', null, { cancelled_at: { sql: 'now()' }, cancelled_by: SYS, cancel_reason_text: 'synthetic' }),
   grnRow(uid(17617), 'GR260017017', STORE_B, SUP_B, 'posted', '2026-03-12T00:00:00Z', '2026-03-12T00:00:00Z', { tenant_id: B })].join('\n')}
${[grnLine(uid(17620), uid(17610), 1, H1, K1, LX0, 'T12-X0L'),
   grnLine(uid(17621), uid(17611), 1, H1, K1, LX1, '=SUM(1+1)', { qty_packs: 2.5, qty_base: 1000, unit_price_paisa: 1001, discount_paisa: 3, tax_code: 'VAT', tax_rate_bp: 1300, net_paisa: 2500, vat_paisa: 325, line_total_paisa: 2825, capitalised_value_paisa: 2825 }),
   grnLine(uid(17622), uid(17611), 2, H1, K1, LX2, '+1+1'), grnLine(uid(17623), uid(17611), 3, H1, K1, LX3, '-2+3'), grnLine(uid(17624), uid(17611), 4, H1, K1, LX4, '@SUM(A1)'), grnLine(uid(17625), uid(17611), 5, H1, K1, LX5, "'quoted"),
   grnLine(uid(17626), uid(17612), 1, H1, K1, LX6, 'T12-X2L'), grnLine(uid(17627), uid(17613), 1, H1, K1, LX7, 'T12-X3L'), grnLine(uid(17628), uid(17614), 1, H1, K1, LX8, 'T12-X7L'),
   grnLine(uid(17629), uid(17615), 1, H1, K1, LX9, 'T12-X4L'), grnLine(uid(17630), uid(17616), 1, H1, K1, LX10, 'T12-X5L'),
   ins('goods_receipt_lines', { tenant_id: B, id: uid(17631), grn_id: uid(17617), line_no: 1, item_id: ITEM_B, pack_id: PACK_B, qty_packs: 1, qty_in_base_snapshot: 400, qty_base: 400, lot_no: 'T12-BLOT', expiry_on: '2027-06-30', lot_id: null,
     unit_price_paisa: 1000, discount_paisa: 0, tax_code: null, tax_rate_bp: 0, net_paisa: 1000, vat_paisa: 0, line_total_paisa: 1000, capitalised_value_paisa: 1000 })].join('\n')}
COMMIT;`;
const adminBlock = (sql: string, tenant = A) => `BEGIN; SET LOCAL session_replication_role = replica; SELECT set_config('request.jwt.claims', '{"tenant_id":"${tenant}","sub":"${SYS}","actor_type":"system"}', true); ${sql} COMMIT;`;

const hasTrigger = live && await (async () => {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  try { await c.connect(); return (await c.query("SELECT 1 FROM pg_proc WHERE proname = 'tg_line_guard'")).rowCount === 1; } catch { return false; } finally { await c.end().catch(() => undefined); }
})();

let api: pg.Pool;
let admin: pg.Pool;
beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 12 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c12-t03/fixtures.sql', import.meta.url)), 'utf8'));
  await admin.query(EXTRAS);
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-12 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

interface Sess {
  call(t: string, op: string, req?: Parameters<typeof call>[2], o?: PoOpts): Promise<{ status: number; body: any; headers?: Record<string, string> }>;
  sql(t: string, text: string, v?: unknown[]): Promise<any[]>;
  roleCalls: any[]; taxCalls: { taxCode: string; on: string }[]; audit: any[];
}
const claims = (t: string) => JSON.stringify({ tenant_id: t, sub: SYS, actor_type: 'system' });
type Client = pg.PoolClient;
function sessionOn(client: Client): Sess {
  let n = 0;
  const roleCalls: any[] = []; const taxCalls: { taxCode: string; on: string }[] = []; const audit: any[] = [];
  const tx = { query: (t: string, v?: unknown[]) => client.query(t, v) };
  return {
    roleCalls, taxCalls, audit,
    async sql(t, text, v) { await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]); return (await client.query(text, v)).rows; },
    async call(t, op, req, o) {
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]);
      const st = makeGrnCtx(tx, t, o ?? {});
      const sp = `t12_h${++n}`;
      await client.query(`SAVEPOINT ${sp}`);
      const keep = () => { roleCalls.push(...st.roleCalls); taxCalls.push(...st.taxCalls); audit.push(...st.audit); };
      try { const r = await call(op, st.ctx, req); keep(); await client.query(`RELEASE SAVEPOINT ${sp}`); return r; }
      catch (e) { keep(); await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
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
const num = (v: unknown) => Number(v);
const nf = (p: Promise<unknown>) => expectLims(p, 'common.not_found', 404);
const forbidden = (p: Promise<unknown>) => expectLims(p, 'auth.forbidden', 403);
const docInvalid = (p: Promise<unknown>) => expectLims(p, 'inventory.document_invalid_transition', 409);
const clean = (b: Record<string, unknown>) => Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
/** An exempt receipt line (no tax call, capitalised value = net) of item H1. */
const E1 = (over: Record<string, unknown> = {}) => gLine(H1, K1, '1', { unit_price_paisa: 1000, is_exempt: true, ...over });
const lotLine = (no: string, days = 365, over: Record<string, unknown> = {}) => E1({ lot_no: no, expiry_on: addDays(TODAY, days), ...over });
const mk = async (s: Sess, lines: Record<string, unknown>[] = [lotLine('T12-L1')], over: Record<string, unknown> = {}, o?: PoOpts, st = G1) =>
  (await s.call(A, 'createGoodsReceipt', { headers: idem(), body: clean({ kind: 'purchase', store_id: st, supplier_id: SA, lines, ...over }) }, o)).body;
const mkOpen = async (s: Sess, lines: Record<string, unknown>[], over: Record<string, unknown> = {}, o?: PoOpts, st = G1) =>
  (await s.call(A, 'createGoodsReceipt', { headers: idem(), body: clean({ ...openingGrn(st, lines), ...over }) }, o)).body;
const dbGrn = async (s: Sess, id: string) => (await s.sql(A, 'SELECT * FROM inventory.goods_receipts WHERE tenant_id = $1 AND id = $2', [A, id]))[0];
const ver = async (s: Sess, id: string) => num((await dbGrn(s, id)).version);
const dbLines = (s: Sess, id: string) => s.sql(A, 'SELECT * FROM inventory.goods_receipt_lines WHERE tenant_id = $1 AND grn_id = $2 ORDER BY removed_at NULLS LAST, line_no, created_at', [A, id]);
const post = async (s: Sess, id: string, o?: PoOpts, version?: number, key = 'syn-key-post') => s.call(A, 'postGoodsReceipt', { params: { grn_id: id }, headers: hdr(version ?? await ver(s, id), key) }, o);
const cancel = async (s: Sess, id: string, o?: PoOpts, body = cancelGrnBody()) => s.call(A, 'cancelGoodsReceipt', { params: { grn_id: id }, headers: hdr(await ver(s, id)), body }, o);
const replace = async (s: Sess, id: string, lines: Record<string, unknown>[], o?: PoOpts, over: Record<string, unknown> = {}) =>
  s.call(A, 'replaceGoodsReceiptDraft', { params: { grn_id: id }, headers: ifm(await ver(s, id)), body: clean(replaceBody(lines, { supplier_id: SA, ...over })) }, o);
const get = (s: Sess, id: string, o?: PoOpts, t = A) => s.call(t, 'getGoodsReceipt', { params: { grn_id: id } }, o);
const lotOf = async (s: Sess, itemId: string, no: string) => (await s.sql(A, 'SELECT id, lot_no, expiry_on::text AS expiry_on, status, last_receipt_qty_base::text AS lq, last_receipt_value_paisa::text AS lv FROM inventory.lots WHERE tenant_id = $1 AND item_id = $2 AND lot_no = $3', [A, itemId, no]))[0];
const bal = async (s: Sess, st: string, itemId: string, lot: string | null) => {
  const r = (await s.sql(A, 'SELECT qty_base::text AS q, value_paisa::text AS v FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id IS NOT DISTINCT FROM $4::uuid', [A, st, itemId, lot]))[0];
  return r ? { q: num(r.q), v: num(r.v) } : null;
};
const mvs = (s: Sess, grnId: string) => s.sql(A, `SELECT id, movement_kind, qty_base::text AS q, value_paisa::text AS v, value_basis, doc_type, doc_line_id, lot_id, store_id, item_id, business_date::text AS bd, balance_qty_after::text AS ba
  FROM inventory.stock_movements WHERE tenant_id = $1 AND doc_id = $2 ORDER BY occurred_at, id`, [A, grnId]);
const poState = async (s: Sess, id: string) => {
  const po = (await s.sql(A, 'SELECT status, version FROM inventory.purchase_orders WHERE tenant_id = $1 AND id = $2', [A, id]))[0];
  const lines = await s.sql(A, 'SELECT id, received_qty_base::text AS recv FROM inventory.purchase_order_lines WHERE tenant_id = $1 AND po_id = $2 AND removed_at IS NULL ORDER BY line_no', [A, id]);
  return { status: po.status as string, version: num(po.version), recv: lines.map((l: any) => num(l.recv)) };
};
const total = async (s: Sess, table: string) => num((await s.sql(A, `SELECT count(*) AS n FROM inventory.${table} WHERE tenant_id = $1`, [A]))[0].n);
const setting = (s: Sess, col: 'over_receipt_tolerance_bp' | 'vat_in_cost' | 'grn_without_po_allowed' | 'count_locks_store', v: number | boolean) =>
  s.sql(A, `UPDATE inventory.settings SET ${col} = $2 WHERE tenant_id = $1`, [A, v]);
const rhu = (n: bigint, d: bigint) => (n * 2n + d) / (2n * d);
const oracle = (qtyPacks: string, price: number, disc: number, bp: number) => {
  const gross = Number(rhu(BigInt(Math.round(Number(qtyPacks) * 1000)) * BigInt(price), 1000n));
  const net = gross - disc; const vat = Number(rhu(BigInt(net) * BigInt(bp), 10000n));
  return { gross, net, vat, total: net + vat };
};
const keysOk = (g: any) => {
  expect(onlyKeys(g, GRN_KEYS)).toEqual([]); expect(JSON.stringify(g)).not.toMatch(LEAK);
  for (const l of g.lines) { expect(onlyKeys(l, GRN_LINE_KEYS)).toEqual([]); expect(Object.keys(l).filter((k) => LEAK.test(k))).toEqual([]); }
  for (const m of g.movements ?? []) expect(onlyKeys(m, MOVEMENT_KEYS)).toEqual([]);
};
const noCost = (v: unknown) => expect(deepKeys(v).filter((k) => COST_FIELD.test(k))).toEqual([]);
/** Mutations that must leave the ledger as it was: counts of movements / lots + every balance + every PO line received quantity. */
const snapshot = async (s: Sess) => JSON.stringify([await s.sql(A, 'SELECT id, qty_base::text, value_paisa::text FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [A]), await total(s, 'stock_movements'), await total(s, 'lots'),
  await s.sql(A, 'SELECT id, received_qty_base::text FROM inventory.purchase_order_lines WHERE tenant_id = $1 ORDER BY id', [A]), await s.sql(A, 'SELECT id, status FROM inventory.purchase_orders WHERE tenant_id = $1 ORDER BY id', [A])]);
const path = (e: any, p: string) => expect(JSON.stringify(e.errors ?? e.detail ?? ''), `errors should point at ${p}`).toContain(p);
const rid = () => uid(17_100_000_000 + Math.floor(Math.random() * 1_000_000_000));

// =============================================================================================================== #50 create: money, tax, exempt, PO, kind rules
describe.skipIf(!live)('T-12 #50 createGoodsReceipt: server-computed money (CatalogPort.getTaxRate, half-up), P-23, D-70, draft semantics', () => {
  run('golden: 2.500 packs x 1001 - 3 at VAT 13 % => gross 2503 (2502.5 half-up), net 2500, vat 325, total 2825; header = line; shape; draft has no lot id, no capitalised value, no lot row, no movement; creator', async (s) => {
    const g = await mk(s, [gLine(H1, K1, '2.500', { unit_price_paisa: 1001, discount_paisa: 3, lot_no: 'T12-GOLD', expiry_on: addDays(TODAY, 300) })], { notes: 'synthetic note', supplier_invoice_no: 'INV-1' }, { actor: OTHER });
    keysOk(g);
    expect(g).toMatchObject({ status: 'draft', kind: 'purchase', version: 1, store_id: G1, supplier_id: SA, notes: 'synthetic note', supplier_invoice_no: 'INV-1' });
    expect(g.grn_no).toMatch(GRN_NO);
    const l = g.lines[0];
    expect(l).toMatchObject({ line_no: 1, item_id: H1, pack_id: K1, unit_price_paisa: 1001, discount_paisa: 3, tax_code: 'VAT', is_exempt: false, tax_rate_bp: 1300, net_paisa: 2500, vat_paisa: 325, line_total_paisa: 2825, lot_no: 'T12-GOLD' });
    expect(num(l.qty_packs)).toBe(2.5); expect(num(l.qty_base)).toBe(1000);
    expect(l.lot_id ?? null).toBeNull(); expect(l.capitalised_value_paisa ?? null).toBeNull();
    expect(g).toMatchObject({ subtotal_paisa: 2503, discount_paisa: 3, net_paisa: 2500, vat_paisa: 325, total_paisa: 2825 });
    const row = await dbGrn(s, g.id);
    expect(row.created_by).toBe(OTHER); expect(row.total_paisa).toBe('2825'); expect(row.posted_at).toBeNull();
    const [dl] = await dbLines(s, g.id);
    expect(num(dl.qty_in_base_snapshot)).toBe(400); expect(num(dl.qty_base)).toBe(1000); expect(dl.tax_rate_bp).toBe(1300); expect(dl.lot_id).toBeNull(); expect(dl.capitalised_value_paisa).toBeNull();
    expect(await lotOf(s, H1, 'T12-GOLD')).toBeUndefined(); // the lot is upserted at POST, never at draft
    expect(await mvs(s, g.id)).toEqual([]);
  });
  run('oracle table: every line equals the independent computation (half-up); header = sum of the lines; line_no 1..n', async (s) => {
    const cases: [string, number, number, number, string, string][] = [['1', 50, 0, 1300, 'VAT', K1], ['2.500', 1001, 3, 1300, 'VAT', K1], ['0.333', 1000, 0, 1300, 'VAT', K2], ['1.005', 100, 0, 500, 'LOCALTAX', K1],
      ['7', 199, 5, 500, 'LOCALTAX', K2], ['12.345', 8888, 100, 1300, 'VAT', K1], ['0.001', 499, 0, 1300, 'VAT', K1], ['1', 4, 0, 1300, 'VAT', K2]];
    const g = await mk(s, cases.map(([q, p, d, , t, pk]) => gLine(H1, pk, q, { unit_price_paisa: p, discount_paisa: d, tax_code: t })));
    let sg = 0, sd = 0, sn = 0, sv = 0, st = 0;
    cases.forEach(([q, p, d, bp], i) => {
      const o = oracle(q, p, d, bp); const l = g.lines[i];
      expect([l.net_paisa, l.vat_paisa, l.line_total_paisa, l.tax_rate_bp], `line ${i + 1}`).toEqual([o.net, o.vat, o.total, bp]);
      sg += o.gross; sd += d; sn += o.net; sv += o.vat; st += o.total;
    });
    expect(g).toMatchObject({ subtotal_paisa: sg, discount_paisa: sd, net_paisa: sn, vat_paisa: sv, total_paisa: st });
    expect(g.lines.map((l: any) => l.line_no)).toEqual(cases.map((_, i) => i + 1));
  });
  run('a discount above the gross (qty x price) is refused 400 at /lines/0/discount_paisa (P-1)', async (s) => {
    const e: any = await rej(mk(s, [gLine(H1, K1, '1', { unit_price_paisa: 100, discount_paisa: 101, is_exempt: true })]));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); path(e, '/lines/0/discount_paisa');
  });
  run('exempt line (D-70): getTaxRate NEVER called; wire has is_exempt true and NO tax_code key (not null); tax_rate_bp 0, vat 0; stored tax_code NULL; same on read', async (s) => {
    const g = await mk(s, [E1()], {}, { rates: {} }); // an empty rate table: a call would fail with tax_config_missing
    expect(s.taxCalls).toEqual([]);
    const l = g.lines[0];
    expect(l.is_exempt).toBe(true); expect('tax_code' in l).toBe(false); expect(l).toMatchObject({ tax_rate_bp: 0, vat_paisa: 0, net_paisa: 1000, line_total_paisa: 1000 });
    const [dl] = await dbLines(s, g.id);
    expect(dl.tax_code).toBeNull(); expect(dl.tax_rate_bp).toBe(0);
    expect('tax_code' in (await get(s, g.id)).body.lines[0]).toBe(false);
  });
  run('exempt + taxed lines: the port is asked only for the taxed code, with `on` = the TENANT business date (2026-11-14T19:00Z is 2026-11-15 in Asia/Kathmandu)', async (s) => {
    const g = await mk(s, [E1(), gLine(H1, K1, '1', { unit_price_paisa: 2000 })], {}, { now: '2026-11-14T19:00:00.000Z' });
    expect(new Set(s.taxCalls.map((c) => `${c.taxCode}@${c.on}`))).toEqual(new Set(['VAT@2026-11-15']));
    expect(g.lines.map((l: any) => [l.is_exempt, l.vat_paisa])).toEqual([[true, 0], [false, 260]]);
  });
  run('defaults (assumption, as T-11 PO lines): tax code supplier item > item default > VAT; unit price = the supplier item price', async (s) => {
    const g = await mk(s, [gLine(H1, K1, '1'), gLine(H1, K2, '1'), gLine(H2, K3, '1')]);
    expect(g.lines.map((l: any) => [l.unit_price_paisa, l.tax_code, l.tax_rate_bp])).toEqual([[5000, 'VAT', 1300], [1200, 'LOCALTAX', 500], [700, 'LOCALTAX', 500]]);
  });
  run('an explicit tax_code and an explicit price beat the defaults; a rate of 0 bp keeps the tax code (not exempt)', async (s) => {
    const g = await mk(s, [gLine(H1, K2, '1', { tax_code: 'VAT', unit_price_paisa: 10 }), gLine(H1, K1, '1', { tax_code: 'LOCALTAX', unit_price_paisa: 1000 })], {}, { rates: { VAT: 1300, LOCALTAX: 0 } });
    expect(g.lines[0]).toMatchObject({ tax_code: 'VAT', unit_price_paisa: 10, tax_rate_bp: 1300 });
    expect(g.lines[1]).toMatchObject({ tax_code: 'LOCALTAX', is_exempt: false, tax_rate_bp: 0, vat_paisa: 0 });
  });
  run('the rate is a SNAPSHOT: a later C3 rate change (VAT 2000 bp) does not change the stored line on read', async (s) => {
    const g = await mk(s, [gLine(H1, K1, '1', { unit_price_paisa: 1000 })]);
    const again = (await get(s, g.id, { rates: { VAT: 2000 } })).body;
    expect(again.lines[0]).toMatchObject({ tax_rate_bp: 1300, vat_paisa: 130 }); expect(again.total_paisa).toBe(g.total_paisa);
  });
  run('catalog.tax_config_missing is rethrown unchanged (the SAME LimsError object, 422, P-23); no GRN row', async (s) => {
    const before = await total(s, 'goods_receipts');
    const failure = new LimsError('catalog.tax_config_missing');
    const e = await rej(mk(s, [gLine(H1, K1, '1', { tax_code: 'VAT', unit_price_paisa: 1000 })], {}, { taxFailure: failure }));
    expect(e).toBe(failure); expect((e as LimsError).statusCode).toBe(422);
    const e2 = await expectLims(mk(s, [gLine(H1, K1, '1', { tax_code: 'NORATE', unit_price_paisa: 1000 })]), 'catalog.tax_config_missing', 422);
    expect(e2.code).toBe('catalog.tax_config_missing');
    expect(await total(s, 'goods_receipts')).toBe(before);
  });
  run('invoice total: informational; a difference adds invoice_total_mismatch_paisa (|difference|), an exact match does not; never an error', async (s) => {
    const g = await mk(s, [E1()], { supplier_invoice_total_paisa: 1100 });
    expect(g.supplier_invoice_total_paisa).toBe(1100); expect(Math.abs(g.invoice_total_mismatch_paisa)).toBe(100);
    const h = await mk(s, [E1()], { supplier_invoice_total_paisa: 1000 });
    expect(h.invoice_total_mismatch_paisa ?? 0).toBe(0);
  });
  run('pack of another item -> 422 inventory.uom_mismatch (TRD §4.1)', async (s) => { await expectLims(mk(s, [gLine(H1, K3, '1', { unit_price_paisa: 1, is_exempt: true })]), 'inventory.uom_mismatch', 422); });
  run('a draft accepts what posting will refuse: no lot_no / no expiry / an expired lot are all fine at draft', async (s) => {
    const g = await mk(s, [E1(), lotLine('T12-OLD', -30)]);
    expect(g.status).toBe('draft'); expect(g.lines).toHaveLength(2);
  });
});

describe.skipIf(!live)('T-12 #50 createGoodsReceipt: kind, supplier, PO link (AC-06.6, state machine of the PO), opening balance (AC-06.7)', () => {
  run('AC-06.6: grn_without_po_allowed = false and a purchase GRN with no PO => 400 common.validation_failed at /po_id; with a PO it is accepted; opening_balance is not affected', async (s) => {
    await setting(s, 'grn_without_po_allowed', false);
    const e: any = await rej(mk(s, [E1()]));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); path(e, '/po_id');
    expect((await mk(s, [E1({ po_line_id: L_POA })], { po_id: POA })).status).toBe('draft');
    expect((await mkOpen(s, [E1()])).status).toBe('draft');
  });
  run('grn_without_po_allowed = true (default): a purchase GRN with a supplier and no PO is accepted', async (s) => { expect((await mk(s, [E1()])).po_id ?? null).toBeNull(); });
  run('a purchase GRN needs a supplier or a PO: neither => 400 at /supplier_id', async (s) => {
    const e: any = await rej(mk(s, [E1()], { supplier_id: undefined }));
    expect(e.code).toBe('common.validation_failed'); path(e, '/supplier_id');
  });
  run('PO link: status approved / sent / partially_received accepted; draft / received / closed / cancelled => 409 inventory.po_invalid_transition', async (s) => {
    for (const [po, line] of [[POA, L_POA], [POS, L_POS], [PP, L_PP]] as const) expect((await mk(s, [E1({ po_line_id: line })], { po_id: po })).po_id).toBe(po);
    for (const [po, line] of [[PD, L_PD], [PR, L_PR], [PC, L_PC], [PX, L_PX]] as const) await expectLims(mk(s, [E1({ po_line_id: line })], { po_id: po }), 'inventory.po_invalid_transition', 409);
  });
  run('PO link: the supplier is taken from the PO when omitted; another supplier => 400 at /supplier_id', async (s) => {
    expect((await mk(s, [E1({ po_line_id: L_POA })], { po_id: POA, supplier_id: undefined })).supplier_id).toBe(SA);
    const e: any = await rej(mk(s, [E1({ po_line_id: L_POA })], { po_id: POA, supplier_id: SB }));
    expect(e.code).toBe('common.validation_failed'); path(e, '/supplier_id');
  });
  run('po_line_id must be a current line of THAT PO: another PO\'s line, a removed line, a tenant B line, or a line with no po_id => 400 at /lines/0/po_line_id', async (s) => {
    for (const [po, line] of [[POA, L_POS], [POA, L_POA_REMOVED], [undefined, L_POA]] as const) {
      const e: any = await rej(mk(s, [E1({ po_line_id: line })], { po_id: po }));
      expect(e.code, `${line}`).toBe('common.validation_failed'); path(e, '/lines/0/po_line_id');
    }
    const tb: any = await rej(mk(s, [E1({ po_line_id: uid(8601) })], { po_id: POA })); // a line of tenant B is invisible (RLS): any 4xx, never accepted
    expect(tb.statusCode).toBeGreaterThanOrEqual(400); expect(tb.statusCode).toBeLessThan(500);
  });
  run('a PO in another store is refused (400 at /po_id); a PO of tenant B is not found', async (s) => {
    const e: any = await rej(mk(s, [E1({ po_line_id: L_PB2 })], { po_id: PB2 }));
    expect(e.statusCode).toBe(400); path(e, '/po_id');
    const e2: any = await rej(mk(s, [E1()], { po_id: uid(8401) }));
    expect([400, 404]).toContain(e2.statusCode);
  });
  run('AC-06.7 opening balance: no supplier and no PO; a supplier or a PO on it => 400 at /supplier_id or /po_id', async (s) => {
    const g = await mkOpen(s, [gLine(H2, K3, '5', { unit_price_paisa: 200, is_exempt: true })]);
    expect(g).toMatchObject({ kind: 'opening_balance', status: 'draft' }); expect(g.supplier_id ?? null).toBeNull(); expect(g.po_id ?? null).toBeNull();
    const a: any = await rej(mkOpen(s, [E1()], { supplier_id: SA })); expect(a.code).toBe('common.validation_failed'); path(a, '/supplier_id');
    const b: any = await rej(mkOpen(s, [E1()], { po_id: POA })); expect(b.code).toBe('common.validation_failed'); path(b, '/po_id');
  });
  run('AC-06.7 / PE-1: creating an opening-balance GRN needs inventory.stock.adjust for the branch of the store: missing => 403 auth.forbidden, at aal1 => 403 auth.mfa_required; a purchase GRN needs only stock.manage', async (s) => {
    await forbidden(mkOpen(s, [E1()], {}, NO_ADJUST));
    await expectLims(mkOpen(s, [E1()], {}, { aal: 'aal1' }), 'auth.mfa_required', 403);
    expect((await mk(s, [E1()], {}, NO_ADJUST)).status).toBe('draft');
    expect((await mk(s, [E1()], {}, { aal: 'aal1', permissions: [READ, MANAGE] })).status).toBe('draft');
    const r = await s.call(A, 'createGoodsReceipt', { headers: idem(), body: openingGrn(G1, [E1()]) });
    expect(s.roleCalls.filter((c) => c.permission === ADJUST).some((c) => c.branchId === BR1)).toBe(true);
    expect(r.status).toBe(201);
  });
  run('inactive supplier => 400 at /supplier_id', async (s) => { const e: any = await rej(mk(s, [E1()], { supplier_id: SIN })); expect(e.code).toBe('common.validation_failed'); path(e, '/supplier_id'); });
});

describe.skipIf(!live)('T-12 scope and permission on #50 / #49 (P-B8: 404 beats 403; branch visibility; tenant isolation)', () => {
  run('unknown store, store of a branch the user cannot see, and a store of tenant B => 404 common.not_found (also without any permission); nothing created', async (s) => {
    const before = await total(s, 'goods_receipts');
    await nf(mk(s, [E1()], {}, undefined, uid(19999)));
    await nf(mk(s, [E1()], {}, BR2_ONLY, G1));
    await nf(mk(s, [E1()], {}, undefined, STORE_B));
    await nf(mk(s, [E1()], {}, { permissions: [], all: false, branchIds: [BR2] }, G1));
    expect(await total(s, 'goods_receipts')).toBe(before);
  });
  run('a visible store without inventory.stock.manage => 403 auth.forbidden, assertRole({ permission, branchId }) for the branch of the store', async (s) => {
    await forbidden(mk(s, [E1()], {}, READ_ONLY));
    expect(s.roleCalls.some((c) => c.permission === MANAGE && c.branchId === BR1)).toBe(true);
  });
  run('references from tenant B (supplier, item, pack) are never accepted: 4xx and no GRN', async (s) => {
    const before = await total(s, 'goods_receipts');
    for (const over of [{ supplier_id: SUP_B }]) { const e: any = await rej(mk(s, [E1()], over)); expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500); }
    const e2: any = await rej(mk(s, [gLine(ITEM_B, PACK_B, '1', { unit_price_paisa: 1, is_exempt: true })])); expect(e2.statusCode).toBeGreaterThanOrEqual(400); expect(e2.statusCode).toBeLessThan(500);
    expect(await total(s, 'goods_receipts')).toBe(before);
  });
});

// =============================================================================================================== #52 replace (D-71)
describe.skipIf(!live)('T-12 #52 replaceGoodsReceiptDraft: draft replace by soft removal (D-71), state, If-Match, tax', () => {
  run('D-71: every current line is marked removed (removed_at, removed_by = actor), the request lines are inserted with NEW ids and line_no 1..n; totals recomputed; version + 1; nothing deleted', async (s) => {
    const g = await mk(s, [E1({ unit_price_paisa: 500 }), E1({ unit_price_paisa: 700 })]);
    const oldIds = g.lines.map((l: any) => l.id);
    const r = await replace(s, g.id, [gLine(H1, K1, '2', { unit_price_paisa: 300, is_exempt: true })], { actor: OTHER }, { notes: 'edited' });
    expect(r.status).toBe(200); keysOk(r.body);
    expect(r.body.lines).toHaveLength(1); expect(r.body.lines[0].line_no).toBe(1); expect(oldIds).not.toContain(r.body.lines[0].id);
    expect(r.body).toMatchObject({ status: 'draft', version: 2, notes: 'edited', subtotal_paisa: 600, net_paisa: 600, total_paisa: 600 });
    const rows = await dbLines(s, g.id);
    expect(rows).toHaveLength(3);
    const removed = rows.filter((l: any) => l.removed_at !== null);
    expect(removed.map((l: any) => l.id).sort()).toEqual([...oldIds].sort());
    expect(removed.every((l: any) => l.removed_by === OTHER)).toBe(true);
    expect(rows.filter((l: any) => l.removed_at === null)).toHaveLength(1);
    expect((await get(s, g.id)).body.lines.map((l: any) => l.id)).toEqual([r.body.lines[0].id]); // removed lines never appear
    const hdrRow = await dbGrn(s, g.id);
    expect(hdrRow).toMatchObject({ kind: 'purchase', store_id: G1, status: 'draft' }); expect(hdrRow.total_paisa).toBe('600');
  });
  run('the fixture draft GRN 8001 reads with its CURRENT lines only (8201, 8203; 8202 is removed)', async (s) => {
    const r = await get(s, GRN_FX);
    expect(r.body.lines.map((l: any) => l.id)).toEqual([GRN_FX_L1, GRN_FX_L3]); keysOk(r.body);
  });
  run('the supplier, PO link and header fields can change in a draft; the kind and the store never do', async (s) => {
    const g = await mk(s, [E1()]);
    const r = await replace(s, g.id, [E1({ po_line_id: L_POS })], undefined, { supplier_id: SA, po_id: POS, supplier_invoice_no: 'INV-9' });
    expect(r.body).toMatchObject({ po_id: POS, supplier_invoice_no: 'INV-9', kind: 'purchase', store_id: G1 });
    const r2 = await replace(s, g.id, [E1()], undefined, { supplier_id: SB });
    expect(r2.body.supplier_id).toBe(SB); expect(r2.body.store_id).toBe(G1);
  });
  run('If-Match: a stale version => 409 common.version_conflict and the lines are untouched', async (s) => {
    const g = await mk(s, [E1()]);
    await expectLims(s.call(A, 'replaceGoodsReceiptDraft', { params: { grn_id: g.id }, headers: ifm(g.version + 1), body: replaceBody([E1({ unit_price_paisa: 9 })], { supplier_id: SA }) }), 'common.version_conflict', 409);
    expect((await dbLines(s, g.id)).every((l: any) => l.removed_at === null)).toBe(true); expect(await ver(s, g.id)).toBe(1);
  });
  run('AC-06.5: a POSTED GRN cannot be edited => 409 common.immutable_record; a CANCELLED one => 409 inventory.document_invalid_transition (a draft is the only editable state)', async (s) => {
    const g = await mk(s, [lotLine('T12-IMM')]); await post(s, g.id);
    const before = JSON.stringify(await dbLines(s, g.id));
    await expectLims(replace(s, g.id, [E1()]), 'common.immutable_record', 409);
    expect(JSON.stringify(await dbLines(s, g.id))).toBe(before);
    const c = await mk(s, [E1()]); await cancel(s, c.id);
    await docInvalid(replace(s, c.id, [E1()]));
  });
  run('a tax failure on replace leaves the old lines current (same LimsError object, nothing removed)', async (s) => {
    const g = await mk(s, [E1()]);
    const failure = new LimsError('catalog.tax_config_missing');
    const e = await rej(replace(s, g.id, [gLine(H1, K1, '1', { tax_code: 'VAT', unit_price_paisa: 1 })], { taxFailure: failure }));
    expect(e).toBe(failure);
    expect((await dbLines(s, g.id)).every((l: any) => l.removed_at === null)).toBe(true); expect(await ver(s, g.id)).toBe(1);
  });
  run('replace re-validates the PO link (po_line_id of another PO => 400 at /lines/0/po_line_id) and the pack of the item (422 uom_mismatch)', async (s) => {
    const g = await mk(s, [E1({ po_line_id: L_POA })], { po_id: POA });
    const e: any = await rej(replace(s, g.id, [E1({ po_line_id: L_POS })], undefined, { po_id: POA })); path(e, '/lines/0/po_line_id');
    await expectLims(replace(s, g.id, [gLine(H1, K3, '1', { unit_price_paisa: 1, is_exempt: true })], undefined, { po_id: POA }), 'inventory.uom_mismatch', 422);
  });
  run('scope: a branch the user cannot see / another tenant => 404; visible but no stock.manage => 403', async (s) => {
    const g = await mk(s, [E1()]);
    await nf(replace(s, g.id, [E1()], BR2_ONLY));
    await nf(s.call(B, 'replaceGoodsReceiptDraft', { params: { grn_id: g.id }, headers: ifm(1), body: replaceBody([E1()], { supplier_id: SUP_B }) }));
    await nf(s.call(A, 'replaceGoodsReceiptDraft', { params: { grn_id: GRN_B }, headers: ifm(1), body: replaceBody([E1()], { supplier_id: SA }) }));
    await forbidden(replace(s, g.id, [E1()], READ_ONLY));
  });
});

describe.skipIf(!live || !hasTrigger)('T-12 IT-1a: removed_at on a line of a non-draft GRN is refused by the database (tg_line_guard, P0001)', () => {
  run('posted GRN line (fixture 17620)', async (s) => {
    await expect(s.sql(A, 'UPDATE inventory.goods_receipt_lines SET removed_at = now(), removed_by = $2 WHERE tenant_id = $1 AND id = $3', [A, SYS, uid(17620)])).rejects.toMatchObject({ code: 'P0001' });
  });
});

// =============================================================================================================== #53 post: AC-06.1 .. AC-06.9
describe.skipIf(!live)('T-12 #53 postGoodsReceipt: AC-06.1 / AC-06.2 lots, movements, balances, PO progress', () => {
  run('AC-06.1: sent PO line H1 2 BOX, GRN 1 BOX lot L-SYN-001 => lot exists, receive +400 in G1, balance 400, PO line received 400, PO partially_received; response = posted Grn with lot ids + movements', async (s) => {
    const exp = addDays(TODAY, 365);
    const g = await mk(s, [E1({ po_line_id: L_POS, lot_no: 'L-SYN-001', expiry_on: exp })], { po_id: POS });
    const r = await post(s, g.id, { actor: OTHER });
    expect(r.status).toBe(200);
    const lot = await lotOf(s, H1, 'L-SYN-001');
    expect(lot).toMatchObject({ lot_no: 'L-SYN-001', expiry_on: exp, status: 'available' });
    const m = await mvs(s, g.id);
    expect(m).toHaveLength(1);
    const [dl] = await dbLines(s, g.id);
    expect(m[0]).toMatchObject({ movement_kind: 'receive', store_id: G1, item_id: H1, lot_id: lot.id, doc_type: 'goods_receipt', value_basis: 'receipt', doc_line_id: dl.id });
    expect(num(m[0].q)).toBe(400); expect(num(m[0].v)).toBe(1000);
    expect(await bal(s, G1, H1, lot.id)).toEqual({ q: 400, v: 1000 });
    expect(await poState(s, POS)).toMatchObject({ status: 'partially_received', recv: [400] });
    const d = r.body; keysOk(d);
    expect(d).toMatchObject({ status: 'posted', id: g.id }); expect(d.posted_at).toBeTruthy();
    expect(d.lines[0].lot_id).toBe(lot.id); expect(d.movements).toHaveLength(1);
    expect(d.movements[0]).toMatchObject({ movement_kind: 'receive', lot_id: lot.id, store_id: G1, doc_type: 'goods_receipt', doc_id: g.id }); expect(qty(d.movements[0].qty_base)).toBe(400);
    const row = await dbGrn(s, g.id);
    expect(row.status).toBe('posted'); expect(row.posted_by).toBe(OTHER); expect(row.posted_at).not.toBeNull(); expect(num(row.version)).toBe(2);
    expect((await get(s, g.id)).body).toMatchObject({ status: 'posted' });
  });
  run('the movement business date is the TENANT date (ctx.now 2026-11-14T19:00Z is 2026-11-15 in Asia/Kathmandu)', async (s) => {
    const g = await mk(s, [lotLine('T12-BD', 365)], {}, { now: '2026-11-14T19:00:00.000Z' });
    await post(s, g.id, { now: '2026-11-14T19:00:00.000Z' });
    expect((await mvs(s, g.id))[0].bd).toBe('2026-11-15');
  });
  run('AC-06.2: the rest received later => PO received (received_qty_base 800), then the PO can be closed (#87); an approved PO goes approved -> partially_received -> received the same way', async (s) => {
    const g1 = await mk(s, [E1({ po_line_id: L_POA, lot_no: 'T12-R1', expiry_on: addDays(TODAY, 300) })], { po_id: POA });
    await post(s, g1.id);
    expect(await poState(s, POA)).toMatchObject({ status: 'partially_received', recv: [400] });
    const g2 = await mk(s, [E1({ po_line_id: L_POA, lot_no: 'T12-R2', expiry_on: addDays(TODAY, 300) })], { po_id: POA });
    await post(s, g2.id);
    const st = await poState(s, POA);
    expect(st).toMatchObject({ status: 'received', recv: [800] });
    const c = await s.call(A, 'closePurchaseOrder', { params: { po_id: POA }, headers: hdr(st.version), body: {} });
    expect(c.status).toBe(200); expect(c.body.status).toBe('closed');
  });
  run('a PO with two lines is received only when EVERY line is complete: line 1 => partially_received, line 2 => received; one GRN with both lines => received at once', async (s) => {
    const g1 = await mk(s, [E1({ po_line_id: L_POM1, lot_no: 'T12-M1', expiry_on: addDays(TODAY, 300) })], { po_id: POM }); await post(s, g1.id);
    expect(await poState(s, POM)).toMatchObject({ status: 'partially_received', recv: [400, 0] });
    const g2 = await mk(s, [gLine(H3, K4, '1', { po_line_id: L_POM2, lot_no: 'T12-M2', unit_price_paisa: 100, is_exempt: true })], { po_id: POM }); await post(s, g2.id);
    expect(await poState(s, POM)).toMatchObject({ status: 'received', recv: [400, 20] });
  });
  run('a GRN without a PO changes no PO; the received quantity of a line is the sum over posted GRNs (two partial receipts of 0.5 BOX)', async (s) => {
    const g = await mk(s, [lotLine('T12-NOPO')]); await post(s, g.id);
    expect(await poState(s, POS)).toMatchObject({ status: 'sent', recv: [0] });
    const a = await mk(s, [E1({ po_line_id: L_POS, qty_packs: '0.500', lot_no: 'T12-H1A', expiry_on: addDays(TODAY, 300) })], { po_id: POS });
    const b = await mk(s, [E1({ po_line_id: L_POS, qty_packs: '0.500', lot_no: 'T12-H1B', expiry_on: addDays(TODAY, 300) })], { po_id: POS });
    await post(s, a.id); await post(s, b.id);
    expect(await poState(s, POS)).toMatchObject({ status: 'partially_received', recv: [400] });
  });
  run('review T-12 #1 (03-APP-FLOW P5): a PO-linked GRN whose lines carry no po_line_id receives nothing against the PO => PO stays sent, line received_qty_base unchanged', async (s) => {
    const g = await mk(s, [lotLine('T12-NPL')], { po_id: POS, supplier_id: undefined });
    expect(g.po_id).toBe(POS);
    await post(s, g.id);
    expect(await poState(s, POS)).toMatchObject({ status: 'sent', recv: [0] });
  });
});

describe.skipIf(!live)('T-12 #53 over-receipt (AC-06.3) and PO state at post', () => {
  run('AC-06.3: tolerance 0 => 2 BOX on a 2-BOX line is accepted (<=), 2.001 / 3 BOX => 422 inventory.over_receipt; the failed post changes nothing', async (s) => {
    const over = await mk(s, [E1({ po_line_id: L_POA, qty_packs: '3', lot_no: 'T12-O3', expiry_on: addDays(TODAY, 300) })], { po_id: POA });
    const before = await snapshot(s);
    const e = await expectLims(post(s, over.id), 'inventory.over_receipt', 422);
    expect(e.code).toBe('inventory.over_receipt'); expect(await snapshot(s)).toBe(before); expect((await dbGrn(s, over.id)).status).toBe('draft');
    const just = await mk(s, [E1({ po_line_id: L_POA, qty_packs: '2.001', lot_no: 'T12-O2', expiry_on: addDays(TODAY, 300) })], { po_id: POA });
    await expectLims(post(s, just.id), 'inventory.over_receipt', 422);
    const exact = await mk(s, [E1({ po_line_id: L_POA, qty_packs: '2', lot_no: 'T12-O1', expiry_on: addDays(TODAY, 300) })], { po_id: POA });
    expect((await post(s, exact.id)).status).toBe(200); expect((await poState(s, POA)).status).toBe('received');
  });
  run('cumulative: 1 BOX posted earlier + a draft of 2 BOX => over_receipt (400 + 800 > 800); 1 BOX more is fine', async (s) => {
    const a = await mk(s, [E1({ po_line_id: L_POA, lot_no: 'T12-C1', expiry_on: addDays(TODAY, 300) })], { po_id: POA }); await post(s, a.id);
    const big = await mk(s, [E1({ po_line_id: L_POA, qty_packs: '2', lot_no: 'T12-C2', expiry_on: addDays(TODAY, 300) })], { po_id: POA });
    await expectLims(post(s, big.id), 'inventory.over_receipt', 422);
    const ok = await mk(s, [E1({ po_line_id: L_POA, lot_no: 'T12-C3', expiry_on: addDays(TODAY, 300) })], { po_id: POA });
    expect((await post(s, ok.id)).status).toBe(200);
  });
  run('two GRN lines on the same PO line in ONE GRN are summed (1.5 + 1 BOX > 2 BOX => over_receipt)', async (s) => {
    const g = await mk(s, [E1({ po_line_id: L_POA, qty_packs: '1.5', lot_no: 'T12-S1', expiry_on: addDays(TODAY, 300) }), E1({ po_line_id: L_POA, qty_packs: '1', lot_no: 'T12-S2', expiry_on: addDays(TODAY, 300) })], { po_id: POA });
    await expectLims(post(s, g.id), 'inventory.over_receipt', 422);
  });
  run('tolerance 500 bp: up to 800 x 1.05 = 840 base is accepted (2.100 BOX), 840.4 (2.101 BOX) is not', async (s) => {
    await setting(s, 'over_receipt_tolerance_bp', 500);
    const no = await mk(s, [E1({ po_line_id: L_POA, qty_packs: '2.101', lot_no: 'T12-T2', expiry_on: addDays(TODAY, 300) })], { po_id: POA });
    await expectLims(post(s, no.id), 'inventory.over_receipt', 422);
    const yes = await mk(s, [E1({ po_line_id: L_POA, qty_packs: '2.100', lot_no: 'T12-T1', expiry_on: addDays(TODAY, 300) })], { po_id: POA });
    expect((await post(s, yes.id)).status).toBe(200);
    expect(await poState(s, POA)).toMatchObject({ status: 'received', recv: [840] });
  });
  run('the PO must still be approved / sent / partially_received AT POST: cancelling the PO after the draft was made => 409 inventory.po_invalid_transition; nothing received', async (s) => {
    const g = await mk(s, [E1({ po_line_id: L_POA, lot_no: 'T12-PC', expiry_on: addDays(TODAY, 300) })], { po_id: POA });
    const po = await poState(s, POA);
    await s.call(A, 'cancelPurchaseOrder', { params: { po_id: POA }, headers: hdr(po.version), body: { reason_code: 'no_longer_needed' } });
    expect((await poState(s, POA)).status).toBe('cancelled');
    await expectLims(post(s, g.id), 'inventory.po_invalid_transition', 409);
    expect(await mvs(s, g.id)).toEqual([]); expect((await dbGrn(s, g.id)).status).toBe('draft');
  });
});

describe.skipIf(!live)('T-12 #53 value (AC-06.4), lots (upsert, conflicts, tracking rules), AC-06.9 expiry, supplier price, alert', () => {
  run('AC-06.4: capitalised = net + vat when vat_in_cost (default): 2.500 x 1001 - 3 at 13 % => 2825; the lot-store balance value rises by exactly that; movement value = 2825; line capitalised_value_paisa = 2825', async (s) => {
    const g = await mk(s, [gLine(H1, K1, '2.500', { unit_price_paisa: 1001, discount_paisa: 3, lot_no: 'T12-CAP', expiry_on: addDays(TODAY, 300) })]);
    const r = await post(s, g.id);
    const lot = await lotOf(s, H1, 'T12-CAP');
    expect(await bal(s, G1, H1, lot.id)).toEqual({ q: 1000, v: 2825 });
    expect(num((await mvs(s, g.id))[0].v)).toBe(2825);
    expect(r.body.lines[0].capitalised_value_paisa).toBe(2825); expect(num((await dbLines(s, g.id))[0].capitalised_value_paisa)).toBe(2825);
    expect(r.body.movements[0].value_paisa).toBe(2825); expect(r.body.movements[0].value_basis).toBe('receipt');
  });
  run('AC-06.4: vat_in_cost = false => capitalised = net (2500); an exempt line is net in both settings; the header total still includes the vat', async (s) => {
    await setting(s, 'vat_in_cost', false);
    const g = await mk(s, [gLine(H1, K1, '2.500', { unit_price_paisa: 1001, discount_paisa: 3, lot_no: 'T12-CAP2', expiry_on: addDays(TODAY, 300) }), lotLine('T12-CAP3', 300)]);
    const r = await post(s, g.id);
    const l1 = await lotOf(s, H1, 'T12-CAP2'); const l2 = await lotOf(s, H1, 'T12-CAP3');
    expect(await bal(s, G1, H1, l1.id)).toEqual({ q: 1000, v: 2500 }); expect(await bal(s, G1, H1, l2.id)).toEqual({ q: 400, v: 1000 });
    expect(r.body.lines.map((l: any) => l.capitalised_value_paisa)).toEqual([2500, 1000]); expect(r.body.total_paisa).toBe(3825);
  });
  run('an unlotted item: lot_id NULL on line, movement and balance; two receipts add up (qty and value); lot-less lines never create a lot', async (s) => {
    const lots = await total(s, 'lots');
    const mkU = () => mk(s, [gLine(H2, K3, '5', { unit_price_paisa: 100, is_exempt: true })]);
    const a = await mkU(); const ra = await post(s, a.id); const b = await mkU(); await post(s, b.id);
    expect(ra.body.lines[0].lot_id ?? null).toBeNull(); expect((await mvs(s, a.id))[0].lot_id).toBeNull();
    expect(await bal(s, G1, H2, null)).toEqual({ q: 100, v: 1000 }); expect(await total(s, 'lots')).toBe(lots);
  });
  run('AC-06.9: a lot that expired before the receipt date => 409 inventory.lot_expired (the draft was accepted); expiry TODAY is accepted; nothing written on refusal', async (s) => {
    const old = await mk(s, [lotLine('T12-EXP', -1)]);
    const before = await snapshot(s);
    await expectLims(post(s, old.id), 'inventory.lot_expired', 409);
    expect(await snapshot(s)).toBe(before); expect(await lotOf(s, H1, 'T12-EXP')).toBeUndefined();
    const today = await mk(s, [lotLine('T12-TODAY', 0)]);
    expect((await post(s, today.id)).status).toBe(200);
  });
  run('AC-06.9 (receipt date, literal reading): a backdated receipt (received 5 days ago) of a lot that expired 3 days ago is not "expired before the receipt date"', async (s) => {
    const recv = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const g = await mk(s, [lotLine('T12-BACK', -3)], { received_at: recv });
    expect((await post(s, g.id)).status).toBe(200);
  });
  run('lot-tracked item: lot_no required (400 at /lines/1/lot_no, line index kept); expiry_on required when the item requires expiry (400 at /lines/0/expiry_on); an item without requires_expiry takes a lot_no alone', async (s) => {
    const a = await mk(s, [lotLine('T12-OK1'), E1()]);
    const ea: any = await rej(post(s, a.id)); expect(ea.code).toBe('common.validation_failed'); expect(ea.statusCode).toBe(400); path(ea, '/lines/1/lot_no');
    const b = await mk(s, [E1({ lot_no: 'T12-NOEXP' })]);
    const eb: any = await rej(post(s, b.id)); expect(eb.code).toBe('common.validation_failed'); path(eb, '/lines/0/expiry_on');
    const c = await mk(s, [gLine(H3, K4, '1', { lot_no: 'T12-H3', unit_price_paisa: 100, is_exempt: true })]);
    expect((await post(s, c.id)).status).toBe(200); expect((await lotOf(s, H3, 'T12-H3')).expiry_on).toBeNull();
  });
  run('lot upsert: a second receipt of the same (item, lot_no, expiry) reuses the lot (one lot row, balances add up); last_receipt_qty_base / value = the LATEST line', async (s) => {
    const exp = addDays(TODAY, 300);
    const a = await mk(s, [E1({ lot_no: 'T12-UP', expiry_on: exp })]); await post(s, a.id);
    const lot = await lotOf(s, H1, 'T12-UP');
    expect([num(lot.lq), num(lot.lv)]).toEqual([400, 1000]);
    const b = await mk(s, [gLine(H1, K1, '2', { lot_no: 'T12-UP', expiry_on: exp, unit_price_paisa: 1500, is_exempt: true })]);
    const rb = await post(s, b.id);
    const lot2 = await lotOf(s, H1, 'T12-UP');
    expect(lot2.id).toBe(lot.id); expect(rb.body.lines[0].lot_id).toBe(lot.id);
    expect(await bal(s, G1, H1, lot.id)).toEqual({ q: 1200, v: 4000 });
    expect([num(lot2.lq), num(lot2.lv)]).toEqual([800, 3000]);
    expect(num((await s.sql(A, "SELECT count(*) AS n FROM inventory.lots WHERE tenant_id = $1 AND item_id = $2 AND lot_no = 'T12-UP'", [A, H1]))[0].n)).toBe(1);
  });
  run('lot conflict: an existing lot with another non-null expiry => 400 at /lines/0/expiry_on ("a lot has one expiry"); the lot and the ledger are unchanged', async (s) => {
    const exp = addDays(TODAY, 300);
    const a = await mk(s, [E1({ lot_no: 'T12-CF', expiry_on: exp })]); await post(s, a.id);
    const before = await snapshot(s);
    const b = await mk(s, [E1({ lot_no: 'T12-CF', expiry_on: addDays(TODAY, 301) })]);
    const e: any = await rej(post(s, b.id));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); path(e, '/lines/0/expiry_on');
    expect(await snapshot(s)).toBe(before); expect((await lotOf(s, H1, 'T12-CF')).expiry_on).toBe(exp);
  });
  run('lot conflict inside one GRN: two lines of the same lot_no with different expiry => 400 at /lines/1/expiry_on; the same expiry twice shares one lot (qty adds up)', async (s) => {
    const bad = await mk(s, [E1({ lot_no: 'T12-TW', expiry_on: addDays(TODAY, 300) }), E1({ lot_no: 'T12-TW', expiry_on: addDays(TODAY, 310) })]);
    const e: any = await rej(post(s, bad.id)); path(e, '/lines/1/expiry_on');
    const ok = await mk(s, [E1({ lot_no: 'T12-TW2', expiry_on: addDays(TODAY, 300) }), E1({ lot_no: 'T12-TW2', expiry_on: addDays(TODAY, 300) })]);
    const r = await post(s, ok.id);
    expect(r.body.lines[0].lot_id).toBe(r.body.lines[1].lot_id); expect(await bal(s, G1, H1, r.body.lines[0].lot_id)).toEqual({ q: 800, v: 2000 });
  });
  run('an existing lot with an expiry, a later receipt of an item that does not require one with no expiry given: accepted, the lot keeps its expiry; the same lot_no on another item is another lot', async (s) => {
    const exp = addDays(TODAY, 300);
    const a = await mk(s, [gLine(H3, K4, '1', { lot_no: 'T12-SH', expiry_on: exp, unit_price_paisa: 10, is_exempt: true })]); await post(s, a.id);
    const b = await mk(s, [gLine(H3, K4, '1', { lot_no: 'T12-SH', unit_price_paisa: 10, is_exempt: true })]); await post(s, b.id);
    expect((await lotOf(s, H3, 'T12-SH')).expiry_on).toBe(exp);
    const c = await mk(s, [lotLine('T12-SH', 200)]); await post(s, c.id);
    expect((await lotOf(s, H1, 'T12-SH')).id).not.toBe((await lotOf(s, H3, 'T12-SH')).id);
  });
  run('supplier item price: a purchase receipt sets last_unit_price_paisa of (supplier, item, pack) to the line price (5000 -> 1001); an opening balance has no supplier and changes none', async (s) => {
    const g = await mk(s, [gLine(H1, K1, '1', { unit_price_paisa: 1001, is_exempt: true, lot_no: 'T12-PR', expiry_on: addDays(TODAY, 300) })]); await post(s, g.id);
    const price = async () => num((await s.sql(A, 'SELECT last_unit_price_paisa::text AS p FROM inventory.supplier_items WHERE tenant_id = $1 AND supplier_id = $2 AND item_id = $3 AND pack_id = $4', [A, SA, H1, K1]))[0].p);
    expect(await price()).toBe(1001);
    const o = await mkOpen(s, [lotLine('T12-PR2', 300, { unit_price_paisa: 7 })]); await post(s, o.id);
    expect(await price()).toBe(1001);
  });
  run('alert hook (step 7): posting stock above the reorder level resolves the open below_reorder alert in the same transaction; a receipt that stays below leaves it open', async (s) => {
    const state = async () => (await s.sql(A, "SELECT status, resolved_at FROM inventory.alerts WHERE tenant_id = $1 AND dedupe_key = $2 ORDER BY first_raised_at DESC", [A, `below_reorder:${G1}:${H4}`]))[0];
    expect((await state()).status).toBe('open');
    const small = await mk(s, [gLine(H4, K5, '10', { unit_price_paisa: 100, is_exempt: true })]); await post(s, small.id); // 100 + 100 = 200 < 500
    expect((await state()).status).toBe('open');
    const big = await mk(s, [gLine(H4, K5, '60', { unit_price_paisa: 100, is_exempt: true })]); await post(s, big.id); // 200 + 600 = 800 >= 500
    const a = await state(); expect(a.status).toBe('resolved'); expect(a.resolved_at).not.toBeNull();
  });
});

describe.skipIf(!live)('T-12 #53 opening balance (AC-06.7), count lock, state machine and replay safety (AC-06.8), cancel (#54)', () => {
  run('AC-06.7: an opening-balance GRN posts as movement kind opening_balance (+50, value = net 1000, doc_type goods_receipt); the post needs stock.adjust: without it 403 auth.forbidden, at aal1 403 auth.mfa_required; nothing posted on refusal', async (s) => {
    const g = await mkOpen(s, [gLine(H2, K3, '5', { unit_price_paisa: 200, is_exempt: true })]);
    await forbidden(post(s, g.id, NO_ADJUST));
    await expectLims(post(s, g.id, { aal: 'aal1' }), 'auth.mfa_required', 403);
    expect(await mvs(s, g.id)).toEqual([]); expect((await dbGrn(s, g.id)).status).toBe('draft');
    const r = await post(s, g.id);
    expect(r.status).toBe(200);
    const m = await mvs(s, g.id);
    expect(m).toHaveLength(1); expect(m[0]).toMatchObject({ movement_kind: 'opening_balance', doc_type: 'goods_receipt', store_id: G1, item_id: H2 }); expect(num(m[0].q)).toBe(50); expect(num(m[0].v)).toBe(1000);
    expect(await bal(s, G1, H2, null)).toEqual({ q: 50, v: 1000 });
    expect(s.roleCalls.filter((c) => c.permission === ADJUST).some((c) => c.branchId === BR1)).toBe(true);
  });
  run('a purchase GRN is posted by stock.manage alone (no adjust, no mfa)', async (s) => {
    const g = await mk(s, [lotLine('T12-NA')]);
    expect((await post(s, g.id, { permissions: [READ, MANAGE], aal: 'aal1' })).status).toBe(200);
  });
  run('count lock: count_locks_store ON + an open count for the store (fixture count 8901 / MAIN) => post 409 inventory.store_locked_for_count; creating / replacing the draft is unaffected; OFF (default) => posts', async (s) => {
    const g = await mk(s, [lotLine('T12-LK')], {}, undefined, MAIN);
    expect((await post(s, g.id)).status).toBe(200); // default: no lock
    const h = await mk(s, [lotLine('T12-LK2')], {}, undefined, MAIN);
    await setting(s, 'count_locks_store', true);
    const k = await mk(s, [lotLine('T12-LK3')], {}, undefined, MAIN); await replace(s, k.id, [lotLine('T12-LK4')]);
    const before = await snapshot(s);
    await expectLims(post(s, h.id), 'inventory.store_locked_for_count', 409);
    expect(await snapshot(s)).toBe(before);
    const other = await mk(s, [lotLine('T12-LK5')]); // G1 has no open count
    expect((await post(s, other.id)).status).toBe(200);
  });
  run('the status check comes BEFORE the count lock (algorithm steps 1 and 2): a posted GRN in a locked store answers document_invalid_transition', async (s) => {
    const g = await mk(s, [lotLine('T12-ORD')], {}, undefined, MAIN); await post(s, g.id);
    await setting(s, 'count_locks_store', true);
    await docInvalid(post(s, g.id, undefined, await ver(s, g.id)));
  });
  run('AC-06.8: a second post (another key, current version) => 409 inventory.document_invalid_transition; no duplicate movements, balance and PO unchanged', async (s) => {
    const g = await mk(s, [E1({ po_line_id: L_POS, lot_no: 'T12-DUP', expiry_on: addDays(TODAY, 300) })], { po_id: POS }); await post(s, g.id, undefined, undefined, 'key-1');
    const lot = await lotOf(s, H1, 'T12-DUP');
    const before = await snapshot(s); const m1 = await mvs(s, g.id);
    await docInvalid(post(s, g.id, undefined, await ver(s, g.id), 'key-2'));
    expect(await snapshot(s)).toBe(before); expect(await mvs(s, g.id)).toEqual(m1); expect(m1).toHaveLength(1);
    expect(await bal(s, G1, H1, lot.id)).toEqual({ q: 400, v: 1000 }); expect(await poState(s, POS)).toMatchObject({ recv: [400] });
  });
  run('a cancelled GRN cannot be posted (409 document_invalid_transition)', async (s) => { const g = await mk(s, [lotLine('T12-CX')]); await cancel(s, g.id); await docInvalid(post(s, g.id, undefined, await ver(s, g.id))); });
  run('If-Match on post: a stale version => 409 common.version_conflict and nothing is posted', async (s) => {
    const g = await mk(s, [lotLine('T12-IM')]);
    await expectLims(post(s, g.id, undefined, 99), 'common.version_conflict', 409);
    expect(await mvs(s, g.id)).toEqual([]); expect((await dbGrn(s, g.id)).status).toBe('draft');
  });
  run('#54 cancel (draft): status cancelled, cancelled_at / reason, version + 1, lines kept, no movement, PO untouched, the lot is not created', async (s) => {
    const g = await mk(s, [E1({ po_line_id: L_POS, lot_no: 'T12-CN', expiry_on: addDays(TODAY, 300) })], { po_id: POS });
    const r = await cancel(s, g.id, { actor: OTHER }, cancelGrnBody({ reason_text: 'wrong delivery' }));
    expect(r.status).toBe(200); keysOk(r.body);
    expect(r.body).toMatchObject({ status: 'cancelled', cancel_reason_text: 'wrong delivery', version: 2 }); expect(r.body.cancelled_at).toBeTruthy();
    const row = await dbGrn(s, g.id); expect(row).toMatchObject({ status: 'cancelled', cancelled_by: OTHER });
    expect((await dbLines(s, g.id)).filter((l: any) => l.removed_at === null)).toHaveLength(1);
    expect(await mvs(s, g.id)).toEqual([]); expect(await poState(s, POS)).toMatchObject({ status: 'sent', recv: [0] }); expect(await lotOf(s, H1, 'T12-CN')).toBeUndefined();
  });
  run('#54: a posted or an already cancelled GRN => 409 inventory.document_invalid_transition (the state check precedes If-Match); stale If-Match => 409 version_conflict; ledger untouched', async (s) => {
    const p = await mk(s, [lotLine('T12-CP')]); await post(s, p.id);
    const before = await snapshot(s);
    await docInvalid(cancel(s, p.id));
    expect(await snapshot(s)).toBe(before);
    const c = await mk(s, [E1()]); await cancel(s, c.id);
    await docInvalid(cancel(s, c.id));
    const d = await mk(s, [E1()]);
    await expectLims(s.call(A, 'cancelGoodsReceipt', { params: { grn_id: d.id }, headers: hdr(d.version + 5), body: cancelGrnBody() }), 'common.version_conflict', 409);
  });
  run('#54 scope: a branch the user cannot see / tenant B => 404; visible without stock.manage => 403', async (s) => {
    const g = await mk(s, [E1()]);
    await nf(cancel(s, g.id, BR2_ONLY)); await forbidden(cancel(s, g.id, READ_ONLY));
    await nf(s.call(A, 'cancelGoodsReceipt', { params: { grn_id: GRN_B }, headers: hdr(1), body: cancelGrnBody() }));
    await nf(s.call(B, 'cancelGoodsReceipt', { params: { grn_id: g.id }, headers: hdr(1), body: cancelGrnBody() }));
  });
  run('#53 scope: a branch the user cannot see / tenant B => 404; visible without stock.manage => 403; the lot of the refused post is not created', async (s) => {
    const g = await mk(s, [lotLine('T12-SC')]);
    await nf(post(s, g.id, BR2_ONLY)); await forbidden(post(s, g.id, READ_ONLY));
    await nf(s.call(A, 'postGoodsReceipt', { params: { grn_id: GRN_B }, headers: hdr(1) }));
    await nf(s.call(B, 'postGoodsReceipt', { params: { grn_id: g.id }, headers: hdr(1) }));
    expect(await lotOf(s, H1, 'T12-SC')).toBeUndefined();
  });
});

// =============================================================================================================== reads #49 / #51 and the cost allowlist (PE-3)
describe.skipIf(!live)('T-12 #49 listGoodsReceipts / #51 getGoodsReceipt: filters, paging, visibility, money allowlist', () => {
  run('#49 filters: store_id, status, supplier_id, po_id, received_at range; newest received first; summary keys only', async (s) => {
    const a = await mk(s, [E1()], { received_at: '2026-01-05T00:00:00.000Z' });
    const b = await mk(s, [lotLine('T12-LS')], { received_at: '2026-01-20T00:00:00.000Z', supplier_id: SB }); await post(s, b.id);
    const c = await mk(s, [E1({ po_line_id: L_POA })], { received_at: '2026-01-25T00:00:00.000Z', po_id: POA });
    const d = await mk(s, [E1()], { received_at: '2026-01-26T00:00:00.000Z' }, undefined, G2);
    const list = async (query: Record<string, unknown>, o?: PoOpts) => (await s.call(A, 'listGoodsReceipts', { query }, o)).body;
    const ids = (r: any) => r.data.map((x: any) => x.id);
    const mine = [a.id, b.id, c.id, d.id];
    const g1 = await list({ store_id: G1, limit: 200 });
    expect(ids(g1).filter((i: string) => mine.includes(i))).toEqual([c.id, b.id, a.id]); // newest received first, G2's GRN absent
    for (const row of g1.data) expect(onlyKeys(row, GRN_SUMMARY_KEYS)).toEqual([]);
    expect(JSON.stringify(g1)).not.toMatch(LEAK);
    expect(ids(await list({ store_id: G1, status: 'posted', limit: 200 })).filter((i: string) => mine.includes(i))).toEqual([b.id]);
    expect(ids(await list({ store_id: G1, status: 'draft', limit: 200 })).filter((i: string) => mine.includes(i))).toEqual([c.id, a.id]);
    expect(ids(await list({ supplier_id: SB, limit: 200 })).filter((i: string) => mine.includes(i))).toEqual([b.id]);
    expect(ids(await list({ po_id: POA, limit: 200 }))).toEqual([c.id]);
    expect(ids(await list({ store_id: G1, received_at_from: '2026-01-10T00:00:00.000Z', received_at_to: '2026-01-31T00:00:00.000Z', limit: 200 })).filter((i: string) => mine.includes(i))).toEqual([c.id, b.id]);
    expect(ids(await list({ store_id: G2, limit: 200 })).filter((i: string) => mine.includes(i))).toEqual([d.id]);
    expect(g1.data.find((x: any) => x.id === b.id)).toMatchObject({ status: 'posted', kind: 'purchase', supplier_id: SB, total_paisa: 1000 });
  });
  run('#49 paging: limit 2 => 2 rows and page.next_cursor; the next page (cursor) is disjoint and continues the order', async (s) => {
    for (let i = 0; i < 3; i++) await mk(s, [E1()], { received_at: `2026-02-0${i + 1}T00:00:00.000Z` });
    const p1 = (await s.call(A, 'listGoodsReceipts', { query: { limit: 2 } })).body;
    expect(p1.data).toHaveLength(2); expect(typeof p1.page.next_cursor).toBe('string'); expect(p1.page.limit).toBe(2);
    const p2 = (await s.call(A, 'listGoodsReceipts', { query: { limit: 2, cursor: p1.page.next_cursor } })).body;
    expect(p2.data.length).toBeGreaterThan(0);
    expect(p2.data.map((x: any) => x.id).filter((i: string) => p1.data.map((y: any) => y.id).includes(i))).toEqual([]);
  });
  run('#49 visibility (P-B8): without store_id the permission is asserted first with no branchId and only visible branches are listed; an invisible store_id => 404; tenant B sees only its own', async (s) => {
    const a = await mk(s, [E1()]); const b = await mk(s, [E1()], {}, undefined, G2);
    s.roleCalls.length = 0;
    const ids = (r: any) => r.body.data.map((x: any) => x.id);
    const one =await s.call(A, 'listGoodsReceipts', { query: { limit: 200 } }, BR1_ONLY);
    expect(s.roleCalls[0]).toEqual({ permission: READ });
    expect(ids(one)).toContain(a.id); expect(ids(one)).not.toContain(b.id);
    const two = await s.call(A, 'listGoodsReceipts', { query: { limit: 200 } }, BR2_ONLY);
    expect(ids(two)).toContain(b.id); expect(ids(two)).not.toContain(a.id);
    await nf(s.call(A, 'listGoodsReceipts', { query: { store_id: G1 } }, BR2_ONLY));
    await nf(s.call(A, 'listGoodsReceipts', { query: { store_id: STORE_B } }));
    const tb = await s.call(B, 'listGoodsReceipts', { query: { limit: 200 } });
    expect(ids(tb)).toContain(GRN_B); expect(ids(tb)).not.toContain(a.id); expect(ids(tb)).not.toContain(GRN_FX);
    await forbidden(s.call(A, 'listGoodsReceipts', { query: {} }, { permissions: [] }));
  });
  run('#51 get: full Grn (current lines, tax / exempt, mismatch), unknown id / tenant B / invisible branch => 404, no permission => 403 after the row is visible; unknown beats forbidden', async (s) => {
    const g = await mk(s, [E1(), gLine(H1, K1, '1', { unit_price_paisa: 100 })], { supplier_invoice_total_paisa: 5 });
    const r = await get(s, g.id); keysOk(r.body);
    expect(r.body.lines[1]).toMatchObject({ is_exempt: false, tax_code: 'VAT', tax_rate_bp: 1300 }); expect('tax_code' in r.body.lines[0]).toBe(false);
    expect(Math.abs(r.body.invoice_total_mismatch_paisa)).toBe(1000 + 113 - 5);
    await nf(get(s, uid(19998))); await nf(get(s, GRN_B)); await nf(get(s, g.id, BR2_ONLY)); await nf(get(s, g.id, undefined, B));
    await forbidden(get(s, g.id, { permissions: [] }));
    await nf(get(s, uid(19998), { permissions: [] }));
    expect(s.roleCalls.some((c) => c.permission === READ && c.branchId === BR1)).toBe(true);
  });
  run('PE-3 cost allowlist: without inventory.cost.read NO property ending _paisa / _paisa_x1e6 and no value_basis on #49 / #50 / #51 / #52 / #53 / #54 responses (quantities stay); with it they are there', async (s) => {
    const g = await mk(s, [lotLine('T12-NC')], {}, NO_COST); noCost(g); expect(g.lines[0].qty_base).toBeDefined(); expect(g.lines[0].lot_no).toBe('T12-NC');
    noCost((await get(s, g.id, NO_COST)).body); noCost((await s.call(A, 'listGoodsReceipts', { query: { limit: 200 } }, NO_COST)).body);
    noCost((await replace(s, g.id, [lotLine('T12-NC2')], NO_COST)).body);
    const p = (await post(s, g.id, NO_COST)).body; noCost(p); expect(p.movements[0].qty_base).toBeDefined(); expect(p.movements[0].value_basis).toBeUndefined(); expect(p.status).toBe('posted');
    const c = await mk(s, [E1()], {}, NO_COST); noCost((await cancel(s, c.id, NO_COST)).body);
    const withCost = await mk(s, [lotLine('T12-WC')]);
    expect(deepKeys(withCost).filter((k) => COST_FIELD.test(k)).length).toBeGreaterThan(0);
    const wp = (await post(s, withCost.id)).body; expect(wp.movements[0].value_paisa).toBe(1000); expect(wp.movements[0].value_basis).toBe('receipt');
  });
});

// =============================================================================================================== #55 CSV export
describe.skipIf(!live)('T-12 #55 exportGoodsReceiptsCsv: content, window, visibility, P-9 neutralisation, access log (§5.10), permissions (PE-1)', () => {
  const exp = async (s: Sess, query: Record<string, unknown> = window(), o?: PoOpts, t = A) => s.call(t, 'exportGoodsReceiptsCsv', { query }, o);
  const table = async (s: Sess, query: Record<string, unknown> = window(), o?: PoOpts, t = A) => csvObjects(bodyText((await exp(s, query, o, t)).body));
  run('200 text/csv attachment: no-store, nosniff, a plain .csv file name, UTF-8 BOM, CRLF, the header contains the money columns', async (s) => {
    const r = await exp(s);
    expect(r.status).toBe(200);
    expect(headerOf(r, 'content-type') ?? '').toMatch(/^text\/csv/i);
    expect(headerOf(r, 'content-disposition') ?? '').toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.csv"$/);
    expect(headerOf(r, 'cache-control')).toBe('no-store'); expect(headerOf(r, 'x-content-type-options')).toBe('nosniff');
    const text = bodyText(r.body);
    expect(text.charCodeAt(0)).toBe(0xfeff); expect(text.replace(/\r\n/g, '').includes('\n')).toBe(false);
    const { header } = csvObjects(text);
    for (const c of CSV_COLUMNS) expect(header, c).toContain(c);
  });
  run('rows: one per POSTED GRN line with posted_at in [from, to) - X0 (at from) in, X3 (at to) and X7 (one second before from) out, draft / cancelled / tenant B out; money and quantities as posted', async (s) => {
    const { rows } = await table(s);
    const lots = rows.map((r) => r['lot_no']);
    expect(new Set(lots)).toEqual(new Set(['T12-X0L', "'=SUM(1+1)", "'+1+1", "'-2+3", "'@SUM(A1)", "''quoted", 'T12-X2L']));
    expect(lots).toHaveLength(7);
    const golden = rows.find((r) => r['lot_no'] === "'=SUM(1+1)") as Record<string, string>;
    expect(golden).toMatchObject({ grn_no: 'GR260017011', store_code: 'T12-G1', item_code: 'T12-H1', net_paisa: '2500', vat_paisa: '325', capitalised_value_paisa: '2825' });
    expect(num(golden['qty_base'])).toBe(1000);
    const x0 = rows.find((r) => r['lot_no'] === 'T12-X0L') as Record<string, string>;
    expect(x0).toMatchObject({ grn_no: 'GR260017010', store_code: 'T12-G1', net_paisa: '1000', vat_paisa: '0', capitalised_value_paisa: '1000' }); expect(num(x0['qty_base'])).toBe(400);
    expect(rows.some((r) => ['GR260017013', 'GR260017014', 'GR260017015', 'GR260017016', 'GR260017017'].includes(r['grn_no'] as string))).toBe(false);
  });
  run('P-9: every text cell passes neutraliseFormula - no cell of the file starts with = + - @ TAB CR (supplier name "=HYPERLINK...", lot numbers = + - @ \' are all prefixed with an apostrophe); numbers are untouched', async (s) => {
    const text = bodyText((await exp(s)).body);
    const cells = csvObjects(text).rows.flatMap((r) => Object.values(r));
    expect(cells.filter((c) => /^[=+\-@\t\r]/.test(c))).toEqual([]);
    expect(cells).toEqual(expect.arrayContaining(["'=SUM(1+1)", "'+1+1", "'-2+3", "'@SUM(A1)", "''quoted"]));
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
    const { rows } = csvObjects(text); const g = rows.find((r) => r['lot_no'] === 'T12-X0L') as Record<string, string>;
    expect(g['net_paisa']).toBe('1000');
  });
  run('visibility: a user of BR1 only gets G1 rows, a user of BR2 only gets G2 rows; store_id narrows; an invisible store_id => 404; tenant B gets only its own row', async (s) => {
    const lots = async (o?: PoOpts, q = window()) => (await table(s, q, o)).rows.map((r) => r['lot_no']);
    expect(await lots(BR1_ONLY)).not.toContain('T12-X2L'); expect(await lots(BR1_ONLY)).toContain('T12-X0L');
    expect(await lots(BR2_ONLY)).toEqual(['T12-X2L']);
    expect(await lots(undefined, window({ store_id: G2 }))).toEqual(['T12-X2L']);
    expect((await lots(undefined, window({ store_id: G1 }))).sort()).toEqual(['T12-X0L', "'=SUM(1+1)", "'+1+1", "'-2+3", "'@SUM(A1)", "''quoted"].sort());
    await nf(exp(s, window({ store_id: G1 }), BR2_ONLY)); await nf(exp(s, window({ store_id: STORE_B })));
    const b = (await table(s, window(), undefined, B)).rows;
    expect(b.map((r) => r['lot_no'])).toEqual(['T12-BLOT']); expect(b.map((r) => r['grn_no'])).toEqual(['GR260017017']);
  });
  run('an empty window still answers 200 with the header row only (and logs the export)', async (s) => {
    const { header, rows } = await table(s, window({ posted_at_from: '2025-01-01T00:00:00.000Z', posted_at_to: '2025-02-01T00:00:00.000Z' }));
    expect(rows).toEqual([]); for (const c of CSV_COLUMNS) expect(header).toContain(c);
    expect(s.audit).toHaveLength(1);
  });
  run('a GRN posted through #53 shows up (and its draft does not)', async (s) => {
    const g = await mk(s, [lotLine('T12-EXPORTED')]); const d = await mk(s, [lotLine('T12-DRAFTONLY')]); await post(s, g.id);
    void d;
    const from = new Date(Date.now() - 86_400_000).toISOString(); const to = new Date(Date.now() + 86_400_000).toISOString();
    const lots = (await table(s, { posted_at_from: from, posted_at_to: to })).rows.map((r) => r['lot_no']);
    expect(lots).toContain('T12-EXPORTED'); expect(lots).not.toContain('T12-DRAFTONLY');
  });
  run('§5.10 access log: exactly one ctx.audit.access({ action: data.export, entityType: inventory_grn_export, outcome: allowed }) on success (detail values primitives only); none for 400 / 403 / 404 / mfa refusals', async (s) => {
    await exp(s);
    expect(s.audit).toHaveLength(1);
    expect(s.audit[0]).toMatchObject({ action: 'data.export', entityType: 'inventory_grn_export', outcome: 'allowed' });
    for (const v of Object.values(s.audit[0].detail ?? {})) expect(['string', 'number', 'boolean']).toContain(typeof v);
    expect(JSON.stringify(s.audit[0])).not.toMatch(/=HYPERLINK/);
    const n = s.audit.length;
    await rej(exp(s, { posted_at_from: 'x', posted_at_to: 'y' })); await forbidden(exp(s, window(), { permissions: [READ, MANAGE, COST] })); await forbidden(exp(s, window(), { permissions: [READ, MANAGE, EXPORT] }));
    await expectLims(exp(s, window(), { aal: 'aal1' }), 'auth.mfa_required', 403); await nf(exp(s, window({ store_id: uid(19997) })));
    expect(s.audit).toHaveLength(n);
  });
  run('PE-1 / PE-3: the export needs inventory.report.export AND inventory.cost.read (always); both asserted without a branch first; aal1 => 403 auth.mfa_required', async (s) => {
    await forbidden(exp(s, window(), { permissions: [READ, MANAGE, COST] }));
    await forbidden(exp(s, window(), { permissions: [READ, MANAGE, EXPORT] }));
    await expectLims(exp(s, window(), { aal: 'aal1' }), 'auth.mfa_required', 403);
    expect((await exp(s)).status).toBe(200);
    const perms = s.roleCalls.map((c) => c.permission);
    expect(perms).toContain(EXPORT); expect(perms).toContain(COST);
  });
  run('range: 367 days refused (no rows, no log); exactly 366 days accepted', async (s) => {
    const e: any = await rej(exp(s, { posted_at_from: '2026-01-01T00:00:00.000Z', posted_at_to: '2027-01-03T00:00:00.000Z' }));
    expect([400, 422]).toContain(e.statusCode); expect(s.audit).toHaveLength(0);
    expect((await exp(s, { posted_at_from: '2026-01-01T00:00:00.000Z', posted_at_to: '2027-01-02T00:00:00.000Z' })).status).toBe(200);
  });
});

// =============================================================================================================== races and many users at once
describe.skipIf(!live)('T-12 races (committed): double post, over-receipt, parallel receipts into one balance', () => {
  it('two concurrent posts of the SAME draft: exactly one succeeds (the other is 409), one movement, balance applied once (replay safety, AC-06.8)', async () => {
    const lotNo = `RACE-${Math.floor(Math.random() * 1e9)}`;
    const id = await committed(async (s) => (await mk(s, [lotLine(lotNo, 300)], {}, undefined, G3)).id);
    const attempt = () => committed(async (s) => post(s, id, undefined, 1, 'race-key'));
    const out = await Promise.allSettled([attempt(), attempt()]);
    expect(out.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = out.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.statusCode).toBe(409); expect(['inventory.document_invalid_transition', 'common.version_conflict']).toContain(lost.reason.code);
    await session(async (s) => {
      const m = await mvs(s, id); expect(m).toHaveLength(1); expect(num(m[0].q)).toBe(400);
      const lot = await lotOf(s, H1, lotNo); expect(await bal(s, G3, H1, lot.id)).toEqual({ q: 400, v: 1000 });
    });
  }, 60_000);

  it('two drafts of 1 BOX each against a PO line of 1 BOX, posted at the same time: exactly one succeeds, the other is 422 inventory.over_receipt; the PO line holds 400 and the PO is received', async () => {
    const po = rid(); const line = rid();
    await admin.query(adminBlock([poRow(po, `T12-RACE-${po.slice(-6)}`, G3, BR1, 'approved'), pol(line, po, 1, H1, K1, 1, 400)].join('\n')));
    const [g1, g2] = await committed(async (s) => [
      (await mk(s, [E1({ po_line_id: line, lot_no: `RACE-A${po.slice(-6)}`, expiry_on: addDays(TODAY, 300) })], { po_id: po }, undefined, G3)).id,
      (await mk(s, [E1({ po_line_id: line, lot_no: `RACE-B${po.slice(-6)}`, expiry_on: addDays(TODAY, 300) })], { po_id: po }, undefined, G3)).id,
    ] as [string, string]);
    const out = await Promise.allSettled([committed((s) => post(s, g1, undefined, 1, 'k1')), committed((s) => post(s, g2, undefined, 1, 'k2'))]);
    expect(out.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = out.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('inventory.over_receipt'); expect(lost.reason.statusCode).toBe(422);
    await session(async (s) => { expect(await poState(s, po)).toMatchObject({ status: 'received', recv: [400] }); });
  }, 60_000);

  it('8 receipts of the same unlotted item into one store posted in parallel: all succeed, no deadlock, the balance is exactly the sum, 8 movements with distinct running balances', async () => {
    const b0 = await session((s) => bal(s, G3, H2, null));
    const ids = await committed(async (s) => { const out: string[] = []; for (let i = 0; i < 8; i++) out.push((await mk(s, [gLine(H2, K3, '5', { unit_price_paisa: 100, is_exempt: true })], {}, undefined, G3)).id); return out; });
    const out = await Promise.allSettled(ids.map((id, i) => committed((s) => post(s, id, undefined, 1, `par-${i}`))));
    expect(out.map((r) => r.status === 'rejected' ? String((r as PromiseRejectedResult).reason?.code ?? (r as PromiseRejectedResult).reason) : 'ok')).toEqual(Array(8).fill('ok'));
    await session(async (s) => {
      expect(await bal(s, G3, H2, null)).toEqual({ q: (b0?.q ?? 0) + 400, v: (b0?.v ?? 0) + 4000 });
      const after = new Set<number>();
      for (const id of ids) { const m = await mvs(s, id); expect(m).toHaveLength(1); after.add(num(m[0].ba)); }
      expect(after.size).toBe(8);
    });
  }, 90_000);
});
