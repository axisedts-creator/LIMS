import 'server-only';
// E42 listMessageRejections (GET /v1/instruments/rejections) — SCR-09 "Rejected uploads" tab. Raw bytes are never part of the DTO.
import { serverFetch } from '@/core/api/server-fetch';
import { REJECTION_REASONS, validRange, type MessageRejection } from './messages';
import { badRequest } from './shared.server';
import { UUID_RE, type Page } from './types';

export interface ListRejectionsQuery { receivedAtFrom: string; receivedAtTo: string; agentId?: string; reason?: string; limit?: number; cursor?: string }

export async function listMessageRejections(q: ListRejectionsQuery): Promise<Page<MessageRejection>> {
  if (!validRange(q?.receivedAtFrom, q?.receivedAtTo)) throw badRequest();
  const p = new URLSearchParams({ received_at_from: q.receivedAtFrom, received_at_to: q.receivedAtTo });
  if (q.agentId !== undefined) {
    if (typeof q.agentId !== 'string' || !UUID_RE.test(q.agentId)) throw badRequest();
    p.set('agent_id', q.agentId);
  }
  if (q.reason !== undefined) {
    if (!(REJECTION_REASONS as readonly string[]).includes(q.reason)) throw badRequest();
    p.set('reason', q.reason);
  }
  if (q.cursor) p.set('cursor', q.cursor);
  if (q.limit !== undefined) {
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 200) throw badRequest();
    p.set('limit', String(q.limit));
  }
  return serverFetch<Page<MessageRejection>>(`/v1/instruments/rejections?${p}`);
}
