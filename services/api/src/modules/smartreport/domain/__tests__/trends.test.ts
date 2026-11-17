// C14 T08 — domain/trends.ts (02-TRD §4.8; AC-13.2 direction, AC-13.3 stable threshold, AC-13.4 unit mismatch, AC-13.5 history unavailable).
// API pinned by these tests (spec gives no names):
//   buildTrends({ candidates, history, trendMaxPoints, trendStableBp, trendsMax }) -> Trend[]
//     candidates = { resultId, analyteId, analyteName, unitCode, valueNumeric, approvedAt, trendEnabled,
//                    referenceRangeSnapshot: { low?, high? }, derangedSeverity?, groupSortOrder, analyteSortOrder }
//       derangedSeverity set = analyte has a deranged entry (§4.5 order: severity desc, group sort, analyte sort, resultId).
//       A candidate is skipped when trendEnabled is false, valueNumeric is missing, or the snapshot has neither low nor high.
//     history = LabPort.getAnalyteHistory result ({ series: [{ analyteId, points }] }) or undefined when the method is
//       missing / threw (caller increments the metric) -> []. Point order from the port is not trusted: domain sorts newest first.
//     Trend = { analyteId, analyteName, unitCode, direction, pointResultIds, points: [{ resultId, approvedAt, valueNumeric }] }, oldest -> newest.
//   Pure: no mutation of inputs, deterministic.
import { describe, expect, it } from 'vitest';
import { buildTrends } from '../trends.js';

type Pt = Record<string, unknown>;
const cand = (o: Record<string, unknown> = {}) =>
  ({ resultId: 'r-cur', analyteId: 'A-GLUF', analyteName: 'Glucose Fasting', unitCode: 'mg/dL', valueNumeric: '95',
    approvedAt: '2026-06-01T00:00:00Z', trendEnabled: true, referenceRangeSnapshot: { low: '70', high: '100' },
    groupSortOrder: 10, analyteSortOrder: 10, ...o });
const pt = (resultId: string, valueNumeric: string | undefined, approvedAt: string, o: Pt = {}) =>
  ({ source: 'lis', resultId, approvedAt, valueNumeric, unitCode: 'mg/dL', ...o });
const series = (analyteId: string, points: Pt[]) => ({ analyteId, points });
const run = (o: Record<string, unknown>) =>
  buildTrends({ candidates: [cand()], history: { series: [] }, trendMaxPoints: 4, trendStableBp: 1000, trendsMax: 6, ...o } as never) as unknown as
    { analyteId: string; analyteName: string; unitCode: string; direction: string; pointResultIds: string[];
      points: { resultId: string; approvedAt: string; valueNumeric: string }[] }[];
const one = (c: Record<string, unknown>, prev: string, o: Record<string, unknown> = {}) =>
  run({ candidates: [cand(c)], history: { series: [series('A-GLUF', [pt('r-prev', prev, '2026-01-01T00:00:00Z')])] }, ...o });
const dir = (c: Record<string, unknown>, prev: string, o: Record<string, unknown> = {}) => one(c, prev, o)[0]?.direction;

