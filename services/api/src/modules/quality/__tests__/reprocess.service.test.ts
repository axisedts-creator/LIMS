// C9 T-11 — re-processing (06 row T-11; 02-TRD §6.4 + "Adopting Phase-1 history" (08 A17 D-60), §6.3; PRD AC-02.4, AC-04.7; 03-APP-FLOW §1 status table; 07-SECURITY tenant/log hygiene).
// No database: FakeReprocessRepo (reprocess.helpers.ts) = T-09 FakeSyncRepo + the four T-11 repo methods. SEAMS: see the helper header.
// Not covered here (needs real PG / a clock): the 2-minute latency of AC-02.4 (job queue timing), FOR UPDATE blocking, savepoint rollback of the assembler's writes, RLS.
// Fails now: `svc.reprocessPending is not a function`.
import { describe, expect, it } from 'vitest';
import { createObservationService } from '../service/observation.service.js';
import {
  ANA, INS, IN_WINDOW, LOT, LVL, OBS, OLD, PATCH_KEYS, PENDING, PLN, RUN, SECRET_RAW, TENANT_A, TENANT_B, TGT, lotRow, makeAssembler, makeCtx, makeReprocessRepo, obsRow, planRow, rejection,
  seedWith, type ReprocessHooks, type Row,
} from './reprocess.helpers.js';

const rig = (observations: Row[], o: { seed?: Parameters<typeof seedWith>[1]; hooks?: ReprocessHooks; ctx?: Parameters<typeof makeCtx>[0]; assembleFails?: Error } = {}) => {
  const repo = makeReprocessRepo(seedWith(observations, o.seed), o.hooks);
  const a = makeAssembler(o.assembleFails);
  const c = makeCtx(o.ctx);
  const svc: any = createObservationService({ repo: repo.repo as any, assembler: a.assembler as any });
  return { ...repo, ...a, ...c, svc, run: (scope: { instrument_id?: string; plan_id?: string }) => svc.reprocessPending(c.ctx, scope) as Promise<any> };
};
const byInstrument = { instrument_id: INS(1) };
const byPlan = { plan_id: PLN(1) };
const savepointTexts = (r: { queries: Array<{ text: string }> }) => r.queries.map((q) => q.text.trim());

