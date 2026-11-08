// T-28b (C3) — the REAL CatalogPort.priceFor over the composite SQL fake (helpers/quoteDb.ts). Interface: helpers/t28b.ts (SEAM header).
// Spec: 03-IC §4.2 contract cases (6) precedence over five sources, (7) urgent surcharge only when a rule exists, (8) no price -> catalog.no_price, and from 08 (17) vatRateBp 1300,
//       (18) catalog.tax_config_missing, (23) explicit inactive list -> common.not_found; 02-TRD §6.1 (priceFor row), §7.4 (precedence), §7.5 (surcharge), §7.6 (tax);
//       PRD AC-13.1–13.3, AC-14.1–14.4, AC-15.1, AC-15.3, AC-15.5 (effect on the quote), AC-07.6; 07-SECURITY REQ-SEC-046 (server-side prices), S-1 (tenant), S-6 (binds only).
// AC-14.5 (overlapping surcharge rule -> 400 /effective_from), AC-15.2 (rule without a rate -> 400 /other_tax_code) and the AC-15.5 overlap rejection are WRITE-side rules (T-18, services under
//   __tests__/integration/pricing*.test.ts); priceFor cannot reach them. Here only their READ consequence is asserted (a rule whose rate is unusable cannot yield a quote).
// Behaviour = the quote engine (quote.service.ts, T-19) with camelCase output and thrown errors instead of per-item error_code; a differential test pins the two together.
// The shared packages/fakes/contract-tests/CatalogPort.contract.ts runs all cases against the fake and is wired to the real impl by T-29.
import { describe, expect, it } from 'vitest';
import {
  A, C2, C3, CB, CEN, D1, D2, DEF, DOC1, DOC2, DOC3, EXP, GHOST, LB, NOW, NPR, O1, O2, O3, O4, OB, P1, P2, PB, PRT, REF, T, T0, T1, T3, TENANT_B, VD, VAT_ROW,
  codeOf, createQuoteService, errOf, item, iso, keysOf, pf, priceFor, query, replace, setFallsThrough, setup28b, srule, trule, ttype, ver, actorIdentity, READ, call,
} from '../helpers/t28b.js';
import { createEvents } from '../../../../core/events/publish.js';
import type { Row } from '../helpers/mastersDb.js';

const notFound = async (p: Promise<unknown>) => { const e = await errOf(p); expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404); };
const pct = (n: number, bp: number, o: Row = {}) => srule(n, A, { scope: 'department', department_id: D1.id, amount_kind: 'percent', amount_paisa: null, percent_bp: bp, ...o });

describe('CatalogPort real impl: priceFor shape (AC-19.1, 03-IC §4.2)', () => {
  it('exposes priceFor as a function', { timeout: T }, () => {
    expect(typeof setup28b().port['priceFor']).toBe('function');
  });
  it('a default-list quote carries exactly the contract fields (camelCase), optionals OMITTED, money is integer paisa NPR (AC-13.3, AC-13.8)', { timeout: T }, async () => {
    const q = await pf(setup28b(), O1);
    expect(q).toEqual({ orderableId: O1.id, priceListId: DEF.id, priceListVersion: 1, source: 'tenant_default', unitPrice: NPR(90_000), tax: { vat: 'exempt' } });
    expect(Number.isSafeInteger(q.unitPrice.amountPaisa)).toBe(true);
    expect(Object.keys(q).sort()).toEqual(['orderableId', 'priceListId', 'priceListVersion', 'source', 'tax', 'unitPrice']);
  });
  it('no snake_case keys, no null, no internal columns leak (tenant_id, id, status, effective_*)', { timeout: T }, async () => {
    const env = setup28b({ surcharge_rules: [pct(1, 5_000)], tax_rules: [trule(2, A, { scope: 'orderable', orderable_id: O1.id, vat_treatment: 'taxable', other_tax_code: 'HST', hs_code: '9018' })], cs_tax_types: [ttype(1, A, 'HST', { rate_bp: 500 })] });
    const q = await pf(env, O1, { creditPartyId: P1.id }, 'urgent');
    for (const k of keysOf(q)) expect(k, k).toMatch(/^[a-z][A-Za-z]*$/);
    expect(JSON.stringify(q)).not.toMatch(/null|tenant|"id"|status|effective|_paisa|created|updated/);
    expect(q).toEqual({
      orderableId: O1.id, priceListId: PRT.id, priceListVersion: 1, source: 'credit_party', unitPrice: NPR(60_000), urgentSurcharge: NPR(30_000),
      tax: { vat: 'taxable', vatRateBp: 1300, otherTaxCode: 'HST', otherTaxRateBp: 500, hsCode: '9018' },
    });
  });
  it('the result is a fresh object per call: mutating it never changes the next answer (cache safety)', { timeout: T }, async () => {
    const env = setup28b();
    const first = await pf(env, O1);
    try { (first as any).unitPrice.amountPaisa = 1; (first as any).tax.vat = 'taxable'; (first as any).source = 'explicit'; } catch { /* frozen is fine too */ }
    expect(await pf(env, O1)).toEqual({ orderableId: O1.id, priceListId: DEF.id, priceListVersion: 1, source: 'tenant_default', unitPrice: NPR(90_000), tax: { vat: 'exempt' } });
  });
  it('a differential: for every context combination priceFor == quotePrices (same engine, camelCase / thrown errors)', { timeout: T }, async () => {
    const env = setup28b({ surcharge_rules: [pct(1, 5_000)] });
    const svc = createQuoteService({ events: createEvents({ producer: 'catalog' } as never), identity: actorIdentity([READ]) } as never) as unknown as { quotePrices: (c: any, b: any) => Promise<{ quotes: any[] }> };
    const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
    const deep = (v: any): any => Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), k === 'currency' ? x : deep(x)])) : v;
    const ctxs: Array<Record<string, string>> = [{}, { centre_id: C2.id }, { referrer_id: DOC1.id, centre_id: C2.id }, { credit_party_id: P1.id, referrer_id: DOC1.id, centre_id: C2.id }, { price_list_id: EXP.id }, { referrer_id: DOC2.id }, { credit_party_id: P2.id, centre_id: C3.id }];
    for (const c of ctxs) for (const priority of ['routine', 'urgent'] as const) for (const o of [O1, O2, O3]) {
      const quoted = (await env.db.run((ctx) => svc.quotePrices(ctx, { items: [{ orderable_id: o['id'], priority }], context: c }), { at: NOW })).quotes[0];
      const asPort = { price_list_id: c['price_list_id'], credit_party_id: c['credit_party_id'], referrer_id: c['referrer_id'], centre_id: c['centre_id'] };
      const ctxCamel = Object.fromEntries(Object.entries(asPort).filter(([, v]) => v !== undefined).map(([k, v]) => [camel(k), v]));
      expect(await pf(env, o, ctxCamel, priority), JSON.stringify([c, priority, o['code']])).toEqual(deep(quoted));
    }
  });
});

