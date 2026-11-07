// BL-T05 quote engine unit tests (02-TRD §6.x BillingCommandPort.computeQuote; PRD US-BL-14.1-14.4; 08 R18).
// Fails now: ../quote.service.js does not exist.
// ASSUMED API (spec gives the port signature only; writer: object via a dispute if wrong):
//   quote.service.ts : export async function computeQuote(ctx, input: { lines: PricedLineInput[]; discounts: DiscountInput[] }): Promise<QuoteResult>
//   Pure: no writes, no DB, no catalog call. Rates come ONLY from each line's `tax` (PricedLineInput.tax = CatalogPort.priceFor().tax).
//   ComputedLine = the input line fields (tax echoed verbatim = the rate snapshot) + lineKind/gross/discount/exempt/taxable/vat/otherTax/net (Money {amountPaisa,currency:'NPR'}).
//   Rows per input line, in order: the orderable row, then (priority 'urgent' && urgentSurcharge) an 'urgent_surcharge' row taxed like its parent.
//   A 'line' discount hits the orderable row only; a 'bill' discount is spread over ALL rows pro-rata to the amount left after line discounts
//   (largest remainder, ties -> lowest row); VAT per row half-up on the taxable amount; otherTax = half-up of otherTaxRateBp on the taxable amount ([CONV] tax.ts).
//   percent discount = half-up percentBp of the gross of its target (single percent discount per test, no line discounts mixed in).
import { describe, expect, it } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { computeQuote } from '../quote.service.js';

const ctx = makeCtxFor()('A');
const npr = (amountPaisa: number) => ({ amountPaisa, currency: 'NPR' as const });
const PL = '01900000-0000-7000-8000-0000000c4041';
const line = (ref: string, paisa: number, extra: Record<string, unknown> = {}) => ({
  lineRef: ref, orderableId: `01900000-0000-7000-8000-0000000c4${(0x100 + ref.length).toString(16)}`, orderableKind: 'test' as const, code: ref,
  name: `Synthetic ${ref}`, priority: 'routine' as const, unitPrice: npr(paisa), tax: { vat: 'taxable' as const, vatRateBp: 1300 },
  priceListId: PL, priceListVersion: 1, priceSource: 'tenant_default' as const, ...extra,
});
const exempt = (ref: string, paisa: number, extra: Record<string, unknown> = {}) => line(ref, paisa, { tax: { vat: 'exempt' as const }, ...extra });
const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const q = (lines: unknown[], discounts: unknown[] = []) => computeQuote(ctx, { lines, discounts } as never) as Promise<any>;
const p = (m: { amountPaisa: number }) => m.amountPaisa;

describe('US-BL-14.1 taxable line: 13 % VAT half-up to the paisa', () => {
  it('NPR 1,000.00 taxable -> VAT 130.00, net 1,130.00, exempt 0', async () => {
    const r = await q([line('CBC', 100000)]);
    expect(r.lines).toHaveLength(1);
    const l = r.lines[0];
    expect([l.lineKind, p(l.gross), p(l.discount), p(l.exempt), p(l.taxable), p(l.vat), p(l.otherTax), p(l.net)]).toEqual(['orderable', 100000, 0, 0, 100000, 13000, 0, 113000]);
    expect(Object.fromEntries(Object.entries(r.totals).map(([k, v]: [string, any]) => [k, p(v)]))).toEqual(
      { gross: 100000, discount: 0, exempt: 0, taxable: 100000, vat: 13000, otherTax: 0, net: 113000 });
    expect(l.net.currency).toBe('NPR');
  });
  it('rounds half-up: 13 % of 50.00 = 6.50 exactly; of 0.50 (50 paisa) = 6.5 paisa -> 7; of 0.38 (38 paisa) = 4.94 -> 5; of 0.34 = 4.42 -> 4', async () => {
    const r = await q([line('A', 5000), line('B', 50), line('C', 38), line('D', 34)]);
    expect(r.lines.map((l: any) => p(l.vat))).toEqual([650, 7, 5, 4]);
    expect(p(r.totals.vat)).toBe(666); // per-line rounding then sum ([CONV] tax.ts), not 13 % of the total
  });
});

