// C14 T09 — domain/engine.ts (02-TRD §3 "buildContent(inputs, library) → SummaryContent", §4.10 determinism; AC-08.2).
// done_when: same inputs give byte-identical JSON (property test with shuffled input order).
// API pinned by these tests (spec gives no argument names beyond `buildContent(inputs, library)`):
//   canonicalJson(value) -> string          keys sorted recursively (code-unit order), no whitespace, array order kept,
//                                           undefined-valued keys omitted, non-finite numbers throw.
//   contentSha256(content) -> string        lower-case hex SHA-256 of canonicalJson(content) (UTF-8).
//   buildContent(inputs, library) -> content  pure: no IO, no clock, no mutation; every array in inputs/library is an
//                                           id-keyed SET (engine canonicalises order itself).
//     inputs  = { builtAt, results: [{ resultId, analyteId, flag?, valueNumeric?, valueText?, unitCode?, approvedAt,
//                                      referenceRangeSnapshot? }],
//                 analytes: [{ analyteId, name, printName?, sortOrder, resultType }],
//                 history?: { series: [{ analyteId, points: [{ source, resultId, approvedAt, valueNumeric?, unitCode? }] }] },
//                 tests: [{ testId, code, name }]   // follow-up tests already resolved ACTIVE
//               }
//     library = { language, disclaimerBlockId, params: { scoreEnabled, creditInRangeBp, creditBorderlineBp, creditOutOfRangeBp,
//                   creditCriticalBp, minGroupsScored, bandGoodMin, bandFairMin, criticalForcesNeedsAttention,
//                   adviceMaxBlocks, followupMax, trendMaxPoints, trendStableBp, trendsMax, borderlineFractionBp },
//                 blocks: [{ id, kind, blockKey, textEn?, textNe? }], rules: [DerangedRule | FollowUpRule],
//                 mappings: [{ analyteId, groupCode, includeInScore, trendEnabled }],
//                 groups: [{ groupCode, displayEn, displayNe?, sortOrder, isShown, scoreWeight }] }
//     content = { language, builtAt, healthScore?, panels, deranged, advice, followUps, trends, disclaimerBlockId, disclaimerText }
//       (SmartSummary body of 03-IC §4.10 without summaryId/orderId/reportVersionNo/status/templateLibraryVersion).
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildContent, canonicalJson, contentSha256 } from '../engine.js';

// ---------- fixture (synthetic) ----------
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const rng = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

const snap = (low: string, high: string) => ({ low, high });
const res = (resultId: string, analyteId: string, flag: string, valueNumeric: string, range: { low: string; high: string },
  o: Record<string, unknown> = {}) =>
  ({ resultId, analyteId, flag, valueNumeric, unitCode: 'u', approvedAt: '2026-06-01T10:00:00Z', referenceRangeSnapshot: range, ...o });

const baseInputs = () => ({
  builtAt: '2026-06-02T00:00:00Z',
  registrationNo: 'REG-SECRET-0001', // must never reach content (TRD §4.1)
  results: [
    res('r-glu', 'a-glu', 'H', '130', snap('70', '100')),
    res('r-cre', 'a-cre', 'N', '0.9', snap('0.6', '1.3')),
    res('r-alt', 'a-alt', 'HH', '400', snap('7', '56')),
    res('r-chol', 'a-chol', 'N', '190', snap('0', '200')),
    res('r-hb', 'a-hb', 'L', '9', snap('12', '16')),
    // duplicate analyte, same approvedAt: greatest resultId must win (TRD §4.1) whatever the input order
    res('r-cre-1', 'a-cre', 'H', '1.9', snap('0.6', '1.3'), { approvedAt: '2026-06-01T11:00:00Z' }),
    res('r-cre-2', 'a-cre', 'N', '1.0', snap('0.6', '1.3'), { approvedAt: '2026-06-01T11:00:00Z' }),
    // not mapped -> never eligible
    res('r-unmapped', 'a-zzz', 'H', '5', snap('1', '2')),
  ],
  analytes: [
    { analyteId: 'a-glu', name: 'Glucose Fasting', printName: 'Fasting Glucose', sortOrder: 10, resultType: 'numeric' },
    { analyteId: 'a-cre', name: 'Creatinine', sortOrder: 20, resultType: 'numeric' },
    { analyteId: 'a-alt', name: 'ALT', sortOrder: 30, resultType: 'numeric' },
    { analyteId: 'a-chol', name: 'Cholesterol', sortOrder: 40, resultType: 'numeric' },
    { analyteId: 'a-hb', name: 'Haemoglobin', sortOrder: 50, resultType: 'numeric' },
    { analyteId: 'a-zzz', name: 'Unmapped', sortOrder: 60, resultType: 'numeric' },
  ],
  history: {
    series: [{ analyteId: 'a-glu', points: [
      { source: 'lis', resultId: 'h-2', approvedAt: '2026-03-01T00:00:00Z', valueNumeric: '120', unitCode: 'u' },
      { source: 'lis', resultId: 'h-1', approvedAt: '2026-01-01T00:00:00Z', valueNumeric: '150', unitCode: 'u' },
      { source: 'lis', resultId: 'h-3', approvedAt: '2026-04-01T00:00:00Z', valueNumeric: '160', unitCode: 'u' },
    ] }],
  },
  tests: [
    { testId: 't-hba1c', code: 'HBA1C', name: 'HbA1c' },
    { testId: 't-lft', code: 'LFT', name: 'Liver Function' },
  ],
});

