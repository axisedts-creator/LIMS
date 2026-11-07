// billing.order_balances, keyed (tenant_id, order_id). Writes are guarded by billing.order_balances_guard (05-SCHEMA §3):
// balance_version never decreases and rises iff invoiced/paid/credited changed.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export async function getOrderBalance(tx: Q, a: { tenantId: string; orderId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.order_balances WHERE tenant_id = $1 AND order_id = $2', [a.tenantId, a.orderId]);
  return rows[0];
}

export interface OrderTotals {
  readonly invoiced_paisa: string; readonly paid_paisa: string; readonly credited_paisa: string; readonly issued_invoice_count: number;
  readonly centre_id: string | null; readonly billing_mode: string;
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
             (SELECT g.centre_id FROM billing.credit_charges g WHERE g.tenant_id = $1 AND g.order_id = $2 ORDER BY g.charged_at, g.id LIMIT 1)) AS centre_id`;

/** undefined = the order has no invoice, no payment and no credit charge here (not_found for the caller). */
export async function readOrderTotals(tx: Q, a: { tenantId: string; orderId: string }): Promise<OrderTotals | undefined> {
  const r = (await tx.query(TOTALS_SQL, [a.tenantId, a.orderId])).rows[0];
  if (!r || (r.issued_invoice_count === 0 && r.ledger_count === 0 && r.charge_count === 0)) return undefined;
  return { invoiced_paisa: r.invoiced_paisa, paid_paisa: r.paid_paisa, credited_paisa: r.credited_paisa, issued_invoice_count: r.issued_invoice_count,
    centre_id: r.centre_id, billing_mode: r.billing_mode };
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
