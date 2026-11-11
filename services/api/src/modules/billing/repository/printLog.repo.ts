// billing.print_log is append-only: rows are inserted by the print service (BL-T09) and never updated or deleted.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

/** One row per print. A duplicate (tenant, kind, document, print_no) raises 23505 print_log__tenant_id_doc_print__uq and is not swallowed. Absent centre_id / reason_code = NULL. */
export async function insertPrintLog(tx: Q, row: Record<string, unknown>): Promise<void> {
  await tx.query(
    `INSERT INTO billing.print_log (id, tenant_id, centre_id, document_kind, document_id, document_no, print_no, is_copy, reason_code, printed_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [row['id'], row['tenant_id'], row['centre_id'] ?? null, row['document_kind'], row['document_id'], row['document_no'], row['print_no'], row['is_copy'],
      row['reason_code'] ?? null, row['printed_at'], row['created_by']]);
}

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
