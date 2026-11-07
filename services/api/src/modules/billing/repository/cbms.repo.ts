// billing.cbms_submissions is append-only. Read here.
import type { Tx } from '../../../core/db/tx.js';

export async function listCbmsSubmissions(tx: Pick<Tx, 'query'>, a: { tenantId: string; documentKind: 'invoice' | 'credit_note' | 'invoice_cancellation'; documentId: string }): Promise<Record<string, unknown>[]> {
  const { rows } = await tx.query('SELECT * FROM billing.cbms_submissions WHERE tenant_id = $1 AND document_kind = $2 AND document_id = $3 ORDER BY attempt_no', [a.tenantId, a.documentKind, a.documentId]);
  return rows;
}
