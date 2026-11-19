// reporting.print_profile and reporting.signatory_profile (T0B-PRINTCFG-1; migration 20261117160000, T0C-PRINTCFG-1). REQ-SEC-024: tenant_id is bound
// explicitly on every statement in addition to RLS. Branch and user existence come from the FKs (23503 -> common.not_found in core mapDbError); no core.* read. Static SQL only, values are parameters. No DELETE (lims_app has none): a profile is deactivated.
import type { PrintProfileInput, SignatoryProfileInput } from '../domain/printProfile.js';

export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

const vals = (p: PrintProfileInput) => [p.paper_mode, p.header_text, p.footer_text, p.reserve_top_mm, p.reserve_bottom_mm, p.show_logo, p.show_seller_pan, p.grayscale, p.font_size_pt];

export async function listPrintProfiles(tx: Tx, tenantId: string, f: { documentKind?: string; branchId?: string }): Promise<any[]> {
  const { rows } = await tx.query(
    `SELECT * FROM reporting.print_profile WHERE tenant_id = $1 AND is_active AND ($2::text IS NULL OR document_kind = $2) AND ($3::uuid IS NULL OR branch_id = $3)
       ORDER BY document_kind, branch_id NULLS FIRST, recipient_type NULLS FIRST, id LIMIT 200`, [tenantId, f.documentKind ?? null, f.branchId ?? null]);
  return rows;
}

/** One active row per key (partial unique index print_profile__active_key__uq): an active upsert is one atomic INSERT .. ON CONFLICT (race safe). */
export async function upsertPrintProfile(tx: Tx, a: { id: string; tenantId: string; actorId: string; p: PrintProfileInput }): Promise<any> {
  const { p } = a;
  const key = [a.tenantId, p.branch_id ?? null, p.document_kind, p.recipient_type ?? null];
  if (!p.is_active) {   // deactivate the active row of the key; none -> keep the inactive row as history
    const { rows } = await tx.query(
      `UPDATE reporting.print_profile SET (paper_mode, header_text, footer_text, reserve_top_mm, reserve_bottom_mm, show_logo, show_seller_pan, grayscale, font_size_pt)
           = ($5, $6, $7, $8, $9, $10, $11, $12, $13), is_active = false, version = version + 1, updated_at = now(), updated_by = $14
         WHERE tenant_id = $1 AND branch_id IS NOT DISTINCT FROM $2::uuid AND document_kind = $3 AND recipient_type IS NOT DISTINCT FROM $4::text AND is_active RETURNING *`, [...key, ...vals(p), a.actorId]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await tx.query(
    `INSERT INTO reporting.print_profile (id, tenant_id, branch_id, document_kind, recipient_type, paper_mode, header_text, footer_text, reserve_top_mm,
       reserve_bottom_mm, show_logo, show_seller_pan, grayscale, font_size_pt, is_active, created_by, updated_by)
       VALUES ($1, $2, $3::uuid, $4, $5::text, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)
     ON CONFLICT (tenant_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), document_kind, coalesce(recipient_type, '')) WHERE is_active
     DO UPDATE SET paper_mode = EXCLUDED.paper_mode, header_text = EXCLUDED.header_text, footer_text = EXCLUDED.footer_text, reserve_top_mm = EXCLUDED.reserve_top_mm,
       reserve_bottom_mm = EXCLUDED.reserve_bottom_mm, show_logo = EXCLUDED.show_logo, show_seller_pan = EXCLUDED.show_seller_pan, grayscale = EXCLUDED.grayscale,
       font_size_pt = EXCLUDED.font_size_pt, version = reporting.print_profile.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING *`, [a.id, ...key, ...vals(p), p.is_active, a.actorId]);
  return rows[0];
}

/** previewPrintProfile: the render job (same task as previewReportTemplate); the draft profile travels in the payload, never stored. */
export async function enqueuePreview(tx: Tx, a: { task: string; tenantId: string; printJobId: string; documentKind: string; printProfile: unknown; maxAttempts: number }): Promise<void> {
  await tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)',
    [a.task, JSON.stringify({ tenant_id: a.tenantId, print_job_id: a.printJobId, document_kind: a.documentKind, print_profile: a.printProfile }), `print:${a.printJobId}`, null, a.maxAttempts]);
}

export async function listSignatoryProfiles(tx: Tx, tenantId: string): Promise<any[]> {
  return (await tx.query('SELECT * FROM reporting.signatory_profile WHERE tenant_id = $1 ORDER BY display_name, user_id LIMIT 500', [tenantId])).rows;
}
export async function upsertSignatoryProfile(tx: Tx, a: { id: string; tenantId: string; userId: string; actorId: string; s: SignatoryProfileInput }): Promise<any> {
  const { s } = a;
  const { rows } = await tx.query(
    `INSERT INTO reporting.signatory_profile (id, tenant_id, user_id, display_name, title, registration_no, signature_asset_id, is_active, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET display_name = EXCLUDED.display_name, title = EXCLUDED.title, registration_no = EXCLUDED.registration_no,
       signature_asset_id = EXCLUDED.signature_asset_id, is_active = EXCLUDED.is_active, version = reporting.signatory_profile.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING *`, [a.id, a.tenantId, a.userId, s.display_name, s.title ?? null, s.registration_no ?? null, s.signature_asset_id ?? null, s.is_active, a.actorId]);
  return rows[0];
}
