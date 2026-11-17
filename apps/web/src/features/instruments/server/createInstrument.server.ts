import 'server-only';
// E24 createInstrument (POST /v1/instruments/instruments, x-idempotency: required). The form mints one key per open and passes it
// on every submit, so a retry after a failure is deduplicated by the API (02-CONVENTIONS §4.5).
import { randomUUID } from 'node:crypto';
import { serverFetch } from '@/core/api/server-fetch';
import { instrumentBody, validateInstrument, type InstrumentBody } from '../forms/instrument';
import { JSON_HEADERS, badRequest } from './shared.server';
import { IDEMPOTENCY_KEY_RE, type Instrument } from './types';

export async function createInstrument(input: InstrumentBody, idempotencyKey?: string): Promise<Instrument> {
  if (validateInstrument(input, 'create').length || (idempotencyKey !== undefined && !(typeof idempotencyKey === 'string' && IDEMPOTENCY_KEY_RE.test(idempotencyKey)))) throw badRequest();
  return serverFetch<Instrument>('/v1/instruments/instruments', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'idempotency-key': idempotencyKey ?? randomUUID() },
    body: JSON.stringify(instrumentBody(input as Record<string, unknown>, 'create')),
  });
}
