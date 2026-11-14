// C9 T-09 — observation import + classification (06 row T-09; 02-TRD §6.2 steps 1-6, §6.3; PRD AC-02.1-02.3, AC-05.1, AC-05.3-05.5; 07-SECURITY tenant/log hygiene).
// No database: FakeSyncRepo (observation.helpers.ts) emulates the view, the unique index, the FKs and the never-backwards cursor. SEAMS: see the helper header.
// Fails now: "Cannot find module ../service/observation.service.js".
import { describe, expect, it } from 'vitest';
import { createObservationService } from '../service/observation.service.js';
import {
  ANA, INS, LOT, NOW, OBS_KEYS, PLN, QCR, RUN, SECRET_RAW, TENANT_A, TENANT_B, USER, baseSeed, lotRow, makeAssembler, makeClock, makeCtx, makeSyncRepo, mapRow, planRow, rejection, targetRow, viewRow,
  type FakeSeed, type Row,
} from './observation.helpers.js';

const rig = (seed: FakeSeed = baseSeed(), o: { hooks?: Parameters<typeof makeSyncRepo>[1]; config?: Row; assembleFails?: Error; clock?: ReturnType<typeof makeClock>; ctx?: Parameters<typeof makeCtx>[0] } = {}) => {
  const clock = o.clock ?? makeClock(0);
  const sync = makeSyncRepo(seed, { onPage: clock.tick, ...(o.hooks ?? {}) });
  const a = makeAssembler(o.assembleFails);
  const c = makeCtx(o.ctx);
  const service = createObservationService({ repo: sync.repo, assembler: a.assembler, config: { syncBatch: 500, syncOverlapSeconds: 600, syncTimeBudgetSeconds: 25, ...(o.config ?? {}) }, nowMs: clock.nowMs } as any);
  return { sync, ...a, ...c, service, clock, run: () => service.syncQcObservations(c.ctx) };
};
const withView = (rows: Row[], mut?: (s: FakeSeed) => void): FakeSeed => { const s = baseSeed(); s.view = rows; mut?.(s); return s; };
const one = async (row: Row, mut?: (s: FakeSeed) => void, o: Parameters<typeof rig>[1] = {}) => { const r = rig(withView([row], mut), o); const res = await r.run(); return { ...r, res, obs: r.sync.obsOf(1)! }; };

// ================================================================================================ AC-02.1 / AC-02.2 / AC-02.3  control-ID map
describe('AC-02.1-02.3 control-ID map: exact vs wildcard, unmapped', () => {
  const MAPS = (s: FakeSeed) => { s.maps = [mapRow(2, 2, { control_id_raw: 'QC-L2' }), mapRow(7, 4, { control_id_raw: 'QC-L2', control_lot_raw: 'LOT-SYN-02' })]; };
  const L2 = { control_id_raw: 'QC-L2' };

  it('AC-02.1 exact map (I1, QC-L2, LOT-SYN-01) assigns that lot and its level', async () => {
    const { obs } = await one(viewRow(1, { ...L2, control_lot_raw: 'LOT-SYN-01' }), (s) => { s.maps = [mapRow(3, 2, { control_id_raw: 'QC-L2', control_lot_raw: 'LOT-SYN-01' })]; });
    expect(obs).toMatchObject({ status: 'assigned', lot_id: LOT(2), level_id: idN2(2), plan_id: PLN(1) });
  });
  it('AC-02.2 exact map wins over the wildcard map when both exist', async () => {
    // ruling C9.T-09-ruling.md: §6.3 row 7 needs an active target for (PLN1, LOT4), else 'no_target'.
    const { obs } = await one(viewRow(1, { ...L2, control_lot_raw: 'LOT-SYN-02' }), (s) => { MAPS(s); s.targets!.push(targetRow(3, 4)); });
    expect(obs).toMatchObject({ status: 'assigned', lot_id: LOT(4) });
  });
  it('AC-02.2 a lot raw with no exact map falls back to the wildcard map', async () => {
    const { obs } = await one(viewRow(1, { ...L2, control_lot_raw: 'LOT-SYN-01' }), MAPS);
    expect(obs).toMatchObject({ status: 'assigned', lot_id: LOT(2) });
  });
  it('a missing lot raw (null) uses the wildcard map', async () => {
    const { obs } = await one(viewRow(1, { ...L2, control_lot_raw: null }), MAPS);
    expect(obs).toMatchObject({ status: 'assigned', lot_id: LOT(2) });
  });
  it('an exact-lot map for ANOTHER lot raw does not match (no wildcard exists) -> unmapped_control', async () => {
    const { obs } = await one(viewRow(1, { ...L2, control_lot_raw: 'LOT-SYN-09' }), (s) => { s.maps = [mapRow(7, 4, { control_id_raw: 'QC-L2', control_lot_raw: 'LOT-SYN-02' })]; });
    expect(obs.status).toBe('unmapped_control');
  });
  it('an exact-lot map does not match an observation with no lot raw -> unmapped_control', async () => {
    const { obs } = await one(viewRow(1, { ...L2, control_lot_raw: null }), (s) => { s.maps = [mapRow(7, 4, { control_id_raw: 'QC-L2', control_lot_raw: 'LOT-SYN-02' })]; });
    expect(obs.status).toBe('unmapped_control');
  });
  it('AC-02.3 no map at all: stored as unmapped_control, no lot/level/run, never evaluated (assembler not called)', async () => {
    const { obs, drafts } = await one(viewRow(1, { control_id_raw: 'QC-UNKNOWN' }));
    expect(obs).toMatchObject({ status: 'unmapped_control', lot_id: null, level_id: null, target_id: null, qc_run_id: null });
    expect(drafts).toEqual([]);
  });
  it('maps of another instrument, a deactivated map and a map of another tenant never match', async () => {
    for (const mut of [
      (s: FakeSeed) => { s.maps = [mapRow(1, 1, { instrument_id: INS(2) })]; },
      (s: FakeSeed) => { s.maps = [mapRow(1, 1, { is_active: false })]; },
      (s: FakeSeed) => { s.maps = [mapRow(1, 1, { tenant_id: TENANT_B })]; },
    ]) expect((await one(viewRow(1), mut)).obs.status).toBe('unmapped_control');
  });
});
const idN2 = (n: number) => `0190a000-0000-7000-8000-${(0x4000 + n).toString(16).padStart(12, '0')}`;   // LVL(n)

