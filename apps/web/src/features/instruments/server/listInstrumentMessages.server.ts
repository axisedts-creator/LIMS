import 'server-only';
// E33 listInstrumentMessages (GET /v1/instruments/messages). A sample barcode is never a query parameter (REQ-SEC-098): only the keys below are read.
import { serverFetch } from '@/core/api/server-fetch';
import { LATEST_OUTCOMES, MESSAGE_KINDS, validRange, type MessageSummary } from './messages';
import { badRequest } from './shared.server';
import { UUID_RE, type Page } from './types';

export interface ListMessagesQuery {
  receivedAtFrom: string;
  receivedAtTo: string;
  instrumentId?: string;
  agentId?: string;
  centreId?: string;
  messageKind?: readonly string[];
  latestOutcome?: readonly string[];
  hasUnmapped?: boolean;
  hasQc?: boolean;
  limit?: number;
  cursor?: string;
}

const allIn = (xs: unknown, allowed: readonly string[]) => Array.isArray(xs) && xs.length <= allowed.length && xs.every((x) => allowed.includes(x));

export async function listInstrumentMessages(q: ListMessagesQuery): Promise<Page<MessageSummary>> {
  if (!validRange(q?.receivedAtFrom, q?.receivedAtTo)) throw badRequest();
  const p = new URLSearchParams({ received_at_from: q.receivedAtFrom, received_at_to: q.receivedAtTo });
  for (const [key, v] of [['instrument_id', q.instrumentId], ['agent_id', q.agentId], ['centre_id', q.centreId]] as const) {
    if (v === undefined) continue;
    if (typeof v !== 'string' || !UUID_RE.test(v)) throw badRequest();
    p.set(key, v);
  }
  if (q.messageKind?.length) {
    if (!allIn(q.messageKind, MESSAGE_KINDS)) throw badRequest();
    p.set('message_kind', q.messageKind.join(','));
  }
  if (q.latestOutcome?.length) {
    if (!allIn(q.latestOutcome, LATEST_OUTCOMES)) throw badRequest();
    p.set('latest_outcome', q.latestOutcome.join(','));
  }
  for (const [key, v] of [['has_unmapped', q.hasUnmapped], ['has_qc', q.hasQc]] as const) {
    if (v === undefined) continue;
    if (typeof v !== 'boolean') throw badRequest();
    p.set(key, String(v));
  }
  if (q.cursor) p.set('cursor', q.cursor);
  if (q.limit !== undefined) {
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 200) throw badRequest();
    p.set('limit', String(q.limit));
  }
  return serverFetch<Page<MessageSummary>>(`/v1/instruments/messages?${p}`);
}
