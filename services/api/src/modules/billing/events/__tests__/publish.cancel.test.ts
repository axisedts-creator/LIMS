// BL-T10 — typed publisher for billing.invoice.cancelled.v1 (event payload tests). 02-TRD §8.1 (trigger: commit of cancelInvoice; key <invoice_id>:cancelled; aggregate seq = invoice version after cancel);
// 03-IC (payload); contracts/events/billing.invoice.cancelled.v1.schema.json (additionalProperties false); PRD US-BL-04.1; 07-SECURITY REQ-SEC-006 (no PHI / free text in events).
// Fails now: createBillingEvents(...).invoiceCancelled is not a function (events/publish.ts only has invoiceIssued / balanceChanged).
// ASSUMED API (same seam as invoiceIssued/balanceChanged; writer: object via a dispute if wrong):
//   invoiceCancelled(ctx, payload, invoiceVersion: number)  aggregate { invoice, payload.invoice_id, seq: invoiceVersion }, key `<invoice_id>:cancelled`; the payload goes through verbatim
//   (the version is not a payload field: the schema forbids extra keys); a version that is not a positive integer is refused before anything is stored.
import { describe, expect, it } from 'vitest';
import { ctxFor, makeEventDb, rejection } from '../../../../core/events/__tests__/helpers.js';
import { createEvents } from '../../../../core/events/publish.js';
import { createBillingEvents } from '../publish.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const INV = V7('000000a00001'), ORDER = V7('000000050001'), CN = V7('000000c00001');
const M = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const cancelledP = (over: Record<string, unknown> = {}) => ({
  invoice_id: INV, invoice_no: '083/84-000001', fiscal_year_bs: '2083/84', order_id: ORDER, credit_note_id: CN, credit_note_no: 'CN-083/84-000001', reason_code: 'billing_error',
  cancelled_at: '2026-11-08T06:00:02.000Z', credited_total: M(163000), ...over,
});
function setup() {
  const db = makeEventDb();
  const bl = createBillingEvents(createEvents({ producer: 'billing' }) as never) as any;
  const ctx = ctxFor(db) as never;
  return { db, bl, ctx, run: <T>(fn: () => Promise<T>) => db.transaction(fn), stored: () => db.events.filter((e) => e.eventType === 'billing.invoice.cancelled.v1') };
}

describe('billing.invoice.cancelled.v1', () => {
  it('stored once: key <invoice_id>:cancelled, aggregate invoice with seq = the invoice version after the cancel, producer billing, payload verbatim', async () => {
    const { bl, ctx, run, stored } = setup();
    const out = await run(() => bl.invoiceCancelled(ctx, cancelledP(), 2));
    expect(out.duplicate).toBe(false);
    const [e] = stored();
    expect(e!.key).toBe(`${INV}:cancelled`);
    expect(e!.envelope.producer).toBe('billing');
    expect(e!.envelope.aggregate).toEqual({ type: 'invoice', id: INV, seq: 2 });
    expect(e!.envelope.payload).toEqual(cancelledP());
  });
  it('a cancel after earlier partial credits has a higher version (seq 4) and the same key shape', async () => {
    const { bl, ctx, run, stored } = setup();
    await run(() => bl.invoiceCancelled(ctx, cancelledP(), 4));
    expect(stored()[0]!.envelope.aggregate.seq).toBe(4);
  });
  it('periodic credit bill: order_id is optional (no order) -> valid', async () => {
    const { bl, ctx, run, stored } = setup();
    const p = cancelledP(); delete (p as Record<string, unknown>)['order_id'];
    await run(() => bl.invoiceCancelled(ctx, p, 2));
    expect(stored()).toHaveLength(1);
  });
  it('same invoice published twice in one tx -> second is a duplicate no-op (exactly one event)', async () => {
    const { bl, ctx, run, stored } = setup();
    await run(async () => { await bl.invoiceCancelled(ctx, cancelledP(), 2); expect((await bl.invoiceCancelled(ctx, cancelledP(), 2)).duplicate).toBe(true); });
    expect(stored()).toHaveLength(1);
  });
  it('schema failures fail closed with common.internal and store nothing: missing credit_note_no / credited_total, extra PHI or free-text keys (buyer name, PAN, reason text), non-integer paisa, bad fiscal year, bad instant', async () => {
    const without = (k: string) => { const p = cancelledP(); delete (p as Record<string, unknown>)[k]; return p; };
    const bad: Array<Record<string, unknown>> = [
      without('credit_note_no'), without('credited_total'), without('cancelled_at'), without('reason_code'),
      cancelledP({ buyer_name: 'Synthetic Buyer One' }), cancelledP({ buyer_pan: '123456789' }), cancelledP({ reason_text: 'free text' }), cancelledP({ patient_id: V7('000000040001') }),
      cancelledP({ credited_total: M(1630.5) }), cancelledP({ fiscal_year_bs: '083/84' }), cancelledP({ cancelled_at: '08-11-2026' }), cancelledP({ invoice_id: 'not-a-uuid' }),
    ];
    for (const p of bad) {
      const { bl, ctx, run, stored } = setup();
      const e = await rejection(run(() => bl.invoiceCancelled(ctx, p, 2)));
      expect(e.code, JSON.stringify(Object.keys(p))).toBe('common.internal');
      expect(stored()).toHaveLength(0);
    }
  });
  it('a version that is not a positive integer is refused and nothing is stored', async () => {
    for (const v of [0, -1, 1.5, Number.NaN, undefined, '2']) {
      const { bl, ctx, run, stored } = setup();
      const e = await rejection(run(() => bl.invoiceCancelled(ctx, cancelledP(), v)));
      expect(typeof e.code, String(v)).toBe('string'); // a refusal by the publisher / core, not a TypeError
      expect(stored(), String(v)).toHaveLength(0);
    }
  });
  it('rollback of the caller tx drops the event (same-transaction guarantee)', async () => {
    const { db, bl, ctx } = setup();
    const e = await rejection(db.transaction(async () => { await bl.invoiceCancelled(ctx, cancelledP(), 2); throw new Error('later step failed'); }));
    expect(e.message).toBe('later step failed');
    expect(db.events).toHaveLength(0);
  });
});
