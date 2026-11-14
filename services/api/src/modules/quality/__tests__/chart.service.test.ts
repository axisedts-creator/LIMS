// C9 T-14 — LJ chart data service (02-TRD §7.10 LjChartDto, point status mapping, z view; §5.5 #35; PRD AC-08.1, AC-08.4; 07-SECURITY REQ-SEC-024/081/098/100, S-16).
// No database: fake ChartRepo (chart.helpers.ts, SEAMS in its header). Fails now: "Cannot find module ../service/chart.service.js" (and ../repository/chart.repo.js).
import { describe, expect, it } from 'vitest';
import { createChartService } from '../service/chart.service.js';
import { BODY_KEYS, DAY_MS, FROM, L2, LOT, LVL, OBS, PLANTED, PLAN_KEYS, PLN, POINT_KEYS, RUN, SERIES_KEYS, STATUSES, T, TARGET_KEYS, TENANT_A, TENANT_B, TGT, TO,
  baseSeed, code, makeChartCatalog, makeChartCtx, makeChartRepo, noRights, obs, plan, readOnly, rejection, run, target, type ChartSeed } from './chart.helpers.js';

const setup = (seed: ChartSeed = baseSeed(), o: { maxPoints?: number; ctx?: Parameters<typeof makeChartCtx>[0] } = {}) => {
  const fake = makeChartRepo(seed); const c = makeChartCtx(o.ctx);
  return { fake, ...c, svc: createChartService({ repo: fake.repo, ...(o.maxPoints ? { maxPoints: o.maxPoints } : {}) }) };
};
const q = (o: object = {}) => ({ planId: PLN(1), view: 'level', levelId: LVL(1), observedAtFrom: FROM, observedAtTo: TO, ...o });
const get = async (s: ReturnType<typeof setup>, o: object = {}) => (await s.svc.getLeveyJenningsChart(s.ctx, q(o))).body;

