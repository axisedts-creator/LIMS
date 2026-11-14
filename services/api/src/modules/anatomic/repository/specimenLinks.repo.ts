// anatomic.specimen_links — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { setClause, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

const SPECIMEN_LINKS_UPDATABLE = { case_id: '', part_id: '', link_kind: '', last_seq: '', last_status: '' } as const;

export async function insertSpecimenLink(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.specimen_links (id, tenant_id, centre_id, specimen_id, case_id, part_id, link_kind, last_seq, last_status, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['centre_id'] ?? null, row['specimen_id'] ?? null, row['case_id'] ?? null, row['part_id'] ?? null, row['link_kind'] ?? null, row['last_seq'] ?? null, row['last_status'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getSpecimenLink(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.specimen_links WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listSpecimenLinks(tx: Q, i: { tenantId: string; caseId: string }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.specimen_links WHERE tenant_id = $1 AND case_id = $2 ORDER BY created_at, id`, [i.tenantId, i.caseId]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateSpecimenLink(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, SPECIMEN_LINKS_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.specimen_links SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}

/** Link row of a C5 specimen (unique per specimen), if any. forUpdate: row lock for the intake stale-seq check (02-TRD §4.1 step 2). */
export async function getSpecimenLinkBySpecimen(tx: Q, i: { tenantId: string; specimenId: string; forUpdate?: boolean }): Promise<Row | undefined> {
  const { rows } = await tx.query(
    i.forUpdate
      ? `SELECT * FROM anatomic.specimen_links WHERE tenant_id = $1 AND specimen_id = $2 FOR UPDATE`
      : `SELECT * FROM anatomic.specimen_links WHERE tenant_id = $1 AND specimen_id = $2`, [i.tenantId, i.specimenId]);
  return rows[0];
}
