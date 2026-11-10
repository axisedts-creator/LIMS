import 'server-only';
// E35 getInstrumentMessage (GET /v1/instruments/messages/{id}); preview_parse only on request (records older than 90 days).
import { serverFetch } from '@/core/api/server-fetch';
import type { MessageDetailDto } from './messages';
import { badRequest } from './shared.server';
import { UUID_RE } from './types';

export async function getInstrumentMessage(id: string, opts: { previewParse?: boolean } = {}): Promise<MessageDetailDto> {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw badRequest();
  return serverFetch<MessageDetailDto>(`/v1/instruments/messages/${id}${opts.previewParse ? '?preview_parse=true' : ''}`);
}
