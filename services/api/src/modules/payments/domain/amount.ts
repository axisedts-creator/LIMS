// C15 amounts: exact decimal only, no floats (02-CV §4.9, REQ-SEC-048). TRD §7.2.3 formatRupees, §7.2.4 decimal parse, 04 P4 Khalti minimum.
import { LimsError } from '../../../core/errors.js';

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const KHALTI_MIN_PAISA = 1000;

/** Gateway decimal rupee text -> integer paisa. undefined = not a decimal, > 2 non-zero fraction digits, or beyond safe-integer range. */
export function rupeesTextToPaisa(text: string): number | undefined {
  const m = typeof text === 'string' ? DECIMAL.exec(text) : null;
  if (!m) return undefined;
  const frac = m[2] ?? '';
  if (/[1-9]/.test(frac.slice(2))) return undefined;
  const paisa = BigInt(m[1]!) * 100n + BigInt(frac.slice(0, 2).padEnd(2, '0'));
  return paisa > MAX ? undefined : Number(paisa);
}

const unsupported = (): LimsError => new LimsError('payments.amount_not_supported');
const isPositivePaisa = (p: number): boolean => Number.isSafeInteger(p) && p > 0;

/** Paisa -> eSewa amount string. Whole rupees only until fractional amounts are verified (allowFractional). */
export function formatRupees(paisa: number, opts: { allowFractional?: boolean } = {}): string {
  if (!isPositivePaisa(paisa)) throw unsupported();
  const rupees = Math.floor(paisa / 100);
  const rest = paisa % 100;
  if (rest === 0) return String(rupees);
  if (!opts.allowFractional) throw unsupported();
  return `${rupees}.${String(rest).padStart(2, '0')}`;
}

export function assertAmountSupported(gateway: 'esewa' | 'khalti', paisa: number): void {
  if (!isPositivePaisa(paisa)) throw unsupported();
  if (gateway === 'khalti' && paisa < KHALTI_MIN_PAISA) throw unsupported();
}
