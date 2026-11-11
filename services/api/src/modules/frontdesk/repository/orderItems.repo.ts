// frontdesk.order_items (05-SCHEMA §3).
import { getRow, insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'order_id', 'centre_id', 'orderable_id', 'orderable_kind', 'code', 'name', 'test_ids', 'department_id', 'priority', 'outsourced',
  'status', 'unit_price_paisa', 'urgent_surcharge_paisa', 'price_list_id', 'price_list_version', 'price_source', 'vat_treatment', 'other_tax_code',
  'added_in_items_version'] as const;

export const insertOrderItem = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, 'frontdesk.order_items', COLS, tenantId, row);
export const getOrderItemById = (tx: Tx, tenantId: string, id: string) => getRow(tx, 'frontdesk.order_items', tenantId, id);

/** order_id -> ids of its ACTIVE items, for several orders in one statement (F10 status derivation ignores removed/cancelled items). */
export async function activeItemIdsByOrders(tx: Tx, tenantId: string, orderIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (orderIds.length === 0) return out;
  const { rows } = await tx.query(`SELECT order_id, id FROM frontdesk.order_items WHERE tenant_id = $1 AND order_id = ANY($2::uuid[]) AND status = 'active'`, [tenantId, orderIds]);
  for (const r of rows) (out.get(r.order_id) ?? out.set(r.order_id, new Set()).get(r.order_id)!).add(r.id);
  return out;
}

/** FD-T09 F13: active -> removed (reason + time + who). null when the item is not an active item of this order. */
export async function removeOrderItem(tx: Tx, tenantId: string, orderId: string, id: string, r: { at: Date; by: string; reasonCode: string }): Promise<any | null> {
  const { rows } = await tx.query(`UPDATE frontdesk.order_items SET status = 'removed', removed_at = $4, removed_by = $5, removal_reason_code = $6,
      version = version + 1, updated_at = now(), updated_by = (SELECT app.current_actor_id())
    WHERE tenant_id = $1 AND order_id = $2 AND id = $3 AND status = 'active' RETURNING *`, [tenantId, orderId, id, r.at, r.by, r.reasonCode]);
  return rows[0] ?? null;
}

/** FD-T09 F14: every still-active item becomes cancelled (removed items stay removed). */
export async function cancelActiveItems(tx: Tx, tenantId: string, orderId: string): Promise<void> {
  await tx.query(`UPDATE frontdesk.order_items SET status = 'cancelled', version = version + 1, updated_at = now(), updated_by = (SELECT app.current_actor_id())
    WHERE tenant_id = $1 AND order_id = $2 AND status = 'active'`, [tenantId, orderId]);
}

/** FD-T12 F12: one active item -> cancelled (a stored pre_registered item replaced at confirm). */
export async function cancelOrderItem(tx: Tx, tenantId: string, orderId: string, id: string): Promise<void> {
  await tx.query(`UPDATE frontdesk.order_items SET status = 'cancelled', version = version + 1, updated_at = now(), updated_by = (SELECT app.current_actor_id())
    WHERE tenant_id = $1 AND order_id = $2 AND id = $3 AND status = 'active'`, [tenantId, orderId, id]);
}

export async function listOrderItemsByOrder(tx: Tx, tenantId: string, orderId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id`, [tenantId, orderId]);
  return rows;
}
