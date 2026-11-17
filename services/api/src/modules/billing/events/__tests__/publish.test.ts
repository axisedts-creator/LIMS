// BL-T06 — typed publishers for billing.invoice.issued.v1 and billing.balance.changed.v1 (event payload tests).
// 02-TRD §8.1 (exact triggers, idempotency keys, aggregate seq); 03-IC §3.4/§3.5; PRD US-FD-03.1, US-BL-13; 08 A13 D-1 (periodic credit bill omits order_id/centre_id).
// Fails now: ../publish.js does not exist.
// ASSUMED API (same seam as lab/events/publish.ts; writer: object via a dispute if wrong):
//   export function createBillingEvents(events: { publish(ctx, type, input): Promise<{ eventId: string; duplicate: boolean }> })
//     -> { invoiceIssued(ctx, payload)   aggregate { invoice, payload.invoice_id, seq 1 },                key `<invoice_id>:issued`
//          balanceChanged(ctx, payload)  aggregate { order_balance, payload.order_id, seq balance_version }, key `<order_id>:balance:<balance_version>` }
//   `payload` = the 03-IC payload exactly (snake_case; Money = {amount_paisa:int, currency:'NPR'}); the publisher adds no keys and the real core publish validates.
import { describe, expect, it } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { ctxFor, makeEventDb, rejection } from '../../../../core/events/__tests__/helpers.js';
import { createBillingEvents } from '../publish.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const INV = V7('000000a00001'), ORDER = V7('000000050001'), CENTRE = V7('000000020002'), BRANCH = V7('000000010001'), PARTY = V7('000000b00001');
const M = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const TOTALS = { gross: M(100000), discount: M(0), exempt: M(0), taxable: M(100000), vat: M(13000), other_tax: M(0), net: M(113000) };

const issuedP = (over: Record<string, unknown> = {}) => ({
  invoice_id: INV, invoice_no: '083/84-000001', fiscal_year_bs: '2083/84', invoice_kind: 'tax_invoice', order_id: ORDER, branch_id: BRANCH, centre_id: CENTRE,
  issued_at: '2026-11-08T06:00:01.000Z', totals: TOTALS, ...over,
});
const balanceP = (over: Record<string, unknown> = {}) => ({
  order_id: ORDER, balance_version: 1, invoiced: M(113000), paid: M(0), credited: M(0), balance_due: M(113000), cause: 'invoice_issued', release_eligible: false,
  release_basis: 'due_outstanding', ...over,
});

function setup() {
  const db = makeEventDb();
  const bl = createBillingEvents(createEvents({ producer: 'billing' }) as never);
  const ctx = ctxFor(db) as never;
  const run = <T>(fn: () => Promise<T>) => db.transaction(fn);
  const stored = (type: string) => db.events.filter((e) => e.eventType === type);
  return { db, bl, ctx, run, stored };
}

