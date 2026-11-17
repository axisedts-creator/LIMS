import 'server-only';
// E10 listAgents (GET /v1/instruments/agents). Enum filters are checked here so tampered input never reaches the API.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { AGENT_SORTS, AGENT_STATUSES, HEALTH_STATES, UUID_RE, type AgentSort, type AgentStatus, type AgentSummary, type HealthState, type Page } from './types';

export interface ListAgentsQuery {
  centreId?: string;
  status?: readonly AgentStatus[];
  healthState?: readonly HealthState[];
  sort?: AgentSort;
  cursor?: string;
  limit?: number;
}

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const allIn = (xs: readonly string[], allowed: readonly string[]) => xs.length <= allowed.length && xs.every((x) => allowed.includes(x));

export async function listAgents(q: ListAgentsQuery = {}): Promise<Page<AgentSummary>> {
  const p = new URLSearchParams();
  if (q.centreId !== undefined) {
    if (!UUID_RE.test(q.centreId)) throw bad();
    p.set('centre_id', q.centreId);
  }
  if (q.status?.length) {
    if (!allIn(q.status, AGENT_STATUSES)) throw bad();
    p.set('status', q.status.join(','));
  }
  if (q.healthState?.length) {
    if (!allIn(q.healthState, HEALTH_STATES)) throw bad();
    p.set('health_state', q.healthState.join(','));
  }
  if (q.sort !== undefined) {
    if (!AGENT_SORTS.includes(q.sort)) throw bad();
    p.set('sort', q.sort);
  }
  if (q.cursor) p.set('cursor', q.cursor);
  if (q.limit !== undefined) {
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 200) throw bad();
    p.set('limit', String(q.limit));
  }
  const qs = p.toString();
  return serverFetch<Page<AgentSummary>>(`/v1/instruments/agents${qs ? `?${qs}` : ''}`);
}
