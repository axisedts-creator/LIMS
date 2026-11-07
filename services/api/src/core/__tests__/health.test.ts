// T0D-10 health endpoint tests — 02-TRD §8 (getLiveness / getReadiness), contracts/openapi/core.yaml,
// 07-SECURITY §cross-tenant probe ("public health endpoints return no tenant data"), CR-C0-006.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHealthHandlers } from '../health.js';
import { bootObs, closeAll, okChecks, type Checks } from '../observability/__tests__/helpers.js';

afterEach(closeAll);

const LIVE = '/v1/core/health/live';
const READY = '/v1/core/health/ready';
const checks = (db: any, ratelimit: any = 'ok'): Checks => ({
  db: async () => { if (db instanceof Error) throw db; return db; },
  ratelimit: async () => { if (ratelimit instanceof Error) throw ratelimit; return ratelimit; },
});

describe('GET /v1/core/health/live', () => {
  // T-01 ruling: first boot gets 30000 ms headroom (default 5000 ms is a harness assumption under parallel load).
  it('200 {status:"ok"} with no data, no auth', { timeout: 30000 }, async () => {
    const { app } = await bootObs();
    const r = await app.inject({ method: 'GET', url: LIVE });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(r.json()).toEqual({ status: 'ok' });
  });

  it('never touches a dependency (liveness is process-only)', async () => {
    const c = { db: vi.fn(async () => 'ok' as const), ratelimit: vi.fn(async () => 'ok' as const) };
    const { app } = await bootObs({ checks: c });
    await app.inject({ method: 'GET', url: LIVE });
    expect(c.db).not.toHaveBeenCalled();
    expect(c.ratelimit).not.toHaveBeenCalled();
  });

  it('still 200 when every dependency is down', async () => {
    const { app } = await bootObs({ checks: checks('down', 'down') });
    expect((await app.inject({ method: 'GET', url: LIVE })).statusCode).toBe(200);
  });

  it('x-public: a garbage Authorization header is ignored, no tenant data comes back', async () => {
    const { app } = await bootObs();
    const r = await app.inject({
      method: 'GET', url: LIVE,
      headers: { authorization: 'Bearer not-a-jwt', 'x-lims-bff-key': 'nope' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok' });
  });

  it('unknown query parameter is rejected by spec validation (400 common.validation_failed)', async () => {
    const { app } = await bootObs();
    const r = await app.inject({ method: 'GET', url: `${LIVE}?x=1` });
    expect(r.statusCode).toBe(400);
  });

  it('only GET is routed', async () => {
    const { app } = await bootObs();
    expect([404, 405]).toContain((await app.inject({ method: 'POST', url: LIVE, payload: {} })).statusCode);
  });
});

describe('GET /v1/core/health/ready', () => {
  it('200 {status:"ok", checks:{db:"ok", ratelimit:"ok"}} when all dependencies are up', async () => {
    const { app } = await bootObs({ checks: okChecks() });
    const r = await app.inject({ method: 'GET', url: READY });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok', checks: { db: 'ok', ratelimit: 'ok' } });
  });

  it('503 with the same body shape and the failing check when db is down', async () => {
    const { app } = await bootObs({ checks: checks('down') });
    const r = await app.inject({ method: 'GET', url: READY });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ status: 'down', checks: { db: 'down', ratelimit: 'ok' } });
  });

  it('503 when ratelimit is down (spec lists no exemption)', async () => {
    const { app } = await bootObs({ checks: checks('ok', 'down') });
    const r = await app.inject({ method: 'GET', url: READY });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ status: 'down', checks: { db: 'ok', ratelimit: 'down' } });
  });

  it('a check that throws counts as down and its message never reaches the response', async () => {
    const boom = new Error('connect ECONNREFUSED 10.20.30.40:5432 password=hunter2 host=db.internal.example');
    const { app } = await bootObs({ checks: checks(boom) });
    const r = await app.inject({ method: 'GET', url: READY });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ status: 'down', checks: { db: 'down', ratelimit: 'ok' } });
    for (const leak of ['ECONNREFUSED', '10.20.30.40', 'hunter2', 'db.internal', 'stack']) expect(r.body).not.toContain(leak);
  });

  it('a degraded check is reported as degraded and the body stays schema-valid', async () => {
    const { app } = await bootObs({ checks: checks('degraded') });
    const r = await app.inject({ method: 'GET', url: READY });
    expect([200, 503]).toContain(r.statusCode);
    expect(r.json().checks).toEqual({ db: 'degraded', ratelimit: 'ok' });
    expect(['degraded', 'down']).toContain(r.json().status);
  });

  it('dependency names only: no versions, hosts or extra keys (x-public contract)', async () => {
    const { app } = await bootObs({ checks: checks('down') });
    const body = (await app.inject({ method: 'GET', url: READY })).json();
    expect(Object.keys(body).sort()).toEqual(['checks', 'status']);
    expect(Object.keys(body.checks).sort()).toEqual(['db', 'ratelimit']);
  });

  it('checks run per request (no caching): a recovering dependency flips 503 -> 200', async () => {
    let state: 'down' | 'ok' = 'down';
    const { app } = await bootObs({ checks: { db: async () => state, ratelimit: async () => 'ok' } });
    expect((await app.inject({ method: 'GET', url: READY })).statusCode).toBe(503);
    state = 'ok';
    expect((await app.inject({ method: 'GET', url: READY })).statusCode).toBe(200);
  });

  it('anonymous and bogus-credential callers get identical bodies (no tenant data)', async () => {
    const { app } = await bootObs();
    const a = await app.inject({ method: 'GET', url: READY });
    const b = await app.inject({ method: 'GET', url: READY, headers: { authorization: 'Bearer eyJ.fake.jwt', 'x-tenant-id': 'tenant-b' } });
    expect(b.statusCode).toBe(a.statusCode);
    expect(b.body).toBe(a.body);
  });
});

describe('createHealthHandlers (unit)', () => {
  const ctx: any = { operationId: 'x', clientIp: '127.0.0.1', log: { info() {}, warn() {}, error() {} } };
  const req: any = { params: {}, query: {}, headers: {}, body: undefined };

  it('returns HandlerResult values keyed by the core.yaml operationIds', async () => {
    const h = createHealthHandlers(okChecks());
    expect(Object.keys(h).sort()).toEqual(['getLiveness', 'getReadiness']);
    expect(await h.getLiveness(req, ctx)).toMatchObject({ status: 200, body: { status: 'ok' } });
    expect(await h.getReadiness(req, ctx)).toMatchObject({ status: 200, body: { status: 'ok', checks: { db: 'ok', ratelimit: 'ok' } } });
  });

  it('readiness maps a failing check to status 503', async () => {
    const h = createHealthHandlers(checks('down'));
    expect(await h.getReadiness(req, ctx)).toMatchObject({ status: 503, body: { status: 'down', checks: { db: 'down', ratelimit: 'ok' } } });
  });
});
