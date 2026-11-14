// C12.T-16 consumer contract: `lab.result.verified.v1` -> inventory consumption facts (02-TRD §8.1 steps 1-8 + table row, §8.2-8.4; PRD AC-12.1..12.7, AC-12.9; 07-SECURITY D-EVT, P-T6, LT-1).
// Real migrated DB as role lims_api (RLS on), REAL consumers.service / ledger from T-05 / T-15, no fakes except the JobContext. Harness: tests/db/c12-t16/run.sh (clone of c12-t15; exports
// LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL / LIMS_C12T03_REQUIRE_DB=1). Fixtures: tests/db/c12-t03/fixtures.sql + EXTRAS below (ids 17xxx, committed once with the superuser).
// Each test = one transaction that is ROLLED BACK (settings are changed INSIDE it). The race tests COMMIT and use their own rows (TRC world).
// LEAD DECISIONS: none of LD-140 applies (backend only).
// SEAMS pinned here (spec fixes behaviour, not names; the writer may dispute through the reviewer):
//   * services/worker/src/jobs/inventory/consumers/lab.result.verified.v1.ts exports `onResultVerified(event, ctx: JobContext)` (the TRD §9 name); ctx.tx = the one transaction, ctx.tenantId = tenant. `event` is the C0
//     envelope (payload under `.payload`, ids `event_id`, `idempotency_key`). The manifest `subscriptions['lab.result.verified.v1']` is that very function (no longer the T-01 stub).
//   * INBOX. The C0 wrapper core/consumer.ts `consumerRun` owns `inventory.event_inbox` (precedent: partners reporting.report.released.v1). The handler NEVER touches event_inbox (a second insert would conflict and the
//     handler would silently do nothing in production). TRD §8.1 step 1 is therefore satisfied by the wrapper; AC-12.4 "same event twice" is proved through the REAL `consumerRun` below.
//   * TENANT. The handler works for ctx.tenantId only (REQ-SEC-024); an envelope whose tenant_id differs from ctx.tenantId writes nothing in tenant A (P-T6) (it may reject or return).
//   * FACT COUNTERS. `tests_counted` +1 for every NEWLY inserted `test` fact whatever its status (posted / no_rule / unresolved) (AC-12.7: "test counts complete"). `verified_result_events` +1 for EVERY non-duplicate event
//     (D-73), also analyte events and re-verifications, also while consumption is off. Key = (business_date, instrument_id ?? NULL, test_id).
//   * Required payload fields it uses (result_id, order_item_id, test_id, analyte_id, department_id, verified_at) missing / malformed => the handler REJECTS before any write (the job retries / dead-letters).
//   * RESOLUTION: only steps 1 (binding), 5 (settings.default_consumption_store_id) and 6 (unresolved) are used (steps 2-4 sit behind LIMS_INVENTORY_RESOLUTION_STEPS, default 1,2,5 — T-15 impl note).
// Synthetic data only.
import '../../../../../../api/src/__tests__/setup-env.js';
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
const EVENT = 'lab.result.verified.v1';
const consumerUrl = new URL('../lab.result.verified.v1.ts', import.meta.url);
const manifestUrl = new URL('../../index.ts', import.meta.url).href;
const load = () => import(/* @vite-ignore */ consumerUrl.href) as Promise<{ onResultVerified: (e: unknown, c: unknown) => Promise<void> }>;

const A = '01a1a98a-ac40-7000-8000-00000000a001', B = '01a1a98a-ac40-7000-8000-00000000b001', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const BR1 = '01a1a98a-ac40-7000-8000-00000000a101', BR2 = '01a1a98a-ac40-7000-8000-00000000a102';
const CENTRE_BR1 = '01a1a98a-ac40-7000-8000-00000000a201';
const uid = (n: number) => `0190c514-0000-7000-8000-${String(n).padStart(12, '0')}`;
const KT = 'Asia/Kathmandu';
const V1 = '2026-11-13T19:00:00.000Z';            // = 2026-11-14 00:45 in Asia/Kathmandu (+05:45): business date 2026-11-14, UTC date 2026-11-13
const V1_BD = '2026-11-14';
const RULES_FROM = '2026-01-01T00:00:00.000Z', ENABLED = '2026-06-01T00:00:00.000Z';
const ymd = (daysAhead: number) => new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);

// ---- fixtures (tenant A)
const TG = uid(17001), TCBC = uid(17002), TN = uid(17003), TS = uid(17004), TL = uid(17005), TU = uid(17006), TI = uid(17009), TW = uid(17011), TRC = uid(17010);
const AG = uid(17121), ANI = uid(17122), ANX = uid(17123);                                  // opaque analyte ids (no FK)
const CBC_AN = Array.from({ length: 20 }, (_, i) => uid(17101 + i));
const RC_AN = Array.from({ length: 20 }, (_, i) => uid(17301 + i));
const I1 = uid(17201), I2 = uid(17202), I3 = uid(17203);
const S1 = uid(17301 + 100), S3 = uid(17302 + 100), SD = uid(17303 + 100);
const IGLU = uid(17401), IC1 = uid(17402), IA = uid(17403), IS = uid(17404), IL = uid(17405), ITRC = uid(17406), ITRA = uid(17407);
const LL1 = uid(17501), LL2 = uid(17502);
const DEPT = uid(17601), BR_OPAQUE = BR1;
const ruleId = (n: number) => uid(17700 + n);

const J = (o: unknown) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const I = (table: string, o: Record<string, unknown>) => `SELECT pg_temp.t16_ins('${table}', ${J(o)});`;
const tid = { tenant_id: A };
const store = (n: number, branch: string, code: string, kind: string, def: boolean) => I('inventory.stores', { id: uid(n), ...tid, branch_id: branch, store_code: code, name: `Store ${code}`, store_kind: kind, is_default_consumption: def, is_active: true });
const item = (n: number, code: string, cat: string, uom: string, lt: boolean) => I('inventory.items', { id: uid(n), ...tid, item_code: code, name: `Item ${code}`, category: cat, base_uom_code: uom, is_lot_tracked: lt, requires_expiry: lt, is_active: true });
const bal = (n: number, s: string, i: string, lot: string | null, q: number, v: number) => I('inventory.stock_balances', { id: uid(n), ...tid, store_id: s, item_id: i, lot_id: lot, qty_base: q, value_paisa: v, last_movement_at: new Date().toISOString() });
const inst = (n: number, code: string) => I('instruments.instruments', { id: uid(n), ...tid, centre_id: CENTRE_BR1, agent_id: uid(n + 1000), instrument_code: code, display_name: `Instrument ${code}`, vendor: 'Synthetic', model: 'SX-1', protocol: 'astm',
  driver_code: 'astm_generic_e1394', transport: { kind: 'tcp_client' }, timezone: KT, state: 'draft' });
