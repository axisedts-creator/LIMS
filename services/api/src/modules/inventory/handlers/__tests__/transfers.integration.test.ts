// C12.T-13 integration + probes for #56-#62 on the migrated database as role lims_api with RLS on (REAL T-03 repositories, handlers/index.ts, T-04 scope service, T-05 ledger).
// Harness: tests/db/c12-t13/run.sh (clone of c12-t09: pinned image, migrations, seeds, inventory DDL, exports LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL / LIMS_C12T03_REQUIRE_DB=1).
// Fixtures: tests/db/c12-t03/fixtures.sql (stores 1001 MAIN-A, 1002 BENCH-A; items 2001 GLU-R1, 2002; packs 2201 BOX = 400, 2202 KIT = 100 (item 2001); lot 4001 (item 2001); transfers 8701 draft, 8702 dispatched;
//   tenant B: store 1101, 1102, item 2101, lot 4101, transfer 8801) + EXTRAS below (ids 14xxx, committed once with the superuser, ON CONFLICT DO NOTHING).
// Each test = one request-shaped transaction that is ROLLED BACK; every handler call runs inside a SAVEPOINT. The race tests commit (fresh documents, own stores / lots) and never touch other fixtures.
// Without the URLs the DB tests skip, except under LIMS_C12T03_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails.
// EXTRAS (tenant A): stores S1 (BR1, source) S2 (BR2, destination) S3 (BR1) S5 (BR1) S6 (BR2) S7 (BR1, race source), all is_default_consumption = false.
//   items IT (lot tracked) IU (not lot tracked) IF (FEFO) IR (race). Money: LA = 100 units worth 33 325 paisa (98 / 100 x 33 325 = 32 658.5 -> half-up 32 659, not banker's 32 658); LB = 7 units worth 100 paisa.
//   LX expired yesterday, LT expires today (still usable), LQ quarantined, LBK blocked, LL = 5 units. FA (+10 d, 10 units, 1000) FB (+40 d, 20 units, 2000) FC (+5 d quarantined) FD (expired) FE (blocked).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  A, B, BR1, BR2, COST, LEAK, LINE_KEYS, MANAGE, READ, SUMMARY_KEYS, SYS, TRANSFER_KEYS, TRANSFER_NO, addDays, call, cancelBody, expectLims, ifm, makeTrCtx, newTransfer, onlyKeys, qty, recvBody,
  rej, replaceBody, trLine, uid, ymdIn, type LotOpts,
} from './transfers.helpers.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

// fixtures (T-03)
const MAIN = uid(1001), BENCH_ST = uid(1002), GLU = uid(2001), CTRL = uid(2002), L_GLU = uid(4001), BOX = uid(2201), KIT = uid(2202), TR_DRAFT = uid(8701), TR_DISP = uid(8702);
const MAIN_B = uid(1101), BENCH_B = uid(1102), GLU_B = uid(2101), LOT_B = uid(4101), TR_B = uid(8801), TRL_B = uid(8811);
// extras
const KT = 'Asia/Kathmandu', TODAY = ymdIn(KT);
const S1 = uid(14001), S2 = uid(14002), S3 = uid(14003), S5 = uid(14005), S6 = uid(14006), S7 = uid(14007);
const IT = uid(14101), IU = uid(14102), IF_ = uid(14103), IR = uid(14104);
const LA = uid(14201), LB = uid(14202), LX = uid(14203), LT = uid(14204), LQ = uid(14205), LBK = uid(14206), LL = uid(14207);
const FA = uid(14221), FB = uid(14222), FC = uid(14223), FD = uid(14224), FE = uid(14225);
const LR1 = uid(14231), LR2 = uid(14232), LR3 = uid(14233);
const BR1_ONLY: LotOpts = { all: false, branchIds: [BR1] };
const BR2_ONLY: LotOpts = { all: false, branchIds: [BR2] };
const NOBODY: LotOpts = { all: false, branchIds: [] };
const WITH_COST: LotOpts = { permissions: [READ, MANAGE, COST] };

const lots: [string, string, string, string | null, string][] = [
  [LA, IT, 'T13-LA', addDays(TODAY, 60), 'available'], [LB, IT, 'T13-LB', addDays(TODAY, 60), 'available'], [LX, IT, 'T13-LX', addDays(TODAY, -1), 'available'],
  [LT, IT, 'T13-LT', TODAY, 'available'], [LQ, IT, 'T13-LQ', addDays(TODAY, 60), 'quarantined'], [LBK, IT, 'T13-LBK', addDays(TODAY, 60), 'blocked'], [LL, IT, 'T13-LL', addDays(TODAY, 60), 'available'],
  [FA, IF_, 'T13-FA', addDays(TODAY, 10), 'available'], [FB, IF_, 'T13-FB', addDays(TODAY, 40), 'available'], [FC, IF_, 'T13-FC', addDays(TODAY, 5), 'quarantined'],
  [FD, IF_, 'T13-FD', addDays(TODAY, -3), 'available'], [FE, IF_, 'T13-FE', addDays(TODAY, 20), 'blocked'],
  [LR1, IR, 'T13-LR1', addDays(TODAY, 60), 'available'], [LR2, IR, 'T13-LR2', addDays(TODAY, 60), 'available'], [LR3, IR, 'T13-LR3', addDays(TODAY, 60), 'available'],
];
// id, store, item, lot, qty, value
const balances: [string, string, string, string | null, number, number][] = [
  [uid(14501), S1, IT, LA, 100, 33325], [uid(14502), S1, IT, LB, 7, 100], [uid(14503), S1, IT, LX, 10, 100], [uid(14504), S1, IT, LT, 10, 100], [uid(14505), S1, IT, LQ, 10, 100],
  [uid(14506), S1, IT, LBK, 10, 100], [uid(14507), S1, IT, LL, 5, 500], [uid(14508), S1, IF_, FA, 10, 1000], [uid(14509), S1, IF_, FB, 20, 2000], [uid(14510), S1, IF_, FC, 50, 5000],
  [uid(14511), S1, IF_, FD, 50, 5000], [uid(14512), S1, IF_, FE, 50, 5000], [uid(14513), S1, IU, null, 25, 2500], [uid(14514), S5, IT, LA, 50, 1000], [uid(14515), S7, IR, LR1, 10, 1000],
  [uid(14516), S7, IR, LR2, 10, 1000], [uid(14517), S1, GLU, L_GLU, 1000, 500000], [uid(14518), S7, IR, LR3, 10, 1000],
];
const q = (v: string | null) => (v === null ? 'NULL' : `'${v}'`);
const EXTRAS = `
BEGIN;
SET LOCAL session_replication_role = replica;
SELECT set_config('request.jwt.claims', '{"tenant_id":"${A}","sub":"${SYS}","actor_type":"system"}', true);
INSERT INTO inventory.g_cs_reasons (id, reason_group, code, display) VALUES
  ('${uid(14601)}', 'transfer_discrepancy', 'transit_loss', 'Transit loss'), ('${uid(14602)}', 'transfer_discrepancy', 'damaged_in_transit', 'Damaged in transit'),
  ('${uid(14603)}', 'transfer_discrepancy', 'count_error', 'Count error'), ('${uid(14604)}', 'transfer_discrepancy', 'other', 'Other') ON CONFLICT DO NOTHING;
INSERT INTO inventory.stores (id, tenant_id, branch_id, store_code, name, store_kind, is_default_consumption, is_active, created_by, updated_by) VALUES
  ('${S1}', '${A}', '${BR1}', 'T13-S1', 'Store T13-S1', 'main', false, true, '${SYS}', '${SYS}'), ('${S2}', '${A}', '${BR2}', 'T13-S2', 'Store T13-S2', 'main', false, true, '${SYS}', '${SYS}'),
  ('${S3}', '${A}', '${BR1}', 'T13-S3', 'Store T13-S3', 'bench', false, true, '${SYS}', '${SYS}'), ('${S5}', '${A}', '${BR1}', 'T13-S5', 'Store T13-S5', 'bench', false, true, '${SYS}', '${SYS}'),
  ('${S6}', '${A}', '${BR2}', 'T13-S6', 'Store T13-S6', 'bench', false, true, '${SYS}', '${SYS}'), ('${S7}', '${A}', '${BR1}', 'T13-S7', 'Store T13-S7', 'bench', false, true, '${SYS}', '${SYS}')
  ON CONFLICT DO NOTHING;
INSERT INTO inventory.items (id, tenant_id, item_code, name, category, base_uom_code, is_lot_tracked, requires_expiry, open_stability_days, created_by, updated_by) VALUES
  ('${IT}', '${A}', 'T13-IT', 'T13 lot tracked', 'reagent', 'test', true, true, NULL, '${SYS}', '${SYS}'), ('${IU}', '${A}', 'T13-IU', 'T13 not lot tracked', 'consumable', 'test', false, false, NULL, '${SYS}', '${SYS}'),
  ('${IF_}', '${A}', 'T13-IF', 'T13 FEFO item', 'reagent', 'test', true, true, NULL, '${SYS}', '${SYS}'), ('${IR}', '${A}', 'T13-IR', 'T13 race item', 'reagent', 'test', true, true, NULL, '${SYS}', '${SYS}')
  ON CONFLICT DO NOTHING;
INSERT INTO inventory.lots (id, tenant_id, item_id, lot_no, expiry_on, status, status_reason_code, created_by, updated_by) VALUES
${lots.map((l) => `  ('${l[0]}', '${A}', '${l[1]}', '${l[2]}', ${q(l[3])}, '${l[4]}', ${l[4] === 'available' ? 'NULL' : "'syn_quarantine'"}, '${SYS}', '${SYS}')`).join(',\n')} ON CONFLICT DO NOTHING;
INSERT INTO inventory.stock_balances (id, tenant_id, store_id, item_id, lot_id, qty_base, value_paisa, last_movement_at, created_by, updated_by) VALUES
${balances.map((b) => `  ('${b[0]}', '${A}', '${b[1]}', '${b[2]}', ${q(b[3])}, ${b[4]}, ${b[5]}, now(), '${SYS}', '${SYS}')`).join(',\n')} ON CONFLICT DO NOTHING;
COMMIT;`;

