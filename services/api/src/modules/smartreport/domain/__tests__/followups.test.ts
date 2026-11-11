// C14 T07 — domain/followups.ts (02-TRD §4.7; AC-12.1 output shape, AC-12.3 dedupe smallest interval, no follow-up on all-in-range; 07-SECURITY AB-3).
// API pinned by these tests (spec gives no names):
//   selectFollowUps({ entries, tiles, rules, blocks, language, followupMax, tests }) -> { ruleId, suggestedTestCode, suggestedTestName, intervalDays, text }[]
//     entries/tiles/blocks/language as in advice.test.ts.
//     rules = { id, ruleKind, triggerKind, analyteId?, groupCode?, direction, minSeverity?, priority, blockId, suggestedTestId, intervalDays }
//     tests = ReadonlyMap<testId, { code, name }> = tests the caller resolved as ACTIVE (CatalogPort, §4.7);
//             a rule whose suggestedTestId is absent from the map is skipped before dedupe and cap.
//   Dedupe by suggestedTestId (smallest intervalDays, then lowest priority); order: trigger severity desc, intervalDays asc, priority asc; cap.
//   Text placeholders: {test_name}, {interval_days}, {group_name}, {analyte_name}.
import { describe, expect, it } from 'vitest';
import { selectFollowUps } from '../followups.js';

type Sev = 'borderline' | 'out_of_range' | 'critical';
const entry = (o: Record<string, unknown> = {}) =>
  ({ resultId: 'res-1', analyteId: 'A-GLUF', groupCode: 'diabetes', direction: 'high', severity: 'out_of_range' as Sev,
    templateBlockId: 'b-d', text: 'x', analyteName: 'Glucose Fasting', ...o });
const tile = (o: Record<string, unknown> = {}) => ({ groupCode: 'diabetes', groupName: 'Diabetes', status: 'out_of_range', ...o });
const rule = (o: Record<string, unknown>) =>
  ({ ruleKind: 'followup', triggerKind: 'analyte', analyteId: 'A-GLUF', direction: 'high', minSeverity: 'out_of_range',
    priority: 100, blockId: 'fb', suggestedTestId: 'T-HBA1C', intervalDays: 90, ...o });
const block = (id: string, o: Record<string, unknown> = {}) =>
  ({ id, kind: 'followup', blockKey: `followup.${id}`, textEn: `follow ${id}`, textNe: `अनुगमन ${id}`, ...o });
const TESTS = new Map([
  ['T-HBA1C', { code: 'HBA1C', name: 'HbA1c' }],
  ['T-LFT', { code: 'LFT', name: 'Liver Function Test' }],
  ['T-LIPID', { code: 'LIPID', name: 'Lipid Profile' }],
  ['T-TSH', { code: 'TSH', name: 'TSH' }],
]);
const run = (o: Record<string, unknown>) =>
  selectFollowUps({ entries: [entry()], tiles: [tile()], rules: [], blocks: [block('fb')], language: 'en', followupMax: 3, tests: TESTS, ...o } as never);
const codes = (r: unknown) => (r as { suggestedTestCode: string }[]).map((x) => x.suggestedTestCode);

describe('AC-12.1 output shape', () => {
  it('GLUF high >= out_of_range → HBA1C, 90 days', () => {
    expect(run({ rules: [rule({ id: 'r-1' })] })).toEqual([
      { ruleId: 'r-1', suggestedTestCode: 'HBA1C', suggestedTestName: 'HbA1c', intervalDays: 90, text: 'follow fb' }]);
  });
  it('fills {test_name}, {interval_days}, {analyte_name}, {group_name} in the text', () => {
    const r = run({
      rules: [rule({ id: 'r-1', blockId: 'ph' })],
      blocks: [block('ph', { textEn: 'Consider {test_name} in {interval_days} days ({analyte_name}, {group_name})' })],
    });
    expect(r[0]?.text).toBe('Consider HbA1c in 90 days (Glucose Fasting, Diabetes)');
  });
  it('language ne uses textNe', () => {
    expect(run({ rules: [rule({ id: 'r-1' })], language: 'ne' })[0]?.text).toBe('अनुगमन fb');
  });
  it('output carries only the five documented fields (no price / link / phone fields)', () => {
    const o = run({ rules: [rule({ id: 'r-1' })] })[0] as object;
    expect(Object.keys(o).sort()).toEqual(['intervalDays', 'ruleId', 'suggestedTestCode', 'suggestedTestName', 'text']);
  });
  it('interval is taken from the rule — never defaulted', () => {
    expect(run({ rules: [rule({ id: 'r-1', intervalDays: 45 })] })[0]?.intervalDays).toBe(45);
    expect(run({ rules: [rule({ id: 'r-1', intervalDays: 730 })] })[0]?.intervalDays).toBe(730);
  });
});

describe('AC-12.3 dedupe by suggested test', () => {
  it('two rules suggest the same test with 90 and 180 days → one suggestion with 90', () => {
    const r = run({ rules: [rule({ id: 'r-180', intervalDays: 180 }), rule({ id: 'r-90', intervalDays: 90 })] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ ruleId: 'r-90', intervalDays: 90 });
  });
  it('same test and interval → lowest priority wins', () => {
    const r = run({ rules: [rule({ id: 'r-b', priority: 200 }), rule({ id: 'r-a', priority: 50 })] });
    expect(r.map((x: { ruleId: string }) => x.ruleId)).toEqual(['r-a']);
  });
  it('different tests are not merged', () => {
    const r = run({ rules: [rule({ id: 'r1' }), rule({ id: 'r2', suggestedTestId: 'T-LFT' })] });
    expect(codes(r).sort()).toEqual(['HBA1C', 'LFT']);
  });
});

