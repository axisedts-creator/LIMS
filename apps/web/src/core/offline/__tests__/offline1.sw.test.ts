// T0D-OFFLINE-1 (design file section 6): the service worker caches only the app shell and static assets, never API responses or personal data;
// the update flow does not interrupt a user mid work. The worker is plain JS at apps/web/public/sw.js, run here in a vm with a fake `self`.
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../../../', import.meta.url));
const swPath = `${web}public/sw.js`;
const ORIGIN = 'https://lims.test';

function caches0() {
  const stores = new Map<string, Map<string, Response>>();
  const put = vi.fn(); const addAll = vi.fn();
  const cache = (name: string) => ({
    match: async (r: string | { url: string }) => stores.get(name)?.get(typeof r === 'string' ? r : r.url)?.clone(),
    put: async (r: string | { url: string }, res: Response) => { put(name, typeof r === 'string' ? r : r.url, res); stores.get(name)!.set(typeof r === 'string' ? r : r.url, res); },
    addAll: async (urls: string[]) => { addAll(name, urls); for (const u of urls) stores.get(name)!.set(new URL(u, ORIGIN).href, new Response('precached ' + u)); },
    add: async (u: string) => { addAll(name, [u]); stores.get(name)!.set(new URL(u, ORIGIN).href, new Response('precached ' + u)); },
  });
  return {
    stores, put, addAll,
    open: async (name: string) => { if (!stores.has(name)) stores.set(name, new Map()); return cache(name); },
    keys: async () => [...stores.keys()], delete: async (n: string) => stores.delete(n),
    match: async (r: string | { url: string }) => { for (const [n] of stores) { const m = await cache(n).match(r); if (m) return m; } return undefined; },
  };
}

function boot(precache = ['/', '/_next/static/chunks/main.js', '/_next/static/css/app.css'], net: (url: string) => Promise<Response> = async (u) => new Response('net ' + u)) {
  const handlers: Record<string, (e: any) => void> = {}; const caches = caches0(); const skipWaiting = vi.fn(); const claim = vi.fn();
  const fetchFn = vi.fn((r: any) => net(typeof r === 'string' ? r : r.url));
  const self: any = { addEventListener: (t: string, h: any) => { handlers[t] = h; }, skipWaiting, clients: { claim, matchAll: async () => [] }, location: { origin: ORIGIN },
    registration: { scope: ORIGIN + '/' }, __PRECACHE_URLS__: precache, __SHELL_URL__: '/' };
  const ctx: any = { self, caches, fetch: fetchFn, URL, Request, Response, Headers, console, Promise, Map, Set };
  ctx.globalThis = ctx; Object.assign(self, { caches, fetch: fetchFn });
  runInNewContext(readFileSync(swPath, 'utf8'), ctx, { filename: 'sw.js' });
  const waited: Promise<unknown>[] = [];
  const ev = (extra: object) => ({ waitUntil: (p: Promise<unknown>) => waited.push(Promise.resolve(p)), ...extra });
  const fire = async (type: string, extra: object = {}) => { const e = ev(extra); handlers[type]?.(e); await Promise.all(waited.splice(0)); return e; };
  const request = async (url: string, o: { method?: string; mode?: string; headers?: Record<string, string> } = {}) => {
    const req: any = { url: url.startsWith('http') ? url : ORIGIN + url, method: o.method ?? 'GET', mode: o.mode ?? 'cors', headers: new Headers(o.headers ?? {}), destination: '' };
    let responded: Promise<Response> | undefined;
    handlers.fetch?.({ request: req, respondWith: (p: any) => { responded = Promise.resolve(p); }, waitUntil: (p: Promise<unknown>) => waited.push(Promise.resolve(p)) });
    const res = responded ? await responded : undefined; await Promise.all(waited.splice(0));
    return { res, handled: !!responded };
  };
  return { handlers, caches, skipWaiting, claim, fetchFn, fire, request };
}

describe('service worker source', () => {
  it('exists at apps/web/public/sw.js and is plain JavaScript with the four lifecycle handlers', () => {
    expect(existsSync(swPath), 'apps/web/public/sw.js must exist').toBe(true);
    const src = readFileSync(swPath, 'utf8');
    for (const ev of ['install', 'activate', 'fetch', 'message']) expect(src, ev).toMatch(new RegExp(`addEventListener\\(\\s*['"]${ev}['"]`));
  });
});

