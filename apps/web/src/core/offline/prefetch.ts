// T0D-OFFLINE-2 (LD-322; offline design section 3): reference data prefetch through pullChanges (POST /v1/core/sync/pull).
// When online and idle, the cacheable reads the signed in role may see are pulled with incremental cursors and kept encrypted
// in the 'refdata' store. Each round's documents and cursors are written in ONE transaction, so a later run resumes where the
// last good round stopped. A size cap (default 150 MB) evicts the least recently used patients; catalogue types are never evicted.
import { timedFetch } from './connectivity';
import type { OfflineStore, SealedRecord } from './store';

/** Copied from services/api/src/core/sync/pull.service.ts SOURCES (the server's own permission per type).
 *  worklist_item and permission are not requested: the server fails them closed until the lead maps them. */
export const PREFETCH_ENTITIES = [
  { entity_type: 'test', permission: 'catalog.test.read' },
  { entity_type: 'parameter', permission: 'catalog.test.read' },
  { entity_type: 'doctor', permission: 'catalog.referrer.read' },
  { entity_type: 'centre', permission: 'identity.centre.read' },
  { entity_type: 'price_list_version', permission: 'catalog.price_list.read' },
  { entity_type: 'verification_policy', permission: 'lab.verification_policy.read' },
  { entity_type: 'print_profile', permission: 'reporting.settings.manage' },
  { entity_type: 'patient', permission: 'frontdesk.patient.read' },
] as const;
export const DEFAULT_CACHE_CAP_BYTES = 150 * 1024 * 1024;
const EVICTABLE = 'patient';
const MAX_ROUNDS = 500;
const META = 'prefetch';

interface Meta { cursors: Record<string, string>; done: Record<string, boolean>; fetchedAt: number | null; index: Record<string, [bytes: number, usedAt: number]> }
interface Change { entity_type: string; upserts?: Array<{ id: string; document: unknown }>; tombstones?: Array<{ id: string }>; next_cursor?: string; has_more?: boolean }
export interface PrefetchResult { ok: boolean; skipped?: 'offline' | 'busy' | 'no_permission' | 'locked' | 'error'; requested: string[]; evicted: number }

export interface PrefetchOptions {
  store: OfflineStore; fetch?: typeof fetch; deviceId: string; permissions: readonly string[]; now?: () => number;
  capBytes?: number; limit?: number; isOnline?: () => boolean; isIdle?: () => boolean; baseUrl?: string; timeoutMs?: number;
}

/** a document as the read API returns it; its shape depends on the entity type */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- per entity type JSON, typed by the caller through the generic
type Doc = any;
const enc = new TextEncoder();
const rk = (type: string, id: string) => `${type}:${id}`;