describe('AC-08.1 — level view: one point per observation, never merged, plan header', () => {
  it('200 + LjChartDto: plan header from the plan + CatalogPort, view level, one series (L1 x LOT-SYN-1), points ascending, truncated false', async () => {
    const s = setup(); const r = await s.svc.getLeveyJenningsChart(s.ctx, q());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      plan: { id: PLN(1), instrument_id: expect.any(String), analyte_id: expect.any(String), analyte_code: 'GLU1', unit_code: 'mg_dl', decimals: 1 },
      view: 'level', truncated: false,
      series: [{
        level_id: LVL(1), level_code: 'L1', lot_id: LOT(1), lot_no: 'LOT-SYN-1',
        points: [
          { observation_id: OBS(1), observed_at: T('08:00:00'), value: '100.4', z: '0.200', status: 'accepted', qc_run_id: RUN(1), rule_hits: [] },
          { observation_id: OBS(2), observed_at: T('09:00:00'), value: '103.0', z: '1.500', status: 'accepted', qc_run_id: RUN(2), rule_hits: [] },
          { observation_id: OBS(3), observed_at: T('10:00:00'), value: '106.4', z: '3.200', status: 'rejected', qc_run_id: RUN(3), rule_hits: ['1-3s'] },
        ],
        targets: [{ target_id: TGT(1), effective_from: '2026-09-01T00:00:00.000Z', mean: '100.000000', sd: '2.000000', source: 'manufacturer' }],
      }],
    });
  });
  it('view defaults to level; points are ordered by observed time then id whatever the repo order; observed_at leaves as ISO with ms', async () => {
    const seed = baseSeed(); seed.observations = [seed.observations![2]!, seed.observations![0]!, obs(4, T('08:00:00'), '99.0', '-0.500000', { qc_run_id: RUN(1) })];
    const s = setup(seed); const { view, series } = await get(s, { view: undefined });
    expect(view).toBe('level'); expect(series[0].points.map((p: any) => p.observation_id)).toEqual([OBS(1), OBS(4), OBS(3)]);
    for (const p of series[0].points) expect(p.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
  it('never merges levels or lots: a level with two lots gives two series (sorted by lot_no); another level never appears; the repo is asked for that level', async () => {
    const seed = baseSeed();
    seed.observations!.push(obs(4, T('11:00:00'), '101.0', '0.500000', { lot_id: LOT(3), lot_no: 'LOT-SYN-0', qc_run_id: RUN(1) }), obs(5, T('11:30:00'), '55.0', '0.100000', { ...L2, qc_run_id: RUN(1) }));
    const s = setup(seed); const { series } = await get(s);
    expect(series.map((x: any) => [x.level_code, x.lot_no, x.points.length])).toEqual([['L1', 'LOT-SYN-0', 1], ['L1', 'LOT-SYN-1', 3]]);
    expect(series.flatMap((x: any) => x.points.map((p: any) => p.observation_id))).not.toContain(OBS(5));
    expect(s.fake.calls.find((c) => c.op === 'listChartObservations')!.args[0]).toMatchObject({ planId: PLN(1), levelId: LVL(1), from: FROM, to: TO });
  });
  it('lot_id narrows to that lot only (passed to the repo, series of other lots absent)', async () => {
    const seed = baseSeed(); seed.observations!.push(obs(4, T('11:00:00'), '101.0', '0.500000', { lot_id: LOT(3), lot_no: 'LOT-SYN-0', qc_run_id: RUN(1) }));
    const s = setup(seed); const { series } = await get(s, { lotId: LOT(3) });
    expect(series.map((x: any) => x.lot_no)).toEqual(['LOT-SYN-0']); expect(s.fake.calls.find((c) => c.op === 'listChartObservations')!.args[0].lotId).toBe(LOT(3));
  });
  it('a period without observations -> 200 with series [] and truncated false (UI: "No QC values in this period."); no run or target read', async () => {
    const s = setup(); const r = await s.svc.getLeveyJenningsChart(s.ctx, q({ observedAtFrom: '2026-01-01T00:00:00.000Z', observedAtTo: '2026-01-31T00:00:00.000Z' }));
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ series: [], truncated: false, view: 'level', plan: { id: PLN(1) } }); expect(s.fake.ops()).toEqual(['findPlan', 'listChartObservations']);
  });
  it('the period is inclusive at both ends (an observation exactly at from / to is charted); one outside is not', async () => {
    const seed = baseSeed(); seed.observations = [obs(1, FROM, '1.0', '0.1'), obs(2, TO, '2.0', '0.2'), obs(3, '2026-09-30T23:59:59.999Z', '3.0', '0.3'), obs(4, '2026-11-01T00:00:00.001Z', '4.0', '0.4')];
    const { series } = await get(setup(seed));
    expect(series[0].points.map((p: any) => p.observation_id)).toEqual([OBS(1), OBS(2)]);
  });
  it('decimals / unit: no unit in the catalog -> unit_code omitted; no decimals -> 0 (as target.service)', async () => {
    const s = setup(baseSeed(), { ctx: { catalog: makeChartCatalog({ unitCode: undefined, decimals: undefined, plans: [plan(1)] }) } });
    const p = (await get(s)).plan; expect(p).not.toHaveProperty('unit_code'); expect(p.decimals).toBe(0); expect(p.analyte_code).toBe('GLU1');
  });
});

