// C14 T06 — domain/deranged.ts (02-TRD §4.5; AC-10.1 rule precedence + placeholder fill, AC-10.4 ordering).
// API pinned by these tests (spec gives no names):
//   resolveDerangedRule(rules, { analyteId, groupCode, direction, severity }) -> Rule | undefined
//     Rule = { id, ruleKind, triggerKind, analyteId?, groupCode?, direction, minSeverity?, priority, blockId }
//     only ruleKind 'deranged' considered; analyte > group > any; then lowest priority; then smallest id.
//   buildDerangedEntries({ items, rules, blocks, language }) -> { resultId, analyteId, direction, severity, templateBlockId, text, analyteName }[]
//     item = { resultId, analyteId, analyte:{name,printName?}, groupCode, groupName, groupSortOrder, analyteSortOrder,
//              status, direction?, result:{valueNumeric?,valueText?,ordinalCode?,unitCode?}, referenceRangeSnapshot? }
//     in_range items yield no entry; output order per §4.5 regardless of input order.
//     block = { id, kind, textEn?, textNe? }; language 'en' | 'ne'.
import { describe, expect, it } from 'vitest';
import { buildDerangedEntries, resolveDerangedRule } from '../deranged.js';

type Sev = 'borderline' | 'out_of_range' | 'critical';
const rule = (o: Record<string, unknown>) =>
  ({ ruleKind: 'deranged', triggerKind: 'any', direction: 'any', minSeverity: 'borderline', priority: 100, ...o }) as never;
const target = (o: Record<string, unknown> = {}) =>
  ({ analyteId: 'A-HGB', groupCode: 'blood_counts', direction: 'low', severity: 'out_of_range' as Sev, ...o }) as never;
const idOf = (rules: unknown[], t = target()) => (resolveDerangedRule(rules as never, t) as { id: string } | undefined)?.id;

describe('resolveDerangedRule — precedence (§4.5)', () => {
  it('analyte > group > any, even when the more specific rule has a worse priority number', () => {
    const rules = [
      rule({ id: 'r-any', triggerKind: 'any', priority: 1 }),
      rule({ id: 'r-grp', triggerKind: 'group', groupCode: 'blood_counts', priority: 50 }),
      rule({ id: 'r-ana', triggerKind: 'analyte', analyteId: 'A-HGB', priority: 999 }),
    ];
    expect(idOf(rules)).toBe('r-ana');
    expect(idOf(rules.slice(0, 2))).toBe('r-grp');
    expect(idOf(rules.slice(0, 1))).toBe('r-any');
  });
  it('same specificity: lowest priority wins', () => {
    expect(idOf([rule({ id: 'b', priority: 200 }), rule({ id: 'a', priority: 100 })])).toBe('a');
  });
  it('same specificity and priority: smallest id wins (input order irrelevant)', () => {
    expect(idOf([rule({ id: 'r-02' }), rule({ id: 'r-01' }), rule({ id: 'r-03' })])).toBe('r-01');
    expect(idOf([rule({ id: 'r-03' }), rule({ id: 'r-01' }), rule({ id: 'r-02' })])).toBe('r-01');
  });
  it('rule for another analyte / another group does not match', () => {
    const rules = [
      rule({ id: 'other-ana', triggerKind: 'analyte', analyteId: 'A-WBC' }),
      rule({ id: 'other-grp', triggerKind: 'group', groupCode: 'liver' }),
      rule({ id: 'r-any' }),
    ];
    expect(idOf(rules)).toBe('r-any');
  });
  it('direction: exact or "any" matches, a different direction does not', () => {
    expect(idOf([rule({ id: 'hi', direction: 'high' }), rule({ id: 'g' })])).toBe('g');
    expect(idOf([rule({ id: 'a-lo', direction: 'low' }), rule({ id: 'g' })])).toBe('a-lo');
    expect(idOf([rule({ id: 'dir-any', direction: 'any' })])).toBe('dir-any');
  });
  it('direction mismatch on the analyte rule falls through to the generic rule', () => {
    expect(idOf([rule({ id: 'ana-high', triggerKind: 'analyte', analyteId: 'A-HGB', direction: 'high' }), rule({ id: 'gen-low', direction: 'low' })])).toBe('gen-low');
  });
  it('min_severity ordering borderline < out_of_range < critical', () => {
    const only = (min: Sev, sev: Sev) => idOf([rule({ id: 'r', minSeverity: min })], target({ severity: sev }));
    expect(only('borderline', 'borderline')).toBe('r');
    expect(only('borderline', 'critical')).toBe('r');
    expect(only('out_of_range', 'out_of_range')).toBe('r');
    expect(only('out_of_range', 'borderline')).toBeUndefined();
    expect(only('critical', 'out_of_range')).toBeUndefined();
    expect(only('critical', 'critical')).toBe('r');
  });
  it('severity-gated analyte rule yields to a lower-specificity rule that does match', () => {
    const rules = [rule({ id: 'ana-crit', triggerKind: 'analyte', analyteId: 'A-HGB', minSeverity: 'critical' }), rule({ id: 'gen' })];
    expect(idOf(rules, target({ severity: 'out_of_range' }))).toBe('gen');
    expect(idOf(rules, target({ severity: 'critical' }))).toBe('ana-crit');
  });
  it('ignores advice / followup rules', () => {
    expect(idOf([rule({ id: 'adv', ruleKind: 'advice' }), rule({ id: 'fu', ruleKind: 'followup' })])).toBeUndefined();
  });
  it('no rule matches -> undefined (never throws)', () => {
    expect(idOf([])).toBeUndefined();
  });
});

