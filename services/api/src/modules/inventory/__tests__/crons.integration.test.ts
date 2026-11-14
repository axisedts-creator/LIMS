// C12.T-18 tests: the five inventory crons + alert rules file (02-TRD §8.5, §9, §13; 05-SCHEMA §4.3, §5; PRD AC-16.1, AC-16.2, AC-20.3, AC-21.7 (alert part); 08 A13 P-6, A17 D-72, D-74).
// Harness: tests/db/c12-t18/run.sh (clone of c12-t15: pinned image, migrations, seeds, inventory DDL, exports LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL / LIMS_C12T03_REQUIRE_DB=1).
// Every task runs as a worker job: `handler(payload {tenant_id}, ctx)` with ctx = {tenantId, actor system, tx, db.tx, core, log, now}; each test is ONE transaction that is ROLLED BACK (same pattern as the T-15 task suite).
// Committed fixtures (superuser, session_replication_role = replica so source rows of other modules need no parents): ids 18xxx in tenant A, source rows for lab.v_pub_result_daily / instruments.v_pub_message_daily.
//
// PINNED SEAMS (writer may dispute via CR/ruling):
//  * task files + exports (TRD §3 / §9): tasks/inventory.daily_fixed_consumption.ts -> dailyFixedConsumption, inventory.daily_alert_scan.ts -> dailyAlertScan, inventory.balance_integrity_check.ts -> balanceIntegrityCheck,
//    inventory.reconciliation_scan.ts -> reconciliationScan, inventory.purge_alerts.ts -> purgeAlerts; each `(payload: {tenant_id}, ctx: JobContext) => Promise<void>`; the manifest registers THOSE functions (no T-01 stub left).
//  * cron.ts exports `crontab` (the five entries, TRD §9 schedules, all tenantScope 'per_tenant'); manifest.crontab equals it. maxAttempts (5/5/3/3/3 in the TRD table) is not asserted.
//  * basis key of a fixed fact = domain/basis.fixedBasisKey(rule, D) = `fixed:<rule_id>:<D>` (TRD §8.5 + code + 03-APP-FLOW); PRD AC-16.2 prints `fixed:<rule>:<instrument>:<D>`, the rule already names the instrument.
//  * catch-up window: facts only for business dates in [Y-7, Y] (Y = yesterday in Asia/Kathmandu); "yesterday + up to 7 missing days" and "7 days incl. yesterday" are both accepted, older days never.
//  * fixed fact occurred_at = D 23:59:59.999 Asia/Kathmandu (= D 18:14:59.999Z); movement business_date D, kind consume_fixed, store = instrument binding.
//  * alert scan raises one alert per condition with columns alert_kind/store_id/item_id/lot_id (dedupe_key text is not asserted); auto-resolved alerts get status 'resolved', resolved_at and expires_at = resolved_at + 365 d (05-SCHEMA retention row).
//  * integrity check: balance_drift alert per differing (store, item, lot) (qty OR value, balance without movements, movements without balance); nothing in stock_balances / stock_movements is written.
//  * reconciliation: yesterday only; per test, C12 verified_result_events (summed over instruments) vs lab.v_pub_result_daily.results_verified (summed); alert when the gap in bp exceeds reconciliation_gap_alert_bp on a day with >= 50 events.
//    The cases sit away from every boundary / denominator choice: 1000 bp and 10000 bp alert, 100 bp and 0 bp do not, a 40 vs 20 day (< 50 events) does not. The alert carries test_id; the instrument QC block never raises an alert.
//  * purge: calls `SELECT app.purge_inventory_alerts()` through ctx.tx (no DELETE statement of its own), repeats while the function returns 10000; never deletes as a user actor.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { A, B, BR1, SYS, addDays, uid, ymdIn } from '../handlers/__tests__/consumption.helpers.js';
import { fixedBasisKey } from '../domain/basis.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const KT = 'Asia/Kathmandu';
const CENTRE_BR1 = '01a1a98a-ac40-7000-8000-00000000a201';
const TODAY = ymdIn(KT);
const Y = addDays(TODAY, -1); // "yesterday" in the tenant timezone (the cron's business date D)
const mins = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const here = (rel: string) => new URL(rel, import.meta.url);
const WORKER = '../../../../../worker/src/jobs/inventory';

const TASKS = {
  daily_fixed_consumption: { file: 'inventory.daily_fixed_consumption.ts', exp: 'dailyFixedConsumption', schedule: '15 19 * * *' },
  daily_alert_scan: { file: 'inventory.daily_alert_scan.ts', exp: 'dailyAlertScan', schedule: '30 19 * * *' },
  balance_integrity_check: { file: 'inventory.balance_integrity_check.ts', exp: 'balanceIntegrityCheck', schedule: '45 19 * * *' },
  reconciliation_scan: { file: 'inventory.reconciliation_scan.ts', exp: 'reconciliationScan', schedule: '0 20 * * *' },
  purge_alerts: { file: 'inventory.purge_alerts.ts', exp: 'purgeAlerts', schedule: '0 21 * * 0' },
} as const;
type TaskKey = keyof typeof TASKS;
const taskUrl = (k: TaskKey) => here(`${WORKER}/tasks/${TASKS[k].file}`).href;
const manifestUrl = here(`${WORKER}/index.ts`).href;
const cronUrl = here(`${WORKER}/cron.ts`).href;
const loadTask = async (k: TaskKey) => ((await import(/* @vite-ignore */ taskUrl(k))) as Record<string, (p: unknown, c: unknown) => Promise<void>>)[TASKS[k].exp]!;

// ------------------------------------------------------------------------------------------------------------------------------------------------ fixture ids
const XI1 = uid(18201), XI2 = uid(18202), QI1 = uid(18203);             // instruments: XI1 bound to SB with activity Y-10..Y, XI2 unbound no activity, QI1 QC counts only
const SB = uid(18301);                                                    // BR1 bench store
const FI1 = uid(18401), FI2 = uid(18402);                                 // fixed consumption items (unlotted, FI1: 1000 / 10000 in SB)
const R1 = uid(18601);                                                    // per_day XI1 FI1 50, effective since 30 d
const AL_SOON = uid(18411), AL_FAR = uid(18412), AL_SOON0 = uid(18413), AL_EXP = uid(18414);
const LOT_SOON = uid(18511), LOT_FAR = uid(18512), LOT_SOON0 = uid(18513), LOT_EXP = uid(18514);
const RI1 = uid(18421), RI2 = uid(18422), RI3 = uid(18423);               // reorder level 100: balance 40 / 150 / 150
const OCI = uid(18431);                                                   // item of the opened containers
const DI = [18441, 18442, 18443, 18444, 18445].map(uid) as [string, string, string, string, string]; // integrity items P1..P5
const T_X = uid(18001), T_YT = uid(18002), T_Z = uid(18003), T_W = uid(18004), T_U = uid(18005), T_V = uid(18006); // reconciliation tests
const ALERT_ITEMS = [AL_SOON, AL_FAR, AL_SOON0, AL_EXP, RI1, RI2, RI3, OCI];