describe('contract (6) priceFor precedence over five sources — AC-13.1: NPR 900 default / 800 centre C2 / 700 doctor X / 600 hospital H / explicit 500', () => {
  const ctxs: Array<[string, Record<string, string>, string, number, string]> = [
    ['no context', {}, 'tenant_default', 90_000, DEF.id as string],
    ['C2', { centreId: C2.id as string }, 'centre', 80_000, CEN.id as string],
    ['X + C2', { referrerId: DOC1.id as string, centreId: C2.id as string }, 'referrer', 70_000, REF.id as string],
    ['H + X + C2', { creditPartyId: P1.id as string, referrerId: DOC1.id as string, centreId: C2.id as string }, 'credit_party', 60_000, PRT.id as string],
    ['explicit + H + X + C2', { priceListId: EXP.id as string, creditPartyId: P1.id as string, referrerId: DOC1.id as string, centreId: C2.id as string }, 'explicit', 50_000, EXP.id as string],
    ['explicit alone', { priceListId: EXP.id as string }, 'explicit', 50_000, EXP.id as string],
  ];
  it.each(ctxs)('%s', { timeout: T }, async (_n, context, source, paisa, listId) => {
    expect(await pf(setup28b(), O1, context)).toMatchObject({ source, priceListId: listId, priceListVersion: 1, unitPrice: NPR(paisa) });
  });
  it('a party / doctor / centre with NO assigned list is not an error: the next source answers', { timeout: T }, async () => {
    expect(await pf(setup28b(), O1, { creditPartyId: P2.id, referrerId: DOC3.id, centreId: C3.id })).toMatchObject({ source: 'tenant_default', unitPrice: NPR(90_000) });
    expect(await pf(setup28b(), O1, { creditPartyId: P2.id, referrerId: DOC1.id })).toMatchObject({ source: 'referrer', unitPrice: NPR(70_000) });
  });
  it('a merged referrer resolves to the CANONICAL doctor and its list (02-TRD §7.4)', { timeout: T }, async () => {
    expect(await pf(setup28b(), O1, { referrerId: DOC2.id })).toMatchObject({ source: 'referrer', priceListId: REF.id, unitPrice: NPR(70_000) });
  });
  it('an INACTIVE assigned list is skipped as if absent (even with falls_through=false)', { timeout: T }, async () => {
    const env = setup28b((w) => replace(w, 'price_lists', (r) => r['id'] === PRT.id, { ...PRT, is_active: false, falls_through: false }));
    expect(await pf(env, O1, { creditPartyId: P1.id, centreId: C2.id })).toMatchObject({ source: 'centre', unitPrice: NPR(80_000) });
  });
  it('the answer is deterministic: same input, same revision -> identical output, repeatedly and from a cold cache', { timeout: T }, async () => {
    const env = setup28b();
    const ctx = { creditPartyId: P1.id, referrerId: DOC1.id, centreId: C2.id };
    const first = await pf(env, O1, ctx);
    for (let i = 0; i < 5; i++) expect(await pf(env, O1, ctx)).toEqual(first);
    env.cache.clear();
    expect(await pf(env, O1, ctx)).toEqual(first);
  });
});

