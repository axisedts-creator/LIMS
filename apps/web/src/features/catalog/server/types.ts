// DTOs mirrored from contracts/openapi/catalog.yaml (Department, SpecimenType, Container, Method, Unit, ValueSet, CatalogHealthReport).
// [CONV] hand-mirrored: apps/web has no generated client yet. Type-only + pure validators: safe in client components.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const CODE_RE = /^[A-Z0-9][A-Z0-9_]{0,31}$/; // 04-UI-UX §4 SCR-02
export const UNIT_CODE_RE = /^[A-Za-z0-9_]{1,32}$/; // SCR-05
export const VALUE_SET_CODE_RE = /^[A-Z0-9_]{1,32}$/;
export const VALUE_CODE_RE = /^[A-Z0-9_+-]{1,16}$/;

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

/** Server-action result: ApiError cannot cross the action boundary (Next strips messages), so the code travels as data. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };
