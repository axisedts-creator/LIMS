// C12.T-17 consumer contract: `instruments.result.received.v1` (reruns), `instruments.qc.received.v1`, `instruments.calibration.received.v1` -> inventory consumption facts
// (02-TRD §8.1 steps 1-8 + table rows, §8.2 centre -> branch store, §8.3, §8.4; PRD AC-13.1..13.3, AC-14.1..14.4, AC-21.7 counter part; 07-SECURITY D-EVT, P-T6, LT-1; 08 A17 D-74, CR-C12-006, R13).
// Real migrated DB as role lims_api (RLS on), REAL consumers.service / ledger from T-05 / T-15, no fakes except the JobContext. Harness: tests/db/c12-t17/run.sh (clone of c12-t16).
// Fixtures: tests/db/c12-t03/fixtures.sql + EXTRAS below (ids 18xxx, committed once with the superuser). Each test = one transaction that is ROLLED BACK; the race test COMMITS on its own rows.
// LEAD DECISIONS: none of LD-140 applies (backend only).
// SEAMS pinned here (spec fixes behaviour, not names; the writer may dispute through the reviewer):
//   * services/worker/src/jobs/inventory/consumers/instruments.{result,qc,calibration}.received.v1.ts export `onResultReceived`, `onQcReceived`, `onCalibrationReceived` (the TRD §9 names), each
//     `(event, ctx: JobContext)`, and the manifest `subscriptions[...]` is that very function (no longer the T-01 stub). `event` = C0 envelope (payload under `.payload`, `event_id`, `idempotency_key`).
//   * INBOX: the C0 wrapper core/consumer.ts `consumerRun` owns `inventory.event_inbox` (as in T-16). The handlers never touch it; "duplicate event" is proved through the REAL `consumerRun`.
//   * TENANT: a handler works for ctx.tenantId only (P-T6); an envelope of another tenant writes nothing in tenant A.
//   * COUNTERS: `instrument_qc_daily.qc_observations` +1 for EVERY non-duplicate QC event (mapped or not, switch on or off, before and after enable) keyed (business_date of received_at in the tenant tz, instrument_id).
//     `test_counts_daily.qc_events` / `rerun_events` only for a NEWLY inserted fact (never while the switch gate is closed): qc_events +1 per DISTINCT attributed test of the matched rules, none when no
//     rule matched; rerun_events +1 per newly inserted rerun fact whatever its status (same rule as tests_counted in T-16). Key (business_date, instrument_id, test_id). Calibration and result events
//     write NO counter. The result handler never touches verified_result_events / tests_counted.
//   * MISSING / malformed fields the handler uses (instrument_id, received_at, mapping_status of QC; instrument_message_id of a rerun; received_at) reject BEFORE any write (the job retries / dead-letters).
//   * METRIC `lims_inventory_events_skipped_total{reason}` is NOT asserted: JobContext has no metrics seam yet (T-18 note, CR-C12-018).
// Synthetic data only.
import '../../../../../../api/src/__tests__/setup-env.js';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const requireApi = createRequire(new URL('../../../../../../api/package.json', import.meta.url));
const pg = requireApi('pg') as typeof import('pg');
type PoolClient = import('pg').PoolClient;

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const E_RES = 'instruments.result.received.v1', E_QC = 'instruments.qc.received.v1', E_CAL = 'instruments.calibration.received.v1';
type Kind = 'res' | 'qc' | 'cal';
const EVENT: Record<Kind, string> = { res: E_RES, qc: E_QC, cal: E_CAL };
const FILE: Record<Kind, URL> = { res: new URL(`../${E_RES}.ts`, import.meta.url), qc: new URL(`../${E_QC}.ts`, import.meta.url), cal: new URL(`../${E_CAL}.ts`, import.meta.url) };
const FN: Record<Kind, string> = { res: 'onResultReceived', qc: 'onQcReceived', cal: 'onCalibrationReceived' };
const manifestUrl = new URL('../../index.ts', import.meta.url).href;
const load = (k: Kind) => import(/* @vite-ignore */ FILE[k].href) as Promise<Record<string, (e: unknown, c: unknown) => Promise<void>>>;

const A = '01a1a98a-ac40-7000-8000-00000000a001', B = '01a1a98a-ac40-7000-8000-00000000b001', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const BR1 = '01a1a98a-ac40-7000-8000-00000000a101', BR2 = '01a1a98a-ac40-7000-8000-00000000a102';
const CEN1 = '01a1a98a-ac40-7000-8000-00000000a201' /* branch BR1 */, CEN2 = '01a1a98a-ac40-7000-8000-00000000a202' /* branch BR2 */;
const uid = (n: number) => `0190c514-0000-7000-8000-${String(n).padStart(12, '0')}`;
const KT = 'Asia/Kathmandu';
const V1 = '2026-11-13T19:00:00.000Z';            // = 2026-11-14 00:45 in Asia/Kathmandu (+05:45): business date 2026-11-14, UTC date 2026-11-13
const V1_BD = '2026-11-14';
const RULES_FROM = '2026-01-01T00:00:00.000Z', ENABLED = '2026-06-01T00:00:00.000Z';
const MAIN_A = uid(1001);                          // fixtures.sql: MAIN-A, branch a101, default consumption store

// ---- fixtures (tenant A)
const TG = uid(18001), TQ2 = uid(18002), TQ3 = uid(18003), TQ4 = uid(18004), TR2 = uid(18005), TC2 = uid(18006), TN = uid(18007);
const AGLU = uid(18121), AOTH = uid(18122), ASTORE = uid(18123);                                  // opaque analyte ids (no FK on facts)
const IB1 = uid(18201), IB2 = uid(18202), IB3 = uid(18203), IB5 = uid(18205);
const SB = uid(18401), SD2 = uid(18402);
const IQ1 = uid(18501), IQ2 = uid(18502), IQN = uid(18503), IQ3 = uid(18504), IRR = uid(18505), ICAL = uid(18506), ICV = uid(18507);
const ruleId = (n: number) => uid(18700 + n);
const J = (o: unknown) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const I = (table: string, o: Record<string, unknown>) => `SELECT pg_temp.t17_ins('${table}', ${J(o)});`;
const tid = { tenant_id: A };
const store = (n: number, branch: string, code: string, kind: string, def: boolean) => I('inventory.stores', { id: uid(n), ...tid, branch_id: branch, store_code: code, name: `Store ${code}`, store_kind: kind, is_default_consumption: def, is_active: true });
const item = (n: number, code: string, cat: string, uom: string) => I('inventory.items', { id: uid(n), ...tid, item_code: code, name: `Item ${code}`, category: cat, base_uom_code: uom, is_lot_tracked: false, requires_expiry: false, is_active: true });
const bal = (n: number, s: string, i: string) => I('inventory.stock_balances', { id: uid(n), ...tid, store_id: s, item_id: i, lot_id: null, qty_base: 1000, value_paisa: 10000, last_movement_at: new Date().toISOString() });
const inst = (n: number, code: string, centre: string) => I('instruments.instruments', { id: uid(n), ...tid, centre_id: centre, agent_id: uid(n + 1000), instrument_code: code, display_name: `Instrument ${code}`, vendor: 'Synthetic', model: 'SX-1',
  protocol: 'astm', driver_code: 'astm_generic_e1394', transport: { kind: 'tcp_client' }, timezone: KT, state: 'draft' });
let ruleSeq = 0;
const rule = (kind: string, testId: string | null, itemId: string, qty: number, o: Record<string, unknown> = {}) => I('inventory.consumption_rules', { id: ruleId(++ruleSeq), ...tid, rule_kind: kind, test_id: testId, item_id: itemId, qty_base: qty, entered_qty: qty,
  effective_from: RULES_FROM, ...o });
