// DTOs mirrored from the C3 TRD §8 (routes #23–#51) and contracts/openapi/catalog.yaml (Department, SpecimenType, Container, Method, Unit, ValueSet, CatalogHealthReport).
// [CONV] hand-mirrored: apps/web has no generated client yet — replace when it lands.
// Type-only + pure helpers: safe to import from client components (no server-only, no secrets).
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const CODE_RE = /^[A-Z0-9][A-Z0-9_]{0,31}$/; // 04-UI-UX §4 SCR-02
export const UNIT_CODE_RE = /^[A-Za-z0-9_]{1,32}$/; // SCR-05
export const VALUE_SET_CODE_RE = /^[A-Z0-9_]{1,32}$/;
export const VALUE_CODE_RE = /^[A-Z0-9_+-]{1,16}$/;
export const SEXES = ['male', 'female', 'other', 'unknown'] as const;
export type Sex = (typeof SEXES)[number];
export type RangeKind = 'ranges' | 'critical';
export type ResultType = 'numeric' | 'ordinal' | 'coded' | 'text' | 'narrative';

export interface FieldError { path?: string; code?: string; message: string }
/** Server-action result: ApiError cannot cross the action boundary (Next strips messages), so the code travels as data. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; errors?: FieldError[] };

export interface TestDto {
  id: string; code: string; name: string; department_id: string; workflow_type: string;
  report_order: number; is_orderable: boolean; is_active: boolean; version: number;
}
export interface AnalyteRow {
  id: string; code: string; name: string; print_name?: string | undefined; report_subheading?: string | undefined; sort_order: number;
  result_type: string; unit_code?: string | undefined; decimals?: number | undefined; method_name?: string | undefined; formula_expression?: string | undefined;
  range_set_version?: number | null | undefined; current_version_no?: number | undefined; has_draft?: boolean | undefined; is_active?: boolean | undefined; version: number;
}
export interface AnalyteVersion {
  id: string; analyte_id?: string; version_no: number; status: 'draft' | 'published' | 'superseded' | 'discarded';
  result_type: string; unit_code?: string; decimals?: number; method_id?: string; value_set_code?: string;
  formula_expression?: string; effective_from?: string; effective_to?: string; change_reason?: string; version: number;
}
export interface Age { value: number; unit: string }
export interface Band {
  sex?: string; age_low?: Age | undefined; age_high?: Age | undefined; specimen_type_id?: string; kind?: string;
  low?: string | undefined; high?: string | undefined; normal_codes?: string[]; display_text?: string | undefined;
  critical_low?: string; critical_high?: string; abnormal_codes?: string[]; sort_order?: number;
}
export interface RangeSet {
  id: string; analyte_id?: string; version_no: number; status: 'draft' | 'published' | 'superseded' | 'discarded' | 'retired' | string;
  unit_code?: string; bands: Band[]; version: number;
}
export interface FormulaValidation {
  valid: boolean; input_analyte_codes: string[]; dependency_order: string[]; chain_depth: number;
  sample_result?: string; sample_not_computable_reason?: string; errors: FieldError[];
}
export interface PreviewResult {
  reference_range?: { reference_range_id?: string; version?: number; low?: string; high?: string; unit_code?: string; kind?: string; text?: string; normal_codes?: string[] };
  critical_limits?: { critical_limit_id?: string; version?: number; low?: string; high?: string; unit_code?: string };
  no_reference_range: boolean;
}
export interface PublishBody { effective_from?: string; change_reason: string; reference_range_set_id?: string; critical_limit_set_id?: string; allow_without_ranges?: boolean }
export interface PreviewInput { analyte_id: string; sex: Sex; age_days: number; birth_on?: string; specimen_type_code?: string; at?: string }
export interface FormulaInput { analyte_id?: string; expression: string; sample_inputs?: Record<string, string>; sample_context?: { age_days: number; sex: string } }

/** Days per age unit for client-side ordering checks only (the API owns the real calendar arithmetic). */
export const AGE_UNITS: Readonly<Record<string, number>> = { day: 1, week: 7, month: 30, year: 365 };

export interface Base { id: string; is_active: boolean; version: number; created_at: string; updated_at: string }
export interface Department extends Base { code: string; name: string; report_order: number; report_heading?: string }
export interface SpecimenType extends Base { code: string; name: string; report_label: string }
export interface Container extends Base { code: string; name: string; additive?: string; cap_colour_display?: string; default_specimen_type_id?: string }
export interface Method extends Base { code: string; name: string }
export interface Unit extends Base { code: string; display: string; scope: 'global' | 'tenant' }
export interface ValueSetValue { code: string; display: string; sort_order: number; is_active?: boolean }
export interface ValueSet extends Base { code: string; display: string; is_ordered: boolean; scope: 'global' | 'tenant'; values: ValueSetValue[] }

export interface CatalogHealthReport {
  active_orderables_without_default_price: string[];
  analytes_without_reference_range: string[];
  tests_without_specimen_type: string[];
  tests_missing_required_analyte: string[];
  tax_default_configured: boolean;
  unmapped_formula_inputs: string[];
  truncated: boolean;
}
export interface CatalogCounts { departments: number; tests: number; panels: number; doctors: number; doctors_unverified: number; price_lists: number }

export interface PageInfo { limit: number; next_cursor?: string; prev_cursor?: string }
export interface Page<T> { data: T[]; page: PageInfo }
export interface ListQuery { isActive?: boolean | 'all'; limit?: number; cursor?: string }
export interface UnitsQuery { scope?: 'global' | 'tenant'; isActive?: boolean | 'all' }

export interface DepartmentInput { code: string; name: string; report_order: number; report_heading?: string; is_active?: boolean }
export interface SpecimenTypeInput { code: string; name: string; report_label: string; is_active?: boolean }
export interface ContainerInput { code: string; name: string; additive?: string; cap_colour_display?: string; default_specimen_type_id?: string; is_active?: boolean }
export interface MethodInput { code: string; name: string; is_active?: boolean }
export interface UnitInput { code: string; display: string }
export interface ValueSetInput { code: string; display: string; is_ordered: boolean; values?: { code: string; display: string; sort_order?: number; is_active?: boolean }[] }
