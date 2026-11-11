// BL-T05 contract tests: the real quote engine against the C0 fake of BillingCommandPort.computeQuote (packages/fakes, IC §4.15 cases (1), (11), (12)),
// plus CatalogPort.priceFor().tax -> PricedLineInput -> quote round trip (08 R18). The shared suite packages/fakes/contract-tests/BillingCommandPort.contract.ts
// cannot be pointed at this task alone (it also exercises issueOrderInvoice/recordPayment of BL-T06..), so its computeQuote cases are repeated here.
// Fails now: ../quote.service.js does not exist.
import { describe, expect, it } from 'vitest';
import { createFakeBillingCommandPort } from '../../../../../../../packages/fakes/src/BillingCommandPort.fake';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { computeQuote } from '../quote.service.js';

const ctx = makeCtxFor()('A');
const npr = (amountPaisa: number) => ({ amountPaisa, currency: 'NPR' as const });
const PL = '01900000-0000-7000-8000-0000000c4041';
// same LINES as the shared contract file
const line = (ref: string, paisa: number, extra: object = {}) => ({
  lineRef: ref, orderableId: `01900000-0000-7000-8000-0000000c4${(0x100 + ref.length).toString(16)}`, orderableKind: 'test' as const, code: ref, name: `Synthetic ${ref}`,
  priority: 'routine' as const, unitPrice: npr(paisa), tax: { vat: 'taxable' as const, vatRateBp: 1300 }, priceListId: PL, priceListVersion: 1, priceSource: 'tenant_default' as const, ...extra,
});
const LINES = [line('CBC', 50000), line('LFT', 120000, { priority: 'urgent', urgentSurcharge: npr(20000) })];
const amounts = (r: any) => ({
  lines: r.lines.map((l: any) => [l.lineRef, l.lineKind, ...['gross', 'discount', 'exempt', 'taxable', 'vat', 'otherTax', 'net'].map((k) => l[k].amountPaisa)]),
  totals: Object.fromEntries(Object.entries(r.totals).map(([k, v]: [string, any]) => [k, v.amountPaisa])),
});
const fake = () => createFakeBillingCommandPort({ seed: 1 } as never) as any;

describe('computeQuote: real engine conforms to the port fake on unambiguous input (no half-paisa cases)', () => {
  it('(1) determinism + urgent surcharge row; same amounts as the fake, QuoteResult has the same keys', async () => {
    const real: any = await computeQuote(ctx, { lines: LINES, discounts: [] } as never);
    const again: any = await computeQuote(ctx, { lines: LINES, discounts: [] } as never);
    expect(again).toEqual(real);
    expect(real.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(real.lines.some((l: any) => l.lineKind === 'urgent_surcharge')).toBe(true);
    const f: any = await fake().computeQuote(ctx, { lines: LINES, discounts: [] });
    expect(amounts(real)).toEqual(amounts(f));
    expect(Object.keys(real).sort()).toEqual(Object.keys(f).sort());
    expect(Object.keys(real.totals).sort()).toEqual(Object.keys(f.totals).sort());
  });
  it('with a bill discount that divides exactly the amounts still match the fake', async () => {
    const d = [{ scope: 'bill', kind: 'amount', amountPaisa: 19000 }]; // 190000 gross, 10 % -> every share exact
    const real: any = await computeQuote(ctx, { lines: LINES, discounts: d } as never);
    const f: any = await fake().computeQuote(ctx, { lines: LINES, discounts: d });
    expect(amounts(real)).toEqual(amounts(f));
  });
  it('(11) missing tax rate on a line -> catalog.tax_config_missing, same code as the fake', async () => {
    const bad = [line('CBC', 50000, { tax: { vat: 'taxable' } })];
    await expect(computeQuote(ctx, { lines: bad, discounts: [] } as never)).rejects.toMatchObject({ code: 'catalog.tax_config_missing' });
    await expect(fake().computeQuote(ctx, { lines: bad, discounts: [] })).rejects.toMatchObject({ code: 'catalog.tax_config_missing' });
  });
  it('(12) baseFingerprint equals the fingerprint of the same lines quoted with discounts: []', async () => {
    const withD: any = await computeQuote(ctx, { lines: LINES, discounts: [{ scope: 'bill', kind: 'amount', amountPaisa: 1000 }] } as never);
    const none: any = await computeQuote(ctx, { lines: LINES, discounts: [] } as never);
    expect(withD.baseFingerprint).toBe(none.fingerprint);
    expect(withD.fingerprint).not.toBe(none.fingerprint);
  });
});

describe('the rate on the line is the only rate source (08 R18; PriceQuote.tax from CatalogPort.priceFor)', () => {
  it('a tax block as priceFor returns it is quoted as given: rate and hsCode snapshotted on the computed line', async () => {
    const tax = { vat: 'taxable' as const, vatRateBp: 1300, hsCode: '3822' };
    const r: any = await computeQuote(ctx, { lines: [line('CBC', 100000, { tax })], discounts: [] } as never);
    expect(r.lines[0].tax).toEqual(tax);
    expect(r.lines[0].vat.amountPaisa).toBe(13000);
  });
});
