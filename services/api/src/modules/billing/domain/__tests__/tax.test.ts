// BL-T02 domain/money/tax.ts (US-BL-14.1/14.2/14.4; 04 L14 13 % half-up to the paisa; 03-APP-FLOW B5 credit-note component split).
// Assumed API (spec gives no signatures; pure, integer paisa, errors are LimsError with .code):
//   computeLine({grossPaisa, discountPaisa, vatTreatment:'taxable'|'exempt', vatRateBp:number|null, otherTaxCode?, otherTaxRateBp?}) -> LineAmounts
//   allocateBillDiscount(bases:number[], billDiscountPaisa) -> number[]      (largest remainder, ties -> lowest index; weight = base)
//   computeInvoiceTotals({lines: LineInput[], billDiscountPaisa?}) -> {lines: LineAmounts[], totals: LineAmounts}
//   splitCredit(line: LineAmounts, creditNetPaisa) -> LineAmounts            (credit-note components, proportional, largest remainder)
// LineAmounts = {grossPaisa, discountPaisa, exemptPaisa, taxablePaisa, vatPaisa, otherTaxPaisa, netPaisa}
import { describe, expect, it } from 'vitest';
import { allocateBillDiscount, computeInvoiceTotals, computeLine, splitCredit } from '../money/tax.js';

const taxable = (grossPaisa: number, discountPaisa = 0, vatRateBp = 1300, extra: object = {}) =>
  ({ grossPaisa, discountPaisa, vatTreatment: 'taxable' as const, vatRateBp, ...extra });
const exempt = (grossPaisa: number, discountPaisa = 0) =>
  ({ grossPaisa, discountPaisa, vatTreatment: 'exempt' as const, vatRateBp: null });

// [gross, discount, rateBp, expected VAT] — expected values hand-computed: floor((taxable*bp + 5000) / 10000).
const GOLDEN: ReadonlyArray<readonly [number, number, number, number]> = [
  [100000, 0, 1300, 13000], // US-BL-14.1: NPR 1,000.00 -> NPR 130.00
  [1, 0, 1300, 0], [3, 0, 1300, 0], [4, 0, 1300, 1], [5, 0, 1300, 1], [7, 0, 1300, 1], [8, 0, 1300, 1],
  [11, 0, 1300, 1], [12, 0, 1300, 2], [38, 0, 1300, 5], [39, 0, 1300, 5],
  [50, 0, 1300, 7], [150, 0, 1300, 20], [350, 0, 1300, 46], [250, 0, 1300, 33], // exact .5 ties round UP
  [10, 0, 1300, 1], [100, 0, 1300, 13], [99, 0, 1300, 13], [101, 0, 1300, 13], [999, 0, 1300, 130],
  [12345, 0, 1300, 1605], [50000, 0, 1300, 6500], [123456, 0, 1300, 16049], [99999, 0, 1300, 13000],
  [100001, 0, 1300, 13000], [250050, 0, 1300, 32507], [0, 0, 1300, 0], [100000000, 0, 1300, 13000000],
  [77777, 0, 1300, 10111], [45000, 0, 1300, 5850], [333333, 0, 1300, 43333], [666667, 0, 1300, 86667],
  [37, 0, 1300, 5], [30, 0, 1300, 4], [999999999, 0, 1300, 130000000], [1000000000000, 0, 1300, 130000000000],
  [12345, 0, 1000, 1235], [1000, 0, 250, 25], [10, 0, 250, 0], [20, 0, 250, 1], [12345, 0, 10000, 12345],
  [5000, 0, 1, 1], [4999, 0, 1, 0], [1, 0, 500, 0], [5000, 0, 0, 0], // other rates; rate 0 is a valid taxable rate
  [120000, 20000, 1300, 13000], [100050, 25, 1300, 13003], [999, 999, 1300, 0], [2000, 1, 1300, 260],
  [1000, 333, 1300, 87], [1000, 500, 1300, 65], [15, 5, 1300, 1], [9, 1, 1300, 1], [2500, 1250, 1300, 163],
  [700, 100, 500, 30], // VAT is on the discounted (taxable) amount
];

