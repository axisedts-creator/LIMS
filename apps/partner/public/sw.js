// C13.T20 static-only service worker (02-TRD §3.7, US-16.2, 07-SECURITY ST14). Hand-written, no library.
// Caches ONLY build-hashed static assets (/_next/static/**), fonts, icons and /offline. It never stores an HTML document
// (except /offline), a BFF/JSON/PDF response or any URL with a query string. Navigations always go to the network; on
// failure /offline is served. No push subscription, no background sync, no browser storage beyond Cache Storage.
const STATIC_CACHE = 'partner-static-v1';
const OFFLINE_URL = '/offline';
const STATIC_PATH = /^\/(?:_next\/static|fonts|icons)\/.+/;
const NEVER_STORE_TYPE = /html|json|pdf/i;

const isOffline = (u) => u.pathname === OFFLINE_URL || u.pathname === OFFLINE_URL + '/';
const isStatic = (u) => u.origin === self.location.origin && u.search === '' && STATIC_PATH.test(u.pathname);
const isAllowed = (u) => u.origin === self.location.origin && u.search === '' && (isOffline(u) || STATIC_PATH.test(u.pathname));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.add(OFFLINE_URL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== STATIC_CACHE) await caches.delete(name); // legacy / foreign caches may hold pages or JSON
      }
      const cache = await caches.open(STATIC_CACHE);
      for (const req of await cache.keys()) {
        if (!isAllowed(new URL(req.url))) await cache.delete(req);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Network only. The page itself is never stored; a failed navigation shows the static offline page.
    event.respondWith(
      fetch(req).catch(async () => (await caches.match(OFFLINE_URL)) || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } })),
    );
    return;
  }

  if (!isStatic(url)) return; // BFF, _next/data, PDFs, anything with a query: browser default (network, no-store)

  event.respondWith(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && !NEVER_STORE_TYPE.test(res.headers.get('content-type') || '')) await cache.put(req, res.clone());
      return res;
    })(),
  );
});
