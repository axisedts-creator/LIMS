// DTOs mirrored from contracts/openapi/instruments.yaml (AgentSummary, Agent, AgentHealth, AgentCredential, HealthTransition,
// InstrumentSummary). [CONV] hand-mirrored: apps/web has no generated client yet — replace with generated types when it lands.
// Type-only + pure validators: safe to import from client components (no server-only, no secrets).
import { PROTOCOLS, type Protocol } from '../forms/transport';
import type { InstrumentBody } from '../forms/instrument';

export const AGENT_STATUSES =['pending_enrolment', 'active', 'revoked', 'retired'] as const;
export const HEALTH_STATES = ['online', 'offline', 'backlog', 'degraded'] as const;
export const AGENT_SORTS = ['agent_code', '-last_heartbeat_at'] as const;
export const UPDATE_CHANNELS = ['stable', 'beta'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type HealthState = (typeof HEALTH_STATES)[number];
export type AgentSort = (typeof AGENT_SORTS)[number];
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

// 04-UI-UX SCR-01: default Status filter = all except retired; default sort agent code.
export const DEFAULT_AGENT_STATUSES: readonly AgentStatus[] = ['pending_enrolment', 'active', 'revoked'];

type Sp = Readonly<Record<string, string | readonly string[] | undefined>>;
const csv = (v: Sp[string]) => (v === undefined ? [] : (typeof v === 'string' ? [v] : v).flatMap((x) => x.split(',')));
const pick = <T extends string>(v: Sp[string], allowed: readonly T[]) => [...new Set(csv(v).filter((x): x is T => (allowed as readonly string[]).includes(x)))];

/** SCR-01 URL query → E10 filters. Unknown values are dropped, so tampered input never reaches the API. */
export function parseAgentQuery(sp: Sp): { centreId?: string; status: AgentStatus[]; healthState: HealthState[]; sort: AgentSort } {
  const status = pick(sp.status, AGENT_STATUSES);
  const centre = csv(sp.centre_id)[0];
  const sort = pick(sp.sort, AGENT_SORTS)[0] ?? 'agent_code';
  return {
    ...(centre && UUID_RE.test(centre) ? { centreId: centre } : {}),
    status: status.length ? status : [...DEFAULT_AGENT_STATUSES],
    healthState: pick(sp.health_state, HEALTH_STATES),
    sort,
  };
}

export const COMMAND_KINDS =['upload_logs', 'refresh_config', 'restart_service', 'reupload_since'] as const;
export type AgentCommandKind = (typeof COMMAND_KINDS)[number];
// instruments.g_cs_revoke_reasons seed (05-SCHEMA §2, [CONV] codes). Displays [CONV]: no coded-set read API in apps/web yet.
export const REVOKE_REASONS = [
  { code: 'device_replaced', display: 'Device replaced' },
  { code: 'device_lost_or_stolen', display: 'Device lost or stolen' },
  { code: 'suspected_compromise', display: 'Suspected compromise' },
  { code: 'decommissioned', display: 'Decommissioned' },
  { code: 'staff_error', display: 'Staff error' },
  { code: 'other', display: 'Other' },
] as const;

export const AGENT_CODE_RE = /^[A-Z0-9-]{2,32}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

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

export const INSTRUMENT_STATES = ['draft', 'commissioning', 'live', 'suspended', 'retired'] as const;
export type InstrumentState = (typeof INSTRUMENT_STATES)[number];
export const DRIVER_STATUSES = ['generic', 'verified', 'sketch_blocked'] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];
export const INSTRUMENT_SORTS = ['instrument_code', '-last_message_at'] as const;
export type InstrumentSort = (typeof INSTRUMENT_SORTS)[number];
export { PROTOCOLS };
export type { Protocol };

// 04-UI-UX SCR-05: default State filter = all except retired; default sort instrument code.
export const DEFAULT_INSTRUMENT_STATES: readonly InstrumentState[] = ['draft', 'commissioning', 'live', 'suspended'];

/** SCR-05 URL query → E23 filters. Unknown values are dropped, so tampered input never reaches the API. */
export function parseInstrumentQuery(sp: Sp): { centreId?: string; agentId?: string; state: InstrumentState[]; protocol?: Protocol; sort: InstrumentSort } {
  const state = pick(sp.state, INSTRUMENT_STATES);
  const centre = csv(sp.centre_id)[0];
  const agent = csv(sp.agent_id)[0];
  const protocol = pick(sp.protocol, PROTOCOLS)[0];
  return {
    ...(centre && UUID_RE.test(centre) ? { centreId: centre } : {}),
    ...(agent && UUID_RE.test(agent) ? { agentId: agent } : {}),
    state: state.length ? state : [...DEFAULT_INSTRUMENT_STATES],
    ...(protocol ? { protocol } : {}),
    sort: pick(sp.sort, INSTRUMENT_SORTS)[0] ?? 'instrument_code',
  };
}

