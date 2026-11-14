// C5 T-28 — in-process CatalogPort cache (02-TRD §6.2 `CatalogPort` row, §7.2 row catalog.changed.v1; 03-IC §3.19 "Ordering" + x-extensible rule; 03-IC §4.2).
// Entries are keyed (tenantId, method, canonical-JSON(input)) and remember the catalog revision they were read at. catalog.changed.v1 invalidates a tenant's entries with
// revision <= the event revision; an unknown entity_type or `catalog_import` drops the whole tenant. Never shared across tenants (REQ-SEC-024).
import { loadLabConfig } from '../config.js';

export interface CatalogCache {
  /** Ignored when `revision` <= the tenant's invalidation floor (a read that started before the event must not re-fill the cache). */
  set(tenantId: string, method: string, input: unknown, value: unknown, revision: number): void;
  /** A hit refreshes LRU recency; the box distinguishes a cached null/undefined from a miss. With `revision`, an entry read at another revision is a miss. */
  get(tenantId: string, method: string, input: unknown, revision?: number): { value: unknown } | undefined;
  invalidate(tenantId: string, ev: { revision: number; entityType: string }): void;
  size(): number;
}

// 03-IC §3.19 entity_type enum minus `catalog_import` (the import event is a whole-tenant flush, §3.19 last paragraph).
const KNOWN_ENTITY_TYPES: ReadonlySet<string> = new Set([
  'department', 'specimen_type', 'container', 'test', 'analyte', 'panel', 'reference_range', 'critical_limit', 'comment_code', 'doctor', 'credit_party',
  'price_list', 'surcharge_rule', 'tat_target', 'instrument_code_map', 'global_reference', 'method', 'unit', 'value_set', 'tax_rule',
]);

function canonical(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

interface Entry { readonly tenantId: string; readonly value: unknown; readonly revision: number }

export function createCatalogCache(opts: { maxEntries: number }): CatalogCache {
  const max = Math.max(1, Math.floor(opts.maxEntries));
  const entries = new Map<string, Entry>();       // insertion order = recency order (oldest first)
  const floors = new Map<string, number>();       // tenant -> highest invalidated revision
  const keyOf = (t: string, m: string, i: unknown) => `${t}\u0000${m}\u0000${canonical(i)}`;
  return {
    set(tenantId, method, input, value, revision) {
      const floor = floors.get(tenantId);
      if (floor !== undefined && revision <= floor) return;
      const k = keyOf(tenantId, method, input);
      entries.delete(k);
      entries.set(k, { tenantId, value, revision });
      while (entries.size > max) entries.delete(entries.keys().next().value as string);
    },
    get(tenantId, method, input, revision) {
      const k = keyOf(tenantId, method, input);
      const e = entries.get(k);
      if (!e || (revision !== undefined && e.revision !== revision)) return undefined;
      entries.delete(k);
      entries.set(k, e);
      return { value: e.value };
    },
    invalidate(tenantId, { revision, entityType }) {
      const whole = !KNOWN_ENTITY_TYPES.has(entityType);
      for (const [k, e] of entries) if (e.tenantId === tenantId && (whole || e.revision <= revision)) entries.delete(k);
      // [CONV] a targeted event only ever raises the floor (a stale replay must not re-open the window); a whole-tenant flush leaves nothing cached, so its floor is
      // set to the event revision (T-28 tests seed revision-0 `unseed` flushes and then re-fill at lower revisions).
      floors.set(tenantId, whole ? revision : Math.max(floors.get(tenantId) ?? revision, revision));
    },
    size: () => entries.size,
  };
}

let singleton: CatalogCache | undefined;
/** Process singleton, sized by LIMS_LAB_CATALOG_CACHE_MAX_ENTRIES; the worker consumer of catalog.changed.v1 invalidates this instance. */
export function getCatalogCache(): CatalogCache {
  return (singleton ??= createCatalogCache({ maxEntries: loadLabConfig().catalogCacheMaxEntries }));
}

const CACHED_METHODS: ReadonlySet<string> = new Set([
  'getTest', 'resolveOrderables', 'referenceRangeFor', 'criticalLimitsFor', 'mapInstrumentCode', 'resolveCommentCodes', 'getReferrer',
]);

type AnyFn = (...args: unknown[]) => unknown;
interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> }
export type ReadRevision = (ctx: { tenantId: string; tx?: unknown }) => Promise<number>;

/** The tenant's current catalog revision (0 before the first catalog write), read in the caller's transaction (RLS-scoped).
 *  [CONV] R1 forbids importing catalog code and CatalogPort has no revision read, so this is one read-only SELECT on catalog.catalog_state;
 *  see .orchestra/cr/C5.T-28.md (asks for a CatalogPort revision read to replace it). */
export async function currentRevision(tx: unknown, tenantId: string): Promise<number> {
  const { rows } = await (tx as Tx).query('SELECT catalog_revision FROM catalog.catalog_state WHERE tenant_id = $1', [tenantId]);
  return rows[0] ? Number(rows[0].catalog_revision) : 0;
}

/** Wraps the read methods of a CatalogPort with the cache. Tenant = ctx.tenantId only; a ctx without a tenant bypasses; rejections are never cached.
 *  REVIEW T-28 items 1+2 (02-TRD §6.2 key = tenant, method, input, catalogRevision): the revision is read BEFORE each port call, a hit needs that same revision and
 *  a fill is stored at it, so the API process stays correct with no invalidate() from the worker. A non-integer or failed revision read bypasses the cache. */
export function withCatalogCache<P extends object>(
  port: P,
  cache: CatalogCache = getCatalogCache(),
  readRevision: ReadRevision = (ctx) => currentRevision(ctx.tx, ctx.tenantId),
): P {
  return new Proxy(port, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver) as unknown;
      if (typeof orig !== 'function') return orig;
      const bound = (...args: unknown[]) => Reflect.apply(orig as AnyFn, target, args);
      if (typeof prop !== 'string' || !CACHED_METHODS.has(prop)) return bound;
      return async (ctx: unknown, input: unknown, ...rest: unknown[]) => {
        const tenantId = (ctx as { tenantId?: unknown } | null | undefined)?.tenantId;
        if (typeof tenantId !== 'string' || !tenantId) return bound(ctx, input, ...rest);
        let rev: number;
        try { rev = await readRevision(ctx as { tenantId: string; tx?: unknown }); } catch { return bound(ctx, input, ...rest); }
        if (!Number.isInteger(rev)) return bound(ctx, input, ...rest);
        const hit = cache.get(tenantId, prop, input, rev);
        if (hit) return hit.value;
        const result = await bound(ctx, input, ...rest);
        cache.set(tenantId, prop, input, result, rev);
        return result;
      };
    },
  });
}
