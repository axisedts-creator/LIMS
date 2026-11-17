import 'server-only';
// E21/E23 listInstruments (GET /v1/instruments/instruments); E21 = by agent (SCR-02 Instruments tab), E23 = filtered list (SCR-05).
import { serverFetch } from '@/core/api/server-fetch';
import { badRequest } from './shared.server';
import { INSTRUMENT_SORTS, INSTRUMENT_STATES, PROTOCOLS, UUID_RE, type InstrumentSort, type InstrumentState, type InstrumentSummary, type Page, type Protocol } from './types';

export interface ListInstrumentsQuery {
  agentId?: string;
  centreId?: string;
  state?: readonly InstrumentState[];
  protocol?: Protocol;
  sort?: InstrumentSort;
  limit?: number;
  cursor?: string;
}

const oneOf = (list: readonly string[], v: unknown) => typeof v === 'string' && list.includes(v);

export async function listInstruments(q: ListInstrumentsQuery = {}): Promise<Page<InstrumentSummary>> {
  const limit = q.limit ?? 50;
  const ok =
    (q.agentId === undefined || (typeof q.agentId === 'string' && UUID_RE.test(q.agentId))) &&
    (q.centreId === undefined || (typeof q.centreId === 'string' && UUID_RE.test(q.centreId))) &&
    (q.state === undefined || (Array.isArray(q.state) && q.state.every((s) => oneOf(INSTRUMENT_STATES, s)))) &&
    (q.protocol === undefined || oneOf(PROTOCOLS, q.protocol)) &&
    (q.sort === undefined || oneOf(INSTRUMENT_SORTS, q.sort)) &&
    Number.isInteger(limit) && limit >= 1 && limit <= 200;
  if (!ok) throw badRequest();
  const p = new URLSearchParams({ limit: String(limit) });
  if (q.agentId) p.set('agent_id', q.agentId);
  if (q.centreId) p.set('centre_id', q.centreId);
  if (q.state?.length) p.set('state', q.state.join(','));
  if (q.protocol) p.set('protocol', q.protocol);
  if (q.sort) p.set('sort', q.sort);
  if (q.cursor) p.set('cursor', q.cursor);
  return serverFetch<Page<InstrumentSummary>>(`/v1/instruments/instruments?${p}`);
}
