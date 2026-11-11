import 'server-only';
// E26 updateInstrument (PATCH /v1/instruments/instruments/{instrument_id}, If-Match). instrument_code and agent_id are immutable.
import { serverFetch } from '@/core/api/server-fetch';
import { instrumentBody, validateInstrument, type InstrumentBody } from '../forms/instrument';
import { JSON_HEADERS, badRequest, ifMatch } from './shared.server';
import type { Instrument } from './types';

export async function updateInstrument(instrumentId: string, version: number, patch: Partial<InstrumentBody>): Promise<Instrument> {
  const match = ifMatch(instrumentId, version);
  if (validateInstrument(patch, 'update').length) throw badRequest();
  return serverFetch<Instrument>(`/v1/instruments/instruments/${instrumentId}`, {
    method: 'PATCH',
    headers: { ...JSON_HEADERS, 'if-match': match },
    body: JSON.stringify(instrumentBody(patch as Record<string, unknown>, 'update')),
  });
}
