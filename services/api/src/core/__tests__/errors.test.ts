// T0D-04 — errors -> problem+json. AC-0D-3.1, REQ-SEC-095 (+ REQ-SEC-098 no PHI in URLs/bodies), 02-CV §4.6, 02-TRD §6.2 stage 12.
// Interface these tests expect from impl (documented in .orchestra/notes/T0D-04-tests.md):
//   core/errors.ts exports  LimsError(code, detail?, errors?: FieldError[])   extends Error; fields code, statusCode (= errors.yaml http),
//                                       detail, errors, retryAfterSeconds (plain writable property, set by the thrower)
//                           toProblem(err: unknown, instance: string, requestId: string): Problem     (02-TRD §3 shared-ts/errors shape)
//                           isLimsError(e: unknown, code?: string): e is LimsError
//   bootstrap() installs the Fastify error handler + not-found handler itself: every non-2xx reply is application/problem+json.
//   Fixture module: __tests__/fixtures/errors/{modules,root}. Its handlers throw all kinds of things; most spec ops declare no error responses.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AjvCompiler } from '@fastify/ajv-compiler';
import type { FastifyInstance } from 'fastify';
import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../bootstrap.js';
import { loadConfig } from '../config.js';
import { REPO_ROOT } from '../module.js';
import { LimsError, isLimsError, toProblem } from '../errors.js';

// ---------- registry + Problem schema, read from the real contracts (not copied) ----------
interface Entry { code: string; http: number; title: string; retired?: boolean }
const REGISTRY = parse(readFileSync(join(REPO_ROOT, 'contracts', 'errors.yaml'), 'utf8')) as Entry[];
const BY_CODE = new Map(REGISTRY.map((e) => [e.code, e]));
const common = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', '_common.yaml'), 'utf8')) as { components: { schemas: Record<string, unknown> } };
// Problem refs '#/components/schemas/X'; compile it standalone with the refs re-rooted at $defs.
const problemSchema = {
  $defs: JSON.parse(JSON.stringify(common.components.schemas).replaceAll('#/components/schemas/', '#/$defs/')),
  $ref: '#/$defs/Problem',
};
const ajv = AjvCompiler() as unknown as (e: object, o: { customOptions: object }) => (c: { schema: object }) => ((v: unknown) => boolean) & { errors?: unknown };
const validateProblem = ajv({}, { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: true } })({ schema: problemSchema });

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GOOD_RID = '0190a000-0000-7000-8000-0000000000a1';
const LEAKY_FRAGMENTS = ['SELECT', 'core.patients', '/srv/lims', 'db.js', 'node_modules', 'at Object', 'fk_', 'violates', 'orders', 'synthetic', '.ts:', 'C:\\'];

/** Fails (with the offending body) unless `body` is a Problem, registry-backed and leak-free. Returns the parsed body. */
function expectProblem(res: { statusCode: number; headers: Record<string, unknown>; body: string }, want?: { status?: number; code?: string }): any {
  expect(String(res.headers['content-type'])).toMatch(/^application\/problem\+json\b/);
  const body = JSON.parse(res.body);
  expect(validateProblem(body), JSON.stringify([body, validateProblem.errors])).toBe(true);
  expect(body.status).toBe(res.statusCode);
  const reg = BY_CODE.get(body.code);
  expect(reg, `code ${String(body.code)} must exist in errors.yaml`).toBeDefined();
  expect(reg!.http).toBe(res.statusCode);
  expect(body.type).toBe(`urn:lims:error:${body.code}`);
  expect(body.title).toBe(reg!.title);
  expect(res.statusCode).toBeGreaterThanOrEqual(400);
  for (const f of LEAKY_FRAGMENTS) expect(res.body, `leaked "${f}"`).not.toContain(f);
  expect(res.body).not.toMatch(/\bstack\b|\n\s+at /i);
  if (want?.status !== undefined) expect(res.statusCode).toBe(want.status);
  if (want?.code !== undefined) expect(body.code).toBe(want.code);
  return body;
}

