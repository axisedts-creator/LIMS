// anatomic.settings / anatomic.test_profiles / anatomic.stains / anatomic.assays / anatomic.assay_targets / anatomic.assay_target_values — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { page, setClause, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

const SETTINGS_UPDATABLE = { auto_accession_on_receipt: '', require_gross_complete_for_processing: '', default_routine_stain_code: '', max_images_per_case: '', max_report_images: '' } as const;
const TEST_PROFILES_UPDATABLE = { case_kind: '', is_addon: '', requires_gross: '', default_stain_code: '', default_synoptic_template_keys: '', is_active: '' } as const;
const STAINS_UPDATABLE = { display: '', kind: '', addon_test_id: '', sort_order: '', is_active: '' } as const;
const ASSAYS_UPDATABLE = { display: '', method_text_default: '', is_active: '' } as const;
const ASSAY_TARGETS_UPDATABLE = { display: '', allows_quantitative: '', unit_code: '', decimals: '', sort_order: '', is_active: '' } as const;
const ASSAY_TARGET_VALUES_UPDATABLE = { display: '', is_abnormal: '', sort_order: '', is_active: '' } as const;

/** Lazy tenant defaults (05-SCHEMA §2.3): the tenant's row already exists -> undefined (ON CONFLICT DO NOTHING, no aborted tx); the caller re-reads. */
export async function insertSettings(tx: Q, row: Row): Promise<Row | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.settings (id, tenant_id, auto_accession_on_receipt, require_gross_complete_for_processing, default_routine_stain_code, max_images_per_case, max_report_images, created_by, updated_by)
     VALUES ($1, $2, COALESCE($3::boolean, false), COALESCE($4::boolean, true), COALESCE($5::text, 'HE'), COALESCE($6::integer, 50), COALESCE($7::integer, 12), $8, $9)
     ON CONFLICT DO NOTHING RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['auto_accession_on_receipt'] ?? null, row['require_gross_complete_for_processing'] ?? null, row['default_routine_stain_code'] ?? null, row['max_images_per_case'] ?? null, row['max_report_images'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0];
}

export async function getSettings(tx: Q, i: { tenantId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.settings WHERE tenant_id = $1`, [i.tenantId]);
  return rows[0];
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateSettings(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, SETTINGS_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.settings SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}

export async function insertTestProfile(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.test_profiles (id, tenant_id, test_id, case_kind, is_addon, requires_gross, default_stain_code, default_synoptic_template_keys, created_by, updated_by)
     VALUES ($1, $2, $3, $4, COALESCE($5::boolean, false), COALESCE($6::boolean, true), $7, COALESCE($8::text[], '{}'), $9, $10) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['test_id'] ?? null, row['case_kind'] ?? null, row['is_addon'] ?? null, row['requires_gross'] ?? null, row['default_stain_code'] ?? null, row['default_synoptic_template_keys'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getTestProfile(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.test_profiles WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

/** Profile of a catalog test (unique per tenant + test_id). */
export async function getTestProfileByTestId(tx: Q, i: { tenantId: string; testId: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.test_profiles WHERE tenant_id = $1 AND test_id = $2`, [i.tenantId, i.testId]);
  return rows[0];
}

export async function listTestProfiles(tx: Q, i: { tenantId: string; activeOnly?: boolean; limit?: number; offset?: number }): Promise<Row[]> {
  const p = page(i);
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.test_profiles WHERE tenant_id = $1 AND (NOT $2::boolean OR is_active)
     ORDER BY created_at, id LIMIT $3 OFFSET $4`,
    [i.tenantId, i.activeOnly ?? false, p.limit, p.offset]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateTestProfile(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, TEST_PROFILES_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.test_profiles SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}

export async function insertStain(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.stains (id, tenant_id, code, display, kind, addon_test_id, sort_order, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::integer, 0), $8, $9) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['code'] ?? null, row['display'] ?? null, row['kind'] ?? null, row['addon_test_id'] ?? null, row['sort_order'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getStain(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.stains WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listStains(tx: Q, i: { tenantId: string; activeOnly?: boolean; limit?: number; offset?: number }): Promise<Row[]> {
  const p = page(i);
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.stains WHERE tenant_id = $1 AND (NOT $2::boolean OR is_active)
     ORDER BY sort_order, code, id LIMIT $3 OFFSET $4`,
    [i.tenantId, i.activeOnly ?? false, p.limit, p.offset]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateStain(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, STAINS_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.stains SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}

export async function insertAssay(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.assays (id, tenant_id, code, display, method_text_default, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['code'] ?? null, row['display'] ?? null, row['method_text_default'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getAssay(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.assays WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listAssays(tx: Q, i: { tenantId: string; activeOnly?: boolean; limit?: number; offset?: number }): Promise<Row[]> {
  const p = page(i);
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.assays WHERE tenant_id = $1 AND (NOT $2::boolean OR is_active)
     ORDER BY code, id LIMIT $3 OFFSET $4`,
    [i.tenantId, i.activeOnly ?? false, p.limit, p.offset]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateAssay(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, ASSAYS_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.assays SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}

export async function insertAssayTarget(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.assay_targets (id, tenant_id, assay_id, code, display, allows_quantitative, unit_code, decimals, sort_order, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::boolean, false), $7, $8, COALESCE($9::integer, 0), $10, $11) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['assay_id'] ?? null, row['code'] ?? null, row['display'] ?? null, row['allows_quantitative'] ?? null, row['unit_code'] ?? null, row['decimals'] ?? null, row['sort_order'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getAssayTarget(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.assay_targets WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listAssayTargets(tx: Q, i: { tenantId: string; assayId: string; activeOnly?: boolean }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.assay_targets WHERE tenant_id = $1 AND assay_id = $2 AND (NOT $3::boolean OR is_active) ORDER BY sort_order, code, id`, [i.tenantId, i.assayId, i.activeOnly ?? false]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateAssayTarget(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, ASSAY_TARGETS_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.assay_targets SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}

export async function insertAssayTargetValue(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.assay_target_values (id, tenant_id, target_id, code, display, is_abnormal, sort_order, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::boolean, false), COALESCE($7::integer, 0), $8, $9) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['target_id'] ?? null, row['code'] ?? null, row['display'] ?? null, row['is_abnormal'] ?? null, row['sort_order'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getAssayTargetValue(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.assay_target_values WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listAssayTargetValues(tx: Q, i: { tenantId: string; targetId: string; activeOnly?: boolean }): Promise<Row[]> {
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.assay_target_values WHERE tenant_id = $1 AND target_id = $2 AND (NOT $3::boolean OR is_active) ORDER BY sort_order, code, id`, [i.tenantId, i.targetId, i.activeOnly ?? false]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateAssayTargetValue(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, ASSAY_TARGET_VALUES_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.assay_target_values SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}