let ruleSeq = 0;
const rule = (kind: string, testId: string, itemId: string, qty: number, o: Record<string, unknown> = {}) => I('inventory.consumption_rules', { id: ruleId(++ruleSeq), ...tid, rule_kind: kind, test_id: testId, item_id: itemId, qty_base: qty, entered_qty: qty, effective_from: RULES_FROM, ...o });
const EXTRAS = `
BEGIN;
SET search_path = extensions, public, pg_catalog;
SET LOCAL session_replication_role = replica;
CREATE OR REPLACE FUNCTION pg_temp.t16_sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '${SYS}'::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.t16_ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r jsonb := p_row; a text; cols text;
BEGIN
  IF r ? 'tenant_id' THEN PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', r->>'tenant_id', 'sub', pg_temp.t16_sys(), 'actor_type', 'system')::text, true); END IF;
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.t16_sys()); END IF;
  END LOOP;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb) ON CONFLICT DO NOTHING', p_tbl, cols, r::text);
END $f$;
SELECT set_config('request.jwt.claims', '{"tenant_id":"${A}","sub":"${SYS}","actor_type":"system"}', true);
${[TG, TCBC, TN, TS, TL, TU, TI, TW, TRC].map((t) => I('catalog.tests', { id: t, ...tid, workflow_type: 'standard' })).join('\n')}
${inst(17201, 'T16-I1')}
${inst(17202, 'T16-I2')}
${inst(17203, 'T16-I3')}
${store(17401, BR1, 'T16-S1', 'main', false)}
${store(17402, BR1, 'T16-S3', 'bench', false)}
${store(17403, BR2, 'T16-SD', 'main', true)}
${item(17401, 'T16-GLU', 'consumable', 'piece', false)}${item(17402, 'T16-C1', 'consumable', 'piece', false)}${item(17403, 'T16-A', 'consumable', 'piece', false)}
${item(17404, 'T16-S', 'consumable', 'piece', false)}${item(17405, 'T16-L', 'reagent', 'test', true)}${item(17406, 'T16-RC', 'consumable', 'piece', false)}${item(17407, 'T16-RA', 'consumable', 'piece', false)}
${I('inventory.lots', { id: LL1, ...tid, item_id: IL, lot_no: 'T16-LL1', expiry_on: ymd(30), status: 'available' })}
${I('inventory.lots', { id: LL2, ...tid, item_id: IL, lot_no: 'T16-LL2', expiry_on: ymd(90), status: 'available' })}
${[[1, S1, IGLU, null, 1000, 10000], [2, S1, IC1, null, 1000, 10000], [3, S1, IA, null, 1000, 10000], [4, S1, IS, null, 1000, 10000], [5, S1, IL, LL1, 50, 5000], [6, S1, IL, LL2, 50, 5000],
  [7, S1, ITRC, null, 1000, 10000], [8, S1, ITRA, null, 1000, 10000], [9, S3, IGLU, null, 1000, 10000], [10, SD, IGLU, null, 1000, 10000]]
  .map(([n, s, i, l, q, v]) => bal(17800 + (n as number), s as string, i as string, l as string | null, q as number, v as number)).join('')}
${I('inventory.instrument_bindings', { id: uid(17901), ...tid, instrument_id: I1, store_id: S1, is_active: true })}
${I('inventory.instrument_bindings', { id: uid(17902), ...tid, instrument_id: I2, store_id: S1, is_active: true })}
${I('inventory.opened_containers', { id: uid(17903), ...tid, store_id: S1, item_id: IL, lot_id: LL2, instrument_id: I1, opened_at: '2026-10-01T00:00:00.000Z', opened_by: SYS, status: 'open' })}
${rule('per_test', TG, IGLU, 1, { instrument_id: I1 })}
${rule('per_test', TCBC, IC1, 1)}
${CBC_AN.map((a) => rule('per_analyte', TCBC, IA, 1, { analyte_id: a })).join('\n')}
${rule('per_test', TS, IS, 1)}
${rule('per_test', TS, IS, 3, { instrument_id: I1 })}
${rule('per_test', TL, IL, 1)}
${rule('per_test', TU, IGLU, 1)}
${rule('per_test', TI, IGLU, 1)}
${rule('per_analyte', TI, IA, 2, { analyte_id: ANI })}
${rule('per_test', TW, IGLU, 1, { effective_from: '2026-12-01T00:00:00.000Z' })}
${rule('per_test', TRC, ITRC, 1)}
${RC_AN.map((a) => rule('per_analyte', TRC, ITRA, 1, { analyte_id: a })).join('\n')}
COMMIT;`;

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

describe('T-16 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => { if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true); });
});

// ---------------------------------------------------------------------------------------------------------- session + job context
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
      const c: any = { tenantId: tenant, actor: { type: 'system', id: SYS }, requestId: 'r-t16', tx, now: () => new Date().toISOString(), attempt: 1, maxAttempts: 10, jobId: 'job-t16', isNewer: () => true,
        core: createCoreRepo({ withTenantScope: async (_t: unknown, _tenant: unknown, _actor: unknown, fn: () => unknown) => fn(), systemActorOf: () => SYS } as any),
        ports: { IdentityPort: { async getTenantSettings() { return { timezone: KT }; } } }, events: {}, storage: {}, files: {}, audit: {},
        metrics: { inc() {}, set() {}, observe() {} }, log: { info: keep, warn: keep, error: keep, debug: keep, child() { return this; } } };
      c.db = { async tx(fn: (x: unknown) => Promise<unknown>) { const name = `t16_sp_${++sp}`; await tx.query(`SAVEPOINT ${name}`); try { const r = await fn(c); await tx.query(`RELEASE SAVEPOINT ${name}`); return r; } catch (e) { await tx.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; } } };
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
let evSeq = 100;
const payload = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  result_id: uid(20000 + ++evSeq), result_version_no: 1, order_id: uid(21000 + evSeq), order_item_id: uid(22000 + evSeq), specimen_id: uid(23000 + evSeq), test_id: TG, analyte_id: AG, department_id: DEPT,
  instrument_id: I1, origin: 'instrument', mode: 'manual', verified_at: V1, verified_by_membership_id: uid(24000), processing_branch_id: BR_OPAQUE, ...o });
