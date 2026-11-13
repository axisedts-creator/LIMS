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