describe('computeLine golden table (US-BL-14.1, 14.4)', () => {
  it('has >= 50 taxable cases', () => expect(GOLDEN.length).toBeGreaterThanOrEqual(50));
  it.each(GOLDEN)('gross %i disc %i @%i bp -> vat %i', (gross, disc, bp, vat) => {
    const t = gross - disc;
    expect(computeLine(taxable(gross, disc, bp))).toEqual({
      grossPaisa: gross, discountPaisa: disc, exemptPaisa: 0, taxablePaisa: t, vatPaisa: vat, otherTaxPaisa: 0, netPaisa: t + vat,
    });
  });
  it('13 % sweep t = 0..2000 equals the integer half-up formula', () => {
    for (let t = 0; t <= 2000; t++) {
      expect(computeLine(taxable(t)).vatPaisa).toBe(Math.floor((t * 1300 + 5000) / 10000));
    }
  });
  it('every exact .5 tie rounds up, never to even (t = 50, 150, ... where t*13 mod 100 = 50)', () => {
    for (const t of [50, 150, 250, 350, 450, 550, 650, 750, 850, 950]) {
      expect(computeLine(taxable(t)).vatPaisa).toBe((t * 13 + 50) / 100);
    }
  });
});

describe('exempt lines (US-BL-14.2)', () => {
  it('VAT 0, amount in the exempt column, taxable 0', () => {
    expect(computeLine(exempt(50000))).toEqual({
      grossPaisa: 50000, discountPaisa: 0, exemptPaisa: 50000, taxablePaisa: 0, vatPaisa: 0, otherTaxPaisa: 0, netPaisa: 50000,
    });
  });
  it('exempt with discount: exempt = gross - discount', () => {
    expect(computeLine(exempt(50000, 5000))).toMatchObject({ exemptPaisa: 45000, taxablePaisa: 0, vatPaisa: 0, netPaisa: 45000 });
  });
  it('exempt line must not carry a VAT rate (vat_rate_bp NULL iff exempt, 05-SCHEMA invoice_lines__vat__ck)', () => {
    expect(() => computeLine({ ...exempt(1000), vatRateBp: 1300 } as never)).toThrow();
  });
  it('taxable line without a rate throws — a rate is never guessed (08 R18)', () => {
    expect(() => computeLine({ ...taxable(1000), vatRateBp: null } as never)).toThrow();
    expect(() => computeLine({ ...taxable(1000), vatRateBp: undefined } as never)).toThrow();
  });
});

describe('other tax (HST) on the taxable amount, half-up', () => {
  it.each([
    [100000, 200, 2000, 13000, 115000],
    [12345, 150, 185, 1605, 14135],
    [50, 1000, 5, 7, 62],
    [5, 1000, 1, 1, 7], // 0.5 tie up
    [25, 2000, 5, 3, 33],
  ])('taxable %i other %i bp -> other tax %i', (t, bp, other, vat, net) => {
    expect(computeLine(taxable(t, 0, 1300, { otherTaxCode: 'HST', otherTaxRateBp: bp }))).toMatchObject({
      taxablePaisa: t, vatPaisa: vat, otherTaxPaisa: other, netPaisa: net,
    });
  });
  it('code without rate (or rate without code) throws', () => {
    expect(() => computeLine(taxable(1000, 0, 1300, { otherTaxCode: 'HST' }) as never)).toThrow();
    expect(() => computeLine(taxable(1000, 0, 1300, { otherTaxRateBp: 200 }) as never)).toThrow();
  });
});

