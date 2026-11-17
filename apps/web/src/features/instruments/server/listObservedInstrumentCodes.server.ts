import 'server-only';
// E32 listObservedInstrumentCodes (GET /v1/instruments/instruments/{id}/observed-codes). C7 operation: instruments.instrument.read is enforced by the API.
import { serverFetch } from '@/core/api/server-fetch';
import { isUuid, type ObservedCode } from './codeMaps';
import { badRequest } from './shared.server';
import type { Page } from './types';

export interface ListObservedQuery { recordClass?: ObservedCode['record_class']; mappingStatus?: ObservedCode['last_mapping_status']; limit?: number; cursor?: string }

export async function listObservedInstrumentCodes(instrumentId: string, q: ListObservedQuery = {}): Promise<Page<ObservedCode>> {
  const ok =
    isUuid(instrumentId) &&
    (q.recordClass === undefined || ['patient', 'qc', 'calibrator'].includes(q.recordClass)) &&
    (q.mappingStatus === undefined || ['mapped', 'unmapped'].includes(q.mappingStatus)) &&
    (q.limit === undefined || (Number.isInteger(q.limit) && q.limit >= 1 && q.limit <= 200)) &&
    (q.cursor === undefined || (typeof q.cursor === 'string' && q.cursor.length <= 512));
  if (!ok) throw badRequest();
  const p = new URLSearchParams();
  if (q.recordClass) p.set('record_class', q.recordClass);
  if (q.mappingStatus) p.set('mapping_status', q.mappingStatus);
  if (q.limit !== undefined) p.set('limit', String(q.limit));
  if (q.cursor) p.set('cursor', q.cursor);
  const qs = p.toString();
  return serverFetch<Page<ObservedCode>>(`/v1/instruments/instruments/${instrumentId}/observed-codes${qs ? `?${qs}` : ''}`);
}
