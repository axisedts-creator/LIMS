// billing.order_balances, keyed (tenant_id, order_id). Writes are guarded by billing.order_balances_guard (05-SCHEMA §3):
// balance_version never decreases and rises iff invoiced/paid/credited changed.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export async function getOrderBalance(tx: Q, a: { tenantId: string; orderId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.order_balances WHERE tenant_id = $1 AND order_id = $2', [a.tenantId, a.orderId]);
  return rows[0];
}

/** TRD §12 lock order: this row first, then the RC counter. No row yet (first invoice of the order) = nothing to lock; the optimistic balance_version guard covers that case. */
export async function lockOrderBalance(tx: Q, a: { tenantId: string; orderId: string }): Promise<void> {
  await tx.query('SELECT 1 FROM billing.order_balances WHERE tenant_id = $1 AND order_id = $2 FOR UPDATE', [a.tenantId, a.orderId]);
}

export interface OrderTotals {
  readonly invoiced_paisa: string; readonly paid_paisa: string; readonly credited_paisa: string; readonly issued_invoice_count: number;
  readonly centre_id: string | null; readonly billing_mode: string;
  /** Branch of the order's first invoice (ledger_entries.branch_id is NOT NULL); null = the order has no invoice. */
  readonly branch_id?: string | null;
}

// invoiced = Σ net of the order's invoices (any status); credited = Σ credit notes against them; paid = Σ signed ledger amounts (TRD §6.2 "Balance:").
// billing_mode / centre_id: the stored row wins, else the order's invoice / credit charge (C4 does not read frontdesk tables).
const TOTALS_SQL = `SELECT
    (SELECT COALESCE(SUM(i.net_paisa), 0) FROM billing.invoices i WHERE i.tenant_id = $1 AND i.order_id = $2)::text AS invoiced_paisa,
    (SELECT COUNT(*) FROM billing.invoices i WHERE i.tenant_id = $1 AND i.order_id = $2)::int AS issued_invoice_count,
    (SELECT COALESCE(SUM(c.net_paisa), 0) FROM billing.credit_notes c WHERE c.tenant_id = $1
        AND c.invoice_id IN (SELECT i.id FROM billing.invoices i WHERE i.tenant_id = $1 AND i.order_id = $2))::text AS credited_paisa,
    (SELECT COALESCE(SUM(l.amount_paisa), 0) FROM billing.ledger_entries l WHERE l.tenant_id = $1 AND l.order_id = $2)::text AS paid_paisa,
    (SELECT COUNT(*) FROM billing.ledger_entries l WHERE l.tenant_id = $1 AND l.order_id = $2)::int AS ledger_count,
    (SELECT COUNT(*) FROM billing.credit_charges g WHERE g.tenant_id = $1 AND g.order_id = $2)::int AS charge_count,
    COALESCE((SELECT b.billing_mode FROM billing.order_balances b WHERE b.tenant_id = $1 AND b.order_id = $2),
             CASE WHEN EXISTS (SELECT 1 FROM billing.credit_charges g WHERE g.tenant_id = $1 AND g.order_id = $2) THEN 'credit' ELSE 'cash' END) AS billing_mode,
    COALESCE((SELECT b.centre_id FROM billing.order_balances b WHERE b.tenant_id = $1 AND b.order_id = $2),
             (SELECT i.centre_id FROM billing.invoices i WHERE i.tenant_id = $1 AND i.order_id = $2 AND i.centre_id IS NOT NULL ORDER BY i.issued_at, i.id LIMIT 1),
             (SELECT g.centre_id FROM billing.credit_charges g WHERE g.tenant_id = $1 AND g.order_id = $2 ORDER BY g.charged_at, g.id LIMIT 1)) AS centre_id,
    (SELECT i.branch_id FROM billing.invoices i WHERE i.tenant_id = $1 AND i.order_id = $2 ORDER BY i.issued_at, i.id LIMIT 1) AS branch_id`;

/** undefined = the order has no invoice, no payment and no credit charge here (not_found for the caller). */
export async function readOrderTotals(tx: Q, a: { tenantId: string; orderId: string }): Promise<OrderTotals | undefined> {
  const r = (await tx.query(TOTALS_SQL, [a.tenantId, a.orderId])).rows[0];
  if (!r || (r.issued_invoice_count === 0 && r.ledger_count === 0 && r.charge_count === 0)) return undefined;
  return { invoiced_paisa: r.invoiced_paisa, paid_paisa: r.paid_paisa, credited_paisa: r.credited_paisa, issued_invoice_count: r.issued_invoice_count,
    centre_id: r.centre_id, billing_mode: r.billing_mode, branch_id: r.branch_id };
}

