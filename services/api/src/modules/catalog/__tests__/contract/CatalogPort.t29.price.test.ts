// T-29 (C3) — REAL CatalogPort.priceFor, the CR-C3-001 parts: tax rates in the quote (17), tax_config_missing (18), explicit inactive list (23), AC-15.1, AC-12.2.
// Spec: 02-TRD §6.1 (PriceQuote.tax {vat, otherTaxCode?, vatRateBp?, otherTaxRateBp?, hsCode?}; priceFor row: catalog.no_price, catalog.tax_config_missing, common.not_found), §7.4–§7.6, §14 cases (17) (18) (23);
//       01-PRD AC-15.1 (tenant default exempt + orderable rule taxable -> taxable with vatRateBp 1300, others exempt), AC-15.3 (never an assumed exempt), AC-12.2 (allows_credit=false party still
//       gets its list, source credit_party), AC-13.1 (precedence is T-28b's); 07-SECURITY S-1, S-6, REQ-SEC-046 (read-only). Money = { amountPaisa, currency: 'NPR' }.
// priceFor itself is T-28b (cases 6–8, not in this repo yet): these tests drive the port method with a PriceQuery { orderableId, context{priceListId?, creditPartyId?, referrerId?, centreId?}, priority, at }
// and throw (not per-item error objects) per the TRD @throws row. World = the quote engine's (T-19): helpers/quoteDb.ts; the rules are the same data, the port is the new consumer.
// Assumptions beyond the spec (see .orchestra/notes/C3.T-29-tests.md): check order not_found -> no_price -> tax_config_missing; the whole call rejects for a bad context id.
import { describe, expect, it } from 'vitest';
import { centre, defaultList, dept, orderable, party, passign, pitem, plist, pver, srule, trule, ttype, VAT_ROW } from '../helpers/quoteDb.js';
import type { Row } from '../helpers/mastersDb.js';
import { NOW, T, TENANT_A as A, TENANT_B as B, WRITE, codeOf, keysOf, priceEnv } from '../helpers/t29.js';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const D1 = dept(1, A), D2 = dept(2, A);
const O_CBC = orderable(1, A, { code: 'CBC', kind: 'test', department_id: D1.id });
const O_FBS = orderable(2, A, { code: 'FBS', kind: 'test', department_id: D2.id });
const O_KIT = orderable(3, A, { code: 'KIT', kind: 'test', department_id: D2.id });                  // the "kit-sale orderable" of AC-15.1
const O_NOPRICE = orderable(4, A, { code: 'NOPRICE', kind: 'test', department_id: D1.id });
const O_B = orderable(9, B, { code: 'BSECRET', kind: 'test' });
const DEF = defaultList(1, A), PRT = plist(4, A, { owner_kind: 'credit_party' }), EXP = plist(5, A, { owner_kind: 'credit_party', code: 'EXPLICIT' });
const OFF = plist(6, A, { owner_kind: 'credit_party', code: 'OFFLIST', is_active: false });
const LB = defaultList(9, B);
const ver = (n: number, l: Row, o: Row = {}) => pver(n, A, l.id as string, 1, { status: 'published', effective_from: T0, ...o });
const [VD, VP, VE, VO] = [ver(1, DEF), ver(2, PRT), ver(3, EXP), ver(4, OFF)];
const VB = pver(9, B, LB.id as string, 1, { status: 'published' });
const P_NOCRED = party(1, A, { allows_credit: false, party_code: 'DISC1' }), P_B = party(9, B), C1 = centre(1, A), C_B = centre(9, B);

const world = (edit: (w: Record<string, Row[]>) => void = () => {}) => {
  const w: Record<string, Row[]> = {
    departments: [D1, D2], orderables: [O_CBC, O_FBS, O_KIT, O_NOPRICE, O_B], doctors: [], credit_parties: [P_NOCRED, P_B], collection_centres: [C1, C_B],
    price_lists: [DEF, PRT, EXP, OFF, LB], price_list_versions: [VD, VP, VE, VO, VB],
    price_list_items: [pitem(1, A, VD.id as string, O_CBC.id as string, 90_000), pitem(2, A, VD.id as string, O_FBS.id as string, 40_000), pitem(3, A, VD.id as string, O_KIT.id as string, 25_000),
      pitem(4, A, VP.id as string, O_CBC.id as string, 60_000), pitem(5, A, VE.id as string, O_CBC.id as string, 50_000), pitem(6, A, VO.id as string, O_CBC.id as string, 10_000),
      pitem(8, B, VB.id as string, O_B.id as string, 11_111)],
    price_list_assignments: [passign(1, A, PRT.id as string, 'credit_party', P_NOCRED.id as string)],
    tax_rules: [trule(1, A), trule(9, B)],                                                            // tenant default: exempt
  };
  edit(w);
  return priceEnv(w);
};
const q = (o: Row, context: object = {}, priority = 'routine', at = NOW) => ({ orderableId: o.id, context, priority, at });
const replace = (w: Record<string, Row[]>, table: string, ...rows: Row[]) => { w[table] = rows; };

