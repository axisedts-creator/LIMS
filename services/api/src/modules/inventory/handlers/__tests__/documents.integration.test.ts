// C12.T-10 integration + probes for #40-#48 on the migrated database as role lims_api with RLS on (REAL repositories, handlers/index.ts, T-04 scope service, T-05 ledger, T-09 handlers for read-back).
// Harness: tests/db/c12-t10/run.sh (clone of c12-t09: pinned image, migrations, seeds, inventory DDL, exports LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL / LIMS_C12T03_REQUIRE_DB=1).
// Fixtures: tests/db/c12-t03/fixtures.sql (stores 1001 MAIN-A (open count 8901) 1002 BENCH-A; items 2001 GLU-R1 (lot tracked; packs 2201 BOX = 400, 2202 KIT = 100) 2004 INACTIVE; suppliers 3002 / tenant B 3101;
//   posted GRN 8002 (store 1001, supplier 3002); tenant B: store 1101, item 2101, lot 4101, GRN 8101, document 9201, container 9311; document 9001 (issue, 2 lines); instruments 421 / 431; reasons: global wastage
//   spillage|damaged, tenant wastage lab_custom (active) and old_one (INACTIVE), count_variance) + EXTRAS below (ids 15xxx, committed once with the superuser, ON CONFLICT DO NOTHING).
// Each test = one request-shaped transaction that is ROLLED BACK; every handler call runs inside a SAVEPOINT. The race tests commit (own stores / lots) and never touch other fixtures.
// Without the URLs the DB tests skip, except under LIMS_C12T03_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails.
// EXTRAS (tenant A): stores S1 (BR1) S2 (BR2) S3 (BR1, race), department DEPT (tenant B: DEPT_B), reasons adjustment/stock_correction supplier_return/damaged_on_arrival|wrong_item.
//   IT (lot tracked): LA 100 u / 33 325 paisa (98 -> 32 658.5 -> half-up 32 659, not banker's 32 658) LB 7 u / 100, LX expired yesterday, LT expires today, LQ quarantined, LBK blocked, LL 5 u, LZ Q = 0 with last receipt
//   50 u / 7 500, LN no row and no receipt data, LK (MAIN) LK2 (BENCH-A). IF (FEFO): FA +10 d 10 u / 1000, FB +40 d 20 u / 2000, FC quarantined, FD expired, FE blocked (50 u each). IG: GA +10 d, GB +40 d with an OPEN
//   container on GB. IU: not lot tracked, 25 u / 2500 (100 paisa a unit). D-75 rows (unlotted, negative): NA -4 / -400 (+ lots 10 u / 1500 and 30 u / 4500 => average 150), NB -3 / -100, NF -4 / -400 (no cost info).
//   IW (expiry write-off): W1 10 u / 1000 and W2 20 u / 333 expired, W3 not expired, W4 expired with Q = 0, W5 expired in S2. ID (discard): D1 20 u / 4000, D2 expired, D3 quarantined; containers C1 C2 C7 (open) C3 (finished) C4
//   (discarded) C5 (S2) C6 (IU, no lot). Race items IR1 IR2 IR5 IR3 (+ container CR) in S3. LG2: GLU lot in MAIN, 1000 u / 500 000 paisa (500 paisa a unit).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  A, ADJUST, B, BENCH, BR1, BR2, CONTAINER_KEYS, COST, DOC_KEYS, DOC_LINE_KEYS, DOC_NO, DOC_SUMMARY_KEYS, KIND_OF, LEAK, MANAGE, MOVEMENT_KEYS, PERMISSION, READ, SYS, addDays, adjustBody, aLine, call, costKeys,
  dLine, discardBody, expectLims, ifm, issueBody, makeDocCtx, onlyKeys, qty, rej, returnBody, supplierReturnBody, uid, wastageBody, writeoffBody, ymdIn, type LotOpts,
} from './documents.helpers.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

// fixtures (T-03)
const MAIN = uid(1001), BENCH_ST = uid(1002), GLU = uid(2001), OLD_IT = uid(2004), BOX = uid(2201), KIT = uid(2202);
const SUP = uid(3002), SUP_B = uid(3101), GRN_P = uid(8002), GRN_B = uid(8101), IN_A = uid(421), IN_B = uid(431), DOC_FX = uid(9001), DOC_B = uid(9201), CONT_B = uid(9311), DOC_WASTE_FX = uid(9002);
const MAIN_B = uid(1101), GLU_B = uid(2101), LOT_B = uid(4101);
// extras
const KT = 'Asia/Kathmandu', TODAY = ymdIn(KT);
const S1 = uid(15001), S2 = uid(15002), S3 = uid(15003), DEPT = uid(15900), DEPT_B = uid(15901);
const IT = uid(15101), IF_ = uid(15102), IG = uid(15103), IU = uid(15104), NA = uid(15111), NB = uid(15112), NF = uid(15113), IR1 = uid(15121), IR2 = uid(15122), IR5 = uid(15123), IR3 = uid(15124), IW = uid(15131), ID = uid(15141);
const LA = uid(15201), LB = uid(15202), LX = uid(15203), LT = uid(15204), LQ = uid(15205), LBK = uid(15206), LL = uid(15207), LZ = uid(15208), LN = uid(15209), LK = uid(15210), LK2 = uid(15211);
const FA = uid(15221), FB = uid(15222), FC = uid(15223), FD = uid(15224), FE = uid(15225), GA = uid(15231), GB = uid(15232), NA1 = uid(15241), NA2 = uid(15242);
const R1 = uid(15251), R2 = uid(15252), R5 = uid(15253), R3 = uid(15254), W1 = uid(15261), W2 = uid(15262), W3 = uid(15263), W4 = uid(15264), W5 = uid(15265), D1 = uid(15271), D2 = uid(15272), D3 = uid(15273), LG2 = uid(15281);
const CG = uid(15701), C1 = uid(15711), C2 = uid(15712), C3 = uid(15713), C4 = uid(15714), C5 = uid(15715), C6 = uid(15716), C7 = uid(15717), CR = uid(15720);
const BR1_ONLY: LotOpts = { all: false, branchIds: [BR1] };
const BR2_ONLY: LotOpts = { all: false, branchIds: [BR2] };
const NOBODY: LotOpts = { all: false, branchIds: [] };
const WITH_COST: LotOpts = { permissions: [READ, MANAGE, ADJUST, BENCH, COST] };
const TECH: LotOpts = { permissions: [READ, BENCH] };
const NO_ADJUST: LotOpts = { permissions: [READ, MANAGE, BENCH] };

