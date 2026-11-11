// BL-T04 live-DB integration: 200 parallel transactions, rollback gaplessness, real lock timeout, lock_timeout reset, FY rollover leaves nothing behind.
// Gated exactly like billing/repository/__tests__/immutability.live.test.ts: skipped unless both URLs are set (needs `pg`, loaded dynamically).
//   LIMS_TEST_DATABASE_URL      superuser URL of a migrated + seeded DB (tenant 01a1a98a-ac40-7000-8000-00000000a001). Used to hold locks, inspect, clean up.
//   LIMS_TEST_APP_DATABASE_URL  URL that logs in as / may SET ROLE lims_app; the service runs through createDb().requestTx as lims_app.
// Fixtures: series INV:BLT04* in the CURRENT fiscal year (the service compares allocated_at with the row's FY) and FY 2001/02 for the rollover case; all removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../../../core/db/tx.js';
import { fiscalYearOf } from '../../domain/fiscalYear.js';
import { createCounterService } from '../counter.service.js';

const SU = process.env['LIMS_TEST_DATABASE_URL'], APP = process.env['LIMS_TEST_APP_DATABASE_URL'];
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a500', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const CLAIMS = { actor_type: 'system', tenant_id: TENANT, sub: SYS, membership_id: MEMBERSHIP };
const FY = fiscalYearOf(new Date().toISOString() as never).long;
const S_BURST = 'INV:BLT04A', S_ROLL = 'INV:BLT04B', S_LOCK = 'INV:BLT04C', S_NEW = 'INV:BLT04D', S_FY = 'INV:BLT04E';
const PATTERN = '{branch}-{fy}-{seq:6}';
const uid = (n: number) => `0190c404-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe.skipIf(!SU || !APP)('counter.service over a real DB (lims_app)', () => {
  let su: any, app: any, db: ReturnType<typeof createDb>;
  const svc = createCounterService();
  let reqN = 0;
  const requestTx = <T>(fn: Parameters<typeof db.requestTx<T>>[1]) =>
    db.requestTx({ claims: CLAIMS as never, requestId: uid(++reqN), clientIp: '203.0.113.7', operation: { module: 'billing', operationId: 'BL-T04.live' } }, fn);
  const alloc = (tx: any, series: string, fiscalYearBs = FY) => svc.allocate(tx, { tenantId: TENANT, series, fiscalYearBs, actorId: SYS, invoiceNoPattern: PATTERN });
  const lastNo = async (series: string, fy = FY) =>
    (await su.query(`SELECT last_no FROM billing.fiscal_counters WHERE tenant_id = $1 AND series = $2 AND fiscal_year_bs = $3`, [TENANT, series, fy])).rows[0]?.last_no;

  async function cleanup() {
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT, sub: SYS, actor_type: 'system' })]);
      await c.query(`DELETE FROM billing.fiscal_counters WHERE tenant_id = $1 AND series LIKE 'INV:BLT04%'`, [TENANT]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  beforeAll(async () => {
    const pg: any = await import(['p', 'g'].join(''));
    const Pool = (pg.default ?? pg).Pool;
    su = new Pool({ connectionString: SU, max: 3 }); app = new Pool({ connectionString: APP, max: 8 });
    db = createDb({ pool: app, identitySystemActorId: SYS });
    await cleanup();
  });
  afterAll(async () => { if (su) await cleanup().catch(() => undefined); await su?.end(); await app?.end(); });

  it('200 parallel transactions → 1..200, no gap, no duplicate; allocated_at never decreases with invoice_seq (US-BL-01.1)', async () => {
    const out = await Promise.all(Array.from({ length: 200 }, () => requestTx((tx) => alloc(tx, S_BURST))));
    const bySeq = [...out].sort((a, b) => a.lastNo - b.lastNo);
    expect(bySeq.map((r) => r.lastNo)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    const t = bySeq.map((r) => Date.parse(r.allocatedAt));
    expect(t).toEqual([...t].sort((a, b) => a - b));
    expect(Number(await lastNo(S_BURST))).toBe(200);
  }, 120_000);

  it('a transaction that fails after allocating leaves no gap: the next allocation reuses the number', async () => {
    await requestTx((tx) => alloc(tx, S_ROLL)); // 1
    await expect(requestTx(async (tx) => { await alloc(tx, S_ROLL); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(Number(await lastNo(S_ROLL))).toBe(1);
    await expect(requestTx((tx) => alloc(tx, S_ROLL))).resolves.toMatchObject({ lastNo: 2 });
  });

  it('missing counter row is created at 0 and the first allocation is 1', async () => {
    await expect(requestTx((tx) => alloc(tx, S_NEW))).resolves.toMatchObject({ lastNo: 1 });
  });

  it('row locked by another transaction past the timeout → billing.counter_busy (503) and nothing stored (US-BL-01.4)', async () => {
    await requestTx((tx) => alloc(tx, S_LOCK)); // row exists, last_no 1
    const holder = await su.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT, sub: SYS, actor_type: 'system' })]);
      await holder.query(`SELECT 1 FROM billing.fiscal_counters WHERE tenant_id = $1 AND series = $2 AND fiscal_year_bs = $3 FOR UPDATE`, [TENANT, S_LOCK, FY]);
      const quick = createCounterService({ config: { counterLockTimeoutMs: 300 } });
      const t0 = Date.now();
      const e: any = await requestTx((tx) => quick.allocate(tx, { tenantId: TENANT, series: S_LOCK, fiscalYearBs: FY, actorId: SYS, invoiceNoPattern: PATTERN })).catch((x) => x);
      expect(e).toMatchObject({ code: 'billing.counter_busy', statusCode: 503 });
      expect(e.detail).toBeUndefined();
      expect(Date.now() - t0).toBeLessThan(2500); // 300 ms timeout, not the 3 s default or an endless wait
    } finally { await holder.query('ROLLBACK').catch(() => undefined); holder.release(); }
    expect(Number(await lastNo(S_LOCK))).toBe(1);
    await expect(requestTx((tx) => alloc(tx, S_LOCK))).resolves.toMatchObject({ lastNo: 2 }); // usable again
  });

  it('lock_timeout is reset to 0 right after the counter UPDATE, inside the same transaction (review C4 #29)', async () => {
    const seen = await requestTx(async (tx) => {
      const before = (await tx.query(`SHOW lock_timeout`)).rows[0].lock_timeout; // createDb default 3000ms
      await alloc(tx, S_BURST);
      return { before, after: (await tx.query(`SHOW lock_timeout`)).rows[0].lock_timeout };
    });
    expect(seen.before).toBe('3s');
    expect(seen.after).toBe('0');
  });

  it('allocated_at in another fiscal year than the row → counter_busy / fiscal_year_rollover, and the transaction leaves no counter row or increment (US-BL-01.3)', async () => {
    const before = await lastNo(S_BURST);
    const e: any = await requestTx((tx) => alloc(tx, S_FY, '2001/02')).catch((x) => x);
    expect(e).toMatchObject({ code: 'billing.counter_busy', detail: 'fiscal_year_rollover', statusCode: 503 });
    expect(await lastNo(S_FY, '2001/02')).toBeUndefined();
    expect(await lastNo(S_BURST)).toBe(before);
  });

  it('branch series without {branch} in the pattern → numbering_pattern_invalid and no counter touched (D-23)', async () => {
    const e: any = await requestTx((tx) => svc.allocate(tx, { tenantId: TENANT, series: S_NEW, fiscalYearBs: FY, actorId: SYS, invoiceNoPattern: '{fy}-{seq:6}' })).catch((x) => x);
    expect(e).toMatchObject({ code: 'billing.numbering_pattern_invalid', statusCode: 409 });
    expect(Number(await lastNo(S_NEW))).toBe(1);
  });
});
