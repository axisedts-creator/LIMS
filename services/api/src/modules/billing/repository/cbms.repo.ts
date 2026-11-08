// billing.cbms_submissions is append-only. Read here; the CBMS job (BL-T13) inserts.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
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

type Kind = 'invoice' | 'credit_note' | 'invoice_cancellation';
const KIND_IDX: Readonly<Record<Kind, number>> = { invoice: 0, invoice_cancellation: 1, credit_note: 2 };
export const cbmsKindIdx = (k: Kind): number => KIND_IDX[k];

// invoice -> invoices.cbms_*; invoice_cancellation -> invoices.cbms_cancel_* (document = the cancelling credit note); credit_note -> credit_notes.cbms_*
const DOC_SQL: Readonly<Record<Kind, string>> = {
  invoice: `SELECT 'invoice'::text AS document_kind, i.id AS document_id, i.invoice_no AS document_no, i.fiscal_year_bs, i.issued_at, i.invoice_date_bs AS date_bs, i.seller_pan,
                   i.buyer_name, i.buyer_pan, NULL::text AS ref_invoice_no,
                   i.gross_paisa, i.discount_paisa, i.exempt_paisa, i.taxable_paisa, i.vat_paisa, i.other_tax_paisa, i.net_paisa,
                   i.cbms_state, i.cbms_attempts, i.cbms_last_attempt_at
              FROM billing.invoices i WHERE i.tenant_id = $1 AND i.id = $2 FOR UPDATE OF i`,
  invoice_cancellation: `SELECT 'invoice_cancellation'::text AS document_kind, i.id AS document_id, c.credit_note_no AS document_no, c.fiscal_year_bs, c.issued_at, c.credit_note_date_bs AS date_bs,
                   i.seller_pan, c.buyer_name, c.buyer_pan, c.invoice_no AS ref_invoice_no,
                   c.gross_paisa, c.discount_paisa, c.exempt_paisa, c.taxable_paisa, c.vat_paisa, c.other_tax_paisa, c.net_paisa,
                   i.cbms_cancel_state AS cbms_state, i.cbms_cancel_attempts AS cbms_attempts, i.cbms_cancel_last_attempt_at AS cbms_last_attempt_at
              FROM billing.invoices i JOIN billing.credit_notes c ON c.tenant_id = i.tenant_id AND c.id = i.credit_note_id
             WHERE i.tenant_id = $1 AND i.id = $2 AND i.cbms_cancel_state IS NOT NULL FOR UPDATE OF i`,
  credit_note: `SELECT 'credit_note'::text AS document_kind, c.id AS document_id, c.credit_note_no AS document_no, c.fiscal_year_bs, c.issued_at, c.credit_note_date_bs AS date_bs,
                   i.seller_pan, c.buyer_name, c.buyer_pan, c.invoice_no AS ref_invoice_no,
                   c.gross_paisa, c.discount_paisa, c.exempt_paisa, c.taxable_paisa, c.vat_paisa, c.other_tax_paisa, c.net_paisa,
                   c.cbms_state, c.cbms_attempts, c.cbms_last_attempt_at
              FROM billing.credit_notes c JOIN billing.invoices i ON i.tenant_id = c.tenant_id AND i.id = c.invoice_id
             WHERE c.tenant_id = $1 AND c.id = $2 FOR UPDATE OF c`,
};

