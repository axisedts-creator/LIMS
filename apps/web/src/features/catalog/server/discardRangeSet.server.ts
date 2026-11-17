import 'server-only';
// #43 / #50 discard{Reference,Critical}Draft (If-Match).
import { serverFetch } from '@/core/api/server-fetch';
import { ifMatch, json, uuid } from './guard';
import type { RangeSet } from './types';

const discard = (seg: string) => async (setId: string, version: number): Promise<RangeSet> => {
  const id = uuid(setId);
  return serverFetch<RangeSet>(`/v1/catalog/${seg}/${id}/discard`, { method: 'POST', headers: json({ 'if-match': ifMatch(version) }) });
};
export const discardReferenceRangeSetDraft = discard('reference-range-sets');
export const discardCriticalLimitSetDraft = discard('critical-limit-sets');
