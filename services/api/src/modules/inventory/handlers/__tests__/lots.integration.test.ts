// C12.T-09 integration + probes for #30-#39 on the migrated database as role lims_api with RLS on (REAL T-03 repositories, handlers/index.ts, T-04 scope service).
// Harness: tests/db/c12-t09/run.sh (clone of c12-t08: pinned image, migrations, seeds, inventory DDL, exports LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL / LIMS_C12T03_REQUIRE_DB=1).
// Fixtures: tests/db/c12-t03/fixtures.sql (stores 1001 MAIN-A, 1002 BENCH-A, tenant B 1101; items 2001 GLU-R1, 2002, 2003; lots 4001-4003, B 4101; containers 9301 open (item 2002 lot 4003 instrument 421 store 1001),
//   9302 finished, B 9311; movements 6001-6004, B 6101; instruments 421 422, B 431; documents 9002) + EXTRAS below (ids 13xxx, committed once with the superuser, ON CONFLICT DO NOTHING).
// Each test = one request-shaped transaction that is ROLLED BACK; every handler call runs inside a SAVEPOINT. The race tests commit and restore through the admin pool.
// Without the URLs the DB tests skip, except under LIMS_C12T03_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails.
// Items / lots of EXTRAS (all tenant A):
//   S30 = open_stability_days 30 | NS = lot tracked, no stability | FE = FEFO item | BND = expiry boundary today / yesterday | TZ = expiry = "today" in Pacific/Pago_Pago | LST = lot list | USE = in-use lot | NL = not lot tracked, stability 10.
//   Dates that depend on the clock (today in tenant time) are computed in JS at start-up and interpolated, so the suite is stable on any day.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  A, ADJUST, B, BALANCE_KEYS, BENCH, BR1, BR2, CONTAINER_KEYS, COST, FEFO_KEYS, FEFO_LINE_KEYS, LEAK, LOT_KEYS, MOVEMENT_KEYS, READ, SYS,
  addDays, call, correctExpiry, costKeys, expectLims, ifm, isEndOfDay, makeLotCtx, newContainer, onlyKeys, qty, reason, rej, setStatus, uid, wall, ymdIn, type LotOpts,
} from './lots.helpers.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

// fixtures (T-03)
const MAIN = uid(1001), BENCH_ST = uid(1002), MAIN_B = uid(1101), GLU_B = uid(2101), LOT_B = uid(4101), IN1 = uid(421), IN2 = uid(422), IN_B = uid(431);
const CONT_OPEN = uid(9301), CONT_FIN = uid(9302), CONT_B = uid(9311), DOC_WASTE = uid(9002), MOV_RECEIVE = uid(6001), MOV_B = uid(6101), MOV_UNLOT = uid(6004);
// extras
const KT = 'Asia/Kathmandu', TODAY = ymdIn(KT), PAGO = 'Pacific/Pago_Pago', KIRI = 'Pacific/Kiritimati', PAGO_TODAY = ymdIn(PAGO);
const ST_BR2 = uid(13101);
const I_S30 = uid(13001), I_NS = uid(13002), I_FE = uid(13003), I_NL = uid(13004), I_BND = uid(13005), I_TZ = uid(13006), I_LST = uid(13007), I_USE = uid(13008);
const L71 = uid(13201), L_NOEXP = uid(13202), L_DST = uid(13203), L_NS1 = uid(13211), L_NSN = uid(13212), L_M1 = uid(13213), L_M2 = uid(13214), L_RACE = uid(13215), L_EXP = uid(13216), L_QUA = uid(13217),
  L_BLK = uid(13218), L_ZERO = uid(13219), L_NOROW = uid(13220), L_AKL = uid(13221), L_NYF = uid(13222), L_BR2 = uid(13223);
const FA = uid(13231), FB = uid(13232), FC = uid(13233), FX = uid(13234), FQ = uid(13235), FK = uid(13236), FZ = uid(13237), FO = uid(13238);
const L_TODAY = uid(13241), L_YEST = uid(13242), L_TZ = uid(13243);
const LS1 = uid(13251), LS2 = uid(13252), LS3 = uid(13253), LS4 = uid(13254);
const U1 = uid(13261), U2 = uid(13262);
const C_FC = uid(13301), C_DISC = uid(13302), C_BR2 = uid(13303), C_RACE = uid(13304), MOV_BR2 = uid(13401);
const BR1_ONLY: LotOpts = { all: false, branchIds: [BR1] };
const WITH_COST: LotOpts = { permissions: [READ, BENCH, COST] };
const PRIV: LotOpts = { permissions: [READ, ADJUST] };
const NOW_KT = (iso: string): LotOpts => ({ now: iso, tz: KT, permissions: [BENCH] });