let api: pg.Pool;
let admin: pg.Pool;

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
    case 'text': case 'character varying': return 't18';
    case 'integer': case 'smallint': case 'bigint': case 'numeric': return 0;
    case 'boolean': return false;
    case 'timestamp with time zone': return new Date().toISOString();
    case 'date': return TODAY;
    case 'jsonb': return {};
    case 'ARRAY': return '{}';
    case 'bytea': return '\\x01';
    default: throw new Error(`t18 fixture: no dummy for ${type} (${col})`);
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
const tid = { tenant_id: A };
const store = (id: string, code: string) => ({ id, ...tid, branch_id: BR1, store_code: code, name: `Store ${code}`, store_kind: 'bench', is_default_consumption: false, is_active: true });
const item = (id: string, code: string, tracked: boolean, cat = 'consumable', uom = 'piece') => ({ id, ...tid, item_code: code, name: `Item ${code}`, category: cat, base_uom_code: uom, is_lot_tracked: tracked, requires_expiry: tracked, is_active: true });
const instrument = (id: string, code: string) => ({ id, ...tid, centre_id: CENTRE_BR1, agent_id: randomUUID(), instrument_code: code, display_name: `Instrument ${code}`, vendor: 'Synthetic', model: 'SX-1', protocol: 'astm',
  driver_code: 'astm_generic_e1394', transport: { kind: 'tcp_client' }, timezone: KT, state: 'draft' });
const balance = (n: number, st: string, it: string, lot: string | null, q: number, v: number) => ({ id: uid(n), ...tid, store_id: st, item_id: it, lot_id: lot, qty_base: q, value_paisa: v, last_movement_at: new Date().toISOString() });
const movement = (n: number, it: string, q: number, v: number) => ({ id: uid(n), ...tid, business_date: Y, occurred_at: mins(30), store_id: SB, item_id: it, lot_id: null, movement_kind: 'opening_balance', qty_base: q, value_paisa: v,
  value_basis: 'receipt', doc_type: 'stock_document', doc_id: randomUUID(), balance_qty_after: q });
const messageRow = (inst: string, date: string, n: number) => ({ id: randomUUID(), ...tid, centre_id: CENTRE_BR1, instrument_id: inst, agent_message_id: randomUUID(), protocol: 'astm', message_kind: 'data', message_key: `t18-${inst}-${date}-${n}`,
  message_key_kind: 'sha256', raw_bytes: '\\x01', raw_sha256: 'a'.repeat(64), size_bytes: 1, captured_at_agent: `${date}T06:15:00Z`, agent_clock_offset_ms: 0, captured_at: `${date}T06:15:00Z`, received_at: `${date}T06:15:00Z` }); // 12:00 Asia/Kathmandu
async function seedVerified(c: pg.PoolClient, test: string, date: string, n: number) {
  const results = Array.from({ length: n }, () => ({ id: randomUUID(), ...tid, centre_id: CENTRE_BR1, processing_branch_id: BR1, test_id: test, status: 'verified', origin: 'manual', result_type: 'numeric', is_reportable: true, analyte_code: 'T18' }));
  await put(c, 'lab.results', results);
  await put(c, 'lab.verifications', results.map((r) => ({ id: randomUUID(), ...tid, centre_id: CENTRE_BR1, result_id: r.id, kind: 'verified', mode: 'manual', result_row_version: 1, occurred_at: `${date}T06:15:00Z` })));
}
const count = (test: string, date: string, verified: number, inst: string | null = null) => ({ id: randomUUID(), ...tid, business_date: date, instrument_id: inst, test_id: test, verified_result_events: verified, tests_counted: verified });

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 6 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(readFileSync(fileURLToPath(here('../../../../../../tests/db/c12-t03/fixtures.sql')), 'utf8'));
  await admin.query('GRANT EXECUTE ON FUNCTION app.purge_inventory_alerts() TO lims_app'); // 05-SCHEMA §4.4; the harness's DDL extract (tests/db/c12-t03/run.sh) omits this line, C0's migration will carry it
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query(`SELECT set_config('request.jwt.claims', '{"tenant_id":"${A}","sub":"${SYS}","actor_type":"system"}', true)`);
    await put(c, 'instruments.instruments', [instrument(XI1, 'T18-XI1'), instrument(XI2, 'T18-XI2'), instrument(QI1, 'T18-QI1')]);
    await put(c, 'inventory.stores', [store(SB, 'T18-SB')]);
    await put(c, 'inventory.items', [item(FI1, 'T18-FI1', false), item(FI2, 'T18-FI2', false), item(AL_SOON, 'T18-AL1', true, 'reagent', 'ml'), item(AL_FAR, 'T18-AL2', true, 'reagent', 'ml'), item(AL_SOON0, 'T18-AL3', true, 'reagent', 'ml'),
      item(AL_EXP, 'T18-AL4', true, 'reagent', 'ml'), item(RI1, 'T18-RI1', false), item(RI2, 'T18-RI2', false), item(RI3, 'T18-RI3', false), item(OCI, 'T18-OC1', false, 'reagent', 'ml'), ...DI.map((d, i) => item(d, `T18-DI${i + 1}`, false))]);
    await put(c, 'inventory.lots', [LOT_SOON, LOT_FAR, LOT_SOON0, LOT_EXP].map((id, i) => ({ id, ...tid, item_id: [AL_SOON, AL_FAR, AL_SOON0, AL_EXP][i], lot_no: `T18-L${i + 1}`, status: 'available', expiry_on: addDays(TODAY, [10, 45, 10, -3][i]!) })));
    await put(c, 'inventory.stock_balances', [
      balance(18701, SB, FI1, null, 1000, 10000), balance(18702, SB, FI2, null, 100, 1000),
      balance(18711, SB, AL_SOON, LOT_SOON, 5, 500), balance(18712, SB, AL_FAR, LOT_FAR, 5, 500), balance(18713, SB, AL_SOON0, LOT_SOON0, 0, 0), balance(18714, SB, AL_EXP, LOT_EXP, 5, 500),
      balance(18721, SB, RI1, null, 40, 400), balance(18722, SB, RI2, null, 150, 1500), balance(18723, SB, RI3, null, 150, 1500),
      balance(18731, SB, DI[0], null, 10, 100), balance(18732, SB, DI[1], null, 10, 100), balance(18733, SB, DI[2], null, 10, 100), balance(18734, SB, DI[3], null, 5, 50),   // P5 (DI[4]) has movements only
    ]);
    await put(c, 'inventory.stock_movements', [movement(18741, DI[0], 10, 100), movement(18742, DI[1], 7, 70), movement(18743, DI[2], 10, 90), movement(18745, DI[4], 4, 40)]);
    await put(c, 'inventory.store_item_settings', [RI1, RI2, RI3].map((it, i) => ({ id: uid(18801 + i), ...tid, store_id: SB, item_id: it, reorder_level_base: 100, reorder_qty_base: 200, is_stocked: true, is_active: true })));
    await put(c, 'inventory.opened_containers', [
      { id: uid(18901), ...tid, store_id: SB, item_id: OCI, opened_at: days(10), open_expiry_at: days(1), status: 'open' },                                   // exceeded
      { id: uid(18902), ...tid, store_id: SB, item_id: OCI, opened_at: days(1), open_expiry_at: new Date(Date.now() + 86_400_000).toISOString(), status: 'open' }, // still within stability
      { id: uid(18903), ...tid, store_id: SB, item_id: OCI, opened_at: days(10), open_expiry_at: days(1), status: 'finished', finished_at: days(2), finished_by: SYS },     // finished
    ]);
    await put(c, 'inventory.instrument_bindings', [{ id: uid(18951), ...tid, instrument_id: XI1, store_id: SB, is_active: true }]);
    await put(c, 'inventory.consumption_rules', [{ id: R1, ...tid, rule_kind: 'per_day', instrument_id: XI1, item_id: FI1, qty_base: 50, entered_qty: 50, effective_from: days(30), is_active: true }]);
    await put(c, 'instruments.messages', Array.from({ length: 11 }, (_, i) => messageRow(XI1, addDays(TODAY, -1 - i), i)));    // activity on Y .. Y-10 for XI1; none for XI2
    // reconciliation: lab side (verified results) and C12 side (test_counts_daily / instrument_qc_daily)
    for (const [t, n] of [[T_X, 100], [T_YT, 100], [T_Z, 40], [T_W, 100], [T_U, 100]] as const) await seedVerified(c, t, Y, n);
    await seedVerified(c, T_V, addDays(Y, -3), 100);
    await put(c, 'inventory.test_counts_daily', [count(T_X, Y, 90), count(T_YT, Y, 99), count(T_Z, Y, 20), count(T_W, Y, 60, XI1), count(T_W, Y, 40, XI2), count(T_V, addDays(Y, -3), 50)]); // T_U: no C12 row; T_W summed over two instruments
    await put(c, 'inventory.instrument_qc_daily', [{ ...tid, business_date: Y, instrument_id: QI1, qc_observations: 100 }]); // instruments.v_pub_message_daily.qc_records for QI1 = 0 -> a 100 % instrument-block gap
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}, 180_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

