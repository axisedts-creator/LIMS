// C13.T05 shared harness: fake next/headers + next/navigation, a fetch fake standing in for the C2 identity API
// (/v1/identity/auth/*, C2 02-TRD §5.1). No msw/jsdom: apps/partner has no test dependencies and T05 tests may not add any.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const API = 'http://api.t05.test';
export const BFF_KEY = 'bff-key-partner-t05-synthetic';
export const ORIGIN = 'https://partner.t05.test'; // LIMS_ORIGIN_PARTNER
export const COOKIE = '__Host-lims_psid'; // browser-facing partner cookie (C13 02-TRD §4 item 2)
export const BFF_COOKIE = '__Host-lims_sid'; // server-to-server wire cookie of bffSession ops (contracts/openapi/_common.yaml, 08 R10)
export const SID = 'psid-existing-opaque-token-0123456789abcdefghijkl'; // opaque cookie value already in the browser
export const NEW_TOKEN = 'newptoken_abcdefghijklmnopqrstuvwxyz0123456789AB'; // LoginResult.session_token
export const JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzeW50aGV0aWMiOnRydWV9.c2lnbmF0dXJlc3ludGhldGlj'; // resolveSession.access_token
export const FACTOR = '0190f3a2-7b1c-7d3e-8a4f-5b6c7d8e9f01';
export const CLIENT_IP = '203.0.113.7';
export const AUTH = '/v1/identity/auth';

export class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

export interface SetCookie { name: string; value: string; opts: Record<string, unknown> }
export const jar = { current: undefined as string | undefined, set: [] as SetCookie[], cleared: [] as string[] };

const cookieStore = {
  get: (n: string) => (n === COOKIE && jar.current ? { name: n, value: jar.current } : undefined),
  getAll: () => (jar.current ? [{ name: COOKIE, value: jar.current }] : []),
  has: (n: string) => n === COOKIE && !!jar.current,
  set: (a: string | { name: string; value: string; [k: string]: unknown }, v?: string, o?: Record<string, unknown>) => {
    const c = typeof a === 'string' ? { name: a, value: v ?? '', opts: o ?? {} } : (({ name, value, ...opts }) => ({ name, value, opts }))(a);
    if (c.value === '' || c.opts.maxAge === 0) jar.cleared.push(c.name);
    else jar.set.push(c);
  },
  delete: (a: string | { name: string }) => {
    jar.cleared.push(typeof a === 'string' ? a : a.name);
  },
};
export const headerStore = new Headers();

export const headersMock = { cookies: async () => cookieStore, headers: async () => headerStore };
export const navigationMock = {
  redirect: (url: string) => { throw new RedirectSignal(url); },
  permanentRedirect: (url: string) => { throw new RedirectSignal(url); },
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
};

export interface Seen { method: string; path: string; headers: Headers; body: unknown }
export const seen: Seen[] = [];
export const apiCalls = (suffix: string) => seen.filter((s) => s.path === `${AUTH}${suffix}`);

export const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  ({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra });

export const sessionState = (state: string, absoluteMs = 8 * 3600_000, kind = 'partner') => ({
  session_id: '0190f3a2-0000-7000-8000-000000000001',
  kind,
  state,
  aal: state === 'active' ? 'aal2' : 'aal1',
  idle_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  absolute_expires_at: new Date(Date.now() + absoluteMs).toISOString(),
  actor: { display_name: 'Partner Admin', tenant_code: 'alpha', roles: ['partner_admin'] },
});
export const resolved = (state = 'active') => ({
  access_token: JWT,
  access_expires_at: new Date(Date.now() + 300_000).toISOString(),
  session: sessionState(state),
});

// per-test response overrides: URL pathname (e.g. /v1/identity/auth/partner/login or /v1/partners/me) -> (parsed body) => Response
export const reply: Record<string, (body: any, req: Request) => Response | Promise<Response>> = {};
export const resetApi = () => {
  seen.length = 0;
  jar.current = SID;
  jar.set.length = 0;
  jar.cleared.length = 0;
  for (const k of Object.keys(reply)) delete reply[k];
  for (const k of [...headerStore.keys()]) headerStore.delete(k);
  headerStore.set('x-forwarded-for', CLIENT_IP);
  headerStore.set('origin', ORIGIN);
  headerStore.set('sec-fetch-site', 'same-origin');
};

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers },
  });

const realFetch = globalThis.fetch;
export function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as never, init);
    const url = new URL(req.url);
    if (url.origin !== API) throw new Error(`T05: unexpected network call to ${req.url} (only ${API} is mocked)`);
    const body = await req.clone().json().catch(() => undefined);
    seen.push({ method: req.method, path: url.pathname, headers: req.headers, body });
    const h = reply[url.pathname];
    return h ? h(body, req) : json(500, problem('common.internal', 500));
  }) as typeof fetch;
}
export const restoreFetch = () => { globalThis.fetch = realFetch; };
export const networkError = (): never => { throw new TypeError('fetch failed'); };

export function setEnv() {
  const f = join(mkdtempSync(join(tmpdir(), 't05-')), 'partner-bff.key');
  writeFileSync(f, BFF_KEY);
  process.env.LIMS_PARTNER_BFF_KEY_FILE = f;
  process.env.LIMS_PARTNER_BFF_API_URL = API;
  process.env.LIMS_ORIGIN_PARTNER = ORIGIN;
  process.env.LIMS_PARTNER_BFF_SESSION_CACHE_SECONDS = '0'; // every resolve hits the fake API in tests
}

/** Runs an action/guard; returns its result or the redirect URL it threw. */
export async function run<T>(fn: () => Promise<T>): Promise<{ result?: T; redirect?: string }> {
  try {
    return { result: await fn() };
  } catch (e) {
    if (e instanceof RedirectSignal) return { redirect: e.url };
    throw e;
  }
}
export const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
