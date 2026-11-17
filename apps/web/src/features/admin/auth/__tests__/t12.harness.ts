// C2.T12 shared harness: fake next/headers + next/navigation, MSW stand-in for the identity API (02-TRD §5.1).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const API = 'http://api.t12.test';
export const BFF_KEY = 'bff-key-staff-web-t12-synthetic';
export const SID = 'sid-existing-opaque-token-0123456789abcdefghijklmn'; // opaque cookie value already in the browser
export const NEW_TOKEN = 'newtoken_abcdefghijklmnopqrstuvwxyz0123456789ABC'; // LoginResult.session_token
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
  get: (n: string) => (n === '__Host-lims_sid' && jar.current ? { name: n, value: jar.current } : undefined),
  getAll: () => (jar.current ? [{ name: '__Host-lims_sid', value: jar.current }] : []),
  has: (n: string) => n === '__Host-lims_sid' && !!jar.current,
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

export const sessionState = (state: string, absoluteMs = 8 * 3600_000) => ({
  session_id: '0190f3a2-0000-7000-8000-000000000001',
  kind: 'tenant_staff',
  state,
  aal: 'aal1',
  idle_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  absolute_expires_at: new Date(Date.now() + absoluteMs).toISOString(),
  actor: { display_name: 'Test User', tenant_code: 'alpha', roles: ['lab_admin'] },
});

// per-test response overrides: path suffix after /v1/identity/auth -> (parsed body) => Response
export const reply: Record<string, (body: any) => Response> = {};
export const resetApi = () => {
  seen.length = 0;
  jar.current = SID;
  jar.set.length = 0;
  jar.cleared.length = 0;
  for (const k of Object.keys(reply)) delete reply[k];
  for (const k of [...headerStore.keys()]) headerStore.delete(k);
  headerStore.set('x-forwarded-for', CLIENT_IP);
  headerStore.set('origin', 'http://staff.t12.test');
};

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  HttpResponse.json(body as never, { status, headers: status >= 400 ? { 'content-type': 'application/problem+json', ...headers } : headers });

export const api = setupServer(
  http.all(`${API}${AUTH}/*`, async ({ request }) => {
    const path = new URL(request.url).pathname;
    const body = await request.json().catch(() => undefined);
    seen.push({ method: request.method, path, headers: request.headers, body });
    const h = reply[path.slice(AUTH.length)];
    return h ? h(body) : json(500, problem('common.internal', 500));
  }),
);

export function setEnv() {
  const f = join(mkdtempSync(join(tmpdir(), 't12-')), 'bff.key');
  writeFileSync(f, BFF_KEY);
  process.env.LIMS_WEB_BFF_KEY_FILE = f;
  process.env.LIMS_ORIGIN_API = API;
  process.env.LIMS_ORIGIN_STAFF_WEB = 'http://staff.t12.test';
}

/** Runs a server action; returns its result or the redirect URL it threw. */
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
