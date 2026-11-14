// homecollection.collection.synced.v1 -> engagement (02-TRD §4.8 "Completion of home_collection bookings", §7.2; 01-PRD US-EN-14.7; 08 A19 D-120).
// payload.booking_id present AND that booking is home_collection AND confirmed|checked_in -> completed (system), order_id = payload.order_id, transition row, NO event.
// Everything else (no booking_id, unknown / foreign-tenant / terminal / centre_visit booking, duplicate delivery) is a silent no-op. The tenant is the job tenant, never a payload value (REQ-SEC-024).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { ConsumerHandler } from '../../../core/manifest.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const handle: ConsumerHandler = async (event, ctx) => {
  const bookingId = event?.payload?.booking_id, orderId = event?.payload?.order_id;
  if (typeof bookingId !== 'string' || !UUID.test(bookingId) || typeof orderId !== 'string' || !UUID.test(orderId)) return; // absent booking_id = a visit of another kind
  if (typeof ctx.tenantId !== 'string' || !ctx.tenantId || event.tenant_id !== ctx.tenantId) return;
  const { rows } = await ctx.tx.query(
    'SELECT centre_id, booking_kind, status, version FROM engagement.bookings WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, bookingId]);
  const b = rows[0];
  if (!b || b.booking_kind !== 'home_collection' || (b.status !== 'confirmed' && b.status !== 'checked_in')) return;
  // conditional on version + live status: a concurrent delivery / cancel wins, this one updates nothing
  const done = await ctx.tx.query(
    `UPDATE engagement.bookings SET status = 'completed', completed_at = $4, order_id = $5, version = version + 1, updated_at = now(), updated_by = $6
     WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status IN ('confirmed', 'checked_in') RETURNING id`,
    [ctx.tenantId, bookingId, b.version, ctx.now(), orderId, ctx.actor.id]);
  if (done.rows.length === 0) return;
  await ctx.tx.query(
    `INSERT INTO engagement.booking_transitions (id, tenant_id, booking_id, centre_id, from_status, to_status, reason_code, actor_type, actor_id, occurred_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'completed', NULL, 'system', $6, $7, $6)`,
    [uuidv7(), ctx.tenantId, bookingId, b.centre_id, b.status, ctx.actor.id, ctx.now()]);
};
