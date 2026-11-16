// T0D-WAKE-1 (LD-277, audit RS-07): c2Resolver tells "the API did not answer" (timeout / connection failure) apart from "the API answered".
// CONTRACT chosen by the tester (writer: follow it, or dispute in .orchestra/notes). No new error code: the distinct signal is a flag.
//   Resolution { ok:false, status:503, problem.code:'common.dependency_unavailable', waking:true }  <- fetch rejected (TimeoutError or network TypeError)
//   Any HTTP answer (401, 4xx, 5xx, bad body) keeps today's result and carries NO `waking`.  Timeout stays <= 8000 ms (hosting limit).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { c2Resolver } from '../c2';

const SID = 'S'.padEnd(43, '0');
const resolve = () => c2Resolver.resolve(SID, { touch: false });
const answer = (status: number, b: unknown = {}) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })));
const problem = (code: string, status: number) => ({ type: `urn:lims:error:${code}`, title: code, status, code });
const flag = (r: unknown) => (r as { waking?: boolean }).waking;

beforeEach(() => {
  process.env.LIMS_CORE_ENV = 'ci';
  process.env.LIMS_WEB_BFF_KEY = 'synthetic-web-bff-key-0123456789';
  process.env.LIMS_ORIGIN_API = 'https://api.lims-test.invalid';
  delete process.env.LIMS_WEB_BFF_KEY_FILE;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RS-07: no answer from the API = waking, not signed out, not plain unavailable', () => {
  it.each([
    ['a timeout', () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ['a connection failure', () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })],
  ])('%s -> { ok:false, status:503, dependency_unavailable, waking:true } (never 401)', async (_n, err) => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw err(); }));
    const r = await resolve();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(503);
    expect(r.problem.code).toBe('common.dependency_unavailable');
    expect(flag(r)).toBe(true);
  });
});

describe('an HTTP answer keeps its current behaviour and is NOT waking', () => {
  it('401 stays 401 auth.session_expired (signed out)', async () => {
    answer(401, problem('auth.session_expired', 401));
    const r = await resolve();
    expect(r).toMatchObject({ ok: false, status: 401, problem: { code: 'auth.session_expired' } });
    expect(flag(r)).toBeUndefined();
  });
  it.each([500, 502, 503, 504])('HTTP %i stays 503 dependency_unavailable without waking', async (s) => {
    answer(s, problem('common.dependency_unavailable', s));
    const r = await resolve();
    expect(r).toMatchObject({ ok: false, status: 503, problem: { code: 'common.dependency_unavailable' } });
    expect(flag(r)).toBeUndefined();
  });
  it('a 4xx problem is relayed unchanged without waking', async () => {
    answer(403, problem('auth.forbidden', 403));
    const r = await resolve();
    expect(r).toMatchObject({ ok: false, status: 403, problem: { code: 'auth.forbidden' } });
    expect(flag(r)).toBeUndefined();
  });
});

it('the resolve timeout is set and stays at or below 8000 ms (hosting limit of web functions)', async () => {
  const spy = vi.spyOn(AbortSignal, 'timeout');
  answer(401, problem('auth.session_expired', 401));
  await resolve();
  expect(spy).toHaveBeenCalled();
  for (const [ms] of spy.mock.calls) {
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(8000);
  }
});
