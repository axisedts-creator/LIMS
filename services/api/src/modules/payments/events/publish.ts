// C15 PG-T10 — typed publisher for payments.intent.settled.v1 (02-TRD §8.1; 03-IC §3.20 / §10.6).
// Core publish validates payload against contracts/events schema (additionalProperties:false) and fails closed; the row is written in the caller's tx.
export const SETTLED_EVENT = 'payments.intent.settled.v1';

export const settledIdempotencyKey = (p: { gateway: string; gateway_txn_ref: string }): string => `${p.gateway}:${p.gateway_txn_ref}:settled`;

export interface EventsPort {
  publish(ctx: any, type: string, input: { aggregate: { type: string; id: string; seq: number }; idempotencyKey: string; payload: Record<string, unknown> }):
    Promise<{ eventId: string; duplicate: boolean }>;
}

export function createPaymentsEvents(events: EventsPort) {
  return {
    intentSettled: (ctx: any, payload: Record<string, any>, o: { intentVersion: number }) =>
      events.publish(ctx, SETTLED_EVENT, {
        aggregate: { type: 'payment_intent', id: payload['intent_id'], seq: o.intentVersion },
        idempotencyKey: settledIdempotencyKey({ gateway: payload['gateway'], gateway_txn_ref: payload['gateway_txn_ref'] }),
        payload,
      }),
  };
}
