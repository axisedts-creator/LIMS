import 'server-only';
// listCentres (C2 GET /v1/identity/centres?is_active=true) under the user's session / identity.centre.read (08 A13 D-16).
// Any failure (403, 5xx, network) → null: the worklist hides the Centre filter instead of failing.
import { serverFetch } from '@/core/api/server-fetch';
import type { CentreLite } from './types';

export async function listCentres(): Promise<CentreLite[] | null> {
  try {
    const r = await serverFetch<{ data: CentreLite[] }>('/v1/identity/centres?is_active=true&limit=200');
    return r.data.map((c) => ({ centre_id: c.centre_id, name: c.name }));
  } catch {
    return null;
  }
}
