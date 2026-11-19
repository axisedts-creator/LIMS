// T0D-OFFLINE-1 shared test helpers (tester-owned). Test-only: fake IndexedDB comes from `fake-indexeddb` (devDependency, pinned by the writer).
//
// CONTRACT the writer implements (all under apps/web/src/core/offline/, re-exported from index.ts; names are what the tests import):
//   store.ts     openOfflineStore({ dbName?, now?, retentionDays = 14, maxPinFailures = 10 }) -> OfflineStore
//                  setupPin(pin, { userId }) (online sign in; also stamps the online sign in time), markOnlineSignIn(), unlock(pin), lock(),
//                  isUnlocked(), status() -> { state: 'empty'|'locked'|'unlocked'|'wiped'|'revoked', failedAttempts },
//                  put/get/remove/keys(storeName: 'refdata'|'counters'|'meta', key, value), wipe(reason), markRevoked(), purgeExpired() -> boolean
//                  unlock -> { ok: true } | { ok: false, reason: 'wrong_pin', attemptsLeft } | { ok: false, reason: 'wiped'|'revoked'|'expired'|'not_setup' }
//   outbox.ts    createOutbox(store, { deviceId, userId, now }) -> { append(input, localChanges?), pending(limit?), count(), remove(opIds),
//                  recordAttempt(opIds, nextAttemptAt), moveToAttention(opId, code), moveToConflicts(opId, conflictId), needsAttention(),
//                  conflicts(), saveNumberMappings(m[]), numberMappings() }; every method rejects with Error.code 'offline.locked' while locked
//   engine.ts    createSyncEngine({ outbox, fetch, deviceId, now, random, locks?, channelName?, baseDelayMs?, maxDelayMs? })
//                  -> { syncOnce(), drain(), close(), nextAttemptAt() }; backoffDelayMs(attempt, { baseMs, maxMs }, random)
//   connectivity.ts createConnectivity({ fetch, now, timeoutMs, deviceId?, internetProbeUrl? }) -> { check(), setSyncing(b), refreshStatus(), state(), skewMs(), skewFlag() }
//   device.ts    registerDevice({ fetch, store, now, deviceLabel, appVersion }) -> { id }; pollDeviceStatus({ fetch, store, deviceId })
//   register-sw.ts registerServiceWorker(nav, { onUpdateReady }) -> { applyUpdate({ busy }) }
//   apps/web/public/sw.js  plain JS service worker; reads self.__PRECACHE_URLS__ (array) and self.__SHELL_URL__ (default '/')
import 'fake-indexeddb/auto';
import { vi } from 'vitest';

export const PIN = '481516';
export const USER = '0192f0d6-0000-7000-8000-000000000001';
export const DEVICE = '0192f0d6-0000-7000-8000-0000000000d1';
export const T0 = Date.parse('2026-11-18T06:00:00.000Z');
const DAY = 86_400_000;
export const days = (n: number) => n * DAY;

let n = 0;
export const freshDb = () => `lims-offline-test-${Date.now()}-${++n}`;
export const clock = (start = T0) => { const c = { t: start, now: () => c.t, advance: (ms: number) => { c.t += ms; } }; return c; };
export const seqRandom = (values: number[]) => { let i = 0; return () => values[i++ % values.length]; };

export async function newStore(over: Record<string, unknown> = {}) {
  const { openOfflineStore } = await import('../store');
  const c = clock();
  const dbName = freshDb();
  const store = await openOfflineStore({ dbName, now: c.now, ...over });
  return { store, c, dbName, reopen: () => openOfflineStore({ dbName, now: c.now, ...over }) };
}
export async function unlockedStore(over: Record<string, unknown> = {}) {
  const env = await newStore(over);
  await env.store.setupPin(PIN, { userId: USER });
  const r = await env.store.unlock(PIN);
  if (!r.ok) throw new Error('fixture unlock failed: ' + JSON.stringify(r));
  return env;
}
export async function newOutbox(env: { store: unknown; c: { now: () => number } }) {
  const { createOutbox } = await import('../outbox');
  return createOutbox(env.store as never, { deviceId: DEVICE, userId: USER, now: env.c.now });
}
export const orderOp = (i: number, extra = 0) => ({
  op_type: 'registration.create_order' as const,
  payload: { patient: { patient_id: `p-${i}` }, note: 'x'.repeat(extra) },
});

