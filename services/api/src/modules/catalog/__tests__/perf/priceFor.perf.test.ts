// T-37 (C3) — CatalogPort.priceFor latency budget at 1x and 10x catalog size (02-TRD §12: port p95 <= 20 ms warm; PRD AC-19.4; 05-DoD §3.5 asks for 1x and 10x).
// 1x = the §12 ASSUMPTION (<= 5,000 orderables, one published default-list version holding 5,000 items); 10x = 50,000. Tenant B holds the same again (isolation under load).
// In-process proxy: the SQL fake stands in for Postgres (and scans linearly), so
//   - the 20 ms budget is applied to SERVICE time only (total minus time spent inside tx.query) at BOTH sizes: the JS fake scans the item table linearly
//     (measured ~275 ms per call at 1x), so total wall time says nothing about the service or about Postgres;
//   - at both sizes the statement count per call is constant (no per-item lookups) and the answer is correct.
// Real-database latency is measured by the k6-style script against the compose stack [PIN-C0] (02-TRD §12 "Load test"); not runnable here.
import { describe, expect, it } from 'vitest';
import { A, TENANT_B, VD, VB, call, iso, NOW, query, setup28b, item, orderable, pitem } from '../helpers/t28b.js';

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
const PRICE = (i: number) => 10_000 + (i % 977) * 100;                                  // paise, deterministic per orderable

function bulk(count: number) {
  const orderables = Array.from({ length: count }, (_v, i) => orderable(1000 + i, A, { code: `PF${String(i).padStart(5, '0')}`, kind: 'test' }));
  const items = orderables.map((o, i) => item(1000 + i, VD, o, PRICE(i)));
  const foreign = Array.from({ length: count }, (_v, i) => orderable(200_000 + i, TENANT_B, { code: `PB${String(i).padStart(5, '0')}`, kind: 'test' }));
  const foreignItems = foreign.map((o, i) => pitem(200_000 + i, TENANT_B, VB.id as string, o.id as string, 1));
  return { orderables, items, foreign, foreignItems };
}

describe.each([[1, 5_000], [10, 50_000]])('priceFor at %ix (%i orderables / items for the tenant + the same again for another tenant)', (factor, count) => {
  it('warm p95 within the 20 ms budget, constant statement count, correct price, no foreign data', { timeout: 180_000 }, async () => {
    void factor;
    const b = bulk(count);
    const env = setup28b({ orderables: [...b.orderables, ...b.foreign], price_list_items: [...b.items, ...b.foreignItems] });
    const picks = Array.from({ length: 40 }, (_v, k) => Math.floor((k * count) / 40));      // spread over the whole list
    const priceOf = (i: number) => call(env, (p, ctx) => p['priceFor']!(ctx, query(b.orderables[i]!.id as string)));
    for (const i of picks.slice(0, 5)) await priceOf(i);                                    // warm-up (cache + JIT), not sampled
    const service: number[] = []; const stmtCounts = new Set<number>();
    for (let round = 0; round < 2; round++) {
      for (const i of picks) {
        (globalThis as { gc?: () => void }).gc?.();                                         // keep fake-heap GC pauses out of the sample when node runs with --expose-gc
        let inDb = 0;
        const before = env.db.stmts.length;
        const t0 = performance.now();
        const q = await env.db.run((ctx) => {
          const tx = ctx.tx as { query: (...a: any[]) => Promise<any> };
          const orig = tx.query.bind(tx);
          tx.query = async (...args: any[]) => { const s = performance.now(); try { return await orig(...args); } finally { inDb += performance.now() - s; } };
          return env.port['priceFor']!(ctx, { orderableId: b.orderables[i]!.id, context: {}, priority: 'routine', at: iso(NOW) });
        }, { at: NOW });
        const dt = performance.now() - t0;
        service.push(dt - inDb);
        stmtCounts.add(env.db.stmts.length - before);
        expect(q.unitPrice).toEqual({ amountPaisa: PRICE(i), currency: 'NPR' });
        expect(JSON.stringify(q)).not.toContain(TENANT_B);
      }
    }
    expect(Math.max(...stmtCounts) - Math.min(...stmtCounts), `statement counts ${[...stmtCounts]}`).toBeLessThanOrEqual(2);   // independent of the item and of the list size
    expect(Math.max(...stmtCounts), `statement counts ${[...stmtCounts]}`).toBeLessThanOrEqual(12);                              // bounded round trips (an N+1 over items would be >> 12)
    // T-37 review item 1: 02-TRD §12 sets the same 20 ms warm p95 at 1x and 10x; no loosened 10x number. If unreachable in-process -> CR, not a looser budget.
    const budget = 20;
    expect(p95(service), `service-only p95 ${p95(service).toFixed(1)} ms (budget ${budget})`).toBeLessThanOrEqual(budget);
  });
});
