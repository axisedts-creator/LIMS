// billing.invoices. Content columns are frozen by the DB (invoices__mutable_columns, 05-SCHEMA §3); only lifecycle columns are assigned here.
// P0001 immutable_row on this table -> 409 billing.invoice_immutable (05-SCHEMA §5 API mapping, 02-CV §5.7); every other error passes through.
import type { Tx } from '../../../core/db/tx.js';

export type InvoiceRow = Record<string, unknown>;
type Q = Pick<Tx, 'query'>;

function mapImmutable(e: unknown): unknown {
  const x = e as { code?: string; message?: string; detail?: string } | null;
  if (x?.code === 'P0001' && x.message === 'immutable_row' && x.detail === 'billing.invoices') {
    return Object.assign(new Error('Invoice cannot be changed'), { code: 'billing.invoice_immutable', statusCode: 409 });
  }
  return e;
}

export async function getInvoice(tx: Q, a: { tenantId: string; invoiceId: string }): Promise<InvoiceRow | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.invoices WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.invoiceId]);
  return rows[0];
}

/** SELECT … FOR UPDATE: serialises every cancel / credit on one invoice (TRD §12 lock order). Tenant-filtered: another tenant's id is simply absent. */
export async function getInvoiceForUpdate(tx: Q, a: { tenantId: string; invoiceId: string }): Promise<InvoiceRow | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.invoices WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [a.tenantId, a.invoiceId]);
  return rows[0];
}

/** B22: the periodic bill of THIS party only (any other invoice, party or tenant is simply absent), locked so payments on one bill serialise. */
export async function getPeriodicInvoiceForUpdate(tx: Q, a: { tenantId: string; creditPartyId: string; invoiceId: string }): Promise<InvoiceRow | undefined> {
  const { rows } = await tx.query(
    'SELECT * FROM billing.invoices WHERE tenant_id = $1 AND id = $2 AND credit_party_id = $3 AND is_periodic_credit_bill FOR UPDATE', [a.tenantId, a.invoiceId, a.creditPartyId]);
  return rows[0];
}

/** issued -> cancelled, with the cancellation columns and cbms_cancel_state set together (the only transition the DB guard allows). */
export async function markInvoiceCancelled(tx: Q, a: {
  tenantId: string; invoiceId: string; cancelledAt: string; cancelledBy: string; reasonCode: string; reasonText?: string | null;
  creditNoteId: string; creditedTotalPaisa: number; cbmsCancelState: 'not_required' | 'pending'; userId: string;
}): Promise<InvoiceRow | undefined> {
  try {
    const { rows } = await tx.query(
      `UPDATE billing.invoices SET status = 'cancelled', is_active = false, cancelled_at = $3::timestamptz, cancelled_by = $4, cancel_reason_code = $5, cancel_reason_text = $6,
              credit_note_id = $7, credited_total_paisa = $8, cbms_cancel_state = $9, updated_at = now(), updated_by = $10, version = version + 1
        WHERE tenant_id = $1 AND id = $2 AND status = 'issued' RETURNING *`,
      [a.tenantId, a.invoiceId, a.cancelledAt, a.cancelledBy, a.reasonCode, a.reasonText ?? null, a.creditNoteId, a.creditedTotalPaisa, a.cbmsCancelState, a.userId]);
    return rows[0];
  } catch (e) { throw mapImmutable(e); }
}

/** Partial credit: only credited_total_paisa / version / updated_* move; the DB guard rejects a decrease. */
export async function addInvoiceCredit(tx: Q, a: { tenantId: string; invoiceId: string; creditedTotalPaisa: number; userId: string }): Promise<InvoiceRow | undefined> {
  try {
    const { rows } = await tx.query(
      `UPDATE billing.invoices SET credited_total_paisa = $3, updated_at = now(), updated_by = $4, version = version + 1
        WHERE tenant_id = $1 AND id = $2 AND status = 'issued' RETURNING *`, [a.tenantId, a.invoiceId, a.creditedTotalPaisa, a.userId]);
    return rows[0];
  } catch (e) { throw mapImmutable(e); }
}

