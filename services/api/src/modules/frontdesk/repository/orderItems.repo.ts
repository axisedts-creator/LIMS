// frontdesk.order_items (05-SCHEMA §3).
import { getRow, insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'order_id', 'centre_id', 'orderable_id', 'orderable_kind', 'code', 'name', 'test_ids', 'department_id', 'priority', 'outsourced',
  'status', 'unit_price_paisa', 'urgent_surcharge_paisa', 'price_list_id', 'price_list_version', 'price_source', 'vat_treatment', 'other_tax_code',
  'added_in_items_version'] as const;

export const insertOrderItem = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, 'frontdesk.order_items', COLS, tenantId, row);
export const getOrderItemById = (tx: Tx, tenantId: string, id: string) => getRow(tx, 'frontdesk.order_items', tenantId, id);

export async function listOrderItemsByOrder(tx: Tx, tenantId: string, orderId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id`, [tenantId, orderId]);
  return rows;
}
