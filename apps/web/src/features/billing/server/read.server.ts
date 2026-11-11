import 'server-only';
// BFF reads for the billing screens (B1, B2, B2a, B6a/b, B13, B17, B19–B27, B30–B33, B35). All GET; no PHI beyond what the API allows
// for the caller's permissions (the API enforces; the UI only hides).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import type { Charge, StatementMonth } from '../components/CreditPartyDetail';
import { FY_RE, ISO_DATE_RE, UUID_RE, type ActivityRow, type BillingSettings, type CancelledInvoiceRow, type CbmsDocumentRow, type CashSession, type CreditNoteRegisterRow, type CreditNoteTask, type CreditParty, type DailyCash, type DueRow, type FinanceReviewItem, type InvoiceDetail, type InvoicePrintRow, type InvoiceSummary, type Page, type RefundRequest, type SalesRegisterRow } from './types';

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));

/** Query values are validated by shape before they leave the BFF; anything else is a 400, never forwarded. */
function qs(params: Record<string, string | number | undefined>, checks: Record<string, RegExp> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    const s = String(v);
    const re = checks[k];
    if (re && !re.test(s)) throw bad();
    p.set(k, s);
  }
  const out = p.toString();
  return out ? `?${out}` : '';
}
const id = (v: string) => {
  if (!UUID_RE.test(v)) throw bad();
  return v;
};

export interface Filters { fiscalYearBs?: string; from?: string; to?: string; centreId?: string; cursor?: string; limit?: number }
const dateRe = { from: ISO_DATE_RE, to: ISO_DATE_RE, fiscal_year_bs: FY_RE, centre_id: UUID_RE, credit_party_id: UUID_RE, order_id: UUID_RE, actor_membership_id: UUID_RE };
const limitOf = (n?: number) => {
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 200)) throw bad();
  return n;
};

export async function listInvoices(q: { status?: string; centreId?: string; fiscalYearBs?: string; creditPartyId?: string; invoiceNo?: string; from?: string; to?: string; sort?: string; cursor?: string; limit?: number } = {}) {
  return serverFetch<Page<InvoiceSummary>>(`/v1/billing/invoices${qs({ status: q.status, centre_id: q.centreId, fiscal_year_bs: q.fiscalYearBs, credit_party_id: q.creditPartyId, invoice_no: q.invoiceNo, issued_at_from: q.from ? `${q.from}T00:00:00.000Z` : undefined, issued_at_to: q.to ? `${q.to}T23:59:59.999Z` : undefined, sort: q.sort, cursor: q.cursor, limit: limitOf(q.limit) }, { centre_id: UUID_RE, fiscal_year_bs: FY_RE, credit_party_id: UUID_RE })}`);
}
export const getInvoice = (invoiceId: string) => serverFetch<InvoiceDetail>(`/v1/billing/invoices/${id(invoiceId)}`);
export const listInvoicePrints = (invoiceId: string) => serverFetch<Page<InvoicePrintRow>>(`/v1/billing/invoices/${id(invoiceId)}/prints`);
export const listCreditNotesForInvoice = (invoiceId: string) => serverFetch<Page<{ id: string; credit_note_no: string; kind: string; issued_at: string; credit_note_date_bs: string }>>(`/v1/billing/credit-notes${qs({ invoice_id: invoiceId }, { invoice_id: UUID_RE })}`);
export const listDues = (f: Filters = {}) => serverFetch<Page<DueRow>>(`/v1/billing/dues${qs({ centre_id: f.centreId, cursor: f.cursor, limit: limitOf(f.limit) }, dateRe)}`);
export const getMyCashSession = () => serverFetch<CashSession>('/v1/billing/cash-sessions/current').catch((e: unknown) => {
  if (e instanceof ApiError && e.status === 404) return null; // no open shift
  throw e;
});
export const getDailyCash = (q: { date?: string; centreId?: string; actorMembershipId?: string } = {}) => serverFetch<DailyCash>(`/v1/billing/daily-cash${qs({ date: q.date, centre_id: q.centreId, actor_membership_id: q.actorMembershipId }, { date: ISO_DATE_RE, centre_id: UUID_RE, actor_membership_id: UUID_RE })}`);
export const listCreditParties = (f: { cursor?: string; limit?: number } = {}) => serverFetch<Page<CreditParty>>(`/v1/billing/credit-parties${qs({ cursor: f.cursor, limit: limitOf(f.limit) })}`);
export const getCreditParty = (partyId: string) => serverFetch<CreditParty>(`/v1/billing/credit-parties/${id(partyId)}`);
export const listCreditCharges = (partyId: string) => serverFetch<Page<Charge>>(`/v1/billing/credit-parties/${id(partyId)}/charges`);
export const getCreditPartyStatement = (partyId: string) => serverFetch<{ rows: StatementMonth[] }>(`/v1/billing/credit-parties/${id(partyId)}/statement`);
export const getSalesRegister = (f: Filters = {}) => serverFetch<Page<SalesRegisterRow>>(`/v1/billing/registers/sales${qs({ fiscal_year_bs: f.fiscalYearBs, from: f.from, to: f.to, centre_id: f.centreId, cursor: f.cursor, limit: limitOf(f.limit) }, dateRe)}`);
export const getCancelledInvoiceRegister = (f: Filters = {}) => serverFetch<Page<CancelledInvoiceRow>>(`/v1/billing/registers/cancelled-invoices${qs({ fiscal_year_bs: f.fiscalYearBs, from: f.from, to: f.to, centre_id: f.centreId, cursor: f.cursor, limit: limitOf(f.limit) }, dateRe)}`);
export const getCreditNoteRegister = (f: Filters = {}) => serverFetch<Page<CreditNoteRegisterRow>>(`/v1/billing/registers/credit-notes${qs({ fiscal_year_bs: f.fiscalYearBs, from: f.from, to: f.to, centre_id: f.centreId, cursor: f.cursor, limit: limitOf(f.limit) }, dateRe)}`);
export const getAuditTrail = (f: Filters & { actorMembershipId?: string; action?: string } = {}) => serverFetch<Page<ActivityRow>>(`/v1/billing/audit-trail${qs({ from: f.from, to: f.to, actor_membership_id: f.actorMembershipId, action: f.action?.slice(0, 64), cursor: f.cursor, limit: limitOf(f.limit) }, dateRe)}`);
export const listCbmsDocuments = (f: { cursor?: string; limit?: number } = {}) => serverFetch<Page<CbmsDocumentRow>>(`/v1/billing/cbms/documents${qs({ cursor: f.cursor, limit: limitOf(f.limit) })}`);
export const listCreditNoteTasks = () => serverFetch<Page<CreditNoteTask>>('/v1/billing/credit-note-tasks');
export const listFinanceReviewItems = () => serverFetch<Page<FinanceReviewItem>>('/v1/billing/finance-review-items');
export const listRefundRequests = () => serverFetch<Page<RefundRequest>>('/v1/billing/refund-requests?status=pending');
export const getBillingSettings = () => serverFetch<BillingSettings>('/v1/billing/settings');
