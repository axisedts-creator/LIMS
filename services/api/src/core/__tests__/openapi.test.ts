// T0D-01 — core/openapi.ts obligations from the SP-8 record (db/meta/decisions/SP-8.md O1–O4),
// 02-TRD §6.2 stages 3 and 12; REQ-SEC-080 (unknown fields rejected), REQ-ARCH-071 (response validation).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boot, calls, closeAll } from './helpers.js';

beforeEach(() => {
  calls().length = 0;
});
afterEach(closeAll);

describe('O1 ajv: unknown body fields are rejected, never silently stripped (REQ-SEC-080)', () => {
  it('unknown field -> 400 and the handler is not called', async () => {
    const app = await boot('ok');
    const r = await app.inject({ method: 'POST', url: '/v1/catalog/things', payload: { name: 'a', zzz: 1 } });
    expect(r.statusCode).toBe(400);
    expect(calls()).toEqual([]);
  });

  it('required field missing / wrong type / over maxLength -> 400', async () => {
    const app = await boot('ok');
    for (const payload of [{}, { name: 5 }, { name: 'x'.repeat(101) }]) {
      const r = await app.inject({ method: 'POST', url: '/v1/catalog/things', payload });
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(calls()).toEqual([]);
  });

  it('integer query param is coerced (limit=5 is valid), out-of-range is 400', async () => {
    const app = await boot('ok');
    expect((await app.inject({ method: 'GET', url: '/v1/catalog/things?limit=5' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/catalog/things?limit=0' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/catalog/things?limit=abc' })).statusCode).toBe(400);
  });
});

describe('O2 strict query: unknown query parameters -> 400', () => {
  it('unknown query param is rejected and the handler is not called', async () => {
    const app = await boot('ok');
    const r = await app.inject({ method: 'GET', url: '/v1/catalog/things?foo=1' });
    expect(r.statusCode).toBe(400);
    expect(calls()).toEqual([]);
  });

  it('unknown request headers are NOT rejected (proxies add headers)', async () => {
    const app = await boot('ok');
    const r = await app.inject({ method: 'GET', url: '/v1/catalog/things', headers: { 'x-random-proxy-header': 'a' } });
    expect(r.statusCode).toBe(200);
  });
});

describe('O4 response validation toggle (LIMS_CORE_RESPONSE_VALIDATION)', () => {
  it('on: a handler body that violates the spec -> 500 common.internal, body does not leak the handler data', async () => {
    const app = await boot('badresp', { LIMS_CORE_RESPONSE_VALIDATION: 'on' });
    const r = await app.inject({ method: 'GET', url: '/v1/catalog/things/q1' });
    expect(r.statusCode).toBe(500);
    expect(r.body).toContain('common.internal');
    expect(r.body).not.toContain('extra');
  });

  it('on is the default in ci', async () => {
    const app = await boot('badresp');
    expect((await app.inject({ method: 'GET', url: '/v1/catalog/things/q1' })).statusCode).toBe(500);
  });

  it('off: no contract check (200)', async () => {
    const app = await boot('badresp', { LIMS_CORE_RESPONSE_VALIDATION: 'off' });
    expect((await app.inject({ method: 'GET', url: '/v1/catalog/things/q1' })).statusCode).toBe(200);
  });

  it('on: a conforming response still passes', async () => {
    const app = await boot('ok', { LIMS_CORE_RESPONSE_VALIDATION: 'on' });
    expect((await app.inject({ method: 'GET', url: '/v1/catalog/things/q1' })).statusCode).toBe(200);
  });
});