describe('AC-08.1 — target segments (the target in force at each point; step change when targets change)', () => {
  const stepSeed = () => {
    const seed = baseSeed();
    seed.targets = [
      target(1, '2026-09-01T00:00:00.000Z', { status: 'superseded', effective_to: '2026-10-10T08:30:00.000Z', mean: '100.000000', sd: '2.000000' }),
      target(2, '2026-10-10T08:30:00.000Z', { status: 'active', mean: '104.000000', sd: '2.500000', source: 'established' }),
      target(3, '2026-09-01T00:00:00.000Z', { ...L2, mean: '50.000000', sd: '1.000000' }),                       // another level / lot
      target(4, '2026-09-01T00:00:00.000Z', { lot_id: LOT(7), mean: '1.000000', sd: '1.000000' }),                  // a lot with no point in range
    ];
    return seed;
  };
  it('a step change = two ordered segments: effective_to only on the closed one, mean/sd/source untouched, no other columns', async () => {
    const t = (await get(setup(stepSeed()))).series[0].targets;
    expect(t).toEqual([
      { target_id: TGT(1), effective_from: '2026-09-01T00:00:00.000Z', effective_to: '2026-10-10T08:30:00.000Z', mean: '100.000000', sd: '2.000000', source: 'manufacturer' },
      { target_id: TGT(2), effective_from: '2026-10-10T08:30:00.000Z', mean: '104.000000', sd: '2.500000', source: 'established' },
    ]);
    expect(t[1]).not.toHaveProperty('effective_to');
  });
  it('segments are ordered by effective_from whatever the repo order, and belong to their own (level, lot) series only', async () => {
    const seed = stepSeed(); seed.targets!.reverse();
    seed.observations!.push(obs(9, T('12:00:00'), '50.0', '0.000000', { ...L2, qc_run_id: RUN(1) }));
    const { series } = await get(setup(seed), { view: 'z', levelId: undefined });
    expect(series.map((x: any) => [x.level_code, x.targets.map((t: any) => t.target_id)])).toEqual([['L1', [TGT(1), TGT(2)]], ['L2', [TGT(3)]]]);
  });
  it('the repo gets the plan, the DISTINCT lots of the charted points and the period; targets are read once (no per-series query)', async () => {
    const seed = stepSeed(); seed.observations!.push(obs(9, T('12:00:00'), '50.0', '0.000000', { ...L2, qc_run_id: RUN(1) }));
    const s = setup(seed); await get(s, { view: 'z', levelId: undefined });
    const calls = s.fake.calls.filter((c) => c.op === 'listTargetsForChart'); expect(calls).toHaveLength(1);
    const a = calls[0]!.args[0]; expect(a).toMatchObject({ planId: PLN(1), from: FROM, to: TO }); expect([...a.lotIds].sort()).toEqual([LOT(1), LOT(2)].sort());
  });
  it('a series with points but no target in force still renders: targets []', async () => {
    const seed = baseSeed(); seed.targets = []; const { series } = await get(setup(seed));
    expect(series[0].targets).toEqual([]); expect(series[0].points).toHaveLength(3);
  });
  it('draft / discarded targets and targets that ended before the period never come back (repo filter) — the service adds no segment of its own', async () => {
    const seed = baseSeed();
    seed.targets = [target(1, '2026-01-01T00:00:00.000Z', { status: 'superseded', effective_to: '2026-02-01T00:00:00.000Z' }), target(2, '2026-09-01T00:00:00.000Z', { status: 'draft', effective_from: '2026-09-01T00:00:00.000Z' }),
      target(3, '2026-09-01T00:00:00.000Z', { status: 'discarded' }), target(4, '2026-09-01T00:00:00.000Z', { status: 'retired', effective_to: '2026-10-05T00:00:00.000Z' })];
    expect((await get(setup(seed))).series[0].targets.map((t: any) => t.target_id)).toEqual([TGT(4)]);
  });
});

