// C9 T-02 — target statistics on the shared decimal (02-TRD §7.6; 08 A17 D-54; 08 R12a). Pure module, no DB, no clock.
// done_when: decimal-only maths: S1,S2 exact; one division each for mean and variance (28 digits half-up); sqrt in double rounded to 15
//   significant digits and marked inexact; stored mean/sd rounded half-up to decimals+2 (<= 6); n < 2 always fails, n < target_min_points fails;
//   exact `dev > k*sd` compare (no division); no Rational type. AC-04.2 (establish-from-data mean = arithmetic mean, sd = sample sd, n-1).
// Expected values below were computed independently with Python decimal (prec 28, ROUND_HALF_UP) and math.sqrt, not with the module under test.
// Interface expected from the writer (../target-stats.ts). Seams the spec does not fix are marked SEAM:
//   import { Decimal } from '@lims/shared-ts/decimal' — until the package export exists services/api imports it relatively
//   (core/errors.ts precedent, LD-05): '../../../../../../packages/shared-ts/src/decimal/index.js'.
//   targetStats(values: readonly Decimal[], minPoints: number): TargetStats                                  (SEAM: names)
//     TargetStats = { n: number; s1: Decimal; s2: Decimal; mean: Decimal; variance: Decimal; sd: Decimal; sdInexact: true }
//     throws RangeError when n < 2 (whatever minPoints) or n < minPoints; the service maps that to a 4xx.
//   storedTarget(stats, decimals: number): { mean: Decimal; sd: Decimal }   rounds half-up to min(decimals + 2, 6) places
//   cvPct(mean: Decimal, sd: Decimal): Decimal | undefined               sd / mean * 100; undefined when mean = 0
//   exceedsKSd(dev: Decimal, k: number, sd: Decimal): boolean            exact dev > k*sd (no division, no double)
import { describe, expect, it } from 'vitest';
import {
  cmp, fromInt, parseDecimal, toDecimalString, type Decimal,
} from '../../../../../../../packages/shared-ts/src/decimal/index.js';
import { cvPct, exceedsKSd, storedTarget, targetStats } from '../target-stats.js';

const D = (s: string): Decimal => {
  const d = parseDecimal(s);
  if (!d) throw new Error(`bad decimal literal ${s}`);
  return d;
};
const eq = (actual: Decimal, expected: string): void => {
  expect(cmp(actual, D(expected)), `${toDecimalString(actual)} != ${expected}`).toBe(0);
};

// 20 synthetic control values (analyte decimals = 1), n = 20 = default settings.target_min_points.
const GOLDEN = ['98.4', '101.2', '99.7', '100.5', '102.1', '97.9', '100.3', '99.1', '101.8', '98.8',
  '100.0', '100.9', '99.4', '101.5', '98.2', '100.7', '99.9', '102.4', '97.6', '100.1'].map(D);

describe('targetStats golden (20 synthetic values, TRD 7.6)', () => {
  const st = targetStats(GOLDEN, 20);

  it('pins n, S1 and S2 exactly', () => {
    expect(st.n).toBe(20);
    eq(st.s1, '2000.5');
    eq(st.s2, '200137.43');
  });
  it('mean = S1/n and sample variance (n-1) with one 28-digit division each', () => {
    eq(st.mean, '100.025');
    eq(st.variance, '1.969342105263157894736842105'); // (20*S2 - S1^2) / (20*19) = 748.35 / 380, 28 sig digits half-up
  });
  it('sd = sqrt(variance) in double rounded to 15 significant digits, marked inexact', () => {
    eq(st.sd, '1.40333249989557');
    expect(st.sdInexact).toBe(true);
  });
  it('stored mean/sd round half-up to decimals+2 places (decimals = 1 -> 3 dp)', () => {
    const s = storedTarget(st, 1);
    eq(s.mean, '100.025');
    eq(s.sd, '1.403');
    expect(toDecimalString(s.sd)).toBe('1.403');
  });
  it('stored rounding is half-up, not banker: decimals = 0 -> 2 dp, 100.025 -> 100.03', () => {
    const s = storedTarget(st, 0);
    expect(toDecimalString(s.mean)).toBe('100.03');
    expect(toDecimalString(s.sd)).toBe('1.40');
  });
  it('stored places are capped at 6: decimals = 5 and 9 both give 6 dp', () => {
    for (const dec of [5, 9]) {
      const s = storedTarget(st, dec);
      eq(s.mean, '100.025');
      expect(toDecimalString(s.sd)).toBe('1.403332');
    }
  });
  it('input order does not change any statistic', () => {
    const r = targetStats([...GOLDEN].reverse(), 20);
    expect(cmp(r.s1, st.s1)).toBe(0);
    expect(cmp(r.s2, st.s2)).toBe(0);
    expect(cmp(r.mean, st.mean)).toBe(0);
    expect(cmp(r.variance, st.variance)).toBe(0);
    expect(cmp(r.sd, st.sd)).toBe(0);
  });
  it('does not mutate its input', () => {
    const copy = GOLDEN.map((d) => ({ ...d }));
    targetStats(GOLDEN, 20);
    expect(GOLDEN).toEqual(copy);
  });
});