// ------------------------------------------------------------------------------------------------------------------------------------------------ session + job ctx
interface Sess { client: pg.PoolClient; log: string[]; tx: { query(t: string, v?: unknown[]): Promise<{ rows: any[] }> }; sql(t: string, text: string, v?: unknown[]): Promise<any[]>; as(actor: 'system' | 'user', tenant?: string): Promise<void> }
const claims = (t: string, actor: 'system' | 'user') => JSON.stringify({ tenant_id: t, sub: actor === 'system' ? SYS : uid(18999), actor_type: actor });
function sessionOn(client: pg.PoolClient): Sess {
  const log: string[] = [];
  const tx = { query: (t: string, v?: unknown[]) => { log.push(t); return client.query(t, v); } };
  const setClaims = (t: string, a: 'system' | 'user' = 'system') => client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(t, a)]);
  return { client, log, tx, async sql(t, text, v) { await setClaims(t); return (await client.query(text, v)).rows; }, async as(actor, tenant = A) { await setClaims(tenant, actor); } };
}
async function session<T>(fn: (s: Sess) => Promise<T>): Promise<T> {
  const client = await api.connect();
  try { await client.query('BEGIN'); await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A, 'system')]); return await fn(sessionOn(client)); } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}
const run = (name: string, fn: (s: Sess) => Promise<void>, timeout?: number) => it(name, () => session(fn), timeout);

async function jobCtx(s: Sess, tenant = A, actorType: 'system' | 'user' = 'system') {
  const { createCoreRepo } = await import('../../../core/core-repo/index.js');
  let sp = 0;
  await s.as(actorType === 'system' ? 'system' : 'user', tenant === A ? A : tenant);
  const ctx: any = { tenantId: tenant, actor: { type: actorType, id: actorType === 'system' ? SYS : uid(18999) }, requestId: 'r-t18-task', tx: s.tx, now: () => new Date().toISOString(), attempt: 1, maxAttempts: 5, jobId: 'job-t18', isNewer: () => true,
    core: createCoreRepo({ withTenantScope: async (_t: unknown, _tenant: unknown, _actor: unknown, fn: () => unknown) => fn(), systemActorOf: () => SYS }), events: {}, storage: {}, files: {}, audit: {},
    log: { info() {}, warn() {}, error() {} } };
  ctx.db = { async tx(fn: (c: unknown) => Promise<unknown>) { const name = `t18_task_sp_${++sp}`; await s.tx.query(`SAVEPOINT ${name}`); try { const r = await fn(ctx); await s.tx.query(`RELEASE SAVEPOINT ${name}`); return r; } catch (e) { await s.tx.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; } } };
  return ctx;
}
/** runs the task for tenant A (payload tenant = ctx tenant) unless told otherwise */
async function runTask(s: Sess, k: TaskKey, payload: Record<string, unknown> = { tenant_id: A }, tenant = A) { const h = await loadTask(k); await h(payload, await jobCtx(s, tenant)); }