describe('§7.10 point status mapping (first match wins) + rule_hits + z on the wire', () => {
  // [label, observation overrides, run (or null = no run row), z (6 dp stored), expected status, expected rule_hits]
  const R = (outcome: string | null, o: object = {}) => run(1, outcome, o);
  const V: Array<[string, object, ReturnType<typeof run> | null, string | null, string, string[]]> = [
    ['excluded observation (still listed by the run: rule_hits follow rule_detail, status does not)', { status: 'excluded' }, R('rejected', { rule_detail: [{ rule: '1-3s', observation_ids: [OBS(1)] }] }), '3.500000', 'excluded', ['1-3s']],
    ['excluded beats collecting', { status: 'excluded' }, R(null), '0.100000', 'excluded', []],
    ['no_target (not assigned)', { status: 'no_target', qc_run_id: null }, null, null, 'unevaluated', []],
    ['unit_mismatch (not assigned)', { status: 'unit_mismatch', qc_run_id: null }, null, null, 'unevaluated', []],
    ['lot_expired (not assigned)', { status: 'lot_expired', qc_run_id: null }, null, null, 'unevaluated', []],
    ['late_unassigned (history, never assembled)', { status: 'late_unassigned', qc_run_id: null }, null, '0.400000', 'unevaluated', []],
    ['unevaluated beats collecting', { status: 'no_target' }, R(null), null, 'unevaluated', []],
    ['assigned in a collecting run', {}, R(null), '2.800000', 'collecting', []],
    ['rejected run, listed in rule_detail', {}, R('rejected', { rule_detail: [{ rule: '1-3s', observation_ids: [OBS(1)] }] }), '3.200000', 'rejected', ['1-3s']],
    ['rejected + closed run, listed', {}, R('rejected', { status: 'closed', rule_detail: [{ rule: '2-2s', observation_ids: [OBS(1), OBS(2)] }] }), '2.300000', 'rejected', ['2-2s']],
    ['rejected run, listed under two rules (distinct, rule_detail order)', {}, R('rejected', { rule_detail: [{ rule: '2-2s', observation_ids: [OBS(1)] }, { rule: '1-3s', observation_ids: [OBS(1)] }, { rule: '2-2s', observation_ids: [OBS(1)] }] }), '3.100000', 'rejected', ['2-2s', '1-3s']],
    ['rejected run, NOT listed, within 2SD -> accepted', {}, R('rejected', { rule_detail: [{ rule: '1-3s', observation_ids: [OBS(2)] }] }), '0.500000', 'accepted', []],
    ['rejected run, NOT listed, beyond 2SD -> warning', {}, R('rejected', { rule_detail: [{ rule: '1-3s', observation_ids: [OBS(2)] }] }), '2.500000', 'warning', []],
    ['accepted run, z = 2 exactly is not beyond', {}, R('accepted'), '2.000000', 'accepted', []],
    ['accepted run, z = -2 exactly is not beyond', {}, R('accepted'), '-2.000000', 'accepted', []],
    ['accepted run, z = 2.000001 (exact 6 dp, the 3 dp wire value would read 2.000)', {}, R('accepted'), '2.000001', 'warning', []],
    ['accepted run, z = -2.000001', {}, R('accepted'), '-2.000001', 'warning', []],
    ['accepted run, z = -1.999999', {}, R('accepted'), '-1.999999', 'accepted', []],
    ['accepted_warning run, beyond 2SD, listed under 1-2s', {}, R('accepted_warning', { rule_detail: [{ rule: '1-2s', observation_ids: [OBS(1)] }] }), '2.300000', 'warning', ['1-2s']],
    ['accepted_warning run, within 2SD', {}, R('accepted_warning'), '0.500000', 'accepted', []],
    ['incomplete run, within 2SD', {}, R('incomplete'), '0.100000', 'accepted', []],
    ['incomplete run, beyond 2SD', {}, R('incomplete'), '-2.600000', 'warning', []],
  ];
  it.each(V)('%s', async (_label, over, runRow, z, status, hits) => {
    const seed: ChartSeed = { plans: [plan(1)], observations: [obs(1, T('08:00:00'), '100.0', z, over)], runs: runRow ? [runRow] : [], targets: [target(1, '2026-09-01T00:00:00.000Z')] };
    const p = (await get(setup(seed))).series[0].points[0];
    expect(p.status).toBe(status); expect(p.rule_hits).toEqual(hits); expect(STATUSES).toContain(p.status);
  });
  it('the status uses the run of EACH observation (two runs in one chart)', async () => {
    const seed: ChartSeed = { plans: [plan(1)], observations: [obs(1, T('08:00:00'), '100.0', '0.5', { qc_run_id: RUN(1) }), obs(2, T('09:00:00'), '100.0', '0.5', { qc_run_id: RUN(2) })], runs: [run(1, 'accepted'), run(2, null)], targets: [] };
    expect((await get(setup(seed))).series[0].points.map((p: any) => p.status)).toEqual(['accepted', 'collecting']);
  });
  it('z: 3 dp half-up on the wire, padded; absent KEY (never null) for an observation with no z; qc_run_id absent when none; value passes through as stored', async () => {
    const seed: ChartSeed = { plans: [plan(1)], runs: [run(1, 'accepted')], targets: [], observations: [
      obs(1, T('08:00:00'), '100.40', '2.345500'), obs(2, T('08:01:00'), '100.4', '0.123400'), obs(3, T('08:02:00'), '100', '0.100000'), obs(4, T('08:03:00'), '7.5', null, { status: 'no_target', qc_run_id: null })] };
    const pts = (await get(setup(seed))).series[0].points;
    expect(pts.map((p: any) => p.z)).toEqual(['2.346', '0.123', '0.100', undefined]); expect(pts.map((p: any) => p.value)).toEqual(['100.40', '100.4', '100', '7.5']);
    expect(pts[3]).not.toHaveProperty('z'); expect(pts[3]).not.toHaveProperty('qc_run_id'); expect(pts[3].rule_hits).toEqual([]);
  });
  it('runs are read once for the DISTINCT run ids of the charted points (no per-point query)', async () => {
    const seed = baseSeed(); for (let i = 4; i <= 40; i++) seed.observations!.push(obs(i, `2026-10-11T${String(i % 24).padStart(2, '0')}:10:00.000Z`, '100.0', '0.1', { qc_run_id: RUN(1 + (i % 3)) }));
    const s = setup(seed); await get(s);
    const c = s.fake.calls.filter((x) => x.op === 'listRunsForChart'); expect(c).toHaveLength(1); expect([...c[0]!.args[0]].sort()).toEqual([RUN(1), RUN(2), RUN(3)].sort());
    expect(s.fake.ops()).toEqual(expect.arrayContaining(['findPlan', 'listChartObservations', 'listRunsForChart', 'listTargetsForChart'])); expect(s.fake.calls).toHaveLength(4);
  });
});