describe('computeLine input validation (trust boundary, no floats)', () => {
  it.each([
    ['fractional gross', taxable(10.5)],
    ['negative gross', taxable(-1)],
    ['negative discount', taxable(100, -1)],
    ['discount > gross', taxable(100, 101)],
    ['rate > 10000 bp', taxable(100, 0, 10001)],
    ['negative rate', taxable(100, 0, -1)],
    ['fractional rate', taxable(100, 0, 1300.5)],
    ['NaN gross', taxable(Number.NaN)],
    ['unsafe integer gross', taxable(Number.MAX_SAFE_INTEGER + 1)],
  ])('%s throws', (_n, input) => {
    expect(() => computeLine(input as never)).toThrow();
  });
  it('unknown vatTreatment throws', () => {
    expect(() => computeLine({ ...taxable(100), vatTreatment: 'zero_rated' } as never)).toThrow();
  });
  it('invariants hold for every golden row: net = exempt + taxable + vat + other; gross - discount = exempt + taxable', () => {
    for (const [g, d, bp] of GOLDEN) {
      const r = computeLine(taxable(g, d, bp));
      expect(r.netPaisa).toBe(r.exemptPaisa + r.taxablePaisa + r.vatPaisa + r.otherTaxPaisa);
      expect(r.grossPaisa - r.discountPaisa).toBe(r.exemptPaisa + r.taxablePaisa);
    }
  });
});

describe('allocateBillDiscount (US-BL-14.4; pro-rata, largest remainder to the paisa)', () => {
  it('equal bases: remainder goes to the lowest index', () => expect(allocateBillDiscount([1000, 1000, 1000], 100)).toEqual([34, 33, 33]));
  it('1000 over [100000, 50000, 20000] -> [588, 294, 118]', () => expect(allocateBillDiscount([100000, 50000, 20000], 1000)).toEqual([588, 294, 118]));
  it('zero-base line gets nothing', () => expect(allocateBillDiscount([0, 1000], 10)).toEqual([0, 10]));
  it('tie between equal remainders -> lowest index, zero line skipped', () => expect(allocateBillDiscount([10, 0, 10], 5)).toEqual([3, 0, 2]));
  it('discount = total base discounts every line fully', () => expect(allocateBillDiscount([1, 1, 1], 3)).toEqual([1, 1, 1]));
  it('zero discount -> zeros', () => expect(allocateBillDiscount([5, 6], 0)).toEqual([0, 0]));
  it('sum always equals the discount and no share exceeds its base (sweep)', () => {
    const bases = [333, 1, 7, 1000, 0, 59];
    for (let d = 0; d <= bases.reduce((a, b) => a + b, 0); d += 13) {
      const a = allocateBillDiscount(bases, d);
      expect(a.reduce((x, y) => x + y, 0)).toBe(d);
      a.forEach((v, i) => expect(v).toBeLessThanOrEqual(bases[i]!));
    }
  });
  it('is exact beyond 2^53 intermediates (bigint)', () => {
    const bases = [4_000_000_000_000_000, 3_000_000_000_000_001];
    const a = allocateBillDiscount(bases, 7_000_000_000_000_000);
    expect(a[0]! + a[1]!).toBe(7_000_000_000_000_000);
    expect(a[0]!).toBeLessThanOrEqual(bases[0]!);
    expect(a[1]!).toBeLessThanOrEqual(bases[1]!);
  });
  it('throws when the discount exceeds the total base, is negative/fractional, or all bases are zero', () => {
    expect(() => allocateBillDiscount([10, 10], 21)).toThrow();
    expect(() => allocateBillDiscount([10, 10], -1)).toThrow();
    expect(() => allocateBillDiscount([10, 10], 1.5)).toThrow();
    expect(() => allocateBillDiscount([0, 0], 1)).toThrow();
  });
});

