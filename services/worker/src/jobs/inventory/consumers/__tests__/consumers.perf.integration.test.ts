// C12.T-26 chunk gate, part 4: TRD §12 consumer targets + risk R3 (hot balance row). Real migrated DB as lims_api (RLS on), REAL consumers; harness tests/db/c12-t26/run.sh (same pinned image, fixtures).
// TARGETS (02-TRD §12): consumer handler p95 <= 100 ms (posting path, warm); <= 20 ms (skip path); consumption lag (occurred_at -> commit) p95 <= 60 s; R3 (06-PLAN §7): ONE reagent balance row hit by 4
// workers (the C1 concurrency for evt.inventory.*) serialises consumers, but the per-event time INCLUDING the wait stays <= 4 x 100 ms (lock held << 100 ms) and no event is lost or double-posted.
// Event names / seams are those of T-16 (onResultVerified) and T-17 (onResultReceived); fixtures use ids 26xxx. Synthetic data only.
// ponytail: wall-clock on one machine, 200 events per path (the TRD peak is 5.6 posting + 29 skip events/s at N = 10 labs; this proves the per-event cost, the 4-worker run proves the contention).
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
const A = '01a1a98a-ac40-7000-8000-00000000a001', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5', BR1 = '01a1a98a-ac40-7000-8000-00000000a101', CENTRE_BR1 = '01a1a98a-ac40-7000-8000-00000000a201';
const uid = (n: number) => `0190c514-0000-7000-8000-${String(n + 3000).padStart(12, '0')}`; // +3000: stays clear of the api gate's tenant-B ids (uid 26001..) in the same database
const KT = 'Asia/Kathmandu';
const TG = uid(26001), I1 = uid(26201), S1 = uid(26401), ITEM = uid(26501), AG = uid(26121), DEPT = uid(26601);
const verified = new URL('../lab.result.verified.v1.ts', import.meta.url).href;
const received = new URL('../instruments.result.received.v1.ts', import.meta.url).href;

const J = (o: unknown) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const I = (table: string, o: Record<string, unknown>) => `SELECT pg_temp.t26_ins('${table}', ${J(o)});`;
const tid = { tenant_id: A };
const EXTRAS = `
BEGIN;
SET search_path = extensions, public, pg_catalog;
SET LOCAL session_replication_role = replica;
CREATE OR REPLACE FUNCTION pg_temp.t26_ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r jsonb := p_row; a text; cols text;
BEGIN
  IF r ? 'tenant_id' THEN PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', r->>'tenant_id', 'sub', '${SYS}', 'actor_type', 'system')::text, true); END IF;
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, '${SYS}'::uuid); END IF;
  END LOOP;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb) ON CONFLICT DO NOTHING', p_tbl, cols, r::text);
END $f$;
SELECT set_config('request.jwt.claims', '{"tenant_id":"${A}","sub":"${SYS}","actor_type":"system"}', true);
${I('catalog.tests', { id: TG, ...tid, workflow_type: 'standard' })}
${I('instruments.instruments', { id: I1, ...tid, centre_id: CENTRE_BR1, agent_id: uid(27201), instrument_code: 'T26-I1', display_name: 'Instrument T26-I1', vendor: 'Synthetic', model: 'SX-1', protocol: 'astm',
  driver_code: 'astm_generic_e1394', transport: { kind: 'tcp_client' }, timezone: KT, state: 'draft' })}
${I('inventory.stores', { id: S1, ...tid, branch_id: BR1, store_code: 'T26-S1', name: 'Store T26-S1', store_kind: 'main', is_default_consumption: false, is_active: true })}
${I('inventory.items', { id: ITEM, ...tid, item_code: 'T26-GLU', name: 'Item T26-GLU', category: 'consumable', base_uom_code: 'piece', is_lot_tracked: false, requires_expiry: false, is_active: true })}
${I('inventory.stock_balances', { id: uid(26801), ...tid, store_id: S1, item_id: ITEM, lot_id: null, qty_base: 1000000, value_paisa: 10000000, last_movement_at: new Date().toISOString() })}
${I('inventory.instrument_bindings', { id: uid(26901), ...tid, instrument_id: I1, store_id: S1, is_active: true })}
${I('inventory.consumption_rules', { id: uid(26701), ...tid, rule_kind: 'per_test', test_id: TG, item_id: ITEM, qty_base: 1, entered_qty: 1, effective_from: '2026-01-01T00:00:00.000Z', is_active: true })}
UPDATE inventory.settings SET consumption_enabled_at = '2026-06-01T00:00:00.000Z' WHERE tenant_id = '${A}';
COMMIT;`;