describe('truncation (§7.10: more than LIMIT points -> newest kept, truncated = true)', () => {
  const many = (n: number, lot = 1): ChartSeed => ({ plans: [plan(1)], runs: [run(1, 'accepted')], targets: [],
    observations: Array.from({ length: n }, (_, i) => obs(100 + i, new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 60_000).toISOString(), '100.0', '0.1', lot === 1 ? {} : { lot_id: LOT(lot), lot_no: `LOT-SYN-${lot}` })) });
  it('maxPoints + 1 rows are requested; exactly maxPoints -> all points, truncated false; maxPoints + 1 -> the NEWEST maxPoints (ascending), truncated true', async () => {
    const a = setup(many(5), { maxPoints: 5 }); const ra = await get(a);
    expect(ra.truncated).toBe(false); expect(ra.series[0].points).toHaveLength(5); expect(a.fake.calls.find((c) => c.op === 'listChartObservations')!.args[0].limit).toBe(6);
    const b = setup(many(8), { maxPoints: 5 }); const rb = await get(b);
    expect(rb.truncated).toBe(true); expect(rb.series[0].points.map((p: any) => p.observation_id)).toEqual([OBS(103), OBS(104), OBS(105), OBS(106), OBS(107)]);
  });
  it('the default cap is 2,000 (LIMS_QUALITY_LJ_MAX_POINTS): 2,000 points -> not truncated, 2,001 -> truncated with 2,000 kept', async () => {
    const mk = (n: number) => { const fake = makeChartRepo(many(n)); const c = makeChartCtx(); return { fake, c, svc: createChartService({ repo: fake.repo }) }; };
    const a = mk(2000); const ra = (await a.svc.getLeveyJenningsChart(a.c.ctx, q())).body; expect(ra.truncated).toBe(false); expect(ra.series[0].points).toHaveLength(2000);
    const b = mk(2001); const rb = (await b.svc.getLeveyJenningsChart(b.c.ctx, q())).body; expect(rb.truncated).toBe(true); expect(rb.series[0].points).toHaveLength(2000);
    expect(rb.series[0].points[0].observation_id).toBe(OBS(101)); expect(b.fake.calls.find((c) => c.op === 'listChartObservations')!.args[0].limit).toBe(2001);
  });
  it('the cap is per chart, not per series: two lots share it; a series whose points were all cut disappears; targets are read only for the kept lots', async () => {
    const seed = many(4, 1); seed.observations!.push(...many(4, 2).observations!.map((o, i) => ({ ...o, id: OBS(200 + i), observed_at: new Date(Date.parse('2026-10-05T00:00:00.000Z') + i * 60_000).toISOString() })));
    seed.targets = [target(1, '2026-09-01T00:00:00.000Z'), target(2, '2026-09-01T00:00:00.000Z', { lot_id: LOT(2) })];
    const s = setup(seed, { maxPoints: 4 }); const r = await get(s, { levelId: LVL(1) });
    expect(r.truncated).toBe(true); expect(r.series.map((x: any) => [x.lot_no, x.points.length])).toEqual([['LOT-SYN-2', 4]]); expect(r.series[0].targets.map((t: any) => t.target_id)).toEqual([TGT(2)]);
    expect(s.fake.calls.find((c) => c.op === 'listTargetsForChart')!.args[0].lotIds).toEqual([LOT(2)]);
  });
});

