// C5 T-28 — in-process CatalogPort cache (06 row T-28; 02-TRD §6.2 `CatalogPort` row, §7.2 row catalog.changed.v1; 03-IC §3.19 "Ordering"; 03-IC §4.2 "Caches invalidated by catalog.changed.v1"). No database.
// SEAM (the writer implements services/api/src/modules/lab/service/cache.ts exactly with these exports):
//   createCatalogCache({ maxEntries }): CatalogCache          LRU, one instance per process; entries keyed (tenantId, method, canonical-JSON(input)); each entry remembers the catalog revision it was read at.
//   CatalogCache.set(tenantId, method, input, value, revision): void   ignored when revision <= the tenant's invalidation floor (a read that started before the event must not re-fill the cache).
//   CatalogCache.get(tenantId, method, input): { value } | undefined   (a hit refreshes LRU recency; the box distinguishes a cached null/undefined from a miss)
//   CatalogCache.invalidate(tenantId, { revision, entityType }): void  drops that tenant's entries with revision <= `revision`; entityType not in the known 03-IC §3.19 list, or 'catalog_import' (§3.19 last para.),
//                                                                      drops ALL of the tenant's entries; raises the tenant floor to `revision`. Never touches another tenant.
//   CatalogCache.size(): number
//   getCatalogCache(): CatalogCache                           process singleton, sized by loadLabConfig().catalogCacheMaxEntries (the worker consumer invalidates this instance).
//   withCatalogCache(port, cache = getCatalogCache()): port   wraps getTest, resolveOrderables, referenceRangeFor, criticalLimitsFor, mapInstrumentCode, resolveCommentCodes, getReferrer — signature (ctx, input),
//                                                             tenant = ctx.tenantId only; revision = result.catalogRevision when it is an integer, else 0 (dropped by any later event); every other method passes through uncached;
//                                                             a rejection is never cached; a ctx without a tenant bypasses the cache.
import { describe, expect, it, vi } from 'vitest';
import { createCatalogCache, getCatalogCache, withCatalogCache } from '../cache.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const mk = (maxEntries = 100) => createCatalogCache({ maxEntries });

describe('T-28 CatalogCache: keys and isolation', () => {
  it('hits only on the same (tenant, method, input); a miss is undefined', () => {
    const c = mk();
    c.set(A, 'getTest', { testId: 't1' }, { code: 'CBC' }, 10);
    expect(c.get(A, 'getTest', { testId: 't1' })).toEqual({ value: { code: 'CBC' } });
    expect(c.get(A, 'getTest', { testId: 't2' })).toBeUndefined();
    expect(c.get(A, 'referenceRangeFor', { testId: 't1' })).toBeUndefined();
    expect(c.get(B, 'getTest', { testId: 't1' })).toBeUndefined();   // never shared across tenants
  });
  it('input key order does not matter', () => {
    const c = mk();
    c.set(A, 'm', { a: 1, b: { x: 1, y: 2 } }, 'v', 1);
    expect(c.get(A, 'm', { b: { y: 2, x: 1 }, a: 1 })).toEqual({ value: 'v' });
  });
  it('a cached null (not found upstream) is a hit, distinguishable from a miss', () => {
    const c = mk();
    c.set(A, 'referenceRangeFor', { q: 1 }, null, 5);
    expect(c.get(A, 'referenceRangeFor', { q: 1 })).toEqual({ value: null });
  });
});

describe('T-28 CatalogCache: invalidation by revision (03-IC §3.19)', () => {
  const seed = () => {
    const c = mk();
    c.set(A, 'm', { n: 1 }, 'old', 417);
    c.set(A, 'm', { n: 2 }, 'at', 418);
    c.set(A, 'm', { n: 3 }, 'new', 419);
    c.set(B, 'm', { n: 1 }, 'b-old', 1);
    return c;
  };
  it('a known entity_type drops that tenant\'s entries with revision <= event revision and keeps newer ones', () => {
    const c = seed();
    c.invalidate(A, { revision: 418, entityType: 'test' });
    expect(c.get(A, 'm', { n: 1 })).toBeUndefined();
    expect(c.get(A, 'm', { n: 2 })).toBeUndefined();
    expect(c.get(A, 'm', { n: 3 })).toEqual({ value: 'new' });
  });
  it('never touches another tenant', () => {
    const c = seed();
    c.invalidate(A, { revision: 9999, entityType: 'test' });
    expect(c.get(B, 'm', { n: 1 })).toEqual({ value: 'b-old' });
  });
  it.each(['a_value_added_in_a_later_version', 'catalog_import'])('entity_type %s drops ALL of the tenant\'s entries, even newer than the event revision', (entityType) => {
    const c = seed();
    c.invalidate(A, { revision: 418, entityType });
    expect(c.get(A, 'm', { n: 3 })).toBeUndefined();
    expect(c.get(B, 'm', { n: 1 })).toEqual({ value: 'b-old' });
  });
  it('a stale (lower-revision) event after a newer fill drops nothing newer, and replay is idempotent', () => {
    const c = mk();
    c.set(A, 'm', { n: 1 }, 'v', 500);
    c.invalidate(A, { revision: 418, entityType: 'test' });
    c.invalidate(A, { revision: 418, entityType: 'test' });
    expect(c.get(A, 'm', { n: 1 })).toEqual({ value: 'v' });
  });
  it('a fill at revision <= the invalidation floor is ignored (read raced the event); a newer fill is kept', () => {
    const c = mk();
    c.invalidate(A, { revision: 418, entityType: 'test' });
    c.set(A, 'm', { n: 1 }, 'stale', 417);
    c.set(A, 'm', { n: 2 }, 'stale', 418);
    c.set(A, 'm', { n: 3 }, 'fresh', 419);
    expect(c.get(A, 'm', { n: 1 })).toBeUndefined();
    expect(c.get(A, 'm', { n: 2 })).toBeUndefined();
    expect(c.get(A, 'm', { n: 3 })).toEqual({ value: 'fresh' });
    c.set(B, 'm', { n: 1 }, 'b', 1);   // the floor is per tenant
    expect(c.get(B, 'm', { n: 1 })).toEqual({ value: 'b' });
  });
});