describe('computeInvoiceTotals golden (US-BL-14.4: rounding, bill discount, surcharge, exempt + taxable mix)', () => {
  it('VAT is rounded per line, then summed (3 x 50 paisa -> 21, not round(19.5) = 20)', () => {
    const r = computeInvoiceTotals({ lines: [taxable(50), taxable(50), taxable(50)] });
    expect(r.totals).toEqual({ grossPaisa: 150, discountPaisa: 0, exemptPaisa: 0, taxablePaisa: 150, vatPaisa: 21, otherTaxPaisa: 0, netPaisa: 171 });
    expect(r.lines.map((l) => l.vatPaisa)).toEqual([7, 7, 7]);
  });
  it('exempt + taxable + urgent surcharge mix', () => {
    const r = computeInvoiceTotals({ lines: [taxable(100000), exempt(50000), taxable(20000)] });
    expect(r.totals).toEqual({ grossPaisa: 170000, discountPaisa: 0, exemptPaisa: 50000, taxablePaisa: 120000, vatPaisa: 15600, otherTaxPaisa: 0, netPaisa: 185600 });
  });
  it('bill discount 1000 over the mix', () => {
    const r = computeInvoiceTotals({ lines: [taxable(100000), exempt(50000), taxable(20000)], billDiscountPaisa: 1000 });
    expect(r.lines.map((l) => l.discountPaisa)).toEqual([588, 294, 118]);
    expect(r.lines.map((l) => l.vatPaisa)).toEqual([12924, 0, 2585]);
    expect(r.totals).toEqual({ grossPaisa: 170000, discountPaisa: 1000, exemptPaisa: 49706, taxablePaisa: 119294, vatPaisa: 15509, otherTaxPaisa: 0, netPaisa: 184509 });
  });
  it('equal split 100 over three 1000 lines', () => {
    const r = computeInvoiceTotals({ lines: [taxable(1000), taxable(1000), taxable(1000)], billDiscountPaisa: 100 });
    expect(r.lines.map((l) => l.discountPaisa)).toEqual([34, 33, 33]);
    expect(r.totals).toMatchObject({ grossPaisa: 3000, discountPaisa: 100, taxablePaisa: 2900, vatPaisa: 378, netPaisa: 3278 });
  });
  it('line discount + bill discount: bill discount is weighted by what is left after the line discount', () => {
    const r = computeInvoiceTotals({ lines: [taxable(2000, 500), taxable(2000)], billDiscountPaisa: 350 });
    expect(r.lines.map((l) => l.discountPaisa)).toEqual([650, 200]);
    expect(r.lines.map((l) => l.vatPaisa)).toEqual([176, 234]);
    expect(r.totals).toMatchObject({ grossPaisa: 4000, discountPaisa: 850, taxablePaisa: 3150, vatPaisa: 410, netPaisa: 3560 });
  });
  it('bill discount can never push a fully line-discounted line below zero', () => {
    const r = computeInvoiceTotals({ lines: [taxable(100, 100), taxable(1000)], billDiscountPaisa: 10 });
    expect(r.lines[0]!.discountPaisa).toBe(100);
    expect(r.lines[1]!.discountPaisa).toBe(10);
  });
  it('bill discount equal to the whole remaining amount -> net 0', () => {
    expect(computeInvoiceTotals({ lines: [taxable(1000), exempt(500)], billDiscountPaisa: 1500 }).totals).toMatchObject({ taxablePaisa: 0, exemptPaisa: 0, vatPaisa: 0, netPaisa: 0 });
  });
  it('bill discount above the remaining amount throws', () => {
    expect(() => computeInvoiceTotals({ lines: [taxable(1000)], billDiscountPaisa: 1001 })).toThrow();
  });
  it('totals equal the column sums of the lines and satisfy the DB invoices__totals__ck for 40 synthetic invoices', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    for (let i = 0; i < 40; i++) {
      const lines = Array.from({ length: 1 + rnd(8) }, () => {
        const g = 1 + rnd(500000);
        const d = rnd(g);
        return rnd(4) === 0 ? exempt(g, d) : taxable(g, d, [1300, 1300, 1000, 0][rnd(4)]!);
      });
      const remaining = lines.reduce((s, l) => s + l.grossPaisa - l.discountPaisa, 0);
      const bill = rnd(remaining + 1);
      const { lines: out, totals } = computeInvoiceTotals({ lines, billDiscountPaisa: bill });
      for (const k of ['grossPaisa', 'discountPaisa', 'exemptPaisa', 'taxablePaisa', 'vatPaisa', 'otherTaxPaisa', 'netPaisa'] as const) {
        expect(totals[k]).toBe(out.reduce((s, l) => s + l[k], 0));
      }
      expect(totals.discountPaisa).toBe(lines.reduce((s, l) => s + l.discountPaisa, 0) + bill);
      expect(totals.grossPaisa - totals.discountPaisa).toBe(totals.exemptPaisa + totals.taxablePaisa);
      expect(totals.netPaisa).toBe(totals.exemptPaisa + totals.taxablePaisa + totals.vatPaisa + totals.otherTaxPaisa);
      out.forEach((l) => expect(l.discountPaisa).toBeLessThanOrEqual(l.grossPaisa));
    }
  });
});

