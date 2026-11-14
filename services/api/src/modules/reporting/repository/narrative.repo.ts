// reporting.narrative_templates / narrative_reports / narrative_versions (N1-N5, N8-N10; 02-TRD §6.4; 05-SCHEMA narrative_*).
// REQ-SEC-024: explicit tenant_id on every statement. Static SQL only; every value is a parameter. Optimistic locking is the
// narrative_reports.version column (If-Match); every narrative_versions UPDATE is status-guarded (the DB trigger is only the backstop).
import type { Tx } from './settings.repo.js';
export type { Tx };

// ---------------------------------------------------------------------------------------------------- templates
export async function listTemplates(tx: Tx, tenantId: string, f: { kind: string | null; testId: string | null; isActive: boolean | null }): Promise<any[]> {
  const { rows } = await tx.query(`SELECT id, tenant_id, code, name, kind, test_id, sections, is_active, version FROM reporting.narrative_templates
    WHERE tenant_id = $1 AND ($2::text IS NULL OR kind = $2::text) AND ($3::uuid IS NULL OR test_id = $3::uuid)
      AND ($4::boolean IS NULL OR is_active = $4::boolean) ORDER BY code LIMIT 200`, [tenantId, f.kind, f.testId, f.isActive]);
  return rows;
}

export async function findTemplate(tx: Tx, tenantId: string, id: string): Promise<any | undefined> {
  const { rows } = await tx.query(`SELECT * FROM reporting.narrative_templates WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows[0];
}

export async function findTemplateByCode(tx: Tx, tenantId: string, code: string): Promise<any | undefined> {
  const { rows } = await tx.query(`SELECT id, tenant_id, code FROM reporting.narrative_templates WHERE tenant_id = $1 AND code = $2`, [tenantId, code]);
  return rows[0];
}

/** Active templates bound to one test. */
export async function activeTemplatesForTest(tx: Tx, tenantId: string, testId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM reporting.narrative_templates WHERE tenant_id = $1 AND test_id = $2 AND is_active = $3 ORDER BY code LIMIT 50`,
    [tenantId, testId, true]);
  return rows;
}

/** Active templates of one kind (the caller keeps the unbound ones: test_id IS NULL). */
export async function activeTemplatesForKind(tx: Tx, tenantId: string, kind: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM reporting.narrative_templates WHERE tenant_id = $1 AND kind = $2 AND is_active = $3 ORDER BY code LIMIT 200`,
    [tenantId, kind, true]);
  return rows;
}

export async function insertTemplate(tx: Tx, r: { id: string; tenantId: string; code: string; name: string; kind: string; testId: string | null; sections: unknown; actorId: string }): Promise<any> {
  const { rows } = await tx.query(`INSERT INTO reporting.narrative_templates (id, tenant_id, code, name, kind, test_id, sections, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8) RETURNING *`,
  [r.id, r.tenantId, r.code, r.name, r.kind, r.testId, JSON.stringify(r.sections), r.actorId]);
  return rows[0];
}

/** N10: only at the expected version; undefined = stale / lost the race. `$3`/`$4`/`$5` NULL keep the column (COALESCE). */
export async function updateTemplate(tx: Tx, tenantId: string, id: string, expectedVersion: number, p: { name: string | null; sections: unknown | null; isActive: boolean | null }, actorId: string): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.narrative_templates SET name = COALESCE($4, name), sections = COALESCE($5::jsonb, sections),
      is_active = COALESCE($6, is_active), version = version + 1, updated_by = $7, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
  [tenantId, id, expectedVersion, p.name, p.sections === null ? null : JSON.stringify(p.sections), p.isActive, actorId]);
  return rows[0];
}

// ---------------------------------------------------------------------------------------------------- narratives
export async function findNarrative(tx: Tx, tenantId: string, id: string): Promise<any | undefined> {
  const { rows } = await tx.query(`SELECT * FROM reporting.narrative_reports WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows[0];
}

export async function listNarratives(tx: Tx, tenantId: string, f: { status: string | null; kind: string | null; centreId: string | null; afterId: string | null; limit: number }): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM reporting.narrative_reports WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2::text)
      AND ($3::text IS NULL OR template_kind = $3::text) AND ($4::uuid IS NULL OR centre_id = $4::uuid)
      AND ($5::uuid IS NULL OR id < $5::uuid) ORDER BY id DESC LIMIT $6`, [tenantId, f.status, f.kind, f.centreId, f.afterId, f.limit]);
  return rows;
}

/** Narratives of one order item (readiness: the item is ready only when every one is signed). */
export async function narrativesOfItem(tx: Tx, tenantId: string, orderItemId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT id, status FROM reporting.narrative_reports WHERE tenant_id = $1 AND order_item_id = $2`, [tenantId, orderItemId]);
  return rows;
}

/** If-Match gate: bumps narrative_reports.version at the expected version; undefined = stale. Optional status / current version move. */
export async function bumpNarrative(tx: Tx, tenantId: string, id: string, expectedVersion: number,
  p: { status: string | null; currentVersionNo: number | null; signedVersionNo: number | null }, actorId: string): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.narrative_reports SET status = COALESCE($4, status), current_version_no = COALESCE($5, current_version_no),
      signed_version_no = COALESCE($6, signed_version_no), version = version + 1, updated_by = $7, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
  [tenantId, id, expectedVersion, p.status, p.currentVersionNo, p.signedVersionNo, actorId]);
  return rows[0];
}

