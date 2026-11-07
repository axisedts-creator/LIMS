import 'server-only';
// E11 createAgent (POST /v1/instruments/agents, x-idempotency: required → fresh key per user submit).
import { randomUUID } from 'node:crypto';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { AGENT_CODE_RE, UPDATE_CHANNELS, UUID_RE, type Agent, type CreateAgentInput } from './types';

export async function createAgent(input: CreateAgentInput): Promise<Agent> {
  const { agent_code, display_name, centre_id, update_channel, backlog_threshold } = input;
  const ok =
    typeof agent_code === 'string' && AGENT_CODE_RE.test(agent_code) &&
    typeof display_name === 'string' && display_name.length >= 1 && display_name.length <= 80 &&
    typeof centre_id === 'string' && UUID_RE.test(centre_id) &&
    (update_channel === undefined || UPDATE_CHANNELS.includes(update_channel)) &&
    (backlog_threshold === undefined || (Number.isInteger(backlog_threshold) && backlog_threshold >= 10 && backlog_threshold <= 100000));
  if (!ok) throw new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
  const body: CreateAgentInput = {
    agent_code,
    display_name,
    centre_id,
    ...(update_channel !== undefined ? { update_channel } : {}),
    ...(backlog_threshold !== undefined ? { backlog_threshold } : {}),
  };
  return serverFetch<Agent>('/v1/instruments/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify(body),
  });
}