// ---------- app under test (both response-validation settings: error replies bypass/satisfy stage 12 either way) ----------
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'errors');
const apps: FastifyInstance[] = [];
async function boot(responseValidation: 'on' | 'off'): Promise<FastifyInstance> {
  const config = loadConfig({ LIMS_CORE_ENV: 'ci', LIMS_CORE_RESPONSE_VALIDATION: responseValidation });
  const app = await bootstrap({ config, repoRoot: join(ROOT, 'root'), modulesDir: join(ROOT, 'modules') });
  apps.push(app);
  return app;
}
afterAll(async () => { await Promise.all(apps.map((a) => a.close())); });

// ---------- unit: LimsError / toProblem ----------
describe('LimsError + toProblem (unit)', () => {
  it('LimsError carries the registry code and http status', () => {
    const e = new LimsError('common.not_found');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('common.not_found');
    expect(e.statusCode).toBe(404);
    expect(isLimsError(e)).toBe(true);
    expect(isLimsError(e, 'common.not_found')).toBe(true);
    expect(isLimsError(e, 'common.internal')).toBe(false);
    expect(isLimsError(new Error('x'))).toBe(false);
    expect(isLimsError(null)).toBe(false);
  });

  it('every registry code maps to its http status and a valid Problem', () => {
    for (const e of REGISTRY) {
      const p = toProblem(new LimsError(e.code), '/v1/x', GOOD_RID) as any;
      expect(validateProblem(p), `${e.code}: ${JSON.stringify(validateProblem.errors)}`).toBe(true);
      expect([p.code, p.status, p.title, p.type, p.request_id]).toEqual([e.code, e.http, e.title, `urn:lims:error:${e.code}`, GOOD_RID]);
    }
  });

  it('detail + instance pass through; errors[] only for common.validation_failed', () => {
    const fe = [{ path: '/name', code: 'common.field_required', message: 'name is required' }];
    const v = toProblem(new LimsError('common.validation_failed', 'Request validation failed', fe), '/v1/lab/specimens', GOOD_RID) as any;
    expect(v).toMatchObject({ code: 'common.validation_failed', status: 400, detail: 'Request validation failed', instance: '/v1/lab/specimens', errors: fe });
    const n = toProblem(new LimsError('common.not_found', 'Specimen not found', fe), '/v1/lab/specimens', GOOD_RID) as any;
    expect(n.detail).toBe('Specimen not found');
    expect('errors' in n).toBe(false); // 02-CV §4.6: errors[] only for validation
  });

  // LD-153 (CR-C9-T15a): registry codes whose meaning is "validation errors in errors[]" render errors[] too.
  it.each([['quality.rule_set_invalid'], ['smartreport.library_invalid']])('LD-153: %s -> 422 with errors[] JSON Pointer', (code) => {
    const fe = [{ path: '/definition/rules/0/limits', code: 'common.field_invalid', message: 'low > high' }];
    const p = toProblem(new LimsError(code, undefined, fe), '/x', GOOD_RID) as any;
    expect(p.status).toBe(422);
    expect(p.errors[0].path).toBe('/definition/rules/0/limits');
  });

  it('LD-153: a non-listed code (common.not_found) still has no errors[]', () => {
    const fe = [{ path: '/definition/rules/0/limits', code: 'common.field_invalid', message: 'low > high' }];
    const p = toProblem(new LimsError('common.not_found', undefined, fe), '/x', GOOD_RID) as any;
    expect('errors' in p).toBe(false);
  });

  it('unknown internal failures are 500 common.internal with request_id only (no message, no stack)', () => {
    const err = Object.assign(new Error('SELECT * FROM core.patients /srv/lims/api/dist/db.js:12:3'), { code: '23503', constraint: 'fk_secret' });
    const p = toProblem(err, '/v1/x', GOOD_RID) as any;
    expect(validateProblem(p)).toBe(true);
    expect([p.status, p.code, p.request_id]).toEqual([500, 'common.internal', GOOD_RID]);
    const s = JSON.stringify(p);
    for (const f of ['SELECT', 'core.patients', '/srv', 'fk_secret', '23503']) expect(s).not.toContain(f);
  });

  it.each([['string', 'SELECT 1'], ['null', null], ['undefined', undefined], ['number', 42], ['object', { code: 'common.not_found', statusCode: 404 }]])(
    'non-Error throwable (%s) -> 500 common.internal', (_n, v) => {
      const p = toProblem(v, '/v1/x', GOOD_RID) as any;
      expect(validateProblem(p)).toBe(true);
      expect([p.status, p.code]).toEqual([500, 'common.internal']);
    });

  it('a code that is not in errors.yaml never reaches the client (fail closed to common.internal)', () => {
    const p = toProblem(new LimsError('zzz.not_registered'), '/v1/x', GOOD_RID) as any;
    expect(validateProblem(p)).toBe(true);
    expect([p.status, p.code]).toEqual([500, 'common.internal']);
    expect(JSON.stringify(p)).not.toContain('zzz');
  });

  it('a status < 400 on a thrown error is never echoed: still a 4xx/5xx Problem', () => {
    const p = toProblem(Object.assign(new Error('x'), { statusCode: 200 }), '/v1/x', GOOD_RID) as any;
    expect(validateProblem(p)).toBe(true);
    expect(p.status).toBeGreaterThanOrEqual(400);
  });

  it('oversized pieces are clamped so the result still validates Problem (200 errors, 500/512/2000/2048 chars)', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ path: `/${'p'.repeat(2000)}${i}`, code: 'common.field_invalid', message: 'm'.repeat(2000) }));
    const p = toProblem(new LimsError('common.validation_failed', 'd'.repeat(5000), many), `/${'i'.repeat(6000)}`, GOOD_RID) as any;
    expect(validateProblem(p), JSON.stringify(validateProblem.errors)).toBe(true);
    expect(p.errors.length).toBeLessThanOrEqual(200);
  });

  it('a malformed request id is never copied into the body', () => {
    const p = toProblem(new LimsError('common.not_found'), '/v1/x', 'not-a-uuid\r\nX-Evil: 1') as any;
    expect(JSON.stringify(p)).not.toContain('X-Evil');
    expect(validateProblem(p)).toBe(true);
    expect(p.request_id).toMatch(UUIDV7);
  });
});

