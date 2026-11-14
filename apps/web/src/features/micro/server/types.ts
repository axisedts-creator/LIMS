// C10 web DTOs (contracts/openapi/micro.yaml schemas, only the fields the T-24 screens read) and shared BFF types.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** [CONV] same shape as the catalog import keys: generated ones are UUIDs. */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const MICRO_CODE_RE = /^[a-z0-9_]{2,64}$/;

export interface FieldError { path?: string; code?: string; message: string }
/** ApiError cannot cross the server-action boundary, so the problem code travels as data. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; errors?: FieldError[] };
export interface Page<T> { data: T[]; page: { next_cursor?: string; limit: number } }

export const STANDARDS = ['CLSI', 'EUCAST', 'ECOFF'] as const;
export type Standard = (typeof STANDARDS)[number];
export const BREAKPOINT_STATUSES = ['uploaded', 'validating', 'validated', 'invalid', 'active', 'retired', 'discarded'] as const;
export type BreakpointStatus = (typeof BREAKPOINT_STATUSES)[number];

export interface BreakpointSetDto {
  id: string; version: number; standard: Standard; standard_version: string; title: string; licence_attestation_text: string;
  status: BreakpointStatus; file_sha256: string; file_bytes: number; row_count: number; band_count: number; error_count: number; warning_count: number;
  intended_effective_from?: string; effective_from?: string; effective_to?: string; imported_by_display: string; created_at: string;
  activated_by_display?: string; activated_at?: string; retired_at?: string;
}
export interface BreakpointImportIssueDto { line_no?: number; severity: 'error' | 'warning'; code: string; field?: string; message: string }
export interface BreakpointBandDto { id: string; band_no: number; category_code: string; lower_value?: string; lower_inclusive: boolean; upper_value?: string; upper_inclusive: boolean; note?: string }
export interface BreakpointRowDto {
  id: string; line_no: number; organism_scope: string; organism_code?: string; organism_group_code?: string; antibiotic_code: string; method: string;
  specimen_site_code?: string; qualifier_code?: string; bands: BreakpointBandDto[];
}
export interface BreakpointImportInput { standard: string; standard_version: string; title: string; licence_attestation_text: string; intended_effective_from?: string }

export interface MicroSettingsDto {
  id: string; version: number; manual_ast_standard?: 'CLSI' | 'EUCAST'; zone_suggestion_enabled: boolean; mic_suggestion_enabled: boolean;
  default_final_no_growth_hours: number; early_final_requires_reason: boolean; recent_window_days: number; is_active?: boolean;
}
export interface MicroSettingsInput {
  manual_ast_standard?: 'CLSI' | 'EUCAST'; zone_suggestion_enabled: boolean; mic_suggestion_enabled: boolean; default_final_no_growth_hours: number;
  early_final_requires_reason: boolean; recent_window_days: number; unset?: ['manual_ast_standard'];
}

export const CODED_SETS = ['organisms', 'organism_groups', 'antibiotics', 'media', 'specimen_sites', 'growth_codes', 'culture_outcomes', 'isolate_withdraw_reasons', 'culture_cancel_reasons', 'record_ignore_reasons', 'ast_interpretations'] as const;
export type CodedSetName = (typeof CODED_SETS)[number];
export interface MicroCodeDto {
  code: string; display: string; sort_order: number; is_active: boolean; source: 'global' | 'tenant'; standard?: string;
  organism_group_code?: string; gram_class?: string; is_alert?: boolean; snomed_ct_concept_id?: string; antibiotic_class?: string;
  indicates_growth?: boolean; result_flag?: 'N' | 'A'; requires_isolate?: boolean;
}
export interface MicroCodeInput {
  display: string; sort_order: number; is_active: boolean; organism_group_code?: string; gram_class?: string; is_alert?: boolean; snomed_ct_concept_id?: string;
  antibiotic_class?: string; indicates_growth?: boolean; result_flag?: 'N' | 'A'; requires_isolate?: boolean;
}

export interface PlatingProtocolDto {
  id: string; version?: number; code: string; version_no: number; display: string; read_schedule_hours: number[]; final_no_growth_hours: number;
  requires_gram_stain: boolean; default_specimen_site_code?: string; is_active: boolean; media?: { media_code: string; incubation_text?: string }[];
  applies_to?: { test_id?: string; specimen_type_code?: string }[];
}
export interface PlatingProtocolInput {
  code?: string; display: string; read_schedule_hours: number[]; final_no_growth_hours: number; requires_gram_stain: boolean; default_specimen_site_code?: string;
  media: { media_code: string; incubation_text?: string }[]; applies_to: { test_id?: string; specimen_type_code?: string }[];
}
export type AstMethod = 'mic' | 'zone_diameter' | 'other';
export interface AstPanelDto {
  id: string; version?: number; code: string; version_no: number; display: string; organism_code?: string; organism_group_code?: string; specimen_site_code?: string;
  default_method: AstMethod; is_active: boolean; antibiotic_count?: number; antibiotics?: { antibiotic_code: string; method?: AstMethod; is_reported_default: boolean }[];
}
export interface AstPanelInput {
  code?: string; display: string; organism_code?: string; organism_group_code?: string; specimen_site_code?: string; default_method: AstMethod;
  antibiotics: { antibiotic_code: string; method?: AstMethod; is_reported_default: boolean }[];
}
export interface VocabMapDto { id: string; version?: number; instrument_id: string; kind: 'organism' | 'antibiotic'; code_raw: string; local_code: string; is_active: boolean }
export interface VocabMapInput { instrument_id: string; kind: 'organism' | 'antibiotic'; code_raw: string; local_code: string }
export interface InstrumentAstDefaultDto { instrument_id: string; standard: Standard; standard_version: string; version?: number }
export interface InstrumentLite { id: string; code: string; name: string }
export interface TestLite { id: string; code: string; name: string }

// ---- T-19 worklist (CultureSummaryDto in micro.yaml; SpecimenDto in lab.yaml; centre in identity.yaml) — only the fields the screen reads.
export const TAB_IDS = ['setup', 'incubating', 'workup', 'amending', 'recent'] as const;
export type TabId = (typeof TAB_IDS)[number];
export interface CultureSummaryDto {
  id: string; version: number; status: string; specimen_id: string; centre_id: string; test_code: string; test_name: string; specimen_type_code: string; specimen_site_code?: string;
  received_at: string; next_read_due_at?: string; is_read_overdue: boolean; current_report_version_no: number; last_report_phase?: 'preliminary' | 'final';
  open_instrument_record_count: number; barcode?: string;
}
export interface CulturePage { data: CultureSummaryDto[]; page: { next_cursor?: string; limit: number; total?: number } }
export interface CentreLite { centre_id: string; name: string }
export interface SpecimenLite { registration_no?: string; barcode?: string }
/** Scan outcome. `none` covers unknown barcode, no culture and a refused lookup alike (07-SECURITY S-02: no existence oracle). */
export type ScanResult =
  | { kind: 'open'; cultureId: string }
  | { kind: 'choose'; cultures: { id: string; test_code: string; test_name: string; status: string }[] }
  | { kind: 'none' }
  | { kind: 'error' };

