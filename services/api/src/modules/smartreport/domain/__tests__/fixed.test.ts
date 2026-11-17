// C14 T04 — domain/fixed.ts (02-TRD §2 "Decimal handling", §3 tree: "DecimalString ⇄ bigint micro-units; half-up division").
// API pinned by these tests (spec gives no names): toMicro(s: string): bigint · fromMicro(m: bigint): string · divHalfUp(n: bigint, d: bigint): bigint.
import { describe, expect, it } from 'vitest';
import { divHalfUp, fromMicro, toMicro } from '../fixed.js';

describe('toMicro (DecimalString pattern ^-?[0-9]{1,12}(\\.[0-9]{1,6})?$, 03-IC §2.1)', () => {
  it.each([
    ['0', 0n], ['13', 13_000_000n], ['13.4', 13_400_000n], ['13.40', 13_400_000n], ['0.000001', 1n],
    ['-0.5', -500_000n], ['-10', -10_000_000n], ['999999999999.999999', 999_999_999_999_999_999n], ['12.123456', 12_123_456n],
  ])('%s -> %s', (s, v) => expect(toMicro(s)).toBe(v));

  it('-0 and 0.0 are zero', () => {
    expect(toMicro('-0')).toBe(0n);
    expect(toMicro('0.0')).toBe(0n);
  });

  it.each(['', ' 1', '1 ', '+1', '1.', '.5', '1e3', 'NaN', 'Infinity', '1,5', '0x10', '1.1234567', '1234567890123', '--1', '1.2.3', '٣'])(
    'rejects non-DecimalString %j (never silently truncates or coerces)', (s) => {
      expect(() => toMicro(s)).toThrow();
    });
});

describe('fromMicro', () => {
  it.each([
    [0n, '0'], [13_000_000n, '13'], [13_400_000n, '13.4'], [1n, '0.000001'], [-500_000n, '-0.5'], [-1n, '-0.000001'], [12_123_456n, '12.123456'],
  ])('%s -> %s (canonical: no trailing zeros, no trailing dot, no "-0")', (m, s) => expect(fromMicro(m)).toBe(s));

  it('round-trips toMicro for every pattern-valid sample', () => {
    for (const s of ['0', '1', '-1', '0.5', '-0.000001', '999999999999.999999', '-999999999999.999999', '7.25']) {
      expect(fromMicro(toMicro(s))).toBe(s);
    }
  });
});

describe('divHalfUp (non-negative n, positive d; ties round up)', () => {
  it.each([
    [0n, 3n, 0n], [10n, 5n, 2n], [1n, 2n, 1n], [1n, 3n, 0n], [2n, 3n, 1n], [3n, 2n, 2n], [5n, 10n, 1n], [4n, 10n, 0n], [15n, 10n, 2n],
    [16099n, 200n, 80n],   // 80.495 -> 80 (G-06)
    [16100n, 200n, 81n],   // 80.5   -> 81
  ])('%s / %s = %s', (n, d, q) => expect(divHalfUp(n, d)).toBe(q));

  it('exact for values beyond Number.MAX_SAFE_INTEGER (bigint, no float)', () => {
    expect(divHalfUp(300000000000000000001n, 2n)).toBe(150000000000000000001n);   // 1.5e20 + 0.5 -> tie rounds up
    expect(divHalfUp(300000000000000000000n, 7n)).toBe(42857142857142857143n);    // 42857142857142857142.857… -> …143
  });

  it('throws on divisor 0 (and negative divisor — out of contract)', () => {
    expect(() => divHalfUp(1n, 0n)).toThrow();
    expect(() => divHalfUp(1n, -1n)).toThrow();
  });
});
