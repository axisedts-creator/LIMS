// anatomic.blocks — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { setClause, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

const BLOCKS_UPDATABLE = { note: '', location_status: '', location_text: '' } as const;

export async function insertBlock(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.blocks (id, tenant_id, centre_id, case_id, part_id, seq, label, note, location_status, location_text, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::text, 'in_lab'), $10, $11, $12) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['case_id'] ?? null, row['part_id'] ?? null, row['seq'] ?? null, row['label'] ?? null, row['note'] ?? null, row['location_status'] ?? null, row['location_text'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getBlock(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.blocks WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listBlocks(tx: Q, i: { tenantId: string; caseId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.blocks WHERE tenant_id = $1 AND case_id = $2 ORDER BY part_id, seq, id`, [i.tenantId, i.caseId]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateBlock(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, BLOCKS_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.blocks SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}
