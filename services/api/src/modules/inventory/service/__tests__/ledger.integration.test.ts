// C12 T-05 — ledger core `ledger.service.post()` (+ alert hooks in alerts.service.ts) (06-IMPLEMENTATION-PLAN row T-05).
// done_when: "TRD s10 invariants hold after every test; 20 parallel posts same item exact, no deadlock; rounding golden pinned on the PG image". Tests: unit (valuation golden) + integration (concurrency). ACs: AC-06.4, AC-08.3, AC-12.8, AC-20.1, AC-20.2.
// Spec: 02-TRD §4.3 (valuation, steps 1-7), §10 (invariants), §15 (concurrency: 20 parallel posts; 2 parallel issues of the last stock -> one insufficient_stock); 01-PRD §8.1 (+ D-75), 05-SCHEMA §6.4 (kinds, consumption_daily), 07-SECURITY (ledger append-only, tenant isolation).
// The "valuation golden" is run on the PINNED Postgres image through post() (TS never computes money, TRD §4.3), so the half-up rounding of round(numeric) is pinned where it matters (TRD §2 / PRD §8.1).
// Needs the migrated+seeded database of tests/db/c12-t03/run.sh (LIMS_TEST_DATABASE_URL = role lims_api, RLS on; LIMS_TEST_ADMIN_DATABASE_URL = superuser) and its fixtures.sql; run via .orchestra/notes/C12.T-05-verify.cmd.
// Without the DB the DB tests skip, except under LIMS_C12T03_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails.
//
// SEAM the spec does not fix (writer must provide exactly this; rows in/out use the DDL's snake_case names verbatim; same RepoCtx as the T-03 repositories):
//   service/ledger.service.ts   post(rc: RepoCtx /* {tx, tenantId, actorId} */, input): Promise<Row[]>
//     input    = { doc_type, doc_id, occurred_at (ISO), business_date ('YYYY-MM-DD', computed by the caller in the tenant timezone), movements: Mv[] }
//     Mv       = { store_id, item_id, lot_id: uuid|null, kind: movement_kind, qty_base: DecimalString (SIGNED), value_hint?: integer paisa, doc_line_id?, instrument_id?, attributed_test_id?, rule_id?, reason_code?, reverses_movement_id? }
//     value_hint is the source-fixed value: the capitalised value for receive/opening_balance, the dispatched/pro-rata value for transfer_in. Every other kind is valued by the ledger from the row (§4.3).
//     returns  = the inserted stock_movements rows (RETURNING *), in processing order; a split consume_*/count_adjust_out returns the lot-row part first, then the unlotted part.
//     Everything runs in rc.tx (caller owns BEGIN/COMMIT); tenant_id comes from rc.tenantId only, created_by = rc.actorId. Malformed input -> LimsError `common.validation_failed`, nothing written.
//   service/alerts.service.ts is exercised only through post(): below_reorder raise/occurrence/resolve and negative_stock open (alert rows read from inventory.alerts; dedupe key format is the writer's).
// ASSUMPTIONS (state in the notes file): D-75 inbound into a negative row stays ONE movement row whose value is the sum (-V of the cleared part + the remainder's rule value); "available quantity" for below_reorder = sum of qty_base of ALL
//   rows of (store,item) incl. the unlotted row (no quarantine/expiry filtering is tested); the avg cost used for the unlotted remainder of a split is tested only where the pre- and post-lot-emptied averages coincide.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import * as ledger from '../ledger.service.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const dbIt = live ? it : it.skip;

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const uid = (n: number) => `0190c514-0000-7000-8000-${String(n).padStart(12, '0')}`;
const S1 = uid(1001); const S2 = uid(1002);          // tenant A stores (fixtures.sql)
const INSTR = uid(421); const TEST7 = uid(7001); const RULE = uid(7001);   // tenant A instrument / catalog test / consumption rule (fixtures.sql)
const S_B = uid(1101); const ITEM_B = uid(2101);     // tenant B store / item

type Row = Record<string, any>;
interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
interface Stmt { text: string; values: unknown[] }
interface Rc { tx: Tx; tenantId: string; actorId: string }
interface Mv { store_id: string; item_id: string; lot_id: string | null; kind: string; qty_base: string; value_hint?: number; [k: string]: unknown }

let api: pg.Pool;
let admin: pg.Pool;
const claims = (tenantId: string) => JSON.stringify({ tenant_id: tenantId, sub: SYS, actor_type: 'system' });
/** One request-shaped transaction on lims_api (claims transaction-local like core/db/tx.ts), COMMIT on success, ROLLBACK on throw; records every statement. */
async function asApi<T>(tenantId: string, fn: (rc: Rc, stmts: Stmt[]) => Promise<T>): Promise<T> {
  const client = await api.connect();
  const stmts: Stmt[] = [];
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenantId)]);
    const tx: Tx = { query: async (text, values = []) => { stmts.push({ text, values: [...values] }); return client.query(text, values); } };
    const out = await fn({ tx, tenantId, actorId: SYS }, stmts);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { client.release(); }
}
const sql = async (text: string, values: unknown[] = []): Promise<Row[]> => (await admin.query(text, values)).rows;
async function rejection(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected rejection, but it resolved');
}
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const today = () => new Date().toISOString().slice(0, 10);

let seq = 700000;
const nid = () => uid(seq++);
let touched: string[] = [];   // items created by the current test: the TRD §10 invariants are checked on them after every test

const DOC_TYPE: Record<string, string> = {
  receive: 'goods_receipt', opening_balance: 'goods_receipt', supplier_return: 'stock_document', issue: 'stock_document', return_to_store: 'stock_document', wastage: 'stock_document',
  expiry_writeoff: 'stock_document', adjust_in: 'stock_document', adjust_out: 'stock_document', transfer_out: 'transfer', transfer_in: 'transfer',
  count_adjust_in: 'stock_count', count_adjust_out: 'stock_count',
};
const docTypeOf = (kind: string) => DOC_TYPE[kind] ?? 'consumption_fact';   // consume_* / consume_reversal