// ---------- integration: the real bootstrap ----------
describe.each(['on', 'off'] as const)('AC-0D-3.1 every non-2xx is a registry-backed Problem (response validation %s)', (rv) => {
  let app: FastifyInstance;
  const get = async (url: string, headers: Record<string, string> = {}) => (app ??= await boot(rv), app).inject({ method: 'GET', url, headers });
  const post = async (url: string, payload: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    (app ??= await boot(rv), app).inject({ method: 'POST', url, headers, payload: payload as any });

  // T-01 ruling: first boot gets 30000 ms headroom (default 5000 ms is a harness assumption under parallel load).
  it('every code in errors.yaml thrown as LimsError -> its http status, code, title, type', { timeout: 30000 }, async () => {
    for (const e of REGISTRY) {
      const res = await get(`/v1/catalog/lims/${e.code}`);
      const b = expectProblem(res, { status: e.http, code: e.code });
      expect(b.request_id).toMatch(UUIDV7);
    }
  });

  it('unexpected Error with SQL / file path / stack in its message -> 500 common.internal, nothing leaked', async () => {
    const res = await get('/v1/catalog/boom');
    const b = expectProblem(res, { status: 500, code: 'common.internal' });
    expect(b.errors).toBeUndefined();
  });

  it('LimsError detail is returned; instance is the request path', async () => {
    const b = expectProblem(await get('/v1/catalog/detail'), { status: 404, code: 'common.not_found' });
    expect(b.detail).toBe('Specimen not found');
    expect(b.instance).toBe('/v1/catalog/detail');
  });

  it('instance never carries the query string (REQ-SEC-098: no PHI in URLs)', async () => {
    const res = await get('/v1/catalog/query?limit=abc&patient=SYNTHETIC-NAME');
    const b = expectProblem(res, { status: 400, code: 'common.validation_failed' });
    expect(b.instance).toBe('/v1/catalog/query');
    expect(res.body).not.toContain('SYNTHETIC-NAME');
  });

  it('429 rate_limited carries Retry-After in seconds', async () => {
    const res = await get('/v1/catalog/retry');
    expectProblem(res, { status: 429, code: 'common.rate_limited' });
    expect(res.headers['retry-after']).toBe('7');
  });

  it('LimsError with errors[] keeps them (validation_failed only)', async () => {
    const b = expectProblem(await get('/v1/catalog/fielderrors'), { status: 400, code: 'common.validation_failed' });
    expect(b.errors).toEqual([{ path: '/reason_code', code: 'common.field_required', message: 'reason_code is required' }]);
  });

  it('declared 404 problem+json response + response validation: same Problem', async () => {
    expectProblem(await get('/v1/catalog/declared'), { status: 404, code: 'common.not_found' });
  });

  describe('spec validation errors (stage 3) -> 400 common.validation_failed with JSON-pointer errors[]', () => {
    const POINTER = /^(\/[^/]*)*$/;
    const sub = new Set(['common.field_required', 'common.field_invalid', 'common.unknown_field']);

    it('missing required field', async () => {
      const b = expectProblem(await post('/v1/catalog/validate', {}), { status: 400, code: 'common.validation_failed' });
      expect(b.errors).toContainEqual(expect.objectContaining({ path: '/name', code: 'common.field_required' }));
    });
    it('unknown field (REQ-SEC-080)', async () => {
      const b = expectProblem(await post('/v1/catalog/validate', { name: 'a', extra: 1 }), { status: 400, code: 'common.validation_failed' });
      expect(b.errors).toContainEqual(expect.objectContaining({ path: '/extra', code: 'common.unknown_field' }));
    });
    it('wrong type and out-of-range value', async () => {
      const b = expectProblem(await post('/v1/catalog/validate', { name: 5, qty: 99 }), { status: 400, code: 'common.validation_failed' });
      expect(b.errors).toContainEqual(expect.objectContaining({ path: '/name', code: 'common.field_invalid' }));
      expect(b.errors).toContainEqual(expect.objectContaining({ path: '/qty', code: 'common.field_invalid' }));
    });
    it('every errors[] entry: JSON-pointer path, sub-code from the registry, no submitted value echoed', async () => {
      const secret = 'SYNTHETIC-PERSON-NAME-FAR-TOO-LONG-VALUE';
      const res = await post('/v1/catalog/validate', { name: secret, qty: 'SYNTHETIC-QTY-TEXT', zzz: 'SYNTHETIC-EXTRA-VALUE' });
      const b = expectProblem(res, { status: 400, code: 'common.validation_failed' });
      expect(b.errors.length).toBeGreaterThan(0);
      for (const e of b.errors) {
        expect(e.path).toMatch(POINTER);
        expect(sub.has(e.code), e.code).toBe(true);
        expect(BY_CODE.has(e.code)).toBe(true);
      }
      for (const v of [secret, 'SYNTHETIC-QTY-TEXT', 'SYNTHETIC-EXTRA-VALUE']) expect(res.body).not.toContain(v);
    });
    it('bad query value and unknown query parameter (SP-8 O2)', async () => {
      const a = expectProblem(await get('/v1/catalog/query?limit=abc'), { status: 400, code: 'common.validation_failed' });
      expect(a.errors.some((e: any) => e.path.endsWith('limit'))).toBe(true);
      const u = expectProblem(await get('/v1/catalog/query?bogus=1'), { status: 400, code: 'common.validation_failed' });
      expect(u.errors).toContainEqual(expect.objectContaining({ code: 'common.unknown_field' }));
      expect(u.errors.some((e: any) => e.path.endsWith('bogus'))).toBe(true);
    });
    it('malformed JSON body', async () => {
      expectProblem(await post('/v1/catalog/echo', '{"name":'), { status: 400, code: 'common.validation_failed' });
    });
    it('empty body where one is required', async () => {
      expectProblem(await post('/v1/catalog/validate', ''), { status: 400, code: 'common.validation_failed' });
    });
  });

  describe('transport-level failures raised by Fastify itself are Problems too', () => {
    it('unknown route -> 404 common.not_found, instance = path only', async () => {
      const res = await get('/v1/nope/at/all?patient=SYNTHETIC-NAME');
      const b = expectProblem(res, { status: 404, code: 'common.not_found' });
      expect(b.instance).toBe('/v1/nope/at/all');
      expect(res.body).not.toContain('SYNTHETIC-NAME');
    });
    it('unsupported method on a known path -> a registry Problem (404 or 405)', async () => {
      const res = await (app ??= await boot(rv), app).inject({ method: 'PATCH', url: '/v1/catalog/boom' });
      expect([404, 405]).toContain(res.statusCode);
      expectProblem(res);
    });
    it('body over the 1 MB default limit -> 413 common.payload_too_large', async () => {
      expectProblem(await post('/v1/catalog/echo', JSON.stringify({ name: 'x'.repeat(1_200_000) })), { status: 413, code: 'common.payload_too_large' });
    });
    it('non-JSON content type -> 415 common.unsupported_media_type', async () => {
      expectProblem(await post('/v1/catalog/echo', 'name=x', { 'content-type': 'text/plain' }), { status: 415, code: 'common.unsupported_media_type' });
    });
  });

  describe('thrown values that must fail closed', () => {
    it.each(['string', 'null', 'undefined', 'number', 'status200', 'status302', 'unregistered', 'leaky500'])('%s -> 500 common.internal', async (kind) => {
      expectProblem(await get(`/v1/catalog/weird/${kind}`), { status: 500, code: 'common.internal' });
    });
    it('non-registry http status on a thrown error (418) -> still a registry-backed Problem, message not leaked', async () => {
      const res = await get('/v1/catalog/weird/teapot');
      expectProblem(res, { status: 500, code: 'common.internal' });
      expect(JSON.parse(res.body).instance).toBe('/v1/catalog/weird/teapot');
    });
  });

  describe('database errors (REQ-SEC-026: no oracle, no internals)', () => {
    it('raw, unmapped driver error reaching the handler -> 500 common.internal, constraint/table/detail not leaked', async () => {
      expectProblem(await get('/v1/catalog/rawdb'), { status: 500, code: 'common.internal' });
    });
    it.each([
      ['23503', 404, 'common.not_found'], ['42501', 404, 'common.not_found'], ['23505', 500, 'common.internal'],
      ['23514', 400, 'common.validation_failed'], ['40001', 503, 'common.dependency_unavailable'], ['XX000', 500, 'common.internal'],
    ])('mapDbError(%s) rendered -> %i %s', async (state, status, code) => {
      expectProblem(await get(`/v1/catalog/mapped/${state}`), { status, code });
    });
  });

  describe('request_id', () => {
    it('a valid UUIDv7 X-Request-Id is echoed in the body', async () => {
      const b = expectProblem(await get('/v1/catalog/boom', { 'x-request-id': GOOD_RID }), { status: 500 });
      expect(b.request_id).toBe(GOOD_RID);
    });
    it.each([['not-a-uuid'], ['0190a000-0000-4000-8000-0000000000a1'], ['0190a000-0000-7000-8000-0000000000a1; DROP TABLE x'], ['A'.repeat(500)]])(
      'invalid X-Request-Id %j is replaced by a fresh UUIDv7 and never echoed', async (bad) => {
        const res = await get('/v1/catalog/boom', { 'x-request-id': bad });
        const b = expectProblem(res, { status: 500 });
        expect(b.request_id).toMatch(UUIDV7);
        expect(b.request_id).not.toBe(bad);
        expect(res.body).not.toContain('DROP TABLE');
      });
    it('without the header every error gets its own UUIDv7', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 5; i++) ids.add(expectProblem(await get('/v1/catalog/boom')).request_id);
      expect(ids.size).toBe(5);
    });
  });

  it('60 concurrent mixed failures: each response carries its own code/status/instance (no shared error state)', async () => {
    const codes = REGISTRY.map((e) => e.code);
    const jobs = Array.from({ length: 60 }, (_, i) => {
      const code = codes[i % codes.length]!;
      return get(`/v1/catalog/lims/${code}`, { 'x-request-id': `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}` }).then((res) => ({ res, code, i }));
    });
    for (const { res, code, i } of await Promise.all(jobs)) {
      const b = expectProblem(res, { status: BY_CODE.get(code)!.http, code });
      expect(b.request_id).toBe(`0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`);
      expect(b.instance).toBe(`/v1/catalog/lims/${code}`);
    }
  });

  it('a successful response is not touched (no problem+json on 2xx)', async () => {
    const res = await post('/v1/catalog/validate', { name: 'ok' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).not.toMatch(/problem/);
  });
});
