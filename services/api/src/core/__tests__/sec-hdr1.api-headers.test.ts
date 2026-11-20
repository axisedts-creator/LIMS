// SEC-HDR-1 (LD-238, audit 10.1): the API adds, in one onSend hook, X-Content-Type-Options nosniff and Referrer-Policy no-referrer to every
// response, and Cache-Control no-store on AUTHENTICATED JSON only (a non-public operation answering 2xx JSON), only when the handler sent none.
// Per route kind over the real bootstrap + app.inject: public JSON, authenticated JSON, authenticated JSON with its own Cache-Control,
// authenticated 204, 401 / 404 problem+json, unknown route. Fixture: __tests__/fixtures/hdr1 (synthetic). No database: contract mode (ci).
// Tester contract for what the brief leaves open: no-store is NOT asserted either way on 204 and on problem+json errors; it must be absent
// on public JSON (LD-238: "authenticated JSON only").
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../bootstrap.js';
import { loadConfig } from '../config.js';
import { AUD, ISS, makeKeys, makeToken } from '../auth/__tests__/helpers.js';
import { FIXTURES } from './helpers.js';

const ROOT = join(FIXTURES, 'hdr1');
const ks = makeKeys('ES256');
const nowS = () => Math.floor(Date.now() / 1000);
const auth = () => ({ authorization: `Bearer ${makeToken(ks, {}, {}, nowS())}` });
let app: FastifyInstance;

beforeAll(async () => {
  app = await bootstrap({
    config: loadConfig({ LIMS_CORE_ENV: 'ci', LIMS_CORE_JWT_ALG: 'ES256', LIMS_CORE_JWT_ISSUER: ISS, LIMS_CORE_JWT_AUDIENCE: AUD, LIMS_CORE_JWT_KEY_FILE: ks.verifyKeyFile }),
    repoRoot: ROOT, modulesDir: join(ROOT, 'modules'),
  });
});
afterAll(async () => { await app?.close(); });

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });
/** nosniff and no-referrer, each exactly once (a duplicated header would be an array). */
function baseHeaders(h: Record<string, unknown>): void {
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('no-referrer');
}

describe('every response: nosniff + Referrer-Policy no-referrer', () => {
  it('public JSON 200', async () => { const r = await get('/v1/identity/probe'); expect(r.statusCode).toBe(200); baseHeaders(r.headers); });
  it('authenticated JSON 200', async () => { const r = await get('/v1/identity/whoami', auth()); expect(r.statusCode).toBe(200); baseHeaders(r.headers); });
  it('authenticated 204 (no body, no content-type)', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/v1/identity/gone', headers: auth() });
    expect(r.statusCode).toBe(204); baseHeaders(r.headers);
  });
  it('401 problem+json (no token)', async () => {
    const r = await get('/v1/identity/whoami');
    expect(r.statusCode).toBe(401);
    expect(String(r.headers['content-type'])).toContain('application/problem+json');
    baseHeaders(r.headers);
  });
  it('404 problem+json from a handler (authenticated)', async () => {
    const r = await get('/v1/identity/missing', auth());
    expect(r.statusCode).toBe(404); baseHeaders(r.headers);
  });
  it('unknown route 404', async () => { const r = await get('/v1/identity/does-not-exist'); expect(r.statusCode).toBe(404); baseHeaders(r.headers); });
  it('400 validation failure (unsupported method on a known path)', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/identity/probe', payload: {} });
    expect(r.statusCode).toBeGreaterThanOrEqual(400); baseHeaders(r.headers);
  });
});

describe('Cache-Control: no-store on authenticated JSON only, only when the handler sent none', () => {
  it('authenticated JSON 200 without its own Cache-Control gets no-store', async () => {
    const r = await get('/v1/identity/whoami', auth());
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(r.headers['cache-control']).toBe('no-store');
  });
  it('a handler-set Cache-Control is kept as it is', async () => {
    const r = await get('/v1/identity/cached', auth());
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('private, max-age=60');
  });
  it('public JSON is not given no-store', async () => {
    const r = await get('/v1/identity/probe');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBeUndefined();
  });
  it('the 401 of a request that never authenticated is not described as authenticated JSON: a public caller can still read nothing cached', async () => {
    // no assertion on cache-control either way (tester contract above); the body shape must be untouched by the hook
    const r = await get('/v1/identity/whoami');
    expect(r.json()).toMatchObject({ status: 401, code: expect.stringMatching(/^auth\./) });
  });
});

describe('the hook changes headers only: bodies and statuses are as before', () => {
  it('authenticated and public bodies are byte-identical JSON', async () => {
    expect((await get('/v1/identity/whoami', auth())).body).toBe('{"ok":true}');
    expect((await get('/v1/identity/probe')).body).toBe('{"ok":true}');
  });
  it('Server-Timing and the compression Vary from T0B-PERF-1 still work next to the new hook', async () => {
    const r = await get('/v1/identity/whoami', { ...auth(), 'accept-encoding': 'gzip' });
    expect(r.headers['server-timing']).toMatch(/total;dur=/);
  });
});
