// C14 T07 — domain/advice.ts (02-TRD §4.6; AC-11.1 dedupe, AC-11.2 cap by severity then priority, AC-11.3 all_in_range).
// API pinned by these tests (spec gives no names):
//   selectAdvice({ entries, tiles, rules, blocks, language, adviceMaxBlocks }) -> { templateBlockId, text }[]
//     entries = DerangedEntry + groupCode: { resultId, analyteId, groupCode, direction, severity, ... }
//     tiles   = { groupCode, groupName, status: 'in_range'|'borderline'|'out_of_range'|'critical' }
//     rules   = { id, ruleKind, triggerKind: analyte|group|any|all_in_range, analyteId?, groupCode?, direction, minSeverity?, priority, blockId }
//               (only ruleKind 'advice' considered)
//     blocks  = { id, kind, blockKey, textEn?, textNe? }; language 'en'|'ne'
//   Dedupe by blockId (highest trigger severity, then lowest priority); order: trigger severity desc, priority asc, blockKey asc; cap.
import { describe, expect, it } from 'vitest';
import { selectAdvice } from '../advice.js';

type Sev = 'borderline' | 'out_of_range' | 'critical';
const entry = (o: Record<string, unknown> = {}) =>
  ({ resultId: 'res-1', analyteId: 'A-HGB', groupCode: 'blood_counts', direction: 'low', severity: 'out_of_range' as Sev,
    templateBlockId: 'b-d', text: 'x', analyteName: 'Hemoglobin', ...o });
const tile = (o: Record<string, unknown> = {}) =>
  ({ groupCode: 'blood_counts', groupName: 'Blood counts', status: 'out_of_range', ...o });
const rule = (o: Record<string, unknown>) =>
  ({ ruleKind: 'advice', triggerKind: 'any', direction: 'any', minSeverity: 'borderline', priority: 100, ...o });
const block = (id: string, o: Record<string, unknown> = {}) =>
  ({ id, kind: 'advice', blockKey: `advice.${id}`, textEn: `text ${id}`, textNe: `पाठ ${id}`, ...o });
const run = (o: Record<string, unknown>) =>
  selectAdvice({ entries: [entry()], tiles: [tile()], rules: [], blocks: [], language: 'en', adviceMaxBlocks: 5, ...o } as never);
const ids = (r: unknown) => (r as { templateBlockId: string }[]).map((x) => x.templateBlockId);

describe('AC-11.1 dedupe by block', () => {
  it('two rules pointing to the same block → block appears once', () => {
    const r = run({
      entries: [entry(), entry({ resultId: 'res-2', analyteId: 'A-FER', groupCode: 'iron' })],
      tiles: [tile(), tile({ groupCode: 'iron', groupName: 'Iron' })],
      rules: [
        rule({ id: 'r1', triggerKind: 'analyte', analyteId: 'A-HGB', blockId: 'iron_rich' }),
        rule({ id: 'r2', triggerKind: 'analyte', analyteId: 'A-FER', blockId: 'iron_rich' }),
      ],
      blocks: [block('iron_rich')],
    });
    expect(ids(r)).toEqual(['iron_rich']);
    expect(r[0]).toEqual({ templateBlockId: 'iron_rich', text: 'text iron_rich' });
  });
  it('dedupe keeps the highest trigger severity: it sorts ahead of a mid-severity block', () => {
    const r = run({
      entries: [entry({ severity: 'borderline' }), entry({ resultId: 'res-2', analyteId: 'A-FER', severity: 'critical' })],
      rules: [
        rule({ id: 'r1', triggerKind: 'analyte', analyteId: 'A-HGB', blockId: 'dup', priority: 1 }),
        rule({ id: 'r2', triggerKind: 'analyte', analyteId: 'A-FER', blockId: 'dup', priority: 500 }),
        rule({ id: 'r3', triggerKind: 'analyte', analyteId: 'A-HGB', blockId: 'mid', priority: 1, minSeverity: 'borderline' }),
      ],
      blocks: [block('dup'), block('mid')],
    });
    expect(ids(r)).toEqual(['dup', 'mid']); // dup counted at critical, not at its borderline/priority-1 match
  });
  it('same block matched with different priorities → lowest priority used for ordering', () => {
    const r = run({
      rules: [
        rule({ id: 'r1', blockId: 'dup', priority: 90 }),
        rule({ id: 'r2', blockId: 'dup', priority: 10 }),
        rule({ id: 'r3', blockId: 'other', priority: 50 }),
      ],
      blocks: [block('dup'), block('other')],
    });
    expect(ids(r)).toEqual(['dup', 'other']);
  });
});

