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

export async function listHandoverItemsByHandover(tx: Tx, tenantId: string, handoverId: string): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.handover_items WHERE tenant_id = $1 AND handover_id = $2 ORDER BY created_at, id', [tenantId, handoverId]);
  return rows;
}
