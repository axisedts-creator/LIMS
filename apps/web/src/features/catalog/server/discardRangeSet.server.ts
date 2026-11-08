import 'server-only';
// #43 / #50 discard{Reference,Critical}Draft.
import { serverFetch } from '@/core/api/server-fetch';
import { uuid } from './guard';
import type { RangeSet } from './types';

const discard = (seg: string) => async (setId: string): Promise<RangeSet> => serverFetch<RangeSet>(`/v1/catalog/${seg}/${uuid(setId)}/discard`, { method: 'POST' });
export const discardReferenceRangeSetDraft = discard('reference-range-sets');
export const discardCriticalLimitSetDraft = discard('critical-limit-sets');