const envelope = (p: Record<string, unknown>, o: Record<string, unknown> = {}) => ({
  event_id: uid(25000 + ++evSeq), event_type: EVENT, tenant_id: A, occurred_at: String(p['verified_at'] ?? V1), actor: { type: 'system', id: SYS }, idempotency_key: `${p['result_id']}:verified:${p['result_version_no'] ?? 1}:${evSeq}`,
  producer: 'lab', aggregate: { type: 'result', id: p['result_id'], seq: 1 }, request_id: uid(26000 + evSeq), payload: p, ...o });
const deliver = async (s: Sess, e: unknown, tenant = A) => (await load()).onResultVerified(e, await s.ctx(tenant));
const ev = (s: Sess, o: Record<string, unknown> = {}) => { const e = envelope(payload(o)); return deliver(s, e).then(() => e); };

// ---------------------------------------------------------------------------------------------------------- db helpers
const n = (v: unknown) => Number(v);
const enable = (s: Sess, at: string | null) => s.sql('UPDATE inventory.settings SET consumption_enabled_at = $2 WHERE tenant_id = $1', [A, at]);
const setDefault = (s: Sess, st: string | null) => s.sql('UPDATE inventory.settings SET default_consumption_store_id = $2 WHERE tenant_id = $1', [A, st]);
const factsOf = (s: Sess, like: string) => s.sql('SELECT *, occurred_at AT TIME ZONE \'UTC\' AS occ_utc, business_date::text AS bd FROM inventory.consumption_facts WHERE tenant_id = $1 AND basis_key LIKE $2 ORDER BY basis_key', [A, like]);
const movesOf = (s: Sess, factId: string) => s.sql(`SELECT movement_kind AS kind, store_id, item_id, lot_id, qty_base::text AS q, value_paisa::text AS v, instrument_id, attributed_test_id, rule_id, business_date::text AS bd, occurred_at, doc_type, doc_id
  FROM inventory.stock_movements WHERE tenant_id = $1 AND doc_type = 'consumption_fact' AND doc_id = $2 ORDER BY created_at, qty_base`, [A, factId]);
const movesForTest = (s: Sess, test: string, from: string, kind?: string) => s.sql(`SELECT movement_kind AS kind, qty_base::text AS q, lot_id, store_id, item_id FROM inventory.stock_movements WHERE tenant_id = $1 AND attributed_test_id = $2 AND created_at >= $3::timestamptz
  AND ($4::text IS NULL OR movement_kind = $4) ORDER BY created_at`, [A, test, from, kind ?? null]);
const balance = async (s: Sess, store: string, itemId: string, lot: string | null) => {
  const r = (await s.sql('SELECT qty_base::text AS q FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id IS NOT DISTINCT FROM $4::uuid', [A, store, itemId, lot]))[0];
  return r ? n(r.q) : 0;
};
const counts = async (s: Sess, test: string, instrument: string | null, bd = V1_BD) => (await s.sql(`SELECT tests_counted, verified_result_events, rerun_events, qc_events FROM inventory.test_counts_daily WHERE tenant_id = $1 AND business_date = $2 AND test_id = $3
  AND instrument_id IS NOT DISTINCT FROM $4::uuid`, [A, bd, test, instrument]))[0];
