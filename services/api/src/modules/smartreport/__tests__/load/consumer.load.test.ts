// C14 T25 — load: event consumer p95 <= 20 ms at 17 events/s, 1x and 10x seed, two tenants (02-TRD §8.2, §11; 07-SECURITY row 025).
// Drives the REAL worker consumers (services/worker/src/jobs/smartreport) through the real C0 wrapper on the core fake DB, reusing the T14 fakes; the
// consumer handlers live in the worker package, the T25 files path is the API load folder, so the worker modules are imported by relative path.
// Latency is VIRTUAL (see load.helpers.ts): per-event duration = real time inside the handler + the budget of each statement the consumer issued (read it from the T14 call log).
// 17 events/s = deterministic arrivals every 1000/17 ms into ONE consumer slot (worst case, graphile concurrency is higher); sojourn = queue wait + service.
import { performance } from 'node:perf_hooks';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../repository/summaries.repo.js', async (orig) => ({ ...(await orig<any>()), ...(await import('../../../../../../worker/src/jobs/smartreport/__tests__/t14.fakes.js')).summariesRepo }));
vi.mock('../../repository/reviews.repo.js', async (orig) => ({ ...(await orig<any>()), ...(await import('../../../../../../worker/src/jobs/smartreport/__tests__/t14.fakes.js')).reviewsRepo }));
vi.mock('../../repository/library.repo.js', async (orig) => ({ ...(await orig<any>()), getApprovedLibraryVersion: async (rc: any) => ({ id: 'lib-approved', tenant_id: rc.tenantId, status: 'approved' }) }));
vi.mock('../../summary.service.js', async (orig) => ({ ...(await orig<any>()), ...(await import('../../../../../../worker/src/jobs/smartreport/__tests__/t14.fakes.js')).summaryService }));

import { setup, type Setup } from '../../../../../../worker/src/core/__tests__/helpers.js';
import { manifest } from '../../../../../../worker/src/jobs/smartreport/index.js';
import { R, TA, TB, amendedEnvelope, approvedEnvelope, reset, store, summaryRow, withPorts } from '../../../../../../worker/src/jobs/smartreport/__tests__/t14.fakes.js';
import { fmt, pct } from './load.helpers.js';

