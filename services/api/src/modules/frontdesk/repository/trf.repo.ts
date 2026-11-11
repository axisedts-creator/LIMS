// frontdesk.trf_attachments (05-SCHEMA §3). Draft purge is the DEFINER function frontdesk.purge_trf_drafts (worker), not this repo.
import { getRow, insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'centre_id', 'order_id', 'object_path', 'original_filename', 'mime_type', 'size_bytes', 'sha256'] as const;

export const insertTrfAttachment = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, 'frontdesk.trf_attachments', COLS, tenantId, row);
export const getTrfAttachmentById = (tx: Tx, tenantId: string, id: string) => getRow(tx, 'frontdesk.trf_attachments', tenantId, id);

export async function listTrfByOrder(tx: Tx, tenantId: string, orderId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.trf_attachments WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id`, [tenantId, orderId]);
  return rows;
}
