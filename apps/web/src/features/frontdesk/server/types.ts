// Wire types for the registration page (F1, F8, F9, C3 search, B3, C5 #14a). Names copied from 02-TRD §F and 03-INTERFACE-CATALOG.
export interface Money { amount_paisa: number; currency: string }
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; title?: string; detail?: string; errors?: { path: string; code: string }[] };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface Centre { id: string; name: string }
export interface PatientSummary { id: string; patient_code: string; full_name: string; sex: string; age_display: string; phone_masked?: string; last_visit_at?: string; is_anonymised?: boolean }
export interface OrderableSummary { id: string; kind: 'test' | 'panel'; code: string; name: string }
export interface DoctorSummary { id: string; doctor_code?: string; display_name: string; is_verified?: boolean }
export interface CreditPartySummary { id: string; party_code?: string; name: string }
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
export interface NewPatientDraft {
  full_name: string; sex: string; birth_on?: string; age?: { years: number; months: number; days: number };
  phone_e164?: string; email?: string; address_text?: string;
  consents: { processing: boolean; sms: boolean; whatsapp: boolean; email: boolean; share_with_referrer: boolean; consent_text_version: string };
}
export interface RegistrationDraft {
  patient: { patient_id: string } | { new_patient: NewPatientDraft };
  centre_id: string; visit_type: 'opd' | 'ipd'; billing_mode: 'cash' | 'credit'; priority: 'routine' | 'urgent'; collection_mode: string;
  credit_party_id?: string; referrer_id?: string;
  items: { orderable_id: string; priority: 'routine' | 'urgent' }[];
  discounts?: DraftDiscount[];
}
export interface PaymentIn { method_code: string; amount_received_paisa: number; reference?: string; tendered_paisa?: number }
export type RegisterBody = RegistrationDraft & {
  quote_fingerprint: string; payments: PaymentIn[]; discount_approval_id?: string;
  /** LD-25 (2026-11-07) downtime back-entry; absent = live. */
  entry_mode?: 'downtime_backentry'; occurred_at?: string; downtime_ref?: string;
};
export interface DiscountApprovalIn { centre_id: string; base_fingerprint: string; discounts: DraftDiscount[]; reason_code: string; reason_text?: string; patient_id?: string }
export interface InvoicePrintDoc{ print_no: number; document?: unknown }
export interface LabelReadiness { order_id: string; specimens: unknown[]; labels_route?: string }
