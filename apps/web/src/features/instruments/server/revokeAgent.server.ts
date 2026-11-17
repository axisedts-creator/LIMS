import 'server-only';
// E15 revokeAgent (POST /v1/instruments/agents/{agent_id}/revoke, If-Match, reason from instruments.g_cs_revoke_reasons).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { reasonBody, type Agent, type ReasonInput } from './types';

export async function revokeAgent(agentId: string, version: number, reason: ReasonInput): Promise<Agent> {
  const body = reasonBody(agentId, version, reason);
  if (!body) throw new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
  return serverFetch<Agent>(`/v1/instruments/agents/${agentId}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'if-match': `"${version}"` },
    body: JSON.stringify(body),
  });
}
