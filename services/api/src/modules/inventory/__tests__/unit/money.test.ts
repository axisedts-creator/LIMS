// C12.T-02 — domain/money.ts (02-TRD §4.2, §15 "golden table: 30 cases incl. .5 rounding, discount = gross, rate 0"; PRD AC-05.1, AC-02.4).
// Expected interface (domain/money.ts), integer paisa as JS numbers (Number.isSafeInteger), qty_packs a DecimalStringPacks string:
//   computeLine({ qtyPacks, unitPricePaisa, discountPaisa, taxRateBp }) → { grossPaisa, netPaisa, vatPaisa, totalPaisa }
//   computeTotals(lines: {grossPaisa, discountPaisa, netPaisa, vatPaisa, totalPaisa}[]) → { subtotalPaisa, discountPaisa, netPaisa, vatPaisa, totalPaisa }
//   capitalisedValuePaisa({ netPaisa, vatPaisa }, vatInCost: boolean) → number
// Errors carry `.code` 'common.validation_failed'. An exempt line is computeLine with taxRateBp = 0 (the service never calls getTaxRate, D-70).
// Golden rows below are produced by an independent BigInt oracle: .orchestra/notes/C12.T-02-gen-money.cjs (exact rational arithmetic, half up).
import { describe, expect, it } from 'vitest';
import { capitalisedValuePaisa, computeLine, computeTotals } from '../../domain/money.js';
import { codeOf } from './helpers.js';

const VALIDATION = 'common.validation_failed';
const MAX = 9007199254740991;