describe('AC-08.4 — z view: every level of the plan in SD units, one series per (level, lot)', () => {
  const twoLevels = () => {
    const seed = baseSeed();
    seed.observations!.push(obs(4, T('08:30:00'), '51.0', '1.000000', { ...L2, qc_run_id: RUN(1) }), obs(5, T('09:30:00'), '49.0', '-1.000000', { ...L2, qc_run_id: RUN(2) }), obs(6, T('09:45:00'), '48.0', null, { ...L2, status: 'no_target', qc_run_id: null }));
    seed.targets!.push(target(2, '2026-09-01T00:00:00.000Z', { ...L2, mean: '50.000000', sd: '1.000000' }));
    return seed;
  };
  it('view z: body.view = z, series for BOTH levels (sorted by level_code, lot_no), points keep value + z + status, targets still returned, no level_id needed', async () => {
    const s = setup(twoLevels()); const r = (await s.svc.getLeveyJenningsChart(s.ctx, { planId: PLN(1), view: 'z', observedAtFrom: FROM, observedAtTo: TO })).body;
    expect(r.view).toBe('z'); expect(r.truncated).toBe(false);
    expect(r.series.map((x: any) => [x.level_code, x.lot_no, x.points.map((p: any) => p.z)])).toEqual([['L1', 'LOT-SYN-1', ['0.200', '1.500', '3.200']], ['L2', 'LOT-SYN-2', ['1.000', '-1.000', undefined]]]);
    expect(r.series[1].points.map((p: any) => p.status)).toEqual(['accepted', 'accepted', 'unevaluated']); expect(r.series[1].points[0].value).toBe('51.0');
    expect(r.series[1].targets.map((t: any) => t.target_id)).toEqual([TGT(2)]);
    expect(s.fake.calls.find((c) => c.op === 'listChartObservations')!.args[0].levelId).toBeUndefined();
  });
  it('levels and lots are still separate series in the z view (a level with two lots = two series); a level supplied in the z view does not narrow it', async () => {
    const seed = twoLevels(); seed.observations!.push(obs(7, T('12:00:00'), '100.0', '0.3', { lot_id: LOT(3), lot_no: 'LOT-SYN-0' }));
    const s = setup(seed); const r = (await s.svc.getLeveyJenningsChart(s.ctx, q({ view: 'z', levelId: LVL(1) }))).body;
    expect(r.series.map((x: any) => `${x.level_code}/${x.lot_no}`)).toEqual(['L1/LOT-SYN-0', 'L1/LOT-SYN-1', 'L2/LOT-SYN-2']); expect(s.fake.calls.find((c) => c.op === 'listChartObservations')!.args[0].levelId).toBeUndefined();
  });
  it('the z view is capped like the level view (per chart) and is not a different read: same four repo calls', async () => {
    const s = setup(twoLevels(), { maxPoints: 3 }); const r = (await s.svc.getLeveyJenningsChart(s.ctx, { planId: PLN(1), view: 'z', observedAtFrom: FROM, observedAtTo: TO })).body;
    expect(r.truncated).toBe(true); expect(r.series.flatMap((x: any) => x.points).length).toBe(3); expect(s.fake.ops()).toEqual(['findPlan', 'listChartObservations', 'listRunsForChart', 'listTargetsForChart']);
  });
});

