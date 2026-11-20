// C12.T-26 chunk gate, part 3: TRD §12 performance targets at 1x and 10x seed (API side). Real migrated DB as lims_api (RLS on), REAL handlers. Run SEQUENTIALLY (vitest --no-file-parallelism, run.sh).
// Seed (tenant A, superuser, replica role; deterministic ids so a second pass only tops up):  1x = 150 items, 4 stores (2 per branch), 100,000 stock movements, one balance per (store, item),
//   consumption_daily = every 4th (store,item) pair per day for 366 days (150 rows/day at 1x);  10x = 1,500 items, 1,000,000 movements, 1,500 rows/day.  "10x" is therefore 10x the catalogue and the ledger of ONE lab
//   (the TRD's N = 10 labs write load is the worker test: services/worker/.../consumers.perf.integration.test.ts).  ASSUMPTION: TRD §12 gives rates, not row counts; these sizes are the gate's choice.
// TARGETS (02-TRD §12, p95 over >= 20 warm calls unless noted): interactive reads <= 300 ms at BOTH scales; document post (200 lines) <= 3.0 s (LD-207); reports 31 days / one branch <= 2 s; 366 days <= 8 s;
//   CSV export of 40,000-50,000 rows <= 20 s; integrity check per tenant: the real task runs and finishes within 5 min at 10x (TRD: 7 M movements / year; 10x here is 1 M, so the budget is generous: it
//   catches a missing index, not the 7 M ceiling - NOT verified at 7 M).   ponytail: wall-clock on one machine; compare relative growth 1x -> 10x too (<= 6x for the indexed reads).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, API_URL, A, BR1, BR2, applyFixtures, NOW, SYS, claims, live, p95, put, uid, withSession, type Sess } from './gate.helpers.js';

const REPORT_ROWS_PER_DAY = (scale: number) => 150 * scale;       // consumption_daily rows per business day
const STORES = [uid(26901), uid(26902), uid(26903), uid(26904)];
const itemId = (n: number) => `0190c514-0000-7000-8000-${String(26_100_000 + n).padStart(12, '0')}`;
const mvId = (n: number) => `0190c514-0000-7000-8000-${String(30_000_000 + n).padStart(12, '0')}`;
const TODAY = '2026-06-15';

let api: pg.Pool;
let admin: pg.Pool;
const stats: Record<string, number> = {};

