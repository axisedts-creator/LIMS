// T0D-FIX-12 (LD-455, founder 2026-11-22 22:06 NPT), done_when (3): a 429 from resolveSession is retried ONCE after Retry-After
// (waiting at most 1 second); a second 429 is the answer (typed problem, relayed). Nothing else is retried. Same body (touch) on the retry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
import { c2Resolver } from '../c2';

const SID = 'S'.padEnd(43, '0');
const OK_BODY = { access_token: 'ACCESS', session: { session_id: '0190a000-0000-7000-8000-000000000001', kind: 'tenant_staff', state: 'active', aal: 'aal1',
  idle_expires_at: '2026-11-16T07:00:00.000Z', absolute_expires_at: '2026-11-16T15:00:00.000Z', actor: { display_name: 'Ana Demo', tenant_code: 'lab_a', roles: [], permissions: ['p.x'] } } };
const prob = (code: string, status: number) => ({ type: `urn:lims:error:${code}`, title: code, status, code });
const json = (status: number, b: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });
const limited = (retryAfter?: string) => json(429, prob('common.rate_limited', 429), retryAfter === undefined ? {} : { 'retry-after': retryAfter });
let fetchMock: ReturnType<typeof vi.fn>;
const script = (...answers: (() => Response | Promise<Response>)[]) => {
  let i = 0;
  fetchMock = vi.fn(async () => answers[Math.min(i++, answers.length - 1)]!());
  vi.stubGlobal('fetch', fetchMock);
};
const bodies = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
const run = (touch: boolean) => {
  const p = c2Resolver.resolve(SID, { touch });
  return p;
};
/** let the first answer arrive and the retry timer be armed, then move the clock */
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  process.env.LIMS_CORE_ENV = 'ci'; process.env.LIMS_WEB_BFF_KEY = 'synthetic-web-bff-key-0123456789'; process.env.LIMS_ORIGIN_API = 'https://api.lims-test.invalid';
  delete process.env.LIMS_WEB_BFF_KEY_FILE;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('429 from resolveSession: retried once, after Retry-After, capped at 1 second', () => {
  it('429 (Retry-After: 1) then 200 -> resolved session, exactly 2 calls', async () => {
    script(() => limited('1'), () => json(200, OK_BODY));
    const p = run(true);
    await tick(1000);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('waits for Retry-After: not retried before it passes (Retry-After: 1 -> no second call at 500 ms)', async () => {
    script(() => limited('1'), () => json(200, OK_BODY));
    const p = run(true);
    await tick(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(500);
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each(['30', '3600', 'Wed, 21 Oct 2037 07:28:00 GMT'])('Retry-After %j is capped: retried within 1000 ms', async (ra) => {
    script(() => limited(ra), () => json(200, OK_BODY));
    const p = run(true);
    await tick(1000);
    expect((await p).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, '', 'soon', '-5', 'NaN'])('Retry-After %j (missing or junk) -> still one retry within 1000 ms', async (ra) => {
    script(() => limited(ra), () => json(200, OK_BODY));
    const p = run(false);
    await tick(1000);
    expect((await p).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('Retry-After: 0 retries at once (no wait beyond the timer queue)', async () => {
    script(() => limited('0'), () => json(200, OK_BODY));
    const p = run(true);
    await tick(0);
    expect((await p).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('a second 429 is the answer: one retry, never a loop; the typed problem is relayed', () => {
  it('429 then 429 -> { ok:false, status:429, common.rate_limited }, exactly 2 calls, no session data', async () => {
    script(() => limited('1'), () => limited('1'));
    const p = run(true);
    await tick(1000);
    await tick(5000); // a third attempt would show up as a third call
    const r = await p;
    expect(r).toMatchObject({ ok: false, status: 429, problem: { code: 'common.rate_limited' } });
    expect(r).not.toHaveProperty('accessToken');
    expect(r).not.toHaveProperty('session');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('only 429 is retried', () => {
  it.each([
    ['401', () => json(401, prob('auth.session_expired', 401))],
    ['403', () => json(403, prob('auth.forbidden', 403))],
    ['500', () => json(500, prob('common.internal', 500))],
    ['503', () => json(503, prob('common.dependency_unavailable', 503))],
  ])('%s -> one call, answer as today', async (_n, a) => {
    script(a);
    const r = await run(true);
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('a fetch that never answers (timeout / connection failure) -> waking as today, not retried', async () => {
    script(() => { throw new DOMException('timeout', 'TimeoutError'); });
    const r = await run(true);
    expect(r).toMatchObject({ ok: false, status: 503, waking: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('a 200 is one call (no retry, no extra resolve)', async () => {
    script(() => json(200, OK_BODY));
    expect((await run(true)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('idle timeout logic is unchanged: touch is sent as given, also on the retry', () => {
  it.each([true, false])('touch:%s -> the same body on both calls', async (touch) => {
    script(() => limited('0'), () => json(200, OK_BODY));
    const p = run(touch);
    await tick(0);
    await p;
    expect(bodies()).toEqual([{ touch }, { touch }]);
  });
  it('the retry carries the same cookie and BFF key (no new identity)', async () => {
    script(() => limited('0'), () => json(200, OK_BODY));
    const p = run(true);
    await tick(0);
    await p;
    const [a, b] = fetchMock.mock.calls.map((c) => new Headers((c[1] as RequestInit).headers));
    expect(b!.get('cookie')).toBe(a!.get('cookie'));
    expect(b!.get('x-lims-bff-key')).toBe(a!.get('x-lims-bff-key'));
  });
});
