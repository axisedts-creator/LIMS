// T0D-FIX-12 (LD-455, founder 2026-11-22 22:06 NPT): 62 x 429 on resolveSession in 12 minutes of one person browsing.
// (1) FIND: how many resolveSession calls one page render makes, and where the fan-out comes from. Measured here, in source:
//     middleware.ts resolves ONCE per incoming request; server components / serverFetch never resolve again (they read the forwarded headers).
//     So a page render = 1 resolve, and the bursts of 7 to 15 come from many REQUESTS at once = next/link prefetch of the rail links (each
//     prefetch is its own request through middleware). Rail.tsx and GlobalSearch.tsx are the only files that import next/link.
// (2) FIX: prefetch={false} on every <Link> that fans out to authenticated pages; touch true (foreground) / false (X-Lims-Background) unchanged.
// (3) a 429 that survives the one retry fails the WHOLE request (problem+json 429), no session headers forwarded, no partial data.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const h = vi.hoisted(() => ({ incoming: undefined as unknown as Headers }));
vi.mock('next/headers', () => ({ headers: async () => h.incoming }));
import { middleware } from '../middleware';
import { serverFetch } from '../core/api/server-fetch';
import { RESOLVE_SESSION_PATH } from '../core/session/c2';
import { BACKGROUND_HEADER, H_ACCESS_TOKEN, H_SESSION } from '../core/session/request';

const ORIGIN = 'http://localhost:3000';
const API = 'https://api.lims-test.invalid';
const COOKIE = '__Host-lims_sid=sid-synthetic-0123456789';
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const OK_BODY = { access_token: 'ACCESS', session: { session_id: '0190a000-0000-7000-8000-000000000001', kind: 'tenant_staff', state: 'active', aal: 'aal1',
  idle_expires_at: '2026-11-16T07:00:00.000Z', absolute_expires_at: '2026-11-16T15:00:00.000Z', actor: { display_name: 'Ana Demo', tenant_code: 'lab_a', roles: [], permissions: ['p.x'] } } };
const prob = (code: string, status: number) => ({ type: `urn:lims:error:${code}`, title: code, status, code });
const json = (status: number, b: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });
const req = (path: string, extra: Record<string, string> = {}) => new NextRequest(`${ORIGIN}${path}`, { headers: { accept: HTML, cookie: COOKIE, ...extra } });

let fetchMock: ReturnType<typeof vi.fn>;
const isResolve = (c: unknown[]) => String(c[0]).endsWith(RESOLVE_SESSION_PATH);
const resolveCalls = () => fetchMock.mock.calls.filter(isResolve);
const touches = () => resolveCalls().map((c) => JSON.parse((c[1] as RequestInit).body as string).touch);

