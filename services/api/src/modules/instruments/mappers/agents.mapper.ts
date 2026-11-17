// Row -> DTO for E10-E21 (02-TRD §7.4; contracts/openapi/instruments.yaml). Pure allowlists: a column not named here never reaches
// the wire, so secret_sha256 / host fingerprint / signatures / internal ids cannot leak (07-SECURITY S-06, REQ-SEC-080/081).
// No nulls on the wire: absent optionals are omitted.
type Row = Record<string, any>;
type Out = Record<string, unknown>;

const iso = (v: unknown): string => new Date(v as string).toISOString();
function put(o: Out, key: string, v: unknown, f: (x: any) => unknown = (x) => x): void {
  if (v !== null && v !== undefined) o[key] = f(v);
}
const putIso = (o: Out, key: string, v: unknown) => put(o, key, v, iso);
const seconds = (ms: unknown) => Math.round(Number(ms) / 1000);

/** Pending agents have no agent_status row yet: state offline, counters 0. */
const NO_STATUS: Row = { health_state: 'offline', health_version: 1, queue_depth: 0, oldest_pending_age_seconds: 0, queue_rejected: 0, queue_oversize: 0 };

function health(s: Row | null | undefined): Out {
  const h = s ?? NO_STATUS;
  const o: Out = {
    state: h['health_state'], health_version: h['health_version'], queue_depth: h['queue_depth'], oldest_pending_age_seconds: h['oldest_pending_age_seconds'],
    queue_rejected: h['queue_rejected'] ?? 0, queue_oversize: h['queue_oversize'] ?? 0,
  };
  putIso(o, 'last_heartbeat_at', h['last_heartbeat_at']);
  for (const k of ['agent_version', 'launcher_version', 'os_version', 'disk_free_mb']) put(o, k, h[k]);
  put(o, 'clock_offset_seconds', h['clock_offset_ms'], seconds);
  for (const k of ['clock_offset_ms', 'clock_offset_uncertainty_ms', 'config_version_applied', 'config_state', 'update_state', 'update_target_version', 'auth_state', 'last_ip']) put(o, k, h[k]);
  putIso(o, 'last_ip_changed_at', h['last_ip_changed_at']);
  return o;
}
function summaryHealth(s: Row | null | undefined): Out {
  const h = s ?? NO_STATUS;
  const o: Out = { state: h['health_state'], queue_depth: h['queue_depth'], oldest_pending_age_seconds: h['oldest_pending_age_seconds'] };
  putIso(o, 'last_heartbeat_at', h['last_heartbeat_at']);
  put(o, 'agent_version', h['agent_version']);
  put(o, 'clock_offset_seconds', h['clock_offset_ms'], seconds);
  put(o, 'config_state', h['config_state']);
  put(o, 'update_state', h['update_state']);
  return o;
}

export function toAgentCredential(r: Row): Out {
  const o: Out = { credential_id: r['id'], kind: r['kind'], status: r['status'], issued_at: iso(r['issued_at']), issued_by_display: r['issued_by_display'] };
  for (const k of ['expires_at', 'used_at', 'last_used_at', 'revoked_at']) putIso(o, k, r[k]);
  return o;
}

export function toAgent(r: Row): Out {
  const o: Out = {
    id: r['id'], agent_code: r['agent_code'], display_name: r['display_name'], centre_id: r['centre_id'], status: r['status'],
    update_channel: r['update_channel'], backlog_threshold: r['backlog_threshold'], version: r['version'],
  };
  put(o, 'pinned_release_id', r['pinned_release_id']);
  for (const k of ['enrolled_at', 'revoked_at', 'retired_at']) putIso(o, k, r[k]);
  put(o, 'revoke_reason_code', r['revoke_reason_code']);
  o['health'] = health(r['health']);
  o['latest_config_version'] = r['latest_config_version'];
  o['credentials'] = ((r['credentials'] ?? []) as Row[]).slice(0, 100).map(toAgentCredential);
  return o;
}

export function toAgentSummary(r: Row): Out {
  return {
    id: r['id'], agent_code: r['agent_code'], display_name: r['display_name'], centre_id: r['centre_id'], status: r['status'],
    update_channel: r['update_channel'], version: r['version'], latest_config_version: r['latest_config_version'], health: summaryHealth(r['health']),
  };
}

export function toAgentCommand(r: Row): Out {
  const params: Out = {};
  put(params, 'since', r['params']?.['since'], iso);
  const o: Out = {
    command_id: r['id'], agent_id: r['agent_id'], kind: r['kind'], params, state: r['state'], requested_at: iso(r['requested_at']),
    requested_by_display: r['requested_by_display'], expires_at: iso(r['expires_at']),
  };
  putIso(o, 'delivered_at', r['delivered_at']);
  putIso(o, 'completed_at', r['completed_at']);
  put(o, 'result_code', r['result_code']);
  put(o, 'log_bundle_id', r['log_bundle_id']);
  return o;
}

export function toHealthTransition(r: Row): Out {
  const o: Out = { health_version: r['health_version'], to_state: r['to_state'], changed_at: iso(r['changed_at']), queue_depth: r['queue_depth'] };
  put(o, 'from_state', r['from_state']);
  putIso(o, 'last_heartbeat_at', r['last_heartbeat_at']);
  put(o, 'clock_offset_seconds', r['clock_offset_seconds']);
  o['silent_instrument_ids'] = ((r['silent_instrument_ids'] ?? []) as string[]).slice(0, 50);
  return o;
}

export function toAgentRelease(r: Row): Out {
  const o: Out = { id: r['id'], version: r['version'], channel: r['channel'], released_at: iso(r['released_at']), package_size: Number(r['package_size']), is_active: r['is_active'] };
  put(o, 'min_windows_build', r['min_windows_build']);
  put(o, 'notes', r['notes']);
  return o;
}

export function toLogBundle(r: Row): Out {
  return { bundle_id: r['id'], lines: [...(r['lines'] ?? [])], from_at_agent: iso(r['from_at_agent']), to_at_agent: iso(r['to_at_agent']), created_at: iso(r['created_at']) };
}
