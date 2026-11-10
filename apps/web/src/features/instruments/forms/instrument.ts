// InstrumentCreate / InstrumentUpdate rules (contracts/openapi/instruments.yaml), shared by the SCR-06 form and the BFF server
// functions so both sides reject the same input. Pure; issues carry JSON Pointers ('/vendor', '/transport/port').
import { PROTOCOLS, TRANSPORT_KINDS_BY_PROTOCOL, int, isObj, normalizeFileDrop, normalizeTransport, str, validateFileDrop, validateTransport, type Issue, type Protocol } from './transport';

export const INSTRUMENT_CODE_RE = /^[A-Z0-9-]{2,32}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const ACK_APP_RE = /^[A-Z0-9_]+$/;

/** 02-TRD §5.2.4 ASTM timers/counters: [default, min, max]. Defaults are [CONV] configurable (08 A13 D-41). */
export const ASTM_OPTIONS = [
  ['establish_reply_s', 'Establish reply timeout (s)', 15, 1, 300],
  ['nak_retry_delay_s', 'NAK retry delay (s)', 10, 1, 300],
  ['host_contention_defer_s', 'Host contention defer (s)', 20, 1, 300],
  ['instrument_contention_retry_s', 'Instrument contention retry (s)', 1, 1, 300],
  ['transfer_reply_s', 'Transfer reply timeout (s)', 15, 1, 300],
  ['receiver_frame_wait_s', 'Receiver frame wait (s)', 30, 1, 300],
  ['receiver_interrupt_backoff_s', 'Receiver interrupt back-off (s)', 15, 1, 300],
  ['outbound_retry_cycle_s', 'Outbound retry cycle (s)', 60, 1, 300],
  ['max_frame_sends', 'Max frame sends', 6, 1, 10],
  ['max_establish_attempts', 'Max establish attempts', 6, 1, 20],
  ['max_outbound_cycles', 'Max outbound retry cycles', 3, 1, 10],
] as const;
/** HL7 v2 link options: [key, label, min, max]. */
export const HL7_OPTIONS = [
  ['ack_timeout_s', 'ACK timeout (s)', 1, 60],
  ['send_retries', 'Send retries', 0, 5],
  ['max_message_bytes', 'Max message size (bytes)', 1024, 1048576],
] as const;

export interface InstrumentBody {
  instrument_code?: string;
  display_name?: string;
  agent_id?: string;
  vendor?: string;
  model?: string;
  serial_no?: string;
  software_version?: string;
  protocol?: Protocol;
  driver_code?: string;
  transport?: Record<string, unknown>;
  protocol_options?: { astm?: Record<string, number | string>; hl7v2?: Record<string, number | string> };
  parser_options?: Record<string, unknown>;
  file_drop?: Record<string, unknown>;
  capabilities?: { host_query: boolean; worklist_download: boolean };
  qc_sample_id_patterns?: string[];
  timezone?: string;
  silence_window_minutes?: number;
  silence_active_from?: string;
  silence_active_to?: string;
}

const CREATE_KEYS = ['instrument_code', 'display_name', 'agent_id', 'vendor', 'model', 'serial_no', 'software_version', 'protocol', 'driver_code', 'transport', 'protocol_options', 'parser_options', 'file_drop', 'capabilities', 'qc_sample_id_patterns', 'timezone', 'silence_window_minutes', 'silence_active_from', 'silence_active_to'] as const;
const IMMUTABLE = ['instrument_code', 'agent_id'] as const;

const o = (v: unknown, k: string) => (isObj(v) && Object.hasOwn(v, k) ? v[k] : undefined);
const present = (v: Record<string, unknown>, k: string) => Object.hasOwn(v, k) && v[k] !== undefined;

function validateProtocolOptions(po: unknown): Issue[] {
  if (!isObj(po)) return [{ path: '/protocol_options', message: 'Invalid link settings.' }];
  const out: Issue[] = [];
  const astm = o(po, 'astm');
  if (astm !== undefined) {
    if (!isObj(astm)) out.push({ path: '/protocol_options/astm', message: 'Invalid ASTM settings.' });
    else {
      for (const [k, label, , min, max] of ASTM_OPTIONS) if (present(astm, k) && !int(astm[k], min, max)) out.push({ path: `/protocol_options/astm/${k}`, message: `${label}: enter a whole number from ${min} to ${max}.` });
      if (present(astm, 'encoding') && !str(astm['encoding'], 1, 16)) out.push({ path: '/protocol_options/astm/encoding', message: 'Enter 1–16 characters.' });
    }
  }
  const hl7 = o(po, 'hl7v2');
  if (hl7 !== undefined) {
    if (!isObj(hl7)) out.push({ path: '/protocol_options/hl7v2', message: 'Invalid HL7 settings.' });
    else {
      for (const [k, label, min, max] of HL7_OPTIONS) if (present(hl7, k) && !int(hl7[k], min, max)) out.push({ path: `/protocol_options/hl7v2/${k}`, message: `${label}: enter a whole number from ${min} to ${max}.` });
      if (present(hl7, 'ack_mode') && !str(hl7['ack_mode'], 1, 32)) out.push({ path: '/protocol_options/hl7v2/ack_mode', message: 'Enter 1–32 characters.' });
      if (present(hl7, 'ack_sending_app') && (!str(hl7['ack_sending_app'], 1, 20) || !ACK_APP_RE.test(hl7['ack_sending_app']))) out.push({ path: '/protocol_options/hl7v2/ack_sending_app', message: 'Use capital letters, digits and underscores (up to 20).' });
      if (present(hl7, 'ack_sending_facility') && !str(hl7['ack_sending_facility'], 0, 20)) out.push({ path: '/protocol_options/hl7v2/ack_sending_facility', message: 'Enter up to 20 characters.' });
    }
  }
  return out;
}

