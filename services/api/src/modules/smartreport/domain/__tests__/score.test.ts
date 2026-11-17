// C14 T05 — domain/score.ts, formula hs-1 (02-TRD §4.4, golden vectors G-01..G-06 in §9.6; AC-09.1..AC-09.4, AC-04.4).
// API pinned by these tests (spec gives no names):
//   computeHealthScore({ members, groups, params }) -> { value, band, formulaVersion: 'hs-1', panelsScored } | undefined
//     member = { groupCode, status: 'in_range'|'borderline'|'out_of_range'|'critical', includeInScore }
//     group  = { groupCode, scoreWeight, isShown }
//     params = { scoreEnabled, creditInRangeBp, creditBorderlineBp, creditOutOfRangeBp, creditCriticalBp,
//                minGroupsScored, bandGoodMin, bandFairMin, criticalForcesNeedsAttention }
//   undefined = healthScore omitted (never 0, never 100).
import { describe, expect, it } from 'vitest';
import { computeHealthScore } from '../score.js';

type St = 'in_range' | 'borderline' | 'out_of_range' | 'critical';
const DEFAULTS = {
  scoreEnabled: true, creditInRangeBp: 10000, creditBorderlineBp: 5000, creditOutOfRangeBp: 0, creditCriticalBp: 0,
  minGroupsScored: 2, bandGoodMin: 80, bandFairMin: 60, criticalForcesNeedsAttention: true,
};
const m = (groupCode: string, status: St, includeInScore = true) => ({ groupCode, status, includeInScore });
const g = (groupCode: string, scoreWeight = 1, isShown = true) => ({ groupCode, scoreWeight, isShown });
const run = (members: unknown[], groups: unknown[], params: Record<string, unknown> = {}) =>
  computeHealthScore({ members, groups, params: { ...DEFAULTS, ...params } } as never) as
    | { value: number; band: string; formulaVersion: string; panelsScored: number }
    | undefined;

const G01_MEMBERS = [
  m('blood_counts', 'in_range'), m('blood_counts', 'in_range'), m('blood_counts', 'out_of_range'),
  m('liver', 'in_range'), m('liver', 'borderline'),
  m('kidney', 'in_range'),
];
const G01_GROUPS = [g('blood_counts'), g('liver'), g('kidney')];

describe('golden vectors (02-TRD §9.6)', () => {
  it('G-01 / AC-09.1: subs 6667/7500/10000 -> 81, good, hs-1, 3 panels', () => {
    expect(run(G01_MEMBERS, G01_GROUPS)).toEqual({ value: 81, band: 'good', formulaVersion: 'hs-1', panelsScored: 3 });
  });

  it('G-02: kidney (in, critical) -> sub 5000, value 64, needs_attention (critical forces)', () => {
    const members = [...G01_MEMBERS.slice(0, 5), m('kidney', 'in_range'), m('kidney', 'critical')];
    expect(run(members, G01_GROUPS)).toEqual({ value: 64, band: 'needs_attention', formulaVersion: 'hs-1', panelsScored: 3 });
  });

  it('G-03 / AC-09.3: one group measured (1 < 2) -> omitted, not 0, not 100', () => {
    const r = run([m('liver', 'in_range'), m('liver', 'in_range')], [g('liver')]);
    expect(r).toBeUndefined();
  });

  it('G-04: all out of range -> 0, needs_attention', () => {
    const r = run(
      [m('blood_counts', 'out_of_range'), m('blood_counts', 'out_of_range'), m('glucose', 'out_of_range')],
      [g('blood_counts'), g('glucose')],
    );
    expect(r).toEqual({ value: 0, band: 'needs_attention', formulaVersion: 'hs-1', panelsScored: 2 });
  });

  it('G-05: weights 2 and 1 -> (2*10000+0)/300 = 66.67 -> 67, fair', () => {
    const r = run(
      [m('blood_counts', 'in_range'), m('blood_counts', 'in_range'), m('blood_counts', 'in_range'), m('liver', 'out_of_range')],
      [g('blood_counts', 2), g('liver', 1)],
    );
    expect(r).toEqual({ value: 67, band: 'fair', formulaVersion: 'hs-1', panelsScored: 2 });
  });

  it('G-06: half-up boundary, subs 8050 and 8049 -> 80.495 -> 80, good', () => {
    const r = run(
      [m('a', 'borderline'), m('b', 'out_of_range')],
      [g('a'), g('b')],
      { creditBorderlineBp: 8050, creditOutOfRangeBp: 8049 },
    );
    expect(r).toEqual({ value: 80, band: 'good', formulaVersion: 'hs-1', panelsScored: 2 });
  });
});

describe('AC-09.2 critical forces needs_attention', () => {
  const critMembers = [
    m('a', 'in_range'), m('a', 'in_range'), m('a', 'in_range'), m('a', 'in_range'), m('a', 'in_range'), m('a', 'in_range'),
    m('a', 'in_range'), m('a', 'in_range'), m('a', 'in_range'), m('a', 'critical'),
    m('b', 'in_range'),
  ];
  const groups = [g('a'), g('b')];

  it('high value but a critical scored member -> needs_attention regardless of value', () => {
    const r = run(critMembers, groups);
    expect(r?.value).toBe(95); // a = 9000, b = 10000
    expect(r?.band).toBe('needs_attention');
  });

  it('critical_forces_needs_attention=false -> band comes from value', () => {
    const r = run(critMembers, groups, { criticalForcesNeedsAttention: false });
    expect(r).toEqual({ value: 95, band: 'good', formulaVersion: 'hs-1', panelsScored: 2 });
  });

  it('a critical member that is NOT scored (include_in_score=false) does not force the band', () => {
    const r = run([m('a', 'in_range'), m('a', 'critical', false), m('b', 'in_range')], groups);
    expect(r).toEqual({ value: 100, band: 'good', formulaVersion: 'hs-1', panelsScored: 2 });
  });

  it('a critical member in a hidden group does not force the band', () => {
    const r = run([m('a', 'in_range'), m('b', 'in_range'), m('iron', 'critical')], [g('a'), g('b'), g('iron', 1, false)]);
    expect(r?.band).toBe('good');
  });
});

