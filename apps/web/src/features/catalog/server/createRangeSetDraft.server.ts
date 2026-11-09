import 'server-only';
// #38 / #45 create{Reference,Critical}Draft (Idempotency-Key). 409 common.version_conflict when a draft exists.
import { serverFetch } from '@/core/api/server-fetch';
import { idemKey, json, uuid } from './guard';
import type { Band, RangeSet } from './types';

const create = (seg: string) => async (analyteId: string, body: { copy_from_set_id?: string; bands?: Band[] }, idempotencyKey: string): Promise<RangeSet> => {
  const id = uuid(analyteId); // copy_from_set_id travels in the body, never in a path: the API validates it
  return serverFetch<RangeSet>(`/v1/catalog/analytes/${id}/${seg}`, { method: 'POST', headers: json({ 'idempotency-key': idemKey(idempotencyKey) }), body: JSON.stringify(body) });
};
export const createReferenceRangeSetDraft = create('reference-range-sets');
export const createCriticalLimitSetDraft = create('critical-limit-sets');
