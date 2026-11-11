// FD-T05 Quote F8 (quoteRegistration): US-FD-05.1-2, US-FD-06.1-3, US-FD-14.1 (SMS is registration-time: only the "no write, no PHI" half applies to a quote),
// 02-TRD §5.1 F8 / Quote schema, 03-APP-FLOW §2.2, 07-SECURITY REQ-SEC-046 (server-side prices + fingerprint), tenant isolation (07 §isolation matrix, F8 row).
// Ports are the real fakes (packages/fakes): CatalogPort price precedence 03-IC §4.2 / C3 AC-13.1, BillingCommandPort computeQuote (contract case 1, 12).
// LD-75 / LD-70 do not apply to this file (no BL-T22 probe, no pending.json edit).
import { beforeAll, describe, expect, it } from 'vitest';
import { CENTRE, CP, DEPT, ID, O, PRICE_LIST, REFERRER, T, TENANT_A, TENANT_B, bill, draft, fp, line, orderableLines, quote, quoteFails, schemaErrors, seedLimits, uid, world } from './helpers.js';

beforeAll(seedLimits, T);
const money = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const lineOf = (r: { body: any }, orderable: string, kind = 'orderable') => (r.body.lines as any[]).find((l) => l.orderable_id === orderable && l.kind === kind);

describe('shape, pricing from the catalog, taxes via BillingCommandPort.computeQuote', () => {
  it('returns 200 with a body that satisfies the Quote schema, lines priced by C3 and taxes by the fake', async () => {
    const r = await quote(draft());
    expect(r.status).toBe(200);
    expect(schemaErrors('Quote', r.body)).toEqual([]);
    const [cbc, glu] = orderableLines(r);
    expect(cbc).toMatchObject({ orderable_id: O.cbc, orderable_kind: 'test', code: 'CBC', name: 'Complete Blood Count', priority: 'routine', kind: 'orderable',
      unit_price: money(50000), discount: money(0), exempt: money(50000), taxable: money(0), vat: money(0), other_tax: money(0), net: money(50000),
      price_source: 'tenant_default', price_list_id: PRICE_LIST.a.td, price_list_version: 1 });
    expect(glu).toMatchObject({ orderable_id: O.glu, unit_price: money(20000), taxable: money(20000), exempt: money(0), vat: money(2600), net: money(22600) });
    expect(r.body.totals).toEqual({ gross: money(70000), discount: money(0), exempt: money(50000), taxable: money(20000), vat: money(2600), other_tax: money(0), net: money(72600) });
    expect(r.body.fiscal_year_bs).toBe('2083/84');                                    // 2026-11-10 A.D. is in B.S. FY 2083/84 (starts Shrawan 1)
    expect(r.body.discount_evaluation).toEqual({ within_limit: true, approval_required: false, limit_percent_bp: 1000, limit_paisa: 0 });
    expect(r.body).not.toHaveProperty('credit_status');                               // present iff billing_mode = credit
  }, T);

  it('catalog_revision comes from CatalogPort.resolveOrderables', async () => {
    expect((await quote(draft(), { w: world({ catalogRevision: 7 }) })).body.catalog_revision).toBe(7);
  }, T);

  it('other tax: other_tax and other_tax_code come from the C3 rule + rate carried on the priced line', async () => {
    const r = await quote(draft({ items: [{ orderable_id: O.ure }] }));
    expect(lineOf(r, O.ure)).toMatchObject({ unit_price: money(15000), other_tax: money(300), other_tax_code: 'SC', vat: money(0), net: money(15300) });
  }, T);

  it('a panel is priced as ONE orderable (not per member test): code and name from getPanel', async () => {
    const w = world();
    const r = await quote(draft({ items: [{ orderable_id: O.anaemia }] }), { w });
    expect(orderableLines(r)).toHaveLength(1);
    expect(orderableLines(r)[0]).toMatchObject({ orderable_kind: 'panel', code: 'ANAEMIA', name: 'Anaemia Panel', unit_price: money(65000) });
    expect((w.catalog as any).calls('priceFor').map((c: any) => c.input.orderableId)).toEqual([O.anaemia]);
  }, T);

  it('department is passed to the billing port only when all member tests share one (03-APP-FLOW §2.2 step 4)', async () => {
    const w = world();
    await quote(draft({ items: [{ orderable_id: O.cbc }, { orderable_id: O.anaemia }] }), { w });
    const lines = (w.billingFake as any).calls('computeQuote')[0].input.lines;
    expect(lines.find((l: any) => l.orderableId === O.cbc).departmentId).toBe(DEPT.haem);
    expect(lines.find((l: any) => l.orderableId === O.anaemia).departmentId).toBeUndefined();   // CBC (HAEM) + glucose (BIO)
  }, T);

  it('calls priceFor once per orderable with the draft context and an ISO "at"; SELF referrer = no referrerId; cash = no creditPartyId', async () => {
    const w = world();
    await quote(draft({ visit_type: 'ipd' }), { w });
    const calls = (w.catalog as any).calls('priceFor').map((c: any) => c.input);
    expect(calls.map((c: any) => c.orderableId).sort()).toEqual([O.cbc, O.glu].sort());
    for (const c of calls) {
      expect(c.context.centreId).toBe(CENTRE.a);
      expect(c.context).not.toHaveProperty('referrerId');
      expect(c.context).not.toHaveProperty('creditPartyId');
      expect(c.priority).toBe('routine');
      expect(c.at).toBe('2026-11-10T06:00:00.000Z');
    }
  }, T);
});