describe('T-vectors: direction (AC-13.2, AC-13.3)', () => {
  it('T-01 improved: previous above range, current inside', () => expect(dir({ valueNumeric: '95' }, '130')).toBe('improved'));
  it('T-02 worsened: previous inside, current above range', () => expect(dir({ valueNumeric: '130' }, '95')).toBe('worsened'));
  it('T-02b worsened: previous inside, current below range', () => expect(dir({ valueNumeric: '50' }, '80')).toBe('worsened'));
  it('T-03 stable by threshold: both out of range, |c-p| within trend_stable_bp of |p|', () =>
    expect(dir({ valueNumeric: '115' }, '110')).toBe('stable')); // 5*10000 <= 110*1000 although farther from range
  it('T-03b threshold boundary is inclusive (<=)', () => expect(dir({ valueNumeric: '121' }, '110')).toBe('stable')); // 11*10000 = 110*1000
  it('T-03c one step past the boundary is not stable by threshold', () => expect(dir({ valueNumeric: '121.1' }, '110')).toBe('worsened'));
  it('T-03d trend_stable_bp = 0: any change skips the threshold, distance decides', () => {
    expect(dir({ valueNumeric: '131' }, '130', { trendStableBp: 0 })).toBe('worsened'); // d 31 > 30
    expect(dir({ valueNumeric: '130' }, '130', { trendStableBp: 0 })).toBe('stable'); // equal
  });
  it('per-analyte candidate trendStableBp overrides the library param (05-SCHEMA §2.4 analyte_groups.trend_stable_bp)', () => {
    expect(dir({ valueNumeric: '115' }, '110')).toBe('stable'); // library 1000 alone
    expect(dir({ valueNumeric: '115', trendStableBp: 0 }, '110')).toBe('worsened'); // override 0 wins: d 15 > 10
  });
  it('T-04 stable: both inside range, change beyond threshold', () => expect(dir({ valueNumeric: '95' }, '80')).toBe('stable'));
  it('T-05 p = 0, c = 0 -> stable', () => expect(dir({ valueNumeric: '0', referenceRangeSnapshot: { low: '0', high: '10' } }, '0')).toBe('stable'));
  it('T-05b p = 0, c != 0 is never stable-by-threshold; distance decides', () =>
    expect(dir({ valueNumeric: '5', referenceRangeSnapshot: { low: '1', high: '10' } }, '0')).toBe('improved'));
  it('both out of range, current closer to range, change beyond threshold -> improved', () => expect(dir({ valueNumeric: '110' }, '150')).toBe('improved'));
  it('both out of range on opposite sides: smaller distance wins', () => {
    expect(dir({ valueNumeric: '65' }, '140')).toBe('improved'); // d 5 < 40
    expect(dir({ valueNumeric: '140' }, '65')).toBe('worsened');
  });
  it('equal distance beyond threshold -> stable', () => expect(dir({ valueNumeric: '60' }, '110')).toBe('stable')); // d 10 vs 10
  it('uses the CURRENT result range for both points (one ruler)', () =>
    expect(dir({ valueNumeric: '8', referenceRangeSnapshot: { low: '4', high: '10' } }, '12')).toBe('improved'));
  it('high-only range: missing low is unbounded', () => {
    expect(dir({ valueNumeric: '4', referenceRangeSnapshot: { high: '5' } }, '9')).toBe('improved');
    expect(dir({ valueNumeric: '-100', referenceRangeSnapshot: { high: '5' } }, '4')).toBe('stable'); // both inside
  });
  it('low-only range: missing high is unbounded', () => expect(dir({ valueNumeric: '9', referenceRangeSnapshot: { low: '5' } }, '3')).toBe('improved'));
  it('compares against the PREVIOUS (newest earlier) point, not the oldest', () => {
    const t = run({ history: { series: [series('A-GLUF', [pt('r-old', '95', '2025-01-01T00:00:00Z'), pt('r-prev', '130', '2026-01-01T00:00:00Z')])] } });
    expect(t[0]!.direction).toBe('improved'); // vs 130, not vs 95
  });
  it('decimal arithmetic is exact (no float drift)', () => {
    expect(dir({ valueNumeric: '0.3', referenceRangeSnapshot: { low: '0.1', high: '0.3' } }, '0.1')).toBe('stable'); // both inside
    expect(dir({ valueNumeric: '0.30001', referenceRangeSnapshot: { low: '0.1', high: '0.3' } }, '0.2')).toBe('worsened');
  });
});

