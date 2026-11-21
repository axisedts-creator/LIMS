// C9 T-10 — integration: the REAL observation service (T-09) with the REAL run service as its RunAssembler, fake repos, real core events.publish (06-IMPLEMENTATION-PLAN row T-10 "integration").
// PRD AC-06.6 (AS1 through the import path), AC-06.8 (one event, same tx, re-import produces none). The sync fake (observation.helpers.ts) and the run fake (run.helpers.ts) are joined by copying each
// inserted observation into the run fake's table, like the real shared table. Savepoint semantics (poison row inside a page) need a real PG: not covered here.
// Fails now: "Cannot find module ../service/run.service.js".
import { describe, expect, it } from 'vitest';
import { createObservationService } from '../service/observation.service.js';
import { QCR, baseSeed, makeSyncRepo, viewRow } from './observation.helpers.js';
import { ANA, INS, PLN, TENANT_A, makeRunHarness, rejection } from './run.helpers.js';

const OBS_AT = (hm: string) => `2026-11-13T${hm}:00.000000Z`;
const l1 = (n: number, hm: string, v: string, o: Record<string, unknown> = {}) => viewRow(n, { value_numeric: v, instrument_result_time: OBS_AT(hm), received_at: OBS_AT(hm), created_at: OBS_AT(hm), ...o });
const l2 = (n: number, hm: string, v: string, o: Record<string, unknown> = {}) => l1(n, hm, v, { control_id_raw: 'QC-L2', control_lot_raw: null, control_level: '2', ...o });

function build(view: Array<Record<string, unknown>>, o: { insertFails?: (row: any) => Error | undefined } = {}) {
  const h = makeRunHarness({ now: '2026-11-13T18:30:00.000Z' });
  const seed = baseSeed(); seed.view = view as any;
  const sync = makeSyncRepo(seed, o.insertFails ? { insertFails: o.insertFails } : {});
  const joined = { ...sync.repo, async insertObservation(tx: any, t: string, row: any) { const r = await sync.repo.insertObservation(tx, t, row); if (r) h.state.observations.push(structuredClone(row)); return r; } };
  const service = createObservationService({ repo: joined as any, assembler: h.svc, config: { syncBatch: 500, syncOverlapSeconds: 600, syncTimeBudgetSeconds: 25 } } as any);
  const sync_ = () => h.transaction(() => service.syncQcObservations(h.ctx()));
  return { h, sync, service, run: sync_ };
}

describe('import -> assemble -> evaluate -> publish', () => {
  it('AS1 through the sync: V27 (L1 106.8 = z 3.4) then L2 100.4 within the window -> both observations on ONE rejected run, exactly one quality.qc_run.rejected.v1', async () => {
    const t = build([l1(1, '17:59', '106.8'), l2(2, '18:09', '100.4')]);
    const res = await t.run();
    expect(res).toMatchObject({ imported: 2, importErrors: 0 });
    const runs = t.h.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ plan_id: PLN(1), instrument_id: INS(1), analyte_id: ANA(1), status: 'evaluated', outcome: 'rejected', is_complete: false, rules_violated: ['1-3s'], observation_count: 2 });
    expect(t.sync.observations.map((x: any) => x.qc_run_id)).toEqual([runs[0]!['id'], runs[0]!['id']]);
    expect(t.sync.observations.every((x: any) => x.status === 'assigned')).toBe(true);
    expect(t.h.stored()).toHaveLength(1);
    expect(t.h.stored()[0]!.envelope.payload).toMatchObject({ qc_run_id: runs[0]!['id'], instrument_id: INS(1), analyte_ids: [ANA(1)], rules_violated: ['1-3s'], rule_mode: 'classic', controls_per_run: 2 });
  });
  it('the assembler sees the rows in observed_at order whatever the view order (L2 imported first by created_at) — still the same single run and one event', async () => {
    const t = build([l2(2, '18:09', '100.4', { created_at: OBS_AT('18:00') }), l1(1, '17:59', '106.8', { created_at: OBS_AT('18:01') })]);
    await t.run();
    expect(t.h.runs()).toHaveLength(1);
    expect(t.h.runs()[0]).toMatchObject({ outcome: 'rejected', observation_count: 2 });
    expect(t.h.stored()).toHaveLength(1);
  });
  it('in-control pair: L1 + L2 within the window -> one accepted complete run, no event, qc_activity reset', async () => {
    const t = build([l1(1, '17:59', '100.8'), l2(2, '18:05', '99.6')]);
    await t.run();
    expect(t.h.runs()).toHaveLength(1);
    expect(t.h.runs()[0]).toMatchObject({ status: 'evaluated', outcome: 'accepted', is_complete: true });
    expect(t.h.stored()).toEqual([]);
    expect(t.h.state.activity).toEqual([expect.objectContaining({ tenant_id: TENANT_A, plan_id: PLN(1), patient_results_since_last_qc: 0 })]);
  });
  it('a second sync over the same rows (overlap window) imports nothing, assigns nothing and publishes no second event', async () => {
    const t = build([l1(1, '17:59', '106.8'), l2(2, '18:09', '100.4')]);
    await t.run();
    const before = { runs: structuredClone(t.h.state.runs), obs: t.sync.observations.length, assignCalls: t.h.callsOf('insertRun').length + t.h.callsOf('updateRun').length };
    const again = await t.run();
    expect(again).toMatchObject({ imported: 0, duplicates: 2 });
    expect(t.h.state.runs).toEqual(before.runs);
    expect(t.sync.observations).toHaveLength(before.obs);
    expect(t.h.callsOf('insertRun').length + t.h.callsOf('updateRun').length).toBe(before.assignCalls);
    expect(t.h.stored()).toHaveLength(1);
  });
  it('a later L2 of the same early-rejected run (next sync) attaches without a second event', async () => {
    const t = build([l1(1, '17:59', '106.8')]);
    await t.run();
    expect(t.h.stored()).toHaveLength(1);
    const seed = t.sync.view; seed.push(l2(2, '18:10', '100.4') as any);
    await t.run();
    expect(t.h.runs()).toHaveLength(1);
    expect(t.h.runs()[0]).toMatchObject({ outcome: 'rejected', is_complete: false, observation_count: 2 });
    expect(t.h.stored()).toHaveLength(1);
  });
  it('same job transaction: a non-data failure on the second row aborts the sync and rolls back the run, the event and the first member (nothing half-committed)', async () => {
    const t = build([l1(1, '17:59', '106.8'), l2(2, '18:09', '100.4')], { insertFails: (row) => (row.source_qc_result_id === QCR(2) ? Object.assign(new Error('connection lost'), { code: '08006' }) : undefined) });
    const err = await rejection(t.run());
    expect(err).toBeInstanceOf(Error);
    expect(t.h.runs()).toEqual([]);
    expect(t.h.stored()).toEqual([]);
    expect(t.h.state.observations).toEqual([]);
  });
  it('rows of other statuses (no_target, unmapped_control) never reach the assembler: no run, no event', async () => {
    const t = build([l1(1, '17:59', '106.8', { control_id_raw: 'QC-UNKNOWN' }), l1(2, '18:00', '106.8', { analyte_id: null })]);
    await t.run();
    expect(t.h.runs()).toEqual([]);
    expect(t.h.stored()).toEqual([]);
    expect(t.h.callsOf('lockPlan')).toEqual([]);
  });
});