describe('precache and offline serving of the app shell', () => {
  it('install precaches exactly the listed shell and static URLs into a versioned lims-shell- cache', async () => {
    const sw = boot();
    await sw.fire('install');
    expect(sw.caches.addAll).toHaveBeenCalled();
    const [name, urls] = sw.caches.addAll.mock.calls[0];
    expect(name).toMatch(/^lims-shell-/);
    expect(urls).toEqual(['/', '/_next/static/chunks/main.js', '/_next/static/css/app.css']);
  });

  it('serves a precached static asset from the cache without touching the network', async () => {
    const sw = boot();
    await sw.fire('install');
    const { res, handled } = await sw.request('/_next/static/chunks/main.js');
    expect(handled).toBe(true);
    expect(await res!.text()).toContain('precached');
    expect(sw.fetchFn).not.toHaveBeenCalled();
  });

  it('a page navigation while the network is down is answered with the cached app shell', async () => {
    const sw = boot(undefined, async () => { throw new TypeError('offline'); });
    await sw.fire('install');
    const { res, handled } = await sw.request('/billing/bills/123', { mode: 'navigate' });
    expect(handled).toBe(true);
    expect(await res!.text()).toContain('precached /');
  });

  it('activate deletes older lims-shell- caches, keeps the current one and caches of other owners; then claims clients', async () => {
    const sw = boot();
    await sw.caches.open('lims-shell-OLD'); await sw.caches.open('someone-elses');
    await sw.fire('install'); await sw.fire('activate');
    const names = await sw.caches.keys();
    expect(names).not.toContain('lims-shell-OLD');
    expect(names).toContain('someone-elses');
    expect(names.filter((n) => n.startsWith('lims-shell-')).length).toBe(1);
    expect(sw.claim).toHaveBeenCalled();
  });
});

describe('never caches API responses or personal data', () => {
  const never = [
    ['GET', '/v1/patients/0192f0d6-aaaa-7000-8000-000000000001'], ['GET', '/v1/core/sync/status?device_id=x'], ['POST', '/v1/core/sync/batches'],
    ['GET', '/api/session'], ['GET', '/_next/data/build-1/en/patients/1.json'], ['PUT', '/_next/static/x.js'], ['GET', 'https://cdn.other.test/lib.js'],
  ] as const;
  for (const [method, url] of never) {
    it(`${method} ${url}: nothing is written to any cache`, async () => {
      const sw = boot(undefined, async () => new Response(JSON.stringify({ name: 'Sita Rai' }), { headers: { 'content-type': 'application/json' } }));
      await sw.fire('install');
      sw.caches.put.mockClear();
      const { res } = await sw.request(url, { method });
      if (res) await res.text();
      await new Promise((r) => setTimeout(r, 10));
      expect(sw.caches.put).not.toHaveBeenCalled();
      for (const [, m] of sw.caches.stores) for (const v of m.values()) expect(await v.clone().text()).not.toContain('Sita');
    });
  }

  it('a request carrying an Authorization header or answered with Set-Cookie / Cache-Control: no-store is not cached even on a static looking path', async () => {
    for (const [headers, resHeaders] of [[{ authorization: 'Bearer t' }, {}], [{}, { 'set-cookie': 'sid=1' }], [{}, { 'cache-control': 'no-store' }]] as const) {
      const sw = boot(undefined, async () => new Response('body', { headers: resHeaders as Record<string, string> }));
      await sw.fire('install'); sw.caches.put.mockClear();
      const { res } = await sw.request('/_next/static/chunks/other.js', { headers: headers as Record<string, string> });
      if (res) await res.text();
      await new Promise((r) => setTimeout(r, 10));
      expect(sw.caches.put).not.toHaveBeenCalled();
    }
  });

  it('the worker source does not reference the API at all (no /v1/ URLs hard coded for caching)', () => {
    expect(readFileSync(swPath, 'utf8')).not.toMatch(/['"`]\/v1\/[^'"`]*['"`]\s*\)\s*;?\s*cache/);
  });
});

describe('update flow does not break a user mid work', () => {
  it('install never calls skipWaiting by itself; only a SKIP_WAITING message from the page does', async () => {
    const sw = boot();
    await sw.fire('install');
    expect(sw.skipWaiting).not.toHaveBeenCalled();
    await sw.fire('message', { data: { type: 'SKIP_WAITING' } });
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
    await sw.fire('message', { data: { type: 'SOMETHING_ELSE' } });
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('registerServiceWorker announces a waiting update through onUpdateReady and does not activate it on its own; applyUpdate refuses while busy', async () => {
    const { registerServiceWorker } = await import('../register-sw');
    const listeners: Record<string, () => void> = {}; const posted = vi.fn();
    const waiting = { postMessage: posted, state: 'installed' };
    const installing: any = { state: 'installing', addEventListener: (t: string, h: () => void) => { listeners[t] = h; } };
    const reg: any = { installing, waiting: null, addEventListener: (t: string, h: () => void) => { listeners['reg:' + t] = h; } };
    const register = vi.fn(async () => reg);
    const nav: any = { serviceWorker: { register, controller: {}, addEventListener: vi.fn() } };
    const onUpdateReady = vi.fn();
    const handle = await registerServiceWorker(nav, { onUpdateReady });
    expect(register).toHaveBeenCalledWith(expect.stringMatching(/sw\.js$/), expect.objectContaining({ scope: '/' }));
    reg.waiting = waiting; installing.state = 'installed'; listeners.statechange?.();
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    expect(posted).not.toHaveBeenCalled();
    expect(await handle.applyUpdate({ busy: () => true })).toBe(false);
    expect(posted).not.toHaveBeenCalled();
    expect(await handle.applyUpdate({ busy: () => false })).toBe(true);
    expect(posted).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });

  it('registerServiceWorker is a quiet no-op where service workers do not exist', async () => {
    const { registerServiceWorker } = await import('../register-sw');
    await expect(registerServiceWorker({} as never, { onUpdateReady: () => {} })).resolves.toBeTruthy();
  });
});