describe('billing.invoice.issued.v1', () => {
  it('order invoice: stored once, key <invoice_id>:issued, aggregate invoice seq 1, producer billing, payload verbatim', async () => {
    const { bl, ctx, run, stored } = setup();
    const out = await run(() => bl.invoiceIssued(ctx, issuedP()));
    expect(out.duplicate).toBe(false);
    const [e] = stored('billing.invoice.issued.v1');
    expect(e!.key).toBe(`${INV}:issued`);
    expect(e!.envelope.producer).toBe('billing');
    expect(e!.envelope.aggregate).toEqual({ type: 'invoice', id: INV, seq: 1 });
    expect(e!.envelope.payload).toEqual(issuedP());
  });
  it('same invoice published twice in one tx -> second is a duplicate no-op (exactly one event)', async () => {
    const { bl, ctx, run, stored } = setup();
    await run(async () => { await bl.invoiceIssued(ctx, issuedP()); const again = await bl.invoiceIssued(ctx, issuedP()); expect(again.duplicate).toBe(true); });
    expect(stored('billing.invoice.issued.v1')).toHaveLength(1);
  });
  it('periodic credit bill (D-1): credit_party_id + is_periodic_credit_bill, NO order_id / centre_id -> valid', async () => {
    const { bl, ctx, run, stored } = setup();
    const p = { ...issuedP(), is_periodic_credit_bill: true, credit_party_id: PARTY };
    delete (p as Record<string, unknown>)['order_id']; delete (p as Record<string, unknown>)['centre_id'];
    await run(() => bl.invoiceIssued(ctx, p));
    expect(stored('billing.invoice.issued.v1')).toHaveLength(1);
  });
  it('schema failures fail closed with common.internal and store nothing: missing centre_id on an order invoice, order_id on a periodic bill, extra PHI key, non-integer paisa', async () => {
    const bad: Array<Record<string, unknown>> = [
      (() => { const p = issuedP(); delete (p as Record<string, unknown>)['centre_id']; return p; })(),
      issuedP({ is_periodic_credit_bill: true, credit_party_id: PARTY }), // still carries order_id + centre_id
      issuedP({ buyer_name: 'Synthetic Buyer One' }),
      issuedP({ buyer_pan: '123456789' }),
      issuedP({ totals: { ...TOTALS, net: M(1130.5) } }),
      issuedP({ invoice_kind: 'invoice' }),
    ];
    for (const p of bad) {
      const { bl, ctx, run, stored } = setup();
      const e = await rejection(run(() => bl.invoiceIssued(ctx, p)));
      expect(e.code, JSON.stringify(Object.keys(p))).toBe('common.internal');
      expect(stored('billing.invoice.issued.v1')).toHaveLength(0);
    }
  });
  it('rollback of the caller tx drops the event (same-transaction guarantee)', async () => {
    const { db, bl, ctx } = setup();
    await rejection(db.transaction(async () => { await bl.invoiceIssued(ctx, issuedP()); throw new Error('later step failed'); }));
    expect(db.events).toHaveLength(0);
  });
});

describe('billing.balance.changed.v1', () => {
  it('stored once, key <order_id>:balance:<version>, aggregate order_balance seq = balance_version', async () => {
    const { bl, ctx, run, stored } = setup();
    await run(() => bl.balanceChanged(ctx, balanceP({ balance_version: 3, cause: 'payment_recorded', paid: M(100000), balance_due: M(13000) })));
    const [e] = stored('billing.balance.changed.v1');
    expect(e!.key).toBe(`${ORDER}:balance:3`);
    expect(e!.envelope.aggregate).toEqual({ type: 'order_balance', id: ORDER, seq: 3 });
    expect(e!.envelope.payload.cause).toBe('payment_recorded');
  });
  it('strictly increasing versions -> distinct keys; the same version twice -> one event (one balance event per balance change)', async () => {
    const { bl, ctx, run, stored } = setup();
    await run(async () => {
      for (const v of [1, 2, 3]) await bl.balanceChanged(ctx, balanceP({ balance_version: v }));
      expect((await bl.balanceChanged(ctx, balanceP({ balance_version: 3 }))).duplicate).toBe(true);
    });
    expect(stored('billing.balance.changed.v1').map((e) => e.envelope.aggregate.seq)).toEqual([1, 2, 3]);
  });
  it('every cause in the TRD §8.1 mapping validates; an unknown cause, version 0, or an unknown release_basis is refused', async () => {
    for (const cause of ['invoice_issued', 'invoice_cancelled', 'payment_recorded', 'payment_reversed', 'credit_note_issued', 'gateway_payment_recorded']) {
      const { bl, ctx, run, stored } = setup();
      await run(() => bl.balanceChanged(ctx, balanceP({ cause })));
      expect(stored('billing.balance.changed.v1')).toHaveLength(1);
    }
    for (const over of [{ cause: 'refund' }, { balance_version: 0 }, { release_basis: 'maybe' }, { patient_id: V7('000000040001') }]) {
      const { bl, ctx, run, stored } = setup();
      expect((await rejection(run(() => bl.balanceChanged(ctx, balanceP(over))))).code).toBe('common.internal');
      expect(stored('billing.balance.changed.v1')).toHaveLength(0);
    }
  });
});