// id, item, lot_no, expiry, status, last_receipt_qty, last_receipt_value
const lots: [string, string, string, string, string, number | null, number | null][] = [
  [LA, IT, 'T10-LA', addDays(TODAY, 60), 'available', null, null], [LB, IT, 'T10-LB', addDays(TODAY, 60), 'available', null, null], [LX, IT, 'T10-LX', addDays(TODAY, -1), 'available', null, null],
  [LT, IT, 'T10-LT', TODAY, 'available', null, null], [LQ, IT, 'T10-LQ', addDays(TODAY, 60), 'quarantined', null, null], [LBK, IT, 'T10-LBK', addDays(TODAY, 60), 'blocked', null, null],
  [LL, IT, 'T10-LL', addDays(TODAY, 60), 'available', null, null], [LZ, IT, 'T10-LZ', addDays(TODAY, 60), 'available', 50, 7500], [LN, IT, 'T10-LN', addDays(TODAY, 60), 'available', null, null],
  [LK, IT, 'T10-LK', addDays(TODAY, 60), 'available', null, null], [LK2, IT, 'T10-LK2', addDays(TODAY, 60), 'available', null, null],
  [FA, IF_, 'T10-FA', addDays(TODAY, 10), 'available', null, null], [FB, IF_, 'T10-FB', addDays(TODAY, 40), 'available', null, null], [FC, IF_, 'T10-FC', addDays(TODAY, 5), 'quarantined', null, null],
  [FD, IF_, 'T10-FD', addDays(TODAY, -3), 'available', null, null], [FE, IF_, 'T10-FE', addDays(TODAY, 20), 'blocked', null, null],
  [GA, IG, 'T10-GA', addDays(TODAY, 10), 'available', null, null], [GB, IG, 'T10-GB', addDays(TODAY, 40), 'available', null, null],
  [NA1, NA, 'T10-NA1', addDays(TODAY, 60), 'available', null, null], [NA2, NA, 'T10-NA2', addDays(TODAY, 60), 'available', null, null],
  [R1, IR1, 'T10-R1', addDays(TODAY, 60), 'available', null, null], [R2, IR2, 'T10-R2', addDays(TODAY, 60), 'available', null, null], [R5, IR5, 'T10-R5', addDays(TODAY, 60), 'available', null, null],
  [R3, IR3, 'T10-R3', addDays(TODAY, 60), 'available', null, null],
  [W1, IW, 'T10-W1', addDays(TODAY, -5), 'available', null, null], [W2, IW, 'T10-W2', addDays(TODAY, -1), 'available', null, null], [W3, IW, 'T10-W3', addDays(TODAY, 30), 'available', null, null],
  [W4, IW, 'T10-W4', addDays(TODAY, -2), 'available', null, null], [W5, IW, 'T10-W5', addDays(TODAY, -4), 'available', null, null],
  [D1, ID, 'T10-D1', addDays(TODAY, 60), 'available', null, null], [D2, ID, 'T10-D2', addDays(TODAY, -3), 'available', null, null], [D3, ID, 'T10-D3', addDays(TODAY, 60), 'quarantined', null, null],
  [LG2, GLU, 'T10-LG2', addDays(TODAY, 60), 'available', null, null],
];
// id, store, item, lot, qty, value
const balances: [string, string, string, string | null, number, number][] = [
  [uid(15501), S1, IT, LA, 100, 33325], [uid(15502), S1, IT, LB, 7, 100], [uid(15503), S1, IT, LX, 10, 100], [uid(15504), S1, IT, LT, 10, 100], [uid(15505), S1, IT, LQ, 10, 100],
  [uid(15506), S1, IT, LBK, 10, 100], [uid(15507), S1, IT, LL, 5, 500], [uid(15508), S1, IT, LZ, 0, 0], [uid(15509), MAIN, IT, LK, 20, 2000], [uid(15510), BENCH_ST, IT, LK2, 20, 2000],
  [uid(15511), S2, IT, LA, 50, 1000],
  [uid(15512), S1, IF_, FA, 10, 1000], [uid(15513), S1, IF_, FB, 20, 2000], [uid(15514), S1, IF_, FC, 50, 5000], [uid(15515), S1, IF_, FD, 50, 5000], [uid(15516), S1, IF_, FE, 50, 5000],
  [uid(15517), S1, IG, GA, 10, 1000], [uid(15518), S1, IG, GB, 10, 2000], [uid(15519), S1, IU, null, 25, 2500],
  [uid(15520), S1, NA, NA1, 10, 1500], [uid(15521), S1, NA, NA2, 30, 4500], [uid(15522), S1, NA, null, -4, -400], [uid(15523), S1, NB, null, -3, -100], [uid(15524), S1, NF, null, -4, -400],
  [uid(15525), S3, IR1, R1, 10, 1000], [uid(15526), S3, IR2, R2, 10, 1000], [uid(15527), S3, IR5, R5, 20, 2000], [uid(15528), S3, IR3, R3, 10, 1000],
  [uid(15529), S1, IW, W1, 10, 1000], [uid(15530), S1, IW, W2, 20, 333], [uid(15531), S1, IW, W3, 5, 500], [uid(15532), S1, IW, W4, 0, 0], [uid(15533), S2, IW, W5, 8, 800],
  [uid(15534), S1, ID, D1, 20, 4000], [uid(15535), S1, ID, D2, 10, 1000], [uid(15536), S1, ID, D3, 10, 1000], [uid(15537), S2, ID, D1, 10, 2000], [uid(15538), MAIN, GLU, LG2, 1000, 500000],
];
const q = (v: string | number | null) => (v === null ? 'NULL' : `'${v}'`);
const n = (v: number | null) => (v === null ? 'NULL' : String(v));
const EXTRAS = `
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT set_config('request.jwt.claims', '{"tenant_id":"${A}","sub":"${SYS}","actor_type":"system"}', true);
INSERT INTO inventory.g_cs_reasons (id, reason_group, code, display) VALUES
  ('${uid(15601)}', 'adjustment', 'stock_correction', 'Stock correction'), ('${uid(15602)}', 'supplier_return', 'damaged_on_arrival', 'Damaged on arrival'),
  ('${uid(15603)}', 'supplier_return', 'wrong_item', 'Wrong item') ON CONFLICT DO NOTHING;
INSERT INTO catalog.departments (id, tenant_id, code, name, created_by, updated_by) VALUES
  ('${DEPT}', '${A}', 'T10BIOCHEM', 'Biochemistry (T10)', '${SYS}', '${SYS}'), ('${DEPT_B}', '${B}', 'T10BIOCHEM', 'Biochemistry (T10 B)', '${SYS}', '${SYS}') ON CONFLICT DO NOTHING;
INSERT INTO inventory.stores (id, tenant_id, branch_id, store_code, name, store_kind, is_default_consumption, is_active, created_by, updated_by) VALUES
  ('${S1}', '${A}', '${BR1}', 'T10-S1', 'Store T10-S1', 'main', false, true, '${SYS}', '${SYS}'), ('${S2}', '${A}', '${BR2}', 'T10-S2', 'Store T10-S2', 'main', false, true, '${SYS}', '${SYS}'),
  ('${S3}', '${A}', '${BR1}', 'T10-S3', 'Store T10-S3', 'bench', false, true, '${SYS}', '${SYS}') ON CONFLICT DO NOTHING;
INSERT INTO inventory.items (id, tenant_id, item_code, name, category, base_uom_code, is_lot_tracked, requires_expiry, open_stability_days, created_by, updated_by) VALUES
${[[IT, 'T10-IT', true], [IF_, 'T10-IF', true], [IG, 'T10-IG', true], [IU, 'T10-IU', false], [NA, 'T10-NA', true], [NB, 'T10-NB', true], [NF, 'T10-NF', true], [IR1, 'T10-IR1', true], [IR2, 'T10-IR2', true],
  [IR5, 'T10-IR5', true], [IR3, 'T10-IR3', true], [IW, 'T10-IW', true], [ID, 'T10-ID', true]]
  .map(([id, code, lt]) => `  ('${id}', '${A}', '${code}', 'T10 ${code}', 'reagent', 'test', ${lt}, ${lt}, NULL, '${SYS}', '${SYS}')`).join(',\n')} ON CONFLICT DO NOTHING;
INSERT INTO inventory.lots (id, tenant_id, item_id, lot_no, expiry_on, status, status_reason_code, last_receipt_qty_base, last_receipt_value_paisa, created_by, updated_by) VALUES
${lots.map((l) => `  ('${l[0]}', '${A}', '${l[1]}', '${l[2]}', ${q(l[3])}, '${l[4]}', ${l[4] === 'available' ? 'NULL' : "'syn_quarantine'"}, ${n(l[5])}, ${n(l[6])}, '${SYS}', '${SYS}')`).join(',\n')} ON CONFLICT DO NOTHING;
INSERT INTO inventory.stock_balances (id, tenant_id, store_id, item_id, lot_id, qty_base, value_paisa, last_movement_at, created_by, updated_by) VALUES
${balances.map((b) => `  ('${b[0]}', '${A}', '${b[1]}', '${b[2]}', ${q(b[3])}, ${b[4]}, ${b[5]}, now(), '${SYS}', '${SYS}')`).join(',\n')} ON CONFLICT DO NOTHING;
INSERT INTO inventory.opened_containers (id, tenant_id, store_id, item_id, lot_id, instrument_id, opened_at, opened_by, open_expiry_at, status, finished_at, finished_by, discard_document_id, created_by, updated_by) VALUES
  ('${CG}', '${A}', '${S1}', '${IG}', '${GB}', NULL, now() - interval '1 day', '${SYS}', NULL, 'open', NULL, NULL, NULL, '${SYS}', '${SYS}'),
  ('${C1}', '${A}', '${S1}', '${ID}', '${D1}', NULL, now() - interval '1 day', '${SYS}', NULL, 'open', NULL, NULL, NULL, '${SYS}', '${SYS}'),
  ('${C2}', '${A}', '${S1}', '${ID}', '${D2}', NULL, now() - interval '5 days', '${SYS}', NULL, 'open', NULL, NULL, NULL, '${SYS}', '${SYS}'),
  ('${C3}', '${A}', '${S1}', '${ID}', '${D1}', NULL, now() - interval '9 days', '${SYS}', NULL, 'finished', now() - interval '3 days', '${SYS}', NULL, '${SYS}', '${SYS}'),
  ('${C4}', '${A}', '${S1}', '${ID}', '${D1}', NULL, now() - interval '8 days', '${SYS}', NULL, 'discarded', now() - interval '4 days', '${SYS}', '${DOC_WASTE_FX}', '${SYS}', '${SYS}'),
  ('${C5}', '${A}', '${S2}', '${ID}', '${D1}', NULL, now() - interval '1 day', '${SYS}', NULL, 'open', NULL, NULL, NULL, '${SYS}', '${SYS}'),
  ('${C6}', '${A}', '${S1}', '${IU}', NULL, NULL, now() - interval '1 day', '${SYS}', NULL, 'open', NULL, NULL, NULL, '${SYS}', '${SYS}'),
  ('${C7}', '${A}', '${S1}', '${ID}', '${D3}', NULL, now() - interval '1 day', '${SYS}', NULL, 'open', NULL, NULL, NULL, '${SYS}', '${SYS}'),
  ('${CR}', '${A}', '${S3}', '${IR3}', '${R3}', NULL, now() - interval '1 day', '${SYS}', NULL, 'open', NULL, NULL, NULL, '${SYS}', '${SYS}') ON CONFLICT DO NOTHING;
COMMIT;`;

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