const ITEMS = [IQ1, IQ2, IQN, IQ3, IRR, ICAL, ICV], STORES = [SB, MAIN_A, SD2];
const EXTRAS = `
BEGIN;
SET search_path = extensions, public, pg_catalog;
SET LOCAL session_replication_role = replica;
CREATE OR REPLACE FUNCTION pg_temp.t17_sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '${SYS}'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.t17_ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r jsonb := p_row; a text; cols text;
BEGIN
  IF r ? 'tenant_id' THEN PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', r->>'tenant_id', 'sub', pg_temp.t17_sys(), 'actor_type', 'system')::text, true); END IF;
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.t17_sys()); END IF;
  END LOOP;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb) ON CONFLICT DO NOTHING', p_tbl, cols, r::text);
END $f$;
SELECT set_config('request.jwt.claims', '{"tenant_id":"${A}","sub":"${SYS}","actor_type":"system"}', true);
${[TG, TQ2, TQ3, TQ4, TR2, TC2, TN].map((t) => I('catalog.tests', { id: t, ...tid, workflow_type: 'standard' })).join('\n')}
${inst(18201, 'T17-I1', CEN1)}
${inst(18202, 'T17-I2', CEN2)}
${inst(18203, 'T17-I3', CEN1)}
${inst(18205, 'T17-I5', CEN1)}
${store(18401, BR1, 'T17-SB', 'bench', false)}
${store(18402, BR2, 'T17-SD2', 'main', true)}
${item(18501, 'T17-CTRL', 'control', 'ml')}${item(18502, 'T17-Q2', 'consumable', 'piece')}${item(18503, 'T17-QN', 'consumable', 'piece')}${item(18504, 'T17-Q3', 'consumable', 'piece')}
${item(18505, 'T17-RR', 'consumable', 'piece')}${item(18506, 'T17-CAL', 'consumable', 'piece')}${item(18507, 'T17-CV', 'consumable', 'piece')}
${ITEMS.flatMap((it, i) => STORES.map((st, j) => bal(18800 + i * 10 + j, st, it))).join('')}
${I('inventory.instrument_bindings', { id: uid(18901), ...tid, instrument_id: IB1, store_id: SB, is_active: true })}
${rule('per_qc', TG, IQ1, 0.1, { instrument_id: IB1, analyte_id: AGLU })}
${rule('per_qc', TG, IQ2, 1, { instrument_id: IB1, analyte_id: AGLU })}
${rule('per_qc', TQ2, IQN, 1, { instrument_id: IB5 })}
${rule('per_qc', TQ3, IQ3, 1, { instrument_id: IB5 })}
${rule('per_qc', TG, IQ1, 0.1, { instrument_id: IB5, analyte_id: AGLU })}
${rule('per_rerun', TG, IRR, 1, { instrument_id: IB1 })}
${rule('per_rerun', TR2, IRR, 1)}
${rule('per_qc', TQ4, IQ2, 1, { analyte_id: ASTORE })}
${rule('per_calibration', TG, ICAL, 2, { instrument_id: IB1 })}
${rule('per_calibration', TC2, ICAL, 1)}
${rule('per_test', TG, ICV, 1, { instrument_id: IB1 })}
COMMIT;`;
const R = { qc1: 1, qc2: 2, null1: 3, null2: 4, qcG5: 5, rerun1: 6, rerunGen: 7, qcStore: 8, cal1: 9, calGen: 10 };

let api: InstanceType<typeof pg.Pool>;
let admin: InstanceType<typeof pg.Pool>;
beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 8 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c12-t03/fixtures.sql', import.meta.url)), 'utf8'));
  await admin.query(EXTRAS);
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-17 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => { if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true); });
});

// ---------------------------------------------------------------------------------------------------------- session + job context (as T-16)
const claims = (t: string) => JSON.stringify({ tenant_id: t, sub: SYS, actor_type: 'system' });
interface Sess { client: PoolClient; log: string[]; logs: string[]; sql(text: string, v?: unknown[]): Promise<any[]>; ctx(tenant?: string): Promise<any>; }
function sessionOn(client: PoolClient): Sess {
  const log: string[] = [], logs: string[] = [];
  const tx = { query: (t: string, v?: unknown[]) => { log.push(t); return client.query(t, v); } };
  let sp = 0;
  const s: Sess = {
    client, log, logs,
    async sql(text, v) { await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]); return (await client.query(text, v)).rows; },
    async ctx(tenant = A) {
      const { createCoreRepo } = await import('../../../../../../api/src/core/core-repo/index.js');
      const keep = (...a: unknown[]) => { logs.push(JSON.stringify(a)); };
      const c: any = { tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: 'r-t17', tx, now: () => new Date().toISOString(), attempt: 1, maxAttempts: 10, jobId: 'job-t17', isNewer: () => true,
        core: createCoreRepo({ withTenantScope: async (_t: unknown, _tenant: unknown, _actor: unknown, fn: () => unknown) => fn(), systemActorOf: () => SYS } as any),
        ports: { IdentityPort: { async getTenantSettings() { return { timezone: KT }; } } }, events: {}, storage: {}, files: {}, audit: {},
        metrics: { inc() {}, set() {}, observe() {} }, log: { info: keep, warn: keep, error: keep, debug: keep, child() { return this; } } };
      c.db = { async tx(fn: (x: unknown) => Promise<unknown>) { const name = `t17_sp_${++sp}`; await tx.query(`SAVEPOINT ${name}`); try { const r = await fn(c); await tx.query(`RELEASE SAVEPOINT ${name}`); return r; } catch (e) { await tx.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; } } };
      return c;
    },
  };
  return s;
}
async function session<T>(fn: (s: Sess) => Promise<T>): Promise<T> {
  const client = await api.connect();
  try { await client.query('BEGIN'); await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]); return await fn(sessionOn(client)); } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}
const run = (name: string, fn: (s: Sess) => Promise<void>, timeout?: number) => it(name, () => session(fn), timeout);

// ---------------------------------------------------------------------------------------------------------- events
let seq = 100;
const msgId = () => uid(30000 + ++seq);
const qcPayload = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ instrument_message_id: msgId(), instrument_id: IB1, centre_id: CEN1, control_id_raw: 'SYN-CTRL-1', control_lot_raw: 'SYN-LOT-1', control_level: 'L1',
  instrument_analyte_code: 'GLU', mapping_status: 'mapped', analyte_id: AGLU, value_raw: '5.1', value_numeric: '5.1', unit_raw: 'mmol/L', received_at: V1, ...o });
const resPayload = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ instrument_message_id: msgId(), instrument_id: IB1, agent_id: uid(18301), centre_id: CEN1, protocol: 'astm', sample_barcode: 'SYN-BC-1', record_kind: 'quantitative',
  instrument_analyte_code: 'GLU', mapping_status: 'mapped', analyte_id: AGLU, test_id: TG, value_raw: '5.1', received_at: V1, is_rerun: true, ...o });
const calPayload = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ instrument_message_id: msgId(), instrument_id: IB1, centre_id: CEN1, instrument_analyte_code: 'GLU', mapping_status: 'mapped', analyte_id: AGLU, test_id: TG,
  calibrator_id_raw: 'SYN-CAL-1', calibrator_lot_raw: 'SYN-CALLOT-1', received_at: V1, ...o });
