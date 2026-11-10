import 'server-only';
// BFF reads for the front-desk order, patient, worklist and approvals pages (F4, F5, F7a, F9, F10, F15, F17, F18, F25, F26 + B7 + catalog list).
// All GET. The API enforces permissions; callers only skip calls the session cannot make (no 403 noise, no PHI fetched needlessly).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { UUID_RE, type CatalogOption, type Coded, type DiscountApproval, type Order, type OrderBilling, type OrderFlag, type OrderSummary, type Page, type Patient, type PossibleDuplicate } from './types';

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const id = (v: string) => {
  if (!UUID_RE.test(v)) throw bad();
  return v;
};
const CODED_SETS = ['order_cancel_reasons', 'item_removal_reasons', 'flag_resolutions'] as const;

export const getOrder = (orderId: string) => serverFetch<Order>(`/v1/frontdesk/orders/${id(orderId)}`);
export const getOrderBilling = (orderId: string) => serverFetch<OrderBilling>(`/v1/billing/orders/${id(orderId)}`);
export const getPatient = (patientId: string) => serverFetch<Patient>(`/v1/frontdesk/patients/${id(patientId)}`);
export const listPatientOrders = (patientId: string) => serverFetch<Page<OrderSummary>>(`/v1/frontdesk/patients/${id(patientId)}/orders?limit=50`);
export const listCodedSet = async (set: (typeof CODED_SETS)[number]) => (await serverFetch<Page<Coded>>(`/v1/frontdesk/coded-sets/${set}`)).data;
export const listOpenFlags = () => serverFetch<Page<OrderFlag>>('/v1/frontdesk/order-flags?status=open&limit=200');
export const listOrders = (status?: 'pre_registered') => serverFetch<Page<OrderSummary>>(`/v1/frontdesk/orders?limit=200${status ? `&status=${status}` : ''}`);
export const listPossibleDuplicates = () => serverFetch<Page<PossibleDuplicate>>('/v1/frontdesk/patients/possible-duplicates');
export const listDiscountApprovals = () => serverFetch<Page<DiscountApproval>>('/v1/frontdesk/discount-approvals');

/** Centre names for display only (C2 listCentres); the caller degrades to "—" when this fails or the caller lacks the permission. */
export const listCentres = async () => (await serverFetch<Page<{ id: string; name: string }>>('/v1/identity/centres')).data;

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
