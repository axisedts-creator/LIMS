// C13.T20 — US-16.2 / 02-TRD §3.7 / 07-SECURITY ST14: the service worker caches ONLY build-hashed static assets + /offline.
// No browser-automation package is installed, so public/sw.js is executed in a node:vm sandbox against a fake CacheStorage; the
// test then ENUMERATES Cache Storage after browsing PHI pages (plan row T20): no HTML (except /offline) and no JSON entries.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

const SW = fileURLToPath(new URL('../../public/sw.js', import.meta.url));
const ORIGIN = 'https://partner.test';
const PHI = 'Synthetic Binita Test';
const ALLOWED = /^\/offline\/?$|^\/_next\/static\/.+|^\/fonts\/.+|^\/icons\/.+/;
const OFFLINE_HTML = '<html><body>OFFLINE-PAGE-MARKER</body></html>';

type Listener = (ev: Record<string, unknown>) => void;
interface Req { url: string; method: string; mode: string; destination: string; headers: Headers; clone(): Req }
const mkReq = (path: string, o: { method?: string; mode?: string; destination?: string; accept?: string } = {}): Req => {
  const r: Req = { url: path.startsWith('http') ? path : ORIGIN + path, method: o.method ?? 'GET', mode: o.mode ?? 'cors', destination: o.destination ?? '', headers: new Headers(o.accept ? { accept: o.accept } : {}), clone: () => r };
  return r;
};
const nav = (path: string) => mkReq(path, { mode: 'navigate', destination: 'document', accept: 'text/html' });

function makeWorld() {
  const stores = new Map<string, Map<string, Response>>();
  const key = (r: Req | string) => (typeof r === 'string' ? (r.startsWith('http') ? r : ORIGIN + r) : r.url);
  const cacheOf = (m: Map<string, Response>) => ({
    put: async (r: Req | string, res: Response) => { m.set(key(r), res.clone()); },
    add: async (r: Req | string) => { const res = await world.fetch(r); if (!res.ok) throw new TypeError('add failed'); m.set(key(r), res.clone()); },
    addAll: async (rs: (Req | string)[]) => { for (const r of rs) await cacheOf(m).add(r); },
    match: async (r: Req | string) => m.get(key(r))?.clone(),
    keys: async () => [...m.keys()].map((u) => mkReq(u)),
    delete: async (r: Req | string) => m.delete(key(r)),
  });
  const caches = {
    open: async (n: string) => { if (!stores.has(n)) stores.set(n, new Map()); return cacheOf(stores.get(n)!); },
    keys: async () => [...stores.keys()],
    has: async (n: string) => stores.has(n),
    delete: async (n: string) => stores.delete(n),
    match: async (r: Req | string) => { for (const m of stores.values()) { const h = m.get(key(r)); if (h) return h.clone(); } return undefined; },
  };
  const listeners: Record<string, Listener[]> = {};
  const world = {
    online: true,
    network: {} as Record<string, { status?: number; ct: string; body: string }>,
    stores, caches, listeners,
    fetch: async (input: Req | string): Promise<Response> => {
      if (!world.online) throw new TypeError('Failed to fetch');
      const u = new URL(key(input));
      const hit = world.network[u.pathname] ?? world.network[u.pathname + u.search];
      if (!hit) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      return new Response(hit.body, { status: hit.status ?? 200, headers: { 'content-type': hit.ct } });
    },
    async fire(type: string, extra: Record<string, unknown> = {}) {
      const waits: Promise<unknown>[] = [];
      let responded: Promise<Response> | undefined;
      const ev = { ...extra, waitUntil: (p: Promise<unknown>) => { waits.push(Promise.resolve(p)); }, respondWith: (p: Promise<Response> | Response) => { responded = Promise.resolve(p); } };
      for (const l of listeners[type] ?? []) l(ev);
      const res = responded ? await responded.then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e })) : undefined;
      await Promise.all(waits);
      await new Promise((r) => setTimeout(r, 5));
      return res;
    },
    load() {
      expect(existsSync(SW), 'apps/partner/public/sw.js must exist').toBe(true);
      const self: Record<string, unknown> = {
        addEventListener: (t: string, l: Listener) => { (listeners[t] ??= []).push(l); },
        skipWaiting: async () => {}, clients: { claim: async () => {} }, caches, fetch: world.fetch, location: new URL(ORIGIN + '/sw.js'), registration: {},
      };
      const sandbox = { ...self, self, URL, URLSearchParams, Request, Response, Headers, console, Promise, setTimeout, clearTimeout };
      vm.runInNewContext(readFileSync(SW, 'utf8'), sandbox, { filename: 'sw.js' });
    },
    async entries() {
      const out: { cache: string; path: string; ct: string; body: string }[] = [];
      for (const [cache, m] of stores) for (const [u, res] of m) out.push({ cache, path: new URL(u).pathname, ct: res.headers.get('content-type') ?? '', body: await res.clone().text() });
      return out;
    },
  };
  return world;
}