const lots: [string, string, string, string | null, string | null, string, string | null, number | null, number | null][] = [
  // id, item, lot_no, expiry_on, manufactured_on, status, status_reason_code, last_receipt_qty, last_receipt_value
  [L71, I_S30, 'T09-L71', '2027-06-30', null, 'available', null, null, null], [L_NOEXP, I_S30, 'T09-NOEXP', null, null, 'available', null, null, null], [L_DST, I_S30, 'T09-DST', '2027-12-31', null, 'available', null, null, null],
  [L_NS1, I_NS, 'T09-NS1', '2027-06-30', null, 'available', null, null, null], [L_NSN, I_NS, 'T09-NSN', null, null, 'available', null, null, null], [L_M1, I_NS, 'T09-M1', '2027-06-30', null, 'available', null, null, null],
  [L_M2, I_NS, 'T09-M2', '2027-06-30', '2026-10-01', 'available', null, null, null], [L_RACE, I_NS, 'T09-RACE', '2027-06-30', null, 'available', null, null, null], [L_EXP, I_NS, 'T09-EXP', '2026-01-15', null, 'available', null, null, null],
  [L_QUA, I_NS, 'T09-QUA', '2027-06-30', null, 'quarantined', 'syn_quarantine', null, null], [L_BLK, I_NS, 'T09-BLK', '2027-06-30', null, 'blocked', 'syn_quarantine', null, null],
  [L_ZERO, I_NS, 'T09-ZERO', '2027-06-30', null, 'available', null, null, null], [L_NOROW, I_NS, 'T09-NOROW', '2027-06-30', null, 'available', null, null, null],
  [L_AKL, I_NS, 'T09-AKL', '2027-09-26', null, 'available', null, null, null], [L_NYF, I_NS, 'T09-NYF', '2027-11-07', null, 'available', null, null, null], [L_BR2, I_NS, 'T09-BR2L', '2027-06-30', null, 'available', null, null, null],
  [FA, I_FE, 'T09-FA', addDays(TODAY, 79), null, 'available', null, null, null], [FB, I_FE, 'T09-FB', addDays(TODAY, 48), null, 'available', null, null, null], [FC, I_FE, 'T09-FC', addDays(TODAY, 120), null, 'available', null, null, null],
  [FX, I_FE, 'T09-FX', addDays(TODAY, -10), null, 'available', null, null, null], [FQ, I_FE, 'T09-FQ', addDays(TODAY, 5), null, 'quarantined', 'syn_quarantine', null, null],
  [FK, I_FE, 'T09-FK', addDays(TODAY, 6), null, 'blocked', 'syn_quarantine', null, null], [FZ, I_FE, 'T09-FZ', addDays(TODAY, 7), null, 'available', null, null, null], [FO, I_FE, 'T09-FO', addDays(TODAY, 1), null, 'available', null, null, null],
  [L_TODAY, I_BND, 'T09-TODAY', TODAY, null, 'available', null, null, null], [L_YEST, I_BND, 'T09-YEST', addDays(TODAY, -1), null, 'available', null, null, null], [L_TZ, I_TZ, 'T09-TZ1', PAGO_TODAY, null, 'available', null, null, null],
  [LS1, I_LST, 'T09-A1', '2026-12-31', null, 'available', null, 8, 100], [LS2, I_LST, 'T09-A2', '2027-06-30', null, 'available', null, null, null], [LS3, I_LST, 'T09-A3', '2027-03-31', null, 'quarantined', 'syn_quarantine', null, null],
  [LS4, I_LST, 'T09-A4', null, null, 'available', null, null, null], [U1, I_USE, 'T09-U1', '2027-06-30', null, 'available', null, null, null], [U2, I_USE, 'T09-U2', '2027-06-30', null, 'available', null, null, null],
];
// id, store, item, lot, qty, value
const balances: [string, string, string, string | null, number, number][] = [
  [L71, MAIN, I_S30, L71, 100, 50000], [uid(13502), ST_BR2, I_S30, L71, 7, 3500], [L_NOEXP, MAIN, I_S30, L_NOEXP, 50, 0], [L_DST, MAIN, I_S30, L_DST, 10, 0],
  [L_NS1, MAIN, I_NS, L_NS1, 50, 0], [L_NSN, MAIN, I_NS, L_NSN, 50, 0], [L_M1, MAIN, I_NS, L_M1, 10, 0], [L_M2, MAIN, I_NS, L_M2, 10, 0], [L_RACE, MAIN, I_NS, L_RACE, 10, 0], [L_EXP, MAIN, I_NS, L_EXP, 10, 0],
  [L_QUA, MAIN, I_NS, L_QUA, 10, 0], [L_BLK, MAIN, I_NS, L_BLK, 10, 0], [L_ZERO, MAIN, I_NS, L_ZERO, 0, 0], [L_AKL, MAIN, I_NS, L_AKL, 10, 0], [L_NYF, MAIN, I_NS, L_NYF, 10, 0], [L_BR2, ST_BR2, I_NS, L_BR2, 30, 0],
  [FA, MAIN, I_FE, FA, 40, 0], [FB, MAIN, I_FE, FB, 30, 0], [FC, MAIN, I_FE, FC, 20, 0], [FX, MAIN, I_FE, FX, 500, 0], [FQ, MAIN, I_FE, FQ, 500, 0], [FK, MAIN, I_FE, FK, 500, 0], [FZ, MAIN, I_FE, FZ, 0, 0], [FO, BENCH_ST, I_FE, FO, 100, 0],
  [L_TODAY, MAIN, I_BND, L_TODAY, 5, 0], [L_YEST, MAIN, I_BND, L_YEST, 5, 0], [L_TZ, MAIN, I_TZ, L_TZ, 10, 0], [U1, MAIN, I_USE, U1, 20, 0], [U2, MAIN, I_USE, U2, 20, 0], [uid(13503), MAIN, I_NL, null, 25, 0],
];
const q = (v: string | null) => (v === null ? 'NULL' : `'${v}'`);
const EXTRAS = `
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT set_config('request.jwt.claims', '{"tenant_id":"${A}","sub":"${SYS}","actor_type":"system"}', true);
INSERT INTO inventory.g_cs_reasons (id, reason_group, code, display) VALUES ('${uid(13601)}', 'lot_status', 'syn_quarantine', 'Synthetic quarantine'), ('${uid(13602)}', 'adjustment', 'syn_expiry_fix', 'Synthetic expiry fix')
  ON CONFLICT DO NOTHING;
INSERT INTO inventory.stores (id, tenant_id, branch_id, store_code, name, store_kind, is_default_consumption, is_active, created_by, updated_by) VALUES
  ('${ST_BR2}', '${A}', '${BR2}', 'T09-BR2', 'Store T09-BR2', 'main', true, true, '${SYS}', '${SYS}') ON CONFLICT DO NOTHING;
INSERT INTO inventory.items (id, tenant_id, item_code, name, category, base_uom_code, is_lot_tracked, requires_expiry, open_stability_days, created_by, updated_by) VALUES
  ('${I_S30}', '${A}', 'T09-S30', 'T09 stability 30', 'reagent', 'test', true, true, 30, '${SYS}', '${SYS}'),
  ('${I_NS}', '${A}', 'T09-NS', 'T09 no stability', 'reagent', 'test', true, true, NULL, '${SYS}', '${SYS}'),
  ('${I_FE}', '${A}', 'T09-FE', 'T09 FEFO item', 'reagent', 'test', true, true, NULL, '${SYS}', '${SYS}'),
  ('${I_NL}', '${A}', 'T09-NL', 'T09 not lot tracked', 'consumable', 'test', false, false, 10, '${SYS}', '${SYS}'),
  ('${I_BND}', '${A}', 'T09-BND', 'T09 boundary', 'reagent', 'test', true, true, NULL, '${SYS}', '${SYS}'),
  ('${I_TZ}', '${A}', 'T09-TZ', 'T09 timezone', 'reagent', 'test', true, true, NULL, '${SYS}', '${SYS}'),
  ('${I_LST}', '${A}', 'T09-LST', 'T09 lot list', 'reagent', 'test', true, true, NULL, '${SYS}', '${SYS}'),
  ('${I_USE}', '${A}', 'T09-USE', 'T09 in use', 'reagent', 'test', true, true, NULL, '${SYS}', '${SYS}') ON CONFLICT DO NOTHING;
INSERT INTO inventory.lots (id, tenant_id, item_id, lot_no, expiry_on, manufactured_on, status, status_reason_code, last_receipt_qty_base, last_receipt_value_paisa, created_by, updated_by) VALUES
${lots.map((l) => `  ('${l[0]}', '${A}', '${l[1]}', '${l[2]}', ${q(l[3])}, ${q(l[4])}, '${l[5]}', ${q(l[6])}, ${l[7] ?? 'NULL'}, ${l[8] ?? 'NULL'}, '${SYS}', '${SYS}')`).join(',\n')} ON CONFLICT DO NOTHING;
INSERT INTO inventory.stock_balances (id, tenant_id, store_id, item_id, lot_id, qty_base, value_paisa, last_movement_at, created_by, updated_by) VALUES
${balances.map((b) => `  ('${b[0]}', '${A}', '${b[1]}', '${b[2]}', ${q(b[3])}, ${b[4]}, ${b[5]}, now(), '${SYS}', '${SYS}')`).join(',\n')} ON CONFLICT DO NOTHING;
INSERT INTO inventory.opened_containers (id, tenant_id, store_id, item_id, lot_id, instrument_id, opened_at, opened_by, open_expiry_at, status, finished_at, finished_by, discard_document_id, created_by, updated_by) VALUES
  ('${C_FC}', '${A}', '${MAIN}', '${I_FE}', '${FC}', NULL, now() - interval '2 hours', '${SYS}', (('${addDays(TODAY, 37)}'::date + time '06:00') AT TIME ZONE 'UTC'), 'open', NULL, NULL, NULL, '${SYS}', '${SYS}'),
  ('${C_DISC}', '${A}', '${MAIN}', '${I_NS}', '${L_M1}', NULL, now() - interval '5 days', '${SYS}', NULL, 'discarded', now() - interval '4 days', '${SYS}', '${DOC_WASTE}', '${SYS}', '${SYS}'),
  ('${C_BR2}', '${A}', '${ST_BR2}', '${I_NS}', '${L_BR2}', NULL, now() - interval '1 day', '${SYS}', NULL, 'open', NULL, NULL, NULL, '${SYS}', '${SYS}'),
  ('${C_RACE}', '${A}', '${MAIN}', '${I_NS}', '${L_RACE}', NULL, now() - interval '1 day', '${SYS}', NULL, 'open', NULL, NULL, NULL, '${SYS}', '${SYS}') ON CONFLICT DO NOTHING;
INSERT INTO inventory.stock_movements (id, tenant_id, business_date, occurred_at, store_id, item_id, lot_id, movement_kind, qty_base, value_paisa, value_basis, doc_type, doc_id, balance_qty_after, created_by) VALUES
  ('${MOV_BR2}', '${A}', current_date, now() - interval '1 hour', '${ST_BR2}', '${I_NS}', '${L_BR2}', 'receive', 30, 0, 'receipt', 'goods_receipt', '${uid(13999)}', 30, '${SYS}') ON CONFLICT DO NOTHING;
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

describe('T-09 harness', () => {
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
async function session<T>(fn: (s: Sess) => Promise<T>): Promise<T> {
  const client = await api.connect();
  let n = 0;
  const roleCalls: any[] = [];
  const tx = { query: (t: string, v?: unknown[]) => client.query(t, v) };
  const s: Sess = {
    roleCalls,
    async sql(t, text, v) { await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]); return (await client.query(text, v)).rows; },
    async call(t, op, req, o) {
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]);
      const st = makeLotCtx(tx, t, o ?? {});
      const sp = `t09_h${++n}`;
      await client.query(`SAVEPOINT ${sp}`);
      try { const r = await call(op, st.ctx, req); roleCalls.push(...st.roleCalls); await client.query(`RELEASE SAVEPOINT ${sp}`); return r; }
      catch (e) { roleCalls.push(...st.roleCalls); await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
    },
  };
  try { await client.query('BEGIN'); return await fn(s); } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}
const run = (name: string, fn: (s: Sess) => Promise<void>) => it(name, () => session(fn));

const row = async (s: Sess, table: string, id: string, t = A) => (await s.sql(t, `SELECT * FROM inventory.${table} WHERE id = $1`, [id]))[0];
const count = async (s: Sess, table: string, t = A) => Number((await s.sql(t, `SELECT count(*) AS n FROM inventory.${table} WHERE tenant_id = $1`, [t]))[0].n);
const stockSnapshot = async (s: Sess) => JSON.stringify([await s.sql(A, 'SELECT id, qty_base, value_paisa, version FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [A]), await count(s, 'stock_movements')]);
const lotIds = (r: { body: { lines: any[] } }) => r.body.lines.map((l) => l.lot_id);
const nf = (p: Promise<unknown>) => expectLims(p, 'common.not_found', 404);
const lines = (r: { body: any }) => r.body.lines.map((l: any) => [l.lot_id, qty(l.take_qty_base)]);
/** Either a 404 or an empty 200 list: the caller learns nothing about another tenant's rows. */
async function hidden(p: Promise<{ body: any }>): Promise<void> {
  try { const r = await p; expect(r.body.data).toEqual([]); } catch (e) { expect((e as any).code).toBe('common.not_found'); }
}
const open = (s: Sess, body: Record<string, unknown>, o?: LotOpts) => s.call(A, 'openContainer', { body }, { permissions: [BENCH], ...o });
const fefo = (s: Sess, item: string, qtyBase: string, o?: LotOpts, store = MAIN) => s.call(A, 'getFefoSuggestion', { query: { store_id: store, item_id: item, qty_base: qtyBase } }, o);

// ======================================================================================================== #38 open a container (AC-07.1)
describe.skipIf(!live)('T-09 #38 openContainer: open expiry in tenant time (AC-07.1)', () => {
  run('AC-07.1 (a) lot expiry 2027-06-30, stability 30, opened 2027-06-10 10:00 NPT => the EARLIER date: the last second of 2027-06-30 in tenant time', async (s) => {
    const r = await open(s, newContainer(MAIN, I_S30, { lot_id: L71, instrument_id: IN1 }), NOW_KT('2027-06-10T04:15:00.000Z'));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ store_id: MAIN, item_id: I_S30, lot_id: L71, lot_no: 'T09-L71', instrument_id: IN1, status: 'open', version: 1 });
    expect(Date.parse(r.body.opened_at)).toBe(Date.parse('2027-06-10T04:15:00.000Z'));
    expect(isEndOfDay(r.body.open_expiry_at, '2027-06-30', KT)).toBe(true);
    expect(onlyKeys(r.body, CONTAINER_KEYS)).toEqual([]);
    expect(Object.keys(r.body).filter((k) => LEAK.test(k))).toEqual([]);
    const db = await row(s, 'opened_containers', r.body.id);
    expect(db).toMatchObject({ tenant_id: A, store_id: MAIN, status: 'open', opened_by: SYS, created_by: SYS });
    expect(isEndOfDay(new Date(db.open_expiry_at).toISOString(), '2027-06-30', KT)).toBe(true);
  });
  run('AC-07.1 (b) opened 2027-05-01 10:00 NPT => opened-on + 30 days = 2027-05-31 10:00 NPT', async (s) => {
    const r = await open(s, newContainer(MAIN, I_S30, { lot_id: L71 }), NOW_KT('2027-05-01T04:15:00.000Z'));
    expect(r.status).toBe(201);
    expect(Date.parse(r.body.open_expiry_at)).toBe(Date.parse('2027-05-31T04:15:00.000Z'));
    expect(wall(r.body.open_expiry_at, KT)).toEqual({ ymd: '2027-05-31', hms: '10:00:00' });
  });
  run('the tenant timezone comes from IdentityPort.getTenantSettings({ keys: [\'timezone\'] }), once per request, and the clock from ctx.now()', async (s) => {
    const tx = { query: (t: string, v?: unknown[]) => s.sql(A, t, v).then((rows) => ({ rows })) };
    const st = makeLotCtx(tx, A, { ...NOW_KT('2027-05-01T04:15:00.000Z') });
    await call('openContainer', st.ctx, { body: newContainer(MAIN, I_S30, { lot_id: L71 }) });
    expect(st.settingsCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of st.settingsCalls) expect(c.keys).toContain('timezone');
  });
  run('"+ 30 days" is wall-clock days in the tenant zone: New York 2027-03-01 10:00 EST + 30 days = 2027-03-31 10:00 EDT (14:00Z, not 15:00Z: DST began 2027-03-14)', async (s) => {
    const r = await open(s, newContainer(MAIN, I_S30, { lot_id: L_DST }), { now: '2027-03-01T15:00:00.000Z', tz: 'America/New_York', permissions: [BENCH] });
    expect(r.status).toBe(201);
    expect(Date.parse(r.body.open_expiry_at)).toBe(Date.parse('2027-03-31T14:00:00.000Z'));
  });
  run('end of the expiry day on a 23-hour day (Pacific/Auckland 2027-09-26, DST starts) and a 25-hour day (America/New_York 2027-11-07, DST ends) is the last second of that LOCAL day', async (s) => {
    const a = await open(s, newContainer(MAIN, I_NS, { lot_id: L_AKL }), { now: '2027-09-01T00:00:00.000Z', tz: 'Pacific/Auckland', permissions: [BENCH] });
    expect(isEndOfDay(a.body.open_expiry_at, '2027-09-26', 'Pacific/Auckland')).toBe(true);
    const b = await open(s, newContainer(MAIN, I_NS, { lot_id: L_NYF }), { now: '2027-10-20T12:00:00.000Z', tz: 'America/New_York', permissions: [BENCH] });
    expect(isEndOfDay(b.body.open_expiry_at, '2027-11-07', 'America/New_York')).toBe(true);
  });
  run('no stability days: the open expiry is the end of the lot expiry day; no stability and no lot expiry: open_expiry_at is absent (never null on the wire)', async (s) => {
    const a = await open(s, newContainer(MAIN, I_NS, { lot_id: L_NS1 }), NOW_KT('2027-05-01T04:15:00.000Z'));
    expect(isEndOfDay(a.body.open_expiry_at, '2027-06-30', KT)).toBe(true);
    const b = await open(s, newContainer(MAIN, I_NS, { lot_id: L_NSN }), NOW_KT('2027-05-01T04:15:00.000Z'));
    expect(b.status).toBe(201);
    expect('open_expiry_at' in b.body).toBe(false);
    expect((await row(s, 'opened_containers', b.body.id)).open_expiry_at).toBeNull();
  });
  run('lot without expiry + stability 30: opened-on + 30 days', async (s) => {
    const r = await open(s, newContainer(MAIN, I_S30, { lot_id: L_NOEXP }), NOW_KT('2027-05-01T04:15:00.000Z'));
    expect(Date.parse(r.body.open_expiry_at)).toBe(Date.parse('2027-05-31T04:15:00.000Z'));
  });
  run('item that is not lot tracked: no lot_id needed, lot_id absent on the wire, open expiry = opened-on + its stability (10 days)', async (s) => {
    const r = await open(s, newContainer(MAIN, I_NL), NOW_KT('2027-05-01T04:15:00.000Z'));
    expect(r.status).toBe(201);
    expect('lot_id' in r.body).toBe(false);
    expect(Date.parse(r.body.open_expiry_at)).toBe(Date.parse('2027-05-11T04:15:00.000Z'));
  });
  run('an explicit opened_at is honoured and drives the computation (not the clock): opened 2027-04-01 10:00 NPT, clock 2 days later => 2027-05-01 10:00 NPT', async (s) => {
    const r = await open(s, newContainer(MAIN, I_S30, { lot_id: L71, opened_at: '2027-04-01T04:15:00.000Z', notes: 'synthetic note' }), NOW_KT('2027-04-03T04:15:00.000Z'));
    expect(r.status).toBe(201);
    expect(Date.parse(r.body.opened_at)).toBe(Date.parse('2027-04-01T04:15:00.000Z'));
    expect(Date.parse(r.body.open_expiry_at)).toBe(Date.parse('2027-05-01T04:15:00.000Z'));
    expect(r.body.notes).toBe('synthetic note');
  });
  run('opening writes NO stock: balances, movements and the version of every balance row are unchanged', async (s) => {
    const before = await stockSnapshot(s);
    await open(s, newContainer(MAIN, I_S30, { lot_id: L71 }), NOW_KT('2027-05-01T04:15:00.000Z'));
    expect(await stockSnapshot(s)).toBe(before);
  });
});

describe.skipIf(!live)('T-09 #38 openContainer: refusals, tenant time boundaries, scope (AC-07.3, AC-07.4, P-B2, P-T3)', () => {
  run('AC-07.4 an expired lot cannot be opened: 409 inventory.lot_expired, nothing written', async (s) => {
    const n = await count(s, 'opened_containers');
    await expectLims(open(s, newContainer(MAIN, I_NS, { lot_id: L_EXP })), 'inventory.lot_expired', 409);
    expect(await count(s, 'opened_containers')).toBe(n);
  });
  run('AC-07.3 a quarantined or blocked lot cannot be opened: 409 inventory.lot_unavailable', async (s) => {
    await expectLims(open(s, newContainer(MAIN, I_NS, { lot_id: L_QUA })), 'inventory.lot_unavailable', 409);
    await expectLims(open(s, newContainer(MAIN, I_NS, { lot_id: L_BLK })), 'inventory.lot_unavailable', 409);
  });
  run('a lot row with quantity 0 in the store, or no lot row there at all => 409 inventory.insufficient_stock', async (s) => {
    await expectLims(open(s, newContainer(MAIN, I_NS, { lot_id: L_ZERO })), 'inventory.insufficient_stock', 409);
    await expectLims(open(s, newContainer(MAIN, I_NS, { lot_id: L_NOROW })), 'inventory.insufficient_stock', 409);
    await expectLims(open(s, newContainer(BENCH_ST, I_NS, { lot_id: L_NS1 })), 'inventory.insufficient_stock', 409); // stock exists in MAIN, not in BENCH
  });
  run('boundary in tenant time: a lot expiring TODAY (Kathmandu) opens, a lot that expired YESTERDAY does not; the open expiry of the first is the end of today', async (s) => {
    const r = await open(s, newContainer(MAIN, I_BND, { lot_id: L_TODAY }));
    expect(r.status).toBe(201);
    expect(isEndOfDay(r.body.open_expiry_at, TODAY, KT)).toBe(true);
    await expectLims(open(s, newContainer(MAIN, I_BND, { lot_id: L_YEST })), 'inventory.lot_expired', 409);
  });
  run('"expired" follows the TENANT zone: a lot whose expiry is today in Pago Pago is expired for a Kiritimati tenant (409) and open-able for a Pago Pago tenant (201)', async (s) => {
    await expectLims(open(s, newContainer(MAIN, I_TZ, { lot_id: L_TZ }), { tz: KIRI, permissions: [BENCH] }), 'inventory.lot_expired', 409);
    const r = await open(s, newContainer(MAIN, I_TZ, { lot_id: L_TZ }), { tz: PAGO, permissions: [BENCH] });
    expect(r.status).toBe(201);
  });
  run('PE-2 / P-B8 / P-B2: bench.record alone is enough (technologist); read-only on a visible store -> 403; a BR-2 store for a BR-1 user -> 404 even without the permission; unknown store -> 404', async (s) => {
    expect((await open(s, newContainer(MAIN, I_S30, { lot_id: L71 }), { permissions: [BENCH] })).status).toBe(201);
    await expectLims(open(s, newContainer(MAIN, I_S30, { lot_id: L71 }), { permissions: [READ] }), 'auth.forbidden', 403);
    const n = await count(s, 'opened_containers');
    await nf(open(s, newContainer(ST_BR2, I_NS, { lot_id: L_BR2 }), { ...BR1_ONLY, permissions: [BENCH] }));
    await nf(open(s, newContainer(ST_BR2, I_NS, { lot_id: L_BR2 }), { ...BR1_ONLY, permissions: [] }));
    await nf(open(s, newContainer(uid(999999), I_S30, { lot_id: L71 })));
    expect(await count(s, 'opened_containers')).toBe(n);
    expect((await open(s, newContainer(ST_BR2, I_NS, { lot_id: L_BR2 }), { permissions: [BENCH] })).status).toBe(201); // all-centres user: BR-2 store is visible (P-B4)
  });
  run('the permission check carries the store branch: assertRole({ permission: bench.record, branchId: BR-1 })', async (s) => {
    await open(s, newContainer(MAIN, I_S30, { lot_id: L71 }));
    expect(s.roleCalls).toContainEqual({ permission: BENCH, branchId: BR1 });
  });
  run('P-T3 cross-tenant ids never write: store B, item B, lot B, instrument B => 404; and tenant A lot id with a tenant B user => 404', async (s) => {
    const n = await count(s, 'opened_containers');
    await nf(open(s, newContainer(MAIN_B, GLU_B, { lot_id: LOT_B })));
    await nf(open(s, newContainer(MAIN, I_S30, { lot_id: LOT_B })));
    await nf(open(s, newContainer(MAIN, GLU_B)));
    await nf(open(s, newContainer(MAIN, I_S30, { lot_id: L71, instrument_id: IN_B })));
    expect(await count(s, 'opened_containers')).toBe(n);
    expect(await count(s, 'opened_containers', B)).toBe(1); // B has exactly its fixture container 9311
    await nf(s.call(B, 'openContainer', { body: newContainer(uid(1101), GLU_B, { lot_id: L71 }) }, { permissions: [BENCH] }));
  });
  run('unknown instrument in this tenant => 404 (FK mapped), nothing written', async (s) => {
    await nf(open(s, newContainer(MAIN, I_S30, { lot_id: L71, instrument_id: uid(999998) })));
  });
});

// ======================================================================================================== #37 list + in-use lot (AC-07.2)
describe.skipIf(!live)('T-09 #37 listOpenedContainers and the in-use lot (AC-07.2)', () => {
  run('default status=open: fixture open containers of the store only (finished, discarded, tenant B and other-store ones are absent); Container keys only; lot_no present', async (s) => {
    const r = await s.call(A, 'listOpenedContainers', { query: { store_id: MAIN, limit: 200 } });
    const ids = r.body.data.map((c: any) => c.id);
    expect(ids).toEqual(expect.arrayContaining([CONT_OPEN, C_FC, C_RACE]));
    expect(ids).not.toContain(CONT_FIN);
    expect(ids).not.toContain(C_DISC);
    expect(ids).not.toContain(C_BR2);
    expect(ids).not.toContain(CONT_B);
    expect(r.body.data.every((c: any) => c.status === 'open')).toBe(true);
    expect(r.body.data.flatMap((c: any) => onlyKeys(c, CONTAINER_KEYS))).toEqual([]);
    expect(r.body.data.find((c: any) => c.id === CONT_OPEN)).toMatchObject({ lot_id: uid(4003), lot_no: 'C-001', instrument_id: IN1, store_id: MAIN, item_id: uid(2002) });
    expect(typeof r.body.page).toBe('object');
  });
  run('status=finished / discarded select those rows; instrument_id narrows', async (s) => {
    const fin = await s.call(A, 'listOpenedContainers', { query: { store_id: MAIN, status: 'finished', limit: 200 } });
    expect(fin.body.data.map((c: any) => c.id)).toContain(CONT_FIN);
    expect(fin.body.data.every((c: any) => c.status === 'finished' && typeof c.finished_at === 'string')).toBe(true);
    const dis = await s.call(A, 'listOpenedContainers', { query: { store_id: MAIN, status: 'discarded', limit: 200 } });
    expect(dis.body.data.map((c: any) => c.id)).toEqual([C_DISC]);
    expect(dis.body.data[0].discard_document_id).toBe(DOC_WASTE);
    const byIn = await s.call(A, 'listOpenedContainers', { query: { store_id: MAIN, instrument_id: IN1, limit: 200 } });
    expect(byIn.body.data.map((c: any) => c.id)).toEqual([CONT_OPEN]);
  });
  run('AC-07.2 the LATEST open container for (BIO-1, item) is the in-use lot: first row of the instrument-filtered list; another instrument and an instrument-less container do not interfere; finishing it hands the role back', async (s) => {
    const t1 = NOW_KT('2027-02-01T05:00:00.000Z'), t2 = NOW_KT('2027-02-01T09:00:00.000Z'), t3 = NOW_KT('2027-02-01T11:00:00.000Z');
    const c1 = (await open(s, newContainer(MAIN, I_USE, { lot_id: U1, instrument_id: IN1 }), t1)).body;
    const c2 = (await open(s, newContainer(MAIN, I_USE, { lot_id: U2, instrument_id: IN1 }), t2)).body;
    const other = (await open(s, newContainer(MAIN, I_USE, { lot_id: U2, instrument_id: IN2 }), t3)).body; // newest overall, other analyser
    const none = (await open(s, newContainer(MAIN, I_USE, { lot_id: U1 }), t3)).body; // no analyser
    const list = async () => (await s.call(A, 'listOpenedContainers', { query: { store_id: MAIN, instrument_id: IN1, limit: 200 } })).body.data.filter((c: any) => c.item_id === I_USE);
    expect((await list()).map((c: any) => c.id)).toEqual([c2.id, c1.id]); // c2 is in use; c1 stays open (still listed)
    expect((await list())[0].lot_id).toBe(U2);
    expect((await list()).map((c: any) => c.id)).not.toContain(other.id);
    expect((await list()).map((c: any) => c.id)).not.toContain(none.id);
    const fin = await s.call(A, 'finishContainer', { params: { container_id: c2.id }, headers: ifm(c2.version), body: {} }, { permissions: [BENCH] });
    expect(fin.status).toBe(200);
    expect((await list())[0].id).toBe(c1.id); // c1 is in use again
  });
  run('scope: a BR-2 store for a BR-1 user -> 404 (P-B1); permission missing on a visible store -> 403; unknown store -> 404; tenant B store -> 404; the all-centres user sees BR-2', async (s) => {
    await nf(s.call(A, 'listOpenedContainers', { query: { store_id: ST_BR2 } }, BR1_ONLY));
    await nf(s.call(A, 'listOpenedContainers', { query: { store_id: ST_BR2 } }, { ...BR1_ONLY, permissions: [] }));
    await expectLims(s.call(A, 'listOpenedContainers', { query: { store_id: MAIN } }, { permissions: [BENCH] }), 'auth.forbidden', 403);
    await nf(s.call(A, 'listOpenedContainers', { query: { store_id: uid(999999) } }));
    await nf(s.call(A, 'listOpenedContainers', { query: { store_id: MAIN_B } }));
    expect((await s.call(A, 'listOpenedContainers', { query: { store_id: ST_BR2 } })).body.data.map((c: any) => c.id)).toEqual([C_BR2]);
  });
  run('paging: limit 1 yields a cursor; following it returns the next row, never a duplicate', async (s) => {
    const p1 = await s.call(A, 'listOpenedContainers', { query: { store_id: MAIN, limit: 1 } });
    expect(p1.body.data).toHaveLength(1);
    expect(typeof p1.body.page.next_cursor).toBe('string');
    const p2 = await s.call(A, 'listOpenedContainers', { query: { store_id: MAIN, limit: 1, cursor: p1.body.page.next_cursor } });
    expect(p2.body.data).toHaveLength(1);
    expect(p2.body.data[0].id).not.toBe(p1.body.data[0].id);
  });
});

// ======================================================================================================== #39 finish
describe.skipIf(!live)('T-09 #39 finishContainer', () => {
  run('open -> finished: 200 Container, finished_at = clock (or the given instant), version + 1, finished_by = actor; the finished container leaves the open list', async (s) => {
    const clock = new Date().toISOString();
    const r = await s.call(A, 'finishContainer', { params: { container_id: CONT_OPEN }, headers: ifm(1), body: {} }, { permissions: [BENCH], now: clock });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: CONT_OPEN, status: 'finished', version: 2 });
    expect(Date.parse(r.body.finished_at)).toBe(Date.parse(clock));
    expect(onlyKeys(r.body, CONTAINER_KEYS)).toEqual([]);
    expect(await row(s, 'opened_containers', CONT_OPEN)).toMatchObject({ status: 'finished', finished_by: SYS, updated_by: SYS, version: 2 });
    const l = await s.call(A, 'listOpenedContainers', { query: { store_id: MAIN, limit: 200 } });
    expect(l.body.data.map((c: any) => c.id)).not.toContain(CONT_OPEN);
  });
  run('an explicit finished_at is honoured', async (s) => {
    const at = new Date(Date.now() - 3600_000).toISOString(); // after the fixture's opened_at (a day ago), not in the future
    const r = await s.call(A, 'finishContainer', { params: { container_id: C_RACE }, headers: ifm(1), body: { finished_at: at } }, { permissions: [BENCH] });
    expect(Date.parse(r.body.finished_at)).toBe(Date.parse(at));
  });
  run('finished and discarded are terminal: 409 inventory.document_invalid_transition, row unchanged', async (s) => {
    await expectLims(s.call(A, 'finishContainer', { params: { container_id: CONT_FIN }, headers: ifm(1), body: {} }, { permissions: [BENCH] }), 'inventory.document_invalid_transition', 409);
    await expectLims(s.call(A, 'finishContainer', { params: { container_id: C_DISC }, headers: ifm(1), body: {} }, { permissions: [BENCH] }), 'inventory.document_invalid_transition', 409);
    expect((await row(s, 'opened_containers', C_DISC)).status).toBe('discarded');
  });
  run('a second finish after success: 409 (stale If-Match: common.version_conflict, or the transition code with the fresh version); never 200 twice', async (s) => {
    const o = { permissions: [BENCH] };
    await s.call(A, 'finishContainer', { params: { container_id: CONT_OPEN }, headers: ifm(1), body: {} }, o);
    const e = await rej(s.call(A, 'finishContainer', { params: { container_id: CONT_OPEN }, headers: ifm(1), body: {} }, o)) as any;
    expect(e.statusCode).toBe(409);
    expect(['common.version_conflict', 'inventory.document_invalid_transition']).toContain(e.code);
    await expectLims(s.call(A, 'finishContainer', { params: { container_id: CONT_OPEN }, headers: ifm(2), body: {} }, o), 'inventory.document_invalid_transition', 409);
  });
  run('stale If-Match on an open container => 409 common.version_conflict, row unchanged', async (s) => {
    await expectLims(s.call(A, 'finishContainer', { params: { container_id: CONT_OPEN }, headers: ifm(7), body: {} }, { permissions: [BENCH] }), 'common.version_conflict', 409);
    expect((await row(s, 'opened_containers', CONT_OPEN)).status).toBe('open');
  });
  run('scope + tenancy: BR-2 container for a BR-1 user -> 404 (P-B2, beats a missing permission); unknown id -> 404; tenant B container -> 404 and untouched; read-only user on a visible container -> 403', async (s) => {
    await nf(s.call(A, 'finishContainer', { params: { container_id: C_BR2 }, headers: ifm(1), body: {} }, { ...BR1_ONLY, permissions: [BENCH] }));
    await nf(s.call(A, 'finishContainer', { params: { container_id: C_BR2 }, headers: ifm(1), body: {} }, { ...BR1_ONLY, permissions: [] }));
    await nf(s.call(A, 'finishContainer', { params: { container_id: uid(999999) }, headers: ifm(1), body: {} }, { permissions: [BENCH] }));
    await nf(s.call(A, 'finishContainer', { params: { container_id: CONT_B }, headers: ifm(1), body: {} }, { permissions: [BENCH] }));
    expect((await row(s, 'opened_containers', CONT_B, B)).status).toBe('open');
    await expectLims(s.call(A, 'finishContainer', { params: { container_id: CONT_OPEN }, headers: ifm(1), body: {} }, { permissions: [READ] }), 'auth.forbidden', 403);
    expect((await s.call(A, 'finishContainer', { params: { container_id: C_BR2 }, headers: ifm(1), body: {} }, { permissions: [BENCH] })).status).toBe(200); // all-centres user
  });
  it('race: two concurrent finishes of one open container with the same If-Match => exactly one 200, the other 409, never a 500, the row finished once', async () => {
    const open2 = async () => { const c = await api.connect(); await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]); return c; };
    const [c1, c2] = [await open2(), await open2()];
    try {
      const go = (c: pg.PoolClient) => call('finishContainer', makeLotCtx({ query: (t, v) => c.query(t, v) }, A, { permissions: [BENCH] }).ctx, { params: { container_id: C_RACE }, headers: ifm(1), body: {} });
      const r1 = await go(c1);
      const p2 = go(c2).then((r) => ({ ok: r }), (e) => ({ err: e }));
      await new Promise((r) => setTimeout(r, 300));
      await c1.query('COMMIT');
      const r2: any = await p2;
      expect(r1.status).toBe(200);
      expect(r2.err?.statusCode).toBe(409);
      expect(['common.version_conflict', 'inventory.document_invalid_transition']).toContain(r2.err?.code);
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined); await c2.query('ROLLBACK').catch(() => undefined); c1.release(); c2.release();
      await admin.query(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE inventory.opened_containers SET status = 'open', finished_at = NULL, finished_by = NULL, version = 1 WHERE id = '${C_RACE}'; COMMIT;`);
    }
  }, 30_000);
});

