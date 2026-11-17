// @lims/shared-ts/logger (02-TRD §3.1; CV §9.1 fields, §9.2 denylist + value scrubbers; 07 AB-19). pino backend.
import pino from 'pino';

export type ServiceName = 'api' | 'worker' | 'web-bff' | 'renderer' | 'portal' | 'partner' | 'bridge-agent';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  request_id?: string; trace_id?: string; span_id?: string; tenant_id?: string; actor_id?: string; actor_type?: string;
  module?: string; operation_id?: string; task?: string; route?: string; status?: number; duration_ms?: number; error_code?: string;
}

export interface Logger {
  child(ctx: LogContext): Logger;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  service: ServiceName; env: string; version: string; level?: LogLevel;
  /** [CONV] output sink (tests); default stdout. */
  destination?: { write(line: string): void };
}

const R = '[REDACTED]';

/** CV §9.2 denylist: a key is redacted if its lowercase form contains any of these. [CONV] list derived from §9.2 categories. */
const DENY = [
  'patient_name', 'full_name', 'first_name', 'middle_name', 'last_name', 'phone', 'mobile', 'email', 'address',
  'dob', 'date_of_birth', 'birth', 'citizenship', 'national_id', 'photo', 'signature',
  'registration_no', 'barcode', 'sample_no', 'lab_no', 'accession', 'url', 'qr',
  'result_value', 'interpretation', 'diagnos', 'clinical', 'trf', 'report_content', 'report_text',
  'password', 'passwd', 'otp', 'jwt', 'token', 'cookie', 'authorization', 'secret', 'api_key', 'apikey',
  'card', 'wallet', 'comment', 'critical', 'test_name', 'panel_name', 'smart_report',
];

/** Value scrubbers (CV §9.2): keyword-labelled values in free text ("otp 482913", "barcode=BC-1"),
 *  bearer/basic credentials, JWT-shaped strings, Nepali mobile numbers (+977 optional). */
const SCRUB: [RegExp, string][] = [
  [/\b(barcode|sample_no|lab_no|otp|pin|password|passwd|token|phone|mobile)(\s*[:=]\s*|\s+)\S*\d\S*/gi, `$1$2${R}`],
  [/\b(Bearer|Basic)\s+\S+/gi, `$1 ${R}`],
  [/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, R],
  [/(?<![0-9A-Za-z])(?:\+?977[-\s]?)?9\d{9}(?![0-9A-Za-z])/g, R],
];

/** Fields the logger owns; callers can never overwrite them. */
const RESERVED = new Set(['ts', 'level', 'service', 'env', 'version', 'msg']);

const scrubStr = (s: string): string => SCRUB.reduce((acc, [re, to]) => acc.replace(re, to), s);
const denied = (k: string): boolean => { const l = k.toLowerCase(); return DENY.some((d) => l.includes(d)); };

function scrub(v: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof v === 'string') return scrubStr(v);
  if (typeof v === 'number' && Number.isInteger(v) && scrubStr(String(v)) !== String(v)) return R; // numeric phone
  if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? v.toString() : v;
  if (seen.has(v)) return '[Circular]';
  if (depth > 10) return '[Truncated]';
  seen.add(v);
  if (v instanceof Error) return { type: v.name, message: scrubStr(v.message), stack: v.stack === undefined ? undefined : scrubStr(v.stack) };
  if (Array.isArray(v)) return v.map((x) => scrub(x, seen, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = denied(k) ? R : scrub(x, seen, depth + 1);
  return out;
}

/** Copy of `fields` with reserved keys dropped, denylisted keys redacted, string values scrubbed. Never mutates input. */
function clean(fields: Record<string, unknown> | object | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fields || typeof fields !== 'object') return out;
  const seen = new WeakSet<object>([fields]);
  for (const [k, v] of Object.entries(fields)) {
    if (RESERVED.has(k) || v === undefined) continue;
    out[k] = denied(k) ? R : scrub(v, seen, 1);
  }
  return out;
}

function wrap(p: pino.Logger): Logger {
  const at = (lvl: LogLevel) => (msg: string, fields?: Record<string, unknown>) => {
    let f: Record<string, unknown>;
    try { f = clean(fields); } catch { f = { log_fields_dropped: true }; } // logging never throws (e.g. throwing getters)
    p[lvl](f, scrubStr(String(msg)));
  };
  const child = (ctx: LogContext): Logger => {
    let c: Record<string, unknown>;
    try { c = clean(ctx); } catch { c = { log_fields_dropped: true }; } // child() never throws either
    return wrap(p.child(c));
  };
  return { child, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export function createLogger(opts: LoggerOptions): Logger {
  const o: pino.LoggerOptions = {
    level: opts.level ?? 'info',
    messageKey: 'msg',
    base: { service: opts.service, env: opts.env, version: opts.version },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label }) },
  };
  return wrap(opts.destination ? pino(o, opts.destination) : pino(o));
}