const baseLibrary = () => ({
  language: 'en' as 'en' | 'ne',
  disclaimerBlockId: 'b-disc',
  params: {
    scoreEnabled: true, creditInRangeBp: 10000, creditBorderlineBp: 5000, creditOutOfRangeBp: 0, creditCriticalBp: 0,
    minGroupsScored: 2, bandGoodMin: 80, bandFairMin: 60, criticalForcesNeedsAttention: true,
    adviceMaxBlocks: 5, followupMax: 3, trendMaxPoints: 4, trendStableBp: 1000, trendsMax: 6, borderlineFractionBp: 0,
  },
  blocks: [
    { id: 'b-dlow', kind: 'deranged', blockKey: 'd_low', textEn: '{analyte_name} is low: {value} {unit}.', textNe: 'NE {analyte_name} {value}' },
    { id: 'b-dhigh', kind: 'deranged', blockKey: 'd_high', textEn: '{analyte_name} is high: {value} {unit} (range {ref_range}).', textNe: 'NE {analyte_name} {value}' },
    { id: 'b-dabn', kind: 'deranged', blockKey: 'd_abn', textEn: '{analyte_name} is abnormal.', textNe: 'NE {analyte_name}' },
    { id: 'b-adv-glu', kind: 'advice', blockKey: 'adv_glu', textEn: 'Review {group_name} with your doctor.', textNe: 'NE {group_name}' },
    { id: 'b-adv-a', kind: 'advice', blockKey: 'adv_a', textEn: 'Advice A.', textNe: 'NE A' },
    { id: 'b-adv-b', kind: 'advice', blockKey: 'adv_b', textEn: 'Advice B.', textNe: 'NE B' },
    { id: 'b-fu-a', kind: 'followup', blockKey: 'fu_a', textEn: 'Repeat {test_name} in {interval_days} days.', textNe: 'NE {test_name}' },
    { id: 'b-fu-b', kind: 'followup', blockKey: 'fu_b', textEn: 'Repeat {test_name} in {interval_days} days.', textNe: 'NE {test_name}' },
    { id: 'b-disc', kind: 'disclaimer', blockKey: 'disc', textEn: 'Not a diagnosis.', textNe: 'NE disclaimer' },
  ],
  rules: [
    { id: 'ru-d-low', ruleKind: 'deranged', triggerKind: 'any', direction: 'low', priority: 100, blockId: 'b-dlow' },
    { id: 'ru-d-high', ruleKind: 'deranged', triggerKind: 'any', direction: 'high', priority: 100, blockId: 'b-dhigh' },
    { id: 'ru-d-abn', ruleKind: 'deranged', triggerKind: 'any', direction: 'abnormal', priority: 100, blockId: 'b-dabn' },
    { id: 'ru-adv-glu', ruleKind: 'advice', triggerKind: 'group', groupCode: 'g-met', direction: 'any', minSeverity: 'borderline', priority: 10, blockId: 'b-adv-glu' },
    // two same-priority, same-severity advice rules: order falls to block_key, not input order
    { id: 'ru-adv-b', ruleKind: 'advice', triggerKind: 'any', direction: 'any', minSeverity: 'borderline', priority: 50, blockId: 'b-adv-b' },
    { id: 'ru-adv-a', ruleKind: 'advice', triggerKind: 'any', direction: 'any', minSeverity: 'borderline', priority: 50, blockId: 'b-adv-a' },
    // follow-up: same suggested test twice -> smallest interval wins (AC-12.3)
    { id: 'ru-fu-90', ruleKind: 'followup', triggerKind: 'analyte', analyteId: 'a-glu', direction: 'any', minSeverity: 'borderline', priority: 10,
      blockId: 'b-fu-a', suggestedTestId: 't-hba1c', intervalDays: 90 },
    { id: 'ru-fu-30', ruleKind: 'followup', triggerKind: 'analyte', analyteId: 'a-glu', direction: 'any', minSeverity: 'borderline', priority: 20,
      blockId: 'b-fu-b', suggestedTestId: 't-hba1c', intervalDays: 30 },
    { id: 'ru-fu-lft', ruleKind: 'followup', triggerKind: 'group', groupCode: 'g-liv', direction: 'high', minSeverity: 'out_of_range', priority: 10,
      blockId: 'b-fu-a', suggestedTestId: 't-lft', intervalDays: 14 },
  ],
  mappings: [
    { analyteId: 'a-glu', groupCode: 'g-met', includeInScore: true, trendEnabled: true },
    { analyteId: 'a-cre', groupCode: 'g-kid', includeInScore: true, trendEnabled: true },
    { analyteId: 'a-alt', groupCode: 'g-liv', includeInScore: true, trendEnabled: true },
    { analyteId: 'a-chol', groupCode: 'g-lip', includeInScore: true, trendEnabled: false },
    { analyteId: 'a-hb', groupCode: 'g-bld', includeInScore: true, trendEnabled: true },
  ],
  groups: [
    { groupCode: 'g-met', displayEn: 'Metabolic', displayNe: 'NE Metabolic', sortOrder: 1, isShown: true, scoreWeight: 1 },
    { groupCode: 'g-kid', displayEn: 'Kidney', displayNe: 'NE Kidney', sortOrder: 2, isShown: true, scoreWeight: 1 },
    { groupCode: 'g-liv', displayEn: 'Liver', displayNe: 'NE Liver', sortOrder: 3, isShown: true, scoreWeight: 1 },
    { groupCode: 'g-lip', displayEn: 'Lipids', displayNe: 'NE Lipids', sortOrder: 4, isShown: true, scoreWeight: 1 },
    { groupCode: 'g-bld', displayEn: 'Blood', displayNe: 'NE Blood', sortOrder: 5, isShown: true, scoreWeight: 1 },
  ],
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const run = (i: unknown = baseInputs(), l: unknown = baseLibrary()): Json => buildContent(i as never, l as never) as unknown as Json;
const bytes = (i?: unknown, l?: unknown) => canonicalJson(run(i, l));

/** Fresh deep copy where EVERY array is shuffled and every object's key insertion order is shuffled. */
function shuffleDeep(v: unknown, r: () => number): unknown {
  if (Array.isArray(v)) {
    const a = v.map((x) => shuffleDeep(x, r));
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v as object);
    for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [keys[i], keys[j]] = [keys[j]!, keys[i]!]; }
    return Object.fromEntries(keys.map((k) => [k, shuffleDeep((v as Json)[k], r)]));
  }
  return v;
}
const deepFreeze = <T>(v: T): T => {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v as object).forEach(deepFreeze); }
  return v;
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// ---------- canonicalJson / contentSha256 ----------
describe('canonicalJson (TRD §4.10: keys sorted, no whitespace)', () => {
  it('E-01 sorts keys recursively, no whitespace', () =>
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe('{"a":{"c":"x","d":[1,2]},"b":1}'));
  it('E-02 key order of the input never matters', () =>
    expect(canonicalJson({ z: 1, a: 2, m: { y: 1, b: 2 } })).toBe(canonicalJson({ m: { b: 2, y: 1 }, a: 2, z: 1 })));
  it('E-03 array order is data and is kept', () => expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]'));
  it('E-04 undefined-valued keys are omitted (same as absent)', () =>
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 })));
  it('E-05 strings escape like JSON.stringify; non-ASCII stays literal UTF-8', () =>
    expect(canonicalJson({ t: 'a"b\nने' })).toBe(`{"t":${JSON.stringify('a"b\nने')}}`));
  it('E-06 numbers, booleans, null', () => expect(canonicalJson({ n: -0.5, t: true, f: false, z: null })).toBe('{"f":false,"n":-0.5,"t":true,"z":null}'));
  it('E-07 NaN / Infinity throw (JSON.stringify would silently emit null)', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
  });
  it('E-08 does not mutate its input', () => {
    const v = deepFreeze({ b: [{ y: 1, x: 2 }], a: 1 });
    expect(() => canonicalJson(v)).not.toThrow();
  });
});

