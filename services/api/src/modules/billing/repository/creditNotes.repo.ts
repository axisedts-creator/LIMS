// billing.credit_notes (immutable content, like invoices). Read here; writes arrive with the cancel/credit services; print_count only grows (DB guard credit_notes__mutable_columns).
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export async function getCreditNote(tx: Q, a: { tenantId: string; creditNoteId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.credit_notes WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.creditNoteId]);
  return rows[0];
}

/** B6 print: the row lock + the new count in one statement, so concurrent prints get distinct numbers. Returns the new print_count, undefined when not found (or another tenant's). */
export async function markCreditNotePrinted(tx: Q, a: { tenantId: string; creditNoteId: string; userId: string }): Promise<number | undefined> {
  const { rows } = await tx.query(
    `UPDATE billing.credit_notes SET print_count = print_count + 1, last_printed_at = now(), updated_at = now(), updated_by = $3
     WHERE tenant_id = $1 AND id = $2 RETURNING print_count`, [a.tenantId, a.creditNoteId, a.userId]);
  return rows[0]?.print_count;
}

/** credit_note_lines has no line_no of its own: it takes the original invoice line's, so a credit note prints in invoice order. */
export async function listCreditNoteLines(tx: Q, a: { tenantId: string; creditNoteId: string }): Promise<Record<string, unknown>[]> {
  const { rows } = await tx.query(
    `SELECT cl.*, il.line_no AS line_no FROM billing.credit_note_lines cl
       JOIN billing.invoice_lines il ON il.tenant_id = cl.tenant_id AND il.id = cl.invoice_line_id
      WHERE cl.tenant_id = $1 AND cl.credit_note_id = $2 ORDER BY line_no, cl.id`, [a.tenantId, a.creditNoteId]);
  return rows;
}
