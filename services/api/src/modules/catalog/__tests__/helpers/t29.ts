// T-29 (C3) shared test setup: the REAL CatalogPort (CR-C3-001 additions) over the existing SQL fakes. Synthetic data only.
//   refEnv   getReferrer / getCreditParty : doctors + price lists/assignments (pricingDb.ts) and credit parties with pan / billing_address / contact (creditPartiesDb.ts),
//            ONE transaction facade routing `catalog.credit_parties` to the parties fake and everything else to the pricing fake (same trick as quoteDb.ts).
//   cmtEnv   resolveCommentCodes          : comment_codes + comment_code_texts + departments (commentsDb.ts).
//   priceEnv priceFor                     : quoteDb.ts (price lists + tax rules + VAT row).
// SEAM (spec silent on names; the same as T-28a): `ports/CatalogPort.impl.ts` `createCatalogPort({ cache })` returns an object that also has
//   getReferrer(ctx, { referrerId, purpose }), getCreditParty(ctx, { creditPartyId, purpose }), resolveCommentCodes(ctx, { codes, departmentId?, asOf? }), priceFor(ctx, PriceQuery)
//   (camelCase per contracts/ports/CatalogPort.ts). All run on ctx.tx, never write, tenant from ctx.tenantId only, every value a bind parameter, single-table SQL (fake dialect).
import { isLimsError } from '../../../../core/errors.js';
import { createCatalogCache } from '../../cache/catalogCache.js';
import { createCatalogPort } from '../../ports/CatalogPort.impl.js';
import { ROOT_A, ROOT_B, TENANT_A, TENANT_B, USER } from './catalogDb.js';
import { makeCommentsDb, type CommentTable } from './commentsDb.js';
import { makeCreditPartiesDb } from './creditPartiesDb.js';
import type { Row } from './mastersDb.js';
import { makePricingDb, type PTable } from './pricingDb.js';
import { makeQuoteDb } from './quoteDb.js';

export { TENANT_A, TENANT_B, USER, ROOT_A, ROOT_B };
export const T = 20_000;
export const REV = 417;
export const NOW = '2026-11-07T12:00:00.000Z';
export const seedState = { state: { [TENANT_A]: { rootId: ROOT_A, revision: REV }, [TENANT_B]: { rootId: ROOT_B, revision: REV } } };

type Port = Record<string, (ctx: any, input?: any) => Promise<any>>;
export const newPort = (): Port => createCatalogPort({ cache: createCatalogCache({ maxEntries: 1000, ttlSeconds: 600 }) }) as unknown as Port;

/** Actor override for a ctx (`ctx.actor.type`): the port only allows `user` and `system` to read contact / billing data. */
export const asActor = (type: string, id = USER) => ({ ctx: { actor: { type, id } } });
export const NON_STAFF = ['device', 'portal', 'patient', 'partner'] as const;
export const STAFF = ['user', 'system'] as const;

/** Rejection code of a LimsError (asserts the rejection IS a LimsError, never a crash). */
export async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e: any) { if (!isLimsError(e)) throw e; return e.code; }
}
/** The rejection itself (a LimsError), or fails. */
export async function rejection(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { if (!isLimsError(e as never)) throw e; return e; }
  throw new Error('expected rejection, got success');
}
/** All object keys of a value, recursively. */
export function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); }
  return out;
}
export const WRITE = /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b|\bFOR\s+(UPDATE|SHARE)\b/i;

// ---------------------------------------------------------------------------------------------------------------------------- refEnv
export interface RefSeed { rows?: Partial<Record<PTable, Row[]>>; parties?: Row[] }
export function refEnv(seed: RefSeed = {}) {
  const { credit_parties: _ignored, ...priceRows } = seed.rows ?? {};
  const price = makePricingDb({ rows: priceRows as never, catalog: seedState as never });
  const parties = makeCreditPartiesDb({ rows: { credit_parties: seed.parties ?? [] }, catalog: seedState as never });
  const port = newPort();
  async function run<T>(fn: (ctx: any) => Promise<T>, o: { tenantId?: string; ctx?: Record<string, unknown> } = {}): Promise<T> {
    const tenantId = o.tenantId ?? TENANT_A;
    const partyTx = parties.begin(tenantId, USER);
    let out: T | undefined; let done = false;
    try {
      await price.run(async (ctx: any) => {
        const pf = ctx.tx;
        const routed = {
          ...pf,
          async query(text: string, values: unknown[] = []) { return (/\bcatalog\.credit_parties\b/i.test(text) ? partyTx.facade : pf).query(text, values); },
          savepoint: async (f: (t: unknown) => Promise<unknown>) => f(routed),
        };
        out = await fn({ ...ctx, tx: routed }); done = true;
      }, { tenantId, ...(o.ctx ? { ctx: o.ctx } : {}), rollback: true }).catch((e) => { if (!(done && e instanceof Error && e.message === 'forced rollback')) throw e; });
      return out as T;
    } finally { partyTx.rollback(); }
  }
  const one = <R = any>(method: string, input: unknown, o: { tenantId?: string; ctx?: Record<string, unknown> } = {}): Promise<R> => run((ctx) => port[method]!(ctx, input), o);
  return {
    run, one, port,
    get stmts() { return [...price.stmts, ...parties.stmts].map((s: any) => ({ text: String(s.text), values: s.values as unknown[], tenantId: s.tenantId as string })); },
  };
}
export type RefEnv = ReturnType<typeof refEnv>;

// ---------------------------------------------------------------------------------------------------------------------------- cmtEnv
export interface CmtSeed { rows?: Partial<Record<CommentTable, Row[]>>; departments?: Row[] }
export function cmtEnv(seed: CmtSeed = {}) {
  const db = makeCommentsDb({ rows: seed.rows ?? {}, departments: seed.departments ?? [], catalog: seedState as never });
  const port = newPort();
  const one = <R = any>(input: unknown, o: { tenantId?: string; ctx?: Record<string, unknown>; at?: Date } = {}): Promise<R> =>
    db.run((ctx) => port['resolveCommentCodes']!(ctx, input), o);
  return { db, port, one };
}
export type CmtEnv = ReturnType<typeof cmtEnv>;

// ---------------------------------------------------------------------------------------------------------------------------- priceEnv
export function priceEnv(rows: Record<string, Row[]>, o: { noVat?: boolean } = {}) {
  const db = makeQuoteDb({ rows: rows as never, ...o });
  const port = newPort();
  const one = <R = any>(input: unknown, r: { tenantId?: string; ctx?: Record<string, unknown>; at?: Date } = {}): Promise<R> =>
    db.run((ctx) => port['priceFor']!(ctx, input), { at: new Date(NOW), ...r });
  return { db, port, one };
}
export type PriceEnv = ReturnType<typeof priceEnv>;
