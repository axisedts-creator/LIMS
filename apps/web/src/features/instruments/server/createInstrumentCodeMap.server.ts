import 'server-only';
// C3 #93 createInstrumentCodeMap (POST /v1/catalog/instrument-code-maps, Idempotency-Key). Needs catalog.instrument_code_map.manage (D-39).
import { serverFetch } from '@/core/api/server-fetch';
import { CODE_MAP_MANAGE, codeMapProblems, createBody, type CodeMapCreate, type InstrumentCodeMap } from './codeMaps';
import { JSON_HEADERS, badRequest, idemKey, requirePermission } from './shared.server';

export async function createInstrumentCodeMap(input: CodeMapCreate, idempotencyKey: string): Promise<InstrumentCodeMap> {
  await requirePermission(CODE_MAP_MANAGE);
  const key = idemKey(idempotencyKey);
  if (!input || typeof input !== 'object' || codeMapProblems(input as unknown as Record<string, unknown>, true).length) throw badRequest();
  return serverFetch<InstrumentCodeMap>('/v1/catalog/instrument-code-maps', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'idempotency-key': key },
    body: JSON.stringify(createBody(input as unknown as Record<string, unknown>)),
  });
}
