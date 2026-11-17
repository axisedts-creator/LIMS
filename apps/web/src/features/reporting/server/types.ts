// DTOs mirrored from contracts/openapi/reporting.yaml. [CONV] hand-mirrored (apps/web has no generated client yet; same as features/billing).
// Type-only + constants: safe to import from client components (no server-only, no secrets).
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface Page<T> { data: T[]; page: { limit: number; next_cursor?: string } }
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; extra?: Record<string, unknown> };
export interface Centre { id: string; name: string }
export interface CodedOption { code: string; display: string; sort_order?: number }

export type ReportTab = 'awaiting_content' | 'ready_to_release' | 'held' | 'render_failed' | 'released_today' | 'all';
export const REPORT_TABS: readonly ReportTab[] = ['awaiting_content', 'ready_to_release', 'held', 'render_failed', 'released_today', 'all'];

export interface ReportSummary {
  id: string; order_id: string; family: 'laboratory' | 'narrative'; centre_id: string; state: string; display_status: string; held_basis?: string; balance_due_paisa?: number;
  registration_no: string; patient_display_name: string; centre_code?: string; referrer_name?: string; items_total: number; items_ready: number;
  latest_version_no?: number; latest_report_kind?: string;
  /** [CONV] NOT in ReportSummary today (CR .orchestra/cr/C6-T31.md): bulk release needs report-version ids; falls back to the report id until the contract adds it. */
  registered_at: string; updated_at: string; review_flag?: string; version: number;
}
export interface VersionSummary {
  id: string; version_no: number; status: string; report_kind?: string; completeness?: string; page_count?: number; pdf_bytes?: number; rendered_at?: string;
  released_at?: string; release_basis?: string; last_render_error_code?: string; version: number;
}
export interface ReportItem {
  order_item_id: string; test_names: string[]; item_kind: string; requires_lab: boolean; requires_narrative: boolean; requires_outsourced: boolean;
  lab_ready: boolean; narrative_ready: boolean; outsourced_ready: boolean; item_status: string; narrative_report_id?: string;
}
export interface ReportDetail extends ReportSummary {
  age_display?: string; sex?: string; items: ReportItem[]; versions: VersionSummary[];
  deliveries_summary: Record<'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'suppressed', number>; audiences?: string[]; computed_audiences?: string[];
}
export interface CriticalAlert {
  critical_event_id: string; report_id?: string; order_id?: string; registration_no?: string; centre_id?: string; alerted_at: string;
  recipients: { recipient_kind: string; status: string }[];
}
export interface Delivery {
  id: string; channel: string; purpose: string; recipient_kind: string; status: string; attempt_no: number; destination_masked?: string; report_id?: string;
  report_version_no?: number; failure_code?: string; queued_at?: string; failed_at?: string;
  attempts?: { attempt_no: number; started_at: string; outcome: string; error_code?: string }[];
}
export interface OutsourcedItem { order_item_id: string; report_id?: string; registration_no: string; patient_display_name?: string; test_names: string[]; external_lab_name?: string; registered_at: string; latest_file_state?: string; centre_id?: string; file?: InputFile }
export interface InputFile {
  id: string; kind: string; order_item_id: string; state: string; original_filename?: string; size_bytes?: number; page_count?: number; external_lab_name?: string;
  last_error_code?: string; confirmed_at?: string; confirmed_by_name?: string; version: number;
}
export interface NarrativeSection { key: string; heading: string; html: string }
export interface Narrative {
  id: string; order_item_id: string; test_id?: string; test_name: string; template_kind: string; status: string; patient_display_name?: string; registration_no?: string;
  current_version: { version_no: number; status: string; template_id?: string; sections: NarrativeSection[]; images: { image_id: string; caption?: string }[]; signed_at?: string; signed_by?: string };
  history?: { version_no: number; status: string }[]; version: number;
}
export interface NarrativeTemplate { id: string; code: string; name: string; kind: string; sections: { key: string; heading: string; required: boolean; default_html?: string }[]; is_active: boolean; version: number }
export interface ReportTemplateRow { id: string; family: string; name: string; current_version_no?: number; draft_version_no?: number; is_active: boolean; version: number }
export interface TemplateConfig {
  page: { size: string; margin_mm: { top: number; bottom: number; left: number; right: number } };
  letterhead: { header_asset: string; footer_asset: string; plain_reserve_top_mm: number; plain_reserve_bottom_mm: number };
  header_fields: string[];
  results: { show_method_line: boolean; show_units_column: boolean; group_by_package: boolean; page_break_before_department: boolean; show_department_approved_by: boolean };
  signatories: { mode: string; max: number; show_signature_images: boolean; label_registration: string };
  qr: { enabled: boolean; size_mm: number; caption: string };
  watermark: { text: string; opacity: number };
  disclaimers: string[]; fonts: { base_pt: number }; narrative?: Record<string, unknown>; contact_strip_extra?: string;
}
export interface TemplateDetail extends ReportTemplateRow { versions: { version_no: number; status: string; published_at?: string }[]; draft: { config: TemplateConfig; version: number } }
export interface MessageText {
  channel: string; language: string; body_text: string; subject_text?: string; provider_template_name?: string; provider_template_language?: string;
  provider_variable_order?: string[]; approval_status: string; is_active: boolean; version: number;
}
export interface MessageTemplate { code: string; purpose: string; channels: string[]; params: { name: string; kind: string; max_length?: number }[]; texts: MessageText[] }
export interface ChannelAccount { id: string; channel: string; provider_kind: string; sender_id?: string; secret_ref: string; callback_url_configured?: boolean; is_active: boolean; version: number }
export interface ReportingSettings {
  auto_release: string; narrative_report_mode: string; patient_mobile_channel_order: string[]; patient_email_enabled: boolean; referrer_delivery_enabled: boolean;
  referrer_channels: string[]; centre_delivery_enabled: boolean; whatsapp_fallback_minutes: number; critical_alert_referrer_enabled: boolean; bulk_release_max: number;
  print_critical_label: boolean; link_reissue_max_per_day: number; dues_link_enabled: boolean; portal_payment_gateways: string[]; version: number;
}
export interface CentreContact { id: string; centre_id: string; channel: string; address_masked: string; label?: string; is_active: boolean; version: number }
export interface BulkResult { results: { id: string; outcome: string; release_basis?: string }[] }