// collection-time probe: does the migrated DB ship inventory.tg_line_guard yet?
const hasTrigger = live && await (async () => {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  try { await c.connect(); return (await c.query("SELECT 1 FROM pg_proc WHERE proname = 'tg_line_guard'")).rowCount === 1; } catch { return false; } finally { await c.end().catch(() => undefined); }
})();

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

describe('T-13 harness', () => {
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
  let n = 0;
  const roleCalls: any[] = [];
  const tx = { query: (t: string, v?: unknown[]) => client.query(t, v) };
  return {
    roleCalls,
    async sql(t, text, v) { await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]); return (await client.query(text, v)).rows; },
    async call(t, op, req, o) {
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]);
      const st = makeTrCtx(tx, t, o ?? {});
      const sp = `t13_h${++n}`;
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
const invalid = (p: Promise<unknown>) => expectLims(p, 'inventory.document_invalid_transition', 409);
const mk = async (s: Sess, from: string, to: string, lines: Record<string, unknown>[], o?: LotOpts, over: Record<string, unknown> = {}) =>
  (await s.call(A, 'createTransfer', { body: newTransfer(from, to, lines, over) }, o)).body;
const get = (s: Sess, id: string, o?: LotOpts, t = A) => s.call(t, 'getTransfer', { params: { transfer_id: id } }, o);
const dispatch = (s: Sess, t: { id: string; version: number }, o?: LotOpts) => s.call(A, 'dispatchTransfer', { params: { transfer_id: t.id }, headers: ifm(t.version) }, o);
const receive = (s: Sess, t: { id: string; version: number }, lines: { line_id: string; received_qty_base: string; discrepancy_reason_code?: string }[], o?: LotOpts) =>
  s.call(A, 'receiveTransfer', { params: { transfer_id: t.id }, headers: ifm(t.version), body: recvBody(lines) }, o);
const cancel = (s: Sess, t: { id: string; version: number }, o?: LotOpts, body = cancelBody()) => s.call(A, 'cancelTransfer', { params: { transfer_id: t.id }, headers: ifm(t.version), body }, o);
const replace = (s: Sess, t: { id: string; version: number }, lines: Record<string, unknown>[], o?: LotOpts) =>
  s.call(A, 'replaceTransferDraft', { params: { transfer_id: t.id }, headers: ifm(t.version), body: replaceBody(lines) }, o);
/** Every movement of document `doc` (the transfer), keyed for assertions. */
const moves = async (s: Sess, doc: string) => (await s.sql(A, `SELECT movement_kind AS kind, store_id, item_id, lot_id, qty_base::text AS q, value_paisa::text AS v, value_basis AS basis, reason_code, balance_qty_after::text AS bal,
  doc_type, doc_line_id FROM inventory.stock_movements WHERE tenant_id = $1 AND doc_id = $2 ORDER BY balance_qty_after::numeric, created_at`, [A, doc]))
  .map((m: any) => ({ ...m, qn: Number(m.q), vn: Number(m.v), bn: Number(m.bal) }));
