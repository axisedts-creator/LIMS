import 'server-only';
// C3 #94 updateInstrumentCodeMap (PATCH /v1/catalog/instrument-code-maps/{id}, If-Match). Edit + deactivate ({is_active:false}).
// instrument_id / instrument_code / analyte_id / test_id / direction are immutable and never forwarded. Needs catalog.instrument_code_map.manage.
import { serverFetch } from '@/core/api/server-fetch';
import { CODE_MAP_MANAGE, patchBody, patchProblems, type CodeMapPatch, type InstrumentCodeMap } from './codeMaps';
import { JSON_HEADERS, badRequest, ifMatch, requirePermission } from './shared.server';

export async function updateInstrumentCodeMap(mapId: string, version: number, patch: CodeMapPatch): Promise<InstrumentCodeMap> {
  await requirePermission(CODE_MAP_MANAGE);
  const match = ifMatch(mapId, version);
  if (!patch || typeof patch !== 'object' || patchProblems(patch as Record<string, unknown>).length) throw badRequest();
  return serverFetch<InstrumentCodeMap>(`/v1/catalog/instrument-code-maps/${mapId}`, {
    method: 'PATCH',
    headers: { ...JSON_HEADERS, 'if-match': match },
    body: JSON.stringify(patchBody(patch as Record<string, unknown>)),
  });
}
