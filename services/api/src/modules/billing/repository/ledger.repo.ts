// billing.ledger_entries is append-only (05-SCHEMA §5): INSERT and SELECT only. Reversals and refunds are new signed rows.
import type { Tx } from '../../../core/db/tx.js';

export interface NewLedgerEntry {
  readonly id: string; readonly tenantId: string; readonly branchId: string; readonly centreId: string | null;
  readonly orderId: string | null; readonly invoiceId: string | null;
  readonly entryKind: 'payment' | 'reversal' | 'refund'; readonly captureKind: 'manual' | 'gateway' | 'home_collection';
  readonly methodCode: string; readonly amountPaisa: number; readonly fiscalYearBs: string; readonly businessDate: string;
  readonly collectedByMembershipId: string | null; readonly userId: string;
  readonly reversesEntryId?: string | null; readonly reasonCode?: string | null; readonly idempotencyKey?: string | null;
}

export async function insertLedgerEntry(tx: Pick<Tx, 'query'>, e: NewLedgerEntry): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO billing.ledger_entries (id, tenant_id, branch_id, centre_id, order_id, invoice_id, entry_kind, capture_kind, method_code, amount_paisa,
       fiscal_year_bs, business_date, collected_by_membership_id, reverses_entry_id, reason_code, idempotency_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
    [e.id, e.tenantId, e.branchId, e.centreId, e.orderId, e.invoiceId, e.entryKind, e.captureKind, e.methodCode, e.amountPaisa,
      e.fiscalYearBs, e.businessDate, e.collectedByMembershipId, e.reversesEntryId ?? null, e.reasonCode ?? null, e.idempotencyKey ?? null, e.userId]);
  return rows[0];
}

export async function listLedgerForInvoice(tx: Pick<Tx, 'query'>, a: { tenantId: string; invoiceId: string }): Promise<Record<string, unknown>[]> {
  const { rows } = await tx.query('SELECT * FROM billing.ledger_entries WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY created_at, id', [a.tenantId, a.invoiceId]);
  return rows;
}
