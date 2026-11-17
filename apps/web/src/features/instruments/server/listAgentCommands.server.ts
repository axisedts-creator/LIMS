import 'server-only';
// E18 listAgentCommands (GET /v1/instruments/agents/{agent_id}/commands); SCR-02 Commands & logs tab.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { UUID_RE, type AgentCommand, type Page } from './types';

export async function listAgentCommands(agentId: string, q: { limit?: number; cursor?: string } = {}): Promise<Page<AgentCommand>> {
  const limit = q.limit ?? 50;
  if (!UUID_RE.test(agentId) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
  const p = new URLSearchParams({ limit: String(limit) });
  if (q.cursor) p.set('cursor', q.cursor);
  return serverFetch<Page<AgentCommand>>(`/v1/instruments/agents/${agentId}/commands?${p}`);
}