export interface InstrumentSummary {
  id: string;
  instrument_code: string;
  display_name: string;
  state: string;
  vendor?: string;
  model?: string;
  protocol?: Protocol;
  agent_id?: string;
  agent_code?: string;
  centre_id?: string;
  driver_code?: string;
  driver_status?: DriverStatus;
  version?: number;
  unmapped_code_count?: number;
  link_state?: string;
  last_message_at?: string;
  // Not in contracts InstrumentSummary yet (only Instrument.status has them) — CR in .orchestra/cr/WEB-T02.md.
  last_link_error_code?: string;
  silent_since?: string;
}

export interface AgentCommand {
  command_id: string;
  agent_id: string;
  kind: AgentCommandKind;
  params?: { since?: string };
  state: 'queued' | 'delivered' | 'completed' | 'failed' | 'expired';
  requested_at: string;
  requested_by_display: string;
  delivered_at?: string;
  completed_at?: string;
  result_code?: string;
  expires_at: string;
  log_bundle_id?: string;
}

export interface AgentLogBundle { bundle_id: string; lines: string[]; from_at_agent: string; to_at_agent: string; created_at: string }

export interface UpdateAgentInput { display_name?: string; update_channel?: UpdateChannel; backlog_threshold?: number }

export interface ReasonInput { reason_code: string; reason_text?: string }
/** Validated E15/E16 body, or null. */
export function reasonBody(agentId: string, version: number, r: ReasonInput): ReasonInput | null {
  const ok =
    UUID_RE.test(agentId) && Number.isInteger(version) && version >= 1 &&
    REVOKE_REASONS.some((x) => x.code === r?.reason_code) &&
    (r.reason_text === undefined || (typeof r.reason_text === 'string' && r.reason_text.length <= 300));
  return ok ? { reason_code: r.reason_code, ...(r.reason_text ? { reason_text: r.reason_text } : {}) } : null;
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

export interface FieldProblemDto { path?: string; code?: string; message?: string }

/** Server-action result: ApiError cannot cross the action boundary (Next strips messages), so the code travels as data.
 *  `errors` carries the problem+json errors[] (JSON Pointer paths) for field mapping (WEB-T03). */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; errors?: FieldProblemDto[] };

export interface Driver {
  code: string;
  display_name: string;
  protocol: Protocol;
  vendor?: string;
  model_pattern?: string;
  status: DriverStatus;
  driver_version: string;
  manual?: { title: string; document_id?: string; version?: string };
  is_active: boolean;
  capabilities: { host_query: boolean; worklist_download: boolean; qc: boolean; attachments: boolean; calibration: boolean };
}

export interface GoLiveChecklist { manual_reference_confirmed: boolean; sample_comparison_done: boolean; qc_comparison_done: boolean; mappings_reviewed: boolean }
export const GO_LIVE_CHECKLIST_KEYS = ['manual_reference_confirmed', 'sample_comparison_done', 'qc_comparison_done', 'mappings_reviewed'] as const;

/** E25 Instrument (contracts `Instrument`). */
export interface Instrument extends InstrumentBody {
  id: string;
  centre_id: string;
  instrument_code: string;
  display_name: string;
  agent_id: string;
  vendor: string;
  model: string;
  state: InstrumentState;
  driver_status: DriverStatus;
  driver_version: string;
  version: number;
  commissioned_at?: string;
  live_at?: string;
  live_by_display?: string;
  go_live_checklist?: GoLiveChecklist;
  suspended_at?: string;
  retired_at?: string;
  status?: { link_state?: string; last_message_at?: string; last_message_at_agent?: string; last_link_error_code?: string; instrument_clock_offset_seconds?: number; silent_since?: string };
}

/** E40/E41 InstrumentSettings (02-TRD §7.4). `version` is read-only: it travels as If-Match only. update_window_* are both set or both absent. */
export interface InstrumentSettingsBody {
  default_backlog_threshold: number;
  backlog_max_oldest_pending_seconds: number;
  clock_offset_warn_seconds: number;
  agent_uploaded_retention_hours: number;
  update_window_from?: string;
  update_window_to?: string;
}
export interface InstrumentSettings extends InstrumentSettingsBody { version: number }
