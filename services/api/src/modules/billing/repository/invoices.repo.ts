// billing.invoices. Content columns are frozen by the DB (invoices__mutable_columns, 05-SCHEMA §3); only lifecycle columns are assigned here.
// P0001 immutable_row on this table -> 409 billing.invoice_immutable (05-SCHEMA §5 API mapping, 02-CV §5.7); every other error passes through.
import type { Tx } from '../../../core/db/tx.js';

export type InvoiceRow = Record<string, unknown>;

function mapImmutable(e: unknown): unknown {
  const x = e as { code?: string; message?: string; detail?: string } | null;
  if (x?.code === 'P0001' && x.message === 'immutable_row' && x.detail === 'billing.invoices') {
    return Object.assign(new Error('Invoice cannot be changed'), { code: 'billing.invoice_immutable', statusCode: 409 });
  }
  return e;
}

export async function getInvoice(tx: Pick<Tx, 'query'>, a: { tenantId: string; invoiceId: string }): Promise<InvoiceRow | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.invoices WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.invoiceId]);
  return rows[0];
}

/** print_count may grow by exactly 1 (DB guard). Returns the new count, undefined when the invoice is not found. */
export async function markInvoicePrinted(tx: Pick<Tx, 'query'>, a: { tenantId: string; invoiceId: string; userId: string }): Promise<number | undefined> {
  try {
    const { rows } = await tx.query(
      `UPDATE billing.invoices SET print_count = print_count + 1, last_printed_at = now(), updated_at = now(), updated_by = $3
       WHERE tenant_id = $1 AND id = $2 RETURNING print_count`, [a.tenantId, a.invoiceId, a.userId]);
    return rows[0]?.print_count;
  } catch (e) { throw mapImmutable(e); }
}