// ---- T-20 culture page (CultureDetailDto and children in micro.yaml; getPatient maps frontdesk.yaml PatientDto) — only the fields the screen reads.
export interface PatientLite { name: string; age_display?: string; sex?: string }
export const OBSERVATION_KINDS = ['plate_read', 'gram_stain', 'microscopy', 'other'] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];
export interface ProtocolLite { id?: string; code: string; version_no: number; display: string }
export interface PlateDto {
  id: string; version: number; plate_no: number; media_code: string; incubation_text?: string; parent_plate_id?: string; source_isolate_id?: string;
  planted_at: string; status: 'active' | 'discarded';
}
export interface ObservationDto {
  id: string; kind: ObservationKind; plate_id?: string; growth_code?: string; quantity_text?: string; finding_text?: string; observed_at: string; hours_since_planting?: number;
  recorded_by_display: string; corrects_observation_id?: string; is_corrected: boolean;
}
export interface IsolateDto {
  id: string; version: number; isolate_seq: number; status: 'pending_id' | 'identified' | 'withdrawn'; organism_code?: string; organism_display?: string; organism_source?: string;
  identified_at?: string; colony_description?: string; quantity_text?: string; plate_id?: string; is_reportable: boolean; withdraw_reason_code?: string;
}
export interface CultureDetailDto {
  id: string; version: number; status: string; order_id: string; specimen_id: string; patient_id: string; centre_id: string; test_id: string; test_code: string; test_name: string;
  specimen_type_code: string; specimen_site_code?: string; received_at: string; planted_at?: string; next_read_due_at?: string; final_due_at?: string; is_read_overdue: boolean;
  current_report_version_no: number; chain_cancelled: boolean; open_instrument_record_count: number; barcode?: string; suggested_protocol?: ProtocolLite;
  protocol?: ProtocolLite & { read_schedule_hours: number[]; final_no_growth_hours: number; requires_gram_stain: boolean };
  plates: PlateDto[]; observations: ObservationDto[]; isolates: IsolateDto[]; amendment_reason_text?: string;
  lab_result?: { result_id: string; status: string; version_no: number }; permissions_hint: { can_amend_approved: boolean };
}
export interface SetupInput { plating_protocol_id?: string; specimen_site_code?: string; planted_at: string; plates: { media_code: string; incubation_text?: string }[] }
export interface PlateInput { media_code: string; incubation_text?: string; parent_plate_id?: string; source_isolate_id?: string; planted_at?: string }
export interface ObservationInput {
  kind: ObservationKind; plate_id?: string; growth_code?: string; quantity_text?: string; finding_text?: string; observed_at: string; corrects_observation_id?: string;
}
export interface IsolateInput { plate_id?: string; colony_description?: string; quantity_text?: string; organism_code?: string }
export interface IsolateDescribeInput { colony_description?: string; quantity_text?: string; is_reportable: boolean; plate_id?: string }
