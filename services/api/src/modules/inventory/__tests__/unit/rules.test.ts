// C12.T-02 — domain/rules.ts: rule matching and precedence (02-TRD §8.3; PRD AC-12.6; 05-SCHEMA consumption_rules, 05 §6.4).
// Expected interface (domain/rules.ts); property names are the spec's column names, so rows map 1:1 from SQL:
//   ruleKindForFact(factKind): 'per_test'|'per_analyte'|'per_rerun'|'per_qc'|'per_calibration'|'per_day'   throws .code 'common.validation_failed' for an unknown kind
//   matchRules(fact, rules): { rule_id, item_id, qty_base: DecimalString, attributed_test_id }[]
//     fact:  { fact_kind, occurred_at: ISO instant, instrument_id: string|null, test_id: string|null, analyte_id: string|null, multiplier: number, rule_id?: string }
//     rules: { id, rule_kind, test_id, analyte_id, instrument_id, item_id, qty_base: DecimalString, effective_from: ISO, effective_to: ISO|null, is_active: boolean }[]
//   Result order is not specified; the tests sort by rule_id.
import { describe, expect, it } from 'vitest';
import { matchRules, ruleKindForFact } from '../../domain/rules.js';
import { codeOf, norm } from './helpers.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T1 = id(101), T2 = id(102); // tests
const A1 = id(201), A2 = id(202); // analytes
const BIO1 = id(301), BIO2 = id(302); // instruments
const X = id(401), Y = id(402); // items
const NOW = '2026-11-13T04:00:00Z';

interface Rule { id: string; rule_kind: string; test_id: string | null; analyte_id: string | null; instrument_id: string | null; item_id: string; qty_base: string; effective_from: string; effective_to: string | null; is_active: boolean }
let seq = 1000;
const rule = (o: Partial<Rule> & Pick<Rule, 'rule_kind'>): Rule => ({
  id: id(seq++), test_id: null, analyte_id: null, instrument_id: null, item_id: X, qty_base: '1',
  effective_from: '2026-01-01T00:00:00Z', effective_to: null, is_active: true, ...o,
});
const fact = (o: Partial<{ fact_kind: string; occurred_at: string; instrument_id: string | null; test_id: string | null; analyte_id: string | null; multiplier: number; rule_id: string }> = {}) => ({
  fact_kind: 'test', occurred_at: NOW, instrument_id: BIO1, test_id: T1, analyte_id: null, multiplier: 1, ...o,
});
const ids = (needs: ReturnType<typeof matchRules>) => needs.map((n) => n.rule_id).sort();

describe('§8.3 fact kind → rule kind', () => {
  it.each([['test', 'per_test'], ['analyte', 'per_analyte'], ['rerun', 'per_rerun'], ['qc', 'per_qc'], ['calibration', 'per_calibration'], ['fixed', 'per_day']])(
    '%s → %s',
    (f, k) => expect(ruleKindForFact(f as never)).toBe(k),
  );
  it.each([['per_test'], ['bogus'], [''], ['__proto__'], ['constructor']])('rejects %j', (f) => {
    expect(codeOf(() => ruleKindForFact(f as never))).toBe('common.validation_failed');
  });
});

describe('AC-12.6 instrument-specific overrides generic for the same (test, item)', () => {
  const generic = rule({ rule_kind: 'per_test', test_id: T1, qty_base: '1' });
  const specific = rule({ rule_kind: 'per_test', test_id: T1, instrument_id: BIO1, qty_base: '2' });
  it('an event from BIO-1 uses only the BIO-1 rule', () => {
    const n = matchRules(fact({ instrument_id: BIO1 }), [generic, specific]);
    expect(ids(n)).toEqual([specific.id]);
    expect(norm(n[0]!.qty_base)).toBe('2');
  });
  it('an event from another instrument uses the generic rule', () => {
    expect(ids(matchRules(fact({ instrument_id: BIO2 }), [generic, specific]))).toEqual([generic.id]);
  });
  it('an event with no instrument uses the generic rule and never an instrument-specific one', () => {
    expect(ids(matchRules(fact({ instrument_id: null }), [generic, specific]))).toEqual([generic.id]);
    expect(matchRules(fact({ instrument_id: null }), [specific])).toEqual([]);
  });
  it('the override works per item: BIO-1 specific for X does not suppress generic for Y', () => {
    const genericY = rule({ rule_kind: 'per_test', test_id: T1, item_id: Y });
    expect(ids(matchRules(fact(), [generic, specific, genericY]))).toEqual([specific.id, genericY.id].sort());
  });
  it('a BIO-2 specific rule does not apply to BIO-1', () => {
    const other = rule({ rule_kind: 'per_test', test_id: T1, instrument_id: BIO2 });
    expect(matchRules(fact({ instrument_id: BIO1 }), [other])).toEqual([]);
    expect(ids(matchRules(fact({ instrument_id: BIO1 }), [other, generic]))).toEqual([generic.id]);
  });
  it('two items on one test produce two needs', () => {
    const r2 = rule({ rule_kind: 'per_test', test_id: T1, item_id: Y, qty_base: '0.5' });
    const n = matchRules(fact(), [generic, r2]);
    expect(n).toHaveLength(2);
    expect(n.map((x) => x.item_id).sort()).toEqual([X, Y].sort());
  });
});