describe('fall-through and effective windows — AC-13.2, AC-13.3, AC-07.6', () => {
  it('H lacks FBS and falls_through=true: FBS priced from the next source; CBC still from H', { timeout: T }, async () => {
    const env = setup28b();
    expect(await pf(env, O2, { creditPartyId: P1.id })).toMatchObject({ source: 'tenant_default', priceListId: DEF.id, unitPrice: NPR(40_000) });
    expect(await pf(env, O1, { creditPartyId: P1.id })).toMatchObject({ source: 'credit_party', unitPrice: NPR(60_000) });
  });
  it('H lacks FBS and falls_through=false: catalog.no_price (422) — the default is NOT consulted', { timeout: T }, async () => {
    const env = setup28b((w) => replace(w, 'price_lists', (r) => r['id'] === PRT.id, { ...PRT, falls_through: false }));
    const e = await errOf(pf(env, O2, { creditPartyId: P1.id }));
    expect([e.code, e.statusCode]).toEqual(['catalog.no_price', 422]);
    expect(await pf(env, O1, { creditPartyId: P1.id })).toMatchObject({ source: 'credit_party' });
  });
  it('an assigned list with ONLY a draft v1 is skipped as if absent, regardless of falls_through', { timeout: T }, async () => {
    for (const ft of [true, false]) {
      const env = setup28b((w) => { replace(w, 'price_lists', (r) => r['id'] === PRT.id, { ...PRT, falls_through: ft }); replace(w, 'price_list_versions', (r) => r['id'] === VP().id, { ...VP(), status: 'draft', effective_from: null, published_at: null, change_reason: null }); });
      expect(await pf(env, O1, { creditPartyId: P1.id, centreId: C2.id }), `falls_through=${ft}`).toMatchObject({ source: 'centre', unitPrice: NPR(80_000) });
    }
  });
  it('the explicit list lacking the item: falls_through=true continues down the chain; false ends it with no_price', { timeout: T }, async () => {
    expect(await pf(setup28b(), O2, { priceListId: EXP.id })).toMatchObject({ source: 'tenant_default', unitPrice: NPR(40_000) });
    const closed = setup28b((w) => replace(w, 'price_lists', (r) => r['id'] === EXP.id, { ...EXP, falls_through: false }));
    expect(await codeOf(pf(closed, O2, { priceListId: EXP.id }))).toBe('catalog.no_price');
  });
  const versioned = () => setup28b((w) => {
    replace(w, 'price_list_versions', (r) => r['id'] === VD.id, ver(1, DEF, 1, { status: 'superseded', effective_to: T1 }), ver(11, DEF, 2, { effective_from: T1 }), ver(12, DEF, 3, { effective_from: T3 }), ver(13, DEF, 4, { status: 'draft', effective_from: null }));
    replace(w, 'price_list_items', (r) => r['orderable_id'] === O1.id && r['price_list_version_id'] === VD.id, item(30, ver(1, DEF, 1), O1, 85_000), item(31, ver(11, DEF, 2), O1, 90_000), item(32, ver(12, DEF, 3), O1, 95_000), item(33, ver(13, DEF, 4), O1, 1));
  });
  it('AC-13.3 `at` selects the version and the quote names it: at < T1 -> v1; at == T1 -> v2 (inclusive start); at >= T3 -> v3; the draft v4 is never used', { timeout: T }, async () => {
    const env = versioned();
    expect(await pf(env, O1, {}, 'routine', iso(new Date(T1.getTime() - 1)))).toMatchObject({ priceListVersion: 1, unitPrice: NPR(85_000), priceListId: DEF.id });
    expect(await pf(env, O1, {}, 'routine', iso(T1))).toMatchObject({ priceListVersion: 2, unitPrice: NPR(90_000) });
    expect(await pf(env, O1, {}, 'routine', iso(NOW))).toMatchObject({ priceListVersion: 2 });
    expect(await pf(env, O1, {}, 'routine', iso(T3))).toMatchObject({ priceListVersion: 3, unitPrice: NPR(95_000) });
  });
  it('the SAME warm cache serves different instants correctly (time filtering is per call, not per cache entry)', { timeout: T }, async () => {
    const env = versioned();
    const at = [new Date(T0.getTime() - 1), T0, new Date(T1.getTime() - 1), T1, NOW, T3];
    const want = [undefined, 1, 1, 2, 2, 3];
    for (let round = 0; round < 2; round++) for (const [i, a] of at.entries()) {
      if (want[i] === undefined) expect(await codeOf(pf(env, O1, {}, 'routine', iso(a))), `round ${round} @${iso(a)}`).toBe('catalog.no_price');
      else expect((await pf(env, O1, {}, 'routine', iso(a))).priceListVersion, `round ${round} @${iso(a)}`).toBe(want[i]);
    }
  });
  it('a list whose first version starts in the future is skipped until then (falls to the default)', { timeout: T }, async () => {
    const env = setup28b((w) => replace(w, 'price_list_versions', (r) => r['id'] === VP().id, ver(4, PRT, 1, { effective_from: T3 })));
    expect(await pf(env, O1, { creditPartyId: P1.id })).toMatchObject({ source: 'tenant_default' });
    expect(await pf(env, O1, { creditPartyId: P1.id }, 'routine', iso(T3))).toMatchObject({ source: 'credit_party', unitPrice: NPR(60_000) });
  });
  it('`at` bounds tax at the same instant (AC-15.5 successor default: exempt before T1, taxable with 1300 bp from T1)', { timeout: T }, async () => {
    const env = setup28b((w) => replace(w, 'tax_rules', () => true, trule(1, A, { effective_to: T1 }), trule(2, A, { vat_treatment: 'taxable', effective_from: T1 })));
    expect((await pf(env, O1, {}, 'routine', iso(new Date(T1.getTime() - 1)))).tax).toEqual({ vat: 'exempt' });
    expect((await pf(env, O1, {}, 'routine', iso(T1))).tax).toEqual({ vat: 'taxable', vatRateBp: 1300 });
  });
  it('AC-07.6 / contract (8): a package with no price-list item of its own -> catalog.no_price — component prices are never summed', { timeout: T }, async () => {
    expect(await codeOf(pf(setup28b(), O4))).toBe('catalog.no_price');
    expect(await codeOf(pf(setup28b(), O4, { creditPartyId: P1.id, centreId: C2.id, referrerId: DOC1.id }))).toBe('catalog.no_price');
  });
  it('contract (8): no price anywhere -> catalog.no_price 422, never a made-up 0; before the first version started too', { timeout: T }, async () => {
    const e = await errOf(pf(setup28b((w) => { w['price_list_items'] = w['price_list_items']!.filter((r) => r['orderable_id'] !== O2.id); }), O2));
    expect([e.code, e.statusCode]).toEqual(['catalog.no_price', 422]);
    expect(await codeOf(pf(setup28b(), O1, {}, 'routine', iso(new Date(T0.getTime() - 1))))).toBe('catalog.no_price');
    const noDefault = setup28b((w) => { w['price_lists'] = w['price_lists']!.filter((r) => r['id'] !== DEF.id); });
    expect(await codeOf(pf(noDefault, O1))).toBe('catalog.no_price');
  });
  it('a price of 0 paisa is a real price', { timeout: T }, async () => {
    expect(await pf(setup28b((w) => replace(w, 'price_list_items', (r) => r['orderable_id'] === O2.id, item(20, VD, O2, 0))), O2)).toMatchObject({ unitPrice: NPR(0), source: 'tenant_default' });
  });
});
function VP() { return ver(4, PRT, 1); }

