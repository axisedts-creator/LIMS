// C5 T-28 — catalog.changed.v1 consumer: cache invalidation by revision + reapply enqueue (06 row T-28; 02-TRD §7.2 row catalog.changed.v1, §8; 03-IC §3.19; 07-SECURITY P-11, REQ-SEC-024). No database.
// SEAM: the consumer (consumers/catalog.changed.v1.ts, `handle`) calls getCatalogCache().invalidate(ctx.tenantId, { revision: payload.catalog_revision, entityType: payload.entity_type })
// on the process singleton of services/api/src/modules/lab/service/cache.ts (its contract is in that module's __tests__/cache.test.ts), after the tenant guard and before/independent of the reapply enqueue.
// The T-23 enqueue behaviour stays covered by tasks.reapply.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isLimsError } from '../../../../../api/src/core/errors.js';
import { getCatalogCache } from '../../../../../api/src/modules/lab/service/cache.js';
import { handle } from '../consumers/catalog.changed.v1.js';

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const u = (n: number) => `0190c609-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const envelope = (tenant: string, over: Record<string, unknown> = {}) => ({
  event_id: u(9), event_type: 'catalog.changed.v1', tenant_id: tenant, producer: 'catalog', aggregate: { type: 'catalog', id: u(10), seq: 418 },
  payload: { catalog_revision: 418, entity_type: 'test', entity_id: u(11), change_kind: 'updated', effective_from: '2026-06-15T05:00:00.000Z', ...over },
});

function jobCtx(tenant: string | undefined, queryThrows?: Error) {
  const queries: unknown[][] = [];
  const ctx = {
    tenantId: tenant, actor: { type: 'system', id: u(5) }, requestId: u(8), now: () => '2026-06-15T05:00:30.000Z',
    tx: { query: async (_sql: string, p: unknown[]) => { if (queryThrows) throw queryThrows; queries.push(p); return { rows: [] }; } },
    log: { info() {}, warn() {}, error() {}, child() { return this; } },
  };
  return { ctx: ctx as never, queries };
}
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };

const cache = getCatalogCache();
const seed = () => {
  cache.invalidate(A, { revision: 0, entityType: 'unseed' });   // unknown type: empties tenant A and B scratch state of earlier tests
  cache.invalidate(B, { revision: 0, entityType: 'unseed' });
  cache.set(A, 'getTest', { n: 1 }, 'old', 417);
  cache.set(A, 'getTest', { n: 2 }, 'at', 418);
  cache.set(A, 'getTest', { n: 3 }, 'new', 419);
  cache.set(B, 'getTest', { n: 1 }, 'b', 1);
};
beforeEach(seed);

describe('T-28 catalog.changed.v1: invalidate caches <= revision', () => {
  it.each(['test', 'analyte', 'reference_range', 'critical_limit', 'comment_code', 'doctor', 'instrument_code_map', 'panel'])('entity_type %s drops tenant-A entries <= 418, keeps 419 and tenant B', async (entity_type) => {
    const { ctx } = jobCtx(A);
    await handle(envelope(A, { entity_type }) as never, ctx);
    expect(cache.get(A, 'getTest', { n: 1 })).toBeUndefined();
    expect(cache.get(A, 'getTest', { n: 2 })).toBeUndefined();
    expect(cache.get(A, 'getTest', { n: 3 })).toEqual({ value: 'new' });
    expect(cache.get(B, 'getTest', { n: 1 })).toEqual({ value: 'b' });
  });
  it.each(['a_value_added_in_a_later_version', 'catalog_import'])('entity_type %s (unknown / import, x-extensible) invalidates the whole tenant cache, never tenant B', async (entity_type) => {
    const { ctx, queries } = jobCtx(A);
    await handle(envelope(A, { entity_type }) as never, ctx);
    expect(cache.get(A, 'getTest', { n: 3 })).toBeUndefined();
    expect(cache.get(B, 'getTest', { n: 1 })).toEqual({ value: 'b' });
    expect(queries).toHaveLength(0);   // and it enqueues nothing
  });
  it('duplicate delivery and a stale (older revision) event are harmless', async () => {
    const { ctx } = jobCtx(A);
    await handle(envelope(A) as never, ctx);
    await handle(envelope(A) as never, ctx);
    cache.set(A, 'getTest', { n: 9 }, 'fresh', 500);
    await handle(envelope(A, { catalog_revision: 100 }) as never, ctx);
    expect(cache.get(A, 'getTest', { n: 9 })).toEqual({ value: 'fresh' });
  });
});

describe('T-28 catalog.changed.v1: reapply enqueue stays (AC-14.5) together with invalidation', () => {
  it('instrument_code_map invalidates AND enqueues lab.reapply_unmapped_exceptions with job_key <tenant>:<revision>', async () => {
    const { ctx, queries } = jobCtx(A);
    await handle(envelope(A, { entity_type: 'instrument_code_map' }) as never, ctx);
    expect(cache.get(A, 'getTest', { n: 2 })).toBeUndefined();
    expect(queries).toHaveLength(1);
    expect(queries[0]![0]).toBe('lab.reapply_unmapped_exceptions');
    expect(JSON.parse(queries[0]![1] as string)).toEqual({ tenant_id: A, revision: 418 });
    expect(queries[0]![2]).toBe(`${A}:418`);
  });
  it('a failing enqueue still rejects (retry / dead letter), never a silent ack', async () => {
    const { ctx } = jobCtx(A, new Error('enqueue failed'));
    expect(await failure(Promise.resolve(handle(envelope(A, { entity_type: 'instrument_code_map' }) as never, ctx)))).toBeInstanceOf(Error);
  });
});

describe('T-28 tenant guard (REQ-SEC-024, 07-SECURITY P-11): nothing is invalidated for a foreign envelope', () => {
  it('an envelope of tenant B on a tenant-A job is refused (common.internal); neither cache is touched', async () => {
    const { ctx, queries } = jobCtx(A);
    const err = await failure(Promise.resolve(handle(envelope(B, { entity_type: 'catalog_import' }) as never, ctx)));
    expect(isLimsError(err, 'common.internal')).toBe(true);
    expect(cache.get(A, 'getTest', { n: 3 })).toEqual({ value: 'new' });
    expect(cache.get(B, 'getTest', { n: 1 })).toEqual({ value: 'b' });
    expect(queries).toHaveLength(0);
  });
  it('a job without a tenant is refused the same way', async () => {
    const { ctx } = jobCtx(undefined);
    const err = await failure(Promise.resolve(handle(envelope(A, { entity_type: 'catalog_import' }) as never, ctx)));
    expect(isLimsError(err, 'common.internal')).toBe(true);
    expect(cache.get(A, 'getTest', { n: 3 })).toEqual({ value: 'new' });
  });
  it('a non-integer catalog_revision is refused (fails closed) for every entity_type and invalidates nothing', async () => {
    const { ctx } = jobCtx(A);
    const spy = vi.spyOn(cache, 'invalidate');
    const err = await failure(Promise.resolve(handle(envelope(A, { catalog_revision: 'x' }) as never, ctx)));
    expect(isLimsError(err, 'common.internal')).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(cache.get(A, 'getTest', { n: 1 })).toEqual({ value: 'old' });
    spy.mockRestore();
  });
});
