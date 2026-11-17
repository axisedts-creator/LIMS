// C7 API-T15 — E05 submitHostQuery (AC-10.5, p95 <= 500 ms) and E03 submitAgentHeartbeat (p95 <= 100 ms) at 1x and 10x (02-TRD §12.1/§12.2). Harness limits: see perf.helpers.ts header.
import { describe, expect, it } from 'vitest';
import { createHeartbeatService } from '../../service/heartbeat.service.js';
import { createHostQueryService } from '../../service/hostQuery.service.js';
import { activeAgent, heartbeatBody, makeDeviceCtx, makeRepo } from '../device.helpers.js';
import { AN, TEST, hqBody, hqSetup, queryBytes, type LabEntry } from '../hostQuery.helpers.js';
import { openLoop, p95 } from './perf.helpers.js';

describe('AC-10.5 — E05 submitHostQuery server-side p95 <= 500 ms at reference load', () => {
  // TRD §12.1: peak 2.1 msg/s over 10 labs (1x); 21/s at 10x. Every message here is a host query (worst case). LabPort simulated at 20 ms (TRD allows <= 300 ms), 3 barcodes x 2 analytes each.
  for (const [name, perSec] of [['1x', 2.1], ['10x', 21]] as const) {
    it(`${name}: ${perSec} queries/s for 8 s: all answered (200, 3 answers), p95 <= 500 ms`, async () => {
      const codes = ['E2600000100', 'E2600000101', 'E2600000102'];
      const lab: Record<string, LabEntry> = Object.fromEntries(codes.map((c) => [c, { tests: [{ testId: TEST.glu, analyteIds: [AN.glu] }, { testId: TEST.elec, analyteIds: [AN.na] }] }]));
      const s = hqSetup({ lab, labDelayMs: 20 });
      const svc = createHostQueryService({ repo: s.repo, getDriver: s.driver.getDriver });
      let ok = 0;
      const { times, errors, total } = await openLoop(perSec, 8, async (i) => {
        const r = await svc.submitHostQuery(s.ctx, { body: hqBody({ n: 10_000 + i + (name === '10x' ? 5_000 : 0), raw: queryBytes(...codes, `X${name}${i}`.slice(0, 11)) }) });   // unique bytes each; 4th barcode: not found
        if (r.status === 200 && (r.body as any).answer_summary.length === 4) ok++;
      });
      expect(errors).toEqual([]); expect(ok).toBe(total); expect(times).toHaveLength(total);
      expect(p95(times)).toBeLessThanOrEqual(500);
    }, 120_000);
  }
});

describe('TRD §12.2 — E03 submitAgentHeartbeat p95 <= 100 ms', () => {
  // TRD §12.1: 200 agents x 1/min = 3.3 req/s (1x); 2,000 agents = 33 req/s (10x).
  for (const [name, perSec] of [['1x', 3.3], ['10x', 33]] as const) {
    it(`${name}: ${perSec} heartbeats/s for 8 s: all 200, p95 <= 100 ms`, async () => {
      const f = makeRepo({ agents: [activeAgent()] });
      const svc = createHeartbeatService({ repo: f.repo as any });
      const ctx = makeDeviceCtx({}).ctx; let ok = 0;
      const { times, errors, total } = await openLoop(perSec, 8, async () => { const r = await svc.submitAgentHeartbeat(ctx, { body: heartbeatBody() }); if (r.status === 200) ok++; });
      expect(errors).toEqual([]); expect(ok).toBe(total);
      expect(p95(times)).toBeLessThanOrEqual(100);
    }, 60_000);
  }
});
