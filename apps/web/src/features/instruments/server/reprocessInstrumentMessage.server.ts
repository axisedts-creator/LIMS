import 'server-only';
// E38 reprocessInstrumentMessage (POST /v1/instruments/messages/{id}/reprocess): Idempotency-Key, no If-Match (A-class). A retry reuses the caller's key.
import { serverFetch } from '@/core/api/server-fetch';
import { MESSAGE_REASON_TEXT_MAX, isReprocessReason, type ReasonFields, type ReprocessResult } from './messages';
import { JSON_HEADERS, badRequest, idemKey } from './shared.server';
import { UUID_RE } from './types';

/** reason_code + optional reason_text body, or a thrown 400. Shared by E38/E39. */
export function messageReasonBody(r: ReasonFields | undefined): { reason_code: string; reason_text?: string } {
  if (!r || !isReprocessReason(r.reasonCode)) throw badRequest();
  if (r.reasonText !== undefined && (typeof r.reasonText !== 'string' || r.reasonText.length > MESSAGE_REASON_TEXT_MAX)) throw badRequest();
  return { reason_code: r.reasonCode, ...(r.reasonText ? { reason_text: r.reasonText } : {}) };
}

export async function reprocessInstrumentMessage(id: string, input: ReasonFields, idempotencyKey: string): Promise<ReprocessResult> {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw badRequest();
  const body = messageReasonBody(input);
  const key = idemKey(idempotencyKey);
  return serverFetch<ReprocessResult>(`/v1/instruments/messages/${id}/reprocess`, { method: 'POST', headers: { ...JSON_HEADERS, 'idempotency-key': key }, body: JSON.stringify(body) });
}
