// The ONLY reader of other schemas' published views (02-CV §5.13; 03-IC §6.3; 02-TRD §4.4): frontdesk.v_pub_order_status, lab.v_pub_specimen_timeline, billing.v_pub_order_balance.
// Read-only. REQ-SEC-024: every statement binds tenant_id besides RLS. Paging is LIMIT / OFFSET; timeline / balance are read in `order_id = ANY($n)` batches (no N+1). Plain SQL (no JOIN).
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
export type Row = Record<string, any>;

/** Orders of one patient, newest registered first (02-TRD §4.4 backfill: pages of 200, at most 1,000 orders [CONV]). */
export async function orderPage(tx: Q, a: { tenantId: string; patientId: string; limit: number; offset: number }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT order_id, patient_id, centre_id, branch_id, source, source_ref_id, partner_id, status, registered_at, updated_at
     FROM frontdesk.v_pub_order_status WHERE tenant_id = $1 AND patient_id = $2 ORDER BY registered_at DESC, order_id LIMIT $3 OFFSET $4`,
    [a.tenantId, a.patientId, a.limit, a.offset]);
  return rows;
}

/** One order (first sight of an order by an event consumer). */
export async function orderOf(tx: Q, a: { tenantId: string; orderId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `SELECT order_id, patient_id, centre_id, branch_id, source, source_ref_id, partner_id, status, registered_at, updated_at
     FROM frontdesk.v_pub_order_status WHERE tenant_id = $1 AND order_id = $2`, [a.tenantId, a.orderId]);
  return rows[0];
}

/** Specimens of the given orders; `specimen_version` is the aggregate seq (CR-C16-022 / 08 A19 D-106). */
export async function timelineOf(tx: Q, a: { tenantId: string; orderIds: readonly string[] }): Promise<Row[]> {
  if (a.orderIds.length === 0) return [];
  const { rows } = await tx.query(
    `SELECT specimen_id, order_id, specimen_type_code, status, ordered_at, collected_at, received_at, rejected_at, rejection_reason_code, replaces_specimen_id, specimen_version
     FROM lab.v_pub_specimen_timeline WHERE tenant_id = $1 AND order_id = ANY($2::uuid[]) ORDER BY order_id, ordered_at, specimen_id`,
    [a.tenantId, [...a.orderIds]]);
  return rows;
}

export async function balancesOf(tx: Q, a: { tenantId: string; orderIds: readonly string[] }): Promise<Row[]> {
  if (a.orderIds.length === 0) return [];
  const { rows } = await tx.query(
    `SELECT order_id, invoiced_paisa, paid_paisa, balance_due_paisa, balance_version, release_basis
     FROM billing.v_pub_order_balance WHERE tenant_id = $1 AND order_id = ANY($2::uuid[]) ORDER BY order_id`,
    [a.tenantId, [...a.orderIds]]);
  return rows;
}