const count = async (s: Sess, table: string, where = 'true', v: unknown[] = []) => n((await s.sql(`SELECT count(*) AS n FROM inventory.${table} WHERE tenant_id = $1 AND ${where}`, [A, ...v]))[0].n);
const snapshot = async (s: Sess) => JSON.stringify([await count(s, 'consumption_facts'), await count(s, 'stock_movements'), await count(s, 'test_counts_daily'), await count(s, 'alerts'),
  await s.sql('SELECT id, qty_base, value_paisa, version FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [A]), await s.sql('SELECT test_id, tests_counted, verified_result_events FROM inventory.test_counts_daily WHERE tenant_id = $1 ORDER BY id', [A])]);
const startedAt = (s: Sess) => s.sql('SELECT now()::text AS t').then((r) => r[0].t as string);
const rejected = async (p: Promise<unknown>) => { p.catch(() => undefined); await load(); /* a missing module must FAIL the test, not count as a rejection */ try { await p; } catch (e) { return e as any; } return undefined; };

// ========================================================================================================== wiring + data minimisation (no DB needed)
describe('T-16 wiring and data minimisation', () => {
  it('the consumer file exports onResultVerified and the manifest subscribes THAT function (not the T-01 stub)', async () => {
    const mod = await load(); const manifest = ((await import(/* @vite-ignore */ manifestUrl)) as any).manifest;
    expect(typeof mod.onResultVerified).toBe('function'); expect(manifest.subscriptions[EVENT]).toBe(mod.onResultVerified);
  });
  it('D-EVT: the source never names P2/P3 fields or fields C12 does not use (specimen_id, verified_by_membership_id) and never touches event_inbox (the C0 wrapper owns it)', () => {
    const src = readFileSync(consumerUrl, 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    for (const f of ['sample_barcode', 'value_raw', 'value_numeric', 'unit_raw', 'instrument_flags', 'control_id_raw', 'control_lot_raw', 'control_level', 'specimen_id', 'verified_by_membership_id', 'event_inbox']) expect(src, f).not.toContain(f);
    for (const f of ['order_item_id', 'result_id', 'test_id', 'analyte_id', 'department_id', 'verified_at']) expect(src, f).toContain(f);
  });
});

// ========================================================================================================== AC-12.1 + TRD §8.1 steps
describe.skipIf(!live)('T-16 AC-12.1 per-test consumption (IC §3.9 example payload)', () => {
  run('rule (per_test, GLU, I1, item, 1) + I1 bound to S1 + switch on: ONE consume_test movement of -1 in S1, attributed to the test and instrument; the fact carries the event facts; counters written', async (s) => {
    await enable(s, ENABLED); const t0 = await startedAt(s); const before = await balance(s, S1, IGLU, null);
    const p = payload(); const e = envelope(p); await deliver(s, e);
    const [f, ...rest] = await factsOf(s, `%${p['order_item_id']}%`); expect(rest).toEqual([]);
    expect(f).toMatchObject({ basis_key: `test:${p['order_item_id']}:${TG}`, fact_kind: 'test', source: 'event', source_event_id: e.event_id, source_event_type: EVENT, instrument_id: I1, test_id: TG, department_id: DEPT,
      processing_branch_id: BR_OPAQUE, status: 'posted', store_id: S1, rules_applied: 1, multiplier: 1, bd: V1_BD });
    expect(new Date(f.occurred_at).toISOString()).toBe(V1);
    const ms = await movesOf(s, f.id); expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: 'consume_test', store_id: S1, item_id: IGLU, instrument_id: I1, attributed_test_id: TG, rule_id: ruleId(1), bd: V1_BD, doc_type: 'consumption_fact', doc_id: f.id });
    expect(n(ms[0].q)).toBe(-1); expect(new Date(ms[0].occurred_at).toISOString()).toBe(V1);
    expect(n(f.value_paisa_total)).toBe(n(ms[0].v)); expect(await balance(s, S1, IGLU, null)).toBe(before - 1);
    expect(await movesForTest(s, TG, t0)).toHaveLength(1);
    expect(await counts(s, TG, I1)).toMatchObject({ tests_counted: 1, verified_result_events: 1, rerun_events: 0, qc_events: 0 });
  });
  run('business date = the occurrence time in the TENANT timezone (UTC 17:59:59 -> 23:44:59 same day, UTC 18:15:00 -> next day)', async (s) => {
    await enable(s, ENABLED);
    const a = payload({ verified_at: '2026-11-13T18:14:59.000Z' }), b = payload({ verified_at: '2026-11-13T18:15:00.000Z' });
    await deliver(s, envelope(a)); await deliver(s, envelope(b));
    expect((await factsOf(s, `%${a['order_item_id']}%`))[0].bd).toBe('2026-11-13'); expect((await factsOf(s, `%${b['order_item_id']}%`))[0].bd).toBe('2026-11-14');
    expect(await counts(s, TG, I1, '2026-11-13')).toMatchObject({ verified_result_events: 1 }); expect((await counts(s, TG, I1, '2026-11-14'))).toMatchObject({ verified_result_events: 1 });
  });
  run('the fact is INSERTed with its FINAL status (no UPDATE of status), ON CONFLICT DO NOTHING on (tenant, basis_key); only a same-status value_paisa_total UPDATE follows; counters are upserts', async (s) => {
    await enable(s, ENABLED); s.log.length = 0; await ev(s);
    const ins = s.log.filter((t) => /INSERT\s+INTO\s+inventory\.consumption_facts/i.test(t)); expect(ins).toHaveLength(1); expect(ins[0]).toMatch(/ON\s+CONFLICT[\s\S]*DO\s+NOTHING[\s\S]*RETURNING/i);
    for (const u of s.log.filter((t) => /UPDATE\s+inventory\.consumption_facts/i.test(t))) expect((/SET([\s\S]*?)(WHERE|$)/i.exec(u) ?? [])[1] ?? '').not.toMatch(/\bstatus\b/i);
    expect(s.log.some((t) => /INSERT\s+INTO\s+inventory\.test_counts_daily[\s\S]*ON\s+CONFLICT[\s\S]*DO\s+UPDATE/i.test(t))).toBe(true);
    expect(s.log.some((t) => /event_inbox/i.test(t))).toBe(false);
  });
  run('extra fields (sample_barcode, value_numeric, specimen_id, unknown) are tolerated, never stored and never logged (LT-1)', async (s) => {
    await enable(s, ENABLED); const p = payload({ sample_barcode: 'SYN-BARCODE-9917', value_numeric: 5.5, value_raw: '5.5 SYN-RAW', unit_raw: 'mmol/L', instrument_flags: 'SYN-FLAG', unknown_future_field: { x: 1 } });
    await deliver(s, envelope(p));
    const rows = await s.sql("SELECT row_to_json(f)::text AS j FROM inventory.consumption_facts f WHERE tenant_id = $1 AND basis_key LIKE $2", [A, `%${p['order_item_id']}%`]);
    expect(rows).toHaveLength(1); for (const x of ['SYN-BARCODE-9917', 'SYN-RAW', 'SYN-FLAG', 'mmol']) { expect(rows[0].j).not.toContain(x); expect(s.logs.join('\n')).not.toContain(x); }
  });
  run('absent optional fields (no instrument_id, no processing_branch_id, no specimen_id, mode auto without verified_by) are tolerated: only store resolution changes (default store step 5)', async (s) => {
    await enable(s, ENABLED); await setDefault(s, S3);
    const { instrument_id: _i, processing_branch_id: _b, specimen_id: _s, verified_by_membership_id: _v, ...base } = payload({ test_id: TU, mode: 'auto', origin: 'calculated' });
    await deliver(s, envelope(base));
    const [f] = await factsOf(s, `%${base['order_item_id']}%`);
    expect(f).toMatchObject({ status: 'posted', store_id: S3, instrument_id: null, processing_branch_id: null, rules_applied: 1 });
    const ms = await movesOf(s, f.id); expect(ms).toHaveLength(1); expect(ms[0]).toMatchObject({ kind: 'consume_test', store_id: S3, item_id: IGLU, instrument_id: null, attributed_test_id: TU });
    expect(await counts(s, TU, null)).toMatchObject({ tests_counted: 1, verified_result_events: 1 });
  });
  it.each([['test_id'], ['order_item_id'], ['result_id'], ['verified_at']])('a missing required field (%s) rejects BEFORE any write (the job retries / dead-letters)', (field) => session(async (s) => {
    await enable(s, ENABLED); const before = await snapshot(s); const p: Record<string, unknown> = payload(); delete p[field];
    expect(await rejected(deliver(s, envelope(p)))).toBeDefined(); expect(await snapshot(s)).toBe(before);
  }));
  run('a malformed verified_at rejects before any write', async (s) => {
    await enable(s, ENABLED); const before = await snapshot(s);
    expect(await rejected(deliver(s, envelope(payload({ verified_at: 'not-a-date' }))))).toBeDefined(); expect(await snapshot(s)).toBe(before);
  });
  run('P-T6: an envelope of tenant B delivered to tenant A\'s context writes nothing in tenant A', async (s) => {
    await enable(s, ENABLED); const before = await snapshot(s); await rejected(deliver(s, envelope(payload(), { tenant_id: B }))); expect(await snapshot(s)).toBe(before);
  });
});

// ========================================================================================================== AC-12.2 facts (a)/(b)
describe.skipIf(!live)('T-16 AC-12.2 facts (a) test and (b) analyte are independent', () => {
  const cbcEvents = (orderItem: string) => CBC_AN.map((a) => envelope(payload({ test_id: TCBC, analyte_id: a, instrument_id: I1, order_item_id: orderItem })));
  run('CBC, 20 analyte events, a per_analyte rule on every analyte: 20 consume_analyte + 1 consume_test; per-test rules deduct ONCE per (order item, test)', async (s) => {
    await enable(s, ENABLED); const t0 = await startedAt(s); const oi = uid(29001); const c1 = await balance(s, S1, IC1, null), a1 = await balance(s, S1, IA, null);
    for (const e of cbcEvents(oi)) await deliver(s, e);
    const ms = await movesForTest(s, TCBC, t0); expect(ms.filter((m) => m.kind === 'consume_test')).toHaveLength(1); expect(ms.filter((m) => m.kind === 'consume_analyte')).toHaveLength(20); expect(ms).toHaveLength(21);
    expect(await factsOf(s, `test:${oi}:%`)).toHaveLength(1); const an = await factsOf(s, 'analyte:%'); expect(an.filter((f: any) => f.test_id === TCBC && f.status === 'posted' && f.fact_kind === 'analyte').length).toBeGreaterThanOrEqual(20);
    expect(await balance(s, S1, IC1, null)).toBe(c1 - 1); expect(await balance(s, S1, IA, null)).toBe(a1 - 20);
    expect(await counts(s, TCBC, I1)).toMatchObject({ tests_counted: 1, verified_result_events: 20 });
  });
  run('the arrival order does not matter: the analyte events in REVERSE order give the same 20 + 1', async (s) => {
    await enable(s, ENABLED); const t0 = await startedAt(s); const oi = uid(29002);
    for (const e of cbcEvents(oi).reverse()) await deliver(s, e);
    const ms = await movesForTest(s, TCBC, t0); expect(ms.filter((m) => m.kind === 'consume_test')).toHaveLength(1); expect(ms.filter((m) => m.kind === 'consume_analyte')).toHaveLength(20);
  });
  run('fact (b) is attempted although fact (a) already exists: second analyte event of the same order item inserts ONLY the analyte fact (+1 consume_analyte, no second consume_test)', async (s) => {
    await enable(s, ENABLED); const oi = uid(29003); const p1 = payload({ test_id: TI, analyte_id: ANX, order_item_id: oi }), p2 = payload({ test_id: TI, analyte_id: ANI, order_item_id: oi });
    await deliver(s, envelope(p1)); const t0 = await startedAt(s); await deliver(s, envelope(p2));
    // now() is the transaction start, so t0 also covers p1's consume_test: assert on the movements of both events (1 consume_test from p1 only, +1 consume_analyte from p2)
    const all = await movesForTest(s, TI, t0); expect(all.filter((m) => m.kind === 'consume_test')).toHaveLength(1); const ms = all.filter((m) => m.kind === 'consume_analyte'); expect(all).toHaveLength(2);
    expect(ms).toHaveLength(1); expect(ms[0]).toMatchObject({ kind: 'consume_analyte', item_id: IA }); expect(n(ms[0].q)).toBe(-2);
    expect(await factsOf(s, `test:${oi}:%`)).toHaveLength(1); expect(await factsOf(s, `analyte:${p2['result_id']}`)).toHaveLength(1); expect(await factsOf(s, `analyte:${p1['result_id']}`)).toHaveLength(0);
    expect(await counts(s, TI, I1)).toMatchObject({ tests_counted: 1, verified_result_events: 2 });
  });
  run('analyte event with no per_analyte rule for (test, analyte): no analyte fact; the event counter still counts it', async (s) => {
    await enable(s, ENABLED); const oi = uid(29004);
    await deliver(s, envelope(payload({ test_id: TI, analyte_id: ANX, order_item_id: oi }))); await deliver(s, envelope(payload({ test_id: TI, analyte_id: ANX, order_item_id: oi })));
    expect(await count(s, 'consumption_facts', "fact_kind = 'analyte' AND test_id = $2 AND occurred_at = $3::timestamptz AND analyte_id = $4", [TI, V1, ANX])).toBe(0);
    expect(await counts(s, TI, I1)).toMatchObject({ tests_counted: 1, verified_result_events: 2 });
  });
});

// ========================================================================================================== AC-12.3 lot choice
describe.skipIf(!live)('T-16 AC-12.3 in-use lot, else FEFO', () => {
  run('open container of LL2 on I1 for the item: consumption is taken from LL2 although LL1 expires earlier', async (s) => {
    await enable(s, ENABLED); const l1 = await balance(s, S1, IL, LL1), l2 = await balance(s, S1, IL, LL2);
    const p = payload({ test_id: TL, instrument_id: I1 }); await deliver(s, envelope(p));
    const [f] = await factsOf(s, `%${p['order_item_id']}%`); const ms = await movesOf(s, f.id); expect(ms).toHaveLength(1); expect(ms[0]).toMatchObject({ kind: 'consume_test', lot_id: LL2 });
    expect(await balance(s, S1, IL, LL2)).toBe(l2 - 1); expect(await balance(s, S1, IL, LL1)).toBe(l1);
  });
  run('no open container for the instrument (I2): the FEFO lot (LL1, earliest expiry) is used', async (s) => {
    await enable(s, ENABLED); const l1 = await balance(s, S1, IL, LL1);
    // ruling: FEFO key 1 = has_open_container of the lot in the store (any instrument, TRD 4.4); close the fixture's open LL2 container so LL1 is the FEFO lot
    await s.sql("UPDATE inventory.opened_containers SET status = 'finished', finished_at = now(), finished_by = $2 WHERE tenant_id = $1 AND id = $3", [A, SYS, uid(17903)]);
    const p = payload({ test_id: TL, instrument_id: I2 }); await deliver(s, envelope(p));
    const [f] = await factsOf(s, `%${p['order_item_id']}%`); const ms = await movesOf(s, f.id); expect(ms).toHaveLength(1); expect(ms[0]).toMatchObject({ lot_id: LL1 }); expect(await balance(s, S1, IL, LL1)).toBe(l1 - 1);
  });
});

// ========================================================================================================== AC-12.4 duplicates
describe.skipIf(!live)('T-16 IT-4 AC-12.4 duplicate delivery (same event_id) and re-verification (same basis key) cause no change', () => {
  run('a LATER re-verification of the same result (new event id, result_version_no 2) never deducts twice; the event counter counts both verifications (D-73)', async (s) => {
    await enable(s, ENABLED); const t0 = await startedAt(s); const p = payload({ test_id: TI, analyte_id: ANI });
    await deliver(s, envelope(p)); await deliver(s, envelope({ ...p, result_version_no: 2 })); await deliver(s, envelope({ ...p, result_version_no: 3, verified_at: '2026-11-13T20:00:00.000Z' }));
    const ms = await movesForTest(s, TI, t0); expect(ms.filter((m) => m.kind === 'consume_test')).toHaveLength(1); expect(ms.filter((m) => m.kind === 'consume_analyte')).toHaveLength(1);
    expect(await factsOf(s, `test:${p['order_item_id']}:%`)).toHaveLength(1); expect(await factsOf(s, `analyte:${p['result_id']}`)).toHaveLength(1);
    expect(await counts(s, TI, I1)).toMatchObject({ tests_counted: 1, verified_result_events: 3 });
  });
  describe('through the REAL C0 wrapper core/consumer.ts consumerRun (inbox + core.event_log + envelope validation)', () => {
    async function consume(e: any) {
      const { consumerRun } = await import('../../../../core/consumer.js'); const { createCoreRepo } = await import('../../../../../../api/src/core/core-repo/index.js');
      const deps: any = { db: { async tx(_i: unknown, fn: (t: unknown) => Promise<unknown>) {
          const c = await api.connect();
          try { await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]); const r = await fn({ query: (t: string, v?: unknown[]) => c.query(t, v) }); await c.query('COMMIT'); return r; }
          catch (x) { await c.query('ROLLBACK').catch(() => undefined); throw x; } finally { c.release(); } } },
        systemActorOf: () => SYS, coreActorId: SYS, withTenantScope: async (_t: unknown, _x: unknown, _y: unknown, fn: () => unknown) => fn(), metrics: { inc() {}, set() {}, observe() {} },
        log: { child() { return this; }, info() {}, warn() {}, error() {} }, now: () => new Date(), events: {}, storage: {}, files: {}, audit: {},
        core: createCoreRepo({ withTenantScope: async (_t: unknown, _x: unknown, _y: unknown, fn: () => unknown) => fn(), systemActorOf: () => SYS } as any) };
      const mod = await load();
      return consumerRun(deps, { module: 'inventory', identifier: `evt.inventory.${EVENT}`, kind: 'consumer', scope: 'per_tenant', maxAttempts: 10 }, EVENT, mod.onResultVerified as any)(
        { tenant_id: A, event_id: e.event_id }, { id: '1', attempts: 1, max_attempts: 10 } as any);
    }
    const seedLog = (e: any) => admin.query(`INSERT INTO core.event_log (tenant_id, event_id, event_type, producer, idempotency_key, aggregate_type, aggregate_id, aggregate_seq, occurred_at, envelope, created_by)
      VALUES ($1, $2, $3, 'lab', $4, 'result', $5, 1, $6, $7::jsonb, $8)`, [A, e.event_id, EVENT, e.idempotency_key, e.payload.result_id, e.occurred_at, JSON.stringify(e), SYS]);
    const adminCount = async (sql: string, v: unknown[]) => n((await admin.query(sql, v)).rows[0].n);

    it('the same event delivered twice, and twice at once: one fact, one movement, one inbox row, the event counter once', async () => {
      await admin.query('UPDATE inventory.settings SET consumption_enabled_at = $2 WHERE tenant_id = $1', [A, ENABLED]);
      const e = envelope(payload({ test_id: TI, analyte_id: ANX, verified_at: '2026-11-12T10:00:00.000Z' })); await seedLog(e); const bd = '2026-11-12';
      const c0 = await adminCount('SELECT coalesce(max(verified_result_events), 0) AS n FROM inventory.test_counts_daily WHERE tenant_id = $1 AND business_date = $2 AND test_id = $3 AND instrument_id = $4', [A, bd, TI, I1]);
      await Promise.all([consume(e), consume(e)]); await consume(e);
      expect(await adminCount('SELECT count(*) AS n FROM inventory.consumption_facts WHERE tenant_id = $1 AND source_event_id = $2', [A, e.event_id])).toBe(1);
      expect(await adminCount("SELECT count(*) AS n FROM inventory.stock_movements m JOIN inventory.consumption_facts f ON f.id = m.doc_id WHERE m.tenant_id = $1 AND f.source_event_id = $2", [A, e.event_id])).toBe(1);
      expect(await adminCount('SELECT count(*) AS n FROM inventory.event_inbox WHERE tenant_id = $1 AND event_id = $2', [A, e.event_id])).toBe(1);
      expect(await adminCount('SELECT verified_result_events AS n FROM inventory.test_counts_daily WHERE tenant_id = $1 AND business_date = $2 AND test_id = $3 AND instrument_id = $4', [A, bd, TI, I1])).toBe(c0 + 1);
    });
    it('a handler failure rolls the inbox row back with it (the retry re-processes); an envelope that violates its schema is rejected', async () => {
      const bad = envelope({ ...payload(), test_id: 'not-a-uuid' }); await seedLog(bad);
      expect(await rejected(consume(bad))).toBeDefined();
      expect(await adminCount('SELECT count(*) AS n FROM inventory.event_inbox WHERE tenant_id = $1 AND event_id = $2', [A, bad.event_id])).toBe(0);
    });
  });
});