const envelope = (k: Kind, p: Record<string, unknown>, o: Record<string, unknown> = {}) => ({
  event_id: uid(31000 + ++seq), event_type: EVENT[k], tenant_id: A, occurred_at: String(p['received_at'] ?? V1), actor: { type: 'system', id: SYS }, idempotency_key: `${p['instrument_message_id']}:${k}:${seq}`,
  producer: 'instruments', aggregate: { type: 'instrument_message', id: p['instrument_message_id'], seq: 1 }, request_id: uid(32000 + seq), payload: p, ...o });
const deliver = async (k: Kind, s: Sess, e: unknown, tenant = A) => (await load(k))[FN[k]]!(e, await s.ctx(tenant));
const qc = (s: Sess, o: Record<string, unknown> = {}, eo: Record<string, unknown> = {}) => { const e = envelope('qc', qcPayload(o), eo); return deliver('qc', s, e).then(() => e); };
const rerun = (s: Sess, o: Record<string, unknown> = {}, eo: Record<string, unknown> = {}) => { const e = envelope('res', resPayload(o), eo); return deliver('res', s, e).then(() => e); };
const cal = (s: Sess, o: Record<string, unknown> = {}, eo: Record<string, unknown> = {}) => { const e = envelope('cal', calPayload(o), eo); return deliver('cal', s, e).then(() => e); };
const sha = (key: string) => createHash('sha256').update(key).digest('hex');

// ---------------------------------------------------------------------------------------------------------- db helpers
const n = (v: unknown) => Number(v);
const enable = (s: Sess, at: string | null) => s.sql('UPDATE inventory.settings SET consumption_enabled_at = $2 WHERE tenant_id = $1', [A, at]);
const factsLike = (s: Sess, like: string) => s.sql('SELECT *, business_date::text AS bd FROM inventory.consumption_facts WHERE tenant_id = $1 AND basis_key LIKE $2 ORDER BY basis_key', [A, like]);
const factOf = async (s: Sess, basis: string) => (await factsLike(s, basis))[0];
const movesOf = (s: Sess, factId: string) => s.sql(`SELECT movement_kind AS kind, store_id, item_id, qty_base::text AS q, instrument_id, attributed_test_id, rule_id, business_date::text AS bd, occurred_at, doc_type, doc_id
  FROM inventory.stock_movements WHERE tenant_id = $1 AND doc_type = 'consumption_fact' AND doc_id = $2 ORDER BY qty_base, rule_id`, [A, factId]);
const balance = async (s: Sess, st: string, itemId: string) => { const r = (await s.sql('SELECT qty_base::text AS q FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id IS NULL', [A, st, itemId]))[0]; return r ? n(r.q) : 0; };
const counts = async (s: Sess, test: string, instrument: string | null, bd = V1_BD) => (await s.sql(`SELECT tests_counted, verified_result_events, rerun_events, qc_events FROM inventory.test_counts_daily WHERE tenant_id = $1 AND business_date = $2
  AND test_id = $3 AND instrument_id IS NOT DISTINCT FROM $4::uuid`, [A, bd, test, instrument]))[0];
const qcObs = async (s: Sess, instrument: string, bd = V1_BD) => { const r = (await s.sql('SELECT qc_observations FROM inventory.instrument_qc_daily WHERE tenant_id = $1 AND business_date = $2 AND instrument_id = $3', [A, bd, instrument]))[0]; return r ? n(r.qc_observations) : 0; };
const count = async (s: Sess, table: string, where = 'true', v: unknown[] = []) => n((await s.sql(`SELECT count(*) AS n FROM inventory.${table} WHERE tenant_id = $1 AND ${where}`, [A, ...v]))[0].n);
const snapshot = async (s: Sess) => JSON.stringify([await count(s, 'consumption_facts'), await count(s, 'stock_movements'), await count(s, 'test_counts_daily'), await count(s, 'instrument_qc_daily'), await count(s, 'alerts'),
  await s.sql('SELECT id, qty_base, value_paisa, version FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [A]), await s.sql('SELECT test_id, tests_counted, verified_result_events, rerun_events, qc_events FROM inventory.test_counts_daily WHERE tenant_id = $1 ORDER BY id', [A]),
  await s.sql('SELECT instrument_id, business_date, qc_observations FROM inventory.instrument_qc_daily WHERE tenant_id = $1 ORDER BY 1, 2', [A])]);
const rejected = async (k: Kind, p: Promise<unknown>) => { p.catch(() => undefined); await load(k); /* a missing module must FAIL the test, not count as a rejection */ try { await p; } catch (e) { return e as any; } return undefined; };
const KINDS: Kind[] = ['res', 'qc', 'cal'];

// ========================================================================================================== wiring + data minimisation (no DB needed)
describe('T-17 wiring and data minimisation', () => {
  it.each(KINDS)('%s: the consumer file exports its handler and the manifest subscribes THAT function (not the T-01 stub)', async (k) => {
    const mod = await load(k); const manifest = ((await import(/* @vite-ignore */ manifestUrl)) as any).manifest;
    expect(typeof mod[FN[k]]).toBe('function'); expect(manifest.subscriptions[EVENT[k]]).toBe(mod[FN[k]]);
  });
  it.each(KINDS)('%s D-EVT: the source never names P2/P3 fields or the calibrator fields, never touches event_inbox (the C0 wrapper owns it) and reads only the fields of TRD §8.1', (k) => {
    const src = readFileSync(FILE[k], 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    for (const f of ['sample_barcode', 'value_raw', 'value_numeric', 'unit_raw', 'unit_code', 'instrument_flags', 'control_id_raw', 'control_lot_raw', 'control_level', 'calibrator_id_raw', 'calibrator_lot_raw', 'instrument_analyte_code', 'event_inbox']) expect(src, f).not.toContain(f);
    for (const f of ['instrument_message_id', 'instrument_id', 'centre_id', 'mapping_status', 'received_at']) expect(src, f).toContain(f);
    if (k === 'res') for (const f of ['is_rerun', 'test_id']) expect(src, f).toContain(f);
    if (k === 'qc') for (const f of ['analyte_id', 'qc_observations', 'sha256']) expect(src, f).toContain(f);
    if (k === 'cal') for (const f of ['test_id', 'sha256']) expect(src, f).toContain(f);
  });
});

// ========================================================================================================== AC-13.1 / 13.2 / 13.3 reruns
describe.skipIf(!live)('T-17 AC-13.1 rerun -> consume_rerun', () => {
  run('rule (per_rerun, GLU, I1, item, 1), switch on, is_rerun + mapped + test_id: ONE consume_rerun of -1 attributed to the test, store = binding of I1; fact carries centre; rerun_events +1; verified/tests counters untouched', async (s) => {
    await enable(s, ENABLED); const before = await balance(s, SB, IRR); const p = resPayload(); const e = envelope('res', p); await deliver('res', s, e);
    const f = await factOf(s, `rerun:${p['instrument_message_id']}:${TG}`); expect(await factsLike(s, `%${p['instrument_message_id']}%`)).toHaveLength(1);
    expect(f).toMatchObject({ fact_kind: 'rerun', source: 'event', source_event_id: e.event_id, source_event_type: E_RES, instrument_id: IB1, test_id: TG, centre_id: CEN1, status: 'posted', store_id: SB, rules_applied: 1, multiplier: 1, bd: V1_BD });
    expect(new Date(f.occurred_at).toISOString()).toBe(V1);
    const ms = await movesOf(s, f.id); expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: 'consume_rerun', store_id: SB, item_id: IRR, instrument_id: IB1, attributed_test_id: TG, rule_id: ruleId(R.rerun1), bd: V1_BD, doc_type: 'consumption_fact', doc_id: f.id }); expect(n(ms[0].q)).toBe(-1);
    expect(await balance(s, SB, IRR)).toBe(before - 1);
    expect(await counts(s, TG, IB1)).toMatchObject({ rerun_events: 1, tests_counted: 0, verified_result_events: 0, qc_events: 0 });
    expect(await qcObs(s, IB1)).toBe(0);
  });
  run('one movement per (instrument message, test): the same message for ANOTHER test is a second fact; the same (message, test) delivered again as a new event writes nothing more', async (s) => {
    await enable(s, ENABLED); const mid = msgId(); const p1 = resPayload({ instrument_message_id: mid }), p2 = resPayload({ instrument_message_id: mid, test_id: TR2, instrument_id: IB3 });
    await deliver('res', s, envelope('res', p1)); await deliver('res', s, envelope('res', p2)); await deliver('res', s, envelope('res', p1)); await deliver('res', s, envelope('res', { ...p1 }));
    const fs = await factsLike(s, `rerun:${mid}:%`); expect(fs.map((f: any) => f.basis_key).sort()).toEqual([`rerun:${mid}:${TG}`, `rerun:${mid}:${TR2}`].sort());
    for (const f of fs) expect(await movesOf(s, f.id)).toHaveLength(1);
    expect(await counts(s, TG, IB1)).toMatchObject({ rerun_events: 1 });
  });
  run('no rule for the test: the rerun fact is recorded as no_rule (no store, no movement, no alert); rerun_events still +1 (pinned: same rule as tests_counted)', async (s) => {
    await enable(s, ENABLED); const p = resPayload({ test_id: TN }); await deliver('res', s, envelope('res', p));
    const f = await factOf(s, `rerun:${p['instrument_message_id']}:${TN}`); expect(f).toMatchObject({ status: 'no_rule', store_id: null, rules_applied: 0 }); expect(await movesOf(s, f.id)).toEqual([]);
    expect(await count(s, 'alerts', "alert_kind = 'unresolved_consumption'")).toBe(0); expect(await counts(s, TN, IB1)).toMatchObject({ rerun_events: 1 });
  });
  run('out of order: a rerun that arrives BEFORE the verified event creates its own fact; the later lab.result.verified.v1 of the same test creates its own (no dependency, both deduct)', async (s) => {
    await enable(s, ENABLED); const p = resPayload(); await deliver('res', s, envelope('res', p));
    const { onResultVerified } = (await import(/* @vite-ignore */ new URL('../lab.result.verified.v1.ts', import.meta.url).href)) as any; const oi = uid(33001), rid = uid(33002);
    const vp = { result_id: rid, result_version_no: 1, order_id: uid(33003), order_item_id: oi, specimen_id: uid(33004), test_id: TG, analyte_id: AGLU, department_id: uid(17601), instrument_id: IB1, origin: 'instrument', mode: 'manual', verified_at: V1, verified_by_membership_id: uid(33005), processing_branch_id: BR1 };
    await onResultVerified({ event_id: uid(33006), event_type: 'lab.result.verified.v1', tenant_id: A, occurred_at: V1, actor: { type: 'system', id: SYS }, idempotency_key: `${rid}:verified:1`, producer: 'lab', aggregate: { type: 'result', id: rid, seq: 1 }, request_id: uid(33007), payload: vp }, await s.ctx());
    const r = await factOf(s, `rerun:${p['instrument_message_id']}:${TG}`), t = await factOf(s, `test:${oi}:${TG}`);
    expect(r).toMatchObject({ status: 'posted' }); expect(t).toMatchObject({ status: 'posted' }); expect((await movesOf(s, r.id))[0]).toMatchObject({ kind: 'consume_rerun' }); expect((await movesOf(s, t.id))[0]).toMatchObject({ kind: 'consume_test' });
    expect(await counts(s, TG, IB1)).toMatchObject({ rerun_events: 1, tests_counted: 1, verified_result_events: 1 });
  });
});

