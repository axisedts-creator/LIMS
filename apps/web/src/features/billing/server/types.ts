// DTOs mirrored from contracts/openapi/billing.yaml. [CONV] hand-mirrored: apps/web has no generated client yet — replace with
// generated types when it lands. Type-only + constants: safe to import from client components (no server-only, no secrets).
export interface Money { amount_paisa: number; currency: string }
export interface Page<T> { data: T[]; page: { limit: number; next_cursor?: string } }
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

export interface InvoiceSummary {
  id: string; invoice_no: string; invoice_seq: number; fiscal_year_bs: string; invoice_kind: string; status: string;
  issued_at: string; invoice_date_bs: string; centre_id?: string; order_id?: string; credit_party_id?: string;
  buyer_name?: string; net: Money; cbms_state: string; print_count?: number;
}
export interface Party { name?: string; pan?: string; address?: string }
export interface InvoiceLine {
  id: string; line_no: number; line_kind: string; code?: string; name: string; quantity: number; unit_price: Money; gross: Money;
  discount: Money; exempt: Money; taxable: Money; vat: Money; other_tax: Money; net: Money; credited?: Money;
}
export interface Totals { gross: Money; discount: Money; exempt: Money; taxable: Money; vat: Money; other_tax: Money; net: Money }
export interface InvoiceDetail extends InvoiceSummary {
  print_count: number;
  series?: string; is_active: boolean; branch_id: string; is_periodic_credit_bill: boolean; referrer_id?: string; referrer_name?: string;
  registration_no?: string; buyer: Party; seller: Party; lines: InvoiceLine[]; totals: Totals; credited_total: Money;
  cancellation?: { cancelled_at: string; cancelled_by_display: string; reason_code: string; reason_text?: string; credit_note_id: string; credit_note_no: string };
  last_printed_at?: string; cbms_cancel_state?: string; version: number;
  cbms_submissions: { document_kind: string; attempt_no: number; client_mode: string; outcome: string; submitted_at: string }[];
}
export interface InvoicePrintRow { print_no: number; is_copy: boolean; reason_code: string; printed_by_display: string; printed_at: string }
export interface Branding { legal_name?: string; address_lines?: string[]; phones?: string[]; images?: { kind: string; data_uri: string }[] }
export interface InvoicePrintDocument extends InvoiceDetail {
  branding?: Branding; dates?: { bs: string; ad: string }; payment_block?: { paid: Money; balance_due: Money }; print_no?: number;
  copy_mark?: string; cancelled_banner?: string; printed_by_display?: string; printed_at?: string; footer_note?: string;
}
export interface CreditNoteSummary { id: string; credit_note_no: string; kind: string; issued_at: string; credit_note_date_bs: string; net?: Money }
export interface CreditNotePrintDocument {
  id: string; credit_note_no: string; kind: string; invoice_no: string; invoice_date_bs?: string; invoice_issued_at?: string; fiscal_year_bs: string;
  issued_at: string; credit_note_date_bs: string; reason_code: string; reason_text?: string; lines: InvoiceLine[]; totals: Totals;
  branding?: Branding; dates?: { bs: string; ad: string }; print_no?: number; copy_mark?: string; seller?: Party; buyer?: Party;
}
export interface ReceiptDocument {
  receipt_no: string; issued_at: string; registration_no?: string; invoice_nos: string[]; method_code: string; amount: Money; balance_after?: Money;
  branding?: Branding; dates?: { bs: string; ad: string };
}
export interface DueRow {
  order_id: string; registration_no: string; patient_display: string; centre_id: string; invoiced: Money; paid: Money; credited: Money;
  balance_due: Money; oldest_invoice_at?: string;
}
export interface Actor { membership_id: string; display_name: string }
export interface CashSessionRow { method_code: string; expected: Money; counted?: Money; variance?: Money }
export interface CashSession { id: string; opened_by: Actor; centre_id: string; status: string; opened_at: string; closed_at?: string; rows: CashSessionRow[]; note?: string; version: number }
export interface DailyCash {
  business_date: string; business_date_bs: string;
  rows: { collected_by: Actor; method_code: string; entries: number; reversals: number; gross: Money; reversed: Money; net: Money }[];
  totals: { gross: Money; reversed: Money; net: Money }; sessions: CashSession[];
}
export interface CreditParty {
  id: string; code: string; name: string; credit_limit_paisa: number; credit_days: number; is_locked: boolean; lock_reason_code?: string; outstanding: Money; version: number;
}
export interface SalesRegisterRow { sn: number; invoice_date_bs: string; invoice_date_ad: string; invoice_no: string; buyer_name?: string; buyer_pan?: string; total: Money; exempt: Money; taxable: Money; vat: Money; other_tax: Money; status: string }
export interface CancelledInvoiceRow { sn: number; cancelled_date_bs: string; cancelled_date_ad: string; invoice_no: string; credit_note_no: string; buyer_name?: string; buyer_pan?: string; total: Money; reason_code: string }
export interface CreditNoteRegisterRow { sn: number; credit_note_date_bs: string; credit_note_date_ad: string; credit_note_no: string; kind: string; invoice_no: string; buyer_name?: string; buyer_pan?: string; reason_code: string; exempt: Money; taxable: Money; vat: Money; other_tax: Money; net: Money }
export interface ActivityRow { occurred_at: string; actor: Actor; action: string; entity_type: string; entity_id: string; summary?: string }
export interface CbmsDocumentRow { document_kind: string; document_id: string; document_no: string; cbms_state: string; attempts: number; last_attempt_at?: string; last_outcome?: string }
export interface CreditNoteTask { id: string; order_id: string; invoice_id: string; invoice_line_ids: string[]; cause: string; status: string; created_at: string }
export interface FinanceReviewItem { id: string; order_id: string; kind: string; status: string; amount?: Money; created_at: string; version: number }
export interface RefundRequest { id: string; order_id: string; method_code: string; refund_amount: Money; reason_code: string; status: string; requested_by: Actor; requested_at: string; version: number }
export interface BillingSettings {
  invoice_series_scope: 'tenant' | 'branch'; prices_include_tax: boolean; abbreviated_invoice_enabled: boolean; pay_by_qr_enabled: boolean;
  receipt_no_enabled: boolean; credit_days_auto_lock: boolean; cash_variance_alert_paisa: number; refund_alert_per_day: number; version?: number;
}
export interface ExportJob { id: string; kind: string; format: string; status: string; created_at: string }
export type ExportKind = 'sales_register' | 'cancelled_invoices' | 'credit_notes' | 'audit_trail' | 'daily_cash' | 'invoice_documents';
export type ExportFormat = 'xlsx' | 'xml' | 'pdf';

