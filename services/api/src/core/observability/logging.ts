// Fastify logger = @lims/shared-ts/logger (CV §9.1 fields, §9.2 denylist + scrubbers) and the stage-13 onResponse
// log line + HTTP metrics (02-TRD §6.2 row 13). Route template only, never the raw URL or query.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (lockfile is C0-0A's, LD-05).
import { createLogger, type Logger } from '../../../../../packages/shared-ts/src/logger/index.js';
import type { CoreConfig } from '../config.js';
import type { CoreMetrics } from './metrics.js';
import { parseTraceparent } from './tracing.js';

/** [CONV] package.json version until the C1 build injects the git sha. */
const VERSION: string = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8')).version;

/** pino-style (fields, msg) calls -> the shared logger's (msg, fields). */
function adapt(l: Logger, level: string): FastifyBaseLogger {
  const at = (fn: (msg: string, f?: Record<string, unknown>) => void) => (a?: unknown, b?: unknown) => {
    if (typeof a === 'string') return fn(a);
    fn(typeof b === 'string' ? b : '', (a instanceof Error ? { err: a } : a) as Record<string, unknown>);
  };
  return {
    level,
    fatal: at(l.error), error: at(l.error), warn: at(l.warn), info: at(l.info), debug: at(l.debug), trace: at(l.debug),
    silent: () => undefined,
    child: (bindings: object) => adapt(l.child(bindings), level),
  } as unknown as FastifyBaseLogger;
}

export function createCoreLogger(config: CoreConfig, stream?: { write(line: string): void }): FastifyBaseLogger {
  const l = createLogger({
    service: 'api', env: config.env, version: VERSION, level: config.logLevel as 'info',
    ...(stream ? { destination: stream } : {}),
  });
  return adapt(l, config.logLevel);
}

/** Fastify childLoggerFactory: request_id (requestIdLogLabel) + trace_id/span_id from traceparent (stage 1). */
export const childLoggerFactory = (logger: FastifyBaseLogger, bindings: object, opts: object, raw: { headers: Record<string, unknown> }) =>
  logger.child({ ...bindings, ...parseTraceparent(raw.headers.traceparent) }, opts);

const errorCodes = new WeakMap<FastifyRequest, string>();
/** errors.yaml code of a failed request, for the stage-13 line. */
export const setErrorCode = (req: FastifyRequest, code: string): void => { errorCodes.set(req, code); };

interface Actor { readonly tenant_id?: string | undefined; readonly sub?: string; readonly actor_type?: string }

export function installRequestLog(app: FastifyInstance, metrics: CoreMetrics, actorOf: (req: FastifyRequest) => Actor | undefined): void {
  app.addHook('onResponse', async (req, reply) => {
    const operationId = (req.routeOptions.schema as { operationId?: string } | undefined)?.operationId;
    // [CONV] no-route requests share one bounded label value; module 'core' (the core's not-found handler answered).
    const operation_id = operationId ?? 'unmatched';
    const module = (operationId && (req.routeOptions.config as { module?: string } | undefined)?.module) || 'core';
    const status = reply.statusCode;
    metrics.inc('lims_http_requests_total', { module, operation_id, status: String(status) });
    const ms = reply.elapsedTime;
    metrics.observe('lims_http_request_duration_seconds', ms / 1000, { module, operation_id });
    const a = actorOf(req);
    req.log[status >= 500 ? 'error' : 'info']({
      module, operation_id,
      route: operationId ? req.routeOptions.url?.replace(/:(\w+)/g, '{$1}') : undefined,
      status, duration_ms: Math.round(ms), error_code: errorCodes.get(req),
      tenant_id: a?.tenant_id, actor_id: a?.sub, actor_type: a?.actor_type,
    }, 'request');
  });
}