describe.skipIf(!live)('T-17 AC-13.2 filters: nothing is written (no fact, no movement, no counter, no alert)', () => {
  const cases: [string, (p: Record<string, unknown>) => Record<string, unknown>][] = [
    ['is_rerun false (reason not_rerun)', (p) => ({ ...p, is_rerun: false })],
    ['is_rerun absent (driver does not report reruns; AC-13.3, reason not_rerun)', (p) => { const { is_rerun: _r, ...q } = p; return q; }],
    ['mapping_status unmapped (reason unmapped)', (p) => { const { test_id: _t, analyte_id: _a, ...q } = p; return { ...q, mapping_status: 'unmapped' }; }],
    ['mapped but unmapped carries a test_id anyway: still skipped (unmapped wins)', (p) => ({ ...p, mapping_status: 'unmapped' })],
    ['no test_id (reason no_test)', (p) => { const { test_id: _t, ...q } = p; return q; }],
  ];
  it.each(cases)('%s', (_name, f) => session(async (s) => {
    await enable(s, ENABLED); const before = await snapshot(s); await deliver('res', s, envelope('res', f(resPayload())));
    expect(await snapshot(s)).toBe(before);
  }));
  run('switch gate: consumption_enabled_at NULL, or received_at before it: nothing written; at the enable instant: processed (the instant is exact)', async (s) => {
    await enable(s, null); const before = await snapshot(s); await rerun(s); expect(await snapshot(s)).toBe(before);
    await enable(s, V1); await rerun(s, { received_at: '2026-11-13T18:59:59.999Z' }); expect(await snapshot(s)).toBe(before);
    const p = resPayload({ received_at: V1 }); await deliver('res', s, envelope('res', p)); expect(await factOf(s, `rerun:${p['instrument_message_id']}:${TG}`)).toMatchObject({ status: 'posted' });
  });
  run('a skipped event never reads or stores P2/P3 data: sample_barcode / value_raw / unknown fields are tolerated, never stored, never logged (LT-1)', async (s) => {
    await enable(s, ENABLED); const p = resPayload({ sample_barcode: 'SYN-BARCODE-9917', value_raw: '5.5 SYN-RAW', unit_raw: 'mmol/L', instrument_flags: ['SYN-FLAG'], unknown_future_field: { x: 1 } });
    await deliver('res', s, envelope('res', p)); const rows = await s.sql('SELECT row_to_json(f)::text AS j FROM inventory.consumption_facts f WHERE tenant_id = $1 AND basis_key LIKE $2', [A, `%${p['instrument_message_id']}%`]);
    expect(rows).toHaveLength(1); for (const x of ['SYN-BARCODE-9917', 'SYN-RAW', 'SYN-FLAG', 'mmol']) { expect(rows[0].j).not.toContain(x); expect(s.logs.join('\n')).not.toContain(x); }
  });
});

