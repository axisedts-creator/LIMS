// T0A-HEADERS-1 (LD-277, LD-278): required mixed-case header parameters must validate.
// Node delivers header names in lower case; the core schemaController's custom buildValidator makes Fastify skip its own
// lowerCaseHeadersSchema, so a schema that requires `Idempotency-Key` never matches `idempotency-key` -> 400 for every
// idempotent create and every If-Match save. Fix lives in core/openapi.ts (headers validator compile only).
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { installErrorHandlers } from '../errors.js';
import { schemaController } from '../openapi.js';

const open: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((a) => a.close())); });

// The three header kinds named in the brief, written mixed-case exactly as the contracts write them.
const HEADERS_SCHEMA = {
  type: 'object',
  properties: {
    'Idempotency-Key': { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]{1,64}$' },
    'If-Match': { type: 'string', maxLength: 12, pattern: '^"[1-9][0-9]*"$' },
    'X-Lims-App-Instance': { type: 'string', minLength: 1, maxLength: 36 },
    'X-Request-Id': { type: 'string', maxLength: 36 }, // optional, mixed-case
  },
  required: ['Idempotency-Key', 'If-Match', 'X-Lims-App-Instance'],
} as const;

const GOOD = { 'idempotency-key': 'abc_123-XYZ', 'if-match': '"3"', 'x-lims-app-instance': 'inst-1' };

async function app(headers: object = HEADERS_SCHEMA): Promise<FastifyInstance> {
  const a = Fastify({ schemaController });
  installErrorHandlers(a);
  a.post('/t', { schema: { headers: structuredClone(headers) as any } }, async () => ({ ok: true }));
  a.post('/b', { schema: { body: { type: 'object', additionalProperties: false, required: ['Name'], properties: { Name: { type: 'string' } } } } }, async () => ({ ok: true }));
  a.get('/q', { schema: { querystring: { type: 'object', additionalProperties: false, required: ['Limit'], properties: { Limit: { type: 'integer' } } } } }, async () => ({ ok: true }));
  await a.ready();
  open.push(a);
  return a;
}

const post = (a: FastifyInstance, headers: Record<string, string>) => a.inject({ method: 'POST', url: '/t', headers, payload: {} });

describe('required mixed-case header parameters (T0A-HEADERS-1)', () => {
  it('request with the required headers in lower case (as Node delivers them) is accepted', async () => {
    const r = await post(await app(), GOOD);
    expect(r.statusCode, r.body).toBe(200);
  });

  it('mixed-case names in the request give the same result as lower-case ones', async () => {
    const a = await app();
    const mixed = { 'Idempotency-Key': 'abc_123-XYZ', 'If-Match': '"3"', 'X-Lims-App-Instance': 'inst-1' };
    expect((await post(a, mixed)).statusCode).toBe(200);
    expect((await post(a, GOOD)).statusCode).toBe(200);
  });

  it('mixed-case and lower-case names in the schema give the same result', async () => {
    const lower = {
      type: 'object',
      properties: Object.fromEntries(Object.entries(HEADERS_SCHEMA.properties).map(([k, v]) => [k.toLowerCase(), v])),
      required: HEADERS_SCHEMA.required.map((k) => k.toLowerCase()),
    };
    const r = await post(await app(lower), GOOD);
    expect(r.statusCode, r.body).toBe(200);
  });

  it.each(['idempotency-key', 'if-match', 'x-lims-app-instance'])('missing %s -> 400 common.validation_failed naming that header', async (missing) => {
    const headers: Record<string, string> = { ...GOOD };
    delete headers[missing];
    const r = await post(await app(), headers);
    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.code).toBe('common.validation_failed');
    expect(JSON.stringify(body.errors).toLowerCase()).toContain(missing);
  });

  it('invalid values still 400: Idempotency-Key over 64 chars, If-Match not a quoted version', async () => {
    const a = await app();
    const long = await post(a, { ...GOOD, 'idempotency-key': 'k'.repeat(65) });
    expect(long.statusCode).toBe(400);
    expect(long.json().code).toBe('common.validation_failed');
    expect((await post(a, { ...GOOD, 'if-match': '3' })).statusCode).toBe(400);
    // an optional mixed-case header is validated too (properties keys are lower-cased, not only `required`)
    expect((await post(a, { ...GOOD, 'x-request-id': 'r'.repeat(37) })).statusCode).toBe(400);
    expect((await post(a, { ...GOOD, 'x-request-id': 'r'.repeat(36) })).statusCode).toBe(200);
  });

  it('body and querystring validators are unchanged: mixed-case names stay case-sensitive', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/b', payload: { Name: 'a' } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'POST', url: '/b', payload: { name: 'a' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'GET', url: '/q?Limit=5' })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/q?limit=5' })).statusCode).toBe(400);
  });

  it('the validator does not mutate the schema it was given', async () => {
    const schema = structuredClone(HEADERS_SCHEMA);
    const a = Fastify({ schemaController });
    installErrorHandlers(a);
    a.post('/t', { schema: { headers: schema as any } }, async () => ({ ok: true }));
    await a.ready();
    open.push(a);
    await a.inject({ method: 'POST', url: '/t', headers: GOOD, payload: {} });
    expect(schema.required).toEqual(['Idempotency-Key', 'If-Match', 'X-Lims-App-Instance']);
    expect(Object.keys(schema.properties)).toContain('Idempotency-Key');
  });
});