const ofKind = (ms: any[], kind: string, store?: string) => ms.filter((m) => m.kind === kind && (store === undefined || m.store_id === store));
const bal = async (s: Sess, store: string, item: string, lot: string | null) => {
  const r = (await s.sql(A, 'SELECT qty_base::text AS q, value_paisa::text AS v FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id IS NOT DISTINCT FROM $4::uuid', [A, store, item, lot]))[0];
  return r ? { q: Number(r.q), v: Number(r.v) } : { q: 0, v: 0 };
};
const count = async (s: Sess, table: string, where = 'true', v: unknown[] = []) => Number((await s.sql(A, `SELECT count(*) AS n FROM inventory.${table} WHERE tenant_id = $1 AND ${where}`, [A, ...v]))[0].n);
const movementCount = (s: Sess) => count(s, 'stock_movements');
const dbTransfer = async (s: Sess, id: string, t = A) => (await s.sql(t, 'SELECT * FROM inventory.transfers WHERE id = $1', [id]))[0];
const dbLines = (s: Sess, id: string, t = A) => s.sql(t, 'SELECT * FROM inventory.transfer_lines WHERE transfer_id = $1 ORDER BY line_no, created_at, id', [id]);
const stockSnapshot = async (s: Sess) => JSON.stringify([await s.sql(A, 'SELECT id, qty_base, value_paisa, version FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [A]), await movementCount(s)]);
/** draft S1 -> S2 of 100 x LA, dispatched; returns the dispatched Transfer body. */
async function dispatchedLA(s: Sess, take = '100') {
  const d = await mk(s, S1, S2, [trLine(IT, take, LA)]);
  return (await dispatch(s, d)).body;
}

// ======================================================================================================== #57 / #58 create + read
describe.skipIf(!live)('T-13 #57 createTransfer / #58 getTransfer', () => {
  run('AC-10.1 setup: draft BR1-MAIN -> BR2-MAIN of 100 test of lot LA: 201, draft, numbered, lines numbered, NO stock effect', async (s) => {
    const before = await stockSnapshot(s);
    const r = await s.call(A, 'createTransfer', { body: newTransfer(S1, S2, [trLine(IT, '100', LA)], { notes: 'Synthetic note' }) });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ from_store_id: S1, to_store_id: S2, status: 'draft', version: 1, notes: 'Synthetic note' });
    expect(r.body.transfer_no).toMatch(TRANSFER_NO);
    expect(r.body.lines).toHaveLength(1);
    expect(r.body.lines[0]).toMatchObject({ line_no: 1, item_id: IT, lot_id: LA });
    expect(qty(r.body.lines[0].qty_base)).toBe(100);
    expect(onlyKeys(r.body, TRANSFER_KEYS)).toEqual([]);
    expect(onlyKeys(r.body.lines[0], LINE_KEYS)).toEqual([]);
    expect(Object.keys(r.body).filter((k) => LEAK.test(k))).toEqual([]);
    const db = await dbTransfer(s, r.body.id);
    expect(db).toMatchObject({ tenant_id: A, status: 'draft', created_by: SYS, version: 1 });
    expect(await stockSnapshot(s)).toBe(before);
  });
  run('two creates get two different numbers; the second is greater (counter, not random)', async (s) => {
    const a = await mk(s, S1, S2, [trLine(IT, '1', LA)]);
    const b = await mk(s, S1, S3, [trLine(IT, '1', LA)]);
    expect(a.transfer_no).not.toBe(b.transfer_no);
    expect(b.transfer_no > a.transfer_no).toBe(true);
  });
  run('lines get line_no 1..n in request order; a lot-tracked line without lot_id is a draft (the FEFO split happens at dispatch)', async (s) => {
    const r = await mk(s, S1, S2, [trLine(IT, '5', LA), trLine(IF_, '25'), trLine(IU, '3')]);
    expect(r.lines.map((l: any) => l.line_no)).toEqual([1, 2, 3]);
    expect(r.lines.map((l: any) => l.item_id)).toEqual([IT, IF_, IU]);
    expect(r.lines[1].lot_id ?? null).toBeNull();
    expect(r.lines[2].lot_id ?? null).toBeNull();
  });
  run('a draft of an unavailable / expired lot is allowed (availability is judged at dispatch, 03-APP-FLOW T2)', async (s) => {
    const r = await mk(s, S1, S2, [trLine(IT, '5', LQ), trLine(IT, '5', LX)]);
    expect(r.status).toBe('draft');
  });
  run('qty with pack_id: 2 KIT (100 each) of item 2001 = 200 base; 1.5 BOX (400) = 600', async (s) => {
    const r = await mk(s, S1, S2, [trLine(GLU, '2', L_GLU, { pack_id: KIT }), trLine(GLU, '1.5', L_GLU, { pack_id: BOX })]);
    expect(r.lines.map((l: any) => qty(l.qty_base))).toEqual([200, 600]);
  });
  run('a pack of another item -> 422 inventory.uom_mismatch, no transfer row', async (s) => {
    const before = await count(s, 'transfers');
    await expectLims(s.call(A, 'createTransfer', { body: newTransfer(S1, S2, [trLine(CTRL, '2', null, { pack_id: BOX })]) }), 'inventory.uom_mismatch', 422);
    expect(await count(s, 'transfers')).toBe(before);
  });
  run('lot_id on a non-lot-tracked item -> 400 at /lines/0/lot_id; a lot of ANOTHER item -> 404 common.not_found', async (s) => {
    const e = await expectLims(s.call(A, 'createTransfer', { body: newTransfer(S1, S2, [trLine(IU, '1', LA)]) }), 'common.validation_failed', 400);
    expect(JSON.stringify(e.errors ?? e.detail ?? '')).toContain('/lines/0/lot_id');
    await nf(s.call(A, 'createTransfer', { body: newTransfer(S1, S2, [trLine(IF_, '1', LA)]) }));
  });
  run('unknown item / lot / store ids -> 404 common.not_found; nothing is written (documents are atomic, P-T4)', async (s) => {
    const before = await count(s, 'transfers');
    await nf(s.call(A, 'createTransfer', { body: newTransfer(S1, S2, [trLine(IT, '1', LA), trLine(uid(99001), '1')]) }));
    await nf(s.call(A, 'createTransfer', { body: newTransfer(S1, S2, [trLine(IT, '1', uid(99002))]) }));
    await nf(s.call(A, 'createTransfer', { body: newTransfer(S1, uid(99003), [trLine(IT, '1', LA)]) }));
    await nf(s.call(A, 'createTransfer', { body: newTransfer(uid(99004), S2, [trLine(IT, '1', LA)]) }));
    expect(await count(s, 'transfers')).toBe(before);
  });
  run('#58 getTransfer returns the Transfer with only current lines, strict keys, no tenant / audit columns; without cost.read no dispatched_value_paisa', async (s) => {
    const d = await dispatchedLA(s);
    const r = await get(s, d.id);
    expect(r.status).toBe(200);
    expect(onlyKeys(r.body, TRANSFER_KEYS)).toEqual([]);
    expect(onlyKeys(r.body.lines[0], LINE_KEYS)).toEqual([]);
    expect(Object.keys(r.body.lines[0])).not.toContain('dispatched_value_paisa');
    expect(Object.keys(r.body).filter((k) => LEAK.test(k))).toEqual([]);
    const c = await get(s, d.id, WITH_COST);
    expect(c.body.lines[0].dispatched_value_paisa).toBe(33325);
  });
  run('#58 the fixture drafts: 8701 shows only its 2 current lines (the soft-removed line 8712 is hidden)', async (s) => {
    const r = await get(s, TR_DRAFT);
    expect(r.body.status).toBe('draft');
    expect(r.body.lines.map((l: any) => l.id).sort()).toEqual([uid(8711), uid(8713)].sort());
  });
  run('#58 unknown id -> 404; not a uuid-shaped row of this tenant -> 404', async (s) => { await nf(get(s, uid(99010))); });
});

// ======================================================================================================== #60 dispatch (AC-10.1)
describe.skipIf(!live)('T-13 #60 dispatchTransfer (AC-10.1)', () => {
  run('AC-10.1 100 of LA dispatched: transfer_out of -100 at the source (value -33325, doc_type transfer), source row 0, destination untouched, status dispatched', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IT, '100', LA)]);
    const r = await dispatch(s, d);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: d.id, status: 'dispatched', version: d.version + 1 });
    expect(Date.parse(r.body.dispatched_at)).toBeGreaterThan(Date.now() - 60_000);
    const ms = await moves(s, d.id);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: 'transfer_out', store_id: S1, item_id: IT, lot_id: LA, qn: -100, vn: -33325, doc_type: 'transfer', bn: 0, doc_line_id: d.lines[0].id });
    expect(await bal(s, S1, IT, LA)).toEqual({ q: 0, v: 0 });
    expect(await bal(s, S2, IT, LA)).toEqual({ q: 0, v: 0 });
    const db = await dbTransfer(s, d.id);
    expect(db).toMatchObject({ status: 'dispatched', dispatched_by: SYS, version: d.version + 1 });
    expect((await dbLines(s, d.id))[0]).toMatchObject({ dispatched_value_paisa: '33325' });
  });
  run('pro-rata value: 3 of LB (7 units worth 100) dispatches 43 paisa (42.857 rounded half up); the source row keeps 4 units / 57', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IT, '3', LB)]);
    const r = await dispatch(s, d, WITH_COST);
    expect(r.body.lines[0].dispatched_value_paisa).toBe(43);
    expect((await moves(s, d.id))[0]).toMatchObject({ kind: 'transfer_out', qn: -3, vn: -43 });
    expect(await bal(s, S1, IT, LB)).toEqual({ q: 4, v: 57 });
  });
  run('a non-lot-tracked item dispatches from the unlotted row (lot_id null)', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IU, '25')]);
    await dispatch(s, d);
    const ms = await moves(s, d.id);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: 'transfer_out', item_id: IU, lot_id: null, qn: -25, vn: -2500 });
    expect(await bal(s, S1, IU, null)).toEqual({ q: 0, v: 0 });
  });
  run('FEFO split: one line of 25 without a lot becomes one line per lot (FA 10 then FB 15), the draft is rewritten in the same transaction; quarantined / expired / blocked lots are skipped', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IF_, '25')]);
    const r = await dispatch(s, d, WITH_COST);
    expect(r.body.status).toBe('dispatched');
    expect(r.body.lines.map((l: any) => [l.line_no, l.lot_id, qty(l.qty_base)])).toEqual([[1, FA, 10], [2, FB, 15]]);
    expect(r.body.lines.map((l: any) => l.dispatched_value_paisa)).toEqual([1000, 1500]);
    const ms = await moves(s, d.id);
    expect(ms.map((m: any) => [m.kind, m.lot_id, m.qn, m.vn]).sort()).toEqual([['transfer_out', FA, -10, -1000], ['transfer_out', FB, -15, -1500]].sort());
    expect(ms.map((m: any) => m.doc_line_id).sort()).toEqual(r.body.lines.map((l: any) => l.id).sort()); // each movement points at its own (new) line
    expect(await bal(s, S1, IF_, FA)).toEqual({ q: 0, v: 0 });
    expect(await bal(s, S1, IF_, FB)).toEqual({ q: 5, v: 500 });
    for (const lot of [FC, FD, FE]) expect((await bal(s, S1, IF_, lot)).q).toBe(50);
    // D-71: the original lot-less line is soft-removed, never deleted
    const all = await dbLines(s, d.id);
    expect(all).toHaveLength(3);
    const removed = all.filter((l: any) => l.removed_at !== null);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ lot_id: null, removed_by: SYS });
    expect(all.filter((l: any) => l.removed_at === null).map((l: any) => l.line_no)).toEqual([1, 2]);
  });
  run('a line that names a lot is never split or re-picked: 5 of FB stays one line on FB', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IF_, '5', FB)]);
    const r = await dispatch(s, d);
    expect(r.body.lines).toHaveLength(1);
    expect(r.body.lines[0].lot_id).toBe(FB);
    expect(await dbLines(s, d.id)).toHaveLength(1);
  });
  run('FEFO shortfall (31 asked, 30 usable) -> 409 inventory.insufficient_stock; the draft is exactly as it was (rewrite rolled back), nothing posted', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IF_, '31')]);
    const before = await stockSnapshot(s);
    await expectLims(dispatch(s, d), 'inventory.insufficient_stock', 409);
    expect(await stockSnapshot(s)).toBe(before);
    const all = await dbLines(s, d.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ removed_at: null, lot_id: null });
    expect(await dbTransfer(s, d.id)).toMatchObject({ status: 'draft', version: d.version });
  });
  run('lot checks in tenant time: expired yesterday -> 409 inventory.lot_expired; expires TODAY is still usable; quarantined / blocked -> 409 inventory.lot_unavailable; 6 of 5 -> insufficient_stock', async (s) => {
    const t = async (lot: string, q1: string) => dispatch(s, await mk(s, S1, S2, [trLine(IT, q1, lot)]));
    await expectLims(t(LX, '1'), 'inventory.lot_expired', 409);
    await expectLims(t(LQ, '1'), 'inventory.lot_unavailable', 409);
    await expectLims(t(LBK, '1'), 'inventory.lot_unavailable', 409);
    await expectLims(t(LL, '6'), 'inventory.insufficient_stock', 409);
    expect((await t(LT, '10')).body.status).toBe('dispatched');
    expect(await bal(s, S1, IT, LT)).toEqual({ q: 0, v: 0 });
  });
  run('expiry is judged in the TENANT timezone: at 10:30Z on LT\'s expiry day it is still usable in Asia/Kathmandu (16:15) but expired in Pacific/Kiritimati (already the next day, 00:30)', async (s) => {
    const now = `${TODAY}T10:30:00.000Z`;
    const ok = await mk(s, S1, S2, [trLine(IT, '1', LT)]);
    expect((await dispatch(s, ok, { now, tz: KT })).body.status).toBe('dispatched');
    const late = await mk(s, S1, S2, [trLine(IT, '1', LT)]);
    await expectLims(dispatch(s, late, { now, tz: 'Pacific/Kiritimati' }), 'inventory.lot_expired', 409);
  });
  run('atomic: line 1 fine, line 2 short -> 409, NO movement of line 1, status draft, balances identical', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IT, '3', LB), trLine(IT, '6', LL)]);
    const before = await stockSnapshot(s);
    await expectLims(dispatch(s, d), 'inventory.insufficient_stock', 409);
    expect(await stockSnapshot(s)).toBe(before);
    expect(await dbTransfer(s, d.id)).toMatchObject({ status: 'draft' });
  });
  run('two lines of the same lot together exceed the stock (4 + 4 of LB, 7 on hand) -> 409 insufficient_stock, nothing posted', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IT, '4', LB), trLine(IT, '4', LB)]);
    const before = await stockSnapshot(s);
    await expectLims(dispatch(s, d), 'inventory.insufficient_stock', 409);
    expect(await stockSnapshot(s)).toBe(before);
  });
  run('the response is the dispatched Transfer (strict keys; dispatched_at set; received_at absent)', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IT, '1', LA)]);
    const r = await dispatch(s, d);
    expect(onlyKeys(r.body, TRANSFER_KEYS)).toEqual([]);
    expect(r.body.dispatched_at).toBeTypeOf('string');
    expect(r.body.received_at ?? null).toBeNull();
  });
});