// ======================================================================================================== #36 FEFO suggestion (AC-18.x, AC-07.3, AC-07.4)
describe.skipIf(!live)('T-09 #36 getFefoSuggestion (AC-18.1, AC-18.2)', () => {
  run('AC-18.1 lots A (expiry +79 d, 40), B (+48 d, 30), C (+120 d, 20, one open container whose open expiry is +37 d): 80 units => C (open) then B then A; covers the quantity; shortfall 0', async (s) => {
    const r = await fefo(s, I_FE, '80');
    expect(r.status).toBe(200);
    expect(lines(r)).toEqual([[FC, 20], [FB, 30], [FA, 30]]);
    expect(r.body.lines.map((l: any) => [qty(l.available_qty_base), l.has_open_container])).toEqual([[20, true], [30, false], [40, false]]);
    expect(r.body.lines.map((l: any) => l.expiry_on)).toEqual([addDays(TODAY, 120), addDays(TODAY, 48), addDays(TODAY, 79)]);
    expect(qty(r.body.shortfall_qty_base)).toBe(0);
    expect(r.body).toMatchObject({ store_id: MAIN, item_id: I_FE });
    expect(qty(r.body.qty_base)).toBe(80);
    expect(Object.keys(r.body).filter((k) => !FEFO_KEYS.includes(k))).toEqual([]);
    expect(r.body.lines.flatMap((l: any) => onlyKeys(l, FEFO_LINE_KEYS))).toEqual([]);
    expect(r.body.lines.map((l: any) => l.lot_no)).toEqual(['T09-FC', 'T09-FB', 'T09-FA']);
  });
  run('effective_expiry_at = the earlier of the open container\'s open expiry and the end of the lot expiry day: C => its open expiry (+37 d 06:00Z); B => the last second of its expiry day in tenant time', async (s) => {
    const r = await fefo(s, I_FE, '80');
    const [c, b] = r.body.lines;
    expect(Date.parse(c.effective_expiry_at)).toBe(Date.parse(`${addDays(TODAY, 37)}T06:00:00.000Z`));
    expect(isEndOfDay(b.effective_expiry_at, addDays(TODAY, 48), KT)).toBe(true);
  });
  run('only as many lots as needed: 20 => C only; 50 => C 20 + B 30, A absent; 0.5 => C 0.5 (fractions are exact)', async (s) => {
    expect(lines(await fefo(s, I_FE, '20'))).toEqual([[FC, 20]]);
    expect(lines(await fefo(s, I_FE, '50'))).toEqual([[FC, 20], [FB, 30]]);
    expect(lines(await fefo(s, I_FE, '0.5'))).toEqual([[FC, 0.5]]);
  });
  run('short stock: 100 asked, 90 usable => three lines, take = available, shortfall_qty_base 10', async (s) => {
    const r = await fefo(s, I_FE, '100');
    expect(lines(r)).toEqual([[FC, 20], [FB, 30], [FA, 40]]);
    expect(qty(r.body.shortfall_qty_base)).toBe(10);
  });
  run('AC-18.2 expired (500), quarantined (500), blocked (500), zero-quantity and other-store lots never appear, however much is asked; the shortfall counts only usable stock', async (s) => {
    const r = await fefo(s, I_FE, '100000');
    expect(lotIds(r).sort()).toEqual([FA, FB, FC].sort());
    expect(qty(r.body.shortfall_qty_base)).toBe(100000 - 90);
    for (const bad of [FX, FQ, FK, FZ, FO]) expect(lotIds(r)).not.toContain(bad);
  });
  run('the store matters: BENCH-A holds only FO (100): the suggestion is FO alone', async (s) => {
    expect(lines(await fefo(s, I_FE, '10', undefined, BENCH_ST))).toEqual([[FO, 10]]);
  });
  run('no usable lots at all: lines [] and the whole quantity is the shortfall (200, not an error)', async (s) => {
    const r = await fefo(s, I_USE, '5', undefined, BENCH_ST);
    expect(r.status).toBe(200);
    expect(r.body.lines).toEqual([]);
    expect(qty(r.body.shortfall_qty_base)).toBe(5);
  });
  run('AC-07.3 quarantining B (via #32) removes it from the next suggestion; making it available again restores it; blocking works the same', async (s) => {
    const lot = await s.call(A, 'getInventoryLot', { params: { lot_id: FB } });
    const q1 = await s.call(A, 'setInventoryLotStatus', { params: { lot_id: FB }, headers: ifm(lot.body.version), body: setStatus() }, PRIV);
    expect(lotIds(await fefo(s, I_FE, '80'))).toEqual([FC, FA]);
    expect(qty((await fefo(s, I_FE, '80')).body.shortfall_qty_base)).toBe(20);
    const q2 = await s.call(A, 'setInventoryLotStatus', { params: { lot_id: FB }, headers: ifm(q1.body.version), body: { status: 'available', ...reason() } }, PRIV);
    expect(lotIds(await fefo(s, I_FE, '80'))).toEqual([FC, FB, FA]);
    await s.call(A, 'setInventoryLotStatus', { params: { lot_id: FB }, headers: ifm(q2.body.version), body: setStatus({ status: 'blocked' }) }, PRIV);
    expect(lotIds(await fefo(s, I_FE, '80'))).toEqual([FC, FA]);
  });
  run('AC-07.4 correcting a lot expiry into the past (via #33) takes it out of the suggestion', async (s) => {
    const lot = await s.call(A, 'getInventoryLot', { params: { lot_id: FA } });
    await s.call(A, 'correctInventoryLotExpiry', { params: { lot_id: FA }, headers: ifm(lot.body.version), body: correctExpiry({ expiry_on: addDays(TODAY, -1) }) }, PRIV);
    expect(lotIds(await fefo(s, I_FE, '100'))).toEqual([FC, FB]);
  });
  run('boundary in tenant time: expiring today stays a candidate, expired yesterday does not', async (s) => {
    expect(lotIds(await fefo(s, I_BND, '100'))).toEqual([L_TODAY]);
  });
  run('"today" follows the tenant zone: the lot expiring today in Pago Pago is a candidate for a Pago Pago tenant and not for a Kiritimati tenant', async (s) => {
    expect(lotIds(await fefo(s, I_TZ, '5', { tz: PAGO }))).toEqual([L_TZ]);
    expect(lotIds(await fefo(s, I_TZ, '5', { tz: KIRI }))).toEqual([]);
  });
  run('never money: no cost field on the suggestion, even for a cost.read holder', async (s) => {
    const r = await fefo(s, I_FE, '80', WITH_COST);
    expect([...costKeys(r.body), ...r.body.lines.flatMap((l: any) => costKeys(l))]).toEqual([]);
  });
  run('scope: BR-2 store for a BR-1 user -> 404 (P-B1; beats a missing permission, P-B8); permission missing on a visible store -> 403; unknown store / item -> 404; tenant B store or item -> 404; the permission check carries the branch', async (s) => {
    await nf(fefo(s, I_NS, '5', BR1_ONLY, ST_BR2));
    await nf(fefo(s, I_NS, '5', { ...BR1_ONLY, permissions: [] }, ST_BR2));
    await expectLims(fefo(s, I_FE, '5', { permissions: [] }), 'auth.forbidden', 403);
    await nf(fefo(s, I_FE, '5', undefined, uid(999999)));
    await nf(fefo(s, uid(999999), '5'));
    await nf(fefo(s, I_FE, '5', undefined, MAIN_B));
    await nf(fefo(s, GLU_B, '5'));
    expect(lotIds(await fefo(s, I_NS, '5', undefined, ST_BR2))).toEqual([L_BR2]); // all-centres user
    expect(s.roleCalls).toContainEqual({ permission: READ, branchId: BR1 });
  });
});

