// frontdesk.discount_approvals (05-SCHEMA §3). `discounts` is jsonb -> JSON-encoded on insert. Explicit tenant_id on every statement (REQ-SEC-024); RLS is the backstop.
import { getRow, insertRow, type Tx } from './shared.repo.js';

const COLS = ['id', 'centre_id', 'requested_by_membership_id', 'patient_id', 'draft_hash', 'base_fingerprint', 'discounts', 'gross_paisa',
  'computed_discount_paisa', 'percent_of_gross_bp', 'reason_code', 'reason_text', 'status', 'expires_at'] as const;
const ACTOR = '(SELECT app.current_actor_id())';

export const insertDiscountApproval = (tx: Tx, tenantId: string, row: Record<string, unknown>) =>
  insertRow(tx, 'frontdesk.discount_approvals', COLS, tenantId, row, { jsonCols: ['discounts'] });
export const getDiscountApprovalById = (tx: Tx, tenantId: string, id: string) => getRow(tx, 'frontdesk.discount_approvals', tenantId, id);

/** Row lock (FD-T07): serialises two deciders / two registrations racing for one approval; the loser re-reads the committed row. */
export async function lockDiscountApproval(tx: Tx, tenantId: string, id: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM frontdesk.discount_approvals WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, id]);
  return rows[0] ?? null;
}

/** pending -> approved|rejected at `expectedVersion`; null when the row moved (status or version). */
export async function decideDiscountApproval(tx: Tx, tenantId: string, id: string,
  o: { expectedVersion: number; status: 'approved' | 'rejected'; membershipId: string; decidedAt: Date; note: string | null }): Promise<any | null> {
  const { rows } = await tx.query(`UPDATE frontdesk.discount_approvals SET status = $4, decided_by_membership_id = $5, decided_at = $6, decision_note = $7,
      version = version + 1, updated_at = now(), updated_by = ${ACTOR}
    WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'pending' RETURNING *`,
  [tenantId, id, o.expectedVersion, o.status, o.membershipId, o.decidedAt, o.note]);
  return rows[0] ?? null;
}

/** approved -> consumed by `orderId` (US-FD-07.5 single use); null when it is no longer approved. */
export async function consumeDiscountApproval(tx: Tx, tenantId: string, id: string, orderId: string, at: Date): Promise<any | null> {
  const { rows } = await tx.query(`UPDATE frontdesk.discount_approvals SET status = 'consumed', consumed_order_id = $3, consumed_at = $4,
      version = version + 1, updated_at = now(), updated_by = ${ACTOR}
    WHERE tenant_id = $1 AND id = $2 AND status = 'approved' RETURNING *`, [tenantId, id, orderId, at]);
  return rows[0] ?? null;
}

/**
 * F16 keyset page, oldest first. `status` is the EFFECTIVE status (pending/approved past expires_at read as expired, 03-APP-FLOW §1.3).
 * `centreIds` null = every centre; sort key = created_at as microsecond-exact text for the cursor. `after` = [sort_key text, id].
 */
export async function pageDiscountApprovals(tx: Tx, tenantId: string,
  o: { status: string; now: Date; centreIds: readonly string[] | null; limit: number; after?: readonly [string, string] }): Promise<any[]> {
  const values: unknown[] = [tenantId, o.now, o.status, o.limit + 1];
  const where = ['a.tenant_id = $1',
    `(CASE WHEN a.status IN ('pending','approved') AND a.expires_at <= $2::timestamptz THEN 'expired' ELSE a.status END) = $3`];
  if (o.centreIds) { values.push([...o.centreIds]); where.push(`a.centre_id = ANY($${values.length}::uuid[])`); }
  if (o.after) { values.push(o.after[0], o.after[1]); where.push(`(a.created_at, a.id) > ($${values.length - 1}::timestamptz, $${values.length}::uuid)`); }
  const { rows } = await tx.query(`SELECT a.*, to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key
    FROM frontdesk.discount_approvals a WHERE ${where.join(' AND ')} ORDER BY a.created_at, a.id LIMIT $4`, values);
  return rows;
}

/** Open = pending | approved (partial index discount_approvals__tenant_id_status_centre_id__p_idx). Oldest first. */
export async function listOpenDiscountApprovals(tx: Tx, tenantId: string, limit = 100): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM frontdesk.discount_approvals WHERE tenant_id = $1 AND status IN ('pending','approved')
    ORDER BY created_at, id LIMIT $2`, [tenantId, limit]);
  return rows;
}
