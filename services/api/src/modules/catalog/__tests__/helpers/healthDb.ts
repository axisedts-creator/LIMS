// T-30 (C3) test fixture: ONE transaction facade over three existing SQL fakes so the health report (#4) and revision (#1) read a whole tenant in one request.
//   tests side  testsDb.ts   (T-06..T-14): departments, specimen_types, containers, methods, orderables, tests, panels, panel_members, test_specimen_types, analytes,
//                            analyte_versions, reference_range_sets, reference_ranges, critical_limit_sets, critical_limits, formula_dependencies, tat_targets, value sets
//   price side  pricingDb.ts (T-17):     price_lists, price_list_versions, price_list_items, ..., catalog_state (revision, global_release_seen), core.event_log
//   rule  side  taxDb.ts     (T-18):     surcharge_rules, tax_rules, cs_tax_types, g_tax_types
// Routing is by table name in the SQL text (never position). Dialect = single-table SQL with bind params, NO joins / subqueries / aggregates beyond count(*) (mastersDb.ts header):
// the report is computed in the service from several single-table SELECTs. Everything not tests-side or rule-side (catalog_state, event_log) goes to the price side.
// Both reports are READ-ONLY: `run` always rolls back every transaction and any INSERT / UPDATE / DELETE is recorded in `writes` (a test failure).
// Price-side `orderables` rows are derived from the tests-side orderables (same ids). `run(fn, { tenantId, at, ctx })`: `at` fixes ctx.now(). Synthetic data only.
import { ROOT_A, ROOT_B, TENANT_A, TENANT_B, USER } from './catalogDb.js';
import type { Row } from './mastersDb.js';
import { makePricingDb, type PTable } from './pricingDb.js';
import { makeTaxDb, type TTable } from './taxDb.js';
import { makeTestsDb, type T6Table } from './testsDb.js';

const RULE_RE = /\bcatalog\.(surcharge_rules|tax_rules|cs_tax_types|g_tax_types)\b/i;
const TESTS_RE = /\bcatalog\.(departments|specimen_types|containers|methods|orderables|tests|panels|panel_members|test_specimen_types|analytes|analyte_versions|reference_range_sets|reference_ranges|critical_limit_sets|critical_limits|formula_dependencies|tat_targets|g_value_sets|cs_value_sets|g_value_set_values|cs_value_set_values)\b/i;
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE)\b/i;

export const TENANT_NEW = '0190a000-0000-7000-8000-0000000000c3';   // a tenant with NO catalog_state row yet
export interface HealthSeed {
  masters?: { departments?: Row[]; specimen_types?: Row[]; containers?: Row[]; methods?: Row[] };
  t6?: Partial<Record<T6Table, Row[]>>;
  price?: Partial<Record<PTable, Row[]>>;
  tax?: Partial<Record<TTable, Row[]>>;
  /** catalog_state per tenant; default A = 417 / seen 3, B = 9 / seen 1, others none. */
  state?: Record<string, { rootId: string; revision: number; globalReleaseSeen?: number }>;
}

export function makeHealthDb(seed: HealthSeed = {}) {
  const state = seed.state ?? { [TENANT_A]: { rootId: ROOT_A, revision: 417, globalReleaseSeen: 3 }, [TENANT_B]: { rootId: ROOT_B, revision: 9, globalReleaseSeen: 1 } };
  const catalog = { state } as never;
  const t6 = seed.t6 ?? {};
  const tests = makeTestsDb({ rows: seed.masters as never, t6, catalog });
  const priceRows: Partial<Record<PTable, Row[]>> = { ...(seed.price ?? {}) };
  priceRows.orderables = (t6.orderables ?? []).map((o) => ({ id: o['id'], tenant_id: o['tenant_id'] }));
  const price = makePricingDb({ rows: priceRows as never, catalog });
  const tax = makeTaxDb({ rows: { ...(seed.tax ?? {}), departments: seed.masters?.departments ?? [] } as never, catalog });
  const writes: string[] = [];

  async function run<T>(fn: (ctx: any) => Promise<T>, o: { tenantId?: string; actorId?: string; at?: Date; ctx?: Record<string, unknown> } = {}): Promise<T> {
    const tenantId = o.tenantId ?? TENANT_A; const actorId = o.actorId ?? USER;
    const taxTx = tax.begin(tenantId, actorId, o.at);
    const testsTx = tests.begin(tenantId, actorId);
    let out: T | undefined; let done = false;
    try {
      await price.run(async (ctx: any) => {
        const pf = ctx.tx;
        const routed = {
          ...pf,
          async query(text: string, values: unknown[] = []) {
            if (WRITE_RE.test(text.replace(/\s+/g, ' ').trim())) writes.push(text);
            if (RULE_RE.test(text)) return taxTx.facade.query(text, values);
            if (TESTS_RE.test(text)) return testsTx.facade.query(text, values);
            return pf.query(text, values);
          },
          savepoint: async (f: (t: unknown) => Promise<unknown>) => f(routed),
        };
        out = await fn({ ...ctx, tx: routed }); done = true;
      }, { tenantId, actorId, ...(o.at ? { at: o.at } : {}), ...(o.ctx ? { ctx: o.ctx } : {}), rollback: true }).catch((e) => { if (!(done && e instanceof Error && e.message === 'forced rollback')) throw e; });
      return out as T;
    } finally { taxTx.rollback(); testsTx.rollback(); }
  }

  return {
    run, price, tax, tests, writes,
    /** Every statement of the three sides (cross-side order is NOT guaranteed — use per-statement predicates). */
    get stmts() { return [...price.stmts, ...tests.stmts, ...tax.base.stmts].map((s: any) => ({ text: String(s.text), values: s.values as unknown[], tenantId: s.tenantId as string })); },
    revisionOf: price.revisionOf,
  };
}
export type HealthDb = ReturnType<typeof makeHealthDb>;

export { MANAGE, READ, actorIdentity, defaultList, ID, plist, pitem, pver } from './pricingDb.js';
export { trule, ttype } from './taxDb.js';
export { ana, anv, rset, tsr, tst, pnl, tat } from './testsDb.js';
export { dept, spec } from './mastersDb.js';
export { ROOT_A, ROOT_B, TENANT_A, TENANT_B, USER };
/** The permission #1 and #4 declare (02-TRD §5 rows 1, 4). */
export const TEST_READ = 'catalog.test.read';
