// Mounts module specs through fastify-openapi-glue 4.12.0 with the SP-8 obligations (db/meta/decisions/SP-8.md):
// O1 ajv options (bootstrap.ts), O2 strict query, O3 boot-time handler check via operationResolver, O4 response validation.
// O5 error mapping is T0D-04 (core/errors.ts); security handlers are T0D-02 (core/auth/**).
import { AjvCompiler } from '@fastify/ajv-compiler';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions, RouteOptions } from 'fastify';
import openapiGlue from 'fastify-openapi-glue';
import type { BffKeyVerifier, BffKind } from './auth/bff-key.js';
import { authenticateBearer, endpointFamilyOf, type ClaimsResolver } from './auth/claims-resolver.js';
import type { DbClaims } from './auth/claims.js';
import type { ClientIpResolver } from './auth/client-ip.js';
import { AuthError } from './auth/errors.js';
import type { AuthResolverRegistry } from './auth/resolvers.js';
import type { Db } from './db/tx.js';
import { isRenderedProblem, LimsError, pendingProblem } from './errors.js';
import type { JwtVerifier } from './auth/jwt.js';
import type { Handler } from './module.js';
import { setErrorCode } from './observability/logging.js';
import type { Pipeline, PipelineOp } from './pipeline/index.js';

/** Per-boot auth dependencies (02-TRD §6.5). */
export interface CoreAuth {
  readonly verifier?: JwtVerifier;
  readonly claimsResolver?: ClaimsResolver | undefined;
  readonly bff: BffKeyVerifier;
  readonly clientIp: ClientIpResolver;
  readonly authResolvers?: AuthResolverRegistry;
  db?: Db | undefined;
}
interface RequestAuth {
  readonly clientIp: string;
  readonly bffKind?: BffKind;
  claims?: DbClaims;
}
const requestAuth = new WeakMap<FastifyRequest, RequestAuth>();
/** DbClaims of an authenticated request (for the request transaction, T0D-03). */
export const claimsOf = (req: FastifyRequest): DbClaims | undefined => requestAuth.get(req)?.claims;

const header = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const BEARER = /^Bearer ([^\s]+)$/i;
const SID_COOKIE = /(?:^|;\s*)__Host-lims_sid=[^;\s]{1,4096}(?=;|\s*$)/; // non-empty, <= 4096 chars

/** securityHandlers for fastify-openapi-glue. Schemes without a handler here fail closed (glue rejects the request). */
function securityHandlers(auth: CoreAuth): Record<string, (req: FastifyRequest) => Promise<void>> {
  const out: Record<string, (req: FastifyRequest) => Promise<void>> = {};
  const { verifier, claimsResolver, authResolvers, db } = auth;
  if (verifier) {
    out.bearerJwt = async (req) => {
      const m = BEARER.exec(header(req.headers.authorization) ?? '');
      if (!m) throw new AuthError('auth.unauthenticated');
      const ra = requestAuth.get(req)!;
      const { claims } = await authenticateBearer({ verifier, claimsResolver }, m[1]!, {
        clientIp: ra.clientIp, requestId: String(req.id), endpointFamily: endpointFamilyOf(req.routeOptions.url ?? '', ra.bffKind),
        ...(ra.bffKind ? { bffKey: ra.bffKind } : {}),
      });
      ra.claims = claims;
    };
  }
  // LD-212 / LD-189 / LD-206: bffSession is ALWAYS registered (no verifier needed). No DB call; the identity handlers do the session lookup.
  out.bffSession = async (req) => {
    const ok = requestAuth.get(req)?.bffKind !== undefined // verifier result from the onRequest hook, never a header read here
      && (req.routeOptions.url ?? '').startsWith('/v1/identity/auth/')
      && SID_COOKIE.test(header(req.headers.cookie) ?? '');
    if (!ok) throw new AuthError('auth.unauthenticated');
  };

  // Module auth resolvers: portalSession, patientPreAuth, queueDisplayToken, deviceToken, paymentCallbackToken
  if (authResolvers) {
    const registerResolver = (scheme: string, getCred: (req: FastifyRequest) => string | undefined, resolverKey: string = scheme) => {
      if (!authResolvers.has(resolverKey)) return;
      out[scheme] = async (req) => {
        const cred = getCred(req);
        if (!cred) throw new AuthError('auth.unauthenticated');
        const ra = requestAuth.get(req)!;
        const authenticate = async (tx: unknown) => {
          const claims = await authResolvers.authenticate(resolverKey, cred, tx);
          ra.claims = claims;
        };
        if (db?.anonymousTx) {
          await db.anonymousTx({
            requestId: String(req.id),
            clientIp: ra.clientIp,
            readOnly: true,
            operation: { module: 'core', operationId: 'authenticateResolver', context: 'internal' },
          }, async (tx) => {
            await authenticate(tx);
          });
        } else {
          await authenticate({ query: async () => ({ rows: [] }) });
        }
      };
    };

    registerResolver('portalSession', (req) => header(req.headers['x-lims-portal-credential']));
    registerResolver('patientPreAuth', (req) => header(req.headers['x-lims-patient-preauth']));
    registerResolver('applicantPreAuth', (req) => header(req.headers['x-lims-applicant-preauth']));
    registerResolver('queueDisplayToken', (req) => header(req.headers['x-lims-display-token']));
    registerResolver('deviceToken', (req) => {
      const m = BEARER.exec(header(req.headers.authorization) ?? '');
      return m ? m[1] : undefined;
    });
    registerResolver('paymentCallbackToken', (req) => {
      const p = req.params as Record<string, unknown> | undefined;
      const q = req.query as Record<string, unknown> | undefined;
      return header(p?.['callback_token']) ?? header(q?.['callback_token']);
    }, 'paymentCallback');
  }
  return out;
}

