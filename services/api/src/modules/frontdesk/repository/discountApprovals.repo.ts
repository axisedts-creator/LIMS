// frontdesk.discount_approvals (05-SCHEMA §3). `discounts` is jsonb -> JSON-encoded on insert.
import { getRow, insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'centre_id', 'requested_by_membership_id', 'patient_id', 'draft_hash', 'base_fingerprint', 'discounts', 'gross_paisa',
  'computed_discount_paisa', 'percent_of_gross_bp', 'reason_code', 'reason_text', 'status', 'expires_at'] as const;

export const insertDiscountApproval = (tx: Tx, tenantId: string, row: Record<string, unknown>) =>
  insertRow(tx, 'frontdesk.discount_approvals', COLS, tenantId, row, { jsonCols: ['discounts'] });
export const getDiscountApprovalById = (tx: Tx, tenantId: string, id: string) => getRow(tx, 'frontdesk.discount_approvals', tenantId, id);

/** Open = pending | approved (partial index discount_approvals__tenant_id_status_centre_id__p_idx). Oldest first. */
export async function listOpenDiscountApprovals(tx: Tx, tenantId: string, limit = 100): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.discount_approvals WHERE tenant_id = $1 AND status IN ('pending','approved')
    ORDER BY created_at, id LIMIT $2`, [tenantId, limit]);
  return rows;
}