// ------------------------------------------------------------------------------------------------------------------------------------------------ small db helpers
const num = (v: unknown) => Number(v);
const alertsOf = (s: Sess, kind: string, items: string[]) => s.sql(A, `SELECT alert_kind, store_id, item_id, lot_id, test_id, instrument_id, status, resolved_at, expires_at, occurrences FROM inventory.alerts WHERE tenant_id = $1 AND alert_kind = $2 AND item_id = ANY($3::uuid[]) ORDER BY item_id`, [A, kind, items]);
const openAlerts = async (s: Sess, kind: string, items: string[]) => (await alertsOf(s, kind, items)).filter((a) => a.status !== 'resolved');
const gapAlerts = (s: Sess) => s.sql(A, `SELECT test_id, instrument_id, status FROM inventory.alerts WHERE tenant_id = $1 AND alert_kind = 'reconciliation_gap' AND status <> 'resolved' AND (test_id = ANY($2::uuid[]) OR instrument_id = $3) ORDER BY test_id`, [A, [T_X, T_YT, T_Z, T_W, T_U, T_V], QI1]);
const driftAlerts = (s: Sess) => s.sql(A, `SELECT store_id, item_id, lot_id, status FROM inventory.alerts WHERE tenant_id = $1 AND alert_kind = 'balance_drift' AND item_id = ANY($2::uuid[]) AND status <> 'resolved' ORDER BY item_id`, [A, DI]);
const fixedFacts = (s: Sess, rules: string[]) => s.sql(A, `SELECT id, basis_key, fact_kind, status, store_id, instrument_id, business_date::text AS bd, occurred_at, (SELECT count(*) FROM inventory.stock_movements m WHERE m.tenant_id = f.tenant_id AND m.doc_type = 'consumption_fact' AND m.doc_id = f.id)::int AS movements
  FROM inventory.consumption_facts f WHERE tenant_id = $1 AND basis_key LIKE 'fixed:%' AND basis_key ~ ANY(SELECT '^fixed:' || r || ':' FROM unnest($2::text[]) r) ORDER BY business_date`, [A, rules]);
const fixedMoves = (s: Sess) => s.sql(A, `SELECT movement_kind AS kind, store_id, item_id, qty_base::text AS q, value_paisa::text AS v, instrument_id, rule_id, business_date::text AS bd, occurred_at, doc_type FROM inventory.stock_movements WHERE tenant_id = $1 AND rule_id = $2 ORDER BY business_date`, [A, R1]);
const bal = async (s: Sess, st: string, it: string) => { const r = (await s.sql(A, 'SELECT qty_base::text AS q, value_paisa::text AS v, version FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id IS NULL', [A, st, it]))[0]; return r ? { q: num(r.q), v: num(r.v), version: r.version } : { q: 0, v: 0, version: 0 }; };
const ledgerSnapshot = async (s: Sess, t = A) => JSON.stringify([await s.sql(t, 'SELECT id, qty_base::text, value_paisa, version FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [t]),
  await s.sql(t, 'SELECT count(*) AS n FROM inventory.stock_movements WHERE tenant_id = $1', [t]), await s.sql(t, 'SELECT count(*) AS n FROM inventory.consumption_facts WHERE tenant_id = $1', [t])]);
const allAlerts = (s: Sess, t = A) => s.sql(t, 'SELECT count(*)::int AS n FROM inventory.alerts WHERE tenant_id = $1', [t]).then((r) => r[0].n as number);
async function insAlert(s: Sess, o: { kind: string; store?: string; item?: string; lot?: string | null; key: string; status?: string; expires?: string | null; resolved?: string | null; tenant?: string }) {
  const status = o.status ?? 'open';
  await s.sql(o.tenant ?? A, `INSERT INTO inventory.alerts (id, tenant_id, alert_kind, store_id, item_id, lot_id, dedupe_key, status, first_raised_at, last_raised_at, expires_at, resolved_at, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '3 days', now() - interval '3 days', $9, $10, $11, $11)`,
    [randomUUID(), o.tenant ?? A, o.kind, o.store ?? null, o.item ?? null, o.lot ?? null, o.key, status, o.expires ?? null, o.resolved ?? (status === 'resolved' ? new Date().toISOString() : null), SYS]);
}
const withRule = (s: Sess, id: string, o: { instrument: string; item: string; qty: number; from?: string; to?: string | null; active?: boolean }) =>
  s.sql(A, `INSERT INTO inventory.consumption_rules (id, tenant_id, rule_kind, instrument_id, item_id, qty_base, entered_qty, effective_from, effective_to, is_active, created_by, updated_by) VALUES ($1, $2, 'per_day', $3, $4, $5, $5, $6, $7, $8, $9, $9)`,
    [id, A, o.instrument, o.item, o.qty, o.from ?? days(30), o.to ?? null, o.active ?? true, SYS]);

// ================================================================================================================================================ static: manifest, cron.ts, rules file
describe('T-18 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => { if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true); });
});

describe('T-18 manifest + cron.ts (TRD §9; 08 A13 P-6, A17 D-72)', () => {
  const NAMES = Object.keys(TASKS).map((k) => `inventory.${k}`);
  it('the manifest registers the five REAL task functions exported by the files the plan names (no T-01 stub left)', async () => {
    const { manifest } = (await import(/* @vite-ignore */ manifestUrl)) as any;
    for (const k of Object.keys(TASKS) as TaskKey[]) {
      const fn = await loadTask(k);
      expect(typeof fn, `${TASKS[k].file} must export ${TASKS[k].exp}`).toBe('function');
      expect(manifest.tasks[`inventory.${k}`]).toBe(fn);
    }
  });
  it('cron.ts exports the five entries, every one tenantScope per_tenant (none platform) with the TRD §9 UTC schedule; the manifest crontab is that array', async () => {
    const { crontab } = (await import(/* @vite-ignore */ cronUrl)) as { crontab: { identifier: string; schedule: string; tenantScope: string }[] };
    expect(crontab.map((c) => c.identifier).sort()).toEqual([...NAMES].sort());
    for (const c of crontab) {
      expect(c.tenantScope, c.identifier).toBe('per_tenant');
      expect(c.schedule, c.identifier).toBe(TASKS[c.identifier.replace('inventory.', '') as TaskKey].schedule);
    }
    const { manifest } = (await import(/* @vite-ignore */ manifestUrl)) as any;
    expect(manifest.crontab).toEqual(crontab);
  });
  it('the manifest still passes the build-time validation (validateManifests)', async () => {
    const { validateManifests } = await import('../../../../../worker/src/core/manifest.js');
    const { manifest } = (await import(/* @vite-ignore */ manifestUrl)) as any;
    expect(() => validateManifests([manifest])).not.toThrow();
  });
});

