// C6-T33 — reporting log denylist (02-TRD §12 "Logs", 02-CV §9.2, REQ-SEC-098).
// Runtime wiring into the api/worker core loggers is owned by C0-0D/C0-0A: see .orchestra/cr/C6-T33.md (CR-C6-T33).
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as analytics/billing/catalog).
import { createLogger, type LogContext, type Logger, type LoggerOptions } from '../../../../../packages/shared-ts/src/logger/index.js';

/** The module's extra keys on top of the shared CV §9.2 denylist, spelled as in 02-TRD §12. */
export const REPORTING_LOG_DENY: readonly string[] = Object.freeze([
  'otp', 'code', 'link_url', 'url', 'token', 'destination', 'body_text', 'params', 'to', 'action_url', 'action_json', 'portalUrl',
]);

const DENY = new Set(REPORTING_LOG_DENY.map((k) => k.toLowerCase()));
const R = '[REDACTED]';

/** Copy with every key in DENY (exact, case-insensitive: `error_code` / `tenant_id` stay visible) replaced; never mutates the input.
 *  Only plain objects and arrays are walked; Errors and other instances go to the shared logger untouched. */
function redact(v: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (v === null || typeof v !== 'object') return v;
  const proto = Object.getPrototypeOf(v);
  if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return v;
  if (seen.has(v) || depth > 10) return '[Truncated]';
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => redact(x, seen, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = DENY.has(k.toLowerCase()) ? R : redact(x, seen, depth + 1);
  return out;
}
const clean = <T extends object | undefined>(f: T): T => (f ? (redact(f, new WeakSet(), 0) as T) : f);

function wrap(l: Logger): Logger {
  return {
    child: (ctx: LogContext) => wrap(l.child(clean(ctx))),
    debug: (m, f) => l.debug(m, clean(f)),
    info: (m, f) => l.info(m, clean(f)),
    warn: (m, f) => l.warn(m, clean(f)),
    error: (m, f) => l.error(m, clean(f)),
  };
}

/** Shared logger (CV §9.2 denylist + value scrubbers) plus REPORTING_LOG_DENY. */
export const createReportingLogger = (opts: LoggerOptions): Logger => wrap(createLogger(opts));
