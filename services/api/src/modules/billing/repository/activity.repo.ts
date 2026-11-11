// billing.activity_log is append-only: INSERT and SELECT only. `details` holds non-PHI keys only.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export async function getActivity(tx: Q, a: { tenantId: string; activityId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.activity_log WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.activityId]);
  return rows[0];
}

/** `row` is a snake_case billing.activity_log row; `details` is an object (stored as jsonb). */
export async function insertActivity(tx: Q, row: Record<string, unknown>): Promise<void> {
  await tx.query(
    `INSERT INTO billing.activity_log (id, tenant_id, centre_id, action, document_kind, document_id, document_no, actor_id, actor_membership_id, actor_type,
       occurred_at, request_id, details, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
    [row['id'], row['tenant_id'], row['centre_id'] ?? null, row['action'], row['document_kind'] ?? null, row['document_id'] ?? null, row['document_no'] ?? null,
      row['actor_id'], row['actor_membership_id'] ?? null, row['actor_type'], row['occurred_at'], row['request_id'] ?? null, JSON.stringify(row['details'] ?? {}), row['created_by']]);
}
