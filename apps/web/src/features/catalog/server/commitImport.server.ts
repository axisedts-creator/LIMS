import 'server-only';
// #102 commitImport (privileged: If-Match + Idempotency-Key). The typed price-list code is a UI-only guard and is never forwarded.
import { randomUUID } from 'node:crypto';
import { serverFetch } from '@/core/api/server-fetch';
import { IMPORT_KEY_RE } from './createImport.server';
import { bad, bool, int, pick, str, uuid, type V } from './shared';
import type { Import } from './types';

const isoDate: V = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(Date.parse(v))) throw bad();
  return v;
};

export async function commitImport(id: string, version: number, input: unknown, idempotencyKey?: string): Promise<Import> {
  const path = uuid(id) as string;
  int(1, Number.MAX_SAFE_INTEGER)(version);
  const body = pick(input, { effective_from: isoDate, change_reason: str(1, 500), accept_stale_base: bool, publish: bool, replace_draft: bool }, ['change_reason']);
  if (idempotencyKey !== undefined && !IMPORT_KEY_RE.test(idempotencyKey)) throw bad();
  return serverFetch<Import>(`/v1/catalog/imports/${path}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': `"${version}"`, 'idempotency-key': idempotencyKey ?? randomUUID() },
    body: JSON.stringify(body),
  });
}