describe('splitCredit — credit-note component split (03-APP-FLOW B5; schema credit_note_lines__amounts__ck)', () => {
  const L1 = computeLine(taxable(120000, 20000)); // taxable 100000, vat 13000, net 113000
  const L2 = computeLine(exempt(50000));
  const L3 = computeLine(taxable(100000, 0, 1300, { otherTaxCode: 'HST', otherTaxRateBp: 200 })); // net 115000

  it('crediting the whole line returns the line components exactly', () => {
    expect(splitCredit(L1, 113000)).toEqual(L1);
    expect(splitCredit(L2, 50000)).toEqual(L2);
    expect(splitCredit(L3, 115000)).toEqual(L3);
  });
  it('exact half', () => {
    expect(splitCredit(L1, 56500)).toEqual({ grossPaisa: 60000, discountPaisa: 10000, exemptPaisa: 0, taxablePaisa: 50000, vatPaisa: 6500, otherTaxPaisa: 0, netPaisa: 56500 });
  });
  it('10 % of a line with other tax is exact', () => {
    expect(splitCredit(L3, 11500)).toMatchObject({ taxablePaisa: 10000, vatPaisa: 1300, otherTaxPaisa: 200, netPaisa: 11500 });
  });
  it('rounding: largest remainder decides, the extra paisa lands on the largest remainder', () => {
    expect(splitCredit(L1, 1)).toMatchObject({ taxablePaisa: 1, vatPaisa: 0, netPaisa: 1 });
    expect(splitCredit(L1, 3)).toMatchObject({ taxablePaisa: 3, vatPaisa: 0, netPaisa: 3 });
    expect(splitCredit(L1, 10000)).toMatchObject({ taxablePaisa: 8850, vatPaisa: 1150, netPaisa: 10000 });
    expect(splitCredit(L3, 7)).toMatchObject({ taxablePaisa: 6, vatPaisa: 1, otherTaxPaisa: 0, netPaisa: 7 });
  });
  it('exempt line: credit is all exempt, no VAT component', () => {
    expect(splitCredit(L2, 12345)).toEqual({ grossPaisa: 12345, discountPaisa: 0, exemptPaisa: 12345, taxablePaisa: 0, vatPaisa: 0, otherTaxPaisa: 0, netPaisa: 12345 });
  });
  it.each([['L1', L1], ['L2', L2], ['L3', L3]] as const)('%s invariants hold for every credit amount in a sweep', (_n, line) => {
    const amounts = [...Array.from({ length: 300 }, (_, i) => i + 1), ...Array.from({ length: 60 }, (_, i) => 997 * (i + 1)), line.netPaisa - 1, line.netPaisa]
      .filter((x) => x >= 1 && x <= line.netPaisa);
    for (const x of amounts) {
      const c = splitCredit(line, x);
      expect(c.netPaisa).toBe(x);
      expect(c.netPaisa).toBe(c.exemptPaisa + c.taxablePaisa + c.vatPaisa + c.otherTaxPaisa);
      expect(c.grossPaisa - c.discountPaisa).toBe(c.exemptPaisa + c.taxablePaisa);
      expect(c.discountPaisa).toBeGreaterThanOrEqual(0);
      expect(c.discountPaisa).toBeLessThanOrEqual(c.grossPaisa);
      for (const k of ['grossPaisa', 'discountPaisa', 'exemptPaisa', 'taxablePaisa', 'vatPaisa', 'otherTaxPaisa'] as const) {
        expect(c[k]).toBeGreaterThanOrEqual(0);
        expect(c[k]).toBeLessThanOrEqual(line[k]);
      }
    }
  });
  it('throws for credit <= 0, > line net, or non-integer (credit_note_lines__amounts__ck: net > 0; guard: Σ <= line net)', () => {
    expect(() => splitCredit(L1, 0)).toThrow();
    expect(() => splitCredit(L1, -5)).toThrow();
    expect(() => splitCredit(L1, 113001)).toThrow();
    expect(() => splitCredit(L1, 10.5)).toThrow();
  });
});