describe('US-BL-14.2 exempt line', () => {
  it('VAT 0, the whole amount in the exempt column, no VAT rate on the line snapshot', async () => {
    const r = await q([exempt('FEE', 100000)]);
    const l = r.lines[0];
    expect([p(l.exempt), p(l.taxable), p(l.vat), p(l.net)]).toEqual([100000, 0, 0, 100000]);
    expect(l.tax.vat).toBe('exempt');
    expect(l.tax.vatRateBp).toBeUndefined(); // invoice_lines.vat_rate_bp is NULL for exempt lines (plan row BL-T05)
  });
  it('exempt + taxable mix: totals add up column by column', async () => {
    const r = await q([line('T', 100000), exempt('E', 25050)]);
    expect(Object.fromEntries(Object.entries(r.totals).map(([k, v]: [string, any]) => [k, p(v)]))).toEqual(
      { gross: 125050, discount: 0, exempt: 25050, taxable: 100000, vat: 13000, otherTax: 0, net: 138050 });
  });
});

describe('US-BL-14.3 rates come from the line snapshot; a missing rate is never guessed (08 R18)', () => {
  it('taxable without vatRateBp -> 422 catalog.tax_config_missing (not a 13 % fallback)', async () => {
    await expect(q([line('X', 100000, { tax: { vat: 'taxable' } })])).rejects.toMatchObject({ code: 'catalog.tax_config_missing', statusCode: 422 });
  });
  it('otherTaxCode HST without otherTaxRateBp -> catalog.tax_config_missing', async () => {
    await expect(q([line('X', 100000, { tax: { vat: 'taxable', vatRateBp: 1300, otherTaxCode: 'HST' } })])).rejects.toMatchObject({ code: 'catalog.tax_config_missing' });
    await expect(q([exempt('X', 100000, { tax: { vat: 'exempt', otherTaxCode: 'HST' } })])).rejects.toMatchObject({ code: 'catalog.tax_config_missing' });
  });
  it('one bad line fails the whole quote (no partial result)', async () => {
    await expect(q([line('OK', 1000), line('BAD', 1000, { tax: { vat: 'taxable' } })])).rejects.toMatchObject({ code: 'catalog.tax_config_missing' });
  });
  it('the error carries no rate, price or code from the request (propagated unchanged)', async () => {
    const e: any = await q([line('SECRETNAME', 123457, { tax: { vat: 'taxable', otherTaxCode: 'HST' } })]).catch((x) => x);
    expect(e.code).toBe('catalog.tax_config_missing');
    expect(JSON.stringify({ m: e.message, d: e.detail, e: e.errors })).not.toMatch(/SECRETNAME|123457|HST|1300/);
  });
  it('an explicit rate of 0 bp is a configured rate (VAT 0), not a missing one', async () => {
    const r = await q([line('Z', 100000, { tax: { vat: 'taxable', vatRateBp: 0 } })]);
    expect([p(r.lines[0].vat), p(r.lines[0].taxable), p(r.lines[0].net)]).toEqual([0, 100000, 100000]);
    expect(r.lines[0].tax.vatRateBp).toBe(0);
  });
  it('the rate is snapshotted from the line, whatever it is (1000 bp quote differs from the 1300 bp quote)', async () => {
    const a = await q([line('R', 100000)]);
    const b = await q([line('R', 100000, { tax: { vat: 'taxable', vatRateBp: 1000, hsCode: '3002' } })]);
    expect(p(b.lines[0].vat)).toBe(10000);
    expect(b.lines[0].tax).toEqual({ vat: 'taxable', vatRateBp: 1000, hsCode: '3002' });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
  it('other tax HST 2 % is taken from the line and shown separately; code kept on the line', async () => {
    const r = await q([line('H', 100000, { tax: { vat: 'taxable', vatRateBp: 1300, otherTaxCode: 'HST', otherTaxRateBp: 200 } })]);
    const l = r.lines[0];
    expect([p(l.vat), p(l.otherTax), p(l.net), l.otherTaxCode]).toEqual([13000, 2000, 115000, 'HST']);
    expect(l.tax).toMatchObject({ otherTaxCode: 'HST', otherTaxRateBp: 200 });
    expect(p(r.totals.otherTax)).toBe(2000);
  });
});

describe('urgent surcharge row', () => {
  it('urgent + surcharge -> second row lineKind urgent_surcharge, taxed like its parent; routine ignores the surcharge', async () => {
    const r = await q([line('LFT', 120000, { priority: 'urgent', urgentSurcharge: npr(20000) }), line('CBC', 50000, { urgentSurcharge: npr(9999) })]);
    expect(r.lines.map((l: any) => [l.lineRef, l.lineKind, p(l.gross), p(l.vat)])).toEqual([
      ['LFT', 'orderable', 120000, 15600], ['LFT', 'urgent_surcharge', 20000, 2600], ['CBC', 'orderable', 50000, 6500]]);
    expect(p(r.totals.gross)).toBe(190000);
  });
  it('a line discount reduces the orderable row only, never the surcharge row', async () => {
    const r = await q([line('LFT', 100000, { priority: 'urgent', urgentSurcharge: npr(20000) })], [{ scope: 'line', lineRef: 'LFT', kind: 'amount', amountPaisa: 10000 }]);
    expect(r.lines.map((l: any) => p(l.discount))).toEqual([10000, 0]);
  });
});

describe('discounts (bill discount allocation, US-BL-14.4)', () => {
  it('line amount discount reduces the VAT base: 1,000 - 100 -> VAT 117.00', async () => {
    const r = await q([line('A', 100000)], [{ scope: 'line', lineRef: 'A', kind: 'amount', amountPaisa: 10000 }]);
    expect([p(r.lines[0].discount), p(r.lines[0].taxable), p(r.lines[0].vat), p(r.lines[0].net)]).toEqual([10000, 90000, 11700, 101700]);
    expect(p(r.totals.discount)).toBe(10000);
  });
  it('bill amount discount is spread pro-rata, remainder to the largest remainder; shares add up exactly', async () => {
    // bases 10000 / 20000 / 30001; D = 100 -> exact 16.66.. / 33.33.. / 50.00..; floors 16/33/50 = 99, +1 to the largest remainder (row 0: .66 > .33 > .00)
    const r = await q([exempt('A', 10000), exempt('B', 20000), exempt('C', 30001)], [{ scope: 'bill', kind: 'amount', amountPaisa: 100 }]);
    expect(r.lines.map((l: any) => p(l.discount))).toEqual([17, 33, 50]);
    expect(p(r.totals.discount)).toBe(100);
  });
  it('bill percent discount: 10 % of the gross (half-up) over taxable + exempt rows', async () => {
    const r = await q([line('T', 100000), exempt('E', 50005)], [{ scope: 'bill', kind: 'percent', percentBp: 1000 }]);
    expect(p(r.totals.discount)).toBe(15001); // 150005 * 10 % = 15000.5 -> half-up 15001
    expect(r.totals.gross.amountPaisa - r.totals.discount.amountPaisa).toBe(p(r.totals.exempt) + p(r.totals.taxable));
  });
  it('line + bill discounts together: bill share is weighted by what is left after the line discount', async () => {
    const r = await q([exempt('A', 100000), exempt('B', 100000)], [
      { scope: 'line', lineRef: 'A', kind: 'amount', amountPaisa: 50000 }, { scope: 'bill', kind: 'amount', amountPaisa: 30000 }]);
    // left: A 50000, B 100000 -> bill 10000 / 20000
    expect(r.lines.map((l: any) => p(l.discount))).toEqual([60000, 20000]);
  });
  it('rejects: discount above the amount, unknown lineRef, percent > 100 %, fractional or negative paisa -> common.validation_failed', async () => {
    const base = [exempt('A', 1000)];
    for (const d of [
      { scope: 'bill', kind: 'amount', amountPaisa: 1001 }, { scope: 'line', lineRef: 'NOPE', kind: 'amount', amountPaisa: 1 },
      { scope: 'bill', kind: 'percent', percentBp: 10001 }, { scope: 'bill', kind: 'amount', amountPaisa: 10.5 }, { scope: 'bill', kind: 'amount', amountPaisa: -1 },
      { scope: 'bill', kind: 'bogus', amountPaisa: 1 },
    ]) await expect(q(base, [d]), JSON.stringify(d)).rejects.toMatchObject({ code: 'common.validation_failed' });
  });
});

describe('input validation (integer paisa only) and purity', () => {
  it('rejects negative, fractional, string, NaN and unsafe unit prices -> common.validation_failed', async () => {
    for (const bad of [-1, 10.5, '1000', Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, null, undefined])
      await expect(q([line('A', bad as number)]), String(bad)).rejects.toMatchObject({ code: 'common.validation_failed' });
  });
  it('does not mutate its input (frozen input) and returns equal results for equal input', async () => {
    const lines = deepFreeze([line('A', 100000, { priority: 'urgent', urgentSurcharge: npr(5000) })]);
    const discounts = deepFreeze([{ scope: 'bill', kind: 'amount', amountPaisa: 1000 }]);
    const a = await computeQuote(ctx, { lines, discounts } as never);
    const b = await computeQuote(ctx, { lines, discounts } as never);
    expect(b).toEqual(a);
  });
  it('a hostile lineRef / name is data: no throw, echoed verbatim, never interpreted', async () => {
    const r = await q([exempt("x'); DROP TABLE billing.invoices;--", 100, { name: '<script>alert(1)</script>' })]);
    expect(r.lines[0].lineRef).toBe("x'); DROP TABLE billing.invoices;--");
  });
});

describe('fingerprint / baseFingerprint', () => {
  const L = () => [line('CBC', 50000), line('LFT', 120000, { priority: 'urgent', urgentSurcharge: npr(20000) })];
  const D = [{ scope: 'bill', kind: 'amount', amountPaisa: 1000 }];
  it('sha256 hex, deterministic, independent of property order in the input', async () => {
    const a = await q(L(), D);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.baseFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await q(L(), D)).fingerprint).toBe(a.fingerprint);
    const reordered = L().map((l) => Object.fromEntries(Object.entries(l).reverse()));
    expect((await q(reordered, D)).fingerprint).toBe(a.fingerprint);
  });
  it('baseFingerprint = fingerprint of the same lines with discounts [] (discount-approval binding)', async () => {
    const withDisc = await q(L(), D), none = await q(L(), []);
    expect(withDisc.baseFingerprint).toBe(none.fingerprint);
    expect(none.baseFingerprint).toBe(none.fingerprint);
    expect(withDisc.fingerprint).not.toBe(withDisc.baseFingerprint);
  });
  it('baseFingerprint is unchanged by any discount but changes with price, tax rate, lines, urgency', async () => {
    const base = (await q(L())).baseFingerprint;
    expect((await q(L(), [{ scope: 'bill', kind: 'percent', percentBp: 500 }])).baseFingerprint).toBe(base);
    expect((await q(L(), [{ scope: 'line', lineRef: 'CBC', kind: 'amount', amountPaisa: 5 }])).baseFingerprint).toBe(base);
    const variants = [
      [line('CBC', 50001), L()[1]], [line('CBC', 50000, { tax: { vat: 'taxable', vatRateBp: 1301 } }), L()[1]], [L()[0]],
      [L()[0], line('LFT', 120000, { priority: 'urgent', urgentSurcharge: npr(20001) })], [L()[0], line('LFT', 120000)],
      [line('CBC', 50000, { priceListVersion: 2 }), L()[1]],
    ];
    const seen = new Set([base]);
    for (const v of variants) seen.add((await q(v)).baseFingerprint);
    expect(seen.size).toBe(variants.length + 1);
  });
  it('different discounts give different fingerprints', async () => {
    const f = async (d: unknown[]) => (await q(L(), d)).fingerprint;
    const all = [await f([]), await f(D), await f([{ scope: 'bill', kind: 'amount', amountPaisa: 1001 }]), await f([{ scope: 'bill', kind: 'percent', percentBp: 100 }])];
    expect(new Set(all).size).toBe(4);
  });
});