// ======================================================================================================== #61 receive (AC-10.2)
describe.skipIf(!live)('T-13 #61 receiveTransfer: pro-rata value and transit loss (AC-10.2, D-69)', () => {
  run('AC-10.2 receives 98 of 100 (V = 33325): destination transfer_in +98 at round_half_up(98/100 x V) = 32659; source transfer_in +2 at 666 then wastage -2 at 666 (reason transit_loss); the source nets -100', async (s) => {
    const d = await dispatchedLA(s);
    const r = await receive(s, d, [{ line_id: d.lines[0].id, received_qty_base: '98', discrepancy_reason_code: 'transit_loss' }], WITH_COST);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'received', version: d.version + 1 });
    expect(Date.parse(r.body.received_at)).toBeGreaterThan(Date.now() - 60_000);
    expect(r.body.lines[0]).toMatchObject({ received_qty_base: expect.any(String), discrepancy_reason_code: 'transit_loss', dispatched_value_paisa: 33325 });
    expect(qty(r.body.lines[0].received_qty_base)).toBe(98);
    const ms = await moves(s, d.id);
    expect(ms).toHaveLength(4);
    const dest = ofKind(ms, 'transfer_in', S2);
    expect(dest).toHaveLength(1);
    expect(dest[0]).toMatchObject({ lot_id: LA, qn: 98, vn: 32659, doc_type: 'transfer', bn: 98 });
    const srcIn = ofKind(ms, 'transfer_in', S1);
    const srcW = ofKind(ms, 'wastage', S1);
    expect(srcIn).toHaveLength(1);
    expect(srcW).toHaveLength(1);
    expect(srcIn[0]).toMatchObject({ lot_id: LA, qn: 2, vn: 666, basis: 'transfer', doc_type: 'transfer', bn: 2 });
    expect(srcW[0]).toMatchObject({ lot_id: LA, qn: -2, vn: -666, reason_code: 'transit_loss', doc_type: 'transfer', bn: 0 });
    // the same (store, item, lot) row as the transfer_out; the source nets -100 units and -33325 paisa
    const src = ms.filter((m) => m.store_id === S1);
    expect(src.reduce((a, m) => a + m.qn, 0)).toBe(-100);
    expect(src.reduce((a, m) => a + m.vn, 0)).toBe(-33325);
    expect(await bal(s, S1, IT, LA)).toEqual({ q: 0, v: 0 });
    expect(await bal(s, S2, IT, LA)).toEqual({ q: 98, v: 32659 });
    expect(ms.filter((m) => m.store_id === S1 && m.lot_id === LA)).toHaveLength(3);
  });
  run('the wastage row never raises insufficient_stock nor breaks the lot non-negative CHECK even though the row dispatched its last unit (receive completes with 200)', async (s) => {
    const d = await dispatchedLA(s);
    expect((await bal(s, S1, IT, LA)).q).toBe(0);
    expect((await receive(s, d, [{ line_id: d.lines[0].id, received_qty_base: '1', discrepancy_reason_code: 'transit_loss' }])).status).toBe(200);
    expect(await bal(s, S1, IT, LA)).toEqual({ q: 0, v: 0 });
  });
  run('the loss appears in the wastage report at the source: listStockMovements(movement_kind wastage, store S1, lot LA) shows the -2 with reason transit_loss', async (s) => {
    const d = await dispatchedLA(s);
    await receive(s, d, [{ line_id: d.lines[0].id, received_qty_base: '98', discrepancy_reason_code: 'transit_loss' }]);
    const r = await s.call(A, 'listStockMovements', { query: { store_id: S1, movement_kind: 'wastage', lot_id: LA } }, { permissions: [READ] });
    expect(r.body.data.map((m: any) => [m.movement_kind, qty(m.qty_base), m.reason_code, m.doc_id])).toEqual([['wastage', -2, 'transit_loss', d.id]]);
  });
  run('the wastage carries the LINE\'s discrepancy code (damaged_in_transit), not a hard-coded one', async (s) => {
    const d = await dispatchedLA(s);
    await receive(s, d, [{ line_id: d.lines[0].id, received_qty_base: '90', discrepancy_reason_code: 'damaged_in_transit' }]);
    const ms = await moves(s, d.id);
    expect(ofKind(ms, 'wastage', S1)[0]).toMatchObject({ qn: -10, reason_code: 'damaged_in_transit' });
    expect(ofKind(ms, 'transfer_in', S2)[0]).toMatchObject({ qn: 90, vn: 29993 }); // 90 x 33325 / 100 = 29992.5 -> half up 29993
    expect(ofKind(ms, 'transfer_in', S1)[0]).toMatchObject({ qn: 10, vn: 3332 }); // 33325 - 29993
    expect((await dbLines(s, d.id))[0]).toMatchObject({ discrepancy_reason_code: 'damaged_in_transit' });
  });
  run('received = dispatched: destination +100 at the full dispatched value, NO source pair, no wastage', async (s) => {
    const d = await dispatchedLA(s);
    await receive(s, d, [{ line_id: d.lines[0].id, received_qty_base: '100' }]);
    const ms = await moves(s, d.id);
    expect(ms).toHaveLength(2);
    expect(ofKind(ms, 'transfer_in', S2)[0]).toMatchObject({ qn: 100, vn: 33325, lot_id: LA });
    expect(ofKind(ms, 'wastage')).toEqual([]);
    expect(ofKind(ms, 'transfer_in', S1)).toEqual([]);
    expect(await bal(s, S2, IT, LA)).toEqual({ q: 100, v: 33325 });
  });
  run('received 0 (everything lost): no destination movement; source +100 / -100 pair at the full value; the transfer is received', async (s) => {
    const d = await dispatchedLA(s);
    const r = await receive(s, d, [{ line_id: d.lines[0].id, received_qty_base: '0', discrepancy_reason_code: 'transit_loss' }]);
    expect(r.body.status).toBe('received');
    const ms = await moves(s, d.id);
    expect(ofKind(ms, 'transfer_in', S2)).toEqual([]);
    expect(ofKind(ms, 'transfer_in', S1)[0]).toMatchObject({ qn: 100, vn: 33325, basis: 'transfer' });
    expect(ofKind(ms, 'wastage', S1)[0]).toMatchObject({ qn: -100, vn: -33325, reason_code: 'transit_loss' });
    expect(await bal(s, S1, IT, LA)).toEqual({ q: 0, v: 0 });
    expect(await bal(s, S2, IT, LA)).toEqual({ q: 0, v: 0 });
  });
  run('pro-rata on a part dispatch: 3 of LB dispatched (V = 43), 2 received -> destination 29 (28.667), source pair of 1 at 14; the source row ends at 4 / 57', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IT, '3', LB)]);
    const dd = (await dispatch(s, d)).body;
    await receive(s, dd, [{ line_id: dd.lines[0].id, received_qty_base: '2', discrepancy_reason_code: 'count_error' }]);
    const ms = await moves(s, d.id);
    expect(ofKind(ms, 'transfer_in', S2)[0]).toMatchObject({ qn: 2, vn: 29 });
    expect(ofKind(ms, 'transfer_in', S1)[0]).toMatchObject({ qn: 1, vn: 14 });
    expect(ofKind(ms, 'wastage', S1)[0]).toMatchObject({ qn: -1, vn: -14, reason_code: 'count_error' });
    expect(await bal(s, S1, IT, LB)).toEqual({ q: 4, v: 57 });
    expect(await bal(s, S2, IT, LB)).toEqual({ q: 2, v: 29 });
  });
  run('a non-lot-tracked item: 25 dispatched (2500), 20 received -> destination unlotted row +20 at 2000; source pair of 5 at 500 on the unlotted row; the source nets -25', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IU, '25')]);
    const dd = (await dispatch(s, d)).body;
    await receive(s, dd, [{ line_id: dd.lines[0].id, received_qty_base: '20', discrepancy_reason_code: 'transit_loss' }]);
    const ms = await moves(s, d.id);
    expect(ofKind(ms, 'transfer_in', S2)[0]).toMatchObject({ lot_id: null, qn: 20, vn: 2000 });
    expect(ofKind(ms, 'transfer_in', S1)[0]).toMatchObject({ lot_id: null, qn: 5, vn: 500 });
    expect(ofKind(ms, 'wastage', S1)[0]).toMatchObject({ lot_id: null, qn: -5, vn: -500 });
    expect(await bal(s, S1, IU, null)).toEqual({ q: 0, v: 0 });
    expect(await bal(s, S2, IU, null)).toEqual({ q: 20, v: 2000 });
  });
  run('a FEFO-split transfer receives per (rewritten) line: FA 10 fully, FB 15 -> 14 with a reason; each line pairs only its own shortfall', async (s) => {
    const dd = (await dispatch(s, await mk(s, S1, S2, [trLine(IF_, '25')]))).body;
    const [la, lb] = dd.lines;
    await receive(s, dd, [{ line_id: la.id, received_qty_base: '10' }, { line_id: lb.id, received_qty_base: '14', discrepancy_reason_code: 'transit_loss' }]);
    const ms = await moves(s, dd.id);
    expect(ofKind(ms, 'transfer_in', S2).map((m: any) => [m.lot_id, m.qn, m.vn]).sort()).toEqual([[FA, 10, 1000], [FB, 14, 1400]].sort());
    expect(ofKind(ms, 'wastage', S1).map((m: any) => [m.lot_id, m.qn, m.vn])).toEqual([[FB, -1, -100]]);
    expect(ofKind(ms, 'transfer_in', S1).map((m: any) => [m.lot_id, m.qn, m.vn])).toEqual([[FB, 1, 100]]);
  });
  run('two lines, one short one whole, in one request: all movements post in the same transaction; response lines carry received_qty_base per line', async (s) => {
    const dd = (await dispatch(s, await mk(s, S1, S2, [trLine(IT, '3', LB), trLine(IU, '25')]))).body;
    const r = await receive(s, dd, [{ line_id: dd.lines[0].id, received_qty_base: '3' }, { line_id: dd.lines[1].id, received_qty_base: '24', discrepancy_reason_code: 'other' }]);
    expect(r.body.lines.map((l: any) => qty(l.received_qty_base))).toEqual([3, 24]);
    expect(r.body.lines[0].discrepancy_reason_code ?? null).toBeNull();
    expect(r.body.lines[1].discrepancy_reason_code).toBe('other');
  });
  run('without cost.read the receive response carries no dispatched_value_paisa; the movements still carry their values in the DB', async (s) => {
    const d = await dispatchedLA(s);
    const r = await receive(s, d, [{ line_id: d.lines[0].id, received_qty_base: '98', discrepancy_reason_code: 'transit_loss' }]);
    expect(Object.keys(r.body.lines[0])).not.toContain('dispatched_value_paisa');
  });
  run('reason required: received < dispatched without a code -> 422 inventory.reason_required, nothing posted, still dispatched', async (s) => {
    const d = await dispatchedLA(s);
    const before = await stockSnapshot(s);
    await expectLims(receive(s, d, [{ line_id: d.lines[0].id, received_qty_base: '98' }]), 'inventory.reason_required', 422);
    expect(await stockSnapshot(s)).toBe(before);
    expect(await dbTransfer(s, d.id)).toMatchObject({ status: 'dispatched', version: d.version });
  });
  run('an unknown code, or a code of another reason group (wastage "spillage"), is not a discrepancy reason -> 422 inventory.reason_required', async (s) => {
    const d = await dispatchedLA(s);
    for (const code of ['no_such_code', 'spillage']) await expectLims(receive(s, d, [{ line_id: d.lines[0].id, received_qty_base: '98', discrepancy_reason_code: code }]), 'inventory.reason_required', 422);
  });
  run('received > dispatched -> 400 common.validation_failed (never an over-receipt), nothing posted', async (s) => {
    const d = await dispatchedLA(s);
    const before = await stockSnapshot(s);
    await expectLims(receive(s, d, [{ line_id: d.lines[0].id, received_qty_base: '100.000001', discrepancy_reason_code: 'other' }]), 'common.validation_failed', 400);
    expect(await stockSnapshot(s)).toBe(before);
  });
  run('every line must be given: omitting one of two -> 400; the same line twice -> 400; a line of ANOTHER transfer or a soft-removed line -> 404', async (s) => {
    const dd = (await dispatch(s, await mk(s, S1, S2, [trLine(IT, '3', LB), trLine(IU, '25')]))).body;
    const [l1, l2] = dd.lines;
    const before = await stockSnapshot(s);
    await expectLims(receive(s, dd, [{ line_id: l1.id, received_qty_base: '3' }]), 'common.validation_failed', 400);
    await expectLims(receive(s, dd, [{ line_id: l1.id, received_qty_base: '3' }, { line_id: l1.id, received_qty_base: '3' }]), 'common.validation_failed', 400);
    await nf(receive(s, dd, [{ line_id: l1.id, received_qty_base: '3' }, { line_id: uid(8711), received_qty_base: '3' }]));
    await nf(receive(s, dd, [{ line_id: l1.id, received_qty_base: '3' }, { line_id: uid(8712), received_qty_base: '3' }]));
    expect(l2.id).toBeTruthy();
    expect(await stockSnapshot(s)).toBe(before);
  });
  run('receiving at a destination whose balance row does not exist yet creates it (no insufficient_stock, no error)', async (s) => {
    expect(await bal(s, S3, IT, LA)).toEqual({ q: 0, v: 0 });
    const dd = (await dispatch(s, await mk(s, S1, S3, [trLine(IT, '100', LA)]))).body;
    await receive(s, dd, [{ line_id: dd.lines[0].id, received_qty_base: '100' }]);
    expect(await bal(s, S3, IT, LA)).toEqual({ q: 100, v: 33325 });
  });
});

