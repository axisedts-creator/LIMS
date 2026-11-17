// BL-T04 concurrency + gaplessness over an in-memory model of Postgres row locks / rollback (helpers.ts SimDb).
// Proves the SERVICE's protocol (set timeout → one UPDATE → reset → FY check; caller rollback ⇒ no gap). The real-DB proof is counter.live.test.ts.
// done_when: 200 concurrent allocations → 1..200; two tenants independent; straddling Shrawan 1 never numbered in the wrong FY (US-BL-01.1–.4).
import { describe, expect, it } from 'vitest';
import { createCounterService } from '../counter.service.js';
import { ACTOR, SimDb, TENANT, TENANT_B } from './helpers.js';

const svc = createCounterService();
const MID = '2026-01-05T06:00:00.000Z'; // 2082/83
const key = (tenantId: string, fiscalYearBs = '2082/83') => ({ tenantId, series: 'INV', fiscalYearBs, actorId: ACTOR });

async function inTx(db: SimDb, fn: (tx: ReturnType<SimDb['begin']>['tx']) => Promise<unknown>, fail = false) {
  const t = db.begin();
  try { const out = await fn(t.tx); if (fail) throw new Error('caller failed after allocate'); t.commit(); return out; } catch (e) { t.rollback(); throw e; }
}

describe('gapless under concurrency', () => {
  it('200 parallel allocations in one tenant → exactly 1..200, no duplicate, invoice_seq order == allocated_at order (US-BL-01.1)', async () => {
    const db = new SimDb(MID, 1);
    const out = (await Promise.all(Array.from({ length: 200 }, () => inTx(db, (tx) => svc.allocate(tx, key(TENANT)))))) as Array<{ lastNo: number; allocatedAt: string }>;
    const bySeq = [...out].sort((a, b) => a.lastNo - b.lastNo);
    expect(bySeq.map((r) => r.lastNo)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    const times = bySeq.map((r) => Date.parse(r.allocatedAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(200); // strictly increasing: stamped after the row lock is held
  });
  it('two tenants allocate concurrently → each series is independent and starts at 1 (US-BL-01.2)', async () => {
    const db = new SimDb(MID, 1);
    const jobs = Array.from({ length: 60 }, (_, i) => ({ t: i % 2 ? TENANT_B : TENANT }));
    const out = (await Promise.all(jobs.map((j) => inTx(db, (tx) => svc.allocate(tx, key(j.t)))))) as Array<{ lastNo: number }>;
    const a = out.filter((_, i) => jobs[i]!.t === TENANT).map((r) => r.lastNo).sort((x, y) => x - y);
    const b = out.filter((_, i) => jobs[i]!.t === TENANT_B).map((r) => r.lastNo).sort((x, y) => x - y);
    expect(a).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(b).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });
  it('a caller that fails after allocating rolls the counter back: the next document gets the SAME number (gapless, US-BL-01 / FD-03.5)', async () => {
    const db = new SimDb(MID, 1);
    await inTx(db, (tx) => svc.allocate(tx, key(TENANT))); // 1
    await expect(inTx(db, (tx) => svc.allocate(tx, key(TENANT)), true)).rejects.toThrow('caller failed'); // would be 2
    await expect(inTx(db, (tx) => svc.allocate(tx, key(TENANT)))).resolves.toMatchObject({ lastNo: 2 });
  });
  it('50 parallel allocations of which every third caller fails afterwards → committed numbers are contiguous 1..k', async () => {
    const db = new SimDb(MID, 1);
    const res = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => inTx(db, (tx) => svc.allocate(tx, key(TENANT)), i % 3 === 0)));
    const ok = res.filter((r): r is PromiseFulfilledResult<{ lastNo: number }> => r.status === 'fulfilled').map((r) => r.value.lastNo).sort((a, b) => a - b);
    expect(ok).toEqual(Array.from({ length: ok.length }, (_, i) => i + 1));
    expect(ok.length).toBe(50 - Math.ceil(50 / 3));
    expect([...db.rows.values()]).toEqual([ok.length]);
  });
});

describe('fiscal-year boundary mid-burst (US-BL-01.3)', () => {
  it('allocations straddling Shrawan 1 are rejected with fiscal_year_rollover, never numbered in the wrong FY; no gap; retry lands as seq 1 of the new FY', async () => {
    const db = new SimDb('2025-07-16T18:14:59.900Z', 50); // ticks: .900 .950 | 18:15:00.000 …
    const res = await Promise.allSettled(Array.from({ length: 10 }, () => inTx(db, (tx) => svc.allocate(tx, key(TENANT, '2081/82')))));
    const ok = res.filter((r): r is PromiseFulfilledResult<{ lastNo: number }> => r.status === 'fulfilled').map((r) => r.value.lastNo).sort((a, b) => a - b);
    const bad = res.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toEqual([1, 2]);
    expect(bad).toHaveLength(8);
    for (const r of bad) expect(r.reason).toMatchObject({ code: 'billing.counter_busy', detail: 'fiscal_year_rollover', statusCode: 503 });
    expect([...db.rows.entries()].filter(([k]) => k.endsWith('|2081/82')).map(([, v]) => v)).toEqual([2]); // rolled-back attempts consumed nothing
    await expect(inTx(db, (tx) => svc.allocate(tx, key(TENANT, '2082/83')))).resolves.toMatchObject({ lastNo: 1 }); // new FY starts at 1
  });
});

describe('lock timeout (US-BL-01.4)', () => {
  it('a waiter whose row is held past the timeout gets billing.counter_busy (not an endless wait); the holder is unaffected', async () => {
    const db = new SimDb(MID, 1);
    await inTx(db, (tx) => svc.allocate(tx, key(TENANT))); // row exists
    const holder = db.begin();
    await svc.allocate(holder.tx, key(TENANT)); // 2, lock held (holder has not committed)
    db.stuck = true;
    await expect(inTx(db, (tx) => svc.allocate(tx, key(TENANT)))).rejects.toMatchObject({ code: 'billing.counter_busy', statusCode: 503 });
    holder.commit();
    db.stuck = false;
    await expect(inTx(db, (tx) => svc.allocate(tx, key(TENANT)))).resolves.toMatchObject({ lastNo: 3 });
  });
  it('after a successful allocation the connection’s lock_timeout is back to 0 (reset, review C4 #29)', async () => {
    const db = new SimDb(MID, 1);
    const t = db.begin();
    await svc.allocate(t.tx, key(TENANT));
    expect(t.lockTimeout).toMatch(/^0(ms)?$/);
    t.commit();
  });
});
