// billing.print_log is append-only. Read here; the print service inserts (BL-T11).
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export async function listPrintLog(tx: Q, a: { tenantId: string; documentKind: 'invoice' | 'credit_note' | 'receipt'; documentId: string }): Promise<Record<string, unknown>[]> {
  const { rows } = await tx.query('SELECT * FROM billing.print_log WHERE tenant_id = $1 AND document_kind = $2 AND document_id = $3 ORDER BY print_no', [a.tenantId, a.documentKind, a.documentId]);
  return rows;
}

/** B37 keyset page by print_no (ascending): `afterPrintNo` = last print_no of the previous page. The caller asks for limit + 1. */
export async function pagePrintLog(tx: Q, a: { tenantId: string; documentKind: 'invoice' | 'credit_note' | 'receipt'; documentId: string; afterPrintNo?: number; limit: number }): Promise<Record<string, unknown>[]> {
  const { rows } = await tx.query(
    `SELECT * FROM billing.print_log WHERE tenant_id = $1 AND document_kind = $2 AND document_id = $3 AND print_no > $4
       ORDER BY print_no LIMIT $5`, [a.tenantId, a.documentKind, a.documentId, a.afterPrintNo ?? 0, a.limit]);
  return rows;
}
