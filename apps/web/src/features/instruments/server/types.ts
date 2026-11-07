// DTOs mirrored from contracts/openapi/instruments.yaml (AgentSummary, Agent, AgentHealth, AgentCredential, HealthTransition,
// InstrumentSummary). [CONV] hand-mirrored: apps/web has no generated client yet — replace with generated types when it lands.
// Type-only + pure validators: safe to import from client components (no server-only, no secrets).
export const AGENT_STATUSES = ['pending_enrolment', 'active', 'revoked', 'retired'] as const;
export const HEALTH_STATES = ['online', 'offline', 'backlog', 'degraded'] as const;
export const AGENT_SORTS = ['agent_code', '-last_heartbeat_at'] as const;
export const UPDATE_CHANNELS = ['stable', 'beta'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type HealthState = (typeof HEALTH_STATES)[number];
export type AgentSort = (typeof AGENT_SORTS)[number];
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const AGENT_CODE_RE = /^[A-Z0-9-]{2,32}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AgentHealth {
  state: HealthState;
  health_version?: number;
  last_heartbeat_at?: string;
  agent_version?: string;
  launcher_version?: string;
  os_version?: string;
  queue_depth: number;
  oldest_pending_age_seconds: number;
  queue_rejected?: number;
  queue_oversize?: number;
  disk_free_mb?: number;
  clock_offset_seconds?: number;
  clock_offset_ms?: number;
  clock_offset_uncertainty_ms?: number;
  config_version_applied?: number;
  config_state?: 'ok' | 'signature_invalid' | 'agent_mismatch' | 'rollback_rejected' | 'schema_invalid';
  update_state?: string;
  update_target_version?: string;
  auth_state?: 'ok' | 'rejected';
  last_ip?: string;
  last_ip_changed_at?: string;
}

export interface AgentSummary {
  id: string;
  agent_code: string;
  display_name: string;
  centre_id: string;
  status: AgentStatus;
  update_channel: UpdateChannel;
  version: number;
  latest_config_version: number;
  health: AgentHealth;
}

export interface AgentCredential {
  credential_id: string;
  kind: 'enrolment_code' | 'device_token';
  status: 'active' | 'used' | 'expired' | 'revoked';
  issued_at: string;
  issued_by_display: string;
  expires_at?: string;
  used_at?: string;
  last_used_at?: string;
  revoked_at?: string;
}

export interface Agent extends AgentSummary {
  backlog_threshold: number;
  pinned_release_id?: string;
  enrolled_at?: string;
  revoked_at?: string;
  revoke_reason_code?: string;
  retired_at?: string;
  credentials: AgentCredential[];
}

export interface HealthTransition {
  health_version: number;
  from_state?: HealthState;
  to_state: HealthState;
  changed_at: string;
  last_heartbeat_at?: string;
  queue_depth: number;
  clock_offset_seconds?: number;
  silent_instrument_ids: string[];
}

export interface InstrumentSummary {
  id: string;
  instrument_code: string;
  display_name: string;
  state: string;
  link_state?: string;
  last_message_at?: string;
}

export interface PageInfo { limit: number; next_cursor?: string; prev_cursor?: string }
export interface Page<T> { data: T[]; page: PageInfo }

export interface CreateAgentInput {
  agent_code: string;
  display_name: string;
  centre_id: string;
  update_channel?: UpdateChannel;
  backlog_threshold?: number;
}

export interface EnrolmentCodeIssued { enrolment_code: string; expires_at: string; credential_id: string }

/** Server-action result: ApiError cannot cross the action boundary (Next strips messages), so the code travels as data. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };
