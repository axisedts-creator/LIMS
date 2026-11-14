// reporting.print_jobs access (R10-R13, T5; 05-SCHEMA §2.14). REQ-SEC-024: every statement names tenant_id next to RLS (`__tenant_centre` hides other centres). Static SQL, parameters only.
import type { Tx } from './settings.repo.js';
export type { Tx };

export interface PrintInsert {
  id: string; tenantId: string; centreId: string; kind: 'single' | 'bulk' | 'template_preview'; versionIds: string[]; excludedIds: string[]; templateVersionId: string | null;
  variant: string; copies: number; draftWatermark: boolean; state: 'rendering' | 'ready'; expiresAt: string; actorId: string;
}

export async function insertPrint(tx: Tx, p: PrintInsert): Promise<void> {
  await tx.query(
    `INSERT INTO reporting.print_jobs (id, tenant_id, centre_id, kind, report_version_ids, excluded_ids, template_version_id, variant, copies, draft_watermark, state, expires_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5::uuid[], $6::uuid[], $7, $8, $9, $10, $11, $12, $13, $13)`,
    [p.id, p.tenantId, p.centreId, p.kind, p.versionIds, p.excludedIds, p.templateVersionId, p.variant, p.copies, p.draftWatermark, p.state, p.expiresAt, p.actorId]);
}

export async function findPrint(tx: Tx, tenantId: string, id: string): Promise<any | undefined> {
  return (await tx.query(`SELECT id, centre_id, kind, report_version_ids, excluded_ids, template_version_id, variant, copies, draft_watermark, state, object_path, expires_at, error_code
    FROM reporting.print_jobs WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows[0];
}

/** Never a discarded version. Centre scope = RLS: out-of-scope == unknown. */
export async function findVersionForPrint(tx: Tx, tenantId: string, id: string): Promise<any | undefined> {
  return (await tx.query(`SELECT id, report_id, version_no, centre_id, patient_id, released_at, template_version_id, pdf_object_path
    FROM reporting.report_versions WHERE tenant_id = $1 AND id = $2 AND status <> 'discarded'`, [tenantId, id])).rows[0];
}

export async function findVersionsForPrint(tx: Tx, tenantId: string, ids: string[]): Promise<any[]> {
  return (await tx.query(`SELECT id, report_id, version_no, centre_id, patient_id, released_at, template_version_id, pdf_object_path
    FROM reporting.report_versions WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status <> 'discarded'`, [tenantId, ids])).rows;
}