describe('targetStats exactness and rounding edges', () => {
  it('sums are exact where IEEE doubles drift (ten 0.1 + ten 0.2)', () => {
    const vs = [...Array(10).fill('0.1'), ...Array(10).fill('0.2')].map(D);
    const st = targetStats(vs, 20);
    eq(st.s1, '3');
    eq(st.s2, '0.5');
    eq(st.mean, '0.15');
    eq(st.variance, '0.002631578947368421052631578947'); // 1/380 at 28 sig digits
    eq(st.sd, '0.0512989176042577'); // 15 significant digits
  });
  it('mean division rounds half-up at 28 significant digits ([1,1,0] -> 0.666...67)', () => {
    const st = targetStats([D('1'), D('1'), D('0')], 2);
    eq(st.mean, '0.6666666666666666666666666667');
    eq(st.variance, '0.3333333333333333333333333333');
    eq(st.sd, '0.577350269189626');
  });
  it('negative values and a zero mean: sd of [-1, 1] is sqrt(2) to 15 digits', () => {
    const st = targetStats([D('-1'), D('1')], 2);
    eq(st.mean, '0');
    eq(st.sd, '1.4142135623731');
  });
  it('identical values give variance 0 and sd 0 (never NaN)', () => {
    const st = targetStats([D('5.5'), D('5.5'), D('5.5')], 3);
    eq(st.variance, '0');
    eq(st.sd, '0');
    eq(st.mean, '5.5');
  });
  it('n = minPoints is accepted (boundary), n = minPoints - 1 is rejected', () => {
    expect(() => targetStats(GOLDEN, 20)).not.toThrow();
    expect(() => targetStats(GOLDEN.slice(0, 19), 20)).toThrow(RangeError);
  });
  it('n < 2 always fails, even when minPoints is 0, 1 or negative', () => {
    for (const mp of [0, 1, -5]) {
      expect(() => targetStats([], mp)).toThrow(RangeError);
      expect(() => targetStats([D('1')], mp)).toThrow(RangeError);
    }
    expect(() => targetStats([D('1'), D('2')], 1)).not.toThrow();
  });
});

describe('cvPct (display only)', () => {
  it('sd / mean * 100', () => eq(cvPct(D('100'), D('2'))!, '2'));
  it('mean = 0 is omitted', () => expect(cvPct(D('0'), D('2'))).toBeUndefined());
});

describe('exceedsKSd: exact dev > k*sd with no division and no double', () => {
  it('strictly greater only: equality is not an exceedance', () => {
    expect(exceedsKSd(D('0.3'), 3, D('0.1'))).toBe(false);
    expect(exceedsKSd(D('0.4'), 3, D('0.1'))).toBe(true);
  });
  it('one unit in the 19th place decides, which a double cannot see', () => {
    expect(exceedsKSd(D('0.3000000000000000001'), 3, D('0.1'))).toBe(true);
    expect(exceedsKSd(D('0.2999999999999999999'), 3, D('0.1'))).toBe(false);
  });
  it('negative dev never exceeds the positive bound; sd = 0 means any positive dev exceeds', () => {
    expect(exceedsKSd(D('-9'), 1, D('1'))).toBe(false);
    expect(exceedsKSd(D('0.0000001'), 2, D('0'))).toBe(true);
    expect(exceedsKSd(fromInt(0), 2, D('0'))).toBe(false);
  });
});
