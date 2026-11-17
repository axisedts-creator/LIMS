// frontdesk.discounts (05-SCHEMA §3).
import { getRow, insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'order_id', 'centre_id', 'scope', 'order_item_id', 'kind', 'amount_paisa', 'percent_bp', 'computed_paisa', 'reason_code', 'reason_text',
  'approval_mode', 'approval_id', 'applied_by_membership_id', 'approved_by_membership_id', 'applied_at', 'billing_document_id', 'status'] as const;

export const insertDiscount = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, 'frontdesk.discounts', COLS, tenantId, row);
export const getDiscountById = (tx: Tx, tenantId: string, id: string) => getRow(tx, 'frontdesk.discounts', tenantId, id);

export async function listDiscountsByOrder(tx: Tx, tenantId: string, orderId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.discounts WHERE tenant_id = $1 AND order_id = $2 ORDER BY applied_at, id`, [tenantId, orderId]);
  return rows;
}
