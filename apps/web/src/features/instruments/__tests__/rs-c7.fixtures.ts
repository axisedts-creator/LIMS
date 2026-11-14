// RS-C7 shared synthetic fixtures (no real patient or lab data). Imported by the rs-c7.* tests only.
export const ORIGIN = 'http://api.test';
export const id = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
export const CENTRE = id(0xc01);
export const AGENT = id(0xd01);
export const READ = ['instruments.instrument.read', 'instruments.message.read', 'instruments.agent.read'];
export const MANAGE = [...READ, 'instruments.instrument.manage', 'instruments.agent.manage'];

export const driver = (o: Record<string, unknown> = {}) => ({
  code: 'astm_generic_e1394', display_name: 'Generic ASTM E1394', protocol: 'astm', status: 'generic', driver_version: '1.0.0', is_active: true,
  capabilities: { host_query: false, worklist_download: false, qc: true, attachments: false, calibration: false }, ...o,
});
export const DRIVERS = [driver(), driver({ code: 'astm_verified_x', display_name: 'Synthetic Verified Driver', status: 'verified', capabilities: { host_query: true, worklist_download: false, qc: true, attachments: false, calibration: false } })];
export const AGENTS_PICK = [{ id: AGENT, agent_code: 'SYN-AGENT-1', display_name: 'Synthetic bench PC', status: 'active' }];
export const CENTRES = [{ id: CENTRE, name: 'Synthetic Centre A1' }];

export const INST = id(0xe01);
export const summary = (o: Record<string, unknown> = {}) => ({
  id: INST, instrument_code: 'SIM-CHEM-1', display_name: 'Sim chem', vendor: 'Synthetic Vendor', model: 'SV-100', protocol: 'astm', agent_id: AGENT, agent_code: 'SYN-AGENT-1',
  centre_id: CENTRE, driver_code: 'astm_generic_e1394', driver_status: 'generic', state: 'draft', version: 4, link_state: 'up', last_message_at: '2026-11-07T03:58:00.000Z', unmapped_code_count: 3, ...o,
});
export const ROWS = [
  summary(),
  summary({ id: id(0xe02), instrument_code: 'SIM-CHEM-2', display_name: 'Verified chem', driver_status: 'verified', state: 'live', unmapped_code_count: 0 }),
  summary({ id: id(0xe03), instrument_code: 'SIM-HEM-1', display_name: 'Sketchy', driver_status: 'sketch_blocked', state: 'commissioning', unmapped_code_count: 12 }),
  summary({ id: id(0xe05), instrument_code: 'SIM-SUS-1', display_name: 'Paused', state: 'suspended', unmapped_code_count: 0, last_message_at: undefined }),
];
export const full = (o: Record<string, unknown> = {}) => ({
  ...summary(), driver_version: '1.0.0', transport: { kind: 'tcp_client', host: '10.0.0.7', port: 5000, connect_timeout_s: 10, reconnect_max_backoff_s: 60 }, protocol_options: {},
  capabilities: { host_query: false, worklist_download: false }, status: { link_state: 'up', last_message_at: '2026-11-07T03:58:00.000Z' }, ...o,
});
export const CHECKS = {
  manual_reference_confirmed: 'The official interface manual for this model and software version is on file',
  sample_comparison_done: 'Patient-sample comparison with the instrument printout is done',
  qc_comparison_done: 'QC values compared',
  mappings_reviewed: 'Code mappings reviewed',
} as const;

// ── agents (AgentsList is a guard: heartbeat + queue depth are agent data, the instrument summary has neither)
export const agentRow = (n: number, o: Record<string, unknown> = {}) => ({
  id: id(0xd00 + n), agent_code: `SYN-AGENT-${n}`, display_name: `Synthetic bench PC ${n}`, centre_id: CENTRE, status: 'active', update_channel: 'stable', version: 1, latest_config_version: 1,
  health: { state: 'online', last_heartbeat_at: '2026-11-07T03:59:00.000Z', agent_version: '1.4.2', queue_depth: 7, oldest_pending_age_seconds: 12, clock_offset_seconds: 2 }, ...o,
});

// ── messages
const latest = (o: Record<string, unknown> = {}) => ({ run_no: 1, kind: 'ingest', outcome: 'parsed', patient_records: 4, qc_records: 2, calibrator_records: 0, unmapped_records: 1, emitted_events: 5, ...o });
export const message = (n: number, o: Record<string, unknown> = {}) => ({
  id: id(0xa00 + n), instrument_id: INST, instrument_code: 'SIM-CHEM-1', agent_id: AGENT, centre_id: CENTRE, protocol: 'astm', message_kind: 'data',
  received_at: `2026-11-06T04:0${n}:00.000Z`, captured_at: '2026-11-06T04:00:00.000Z', size_bytes: 412, latest_run: latest(), ...o,
});
export const MESSAGES = [
  message(1),
  message(2, { message_kind: 'host_query', latest_run: latest({ outcome: 'shadow', patient_records: 0, qc_records: 0, unmapped_records: 0, emitted_events: 0 }) }),
  message(3, { latest_run: latest({ outcome: 'quarantined', unmapped_records: 3, emitted_events: 0 }) }),
];
export const REJECTIONS = [{ id: id(0xb01), received_at: '2026-11-06T05:00:00.000Z', agent_id: AGENT, claimed_instrument_id: id(0xe99), agent_message_id: 'syn-msg-1', reason_code: 'instruments.device_mismatch', size_bytes: 2048, raw_sha256: 'a'.repeat(64) }];
export const INSTRUMENT_PICK = [{ id: INST, instrument_code: 'SIM-CHEM-1' }];

/** Snapshot normaliser: react-aria / useId ids differ between runs; nothing else is touched. */
export const normalise = (root: HTMLElement) => root.innerHTML.replace(/react-aria[\w-]*:?[\w]*/g, 'ID').replace(/:r[0-9a-z]+:/g, 'ID').replace(/></g, '>\n<');
