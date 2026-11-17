// C6-T14 load — done_when: "200-id load <= 8 s p95" (02-TRD §11: 200 x (getReleaseEligibility <= 15 ms + update/publish ~ 10 ms) ~ 5 s; p95 <= 8 s per request [CONV]).
// Latency is injected into the fakes: BillingPort 15 ms per call, 2 ms per write statement (update / insert / enqueue ~ 5 per release = ~10 ms). So the target is only met by an
// implementation that does ONE eligibility call and a constant number of statements per id (no N+1 re-reads, no per-id extra round trips beyond rules 1-6) and does not add its own waits.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { bulkSetup, callBulk, countBy, idsOf, many, sleep } from './bulk-release.helpers.js';

let manifest: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t14l-')), 'otp.key'); writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev'; delete process.env.NODE_ENV; delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
}, 90_000);

const RUNS = 5; const BUDGET_MS = 8000;
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1]!;

describe('load: bulk release of 200 ids', () => {
  it('self-check: injected latency is accurate (mean sleep(2) < 4 ms, mean sleep(15) < 17 ms)', async () => {
    const mean = async (ms: number) => { const t0 = performance.now(); for (let k = 0; k < 50; k++) await sleep(ms); return (performance.now() - t0) / 50; };
    expect(await mean(2)).toBeLessThan(4); expect(await mean(15)).toBeLessThan(17);
  });

  it(`${RUNS} consecutive 200-id requests (20 with dues) each answer correctly and p95 latency <= ${BUDGET_MS} ms`, async () => {
    const times: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const dues = Array.from({ length: 20 }, (_, k) => k * 10 + 5);
      const s = bulkSetup({ items: many(200), dues, billingMs: 15, queryMs: 2, fastSavepoints: true });
      const t0 = performance.now(); const r = await callBulk(manifest, s, { ids: idsOf(200) }); times.push(performance.now() - t0);
      expect(r.status).toBe(200); expect(r.body.results).toHaveLength(200); expect(countBy(r, 'released')).toBe(180); expect(countBy(r, 'blocked_due')).toBe(20);
      expect(s.billing.calls).toHaveLength(200);                    // exactly one eligibility call per id
      expect(s.published).toHaveLength(180); expect(s.jobs()).toHaveLength(180);
    }
    const worst = Math.max(...times);
    expect(p95(times), `latencies ms: ${times.map((t) => Math.round(t)).join(', ')} (max ${Math.round(worst)})`).toBeLessThanOrEqual(BUDGET_MS);
  }, 180_000);

  it('statements per id are bounded: a 200-id request issues at most 20 statements per id (no N+1 growth)', async () => {
    const s = bulkSetup({ items: many(200) }); const before = s.db.stmts.length; const r = await callBulk(manifest, s, { ids: idsOf(200) });
    expect(r.status).toBe(200); expect(countBy(r, 'released')).toBe(200);
    const per = (s.db.stmts.length - before) / 200; expect(per).toBeGreaterThanOrEqual(5); expect(per).toBeLessThanOrEqual(20);
  }, 60_000);

  it('the cost is linear: 200 ids take less than 6x the time of 50 ids (nothing quadratic such as a full re-scan per id)', async () => {
    const time = async (n: number) => { const s = bulkSetup({ items: many(n), billingMs: 15, queryMs: 2, fastSavepoints: true }); const t0 = performance.now(); const r = await callBulk(manifest, s, { ids: idsOf(n) }); const dt = performance.now() - t0; expect(countBy(r, 'released')).toBe(n); return dt; };
    await time(10); const a = await time(50); const b = await time(200); expect(b).toBeLessThan(a * 6);
  }, 120_000);
});
