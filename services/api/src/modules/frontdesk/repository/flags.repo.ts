// frontdesk.order_flags (05-SCHEMA §3).
import { getRow, insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'centre_id', 'order_id', 'kind', 'specimen_id', 'source_event_id', 'note'] as const;

export const insertOrderFlag = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, 'frontdesk.order_flags', COLS, tenantId, row);
export const getOrderFlagById = (tx: Tx, tenantId: string, id: string) => getRow(tx, 'frontdesk.order_flags', tenantId, id);

export async function listOrderFlagsByOrder(tx: Tx, tenantId: string, orderId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.order_flags WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id`, [tenantId, orderId]);
  return rows;
}
