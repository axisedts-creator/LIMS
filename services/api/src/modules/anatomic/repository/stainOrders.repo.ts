// anatomic.stain_orders — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { setClause, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

const STAIN_ORDERS_UPDATABLE = { status: '', note: '', reagent_lot: '', started_at: '', completed_at: '', performed_at: '', cancelled_at: '', cancel_reason_text: '', addon_case_item_id: '' } as const; // addon_case_item_id: M10 link-addon (C11 T-09)

export async function insertStainOrder(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.stain_orders (id, tenant_id, centre_id, case_id, stain_id, stain_code, stain_kind, block_id, part_id, status, note, reagent_lot, addon_case_item_id, requested_at, requested_by_membership_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::text, 'requested'), $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['case_id'] ?? null, row['stain_id'] ?? null, row['stain_code'] ?? null, row['stain_kind'] ?? null, row['block_id'] ?? null, row['part_id'] ?? null, row['status'] ?? null, row['note'] ?? null, row['reagent_lot'] ?? null, row['addon_case_item_id'] ?? null, row['requested_at'] ?? null, row['requested_by_membership_id'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getStainOrder(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.stain_orders WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listStainOrders(tx: Q, i: { tenantId: string; caseId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.stain_orders WHERE tenant_id = $1 AND case_id = $2 ORDER BY requested_at, id`, [i.tenantId, i.caseId]);
  return rows;
}

/** M6: bench queue over the tenant (RLS limits it to the caller's centres) with case accession_no/priority, stain display, block label and add-on order item. */
export async function listStainOrdersPage(
  tx: Q, i: { tenantId: string; statuses: string[]; stainKinds?: string[]; centreIds?: string[]; descending: boolean; limit: number; offset: number },
): Promise<Row[]> {
  const ORDER = i.descending ? 'o.requested_at DESC, o.id' : 'o.requested_at, o.id'; // fixed text, never caller input
  const { rows } = await tx.query(
    `SELECT o.*, c.accession_no, c.priority, st.display AS stain_display, bl.label AS block_label, ci.order_item_id AS addon_order_item_id
       FROM anatomic.stain_orders o
       JOIN anatomic.cases c ON c.tenant_id = o.tenant_id AND c.id = o.case_id
       LEFT JOIN anatomic.stains st ON st.tenant_id = o.tenant_id AND st.id = o.stain_id
       LEFT JOIN anatomic.blocks bl ON bl.tenant_id = o.tenant_id AND bl.id = o.block_id
       LEFT JOIN anatomic.case_items ci ON ci.tenant_id = o.tenant_id AND ci.id = o.addon_case_item_id
      WHERE o.tenant_id = $1 AND o.status = ANY($2::text[]) AND ($3::text[] IS NULL OR o.stain_kind = ANY($3::text[])) AND ($4::uuid[] IS NULL OR o.centre_id = ANY($4::uuid[]))
      ORDER BY ${ORDER} LIMIT $5 OFFSET $6`,
    [i.tenantId, i.statuses, i.stainKinds ?? null, i.centreIds ?? null, i.limit, i.offset]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateStainOrder(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, STAIN_ORDERS_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.stain_orders SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}
