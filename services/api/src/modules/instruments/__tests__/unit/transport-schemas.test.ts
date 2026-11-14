// API-T02 — 02-TRD §5.8 transport / protocol_options / file_drop validation (domain/transportSchemas.ts).
// Expected API (pure; { valid: true } or { valid: false, errors: string[] }; unknown properties are rejected):
//   validateTransport(x: unknown), validateFileDrop(x: unknown), validateProtocolOptions(protocol: 'astm'|'hl7v2', x: unknown)
// Also exported: transportSchema, fileDropSchema, protocolOptionsSchema (JSON Schema objects, reused by OpenAPI/probes).
import { describe, expect, it } from 'vitest';
import {
  fileDropSchema,
  protocolOptionsSchema,
  transportSchema,
  validateFileDrop,
  validateProtocolOptions,
  validateTransport,
} from '../../domain/transportSchemas.js';

const ok = (r: { valid: boolean }) => r.valid;
const serial = { kind: 'serial', port_name: 'COM3', baud_rate: 9600, data_bits: 8, parity: 'none', stop_bits: '1' };
const tcpClient = { kind: 'tcp_client', host: '192.0.2.10', port: 5000 };
const tcpServer = { kind: 'tcp_server', bind_address: '192.0.2.5', port: 5001, allowed_peers: ['192.0.2.20'] };
const fileDrop = {
  directory: 'C:\\Instruments\\Drop', filename_pattern: '^.*\\.pdf$', barcode_regex: '^(?P<barcode>[A-Z0-9]{6,12})_',
  allowed_types: ['pdf'], attachment_instrument_code: 'HPLC1',
};

describe('exports', () => {
  it('JSON Schema objects exist', () => {
    for (const s of [transportSchema, fileDropSchema, protocolOptionsSchema]) expect(typeof s).toBe('object');
  });
});

describe('transport: serial', () => {
  it('valid minimal + optional dtr/rts', () => {
    expect(ok(validateTransport(serial))).toBe(true);
    expect(ok(validateTransport({ ...serial, dtr: false, rts: false }))).toBe(true);
  });
  it.each([
    ['port_name', 'COM0'], ['port_name', 'COM1000'], ['port_name', 'com3'], ['port_name', '/dev/ttyS0'], ['port_name', 'COM3 '],
    ['baud_rate', 1000], ['baud_rate', '9600'], ['data_bits', 5], ['data_bits', 9], ['parity', 'bogus'], ['stop_bits', 1], ['stop_bits', '3'],
  ])('rejects %s = %j', (k, v) => expect(ok(validateTransport({ ...serial, [k]: v }))).toBe(false));
  it.each(['mark', 'space', 'odd', 'even'])('accepts parity %s', (p) => expect(ok(validateTransport({ ...serial, parity: p }))).toBe(true));
  it.each(['1', '1.5', '2'])('accepts stop_bits %s', (s) => expect(ok(validateTransport({ ...serial, stop_bits: s }))).toBe(true));
  it('rejects a missing required field and unknown properties', () => {
    const { baud_rate: _b, ...rest } = serial;
    expect(ok(validateTransport(rest))).toBe(false);
    expect(ok(validateTransport({ ...serial, evil: 1 }))).toBe(false);
  });
});

describe('transport: tcp_client', () => {
  it('valid, with optional timeouts', () => {
    expect(ok(validateTransport(tcpClient))).toBe(true);
    expect(ok(validateTransport({ ...tcpClient, connect_timeout_s: 60, reconnect_max_backoff_s: 300 }))).toBe(true);
    expect(ok(validateTransport({ ...tcpClient, host: 'analyser-01.lab.local' }))).toBe(true);
  });
  it.each([
    ['port', 0], ['port', 65536], ['port', '5000'], ['connect_timeout_s', 0], ['connect_timeout_s', 61],
    ['reconnect_max_backoff_s', 301], ['host', 'a b'], ['host', 'h;rm -rf'], ['host', 'http://x'], ['host', ''], ['host', 'a'.repeat(254)],
  ])('rejects %s = %j', (k, v) => expect(ok(validateTransport({ ...tcpClient, [k]: v }))).toBe(false));
});

