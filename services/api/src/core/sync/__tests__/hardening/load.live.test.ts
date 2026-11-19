// T0B-SYNC-5 done_when (1) LOAD: 200 devices each send 100 mixed operations in batches of 50 after a simulated outage, with overlap of patients and orders.
// Proves: no lost and no duplicated operation, every receipt number unique and gap free, database connections within the bound, p95 batch time inside the bound written in the notes,
// rate limits and retry_after honoured. Live PG17 only (the throwaway container of tests/core/T0B-SYNC-5.pg.sh), real engine, RLS on. Synthetic adapters (see ./kit.ts header).
// HONEST STATUS: the engine under test exists since T0B-SYNC-2..4 and done_when (6) forbids production changes in it, so this file is a GUARD that is expected to pass on a correct engine
// (it fails if the engine loses, doubles, mis-numbers or over-connects under load). The failing-first tests of this task are retention / metrics / runbook (sibling files).
import { beforeAll, describe, expect, it } from 'vitest';
import { LOAD, P95_BATCH_MS_BOUND, buildPlans, chunk, code, devicePush, ensureS5, eventsOf, ledgerOf, ownerRows, percentile, pool, receiptNos, revoke, syncEngine, uid, A1, NOW, newDevice, okBody, closedCodes } from './kit.js';

const T = 1_800_000;
const run = `ld${uid().slice(-8)}`;
beforeAll(ensureS5);

describe('200 devices x 100 mixed operations after an outage', () => {
  it('lands every operation exactly once with gap free receipt numbers, bounded connections and a p95 batch time inside the bound', async () => {
    const series = `S5L-${run}`;
    const H = syncEngine(series);
    const { plans, overlap } = await buildPlans(run, LOAD.devices, LOAD.opsPerDevice);
    const allOps = plans.flatMap((p) => p.ops);
    expect(allOps).toHaveLength(LOAD.devices * LOAD.opsPerDevice);
    expect(new Set(allOps.map((o) => o.op.op_id)).size).toBe(allOps.length);

    // connection sampler: lims_api sessions during the run (the engine takes ONE connection per batch in flight, never a second pool)
    const baseline = Number((await ownerRows(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'lims_api'`))[0].n);
    let maxSessions = baseline; let sampling = true;
    const sampler = (async () => { while (sampling) { const n = Number((await ownerRows(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'lims_api'`))[0].n); if (n > maxSessions) maxSessions = n; await new Promise((r) => setTimeout(r, 50)); } })();

    const times: number[] = []; const results = new Map<string, any>(); const failures: string[] = [];
    await pool(plans, LOAD.concurrency, async (plan) => {
      for (const batch of chunk(plan.ops.map((p) => p.op), LOAD.batchSize)) {   // ONE batch in flight per device
        const t0 = Date.now();
        const o = await devicePush(H, A1, plan.deviceId, batch);
        times.push(Date.now() - t0);
        if (o.error) { failures.push(`${plan.index}: ${code(o) ?? String(o.error)}`); continue; }
        for (const r of okBody(o).results) results.set(r.op_id, r);
      }
    });
    sampling = false; await sampler;

    // (a) no lost operation: every op has a result and a ledger row; (b) no duplicated one: exactly one ledger row and at most one applied event per op id
    expect(failures).toEqual([]);
    expect(results.size).toBe(allOps.length);
    const ids = allOps.map((o) => o.op.op_id);
    const ledger = new Map<string, any>(); for (const part of chunk(ids, 2000)) for (const r of await ledgerOf(part)) ledger.set(r.op_id, r);
    expect(ledger.size).toBe(allOps.length);
    const events: any[] = []; for (const part of chunk(ids, 2000)) events.push(...await eventsOf(part));
    expect(new Set(events.map((e) => e.op_id)).size).toBe(events.length);

    const byStatus = (s: string) => [...results.values()].filter((r) => r.status === s).length;
    const closed = await closedCodes();
    expect(byStatus('rejected')).toBe(0);                                                       // a clean load has no refusal (any would carry a closed code)
    for (const r of results.values()) if (r.error_code) expect(closed.has(r.error_code)).toBe(true);
    expect(byStatus('conflict')).toBe(overlap.sharedOrders);                                    // one of each pair of devices registering the same order loses and gets a conflict, never a second order
    expect(byStatus('duplicate')).toBe(overlap.sharedSpecimens + overlap.sharedCashDays);       // the same specimen / the same cash day from two devices: applied once, the other is a duplicate
    expect(byStatus('accepted') + byStatus('duplicate') + byStatus('conflict')).toBe(allOps.length);
    expect(events).toHaveLength(byStatus('accepted'));                                          // every accepted operation applied exactly once, nothing else was applied
    for (const [opId, row] of ledger) expect(row.status, opId).toBe(results.get(opId).status);   // the ledger says what the device was told

    // overlap of patients and orders: one patient row per distinct patient of an ACCEPTED registration, one order per accepted registration
    const accepted = allOps.filter((o) => o.kind === 'registration' && results.get(o.op.op_id).status === 'accepted');
    const orders = Number((await ownerRows(`SELECT count(*)::int AS n FROM sync2_test.s5_order WHERE order_key LIKE $1`, [`${run}-%`]))[0].n);
    const patients = Number((await ownerRows(`SELECT count(*)::int AS n FROM sync2_test.s5_patient WHERE patient_key LIKE $1`, [`${run}-%`]))[0].n);
    expect(orders).toBe(accepted.length);
    expect(patients).toBe(new Set(accepted.map((o) => (o.op.payload as any).patient_key)).size);
    expect(patients).toBeLessThan(accepted.length);                                              // patients really overlapped across devices

    // (c) receipt numbers: unique, gap free 1..N in server arrival order, provisional -> final mapping unique and complete
    const receiptOps = allOps.filter((o) => o.kind === 'receipt');
    const nos = await receiptNos(series);
    expect(nos).toHaveLength(receiptOps.length);
    expect(nos).toEqual(Array.from({ length: receiptOps.length }, (_, i) => i + 1));
    const finals = receiptOps.map((o) => results.get(o.op.op_id).number_mappings?.[0]?.final_number);
    expect(finals.every((f) => typeof f === 'string')).toBe(true);
    expect(new Set(finals).size).toBe(finals.length);
    const provisionals = receiptOps.map((o) => results.get(o.op.op_id).number_mappings[0].provisional_number);
    expect(new Set(provisionals).size).toBe(provisionals.length);
    expect(provisionals.every((p: string) => /^OFF-/.test(p))).toBe(true);

    // (d) connections: ONE session per batch in flight (+ the 4 of the owner side pool and the sampler's own); never a per operation connection
    expect(maxSessions - baseline).toBeLessThanOrEqual(LOAD.concurrency);
    // (e) p95 batch time inside the bound written in the notes
    expect(times).toHaveLength(LOAD.devices * (LOAD.opsPerDevice / LOAD.batchSize));
    expect(percentile(times, 0.95)).toBeLessThanOrEqual(P95_BATCH_MS_BOUND);
    // devices were marked synced
    const synced = Number((await ownerRows(`SELECT count(*)::int AS n FROM core.sync_device WHERE id = ANY($1::uuid[]) AND last_sync_at IS NOT NULL`, [plans.map((p) => p.deviceId)]))[0].n);
    expect(synced).toBe(LOAD.devices);
  }, T);
});