// ========================================================================================================== AC-12.5 switch + event counter (D-73)
describe.skipIf(!live)('T-16 AC-12.5 consumption switch; event counter while off (D-73)', () => {
  const nothingButCounter = async (s: Sess, p: Record<string, unknown>, expectedEvents: number, test = TG, instrument: string | null = I1) => {
    expect(await factsOf(s, `%${p['order_item_id']}%`)).toEqual([]); expect(await count(s, 'stock_movements', 'attributed_test_id = $2 AND occurred_at = $3::timestamptz', [test, p['verified_at']])).toBe(0);
    expect(await count(s, 'alerts', "alert_kind = 'unresolved_consumption'")).toBe(0);
    expect(await counts(s, test, instrument, V1_BD)).toMatchObject({ tests_counted: 0, verified_result_events: expectedEvents });
  };
  run('consumption_enabled_at NULL: no fact, no movement, no fact-level counter - but the event counter row is created on first use and counts every event (re-verifications too)', async (s) => {
    await enable(s, null); const p = payload(); await deliver(s, envelope(p)); await nothingButCounter(s, p, 1);
    await deliver(s, envelope({ ...p, result_version_no: 2 })); await nothingButCounter(s, p, 2);
    await deliver(s, envelope(payload())); await nothingButCounter(s, p, 3);
  });
  run('verified_at < consumption_enabled_at: ignored (counter only); verified_at == consumption_enabled_at: processed (the enable instant is exact)', async (s) => {
    await enable(s, V1); const before = payload({ verified_at: '2026-11-13T18:59:59.999Z' }); await deliver(s, envelope(before));
    expect(await factsOf(s, `%${before['order_item_id']}%`)).toEqual([]); expect(await counts(s, TG, I1, V1_BD)).toMatchObject({ tests_counted: 0, verified_result_events: 1 });
    const at = payload({ verified_at: V1 }); await deliver(s, envelope(at)); const [f] = await factsOf(s, `%${at['order_item_id']}%`); expect(f).toMatchObject({ status: 'posted' }); expect(await movesOf(s, f.id)).toHaveLength(1);
  });
  run('enabling takes effect instantly for the NEXT event; events skipped earlier are never back-filled', async (s) => {
    await enable(s, null); const early = payload(); await deliver(s, envelope(early));
    await enable(s, ENABLED); const late = payload(); await deliver(s, envelope(late));
    expect(await factsOf(s, `%${early['order_item_id']}%`)).toEqual([]); expect(await factsOf(s, `%${late['order_item_id']}%`)).toHaveLength(1);
    expect(await counts(s, TG, I1)).toMatchObject({ tests_counted: 1, verified_result_events: 2 });
  });
  run('a skipped event in the future of the enable instant for a test with NO rule is still just a counter write while off (no no_rule fact)', async (s) => {
    await enable(s, null); const p = payload({ test_id: TN, instrument_id: null }); await deliver(s, envelope(p)); await nothingButCounter(s, p, 1, TN, null);
  });
});

