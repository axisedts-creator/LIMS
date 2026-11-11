// Row -> DTO for E22-E32, E40 (02-TRD §7.4; contracts/openapi/instruments.yaml). Pure allowlists: a column not named here never reaches the wire
// (tenant_id, created_by, updated_*, is_active, cap_* columns, evidence_note inside the stored checklist). No nulls on the wire: absent optionals are omitted.
type Row = Record<string, any>;
type Out = Record<string, unknown>;

const iso = (v: unknown): string => new Date(v as string).toISOString();
function put(o: Out, key: string, v: unknown, f: (x: any) => unknown = (x) => x): void {
  if (v !== null && v !== undefined) o[key] = f(v);
}
const hhmm = (v: unknown): string => String(v).slice(0, 5);   // the DB may hand back HH:MM:SS
const CHECKLIST = ['manual_reference_confirmed', 'sample_comparison_done', 'qc_comparison_done', 'mappings_reviewed'] as const;
const nonEmpty = (v: unknown) => v !== null && typeof v === 'object' && Object.keys(v as object).length > 0;

export function toDriver(r: Row): Out {
  const o: Out = {
    code: r['code'], display_name: r['display_name'], protocol: r['protocol'], status: r['status'], driver_version: r['driver_version'],
    capabilities: {
      host_query: r['cap_host_query'], worklist_download: r['cap_worklist_download'], qc: r['cap_qc'], attachments: r['cap_attachments'], calibration: r['cap_calibration'],
    },
    is_active: r['is_active'],
  };
  put(o, 'vendor', r['vendor']);
  put(o, 'model_pattern', r['model_pattern']);
  if (r['manual_title'] && r['manual_document_id'] && r['manual_revision']) {   // schema: all three or no `manual`
    const m: Out = { title: r['manual_title'], document_id: r['manual_document_id'], revision: r['manual_revision'] };
    put(m, 'software_version', r['manual_software_version']);
    o['manual'] = m;
  }
  return o;
}

/** `driver` = the g_drivers row of r.driver_code (status / version are not instrument columns). */
export function toInstrument(r: Row, driver: Row): Out {
  const o: Out = {
    id: r['id'], centre_id: r['centre_id'], instrument_code: r['instrument_code'], display_name: r['display_name'], agent_id: r['agent_id'], vendor: r['vendor'], model: r['model'],
    protocol: r['protocol'], driver_code: r['driver_code'], transport: r['transport'],
    capabilities: { host_query: r['cap_host_query'], worklist_download: r['cap_worklist_download'] },
    state: r['state'], driver_status: driver['status'], driver_version: driver['driver_version'], version: r['version'],
  };
  for (const k of ['serial_no', 'software_version', 'timezone', 'silence_window_minutes']) put(o, k, r[k]);
  for (const k of ['silence_active_from', 'silence_active_to']) put(o, k, r[k], hhmm);
  if (nonEmpty(r['protocol_options'])) o['protocol_options'] = r['protocol_options'];
  if (nonEmpty(r['parser_options'])) o['parser_options'] = r['parser_options'];
  put(o, 'file_drop', r['file_drop']);
  if (Array.isArray(r['qc_sample_id_patterns']) && r['qc_sample_id_patterns'].length > 0) o['qc_sample_id_patterns'] = r['qc_sample_id_patterns'];
  for (const k of ['commissioned_at', 'live_at', 'suspended_at', 'retired_at']) put(o, k, r[k], iso);
  put(o, 'live_by_display', r['live_by_display']);
  put(o, 'go_live_checklist', r['go_live_checklist'], (c) => Object.fromEntries(CHECKLIST.map((k) => [k, c[k] === true])));   // evidence_note stays server-side
  const st: Out = {};
  put(st, 'link_state', r['link_state']);
  for (const k of ['last_message_at', 'last_message_at_agent', 'silent_since']) put(st, k, r[k], iso);
  put(st, 'last_link_error_code', r['last_link_error_code']);
  put(st, 'instrument_clock_offset_seconds', r['instrument_clock_offset_seconds']);
  o['status'] = st;
  return o;
}

export function toInstrumentSummary(r: Row, driver: Row): Out {
  const o: Out = {
    id: r['id'], instrument_code: r['instrument_code'], display_name: r['display_name'], vendor: r['vendor'], model: r['model'], protocol: r['protocol'],
    agent_id: r['agent_id'], agent_code: r['agent_code'], centre_id: r['centre_id'], driver_code: r['driver_code'], driver_status: driver['status'],
    state: r['state'], version: r['version'], unmapped_code_count: Number(r['unmapped_code_count'] ?? 0),
  };
  put(o, 'link_state', r['link_state']);
  put(o, 'last_message_at', r['last_message_at'], iso);
  return o;
}

export function toObservedCode(r: Row): Out {
  const o: Out = {
    instrument_id: r['instrument_id'], record_class: r['record_class'], instrument_analyte_code: r['instrument_analyte_code'], first_seen_at: iso(r['first_seen_at']),
    last_seen_at: iso(r['last_seen_at']), seen_count: Number(r['seen_count']), last_mapping_status: r['last_mapping_status'],
    last_mapping_checked_at: iso(r['last_mapping_checked_at']),
  };
  put(o, 'last_analyte_id', r['last_analyte_id']);
  return o;
}

export function toSettings(r: Row): Out {
  const o: Out = {
    default_backlog_threshold: r['default_backlog_threshold'], backlog_max_oldest_pending_seconds: r['backlog_max_oldest_pending_seconds'],
    clock_offset_warn_seconds: r['clock_offset_warn_seconds'], agent_uploaded_retention_hours: r['agent_uploaded_retention_hours'],
  };
  for (const k of ['update_window_from', 'update_window_to']) put(o, k, r[k], hhmm);
  o['version'] = r['version'];
  return o;
}