describe('rate limits and retry_after are honoured by a device after an outage', () => {
  it('200 devices against a tenant limit of 120 batches a minute: the surplus gets 429 with retry_after, honouring it everything lands once inside 5 simulated minutes', async () => {
    const series = `S5R-${run}`;
    const H = syncEngine(series, { tenantBatchesPerMinute: 120, deviceBatchesPerMinute: 30 });
    const { plans } = await buildPlans(`${run}r`, 200, 5, 11);
    let clock = NOW.getTime();
    const waiting = plans.map((p) => ({ p, at: clock, tries: 0 }));
    const limited: number[] = []; const done = new Set<string>(); const earlyRefused: boolean[] = [];
    const results = new Map<string, any>();
    while (waiting.length) {
      waiting.sort((a, b) => a.at - b.at);
      const w = waiting.shift()!;
      clock = Math.max(clock, w.at);
      const o = await devicePush(H, A1, w.p.deviceId, w.p.ops.map((x) => x.op), { now: new Date(clock) });
      w.tries += 1;
      if (o.error) {
        expect(code(o)).toBe('common.rate_limited');
        const ra = (o.error as any).retryAfterSeconds as number;
        expect(ra).toBeGreaterThan(0); expect(ra).toBeLessThanOrEqual(60);
        limited.push(ra);
        if (earlyRefused.length < 3) {                                                       // a retry BEFORE retry_after is refused again: the server really enforces the wait
          const early = await devicePush(H, A1, w.p.deviceId, w.p.ops.map((x) => x.op), { now: new Date(clock + Math.max(0, ra - 2) * 1000) });
          earlyRefused.push(code(early) === 'common.rate_limited');
        }
        w.at = clock + ra * 1000; waiting.push(w);
        expect(w.tries).toBeLessThan(20);                                                    // honouring retry_after converges
        continue;
      }
      for (const r of okBody(o).results) { results.set(r.op_id, r); }
      done.add(w.p.deviceId);
    }
    expect(limited.length).toBeGreaterThan(0);                                               // 200 batches in one window against a limit of 120: the limit really bit
    expect(earlyRefused.length).toBeGreaterThan(0); expect(earlyRefused.every(Boolean)).toBe(true);
    expect(done.size).toBe(200);
    expect(clock - NOW.getTime()).toBeLessThanOrEqual(5 * 60_000);
    const ids = plans.flatMap((p) => p.ops.map((x) => x.op.op_id));
    expect(results.size).toBe(ids.length);
    expect((await ledgerOf(ids))).toHaveLength(ids.length);                                  // a refused (429) batch left nothing behind, a retried one landed once
    expect((await eventsOf(ids)).length).toBe([...results.values()].filter((r) => r.status === 'accepted').length);
  }, T);

  it('a device that is revoked while its backlog waits is refused after the outage and nothing is applied', async () => {
    const series = `S5V-${run}`;
    const H = syncEngine(series);
    const dev = await newDevice(A1);
    okBody(await revoke(A1, dev));
    const op = { op_id: uid(), op_type: 'result.enter', payload: { value: 1 }, device_created_at: '2026-11-17T08:00:00Z' };
    const o = await devicePush(H, A1, dev, [op]);
    expect(code(o)).toBe('sync.device_revoked');
    expect(await ledgerOf([op.op_id])).toEqual([]);
    expect(await eventsOf([op.op_id])).toEqual([]);
  }, T);
});