// ================================================================================================ AC-05.3 / 02-TRD §6.3  classification
describe('AC-05.3 classification statuses (first matching row wins; none of them is evaluated)', () => {
  const NOT_EVALUATED = { qc_run_id: null };
  const cases: Array<[string, string, Row, ((s: FakeSeed) => void) | undefined, Row]> = [
    ['row 1', 'unmapped_analyte', { analyte_id: null }, undefined, { plan_id: null }],
    ['row 1 beats row 2 (analyte absent AND value absent)', 'unmapped_analyte', { analyte_id: null, value_numeric: null }, undefined, {}],
    ['row 2', 'non_numeric', { value_numeric: null }, undefined, {}],
    ['row 3 (no plan for the instrument/analyte pair)', 'no_plan', { instrument_id: INS(2) }, undefined, { plan_id: null }],
    ['row 3 (plan exists but is inactive)', 'no_plan', {}, (s) => { s.plans = [planRow({ status: 'inactive' })]; }, { plan_id: null }],
    ['row 3 beats row 4 (no plan AND no map)', 'no_plan', { instrument_id: INS(2), control_id_raw: 'NOPE' }, undefined, {}],
    ['row 4', 'unmapped_control', { control_id_raw: 'NOPE' }, undefined, { lot_id: null }],
    ['row 5 (lot level not in the plan composition)', 'level_not_in_plan', {}, (s) => { s.maps = [mapRow(1, 5)]; }, { plan_id: PLN(1), lot_id: LOT(5), target_id: null }],
    ['row 6 (lot expired on the observation date)', 'lot_expired', {}, (s) => { s.lots = [lotRow(1, 1, { expires_on: '2026-11-12' })]; }, { lot_id: LOT(1), target_id: null }],
    ['row 5 beats rows 6 and 7 (not in plan, expired, no target)', 'level_not_in_plan', {}, (s) => { s.maps = [mapRow(1, 5)]; s.lots = [lotRow(5, 3, { expires_on: '2020-01-01' })]; }, {}],
    ['row 7 (no target at all)', 'no_target', {}, (s) => { s.targets = []; }, { plan_id: PLN(1), lot_id: LOT(1), target_id: null, mean: null, sd: null, z: null }],
    ['row 6 beats row 7 (expired AND no target)', 'lot_expired', {}, (s) => { s.targets = []; s.lots = [lotRow(1, 1, { expires_on: '2026-11-12' })]; }, {}],
    ['row 8 (unit differs from the target unit)', 'unit_mismatch', { unit_code: 'mg_dl' }, undefined, { plan_id: PLN(1), lot_id: LOT(1), target_id: null, z: null }],
    ['row 7 beats row 8 (no target AND unit differs)', 'no_target', { unit_code: 'mg_dl' }, (s) => { s.targets = []; }, {}],
  ];
  it.each(cases)('%s -> %s', async (_n, status, over, mut, expected) => {
    const { obs, drafts } = await one(viewRow(1, over), mut);
    expect(obs.status).toBe(status);
    expect(obs).toMatchObject({ ...NOT_EVALUATED, ...expected });
    expect(drafts, 'never evaluated: the run assembler is not called').toEqual([]);
  });

  it('row 8: an ABSENT unit_code is assumed to be in the analyte unit (ASSUMPTION in 6.3) -> assigned', async () => {
    expect((await one(viewRow(1, { unit_code: null }))).obs.status).toBe('assigned');
  });

  it('row 6 uses the tenant calendar date (Asia/Kathmandu): 2026-11-13T19:00Z is 2026-11-14 there; a lot expiring on 11-13 is expired, one expiring on 11-14 is not', async () => {
    const at = { instrument_result_time: '2026-11-13T19:00:00.000000Z', received_at: '2026-11-13T19:00:00.000000Z' };
    expect((await one(viewRow(1, at), (s) => { s.lots = [lotRow(1, 1, { expires_on: '2026-11-13' })]; })).obs.status).toBe('lot_expired');
    expect((await one(viewRow(1, at), (s) => { s.lots = [lotRow(1, 1, { expires_on: '2026-11-14' })]; })).obs.status).toBe('assigned');
  });

  describe('row 7 target selection: active or superseded, effective at observed_at', () => {
    const T = (o: Row, n = 1) => (s: FakeSeed) => { s.targets = [targetRow(n, 1, o)]; };
    it('draft and retired targets are ignored', async () => {
      expect((await one(viewRow(1), T({ status: 'draft' }))).obs.status).toBe('no_target');
      expect((await one(viewRow(1), T({ status: 'retired' }))).obs.status).toBe('no_target');
    });
    it('an active target that starts after observed_at is not effective yet', async () => {
      expect((await one(viewRow(1), T({ effective_from: '2026-11-14T00:00:00.000000Z' }))).obs.status).toBe('no_target');
    });
    it('a superseded target whose window contains observed_at is used; one that ended before observed_at is not', async () => {
      expect((await one(viewRow(1), T({ status: 'superseded', effective_to: '2026-11-14T00:00:00.000000Z' }))).obs).toMatchObject({ status: 'assigned', target_id: targetRow(1, 1)['id'] });
      expect((await one(viewRow(1), T({ status: 'superseded', effective_to: '2026-11-13T17:00:00.000000Z' }))).obs.status).toBe('no_target');
    });
    it('observed after a supersession: the new active target is used, not the superseded one', async () => {
      const { obs } = await one(viewRow(1), (s) => { s.targets = [targetRow(1, 1, { status: 'superseded', effective_to: '2026-11-13T12:00:00.000000Z' }), targetRow(3, 1, { mean: '110.000000', effective_from: '2026-11-13T12:00:00.000000Z' })]; });
      expect(obs).toMatchObject({ status: 'assigned', target_id: targetRow(3, 1)['id'], mean: '110.000000' });
    });
  });

  describe('row 9 late_unassigned (AC-05.4)', () => {
    const run = (at: string) => (s: FakeSeed) => { s.runs = [{ plan_id: PLN(1), run_at: at }]; };
    it('observed_at earlier than the latest evaluated run of the pair -> late_unassigned: charted data kept (target snapshot set), no run, assembler not called', async () => {
      const { obs, drafts } = await one(viewRow(1), run('2026-11-13T18:30:00.000Z'));
      expect(obs).toMatchObject({ status: 'late_unassigned', qc_run_id: null, target_id: targetRow(1, 1)['id'], mean: '100.000000', sd: '2.000000', z: '2.000000' });
      expect(drafts).toEqual([]);
    });
    it('observed_at equal to the run_at passes row 9 (strict <): assigned', async () => {
      expect((await one(viewRow(1), run(OBSERVED_ISO))).obs.status).toBe('assigned');
    });
    it('a later observation of another plan does not make this one late (latest run is per plan)', async () => {
      expect((await one(viewRow(1), (s) => { s.runs = [{ plan_id: PLN(9), run_at: '2026-11-13T23:00:00.000Z' }]; })).obs.status).toBe('assigned');
    });
    it('rows 5-8 beat row 9 (unit mismatch AND late -> unit_mismatch)', async () => {
      expect((await one(viewRow(1, { unit_code: 'mg_dl' }), run('2026-11-13T18:30:00.000Z'))).obs.status).toBe('unit_mismatch');
    });
  });

  describe('row 10 assigned', () => {
    it('stores the target snapshot (mean, sd with 6 dp) and z = (value - mean) / sd as a 6 dp decimal string; hands the draft to the run assembler and stores its qc_run_id', async () => {
      const { obs, drafts } = await one(viewRow(1));
      expect(obs).toMatchObject({ status: 'assigned', plan_id: PLN(1), level_id: idN2(1), lot_id: LOT(1), target_id: targetRow(1, 1)['id'], mean: '100.000000', sd: '2.000000', z: '2.000000', value: '104', qc_run_id: RUN(1) });
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({ source_qc_result_id: QCR(1), status: 'assigned', target_id: targetRow(1, 1)['id'] });
      expect(drafts[0]!['qc_run_id']).toBeUndefined();
    });
    it('z is half-up to 6 dp and never a JS number: (102-100)/3 = 0.666667, (101-100)/3 = 0.333333, negative (97-100)/3 = -1.000000', async () => {
      for (const [v, z] of [['102', '0.666667'], ['101', '0.333333'], ['97', '-1.000000']] as const) {
        const { obs } = await one(viewRow(1, { value_numeric: v }), (s) => { s.targets = [targetRow(1, 1, { sd: '3.000000' })]; });
        expect(obs['z'], v).toBe(z);
        expect(typeof obs['z']).toBe('string');
        expect(obs['sd']).toBe('3.000000');
      }
    });
    it('the stored value is the exact decimal text of the view (no float round trip)', async () => {
      expect((await one(viewRow(1, { value_numeric: '104.10' }))).obs['value']).toBe('104.10');
    });
  });
});
const OBSERVED_ISO = '2026-11-13T17:59:00.000Z';

