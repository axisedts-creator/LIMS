// T0D-10 pipeline stage 13 (02-TRD §6.2 row 13) + PHI log scan (DoD §1.8 phi-log-scan, CV §9.1/§9.2, 02-TRD §4 logger rules).
import { afterEach, describe, expect, it } from 'vitest';
import { bootObs, closeAll, find, RID, type Checks } from './helpers.js';

afterEach(closeAll);

const LIVE = '/v1/core/health/live';
const READY = '/v1/core/health/ready';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACEPARENT = `00-${TRACE}-00f067aa0e5db731-01`;

// Synthetic planted PHI/credentials (never real data).
const PLANT = {
  name: 'Test Patient 0042',
  phone: '9841000000',
  email: 'test.patient0042@example.invalid',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LTAwNDIifQ.c2lnbmF0dXJlMDA0Mg',
  token: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0',
  cookie: 'lims_session=SECRETCOOKIE0042',
  rawPath: 'PLANTED-ROUTE-0042',
};

const DENY_KEYS = [
  'name', 'phone', 'mobile', 'email', 'address', 'dob', 'birth', 'barcode', 'registration_no', 'patient_code', 'lab_no',
  'accession', 'token', 'otp', 'password', 'secret', 'authorization', 'cookie', 'jwt', 'signature', 'result', 'value',
  'comment', 'diagnosis', 'url',
];
const KEY_EXCEPTIONS = new Set(['service', 'module', 'event_type', 'task', 'route']); // 02-TRD logger rules

function allKeys(o: unknown, out: string[] = []): string[] {
  if (Array.isArray(o)) o.forEach((x) => allKeys(x, out));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { out.push(k); allKeys(v, out); }
  return out;
}

async function traffic(app: any) {
  const q = new URLSearchParams({ email: PLANT.email, phone: PLANT.phone, name: PLANT.name, token: PLANT.token }).toString();
  const headers = {
    authorization: `Bearer ${PLANT.jwt}`, cookie: PLANT.cookie, 'x-forwarded-for': '203.0.113.9',
    'user-agent': `agent ${PLANT.name}`, 'x-request-id': RID, traceparent: TRACEPARENT,
  };
  await app.inject({ method: 'GET', url: LIVE, headers });
  await app.inject({ method: 'GET', url: READY, headers });
  await app.inject({ method: 'GET', url: `${LIVE}?${q}`, headers }); // 400 unknown params
  await app.inject({ method: 'GET', url: `/v1/core/health/${PLANT.rawPath}?${q}`, headers }); // 404 unmatched
  await app.inject({ method: 'POST', url: LIVE, headers, payload: { name: PLANT.name } });
}