describe('contract (23) ids that cannot be used: common.not_found — S-1, AB-1 (unknown and foreign look the same)', () => {
  it('an INACTIVE explicit list', { timeout: T }, async () => {
    await notFound(pf(setup28b((w) => replace(w, 'price_lists', (r) => r['id'] === EXP.id, { ...EXP, is_active: false })), O1, { priceListId: EXP.id }));
  });
  it("an unknown explicit list and another tenant's explicit list", { timeout: T }, async () => {
    const env = setup28b();
    for (const id of [GHOST, LB.id as string]) await notFound(pf(env, O1, { priceListId: id }));
  });
  it("an unknown / another tenant's credit party, referrer and centre", { timeout: T }, async () => {
    const env = setup28b();
    for (const ctx of [{ creditPartyId: GHOST }, { creditPartyId: PB.id }, { referrerId: GHOST }, { centreId: GHOST }, { centreId: CB.id }]) await notFound(pf(env, O1, ctx));
  });
  it("an unknown orderable and another tenant's orderable: common.not_found; its price never leaks", { timeout: T }, async () => {
    const env = setup28b();
    await notFound(pf(env, { id: GHOST } as Row));
    const e = await errOf(pf(env, OB));
    expect(e.code).toBe('common.not_found');
    expect(JSON.stringify({ m: e.message, d: e.detail, errors: e.errors })).not.toMatch(/11111|11_111|BSECRET/);
  });
  it('a panel/test id is priced the same way (kind is irrelevant to the engine): the panel LFT is priced from its own item', { timeout: T }, async () => {
    expect(await pf(setup28b(), O3)).toMatchObject({ orderableId: O3.id, unitPrice: NPR(120_000) });
  });
  it('tenant isolation with ONE shared cache: A warm, then B asks the same ids -> not_found / B only sees its own; A is unchanged afterwards', { timeout: T }, async () => {
    const env = setup28b();
    const mine = await pf(env, O1, { creditPartyId: P1.id });
    expect(mine.unitPrice).toEqual(NPR(60_000));
    await notFound(priceFor(env, query(O1.id as string, {}), { tenantId: TENANT_B }));
    await notFound(priceFor(env, query(O1.id as string, { creditPartyId: P1.id }), { tenantId: TENANT_B }));
    const b = await priceFor(env, query(OB.id as string), { tenantId: TENANT_B });
    expect(b).toMatchObject({ orderableId: OB.id, priceListId: LB.id, unitPrice: NPR(11_111) });
    expect(JSON.stringify(b)).not.toContain(String(O1.id));
    expect(await codeOf(priceFor(env, query(OB.id as string)))).toBe('common.not_found');
    expect(await pf(env, O1, { creditPartyId: P1.id })).toEqual(mine);
  });
});

