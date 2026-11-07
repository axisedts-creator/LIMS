import 'server-only';
// E21 listInstruments (GET /v1/instruments/instruments?agent_id=); feeds the SCR-02 Instruments tab.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { UUID_RE, type InstrumentSummary, type Page } from './types';

export async function listInstruments(q: { agentId: string; limit?: number; cursor?: string }): Promise<Page<InstrumentSummary>> {
  const limit = q.limit ?? 50;
  if (!UUID_RE.test(q.agentId) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
  const p = new URLSearchParams({ agent_id: q.agentId, limit: String(limit) });
  if (q.cursor) p.set('cursor', q.cursor);
  return serverFetch<Page<InstrumentSummary>>(`/v1/instruments/instruments?${p}`);
}