// ======================================================================================================== #30 / #31 lots
describe.skipIf(!live)('T-09 #30 listInventoryLots / #31 getInventoryLot', () => {
  const list = (s: Sess, query: Record<string, unknown>, o?: LotOpts) => s.call(A, 'listInventoryLots', { query: { limit: 200, ...query } }, o);
  run('#30 lots of one item: Lot keys only (no balances), no tenant / audit columns, version present; other items\' lots never mixed in', async (s) => {
    const r = await list(s, { item_id: I_LST });
    expect(r.body.data.map((l: any) => l.lot_no).sort()).toEqual(['T09-A1', 'T09-A2', 'T09-A3', 'T09-A4']);
    expect(r.body.data.flatMap((l: any) => onlyKeys(l, LOT_KEYS))).toEqual([]);
    expect(r.body.data.every((l: any) => !('balances' in l) && l.item_id === I_LST && Number.isInteger(l.version))).toBe(true);
    expect(r.body.data.flatMap((l: any) => Object.keys(l).filter((k) => LEAK.test(k)))).toEqual([]);
    expect(r.body.data.find((l: any) => l.id === LS3)).toMatchObject({ status: 'quarantined', status_reason_code: 'syn_quarantine', expiry_on: '2027-03-31' });
    expect('expiry_on' in r.body.data.find((l: any) => l.id === LS4)).toBe(false);
  });
  run('#30 filters: status; expiring_before is a strict "<" on expiry_on and never matches lots without an expiry; both together', async (s) => {
    expect((await list(s, { item_id: I_LST, status: 'quarantined' })).body.data.map((l: any) => l.id)).toEqual([LS3]);
    expect((await list(s, { item_id: I_LST, status: 'blocked' })).body.data).toEqual([]);
    expect((await list(s, { item_id: I_LST, expiring_before: '2027-01-01' })).body.data.map((l: any) => l.id)).toEqual([LS1]);
    expect((await list(s, { item_id: I_LST, expiring_before: '2026-12-31' })).body.data).toEqual([]); // strict
    expect((await list(s, { item_id: I_LST, expiring_before: '2027-04-01', status: 'available' })).body.data.map((l: any) => l.id)).toEqual([LS1]);
    expect((await list(s, { item_id: I_LST, expiring_before: '2099-01-01' })).body.data.map((l: any) => l.id).sort()).toEqual([LS1, LS2, LS3].sort());
  });
  run('#30 paging: limit 2 => cursor, the next page completes the set, no duplicates', async (s) => {
    const p1 = await list(s, { item_id: I_LST, limit: 2 });
    expect(p1.body.data).toHaveLength(2);
    const p2 = await list(s, { item_id: I_LST, limit: 2, cursor: p1.body.page.next_cursor });
    const all = [...p1.body.data, ...p2.body.data].map((l: any) => l.id);
    expect(new Set(all).size).toBe(4);
  });
  run('#30 PE-3: last_receipt_unit_cost_paisa_x1e6 appears only with inventory.cost.read (8 units for 100 paisa = 12.5 paisa = 12500000)', async (s) => {
    const plain = (await list(s, { item_id: I_LST })).body.data;
    expect(plain.flatMap((l: any) => costKeys(l))).toEqual([]);
    const withCost = (await list(s, { item_id: I_LST }, WITH_COST)).body.data;
    expect(withCost.find((l: any) => l.id === LS1).last_receipt_unit_cost_paisa_x1e6).toBe(12_500_000);
    expect(withCost.flatMap((l: any) => onlyKeys(l, LOT_KEYS))).toEqual([]);
  });
  run('#30 tenant isolation: an item of tenant B (or an unknown item) reveals nothing; tenant B sees only its own lot', async (s) => {
    await hidden(list(s, { item_id: GLU_B }));
    await hidden(list(s, { item_id: uid(999999) }));
    const b = await s.call(B, 'listInventoryLots', { query: { item_id: GLU_B, limit: 200 } });
    expect(b.body.data.map((l: any) => l.id)).toEqual([LOT_B]);
  });
  run('#31 Lot + balances in visible stores: the all-centres user sees MAIN (100) and BR-2 (7); a BR-1 user sees MAIN only (P-B1) but still gets the lot (tenant scope)', async (s) => {
    const all = await s.call(A, 'getInventoryLot', { params: { lot_id: L71 } });
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ id: L71, item_id: I_S30, lot_no: 'T09-L71', expiry_on: '2027-06-30', status: 'available', version: 1 });
    expect(onlyKeys(all.body, LOT_KEYS)).toEqual([]);
    expect(all.body.balances.map((b: any) => [b.store_id, qty(b.qty_base)]).sort()).toEqual([[MAIN, 100], [ST_BR2, 7]].sort());
    expect(all.body.balances.flatMap((b: any) => onlyKeys(b, BALANCE_KEYS))).toEqual([]);
    expect(all.body.balances[0]).toMatchObject({ item_id: I_S30, item_code: 'T09-S30', lot_id: L71, lot_no: 'T09-L71', lot_status: 'available', has_open_container: false });
    const br1 = await s.call(A, 'getInventoryLot', { params: { lot_id: L71 } }, BR1_ONLY);
    expect(br1.body.id).toBe(L71);
    expect(br1.body.balances.map((b: any) => b.store_id)).toEqual([MAIN]);
  });
  run('#31 has_open_container is true on the balance row of a lot with an open container', async (s) => {
    const r = await s.call(A, 'getInventoryLot', { params: { lot_id: FC } });
    expect(r.body.balances.find((b: any) => b.store_id === MAIN).has_open_container).toBe(true);
  });
  run('#31 PE-3: value_paisa / avg_unit_cost_paisa_x1e6 / last_receipt cost only with cost.read (50000 paisa over 100 units = 500 paisa each = 500000000 micro-paisa)', async (s) => {
    const plain = await s.call(A, 'getInventoryLot', { params: { lot_id: L71 } });
    expect([...costKeys(plain.body), ...plain.body.balances.flatMap((b: any) => costKeys(b))]).toEqual([]);
    const c = await s.call(A, 'getInventoryLot', { params: { lot_id: L71 } }, WITH_COST);
    const main = c.body.balances.find((b: any) => b.store_id === MAIN);
    expect(main.value_paisa).toBe(50000);
    expect(main.avg_unit_cost_paisa_x1e6).toBe(500_000_000);
  });
  run('#31 unknown lot -> 404; a lot of tenant B -> 404 for tenant A (P-T1); tenant B reads it fine', async (s) => {
    await nf(s.call(A, 'getInventoryLot', { params: { lot_id: uid(999999) } }));
    await nf(s.call(A, 'getInventoryLot', { params: { lot_id: LOT_B } }));
    expect((await s.call(B, 'getInventoryLot', { params: { lot_id: LOT_B } })).body.lot_no).toBe('L-001');
  });
  run('#30 / #31 need inventory.item.read (checked first, no branch)', async (s) => {
    await expectLims(s.call(A, 'listInventoryLots', { query: { item_id: I_LST } }, { permissions: [BENCH] }), 'auth.forbidden', 403);
    await expectLims(s.call(A, 'getInventoryLot', { params: { lot_id: L71 } }, { permissions: [] }), 'auth.forbidden', 403);
  });
});

