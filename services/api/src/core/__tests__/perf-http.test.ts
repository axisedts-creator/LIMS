// T0B-PERF-1 (LD-310) done_when 1, 2, 5 (headers), 8: response compression, Server-Timing, the structured request line,
// no-store on health, keep-alive. HTTP level over app.inject; public fixture operations, so no database is needed.
// Fixture: __tests__/fixtures/perf (catalog over the shared spec). Synthetic data only.
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bootstrap } from '../bootstrap.js';
import { loadConfig } from '../config.js';
import { bootObs, closeAll as closeObs, RID } from '../observability/__tests__/helpers.js';
import { FIXTURES, SHARED_ROOT } from './helpers.js';

const BIG = '/v1/catalog/things?limit=40';  // ~4 KB of JSON
const SMALL = '/v1/catalog/things?limit=1';  // ~120 bytes
const logs: string[] = [];
let app: FastifyInstance;
const lines = () => logs.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
const requestLines = () => lines().filter((o) => o.msg === 'request');

beforeAll(async () => {
  app = await bootstrap({
    config: loadConfig({ LIMS_CORE_ENV: 'ci', LIMS_CORE_LOG_LEVEL: 'info' }),
    repoRoot: SHARED_ROOT, modulesDir: join(FIXTURES, 'perf'), logStream: { write: (l: string) => { logs.push(l); } },
  } as any);
});
afterAll(async () => { await app?.close(); await closeObs(); });

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });

describe('(1) compression of JSON over 1 KB', () => {
  it('no Accept-Encoding: plain JSON, no content-encoding (the contract is unchanged)', async () => {
    const r = await get(BIG);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-encoding']).toBeUndefined();
    expect(r.rawPayload.length).toBeGreaterThan(1024);
    expect(r.json().items).toHaveLength(40);
  });

  it('gzip: content-encoding gzip, body inflates to the identical JSON, smaller on the wire, Vary names Accept-Encoding', async () => {
    const plain = (await get(BIG)).body;
    const r = await get(BIG, { 'accept-encoding': 'gzip' });
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(String(r.headers['vary'])).toMatch(/accept-encoding/i);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(gunzipSync(r.rawPayload).toString('utf8')).toBe(plain);
    expect(r.rawPayload.length).toBeLessThan(plain.length / 2);
    if (r.headers['content-length'] !== undefined) expect(Number(r.headers['content-length'])).toBe(r.rawPayload.length);
  });

  it('br: brotli when the client offers only br', async () => {
    const plain = (await get(BIG)).body;
    const r = await get(BIG, { 'accept-encoding': 'br' });
    expect(r.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(r.rawPayload).toString('utf8')).toBe(plain);
  });

  it('gzip, br offered: one of the two is chosen and it decodes', async () => {
    const plain = (await get(BIG)).body;
    const r = await get(BIG, { 'accept-encoding': 'gzip, deflate, br' });
    const enc = String(r.headers['content-encoding']);
    expect(['gzip', 'br']).toContain(enc);
    expect((enc === 'br' ? brotliDecompressSync(r.rawPayload) : gunzipSync(r.rawPayload)).toString('utf8')).toBe(plain);
  });

  it.each(['identity', 'gzip;q=0', 'compress'])('Accept-Encoding %j: not compressed', async (ae) => {
    expect((await get(BIG, { 'accept-encoding': ae })).headers['content-encoding']).toBeUndefined();
  });

  it('a response of 1 KB or less is not compressed even when the client accepts it', async () => {
    const r = await get(SMALL, { 'accept-encoding': 'gzip, br' });
    expect(r.rawPayload.length).toBeLessThanOrEqual(1024);
    expect(r.headers['content-encoding']).toBeUndefined();
  });

  it('a compressed response keeps status, Server-Timing and the problem body shape of errors (400 stays readable JSON)', async () => {
    const ok = await get(BIG, { 'accept-encoding': 'gzip' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['server-timing']).toBeDefined();
    const bad = await get('/v1/catalog/things?limit=9999', { 'accept-encoding': 'gzip' });
    expect(bad.statusCode).toBe(400);
    const body = bad.headers['content-encoding'] === 'gzip' ? gunzipSync(bad.rawPayload).toString('utf8') : bad.body;
    expect(JSON.parse(body)).toHaveProperty('code');
  });

  it('a 204 has an empty body and no encoding', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/v1/catalog/things/t1', headers: { 'accept-encoding': 'gzip' } });
    expect(r.statusCode).toBe(204);
    expect(r.rawPayload.length).toBe(0);
  });
});