describe('T-06 + AC-13.4: unit mismatch / point filtering', () => {
  it('T-06 only earlier point has another unit -> excluded, so no trend', () =>
    expect(run({ history: { series: [series('A-GLUF', [pt('r-prev', '5.3', '2026-01-01T00:00:00Z', { unitCode: 'mmol/L' })])] } })).toEqual([]));
  it('mixed units: mismatching point is dropped from points and pointResultIds', () => {
    const t = run({ history: { series: [series('A-GLUF', [
      pt('r-b', '5.3', '2026-02-01T00:00:00Z', { unitCode: 'mmol/L' }), pt('r-a', '130', '2026-01-01T00:00:00Z')])] } });
    expect(t[0]!.pointResultIds).toEqual(['r-a', 'r-cur']);
    expect(t[0]!.unitCode).toBe('mg/dL');
  });
  it('unit compare is exact (case-sensitive)', () =>
    expect(run({ history: { series: [series('A-GLUF', [pt('r-prev', '130', '2026-01-01T00:00:00Z', { unitCode: 'MG/DL' })])] } })).toEqual([]));
  it('point with a missing unit is excluded', () =>
    expect(run({ history: { series: [series('A-GLUF', [pt('r-prev', '130', '2026-01-01T00:00:00Z', { unitCode: undefined })])] } })).toEqual([]));
  it("source != 'lis' (legacy) is excluded", () =>
    expect(run({ history: { series: [series('A-GLUF', [pt('r-prev', '130', '2026-01-01T00:00:00Z', { source: 'legacy' })])] } })).toEqual([]));
  it('point without valueNumeric is excluded', () =>
    expect(run({ history: { series: [series('A-GLUF', [pt('r-prev', undefined, '2026-01-01T00:00:00Z')])] } })).toEqual([]));
  it('fewer than 2 points -> no trend', () => expect(run({ history: { series: [series('A-GLUF', [])] } })).toEqual([]));
});

describe('AC-13.5: history unavailable', () => {
  it('history undefined (method missing or threw) -> []', () => expect(run({ history: undefined })).toEqual([]));
  it('empty series -> []', () => expect(run({ history: { series: [] } })).toEqual([]));
  it('series for another analyte only -> []', () =>
    expect(run({ history: { series: [series('A-OTHER', [pt('r-prev', '130', '2026-01-01T00:00:00Z')])] } })).toEqual([]));
  it('no candidates -> []', () => expect(run({ candidates: [] })).toEqual([]));
});

describe('points, output shape, caps (AC-13.1 shape, §4.8 step 3, 6)', () => {
  const hist5 = ['e', 'd', 'c', 'b', 'a'].map((k, i) => pt(`r-${k}`, String(100 + i), `2026-0${5 - i}-01T00:00:00Z`)); // newest first: e(May) .. a(Jan)
  it('output shape; points oldest -> newest and current last', () => {
    const t = run({ history: { series: [series('A-GLUF', [pt('r-2', '130', '2026-02-01T00:00:00Z'), pt('r-1', '120', '2026-01-01T00:00:00Z')])] } });
    expect(t).toEqual([{ analyteId: 'A-GLUF', analyteName: 'Glucose Fasting', unitCode: 'mg/dL', direction: 'improved',
      pointResultIds: ['r-1', 'r-2', 'r-cur'],
      points: [{ resultId: 'r-1', approvedAt: '2026-01-01T00:00:00Z', valueNumeric: '120' },
        { resultId: 'r-2', approvedAt: '2026-02-01T00:00:00Z', valueNumeric: '130' },
        { resultId: 'r-cur', approvedAt: '2026-06-01T00:00:00Z', valueNumeric: '95' }] }]);
  });
  it('unordered port input is sorted by approvedAt', () => {
    const t = run({ history: { series: [series('A-GLUF', [pt('r-1', '120', '2026-01-01T00:00:00Z'), pt('r-3', '110', '2026-03-01T00:00:00Z'), pt('r-2', '130', '2026-02-01T00:00:00Z')])] } });
    expect(t[0]!.pointResultIds).toEqual(['r-1', 'r-2', 'r-3', 'r-cur']);
  });
  it('keeps the newest trend_max_points - 1 history points (+ current)', () => {
    expect(run({ history: { series: [series('A-GLUF', hist5)] }, trendMaxPoints: 4 })[0]!.pointResultIds).toEqual(['r-c', 'r-d', 'r-e', 'r-cur']);
    expect(run({ history: { series: [series('A-GLUF', hist5)] }, trendMaxPoints: 2 })[0]!.pointResultIds).toEqual(['r-e', 'r-cur']);
  });
  it('filtering happens before the point cap (mismatching unit does not consume a slot)', () => {
    const t = run({ trendMaxPoints: 3, history: { series: [series('A-GLUF', [
      pt('r-x', '5', '2026-05-01T00:00:00Z', { unitCode: 'mmol/L' }), pt('r-b', '101', '2026-04-01T00:00:00Z'), pt('r-a', '102', '2026-03-01T00:00:00Z')])] } });
    expect(t[0]!.pointResultIds).toEqual(['r-a', 'r-b', 'r-cur']);
  });
  it('trends_max caps the number of trends', () => {
    const cs = ['A', 'B', 'C'].map((k, i) => cand({ resultId: `r-${k}`, analyteId: `A-${k}`, analyteSortOrder: i }));
    const h = { series: cs.map((c) => series(c.analyteId, [pt(`p-${c.analyteId}`, '130', '2026-01-01T00:00:00Z')])) };
    expect(run({ candidates: cs, history: h, trendsMax: 2 }).map((t) => t.analyteId)).toEqual(['A-A', 'A-B']);
    expect(run({ candidates: cs, history: h, trendsMax: 0 })).toEqual([]);
  });
});