// ======================================================================================================== AC-10.4 transitions
describe.skipIf(!live)('T-13 AC-10.4 forbidden transitions -> 409 inventory.document_invalid_transition (CR-C12-003)', () => {
  const lineBody = [trLine(IT, '1', LA)];
  async function states(s: Sess) {
    const draft = await mk(s, S1, S2, lineBody);
    const disp = (await dispatch(s, await mk(s, S1, S2, lineBody))).body;
    const rec0 = (await dispatch(s, await mk(s, S1, S2, lineBody))).body;
    const received = (await receive(s, rec0, [{ line_id: rec0.lines[0].id, received_qty_base: '1' }])).body;
    const canc = (await cancel(s, await mk(s, S1, S2, lineBody))).body;
    return { draft, disp, received, canc };
  }
  const act = (s: Sess, op: string, t: any) => op === 'dispatch' ? dispatch(s, t) : op === 'receive' ? receive(s, t, [{ line_id: t.lines[0].id, received_qty_base: '1' }]) : op === 'cancel' ? cancel(s, t) : replace(s, t, lineBody);
  const MATRIX: [string, string][] = [
    ['draft', 'receive'],
    ['dispatched', 'dispatch'], ['dispatched', 'cancel'], ['dispatched', 'replace'],
    ['received', 'dispatch'], ['received', 'receive'], ['received', 'cancel'], ['received', 'replace'],
    ['cancelled', 'dispatch'], ['cancelled', 'receive'], ['cancelled', 'cancel'], ['cancelled', 'replace'],
  ];
  const pick = (st: Awaited<ReturnType<typeof states>>, name: string) => (name === 'draft' ? st.draft : name === 'dispatched' ? st.disp : name === 'received' ? st.received : st.canc);
  for (const [from, op] of MATRIX) {
    run(`${from} -> ${op} is refused 409 inventory.document_invalid_transition; no stock, no row change`, async (s) => {
      const st = await states(s);
      const t = pick(st, from);
      const before = await stockSnapshot(s);
      const v = (await dbTransfer(s, t.id)).version;
      await invalid(act(s, op, t));
      expect(await stockSnapshot(s)).toBe(before);
      expect((await dbTransfer(s, t.id)).version).toBe(v);
    });
  }
  run('the transition check comes before the If-Match check: a STALE version on a received transfer is still document_invalid_transition (not version_conflict)', async (s) => {
    const { received } = await states(s);
    await invalid(s.call(A, 'dispatchTransfer', { params: { transfer_id: received.id }, headers: ifm(1) }));
  });
  run('draft -> cancelled: status cancelled, cancelled_at / reason stored, no movements; draft -> dispatched -> received are the only forward edges', async (s) => {
    const d = await mk(s, S1, S2, lineBody);
    const before = await stockSnapshot(s);
    const r = await cancel(s, d, undefined, cancelBody({ reason_text: 'Synthetic duplicate' }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'cancelled', cancel_reason_text: 'Synthetic duplicate', version: d.version + 1 });
    expect(r.body.cancelled_at).toBeTypeOf('string');
    expect(await dbTransfer(s, d.id)).toMatchObject({ status: 'cancelled', cancelled_by: SYS });
    expect(await stockSnapshot(s)).toBe(before);
  });
  run('a stale If-Match on a draft -> 409 common.version_conflict for #59 #60 #62 (and the row is unchanged)', async (s) => {
    const d = await mk(s, S1, S2, lineBody);
    const stale = { id: d.id, version: d.version + 5 };
    await expectLims(replace(s, stale, lineBody), 'common.version_conflict', 409);
    await expectLims(dispatch(s, stale), 'common.version_conflict', 409);
    await expectLims(cancel(s, stale), 'common.version_conflict', 409);
    expect(await dbTransfer(s, d.id)).toMatchObject({ status: 'draft', version: d.version });
  });
  run('a stale If-Match on a dispatched transfer -> 409 common.version_conflict for #61', async (s) => {
    const dd = (await dispatch(s, await mk(s, S1, S2, lineBody))).body;
    await expectLims(receive(s, { id: dd.id, version: dd.version + 5 }, [{ line_id: dd.lines[0].id, received_qty_base: '1' }]), 'common.version_conflict', 409);
    expect(await dbTransfer(s, dd.id)).toMatchObject({ status: 'dispatched', version: dd.version });
  });
});

