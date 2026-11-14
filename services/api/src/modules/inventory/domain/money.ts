// C12 money (02-TRD §4.2; AC-05.1). Integer paisa as safe JS integers; all intermediates BigInt; round half up.
import { LimsError } from '../../../core/errors.js';
import { fracDigits, parsePackQty, scaled } from './quantity.js';

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const fail = (msg: string): never => {
  throw new LimsError('common.validation_failed', msg);
};
const nonNegInt = (v: unknown, what: string): bigint =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : fail(`${what} must be a non-negative safe integer`);
const safe = (v: bigint, what: string): number => (v > MAX ? fail(`${what} exceeds 2^53-1`) : Number(v));
/** round_half_up(n / d) for n ≥ 0, d > 0. */
const divHalfUp = (n: bigint, d: bigint): bigint => (n + d / 2n) / d;

export interface LineInput { qtyPacks: string; unitPricePaisa: number; discountPaisa: number; taxRateBp: number }
export interface LineAmounts { grossPaisa: number; netPaisa: number; vatPaisa: number; totalPaisa: number }

export function computeLine(i: LineInput): LineAmounts {
  parsePackQty(i.qtyPacks);
  const price = nonNegInt(i.unitPricePaisa, 'unit price');
  const disc = nonNegInt(i.discountPaisa, 'discount');
  const bp = nonNegInt(i.taxRateBp, 'tax rate');
  const f = fracDigits(i.qtyPacks);
  const gross = divHalfUp(scaled(i.qtyPacks, f) * price, 10n ** BigInt(f));
  if (disc > gross) fail('discount exceeds gross'); // rejected, never clamped (§4.2)
  const net = gross - disc;
  const vat = divHalfUp(net * bp, 10000n);
  return { grossPaisa: safe(gross, 'gross'), netPaisa: safe(net, 'net'), vatPaisa: safe(vat, 'vat'), totalPaisa: safe(net + vat, 'total') };
}

export interface TotalsInput extends LineAmounts { discountPaisa: number }
export interface Totals { subtotalPaisa: number; discountPaisa: number; netPaisa: number; vatPaisa: number; totalPaisa: number }

/** Header totals = sums of the lines (VAT is rounded per line, never on the sum). */
export function computeTotals(lines: readonly TotalsInput[]): Totals {
  const sum = (f: (l: TotalsInput) => number, what: string): number =>
    safe(lines.reduce((s, l) => s + nonNegInt(f(l), what), 0n), what);
  return {
    subtotalPaisa: sum((l) => l.grossPaisa, 'subtotal'),
    discountPaisa: sum((l) => l.discountPaisa, 'discount'),
    netPaisa: sum((l) => l.netPaisa, 'net'),
    vatPaisa: sum((l) => l.vatPaisa, 'vat'),
    totalPaisa: sum((l) => l.totalPaisa, 'total'),
  };
}

/** capitalised_value = net + (vat if settings.vat_in_cost). */
export function capitalisedValuePaisa(l: { netPaisa: number; vatPaisa: number }, vatInCost: boolean): number {
  return safe(nonNegInt(l.netPaisa, 'net') + (vatInCost ? nonNegInt(l.vatPaisa, 'vat') : 0n), 'capitalised value');
}
