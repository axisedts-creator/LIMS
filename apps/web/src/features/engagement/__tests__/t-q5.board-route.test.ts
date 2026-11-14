// T-Q5 — BFF board route: GET /queue-display/api/board (US-EN-22.2/.3/.4; 02-TRD §4.10, 03-APP-FLOW §7; 07-SECURITY AB-8).
// ASSUMED path (02-TRD file tree): apps/web/src/app/(display)/queue-display/api/board/route.ts exporting GET(req: Request).
// The route reads cookie __Secure-lims_qdisp (from the Cookie header or next/headers) and calls Q9 with X-Lims-Display-Token. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
let jar: Record<string, string> = {};
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (n in jar ? { name: n, value: jar[n] } : undefined),
    getAll: () => Object.entries(jar).map(([name, value]) => ({ name, value })),
    has: (n: string) => n in jar,
  }),
  headers: async () => new Headers(),
}));

const ORIGIN = 'http://api.test';
const TOKEN = 'dT0kenSynthetic_0123456789abcdefghijklmnopq'; // synthetic
const COOKIE = '__Secure-lims_qdisp';
process.env.LIMS_ORIGIN_API = ORIGIN;

const BOARD = {
  centre_display_name: 'Synthetic Lab',
  board_version: 7,
  generated_at: '2026-11-12T04:00:00Z',
  now_calling: [{ token_label: 'A-007', counter_display_name: 'Counter 2', queue_display_name: 'Reception', called_at: '2026-11-12T03:59:00Z' }],
  waiting: [{ queue_display_name: 'Reception', waiting_count: 3 }],
};
const problem = (status: number, code: string) =>
  new Response(JSON.stringify({ type: 'about:blank', title: code, status, code }), { status, headers: { 'content-type': 'application/problem+json' } });
const ok = () => new Response(JSON.stringify(BOARD), { status: 200, headers: { 'content-type': 'application/json', etag: '"7"' } });

let calls: { url: URL; headers: Headers }[] = [];
let upstream: () => Response | Promise<Response> = ok;
beforeEach(() => {
  calls = [];
  jar = {};
  upstream = ok;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : undefined;
    calls.push({ url: new URL(req ? req.url : String(input)), headers: new Headers(init?.headers ?? req?.headers) });
    return upstream();
  });
});
afterEach(() => vi.unstubAllGlobals());

const GET = async (init: { cookie?: boolean; inm?: string } = { cookie: true }) => {
  const m = (await import(/* @vite-ignore */ '../../../app/(display)/queue-display/api/board/route')) as { GET: (r: Request) => Promise<Response> };
  const headers = new Headers();
  if (init.cookie) {
    jar[COOKIE] = TOKEN;
    headers.set('cookie', `${COOKIE}=${TOKEN}`);
  }
  if (init.inm) headers.set('if-none-match', init.inm);
  return m.GET(new Request('http://localhost/queue-display/api/board', { headers }));
};

describe('GET /queue-display/api/board', () => {
  it('no display cookie → 401 auth.unauthenticated and the API is never called', async () => {
    const r = await GET({ cookie: false });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { code: string }).code).toBe('auth.unauthenticated');
    expect(calls).toHaveLength(0);
  });

  it('cookie → Q9 GET /v1/engagement/queue-board with X-Lims-Display-Token only (no bearer, no cookie forwarded)', async () => {
    const r = await GET();
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe(`${ORIGIN}/v1/engagement/queue-board`);
    expect(calls[0]!.headers.get('x-lims-display-token')).toBe(TOKEN);
    expect(calls[0]!.headers.get('authorization')).toBeNull();
    expect(calls[0]!.headers.get('cookie')).toBeNull();
    expect(await r.json()).toEqual(BOARD);
  });

  it('200 is relayed with ETag and Cache-Control: no-store (display polls are never cached)', async () => {
    const r = await GET();
    expect(r.headers.get('etag')).toBe('"7"');
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('If-None-Match is forwarded and an upstream 304 becomes an empty 304 (US-EN-22.2)', async () => {
    upstream = () => new Response(null, { status: 304, headers: { etag: '"7"' } });
    const r = await GET({ cookie: true, inm: '"7"' });
    expect(calls[0]!.headers.get('if-none-match')).toBe('"7"');
    expect(r.status).toBe(304);
    expect(await r.text()).toBe('');
  });

  it('revoked display (upstream 401) → 401 auth.unauthenticated so the page can show "no longer paired" (US-EN-22.4)', async () => {
    upstream = () => problem(401, 'auth.unauthenticated');
    const r = await GET();
    expect(r.status).toBe(401);
    expect(((await r.json()) as { code: string }).code).toBe('auth.unauthenticated');
  });

  it('upstream failure (5xx or network error) → 5xx, and the display token is never echoed in body or headers', async () => {
    const failures: (() => Response)[] = [
      () => problem(500, 'common.internal'),
      () => {
        throw new Error(`boom ${TOKEN}`);
      },
    ];
    for (const f of failures) {
      upstream = f;
      const r = await GET();
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect(await r.text()).not.toContain(TOKEN);
      expect([...r.headers.values()].join('\n')).not.toContain(TOKEN);
    }
  });

  it('only GET is exported (no state change through the display route)', async () => {
    const m = (await import(/* @vite-ignore */ '../../../app/(display)/queue-display/api/board/route')) as Record<string, unknown>;
    for (const v of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(m[v], v).toBeUndefined();
  });
});
