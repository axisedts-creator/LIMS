import 'server-only';
// E19 listAgentHealthTransitions (GET /v1/instruments/agents/{agent_id}/health-transitions); SCR-02 shows the last 50.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { UUID_RE, type HealthTransition, type Page } from './types';

export async function listAgentHealthTransitions(agentId: string, q: { limit?: number; cursor?: string } = {}): Promise<Page<HealthTransition>> {
  const limit = q.limit ?? 50;
  if (!UUID_RE.test(agentId) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
  const p = new URLSearchParams({ limit: String(limit) });
  if (q.cursor) p.set('cursor', q.cursor);
  return serverFetch<Page<HealthTransition>>(`/v1/instruments/agents/${agentId}/health-transitions?${p}`);
}