// ========================================================================================================== AC-14.x QC
describe.skipIf(!live)('T-17 AC-14.1 QC -> consume_qc per matched rule, attributed to the rule test', () => {
  run('two per_qc rules (I1, GLU-A, test GLU: control 0.1 ml, reagent 1): TWO consume_qc movements, both attributed to GLU; ONE fact qc:<sha256(idempotency_key)>; qc_events +1 (distinct test), qc_observations +1', async (s) => {
    await enable(s, ENABLED); const c0 = await balance(s, SB, IQ1), r0 = await balance(s, SB, IQ2); const p = qcPayload(); const e = envelope('qc', p); await deliver('qc', s, e);
    const fs = await factsLike(s, `%${p['instrument_message_id']}%`); expect(fs).toHaveLength(0); const f = await factOf(s, `qc:${sha(e.idempotency_key)}`);
    expect(f).toMatchObject({ fact_kind: 'qc', source: 'event', source_event_id: e.event_id, source_event_type: E_QC, instrument_id: IB1, analyte_id: AGLU, test_id: TG, centre_id: CEN1, status: 'posted', store_id: SB, rules_applied: 2, bd: V1_BD });
    const ms = await movesOf(s, f.id); expect(ms).toHaveLength(2); for (const m of ms) expect(m).toMatchObject({ kind: 'consume_qc', attributed_test_id: TG, instrument_id: IB1, store_id: SB, bd: V1_BD });
    expect(ms.map((m: any) => [m.item_id, n(m.q)]).sort()).toEqual([[IQ1, -0.1], [IQ2, -1]].sort());
    expect(ms.map((m: any) => m.rule_id).sort()).toEqual([ruleId(R.qc1), ruleId(R.qc2)].sort());
    expect(await balance(s, SB, IQ1)).toBeCloseTo(c0 - 0.1, 6); expect(await balance(s, SB, IQ2)).toBe(r0 - 1);
    expect(await counts(s, TG, IB1)).toMatchObject({ qc_events: 1, tests_counted: 0, verified_result_events: 0, rerun_events: 0 }); expect(await qcObs(s, IB1)).toBe(1);
  });
  run('basis key is qc:<sha256 hex of the ENVELOPE idempotency_key> (not of the event id or the message id)', async (s) => {
    await enable(s, ENABLED); const e = await qc(s, {}, { idempotency_key: 'SYN-IDEM-QC-0001' });
    expect(await factsLike(s, `qc:${sha('SYN-IDEM-QC-0001')}`)).toHaveLength(1); expect(await factsLike(s, `qc:${sha(String(e.event_id))}`)).toHaveLength(0);
  });
  run('no rule matches (analyte without a per_qc rule on I1): fact qc/no_rule (no store, no movement, no alert), qc_events NOT written (D-74), qc_observations +1', async (s) => {
    await enable(s, ENABLED); const e = await qc(s, { analyte_id: AOTH }); const f = await factOf(s, `qc:${sha(e.idempotency_key)}`);
    expect(f).toMatchObject({ status: 'no_rule', store_id: null, rules_applied: 0 }); expect(await movesOf(s, f.id)).toEqual([]); expect(await count(s, 'alerts', "alert_kind = 'unresolved_consumption'")).toBe(0);
    expect(await counts(s, TG, IB1)).toBeUndefined(); expect(await count(s, 'test_counts_daily', 'qc_events > 0')).toBe(0); expect(await qcObs(s, IB1)).toBe(1);
  });
  run('extra fields (value_raw, control_id_raw, unit_raw, flags, unknown) are tolerated, never stored and never logged (LT-1)', async (s) => {
    await enable(s, ENABLED); await qc(s, { value_raw: 'SYN-RAW-77', control_id_raw: 'SYN-CTRL-55', control_lot_raw: 'SYN-CLOT-9', unit_raw: 'mmol/L', instrument_flags: ['SYN-FLAG'], unknown_future_field: { x: 1 } });
    const rows = await s.sql("SELECT row_to_json(f)::text AS j FROM inventory.consumption_facts f WHERE tenant_id = $1 AND fact_kind = 'qc' AND instrument_id = $2", [A, IB1]);
    expect(rows).toHaveLength(1); for (const x of ['SYN-RAW-77', 'SYN-CTRL-55', 'SYN-CLOT-9', 'mmol', 'SYN-FLAG']) { expect(rows[0].j).not.toContain(x); expect(s.logs.join('\n')).not.toContain(x); }
  });
});

describe.skipIf(!live)('T-17 AC-14.2 analyte-null QC rules apply to every mapped QC observation of the instrument', () => {
  run('I5 has analyte-null rules (test TQ2 item QN, test TQ3 item Q3) and a GLU-A rule: an observation of ANOTHER analyte gets exactly the two null-analyte movements; GLU-A gets all three; qc_events +1 per DISTINCT attributed test', async (s) => {
    await enable(s, ENABLED); const eo = await qc(s, { instrument_id: IB5, analyte_id: AOTH }); const fo = await factOf(s, `qc:${sha(eo.idempotency_key)}`);
    expect(fo).toMatchObject({ status: 'posted', rules_applied: 2 }); const mo = await movesOf(s, fo.id); expect(mo).toHaveLength(2); expect(mo.map((m: any) => m.attributed_test_id).sort()).toEqual([TQ2, TQ3].sort()); for (const m of mo) expect(m.kind).toBe('consume_qc');
    expect(await counts(s, TQ2, IB5)).toMatchObject({ qc_events: 1 }); expect(await counts(s, TQ3, IB5)).toMatchObject({ qc_events: 1 }); expect(await counts(s, TG, IB5)).toBeUndefined();
    const eg = await qc(s, { instrument_id: IB5, analyte_id: AGLU }); const fg = await factOf(s, `qc:${sha(eg.idempotency_key)}`); expect(fg).toMatchObject({ status: 'posted', rules_applied: 3 }); expect(await movesOf(s, fg.id)).toHaveLength(3);
    expect(await counts(s, TG, IB5)).toMatchObject({ qc_events: 1 }); expect(await counts(s, TQ2, IB5)).toMatchObject({ qc_events: 2 }); expect(await counts(s, TQ3, IB5)).toMatchObject({ qc_events: 2 });
    expect(await qcObs(s, IB5)).toBe(2);
  });
  run('the null-analyte rules of I5 never leak to another instrument (I1, analyte OTHER: no_rule)', async (s) => {
    await enable(s, ENABLED); const e = await qc(s, { instrument_id: IB1, analyte_id: AOTH }); expect(await factOf(s, `qc:${sha(e.idempotency_key)}`)).toMatchObject({ status: 'no_rule' });
  });
});

describe.skipIf(!live)('T-17 AC-14.3 / D-74 unmapped QC: counted, never deducted', () => {
  it.each([['unmapped', { mapping_status: 'unmapped', analyte_id: undefined }], ['mapped but no analyte_id', { analyte_id: undefined }]] as [string, Record<string, unknown>][])(
    '%s: qc_observations +1 (before the mapping filter), no fact, no movement, no qc_events, no alert', (_n, o) => session(async (s) => {
      await enable(s, ENABLED); const p = qcPayload(o); for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
      const b = await snapshot(s); await deliver('qc', s, envelope('qc', p)); expect(await qcObs(s, IB1)).toBe(1);
      expect(await count(s, 'consumption_facts', "fact_kind = 'qc' AND instrument_id = $2", [IB1])).toBe(0); expect(await count(s, 'stock_movements', 'instrument_id = $2 AND occurred_at = $3::timestamptz', [IB1, V1])).toBe(0);
      expect(await count(s, 'test_counts_daily', 'qc_events > 0')).toBe(0); expect(await count(s, 'alerts', "alert_kind = 'unresolved_consumption'")).toBe(0); expect(await snapshot(s)).not.toBe(b);
    }));
});