describe('priceFor: tax fields (17) AC-15.1', () => {
  it('is a function on the real port (T-28b)', { timeout: T }, () => { expect(typeof world().port['priceFor']).toBe('function'); });
  it('(17) AC-15.1 tenant default exempt + an orderable rule taxable for the kit orderable: taxable with vatRateBp 1300 for it, exempt (no rate key) for the others', { timeout: T }, async () => {
    const env = world((w) => { w['tax_rules'] = [trule(1, A), trule(2, A, { scope: 'orderable', orderable_id: O_KIT.id, vat_treatment: 'taxable' }), trule(9, B)]; });
    const kit = await env.one(q(O_KIT));
    expect(kit.tax).toEqual({ vat: 'taxable', vatRateBp: 1300 });
    const cbc = await env.one(q(O_CBC));
    expect(cbc.tax).toEqual({ vat: 'exempt' });
    expect(cbc.tax).not.toHaveProperty('vatRateBp');
  });
  it('the VAT rate is read from the g_tax_types row, not a constant (1400 -> 1400)', { timeout: T }, async () => {
    const env = priceEnv({ departments: [D1], orderables: [O_CBC], price_lists: [DEF], price_list_versions: [VD], price_list_items: [pitem(1, A, VD.id as string, O_CBC.id as string, 90_000)],
      tax_rules: [trule(1, A, { vat_treatment: 'taxable' })], g_tax_types: [{ ...VAT_ROW, rate_bp: 1400 }] }, { noVat: true });
    expect((await env.one(q(O_CBC))).tax).toEqual({ vat: 'taxable', vatRateBp: 1400 });
  });
  it('an "other" tax: otherTaxCode + otherTaxRateBp from the tenant tax type effective at `at`, hsCode from the rule', { timeout: T }, async () => {
    const env = world((w) => {
      w['tax_rules'] = [trule(1, A, { other_tax_code: 'HST', hs_code: '3002.12' }), trule(9, B)];
      w['cs_tax_types'] = [ttype(1, A, 'HST', { rate_bp: 200 })];
    });
    expect((await env.one(q(O_CBC))).tax).toEqual({ vat: 'exempt', otherTaxCode: 'HST', otherTaxRateBp: 200, hsCode: '3002.12' });
  });
  it('a taxable rule successor takes effect at its effective_from (rate is the one effective at `at`)', { timeout: T }, async () => {
    const later = new Date('2026-12-01T00:00:00.000Z');
    const env = world((w) => { w['tax_rules'] = [trule(1, A, { effective_to: later }), trule(2, A, { vat_treatment: 'taxable', effective_from: later }), trule(9, B)]; });
    expect((await env.one(q(O_CBC, {}, 'routine', NOW))).tax).toEqual({ vat: 'exempt' });
    expect((await env.one(q(O_CBC, {}, 'routine', '2026-12-01T00:00:00.000Z'))).tax).toEqual({ vat: 'taxable', vatRateBp: 1300 });
  });
  it('the quote carries port keys only: camelCase, Money as integer paisa NPR, optionals omitted (never null / undefined)', { timeout: T }, async () => {
    const r = await world().one(q(O_CBC));
    expect(r).toEqual({ orderableId: O_CBC.id, priceListId: DEF.id, priceListVersion: 1, source: 'tenant_default', unitPrice: { amountPaisa: 90_000, currency: 'NPR' }, tax: { vat: 'exempt' } });
    expect(keysOf(r).filter((k) => k.includes('_'))).toEqual([]);
    expect(Number.isSafeInteger(r.unitPrice.amountPaisa)).toBe(true);
  });
  it('urgent adds urgentSurcharge only when a rule exists (control that tax fields survive it)', { timeout: T }, async () => {
    const env = world((w) => { w['surcharge_rules'] = [srule(1, A, { amount_paisa: 5_000 })]; });
    const u = await env.one(q(O_CBC, {}, 'urgent'));
    expect(u.urgentSurcharge).toEqual({ amountPaisa: 5_000, currency: 'NPR' });
    expect(u.tax).toEqual({ vat: 'exempt' });
    expect(await world().one(q(O_CBC, {}, 'urgent'))).not.toHaveProperty('urgentSurcharge');
  });
});

