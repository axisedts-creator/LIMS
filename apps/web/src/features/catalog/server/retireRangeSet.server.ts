import 'server-only';
// #42 / #49 retire{Reference,Critical}Set (privileged: If-Match + Idempotency-Key + change_reason).
import { serverFetch } from '@/core/api/server-fetch';
import { idemKey, ifMatch, json, reason, uuid } from './guard';
import type { RangeSet } from './types';

const retire = (seg: string) => async (setId: string, version: number, body: { change_reason: string; effective_at?: string }, idempotencyKey: string): Promise<RangeSet> => {
  const id = uuid(setId);
  const headers = json({ 'if-match': ifMatch(version), 'idempotency-key': idemKey(idempotencyKey) });
  reason(body.change_reason);
  return serverFetch<RangeSet>(`/v1/catalog/${seg}/${id}/retire`, { method: 'POST', headers, body: JSON.stringify(body) });
};
export const retireReferenceRangeSet = retire('reference-range-sets');
export const retireCriticalLimitSet = retire('critical-limit-sets');
