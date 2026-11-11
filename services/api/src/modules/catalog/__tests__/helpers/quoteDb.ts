// T-19 (C3) test fixture: ONE transaction facade over the two existing SQL fakes, so the quote engine can read price lists AND surcharge / tax rows in one request.
//   price side  pricingDb.ts (T-17): price_lists, price_list_assignments, price_list_versions, price_list_items, doctors, credit_parties, orderables, collection_centres, catalog_state
//   rule  side  taxDb.ts     (T-18): surcharge_rules, tax_rules, cs_tax_types, g_tax_types (the VAT row 1300 bp is seeded unless `noVat`)
// Routing is by table name in the SQL text (never position); everything else (catalog_state, event_log) goes to the price side. Dialect = single-table SQL with bind params (pricingDb.ts).
// The quote engine is READ-ONLY: `run` always rolls back both transactions, and any write statement from the engine is a test failure (`writes` lists them).
// `run(fn, { tenantId, at, ctx })`: `at` fixes ctx.now() (the default `at` of a quote). `stmts` = every statement of both sides with its binds (S-6 / tenant scoping checks).
// Synthetic data only.
import { ROOT_A, ROOT_B, TENANT_A, TENANT_B, USER } from './catalogDb.js';
import type { Row } from './mastersDb.js';
import { makePricingDb, type PTable } from './pricingDb.js';
import { makeTaxDb, type TTable } from './taxDb.js';

const RULE_RE = /\bcatalog\.(surcharge_rules|tax_rules|cs_tax_types|g_tax_types)\b/i;
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE)\b/i;
type Seed = Partial<Record<PTable | TTable | 'departments', Row[]>>;

export interface QuoteSeed { rows?: Seed; noVat?: boolean; revision?: number }

export function makeQuoteDb(seed: QuoteSeed = {}) {
  const rows = seed.rows ?? {};
  const catalog = { state: { [TENANT_A]: { rootId: ROOT_A, revision: seed.revision ?? 417 }, [TENANT_B]: { rootId: ROOT_B, revision: seed.revision ?? 417 } } };
  const priceRows: Seed = {}; const taxRows: Seed = {};
  for (const [t, v] of Object.entries(rows)) {
    if (['surcharge_rules', 'tax_rules', 'cs_tax_types', 'g_tax_types'].includes(t)) taxRows[t as never] = v as never; else priceRows[t as never] = v as never;
  }
  // orderables / price_lists / departments are reference data on both sides
  taxRows.orderables = rows.orderables ?? []; taxRows.price_lists = rows.price_lists ?? []; taxRows.departments = rows.departments ?? [];
  const price = makePricingDb({ rows: priceRows as never, catalog: catalog as never });
  const tax = makeTaxDb({ rows: taxRows as never, catalog: catalog as never, ...(seed.noVat ? { noVat: true } : {}) });
  const writes: string[] = [];

  async function run<T>(fn: (ctx: any) => Promise<T>, o: { tenantId?: string; actorId?: string; at?: Date; ctx?: Record<string, unknown> } = {}): Promise<T> {
    const tenantId = o.tenantId ?? TENANT_A; const actorId = o.actorId ?? USER;
    const taxTx = tax.begin(tenantId, actorId, o.at);
    let out: T | undefined; let done = false;
    try {
      await price.run(async (ctx: any) => {
        const pf = ctx.tx;
        const routed = {
          ...pf,
          async query(text: string, values: unknown[] = []) {
            if (WRITE_RE.test(text.replace(/\s+/g, ' ').trim())) writes.push(text);
            return (RULE_RE.test(text) ? taxTx.facade : pf).query(text, values);
          },
          savepoint: async (f: (t: unknown) => Promise<unknown>) => f(routed),
        };
        out = await fn({ ...ctx, tx: routed }); done = true;
      }, { tenantId, actorId, ...(o.at ? { at: o.at } : {}), ...(o.ctx ? { ctx: o.ctx } : {}), rollback: true }).catch((e) => { if (!(done && e instanceof Error && e.message === 'forced rollback')) throw e; });
      return out as T;
    } finally { taxTx.rollback(); }
  }

  return {
    run, price, tax, writes,
    /** Every statement of both sides, in issue order is NOT guaranteed across sides — use per-statement predicates. */
    get stmts() { return [...price.stmts, ...tax.base.stmts].map((s: any) => ({ text: String(s.text), values: s.values as unknown[], tenantId: s.tenantId as string })); },
  };
}
export type QuoteDb = ReturnType<typeof makeQuoteDb>;

export { MANAGE, READ, actorIdentity, centre, defaultList, ID, orderable, party, passign, pitem, plist, pver, doc } from './pricingDb.js';
export { dept, srule, trule, ttype, VAT_ROW } from './taxDb.js';
export { ROOT_A, ROOT_B, TENANT_A, TENANT_B };
