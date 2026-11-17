import 'server-only';
// C3 #92 listInstrumentCodeMaps (GET /v1/catalog/instrument-code-maps?instrument_id=). Needs catalog.instrument_code_map.manage (D-39).
import { serverFetch } from '@/core/api/server-fetch';
import { CODE_MAP_MANAGE, DIRECTIONS, isUuid, type Direction, type InstrumentCodeMap } from './codeMaps';
import { badRequest, requirePermission } from './shared.server';
import type { Page } from './types';

export interface ListCodeMapsQuery { direction?: Direction; analyteId?: string; isActive?: boolean; cursor?: string }

export async function listInstrumentCodeMaps(instrumentId: string, q: ListCodeMapsQuery = {}): Promise<Page<InstrumentCodeMap>> {
  await requirePermission(CODE_MAP_MANAGE);
  const ok =
    isUuid(instrumentId) &&
    (q.direction === undefined || DIRECTIONS.includes(q.direction)) &&
    (q.analyteId === undefined || isUuid(q.analyteId)) &&
    (q.isActive === undefined || typeof q.isActive === 'boolean') &&
    (q.cursor === undefined || (typeof q.cursor === 'string' && q.cursor.length <= 512));
  if (!ok) throw badRequest();
  const p = new URLSearchParams({ instrument_id: instrumentId });
  if (q.direction) p.set('direction', q.direction);
  if (q.analyteId) p.set('analyte_id', q.analyteId);
  if (q.isActive !== undefined) p.set('is_active', String(q.isActive));
  if (q.cursor) p.set('cursor', q.cursor);
  return serverFetch<Page<InstrumentCodeMap>>(`/v1/catalog/instrument-code-maps?${p}`);
}
