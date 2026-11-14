// Plain-JSON shapes the dispatch board needs (02-TRD §5.1 VisitSummaryDto / RouteDto, H12 rows, H20 coded values).
// Rebuilt from an allow-list in server/read.server.ts, so nothing else the API sends reaches a client component.
export interface PersonRef { membership_id: string; display_name: string }
export interface SpecimensSummary { expected: number; collected: number; held: number; received: number; rejected: number }
/** Optional stored address; only present when the caller (visit page, HC-T19) has the detail DTO. */
export interface VisitAddress { address_text?: string; landmark?: string; latitude?: string; longitude?: string }

export interface VisitDto {
  id: string;
  version: number;
  kind: string;
  status: string;
  centre_id: string;
  patient_display_name: string;
  open_flag_kinds: string[];
  specimens_summary: SpecimensSummary;
  window_start?: string;
  window_end?: string;
  area_hint?: string;
  route_id?: string;
  route_date?: string;
  route_sequence?: number;
  phlebotomist?: PersonRef;
  order_id?: string;
  address?: VisitAddress;
  note_for_phlebotomist?: string;
}

export interface RouteDto {
  id: string;
  version: number;
  centre_id: string;
  route_date: string;
  phlebotomist: PersonRef;
  visit_ids_in_order: string[];
  active_visits: number;
  completed_visits: number;
  last_ack_at?: string;
}

/** H5 body as the browser sends it to the server action (re-validated in write.server.ts). */
export interface ScheduleBody {
  window_start: string;
  window_end: string;
  address: { address_text: string; landmark?: string; latitude?: string; longitude?: string };
  note_for_phlebotomist?: string;
  unset?: readonly string[];
}
export interface PhlebotomistOption { membership_id: string; display_name: string; active_visits: number; route_full: boolean }
export interface CodedValue { code: string; display: string; requires_text: boolean; is_active: boolean }
export interface BoardCodes { visit_cancel_reasons: readonly CodedValue[]; unassign_reasons: readonly CodedValue[] }
export interface Centre { id: string; name: string }

// ---- HC-T20: handovers (H13/H14), devices (H16), settings (H18/H19). Rebuilt from allow-lists in server/read.server.ts. ----
/** H13 row. No visit id and no membership id: the receiving centre sees tubes only (08 A19 D-125). */
export interface HandoverSummary {
  id: string;
  version: number;
  status: string;
  from: { display_name: string };
  to_centre_id: string;
  handed_over_at: string;
  item_count: number;
  received_count?: number;
}
export interface HandoverItem { specimen_id: string; barcode: string; specimen_type_code: string; outcome?: string }
/** H14: the summary plus the items and, once handled, who received it and when. */
export interface HandoverDetail extends HandoverSummary { items: HandoverItem[]; received_by_display?: string; received_at?: string }

/** H16 row. No hardware id, token or sequence number. */
export interface DeviceRow {
  id: string;
  version: number;
  /** DeviceDto (02-TRD:220); links the wipe dialog to staff.admin.user. '' when absent/invalid. */
  membership_id: string;
  display_name: string;
  platform: string;
  model: string;
  app_version: string;
  status: string;
  last_seen_at?: string;
  last_push_at?: string;
  last_snapshot_at?: string;
}
export interface PaymentMethod { code: string; display: string; requires_reference: boolean }
/** H18 / H19 `SettingsDto` (02-TRD §11.2) + `version`. */
export interface SettingsDto {
  version: number;
  min_app_version: string;
  sync_interval_seconds: number;
  offline_purge_hours: number;
  capture_gps: boolean;
  gps_retention_days: number;
  map_handoff_enabled: boolean;
  manual_barcode_entry_allowed: boolean;
  second_identifier: string;
  collection_consent_text_version: string;
  collection_consent_text: string;
  payment_methods: PaymentMethod[];
  handover_confirmation_required: boolean;
  handover_overdue_hours: number;
  max_visits_per_route: number;
  notify_phlebotomist_on_assign: boolean;
  notify_patient_on_assign: boolean;
  clock_tolerance_seconds: number;
}
export type SettingsBody = Omit<SettingsDto, 'version'>;
export interface WipeCodes { wipe_reasons: readonly CodedValue[] }
export interface BoardFilter { status: readonly string[]; kind?: string; has_open_flags?: boolean }
