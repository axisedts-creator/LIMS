import 'server-only';
// #103 discardImport (If-Match guards repeats; Idempotency-Key is optional per the contract).
import { serverFetch } from '@/core/api/server-fetch';
import { int, uuid } from './shared';
import type { Import } from './types';

export async function discardImport(id: string, version: number): Promise<Import> {
  const path = uuid(id) as string;
  int(1, Number.MAX_SAFE_INTEGER)(version);
  return serverFetch<Import>(`/v1/catalog/imports/${path}/discard`, { method: 'POST', headers: { 'if-match': `"${version}"` } });
}
