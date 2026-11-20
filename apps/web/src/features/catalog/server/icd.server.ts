import 'server-only';
// T0D-PARTYSET-1 (LD-321): BFF read of the ICD master (catalog.yaml listIcdMasterCodes, catalog.icd.manage; T0C-PARTYSET-1). Paged at 50 rows; only a
// short search text and a well formed cursor reach the query string. The writes are in features/partners/server/partysetActions.ts with the other PARTYSET writes.
import { serverFetch } from '@/core/api/server-fetch';
import type { IcdMasterCode } from '@/features/partners/server/partyset.server';
import type { Page } from '@/features/partners/server/types';

const CURSOR = /^[A-Za-z0-9_\-=.~+/]{1,512}$/;

export function listIcdMasterCodes(f: { q?: string | undefined; cursor?: string | undefined }) {
  const p = new URLSearchParams();
  const q = f.q?.trim().slice(0, 64);
  if (q) p.set('q', q);
  if (f.cursor && CURSOR.test(f.cursor)) p.set('cursor', f.cursor);
  p.set('limit', '50');
  return serverFetch<Page<IcdMasterCode>>(`/v1/catalog/icd-master?${p}`);
}
