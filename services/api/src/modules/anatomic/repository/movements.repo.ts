// anatomic.object_movements — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

export async function insertObjectMovement(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.object_movements (id, tenant_id, centre_id, case_id, object_kind, object_id, movement, from_location_status, to_location_status, location_text, destination_text, reason_code, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['case_id'] ?? null, row['object_kind'] ?? null, row['object_id'] ?? null, row['movement'] ?? null, row['from_location_status'] ?? null, row['to_location_status'] ?? null, row['location_text'] ?? null, row['destination_text'] ?? null, row['reason_code'] ?? null, row['note'] ?? null, row['created_by'] ?? null]);
  return rows[0] as Row;
}

export async function getObjectMovement(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.object_movements WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listObjectMovements(tx: Q, i: { tenantId: string; caseId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.object_movements WHERE tenant_id = $1 AND case_id = $2 ORDER BY created_at, id`, [i.tenantId, i.caseId]);
  return rows;
}

/** Location history of one block or slide, newest first. */
export async function listMovementsOfObject(tx: Q, i: { tenantId: string; objectKind: string; objectId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.object_movements WHERE tenant_id = $1 AND object_kind = $2 AND object_id = $3 ORDER BY created_at DESC, id`,
    [i.tenantId, i.objectKind, i.objectId]);
  return rows;
}