/** mode 'create' needs the required fields; 'update' accepts any subset and refuses the immutable ones. */
export function validateInstrument(v: unknown, mode: 'create' | 'update'): Issue[] {
  if (!isObj(v)) return [{ path: '', message: 'Fill in the form.' }];
  const out: Issue[] = [];
  const bad = (path: string, message: string) => out.push({ path, message });
  const need = (k: string) => mode === 'create' || present(v, k);

  if (mode === 'update') for (const k of IMMUTABLE) if (present(v, k)) bad(`/${k}`, 'This field cannot be changed after the instrument is created.');
  if (mode === 'create') {
    if (typeof v['instrument_code'] !== 'string' || !INSTRUMENT_CODE_RE.test(v['instrument_code'])) bad('/instrument_code', 'Use 2–32 capital letters, digits or hyphens.');
    if (typeof v['agent_id'] !== 'string' || !UUID_RE.test(v['agent_id'])) bad('/agent_id', 'Choose an agent.');
  }
  if (need('display_name') && !str(v['display_name'], 1, 80)) bad('/display_name', 'Enter a name (1–80 characters).');
  if (need('vendor') && !str(v['vendor'], 1, 60)) bad('/vendor', 'Enter the vendor (1–60 characters).');
  if (need('model') && !str(v['model'], 1, 60)) bad('/model', 'Enter the model (1–60 characters).');
  if (present(v, 'serial_no') && !str(v['serial_no'], 0, 60)) bad('/serial_no', 'Enter up to 60 characters.');
  if (present(v, 'software_version') && !str(v['software_version'], 0, 40)) bad('/software_version', 'Enter up to 40 characters.');
  if (need('protocol') && !(PROTOCOLS as readonly unknown[]).includes(v['protocol'])) bad('/protocol', 'Choose a protocol.');
  if (need('driver_code') && !str(v['driver_code'], 1, 64)) bad('/driver_code', 'Choose a driver.');
  if (need('transport')) {
    const t = validateTransport(v['transport']);
    out.push(...t);
    const kind = o(v['transport'], 'kind');
    const proto = v['protocol'];
    if (!t.length && (PROTOCOLS as readonly unknown[]).includes(proto) && !(TRANSPORT_KINDS_BY_PROTOCOL[proto as Protocol] as readonly unknown[]).includes(kind)) bad('/transport/kind', 'This transport is not available for the chosen protocol.');
  }
  if (present(v, 'protocol_options')) out.push(...validateProtocolOptions(v['protocol_options']));
  if (present(v, 'parser_options') && !isObj(v['parser_options'])) bad('/parser_options', 'Invalid parser options.');
  if (present(v, 'file_drop')) out.push(...validateFileDrop(v['file_drop'], '/file_drop'));
  if (need('capabilities')) {
    const c = v['capabilities'];
    if (!isObj(c) || typeof c['host_query'] !== 'boolean' || typeof c['worklist_download'] !== 'boolean') bad('/capabilities', 'Choose on or off for each capability.');
  }
  if (present(v, 'qc_sample_id_patterns')) {
    const p = v['qc_sample_id_patterns'];
    if (!Array.isArray(p) || p.length > 10 || !p.every((x) => str(x, 1, 100))) bad('/qc_sample_id_patterns', 'Enter up to 10 patterns of 1–100 characters, one per line.');
  }
  if (present(v, 'timezone') && !str(v['timezone'], 1, 64)) bad('/timezone', 'Choose a timezone.');
  if (present(v, 'silence_window_minutes') && !int(v['silence_window_minutes'], 15, 1440)) bad('/silence_window_minutes', 'Enter a whole number from 15 to 1440.');
  for (const k of ['silence_active_from', 'silence_active_to']) if (present(v, k) && (typeof v[k] !== 'string' || !HHMM_RE.test(v[k]))) bad(`/${k}`, 'Use HH:MM, for example 07:30.');
  return out;
}

/** Documented keys only (contract additionalProperties false); transport / file_drop are re-picked per kind. Call after validation. */
export function instrumentBody(v: Record<string, unknown>, mode: 'create' | 'update'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CREATE_KEYS) {
    if (mode === 'update' && (IMMUTABLE as readonly string[]).includes(k)) continue;
    if (!present(v, k)) continue;
    const x = v[k];
    out[k] = k === 'transport' && isObj(x) ? normalizeTransport(x) : k === 'file_drop' && isObj(x) ? normalizeFileDrop(x) : k === 'capabilities' && isObj(x) ? { host_query: x['host_query'], worklist_download: x['worklist_download'] } : x;
  }
  return out;
}
