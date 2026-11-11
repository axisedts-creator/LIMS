// C5 T-28 — in-process CatalogPort cache (06 row T-28; 02-TRD §6.2 `CatalogPort` row, §7.2 row catalog.changed.v1; 03-IC §3.19 "Ordering"; 03-IC §4.2 "Caches invalidated by catalog.changed.v1"). No database.
// SEAM (the writer implements services/api/src/modules/lab/service/cache.ts exactly with these exports):
//   createCatalogCache({ maxEntries }): CatalogCache          LRU, one instance per process; entries keyed (tenantId, method, canonical-JSON(input)); each entry remembers the catalog revision it was read at.
//   CatalogCache.set(tenantId, method, input, value, revision): void   ignored when revision <= the tenant's invalidation floor (a read that started before the event must not re-fill the cache).
//   CatalogCache.get(tenantId, method, input): { value } | undefined   (a hit refreshes LRU recency; the box distinguishes a cached null/undefined from a miss)
//   CatalogCache.invalidate(tenantId, { revision, entityType }): void  drops that tenant's entries with revision <= `revision`; entityType not in the known 03-IC §3.19 list, or 'catalog_import' (§3.19 last para.),
//                                                                      drops ALL of the tenant's entries; raises the tenant floor to `revision`. Never touches another tenant.
//   CatalogCache.size(): number
//   getCatalogCache(): CatalogCache                           process singleton, sized by loadLabConfig().catalogCacheMaxEntries (the worker consumer invalidates this instance).
//   withCatalogCache(port, cache = getCatalogCache(), readRevision = (ctx) => currentRevision(ctx.tx, ctx.tenantId)): port
//                                                             wraps getTest, resolveOrderables, referenceRangeFor, criticalLimitsFor, mapInstrumentCode, resolveCommentCodes, getReferrer — signature (ctx, input),
//                                                             tenant = ctx.tenantId only. REVIEW T-28 items 1+2: the API process never receives the worker's invalidate, so the wrapper itself reads the tenant's
//                                                             current catalog revision (02-TRD §6.2: key = tenant, method, input, catalogRevision) BEFORE each port call; a hit needs the same revision, a fill is stored at
//                                                             that revision (never result.catalogRevision, which only resolveOrderables returns). A non-integer or rejected revision read bypasses the cache (fail closed).
//                                                             Every other method passes through uncached; a port rejection is never cached; a ctx without a tenant bypasses the cache.
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
/** Test double for the per-request catalog-revision read; `.at` moves the tenant's revision without any invalidate() in the process. */
const revs = (n: number) => { const f = Object.assign(async () => f.at, { at: n }); return f; };