describe('§8.3 step 1: kind and key fields', () => {
  it('per_test matches test_id only; other tests and other kinds do not match', () => {
    const r = rule({ rule_kind: 'per_test', test_id: T1 });
    expect(ids(matchRules(fact({ test_id: T1 }), [r]))).toEqual([r.id]);
    expect(matchRules(fact({ test_id: T2 }), [r])).toEqual([]);
    expect(matchRules(fact({ test_id: T1, fact_kind: 'rerun' }), [r])).toEqual([]);
  });
  it('per_analyte needs test AND analyte', () => {
    const r = rule({ rule_kind: 'per_analyte', test_id: T1, analyte_id: A1 });
    expect(ids(matchRules(fact({ fact_kind: 'analyte', analyte_id: A1 }), [r]))).toEqual([r.id]);
    expect(matchRules(fact({ fact_kind: 'analyte', analyte_id: A2 }), [r])).toEqual([]);
    expect(matchRules(fact({ fact_kind: 'analyte', analyte_id: A1, test_id: T2 }), [r])).toEqual([]);
    expect(matchRules(fact({ fact_kind: 'analyte', analyte_id: null }), [r])).toEqual([]);
  });
  it('per_rerun and per_calibration match test_id', () => {
    const rr = rule({ rule_kind: 'per_rerun', test_id: T1 });
    const cal = rule({ rule_kind: 'per_calibration', test_id: T1 });
    expect(ids(matchRules(fact({ fact_kind: 'rerun' }), [rr, cal]))).toEqual([rr.id]);
    expect(ids(matchRules(fact({ fact_kind: 'calibration' }), [rr, cal]))).toEqual([cal.id]);
    expect(matchRules(fact({ fact_kind: 'rerun', test_id: T2 }), [rr])).toEqual([]);
  });
  it('per_qc matches analyte = A or analyte null; test_id is the attribution test', () => {
    const exact = rule({ rule_kind: 'per_qc', test_id: T1, analyte_id: A1 });
    const any = rule({ rule_kind: 'per_qc', test_id: T2, analyte_id: null, item_id: Y });
    const otherAnalyte = rule({ rule_kind: 'per_qc', test_id: T1, analyte_id: A2 });
    const n = matchRules(fact({ fact_kind: 'qc', test_id: null, analyte_id: A1 }), [exact, any, otherAnalyte]);
    expect(ids(n)).toEqual([exact.id, any.id].sort());
    expect(n.find((x) => x.rule_id === exact.id)!.attributed_test_id).toBe(T1);
    expect(n.find((x) => x.rule_id === any.id)!.attributed_test_id).toBe(T2);
  });
  it('per_qc: grouping also by analyte-null, so an analyte rule and a catch-all rule on the same item both apply', () => {
    const exact = rule({ rule_kind: 'per_qc', test_id: T1, analyte_id: A1, qty_base: '1' });
    const any = rule({ rule_kind: 'per_qc', test_id: T1, analyte_id: null, qty_base: '3' }); // same item X
    expect(ids(matchRules(fact({ fact_kind: 'qc', test_id: null, analyte_id: A1 }), [exact, any]))).toEqual([exact.id, any.id].sort());
  });
  it('per_qc: instrument-specific overrides generic within the same group only', () => {
    const exactGeneric = rule({ rule_kind: 'per_qc', test_id: T1, analyte_id: A1 });
    const exactBio1 = rule({ rule_kind: 'per_qc', test_id: T1, analyte_id: A1, instrument_id: BIO1 });
    const anyGeneric = rule({ rule_kind: 'per_qc', test_id: T1, analyte_id: null }); // other group (analyte null)
    const n = matchRules(fact({ fact_kind: 'qc', test_id: null, analyte_id: A1 }), [exactGeneric, exactBio1, anyGeneric]);
    expect(ids(n)).toEqual([exactBio1.id, anyGeneric.id].sort());
  });
  it('per_day: only the rule given by the cron (fact.rule_id) matches', () => {
    const r1 = rule({ rule_kind: 'per_day', instrument_id: BIO1 });
    const r2 = rule({ rule_kind: 'per_day', instrument_id: BIO1, item_id: Y });
    expect(ids(matchRules(fact({ fact_kind: 'fixed', test_id: null, rule_id: r1.id }), [r1, r2]))).toEqual([r1.id]);
    expect(ids(matchRules(fact({ fact_kind: 'fixed', test_id: null, rule_id: r2.id }), [r1, r2]))).toEqual([r2.id]);
    expect(matchRules(fact({ fact_kind: 'fixed', test_id: null }), [r1, r2])).toEqual([]); // no rule_id → nothing (never "all per_day rules")
  });
  it('inactive rules never match', () => {
    expect(matchRules(fact(), [rule({ rule_kind: 'per_test', test_id: T1, is_active: false })])).toEqual([]);
  });
  it('an inactive instrument-specific rule does not suppress the generic rule', () => {
    const generic = rule({ rule_kind: 'per_test', test_id: T1 });
    const off = rule({ rule_kind: 'per_test', test_id: T1, instrument_id: BIO1, is_active: false });
    expect(ids(matchRules(fact(), [generic, off]))).toEqual([generic.id]);
  });
  it('no rules, or rules of other keys only → no needs', () => {
    expect(matchRules(fact(), [])).toEqual([]);
    expect(matchRules(fact(), [rule({ rule_kind: 'per_test', test_id: T2 })])).toEqual([]);
  });
});

