// Default SQL repo of the settings service (02-TRD §5.6; 05-SCHEMA §4.6, §4.10). SQL on the request tx; every statement names tenant_id
// explicitly on top of RLS (REQ-SEC-040). No DELETE (assets are kept; no grant).
import type { AssetRow, Row, SettingsRepo } from '../service/settings.service.js';

type Tx = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
const q = async (tx: unknown, sql: string, params: unknown[]) => (await (tx as Tx).query(sql, params)).rows;

const SETTINGS_SELECT = `SELECT s.*, t.billing_live_on::text AS billing_live_on
  FROM identity.tenant_settings s JOIN core.tenants t ON t.id = s.tenant_id
  WHERE s.tenant_id = $1`;

// Patch = jsonb of the changed columns (unset -> null). jsonb_populate_record(s, patch) keeps every column the patch does not name.
// Only tenant-editable + system pending_* columns are listed: platform-only columns (ird_pan, ird_annex_1_record_id, legal_name_snapshot) can never change here.
const SETTINGS_UPDATE = `UPDATE identity.tenant_settings s SET
  (calendar_display, timezone, idle_timeout_minutes, absolute_session_hours, password_min_length, support_access_mode, report_link_ttl_days,
   release_requires_payment, partial_release_allowed, letterhead_default, numbering_prefix, patient_code_pattern, registration_no_pattern, barcode_pattern,
   invoice_no_pattern, credit_note_no_pattern, receipt_no_pattern, barcode_prefix, accession_no_pattern, accession_prefix_histology, accession_prefix_cytology,
   accession_prefix_ihc, accession_prefix_molecular, pending_invoice_no_pattern, pending_credit_note_no_pattern, pending_effective_fy_bs,
   whatsapp_enabled, sms_enabled, email_enabled, sms_sender_id, retention_clinical_years, retention_audit_years, retention_raw_instrument_years,
   auto_verification_enabled, westgard_mode, cbms_realtime_required, abbreviated_invoice_limit_paisa, display_name, address_lines, phones, contact_email,
   website, logo_asset_id, letterhead_header_asset_id, letterhead_footer_asset_id, receipt_footer_note, accent_color)
  = (SELECT r.calendar_display, r.timezone, r.idle_timeout_minutes, r.absolute_session_hours, r.password_min_length, r.support_access_mode, r.report_link_ttl_days,
   r.release_requires_payment, r.partial_release_allowed, r.letterhead_default, r.numbering_prefix, r.patient_code_pattern, r.registration_no_pattern, r.barcode_pattern,
   r.invoice_no_pattern, r.credit_note_no_pattern, r.receipt_no_pattern, r.barcode_prefix, r.accession_no_pattern, r.accession_prefix_histology, r.accession_prefix_cytology,
   r.accession_prefix_ihc, r.accession_prefix_molecular, r.pending_invoice_no_pattern, r.pending_credit_note_no_pattern, r.pending_effective_fy_bs,
   r.whatsapp_enabled, r.sms_enabled, r.email_enabled, r.sms_sender_id, r.retention_clinical_years, r.retention_audit_years, r.retention_raw_instrument_years,
   r.auto_verification_enabled, r.westgard_mode, r.cbms_realtime_required, r.abbreviated_invoice_limit_paisa, r.display_name, r.address_lines, r.phones, r.contact_email,
   r.website, r.logo_asset_id, r.letterhead_header_asset_id, r.letterhead_footer_asset_id, r.receipt_footer_note, r.accent_color
   FROM jsonb_populate_record(s, $3::jsonb) r),
  updated_at = now(), updated_by = $4, version = s.version + 1
  WHERE s.tenant_id = $1 AND s.version = $2 RETURNING s.tenant_id`;

// Upload has no If-Match: the pointer write is unconditional and bumps the version (stale editors then get 409).
const POINTER_UPDATE = `UPDATE identity.tenant_settings SET
  logo_asset_id = CASE WHEN $2 = 'logo_asset_id' THEN $3::uuid ELSE logo_asset_id END,
  letterhead_header_asset_id = CASE WHEN $2 = 'letterhead_header_asset_id' THEN $3::uuid ELSE letterhead_header_asset_id END,
  letterhead_footer_asset_id = CASE WHEN $2 = 'letterhead_footer_asset_id' THEN $3::uuid ELSE letterhead_footer_asset_id END,
  updated_at = now(), updated_by = $4, version = version + 1 WHERE tenant_id = $1`;

const ASSET_COLS = `id, tenant_id, kind, membership_id, bucket, object_path, content_type, size_bytes, width_px, height_px,
  encode(sha256, 'hex') AS sha256, is_active, scan_state, version`;

export function createSettingsRepo(): SettingsRepo {
  return {
    async findSettings(tx, t) { return (await q(tx, SETTINGS_SELECT, [t]))[0] as Row | undefined; },
    async updateSettings(tx, t, v, set, unset, actorId) {
      const patch: Row = { ...set }; for (const c of unset) patch[c] = null;
      const hit = await q(tx, SETTINGS_UPDATE, [t, v, JSON.stringify(patch), actorId]);
      return hit.length ? ((await q(tx, SETTINGS_SELECT, [t]))[0] as Row) : undefined;
    },
    async setAssetPointer(tx, t, column, assetId, actorId) { await q(tx, POINTER_UPDATE, [t, column, assetId, actorId]); },
    async findAsset(tx, t, id) {
      return (await q(tx, `SELECT ${ASSET_COLS}
        FROM identity.branding_assets WHERE tenant_id = $1 AND id = $2`, [t, id]))[0] as AssetRow | undefined;
    },
    async insertAsset(tx, t, r) {
      return (await q(tx, `INSERT INTO identity.branding_assets (id, tenant_id, kind, membership_id, bucket, object_path, content_type, size_bytes,
          width_px, height_px, sha256, scan_state, created_by, updated_by)
        VALUES ($2, $1, $3, $4, $5, $6, $7, $8, $9, $10, decode($11, 'hex'), $12, $13, $13) RETURNING ${ASSET_COLS}`,
      [t, r.id, r.kind, r.membership_id, r.bucket, r.object_path, r.content_type, r.size_bytes, r.width_px, r.height_px, r.sha256, r.scan_state, r.actorId]))[0] as AssetRow;
    },
    async enqueueJob(tx, j) { await q(tx, 'SELECT app.enqueue_job($1, $2::jsonb, $3)', [j.taskIdentifier, JSON.stringify(j.payload), j.jobKey]); },
  };
}
