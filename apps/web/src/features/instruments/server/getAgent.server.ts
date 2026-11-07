import 'server-only';
// E12 getAgent (GET /v1/instruments/agents/{agent_id}). Other-centre agents come back as 404 common.not_found (AC-16.2).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { UUID_RE, type Agent } from './types';

export async function getAgent(agentId: string): Promise<Agent> {
  if (!UUID_RE.test(agentId)) throw new ApiError(404, problem('common.not_found', 'Not found', 404));
  return serverFetch<Agent>(`/v1/instruments/agents/${agentId}`);
}
