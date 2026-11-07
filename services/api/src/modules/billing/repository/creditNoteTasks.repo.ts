// billing.credit_note_tasks.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export async function getCreditNoteTask(tx: Q, a: { tenantId: string; taskId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.credit_note_tasks WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.taskId]);
  return rows[0];
}

/** raiseCreditNoteRequirement: a new 'open' task. Only the table's columns are written (the port's `required` flag is the call's answer, not a column). */
export async function insertCreditNoteTask(tx: Q, row: Record<string, unknown>): Promise<void> {
  await tx.query(
    `INSERT INTO billing.credit_note_tasks (id, tenant_id, centre_id, order_id, invoice_id, invoice_line_ids, cause, reason_code, status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8, 'open', $9, $9)`,
    [row['id'], row['tenant_id'], row['centre_id'], row['order_id'], row['invoice_id'], row['invoice_line_ids'], row['cause'], row['reason_code'], row['created_by']]);
}