// ================================================================================================ columns, observed_at, tenant, source
describe('stored columns and observed_at (02-TRD §6.2 "observed_at (DECISION)")', () => {
  it('maps every view column to the observation row; ids/actor/tenant come from the service ctx; no extra keys', async () => {
    const { obs } = await one(viewRow(1, { source: 'manual', control_level: '2' }));
    expect(Object.keys(obs).sort()).toEqual([...OBS_KEYS].sort());
    expect(obs).toMatchObject({ tenant_id: TENANT_A, source_qc_result_id: QCR(1), source: 'manual', instrument_id: INS(1), analyte_id: ANA(1), control_id_raw: 'QC-L1', control_lot_raw: 'LOT-SYN-01', control_level_raw: '2',
      unit_code: 'mmol_l', received_at: '2026-11-13T18:00:00.000000Z', created_by: USER, updated_by: USER });
    expect(obs['id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Date.parse(obs['classified_at'])).toBe(Date.parse(NOW));
  });
  it('instrument_result_time within +-24 h of received_at is the observed_at (basis instrument)', async () => {
    const { obs } = await one(viewRow(1, { instrument_result_time: '2026-11-13T09:00:01.000000Z' }));
    expect(Date.parse(obs['observed_at'])).toBe(Date.parse('2026-11-13T09:00:01.000Z'));
    expect(obs['observed_at_basis']).toBe('instrument');
  });
  it('a wrong analyser clock (more than 24 h away, either side) falls back to received_at (basis server)', async () => {
    for (const t of ['2026-11-12T17:59:59.000000Z', '2026-11-14T18:00:01.000000Z']) {
      const { obs } = await one(viewRow(1, { instrument_result_time: t }));
      expect(Date.parse(obs['observed_at']), t).toBe(Date.parse('2026-11-13T18:00:00.000Z'));
      expect(obs['observed_at_basis']).toBe('server');
    }
  });
  it('no instrument_result_time -> received_at, basis server', async () => {
    const { obs } = await one(viewRow(1, { instrument_result_time: null }));
    expect(obs).toMatchObject({ observed_at_basis: 'server', instrument_result_time: null });
  });
});

// ================================================================================================ AC-05.1 dedupe, overlap
describe('AC-05.1 dedupe on source_qc_result_id; first page with overlap', () => {
  it('imports one observation per qc_result_id; importing the same rows again creates nothing and does not call the assembler again', async () => {
    const r = rig(withView([viewRow(1), viewRow(2, { created_at: '2026-11-13T18:00:01.000000Z' })]));
    const first = await r.run();
    expect(first).toMatchObject({ imported: 2, duplicates: 0, importErrors: 0 });
    const second = await r.run();
    expect(second).toMatchObject({ imported: 0, duplicates: 2, importErrors: 0 });
    expect(r.sync.observations).toHaveLength(2);
    expect(r.drafts).toHaveLength(2);
  });
  it('the first page re-reads from cursor_at minus the overlap (600 s) and is deduplicated; a late-committing row inside the overlap window is picked up', async () => {
    const seed = withView([viewRow(1, { created_at: '2026-11-13T18:00:00.000000Z' })], (s) => { s.cursor = { qc_cursor_at: '2026-11-13T18:00:00.000000Z', qc_cursor_id: QCR(1) }; s.observations = [{ tenant_id: TENANT_A, source_qc_result_id: QCR(1), status: 'assigned' }]; });
    seed.view!.push(viewRow(2, { created_at: '2026-11-13T17:55:00.000000Z' }));   // committed late, created_at 5 min BEFORE the cursor
    seed.view!.push(viewRow(3, { created_at: '2026-11-13T17:40:00.000000Z' }));   // 20 min before: outside the 600 s overlap
    const r = rig(seed);
    const first = r.sync.callsOf('readFirstPage');
    const res = await r.run();
    expect(first).toHaveLength(0);
    const call = r.sync.callsOf('readFirstPage')[0]!;
    expect(call.args[0]).toMatchObject({ cursorAt: '2026-11-13T18:00:00.000000Z', overlapSeconds: 600, limit: 500 });
    expect(res).toMatchObject({ imported: 1, duplicates: 1 });
    expect(r.sync.obsOf(2)).toBeDefined();
    expect(r.sync.obsOf(3)).toBeUndefined();
  });
  it('the cursor never goes backwards when an overlap page ends on an older key than the stored cursor', async () => {
    const seed = withView([viewRow(2, { created_at: '2026-11-13T17:55:00.000000Z' })], (s) => { s.cursor = { qc_cursor_at: '2026-11-13T18:00:00.000000Z', qc_cursor_id: QCR(9) }; });
    const r = rig(seed);
    await r.run();
    expect(r.sync.state.cursor).toEqual({ qc_cursor_at: '2026-11-13T18:00:00.000000Z', qc_cursor_id: QCR(9) });
  });
  it('reads only the tenant\'s own rows: tenant B rows in the view are never imported, every repo call carries tenant A', async () => {
    const r = rig(withView([viewRow(1), viewRow(2, { tenant_id: TENANT_B, instrument_id: INS(1) })]));
    await r.run();
    expect(r.sync.observations.map((o) => o['source_qc_result_id'])).toEqual([QCR(1)]);
    for (const c of r.sync.calls) expect(c.tenantId, c.op).toBe(TENANT_A);
  });
});

// ================================================================================================ AC-05.5 keyset paging
describe('AC-05.5 / §6.2 steps 2, 5, 6: 1,200 rows in one created_at second', () => {
  const SECOND = '2026-11-13T18:00:00.000000Z';
  const rows1200 = () => Array.from({ length: 1200 }, (_, i) => viewRow(i + 1, { created_at: SECOND, control_id_raw: 'NOPE' }));   // unmapped_control: cheap

  it('imports all 1,200 in ONE cycle: 1 first page + 2 keyset pages, no page repeated, the cursor ends at the last row (created_at, qc_result_id)', async () => {
    const r = rig(withView(rows1200()));
    const res = await r.run();
    expect(res).toMatchObject({ imported: 1200, duplicates: 0, importErrors: 0, pages: 3, budgetExhausted: false });
    expect(r.sync.observations).toHaveLength(1200);
    expect(new Set(r.sync.observations.map((o) => o['source_qc_result_id'])).size).toBe(1200);
    expect(r.sync.callsOf('readFirstPage')).toHaveLength(1);
    const after = r.sync.callsOf('readPageAfter');
    expect(after).toHaveLength(2);
    expect(after[0]!.args[0]).toEqual({ afterAt: SECOND, afterId: QCR(500), limit: 500 });
    expect(after[1]!.args[0]).toEqual({ afterAt: SECOND, afterId: QCR(1000), limit: 500 });
    expect(r.sync.state.cursor).toEqual({ qc_cursor_at: SECOND, qc_cursor_id: QCR(1200) });
    expect(res.cursor).toEqual({ at: SECOND, id: QCR(1200) });
  });
  it('both cursor columns are persisted after EVERY page (so a crash between pages resumes at the last page)', async () => {
    const r = rig(withView(rows1200()));
    await r.run();
    expect(r.sync.callsOf('advanceCursor').map((c) => c.args[0])).toEqual([{ at: SECOND, id: QCR(500) }, { at: SECOND, id: QCR(1000) }, { at: SECOND, id: QCR(1200) }]);
  });
  it('a page that is not full ends the cycle (no extra read after the 200-row page)', async () => {
    const r = rig(withView(rows1200().slice(0, 700)));
    const res = await r.run();
    expect(res.pages).toBe(2);
    expect(r.sync.callsOf('readPageAfter')).toHaveLength(1);
  });
  it('an exactly full last page costs one more (empty) read and then stops', async () => {
    const r = rig(withView(rows1200().slice(0, 1000)));
    const res = await r.run();
    expect(res.imported).toBe(1000);
    expect(r.sync.callsOf('readPageAfter')).toHaveLength(2);
  });
  it('a full page whose key did NOT advance past the previous page ends the cycle (no endless loop)', async () => {
    const stuck = (kind: string, rows: Row[]) => (kind === 'after' ? Array.from({ length: 500 }, (_, i) => viewRow(i + 1, { created_at: SECOND, control_id_raw: 'NOPE' })) : rows);
    const r = rig(withView(rows1200()), { hooks: { pageOverride: stuck } });
    const res = await r.run();
    expect(r.sync.callsOf('readPageAfter').length).toBeLessThanOrEqual(2);
    expect(res.budgetExhausted).toBe(false);
    expect(res.imported).toBe(500);
  });
  it('the batch size comes from config (LIMS_QUALITY_SYNC_BATCH)', async () => {
    const r = rig(withView(rows1200().slice(0, 25)), { config: { syncBatch: 10 } });
    const res = await r.run();
    expect(res).toMatchObject({ imported: 25, pages: 3 });
    expect(r.sync.callsOf('readFirstPage')[0]!.args[0]).toMatchObject({ limit: 10 });
  });
  it('the first-page cursor of the NEXT cycle is the persisted one: a second run reads from (last created_at - overlap) and imports nothing new', async () => {
    const r = rig(withView(rows1200().slice(0, 30)));
    await r.run();
    const again = await r.run();
    expect(again.imported).toBe(0);
    expect(r.sync.callsOf('readFirstPage')[1]!.args[0]).toMatchObject({ cursorAt: SECOND });
  });
});

describe('§6.2 step 6: time budget and the qcsync:cont: continuation', () => {
  const SECOND = '2026-11-13T18:00:00.000000Z';
  const rows = (n: number) => Array.from({ length: n }, (_, i) => viewRow(i + 1, { created_at: SECOND, control_id_raw: 'NOPE' }));
  it('when the budget (25 s) is used up before the pages run out the run stops with budgetExhausted = true; the cursor is persisted so the continuation resumes after the last page', async () => {
    const clock = makeClock(10_000);   // every page read costs 10 s: pages 1,2,3 -> 30 s > 25 s
    const r = rig(withView(rows(2000)), { clock, config: { syncBatch: 100 } });
    const res = await r.run();
    expect(res.budgetExhausted).toBe(true);
    expect(res.pages).toBeGreaterThanOrEqual(1);
    expect(res.pages).toBeLessThan(20);
    expect(res.imported).toBe(res.pages * 100);
    expect(r.sync.state.cursor).toEqual({ qc_cursor_at: SECOND, qc_cursor_id: QCR(res.pages * 100) });
  });
  it('a continuation run (a new run) imports the rest; together all rows are imported exactly once (rows >10 min apart so the overlap re-read stays small)', async () => {
    const clock = makeClock(10_000);
    const spaced = Array.from({ length: 450 }, (_, i) => viewRow(i + 1, { created_at: new Date(Date.parse('2026-10-20T00:00:00.000Z') + i * 700_000).toISOString().replace('Z', '000Z'), control_id_raw: 'NOPE' }));
    const r = rig(withView(spaced), { clock, config: { syncBatch: 100 } });
    let total = 0, guard = 0, last: any;
    do { last = await r.run(); total += last.imported; } while (last.budgetExhausted && ++guard < 20);
    expect(total).toBe(450);
    expect(r.sync.observations).toHaveLength(450);
  });
  it('a run with enough budget never reports budgetExhausted', async () => {
    const r = rig(withView(rows(250)), { clock: makeClock(1_000), config: { syncBatch: 100 } });
    expect((await r.run()).budgetExhausted).toBe(false);
  });
  it('budgetExhausted is false when the last page was not full even if the budget is gone (nothing left to continue)', async () => {
    const r = rig(withView(rows(50)), { clock: makeClock(60_000), config: { syncBatch: 100 } });
    expect((await r.run()).budgetExhausted).toBe(false);
  });
});

// ================================================================================================ AC-05.5 poison row, per-row savepoint
describe('AC-05.5 / §6.2 step 3: per-row savepoint, import_error', () => {
  const six = () => [viewRow(1), viewRow(2), viewRow(3, { instrument_id: INS(3), control_id_raw: SECRET_RAW, value_numeric: '987.654' }), viewRow(4), viewRow(5), viewRow(6)]
    .map((r, i) => ({ ...r, created_at: `2026-11-13T18:00:0${i}.000000Z` }));
  // INS(3) is not in seed.instruments: the insert raises the FK violation 23503 (qc_observations__instrument__fk)

  it('the poison row (unknown instrument) is skipped and counted as import_error; the rows after it are imported; the cursor passes it', async () => {
    const r = rig(withView(six()));
    const res = await r.run();
    expect(res).toMatchObject({ imported: 5, importErrors: 1 });
    expect(res.counts['import_error']).toBe(1);
    expect(r.sync.obsOf(3)).toBeUndefined();
    for (const n of [1, 2, 4, 5, 6]) expect(r.sync.obsOf(n), `row ${n}`).toBeDefined();
    expect(r.sync.state.cursor).toEqual({ qc_cursor_at: '2026-11-13T18:00:05.000000Z', qc_cursor_id: QCR(6) });
  });
  it('each insert runs in its own savepoint: RELEASE after a good row, ROLLBACK TO after the poison row, in that order, on the request tx', async () => {
    const r = rig(withView(six()));
    await r.run();
    const sp = r.queries.map((q) => q.text.trim()).filter((t) => /SAVEPOINT/i.test(t));
    expect(sp.filter((t) => /^SAVEPOINT\b/i.test(t))).toHaveLength(6);
    expect(sp.filter((t) => /^ROLLBACK TO SAVEPOINT\b/i.test(t))).toHaveLength(1);
    expect(sp.filter((t) => /^RELEASE SAVEPOINT\b/i.test(t))).toHaveLength(5);
    expect(sp.map((t) => t.split(/\s+/)[0]!.toUpperCase() === 'ROLLBACK' ? 'R' : t.split(/\s+/)[0]!.toUpperCase() === 'RELEASE' ? 'E' : 'S').join('')).toMatch(/^(SE|SR)+$/);
    expect(new Set(sp.map((t) => t.split(/\s+/).pop())).size, 'one savepoint name, reused (released/rolled back each time)').toBe(1);
  });
  it('the failure is logged as qc_result_id + SQLSTATE only: no value, no control id, no lot', async () => {
    const r = rig(withView(six()));
    await r.run();
    const text = r.logText();
    expect(text).toContain(QCR(3));
    expect(text).toContain('23503');
    for (const leak of ['987.654', SECRET_RAW, 'LOT-SYN-01']) expect(text, leak).not.toContain(leak);
  });
  it('a value that does not fit (SQLSTATE class 22, e.g. 22003 numeric overflow) is also an import_error', async () => {
    const boom = (row: Row) => (row['source_qc_result_id'] === QCR(2) ? Object.assign(new Error('numeric field overflow'), { code: '22003' }) : undefined);
    const r = rig(withView([viewRow(1), viewRow(2, { created_at: '2026-11-13T18:00:01.000000Z' }), viewRow(3, { created_at: '2026-11-13T18:00:02.000000Z' })]), { hooks: { insertFails: boom } });
    expect(await r.run()).toMatchObject({ imported: 2, importErrors: 1 });
  });
  it('a NON-data error (connection lost 57P01, 40001 serialization) is not swallowed: the run rejects and the cursor is not advanced past the failing page', async () => {
    for (const code of ['57P01', '40001', '08006']) {
      const boom = (row: Row) => (row['source_qc_result_id'] === QCR(2) ? Object.assign(new Error('db down'), { code }) : undefined);
      const r = rig(withView([viewRow(1), viewRow(2, { created_at: '2026-11-13T18:00:01.000000Z' })]), { hooks: { insertFails: boom } });
      await rejection(r.run());
      expect(r.sync.state.cursor!.qc_cursor_at, code).toBe('2026-10-01T00:00:00.000000Z');
    }
  });
  it('a failing view read rejects the run (never a silent empty success) and leaves the cursor alone', async () => {
    const r = rig(withView([viewRow(1)]), { hooks: { viewFails: new Error('view unavailable') } });
    await rejection(r.run());
    expect(r.sync.state.cursor!.qc_cursor_at).toBe('2026-10-01T00:00:00.000000Z');
  });
  it('a failing run assembler for an `assigned` row rejects the run (the row is neither imported half-done nor skipped as import_error)', async () => {
    const r = rig(withView([viewRow(1)]), { assembleFails: new Error('assembler down') });
    await rejection(r.run());
    expect(r.sync.observations).toHaveLength(0);
  });
});

// ================================================================================================ §6.2 step 4: pair lock, order, counts
describe('§6.2 step 4: pair lock and processing order; status counts', () => {
  it('locks each (instrument, analyte) group once per page BEFORE classifying any of its rows; rows of one group are processed in observed_at, received_at, qc_result_id order', async () => {
    const t = (min: number) => `2026-11-13T18:0${min}:00.000000Z`;
    const rows = [
      viewRow(3, { instrument_result_time: t(3), received_at: t(3), created_at: t(1) }),
      viewRow(1, { instrument_result_time: t(1), received_at: t(2), created_at: t(1) }),
      viewRow(2, { instrument_result_time: t(1), received_at: t(2), created_at: t(1) }),
      viewRow(4, { instrument_id: INS(2), analyte_id: ANA(2), created_at: t(1), instrument_result_time: t(0), received_at: t(0) }),   // other pair
    ];
    const r = rig(withView(rows, (s) => { s.plans!.push(planRow({ id: PLN(2), instrument_id: INS(2), analyte_id: ANA(2) })); s.maps!.push(mapRow(5, 1, { instrument_id: INS(2) })); }));
    await r.run();
    const lock = r.sync.callsOf('lockPair');
    expect(lock.map((c) => c.args)).toHaveLength(2);
    expect(lock.map((c) => `${c.args[0]}|${c.args[1]}`).sort()).toEqual([`${INS(1)}|${ANA(1)}`, `${INS(2)}|${ANA(2)}`].sort());
    const ops = r.sync.calls.map((c) => c.op);
    const firstClassify = (k: number) => ops.findIndex((o, i) => (o === 'findActivePlan') && (r.sync.calls[i]!.args[0] === (k === 1 ? INS(1) : INS(2))));
    for (const k of [1, 2]) {
      const li = r.sync.calls.findIndex((c) => c.op === 'lockPair' && c.args[0] === (k === 1 ? INS(1) : INS(2)));
      expect(li, `pair ${k} locked`).toBeGreaterThanOrEqual(0);
      expect(li, `pair ${k}: lock before classification`).toBeLessThan(firstClassify(k));
    }
    // assembler order for pair 1: observed_at asc, then received_at, then qc_result_id
    expect(r.drafts.filter((d) => d['instrument_id'] === INS(1)).map((d) => d['source_qc_result_id'])).toEqual([QCR(1), QCR(2), QCR(3)]);
  });
  it('serialises sync runs per tenant: lockSyncState is called once, before the first page read (§6.2 step 4 / E1, review item 2)', async () => {
    const r = rig(withView([viewRow(1)]));
    await r.run();
    const ops = r.sync.calls.map((c) => c.op);
    expect(ops.filter((o) => o === 'lockSyncState')).toHaveLength(1);
    expect(ops.indexOf('lockSyncState')).toBeLessThan(ops.indexOf('readFirstPage'));
    expect(r.sync.callsOf('lockSyncState')[0]!.tenantId).toBe(TENANT_A);
  });
  it('locks the pairs of a page in a deterministic order (sorted by "instrument|analyte"), not first-appearance order', async () => {
    const t = (s: number) => `2026-11-13T18:00:0${s}.000000Z`;
    const rows = [
      viewRow(1, { instrument_id: INS(2), analyte_id: ANA(2), created_at: t(1) }),   // appears first but sorts last
      viewRow(2, { created_at: t(2) }),
    ];
    const r = rig(withView(rows, (s) => { s.plans!.push(planRow({ id: PLN(2), instrument_id: INS(2), analyte_id: ANA(2) })); s.maps!.push(mapRow(5, 1, { instrument_id: INS(2) })); }));
    await r.run();
    const keys = r.sync.callsOf('lockPair').map((c) => `${c.args[0]}|${c.args[1] ?? ''}`);
    expect(keys).toHaveLength(2);
    expect(keys).toEqual([...keys].sort());
  });
  it('a group whose analyte is unknown (analyte_id null) is still locked/processed without error', async () => {
    const r = rig(withView([viewRow(1, { analyte_id: null })]));
    expect((await r.run()).counts['unmapped_analyte']).toBe(1);
  });
  it('counts per status (feeds lims_quality_qc_observations_total{status}) incl. import_error; duplicates are not counted', async () => {
    const rows = [viewRow(1), viewRow(2, { value_numeric: null }), viewRow(3, { analyte_id: null }), viewRow(4, { control_id_raw: 'NOPE' }), viewRow(5, { instrument_id: INS(3) })]
      .map((r, i) => ({ ...r, created_at: `2026-11-13T18:00:0${i}.000000Z` }));
    const r = rig(withView(rows));
    const res = await r.run();
    expect(res.counts).toEqual({ assigned: 1, non_numeric: 1, unmapped_analyte: 1, unmapped_control: 1, import_error: 1 });
  });
  it('overlapping jobs (cron + event) running at the same time leave ONE observation per qc_result_id and a cursor at the maximum key', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => viewRow(i + 1, { created_at: `2026-11-13T18:00:${String(i).padStart(2, '0')}.000000Z` }));
    const r = rig(withView(rows), { config: { syncBatch: 7 } });
    const [a, b] = await Promise.all([r.service.syncQcObservations(r.ctx), r.service.syncQcObservations(makeCtx().ctx)]);
    const ids = r.sync.observations.map((o) => o['source_qc_result_id']);
    expect(new Set(ids).size).toBe(40);
    expect(ids).toHaveLength(40);
    expect(a.imported + b.imported).toBe(40);
    expect(r.sync.state.cursor).toEqual({ qc_cursor_at: '2026-11-13T18:00:39.000000Z', qc_cursor_id: QCR(40) });
  });
});

