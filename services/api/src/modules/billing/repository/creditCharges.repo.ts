// billing.credit_charges. Rows leave 'uninvoiced' only through the DB guard (uninvoiced -> invoiced | voided).
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export async function getCreditCharge(tx: Q, a: { tenantId: string; chargeId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.credit_charges WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.chargeId]);
  return rows[0];
}

// created_at / updated_at / version / is_active / voided_* take their column defaults.
const INSERT_COLUMNS = ['id', 'tenant_id', 'credit_party_id', 'order_id', 'order_item_id', 'branch_id', 'centre_id', 'referrer_id', 'patient_display_name', 'line_kind',
  'orderable_id', 'code', 'name', 'department_id', 'unit_price_paisa', 'gross_paisa', 'discount_paisa', 'vat_treatment', 'other_tax_code', 'charged_at', 'period_month',
  'status', 'created_by', 'updated_by'] as const;

/** One multi-row INSERT from snake_case rows; only INSERT_COLUMNS are written, absent = NULL. */
export async function insertCreditCharges(tx: Q, rows: readonly Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const n = INSERT_COLUMNS.length;
  const values = rows.map((_, r) => '(' + INSERT_COLUMNS.map((__, c) => '$' + String(r * n + c + 1)).join(', ') + ')').join(', ');
  await tx.query('INSERT INTO billing.credit_charges (' + INSERT_COLUMNS.join(', ') + ') VALUES ' + values, rows.flatMap((row) => INSERT_COLUMNS.map((c) => row[c] ?? null)));
}

const LIST_SQL = `SELECT id, order_item_id, credit_party_id, centre_id, (gross_paisa - discount_paisa)::text AS amount_paisa, status, invoice_id, invoice_line_id
                    FROM billing.credit_charges WHERE tenant_id = $1 AND order_id = $2 ORDER BY charged_at, id`;

/** `lock`: FOR UPDATE, so a charge cannot be invoiced between the list and the void that follows it. */
export async function listCreditChargesByOrder(tx: Q, a: { tenantId: string; orderId: string; lock?: boolean }): Promise<Record<string, any>[]> {
  return (await tx.query(a.lock === true ? LIST_SQL + ' FOR UPDATE' : LIST_SQL, [a.tenantId, a.orderId])).rows;
}

/** Only still-uninvoiced charges change (an invoiced one is never voided here). Returns how many were voided. */
export async function voidCreditChargesByIds(tx: Q, a: { tenantId: string; ids: readonly string[]; reasonCode: string; userId: string }): Promise<number> {
  if (a.ids.length === 0) return 0;
  const { rows } = await tx.query(
    `UPDATE billing.credit_charges SET status = 'voided', voided_at = now(), voided_by = $3, void_reason_code = $4, updated_at = now(), updated_by = $3, version = version + 1
      WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status = 'uninvoiced' RETURNING id`, [a.tenantId, a.ids, a.userId, a.reasonCode]);
  return rows.length;
}

/** B20: keyset on id (ascending); `periodMonth` is the first day of the A.D. month ('YYYY-MM-01'). The caller asks for limit + 1. */
export async function listCreditChargesByParty(tx: Q, a: { tenantId: string; creditPartyId: string; status?: string; periodMonth?: string; afterId?: string; limit: number }): Promise<Record<string, any>[]> {
  const p: unknown[] = [a.tenantId, a.creditPartyId];
  const where = ['tenant_id = $1', 'credit_party_id = $2'];
  const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', '$' + String(p.length))); };
  if (a.status !== undefined) add('status = ?', a.status);
  if (a.periodMonth !== undefined) add('period_month = ?::date', a.periodMonth);
  if (a.afterId !== undefined) add('id > ?::uuid', a.afterId);
  p.push(a.limit);
  return (await tx.query('SELECT * FROM billing.credit_charges WHERE ' + where.join(' AND ') + ' ORDER BY id LIMIT $' + String(p.length), p)).rows;
}

/** B21: the party's uninvoiced charges of one month, FOR UPDATE (two finance users cannot bill the same month twice), in bill order. */
export async function lockUninvoicedCreditCharges(tx: Q, a: { tenantId: string; creditPartyId: string; periodMonth: string }): Promise<Record<string, any>[]> {
  const { rows } = await tx.query(
    `SELECT * FROM billing.credit_charges WHERE tenant_id = $1 AND credit_party_id = $2 AND period_month = $3::date AND status = 'uninvoiced'
      ORDER BY charged_at, id FOR UPDATE`, [a.tenantId, a.creditPartyId, a.periodMonth]);
  return rows;
}

/** uninvoiced -> invoiced for every link, one statement. Returns how many rows moved (the caller compares it with links.length). */
export async function markCreditChargesInvoiced(tx: Q, a: {
  tenantId: string; links: ReadonlyArray<{ chargeId: string; invoiceId: string; invoiceLineId: string }>; invoicedAt: string; userId: string;
}): Promise<number> {
  if (a.links.length === 0) return 0;
  const { rows } = await tx.query(
    `UPDATE billing.credit_charges c SET status = 'invoiced', invoice_id = l.invoice_id, invoice_line_id = l.line_id, invoiced_at = $5::timestamptz,
            updated_at = now(), updated_by = $6, version = c.version + 1
       FROM unnest($2::uuid[], $3::uuid[], $4::uuid[]) AS l(charge_id, invoice_id, line_id)
      WHERE c.tenant_id = $1 AND c.id = l.charge_id AND c.status = 'uninvoiced' RETURNING c.id`,
    [a.tenantId, a.links.map((l) => l.chargeId), a.links.map((l) => l.invoiceId), a.links.map((l) => l.invoiceLineId), a.invoicedAt, a.userId]);
  return rows.length;
}
