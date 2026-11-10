import 'server-only';
// BFF reads for the registration page: F1 patient search (POST, so no PHI in URLs), C3 orderable/doctor/credit-party search,
// B-coded-set payment_methods, identity centres. `front_desk` holds no billing.credit_party.read, so B19 is never called (04-UI-UX §3.2 B).
// Plus reads for the front-desk order, patient, worklist and approvals pages (F4, F5, F7a, F9, F10, F15, F17, F18, F25, F26 + B7 + catalog list).
// The API enforces permissions; callers only skip calls the session cannot make (no 403 noise, no PHI fetched needlessly).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import {
  UUID_RE,
  type CatalogOption, type Centre, type Coded, type CodedSetEntry, type CreditPartySummary, type DiscountApproval, type DoctorSummary,
  type Order, type OrderBilling, type OrderFlag, type OrderSummary, type OrderableSummary, type Page, type Patient, type PatientSummary, type PossibleDuplicate,
} from './types';

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const q100 = (v: string) => {
  if (typeof v !== 'string' || v.trim() === '' || v.length > 100) throw bad();
  return v;
};
const id = (v: string) => {
  if (!UUID_RE.test(v)) throw bad();
  return v;
};
const json = { 'content-type': 'application/json' };
const CODED_SETS = ['order_cancel_reasons', 'item_removal_reasons', 'flag_resolutions'] as const;

export async function searchPatients(query: string): Promise<PatientSummary[]> {
  return (await serverFetch<{ data: PatientSummary[] }>('/v1/frontdesk/patients/search', { method: 'POST', headers: json, body: JSON.stringify({ query: q100(query), limit: 20 }) })).data;
}
export async function searchOrderables(q: string): Promise<OrderableSummary[]> {
  return (await serverFetch<{ data: OrderableSummary[] }>(`/v1/catalog/orderables?${new URLSearchParams({ q: q100(q), is_orderable: 'true', limit: '20' })}`)).data;
}
export async function searchDoctors(q: string): Promise<DoctorSummary[]> {
  return (await serverFetch<{ data: DoctorSummary[] }>('/v1/catalog/doctors/search', { method: 'POST', headers: json, body: JSON.stringify({ q: q100(q), limit: 20 }) })).data;
}
export async function searchCreditParties(q: string): Promise<CreditPartySummary[]> {
  return (await serverFetch<{ data: CreditPartySummary[] }>(`/v1/catalog/credit-parties?${new URLSearchParams({ q: q100(q), limit: '20' })}`)).data;
}
export async function listPaymentMethods(): Promise<CodedSetEntry[]> {
  return (await serverFetch<{ data: CodedSetEntry[] }>('/v1/billing/coded-sets/payment_methods')).data;
}
/** F25 listFrontdeskCodes (C4 02-TRD:219; frontdesk.order.read). Only the discount_reasons set is used by the registration page (04-UI-UX:90). */
export async function listDiscountReasons(): Promise<CodedSetEntry[]> {
  return (await serverFetch<{ data: CodedSetEntry[] }>('/v1/frontdesk/coded-sets/discount_reasons')).data;
}
/** Centres in scope (C2 listCentres), active only. Identity may refuse the read for some roles: callers treat a failure as "none" / "—". */
export async function listCentres(): Promise<Centre[]> {
  const r = await serverFetch<{ data: { centre_id?: string; id?: string; name: string; is_active?: boolean }[] }>('/v1/identity/centres');
  return r.data.filter((c) => c.is_active !== false).map((c) => ({ id: (c.centre_id ?? c.id) as string, name: c.name }));
}
export async function getDiscountApproval(approvalId: string): Promise<{ id: string; status?: string; state?: string }> {
  return serverFetch(`/v1/frontdesk/discount-approvals/${id(approvalId)}`);
}

export const getOrder = (orderId: string) => serverFetch<Order>(`/v1/frontdesk/orders/${id(orderId)}`);
export const getOrderBilling = (orderId: string) => serverFetch<OrderBilling>(`/v1/billing/orders/${id(orderId)}`);
export const getPatient = (patientId: string) => serverFetch<Patient>(`/v1/frontdesk/patients/${id(patientId)}`);
export const listPatientOrders = (patientId: string) => serverFetch<Page<OrderSummary>>(`/v1/frontdesk/patients/${id(patientId)}/orders?limit=50`);
export const listCodedSet = async (set: (typeof CODED_SETS)[number]) => (await serverFetch<Page<Coded>>(`/v1/frontdesk/coded-sets/${set}`)).data;
export const listOpenFlags = () => serverFetch<Page<OrderFlag>>('/v1/frontdesk/order-flags?status=open&limit=200');
export const listOrders = (status?: 'pre_registered') => serverFetch<Page<OrderSummary>>(`/v1/frontdesk/orders?limit=200${status ? `&status=${status}` : ''}`);
export const listPossibleDuplicates = () => serverFetch<Page<PossibleDuplicate>>('/v1/frontdesk/patients/possible-duplicates');
export const listDiscountApprovals = () => serverFetch<Page<DiscountApproval>>('/v1/frontdesk/discount-approvals');

/** Orderables the "Add tests" dialog offers. ponytail: first 200 active tests, no server-side search; add a Combobox over searchOrderables when the catalogue outgrows that. */
export async function listCatalogOptions(): Promise<CatalogOption[]> {
  try {
    const r = await serverFetch<Page<{ id: string; code: string; name: string; is_active?: boolean; is_orderable?: boolean }>>('/v1/catalog/tests?limit=200');
    return r.data.filter((t) => t.is_active !== false && t.is_orderable !== false).map(({ id: i, code, name }) => ({ id: i, code, name }));
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return []; // no catalog.test.read: the dialog simply offers nothing
    throw e;
  }
}