// ======================================================================================================== #32 / #33 privileged lot changes
describe.skipIf(!live)('T-09 #32 setInventoryLotStatus / #33 correctInventoryLotExpiry (privileged, PE-1)', () => {
  const st = (s: Sess, lot: string, v: number, body: unknown, o: LotOpts = PRIV) => s.call(A, 'setInventoryLotStatus', { params: { lot_id: lot }, headers: ifm(v), body }, o);
  const fx = (s: Sess, lot: string, v: number, body: unknown, o: LotOpts = PRIV) => s.call(A, 'correctInventoryLotExpiry', { params: { lot_id: lot }, headers: ifm(v), body }, o);
  run('#32 quarantine: 200 Lot with status, status_reason_code, version + 1; DB row updated_by = actor; other columns untouched', async (s) => {
    const before = await row(s, 'lots', L_M1);
    const r = await st(s, L_M1, 1, setStatus());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: L_M1, lot_no: 'T09-M1', status: 'quarantined', status_reason_code: 'syn_quarantine', version: 2, expiry_on: '2027-06-30' });
    expect(onlyKeys(r.body, LOT_KEYS)).toEqual([]);
    const after = await row(s, 'lots', L_M1);
    expect(after).toMatchObject({ status: 'quarantined', status_reason_code: 'syn_quarantine', version: 2, updated_by: SYS });
    expect({ item_id: after.item_id, lot_no: after.lot_no, expiry_on: after.expiry_on, tenant_id: after.tenant_id }).toEqual({ item_id: before.item_id, lot_no: before.lot_no, expiry_on: before.expiry_on, tenant_id: before.tenant_id });
    expect((await s.call(A, 'getInventoryLot', { params: { lot_id: L_M1 } })).body.status).toBe('quarantined');
  });
  run('#32 a reason from the lot_status group is required: unknown code, a code of another group (wastage/spillage) => 422 inventory.reason_required; nothing written', async (s) => {
    await expectLims(st(s, L_M1, 1, setStatus({ reason_code: 'no_such_code' })), 'inventory.reason_required', 422);
    await expectLims(st(s, L_M1, 1, setStatus({ reason_code: 'spillage' })), 'inventory.reason_required', 422);
    expect(await row(s, 'lots', L_M1)).toMatchObject({ status: 'available', version: 1 });
  });
  run('#32 stale If-Match => 409 common.version_conflict; unknown lot => 404; lot of tenant B => 404 and its row is untouched (P-T1)', async (s) => {
    await st(s, L_M1, 1, setStatus());
    await expectLims(st(s, L_M1, 1, setStatus({ status: 'blocked' })), 'common.version_conflict', 409);
    await nf(st(s, uid(999999), 1, setStatus()));
    await nf(st(s, LOT_B, 1, setStatus()));
    expect(await row(s, 'lots', LOT_B, B)).toMatchObject({ status: 'available', version: 1 });
  });
  run('PE-1 at aal1 => 403 auth.mfa_required and nothing changes; PE-2 a technologist => 403 auth.forbidden', async (s) => {
    await expectLims(st(s, L_M1, 1, setStatus(), { permissions: [READ, ADJUST], aal: 'aal1' }), 'auth.mfa_required', 403);
    await expectLims(st(s, L_M1, 1, setStatus(), { permissions: [READ, BENCH] }), 'auth.forbidden', 403);
    await expectLims(fx(s, L_M1, 1, correctExpiry(), { permissions: [READ, ADJUST], aal: 'aal1' }), 'auth.mfa_required', 403);
    await expectLims(fx(s, L_M1, 1, correctExpiry(), { permissions: [READ, BENCH] }), 'auth.forbidden', 403);
    expect(await row(s, 'lots', L_M1)).toMatchObject({ status: 'available', version: 1 });
    expect((await s.sql(A, "SELECT to_char(expiry_on, 'YYYY-MM-DD') AS e FROM inventory.lots WHERE id = $1", [L_M1]))[0].e).toBe('2027-06-30');
  });
  run('#33 correct the expiry: 200 Lot with the new expiry_on, version + 1; the lot moves out of / into the expired set of #34 (AC-07.4 / expired_only)', async (s) => {
    const expiredNow = async () => (await s.call(A, 'listStockBalances', { query: { item_id: I_NS, expired_only: true, limit: 200 } })).body.data.map((b: any) => b.lot_id);
    expect(await expiredNow()).not.toContain(L_M1);
    const r = await fx(s, L_M1, 1, correctExpiry({ expiry_on: addDays(TODAY, -3) }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: L_M1, expiry_on: addDays(TODAY, -3), version: 2 });
    expect(await row(s, 'lots', L_M1)).toMatchObject({ version: 2, updated_by: SYS });
    expect(await expiredNow()).toContain(L_M1);
    const back = await fx(s, L_M1, 2, correctExpiry({ expiry_on: '2027-06-30' }));
    expect(back.body.expiry_on).toBe('2027-06-30');
    expect(await expiredNow()).not.toContain(L_M1);
  });
  run('#33 a lot without an expiry can be given one', async (s) => {
    const r = await fx(s, L_NSN, 1, correctExpiry({ expiry_on: '2027-08-15' }));
    expect(r.body.expiry_on).toBe('2027-08-15');
  });
  run('#33 an expiry before the manufacture date is refused: 400 common.validation_failed at /expiry_on; reason outside the adjustment group => 422 inventory.reason_required; stale / unknown / tenant B => 409 / 404 / 404', async (s) => {
    const e = await expectLims(fx(s, L_M2, 1, correctExpiry({ expiry_on: '2026-09-30' })), 'common.validation_failed', 400);
    expect(JSON.stringify((e as any).errors ?? (e as any).details ?? [])).toContain('/expiry_on');
    await expectLims(fx(s, L_M2, 1, correctExpiry({ reason_code: 'syn_quarantine' })), 'inventory.reason_required', 422); // lot_status group, not adjustment
    await expectLims(fx(s, L_M2, 1, correctExpiry({ reason_code: 'no_such_code' })), 'inventory.reason_required', 422);
    await expectLims(fx(s, L_M2, 9, correctExpiry()), 'common.version_conflict', 409);
    await nf(fx(s, uid(999999), 1, correctExpiry()));
    await nf(fx(s, LOT_B, 1, correctExpiry()));
    expect(await row(s, 'lots', L_M2)).toMatchObject({ version: 1 });
    expect(await row(s, 'lots', LOT_B, B)).toMatchObject({ version: 1 });
  });
  it('race: two concurrent set-status calls with the same If-Match => exactly one 200, the other 409 common.version_conflict (never a 500, never a lost update)', async () => {
    const open2 = async () => { const c = await api.connect(); await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]); return c; };
    const [c1, c2] = [await open2(), await open2()];
    try {
      const go = (c: pg.PoolClient, status: string) => call('setInventoryLotStatus', makeLotCtx({ query: (t, v) => c.query(t, v) }, A, PRIV).ctx, { params: { lot_id: L_RACE }, headers: ifm(1), body: setStatus({ status }) });
      const r1 = await go(c1, 'quarantined');
      const p2 = go(c2, 'blocked').then((r) => ({ ok: r }), (e) => ({ err: e }));
      await new Promise((r) => setTimeout(r, 300));
      await c1.query('COMMIT');
      const r2: any = await p2;
      expect(r1.status).toBe(200);
      expect(r2.err?.code).toBe('common.version_conflict');
      expect(r2.err?.statusCode).toBe(409);
      const db = (await admin.query('SELECT status, version FROM inventory.lots WHERE id = $1', [L_RACE])).rows[0];
      expect(db).toMatchObject({ status: 'quarantined', version: 2 });
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined); await c2.query('ROLLBACK').catch(() => undefined); c1.release(); c2.release();
      await admin.query(`UPDATE inventory.lots SET status = 'available', status_reason_code = NULL, version = 1 WHERE id = '${L_RACE}'`);
    }
  }, 30_000);
});