describe.skipIf(!live)('T-17 AC-14.4 duplicate QC event deducts nothing', () => {
  run('the same idempotency_key delivered again under a NEW event id: one fact, one set of movements, qc_events counted once', async (s) => {
    await enable(s, ENABLED); const p = qcPayload(); const e1 = envelope('qc', p, { idempotency_key: 'SYN-IDEM-QC-DUP' }), e2 = envelope('qc', p, { idempotency_key: 'SYN-IDEM-QC-DUP' });
    const c0 = await balance(s, SB, IQ2); await deliver('qc', s, e1); await deliver('qc', s, e2);
    const fs = await factsLike(s, `qc:${sha('SYN-IDEM-QC-DUP')}`); expect(fs).toHaveLength(1); expect(await movesOf(s, fs[0].id)).toHaveLength(2); expect(await balance(s, SB, IQ2)).toBe(c0 - 1);
    expect(await counts(s, TG, IB1)).toMatchObject({ qc_events: 1 });
  });
  describe('through the REAL C0 wrapper core/consumer.ts consumerRun (inbox + core.event_log + envelope schema validation), all three consumers', () => {
    async function consume(k: Kind, e: any) {
      const { consumerRun } = await import('../../../../core/consumer.js'); const { createCoreRepo } = await import('../../../../../../api/src/core/core-repo/index.js');
      const deps: any = { db: { async tx(_i: unknown, fn: (t: unknown) => Promise<unknown>) {
          const c = await api.connect();
          try { await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]); const r = await fn({ query: (t: string, v?: unknown[]) => c.query(t, v) }); await c.query('COMMIT'); return r; }
          catch (x) { await c.query('ROLLBACK').catch(() => undefined); throw x; } finally { c.release(); } } },
        systemActorOf: () => SYS, coreActorId: SYS, withTenantScope: async (_t: unknown, _x: unknown, _y: unknown, fn: () => unknown) => fn(), metrics: { inc() {}, set() {}, observe() {} },
        log: { child() { return this; }, info() {}, warn() {}, error() {} }, now: () => new Date(), events: {}, storage: {}, files: {}, audit: {},
        core: createCoreRepo({ withTenantScope: async (_t: unknown, _x: unknown, _y: unknown, fn: () => unknown) => fn(), systemActorOf: () => SYS } as any) };
      const mod = await load(k);
      return consumerRun(deps, { module: 'inventory', identifier: `evt.inventory.${EVENT[k]}`, kind: 'consumer', scope: 'per_tenant', maxAttempts: 10 }, EVENT[k], mod[FN[k]] as any)({ tenant_id: A, event_id: e.event_id }, { id: '1', attempts: 1, max_attempts: 10 } as any);
    }
    const seedLog = (k: Kind, e: any) => admin.query(`INSERT INTO core.event_log (tenant_id, event_id, event_type, producer, idempotency_key, aggregate_type, aggregate_id, aggregate_seq, occurred_at, envelope, created_by)
      VALUES ($1, $2, $3, 'instruments', $4, 'instrument_message', $5, 1, $6, $7::jsonb, $8)`, [A, e.event_id, EVENT[k], e.idempotency_key, e.payload.instrument_message_id, e.occurred_at, JSON.stringify(e), SYS]);
    const one = async (sql: string, v: unknown[]) => n((await admin.query(sql, v)).rows[0].n);
    const mk: Record<Kind, (at: string) => any> = {
      qc: (at) => envelope('qc', qcPayload({ received_at: at })), res: (at) => envelope('res', resPayload({ received_at: at })), cal: (at) => envelope('cal', calPayload({ received_at: at })) };
    it.each([['qc', '2026-11-12T10:00:00.000Z', 'qc'], ['res', '2026-11-12T11:00:00.000Z', 'rerun'], ['cal', '2026-11-12T12:00:00.000Z', 'calibration']] as [Kind, string, string][])(
      '%s: the same event delivered twice, and twice at once: ONE fact, its movements once, ONE inbox row (and, for QC, qc_observations +1 once)', async (k, at, factKind) => {
        await admin.query('UPDATE inventory.settings SET consumption_enabled_at = $2 WHERE tenant_id = $1', [A, ENABLED]); const e = mk[k](at); await seedLog(k, e); const bd = '2026-11-12';
        const o0 = await one('SELECT coalesce(max(qc_observations), 0) AS n FROM inventory.instrument_qc_daily WHERE tenant_id = $1 AND business_date = $2 AND instrument_id = $3', [A, bd, IB1]);
        await Promise.all([consume(k, e), consume(k, e)]); await consume(k, e);
        expect(await one('SELECT count(*) AS n FROM inventory.consumption_facts WHERE tenant_id = $1 AND source_event_id = $2 AND fact_kind = $3', [A, e.event_id, factKind])).toBe(1);
        expect(await one('SELECT count(*) AS n FROM inventory.stock_movements m JOIN inventory.consumption_facts f ON f.id = m.doc_id WHERE m.tenant_id = $1 AND f.source_event_id = $2', [A, e.event_id])).toBe(k === 'qc' ? 2 : 1);
        expect(await one('SELECT count(*) AS n FROM inventory.event_inbox WHERE tenant_id = $1 AND event_id = $2', [A, e.event_id])).toBe(1);
        if (k === 'qc') expect(await one('SELECT qc_observations AS n FROM inventory.instrument_qc_daily WHERE tenant_id = $1 AND business_date = $2 AND instrument_id = $3', [A, bd, IB1])).toBe(o0 + 1);
      });
    it('an envelope that violates its schema (mapping_status outside the enum) is rejected and the inbox row rolls back with it (the retry re-processes)', async () => {
      const bad = envelope('qc', qcPayload({ mapping_status: 'bogus' })); await seedLog('qc', bad); expect(await rejected('qc', consume('qc', bad))).toBeDefined();
      expect(await one('SELECT count(*) AS n FROM inventory.event_inbox WHERE tenant_id = $1 AND event_id = $2', [A, bad.event_id])).toBe(0);
    });
  });
});

// ========================================================================================================== AC-21.7 counter part (D-74) + switch
describe.skipIf(!live)('T-17 AC-21.7 / D-74 instrument_qc_daily.qc_observations: every non-duplicate QC event, before the mapping filter and the switch gate', () => {
  run('consumption_enabled_at NULL: qc_observations counts mapped AND unmapped events; no fact, no movement, no qc_events, no tests counters', async (s) => {
    await enable(s, null); await qc(s); await qc(s, { mapping_status: 'unmapped', analyte_id: undefined }); await qc(s, { analyte_id: AOTH });
    expect(await qcObs(s, IB1)).toBe(3); expect(await count(s, 'consumption_facts', "fact_kind = 'qc' AND instrument_id = $2", [IB1])).toBe(0); expect(await count(s, 'stock_movements', 'instrument_id = $2 AND occurred_at = $3::timestamptz', [IB1, V1])).toBe(0);
    expect(await count(s, 'test_counts_daily', 'qc_events > 0')).toBe(0); expect(await count(s, 'alerts', "alert_kind = 'unresolved_consumption'")).toBe(0);
  });
  run('received_at before the enable instant: counted only; at the enable instant: processed; the counter is not back-filled when the switch is turned on later', async (s) => {
    await enable(s, V1); const early = await qc(s, { received_at: '2026-11-13T18:59:59.999Z' }); expect(await factsLike(s, `qc:${sha(early.idempotency_key)}`)).toEqual([]); expect(await qcObs(s, IB1)).toBe(1);
    const at = await qc(s, { received_at: V1 }); expect(await factOf(s, `qc:${sha(at.idempotency_key)}`)).toMatchObject({ status: 'posted' }); expect(await qcObs(s, IB1)).toBe(2); expect(await counts(s, TG, IB1)).toMatchObject({ qc_events: 1 });
  });
  run('business date = received_at in the TENANT timezone (UTC 18:14:59 -> 11-13, 18:15:00 -> 11-14); one counter row per (date, instrument); other instruments do not share a row', async (s) => {
    await enable(s, null); await qc(s, { received_at: '2026-11-13T18:14:59.000Z' }); await qc(s, { received_at: '2026-11-13T18:15:00.000Z' }); await qc(s, { received_at: V1 }); await qc(s, { instrument_id: IB3, centre_id: CEN1 });
    expect(await qcObs(s, IB1, '2026-11-13')).toBe(1); expect(await qcObs(s, IB1, '2026-11-14')).toBe(2); expect(await qcObs(s, IB3, '2026-11-14')).toBe(1); expect(await count(s, 'instrument_qc_daily', 'instrument_id = $2', [IB1])).toBe(2);
  });
  run('the counter row is created on first use and the facts are written with the event business date (same date as the counter)', async (s) => {
    await enable(s, ENABLED); expect(await count(s, 'instrument_qc_daily', 'instrument_id = $2', [IB1])).toBe(0); const e = await qc(s); expect(await count(s, 'instrument_qc_daily', 'instrument_id = $2', [IB1])).toBe(1);
    expect((await factOf(s, `qc:${sha(e.idempotency_key)}`)).bd).toBe(V1_BD);
  });
  run('QC events never touch the result-side counters: tests_counted / verified_result_events / rerun_events stay 0 for the attributed test', async (s) => {
    await enable(s, ENABLED); await qc(s); expect(await counts(s, TG, IB1)).toMatchObject({ tests_counted: 0, verified_result_events: 0, rerun_events: 0, qc_events: 1 });
  });
});

