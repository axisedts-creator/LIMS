// billing.invoice_lines is append-only (no UPDATE grant). Read here; inserts arrive with the issue service (BL-T06).
import type { Tx } from '../../../core/db/tx.js';

export async function listInvoiceLines(tx: Pick<Tx, 'query'>, a: { tenantId: string; invoiceId: string }): Promise<Record<string, unknown>[]> {
  const { rows } = await tx.query('SELECT * FROM billing.invoice_lines WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY id', [a.tenantId, a.invoiceId]);
  return rows;
}