interface Row { qty: string; price: number; disc: number; bp: number; gross: number; net: number; vat: number; total: number }
const GOLDEN: Row[] = [
  { qty: '1', price: 100, disc: 0, bp: 1300, gross: 100, net: 100, vat: 13, total: 113 },
  { qty: '1', price: 100, disc: 0, bp: 0, gross: 100, net: 100, vat: 0, total: 100 },
  { qty: '10', price: 2500, disc: 0, bp: 1300, gross: 25000, net: 25000, vat: 3250, total: 28250 },
  { qty: '0.5', price: 1, disc: 0, bp: 0, gross: 1, net: 1, vat: 0, total: 1 },
  { qty: '1.5', price: 1, disc: 0, bp: 0, gross: 2, net: 2, vat: 0, total: 2 },
  { qty: '2.5', price: 1, disc: 0, bp: 0, gross: 3, net: 3, vat: 0, total: 3 },
  { qty: '0.001', price: 500, disc: 0, bp: 1300, gross: 1, net: 1, vat: 0, total: 1 },
  { qty: '0.002', price: 250, disc: 0, bp: 1300, gross: 1, net: 1, vat: 0, total: 1 },
  { qty: '3', price: 333, disc: 33, bp: 1300, gross: 999, net: 966, vat: 126, total: 1092 },
  { qty: '3', price: 333, disc: 999, bp: 1300, gross: 999, net: 0, vat: 0, total: 0 },
  { qty: '12.5', price: 80, disc: 0, bp: 1300, gross: 1000, net: 1000, vat: 130, total: 1130 },
  { qty: '12.5', price: 80, disc: 100, bp: 1300, gross: 1000, net: 900, vat: 117, total: 1017 },
  { qty: '0.333', price: 100, disc: 0, bp: 1300, gross: 33, net: 33, vat: 4, total: 37 },
  { qty: '0.667', price: 100, disc: 0, bp: 1300, gross: 67, net: 67, vat: 9, total: 76 },
  { qty: '100', price: 1, disc: 0, bp: 1300, gross: 100, net: 100, vat: 13, total: 113 },
  { qty: '1', price: 5, disc: 0, bp: 1300, gross: 5, net: 5, vat: 1, total: 6 },
  { qty: '1', price: 7, disc: 0, bp: 1300, gross: 7, net: 7, vat: 1, total: 8 },
  { qty: '1', price: 3, disc: 0, bp: 1300, gross: 3, net: 3, vat: 0, total: 3 },
  { qty: '1', price: 4, disc: 0, bp: 500, gross: 4, net: 4, vat: 0, total: 4 },
  { qty: '1', price: 10, disc: 0, bp: 500, gross: 10, net: 10, vat: 1, total: 11 },
  { qty: '1', price: 1, disc: 0, bp: 5000, gross: 1, net: 1, vat: 1, total: 2 },
  { qty: '1', price: 1, disc: 0, bp: 10000, gross: 1, net: 1, vat: 1, total: 2 },
  { qty: '1', price: 1, disc: 1, bp: 1300, gross: 1, net: 0, vat: 0, total: 0 },
  { qty: '2', price: 50, disc: 100, bp: 1300, gross: 100, net: 0, vat: 0, total: 0 },
  { qty: '999999999', price: 1, disc: 0, bp: 0, gross: 999999999, net: 999999999, vat: 0, total: 999999999 },
  { qty: '999999999', price: 1000, disc: 0, bp: 1300, gross: 999999999000, net: 999999999000, vat: 129999999870, total: 1129999998870 },
  { qty: '1000.5', price: 99, disc: 50, bp: 1300, gross: 99050, net: 99000, vat: 12870, total: 111870 },
  { qty: '0.001', price: 1, disc: 0, bp: 0, gross: 0, net: 0, vat: 0, total: 0 },
  { qty: '0.999', price: 1, disc: 0, bp: 0, gross: 1, net: 1, vat: 0, total: 1 },
  { qty: '7', price: 12345, disc: 345, bp: 1300, gross: 86415, net: 86070, vat: 11189, total: 97259 },
  { qty: '4.25', price: 1999, disc: 0, bp: 1300, gross: 8496, net: 8496, vat: 1104, total: 9600 },
  { qty: '4.25', price: 1999, disc: 2000, bp: 1300, gross: 8496, net: 6496, vat: 844, total: 7340 },
  { qty: '6', price: 8333, disc: 0, bp: 1300, gross: 49998, net: 49998, vat: 6500, total: 56498 },
  { qty: '0.1', price: 15, disc: 0, bp: 1300, gross: 2, net: 2, vat: 0, total: 2 },
  { qty: '250', price: 40, disc: 0, bp: 1300, gross: 10000, net: 10000, vat: 1300, total: 11300 },
  { qty: '1', price: 0, disc: 0, bp: 1300, gross: 0, net: 0, vat: 0, total: 0 },
  { qty: '5', price: 2, disc: 10, bp: 0, gross: 10, net: 0, vat: 0, total: 0 },
  { qty: '0.4', price: 25, disc: 0, bp: 1300, gross: 10, net: 10, vat: 1, total: 11 },
];

const line = (r: Pick<Row, 'qty' | 'price' | 'disc' | 'bp'>) =>
  computeLine({ qtyPacks: r.qty, unitPricePaisa: r.price, discountPaisa: r.disc, taxRateBp: r.bp });

describe('AC-05.1 money golden table (≥ 30 cases; half up; integer paisa)', () => {
  it('has at least 30 cases', () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(30);
  });
  it.each(GOLDEN.map((r, i) => [i + 1, r] as const))('case %i', (_i, r) => {
    expect(line(r)).toEqual({ grossPaisa: r.gross, netPaisa: r.net, vatPaisa: r.vat, totalPaisa: r.total });
  });
  it('every result is a safe integer and total = net + vat', () => {
    for (const r of GOLDEN) {
      const l = line(r);
      for (const v of Object.values(l)) expect(Number.isSafeInteger(v)).toBe(true);
      expect(l.totalPaisa).toBe(l.netPaisa + l.vatPaisa);
    }
  });
});