// ========================================================================================================== AC-12.6 instrument-specific rule wins
describe.skipIf(!live)('T-16 AC-12.6 instrument-specific rule overrides the generic rule', () => {
  run('event from I1 (specific rule qty 3): only the specific rule; event from I2 (other instrument): the generic rule (qty 1); no instrument: generic only', async (s) => {
    await enable(s, ENABLED); await setDefault(s, S1); const t0 = await startedAt(s);
    const p1 = payload({ test_id: TS, instrument_id: I1 }), p2 = payload({ test_id: TS, instrument_id: I2 }); const { instrument_id: _x, ...p3 } = payload({ test_id: TS });
    for (const p of [p1, p2, p3]) await deliver(s, envelope(p));
    const q = async (p: Record<string, unknown>) => { const [f] = await factsOf(s, `%${p['order_item_id']}%`); const ms = await movesOf(s, f.id); return { rules: f.rules_applied, ms }; };
    const r1 = await q(p1), r2 = await q(p2), r3 = await q(p3);
    expect(r1.rules).toBe(1); expect(r1.ms).toHaveLength(1); expect(n(r1.ms[0].q)).toBe(-3); expect(r1.ms[0].rule_id).toBe(ruleId(1 + 1 + 20 + 2));
    for (const r of [r2, r3]) { expect(r.rules).toBe(1); expect(r.ms).toHaveLength(1); expect(n(r.ms[0].q)).toBe(-1); }
    expect((await movesForTest(s, TS, t0)).length).toBe(3);
  });
});

