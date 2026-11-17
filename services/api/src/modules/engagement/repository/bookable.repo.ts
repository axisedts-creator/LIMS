// engagement.bookable_items (05-SCHEMA bookable_items; 02-TRD §5 S12-S14, §8.1). Static SQL only; values are always parameters; no DELETE (matrix: S I U).
// REQ-SEC-024: every statement binds tenant_id.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;
const COLS = 'id, orderable_id, orderable_kind, code, display_name, indicative_price_paisa, price_list_id, price_list_version, sex_restriction, booking_kinds, sort_order, catalog_revision, synced_at, version, is_active';

/** Catalogue-derived columns (code, name, sex restriction, price snapshot, revision); never taken from a request body. */
export interface SnapshotCols {
  code: string; displayName: string; sexRestriction: string | null; priceAmount: number | null; priceListId: string | null; priceListVersion: number | null; catalogRevision: number | null;
}

export async function getByOrderable(tx: Q, a: { tenantId: string; orderableId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.bookable_items WHERE tenant_id = $1 AND orderable_id = $2`, [a.tenantId, a.orderableId]);
  return rows[0];
}

export async function insertItem(tx: Q, a: { tenantId: string; userId: string; orderableId: string; kind: string; bookingKinds: string[]; sortOrder: number; isActive: boolean; syncedAt: string; snap: SnapshotCols }): Promise<Row | undefined> {
  const s = a.snap;
  const { rows } = await tx.query(
    `INSERT INTO engagement.bookable_items (id, tenant_id, orderable_id, orderable_kind, code, display_name, indicative_price_paisa, price_list_id, price_list_version, sex_restriction, booking_kinds, sort_order, catalog_revision, synced_at, version, is_active, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1, $15, $16, $16) RETURNING ${COLS}`,
    [uuidv7(), a.tenantId, a.orderableId, a.kind, s.code, s.displayName, s.priceAmount, s.priceListId, s.priceListVersion, s.sexRestriction, a.bookingKinds, a.sortOrder, s.catalogRevision, a.syncedAt, a.isActive, a.userId]);
  return rows[0];
}

/** Staff update (S13): optimistic lock on version. undefined = version changed under us. */
export async function updateItem(tx: Q, a: { tenantId: string; userId: string; orderableId: string; expectedVersion: number; bookingKinds: string[]; sortOrder: number; isActive: boolean; syncedAt: string; snap: SnapshotCols }): Promise<Row | undefined> {
  const s = a.snap;
  const { rows } = await tx.query(
    `UPDATE engagement.bookable_items SET code = $4, display_name = $5, indicative_price_paisa = $6, price_list_id = $7, price_list_version = $8, sex_restriction = $9, catalog_revision = $10,
       booking_kinds = $11, sort_order = $12, is_active = $13, synced_at = $14, version = version + 1, updated_at = now(), updated_by = $15
     WHERE tenant_id = $1 AND orderable_id = $2 AND version = $3 RETURNING ${COLS}`,
    [a.tenantId, a.orderableId, a.expectedVersion, s.code, s.displayName, s.priceAmount, s.priceListId, s.priceListVersion, s.sexRestriction, s.catalogRevision, a.bookingKinds, a.sortOrder, a.isActive, a.syncedAt, a.userId]);
  return rows[0];
}

/** Sync (system actor): refreshes the snapshot only; staff columns (booking_kinds, sort_order) and version are untouched. */
export async function syncSnapshot(tx: Q, a: { tenantId: string; userId: string; id: string; isActive: boolean; syncedAt: string; snap: SnapshotCols }): Promise<void> {
  const s = a.snap;
  await tx.query(
    `UPDATE engagement.bookable_items SET code = $3, display_name = $4, indicative_price_paisa = $5, price_list_id = $6, price_list_version = $7, sex_restriction = $8, catalog_revision = $9,
       is_active = $10, synced_at = $11, updated_at = now(), updated_by = $12
     WHERE tenant_id = $1 AND id = $2`,
    [a.tenantId, a.id, s.code, s.displayName, s.priceAmount, s.priceListId, s.priceListVersion, s.sexRestriction, s.catalogRevision, a.isActive, a.syncedAt, a.userId]);
}

/** Item vanished from C3: only switch it off. */
export async function deactivate(tx: Q, a: { tenantId: string; userId: string; id: string }): Promise<void> {
  await tx.query(`UPDATE engagement.bookable_items SET is_active = false, updated_at = now(), updated_by = $3 WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id, a.userId]);
}

export async function listAll(tx: Q, a: { tenantId: string }): Promise<Row[]> {
  const { rows } = await tx.query(`SELECT id, orderable_id, orderable_kind, is_active FROM engagement.bookable_items WHERE tenant_id = $1 ORDER BY sort_order, display_name, id`, [a.tenantId]);
  return rows;
}

/** Keyset page (sort_order, display_name, id). `search` is already a LIKE pattern (escaped by the caller) and stays a bound value. Caller asks for limit + 1. */
export async function listItems(tx: Q, a: { tenantId: string; isActive?: boolean | undefined; search?: string | undefined; after?: { sortOrder: number; displayName: string; id: string }; limit: number }): Promise<Row[]> {
  const v: unknown[] = [a.tenantId];
  let where = 'tenant_id = $1';
  if (a.isActive !== undefined) { v.push(a.isActive); where += ` AND is_active = $${v.length}`; }
  if (a.search !== undefined) { v.push(a.search); where += ` AND (code ILIKE $${v.length} OR display_name ILIKE $${v.length})`; }   // search value is pushed before the cursor values
  if (a.after) { v.push(a.after.sortOrder, a.after.displayName, a.after.id); where += ` AND (sort_order, display_name, id) > ($${v.length - 2}::int, $${v.length - 1}::text, $${v.length}::uuid)`; }
  v.push(a.limit);
  const { rows } = await tx.query(`SELECT ${COLS} FROM engagement.bookable_items WHERE ${where} ORDER BY sort_order, display_name, id LIMIT $${v.length}`, v);
  return rows;
}
