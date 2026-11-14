// HC-T05: booking consumers' entry points (02-TRD §8.2/§8.3, 03-IC §3.22/§3.24, US-01, US-10). Everything runs in ctx.tx (the queue's per-delivery tx); the handler wrapper checks event.tenant_id.
// One advisory lock per (tenant, booking) serialises confirmed / cancelled / redeliveries, so a loser sees the winner's committed row instead of a raw unique violation.
// Messages and logs carry codes only: no address, name or event field is ever echoed (07-SECURITY §6).
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { getBookingRefByBookingId, insertBookingRef, updateBookingRef } from '../repository/bookingRefs.repo.js';
import type { Tx } from '../repository/shared.repo.js';
import { getRouteById, updateRoute } from '../repository/routes.repo.js';
import { insertVisitFlag, listVisitFlagsByVisit } from '../repository/visitFlags.repo.js';
import { insertVisitTransition } from '../repository/visitTransitions.repo.js';
import { getVisitByBookingId, getVisitById, getVisitByOrderId, insertVisit, updateVisit } from '../repository/visits.repo.js';
import { enqueueSpecimenRefresh } from '../specimen.service.js';

type Obj = Record<string, any>;
export interface BookingCtx {
  readonly tenantId: string; readonly tx: Tx; now(): string | Date;
  readonly db: { tx<T>(fn: (c: any) => Promise<T>): Promise<T> };
  readonly ports: { readonly EngagementPort: { getHomeAddress(c: unknown, i: { homeAddressId: string; purpose: 'home_visit' }): Promise<Obj | null | undefined> } };
  readonly log: { warn(o: unknown, m?: string): void };
  readonly audit: { access(e: { action: string; entityType: string; entityId: string; purpose?: string; outcome: 'allowed' | 'denied' }): Promise<void> };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bad = (): LimsError => new LimsError('common.validation_failed');
const uuid = (v: unknown): string => { if (typeof v !== 'string' || !UUID.test(v)) throw bad(); return v; };
const optUuid = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : uuid(v));
const seqOf = (v: unknown): number => { if (!Number.isInteger(v) || (v as number) < 0) throw bad(); return v as number; };
const instant = (v: unknown): Date => { const d = new Date(typeof v === 'string' ? v : NaN); if (Number.isNaN(d.getTime())) throw bad(); return d; };