// Coded sets (05-SCHEMA §2 seeds). Displays [CONV]: no coded-set read API is wired into apps/web yet (B34 listBillingCodes).
export const CANCEL_REASONS = [
  { code: 'order_cancelled', display: 'Order cancelled' },
  { code: 'billing_error', display: 'Billing error' },
  { code: 'duplicate_invoice', display: 'Duplicate invoice' },
  { code: 'patient_request', display: 'Patient request' },
  { code: 'other', display: 'Other' },
] as const;
export const REPRINT_REASONS = [
  { code: 'reprint', display: 'Reprint' },
  { code: 'printer_fault', display: 'Printer fault' },
  { code: 'customer_copy', display: 'Customer copy' },
] as const;
export const REFUND_REASONS = [
  { code: 'test_cancelled', display: 'Test cancelled' },
  { code: 'overpayment', display: 'Overpayment' },
  { code: 'service_not_provided', display: 'Service not provided' },
  { code: 'other', display: 'Other' },
] as const;
export const PAYMENT_METHODS = [
  { code: 'cash', display: 'Cash' },
  { code: 'card', display: 'Card' },
  { code: 'esewa', display: 'eSewa' },
  { code: 'khalti', display: 'Khalti' },
  { code: 'fonepay_qr', display: 'Fonepay QR' },
  { code: 'bank_transfer', display: 'Bank transfer' },
] as const;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FY_RE = /^[0-9]{4}\/[0-9]{2}$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const INVOICE_SORTS = ['-issued_at', 'issued_at', 'invoice_seq', '-invoice_seq'] as const;
export type InvoiceSort = (typeof INVOICE_SORTS)[number];

type Sp = Readonly<Record<string, string | readonly string[] | undefined>>;
const first = (v: Sp[string]) => (typeof v === 'string' ? v : v?.[0]);

/** URL query → B1 filters. Unknown/invalid values are dropped so tampered input never reaches the API. */
export function parseInvoiceQuery(sp: Sp): { status?: string; centreId?: string; fiscalYearBs?: string; creditPartyId?: string; invoiceNo?: string; from?: string; to?: string; sort: InvoiceSort } {
  const s = first(sp.status);
  const c = first(sp.centre_id);
  const fy = first(sp.fiscal_year_bs);
  const cp = first(sp.credit_party_id);
  const no = first(sp.invoice_no);
  const dr = (sp.date_range ? (typeof sp.date_range === 'string' ? sp.date_range.split(',') : sp.date_range) : []) as string[];
  const sort = first(sp.sort);
  return {
    ...(s === 'issued' || s === 'cancelled' ? { status: s } : {}),
    ...(c && UUID_RE.test(c) ? { centreId: c } : {}),
    ...(fy && FY_RE.test(fy) ? { fiscalYearBs: fy } : {}),
    ...(cp && UUID_RE.test(cp) ? { creditPartyId: cp } : {}),
    ...(no ? { invoiceNo: no.slice(0, 64) } : {}),
    ...(dr[0] && dr[1] && ISO_DATE_RE.test(dr[0]) && ISO_DATE_RE.test(dr[1]) ? { from: dr[0], to: dr[1] } : {}),
    sort: (INVOICE_SORTS as readonly string[]).includes(sort ?? '') ? (sort as InvoiceSort) : '-issued_at',
  };
}
