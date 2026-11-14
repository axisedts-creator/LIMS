// engagement.reconcile_bookings (*/10) + engagement.mark_no_shows (*/15), centre_visit only (02-TRD §4.8 "Completion / no-show", §8.2; 01-PRD US-EN-14.4, 14.5; 08 A19 D-120).
// reconcile: order registered|in_progress|completed -> booking completed (no event); order cancelled -> booking cancelled lab_unavailable by system (NO event, TRD §7.1); pre_registered -> only order_id stored.
// mark_no_shows: auto_no_show on && slot_end + no_show_grace_minutes < now (strict) && order pre_registered or none -> cancelled no_show by system + engagement.booking.cancelled.v1; slot_occupancy is NOT released (slot is past).
// home_collection bookings are never selected here: they complete only from homecollection.collection.synced.v1 (consumer).
// Tenant guard (REQ-SEC-024): acts only when payload.tenant_id is a uuid equal to the job's tenant; every statement binds tenant_id; ids are always bound parameters.
// Statements stay in the FakeDb subset (no OR / JOIN / arithmetic): window and grace maths are done here with bound cut-off values.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { TaskHandler } from '../../../core/manifest.js';

export const RECONCILE_BOOKINGS = 'engagement.reconcile_bookings';
export const MARK_NO_SHOWS = 'engagement.mark_no_shows';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const COLS = 'id, patient_id, centre_id, booking_kind, slot_start, slot_end, status, order_id, version';
const RETURNING = 'id, patient_id, centre_id, booking_kind, slot_start, status, version';
const LIVE = ['confirmed', 'checked_in'];
const DONE_ORDER = new Set(['registered', 'in_progress', 'completed']);
type Row = Record<string, any>;

const ownTenant = (payload: { tenant_id?: unknown }, ctxTenant: string | undefined): string | undefined => {
  const t = payload?.tenant_id;
  return typeof t === 'string' && UUID.test(t) && ctxTenant === t ? t : undefined;
};

/** Live centre_visit bookings whose slot starts in [now - 7 d, now + 1 d] (TRD §4.8). */
async function candidates(ctx: any, tenantId: string, statuses: string[], toMs: number): Promise<Row[]> {
  const now = Date.parse(ctx.now());
  const { rows } = await ctx.tx.query(
    `SELECT ${COLS} FROM engagement.bookings WHERE tenant_id = $1 AND booking_kind = 'centre_visit' AND status = ANY($2::text[]) AND slot_start >= $3 AND slot_start <= $4`,
    [tenantId, statuses, new Date(now - 7 * DAY_MS).toISOString(), new Date(toMs).toISOString()]);
  return rows;
}

/** booking id -> its order (frontdesk.v_pub_order_status is a security_invoker view: read only). A booking with several orders keeps the most advanced one. */
async function ordersOf(ctx: any, tenantId: string, bookings: Row[]): Promise<Map<string, Row>> {
  const byBooking = new Map<string, Row>();
  if (bookings.length === 0) return byBooking;
  const { rows } = await ctx.tx.query(
    'SELECT order_id, source_ref_id, status FROM frontdesk.v_pub_order_status WHERE tenant_id = $1 AND source = $2 AND source_ref_id = ANY($3::uuid[])',
    [tenantId, 'engagement_booking', bookings.map((b) => b.id)]);
  for (const r of rows as Row[]) {
    const seen = byBooking.get(r.source_ref_id);
    if (!seen || (DONE_ORDER.has(r.status) && !DONE_ORDER.has(seen.status))) byBooking.set(r.source_ref_id, r);
  }
  return byBooking;
}

const transition = (ctx: any, tenantId: string, b: Row, to: string, reason: string | null) => ctx.tx.query(
  `INSERT INTO engagement.booking_transitions (id, tenant_id, booking_id, centre_id, from_status, to_status, reason_code, actor_type, actor_id, occurred_at, created_by)
   VALUES ($1, $2, $3, $4, $5, $6, $7, 'system', $8, $9, $8)`,
  [uuidv7(), tenantId, b.id, b.centre_id, b.status, to, reason, ctx.actor.id, ctx.now()]);