// ========================================================================================================== AC-12.7 no rule
describe.skipIf(!live)('T-16 AC-12.7 no rule: a no_rule test fact is still recorded', () => {
  run('no rule for the test: fact test/no_rule, no store, no movement, no alert; tests_counted and verified_result_events both 1; the analyte fact is not attempted', async (s) => {
    await enable(s, ENABLED); const p = payload({ test_id: TN }); await deliver(s, envelope(p));
    const fs = await factsOf(s, `%${p['order_item_id']}%`); expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ fact_kind: 'test', status: 'no_rule', store_id: null, rules_applied: 0, value_paisa_total: '0', source: 'event' }); expect(await movesOf(s, fs[0].id)).toEqual([]);
    expect(await count(s, 'alerts', "alert_kind = 'unresolved_consumption'")).toBe(0); expect(await counts(s, TN, I1)).toMatchObject({ tests_counted: 1, verified_result_events: 1 });
  });
  run('a rule that starts AFTER the occurrence time (rules are not retroactive, §8.3) gives no_rule; no store is needed so no unresolved alert', async (s) => {
    await enable(s, ENABLED); const p = payload({ test_id: TW }); await deliver(s, envelope(p));
    expect((await factsOf(s, `%${p['order_item_id']}%`))[0]).toMatchObject({ status: 'no_rule', rules_applied: 0 }); expect(await count(s, 'alerts', "alert_kind = 'unresolved_consumption'")).toBe(0);
  });
  run('re-verification of a no_rule result adds no second fact but counts as an event', async (s) => {
    await enable(s, ENABLED); const p = payload({ test_id: TN }); await deliver(s, envelope(p)); await deliver(s, envelope({ ...p, result_version_no: 2 }));
    expect(await factsOf(s, `%${p['order_item_id']}%`)).toHaveLength(1); expect(await counts(s, TN, I1)).toMatchObject({ tests_counted: 1, verified_result_events: 2 });
  });
});