// ========================================================================================================== calibration (CR-C12-006, R13)
describe.skipIf(!live)('T-17 calibration -> per_calibration facts', () => {
  run('rule (per_calibration, I1, GLU, item, 2): ONE consume_calibration of -2, fact cal:<sha256(idempotency_key)> kind calibration with instrument, test, centre; store = binding of I1; no counter is written', async (s) => {
    await enable(s, ENABLED); const before = await balance(s, SB, ICAL); const p = calPayload(); const e = envelope('cal', p); await deliver('cal', s, e); const f = await factOf(s, `cal:${sha(e.idempotency_key)}`);
    expect(f).toMatchObject({ fact_kind: 'calibration', source: 'event', source_event_id: e.event_id, source_event_type: E_CAL, instrument_id: IB1, test_id: TG, centre_id: CEN1, status: 'posted', store_id: SB, rules_applied: 1, bd: V1_BD });
    const ms = await movesOf(s, f.id); expect(ms).toHaveLength(1); expect(ms[0]).toMatchObject({ kind: 'consume_calibration', store_id: SB, item_id: ICAL, instrument_id: IB1, attributed_test_id: TG, rule_id: ruleId(R.cal1), bd: V1_BD }); expect(n(ms[0].q)).toBe(-2);
    expect(await balance(s, SB, ICAL)).toBe(before - 2); expect(await count(s, 'test_counts_daily', 'test_id = $2', [TG])).toBe(0); expect(await qcObs(s, IB1)).toBe(0);
  });
  it.each([
    ['unmapped', (p: Record<string, unknown>) => { const { test_id: _t, analyte_id: _a, ...q } = p; return { ...q, mapping_status: 'unmapped' }; }],
    ['unmapped although a test_id is carried', (p: Record<string, unknown>) => ({ ...p, mapping_status: 'unmapped' })],
    ['mapped but no test_id', (p: Record<string, unknown>) => { const { test_id: _t, ...q } = p; return q; }],
  ] as [string, (p: Record<string, unknown>) => Record<string, unknown>][])('%s: filtered, nothing is written', (_n, f) => session(async (s) => {
    await enable(s, ENABLED); const b = await snapshot(s); await deliver('cal', s, envelope('cal', f(calPayload()))); expect(await snapshot(s)).toBe(b);
  }));
  run('no rule for the test: fact calibration/no_rule, no movement, no alert; the same idempotency_key under a new event id writes nothing more', async (s) => {
    await enable(s, ENABLED); const p = calPayload({ test_id: TN }); const e1 = envelope('cal', p, { idempotency_key: 'SYN-IDEM-CAL-1' }); await deliver('cal', s, e1); await deliver('cal', s, envelope('cal', p, { idempotency_key: 'SYN-IDEM-CAL-1' }));
    const fs = await factsLike(s, `cal:${sha('SYN-IDEM-CAL-1')}`); expect(fs).toHaveLength(1); expect(fs[0]).toMatchObject({ status: 'no_rule', store_id: null }); expect(await movesOf(s, fs[0].id)).toEqual([]); expect(await count(s, 'alerts', "alert_kind = 'unresolved_consumption'")).toBe(0);
  });
  run('switch gate: NULL / before the enable instant -> nothing; at the enable instant -> processed; calibrator_id_raw / calibrator_lot_raw are never stored or logged (P2/P3, LT-1)', async (s) => {
    await enable(s, null); const b = await snapshot(s); await cal(s); expect(await snapshot(s)).toBe(b);
    await enable(s, V1); await cal(s, { received_at: '2026-11-13T18:59:59.999Z' }); expect(await snapshot(s)).toBe(b);
    await cal(s, { received_at: V1, calibrator_id_raw: 'SYN-CALIB-4242', calibrator_lot_raw: 'SYN-CALLOT-777' });
    const rows = await s.sql("SELECT row_to_json(f)::text AS j FROM inventory.consumption_facts f WHERE tenant_id = $1 AND fact_kind = 'calibration' AND instrument_id = $2", [A, IB1]);
    expect(rows).toHaveLength(1); for (const x of ['SYN-CALIB-4242', 'SYN-CALLOT-777']) { expect(rows[0].j).not.toContain(x); expect(s.logs.join('\n')).not.toContain(x); }
  });
});

