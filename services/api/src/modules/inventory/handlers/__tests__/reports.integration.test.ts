// C12.T-19 integration (golden datasets) for #92 getInventoryReport and #93 exportInventoryReport on the migrated database as role lims_api with RLS on (REAL repositories + handlers/index.ts).
// Spec: PRD AC-21.1-21.9 and §8.3, 02-TRD §5.5 / §5.10 / §5.11 / §6.3 / §8.6, 07-SECURITY P-B6 / PE-1 / PE-3 / P-9 and the abuse controls. Seams: reports.helpers.ts (header) - read it first.
// Harness: tests/db/c12-t19/run.sh (clone of c12-t18: pinned image, migrations, seeds, inventory DDL, exports LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL / LIMS_C12T03_REQUIRE_DB=1).
// Each test = one request-shaped transaction that is ROLLED BACK; every handler call runs inside a SAVEPOINT. The fixtures below are committed once with the superuser (session_replication_role = replica
// so the source rows of other modules need no parents; CHECK constraints still apply). ids 19xxx in tenant A, one row set in tenant B. The clock is frozen at 2026-06-15T06:00:00Z (ctx.now).
// DATASETS (one date window each, so the goldens never interfere; the T-03 fixtures sit on "yesterday" of the real clock, outside every window):
//   DC  2026-03-02..04 daily / analyser: stores S1 (BR1) S2 (BR2); items I1 (name '=HYPERLINK...'), I2, I3 (name '+1+1 plus'); instruments X1, X2 ('@SUM(A1) analyser'); tests TA, TB; a reversal row (negative qty)
//       and a row without instrument; boundary rows on 03-01 and 03-05; tenant B row; ledger movements for every row (the AC-21.1 oracle).
//   CPT 2026-05-01..03 : instruments XC1 (bound to SC1) XC2; tests C1..C6; N / D / F / Ntot chosen for N = 0, Ntot = 0, exact .5 rounding, a reversal, fixed consumption shared by three tests, "none" instrument.
//   WST 2026-04-10..12 : wastage by reason, expiry write-off, count variance (out 3 / in -1). EXP: lots around today (2026-06-15). VAL: stock_valuation now and as_of 2026-06-10.
//   REC 2026-07-01..03 : test block (R1..R4) and the instrument block (XR1..XR3), unresolved / dismissed facts.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  A, B, BR1, BR2, BR1_ONLY, BR2_ONLY, BR_B, BREAKDOWN_KEYS, COLUMN_KEYS, COST_FIELD, EXPORT, LEAK, NOW, NO_COST, OPS, READER, READ_ONLY, REPORTS, RESULT_KEYS, ROW_KEYS, SYS, bodyText, csvObjects,
  deepKeys, expectLims, headerOf, isNum, makeRepCtx, num, parseCsv, rej, rep, uid, win, type RepOpts,
} from './reports.helpers.js';
import { call } from './masters.helpers.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const CENTRE_BR1 = '01a1a98a-ac40-7000-8000-00000000a201';
const tid = { tenant_id: A };

// ------------------------------------------------------------------------------------------------------------------------------------------------ fixture ids
const S1 = uid(19001), S2 = uid(19002), SC1 = uid(19003);
const I1 = uid(19101), I2 = uid(19102), I3 = uid(19103);
const E1 = uid(19111), E2 = uid(19112), E3 = uid(19113), V1 = uid(19121), V2 = uid(19122), IS1 = uid(19131), IS2 = uid(19132), IS3 = uid(19133);
const X1 = uid(19211), X2 = uid(19212), XC1 = uid(19213), XC2 = uid(19214), XR1 = uid(19215), XR2 = uid(19216), XR3 = uid(19217);
const TA = uid(19401), TB = uid(19402), C1 = uid(19411), C2 = uid(19412), C3 = uid(19413), C4 = uid(19414), C5 = uid(19415), C6 = uid(19416), R1 = uid(19421), R2 = uid(19422), R3 = uid(19423), R4 = uid(19424), AN1 = uid(19431);
const LEXP = uid(19201), LSOON = uid(19202), LMID = uid(19203), LFAR = uid(19204), LZERO = uid(19205), LNOEXP = uid(19206), LV1 = uid(19207);
const STORE_B = uid(1101), ITEM_B = uid(2101); // T-03 fixtures, tenant B
const OTHER = uid(19999);
const DEPT = uid(19450);

