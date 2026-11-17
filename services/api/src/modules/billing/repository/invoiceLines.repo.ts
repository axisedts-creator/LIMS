// billing.invoice_lines is append-only (no UPDATE grant): INSERT and SELECT only.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export async function listInvoiceLines(tx: Q, a: { tenantId: string; invoiceId: string }): Promise<Record<string, unknown>[]> {
  const { rows } = await tx.query('SELECT * FROM billing.invoice_lines WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY line_no, id', [a.tenantId, a.invoiceId]);
  return rows;
}

const COLUMNS = ['id', 'tenant_id', 'invoice_id', 'centre_id', 'line_no', 'line_kind', 'order_item_id', 'orderable_id', 'orderable_kind', 'credit_charge_id', 'code', 'name',
  'department_id', 'hs_code', 'quantity', 'unit_price_paisa', 'gross_paisa', 'discount_paisa', 'exempt_paisa', 'taxable_paisa', 'vat_treatment', 'vat_rate_bp', 'vat_paisa',
  'other_tax_code', 'other_tax_rate_bp', 'other_tax_paisa', 'net_paisa', 'price_list_id', 'price_list_version', 'price_source', 'created_by'] as const;

/** One multi-row INSERT; rows are snake_case, absent = NULL. */
export async function insertInvoiceLines(tx: Q, rows: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples = rows.map((r) => {
    const ph = COLUMNS.map((c) => { values.push(r[c] ?? null); return '$' + String(values.length); });
    return '(' + ph.join(', ') + ')';
  });
  await tx.query('INSERT INTO billing.invoice_lines (' + COLUMNS.join(', ') + ') VALUES ' + tuples.join(', '), values);
}

/** Every line of every invoice of the order (raiseCreditNoteRequirement), invoice order then line order. */
export async function listInvoiceLinesByOrder(tx: Q, a: { tenantId: string; orderId: string }): Promise<Array<{ id: string; invoice_id: string; order_item_id: string | null }>> {
  const { rows } = await tx.query(
    `SELECT l.id, l.invoice_id, l.order_item_id FROM billing.invoice_lines l
       JOIN billing.invoices i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
      WHERE l.tenant_id = $1 AND i.order_id = $2 ORDER BY i.issued_at, i.id, l.line_no`, [a.tenantId, a.orderId]);
  return rows;
}

/** Σ credit-note net per invoice line (B2 `credited`); empty while no credit note exists. */
export async function sumCreditedByLine(tx: Q, a: { tenantId: string; invoiceLineIds: readonly string[] }): Promise<Map<string, string>> {
  if (a.invoiceLineIds.length === 0) return new Map();
  const { rows } = await tx.query(
    'SELECT invoice_line_id, SUM(net_paisa)::text AS credited_paisa FROM billing.credit_note_lines WHERE tenant_id = $1 AND invoice_line_id = ANY($2::uuid[]) GROUP BY invoice_line_id',
    [a.tenantId, a.invoiceLineIds]);
  return new Map(rows.map((r) => [String(r.invoice_line_id), String(r.credited_paisa)]));
}