describe('T-10 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

interface Sess {
  call(t: string, op: string, req?: Parameters<typeof call>[2], o?: LotOpts): Promise<{ status: number; body: any }>;
  sql(t: string, text: string, v?: unknown[]): Promise<any[]>;
  roleCalls: any[];
}
const claims = (t: string) => JSON.stringify({ tenant_id: t, sub: SYS, actor_type: 'system' });
type Client = pg.PoolClient;
function sessionOn(client: Client): Sess {
  let k = 0;
  const roleCalls: any[] = [];
  const tx = { query: (t: string, v?: unknown[]) => client.query(t, v) };
  return {
    roleCalls,
    async sql(t, text, v) { await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]); return (await client.query(text, v)).rows; },
    async call(t, op, req, o) {
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]);
      const st = makeDocCtx(tx, t, o ?? {});
      const sp = `t10_h${++k}`;
      await client.query(`SAVEPOINT ${sp}`);
      try { const r = await call(op, st.ctx, req); roleCalls.push(...st.roleCalls); await client.query(`RELEASE SAVEPOINT ${sp}`); return r; }
      catch (e) { roleCalls.push(...st.roleCalls); await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
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
const locked = (p: Promise<unknown>) => expectLims(p, 'inventory.store_locked_for_count', 409);
const issue = (s: Sess, body: Record<string, unknown>, o?: LotOpts) => s.call(A, 'createStockIssue', { body }, o);
const ret = (s: Sess, body: Record<string, unknown>, o?: LotOpts) => s.call(A, 'createStoreReturn', { body }, o);
const supRet = (s: Sess, body: Record<string, unknown>, o?: LotOpts) => s.call(A, 'createSupplierReturn', { body }, o);
const waste = (s: Sess, body: Record<string, unknown>, o?: LotOpts) => s.call(A, 'recordWastage', { body }, o);
const writeoff = (s: Sess, body: Record<string, unknown>, o?: LotOpts) => s.call(A, 'writeOffExpiredStock', { body }, o);
const adjust = (s: Sess, body: Record<string, unknown>, o?: LotOpts) => s.call(A, 'createStockAdjustment', { body }, o);
const discard = (s: Sess, id: string, version: number, body: Record<string, unknown>, o?: LotOpts, t = A) => s.call(t, 'discardContainer', { params: { container_id: id }, headers: ifm(version), body }, { permissions: [BENCH], ...o });

const bal = async (s: Sess, store: string, item: string, lot: string | null, t = A) => {
  const r = (await s.sql(t, 'SELECT qty_base::text AS q, value_paisa::text AS v FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id IS NOT DISTINCT FROM $4::uuid', [t, store, item, lot]))[0];
  return r ? { q: Number(r.q), v: Number(r.v) } : null;
};
const total = async (s: Sess, table: string, t = A) => Number((await s.sql(t, `SELECT count(*) AS n FROM inventory.${table} WHERE tenant_id = $1`, [t]))[0].n);
const snapshot = async (s: Sess, t = A) => JSON.stringify([await s.sql(t, 'SELECT id, qty_base::text, value_paisa::text, version FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [t]),
  await total(s, 'stock_movements', t), await total(s, 'stock_documents', t), await total(s, 'stock_document_lines', t)]);
/** Mutations that must leave no trace: run `p`, expect it to reject, and compare the whole ledger state of tenant A before / after. */
async function untouched(s: Sess, p: () => Promise<unknown>, check: (e: any) => Promise<unknown> | unknown): Promise<void> {
  const before = await snapshot(s);
  const e = await rej(p());
  await check(e);
  expect(await snapshot(s)).toBe(before);
}
const lockOn = (s: Sess) => s.sql(A, 'UPDATE inventory.settings SET count_locks_store = true WHERE tenant_id = $1', [A]);
const lotsOf = (d: any) => d.lines.map((l: any) => l.lot_id ?? null);
const mv = (d: any) => d.movements.map((m: any) => [m.movement_kind, qty(m.qty_base)]);

/** Wire + DB shape of a created document: contract keys only, no tenant / audit columns, line <-> movement 1:1 through doc_line_id, signs follow the direction. */
async function consistent(s: Sess, d: any, kind: string): Promise<void> {
  expect(d.doc_kind).toBe(kind);
  expect(d.doc_no).toMatch(DOC_NO);
  expect(onlyKeys(d, DOC_KEYS)).toEqual([]);
  expect(Object.keys(d).filter((k) => LEAK.test(k))).toEqual([]);
  for (const l of d.lines) { expect(onlyKeys(l, DOC_LINE_KEYS)).toEqual([]); expect(Object.keys(l).filter((k) => LEAK.test(k))).toEqual([]); }
  for (const m of d.movements) expect(onlyKeys(m, MOVEMENT_KEYS)).toEqual([]);
  expect(d.lines.map((l: any) => l.line_no)).toEqual(d.lines.map((_: unknown, i: number) => i + 1));
  expect(d.movements).toHaveLength(d.lines.length);
  const db = await s.sql(A, `SELECT m.movement_kind AS kind, m.item_id, m.lot_id, m.qty_base::text AS q, m.doc_type, m.doc_id, m.doc_line_id, l.id AS line_id, l.line_no, l.direction, l.qty_base::text AS lq, l.item_id AS litem, l.lot_id AS llot
    FROM inventory.stock_movements m JOIN inventory.stock_document_lines l ON l.tenant_id = m.tenant_id AND l.id = m.doc_line_id WHERE m.tenant_id = $1 AND m.doc_id = $2 ORDER BY l.line_no`, [A, d.id]);
  expect(db).toHaveLength(d.lines.length);
  db.forEach((r: any, i: number) => {
    expect(r.doc_type).toBe('stock_document');
    expect(r.line_id).toBe(d.lines[i].id);
    expect(r.item_id).toBe(r.litem);
    expect(r.lot_id).toBe(r.llot);
    expect(r.direction).toBe(d.lines[i].direction);
    expect(Number(r.q)).toBe(r.direction === 'in' ? Number(r.lq) : -Number(r.lq));
    expect(Number(r.lq)).toBe(qty(d.lines[i].qty_base));
  });
  const hdr = (await s.sql(A, 'SELECT doc_kind, doc_no, created_by FROM inventory.stock_documents WHERE tenant_id = $1 AND id = $2', [A, d.id]))[0];
  expect(hdr).toMatchObject({ doc_kind: kind, doc_no: d.doc_no, created_by: SYS });
}

// ======================================================================================================== #43 createStockIssue (AC-08.1, AC-08.2)
describe.skipIf(!live)('T-10 #43 createStockIssue: server-side FEFO split (AC-08.1, AC-08.2)', () => {
  run('AC-08.1 issue 15 of a lot-tracked item to a department without naming a lot: FEFO picks FA (10) then FB (5); one issue movement per lot; FC quarantined / FD expired / FE blocked untouched', async (s) => {
    const r = await issue(s, issueBody(S1, [dLine(IF_, '15')], { issued_to_kind: 'department', department_id: DEPT, reason_text: 'Morning run' }));
    expect(r.status).toBe(201);
    const d = r.body;
    await consistent(s, d, 'issue');
    expect(d).toMatchObject({ store_id: S1, issued_to_kind: 'department', department_id: DEPT, reason_text: 'Morning run' });
    expect(d.lines.map((l: any) => [l.item_id, l.lot_id, l.direction, qty(l.qty_base)])).toEqual([[IF_, FA, 'out', 10], [IF_, FB, 'out', 5]]);
    expect(d.movements.map((m: any) => [m.movement_kind, m.lot_id, qty(m.qty_base), m.doc_type, m.doc_id])).toEqual([['issue', FA, -10, 'stock_document', d.id], ['issue', FB, -5, 'stock_document', d.id]]);
    expect(await bal(s, S1, IF_, FA)).toEqual({ q: 0, v: 0 });
    expect(await bal(s, S1, IF_, FB)).toEqual({ q: 15, v: 1500 });
    for (const l of [FC, FD, FE]) expect(await bal(s, S1, IF_, l)).toEqual({ q: 50, v: 5000 });
  });
  run('the server re-runs FEFO: a client that names the LATER lot FB for 5 gets exactly FB (an explicit lot wins), a client that names no lot never decides the split', async (s) => {
    const named = await issue(s, issueBody(S1, [dLine(IF_, '5', FB)]));
    expect(lotsOf(named.body)).toEqual([FB]);
    expect(await bal(s, S1, IF_, FA)).toEqual({ q: 10, v: 1000 });
    const lotless = await issue(s, issueBody(S1, [dLine(IF_, '5')]));
    expect(lotsOf(lotless.body)).toEqual([FA]);
  });
  run('PE-3 money: without inventory.cost.read NO _paisa / value_basis field is on the document, its lines or its movements', async (s) => {
    const plain = await issue(s, issueBody(S1, [dLine(IF_, '15')]));
    expect([costKeys(plain.body), ...plain.body.lines.map(costKeys), ...plain.body.movements.map(costKeys)].flat()).toEqual([]);
  });
  run('money (with inventory.cost.read): FA -1000, FB -500 (5 of 20 u / 2000); line value = |movement value|', async (s) => {
    const r = await issue(s, issueBody(S1, [dLine(IF_, '15')]), WITH_COST);
    expect(r.body.movements.map((m: any) => m.value_paisa)).toEqual([-1000, -500]);
    expect(r.body.lines.map((l: any) => l.value_paisa)).toEqual([1000, 500]);
  });
  run('an open container makes its lot the FIRST candidate: GB (later expiry, open container) is issued before GA (earlier expiry)', async (s) => {
    const r = await issue(s, issueBody(S1, [dLine(IG, '5')]), WITH_COST);
    expect(lotsOf(r.body)).toEqual([GB]);
    expect(r.body.movements.map((m: any) => m.value_paisa)).toEqual([-1000]);
    expect(await bal(s, S1, IG, GA)).toEqual({ q: 10, v: 1000 });
  });
  run('AC-08.2 exactly the available non-expired stock (30) can be issued; 31 => 409 inventory.insufficient_stock although FC / FD / FE hold 150 more; nothing written', async (s) => {
    await untouched(s, () => issue(s, issueBody(S1, [dLine(IF_, '31')])), (e) => expect(e.code).toBe('inventory.insufficient_stock'));
    await untouched(s, () => issue(s, issueBody(S1, [dLine(IF_, '35')])), (e) => expect(e.statusCode).toBe(409));
    const ok = await issue(s, issueBody(S1, [dLine(IF_, '30')]));
    expect(ok.body.lines.map((l: any) => [l.lot_id, qty(l.qty_base)])).toEqual([[FA, 10], [FB, 20]]);
  });
  run('an explicit lot is used as named: golden half-up 98 of LA (100 u / 33325) => -32659 (not -32658), the lot row keeps 2 u / 666', async (s) => {
    const r = await issue(s, issueBody(S1, [dLine(IT, '98', LA)]), WITH_COST);
    expect(r.body.lines).toHaveLength(1);
    expect(r.body.lines[0]).toMatchObject({ item_id: IT, lot_id: LA, direction: 'out', value_paisa: 32659 });
    expect(qty(r.body.lines[0].qty_base)).toBe(98);
    expect(await bal(s, S1, IT, LA)).toEqual({ q: 2, v: 666 });
  });
  run('explicit lot errors: expired => 409 lot_expired; expires TODAY => usable; quarantined / blocked => 409 lot_unavailable; more than the lot row holds => 409 insufficient_stock; nothing written', async (s) => {
    await untouched(s, () => issue(s, issueBody(S1, [dLine(IT, '1', LX)])), (e) => { expect(e.code).toBe('inventory.lot_expired'); expect(e.statusCode).toBe(409); });
    for (const l of [LQ, LBK]) await untouched(s, () => issue(s, issueBody(S1, [dLine(IT, '1', l)])), (e) => { expect(e.code).toBe('inventory.lot_unavailable'); expect(e.statusCode).toBe(409); });
    await untouched(s, () => issue(s, issueBody(S1, [dLine(IT, '6', LL)])), (e) => expect(e.code).toBe('inventory.insufficient_stock'));
    expect(lotsOf((await issue(s, issueBody(S1, [dLine(IT, '1', LT)]))).body)).toEqual([LT]);
  });
  run('item inactive => 409 inventory.item_inactive', async (s) => {
    await untouched(s, () => issue(s, issueBody(MAIN, [dLine(OLD_IT, '1')])), (e) => { expect(e.code).toBe('inventory.item_inactive'); expect(e.statusCode).toBe(409); });
  });
  run('packs: 0.5 BOX (400) of a GLU lot => 200 base, value 100000 (500 a unit); 2 KIT (100) => 200 base; a pack of ANOTHER item => 422 inventory.uom_mismatch, nothing written', async (s) => {
    const r = await issue(s, issueBody(MAIN, [dLine(GLU, '0.5', LG2, { pack_id: BOX })]), WITH_COST);
    expect(qty(r.body.lines[0].qty_base)).toBe(200);
    expect(r.body.lines[0].value_paisa).toBe(100000);
    expect(await bal(s, MAIN, GLU, LG2)).toEqual({ q: 800, v: 400000 });
    const k = await issue(s, issueBody(MAIN, [dLine(GLU, '2', LG2, { pack_id: KIT })]));
    expect(qty(k.body.lines[0].qty_base)).toBe(200);
    await untouched(s, () => issue(s, issueBody(S1, [dLine(IT, '1', LA, { pack_id: BOX })])), (e) => { expect(e.code).toBe('inventory.uom_mismatch'); expect(e.statusCode).toBe(422); });
  });
  run('a non-lot-tracked item is issued from its unlotted row at the average cost: 10 of IU (25 u / 2500) => value -1000, no lot_id on the line or the movement; 26 => 409 insufficient_stock', async (s) => {
    const r = await issue(s, issueBody(S1, [dLine(IU, '10')]), WITH_COST);
    await consistent(s, r.body, 'issue');
    expect(r.body.lines[0].lot_id).toBeUndefined();
    expect(r.body.movements[0].lot_id ?? null).toBeNull();
    expect(r.body.movements[0].value_paisa).toBe(-1000);
    expect(await bal(s, S1, IU, null)).toEqual({ q: 15, v: 1500 });
    await untouched(s, () => issue(s, issueBody(S1, [dLine(IU, '26')])), (e) => expect(e.code).toBe('inventory.insufficient_stock'));
  });
  run('several lines: line_no 1..n in request order, one document, movements 1:1; the SAME lot twice is checked in total (3 + 3 of LL with 5 on hand => 409)', async (s) => {
    const r = await issue(s, issueBody(S1, [dLine(IT, '3', LB), dLine(IU, '5')]));
    await consistent(s, r.body, 'issue');
    expect(r.body.lines.map((l: any) => l.item_id)).toEqual([IT, IU]);
    await untouched(s, () => issue(s, issueBody(S1, [dLine(IT, '3', LL), dLine(IT, '3', LL)])), (e) => expect(e.code).toBe('inventory.insufficient_stock'));
  });
  run('targets: instrument 421 is stored and returned; a department / instrument of tenant B, or an unknown one, is refused (not created)', async (s) => {
    const r = await issue(s, issueBody(S1, [dLine(IT, '1', LB)], { issued_to_kind: 'instrument', instrument_id: IN_A }));
    expect(r.body).toMatchObject({ issued_to_kind: 'instrument', instrument_id: IN_A });
    await untouched(s, () => issue(s, issueBody(S1, [dLine(IT, '1', LB)], { issued_to_kind: 'instrument', instrument_id: IN_B })), (e) => expect([400, 404, 422]).toContain(e.statusCode));
    await untouched(s, () => issue(s, issueBody(S1, [dLine(IT, '1', LB)], { issued_to_kind: 'department', department_id: DEPT_B })), (e) => expect([400, 404, 422]).toContain(e.statusCode));
    await untouched(s, () => issue(s, issueBody(S1, [dLine(IT, '1', LB)], { issued_to_kind: 'department', department_id: uid(15999) })), (e) => expect([400, 404, 422]).toContain(e.statusCode));
  });
  run('occurred_at defaults to now; a given instant is echoed; business_date is the TENANT-time (Asia/Kathmandu) date of occurred_at, not the UTC date', async (s) => {
    const now = Date.now();
    const def = await issue(s, issueBody(S1, [dLine(IT, '1', LB)]));
    expect(Math.abs(Date.parse(def.body.occurred_at) - now)).toBeLessThan(120_000);
    expect(def.body.business_date).toBe(ymdIn(KT, new Date(Date.parse(def.body.occurred_at))));
    let t = Date.parse(`${TODAY}T00:10:00+05:45`); // 18:25 UTC of the previous day: UTC date != tenant date
    if (t > now - 60_000) t = Date.parse(`${addDays(TODAY, -1)}T00:10:00+05:45`);
    const iso = new Date(t).toISOString();
    const r = await issue(s, issueBody(S1, [dLine(IT, '1', LB)], { occurred_at: iso }));
    expect(Date.parse(r.body.occurred_at)).toBe(t);
    expect(r.body.business_date).toBe(ymdIn(KT, new Date(t)));
    expect(r.body.business_date).not.toBe(iso.slice(0, 10));
    const m = await s.sql(A, 'SELECT business_date::text AS d FROM inventory.stock_movements WHERE tenant_id = $1 AND doc_id = $2', [A, r.body.id]);
    expect(m.map((x: any) => x.d)).toEqual([r.body.business_date]);
  });
  run('doc_no follows SD{yy}{seq:6} and is unique per document (two documents, two numbers)', async (s) => {
    const a = await issue(s, issueBody(S1, [dLine(IT, '1', LB)])); const b = await issue(s, issueBody(S1, [dLine(IT, '1', LB)]));
    expect(a.body.doc_no).toMatch(DOC_NO); expect(b.body.doc_no).toMatch(DOC_NO);
    expect(a.body.doc_no).not.toBe(b.body.doc_no);
  });
  run('probe: reason_text with SQL / markup is stored verbatim and the ledger tables survive', async (s) => {
    const evil = "o'neil'; DROP TABLE inventory.stock_documents; --<script>1</script>";
    const r = await issue(s, issueBody(S1, [dLine(IT, '1', LB)], { reason_text: evil }));
    expect(r.body.reason_text).toBe(evil);
    expect((await s.sql(A, 'SELECT reason_text FROM inventory.stock_documents WHERE id = $1', [r.body.id]))[0].reason_text).toBe(evil);
  });
});

describe.skipIf(!live)('T-10 #43 count lock (store_locked_for_count) and scope', () => {
  run('count_locks_store ON + an open count for the store (fixture count 8901 / MAIN) => 409 store_locked_for_count on #43, #44 and #48 (in and out), nothing written', async (s) => {
    await lockOn(s);
    await untouched(s, () => issue(s, issueBody(MAIN, [dLine(IT, '1', LK)])), (e) => { expect(e.code).toBe('inventory.store_locked_for_count'); expect(e.statusCode).toBe(409); });
    await untouched(s, () => ret(s, returnBody(MAIN, [dLine(IT, '1', LK)])), (e) => expect(e.code).toBe('inventory.store_locked_for_count'));
    await untouched(s, () => adjust(s, adjustBody(MAIN, [aLine(IT, 'in', '1', LK)])), (e) => expect(e.code).toBe('inventory.store_locked_for_count'));
    await untouched(s, () => adjust(s, adjustBody(MAIN, [aLine(IT, 'out', '1', LK)])), (e) => expect(e.code).toBe('inventory.store_locked_for_count'));
  });
  run('the lock is per store: with the setting ON, BENCH-A (no open count) still works; with the setting OFF (default), MAIN works despite its open count', async (s) => {
    expect((await issue(s, issueBody(MAIN, [dLine(IT, '1', LK)]))).status).toBe(201);
    await lockOn(s);
    expect((await issue(s, issueBody(BENCH_ST, [dLine(IT, '1', LK2)]))).status).toBe(201);
  });
  run('the lock is judged BEFORE the lines: a locked store with an unknown item still answers 409 store_locked_for_count', async (s) => {
    await lockOn(s);
    await locked(issue(s, issueBody(MAIN, [dLine(uid(15998), '1')])));
  });
  const ON = (st: string): Record<string, Record<string, unknown>> => ({
    createStockIssue: issueBody(st, [dLine(IT, '1', LA)]), createStoreReturn: returnBody(st, [dLine(IT, '1', LA)]), createSupplierReturn: supplierReturnBody(st, SUP, [dLine(IT, '1', LA)]),
    recordWastage: wastageBody(st, [dLine(IT, '1', LA)]), writeOffExpiredStock: writeoffBody(st, [LX]), createStockAdjustment: adjustBody(st, [aLine(IT, 'in', '1', LA)]),
  });
  const OPS = Object.keys(ON(S1));
  for (const op of OPS) {
    run(`${op}: a user scoped to BR2 on a BR1 store, a user with no branch, an unknown store and a tenant-B store all get 404 (P-B2), even without the permission (P-B8); no assertRole before the row; nothing written`, async (s) => {
      for (const [o, st] of [[BR2_ONLY, S1], [NOBODY, S1], [BR1_ONLY, uid(15998)], [BR1_ONLY, MAIN_B], [{ ...BR2_ONLY, permissions: [READ] }, S1]] as [LotOpts, string][]) {
        s.roleCalls.length = 0;
        await untouched(s, () => s.call(A, op, { body: ON(st)[op] }, o), (e) => { expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404); });
        expect(s.roleCalls.filter((r) => r.branchId !== undefined)).toEqual([]);
      }
    });
    run(`${op}: a visible store but a missing permission => 403 auth.forbidden, the permission is asserted WITH the store's branch (${PERMISSION[op]} @ BR1); tenant B cannot reach a tenant A store (404)`, async (s) => {
      s.roleCalls.length = 0;
      await untouched(s, () => s.call(A, op, { body: ON(S1)[op] }, { permissions: [READ] }), (e) => { expect(e.code).toBe('auth.forbidden'); expect(e.statusCode).toBe(403); });
      expect(s.roleCalls).toContainEqual({ permission: PERMISSION[op], branchId: BR1 });
      await untouched(s, () => s.call(B, op, { body: ON(S1)[op] }), (e) => expect(e.code).toBe('common.not_found'));
    });
  }
  run('PE-2 a technologist (item.read + bench.record) cannot call any stock.manage / stock.adjust document operation', async (s) => {
    for (const op of OPS) await untouched(s, () => s.call(A, op, { body: ON(S1)[op] }, TECH), (e) => { expect(e.code).toBe('auth.forbidden'); expect(e.statusCode).toBe(403); });
  });
});

describe.skipIf(!live)('T-10 #43 races (committed): the last stock is issued once', () => {
  it('2 parallel issues of the last 10 u of an explicit lot => exactly one 201, the other 409 insufficient_stock; balance 0; one document', async () => {
    const rs = await Promise.allSettled([1, 2].map(() => committed((s) => issue(s, issueBody(S3, [dLine(IR1, '10', R1)])))));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const bad = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(bad.reason).toMatchObject({ code: 'inventory.insufficient_stock', statusCode: 409 });
    await session(async (s) => {
      expect(await bal(s, S3, IR1, R1)).toEqual({ q: 0, v: 0 });
      expect(Number((await s.sql(A, `SELECT count(*) AS n FROM inventory.stock_movements WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND movement_kind = 'issue'`, [A, S3, IR1]))[0].n)).toBe(1);
    });
  });
  it('2 parallel LOTLESS issues of the last 10 u (FEFO) => one 201, one 409 insufficient_stock', async () => {
    const rs = await Promise.allSettled([1, 2].map(() => committed((s) => issue(s, issueBody(S3, [dLine(IR2, '10')])))));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((rs.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'inventory.insufficient_stock' });
  });
  it('8 parallel issues of 3 u from 20 u => exactly 6 succeed, 2 are insufficient_stock (no deadlock, no other error), the balance is exactly 2 u / 200 paisa', async () => {
    const rs = await Promise.allSettled(Array.from({ length: 8 }, () => committed((s) => issue(s, issueBody(S3, [dLine(IR5, '3', R5)])))));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    for (const r of rs.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'inventory.insufficient_stock' });
    await session(async (s) => { expect(await bal(s, S3, IR5, R5)).toEqual({ q: 2, v: 200 }); });
  });
});

