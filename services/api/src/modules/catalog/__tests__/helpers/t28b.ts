// T-28b (C3) shared test setup: the REAL CatalogPort.priceFor (camelCase port) over the composite SQL fake of helpers/quoteDb.ts (price lists T-17 + surcharge / tax rows T-18). Synthetic data only.
// SEAM (spec silent on names; same factory as T-28a, see .orchestra/notes/T-28b-tests.md):
//   catalog/ports/CatalogPort.impl.ts  createCatalogPort(deps: { cache: CatalogCache })  -> the object ALSO has  priceFor(ctx, query: PriceQuery): Promise<PriceQuote>   (contracts/ports/CatalogPort.ts)
//   PriceQuote = { orderableId, priceListId, priceListVersion, source, unitPrice: {amountPaisa, currency:'NPR'}, urgentSurcharge?: Money, tax: { vat, vatRateBp?, otherTaxCode?, otherTaxRateBp?, hsCode? } }
//   — absent optionals are OMITTED (never null / undefined-valued keys). Rejections are LimsError: common.not_found (404), catalog.no_price (422), catalog.tax_config_missing (422), common.validation_failed (400).
//   Runs inside ctx.tx (read-only: no write, no event, no lock, no revision bump), tenant from ctx.tenantId only, every value a bind; revision read at most once per ctx
//   (`SELECT catalog_revision FROM catalog.catalog_state WHERE tenant_id = $1`); `at` is required by the contract but still validated (ISO instant with offset).
//   The price/surcharge/tax rules are the quote engine's (02-TRD §7.4–§7.6): priceFor(q) == quotePrices({items:[{orderable_id, priority}], context, at}).quotes[0] with the per-item error_code thrown instead.
import { createEvents } from '../../../../core/events/publish.js';
import { isLimsError } from '../../../../core/errors.js';
import { createCatalogCache } from '../../cache/catalogCache.js';
import { createCatalogPort } from '../../ports/CatalogPort.impl.js';
import { createRevisionService } from '../../service/revision.service.js';
import type { Row } from './mastersDb.js';
import { TENANT_A, TENANT_B, centre, defaultList, dept, doc, makeQuoteDb, orderable, party, passign, pitem, plist, pver, trule } from './quoteDb.js';

export { TENANT_A, TENANT_B };
export const T = 20_000;
export const A = TENANT_A;
export const NOW = new Date(Date.UTC(2026, 10, 7, 12, 0, 0));
export const T0 = new Date('2026-01-01T00:00:00.000Z');
export const T1 = new Date('2026-06-01T00:00:00.000Z');
export const T3 = new Date('2027-01-01T00:00:00.000Z');          // after NOW: a scheduled version
export const iso = (d: Date) => d.toISOString();
export const NPR = (n: number) => ({ amountPaisa: n, currency: 'NPR' as const });
export const GHOST = '0190c300-0000-7000-8000-0000000ffff1';

// ---- synthetic world (tenant A; B holds foreign data that must never surface). Prices: default 900 / centre 800 / referrer 700 / credit party 600 / explicit 500 NPR for CBC.
export const D1 = dept(1, A), D2 = dept(2, A), DB_ = dept(9, TENANT_B);
export const O1 = orderable(1, A, { code: 'CBC', kind: 'test', department_id: D1.id });
export const O2 = orderable(2, A, { code: 'FBS', kind: 'test', department_id: D2.id });
export const O3 = orderable(3, A, { code: 'LFT', kind: 'panel', department_id: null });
export const O4 = orderable(4, A, { code: 'PKG', kind: 'panel', department_id: D1.id });            // a package: components priced, itself NOT
export const OB = orderable(9, TENANT_B, { code: 'BSECRET', kind: 'test' });
export const DOC1 = doc(1, A), DOC2 = doc(2, A, { merged_into_id: DOC1.id, is_active: false }), DOC3 = doc(3, A);
export const P1 = party(1, A), P2 = party(2, A), C2 = centre(2, A), C3 = centre(3, A);
export const PB = party(9, TENANT_B), CB = centre(9, TENANT_B);
export const DEF = defaultList(1, A), CEN = plist(2, A, { owner_kind: 'centre' }), REF = plist(3, A, { owner_kind: 'referrer' });
export const PRT = plist(4, A, { owner_kind: 'credit_party' }), EXP = plist(5, A, { owner_kind: 'credit_party', code: 'EXPLICIT' });
export const LB = defaultList(9, TENANT_B);
export const ver = (n: number, list: Row, no: number, o: Row = {}) => pver(n, A, list.id as string, no, { status: 'published', effective_from: T0, ...o });
export const item = (n: number, v: Row, o: Row, paisa: number) => pitem(n, A, v.id as string, o.id as string, paisa);
export const [VD, VC, VR, VP, VE] = [ver(1, DEF, 1), ver(2, CEN, 1), ver(3, REF, 1), ver(4, PRT, 1), ver(5, EXP, 1)] as [Row, Row, Row, Row, Row];
export const VB = pver(9, TENANT_B, LB.id as string, 1, { status: 'published' });