describe('contentSha256 (TRD §4.10; 05-SCHEMA ^[0-9a-f]{64}$)', () => {
  it('E-09 known vector: sha256("{}")', () =>
    expect(contentSha256({} as never)).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'));
  it('E-10 equals node:crypto SHA-256 over the canonical bytes (independent oracle)', () => {
    const v = { b: [1, 2], a: 'xन' };
    expect(contentSha256(v as never)).toBe(sha(canonicalJson(v)));
  });
  it('E-11 64 lower-case hex chars; key order of input does not change it', () => {
    const h = contentSha256({ a: 1, b: 2 } as never);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(contentSha256({ b: 2, a: 1 } as never)).toBe(h);
  });
  it('E-12 one changed character changes the hash', () =>
    expect(contentSha256({ t: 'a' } as never)).not.toBe(contentSha256({ t: 'b' } as never)));
});

// ---------- AC-08.2 determinism (done_when) ----------
describe('buildContent determinism (AC-08.2, TRD §4.10)', () => {
  const ref = bytes();
  const refSha = sha(ref);

  it('E-20 same inputs twice: byte-identical JSON and identical content_sha256', () => {
    expect(bytes()).toBe(ref);
    expect(contentSha256(run() as never)).toBe(refSha);
  });

  it('E-21 PROPERTY: 300 random shuffles of every input/library array and key order give byte-identical JSON + hash', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const i = shuffleDeep(baseInputs(), r);
      const l = shuffleDeep(baseLibrary(), r);
      const out = bytes(i, l);
      if (out !== ref) throw new Error(`seed ${seed}: output differs from reference`);
      expect(contentSha256(run(i, l) as never)).toBe(refSha);
    }
  });

  it('E-22 PROPERTY: reversed and sorted input orders also match (adversarial fixed orders)', () => {
    const rev = (o: Json) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? [...v].reverse() : v]));
    expect(bytes(rev(baseInputs()), rev(baseLibrary()))).toBe(ref);
  });

  it('E-23 duplicate analyte tie (same approvedAt) resolves to the greatest resultId regardless of order (TRD §4.1)', () => {
    const c = run();
    const ids = (c.panels as { panelCode: string; resultIds: string[] }[]).flatMap((p) => p.resultIds);
    expect(ids).toContain('r-cre-2');
    expect(ids).not.toContain('r-cre-1');
    expect(ids).not.toContain('r-cre');
    const i = baseInputs(); i.results.reverse();
    expect(bytes(i)).toBe(ref);
  });

  it('E-24 the clock is never read: different system time, identical output', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const a = bytes();
    vi.setSystemTime(new Date('2041-07-07T07:07:07Z'));
    expect(bytes()).toBe(a);
    expect(a).toBe(ref);
  });

  it('E-25 builtAt is taken from inputs, not from the clock', () => expect(run().builtAt).toBe('2026-06-02T00:00:00Z'));

  it('E-26 pure: frozen inputs and library are accepted (no mutation) and give the same bytes', () =>
    expect(bytes(deepFreeze(baseInputs()), deepFreeze(baseLibrary()))).toBe(ref));

  it('E-27 sensitivity: changing a value, a block text or the language changes the hash (hash is not constant)', () => {
    const i = baseInputs(); i.results[0]!.valueNumeric = '131';
    const l = baseLibrary(); l.blocks[0]!.textEn = 'changed {analyte_name}';
    const n = baseLibrary(); n.language = 'ne';
    expect(sha(bytes(i))).not.toBe(refSha);
    expect(sha(bytes(undefined, l))).not.toBe(refSha);
    expect(sha(bytes(undefined, n))).not.toBe(refSha);
  });

  it('E-28 no randomness / ids: output has no uuid-like or timestamp values other than inputs', () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
    expect(ref).not.toMatch(uuid);
  });
});