describe('AC-02.4 map / target created: pending observations are re-classified (02-TRD §6.4)', () => {
  it('unmapped_control newer than the latest evaluated run + map now present -> assigned: run assigned through the assembler, full snapshot stored, z 6 dp', async () => {
    const r = rig([obsRow(1, 'unmapped_control')]);
    const res = await r.run(byInstrument);
    expect(res).toMatchObject({ reclassified: 1, adopted: 0, unchanged: 0, counts: { assigned: 1 } });
    expect(r.byId(OBS(1))).toMatchObject({ status: 'assigned', qc_run_id: RUN(1), plan_id: PLN(1), level_id: LVL(1), lot_id: LOT(1), target_id: TGT(1), mean: '100.000000', sd: '2.000000', z: '2.000000', updated_by: expect.any(String) });
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]).toMatchObject({ id: OBS(1), status: 'assigned', plan_id: PLN(1), level_id: LVL(1), lot_id: LOT(1), target_id: TGT(1), observed_at: IN_WINDOW, value: '104.000000' });
    expect(r.drafts[0]!['qc_run_id'] ?? null).toBeNull();   // assign() decides the run; the draft is not yet a member
  });
  it('the late rule is respected (§6.3 row 9): observed_at < run_at of the pair\'s latest evaluated run -> late_unassigned, charted with its snapshot, never assigned', async () => {
    const r = rig([obsRow(1, 'unmapped_control')], { seed: { runs: [{ plan_id: PLN(1), run_at: '2026-11-13T18:30:00.000000Z' }] } });
    const res = await r.run(byInstrument);
    expect(res).toMatchObject({ reclassified: 1, counts: { late_unassigned: 1 } });
    expect(r.byId(OBS(1))).toMatchObject({ status: 'late_unassigned', qc_run_id: null, plan_id: PLN(1), lot_id: LOT(1), level_id: LVL(1), target_id: TGT(1), mean: '100.000000', sd: '2.000000', z: '2.000000' });
    expect(r.drafts).toEqual([]);
  });
  it('a late member of an early-rejected run (observed_at >= run_at, boundary included) still passes row 9 and is assigned', async () => {
    const r = rig([obsRow(1, 'unmapped_control')], { seed: { runs: [{ plan_id: PLN(1), run_at: '2026-11-13T17:59:00.000000Z' }] } });
    await r.run(byInstrument);
    expect(r.statusOf2(1)).toBe('assigned');
    expect(r.drafts).toHaveLength(1);
  });
  it('every pending status is re-classified once its cause is fixed (no_plan, unmapped_control, no_target, level_not_in_plan, unit_mismatch); assignment happens oldest first', async () => {
    const t = (min: number) => `2026-11-13T17:${String(min).padStart(2, '0')}:00.000Z`;
    const rows = [   // seeded newest-first on purpose
      obsRow(5, 'unit_mismatch', { plan_id: PLN(1), lot_id: LOT(1), level_id: LVL(1), observed_at: t(55), received_at: t(55) }),
      obsRow(4, 'level_not_in_plan', { plan_id: PLN(1), observed_at: t(54), received_at: t(54) }),
      obsRow(3, 'no_target', { plan_id: PLN(1), observed_at: t(53), received_at: t(53) }),
      obsRow(2, 'no_plan', { observed_at: t(52), received_at: t(52) }),
      obsRow(1, 'unmapped_control', { plan_id: PLN(1), observed_at: t(51), received_at: t(51) }),
    ];
    const r = rig(rows);
    const res = await r.run(byInstrument);
    expect(res).toMatchObject({ reclassified: 5, adopted: 0, unchanged: 0, counts: { assigned: 5 } });
    expect(r.drafts.map((d) => d['id'])).toEqual([OBS(1), OBS(2), OBS(3), OBS(4), OBS(5)]);
    for (let n = 1; n <= 5; n++) expect(r.byId(OBS(n)), `obs ${n}`).toMatchObject({ status: 'assigned', qc_run_id: RUN(1), target_id: TGT(1) });
  });
  it('a row whose cause is not fixed stays as it is: no UPDATE, no assembler call, counted unchanged', async () => {
    const r = rig([obsRow(1, 'unmapped_control', { control_id_raw: 'QC-NOPE', control_lot_raw: null }), obsRow(2, 'no_plan', { analyte_id: ANA(2) })]);
    const res = await r.run(byInstrument);
    expect(res).toMatchObject({ reclassified: 0, adopted: 0, unchanged: 2, counts: {} });
    expect(r.callsOf('updateObservation')).toEqual([]);
    expect(r.drafts).toEqual([]);
    expect(r.statusOf2(1)).toBe('unmapped_control');
  });
  it('a re-classification may land on another failure status (map found, lot expired -> lot_expired); that status is final: a second run does not pick it up', async () => {
    const r = rig([obsRow(1, 'unmapped_control')]);
    r.repo.findLot = async (_tx: any, _t: string, id: string) => lotRow(1, 1, { id, expires_on: '2026-11-12' }) as any;   // lot expired the day before (Asia/Kathmandu date of the observation is 2026-11-13)
    const first = await r.run(byInstrument);
    expect(first).toMatchObject({ reclassified: 1, counts: { lot_expired: 1 } });
    expect(r.byId(OBS(1))).toMatchObject({ status: 'lot_expired', lot_id: LOT(1), level_id: LVL(1), qc_run_id: null });
    const second = await r.run(byInstrument);
    expect(second).toMatchObject({ reclassified: 0, unchanged: 0 });
  });
  it('only the five §6.4 statuses are requested and only they can change: assigned, late_unassigned, lot_expired, unmapped_analyte, non_numeric are never read or rewritten', async () => {
    const others = ['assigned', 'late_unassigned', 'lot_expired', 'unmapped_analyte', 'non_numeric'].map((s, i) => obsRow(10 + i, s, { qc_run_id: s === 'assigned' ? RUN(7) : null }));
    const r = rig([...others, obsRow(1, 'unmapped_control')]);
    await r.run(byInstrument);
    const asked = r.callsOf('listPendingObservations').map((c) => (c.args[0] as any).statuses as string[]);
    expect(asked.length).toBeGreaterThan(0);
    for (const s of asked) expect([...s].sort()).toEqual(s.length === 1 ? ['no_plan'] : PENDING);   // the window read: five statuses; the D-60 read (plan scope only): no_plan
    for (let n = 10; n < 15; n++) expect(r.updates.map((u) => u.id)).not.toContain(OBS(n));
    expect(r.byId(OBS(10))).toMatchObject({ status: 'assigned', qc_run_id: RUN(7) });
    expect(r.updates.map((u) => u.id)).toEqual([OBS(1)]);
  });
  it('the updates touch classification columns only (value, observed_at, received_at, control raws, source ids are never rewritten) and carry the expected old status', async () => {
    const before = obsRow(1, 'unmapped_control');
    const r = rig([before]);
    await r.run(byInstrument);
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0]!.expectedStatus).toBe('unmapped_control');
    expect(Object.keys(r.updates[0]!.patch).sort()).toEqual(PATCH_KEYS);
    const after = r.byId(OBS(1));
    for (const k of ['value', 'observed_at', 'received_at', 'control_id_raw', 'control_lot_raw', 'source_qc_result_id', 'instrument_id', 'analyte_id', 'unit_code']) expect(after[k], k).toEqual(before[k]);
  });
});

