// Errors -> RFC 9457 problem+json (02-CV §4.6, 02-TRD §3 shared-ts/errors shape, REQ-SEC-095). AC-0D-3.1: every non-2xx is a Problem.
// Fail closed: anything that is not a LimsError with a registry code renders as 500 common.internal with request_id only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { parse } from 'yaml';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (lockfile is C0-0A's, LD-05).
import { isUuidv7, uuidv7 } from '../../../../packages/shared-ts/src/uuidv7/index.js';
import { REPO_ROOT } from './module.js';
import { setErrorCode } from './observability/logging.js';

export interface FieldError { readonly path: string; readonly code: string; readonly message: string }
export interface Problem {
  readonly type: string; readonly title: string; readonly status: number; readonly code: string;
  readonly detail?: string; readonly instance: string; readonly request_id: string; readonly errors?: readonly FieldError[];
}

let registry: ReadonlyMap<string, { readonly http: number; readonly title: string }> | undefined;
function lookup(code: string): { readonly http: number; readonly title: string } | undefined {
  registry ??= new Map(
    (parse(readFileSync(join(REPO_ROOT, 'contracts', 'errors.yaml'), 'utf8')) as Array<{ code: string; http: number; title: string }>)
      .map((e) => [e.code, { http: e.http, title: e.title }]),
  );
  return registry.get(code);
}

export class LimsError extends Error {
  statusCode: number;
  /** Set by the thrower (429 / 503); rendered as the Retry-After header. */
  retryAfterSeconds?: number;
  constructor(readonly code: string, readonly detail?: string, readonly errors?: readonly FieldError[]) {
    super(code); // message = code only: never data
    this.name = 'LimsError';
    this.statusCode = lookup(code)?.http ?? 500;
  }
}

export function isLimsError(e: unknown, code?: string): e is LimsError {
  return e instanceof LimsError && (code === undefined || e.code === code);
}

const clamp = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const SUB_CODES = new Set(['common.field_required', 'common.field_invalid', 'common.unknown_field']);
// LD-153 (CR-C9-T15a / C14.T11): registry meanings "errors in errors[]" (08-CR-REGISTER:873, CR-C9-002) rank above 02-CV §4.6.
const ERRORS_CODES = new Set(['common.validation_failed', 'quality.rule_set_invalid', 'smartreport.library_invalid']);

/** Any throwable -> Problem. Pieces are clamped to the `_common.yaml#/Problem` maxima. */
export function toProblem(err: unknown, instance: string, requestId: string): Problem {
  const known = isLimsError(err) && CODE.test(err.code) && err.code.length <= 100 && lookup(err.code) ? err : undefined;
  const code = known?.code ?? 'common.internal';
  const m = lookup(code)!;
  const p: { -readonly [K in keyof Problem]: Problem[K] } = {
    type: `urn:lims:error:${code}`, title: m.title, status: m.http, code,
    instance: clamp(instance, 2048), request_id: isUuidv7(requestId) ? requestId : uuidv7(),
  };
  if (typeof known?.detail === 'string') p.detail = clamp(known.detail, 2000);
  if (ERRORS_CODES.has(code) && known?.errors?.length) {
    // 02-CV §4.6 as amended by LD-153: errors[] only for ERRORS_CODES; sub-codes always from the registry.
    p.errors = known.errors.slice(0, 200).map((f) => ({
      path: clamp(String(f.path), 512),
      code: SUB_CODES.has(f.code) ? f.code : 'common.field_invalid',
      message: clamp(String(f.message), 500),
    }));
  }
  return p;
}

// ---------- Fastify wiring (installed by bootstrap) ----------

/** 02-TRD §6.2 stage 1: X-Request-Id if a valid UUIDv7, else a fresh one. */
export function genReqId(raw: { headers: Record<string, string | string[] | undefined> }): string {
  const h = raw.headers['x-request-id'];
  return isUuidv7(h) ? h : uuidv7();
}

const pointer = (seg: string): string => seg.replaceAll('~', '~0').replaceAll('/', '~1');
const MSG = { 'common.field_required': 'Field required', 'common.unknown_field': 'Unknown field', 'common.field_invalid': 'Field invalid' } as const;

/** ajv errors -> FieldError[]: JSON-pointer path + sub-code; messages are fixed text so no submitted value is echoed. */
function fieldErrors(validation: ReadonlyArray<{ keyword: string; instancePath?: string; params?: Record<string, unknown> }>): FieldError[] {
  return validation.map((v) => {
    const base = v.instancePath ?? '';
    let code: keyof typeof MSG = 'common.field_invalid';
    let path = base;
    if (v.keyword === 'required' && typeof v.params?.missingProperty === 'string') {
      code = 'common.field_required'; path = `${base}/${pointer(v.params.missingProperty)}`;
    } else if (v.keyword === 'additionalProperties' && typeof v.params?.additionalProperty === 'string') {
      code = 'common.unknown_field'; path = `${base}/${pointer(v.params.additionalProperty)}`;
    }
    return { path, code, message: MSG[code] };
  });
}

/** Fastify's own (FST_*) errors by status; any other non-LimsError stays unmapped (-> 500). */
const FASTIFY_STATUS: Readonly<Record<number, string>> = {
  400: 'common.validation_failed', 404: 'common.not_found', 405: 'common.method_not_allowed',
  413: 'common.payload_too_large', 415: 'common.unsupported_media_type',
};
function normalise(err: unknown): unknown {
  if (isLimsError(err)) return err;
  const fe = err as FastifyError | null;
  if (!(fe instanceof Error)) return err;
  if (Array.isArray(fe.validation)) return new LimsError('common.validation_failed', undefined, fieldErrors(fe.validation as any));
  if (typeof fe.code === 'string' && fe.code.startsWith('FST_') && typeof fe.statusCode === 'number') {
    const code = FASTIFY_STATUS[fe.statusCode];
    if (code) return new LimsError(code);
  }
  return err;
}

/** Problems built here; the stage-12 response check lets them through (they are valid by construction). */
const rendered = new WeakSet<object>();
export const isRenderedProblem = (payload: unknown): boolean => typeof payload === 'object' && payload !== null && rendered.has(payload);

const pathOf = (url: string): string => url.split('?', 1)[0]!; // REQ-SEC-098: never the query string

export function sendProblem(err: unknown, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const e = normalise(err);
  const p = toProblem(e, pathOf(req.url), String(req.id));
  setErrorCode(req, p.code);
  if (p.status >= 500) {
    // ponytail: name + code only (no message/stack: may carry SQL/PHI); full error logging is T0D-10.
    req.log.error({ event: 'request_failed', error_code: p.code, err_name: (err as Error | null)?.name }, 'request_failed');
  }
  const retry = isLimsError(e) ? e.retryAfterSeconds : undefined;
  if (typeof retry === 'number' && Number.isFinite(retry) && retry > 0) reply.header('retry-after', String(Math.ceil(retry)));
  rendered.add(p);
  return reply.code(p.status).type('application/problem+json').send(p);
}

/** Error + not-found handlers. Call before any spec is mounted (child scopes inherit them). */
export function installErrorHandlers(app: FastifyInstance): void {
  // [CONV] JSON + multipart only (02-TRD §6.2); without the default text/plain parser a text body is 415, not a 400.
  app.removeContentTypeParser('text/plain');
  app.setErrorHandler((err, req, reply) => sendProblem(err, req, reply));
  app.setNotFoundHandler((req, reply) => sendProblem(new LimsError('common.not_found'), req, reply));
}