describe('transport: tcp_server', () => {
  it('valid', () => expect(ok(validateTransport(tcpServer))).toBe(true));
  it.each([
    ['bind_address', '0.0.0.0'], ['bind_address', '127.0.0.1'], ['bind_address', '127.1.2.3'], ['bind_address', '::1'], ['bind_address', 'localhost'],
    ['bind_address', '999.1.1.1'], ['port', 1023], ['port', 65536], ['allowed_peers', []],
    ['allowed_peers', ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4', '192.0.2.5', '192.0.2.6', '192.0.2.7', '192.0.2.8', '192.0.2.9']],
    ['allowed_peers', ['not-an-ip']], ['allowed_peers', ['192.0.2.0/24']],
  ])('rejects %s = %j', (k, v) => expect(ok(validateTransport({ ...tcpServer, [k]: v }))).toBe(false));
  it('accepts exactly 8 peers and port 1024', () => {
    const peers = Array.from({ length: 8 }, (_, i) => `192.0.2.${i + 1}`);
    expect(ok(validateTransport({ ...tcpServer, port: 1024, allowed_peers: peers }))).toBe(true);
  });
});

describe('transport: file_drop kind (§5.8 lists it as a transport.kind)', () => {
  it('kind + file_drop fields is valid; bare kind is not', () => {
    expect(ok(validateTransport({ kind: 'file_drop', ...fileDrop }))).toBe(true);
    expect(ok(validateTransport({ kind: 'file_drop' }))).toBe(false);
    expect(ok(validateTransport({ kind: 'file_drop', ...fileDrop, directory: 'relative' }))).toBe(false);
  });
});

describe('transport: discriminator', () => {
  it.each([{}, { kind: 'bogus' }, { kind: 'file_drop' }, null, 'serial', 42, []])('rejects %j', (x) =>
    expect(ok(validateTransport(x))).toBe(false),
  );
  it('a serial body labelled tcp_client is rejected', () => expect(ok(validateTransport({ ...serial, kind: 'tcp_client' }))).toBe(false));
});

describe('file_drop', () => {
  it('valid minimal and with optionals', () => {
    expect(ok(validateFileDrop(fileDrop))).toBe(true);
    expect(ok(validateFileDrop({ ...fileDrop, stable_seconds: 60, move_after_capture: true, captured_subdirectory: 'done_1-2' }))).toBe(true);
    expect(ok(validateFileDrop({ ...fileDrop, directory: '\\\\fileserver\\share\\drop', allowed_types: ['pdf', 'png', 'jpg'] }))).toBe(true);
  });
  it('barcode_regex is optional', () => {
    const { barcode_regex: _r, ...rest } = fileDrop;
    expect(ok(validateFileDrop(rest))).toBe(true);
  });
  it.each([
    ['directory', 'relative\\path'], ['directory', '/etc/passwd'], ['directory', 'C:relative'], ['directory', `C:\\${'a'.repeat(240)}`],
    ['barcode_regex', '^[A-Z0-9]+$'], ['barcode_regex', '(?P<code>x)'], ['barcode_regex', `(?P<barcode>${'a'.repeat(200)})`],
    ['filename_pattern', 'a'.repeat(201)],
    ['allowed_types', []], ['allowed_types', ['exe']], ['allowed_types', ['pdf', 'svg']], ['allowed_types', 'pdf'],
    ['stable_seconds', 1], ['stable_seconds', 61],
    ['captured_subdirectory', '..'], ['captured_subdirectory', '../up'], ['captured_subdirectory', 'a/b'], ['captured_subdirectory', 'a\\b'], ['captured_subdirectory', ''], ['captured_subdirectory', 'a'.repeat(61)],
    ['attachment_instrument_code', ''], ['attachment_instrument_code', 'a'.repeat(65)],
  ])('rejects %s = %j', (k, v) => expect(ok(validateFileDrop({ ...fileDrop, [k]: v }))).toBe(false));
  it('rejects unknown properties', () => expect(ok(validateFileDrop({ ...fileDrop, evil: 1 }))).toBe(false));
  it('rejects file_drop with a missing required field', () => {
    const { allowed_types: _a, ...rest } = fileDrop;
    expect(ok(validateFileDrop(rest))).toBe(false);
  });
});

describe('protocol_options.hl7v2', () => {
  const hl7 = { ack_sending_app: 'LIMS_ACK', ack_sending_facility: 'LAB', ack_timeout_s: 10, send_retries: 3, max_message_bytes: 65536 };
  it('valid partial and boundary values', () => {
    expect(ok(validateProtocolOptions('hl7v2', hl7))).toBe(true);
    expect(ok(validateProtocolOptions('hl7v2', { ack_timeout_s: 1, send_retries: 0, max_message_bytes: 1024 }))).toBe(true);
    expect(ok(validateProtocolOptions('hl7v2', { ack_timeout_s: 60, send_retries: 5, max_message_bytes: 1048576 }))).toBe(true);
  });
  it.each([
    ['ack_sending_app', 'lower'], ['ack_sending_app', 'A'.repeat(21)], ['ack_sending_app', 'A B'], ['ack_sending_facility', 'F'.repeat(21)],
    ['ack_timeout_s', 0], ['ack_timeout_s', 61], ['send_retries', -1], ['send_retries', 6], ['max_message_bytes', 1023], ['max_message_bytes', 1048577],
  ])('rejects %s = %j', (k, v) => expect(ok(validateProtocolOptions('hl7v2', { ...hl7, [k]: v }))).toBe(false));
  it('rejects unknown option keys', () => expect(ok(validateProtocolOptions('hl7v2', { evil: true }))).toBe(false));
});
