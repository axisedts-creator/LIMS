// billing.order_balances, keyed (tenant_id, order_id).
import type { Tx } from '../../../core/db/tx.js';

export async function getOrderBalance(tx: Pick<Tx, 'query'>, a: { tenantId: string; orderId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.order_balances WHERE tenant_id = $1 AND order_id = $2', [a.tenantId, a.orderId]);
  return rows[0];
}
