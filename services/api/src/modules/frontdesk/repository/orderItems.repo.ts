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

export async function listOrderItemsByOrder(tx: Tx, tenantId: string, orderId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id`, [tenantId, orderId]);
  return rows;
}
