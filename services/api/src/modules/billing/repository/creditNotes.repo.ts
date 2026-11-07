// billing.credit_notes (content immutable; print/CBMS lifecycle only) and billing.credit_note_lines (append-only: SELECT + INSERT).
// The DB enforces the gapless/chronology rule (credit_notes__chronology_guard), the unique cancellation note per invoice and the per-line credit cap
// (credit_note_lines__guard); those errors propagate to the service, which rolls the transaction back.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, unknown>;

export async function getCreditNote(tx: Q, a: { tenantId: string; creditNoteId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.credit_notes WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.creditNoteId]);
  return rows[0];
}

// is_active / print_count / cbms_attempts / version / created_at / updated_at take their column defaults.
const NOTE_COLUMNS = ['id', 'tenant_id', 'branch_id', 'centre_id', 'series', 'fiscal_year_bs', 'credit_note_seq', 'credit_note_no', 'kind', 'invoice_id', 'invoice_no',
  'invoice_fiscal_year_bs', 'order_id', 'credit_party_id', 'buyer_name', 'buyer_pan', 'issued_at', 'credit_note_date_bs', 'reason_code', 'reason_text',
  'gross_paisa', 'discount_paisa', 'exempt_paisa', 'taxable_paisa', 'vat_paisa', 'other_tax_paisa', 'net_paisa', 'cbms_state', 'created_by', 'updated_by'] as const;
const NOTE_SQL = 'INSERT INTO billing.credit_notes (' + NOTE_COLUMNS.join(', ') + ') VALUES (' + NOTE_COLUMNS.map((_, i) => '$' + String(i + 1)).join(', ') + ') RETURNING *';

/** Only the listed columns are written, from a snake_case row; absent = NULL. */
export async function insertCreditNote(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(NOTE_SQL, NOTE_COLUMNS.map((c) => row[c] ?? null));
  return rows[0]!;
}

const LINE_COLUMNS = ['id', 'tenant_id', 'credit_note_id', 'invoice_line_id', 'centre_id', 'gross_paisa', 'discount_paisa', 'exempt_paisa', 'taxable_paisa',
  'vat_paisa', 'other_tax_paisa', 'net_paisa', 'created_by'] as const;

/** One multi-row INSERT; nothing for an empty list. */
export async function insertCreditNoteLines(tx: Q, rows: ReadonlyArray<Row>): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples = rows.map((r) => '(' + LINE_COLUMNS.map((c) => { values.push(r[c] ?? null); return '$' + String(values.length); }).join(', ') + ')');
  await tx.query('INSERT INTO billing.credit_note_lines (' + LINE_COLUMNS.join(', ') + ') VALUES ' + tuples.join(', '), values);
}

/** Every credit note line of the invoice (all its credit notes); tenant bound on both tables. */
export async function listCreditNoteLinesByInvoice(tx: Q, a: { tenantId: string; invoiceId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT cl.* FROM billing.credit_note_lines cl
       JOIN billing.credit_notes cn ON cn.tenant_id = cl.tenant_id AND cn.id = cl.credit_note_id
      WHERE cl.tenant_id = $1 AND cn.tenant_id = $1 AND cn.invoice_id = $2 ORDER BY cl.created_at, cl.id`, [a.tenantId, a.invoiceId]);
  return rows;
}
