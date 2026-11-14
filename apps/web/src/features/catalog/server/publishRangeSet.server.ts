import 'server-only';
// #41 / #48 publish{Reference,Critical}Set (privileged: If-Match + Idempotency-Key + change_reason 1–500).
import { serverFetch } from '@/core/api/server-fetch';
import { idemKey, ifMatch, json, reason, uuid } from './guard';
import type { RangeSet } from './types';

const publish = (seg: string) => async (setId: string, version: number, body: { effective_from?: string; change_reason: string }, idempotencyKey: string): Promise<RangeSet> => {
  const id = uuid(setId);
  const headers = json({ 'if-match': ifMatch(version), 'idempotency-key': idemKey(idempotencyKey) });
  reason(body.change_reason);
  return serverFetch<RangeSet>(`/v1/catalog/${seg}/${id}/publish`, { method: 'POST', headers, body: JSON.stringify(body) });
};
export const publishReferenceRangeSet = publish('reference-range-sets');
export const publishCriticalLimitSet = publish('critical-limit-sets');
