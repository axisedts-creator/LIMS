import 'server-only';
// E13 updateAgent (PATCH /v1/instruments/agents/{agent_id}, If-Match). Only the fields the Edit dialog offers.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { UPDATE_CHANNELS, UUID_RE, type Agent, type UpdateAgentInput } from './types';

export async function updateAgent(agentId: string, version: number, input: UpdateAgentInput): Promise<Agent> {
  const { display_name, update_channel, backlog_threshold } = input;
  const ok =
    UUID_RE.test(agentId) && Number.isInteger(version) && version >= 1 &&
    (display_name === undefined || (typeof display_name === 'string' && display_name.length >= 1 && display_name.length <= 80)) &&
    (update_channel === undefined || UPDATE_CHANNELS.includes(update_channel)) &&
    (backlog_threshold === undefined || (Number.isInteger(backlog_threshold) && backlog_threshold >= 10 && backlog_threshold <= 100000));
  if (!ok) throw new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
  const body: UpdateAgentInput = {
    ...(display_name !== undefined ? { display_name } : {}),
    ...(update_channel !== undefined ? { update_channel } : {}),
    ...(backlog_threshold !== undefined ? { backlog_threshold } : {}),
  };
  return serverFetch<Agent>(`/v1/instruments/agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'if-match': `"${version}"` },
    body: JSON.stringify(body),
  });
}