describe('contract (7) urgent surcharge — AC-14.1–14.4', () => {
  it('AC-14.1: department HAEM 5000 bp on CBC NPR 900.00 -> urgentSurcharge 45000 paisa; routine -> the field is absent', { timeout: T }, async () => {
    const env = setup28b({ surcharge_rules: [pct(1, 5_000)] });
    expect(await pf(env, O1, {}, 'urgent')).toMatchObject({ unitPrice: NPR(90_000), urgentSurcharge: NPR(45_000) });
    const routine = await pf(env, O1, {}, 'routine');
    expect(routine).not.toHaveProperty('urgentSurcharge');
    expect('urgentSurcharge' in routine).toBe(false);
  });
  it('the surcharge is computed on the WINNING list price, not the default', { timeout: T }, async () => {
    expect(await pf(setup28b({ surcharge_rules: [pct(1, 5_000)] }), O1, { creditPartyId: P1.id }, 'urgent')).toMatchObject({ unitPrice: NPR(60_000), urgentSurcharge: NPR(30_000) });
  });
  it('AC-14.3: percent rounds half-up to the paisa (333 x 50 % = 166.5 -> 167; 331 -> 165.5 -> 166; 330 -> 165)', { timeout: T }, async () => {
    for (const [price, want] of [[333, 167], [331, 166], [330, 165]] as const) {
      const env = setup28b((w) => { w['surcharge_rules'] = [pct(1, 5_000)]; replace(w, 'price_list_items', (r) => r['orderable_id'] === O1.id && r['price_list_version_id'] === VD.id, item(40, VD, O1, price)); });
      expect((await pf(env, O1, {}, 'urgent')).urgentSurcharge, `${price}`).toEqual(NPR(want));
    }
  });
  it('a flat rule adds its amount_paisa; the amount is an integer', { timeout: T }, async () => {
    const q = await pf(setup28b({ surcharge_rules: [srule(1, A, { scope: 'all', amount_kind: 'flat', amount_paisa: 25_000 })] }), O1, {}, 'urgent');
    expect(q.urgentSurcharge).toEqual(NPR(25_000));
    expect(Number.isSafeInteger(q.urgentSurcharge.amountPaisa)).toBe(true);
  });
  it('AC-14.2 specificity: orderable rule > department rule > all-tests rule', { timeout: T }, async () => {
    const all = srule(1, A, { scope: 'all', amount_kind: 'flat', amount_paisa: 1_000 });
    const d = pct(2, 5_000);
    const o = srule(3, A, { scope: 'orderable', orderable_id: O1.id, amount_kind: 'flat', amount_paisa: 12_345 });
    expect((await pf(setup28b({ surcharge_rules: [all] }), O1, {}, 'urgent')).urgentSurcharge).toEqual(NPR(1_000));
    expect((await pf(setup28b({ surcharge_rules: [all, d] }), O1, {}, 'urgent')).urgentSurcharge).toEqual(NPR(45_000));
    expect((await pf(setup28b({ surcharge_rules: [all, d, o] }), O1, {}, 'urgent')).urgentSurcharge).toEqual(NPR(12_345));
    expect((await pf(setup28b({ surcharge_rules: [o, d, all] }), O2, {}, 'urgent')).urgentSurcharge, 'FBS: only the all-rule matches').toEqual(NPR(1_000));
  });
  it('AC-14.2 list scope: a rule scoped to the winning list beats an unscoped one of the same specificity; a rule scoped to another list does not apply', { timeout: T }, async () => {
    const rules = [pct(1, 5_000), pct(2, 3_000, { price_list_id: PRT.id }), pct(3, 9_000, { price_list_id: CEN.id })];
    expect((await pf(setup28b({ surcharge_rules: rules }), O1, { creditPartyId: P1.id }, 'urgent')).urgentSurcharge).toEqual(NPR(18_000));      // 60000 x 30 %
    expect((await pf(setup28b({ surcharge_rules: rules }), O1, {}, 'urgent')).urgentSurcharge).toEqual(NPR(45_000));                           // default list: unscoped only
  });
  it('AC-14.4 / contract (7): urgent with no matching rule = no surcharge, NOT an error (other department, expired, future, inactive, none)', { timeout: T }, async () => {
    const none = await pf(setup28b(), O1, {}, 'urgent');
    expect(none).toMatchObject({ unitPrice: NPR(90_000) }); expect(none).not.toHaveProperty('urgentSurcharge');
    for (const r of [pct(1, 5_000, { department_id: D2.id }), pct(1, 5_000, { effective_from: T3 }), pct(1, 5_000, { effective_to: NOW }), pct(1, 5_000, { is_active: false })]) {
      expect(await pf(setup28b({ surcharge_rules: [r] }), O1, {}, 'urgent'), JSON.stringify(r)).not.toHaveProperty('urgentSurcharge');
    }
    expect(await pf(setup28b({ surcharge_rules: [pct(1, 5_000, { effective_to: NOW })] }), O1, {}, 'urgent', iso(new Date(NOW.getTime() - 1)))).toHaveProperty('urgentSurcharge');
  });
  it("a panel without a department never matches a department rule; a package uses its own department_id", { timeout: T }, async () => {
    expect(await pf(setup28b({ surcharge_rules: [pct(1, 5_000)] }), O3, {}, 'urgent')).not.toHaveProperty('urgentSurcharge');
    const priced = setup28b((w) => { w['surcharge_rules'] = [pct(1, 5_000)]; w['price_list_items']!.push(item(50, VD, O4, 10_000)); });
    expect((await pf(priced, O4, {}, 'urgent')).urgentSurcharge).toEqual(NPR(5_000));
  });
  it('a surcharge rule of another tenant never applies', { timeout: T }, async () => {
    expect(await pf(setup28b({ surcharge_rules: [srule(7, TENANT_B, { scope: 'all', amount_kind: 'flat', amount_paisa: 77_777 })] }), O1, {}, 'urgent')).not.toHaveProperty('urgentSurcharge');
  });
});

