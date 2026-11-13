// anatomic.cs_cancel_reasons / anatomic.cs_diagnoses / anatomic.cs_cytology_adequacy — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { page, setClause, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

const CS_CANCEL_REASONS_UPDATABLE = { display: '', system: '', system_version: '', sort_order: '', is_active: '' } as const;
const CS_DIAGNOSES_UPDATABLE = { display: '', system: '', system_version: '', sort_order: '', is_active: '' } as const;
const CS_CYTOLOGY_ADEQUACY_UPDATABLE = { display: '', system: '', system_version: '', sort_order: '', is_active: '' } as const;

export async function insertCodedCancelReason(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.cs_cancel_reasons (id, tenant_id, code, display, system, system_version, sort_order, created_by, updated_by)
     VALUES ($1, $2, $3, $4, COALESCE($5::text, 'local'), $6, COALESCE($7::integer, 0), $8, $9) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['code'] ?? null, row['display'] ?? null, row['system'] ?? null, row['system_version'] ?? null, row['sort_order'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getCodedCancelReason(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.cs_cancel_reasons WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listCodedCancelReasons(tx: Q, i: { tenantId: string; activeOnly?: boolean; q?: string; limit?: number; offset?: number }): Promise<Row[]> {
  const p = page(i);
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.cs_cancel_reasons WHERE tenant_id = $1 AND (NOT $2::boolean OR is_active) AND ($3::text = '' OR strpos(lower(display), lower($3)) > 0)
     ORDER BY sort_order, code, id LIMIT $4 OFFSET $5`,
    [i.tenantId, i.activeOnly ?? false, i.q ?? '', p.limit, p.offset]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateCodedCancelReason(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, CS_CANCEL_REASONS_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.cs_cancel_reasons SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}

export async function insertCodedDiagnosis(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.cs_diagnoses (id, tenant_id, code, display, system, system_version, sort_order, created_by, updated_by)
     VALUES ($1, $2, $3, $4, COALESCE($5::text, 'local'), $6, COALESCE($7::integer, 0), $8, $9) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['code'] ?? null, row['display'] ?? null, row['system'] ?? null, row['system_version'] ?? null, row['sort_order'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getCodedDiagnosis(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.cs_diagnoses WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listCodedDiagnoses(tx: Q, i: { tenantId: string; activeOnly?: boolean; q?: string; limit?: number; offset?: number }): Promise<Row[]> {
  const p = page(i);
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.cs_diagnoses WHERE tenant_id = $1 AND (NOT $2::boolean OR is_active) AND ($3::text = '' OR strpos(lower(display), lower($3)) > 0)
     ORDER BY sort_order, code, id LIMIT $4 OFFSET $5`,
    [i.tenantId, i.activeOnly ?? false, i.q ?? '', p.limit, p.offset]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateCodedDiagnosis(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, CS_DIAGNOSES_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.cs_diagnoses SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}

export async function insertCodedCytologyAdequacy(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.cs_cytology_adequacy (id, tenant_id, code, display, system, system_version, sort_order, created_by, updated_by)
     VALUES ($1, $2, $3, $4, COALESCE($5::text, 'local'), $6, COALESCE($7::integer, 0), $8, $9) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['code'] ?? null, row['display'] ?? null, row['system'] ?? null, row['system_version'] ?? null, row['sort_order'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getCodedCytologyAdequacy(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.cs_cytology_adequacy WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listCodedCytologyAdequacies(tx: Q, i: { tenantId: string; activeOnly?: boolean; q?: string; limit?: number; offset?: number }): Promise<Row[]> {
  const p = page(i);
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.cs_cytology_adequacy WHERE tenant_id = $1 AND (NOT $2::boolean OR is_active) AND ($3::text = '' OR strpos(lower(display), lower($3)) > 0)
     ORDER BY sort_order, code, id LIMIT $4 OFFSET $5`,
    [i.tenantId, i.activeOnly ?? false, i.q ?? '', p.limit, p.offset]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateCodedCytologyAdequacy(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, CS_CYTOLOGY_ADEQUACY_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.cs_cytology_adequacy SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}

/** Global seed (no tenant data, read-only): platform cancel reasons that tenant rows shadow by code. */
export async function listGlobalCancelReasons(tx: Q): Promise<Row[]> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.g_cs_cancel_reasons WHERE is_active ORDER BY sort_order, code`);
  return rows;
}
