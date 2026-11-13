import 'server-only';
// getSpecimen (C5 GET /v1/lab/specimens/{id}) — Reg no / barcode for worklist rows. The id is validated as a UUID before it reaches the path (REQ-SEC-026/027).
import { serverFetch } from '@/core/api/server-fetch';
import { uuid } from './shared';
import type { SpecimenLite } from './types';

export async function getSpecimen(id: string): Promise<SpecimenLite> {
  const s = await serverFetch<SpecimenLite>(`/v1/lab/specimens/${uuid(id)}`);
  return { ...(s.registration_no ? { registration_no: s.registration_no } : {}), ...(s.barcode ? { barcode: s.barcode } : {}) };
}

/** One call per distinct specimen; a failing read (403 / 404 / 5xx) just leaves that row without Reg no (the table still renders).
 *  ponytail: N+1 over ≤ 50 ids because C5 has no batch read; add one when it does. */
export async function getSpecimens(ids: readonly string[]): Promise<Record<string, SpecimenLite>> {
  const distinct = [...new Set(ids)];
  const got = await Promise.allSettled(distinct.map((id) => getSpecimen(id)));
  const out: Record<string, SpecimenLite> = {};
  got.forEach((r, i) => { if (r.status === 'fulfilled') out[distinct[i]!] = r.value; });
  return out;
}