describe('priceFor: errors (18) (23)', () => {
  it('(18) AC-15.3 no tenant-default tax rule and no orderable rule -> catalog.tax_config_missing (never an assumed exempt)', { timeout: T }, async () => {
    expect(await codeOf(world((w) => replace(w, 'tax_rules')).one(q(O_CBC)))).toBe('catalog.tax_config_missing');
  });
  it('(18) only an ended / inactive / not-yet-effective default counts as none', { timeout: T }, async () => {
    for (const o of [{ effective_to: T0 }, { is_active: false }, { effective_from: new Date('2027-01-01T00:00:00.000Z') }]) {
      expect(await codeOf(world((w) => replace(w, 'tax_rules', trule(1, A, o))).one(q(O_CBC))), JSON.stringify(o)).toBe('catalog.tax_config_missing');
    }
  });
  it('(18) taxable but no usable VAT row, or an other-tax code without a usable tax type -> catalog.tax_config_missing', { timeout: T }, async () => {
    const noVat = priceEnv({ departments: [D1], orderables: [O_CBC], price_lists: [DEF], price_list_versions: [VD], price_list_items: [pitem(1, A, VD.id as string, O_CBC.id as string, 1)],
      tax_rules: [trule(1, A, { vat_treatment: 'taxable' })] }, { noVat: true });
    expect(await codeOf(noVat.one(q(O_CBC)))).toBe('catalog.tax_config_missing');
    expect(await codeOf(world((w) => replace(w, 'tax_rules', trule(1, A, { other_tax_code: 'NOSUCH' }))).one(q(O_CBC)))).toBe('catalog.tax_config_missing');
  });
  it('error order: unknown orderable -> common.not_found; no price AND no tax rule -> catalog.no_price (before tax_config_missing)', { timeout: T }, async () => {
    expect(await codeOf(world().one(q(O_NOPRICE)))).toBe('catalog.no_price');
    expect(await codeOf(world((w) => replace(w, 'tax_rules')).one(q(O_NOPRICE)))).toBe('catalog.no_price');
    expect(await codeOf(world().one({ orderableId: '0190c300-0000-7000-8000-0000000ffff1', context: {}, priority: 'routine', at: NOW }))).toBe('common.not_found');
    expect(await codeOf(world().one(q(O_B)))).toBe('common.not_found');                           // another tenant's orderable
  });
  it('(23) an explicit INACTIVE price list -> common.not_found (even though it holds a price); the active explicit list is used', { timeout: T }, async () => {
    const env = world();
    expect(await codeOf(env.one(q(O_CBC, { priceListId: OFF.id })))).toBe('common.not_found');
    const ok = await env.one(q(O_CBC, { priceListId: EXP.id }));
    expect([ok.source, ok.priceListId, ok.unitPrice.amountPaisa]).toEqual(['explicit', EXP.id, 50_000]);
  });
  it('(23) unknown explicit list, another tenant\'s list, unknown / foreign party and centre -> common.not_found for the whole call (S-1)', { timeout: T }, async () => {
    const env = world();
    for (const context of [{ priceListId: '0190c300-0000-7000-8000-0000000ffff2' }, { priceListId: LB.id }, { creditPartyId: '0190c300-0000-7000-8000-0000000ffff3' }, { creditPartyId: P_B.id },
      { centreId: '0190c300-0000-7000-8000-0000000ffff4' }, { centreId: C_B.id }, { referrerId: '0190c300-0000-7000-8000-0000000ffff5' }]) {
      expect(await codeOf(env.one(q(O_CBC, context))), JSON.stringify(context)).toBe('common.not_found');
    }
  });
  it('bad input -> common.validation_failed: unknown priority, malformed at, non-uuid orderableId, no input', { timeout: T }, async () => {
    const env = world();
    for (const bad of [q(O_CBC, {}, 'stat'), q(O_CBC, {}, 'routine', 'tomorrow'), { ...q(O_CBC), orderableId: 'nope' }, { ...q(O_CBC), orderableId: undefined }, undefined, null]) {
      expect(await codeOf(env.one(bad)), JSON.stringify(bad)).toBe('common.validation_failed');
    }
  });
});

describe('priceFor: AC-12.2 a party that does not allow credit still gets its list', () => {
  it('source credit_party, the party\'s list and price (60 000) although the party row has allows_credit = false', { timeout: T }, async () => {
    const r = await world().one(q(O_CBC, { creditPartyId: P_NOCRED.id }));
    expect([r.source, r.priceListId, r.unitPrice.amountPaisa]).toEqual(['credit_party', PRT.id, 60_000]);
  });
});

describe('priceFor: read-only and tenant-scoped (REQ-SEC-046, S-1, S-6)', () => {
  it('no write / lock statement; every tenant-table statement names tenant_id and binds the tenant; ids are bound, never spliced', { timeout: T }, async () => {
    const env = world();
    await env.one(q(O_CBC, { creditPartyId: P_NOCRED.id, centreId: C1.id }, 'urgent'));
    expect(env.db.writes).toEqual([]);
    const s = env.db.stmts;
    expect(s.filter((x) => WRITE.test(x.text))).toEqual([]);
    for (const x of s.filter((y) => /catalog\.(price_|credit_parties|doctors|orderables|tax_rules|surcharge_rules|cs_tax_types)/i.test(y.text))) {
      expect(x.text, x.text).toMatch(/\btenant_id\b/i);
      expect(x.values).toContain(A);
      expect(x.text).not.toContain(String(O_CBC.id));
    }
  });
  it('tenant B prices its own orderable from its own default list and never sees tenant A\'s orderables', { timeout: T }, async () => {
    const env = world();
    const own = await env.one(q(O_B), { tenantId: B });
    expect([own.priceListId, own.unitPrice.amountPaisa, own.tax]).toEqual([LB.id, 11_111, { vat: 'exempt' }]);
    expect(await codeOf(env.one(q(O_CBC), { tenantId: B }))).toBe('common.not_found');
  });
});