describe('price precedence (C3 AC-13.1: credit_party > referrer > centre > tenant_default), CatalogPort fake fixtures', () => {
  const cbc = async (d: Record<string, unknown>, w: ReturnType<typeof world>) => { const r = await quote(draft({ items: [{ orderable_id: O.cbc }], ...d }), { w }); return lineOf(r, O.cbc); };
  const all = { centreList: true, referrerList: true, creditList: true };

  it('none -> tenant_default 500.00', async () => {
    expect(await cbc({}, world())).toMatchObject({ price_source: 'tenant_default', unit_price: money(50000), price_list_id: PRICE_LIST.a.td });
  }, T);
  it('centre list -> centre 480.00 (draft centre)', async () => {
    expect(await cbc({}, world({ centreList: true }))).toMatchObject({ price_source: 'centre', unit_price: money(48000), price_list_id: PRICE_LIST.a.centre });
  }, T);
  it('referrer + centre -> referrer 450.00', async () => {
    expect(await cbc({ referrer_id: REFERRER }, world({ centreList: true, referrerList: true }))).toMatchObject({ price_source: 'referrer', unit_price: money(45000) });
  }, T);
  it('credit party + referrer + centre -> credit_party 400.00 (credit mode)', async () => {
    expect(await cbc({ billing_mode: 'credit', credit_party_id: CP.ok, referrer_id: REFERRER }, world(all))).toMatchObject({ price_source: 'credit_party', unit_price: money(40000), price_list_id: PRICE_LIST.a.credit });
  }, T);
  it('credit party without its own list falls through to the next list (referrer)', async () => {
    const w = world(all);
    expect(await cbc({ billing_mode: 'credit', credit_party_id: CP.over, referrer_id: REFERRER }, w)).toMatchObject({ price_source: 'referrer', unit_price: money(45000) });
  }, T);
  it('credit mode passes creditPartyId and referrerId to priceFor', async () => {
    const w = world(all);
    await cbc({ billing_mode: 'credit', credit_party_id: CP.ok, referrer_id: REFERRER }, w);
    expect((w.catalog as any).calls('priceFor')[0].input.context).toMatchObject({ creditPartyId: CP.ok, referrerId: REFERRER, centreId: CENTRE.a });
  }, T);
});

