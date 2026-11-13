// anatomic.synoptic_templates / anatomic.text_templates — SQL only (02-TRD §3.1 layer rules). Every statement names tenant_id as a bound parameter (REQ-SEC-024);
// RLS (05-SCHEMA §7) is the second wall. fn(tx, input): the caller owns the transaction. Append-only tables (class A) have insert + reads only; nothing here deletes.
import type { Tx } from '../../../core/db/tx.js';
import { json, page, setClause, type Row } from './_sql.js';

type Q = Pick<Tx, 'query'>;

const SYNOPTIC_TEMPLATES_UPDATABLE = { status: '', title: '', applies_to_case_kinds: '', definition: 'jsonb', published_at: '', published_by: '', retired_at: '', is_active: '' } as const;
const TEXT_TEMPLATES_UPDATABLE = { title: '', body: '', is_active: '' } as const;

export async function insertSynopticTemplate(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.synoptic_templates (id, tenant_id, template_key, version_no, status, title, applies_to_case_kinds, definition, published_at, published_by, retired_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, COALESCE($5::text, 'draft'), $6, $7, $8::jsonb, $9, $10, $11, $12, $13) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['template_key'] ?? null, row['version_no'] ?? null, row['status'] ?? null, row['title'] ?? null, row['applies_to_case_kinds'] ?? null, json(row['definition']), row['published_at'] ?? null, row['published_by'] ?? null, row['retired_at'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getSynopticTemplate(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.synoptic_templates WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listSynopticTemplates(tx: Q, i: { tenantId: string; activeOnly?: boolean; limit?: number; offset?: number }): Promise<Row[]> {
  const p = page(i);
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.synoptic_templates WHERE tenant_id = $1 AND (NOT $2::boolean OR is_active)
     ORDER BY template_key, version_no DESC, id LIMIT $3 OFFSET $4`,
    [i.tenantId, i.activeOnly ?? false, p.limit, p.offset]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateSynopticTemplate(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, SYNOPTIC_TEMPLATES_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.synoptic_templates SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}

export async function insertTextTemplate(tx: Q, row: Row): Promise<Row> {
  const { rows } = await tx.query(
    `INSERT INTO anatomic.text_templates (id, tenant_id, short_code, section, title, body, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [row['id'] ?? null, row['tenant_id'] ?? null, row['short_code'] ?? null, row['section'] ?? null, row['title'] ?? null, row['body'] ?? null, row['created_by'] ?? null, row['updated_by'] ?? null]);
  return rows[0] as Row;
}

export async function getTextTemplate(tx: Q, i: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(`SELECT * FROM anatomic.text_templates WHERE tenant_id = $1 AND id = $2`, [i.tenantId, i.id]);
  return rows[0];
}

export async function listTextTemplates(tx: Q, i: { tenantId: string; activeOnly?: boolean; limit?: number; offset?: number }): Promise<Row[]> {
  const p = page(i);
  const { rows } = await tx.query(
    `SELECT * FROM anatomic.text_templates WHERE tenant_id = $1 AND (NOT $2::boolean OR is_active)
     ORDER BY section, short_code, id LIMIT $3 OFFSET $4`,
    [i.tenantId, i.activeOnly ?? false, p.limit, p.offset]);
  return rows;
}

/** Optimistic update: matches only while version = expectedVersion; undefined means stale or not visible. Only the listed columns can change. */
export async function updateTextTemplate(
  tx: Q, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row },
): Promise<Row | undefined> {
  const [SET, ARGS] = setClause(i.patch, TEXT_TEMPLATES_UPDATABLE, 5);
  const { rows } = await tx.query(
    `UPDATE anatomic.text_templates SET ${SET}, version = version + 1, updated_at = now(), updated_by = $4
     WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [i.tenantId, i.id, i.expectedVersion, i.actorId, ...ARGS]);
  return rows[0];
}
