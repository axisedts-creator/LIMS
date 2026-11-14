// DTOs for the staff partner screens (contracts/openapi/partners.yaml: PartnerAdminSummary, PartnerAdmin, PartnerUser, InboundManifest*, ManifestLine,
// PickupRequestAdmin, ReferrerMapping, PartnerSettings). Only the fields the screens read.
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; title?: string; errors?: { path: string; code: string }[] };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface Page<T> { data: T[]; page: { limit: number; next_cursor?: string } }
export interface Option { code: string; display: string; isActive: boolean }

export interface PartnerSummary {
  id: string; partner_code: string; name: string; status: string;
  credit_party: { id: string; party_code: string; name: string };
  receiving_centre: { id: string; code: string; name: string };
  active_users: number; open_manifests: number;
}
export interface Partner extends PartnerSummary {
  receiving_branch_id: string; conversion_mode: string; contact_email?: string; contact_phone_e164?: string; address_text?: string;
  created_at: string; version: number; suspend_reason_code?: string;
  projection_status?: { price_list_synced_at?: string; statements_synced_at?: string };
}
export interface PartnerUser {
  id: string; display_name: string; email_masked: string; partner_role: 'partner_admin' | 'partner_member'; status: string; mfa_enrolled: boolean; last_login_at?: string; version: number;
}

export interface ManifestLine {
  id: string; line_no: number; state: string; partner_sample_ref?: string;
  patient: { full_name: string; sex: string; age_years?: number };
  orderables: { orderable_id: string; kind: string; code: string; name: string }[];
  priority: string; collected_at?: string; clinical_note?: string;
  referrer?: { id: string; display_name: string };
  order?: { order_id: string; registration_no: string };
  failure?: { code: string; message_key: string };
  not_received_reason_code?: string; version: number;
}
export interface ManifestSummary {
  id: string; manifest_no: string; state: string; line_count: number; lines_converted: number; lines_failed: number;
  receiving_centre: { id: string; name: string }; submitted_at?: string; pickup_request_id?: string; version: number;
  partner: { id: string; partner_code: string; name: string };
}
export interface Manifest extends ManifestSummary {
  notes?: string; collected_on?: string; lines: ManifestLine[];
  partner: ManifestSummary['partner'] & { status?: string };
}
export interface Pickup {
  id: string; state: string; window_start: string; window_end: string; packages_count: number; contact_name?: string; contact_phone_e164?: string;
  scheduled_start?: string; scheduled_end?: string; assignee_text?: string; version: number;
  manifests: { id: string; manifest_no: string }[];
  partner: { id: string; partner_code: string; name: string; address_text?: string; contact_phone_e164?: string };
}
export interface Referrer {
  id: string; display_name: string; qualification?: string; registration_council?: string; registration_no?: string; mapping_state: string; samples_this_month: number; version: number;
  catalog_doctor?: { id: string; display_name: string }; partner: { id: string; name: string; partner_code?: string };
}
export interface Settings {
  default_conversion_mode: 'on_receipt' | 'on_submit'; include_default_price_list: boolean; require_mapped_referrer: boolean; access_slip_enabled: boolean;
  max_lines_per_manifest: number; draft_ttl_days: number; pickup_max_days_ahead: number; report_download_daily_cap_per_user: number; consent_text_version: string; consent_statement: string;
}
export interface PatientHit { id: string; patient_code: string; full_name: string; sex: string; age_display: string; phone_masked?: string }
export interface DoctorHit { id: string; display_name: string }
export interface CreditPartyHit { id: string; party_code: string; name: string }
export interface Branch { id: string; name: string }
export interface Centre { id: string; name: string; branch_id?: string }
