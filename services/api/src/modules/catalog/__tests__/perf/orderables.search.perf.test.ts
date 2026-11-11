// T-06 (C3) — searchOrderables latency budget (02-TRD §12: p95 <= 150 ms; PRD AC-08.4) at 1x and 10x the catalog-size ASSUMPTION
// (<= 5,000 orderables per tenant, 02-TRD §12 "Catalog size"; 05-DoD §3.5 asks for 1x and 10x).
// In-process proxy: the SQL fake stands in for Postgres, so
//   - at 1x the TOTAL wall time per call (service + fake) must have p95 <= 150 ms;
//   - at 10x the budget is applied to SERVICE time only (total minus time spent inside tx.query), because the JS fake scans 50,000 rows linearly;
//   - at both sizes the statement count must be constant (no N+1) and the response must be bounded by the limit.
// Real-database latency is measured by the T-37 load test against the compose stack; this test catches algorithmic regressions
// (per-row lookups, ranking in O(n^2), unbounded result sets, un-limited payloads) early.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B } from '../helpers/catalogDb.js';
import { ID } from '../helpers/testsDb.js';
import { BIOC, HAEM, setup } from '../helpers/t6.js';

const NAMES = ['Complete blood count', 'Glucose fasting', 'Haemoglobin A1c', 'Thyroid stimulating hormone', 'Liver function panel', 'Culture and sensitivity'];
function bulk(count: number, tenant: string, offset = 0) {
  const orderables: Record<string, unknown>[] = []; const tests: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const id = ID(0x100000 + offset + i);
    orderables.push({ id, tenant_id: tenant, kind: 'test', code: `C${String(offset + i).padStart(5, '0')}`, name: `${NAMES[i % NAMES.length]} ${i}`, department_id: i % 2 ? HAEM.id : BIOC.id, is_active: i % 17 !== 0 });
    tests.push({ id, tenant_id: tenant, workflow_type: 'standard' });
  }
  return { orderables, tests };
}
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

describe.each([[1, 5_000], [10, 50_000]])('searchOrderables at %ix (%i orderables for the tenant + the same again for another tenant)', (factor, count) => {
  it(`p95 within budget, constant statement count, bounded response`, { timeout: 120_000 }, async () => {
    const a = bulk(count, TENANT_A); const b = bulk(count, TENANT_B, count);
    const e = setup({ t6: { orderables: [...a.orderables, ...b.orderables] as never, tests: [...a.tests, ...b.tests] as never } });
    const queries = ['c0', 'complete', 'glu', 'C00012', 'zzz-no-match', 'a', 'blood count 5', '100%'];
    const total: number[] = []; const service: number[] = []; const stmtCounts = new Set<number>();
    for (let round = 0; round < 4; round++) {
      for (const q of queries) {
        let inDb = 0;
        const before = e.db.stmts.filter((s) => s.tenantId === TENANT_A).length;
        const t0 = performance.now();
        const r = await e.db.run((ctx) => {
          const tx = ctx.tx as { query: (...a: any[]) => Promise<any> };
          const orig = tx.query.bind(tx);
          tx.query = async (...args: any[]) => { const s = performance.now(); try { return await orig(...args); } finally { inDb += performance.now() - s; } };
          return e.svc['searchOrderables']!(ctx, { q });
        });
        const dt = performance.now() - t0;
        total.push(dt); service.push(dt - inDb);
        stmtCounts.add(e.db.stmts.filter((s) => s.tenantId === TENANT_A).length - before);
        expect(r.data.length).toBeLessThanOrEqual(20);
        expect(JSON.stringify(r)).not.toContain(TENANT_B);
        if (q === 'C00012') expect(r.data[0]?.code).toBe('C00012');
      }
    }
    expect(Math.max(...stmtCounts), `statement counts ${[...stmtCounts]}`).toBeLessThanOrEqual(4);
    expect(Math.max(...stmtCounts) - Math.min(...stmtCounts)).toBeLessThanOrEqual(1);   // constant: independent of q and of result size
    if (factor === 1) expect(p95(total), `total p95 ${p95(total).toFixed(1)} ms`).toBeLessThanOrEqual(150);
    expect(p95(service), `service-only p95 ${p95(service).toFixed(1)} ms`).toBeLessThanOrEqual(150);
  });
});