describe('input hygiene (REQ-SEC-080/100, S-16): 400 common.validation_failed BEFORE any repo call', () => {
  const bad: Array<[string, object]> = [
    ['plan_id missing', { planId: undefined }], ['plan_id not a uuid', { planId: 'not-a-uuid' }], ['plan_id of the wrong type', { planId: 7 }],
    ['view unknown', { view: 'both' }], ['view of the wrong type', { view: ['z'] }], ['level view without level_id', { view: 'level', levelId: undefined }], ['view omitted (= level) without level_id', { view: undefined, levelId: undefined }],
    ['level_id not a uuid', { levelId: 'L1' }], ['lot_id not a uuid', { lotId: '1; DROP TABLE x' }],
    ['observed_at_from missing', { observedAtFrom: undefined }], ['observed_at_to missing', { observedAtTo: undefined }], ['from not an ISO-UTC instant', { observedAtFrom: '2026-10-01' }],
    ['to with an offset (not UTC)', { observedAtTo: '2026-11-01T00:00:00+05:45' }], ['to not a date', { observedAtTo: 'tomorrow' }], ['from after to', { observedAtFrom: TO, observedAtTo: FROM }],
    ['span 400 days + 1 ms', { observedAtFrom: '2025-01-01T00:00:00.000Z', observedAtTo: new Date(Date.parse('2025-01-01T00:00:00.000Z') + 400 * DAY_MS + 1).toISOString() }],
    ['span 5 years', { observedAtFrom: '2021-01-01T00:00:00.000Z', observedAtTo: '2026-01-01T00:00:00.000Z' }],
  ];
  it.each(bad)('%s', async (_n, o) => {
    const s = setup(); const e = await rejection(s.svc.getLeveyJenningsChart(s.ctx, q(o) as any));
    expect(code(e)).toBe('common.validation_failed'); expect(s.fake.calls).toHaveLength(0);
  });
  it('a non-object input is refused the same way', async () => {
    const s = setup(); for (const v of [undefined, null, 'x', 7]) expect(code(await rejection(s.svc.getLeveyJenningsChart(s.ctx, v as any)))).toBe('common.validation_failed'); expect(s.fake.calls).toHaveLength(0);
  });
  it('the span limit is inclusive: exactly 400 days is served; a single day is served; from = to is served', async () => {
    for (const [f, t] of [['2025-01-01T00:00:00.000Z', new Date(Date.parse('2025-01-01T00:00:00.000Z') + 400 * DAY_MS).toISOString()], [T('00:00:00'), T('23:59:59')], [T('08:00:00'), T('08:00:00')]] as const) {
      const s = setup(); expect((await s.svc.getLeveyJenningsChart(s.ctx, q({ observedAtFrom: f, observedAtTo: t }))).status).toBe(200);
    }
  });
  it('the error carries paths, never the offending input', async () => {
    const s = setup(); const e = await rejection(s.svc.getLeveyJenningsChart(s.ctx, q({ lotId: PLANTED }) as any));
    expect(code(e)).toBe('common.validation_failed'); expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toContain(PLANTED);
  });
  it('lot_id / level_id / plan_id are never interpolated: the repo receives them as given values (no coercion, no trimming)', async () => {
    const s = setup(); await get(s, { lotId: LOT(1) }); const a = s.fake.calls.find((c) => c.op === 'listChartObservations')!.args[0];
    expect(a).toEqual({ planId: PLN(1), levelId: LVL(1), lotId: LOT(1), from: FROM, to: TO, limit: expect.any(Number) });
  });
});

describe('authorisation + tenancy (REQ-SEC-024/098)', () => {
  it('assertRole quality.qc_run.read comes FIRST: no rights -> auth.forbidden, nothing read, even for an invalid query', async () => {
    const s = setup(baseSeed(), { ctx: { roles: noRights } });
    expect(code(await rejection(s.svc.getLeveyJenningsChart(s.ctx, q())))).toBe('auth.forbidden'); expect(code(await rejection(s.svc.getLeveyJenningsChart(s.ctx, q({ planId: 'x' }) as any)))).toBe('auth.forbidden');
    expect(s.fake.calls).toHaveLength(0); expect(s.asserted[0]).toMatchObject({ permission: 'quality.qc_run.read' });
  });
  it('a read-only principal (lab_technologist) may read the chart', async () => {
    const s = setup(baseSeed(), { ctx: { roles: readOnly } }); expect((await s.svc.getLeveyJenningsChart(s.ctx, q())).status).toBe(200); expect(s.asserted.map((a) => a.permission)).toEqual(['quality.qc_run.read']);
  });
  it('every repo call uses ctx.tx and ctx.tenantId; the input cannot carry a tenant (extra keys are ignored and never reach the repo)', async () => {
    const s = setup(); await s.svc.getLeveyJenningsChart(s.ctx, { ...q(), tenantId: TENANT_B, tenant_id: TENANT_B, createdBy: PLANTED } as any);
    for (const c of s.fake.calls) { expect(c.tx).toBe(s.ctx.tx); expect(c.tenantId).toBe(TENANT_A); expect(JSON.stringify(c.args)).not.toMatch(/PLANTED|tenant/i); }
  });
  it("another tenant's plan -> common.not_found (same as a missing plan: no existence leak); no observation, run or target is read", async () => {
    const s = setup(); const e = await rejection(s.svc.getLeveyJenningsChart(s.ctx, q({ planId: PLN(9) })));
    expect(code(e)).toBe('common.not_found'); expect(s.fake.ops()).toEqual(['findPlan']);
    const m = setup(); expect(code(await rejection(m.svc.getLeveyJenningsChart(m.ctx, q({ planId: PLN(77) }))))).toBe('common.not_found');
  });
  it("rows of another tenant never appear, even for a plan id that exists in both tenants (the explicit tenant predicate, not only RLS)", async () => {
    const seed = baseSeed(); seed.plans!.push(plan(1, { tenant_id: TENANT_B })); seed.observations!.push(obs(50, T('11:00:00'), '999.0', '9.0', { tenant_id: TENANT_B }));
    const a = await get(setup(seed)); expect(JSON.stringify(a)).not.toContain(OBS(50));
  });
});

