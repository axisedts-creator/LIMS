// T-28a (C3) — unit tests of catalog/cache/catalogCache.ts (02-TRD §6.3): per-process LRU keyed (tenant_id, catalog_revision, kind, id), TTL, bounded size.
// Interface: createCatalogCache({ maxEntries, ttlSeconds, now? }) -> { get, set, getOrLoad, size, clear } (SEAM header in __tests__/helpers/t28a.ts).
import { describe, expect, it } from 'vitest';
import { createCatalogCache } from '../catalogCache.js';

const A = '0190a000-0000-7000-8000-00000000aaaa', B = '0190a000-0000-7000-8000-00000000bbbb';
const make = (o: { maxEntries?: number; ttlSeconds?: number } = {}) => {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  return { cache: createCatalogCache({ maxEntries: o.maxEntries ?? 100, ttlSeconds: o.ttlSeconds ?? 600, now: clock.now }), clock };
};

describe('key = (tenant, revision, kind, id)', () => {
  it('get returns what set stored; a miss is undefined', () => {
    const { cache } = make();
    expect(cache.get(A, 1, 'test', 'x')).toBeUndefined();
    cache.set(A, 1, 'test', 'x', { v: 1 });
    expect(cache.get(A, 1, 'test', 'x')).toEqual({ v: 1 });
    expect(cache.size).toBe(1);
  });
  it('every key component isolates: tenant, revision, kind, id', () => {
    const { cache } = make();
    cache.set(A, 1, 'test', 'x', 'a1');
    expect(cache.get(B, 1, 'test', 'x')).toBeUndefined();
    expect(cache.get(A, 2, 'test', 'x')).toBeUndefined();
    expect(cache.get(A, 1, 'panel', 'x')).toBeUndefined();
    expect(cache.get(A, 1, 'test', 'y')).toBeUndefined();
    cache.set(B, 1, 'test', 'x', 'b1');
    expect([cache.get(A, 1, 'test', 'x'), cache.get(B, 1, 'test', 'x')]).toEqual(['a1', 'b1']);
  });
  it('components cannot collide through separators (kind "a:b"+id "c" vs kind "a"+id "b:c"; revision 1 + id "2" vs revision 12)', () => {
    const { cache } = make();
    cache.set(A, 1, 'a:b', 'c', 'one');
    cache.set(A, 1, 'a', 'b:c', 'two');
    cache.set(A, 1, 'k', '23', 'three');
    cache.set(A, 12, 'k', '3', 'four');
    expect([cache.get(A, 1, 'a:b', 'c'), cache.get(A, 1, 'a', 'b:c'), cache.get(A, 1, 'k', '23'), cache.get(A, 12, 'k', '3')]).toEqual(['one', 'two', 'three', 'four']);
    expect(cache.size).toBe(4);
  });
  it('set overwrites in place (size unchanged)', () => {
    const { cache } = make();
    cache.set(A, 1, 'k', 'x', 1);
    cache.set(A, 1, 'k', 'x', 2);
    expect([cache.get(A, 1, 'k', 'x'), cache.size]).toEqual([2, 1]);
  });
  it('clear drops everything', () => {
    const { cache } = make();
    cache.set(A, 1, 'k', 'x', 1);
    cache.clear();
    expect([cache.get(A, 1, 'k', 'x'), cache.size]).toEqual([undefined, 0]);
  });
});

describe('getOrLoad', () => {
  it('loads once, then serves from the cache', async () => {
    const { cache } = make();
    let n = 0;
    const load = async () => ({ n: ++n });
    expect(await cache.getOrLoad(A, 1, 'k', 'x', load)).toEqual({ n: 1 });
    expect(await cache.getOrLoad(A, 1, 'k', 'x', load)).toEqual({ n: 1 });
    expect(n).toBe(1);
  });
  it('falsy values are cached (0, "", [], null, false): a truthiness check would re-load them', async () => {
    const { cache } = make();
    let n = 0;
    for (const [i, v] of [0, '', [], null, false].entries()) {
      const load = async () => { n++; return v; };
      expect(await cache.getOrLoad(A, 1, 'k', `f${i}`, load)).toEqual(v);
      expect(await cache.getOrLoad(A, 1, 'k', `f${i}`, load)).toEqual(v);
    }
    expect(n).toBe(5);
  });
  it('a new revision, tenant, kind or id loads again', async () => {
    const { cache } = make();
    let n = 0;
    const load = async () => ++n;
    await cache.getOrLoad(A, 1, 'k', 'x', load);
    await cache.getOrLoad(A, 2, 'k', 'x', load);
    await cache.getOrLoad(B, 1, 'k', 'x', load);
    await cache.getOrLoad(A, 1, 'j', 'x', load);
    await cache.getOrLoad(A, 1, 'k', 'y', load);
    expect(n).toBe(5);
  });
  it('a rejected loader caches nothing and the rejection reaches the caller; the next call loads again', async () => {
    const { cache } = make();
    let n = 0;
    await expect(cache.getOrLoad(A, 1, 'k', 'x', async () => { n++; throw new Error('db down'); })).rejects.toThrow('db down');
    expect(cache.size).toBe(0);
    expect(await cache.getOrLoad(A, 1, 'k', 'x', async () => { n++; return 'ok'; })).toBe('ok');
    expect(n).toBe(2);
  });
  it('a loader that throws synchronously also rejects (never throws out of the call)', async () => {
    const { cache } = make();
    await expect(cache.getOrLoad(A, 1, 'k', 'x', (() => { throw new Error('sync'); }) as never)).rejects.toThrow('sync');
    expect(cache.size).toBe(0);
  });
});