/** glue wraps handler errors in a SecurityError without a code; surface the auth error itself (one scheme list per op). */
function unwrapSecurity(pre: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await pre(req, reply);
    } catch (e) {
      const inner = (e as { errors?: unknown[] }).errors?.find((x) => x instanceof Error && 'code' in x);
      throw inner ?? new AuthError('auth.unauthenticated');
    }
  };
}

/** SP-8 O1 [CONV]. removeAdditional:false is mandatory (REQ-SEC-080). */
/** x-coded-set is annotation-only (02-CONVENTIONS.md:573); registered per lead AUTO 2026-11-07T19:16:21 (T-01). */
export const AJV_OPTIONS = {
  removeAdditional: false,
  coerceTypes: 'array',
  allErrors: true,
  // [CONV] `discriminator` (02-CONVENTIONS §479: oneOf + discriminator with explicit mapping) is annotation-only:
  // ajv's `discriminator: true` throws "mapping is not supported", so validation is the `oneOf` itself (LD-53 (2)).
  // CR-C16-024 (lead-accepted): `x-extensible` is annotation-only (02-CONVENTIONS §459); `enum` still rejects unknown values.
  // [LEAD C13.T01-01] same keyword, same rule (no validation behaviour; removeAdditional stays false).
  keywords: ['x-coded-set', 'discriminator', 'x-extensible'],
} as const;
/**
 * [CONV] coerceTypes 'array' is only for query/path/header strings (SP-8 O1); JSON bodies are typed, so a body
 * `{"name": 5}` against `type: string` is 400, not silently coerced to "5".
 */
const BODY_AJV_OPTIONS = { ...AJV_OPTIONS, coerceTypes: false } as const;
const RESPONSE_AJV_OPTIONS = { ...BODY_AJV_OPTIONS, useDefaults: false } as const;

type ValidatorFactory = (ext: object, o: { customOptions: object }) => (c: { schema: object; httpPart?: string }) => any;
const ajvPool = AjvCompiler() as unknown as ValidatorFactory;

/**
 * T0A-HEADERS-1 (LD-277, LD-278): a custom buildValidator makes Fastify skip its own header-schema lower-casing,
 * so `required: [Idempotency-Key]` never matched Node's `idempotency-key`. Copy with top-level `properties` keys
 * and `required` entries lower-cased (same as Fastify lowerCaseHeadersSchema); the input schema is not mutated.
 */
function lowerCaseHeaders(schema: any): object {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { ...schema };
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k.toLowerCase(), v]));
  }
  if (Array.isArray(schema.required)) out.required = schema.required.map((n: unknown) => (typeof n === 'string' ? n.toLowerCase() : n));
  return out;
}