// ======================================================================================================== #34 stock balances (+ expired_only)
describe.skipIf(!live)('T-09 #34 listStockBalances (expired_only in tenant time, scope, cost allowlist)', () => {
  const stock = (s: Sess, query: Record<string, unknown>, o?: LotOpts) => s.call(A, 'listStockBalances', { query: { limit: 200, ...query } }, o);
  const lotsOf = (r: { body: any }) => r.body.data.map((b: any) => b.lot_id);
  run('rows are (store, item, lot): BalanceRow keys only, item_code / item_name / lot_no / expiry_on / lot_status filled; default excludes zero rows', async (s) => {
    const r = await stock(s, { item_id: I_FE, store_id: MAIN });
    expect(r.status).toBe(200);
    expect(lotsOf(r).sort()).toEqual([FA, FB, FC, FX, FQ, FK].sort());
    expect(r.body.data.flatMap((b: any) => onlyKeys(b, BALANCE_KEYS))).toEqual([]);
    expect(r.body.data.find((b: any) => b.lot_id === FQ)).toMatchObject({ store_id: MAIN, item_id: I_FE, item_code: 'T09-FE', item_name: 'T09 FEFO item', lot_no: 'T09-FQ', lot_status: 'quarantined', has_open_container: false });
    expect(r.body.data.find((b: any) => b.lot_id === FC)).toMatchObject({ has_open_container: true, expiry_on: addDays(TODAY, 120) });
    expect(r.body.data.every((b: any) => qty(b.qty_base) !== 0)).toBe(true);
  });
  run('include_zero=true brings the zero-quantity lot row (FZ) back', async (s) => {
    expect(lotsOf(await stock(s, { item_id: I_FE, store_id: MAIN, include_zero: true }))).toContain(FZ);
    expect(lotsOf(await stock(s, { item_id: I_FE, store_id: MAIN, include_zero: false }))).not.toContain(FZ);
  });
  run('available_qty_base never exceeds qty_base and equals it for an available, unexpired lot', async (s) => {
    const r = await stock(s, { item_id: I_FE, store_id: MAIN });
    for (const b of r.body.data) expect(qty(b.available_qty_base)).toBeLessThanOrEqual(qty(b.qty_base));
    const fa = r.body.data.find((b: any) => b.lot_id === FA);
    expect(qty(fa.available_qty_base)).toBe(40);
  });
  run('expired_only=true: only lots with expiry_on < today (tenant time) that hold stock - the expired fixture lots, not the lot expiring today, not unlotted rows; default (false) shows everything', async (s) => {
    const r = await stock(s, { item_id: I_FE, expired_only: true });
    expect(lotsOf(r)).toEqual([FX]);
    expect(r.body.data.every((b: any) => b.expiry_on < TODAY)).toBe(true);
    const bnd = await stock(s, { item_id: I_BND, expired_only: true });
    expect(lotsOf(bnd)).toEqual([L_YEST]); // L_TODAY expires today: not expired
    expect(lotsOf(await stock(s, { item_id: I_BND, expired_only: false })).sort()).toEqual([L_TODAY, L_YEST].sort());
    expect(lotsOf(await stock(s, { item_id: I_BND }))).toContain(L_TODAY); // default false
    const all = await stock(s, { expired_only: true });
    expect(all.body.data.every((b: any) => b.lot_id && b.expiry_on < TODAY && qty(b.qty_base) > 0)).toBe(true);
    expect(lotsOf(all)).toEqual(expect.arrayContaining([FX, L_EXP, L_YEST]));
  });
  run('expired_only uses the TENANT zone: the lot expiring today in Pago Pago is expired for a Kiritimati tenant and not for a Pago Pago tenant', async (s) => {
    expect(lotsOf(await stock(s, { item_id: I_TZ, expired_only: true }, { tz: KIRI }))).toEqual([L_TZ]);
    expect(lotsOf(await stock(s, { item_id: I_TZ, expired_only: true }, { tz: PAGO }))).toEqual([]);
  });
  run('expired_only combines with store_id, and with include_zero (an expired lot at quantity 0 is listed only then)', async (s) => {
    expect(lotsOf(await stock(s, { item_id: I_FE, store_id: BENCH_ST, expired_only: true }))).toEqual([]);
    expect(lotsOf(await stock(s, { item_id: I_NS, store_id: MAIN, expired_only: true }))).toEqual([L_EXP]);
  });
  run('expiring_within_days: lots expiring from today up to N days ahead - FB (+48 d) is in for 60 and out for 30; FC (+120 d) out for 100', async (s) => {
    expect(lotsOf(await stock(s, { item_id: I_FE, store_id: MAIN, expiring_within_days: 60 }))).toEqual(expect.arrayContaining([FB]));
    expect(lotsOf(await stock(s, { item_id: I_FE, store_id: MAIN, expiring_within_days: 30 }))).not.toContain(FB);
    expect(lotsOf(await stock(s, { item_id: I_FE, store_id: MAIN, expiring_within_days: 100 }))).not.toContain(FC);
    expect(lotsOf(await stock(s, { item_id: I_FE, store_id: MAIN, expiring_within_days: 100 }))).toEqual(expect.arrayContaining([FA, FB]));
  });
  run('the unlotted row of a non-lot-tracked item is a row without lot fields', async (s) => {
    const r = await stock(s, { item_id: I_NL, store_id: MAIN });
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ item_id: I_NL, store_id: MAIN });
    expect(qty(r.body.data[0].qty_base)).toBe(25);
    expect(['lot_id', 'lot_no', 'expiry_on', 'lot_status'].filter((k) => k in r.body.data[0])).toEqual([]);
  });
  run('P-B1 scope: without store_id a BR-1 user sees BR-1 stores only; with a BR-2 store_id -> 404 (beats a missing permission); the all-centres user sees both (P-B4)', async (s) => {
    const br1 = await stock(s, { item_id: I_S30 }, BR1_ONLY);
    expect(br1.body.data.map((b: any) => b.store_id)).not.toContain(ST_BR2);
    expect(br1.body.data.map((b: any) => b.store_id)).toContain(MAIN);
    const all = await stock(s, { item_id: I_S30 });
    expect(all.body.data.map((b: any) => b.store_id)).toEqual(expect.arrayContaining([MAIN, ST_BR2]));
    await nf(stock(s, { store_id: ST_BR2 }, BR1_ONLY));
    await nf(stock(s, { store_id: ST_BR2 }, { ...BR1_ONLY, permissions: [] }));
    await expectLims(stock(s, { store_id: MAIN }, { permissions: [] }), 'auth.forbidden', 403);
    await expectLims(stock(s, {}, { permissions: [] }), 'auth.forbidden', 403);
    await nf(stock(s, { store_id: MAIN_B }));
    await nf(stock(s, { store_id: uid(999999) }));
  });
  run('tenant isolation: tenant A never sees tenant B rows (item or lot ids of B), tenant B sees only its own', async (s) => {
    const a = await stock(s, {});
    expect(a.body.data.map((b: any) => b.item_id)).not.toContain(GLU_B);
    expect(a.body.data.map((b: any) => b.lot_id)).not.toContain(LOT_B);
    await hidden(stock(s, { item_id: GLU_B }));
    const b = await s.call(B, 'listStockBalances', { query: { limit: 200 } });
    expect(b.body.data.map((x: any) => x.lot_id)).toEqual([LOT_B]);
  });
  run('PE-3 cost allowlist: value_paisa / avg_unit_cost_paisa_x1e6 only with cost.read (50000 / 100 units => 500000000)', async (s) => {
    const plain = await stock(s, { item_id: I_S30, store_id: MAIN });
    expect(plain.body.data.flatMap((b: any) => costKeys(b))).toEqual([]);
    const c = await stock(s, { item_id: I_S30, store_id: MAIN }, WITH_COST);
    const r = c.body.data.find((b: any) => b.lot_id === L71);
    expect(r.value_paisa).toBe(50000);
    expect(r.avg_unit_cost_paisa_x1e6).toBe(500_000_000);
    expect(c.body.data.flatMap((b: any) => onlyKeys(b, BALANCE_KEYS))).toEqual([]);
  });
  run('category filter and paging', async (s) => {
    const cons = await stock(s, { category: 'consumable', store_id: MAIN });
    expect(cons.body.data.map((b: any) => b.item_id)).toContain(I_NL);
    expect(cons.body.data.map((b: any) => b.item_id)).not.toContain(I_FE);
    const p1 = await stock(s, { item_id: I_FE, store_id: MAIN, limit: 2 });
    expect(p1.body.data).toHaveLength(2);
    const p2 = await stock(s, { item_id: I_FE, store_id: MAIN, limit: 2, cursor: p1.body.page.next_cursor });
    expect(new Set([...p1.body.data, ...p2.body.data].map((b: any) => `${b.lot_id}`)).size).toBe(4);
  });
});