// ======================================================================================================== #59 draft replace (D-71)
describe.skipIf(!live)('T-13 #59 replaceTransferDraft: soft removal, never delete (D-71, TRD §5.11)', () => {
  run('the fixture draft 8701 (current lines 8711, 8713): replace with ONE new line -> both old lines get removed_at / removed_by, one new line (new id, line_no 1), 3 rows kept in total', async (s) => {
    const t0 = await dbTransfer(s, TR_DRAFT);
    const before = await dbLines(s, TR_DRAFT);
    expect(before).toHaveLength(3); // 8711, 8712 (already removed), 8713
    const r = await replace(s, { id: TR_DRAFT, version: t0.version }, [trLine(IT, '12', LA)]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: TR_DRAFT, status: 'draft', version: t0.version + 1, from_store_id: MAIN, to_store_id: BENCH_ST });
    expect(r.body.lines).toHaveLength(1);
    expect(r.body.lines[0]).toMatchObject({ line_no: 1, item_id: IT, lot_id: LA });
    expect(qty(r.body.lines[0].qty_base)).toBe(12);
    expect([uid(8711), uid(8712), uid(8713)]).not.toContain(r.body.lines[0].id);
    const all = await dbLines(s, TR_DRAFT);
    expect(all).toHaveLength(4); // nothing deleted
    const byId = Object.fromEntries(all.map((l: any) => [l.id, l]));
    for (const id of [uid(8711), uid(8712), uid(8713)]) expect(byId[id].removed_at).not.toBeNull();
    for (const id of [uid(8711), uid(8713)]) expect(byId[id].removed_by).toBe(SYS);
    expect(all.filter((l: any) => l.removed_at === null)).toHaveLength(1);
    expect((await dbTransfer(s, TR_DRAFT)).transfer_no).toBe('TR260000001'); // the number survives the replace
  });
  run('replace changes notes and lines but never the stores or the number; a second replace again soft-removes the first replacement', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IT, '1', LA)], undefined, { notes: 'first' });
    const r1 = await s.call(A, 'replaceTransferDraft', { params: { transfer_id: d.id }, headers: ifm(d.version), body: replaceBody([trLine(IT, '2', LA), trLine(IU, '3')], { notes: 'second' }) });
    expect(r1.body).toMatchObject({ from_store_id: S1, to_store_id: S2, transfer_no: d.transfer_no, notes: 'second' });
    expect(r1.body.lines.map((l: any) => l.line_no)).toEqual([1, 2]);
    const r2 = await replace(s, r1.body, [trLine(IT, '4', LB)]);
    expect(r2.body.lines).toHaveLength(1);
    const all = await dbLines(s, d.id);
    expect(all).toHaveLength(4);
    expect(all.filter((l: any) => l.removed_at !== null)).toHaveLength(3);
  });
  run('replace stays a draft: no stock effect; the new lines are validated as on create (unknown lot -> 404, uom mismatch -> 422) and a failed replace leaves the old lines current', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IT, '1', LA)]);
    const before = await stockSnapshot(s);
    await nf(replace(s, d, [trLine(IT, '1', uid(99020))]));
    await expectLims(replace(s, d, [trLine(CTRL, '1', null, { pack_id: BOX })]), 'inventory.uom_mismatch', 422);
    expect(await stockSnapshot(s)).toBe(before);
    const all = await dbLines(s, d.id);
    expect(all).toHaveLength(1);
    expect(all[0].removed_at).toBeNull();
    expect(await dbTransfer(s, d.id)).toMatchObject({ version: d.version });
  });
  run('IT-1 / D-71: the application role has no DELETE on transfer_lines (the replace could only ever soft-remove)', async (s) => {
    const r = await s.sql(A, "SELECT has_table_privilege(current_user, 'inventory.transfer_lines', 'DELETE') AS d, has_table_privilege(current_user, 'inventory.transfers', 'DELETE') AS h", []);
    expect(r[0]).toEqual({ d: false, h: false });
  });
  run('IT-1a service half: replacing the lines of a DISPATCHED transfer is refused (409 invalid transition) and no line is soft-removed', async (s) => {
    const d = await dispatchedLA(s);
    const before = await dbLines(s, d.id);
    await invalid(replace(s, d, [trLine(IT, '1', LA)]));
    const after = await dbLines(s, d.id);
    expect(after).toHaveLength(before.length);
    expect(after.every((l: any) => l.removed_at === null)).toBe(true);
  });
  // IT-1a DB half: enforced once the inventory migration ships tg_line_guard (05-SCHEMA §5)
  it.skipIf(!hasTrigger)('IT-1a DB half: setting removed_at on a line of a DISPATCHED transfer is refused by the database (tg_line_guard, P0001)', () => session(async (s) => {
    const d = await dispatchedLA(s);
    const e = await rej(s.sql(A, 'UPDATE inventory.transfer_lines SET removed_at = now(), removed_by = $2 WHERE id = $1', [d.lines[0].id, SYS]));
    expect((e as { code?: string }).code).toBe('P0001');
  }));
});

