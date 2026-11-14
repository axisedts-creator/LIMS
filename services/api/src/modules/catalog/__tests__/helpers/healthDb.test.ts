// T-30 fixture self-check: the composite fake routes each table to its side, keeps tenants apart, supports the single-table SQL the report needs, and never writes.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, TENANT_NEW, defaultList, dept, makeHealthDb, pitem, pnl, pver, trule, tst } from './healthDb.js';

const T = 20_000;
const D1 = dept(1, TENANT_A);
const O1 = tst(1, TENANT_A, D1.id as string, { code: 'CBC' });
const P1 = pnl(1, TENANT_A, { code: 'PNL1' });
const OB = tst(2, TENANT_B, dept(2, TENANT_B).id as string, { code: 'CBC' });
const DEF = defaultList(1, TENANT_A); const V1 = pver(1, TENANT_A, DEF.id as string, 1, { status: 'published' });
const db = () => makeHealthDb({
  masters: { departments: [D1] },
  t6: { orderables: [O1.orderable, P1.orderable, OB.orderable], tests: [O1.test, OB.test], panels: [P1.panel] },
  price: { price_lists: [DEF], price_list_versions: [V1], price_list_items: [pitem(1, TENANT_A, V1.id as string, O1.orderable.id as string, 90_000)] },
  tax: { tax_rules: [trule(1, TENANT_A)] },
});

describe('healthDb fixture', () => {
  it('routes tests-side, price-side and rule-side tables and the revision row; tenant B sees none of tenant A', { timeout: T }, async () => {
    const d = db();
    const a = await d.run(async (ctx) => ({
      orderables: (await ctx.tx.query('SELECT id FROM catalog.orderables WHERE tenant_id = $1 AND is_active = true', [TENANT_A])).rows.length,
      items: (await ctx.tx.query('SELECT orderable_id FROM catalog.price_list_items WHERE tenant_id = $1', [TENANT_A])).rows.length,
      rules: (await ctx.tx.query("SELECT id FROM catalog.tax_rules WHERE tenant_id = $1 AND scope = 'tenant_default'", [TENANT_A])).rows.length,
      state: (await ctx.tx.query('SELECT catalog_revision, global_release_seen FROM catalog.catalog_state WHERE tenant_id = $1', [TENANT_A])).rows[0],
    }));
    expect(a.orderables).toBe(2); expect(a.items).toBe(1); expect(a.rules).toBe(1);
    expect(Number(a.state.catalog_revision)).toBe(417); expect(a.state.global_release_seen).toBe(3);
    const b = await d.run(async (ctx) => ({
      orderables: (await ctx.tx.query('SELECT id FROM catalog.orderables WHERE tenant_id = $1', [TENANT_B])).rows.length,
      aOrderablesLeak: (await ctx.tx.query('SELECT id FROM catalog.orderables', [])).rows.length,
      rules: (await ctx.tx.query('SELECT id FROM catalog.tax_rules', [])).rows.length,
    }), { tenantId: TENANT_B });
    expect(b).toEqual({ orderables: 1, aOrderablesLeak: 1, rules: 0 });
    expect(d.writes).toEqual([]);
  });
  it('a tenant without a state row reads none, and statements are recorded', { timeout: T }, async () => {
    const d = db();
    const r = await d.run((ctx) => ctx.tx.query('SELECT catalog_revision FROM catalog.catalog_state WHERE tenant_id = $1', [TENANT_NEW]), { tenantId: TENANT_NEW });
    expect(r.rows).toEqual([]);
    expect(d.stmts.length).toBeGreaterThan(0);
  });
});
