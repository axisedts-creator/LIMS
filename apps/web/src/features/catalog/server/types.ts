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

export const PANEL_CODE_RE = /^[A-Z0-9][A-Z0-9_\-+.]{0,31}$/; // SCR-09
export const COMMENT_CODE_RE = /^[A-Z0-9_]{1,16}$/; // SCR-10
export const PARTY_CODE_RE = /^[A-Z0-9_\-]{1,20}$/; // SCR-11 doctor code, SCR-12 party code
export const PHONE_RE = /^\+[1-9][0-9]{7,14}$/; // E.164 (08 A13 P-11)
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // [CONV] pragmatic; the API validates `format: email`

/** Client-side field checks (the BFF validates again). Empty = fine (optional fields). */
export const phoneError = (v: string) => (v && !PHONE_RE.test(v) ? 'Use international format, for example +9779801234567.' : undefined);
export const emailError = (v: string) => (v && (v.length > 254 || !EMAIL_RE.test(v)) ? 'Enter a valid email address.' : undefined);

export interface Base { id: string; is_active: boolean; version: number; created_at: string; updated_at: string }
export interface Department extends Base { code: string; name: string; report_order: number; report_heading?: string }
export interface SpecimenType extends Base { code: string; name: string; report_label: string }
export interface Container extends Base { code: string; name: string; additive?: string; cap_colour_display?: string; default_specimen_type_id?: string }
export interface Method extends Base { code: string; name: string }
export interface Unit extends Base { code: string; display: string; scope: 'global' | 'tenant' }
export interface ValueSetValue { code: string; display: string; sort_order: number; is_active?: boolean }
export interface ValueSet extends Base { code: string; display: string; is_ordered: boolean; scope: 'global' | 'tenant'; values: ValueSetValue[] }

export interface PanelMember { kind: 'test' | 'panel'; orderable_id: string; sort_order: number }
export interface Panel extends Base { kind: 'test' | 'panel'; code: string; name: string; department_id?: string; department_code?: string; panel_kind: 'clinical' | 'package'; sex_restriction?: 'male' | 'female'; is_orderable: boolean; revision: number; members: PanelMember[] }
export interface OrderableSummary { id: string; kind: 'test' | 'panel'; code: string; name: string; panel_kind?: 'clinical' | 'package'; is_orderable: boolean; is_active: boolean; revision: number }
export interface ResolvedOrderables {
  orderables: { orderable_id: string; kind: 'test' | 'panel'; test_ids: string[] }[];
  tests: { id: string; code: string; name: string; is_active?: boolean }[];
  specimen_requirements: { specimen_type_code: string; container_code?: string; test_ids: string[] }[];
  catalog_revision: number;
}
export interface CommentCode extends Base { code: string; department_id?: string; text: string }
export interface DoctorSummary { id: string; doctor_code: string; display_name: string; qualification?: string; is_verified: boolean; is_active: boolean; canonical_doctor_id?: string }
export interface Doctor extends Base {
  doctor_code: string; display_name: string; qualification?: string; registration_council?: string; registration_no?: string;
  phone_e164?: string; email?: string; notes?: string; is_verified: boolean; source: 'back_office' | 'quick_add' | 'import'; merged_into_id?: string; price_list_id?: string;
}
export type DoctorCreated = Doctor & { possible_duplicate_of: DoctorSummary[] };
export type PartyKind = 'hospital' | 'company' | 'clinic' | 'partner_lab' | 'insurer' | 'other';
export interface CreditParty extends Base {
  party_code: string; name: string; kind: PartyKind; allows_credit: boolean; pan?: string; contact_phone_e164?: string; contact_email?: string; billing_address?: string; price_list_id?: string;
}

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