describe('window: reprocess_window_days (default 7) anchors on ctx.now()', () => {
  const at = (iso: string) => ({ observed_at: iso, received_at: iso, instrument_result_time: iso });
  it('inside the window is re-processed, outside is left alone (instrument scope never adopts history, D-60 is plan activation only)', async () => {
    const r = rig([obsRow(1, 'unmapped_control', at('2026-11-07T00:00:00.000Z')), obsRow(2, 'unmapped_control', at('2026-11-05T00:00:00.000Z')), obsRow(3, 'no_plan', at(OLD))]);
    const res = await r.run(byInstrument);
    expect(res).toMatchObject({ reclassified: 1, adopted: 0 });
    expect(r.statusOf2(1)).not.toBe('unmapped_control');
    expect(r.statusOf2(2)).toBe('unmapped_control');
    expect(r.statusOf2(3)).toBe('no_plan');
    expect(r.callsOf('listPendingObservations').every((c) => (c.args[0] as any).observedBefore === undefined)).toBe(true);
  });
  it('the window length is read from the tenant settings (30 days -> the 8-day-old row is now in), per tenant', async () => {
    const r = rig([obsRow(1, 'unmapped_control', at('2026-11-05T00:00:00.000Z'))], { hooks: { windowDays: 30 } });
    await r.run(byInstrument);
    expect(r.callsOf('getReprocessWindowDays').map((c) => c.tenantId)).toEqual([TENANT_A]);
    expect(r.statusOf2(1)).toBe('assigned');
  });
  it('the cut-off moves with ctx.now(): the same row is outside the window a week later', async () => {
    const late = rig([obsRow(1, 'unmapped_control', at('2026-11-13T17:59:00.000Z'))], { ctx: { now: '2026-11-21T19:00:00.000Z' } });
    await late.run(byInstrument);
    expect(late.statusOf2(1)).toBe('unmapped_control');
  });
});

