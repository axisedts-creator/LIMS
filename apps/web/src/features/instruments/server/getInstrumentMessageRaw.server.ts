import 'server-only';
// E36 getInstrumentMessageRaw (GET /v1/instruments/messages/{id}/raw). Every call is audited by the API, so callers fetch on demand only.
import { serverFetch } from '@/core/api/server-fetch';
import type { MessageRaw } from './messages';
import { badRequest } from './shared.server';
import { UUID_RE } from './types';

export async function getInstrumentMessageRaw(id: string): Promise<MessageRaw> {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw badRequest();
  return serverFetch<MessageRaw>(`/v1/instruments/messages/${id}/raw`);
}