// ========================================================================================================== AC-12.9 unresolved
describe.skipIf(!live)('T-16 AC-12.9 no store: an unresolved fact + an unresolved_consumption alert; the job never fails', () => {
  run('rules matched, no instrument binding / no default store: fact unresolved (inserted as unresolved), no movement, one open alert unresolved:none (dedupe counts occurrences); balances untouched', async (s) => {
    await enable(s, ENABLED); await setDefault(s, null); const bal0 = JSON.stringify(await s.sql('SELECT id, qty_base FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [A]));
    const p1 = payload({ test_id: TU, instrument_id: null, processing_branch_id: null }), p2 = payload({ test_id: TU, instrument_id: null, processing_branch_id: null });
    s.log.length = 0; await deliver(s, envelope(p1)); await deliver(s, envelope(p2));
    for (const p of [p1, p2]) { const [f, ...r] = await factsOf(s, `%${p['order_item_id']}%`); expect(r).toEqual([]); expect(f).toMatchObject({ status: 'unresolved', store_id: null, rules_applied: 1, value_paisa_total: '0' }); expect(await movesOf(s, f.id)).toEqual([]); }
    const al = await s.sql("SELECT status, dedupe_key, occurrences FROM inventory.alerts WHERE tenant_id = $1 AND alert_kind = 'unresolved_consumption' AND dedupe_key = 'unresolved:none'", [A]);
    expect(al).toHaveLength(1); expect(al[0]).toMatchObject({ status: 'open' }); expect(n(al[0].occurrences)).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(await s.sql('SELECT id, qty_base FROM inventory.stock_balances WHERE tenant_id = $1 ORDER BY id', [A]))).toBe(bal0);
    for (const u of s.log.filter((t) => /UPDATE\s+inventory\.consumption_facts/i.test(t))) expect((/SET([\s\S]*?)(WHERE|$)/i.exec(u) ?? [])[1] ?? '').not.toMatch(/\bstatus\b/i);
    expect(await counts(s, TU, null)).toMatchObject({ tests_counted: 2, verified_result_events: 2 });
  });
  run('an instrument WITH a binding is never unresolved; the alert key names the instrument when it is known (unresolved:<instrument_id>)', async (s) => {
    await enable(s, ENABLED); await setDefault(s, null);
    await s.sql('UPDATE inventory.instrument_bindings SET is_active = false WHERE tenant_id = $1 AND instrument_id = $2', [A, I2]);
    const p = payload({ test_id: TU, instrument_id: I2, processing_branch_id: null }); await deliver(s, envelope(p));
    expect((await factsOf(s, `%${p['order_item_id']}%`))[0]).toMatchObject({ status: 'unresolved', store_id: null });
    expect(await count(s, 'alerts', "alert_kind = 'unresolved_consumption' AND dedupe_key = $2", [`unresolved:${I2}`])).toBe(1);
  });
});

// ========================================================================================================== concurrency (committed, own rows)
describe.skipIf(!live)('T-16 concurrency: analyte events of one order item in parallel', () => {
  async function deliverCommitted(e: unknown, tries = 10): Promise<number> {   // emulates the worker retry (CV §7.5): a thrown error rolls back and the job runs again
    for (let attempt = 1; ; attempt++) {
      const c = await api.connect(); const s = sessionOn(c);
      try { await c.query('BEGIN'); await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]); await deliver(s, e); await c.query('COMMIT'); return attempt; }
      catch (x) { await c.query('ROLLBACK').catch(() => undefined); if (attempt >= tries) throw x; } finally { c.release(); }
    }
  }
  const scalar = async (sql: string, v: unknown[] = []) => n((await admin.query(sql, v)).rows[0].n);
  it('20 concurrent analyte events (CBC-like, committed): exactly 1 consume_test + 20 consume_analyte, exact balances, tests_counted 1, verified_result_events 20; every event succeeds within the retry budget', async () => {
    await admin.query('UPDATE inventory.settings SET consumption_enabled_at = $2 WHERE tenant_id = $1', [A, ENABLED]);
    const oi = uid(29100), bd = '2026-11-10'; const at = '2026-11-10T08:00:00.000Z';
    const q0 = await scalar('SELECT qty_base AS n FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3', [A, S1, ITRC]);
    const a0 = await scalar('SELECT qty_base AS n FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3', [A, S1, ITRA]);
    const events = RC_AN.map((a) => envelope(payload({ test_id: TRC, analyte_id: a, order_item_id: oi, instrument_id: I1, verified_at: at })));
    const attempts = await Promise.all(events.map((e) => deliverCommitted(e)));
    expect(attempts.every((a) => a <= 10)).toBe(true);
    expect(await scalar("SELECT count(*) AS n FROM inventory.consumption_facts WHERE tenant_id = $1 AND basis_key = $2", [A, `test:${oi}:${TRC}`])).toBe(1);
    const kinds = (await admin.query(`SELECT m.movement_kind AS k, count(*)::int AS n FROM inventory.stock_movements m JOIN inventory.consumption_facts f ON f.id = m.doc_id AND f.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1 AND m.attributed_test_id = $2 AND f.business_date = $3 GROUP BY 1 ORDER BY 1`, [A, TRC, bd])).rows;
    expect(kinds).toEqual([{ k: 'consume_analyte', n: 20 }, { k: 'consume_test', n: 1 }]);
    expect(await scalar('SELECT qty_base AS n FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3', [A, S1, ITRC])).toBe(q0 - 1);
    expect(await scalar('SELECT qty_base AS n FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3', [A, S1, ITRA])).toBe(a0 - 20);
    expect((await admin.query('SELECT tests_counted, verified_result_events FROM inventory.test_counts_daily WHERE tenant_id = $1 AND business_date = $2 AND test_id = $3 AND instrument_id = $4', [A, bd, TRC, I1])).rows[0])
      .toMatchObject({ tests_counted: 1, verified_result_events: 20 });
  }, 120_000);
  it('two events for the SAME (order item, test) racing, plus the same analyte event twice by different event ids: one test fact, one analyte fact, one deduction each', async () => {
    const oi = uid(29101), at = '2026-11-09T08:00:00.000Z'; const p = payload({ test_id: TRC, analyte_id: RC_AN[0], order_item_id: oi, instrument_id: I1, verified_at: at });
    await Promise.all([deliverCommitted(envelope(p)), deliverCommitted(envelope({ ...p })), deliverCommitted(envelope(payload({ test_id: TRC, analyte_id: RC_AN[1], order_item_id: oi, instrument_id: I1, verified_at: at })))]);
    expect(await scalar('SELECT count(*) AS n FROM inventory.consumption_facts WHERE tenant_id = $1 AND basis_key = $2', [A, `test:${oi}:${TRC}`])).toBe(1);
    expect(await scalar("SELECT count(*) AS n FROM inventory.consumption_facts WHERE tenant_id = $1 AND basis_key = $2", [A, `analyte:${p['result_id']}`])).toBe(1);
    expect(await scalar("SELECT count(*) AS n FROM inventory.stock_movements m JOIN inventory.consumption_facts f ON f.id = m.doc_id WHERE m.tenant_id = $1 AND f.basis_key = ANY($2)", [A, [`test:${oi}:${TRC}`, `analyte:${p['result_id']}`]])).toBe(2);
  }, 120_000);
});