async function lock(c: BookingCtx, bookingId: string): Promise<void> {
  await c.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${c.tenantId}:homecollection.booking:${bookingId}`]);
}
const conflict = (): LimsError => new LimsError('common.version_conflict');   // lost an optimistic write (cannot happen under the booking lock): the queue retries the delivery

async function upsertRef(c: BookingCtx, ref: Obj | null, bookingId: string, patch: { state: string; last_seq: number; visit_id?: string | null }): Promise<void> {
  if (!ref) { await insertBookingRef(c.tx, c.tenantId, { id: uuidv7(), booking_id: bookingId, ...patch, visit_id: patch.visit_id ?? null }); return; }
  if (!(await updateBookingRef(c.tx, c.tenantId, ref['id'], ref['version'], { ...patch, visit_id: patch.visit_id ?? ref['visit_id'] }))) throw conflict();
}

async function raiseFlag(c: BookingCtx, visit: Obj, kind: string, relatedId?: string | null): Promise<void> {
  const open = (await listVisitFlagsByVisit(c.tx, c.tenantId, visit['id'])).some((f) => f['kind'] === kind && f['status'] === 'open' && (f['related_id'] ?? null) === (relatedId ?? null));
  if (!open) await insertVisitFlag(c.tx, c.tenantId, { id: uuidv7(), centre_id: visit['centre_id'], visit_id: visit['id'], kind, status: 'open', ...(relatedId ? { related_id: relatedId } : {}) });
}

const transition = (c: BookingCtx, visit: Obj, from: string | null, to: string, reason?: string) =>
  insertVisitTransition(c.tx, c.tenantId, { id: uuidv7(), centre_id: visit['centre_id'], visit_id: visit['id'], from_status: from, to_status: to, cause: 'consumer',
    ...(reason ? { reason_code: reason } : {}), at: new Date(c.now()) });

/** EngagementPort result -> visit columns; anything unusable (shape, length, range) counts as "no address". */
function addressColumns(a: Obj | null | undefined): Obj | null {
  const text = typeof a?.['addressText'] === 'string' ? a['addressText'].trim().slice(0, 500) : '';
  if (!text) return null;
  const lat = a?.['latitude'] == null ? NaN : Number(a['latitude']), lon = a?.['longitude'] == null ? NaN : Number(a['longitude']);
  const geo = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return { address_text: text, landmark: typeof a?.['landmark'] === 'string' && a['landmark'] ? a['landmark'].slice(0, 200) : null, latitude: geo ? lat : null, longitude: geo ? lon : null };
}

/** engagement.booking.confirmed.v1 (US-01). */
export async function onBookingConfirmed(c: BookingCtx, payload: Obj, seq: unknown): Promise<void> {
  if (payload?.['booking_kind'] !== 'home_collection') return;                                      // US-01-3: centre visits belong to C4
  const bookingId = uuid(payload['booking_id']), last = seqOf(seq);
  const patientId = uuid(payload['patient_id']), centreId = uuid(payload['centre_id']), branchId = uuid(payload['branch_id']);
  const orderables = payload['orderable_ids'];
  if (!Array.isArray(orderables) || orderables.length < 1 || orderables.length > 50) throw bad();
  const orderableIds = orderables.map(uuid), homeAddressId = optUuid(payload['home_address_id']), referrerId = optUuid(payload['referrer_id']);
  const windowStart = instant(payload['slot_start']), windowEnd = instant(payload['slot_end']);

  await lock(c, bookingId);
  const ref = await getBookingRefByBookingId(c.tx, c.tenantId, bookingId);
  if (ref?.['state'] === 'cancelled' && ref['last_seq'] >= last) return;                            // US-01-5: cancel overtook confirm
  const existing = await getVisitByBookingId(c.tx, c.tenantId, bookingId);
  if (existing) {                                                                                   // US-01-2: redelivery never rewrites the visit nor re-calls the port
    if (!ref || ref['last_seq'] < last) await upsertRef(c, ref, bookingId, { state: 'confirmed', last_seq: last, visit_id: existing['id'] });
    return;
  }

  const visitId = uuidv7();
  let address: Obj | null = null;
  if (homeAddressId) {
    try { address = addressColumns(await c.db.tx((x) => (c.ports.EngagementPort.getHomeAddress(x, { homeAddressId, purpose: 'home_visit' })))); }
    catch (e) { c.log.warn({ code: typeof (e as any)?.code === 'string' ? (e as any).code : 'unknown' }, 'homecollection.address_lookup_failed'); }   // never fails the consumer, never logs the message
    // 02-TRD §8.2 / §14: one access row per port call (success or failure); none on redelivery or without home_address_id
    await c.audit.access({ action: 'home_visit.view', entityType: 'home_visit', entityId: visitId, purpose: 'home_address_fetch', outcome: 'allowed' });
  }
  const visit = await insertVisit(c.tx, c.tenantId, { id: visitId, centre_id: centreId, branch_id: branchId, kind: 'booking', status: 'unassigned', booking_id: bookingId,
    patient_id: patientId, orderable_ids: orderableIds, ...(referrerId ? { referrer_id: referrerId } : {}), ...(homeAddressId ? { home_address_id: homeAddressId } : {}),
    window_start: windowStart, window_end: windowEnd, ...(address ?? {}) });
  await transition(c, visit, null, 'unassigned');
  if (!address) await raiseFlag(c, visit, 'address_missing');
  await upsertRef(c, ref, bookingId, { state: 'confirmed', last_seq: last, visit_id: visit['id'] });
}

/** frontdesk.order.created.v1 (US-02, 02-TRD §8.2): home + front_desk -> front_desk visit; home + home_collection -> order_registered_at on source_ref_id; else ignored. */
export async function onOrderCreated(c: BookingCtx, payload: Obj): Promise<void> {
  const source = payload?.['source'];
  if (payload?.['collection_mode'] !== 'home' || (source !== 'front_desk' && source !== 'home_collection')) return;   // US-02-3
  const orderId = uuid(payload['order_id']);
  if (source === 'front_desk') {
    await c.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${c.tenantId}:homecollection.order:${orderId}`]);
    if (await getVisitByOrderId(c.tx, c.tenantId, orderId)) return;                                 // redelivery / re-emit / booking-born visit already owns the order
    const referrerId = optUuid(payload['referrer_id']);
    const visit = await insertVisit(c.tx, c.tenantId, { id: uuidv7(), centre_id: uuid(payload['centre_id']), branch_id: uuid(payload['branch_id']), kind: 'front_desk', status: 'unassigned',
      patient_id: uuid(payload['patient_id']), order_id: orderId, ...(referrerId ? { referrer_id: referrerId } : {}) });
    await transition(c, visit, null, 'unassigned');
    await raiseFlag(c, visit, 'address_missing');
    await enqueueSpecimenRefresh(c, visit['id']);
    return;
  }
  const visitId = optUuid(payload['source_ref_id']);
  const visit = visitId ? await getVisitById(c.tx, c.tenantId, visitId) : null;
  if (!visit || visit['order_id'] !== orderId || visit['order_registered_at']) return;              // unknown visit, other order (guard), or already stamped (redelivery)
  if (!(await updateVisit(c.tx, c.tenantId, visit['id'], visit['version'], { order_registered_at: instant(payload['registered_at']) }))) throw conflict();
  const route = visit['route_id'] ? await getRouteById(c.tx, c.tenantId, visit['route_id']) : null;
  if (route && !(await updateRoute(c.tx, c.tenantId, route['id'], route['version'], {}))) throw conflict();   // TRD §4.1: snapshot field changed
  await enqueueSpecimenRefresh(c, visit['id']);
}

