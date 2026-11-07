// billing.ledger_entries is append-only (05-SCHEMA §5): INSERT and SELECT only. Reversals and refunds are new signed rows.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export interface NewLedgerEntry {
  readonly id: string; readonly tenantId: string; readonly branchId: string; readonly centreId: string | null;
  readonly orderId: string | null; readonly invoiceId: string | null;
  readonly entryKind: 'payment' | 'reversal' | 'refund'; readonly captureKind: 'manual' | 'gateway' | 'home_collection';
  readonly methodCode: string; readonly amountPaisa: number; readonly fiscalYearBs: string; readonly businessDate: string;
  readonly collectedByMembershipId: string | null; readonly userId: string;
  readonly reversesEntryId?: string | null; readonly reasonCode?: string | null; readonly idempotencyKey?: string | null;
  readonly receiptNo?: string | null; readonly receiptSeq?: number | null; readonly cashSessionId?: string | null;
  readonly referenceText?: string | null; readonly capturedAtDevice?: string | null;
}

export async function insertLedgerEntry(tx: Q, e: NewLedgerEntry): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO billing.ledger_entries (id, tenant_id, branch_id, centre_id, order_id, invoice_id, entry_kind, capture_kind, method_code, amount_paisa,
       fiscal_year_bs, business_date, collected_by_membership_id, reverses_entry_id, reason_code, idempotency_key, created_by,
       receipt_no, receipt_seq, cash_session_id, reference_text, captured_at_device)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING *`,
    [e.id, e.tenantId, e.branchId, e.centreId, e.orderId, e.invoiceId, e.entryKind, e.captureKind, e.methodCode, e.amountPaisa,
      e.fiscalYearBs, e.businessDate, e.collectedByMembershipId, e.reversesEntryId ?? null, e.reasonCode ?? null, e.idempotencyKey ?? null, e.userId,
      e.receiptNo ?? null, e.receiptSeq ?? null, e.cashSessionId ?? null, e.referenceText ?? null, e.capturedAtDevice ?? null]);
  return rows[0];
}

export async function listLedgerForInvoice(tx: Q, a: { tenantId: string; invoiceId: string }): Promise<Record<string, unknown>[]> {
  const { rows } = await tx.query('SELECT * FROM billing.ledger_entries WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY created_at, id', [a.tenantId, a.invoiceId]);
  return rows;
}

/** Replay lookup: the unique index is (tenant_id, idempotency_key), so another tenant's key never matches. */
export async function findLedgerByIdempotencyKey(tx: Q, a: { tenantId: string; idempotencyKey: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.ledger_entries WHERE tenant_id = $1 AND idempotency_key = $2', [a.tenantId, a.idempotencyKey]);
  return rows[0];
}

/** Signed sum per method of one cash session (payments, reversals, refunds): the session's `expected`. */
export async function sumLedgerBySession(tx: Q, a: { tenantId: string; sessionId: string }): Promise<Array<{ method_code: string; amount_paisa: string }>> {
  const { rows } = await tx.query(
    `SELECT method_code, SUM(amount_paisa)::text AS amount_paisa FROM billing.ledger_entries
      WHERE tenant_id = $1 AND cash_session_id = $2 GROUP BY method_code ORDER BY method_code`, [a.tenantId, a.sessionId]);
  return rows as Array<{ method_code: string; amount_paisa: string }>;
}

export interface LedgerPageArgs {
  readonly tenantId: string; readonly collectedBy?: string; readonly methodCode?: string; readonly centreId?: string; readonly entryKind?: string;
  readonly createdFrom?: string; readonly createdTo?: string; readonly after?: { value: string; id: string }; readonly limit: number;
}

/** B11: newest first, keyset on (created_at truncated to ms, id) - the cursor carries ms, so the order key is ms too and no row is skipped. Filters are bound values only. */
export async function pageLedger(tx: Q, a: LedgerPageArgs): Promise<Record<string, unknown>[]> {
  const p: unknown[] = [a.tenantId];
  const conds = ['l.tenant_id = $1'];
  const add = (sql: string, v: unknown) => { p.push(v); conds.push(sql.replace('?', '$' + p.length)); };
  if (a.collectedBy !== undefined) add('l.collected_by_membership_id = ?', a.collectedBy);
  if (a.methodCode !== undefined) add('l.method_code = ?', a.methodCode);
  if (a.centreId !== undefined) add('l.centre_id = ?', a.centreId);
  if (a.entryKind !== undefined) add('l.entry_kind = ?', a.entryKind);
  if (a.createdFrom !== undefined) add('l.created_at >= ?::timestamptz', a.createdFrom);
  if (a.createdTo !== undefined) add('l.created_at <= ?::timestamptz', a.createdTo);
  if (a.after !== undefined) {
    p.push(a.after.value, a.after.id);
    conds.push("(date_trunc('milliseconds', l.created_at), l.id) < ($" + (p.length - 1) + '::timestamptz, $' + p.length + '::uuid)');
  }
  p.push(a.limit);
  const sql = 'SELECT l.* FROM billing.ledger_entries l WHERE ' + conds.join(' AND ')
    + " ORDER BY date_trunc('milliseconds', l.created_at) DESC, l.id DESC LIMIT $" + p.length;
  return (await tx.query(sql, p)).rows;
}

/** B18: raw payment/reversal rows of one business date that have a collector (gateway rows have none). Grouped in code by the service. */
export async function listLedgerForDay(tx: Q, a: { tenantId: string; businessDate: string; centreId?: string; collectedBy?: string }): Promise<Record<string, unknown>[]> {
  const p: unknown[] = [a.tenantId, a.businessDate];
  const conds = ['l.tenant_id = $1', 'l.business_date = $2::date', "l.entry_kind IN ('payment', 'reversal', 'refund')", 'l.collected_by_membership_id IS NOT NULL'];
  if (a.centreId !== undefined) { p.push(a.centreId); conds.push('l.centre_id = $' + p.length); }
  if (a.collectedBy !== undefined) { p.push(a.collectedBy); conds.push('l.collected_by_membership_id = $' + p.length); }
  // ponytail: one tenant-day of rows is read into memory (thousands at most); move to SQL GROUP BY if a day ever exceeds that.
  const sql = 'SELECT l.collected_by_membership_id, l.method_code, l.entry_kind, l.amount_paisa FROM billing.ledger_entries l WHERE ' + conds.join(' AND ');
  return (await tx.query(sql, p)).rows;
}
