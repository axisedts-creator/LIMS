// frontdesk.order_flags (05-SCHEMA §3).
import { getRow, insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'centre_id', 'order_id', 'kind', 'specimen_id', 'source_event_id', 'note'] as const;

export const insertOrderFlag = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, 'frontdesk.order_flags', COLS, tenantId, row);
/** FD-T12: insert-if-absent. ON CONFLICT (no target) covers both partial unique indexes (specimen / order scoped, D-6); a resolved row also blocks a re-insert. Returns the new row or null. */
export async function upsertOrderFlag(tx: Tx, tenantId: string, row: { id: string; centre_id: string; order_id: string; kind: string; specimen_id?: string; source_event_id?: string }): Promise<any | null> {
  const { rows } = await tx.query(`INSERT INTO frontdesk.order_flags (tenant_id, id, centre_id, order_id, kind, specimen_id, source_event_id, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT app.current_actor_id()), (SELECT app.current_actor_id())) ON CONFLICT DO NOTHING RETURNING *`,
  [tenantId, row.id, row.centre_id, row.order_id, row.kind, row.specimen_id ?? null, row.source_event_id ?? null]);
  return rows[0] ?? null;
}
export const getOrderFlagById = (tx: Tx, tenantId: string, id: string) => getRow(tx, 'frontdesk.order_flags', tenantId, id);

export async function listOrderFlagsByOrder(tx: Tx, tenantId: string, orderId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.order_flags WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id`, [tenantId, orderId]);
  return rows;
}