// ======================================================================================================== #44 createStoreReturn (AC-08.3) and D-75
describe.skipIf(!live)('T-10 #44 createStoreReturn (AC-08.3)', () => {
  run('AC-08.3 return 2 of the named lot LA => a return_to_store movement of +2 valued at the lot-store average: round_half_up(2 x 33325 / 100) = 667 (tie 666.5; banker would give 666)', async (s) => {
    const r = await ret(s, returnBody(S1, [dLine(IT, '2', LA)], { reason_text: 'Unused' }), WITH_COST);
    expect(r.status).toBe(201);
    await consistent(s, r.body, 'return_to_store');
    expect(r.body.reason_code).toBeUndefined(); // a store return carries no reason code
    expect(r.body.lines[0]).toMatchObject({ item_id: IT, lot_id: LA, direction: 'in', value_paisa: 667 });
    expect(r.body.movements.map((m: any) => [m.movement_kind, m.lot_id, qty(m.qty_base), m.value_paisa, m.value_basis])).toEqual([['return_to_store', LA, 2, 667, 'average']]);
    expect(await bal(s, S1, IT, LA)).toEqual({ q: 102, v: 33992 });
  });
  run('a lot row at Q = 0 is valued from the lot\'s last receipt (7500 / 50 x 10 = 1500, basis last_receipt); a lot with no receipt data and no row is valued 0 with basis none', async (s) => {
    const a = await ret(s, returnBody(S1, [dLine(IT, '10', LZ)]), WITH_COST);
    expect(a.body.movements[0]).toMatchObject({ value_paisa: 1500, value_basis: 'last_receipt' });
    const b = await ret(s, returnBody(S1, [dLine(IT, '3', LN)]), WITH_COST);
    expect(b.body.movements[0]).toMatchObject({ value_paisa: 0, value_basis: 'none' });
  });
  run('a not-lot-tracked item returns into its unlotted row at the row average: 5 of IU (25 u / 2500) => +500; row 30 u / 3000', async (s) => {
    const r = await ret(s, returnBody(S1, [dLine(IU, '5')]), WITH_COST);
    expect(r.body.movements[0].value_paisa).toBe(500);
    expect(await bal(s, S1, IU, null)).toEqual({ q: 30, v: 3000 });
  });
  run('packs: 1 KIT (100 base) of a GLU lot => +100; a pack of another item => 422 uom_mismatch', async (s) => {
    const r = await ret(s, returnBody(MAIN, [dLine(GLU, '1', LG2, { pack_id: KIT })]));
    expect(qty(r.body.lines[0].qty_base)).toBe(100);
    await untouched(s, () => ret(s, returnBody(S1, [dLine(IT, '1', LA, { pack_id: BOX })])), (e) => expect(e.code).toBe('inventory.uom_mismatch'));
  });
  run('a return to an expired lot => 409 lot_expired, to a quarantined lot => 409 lot_unavailable, of an inactive item => 409 item_inactive (as #43 minus insufficient_stock)', async (s) => {
    await untouched(s, () => ret(s, returnBody(S1, [dLine(IT, '1', LX)])), (e) => expect(e.code).toBe('inventory.lot_expired'));
    await untouched(s, () => ret(s, returnBody(S1, [dLine(IT, '1', LQ)])), (e) => expect(e.code).toBe('inventory.lot_unavailable'));
    await untouched(s, () => ret(s, returnBody(MAIN, [dLine(OLD_IT, '1')])), (e) => expect(e.code).toBe('inventory.item_inactive'));
  });
  run('a return needs no reason (reason_code is not part of the document) and never refuses for stock: 1000 u into a lot holding 100 is fine', async (s) => {
    expect((await ret(s, returnBody(S1, [dLine(IT, '1000', LA)]))).status).toBe(201);
  });
});

