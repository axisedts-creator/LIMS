import 'server-only';
// BFF writes for the billing screens: B3 printInvoice, B4 cancelInvoice, B5 issuePartialCreditNote, B10 requestRefund, B10a/b approve/reject,
// B17b closeCashSession, B31 retryCbms, B28/B29 exports, B33 updateBillingSettings. Every write sends Idempotency-Key; versioned writes If-Match.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { UUID_RE, type BillingSettings, type CashSession, type ExportFormat, type ExportJob, type ExportKind, type InvoiceDetail, type InvoicePrintDocument } from './types';

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const uuid = (v: string) => {
  if (!UUID_RE.test(v)) throw bad();
  return v;
};
function post<T>(path: string, body: unknown, key: string, version?: number): Promise<T> {
  if (!KEY_RE.test(key)) throw bad();
  return serverFetch<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...(version !== undefined ? { 'if-match': `"${version}"` } : {}) },
    body: JSON.stringify(body),
  });
}

export const printInvoice = (invoiceId: string, reasonCode: string, key: string) =>
  post<{ print_no: number; copy_mark?: string; document: InvoicePrintDocument }>(`/v1/billing/invoices/${uuid(invoiceId)}/print`, { reason_code: reasonCode }, key);

export const cancelInvoice = (invoiceId: string, version: number, r: { reason_code: string; reason_text?: string }, key: string) =>
  post<{ invoice: InvoiceDetail; credit_note: { id: string; credit_note_no: string } }>(`/v1/billing/invoices/${uuid(invoiceId)}/cancel`, r, key, version);

export const issuePartialCreditNote = (invoiceId: string, r: { lines: { invoice_line_id: string; amount_paisa?: number }[]; reason_code: string; reason_text?: string }, key: string) =>
  post<{ id: string; credit_note_no: string }>(`/v1/billing/invoices/${uuid(invoiceId)}/credit-notes`, r, key);

export const requestRefund = (orderId: string, r: { method_code: string; refund_amount_paisa: number; reason_code: string; reason_text?: string; reference?: string }, key: string) =>
  post<{ id: string; status: string }>(`/v1/billing/orders/${uuid(orderId)}/refund-requests`, r, key);

export const approveRefund = (id: string, version: number, key: string) => post<unknown>(`/v1/billing/refund-requests/${uuid(id)}/approve`, {}, key, version);
export const rejectRefund = (id: string, version: number, note: string, key: string) => {
  if (note.trim().length < 1 || note.length > 500) throw bad();
  return post<unknown>(`/v1/billing/refund-requests/${uuid(id)}/reject`, { note }, key, version);
};

export const resolveFinanceReviewItem = (id: string, version: number, r: { resolution_code: 'refunded' | 'kept_as_advance' | 'other'; note?: string }, key: string) => {
  if (!['refunded', 'kept_as_advance', 'other'].includes(r.resolution_code) || (r.resolution_code === 'other' && !r.note?.trim())) throw bad();
  return post<unknown>(`/v1/billing/finance-review-items/${uuid(id)}/resolve`, r, key, version);
};

export const closeCashSession = (id: string, version: number, r: { counted: { method_code: string; amount_paisa: number }[]; note?: string }, key: string) =>
  post<CashSession>(`/v1/billing/cash-sessions/${uuid(id)}/close`, r, key, version);

export const retryCbmsDocument = (kind: string, id: string, key: string) => {
  if (!['invoice', 'invoice_cancellation', 'credit_note'].includes(kind)) throw bad();
  return post<{ cbms_state: string }>(`/v1/billing/cbms/documents/${kind}/${uuid(id)}/retry`, {}, key);
};

export const createBillingExport = (kind: ExportKind, format: ExportFormat, filters: { fiscal_year_bs?: string; from?: string; to?: string; centre_id?: string }, key: string) =>
  post<ExportJob>('/v1/billing/exports', { kind, format, filters }, key);
export const getBillingExport = (exportId: string) => serverFetch<ExportJob>(`/v1/billing/exports/${uuid(exportId)}`);

export function updateBillingSettings(version: number, s: Omit<BillingSettings, 'version'>, key: string) {
  if (!KEY_RE.test(key)) throw bad();
  return serverFetch<BillingSettings>('/v1/billing/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, 'if-match': `"${version}"` },
    body: JSON.stringify(s),
  });
}