export function createPrefetcher(o: PrefetchOptions) {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const now = o.now ?? Date.now;
  const cap = o.capBytes ?? DEFAULT_CACHE_CAP_BYTES;
  const limit = Math.min(1000, Math.max(1, o.limit ?? 500));
  const types = o.permissions.includes('sync.use') ? PREFETCH_ENTITIES.filter((e) => o.permissions.includes(e.permission)).map((e) => e.entity_type as string) : [];
  const { store } = o;
  const readMeta = async (): Promise<Meta> => ({ cursors: {}, done: {}, fetchedAt: null, index: {}, ...((await store.get<Meta>('meta', META)) ?? {}) });

  /** documents to put / ids to delete plus the new meta, in one readwrite transaction (crypto first) */
  async function commit(puts: Array<[string, unknown]>, dels: string[], meta: Meta) {
    const sealed: SealedRecord[] = [];
    for (const [k, v] of puts) sealed.push(await store.encryptRecord('refdata', k, v));
    const m = await store.encryptRecord('meta', META, meta);
    await store.transact(['refdata', 'meta'], 'readwrite', (s) => {
      for (const r of sealed) s('refdata').put(r);
      for (const k of dels) s('refdata').delete(k);
      s('meta').put(m);
    });
  }

  /** least recently used patients leave until the kept size is at or under the cap */
  function evict(meta: Meta): string[] {
    let total = Object.values(meta.index).reduce((a, [b]) => a + b, 0);
    const out: string[] = [];
    const lru = Object.entries(meta.index).filter(([k]) => k.startsWith(`${EVICTABLE}:`)).sort((a, b) => a[1][1] - b[1][1]);
    for (const [k, [b]] of lru) {
      if (total <= cap) break;
      total -= b; out.push(k); delete meta.index[k];
    }
    return out;
  }

  async function round(entities: Array<{ entity_type: string; cursor?: string }>): Promise<Change[] | null> {
    const res = await timedFetch(f, `${o.baseUrl ?? ''}/v1/core/sync/pull`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ device_id: o.deviceId, entities, limit }),
    }, o.timeoutMs ?? 30_000);
    if (!res?.ok) return null;
    const body = (await res.json().catch(() => null)) as { changes?: Change[] } | null;
    return Array.isArray(body?.changes) ? body.changes : null;
  }

  const prefetcher = {
    async run(): Promise<PrefetchResult> {
      const no = (skipped: NonNullable<PrefetchResult['skipped']>): PrefetchResult => ({ ok: false, skipped, requested: [], evicted: 0 });
      if (types.length === 0) return no('no_permission');
      if (o.isOnline && !o.isOnline()) return no('offline');
      if (o.isIdle && !o.isIdle()) return no('busy');
      if (!store.isUnlocked()) return no('locked');
      let evicted = 0;
      try {
        const meta = await readMeta();
        let todo = types.slice();
        for (let n = 0; todo.length > 0 && n < MAX_ROUNDS; n++) {
          const changes = await round(todo.map((t) => (meta.cursors[t] ? { entity_type: t, cursor: meta.cursors[t] } : { entity_type: t })));
          if (!changes) return { ok: false, skipped: 'error', requested: types, evicted };
          const puts: Array<[string, unknown]> = []; const dels: string[] = []; const more: string[] = [];
          for (const c of changes) {
            if (!c || !todo.includes(c.entity_type)) continue; // only what was asked for
            for (const u of c.upserts ?? []) {
              const k = rk(c.entity_type, u.id);
              puts.push([k, u.document]);
              meta.index[k] = [enc.encode(JSON.stringify(u.document ?? null)).length, now()];
            }
            for (const d of c.tombstones ?? []) { const k = rk(c.entity_type, d.id); dels.push(k); delete meta.index[k]; }
            if (c.next_cursor) meta.cursors[c.entity_type] = c.next_cursor;
            if (c.has_more) more.push(c.entity_type); else meta.done[c.entity_type] = true;
          }
          const gone = evict(meta);
          evicted += gone.length;
          const keep = puts.filter(([k]) => !gone.includes(k));
          if (types.every((t) => meta.done[t]) && more.length === 0) meta.fetchedAt = now();
          await commit(keep, [...dels, ...gone], meta);
          todo = more;
        }
        return { ok: todo.length === 0, ...(todo.length ? { skipped: 'error' as const } : {}), requested: types, evicted };
      } catch {
        return { ok: false, skipped: 'error', requested: types, evicted };
      }
    },
    /** the document as the read API returns it; reading a patient counts as a use (LRU) */
    async get<T = Doc>(entityType: string, id: string): Promise<T | undefined> {
      const k = rk(entityType, id);
      const d = await store.get<T>('refdata', k);
      if (d !== undefined && entityType === EVICTABLE) {
        const meta = await readMeta();
        if (meta.index[k]) { meta.index[k] = [meta.index[k][0], now()]; await store.put('meta', META, meta); }
      }
      return d;
    },
    async list<T = Doc>(entityType: string): Promise<T[]> {
      const keys = (await store.keys('refdata')).filter((k) => k.startsWith(`${entityType}:`));
      const docs = await Promise.all(keys.map((k) => store.get<T>('refdata', k)));
      return docs.filter((d) => d !== undefined) as T[];
    },
    async usage() { const m = await readMeta(); return { bytes: Object.values(m.index).reduce((a, [b]) => a + b, 0), capBytes: cap }; },
    async status() {
      const m = await readMeta();
      return { ready: types.length > 0 && types.every((t) => m.done[t]), fetchedAt: m.fetchedAt };
    },
  };
  return prefetcher;
}

export type Prefetcher = ReturnType<typeof createPrefetcher>;