describe.skipIf(!live)('T-10 D-75 goldens: inbound into a NEGATIVE unlotted row (08 A17 D-75; #44 return_to_store and #48 adjust_in)', () => {
  // item, q, expected movement value, row after [q, v]
  const golden: [string, string, string, number, number, number][] = [
    ['branch q >= -Q: NA row -4 / -400, +10: first 4 units take +400 (clear -V), the remaining 6 are valued at the store average 150 => 400 + 900 = 1300', NA, '10', 1300, 6, 900],
    ['boundary q = -Q: NA row -4 / -400, +4 => 400, the row ends at exactly 0 / 0', NA, '4', 400, 0, 0],
    ['branch q < -Q: NB row -3 / -100, +2 => round_half_up(2 x -100 / -3) = 67 (66.67); the row ends -1 / -33', NB, '2', 67, -1, -33],
    ['branch q < -Q, rounding down: NB row -3 / -100, +1 => round_half_up(33.33) = 33; the row ends -2 / -67', NB, '1', 33, -2, -67],
    ['q >= -Q with no cost information (NF -4 / -400, +10): 400 for the cleared part, the remaining 6 valued 0 => 400; the row ends 6 / 0', NF, '10', 400, 6, 0],
  ];
  for (const [kind, body] of [['#44', (item: string, qn: string) => ({ op: 'createStoreReturn', body: returnBody(S1, [dLine(item, qn)]) })], ['#48', (item: string, qn: string) => ({ op: 'createStockAdjustment', body: adjustBody(S1, [aLine(item, 'in', qn)]) })]] as const) {
    for (const [name, item, qn, value, rq, rv] of golden) {
      run(`${kind} ${name}`, async (s) => {
        const { op, body: b } = body(item, qn);
        const r = await s.call(A, op, { body: b }, WITH_COST);
        expect(r.status).toBe(201);
        await consistent(s, r.body, KIND_OF[op] as string);
        expect(r.body.movements).toHaveLength(1);
        expect(r.body.movements[0]).toMatchObject({ qty_base: expect.any(String), value_paisa: value });
        expect(qty(r.body.movements[0].qty_base)).toBe(Number(qn));
        expect(r.body.movements[0].lot_id ?? null).toBeNull();
        expect(await bal(s, S1, item, null)).toEqual({ q: rq, v: rv });
      });
    }
  }
});

// ======================================================================================================== #45 createSupplierReturn (AC-09.1)
describe.skipIf(!live)('T-10 #45 createSupplierReturn (AC-09.1)', () => {
  run('AC-09.1 return 1 BOX (400 test) of a posted GRN lot with reason damaged_on_arrival => a supplier_return movement of -400, the GRN link recorded; value -200000 (500 a unit)', async (s) => {
    const r = await supRet(s, supplierReturnBody(MAIN, SUP, [dLine(GLU, '1', LG2, { pack_id: BOX })], { grn_id: GRN_P, reason_text: 'Cracked boxes' }), WITH_COST);
    expect(r.status).toBe(201);
    const d = r.body;
    await consistent(s, d, 'supplier_return');
    expect(d).toMatchObject({ store_id: MAIN, supplier_id: SUP, grn_id: GRN_P, reason_code: 'damaged_on_arrival', reason_text: 'Cracked boxes' });
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toMatchObject({ item_id: GLU, lot_id: LG2, direction: 'out', value_paisa: 200000 });
    expect(qty(d.lines[0].qty_base)).toBe(400);
    expect(d.movements.map((m: any) => [m.movement_kind, qty(m.qty_base), m.value_paisa])).toEqual([['supplier_return', -400, -200000]]);
    expect(await bal(s, MAIN, GLU, LG2)).toEqual({ q: 600, v: 300000 });
    const db = (await s.sql(A, 'SELECT supplier_id, grn_id, reason_code, doc_kind FROM inventory.stock_documents WHERE id = $1', [d.id]))[0];
    expect(db).toEqual({ supplier_id: SUP, grn_id: GRN_P, reason_code: 'damaged_on_arrival', doc_kind: 'supplier_return' });
  });
  run('grn_id is optional: without it the document has no grn_id', async (s) => {
    const r = await supRet(s, supplierReturnBody(MAIN, SUP, [dLine(GLU, '10', LG2)], { reason_code: 'wrong_item' }));
    expect(r.body.grn_id).toBeUndefined();
    expect(r.body.reason_code).toBe('wrong_item');
  });
  run('reason: omitted => 422 inventory.reason_required; an unknown code, a code of another group (spillage = wastage) and an inactive / other-tenant code => 422; nothing written', async (s) => {
    const { reason_code: _r, ...noReason } = supplierReturnBody(MAIN, SUP, [dLine(GLU, '1', LG2)]);
    await untouched(s, () => supRet(s, noReason), (e) => { expect(e.code).toBe('inventory.reason_required'); expect(e.statusCode).toBe(422); });
    for (const code of ['no_such_code', 'spillage', 'count_variance']) await untouched(s, () => supRet(s, supplierReturnBody(MAIN, SUP, [dLine(GLU, '1', LG2)], { reason_code: code })), (e) => expect(e.code).toBe('inventory.reason_required'));
  });
  run('more than the lot row holds => 409 insufficient_stock (1001 of 1000); the same lot twice is checked in total (600 + 600)', async (s) => {
    await untouched(s, () => supRet(s, supplierReturnBody(MAIN, SUP, [dLine(GLU, '1001', LG2)])), (e) => expect(e.code).toBe('inventory.insufficient_stock'));
    await untouched(s, () => supRet(s, supplierReturnBody(MAIN, SUP, [dLine(GLU, '600', LG2), dLine(GLU, '600', LG2)])), (e) => expect(e.code).toBe('inventory.insufficient_stock'));
  });
  run('probe: a supplier / GRN of tenant B, or unknown ones, are refused and nothing is written', async (s) => {
    await untouched(s, () => supRet(s, supplierReturnBody(MAIN, SUP_B, [dLine(GLU, '1', LG2)])), (e) => expect([400, 404, 422]).toContain(e.statusCode));
    await untouched(s, () => supRet(s, supplierReturnBody(MAIN, SUP, [dLine(GLU, '1', LG2)], { grn_id: GRN_B })), (e) => expect([400, 404, 422]).toContain(e.statusCode));
    await untouched(s, () => supRet(s, supplierReturnBody(MAIN, uid(15999), [dLine(GLU, '1', LG2)])), (e) => expect([400, 404, 422]).toContain(e.statusCode));
    await untouched(s, () => supRet(s, supplierReturnBody(MAIN, SUP, [dLine(GLU, '1', LOT_B)])), (e) => expect([400, 404, 422]).toContain(e.statusCode));
  });
});