describe('DTO allowlist + failure behaviour (REQ-SEC-081, fail closed)', () => {
  it('exactly the §7.10 keys at every level; no null anywhere; none of the planted internal columns, no tenant_id', async () => {
    const seed = baseSeed(); seed.targets![0] = { ...seed.targets![0]!, created_by: PLANTED, note: PLANTED, activated_by: PLANTED } as any;
    const s = setup(seed); const r = (await s.svc.getLeveyJenningsChart(s.ctx, q())).body;
    expect(Object.keys(r).sort()).toEqual(BODY_KEYS); expect(Object.keys(r.plan).sort()).toEqual(PLAN_KEYS); expect(Object.keys(r.series[0]).sort()).toEqual(SERIES_KEYS);
    for (const p of r.series[0].points) expect(Object.keys(p).every((k) => POINT_KEYS.includes(k)) && ['observation_id', 'observed_at', 'value', 'status', 'rule_hits'].every((k) => k in p)).toBe(true);
    for (const t of r.series[0].targets) expect(Object.keys(t).every((k) => TARGET_KEYS.includes(k)) && ['target_id', 'effective_from', 'mean', 'sd', 'source'].every((k) => k in t)).toBe(true);
    const json = JSON.stringify(r); expect(json).not.toContain(PLANTED); expect(json).not.toMatch(/tenant|null|created_by|internal_note|excluded_comment/);
  });
  it('a repo failure (driver text) -> common.internal without SQL or table names; LimsErrors pass through unchanged', async () => {
    const s = setup(); s.fake.repo.listChartObservations = async () => { throw new Error('relation "quality.qc_observations" does not exist PLANTED'); };
    const e = await rejection(s.svc.getLeveyJenningsChart(s.ctx, q())); expect(code(e)).toBe('common.internal'); expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toMatch(/relation|qc_observations|PLANTED/);
    const t = setup(); t.fake.repo.findPlan = async () => { throw Object.assign(new Error('x'), { code: 'common.dependency_unavailable' }); };
    expect(code(await rejection(t.svc.getLeveyJenningsChart(t.ctx, q())))).toBe('common.dependency_unavailable');
  });
  it('the catalog does not know the plan analyte -> common.internal (the DTO requires analyte_code; never a guessed one)', async () => {
    const s = setup(baseSeed(), { ctx: { catalog: makeChartCatalog({ plans: [plan(1)], missingAnalyte: true }) } });
    expect(code(await rejection(s.svc.getLeveyJenningsChart(s.ctx, q())))).toBe('common.internal');
  });
  it('read-only and bounded: the four repo reads and exactly ONE CatalogPort.getTest (for the plan test), no direct tx query, however many points and series', async () => {
    const seed = baseSeed(); for (let i = 4; i <= 30; i++) seed.observations!.push(obs(i, `2026-10-12T${String(i % 24).padStart(2, '0')}:00:00.000Z`, '1.0', '0.1', i % 2 ? { ...L2 } : {}));
    const s = setup(seed); let n = 0; const orig = s.ctx.ports.CatalogPort.getTest.bind(s.ctx.ports.CatalogPort); s.ctx.ports.CatalogPort.getTest = (...a: unknown[]) => { n++; return (orig as any)(...a); };
    await s.svc.getLeveyJenningsChart(s.ctx, { planId: PLN(1), view: 'z', observedAtFrom: FROM, observedAtTo: TO });
    expect(s.fake.ops()).toEqual(['findPlan', 'listChartObservations', 'listRunsForChart', 'listTargetsForChart']); expect(n).toBe(1); expect(s.queries).toHaveLength(0);
  });
});
