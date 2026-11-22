// T0D-FIX-1 item 5c (LD-446, CR DEPLOY-AXIS-012 item 10): GET /v1/catalog/tests (listTests) and searchOrderables never filled `default_price_paisa`
// ("not joined here"), so Catalog > Tests showed an empty Price column. It must carry the unit price of the test in the PUBLISHED version of the tenant's
// DEFAULT price list, as an integer, and omit the field when there is none (OrderableSummary: "absent when no default price list price").
// No database: a scripted tx answers by table (ignores WHERE; the tenant predicate is asserted on the recorded statements instead).
import { describe, expect, it } from 'vitest';
import { createTestsService } from '../../service/tests.service.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
const u = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;
const DEPT = u(0xd1), PL = u(0x91), VER = u(0x92);
const N = 30;
const tid = (i: number) => u(0x1000 + i);

interface World { prices: Record<string, string>; defaultList: boolean }
function scripted(w: World) {
  const log: { text: string; values: unknown[] }[] = [];
  const orderables = Array.from({ length: N }, (_, i) => ({ id: tid(i), kind: 'test', code: `T${String(i).padStart(3, '0')}`, name: `Synthetic test ${i}`, department_id: DEPT,
    sex_restriction: null, is_orderable: true, is_active: true, revision: 1 }));
  const tests = orderables.map((o) => ({ id: o.id, workflow_type: 'standard', report_order: 1, uses_existing_material: false, version: 1, is_active: true, category_id: null, short_name: null, display_name: null }));
  const items = Object.entries(w.prices).map(([id, p]) => ({ orderable_id: id, price_list_version_id: VER, unit_price_paisa: p, price_paisa: p, default_price_paisa: p, price_list_id: PL }));
  const tx = {
    async query(text: string, values: unknown[] = []) {
      log.push({ text, values });
      if (/price_list_items/i.test(text)) return { rows: items };
      if (/price_list_versions/i.test(text)) return { rows: w.defaultList ? [{ id: VER, price_list_id: PL, status: 'published' }] : [] };
      if (/price_lists/i.test(text)) return { rows: w.defaultList ? [{ id: PL, owner_kind: 'default', is_active: true }] : [] };
      const t = /\bFROM\s+catalog\.([a-z_]+)/i.exec(text)?.[1];
      if (t === 'orderables') return { rows: orderables };
      if (t === 'tests') return { rows: tests };
      if (t === 'departments') return { rows: [{ id: DEPT, code: 'HAEM' }] };
      return { rows: [] };
    },
  };
  return { tx, log };
}
const svc = createTestsService({ events: { publish: async () => ({}) } } as never) as any;
const ctxOf = (tx: unknown) => ({ tenantId: TENANT, actor: { id: u(1) }, requestId: u(2), tx, now: () => '2026-11-22T06:00:00.000Z' });
const priceStatements = (log: { text: string }[]) => log.filter((s) => /price_list/i.test(s.text));

describe('default_price_paisa on the test list (item 5c)', () => {
  it('listTests: a priced test carries its default price as an integer; an unpriced one has no field', async () => {
    const { tx } = scripted({ prices: { [tid(0)]: '12500', [tid(1)]: '0' }, defaultList: true });
    const r = await svc.listTests(ctxOf(tx), { limit: 50 });
    const by = Object.fromEntries(r.data.map((d: any) => [d.id, d]));
    expect(by[tid(0)].default_price_paisa).toBe(12500);
    expect(by[tid(1)].default_price_paisa).toBe(0);          // a real price of 0 is a price, not "absent"
    expect('default_price_paisa' in by[tid(2)]).toBe(false);
    expect(r.data).toHaveLength(N);
  });
  it('searchOrderables carries it too (same OrderableSummary)', async () => {
    const { tx } = scripted({ prices: { [tid(3)]: '4000' }, defaultList: true });
    const r = await svc.searchOrderables(ctxOf(tx), { q: 'T003' });
    expect(r.data.find((d: any) => d.id === tid(3))?.default_price_paisa).toBe(4000);
  });
  it('no default price list -> 200 and no summary has the field', async () => {
    const { tx } = scripted({ prices: {}, defaultList: false });
    const r = await svc.listTests(ctxOf(tx), {});
    expect(r.data.length).toBeGreaterThan(0);
    for (const d of r.data) expect('default_price_paisa' in d).toBe(false);
  });
  it('a large price (999999999 paisa, the column maximum) stays an exact integer', async () => {
    const { tx } = scripted({ prices: { [tid(0)]: '999999999' }, defaultList: true });
    expect((await svc.listTests(ctxOf(tx), {})).data.find((d: any) => d.id === tid(0)).default_price_paisa).toBe(999999999);
  });
  it('no N+1: the price lookup is at most 3 statements for a page of 30 tests', async () => {
    const { tx, log } = scripted({ prices: { [tid(0)]: '1' }, defaultList: true });
    await svc.listTests(ctxOf(tx), { limit: 50 });
    expect(priceStatements(log).length).toBeGreaterThan(0);
    expect(priceStatements(log).length).toBeLessThanOrEqual(3);
  });
  it('tenant isolation: every price statement has an explicit tenant_id predicate bound to the ctx tenant, and is parameterised', async () => {
    const { tx, log } = scripted({ prices: { [tid(0)]: '1' }, defaultList: true });
    await svc.listTests(ctxOf(tx), {});
    expect(priceStatements(log).length).toBeGreaterThan(0);
    for (const s of priceStatements(log)) {
      expect(s.text, s.text).toMatch(/tenant_id\s*=\s*\$\d/i);
      expect(s.values).toContain(TENANT);
      expect(s.text).not.toContain(TENANT);
    }
  });
  it('only the DEFAULT list, PUBLISHED version counts: the statements say so (owner_kind default / status published)', async () => {
    const { tx, log } = scripted({ prices: { [tid(0)]: '1' }, defaultList: true });
    await svc.listTests(ctxOf(tx), {});
    const all = priceStatements(log).map((s) => s.text + ' ' + JSON.stringify(s.values)).join(' | ');
    expect(all).toMatch(/default/i);
    expect(all).toMatch(/published/i);
  });
  it('the existing summary fields are unchanged next to the price', async () => {
    const { tx } = scripted({ prices: { [tid(0)]: '12500' }, defaultList: true });
    const d = (await svc.listTests(ctxOf(tx), {})).data.find((x: any) => x.id === tid(0));
    expect(d).toMatchObject({ kind: 'test', code: 'T000', department_code: 'HAEM', workflow_type: 'standard', is_orderable: true, is_active: true, revision: 1 });
  });
});