/** engagement.booking.cancelled.v1 (US-10). */
export async function onBookingCancelled(c: BookingCtx, payload: Obj, seq: unknown): Promise<void> {
  if (payload?.['booking_kind'] !== 'home_collection') return;
  const bookingId = uuid(payload['booking_id']), last = seqOf(seq), homeVisitId = optUuid(payload['home_visit_id']);
  const reason = typeof payload['reason_code'] === 'string' ? payload['reason_code'].slice(0, 500) : null;   // stored verbatim as text, never validated against visit_cancel_reasons (A13 P-4)

  await lock(c, bookingId);
  const ref = await getBookingRefByBookingId(c.tx, c.tenantId, bookingId);
  if (ref && ref['last_seq'] >= last) return;                                                       // duplicate or stale
  const visit = (homeVisitId ? await getVisitById(c.tx, c.tenantId, homeVisitId) : null) ?? await getVisitByBookingId(c.tx, c.tenantId, bookingId);
  const done = () => upsertRef(c, ref, bookingId, { state: 'cancelled', last_seq: last, visit_id: visit?.['id'] ?? null });
  if (!visit) return done();                                                                        // US-10-4: remembered for a later (stale) confirmed

  const status: string = visit['status'];
  if (status === 'unassigned' || status === 'assigned') {
    if (!(await updateVisit(c.tx, c.tenantId, visit['id'], visit['version'], { status: 'cancelled', cancelled_at: new Date(c.now()), status_reason_code: 'booking_cancelled', status_reason_text: reason }))) throw conflict();
    await transition(c, visit, status, 'cancelled', 'booking_cancelled');
    if (status === 'assigned') {                                                                    // route fields stay on the visit for history; the route's version moves
      if (visit['order_id']) await raiseFlag(c, visit, 'order_cancel_required', visit['order_id']);
      const route = visit['route_id'] ? await getRouteById(c.tx, c.tenantId, visit['route_id']) : null;
      if (route && !(await updateRoute(c.tx, c.tenantId, route['id'], route['version'], {}))) throw conflict();
    }
  } else if (status === 'in_progress' || status === 'completed') await raiseFlag(c, visit, 'cancel_requested_after_start');
  await done();                                                                                     // failed / cancelled: nothing else
}