/** Fastify `schemaController`: Fastify's own ajv compiler (formats included), body without coercion. */
export const schemaController: NonNullable<FastifyServerOptions['schemaController']> = {
  compilersFactory: {
    buildValidator: ((ext: object) => {
      const coercing = ajvPool(ext, { customOptions: AJV_OPTIONS });
      const strict = ajvPool(ext, { customOptions: BODY_AJV_OPTIONS });
      return (c: { schema: object; httpPart?: string }) => {
        if (c.httpPart === 'body') return strict(c);
        if (c.httpPart === 'headers') return coercing({ ...c, schema: lowerCaseHeaders(c.schema) });
        return coercing(c);
      };
    }) as any,
  },
};

/** Deep copy of a response schema without `required` arrays (property names called "required" are kept). */
function withoutRequired(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(withoutRequired);
  if (!s || typeof s !== 'object') return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'required' && Array.isArray(v)) continue;
    out[k] = k === 'properties' && v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, withoutRequired(ps)]))
      : withoutRequired(v);
  }
  return out;
}

export class ResponseContractError extends LimsError {
  constructor() {
    super('common.internal');
  }
}

/** Register before any spec is mounted: O2 + O4 are applied per route in onRoute. */
export function installRouteHooks(app: FastifyInstance, opts: { responseValidation: boolean; auth: CoreAuth }): void {
  const compile = ajvPool({}, { customOptions: RESPONSE_AJV_OPTIONS });
  // ctx.clientIp + BFF kind for every request (P-61, D-32). req.ip is the TCP peer: Fastify trustProxy stays off.
  app.addHook('onRequest', async (req) => {
    const bffKind = opts.auth.bff.verify(req.headers['x-lims-bff-key']);
    const clientIp = opts.auth.clientIp({ peer: req.ip, forwardedFor: header(req.headers['x-forwarded-for']), bffKind });
    requestAuth.set(req, bffKind ? { clientIp, bffKind } : { clientIp });
  });
  app.addHook('onRoute', (route: RouteOptions) => {
    const schema = route.schema as any;
    if (!schema?.operationId) return; // not a spec route
    if (typeof route.preHandler === 'function') route.preHandler = unwrapSecurity(route.preHandler as any) as any; // glue security
    // O2: unknown query params -> 400. Never on headers (proxies add headers).
    if (schema.querystring && typeof schema.querystring === 'object') schema.querystring.additionalProperties = false;
    else schema.querystring = { type: 'object', properties: {}, additionalProperties: false };
    // O4: compile once at boot, from the spec as written.
    const validators = new Map<string, (v: unknown) => boolean>();
    if (opts.responseValidation) {
      for (const [status, s] of Object.entries<any>(schema.response ?? {})) {
        const body = s?.content?.['application/json']?.schema; // glue shape: { content: { <mime>: { schema } } }
        if (body && typeof body === 'object') validators.set(status, compile({ schema: body }));
      }
    }
    // [CONV] The serializer only strips undeclared fields; it never 500s on a missing `required` field. Contract
    // checking is solely the toggle below, so "off" really means no check (SP-8 O4), and stripping stays on in production.
    // problem+json bodies are built by errors.ts (always a valid Problem); a declared schema would make the serializer strip them.
    for (const [status, s] of Object.entries<any>(schema.response ?? {})) {
      if (!s?.content?.['application/problem+json']) continue;
      delete s.content['application/problem+json'];
      if (Object.keys(s.content).length === 0) delete schema.response[status];
    }
    if (schema.response) schema.response = withoutRequired(schema.response);
    if (!opts.responseValidation) return;
    // Mismatch -> 500 common.internal + log response_contract_violation (02-TRD §6.2 stage 12).
    const operationId: string = schema.operationId;
    const hook = async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
      if (isRenderedProblem(payload)) return payload; // core-built Problem (errors.ts), valid by construction
      const v = validators.get(String(reply.statusCode)) ?? validators.get('default');
      if (v && v(payload)) return payload;
      // No data in the log: only the operation, status and failing schema paths.
      const errors: Array<{ instancePath: string; keyword: string }> = (v as any)?.errors ?? [];
      req.log.error(
        { event: 'response_contract_violation', operationId, status: reply.statusCode,
          errors: errors.map((e) => `${e.instancePath} ${e.keyword}`) },
        'response_contract_violation',
      );
      throw new ResponseContractError();
    };
    const existing = route.preSerialization;
    route.preSerialization = [...(existing ? (Array.isArray(existing) ? existing : [existing]) : []), hook] as any;
  });
}