// ======================================================================================================== AC-10.3 scope (assertTransferAccess two-branch scope, P-B3)
describe.skipIf(!live)('T-13 AC-10.3 / P-B3 / P-B8: two-branch scope', () => {
  run('a user scoped to BR-1 only: creates and dispatches BR1 -> BR2 (assertRole on the SOURCE branch), but receiving is 403 auth.forbidden (visible as the source, the destination end is outside scope)', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IT, '1', LA)], BR1_ONLY);
    const dd = (await dispatch(s, d, BR1_ONLY)).body;
    expect(dd.status).toBe('dispatched');
    expect(s.roleCalls).toContainEqual({ permission: MANAGE, branchId: BR1 });
    expect(s.roleCalls.filter((c) => c.branchId === BR2)).toEqual([]);
    const before = await stockSnapshot(s);
    await forbidden(receive(s, dd, [{ line_id: dd.lines[0].id, received_qty_base: '1' }], BR1_ONLY));
    expect(await stockSnapshot(s)).toBe(before);
    expect((await get(s, dd.id, BR1_ONLY)).status).toBe(200);
  });
  run('a user scoped to BR-2 only: sees the transfer (get / list), receives it, but dispatch / replace / cancel are 403 (visible as the destination, the source end is outside scope)', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IT, '1', LA)]);
    expect((await get(s, d.id, BR2_ONLY)).status).toBe(200);
    await forbidden(dispatch(s, d, BR2_ONLY));
    await forbidden(replace(s, d, [trLine(IT, '2', LA)], BR2_ONLY));
    await forbidden(cancel(s, d, BR2_ONLY));
    expect(await dbTransfer(s, d.id)).toMatchObject({ status: 'draft', version: d.version });
    const dd = (await dispatch(s, d)).body;
    const r = await receive(s, dd, [{ line_id: dd.lines[0].id, received_qty_base: '1' }], BR2_ONLY);
    expect(r.body.status).toBe('received');
    expect(s.roleCalls).toContainEqual({ permission: MANAGE, branchId: BR2 });
  });
  run('creating needs the SOURCE branch: a BR-1 user may name a BR-2 destination; a BR-1 user naming a BR-2 SOURCE gets 404 (the store is not visible; 404 beats 403)', async (s) => {
    expect((await s.call(A, 'createTransfer', { body: newTransfer(S1, S2, [trLine(IT, '1', LA)]) }, BR1_ONLY)).status).toBe(201);
    const before = await count(s, 'transfers');
    await nf(s.call(A, 'createTransfer', { body: newTransfer(S2, S1, [trLine(IT, '1', LA)]) }, BR1_ONLY));
    expect(await count(s, 'transfers')).toBe(before);
  });
  run('a user with no visible branch: get / replace / dispatch / receive / cancel -> 404 common.not_found (the transfer is invisible; never 403), list -> empty', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IT, '1', LA)]);
    const dd = (await dispatch(s, await mk(s, S1, S2, [trLine(IT, '1', LA)]))).body;
    const n0 = s.roleCalls.length;
    await nf(get(s, d.id, NOBODY));
    await nf(replace(s, d, [trLine(IT, '2', LA)], NOBODY));
    await nf(dispatch(s, d, NOBODY));
    await nf(cancel(s, d, NOBODY));
    await nf(receive(s, dd, [{ line_id: dd.lines[0].id, received_qty_base: '1' }], NOBODY));
    expect(s.roleCalls.slice(n0)).toEqual([]); // 404 beats 403: no permission decision was ever made
    expect((await s.call(A, 'listTransfers', {}, NOBODY)).body.data).toEqual([]);
  });
  run('a transfer between two BR-1 stores is invisible to a BR-2 user (neither end visible): get / dispatch -> 404, absent from the list; visible to BR-1 and to centre-wide users', async (s) => {
    const d = await mk(s, S1, S3, [trLine(IT, '1', LA)]);
    await nf(get(s, d.id, BR2_ONLY));
    await nf(dispatch(s, d, BR2_ONLY));
    expect((await s.call(A, 'listTransfers', { query: { limit: 200 } }, BR2_ONLY)).body.data.map((t: any) => t.id)).not.toContain(d.id);
    expect((await s.call(A, 'listTransfers', { query: { limit: 200 } }, BR1_ONLY)).body.data.map((t: any) => t.id)).toContain(d.id);
    expect((await get(s, d.id)).status).toBe(200);
  });
  run('without inventory.stock.manage at a visible end -> 403 auth.forbidden (read-only user: item.read only); reads still work', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IT, '1', LA)]);
    const RO: LotOpts = { permissions: [READ] };
    await forbidden(dispatch(s, d, RO));
    await forbidden(replace(s, d, [trLine(IT, '2', LA)], RO));
    await forbidden(cancel(s, d, RO));
    await forbidden(s.call(A, 'createTransfer', { body: newTransfer(S1, S2, [trLine(IT, '1', LA)]) }, RO));
    expect((await get(s, d.id, RO)).status).toBe(200);
    await forbidden(s.call(A, 'getTransfer', { params: { transfer_id: d.id } }, { permissions: [] }));
  });
  run('#56 list: transfers whose from OR to store is visible; each row is a TransferSummary (strict keys); filters from_store_id / to_store_id / status; limit + cursor page without duplicates', async (s) => {
    const a = await mk(s, S1, S2, [trLine(IT, '1', LA)]);
    const b = await mk(s, S1, S2, [trLine(IT, '1', LB)]);
    const c = await mk(s, S1, S3, [trLine(IT, '1', LA)]);
    const bd = (await dispatch(s, b)).body;
    const all = await s.call(A, 'listTransfers', { query: { from_store_id: S1, limit: 200 } });
    expect(all.status).toBe(200);
    expect(all.body.data.map((t: any) => t.id)).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
    for (const t of all.body.data) expect(onlyKeys(t, SUMMARY_KEYS)).toEqual([]);
    expect(typeof all.body.page).toBe('object');
    expect((await s.call(A, 'listTransfers', { query: { to_store_id: S3, limit: 200 } })).body.data.map((t: any) => t.id)).toEqual([c.id]);
    expect((await s.call(A, 'listTransfers', { query: { from_store_id: S1, to_store_id: S2, status: 'dispatched', limit: 200 } })).body.data.map((t: any) => t.id)).toEqual([bd.id]);
    expect((await s.call(A, 'listTransfers', { query: { from_store_id: S1, to_store_id: S2, status: 'draft', limit: 200 } })).body.data.map((t: any) => t.id)).toEqual([a.id]);
    const p1 = await s.call(A, 'listTransfers', { query: { from_store_id: S1, to_store_id: S2, limit: 1 } });
    expect(p1.body.data).toHaveLength(1);
    expect(typeof p1.body.page.next_cursor).toBe('string');
    const p2 = await s.call(A, 'listTransfers', { query: { from_store_id: S1, to_store_id: S2, limit: 1, cursor: p1.body.page.next_cursor } });
    expect(p2.body.data).toHaveLength(1);
    expect(p2.body.data[0].id).not.toBe(p1.body.data[0].id);
  });
  run('#56 as BR-2 user lists BR1->BR2 transfers but not BR1->BR1 ones', async (s) => {
    const x = await mk(s, S1, S2, [trLine(IT, '1', LA)]);
    const y = await mk(s, S1, S3, [trLine(IT, '1', LA)]);
    const ids = (await s.call(A, 'listTransfers', { query: { limit: 200 } }, BR2_ONLY)).body.data.map((t: any) => t.id);
    expect(ids).toContain(x.id);
    expect(ids).not.toContain(y.id);
  });
});

