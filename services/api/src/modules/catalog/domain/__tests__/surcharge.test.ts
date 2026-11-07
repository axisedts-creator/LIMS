// C3 T-18 — urgent-surcharge domain rules (domain/surcharge.ts). Spec: 02-TRD §7.5 (rules effective at `at`; candidates: orderable scope (orderable_id = id), department scope (the test's
// department; for a panel its own department_id if set), `all`; rank = specificity orderable 3 > department 2 > all 1, then list-scoped (price_list_id = the winning list) over unscoped;
// top rule: flat -> amount_paisa, percent -> round_half_up(unit_price_paisa x percent_bp / 10000); no rule -> undefined; overlapping windows with the same (scope, key, price_list_id) are
// rejected at create), 01-PRD AC-14.1 (50 % of 90000 = 45000), AC-14.2 (specificity + list scope), AC-14.3 (round half-up to the paisa), AC-14.4 (no rule = no surcharge, not an error),
// 02-CV §4.9 (integer paisa, no floats).
// Windows are half-open [effective_from, effective_to) — the same convention as 02-TRD §7.6a (`effective_from <= t < coalesce(effective_to, +inf)`); this is what lets AC-15.5's successor
// (predecessor.effective_to := successor.effective_from) leave no overlap and no gap.
// Interface expected from the writer — SEAMS (rules are the snake_case DB rows; `at` is a Date or an ISO string):
//   export function surchargeAmountPaisa(rule: { amount_kind: 'flat'|'percent'; amount_paisa?: number|null; percent_bp?: number|null }, unitPricePaisa: number): number
//   export function pickSurchargeRule<R>(rules: readonly R[], q: { orderableId: string; departmentId?: string|null; priceListId?: string|null; at: Date|string }): R | undefined
//   export function windowsOverlap(a: { effective_from: Date|string; effective_to?: Date|string|null }, b: {...same}): boolean
// Invalid numeric input (non-integer / negative price, bp outside 1..100000, unknown amount_kind, flat without amount, percent without bp) throws — never returns NaN or a silent 0.
import { describe, expect, it } from 'vitest';
import { pickSurchargeRule, surchargeAmountPaisa, windowsOverlap } from '../surcharge.js';

const D1 = '0190c300-0000-7000-8000-000000000101';
const D2 = '0190c300-0000-7000-8000-000000000102';
const O1 = '0190c300-0000-7000-8000-000000001001';
const O2 = '0190c300-0000-7000-8000-000000001002';
const L1 = '0190c300-0000-7000-8000-000000000a01';
const L2 = '0190c300-0000-7000-8000-000000000a02';
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-06-01T00:00:00.000Z';
const T2 = '2026-12-01T00:00:00.000Z';

