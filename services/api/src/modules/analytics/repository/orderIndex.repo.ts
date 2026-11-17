// analytics.order_index maintenance (02-TRD §8.2; review #5: a late `order.created` completes a cancel-before-create placeholder, never overwrites a complete row).
// bd(ts) is evaluated in SQL with the same expression as the views. Caller owns the tx. expires_at = coalesce(registered_at, created_at) + 400 d (08 A17 D-45).
import { assertInstant, assertUuid, type RefreshTx } from './refresh.repo.js';

export interface OrderCreatedInput {
  readonly tenantId: string; readonly orderId: string; readonly centreId?: string | null; readonly branchId?: string | null; readonly referrerId?: string | null;
  readonly registeredAt: string; readonly eventId: string; readonly actorId: string;
}
export interface OrderCancelledInput {
  readonly tenantId: string; readonly orderId: string; readonly cancelledAt: string; readonly eventId: string; readonly actorId: string;
}

const optUuid = (v: unknown, what: string) => { if (v != null) assertUuid(v, what); return v ?? null; };

export async function upsertOrderCreated(tx: RefreshTx, a: OrderCreatedInput): Promise<void> {
  assertUuid(a.tenantId, 'tenantId'); assertUuid(a.orderId, 'orderId'); assertUuid(a.eventId, 'eventId'); assertUuid(a.actorId, 'actorId');
  assertInstant(a.registeredAt, 'registeredAt');
  const values = [a.tenantId, a.orderId, optUuid(a.centreId, 'centreId'), optUuid(a.branchId, 'branchId'), optUuid(a.referrerId, 'referrerId'), a.registeredAt, a.eventId, a.actorId];
  await tx.query(
    `INSERT INTO analytics.order_index (tenant_id, order_id, centre_id, branch_id, referrer_id, registered_at, registered_on,
       source_event_id, created_by, expires_at)
VALUES ($1, $2, $3, $4, $5, $6::timestamptz, ($6::timestamptz AT TIME ZONE 'Asia/Kathmandu')::date, $7, $8, $6::timestamptz + interval '400 days')
ON CONFLICT (tenant_id, order_id) DO UPDATE
   SET centre_id = EXCLUDED.centre_id, branch_id = EXCLUDED.branch_id, referrer_id = EXCLUDED.referrer_id,
       registered_at = EXCLUDED.registered_at, registered_on = EXCLUDED.registered_on, expires_at = EXCLUDED.expires_at
 WHERE analytics.order_index.registered_on IS NULL`,
    values);
}

/** Marks the order cancelled; no row (order predates C8 / reordered events) -> placeholder with NULL registered_at/on that a later `created` completes. */
export async function recordOrderCancelled(tx: RefreshTx, a: OrderCancelledInput): Promise<{ placeholder: boolean }> {
  assertUuid(a.tenantId, 'tenantId'); assertUuid(a.orderId, 'orderId'); assertUuid(a.eventId, 'eventId'); assertUuid(a.actorId, 'actorId');
  assertInstant(a.cancelledAt, 'cancelledAt');
  const upd = await tx.query(
    'UPDATE analytics.order_index SET cancelled_at = $3 WHERE tenant_id = $1 AND order_id = $2 AND cancelled_at IS NULL',
    [a.tenantId, a.orderId, a.cancelledAt]);
  if (Number(upd.rowCount ?? 0) > 0) return { placeholder: false };
  const ins = await tx.query(
    `INSERT INTO analytics.order_index (tenant_id, order_id, cancelled_at, source_event_id, created_by, expires_at)
VALUES ($1, $2, $3, $4, $5, now() + interval '400 days')
ON CONFLICT (tenant_id, order_id) DO NOTHING`,
    [a.tenantId, a.orderId, a.cancelledAt, a.eventId, a.actorId]);
  return { placeholder: Number(ins.rowCount ?? 0) > 0 };
}
