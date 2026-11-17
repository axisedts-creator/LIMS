// Tenant-settings column classes + DTO mapping (05-SCHEMA §4.6 "editable by"; contracts/openapi/identity.yaml TenantSettingsDto). Pure.
// Shared by the tenant PATCH (settings.service, T16) and the platform PATCH (tenant.service, T22).
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as role.service).
import { instantToBs } from '../../../../../../packages/shared-ts/src/bsdate/index.js';

type Row = Record<string, any>;
export const BRANDING_KINDS: Readonly<Record<string, string>> = { logo: 'logo_asset_id', letterhead_header: 'letterhead_header_asset_id', letterhead_footer: 'letterhead_footer_asset_id' };
// Platform-only columns -> 403 on the tenant path; system / std / unknown columns -> 400 (mass assignment).
export const PLATFORM_ONLY: ReadonlySet<string> = new Set(['ird_pan', 'ird_annex_1_record_id']);
export const BOOLS: ReadonlySet<string> = new Set(['release_requires_payment', 'partial_release_allowed', 'whatsapp_enabled', 'sms_enabled', 'email_enabled', 'auto_verification_enabled', 'cbms_realtime_required']);
export const PATTERNS: ReadonlySet<string> = new Set(['patient_code_pattern', 'registration_no_pattern', 'barcode_pattern', 'invoice_no_pattern', 'credit_note_no_pattern', 'receipt_no_pattern', 'accession_no_pattern']);
export const PATTERN_MAX = 40;   // DB tenant_settings__patterns_len__ck
export const DEFERRED = ['invoice_no_pattern', 'credit_note_no_pattern'] as const;   // AC-C3.3 / 08 A13 P-6
export const ASSET_COLUMNS: ReadonlySet<string> = new Set(Object.values(BRANDING_KINDS));
const OTHER_EDITABLE = ['calendar_display', 'timezone', 'idle_timeout_minutes', 'absolute_session_hours', 'password_min_length', 'support_access_mode', 'report_link_ttl_days',
  'letterhead_default', 'numbering_prefix', 'barcode_prefix', 'accession_prefix_histology', 'accession_prefix_cytology', 'accession_prefix_ihc', 'accession_prefix_molecular',
  'sms_sender_id', 'retention_clinical_years', 'retention_audit_years', 'retention_raw_instrument_years', 'westgard_mode', 'abbreviated_invoice_limit_paisa', 'display_name',
  'address_lines', 'phones', 'contact_email', 'website', 'receipt_footer_note', 'accent_color'];
export const EDITABLE: ReadonlySet<string> = new Set([...BOOLS, ...PATTERNS, ...ASSET_COLUMNS, ...OTHER_EDITABLE]);
export const UNSETTABLE: ReadonlySet<string> = new Set(['barcode_prefix', 'sms_sender_id', 'abbreviated_invoice_limit_paisa', 'contact_email', 'website', 'logo_asset_id', 'letterhead_header_asset_id',
  'letterhead_footer_asset_id', 'receipt_footer_note', 'accent_color']);
// TenantSettingsDto properties read from the row; pending_numbering is built separately.
const DTO_KEYS = [...EDITABLE, 'ird_pan', 'ird_annex_1_record_id', 'legal_name_snapshot'];

/** Fiscal year after the one containing `now` (Asia/Kathmandu date; FY starts Shrawan 1, 04 L16). */
export function nextFiscalYear(now: string): string {
  const bs = instantToBs(now as any);
  const y = (bs.month >= 4 ? bs.year : bs.year - 1) + 1;
  return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
}

export function toDto(r: Row) {
  const out: Row = {};
  for (const k of DTO_KEYS) if (r[k] !== null && r[k] !== undefined) out[k] = r[k];
  if (r['pending_effective_fy_bs']) {
    out['pending_numbering'] = {
      ...(r['pending_invoice_no_pattern'] ? { invoice_no_pattern: r['pending_invoice_no_pattern'] } : {}),
      ...(r['pending_credit_note_no_pattern'] ? { credit_note_no_pattern: r['pending_credit_note_no_pattern'] } : {}),
      effective_fy_bs: r['pending_effective_fy_bs'],
    };
  }
  out['version'] = r['version'];
  return out;
}