// ---------- content composition (TRD §3, §4.3–4.8; smoke that engine wires T05–T08 modules) ----------
describe('buildContent content', () => {
  const c = run();

  it('E-30 no patient identifiers in content (registrationNo is display-only, TRD §4.1)', () =>
    expect(canonicalJson(c)).not.toContain('REG-SECRET'));

  it('E-31 panels: group sort order; tile status = worst member; unmeasured group absent', () => {
    expect(c.panels.map((p: Json) => [p.panelCode, p.status])).toEqual([
      ['g-met', 'out_of_range'], ['g-kid', 'in_range'], ['g-liv', 'critical'], ['g-lip', 'in_range'], ['g-bld', 'out_of_range']]);
    expect(c.panels[0].displayName).toBe('Metabolic');
  });

  it('E-32 deranged: severity desc then group/analyte order; filled text; unmapped result excluded', () => {
    expect(c.deranged.map((d: Json) => d.resultId)).toEqual(['r-alt', 'r-glu', 'r-hb']);
    expect(c.deranged[1]).toMatchObject({ analyteId: 'a-glu', direction: 'high', severity: 'out_of_range', templateBlockId: 'b-dhigh', analyteName: 'Fasting Glucose' });
    expect(c.deranged[1].text).toBe('Fasting Glucose is high: 130 u (range 70 – 100).');
  });

  it('E-33 healthScore hs-1 present with panelsScored = scored groups', () =>
    expect(c.healthScore).toMatchObject({ formulaVersion: 'hs-1', panelsScored: 5 }));

  it('E-34 advice: severity desc, priority asc, block_key asc, capped; group name filled', () => {
    expect(c.advice.map((a: Json) => a.templateBlockId)).toEqual(['b-adv-a', 'b-adv-b', 'b-adv-glu']); // 'any' rules trigger at critical; group rule at out_of_range
    expect(c.advice[2].text).toBe('Review Metabolic with your doctor.');
    const l = baseLibrary(); l.params.adviceMaxBlocks = 1;
    expect(run(undefined, l).advice).toHaveLength(1);
  });

  it('E-35 follow-ups: one per test (smallest interval), no price/booking fields, test name from resolved tests', () => {
    expect(c.followUps.map((f: Json) => [f.ruleId, f.suggestedTestCode, f.intervalDays])).toEqual([
      ['ru-fu-lft', 'LFT', 14], ['ru-fu-30', 'HBA1C', 30]]);
    expect(c.followUps[1]).toMatchObject({ suggestedTestName: 'HbA1c', text: 'Repeat HbA1c in 30 days.' });
    expect(Object.keys(c.followUps[0]).sort()).toEqual(['intervalDays', 'ruleId', 'suggestedTestCode', 'suggestedTestName', 'text']);
  });

  it('E-36 follow-up whose test is not in the active list is skipped', () => {
    const i = baseInputs(); i.tests = i.tests.filter((t) => t.testId !== 't-lft');
    expect(run(i).followUps.map((f: Json) => f.ruleId)).toEqual(['ru-fu-30']);
  });

  it('E-37 trends: oldest -> newest points incl. current; history undefined -> []', () => {
    const t = c.trends.find((x: Json) => x.analyteId === 'a-glu');
    expect(t.pointResultIds).toEqual(['h-1', 'h-2', 'h-3', 'r-glu']);
    expect(t.direction).toBe('improved'); // previous 160 (60 above range) -> current 130 (30 above), beyond the 10 % stable band
    const i = baseInputs(); delete (i as Json).history;
    expect(run(i).trends).toEqual([]);
  });

  it('E-38 disclaimer id and text from the library; language ne uses Nepali block text', () => {
    expect(c).toMatchObject({ language: 'en', disclaimerBlockId: 'b-disc', disclaimerText: 'Not a diagnosis.' });
    const l = baseLibrary(); l.language = 'ne';
    const n = run(undefined, l);
    expect(n).toMatchObject({ language: 'ne', disclaimerText: 'NE disclaimer' });
    expect(n.panels[0].displayName).toBe('NE Metabolic');
  });

  it('E-39 all in range: deranged, advice-of-findings and follow-ups empty (no finding, no follow-up)', () => {
    const i = baseInputs();
    i.results = [res('r1', 'a-glu', 'N', '90', snap('70', '100')), res('r2', 'a-cre', 'N', '0.9', snap('0.6', '1.3'))];
    const o = run(i);
    expect(o.deranged).toEqual([]);
    expect(o.followUps).toEqual([]);
  });
});
