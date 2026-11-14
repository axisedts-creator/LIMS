// C9 T-11 — integration: the REAL observation service (T-09 + reprocessPending) with the REAL run service (T-10) as RunAssembler, fake repos, real core events.publish
// (06-IMPLEMENTATION-PLAN row T-11 "integration"). PRD AC-02.4 (map created -> the pending observation is assigned into a run), AC-04.7 / 02-TRD §6.4 D-60 (history adopted: no run, no
// quality.qc_run.rejected.v1, no result hold, even for values that would reject a run). Same joining trick as run.integration.test.ts. Real PG behaviour is not covered.
// Fails now: `service.reprocessPending is not a function`.
import { describe, expect, it } from 'vitest';
import { createObservationService } from '../service/observation.service.js';
import { INS, OBS, OLD, PLN, TENANT_A, makeReprocessRepo, obsRow, seedWith, type Row } from './reprocess.helpers.js';
import { makeRunHarness } from './run.helpers.js';

function build(observations: Row[], o: { rich?: boolean } = {}) {
  const h = makeRunHarness({ now: '2026-11-13T18:30:00.000Z' });
  const rep = makeReprocessRepo(seedWith(observations, { rich: o.rich }));
  const joined = {
    ...rep.repo,
    async updateObservation(tx: any, t: string, id: string, expected: string, patch: Row) {
      const ok = await rep.repo.updateObservation(tx, t, id, expected, patch);
      if (ok && patch['status'] === 'assigned') h.state.observations.push(structuredClone(rep.byId(id)));   // the shared table: the run fake sees the member
      return ok;
    },
  };
  const service: any = createObservationService({ repo: joined as any, assembler: h.svc });
  return { h, rep, run: (scope: { instrument_id?: string; plan_id?: string }) => h.transaction(() => service.reprocessPending(h.ctx(), scope)) as Promise<any> };
}
const at = (hm: string) => `2026-11-13T${hm}:00.000Z`;
const pending = (n: number, hm: string, v: string, o: Row = {}) => obsRow(n, 'unmapped_control', { value: v, observed_at: at(hm), received_at: at(hm), instrument_result_time: at(hm), ...o });
const l2 = (n: number, hm: string, v: string, o: Row = {}) => pending(n, hm, v, { control_id_raw: 'QC-L2', control_lot_raw: null, control_level_raw: '2', ...o });

describe('AC-02.4 map created -> re-process -> assemble (real run service)', () => {
  it('two pending observations (L1, L2) become ONE accepted complete run once the map exists; both rows carry the run id', async () => {
    const t = build([pending(1, '17:59', '100.8'), l2(2, '18:05', '99.6')]);
    const res = await t.run({ instrument_id: INS(1) });
    expect(res).toMatchObject({ reclassified: 2, counts: { assigned: 2 } });
    const runs = t.h.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ plan_id: PLN(1), status: 'evaluated', outcome: 'accepted', is_complete: true });
    expect([OBS(1), OBS(2)].map((id) => t.rep.byId(id)['qc_run_id'])).toEqual([runs[0]!['id'], runs[0]!['id']]);
    expect(t.h.stored()).toEqual([]);
  });
  it('a pending observation that violates a rule is assigned and the rejected run is published exactly once; a second re-process is a no-op (no second event)', async () => {
    const t = build([pending(1, '17:59', '106.8'), l2(2, '18:09', '100.4')]);
    await t.run({ instrument_id: INS(1) });
    expect(t.h.runs()).toHaveLength(1);
    expect(t.h.runs()[0]).toMatchObject({ outcome: 'rejected', rules_violated: ['1-3s'] });
    expect(t.h.stored()).toHaveLength(1);
    const again = await t.run({ instrument_id: INS(1) });
    expect(again).toMatchObject({ reclassified: 0, unchanged: 0 });
    expect(t.h.stored()).toHaveLength(1);
    expect(t.h.runs()).toHaveLength(1);
  });
});

describe('AC-04.7 plan activation adopts history (real run service): no run, no event, no hold', () => {
  const history = () => [
    obsRow(1, 'no_plan', { value: '106.800000', observed_at: OLD, received_at: OLD, instrument_result_time: OLD }),                                                                // z 3.4: would reject a run
    obsRow(2, 'no_plan', { control_id_raw: 'QC-L2', control_lot_raw: null, control_level_raw: '2', value: '100.400000', observed_at: '2026-09-01T08:09:00.000Z', received_at: '2026-09-01T08:09:00.000Z', instrument_result_time: '2026-09-01T08:09:00.000Z' }),
  ];
  it('values that would reject a run are charted as late_unassigned: zero runs, zero events, zero run-fake writes', async () => {
    const t = build(history(), { rich: true });
    const res = await t.run({ plan_id: PLN(1) });
    expect(res).toMatchObject({ adopted: 2, counts: { late_unassigned: 2 } });
    expect(t.rep.statusOf2(1)).toBe('late_unassigned');
    expect(t.rep.statusOf2(2)).toBe('late_unassigned');
    expect(t.h.runs()).toEqual([]);
    expect(t.h.stored()).toEqual([]);
    expect(t.h.callsOf('insertRun')).toEqual([]);
    expect(t.h.callsOf('updateRun')).toEqual([]);
    expect(t.h.state.activity).toEqual([]);
    expect(t.rep.observations.every((o: Row) => o['tenant_id'] === TENANT_A)).toBe(true);
  });
});
