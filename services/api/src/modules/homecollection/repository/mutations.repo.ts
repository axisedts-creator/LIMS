// homecollection.mutations (class A, append-only: insert + read only). Dedupe primitive: unique (tenant_id, client_mutation_id) -> 23505 for the loser.
import { getRowById, insertRow, type Tx } from './shared.repo.js';

const T = 'homecollection.mutations';
const INSERT_COLS = ['id', 'centre_id', 'client_mutation_id', 'device_id', 'batch_id', 'membership_id', 'device_seq', 'type', 'visit_id', 'payload', 'payload_sha256',
  'captured_at_device', 'captured_at', 'clock_source', 'clock_suspect', 'outcome', 'outcome_code', 'received_at'] as const;

export const insertMutation = (tx: Tx, tenantId: string, row: Record<string, unknown>) => insertRow(tx, T, INSERT_COLS, tenantId, row, { actorCols: ['created_by'], jsonCols: ['payload'] });
export const getMutationById = (tx: Tx, tenantId: string, mutationId: string) => getRowById(tx, T, tenantId, mutationId);

export async function getMutationByClientId(tx: Tx, tenantId: string, clientMutationId: string): Promise<any | null> {
  const { rows } = await tx.query('SELECT * FROM homecollection.mutations WHERE tenant_id = $1 AND client_mutation_id = $2', [tenantId, clientMutationId]);
  return rows[0] ?? null;
}

export async function listMutationsByVisit(tx: Tx, tenantId: string, visitId: string): Promise<any[]> {
  const { rows } = await tx.query('SELECT * FROM homecollection.mutations WHERE tenant_id = $1 AND visit_id = $2 ORDER BY device_seq, id', [tenantId, visitId]);
  return rows;
}
