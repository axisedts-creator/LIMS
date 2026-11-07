// Mounts module specs through fastify-openapi-glue 4.12.0 with the SP-8 obligations (db/meta/decisions/SP-8.md):
// O1 ajv options (bootstrap.ts), O2 strict query, O3 boot-time handler check via operationResolver, O4 response validation.
// O5 error mapping is T0D-04 (core/errors.ts); security handlers are T0D-02 (core/auth/**).
import { AjvCompiler } from '@fastify/ajv-compiler';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions, RouteOptions } from 'fastify';
import openapiGlue from 'fastify-openapi-glue';
import type { Handler, HandlerContext } from './module.js';

/** SP-8 O1 [CONV]. removeAdditional:false is mandatory (REQ-SEC-080). */
export const AJV_OPTIONS = { removeAdditional: false, coerceTypes: 'array', allErrors: true } as const;
/**
 * [CONV] coerceTypes 'array' is only for query/path/header strings (SP-8 O1); JSON bodies are typed, so a body
 * `{"name": 5}` against `type: string` is 400, not silently coerced to "5".
 */
const BODY_AJV_OPTIONS = { ...AJV_OPTIONS, coerceTypes: false } as const;
const RESPONSE_AJV_OPTIONS = { ...BODY_AJV_OPTIONS, useDefaults: false } as const;

type ValidatorFactory = (ext: object, o: { customOptions: object }) => (c: { schema: object; httpPart?: string }) => any;
const ajvPool = AjvCompiler() as unknown as ValidatorFactory;

/** Fastify `schemaController`: Fastify's own ajv compiler (formats included), body without coercion. */
export const schemaController: NonNullable<FastifyServerOptions['schemaController']> = {
  compilersFactory: {
    buildValidator: ((ext: object) => {
      const coercing = ajvPool(ext, { customOptions: AJV_OPTIONS });
      const strict = ajvPool(ext, { customOptions: BODY_AJV_OPTIONS });
      return (c: { schema: object; httpPart?: string }) => (c.httpPart === 'body' ? strict(c) : coercing(c));
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

export class ResponseContractError extends Error {
  readonly statusCode = 500;
  readonly code = 'common.internal';
  constructor() {
    super('common.internal');
  }
}

/** Register before any spec is mounted: O2 + O4 are applied per route in onRoute. */
export function installRouteHooks(app: FastifyInstance, opts: { responseValidation: boolean }): void {
  const compile = ajvPool({}, { customOptions: RESPONSE_AJV_OPTIONS });
  app.addHook('onRoute', (route: RouteOptions) => {
    const schema = route.schema as any;
    if (!schema?.operationId) return; // not a spec route
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
    if (schema.response) schema.response = withoutRequired(schema.response);
    if (!opts.responseValidation) return;
    // Mismatch -> 500 common.internal + log response_contract_violation (02-TRD §6.2 stage 12).
    const operationId: string = schema.operationId;
    const hook = async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
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

/** Wrap a module handler: HandlerResult { status, body, headers } is applied to the reply (SP-8 O3). */
function wrap(operationId: string, h: Handler) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx: HandlerContext = { operationId, log: req.log };
    const r = await h({ params: req.params, query: req.query, headers: req.headers, body: req.body }, ctx);
    if (r.headers) reply.headers(r.headers);
    reply.code(r.status);
    return reply.send(r.body);
  };
}

/** Mount one spec. A missing handler throws in operationResolver, so register (and boot) fails (SP-8 O3). */
export async function mountSpec(
  app: FastifyInstance,
  name: string,
  spec: object,
  handlers: Readonly<Record<string, Handler>>,
): Promise<void> {
  await app.register(openapiGlue, {
    specification: spec,
    operationResolver: (operationId: string) => {
      const h = Object.hasOwn(handlers, operationId) ? handlers[operationId] : undefined;
      if (typeof h !== 'function') throw new Error(`module ${name}: missing handler for operationId ${operationId}`);
      return wrap(operationId, h);
    },
  });
}