// ======================================================================================================== #46 recordWastage (AC-11.1)
describe.skipIf(!live)('T-10 #46 recordWastage (AC-11.1)', () => {
  run('AC-11.1 without a reason code => 422 inventory.reason_required (CR-C12-003), nothing written; with spillage a wastage movement is written and the wastage listing (#35) shows it', async (s) => {
    const { reason_code: _r, ...noReason } = wastageBody(S1, [dLine(IT, '1', LA)]);
    await untouched(s, () => waste(s, noReason), (e) => { expect(e.code).toBe('inventory.reason_required'); expect(e.statusCode).toBe(422); });
    const r = await waste(s, wastageBody(S1, [dLine(IT, '4', LA)], { reason_text: 'Dropped tray' }), WITH_COST);
    expect(r.status).toBe(201);
    await consistent(s, r.body, 'wastage');
    expect(r.body).toMatchObject({ store_id: S1, reason_code: 'spillage', reason_text: 'Dropped tray' });
    expect(r.body.movements.map((m: any) => [m.movement_kind, qty(m.qty_base), m.value_paisa, m.reason_code])).toEqual([['wastage', -4, -1333, 'spillage']]); // round_half_up(4 x 33325 / 100) = 1333
    const list = await s.call(A, 'listStockMovements', { query: { store_id: S1, movement_kind: 'wastage', doc_id: r.body.id } }, { permissions: [READ] });
    expect(list.body.data.map((m: any) => [m.movement_kind, m.doc_id])).toEqual([['wastage', r.body.id]]);
  });
  run('reasons: unknown / inactive tenant code (old_one) / other group (count_variance) / a wrong per-line reason => 422; a tenant code (lab_custom) and a global one (damaged) are valid; nothing written on refusal', async (s) => {
    for (const code of ['no_such_code', 'old_one', 'count_variance', 'stock_correction']) await untouched(s, () => waste(s, wastageBody(S1, [dLine(IT, '1', LA)], { reason_code: code })), (e) => expect(e.code).toBe('inventory.reason_required'));
    await untouched(s, () => waste(s, wastageBody(S1, [dLine(IT, '1', LA, { reason_code: 'count_variance' })])), (e) => expect(e.code).toBe('inventory.reason_required'));
    expect((await waste(s, wastageBody(S1, [dLine(IT, '1', LA)], { reason_code: 'lab_custom' }))).body.reason_code).toBe('lab_custom');
    expect((await waste(s, wastageBody(S1, [dLine(IT, '1', LA)], { reason_code: 'damaged' }))).status).toBe(201);
  });
  run('the per-line reason_code wins on its movement; the header reason is the default for lines without one', async (s) => {
    const r = await waste(s, wastageBody(S1, [dLine(IT, '1', LA, { reason_code: 'damaged' }), dLine(IT, '1', LB)]));
    expect(r.body.lines.map((l: any) => l.reason_code ?? null)).toEqual(['damaged', null]);
    expect(r.body.movements.map((m: any) => m.reason_code)).toEqual(['damaged', 'spillage']);
  });
  run('wastage without a lot uses the FEFO candidates (FA 10 then FB 5); with an explicit lot it is ALLOWED from an expired (LX), a quarantined (LQ) and a blocked (LBK) lot', async (s) => {
    const f = await waste(s, wastageBody(S1, [dLine(IF_, '15')]));
    expect(f.body.lines.map((l: any) => [l.lot_id, qty(l.qty_base)])).toEqual([[FA, 10], [FB, 5]]);
    for (const l of [LX, LQ, LBK]) expect(lotsOf((await waste(s, wastageBody(S1, [dLine(IT, '1', l)]))).body)).toEqual([l]);
  });
  run('lotless wastage never takes from FC / FD / FE: 31 of IF => 409 insufficient_stock', async (s) => {
    await untouched(s, () => waste(s, wastageBody(S1, [dLine(IF_, '31')])), (e) => expect(e.code).toBe('inventory.insufficient_stock'));
  });
  run('more than the lot holds => 409 insufficient_stock; a not-lot-tracked item is written off from its unlotted row at the average (4 of IU => -400); a pack of another item => 422 uom_mismatch', async (s) => {
    await untouched(s, () => waste(s, wastageBody(S1, [dLine(IT, '6', LL)])), (e) => expect(e.code).toBe('inventory.insufficient_stock'));
    const r = await waste(s, wastageBody(S1, [dLine(IU, '4')]), WITH_COST);
    expect(r.body.movements[0].value_paisa).toBe(-400);
    await untouched(s, () => waste(s, wastageBody(S1, [dLine(IT, '1', LA, { pack_id: BOX })])), (e) => expect(e.code).toBe('inventory.uom_mismatch'));
  });
  run('occurred_at window [now - backdate_max_days, now + 300 s] (02-TRD §4.7): outside either bound => 400 /occurred_at, nothing written; inside => 201', async (s) => {
    const days = Number((await s.sql(A, 'SELECT backdate_max_days AS d FROM inventory.settings WHERE tenant_id = $1', [A]))[0]?.d ?? 7);
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    const D = 86_400_000;
    const bad = (iso: string) => untouched(s, () => waste(s, wastageBody(S1, [dLine(IT, '1', LA)], { occurred_at: iso })), (e) => {
      expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
      expect((e.errors ?? []).map((f: any) => f.path)).toContain('/occurred_at');
    });
    await bad(at(-(days + 1) * D));
    await bad(at(400_000));
    expect((await waste(s, wastageBody(S1, [dLine(IT, '1', LA)], { occurred_at: at(-(days - 1) * D) }))).status).toBe(201);
    expect((await waste(s, wastageBody(S1, [dLine(IT, '1', LA)], { occurred_at: at(60_000) }))).status).toBe(201);
  });
  run('probe: a lot of tenant B / another item / unknown is refused (not created)', async (s) => {
    await untouched(s, () => waste(s, wastageBody(S1, [dLine(IT, '1', LOT_B)])), (e) => expect([400, 404, 422]).toContain(e.statusCode));
    await untouched(s, () => waste(s, wastageBody(S1, [dLine(IF_, '1', LA)])), (e) => expect([400, 404, 422]).toContain(e.statusCode));
    await untouched(s, () => waste(s, wastageBody(S1, [dLine(GLU_B, '1')])), (e) => expect([400, 404, 422]).toContain(e.statusCode));
  });
});

// ======================================================================================================== #47 writeOffExpiredStock (AC-11.2)
describe.skipIf(!live)('T-10 #47 writeOffExpiredStock (AC-11.2)', () => {
  run('AC-11.2 two expired lots with stock => ONE expiry_writeoff per (lot, store) clearing the full quantity and value (W1 10 u / 1000, W2 20 u / 333); both rows end 0 / 0', async (s) => {
    const r = await writeoff(s, writeoffBody(S1, [W1, W2]), WITH_COST);
    expect(r.status).toBe(201);
    await consistent(s, r.body, 'expiry_writeoff');
    expect(r.body.store_id).toBe(S1);
    expect(r.body.lines.map((l: any) => [l.lot_id, l.direction, qty(l.qty_base), l.value_paisa])).toEqual([[W1, 'out', 10, 1000], [W2, 'out', 20, 333]]);
    expect(r.body.movements.map((m: any) => [m.movement_kind, m.lot_id, qty(m.qty_base), m.value_paisa])).toEqual([['expiry_writeoff', W1, -10, -1000], ['expiry_writeoff', W2, -20, -333]]);
    expect(await bal(s, S1, IW, W1)).toEqual({ q: 0, v: 0 });
    expect(await bal(s, S1, IW, W2)).toEqual({ q: 0, v: 0 });
    expect(await bal(s, S1, IW, W3)).toEqual({ q: 5, v: 500 });
    expect(await bal(s, S2, IW, W5)).toEqual({ q: 8, v: 800 });
  });
  run('a NON-expired lot in the request => 400 common.validation_failed with the per-line path /lot_ids/1, and NOTHING is written (W1 stays); the expiry day itself (LT, today) is not expired', async (s) => {
    await untouched(s, () => writeoff(s, writeoffBody(S1, [W1, W3])), (e) => { expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); expect(JSON.stringify(e.errors ?? e.detail ?? '')).toContain('/lot_ids/1'); });
    await untouched(s, () => writeoff(s, writeoffBody(S1, [LT])), (e) => { expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? e.detail ?? '')).toContain('/lot_ids/0'); });
    expect(await bal(s, S1, IW, W1)).toEqual({ q: 10, v: 1000 });
  });
  run('an expired lot with NO stock in the store (W4 at 0, W5 only in S2, unknown id) => per-line 400 (unknown may be 404), nothing written', async (s) => {
    await untouched(s, () => writeoff(s, writeoffBody(S1, [W4])), (e) => { expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? e.detail ?? '')).toContain('/lot_ids/0'); });
    await untouched(s, () => writeoff(s, writeoffBody(S1, [W1, W5])), (e) => { expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? e.detail ?? '')).toContain('/lot_ids/1'); });
    await untouched(s, () => writeoff(s, writeoffBody(S1, [W1, uid(15999)])), (e) => expect([400, 404]).toContain(e.statusCode));
  });
  run('A11 mixed-tenant ids: a lot id of tenant B is refused per line (400 / 404), nothing is written for A or B, and the tenant B balance is untouched', async (s) => {
    const beforeB = await snapshot(s, B);
    await untouched(s, () => writeoff(s, writeoffBody(S1, [W1, LOT_B])), (e) => expect([400, 404]).toContain(e.statusCode));
    expect(await snapshot(s, B)).toBe(beforeB);
  });
  run('replay: a second write-off of the same lots finds no stock => per-line 400 and no second movement (never a double write)', async (s) => {
    await writeoff(s, writeoffBody(S1, [W1]));
    await untouched(s, () => writeoff(s, writeoffBody(S1, [W1])), (e) => expect(e.code).toBe('common.validation_failed'));
    expect(Number((await s.sql(A, `SELECT count(*) AS n FROM inventory.stock_movements WHERE tenant_id = $1 AND lot_id = $2 AND movement_kind = 'expiry_writeoff'`, [A, W1]))[0].n)).toBe(1);
  });
  run('the other branch: W5 in S2 is written off by a BR2 user (the requested store decides), a BR1-only user gets 404 for S2 (P-B2)', async (s) => {
    const r = await writeoff(s, writeoffBody(S2, [W5]), BR2_ONLY);
    expect(r.body.lines.map((l: any) => [l.lot_id, qty(l.qty_base)])).toEqual([[W5, 8]]);
    await nf(writeoff(s, writeoffBody(S2, [W5]), BR1_ONLY));
  });
});

