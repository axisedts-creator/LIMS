// C7 API-T10 — AC-10.5: server-side handling of E05 p95 <= 500 ms (02-TRD §12) at reference load. In-process fakes with a simulated 5 ms C5 round trip per barcode;
// this guards the service's own overhead (no N+1, no serial blow-up). The full load run at 1x/10x is API-T15.
import { describe, expect, it } from 'vitest';
import { AN, TEST, hqBody, hqSetup, queryBytes, type LabEntry } from './hostQuery.helpers.js';
import { createHostQueryService } from '../service/hostQuery.service.js';

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

describe('AC-10.5 — E05 p95 <= 500 ms', () => {
  it('200 queries x 3 barcodes (each with 2 mapped analytes), 10 in flight: p95 <= 500 ms and every one answered', async () => {
    const codes = ['E2600000100', 'E2600000101', 'E2600000102'];
    const lab: Record<string, LabEntry> = Object.fromEntries(codes.map((c) => [c, { tests: [{ testId: TEST.glu, analyteIds: [AN.glu] }, { testId: TEST.elec, analyteIds: [AN.na] }] }]));
    const s = hqSetup({ lab, labDelayMs: 5 });
    const svc = createHostQueryService({ repo: s.repo, getDriver: s.driver.getDriver });
    const times: number[] = []; let ok = 0;
    const one = async (n: number) => {
      const raw = queryBytes(...codes, `E26${String(n).padStart(8, '0')}`.slice(0, 11));      // unique bytes per query (4th barcode: not found)
      const t0 = performance.now();
      const r = await svc.submitHostQuery(s.ctx, { body: hqBody({ n: 1000 + n, raw }) });
      times.push(performance.now() - t0);
      if (r.status === 200 && (r.body as any).answer_summary.length === 4) ok++;
    };
    for (let i = 0; i < 200; i += 10) await Promise.all(Array.from({ length: 10 }, (_v, k) => one(i + k)));
    expect(ok).toBe(200);
    expect(p95(times)).toBeLessThanOrEqual(500);
  }, 60_000);

  it('a single 50-barcode query is answered inside the 500 ms budget', async () => {
    const codes = Array.from({ length: 50 }, (_v, i) => `E26${String(i).padStart(8, '0')}`);
    const s = hqSetup({ lab: Object.fromEntries(codes.map((c) => [c, { tests: [{ testId: TEST.glu, analyteIds: [AN.glu] }] } as LabEntry])), labDelayMs: 2 });
    const svc = createHostQueryService({ repo: s.repo, getDriver: s.driver.getDriver });
    const t0 = performance.now();
    const r = await svc.submitHostQuery(s.ctx, { body: hqBody({ raw: queryBytes(...codes) }) });
    expect(performance.now() - t0).toBeLessThanOrEqual(500);
    expect((r.body as any).answer_summary).toHaveLength(50);
  });
});