// ---------------------------------------------------------------------------------------------------- versions
export async function findVersion(tx: Tx, tenantId: string, narrativeId: string, versionNo: number): Promise<any | undefined> {
  const { rows } = await tx.query(`SELECT * FROM reporting.narrative_versions WHERE tenant_id = $1 AND narrative_report_id = $2 AND version_no = $3`,
    [tenantId, narrativeId, versionNo]);
  return rows[0];
}

export async function versionsOf(tx: Tx, tenantId: string, narrativeId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM reporting.narrative_versions WHERE tenant_id = $1 AND narrative_report_id = $2 ORDER BY version_no LIMIT 100`,
    [tenantId, narrativeId]);
  return rows;
}

/** Idempotent insert of one version: a concurrent creator of the same (narrative, version_no) wins and this is a no-op. */
export async function insertVersion(tx: Tx, r: {
  id: string; tenantId: string; centreId: string; narrativeId: string; versionNo: number; templateId: string | null; sections: unknown; imageFileIds: string[];
  amendmentOf: number | null; reasonCode: string | null; reasonText: string | null; actorId: string;
}): Promise<void> {
  await tx.query(`INSERT INTO reporting.narrative_versions (id, tenant_id, centre_id, narrative_report_id, version_no, status, template_id, sections,
      image_file_ids, amendment_of_version_no, amendment_reason_code, amendment_reason_text, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::uuid[], $10, $11, $12, $13, $13)
    ON CONFLICT (tenant_id, narrative_report_id, version_no) DO NOTHING`,
  [r.id, r.tenantId, r.centreId, r.narrativeId, r.versionNo, 'draft', r.templateId, JSON.stringify(r.sections), r.imageFileIds,
    r.amendmentOf, r.reasonCode, r.reasonText, r.actorId]);
}

/** N3: draft only. `$5` NULL keeps the template. undefined = the version is no longer a draft. */
export async function saveDraft(tx: Tx, tenantId: string, narrativeId: string, versionNo: number, p: { templateId: string | null; sections: unknown; imageFileIds: string[] }, actorId: string): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.narrative_versions SET template_id = COALESCE($5, template_id), sections = $6::jsonb, image_file_ids = $7::uuid[],
      version = version + 1, updated_by = $8, updated_at = now()
    WHERE tenant_id = $1 AND narrative_report_id = $2 AND version_no = $3 AND status = $4 RETURNING *`,
  [tenantId, narrativeId, versionNo, 'draft', p.templateId, JSON.stringify(p.sections), p.imageFileIds, actorId]);
  return rows[0];
}

/** N4: draft -> signed with the signer and content hash. undefined = not a draft any more. */
export async function signVersion(tx: Tx, tenantId: string, narrativeId: string, versionNo: number, membershipId: string, at: string, sha256: string, actorId: string): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.narrative_versions SET status = $5, signed_by_membership_id = $6, signed_at = $7::timestamptz, content_sha256 = $8,
      version = version + 1, updated_by = $9, updated_at = now()
    WHERE tenant_id = $1 AND narrative_report_id = $2 AND version_no = $3 AND status = $4 RETURNING *`,
  [tenantId, narrativeId, versionNo, 'draft', 'signed', membershipId, at, sha256, actorId]);
  return rows[0];
}

/** N4 on an amendment: the previous signed version becomes superseded (the only status change the DB guard allows on a signed row). */
export async function supersedeVersion(tx: Tx, tenantId: string, narrativeId: string, versionNo: number, actorId: string): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.narrative_versions SET status = $5, version = version + 1, updated_by = $6, updated_at = now()
    WHERE tenant_id = $1 AND narrative_report_id = $2 AND version_no = $3 AND status = $4 RETURNING *`,
  [tenantId, narrativeId, versionNo, 'signed', 'superseded', actorId]);
  return rows[0];
}

// ---------------------------------------------------------------------------------------------------- images (input_files kind narrative_image)
export async function findImage(tx: Tx, tenantId: string, id: string): Promise<any | undefined> {
  const { rows } = await tx.query(`SELECT id, tenant_id, kind, state, narrative_report_id, caption FROM reporting.input_files WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows[0];
}

export async function setImageCaption(tx: Tx, tenantId: string, id: string, caption: string | null, actorId: string): Promise<void> {
  await tx.query(`UPDATE reporting.input_files SET caption = $4, version = version + 1, updated_by = $5, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND kind = $3`, [tenantId, id, 'narrative_image', caption, actorId]);
}

// ---------------------------------------------------------------------------------------------------- readiness hook
export async function setNarrativeReady(tx: Tx, tenantId: string, orderItemId: string, ready: boolean, actorId: string): Promise<string[]> {
  const { rows } = await tx.query(`UPDATE reporting.report_order_items SET narrative_ready = $3, version = version + 1, updated_by = $4, updated_at = now()
    WHERE tenant_id = $1 AND order_item_id = $2 AND item_status = $5 RETURNING report_id`, [tenantId, orderItemId, ready, actorId, 'active']);
  return [...new Set(rows.map((r) => r.report_id as string))];
}