// ================================================================================================ security
describe('security: ctx tenant only, no leaks', () => {
  it('uses only ctx.tenantId: a tenant-B ctx imports only tenant B rows and never reads tenant A', async () => {
    const seed = withView([viewRow(1), viewRow(2, { tenant_id: TENANT_B, created_at: '2026-11-13T18:00:01.000000Z' })], (s) => { s.instruments!.push(INS(1)); });
    const r = rig(seed, { ctx: { tenantId: TENANT_B } });
    await r.run();
    expect(r.sync.observations.map((o) => `${o['tenant_id']}|${o['source_qc_result_id']}`)).toEqual([`${TENANT_B}|${QCR(2)}`]);
  });
  it('a hostile raw control id / lot (SQL text) is only ever passed as data to the repo and stored verbatim, never executed or logged', async () => {
    const evil = "x'; DROP TABLE quality.qc_observations;--";
    const r = rig(withView([viewRow(1, { control_id_raw: evil, control_lot_raw: evil })]));
    const res = await r.run();
    expect(res.counts['unmapped_control']).toBe(1);
    expect(r.sync.obsOf(1)).toMatchObject({ control_id_raw: evil, control_lot_raw: evil });
    expect(r.queries.map((q) => q.text).join('\n')).not.toContain('DROP TABLE');
    expect(r.logText()).not.toContain('DROP TABLE');
  });
});
