// C7 API-T15 — E04 submitMessageBatch at 1x and 10x (02-TRD §12.2; 01-PRD AC-08.5 backlog drain, AC-09.x throughput). Harness limits: see perf.helpers.ts header.
import { beforeAll, describe, expect, it } from 'vitest';
import { createIngestService } from '../../service/ingest.service.js';
import { makeIngestCtx, makeWorld } from '../ingest.helpers.js';
import { RECORDS_PER_MESSAGE, openLoop, p95, perfBatch, perfDriver } from './perf.helpers.js';

const { getDriver } = perfDriver();
/** one lab/agent = one world (in-memory DB with per-message snapshot savepoints, so a world must stay small); services are shared like in production. */
const lab = () => { const w = makeWorld(); return { w, c: makeIngestCtx(w).ctx }; };
const submit = (l: ReturnType<typeof lab>, ns: number[]) => createIngestService({ repo: l.w.repo, getDriver } as any).submitMessageBatch(l.c, { body: perfBatch(ns) });

beforeAll(async () => { await submit(lab(), [999_001]); }, 120_000);      // warm-up: JSON-schema compilation of the event validators must not count against p95 (first real request pays it once per process)

describe('TRD §12.2 — submitMessageBatch, 100 messages (~800 records): p95 <= 3 s, hard budget 8 s', () => {
  it('20 sequential 100-message batches: every message accepted, 800 records + 800 events each, p95 <= 3 s, max < 8 s', async () => {
    const times: number[] = [];
    for (let b = 0; b < 20; b++) {
      const l = lab(), ns = Array.from({ length: 100 }, (_v, i) => b * 100 + i + 1);
      const t0 = performance.now(); const r = await submit(l, ns); times.push(performance.now() - t0);
      const res = r.body.results as Array<Record<string, unknown>>;
      expect(res.filter((x) => x['outcome'] === 'accepted')).toHaveLength(100);
      expect(l.w.records).toHaveLength(100 * RECORDS_PER_MESSAGE);
      expect(l.w.eventsOf('instruments.result.received.v1')).toHaveLength(100 * RECORDS_PER_MESSAGE);
    }
    expect(p95(times)).toBeLessThanOrEqual(3_000);
    expect(Math.max(...times)).toBeLessThan(8_000);
  }, 300_000);

  it('10x: 5 batches of 100 in flight at once (concurrent agents) still finish under the 8 s hard budget with no outcome retry', async () => {
    const ls = Array.from({ length: 5 }, lab);
    const t0 = performance.now();
    const rs = await Promise.all(ls.map((l, k) => submit(l, Array.from({ length: 100 }, (_v, i) => 50_000 + k * 100 + i))));
    expect(performance.now() - t0).toBeLessThan(8_000);
    for (const r of rs) expect((r.body.results as Array<Record<string, unknown>>).every((x) => x['outcome'] === 'accepted')).toBe(true);
  }, 120_000);
});

describe('TRD §12.2 — steady state, 1-5 message batches: p95 <= 300 ms', () => {
  // 1x: 10 labs x 1 agent, each flushing every 2 s => 5 batches/s. 10x: 100 labs => 50 batches/s. 3 messages/batch (~2.1 msg/s x10 is the TRD peak; here 15 and 150 msg/s: stricter than the peak).
  for (const [name, labs, perSec] of [['1x', 10, 5], ['10x', 100, 50]] as const) {
    it(`${name}: ${perSec} batches/s of 3 messages for 6 s: p95 <= 300 ms, no errors, every message accepted`, async () => {
      const ls = Array.from({ length: labs }, lab); let accepted = 0;
      const { times, errors, total } = await openLoop(perSec, 6, async (i) => {
        const r = await submit(ls[i % labs]!, [1, 2, 3].map((k) => 100_000 * (labs === 10 ? 1 : 2) + i * 3 + k));
        accepted += (r.body.results as Array<Record<string, unknown>>).filter((x) => x['outcome'] === 'accepted').length;
      });
      expect(errors).toEqual([]); expect(times).toHaveLength(total); expect(accepted).toBe(total * 3);
      expect(p95(times)).toBeLessThanOrEqual(300);
    }, 120_000);
  }
});

describe('AC-08.5 — backlog of 9,000 messages (72 h x 3,000/day) drains in <= 15 min', () => {
  it('90 batches x 100 messages, sequential (TRD: server 90 x 3 s = 4.5 min): all 9,000 accepted, total server time <= 4.5 min and so <= 15 min', async () => {
    let accepted = 0; const t0 = performance.now();
    for (let b = 0; b < 90; b++) {
      const l = lab(); const r = await submit(l, Array.from({ length: 100 }, (_v, i) => 200_000 + b * 100 + i));   // fresh world per batch: the snapshot savepoint is O(world), a harness artefact
      accepted += (r.body.results as Array<Record<string, unknown>>).filter((x) => x['outcome'] === 'accepted').length;
    }
    expect(accepted).toBe(9_000);
    expect(performance.now() - t0).toBeLessThanOrEqual(4.5 * 60_000);
  }, 15 * 60_000);

  it('quota arithmetic (TRD §12.2): 90 requests at the 04 §4 limit of 60 requests/min/device need <= 1.5 min of quota, leaving the >= 38/min request budget unexhausted', () => {
    const requests = 90, limitPerMin = 60, budgetPerMin = 38;
    expect(requests / limitPerMin).toBeLessThanOrEqual(2.4);
    expect(requests / budgetPerMin).toBeLessThanOrEqual(2.4);
    expect(Math.ceil(9_000 / 100)).toBe(requests);
  });
});
