// C12.T-15 integration + probes for #69-#79 on the migrated database as role lims_api with RLS on (REAL T-03 repositories, handlers/index.ts, T-04 scope service, T-05 ledger; CatalogPort = fake).
// Harness: tests/db/c12-t15/run.sh (clone of c12-t14: pinned image, migrations, seeds, inventory DDL, exports LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL / LIMS_C12T03_REQUIRE_DB=1).
// Fixtures: tests/db/c12-t03/fixtures.sql (rules 7001-7005 / 7101, facts 7201 7203 unresolved 7202 posted (store 1001) / B 7301, bindings 9401 (421 -> 1001) 9402 INACTIVE (422), store 1001 = default consumption of BR1)
//   + EXTRAS below (ids 16xxx, committed once with the superuser, ON CONFLICT DO NOTHING / unique ids).
// Each test = one request-shaped transaction that is ROLLED BACK (rules, bindings, settings changes are made INSIDE it); every handler call runs inside a SAVEPOINT. Race tests COMMIT and use their own rows.
// EXTRAS (tenant A): tests TA TB TC; analytes AN1 AN2 (TA) AN3 (TB); instruments I1 (centre a201 -> BR1, unbound) I2 (centre a202 -> BR2, unbound) I3 (a201, bound to S3, races only);
//   stores S1 (BR1 main) D2 (BR2 main, DEFAULT consumption of BR2) S3 (BR1 bench) S2 (BR2 bench) SI (BR1, INACTIVE); items IT1 (reagent, lot tracked, base test) IT2 (consumable, unlotted) IT3 (reagent, lot tracked, ml);
//   pack PK1 (IT1, 100 base); lots LA (IT1, +90 d) LB (IT1, +30 d: FEFO first) LC (IT3).
//   Balances: S1 IT1/LA 100 worth 10000, IT1/LB 7 worth 1000, IT2 50 worth 500, IT3/LC 100 worth 5000; D2 IT1/LA 100 worth 10000, IT2 50 worth 500; 1001 IT2 50 worth 500; S3 IT2 1000 worth 10000; S2 IT2 50 worth 500.
//   Committed for the races: rules RC1 (per_test TC IT2 qty 1) RC2 (per_calibration TC IT2 qty 1), binding I3 -> S3, unresolved fact FR, event-sourced posted fact FE (store S1).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ledger from '../../service/ledger.service.js';
import {
  A, ADJUST, B, BENCH, BR1, BR2, COST, FACT_KEYS, LEAK, MANAGE, PREVIEW_KEYS, PREVIEW_LINE_KEYS, READ, RULE_KEYS, SECRET_FACT_KEYS, SYS, addDays, call, calBody, expectLims, ifm, makeConsCtx, onlyKeys,
  previewBody, qcBody, reasonBody, resolveBody, ruleBody, supersedeBody, uid, ymdIn, type ConsOpts,
} from './consumption.helpers.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const KT = 'Asia/Kathmandu';

// fixtures (T-03)
const MAIN_A = uid(1001), FIX_TEST = uid(7001), FIX_R1 = uid(7001), FIX_R2 = uid(7002), FIX_R_OLD = uid(7003), FIX_R_DAY = uid(7004), FIX_R_INACT = uid(7005), FIX_R_B = uid(7101);
const FACT_U1 = uid(7201), FACT_U2 = uid(7203), FACT_P = uid(7202), FACT_B = uid(7301), FIX_PACK_OTHER = uid(2201), FIX_ITEM = uid(2001), INST_UNBOUND_FIX = uid(422);
// extras
const TA = uid(16001), TB = uid(16002), TC = uid(16003), AN1 = uid(16101), AN2 = uid(16102), AN3 = uid(16103);
const I1 = uid(16201), I2 = uid(16202), I3 = uid(16203);
const S1 = uid(16301), D2 = uid(16302), S3 = uid(16303), S2 = uid(16304), SI = uid(16305);
const IT1 = uid(16401), IT2 = uid(16402), IT3 = uid(16403), PK1 = uid(16451), LA = uid(16501), LB = uid(16502), LC = uid(16503);
const FR = uid(16601), FE = uid(16602);
const ANALYTES: Record<string, string[]> = { [TA]: [AN1, AN2], [TB]: [AN3], [TC]: [], [FIX_TEST]: [] };
const BR1_ONLY: ConsOpts = { all: false, branchIds: [BR1] };
const BR2_ONLY: ConsOpts = { all: false, branchIds: [BR2] };
const READER: ConsOpts = { permissions: [READ] };
const WITH_COST: ConsOpts = { permissions: [READ, MANAGE, BENCH, ADJUST, COST] };
const mins = (n: number) => new Date(Date.now() - n * 60_000).toISOString();     // n minutes ago
const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString(); // n days ago

const J = (o: unknown) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const I = (table: string, o: Record<string, unknown>) => `SELECT pg_temp.t15_ins('${table}', ${J(o)});`; // own names: the fixtures' pg_temp.sys / pg_temp.ins may live on the same pooled connection
const tid = { tenant_id: A };
const store = (n: number, branch: string, code: string, kind: string, def: boolean, active = true) => I('inventory.stores', { id: uid(n), ...tid, branch_id: branch, store_code: code, name: `Store ${code}`, store_kind: kind, is_default_consumption: def, is_active: active });
const item = (n: number, code: string, cat: string, uom: string, lt: boolean) => I('inventory.items', { id: uid(n), ...tid, item_code: code, name: `Item ${code}`, category: cat, base_uom_code: uom, is_lot_tracked: lt, requires_expiry: lt, is_active: true });
const balRow = (n: number, s: string, i: string, lot: string | null, q: number, v: number) => I('inventory.stock_balances', { id: uid(n), ...tid, store_id: s, item_id: i, lot_id: lot, qty_base: q, value_paisa: v, last_movement_at: new Date().toISOString() });
const inst = (n: number, code: string, centre: string) => I('instruments.instruments', { id: uid(n), ...tid, centre_id: centre, agent_id: uid(n + 1000), instrument_code: code, display_name: `Instrument ${code}`, vendor: 'Synthetic', model: 'SX-1', protocol: 'astm',
  driver_code: 'astm_generic_e1394', transport: { kind: 'tcp_client' }, timezone: KT, state: 'draft' });