describe('T-18 ops/inventory.rules.yml (CR-C12-011; TRD §13 "Alert rules for C1")', () => {
  const path = fileURLToPath(here(`${WORKER}/ops/inventory.rules.yml`));
  const EXPECTED = [
    { alert: 'InventoryConsumerFailing', expr: 'sum by (event_type) (increase(lims_inventory_consumer_failures_total[15m])) > 0', for: '15m', severity: 'page' },
    { alert: 'InventoryConsumptionLagHigh', expr: 'histogram_quantile(0.95, sum by (le, event_type) (rate(lims_inventory_consumption_lag_seconds_bucket[5m]))) > 300', for: '15m', severity: 'warn' },
    { alert: 'InventoryBalanceDrift', expr: 'max by (tenant_id) (lims_inventory_balance_drift_rows) > 0', for: '0m', severity: 'page' },
    { alert: 'InventoryUnresolvedBacklog', expr: 'max by (tenant_id) (lims_inventory_unresolved_oldest_age_seconds) > 86400', for: '5m', severity: 'warn' },
  ];
  const norm = (x: unknown) => String(x).replace(/\s+/g, ' ').trim();
  const rulesOf = (file: string) => (parseYaml(readFileSync(file, 'utf8')) as any).groups.flatMap((g: any) => g.rules) as any[];
  it('the file exists at the TRD path and holds exactly the four rules with the TRD expr / for / severity', () => {
    expect(existsSync(path), `${path} must exist`).toBe(true);
    const rules = rulesOf(path);
    expect(rules.map((r) => r.alert).sort()).toEqual(EXPECTED.map((e) => e.alert).sort());
    for (const e of EXPECTED) {
      const r = rules.find((x) => x.alert === e.alert);
      expect({ expr: norm(r.expr), for: norm(r.for), severity: r.labels?.severity }, e.alert).toEqual({ expr: e.expr, for: e.for, severity: e.severity });
    }
  });
  it('the C1 import (infra/monitoring/rules/imported/inventory.rules.yml) carries the same expr / for (alert-import-drift)', () => {
    const imported = rulesOf(fileURLToPath(here('../../../../../../infra/monitoring/rules/imported/inventory.rules.yml')));
    const own = rulesOf(path);
    for (const r of imported) { const o = own.find((x) => x.alert === r.alert); expect(o, r.alert).toBeDefined(); expect([norm(o.expr), norm(o.for)]).toEqual([norm(r.expr), norm(r.for)]); }
  });
});

// ================================================================================================================================================ fixtures visible to the nightly system actor
describe.skipIf(!live)('T-18 fixtures (sanity: the views the scans read show the seeded source rows to the system actor)', () => {
  run('lab.v_pub_result_daily / instruments.v_pub_message_daily / C12 counters see the seeded rows', async (s) => {
    const lab = await s.sql(A, 'SELECT test_id, sum(results_verified)::int AS n FROM lab.v_pub_result_daily WHERE business_date = $1 AND test_id = ANY($2::uuid[]) GROUP BY 1', [Y, [T_X, T_YT, T_Z, T_W, T_U]]);
    expect(Object.fromEntries(lab.map((r) => [r.test_id, r.n]))).toEqual({ [T_X]: 100, [T_YT]: 100, [T_Z]: 40, [T_W]: 100, [T_U]: 100 });
    const act = await s.sql(A, 'SELECT business_date::text AS d, messages::int AS m FROM instruments.v_pub_message_daily WHERE instrument_id = $1 ORDER BY 1', [XI1]);
    expect(act.length).toBe(11); expect(act.map((r) => r.d)).toContain(Y); expect(act.every((r) => r.m === 1)).toBe(true);
    expect(await s.sql(A, 'SELECT 1 FROM instruments.v_pub_message_daily WHERE instrument_id = $1', [XI2])).toEqual([]);
    expect((await s.sql(A, 'SELECT qc_records::int AS q FROM instruments.v_pub_message_daily WHERE instrument_id = $1 AND business_date = $2', [QI1, Y]))).toEqual([]); // QI1 has no messages: qc_records = 0 / no row
    expect((await s.sql(A, 'SELECT qc_observations FROM inventory.instrument_qc_daily WHERE instrument_id = $1 AND business_date = $2', [QI1, Y]))[0].qc_observations).toBe(100);
  });
});

