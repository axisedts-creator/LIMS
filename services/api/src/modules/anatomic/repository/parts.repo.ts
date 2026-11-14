// anatomic.parts — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { setClause, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

const PARTS_UPDATABLE = { specimen_id: '', specimen_type_code: '', specimen_state: '', site_text: '', description_text: '' } as const;

export async function insertPart(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.parts (id, tenant_id, centre_id, case_id, letter, letter_seq, specimen_id, specimen_type_code, specimen_state, site_text, description_text, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::text, 'none'), $10, $11, $12, $13) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['case_id'] ?? null, row['letter'] ?? null, row['letter_seq'] ?? null, row['specimen_id'] ?? null, row['specimen_type_code'] ?? null, row['specimen_state'] ?? null, row['site_text'] ?? null, row['description_text'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getPart(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.parts WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listParts(tx: Q, i: { tenantId: string; caseId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.parts WHERE tenant_id = $1 AND case_id = $2 ORDER BY letter_seq, id`, [i.tenantId, i.caseId]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updatePart(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, PARTS_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.parts SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}