describe('T-28 withCatalogCache: the CatalogPort wrapper', () => {
  it.each(['getTest', 'resolveOrderables', 'referenceRangeFor', 'criticalLimitsFor', 'mapInstrumentCode', 'resolveCommentCodes', 'getReferrer'])('%s: the second identical call is served from cache; another tenant or input calls the port', async (m) => {
    const fn = vi.fn(async (_c: unknown, i: unknown) => ({ echo: i, catalogRevision: 10 }));
    const port = withCatalogCache({ [m]: fn } as Record<string, Fn>, mk(), revs(10)) as Record<string, Fn>;
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
    const port = withCatalogCache({ getTest: fn } as Record<string, Fn>, cache, revs(418)) as Record<string, Fn>;
    await port.getTest!(ctxOf(A), { id: 1 });
    cache.invalidate(A, { revision: 418, entityType: 'test' });
    await port.getTest!(ctxOf(A), { id: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('REVIEW item 1: a fill at revision N is a miss once the tenant revision is N+1, with NO invalidate() in this process', async () => {
    const cache = mk();
    const rev = revs(417);
    const fn = vi.fn(async () => ({ catalogRevision: 417 }));
    const port = withCatalogCache({ referenceRangeFor: fn } as Record<string, Fn>, cache, rev) as Record<string, Fn>;
    await port.referenceRangeFor!(ctxOf(A), { q: 1 });
    await port.referenceRangeFor!(ctxOf(A), { q: 1 });
    expect(fn).toHaveBeenCalledTimes(1);          // same revision: hit
    rev.at = 418;                                  // catalog changed in another process; this one never hears about it
    await port.referenceRangeFor!(ctxOf(A), { q: 1 });
    expect(fn).toHaveBeenCalledTimes(2);          // miss: the key includes the revision
    await port.referenceRangeFor!(ctxOf(A), { q: 1 });
    expect(fn).toHaveBeenCalledTimes(2);          // and the new fill is cached at 418
  });
  it('REVIEW item 1: the revision is read per tenant (ctx), so a bump for A does not miss B', async () => {
    const byTenant: Record<string, number> = { [A]: 5, [B]: 5 };
    const fn = vi.fn(async () => ({ v: 1 }));
    const readRev = async (ctx: unknown) => byTenant[(ctx as { tenantId: string }).tenantId]!;
    const port = withCatalogCache({ criticalLimitsFor: fn } as Record<string, Fn>, mk(), readRev) as Record<string, Fn>;
    await port.criticalLimitsFor!(ctxOf(A), { q: 1 });
    await port.criticalLimitsFor!(ctxOf(B), { q: 1 });
    byTenant[A] = 6;
    await port.criticalLimitsFor!(ctxOf(A), { q: 1 });   // miss
    await port.criticalLimitsFor!(ctxOf(B), { q: 1 });   // hit
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it.each(['getTest', 'referenceRangeFor', 'criticalLimitsFor', 'mapInstrumentCode', 'resolveCommentCodes', 'getReferrer'])('REVIEW item 2: %s (result has NO catalogRevision) is cached at the read revision, also after an unrelated event raised the floor', async (m) => {
    const cache = mk();
    cache.invalidate(A, { revision: 5, entityType: 'doctor' });   // the process has seen an invalidation: floor >= 0
    const fn = vi.fn(async () => ({ displayName: 'Dr X' }));
    const port = withCatalogCache({ [m]: fn } as Record<string, Fn>, cache, revs(10)) as Record<string, Fn>;
    await port[m]!(ctxOf(A), { k: 1 });
    await port[m]!(ctxOf(A), { k: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('REVIEW item 2: with no invalidate at all, a no-catalogRevision result stops being served when the revision moves', async () => {
    const rev = revs(1);
    const fn = vi.fn(async () => ({ displayName: 'Dr X' }));
    const port = withCatalogCache({ getReferrer: fn } as Record<string, Fn>, mk(), rev) as Record<string, Fn>;
    await port.getReferrer!(ctxOf(A), { referrerId: 'r1' });
    rev.at = 2;
    await port.getReferrer!(ctxOf(A), { referrerId: 'r1' });
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('the worker eviction still works: after an event at revision R the entry read at R is gone and the next call goes to the port', async () => {
    const cache = mk();
    const fn = vi.fn(async () => ({ displayName: 'Dr X' }));
    const port = withCatalogCache({ getReferrer: fn } as Record<string, Fn>, cache, revs(7)) as Record<string, Fn>;
    await port.getReferrer!(ctxOf(A), { referrerId: 'r1' });
    cache.invalidate(A, { revision: 7, entityType: 'doctor' });
    await port.getReferrer!(ctxOf(A), { referrerId: 'r1' });
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['non-integer', async () => 1.5],
    ['rejected', async () => { throw new Error('revision read failed'); }],
  ] as const)('a %s revision read bypasses the cache (fail closed): nothing is stored', async (_n, readRev) => {
    const cache = mk();
    const fn = vi.fn(async () => ({ catalogRevision: 1 }));
    const port = withCatalogCache({ getTest: fn } as Record<string, Fn>, cache, readRev as () => Promise<number>) as Record<string, Fn>;
    await port.getTest!(ctxOf(A), { id: 1 }).catch(() => undefined);
    await port.getTest!(ctxOf(A), { id: 1 }).catch(() => undefined);
    expect(cache.size()).toBe(0);
  });
  it('a read that resolves after the event with an older revision is not cached', async () => {
    const cache = mk();
    let release!: (v: unknown) => void;
    const fn = vi.fn(() => new Promise((r) => { release = r; }));
    const port = withCatalogCache({ getTest: fn } as Record<string, Fn>, cache, revs(417)) as Record<string, Fn>;
    const inflight = port.getTest!(ctxOf(A), { id: 1 });
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());   // revision read (417) precedes the port call (ruling, TRD:363)
    cache.invalidate(A, { revision: 418, entityType: 'test' });   // event lands while the port call is in flight
    release({ catalogRevision: 417 });
    await inflight;
    expect(cache.get(A, 'getTest', { id: 1 })).toBeUndefined();
  });
  it('a rejection propagates and is not cached', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('catalog down')).mockResolvedValueOnce({ catalogRevision: 1 });
    const port = withCatalogCache({ getTest: fn } as Record<string, Fn>, mk(), revs(1)) as Record<string, Fn>;
    await expect(port.getTest!(ctxOf(A), { id: 1 })).rejects.toThrow('catalog down');
    await expect(port.getTest!(ctxOf(A), { id: 1 })).resolves.toEqual({ catalogRevision: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('a ctx without a tenant bypasses the cache (never a shared bucket)', async () => {
    const fn = vi.fn(async () => ({ catalogRevision: 1 }));
    const port = withCatalogCache({ getTest: fn } as Record<string, Fn>, mk(), revs(1)) as Record<string, Fn>;
    await port.getTest!(ctxOf(undefined), { id: 1 });
    await port.getTest!(ctxOf(undefined), { id: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('methods outside the cached set pass through uncached', async () => {
    const fn = vi.fn(async () => 'x');
    const port = withCatalogCache({ somethingElse: fn } as Record<string, Fn>, mk(), revs(1)) as Record<string, Fn>;
    await port.somethingElse!(ctxOf(A), {});
    await port.somethingElse!(ctxOf(A), {});
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
