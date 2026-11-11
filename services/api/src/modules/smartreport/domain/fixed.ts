// Fixed-point helpers (02-TRD §2 "Decimal handling", §3): DecimalString <-> bigint micro-units, half-up division.
// Pure: integer bigint only, no float, no I/O.
const MICRO = 1_000_000n;
// 03-IC §2.1 DecimalString. [0-9] (not \d) so only ASCII digits pass.
const DECIMAL = /^(-?)([0-9]{1,12})(?:\.([0-9]{1,6}))?$/;

/** DecimalString -> micro-units (x 10^6). Throws on anything outside the pattern; never truncates or coerces. */
export function toMicro(s: string): bigint {
  const m = typeof s === 'string' ? DECIMAL.exec(s) : null;
  if (m === null) throw new RangeError(`not a DecimalString: ${JSON.stringify(s)}`);
  const abs = BigInt(m[2]!) * MICRO + BigInt((m[3] ?? '').padEnd(6, '0'));
  return m[1] === '-' ? -abs : abs;
}

/** micro-units -> canonical DecimalString (no trailing zeros, no trailing dot, no "-0"). */
export function fromMicro(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const frac = (abs % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${abs / MICRO}${frac === '' ? '' : `.${frac}`}`;
}

/** round-half-up(n / d) for n >= 0, d > 0 (ties round up). */
export function divHalfUp(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError('divHalfUp: divisor must be > 0');
  if (n < 0n) throw new RangeError('divHalfUp: dividend must be >= 0');
  return (2n * n + d) / (2n * d);
}
