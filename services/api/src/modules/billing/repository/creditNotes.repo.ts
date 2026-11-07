// billing.credit_notes (immutable content, like invoices). Read here; writes arrive with the cancel/credit services.
import type { Tx } from '../../../core/db/tx.js';

export async function getCreditNote(tx: Pick<Tx, 'query'>, a: { tenantId: string; creditNoteId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.credit_notes WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.creditNoteId]);
  return rows[0];
}
