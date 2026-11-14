// homecollection.handovers + homecollection.handover_items (05-SCHEMA §4). Update columns = the *__mutable_columns trigger lists.
import { getRowById, insertRow, updateRow, type Tx } from './shared.repo.js';

const H = 'homecollection.handovers';
const H_INSERT = ['id', 'centre_id', 'to_centre_id', 'from_membership_id', 'mutation_id', 'handed_over_at', 'handed_over_at_device', 'status', 'received_by_membership_id',
  'received_at', 'note'] as const;
const H_UPDATE = ['status', 'received_by_membership_id', 'received_at', 'note', 'updated_by'] as const;
const I = 'homecollection.handover_items';
const I_INSERT = ['id', 'centre_id', 'to_centre_id', 'handover_id', 'collection_id', 'specimen_id', 'visit_id', 'barcode', 'specimen_type_code', 'outcome'] as const;
const I_UPDATE = ['outcome', 'updated_by'] as const;

export const insertHandover = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, H, H_INSERT, tenantId, row);
export const getHandoverById = (tx: Tx, tenantId: string, handoverId: string) => getRowById(tx, H, tenantId, handoverId);
export const updateHandover = (tx: Tx, tenantId: string, handoverId: string, expectedVersion: number, patch: Record<string, unknown>) =>
  updateRow(tx, H, H_UPDATE, [], tenantId, handoverId, expectedVersion, patch);

/** Handovers visible from the receiving centre, oldest first. */
export async function listHandoversByToCentre(tx: Tx, tenantId: string, toCentreId: string): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.handovers WHERE tenant_id = $1 AND to_centre_id = $2 ORDER BY handed_over_at, id', [tenantId, toCentreId]);
  return rows;
}

export const insertHandoverItem = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, I, I_INSERT, tenantId, row);
export const getHandoverItemById = (tx: Tx, tenantId: string, itemId: string) => getRowById(tx, I, tenantId, itemId);
export const updateHandoverItem = (tx: Tx, tenantId: string, itemId: string, expectedVersion: number, patch: Record<string, unknown>) =>
  updateRow(tx, I, I_UPDATE, [], tenantId, itemId, expectedVersion, patch);

/** HC-T12 push: items already covering any of the collections (one handover per collection: unique (tenant_id, collection_id)). */
export async function listHandoverItemsByCollectionIds(tx: Tx, tenantId: string, collectionIds: readonly string[]): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.handover_items WHERE tenant_id = $1 AND collection_id = ANY($2::uuid[])', [tenantId, collectionIds]);
  return rows;
}

/** HC-T12 push: `to_centre_id` must be an active centre of the tenant (core.collection_centres FK target read). Null when unknown / other tenant / inactive. */
export async function getActiveCentreId(tx: Tx, tenantId: string, centreId: string): Promise<string | null> {
  const { rows } = await tx.query('SELECT id FROM core.collection_centres WHERE tenant_id = $1 AND id = $2 AND is_active', [tenantId, centreId]);
  return rows[0]?.id ?? null;
}

export interface HandoverPageFilter {
  statuses?: readonly string[]; toCentreId?: string; handedOverFrom?: string; handedOverTo?: string;
  after?: { key: string; id: string }; limit: number;
}

/**
 * HC-T14 H13: newest first, keyset on (handed_over_at, id). Counts come from handover_items only (D-125: no visit-side table). RLS narrows to the caller's to_centre_id scope.
 * `cursor_key` = handed_over_at as text (microsecond precision) for the cursor. Returns limit + 1 rows at most so the caller can tell there is a next page.
 */
export async function listHandoversPage(tx: Tx, tenantId: string, f: HandoverPageFilter): Promise<{ rows: any[]; hasMore: boolean }> {
  const values: unknown[] = [tenantId];
  const where = ['h.tenant_id = $1'];
  const add = (sql: string, v: unknown) => { values.push(v); where.push(sql.replace('$$', `$${values.length}`)); };
  if (f.statuses) add('h.status = ANY($$::text[])', [...f.statuses]);
  if (f.toCentreId) add('h.to_centre_id = $$::uuid', f.toCentreId);
  if (f.handedOverFrom) add('h.handed_over_at >= $$::timestamptz', f.handedOverFrom);
  if (f.handedOverTo) add('h.handed_over_at <= $$::timestamptz', f.handedOverTo);
  if (f.after) { values.push(f.after.key, f.after.id); where.push(`(h.handed_over_at, h.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`); }
  values.push(f.limit + 1);
  const { rows } = await tx.query(
    `SELECT h.*, h.handed_over_at::text AS cursor_key,
       (SELECT count(*)::int FROM homecollection.handover_items i WHERE i.tenant_id = h.tenant_id AND i.handover_id = h.id) AS item_count,
       (SELECT count(*)::int FROM homecollection.handover_items i WHERE i.tenant_id = h.tenant_id AND i.handover_id = h.id AND i.outcome = 'received') AS received_count
     FROM homecollection.handovers h WHERE ${where.join(' AND ')} ORDER BY h.handed_over_at DESC, h.id DESC LIMIT $${values.length}`, values);
  return { rows: rows.slice(0, f.limit), hasMore: rows.length > f.limit };
}

/** HC-T14 H15 (D-125, 02-TRD §10): queue homecollection.flag_handover_discrepancy in the caller's tx; job_key flag_handover_discrepancy:<handover_id> = one pending job per handover. */
export async function enqueueFlagHandoverDiscrepancy(tx: Tx, tenantId: string, handoverId: string): Promise<void> {
  await tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)',
    ['homecollection.flag_handover_discrepancy', JSON.stringify({ tenant_id: tenantId, handover_id: handoverId }), `flag_handover_discrepancy:${handoverId}`]);
}

export async function listHandoverItemsByHandover(tx: Tx, tenantId: string, handoverId: string): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.handover_items WHERE tenant_id = $1 AND handover_id = $2 ORDER BY created_at, id', [tenantId, handoverId]);
  return rows;
}