async function mkItem(tracked = true): Promise<string> {
  const id = nid();
  await admin.query(`INSERT INTO inventory.items (id, tenant_id, item_code, name, category, base_uom_code, is_lot_tracked, requires_expiry, created_by, updated_by)
    VALUES ($1, $2, $3, 'T5 item', 'reagent', 'test', $4, $4, $5, $5)`, [id, A, `T5-${seq}`, tracked, SYS]);
  touched.push(id);
  return id;
}
async function mkLot(item: string, o: { lastQty?: number; lastValue?: number; expiry?: string } = {}): Promise<string> {
  const id = nid();
  await admin.query(`INSERT INTO inventory.lots (id, tenant_id, item_id, lot_no, expiry_on, last_receipt_qty_base, last_receipt_value_paisa, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $8, $5, $6, $7, $7)`, [id, A, item, `LOT-${seq}`, o.lastQty ?? null, o.lastValue ?? null, SYS, o.expiry ?? '2031-01-01']);
  return id;
}
async function setReorder(store: string, item: string, level: number | null, active = true): Promise<void> {
  await admin.query(`INSERT INTO inventory.store_item_settings (id, tenant_id, store_id, item_id, reorder_level_base, is_active, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [nid(), A, store, item, level, active, SYS]);
}
const mv = (kind: string, store: string, item: string, lot: string | null, qty: number | string, extra: Record<string, unknown> = {}): Mv =>
  ({ store_id: store, item_id: item, lot_id: lot, kind, qty_base: String(qty), ...extra });
const postMany = (movements: Mv[], o: { docType?: string; tenant?: string } = {}) =>
  asApi(o.tenant ?? A, (rc) => ledger.post(rc, { doc_type: o.docType ?? docTypeOf(movements[0]!.kind), doc_id: nid(), occurred_at: iso(), business_date: today(), movements }));
const post1 = (kind: string, store: string, item: string, lot: string | null, qty: number | string, extra: Record<string, unknown> = {}) => postMany([mv(kind, store, item, lot, qty, extra)]);
const receive = (store: string, item: string, lot: string | null, qty: number | string, value: number) => post1('receive', store, item, lot, qty, { value_hint: value });
async function bal(store: string, item: string, lot: string | null): Promise<{ qty: number; value: number; version: number } | null> {
  const r = (await sql(`SELECT qty_base, value_paisa, version FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id IS NOT DISTINCT FROM $4`, [A, store, item, lot]))[0];
  return r ? { qty: Number(r['qty_base']), value: Number(r['value_paisa']), version: Number(r['version']) } : null;
}
const nMovements = async (item: string): Promise<number> => Number((await sql('SELECT count(*) AS n FROM inventory.stock_movements WHERE item_id = $1', [item]))[0]!['n']);
const alertsOf = (kind: string, store: string, item: string) =>
  sql('SELECT * FROM inventory.alerts WHERE tenant_id = $1 AND alert_kind = $2 AND store_id = $3 AND item_id = $4 ORDER BY first_raised_at, id', [A, kind, store, item]);
const dailyOf = (item: string) => sql('SELECT * FROM inventory.consumption_daily WHERE item_id = $1 ORDER BY movement_kind, instrument_id NULLS FIRST', [item]);
/** an unlotted row at qty -n, value -v (average cost v/n) built only through post(), so the §10 invariants hold: one lot receive(n, v) + an unlotted consume_test of n. */
async function negativeUnlotted(store: string, item: string, n: number, v: number): Promise<string> {
  const lot = await mkLot(item);
  await receive(store, item, lot, n, v);
  await post1('consume_test', store, item, null, -n);
  expect(await bal(store, item, null)).toMatchObject({ qty: -n, value: -v });
  return lot;
}

async function invariants(items: string[]): Promise<void> {
  if (items.length === 0) return;
  // §10.1 balance = Σ movements (qty and value) per (store, item, lot); §10.2 lot rows never negative
  const drift = await sql(`SELECT coalesce(b.store_id, m.store_id) AS store_id, coalesce(b.item_id, m.item_id) AS item_id, b.qty_base, b.value_paisa, m.q, m.v
    FROM (SELECT * FROM inventory.stock_balances WHERE item_id = ANY($1)) b
    FULL JOIN (SELECT store_id, item_id, lot_id, sum(qty_base) q, sum(value_paisa) v FROM inventory.stock_movements WHERE item_id = ANY($1) GROUP BY 1, 2, 3) m
      ON m.store_id = b.store_id AND m.item_id = b.item_id AND m.lot_id IS NOT DISTINCT FROM b.lot_id
    WHERE b.qty_base IS DISTINCT FROM m.q AND NOT (b.qty_base = 0 AND m.q IS NULL) OR b.value_paisa IS DISTINCT FROM m.v AND NOT (b.value_paisa = 0 AND m.v IS NULL)`, [items]);
  expect(drift, 'TRD §10.1: balance == Σ movements').toEqual([]);
  expect(await sql('SELECT 1 FROM inventory.stock_balances WHERE item_id = ANY($1) AND lot_id IS NOT NULL AND qty_base < 0', [items]), 'TRD §10.2').toEqual([]);
  // §10.4 consumption_daily == ledger sums (return_to_store under issue, count_adjust_in under count_adjust_out, consume_reversal under the reversed kind; all negative)
  const dd = await sql(`WITH m AS (
      SELECT sm.business_date, sm.store_id, sm.item_id, sm.instrument_id, sm.attributed_test_id, -sm.qty_base AS q, -sm.value_paisa AS v,
             CASE sm.movement_kind WHEN 'return_to_store' THEN 'issue' WHEN 'count_adjust_in' THEN 'count_adjust_out' WHEN 'consume_reversal' THEN o.movement_kind ELSE sm.movement_kind END AS k
        FROM inventory.stock_movements sm LEFT JOIN inventory.stock_movements o ON o.tenant_id = sm.tenant_id AND o.id = sm.reverses_movement_id
       WHERE sm.item_id = ANY($1) AND sm.movement_kind NOT IN ('receive','opening_balance','supplier_return','transfer_out','transfer_in','adjust_in','adjust_out')),
    e AS (SELECT business_date, store_id, item_id, k, instrument_id, attributed_test_id, sum(q) q, sum(v) v FROM m GROUP BY 1, 2, 3, 4, 5, 6),
    d AS (SELECT business_date, store_id, item_id, movement_kind AS k, instrument_id, attributed_test_id, qty_consumed q, value_consumed_paisa v FROM inventory.consumption_daily WHERE item_id = ANY($1))
    SELECT e.k AS ek, d.k AS dk, e.q AS eq, d.q AS dq, e.v AS ev, d.v AS dv FROM e FULL JOIN d ON e.business_date = d.business_date AND e.store_id = d.store_id AND e.item_id = d.item_id AND e.k = d.k
      AND e.instrument_id IS NOT DISTINCT FROM d.instrument_id AND e.attributed_test_id IS NOT DISTINCT FROM d.attributed_test_id
    WHERE e.q IS DISTINCT FROM d.q OR e.v IS DISTINCT FROM d.v`, [items]);
  expect(dd, 'TRD §10.4: consumption_daily == ledger sums').toEqual([]);
}

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 30 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  await admin.query(readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c12-t03/fixtures.sql', import.meta.url)), 'utf8'));   // fresh migrated + seeded database (run.sh)
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });
beforeEach(() => { touched = []; });
afterEach(async () => { if (live) await invariants(touched); });

describe('T-05 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------- valuation golden (TRD §4.3 step 3, PRD §8.1)
describe('outbound from a lot row: round_half_up(q x V / Q), pinned on the PG image', () => {
  // [label, Q, V, q, expected |value|]   (a banker's/half-even or truncating implementation fails the tie rows)
  const GOLDEN: Array<[string, string, number, string, number]> = [
    ['q = Q clears the row exactly', '3', 100, '3', 100],
    ['33.33 -> 33', '3', 100, '1', 33],
    ['66.67 -> 67', '3', 100, '2', 67],
    ['tie 0.5 -> 1 (half-even would give 0)', '2', 1, '1', 1],
    ['tie 1.5 -> 2', '2', 3, '1', 2],
    ['tie 2.5 -> 3 (half-even would give 2)', '4', 10, '1', 3],
    ['tie 7.5 -> 8', '4', 10, '3', 8],
    ['0.625 -> 1', '8', 5, '1', 1],
    ['0.14 -> 0 (value 0 is allowed)', '7', 1, '1', 0],
    ['fractional quantities', '2.5', 1000, '0.5', 200],
    ['6-decimal quantities', '0.000003', 100, '0.000001', 33],
    ['bigint value above 2^31', '1000000', 9_999_999_999, '1', 10_000],
  ];
  for (const [label, Q, V, q, expected] of GOLDEN) {
    dbIt(label, async () => {
      const item = await mkItem(); const lot = await mkLot(item);
      await receive(S1, item, lot, Q, V);
      const [m] = await post1('issue', S1, item, lot, `-${q}`);
      // arbiter ruling (C12.T-05-ruling.md): value_paisa is a PG bigint, no signed zero; exact integer equality, 0 when expected is 0.
      expect(Number(m!['value_paisa'])).toBe(expected === 0 ? 0 : -expected);
      expect(m!['value_basis']).toBe('average');
      expect(Number(m!['balance_qty_after'])).toBeCloseTo(Number(Q) - Number(q), 6);
      const b = (await bal(S1, item, lot))!;
      expect(b.value).toBe(V - expected);
    });
  }
  dbIt('draining a row in pieces takes exactly V in total (33 + 34 + 33; the last piece takes the remainder)', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 3, 100);
    const values: number[] = [];
    for (let i = 0; i < 3; i++) values.push(Number((await post1('issue', S1, item, lot, -1))[0]!['value_paisa']));
    expect(values).toEqual([-33, -34, -33]);
    expect(await bal(S1, item, lot)).toMatchObject({ qty: 0, value: 0 });
  });
  dbIt('a seeded random drain (40 issues) never loses or invents a paisa: Σ|values| = V and the row ends at 0 / 0', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    const Q = 1000; const V = 123_457;
    await receive(S1, item, lot, Q, V);
    let s = 12345; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    let left = Q; let sum = 0;
    for (let i = 0; i < 40 && left > 25; i++) {
      const q = 1 + Math.floor(rnd() * 20); left -= q;
      sum += -Number((await post1('issue', S1, item, lot, -q))[0]!['value_paisa']);
    }
    sum += -Number((await post1('issue', S1, item, lot, -left))[0]!['value_paisa']);
    expect(sum).toBe(V);
    expect(await bal(S1, item, lot)).toMatchObject({ qty: 0, value: 0 });
  });
});

describe('inbound valuation', () => {
  dbIt('AC-06.4: receive adds exactly the capitalised value to the lot-store balance (and opening_balance too), basis receipt', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 10, 5000);                                   // existing row
    const [r] = await post1('receive', S1, item, lot, 7, { value_hint: 11_300 });   // net 10000 + vat 1300 (vat_in_cost) as computed by the caller
    expect(r).toMatchObject({ movement_kind: 'receive', value_basis: 'receipt' });
    expect(Number(r!['value_paisa'])).toBe(11_300);
    expect(await bal(S1, item, lot)).toMatchObject({ qty: 17, value: 16_300 });
    const [o] = await post1('opening_balance', S1, item, lot, 1, { value_hint: 7 });
    expect(Number(o!['value_paisa'])).toBe(7);
    expect(await bal(S1, item, lot)).toMatchObject({ qty: 18, value: 16_307 });
  });
  dbIt('AC-08.3: return_to_store of 2 into a named lot = +2 valued at the lot-store average (round half-up), reported under issue with negative qty', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 10, 1000);
    const [m] = await post1('return_to_store', S1, item, lot, 2);
    expect(m).toMatchObject({ movement_kind: 'return_to_store', lot_id: lot, value_basis: 'average' });
    expect(Number(m!['qty_base'])).toBe(2);
    expect(Number(m!['value_paisa'])).toBe(200);
    expect(await bal(S1, item, lot)).toMatchObject({ qty: 12, value: 1200 });
    const d = (await dailyOf(item)).find((r) => r['movement_kind'] === 'issue')!;
    expect(Number(d['qty_consumed'])).toBe(-2);
    expect(Number(d['value_consumed_paisa'])).toBe(-200);
  });
  dbIt('return_to_store ties round half-up (Q=4 V=10 q=1 -> 3)', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 4, 10);
    expect(Number((await post1('return_to_store', S1, item, lot, 1))[0]!['value_paisa'])).toBe(3);
  });
  dbIt('return/adjust into an EMPTY lot row uses the lot last receipt unit cost (8 for 5 paisa: q=1 -> 1, basis last_receipt)', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 8, 5);
    await post1('issue', S1, item, lot, -8);
    await admin.query('UPDATE inventory.lots SET last_receipt_qty_base = 8, last_receipt_value_paisa = 5 WHERE id = $1', [lot]);
    const [m] = await post1('adjust_in', S1, item, lot, 1);
    expect(Number(m!['value_paisa'])).toBe(1);
    expect(m!['value_basis']).toBe('last_receipt');
  });
  dbIt('return/adjust into an empty lot row with no last receipt is valued 0, basis none', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    const [m] = await post1('return_to_store', S1, item, lot, 3);
    expect(Number(m!['value_paisa'])).toBe(0);
    expect(m!['value_basis']).toBe('none');
    expect(await bal(S1, item, lot)).toMatchObject({ qty: 3, value: 0 });
  });
  dbIt('adjust_in on the unlotted row = q x the store average cost of the item over its lot rows with qty > 0 (200/unit -> 2 units = 400)', async () => {
    const item = await mkItem();
    await receive(S1, item, await mkLot(item), 10, 1000);
    await receive(S1, item, await mkLot(item), 10, 3000);
    const [m] = await post1('adjust_in', S1, item, null, 2);
    expect(m).toMatchObject({ lot_id: null, value_basis: 'average' });
    expect(Number(m!['value_paisa'])).toBe(400);
  });
  dbIt('consume_reversal is exactly the negated reversed value (not re-averaged): consume 1 of Q=3 V=100 (-33), reverse (+33), row back to 3 / 100; daily nets to 0 under consume_test', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 3, 100);
    const ex = { instrument_id: INSTR, attributed_test_id: TEST7, rule_id: RULE };
    const [c] = await post1('consume_test', S1, item, lot, -1, ex);
    expect(Number(c!['value_paisa'])).toBe(-33);
    const [r] = await post1('consume_reversal', S1, item, lot, 1, { ...ex, reverses_movement_id: c!['id'] });
    expect(Number(r!['value_paisa'])).toBe(33);
    expect(r!['value_basis']).toBe('reversal');
    expect(r!['reverses_movement_id']).toBe(c!['id']);
    expect(await bal(S1, item, lot)).toMatchObject({ qty: 3, value: 100 });
    const d = (await dailyOf(item)).filter((x) => x['movement_kind'] === 'consume_test');
    expect(d).toHaveLength(1);
    expect(Number(d[0]!['qty_consumed'])).toBe(0);
    expect(Number(d[0]!['value_consumed_paisa'])).toBe(0);
  });
  // review T-05 item 2 (TRD §4.3 step 2): the reversed movement must be the same store/item/lot and exactly the negated qty, else common.validation_failed and nothing written
  const MISMATCH: Array<[string, 'item' | 'lot' | 'qty']> = [['a different item', 'item'], ['a different lot of the same item', 'lot'], ['a different quantity', 'qty']];
  for (const [label, how] of MISMATCH) {
    dbIt(`consume_reversal of a movement of ${label} is refused (common.validation_failed) and moves no value`, async () => {
      const itemA = await mkItem(); const lotA = await mkLot(itemA);
      const itemB = await mkItem(); const lotB = await mkLot(itemB); const lotA2 = await mkLot(itemA);
      await receive(S1, itemA, lotA, 10, 1000);
      await receive(S1, itemA, lotA2, 10, 5000);
      await receive(S1, itemB, lotB, 10, 9000);
      const ex = { instrument_id: INSTR, attributed_test_id: TEST7, rule_id: RULE };
      const [c] = await post1('consume_test', S1, itemA, lotA, -2, ex);       // -200 on lotA
      const target = { item: [itemB, lotB, 2], lot: [itemA, lotA2, 2], qty: [itemA, lotA, 1] }[how] as [string, string, number];
      const e = await rejection(post1('consume_reversal', S1, target[0], target[1], target[2], { ...ex, reverses_movement_id: c!['id'] }));
      expect(isLimsError(e, 'common.validation_failed')).toBe(true);
      expect(await nMovements(itemB)).toBe(1);
      expect(await bal(S1, itemA, lotA)).toMatchObject({ qty: 8, value: 800 });
      expect(await bal(S1, itemA, lotA2)).toMatchObject({ qty: 10, value: 5000 });
      expect(await bal(S1, itemB, lotB)).toMatchObject({ qty: 10, value: 9000 });
    });
  }
  dbIt('transfer_in keeps the value given by the source (value_hint), basis transfer', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    const [m] = await post1('transfer_in', S2, item, lot, 98, { value_hint: 49_000 });
    expect(Number(m!['value_paisa'])).toBe(49_000);
    expect(m!['value_basis']).toBe('transfer');
  });
});

// PRD §8.1 / TRD §4.3 step 2 (08 A17 D-75): inbound into a negative unlotted row
describe('D-75 inbound into a negative unlotted row', () => {
  dbIt('q > -Q: the first -Q units take +1000 (clearing -V), the remainder at the store average: adjust_in 15 into -10/-1000 -> +1500 in one movement, row 5 / 500', async () => {
    const item = await mkItem(); await negativeUnlotted(S1, item, 10, 1000);
    const rows = await post1('adjust_in', S1, item, null, 15);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!['value_paisa'])).toBe(1500);
    expect(await bal(S1, item, null)).toMatchObject({ qty: 5, value: 500 });
  });
  dbIt('q < -Q: value = round_half_up(q x V / Q): 4 into -10/-1000 -> 400, row -6 / -600', async () => {
    const item = await mkItem(); await negativeUnlotted(S1, item, 10, 1000);
    expect(Number((await post1('adjust_in', S1, item, null, 4))[0]!['value_paisa'])).toBe(400);
    expect(await bal(S1, item, null)).toMatchObject({ qty: -6, value: -600 });
  });
  dbIt('q = -Q: the row ends at exactly 0 / 0 (count_adjust_in, 03-APP-FLOW E7); reported under count_adjust_out with negative qty', async () => {
    const item = await mkItem(); await negativeUnlotted(S1, item, 10, 1000);
    expect(Number((await post1('count_adjust_in', S1, item, null, 10))[0]!['value_paisa'])).toBe(1000);
    expect(await bal(S1, item, null)).toMatchObject({ qty: 0, value: 0 });
    const d = (await dailyOf(item)).find((r) => r['movement_kind'] === 'count_adjust_out')!;
    expect(Number(d['qty_consumed'])).toBe(-10);
  });
  dbIt('tie in the q < -Q branch rounds half-up: 1 into -8/-5 -> 0.625 -> 1', async () => {
    const item = await mkItem(); await negativeUnlotted(S1, item, 8, 5);
    expect(Number((await post1('adjust_in', S1, item, null, 1))[0]!['value_paisa'])).toBe(1);
    expect(await bal(S1, item, null)).toMatchObject({ qty: -7, value: -4 });
  });
  dbIt('return_to_store into the negative row follows the same rule', async () => {
    const item = await mkItem(); await negativeUnlotted(S1, item, 10, 1000);
    expect(Number((await post1('return_to_store', S1, item, null, 4))[0]!['value_paisa'])).toBe(400);
  });
  dbIt('receive (source-fixed value) is NOT netted against the negative row: value stays the capitalised 700', async () => {
    const item = await mkItem(); await negativeUnlotted(S1, item, 10, 1000);
    expect(Number((await receive(S1, item, null, 15, 700))[0]!['value_paisa'])).toBe(700);
    expect(await bal(S1, item, null)).toMatchObject({ qty: 5, value: -300 });
  });
});

// ---------------------------------------------------------------------------------------------------------- outbound rules
describe('outbound: insufficient stock, split, unlotted (TRD §4.3 steps 3-4)', () => {
  for (const kind of ['issue', 'adjust_out', 'supplier_return', 'wastage', 'expiry_writeoff', 'transfer_out']) {
    dbIt(`${kind} of more than the lot row holds -> 409 inventory.insufficient_stock and nothing written`, async () => {
      const item = await mkItem(); const lot = await mkLot(item);
      await receive(S1, item, lot, 5, 500);
      const e = await rejection(post1(kind, S1, item, lot, -6));
      expect(isLimsError(e, 'inventory.insufficient_stock')).toBe(true);
      expect(await nMovements(item)).toBe(1);
      expect(await bal(S1, item, lot)).toMatchObject({ qty: 5, value: 500 });
    });
  }
  dbIt('a failing movement rolls back the whole batch: [issue 3 ok, issue 99] leaves no issue row', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 5, 500);
    const e = await rejection(postMany([mv('issue', S1, item, lot, -3), mv('issue', S1, item, lot, -99)]));
    expect(isLimsError(e, 'inventory.insufficient_stock')).toBe(true);
    expect(await nMovements(item)).toBe(1);
    expect(await bal(S1, item, lot)).toMatchObject({ qty: 5, value: 500 });
  });
  dbIt('AC-12.8: consume_test of 25 against a lot row of 10 never fails: lot part -10 at -V, remainder -15 on the unlotted row, negative_stock alert opens', async () => {
    const item = await mkItem(); const l1 = await mkLot(item); const l2 = await mkLot(item);
    await receive(S1, item, l1, 10, 1000);
    await receive(S1, item, l2, 10, 1000);     // average cost 100/unit before and after l1 empties
    const rows = await post1('consume_test', S1, item, l1, -25, { instrument_id: INSTR, attributed_test_id: TEST7 });
    expect(rows.map((r) => [r['lot_id'], Number(r['qty_base']), Number(r['value_paisa'])])).toEqual([[l1, -10, -1000], [null, -15, -1500]]);
    expect(rows.every((r) => r['movement_kind'] === 'consume_test' && r['instrument_id'] === INSTR && r['attributed_test_id'] === TEST7)).toBe(true);
    expect(await bal(S1, item, l1)).toMatchObject({ qty: 0, value: 0 });
    expect(await bal(S1, item, null)).toMatchObject({ qty: -15, value: -1500 });
    const al = await alertsOf('negative_stock', S1, item);
    expect(al.filter((a) => a['status'] !== 'resolved')).toHaveLength(1);
    const d = (await dailyOf(item)).find((r) => r['movement_kind'] === 'consume_test')!;
    expect(Number(d['qty_consumed'])).toBe(25);                 // lot part + unlotted part, one key
    expect(Number(d['value_consumed_paisa'])).toBe(2500);
  });
  dbIt('AC-12.8 / E7: consumption with no stock at all -> unlotted movement (lot null), value 0 basis none, negative_stock open; a second one raises occurrences, not a second alert', async () => {
    const item = await mkItem();
    const [m] = await post1('consume_test', S1, item, null, -7);
    expect(m).toMatchObject({ lot_id: null, value_basis: 'none' });
    expect(Number(m!['value_paisa'])).toBe(0);
    expect(await bal(S1, item, null)).toMatchObject({ qty: -7, value: 0 });
    let al = await alertsOf('negative_stock', S1, item);
    expect(al).toHaveLength(1);
    expect(al[0]!['status']).toBe('open');
    expect(Number(al[0]!['occurrences'])).toBe(1);
    await post1('consume_test', S1, item, null, -3);
    al = await alertsOf('negative_stock', S1, item);
    expect(al).toHaveLength(1);
    expect(Number(al[0]!['occurrences'])).toBe(2);
  });
  dbIt('unlotted outbound with no lot rows falls back to the most recent lot last_receipt unit cost (400 for 50000 -> 4 units = 500, basis last_receipt)', async () => {
    const item = await mkItem(); await mkLot(item, { lastQty: 400, lastValue: 50_000 });
    const [m] = await post1('consume_test', S1, item, null, -4);
    expect(Number(m!['value_paisa'])).toBe(-500);
    expect(m!['value_basis']).toBe('last_receipt');
  });
  dbIt('unlotted outbound is valued at average cost with half-up ties (non-tracked item: row Q=2 V=7 -> issue 1 = 4); negative_stock only when the row goes below 0', async () => {
    const item = await mkItem(false);
    await receive(S1, item, null, 2, 7);
    expect(Number((await post1('issue', S1, item, null, -1))[0]!['value_paisa'])).toBe(-4);
    expect(Number((await post1('consume_test', S1, item, null, -1))[0]!['value_paisa'])).toBe(-3);
    expect(await bal(S1, item, null)).toMatchObject({ qty: 0, value: 0 });
    expect(await alertsOf('negative_stock', S1, item)).toHaveLength(0);
    const [m] = await post1('consume_test', S1, item, null, -1);
    expect(Number(m!['value_paisa'])).toBe(0);
    expect(m!['value_basis']).toBe('none');
    expect(await alertsOf('negative_stock', S1, item)).toHaveLength(1);
  });
  dbIt('count_adjust_out larger than the lot row (AC-19.3/19.4 split) never fails: -Q on the lot row, remainder on the unlotted row, negative_stock opens', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 4, 400);
    const rows = await post1('count_adjust_out', S1, item, lot, -6);
    expect(rows.map((r) => [r['lot_id'], Number(r['qty_base'])])).toEqual([[lot, -4], [null, -2]]);
    expect(await bal(S1, item, lot)).toMatchObject({ qty: 0, value: 0 });
    expect(await alertsOf('negative_stock', S1, item)).toHaveLength(1);
  });
  dbIt('no negative_stock alert while stock covers the consumption', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 10, 1000);
    await post1('consume_test', S1, item, lot, -10);
    expect(await alertsOf('negative_stock', S1, item)).toHaveLength(0);
  });
  // review T-05 item 1 (TRD §4.3 step 7, third bullet): consume_* (not consume_reversal) on a lot expired before business_date
  dbIt('expired_lot_in_use: consume_test on a lot with expiry_on before business_date opens ONE alert (store, item, lot set); a repeat raises occurrences to 2', async () => {
    const item = await mkItem(); const lot = await mkLot(item, { expiry: '2020-01-01' });
    await receive(S1, item, lot, 10, 1000);
    expect(await alertsOf('expired_lot_in_use', S1, item)).toHaveLength(0);   // receive is not a consumption
    await post1('consume_test', S1, item, lot, -1);
    let al = await alertsOf('expired_lot_in_use', S1, item);
    expect(al).toHaveLength(1);
    expect(al[0]).toMatchObject({ status: 'open', store_id: S1, item_id: item, lot_id: lot, alert_kind: 'expired_lot_in_use' });
    expect(Number(al[0]!['occurrences'])).toBe(1);
    await post1('consume_test', S1, item, lot, -1);
    al = await alertsOf('expired_lot_in_use', S1, item);
    expect(al).toHaveLength(1);
    expect(Number(al[0]!['occurrences'])).toBe(2);
  });
  dbIt('no expired_lot_in_use for a lot that has not expired, nor for a non-consume outbound (issue) on an expired lot', async () => {
    const item = await mkItem(); const fresh = await mkLot(item); const old = await mkLot(item, { expiry: '2020-01-01' });
    await receive(S1, item, fresh, 10, 1000);
    await receive(S1, item, old, 10, 1000);
    await post1('consume_test', S1, item, fresh, -1);
    await post1('issue', S1, item, old, -1);
    expect(await alertsOf('expired_lot_in_use', S1, item)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------- consumption_daily (TRD §4.3 step 6, 05-SCHEMA §6.4)
describe('consumption_daily upsert', () => {
  dbIt('one row per key accumulates: qty_consumed, value_consumed_paisa and movements; a different instrument is a different row; NULL instrument/test is one key (NULLS NOT DISTINCT)', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 100, 10_000);
    await post1('consume_test', S1, item, lot, -3, { instrument_id: INSTR, attributed_test_id: TEST7 });
    await post1('consume_test', S1, item, lot, -2, { instrument_id: INSTR, attributed_test_id: TEST7 });
    await post1('consume_test', S1, item, lot, -4);
    await post1('consume_test', S1, item, lot, -1);
    await post1('issue', S1, item, lot, -5);
    const d = await dailyOf(item);
    expect(d).toHaveLength(3);
    const key = (k: string, instr: string | null) => d.find((r) => r['movement_kind'] === k && r['instrument_id'] === instr)!;
    expect(Number(key('consume_test', INSTR)['qty_consumed'])).toBe(5);
    expect(Number(key('consume_test', INSTR)['value_consumed_paisa'])).toBe(500);
    expect(Number(key('consume_test', INSTR)['movements'])).toBe(2);
    expect(Number(key('consume_test', null)['qty_consumed'])).toBe(5);
    expect(Number(key('issue', null)['qty_consumed'])).toBe(5);
    expect(d[0]!['business_date']).toBeDefined();
  });
  dbIt('kinds outside the §6.4 list write nothing: receive, opening_balance, supplier_return, adjust_in, adjust_out, transfer_out, transfer_in', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 50, 5000);
    await post1('opening_balance', S1, item, lot, 5, { value_hint: 500 });
    await post1('adjust_in', S1, item, lot, 2);
    await post1('adjust_out', S1, item, lot, -2);
    await post1('supplier_return', S1, item, lot, -3);
    await post1('transfer_out', S1, item, lot, -4);
    await post1('transfer_in', S2, item, lot, 4, { value_hint: 400 });
    expect(await dailyOf(item)).toEqual([]);
  });
  dbIt('wastage, expiry_writeoff and count_adjust_out are recorded under their own kind with positive qty and value', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 100, 10_000);
    await post1('wastage', S1, item, lot, -3);
    await post1('expiry_writeoff', S1, item, lot, -2);
    await post1('count_adjust_out', S1, item, lot, -1);
    const d = await dailyOf(item);
    expect(d.map((r) => [r['movement_kind'], Number(r['qty_consumed']), Number(r['value_consumed_paisa'])]).sort()).toEqual(
      [['count_adjust_out', 1, 100], ['expiry_writeoff', 2, 200], ['wastage', 3, 300]]);
  });
});

// ---------------------------------------------------------------------------------------------------------- alerts (AC-20.1, AC-20.2)
describe('below_reorder alert (TRD §4.3 step 7)', () => {
  dbIt('AC-20.1: falling below the level opens ONE alert; later movements update occurrences/last_raised_at, never a second row; exactly at the level is not below', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await setReorder(S1, item, 200);
    await receive(S1, item, lot, 250, 25_000);
    await post1('consume_test', S1, item, lot, -50);                        // 200 = level: not below
    expect(await alertsOf('below_reorder', S1, item)).toHaveLength(0);
    await post1('consume_test', S1, item, lot, -10);                        // 190
    let al = await alertsOf('below_reorder', S1, item);
    expect(al).toHaveLength(1);
    expect(al[0]).toMatchObject({ status: 'open', store_id: S1, item_id: item, alert_kind: 'below_reorder' });
    expect(Number(al[0]!['occurrences'])).toBe(1);
    const first = new Date(al[0]!['last_raised_at']).getTime();
    await post1('consume_test', S1, item, lot, -10);                        // 180
    al = await alertsOf('below_reorder', S1, item);
    expect(al).toHaveLength(1);
    expect(Number(al[0]!['occurrences'])).toBe(2);
    expect(new Date(al[0]!['last_raised_at']).getTime()).toBeGreaterThanOrEqual(first);
  });
  dbIt('AC-20.2: back to or above the level auto-resolves; falling below again opens a new alert', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await setReorder(S1, item, 200);
    await receive(S1, item, lot, 190, 19_000);                              // first post is already below the level
    expect((await alertsOf('below_reorder', S1, item)).filter((a) => a['status'] === 'open')).toHaveLength(1);
    await receive(S1, item, lot, 10, 1000);                                 // exactly 200
    const al = await alertsOf('below_reorder', S1, item);
    expect(al).toHaveLength(1);
    expect(al[0]!['status']).toBe('resolved');
    expect(al[0]!['resolved_at']).not.toBeNull();
    await post1('consume_test', S1, item, lot, -1);                         // 199
    const again = await alertsOf('below_reorder', S1, item);
    expect(again).toHaveLength(2);
    expect(again.filter((a) => a['status'] === 'open')).toHaveLength(1);
  });
  for (const [label, level, active] of [['no reorder level (null)', null, true], ['inactive setting', 100, false]] as const) {
    dbIt(`no alert for ${label}`, async () => {
      const item = await mkItem(); const lot = await mkLot(item);
      await setReorder(S1, item, level, active);
      await receive(S1, item, lot, 10, 1000);
      await post1('consume_test', S1, item, lot, -5);
      expect(await alertsOf('below_reorder', S1, item)).toHaveLength(0);
    });
  }
  dbIt('no alert for an item with no store_item_settings row, and a level on another store does not apply', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await setReorder(S2, item, 1000);
    await receive(S1, item, lot, 10, 1000);
    expect(await alertsOf('below_reorder', S1, item)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------- persistence, bad input, isolation
describe('persisted movement rows, input validation, tenant isolation', () => {
  dbIt('the row carries ctx tenant/actor, the document, caller fields and balance_qty_after; the balance row version moves by one per movement', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 10, 1000);
    const v0 = (await bal(S1, item, lot))!.version;
    const docId = nid(); const lineId = nid(); const at = iso(-3_600_000); const bd = at.slice(0, 10);
    const [m] = await asApi(A, (rc) => ledger.post(rc, { doc_type: 'consumption_fact', doc_id: docId, occurred_at: at, business_date: bd,
      movements: [mv('consume_qc', S1, item, lot, -4, { doc_line_id: lineId, instrument_id: INSTR, attributed_test_id: TEST7, rule_id: RULE, reason_code: "o'neil'; DROP TABLE inventory.stock_movements;--" })] }));
    expect(m).toMatchObject({ tenant_id: A, created_by: SYS, store_id: S1, item_id: item, lot_id: lot, movement_kind: 'consume_qc', doc_type: 'consumption_fact', doc_id: docId, doc_line_id: lineId,
      instrument_id: INSTR, attributed_test_id: TEST7, rule_id: RULE, reason_code: "o'neil'; DROP TABLE inventory.stock_movements;--" });
    expect(new Date(m!['occurred_at']).getTime()).toBe(new Date(at).getTime());
    expect((await sql('SELECT business_date::text AS d FROM inventory.stock_movements WHERE id = $1', [m!['id']]))[0]!['d']).toBe(bd);
    expect(Number(m!['balance_qty_after'])).toBe(6);
    expect((await bal(S1, item, lot))!.version).toBe(v0 + 1);
    const back = await sql('SELECT balance_qty_after FROM inventory.stock_movements WHERE id = $1', [m!['id']]);
    expect(Number(back[0]!['balance_qty_after'])).toBe(6);
  });
  const BAD: Array<[string, (item: string, lot: string) => Mv[]]> = [
    ['qty 0', (i, l) => [mv('issue', S1, i, l, '0')]],
    ['qty not a DecimalString (1e3)', (i, l) => [mv('receive', S1, i, l, '1e3', { value_hint: 1 })]],
    ['qty with 7 decimals', (i, l) => [mv('receive', S1, i, l, '1.1234567', { value_hint: 1 })]],
    ['qty with a comma', (i, l) => [mv('receive', S1, i, l, '1,5', { value_hint: 1 })]],
    ['qty empty', (i, l) => [mv('receive', S1, i, l, '', { value_hint: 1 })]],
    ['receive with a negative qty', (i, l) => [mv('receive', S1, i, l, '-5', { value_hint: 1 })]],
    ['issue with a positive qty', (i, l) => [mv('issue', S1, i, l, '5')]],
    ['unknown kind', (i, l) => [mv('teleport', S1, i, l, '5')]],
    ['negative value_hint', (i, l) => [mv('receive', S1, i, l, '5', { value_hint: -1 })]],
    ['fractional value_hint', (i, l) => [mv('receive', S1, i, l, '5', { value_hint: 1.5 })]],
    ['consume_reversal without reverses_movement_id', (i, l) => [mv('consume_reversal', S1, i, l, '1')]],
  ];
  for (const [label, build] of BAD) {
    dbIt(`bad input is rejected and writes nothing: ${label}`, async () => {
      const item = await mkItem(); const lot = await mkLot(item);
      const e = await rejection(postMany(build(item, lot)));
      expect(e).toBeInstanceOf(Error);
      expect(await nMovements(item)).toBe(0);
      expect(await bal(S1, item, lot)).toBeNull();
    });
  }
  dbIt('shape errors (qty not a DecimalString, empty batch) are LimsError common.validation_failed', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    expect(isLimsError(await rejection(postMany([mv('receive', S1, item, lot, '1e3', { value_hint: 1 })])), 'common.validation_failed')).toBe(true);
    expect(isLimsError(await rejection(postMany([], { docType: 'goods_receipt' })), 'common.validation_failed')).toBe(true);
  });
  dbIt('tenant A cannot post against tenant B ids: rejected, nothing written for either tenant (composite FK + explicit tenant)', async () => {
    const before = Number((await sql('SELECT count(*) AS n FROM inventory.stock_movements WHERE tenant_id = $1', [B]))[0]!['n']);
    await rejection(postMany([mv('receive', S_B, ITEM_B, null, 5, { value_hint: 100 })]));
    await rejection(postMany([mv('receive', S1, ITEM_B, null, 5, { value_hint: 100 })]));
    expect(Number((await sql('SELECT count(*) AS n FROM inventory.stock_movements WHERE tenant_id = $1', [B]))[0]!['n'])).toBe(before);
    expect(Number((await sql('SELECT count(*) AS n FROM inventory.stock_movements WHERE item_id = $1 AND tenant_id = $2', [ITEM_B, A]))[0]!['n'])).toBe(0);
  });
  dbIt('a tenant_id smuggled in a movement never reaches the row: rejected or ignored, never written to tenant B', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    try { await postMany([mv('receive', S1, item, lot, 5, { value_hint: 100, tenant_id: B })]); } catch { /* rejecting is fine */ }
    expect(await sql('SELECT 1 FROM inventory.stock_movements WHERE item_id = $1 AND tenant_id <> $2', [item, A])).toEqual([]);
  });
  dbIt('statements: locks the balance rows FOR UPDATE in (store_id, item_id, lot_id NULLS FIRST) order, binds every value, never rewrites the ledger', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    const stmts = await asApi(A, async (rc, s) => { await ledger.post(rc, { doc_type: 'goods_receipt', doc_id: nid(), occurred_at: iso(), business_date: today(), movements: [mv('receive', S1, item, lot, 5, { value_hint: 100 })] }); return s; });
    const all = stmts.map((s) => s.text);
    expect(all.some((t) => /stock_balances/i.test(t) && /FOR\s+UPDATE/i.test(t) && /ORDER\s+BY[^;]*store_id[^;]*item_id[^;]*lot_id\s+NULLS\s+FIRST/i.test(t)), 'TRD §4.3 step 1').toBe(true);
    expect(all.some((t) => /INSERT\s+INTO\s+inventory\.stock_balances[\s\S]*ON\s+CONFLICT[\s\S]*DO\s+NOTHING/i.test(t)), 'missing rows are inserted first (step 1)').toBe(true);
    for (const t of all) {
      expect(t).not.toContain(item); expect(t).not.toContain(lot); expect(t).not.toContain(S1);                 // values are bound, never interpolated
      expect(t).not.toMatch(/\b(UPDATE|DELETE\s+FROM|TRUNCATE)\s+(TABLE\s+)?inventory\.stock_movements\b/i);
      if (/inventory\./i.test(t)) expect(t, 'explicit tenant filter').toMatch(/tenant_id/i);
    }
  });
});

describe('structure (TRD §3.1: ledger.service.post is the ONLY writer; §4.3: TS never computes money)', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));      // services/api/src/modules/inventory/
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = `${dir}/${n}`;
    return statSync(p).isDirectory() ? (n === '__tests__' || n === 'repository' ? [] : walk(p)) : /\.ts$/.test(n) ? [p] : [];
  });
  it('ledger.service.ts does no arithmetic on quantities or money (SQL numeric only)', () => {
    const src = readFileSync(`${root}service/ledger.service.ts`, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/Math\.(round|floor|ceil|trunc)|parseFloat|toFixed|\bBigInt\(/);
  });
  it('no file outside ledger.service.ts writes stock_movements / stock_balances / consumption_daily', () => {
    const offenders = walk(root).filter((f) => !/service\/ledger\.service\.ts$/.test(f.replace(/\\/g, '/')))
      .filter((f) => /\b(insertMovement|insertBalance|updateBalance|insertConsumptionDaily|updateConsumptionDaily)\b|(INSERT\s+INTO|UPDATE)\s+inventory\.(stock_movements|stock_balances|consumption_daily)/i.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------- concurrency (TRD §15, done_when)
describe('concurrency: one transaction per post, own connection', () => {
  dbIt('20 parallel consume_test posts of 3 on the same lot row: all succeed (no deadlock), balance exact 940 / 94000, serial balance_qty_after, daily row exact', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 1000, 100_000);                              // 100/unit: every partial value is exact whatever the order
    const res = await Promise.allSettled(Array.from({ length: 20 }, () => post1('consume_test', S1, item, lot, -3, { instrument_id: INSTR, attributed_test_id: TEST7 })));
    expect(res.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(await bal(S1, item, lot)).toMatchObject({ qty: 940, value: 94_000 });
    const rows = await sql("SELECT qty_base, value_paisa, balance_qty_after FROM inventory.stock_movements WHERE item_id = $1 AND movement_kind = 'consume_test'", [item]);
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => Number(r['value_paisa']) === -300)).toBe(true);
    expect(rows.map((r) => Number(r['balance_qty_after'])).sort((a, b) => b - a)).toEqual(Array.from({ length: 20 }, (_, i) => 997 - 3 * i));
    const d = await dailyOf(item);
    expect(d).toHaveLength(1);
    expect(Number(d[0]!['qty_consumed'])).toBe(60);
    expect(Number(d[0]!['value_consumed_paisa'])).toBe(6000);
    expect(Number(d[0]!['movements'])).toBe(20);
  });
  dbIt('20 parallel first receipts into a not-yet-existing balance row: one row, qty and value exact', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    const res = await Promise.allSettled(Array.from({ length: 20 }, () => receive(S1, item, lot, 5, 250)));
    expect(res.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(await sql('SELECT 1 FROM inventory.stock_balances WHERE item_id = $1 AND store_id = $2', [item, S1])).toHaveLength(1);
    expect(await bal(S1, item, lot)).toMatchObject({ qty: 100, value: 5000 });
  });
  dbIt('batches touching the same keys in opposite input order never deadlock (locks are taken in (store, item, lot NULLS FIRST) order)', async () => {
    const item = await mkItem(); const l1 = await mkLot(item); const l2 = await mkLot(item);
    await receive(S1, item, l1, 100, 10_000); await receive(S1, item, l2, 100, 10_000); await receive(S2, item, l1, 100, 10_000);
    const res = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => {
      const a = mv('consume_test', S1, item, l1, -1); const b = mv('consume_test', S1, item, l2, -1); const c = mv('consume_test', S2, item, l1, -1); const u = mv('consume_test', S1, item, null, -1);
      return postMany(i % 2 === 0 ? [a, b, c, u] : [u, c, b, a]);
    }));
    expect(res.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(await bal(S1, item, l1)).toMatchObject({ qty: 80, value: 8000 });
    expect(await bal(S1, item, l2)).toMatchObject({ qty: 80, value: 8000 });
    expect(await bal(S2, item, l1)).toMatchObject({ qty: 80, value: 8000 });
    expect((await bal(S1, item, null))!.qty).toBe(-20);
  });
  dbIt('2 parallel issues of the last stock: exactly one succeeds, the other is 409 inventory.insufficient_stock', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 10, 1000);
    const res = await Promise.allSettled([post1('issue', S1, item, lot, -10), post1('issue', S1, item, lot, -10)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(isLimsError(lost.reason, 'inventory.insufficient_stock')).toBe(true);
    expect(await bal(S1, item, lot)).toMatchObject({ qty: 0, value: 0 });
  });
  dbIt('20 parallel consumptions of 3 against a lot of 30: never fails, lot row never negative, 60 consumed in total (30 on the lot row, 30 on the unlotted row)', async () => {
    const item = await mkItem(); const lot = await mkLot(item);
    await receive(S1, item, lot, 30, 3000);
    const res = await Promise.allSettled(Array.from({ length: 20 }, () => post1('consume_test', S1, item, lot, -3, { instrument_id: INSTR, attributed_test_id: TEST7 })));
    expect(res.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(await bal(S1, item, lot)).toMatchObject({ qty: 0, value: 0 });
    expect((await bal(S1, item, null))!.qty).toBe(-30);
    expect(Number((await sql("SELECT -sum(qty_base) AS q FROM inventory.stock_movements WHERE item_id = $1 AND movement_kind = 'consume_test'", [item]))[0]!['q'])).toBe(60);
    expect((await alertsOf('negative_stock', S1, item)).filter((a) => a['status'] !== 'resolved')).toHaveLength(1);
  });
});
