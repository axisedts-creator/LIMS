// Money (02-TRD §3.3; CV §4.9). Integer paisa only; all intermediates are bigint — no floats.

/** [CONV] local brands until `@lims/contracts/ports/common` exists; re-export them then. */
export type Paisa = number & { readonly __brand: 'Paisa' };
export interface Money { readonly amountPaisa: number; readonly currency: 'NPR' }

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** Throws unless Number.isSafeInteger(n). */
export function paisa(n: number): Paisa {
  if (!Number.isSafeInteger(n)) throw new RangeError(`paisa: not a safe integer: ${String(n)}`);
  return (n === 0 ? 0 : n) as Paisa; // no -0
}

export function money(amountPaisa: number): Money {
  return { amountPaisa: paisa(amountPaisa), currency: 'NPR' };
}

function nonNeg(n: number, what: string): bigint {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what}: must be a safe integer >= 0: ${String(n)}`);
  return BigInt(n);
}

function big(m: Money): bigint {
  return BigInt(paisa(m.amountPaisa));
}

function out(v: bigint): Money {
  if (v > MAX || v < -MAX) throw new RangeError(`money: result outside the safe-integer range: ${v}`);
  return money(Number(v));
}

/** Floor division (bigint `/` truncates toward zero). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}

export function add(...m: Money[]): Money {
  return out(m.reduce((s, x) => s + big(x), 0n));
}

export function sub(a: Money, b: Money): Money {
  return out(big(a) - big(b));
}

/** qty integer >= 0. */
export function mulQty(m: Money, qty: number): Money {
  return out(big(m) * nonNeg(qty, 'qty'));
}

/** Half-up to the paisa: floor((a * bp + 5000) / 10000). 1300 bp = 13% VAT (04 L14). */
export function percentOf(m: Money, basisPoints: number): Money {
  return out(floorDiv(big(m) * nonNeg(basisPoints, 'basisPoints') + 5000n, 10000n));
}

/** Largest remainder; sum(result) === total; remainder ties go to the lowest index [CONV]. */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  const t = big(total);
  if (t < 0n) throw new RangeError('allocate: total must be >= 0');
  if (weights.length === 0) throw new RangeError('allocate: weights must be non-empty');
  const w = weights.map((x) => nonNeg(x, 'weight'));
  const s = w.reduce((a, b) => a + b, 0n);
  if (s === 0n) throw new RangeError('allocate: weights must not all be zero');
  const base = w.map((x) => (t * x) / s);
  const rem = w.map((x) => (t * x) % s);
  let left = t - base.reduce((a, b) => a + b, 0n);
  const order = w.map((_, i) => i).sort((i, j) => (rem[j]! > rem[i]! ? 1 : rem[j]! < rem[i]! ? -1 : i - j));
  for (const i of order) {
    if (left === 0n) break;
    base[i]! += 1n;
    left -= 1n;
  }
  return base.map(out);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  const x = big(a), y = big(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function isZero(m: Money): boolean {
  return big(m) === 0n;
}

function group(int: string, grouping: 'lakh' | 'international'): string {
  if (int.length <= 3) return int;
  if (grouping === 'international') return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + int.slice(-3);
}

/** Display only (wire stays integer paisa). Default `lakh` grouping and `Rs.` [CONV]; negatives as `-Rs. 1.00` [CONV]. */
export function format(m: Money, opts: { grouping?: 'lakh' | 'international'; symbol?: 'Rs.' | 'NPR' } = {}): string {
  const grouping = opts.grouping ?? 'lakh', symbol = opts.symbol ?? 'Rs.';
  if (grouping !== 'lakh' && grouping !== 'international') throw new RangeError(`format: bad grouping ${String(grouping)}`);
  if (symbol !== 'Rs.' && symbol !== 'NPR') throw new RangeError(`format: bad symbol ${String(symbol)}`);
  const v = big(m);
  const s = (v < 0n ? -v : v).toString().padStart(3, '0');
  return `${v < 0n ? '-' : ''}${symbol} ${group(s.slice(0, -2), grouping)}.${s.slice(-2)}`;
}
