// homecollection.collections (05-SCHEMA §4). Update columns = the collections__mutable_columns trigger list (held -> applied | discarded only, C0 trigger).
import { getRowById, insertRow, updateRow, type Tx } from './shared.repo.js';

const T = 'homecollection.collections';
const INSERT_COLS = ['id', 'centre_id', 'visit_id', 'specimen_id', 'order_id', 'mutation_id', 'client_mutation_id', 'collected_by_membership_id', 'scan_method',
  'barcode_verified', 'collected_at', 'collected_at_device', 'clock_suspect', 'status', 'hold_code', 'review_decision', 'review_reason_code', 'review_reason_text',
  'reviewed_by', 'reviewed_at', 'applied_event_id'] as const;
const UPDATE_COLS = ['status', 'review_decision', 'review_reason_code', 'review_reason_text', 'reviewed_by', 'reviewed_at', 'applied_event_id', 'updated_by'] as const;

export const insertCollection = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, T, INSERT_COLS, tenantId, row);
export const getCollectionById = (tx: Tx, tenantId: string, collectionId: string) => getRowById(tx, T, tenantId, collectionId);
export const updateCollection = (tx: Tx, tenantId: string, collectionId: string, expectedVersion: number, patch: Record<string, unknown>) =>
  updateRow(tx, T, UPDATE_COLS, [], tenantId, collectionId, expectedVersion, patch);

/** HC-T12 push (guard 7, handover): the applied collection of each of the specimens (at most one per specimen: partial unique index). */
export async function listAppliedCollectionsBySpecimenIds(tx: Tx, tenantId: string, specimenIds: readonly string[]): Promise<any[]> {
  const { rows } = await tx.query("SELECT * FROM homecollection.collections WHERE tenant_id = $1 AND specimen_id = ANY($2::uuid[]) AND status = 'applied'", [tenantId, specimenIds]);
  return rows;
}

/** Review queue: held collections of the tenant, oldest first. */
export async function listHeldCollections(tx: Tx, tenantId: string): Promise<any[]> {
  const { rows } = await tx.query("SELECT * FROM homecollection.collections WHERE tenant_id = $1 AND status = 'held' ORDER BY collected_at, id", [tenantId]);
  return rows;
}
