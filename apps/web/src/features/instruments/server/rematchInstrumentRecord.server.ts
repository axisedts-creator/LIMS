import 'server-only';
// E39 rematchInstrumentRecord (POST /v1/instruments/message-records/{record_id}/rematch): the corrected barcode travels ONLY in the JSON body (REQ-SEC-098).
import { serverFetch } from '@/core/api/server-fetch';
import { isBarcode, type ReasonFields, type RematchResult } from './messages';
import { messageReasonBody } from './reprocessInstrumentMessage.server';
import { JSON_HEADERS, badRequest, idemKey } from './shared.server';
import { UUID_RE } from './types';

export async function rematchInstrumentRecord(recordId: string, input: ReasonFields & { sampleBarcode: string }, idempotencyKey: string): Promise<RematchResult> {
  if (typeof recordId !== 'string' || !UUID_RE.test(recordId) || !isBarcode(input?.sampleBarcode)) throw badRequest();
  const body = { sample_barcode: input.sampleBarcode, ...messageReasonBody(input) };
  const key = idemKey(idempotencyKey);
  return serverFetch<RematchResult>(`/v1/instruments/message-records/${recordId}/rematch`, { method: 'POST', headers: { ...JSON_HEADERS, 'idempotency-key': key }, body: JSON.stringify(body) });
}