// ------------------------------------------------------------------------------------------------------------------------------------------------ superuser seeding
const colCache = new Map<string, { column_name: string; data_type: string }[]>();
async function required(c: pg.PoolClient, table: string) {
  if (!colCache.has(table)) {
    const [schema, name] = table.split('.');
    colCache.set(table, (await c.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER' AND is_identity = 'NO'`, [schema, name])).rows);
  }
  return colCache.get(table)!;
}
function dummy(type: string, col: string): unknown {
  switch (type) {
    case 'uuid': return /(^|_)by$/.test(col) ? SYS : randomUUID();
    case 'text': case 'character varying': return 't19';
    case 'integer': case 'smallint': case 'bigint': case 'numeric': return 0;
    case 'boolean': return false;
    case 'timestamp with time zone': return NOW;
    case 'date': return '2026-01-01';
    case 'jsonb': return {};
    case 'ARRAY': return '{}';
    case 'bytea': return '\\x01';
    default: throw new Error(`t19 fixture: no dummy for ${type} (${col})`);
  }
}
/** Inserts `rows` into `table` (columns the caller omits that are NOT NULL without default are filled with dummies). Triggers / FKs are bypassed (replica). */
async function put(c: pg.PoolClient, table: string, rows: Record<string, unknown>[]) {
  const req = await required(c, table);
  const full = rows.map((r) => ({ ...Object.fromEntries(req.map((k) => [k.column_name, dummy(k.data_type, k.column_name)])), ...r }));
  const cols = [...new Set(full.flatMap((r) => Object.keys(r)))];
  for (let i = 0; i < full.length; i += 250) {
    const batch = full.slice(i, i + 250).map((r) => Object.fromEntries(cols.filter((k) => k in r).map((k) => [k, r[k]])));
    const list = cols.map((k) => `"${k}"`).join(',');
    await c.query(`INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(batch)]);
  }
}
const store = (id: string, br: string, code: string) => ({ id, ...tid, branch_id: br, store_code: code, name: `Store ${code}`, store_kind: 'bench', is_default_consumption: false, is_active: true });
const item = (id: string, code: string, name: string, tracked = false) => ({ id, ...tid, item_code: code, name, category: 'reagent', base_uom_code: 'piece', is_lot_tracked: tracked, requires_expiry: tracked, is_active: true });
const instrument = (id: string, code: string, display: string) => ({ id, ...tid, centre_id: CENTRE_BR1, agent_id: randomUUID(), instrument_code: code, display_name: display, vendor: 'Synthetic', model: 'SX-1', protocol: 'astm',
  driver_code: 'astm_generic_e1394', transport: { kind: 'tcp_client' }, timezone: 'Asia/Kathmandu', state: 'draft' });
const orderable = (id: string, code: string, name: string) => ({ id, ...tid, kind: 'test', code, name, department_id: DEPT, is_orderable: true, is_active: true });
let n = 0;
const cd = (date: string, st: string, it: string, kind: string, instr: string | null, test: string | null, qty: number, val: number, mv: number, tenant = A) =>
  ({ id: uid(19500 + ++n), tenant_id: tenant, business_date: date, store_id: st, item_id: it, movement_kind: kind, instrument_id: instr, attributed_test_id: test, qty_consumed: qty, value_consumed_paisa: val, movements: mv });
const tcd = (date: string, instr: string | null, test: string, counted: number, rerun = 0, qc = 0) =>
  ({ id: uid(19700 + ++n), ...tid, business_date: date, instrument_id: instr, test_id: test, tests_counted: counted, verified_result_events: counted, rerun_events: rerun, qc_events: qc });
const mv = (date: string, st: string, it: string, lot: string | null, kind: string, qty: number, val: number, o: Record<string, unknown> = {}) =>
  ({ id: uid(19800 + ++n), ...tid, business_date: date, occurred_at: `${date}T06:00:00Z`, store_id: st, item_id: it, lot_id: lot, movement_kind: kind, qty_base: qty, value_paisa: val, value_basis: 'average',
    doc_type: 'stock_document', doc_id: randomUUID(), balance_qty_after: 0, ...o });
const bal = (nn: number, st: string, it: string, lot: string | null, q: number, v: number) => ({ id: uid(19300 + nn), ...tid, store_id: st, item_id: it, lot_id: lot, qty_base: q, value_paisa: v, last_movement_at: NOW });
const lot = (id: string, it: string, no: string, exp: string | null, status = 'available') => ({ id, ...tid, item_id: it, lot_no: no, status, expiry_on: exp });
const rule = (nn: number, kind: string, test: string, it: string, qty: number, analyte: string | null = null) =>
  ({ id: uid(19950 + nn), ...tid, rule_kind: kind, test_id: test, analyte_id: analyte, item_id: it, qty_base: qty, entered_qty: qty, effective_from: '2026-01-01T00:00:00Z', is_active: true });
const fact = (nn: number, date: string, status: string) => ({ id: uid(19900 + nn), ...tid, fact_kind: 'test', basis_key: `t19-fact-${nn}`, source: 'manual', occurred_at: `${date}T06:00:00Z`, business_date: date, status, rules_applied: 0 });
const messageRow = (inst: string, date: string, k: number) => ({ id: uid(19600 + k), ...tid, centre_id: CENTRE_BR1, instrument_id: inst, agent_message_id: randomUUID(), protocol: 'astm', message_kind: 'data', message_key: `t19-${inst}-${date}-${k}`,
  message_key_kind: 'sha256', raw_bytes: '\\x01', raw_sha256: 'a'.repeat(64), size_bytes: 1, captured_at_agent: `${date}T06:15:00Z`, agent_clock_offset_ms: 0, captured_at: `${date}T06:15:00Z`, received_at: `${date}T06:15:00Z` });
const run1 = (messageId: string, qc: number) => ({ id: randomUUID(), ...tid, centre_id: CENTRE_BR1, message_id: messageId, run_no: 1, kind: 'live', driver_code: 'astm_generic_e1394', driver_version: '1', outcome: 'parsed', qc_records: qc, actor_type: 'system' });
async function seedVerified(c: pg.PoolClient, test: string, date: string, k: number) {
  const results = Array.from({ length: k }, () => ({ id: randomUUID(), ...tid, centre_id: CENTRE_BR1, processing_branch_id: BR1, test_id: test, status: 'verified', origin: 'manual', result_type: 'numeric', is_reportable: true, analyte_code: 'T19' }));
  await put(c, 'lab.results', results);
  await put(c, 'lab.verifications', results.map((r) => ({ id: randomUUID(), ...tid, centre_id: CENTRE_BR1, result_id: r.id, kind: 'verified', mode: 'manual', result_row_version: 1, occurred_at: `${date}T06:15:00Z` })));
}

// the consumption_daily rows of the DC dataset (window 2026-03-02 .. 03-04, exclusive end 03-05); every row also gets one ledger movement (the AC-21.1 oracle)
const DC_ROWS = [
  cd('2026-03-02', S1, I1, 'consume_test', X1, TA, 6, 3000, 3), cd('2026-03-02', S1, I1, 'consume_test', X1, TB, 4, 2000, 1), cd('2026-03-02', S1, I1, 'issue', null, null, 2, 1000, 1),
  cd('2026-03-03', S1, I2, 'consume_qc', X2, TA, 1.5, 750, 2), cd('2026-03-03', S1, I1, 'consume_test', X2, TA, 5, 2500, 2), cd('2026-03-03', S1, I1, 'consume_test', X2, TB, -1, -500, 1),
  cd('2026-03-04', S2, I3, 'consume_fixed', X1, null, 3, 900, 1), cd('2026-03-04', S1, I2, 'consume_test', null, TB, -2, -800, 1),
  cd('2026-03-01', S1, I1, 'consume_test', X1, TA, 99, 9999, 9), cd('2026-03-05', S2, I3, 'issue', null, null, 77, 7777, 7), // outside the window (03-01 before, 03-05 = exclusive end)
  cd('2026-03-02', STORE_B, ITEM_B, 'consume_test', null, null, 55, 5555, 5, B),                                                  // tenant B
];
const dcMovement = (r: ReturnType<typeof cd>) => r.qty_consumed < 0
  ? mv(r.business_date, r.store_id, r.item_id, null, 'consume_reversal', -r.qty_consumed, -r.value_consumed_paisa, { tenant_id: r.tenant_id, value_basis: 'reversal', doc_type: 'consumption_fact', reverses_movement_id: randomUUID() })
  : mv(r.business_date, r.store_id, r.item_id, null, r.movement_kind, -r.qty_consumed, -r.value_consumed_paisa, { tenant_id: r.tenant_id, doc_type: r.movement_kind === 'issue' ? 'stock_document' : 'consumption_fact' });

const CPT_ROWS = [
  cd('2026-05-01', SC1, IS1, 'consume_test', XC1, C1, 7, 700, 7), cd('2026-05-03', SC1, IS1, 'consume_rerun', XC1, C1, 3, 301, 3),
  cd('2026-05-01', SC1, IS1, 'consume_test', XC1, C3, 9, 900, 9), cd('2026-05-02', SC1, IS1, 'consume_test', XC1, C3, -3, -300, 1),   // C3: a reversal nets the day
  cd('2026-05-02', SC1, IS1, 'consume_test', XC1, C4, 2, 250, 2),                                                                  // C4: consumption without any test count (N = 0)
  cd('2026-05-01', SC1, IS2, 'consume_fixed', XC1, null, 5, 500, 1), cd('2026-05-03', SC1, IS2, 'consume_fixed', XC1, null, 5, 501, 1), // F(XC1) = 1001 over two days
  cd('2026-05-02', SC1, IS1, 'consume_test', XC2, C5, 3, 300, 3), cd('2026-05-02', SC1, IS2, 'consume_fixed', XC2, null, 8, 800, 1),  // XC2: Ntot = 0
  cd('2026-05-02', SC1, IS1, 'consume_analyte', null, C6, 10, 1000, 10),                                                           // instrument "none"
  cd('2026-04-30', SC1, IS1, 'consume_test', XC1, C1, 99, 9999, 9), cd('2026-05-04', SC1, IS1, 'consume_test', XC1, C1, 99, 9999, 9), // outside
];
const CPT_COUNTS = [tcd('2026-05-01', XC1, C1, 1), tcd('2026-05-02', XC1, C1, 1), tcd('2026-05-02', XC1, C2, 1), tcd('2026-05-01', XC1, C3, 2), tcd('2026-05-03', XC1, C3, 1), tcd('2026-05-02', null, C6, 4),
  tcd('2026-05-04', XC1, C1, 50), tcd('2026-04-30', XC1, C2, 50)];

let api: pg.Pool;
let admin: pg.Pool;
beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 12 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c12-t03/fixtures.sql', import.meta.url)), 'utf8'));
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query(`SELECT set_config('request.jwt.claims', '{"tenant_id":"${A}","sub":"${SYS}","actor_type":"system"}', true)`);
    await put(c, 'inventory.stores', [store(S1, BR1, 'T19-S1'), store(S2, BR2, 'T19-S2'), store(SC1, BR1, 'T19-SC1')]);
    await put(c, 'inventory.items', [item(I1, 'T19-I1', '=HYPERLINK("http://x.example","go")'), item(I2, 'T19-I2', 'Reagent two'), item(I3, 'T19-I3', '+1+1 plus'),
      item(E1, 'T19-E1', 'Expiry one', true), item(E2, 'T19-E2', 'Expiry two', true), item(E3, 'T19-E3', 'Expiry three', true), item(V1, 'T19-V1', 'Valuation lot item', true), item(V2, 'T19-V2', 'Valuation unlotted item'),
      item(IS1, 'T19-IS1', 'Standard one'), item(IS2, 'T19-IS2', 'Standard two'), item(IS3, 'T19-IS3', 'Standard three, no cost')]);
    await put(c, 'instruments.instruments', [instrument(X1, 'T19-X1', 'Analyser One'), instrument(X2, 'T19-X2', '@SUM(A1) analyser'), instrument(XC1, 'T19-XC1', 'Analyser C1'), instrument(XC2, 'T19-XC2', 'Analyser C2'),
      instrument(XR1, 'T19-XR1', 'Analyser R1'), instrument(XR2, 'T19-XR2', 'Analyser R2'), instrument(XR3, 'T19-XR3', 'Analyser R3')]);
    const tests = [[TA, 'T19-TA', 'Test A'], [TB, 'T19-TB', 'Test B'], [C1, 'T19-C1', 'Cost one'], [C2, 'T19-C2', 'Cost two'], [C3, 'T19-C3', 'Cost three'], [C4, 'T19-C4', 'Cost four'], [C5, 'T19-C5', 'Cost five'], [C6, 'T19-C6', 'Cost six'],
      [R1, 'T19-R1', 'Rec one'], [R2, 'T19-R2', 'Rec two'], [R3, 'T19-R3', 'Rec three'], [R4, 'T19-R4', 'Rec four']] as const;
    await put(c, 'catalog.orderables', tests.map(([id, code, name]) => orderable(id, code, name)));
    await put(c, 'catalog.tests', tests.map(([id]) => ({ id, ...tid, kind: 'test', workflow_type: 'standard' })));
    // DC + ledger oracle
    await put(c, 'inventory.consumption_daily', DC_ROWS);
    await put(c, 'inventory.stock_movements', DC_ROWS.map(dcMovement));
    await put(c, 'inventory.test_counts_daily', [tcd('2026-03-02', X1, TA, 12, 1, 0), tcd('2026-03-03', X1, TA, 8, 1, 1), tcd('2026-03-02', X1, TB, 5), tcd('2026-03-03', X2, TA, 7, 0, 3), tcd('2026-03-01', X1, TA, 100), tcd('2026-03-05', X1, TA, 100)]);
    // CPT
    await put(c, 'inventory.consumption_daily', CPT_ROWS);
    await put(c, 'inventory.test_counts_daily', CPT_COUNTS);
    await put(c, 'inventory.instrument_bindings', [{ id: uid(19960), ...tid, instrument_id: XC1, store_id: SC1, is_active: true }]);
    await put(c, 'inventory.stock_balances', [bal(1, SC1, IS1, null, 10, 54), bal(2, SC1, IS2, null, 10, 54)]); // avg cost 5.4 paisa per base unit each
    await put(c, 'inventory.consumption_rules', [rule(1, 'per_test', C1, IS1, 1), rule(2, 'per_analyte', C1, IS2, 1, AN1), rule(3, 'per_test', C3, IS3, 2),
      rule(4, 'per_test', C2, IS1, 1), { ...rule(5, 'per_test', C2, IS1, 2), instrument_id: XC1 }, // C2: generic + XC1-specific on one item => ONLY the specific rule counts (TRD 5.8 step 2): 10.8 -> 11, not 16
      rule(6, 'per_test', C4, IS1, 1), { ...rule(7, 'per_test', C4, IS1, 100), effective_from: '2099-01-01T00:00:00Z' }]); // C4: a future-dated rule is not matched today: 5.4 -> 5, not 545 // C1 standard = 5.4 + 5.4 = 10.8; C3's item has no cost
    // wastage / count variance
    await put(c, 'inventory.consumption_daily', [
      cd('2026-04-10', S1, I1, 'wastage', null, null, 2, 400, 1), cd('2026-04-11', S1, I1, 'wastage', null, null, 1, 200, 1), cd('2026-04-12', S1, I2, 'expiry_writeoff', null, null, 5, 750, 1),
      cd('2026-04-11', S1, I1, 'count_adjust_out', null, null, 3, 600, 1), cd('2026-04-12', S1, I1, 'count_adjust_out', null, null, -1, -200, 1),
      cd('2026-04-10', S2, I1, 'wastage', null, null, 9, 900, 1), cd('2026-04-09', S1, I1, 'wastage', null, null, 50, 5000, 1), cd('2026-04-13', S1, I1, 'expiry_writeoff', null, null, 60, 6000, 1)]);
    await put(c, 'inventory.stock_movements', [mv('2026-04-10', S1, I1, null, 'wastage', -2, -400, { reason_code: 'damaged' }), mv('2026-04-11', S1, I1, null, 'wastage', -1, -200, { reason_code: 'spillage' }),
      mv('2026-04-10', S2, I1, null, 'wastage', -9, -900, { reason_code: 'damaged' }), mv('2026-04-09', S1, I1, null, 'wastage', -50, -5000, { reason_code: 'damaged' })]);
    // expiry (today = 2026-06-15) and valuation
    await put(c, 'inventory.lots', [lot(LEXP, E1, '=SUM(1+1)', '2026-06-12'), lot(LSOON, E2, '+1', '2026-06-25'), lot(LMID, E3, '-2', '2026-07-05', 'quarantined'), lot(LFAR, E3, "'far", '2026-09-13'),
      lot(LZERO, E1, 'ZERO', '2026-06-20'), lot(LNOEXP, E2, 'NOEXP', null), lot(LV1, V1, 'T19-LV1', '2027-01-01')]);
    await put(c, 'inventory.stock_balances', [bal(11, S1, E1, LEXP, 5, 500), bal(12, S1, E2, LSOON, 4, 400), bal(13, S2, E2, LSOON, 2, 200), bal(14, S1, E3, LMID, 1, 100), bal(15, S1, E3, LFAR, 7, 700),
      bal(16, S1, E1, LZERO, 0, 0), bal(17, S1, E2, LNOEXP, 9, 900), bal(21, S1, V1, LV1, 3, 1000), bal(22, S1, V2, null, 4, 410), bal(23, S2, V1, LV1, 2, 200), bal(24, S2, V2, null, 1, 50)]);
    await put(c, 'inventory.opened_containers', [{ id: uid(19970), ...tid, store_id: S1, item_id: E2, lot_id: LSOON, opened_at: '2026-06-10T06:00:00Z', open_expiry_at: '2026-06-30T06:00:00Z', status: 'open' }]);
    await put(c, 'inventory.stock_movements', [mv('2026-06-05', S1, V1, LV1, 'receive', 9, 3000, { value_basis: 'receipt', doc_type: 'goods_receipt', balance_qty_after: 9 }),
      mv('2026-06-12', S1, V1, LV1, 'consume_test', -6, -2000, { doc_type: 'consumption_fact', balance_qty_after: 3 }), mv('2026-06-12', S1, V2, null, 'receive', 4, 410, { value_basis: 'receipt', doc_type: 'goods_receipt', balance_qty_after: 4 }),
      mv('2026-06-05', S2, V1, LV1, 'receive', 2, 200, { value_basis: 'receipt', doc_type: 'goods_receipt', balance_qty_after: 2 }), mv('2026-06-12', S2, V2, null, 'receive', 1, 50, { value_basis: 'receipt', doc_type: 'goods_receipt', balance_qty_after: 1 })]);
    // reconciliation: lab side, C12 side, instrument QC side, facts
    for (const [t, d, k] of [[R1, '2026-07-01', 100], [R2, '2026-07-02', 99], [R3, '2026-07-01', 40], [R1, '2026-06-30', 9], [R1, '2026-07-04', 3]] as const) await seedVerified(c, t, d, k);
    await put(c, 'inventory.test_counts_daily', [tcd('2026-07-01', XR1, R1, 60), tcd('2026-07-01', XR2, R1, 30), tcd('2026-07-02', null, R2, 100), tcd('2026-07-03', null, R4, 25), tcd('2026-06-30', XR1, R1, 5), tcd('2026-07-04', XR1, R1, 5)]);
    await put(c, 'inventory.instrument_qc_daily', [{ ...tid, business_date: '2026-07-01', instrument_id: XR1, qc_observations: 20 }, { ...tid, business_date: '2026-07-02', instrument_id: XR1, qc_observations: 5 },
      { ...tid, business_date: '2026-07-01', instrument_id: XR2, qc_observations: 7 }]);
    const msgs = [messageRow(XR1, '2026-07-01', 1), messageRow(XR1, '2026-07-01', 2), messageRow(XR1, '2026-07-02', 3), messageRow(XR3, '2026-07-03', 4)];
    await put(c, 'instruments.messages', msgs);
    await put(c, 'instruments.processing_runs', [run1(msgs[0]!.id, 8), run1(msgs[1]!.id, 9), run1(msgs[2]!.id, 5), run1(msgs[3]!.id, 4)]);
    await put(c, 'inventory.consumption_facts', [fact(1, '2026-07-01', 'unresolved'), fact(2, '2026-07-03', 'unresolved'), fact(3, '2026-07-02', 'dismissed'), fact(4, '2026-06-30', 'unresolved'), fact(5, '2026-07-04', 'dismissed')]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}, 240_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

// ------------------------------------------------------------------------------------------------------------------------------------------------ session
interface Res { status: number; body: any; headers?: Record<string, string> }
interface Sess {
  get(code: string, query?: Record<string, unknown>, o?: RepOpts, t?: string): Promise<Res>;
  csv(code: string, query?: Record<string, unknown>, o?: RepOpts, t?: string): Promise<Res>;
  sql(t: string, text: string, v?: unknown[]): Promise<any[]>;
  roleCalls: any[]; audit: any[]; catalogCalls: any[];
}
const claims = (t: string) => JSON.stringify({ tenant_id: t, sub: SYS, actor_type: 'system' });
function sessionOn(client: pg.PoolClient): Sess {
  let k = 0;
  const roleCalls: any[] = []; const audit: any[] = []; const catalogCalls: any[] = [];
  const tx = { query: (t: string, v?: unknown[]) => client.query(t, v) };
  const go = async (op: string, code: string, query: Record<string, unknown>, o: RepOpts, t: string): Promise<Res> => {
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]);
    const st = makeRepCtx(tx, t, o);
    const sp = `t19_h${++k}`;
    await client.query(`SAVEPOINT ${sp}`);
    const keep = () => { roleCalls.push(...st.roleCalls); audit.push(...st.audit); catalogCalls.push(...st.catalogCalls); };
    try { const r = await call(op, st.ctx, rep(code, query)); keep(); await client.query(`RELEASE SAVEPOINT ${sp}`); return r; }
    catch (e) { keep(); await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
  };
  return {
    roleCalls, audit, catalogCalls,
    get: (code, query = {}, o = {}, t = A) => go(OPS.get, code, query, o, t),
    csv: (code, query = {}, o = {}, t = A) => go(OPS.csv, code, query, o, t),
    async sql(t, text, v) { await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]); return (await client.query(text, v)).rows; },
  };
}
async function session<T>(fn: (s: Sess) => Promise<T>): Promise<T> {
  const client = await api.connect();
  try { await client.query('BEGIN'); return await fn(sessionOn(client)); } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}
const runT = (name: string, fn: (s: Sess) => Promise<void>) => it(name, () => session(fn));

// ------------------------------------------------------------------------------------------------------------------------------------------------ helpers
const DC = win('2026-03-02', '2026-03-05');
const CPT = win('2026-05-01', '2026-05-04');
const WST = win('2026-04-10', '2026-04-13');
const REC = win('2026-07-01', '2026-07-04');
const QUERY: Record<string, Record<string, unknown>> = { daily_consumption: DC, analyser_consumption: DC, cost_per_test: CPT, wastage: WST, expiry: { store_id: S1 }, stock_valuation: { store_id: S1 }, consumption_reconciliation: REC };
const body = async (s: Sess, code: string, q: Record<string, unknown> = QUERY[code]!, o?: RepOpts, t = A) => (await s.get(code, q, o, t)).body;
const rowsOf = async (s: Sess, code: string, q?: Record<string, unknown>, o?: RepOpts, t = A): Promise<any[]> => (await body(s, code, q, o, t)).rows;
const find = (rows: any[], p: Partial<Record<string, unknown>>) => rows.filter((r) => Object.entries(p).every(([k, v]) => r[k] === v));
const one = (rows: any[], p: Partial<Record<string, unknown>>) => { const f = find(rows, p); if (f.length !== 1) throw new Error(`expected exactly one row for ${JSON.stringify(p)}, got ${f.length}`); return f[0]; };
const nf = (p: Promise<unknown>) => expectLims(p, 'common.not_found', 404);
const forbidden = (p: Promise<unknown>) => expectLims(p, 'auth.forbidden', 403);
const nul = (v: unknown) => v ?? null;
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const was = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const table = async (s: Sess, code: string, q: Record<string, unknown> = QUERY[code]!, o?: RepOpts, t = A) => csvObjects(bodyText((await s.csv(code, q, o, t)).body));
const countAll = (s: Sess) => s.sql(A, `SELECT (SELECT count(*) FROM inventory.stock_movements WHERE tenant_id = $1)::int AS mv, (SELECT count(*) FROM inventory.consumption_daily WHERE tenant_id = $1)::int AS cd,
  (SELECT count(*) FROM inventory.alerts WHERE tenant_id = $1)::int AS al, (SELECT count(*) FROM inventory.consumption_facts WHERE tenant_id = $1)::int AS ft, (SELECT count(*) FROM inventory.test_counts_daily WHERE tenant_id = $1)::int AS tc`, [A]).then((r) => r[0]);

describe('T-19 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => { if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true); });
});

// =============================================================================================================== AC-21.1 daily consumption
describe.skipIf(!live)('T-19 AC-21.1 daily_consumption: golden rows, window, filters, ledger oracle, wire shape', () => {
  const GOLD: [string, string, string, string, number, number, number][] = [
    ['2026-03-02', S1, I1, 'consume_test', 10, 5000, 4], ['2026-03-02', S1, I1, 'issue', 2, 1000, 1], ['2026-03-03', S1, I1, 'consume_test', 4, 2000, 3],
    ['2026-03-03', S1, I2, 'consume_qc', 1.5, 750, 2], ['2026-03-04', S1, I2, 'consume_test', -2, -800, 1], ['2026-03-04', S2, I3, 'consume_fixed', 3, 900, 1],
  ];
  runT('200 ReportResult: exactly the contract keys, params echoed, generated_at = ctx.now, no tenant / audit columns, read-only on the data', async (s) => {
    const before = await countAll(s);
    const r = await s.get('daily_consumption', DC);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual([...RESULT_KEYS].sort());
    expect(r.body.report_code).toBe('daily_consumption'); expect(r.body.params).toMatchObject(DC);
    expect(Date.parse(r.body.generated_at)).toBe(Date.parse(NOW)); expect(r.body.truncated).toBe(false);
    expect(JSON.stringify(r.body)).not.toMatch(LEAK);
    for (const c of r.body.columns) { expect(Object.keys(c).sort()).toEqual([...COLUMN_KEYS].sort()); }
    for (const row of r.body.rows) expect(Object.keys(row).filter((k) => !ROW_KEYS.includes(k))).toEqual([]);
    expect(await countAll(s)).toEqual(before); expect(s.audit).toEqual([]); // a screen report writes nothing, not even an access-log entry
  });
  runT('columns: the TRD §5.11 keys, is_cost true exactly for value_consumed_paisa', async (s) => {
    const cols = (await body(s, 'daily_consumption')).columns as { key: string; is_cost: boolean }[];
    const keys = ['business_date', 'store_id', 'store_code', 'item_id', 'item_code', 'item_name', 'base_uom_code', 'movement_kind', 'qty_consumed', 'value_consumed_paisa', 'movements'];
    for (const k of keys) expect(cols.map((c) => c.key), k).toContain(k);
    expect(cols.filter((c) => c.is_cost).map((c) => c.key)).toEqual(['value_consumed_paisa']);
  });
  runT('golden rows: one per business_date x store x item x kind, quantities and values summed over instruments / tests, a reversal nets; boundaries: 03-01 out, 03-05 (exclusive end) out; tenant B out', async (s) => {
    const rows = await rowsOf(s, 'daily_consumption');
    expect(rows).toHaveLength(GOLD.length);
    for (const [d, st, it, kind, q, v, m] of GOLD) {
      const r = one(rows, { business_date: d, store_id: st, item_id: it, movement_kind: kind });
      expect(num(r.qty_consumed), `${d} ${kind} qty`).toBeCloseTo(q, 6); expect(r.value_consumed_paisa, `${d} ${kind} value`).toBe(v); expect(r.movements, `${d} ${kind} movements`).toBe(m);
    }
    expect(one(rows, { movement_kind: 'consume_qc' })).toMatchObject({ store_code: 'T19-S1', item_code: 'T19-I2', item_name: 'Reagent two', base_uom_code: 'piece' });
    expect(rows.some((r) => r.business_date === '2026-03-01' || r.business_date === '2026-03-05' || r.store_id === STORE_B)).toBe(false);
  });
  runT('totals = sum of the rows (value, movements) and = the sum of the ledger movements of those kinds in the window (the AC-21.1 oracle, taken from stock_movements)', async (s) => {
    const b = await body(s, 'daily_consumption');
    expect(b.totals.value_consumed_paisa).toBe(8850); expect(b.totals.movements).toBe(12);
    expect(b.rows.reduce((a: number, r: any) => a + r.value_consumed_paisa, 0)).toBe(b.totals.value_consumed_paisa);
    const o = (await s.sql(A, `SELECT coalesce(sum(-value_paisa), 0)::bigint AS v FROM inventory.stock_movements WHERE tenant_id = $1 AND business_date >= '2026-03-02' AND business_date < '2026-03-05'
      AND movement_kind IN ('issue','consume_test','consume_analyte','consume_rerun','consume_qc','consume_calibration','consume_fixed','consume_reversal')`, [A]))[0];
    expect(Number(o.v)).toBe(b.totals.value_consumed_paisa);
  });
  runT('filters: store_id, branch_id, item_id, instrument_id, test_id narrow the rows (and the totals)', async (s) => {
    const q = (o: Record<string, unknown>) => body(s, 'daily_consumption', { ...DC, ...o });
    const st = await q({ store_id: S1 }); expect(st.rows).toHaveLength(5); expect(st.totals.value_consumed_paisa).toBe(7950); expect(st.totals.movements).toBe(11);
    expect((await q({ branch_id: BR2 })).rows.map((r: any) => r.store_id)).toEqual([S2]);
    expect(new Set((await q({ branch_id: BR1 })).rows.map((r: any) => r.store_id))).toEqual(new Set([S1]));
    expect((await q({ item_id: I2 })).rows).toHaveLength(2);
    const x1 = await q({ instrument_id: X1 }); expect(x1.rows).toHaveLength(2); expect(x1.totals.value_consumed_paisa).toBe(5900);
    const tb = await q({ test_id: TB }); expect(tb.rows).toHaveLength(3); expect(tb.totals.value_consumed_paisa).toBe(2000 - 500 - 800);
  });
  runT('the cost-less caller gets the same rows without value_consumed_paisa (AC-21.9) - quantities and counts survive', async (s) => {
    const b = await body(s, 'daily_consumption', DC, NO_COST);
    expect(b.rows).toHaveLength(GOLD.length);
    expect(deepKeys(b).filter((k) => COST_FIELD.test(k))).toEqual([]);
    expect(b.columns.some((c: any) => c.is_cost)).toBe(false); expect(b.columns.map((c: any) => c.key)).toContain('qty_consumed');
    expect(num(one(b.rows, { movement_kind: 'consume_qc' }).qty_consumed)).toBeCloseTo(1.5, 6); expect(b.totals.movements).toBe(12);
  });
});

// =============================================================================================================== AC-21.2 analyser consumption
describe.skipIf(!live)('T-19 AC-21.2 analyser_consumption: instrument x item x kind, per-test count block', () => {
  runT('golden rows: instrument x item x kind over the window; rows without instrument are not in it; label from the instrument directory', async (s) => {
    const rows = await rowsOf(s, 'analyser_consumption');
    expect(rows).toHaveLength(4);
    const g = (inst: string, it: string, kind: string, q: number, v: number, m: number) => { const r = one(rows, { instrument_id: inst, item_id: it, movement_kind: kind }); expect(num(r.qty_consumed)).toBeCloseTo(q, 6); expect(r.value_consumed_paisa).toBe(v); expect(r.movements).toBe(m); return r; };
    expect(g(X1, I1, 'consume_test', 10, 5000, 4)).toMatchObject({ instrument_label: 'Analyser One', item_code: 'T19-I1' });
    g(X1, I3, 'consume_fixed', 3, 900, 1); g(X2, I1, 'consume_test', 4, 2000, 3); g(X2, I2, 'consume_qc', 1.5, 750, 2);
    expect(rows.some((r) => r.movement_kind === 'issue' || r.instrument_id == null)).toBe(false);
  });
  runT('tests[] of an instrument: tests_counted / rerun_events / qc_events summed over the window (03-01 and 03-05 excluded), test_code from the catalogue directory', async (s) => {
    const rows = await rowsOf(s, 'analyser_consumption');
    const t = (inst: string) => [...(one(rows, { instrument_id: inst, movement_kind: inst === X1 ? 'consume_fixed' : 'consume_qc' }).tests as any[])].sort((a, b) => a.test_code.localeCompare(b.test_code));
    expect(t(X1)).toEqual([{ test_id: TA, test_code: 'T19-TA', tests_counted: 20, rerun_events: 2, qc_events: 1 }, { test_id: TB, test_code: 'T19-TB', tests_counted: 5, rerun_events: 0, qc_events: 0 }]);
    expect(t(X2)).toEqual([{ test_id: TA, test_code: 'T19-TA', tests_counted: 7, rerun_events: 0, qc_events: 3 }]);
    for (const r of find(rows, { instrument_id: X1 })) expect(r.tests).toHaveLength(2); // the block is repeated on every row of the instrument
  });
  runT('instrument_id filter keeps only that instrument; the totals follow', async (s) => {
    const b = await body(s, 'analyser_consumption', { ...DC, instrument_id: X2 });
    expect(new Set(b.rows.map((r: any) => r.instrument_id))).toEqual(new Set([X2])); expect(b.rows).toHaveLength(2); expect(b.totals.value_consumed_paisa).toBe(2750);
  });
  runT('without cost.read: no *_paisa key, tests[] counts stay', async (s) => {
    const b = await body(s, 'analyser_consumption', DC, NO_COST);
    expect(deepKeys(b).filter((k) => COST_FIELD.test(k))).toEqual([]); expect(b.rows).toHaveLength(4); expect(b.rows[0].tests.length).toBeGreaterThan(0);
  });
});

// =============================================================================================================== AC-21.3 cost per test (PRD §8.3, TRD §8.6)
describe.skipIf(!live)('T-19 AC-21.3 cost_per_test: formulas per PRD §8.3 (N = 0, Ntot = 0, exact .5 rounding, reversal, fixed shared by three tests, instrument none, standard cost)', () => {
  const cpt = async (s: Sess, q: Record<string, unknown> = CPT, o: RepOpts = { analytes: { [C1]: [AN1] } }) => { const b = await body(s, 'cost_per_test', q, o); return b.rows as any[]; };
  const row = (rows: any[], test: string, inst: string | null) => rows.find((r) => r.test_id === test && nul(r.instrument_id) === inst);
  runT('C1 on XC1 (N = 2, D = 1001, F = 1001, Ntot = 6): cpt_direct 500.5 -> 501 (half up); fixed_share 333.67 -> 334; cpt_loaded 667.33 -> 667 (from the exact share, NOT 667.5 from the rounded one); breakdown by kind', async (s) => {
    const r = row(await cpt(s), C1, XC1);
    expect(r).toMatchObject({ test_code: 'T19-C1', test_name: 'Cost one', tests_counted: 2, direct_value_paisa: 1001, fixed_value_on_instrument_paisa: 1001, fixed_share_paisa: 334, cpt_direct_paisa: 501, cpt_loaded_paisa: 667 });
    expect(r.breakdown).toEqual({ consume_test: 700, consume_analyte: 0, consume_rerun: 301, consume_qc: 0, consume_calibration: 0 });
    expect(Object.keys(r.breakdown).sort()).toEqual([...BREAKDOWN_KEYS].sort());
  });
  runT('C2 (N = 1, D = 0 - counted, nothing consumed): cpt_direct 0, fixed_share 167 (166.83), cpt_loaded 167', async (s) => {
    expect(row(await cpt(s), C2, XC1)).toMatchObject({ tests_counted: 1, direct_value_paisa: 0, fixed_share_paisa: 167, cpt_direct_paisa: 0, cpt_loaded_paisa: 167 });
  });
  runT('C3 (N = 3, consumed 900 and a reversal of -300 the next day): D = 600, cpt_direct 200, fixed_share 500.5 -> 501 (the exact .5 rounds up), cpt_loaded 366.83 -> 367', async (s) => {
    const r = row(await cpt(s), C3, XC1);
    expect(r).toMatchObject({ tests_counted: 3, direct_value_paisa: 600, fixed_share_paisa: 501, cpt_direct_paisa: 200, cpt_loaded_paisa: 367 });
    expect(r.breakdown.consume_test).toBe(600);
  });
  runT('N = 0 (C4: 250 consumed, no test count): cpt_direct and cpt_loaded are null (or absent), fixed_share is 0, the consumption still shows', async (s) => {
    const r = row(await cpt(s), C4, XC1);
    expect(r).toMatchObject({ tests_counted: 0, direct_value_paisa: 250, fixed_share_paisa: 0 });
    expect(nul(r.cpt_direct_paisa)).toBeNull(); expect(nul(r.cpt_loaded_paisa)).toBeNull();
  });
  runT('Ntot = 0 (XC2: C5 consumed 300, fixed 800, no counts): fixed_share 0 (no division by zero), cpt values null', async (s) => {
    const r = row(await cpt(s), C5, XC2);
    expect(r).toMatchObject({ tests_counted: 0, direct_value_paisa: 300, fixed_value_on_instrument_paisa: 800, fixed_share_paisa: 0 });
    expect(nul(r.cpt_direct_paisa)).toBeNull(); expect(nul(r.cpt_loaded_paisa)).toBeNull();
  });
  runT('instrument "none" (C6: N = 4, D = 1000, no fixed consumption): instrument_id null / absent, cpt_direct 250, fixed_share 0, cpt_loaded 250', async (s) => {
    const r = row(await cpt(s), C6, null);
    expect(r).toMatchObject({ tests_counted: 4, direct_value_paisa: 1000, fixed_share_paisa: 0, cpt_direct_paisa: 250, cpt_loaded_paisa: 250 });
    expect(r.fixed_value_on_instrument_paisa ?? 0).toBe(0);
  });
  runT('exactly six (test, instrument) rows: the window decides (04-30 / 05-04 rows out); no other test appears', async (s) => {
    const rows = await cpt(s);
    expect(rows.map((r) => `${r.test_code}|${nul(r.instrument_id)}`).sort()).toEqual([`T19-C1|${XC1}`, `T19-C2|${XC1}`, `T19-C3|${XC1}`, `T19-C4|${XC1}`, `T19-C5|${XC2}`, `T19-C6|null`].sort());
  });
  runT('test_id / instrument_id filters narrow the rows but do NOT change Ntot: C1 alone still has fixed_share 334', async (s) => {
    const t1 = await cpt(s, { ...CPT, test_id: C1 });
    expect(t1).toHaveLength(1); expect(t1[0]).toMatchObject({ test_id: C1, fixed_share_paisa: 334, cpt_loaded_paisa: 667, tests_counted: 2 });
    const i2 = await cpt(s, { ...CPT, instrument_id: XC2 });
    expect(i2.map((r) => r.test_id)).toEqual([C5]);
  });
  runT('cpt_standard: per_test + per_analyte rules x avg cost of the instrument\'s binding store, rounded ONCE (5.4 + 5.4 = 10.8 -> 11, not 5 + 5); an item without cost makes the row incomplete', async (s) => {
    const rows = await cpt(s);
    const c1 = row(rows, C1, XC1);
    expect(c1.cpt_standard_paisa).toBe(11); expect(c1.standard_is_complete).toBe(true);
    expect(s.catalogCalls.map((c) => c.testId)).toContain(C1); // reportable analytes of the test come from CatalogPort.getTest
    expect(row(rows, C3, XC1).standard_is_complete).toBe(false);
    expect(row(rows, C3, XC1).missing_item_ids).toEqual([IS3]); // PRD 8.3: is_complete = false carries missing_item_ids[]
    expect(c1.missing_item_ids ?? []).toEqual([]);
  });
  runT('cpt_standard rule matching (TRD 5.8): an instrument-specific rule drops the generic rule of the same item (C2: 11, not 16); a future-dated rule is ignored (C4: 5, not 545)', async (s) => {
    const rows = await cpt(s);
    expect(row(rows, C2, XC1).cpt_standard_paisa).toBe(11);
    expect(row(rows, C4, XC1).cpt_standard_paisa).toBe(5);
  });
  runT('cpt_standard follows the reportable analytes of the catalogue test: with no analyte the per_analyte rule does not apply (5.4 -> 5)', async (s) => {
    const b = await s.get('cost_per_test', CPT, { analytes: { [C1]: [AN1] } });
    expect(row(b.body.rows, C1, XC1).cpt_standard_paisa).toBe(11);
    const none = await s.get('cost_per_test', CPT, { analytes: {} });
    expect(row(none.body.rows, C1, XC1).cpt_standard_paisa).toBe(5);
  });
  runT('money-only: without inventory.cost.read -> 403 auth.forbidden (no rows); every *_paisa column is flagged is_cost, the test / count columns are not', async (s) => {
    await forbidden(s.get('cost_per_test', CPT, READ_ONLY));
    const cols = (await body(s, 'cost_per_test')).columns as { key: string; is_cost: boolean }[];
    for (const c of cols.filter((x) => COST_FIELD.test(x.key))) expect(c.is_cost, c.key).toBe(true);
    for (const k of ['test_id', 'test_code', 'test_name', 'instrument_id', 'tests_counted']) expect(cols.find((c) => c.key === k)?.is_cost, k).toBe(false);
  });
});

// =============================================================================================================== AC-21.4 wastage
describe.skipIf(!live)('T-19 AC-21.4 wastage: recorded by reason, expiry write-offs, count variance (quantity and value)', () => {
  runT('golden rows per store x item x category: recorded:<reason> from the wastage movements, expiry_writeoff, count_variance = out 3 - in 1 (net 2 / 400)', async (s) => {
    const rows = await rowsOf(s, 'wastage', { ...WST, store_id: S1 });
    expect(rows).toHaveLength(4);
    const g = (it: string, cat: string, q: number, v: number) => { const r = one(rows, { item_id: it, category: cat }); expect(num(r.qty), cat).toBeCloseTo(q, 6); expect(r.value_paisa, cat).toBe(v); expect(r.item_code).toMatch(/^T19-I/); expect(r.store_id).toBe(S1); };
    g(I1, 'recorded:damaged', 2, 400); g(I1, 'recorded:spillage', 1, 200); g(I2, 'expiry_writeoff', 5, 750); g(I1, 'count_variance', 2, 400);
  });
  runT('window and visibility: 04-09 and 04-13 rows out; all stores adds the BR2 row; a BR1-only caller does not see it', async (s) => {
    const all = await rowsOf(s, 'wastage');
    expect(all).toHaveLength(5); expect(one(all, { store_id: S2 })).toMatchObject({ category: 'recorded:damaged', value_paisa: 900 });
    expect((await rowsOf(s, 'wastage', WST, BR1_ONLY)).some((r) => r.store_id === S2)).toBe(false);
    expect((await rowsOf(s, 'wastage', WST, BR2_ONLY)).map((r) => r.store_id)).toEqual([S2]);
  });
  runT('without cost.read the value_paisa column and key are gone, quantities stay', async (s) => {
    const b = await body(s, 'wastage', { ...WST, store_id: S1 }, NO_COST);
    expect(deepKeys(b).filter((k) => COST_FIELD.test(k))).toEqual([]); expect(b.rows).toHaveLength(4); expect(num(one(b.rows, { category: 'count_variance' }).qty)).toBeCloseTo(2, 6);
  });
});

// =============================================================================================================== AC-21.5 expiry
describe.skipIf(!live)('T-19 AC-21.5 expiry: lots expiring within N days or expired, with stock, by store (today = 2026-06-15)', () => {
  const lots = async (s: Sess, q: Record<string, unknown>, o?: RepOpts) => (await rowsOf(s, 'expiry', { store_id: S1, ...q }, o)).map((r) => r.lot_no).sort();
  runT('default within_days = settings.expiry_alert_days (30): expired lot (-3 d), +10 d and +20 d (quarantined); not +90 d, not qty 0, not a lot without expiry', async (s) => {
    expect(await lots(s, {})).toEqual(['+1', '-2', '=SUM(1+1)']);
    const rows = await rowsOf(s, 'expiry', { store_id: S1 });
    expect(one(rows, { lot_id: LEXP })).toMatchObject({ store_id: S1, item_id: E1, item_code: 'T19-E1', expiry_on: '2026-06-12', days_to_expiry: -3, value_paisa: 500, lot_status: 'available', has_open_container: false });
    expect(num(one(rows, { lot_id: LEXP }).qty_base)).toBeCloseTo(5, 6);
    expect(one(rows, { lot_id: LSOON })).toMatchObject({ days_to_expiry: 10, value_paisa: 400, has_open_container: true });
    expect(one(rows, { lot_id: LMID })).toMatchObject({ days_to_expiry: 20, lot_status: 'quarantined' });
  });
  runT('within_days narrows / widens (15: expired + 10 d; 25: + 20 d; 100: + 90 d)', async (s) => {
    expect(await lots(s, { within_days: 15 })).toEqual(['+1', '=SUM(1+1)']);
    expect(await lots(s, { within_days: 25 })).toEqual(['+1', '-2', '=SUM(1+1)']);
    expect(await lots(s, { within_days: 100 })).toEqual(["'far", '+1', '-2', '=SUM(1+1)']);
  });
  runT('stock is per store: the same lot in S2 is its own row, visible to BR2 only', async (s) => {
    const all = await rowsOf(s, 'expiry', { within_days: 15 });
    expect(find(all, { lot_id: LSOON }).map((r) => r.store_id).sort()).toEqual([S1, S2].sort());
    expect(find(await rowsOf(s, 'expiry', { within_days: 15 }, BR1_ONLY), { lot_id: LSOON }).map((r) => r.store_id)).toEqual([S1]);
  });
  runT('without cost.read value_paisa is gone', async (s) => {
    const b = await body(s, 'expiry', { store_id: S1 }, NO_COST);
    expect(deepKeys(b).filter((k) => COST_FIELD.test(k))).toEqual([]); expect(b.rows).toHaveLength(3);
  });
});

// =============================================================================================================== AC-21.6 stock valuation
describe.skipIf(!live)('T-19 AC-21.6 stock_valuation: store x item x lot, now and as_of recomputed from the ledger', () => {
  const val = async (s: Sess, q: Record<string, unknown>, o?: RepOpts) => (await rowsOf(s, 'stock_valuation', q, o)).filter((r) => [V1, V2].includes(r.item_id));
  runT('now: from stock_balances - lot row 3 / 1000 (avg 333.333333 paisa = 333333333 x1e6), unlotted row 4 / 410 (avg 102.5 = 102500000, no lot_id)', async (s) => {
    const rows = await val(s, { store_id: S1 });
    expect(rows).toHaveLength(2);
    const a = one(rows, { item_id: V1 }); expect(a).toMatchObject({ store_id: S1, lot_id: LV1, lot_no: 'T19-LV1', item_code: 'T19-V1', value_paisa: 1000, avg_unit_cost_paisa_x1e6: 333333333 }); expect(num(a.qty_base)).toBeCloseTo(3, 6);
    const b = one(rows, { item_id: V2 }); expect(b).toMatchObject({ value_paisa: 410, avg_unit_cost_paisa_x1e6: 102500000 }); expect(nul(b.lot_id)).toBeNull(); expect(num(b.qty_base)).toBeCloseTo(4, 6);
  });
  runT('as_of 2026-06-10: recomputed from stock_movements before it - the lot row was 9 / 3000 then (the consumption of 06-12 is not in), the unlotted receipt of 06-12 is not in either', async (s) => {
    const rows = await val(s, { store_id: S1, as_of: '2026-06-10' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ item_id: V1, lot_id: LV1, value_paisa: 3000, avg_unit_cost_paisa_x1e6: 333333333 }); expect(num(rows[0].qty_base)).toBeCloseTo(9, 6);
    expect(one(await val(s, { store_id: S2, as_of: '2026-06-10' }), { item_id: V1 })).toMatchObject({ value_paisa: 200, avg_unit_cost_paisa_x1e6: 100000000 });
  });
  runT('visibility and filters: BR1-only sees S1 only; item_id narrows', async (s) => {
    expect((await val(s, {}, BR1_ONLY)).every((r) => r.store_id === S1)).toBe(true);
    expect((await val(s, { item_id: V2 })).map((r) => r.store_id).sort()).toEqual([S1, S2].sort());
  });
  runT('without cost.read: quantities only (no value_paisa, no avg_unit_cost_paisa_x1e6)', async (s) => {
    const b = await body(s, 'stock_valuation', { store_id: S1, item_id: V1 }, NO_COST);
    expect(b.rows).toHaveLength(1); expect(deepKeys(b).filter((k) => COST_FIELD.test(k))).toEqual([]); expect(num(b.rows[0].qty_base)).toBeCloseTo(3, 6);
  });
});

// =============================================================================================================== AC-21.7 reconciliation
describe.skipIf(!live)('T-19 AC-21.7 consumption_reconciliation: test block (C12 vs lab view), instrument block (D-74), all-centres rule, no alerts', () => {
  const rec = async (s: Sess, o?: RepOpts) => (await rowsOf(s, 'consumption_reconciliation', REC, o));
  runT('test block: per (test, date) c12 = test_counts_daily summed over instruments, lab = lab.v_pub_result_daily; diff = c12 - lab; diff_bp = |diff| x 10000 / max(c12, lab); the outside days (06-30, 07-04) are out', async (s) => {
    const rows = (await rec(s)).filter((r) => r.test_id != null);
    const g = (t: string, d: string, c: number, l: number, diff: number, bp: number) => expect(one(rows, { test_id: t, business_date: d }), `${t} ${d}`).toMatchObject({ c12_verified_result_events: c, lab_results_verified: l, diff, diff_bp: bp });
    g(R1, '2026-07-01', 90, 100, -10, 1000); g(R2, '2026-07-02', 100, 99, 1, 100); g(R3, '2026-07-01', 0, 40, -40, 10000); g(R4, '2026-07-03', 25, 0, 25, 10000);
    expect(one(rows, { test_id: R1, business_date: '2026-07-01' }).test_code).toBe('T19-R1');
    expect(rows.some((r) => r.business_date === '2026-06-30' || r.business_date === '2026-07-04')).toBe(false);
  });
  runT('instrument block (D-74): instrument_qc_daily.qc_observations vs v_pub_message_daily.qc_records per (instrument, date); diff = c12 - records; listed, with the label', async (s) => {
    const rows = (await rec(s)).filter((r) => r.instrument_id != null && r.test_id == null);
    const g = (i: string, d: string, c: number, q: number, diff: number) => expect(one(rows, { instrument_id: i, business_date: d }), `${i} ${d}`).toMatchObject({ c12_qc_observations: c, instrument_qc_records: q, diff });
    g(XR1, '2026-07-01', 20, 17, 3); g(XR2, '2026-07-01', 7, 0, 7); g(XR3, '2026-07-03', 0, 4, -4);
    expect(Object.keys(one(rows, { instrument_id: XR1, business_date: '2026-07-01' }))).not.toContain('instrument_label'); // TRD 5.11: the reconciliation columns are fixed and do not list it
    const same = find(rows, { instrument_id: XR1, business_date: '2026-07-02' }); if (same.length) expect(same[0].diff).toBe(0);
  });
  runT('totals carry the unresolved / dismissed fact counts of the window (2 unresolved, 1 dismissed; 06-30 and 07-04 facts out)', async (s) => {
    const b = await body(s, 'consumption_reconciliation', REC);
    expect(b.totals).toMatchObject({ unresolved_facts: 2, dismissed_facts: 1 });
  });
  runT('the report only reads: no alert is raised for the 10000 bp gaps (the nightly scan does that, test block only), nothing is written', async (s) => {
    const before = await countAll(s);
    await rec(s); await rec(s);
    expect(await countAll(s)).toEqual(before);
    expect((await s.sql(A, `SELECT count(*)::int AS n FROM inventory.alerts WHERE tenant_id = $1 AND alert_kind = 'reconciliation_gap' AND (test_id = ANY($2::uuid[]) OR instrument_id = ANY($3::uuid[]))`, [A, [R1, R2, R3, R4], [XR1, XR2, XR3]]))[0].n).toBe(0);
  });
  runT('needs all centres: a caller scoped to BR1 (all = false) gets 403 auth.forbidden even though BR1 holds the data; the same rule on the CSV', async (s) => {
    await forbidden(s.get('consumption_reconciliation', REC, BR1_ONLY));
    await forbidden(s.csv('consumption_reconciliation', REC, BR1_ONLY));
    expect(s.audit).toEqual([]);
    expect((await s.get('consumption_reconciliation', REC, { all: true })).status).toBe(200);
  });
});

// =============================================================================================================== scope, tenants, validation that needs rows (P-B6)
describe.skipIf(!live)('T-19 scope (P-B6): store_id / branch_id outside the caller scope -> 404, visible branches only, tenant isolation', () => {
  runT('a store of a branch the caller cannot see -> 404 common.not_found (not 403, not an empty list); an unknown store and a store of tenant B too; same on the CSV', async (s) => {
    for (const code of ['daily_consumption', 'wastage', 'expiry', 'stock_valuation']) {
      await nf(s.get(code, { ...QUERY[code], store_id: S2 }, BR1_ONLY)); await nf(s.get(code, { ...QUERY[code], store_id: OTHER })); await nf(s.get(code, { ...QUERY[code], store_id: STORE_B }));
    }
    await nf(s.csv('daily_consumption', { ...DC, store_id: S2 }, BR1_ONLY)); await nf(s.csv('daily_consumption', { ...DC, store_id: OTHER }));
    expect(s.audit).toEqual([]);
  });
  runT('branch_id outside the scope -> 404; inside -> its stores only', async (s) => {
    await nf(s.get('daily_consumption', { ...DC, branch_id: BR2 }, BR1_ONLY)); await nf(s.get('daily_consumption', { ...DC, branch_id: OTHER }));
    expect((await rowsOf(s, 'daily_consumption', { ...DC, branch_id: BR1 }, BR1_ONLY)).every((r) => r.store_id === S1)).toBe(true);
  });
  runT('without a store filter the report aggregates only the visible branches (BR1-only: S1 rows and totals; BR2-only: the S2 row)', async (s) => {
    const b1 = await body(s, 'daily_consumption', DC, BR1_ONLY); expect(b1.rows).toHaveLength(5); expect(b1.totals.value_consumed_paisa).toBe(7950);
    const b2 = await body(s, 'daily_consumption', DC, BR2_ONLY); expect(b2.rows).toHaveLength(1); expect(b2.rows[0]).toMatchObject({ store_id: S2, value_consumed_paisa: 900 }); expect(b2.totals.value_consumed_paisa).toBe(900);
  });
  runT('tenant isolation: tenant B sees only its own row (5555), never tenant A data, and tenant A never sees B\'s row', async (s) => {
    const b = await body(s, 'daily_consumption', DC, { branchIds: [BR_B] }, B);
    expect(b.rows).toHaveLength(1); expect(b.rows[0]).toMatchObject({ store_id: STORE_B, item_id: ITEM_B, value_consumed_paisa: 5555 });
    await nf(s.get('daily_consumption', { ...DC, store_id: S1 }, {}, B));
    expect(JSON.stringify(await rowsOf(s, 'daily_consumption'))).not.toContain(STORE_B);
  });
  runT('a request that selects a validation failure or a range failure writes nothing and reads no rows (nothing logged)', async (s) => {
    await expectLims(s.get('daily_consumption', { ...DC, within_days: 0 }), 'common.validation_failed', 400);
    await expectLims(s.csv('daily_consumption', win('2026-01-01', '2027-01-03')), 'inventory.range_too_large', 422);
    expect(s.audit).toEqual([]);
  });
});

// =============================================================================================================== AC-21.8 export
describe.skipIf(!live)('T-19 AC-21.8 exportInventoryReport: CSV content, P-9 neutralisation, access log, caps, permissions', () => {
  runT('200 text/csv attachment: no-store, nosniff, plain .csv name, UTF-8 BOM, CRLF; header = columns[].key of #92 for the same caller; one record per row; numbers as plain text', async (s) => {
    const r = await s.csv('daily_consumption', DC);
    expect(r.status).toBe(200);
    expect(headerOf(r, 'content-type') ?? '').toMatch(/^text\/csv/i);
    expect(headerOf(r, 'content-disposition') ?? '').toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.csv"$/);
    expect(headerOf(r, 'cache-control')).toBe('no-store'); expect(headerOf(r, 'x-content-type-options')).toBe('nosniff');
    const text = bodyText(r.body);
    expect(text.charCodeAt(0)).toBe(0xfeff); expect(text.replace(/\r\n/g, '').includes('\n')).toBe(false); expect(text.endsWith('\r\n')).toBe(true);
    const json = await body(s, 'daily_consumption');
    const { header, rows } = csvObjects(text);
    expect(header).toEqual(json.columns.map((c: any) => c.key)); expect(rows).toHaveLength(json.rows.length);
    const golden = rows.find((x) => x['business_date'] === '2026-03-02' && x['movement_kind'] === 'consume_test') as Record<string, string>;
    expect(num(golden['qty_consumed'])).toBeCloseTo(10, 6); expect(golden['value_consumed_paisa']).toBe('5000'); expect(golden['movements']).toBe('4'); expect(golden['store_code']).toBe('T19-S1');
  });
  runT('TRD 5.11 columns are fixed: wastage / expiry / stock_valuation carry no store_code, reconciliation no instrument_label (JSON columns and CSV header)', async (s) => {
    for (const [code, col] of [['wastage', 'store_code'], ['expiry', 'store_code'], ['stock_valuation', 'store_code'], ['consumption_reconciliation', 'instrument_label']] as const) {
      const b = await body(s, code, QUERY[code]);
      expect(b.columns.map((c: any) => c.key), code).not.toContain(col);
      expect(b.rows.flatMap((r: any) => Object.keys(r)), code).not.toContain(col);
    }
  });
  runT('P-9: every text cell passes neutraliseFormula (item name =HYPERLINK / +1+1, lot numbers = + - \' , instrument label @) - nothing starts with = + - @ TAB CR unless it is a plain negative number; negative numbers are NOT prefixed', async (s) => {
    const daily = await table(s, 'daily_consumption');
    const cells = daily.rows.flatMap((r) => Object.values(r));
    expect(cells.filter((c) => /^[=+\-@\t\r]/.test(c) && !isNum(c))).toEqual([]);
    expect(cells).toEqual(expect.arrayContaining(['\'=HYPERLINK("http://x.example","go")', "'+1+1 plus"]));
    const neg = daily.rows.find((r) => r['business_date'] === '2026-03-04' && r['movement_kind'] === 'consume_test') as Record<string, string>;
    expect(neg['value_consumed_paisa']).toBe('-800'); expect(num(neg['qty_consumed'])).toBeCloseTo(-2, 6); expect(neg['qty_consumed'].startsWith("'")).toBe(false);
    const exp = await table(s, 'expiry', { store_id: S1, within_days: 100 });
    expect(exp.rows.map((r) => r['lot_no']).sort()).toEqual(["''far", "'+1", "'-2", "'=SUM(1+1)"]);
    const an = await table(s, 'analyser_consumption');
    expect(an.rows.map((r) => r['instrument_label'])).toContain("'@SUM(A1) analyser");
    for (const code of REPORTS) { const t = await table(s, code, QUERY[code]); expect(t.rows.flatMap((r) => Object.values(r)).filter((c) => /^[=+\-@\t\r]/.test(c) && !isNum(c)), code).toEqual([]); }
  });
  runT('every report exports: header = columns, one record per row (the same rows as #92), BOM, attachment', async (s) => {
    for (const code of REPORTS) {
      const json = await body(s, code); const r = await s.csv(code, QUERY[code]);
      expect(r.status, code).toBe(200); expect(bodyText(r.body).charCodeAt(0)).toBe(0xfeff);
      const recs = parseCsv(bodyText(r.body));
      expect(recs[0], code).toEqual(json.columns.map((c: any) => c.key)); expect(recs.length - 1, code).toBe(json.rows.length);
      expect(json.rows.length, `${code} has golden rows`).toBeGreaterThan(0);
    }
  });
  runT('§5.10 access log: exactly one ctx.audit.access({ action: data.export, entityType: inventory_report, outcome: allowed }) per success; detail has primitives only and never a cell value; none on any refusal', async (s) => {
    await s.csv('daily_consumption', DC);
    expect(s.audit).toHaveLength(1);
    expect(s.audit[0]).toMatchObject({ action: 'data.export', entityType: 'inventory_report', outcome: 'allowed' });
    for (const v of Object.values(s.audit[0].detail ?? {})) expect(['string', 'number', 'boolean']).toContain(typeof v);
    expect(JSON.stringify(s.audit[0])).not.toMatch(/HYPERLINK/);
    expect(JSON.stringify(s.audit[0])).toContain('daily_consumption');
    const n = s.audit.length;
    await rej(s.csv('daily_consumption', { ...DC, tenant_id: A })); await forbidden(s.csv('daily_consumption', DC, READER)); await forbidden(s.csv('cost_per_test', CPT, NO_COST));
    await expectLims(s.csv('daily_consumption', DC, { aal: 'aal1' }), 'auth.mfa_required', 403); await nf(s.csv('daily_consumption', { ...DC, store_id: OTHER })); await expectLims(s.csv('daily_consumption', win('2026-01-01', '2027-01-03')), 'inventory.range_too_large', 422);
    expect(s.audit).toHaveLength(n);
    await s.csv('expiry', { store_id: S1 }); await s.csv('stock_valuation', { store_id: S1 }); expect(s.audit).toHaveLength(n + 2);
  });
  runT('an empty window still answers 200 with the header row only, and logs the export', async (s) => {
    const { header, rows } = await table(s, 'daily_consumption', win('2025-01-01', '2025-02-01'));
    expect(rows).toEqual([]); expect(header).toContain('qty_consumed'); expect(s.audit).toHaveLength(1);
  });
  runT('row cap: more than LIMS_INVENTORY_EXPORT_MAX_ROWS rows -> 422 inventory.export_too_large, no body, nothing logged; exactly the cap is fine (the screen cap does not apply to the export)', async (s) => {
    await withEnv({ LIMS_INVENTORY_EXPORT_MAX_ROWS: '5' }, async () => { await expectLims(s.csv('daily_consumption', DC), 'inventory.export_too_large', 422); expect(s.audit).toEqual([]); });
    await withEnv({ LIMS_INVENTORY_EXPORT_MAX_ROWS: '6', LIMS_INVENTORY_REPORT_SCREEN_ROWS: '2' }, async () => { const t = await table(s, 'daily_consumption'); expect(t.rows).toHaveLength(6); expect(s.audit).toHaveLength(1); });
  });
  runT('the range cap is the same 366 days: exactly 366 days exports, 367 does not', async (s) => {
    expect((await s.csv('daily_consumption', win('2026-01-01', '2027-01-02'))).status).toBe(200);
    await expectLims(s.csv('daily_consumption', win('2026-01-01', '2027-01-03')), 'inventory.range_too_large', 422);
  });
  runT('permissions (PE-1 / PE-3): report.export is always asserted (no branchId) and a cost-less exporter gets the same file without the money columns; cost_per_test needs cost.read too', async (s) => {
    const full = await table(s, 'daily_consumption'); const bare = await table(s, 'daily_consumption', DC, NO_COST);
    expect(full.header).toContain('value_consumed_paisa'); expect(bare.header.filter((h) => COST_FIELD.test(h))).toEqual([]); expect(bare.rows).toHaveLength(full.rows.length);
    expect(s.roleCalls.map((c) => c.permission)).toContain(EXPORT);
    expect((await s.csv('cost_per_test', CPT)).status).toBe(200);
    const money = (await table(s, 'cost_per_test')).header; expect(money).toContain('cpt_direct_paisa');
  });
});

// =============================================================================================================== AC-21.9, screen cap, concurrency
describe.skipIf(!live)('T-19 AC-21.9 / row caps / many users at once', () => {
  runT('a user without inventory.cost.read: no money key at any depth of any report (columns, rows, totals); the row sets equal the cost caller\'s', async (s) => {
    for (const code of REPORTS.filter((c) => c !== 'cost_per_test')) {
      const full = await body(s, code); const bare = await body(s, code, QUERY[code], NO_COST);
      expect(deepKeys(bare).filter((k) => COST_FIELD.test(k)), code).toEqual([]);
      expect(bare.columns.some((c: any) => c.is_cost), code).toBe(false); expect(bare.rows.length, code).toBe(full.rows.length);
      expect(bare.columns.map((c: any) => c.key), code).toEqual(full.columns.filter((c: any) => !c.is_cost).map((c: any) => c.key));
    }
    await forbidden(s.get('cost_per_test', CPT, NO_COST));
  });
  runT('screen cap: more rows than LIMS_INVENTORY_REPORT_SCREEN_ROWS -> rows cut to the cap and truncated = true; exactly the cap -> truncated = false', async (s) => {
    await withEnv({ LIMS_INVENTORY_REPORT_SCREEN_ROWS: '6' }, async () => { const b = await body(s, 'daily_consumption'); expect(b.rows).toHaveLength(6); expect(b.truncated).toBe(false); });
    await withEnv({ LIMS_INVENTORY_REPORT_SCREEN_ROWS: '4' }, async () => { const b = await body(s, 'daily_consumption'); expect(b.rows).toHaveLength(4); expect(b.truncated).toBe(true); });
  });
  it('many users at once: eight parallel sessions with different scopes get exactly the golden results (no shared state, no cross-talk)', async () => {
    const one1 = async (k: number) => session(async (s) => {
      const o = k % 2 === 0 ? undefined : BR1_ONLY;
      const d = await body(s, 'daily_consumption', DC, o); const c = await body(s, 'cost_per_test', CPT, o); const r = await body(s, 'consumption_reconciliation', REC);
      return { d: d.totals.value_consumed_paisa, dr: d.rows.length, c1: c.rows.find((x: any) => x.test_id === C1).cpt_loaded_paisa, rr: r.rows.length };
    });
    const out = await Promise.all(Array.from({ length: 8 }, (_, k) => one1(k)));
    out.forEach((x, k) => { expect(x.d).toBe(k % 2 === 0 ? 8850 : 7950); expect(x.dr).toBe(k % 2 === 0 ? 6 : 5); expect(x.c1).toBe(667); expect(x.rr).toBe(out[0]!.rr); });
  });
});