// ================================================================================================================================================ US-16 inventory.daily_fixed_consumption (AC-16.1, AC-16.2)
describe.skipIf(!live)('T-18 inventory.daily_fixed_consumption (AC-16.1, AC-16.2; TRD §8.5)', () => {
  run('AC-16.1: per_day rule + activity on D => ONE fact fixed:<rule>:<D> posted, ONE consume_fixed movement of -50 for D in the instrument\'s bound store, occurred_at = D 23:59:59.999 Asia/Kathmandu', async (s) => {
    const before = await bal(s, SB, FI1);
    await runTask(s, 'daily_fixed_consumption');
    const f = (await fixedFacts(s, [R1])).filter((x) => x.bd === Y);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ basis_key: fixedBasisKey(R1, Y), status: 'posted', store_id: SB, instrument_id: XI1, movements: 1 });
    expect(new Date(f[0].occurred_at).toISOString()).toBe(`${Y}T18:14:59.999Z`);
    const m = (await fixedMoves(s)).filter((x) => x.bd === Y);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'consume_fixed', store_id: SB, item_id: FI1, instrument_id: XI1, rule_id: R1, doc_type: 'consumption_fact' });
    expect(num(m[0].q)).toBe(-50); expect(num(m[0].v)).toBe(-500); // average cost 10 paisa / unit
    expect(new Date(m[0].occurred_at).toISOString()).toBe(`${Y}T18:14:59.999Z`);
    const nFacts = (await fixedFacts(s, [R1])).length;
    expect((await bal(s, SB, FI1)).q).toBe(before.q - 50 * nFacts); // every catch-up day took exactly 50
  });

  run('AC-16.2: running the job twice writes nothing new (no second fact, no second movement, balance unchanged)', async (s) => {
    await runTask(s, 'daily_fixed_consumption');
    const facts = await fixedFacts(s, [R1]); const moves = await fixedMoves(s); const b = await bal(s, SB, FI1); const snap = await ledgerSnapshot(s);
    expect(facts.length).toBeGreaterThan(0);
    await runTask(s, 'daily_fixed_consumption');
    expect((await fixedFacts(s, [R1])).map((x) => x.basis_key)).toEqual(facts.map((x) => x.basis_key));
    expect(await fixedMoves(s)).toEqual(moves);
    expect(await bal(s, SB, FI1)).toEqual(b);
    expect(await ledgerSnapshot(s)).toBe(snap);
    expect(new Set(facts.map((x) => x.basis_key)).size).toBe(facts.length);
  });

  run('no activity on D (per_day_requires_activity = true) => no fact for XI2; = false => one fact without activity', async (s) => {
    await withRule(s, uid(18611), { instrument: XI2, item: FI1, qty: 5 });
    await s.sql(A, 'INSERT INTO inventory.instrument_bindings (id, tenant_id, instrument_id, store_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)', [randomUUID(), A, XI2, SB, SYS]);
    await runTask(s, 'daily_fixed_consumption');
    expect(await fixedFacts(s, [uid(18611)])).toEqual([]);
    await s.sql(A, 'UPDATE inventory.settings SET per_day_requires_activity = false WHERE tenant_id = $1', [A]);
    await runTask(s, 'daily_fixed_consumption');
    const f = (await fixedFacts(s, [uid(18611)])).filter((x) => x.bd === Y);
    expect(f).toHaveLength(1); expect(f[0]).toMatchObject({ status: 'posted', store_id: SB, instrument_id: XI2, movements: 1 });
  });

  run('catch-up: activity on Y..Y-10 and the job never ran => facts for yesterday and the missing days, none older than 7 days before yesterday, at most 8 dates; one run only', async (s) => {
    await runTask(s, 'daily_fixed_consumption');
    const dates = (await fixedFacts(s, [R1])).map((x) => x.bd);
    expect(dates).toContain(Y); expect(dates).toContain(addDays(Y, -1)); expect(dates).toContain(addDays(Y, -6));
    expect(dates.length).toBeLessThanOrEqual(8);
    for (const d of dates) { expect(d >= addDays(Y, -7), `${d} is older than the 7-day catch-up window`).toBe(true); expect(d <= Y, `${d} is in the future`).toBe(true); }
    expect(dates).not.toContain(addDays(Y, -8)); expect(dates).not.toContain(addDays(Y, -10));
    expect(new Set(dates).size).toBe(dates.length);
  });

  run('rules are evaluated at D: an inactive rule and a rule that starts after D (or ended before it) produce no fact', async (s) => {
    await withRule(s, uid(18621), { instrument: XI1, item: FI2, qty: 1, active: false });
    await withRule(s, uid(18622), { instrument: XI1, item: FI2, qty: 1, from: mins(60) });
    await withRule(s, uid(18623), { instrument: XI1, item: FI2, qty: 1, from: days(30), to: days(20) });
    const snap2 = (await bal(s, SB, FI2));
    await runTask(s, 'daily_fixed_consumption');
    expect(await fixedFacts(s, [uid(18621), uid(18622)])).toEqual([]);
    expect((await fixedFacts(s, [uid(18623)])).every((f) => f.bd <= addDays(TODAY, -20))).toBe(true); // may only exist for days it was effective (none are in the catch-up window)
    expect(await bal(s, SB, FI2)).toEqual(snap2);
  });

  run('the task works on ITS tenant only: a payload naming tenant B (or a ctx of tenant B) writes nothing for tenant A or B', async (s) => {
    const snapA = await ledgerSnapshot(s, A); const snapB = await ledgerSnapshot(s, B);
    await runTask(s, 'daily_fixed_consumption', { tenant_id: B }, A);   // payload can never widen the tenant scope
    expect(await ledgerSnapshot(s, A)).toBe(snapA); expect(await ledgerSnapshot(s, B)).toBe(snapB);
    expect(await fixedFacts(s, [R1])).toEqual([]);
  });
});

