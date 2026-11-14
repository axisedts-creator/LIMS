// homecollection.sync_batches (class A, append-only: insert + read only). Inserted last in a push transaction (mutations FK is deferred).
import { insertRow, type Tx } from './shared.repo.js';

const T = 'homecollection.sync_batches';
const INSERT_COLS = ['id', 'device_id', 'membership_id', 'sent_at_device', 'now_device_wall_time', 'now_monotonic_ms', 'now_boot_id', 'anchors', 'mutation_count',
  'applied_count', 'held_count', 'rejected_count', 'duplicate_count', 'unresolved_mutations', 'received_at'] as const;

export const insertSyncBatch = (tx: Tx, tenantId: string, row: Record<string, unknown>) =>
  insertRow(tx, T, INSERT_COLS, tenantId, row, { actorCols: ['created_by'], jsonCols: ['anchors', 'unresolved_mutations'] });
export async function getSyncBatchById(tx: Tx, tenantId: string, batchId: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM homecollection.sync_batches WHERE tenant_id = $1 AND id = $2', [tenantId, batchId]);
  return rows[0] ?? null;
}
