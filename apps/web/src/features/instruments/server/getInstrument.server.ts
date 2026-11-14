import 'server-only';
// E25 getInstrument (GET /v1/instruments/instruments/{instrument_id}). Other-centre instruments come back as 404 common.not_found.
import { serverFetch } from '@/core/api/server-fetch';
import { badRequest } from './shared.server';
import { UUID_RE, type Instrument } from './types';

export async function getInstrument(instrumentId: string): Promise<Instrument> {
  if (typeof instrumentId !== 'string' || !UUID_RE.test(instrumentId)) throw badRequest(); // never builds a path from free text
  return serverFetch<Instrument>(`/v1/instruments/instruments/${instrumentId}`);
}