describe('candidates and ordering (§4.8 steps 1, 5)', () => {
  const hist = (...ids: string[]) => ({ series: ids.map((id) => series(id, [pt(`p-${id}`, '130', '2026-01-01T00:00:00Z')])) });
  it('trendEnabled = false -> skipped', () => expect(run({ candidates: [cand({ trendEnabled: false })], history: hist('A-GLUF') })).toEqual([]));
  it('missing valueNumeric -> skipped', () => expect(run({ candidates: [cand({ valueNumeric: undefined })], history: hist('A-GLUF') })).toEqual([]));
  it('range snapshot with neither low nor high -> skipped', () =>
    expect(run({ candidates: [cand({ referenceRangeSnapshot: {} })], history: hist('A-GLUF') })).toEqual([]));
  it('deranged analytes first (severity desc, group sort, analyte sort), then catalog sortOrder', () => {
    const cs = [
      cand({ resultId: 'r-1', analyteId: 'A-1', analyteSortOrder: 1 }),
      cand({ resultId: 'r-2', analyteId: 'A-2', analyteSortOrder: 2, derangedSeverity: 'out_of_range', groupSortOrder: 5 }),
      cand({ resultId: 'r-3', analyteId: 'A-3', analyteSortOrder: 3, derangedSeverity: 'critical', groupSortOrder: 9 }),
      cand({ resultId: 'r-4', analyteId: 'A-4', analyteSortOrder: 0, derangedSeverity: 'out_of_range', groupSortOrder: 5 }),
    ];
    expect(run({ candidates: cs, history: hist('A-1', 'A-2', 'A-3', 'A-4') }).map((t) => t.analyteId)).toEqual(['A-3', 'A-4', 'A-2', 'A-1']);
  });
  it('cap applies after ordering (deranged analyte survives the cap)', () => {
    const cs = [cand({ resultId: 'r-1', analyteId: 'A-1', analyteSortOrder: 1 }), cand({ resultId: 'r-9', analyteId: 'A-9', analyteSortOrder: 9, derangedSeverity: 'borderline' })];
    expect(run({ candidates: cs, history: hist('A-1', 'A-9'), trendsMax: 1 }).map((t) => t.analyteId)).toEqual(['A-9']);
  });
  it('input order does not change the result (deterministic)', () => {
    const cs = ['A', 'B', 'C'].map((k, i) => cand({ resultId: `r-${k}`, analyteId: `A-${k}`, analyteSortOrder: i }));
    const h = hist('A-A', 'A-B', 'A-C');
    expect(run({ candidates: [...cs].reverse(), history: h })).toEqual(run({ candidates: cs, history: h }));
  });
  it('does not mutate its inputs', () => {
    const history = { series: [series('A-GLUF', [pt('r-2', '130', '2026-02-01T00:00:00Z'), pt('r-1', '120', '2026-01-01T00:00:00Z')])] };
    const candidates = [cand()];
    const before = JSON.stringify({ history, candidates });
    run({ history, candidates });
    expect(JSON.stringify({ history, candidates })).toBe(before);
  });
});