describe('US-FD-05 urgent', () => {
  it('05.1 urgent item with a surcharge rule -> extra line kind urgent_surcharge (orderable line + surcharge line, both priority urgent)', async () => {
    const r = await quote(draft({ items: [{ orderable_id: O.cbc, priority: 'urgent' }] }));
    const [main, sur] = [lineOf(r, O.cbc), lineOf(r, O.cbc, 'urgent_surcharge')];
    expect(main).toMatchObject({ priority: 'urgent', unit_price: money(50000) });
    expect(sur).toMatchObject({ priority: 'urgent', kind: 'urgent_surcharge', unit_price: money(10000), net: money(10000) });
    expect(r.body.totals.gross).toEqual(money(60000));
    expect(schemaErrors('Quote', r.body)).toEqual([]);
  }, T);
  it('05.2 urgent item with no surcharge rule -> urgent, no surcharge line', async () => {
    const r = await quote(draft({ items: [{ orderable_id: O.glu, priority: 'urgent' }] }));
    expect(r.body.lines).toHaveLength(1);
    expect(r.body.lines[0]).toMatchObject({ orderable_id: O.glu, priority: 'urgent', kind: 'orderable' });
  }, T);
  it('order priority urgent is the default for items; an item priority overrides it either way', async () => {
    const a = await quote(draft({ priority: 'urgent', items: [{ orderable_id: O.cbc }, { orderable_id: O.glu, priority: 'routine' }] }));
    expect(lineOf(a, O.cbc).priority).toBe('urgent');
    expect(lineOf(a, O.cbc, 'urgent_surcharge')).toBeDefined();
    expect(lineOf(a, O.glu).priority).toBe('routine');
    const b = await quote(draft({ priority: 'routine', items: [{ orderable_id: O.cbc, priority: 'urgent' }] }));
    expect(lineOf(b, O.cbc, 'urgent_surcharge')).toBeDefined();
  }, T);
  it('priority is passed to priceFor per item; the billing port gets the surcharge only for an urgent line that has one', async () => {
    const w = world();
    await quote(draft({ items: [{ orderable_id: O.cbc, priority: 'urgent' }, { orderable_id: O.glu, priority: 'urgent' }] }), { w });
    const prio = Object.fromEntries((w.catalog as any).calls('priceFor').map((c: any) => [c.input.orderableId, c.input.priority]));
    expect(prio).toEqual({ [O.cbc]: 'urgent', [O.glu]: 'urgent' });
    const lines = (w.billingFake as any).calls('computeQuote')[0].input.lines;
    expect(lines.find((l: any) => l.orderableId === O.cbc).urgentSurcharge).toEqual({ amountPaisa: 10000, currency: 'NPR' });
    expect(lines.find((l: any) => l.orderableId === O.glu).urgentSurcharge).toBeUndefined();
  }, T);
  it('a routine item never carries a surcharge even though the catalog has one', async () => {
    const r = await quote(draft({ items: [{ orderable_id: O.cbc, priority: 'routine' }] }));
    expect(lineOf(r, O.cbc, 'urgent_surcharge')).toBeUndefined();
  }, T);
});