/** The document as the CBMS sees it, row-locked (tenant-filtered: another tenant's id is simply absent). */
export async function getCbmsDocumentForUpdate(tx: Q, a: { tenantId: string; documentKind: Kind; documentId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query(DOC_SQL[a.documentKind], [a.tenantId, a.documentId]);
  return rows[0];
}

/** Append-only attempt log. UNIQUE (tenant, kind, document, attempt_no) backstops two writers. */
export async function insertCbmsSubmission(tx: Q, a: {
  tenantId: string; documentKind: Kind; documentId: string; attemptNo: number; clientMode: 'stub' | 'live'; outcome: string;
  externalRef?: string; rawStatusRedacted?: string; submittedAt: string; userId: string;
}): Promise<void> {
  await tx.query(
    `INSERT INTO billing.cbms_submissions (id, tenant_id, document_kind, document_id, attempt_no, client_mode, outcome, external_ref, raw_status_redacted, submitted_at, created_by)
     VALUES ($11, $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10)`,
    [a.tenantId, a.documentKind, a.documentId, a.attemptNo, a.clientMode, a.outcome, a.externalRef ?? null, a.rawStatusRedacted ?? null, a.submittedAt, a.userId, uuidv7()]);
}

const ATTEMPT_SQL: Readonly<Record<Kind, string>> = {
  invoice: `UPDATE billing.invoices SET cbms_state = $3, cbms_attempts = $4, cbms_last_attempt_at = $5::timestamptz,
          cbms_synced_at = CASE WHEN $3 = 'synced' THEN $5::timestamptz ELSE cbms_synced_at END,
          cbms_external_ref = CASE WHEN $3 = 'synced' THEN $6 ELSE cbms_external_ref END,
          updated_at = now(), updated_by = $7, version = version + 1
    WHERE tenant_id = $1 AND id = $2`,
  invoice_cancellation: `UPDATE billing.invoices SET cbms_cancel_state = $3, cbms_cancel_attempts = $4, cbms_cancel_last_attempt_at = $5::timestamptz,
          cbms_cancel_synced_at = CASE WHEN $3 = 'synced' THEN $5::timestamptz ELSE cbms_cancel_synced_at END,
          cbms_cancel_external_ref = CASE WHEN $3 = 'synced' THEN $6 ELSE cbms_cancel_external_ref END,
          updated_at = now(), updated_by = $7, version = version + 1
    WHERE tenant_id = $1 AND id = $2`,
  credit_note: `UPDATE billing.credit_notes SET cbms_state = $3, cbms_attempts = $4, cbms_last_attempt_at = $5::timestamptz,
          cbms_synced_at = CASE WHEN $3 = 'synced' THEN $5::timestamptz ELSE cbms_synced_at END,
          cbms_external_ref = CASE WHEN $3 = 'synced' THEN $6 ELSE cbms_external_ref END,
          updated_at = now(), updated_by = $7, version = version + 1
    WHERE tenant_id = $1 AND id = $2`,
};
const RESET_SQL: Readonly<Record<Kind, string>> = {
  invoice: `UPDATE billing.invoices SET cbms_state = 'pending', updated_at = now(), updated_by = $3, version = version + 1 WHERE tenant_id = $1 AND id = $2`,
  invoice_cancellation: `UPDATE billing.invoices SET cbms_cancel_state = 'pending', updated_at = now(), updated_by = $3, version = version + 1 WHERE tenant_id = $1 AND id = $2`,
  credit_note: `UPDATE billing.credit_notes SET cbms_state = 'pending', updated_at = now(), updated_by = $3, version = version + 1 WHERE tenant_id = $1 AND id = $2`,
};

/** State + attempt counters; 'synced' also stamps synced_at / external_ref. The DB guard allows only pending -> synced | failed_permanent. */
export async function recordCbmsAttempt(tx: Q, a: {
  tenantId: string; documentKind: Kind; documentId: string; state: string; attempts: number; lastAttemptAt: string; externalRef?: string; userId: string;
}): Promise<void> {
  await tx.query(ATTEMPT_SQL[a.documentKind], [a.tenantId, a.documentId, a.state, a.attempts, a.lastAttemptAt, a.externalRef ?? null, a.userId]);
}

/** B31: failed_permanent -> pending (attempts kept). */
export async function resetCbmsToPending(tx: Q, a: { tenantId: string; documentKind: Kind; documentId: string; userId: string }): Promise<void> {
  await tx.query(RESET_SQL[a.documentKind], [a.tenantId, a.documentId, a.userId]);
}

/** B30: the three kinds in one keyset page ordered by (document_id, kind); afterKey = the last row of the previous page. */
export async function listCbmsDocuments(tx: Q, a: {
  tenantId: string; state?: string; documentKind?: Kind; afterKey?: { id: string; kindIdx: number }; limit: number;
}): Promise<Record<string, unknown>[]> {
  const { rows } = await tx.query(
    `SELECT d.document_kind, d.document_id, d.document_no, d.cbms_state, d.attempts, d.last_attempt_at, lo.outcome AS last_outcome
       FROM (SELECT * FROM (
               SELECT 'invoice'::text AS document_kind, 0 AS kind_idx, i.id AS document_id, i.invoice_no AS document_no, i.cbms_state, i.cbms_attempts AS attempts, i.cbms_last_attempt_at AS last_attempt_at
                 FROM billing.invoices i WHERE i.tenant_id = $1
               UNION ALL
               SELECT 'invoice_cancellation', 1, i.id, c.credit_note_no, i.cbms_cancel_state, i.cbms_cancel_attempts, i.cbms_cancel_last_attempt_at
                 FROM billing.invoices i JOIN billing.credit_notes c ON c.tenant_id = i.tenant_id AND c.id = i.credit_note_id WHERE i.tenant_id = $1 AND i.cbms_cancel_state IS NOT NULL
               UNION ALL
               SELECT 'credit_note', 2, n.id, n.credit_note_no, n.cbms_state, n.cbms_attempts, n.cbms_last_attempt_at
                 FROM billing.credit_notes n WHERE n.tenant_id = $1) u
              WHERE ($2::text IS NULL OR u.cbms_state = $2) AND ($3::text IS NULL OR u.document_kind = $3)
                AND ($4::uuid IS NULL OR (u.document_id, u.kind_idx) > ($4::uuid, $5::int))
              ORDER BY u.document_id, u.kind_idx LIMIT $6) d
       LEFT JOIN LATERAL (SELECT s.outcome FROM billing.cbms_submissions s
                           WHERE s.tenant_id = $1 AND s.document_kind = d.document_kind AND s.document_id = d.document_id ORDER BY s.attempt_no DESC LIMIT 1) lo ON true
      ORDER BY d.document_id, d.kind_idx`,
    [a.tenantId, a.state ?? null, a.documentKind ?? null, a.afterKey?.id ?? null, a.afterKey?.kindIdx ?? 0, a.limit]);
  return rows;
}

/** TRD §9 outbox: job billing.cbms_sync {tenant_id, document_kind, document_id}, job_key cbms:<kind>:<id>, in the issuing transaction. */
export async function enqueueCbmsSync(tx: Q, a: { tenantId: string; documentKind: 'invoice' | 'credit_note' | 'invoice_cancellation'; documentId: string }): Promise<void> {
  await tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [
    'billing.cbms_sync', JSON.stringify({ tenant_id: a.tenantId, document_kind: a.documentKind, document_id: a.documentId }), `cbms:${a.documentKind}:${a.documentId}`]);
}
