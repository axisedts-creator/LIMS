import 'server-only';
// #40 / #47 replace{Reference,Critical}Bands (PUT {bands[1–100]}, If-Match). Decimals stay strings end to end.
import { serverFetch } from '@/core/api/server-fetch';
import { badRequest, ifMatch, json, uuid } from './guard';
import type { Band, RangeSet } from './types';

const replace = (seg: string) => async (setId: string, version: number, bands: readonly Band[]): Promise<RangeSet> => {
  const id = uuid(setId);
  const headers = json({ 'if-match': ifMatch(version) });
  if (!Array.isArray(bands) || bands.length < 1 || bands.length > 100) throw badRequest();
  return serverFetch<RangeSet>(`/v1/catalog/${seg}/${id}/bands`, { method: 'PUT', headers, body: JSON.stringify({ bands }) });
};
export const replaceReferenceRangeBands = replace('reference-range-sets');
export const replaceCriticalLimitBands = replace('critical-limit-sets');