describe('US-FD-06 discounts: allocation, evaluation against the tenant limits', () => {
  const D = async (discounts: unknown[], o: Parameters<typeof quote>[1] = {}, d: Record<string, unknown> = {}) => quote(draft({ discounts, ...d }), o);
  const ev = (r: { body: any }) => r.body.discount_evaluation;

  it('06.1 5 % bill discount (self-limit 10 %): pro-rata over the lines, within_limit, approval not required', async () => {
    const r = await D([bill({ kind: 'percent', percent_bp: 500, reason_text: 'synthetic' })]);
    expect(r.body.totals.discount).toEqual(money(3500));
    expect(lineOf(r, O.cbc).discount).toEqual(money(2500));     // 3500 x 50000 / 70000 exactly
    expect(lineOf(r, O.glu).discount).toEqual(money(1000));
    expect(ev(r)).toEqual({ within_limit: true, approval_required: false, limit_percent_bp: 1000, limit_paisa: 0 });
    expect(schemaErrors('Quote', r.body)).toEqual([]);
  }, T);

  it('allocation conserves the paisa: line discounts sum to totals.discount, no line goes below zero, net adds up', async () => {
    const r = await D([bill({ kind: 'amount', amount_paisa: 1001 })], {}, { items: [{ orderable_id: O.cbc }, { orderable_id: O.glu }, { orderable_id: O.ure }] });
    const ls = r.body.lines as any[];
    expect(r.body.totals.discount.amount_paisa).toBe(1001);
    expect(sum(ls.map((l) => l.discount.amount_paisa))).toBe(1001);
    for (const l of ls) { expect(l.discount.amount_paisa).toBeGreaterThanOrEqual(0); expect(l.discount.amount_paisa).toBeLessThanOrEqual(l.unit_price.amount_paisa); }
    expect(sum(ls.map((l) => l.net.amount_paisa))).toBe(r.body.totals.net.amount_paisa);
  }, T);

  it('a line discount lands on that line only (line scope, orderable_id) and is passed to the billing port with that line\'s line_ref', async () => {
    const w = world();
    const r = await D([line(O.glu, { kind: 'amount', amount_paisa: 2000 })], { w });
    expect(lineOf(r, O.glu).discount).toEqual(money(2000));
    expect(lineOf(r, O.cbc).discount).toEqual(money(0));
    const sent = (w.billingFake as any).calls('computeQuote')[0].input.discounts[0];
    expect(sent).toMatchObject({ scope: 'line', kind: 'amount', amountPaisa: 2000, lineRef: lineOf(r, O.glu).line_ref });
  }, T);

  it('kind decides which magnitude counts: {kind: amount, amount_paisa, percent_bp} ignores percent_bp (OpenAPI example shape)', async () => {
    const r = await D([bill({ kind: 'amount', amount_paisa: 100, percent_bp: 9999 })]);
    expect(r.body.totals.discount).toEqual(money(100));
    const w = world();
    await D([bill({ kind: 'percent', percent_bp: 500, amount_paisa: 99999999 })], { w });
    expect((w.billingFake as any).calls('computeQuote')[0].input.discounts[0]).toMatchObject({ scope: 'bill', kind: 'percent', percentBp: 500 });
  }, T);

  it('the evaluation uses the TOTAL discount (line + bill), not each discount alone', async () => {
    const one = await D([line(O.cbc, { kind: 'amount', amount_paisa: 5000 })]);                                   // 7.1 %
    expect(ev(one).approval_required).toBe(false);
    const both = await D([line(O.cbc, { kind: 'amount', amount_paisa: 5000 }), bill({ kind: 'amount', amount_paisa: 3000 })]);   // 8000 / 70000 = 11.4 %
    expect(both.body.totals.discount).toEqual(money(8000));
    expect(ev(both)).toMatchObject({ within_limit: false, approval_required: true });
    expect(lineOf(both, O.cbc).discount.amount_paisa).toBeGreaterThanOrEqual(5000);
  }, T);

  it.each([
    ['no discount', [], true],
    ['exactly the self limit (10.00 %) is within', [bill({ kind: 'percent', percent_bp: 1000 })], true],
    ['one paisa over the self limit (7001 / 70000)', [bill({ kind: 'amount', amount_paisa: 7001 })], false],
    ['30 % (limit 10 %, absolute max 50 %)', [bill({ kind: 'percent', percent_bp: 3000 })], false],
    ['exactly the absolute max (50 %) still only needs approval', [bill({ kind: 'percent', percent_bp: 5000 })], false],
  ] as const)('tenant A (percent-only limit): %s', async (_n, discounts, within) => {
    const r = await D([...discounts]);
    expect(ev(r)).toEqual({ within_limit: within, approval_required: !within, limit_percent_bp: 1000, limit_paisa: 0 });
  }, T);

  it.each([
    ['above the absolute max by one paisa (35001 / 70000)', [bill({ kind: 'amount', amount_paisa: 35001 })]],
    ['100 % bill discount', [bill({ kind: 'percent', percent_bp: 10000 })]],
    ['bill amount larger than the gross', [bill({ kind: 'amount', amount_paisa: 70001 })]],
  ] as const)('exceeds_limit -> 422 frontdesk.discount_exceeds_limit: %s', async (_n, discounts) => {
    const e = await quoteFails(draft({ discounts: [...discounts] }));
    expect(e.code).toBe('frontdesk.discount_exceeds_limit'); expect(e.statusCode).toBe(422);
  }, T);

  it('06.3 a line discount larger than the line amount -> 422 frontdesk.discount_exceeds_limit', async () => {
    const e = await quoteFails(draft({ discounts: [line(O.glu, { kind: 'amount', amount_paisa: 20001 })] }));
    expect(e.code).toBe('frontdesk.discount_exceeds_limit'); expect(e.statusCode).toBe(422);
    const p = await quoteFails(draft({ discounts: [line(O.glu, { kind: 'amount', amount_paisa: 15000 }), line(O.glu, { kind: 'amount', amount_paisa: 6000 })] }));
    expect(p.code, 'two line discounts on one line together exceed it').toBe('frontdesk.discount_exceeds_limit');
  }, T);

  it('06.2 a discount without reason_code -> 400 common.validation_failed with path /discounts/0/reason_code (schema and handler)', async () => {
    const bad = draft({ discounts: [{ scope: 'bill', kind: 'percent', percent_bp: 500 }] });
    expect(schemaErrors('RegistrationDraft', bad).some((m) => m.includes('reason_code'))).toBe(true);
    const e = await quoteFails(bad);
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
    expect((e.errors ?? []).map((x: any) => x.path)).toContain('/discounts/0/reason_code');
    expect((await quoteFails(draft({ discounts: [bill({ kind: 'percent', percent_bp: 500, reason_code: '' })] }))).code).toBe('common.validation_failed');
  }, T);

  it('a line discount for an orderable that is not in the draft -> 400 common.validation_failed', async () => {
    expect((await quoteFails(draft({ discounts: [line(O.ure, { kind: 'amount', amount_paisa: 100 })] }))).code).toBe('common.validation_failed');
  }, T);

  it('tenant B (limit 10 % AND NPR 50.00): the paisa cap also forces approval, boundary inclusive (US-FD-06 / 03-APP-FLOW §2.2 step 6)', async () => {
    const B = { tenant: TENANT_B };
    const base = { centre_id: CENTRE.b };
    const q = (discounts: unknown[]) => quote(draft({ ...base, discounts }), B);
    expect(ev(await q([bill({ kind: 'percent', percent_bp: 500 })]))).toEqual({ within_limit: true, approval_required: false, limit_percent_bp: 1000, limit_paisa: 5000 });   // 3500
    expect(ev(await q([bill({ kind: 'amount', amount_paisa: 5000 })])).within_limit).toBe(true);                                                          // = cap
    expect(ev(await q([bill({ kind: 'amount', amount_paisa: 5001 })]))).toMatchObject({ within_limit: false, approval_required: true });                 // 7.1 % but > NPR 50
    expect(ev(await q([bill({ kind: 'percent', percent_bp: 800 })])).approval_required).toBe(true);                                                       // 5600 > 5000
  }, T);
});

