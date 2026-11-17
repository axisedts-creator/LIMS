// FD-T15 F25 listFrontdeskCodes. 02-TRD §5 F25: GET /v1/frontdesk/coded-sets/{set_name}, set_name in order_cancel_reasons | item_removal_reasons | discount_reasons |
// duplicate_override_reasons | anonymise_reasons | flag_resolutions, permission frontdesk.order.read (NOT privileged: aal1 is enough), response `{data:[{code, display, sort_order}]}`.
// Source rows: frontdesk.g_cs_reasons (global, seeded) + frontdesk.cs_reasons (tenant, RLS) — 05-SCHEMA §3/§7. db/seeds has no frontdesk rows yet, so the tests seed their own
// uniquely-named codes and assert on those only (a later seed file must not break them): active only, ordered by sort_order, own tenant only, own set only.
// Fails now: stub (common.service_unavailable).
import { describe, expect, it } from 'vitest';
import { ADMIN, DESK, P, T, TENANT_B, as, codes, schemaErrors, seed, tag, uid } from './helpers.js';

const SETS = ['order_cancel_reasons', 'item_removal_reasons', 'discount_reasons', 'duplicate_override_reasons', 'anonymise_reasons', 'flag_resolutions'] as const;
const mine = (body: any, prefix: string) => (body.data as any[]).filter((x) => String(x.code).startsWith(prefix));

async function seedGlobal(set: string, prefix: string) {
  const c = (n: string) => `${prefix}_${n}`;
  const rows = [{ code: c('third'), sort_order: 30, is_active: true }, { code: c('first'), sort_order: 10, is_active: true },
    { code: c('second'), sort_order: 20, is_active: true }, { code: c('retired'), sort_order: 5, is_active: false }];
  for (const r of rows) await seed('frontdesk.g_cs_reasons', { id: uid(), set_name: set, display: `Synthetic ${r.code}`, ...r });
  return { active: [c('first'), c('second'), c('third')], retired: c('retired') };
}
async function seedTenant(side: 'a' | 'b', set: string, code: string, sort: number, active = true) {
  await seed('frontdesk.cs_reasons', { id: uid(), tenant_id: side === 'a' ? ADMIN.tenant : TENANT_B, set_name: set, code, display: `Synthetic ${code}`, sort_order: sort, is_active: active });
}

describe('F25 listFrontdeskCodes', () => {
  it.each(SETS)('%s: active global codes only, ordered by sort_order, shaped {code, display, sort_order}', { timeout: T }, async (set) => {
    const p = `zz15${tag()}`; const s = await seedGlobal(set, p);
    const r = await codes(set);
    expect(r.status).toBe(200);
    expect(schemaErrors('CodedSetList', r.body)).toEqual([]);
    expect(mine(r.body, p).map((x) => x.code)).toEqual(s.active);                       // sorted 10, 20, 30; the retired one is gone
    expect(r.body.data.map((x: any) => x.code)).not.toContain(s.retired);
    for (const x of r.body.data) expect(Object.keys(x).sort()).toEqual(['code', 'display', 'sort_order']);   // no requires_text / id / is_active leak
    const orders = r.body.data.map((x: any) => x.sort_order);
    expect(orders).toEqual([...orders].sort((a: number, b: number) => a - b));
  });

  it('a code of one set never shows up in another set', { timeout: T }, async () => {
    const p = `zz15${tag()}`; await seedGlobal('order_cancel_reasons', p);
    for (const other of SETS.filter((x) => x !== 'order_cancel_reasons')) expect(mine((await codes(other)).body, p), other).toEqual([]);
  });

  it('tenant codes (cs_reasons) are merged in for their own tenant, active only, and never cross tenants', { timeout: T }, async () => {
    const p = `zz15${tag()}`;
    await seedTenant('a', 'discount_reasons', `${p}_a_on`, 15); await seedTenant('a', 'discount_reasons', `${p}_a_off`, 16, false); await seedTenant('b', 'discount_reasons', `${p}_b_on`, 17);
    const a = mine((await codes('discount_reasons')).body, p).map((x) => x.code);
    expect(a).toEqual([`${p}_a_on`]);
    const b = mine((await codes('discount_reasons', as(DESK, { tenant: TENANT_B, centreIds: [] }))).body, p).map((x) => x.code);
    expect(b).toEqual([`${p}_b_on`]);
    // explicit tenant filter, RLS bypassed
    expect(mine((await codes('discount_reasons', DESK, { bypassRls: true })).body, p).map((x) => x.code)).toEqual([`${p}_a_on`]);
  });

  it('an unknown set name is refused (400 common.validation_failed or 404 common.not_found) and never reaches SQL', { timeout: T }, async () => {
    for (const bad of ['nope', '', 'ORDER_CANCEL_REASONS', "order_cancel_reasons'; DROP TABLE frontdesk.g_cs_reasons;--", '../settings', 'x'.repeat(40)]) {
      const e = await codes(bad).catch((x) => x);
      expect(['common.validation_failed', 'common.not_found'], JSON.stringify(bad)).toContain(e?.code);
    }
  });

  it('permission frontdesk.order.read is required (auth.forbidden) and sufficient at aal1; settings.manage / registration.create alone are not enough', { timeout: T }, async () => {
    expect((await codes('order_cancel_reasons', as(DESK, { grants: [] })).catch((e) => e)).code).toBe('auth.forbidden');
    expect((await codes('order_cancel_reasons', as(DESK, { grants: [P.create, P.settings] })).catch((e) => e)).code).toBe('auth.forbidden');
    const ok = await codes('order_cancel_reasons', as(DESK, { grants: [P.orderRead], mfa: 'aal1' }));
    expect(ok.status).toBe(200); expect(ok.probe.identity.calls.map((c) => c.permission)).toContain(P.orderRead);
  });
});
