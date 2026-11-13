// S12 listBookableItems, S13 upsertBookableItem, S14 syncBookableItems + the shared catalogue snapshot used by the worker task engagement.sync_bookable_items
// (02-TRD §5 S12-S14, §7 CatalogPort rows, §8.1; 05-SCHEMA bookable_items; US-EN-26.1-3). Tenant and actor come from ctx only; errors carry fixed text.
// Name, code, sex restriction and price are NEVER taken from a request: they are a snapshot of C3 (getTest/getPanel + priceFor with the tenant default, context {}).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { isUuid } from './queue.service.js';
import * as defaultRepo from '../repository/bookable.repo.js';
import type { SnapshotCols } from '../repository/bookable.repo.js';

export interface BookableCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly tx: unknown;
  readonly ports?: { CatalogPort?: CatalogLike };
  now(): string;
}
interface CatalogLike {
  getTest(ctx: any, i: { testId: string; requireActive?: boolean }): Promise<Record<string, any>>;
  getPanel(ctx: any, i: { panelId: string; requireActive?: boolean }): Promise<Record<string, any>>;
  priceFor(ctx: any, i: { orderableId: string; context: Record<string, never>; priority: 'routine'; at: string }): Promise<Record<string, any>>;
}
export type BookableRepo = typeof defaultRepo;

export const SYNC_TASK = 'engagement.sync_bookable_items';
export const SYNC_MAX_ATTEMPTS = 5;                                  // TRD §8.1
export const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4::timestamptz, $5)';   // (identifier, payload, job_key, run_at, max_attempts)
export const syncJobKey = (tenantId: string): string => `bookable:${tenantId}`;

const KINDS = ['centre_visit', 'home_collection'];
const UPSERT_KEYS = new Set(['orderable_kind', 'booking_kinds', 'sort_order', 'is_active']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fe = (path: string, code: string, message: string): FieldError => ({ path, code, message });
const invalid = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => { throw new LimsError('common.validation_failed', undefined, [fe(path, code, message)]); };
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();

export interface Snapshot { snap: SnapshotCols; catalogActive: boolean }

/** C3 snapshot of one orderable. catalog.no_price -> price columns NULL (US-EN-26.3); every other port error (incl. common.not_found, catalog.test_inactive) propagates. */
export async function fetchSnapshot(ctx: BookableCtx, a: { kind: 'test' | 'panel'; orderableId: string; requireActive: boolean }): Promise<Snapshot> {
  const catalog = ctx.ports?.CatalogPort;
  if (!catalog) throw new LimsError('common.service_unavailable');
  const def = a.kind === 'test'
    ? await catalog.getTest(ctx, { testId: a.orderableId, requireActive: a.requireActive })
    : await catalog.getPanel(ctx, { panelId: a.orderableId, requireActive: a.requireActive });
  let price: Record<string, any> | null = null;
  try {
    price = await catalog.priceFor(ctx, { orderableId: a.orderableId, context: {}, priority: 'routine', at: ctx.now() });
  } catch (e) {
    if (!(e instanceof LimsError && e.code === 'catalog.no_price')) throw e;
  }
  const sex = def['sexRestriction'];
  return {
    catalogActive: def['isActive'] !== false,
    snap: {
      code: String(def['code']).slice(0, 64), displayName: String(def['name']).slice(0, 200),
      sexRestriction: sex === 'male' || sex === 'female' ? sex : null,
      priceAmount: price ? Number(price['unitPrice']['amountPaisa']) : null, priceListId: price ? price['priceListId'] : null, priceListVersion: price ? price['priceListVersion'] : null,
      catalogRevision: Number.isInteger(def['revision']) ? def['revision'] : null,
    },
  };
}

/** Row -> StaffBookableItem: only schema fields; NULL columns omitted. price_source is always tenant_default: the snapshot is never taken for a customer context ([CONV], no column). */
function toBody(r: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = { orderable_id: r['orderable_id'], kind: r['orderable_kind'], code: r['code'], display_name: r['display_name'], booking_kinds: r['booking_kinds'], is_active: r['is_active'], version: r['version'] };
  if (r['indicative_price_paisa'] != null) { out['indicative_price'] = { amount_paisa: Number(r['indicative_price_paisa']), currency: 'NPR' }; out['price_source'] = 'tenant_default'; }
  if (r['sex_restriction'] != null) out['sex_restriction'] = r['sex_restriction'];
  if (r['synced_at'] != null) out['synced_at'] = iso(r['synced_at']);
  return out;
}

/** If-Match arrives as the raw header '"<version>"'. Absent -> undefined (create); malformed -> 400. */
function parseIfMatch(headers: unknown): number | undefined {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  const n = m ? Number(m[1]) : 0;
  if (n < 1 || n > 2147483647) return invalid('/If-Match');
  return n;
}

const encodeCursor = (r: Record<string, any>) => Buffer.from(JSON.stringify([r['sort_order'], r['display_name'], r['id']])).toString('base64url');
function decodeCursor(c: unknown): { sortOrder: number; displayName: string; id: string } | undefined {
  if (c === undefined) return undefined;
  try {
    if (typeof c !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(c)) throw new Error('shape');
    const [sortOrder, displayName, id] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown[];
    if (!Number.isInteger(sortOrder) || typeof displayName !== 'string' || !isUuid(id)) throw new Error('shape');
    return { sortOrder: sortOrder as number, displayName, id };
  } catch { return invalid('/cursor'); }
}

function scope(ctx: BookableCtx): { tx: any; tenantId: string; userId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, userId: ctx.actor.id };
}