/** Every record of every object store, read with the raw IndexedDB API, as one JSON-ish string (typed arrays -> hex). */
export async function rawDump(dbName: string): Promise<string> {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open(dbName); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const out: Record<string, unknown[]> = {};
  const names = Array.from(db.objectStoreNames);
  for (const name of names) {
    out[name] = await new Promise<unknown[]>((res, rej) => { const q = db.transaction(name).objectStore(name).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  }
  db.close();
  return JSON.stringify(out, (_k, v) => (v instanceof ArrayBuffer ? hex(new Uint8Array(v)) : ArrayBuffer.isView(v) ? hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) : v));
}
export async function rawCounts(dbName: string): Promise<Record<string, number>> {
  const db: IDBDatabase = await new Promise((res, rej) => { const r = indexedDB.open(dbName); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const out: Record<string, number> = {};
  for (const name of Array.from(db.objectStoreNames)) out[name] = await new Promise<number>((res, rej) => { const q = db.transaction(name).objectStore(name).count(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  db.close();
  return out;
}
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

/** Minimal Web Locks stand-in with real exclusive semantics (ifAvailable supported). Shared between "tabs" to model one browser. */
export function fakeLocks() {
  const held = new Set<string>(); const waiting = new Map<string, Array<() => void>>();
  const release = (name: string) => { held.delete(name); const next = waiting.get(name)?.shift(); if (next) next(); };
  return {
    held,
    async request(name: string, a: unknown, b?: unknown) {
      const opts = (typeof a === 'function' ? {} : a) as { ifAvailable?: boolean }; const cb = (typeof a === 'function' ? a : b) as (l: unknown) => unknown;
      if (held.has(name)) {
        if (opts.ifAvailable) return cb(null);
        await new Promise<void>((r) => { const q = waiting.get(name) ?? []; q.push(r); waiting.set(name, q); });
      }
      held.add(name);
      try { return await cb({ name, mode: 'exclusive' }); } finally { release(name); }
    },
  };
}

type Handler = (req: { url: string; init: RequestInit; body: any }) => { status: number; body?: unknown; headers?: Record<string, string> } | Promise<{ status: number; body?: unknown; headers?: Record<string, string> }> | 'throw' | 'hang';
/** Recording fetch double that speaks the real sync operations. Route table is matched by "METHOD path-prefix". */
export function fakeServer(over: Record<string, Handler> = {}) {
  const calls: Array<{ method: string; url: string; path: string; headers: Record<string, string>; body: any; bytes: number }> = [];
  const batches: Array<{ ids: string[]; body: any; bytes: number }> = [];
  const routes: Record<string, Handler> = {
    'POST /v1/core/sync/batches': ({ body }) => ({ status: 200, body: { results: body.operations.map((o: { op_id: string }) => ({ op_id: o.op_id, status: 'accepted' })) } }),
    'GET /v1/core/health/live': () => ({ status: 200, body: { status: 'ok' } }),
    'GET /v1/core/sync/status': () => ({ status: 200, body: statusBody() }),
    'POST /v1/core/sync/devices': ({ body }) => ({ status: 200, body: { ...body, user_id: USER, status: 'active' } }),
    ...over,
  };
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(typeof input === 'object' && 'url' in input ? input.url : input);
    const path = new URL(url, 'https://lims.test').pathname; const method = (init.method ?? 'GET').toUpperCase();
    const raw = typeof init.body === 'string' ? init.body : '';
    const body = raw ? JSON.parse(raw) : undefined;
    const headers = Object.fromEntries(new Headers(init.headers as HeadersInit).entries());
    calls.push({ method, url, path, headers, body, bytes: new TextEncoder().encode(raw).length });
    if (method === 'POST' && path === '/v1/core/sync/batches') batches.push({ ids: (body?.operations ?? []).map((o: { op_id: string }) => o.op_id), body, bytes: new TextEncoder().encode(raw).length });
    const key = Object.keys(routes).filter((k) => k.split(' ')[0] === method && path.startsWith(k.split(' ')[1])).sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response(JSON.stringify({ code: 'common.not_found' }), { status: 404, headers: { 'content-type': 'application/problem+json' } });
    const r = await routes[key]({ url, init, body });
    if (r === 'throw') throw new TypeError('Failed to fetch');
    if (r === 'hang') return new Promise<Response>(() => {});
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, mock: fetch, calls, batches, routes };
}
export const statusBody = (over: Record<string, unknown> = {}) => ({
  server_time: new Date(T0).toISOString(), device_status: 'active',
  limits: { max_batch_operations: 50, max_batch_bytes: 1_048_576 }, retry: { base_delay_ms: 1000, max_delay_ms: 300_000, jitter: 'full' },
  offline_approval_allowed: false, ...over,
});

export async function newEngine(env: Awaited<ReturnType<typeof unlockedStore>>, server: ReturnType<typeof fakeServer>, over: Record<string, unknown> = {}) {
  const { createSyncEngine } = await import('../engine');
  const outbox = await newOutbox(env);
  const engine = createSyncEngine({ outbox, fetch: server.fetch, deviceId: DEVICE, now: env.c.now, random: () => 0.5, locks: fakeLocks(), baseDelayMs: 1000, maxDelayMs: 300_000, ...over } as never);
  return { engine, outbox };
}