// ---- SCR-18 / SCR-19 (T-35): contracts/openapi/catalog.yaml Import, ImportIssue, Export (#96–#107). [CONV] hand-mirrored.
export const IMPORT_KINDS = ['price_list', 'catalog_master', 'referrers', 'credit_parties'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export const EXPORT_KINDS = ['price_list', 'catalog_master', 'referrers'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export const IMPORT_STATUSES = ['uploaded', 'scanning', 'validating', 'validated', 'invalid', 'quarantined', 'committing', 'committed', 'commit_failed', 'discarded', 'expired', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
export const EXPORT_STATUSES = ['queued', 'building', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];
export interface ImportSummary { rows: number; added: number; changed: number; removed: number; unchanged: number; errors: number; warnings: number }
export interface Import {
  id: string; kind: ImportKind; target_price_list_id?: string | undefined; base_version_no?: number | undefined; status: ImportStatus; file_name: string; file_sha256: string;
  summary: ImportSummary; deduplicated?: boolean; result_price_list_version_id?: string | undefined; expires_at: string; created_at: string; created_by: string; version: number;
}
export interface ImportIssue { seq: number; severity: 'error' | 'warning'; sheet: string; row_no?: number | undefined; column?: string | undefined; issue_code: string; message: string }
export interface ExportRow { id: string; kind: ExportKind; status: ExportStatus; file_name?: string | undefined; byte_size?: number | undefined; expires_at?: string | undefined; version: number }
export interface PriceListLite { id: string; code: string; name: string; current_version?: { id: string; version_no: number } | null | undefined }
export interface ImportCommitBody { effective_from?: string; change_reason: string; accept_stale_base?: boolean; publish?: boolean; replace_draft?: boolean }
// ---- Pricing (SCR-13…17; contracts/openapi/catalog.yaml PriceList…TaxRule, identity.yaml Centre) ----
export const PRICE_LIST_CODE_RE = /^[A-Z0-9][A-Z0-9_\-]{0,31}$/;
export const TAX_CODE_RE = /^[A-Z0-9_]{1,16}$/;
export const HS_CODE_RE = /^[0-9]{4,8}$/;
export const MAX_PRICE_PAISA = 999_999_999;
/** Rows per bulk-upsert / bulk-remove request (REQ-SEC-100). */
export const BULK_MAX = 200;
export const TAX_DISCLAIMER = 'Tax treatment of lab services is pending confirmation by your auditor.';

export type PriceOwnerKind = 'default' | 'credit_party' | 'referrer' | 'centre';
export interface Money { amount_paisa: number; currency: 'NPR' }
export interface PriceListVersionRef { id: string; version_no: number; effective_from: string }
export interface PriceList {
  id: string; code: string; name: string; owner_kind: PriceOwnerKind; falls_through: boolean; assignments: { owner_id: string }[];
  current_version?: PriceListVersionRef; scheduled_version?: PriceListVersionRef; draft_version_id?: string; is_active: boolean; version: number;
}
export interface PriceListVersion {
  id: string; price_list_id: string; version_no: number; status: 'draft' | 'published' | 'superseded' | 'retired' | 'discarded';
  effective_from?: string; effective_to?: string; item_count: number; source_import_id?: string; change_reason?: string; version: number;
}
export interface PriceListDetail extends PriceList { versions: PriceListVersion[] }
export interface PriceItem { orderable_id: string; orderable_code?: string; orderable_kind?: 'test' | 'panel'; unit_price: Money }
export interface PriceItemResult { orderable_id: string; outcome: 'created' | 'updated' | 'unchanged' | 'error'; error_code?: string }
export interface PriceQuoteLine {
  orderable_id: string; price_list_id: string; price_list_version: number; source: 'explicit' | 'credit_party' | 'referrer' | 'centre' | 'tenant_default';
  unit_price: Money; urgent_surcharge?: Money;
  tax: { vat: 'exempt' | 'taxable'; other_tax_code?: string; vat_rate_bp?: number; other_tax_rate_bp?: number; hs_code?: string };
}
export interface PriceQuoteError { orderable_id: string; error_code: string }
export type PriceQuoteResult = PriceQuoteLine | PriceQuoteError;
export interface SurchargeRule {
  id: string; scope: 'all' | 'department' | 'orderable'; department_id?: string; orderable_id?: string; price_list_id?: string;
  amount_kind: 'flat' | 'percent'; amount?: Money; percent_bp?: number; effective_from: string; effective_to?: string; version: number;
}
export interface TaxType { id: string; code: string; display: string; rate_bp?: number; effective_from: string; effective_to?: string; scope: 'global' | 'tenant'; is_active: boolean; version: number }
export interface TaxRule {
  id: string; scope: 'tenant_default' | 'department' | 'orderable'; department_id?: string; orderable_id?: string; vat_treatment: 'exempt' | 'taxable';
  other_tax_code?: string; hs_code?: string; effective_from: string; effective_to?: string; version: number;
}
export interface Centre { centre_id: string; code: string; name: string; branch_id: string; kind: string; is_active: boolean; version: number }
/** Orderable as the version editor shows it (catalog list rows carry department_id). */
export type PricedOrderable = OrderableSummary & { department_id?: string };

/** "1500.50" → 150050; undefined unless a plain decimal with ≤ 2 places in 0…9,999,999.99 (AC-13.8). Integer maths, no float. */
export function parseNpr(text: string): number | undefined {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : undefined;
}
export const formatNpr = (paisa: number) => `${Math.floor(paisa / 100)}.${String(paisa % 100).padStart(2, '0')}`;
/** Percent text with ≤ 2 decimals → basis points (50 → 5000, 13.5 → 1350); undefined when malformed. */
export function parsePercentBp(text: string): number | undefined {
  const m = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(text.trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : undefined;
}