// ========================================================================================================== store resolution: binding, then centre -> branch default store, then unresolved
describe.skipIf(!live)('T-17 store resolution for centre-carrying events (TRD §8.2 steps 1, 2, 6)', () => {
  const flow = (k: Kind, s: Sess, o: Record<string, unknown>) => (k === 'qc' ? qc(s, o) : k === 'res' ? rerun(s, o) : cal(s, o));
  const pick: Record<Kind, { ps: Record<string, unknown>; basis: (e: any) => string; item: string; test: string }> = {
    qc: { ps: { analyte_id: ASTORE }, basis: (e) => `qc:${sha(e.idempotency_key)}`, item: IQ2, test: TQ4 },
    res: { ps: { test_id: TR2 }, basis: (e) => `rerun:${e.payload.instrument_message_id}:${TR2}`, item: IRR, test: TR2 },
    cal: { ps: { test_id: TC2 }, basis: (e) => `cal:${sha(e.idempotency_key)}`, item: ICAL, test: TC2 },
  };
  it.each(KINDS)('%s: instrument WITHOUT binding, centre of branch BR1 -> the default consumption store of BR1 (MAIN-A); centre of branch BR2 -> its default store; instrument WITH a binding -> the binding wins over the centre', (k) => session(async (s) => {
    await enable(s, ENABLED); const { ps, basis, item } = pick[k];
    const e1 = await flow(k, s, { ...ps, instrument_id: IB3, centre_id: CEN1 }); const f1 = await factOf(s, basis(e1)); expect(f1).toMatchObject({ status: 'posted', store_id: MAIN_A, centre_id: CEN1 }); expect((await movesOf(s, f1.id))[0]).toMatchObject({ store_id: MAIN_A, item_id: item });
    const e2 = await flow(k, s, { ...ps, instrument_id: IB2, centre_id: CEN2 }); const f2 = await factOf(s, basis(e2)); expect(f2).toMatchObject({ status: 'posted', store_id: SD2, centre_id: CEN2 }); expect((await movesOf(s, f2.id))[0]).toMatchObject({ store_id: SD2 });
    const before = await balance(s, SB, item); const e3 = await flow(k, s, { ...ps, instrument_id: IB1, centre_id: CEN2 }); const f3 = await factOf(s, basis(e3));
    expect(f3).toMatchObject({ status: 'posted', store_id: SB }); expect(await balance(s, SB, item)).toBeLessThan(before);
  }));
  it.each(KINDS)('%s: rules matched but no binding, no default store in the centre branch and no tenant default -> fact unresolved (inserted as unresolved), no movement, alert unresolved:<instrument_id>, the job does NOT fail, counters still written', (k) => session(async (s) => {
    await enable(s, ENABLED); await s.sql('UPDATE inventory.stores SET is_default_consumption = false WHERE tenant_id = $1 AND branch_id = $2', [A, BR2]); await s.sql('UPDATE inventory.settings SET default_consumption_store_id = NULL WHERE tenant_id = $1', [A]);
    const { ps, basis, test } = pick[k]; s.log.length = 0; const e = await flow(k, s, { ...ps, instrument_id: IB2, centre_id: CEN2 }); const f = await factOf(s, basis(e));
    expect(f).toMatchObject({ status: 'unresolved', store_id: null, rules_applied: 1, value_paisa_total: '0' }); expect(await movesOf(s, f.id)).toEqual([]);
    expect(await count(s, 'alerts', "alert_kind = 'unresolved_consumption' AND status = 'open' AND dedupe_key = $2", [`unresolved:${IB2}`])).toBe(1);
    for (const u of s.log.filter((t) => /UPDATE\s+inventory\.consumption_facts/i.test(t))) expect((/SET([\s\S]*?)(WHERE|$)/i.exec(u) ?? [])[1] ?? '').not.toMatch(/\bstatus\b/i);
    if (k === 'qc') { expect(await qcObs(s, IB2)).toBe(1); expect(await counts(s, test, IB2)).toMatchObject({ qc_events: 1 }); } if (k === 'res') expect(await counts(s, test, IB2)).toMatchObject({ rerun_events: 1 });
  }));
  run('the fact is INSERTed with its FINAL status, ON CONFLICT DO NOTHING on (tenant, basis_key) (no status UPDATE); counters are upserts; event_inbox never touched', async (s) => {
    await enable(s, ENABLED); s.log.length = 0; await qc(s);
    const ins = s.log.filter((t) => /INSERT\s+INTO\s+inventory\.consumption_facts/i.test(t)); expect(ins).toHaveLength(1); expect(ins[0]).toMatch(/ON\s+CONFLICT[\s\S]*DO\s+NOTHING[\s\S]*RETURNING/i);
    for (const u of s.log.filter((t) => /UPDATE\s+inventory\.consumption_facts/i.test(t))) expect((/SET([\s\S]*?)(WHERE|$)/i.exec(u) ?? [])[1] ?? '').not.toMatch(/\bstatus\b/i);
    expect(s.log.some((t) => /INSERT\s+INTO\s+inventory\.instrument_qc_daily[\s\S]*ON\s+CONFLICT[\s\S]*DO\s+UPDATE/i.test(t))).toBe(true); expect(s.log.some((t) => /event_inbox/i.test(t))).toBe(false);
  });
});

// ========================================================================================================== validation + tenant isolation
describe.skipIf(!live)('T-17 required fields and tenant isolation (P-T6)', () => {
  it.each([['qc', 'instrument_id'], ['qc', 'received_at'], ['qc', 'mapping_status'], ['res', 'instrument_message_id'], ['res', 'received_at'], ['cal', 'instrument_id'], ['cal', 'received_at']] as [Kind, string][])(
    '%s: a missing %s rejects BEFORE any write (the job retries / dead-letters)', (k, field) => session(async (s) => {
      await enable(s, ENABLED); const before = await snapshot(s); const p: Record<string, unknown> = k === 'qc' ? qcPayload() : k === 'res' ? resPayload() : calPayload(); delete p[field];
      expect(await rejected(k, deliver(k, s, envelope(k, p)))).toBeDefined(); expect(await snapshot(s)).toBe(before);
    }));
  it.each(KINDS)('%s: a malformed received_at rejects before any write (no counter either)', (k) => session(async (s) => {
    await enable(s, ENABLED); const before = await snapshot(s); const p = k === 'qc' ? qcPayload({ received_at: 'not-a-date' }) : k === 'res' ? resPayload({ received_at: 'not-a-date' }) : calPayload({ received_at: 'not-a-date' });
    expect(await rejected(k, deliver(k, s, envelope(k, p)))).toBeDefined(); expect(await snapshot(s)).toBe(before);
  }));
  it.each(KINDS)('%s P-T6: an envelope of tenant B delivered to tenant A\'s context writes nothing in tenant A (not even the counter)', (k) => session(async (s) => {
    await enable(s, ENABLED); const before = await snapshot(s); const p = k === 'qc' ? qcPayload() : k === 'res' ? resPayload() : calPayload(); await rejected(k, deliver(k, s, envelope(k, p, { tenant_id: B }))); expect(await snapshot(s)).toBe(before);
  }));
});

// ========================================================================================================== concurrency (committed, own rows)
describe.skipIf(!live)('T-17 concurrency: QC events of one instrument in parallel', () => {
  async function deliverCommitted(e: unknown, tries = 10): Promise<number> {   // emulates the worker retry (CV §7.5)
    for (let attempt = 1; ; attempt++) {
      const c = await api.connect(); const s = sessionOn(c);
      try { await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]); await deliver('qc', s, e); await c.query('COMMIT'); return attempt; }
      catch (x) { await c.query('ROLLBACK').catch(() => undefined); if (attempt >= tries) throw x; } finally { c.release(); }
    }
  }
  const scalar = async (sql: string, v: unknown[] = []) => n((await admin.query(sql, v)).rows[0].n);
  it('12 distinct QC events (I1, GLU-A) at once, committed: qc_observations +12 exactly, qc_events +12 for the test, 12 facts, 24 consume_qc movements, exact balances; every event succeeds within the retry budget', async () => {
    await admin.query('UPDATE inventory.settings SET consumption_enabled_at = $2 WHERE tenant_id = $1', [A, ENABLED]); const at = '2026-11-10T08:00:00.000Z', bd = '2026-11-10';
    const r0 = await scalar('SELECT qty_base AS n FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3', [A, SB, IQ2]);
    const events = Array.from({ length: 12 }, () => envelope('qc', qcPayload({ received_at: at }))); const attempts = await Promise.all(events.map((e) => deliverCommitted(e))); expect(attempts.every((a) => a <= 10)).toBe(true);
    expect(await scalar('SELECT qc_observations AS n FROM inventory.instrument_qc_daily WHERE tenant_id = $1 AND business_date = $2 AND instrument_id = $3', [A, bd, IB1])).toBe(12);
    expect(await scalar('SELECT qc_events AS n FROM inventory.test_counts_daily WHERE tenant_id = $1 AND business_date = $2 AND instrument_id = $3 AND test_id = $4', [A, bd, IB1, TG])).toBe(12);
    expect(await scalar("SELECT count(*) AS n FROM inventory.consumption_facts WHERE tenant_id = $1 AND fact_kind = 'qc' AND instrument_id = $2 AND business_date = $3", [A, IB1, bd])).toBe(12);
    expect(await scalar("SELECT count(*) AS n FROM inventory.stock_movements m JOIN inventory.consumption_facts f ON f.id = m.doc_id WHERE m.tenant_id = $1 AND f.fact_kind = 'qc' AND f.instrument_id = $2 AND f.business_date = $3 AND m.movement_kind = 'consume_qc'", [A, IB1, bd])).toBe(24);
    expect(await scalar('SELECT qty_base AS n FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3', [A, SB, IQ2])).toBe(r0 - 12);
  }, 120_000);
});
