// Line tax, bill discount and credit-note split (04 L14: 13 % VAT half-up to the paisa; US-BL-14.1-14.4; 03-APP-FLOW B5). Integer paisa, bigint intermediates. Pure.
import { allocate, money, percentOf } from '../../../../../../../packages/shared-ts/src/money/index.js';
import { LimsError } from '../../../../core/errors.js';

export type VatTreatment = 'taxable' | 'exempt';
export interface LineInput {
  readonly grossPaisa: number; readonly discountPaisa: number; readonly vatTreatment: VatTreatment;
  /** NULL iff exempt (invoice_lines__vat__ck). */
  readonly vatRateBp: number | null;
  readonly otherTaxCode?: string; readonly otherTaxRateBp?: number;
}
export interface LineAmounts {
  readonly grossPaisa: number; readonly discountPaisa: number; readonly exemptPaisa: number; readonly taxablePaisa: number;
  readonly vatPaisa: number; readonly otherTaxPaisa: number; readonly netPaisa: number;
}

const invalid = (detail: string): LimsError => new LimsError('common.validation_failed', detail);
const isPaisa = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isBp = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 10000;
const KEYS = ['grossPaisa', 'discountPaisa', 'exemptPaisa', 'taxablePaisa', 'vatPaisa', 'otherTaxPaisa', 'netPaisa'] as const;
const pct = (paisa: number, bp: number): number => percentOf(money(paisa), bp).amountPaisa;

export function computeLine(l: LineInput): LineAmounts {
  if (!isPaisa(l.grossPaisa) || !isPaisa(l.discountPaisa)) throw invalid('amounts must be integer paisa >= 0');
  if (l.discountPaisa > l.grossPaisa) throw invalid('discount exceeds gross');
  const base = l.grossPaisa - l.discountPaisa;
  let vatPaisa = 0;
  if (l.vatTreatment === 'taxable') {
    // 08 R18: a rate is never guessed.
    if (l.vatRateBp === null || l.vatRateBp === undefined) throw new LimsError('catalog.tax_config_missing');
    if (!isBp(l.vatRateBp)) throw invalid('vatRateBp must be 0..10000');
    vatPaisa = pct(base, l.vatRateBp);
  } else if (l.vatTreatment === 'exempt') {
    if (l.vatRateBp !== null && l.vatRateBp !== undefined) throw invalid('exempt line carries no VAT rate');
  } else throw invalid('unknown vatTreatment');
  const taxablePaisa = l.vatTreatment === 'taxable' ? base : 0;
  const hasCode = l.otherTaxCode !== undefined && l.otherTaxCode !== null;
  const hasRate = l.otherTaxRateBp !== undefined && l.otherTaxRateBp !== null;
  if (hasCode !== hasRate) throw invalid('otherTaxCode and otherTaxRateBp go together');
  if (hasCode && (typeof l.otherTaxCode !== 'string' || l.otherTaxCode === '' || !isBp(l.otherTaxRateBp))) throw invalid('invalid other tax');
  // [CONV] other tax base = taxable amount, half-up (tester ruling; spec silent).
  const otherTaxPaisa = hasRate ? pct(taxablePaisa, l.otherTaxRateBp!) : 0;
  const exemptPaisa = base - taxablePaisa;
  return {
    grossPaisa: l.grossPaisa, discountPaisa: l.discountPaisa, exemptPaisa, taxablePaisa, vatPaisa, otherTaxPaisa,
    netPaisa: exemptPaisa + taxablePaisa + vatPaisa + otherTaxPaisa,
  };
}

/** Pro-rata over `bases`, largest remainder, ties -> lowest index; a share never exceeds its base. */
export function allocateBillDiscount(bases: readonly number[], billDiscountPaisa: number): number[] {
  if (!isPaisa(billDiscountPaisa) || bases.length === 0 || !bases.every(isPaisa)) throw invalid('amounts must be integer paisa >= 0');
  if (BigInt(billDiscountPaisa) > bases.reduce((a, b) => a + BigInt(b), 0n)) throw invalid('bill discount exceeds the remaining amount');
  if (billDiscountPaisa === 0) return bases.map(() => 0);
  return allocate(money(billDiscountPaisa), bases).map((m) => m.amountPaisa);
}

/** [CONV] VAT rounded per line then summed; bill discount weighted by the amount left after line discounts. */
export function computeInvoiceTotals(x: { lines: readonly LineInput[]; billDiscountPaisa?: number }): { lines: LineAmounts[]; totals: LineAmounts } {
  if (!Array.isArray(x.lines) || x.lines.length === 0) throw invalid('invoice needs at least one line');
  const first = x.lines.map(computeLine); // validates every line before allocating
  const shares = allocateBillDiscount(first.map((l) => l.grossPaisa - l.discountPaisa), x.billDiscountPaisa ?? 0);
  const lines = x.lines.map((l, i) => (shares[i] === 0 ? first[i]! : computeLine({ ...l, discountPaisa: l.discountPaisa + shares[i]! })));
  const totals = Object.fromEntries(KEYS.map((k) => [k, lines.reduce((s, l) => s + l[k], 0)])) as unknown as LineAmounts;
  for (const k of KEYS) if (!Number.isSafeInteger(totals[k])) throw invalid('invoice total out of range');
  return { lines, totals };
}

/** Credit-note components for `creditNetPaisa` of `line`: net split over exempt/taxable/vat/other by largest remainder
 *  (ties -> lowest index); discount follows the base half-up, gross = base + discount. */
export function splitCredit(line: LineAmounts, creditNetPaisa: number): LineAmounts {
  if (!KEYS.every((k) => isPaisa(line[k])) || line.netPaisa !== line.exemptPaisa + line.taxablePaisa + line.vatPaisa + line.otherTaxPaisa
    || line.grossPaisa - line.discountPaisa !== line.exemptPaisa + line.taxablePaisa) throw invalid('inconsistent line amounts');
  if (!Number.isSafeInteger(creditNetPaisa) || creditNetPaisa < 1 || creditNetPaisa > line.netPaisa) throw invalid('credit must be 1..line net paisa');
  const [exemptPaisa, taxablePaisa, vatPaisa, otherTaxPaisa] = allocate(money(creditNetPaisa),
    [line.exemptPaisa, line.taxablePaisa, line.vatPaisa, line.otherTaxPaisa]).map((m) => m.amountPaisa) as [number, number, number, number];
  const base = exemptPaisa + taxablePaisa;
  const lineBase = BigInt(line.exemptPaisa + line.taxablePaisa);
  // lineBase > 0 whenever net > 0 (VAT and other tax are levied on the taxable amount).
  const discountPaisa = lineBase === 0n ? 0 : Number((2n * BigInt(line.discountPaisa) * BigInt(base) + lineBase) / (2n * lineBase));
  return { grossPaisa: base + discountPaisa, discountPaisa, exemptPaisa, taxablePaisa, vatPaisa, otherTaxPaisa, netPaisa: creditNetPaisa };
}