describe('fingerprints (REQ-SEC-046; 02-TRD §6.3: sha256 hex over lines + discounts + totals; base = same lines with discounts [])', () => {
  const HEX = /^[0-9a-f]{64}$/;

  it('stable: same draft -> same quote_fingerprint and base_fingerprint (64 hex), also across 20 parallel requests', async () => {
    const d = draft();
    const first = await quote(d);
    expect(first.body.quote_fingerprint).toMatch(HEX); expect(first.body.base_fingerprint).toMatch(HEX);
    const many = await Promise.all(Array.from({ length: 20 }, () => quote(d)));
    for (const r of many) { expect(fp(r)).toBe(fp(first)); expect(r.body.base_fingerprint).toBe(first.body.base_fingerprint); }
  }, T);

  it('stable across time (no timestamp in it), request key order, patient and request id', async () => {
    const d = draft({ discounts: [bill({ kind: 'percent', percent_bp: 500 })] });
    const a = await quote(d);
    const later = await quote(d, { now: new Date('2026-11-10T09:30:00.000Z') });
    expect(fp(later)).toBe(fp(a));
    const reordered = { items: d.items, discounts: [{ percent_bp: 500, kind: 'percent', reason_code: 'staff_family', scope: 'bill' }], billing_mode: d.billing_mode, visit_type: d.visit_type, centre_id: d.centre_id, patient: d.patient };
    expect(fp(await quote(reordered))).toBe(fp(a));
    expect(fp(await quote({ ...d, patient: { patient_id: uid() } }))).toBe(fp(a));
  }, T);

  it('the fingerprint is the billing port\'s, not a second hash: quote_fingerprint/base_fingerprint equal computeQuote().fingerprint/.baseFingerprint', async () => {
    const w = world();
    const r = await quote(draft({ discounts: [bill({ kind: 'percent', percent_bp: 500 })] }), { w });
    expect(w.results).toHaveLength(1);
    expect(r.body.quote_fingerprint).toBe(w.results[0].fingerprint);
    expect(r.body.base_fingerprint).toBe(w.results[0].baseFingerprint);
    expect(r.body.base_fingerprint).not.toBe(r.body.quote_fingerprint);
  }, T);

  it('base_fingerprint ignores discounts: it equals the quote_fingerprint of the same draft quoted with discounts []; without discounts both are equal', async () => {
    const plain = await quote(draft({ items: [{ orderable_id: O.cbc }, { orderable_id: O.glu }] }));
    const d = draft({ items: [{ orderable_id: O.cbc }, { orderable_id: O.glu }], discounts: [bill({ kind: 'percent', percent_bp: 3000 })] });
    const disc = await quote(d);
    expect(plain.body.base_fingerprint).toBe(fp(plain));
    expect(disc.body.base_fingerprint).toBe(fp(plain));
    expect(fp(disc)).not.toBe(fp(plain));
  }, T);

  it('changes when a price list changes between two quotes (US-FD-03.4 premise), when items, priority or discounts change', async () => {
    const d = draft();
    const v1 = await quote(d);
    const v2 = await quote(d, { w: world({ cbcPriceV2: 52000 }) });
    expect(lineOf(v2, O.cbc)).toMatchObject({ unit_price: money(52000), price_list_version: 2 });
    expect(fp(v2)).not.toBe(fp(v1)); expect(v2.body.base_fingerprint).not.toBe(v1.body.base_fingerprint);
    expect(fp(await quote(draft({ items: [{ orderable_id: O.cbc }] })))).not.toBe(fp(v1));
    expect(fp(await quote(draft({ items: [{ orderable_id: O.cbc, priority: 'urgent' }, { orderable_id: O.glu }] })))).not.toBe(fp(v1));
    expect(fp(await quote(draft({ discounts: [bill({ kind: 'amount', amount_paisa: 1 })] })))).not.toBe(fp(v1));
    expect(fp(await quote(draft({ discounts: [bill({ kind: 'amount', amount_paisa: 2 })] })))).not.toBe(fp(await quote(draft({ discounts: [bill({ kind: 'amount', amount_paisa: 1 })] }))));
  }, T);
});