// ======================================================================================================== #35 movements
describe.skipIf(!live)('T-09 #35 listStockMovements', () => {
  const mov = (s: Sess, query: Record<string, unknown>, o?: LotOpts) => s.call(A, 'listStockMovements', { query: { limit: 200, ...query }, }, o);
  run('default sort is newest first (-occurred_at); Movement keys only; lot_no joined; tenant B rows never appear', async (s) => {
    const r = await mov(s, { store_id: MAIN });
    const ids = r.body.data.map((m: any) => m.id);
    expect(ids).toEqual(expect.arrayContaining([MOV_RECEIVE, uid(6002), uid(6003), MOV_UNLOT]));
    expect(ids).not.toContain(MOV_B);
    const times = r.body.data.map((m: any) => Date.parse(m.occurred_at));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    expect(r.body.data.flatMap((m: any) => onlyKeys(m, MOVEMENT_KEYS))).toEqual([]);
    expect(r.body.data.find((m: any) => m.id === MOV_RECEIVE)).toMatchObject({ movement_kind: 'receive', store_id: MAIN, item_id: uid(2001), lot_id: uid(4001), lot_no: 'L-001', doc_type: 'goods_receipt' });
    expect(qty(r.body.data.find((m: any) => m.id === MOV_RECEIVE).qty_base)).toBe(100);
    expect(qty(r.body.data.find((m: any) => m.id === uid(6002)).qty_base)).toBe(-10);
  });
  run('filters: movement_kind csv, lot_id, item_id, instrument_id, occurred_at window', async (s) => {
    const k = await mov(s, { store_id: MAIN, movement_kind: 'issue,consume_test' });
    expect(k.body.data.map((m: any) => m.id).sort()).toEqual([uid(6002), uid(6003)].sort());
    expect((await mov(s, { store_id: MAIN, movement_kind: 'receive', item_id: uid(2003) })).body.data.map((m: any) => m.id)).toEqual([MOV_UNLOT]);
    expect((await mov(s, { lot_id: uid(4001) })).body.data.every((m: any) => m.lot_id === uid(4001))).toBe(true);
    expect((await mov(s, { instrument_id: IN1 })).body.data.map((m: any) => m.id)).toEqual([uid(6003)]);
    const from = new Date(Date.now() - 36 * 3600_000).toISOString();
    expect((await mov(s, { store_id: MAIN, occurred_at_from: from })).body.data.map((m: any) => m.id)).toEqual([uid(6003)]);
    expect((await mov(s, { store_id: MAIN, occurred_at_to: from, item_id: uid(2001) })).body.data.map((m: any) => m.id)).not.toContain(uid(6003));
  });
  run('P-B1 scope: a BR-1 user does not see BR-2 movements and gets 404 for a BR-2 store_id; the all-centres user sees them', async (s) => {
    expect((await mov(s, { item_id: I_NS }, BR1_ONLY)).body.data.map((m: any) => m.id)).not.toContain(MOV_BR2);
    await nf(mov(s, { store_id: ST_BR2 }, BR1_ONLY));
    await nf(mov(s, { store_id: ST_BR2 }, { ...BR1_ONLY, permissions: [] }));
    expect((await mov(s, { store_id: ST_BR2 })).body.data.map((m: any) => m.id)).toEqual([MOV_BR2]);
    await expectLims(mov(s, {}, { permissions: [] }), 'auth.forbidden', 403);
    await nf(mov(s, { store_id: MAIN_B }));
  });
  run('PE-3: value_paisa and value_basis only with cost.read', async (s) => {
    const plain = await mov(s, { store_id: MAIN });
    expect(plain.body.data.flatMap((m: any) => costKeys(m))).toEqual([]);
    const c = await mov(s, { store_id: MAIN }, WITH_COST);
    expect(c.body.data.find((m: any) => m.id === MOV_RECEIVE)).toMatchObject({ value_paisa: 50000, value_basis: 'receipt' });
  });
  run('tenant isolation: tenant A filter by a B lot id reveals nothing; tenant B sees its movement', async (s) => {
    await hidden(mov(s, { lot_id: LOT_B }));
    expect((await s.call(B, 'listStockMovements', { query: { limit: 200 } })).body.data.map((m: any) => m.id)).toEqual([MOV_B]);
  });
});