describe('AC-05.1 spec formulas, named cases', () => {
  it('gross = round_half_up(qty_packs × unit_price): .5 rounds up, never to even', () => {
    expect(line({ qty: '0.5', price: 1, disc: 0, bp: 0 }).grossPaisa).toBe(1);
    expect(line({ qty: '2.5', price: 1, disc: 0, bp: 0 }).grossPaisa).toBe(3);
    expect(line({ qty: '3.5', price: 1, disc: 0, bp: 0 }).grossPaisa).toBe(4);
  });
  it('vat = round_half_up(net × tax_rate_bp / 10000): exactly .5 rounds up (net 50 × 1300 bp = 6.5 → 7)', () => {
    expect(line({ qty: '1', price: 50, disc: 0, bp: 1300 }).vatPaisa).toBe(7);
    expect(line({ qty: '1', price: 50, disc: 0, bp: 1300 }).totalPaisa).toBe(57);
  });
  it('vat is computed on net (after discount), not on gross', () => {
    const l = line({ qty: '10', price: 100, disc: 200, bp: 1300 }); // gross 1000, net 800, vat 104
    expect(l).toEqual({ grossPaisa: 1000, netPaisa: 800, vatPaisa: 104, totalPaisa: 904 });
  });
  it('discount = gross → net 0, vat 0, total 0 (allowed)', () => {
    expect(line({ qty: '4', price: 25, disc: 100, bp: 1300 })).toEqual({ grossPaisa: 100, netPaisa: 0, vatPaisa: 0, totalPaisa: 0 });
  });
  it('rate 0 (also the exempt snapshot, D-70) → vat 0, total = net', () => {
    expect(line({ qty: '3', price: 999, disc: 0, bp: 0 })).toEqual({ grossPaisa: 2997, netPaisa: 2997, vatPaisa: 0, totalPaisa: 2997 });
  });
  it('is exact where binary floats are not (0.1 × 3 = 0.30000000000000004; 1.005 × 100)', () => {
    expect(line({ qty: '0.1', price: 30, disc: 0, bp: 0 }).grossPaisa).toBe(3);
    expect(line({ qty: '1.005', price: 100, disc: 0, bp: 0 }).grossPaisa).toBe(101); // 100.5 exactly → half up
  });
});

describe('AC-05.1 / AC-02.4 invalid inputs are rejected, never clamped', () => {
  const ok = { qtyPacks: '1', unitPricePaisa: 100, discountPaisa: 0, taxRateBp: 1300 };
  it('discount greater than gross → common.validation_failed (TRD §4.2, P-1)', () => {
    expect(codeOf(() => computeLine({ ...ok, discountPaisa: 101 }))).toBe(VALIDATION);
    expect(codeOf(() => computeLine({ ...ok, qtyPacks: '2.5', unitPricePaisa: 1, discountPaisa: 4 }))).toBe(VALIDATION); // gross 3
  });
  it.each([
    ['negative unit price', { unitPricePaisa: -1 }],
    ['negative discount', { discountPaisa: -1 }],
    ['negative tax rate', { taxRateBp: -1 }],
    ['fractional unit price', { unitPricePaisa: 1.5 }],
    ['fractional discount', { discountPaisa: 0.5 }],
    ['fractional tax rate', { taxRateBp: 12.5 }],
    ['NaN price', { unitPricePaisa: Number.NaN }],
    ['Infinity price', { unitPricePaisa: Number.POSITIVE_INFINITY }],
    ['price above 2^53-1', { unitPricePaisa: MAX + 2 }],
    ['pack quantity with 4 decimals', { qtyPacks: '1.0001' }],
    ['pack quantity zero', { qtyPacks: '0' }],
    ['pack quantity negative', { qtyPacks: '-1' }],
    ['pack quantity with 10 integer digits', { qtyPacks: '1000000000' }],
    ['pack quantity not a string', { qtyPacks: 1 as unknown as string }],
    ['price given as a string', { unitPricePaisa: '100' as unknown as number }],
  ])('%s', (_why, patch) => {
    expect(codeOf(() => computeLine({ ...ok, ...patch }))).toBe(VALIDATION);
  });
  it('a result beyond Number.MAX_SAFE_INTEGER is rejected, not silently rounded (money max 9007199254740991)', () => {
    expect(codeOf(() => computeLine({ qtyPacks: '999999999', unitPricePaisa: MAX, discountPaisa: 0, taxRateBp: 0 }))).toBe(VALIDATION);
    expect(codeOf(() => computeLine({ qtyPacks: '1', unitPricePaisa: MAX, discountPaisa: 0, taxRateBp: 1300 }))).toBe(VALIDATION); // total overflows
  });
  it('the largest safe line still computes exactly', () => {
    const l = computeLine({ qtyPacks: '1', unitPricePaisa: MAX, discountPaisa: 0, taxRateBp: 0 });
    expect(l).toEqual({ grossPaisa: MAX, netPaisa: MAX, vatPaisa: 0, totalPaisa: MAX });
  });
});

