// Transport + file-drop schema (02-TRD §5.8, contracts TransportSerial/TcpClient/TcpServer/FileDrop/FileDropOptions).
// Pure and client-importable: the form validates with the same rules the BFF server functions re-check before any network call.
// Issues carry JSON Pointers relative to the instrument body ('/transport/port'), like the API's errors[].
export type Protocol = 'astm' | 'hl7v2' | 'file_drop';
export const PROTOCOLS: readonly Protocol[] = ['astm', 'hl7v2', 'file_drop'];
export const TRANSPORT_KINDS = ['serial', 'tcp_client', 'tcp_server', 'file_drop'] as const;
export type TransportKind = (typeof TRANSPORT_KINDS)[number];

/** 04-UI-UX SCR-06 §2: Transport kind is filtered by protocol. */
export const TRANSPORT_KINDS_BY_PROTOCOL: Readonly<Record<Protocol, readonly TransportKind[]>> = {
  astm: ['serial', 'tcp_client', 'tcp_server'],
  hl7v2: ['tcp_client', 'tcp_server'],
  file_drop: ['file_drop'],
};

export const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200] as const;
export const DATA_BITS = [7, 8] as const;
export const PARITIES = ['none', 'odd', 'even', 'mark', 'space'] as const;
export const STOP_BITS = ['1', '1.5', '2'] as const;
export const FILE_TYPES = ['pdf', 'png', 'jpg'] as const;

export interface Issue { path: string; message: string }

export const PORT_NAME_RE = /^COM[1-9][0-9]{0,2}$/;
export const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
export const IPV4_RE = /^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
export const WIN_PATH_RE = /^([A-Za-z]:\\|\\\\)/;
export const SUBDIR_RE = /^[A-Za-z0-9_-]{1,60}$/;
export const BARCODE_GROUP = '(?P<barcode>';
export const BARCODE_MESSAGE = 'Include a named group (?P<barcode>…) that captures the sample barcode';

type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const int = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
export const str = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const has = (o: Obj, k: string) => Object.hasOwn(o, k) && o[k] !== undefined;
const range = (min: number, max: number) => `Enter a whole number from ${min} to ${max}.`; // [CONV] texts

const isLoopbackOrAny = (ip: string) => ip === '0.0.0.0' || ip.startsWith('127.');

/** FileDropOptions (the secondary channel) and TransportFileDrop share every rule; `base` is the pointer prefix. */
export function validateFileDrop(o: unknown, base: string): Issue[] {
  const out: Issue[] = [];
  if (!isObj(o)) return [{ path: base, message: 'Fill in the folder settings.' }];
  const bad = (k: string, message: string) => out.push({ path: `${base}/${k}`, message });
  if (!str(o['directory'], 3, 240) || !WIN_PATH_RE.test(o['directory'])) bad('directory', 'Enter a full Windows folder path, such as D:\\Reports.');
  if (!str(o['filename_pattern'], 1, 200)) bad('filename_pattern', 'Enter a file name pattern (1–200 characters).');
  if (has(o, 'barcode_regex') && (!str(o['barcode_regex'], 1, 200) || !o['barcode_regex'].includes(BARCODE_GROUP))) bad('barcode_regex', BARCODE_MESSAGE);
  const t = o['allowed_types'];
  if (!Array.isArray(t) || t.length < 1 || t.length > 3 || new Set(t).size !== t.length || !t.every((x) => (FILE_TYPES as readonly unknown[]).includes(x))) bad('allowed_types', 'Choose at least one file type.');
  if (has(o, 'stable_seconds') && !int(o['stable_seconds'], 2, 60)) bad('stable_seconds', range(2, 60));
  if (has(o, 'move_after_capture') && typeof o['move_after_capture'] !== 'boolean') bad('move_after_capture', 'Choose on or off.');
  if (has(o, 'captured_subdirectory') && (typeof o['captured_subdirectory'] !== 'string' || !SUBDIR_RE.test(o['captured_subdirectory']))) bad('captured_subdirectory', 'Use 1–60 letters, digits, hyphens or underscores.');
  if (!str(o['attachment_instrument_code'], 1, 64)) bad('attachment_instrument_code', 'Enter the attachment code (1–64 characters).');
  return out;
}