describe('AC-04.7 plan activation adopts Phase-1 history: rows 4-8 only, never assembled (D-60)', () => {
  const old = (n: number, o: Row = {}) => obsRow(n, 'no_plan', { observed_at: OLD, received_at: OLD, instrument_result_time: OLD, ...o });
  const adoptionRows = () => [
    old(1),                                                                          // QC-L1 -> LOT1, target effective since 2026-08-01  => would be assigned -> late_unassigned
    old(2, { control_id_raw: 'QC-L2', control_lot_raw: null, control_level_raw: '2' }),   // QC-L2 -> LOT2                                    => late_unassigned
    old(3, { control_id_raw: 'QC-NOPE', control_lot_raw: null }),                    // no map                                             => unmapped_control
    old(4, { control_id_raw: 'QC-L5', control_lot_raw: null }),                      // LOT5 is level 3, not in the plan                  => level_not_in_plan
    old(5, { control_id_raw: 'QC-LX', control_lot_raw: null }),                      // LOT6 expired 2026-08-31                           => lot_expired
    old(6, { control_id_raw: 'QC-L3', control_lot_raw: null, control_level_raw: '2' }),   // LOT4 (level 2) has no target                  => no_target
    old(7, { unit_code: 'g_dl' }),                                                   // target unit is mmol_l                             => unit_mismatch
  ];
  const expected: Record<number, string> = { 1: 'late_unassigned', 2: 'late_unassigned', 3: 'unmapped_control', 4: 'level_not_in_plan', 5: 'lot_expired', 6: 'no_target', 7: 'unit_mismatch' };

  it('older no_plan observations get rows 4-8; anything that would be assigned becomes late_unassigned; nothing is assembled, even with no evaluated run or one far in the past', async () => {
    for (const runs of [[], [{ plan_id: PLN(1), run_at: '2026-08-01T00:00:00.000000Z' }]]) {
      const r = rig(adoptionRows(), { seed: { rich: true, runs } });
      const res = await r.run(byPlan);
      expect(res).toMatchObject({ adopted: 7, reclassified: 0, unchanged: 0, counts: { late_unassigned: 2, unmapped_control: 1, level_not_in_plan: 1, lot_expired: 1, no_target: 1, unit_mismatch: 1 } });
      for (const [n, status] of Object.entries(expected)) expect(r.statusOf2(Number(n)), `obs ${n}`).toBe(status);
      expect(r.drafts, 'the run assembler is never called for history').toEqual([]);
      expect(r.observations.every((o: Row) => o['qc_run_id'] == null && o['status'] !== 'assigned')).toBe(true);
    }
  });
  it('adopted rows carry the snapshot that feeds the LJ chart and "establish from data": plan/lot/level always set once found; target snapshot + z on late_unassigned; no_target keeps lot and level and has no target', async () => {
    const r = rig(adoptionRows(), { seed: { rich: true } });
    await r.run(byPlan);
    expect(r.byId(OBS(1))).toMatchObject({ plan_id: PLN(1), lot_id: LOT(1), level_id: LVL(1), target_id: TGT(1), mean: '100.000000', sd: '2.000000', z: '2.000000', qc_run_id: null });
    expect(r.byId(OBS(6))).toMatchObject({ plan_id: PLN(1), lot_id: LOT(4), level_id: LVL(2), target_id: null, mean: null, sd: null, z: null, qc_run_id: null });
    expect(r.byId(OBS(3))).toMatchObject({ plan_id: PLN(1), lot_id: null, qc_run_id: null });
  });
  it('no run, no event and no result hold: the job tx sees only savepoint statements (the fake repo owns every other write), no enqueue, no publish', async () => {
    const r = rig(adoptionRows(), { seed: { rich: true } });
    await r.run(byPlan);
    for (const text of savepointTexts(r)) expect(text, text).toMatch(/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) /i);
    expect(r.callsOf('latestEvaluatedRunAt'), 'row 9 is not evaluated for history').toEqual([]);
  });
  it('rows 4-8 only: a value that would reject the run (z = 5) is adopted without an assembler call, a run or an event', async () => {
    const r = rig([old(1, { value: '110.000000' })], { seed: { rich: true } });
    await r.run(byPlan);
    expect(r.byId(OBS(1))).toMatchObject({ status: 'late_unassigned', z: '5.000000', qc_run_id: null });
    expect(r.drafts).toEqual([]);
  });
  it('only no_plan history is adopted, and only on plan scope: older unmapped_control / no_target / level_not_in_plan / unit_mismatch rows stay; the older-than-window read asks for no_plan alone', async () => {
    const r = rig([old(1), ...['unmapped_control', 'no_target', 'level_not_in_plan', 'unit_mismatch'].map((s, i) => obsRow(20 + i, s, { observed_at: OLD, received_at: OLD, instrument_result_time: OLD }))], { seed: { rich: true } });
    await r.run(byPlan);
    expect(r.statusOf2(1)).toBe('late_unassigned');
    expect(r.statusOf2(20)).toBe('unmapped_control'); expect(r.statusOf2(21)).toBe('no_target'); expect(r.statusOf2(22)).toBe('level_not_in_plan'); expect(r.statusOf2(23)).toBe('unit_mismatch');
    const old_ = r.callsOf('listPendingObservations').map((c) => c.args[0] as any).filter((q) => q.observedBefore !== undefined);
    expect(old_.length).toBeGreaterThan(0);
    for (const q of old_) expect(q.statuses).toEqual(['no_plan']);
    const inWin = r.callsOf('listPendingObservations').map((c) => c.args[0] as any).filter((q) => q.observedBefore === undefined);
    for (const q of inWin) expect(q.observedFrom).toBeDefined();   // an in-window read is always bounded below by now - window
  });
  it('instrument scope (map created) does not adopt history: the same old no_plan rows stay no_plan', async () => {
    const r = rig(adoptionRows(), { seed: { rich: true } });
    const res = await r.run(byInstrument);
    expect(res).toMatchObject({ adopted: 0 });
    expect(r.observations.every((o: Row) => o['status'] === 'no_plan')).toBe(true);
  });
  it('plan scope is the plan\'s own pair: older no_plan rows of another analyte or of another instrument are untouched', async () => {
    const r = rig([old(1), old(2, { analyte_id: ANA(2) }), old(3, { instrument_id: INS(2) })], { seed: { rich: true } });
    await r.run(byPlan);
    expect(r.statusOf2(1)).toBe('late_unassigned');
    expect(r.statusOf2(2)).toBe('no_plan'); expect(r.statusOf2(3)).toBe('no_plan');
  });
  it('plan not active (retired / draft) or unknown: nothing is adopted, nothing is written, no error', async () => {
    for (const plans of [[planRow({ status: 'retired' })], [planRow({ status: 'draft' })], [planRow({ id: PLN(5) })]]) {
      const r = rig([old(1), obsRow(2, 'no_plan')], { seed: { rich: true, plans } });
      expect(await r.run(byPlan)).toMatchObject({ reclassified: 0, adopted: 0 });
      expect(r.callsOf('updateObservation')).toEqual([]);
      expect(r.drafts).toEqual([]);
    }
  });
  it('a mixed pair: the in-window no_plan row is fully re-classified (rows 4-10, assigned through the assembler) while the older one is adopted as late_unassigned', async () => {
    const r = rig([old(1), obsRow(2, 'no_plan')], { seed: { rich: true } });
    const res = await r.run(byPlan);
    expect(res).toMatchObject({ reclassified: 1, adopted: 1 });
    expect(r.statusOf2(1)).toBe('late_unassigned');
    expect(r.statusOf2(2)).toBe('assigned');
    expect(r.drafts.map((d) => d['id'])).toEqual([OBS(2)]);
  });
  it('target activation re-sends the same {plan_id} payload: the second run over adopted history changes nothing (idempotent)', async () => {
    const r = rig(adoptionRows(), { seed: { rich: true } });
    await r.run(byPlan);
    const snapshot = structuredClone(r.observations);
    const again = await r.run(byPlan);
    expect(again).toMatchObject({ reclassified: 0, adopted: 0 });
    expect(r.observations).toEqual(snapshot);
    expect(r.drafts).toEqual([]);
  });
});