/** The spec operation object + its path/method. */
function findOp(spec: any, operationId: string): { path: string; method: string; op: any } | undefined {
  for (const [path, item] of Object.entries<any>(spec?.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(item ?? {})) if (op?.operationId === operationId) return { path, method, op };
  }
  return undefined;
}

/** First security scheme name of an operation's (or the document's) `security` list; undefined when none. */
function firstScheme(security: unknown): string | undefined {
  const first = Array.isArray(security) ? security[0] : undefined;
  return first && typeof first === 'object' ? Object.keys(first)[0] : undefined;
}

/** Pipeline view of one operation (x-public, x-context, x-idempotency, x-rate-limit-tier; 02-CV §4). */
function pipelineOp(module: string, spec: any, operationId: string): PipelineOp {
  const f = findOp(spec, operationId);
  const op = f?.op ?? {};
  const context = typeof op['x-context'] === 'string' ? op['x-context'] : undefined;
  return Object.freeze({
    module, operationId, method: (f?.method ?? '').toUpperCase(), routeTemplate: f?.path ?? '',
    public: op['x-public'] !== undefined, identityAuth: context === 'identity_auth', context,
    idempotency: op['x-idempotency'], rateLimitTier: op['x-rate-limit-tier'],
    permission: typeof op['x-permission'] === 'string' ? op['x-permission'] : undefined, // SEC-AUTHZ-2: stage 8a
    scheme: firstScheme(op.security ?? spec?.security),
  });
}

/** Wrap a module handler: stages 5-11 run in the pipeline; HandlerResult { status, body, headers } is applied to the reply (SP-8 O3). */
function wrap(op: PipelineOp, h: Handler, errorCodes: readonly string[], pipeline: Pipeline) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ra = requestAuth.get(req);
    const r = await pipeline.run({
      op, claims: ra?.claims, requestId: String(req.id), clientIp: ra?.clientIp ?? req.ip,
      bffKey: ra?.bffKind, // LD-206: only the verifier's result for X-Lims-Bff-Key; never a body/query/cookie field
      userAgent: header(req.headers['user-agent']), idempotencyKey: header(req.headers['idempotency-key']),
      req: { params: req.params, query: req.query, headers: req.headers, body: req.body }, handler: h, log: req.log,
    });
    // A non-Problem error result (e.g. readiness 503) logs the declared x-error-codes entry for its status.
    if (r.status >= 400) {
      const code = errorCodes.find((c) => new LimsError(c).statusCode === r.status);
      if (code) setErrorCode(req, code);
    }
    if (r.headers) reply.headers(r.headers);
    reply.code(r.status);
    return reply.send(r.body);
  };
}

