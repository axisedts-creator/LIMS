// Per-process catalog read cache (02-TRD §6.3): LRU keyed (tenant_id, catalog_revision, kind, id), TTL counted from set time, bounded size.
// The revision is part of the key, so a catalog write (revision bump) makes every older entry unreachable: no invalidation signal is needed.
// `undefined` is the only miss marker; falsy values are cached. A rejected loader caches nothing.
export interface CatalogCache {
  get<T>(tenantId: string, revision: number, kind: string, id: string): T | undefined;
  set<T>(tenantId: string, revision: number, kind: string, id: string, value: T): void;
  getOrLoad<T>(tenantId: string, revision: number, kind: string, id: string, load: () => Promise<T>): Promise<T>;
  readonly size: number;
  clear(): void;
}

export interface CatalogCacheOptions { maxEntries: number; ttlSeconds: number; now?: () => number /* epoch ms */ }

// JSON array: no separator in any component can make two different keys collide.
const keyOf = (tenantId: string, revision: number, kind: string, id: string): string => JSON.stringify([tenantId, revision, kind, id]);

export function createCatalogCache(opts: CatalogCacheOptions): CatalogCache {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlSeconds * 1000;
  const max = Math.max(1, opts.maxEntries);
  const map = new Map<string, { value: unknown; expiresAt: number }>();   // Map iteration order = recency (oldest first)

  function get<T>(tenantId: string, revision: number, kind: string, id: string): T | undefined {
    const k = keyOf(tenantId, revision, kind, id);
    const e = map.get(k);
    if (!e) return undefined;
    if (now() >= e.expiresAt) { map.delete(k); return undefined; }
    map.delete(k); map.set(k, e);                                  // refresh recency; expiresAt is NOT extended
    return e.value as T;
  }
  function set<T>(tenantId: string, revision: number, kind: string, id: string, value: T): void {
    const k = keyOf(tenantId, revision, kind, id);
    map.delete(k);
    map.set(k, { value, expiresAt: now() + ttlMs });
    while (map.size > max) map.delete(map.keys().next().value as string);
  }
  async function getOrLoad<T>(tenantId: string, revision: number, kind: string, id: string, load: () => Promise<T>): Promise<T> {
    const hit = get<T>(tenantId, revision, kind, id);
    if (hit !== undefined) return hit;
    const value = await load();
    set(tenantId, revision, kind, id, value);
    return value;
  }
  return { get, set, getOrLoad, get size() { return map.size; }, clear: () => map.clear() };
}