// ======================================================================================================== AC-19.4 count lock (T-13 side: dispatch + receive)
describe.skipIf(!live)('T-13 AC-19.4: count_locks_store blocks manual transfer movements while a count is open', () => {
  const lock = async (s: Sess, store: string, on = true) => {
    await s.sql(A, 'UPDATE inventory.settings SET count_locks_store = $2 WHERE tenant_id = $1', [A, on]);
    await s.sql(A, "INSERT INTO inventory.stock_counts (id, tenant_id, count_no, store_id, status, snapshot_at, created_by, updated_by) VALUES ($1, $2, $3, $4, 'open', now(), $5, $5)",
      [uid(14800 + Math.floor(Math.random() * 100000)), A, `SC9${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`, store, SYS]);
  };
  run('dispatch from a store with an open count and count_locks_store = true -> 409 inventory.store_locked_for_count, nothing posted, still draft', async (s) => {
    const d = await mk(s, S5, S2, [trLine(IT, '5', LA)]);
    await lock(s, S5);
    const before = await stockSnapshot(s);
    await expectLims(dispatch(s, d), 'inventory.store_locked_for_count', 409);
    expect(await stockSnapshot(s)).toBe(before);
    expect(await dbTransfer(s, d.id)).toMatchObject({ status: 'draft' });
  });
  run('count_locks_store = false (default): the same open count does not block the dispatch', async (s) => {
    const d = await mk(s, S5, S2, [trLine(IT, '5', LA)]);
    await lock(s, S5, false);
    expect((await dispatch(s, d)).body.status).toBe('dispatched');
  });
  run('receive into a locked destination -> 409 inventory.store_locked_for_count; the transfer stays dispatched (stock in transit)', async (s) => {
    const dd = (await dispatch(s, await mk(s, S1, S6, [trLine(IT, '1', LA)]))).body;
    await lock(s, S6);
    const before = await stockSnapshot(s);
    await expectLims(receive(s, dd, [{ line_id: dd.lines[0].id, received_qty_base: '1' }]), 'inventory.store_locked_for_count', 409);
    expect(await stockSnapshot(s)).toBe(before);
    expect(await dbTransfer(s, dd.id)).toMatchObject({ status: 'dispatched' });
  });
  run('cancelling a draft and replacing a draft are not movements: allowed under a lock', async (s) => {
    const d = await mk(s, S5, S2, [trLine(IT, '5', LA)]);
    await lock(s, S5);
    const r = await replace(s, d, [trLine(IT, '6', LA)]);
    expect((await cancel(s, r.body)).body.status).toBe('cancelled');
  });
});

// ======================================================================================================== tenant probes (P-T1 / P-T3 / P-T4)
describe.skipIf(!live)('T-13 probes: cross-tenant (07-SECURITY P-T1..P-T4)', () => {
  const snapB = async (s: Sess) => JSON.stringify([await dbTransfer(s, TR_B, B), await dbLines(s, TR_B, B), await s.sql(B, 'SELECT count(*) AS n FROM inventory.stock_movements WHERE tenant_id = $1', [B]),
    await s.sql(B, 'SELECT id, qty_base, value_paisa, version FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [B])]);
  run('tenant A with tenant B\'s transfer id: get / replace / dispatch / receive / cancel -> 404 common.not_found, no B data, no row change in B', async (s) => {
    const before = await snapB(s);
    const bt = await dbTransfer(s, TR_B, B);
    await nf(get(s, TR_B));
    await nf(replace(s, { id: TR_B, version: bt.version }, [trLine(IT, '1', LA)]));
    await nf(dispatch(s, { id: TR_B, version: bt.version }));
    await nf(cancel(s, { id: TR_B, version: bt.version }));
    await nf(receive(s, { id: TR_B, version: bt.version }, [{ line_id: TRL_B, received_qty_base: '1' }]));
    expect(await snapB(s)).toBe(before);
  });
  run('tenant B reads its own transfer; its lines are B\'s only; A\'s transfers are 404 for B', async (s) => {
    const r = await get(s, TR_B, undefined, B);
    expect(r.body.id).toBe(TR_B);
    expect(r.body.lines.map((l: any) => l.item_id)).toEqual([GLU_B]);
    await nf(get(s, TR_DRAFT, undefined, B));
    await nf(s.call(B, 'dispatchTransfer', { params: { transfer_id: TR_DISP }, headers: ifm(1) }));
  });
  run('P-T3 create in A referencing a B store (from or to), item, lot -> 404 common.not_found; no transfer row in either tenant', async (s) => {
    const beforeA = await count(s, 'transfers');
    const beforeB = Number((await s.sql(B, 'SELECT count(*) AS n FROM inventory.transfers WHERE tenant_id = $1', [B]))[0].n);
    await nf(s.call(A, 'createTransfer', { body: newTransfer(MAIN_B, S2, [trLine(IT, '1', LA)]) }));
    await nf(s.call(A, 'createTransfer', { body: newTransfer(S1, BENCH_B, [trLine(IT, '1', LA)]) }));
    await nf(s.call(A, 'createTransfer', { body: newTransfer(S1, S2, [trLine(GLU_B, '1')]) }));
    await nf(s.call(A, 'createTransfer', { body: newTransfer(S1, S2, [trLine(GLU, '1', LOT_B)]) }));
    expect(await count(s, 'transfers')).toBe(beforeA);
    expect(Number((await s.sql(B, 'SELECT count(*) AS n FROM inventory.transfers WHERE tenant_id = $1', [B]))[0].n)).toBe(beforeB);
  });
  run('P-T4 a replace that mixes A lines with a B lot fails as a whole: the A draft keeps its current lines', async (s) => {
    const d = await mk(s, S1, S2, [trLine(IT, '1', LA)]);
    await nf(replace(s, d, [trLine(IT, '2', LA), trLine(GLU, '1', LOT_B)]));
    const all = await dbLines(s, d.id);
    expect(all).toHaveLength(1);
    expect(all[0].removed_at).toBeNull();
  });
  run('P-T2 list as A: no B transfer, even when asking for B\'s store; list as B: no A transfer', async (s) => {
    const a = await s.call(A, 'listTransfers', { query: { limit: 200 } });
    expect(a.body.data.map((t: any) => t.id)).not.toContain(TR_B);
    try { expect((await s.call(A, 'listTransfers', { query: { from_store_id: MAIN_B } })).body.data).toEqual([]); } catch (e) { expect((e as { code?: string }).code).toBe('common.not_found'); }
    const b = await s.call(B, 'listTransfers', { query: { limit: 200 } });
    expect(b.body.data.map((t: any) => t.id)).toEqual([TR_B]);
  });
});

// ======================================================================================================== races (committed)
describe.skipIf(!live)('T-13 races (committed transactions)', () => {
  const mkCommitted = async (from: string, to: string, lines: Record<string, unknown>[]) => committed((s) => mk(s, from, to, lines));
  const attempt = (fn: (s: Sess) => Promise<unknown>) => committed(fn).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, code: (e as { code?: string }).code ?? String(e) }));
  it('two dispatches of the SAME transfer at once: exactly one wins; the loser gets 409 (invalid transition or version conflict); ONE transfer_out exists', async () => {
    const d = await mkCommitted(S7, S2, [trLine(IR, '10', LR2)]);
    const rs = await Promise.all([attempt((s) => dispatch(s, d)), attempt((s) => dispatch(s, d))]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    const lost = rs.find((r) => !r.ok) as { code: string };
    expect(['inventory.document_invalid_transition', 'common.version_conflict']).toContain(lost.code);
    const n = Number((await admin.query('SELECT count(*) AS n FROM inventory.stock_movements WHERE doc_id = $1 AND movement_kind = $2', [d.id, 'transfer_out'])).rows[0].n);
    expect(n).toBe(1);
    const b = (await admin.query('SELECT qty_base::text AS q FROM inventory.stock_balances WHERE store_id = $1 AND lot_id = $2', [S7, LR2])).rows[0];
    expect(Number(b.q)).toBe(0);
  });
  it('two DIFFERENT transfers compete for the same 10 units: exactly one dispatches, the other is 409 inventory.insufficient_stock; the balance never goes negative', async () => {
    const [t1, t2] = [await mkCommitted(S7, S2, [trLine(IR, '10', LR1)]), await mkCommitted(S7, S2, [trLine(IR, '10', LR1)])];
    const rs = await Promise.all([attempt((s) => dispatch(s, t1)), attempt((s) => dispatch(s, t2))]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect((rs.find((r) => !r.ok) as { code: string }).code).toBe('inventory.insufficient_stock');
    const b = (await admin.query('SELECT qty_base::text AS q FROM inventory.stock_balances WHERE store_id = $1 AND lot_id = $2', [S7, LR1])).rows[0];
    expect(Number(b.q)).toBe(0);
    const st = (await admin.query('SELECT status FROM inventory.transfers WHERE id = ANY($1::uuid[]) ORDER BY status', [[t1.id, t2.id]])).rows.map((r) => r.status);
    expect(st).toEqual(['dispatched', 'draft']);
  });
  it('two receives of the SAME dispatched transfer at once: exactly one posts; the destination is credited once', async () => {
    const d = await mkCommitted(S7, S2, [trLine(IR, '1', LR3)]);
    const dd = (await committed((s) => dispatch(s, d))).body;
    const rs = await Promise.all([1, 2].map(() => attempt((s) => receive(s, dd, [{ line_id: dd.lines[0].id, received_qty_base: '1' }]))));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect((await admin.query("SELECT count(*) AS n FROM inventory.stock_movements WHERE doc_id = $1 AND movement_kind = 'transfer_in'", [dd.id])).rows[0].n).toBe('1');
  });
});
