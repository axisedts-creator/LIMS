// BL-T06 fixture sanity: the literals the BL-T06 tests hard-code (FY, number shape, quote totals, event envelopes) agree with the already-shipped domain code.
// Passes today; keeps the oracle honest while the BL-T06 implementation is missing.
import { describe, expect, it } from 'vitest';
import { fiscalYearOf } from '../../domain/fiscalYear.js';
import { formatDocumentNumber } from '../../domain/numberFormat.js';
import { createEvents } from '../../../../core/events/publish.js';
import { computeQuote } from '../quote.service.js';
import { BASE, FY_LONG, FY_SHORT, IDS, issueInput, line, makeWorld, V7 } from './t06.helpers.js';

describe('t06 fixtures', () => {
  it('BASE falls in BS FY 2083/84 and the tenant pattern renders 083/84-000001', () => {
    const fy = fiscalYearOf(BASE as never, 'Asia/Kathmandu');
    expect(fy).toEqual({ short: FY_SHORT, long: FY_LONG });
    expect(formatDocumentNumber('{fy}-{seq:6}', { fy, seq: 1 })).toBe('083/84-000001');
    expect(formatDocumentNumber('{branch}/{fy}-{seq:6}', { fy, seq: 1, branch: 'KTM', scope: 'branch' })).toBe('KTM/083/84-000001');
  });
  it('line() prices to gross 1,000.00 / VAT 130.00 / net 1,130.00; 500.00 exempt stays 500.00', async () => {
    const w = makeWorld(); const ctx = w.ctx();
    const q = await computeQuote(ctx, { lines: [line()], discounts: [] });
    expect(q.totals).toMatchObject({ gross: { amountPaisa: 100000 }, vat: { amountPaisa: 13000 }, net: { amountPaisa: 113000 } });
    const q2 = await computeQuote(ctx, { lines: [line({ unitPrice: { amountPaisa: 20000, currency: 'NPR' } })], discounts: [] });
    expect(q2.totals.net.amountPaisa).toBe(22600);
    expect((await issueInput(ctx)).expectedFingerprint).toBe(q.fingerprint);
  });
  it('the real publisher accepts a valid billing.invoice.issued.v1 envelope through the world tx and stores it (so schema failures in BL-T06 tests are the code\'s)', async () => {
    const w = makeWorld(); const ctx = w.ctx() as never;
    const ev = createEvents({ producer: 'billing' });
    await w.tx(() => ev.publish(ctx, 'billing.invoice.issued.v1', {
      aggregate: { type: 'invoice', id: V7('000000a00001'), seq: 1 }, idempotencyKey: `${V7('000000a00001')}:issued`,
      payload: { invoice_id: V7('000000a00001'), invoice_no: '083/84-000001', fiscal_year_bs: FY_LONG, invoice_kind: 'tax_invoice', order_id: IDS.order, branch_id: IDS.branch, centre_id: IDS.centre,
        issued_at: BASE, totals: Object.fromEntries(['gross', 'discount', 'exempt', 'taxable', 'vat', 'other_tax', 'net'].map((k) => [k, { amount_paisa: 0, currency: 'NPR' }])) },
    }));
    expect(w.events_of('billing.invoice.issued.v1')).toHaveLength(1);
  });
  it('world.tx rolls the in-memory state back together with the event db', async () => {
    const w = makeWorld();
    await w.tx(async () => { w.s.counterNo = 5; throw new Error('x'); }).catch(() => undefined);
    expect(w.s.counterNo).toBe(0);
  });
});