// ======================================================================================================== #48 createStockAdjustment (AC-11.3)
describe.skipIf(!live)('T-10 #48 createStockAdjustment (AC-11.3): privileged', () => {
  run('AC-11.3 without aal2 => 403 auth.mfa_required; without inventory.stock.adjust => 403 auth.forbidden; the permission is asserted at BR1 with the store branch; nothing written', async (s) => {
    s.roleCalls.length = 0;
    await untouched(s, () => adjust(s, adjustBody(S1, [aLine(IT, 'in', '1', LA)]), { aal: 'aal1' }), (e) => { expect(e.code).toBe('auth.mfa_required'); expect(e.statusCode).toBe(403); });
    expect(s.roleCalls).toContainEqual({ permission: ADJUST, branchId: BR1 });
    await untouched(s, () => adjust(s, adjustBody(S1, [aLine(IT, 'in', '1', LA)]), NO_ADJUST), (e) => { expect(e.code).toBe('auth.forbidden'); expect(e.statusCode).toBe(403); });
  });
  run('AC-11.3 a reason is required: omitted => 422 inventory.reason_required; unknown / other group (spillage) => 422; with stock_correction it posts', async (s) => {
    const { reason_code: _r, ...noReason } = adjustBody(S1, [aLine(IT, 'in', '1', LA)]);
    await untouched(s, () => adjust(s, noReason), (e) => { expect(e.code).toBe('inventory.reason_required'); expect(e.statusCode).toBe(422); });
    for (const code of ['no_such_code', 'spillage']) await untouched(s, () => adjust(s, adjustBody(S1, [aLine(IT, 'in', '1', LA)], { reason_code: code })), (e) => expect(e.code).toBe('inventory.reason_required'));
    expect((await adjust(s, adjustBody(S1, [aLine(IT, 'in', '1', LA)]))).status).toBe(201);
  });
  run('adjustment in and out in ONE document: adjust_in +3 of LA (round_half_up(3 x 33325 / 100) = 999.75 -> 1000), adjust_out -4 of LB (round_half_up(4 x 100 / 7) = 57.14 -> -57)', async (s) => {
    const r = await adjust(s, adjustBody(S1, [aLine(IT, 'in', '3', LA), aLine(IT, 'out', '4', LB)], { reason_text: 'Recount' }), WITH_COST);
    expect(r.status).toBe(201);
    await consistent(s, r.body, 'adjustment');
    expect(r.body).toMatchObject({ reason_code: 'stock_correction', reason_text: 'Recount' });
    expect(r.body.lines.map((l: any) => [l.lot_id, l.direction, qty(l.qty_base), l.value_paisa])).toEqual([[LA, 'in', 3, 1000], [LB, 'out', 4, 57]]);
    expect(r.body.movements.map((m: any) => [m.movement_kind, m.lot_id, qty(m.qty_base), m.value_paisa])).toEqual([['adjust_in', LA, 3, 1000], ['adjust_out', LB, -4, -57]]);
    expect(await bal(s, S1, IT, LA)).toEqual({ q: 103, v: 34325 });
    expect(await bal(s, S1, IT, LB)).toEqual({ q: 3, v: 43 });
  });
  run('an adjustment in valued like a store return: Q = 0 lot row uses the last receipt (LZ +10 => 1500, last_receipt); no data => 0 / none (LN)', async (s) => {
    const a = await adjust(s, adjustBody(S1, [aLine(IT, 'in', '10', LZ)]), WITH_COST);
    expect(a.body.movements[0]).toMatchObject({ movement_kind: 'adjust_in', value_paisa: 1500, value_basis: 'last_receipt' });
    const b = await adjust(s, adjustBody(S1, [aLine(IT, 'in', '2', LN)]), WITH_COST);
    expect(b.body.movements[0]).toMatchObject({ value_paisa: 0, value_basis: 'none' });
  });
  run('out more than the lot holds => 409 insufficient_stock, nothing written; an out of a not-lot-tracked item uses the average (IU 5 => -500)', async (s) => {
    await untouched(s, () => adjust(s, adjustBody(S1, [aLine(IT, 'out', '6', LL)])), (e) => expect(e.code).toBe('inventory.insufficient_stock'));
    const r = await adjust(s, adjustBody(S1, [aLine(IU, 'out', '5')]), WITH_COST);
    expect(r.body.movements[0]).toMatchObject({ movement_kind: 'adjust_out', value_paisa: -500 });
  });
  run('packs: 1 BOX in => +400 base; a pack of another item => 422 uom_mismatch', async (s) => {
    expect(qty((await adjust(s, adjustBody(MAIN, [aLine(GLU, 'in', '1', LG2, { pack_id: BOX })]))).body.lines[0].qty_base)).toBe(400);
    await untouched(s, () => adjust(s, adjustBody(S1, [aLine(IT, 'in', '1', LA, { pack_id: BOX })])), (e) => expect(e.code).toBe('inventory.uom_mismatch'));
  });
  run('P-B8 a user outside BR1 WITHOUT the permission gets 404, not 403 (the object is not visible)', async (s) => {
    await nf(adjust(s, adjustBody(S1, [aLine(IT, 'in', '1', LA)]), { ...BR2_ONLY, permissions: [READ] }));
  });
});