beforeEach(() => {
  h.incoming = new Headers({ [H_ACCESS_TOKEN]: 'ACCESS' });
  process.env.LIMS_CORE_ENV = 'ci'; process.env.LIMS_WEB_BFF_KEY = 'synthetic-web-bff-key-0123456789'; process.env.LIMS_ORIGIN_API = API;
  delete process.env.LIMS_WEB_BFF_KEY_FILE;
  fetchMock = vi.fn(async (u: unknown) => (String(u).endsWith(RESOLVE_SESSION_PATH) ? json(200, OK_BODY) : json(200, { data: [] })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('(1) one page render = one resolveSession', () => {
  it('one document request through middleware -> exactly 1 resolve; then 8 parallel server fetches of the page -> still 1 resolve in total', async () => {
    const res = await middleware(req('/lab/worklist'));
    expect(res.status).toBe(200);
    expect(resolveCalls()).toHaveLength(1);
    await Promise.all(Array.from({ length: 8 }, (_, i) => serverFetch(`/v1/lab/worklist?i=${i}`)));
    expect(fetchMock.mock.calls.filter((c) => !isResolve(c))).toHaveLength(8);
    expect(resolveCalls()).toHaveLength(1);
  });
  it('serverFetch alone never calls resolveSession', async () => {
    await Promise.all(Array.from({ length: 20 }, () => serverFetch('/v1/lab/worklist')));
    expect(resolveCalls()).toHaveLength(0);
  });
});

describe('(2) touch: foreground true, background false, exactly as today', () => {
  it('a normal request touches; an X-Lims-Background request does not', async () => {
    await middleware(req('/lab/worklist'));
    await middleware(req('/lab/worklist', { [BACKGROUND_HEADER]: '1' }));
    expect(touches()).toEqual([true, false]);
  });
});

describe('(3) 429 on resolveSession: one retry, then the whole request fails with the typed problem', () => {
  const limited = () => json(429, prob('common.rate_limited', 429), { 'retry-after': '1' });
  it('429 then 200 -> the page request goes through (session headers forwarded), 2 resolves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let n = 0;
    fetchMock.mockImplementation(async () => (n++ === 0 ? limited() : json(200, OK_BODY)));
    const p = middleware(req('/lab/worklist'));
    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res.status).toBe(200);
    expect(res.headers.get(`x-middleware-request-${H_SESSION}`)).toBeTruthy();
    expect(resolveCalls()).toHaveLength(2);
  });
  it('429 then 429 -> 429 problem+json common.rate_limited, no session headers (no partial data), exactly 2 resolves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fetchMock.mockImplementation(async () => limited());
    const p = middleware(req('/lab/worklist'));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(5000);
    const res = await p;
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect((await res.json()).code).toBe('common.rate_limited');
    expect(res.headers.get(`x-middleware-request-${H_SESSION}`)).toBeNull();
    expect(res.headers.get(`x-middleware-request-${H_ACCESS_TOKEN}`)).toBeNull();
    expect(res.headers.get('location')).toBeNull(); // not a sign-out
    expect(resolveCalls()).toHaveLength(2);
  });
  it('a background (touch:false) request keeps touch:false on the retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let n = 0;
    fetchMock.mockImplementation(async () => (n++ === 0 ? limited() : json(200, OK_BODY)));
    const p = middleware(req('/lab/worklist', { [BACKGROUND_HEADER]: '1' }));
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(touches()).toEqual([false, false]);
  });
});

describe('(2) link prefetch fan-out: no <Link> may prefetch an authenticated page', () => {
  const root = join(import.meta.dirname, '..');
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      if (statSync(p).isDirectory()) return n === '__tests__' || n === 'node_modules' ? [] : walk(p);
      return /\.tsx$/.test(n) && !/\.(test|spec)\./.test(n) ? [p] : [];
    });
  const users = walk(root).filter((f) => /from 'next\/link'/.test(readFileSync(f, 'utf8')));
  const tags = (src: string) => src.match(/<Link\b(?:=>|[^>])*>/g) ?? [];

  it('the rail and the global search are among the next/link users (the scan is not empty)', () => {
    const names = users.map((f) => f.replace(/\\/g, '/'));
    expect(names.some((f) => f.endsWith('core/shell/Rail.tsx'))).toBe(true);
    expect(names.some((f) => f.endsWith('core/shell/GlobalSearch.tsx'))).toBe(true);
  });
  it.each(['core/shell/Rail.tsx', 'core/shell/GlobalSearch.tsx'])('%s: every <Link> sets prefetch={false}', (rel) => {
    const t = tags(readFileSync(join(root, rel), 'utf8'));
    expect(t.length).toBeGreaterThan(0);
    for (const tag of t) expect(tag, tag).toMatch(/\bprefetch=\{false\}/);
  });
  it('anywhere else under core/ (C0-owned): every <Link> sets prefetch={false} (links in a nav or a list fan out to authenticated pages)', () => {
    const coreDir = join(root, 'core');
    for (const f of users.filter((u) => u.startsWith(coreDir))) for (const tag of tags(readFileSync(f, 'utf8'))) expect(tag, f).toMatch(/\bprefetch=\{false\}/);
  });
  it('nothing in the shell calls router.prefetch', () => {
    for (const f of walk(join(root, 'core', 'shell'))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/\.prefetch\(/);
  });
});
