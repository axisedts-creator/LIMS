// billing.release_overrides is append-only. Read here.
import type { Tx } from '../../../core/db/tx.js';

export async function getReleaseOverride(tx: Pick<Tx, 'query'>, a: { tenantId: string; overrideId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.release_overrides WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.overrideId]);
  return rows[0];
}

/** B14: append-only (SELECT, INSERT grants only). */
export async function insertReleaseOverride(tx: Pick<Tx, 'query'>, a: {
  id: string; tenantId: string; orderId: string; centreId: string; reasonCode: string; reasonText: string | null; expiresAt: string | null; membershipId: string; userId: string;
}): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO billing.release_overrides (id, tenant_id, order_id, centre_id, reason_code, reason_text, expires_at, membership_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9) RETURNING *`,
    [a.id, a.tenantId, a.orderId, a.centreId, a.reasonCode, a.reasonText, a.expiresAt, a.membershipId, a.userId]);
  return rows[0];
}

/** TRD §6.2 rule 3: newest active, unexpired override of the order at instant `at` (ISO UTC). */
export async function findActiveOverride(tx: Pick<Tx, 'query'>, a: { tenantId: string; orderId: string; at: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query(
    `SELECT * FROM billing.release_overrides WHERE tenant_id = $1 AND order_id = $2 AND is_active
       AND (expires_at IS NULL OR expires_at > $3::timestamptz) ORDER BY created_at DESC, id DESC LIMIT 1`, [a.tenantId, a.orderId, a.at]);
  return rows[0];
}