describe('tax (contract 17, 18; AC-15.1, AC-15.3, 08 R18: rates are data owned by C3)', () => {
  it('AC-15.1: tenant default exempt + orderable rule taxable for FBS: FBS taxable with vatRateBp 1300, CBC exempt without a rate', { timeout: T }, async () => {
    const env = setup28b({ tax_rules: [trule(2, A, { scope: 'orderable', orderable_id: O2.id, vat_treatment: 'taxable' })] });
    expect((await pf(env, O2)).tax).toEqual({ vat: 'taxable', vatRateBp: 1300 });
    const cbc = (await pf(env, O1)).tax;
    expect(cbc).toEqual({ vat: 'exempt' }); expect(cbc).not.toHaveProperty('vatRateBp');
  });
  it('contract (17): a taxable quote returns vatRateBp = 1300', { timeout: T }, async () => {
    const q = await pf(setup28b((w) => { w['tax_rules'] = [trule(1, A, { vat_treatment: 'taxable' })]; }), O1);
    expect([q.tax.vat, q.tax.vatRateBp]).toEqual(['taxable', 1300]);
  });
  it('rule precedence: orderable > department > tenant default; a panel without a department skips the department rule', { timeout: T }, async () => {
    const dep = trule(2, A, { scope: 'department', department_id: D1.id, vat_treatment: 'taxable' });
    const exOrd = trule(3, A, { scope: 'orderable', orderable_id: O1.id, vat_treatment: 'exempt' });
    expect((await pf(setup28b({ tax_rules: [dep] }), O1)).tax.vat).toBe('taxable');
    expect((await pf(setup28b({ tax_rules: [dep, exOrd] }), O1)).tax.vat).toBe('exempt');
    expect((await pf(setup28b({ tax_rules: [dep] }), O3)).tax.vat).toBe('exempt');
    expect((await pf(setup28b({ tax_rules: [dep] }), O2)).tax.vat).toBe('exempt');
  });
  it('contract (18) / AC-15.3: no tenant-default rule -> catalog.tax_config_missing 422 (never an assumed "exempt")', { timeout: T }, async () => {
    const e = await errOf(pf(setup28b((w) => { w['tax_rules'] = []; }), O1));
    expect([e.code, e.statusCode]).toEqual(['catalog.tax_config_missing', 422]);
  });
  it('AC-15.3: only an ENDED / inactive / not-yet-effective default counts as none; another tenant\'s default does not count', { timeout: T }, async () => {
    for (const o of [{ effective_to: T1 }, { is_active: false }, { effective_from: T3 }]) {
      expect(await codeOf(pf(setup28b((w) => { w['tax_rules'] = [trule(1, A, o), trule(9, TENANT_B)]; }), O1)), JSON.stringify(o)).toBe('catalog.tax_config_missing');
    }
  });
  it('a department / orderable rule alone (no tenant default) still leaves other orderables at tax_config_missing', { timeout: T }, async () => {
    const env = setup28b((w) => { w['tax_rules'] = [trule(2, A, { scope: 'orderable', orderable_id: O2.id, vat_treatment: 'exempt' })]; });
    expect((await pf(env, O2)).tax).toEqual({ vat: 'exempt' });
    expect(await codeOf(pf(env, O1))).toBe('catalog.tax_config_missing');
  });
  it('the VAT rate comes from the g_tax_types row, not a constant; taxable with no VAT row -> tax_config_missing', { timeout: T }, async () => {
    const taxable = (w: Record<string, Row[]>) => { w['tax_rules'] = [trule(1, A, { vat_treatment: 'taxable' })]; };
    expect((await pf(setup28b((w) => { taxable(w); w['g_tax_types'] = [{ ...VAT_ROW, rate_bp: 1400 }]; }, { noVat: true }), O1)).tax).toEqual({ vat: 'taxable', vatRateBp: 1400 });
    expect(await codeOf(pf(setup28b(taxable, { noVat: true }), O1))).toBe('catalog.tax_config_missing');
  });
  it('other tax + hsCode: rate of the cs_tax_types version effective at `at` (a rate change = a new version, 08 R18)', { timeout: T }, async () => {
    const env = setup28b((w) => {
      w['tax_rules'] = [trule(1, A), trule(2, A, { scope: 'orderable', orderable_id: O2.id, other_tax_code: 'HST', hs_code: '9018' })];
      w['cs_tax_types'] = [ttype(1, A, 'HST', { rate_bp: 500, effective_to: T1 }), ttype(2, A, 'HST', { rate_bp: 700, effective_from: T1 })];
    });
    expect((await pf(env, O2)).tax).toEqual({ vat: 'exempt', otherTaxCode: 'HST', otherTaxRateBp: 700, hsCode: '9018' });
    expect((await pf(env, O2, {}, 'routine', iso(new Date(T1.getTime() - 1)))).tax).toEqual({ vat: 'exempt', otherTaxCode: 'HST', otherTaxRateBp: 500, hsCode: '9018' });
  });
  it('AC-15.2 (read side): an other-tax whose type has no usable rate at `at` (none effective / rate NULL / inactive / absent) -> tax_config_missing, never a quote without the rate', { timeout: T }, async () => {
    for (const types of [[ttype(1, A, 'HST', { effective_from: T3 })], [ttype(1, A, 'HST', { rate_bp: null })], [ttype(1, A, 'HST', { is_active: false })], []]) {
      const env = setup28b((w) => { w['tax_rules'] = [trule(1, A), trule(2, A, { scope: 'orderable', orderable_id: O2.id, other_tax_code: 'HST' })]; w['cs_tax_types'] = types; });
      expect(await codeOf(pf(env, O2))).toBe('catalog.tax_config_missing');
    }
  });
  it('0 % is a configured rate: otherTaxRateBp 0 is returned, not dropped', { timeout: T }, async () => {
    const env = setup28b((w) => { w['tax_rules'] = [trule(1, A, { other_tax_code: 'ZR' })]; w['cs_tax_types'] = [ttype(1, A, 'ZR', { rate_bp: 0 })]; });
    expect((await pf(env, O1)).tax).toEqual({ vat: 'exempt', otherTaxCode: 'ZR', otherTaxRateBp: 0 });
  });
  it('error precedence for one orderable: not_found before no_price before tax_config_missing', { timeout: T }, async () => {
    const env = setup28b((w) => { w['tax_rules'] = []; });
    expect(await codeOf(pf(env, { id: GHOST } as Row))).toBe('common.not_found');
    expect(await codeOf(pf(env, O4))).toBe('catalog.no_price');
    expect(await codeOf(pf(env, O1))).toBe('catalog.tax_config_missing');
  });
});