// ======================================================================================================== #40 discardContainer
describe.skipIf(!live)('T-10 #40 discardContainer: creates a wastage document', () => {
  run('discard 5 of an open container: 200 { container, document }; the container is discarded (version 2, discard_document_id); the document is a wastage with container_id, one -5 movement at -1000 (200 a unit)', async (s) => {
    const r = await discard(s, C1, 1, discardBody('5', { reason_text: 'Contaminated' }), { permissions: [BENCH, COST] });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['container', 'document']);
    const { container: c, document: d } = r.body;
    expect(onlyKeys(c, CONTAINER_KEYS)).toEqual([]);
    expect(c).toMatchObject({ id: C1, store_id: S1, item_id: ID, lot_id: D1, status: 'discarded', discard_document_id: d.id, version: 2 });
    await consistent(s, d, 'wastage');
    expect(d).toMatchObject({ store_id: S1, container_id: C1, reason_code: 'spillage', reason_text: 'Contaminated' });
    expect(d.lines.map((l: any) => [l.item_id, l.lot_id, l.direction, qty(l.qty_base)])).toEqual([[ID, D1, 'out', 5]]);
    expect(d.movements.map((m: any) => [m.movement_kind, qty(m.qty_base), m.value_paisa])).toEqual([['wastage', -5, -1000]]);
    expect(await bal(s, S1, ID, D1)).toEqual({ q: 15, v: 3000 });
    const db = (await s.sql(A, 'SELECT status, discard_document_id, version FROM inventory.opened_containers WHERE id = $1', [C1]))[0];
    expect(db).toMatchObject({ status: 'discarded', discard_document_id: d.id, version: 2 });
    expect((await s.sql(A, 'SELECT container_id, doc_kind FROM inventory.stock_documents WHERE id = $1', [d.id]))[0]).toEqual({ container_id: C1, doc_kind: 'wastage' });
  });
  run('a technologist with bench.record only can discard; the same user cannot record wastage (#46) — PE-2; the permission is asserted at the container\'s branch', async (s) => {
    s.roleCalls.length = 0;
    expect((await discard(s, C1, 1, discardBody('1'), TECH)).status).toBe(200);
    expect(s.roleCalls).toContainEqual({ permission: BENCH, branchId: BR1 });
    await forbidden(waste(s, wastageBody(S1, [dLine(ID, '1', D1)]), TECH));
  });
  run('discarding is allowed from an EXPIRED lot (C2 / D2) and from a QUARANTINED lot (C7 / D3), and for a container with no lot (C6, IU: 3 of 25 u / 2500 => -300 at the average)', async (s) => {
    expect(lotsOf((await discard(s, C2, 1, discardBody('2'))).body.document)).toEqual([D2]);
    expect(lotsOf((await discard(s, C7, 1, discardBody('2'))).body.document)).toEqual([D3]);
    const r = await discard(s, C6, 1, discardBody('3'), { permissions: [BENCH, COST] });
    expect(r.body.document.lines[0].lot_id).toBeUndefined();
    expect(r.body.document.movements[0].value_paisa).toBe(-300);
    expect(r.body.container.lot_id).toBeUndefined();
  });
  run('more than the lot row holds (25 of 20) => 409 insufficient_stock and the container stays open (version 1)', async (s) => {
    await untouched(s, () => discard(s, C1, 1, discardBody('25')), (e) => { expect(e.code).toBe('inventory.insufficient_stock'); expect(e.statusCode).toBe(409); });
    expect((await s.sql(A, 'SELECT status, version, discard_document_id FROM inventory.opened_containers WHERE id = $1', [C1]))[0]).toEqual({ status: 'open', version: 1, discard_document_id: null });
  });
  run('reason: omitted => 422 inventory.reason_required; unknown / inactive (old_one) / another group (count_variance) => 422; a tenant code (lab_custom) works; the container is untouched on refusal', async (s) => {
    await untouched(s, () => discard(s, C1, 1, { qty_base: '1' }), (e) => { expect(e.code).toBe('inventory.reason_required'); expect(e.statusCode).toBe(422); });
    for (const code of ['no_such_code', 'old_one', 'count_variance']) await untouched(s, () => discard(s, C1, 1, discardBody('1', { reason_code: code })), (e) => expect(e.code).toBe('inventory.reason_required'));
    expect((await discard(s, C1, 1, discardBody('1', { reason_code: 'lab_custom' }))).body.document.reason_code).toBe('lab_custom');
  });
  run('state: a finished (C3) or an already discarded (C4) container => 409 inventory.document_invalid_transition; the transition is judged before If-Match (a stale version on C3 is still invalid_transition)', async (s) => {
    for (const [c, v] of [[C3, 1], [C4, 1], [C3, 9]] as const) await untouched(s, () => discard(s, c, v, discardBody('1')), (e) => { expect(e.code).toBe('inventory.document_invalid_transition'); expect(e.statusCode).toBe(409); });
  });
  run('If-Match: a stale version on an open container => 409 common.version_conflict, nothing written', async (s) => {
    await untouched(s, () => discard(s, C1, 7, discardBody('1')), (e) => { expect(e.code).toBe('common.version_conflict'); expect(e.statusCode).toBe(409); });
  });
  run('replay: the second discard of the same container (same If-Match) is refused and only ONE wastage document / movement exists', async (s) => {
    await discard(s, C1, 1, discardBody('2'));
    await untouched(s, () => discard(s, C1, 1, discardBody('2')), (e) => expect(['inventory.document_invalid_transition', 'common.version_conflict']).toContain(e.code));
    expect(Number((await s.sql(A, `SELECT count(*) AS n FROM inventory.stock_documents WHERE tenant_id = $1 AND container_id = $2`, [A, C1]))[0].n)).toBe(1);
  });
  run('scope: an unknown container, a tenant-B container, a container of a BR2 store seen by a BR1-only user, and a BR2-only user on a BR1 container => 404 (P-B2, nothing written, no assertRole before the row); a visible container without bench.record => 403', async (s) => {
    for (const [id, o, t] of [[uid(15998), {}, A], [CONT_B, {}, A], [C5, BR1_ONLY, A], [C1, BR2_ONLY, A], [C1, { ...BR2_ONLY, permissions: [READ] }, A], [C1, {}, B]] as [string, LotOpts, string][]) {
      s.roleCalls.length = 0;
      await untouched(s, () => discard(s, id, 1, discardBody('1'), o, t), (e) => { expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404); });
      expect(s.roleCalls.filter((r) => r.branchId !== undefined)).toEqual([]);
    }
    await untouched(s, () => discard(s, C1, 1, discardBody('1'), { permissions: [READ, MANAGE] }), (e) => { expect(e.code).toBe('auth.forbidden'); expect(e.statusCode).toBe(403); });
  });
  run('PE-3 without inventory.cost.read neither the document nor its movements carry a money field', async (s) => {
    const r = await discard(s, C1, 1, discardBody('2'));
    expect([costKeys(r.body.document), ...r.body.document.lines.map(costKeys), ...r.body.document.movements.map(costKeys), costKeys(r.body.container)].flat()).toEqual([]);
  });
});

describe.skipIf(!live)('T-10 #40 race (committed)', () => {
  it('2 parallel discards of the same open container with the same If-Match => exactly one 200; the loser is 409 (invalid transition or version conflict); one wastage document; the lot loses the quantity once', async () => {
    const rs = await Promise.allSettled([1, 2].map(() => committed((s) => discard(s, CR, 1, discardBody('4')))));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const bad = (rs.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
    expect(bad.statusCode).toBe(409);
    expect(['inventory.document_invalid_transition', 'common.version_conflict']).toContain(bad.code);
    await session(async (s) => {
      expect(await bal(s, S3, IR3, R3)).toEqual({ q: 6, v: 600 });
      expect(Number((await s.sql(A, 'SELECT count(*) AS n FROM inventory.stock_documents WHERE tenant_id = $1 AND container_id = $2', [A, CR]))[0].n)).toBe(1);
    });
  });
});

// ======================================================================================================== #41 / #42 read
describe.skipIf(!live)('T-10 #41 listStockDocuments / #42 getStockDocument', () => {
  run('#42 returns the full document (lines + movements) written by #43; READ-only users see no money; inventory.cost.read adds it', async (s) => {
    const w = await waste(s, wastageBody(S1, [dLine(IT, '4', LA), dLine(IT, '1', LB)]), WITH_COST);
    const r = await s.call(A, 'getStockDocument', { params: { document_id: w.body.id } }, { permissions: [READ] });
    expect(r.status).toBe(200);
    await consistent(s, r.body, 'wastage');
    expect(r.body.lines.map((l: any) => l.id)).toEqual(w.body.lines.map((l: any) => l.id));
    expect(r.body.movements.map((m: any) => m.id)).toEqual(w.body.movements.map((m: any) => m.id));
    expect([costKeys(r.body), ...r.body.lines.map(costKeys), ...r.body.movements.map(costKeys)].flat()).toEqual([]);
    const c = await s.call(A, 'getStockDocument', { params: { document_id: w.body.id } }, { permissions: [READ, COST] });
    expect(c.body.movements.every((m: any) => typeof m.value_paisa === 'number')).toBe(true);
  });
  run('#42 reads fixture document 9001 (issue, 2 lines, MAIN); a tenant-B document, an unknown id, a BR2 store document seen by a BR1-only user => 404; BR2 users see it', async (s) => {
    const r = await s.call(A, 'getStockDocument', { params: { document_id: DOC_FX } }, { permissions: [READ] });
    expect(r.body).toMatchObject({ id: DOC_FX, doc_kind: 'issue', store_id: MAIN });
    expect(r.body.lines).toHaveLength(2);
    await nf(s.call(A, 'getStockDocument', { params: { document_id: DOC_B } }, { permissions: [READ] }));
    await nf(s.call(A, 'getStockDocument', { params: { document_id: uid(15998) } }, { permissions: [READ] }));
    const other = await writeoff(s, writeoffBody(S2, [W5]), BR2_ONLY);
    await nf(s.call(A, 'getStockDocument', { params: { document_id: other.body.id } }, { ...BR1_ONLY, permissions: [READ] }));
    expect((await s.call(A, 'getStockDocument', { params: { document_id: other.body.id } }, { ...BR2_ONLY, permissions: [READ] })).status).toBe(200);
    await forbidden(s.call(A, 'getStockDocument', { params: { document_id: DOC_FX } }, { permissions: [] }));
  });
  run('#41 filters by store_id and doc_kind, returns summaries only (line_count, no lines / movements), honours occurred_at_from / _to', async (s) => {
    const i = await issue(s, issueBody(S1, [dLine(IT, '1', LB), dLine(IU, '2')]));
    const w = await waste(s, wastageBody(S1, [dLine(IT, '1', LB)]));
    const r = await s.call(A, 'listStockDocuments', { query: { store_id: S1, doc_kind: 'issue' } }, { permissions: [READ] });
    expect(r.status).toBe(200);
    expect(r.body.page).toBeDefined();
    const ids = r.body.data.map((d: any) => d.id);
    expect(ids).toContain(i.body.id);
    expect(ids).not.toContain(w.body.id);
    const mine = r.body.data.find((d: any) => d.id === i.body.id);
    expect(onlyKeys(mine, DOC_SUMMARY_KEYS)).toEqual([]);
    expect(mine).toMatchObject({ doc_no: i.body.doc_no, doc_kind: 'issue', store_id: S1, line_count: 2 });
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const none = await s.call(A, 'listStockDocuments', { query: { store_id: S1, occurred_at_from: future } }, { permissions: [READ] });
    expect(none.body.data.map((d: any) => d.id)).not.toContain(i.body.id);
    const upto = await s.call(A, 'listStockDocuments', { query: { store_id: S1, occurred_at_to: future } }, { permissions: [READ] });
    expect(upto.body.data.map((d: any) => d.id)).toEqual(expect.arrayContaining([i.body.id, w.body.id]));
  });
  run('P-B1 #41: a BR1-only user without store_id sees BR1 documents and NONE of a BR2 store; with a BR2 store_id => 404; tenant B sees none of tenant A; a user without the permission => 403 before anything', async (s) => {
    const mine = await issue(s, issueBody(S1, [dLine(IT, '1', LB)]));
    const theirs = await writeoff(s, writeoffBody(S2, [W5]), BR2_ONLY);
    const r = await s.call(A, 'listStockDocuments', { query: { limit: 200 } }, { ...BR1_ONLY, permissions: [READ] });
    const ids = r.body.data.map((d: any) => d.id);
    expect(ids).toContain(mine.body.id);
    expect(ids).not.toContain(theirs.body.id);
    await nf(s.call(A, 'listStockDocuments', { query: { store_id: S2 } }, { ...BR1_ONLY, permissions: [READ] }));
    const b = await s.call(B, 'listStockDocuments', { query: { limit: 200 } }, { permissions: [READ] });
    expect(b.body.data.map((d: any) => d.id)).not.toContain(mine.body.id);
    s.roleCalls.length = 0;
    await forbidden(s.call(A, 'listStockDocuments', {}, { permissions: [] }));
    expect(s.roleCalls[0]).toEqual({ permission: READ });
  });
});
