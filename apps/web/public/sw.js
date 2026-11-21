/* T0D-OFFLINE-1 (LD-322; offline design section 6): app shell service worker, plain JS.
 * Precaches self.__PRECACHE_URLS__ (set by an optional /sw-manifest.js) and serves them offline. Runtime caching is
 * limited to same-origin GET of hashed build assets under /_next/static/. Page navigations go to the network and fall
 * back to the cached shell only when the network fails; their responses are never stored. Nothing else (API calls,
 * data routes, other origins, anything with credentials or no-store) is ever cached.
 * Updates: a new worker waits until the page posts SKIP_WAITING, so a user mid work is never switched under. */
if (typeof importScripts === 'function' && !self.__PRECACHE_URLS__) {
  try { importScripts('/sw-manifest.js'); } catch (e) { /* no manifest: runtime caching only */ }
}
var PRECACHE = Array.isArray(self.__PRECACHE_URLS__) ? self.__PRECACHE_URLS__.slice() : [];
var SHELL = new URL(self.__SHELL_URL__ || '/', self.location.origin).href;
var CACHE = 'lims-shell-' + (self.__BUILD_ID__ || hash(JSON.stringify(PRECACHE)));
var PRECACHED = new Set(PRECACHE.map(function (u) { return new URL(u, self.location.origin).href; }));

function hash(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function cacheable(req, res) {
  if (!res || !res.ok || (res.type !== 'basic' && res.type !== 'default')) return false;
  if (req.headers && req.headers.has('authorization')) return false;
  if (res.headers.has('set-cookie')) return false;
  var cc = (res.headers.get('cache-control') || '').toLowerCase();
  return cc.indexOf('no-store') === -1 && cc.indexOf('private') === -1;
}

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(PRECACHE); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) { return n.indexOf('lims-shell-') === 0 && n !== CACHE; }).map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(function () {
      return caches.open(CACHE).then(function (c) { return c.match(SHELL); }).then(function (r) { return r || Response.error(); });
    }));
    return;
  }
  var isStatic = url.pathname.indexOf('/_next/static/') === 0;
  if (!isStatic && !PRECACHED.has(url.href)) return;
  event.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(url.href).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (isStatic && cacheable(req, res)) event.waitUntil(c.put(url.href, res.clone()));
        return res;
      });
    });
  }));
});
