// frontdesk.trf_attachments (05-SCHEMA §3). Draft purge is the DEFINER function frontdesk.purge_trf_drafts (worker), not this repo.
import { getRow, insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'centre_id', 'order_id', 'object_path', 'original_filename', 'mime_type', 'size_bytes', 'sha256'] as const;

export const insertTrfAttachment = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, 'frontdesk.trf_attachments', COLS, tenantId, row);
export const getTrfAttachmentById = (tx: Tx, tenantId: string, id: string) => getRow(tx, 'frontdesk.trf_attachments', tenantId, id);

/** FD-T15 F7: every still-active TRF row of the patient's orders -> is_active = false; returns what the caller must delete from storage. */
export async function deactivateTrfByPatient(tx: Tx, tenantId: string, patientId: string): Promise<Array<{ id: string; bucket: string; object_path: string }>> {
  const { rows } = await tx.query(`UPDATE frontdesk.trf_attachments SET is_active = false, version = version + 1, updated_at = now(), updated_by = (SELECT app.current_actor_id())
    WHERE tenant_id = $1 AND is_active AND order_id IN (SELECT id FROM frontdesk.orders WHERE tenant_id = $1 AND patient_id = $2)
    RETURNING id, bucket, object_path`, [tenantId, patientId]);
  return rows;
}

export async function listTrfByOrder(tx: Tx, tenantId: string, orderId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.trf_attachments WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at, id`, [tenantId, orderId]);
  return rows;
}