let w: ReturnType<typeof makeWorld>;
beforeEach(() => {
  w = makeWorld();
  w.network = {
    '/offline': { ct: 'text/html; charset=utf-8', body: OFFLINE_HTML },
    '/orders': { ct: 'text/html; charset=utf-8', body: `<html>${PHI} orders</html>` },
    '/orders/o-1': { ct: 'text/html; charset=utf-8', body: `<html>${PHI} order detail</html>` },
    '/reports/r-1': { ct: 'text/html; charset=utf-8', body: `<html>${PHI} report</html>` },
    '/manifests/m-1/print': { ct: 'text/html; charset=utf-8', body: `<html>${PHI} print</html>` },
    '/api/bff/orders': { ct: 'application/json', body: JSON.stringify({ data: [{ patient_name: PHI }] }) },
    '/api/bff/reports/r-1': { ct: 'application/json; charset=utf-8', body: JSON.stringify({ patient_name: PHI }) },
    '/_next/data/b1/orders.json': { ct: 'application/json', body: JSON.stringify({ pageProps: { name: PHI } }) },
    '/reports/r-1/slip/s-1/file': { ct: 'application/pdf', body: `%PDF ${PHI}` },
    '/_next/static/chunks/app-3f9c2a1b.js': { ct: 'text/javascript', body: 'console.log(1)' },
    '/_next/static/css/7d1e0c.css': { ct: 'text/css', body: 'a{}' },
    '/fonts/plus-jakarta-sans.woff2': { ct: 'font/woff2', body: 'FONT' },
    '/icons/icon-192.png': { ct: 'image/png', body: 'PNG' },
  };
});

async function browsePhiSession() {
  const pages = ['/orders', '/orders/o-1', '/reports/r-1', '/manifests/m-1/print'];
  for (const p of pages) await w.fire('fetch', { request: nav(p) });
  for (const p of ['/api/bff/orders', '/api/bff/reports/r-1', '/_next/data/b1/orders.json', '/reports/r-1/slip/s-1/file']) await w.fire('fetch', { request: mkReq(p) });
  await w.fire('fetch', { request: mkReq('/api/bff/orders', { method: 'POST' }) });
  await w.fire('fetch', { request: mkReq('/orders?q=' + encodeURIComponent(PHI)) });
  await w.fire('fetch', { request: mkReq('https://cdn.example.test/_next/static/x-123.js') });
  for (const p of ['/_next/static/chunks/app-3f9c2a1b.js', '/_next/static/css/7d1e0c.css', '/fonts/plus-jakarta-sans.woff2', '/icons/icon-192.png']) await w.fire('fetch', { request: mkReq(p) });
}

