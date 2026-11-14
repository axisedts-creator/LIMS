// HC-T11 latency: A2 p95 with a 40-visit route and fakes with the spec latencies (02-TRD §13 / 01-PRD NFR: unchanged <= 500 ms, changed <= 2 s for <= 40 visits).
// Fake latencies: getOrderBalance 10 ms (03-IC §4.4), lookupSpecimens 20 ms (CR-C17-002, TRD §13 assumption), getPatientDemographicsBatch 50 ms for the batch (TRD §13 assumption). LD-156: fakes delay with a
// non-blocking timer (not a busy-spin) and only the handler call is timed (after one warm-up pull); budgets unchanged. Also guards the call shape at scale (one batch call, one lookup + one balance per visit).
// Fails now: A2 is an HC-T01 stub (501).
import { beforeAll, describe, expect, it } from 'vitest';
import { MEMBER, T, nextDay, noonOf, pull, schemaErrors, seedDevice, seedVisit, mkRoute, ensureSettings, type Fx } from './helpers.js';

const FILE = 2;
const N = 40, RUNS = 8;
const fx: Fx = { delay: { demographics: 50, balance: 10, lab: 20 } };
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1]!;

describe('A2 p95 with 40 visits', () => {
  let date: string; let device: any; let route: any; let visits: any[];
  beforeAll(async () => {
    await ensureSettings('a');
    date = nextDay(FILE);
    route = await mkRoute('a', MEMBER.a, date);
    visits = [];
    for (let i = 1; i <= N; i++) visits.push(await seedVisit('a', { route, member: MEMBER.a, seq: i, date }));
    device = await seedDevice('a');
    await go();   // LD-156: one warm-up pull before any timed run
  }, 10 * T);
  const go = (o: { cursor?: string; fx?: Fx } = {}) => pull(device.id, { now: noonOf(date), fx, ...o });

  it(`changed pull of ${N} visits: p95 of ${RUNS} runs <= 2 s; one demographics batch, ${N} lookupSpecimens, ${N} balances; every visit complete; ${N} access rows`, { timeout: 10 * T }, async () => {
    const times: number[] = [];
    let last: any;
    for (let i = 0; i < RUNS; i++) { last = await go(); times.push(last.handlerMs); }
    expect(last.status).toBe(200);
    expect(schemaErrors('SnapshotDto', last.body)).toEqual([]);
    expect(last.body.visits).toHaveLength(N);
    expect(last.body.visits.map((v: any) => v.route_sequence)).toEqual(Array.from({ length: N }, (_x, i) => i + 1));
    for (const v of last.body.visits) { expect(v.specimens).toHaveLength(2); expect(v.patient.full_name).toBeTruthy(); expect(v.balance).toBeTruthy(); }
    expect(last.probe.batch).toHaveLength(1);
    expect(last.probe.batch[0].patientIds).toHaveLength(N);
    expect(last.probe.lab).toHaveLength(N);
    expect(last.probe.balance).toHaveLength(N);
    expect(p95(times), `changed p95 ${Math.round(p95(times))} ms (runs ${times.map(Math.round)})`).toBeLessThanOrEqual(2000);
  });
  it(`unchanged pull of ${N} visits: p95 of ${RUNS} runs <= 500 ms; ${N} balance reads and nothing else`, { timeout: 10 * T }, async () => {
    const first = await go();
    const times: number[] = [];
    let last: any;
    for (let i = 0; i < RUNS; i++) { last = await go({ cursor: first.body.cursor }); times.push(last.handlerMs); }
    expect(last.body.unchanged).toBe(true);
    expect(last.body.balances).toHaveLength(N);
    expect(last.probe.batch).toHaveLength(0);
    expect(last.probe.lab).toHaveLength(0);
    expect(last.probe.balance).toHaveLength(N);
    expect(p95(times), `unchanged p95 ${Math.round(p95(times))} ms (runs ${times.map(Math.round)})`).toBeLessThanOrEqual(500);
  });
  it('a slow or failing port on one visit does not multiply the cost: 40 visits with every lookupSpecimens failing still answers 200 within the changed budget, all visits stale', { timeout: 10 * T }, async () => {
    const r = await go({ fx: { ...fx, labFails: true } });
    expect(r.handlerMs).toBeLessThanOrEqual(2000);
    expect(r.status).toBe(200);
    for (const v of r.body.visits) expect(v).toMatchObject({ specimens: [], specimens_stale: true });
  });
  it('snapshot never truncates: 60 active visits (the D-131 daily cap) are all returned (<= 60 by the contract)', { timeout: 10 * T }, async () => {
    const d2 = nextDay(FILE);
    const r2 = await mkRoute('a', MEMBER.a, d2);
    for (let i = 1; i <= 60; i++) await seedVisit('a', { route: r2, member: MEMBER.a, seq: i, date: d2 });
    const dev = await seedDevice('a');
    const r = await pull(dev.id, { now: noonOf(d2), fx: { specimens: 1 } });
    expect(r.status).toBe(200);
    expect(r.body.visits).toHaveLength(60);
    expect(schemaErrors('SnapshotDto', r.body)).toEqual([]);
  });
});