describe('buildDerangedEntries', () => {
  const blocks = [
    { id: 'B-gen-low', kind: 'deranged', textEn: '{analyte_name} is below the reference range of this laboratory.', textNe: '{analyte_name} न्यून छ।' },
    { id: 'B-gen-high', kind: 'deranged', textEn: '{analyte_name} is above the reference range of this laboratory.' },
    { id: 'B-hgb-low', kind: 'deranged', textEn: '{analyte_name} is below range: {value} {unit} (range {ref_range}, {group_name}).' },
  ];
  const rules = [
    rule({ id: 'r-gen-low', direction: 'low', blockId: 'B-gen-low', priority: 900 }),
    rule({ id: 'r-gen-high', direction: 'high', blockId: 'B-gen-high', priority: 900 }),
    rule({ id: 'r-hgb-low', triggerKind: 'analyte', analyteId: 'A-HGB', direction: 'low', blockId: 'B-hgb-low' }),
  ];
  const item = (o: Record<string, unknown>) => ({
    resultId: 'res-1', analyteId: 'A-X', analyte: { name: 'X', printName: 'X print' }, groupCode: 'g1', groupName: 'Group 1',
    groupSortOrder: 10, analyteSortOrder: 10, status: 'out_of_range', direction: 'high',
    result: { valueNumeric: '1.0', unitCode: 'u' }, referenceRangeSnapshot: { low: '0.1', high: '0.9' }, ...o,
  });
  const build = (items: unknown[], language: 'en' | 'ne' = 'en') =>
    buildDerangedEntries({ items, rules, blocks, language } as never) as unknown as Array<Record<string, unknown>>;

  it('AC-10.1: HGB low -> analyte rule block, {analyte_name} from catalog print name, other placeholders filled', () => {
    const [e] = build([item({
      resultId: 'res-hgb', analyteId: 'A-HGB', analyte: { name: 'HGB', printName: 'Hemoglobin' }, groupCode: 'blood_counts',
      groupName: 'Blood counts', direction: 'low', result: { valueNumeric: '9.1', unitCode: 'g/dL' }, referenceRangeSnapshot: { low: '13.5', high: '17.5' },
    })]);
    expect(e).toMatchObject({
      resultId: 'res-hgb', analyteId: 'A-HGB', direction: 'low', severity: 'out_of_range', templateBlockId: 'B-hgb-low', analyteName: 'Hemoglobin',
      text: 'Hemoglobin is below range: 9.1 g/dL (range 13.5 – 17.5, Blood counts).',
    });
  });
  it('AC-10.1: another analyte with the same direction gets the generic block', () => {
    const [e] = build([item({ analyteId: 'A-WBC', analyte: { name: 'WBC', printName: 'White cells' }, direction: 'low' })]);
    expect(e).toMatchObject({ templateBlockId: 'B-gen-low', text: 'White cells is below the reference range of this laboratory.' });
  });
  it('severity is the item status; direction is the item direction', () => {
    const [e] = build([item({ status: 'critical', direction: 'high' })]);
    expect(e).toMatchObject({ severity: 'critical', direction: 'high', templateBlockId: 'B-gen-high' });
  });
  it('in_range items produce no entry', () => {
    expect(build([item({ status: 'in_range', direction: undefined })])).toEqual([]);
    expect(build([])).toEqual([]);
  });
  it('Nepali library language uses text_ne', () => {
    const [e] = build([item({ analyteId: 'A-WBC', analyte: { name: 'WBC', printName: 'WBC' }, direction: 'low' })], 'ne');
    expect(e.text).toBe('WBC न्यून छ।');
  });

  describe('AC-10.4 ordering: severity, group sort_order, analyte sortOrder, resultId', () => {
    const mk = (resultId: string, status: string, groupSortOrder: number, analyteSortOrder: number) =>
      item({ resultId, status, groupSortOrder, analyteSortOrder, groupCode: `g${groupSortOrder}`, analyteId: `A-${resultId}` });
    const items = [
      mk('r-b1', 'borderline', 1, 1),
      mk('r-o2-5', 'out_of_range', 2, 5),
      mk('r-c9', 'critical', 9, 9),
      mk('r-o1-9', 'out_of_range', 1, 9),
      mk('r-o1-2b', 'out_of_range', 1, 2),
      mk('r-o1-2a', 'out_of_range', 1, 2),
    ];
    const expected = ['r-c9', 'r-o1-2a', 'r-o1-2b', 'r-o1-9', 'r-o2-5', 'r-b1'];
    it('orders as specified', () => {
      expect(build(items).map((e) => e.resultId)).toEqual(expected);
    });
    it('is independent of input order (deterministic)', () => {
      expect(build([...items].reverse()).map((e) => e.resultId)).toEqual(expected);
      expect(build([items[3]!, items[0]!, items[5]!, items[2]!, items[4]!, items[1]!]).map((e) => e.resultId)).toEqual(expected);
    });
    it('does not mutate its input', () => {
      const copy = items.map((i) => i.resultId);
      build(items);
      expect(items.map((i) => i.resultId)).toEqual(copy);
    });
  });
});
