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

/** M12: tenant-wide block list with the case accession_no, slide count and last movement time; RLS limits it to the caller's centres. Newest first. */
export async function listBlocksPage(
  tx: Q, i: { tenantId: string; locationStatuses?: string[]; caseId?: string; limit: number; offset: number },
): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT b.*, c.accession_no,
            (SELECT count(*)::int FROM anatomic.slides s WHERE s.tenant_id = $1 AND s.block_id = b.id) AS slide_count,
            (SELECT max(m.created_at) FROM anatomic.object_movements m WHERE m.tenant_id = $1 AND m.object_kind = 'block' AND m.object_id = b.id) AS last_movement_at
       FROM anatomic.blocks b JOIN anatomic.cases c ON c.tenant_id = b.tenant_id AND c.id = b.case_id
      WHERE b.tenant_id = $1 AND ($2::text[] IS NULL OR b.location_status = ANY($2::text[])) AND ($3::uuid IS NULL OR b.case_id = $3::uuid)
      ORDER BY b.created_at DESC, b.id LIMIT $4 OFFSET $5`,
    [i.tenantId, i.locationStatuses ?? null, i.caseId ?? null, i.limit, i.offset]);
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