/** Validates a Transport object. Never throws; anything that is not a known kind yields an issue. */
export function validateTransport(t: unknown): Issue[] {
  const base = '/transport';
  if (!isObj(t)) return [{ path: base, message: 'Choose how the instrument connects.' }];
  const kind = Object.hasOwn(t, 'kind') ? t['kind'] : undefined;
  if (typeof kind !== 'string' || !(TRANSPORT_KINDS as readonly string[]).includes(kind)) return [{ path: `${base}/kind`, message: 'Choose a transport kind.' }];
  const out: Issue[] = [];
  const bad = (k: string, message: string) => out.push({ path: `${base}/${k}`, message });
  if (kind === 'serial') {
    if (typeof t['port_name'] !== 'string' || !PORT_NAME_RE.test(t['port_name'])) bad('port_name', 'Use a port name like COM3.');
    if (!(BAUD_RATES as readonly unknown[]).includes(t['baud_rate'])) bad('baud_rate', 'Choose one of the listed baud rates.');
    if (!(DATA_BITS as readonly unknown[]).includes(t['data_bits'])) bad('data_bits', 'Choose 7 or 8 data bits.');
    if (!(PARITIES as readonly unknown[]).includes(t['parity'])) bad('parity', 'Choose a parity.');
    if (!(STOP_BITS as readonly unknown[]).includes(t['stop_bits'])) bad('stop_bits', 'Choose 1, 1.5 or 2 stop bits.');
    for (const k of ['dtr', 'rts']) if (has(t, k) && typeof t[k] !== 'boolean') bad(k, 'Choose on or off.');
  } else if (kind === 'tcp_client') {
    if (typeof t['host'] !== 'string' || !HOST_RE.test(t['host'])) bad('host', 'Use letters, digits, dots and hyphens only (up to 253 characters).');
    if (!int(t['port'], 1, 65535)) bad('port', range(1, 65535));
    if (has(t, 'connect_timeout_s') && !int(t['connect_timeout_s'], 1, 60)) bad('connect_timeout_s', range(1, 60));
    if (has(t, 'reconnect_max_backoff_s') && !int(t['reconnect_max_backoff_s'], 1, 300)) bad('reconnect_max_backoff_s', range(1, 300));
  } else if (kind === 'tcp_server') {
    const ip = t['bind_address'];
    if (typeof ip !== 'string' || !IPV4_RE.test(ip) || isLoopbackOrAny(ip)) bad('bind_address', 'Enter the PC\'s IPv4 address on the lab network (not 0.0.0.0 or 127.x).');
    if (!int(t['port'], 1024, 65535)) bad('port', range(1024, 65535));
    const peers = t['allowed_peers'];
    if (!Array.isArray(peers) || peers.length < 1 || peers.length > 8 || new Set(peers).size !== peers.length || !peers.every((p) => typeof p === 'string' && IPV4_RE.test(p))) bad('allowed_peers', 'Enter 1–8 different IPv4 addresses, separated by commas.');
  } else {
    out.push(...validateFileDrop(t, base));
  }
  return out;
}

const pick = (o: Obj, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => has(o, k)).map((k) => [k, o[k]]));
const FILE_DROP_KEYS = ['directory', 'filename_pattern', 'barcode_regex', 'allowed_types', 'stable_seconds', 'move_after_capture', 'captured_subdirectory', 'attachment_instrument_code'] as const;
const TRANSPORT_KEYS: Readonly<Record<TransportKind, readonly string[]>> = {
  serial: ['kind', 'port_name', 'baud_rate', 'data_bits', 'parity', 'stop_bits', 'dtr', 'rts'],
  tcp_client: ['kind', 'host', 'port', 'connect_timeout_s', 'reconnect_max_backoff_s'],
  tcp_server: ['kind', 'bind_address', 'port', 'allowed_peers'],
  file_drop: ['kind', ...FILE_DROP_KEYS],
};
/** Keeps only the documented keys of an already validated transport (contract: additionalProperties false). */
export const normalizeTransport = (t: Obj) => pick(t, TRANSPORT_KEYS[t['kind'] as TransportKind]);
export const normalizeFileDrop = (o: Obj) => pick(o, FILE_DROP_KEYS);