export type World = Record<string, Row[]>;
export const base = (): World => ({
  departments: [D1, D2, DB_], orderables: [O1, O2, O3, O4, OB], doctors: [DOC1, DOC2, DOC3], credit_parties: [P1, P2, PB], collection_centres: [C2, C3, CB],
  price_lists: [DEF, CEN, REF, PRT, EXP, LB], price_list_versions: [VD, VC, VR, VP, VE, VB],
  price_list_items: [item(1, VD, O1, 90_000), item(2, VD, O2, 40_000), item(3, VD, O3, 120_000), item(4, VC, O1, 80_000), item(5, VR, O1, 70_000), item(6, VP, O1, 60_000), item(7, VE, O1, 50_000),
    pitem(8, TENANT_B, VB.id as string, OB.id as string, 11_111)],
  price_list_assignments: [passign(1, A, PRT.id as string, 'credit_party', P1.id as string), passign(2, A, REF.id as string, 'referrer', DOC1.id as string), passign(3, A, CEN.id as string, 'centre', C2.id as string)],
  tax_rules: [trule(1, A), trule(9, TENANT_B)],                                                                            // tenant default: exempt
});
export const replace = (w: World, table: string, pred: (r: Row) => boolean, ...next: Row[]) => { w[table] = [...(w[table] ?? []).filter((r) => !pred(r)), ...next]; };
export type Edit = Partial<Record<string, Row[]>> | ((w: World) => void);

type PortFn = (ctx: any, input?: any) => Promise<any>;
/** World above (`edit` ADDS rows per table, or mutates the world in a function). ONE cache + ONE port per env, shared by every request (so cross-request / cross-tenant cache leaks show). */
export function setup28b(edit: Edit = {}, o: { noVat?: boolean } = {}) {
  const w = base();
  if (typeof edit === 'function') edit(w); else for (const [k, v] of Object.entries(edit)) w[k] = [...(w[k] ?? []), ...(v ?? [])];
  const db = makeQuoteDb({ rows: w as never, ...o });
  const cache = createCatalogCache({ maxEntries: 50_000, ttlSeconds: 600 });
  const port = createCatalogPort({ cache }) as unknown as Record<string, PortFn>;
  return { db, cache, port, w };
}
export type Env28b = ReturnType<typeof setup28b>;

export interface Q { orderableId: string; context?: Record<string, unknown>; priority?: 'routine' | 'urgent'; at?: string }
/** The PriceQuery of the contract: `at` defaults to NOW, priority to routine. */
export const query = (orderableId: string, context: Record<string, unknown> = {}, priority: 'routine' | 'urgent' = 'routine', at: string = iso(NOW)) => ({ orderableId, context, priority, at });

/** One request (= one ctx = one tx, rolled back: the port is read-only) against the port. ctx.now() = `now` (default NOW). */
export const call = <R>(env: Env28b, fn: (port: Env28b['port'], ctx: any) => Promise<R>, o: { tenantId?: string; now?: Date } = {}): Promise<R> =>
  env.db.run((ctx) => fn(env.port, ctx), { at: o.now ?? NOW, ...(o.tenantId ? { tenantId: o.tenantId } : {}) });
export const priceFor = (env: Env28b, q: unknown, o: { tenantId?: string; now?: Date } = {}): Promise<any> => call(env, (p, ctx) => p['priceFor']!(ctx, q), o);
/** priceFor for an orderable with the given context. */
export const pf = (env: Env28b, orderable_: Row, context: Record<string, unknown> = {}, priority: 'routine' | 'urgent' = 'routine', at?: string): Promise<any> =>
  priceFor(env, query(orderable_['id'] as string, context, priority, at));

/** Rejection of a promise (asserts it IS a LimsError; a TypeError crash is not a rejection of this kind). */
export async function errOf(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e: any) { if (!isLimsError(e)) throw e; return e; }
  throw new Error('expected a LimsError rejection, got success');
}
export async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e: any) { if (!isLimsError(e)) throw e; return e.code; }
}

/** Commits a change of a price list + a revision bump (what any C3 price write does). `falls_through` is mutable on a list at any time. */
export async function setFallsThrough(env: Env28b, listId: string, value: boolean): Promise<void> {
  const rev = createRevisionService({ events: createEvents({ producer: 'catalog' } as never) } as never);
  await env.db.price.run(async (ctx) => {
    await ctx.tx.query('UPDATE catalog.price_lists SET falls_through = $1 WHERE tenant_id = $2 AND id = $3', [value, A, listId]);
    await rev.bumpRevision(ctx as never, { entityType: 'price_list', entityId: listId, changeKind: 'updated', effectiveFrom: iso(NOW) });
  }, { at: NOW });
}

/** All object keys of a value, recursively (for the "no snake_case / no internals" checks). */
export function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); }
  return out;
}
export { createQuoteService } from '../../service/quote.service.js';
export { READ, VAT_ROW, actorIdentity, centre, defaultList, dept, doc, makeQuoteDb, orderable, party, passign, pitem, plist, pver, srule, trule, ttype } from './quoteDb.js';