const RATE = 17;                                  // events per second (02-TRD §11 peak)
const BUDGET_MS = 20;
const EVENTS = RATE * 60;                         // one minute of peak traffic
/** Virtual cost (ms) of each step the consumer takes, from the T14 call log; wrapper = inbox dedupe + commit round trips of the C0 consumer wrapper. */
const STEP_MS: Record<string, number> = { lock: 0.5, getLive: 1, update: 2, review: 1, enqueue: 1, build: 0 };
const WRAPPER_MS = 2;
const uid = (n: number) => `0190c514-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const TENANTS = [TA, TB] as const;

let s: Setup;
/** Real time spent inside the smartreport handler itself (the C0 wrapper + core fake DB around it are emulation overhead, replaced by WRAPPER_MS). */
let handlerMs = 0;
const timedManifest = <M extends { subscriptions?: Record<string, any>; tasks?: Record<string, any> }>(m: M): M => {
  const wrap = (h: (a: any, c: any) => Promise<void>) => async (a: any, c: any) => { const t = performance.now(); try { return await h(a, c); } finally { handlerMs = performance.now() - t; } };
  const map = (o?: Record<string, any>) => Object.fromEntries(Object.entries(o ?? {}).map(([k, h]) => [k, wrap(h)]));
  return { ...m, subscriptions: map(m.subscriptions), tasks: map(m.tasks) } as M;
};
const settle = (p: Promise<unknown>) => p.then(() => undefined, (e) => e as Error);

describe.each([[1, 500], [10, 5000]] as const)('C14-T25 consumer load — %dx seed (%d live summaries per tenant, tenants A + B)', (x, perTenant) => {
  const orderOf = (tenant: string, i: number) => uid((tenant === TA ? 0x700000 : 0x800000) + i);
  const tenantOfOrder = new Map<string, string>();
  const durations: number[] = [], parts: [number, number][] = [];
  const kinds: ('approved' | 'amended')[] = [];
  let changing = 0, stats = { superseded: 0, wall: 0 };

  beforeAll(async () => {
    reset();
    s = await setup([withPorts(timedManifest(manifest as any))]);
    // even-index orders hold hgb:1 (outdated by an amend to v2 or by an unknown approved result); odd-index orders already hold hgb:2 (an amend to v2 is a no-op)
    for (const tenant of TENANTS) for (let i = 0; i < perTenant; i++) {
      const order = orderOf(tenant, i); tenantOfOrder.set(order, tenant);
      store.summaries.push(summaryRow({ id: uid((tenant === TA ? 0x900000 : 0xa00000) + i), tenant_id: tenant, order_id: order, version: 3,
        input_result_versions: [`${R.hgb}:${i % 2 === 0 ? 1 : 2}`, `${R.wbc}:1`] }));
    }
    const t0 = performance.now();
    const nth = { [TA]: 0, [TB]: 0 } as Record<string, number>, nthChanging = { [TA]: 0, [TB]: 0 } as Record<string, number>;
    for (let k = 0; k < EVENTS; k++) {
      const tenant = TENANTS[k % 2]!, kind = k % 4 < 2 ? 'approved' : 'amended';
      const isChanging = k % 3 === 0;                                   // one in three events outdates its summary (each on its own order), the rest are no-ops
      const c = nth[tenant]!++;
      const orderIdx = isChanging ? 2 * nthChanging[tenant]!++ : kind === 'approved' ? 400 + 2 * (c % 50) : 1 + 2 * (c % 100);
      const orderId = orderOf(tenant, orderIdx);
      const eventId = uid(0xb00000 + k);
      const env = kind === 'approved'
        ? approvedEnvelope({ eventId, orderId, tenant, resultId: isChanging ? uid(0xc00000 + k) : R.hgb })
        : amendedEnvelope({ eventId, orderId, tenant, resultId: R.hgb, newVersion: 2 });
      s.world.seedEvent(env);
      const before = store.calls.length, c0 = performance.now(); handlerMs = 0;
      const err = await settle(s.run(`evt.smartreport.${env.event_type}`, { tenant_id: tenant, event_id: eventId, event_type: env.event_type }));
      void c0; const real = handlerMs;
      expect(err, `event ${k}`).toBeUndefined();
      const virtual = WRAPPER_MS + store.calls.slice(before).reduce((a, c) => a + (STEP_MS[c] ?? 1), 0);
      durations.push(real + virtual); parts.push([real, virtual]); kinds.push(kind); if (isChanging) changing++;
    }
    stats = { superseded: store.updates.filter((u) => u.patch['status'] === 'superseded').length, wall: performance.now() - t0 };
  }, 300000);

  it(`per-event consumer time p95 <= ${BUDGET_MS} ms (one indexed read + optional update + enqueue)  [done_when]`, () => {
    console.log(`[T25 ${x}x] consumer    ${fmt(durations)}  (budget p95 <= ${BUDGET_MS}); real wall for ${EVENTS} events ${stats.wall.toFixed(0)} ms`);
    expect(durations).toHaveLength(EVENTS);
    expect(pct(durations, 0.95)).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('harness sensitivity: the same events with every round trip 4x slower (an N+1 or a slow index) must FAIL the 20 ms budget (the check is not vacuous)', () => {
    expect(pct(parts.map(([r, v]) => r + 4 * v), 0.95)).toBeGreaterThan(BUDGET_MS);
  });

  it(`at ${RATE} events/s (deterministic arrivals, one consumer slot) the sojourn time p95 stays <= ${BUDGET_MS} ms and no backlog builds`, () => {
    const gap = 1000 / RATE;
    let free = 0; const sojourn: number[] = [];
    durations.forEach((d, i) => { const arrive = i * gap, start = Math.max(arrive, free); free = start + d; sojourn.push(free - arrive); });
    console.log(`[T25 ${x}x] sojourn@${RATE}/s ${fmt(sojourn)}`);
    expect(pct(sojourn, 0.95)).toBeLessThanOrEqual(BUDGET_MS);
    expect(free - (EVENTS - 1) * gap).toBeLessThan(gap);                  // the last event finishes before the next one would have arrived
  });

  it('keeps up in real time: processing the minute of events takes < 50 % of the minute on one core (CPU headroom)', () => {
    expect(stats.wall).toBeLessThan(0.5 * (EVENTS / RATE) * 1000);
  });

  it('only changing events supersede (once each); the prebuild enqueue is deduped by job_key per order', () => {
    expect(stats.superseded).toBe(changing);
    const jobs = s.world.jobs.filter((j: any) => j.identifier === 'smartreport.prebuild_summary');
    const keys = jobs.map((j: any) => j.jobKey);
    expect(new Set(keys).size).toBe(keys.length);                         // no duplicate pending job for one order
    expect(jobs.length).toBeLessThanOrEqual(new Set([...store.liveReads.map((r) => r.orderId)]).size);
    expect(s.world.deadLetters).toHaveLength(0);
  });

  it('tenant isolation under load: each live-summary read and update carries the tenant of the event/summary; every enqueued job names its own tenant', () => {
    const bad = store.liveReads.filter((r) => tenantOfOrder.get(r.orderId) !== undefined && tenantOfOrder.get(r.orderId) !== r.tenantId);
    expect(bad).toEqual([]);
    for (const u of store.updates) expect(store.summaries.find((r) => r.id === u.id)!.tenant_id).toBe(u.tenantId);
    for (const j of s.world.jobs.filter((j: any) => j.identifier === 'smartreport.prebuild_summary')) {
      const p = typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload;
      expect(tenantOfOrder.get(p.order_id)).toBe(p.tenant_id);
    }
    expect(new Set(store.liveReads.map((r) => r.tenantId))).toEqual(new Set([TA, TB]));
      });
});
