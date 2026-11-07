// billing.credit_note_tasks.
import type { Tx } from '../../../core/db/tx.js';

export async function getCreditNoteTask(tx: Pick<Tx, 'query'>, a: { tenantId: string; taskId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.credit_note_tasks WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.taskId]);
  return rows[0];
}
