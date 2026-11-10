import 'server-only';
// BFF writes for the registration page: F8 quote, F9 register (Idempotency-Key), F6b approval request, C5 #14a label readiness.
// B3 printInvoice is reused from the billing BFF.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { KEY_RE, UUID_RE, type DiscountApprovalIn, type LabelReadiness, type Quote, type RegisterBody, type RegistrationDraft, type RegistrationResult } from './types';

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const post = <T>(path: string, body: unknown, key?: string) => {
  if (key !== undefined && !KEY_RE.test(key)) throw bad();
  return serverFetch<T>(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) });
};

export const quoteRegistration = (draft: RegistrationDraft) => post<Quote>('/v1/frontdesk/registrations/quote', draft);
export const createRegistration = (body: RegisterBody, key: string) => post<RegistrationResult>('/v1/frontdesk/registrations', body, key);
export const requestDiscountApproval = (b: DiscountApprovalIn, key: string) =>
  post<{ id: string; state?: string; status?: string }>('/v1/frontdesk/discount-approvals', { centre_id: b.centre_id, base_fingerprint: b.base_fingerprint, discounts: b.discounts, reason_code: b.reason_code, ...(b.reason_text ? { reason_text: b.reason_text } : {}), patient_ref: b.patient_id ? { patient_id: b.patient_id } : undefined }, key);
/** C5 #14a: 200 once the specimens exist, 409 common.version_conflict while they do not. Body is `{}`. */
export function requestLabelPrints(orderId: string, key: string) {
  if (!UUID_RE.test(orderId)) throw bad();
  return post<LabelReadiness>(`/v1/lab/orders/${orderId}/label-prints`, {}, key);
}
