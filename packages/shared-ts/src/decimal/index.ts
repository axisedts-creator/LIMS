// @lims/shared-ts/decimal (02-TRD §3.1; 08 R12a): exact decimal, >= 28 significant digits, half-up.
// [CONV] Implementation is bigint (ECMAScript stdlib) — no third-party library, so no pin or licence check is needed.
// A value is m × 10^-s (m: bigint, s: integer scale; s < 0 means trailing zeros). Rounding is half away from zero.

export interface Decimal { readonly m: bigint; readonly s: number }

/** Significant digits kept by mul/div/pow and add/sub (decimal.js-style precision). */
export const PRECISION = 28;
/** [CONV] |adjusted exponent| above this is an overflow; callers turn it into `domain_error`. */
export const MAX_EXP = 1000;

const DEC_RE = /^-?\d+(\.\d+)?$/; // contracts/openapi/_common.yaml DecimalString
const TEN = 10n;
const pow10 = (n: number): bigint => TEN ** BigInt(n);
const absBig = (x: bigint): bigint => (x < 0n ? -x : x);
const digits = (x: bigint): number => (x === 0n ? 1 : absBig(x).toString().length);

export const ZERO: Decimal = { m: 0n, s: 0 };
export const ONE: Decimal = { m: 1n, s: 0 };

/** Parse a plain decimal string (`^-?\d+(\.\d+)?$`). Returns undefined for anything else. */
export function parseDecimal(str: string): Decimal | undefined {
  if (typeof str !== 'string' || !DEC_RE.test(str)) return undefined;
  const dot = str.indexOf('.');
  if (dot < 0) return { m: BigInt(str), s: 0 };
  return { m: BigInt(str.slice(0, dot) + str.slice(dot + 1)), s: str.length - dot - 1 };
}

export const fromInt = (n: bigint | number): Decimal => ({ m: BigInt(n), s: 0 });

/** Plain decimal string (never exponent notation). */
export function toDecimalString(d: Decimal): string {
  if (d.s <= 0) return (d.m * pow10(-d.s)).toString();
  const neg = d.m < 0n;
  const t = absBig(d.m).toString().padStart(d.s + 1, '0');
  return `${neg ? '-' : ''}${t.slice(0, -d.s)}.${t.slice(-d.s)}`;
}

/** Integer division of x by 10^k, rounded half away from zero (k >= 0). */
function divPow10HalfUp(x: bigint, k: number): bigint {
  if (k <= 0) return x * pow10(-k);
  const p = pow10(k);
  const a = absBig(x);
  let q = a / p;
  if ((a % p) * 2n >= p) q += 1n;
  return x < 0n ? -q : q;
}

/** Round to `p` significant digits, half-up. */
export function roundSig(d: Decimal, p: number = PRECISION): Decimal {
  const drop = digits(d.m) - p;
  if (drop <= 0) return d;
  return { m: divPow10HalfUp(d.m, drop), s: d.s - drop };
}

/** Round to `n` decimal places, half-up (only ever removes places). */
export function roundDp(d: Decimal, n: number): Decimal {
  return d.s <= n ? d : { m: divPow10HalfUp(d.m, d.s - n), s: n };
}

const align = (a: Decimal, b: Decimal): [bigint, bigint, number] => {
  const s = Math.max(a.s, b.s);
  return [a.m * pow10(s - a.s), b.m * pow10(s - b.s), s];
};

export const isZero = (d: Decimal): boolean => d.m === 0n;
export const isNeg = (d: Decimal): boolean => d.m < 0n;
export const neg = (d: Decimal): Decimal => ({ m: -d.m, s: d.s });
export const abs = (d: Decimal): Decimal => ({ m: absBig(d.m), s: d.s });

/** -1, 0, 1 — exact. */
export function cmp(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function add(a: Decimal, b: Decimal): Decimal {
  const [x, y, s] = align(a, b);
  return roundSig({ m: x + y, s });
}
export const sub = (a: Decimal, b: Decimal): Decimal => add(a, neg(b));
export const mul = (a: Decimal, b: Decimal): Decimal => roundSig({ m: a.m * b.m, s: a.s + b.s });

/** a / b to PRECISION significant digits, half-up. Throws RangeError on b = 0. */
export function div(a: Decimal, b: Decimal): Decimal {
  if (b.m === 0n) throw new RangeError('decimal: division by zero');
  if (a.m === 0n) return ZERO;
  // Scale the dividend so the truncated quotient has >= PRECISION + 1 digits; then round.
  const k = Math.max(0, PRECISION + 1 - (digits(a.m) - digits(b.m)) + 1);
  const q = (a.m * pow10(k)) / b.m; // truncation is safe: half-up only needs the first dropped digit
  return roundSig({ m: q, s: a.s - b.s + k });
}

export const isInteger = (d: Decimal): boolean => d.s <= 0 || d.m % pow10(d.s) === 0n;

/** Integer part of an integer-valued decimal. */
export const toBigInt = (d: Decimal): bigint => (d.s <= 0 ? d.m * pow10(-d.s) : d.m / pow10(d.s));

/** Adjusted exponent: floor(log10(|d|)) for d != 0. */
export const adjExp = (d: Decimal): number => digits(d.m) - 1 - d.s;

/** True when |d| is outside 10^±MAX_EXP (zero is in range). */
export const outOfRange = (d: Decimal): boolean => d.m !== 0n && Math.abs(adjExp(d)) > MAX_EXP;

/** base^n for integer n, square-and-multiply at PRECISION. Throws RangeError on 0^negative or overflow. */
export function powInt(base: Decimal, n: bigint): Decimal {
  if (n < 0n) {
    if (base.m === 0n) throw new RangeError('decimal: division by zero');
    return div(ONE, powInt(base, -n));
  }
  let r = ONE;
  let b = base;
  let e = n;
  while (e > 0n) {
    if (e & 1n) r = mul(r, b);
    e >>= 1n;
    if (e > 0n) b = mul(b, b);
    if (outOfRange(r) || outOfRange(b)) throw new RangeError('decimal: overflow');
  }
  return r;
}

/** IEEE-754 double nearest to d (may be ±Infinity or 0 for out-of-range values). */
export const toDouble = (d: Decimal): number => Number(toDecimalString(d));

/** Finite double -> decimal rounded to `sig` significant digits. Throws RangeError on non-finite input. */
export function fromDouble(x: number, sig: number): Decimal {
  if (!Number.isFinite(x)) throw new RangeError('decimal: non-finite');
  const [mant = '0', exp = '0'] = x.toExponential(sig - 1).split('e'); // "-1.41421356237310e+0"
  const d = parseDecimal(mant);
  if (!d) throw new RangeError(`decimal: unexpected double form ${mant}`);
  return strip({ m: d.m, s: d.s - Number(exp) });
}

/** Remove trailing zeros from the coefficient while s > 0. */
export function strip(d: Decimal): Decimal {
  let { m, s } = d;
  if (m === 0n) return ZERO;
  while (s > 0 && m % TEN === 0n) { m /= TEN; s--; }
  return { m, s };
}