describe('input validation at the port boundary (trust boundary: C4 passes user-derived ids) — common.validation_failed 400, nothing echoed', () => {
  const bad = async (q: unknown) => { const env = setup28b(); const e = await errOf(priceFor(env, q)); expect([e.code, e.statusCode]).toEqual(['common.validation_failed', 400]); expect(env.db.writes).toEqual([]); return e; };
  it.each([
    ['orderableId not a uuid', { ...query(O1.id as string), orderableId: 'not-a-uuid' }],
    ['orderableId missing', { context: {}, priority: 'routine', at: iso(NOW) }],
    ['orderableId a SQL string', { ...query(O1.id as string), orderableId: "x' OR '1'='1" }],
    ['priority STAT', { ...query(O1.id as string), priority: 'STAT' }],
    ['priority missing', { orderableId: O1.id, context: {}, at: iso(NOW) }],
    ['context missing', { orderableId: O1.id, priority: 'routine', at: iso(NOW) }],
    ['context null', { ...query(O1.id as string), context: null }],
    ['priceListId not a uuid', { ...query(O1.id as string, { priceListId: 'x' }) }],
    ['creditPartyId not a uuid', { ...query(O1.id as string, { creditPartyId: 12 }) }],
    ['referrerId a SQL string', { ...query(O1.id as string, { referrerId: "'; DROP TABLE catalog.price_lists;--" }) }],
    ['centreId not a uuid', { ...query(O1.id as string, { centreId: '' }) }],
    ['at not an instant', { ...query(O1.id as string), at: 'yesterday' }],
    ['at a date only', { ...query(O1.id as string), at: '2026-11-07' }],
    ['at without offset', { ...query(O1.id as string), at: '2026-11-07T12:00:00' }],
    ['at a number', { ...query(O1.id as string), at: 1_700_000_000 }],
    ['at missing', { orderableId: O1.id, context: {}, priority: 'routine' }],
  ])('%s', { timeout: T }, async (_n, q) => { await bad(q); });
  it.each([null, undefined, 'x', 5, []])('a non-object query (%s)', { timeout: T }, async (q) => { await bad(q); });
  it('errors never echo a submitted value', { timeout: T }, async () => {
    const e = await bad({ ...query(O1.id as string), orderableId: 'SECRET-CANARY-77' });
    expect(JSON.stringify({ m: e.message, d: e.detail, errors: e.errors })).not.toContain('SECRET-CANARY-77');
  });
  it('REQ-SEC-046: a client-supplied price/tax/tenant in the query is never used — either ignored or rejected 400, the answer is never the client value', { timeout: T }, async () => {
    const env = setup28b();
    for (const extra of [{ unitPrice: NPR(1) }, { tax: { vat: 'taxable', vatRateBp: 9_999 } }, { tenantId: TENANT_B }, { urgentSurcharge: NPR(1) }]) {
      const out = await priceFor(env, { ...query(O1.id as string), ...extra }).then((q) => q, (e) => e);
      if (out instanceof Error) { expect(out).toMatchObject({ code: expect.stringMatching(/^common\.(validation_failed|unknown_field)$/) }); continue; }
      expect(out).toEqual({ orderableId: O1.id, priceListId: DEF.id, priceListVersion: 1, source: 'tenant_default', unitPrice: NPR(90_000), tax: { vat: 'exempt' } });
    }
  });
});