describe('AC-11.2 cap and ordering', () => {
  const four = () => ({
    entries: [
      entry({ resultId: 'a', analyteId: 'A1', severity: 'borderline' }),
      entry({ resultId: 'b', analyteId: 'A2', severity: 'out_of_range' }),
      entry({ resultId: 'c', analyteId: 'A3', severity: 'critical' }),
    ],
    rules: [
      rule({ id: 'r1', triggerKind: 'analyte', analyteId: 'A1', blockId: 'x1', priority: 1 }),
      rule({ id: 'r2', triggerKind: 'analyte', analyteId: 'A2', blockId: 'x2', priority: 20 }),
      rule({ id: 'r3', triggerKind: 'analyte', analyteId: 'A2', blockId: 'x3', priority: 10 }),
      rule({ id: 'r4', triggerKind: 'analyte', analyteId: 'A3', blockId: 'x4', priority: 99 }),
    ],
    blocks: ['x1', 'x2', 'x3', 'x4'].map((i) => block(i)),
  });
  it('advice_max_blocks = 2 with four matches → highest severity, then lowest priority number', () => {
    expect(ids(run({ ...four(), adviceMaxBlocks: 2 }))).toEqual(['x4', 'x3']);
  });
  it('uncapped order: severity desc, priority asc', () => {
    expect(ids(run({ ...four(), adviceMaxBlocks: 10 }))).toEqual(['x4', 'x3', 'x2', 'x1']);
  });
  it('ties on severity and priority → block_key asc (input order irrelevant)', () => {
    const base = { rules: [rule({ id: 'r1', blockId: 'zz' }), rule({ id: 'r2', blockId: 'aa' })],
      blocks: [block('zz', { blockKey: 'advice.zebra' }), block('aa', { blockKey: 'advice.apple' })] };
    expect(ids(run(base))).toEqual(['aa', 'zz']);
    expect(ids(run({ rules: [...base.rules].reverse(), blocks: [...base.blocks].reverse() }))).toEqual(['aa', 'zz']);
  });
  it('adviceMaxBlocks = 0 → empty; cap larger than matches → all', () => {
    expect(run({ ...four(), adviceMaxBlocks: 0 })).toEqual([]);
    expect(run({ ...four(), adviceMaxBlocks: 10 })).toHaveLength(4);
  });
});

describe('AC-11.3 all_in_range', () => {
  const air = () => rule({ id: 'r-air', triggerKind: 'all_in_range', blockId: 'all_ok' });
  it('no deranged entries + all_in_range rule → exactly that block', () => {
    const r = run({ entries: [], tiles: [tile({ status: 'in_range' })], rules: [air()], blocks: [block('all_ok')] });
    expect(r).toEqual([{ templateBlockId: 'all_ok', text: 'text all_ok' }]);
  });
  it('any deranged entry → all_in_range rule does not match', () => {
    expect(run({ rules: [air()], blocks: [block('all_ok')] })).toEqual([]);
  });
  it('no entries and no all_in_range rule → empty (no generic wellness padding)', () => {
    expect(run({ entries: [], tiles: [], rules: [rule({ id: 'r', blockId: 'x' })], blocks: [block('x')] })).toEqual([]);
  });
});

describe('trigger matching (§4.6)', () => {
  const sel = (rules: unknown[], o: Record<string, unknown> = {}) =>
    ids(run({ rules, blocks: [block('b')], ...o }));
  it('only ruleKind advice is considered', () => {
    expect(sel([rule({ id: 'r', ruleKind: 'deranged', blockId: 'b' })])).toEqual([]);
    expect(sel([rule({ id: 'r', ruleKind: 'followup', blockId: 'b' })])).toEqual([]);
  });
  it('analyte trigger: analyte, direction and min_severity must match', () => {
    expect(sel([rule({ id: 'r', triggerKind: 'analyte', analyteId: 'A-HGB', direction: 'low', blockId: 'b' })])).toEqual(['b']);
    expect(sel([rule({ id: 'r', triggerKind: 'analyte', analyteId: 'A-WBC', blockId: 'b' })])).toEqual([]);
    expect(sel([rule({ id: 'r', triggerKind: 'analyte', analyteId: 'A-HGB', direction: 'high', blockId: 'b' })])).toEqual([]);
    expect(sel([rule({ id: 'r', triggerKind: 'analyte', analyteId: 'A-HGB', minSeverity: 'critical', blockId: 'b' })])).toEqual([]);
  });
  it('group trigger: tile status >= min_severity', () => {
    const g = (minSeverity: string, status: string) =>
      sel([rule({ id: 'r', triggerKind: 'group', groupCode: 'blood_counts', minSeverity, blockId: 'b' })], { tiles: [tile({ status })] });
    expect(g('out_of_range', 'out_of_range')).toEqual(['b']);
    expect(g('out_of_range', 'critical')).toEqual(['b']);
    expect(g('out_of_range', 'borderline')).toEqual([]);
    expect(g('borderline', 'in_range')).toEqual([]);
  });
  it('group trigger with direction ≠ any needs a deranged entry in that direction', () => {
    const g = (direction: string) =>
      sel([rule({ id: 'r', triggerKind: 'group', groupCode: 'blood_counts', direction, blockId: 'b' })]);
    expect(g('low')).toEqual(['b']);
    expect(g('high')).toEqual([]);
    expect(g('any')).toEqual(['b']);
  });
  it('group trigger for another group does not match', () => {
    expect(sel([rule({ id: 'r', triggerKind: 'group', groupCode: 'liver', blockId: 'b' })], { tiles: [tile(), tile({ groupCode: 'liver', status: 'in_range' })] })).toEqual([]);
  });
  it('any trigger: direction and min_severity checked against entries', () => {
    expect(sel([rule({ id: 'r', direction: 'low', minSeverity: 'out_of_range', blockId: 'b' })])).toEqual(['b']);
    expect(sel([rule({ id: 'r', direction: 'high', blockId: 'b' })])).toEqual([]);
    expect(sel([rule({ id: 'r', minSeverity: 'critical', blockId: 'b' })])).toEqual([]);
  });
});

describe('language and robustness', () => {
  it('uses textNe for language ne, textEn for en', () => {
    const o = { rules: [rule({ id: 'r', blockId: 'b' })], blocks: [block('b')] };
    expect(run(o)[0]?.text).toBe('text b');
    expect(run({ ...o, language: 'ne' })[0]?.text).toBe('पाठ b');
  });
  it('does not mutate its inputs', () => {
    const rules = [rule({ id: 'r2', blockId: 'b2' }), rule({ id: 'r1', blockId: 'b1' })];
    const snap = JSON.stringify(rules);
    run({ rules, blocks: [block('b1'), block('b2')] });
    expect(JSON.stringify(rules)).toBe(snap);
  });
});
