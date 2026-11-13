// C9 T-02 — target statistics, decimal-only (02-TRD §7.6; 08 A17 D-54; 08 R12a). Pure: no DB, no clock, no Rational type.
// [CONV] Relative import until packages/shared-ts exports ./decimal (core/errors.ts precedent, LD-05).
import {
  cmp, div, fromDouble, fromInt, isZero, mul, parseDecimal, roundDp, toDouble, type Decimal,
} from '../../../../../../packages/shared-ts/src/decimal/index.js';

export interface TargetStats {
  n: number; s1: Decimal; s2: Decimal; mean: Decimal; variance: Decimal; sd: Decimal;
  /** R12a: sd passes through an IEEE double (sqrt), so it is rounded to 15 significant digits and inexact. */
  sdInexact: true;
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/**
 * S1, S2 exact (bigint at a common scale); mean and variance one 28-digit half-up division each;
 * sd = sqrt in double, 15 significant digits. RangeError when n < 2 or n < minPoints.
 */
export function targetStats(values: readonly Decimal[], minPoints: number): TargetStats {
  const n = values.length;
  if (n < 2 || n < minPoints) throw new RangeError(`target statistics need n >= max(2, ${minPoints}), got ${n}`);
  const s = Math.max(...values.map((v) => v.s), 0);
  const ms = values.map((v) => v.m * pow10(s - v.s)); // exact integers at scale s
  const s1m = ms.reduce((a, m) => a + m, 0n);
  const s2m = ms.reduce((a, m) => a + m * m, 0n);
  const N = BigInt(n);
  const s1: Decimal = { m: s1m, s };
  const s2: Decimal = { m: s2m, s: 2 * s };
  const mean = div(s1, fromInt(n));
  const variance = div({ m: N * s2m - s1m * s1m, s: 2 * s }, fromInt(N * (N - 1n))); // numerator exact
  const sd = fromDouble(Math.sqrt(toDouble(variance)), 15);
  return { n, s1, s2, mean, variance, sd, sdInexact: true };
}

/** Stored target: half-up to min(decimals + 2, 6) places [CONV]. */
export function storedTarget(stats: TargetStats, decimals: number): { mean: Decimal; sd: Decimal } {
  const p = Math.min(decimals + 2, 6);
  return { mean: roundDp(stats.mean, p), sd: roundDp(stats.sd, p) };
}

/** cv_pct = sd / mean * 100, display only; undefined when mean = 0. */
export function cvPct(mean: Decimal, sd: Decimal): Decimal | undefined {
  return isZero(mean) ? undefined : mul(div(sd, mean), fromInt(100));
}

/** Exact `dev > k*sd`: multiplication only, no division, no double. */
export function exceedsKSd(dev: Decimal, k: number, sd: Decimal): boolean {
  const kd = parseDecimal(String(k));
  if (!kd) throw new RangeError(`k must be a plain decimal number, got ${k}`);
  return cmp(dev, { m: sd.m * kd.m, s: sd.s + kd.s }) === 1;
}
