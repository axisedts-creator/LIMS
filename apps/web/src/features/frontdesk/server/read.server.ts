import 'server-only';
// BFF reads for the registration page: F1 patient search (POST, so no PHI in URLs), C3 orderable/doctor/credit-party search,
// B-coded-set payment_methods, identity centres. `front_desk` holds no billing.credit_party.read, so B19 is never called (04-UI-UX §3.2 B).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { UUID_RE, type Centre, type CodedSetEntry, type CreditPartySummary, type DoctorSummary, type OrderableSummary, type PatientSummary } from './types';

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const q100 = (v: string) => {
  if (typeof v !== 'string' || v.trim() === '' || v.length > 100) throw bad();
  return v;
};
const json = { 'content-type': 'application/json' };

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
/** F25 listFrontdeskCodes (C4 02-TRD:219; frontdesk.order.read). Only the discount_reasons set is used by this page (04-UI-UX:90). */
export async function listDiscountReasons(): Promise<CodedSetEntry[]> {
  return (await serverFetch<{ data: CodedSetEntry[] }>('/v1/frontdesk/coded-sets/discount_reasons')).data;
}
/** Centres in scope for the page header. Identity may refuse the read for some roles: callers treat a failure as "none". */
export async function listCentres(): Promise<Centre[]> {
  const r = await serverFetch<{ data: { centre_id: string; name: string; is_active?: boolean }[] }>('/v1/identity/centres');
  return r.data.filter((c) => c.is_active !== false).map((c) => ({ id: c.centre_id, name: c.name }));
}
export async function getDiscountApproval(id: string): Promise<{ id: string; status?: string; state?: string }> {
  if (!UUID_RE.test(id)) throw bad();
  return serverFetch(`/v1/frontdesk/discount-approvals/${id}`);
}