describe('credit status (TRD Quote.credit_status; US-FD-04.2 "the quote already shows the state")', () => {
  const credit = (party: string, items = [{ orderable_id: O.cbc }]) => draft({ billing_mode: 'credit', credit_party_id: party, items });
  it.each([
    ['active account within the limit', CP.ok, 'ok'],
    ['locked account', CP.locked, 'locked'],
    ['party with allowsCredit = false (port reports credit_party_locked)', CP.noCredit, 'locked'],
    ['projected outstanding above the limit', CP.over, 'over_limit'],
  ])('%s -> 200 with credit_status.state %s (the quote does not fail)', async (_n, party, state) => {
    const r = await quote(credit(party as string));
    expect(r.status).toBe(200);
    expect(r.body.credit_status).toEqual({ state });
    expect(schemaErrors('Quote', r.body)).toEqual([]);
  }, T);
  it('asks BillingCommandPort.assertCreditAllowed with the party and additional = totals.net (after discounts); cash never asks', async () => {
    const w = world();
    const r = await quote(draft({ billing_mode: 'credit', credit_party_id: CP.ok, discounts: [bill({ kind: 'amount', amount_paisa: 1000 })] }), { w });
    const calls = (w.billingFake as any).calls('assertCreditAllowed');
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({ creditPartyId: CP.ok, additional: { amountPaisa: r.body.totals.net.amount_paisa } });
    const cash = world();
    await quote(draft(), { w: cash });
    expect((cash.billingFake as any).calls('assertCreditAllowed')).toHaveLength(0);
  }, T);
  it('credit mode without credit_party_id -> 400 common.validation_failed (US-FD-04.3)', async () => {
    const e = await quoteFails(draft({ billing_mode: 'credit' }));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
  }, T);
  it('a credit party of another tenant -> 404 common.not_found, not a "locked" answer that would confirm it exists', async () => {
    expect((await quoteFails(credit(CP.tenantB))).code).toBe('common.not_found');
  }, T);
});