// ---------------------------------------------------------------- 50 synthetic combinations vs an independent BigInt oracle (US-BL-14.4)
type Row = { gross: bigint; vatBp: bigint | null; otherBp: bigint | null; isOrderable: boolean; lineRef: string };
const halfUp = (n: bigint, bp: bigint) => (n * bp + 5000n) / 10000n;
function oracle(rows: Row[], lineDisc: Map<string, bigint>, billAmount: bigint) {
  const left = rows.map((r) => r.gross - (r.isOrderable ? lineDisc.get(r.lineRef) ?? 0n : 0n));
  const S = left.reduce((a, b) => a + b, 0n);
  const share = left.map((b) => (S === 0n ? 0n : (billAmount * b) / S));
  let rest = billAmount - share.reduce((a, b) => a + b, 0n);
  const order = left.map((b, i) => ({ i, rem: S === 0n ? 0n : (billAmount * b) % S })).sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const { i } of order) { if (rest === 0n) break; share[i]! += 1n; rest -= 1n; }
  return rows.map((r, i) => {
    const disc = (r.isOrderable ? lineDisc.get(r.lineRef) ?? 0n : 0n) + share[i]!;
    const base = r.gross - disc;
    const taxable = r.vatBp === null ? 0n : base;
    const vat = r.vatBp === null ? 0n : halfUp(taxable, r.vatBp);
    const other = r.otherBp === null ? 0n : halfUp(taxable, r.otherBp);
    return { gross: r.gross, disc, exempt: base - taxable, taxable, vat, other, net: base + vat + other };
  });
}
describe('US-BL-14.4 golden: 50 synthetic combinations match an independent oracle', () => {
  let seed = 20261107;
  const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed % n; };
  const PRICES = [1, 33, 34, 38, 50, 333, 999, 1999, 12345, 50001, 99999, 150000];
  for (let c = 0; c < 50; c++) {
    it(`combo ${String(c).padStart(2, '0')}`, async () => {
      const n = 1 + rnd(4), rows: Row[] = [], lines: any[] = [];
      for (let i = 0; i < n; i++) {
        const ref = `L${i}`, price = PRICES[rnd(PRICES.length)]!, kind = rnd(4); // 0 exempt, 1 taxable 13 %, 2 taxable + HST 2 %, 3 taxable 0 bp
        const urgent = rnd(3) === 0, sur = PRICES[rnd(PRICES.length)]!;
        const tax = kind === 0 ? { vat: 'exempt' } : kind === 1 ? { vat: 'taxable', vatRateBp: 1300 } : kind === 2 ? { vat: 'taxable', vatRateBp: 1300, otherTaxCode: 'HST', otherTaxRateBp: 200 } : { vat: 'taxable', vatRateBp: 0 };
        lines.push(line(ref, price, { tax, ...(urgent ? { priority: 'urgent', urgentSurcharge: npr(sur) } : {}) }));
        const vatBp = kind === 0 ? null : kind === 3 ? 0n : 1300n, otherBp = kind === 2 ? 200n : null;
        rows.push({ gross: BigInt(price), vatBp, otherBp, isOrderable: true, lineRef: ref });
        if (urgent) rows.push({ gross: BigInt(sur), vatBp, otherBp, isOrderable: false, lineRef: ref });
      }
      const mode = rnd(4); // 0 none, 1 line amount, 2 bill amount, 3 line + bill amounts
      const discounts: any[] = []; const lineDisc = new Map<string, bigint>(); let bill = 0n;
      if (mode === 1 || mode === 3) { const t = rows.find((r) => r.isOrderable && r.lineRef === 'L0')!; const d = BigInt(rnd(Number(t.gross) + 1)); lineDisc.set('L0', d); discounts.push({ scope: 'line', lineRef: 'L0', kind: 'amount', amountPaisa: Number(d) }); }
      if (mode === 2 || mode === 3) {
        const left = rows.reduce((s, r) => s + r.gross - (r.isOrderable ? lineDisc.get(r.lineRef) ?? 0n : 0n), 0n);
        bill = BigInt(rnd(Number(left) + 1)); discounts.push({ scope: 'bill', kind: 'amount', amountPaisa: Number(bill) });
      }
      const want = oracle(rows, lineDisc, bill);
      const got = await q(lines, discounts);
      expect(got.lines).toHaveLength(want.length);
      got.lines.forEach((l: any, i: number) => expect([l.gross, l.discount, l.exempt, l.taxable, l.vat, l.otherTax, l.net].map((m: any) => BigInt(m.amountPaisa)),
        `row ${i}`).toEqual([want[i]!.gross, want[i]!.disc, want[i]!.exempt, want[i]!.taxable, want[i]!.vat, want[i]!.other, want[i]!.net]));
      const sum = (k: keyof (typeof want)[number]) => want.reduce((s, w) => s + (w[k] as bigint), 0n);
      expect([got.totals.gross, got.totals.discount, got.totals.exempt, got.totals.taxable, got.totals.vat, got.totals.otherTax, got.totals.net].map((m: any) => BigInt(m.amountPaisa)))
        .toEqual([sum('gross'), sum('disc'), sum('exempt'), sum('taxable'), sum('vat'), sum('other'), sum('net')]);
    });
  }
});
