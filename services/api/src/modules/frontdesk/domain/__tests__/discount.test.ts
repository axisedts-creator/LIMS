// FD-T02 discount.ts (03-APP-FLOW §2.2 step 6; US-FD-06.1-06.3, US-FD-07.1). All amounts are integer paisa.
// Assumed API: evaluateLimit({grossPaisa, discountPaisa, selfLimitBp, selfLimitPaisa, absoluteMaxBp}) -> 'within_limit'|'approval_required'|'exceeds_limit';
//   computeDiscountPaisa(discount, grossPaisa); allocate(totalPaisa, lineGrossPaisa[]) -> number[] (largest remainder, ties -> lowest index);
//   resolveDiscounts(lines[{id,grossPaisa}], discounts[]) -> { computed: number[], perLine: Record<id, paisa> }; sameDiscounts(a, b).
// Thrown errors carry `.code`.
import { describe, expect, it } from 'vitest';
import { allocate, computeDiscountPaisa, evaluateLimit, resolveDiscounts, sameDiscounts } from '../discount.js';

describe('allocate golden (largest remainder, to the paisa)', () => {
  // [name, total, lineGross, expected]
  const G: Array<[string, number, number[], number[]]> = [
    ['zero total', 0, [100, 200], [0, 0]],
    ['single line takes all', 100, [100], [100]],
    ['even split', 100, [100, 100], [50, 50]],
    ['tie -> lowest index', 1, [100, 100], [1, 0]],
    ['largest remainder wins', 1, [100, 200, 300], [0, 0, 1]],
    ['333/333/334', 100, [333, 333, 334], [33, 33, 34]],
    ['two leftover, equal remainders', 2, [1, 1, 1], [1, 1, 0]],
    ['5 over 3 equal', 5, [10, 10, 10], [2, 2, 1]],
    ['2 lines half', 100, [50000, 50000], [50, 50]],
    ['NPR 2,250 bill, 5 % exact', 11250, [150000, 75000], [7500, 3750]],
    ['3 lines exact', 11250, [80000, 90000, 55000], [4000, 4500, 2750]],
    ['total == gross exact', 7, [1, 2, 4], [1, 2, 4]],
    ['999 over 333/333/334', 999, [333, 333, 334], [333, 333, 333]],
    ['3 over 1/2/4', 3, [1, 2, 4], [0, 1, 2]],
    ['1 over 1/2/4', 1, [1, 2, 4], [0, 0, 1]],
    ['zero-gross line gets zero', 50, [1000, 0, 1000], [25, 0, 25]],
    ['zero-gross line never gets leftover', 1, [0, 5, 5], [0, 1, 0]],
    ['large remainder distribution', 10000, [333333, 333333, 333334], [3333, 3333, 3334]],
    ['99 over 10/20/30/40', 99, [10, 20, 30, 40], [10, 20, 30, 39]],
    ['one paisa one line', 1, [1], [1]],
    ['full discount two 1-paisa lines', 2, [1, 1], [1, 1]],
    ['33 over three equal', 33, [100, 100, 100], [11, 11, 11]],
    ['4 over 3/3/3', 4, [3, 3, 3], [2, 1, 1]],
    ['8 over 3/3/3 (cap respected)', 8, [3, 3, 3], [3, 3, 2]],
    ['beyond 2^53 intermediates need bigint', 123456789, [1_000_000_000, 2_000_000_000], [41152263, 82304526]],
  ];
  it('has at least 20 golden cases', () => expect(G.length).toBeGreaterThanOrEqual(20));
  it.each(G)('%s', (_n, total, lines, expected) => {
    const out = allocate(total, lines);
    expect(out).toEqual(expected);
    expect(out.reduce((a, b) => a + b, 0)).toBe(total);
    out.forEach((v, i) => expect(v).toBeLessThanOrEqual(lines[i]!));
  });
  it('empty lines with zero total -> []', () => expect(allocate(0, [])).toEqual([]));
  it('does not mutate its input', () => {
    const lines = [10, 20, 30];
    allocate(30, lines);
    expect(lines).toEqual([10, 20, 30]);
  });
  it('invariants hold on 500 pseudo-random inputs', () => {
    let s = 12345;
    const rnd = (n: number) => { s = (s * 1103515245 + 12345) % 2147483648; return s % n; };
    for (let k = 0; k < 500; k++) {
      const lines = Array.from({ length: 1 + rnd(8) }, () => rnd(100000));
      const gross = lines.reduce((a, b) => a + b, 0);
      const total = gross === 0 ? 0 : rnd(gross + 1);
      const out = allocate(total, lines);
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
      out.forEach((v, i) => { expect(Number.isInteger(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(lines[i]!); });
      expect(allocate(total, lines)).toEqual(out); // deterministic
    }
  });
  it.each([
    ['total > gross', 11, [5, 5]],
    ['positive total, zero gross', 1, [0, 0]],
    ['positive total, no lines', 1, []],
    ['negative total', -1, [5]],
    ['fractional total', 1.5, [5]],
    ['negative line', 1, [-5, 10]],
    ['fractional line', 1, [2.5, 10]],
  ] as Array<[string, number, number[]]>)('rejects %s', (_n, total, lines) => {
    expect(() => allocate(total, lines)).toThrow();
  });
});

describe('computeDiscountPaisa', () => {
  it('amount kind is returned as is', () => expect(computeDiscountPaisa({ kind: 'amount', amountPaisa: 5000 }, 225000)).toBe(5000));
  it('5 % of NPR 2,250 = 11250', () => expect(computeDiscountPaisa({ kind: 'percent', percentBp: 500 }, 225000)).toBe(11250));
  it('100 % = gross; 0.01 % of 1,000,000 = 100', () => {
    expect(computeDiscountPaisa({ kind: 'percent', percentBp: 10000 }, 123457)).toBe(123457);
    expect(computeDiscountPaisa({ kind: 'percent', percentBp: 1 }, 1_000_000)).toBe(100);
  });
  it('fraction below half a paisa rounds down (1001 * 5 % = 50.05 -> 50)', () => {
    expect(computeDiscountPaisa({ kind: 'percent', percentBp: 500 }, 1001)).toBe(50);
  });
  it('result is always an integer', () => {
    expect(Number.isInteger(computeDiscountPaisa({ kind: 'percent', percentBp: 333 }, 99999))).toBe(true);
  });
  it.each([
    [{ kind: 'percent', percentBp: 0 }],
    [{ kind: 'percent', percentBp: 10001 }],
    [{ kind: 'percent', percentBp: 1.5 }],
    [{ kind: 'amount', amountPaisa: 0 }],
    [{ kind: 'amount', amountPaisa: -5 }],
  ] as const)('rejects invalid discount %j (mirrors discounts__kind__ck)', (d) => {
    expect(() => computeDiscountPaisa(d as never, 1000)).toThrow();
  });
});

describe('evaluateLimit (US-FD-06.1, 07.1)', () => {
  const lim = { selfLimitBp: 1000, selfLimitPaisa: 0, absoluteMaxBp: 10000 };
  const ev = (discountPaisa: number, over: object = {}) => evaluateLimit({ grossPaisa: 100000, discountPaisa, ...lim, ...over });
  it('5 % under 10 % self-limit -> within_limit', () => expect(ev(5000)).toBe('within_limit'));
  it('exactly at the limit -> within_limit; one paisa over -> approval_required', () => {
    expect(ev(10000)).toBe('within_limit');
    expect(ev(10001)).toBe('approval_required');
  });
  it('30 % vs 10 % limit -> approval_required (US-FD-07.1)', () => expect(ev(30000)).toBe('approval_required'));
  it('zero discount is within any limit', () => expect(ev(0, { selfLimitBp: 0 })).toBe('within_limit'));
  it('default limit 0 -> every positive discount needs approval', () => {
    expect(ev(1, { selfLimitBp: 0, selfLimitPaisa: 0 })).toBe('approval_required');
  });
  it('selfLimitPaisa > 0 adds an absolute cap: both limits must hold', () => {
    expect(ev(5000, { selfLimitPaisa: 5000 })).toBe('within_limit');
    expect(ev(5001, { selfLimitPaisa: 5000 })).toBe('approval_required'); // 5.001 % <= 10 % but > paisa cap
  });
  it('selfLimitPaisa = 0 means percent-only', () => expect(ev(9000, { selfLimitPaisa: 0 })).toBe('within_limit'));
  it('above absoluteMaxBp -> exceeds_limit; at it -> approval_required', () => {
    expect(ev(80001, { absoluteMaxBp: 8000 })).toBe('exceeds_limit');
    expect(ev(80000, { absoluteMaxBp: 8000 })).toBe('approval_required');
  });
  it('discount larger than gross -> exceeds_limit even with default absolute max 100 %', () => {
    expect(ev(100001)).toBe('exceeds_limit');
  });
  it('zero gross with positive discount -> exceeds_limit', () => {
    expect(evaluateLimit({ grossPaisa: 0, discountPaisa: 1, ...lim })).toBe('exceeds_limit');
  });
  it('exact integer comparison (no float drift): 33.33 % boundary', () => {
    const o = { selfLimitBp: 3333 };
    expect(evaluateLimit({ grossPaisa: 30000, discountPaisa: 9999, ...lim, ...o })).toBe('within_limit'); // 33.33 %
    expect(evaluateLimit({ grossPaisa: 30000, discountPaisa: 10000, ...lim, ...o })).toBe('approval_required'); // 33.333.. %
  });
});

describe('resolveDiscounts (line + bill allocation; US-FD-06.1, 06.3)', () => {
  const lines = [{ id: 'a', grossPaisa: 150000 }, { id: 'b', grossPaisa: 75000 }];
  it('5 % bill discount is spread pro-rata across lines', () => {
    const r = resolveDiscounts(lines, [{ scope: 'bill', kind: 'percent', percentBp: 500 }]);
    expect(r.computed).toEqual([11250]);
    expect(r.perLine).toEqual({ a: 7500, b: 3750 });
  });
  it('bill discount remainder goes by largest remainder, sum exact', () => {
    const r = resolveDiscounts([{ id: 'a', grossPaisa: 1 }, { id: 'b', grossPaisa: 2 }, { id: 'c', grossPaisa: 4 }], [{ scope: 'bill', kind: 'amount', amountPaisa: 3 }]);
    expect(r.perLine).toEqual({ a: 0, b: 1, c: 2 });
  });
  it('line discount applies to its own line only', () => {
    const r = resolveDiscounts(lines, [{ scope: 'line', lineId: 'b', kind: 'amount', amountPaisa: 5000 }]);
    expect(r.computed).toEqual([5000]);
    expect(r.perLine).toEqual({ a: 0, b: 5000 });
  });
  it('line discount larger than the line amount -> frontdesk.discount_exceeds_limit (US-FD-06.3)', () => {
    expect(() => resolveDiscounts(lines, [{ scope: 'line', lineId: 'b', kind: 'amount', amountPaisa: 75001 }])).toThrow(expect.objectContaining({ code: 'frontdesk.discount_exceeds_limit' }));
  });
  it('line discount equal to the line amount is allowed', () => {
    expect(resolveDiscounts(lines, [{ scope: 'line', lineId: 'b', kind: 'amount', amountPaisa: 75000 }]).perLine.b).toBe(75000);
  });
  it('bill discount larger than the bill -> frontdesk.discount_exceeds_limit', () => {
    expect(() => resolveDiscounts(lines, [{ scope: 'bill', kind: 'amount', amountPaisa: 225001 }])).toThrow(expect.objectContaining({ code: 'frontdesk.discount_exceeds_limit' }));
  });
  it('unknown lineId is rejected', () => {
    expect(() => resolveDiscounts(lines, [{ scope: 'line', lineId: 'zzz', kind: 'amount', amountPaisa: 1 }])).toThrow();
  });
  it('no discounts -> zeros', () => {
    const r = resolveDiscounts(lines, []);
    expect(r.computed).toEqual([]);
    expect(r.perLine).toEqual({ a: 0, b: 0 });
  });
});

describe('sameDiscounts (approval binding, US-FD-07.5)', () => {
  const d = { scope: 'bill', kind: 'percent', percentBp: 3000, reasonCode: 'staff_family' };
  it('equal regardless of object key order', () => {
    expect(sameDiscounts([d], [{ reasonCode: 'staff_family', percentBp: 3000, kind: 'percent', scope: 'bill' }] as never)).toBe(true);
  });
  it('differs on any value, on count', () => {
    expect(sameDiscounts([d], [{ ...d, percentBp: 3001 }] as never)).toBe(false);
    expect(sameDiscounts([d], [] as never)).toBe(false);
    expect(sameDiscounts([d], [d, d] as never)).toBe(false);
  });
  it('empty equals empty', () => expect(sameDiscounts([], [])).toBe(true));
});