describe('errors from the ports propagate unchanged (08 R18)', () => {
  it('catalog.test_inactive (422), catalog.no_price, catalog.tax_config_missing', async () => {
    expect((await quoteFails(draft({ items: [{ orderable_id: O.lft }] }))).code).toBe('catalog.test_inactive');
    expect((await quoteFails(draft({ items: [{ orderable_id: O.cul }] }))).code).toBe('catalog.no_price');
    expect((await quoteFails(draft({ items: [{ orderable_id: O.cbc }, { orderable_id: O.taxMissing }] }))).code).toBe('catalog.tax_config_missing');
  }, T);
  it('whatever LimsError a port throws keeps its code (failNext)', async () => {
    const w = world(); (w.catalog as any).failNext('priceFor', 'catalog.no_price');
    expect((await quoteFails(draft(), { w })).code).toBe('catalog.no_price');
    const w2 = world(); (w2.billingFake as any).failNext('computeQuote', 'catalog.tax_config_missing');
    expect((await quoteFails(draft(), { w: w2 })).code).toBe('catalog.tax_config_missing');
  }, T);
});

describe('security (07-SECURITY F8 row, REQ-SEC-046)', () => {
  it('permission: only frontdesk.registration.create may quote (assertRole asked for it); other grants -> 403 auth.forbidden, ports untouched', async () => {
    const w = world();
    for (const grants of [[], ['frontdesk.patient.read'], ['frontdesk.order.read', 'billing.invoice.issue']]) {
      const e = await quoteFails(draft(), { grants, w });
      expect(e.code).toBe('auth.forbidden'); expect(e.statusCode).toBe(403);
    }
    expect((w.catalog as any).calls('priceFor')).toHaveLength(0);
    const ok = await quote(draft());
    expect(ok.probe.identity.calls.map((c) => c.permission)).toContain('frontdesk.registration.create');
  }, T);

  it('the client never sets a price: extra fields (unit_price, totals, quote_fingerprint, price_list_id) are ignored; the schema forbids them', async () => {
    const tampered = draft({ items: [{ orderable_id: O.cbc, unit_price: money(1), price_list_id: ID(9999), net: money(1) }], totals: { net: money(1) }, quote_fingerprint: 'a'.repeat(64) });
    expect(schemaErrors('RegistrationDraft', tampered).length).toBeGreaterThan(0);
    const r = await quote(tampered);
    expect(lineOf(r, O.cbc).unit_price).toEqual(money(50000));
    expect(r.body.totals.net).toEqual(money(50000));
    expect(r.body.quote_fingerprint).not.toBe('a'.repeat(64));
  }, T);

  it('a centre outside the actor\'s centre scope -> 404 common.not_found, no catalog/billing call', async () => {
    const w = world();
    const e = await quoteFails(draft({ centre_id: CENTRE.b }), { w });
    expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404);
    expect((w.catalog as any).calls('priceFor')).toHaveLength(0);
  }, T);

  it('tenant isolation: an orderable that exists only for tenant B is 404 for tenant A and its price never appears; tenant B sees its own', async () => {
    const e = await quoteFails(draft({ items: [{ orderable_id: O.tenantBOnly }] }));
    expect(e.code).toBe('common.not_found');
    expect(JSON.stringify({ c: e.code, d: e.detail, e: e.errors })).not.toContain('7000');
    const b = await quote(draft({ centre_id: CENTRE.b, items: [{ orderable_id: O.tenantBOnly }] }), { tenant: TENANT_B });
    expect(lineOf(b, O.tenantBOnly).unit_price).toEqual(money(7000));
  }, T);

  it('a quote performs no write at all (no txid assigned: no order, invoice, discount, approval, counter or audit row) and emits nothing', async () => {
    const r = await quote(draft({ discounts: [bill({ kind: 'percent', percent_bp: 500 })] }));
    expect(r.wrote).toBe(false);
    const cr = await quote(draft({ billing_mode: 'credit', credit_party_id: CP.ok }));
    expect(cr.wrote).toBe(false);
  }, T);

  it('repeating the same quote 5 times leaves no trace either (no number consumed, nothing to replay): every reply identical', async () => {
    const d = draft();
    const rs = await Promise.all(Array.from({ length: 5 }, () => quote(d)));
    for (const r of rs) { expect(r.wrote).toBe(false); expect(r.body).toEqual(rs[0]!.body); }
  }, T);

  it('PHI / identifiers never reach the log (buyer_pan, patient id) and failures do not echo the request', async () => {
    const pan = '987654321'; const pid = uid();
    const ok = await quote(draft({ patient: { patient_id: pid }, buyer_pan: pan }));
    const bad = await quoteFails(draft({ patient: { patient_id: pid }, buyer_pan: pan, items: [{ orderable_id: O.lft }] }));
    const all = JSON.stringify([ok.probe.logs, bad.detail, bad.errors, bad.message]);
    expect(all).not.toContain(pan); expect(all).not.toContain(pid);
  }, T);

  it('malformed bodies fail closed with 400 common.validation_failed, never a 500 or a quote', async () => {
    for (const body of [undefined, null, {}, draft({ items: [] }), draft({ items: Array.from({ length: 51 }, () => ({ orderable_id: O.cbc })) }),
      draft({ items: [{ orderable_id: 'not-a-uuid' }] }), draft({ billing_mode: 'barter' }), draft({ discounts: Array.from({ length: 21 }, () => bill({ kind: 'amount', amount_paisa: 1 })) }),
      draft({ discounts: [bill({ kind: 'percent', percent_bp: 10001 })] }), draft({ discounts: [bill({ kind: 'amount', amount_paisa: -5 })] })]) {
      const e = await quoteFails(body);
      expect(e.code, JSON.stringify(body)?.slice(0, 80)).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
    }
  }, T);
});