/** Conditional on version + live status: a lost race updates nothing (undefined). */
async function complete(ctx: any, tenantId: string, b: Row, orderId: string | null): Promise<Row | undefined> {
  const { rows } = await ctx.tx.query(
    `UPDATE engagement.bookings SET status = 'completed', completed_at = $4, order_id = COALESCE($5, order_id), version = version + 1, updated_at = now(), updated_by = $6
     WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status IN ('confirmed', 'checked_in') RETURNING ${RETURNING}`,
    [tenantId, b.id, b.version, ctx.now(), orderId, ctx.actor.id]);
  return rows[0];
}
async function cancel(ctx: any, tenantId: string, b: Row, reason: string, orderId: string | null): Promise<Row | undefined> {
  const { rows } = await ctx.tx.query(
    `UPDATE engagement.bookings SET status = 'cancelled', cancelled_at = $4, cancel_reason_code = $5, cancelled_by_kind = 'system', order_id = COALESCE($6, order_id), version = version + 1, updated_at = now(), updated_by = $7
     WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status IN ('confirmed', 'checked_in') RETURNING ${RETURNING}`,
    [tenantId, b.id, b.version, ctx.now(), reason, orderId, ctx.actor.id]);
  return rows[0];
}

export const reconcileBookings: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ownTenant(payload, ctx.tenantId);
  if (!tenantId) return;
  const now = Date.parse(ctx.now());
  const bookings = await candidates(ctx, tenantId, LIVE, now + DAY_MS);
  const orders = await ordersOf(ctx, tenantId, bookings);
  for (const b of bookings) {
    const o = orders.get(b.id);
    if (!o) continue;
    if (DONE_ORDER.has(o.status)) {
      if (await complete(ctx, tenantId, b, o.order_id)) await transition(ctx, tenantId, b, 'completed', null);
    } else if (o.status === 'cancelled') {
      if (await cancel(ctx, tenantId, b, 'lab_unavailable', o.order_id)) await transition(ctx, tenantId, b, 'cancelled', 'lab_unavailable'); // TRD §7.1: no event
    } else if (o.status === 'pre_registered' && b.order_id !== o.order_id) {
      await ctx.tx.query(
        `UPDATE engagement.bookings SET order_id = $4, version = version + 1, updated_at = now(), updated_by = $5
         WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status IN ('confirmed', 'checked_in')`, [tenantId, b.id, b.version, o.order_id, ctx.actor.id]);
    }
  }
};

export const markNoShows: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ownTenant(payload, ctx.tenantId);
  if (!tenantId) return;
  const { rows: s } = await ctx.tx.query('SELECT auto_no_show, no_show_grace_minutes FROM engagement.settings WHERE tenant_id = $1', [tenantId]);
  if (s[0]?.auto_no_show !== true) return; // no settings row = feature never switched on = off
  const now = Date.parse(ctx.now()), graceMs = Number(s[0].no_show_grace_minutes) * 60_000;
  // confirmed only: a checked-in patient showed up (TRD §4.8 names pre_registered orders)
  const late = (await candidates(ctx, tenantId, ['confirmed'], now)).filter((b) => Date.parse(b.slot_end) + graceMs < now);
  const orders = await ordersOf(ctx, tenantId, late);
  for (const b of late) {
    const o = orders.get(b.id);
    if (o && o.status !== 'pre_registered') continue; // registered+ -> reconcile completes it; cancelled -> reconcile cancels it silently
    const row = await cancel(ctx, tenantId, b, 'no_show', o?.order_id ?? null);
    if (!row) continue;
    await transition(ctx, tenantId, b, 'cancelled', 'no_show');
    await ctx.events.publish(ctx, 'engagement.booking.cancelled.v1', {
      aggregate: { type: 'booking', id: b.id, seq: row.version }, idempotencyKey: `${b.id}:cancelled`,
      payload: { booking_id: b.id, patient_id: b.patient_id, booking_kind: 'centre_visit', reason_code: 'no_show', cancelled_by_kind: 'system', ...(o ? { order_id: o.order_id } : {}), slot_start: b.slot_start, cancelled_at: ctx.now() } });
  }
};