/** Tops the seed up to `scale` x (idempotent: ON CONFLICT DO NOTHING on deterministic ids). */
async function seed(scale: number) {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims(A)]);
    const stores = [[STORES[0], BR1, 'P26-S1'], [STORES[1], BR1, 'P26-S2'], [STORES[2], BR2, 'P26-S3'], [STORES[3], BR2, 'P26-S4']];
    for (const [id, br, code] of stores) await put(c, 'inventory.stores', [{ id, tenant_id: A, branch_id: br, store_code: code, name: `Perf ${code}`, store_kind: 'bench', is_default_consumption: false, is_active: true }]);
    const items = 150 * scale, moves = 100_000 * scale, days = 366;
    await c.query(`INSERT INTO inventory.items (id, tenant_id, item_code, name, category, base_uom_code, is_lot_tracked, requires_expiry, created_by, updated_by)
      SELECT ('0190c514-0000-7000-8000-' || lpad((26100000 + n)::text, 12, '0'))::uuid, $1, 'P26-' || n, 'Perf item ' || n, 'reagent', 'piece', false, false, $2, $2 FROM generate_series(1, $3) n ON CONFLICT DO NOTHING`, [A, SYS, items]);
    // movements: 6 of 7 are receive (positive), 1 of 7 consume_test (negative; n % 7 is coprime to the item cycle, so no item only consumes) so every (store,item) stays positive; spread over 366 days, 4 stores, all items; balances = the ledger sums (no drift)
    await c.query(`INSERT INTO inventory.stock_movements (id, tenant_id, business_date, occurred_at, store_id, item_id, lot_id, movement_kind, qty_base, value_paisa, value_basis, doc_type, doc_id, balance_qty_after, created_by)
      SELECT ('0190c514-0000-7000-8000-' || lpad((30000000 + n)::text, 12, '0'))::uuid, $1, ($5::date - (n % $4)::int), ($5::date - (n % $4)::int)::timestamptz + interval '6 hours', ($6::uuid[])[1 + (n % 4)],
             ('0190c514-0000-7000-8000-' || lpad((26100000 + 1 + ((n / 4) % $3))::text, 12, '0'))::uuid, NULL,
             CASE WHEN n % 7 = 0 THEN 'consume_test' ELSE 'receive' END, CASE WHEN n % 7 = 0 THEN -1 ELSE 2 + (n % 7) END, CASE WHEN n % 7 = 0 THEN -100 ELSE 100 END, 'average',
             CASE WHEN n % 7 = 0 THEN 'consumption_fact' ELSE 'goods_receipt' END, gen_random_uuid(), 0, $2
        FROM generate_series(1, $7) n ON CONFLICT DO NOTHING`, [A, SYS, items, days, TODAY, STORES, moves]);
    await c.query(`INSERT INTO inventory.stock_balances (id, tenant_id, store_id, item_id, lot_id, qty_base, value_paisa, last_movement_at, created_by, updated_by)
      SELECT gen_random_uuid(), tenant_id, store_id, item_id, NULL, sum(qty_base), sum(value_paisa), $3::timestamptz, $2, $2 FROM inventory.stock_movements
       WHERE tenant_id = $1 AND store_id = ANY($4::uuid[]) GROUP BY tenant_id, store_id, item_id
      ON CONFLICT ON CONSTRAINT stock_balances__key__uq DO UPDATE SET qty_base = EXCLUDED.qty_base, value_paisa = EXCLUDED.value_paisa`, [A, SYS, NOW, STORES]);
    // consumption_daily: every 4th (store, item) pair per day (150 rows/day at 1x), 366 days
    await c.query(`INSERT INTO inventory.consumption_daily (id, tenant_id, business_date, store_id, item_id, movement_kind, qty_consumed, value_consumed_paisa, movements, created_by, updated_by)
      SELECT gen_random_uuid(), $1, ($5::date - d), s.id, ('0190c514-0000-7000-8000-' || lpad((26100000 + n)::text, 12, '0'))::uuid, 'consume_test', 1 + (n % 5), 100 * (1 + (n % 5)), 1, $2, $2
        FROM generate_series(0, $4 - 1) d CROSS JOIN generate_series(1, $3) n CROSS JOIN unnest($6::uuid[]) WITH ORDINALITY s(id, k)
       WHERE ((n + s.k) % 4) = 0 ON CONFLICT DO NOTHING`, [A, SYS, items, days, TODAY, STORES]);
    await c.query('COMMIT');
    await c.query('ANALYZE inventory.stock_movements, inventory.consumption_daily, inventory.stock_balances, inventory.items');
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 4 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  await applyFixtures(admin);
}, 300_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-26 perf harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_C12T03_REQUIRE_DB=1)', () => { if (process.env['LIMS_C12T03_REQUIRE_DB'] === '1') expect(live).toBe(true); });
});

const time = async (n: number, fn: (i: number) => Promise<unknown>): Promise<number[]> => {
  const out: number[] = [];
  for (let i = 0; i < n + 3; i++) { const t0 = performance.now(); await fn(i); if (i >= 3) out.push(performance.now() - t0); } // 3 warm-up calls are dropped
  return out;
};
const read = (op: string, query: Record<string, unknown> = {}) => (s: Sess) => s.go(op, { params: {}, query, headers: {} });
const rep = (s: Sess, code: string, query: Record<string, unknown>) => s.go('getInventoryReport', { params: { report_code: code }, query, headers: {} });