describe('locking, tenancy, scope, concurrency', () => {
  it('plan scope: the pair is locked (FOR UPDATE through repo.lockPair) before the candidates are read and before any row is updated', async () => {
    const r = rig([obsRow(1, 'unmapped_control')]);
    await r.run(byPlan);
    const ops = r.calls.map((c) => c.op);
    const lock = ops.indexOf('lockPair');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(r.callsOf('lockPair')[0]!.args).toEqual([INS(1), ANA(1)]);
    expect(lock).toBeLessThan(ops.indexOf('listPendingObservations'));
    expect(lock).toBeLessThan(ops.indexOf('updateObservation'));
  });
  it('instrument scope: every pair is locked before any of its rows is updated, in a deterministic (ascending analyte) order', async () => {
    const r = rig([obsRow(1, 'unmapped_control', { analyte_id: ANA(2) }), obsRow(2, 'unmapped_control')], { seed: { plans: [planRow(), planRow({ id: PLN(2), analyte_id: ANA(2) })] } });
    await r.run(byInstrument);
    const locks = r.callsOf('lockPair').map((c) => c.args[1]);
    expect(locks).toEqual([...locks].sort());
    const ops = r.calls.map((c) => `${c.op}`);
    expect(ops.indexOf('lockPair')).toBeLessThan(ops.indexOf('updateObservation'));
    expect(new Set(locks)).toEqual(new Set([ANA(1), ANA(2)]));
  });
  it('tenant isolation: only tenant A rows move, every repo call names tenant A, a plan id of tenant B is "unknown" (no read, no write)', async () => {
    const other = obsRow(9, 'unmapped_control', { tenant_id: TENANT_B });
    const r = rig([obsRow(1, 'unmapped_control'), other]);
    await r.run(byInstrument);
    expect(r.byId(OBS(9))).toMatchObject({ status: 'unmapped_control' });
    expect(r.calls.filter((c) => c.tenantId !== undefined).every((c) => c.tenantId === TENANT_A)).toBe(true);
    const foreign = rig([obsRow(1, 'no_plan')], { seed: { plans: [planRow({ id: PLN(9), tenant_id: TENANT_B })] } });
    expect(await foreign.run({ plan_id: PLN(9) })).toMatchObject({ reclassified: 0, adopted: 0 });
    expect(foreign.callsOf('updateObservation')).toEqual([]);
  });
  it('neither instrument_id nor plan_id: rejected before any repo call (no tenant-wide sweep)', async () => {
    const r = rig([obsRow(1, 'unmapped_control')]);
    await rejection(r.run({}));
    expect(r.calls).toEqual([]);
  });
  it('optimistic guard: a row changed by a concurrent job (update returns false) is rolled back to its savepoint, counted unchanged, and the job does not fail', async () => {
    const r = rig([obsRow(1, 'unmapped_control'), obsRow(2, 'unmapped_control', { observed_at: '2026-11-13T18:10:00.000Z', received_at: '2026-11-13T18:10:00.000Z' })], { hooks: { lost: (id) => id === OBS(1) } });
    const res = await r.run(byInstrument);
    expect(res).toMatchObject({ reclassified: 1, unchanged: 1 });
    expect(r.statusOf2(1)).toBe('unmapped_control');
    expect(r.statusOf2(2)).toBe('assigned');
    expect(savepointTexts(r).filter((t) => /^ROLLBACK TO SAVEPOINT/i.test(t))).toHaveLength(1);
  });
  it('every row runs in its own savepoint: SAVEPOINT / RELEASE pairs for the rows that changed', async () => {
    const r = rig([obsRow(1, 'unmapped_control'), obsRow(2, 'unmapped_control', { observed_at: '2026-11-13T18:10:00.000Z', received_at: '2026-11-13T18:10:00.000Z' })]);
    await r.run(byInstrument);
    const sp = savepointTexts(r);
    expect(sp.filter((t) => /^SAVEPOINT\b/i.test(t))).toHaveLength(2);
    expect(sp.filter((t) => /^RELEASE SAVEPOINT\b/i.test(t))).toHaveLength(2);
  });
  it('a data error (class 22/23) on one row skips that row only: logged as id + SQLSTATE (no values, no raw control id), the others continue; any other error aborts the run', async () => {
    const poison = Object.assign(new Error(`bad value ${SECRET_RAW}`), { code: '23514' });
    const r = rig([obsRow(1, 'unmapped_control', { control_id_raw: 'QC-L1' }), obsRow(2, 'unmapped_control', { control_id_raw: 'QC-L2', control_lot_raw: null, observed_at: '2026-11-13T18:10:00.000Z', received_at: '2026-11-13T18:10:00.000Z' })],
      { hooks: { updateFails: (id) => (id === OBS(1) ? poison : undefined) } });
    const res = await r.run(byInstrument);
    expect(res).toMatchObject({ reclassified: 1 });
    expect(r.statusOf2(1)).toBe('unmapped_control');
    expect(r.statusOf2(2)).toBe('assigned');
    expect(r.logText()).toContain('23514');
    expect(r.logText()).not.toContain(SECRET_RAW);
    expect(r.logText()).not.toContain('104.000000');
    expect(savepointTexts(r).filter((t) => /^ROLLBACK TO SAVEPOINT/i.test(t))).toHaveLength(1);
    const hard = rig([obsRow(1, 'unmapped_control')], { hooks: { updateFails: () => Object.assign(new Error('deadlock'), { code: '40P01' }) } });
    expect((await rejection(hard.run(byInstrument))).code).toBe('40P01');
  });
  it('an assembler failure (not a data error) aborts the run and nothing is written for the row', async () => {
    const r = rig([obsRow(1, 'unmapped_control')], { assembleFails: new Error('assembler down') });
    await rejection(r.run(byInstrument));
    expect(r.callsOf('updateObservation')).toEqual([]);
    expect(r.statusOf2(1)).toBe('unmapped_control');
  });
  it('no QC value, z-score or raw control id is ever logged on the happy path either', async () => {
    const r = rig([obsRow(1, 'unmapped_control', { control_id_raw: SECRET_RAW, control_lot_raw: null }), obsRow(2, 'no_plan', { observed_at: OLD, received_at: OLD, instrument_result_time: OLD })]);
    await r.run(byPlan).catch(() => undefined);
    expect(r.logText()).not.toContain(SECRET_RAW);
  });
});
