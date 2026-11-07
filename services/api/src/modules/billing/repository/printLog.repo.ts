// billing.print_log is append-only. Read here; the print service inserts (BL-T11).
import type { Tx } from '../../../core/db/tx.js';

export async function listPrintLog(tx: Pick<Tx, 'query'>, a: { tenantId: string; documentKind: 'invoice' | 'credit_note' | 'receipt'; documentId: string }): Promise<Record<string, unknown>[]> {
  const { rows } = await tx.query('SELECT * FROM billing.print_log WHERE tenant_id = $1 AND document_kind = $2 AND document_id = $3 ORDER BY print_no', [a.tenantId, a.documentKind, a.documentId]);
  return rows;
}