let api: InstanceType<typeof pg.Pool>;
let admin: InstanceType<typeof pg.Pool>;
beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 8 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  try { await admin.query(readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c12-t03/fixtures.sql', import.meta.url)), 'utf8')); } catch (e) { if ((e as { code?: string }).code !== '23505') throw e; } // already applied by the api gate files
  await admin.query(EXTRAS);
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-26 consumer perf harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => { if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true); });
});

const claimsA = JSON.stringify({ tenant_id: A, sub: SYS, actor_type: 'system' });
async function jobCtx(client: PoolClient) {
  const { createCoreRepo } = await import('../../../../../../api/src/core/core-repo/index.js');
  const tx = { query: (t: string, v?: unknown[]) => client.query(t, v) };
  let sp = 0;
  const noop = () => undefined;
  const c: any = { tenantId: A, actor: { type: 'system', id: SYS }, requestId: 'r-t26', tx, now: () => new Date().toISOString(), attempt: 1, maxAttempts: 10, jobId: 'job-t26', isNewer: () => true,
    core: createCoreRepo({ withTenantScope: async (_t: unknown, _tn: unknown, _a: unknown, fn: () => unknown) => fn(), systemActorOf: () => SYS } as any),
    ports: { IdentityPort: { async getTenantSettings() { return { timezone: KT }; } } }, events: {}, storage: {}, files: {}, audit: {}, metrics: { inc: noop, set: noop, observe: noop },
    log: { info: noop, warn: noop, error: noop, debug: noop, child() { return this; } } };
  c.db = { async tx(fn: (x: unknown) => Promise<unknown>) { const name = `t26_sp_${++sp}`; await tx.query(`SAVEPOINT ${name}`); try { const r = await fn(c); await tx.query(`RELEASE SAVEPOINT ${name}`); return r; } catch (e) { await tx.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; } } };
  return c;
}
let seq = 1000;
const verifiedEvent = (occurredAt: string) => {
  const n = ++seq;
  const p = { result_id: uid(40000 + n), result_version_no: 1, order_id: uid(41000 + n), order_item_id: uid(42000 + n), specimen_id: uid(43000 + n), test_id: TG, analyte_id: AG, department_id: DEPT, instrument_id: I1, origin: 'instrument',
    mode: 'manual', verified_at: occurredAt, verified_by_membership_id: uid(44000), processing_branch_id: BR1 };
  return { event_id: uid(45000 + n), event_type: 'lab.result.verified.v1', tenant_id: A, occurred_at: occurredAt, actor: { type: 'system', id: SYS }, idempotency_key: `${p.result_id}:verified:1:${n}`, producer: 'lab',
    aggregate: { type: 'result', id: p.result_id, seq: 1 }, request_id: uid(46000 + n), payload: p };
};
const notRerunEvent = () => {
  const n = ++seq;
  const p = { instrument_message_id: uid(47000 + n), instrument_id: I1, agent_id: uid(27201), centre_id: CENTRE_BR1, protocol: 'astm', sample_barcode: 'SYN-BC-26', record_kind: 'quantitative', instrument_analyte_code: 'GLU',
    mapping_status: 'mapped', analyte_id: AG, test_id: TG, value_raw: '5.1', received_at: new Date().toISOString(), is_rerun: false };
  return { event_id: uid(48000 + n), event_type: 'instruments.result.received.v1', tenant_id: A, occurred_at: p.received_at, actor: { type: 'system', id: SYS }, idempotency_key: `${p.instrument_message_id}:res:${n}`, producer: 'instruments',
    aggregate: { type: 'instrument_message', id: p.instrument_message_id, seq: 1 }, request_id: uid(49000 + n), payload: p };
};
const p95 = (ms: number[]) => { const a = [...ms].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(0.95 * a.length) - 1)]!; };