describe('LRU bound (LIMS_CATALOG_CACHE_MAX_ENTRIES)', () => {
  it('evicts the least recently used entry when full; get refreshes recency', () => {
    const { cache } = make({ maxEntries: 2 });
    cache.set(A, 1, 'k', 'a', 1);
    cache.set(A, 1, 'k', 'b', 2);
    expect(cache.get(A, 1, 'k', 'a')).toBe(1);                       // a is now most recent
    cache.set(A, 1, 'k', 'c', 3);                                    // evicts b
    expect([cache.get(A, 1, 'k', 'a'), cache.get(A, 1, 'k', 'b'), cache.get(A, 1, 'k', 'c')]).toEqual([1, undefined, 3]);
    expect(cache.size).toBe(2);
  });
  it('never exceeds maxEntries under a flood of distinct keys (many tenants / revisions)', () => {
    const { cache } = make({ maxEntries: 50 });
    for (let i = 0; i < 5000; i++) cache.set(i % 2 ? A : B, i, 'k', String(i), i);
    expect(cache.size).toBe(50);
    expect(cache.get(A, 4999, 'k', '4999')).toBe(4999);
    expect(cache.get(B, 0, 'k', '0')).toBeUndefined();
  });
  it('maxEntries 1 keeps only the newest entry', () => {
    const { cache } = make({ maxEntries: 1 });
    cache.set(A, 1, 'k', 'a', 1);
    cache.set(A, 1, 'k', 'b', 2);
    expect([cache.get(A, 1, 'k', 'a'), cache.get(A, 1, 'k', 'b'), cache.size]).toEqual([undefined, 2, 1]);
  });
});

describe('TTL (LIMS_CATALOG_CACHE_TTL_SECONDS)', () => {
  it('an entry is served until ttlSeconds have passed, then it is a miss and is dropped', () => {
    const { cache, clock } = make({ ttlSeconds: 600 });
    cache.set(A, 1, 'k', 'x', 'v');
    clock.advance(599_999);
    expect(cache.get(A, 1, 'k', 'x')).toBe('v');
    clock.advance(2);
    expect(cache.get(A, 1, 'k', 'x')).toBeUndefined();
    expect(cache.size).toBe(0);
  });
  it('getOrLoad reloads an expired entry', async () => {
    const { cache, clock } = make({ ttlSeconds: 1 });
    let n = 0;
    const load = async () => ++n;
    await cache.getOrLoad(A, 1, 'k', 'x', load);
    clock.advance(1_001);
    expect(await cache.getOrLoad(A, 1, 'k', 'x', load)).toBe(2);
  });
  it('get does not extend the TTL (the expiry is from the time of set)', () => {
    const { cache, clock } = make({ ttlSeconds: 10 });
    cache.set(A, 1, 'k', 'x', 'v');
    clock.advance(6_000);
    expect(cache.get(A, 1, 'k', 'x')).toBe('v');
    clock.advance(5_000);
    expect(cache.get(A, 1, 'k', 'x')).toBeUndefined();
  });
  it('set after expiry stores a fresh entry with a fresh TTL', () => {
    const { cache, clock } = make({ ttlSeconds: 10 });
    cache.set(A, 1, 'k', 'x', 'old');
    clock.advance(11_000);
    cache.set(A, 1, 'k', 'x', 'new');
    clock.advance(9_000);
    expect(cache.get(A, 1, 'k', 'x')).toBe('new');
  });
});
