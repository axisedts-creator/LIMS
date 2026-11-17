// BillingCommandPort.computeQuote (03-IC §4.15; US-BL-14.1-14.4; 08 R18). Pure: no DB, no catalog call, no event.
// Rates come only from each line's `tax` (= CatalogPort.priceFor().tax) and are echoed on the computed line (the invoice-line snapshot).
// A missing rate is never guessed: catalog.tax_config_missing. Rounding and bill-discount allocation are the BL-T02 domain (tax.ts).
import type { DiscountInput, PricedLineInput, QuoteResult, ComputedLine } from '../../../../../../contracts/ports/BillingCommandPort.js';
import type { RequestContext } from '../../../../../../contracts/ports/common.js';
import { sha256Hex } from '../../../../../../packages/shared-ts/src/crypto/index.js';
import { money, percentOf } from '../../../../../../packages/shared-ts/src/money/index.js';
import { LimsError } from '../../../core/errors.js';
import { allocateBillDiscount, computeLine } from '../domain/money/tax.js';

const invalid = (detail: string): LimsError => new LimsError('common.validation_failed', detail); // fixed text: never echoes a submitted value
const isPaisa = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isRec = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const npr = (amountPaisa: number) => ({ amountPaisa, currency: 'NPR' as const });
const pct = (paisa: number, bp: number): number => percentOf(money(paisa), bp).amountPaisa;
const TOTAL_KEYS = ['gross', 'discount', 'exempt', 'taxable', 'vat', 'otherTax', 'net'] as const;
const LINE_KEYS = ['lineRef', 'orderItemId', 'orderableId', 'orderableKind', 'code', 'name', 'departmentId', 'priority', 'unitPrice', 'urgentSurcharge',
  'priceListId', 'priceListVersion', 'priceSource'] as const;
const TAX_KEYS = ['vat', 'otherTaxCode', 'vatRateBp', 'otherTaxRateBp', 'hsCode'] as const;

function pick(src: Record<string, any>, keys: readonly string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isRec(v)) return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function paisaOf(m: unknown): number {
  if (!isRec(m) || m['currency'] !== 'NPR' || !isPaisa(m['amountPaisa'])) throw invalid('amount must be integer paisa in NPR');
  return m['amountPaisa'];
}

interface Row { readonly line: Record<string, any>; readonly kind: 'orderable' | 'urgent_surcharge'; readonly gross: number }

function rowsOf(lines: unknown): Row[] {
  if (!Array.isArray(lines)) throw invalid('lines must be an array');
  const refs = new Set<string>();
  const rows: Row[] = [];
  for (const raw of lines) {
    if (!isRec(raw) || typeof raw['lineRef'] !== 'string' || raw['lineRef'] === '' || refs.has(raw['lineRef'])) throw invalid('line needs a unique lineRef');
    refs.add(raw['lineRef']);
    const tax = raw['tax'];
    if (!isRec(tax) || (tax['vat'] !== 'taxable' && tax['vat'] !== 'exempt')) throw invalid('tax.vat must be taxable or exempt');
    // 08 R18: absent rate -> propagate, never a default.
    if (tax['vat'] === 'taxable' && tax['vatRateBp'] == null) throw new LimsError('catalog.tax_config_missing');
    if (tax['otherTaxCode'] != null && tax['otherTaxRateBp'] == null) throw new LimsError('catalog.tax_config_missing');
    if (tax['vat'] === 'exempt' && tax['vatRateBp'] != null) throw invalid('exempt line carries no VAT rate'); // invoice_lines.vat_rate_bp is NULL when exempt
    const line = { ...pick(raw, LINE_KEYS), tax: pick(tax, TAX_KEYS) };
    rows.push({ line, kind: 'orderable', gross: paisaOf(raw['unitPrice']) });
    if (raw['priority'] === 'urgent' && raw['urgentSurcharge'] !== undefined) rows.push({ line, kind: 'urgent_surcharge', gross: paisaOf(raw['urgentSurcharge']) });
  }
  return rows;
}