/** recordPayment: only the columns needed to check that an invoice belongs to the order being paid. */
export async function findInvoiceForPayment(tx: Q, a: { tenantId: string; invoiceId: string }): Promise<{ id: string; order_id: string | null; status: string } | undefined> {
  const { rows } = await tx.query('SELECT id, order_id, status FROM billing.invoices WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.invoiceId]);
  return rows[0];
}

/** print_count may grow by exactly 1 (DB guard). Returns the new count, undefined when the invoice is not found. */
export async function markInvoicePrinted(tx: Q, a: { tenantId: string; invoiceId: string; userId: string }): Promise<number | undefined> {
  try {
    const { rows } = await tx.query(
      `UPDATE billing.invoices SET print_count = print_count + 1, last_printed_at = now(), version = version + 1, updated_at = now(), updated_by = $3
       WHERE tenant_id = $1 AND id = $2 RETURNING print_count`, [a.tenantId, a.invoiceId, a.userId]);
    return rows[0]?.print_count;
  } catch (e) { throw mapImmutable(e); }
}

// created_at / updated_at / is_active / print_count / version / cbms_* timestamps take their column defaults (the server keeps its own clock).
const INSERT_COLUMNS = ['id', 'tenant_id', 'branch_id', 'centre_id', 'series', 'fiscal_year_bs', 'invoice_seq', 'invoice_no', 'invoice_kind', 'purpose',
  'order_id', 'patient_id', 'credit_party_id', 'is_periodic_credit_bill', 'period_month', 'referrer_id', 'buyer_name', 'buyer_pan', 'buyer_address',
  'seller_name', 'seller_pan', 'seller_address', 'issued_at', 'invoice_date_bs', 'gross_paisa', 'discount_paisa', 'exempt_paisa', 'taxable_paisa',
  'vat_paisa', 'other_tax_paisa', 'net_paisa', 'prices_include_tax', 'quote_fingerprint', 'status', 'is_active', 'print_count', 'cbms_state', 'cbms_attempts', 'created_by', 'updated_by'] as const;
const INSERT_SQL = 'INSERT INTO billing.invoices (' + INSERT_COLUMNS.join(', ') + ') VALUES (' + INSERT_COLUMNS.map((_, i) => '$' + String(i + 1)).join(', ') + ') RETURNING *';

/** Only the listed columns are written, from a snake_case row; absent = NULL. A duplicate registration invoice surfaces as 23505 on invoices__tenant_id_order_registration__p_uq. */
export async function insertInvoice(tx: Q, row: Record<string, unknown>): Promise<InvoiceRow> {
  const { rows } = await tx.query(INSERT_SQL, INSERT_COLUMNS.map((c) => row[c] ?? null));
  return rows[0]!;
}

export const INVOICE_SORTS = {
  '-issued_at': { col: 'issued_at', dir: 'DESC' }, 'issued_at': { col: 'issued_at', dir: 'ASC' },
  '-invoice_seq': { col: 'invoice_seq', dir: 'DESC' }, 'invoice_seq': { col: 'invoice_seq', dir: 'ASC' },
} as const;
export type InvoiceSort = keyof typeof INVOICE_SORTS;
export interface InvoiceFilter {
  readonly status?: string; readonly centreId?: string; readonly issuedAtFrom?: string; readonly issuedAtTo?: string; readonly fiscalYearBs?: string;
  readonly orderId?: string; readonly creditPartyId?: string; readonly invoiceNo?: string;
  readonly sort: InvoiceSort; readonly after?: { readonly value: string | number; readonly id: string }; readonly limit: number;
}

/** Keyset page (`limit` rows; the caller asks for limit + 1 to learn whether a next page exists). Every user value is a bound parameter; column and direction come from INVOICE_SORTS. */
export async function listInvoices(tx: Q, tenantId: string, f: InvoiceFilter): Promise<InvoiceRow[]> {
  const values: unknown[] = [tenantId];
  const where: string[] = ['tenant_id = $1'];
  const bind = (v: unknown): string => { values.push(v); return '$' + String(values.length); };
  if (f.status !== undefined) where.push('status = ' + bind(f.status));
  if (f.centreId !== undefined) where.push('centre_id = ' + bind(f.centreId));
  if (f.issuedAtFrom !== undefined) where.push('issued_at >= ' + bind(f.issuedAtFrom) + '::timestamptz');
  if (f.issuedAtTo !== undefined) where.push('issued_at <= ' + bind(f.issuedAtTo) + '::timestamptz');
  if (f.fiscalYearBs !== undefined) where.push('fiscal_year_bs = ' + bind(f.fiscalYearBs));
  if (f.orderId !== undefined) where.push('order_id = ' + bind(f.orderId));
  if (f.creditPartyId !== undefined) where.push('credit_party_id = ' + bind(f.creditPartyId));
  if (f.invoiceNo !== undefined) where.push('invoice_no = ' + bind(f.invoiceNo));
  const { col, dir } = INVOICE_SORTS[f.sort];
  if (f.after !== undefined) {
    const cast = col === 'issued_at' ? '::timestamptz' : '::integer';
    where.push('(' + col + ', id) ' + (dir === 'DESC' ? '<' : '>') + ' (' + bind(f.after.value) + cast + ', ' + bind(f.after.id) + '::uuid)');
  }
  const sql = 'SELECT * FROM billing.invoices WHERE ' + where.join(' AND ') + ' ORDER BY ' + col + ' ' + dir + ', id ' + dir + ' LIMIT ' + bind(f.limit);
  return (await tx.query(sql, values)).rows;
}

/** B7: the order's invoices, oldest first (OrderBillingDto.invoices is capped at 50). */
export async function listInvoicesByOrder(tx: Q, a: { tenantId: string; orderId: string }): Promise<InvoiceRow[]> {
  const { rows } = await tx.query('SELECT * FROM billing.invoices WHERE tenant_id = $1 AND order_id = $2 ORDER BY issued_at, id LIMIT 50', [a.tenantId, a.orderId]);
  return rows;
}