/** True if any operation (or the document default) requires `scheme`. */
function usesScheme(spec: any, scheme: string): boolean {
  const has = (sec: unknown) => Array.isArray(sec) && sec.some((r) => r && Object.hasOwn(r, scheme));
  return has(spec?.security) || Object.values<any>(spec?.paths ?? {}).some((item) => Object.values<any>(item ?? {}).some((op) => has(op?.security)));
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/**
 * T0C-SYNC-1 (LD-322, LD-325): copy of `spec` without the pending operations that require bearerJwt. Used only when no JWT
 * verifier is configured: such an operation could never pass auth, so it gets no route at all (fail closed, 404) instead of
 * blocking a boot that mounts the core health operations. A bearerJwt operation with a real handler still needs JWT config.
 */
export function withoutPendingBearer(spec: any, pending: readonly string[]): any {
  if (!pending.length) return spec;
  const needsBearer = (op: any) => (op?.security ?? spec?.security ?? []).some((r: any) => r && Object.hasOwn(r, 'bearerJwt'));
  const paths: Record<string, any> = {};
  for (const [p, item] of Object.entries<any>(spec?.paths ?? {})) {
    const kept = Object.fromEntries(Object.entries<any>(item ?? {}).filter(([k, op]) =>
      !(HTTP_METHODS.has(k) && pending.includes(op?.operationId) && needsBearer(op))));
    if (Object.keys(kept).some((k) => HTTP_METHODS.has(k))) paths[p] = kept;
  }
  return { ...spec, paths };
}

/** Local `#/...` ref -> target (loadSpec makes every ref local). */
function deref(spec: any, v: any): any {
  for (let i = 0; i < 10 && typeof v?.$ref === 'string' && v.$ref.startsWith('#/'); i++) {
    v = v.$ref.slice(2).split('/').reduce((o: any, k: string) => o?.[k.replaceAll('~1', '/').replaceAll('~0', '~')], spec);
  }
  return v;
}

/**
 * T0D-FIX-1 item 1 (LD-446, CR DEPLOY-AXIS-012 item 2): names of the `in: query`, `explode: false` array parameters of one
 * operation (path-level and operation-level). Only these are split at commas; a default-explode array keeps a comma as data.
 */
export function csvQueryParams(spec: any, operationId: string): string[] {
  const f = findOp(spec, operationId);
  if (!f) return [];
  const all = [...(spec?.paths?.[f.path]?.parameters ?? []), ...(f.op?.parameters ?? [])].map((p) => deref(spec, p));
  return all
    .filter((p) => p?.in === 'query' && p.explode === false && deref(spec, p.schema)?.type === 'array' && typeof p.name === 'string')
    .map((p) => p.name as string);
}

/** Split once at commas, before validation; repeated parameters are flattened. Empty elements are kept so validation rejects them. */
export function splitCsvQuery(query: Record<string, unknown>, names: readonly string[]): void {
  for (const n of names) {
    const v = query[n];
    if (typeof v === 'string') query[n] = v.split(',');
    else if (Array.isArray(v)) query[n] = v.flatMap((x) => (typeof x === 'string' ? x.split(',') : [x]));
  }
}

/** Mount one spec. A missing handler throws in operationResolver, so register (and boot) fails (SP-8 O3). */
export async function mountSpec(
  app: FastifyInstance,
  name: string,
  spec: object,
  handlers: Readonly<Record<string, Handler>>,
  auth: CoreAuth,
  pipeline: Pipeline,
  pending: readonly string[] = [],
): Promise<void> {
  if (!auth.verifier) spec = withoutPendingBearer(spec, pending);
  if (!auth.verifier && usesScheme(spec, 'bearerJwt')) throw new Error(`module ${name}: bearerJwt operations need LIMS_CORE_JWT_* config`);
  await app.register(async (scope) => {
    // route config.module labels the stage-13 log line and metrics (observability/logging.ts).
    scope.addHook('onRoute', (route) => {
      route.config = { ...(route.config as object), module: name };
      const names = csvQueryParams(spec, (route.schema as any)?.operationId);
      if (!names.length) return;
      // preValidation runs before the querystring schema, so enum / maxLength / maxItems apply per split element.
      const split = async (req: FastifyRequest) => { if (req.query && typeof req.query === 'object') splitCsvQuery(req.query as Record<string, unknown>, names); };
      const existing = route.preValidation;
      route.preValidation = [split, ...(existing ? (Array.isArray(existing) ? existing : [existing]) : [])] as any;
    });
    await scope.register(openapiGlue, {
      specification: spec,
      securityHandlers: securityHandlers(auth),
      operationResolver: (operationId: string) => {
        const op = pipelineOp(name, spec, operationId);
        let h = Object.hasOwn(handlers, operationId) ? handlers[operationId] : undefined;
        // LD-325 (T0B-BOOTGATE-1): a pending id without a handler gets a 501 stub run inside the normal pipeline (auth,
        // validation, permission, tenant unchanged). A real handler always wins over a stale entry.
        if (typeof h !== 'function' && pending.includes(operationId)) {
          h = async (_req, ctx) => ({
            status: 501, headers: { 'content-type': 'application/problem+json' },
            body: pendingProblem(operationId, op.routeTemplate, ctx.requestId),
          });
        }
        if (typeof h !== 'function') throw new Error(`module ${name}: missing handler for operationId ${operationId}`);
        return wrap(op, h, findOp(spec, operationId)?.op?.['x-error-codes'] ?? [], pipeline);
      },
    });
  });
}