const CENTRE_BR1 = '01a1a98a-ac40-7000-8000-00000000a201', CENTRE_BR2 = '01a1a98a-ac40-7000-8000-00000000a202';
const EXTRAS = `
BEGIN;
SET search_path = extensions, public, pg_catalog;
SET LOCAL session_replication_role = replica;
CREATE OR REPLACE FUNCTION pg_temp.t15_sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '${SYS}'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.t15_ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r jsonb := p_row; a text; cols text;
BEGIN
  IF r ? 'tenant_id' THEN PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', r->>'tenant_id', 'sub', pg_temp.t15_sys(), 'actor_type', 'system')::text, true); END IF;
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.t15_sys()); END IF;
  END LOOP;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb) ON CONFLICT DO NOTHING', p_tbl, cols, r::text);
END $f$;
SELECT set_config('request.jwt.claims', '{"tenant_id":"${A}","sub":"${SYS}","actor_type":"system"}', true);
INSERT INTO inventory.g_cs_reasons (id, reason_group, code, display) VALUES
  ('${uid(16701)}', 'calibration', 'scheduled', 'Scheduled'), ('${uid(16702)}', 'calibration', 'other', 'Other'), ('${uid(16703)}', 'fact_dismiss', 'not_consumed', 'Not consumed'),
  ('${uid(16704)}', 'fact_dismiss', 'other', 'Other'), ('${uid(16705)}', 'fact_reverse', 'logged_in_error', 'Logged in error'), ('${uid(16706)}', 'fact_reverse', 'other', 'Other') ON CONFLICT DO NOTHING;
${I('catalog.tests', { id: TA, ...tid, workflow_type: 'standard' })}
${I('catalog.tests', { id: TB, ...tid, workflow_type: 'standard' })}
${I('catalog.tests', { id: TC, ...tid, workflow_type: 'standard' })}
${I('catalog.analytes', { id: AN1, ...tid, test_id: TA, code: 'T15A1', name: 'T15 analyte 1' })}
${I('catalog.analytes', { id: AN2, ...tid, test_id: TA, code: 'T15A2', name: 'T15 analyte 2' })}
${I('catalog.analytes', { id: AN3, ...tid, test_id: TB, code: 'T15B1', name: 'T15 analyte 3' })}
${inst(16201, 'T15-I1', CENTRE_BR1)}
${inst(16202, 'T15-I2', CENTRE_BR2)}
${inst(16203, 'T15-I3', CENTRE_BR1)}
${store(16301, BR1, 'T15-S1', 'main', false)}
${store(16302, BR2, 'T15-D2', 'main', true)}
${store(16303, BR1, 'T15-S3', 'bench', false)}
${store(16304, BR2, 'T15-S2', 'bench', false)}
${store(16305, BR1, 'T15-SI', 'bench', false, false)}
${item(16401, 'T15-IT1', 'reagent', 'test', true)}
${item(16402, 'T15-IT2', 'consumable', 'piece', false)}
${item(16403, 'T15-IT3', 'reagent', 'ml', true)}
${I('inventory.item_packs', { id: PK1, ...tid, item_id: IT1, pack_code: 'T15KIT', label: 'Pack T15KIT', uom_code: 'box', qty_in_base: 100, is_purchase_default: false, is_active: true })}
${I('inventory.lots', { id: LA, ...tid, item_id: IT1, lot_no: 'T15-LA', expiry_on: addDays(ymdIn(KT), 90), status: 'available' })}
${I('inventory.lots', { id: LB, ...tid, item_id: IT1, lot_no: 'T15-LB', expiry_on: addDays(ymdIn(KT), 30), status: 'available' })}
${I('inventory.lots', { id: LC, ...tid, item_id: IT3, lot_no: 'T15-LC', expiry_on: addDays(ymdIn(KT), 90), status: 'available' })}
${balRow(16801, S1, IT1, LA, 100, 10000)}${balRow(16802, S1, IT1, LB, 7, 1000)}${balRow(16803, S1, IT2, null, 50, 500)}${balRow(16804, S1, IT3, LC, 100, 5000)}
${balRow(16805, D2, IT1, LA, 100, 10000)}${balRow(16806, D2, IT2, null, 50, 500)}${balRow(16807, MAIN_A, IT2, null, 50, 500)}${balRow(16808, S3, IT2, null, 1000, 10000)}${balRow(16809, S2, IT2, null, 50, 500)}
INSERT INTO core.g_task_registry (identifier, module, kind, scope, max_attempts, is_active) VALUES ('inventory.resolve_unresolved', 'inventory', 'task', 'per_tenant', 5, true) ON CONFLICT DO NOTHING; -- ruling (E): the worker registers it at boot
${I('inventory.consumption_rules', { id: uid(16611), ...tid, rule_kind: 'per_test', test_id: TC, item_id: IT2, qty_base: 1, entered_qty: 1, effective_from: days(30) })}
${I('inventory.consumption_rules', { id: uid(16612), ...tid, rule_kind: 'per_calibration', test_id: TC, item_id: IT2, qty_base: 1, entered_qty: 1, effective_from: days(30) })}
${I('inventory.instrument_bindings', { id: uid(16621), ...tid, instrument_id: I3, store_id: S3, is_active: true })}
${I('inventory.consumption_facts', { id: FR, ...tid, fact_kind: 'test', basis_key: 'manual:t15-race-resolve', source: 'manual', instrument_id: I1, test_id: TC, occurred_at: days(1), business_date: ymdIn(KT, new Date(days(1))), status: 'unresolved', rules_applied: 1 })}
${I('inventory.consumption_facts', { id: FE, ...tid, fact_kind: 'test', basis_key: 'test:t15-event:x', source: 'event', source_event_id: uid(16699), source_event_type: 'lab.result.verified.v1', instrument_id: I1, test_id: TA, occurred_at: days(1),
  business_date: ymdIn(KT, new Date(days(1))), status: 'posted', store_id: S1, rules_applied: 1 })}
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

describe('T-15 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => { if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true); });
});

interface Sess {
  call(t: string, op: string, req?: Parameters<typeof call>[2], o?: ConsOpts): Promise<{ status: number; body: any }>;
  sql(t: string, text: string, v?: unknown[]): Promise<any[]>;
  /** every statement sent through ctx.tx (the handler's own queries; test SQL is not logged). */
  log: string[];
  roleCalls: any[];
  tx: { query(t: string, v?: unknown[]): Promise<{ rows: any[] }> };
  rc: { tx: any; tenantId: string; actorId: string };
  seq(): number;
}
const claims = (t: string) => JSON.stringify({ tenant_id: t, sub: SYS, actor_type: 'system' });
function sessionOn(client: pg.PoolClient): Sess {
  let n = 0, seq = 0;
  const log: string[] = [];
  const roleCalls: any[] = [];
  const tx = { query: (t: string, v?: unknown[]) => { log.push(t); return client.query(t, v); } };
  const setClaims = (t: string) => client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t)]);
  return {
    log, roleCalls, tx, rc: { tx, tenantId: A, actorId: SYS }, seq: () => ++seq,
    async sql(t, text, v) { await setClaims(t); return (await client.query(text, v)).rows; },
    async call(t, op, req, o) {
      await setClaims(t);
      const st = makeConsCtx(tx, t, { analytes: ANALYTES, ...(o ?? {}) });
      const sp = `t15_h${++n}`;
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
const run = (name: string, fn: (s: Sess) => Promise<void>, timeout?: number) => it(name, () => session(fn), timeout);
async function committed<T>(fn: (s: Sess) => Promise<T>): Promise<T> {
  const client = await api.connect();
  try { await client.query('BEGIN'); const r = await fn(sessionOn(client)); await client.query('COMMIT'); return r; } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
}

// ------------------------------------------------------------------ small helpers
const nf = (p: Promise<unknown>) => expectLims(p, 'common.not_found', 404);
const forbidden = (p: Promise<unknown>) => expectLims(p, 'auth.forbidden', 403);
const invalid = (p: Promise<unknown>) => expectLims(p, 'inventory.document_invalid_transition', 409);
const bad400 = async (p: Promise<unknown>, pointer?: string) => { const e = await expectLims(p, 'common.validation_failed', 400); if (pointer) expect(JSON.stringify((e as any).errors ?? (e as any).detail ?? '')).toContain(pointer); return e; };
const n = (v: unknown) => Number(v);
// Ruling C12.T-15 (A): #70 has no effective_from (= ctx.now(), 03-APP-FLOW.md:175) and rules are not retroactive (02-TRD.md:519, 614), so rules are back-dated 1 h unless a test passes its own clock.
const mk = async (s: Sess, kind: string, itemId: string, qty: string, over: Record<string, unknown> = {}, o?: ConsOpts) => (await s.call(A, 'createConsumptionRule', { body: ruleBody(kind, itemId, qty, over) }, { now: mins(60), ...(o ?? {}) } as ConsOpts)).body;
const logCal = (s: Sess, test: string, occurred: string, over: Record<string, unknown> = {}, o?: ConsOpts) => s.call(A, 'logConsumptionEvent', { body: calBody(test, occurred, over) }, o);
const logQc = (s: Sess, test: string, occurred: string, over: Record<string, unknown> = {}, o?: ConsOpts) => s.call(A, 'logConsumptionEvent', { body: qcBody(test, occurred, over) }, o);
const bind = (s: Sess, instrument: string, storeId: string) => s.sql(A, 'INSERT INTO inventory.instrument_bindings (id, tenant_id, instrument_id, store_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)', [uid(950000 + s.seq()), A, instrument, storeId, SYS]);
const setDefault = (s: Sess, storeId: string | null) => s.sql(A, 'UPDATE inventory.settings SET default_consumption_store_id = $2 WHERE tenant_id = $1', [A, storeId]);
const dbFact = async (s: Sess, id: string, t = A) => (await s.sql(t, 'SELECT * FROM inventory.consumption_facts WHERE id = $1', [id]))[0];
const dbRule = async (s: Sess, id: string) => (await s.sql(A, 'SELECT * FROM inventory.consumption_rules WHERE id = $1', [id]))[0];
const moves = async (s: Sess, factId: string) => (await s.sql(A, `SELECT id, movement_kind AS kind, store_id, item_id, lot_id, qty_base::text AS q, value_paisa::text AS v, instrument_id, attributed_test_id, rule_id, reverses_movement_id,
  business_date::text AS bd, occurred_at, doc_type, doc_id FROM inventory.stock_movements WHERE tenant_id = $1 AND doc_type = 'consumption_fact' AND doc_id = $2 ORDER BY created_at, qty_base`, [A, factId]))
  .map((m: any) => ({ ...m, qn: n(m.q), vn: n(m.v) }));
const bal = async (s: Sess, storeId: string, itemId: string, lot: string | null) => {
  const r = (await s.sql(A, 'SELECT qty_base::text AS q, value_paisa::text AS v FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id IS NOT DISTINCT FROM $4::uuid', [A, storeId, itemId, lot]))[0];
  return r ? { q: n(r.q), v: n(r.v) } : { q: 0, v: 0 };
};
const cnt = async (s: Sess, table: string, where = 'true', v: unknown[] = []) => n((await s.sql(A, `SELECT count(*) AS n FROM inventory.${table} WHERE tenant_id = $1 AND ${where}`, [A, ...v]))[0].n);
const snapshot = async (s: Sess) => JSON.stringify([await cnt(s, 'consumption_facts'), await cnt(s, 'stock_movements'), await cnt(s, 'consumption_rules'),
  await s.sql(A, 'SELECT id, qty_base, value_paisa, version FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [A])]);
const untouched = async (s: Sess, p: () => Promise<unknown>, check: (e: any) => void) => { const before = await snapshot(s); let err: any; try { await p(); } catch (e) { err = e; } expect(err, 'expected a rejection').toBeDefined(); check(err); expect(await snapshot(s)).toBe(before); };
const sum = (ms: { vn: number }[]) => ms.reduce((a, m) => a + m.vn, 0);
const factUpdates = (s: Sess) => s.log.filter((t) => /UPDATE\s+inventory\.consumption_facts/i.test(t));
const ruleReads = (s: Sess) => s.log.filter((t) => /FROM\s+inventory\.consumption_rules/i.test(t));
/** a manual calibration rule on (test, item) so a fact posts to the bound store. */
async function setupPosted(s: Sess, qty = '2', itemId = IT2, test = TA, instrument = I1, storeId = S1) {
  await mk(s, 'per_calibration', itemId, qty, { test_id: test }); await bind(s, instrument, storeId);
  return (await logCal(s, test, mins(5), { instrument_id: instrument })).body;
}

// ======================================================================================================== #70 create (shape checks via CatalogPort fake)
describe.skipIf(!live)('T-15 #70 createConsumptionRule', () => {
  run('per_test rule: 201, contract keys only, qty_base = entered_qty, effective_from = now, current, version 1; the row carries the actor; nothing leaks', async (s) => {
    const r = await s.call(A, 'createConsumptionRule', { body: ruleBody('per_test', IT2, '2.5', { test_id: TA, instrument_id: I1, notes: 'syn' }) });
    expect(r.status).toBe(201);
    expect(onlyKeys(r.body, RULE_KEYS)).toEqual([]); expect(JSON.stringify(r.body)).not.toMatch(LEAK);
    expect(r.body).toMatchObject({ rule_kind: 'per_test', test_id: TA, instrument_id: I1, item_id: IT2, is_active: true, version: 1, notes: 'syn' });
    expect(n(r.body.qty_base)).toBe(2.5); expect(n(r.body.entered_qty)).toBe(2.5); expect(r.body.effective_to).toBeUndefined(); expect(r.body.entered_pack_id).toBeUndefined();
    expect(Math.abs(Date.parse(r.body.effective_from) - Date.now())).toBeLessThan(60_000);
    const row = await dbRule(s, r.body.id);
    expect(row).toMatchObject({ tenant_id: A, created_by: SYS, supersedes_rule_id: null, effective_to: null });
  });
  run('pack conversion: 2 x PK1 (100 base) => qty_base 200, entered_qty 2, entered_pack_id; a pack of ANOTHER item => 422 inventory.uom_mismatch, nothing written', async (s) => {
    const r = await mk(s, 'per_test', IT1, '2', { test_id: TA, pack_id: PK1 });
    expect(n(r.qty_base)).toBe(200); expect(n(r.entered_qty)).toBe(2); expect(r.entered_pack_id).toBe(PK1);
    await untouched(s, () => mk(s, 'per_test', IT1, '1', { test_id: TB, pack_id: FIX_PACK_OTHER }), (e) => { expect(e.code).toBe('inventory.uom_mismatch'); expect(e.statusCode).toBe(422); });
  });
  run('shape via CatalogPort.getTest: an analyte that is not of the test => 400 at /analyte_id, nothing written; the port is asked about the TEST; per_day never calls it', async (s) => {
    const c = makeConsCtx(s.tx, A, { analytes: ANALYTES }); // fresh ctx to read catalogCalls
    await untouched(s, () => call('createConsumptionRule', c.ctx, { body: ruleBody('per_analyte', IT2, '1', { test_id: TA, analyte_id: AN3 }) }), (e) => { expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? e.detail)).toContain('/analyte_id'); });
    expect(c.catalogCalls.map((x) => x.testId)).toContain(TA);
    const ok = await call('createConsumptionRule', c.ctx, { body: ruleBody('per_analyte', IT2, '1', { test_id: TA, analyte_id: AN2 }) });
    expect(ok.status).toBe(201);
    const d = makeConsCtx(s.tx, A, { analytes: ANALYTES });
    expect((await call('createConsumptionRule', d.ctx, { body: ruleBody('per_day', IT2, '1', { instrument_id: I1 }) })).status).toBe(201);
    expect(d.catalogCalls).toEqual([]);
    const q = makeConsCtx(s.tx, A, { analytes: ANALYTES }); // per_qc with an analyte of another test is refused too
    await bad400(call('createConsumptionRule', q.ctx, { body: ruleBody('per_qc', IT2, '1', { test_id: TA, analyte_id: AN3 }) }), '/analyte_id');
  });
  run('a LimsError from the port propagates as the SAME object (unknown test => common.not_found), nothing written', async (s) => {
    const boom = new (await import('./consumption.helpers.js')).LimsError('common.not_found');
    const c = makeConsCtx(s.tx, A, { catalogFailure: boom });
    await untouched(s, async () => call('createConsumptionRule', c.ctx, { body: ruleBody('per_test', IT2, '1', { test_id: TA }) }), (e) => expect(e).toBe(boom));
    const d = makeConsCtx(s.tx, A, { analytes: {} });
    await untouched(s, async () => call('createConsumptionRule', d.ctx, { body: ruleBody('per_test', IT2, '1', { test_id: uid(99999) }) }), (e) => expect(e.code).toBe('common.not_found'));
  });
  run('one CURRENT rule per key: a second identical rule => 409 inventory.rule_conflict (also with every nullable key null); another instrument / item / kind is a different key', async (s) => {
    await mk(s, 'per_test', IT2, '1', { test_id: TA });
    await untouched(s, () => mk(s, 'per_test', IT2, '5', { test_id: TA }), (e) => { expect(e.code).toBe('inventory.rule_conflict'); expect(e.statusCode).toBe(409); });
    await mk(s, 'per_qc', IT2, '1', { test_id: TA }); await untouched(s, () => mk(s, 'per_qc', IT2, '1', { test_id: TA }), (e) => expect(e.code).toBe('inventory.rule_conflict'));
    await mk(s, 'per_test', IT2, '1', { test_id: TA, instrument_id: I1 }); await mk(s, 'per_test', IT3, '1', { test_id: TA }); await mk(s, 'per_calibration', IT2, '1', { test_id: TA });
    await mk(s, 'per_qc', IT2, '1', { test_id: TA, analyte_id: AN1 });
  });
  run('after a deactivate the key is free again; after a supersede only the new rule is current (create => rule_conflict)', async (s) => {
    const r = await mk(s, 'per_test', IT2, '1', { test_id: TA });
    await s.call(A, 'deactivateConsumptionRule', { params: { rule_id: r.id }, headers: ifm(r.version) });
    const r2 = await mk(s, 'per_test', IT2, '3', { test_id: TA }); expect(n(r2.qty_base)).toBe(3);
    await s.call(A, 'supersedeConsumptionRule', { params: { rule_id: r2.id }, headers: ifm(r2.version), body: supersedeBody('4') });
    await untouched(s, () => mk(s, 'per_test', IT2, '9', { test_id: TA }), (e) => expect(e.code).toBe('inventory.rule_conflict'));
  });
  run('unknown item_id / instrument_id => 400 at the field (P-1 pattern), nothing written', async (s) => {
    await untouched(s, () => mk(s, 'per_test', uid(99998), '1', { test_id: TA }), (e) => { expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? e.detail)).toContain('/item_id'); });
    await untouched(s, () => mk(s, 'per_test', IT2, '1', { test_id: TA, instrument_id: uid(99997) }), (e) => { expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? e.detail)).toContain('/instrument_id'); });
  });
  run('permission: item.read only => 403 and nothing written; tenant B items cannot be ruled by tenant A', async (s) => {
    await untouched(s, () => mk(s, 'per_test', IT2, '1', { test_id: TA }, READER), (e) => expect(e.code).toBe('auth.forbidden'));
    await untouched(s, () => mk(s, 'per_test', uid(2101), '1', { test_id: TA }), (e) => expect(e.code).toBe('common.validation_failed'));
  });
});

// ======================================================================================================== #69 / #71 list + get, #72 supersede, #73 deactivate
describe.skipIf(!live)('T-15 #69 listConsumptionRules / #71 getConsumptionRule', () => {
  run('current_only (default true) hides the superseded 7003 and the inactive 7005; current_only=false shows them; tenant B rule 7101 never appears', async (s) => {
    const cur = (await s.call(A, 'listConsumptionRules', { query: {} })).body;
    const ids = cur.data.map((r: any) => r.id);
    expect(ids).toEqual(expect.arrayContaining([FIX_R1, FIX_R2, FIX_R_DAY])); expect(ids).not.toContain(FIX_R_OLD); expect(ids).not.toContain(FIX_R_INACT); expect(ids).not.toContain(FIX_R_B);
    for (const r of cur.data) { expect(onlyKeys(r, RULE_KEYS)).toEqual([]); expect(JSON.stringify(r)).not.toMatch(LEAK); }
    const all = (await s.call(A, 'listConsumptionRules', { query: { current_only: false } })).body.data.map((r: any) => r.id);
    expect(all).toEqual(expect.arrayContaining([FIX_R1, FIX_R_OLD, FIX_R_INACT])); expect(all).not.toContain(FIX_R_B);
  });
  run('filters rule_kind / test_id / instrument_id / item_id; paging by limit + next_cursor with no overlap', async (s) => {
    const q = async (query: Record<string, unknown>) => (await s.call(A, 'listConsumptionRules', { query })).body.data.map((r: any) => r.id);
    expect(await q({ rule_kind: 'per_day' })).toEqual([FIX_R_DAY]);
    const byTest = await q({ test_id: FIX_TEST }); expect(byTest).toEqual(expect.arrayContaining([FIX_R1, FIX_R2])); expect(byTest).not.toContain(FIX_R_DAY);
    expect(await q({ instrument_id: uid(421), rule_kind: 'per_test' })).toContain(FIX_R2);
    expect(await q({ item_id: uid(2002) })).toEqual([FIX_R_DAY]); // 7005 is inactive
    const p1 = (await s.call(A, 'listConsumptionRules', { query: { limit: 1 } })).body; expect(p1.data).toHaveLength(1); expect(p1.page.next_cursor).toBeTruthy();
    const p2 = (await s.call(A, 'listConsumptionRules', { query: { limit: 1, cursor: p1.page.next_cursor } })).body; expect(p2.data[0].id).not.toBe(p1.data[0].id);
  });
  run('#71 get: the rule + history chain (new first or old first, both ids); unknown / tenant-B id => 404', async (s) => {
    const r = await mk(s, 'per_test', IT2, '1', { test_id: TA });
    const r2 = (await s.call(A, 'supersedeConsumptionRule', { params: { rule_id: r.id }, headers: ifm(r.version), body: supersedeBody('2') })).body;
    const g = (await s.call(A, 'getConsumptionRule', { params: { rule_id: r2.id } })).body;
    expect(onlyKeys(g, RULE_KEYS)).toEqual([]); expect(g.history.map((h: any) => h.id).sort()).toEqual([r.id, r2.id].sort());
    for (const h of g.history) expect(onlyKeys(h, ['id', 'qty_base', 'effective_from', 'effective_to'])).toEqual([]);
    await nf(s.call(A, 'getConsumptionRule', { params: { rule_id: uid(99996) } })); await nf(s.call(A, 'getConsumptionRule', { params: { rule_id: FIX_R_B } }));
    await nf(s.call(B, 'getConsumptionRule', { params: { rule_id: FIX_R1 } }));
  });
});

describe.skipIf(!live)('T-15 #72 supersedeConsumptionRule / #73 deactivateConsumptionRule', () => {
  run('supersede: new rule 201 (same key, supersedes_rule_id, new qty, effective_from = now); old effective_to = the same instant, still is_active; list current shows only the new one', async (s) => {
    const r = await mk(s, 'per_test', IT2, '1', { test_id: TA, instrument_id: I1, notes: 'old' });
    const sup = await s.call(A, 'supersedeConsumptionRule', { params: { rule_id: r.id }, headers: ifm(r.version), body: supersedeBody('3', { notes: 'new' }) });
    expect(sup.status).toBe(201); expect(onlyKeys(sup.body, RULE_KEYS)).toEqual([]);
    expect(sup.body).toMatchObject({ rule_kind: 'per_test', test_id: TA, instrument_id: I1, item_id: IT2, supersedes_rule_id: r.id, is_active: true, version: 1, notes: 'new' });
    expect(n(sup.body.qty_base)).toBe(3);
    const old = await dbRule(s, r.id);
    expect(old.effective_to).not.toBeNull(); expect(new Date(old.effective_to).toISOString()).toBe(sup.body.effective_from); expect(old.is_active).toBe(true); expect(n(old.qty_base)).toBe(1);
    const cur = (await s.call(A, 'listConsumptionRules', { query: { test_id: TA, instrument_id: I1 } })).body.data.map((x: any) => x.id);
    expect(cur).toContain(sup.body.id); expect(cur).not.toContain(r.id);
  });
  run('supersede with a pack converts again; a pack of another item => 422 uom_mismatch; a stale If-Match => 409 common.version_conflict; the old rule is not current => 409 inventory.document_invalid_transition', async (s) => {
    const r = await mk(s, 'per_test', IT1, '1', { test_id: TA });
    const sup = (await s.call(A, 'supersedeConsumptionRule', { params: { rule_id: r.id }, headers: ifm(r.version), body: supersedeBody('2', { pack_id: PK1 }) })).body;
    expect(n(sup.qty_base)).toBe(200); expect(sup.entered_pack_id).toBe(PK1);
    await invalid(s.call(A, 'supersedeConsumptionRule', { params: { rule_id: r.id }, headers: ifm(r.version + 1), body: supersedeBody('5') })); // r is superseded now
    await untouched(s, () => s.call(A, 'supersedeConsumptionRule', { params: { rule_id: sup.id }, headers: ifm(sup.version), body: supersedeBody('1', { pack_id: FIX_PACK_OTHER }) }), (e) => expect(e.code).toBe('inventory.uom_mismatch'));
    await untouched(s, () => s.call(A, 'supersedeConsumptionRule', { params: { rule_id: sup.id }, headers: ifm(sup.version + 5), body: supersedeBody('5') }), (e) => { expect(e.code).toBe('common.version_conflict'); expect(e.statusCode).toBe(409); });
    await nf(s.call(A, 'supersedeConsumptionRule', { params: { rule_id: uid(99995) }, headers: ifm(1), body: supersedeBody('1') }));
  });
  run('deactivate: effective_to = now, is_active false, version + 1; a second deactivate and a supersede of it => 409; stale If-Match => 409; unknown => 404; nothing else changes', async (s) => {
    const r = await mk(s, 'per_test', IT2, '1', { test_id: TA });
    await untouched(s, () => s.call(A, 'deactivateConsumptionRule', { params: { rule_id: r.id }, headers: ifm(r.version + 3) }), (e) => expect(e.code).toBe('common.version_conflict'));
    const d = await s.call(A, 'deactivateConsumptionRule', { params: { rule_id: r.id }, headers: ifm(r.version) });
    expect(d.status).toBe(200); expect(d.body).toMatchObject({ id: r.id, is_active: false, version: r.version + 1 }); expect(d.body.effective_to).toBeTruthy();
    const row = await dbRule(s, r.id); expect(row.is_active).toBe(false); expect(row.effective_to).not.toBeNull(); expect(n(row.qty_base)).toBe(1);
    await invalid(s.call(A, 'deactivateConsumptionRule', { params: { rule_id: r.id }, headers: ifm(d.body.version) }));
    await invalid(s.call(A, 'supersedeConsumptionRule', { params: { rule_id: r.id }, headers: ifm(d.body.version), body: supersedeBody('2') }));
    await nf(s.call(A, 'deactivateConsumptionRule', { params: { rule_id: uid(99994) }, headers: ifm(1) }));
  });
  run('tenant B cannot touch tenant A rules (404) and READER cannot supersede / deactivate (403)', async (s) => {
    const r = await mk(s, 'per_test', IT2, '1', { test_id: TA });
    await nf(s.call(B, 'supersedeConsumptionRule', { params: { rule_id: r.id }, headers: ifm(1), body: supersedeBody('2') })); await nf(s.call(B, 'deactivateConsumptionRule', { params: { rule_id: r.id }, headers: ifm(1) }));
    await forbidden(s.call(A, 'supersedeConsumptionRule', { params: { rule_id: r.id }, headers: ifm(1), body: supersedeBody('2') }, READER)); await forbidden(s.call(A, 'deactivateConsumptionRule', { params: { rule_id: r.id }, headers: ifm(1) }, READER));
    expect((await dbRule(s, r.id)).effective_to).toBeNull();
  });
});

// ======================================================================================================== resolveStore (02-TRD §8.2: steps 1, 2, 5, 6)
describe.skipIf(!live)('T-15 store resolution (consumption.service.resolveStore): steps 1, 2, 5, 6; first match wins', () => {
  const svc = () => import('../../service/consumption.service.js') as Promise<any>;
  run('step 1: an ACTIVE binding wins over the centre default and over the settings default', async (s) => {
    await bind(s, I1, S3); await setDefault(s, D2);
    expect(await (await svc()).resolveStore(s.rc, { instrument_id: I1, centre_id: CENTRE_BR1 })).toEqual({ store_id: S3, step: 1 });
  });
  run('step 2: no binding, centre set => the default consumption store of the centre\'s branch (a201 -> BR1 -> 1001; a202 -> BR2 -> D2), beating the settings default', async (s) => {
    await setDefault(s, S1);
    const r = (await svc()).resolveStore;
    expect(await r(s.rc, { instrument_id: I1, centre_id: CENTRE_BR1 })).toEqual({ store_id: MAIN_A, step: 2 });
    expect(await r(s.rc, { instrument_id: I2, centre_id: CENTRE_BR2 })).toEqual({ store_id: D2, step: 2 });
    expect(await r(s.rc, { centre_id: CENTRE_BR2 })).toEqual({ store_id: D2, step: 2 });
  });
  run('step 5: no binding, no centre => settings.default_consumption_store_id when ACTIVE; an inactive default, or none => step 6 with store_id null', async (s) => {
    const r = (await svc()).resolveStore;
    await setDefault(s, S3); expect(await r(s.rc, { instrument_id: I1 })).toEqual({ store_id: S3, step: 5 }); expect(await r(s.rc, {})).toEqual({ store_id: S3, step: 5 });
    await setDefault(s, SI); expect(await r(s.rc, { instrument_id: I1 })).toEqual({ store_id: null, step: 6 });
    await setDefault(s, null); expect(await r(s.rc, { instrument_id: I1 })).toEqual({ store_id: null, step: 6 }); expect(await r(s.rc, {})).toEqual({ store_id: null, step: 6 });
  });
  run('an INACTIVE binding (fixture 9402, instrument 422) is ignored; an inactive centre default does not resolve; steps 3 / 4 are OFF by default (processing_branch_id alone does not resolve)', async (s) => {
    const r = (await svc()).resolveStore;
    expect(await r(s.rc, { instrument_id: INST_UNBOUND_FIX })).toEqual({ store_id: null, step: 6 });
    expect(await r(s.rc, { processing_branch_id: BR2 })).toEqual({ store_id: null, step: 6 });
    await setDefault(s, S3); expect(await r(s.rc, { processing_branch_id: BR2 })).toEqual({ store_id: S3, step: 5 });
    expect(await r(s.rc, { instrument_id: uid(421) })).toEqual({ store_id: MAIN_A, step: 1 }); // fixture 9401
  });
});

// ======================================================================================================== #74 preview
describe.skipIf(!live)('T-15 #74 previewConsumption (dry run)', () => {
  run('returns store + step + lines; instrument-specific overrides generic of the SAME item (AC-12.6), different items both apply; no writes at all', async (s) => {
    await mk(s, 'per_test', IT2, '4', { test_id: TA }); await mk(s, 'per_test', IT2, '1', { test_id: TA, instrument_id: I1 }); await mk(s, 'per_test', IT3, '2', { test_id: TA });
    await bind(s, I1, S1);
    const before = await snapshot(s); s.log.length = 0;
    const r = await s.call(A, 'previewConsumption', { body: previewBody('test', { test_id: TA, instrument_id: I1 }) });
    expect(r.status).toBe(200); expect(onlyKeys(r.body, PREVIEW_KEYS)).toEqual([]);
    expect(r.body.store_id).toBe(S1); expect(r.body.store_resolution_step).toBe(1);
    expect(r.body.lines).toHaveLength(2);
    const l2 = r.body.lines.find((l: any) => l.item_id === IT2), l3 = r.body.lines.find((l: any) => l.item_id === IT3);
    expect(n(l2.qty_base)).toBe(1); expect(n(l3.qty_base)).toBe(2);
    for (const l of r.body.lines) { expect(onlyKeys(l, PREVIEW_LINE_KEYS)).toEqual([]); expect(l.rule_id).toBeTruthy(); }
    expect(s.log.filter((t) => /^\s*(INSERT|UPDATE|DELETE)/i.test(t))).toEqual([]);
    expect(await snapshot(s)).toBe(before);
    const generic = (await s.call(A, 'previewConsumption', { body: previewBody('test', { test_id: TA }) })).body.lines.find((l: any) => l.item_id === IT2);
    expect(n(generic.qty_base)).toBe(4); // no instrument => only the generic rule
  });
  run('step 5 / step 6 are reported; kinds map (test->per_test, analyte->per_analyte, qc->per_qc, calibration->per_calibration); `at` before the rule\'s effective_from => no lines', async (s) => {
    await mk(s, 'per_analyte', IT2, '1', { test_id: TA, analyte_id: AN1 }); await mk(s, 'per_qc', IT3, '1', { test_id: TA, analyte_id: AN1 }); await mk(s, 'per_calibration', IT2, '3', { test_id: TA });
    const p = (b: Record<string, unknown>, o?: ConsOpts) => s.call(A, 'previewConsumption', { body: b }, o).then((r) => r.body);
    let r = await p(previewBody('analyte', { test_id: TA, analyte_id: AN1 })); expect(r.store_resolution_step).toBe(6); expect(r.store_id).toBeUndefined(); expect(r.lines.map((l: any) => l.item_id)).toEqual([IT2]);
    await setDefault(s, D2);
    r = await p(previewBody('qc', { test_id: TA, analyte_id: AN1 })); expect(r).toMatchObject({ store_id: D2, store_resolution_step: 5 }); expect(r.lines.map((l: any) => l.item_id)).toEqual([IT3]);
    r = await p(previewBody('calibration', { test_id: TA })); expect(n(r.lines[0].qty_base)).toBe(3);
    expect((await p(previewBody('rerun', { test_id: TA }))).lines).toEqual([]); // no per_rerun rule
    expect((await p(previewBody('calibration', { test_id: TA, at: days(2) }))).lines).toEqual([]); // rules are not retroactive
  });
  run('est_value_paisa only with inventory.cost.read (02-TRD §6.3): unlotted IT2 at S1 is 10 paisa a unit => 3 units = 30', async (s) => {
    await mk(s, 'per_test', IT2, '3', { test_id: TA }); await bind(s, I1, S1);
    const withCost = (await s.call(A, 'previewConsumption', { body: previewBody('test', { test_id: TA, instrument_id: I1 }) }, WITH_COST)).body.lines[0];
    expect(withCost.est_value_paisa).toBe(30);
    const without = (await s.call(A, 'previewConsumption', { body: previewBody('test', { test_id: TA, instrument_id: I1 }) })).body.lines[0];
    expect(Object.keys(without)).not.toContain('est_value_paisa');
  });
  run('inactive / deactivated / superseded rules do not preview; READER may preview; tenant B sees none of A\'s rules', async (s) => {
    const r = await mk(s, 'per_test', IT2, '1', { test_id: TA });
    await s.call(A, 'deactivateConsumptionRule', { params: { rule_id: r.id }, headers: ifm(r.version) });
    expect((await s.call(A, 'previewConsumption', { body: previewBody('test', { test_id: TA }) }, READER)).body.lines).toEqual([]);
    expect((await s.call(B, 'previewConsumption', { body: previewBody('test', { test_id: FIX_TEST }) })).body.lines).toEqual([]);
  });
});

// ======================================================================================================== #76 manual log (AC-15.1 .. AC-15.3, no rule cache, final status at insert, P-B7)
describe.skipIf(!live)('T-15 #76 logConsumptionEvent', () => {
  run('AC-15.1 calibration within the window: posted at the bound store, one consume_calibration movement (qty, value, instrument, attributed test, rule, original occurred_at / business date), balance moved, fact row manual', async (s) => {
    const rule = await mk(s, 'per_calibration', IT2, '2', { test_id: TA }); await bind(s, I1, S1);
    const before = await bal(s, S1, IT2, null); const occurred = mins(30);
    const r = await logCal(s, TA, occurred, { instrument_id: I1, note: 'syn note' });
    expect(r.status).toBe(201); expect(onlyKeys(r.body, FACT_KEYS)).toEqual([]); for (const k of SECRET_FACT_KEYS) expect(Object.keys(r.body)).not.toContain(k);
    expect(r.body).toMatchObject({ fact_kind: 'calibration', source: 'manual', status: 'posted', instrument_id: I1, test_id: TA, store_id: S1, multiplier: 1, rules_applied: 1, reason_code: 'scheduled', note: 'syn note', version: 1 });
    expect(r.body.occurred_at).toBe(occurred); expect(r.body.business_date).toBe(ymdIn(KT, new Date(occurred)));
    const ms = await moves(s, r.body.id);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: 'consume_calibration', store_id: S1, item_id: IT2, lot_id: null, qn: -2, instrument_id: I1, attributed_test_id: TA, rule_id: rule.id, bd: ymdIn(KT, new Date(occurred)) });
    expect(new Date(ms[0].occurred_at).toISOString()).toBe(occurred);
    expect(await bal(s, S1, IT2, null)).toEqual({ q: before.q - 2, v: before.v + ms[0].vn });
    expect(r.body.movements).toHaveLength(1); expect(r.body.movements[0]).toMatchObject({ movement_kind: 'consume_calibration', store_id: S1, item_id: IT2 });
    const row = await dbFact(s, r.body.id);
    expect(row).toMatchObject({ source: 'manual', status: 'posted', store_id: S1, rules_applied: 1, created_by: SYS, source_event_id: null }); expect(row.basis_key).toMatch(/^manual:[0-9a-f-]{36}$/);
    expect(n(row.value_paisa_total)).toBe(sum(ms));
  });
  run('value_paisa_total and movement value_paisa only with inventory.cost.read; the DB total always equals the sum of the movements', async (s) => {
    await setupPosted(s, '3');
    const plain = (await logCal(s, TA, mins(5), { instrument_id: I1 })).body;
    expect(Object.keys(plain)).not.toContain('value_paisa_total'); for (const m of plain.movements) expect(Object.keys(m).filter((k) => /_paisa/.test(k))).toEqual([]);
    const costly = (await logCal(s, TA, mins(5), { instrument_id: I1 }, WITH_COST)).body;
    expect(costly.value_paisa_total).toBe(sum(await moves(s, costly.id))); expect(costly.movements[0].value_paisa).toBeDefined();
  });
  run('AC-15.3 qc: observations 3 => multiplier 3, 3 x qty deducted as consume_qc; default observations = 1; the analyte-null rule and the analyte rule both apply (different groups)', async (s) => {
    await mk(s, 'per_qc', IT2, '2', { test_id: TA, analyte_id: AN1 }); await mk(s, 'per_qc', IT3, '1', { test_id: TA }); await setDefault(s, S1);
    const r = await logQc(s, TA, mins(5), { analyte_id: AN1, observations: 3 });
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ fact_kind: 'qc', status: 'posted', multiplier: 3, rules_applied: 2, store_id: S1 });
    const ms = await moves(s, r.body.id);
    expect(ms.map((m: any) => m.kind)).toEqual(['consume_qc', 'consume_qc']);
    expect(ms.find((m: any) => m.item_id === IT2).qn).toBe(-6); expect(ms.find((m: any) => m.item_id === IT3).qn).toBe(-3);
    const one = await logQc(s, TA, mins(5), { analyte_id: AN1 }); expect(one.body.multiplier).toBe(1); expect((await moves(s, one.body.id)).find((m: any) => m.item_id === IT2).qn).toBe(-2);
    const other = await logQc(s, TA, mins(5), { analyte_id: AN2, observations: 2 }); // only the analyte-null rule matches AN2
    expect(other.body.rules_applied).toBe(1); expect((await moves(s, other.body.id)).map((m: any) => m.item_id)).toEqual([IT3]);
  });
  run('instrument-specific rule overrides the generic one for the same item (AC-12.6); a different item\'s generic rule still applies', async (s) => {
    await mk(s, 'per_calibration', IT2, '5', { test_id: TA }); await mk(s, 'per_calibration', IT2, '2', { test_id: TA, instrument_id: I1 }); await mk(s, 'per_calibration', IT3, '1', { test_id: TA }); await bind(s, I1, S1);
    const r = (await logCal(s, TA, mins(5), { instrument_id: I1 })).body; expect(r.rules_applied).toBe(2);
    const ms = await moves(s, r.id); expect(ms.find((m: any) => m.item_id === IT2).qn).toBe(-2); expect(ms.find((m: any) => m.item_id === IT3).qn).toBe(-1);
    const generic = (await logCal(s, TA, mins(5), { instrument_id: I2 })); expect(generic.body.status).toBe('unresolved'); // I2 unbound, no default: the rules still matched (the generic ones)
    expect(generic.body.rules_applied).toBe(2);
  });
  run('AC-15.2 back-dating window: 6 d 23 h ok; 7 d 1 h => 400 at /occurred_at; +4 min ok; +6 min => 400; tenant setting backdate_max_days = 2 moves the limit; nothing written on a refusal', async (s) => {
    await mk(s, 'per_calibration', IT2, '1', { test_id: TA }); await setDefault(s, S1);
    expect((await logCal(s, TA, mins(6 * 1440 + 23 * 60))).status).toBe(201);
    await untouched(s, () => logCal(s, TA, mins(7 * 1440 + 60)), async (e) => { expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); expect(JSON.stringify(e.errors ?? e.detail)).toContain('/occurred_at'); });
    expect((await logCal(s, TA, mins(-4))).status).toBe(201);
    await untouched(s, () => logCal(s, TA, mins(-6)), (e) => { expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? e.detail)).toContain('/occurred_at'); });
    await s.sql(A, 'UPDATE inventory.settings SET backdate_max_days = 2 WHERE tenant_id = $1', [A]);
    await untouched(s, () => logCal(s, TA, mins(3 * 1440)), (e) => expect(e.code).toBe('common.validation_failed')); expect((await logCal(s, TA, mins(1 * 1440))).status).toBe(201);
    await s.sql(A, 'UPDATE inventory.settings SET backdate_max_days = 0 WHERE tenant_id = $1', [A]);
    await untouched(s, () => logCal(s, TA, mins(60)), (e) => expect(e.code).toBe('common.validation_failed'));
  });
  run('no rule => 201 status no_rule, rules_applied 0, no store, NO movements, no balance change; the row is INSERTed with that status (no UPDATE on consumption_facts at all)', async (s) => {
    const before = await snapshot(s); s.log.length = 0;
    const r = await logCal(s, TB, mins(5), { instrument_id: I1 }); // TB has no rule
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ status: 'no_rule', rules_applied: 0, movements: [], source: 'manual' }); expect(r.body.store_id).toBeUndefined();
    expect(factUpdates(s)).toEqual([]);
    expect(await cnt(s, 'stock_movements')).toBe(JSON.parse(before)[1]);
    const row = await dbFact(s, r.body.id); expect(row).toMatchObject({ status: 'no_rule', store_id: null, rules_applied: 0 }); expect(n(row.value_paisa_total)).toBe(0);
  });
  run('rules matched, no store => 201 status unresolved (final at insert, no UPDATE), nothing deducted; ONE unresolved_consumption alert per dedupe key unresolved:<instrument>; no-instrument => unresolved:none', async (s) => {
    await mk(s, 'per_calibration', IT2, '1', { test_id: TA }); const before = await bal(s, S1, IT2, null); s.log.length = 0;
    const r = (await logCal(s, TA, mins(5), { instrument_id: I1 })).body;
    expect(r).toMatchObject({ status: 'unresolved', rules_applied: 1, movements: [] }); expect(r.store_id).toBeUndefined(); expect(factUpdates(s)).toEqual([]);
    expect(await bal(s, S1, IT2, null)).toEqual(before); expect(await cnt(s, 'stock_movements', 'doc_id = $2', [r.id])).toBe(0);
    const alerts = async (key: string) => cnt(s, 'alerts', "alert_kind = 'unresolved_consumption' AND dedupe_key = $2 AND status <> 'resolved'", [key]);
    expect(await alerts(`unresolved:${I1}`)).toBe(1);
    await logCal(s, TA, mins(4), { instrument_id: I1 }); expect(await alerts(`unresolved:${I1}`)).toBe(1); // deduped
    await logCal(s, TA, mins(3)); expect(await alerts('unresolved:none')).toBe(1);
    expect(await cnt(s, 'consumption_facts', "status = 'unresolved' AND basis_key LIKE 'manual:%' AND id <> $2", [FR])).toBe(3); // ruling (B): EXTRAS' committed FR is also a manual unresolved fact
  });
  run('a manual fact WITHOUT an instrument resolves through step 5 (settings default store); posted facts never UPDATE `status`, only value_paisa_total', async (s) => {
    await mk(s, 'per_calibration', IT2, '1', { test_id: TA }); await setDefault(s, D2); s.log.length = 0;
    const r = (await logCal(s, TA, mins(5))).body; expect(r).toMatchObject({ status: 'posted', store_id: D2 });
    const ups = factUpdates(s); for (const u of ups) { expect(u).not.toMatch(/\bstatus\b/i); expect(u).toMatch(/value_paisa_total/i); }
  });
  run('NO RULE CACHE (TRD §11): every call reads consumption_rules; a rule created after a no_rule call applies to the very next call; rules are NOT retroactive (event before effective_from => no_rule)', async (s) => {
    s.log.length = 0; const first = (await logCal(s, TA, mins(5), { instrument_id: I1 })).body; expect(first.status).toBe('no_rule'); expect(ruleReads(s).length).toBeGreaterThanOrEqual(1);
    await mk(s, 'per_calibration', IT2, '1', { test_id: TA }); await bind(s, I1, S1); s.log.length = 0;
    const second = (await logCal(s, TA, mins(5), { instrument_id: I1 })).body; expect(second.status).toBe('posted'); expect(ruleReads(s).length).toBeGreaterThanOrEqual(1);
    const old = (await logCal(s, TA, days(1), { instrument_id: I1 })).body; expect(old.status).toBe('no_rule');
    await s.call(A, 'deactivateConsumptionRule', { params: { rule_id: (await s.sql(A, "SELECT id FROM inventory.consumption_rules WHERE test_id = $2 AND rule_kind = 'per_calibration' AND item_id = $3 AND tenant_id = $1", [A, TA, IT2]))[0].id }, headers: ifm(1) }, { now: mins(10) } as ConsOpts); // effective_to = 10 min ago, so the 5-min-old event is outside the window
    expect((await logCal(s, TA, mins(5), { instrument_id: I1 })).body.status).toBe('no_rule'); // deactivation is seen immediately
  });
  run('rules are evaluated at occurred_at: an event inside the OLD window of a superseded rule uses the old qty, a later one the new qty (TRD §8.3.4)', async (s) => {
    const r = await mk(s, 'per_calibration', IT2, '2', { test_id: TA }, { now: mins(10) } as ConsOpts); await bind(s, I1, S1);
    await s.call(A, 'supersedeConsumptionRule', { params: { rule_id: r.id }, headers: ifm(r.version), body: supersedeBody('5') }, { now: mins(3) } as ConsOpts);
    const inOld = (await logCal(s, TA, mins(5), { instrument_id: I1 })).body, inNew = (await logCal(s, TA, mins(1), { instrument_id: I1 })).body;
    expect((await moves(s, inOld.id))[0].qn).toBe(-2); expect((await moves(s, inNew.id))[0].qn).toBe(-5);
  });
  run('lot selection: FEFO (LB expires first: 7 from LB, 3 from LA, exact values), an open container of the instrument\'s lot wins over FEFO', async (s) => {
    await mk(s, 'per_calibration', IT1, '10', { test_id: TA }); await bind(s, I1, S1);
    const fefo = (await logCal(s, TA, mins(5), { instrument_id: I1 })).body; const ms = await moves(s, fefo.id);
    expect(ms.map((m: any) => [m.lot_id, m.qn, m.vn]).sort()).toEqual([[LA, -3, -300], [LB, -7, -1000]].sort());
    await s.sql(A, `INSERT INTO inventory.opened_containers (id, tenant_id, store_id, item_id, lot_id, instrument_id, opened_at, opened_by, open_expiry_at, status, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, now(), $7, now() + interval '20 days', 'open', $7, $7)`, [uid(950000 + s.seq()), A, S1, IT1, LA, I1, SYS]);
    const inUse = (await logCal(s, TA, mins(4), { instrument_id: I1 })).body; const m2 = await moves(s, inUse.id);
    expect(m2.map((m: any) => [m.lot_id, m.qn])).toEqual([[LA, -10]]);
  });
  run('short stock never blocks consumption: the remainder goes to the unlotted row (negative) and ONE negative_stock alert is raised (TRD §4.5)', async (s) => {
    await mk(s, 'per_calibration', IT2, '60', { test_id: TA }); await bind(s, I1, S1);
    const r = (await logCal(s, TA, mins(5), { instrument_id: I1 })).body; expect(r.status).toBe('posted');
    expect(await bal(s, S1, IT2, null)).toMatchObject({ q: -10 });
    expect(await cnt(s, 'alerts', "alert_kind = 'negative_stock' AND store_id = $2 AND item_id = $3 AND status <> 'resolved'", [S1, IT2])).toBe(1);
  });
  run('two identical requests are two facts (basis_key manual:<new uuid> per request; the pipeline\'s idempotency key covers retries)', async (s) => {
    await mk(s, 'per_calibration', IT2, '1', { test_id: TA }); await bind(s, I1, S1); const b = await bal(s, S1, IT2, null);
    const a = (await logCal(s, TA, mins(5), { instrument_id: I1 })).body, c = (await logCal(s, TA, mins(5), { instrument_id: I1 })).body;
    expect(a.id).not.toBe(c.id); expect((await bal(s, S1, IT2, null)).q).toBe(b.q - 2);
    expect(new Set((await s.sql(A, 'SELECT basis_key FROM inventory.consumption_facts WHERE id = ANY($1)', [[a.id, c.id]])).map((r: any) => r.basis_key)).size).toBe(2);
  });
  run('P-B7 branch scope: a BR1-only caller whose rules resolve to a BR2 store (I2 -> S2) => 403 auth.forbidden, NOTHING written (no fact, no movement, no balance change); BR1 store ok; no_rule / unresolved need tenant scope only', async (s) => {
    await mk(s, 'per_calibration', IT2, '1', { test_id: TA }); await bind(s, I2, S2); await bind(s, I1, S1);
    await untouched(s, () => logCal(s, TA, mins(5), { instrument_id: I2 }, BR1_ONLY), (e) => expect(e.code).toBe('auth.forbidden'));
    expect((await logCal(s, TA, mins(5), { instrument_id: I1 }, BR1_ONLY)).body.status).toBe('posted');
    await untouched(s, () => logCal(s, TA, mins(5), { instrument_id: I1 }, BR2_ONLY), (e) => expect(e.code).toBe('auth.forbidden'));
    expect((await logCal(s, TB, mins(5), { instrument_id: I2 }, BR1_ONLY)).body.status).toBe('no_rule'); // no rule for TB
    await mk(s, 'per_calibration', IT3, '1', { test_id: TB }); expect((await logCal(s, TB, mins(5), { instrument_id: uid(422) }, BR1_ONLY)).body.status).toBe('unresolved');
  });
  run('permission: item.read / master.manage without bench.record => 403 and nothing written', async (s) => {
    await mk(s, 'per_calibration', IT2, '1', { test_id: TA }); await setDefault(s, S1);
    await untouched(s, () => logCal(s, TA, mins(5), {}, READER), (e) => expect(e.code).toBe('auth.forbidden'));
    await untouched(s, () => logCal(s, TA, mins(5), {}, { permissions: [READ, MANAGE] }), (e) => expect(e.code).toBe('auth.forbidden'));
  });
});

// ======================================================================================================== #75 list facts
describe.skipIf(!live)('T-15 #75 listConsumptionFacts (P-B1: branch-filtered, NULL-store facts included)', () => {
  const ids = async (s: Sess, query: Record<string, unknown>, o?: ConsOpts, t = A) => (await s.call(t, 'listConsumptionFacts', { query }, o)).body.data.map((f: any) => f.id);
  run('tenant-wide caller sees the fixtures 7201 7203 7202 and never tenant B\'s 7301; wire = Fact keys, no basis_key / source_event_id / audit columns', async (s) => {
    const r = (await s.call(A, 'listConsumptionFacts', { query: {} })).body;
    const got = r.data.map((f: any) => f.id); expect(got).toEqual(expect.arrayContaining([FACT_U1, FACT_U2, FACT_P])); expect(got).not.toContain(FACT_B);
    for (const f of r.data) { expect(onlyKeys(f, FACT_KEYS)).toEqual([]); for (const k of SECRET_FACT_KEYS) expect(Object.keys(f)).not.toContain(k); expect(JSON.stringify(f)).not.toMatch(LEAK); expect(Array.isArray(f.movements)).toBe(true); }
    expect(await ids(s, {}, undefined, B)).toContain(FACT_B); expect(await ids(s, {}, undefined, B)).not.toContain(FACT_U1);
  });
  run('P-B1: BR1-only sees the BR1-store fact 7202 and the NULL-store facts; BR2-only sees the NULL-store facts but NOT 7202; a BR2-store fact is invisible to BR1-only (and its movements with it)', async (s) => {
    expect(await ids(s, {}, BR1_ONLY)).toEqual(expect.arrayContaining([FACT_P, FACT_U1, FACT_U2]));
    const br2 = await ids(s, {}, BR2_ONLY); expect(br2).toEqual(expect.arrayContaining([FACT_U1, FACT_U2])); expect(br2).not.toContain(FACT_P);
    await mk(s, 'per_calibration', IT2, '1', { test_id: TA }); await bind(s, I2, D2);
    const f2 = (await logCal(s, TA, mins(5), { instrument_id: I2 })).body; expect(f2.store_id).toBe(D2);
    expect(await ids(s, {}, BR1_ONLY)).not.toContain(f2.id); expect(await ids(s, {}, BR2_ONLY)).toContain(f2.id);
    const seen = (await s.call(A, 'listConsumptionFacts', { query: { status: 'posted' } }, BR1_ONLY)).body.data;
    for (const f of seen) for (const m of f.movements) expect(m.store_id).not.toBe(D2);
    for (const f of (await s.call(A, 'listConsumptionFacts', { query: {} }, BR2_ONLY)).body.data) expect(f.store_id === undefined || f.store_id !== S1).toBe(true);
  });
  run('filters: status, fact_kind, instrument_id, test_id, business_date_from; limit + cursor page without overlap', async (s) => {
    expect(await ids(s, { status: 'unresolved' })).toEqual(expect.arrayContaining([FACT_U1, FACT_U2])); expect(await ids(s, { status: 'unresolved' })).not.toContain(FACT_P);
    expect(await ids(s, { status: 'posted' })).toContain(FACT_P); expect(await ids(s, { status: 'reversed' })).not.toContain(FACT_P);
    expect(await ids(s, { fact_kind: 'test', instrument_id: uid(421), test_id: FIX_TEST })).toEqual(expect.arrayContaining([FACT_U1, FACT_P]));
    expect(await ids(s, { fact_kind: 'qc' })).not.toContain(FACT_P); expect(await ids(s, { instrument_id: uid(422) })).not.toContain(FACT_P);
    const today = ymdIn(KT); expect(await ids(s, { business_date_from: addDays(today, 3) })).toEqual([]);
    const p1 = (await s.call(A, 'listConsumptionFacts', { query: { limit: 1 } })).body; expect(p1.data).toHaveLength(1); expect(p1.page.next_cursor).toBeTruthy();
    expect((await s.call(A, 'listConsumptionFacts', { query: { limit: 1, cursor: p1.page.next_cursor } })).body.data[0].id).not.toBe(p1.data[0].id);
  });
  run('READER may list; a caller without item.read => 403', async (s) => { expect((await s.call(A, 'listConsumptionFacts', { query: {} }, READER)).status).toBe(200); await forbidden(s.call(A, 'listConsumptionFacts', { query: {} }, { permissions: [] })); });
});

// ======================================================================================================== #77 resolve, #78 dismiss (AC-17.3)
describe.skipIf(!live)('T-15 #77 resolveConsumptionFact', () => {
  async function unresolved(s: Sess, occurredMinutesAgo = 2 * 1440) {
    await mk(s, 'per_calibration', IT2, '2', { test_id: TA }, { now: days(3) } as ConsOpts);
    return (await logCal(s, TA, mins(occurredMinutesAgo), { instrument_id: I1 })).body;
  }
  run('resolve to a store: 200 posted, movements with the fact\'s ORIGINAL occurred_at / business_date, balance moved, resolved_at / resolved_by set, value total = sum of movements', async (s) => {
    const f = await unresolved(s); expect(f.status).toBe('unresolved'); const before = await bal(s, S1, IT2, null);
    const r = await s.call(A, 'resolveConsumptionFact', { params: { fact_id: f.id }, headers: ifm(f.version), body: resolveBody(S1) });
    expect(r.status).toBe(200); expect(onlyKeys(r.body, FACT_KEYS)).toEqual([]); expect(r.body).toMatchObject({ id: f.id, status: 'posted', store_id: S1, rules_applied: 1, version: f.version + 1, occurred_at: f.occurred_at, business_date: f.business_date });
    const ms = await moves(s, f.id); expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: 'consume_calibration', store_id: S1, qn: -2, bd: f.business_date, instrument_id: I1, attributed_test_id: TA }); expect(new Date(ms[0].occurred_at).toISOString()).toBe(f.occurred_at);
    expect(await bal(s, S1, IT2, null)).toEqual({ q: before.q - 2, v: before.v + ms[0].vn });
    const row = await dbFact(s, f.id); expect(row.resolved_at).not.toBeNull(); expect(row.resolved_by).toBe(SYS); expect(n(row.value_paisa_total)).toBe(sum(ms));
    expect(roleBranches(s)).toContain(BR1);
  });
  run('re-evaluates with the ORIGINAL time: a rule superseded after the event still applies with its old qty; a rule created after the event does not', async (s) => {
    const f = await unresolved(s); const rule = (await s.sql(A, "SELECT id, version FROM inventory.consumption_rules WHERE tenant_id = $1 AND test_id = $2 AND rule_kind = 'per_calibration'", [A, TA]))[0];
    await s.call(A, 'supersedeConsumptionRule', { params: { rule_id: rule.id }, headers: ifm(rule.version), body: supersedeBody('9') });
    await mk(s, 'per_calibration', IT3, '4', { test_id: TA, instrument_id: I1 }); // created after the event => not part of it
    await s.call(A, 'resolveConsumptionFact', { params: { fact_id: f.id }, headers: ifm(f.version), body: resolveBody(S1) });
    const ms = await moves(s, f.id); expect(ms.map((m: any) => [m.item_id, m.qn])).toEqual([[IT2, -2]]);
  });
  run('only an UNRESOLVED fact: posted / no_rule / dismissed / reversed => 409 inventory.document_invalid_transition, nothing written; unknown / tenant-B fact => 404', async (s) => {
    const posted = await setupPosted(s); const nr = (await logCal(s, TB, mins(5))).body;
    for (const f of [posted, nr]) await untouched(s, () => s.call(A, 'resolveConsumptionFact', { params: { fact_id: f.id }, headers: ifm(f.version), body: resolveBody(S1) }), (e) => { expect(e.code).toBe('inventory.document_invalid_transition'); expect(e.statusCode).toBe(409); });
    await s.call(A, 'reverseConsumptionFact', { params: { fact_id: posted.id }, headers: ifm(posted.version), body: reasonBody('logged_in_error') });
    await invalid(s.call(A, 'resolveConsumptionFact', { params: { fact_id: posted.id }, headers: ifm(posted.version + 1), body: resolveBody(S1) }));
    await nf(s.call(A, 'resolveConsumptionFact', { params: { fact_id: uid(99993) }, headers: ifm(1), body: resolveBody(S1) })); await nf(s.call(A, 'resolveConsumptionFact', { params: { fact_id: FACT_B }, headers: ifm(1), body: resolveBody(S1) }));
    await nf(s.call(B, 'resolveConsumptionFact', { params: { fact_id: FACT_U1 }, headers: ifm(1), body: resolveBody(uid(1101)) }));
  });
  run('store rules: unknown store 404; INACTIVE store => 400 at /store_id; a store in a branch the caller cannot see => 404; without master.manage on a visible store => 403; stale If-Match => 409 common.version_conflict', async (s) => {
    const f = await unresolved(s); const call77 = (store: string, o?: ConsOpts, v = f.version) => s.call(A, 'resolveConsumptionFact', { params: { fact_id: f.id }, headers: ifm(v), body: resolveBody(store) }, o);
    await untouched(s, () => call77(uid(99992)), (e) => expect(e.code).toBe('common.not_found'));
    await untouched(s, () => call77(SI), (e) => { expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? e.detail)).toContain('/store_id'); });
    await untouched(s, () => call77(S2, BR1_ONLY), (e) => expect(e.code).toBe('common.not_found'));
    await untouched(s, () => call77(S1, { permissions: [READ, BENCH] }), (e) => expect(e.code).toBe('auth.forbidden'));
    await untouched(s, () => call77(S1, undefined, f.version + 4), (e) => { expect(e.code).toBe('common.version_conflict'); expect(e.statusCode).toBe(409); });
    expect((await call77(S1, BR1_ONLY)).body.status).toBe('posted');
  });
  it.skipIf(!live)('race: 6 parallel resolves of ONE fact => exactly one wins (the others 409), the movement is posted once', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => committed((s) => s.call(A, 'resolveConsumptionFact', { params: { fact_id: FR }, headers: ifm(1), body: resolveBody(S3) }))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect([409]).toContain((r.reason as any).statusCode);
    const rows = await admin.query("SELECT count(*)::int AS n FROM inventory.stock_movements WHERE doc_type = 'consumption_fact' AND doc_id = $1", [FR]); expect(rows.rows[0].n).toBe(1);
    expect((await admin.query('SELECT status FROM inventory.consumption_facts WHERE id = $1', [FR])).rows[0].status).toBe('posted');
  }, 60_000);
});
const roleBranches = (s: Sess) => s.roleCalls.map((c) => c.branchId).filter(Boolean);

describe.skipIf(!live)('T-15 #78 dismissConsumptionFact (AC-17.3)', () => {
  run('AC-17.3 dismiss: status dismissed, reason stored, NOTHING deducted, still listed (status filter) for reconciliation; version + 1; tenant scope only (a BR1-only caller may dismiss a NULL-store fact)', async (s) => {
    await mk(s, 'per_calibration', IT2, '2', { test_id: TA }); const f = (await logCal(s, TA, mins(5), { instrument_id: I1 })).body; expect(f.status).toBe('unresolved');
    const snap = JSON.stringify(await s.sql(A, 'SELECT id, qty_base, value_paisa FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [A])); const mv = await cnt(s, 'stock_movements');
    const r = await s.call(A, 'dismissConsumptionFact', { params: { fact_id: f.id }, headers: ifm(f.version), body: reasonBody('not_consumed') }, BR1_ONLY);
    expect(r.status).toBe(200); expect(onlyKeys(r.body, FACT_KEYS)).toEqual([]); expect(r.body).toMatchObject({ id: f.id, status: 'dismissed', reason_code: 'not_consumed', version: f.version + 1, movements: [] });
    expect(JSON.stringify(await s.sql(A, 'SELECT id, qty_base, value_paisa FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [A]))).toBe(snap); expect(await cnt(s, 'stock_movements')).toBe(mv);
    expect(await dbFact(s, f.id)).toMatchObject({ status: 'dismissed', reason_code: 'not_consumed' });
    expect((await s.call(A, 'listConsumptionFacts', { query: { status: 'dismissed' } })).body.data.map((x: any) => x.id)).toContain(f.id);
    await invalid(s.call(A, 'resolveConsumptionFact', { params: { fact_id: f.id }, headers: ifm(r.body.version), body: resolveBody(S1) }));
    await invalid(s.call(A, 'dismissConsumptionFact', { params: { fact_id: f.id }, headers: ifm(r.body.version), body: reasonBody('other') }));
  });
  run('only UNRESOLVED facts: posted / no_rule => 409; a reason outside group fact_dismiss (calibration `scheduled`, fact_reverse `logged_in_error`, unknown) => 422 inventory.reason_required; stale If-Match 409; unknown 404; tenant B 404; READER 403', async (s) => {
    const posted = await setupPosted(s); const nr = (await logCal(s, TB, mins(5))).body;
    for (const f of [posted, nr]) await untouched(s, () => s.call(A, 'dismissConsumptionFact', { params: { fact_id: f.id }, headers: ifm(f.version), body: reasonBody('other') }), (e) => expect(e.code).toBe('inventory.document_invalid_transition'));
    const u = (await logCal(s, TA, mins(5), { instrument_id: I2 })).body; expect(u.status).toBe('unresolved');
    for (const reason of ['scheduled', 'logged_in_error', 'no_such_reason']) await untouched(s, () => s.call(A, 'dismissConsumptionFact', { params: { fact_id: u.id }, headers: ifm(u.version), body: reasonBody(reason) }), (e) => { expect(e.code).toBe('inventory.reason_required'); expect(e.statusCode).toBe(422); });
    await untouched(s, () => s.call(A, 'dismissConsumptionFact', { params: { fact_id: u.id }, headers: ifm(u.version + 3), body: reasonBody('other') }), (e) => expect(e.code).toBe('common.version_conflict'));
    await nf(s.call(A, 'dismissConsumptionFact', { params: { fact_id: uid(99991) }, headers: ifm(1), body: reasonBody('other') })); await nf(s.call(A, 'dismissConsumptionFact', { params: { fact_id: FACT_B }, headers: ifm(1), body: reasonBody('other') }));
    await untouched(s, () => s.call(A, 'dismissConsumptionFact', { params: { fact_id: u.id }, headers: ifm(u.version), body: reasonBody('other') }, READER), (e) => expect(e.code).toBe('auth.forbidden'));
  });
});

// ======================================================================================================== #79 reverse (AC-15.4)
describe.skipIf(!live)('T-15 #79 reverseConsumptionFact (AC-15.4, A4, A10, PE-1)', () => {
  const rev = (s: Sess, f: { id: string; version: number }, o?: ConsOpts, reason = 'logged_in_error', v?: number) => s.call(A, 'reverseConsumptionFact', { params: { fact_id: f.id }, headers: ifm(v ?? f.version), body: reasonBody(reason) }, o);
  run('exactness: a fact that took 7 from LB and 3 from LA is reversed AFTER the cost moved; consume_reversal movements give back the SAME qty and the SAME value per lot (not a re-costed value), same store / lot, reverses_movement_id set; status reversed', async (s) => {
    const f = await setupPosted(s, '10', IT1); const orig = await moves(s, f.id); expect(orig.map((m: any) => [m.lot_id, m.qn, m.vn]).sort()).toEqual([[LA, -3, -300], [LB, -7, -1000]].sort());
    await ledger.post({ tx: s.tx, tenantId: A, actorId: SYS }, { doc_type: 'goods_receipt', doc_id: uid(950000 + s.seq()), occurred_at: new Date().toISOString(), business_date: ymdIn(KT), movements: [{ store_id: S1, item_id: IT1, lot_id: LA, kind: 'receive', qty_base: '50', value_hint: 25000 }] });
    const afterReceipt = await bal(s, S1, IT1, LA); expect(afterReceipt.v / afterReceipt.q).not.toBeCloseTo(100, 0); // average cost moved
    const r = await rev(s, f);
    expect(r.status).toBe(200); expect(onlyKeys(r.body, FACT_KEYS)).toEqual([]); expect(r.body).toMatchObject({ id: f.id, status: 'reversed', reason_code: 'logged_in_error', version: f.version + 1 });
    const all = await moves(s, f.id); const reversals = all.filter((m: any) => m.kind === 'consume_reversal');
    expect(reversals).toHaveLength(2);
    for (const o of orig) { const m = reversals.find((x: any) => x.reverses_movement_id === o.id); expect(m, `reversal of ${o.lot_id}`).toBeDefined(); expect(m).toMatchObject({ store_id: o.store_id, item_id: o.item_id, lot_id: o.lot_id, qn: -o.qn, vn: -o.vn }); }
    expect(await bal(s, S1, IT1, LB)).toEqual({ q: 7, v: 1000 }); expect(await bal(s, S1, IT1, LA)).toEqual({ q: afterReceipt.q + 3, v: afterReceipt.v + 300 });
    expect(r.body.movements.map((m: any) => m.movement_kind).sort()).toEqual(['consume_calibration', 'consume_calibration', 'consume_reversal', 'consume_reversal']);
    expect((await dbFact(s, f.id)).status).toBe('reversed');
  });
  run('fractional value: 2 of 7 units worth 1000 (285.71 each...) is reversed with the exact stored value of the original movement', async (s) => {
    await mk(s, 'per_calibration', IT1, '2', { test_id: TA }); await bind(s, I1, S1);
    const f = (await logCal(s, TA, mins(5), { instrument_id: I1 })).body; const o = (await moves(s, f.id))[0]; expect(o.lot_id).toBe(LB); expect(o.qn).toBe(-2); expect([285, 286]).toContain(Math.abs(o.vn)); // 1000 * 2 / 7 = 285.71 (rounding is the ledger's, T-05)
    await ledger.post({ tx: s.tx, tenantId: A, actorId: SYS }, { doc_type: 'goods_receipt', doc_id: uid(950000 + s.seq()), occurred_at: new Date().toISOString(), business_date: ymdIn(KT), movements: [{ store_id: S1, item_id: IT1, lot_id: LB, kind: 'receive', qty_base: '10', value_hint: 3000 }] });
    await rev(s, f); const back = (await moves(s, f.id)).find((m: any) => m.kind === 'consume_reversal'); expect(back).toMatchObject({ qn: 2, vn: -o.vn, lot_id: LB });
    expect(await bal(s, S1, IT1, LB)).toEqual({ q: 7 + 10, v: 1000 + 3000 });
  });
  run('A4: an EVENT-sourced fact (FE) is not reversible => 409 inventory.fact_not_reversible, even for the privileged caller; nothing written. Checked BEFORE the status rule', async (s) => {
    await untouched(s, () => rev(s, { id: FE, version: 1 }), (e) => { expect(e.code).toBe('inventory.fact_not_reversible'); expect(e.statusCode).toBe(409); });
    expect((await dbFact(s, FE)).status).toBe('posted');
  });
  run('state: unresolved / no_rule / dismissed / already reversed => 409 inventory.document_invalid_transition; a second reversal never posts again', async (s) => {
    await mk(s, 'per_calibration', IT2, '1', { test_id: TA }); const un = (await logCal(s, TA, mins(5), { instrument_id: I2 })).body; const nr = (await logCal(s, TB, mins(5))).body;
    const dis = (await s.call(A, 'dismissConsumptionFact', { params: { fact_id: un.id }, headers: ifm(un.version), body: reasonBody('other') })).body;
    const un2 = (await logCal(s, TA, mins(4), { instrument_id: I2 })).body;
    for (const f of [un2, nr, dis]) await untouched(s, () => rev(s, f), (e) => expect(e.code).toBe('inventory.document_invalid_transition'));
    await bind(s, I1, S1); const p = (await logCal(s, TA, mins(5), { instrument_id: I1 })).body; const r1 = (await rev(s, p)).body; const mv = await cnt(s, 'stock_movements'); // ruling (C): the rule from line 1 of this test is current already (no second mk => no rule_conflict)
    await untouched(s, () => rev(s, r1), (e) => { expect(e.code).toBe('inventory.document_invalid_transition'); expect(e.statusCode).toBe(409); }); expect(await cnt(s, 'stock_movements')).toBe(mv);
  });
  run('PE-1 / P-B8: without stock.adjust => 403 (asserted at the fact store\'s branch); at aal1 => 403 auth.mfa_required; a caller who cannot see the store\'s branch => 404; reason outside fact_reverse (fact_dismiss `other`? shared code; `not_consumed`) => 422 inventory.reason_required; stale If-Match => 409', async (s) => {
    const f = await setupPosted(s);
    await untouched(s, () => rev(s, f, { permissions: [READ, MANAGE, BENCH] }), (e) => expect(e.code).toBe('auth.forbidden')); expect(s.roleCalls.some((c) => c.permission === ADJUST && c.branchId === BR1)).toBe(true);
    await untouched(s, () => rev(s, f, { aal: 'aal1' } as ConsOpts), (e) => { expect(e.code).toBe('auth.mfa_required'); expect(e.statusCode).toBe(403); });
    await untouched(s, () => rev(s, f, BR2_ONLY), (e) => expect(e.code).toBe('common.not_found'));
    for (const reason of ['not_consumed', 'scheduled', 'no_such_reason']) await untouched(s, () => rev(s, f, undefined, reason), (e) => { expect(e.code).toBe('inventory.reason_required'); expect(e.statusCode).toBe(422); });
    await untouched(s, () => rev(s, f, undefined, 'logged_in_error', f.version + 7), (e) => { expect(e.code).toBe('common.version_conflict'); expect(e.statusCode).toBe(409); });
    await nf(s.call(A, 'reverseConsumptionFact', { params: { fact_id: uid(99990) }, headers: ifm(1), body: reasonBody('other') })); await nf(s.call(A, 'reverseConsumptionFact', { params: { fact_id: FACT_B }, headers: ifm(1), body: reasonBody('other') }));
    expect((await rev(s, f, BR1_ONLY)).body.status).toBe('reversed');
  });
  it('race: 6 parallel reversals of ONE committed manual fact => exactly one wins, ONE set of reversal movements, balance restored once', async () => {
    const f = (await committed(async (s) => (await logCal(s, TC, mins(5), { instrument_id: I3 })).body)); expect(f.status).toBe('posted'); expect(f.store_id).toBe(S3);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => committed((s) => rev(s, f))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect([409]).toContain((r.reason as any).statusCode);
    const m = await admin.query("SELECT movement_kind, count(*)::int AS n FROM inventory.stock_movements WHERE doc_type = 'consumption_fact' AND doc_id = $1 GROUP BY 1 ORDER BY 1", [f.id]);
    expect(m.rows).toEqual([{ movement_kind: 'consume_calibration', n: 1 }, { movement_kind: 'consume_reversal', n: 1 }]);
  }, 60_000);
});

// ======================================================================================================== worker task inventory.resolve_unresolved (AC-17.2; 02-TRD §9: <= 1,000 per run, oldest first, re-enqueues itself)
// SEAM: services/worker/src/jobs/inventory/tasks/inventory.resolve_unresolved.ts exports `resolveUnresolved(payload: { tenant_id }, ctx: JobContext)` (the TRD §9 manifest name) and the manifest registers THAT function.
// The task re-runs TRD §8.2-8.4 for `unresolved` facts of the ctx tenant (system actor), evaluating rules at each fact's ORIGINAL occurred_at; shared logic lives in consumers.service / consumption.service.
describe.skipIf(!live)('T-15 inventory.resolve_unresolved task (AC-17.2)', () => {
  const taskUrl = new URL('../../../../../../worker/src/jobs/inventory/tasks/inventory.resolve_unresolved.ts', import.meta.url).href;
  const manifestUrl = new URL('../../../../../../worker/src/jobs/inventory/index.ts', import.meta.url).href;
  const load = () => import(/* @vite-ignore */ taskUrl) as Promise<{ resolveUnresolved: (p: unknown, c: unknown) => Promise<void> }>;
  async function jobCtx(s: Sess, tenant = A) {
    const { createCoreRepo } = await import('../../../../core/core-repo/index.js');
    let sp = 0;
    const ctx: any = { tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: 'r-t15-task', tx: s.tx, now: () => new Date().toISOString(), attempt: 1, maxAttempts: 10, jobId: 'job-t15', isNewer: () => true,
      core: createCoreRepo({ withTenantScope: async (_t: unknown, _tenant: unknown, _actor: unknown, fn: () => unknown) => fn(), systemActorOf: () => SYS }), events: {}, storage: {}, files: {}, audit: {},
      log: { info() {}, warn() {}, error() {} } };
    ctx.db = { async tx(fn: (c: unknown) => Promise<unknown>) { const name = `t15_task_sp_${++sp}`; await s.tx.query(`SAVEPOINT ${name}`); try { const r = await fn(ctx); await s.tx.query(`RELEASE SAVEPOINT ${name}`); return r; } catch (e) { await s.tx.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; } } };
    return ctx;
  }
  const runTask = async (s: Sess, payload: Record<string, unknown> = { tenant_id: A }) => { const t = await load(); await t.resolveUnresolved(payload, await jobCtx(s)); };
  const enqueues = (s: Sess) => s.log.filter((t) => /enqueue_job/i.test(t));
  async function twoUnresolved(s: Sess) {
    await mk(s, 'per_calibration', IT2, '2', { test_id: TA }, { now: days(3) } as ConsOpts);
    const a = (await logCal(s, TA, mins(3 * 60), { instrument_id: I1 })).body, b = (await logCal(s, TA, mins(2 * 60), { instrument_id: I1 })).body, c = (await logCal(s, TA, mins(60), { instrument_id: I2 })).body;
    for (const f of [a, b, c]) expect(f.status).toBe('unresolved');
    return { a, b, c };
  }

  it('the manifest registers the real task (no longer the T-01 stub); the task is exported by the file the plan names', async () => {
    const mod = await load(); const manifest = ((await import(/* @vite-ignore */ manifestUrl)) as any).manifest;
    expect(typeof mod.resolveUnresolved).toBe('function'); expect(manifest.tasks['inventory.resolve_unresolved']).toBe(mod.resolveUnresolved);
  });
  run('AC-17.2: after the instrument is bound, the task posts ITS unresolved facts to the bound store with the ORIGINAL occurred_at / business_date; the other instrument\'s fact stays unresolved', async (s) => {
    const { a, b, c } = await twoUnresolved(s); await bind(s, I1, S1); const before = await bal(s, S1, IT2, null);
    await runTask(s);
    for (const f of [a, b]) {
      const row = await dbFact(s, f.id); expect(row).toMatchObject({ status: 'posted', store_id: S1 }); expect(row.resolved_at).not.toBeNull();
      const ms = await moves(s, f.id); expect(ms).toHaveLength(1); expect(ms[0]).toMatchObject({ kind: 'consume_calibration', store_id: S1, item_id: IT2, qn: -2, bd: f.business_date }); expect(new Date(ms[0].occurred_at).toISOString()).toBe(f.occurred_at);
      expect(n(row.value_paisa_total)).toBe(sum(ms));
    }
    expect(await bal(s, S1, IT2, null)).toMatchObject({ q: before.q - 4 });
    expect((await dbFact(s, c.id)).status).toBe('unresolved'); expect(await moves(s, c.id)).toEqual([]);
  });
  run('a default consumption store (step 5) resolves every unresolved fact; a second run is a no-op (no movement twice); posted / dismissed / no_rule / reversed facts are never touched', async (s) => {
    const { a, b, c } = await twoUnresolved(s); const dis = (await s.call(A, 'dismissConsumptionFact', { params: { fact_id: b.id }, headers: ifm(b.version), body: reasonBody('other') })).body;
    const nr = (await logCal(s, TB, mins(5))).body; await setDefault(s, D2);
    await runTask(s);
    expect((await dbFact(s, a.id)).status).toBe('posted'); expect((await dbFact(s, c.id)).status).toBe('posted'); expect((await dbFact(s, c.id)).store_id).toBe(D2);
    expect((await dbFact(s, dis.id)).status).toBe('dismissed'); expect(await moves(s, dis.id)).toEqual([]); expect((await dbFact(s, nr.id)).status).toBe('no_rule');
    const m = await cnt(s, 'stock_movements'); await runTask(s); expect(await cnt(s, 'stock_movements')).toBe(m);
  });
  run('nothing resolvable (no binding, no default) => the task succeeds and changes nothing; tenant B facts (fixture 7301) are never touched by a tenant A run', async (s) => {
    const { a } = await twoUnresolved(s);
    await runTask(s); const snap = await snapshot(s); // ruling (D): fixture facts 7201/7203 are resolvable (binding 9401 + rules 7001/7002), so the first run posts them; the snapshot is taken after it
    await runTask(s); expect(await snapshot(s)).toBe(snap); expect((await dbFact(s, a.id)).status).toBe('unresolved');
    expect((await dbFact(s, FACT_B, B)).status).toBe('unresolved'); await setDefault(s, S1); await runTask(s);
    expect((await dbFact(s, FACT_B, B)).status).toBe('unresolved'); expect(await moves(s, FACT_B)).toEqual([]);
  });
  run('limit: at most 1,000 facts per run, OLDEST first, and the task re-enqueues itself (job_key resolve:<tenant>:...) while more remain; no enqueue when everything fit', async (s) => {
    await mk(s, 'per_calibration', IT2, '1', { test_id: TA }, { now: days(5) } as ConsOpts); await setDefault(s, S1);
    await s.sql(A, `INSERT INTO inventory.consumption_facts (id, tenant_id, fact_kind, basis_key, source, instrument_id, test_id, occurred_at, business_date, status, rules_applied, created_by, updated_by)
      SELECT ('0190c514-0000-7000-8001-' || lpad(g::text, 12, '0'))::uuid, $1, 'calibration', 'manual:t15-bulk-' || g, 'manual', $2, $3, now() - interval '2 days' + (g || ' seconds')::interval,
             (now() - interval '2 days')::date, 'unresolved', 1, $4, $4 FROM generate_series(1, 1002) g`, [A, I1, TA, SYS]);
    s.log.length = 0; await runTask(s);
    const left = await s.sql(A, "SELECT basis_key FROM inventory.consumption_facts WHERE tenant_id = $1 AND basis_key LIKE 'manual:t15-bulk-%' AND status = 'unresolved' ORDER BY occurred_at", [A]);
    expect(left.map((r: any) => r.basis_key)).toEqual(['manual:t15-bulk-1001', 'manual:t15-bulk-1002']);
    expect(await cnt(s, 'consumption_facts', "basis_key LIKE 'manual:t15-bulk-%' AND status = 'posted'")).toBe(1000);
    const q = enqueues(s); expect(q.length).toBeGreaterThanOrEqual(1);
    await s.sql(A, "UPDATE inventory.consumption_facts SET status = 'dismissed', reason_code = 'other' WHERE tenant_id = $1 AND status = 'unresolved' AND basis_key LIKE 'manual:t15-bulk-%'", [A]);
    s.log.length = 0; await runTask(s); expect(enqueues(s)).toEqual([]);
  }, 300_000);
});
