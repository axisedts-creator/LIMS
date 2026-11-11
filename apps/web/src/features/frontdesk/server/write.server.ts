import 'server-only';
// BFF writes for the registration page: F8 quote, F9 register (Idempotency-Key), F6b approval request, C5 #14a label readiness.
// B3 printInvoice is reused from the billing BFF.
// Plus writes for the front-desk order, patient, worklist and approvals pages: F14 cancelOrder, F13 changeOrderItems, F8b quoteOrderItemsChange,
// F7 updatePatient, F7b recordPatientConsent, F16 approve/reject, F18 resolveOrderFlag.
// Every write sends Idempotency-Key (02-CONVENTIONS §4.5); versioned writes send If-Match `"<version>"` (OpenAPI IfMatch).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import {
  KEY_RE, UUID_RE,
  type Consents, type DiscountApproval, type DiscountApprovalIn, type ItemsChangeQuote, type LabelReadiness, type Order, type OrderFlag, type Patient,
  type Quote, type RegisterBody, type RegistrationDraft, type RegistrationResult,
} from './types';

/** Key shape accepted by the order/patient/approval writes (FD-T14). The registration writes use the stricter KEY_RE. */
const WRITE_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const post = <T>(path: string, body: unknown, key?: string) => {
  if (key !== undefined && !KEY_RE.test(key)) throw bad();
  return serverFetch<T>(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) });
};
const uuid = (v: string) => {
  if (!UUID_RE.test(v)) throw bad();
  return v;
};
const version = (v: number) => {
  if (!Number.isInteger(v) || v < 1) throw bad();
  return v;
};
function send<T>(method: 'POST' | 'PATCH', path: string, body: unknown, key: string | undefined, v?: number): Promise<T> {
  if (key !== undefined && !WRITE_KEY_RE.test(key)) throw bad();
  return serverFetch<T>(path, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}), ...(v !== undefined ? { 'if-match': `"${version(v)}"` } : {}) },
    body: JSON.stringify(body),
  });
}
const text = (s: string, max: number) => {
  if (s.trim().length < 1 || s.length > max) throw bad();
  return s;
};

export const quoteRegistration = (draft: RegistrationDraft) => post<Quote>('/v1/frontdesk/registrations/quote', draft);
export const createRegistration = (body: RegisterBody, key: string) => post<RegistrationResult>('/v1/frontdesk/registrations', body, key);
export const requestDiscountApproval = (b: DiscountApprovalIn, key: string) =>
  post<{ id: string; state?: string; status?: string }>('/v1/frontdesk/discount-approvals', { centre_id: b.centre_id, base_fingerprint: b.base_fingerprint, discounts: b.discounts, reason_code: b.reason_code, ...(b.reason_text ? { reason_text: b.reason_text } : {}), patient_ref: b.patient_id ? { patient_id: b.patient_id } : undefined }, key);
/** C5 #14a: 200 once the specimens exist, 409 common.version_conflict while they do not. Body is `{}`. x-idempotency: none — no key (C5 02-TRD:227, 08 A13 D-4). */
export function requestLabelPrints(orderId: string) {
  return post<LabelReadiness>(`/v1/lab/orders/${uuid(orderId)}/label-prints`, {});
}

export const cancelOrder = (orderId: string, v: number, r: { reason_code: string; reason_text?: string }, key: string) =>
  send<Order>('POST', `/v1/frontdesk/orders/${uuid(orderId)}/cancel`, { ...r, reason_code: text(r.reason_code, 64) }, key, v);

export const quoteOrderItemsChange = (orderId: string, add: { orderable_id: string; priority: 'routine' | 'urgent' }[]) => {
  if (add.length < 1 || add.length > 50) throw bad();
  return send<ItemsChangeQuote>('POST', `/v1/frontdesk/orders/${uuid(orderId)}/items-changes/quote`, { add: add.map((a) => ({ orderable_id: uuid(a.orderable_id), priority: a.priority })) }, undefined);
};

export const changeOrderItems = (orderId: string, v: number, r: { add?: { orderable_id: string; priority: 'routine' | 'urgent' }[]; remove?: { order_item_id: string; reason_code: string }[]; quote_fingerprint?: string }, key: string) => {
  if ((r.add?.length ?? 0) + (r.remove?.length ?? 0) < 1 || (r.add?.length ?? 0) > 50 || (r.remove?.length ?? 0) > 50) throw bad();
  if (r.add?.length && !r.quote_fingerprint) throw bad(); // additions are priced by F8b first (04-UI-UX §4)
  r.remove?.forEach((x) => { uuid(x.order_item_id); text(x.reason_code, 64); });
  return send<Order & { credit_note_required?: boolean }>('POST', `/v1/frontdesk/orders/${uuid(orderId)}/items-changes`, r, key, v);
};

export const updatePatient = (patientId: string, v: number, changes: Record<string, string>) => {
  if (Object.keys(changes).length < 1) throw bad();
  return send<Patient>('PATCH', `/v1/frontdesk/patients/${uuid(patientId)}`, changes, undefined, v);
};
export const recordPatientConsent = (patientId: string, c: Consents, key: string) => send<unknown>('POST', `/v1/frontdesk/patients/${uuid(patientId)}/consents`, c, key);

/** B9 recordPayment (billing.payment.record) from the order page's Billing tab. */
export const recordPayment = (orderId: string, r: { method_code: string; amount_received_paisa: number; reference?: string }, key: string) => {
  if (!Number.isInteger(r.amount_received_paisa) || r.amount_received_paisa < 1) throw bad();
  return send<unknown>('POST', `/v1/billing/orders/${uuid(orderId)}/payments`, r, key);
};

/** F21 uploadTrf; TrfUploadForm.order_id links the file to the order so it shows in that order's trf_attachments. */
export function uploadTrf(centreId: string, orderId: string, file: File, key: string) {
  if (!WRITE_KEY_RE.test(key)) throw bad();
  const form = new FormData();
  form.set('centre_id', uuid(centreId));
  form.set('order_id', uuid(orderId));
  form.set('file', file);
  return serverFetch<unknown>('/v1/frontdesk/trf-attachments', { method: 'POST', headers: { 'idempotency-key': key }, body: form });
}

export const approveDiscount =(approvalId: string, v: number, key: string) => send<DiscountApproval>('POST', `/v1/frontdesk/discount-approvals/${uuid(approvalId)}/approve`, {}, key, v);
export const rejectDiscount = (approvalId: string, v: number, note: string, key: string) => send<DiscountApproval>('POST', `/v1/frontdesk/discount-approvals/${uuid(approvalId)}/reject`, { note: text(note, 500) }, key, v);

export const resolveOrderFlag = (flagId: string, v: number, resolutionCode: string, key: string) =>
  send<OrderFlag>('POST', `/v1/frontdesk/order-flags/${uuid(flagId)}/resolve`, { resolution_code: text(resolutionCode, 64) }, key, v);