/** Discount per row: line discounts hit the orderable row only; bill discounts are spread over ALL rows by what is left. */
function discountsPerRow(rows: readonly Row[], discounts: unknown): number[] {
  if (!Array.isArray(discounts)) throw invalid('discounts must be an array');
  const disc = rows.map(() => 0);
  const bill: Record<string, any>[] = [];
  for (const d of discounts) {
    if (!isRec(d) || (d['kind'] !== 'amount' && d['kind'] !== 'percent')) throw invalid('discount kind must be amount or percent');
    if (d['kind'] === 'amount' ? !isPaisa(d['amountPaisa']) : !(Number.isInteger(d['percentBp']) && d['percentBp'] >= 0 && d['percentBp'] <= 10000)) throw invalid('discount value out of range');
    if (d['scope'] === 'bill') { bill.push(d); continue; }
    if (d['scope'] !== 'line') throw invalid('discount scope must be line or bill');
    const i = rows.findIndex((r) => r.kind === 'orderable' && r.line['lineRef'] === d['lineRef']);
    if (i < 0) throw invalid('discount targets an unknown line');
    const left = rows[i]!.gross - disc[i]!;
    const amt = d['kind'] === 'amount' ? d['amountPaisa'] : pct(left, d['percentBp']);
    if (amt > left) throw invalid('discount exceeds the amount');
    disc[i]! += amt;
  }
  let remaining = rows.reduce((s, r, i) => s + r.gross - disc[i]!, 0);
  let total = 0;
  for (const d of bill) { // sequential: a later bill discount applies to what the earlier ones left
    const amt = d['kind'] === 'amount' ? d['amountPaisa'] : pct(remaining, d['percentBp']);
    if (amt > remaining) throw invalid('discount exceeds the amount');
    remaining -= amt; total += amt;
  }
  if (rows.length === 0) return disc;
  const shares = allocateBillDiscount(rows.map((r, i) => r.gross - disc[i]!), total);
  return disc.map((x, i) => x + shares[i]!);
}

async function build(lines: unknown, discounts: unknown): Promise<Omit<QuoteResult, 'baseFingerprint'>> {
  const rows = rowsOf(lines);
  const disc = discountsPerRow(rows, discounts);
  const computed = rows.map((r, i): ComputedLine => {
    const t = r.line['tax'] as PricedLineInput['tax'];
    const a = computeLine({
      grossPaisa: r.gross, discountPaisa: disc[i]!, vatTreatment: t.vat, vatRateBp: t.vat === 'taxable' ? t.vatRateBp! : null,
      ...(t.otherTaxCode != null ? { otherTaxCode: t.otherTaxCode, otherTaxRateBp: t.otherTaxRateBp! } : {}),
    });
    return {
      ...r.line, lineKind: r.kind, gross: npr(a.grossPaisa), discount: npr(a.discountPaisa), exempt: npr(a.exemptPaisa), taxable: npr(a.taxablePaisa),
      vat: npr(a.vatPaisa), otherTax: npr(a.otherTaxPaisa), ...(t.otherTaxCode != null ? { otherTaxCode: t.otherTaxCode } : {}), net: npr(a.netPaisa),
    } as ComputedLine;
  });
  const totals = Object.fromEntries(TOTAL_KEYS.map((k) => {
    const sum = computed.reduce((s, l) => s + l[k].amountPaisa, 0);
    if (!Number.isSafeInteger(sum)) throw invalid('quote total out of range');
    return [k, npr(sum)];
  })) as unknown as QuoteResult['totals'];
  const norm = (discounts as Record<string, any>[]).map((d) => pick(d, ['scope', 'lineRef', 'kind', 'amountPaisa', 'percentBp']));
  return { lines: computed, totals, fingerprint: sha256Hex(canon({ lines: computed, discounts: norm, totals })) };
}

export async function computeQuote(_ctx: RequestContext, input: { lines: readonly PricedLineInput[]; discounts: readonly DiscountInput[] }): Promise<QuoteResult> {
  if (!isRec(input)) throw invalid('input must be an object');
  const q = await build(input.lines, input.discounts);
  // discount-approval binding: the same lines quoted with no discounts.
  const baseFingerprint = Array.isArray(input.discounts) && input.discounts.length === 0 ? q.fingerprint : (await build(input.lines, [])).fingerprint;
  return { ...q, baseFingerprint };
}
