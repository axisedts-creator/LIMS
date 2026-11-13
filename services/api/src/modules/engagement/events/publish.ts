// Producer side of the two booking events (02-TRD §4.8 steps 6 / cancel, §7.1; 03-IC §3.22; contracts/events/engagement.booking.{confirmed,cancelled}.v1.schema.json).
// The core publisher (ctx.events.publish) validates the envelope against the schema (additionalProperties:false) and dedups on (tenant, event_type, idempotency_key), in the caller's transaction.
// Payloads carry ids and instants only: no booking_no, no name, no phone (07-SECURITY §6, P2). `home_visit_id` is not known to C16 and is never sent.
type Publisher = { publish(ctx: never, type: string, input: { aggregate: { type: string; id: string; seq: number }; idempotencyKey: string; payload: Record<string, unknown> }): Promise<unknown> };
export type EventCtx = { readonly events: unknown };

const publisher = (ctx: EventCtx): Publisher => ctx.events as Publisher;

export interface ConfirmedFacts {
  bookingId: string; patientId: string; branchId: string; centreId: string; bookingKind: string; slotStart: string; slotEnd: string; orderableIds: readonly string[]; confirmedAt: string; homeAddressId?: string | null;
}
/** seq = booking version after create (1); idempotency key `<booking_id>:confirmed` (TRD §7.1). */
export async function publishBookingConfirmed(ctx: EventCtx, f: ConfirmedFacts): Promise<void> {
  await publisher(ctx).publish(ctx as never, 'engagement.booking.confirmed.v1', {
    aggregate: { type: 'booking', id: f.bookingId, seq: 1 },
    idempotencyKey: `${f.bookingId}:confirmed`,
    payload: {
      booking_id: f.bookingId, patient_id: f.patientId, branch_id: f.branchId, centre_id: f.centreId, booking_kind: f.bookingKind, slot_start: f.slotStart, slot_end: f.slotEnd,
      orderable_ids: [...f.orderableIds], ...(f.homeAddressId ? { home_address_id: f.homeAddressId } : {}), confirmed_at: f.confirmedAt,
    },
  });
}

export interface CancelledFacts {
  bookingId: string; patientId: string; bookingKind: string; reasonCode: string; cancelledByKind: 'patient' | 'staff' | 'system'; cancelledAt: string; slotStart: string; orderId?: string | null; version: number;
}
/** seq = booking version after the cancel; idempotency key `<booking_id>:cancelled`: a replay (or a re-applied write) leaves ONE event. */
export async function publishBookingCancelled(ctx: EventCtx, f: CancelledFacts): Promise<void> {
  await publisher(ctx).publish(ctx as never, 'engagement.booking.cancelled.v1', {
    aggregate: { type: 'booking', id: f.bookingId, seq: f.version },
    idempotencyKey: `${f.bookingId}:cancelled`,
    payload: {
      booking_id: f.bookingId, patient_id: f.patientId, booking_kind: f.bookingKind, reason_code: f.reasonCode, cancelled_by_kind: f.cancelledByKind,
      ...(f.orderId ? { order_id: f.orderId } : {}), slot_start: f.slotStart, cancelled_at: f.cancelledAt,
    },
  });
}
