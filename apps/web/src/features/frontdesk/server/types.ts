// Wire types for the registration page (F1, F8, F9, C3 search, B3, C5 #14a). Names copied from 02-TRD §F and 03-INTERFACE-CATALOG.
// DTOs mirrored from contracts/openapi/frontdesk.yaml + billing.yaml (OrderDto, OrderSummaryDto, OrderFlag, Patient, DiscountApproval,
// PossibleDuplicate, OrderBillingDto). [CONV] hand-mirrored like features/billing/server/types.ts: apps/web has no generated client yet.
// Type-only + constants: safe to import from client components.
export interface Money { amount_paisa: number; currency: string }
export interface Page<T> { data: T[]; page?: { limit: number; next_cursor?: string } }
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; title?: string; detail?: string; errors?: { path: string; code: string }[] };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** LD-310 / T0D-REGSCREEN-1: `kind` from C2 listCentres (identity enum own|franchise|home_collection); optional for older responses. */
export interface Centre { id: string; name: string; kind?: 'own' | 'franchise' | 'home_collection' }
export interface PatientSummary { id: string; patient_code: string; full_name: string; sex: string; age_display: string; phone_masked?: string; last_visit_at?: string; is_anonymised?: boolean }
export interface OrderableSummary { id: string; kind: 'test' | 'panel'; code: string; name: string }
export interface DoctorSummary { id: string; doctor_code?: string; display_name: string; is_verified?: boolean }
/** LD-310 / T0D-REGSCREEN-1: kind drives Patient type; credit_limit_paisa / outstanding are shown only when the API returns them. */
export interface CreditPartySummary { id: string; party_code?: string; name: string; kind?: string; credit_limit_paisa?: number; outstanding?: Money }
export interface CodedSetEntry { code: string; display: string; sort_order?: number; requires_reference?: boolean }

export interface QuoteLine {
  line_ref: string; orderable_id: string; code: string; name: string; priority: string; kind: string;
  unit_price: Money; discount: Money; taxable: Money; exempt: Money; vat: Money; other_tax: Money; net: Money;
}
export interface Quote {
  lines: QuoteLine[];
  totals: { gross: Money; discount: Money; exempt: Money; taxable: Money; vat: Money; other_tax: Money; net: Money };
  discount_evaluation: { within_limit: boolean; approval_required: boolean; limit_percent_bp: number; limit_paisa: number };
  quote_fingerprint: string; base_fingerprint: string; catalog_revision?: number; fiscal_year_bs?: string;
  credit_status?: { state: 'ok' | 'locked' | 'over_limit' };
}
export interface RegistrationResult {
  order: { id: string; registration_no: string; status: string; billing_mode: string };
  invoice?: { id: string; invoice_no: string; status: string };
  ledger_entries?: { id: string }[];
  balance?: { order_id: string; net: Money; paid: Money; due: Money };
  print?: { invoice_id?: string; receipt_ledger_entry_ids: string[] };
  notifications?: { registration_sms?: string };
  label_print?: { autoprint: boolean };
}

export interface DraftDiscount { scope: 'bill' | 'line'; kind: 'amount' | 'percent'; orderable_id?: string; amount_paisa?: number; percent_bp?: number; reason_code: string; reason_text?: string }
/** LD-310 / T0D-REGSCREEN-2: NewPatient keys of contracts/openapi/frontdesk.yaml (T0C-REGPARITY-1). government_id_number is sensitive (LD-310 (b)). */
export interface NewPatientDraft {
  full_name: string; sex: string; birth_on?: string; age?: { years: number; months: number; days: number };
  phone_e164?: string; email?: string; address_text?: string;
  title?: string; external_patient_id?: string; nationality?: string; government_id_type?: string; government_id_number?: string;
  address_province?: string; address_district?: string; address_municipality?: string; address_ward?: string; address_tole?: string; address_postal_code?: string;
  profile_photo_attachment_id?: string; custom_fields?: { code: string; value: string }[];
  consents: { processing: boolean; sms: boolean; whatsapp: boolean; email: boolean; share_with_referrer: boolean; consent_text_version: string };
}
export interface DraftItem { orderable_id: string; priority: 'routine' | 'urgent'; icd_code?: string }
/** F8 RegistrationDraft (T0C-REGPARITY-2 adds coupon_code, visiting_charge_paisa, redeem_reward_points, items[].icd_code). */
export interface RegistrationDraft {
  patient: { patient_id: string } | { new_patient: NewPatientDraft };
  centre_id: string; visit_type: 'opd' | 'ipd'; billing_mode: 'cash' | 'credit'; priority: 'routine' | 'urgent'; collection_mode: string;
  credit_party_id?: string; referrer_id?: string;
  items: DraftItem[];
  discounts?: DraftDiscount[];
  coupon_code?: string; visiting_charge_paisa?: number; redeem_reward_points?: number;
}
export interface PaymentIn { method_code: string; amount_received_paisa: number; reference?: string; tendered_paisa?: number; card_holder_name?: string; payment_remark?: string }
/** LD-310 / T0D-REGSCREEN-2: the F9-only order fields (CreateRegistrationRequest). Health text (D-27a) is never in F8. */
export interface OrderFields {
  collection_at?: string; collected_by_name?: string; sample_not_collected?: boolean; sample_remark?: string;
  clinical_history?: string; patient_history?: string; mr_number?: string; external_reference?: string; insurance_code?: string; insurance_claim_amount_paisa?: number;
}
export type RegisterBody = RegistrationDraft & OrderFields & {
  quote_fingerprint: string; payments: PaymentIn[]; discount_approval_id?: string;
  /** LD-25 (2026-11-07) downtime back-entry; absent = live. */
  entry_mode?: 'downtime_backentry'; occurred_at?: string; downtime_ref?: string;
  /** LD-310 / T0D-REGSCREEN-1: F9 RegisterRequest fields (contracts/openapi/frontdesk.yaml). */
  buyer_pan?: string; trf_attachment_ids?: string[];
};
// LD-310 / T0D-REGSCREEN-2 reads (T0B-REGAPI-1/2): only the fields the registration screen uses.
export interface IcdCode { id: string; code: string; description: string; is_active: boolean }
export interface CustomFieldDefinition { id: string; field_key: string; label: string; field_type: 'text' | 'number' | 'date' | 'choice'; required: boolean; is_active: boolean; choices?: string[]; sort_order?: number }
export interface NumberPreview { centre_id: string; next_registration_no: string; next_receipt_no: string; next_receipt_no_label: string }
export interface DraftRecordSummary { id: string; centre_id: string; created_at: string; updated_at: string; expires_at: string }
export interface DraftRecord extends DraftRecordSummary { payload: string }
export interface PatientRewards { patient_id: string; balance_points: number }
export interface DiscountApprovalIn { centre_id: string; base_fingerprint: string; discounts: DraftDiscount[]; reason_code: string; reason_text?: string; patient_id?: string }
export interface InvoicePrintDoc{ print_no: number; document?: unknown }
export interface LabelReadiness { order_id: string; specimens: unknown[]; labels_route?: string }

