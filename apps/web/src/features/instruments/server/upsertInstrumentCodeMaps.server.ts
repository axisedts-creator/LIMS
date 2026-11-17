import 'server-only';
// C3 #95 upsertInstrumentCodeMaps (POST /v1/catalog/instrument-code-maps/bulk-upsert, Idempotency-Key) — "Copy from instrument…".
// Rows carry only the create keys; the envelope instrument_id is the only target. Needs catalog.instrument_code_map.manage.
import { serverFetch } from '@/core/api/server-fetch';
import { BULK_MAX, CODE_MAP_MANAGE, codeMapProblems, isUuid, rowBody, type CodeMapFields, type CodeMapResult } from './codeMaps';
import { JSON_HEADERS, badRequest, idemKey, requirePermission } from './shared.server';

export async function upsertInstrumentCodeMaps(instrumentId: string, maps: readonly CodeMapFields[], idempotencyKey: string): Promise<{ results: CodeMapResult[] }> {
  await requirePermission(CODE_MAP_MANAGE);
  const key = idemKey(idempotencyKey);
  const ok =
    isUuid(instrumentId) && Array.isArray(maps) && maps.length >= 1 && maps.length <= BULK_MAX &&
    maps.every((m) => m && typeof m === 'object' && !codeMapProblems(m as unknown as Record<string, unknown>, false).length);
  if (!ok) throw badRequest();
  return serverFetch<{ results: CodeMapResult[] }>('/v1/catalog/instrument-code-maps/bulk-upsert', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'idempotency-key': key },
    body: JSON.stringify({ instrument_id: instrumentId, maps: maps.map((m) => rowBody(m as unknown as Record<string, unknown>)) }),
  });
}
