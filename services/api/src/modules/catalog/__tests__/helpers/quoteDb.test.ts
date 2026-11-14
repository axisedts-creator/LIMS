// Self-check of the T-19 composite fake (helpers/quoteDb.ts): routing to the two underlying fakes, tenant isolation, read-only guard. Not a test of the quote engine.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, defaultList, makeQuoteDb, orderable, pitem, pver, srule, trule } from './quoteDb.js';

const A = TENANT_A;
const O1 = orderable(1, A); const OB = orderable(9, TENANT_B);
const L = defaultList(1, A); const V = pver(1, A, L.id as string, 1, { status: 'published' });

describe('quoteDb composite fake', () => {
  const db = makeQuoteDb({ rows: { orderables: [O1, OB], price_lists: [L], price_list_versions: [V], price_list_items: [pitem(1, A, V.id as string, O1.id as string, 900)], surcharge_rules: [srule(1, A)], tax_rules: [trule(1, A)] } });
  it('routes price tables and rule tables to the right side inside ONE transaction', async () => {
    const out = await db.run(async (ctx) => ({
      items: (await ctx.tx.query('SELECT orderable_id, unit_price_paisa FROM catalog.price_list_items WHERE tenant_id = $1', [A])).rows,
      rules: (await ctx.tx.query('SELECT id, scope FROM catalog.surcharge_rules WHERE tenant_id = $1', [A])).rows,
      vat: (await ctx.tx.query('SELECT code, rate_bp FROM catalog.g_tax_types WHERE code = $1', ['VAT'])).rows,
      rev: (await ctx.tx.query('SELECT catalog_revision FROM catalog.catalog_state WHERE tenant_id = $1', [A])).rows,
    }));
    expect(out.items).toMatchObject([{ orderable_id: O1.id, unit_price_paisa: 900 }]);
    expect(out.rules).toHaveLength(1);
    expect(out.vat).toMatchObject([{ code: 'VAT', rate_bp: 1300 }]);
    expect(out.rev[0].catalog_revision).toBe('417');
  });
  it("another tenant's rows are invisible, and `noVat` removes the VAT row", async () => {
    expect(await db.run((ctx) => ctx.tx.query('SELECT id FROM catalog.orderables WHERE tenant_id = $1', [TENANT_B]).then((r: any) => r.rows.map((x: any) => x.id)), { tenantId: TENANT_B })).toEqual([OB.id]);
    expect(await makeQuoteDb({ noVat: true }).run((ctx) => ctx.tx.query('SELECT code FROM catalog.g_tax_types WHERE code = $1', ['VAT']).then((r: any) => r.rows))).toEqual([]);
  });
  it('is read-only: writes are recorded and rolled back; the result of fn is returned', async () => {
    const r = await db.run(async (ctx) => { await ctx.tx.query('UPDATE catalog.surcharge_rules SET is_active = $2 WHERE id = $1', [srule(1, A).id, false]); return 'ok'; });
    expect(r).toBe('ok');
    expect(db.writes).toHaveLength(1);
    expect(db.tax.rows('surcharge_rules', A)[0]!.is_active).toBe(true);
  });
  it('errors from fn propagate unchanged', async () => {
    await expect(db.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});
