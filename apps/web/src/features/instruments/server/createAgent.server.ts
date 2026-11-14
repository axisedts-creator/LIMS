import 'server-only';
// E11 createAgent (POST /v1/instruments/agents, x-idempotency: required). The dialog mints one key per open and passes it
// on every submit of that dialog, so a retry is deduplicated by the API (02-CONVENTIONS §4.5).
import { randomUUID } from 'node:crypto';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { AGENT_CODE_RE, IDEMPOTENCY_KEY_RE, UPDATE_CHANNELS, UUID_RE, type Agent, type CreateAgentInput } from './types';

export async function createAgent(input: CreateAgentInput, idempotencyKey?: string): Promise<Agent> {
  const { agent_code, display_name, centre_id, update_channel, backlog_threshold } = input;
  const ok =
    typeof agent_code === 'string' && AGENT_CODE_RE.test(agent_code) &&
    typeof display_name === 'string' && display_name.length >= 1 && display_name.length <= 80 &&
    typeof centre_id === 'string' && UUID_RE.test(centre_id) &&
    (update_channel === undefined || UPDATE_CHANNELS.includes(update_channel)) &&
    (backlog_threshold === undefined || (Number.isInteger(backlog_threshold) && backlog_threshold >= 10 && backlog_threshold <= 100000)) &&
    (idempotencyKey === undefined || (typeof idempotencyKey === 'string' && IDEMPOTENCY_KEY_RE.test(idempotencyKey)));
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
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey ?? randomUUID() },
    body: JSON.stringify(body),
  });
}
