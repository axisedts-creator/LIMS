import 'server-only';
// E20 getAgentLogBundle (GET /v1/instruments/agents/{agent_id}/log-bundles/{bundle_id}); SCR-02 Commands & logs "View log".
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { UUID_RE, type AgentLogBundle } from './types';

export async function getAgentLogBundle(agentId: string, bundleId: string): Promise<AgentLogBundle> {
  if (!UUID_RE.test(agentId) || !UUID_RE.test(bundleId)) throw new ApiError(404, problem('common.not_found', 'Not found', 404));
  return serverFetch<AgentLogBundle>(`/v1/instruments/agents/${agentId}/log-bundles/${bundleId}`);
}