describe('AC-09.4 score_enabled=false', () => {
  it('omits healthScore even with plenty of data', () => {
    expect(run(G01_MEMBERS, G01_GROUPS, { scoreEnabled: false })).toBeUndefined();
  });
});

describe('§4.4 step 1 — which members/groups are scored', () => {
  it('AC-04.4: hidden group (is_shown=false) is not scored and does not count as a panel', () => {
    const members = [...G01_MEMBERS, m('iron', 'critical'), m('iron', 'out_of_range')];
    const r = run(members, [...G01_GROUPS, g('iron', 1, false)]);
    expect(r).toEqual({ value: 81, band: 'good', formulaVersion: 'hs-1', panelsScored: 3 });
  });

  it('score_weight=0 group is not scored', () => {
    const r = run([...G01_MEMBERS, m('iron', 'out_of_range')], [...G01_GROUPS, g('iron', 0)]);
    expect(r).toEqual({ value: 81, band: 'good', formulaVersion: 'hs-1', panelsScored: 3 });
  });

  it('include_in_score=false member is excluded from the group average', () => {
    const r = run(
      [m('a', 'in_range'), m('a', 'out_of_range', false), m('b', 'in_range')],
      [g('a'), g('b')],
    );
    expect(r).toEqual({ value: 100, band: 'good', formulaVersion: 'hs-1', panelsScored: 2 });
  });

  it('group whose members are all include_in_score=false is not scored (n_g = 0) and does not count toward panelsScored', () => {
    const r = run([m('a', 'in_range'), m('b', 'out_of_range', false)], [g('a'), g('b')]);
    expect(r).toBeUndefined(); // only 1 scored group < 2
  });

  it('members of a group with no settings row are not scored', () => {
    const r = run([...G01_MEMBERS, m('mystery', 'out_of_range')], G01_GROUPS);
    expect(r).toEqual({ value: 81, band: 'good', formulaVersion: 'hs-1', panelsScored: 3 });
  });
});

describe('§4.4 parameters', () => {
  it('min_groups_scored=1 lets a single group produce a score', () => {
    const r = run([m('liver', 'in_range'), m('liver', 'borderline')], [g('liver')], { minGroupsScored: 1 });
    expect(r).toEqual({ value: 75, band: 'fair', formulaVersion: 'hs-1', panelsScored: 1 });
  });

  it('min_groups_scored=3 omits a 2-group score', () => {
    expect(run([m('a', 'in_range'), m('b', 'in_range')], [g('a'), g('b')], { minGroupsScored: 3 })).toBeUndefined();
  });

  it('credits come from params (critical credit > 0 is honoured)', () => {
    const r = run([m('a', 'critical'), m('b', 'critical')], [g('a'), g('b')], { creditCriticalBp: 2500, criticalForcesNeedsAttention: false });
    expect(r?.value).toBe(25);
  });

  it('band thresholds are inclusive: value == band_good_min -> good; == band_fair_min -> fair; below -> needs_attention', () => {
    const two = (s1: St, s2: St, p: Record<string, unknown>) => run([m('a', s1), m('b', s2)], [g('a'), g('b')], p);
    // a=10000, b=5000 -> 75
    expect(two('in_range', 'borderline', { bandGoodMin: 75 })?.band).toBe('good');
    expect(two('in_range', 'borderline', { bandGoodMin: 76, bandFairMin: 75 })?.band).toBe('fair');
    expect(two('in_range', 'borderline', { bandGoodMin: 90, bandFairMin: 76 })?.band).toBe('needs_attention');
  });

  it('weights are applied to subscores (heavier group dominates)', () => {
    const r = run([m('a', 'in_range'), m('b', 'out_of_range')], [g('a', 10), g('b', 1)]);
    expect(r?.value).toBe(91); // 100000/1100 = 90.9
  });
});

describe('purity / robustness', () => {
  it('is independent of member and group order', () => {
    const a = run(G01_MEMBERS, G01_GROUPS);
    const b = run([...G01_MEMBERS].reverse(), [...G01_GROUPS].reverse());
    expect(b).toEqual(a);
  });

  it('does not mutate its inputs', () => {
    const members = JSON.parse(JSON.stringify(G01_MEMBERS));
    const groups = JSON.parse(JSON.stringify(G01_GROUPS));
    const params = { ...DEFAULTS };
    computeHealthScore({ members, groups, params } as never);
    expect(members).toEqual(G01_MEMBERS);
    expect(groups).toEqual(G01_GROUPS);
    expect(params).toEqual(DEFAULTS);
  });

  it('no members at all -> omitted', () => {
    expect(run([], G01_GROUPS)).toBeUndefined();
  });

  it('value is always an integer in 0..100', () => {
    const r = run(G01_MEMBERS, G01_GROUPS);
    expect(Number.isInteger(r?.value)).toBe(true);
    expect(r!.value).toBeGreaterThanOrEqual(0);
    expect(r!.value).toBeLessThanOrEqual(100);
  });
});
