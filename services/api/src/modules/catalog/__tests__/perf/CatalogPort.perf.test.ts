// T-28a (C3) — performance targets of the real CatalogPort over the in-memory SQL fake (03-IC §4.2 "Performance"; 02-TRD §12; PRD AC-19.4):
//   p95 <= 20 ms per call with a warm cache; resolveOrderables <= 50 ms for 50 orderables; cold-cache getTest <= 60 ms [CONV].
// The fake yields one event-loop turn per statement, so these bound the number of round trips and the per-call CPU, not Postgres itself. Real-DB load: T-37.
import { describe, expect, it } from 'vitest';
import { TENANT_A, av, setup28a, one, SERUM, BIOC, T, NOW, RHB, LAB, HP_ELITE_M, type Rows } from '../helpers/t28a.js';
import { ana, pmb, pnl, tsr, tst } from '../helpers/testsDb.js';

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
async function timed(n: number, fn: () => Promise<unknown>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const t0 = performance.now(); await fn(); out.push(performance.now() - t0); }
  return out;
}

/** 50 orderables: 30 tests (2 analytes each, serum) + 20 panels of 3 of those tests. */
function world50() {
  const tests = Array.from({ length: 30 }, (_v, i) => tst(200 + i, TENANT_A, BIOC.id, { code: `PT${i}`, name: `Perf test ${i}` }));
  const panels = Array.from({ length: 20 }, (_v, i) => pnl(200 + i, TENANT_A, { code: `PP${i}`, name: `Perf panel ${i}` }));
  const analytes = tests.flatMap((t, i) => [ana(200 + 2 * i, TENANT_A, t.test.id, { code: `PA${i}A`, sort_order: 1 }), ana(201 + 2 * i, TENANT_A, t.test.id, { code: `PA${i}B`, sort_order: 2 })]);
  const rows: Rows = {
    orderables: [...tests.map((t) => t.orderable), ...panels.map((p) => p.orderable)], tests: tests.map((t) => t.test), panels: panels.map((p) => p.panel),
    panel_members: panels.flatMap((p, i) => [0, 1, 2].map((k) => pmb(p.panel.id, tests[(i + k) % 30]!.test.id, TENANT_A, k + 1))),
    test_specimen_types: tests.map((t) => tsr(t.test.id, SERUM.id, TENANT_A, { is_preferred: true })),
    analytes, analyte_versions: analytes.map((a, i) => av(200 + i, TENANT_A, a['id'])),
  };
  return { rows, ids: [...tests.map((t) => t.test.id), ...panels.map((p) => p.panel.id)] };
}

describe('CatalogPort performance (AC-19.4)', () => {
  it('warm cache: p95 <= 20 ms for getTest, getPanel, referenceRangeFor, criticalLimitsFor (100 calls each, one request per call)', { timeout: 60_000 }, async () => {
    const env = setup28a();
    const calls: Array<[string, unknown]> = [['getTest', { testId: LAB.test.id }], ['getPanel', { panelId: HP_ELITE_M.panel.id }],
      ['referenceRangeFor', { analyteId: RHB.id, sex: 'male', ageDays: 400, at: NOW }], ['criticalLimitsFor', { analyteId: RHB.id, sex: 'male', ageDays: 400, at: NOW }]];
    for (const [m, i] of calls) await one(env, m, i);                                   // warm
    for (const [m, i] of calls) expect(p95(await timed(100, () => one(env, m, i))), m).toBeLessThanOrEqual(20);
  });

  it('resolveOrderables for 50 orderables (30 tests + 20 panels) <= 50 ms at p95, warm; the answer is complete', { timeout: 60_000 }, async () => {
    const { rows, ids } = world50();
    const env = setup28a({ extra: rows });
    const input = { orderableIds: ids };
    const r = await one(env, 'resolveOrderables', input);                              // cold + warm-up
    expect(r.orderables).toHaveLength(50);
    expect(r.tests).toHaveLength(30);
    expect(r.specimenRequirements.flatMap((g: any) => g.testIds)).toHaveLength(30);
    expect(p95(await timed(40, () => one(env, 'resolveOrderables', input)))).toBeLessThanOrEqual(50);
  });

  it('cold cache: getTest <= 60 ms (CONV: three indexed queries); a fresh cache per sample', { timeout: 60_000 }, async () => {
    const samples: number[] = [];
    await one(setup28a(), 'getTest', { testId: LAB.test.id });                        // JIT warm-up, not sampled
    for (let i = 0; i < 15; i++) {
      const env = setup28a();
      const t0 = performance.now();
      await one(env, 'getTest', { testId: LAB.test.id });
      samples.push(performance.now() - t0);
    }
    expect(p95(samples)).toBeLessThanOrEqual(60);
  });

  it('cold resolveOrderables for 50 orderables loads each entity once: statement count is independent of how often a test repeats', { timeout: T }, async () => {
    const { rows, ids } = world50();
    const env = setup28a({ extra: rows });
    const from = env.db.stmts.length;
    await one(env, 'resolveOrderables', { orderableIds: ids });
    const once = env.db.stmts.length - from;
    const env2 = setup28a({ extra: rows });
    const from2 = env2.db.stmts.length;
    await one(env2, 'resolveOrderables', { orderableIds: [...ids, ...ids, ...ids] });
    expect(env2.db.stmts.length - from2).toBe(once);                                  // no per-id round trips (N+1)
    expect(once).toBeLessThan(40);                                                    // 50 orderables, bounded round trips (an N+1 would be >= 100)
  });
});
