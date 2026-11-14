// billing.refund_requests (two-person manual refunds, 08 A13 D-24) and billing.finance_review_items (B36). SELECT/INSERT/UPDATE grants; no DELETE.
// Every statement binds the tenant; user values are bound parameters only. Lists are keyset pages ordered like B11: (created_at truncated to ms, id) newest first.
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, unknown>;

export async function insertRefundRequest(tx: Q, r: Row): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO billing.refund_requests (id, tenant_id, branch_id, centre_id, order_id, method_code, refund_amount_paisa, reason_code, reason_text, reference_text,
       status, requested_by_membership_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12, $12) RETURNING *`,
    [r['id'], r['tenant_id'], r['branch_id'], r['centre_id'], r['order_id'], r['method_code'], r['refund_amount_paisa'], r['reason_code'], r['reason_text'] ?? null,
      r['reference_text'] ?? null, r['requested_by_membership_id'], r['created_by']]);
  return rows[0];
}

export async function getRefundRequest(tx: Q, a: { tenantId: string; refundRequestId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.refund_requests WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.refundRequestId]);
  return rows[0];
}

/** pending -> approved|rejected, once, on top of `expectedVersion`. undefined = the version moved or the request is no longer pending. */
export async function decideRefundRequest(tx: Q, a: {
  tenantId: string; refundRequestId: string; expectedVersion: number; status: 'approved' | 'rejected'; decidedByMembershipId: string; decidedAt: string;
  decisionNote?: string | null; ledgerEntryId?: string | null; userId: string;
}): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE billing.refund_requests
        SET status = $4, decided_by_membership_id = $5, decided_at = $6::timestamptz, decision_note = $7, ledger_entry_id = $8,
            version = version + 1, updated_at = now(), updated_by = $9
      WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'pending' RETURNING *`,
    [a.tenantId, a.refundRequestId, a.expectedVersion, a.status, a.decidedByMembershipId, a.decidedAt, a.decisionNote ?? null, a.ledgerEntryId ?? null, a.userId]);
  return rows[0];
}

type Page = { after?: { value: string; id: string }; limit: number };

/** B10c: the caller asks for limit + 1 to learn whether a next page exists. */
export async function pageRefundRequests(tx: Q, a: Page & { tenantId: string; status?: string; orderId?: string }): Promise<Row[]> {
  const p: unknown[] = [a.tenantId];
  const conds = ['tenant_id = $1'];
  if (a.status !== undefined) { p.push(a.status); conds.push('status = $' + p.length); }
  if (a.orderId !== undefined) { p.push(a.orderId); conds.push('order_id = $' + p.length); }
  return keyset(tx, 'billing.refund_requests', p, conds, a);
}

export async function getFinanceReviewItem(tx: Q, a: { tenantId: string; itemId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.finance_review_items WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.itemId]);
  return rows[0];
}

/** B36 */
export async function pageFinanceReviewItems(tx: Q, a: Page & { tenantId: string; status?: string }): Promise<Row[]> {
  const p: unknown[] = [a.tenantId];
  const conds = ['tenant_id = $1'];
  if (a.status !== undefined) { p.push(a.status); conds.push('status = $' + p.length); }
  return keyset(tx, 'billing.finance_review_items', p, conds, a);
}

/**
 * open -> resolved, once, on top of `expectedVersion`. undefined = the version moved or the item is no longer open.
 * [CONV] resolved_by stores the resolver's MEMBERSHIP id (the Actor DTO needs a membership id); updated_by is the user id.
 */
export async function resolveFinanceReviewItem(tx: Q, a: {
  tenantId: string; itemId: string; expectedVersion: number; resolutionCode: string; note?: string | null; refundLedgerEntryId?: string | null;
  resolvedAt: string; membershipId: string; userId: string;
}): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `UPDATE billing.finance_review_items
        SET status = 'resolved', resolution_code = $4, note = $5, refund_ledger_entry_id = $6, resolved_at = $7::timestamptz, resolved_by = $8,
            version = version + 1, updated_at = now(), updated_by = $9
      WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status = 'open' RETURNING *`,
    [a.tenantId, a.itemId, a.expectedVersion, a.resolutionCode, a.note ?? null, a.refundLedgerEntryId ?? null, a.resolvedAt, a.membershipId, a.userId]);
  return rows[0];
}

/** BL-T12: a gateway overpayment recorded with allowExceedsDue (kind is checked by finance_review_items__kind__ck). */
export async function insertFinanceReviewItem(tx: Q, a: {
  id: string; tenantId: string; centreId: string; orderId: string; kind: string; ledgerEntryId: string; amountPaisa: number; userId: string;
}): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO billing.finance_review_items (id, tenant_id, centre_id, order_id, kind, ledger_entry_id, amount_paisa, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
    [a.id, a.tenantId, a.centreId, a.orderId, a.kind, a.ledgerEntryId, a.amountPaisa, a.userId]);
  return rows[0];
}

// `table` is one of the two literals above, never user input.
async function keyset(tx: Q, table: string, p: unknown[], conds: string[], a: Page): Promise<Row[]> {
  if (a.after !== undefined) {
    p.push(a.after.value, a.after.id);
    conds.push("(date_trunc('milliseconds', created_at), id) < ($" + (p.length - 1) + '::timestamptz, $' + p.length + '::uuid)');
  }
  p.push(a.limit);
  const sql = 'SELECT * FROM ' + table + ' WHERE ' + conds.join(' AND ') + " ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC LIMIT $" + p.length;
  return (await tx.query(sql, p)).rows;
}
