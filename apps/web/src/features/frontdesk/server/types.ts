// DTOs mirrored from contracts/openapi/frontdesk.yaml + billing.yaml (OrderDto, OrderSummaryDto, OrderFlag, Patient, DiscountApproval,
// PossibleDuplicate, OrderBillingDto). [CONV] hand-mirrored like features/billing/server/types.ts: apps/web has no generated client yet.
// Type-only + constants: safe to import from client components.
export interface Money { amount_paisa: number; currency: string }
export interface Page<T> { data: T[]; page?: { limit: number; next_cursor?: string } }
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export interface PatientSummary { id: string; patient_code: string; full_name: string; sex: string; age_display: string; phone_masked: string; is_anonymised: boolean }
export interface Consents { processing: boolean; sms: boolean; whatsapp: boolean; email: boolean; share_with_referrer: boolean; consent_text_version: string }
export interface Patient extends PatientSummary { is_birth_on_estimated?: boolean; phone_e164?: string; email?: string; address_text?: string; consents: Consents; version: number }
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
  eligibility: { release_eligible: boolean; release_basis: string };
  invoices: InvoiceRow[]; credit_notes: { id: string; credit_note_no?: string }[]; ledger_entries: LedgerEntry[];
  open_credit_note_tasks: { id: string; cause: string; status: string }[];
  open_finance_review_items: { id: string; kind?: string; status?: string }[];
  refund_requests: { id: string; method_code: string; refund_amount: Money; status: string }[];
}
export interface CatalogOption { id: string; code: string; name: string }
export interface Quote { totals: { net: Money }; quote_fingerprint: string }
export const CONSENT_TEXT_VERSION_FALLBACK = 'v1';
