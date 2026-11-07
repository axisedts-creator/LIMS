// billing.cbms_submissions is append-only. Read here; the CBMS job (BL-T13) inserts.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export async function listCbmsSubmissions(tx: Q, a: { tenantId: string; documentKind: 'invoice' | 'credit_note' | 'invoice_cancellation'; documentId: string }): Promise<Record<string, unknown>[]> {
  const { rows } = await tx.query('SELECT * FROM billing.cbms_submissions WHERE tenant_id = $1 AND document_kind = $2 AND document_id = $3 ORDER BY attempt_no', [a.tenantId, a.documentKind, a.documentId]);
  return rows;
}

/** B2: the invoice's own attempts and its cancellation document's attempts (both keyed by the invoice id), oldest first. */
export async function listInvoiceCbmsSubmissions(tx: Q, a: { tenantId: string; invoiceId: string }): Promise<Record<string, unknown>[]> {
  const { rows } = await tx.query(
    `SELECT * FROM billing.cbms_submissions WHERE tenant_id = $1 AND document_id = $2 AND document_kind IN ('invoice', 'invoice_cancellation')
       ORDER BY submitted_at, document_kind, attempt_no LIMIT 200`, [a.tenantId, a.invoiceId]);
  return rows;
}

/** TRD §9 outbox: job billing.cbms_sync {tenant_id, document_kind, document_id}, job_key cbms:<kind>:<id>, in the issuing transaction. */
export async function enqueueCbmsSync(tx: Q, a: { tenantId: string; documentKind: 'invoice' | 'credit_note' | 'invoice_cancellation'; documentId: string }): Promise<void> {
  await tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [
    'billing.cbms_sync', JSON.stringify({ tenant_id: a.tenantId, document_kind: a.documentKind, document_id: a.documentId }), `cbms:${a.documentKind}:${a.documentId}`]);
}