describe('ordering and cap (§4.7)', () => {
  const entries = [
    entry({ resultId: 'a', analyteId: 'A1', severity: 'borderline' }),
    entry({ resultId: 'b', analyteId: 'A2', severity: 'critical' }),
  ];
  const rules = () => [
    rule({ id: 'r1', analyteId: 'A1', minSeverity: 'borderline', suggestedTestId: 'T-LFT', intervalDays: 30 }),
    rule({ id: 'r2', analyteId: 'A2', suggestedTestId: 'T-LIPID', intervalDays: 365 }),
    rule({ id: 'r3', analyteId: 'A1', minSeverity: 'borderline', suggestedTestId: 'T-TSH', intervalDays: 10, priority: 5 }),
    rule({ id: 'r4', analyteId: 'A1', minSeverity: 'borderline', suggestedTestId: 'T-HBA1C', intervalDays: 10, priority: 1 }),
  ];
  it('severity desc, then interval asc, then priority asc', () => {
    expect(codes(run({ entries, rules: rules(), followupMax: 5 }))).toEqual(['LIPID', 'HBA1C', 'TSH', 'LFT']);
  });
  it('cap followup_max applies after ordering', () => {
    expect(codes(run({ entries, rules: rules(), followupMax: 2 }))).toEqual(['LIPID', 'HBA1C']);
    expect(run({ entries, rules: rules(), followupMax: 0 })).toEqual([]);
  });
  it('order is independent of input order', () => {
    expect(codes(run({ entries, rules: rules().reverse(), followupMax: 5 }))).toEqual(['LIPID', 'HBA1C', 'TSH', 'LFT']);
  });
});

describe('no follow-up without a finding (AB-3, AC-05.3)', () => {
  it('no deranged entries → empty, even with any/group rules', () => {
    const r = run({
      entries: [], tiles: [tile({ status: 'in_range' })],
      rules: [rule({ id: 'r1', triggerKind: 'any', direction: 'any', minSeverity: 'borderline' }),
        rule({ id: 'r2', triggerKind: 'group', groupCode: 'diabetes', direction: 'any', minSeverity: 'borderline' })],
    });
    expect(r).toEqual([]);
  });
  it('an all_in_range follow-up rule never fires, with or without findings', () => {
    const air = rule({ id: 'r-air', triggerKind: 'all_in_range', direction: 'any' });
    expect(run({ entries: [], tiles: [], rules: [air] })).toEqual([]);
    expect(run({ rules: [air] })).toEqual([]);
  });
});

describe('trigger matching (§4.6 rules reused)', () => {
  it('only ruleKind followup is considered', () => {
    expect(run({ rules: [rule({ id: 'r', ruleKind: 'advice' })] })).toEqual([]);
    expect(run({ rules: [rule({ id: 'r', ruleKind: 'deranged' })] })).toEqual([]);
  });
  it('analyte trigger: wrong analyte / direction / below min_severity → no match', () => {
    expect(run({ rules: [rule({ id: 'r', analyteId: 'A-OTHER' })] })).toEqual([]);
    expect(run({ rules: [rule({ id: 'r', direction: 'low' })] })).toEqual([]);
    expect(run({ rules: [rule({ id: 'r', minSeverity: 'critical' })] })).toEqual([]);
  });
  it('group trigger: tile status >= min_severity, direction needs matching entry', () => {
    const g = (o: Record<string, unknown>, t: Record<string, unknown> = {}) =>
      run({ rules: [rule({ id: 'r', triggerKind: 'group', analyteId: undefined, groupCode: 'diabetes', ...o })], tiles: [tile(t)] });
    expect(codes(g({}))).toEqual(['HBA1C']);
    expect(g({ minSeverity: 'critical' })).toEqual([]);
    expect(g({ direction: 'low' })).toEqual([]);
    expect(g({ direction: 'any' }, { status: 'borderline' })).toEqual([]); // borderline tile < out_of_range
  });
  it('any trigger matches any satisfying entry', () => {
    expect(codes(run({ rules: [rule({ id: 'r', triggerKind: 'any', analyteId: undefined, direction: 'any' })] }))).toEqual(['HBA1C']);
  });
});

describe('inactive / unknown suggested test (AC-12.2 boundary)', () => {
  it('rule whose test is not in the active-tests map is skipped, others survive', () => {
    const r = run({ rules: [rule({ id: 'r1', suggestedTestId: 'T-GONE', intervalDays: 1 }), rule({ id: 'r2', suggestedTestId: 'T-LFT' })] });
    expect(codes(r)).toEqual(['LFT']);
  });
  it('skipped (inactive) rule does not consume a cap slot or win dedupe', () => {
    const r = run({
      rules: [rule({ id: 'r1', suggestedTestId: 'T-GONE' }), rule({ id: 'r2', suggestedTestId: 'T-LFT' })],
      followupMax: 1,
    });
    expect(codes(r)).toEqual(['LFT']);
  });
});

describe('robustness', () => {
  it('does not mutate its inputs', () => {
    const rules = [rule({ id: 'r2', intervalDays: 180 }), rule({ id: 'r1', intervalDays: 90 })];
    const snap = JSON.stringify(rules);
    run({ rules });
    expect(JSON.stringify(rules)).toBe(snap);
  });
});