// ================================================================================================================================================ inventory.daily_alert_scan (AC-20.3; TRD §9)
describe.skipIf(!live)('T-18 inventory.daily_alert_scan (AC-20.3)', () => {
  run('expiry_soon: a lot expiring within expiry_alert_days (30) WITH stock raises one alert; a lot beyond the window or without stock raises none', async (s) => {
    await runTask(s, 'daily_alert_scan');
    const a = await openAlerts(s, 'expiry_soon', [AL_SOON, AL_FAR, AL_SOON0, AL_EXP]);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ store_id: SB, item_id: AL_SOON, lot_id: LOT_SOON, status: 'open' });
  });

  run('expired_on_hand: an expired lot with stock raises it (and not expiry_soon); not for in-date or empty lots', async (s) => {
    await runTask(s, 'daily_alert_scan');
    const a = await openAlerts(s, 'expired_on_hand', [AL_SOON, AL_FAR, AL_SOON0, AL_EXP]);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ store_id: SB, item_id: AL_EXP, lot_id: LOT_EXP });
    expect(await openAlerts(s, 'expiry_soon', [AL_EXP])).toEqual([]);
  });

  run('the expiry_alert_days setting is honoured: 60 days also covers the +45 d lot, 5 days covers none', async (s) => {
    await s.sql(A, 'UPDATE inventory.settings SET expiry_alert_days = 60 WHERE tenant_id = $1', [A]);
    await runTask(s, 'daily_alert_scan');
    expect((await openAlerts(s, 'expiry_soon', [AL_SOON, AL_FAR, AL_SOON0])).map((a) => a.item_id).sort()).toEqual([AL_SOON, AL_FAR].sort());
  });
  run('expiry_alert_days = 5 raises no expiry_soon for the +10 d lot', async (s) => {
    await s.sql(A, 'UPDATE inventory.settings SET expiry_alert_days = 5 WHERE tenant_id = $1', [A]);
    await runTask(s, 'daily_alert_scan');
    expect(await openAlerts(s, 'expiry_soon', [AL_SOON, AL_FAR, AL_SOON0])).toEqual([]);
  });

  run('open_stability_exceeded: an OPEN container past open_expiry_at raises one alert; a container still in date or already finished raises none', async (s) => {
    await runTask(s, 'daily_alert_scan');
    const a = await openAlerts(s, 'open_stability_exceeded', [OCI]);
    expect(a).toHaveLength(1); expect(a[0]).toMatchObject({ store_id: SB, item_id: OCI });
  });

  run('below_reorder is re-evaluated: below the level raises one alert, at/above does not', async (s) => {
    await runTask(s, 'daily_alert_scan');
    const a = await openAlerts(s, 'below_reorder', [RI1, RI2, RI3]);
    expect(a.map((x) => x.item_id)).toEqual([RI1]); expect(a[0]).toMatchObject({ store_id: SB });
  });

  run('auto-resolve: open alerts whose condition is gone (empty lot, stock back above reorder level) become resolved with resolved_at and expires_at = resolved_at + 365 d; live ones stay open', async (s) => {
    await insAlert(s, { kind: 'expiry_soon', store: SB, item: AL_SOON0, lot: LOT_SOON0, key: `expiry_soon:${SB}:${AL_SOON0}:${LOT_SOON0}` });
    await insAlert(s, { kind: 'below_reorder', store: SB, item: RI3, key: `below_reorder:${SB}:${RI3}` });
    await insAlert(s, { kind: 'below_reorder', store: SB, item: RI1, key: `below_reorder:${SB}:${RI1}` });
    await runTask(s, 'daily_alert_scan');
    const gone = [...(await alertsOf(s, 'expiry_soon', [AL_SOON0])), ...(await alertsOf(s, 'below_reorder', [RI3]))];
    expect(gone).toHaveLength(2);
    for (const a of gone) {
      expect(a.status).toBe('resolved'); expect(a.resolved_at).not.toBeNull();
      const d = (new Date(a.expires_at).getTime() - new Date(a.resolved_at).getTime()) / 86_400_000;
      expect(d, 'expires_at = resolved_at + 365 days').toBeGreaterThan(364); expect(d).toBeLessThan(366);
    }
    const live1 = await openAlerts(s, 'below_reorder', [RI1]);
    expect(live1).toHaveLength(1); expect(live1[0].status).toBe('open');
  });

  run('idempotent: a second run keeps exactly one open alert per condition (no duplicates)', async (s) => {
    await runTask(s, 'daily_alert_scan');
    const keys = async () => (await s.sql(A, `SELECT alert_kind, item_id, lot_id, count(*)::int AS n FROM inventory.alerts WHERE tenant_id = $1 AND status <> 'resolved' AND item_id = ANY($2::uuid[]) GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [A, ALERT_ITEMS]));
    const first = await keys();
    expect(first.length).toBeGreaterThanOrEqual(5); for (const k of first) expect(k.n).toBe(1);
    await runTask(s, 'daily_alert_scan');
    expect(await keys()).toEqual(first);
  });

  run('the scan changes alerts only: no ledger row (balances, movements, facts) is written', async (s) => {
    const snap = await ledgerSnapshot(s);
    await runTask(s, 'daily_alert_scan');
    expect(await ledgerSnapshot(s)).toBe(snap);
  });

  run('tenant isolation: a payload naming tenant B raises nothing; the run for A raises nothing for B', async (s) => {
    const before = await allAlerts(s, A);
    await runTask(s, 'daily_alert_scan', { tenant_id: B }, A);
    expect(await allAlerts(s, A)).toBe(before);
    await runTask(s, 'daily_alert_scan');
    expect(await s.sql(B, 'SELECT 1 FROM inventory.alerts WHERE tenant_id = $1 AND item_id = ANY($2::uuid[])', [B, ALERT_ITEMS])).toEqual([]);
  });
});

// ================================================================================================================================================ inventory.balance_integrity_check (never auto-corrects)
describe.skipIf(!live)('T-18 inventory.balance_integrity_check (TRD §9, §10 invariant 1: raise, NEVER correct)', () => {
  run('a balance that differs from the movement sum (qty, value, no movements) or movements without a balance row raise balance_drift for that (store, item, lot); a consistent pair raises none', async (s) => {
    await runTask(s, 'balance_integrity_check');
    const a = await driftAlerts(s);
    expect(a.map((x) => x.item_id).sort()).toEqual([DI[1], DI[2], DI[3], DI[4]].sort());   // P1 (DI[0]) is consistent
    for (const x of a) { expect(x.store_id).toBe(SB); expect(x.lot_id).toBeNull(); expect(x.status).toBe('open'); }
  });

  run('NEVER auto-corrects: stock_balances and stock_movements are byte-identical after the run and the task sends no write statement for them', async (s) => {
    const snap = await ledgerSnapshot(s); const bals = await s.sql(A, 'SELECT * FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [A]);
    s.log.length = 0;
    await runTask(s, 'balance_integrity_check');
    expect(await ledgerSnapshot(s)).toBe(snap);
    expect(await s.sql(A, 'SELECT * FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [A])).toEqual(bals);
    expect(s.log.filter((t) => /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+inventory\.(stock_balances|stock_movements|consumption_facts)\b/i.test(t))).toEqual([]);
    expect(await bal(s, SB, DI[1])).toMatchObject({ q: 10, v: 100 }); // the drifting balance keeps its wrong value
  });

  run('idempotent: a second run keeps ONE open balance_drift alert per drifting row', async (s) => {
    await runTask(s, 'balance_integrity_check'); await runTask(s, 'balance_integrity_check');
    const a = await driftAlerts(s);
    expect(a.map((x) => x.item_id).sort()).toEqual([DI[1], DI[2], DI[3], DI[4]].sort());
  });

  run('tenant isolation: payload tenant B => no alert; tenant B gets no alert from the run for A', async (s) => {
    const before = await allAlerts(s, A);
    await runTask(s, 'balance_integrity_check', { tenant_id: B }, A);
    expect(await allAlerts(s, A)).toBe(before);
    await runTask(s, 'balance_integrity_check');
    expect(await s.sql(B, "SELECT 1 FROM inventory.alerts WHERE tenant_id = $1 AND alert_kind = 'balance_drift' AND store_id = $2", [B, SB])).toEqual([]);
  });
});

// ================================================================================================================================================ inventory.reconciliation_scan (AC-21.7 alert part; D-74)
describe.skipIf(!live)('T-18 inventory.reconciliation_scan (AC-21.7 alert part; D-74: test block only)', () => {
  run('test block: > reconciliation_gap_alert_bp (200) on a day with >= 50 events raises one reconciliation_gap alert (100 vs 90 events; 100 vs none); 100 vs 99, 100 vs 100 (two instruments summed) and 40 vs 20 (< 50 events) raise none', async (s) => {
    await runTask(s, 'reconciliation_scan');
    const a = await gapAlerts(s);
    expect(a.map((x) => x.test_id).filter(Boolean).sort()).toEqual([T_X, T_U].sort());
    for (const x of a) expect(x.status).toBe('open');
  });

  run('D-74: the instrument QC block (instrument_qc_daily 100 vs qc_records 0) raises NO alert of any kind', async (s) => {
    await runTask(s, 'reconciliation_scan');
    expect((await gapAlerts(s)).filter((x) => x.instrument_id === QI1)).toEqual([]);
    expect(await s.sql(A, "SELECT 1 FROM inventory.alerts WHERE tenant_id = $1 AND instrument_id = $2", [A, QI1])).toEqual([]);
  });

  run('only yesterday is reconciled: the 100 vs 50 gap three days earlier raises nothing', async (s) => {
    await runTask(s, 'reconciliation_scan');
    expect((await gapAlerts(s)).map((x) => x.test_id)).not.toContain(T_V);
  });

  run('the threshold is the tenant setting: 1500 bp silences the 1000 bp gap (the total-loss gap still alerts); 50 bp makes the 100 vs 99 day alert', async (s) => {
    await s.sql(A, 'UPDATE inventory.settings SET reconciliation_gap_alert_bp = 1500 WHERE tenant_id = $1', [A]);
    await runTask(s, 'reconciliation_scan');
    expect((await gapAlerts(s)).map((x) => x.test_id).filter(Boolean)).toEqual([T_U]);
    await s.sql(A, 'UPDATE inventory.settings SET reconciliation_gap_alert_bp = 50 WHERE tenant_id = $1', [A]);
    await runTask(s, 'reconciliation_scan');
    expect((await gapAlerts(s)).map((x) => x.test_id).filter(Boolean).sort()).toEqual([T_X, T_YT, T_U].sort());   // the 40 vs 20 day stays silent (< 50 events)
  });

  run('idempotent: a second run keeps one open alert per gap; the scan writes no ledger row and reads as the system actor (nothing needs a user scope)', async (s) => {
    const snap = await ledgerSnapshot(s);
    await runTask(s, 'reconciliation_scan'); await runTask(s, 'reconciliation_scan');
    expect((await gapAlerts(s)).map((x) => x.test_id).filter(Boolean).sort()).toEqual([T_X, T_U].sort());
    expect(await ledgerSnapshot(s)).toBe(snap);
  });

  run('tenant isolation: payload tenant B => no alert', async (s) => {
    const before = await allAlerts(s, A);
    await runTask(s, 'reconciliation_scan', { tenant_id: B }, A);
    expect(await allAlerts(s, A)).toBe(before);
  });
});

// ================================================================================================================================================ inventory.purge_alerts (D-72, P-18(c); 05-SCHEMA §4.3, §5)
describe.skipIf(!live)('T-18 inventory.purge_alerts (INVOKER app.purge_inventory_alerts() as the system actor via alerts__delete__tenant)', () => {
  const seedPurge = async (s: Sess) => {
    await insAlert(s, { kind: 'below_reorder', store: SB, item: RI1, key: 'p-expired-1', status: 'resolved', expires: days(1) });
    await insAlert(s, { kind: 'expiry_soon', store: SB, item: AL_SOON, key: 'p-expired-2', status: 'resolved', expires: days(400) });
    await insAlert(s, { kind: 'negative_stock', store: SB, item: RI2, key: 'p-future', status: 'resolved', expires: new Date(Date.now() + 86_400_000).toISOString() });
    await insAlert(s, { kind: 'negative_stock', store: SB, item: RI3, key: 'p-open-no-expiry' });
    await insAlert(s, { kind: 'below_reorder', store: undefined, item: undefined, key: 'p-b-expired', status: 'resolved', expires: days(2), tenant: B });
  };
  const keysA = async (s: Sess) => (await s.sql(A, "SELECT dedupe_key FROM inventory.alerts WHERE tenant_id = $1 AND dedupe_key LIKE 'p-%' ORDER BY 1", [A])).map((r) => r.dedupe_key);

  run('system actor: expired alerts of the tenant are deleted through app.purge_inventory_alerts(); alerts not yet expired, without expires_at, and the other tenant\'s expired alerts stay', async (s) => {
    await seedPurge(s);
    s.log.length = 0;
    await runTask(s, 'purge_alerts');
    expect(await keysA(s)).toEqual(['p-future', 'p-open-no-expiry']);
    expect((await s.sql(B, "SELECT dedupe_key FROM inventory.alerts WHERE tenant_id = $1 AND dedupe_key = 'p-b-expired'", [B])).length).toBe(1);
    expect(s.log.some((t) => /app\.purge_inventory_alerts\s*\(/i.test(t))).toBe(true);
    expect(s.log.filter((t) => /DELETE\s+FROM\s+inventory\.alerts/i.test(t)), 'the task calls the function, it never deletes by itself').toEqual([]);
  });

  run('batches: the task repeats the call while it returns 10,000 (10,001 expired rows all go in one run)', async (s) => {
    await s.sql(A, `INSERT INTO inventory.alerts (id, tenant_id, alert_kind, dedupe_key, status, first_raised_at, last_raised_at, resolved_at, expires_at, created_by, updated_by)
      SELECT gen_random_uuid(), $1, 'balance_drift', 'p-bulk-' || g, 'resolved', now() - interval '400 days', now() - interval '400 days', now() - interval '399 days', now() - interval '1 day', $2, $2 FROM generate_series(1, 10001) g`, [A, SYS]);
    await insAlert(s, { kind: 'negative_stock', store: SB, item: RI3, key: 'p-keep', status: 'resolved', expires: new Date(Date.now() + 86_400_000).toISOString() });
    await runTask(s, 'purge_alerts');
    expect(await s.sql(A, "SELECT count(*)::int AS n FROM inventory.alerts WHERE tenant_id = $1 AND dedupe_key LIKE 'p-bulk-%'", [A])).toEqual([{ n: 0 }]);
    expect(await keysA(s)).toEqual(['p-keep']);
  }, 120_000);

  run('a payload naming tenant B purges nothing (not for A, not for B)', async (s) => {
    await seedPurge(s);
    await runTask(s, 'purge_alerts', { tenant_id: B }, A);
    expect((await keysA(s)).length).toBe(4);
    expect((await s.sql(B, "SELECT 1 FROM inventory.alerts WHERE tenant_id = $1 AND dedupe_key = 'p-b-expired'", [B])).length).toBe(1);
  });

  run('a USER actor deletes nothing: the DB function, a direct DELETE and the task all leave expired rows in place', async (s) => {
    await seedPurge(s);
    await s.as('user');
    expect((await s.client.query('SELECT app.purge_inventory_alerts() AS n')).rows[0].n).toBe(0);
    expect((await s.client.query("DELETE FROM inventory.alerts WHERE tenant_id = $1 AND dedupe_key LIKE 'p-%'", [A])).rowCount).toBe(0);
    await s.as('system');
    expect((await keysA(s)).length).toBe(4);
    const h = await loadTask('purge_alerts');
    await Promise.resolve(h({ tenant_id: A }, await jobCtx(s, A, 'user'))).catch(() => undefined);   // refusing (throw) or doing nothing are both fine; deleting is not
    await s.as('system');
    expect((await keysA(s)).length).toBe(4);
  });
});