describe('AC-05.1 header totals = sums of the lines (TRD §4.2)', () => {
  const lines = [
    { qty: '10', price: 2500, disc: 0, bp: 1300 },
    { qty: '3', price: 333, disc: 33, bp: 1300 },
    { qty: '12.5', price: 80, disc: 100, bp: 0 },
    { qty: '4', price: 25, disc: 100, bp: 1300 },
  ].map((r) => ({ r, l: line(r) }));
  it('subtotal = Σ gross, discount = Σ discount, net = Σ net, vat = Σ vat, total = Σ total', () => {
    const t = computeTotals(lines.map(({ r, l }) => ({ ...l, discountPaisa: r.disc })));
    expect(t).toEqual({
      subtotalPaisa: lines.reduce((s, { l }) => s + l.grossPaisa, 0),
      discountPaisa: lines.reduce((s, { r }) => s + r.disc, 0),
      netPaisa: lines.reduce((s, { l }) => s + l.netPaisa, 0),
      vatPaisa: lines.reduce((s, { l }) => s + l.vatPaisa, 0),
      totalPaisa: lines.reduce((s, { l }) => s + l.totalPaisa, 0),
    });
    expect(t.totalPaisa).toBe(t.netPaisa + t.vatPaisa);
  });
  it('literal check: 25000+999+1000+100 gross; vat 3250+126+0+0', () => {
    const t = computeTotals(lines.map(({ r, l }) => ({ ...l, discountPaisa: r.disc })));
    expect(t).toMatchObject({ subtotalPaisa: 27099, discountPaisa: 233, netPaisa: 26866, vatPaisa: 3376, totalPaisa: 30242 });
  });
  it('an empty list totals to zeros', () => {
    expect(computeTotals([])).toEqual({ subtotalPaisa: 0, discountPaisa: 0, netPaisa: 0, vatPaisa: 0, totalPaisa: 0 });
  });
  it('VAT is rounded per line, never on the sum', () => {
    const three = [1, 2, 3].map(() => ({ ...line({ qty: '1', price: 3, disc: 0, bp: 1300 }), discountPaisa: 0 }));
    expect(computeTotals(three).vatPaisa).toBe(0); // 3 × round(0.39) = 0; rounding the sum (1.17) would give 1
    const two = [1, 2].map(() => ({ ...line({ qty: '1', price: 5, disc: 0, bp: 1300 }), discountPaisa: 0 }));
    expect(computeTotals(two).vatPaisa).toBe(2); // 2 × round(0.65) = 2; rounding the sum (1.3) would give 1
  });
  it('a total beyond 2^53-1 is rejected', () => {
    const big = { grossPaisa: MAX, discountPaisa: 0, netPaisa: MAX, vatPaisa: 0, totalPaisa: MAX };
    expect(codeOf(() => computeTotals([big, big]))).toBe(VALIDATION);
  });
});

describe('§4.2 capitalised_value = net + (vat if settings.vat_in_cost else 0)', () => {
  it('vat_in_cost false → net', () => expect(capitalisedValuePaisa({ netPaisa: 966, vatPaisa: 126 }, false)).toBe(966));
  it('vat_in_cost true → net + vat', () => expect(capitalisedValuePaisa({ netPaisa: 966, vatPaisa: 126 }, true)).toBe(1092));
  it('exempt line (vat 0) is the same either way', () => {
    expect(capitalisedValuePaisa({ netPaisa: 500, vatPaisa: 0 }, true)).toBe(500);
    expect(capitalisedValuePaisa({ netPaisa: 500, vatPaisa: 0 }, false)).toBe(500);
  });
});