describe('§8.3 step 1 and 4: effective window is [effective_from, effective_to) evaluated at the fact time t', () => {
  const r = rule({ rule_kind: 'per_test', test_id: T1, effective_from: '2026-11-01T00:00:00Z', effective_to: '2026-11-10T00:00:00Z' });
  it('t = effective_from is inside', () => expect(ids(matchRules(fact({ occurred_at: '2026-11-01T00:00:00Z' }), [r]))).toEqual([r.id]));
  it('t just before effective_from is outside', () => expect(matchRules(fact({ occurred_at: '2026-10-31T23:59:59.999Z' }), [r])).toEqual([]));
  it('t just before effective_to is inside', () => expect(ids(matchRules(fact({ occurred_at: '2026-11-09T23:59:59.999Z' }), [r]))).toEqual([r.id]));
  it('t = effective_to is outside (exclusive)', () => expect(matchRules(fact({ occurred_at: '2026-11-10T00:00:00Z' }), [r])).toEqual([]));
  it('open-ended rule (effective_to null) matches any later t', () => {
    const open = rule({ rule_kind: 'per_test', test_id: T1, effective_to: null });
    expect(ids(matchRules(fact({ occurred_at: '2099-01-01T00:00:00Z' }), [open]))).toEqual([open.id]);
  });
  it('a rule superseded after t still applies to a late event whose t is inside its window; the successor does not', () => {
    const old = rule({ rule_kind: 'per_test', test_id: T1, qty_base: '1', effective_from: '2026-01-01T00:00:00Z', effective_to: '2026-11-10T00:00:00Z' });
    const next = rule({ rule_kind: 'per_test', test_id: T1, qty_base: '2', effective_from: '2026-11-10T00:00:00Z', effective_to: null });
    const late = matchRules(fact({ occurred_at: '2026-11-05T12:00:00Z' }), [old, next]); // processed today, occurred before the change
    expect(ids(late)).toEqual([old.id]);
    expect(norm(late[0]!.qty_base)).toBe('1');
    expect(ids(matchRules(fact({ occurred_at: '2026-11-12T12:00:00Z' }), [old, next]))).toEqual([next.id]);
  });
  it('compares instants, not strings (offset notation)', () => {
    const rr = rule({ rule_kind: 'per_test', test_id: T1, effective_from: '2026-11-13T00:00:00+05:45' }); // = 2026-11-12T18:15:00Z
    expect(ids(matchRules(fact({ occurred_at: '2026-11-12T18:15:00Z' }), [rr]))).toEqual([rr.id]);
    expect(matchRules(fact({ occurred_at: '2026-11-12T18:14:59Z' }), [rr])).toEqual([]);
  });
});

describe('§8.3 step 3: qty = rule.qty_base × fact.multiplier; attribution test = rule.test_id', () => {
  it.each([
    ['0.5', 3, '1.5'],
    ['1', 1, '1'],
    ['0.000001', 50, '0.00005'],
    ['0.1', 3, '0.3'], // binary-float trap
    ['12.345678', 2, '24.691356'],
    ['999999999999', 1, '999999999999'],
  ])('%s × %i = %s', (q, m, expected) => {
    const r = rule({ rule_kind: 'per_test', test_id: T1, qty_base: q });
    const n = matchRules(fact({ multiplier: m }), [r]);
    expect(norm(n[0]!.qty_base)).toBe(expected);
    expect(n[0]).toMatchObject({ rule_id: r.id, item_id: X, attributed_test_id: T1 });
  });
  it.each([[0], [-1], [1.5], [Number.NaN]])('rejects multiplier %s (CHECK multiplier BETWEEN 1 AND 50 is integer)', (m) => {
    const r = rule({ rule_kind: 'per_test', test_id: T1 });
    expect(codeOf(() => matchRules(fact({ multiplier: m }), [r]))).toBe('common.validation_failed');
  });
  it('rejects multiplier above 50', () => {
    expect(codeOf(() => matchRules(fact({ multiplier: 51 }), [rule({ rule_kind: 'per_test', test_id: T1 })]))).toBe('common.validation_failed');
  });
  it('does not mutate the rules it is given', () => {
    const rs = [rule({ rule_kind: 'per_test', test_id: T1 }), rule({ rule_kind: 'per_test', test_id: T1, instrument_id: BIO1 })];
    const snap = JSON.stringify(rs);
    matchRules(fact(), rs);
    expect(JSON.stringify(rs)).toBe(snap);
  });
});