describe('surchargeAmountPaisa: golden rounding (AC-14.1, AC-14.3, 02-CV §4.9)', () => {
  const pct = (bp: number) => ({ amount_kind: 'percent' as const, percent_bp: bp, amount_paisa: null });
  // [unit price in paisa, percent_bp, expected paisa, why]
  const GOLDEN: Array<[number, number, number, string]> = [
    [90_000, 5_000, 45_000, 'AC-14.1: 50 % of NPR 900.00'],
    [1, 5_000, 1, '0.5 rounds UP (half-up), not to even'],
    [3, 5_000, 2, '1.5 -> 2'],
    [5, 1_000, 1, '0.5 -> 1'],
    [15, 1_000, 2, '1.5 -> 2'],
    [25, 1_000, 3, '2.5 -> 3 (banker\'s rounding would give 2)'],
    [35, 1_000, 4, '3.5 -> 4'],
    [101, 5_000, 51, '50.5 -> 51'],
    [250, 3_500, 88, '87.5 -> 88'],
    [999, 1_250, 125, '124.875 -> 125'],
    [33, 3_333, 11, '10.9989 -> 11'],
    [1, 4_999, 0, '0.4999 -> 0 (below half)'],
    [1, 1, 0, '0.0001 -> 0'],
    [100, 1, 0, '0.01 -> 0'],
    [10_000, 1, 1, 'exactly 1 paisa'],
    [0, 5_000, 0, 'a zero price has a zero surcharge'],
    [90_000, 10_000, 90_000, '100 %'],
    [90_000, 100_000, 900_000, 'maximum 1000 %'],
    [999_999_999, 100_000, 9_999_999_990, 'maximum price x maximum bp stays exact (< 2^53)'],
    [999_999_999, 1, 100_000, '999,999,999 x 1 / 10000 = 99,999.9999 -> 100000'],
    [145, 1_000, 15, '14.5 -> 15 (float traps: 145 * 0.1)'],
    [1_005, 100, 10, '10.05 -> 10'],
    [1_015, 100, 10, '10.15 -> 10'],
    [1_025, 200, 21, '20.5 -> 21'],
  ];
  it.each(GOLDEN)('%d paisa x %d bp = %d (%s)', (unit, bp, expected) => {
    expect(surchargeAmountPaisa(pct(bp), unit)).toBe(expected);
  });
  it('the result is always a safe integer', () => {
    for (const [unit, bp] of GOLDEN) { const r = surchargeAmountPaisa(pct(bp), unit); expect(Number.isSafeInteger(r)).toBe(true); }
  });
  it('flat: amount_paisa verbatim, independent of the unit price', () => {
    expect(surchargeAmountPaisa({ amount_kind: 'flat', amount_paisa: 12_345, percent_bp: null }, 90_000)).toBe(12_345);
    expect(surchargeAmountPaisa({ amount_kind: 'flat', amount_paisa: 12_345 }, 0)).toBe(12_345);
    expect(surchargeAmountPaisa({ amount_kind: 'flat', amount_paisa: 1 }, 999_999_999)).toBe(1);
  });
  it('bigint-as-string amounts from node-pg (bigint column) are not silently coerced into NaN', () => {
    // node-pg returns bigint columns as strings; the domain function either handles them correctly or throws — it never returns NaN
    let r: number | undefined;
    try { r = surchargeAmountPaisa({ amount_kind: 'flat', amount_paisa: '12345' as unknown as number }, 100); } catch { r = undefined; }
    if (r !== undefined) expect(r).toBe(12_345);
  });
  it.each([
    ['fractional price', { amount_kind: 'percent', percent_bp: 5_000 }, 90_000.5],
    ['negative price', { amount_kind: 'percent', percent_bp: 5_000 }, -1],
    ['NaN price', { amount_kind: 'percent', percent_bp: 5_000 }, Number.NaN],
    ['Infinity price', { amount_kind: 'percent', percent_bp: 5_000 }, Number.POSITIVE_INFINITY],
    ['bp 0', { amount_kind: 'percent', percent_bp: 0 }, 100],
    ['bp 100001', { amount_kind: 'percent', percent_bp: 100_001 }, 100],
    ['fractional bp', { amount_kind: 'percent', percent_bp: 50.5 }, 100],
    ['percent without bp', { amount_kind: 'percent' }, 100],
    ['flat without amount', { amount_kind: 'flat' }, 100],
    ['flat with 0', { amount_kind: 'flat', amount_paisa: 0 }, 100],
    ['unknown kind', { amount_kind: 'tiered', percent_bp: 5_000 }, 100],
  ])('throws on %s', (_n, rule, unit) => {
    expect(() => surchargeAmountPaisa(rule as never, unit as number)).toThrow();
  });
});