describe('request log line (stage 13, CV §9.1 fields)', () => {
  // T-01 ruling: first boot gets 30000 ms headroom (default 5000 ms is a harness assumption under parallel load).
  it('one JSON line per request with the mandatory fields', { timeout: 30000 }, async () => {
    const { app, lines } = await bootObs();
    await app.inject({ method: 'GET', url: LIVE, headers: { 'x-request-id': RID, traceparent: TRACEPARENT } });
    const mine = lines().filter((l) => l.request_id === RID && l.status !== undefined);
    expect(mine).toHaveLength(1);
    const l = mine[0]!;
    expect(l.ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(l.level).toBe('info'); // string label, not pino's numeric level
    expect(l.service).toBe('api');
    expect(l.env).toBe('ci');
    expect(typeof l.version).toBe('string');
    expect(l.module).toBe('core');
    expect(l.operation_id).toBe('getLiveness');
    expect(l.route).toBe(LIVE);
    expect(l.status).toBe(200);
    expect(typeof l.duration_ms).toBe('number');
    expect(l.duration_ms).toBeGreaterThanOrEqual(0);
    expect(l.trace_id).toBe(TRACE);
    expect(l.span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('anonymous public request carries no tenant/actor ids', async () => {
    const { app, lines } = await bootObs();
    await app.inject({ method: 'GET', url: LIVE, headers: { 'x-request-id': RID } });
    const l = lines().find((x) => x.request_id === RID && x.status !== undefined)!;
    expect(l.tenant_id ?? null).toBeNull();
    expect(l.actor_id ?? null).toBeNull();
  });

  it('failure line carries error_code (errors.yaml code)', async () => {
    const down: Checks = { db: async () => 'down', ratelimit: async () => 'ok' };
    const { app, lines } = await bootObs({ checks: down });
    await app.inject({ method: 'GET', url: READY, headers: { 'x-request-id': RID } });
    const l = lines().find((x) => x.request_id === RID && x.status === 503)!;
    expect(l).toBeDefined();
    expect(l.error_code).toBe('common.dependency_unavailable');
    expect(l.operation_id).toBe('getReadiness');
  });

  it('invalid traceparent is ignored (no trace fields, request still served)', async () => {
    const { app, lines } = await bootObs();
    const r = await app.inject({ method: 'GET', url: LIVE, headers: { 'x-request-id': RID, traceparent: 'zz-not-valid' } });
    expect(r.statusCode).toBe(200);
    const l = lines().find((x) => x.request_id === RID && x.status === 200)!;
    expect(l.trace_id ?? null).toBeNull();
  });

  it('unmatched route: logs the template placeholder, never the raw URL', async () => {
    const { app, logs } = await bootObs();
    const r = await app.inject({ method: 'GET', url: `/v1/core/health/${PLANT.rawPath}` });
    expect(r.statusCode).toBe(404);
    expect(logs.join('')).not.toContain(PLANT.rawPath);
  });
});

describe('PHI log scan (REQ-SEC-098, DoD §1.8): planted values never reach logs or metrics', () => {
  it('no planted value appears anywhere in captured logs', async () => {
    const { app, logs } = await bootObs();
    await traffic(app);
    const text = logs.join('');
    expect(text.length).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(PLANT)) expect(text, `planted ${k}`).not.toContain(v);
    expect(text).not.toContain('203.0.113.9'); // client IP is not a mandatory log field
    expect(text).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/); // JWT shape
    expect(text).not.toMatch(/(\+?977[- ]?)?9[678]\d{8}/); // Nepali mobile shape
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/); // email shape
  });

  it('every log line is valid JSON and no key matches the denylist (hostname/pid/req/res/headers are gone)', async () => {
    const { app, lines } = await bootObs();
    await traffic(app);
    const keys = lines().flatMap((l) => allKeys(l));
    expect(keys.length).toBeGreaterThan(0);
    const bad = keys.filter((k) => !KEY_EXCEPTIONS.has(k) && DENY_KEYS.some((d) => k.toLowerCase().includes(d)));
    expect([...new Set(bad)]).toEqual([]);
    for (const banned of ['req', 'res', 'headers', 'query', 'body', 'params', 'hostname']) expect(keys).not.toContain(banned);
  });

  it('metrics output has no planted value and no raw-path label', async () => {
    const { app } = await bootObs();
    await traffic(app);
    const text = await app.metrics.render();
    for (const [k, v] of Object.entries(PLANT)) expect(text, `planted ${k}`).not.toContain(v);
  });
});

describe('HTTP metrics (stage 13): lims_http_requests_total / lims_http_request_duration_seconds', () => {
  it('counts per module/operation_id/status', async () => {
    const down: Checks = { db: async () => 'down', ratelimit: async () => 'ok' };
    const { app } = await bootObs({ checks: down });
    await app.inject({ method: 'GET', url: LIVE });
    await app.inject({ method: 'GET', url: LIVE });
    await app.inject({ method: 'GET', url: READY });
    const text = await app.metrics.render();
    expect(find(text, 'lims_http_requests_total', { module: 'core', operation_id: 'getLiveness', status: '200' })[0]!.value).toBe(2);
    expect(find(text, 'lims_http_requests_total', { module: 'core', operation_id: 'getReadiness', status: '503' })[0]!.value).toBe(1);
  });

  it('observes duration in seconds per module/operation_id', async () => {
    const { app } = await bootObs();
    await app.inject({ method: 'GET', url: LIVE });
    await app.inject({ method: 'GET', url: LIVE });
    const text = await app.metrics.render();
    const count = find(text, 'lims_http_request_duration_seconds_count', { module: 'core', operation_id: 'getLiveness' });
    expect(count[0]!.value).toBe(2);
    const sum = find(text, 'lims_http_request_duration_seconds_sum', { module: 'core', operation_id: 'getLiveness' })[0]!.value;
    expect(sum).toBeGreaterThanOrEqual(0);
    expect(sum).toBeLessThan(5); // seconds, not milliseconds
    expect(find(text, 'lims_http_request_duration_seconds_bucket', { module: 'core', operation_id: 'getLiveness', le: '+Inf' })[0]!.value).toBe(2);
  });

  it('operation_id label values come only from the spec (bounded cardinality)', async () => {
    const { app } = await bootObs();
    for (let i = 0; i < 5; i++) await app.inject({ method: 'GET', url: `/v1/core/health/unknown-${i}` });
    const ops = new Set(find(await app.metrics.render(), 'lims_http_requests_total').map((s) => s.labels.operation_id));
    for (const o of ops) expect(['getLiveness', 'getReadiness', 'unmatched']).toContain(o); // 'unmatched' = fixed bucket for no-route 404s [CONV]
  });

  it('each bootstrap has its own registry', async () => {
    const a = await bootObs();
    await a.app.inject({ method: 'GET', url: LIVE });
    const b = await bootObs();
    expect(find(await b.app.metrics.render(), 'lims_http_requests_total')).toEqual([]);
  });
});
