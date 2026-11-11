// BL-T06: typed publishers for billing.invoice.issued.v1 and billing.balance.changed.v1 (02-TRD §8.1; 03-IC §3.4/§3.5).
// Payloads go through verbatim (core validates against contracts/events/*.schema.json, additionalProperties false, so any
// non-IC key — buyer name, PAN, patient id — fails closed with common.internal and nothing is stored; REQ-SEC-006).
import { LimsError } from '../../../core/errors.js';
import type { PublishInput } from '../../../core/events/publish.js';

interface Events { publish(ctx: never, type: string, input: PublishInput): Promise<{ eventId: string; duplicate: boolean }> }
type Ctx = Parameters<Events['publish']>[0];
type Payload = Readonly<Record<string, unknown>>;

export function createBillingEvents(events: Events) {
  return {
    /** Key `<invoice_id>:issued`, aggregate invoice seq 1: one event per invoice, replays are duplicates. */
    invoiceIssued: (ctx: Ctx, p: Payload) =>
      events.publish(ctx, 'billing.invoice.issued.v1', {
        aggregate: { type: 'invoice', id: p['invoice_id'] as string, seq: 1 }, idempotencyKey: `${String(p['invoice_id'])}:issued`, payload: p,
      }),
    /** Key `<invoice_id>:cancelled`, aggregate invoice seq = the invoice version after the cancel (not a payload field: the schema forbids extra keys). */
    invoiceCancelled: async (ctx: Ctx, p: Payload, invoiceVersion: number) => {
      if (!Number.isSafeInteger(invoiceVersion) || invoiceVersion < 1) throw new LimsError('common.internal');
      return events.publish(ctx, 'billing.invoice.cancelled.v1', {
        aggregate: { type: 'invoice', id: p['invoice_id'] as string, seq: invoiceVersion }, idempotencyKey: `${String(p['invoice_id'])}:cancelled`, payload: p,
      });
    },
    /** Key `<order_id>:balance:<balance_version>`, aggregate order_balance seq = balance_version: one event per balance change. */
    balanceChanged: (ctx: Ctx, p: Payload) =>
      events.publish(ctx, 'billing.balance.changed.v1', {
        aggregate: { type: 'order_balance', id: p['order_id'] as string, seq: p['balance_version'] as number },
        idempotencyKey: `${String(p['order_id'])}:balance:${String(p['balance_version'])}`, payload: p,
      }),
  };
}
export type BillingEvents = ReturnType<typeof createBillingEvents>;
