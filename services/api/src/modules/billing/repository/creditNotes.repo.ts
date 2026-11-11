// billing.credit_notes (content immutable; print/CBMS lifecycle only) and billing.credit_note_lines (append-only: SELECT + INSERT).
// The DB enforces the gapless/chronology rule (credit_notes__chronology_guard), the unique cancellation note per invoice and the per-line credit cap
// (credit_note_lines__guard); those errors propagate to the service, which rolls the transaction back. print_count only grows (DB guard credit_notes__mutable_columns).
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, unknown>;

export async function getCreditNote(tx: Q, a: { tenantId: string; creditNoteId: string }): Promise<Row | undefined> {
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
export async function listCreditNoteLines(tx: Q, a: { tenantId: string; creditNoteId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT cl.*, il.line_no AS line_no FROM billing.credit_note_lines cl
       JOIN billing.invoice_lines il ON il.tenant_id = cl.tenant_id AND il.id = cl.invoice_line_id
      WHERE cl.tenant_id = $1 AND cl.credit_note_id = $2 ORDER BY line_no, cl.id`, [a.tenantId, a.creditNoteId]);
  return rows;
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

/** B6 listCreditNotes: keyset (fiscal_year_bs, credit_note_seq, id) like the B26 register; every value bound, tenant first. */
export async function listCreditNotes(tx: Q, a: { tenantId: string; invoiceId?: string; fiscalYearBs?: string; after?: { fiscalYearBs: string; seq: number; id: string }; limit: number }): Promise<Row[]> {
  const p: unknown[] = [a.tenantId];
  const add = (v: unknown) => { p.push(v); return '$' + p.length; };
  let w = 'tenant_id = $1';
  if (a.invoiceId !== undefined) w += ' AND invoice_id = ' + add(a.invoiceId) + '::uuid';
  if (a.fiscalYearBs !== undefined) w += ' AND fiscal_year_bs = ' + add(a.fiscalYearBs);
  if (a.after !== undefined) w += ' AND (fiscal_year_bs, credit_note_seq, id) > (' + add(a.after.fiscalYearBs) + ', ' + add(a.after.seq) + '::integer, ' + add(a.after.id) + '::uuid)';
  p.push(a.limit);
  return (await tx.query('SELECT * FROM billing.credit_notes WHERE ' + w + ' ORDER BY fiscal_year_bs, credit_note_seq, id LIMIT $' + p.length, p)).rows;
}

/** Lines of several credit notes (B6 list page); tenant bound on both tables. */
export async function listCreditNoteLinesByNotes(tx: Q, a: { tenantId: string; creditNoteIds: ReadonlyArray<string> }): Promise<Row[]> {
  if (a.creditNoteIds.length === 0) return [];
  return (await tx.query(
    'SELECT cl.* FROM billing.credit_note_lines cl WHERE cl.tenant_id = $1 AND cl.credit_note_id = ANY($2::uuid[]) ORDER BY cl.created_at, cl.id', [a.tenantId, a.creditNoteIds])).rows;
}

/** Every credit note line of the invoice (all its credit notes); tenant bound on both tables. */
export async function listCreditNoteLinesByInvoice(tx: Q, a: { tenantId: string; invoiceId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT cl.* FROM billing.credit_note_lines cl
       JOIN billing.credit_notes cn ON cn.tenant_id = cl.tenant_id AND cn.id = cl.credit_note_id
      WHERE cl.tenant_id = $1 AND cn.tenant_id = $1 AND cn.invoice_id = $2 ORDER BY cl.created_at, cl.id`, [a.tenantId, a.invoiceId]);
  return rows;
}
