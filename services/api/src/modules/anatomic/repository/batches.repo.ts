// anatomic.batches / anatomic.batch_members — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { page, setClause, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

const BATCHES_UPDATABLE = { status: '', kit_name: '', kit_lot: '', kit_expiry_on: '', instrument_text: '', run_at: '', capacity: '', closed_at: '' } as const;
const BATCH_MEMBERS_UPDATABLE = { position: '', is_active: '', removed_at: '' } as const;

export async function insertBatch(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.batches (id, tenant_id, batch_no, assay_id, status, kit_name, kit_lot, kit_expiry_on, instrument_text, run_at, capacity, closed_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, COALESCE($5::text, 'open'), $6, $7, $8, $9, $10, COALESCE($11::integer, 96), $12, $13, $14) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['batch_no'] ?? null, row['assay_id'] ?? null, row['status'] ?? null, row['kit_name'] ?? null, row['kit_lot'] ?? null, row['kit_expiry_on'] ?? null, row['instrument_text'] ?? null, row['run_at'] ?? null, row['capacity'] ?? null, row['closed_at'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

/** forUpdate: take the batch row lock (serialises member changes against close, Q5/Q6/Q7). */
export async function getBatch(tx: Q, i: { tenantId: string; id: string; forUpdate?: boolean }): Promise<Row | undefined> {
  const sql = i.forUpdate
    ? `SELECT * FROM anatomic.batches WHERE tenant_id = $1 AND id = $2 FOR UPDATE`
    : `SELECT * FROM anatomic.batches WHERE tenant_id = $1 AND id = $2`;
  const { rows } = await tx.query(sql, [i.tenantId, i.id]);
  return rows[0];
}

export async function listBatches(tx: Q, i: { tenantId: string; status?: string; assayId?: string; limit?: number; offset?: number }): Promise<Row[]> {
  const p = page(i);
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.batches WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($5::uuid IS NULL OR assay_id = $5)
     ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`,
    [i.tenantId, i.status ?? null, p.limit, p.offset, i.assayId ?? null]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateBatch(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, BATCHES_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.batches SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}

export async function insertBatchMember(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.batch_members (id, tenant_id, batch_id, case_id, position, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['batch_id'] ?? null, row['case_id'] ?? null, row['position'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getBatchMember(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.batch_members WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listBatchMembers(tx: Q, i: { tenantId: string; batchId: string; activeOnly?: boolean }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.batch_members WHERE tenant_id = $1 AND batch_id = $2 AND (NOT $3::boolean OR is_active) ORDER BY position, id`, [i.tenantId, i.batchId, i.activeOnly ?? false]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateBatchMember(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, BATCH_MEMBERS_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.batch_members SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}