for (const scale of [1, 10]) {
  describe.skipIf(!live)(`T-26 TRD §12 targets at ${scale}x seed`, () => {
    beforeAll(async () => { await seed(scale); }, 600_000);

    it('the seed is the size this gate states (guards a silent no-op seed)', async () => {
      const n = (await admin.query(`SELECT (SELECT count(*) FROM inventory.stock_movements WHERE tenant_id = $1 AND doc_type IN ('goods_receipt','consumption_fact') AND id::text LIKE '0190c514-0000-7000-8000-0%') AS m,
        (SELECT count(*) FROM inventory.consumption_daily WHERE tenant_id = $1 AND business_date = $2::date) AS d`, [A, TODAY])).rows[0];
      const bal = (await admin.query(`SELECT count(*)::int AS n, min(qty_base)::float8 AS lo FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND lot_id IS NULL`, [A, STORES[0]])).rows[0];
      const st = (await admin.query(`SELECT count(*)::int AS n FROM inventory.stores WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [A, STORES])).rows[0].n;
      expect({ stores: st, balances: bal.n, lowest: bal.lo > 0 }, 'seed: 4 stores; one positive balance per item in store 1').toEqual({ stores: 4, balances: 150 * scale, lowest: true });
      expect(Number(n.m)).toBeGreaterThanOrEqual(100_000 * scale);
      expect(Number(n.d)).toBeGreaterThanOrEqual(REPORT_ROWS_PER_DAY(scale) * 0.9);
    }, 120_000);

    const reads: [string, string, Record<string, unknown>][] = [
      ['listInventoryItems', 'items', { limit: 50 }], ['listStockBalances', 'balances (store)', { store_id: STORES[0], limit: 100 }], ['listStockMovements', 'movements (store+item)', { store_id: STORES[0], item_id: itemId(7), limit: 100 }],
      ['listStockMovements', 'movements (store only, newest page)', { store_id: STORES[1], limit: 100 }], ['listInventoryLots', 'lots', { item_id: itemId(1), limit: 50 }], ['getInventoryItem', 'item get', {}],
    ];
    for (const [op, label, q] of reads) {
      it(`interactive read p95 <= 300 ms: ${op} ${label}`, () => withSession(api, async (s) => {
        const ms = await time(20, async (i) => op === 'getInventoryItem' ? s.go(op, { params: { item_id: itemId(1 + i) }, query: {}, headers: {} }) : read(op, q)(s));
        stats[`${scale}x:${op}:${label}`] = p95(ms);
        expect(p95(ms), `${op} ${label} p95 ${p95(ms).toFixed(0)} ms`).toBeLessThanOrEqual(300);
      }), 120_000);
    }

    it('document post, 200 lines (createStockIssue): p95 <= 3.0 s', () => withSession(api, async (s) => {
      const ms: number[] = [];
      for (let i = 0; i < 8; i++) {
        const lines = Array.from({ length: 200 }, (_, k) => ({ item_id: itemId(1 + ((i * 200 + k) % (150 * scale))), qty: '1' }));
        const t0 = performance.now();
        const r = await s.go('createStockIssue', { params: {}, query: {}, headers: { 'idempotency-key': randomUUID() }, body: { store_id: STORES[0], issued_to_kind: 'general', lines } });
        expect(r.status).toBe(201);
        if (i >= 2) ms.push(performance.now() - t0);
      }
      expect(p95(ms), `p95 ${p95(ms).toFixed(0)} ms`).toBeLessThanOrEqual(3000);
    }), 300_000);

    for (const code of ['daily_consumption', 'wastage']) {
      it(`report ${code}, 31 days, one branch: p95 <= 2 s; 366 days: <= 8 s`, () => withSession(api, async (s) => {
        const ms31 = await time(10, () => rep(s, code, { business_date_from: '2026-05-15', business_date_to: TODAY, branch_id: BR1 }));
        expect(p95(ms31), `${code} 31d p95 ${p95(ms31).toFixed(0)} ms`).toBeLessThanOrEqual(2000);
        const ms366 = await time(5, () => rep(s, code, { business_date_from: '2025-06-15', business_date_to: TODAY, branch_id: BR1 }));
        expect(p95(ms366), `${code} 366d p95 ${p95(ms366).toFixed(0)} ms`).toBeLessThanOrEqual(8000);
      }), 300_000);
    }
    for (const code of ['stock_valuation', 'expiry']) {
      it(`report ${code}, one branch: p95 <= 2 s`, () => withSession(api, async (s) => {
        const ms = await time(10, () => rep(s, code, { branch_id: BR1 }));
        expect(p95(ms), `${code} p95 ${p95(ms).toFixed(0)} ms`).toBeLessThanOrEqual(2000);
      }), 300_000);
    }

    it('CSV export of 40,000-50,000 rows (daily_consumption, all branches): <= 20 s and streamed-size sane', () => withSession(api, async (s) => {
      const days = Math.ceil(45_000 / REPORT_ROWS_PER_DAY(scale)); // 300 days at 1x (cap 366), 30 days at 10x
      const from = new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
      const t0 = performance.now();
      const r = await s.go('exportInventoryReport', { params: { report_code: 'daily_consumption' }, query: { business_date_from: from, business_date_to: TODAY }, headers: {} });
      const dt = performance.now() - t0;
      const text = typeof r.body === 'string' ? r.body : Buffer.from(r.body).toString('utf8');
      const records = text.split('\r\n').filter(Boolean).length - 1;
      expect(records, 'the seeded window must hold 40,000-50,000 rows').toBeGreaterThanOrEqual(40_000);
      expect(records).toBeLessThanOrEqual(50_000);
      expect(dt, `export took ${dt.toFixed(0)} ms`).toBeLessThanOrEqual(20_000);
    }), 300_000);

    it('balance integrity check (the real inventory.balance_integrity_check task) for the tenant: <= 5 min', async () => {
      const mod = await import(/* @vite-ignore */ new URL('../../../../../../worker/src/jobs/inventory/tasks/inventory.balance_integrity_check.ts', import.meta.url).href) as { balanceIntegrityCheck: (p: unknown, c: unknown) => Promise<void> };
      const client = await api.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(A)]);
        const tx = { query: (t: string, v?: unknown[]) => client.query(t, v) };
        const { createCoreRepo } = await import('../../../../core/core-repo/index.js');
        const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
        const ctx: any = { tenantId: A, actor: { type: 'system', id: SYS }, requestId: 'r-t26', tx, now: () => NOW, attempt: 1, maxAttempts: 10, jobId: 'job-t26', log, metrics: { inc() {}, set() {}, observe() {} },
          core: createCoreRepo({ withTenantScope: async (_t: unknown, _tn: unknown, _a: unknown, fn: () => unknown) => fn(), systemActorOf: () => SYS } as any), ports: {}, events: {}, storage: {}, files: {}, audit: {}, db: { tx: async (fn: any) => fn(ctx) } };
        const t0 = performance.now();
        await mod.balanceIntegrityCheck({ tenant_id: A }, ctx);
        expect(performance.now() - t0).toBeLessThanOrEqual(300_000);
      } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    }, 330_000);
  });
}

describe.skipIf(!live)('T-26 1x -> 10x growth (indexed reads must not grow with the table, only with the page)', () => {
  it('p95 of every interactive read at 10x is at most 6x its 1x value (+ 25 ms floor)', () => {
    const bad = Object.keys(stats).filter((k) => k.startsWith('10x:')).filter((k) => stats[k]! > 6 * (stats[k.replace('10x:', '1x:')] ?? Infinity) + 25);
    expect(bad.map((k) => `${k}: ${stats[k]!.toFixed(0)} ms vs ${stats[k.replace('10x:', '1x:')]?.toFixed(0)} ms`)).toEqual([]);
  });
});