export function createBookableService(deps: { repo?: BookableRepo } = {}) {
  const repo = deps.repo ?? defaultRepo;

  return {
    async list(ctx: BookableCtx, q: unknown) {
      const { tx, tenantId } = scope(ctx);
      const query = isObj(q) ? q : {};
      const act = query['is_active'];
      if (act !== undefined && act !== true && act !== false && act !== 'true' && act !== 'false') invalid('/is_active');
      const text = query['query'];
      if (text !== undefined && (typeof text !== 'string' || text.length > 40)) invalid('/query');
      const rawLimit = query['limit'];
      const limit = rawLimit === undefined ? 50 : typeof rawLimit === 'string' && /^[0-9]{1,4}$/.test(rawLimit) ? Number(rawLimit) : typeof rawLimit === 'number' ? rawLimit : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('/limit');
      const after = decodeCursor(query['cursor']);
      const search = typeof text === 'string' && text !== '' ? `%${text.replace(/[\\%_]/g, '\\$&')}%` : undefined;
      const rows = await repo.listItems(tx, { tenantId, ...(act === undefined ? {} : { isActive: act === true || act === 'true' }), search, ...(after ? { after } : {}), limit: limit + 1 });
      const page = rows.slice(0, limit);
      return { data: page.map(toBody), page: { limit, ...(rows.length > limit ? { next_cursor: encodeCursor(page[page.length - 1]!) } : {}) } };
    },

    async upsert(ctx: BookableCtx, input: { orderableId: unknown; body: unknown; headers: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      const b = input.body;
      if (!isObj(b)) return invalid('/');
      for (const k of Object.keys(b)) if (!UPSERT_KEYS.has(k)) invalid(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');   // mass assignment (code, price, tenant_id, version, ...)
      for (const k of UPSERT_KEYS) if (b[k] === undefined) invalid(`/${k}`, 'common.field_required', 'Field required');
      const kind = b['orderable_kind'];
      if (kind !== 'test' && kind !== 'panel') invalid('/orderable_kind');
      const kinds = b['booking_kinds'];
      if (!Array.isArray(kinds) || kinds.length < 1 || kinds.length > 2 || !kinds.every((k) => typeof k === 'string' && KINDS.includes(k)) || new Set(kinds).size !== kinds.length) invalid('/booking_kinds');
      const sort = b['sort_order'];
      if (typeof sort !== 'number' || !Number.isInteger(sort) || sort < 0 || sort > 9999) invalid('/sort_order');
      if (typeof b['is_active'] !== 'boolean') invalid('/is_active');
      if (!isUuid(input.orderableId)) return invalid('/orderable_id');
      const orderableId = input.orderableId as string;
      const expected = parseIfMatch(input.headers);

      const existing = await repo.getByOrderable(tx, { tenantId, orderableId });   // another tenant's row is invisible: 404, never 409/403
      if (expected !== undefined) {
        if (!existing) throw new LimsError('common.not_found');
        if (existing['version'] !== expected) throw new LimsError('common.version_conflict');
      } else if (existing) throw new LimsError('common.version_conflict');          // create of an orderable that is already in the catalogue

      const { snap } = await fetchSnapshot(ctx, { kind: kind as 'test' | 'panel', orderableId, requireActive: b['is_active'] === true });
      const common = { tenantId, userId, orderableId, bookingKinds: kinds as string[], sortOrder: sort as number, isActive: b['is_active'] as boolean, syncedAt: ctx.now(), snap };
      const row = expected === undefined
        ? await repo.insertItem(tx, { ...common, kind: kind as string }).catch((e: unknown) => { throw !(e instanceof LimsError) && (e as { code?: unknown } | null)?.code === '23505' ? new LimsError('common.version_conflict') : e; })
        : await repo.updateItem(tx, { ...common, expectedVersion: expected });
      if (!row) throw new LimsError('common.version_conflict');                      // changed between read and write
      return toBody(row);
    },

    /** S14: only enqueues; the request never calls C3. Clicking twice collapses on the job_key. */
    async enqueueSync(ctx: BookableCtx) {
      const { tx, tenantId } = scope(ctx);
      await tx.query(ENQUEUE_SQL, [SYNC_TASK, JSON.stringify({ tenant_id: tenantId }), syncJobKey(tenantId), null, SYNC_MAX_ATTEMPTS]);
      return {};
    },
  };
}
export type BookableService = ReturnType<typeof createBookableService>;