describe.skipIf(!live)('T-26 TRD §12 consumer targets', () => {
  it('posting path (lab.result.verified.v1 -> fact + movement + balance + counters): p95 <= 100 ms over 200 warm events, and every event posts', async () => {
    const { onResultVerified } = await import(/* @vite-ignore */ verified) as { onResultVerified: (e: unknown, c: unknown) => Promise<void> };
    const client = await api.connect();
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claimsA]);
      const ctx = await jobCtx(client); const ms: number[] = [];
      for (let i = 0; i < 205; i++) { const t0 = performance.now(); await onResultVerified(verifiedEvent(new Date().toISOString()), ctx); if (i >= 5) ms.push(performance.now() - t0); }
      const posted = Number((await client.query(`SELECT count(*) AS n FROM inventory.consumption_facts WHERE tenant_id = $1 AND status = 'posted' AND basis_key LIKE 'test:%'`, [A])).rows[0].n);
      expect(posted).toBeGreaterThanOrEqual(205);
      expect(p95(ms), `posting p95 ${p95(ms).toFixed(1)} ms`).toBeLessThanOrEqual(100);
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  }, 120_000);

  it('skip path (instruments.result.received.v1, is_rerun false): p95 <= 20 ms over 200 warm events, no fact and no movement written', async () => {
    const { onResultReceived } = await import(/* @vite-ignore */ received) as { onResultReceived: (e: unknown, c: unknown) => Promise<void> };
    const client = await api.connect();
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claimsA]);
      const ctx = await jobCtx(client); const ms: number[] = [];
      const before = Number((await client.query('SELECT count(*) AS n FROM inventory.stock_movements WHERE tenant_id = $1', [A])).rows[0].n);
      for (let i = 0; i < 205; i++) { const t0 = performance.now(); await onResultReceived(notRerunEvent(), ctx); if (i >= 5) ms.push(performance.now() - t0); }
      expect(Number((await client.query('SELECT count(*) AS n FROM inventory.stock_movements WHERE tenant_id = $1', [A])).rows[0].n)).toBe(before);
      expect(p95(ms), `skip p95 ${p95(ms).toFixed(1)} ms`).toBeLessThanOrEqual(20);
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  }, 120_000);

  it('consumption lag (occurred_at -> commit) p95 <= 60 s for events that occurred 5 s ago (the handler adds no queueing of its own)', async () => {
    const { onResultVerified } = await import(/* @vite-ignore */ verified) as { onResultVerified: (e: unknown, c: unknown) => Promise<void> };
    const lags: number[] = [];
    for (let i = 0; i < 30; i++) {
      const client = await api.connect();
      try {
        await client.query('BEGIN'); await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claimsA]);
        const occurred = new Date(Date.now() - 5000).toISOString();
        await onResultVerified(verifiedEvent(occurred), await jobCtx(client));
        await client.query('COMMIT');
        lags.push((Date.now() - Date.parse(occurred)) / 1000);
      } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    }
    expect(p95(lags), `lag p95 ${p95(lags).toFixed(2)} s`).toBeLessThanOrEqual(60);
  }, 120_000);

  it('R3 hot balance row: 4 concurrent workers x 25 committed events on ONE (store, item) balance: every event posts once, balance = ledger, per-event p95 incl. lock wait <= 400 ms', async () => {
    const { onResultVerified } = await import(/* @vite-ignore */ verified) as { onResultVerified: (e: unknown, c: unknown) => Promise<void> };
    const before = (await admin.query(`SELECT qty_base::float8 AS q FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id IS NULL`, [A, S1, ITEM])).rows[0].q as number;
    const events = Array.from({ length: 100 }, () => verifiedEvent(new Date().toISOString()));
    const ms: number[] = [];
    const worker = async (k: number) => {
      for (const e of events.filter((_, i) => i % 4 === k)) {
        const client = await api.connect();
        try {
          const t0 = performance.now();
          await client.query('BEGIN'); await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claimsA]);
          await onResultVerified(e, await jobCtx(client));
          await client.query('COMMIT'); ms.push(performance.now() - t0);
        } catch (err) { await client.query('ROLLBACK').catch(() => undefined); throw err; } finally { client.release(); }
      }
    };
    await Promise.all([0, 1, 2, 3].map(worker));
    const after = (await admin.query(`SELECT qty_base::float8 AS q FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id IS NULL`, [A, S1, ITEM])).rows[0].q as number;
    const posted = Number((await admin.query(`SELECT count(*) AS n FROM inventory.consumption_facts WHERE tenant_id = $1 AND source_event_id = ANY($2::uuid[]) AND status = 'posted'`, [A, events.map((e) => e.event_id)])).rows[0].n);
    expect(posted).toBe(100);
    expect(before - after).toBe(100);
    expect(p95(ms), `contended p95 ${p95(ms).toFixed(0)} ms`).toBeLessThanOrEqual(400);
  }, 180_000);
});