describe('sw.js — static-only Cache Storage (US-16.2)', () => {
  it('install precaches /offline and nothing else but allowed static paths', async () => {
    w.load();
    await w.fire('install');
    const e = await w.entries();
    expect(e.map((x) => x.path)).toContain('/offline');
    for (const x of e) expect(x.path, `${x.cache}: ${x.path}`).toMatch(ALLOWED);
  });

  it('after browsing PHI pages, Cache Storage holds no HTML (except /offline), no JSON, no PDF, no PHI text, and only hashed-static/offline URLs', async () => {
    w.load();
    await w.fire('install');
    await browsePhiSession();
    const e = await w.entries();
    expect(e.length).toBeGreaterThan(0);
    for (const x of e) {
      expect(x.path, `url ${x.path}`).toMatch(ALLOWED);
      if (x.path !== '/offline') { expect(x.ct, x.path).not.toMatch(/html|json|pdf/i); }
      expect(x.body, x.path).not.toContain('Binita');
      expect(x.body, x.path).not.toContain('patient_name');
    }
    // same-origin only; no query-string entries; nothing for the cross-origin host
    for (const [, m] of w.stores) for (const u of m.keys()) { expect(new URL(u).origin).toBe(ORIGIN); expect(new URL(u).search).toBe(''); }
  });

  it('online navigation is a pass-through from the network (status + body) and is not cached', async () => {
    w.load();
    await w.fire('install');
    const before = (await w.entries()).length;
    const out = await w.fire('fetch', { request: nav('/orders/o-1') });
    expect(out?.ok).toBe(true);
    if (out?.ok) { expect(out.r.status).toBe(200); expect(await out.r.text()).toContain('order detail'); }
    expect((await w.entries()).length).toBe(before);
  });

  it('offline navigation serves /offline — never a previously viewed patient page', async () => {
    w.load();
    await w.fire('install');
    await browsePhiSession();
    w.online = false;
    for (const p of ['/orders/o-1', '/reports/r-1', '/orders']) {
      const out = await w.fire('fetch', { request: nav(p) });
      expect(out?.ok, p).toBe(true);
      if (out?.ok) { const t = await out.r.text(); expect(t, p).toContain('OFFLINE-PAGE-MARKER'); expect(t, p).not.toContain('Binita'); }
    }
  });

  it('offline data requests (BFF JSON, _next/data) never resolve with cached patient data or the offline HTML', async () => {
    w.load();
    await w.fire('install');
    await browsePhiSession();
    w.online = false;
    for (const p of ['/api/bff/orders', '/api/bff/reports/r-1', '/_next/data/b1/orders.json', '/reports/r-1/slip/s-1/file']) {
      const out = await w.fire('fetch', { request: mkReq(p) });
      if (out?.ok) { const t = await out.r.text(); expect(t, p).not.toContain('Binita'); expect(t, p).not.toContain('OFFLINE-PAGE-MARKER'); }
    }
  });

  it('activate purges any pre-existing cache entry that is not a hashed static asset or /offline (e.g. a legacy pages cache)', async () => {
    w.load();
    await (await w.caches.open('pages-v0')).put('/orders/o-1', new Response(`<html>${PHI}</html>`, { headers: { 'content-type': 'text/html' } }));
    await (await w.caches.open('api-v0')).put('/api/bff/orders', new Response('{"patient_name":"x"}', { headers: { 'content-type': 'application/json' } }));
    await w.fire('install');
    await w.fire('activate');
    for (const x of await w.entries()) expect(x.path, `${x.cache}: ${x.path}`).toMatch(ALLOWED);
  });

  it('registers only install/activate/fetch(/message) — no push, no background sync (02-TRD §3.7)', () => {
    w.load();
    for (const t of Object.keys(w.listeners)) expect(['install', 'activate', 'fetch', 'message'], t).toContain(t);
    expect(w.listeners.fetch?.length).toBeGreaterThan(0);
  });

  it('source: no localStorage / IndexedDB / push / sync API use', () => {
    expect(existsSync(SW)).toBe(true);
    const src = readFileSync(SW, 'utf8');
    for (const bad of [/localStorage/, /indexedDB/i, /PushManager|pushManager|['"]push['"]/, /SyncManager|['"]sync['"]|periodicsync/i]) expect(src).not.toMatch(bad);
  });
});