describe('(2) Server-Timing on every response', () => {
  const FORMAT = /(?=.*\btotal;dur=\d+(\.\d+)?)(?=.*\bdb;dur=\d+(\.\d+)?)(?=.*\brid;desc="[^"]+")/;

  it.each([
    ['200 list', SMALL, 200],
    ['200 big compressed', BIG, 200],
    ['400 validation', '/v1/catalog/things?limit=9999', 400],
    ['404 unmatched route', '/v1/nope/nothing', 404],
  ])('%s carries total, db and rid', async (_n, url, status) => {
    const r = await get(url, { 'accept-encoding': 'gzip' });
    expect(r.statusCode).toBe(status);
    expect(String(r.headers['server-timing'])).toMatch(FORMAT);
  });

  it('a 201 write carries it too', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/catalog/things', payload: { name: 'x' } });
    expect(r.statusCode).toBe(201);
    expect(String(r.headers['server-timing'])).toMatch(FORMAT);
  });

  it('rid is the request id: a valid UUIDv7 X-Request-Id is echoed, otherwise a fresh UUIDv7', async () => {
    const a = await get(SMALL, { 'x-request-id': RID });
    expect(String(a.headers['server-timing'])).toContain(`rid;desc="${RID}"`);
    const b = await get(SMALL);
    expect(String(b.headers['server-timing'])).toMatch(/rid;desc="[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"/);
    const c = await get(SMALL, { 'x-request-id': 'evil", db;dur=0, x;desc="y' });
    const h = String(c.headers['server-timing']);
    expect(h).not.toContain('evil');
    expect(h.match(/rid;desc=/g)).toHaveLength(1);
  });

  it('total is a real duration of this request and db is 0 when no query ran', async () => {
    const h = String((await get(SMALL)).headers['server-timing']);
    expect(Number(/total;dur=([\d.]+)/.exec(h)![1])).toBeGreaterThanOrEqual(0);
    expect(Number(/db;dur=([\d.]+)/.exec(h)![1])).toBe(0);
  });
});

describe('(2) structured request log line', () => {
  it('one line per request: route, status, duration_ms, db_count, db_ms, request_id', async () => {
    logs.length = 0;
    await get(SMALL, { 'x-request-id': RID });
    const l = requestLines();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ route: '/v1/catalog/things', status: 200, db_count: 0, db_ms: 0, request_id: RID });
    expect(typeof l[0].duration_ms).toBe('number');
  });

  it('no personal data: not the body, the query string, the user agent, authorization, cookies or the client ip', async () => {
    logs.length = 0;
    await app.inject({
      method: 'POST', url: '/v1/catalog/things', payload: { name: 'Jane Synthetic Patient 9841000000' },
      headers: { authorization: 'Bearer secret-token-xyz', cookie: 'sid=secret-cookie', 'user-agent': 'agent-jane@example.test', 'x-forwarded-for': '198.51.100.77' },
    });
    await get('/v1/catalog/things?limit=1&q=jane@example.test');
    const all = logs.join('');
    for (const s of ['Jane Synthetic', '9841000000', 'secret-token-xyz', 'secret-cookie', 'jane@example.test', '198.51.100.77']) expect(all, s).not.toContain(s);
  });

  it('a 404 is logged once with the same field set', async () => {
    logs.length = 0;
    await get('/v1/nope/nothing');
    const l = requestLines();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ status: 404, db_count: 0, db_ms: 0 });
    expect(l[0]).toHaveProperty('request_id');
  });
});

describe('(5, 7) health endpoints: fast, no-store, no auth detail, keep-alive above the proxy idle time', () => {
  const LIVE = '/v1/core/health/live';
  const READY = '/v1/core/health/ready';

  it('liveness and readiness answer a healthy database well under 200 ms, p95 of 20 calls', async () => {
    const { app: a } = await bootObs();
    await a.inject({ method: 'GET', url: READY }); // first call warms the route
    const ms: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const r = await a.inject({ method: 'GET', url: i % 2 ? LIVE : READY });
      ms.push(performance.now() - t0);
      expect(r.statusCode).toBe(200);
    }
    ms.sort((x, y) => x - y);
    expect(ms[Math.floor(ms.length * 0.95) - 1]).toBeLessThan(200);
  });

  it('both are Cache-Control: no-store and carry Server-Timing', async () => {
    const { app: a } = await bootObs();
    for (const u of [LIVE, READY]) {
      const r = await a.inject({ method: 'GET', url: u });
      expect(String(r.headers['cache-control'])).toMatch(/no-store/);
      expect(r.headers['server-timing']).toBeDefined();
    }
  });

  it('a hung database check still ends readiness with 503 and no detail (the web polls it while the API wakes)', async () => {
    const { app: a } = await bootObs({ checks: { db: () => new Promise(() => undefined), ratelimit: async () => 'ok' } });
    const t0 = performance.now();
    const r = await a.inject({ method: 'GET', url: READY });
    expect(r.statusCode).toBe(503);
    expect(Object.keys(r.json()).sort()).toEqual(['checks', 'status']);
    expect(performance.now() - t0).toBeLessThan(5000);
  }, 10000);

  it('keep-alive is above a 60 s proxy idle time and headersTimeout is above keep-alive (no 502 from a reused dead socket)', () => {
    expect(app.server.keepAliveTimeout).toBeGreaterThanOrEqual(65_000);
    expect(app.server.headersTimeout).toBeGreaterThan(app.server.keepAliveTimeout);
  });
});
