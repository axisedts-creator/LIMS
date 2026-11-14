import 'server-only';
// E34 searchInstrumentMessages (POST /v1/instruments/messages/search). The sample barcode travels ONLY in the JSON body (REQ-SEC-098): the URL has no query.
// Only the four documented body keys are forwarded; anything else is dropped.
import { serverFetch } from '@/core/api/server-fetch';
import { isBarcode, validRange, type MessageSummary } from './messages';
import { JSON_HEADERS, badRequest } from './shared.server';
import { UUID_RE } from './types';

export interface SearchMessagesInput { sampleBarcode: string; receivedAtFrom?: string; receivedAtTo?: string; instrumentId?: string }

export async function searchInstrumentMessages(input: SearchMessagesInput): Promise<{ data: MessageSummary[] }> {
  if (!isBarcode(input?.sampleBarcode)) throw badRequest();
  const body: Record<string, string> = { sample_barcode: input.sampleBarcode };
  const { receivedAtFrom: from, receivedAtTo: to, instrumentId } = input;
  if (from !== undefined || to !== undefined) {
    if (typeof from !== 'string' || typeof to !== 'string' || !validRange(from, to)) throw badRequest();
    body['received_at_from'] = from;
    body['received_at_to'] = to;
  }
  if (instrumentId !== undefined) {
    if (typeof instrumentId !== 'string' || !UUID_RE.test(instrumentId)) throw badRequest();
    body['instrument_id'] = instrumentId;
  }
  return serverFetch<{ data: MessageSummary[] }>('/v1/instruments/messages/search', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}
