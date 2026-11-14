// billing.credit_note_tasks (SELECT/INSERT/UPDATE grants; no DELETE). Every statement binds the tenant; user values are bound parameters only.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, unknown>;

export async function getCreditNoteTask(tx: Q, a: { tenantId: string; taskId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.credit_note_tasks WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.taskId]);
  return rows[0];
}

/** Open tasks of one invoice (the cancel resolves them all). */
export async function listOpenCreditNoteTasks(tx: Q, a: { tenantId: string; invoiceId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    "SELECT * FROM billing.credit_note_tasks WHERE tenant_id = $1 AND invoice_id = $2 AND status = 'open' ORDER BY created_at, id", [a.tenantId, a.invoiceId]);
  return rows;
}

/** ONE statement for the whole list; a task that is not open is never rewritten. Returns the rows it resolved. */
export async function resolveCreditNoteTasks(
  tx: Q, a: { tenantId: string; taskIds: readonly string[]; creditNoteId: string; userId: string; resolvedAt: string },
): Promise<Row[]> {
  if (a.taskIds.length === 0) return [];
  const { rows } = await tx.query(
    `UPDATE billing.credit_note_tasks
        SET status = 'resolved', resolved_by_credit_note_id = $3, resolved_by = $4, resolved_at = $5::timestamptz,
            version = version + 1, updated_at = now(), updated_by = $4
      WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status = 'open' RETURNING *`,
    [a.tenantId, a.taskIds, a.creditNoteId, a.userId, a.resolvedAt]);
  return rows;
}

/** B35: keyset page ordered by (created_at, id); the caller asks for limit + 1 to learn whether a next page exists. */
export async function listCreditNoteTasks(
  tx: Q, a: { tenantId: string; status: string; limit: number; after?: { createdAt: string; id: string } },
): Promise<Row[]> {
  const values: unknown[] = [a.tenantId, a.status];
  let keyset = '';
  if (a.after) { values.push(a.after.createdAt, a.after.id); keyset = ' AND (created_at, id) > ($3::timestamptz, $4::uuid)'; }
  values.push(a.limit);
  const sql = 'SELECT * FROM billing.credit_note_tasks WHERE tenant_id = $1 AND status = $2' + keyset + ' ORDER BY created_at, id LIMIT $' + String(values.length);
  return (await tx.query(sql, values)).rows;
}

/** raiseCreditNoteRequirement: a new 'open' task. Only the table's columns are written (the port's `required` flag is the call's answer, not a column). */
export async function insertCreditNoteTask(tx: Q, row: Record<string, unknown>): Promise<void> {
  await tx.query(
    `INSERT INTO billing.credit_note_tasks (id, tenant_id, centre_id, order_id, invoice_id, invoice_line_ids, cause, reason_code, status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8, 'open', $9, $9)`,
    [row['id'], row['tenant_id'], row['centre_id'], row['order_id'], row['invoice_id'], row['invoice_line_ids'], row['cause'], row['reason_code'], row['created_by']]);
}
