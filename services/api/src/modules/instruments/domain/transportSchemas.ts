// JSON Schemas for transport / protocol_options / file_drop (02-TRD §5.8, §5.2.4). Pure; reused by OpenAPI and probes.
import { createRequire } from 'node:module';

// [CONV] ajv is not a direct services/api dependency (lockfile is C0-0A's, LD-05): load the ajv that @fastify/ajv-compiler ships
// (same as core/events/publish.ts).
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => {
  compile(s: object): ((x: unknown) => boolean) & { errors?: { instancePath: string; keyword: string }[] | null };
};

const OCTET = '(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const IPV4 = `^${OCTET}(\\.${OCTET}){3}$`;
const ipv4 = { type: 'string', pattern: IPV4 } as const;
const int = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum }) as const;

const fileDropProps = {
  directory: { type: 'string', maxLength: 240, pattern: '^([A-Za-z]:\\\\|\\\\\\\\)' },
  filename_pattern: { type: 'string', minLength: 1, maxLength: 200 },
  barcode_regex: { type: 'string', maxLength: 200, pattern: '\\(\\?P<barcode>' },
  allowed_types: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: ['pdf', 'png', 'jpg'] } },
  stable_seconds: int(2, 60),
  move_after_capture: { type: 'boolean' },
  captured_subdirectory: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,60}$' },
  attachment_instrument_code: { type: 'string', minLength: 1, maxLength: 64 },
} as const;
const fileDropRequired = ['directory', 'filename_pattern', 'allowed_types', 'attachment_instrument_code'];

export const fileDropSchema = {
  type: 'object', additionalProperties: false, required: fileDropRequired, properties: fileDropProps,
} as const;

export const transportSchema = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      required: ['kind', 'port_name', 'baud_rate', 'data_bits', 'parity', 'stop_bits'],
      properties: {
        kind: { const: 'serial' },
        port_name: { type: 'string', pattern: '^COM[1-9][0-9]{0,2}$' },
        baud_rate: { type: 'integer', enum: [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200] },
        data_bits: { type: 'integer', enum: [7, 8] },
        parity: { type: 'string', enum: ['none', 'odd', 'even', 'mark', 'space'] },
        stop_bits: { type: 'string', enum: ['1', '1.5', '2'] },
        dtr: { type: 'boolean' },
        rts: { type: 'boolean' },
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'host', 'port'],
      properties: {
        kind: { const: 'tcp_client' },
        host: { type: 'string', pattern: '^[A-Za-z0-9.-]{1,253}$' },
        port: int(1, 65535),
        connect_timeout_s: int(1, 60),
        reconnect_max_backoff_s: int(1, 300),
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'bind_address', 'port', 'allowed_peers'],
      properties: {
        kind: { const: 'tcp_server' },
        // IPv4, not 0.0.0.0, not loopback (127.0.0.0/8).
        bind_address: { type: 'string', pattern: IPV4, not: { pattern: '^(0\\.0\\.0\\.0|127\\.)' } },
        port: int(1024, 65535),
        allowed_peers: { type: 'array', minItems: 1, maxItems: 8, items: ipv4 },
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', ...fileDropRequired],
      properties: { kind: { const: 'file_drop' }, ...fileDropProps },
    },
  ],
} as const;

const timer = int(1, 300); // §5.2.4: every *_s timer 1–300 s [CONV]
const astmOptionsSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    establish_reply_s: timer, nak_retry_delay_s: timer, host_contention_defer_s: timer, instrument_contention_retry_s: timer,
    transfer_reply_s: timer, receiver_frame_wait_s: timer, receiver_interrupt_backoff_s: timer, outbound_retry_cycle_s: timer,
    max_frame_sends: int(1, 10), max_establish_attempts: int(1, 20), max_outbound_cycles: int(1, 10),
    encoding: { type: 'string', enum: ['latin1'] }, // only value named by §5.2.4
  },
} as const;
const hl7v2OptionsSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    ack_mode: { type: 'string', enum: ['auto', 'original', 'enhanced', 'none'] }, // §5.4
    ack_sending_app: { type: 'string', maxLength: 20, pattern: '^[A-Z0-9_]+$' },
    ack_sending_facility: { type: 'string', minLength: 1, maxLength: 20 },
    ack_timeout_s: int(1, 60),
    send_retries: int(0, 5),
    max_message_bytes: int(1024, 1048576),
  },
} as const;

/** `protocol_options` column: keyed by protocol. */
export const protocolOptionsSchema = {
  type: 'object', additionalProperties: false, properties: { astm: astmOptionsSchema, hl7v2: hl7v2OptionsSchema },
} as const;

export type ValidationResult = { valid: true } | { valid: false; errors: string[] };

const ajv = new Ajv2020({ strict: true, allErrors: true });
const compile = (s: object) => {
  const v = ajv.compile(s);
  // Never echo instance values (may hold site data): path + keyword only.
  return (x: unknown): ValidationResult =>
    v(x) ? { valid: true } : { valid: false, errors: (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.keyword}`) };
};

export const validateTransport = compile(transportSchema);
export const validateFileDrop = compile(fileDropSchema);
const byProtocol = { astm: compile(astmOptionsSchema), hl7v2: compile(hl7v2OptionsSchema) };
export function validateProtocolOptions(protocol: 'astm' | 'hl7v2', x: unknown): ValidationResult {
  const v = byProtocol[protocol];
  return v ? v(x) : { valid: false, errors: ['/ protocol'] };
}
