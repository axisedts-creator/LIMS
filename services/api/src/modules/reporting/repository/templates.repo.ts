// reporting.report_templates / report_template_versions (T1-T4, T6; 02-TRD §6.4; 05-SCHEMA §2.12). REQ-SEC-024: explicit tenant_id on every statement.
// Static SQL only; every value is a parameter. Optimistic locking is report_templates.version (If-Match). Nothing here deletes: versions are history.
// The config of a version row is written only while it is a draft; the DB trigger (app.enforce_mutable_columns) is the backstop.
import type { Tx } from './settings.repo.js';
export type { Tx };

// ---------------------------------------------------------------------------------------------------- templates
export async function listTemplates(tx: Tx, tenantId: string, family: string | null): Promise<any[]> {
  const { rows } = await tx.query(`SELECT id, tenant_id, family, name, current_version_id, is_active, version FROM reporting.report_templates
    WHERE tenant_id = $1 AND ($2::text IS NULL OR family = $2::text) ORDER BY name, id LIMIT 200`, [tenantId, family]);
  return rows;
}

export async function findTemplate(tx: Tx, tenantId: string, id: string): Promise<any | undefined> {
  const { rows } = await tx.query(`SELECT * FROM reporting.report_templates WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows[0];
}

export async function insertTemplate(tx: Tx, r: { id: string; tenantId: string; family: string; name: string; actorId: string }): Promise<any> {
  const { rows } = await tx.query(`INSERT INTO reporting.report_templates (id, tenant_id, family, name, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`, [r.id, r.tenantId, r.family, r.name, r.actorId]);
  return rows[0];
}

/** If-Match gate (T4/T6): bumps report_templates.version at the expected version; undefined = stale / lost the race. `$4` NULL keeps current_version_id. */
export async function bumpTemplate(tx: Tx, tenantId: string, id: string, expectedVersion: number, currentVersionId: string | null, actorId: string): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.report_templates SET current_version_id = COALESCE($4, current_version_id), version = version + 1,
      updated_by = $5, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`, [tenantId, id, expectedVersion, currentVersionId, actorId]);
  return rows[0];
}

// ---------------------------------------------------------------------------------------------------- versions
/** Every version of one template, config included, ascending. */
export async function versionsOf(tx: Tx, tenantId: string, templateId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM reporting.report_template_versions WHERE tenant_id = $1 AND template_id = $2 ORDER BY version_no LIMIT 500`,
    [tenantId, templateId]);
  return rows;
}

/** T1 summary: version numbers and status of the live (draft / published) rows of every template of the tenant; no config. */
export async function liveVersionsOfTenant(tx: Tx, tenantId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT template_id, tenant_id, version_no, status FROM reporting.report_template_versions
    WHERE tenant_id = $1 AND status <> 'retired' LIMIT 2000`, [tenantId]);
  return rows;
}

export async function findVersion(tx: Tx, tenantId: string, id: string): Promise<any | undefined> {
  const { rows } = await tx.query(`SELECT * FROM reporting.report_template_versions WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows[0];
}

export async function insertVersion(tx: Tx, r: { id: string; tenantId: string; templateId: string; versionNo: number; config: unknown; sha256: string; actorId: string }): Promise<any> {
  const { rows } = await tx.query(`INSERT INTO reporting.report_template_versions (id, tenant_id, template_id, version_no, status, config, config_sha256, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8) RETURNING *`,
  [r.id, r.tenantId, r.templateId, r.versionNo, 'draft', JSON.stringify(r.config), r.sha256, r.actorId]);
  return rows[0];
}

/** T4: draft only. undefined = the row is not a draft any more. */
export async function saveDraft(tx: Tx, tenantId: string, id: string, config: unknown, sha256: string, actorId: string): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.report_template_versions SET config = $3::jsonb, config_sha256 = $4, version = version + 1, updated_by = $5, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND status = 'draft' RETURNING *`, [tenantId, id, JSON.stringify(config), sha256, actorId]);
  return rows[0];
}

/** T6 step 1: the live published row of the template becomes retired (the only change the DB guard allows on a frozen row). */
export async function retirePublished(tx: Tx, tenantId: string, templateId: string, actorId: string): Promise<any[]> {
  const { rows } = await tx.query(`UPDATE reporting.report_template_versions SET status = 'retired', version = version + 1, updated_by = $3, updated_at = now()
    WHERE tenant_id = $1 AND template_id = $2 AND status = 'published' RETURNING id`, [tenantId, templateId, actorId]);
  return rows;
}

/** T6 step 2: draft -> published. undefined = not a draft any more. */
export async function promoteDraft(tx: Tx, tenantId: string, id: string, at: string, actorId: string): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.report_template_versions SET status = 'published', published_at = $3::timestamptz, published_by = $4,
      version = version + 1, updated_by = $4, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND status = 'draft' RETURNING *`, [tenantId, id, at, actorId]);
  return rows[0];
}