describe('pickSurchargeRule: specificity, list scope, effective window (02-TRD §7.5; AC-14.2, AC-14.4)', () => {
  const rule = (id: string, o: Record<string, unknown> = {}) => ({ id, scope: 'all', department_id: null, orderable_id: null, price_list_id: null, effective_from: T0, effective_to: null, is_active: true, ...o });
  const ALL = rule('all');
  const DEPT = rule('dept', { scope: 'department', department_id: D1 });
  const ORD = rule('ord', { scope: 'orderable', orderable_id: O1 });
  const q = (o: Record<string, unknown> = {}) => ({ orderableId: O1, departmentId: D1, priceListId: L1, at: new Date('2026-07-01T00:00:00Z'), ...o });
  const id = (r: { id: string } | undefined) => r?.id;

  it('AC-14.2: orderable > department > all', () => {
    expect(id(pickSurchargeRule([ALL, DEPT, ORD], q()))).toBe('ord');
    expect(id(pickSurchargeRule([ALL, DEPT], q()))).toBe('dept');
    expect(id(pickSurchargeRule([ALL], q()))).toBe('all');
  });
  it('the result does not depend on the input order', () => {
    for (const perm of [[ALL, DEPT, ORD], [ORD, DEPT, ALL], [DEPT, ORD, ALL], [ALL, ORD, DEPT]]) expect(id(pickSurchargeRule(perm, q()))).toBe('ord');
  });
  it('AC-14.4: no rule matches -> undefined (not an error)', () => {
    expect(pickSurchargeRule([], q())).toBeUndefined();
    expect(pickSurchargeRule([rule('o2', { scope: 'orderable', orderable_id: O2 })], q())).toBeUndefined();
    expect(pickSurchargeRule([rule('d2', { scope: 'department', department_id: D2 })], q())).toBeUndefined();
  });
  it('a department rule never applies to an orderable without a department (panel without department_id), but an `all` rule does', () => {
    expect(pickSurchargeRule([DEPT], q({ departmentId: null }))).toBeUndefined();
    expect(pickSurchargeRule([DEPT], q({ departmentId: undefined }))).toBeUndefined();
    expect(id(pickSurchargeRule([DEPT, ALL], q({ departmentId: null })))).toBe('all');
  });
  it('AC-14.2: a rule scoped to the winning price list beats an unscoped rule of the SAME specificity', () => {
    const scoped = rule('dept-l1', { scope: 'department', department_id: D1, price_list_id: L1 });
    expect(id(pickSurchargeRule([DEPT, scoped], q()))).toBe('dept-l1');
    expect(id(pickSurchargeRule([scoped, DEPT], q()))).toBe('dept-l1');
    const scopedAll = rule('all-l1', { price_list_id: L1 });
    expect(id(pickSurchargeRule([ALL, scopedAll], q()))).toBe('all-l1');
  });
  it('specificity outranks list scope: an unscoped orderable rule beats a list-scoped department rule', () => {
    const scopedDept = rule('dept-l1', { scope: 'department', department_id: D1, price_list_id: L1 });
    expect(id(pickSurchargeRule([scopedDept, ORD], q()))).toBe('ord');
  });
  it('a rule scoped to ANOTHER price list does not apply; with no winning list only unscoped rules apply', () => {
    const other = rule('dept-l2', { scope: 'department', department_id: D1, price_list_id: L2 });
    expect(id(pickSurchargeRule([other], q()))).toBeUndefined();
    expect(id(pickSurchargeRule([other, DEPT], q()))).toBe('dept');
    const scoped = rule('dept-l1', { scope: 'department', department_id: D1, price_list_id: L1 });
    expect(id(pickSurchargeRule([scoped], q({ priceListId: null })))).toBeUndefined();
    expect(id(pickSurchargeRule([scoped, DEPT], q({ priceListId: null })))).toBe('dept');
  });
  it('effective window is half-open: from <= at < to', () => {
    const w = rule('w', { effective_from: T1, effective_to: T2 });
    expect(pickSurchargeRule([w], q({ at: new Date('2026-05-31T23:59:59.999Z') }))).toBeUndefined();
    expect(id(pickSurchargeRule([w], q({ at: T1 })))).toBe('w');
    expect(id(pickSurchargeRule([w], q({ at: new Date('2026-11-30T23:59:59.999Z') })))).toBe('w');
    expect(pickSurchargeRule([w], q({ at: T2 }))).toBeUndefined();
  });
  it('an open-ended rule (effective_to null) stays effective; `at` may be an ISO string', () => {
    expect(id(pickSurchargeRule([ALL], q({ at: '2099-01-01T00:00:00.000Z' })))).toBe('all');
  });
  it('an expired specific rule falls through to the next-most-specific rule that is effective', () => {
    const old = rule('ord-old', { scope: 'orderable', orderable_id: O1, effective_from: T0, effective_to: T1 });
    expect(id(pickSurchargeRule([old, DEPT, ALL], q({ at: new Date('2026-07-01T00:00:00Z') })))).toBe('dept');
    expect(id(pickSurchargeRule([old, DEPT, ALL], q({ at: new Date('2026-03-01T00:00:00Z') })))).toBe('ord-old');
  });
  it('an inactive rule is ignored', () => {
    expect(id(pickSurchargeRule([rule('off', { scope: 'orderable', orderable_id: O1, is_active: false }), ALL], q()))).toBe('all');
  });
  it('does not mutate its input', () => {
    const rules = [ALL, DEPT, ORD]; const copy = JSON.stringify(rules);
    pickSurchargeRule(rules, q());
    expect(JSON.stringify(rules)).toBe(copy);
  });
});

describe('windowsOverlap (02-TRD §7.5 overlap rejection; AC-14.5)', () => {
  const w = (from: string, to?: string | null) => ({ effective_from: from, effective_to: to ?? null });
  it('overlapping bounded windows', () => { expect(windowsOverlap(w(T0, T2), w(T1, '2027-06-01T00:00:00Z'))).toBe(true); });
  it('one contains the other', () => { expect(windowsOverlap(w(T0, '2027-01-01T00:00:00Z'), w(T1, T2))).toBe(true); });
  it('identical windows', () => { expect(windowsOverlap(w(T0, T1), w(T0, T1))).toBe(true); });
  it('adjacent windows (a.to = b.from) do NOT overlap — half-open', () => {
    expect(windowsOverlap(w(T0, T1), w(T1, T2))).toBe(false);
    expect(windowsOverlap(w(T1, T2), w(T0, T1))).toBe(false);
  });
  it('disjoint windows', () => { expect(windowsOverlap(w(T0, T1), w(T2, '2027-06-01T00:00:00Z'))).toBe(false); });
  it('open-ended windows', () => {
    expect(windowsOverlap(w(T0), w(T1))).toBe(true);                       // both open: always overlap
    expect(windowsOverlap(w(T0), w(T1, T2))).toBe(true);                   // open a started before b
    expect(windowsOverlap(w(T1, T2), w(T0))).toBe(true);
    expect(windowsOverlap(w(T2), w(T0, T1))).toBe(false);                  // open window starts after the bounded one ended
    expect(windowsOverlap(w(T0, T1), w(T1))).toBe(false);                  // open successor starting exactly at the predecessor's end
  });
  it('symmetric; accepts Date and ISO string mixed', () => {
    const a = { effective_from: new Date(T0), effective_to: new Date(T2) }; const b = w(T1, null);
    expect(windowsOverlap(a, b)).toBe(windowsOverlap(b, a));
    expect(windowsOverlap(a, b)).toBe(true);
  });
});
