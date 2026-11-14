import 'server-only';
// E17 requestAgentCommand (POST /v1/instruments/agents/{agent_id}/commands, x-idempotency: required).
// reupload_since needs params.since within [now − 72 h, now].
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { COMMAND_KINDS, IDEMPOTENCY_KEY_RE, UUID_RE, type AgentCommand, type AgentCommandKind } from './types';

const MAX_REUPLOAD_MS = 72 * 3_600_000;

export async function requestAgentCommand(agentId: string, cmd: { kind: AgentCommandKind; since?: string }, idempotencyKey: string): Promise<AgentCommand> {
  const now = Date.now();
  const sinceMs = typeof cmd.since === 'string' ? Date.parse(cmd.since) : NaN;
  const ok =
    UUID_RE.test(agentId) &&
    typeof idempotencyKey === 'string' && IDEMPOTENCY_KEY_RE.test(idempotencyKey) &&
    COMMAND_KINDS.includes(cmd.kind) &&
    (cmd.kind === 'reupload_since' ? Number.isFinite(sinceMs) && sinceMs <= now && sinceMs >= now - MAX_REUPLOAD_MS : cmd.since === undefined);
  if (!ok) throw new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
  const body = cmd.kind === 'reupload_since' ? { kind: cmd.kind, params: { since: new Date(sinceMs).toISOString() } } : { kind: cmd.kind };
  return serverFetch<AgentCommand>(`/v1/instruments/agents/${agentId}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });
}
