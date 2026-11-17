import 'server-only';
// #104 createExport. credit_parties has no export kind (Export.kind enum).
import { randomUUID } from 'node:crypto';
import { serverFetch } from '@/core/api/server-fetch';
import { IMPORT_KEY_RE } from './createImport.server';
import { bad, oneOf, pick, uuid } from './shared';
import { EXPORT_KINDS, type ExportRow } from './types';

export async function createExport(input: unknown, idempotencyKey?: string): Promise<ExportRow> {
  const body = pick(input, { kind: oneOf(...EXPORT_KINDS), price_list_version_id: uuid }, ['kind']);
  if (idempotencyKey !== undefined && !IMPORT_KEY_RE.test(idempotencyKey)) throw bad();
  return serverFetch<ExportRow>('/v1/catalog/exports', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey ?? randomUUID() }, body: JSON.stringify(body) });
}
