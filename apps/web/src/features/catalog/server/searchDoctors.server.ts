import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { bool, int, opt, str } from './shared';
import type { DoctorSummary } from './types';

/** The name travels in the BODY, never the URL (D-C3-06). Read-only POST: no Idempotency-Key. */
export async function searchDoctors(q: { q: string; includeUnverified?: boolean; includeInactive?: boolean; limit?: number }) {
  const body: Record<string, unknown> = { q: str(1, 64)(q.q) };
  const iu = opt(bool, q.includeUnverified);
  const ii = opt(bool, q.includeInactive);
  const limit = opt(int(1, 50), q.limit);
  if (iu !== undefined) body['include_unverified'] = iu;
  if (ii !== undefined) body['include_inactive'] = ii;
  if (limit !== undefined) body['limit'] = limit;
  return serverFetch<{ data: DoctorSummary[] }>('/v1/catalog/doctors/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
