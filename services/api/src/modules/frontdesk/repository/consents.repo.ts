// frontdesk.patient_consents — append-only (REQ-SEC-005): insert + read only, no update/delete export (lims_app has neither grant).
import { insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'patient_id', 'processing', 'sms', 'whatsapp', 'email', 'share_with_referrer', 'consent_text_version', 'source', 'captured_at'] as const;

export const insertConsent = (tx: Tx, tenantId: string, row: Record<string, unknown>) =>
  insertRow(tx, 'frontdesk.patient_consents', COLS, tenantId, row, { actorCols: ['created_by'] });

/** Newest first; the first row is the patient's current consent. */
export async function listConsentsByPatient(tx: Tx, tenantId: string, patientId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.patient_consents WHERE tenant_id = $1 AND patient_id = $2
    ORDER BY captured_at DESC, created_at DESC, id`, [tenantId, patientId]);
  return rows;
}