export interface DuesArgs {
  readonly tenantId: string; readonly now: string; readonly centreId?: string; readonly minDuePaisa?: number; readonly olderThanDays?: number;
  readonly after?: { value: string; id: string }; readonly limit: number;
}

/**
 * B16: cash orders with a balance due, oldest invoice first (keyset on issued_at truncated to ms, order_id). Filters are bound values.
 * [CONV] registration_no / patient_display have no billing source (CR-C4-BL08-001): the order's first invoice number and buyer name stand in.
 */
export async function listDues(tx: Q, a: DuesArgs): Promise<Record<string, unknown>[]> {
  const p: unknown[] = [a.tenantId];
  const conds = ['b.tenant_id = $1', "b.billing_mode = 'cash'", 'b.balance_due_paisa > 0'];
  const add = (sql: string, v: unknown) => { p.push(v); conds.push(sql.replace('?', '$' + p.length)); };
  if (a.centreId !== undefined) add('b.centre_id = ?', a.centreId);
  if (a.minDuePaisa !== undefined) add('b.balance_due_paisa >= ?', a.minDuePaisa);
  if (a.olderThanDays !== undefined) { p.push(a.now, a.olderThanDays); conds.push('f.issued_at <= $' + (p.length - 1) + '::timestamptz - ($' + p.length + '::int * interval \'1 day\')'); }
  if (a.after !== undefined) {
    p.push(a.after.value, a.after.id);
    conds.push("(date_trunc('milliseconds', f.issued_at), b.order_id) > ($" + (p.length - 1) + '::timestamptz, $' + p.length + '::uuid)');
  }
  p.push(a.limit);
  const sql = 'SELECT b.order_id, f.invoice_no AS registration_no, f.buyer_name AS patient_display, b.centre_id, b.invoiced_paisa::text AS invoiced_paisa, '
    + 'b.paid_paisa::text AS paid_paisa, b.credited_paisa::text AS credited_paisa, b.balance_due_paisa::text AS balance_due_paisa, f.issued_at AS oldest_invoice_at '
    + 'FROM billing.order_balances b JOIN LATERAL (SELECT i.invoice_no, i.buyer_name, i.issued_at FROM billing.invoices i '
    + 'WHERE i.tenant_id = b.tenant_id AND i.order_id = b.order_id ORDER BY i.issued_at, i.id LIMIT 1) f ON true '
    + 'WHERE ' + conds.join(' AND ') + " ORDER BY date_trunc('milliseconds', f.issued_at), b.order_id LIMIT $" + p.length;
  return (await tx.query(sql, p)).rows;
}

export interface BalanceWrite {
  readonly tenantId: string; readonly orderId: string; readonly centreId: string; readonly billingMode: 'cash' | 'credit';
  readonly invoicedPaisa: number; readonly paidPaisa: number; readonly creditedPaisa: number; readonly balanceVersion: number;
  readonly releaseBasis: string; readonly userId: string;
}

/** Optimistic: the update only applies on top of version `balanceVersion - 1` (0 = no row). undefined = a concurrent writer got there first (caller: common.version_conflict). */
export async function upsertOrderBalance(tx: Q, a: BalanceWrite): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO billing.order_balances AS b (tenant_id, order_id, centre_id, billing_mode, invoiced_paisa, paid_paisa, credited_paisa, balance_version, release_basis, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     ON CONFLICT (tenant_id, order_id) DO UPDATE SET
       invoiced_paisa = EXCLUDED.invoiced_paisa, paid_paisa = EXCLUDED.paid_paisa, credited_paisa = EXCLUDED.credited_paisa,
       balance_version = EXCLUDED.balance_version, release_basis = EXCLUDED.release_basis, updated_at = now(), updated_by = EXCLUDED.updated_by, version = b.version + 1
     WHERE b.balance_version = EXCLUDED.balance_version - 1
     RETURNING *`,
    [a.tenantId, a.orderId, a.centreId, a.billingMode, a.invoicedPaisa, a.paidPaisa, a.creditedPaisa, a.balanceVersion, a.releaseBasis, a.userId]);
  return rows[0];
}