describe('T-28 CatalogCache: bounded LRU (LIMS_LAB_CATALOG_CACHE_MAX_ENTRIES)', () => {
  it('never holds more than maxEntries and evicts the least recently used', () => {
    const c = mk(2);
    c.set(A, 'm', { n: 1 }, 'a', 1);
    c.set(A, 'm', { n: 2 }, 'b', 1);
    c.get(A, 'm', { n: 1 });                 // refresh a
    c.set(A, 'm', { n: 3 }, 'c', 1);         // evicts b
    expect(c.size()).toBe(2);
    expect(c.get(A, 'm', { n: 2 })).toBeUndefined();
    expect(c.get(A, 'm', { n: 1 })).toEqual({ value: 'a' });
    expect(c.get(A, 'm', { n: 3 })).toEqual({ value: 'c' });
  });
  it('getCatalogCache() is a process singleton', () => {
    expect(getCatalogCache()).toBe(getCatalogCache());
  });
});

type Fn = (ctx: unknown, i: unknown) => Promise<unknown>;
const ctxOf = (tenantId: string | undefined) => ({ tenantId });

describe('T-28 withCatalogCache: the CatalogPort wrapper', () => {
  it.each(['getTest', 'resolveOrderables', 'referenceRangeFor', 'criticalLimitsFor', 'mapInstrumentCode', 'resolveCommentCodes', 'getReferrer'])('%s: the second identical call is served from cache; another tenant or input calls the port', async (m) => {
    const fn = vi.fn(async (_c: unknown, i: unknown) => ({ echo: i, catalogRevision: 10 }));
    const port = withCatalogCache({ [m]: fn } as Record<string, Fn>, mk()) as Record<string, Fn>;
    const first = await port[m]!(ctxOf(A), { k: 1 });
    expect(await port[m]!(ctxOf(A), { k: 1 })).toEqual(first);
    expect(fn).toHaveBeenCalledTimes(1);
    await port[m]!(ctxOf(B), { k: 1 });
    await port[m]!(ctxOf(A), { k: 2 });
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it('after catalog.changed (revision >= the entry) the next call goes back to the port', async () => {
    const cache = mk();
    const fn = vi.fn(async () => ({ catalogRevision: 418 }));
    const port = withCatalogCache({ getTest: fn } as Record<string, Fn>, cache) as Record<string, Fn>;
    await port.getTest!(ctxOf(A), { id: 1 });
    cache.invalidate(A, { revision: 418, entityType: 'test' });
    await port.getTest!(ctxOf(A), { id: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('a result without catalogRevision is revision 0: any later event drops it', async () => {
    const cache = mk();
    const fn = vi.fn(async () => ({ displayName: 'Dr X' }));
    const port = withCatalogCache({ getReferrer: fn } as Record<string, Fn>, cache) as Record<string, Fn>;
    await port.getReferrer!(ctxOf(A), { referrerId: 'r1' });
    cache.invalidate(A, { revision: 1, entityType: 'doctor' });
    await port.getReferrer!(ctxOf(A), { referrerId: 'r1' });
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('a read that resolves after the event with an older revision is not cached', async () => {
    const cache = mk();
    let release!: (v: unknown) => void;
    const fn = vi.fn(() => new Promise((r) => { release = r; }));
    const port = withCatalogCache({ getTest: fn } as Record<string, Fn>, cache) as Record<string, Fn>;
    const inflight = port.getTest!(ctxOf(A), { id: 1 });
    cache.invalidate(A, { revision: 418, entityType: 'test' });   // event lands while the port call is in flight
    release({ catalogRevision: 417 });
    await inflight;
    expect(cache.get(A, 'getTest', { id: 1 })).toBeUndefined();
  });
  it('a rejection propagates and is not cached', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('catalog down')).mockResolvedValueOnce({ catalogRevision: 1 });
    const port = withCatalogCache({ getTest: fn } as Record<string, Fn>, mk()) as Record<string, Fn>;
    await expect(port.getTest!(ctxOf(A), { id: 1 })).rejects.toThrow('catalog down');
    await expect(port.getTest!(ctxOf(A), { id: 1 })).resolves.toEqual({ catalogRevision: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('a ctx without a tenant bypasses the cache (never a shared bucket)', async () => {
    const fn = vi.fn(async () => ({ catalogRevision: 1 }));
    const port = withCatalogCache({ getTest: fn } as Record<string, Fn>, mk()) as Record<string, Fn>;
    await port.getTest!(ctxOf(undefined), { id: 1 });
    await port.getTest!(ctxOf(undefined), { id: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('methods outside the cached set pass through uncached', async () => {
    const fn = vi.fn(async () => 'x');
    const port = withCatalogCache({ somethingElse: fn } as Record<string, Fn>, mk()) as Record<string, Fn>;
    await port.somethingElse!(ctxOf(A), {});
    await port.somethingElse!(ctxOf(A), {});
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