export interface Actor { membership_id: string; display_name: string }
export interface Coded { code: string; display: string; sort_order: number }

export interface OrderItem { id: string; orderable_id: string; orderable_kind: string; code: string; name: string; priority: string; status: string; unit_price: Money; outsourced?: boolean }
export interface OrderFlag { id: string; order_id: string; kind: string; status: string; specimen_id?: string; resolution_code?: string; resolved_by?: Actor; created_at: string; version: number }
export interface TrfAttachment { id: string; mime_type: string; size_bytes: number; scan_state: string; uploaded_by?: Actor; original_filename?: string; created_at: string }
export interface Order {
  id: string; registration_no: string;
  patient: { id: string; patient_code: string; full_name: string; sex: string; age_at_order?: string };
  branch_id: string; centre_id: string; visit_type: string; billing_mode: string; priority: string; collection_mode?: string; source: string; status: string;
  items: OrderItem[]; discounts: unknown[]; trf_attachments: TrfAttachment[]; flags: OrderFlag[];
  requires_credit_note: boolean; cancel_reason_code?: string; referrer_name?: string; registered_at?: string; version: number;
}
export interface OrderSummary { id: string; registration_no: string; patient_id: string; patient_display: string; centre_id: string; status: string; billing_mode: string; source: string; registered_at: string; item_count: number; has_open_flag: boolean; version: number }

export interface Consents { processing: boolean; sms: boolean; whatsapp: boolean; email: boolean; share_with_referrer: boolean; consent_text_version: string }
export interface Patient extends PatientSummary { phone_masked: string; is_anonymised: boolean; is_birth_on_estimated?: boolean; phone_e164?: string; email?: string; address_text?: string; consents: Consents; version: number }
export interface PossibleDuplicate { patient: PatientSummary; candidates: PatientSummary[] }

export interface DiscountLine { scope: string; kind: string; percent_bp?: number; amount?: Money; reason_code: string }
export interface DiscountApproval {
  id: string; status: string; centre_id: string; patient_code?: string; requested_by: Actor; discounts: DiscountLine[]; computed_discount: Money; gross: Money;
  percent_of_gross_bp: number; reason_code: string; reason_text?: string; expires_at: string; consumed_order_id?: string; version: number;
}

export interface InvoiceRow { id: string; invoice_no: string; invoice_date_bs: string; issued_at: string; status: string; net: Money; print_count?: number }
export interface LedgerEntry { id: string; entry_kind: string; method_code?: string; amount: Money; receipt_no?: string; collected_by?: Actor; created_at: string }
export interface OrderBilling {
  balance: { invoiced: Money; paid: Money; credited: Money; balance_due: Money };
  eligibility: { eligible?: boolean; basis?: string; release_eligible?: boolean; release_basis?: string; order_id?: string; balance_due?: Money; evaluated_at?: string };
  invoices: InvoiceRow[]; credit_notes: { id: string; credit_note_no?: string }[]; ledger_entries: LedgerEntry[];
  open_credit_note_tasks: { id: string; cause: string; status: string }[];
  open_finance_review_items: { id: string; kind?: string; status?: string }[];
  refund_requests: { id: string; method_code: string; refund_amount: Money; status: string }[];
}
export interface CatalogOption { id: string; code: string; name: string }
/** F8b quoteOrderItemsChange response: only the fields the order page reads. */
export interface ItemsChangeQuote { totals: { net: Money }; quote_fingerprint: string }
export const CONSENT_TEXT_VERSION_FALLBACK = 'v1';