describe('read-only, tenant-scoped, bind-only, revision-keyed (REQ-SEC-046, S-1, S-6, 02-TRD §6.3) and concurrency', () => {
  it('priceFor writes nothing, publishes nothing, takes no lock and leaves the catalog revision untouched', { timeout: T }, async () => {
    const env = setup28b({ surcharge_rules: [srule(1, A, { scope: 'all', amount_kind: 'flat', amount_paisa: 5_000 })] });
    await pf(env, O1, { creditPartyId: P1.id, referrerId: DOC1.id, centreId: C2.id }, 'urgent');
    await codeOf(pf(env, O4));
    await codeOf(pf(env, O1, { priceListId: GHOST }));
    expect(env.db.writes).toEqual([]);
    expect(env.db.price.events).toHaveLength(0);
    expect(env.db.price.revisionOf(A)).toBe(417);
    expect(env.db.stmts.filter((s) => /\bFOR\s+(UPDATE|SHARE)\b/i.test(s.text))).toEqual([]);
  });
  it('every statement on a tenant table filters on tenant_id with the caller tenant bound; ids / codes are binds, never SQL text', { timeout: T }, async () => {
    const env = setup28b({ surcharge_rules: [srule(1, A, { scope: 'all', amount_kind: 'flat', amount_paisa: 5_000 })] });
    await pf(env, O1, { priceListId: EXP.id, creditPartyId: P1.id, referrerId: DOC2.id, centreId: C2.id }, 'urgent');
    const tenantTables = /catalog\.(price_lists|price_list_assignments|price_list_versions|price_list_items|orderables|doctors|credit_parties|surcharge_rules|tax_rules|cs_tax_types)\b|core\.collection_centres/i;
    const mine = env.db.stmts.filter((x) => tenantTables.test(x.text));
    expect(mine.length).toBeGreaterThan(0);
    for (const x of mine) {
      expect(/^\s*SELECT\b/i.test(x.text), x.text).toBe(true);
      expect(/\btenant_id\b/i.test(x.text), x.text).toBe(true);
      expect(x.values, x.text).toContain(A);
      for (const id of [O1.id, EXP.id, P1.id, DOC2.id, C2.id, A]) expect(x.text, 'literal id in SQL text').not.toContain(String(id));
    }
  });
  it('the revision is read at most once per request, with exactly the §6.3 statement, even for several priceFor calls on one ctx', { timeout: T }, async () => {
    const env = setup28b();
    await call(env, async (p, ctx) => { await p['priceFor']!(ctx, query(O1.id as string)); await p['priceFor']!(ctx, query(O2.id as string)); await p['priceFor']!(ctx, query(O1.id as string, { centreId: C2.id })); });
    const reads = env.db.stmts.filter((s) => /FROM\s+catalog\.catalog_state/i.test(s.text));
    expect(reads.length).toBeLessThanOrEqual(1);
    for (const r of reads) { expect(r.text.replace(/\s+/g, ' ').trim()).toBe('SELECT catalog_revision FROM catalog.catalog_state WHERE tenant_id = $1'); expect(r.values).toEqual([A]); }
  });
  it('a request costs a bounded number of statements (no per-list / per-rule N+1) — priceFor on the full context <= 25', { timeout: T }, async () => {
    const env = setup28b({ surcharge_rules: [pct(1, 5_000)] });
    const before = env.db.stmts.length;
    await pf(env, O1, { priceListId: EXP.id, creditPartyId: P1.id, referrerId: DOC1.id, centreId: C2.id }, 'urgent');
    expect(env.db.stmts.length - before).toBeLessThanOrEqual(25);
  });
  it('a committed price-list change + revision bump is visible to the NEXT request through the same warm cache (cache key = revision)', { timeout: T }, async () => {
    const env = setup28b();
    expect((await pf(env, O2, { creditPartyId: P1.id })).source).toBe('tenant_default');          // H lacks FBS, falls_through = true
    await setFallsThrough(env, PRT.id as string, false);
    expect(env.db.price.revisionOf(A)).toBe(418);
    expect(await codeOf(pf(env, O2, { creditPartyId: P1.id }))).toBe('catalog.no_price');          // now closed
    await setFallsThrough(env, PRT.id as string, true);
    expect((await pf(env, O2, { creditPartyId: P1.id })).source).toBe('tenant_default');
  });
  it('20 concurrent requests in separate transactions agree (no shared mutable state, deterministic)', { timeout: T }, async () => {
    const env = setup28b({ surcharge_rules: [pct(1, 5_000)] });
    const run = () => Promise.all([pf(env, O1, { creditPartyId: P1.id, centreId: C2.id }, 'urgent'), pf(env, O2, { creditPartyId: P1.id }), codeOf(pf(env, O4)), codeOf(priceFor(env, query(O1.id as string), { tenantId: TENANT_B }))]);
    const runs = await Promise.all(Array.from({ length: 20 }, run));
    for (const r of runs) expect(r).toEqual(runs[0]);
    expect(runs[0]![0]).toMatchObject({ source: 'credit_party', urgentSurcharge: NPR(30_000) });
    expect(runs[0]!.slice(2)).toEqual(['catalog.no_price', 'common.not_found']);
  });
  it('a dependency failure (SQL error) surfaces as an error — never as a partial / zero price', { timeout: T }, async () => {
    for (const table of [/price_list_items/i, /price_list_versions/i, /tax_rules/i]) {
      const env = setup28b();
      env.db.price.fail(table); env.db.tax.fail(table);            // fakes keep an injected failure for the life of the env
      const e = await pf(env, O1).then(() => undefined, (x: unknown) => x);
      expect(e, String(table)).toBeInstanceOf(Error);
      expect(e, `${table}: a crash is not a failure path`).not.toBeInstanceOf(TypeError);
    }
  });
});
