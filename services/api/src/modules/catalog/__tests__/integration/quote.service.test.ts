// T-19 (C3) — quote engine `quotePrices` (#82) over the real services + the composite SQL fake in helpers/quoteDb.ts (price lists from T-17, surcharge / tax rows from T-18).
// Spec: 06-PLAN row T-19 (done_when: precedence x5, fall-through, effective windows, explicit inactive list -> not_found; unit matrix in domain/__tests__/priceMatch.test.ts);
//   01-PRD AC-13.1 (precedence + explicit), AC-13.2 (fall-through; draft-only list skipped), AC-13.3 (effective windows, priceListId / priceListVersion), AC-07.6 (package without own item -> no_price),
//         AC-14.1–14.4 (urgent surcharge: half-up, specificity, list scope, no rule = absent), AC-15.1 / 15.3 / 15.5 (tax: orderable rule, tenant default, no default -> tax_config_missing, successor rule);
//   02-TRD §5.2 row 82 (request / response), §7.4 (precedence, canonical referrer, inactive lists), §7.5, §7.6 (rates from rows: g_tax_types VAT, cs_tax_types versions effective at `at`);
//   contracts/openapi/catalog.yaml PriceQuoteRequest / PriceQuote / PriceQuoteError; 07-SECURITY REQ-SEC-046 (server-side prices, quote read-only), S-1 (tenant), S-5 (closed bodies), S-6 (binds only), AB-1, AB-10.
// SEAM expected from the writer — catalog/service/quote.service.ts:
//   createQuoteService(deps: { events?, identity? })  ->  { quotePrices(ctx, body): Promise<{ quotes: Array<PriceQuote | PriceQuoteError> }> }
//   body = the PriceQuoteRequest (snake_case: items[{orderable_id, priority}], context{price_list_id?, credit_party_id?, referrer_id?, centre_id?}, at?). `at` defaults to ctx.now().
//   quotes[i] answers items[i] (request order). PriceQuote = { orderable_id, price_list_id, price_list_version, source, unit_price:{amount_paisa,currency:'NPR'}, urgent_surcharge?:Money, tax:{vat, other_tax_code?, vat_rate_bp?, other_tax_rate_bp?, hs_code?} }
//   — absent optionals are OMITTED (never null). PriceQuoteError = { orderable_id, error_code } for: catalog.no_price, catalog.tax_config_missing, common.not_found (unknown / other-tenant orderable).
//   Context ids that are unknown, another tenant's, or (explicit list) INACTIVE fail the WHOLE request: LimsError common.not_found (404). Validation: LimsError 400 common.validation_failed / common.unknown_field.
//   Single-table SQL, tenant-scoped, binds only (quoteDb.ts dialect). The engine writes nothing and publishes nothing.
// Assumptions beyond the spec (a failure here may be a spec gap — see .orchestra/notes/C3.T-19-tests.md): per-item (not whole-request) errors for no_price / tax_config_missing / unknown orderable (SCR-15 rows);
//   whole-request 404 for a bad context id; existence of centre / party is checked by SQL on the tenant tables (as pricing.service ownersExist), not through ctx.core; ≤ 50 statements for a 50-item quote (no N+1).
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { createEvents } from '../../../../core/events/publish.js';
import { createQuoteService } from '../../service/quote.service.js';
import {
  READ, TENANT_A, TENANT_B, VAT_ROW, actorIdentity, centre, defaultList, dept, doc, makeQuoteDb, orderable, party, passign, pitem, plist, pver, srule, trule, ttype,
} from '../helpers/quoteDb.js';
import { type Row } from '../helpers/mastersDb.js';

const T = 20_000;
type Svc = { quotePrices: (ctx: any, body?: any) => Promise<{ quotes: any[] }> };
const A = TENANT_A;
const NOW = new Date(Date.UTC(2026, 10, 7, 12, 0, 0));
const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-06-01T00:00:00.000Z');
const T3 = new Date('2027-01-01T00:00:00.000Z');                     // after NOW: a scheduled version
const iso = (d: Date) => d.toISOString();
const money = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { expect(e, `crash: ${(e as Error)?.message}`).not.toBeInstanceOf(TypeError); return e; } throw new Error('expected rejection, got success'); };
const notFound = (e: any) => { expect(isLimsError(e, 'common.not_found'), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(404); };
const validation400 = (e: any, path?: string) => {
  expect(isLimsError(e), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(400); expect(['common.validation_failed', 'common.unknown_field']).toContain(e.code);
  if (path) { expect(e.code).toBe('common.validation_failed'); expect((e.errors ?? []).map((x: any) => x.path)).toContain(path); }
};

// ---- synthetic world (tenant A; B holds foreign data that must never surface) ---------------------------------------------------------------------
const D1 = dept(1, A); const D2 = dept(2, A); const DB_ = dept(9, TENANT_B);
const O1 = orderable(1, A, { code: 'CBC', kind: 'test', department_id: D1.id });
const O2 = orderable(2, A, { code: 'FBS', kind: 'test', department_id: D2.id });
const O3 = orderable(3, A, { code: 'LFT', kind: 'panel', department_id: null });
const O4 = orderable(4, A, { code: 'PKG', kind: 'panel', department_id: D1.id });            // a package: components priced, itself NOT
const OB = orderable(9, TENANT_B, { code: 'BSECRET', kind: 'test' });
const DOC1 = doc(1, A); const DOC2 = doc(2, A, { merged_into_id: DOC1.id, is_active: false }); const DOC3 = doc(3, A);
const P1 = party(1, A); const P2 = party(2, A); const C2 = centre(2, A); const C3 = centre(3, A);
const PB = party(9, TENANT_B); const CB = centre(9, TENANT_B);
const DEF = defaultList(1, A); const CEN = plist(2, A, { owner_kind: 'centre' }); const REF = plist(3, A, { owner_kind: 'referrer' });
const PRT = plist(4, A, { owner_kind: 'credit_party' }); const EXP = plist(5, A, { owner_kind: 'credit_party', code: 'EXPLICIT' });
const LB = defaultList(9, TENANT_B);
const ver = (n: number, list: Row, no: number, o: Row = {}) => pver(n, A, list.id as string, no, { status: 'published', effective_from: T0, ...o });
const item = (n: number, v: Row, o: Row, paisa: number) => pitem(n, A, v.id as string, o.id as string, paisa);
const [VD, VC, VR, VP, VE] = [ver(1, DEF, 1), ver(2, CEN, 1), ver(3, REF, 1), ver(4, PRT, 1), ver(5, EXP, 1)];
const VB = pver(9, TENANT_B, LB.id as string, 1, { status: 'published' });

const base = (): Record<string, Row[]> => ({
  departments: [D1, D2, DB_], orderables: [O1, O2, O3, O4, OB], doctors: [DOC1, DOC2, DOC3], credit_parties: [P1, P2, PB], collection_centres: [C2, C3, CB],
  price_lists: [DEF, CEN, REF, PRT, EXP, LB], price_list_versions: [VD, VC, VR, VP, VE, VB],
  price_list_items: [item(1, VD, O1, 90_000), item(2, VD, O2, 40_000), item(3, VD, O3, 120_000), item(4, VC, O1, 80_000), item(5, VR, O1, 70_000), item(6, VP, O1, 60_000), item(7, VE, O1, 50_000),
    pitem(8, TENANT_B, VB.id as string, OB.id as string, 11_111)],
  price_list_assignments: [passign(1, A, PRT.id as string, 'credit_party', P1.id as string), passign(2, A, REF.id as string, 'referrer', DOC1.id as string), passign(3, A, CEN.id as string, 'centre', C2.id as string)],
  tax_rules: [trule(1, A), trule(9, TENANT_B)],                                                                            // tenant default: exempt
});
type Edit = Partial<Record<string, Row[]>> | ((w: Record<string, Row[]>) => void);
function setup(edit: Edit = {}, o: { noVat?: boolean } = {}) {
  const w = base();
  if (typeof edit === 'function') edit(w); else for (const [k, v] of Object.entries(edit)) w[k] = [...(w[k] ?? []), ...(v ?? [])];
  const db = makeQuoteDb({ rows: w as never, ...o });
  const svc = createQuoteService({ events: createEvents({ producer: 'catalog' } as never), identity: actorIdentity([READ]) } as never) as unknown as Svc;
  return { db, svc, w };
}
const replace = (w: Record<string, Row[]>, table: string, pred: (r: Row) => boolean, ...next: Row[]) => { w[table] = [...(w[table] ?? []).filter((r) => !pred(r)), ...next]; };
const items = (...ids: Array<[Row, ('routine' | 'urgent')?]>) => ids.map(([o, p]) => ({ orderable_id: o.id, priority: p ?? 'routine' }));
const quote = async (s: ReturnType<typeof setup>, body: unknown, o: { at?: Date; tenantId?: string } = {}) => (await s.db.run((ctx) => s.svc.quotePrices(ctx, body), { at: o.at ?? NOW, ...(o.tenantId ? { tenantId: o.tenantId } : {}) })).quotes;
const one = async (s: ReturnType<typeof setup>, o: Row, context: object = {}, priority: 'routine' | 'urgent' = 'routine', at?: string) =>
  (await quote(s, { items: items([o, priority]), context, ...(at ? { at } : {}) }))[0];

describe('response shape (PriceQuote, catalog.yaml) and request order', () => {
  it('a default-list quote carries exactly the contract fields; optionals omitted, money is integer paisa NPR (AC-13.3, AC-13.8)', { timeout: T }, async () => {
    const q = await one(setup(), O1);
    expect(q).toEqual({ orderable_id: O1.id, price_list_id: DEF.id, price_list_version: 1, source: 'tenant_default', unit_price: money(90_000), tax: { vat: 'exempt' } });
    expect(Number.isInteger(q.unit_price.amount_paisa)).toBe(true); expect(typeof q.unit_price.amount_paisa).toBe('number');
  });
  it('quotes[i] answers items[i], including a mix of priced, no_price and unknown orderables', { timeout: T }, async () => {
    const s = setup();
    const unknown = '0190c300-0000-7000-8000-0000000ffff1';
    const out = await quote(s, { items: [{ orderable_id: O2.id, priority: 'routine' }, { orderable_id: O4.id, priority: 'routine' }, { orderable_id: unknown, priority: 'routine' }, { orderable_id: O1.id, priority: 'routine' }], context: {} });
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({ orderable_id: O2.id, unit_price: money(40_000) });
    expect(out[1]).toEqual({ orderable_id: O4.id, error_code: 'catalog.no_price' });
    expect(out[2]).toEqual({ orderable_id: unknown, error_code: 'common.not_found' });
    expect(out[3]).toMatchObject({ orderable_id: O1.id, unit_price: money(90_000) });
  });
});

describe('precedence x5 (AC-13.1): NPR 900 default / 800 centre C2 / 700 doctor X / 600 hospital H / explicit', () => {
  const ctxs: Array<[string, object, string, number, string]> = [
    ['no context', {}, 'tenant_default', 90_000, DEF.id as string],
    ['C2', { centre_id: C2.id }, 'centre', 80_000, CEN.id as string],
    ['X + C2', { referrer_id: DOC1.id, centre_id: C2.id }, 'referrer', 70_000, REF.id as string],
    ['H + X + C2', { credit_party_id: P1.id, referrer_id: DOC1.id, centre_id: C2.id }, 'credit_party', 60_000, PRT.id as string],
    ['explicit + H + X + C2', { price_list_id: EXP.id, credit_party_id: P1.id, referrer_id: DOC1.id, centre_id: C2.id }, 'explicit', 50_000, EXP.id as string],
  ];
  it.each(ctxs)('%s', { timeout: T }, async (_n, context, source, paisa, listId) => {
    expect(await one(setup(), O1, context)).toMatchObject({ source, price_list_id: listId, price_list_version: 1, unit_price: money(paisa) });
  });
  it('explicit alone (no other context) is used', { timeout: T }, async () => {
    expect(await one(setup(), O1, { price_list_id: EXP.id })).toMatchObject({ source: 'explicit', unit_price: money(50_000) });
  });
  it('a party / doctor / centre with NO assigned list is not an error: the next source answers', { timeout: T }, async () => {
    expect(await one(setup(), O1, { credit_party_id: P2.id, referrer_id: DOC3.id, centre_id: C3.id })).toMatchObject({ source: 'tenant_default', unit_price: money(90_000) });
    expect(await one(setup(), O1, { credit_party_id: P2.id, referrer_id: DOC1.id })).toMatchObject({ source: 'referrer', unit_price: money(70_000) });
  });
  it('a referrer that was merged resolves to the CANONICAL doctor and its list (02-TRD §7.4)', { timeout: T }, async () => {
    expect(await one(setup(), O1, { referrer_id: DOC2.id })).toMatchObject({ source: 'referrer', price_list_id: REF.id, unit_price: money(70_000) });
  });
  it('an INACTIVE assigned list is skipped as if absent (even with falls_through=false)', { timeout: T }, async () => {
    const s = setup((w) => replace(w, 'price_lists', (r) => r.id === PRT.id, { ...PRT, is_active: false, falls_through: false }));
    expect(await one(s, O1, { credit_party_id: P1.id, centre_id: C2.id })).toMatchObject({ source: 'centre', unit_price: money(80_000) });
  });
});

describe('fall-through (AC-13.2)', () => {
  it('H lacks FBS and falls_through=true: FBS is priced from the next source; CBC still from H', { timeout: T }, async () => {
    const s = setup();
    const out = await quote(s, { items: items([O2], [O1]), context: { credit_party_id: P1.id } });
    expect(out[0]).toMatchObject({ source: 'tenant_default', price_list_id: DEF.id, unit_price: money(40_000) });
    expect(out[1]).toMatchObject({ source: 'credit_party', unit_price: money(60_000) });
  });
  it('H lacks FBS and falls_through=false: catalog.no_price for FBS — the default is NOT consulted — while CBC is still priced', { timeout: T }, async () => {
    const s = setup((w) => replace(w, 'price_lists', (r) => r.id === PRT.id, { ...PRT, falls_through: false }));
    const out = await quote(s, { items: items([O2], [O1]), context: { credit_party_id: P1.id } });
    expect(out[0]).toEqual({ orderable_id: O2.id, error_code: 'catalog.no_price' });
    expect(out[1]).toMatchObject({ source: 'credit_party', unit_price: money(60_000) });
  });
  it('an assigned list with ONLY a draft v1 is skipped as if absent, regardless of falls_through', { timeout: T }, async () => {
    for (const ft of [true, false]) {
      const s = setup((w) => { replace(w, 'price_lists', (r) => r.id === PRT.id, { ...PRT, falls_through: ft }); replace(w, 'price_list_versions', (r) => r.id === VP.id, pver(4, A, PRT.id as string, 1, { status: 'draft' })); });
      expect(await one(s, O1, { credit_party_id: P1.id, centre_id: C2.id }), `falls_through=${ft}`).toMatchObject({ source: 'centre', unit_price: money(80_000) });
    }
  });
  it('the explicit list lacking the item: falls_through=true continues down the chain; false ends it', { timeout: T }, async () => {
    expect(await one(setup(), O2, { price_list_id: EXP.id })).toMatchObject({ source: 'tenant_default', unit_price: money(40_000) });
    const closed = setup((w) => replace(w, 'price_lists', (r) => r.id === EXP.id, { ...EXP, falls_through: false }));
    expect(await one(closed, O2, { price_list_id: EXP.id })).toEqual({ orderable_id: O2.id, error_code: 'catalog.no_price' });
  });
  it('AC-07.6: a package with no price-list item of its own is no_price — component prices are never summed', { timeout: T }, async () => {
    expect(await one(setup(), O4)).toEqual({ orderable_id: O4.id, error_code: 'catalog.no_price' });
    expect(await one(setup(), O4, { credit_party_id: P1.id, centre_id: C2.id, referrer_id: DOC1.id })).toEqual({ orderable_id: O4.id, error_code: 'catalog.no_price' });
  });
  it('no default-list price for the orderable and no other list: no_price (never a made-up 0)', { timeout: T }, async () => {
    expect(await one(setup((w) => { w['price_list_items'] = w['price_list_items']!.filter((r) => r.orderable_id !== O2.id); }), O2)).toEqual({ orderable_id: O2.id, error_code: 'catalog.no_price' });
  });
  it('a price of 0 paisa is a real price', { timeout: T }, async () => {
    const s = setup((w) => replace(w, 'price_list_items', (r) => r.orderable_id === O2.id, item(20, VD, O2, 0)));
    expect(await one(s, O2)).toMatchObject({ unit_price: money(0), source: 'tenant_default' });
  });
});

describe('effective windows (AC-13.3): `at` selects the version; the quote names it', () => {
  const versioned = () => setup((w) => {
    replace(w, 'price_list_versions', (r) => r.id === VD.id,
      ver(1, DEF, 1, { status: 'superseded', effective_to: T1 }), ver(11, DEF, 2, { effective_from: T1 }), ver(12, DEF, 3, { effective_from: T3 }), ver(13, DEF, 4, { status: 'draft', effective_from: null }));
    replace(w, 'price_list_items', (r) => r.orderable_id === O1.id && r.price_list_version_id === VD.id,
      item(30, ver(1, DEF, 1), O1, 85_000), item(31, ver(11, DEF, 2), O1, 90_000), item(32, ver(12, DEF, 3), O1, 95_000), item(33, ver(13, DEF, 4), O1, 1));
  });
  it('`at` omitted = ctx.now(): v2 (the scheduled v3 and the draft v4 are not used yet)', { timeout: T }, async () => {
    expect(await one(versioned(), O1)).toMatchObject({ price_list_version: 2, unit_price: money(90_000), price_list_id: DEF.id });
  });
  it('at < T1 uses v1; at == T1 uses v2 (inclusive start); at >= T3 uses v3', { timeout: T }, async () => {
    const s = versioned();
    expect(await one(s, O1, {}, 'routine', iso(new Date(T1.getTime() - 1)))).toMatchObject({ price_list_version: 1, unit_price: money(85_000) });
    expect(await one(s, O1, {}, 'routine', iso(T1))).toMatchObject({ price_list_version: 2, unit_price: money(90_000) });
    expect(await one(s, O1, {}, 'routine', iso(T3))).toMatchObject({ price_list_version: 3, unit_price: money(95_000) });
  });
  it('before the first version started there is no price', { timeout: T }, async () => {
    expect(await one(versioned(), O1, {}, 'routine', iso(new Date(T0.getTime() - 1)))).toEqual({ orderable_id: O1.id, error_code: 'catalog.no_price' });
  });
  it('a list whose first version starts in the future is skipped until then (falls to the default)', { timeout: T }, async () => {
    const s = setup((w) => replace(w, 'price_list_versions', (r) => r.id === VP.id, ver(4, PRT, 1, { effective_from: T3 })));
    expect(await one(s, O1, { credit_party_id: P1.id })).toMatchObject({ source: 'tenant_default' });
    expect(await one(s, O1, { credit_party_id: P1.id }, 'routine', iso(T3))).toMatchObject({ source: 'credit_party', unit_price: money(60_000) });
  });
  it('the effective window also bounds tax and surcharge rules at the same `at` (AC-15.5 successor default)', { timeout: T }, async () => {
    const s = setup((w) => replace(w, 'tax_rules', () => true, trule(1, A, { effective_to: T1 }), trule(2, A, { vat_treatment: 'taxable', effective_from: T1 })));
    expect((await one(s, O1, {}, 'routine', iso(new Date(T1.getTime() - 1)))).tax).toEqual({ vat: 'exempt' });
    expect((await one(s, O1, {}, 'routine', iso(T1))).tax).toEqual({ vat: 'taxable', vat_rate_bp: 1300 });
  });
});

describe('explicit / context ids that cannot be used fail the whole request: common.not_found (02-TRD §7.4, S-1, AB-1)', () => {
  it('an INACTIVE explicit list', { timeout: T }, async () => {
    const s = setup((w) => replace(w, 'price_lists', (r) => r.id === EXP.id, { ...EXP, is_active: false }));
    notFound(await rejection(s.db.run((ctx) => s.svc.quotePrices(ctx, { items: items([O1]), context: { price_list_id: EXP.id } }), { at: NOW })));
  });
  it("an unknown explicit list and another tenant's explicit list look the same", { timeout: T }, async () => {
    const s = setup();
    for (const id of ['0190c300-0000-7000-8000-0000000ffff2', LB.id]) notFound(await rejection(s.db.run((ctx) => s.svc.quotePrices(ctx, { items: items([O1]), context: { price_list_id: id } }), { at: NOW })));
  });
  it("an unknown / another tenant's credit party, referrer and centre", { timeout: T }, async () => {
    const s = setup();
    const ghost = '0190c300-0000-7000-8000-0000000ffff3';
    for (const ctx of [{ credit_party_id: ghost }, { credit_party_id: PB.id }, { referrer_id: ghost }, { centre_id: ghost }, { centre_id: CB.id }]) {
      notFound(await rejection(s.db.run((c) => s.svc.quotePrices(c, { items: items([O1]), context: ctx }), { at: NOW })));
    }
  });
  it("another tenant's orderable is a per-item common.not_found and its price never leaks; tenant B sees only its own", { timeout: T }, async () => {
    const s = setup();
    expect(await one(s, OB)).toEqual({ orderable_id: OB.id, error_code: 'common.not_found' });
    const b = (await quote(s, { items: items([OB]), context: {} }, { tenantId: TENANT_B }))[0];
    expect(b).toMatchObject({ orderable_id: OB.id, price_list_id: LB.id, unit_price: money(11_111) });
    expect(JSON.stringify(b)).not.toContain(String(O1.id));
  });
});

describe('urgent surcharge (AC-14.1–14.4)', () => {
  const pct = (n: number, bp: number, o: Row = {}) => srule(n, A, { scope: 'department', department_id: D1.id, amount_kind: 'percent', amount_paisa: null, percent_bp: bp, ...o });
  it('AC-14.1: department HAEM 5000 bp on CBC NPR 900.00 -> urgent 45000 paisa; routine -> field absent', { timeout: T }, async () => {
    const s = setup({ surcharge_rules: [pct(1, 5_000)] });
    expect(await one(s, O1, {}, 'urgent')).toMatchObject({ unit_price: money(90_000), urgent_surcharge: money(45_000) });
    const routine = await one(s, O1, {}, 'routine');
    expect(routine).not.toHaveProperty('urgent_surcharge');
  });
  it('the surcharge is computed on the WINNING list price, not the default', { timeout: T }, async () => {
    const s = setup({ surcharge_rules: [pct(1, 5_000)] });
    expect(await one(s, O1, { credit_party_id: P1.id }, 'urgent')).toMatchObject({ unit_price: money(60_000), urgent_surcharge: money(30_000) });
  });
  it('AC-14.3: percent rounds half-up to the paisa (333 x 50 % = 166.5 -> 167; 331 -> 165.5 -> 166; 330 -> 165)', { timeout: T }, async () => {
    for (const [price, want] of [[333, 167], [331, 166], [330, 165]] as const) {
      const s = setup((w) => { w['surcharge_rules'] = [pct(1, 5_000)]; replace(w, 'price_list_items', (r) => r.orderable_id === O1.id && r.price_list_version_id === VD.id, item(40, VD, O1, price)); });
      expect((await one(s, O1, {}, 'urgent')).urgent_surcharge, `${price}`).toEqual(money(want));
    }
  });
  it('a flat rule adds its amount_paisa', { timeout: T }, async () => {
    const s = setup({ surcharge_rules: [srule(1, A, { scope: 'all', amount_kind: 'flat', amount_paisa: 25_000 })] });
    expect((await one(s, O1, {}, 'urgent')).urgent_surcharge).toEqual(money(25_000));
  });
  it('AC-14.2 specificity: orderable rule > department rule > all-tests rule', { timeout: T }, async () => {
    const all = srule(1, A, { scope: 'all', amount_kind: 'flat', amount_paisa: 1_000 });
    const d = pct(2, 5_000);
    const o = srule(3, A, { scope: 'orderable', orderable_id: O1.id, amount_kind: 'flat', amount_paisa: 12_345 });
    expect((await one(setup({ surcharge_rules: [all] }), O1, {}, 'urgent')).urgent_surcharge).toEqual(money(1_000));
    expect((await one(setup({ surcharge_rules: [all, d] }), O1, {}, 'urgent')).urgent_surcharge).toEqual(money(45_000));
    expect((await one(setup({ surcharge_rules: [all, d, o] }), O1, {}, 'urgent')).urgent_surcharge).toEqual(money(12_345));
    expect((await one(setup({ surcharge_rules: [o, d, all] }), O2, {}, 'urgent')).urgent_surcharge, 'FBS: only the all-rule matches').toEqual(money(1_000));
  });
  it('AC-14.2 list scope: a rule scoped to the winning list beats an unscoped rule of the same specificity; a rule scoped to another list does not apply', { timeout: T }, async () => {
    const unscoped = pct(1, 5_000);
    const scoped = pct(2, 3_000, { price_list_id: PRT.id });
    const other = pct(3, 9_000, { price_list_id: CEN.id });
    expect((await one(setup({ surcharge_rules: [unscoped, scoped, other] }), O1, { credit_party_id: P1.id }, 'urgent')).urgent_surcharge).toEqual(money(18_000));       // 60000 x 30 %
    expect((await one(setup({ surcharge_rules: [unscoped, scoped, other] }), O1, {}, 'urgent')).urgent_surcharge).toEqual(money(45_000));                                  // default list: unscoped only
  });
  it('AC-14.4: no matching rule on an urgent quote = no surcharge, NOT an error', { timeout: T }, async () => {
    const q = await one(setup(), O1, {}, 'urgent');
    expect(q).toMatchObject({ unit_price: money(90_000) }); expect(q).not.toHaveProperty('urgent_surcharge'); expect(q).not.toHaveProperty('error_code');
    expect(await one(setup({ surcharge_rules: [pct(1, 5_000, { department_id: D2.id })] }), O1, {}, 'urgent')).not.toHaveProperty('urgent_surcharge');          // other department
  });
  it('windows are half-open and inactive rules are ignored', { timeout: T }, async () => {
    const s = (o: Row) => setup({ surcharge_rules: [pct(1, 5_000, o)] });
    expect(await one(s({ effective_from: T3 }), O1, {}, 'urgent')).not.toHaveProperty('urgent_surcharge');
    expect(await one(s({ effective_to: NOW }), O1, {}, 'urgent', iso(NOW))).not.toHaveProperty('urgent_surcharge');
    expect(await one(s({ effective_to: NOW }), O1, {}, 'urgent', iso(new Date(NOW.getTime() - 1)))).toHaveProperty('urgent_surcharge');
    expect(await one(s({ is_active: false }), O1, {}, 'urgent')).not.toHaveProperty('urgent_surcharge');
  });
  it("a panel without a department never matches a department rule (only orderable / all rules); a package uses its own department_id", { timeout: T }, async () => {
    const s = setup({ surcharge_rules: [pct(1, 5_000)] });
    expect(await one(s, O3, {}, 'urgent')).not.toHaveProperty('urgent_surcharge');                                       // LFT: department null, priced 120000
    const priced = setup((w) => { w['surcharge_rules'] = [pct(1, 5_000)]; w['price_list_items']!.push(item(50, VD, O4, 10_000)); });
    expect((await one(priced, O4, {}, 'urgent')).urgent_surcharge).toEqual(money(5_000));                                // PKG: dept D1
  });
});

describe('tax (AC-15.1, AC-15.3, 08 R18: rates are data)', () => {
  it('AC-15.1: tenant default exempt + an orderable rule taxable for FBS: FBS taxable with vat_rate_bp 1300, CBC exempt without a rate', { timeout: T }, async () => {
    const s = setup({ tax_rules: [trule(2, A, { scope: 'orderable', orderable_id: O2.id, vat_treatment: 'taxable' })] });
    const out = await quote(s, { items: items([O2], [O1]), context: {} });
    expect(out[0].tax).toEqual({ vat: 'taxable', vat_rate_bp: 1300 });
    expect(out[1].tax).toEqual({ vat: 'exempt' }); expect(out[1].tax).not.toHaveProperty('vat_rate_bp');
  });
  it('rule precedence: orderable > department > tenant default; a panel without a department skips the department rule', { timeout: T }, async () => {
    const dep = trule(2, A, { scope: 'department', department_id: D1.id, vat_treatment: 'taxable' });
    const exOrd = trule(3, A, { scope: 'orderable', orderable_id: O1.id, vat_treatment: 'exempt' });
    expect((await one(setup({ tax_rules: [dep] }), O1)).tax.vat).toBe('taxable');
    expect((await one(setup({ tax_rules: [dep, exOrd] }), O1)).tax.vat).toBe('exempt');
    expect((await one(setup({ tax_rules: [dep] }), O3)).tax.vat).toBe('exempt');                                          // LFT has no department: default applies
    expect((await one(setup({ tax_rules: [dep] }), O2)).tax.vat).toBe('exempt');                                          // FBS is in D2
  });
  it('AC-15.3: no tenant-default rule -> per-item catalog.tax_config_missing (never an assumed "exempt")', { timeout: T }, async () => {
    const s = setup((w) => { w['tax_rules'] = []; });
    expect(await one(s, O1)).toEqual({ orderable_id: O1.id, error_code: 'catalog.tax_config_missing' });
  });
  it('AC-15.3: only an ENDED / inactive / not-yet-effective default counts as none', { timeout: T }, async () => {
    for (const o of [{ effective_to: T1 }, { is_active: false }, { effective_from: T3 }]) {
      const s = setup((w) => { w['tax_rules'] = [trule(1, A, o)]; });
      expect(await one(s, O1), JSON.stringify(o)).toEqual({ orderable_id: O1.id, error_code: 'catalog.tax_config_missing' });
    }
  });
  it('a department / orderable rule alone (no tenant default) is still tax_config_missing for an orderable without a rule', { timeout: T }, async () => {
    const s = setup((w) => { w['tax_rules'] = [trule(2, A, { scope: 'orderable', orderable_id: O2.id, vat_treatment: 'exempt' })]; });
    expect(await one(s, O2)).toMatchObject({ tax: { vat: 'exempt' } });
    expect(await one(s, O1)).toEqual({ orderable_id: O1.id, error_code: 'catalog.tax_config_missing' });
  });
  it('the VAT rate comes from the g_tax_types row, not a constant; taxable with no VAT row -> tax_config_missing', { timeout: T }, async () => {
    const taxable = (w: Record<string, Row[]>) => { w['tax_rules'] = [trule(1, A, { vat_treatment: 'taxable' })]; };
    const s14 = setup((w) => { taxable(w); w['g_tax_types'] = [{ ...VAT_ROW, rate_bp: 1400 }]; }, { noVat: true });
    expect((await one(s14, O1)).tax).toEqual({ vat: 'taxable', vat_rate_bp: 1400 });
    expect(await one(setup(taxable, { noVat: true }), O1)).toEqual({ orderable_id: O1.id, error_code: 'catalog.tax_config_missing' });
  });
  it('other tax + hs_code: rate of the cs_tax_types version effective at `at` (rate change = new version, 08 R18)', { timeout: T }, async () => {
    const s = setup((w) => {
      w['tax_rules'] = [trule(1, A), trule(2, A, { scope: 'orderable', orderable_id: O2.id, other_tax_code: 'HST', hs_code: '9018' })];
      w['cs_tax_types'] = [ttype(1, A, 'HST', { rate_bp: 500, effective_to: T1 }), ttype(2, A, 'HST', { rate_bp: 700, effective_from: T1 })];
    });
    expect((await one(s, O2)).tax).toEqual({ vat: 'exempt', other_tax_code: 'HST', other_tax_rate_bp: 700, hs_code: '9018' });
    expect((await one(s, O2, {}, 'routine', iso(new Date(T1.getTime() - 1)))).tax).toEqual({ vat: 'exempt', other_tax_code: 'HST', other_tax_rate_bp: 500, hs_code: '9018' });
  });
  it('other tax whose type has no usable rate version at `at` (none effective / rate NULL / inactive) -> tax_config_missing', { timeout: T }, async () => {
    for (const types of [[ttype(1, A, 'HST', { effective_from: T3 })], [ttype(1, A, 'HST', { rate_bp: null })], [ttype(1, A, 'HST', { is_active: false })], []]) {
      const s = setup((w) => { w['tax_rules'] = [trule(1, A), trule(2, A, { scope: 'orderable', orderable_id: O2.id, other_tax_code: 'HST' })]; w['cs_tax_types'] = types; });
      expect(await one(s, O2)).toEqual({ orderable_id: O2.id, error_code: 'catalog.tax_config_missing' });
    }
  });
  it('0 % is a configured rate (other_tax_rate_bp 0 is returned, not dropped)', { timeout: T }, async () => {
    const s = setup((w) => { w['tax_rules'] = [trule(1, A, { other_tax_code: 'ZR' })]; w['cs_tax_types'] = [ttype(1, A, 'ZR', { rate_bp: 0 })]; });
    expect((await one(s, O1)).tax).toEqual({ vat: 'exempt', other_tax_code: 'ZR', other_tax_rate_bp: 0 });
  });
});

describe('validation: closed bodies and bounds (S-5, AB-10) — a client can never supply a price', () => {
  const ok = () => ({ items: items([O1]), context: {} });
  const bad = async (body: unknown, path?: string) => { const s = setup(); validation400(await rejection(s.db.run((ctx) => s.svc.quotePrices(ctx, body), { at: NOW })), path); expect(s.db.writes).toEqual([]); };
  it.each([
    ['unit_price at the root', { ...ok(), unit_price: money(1) }],
    ['tenant_id at the root', { ...ok(), tenant_id: TENANT_B }],
    ['status / revision / created_by at the root', { ...ok(), status: 'published', revision: 1, created_by: A }],
    ['unit_price inside an item', { items: [{ orderable_id: O1.id, priority: 'routine', unit_price: money(1) }], context: {} }],
    ['an unknown key in context', { items: items([O1]), context: { tenant_id: TENANT_B } }],
  ])('%s -> 400', { timeout: T }, async (_n, body) => { await bad(body); });
  it('items: missing / empty / 51 / not an array -> 400 /items', { timeout: T }, async () => {
    await bad({ context: {} }, '/items'); await bad({ items: [], context: {} }, '/items');
    await bad({ items: Array.from({ length: 51 }, () => ({ orderable_id: O1.id, priority: 'routine' })), context: {} }, '/items');
    await bad({ items: 'x', context: {} }, '/items');
  });
  it('item fields: bad priority / bad uuid / missing priority -> 400 with the item path', { timeout: T }, async () => {
    await bad({ items: [{ orderable_id: O1.id, priority: 'STAT' }], context: {} }, '/items/0/priority');
    await bad({ items: [{ orderable_id: O1.id }], context: {} }, '/items/0/priority');
    await bad({ items: [{ orderable_id: O1.id, priority: 'routine' }, { orderable_id: 'not-a-uuid', priority: 'routine' }], context: {} }, '/items/1/orderable_id');
    await bad({ items: [{ priority: 'routine' }], context: {} }, '/items/0/orderable_id');
    await bad({ items: [null], context: {} });
  });
  it('context: required; every id must be a uuid; `at` must be an ISO instant with offset', { timeout: T }, async () => {
    await bad({ items: items([O1]) }, '/context'); await bad({ items: items([O1]), context: null }, '/context');
    for (const k of ['price_list_id', 'credit_party_id', 'referrer_id', 'centre_id']) await bad({ items: items([O1]), context: { [k]: "x' OR '1'='1" } }, `/context/${k}`);
    for (const at of ['yesterday', '2026-11-07', '2026-11-07T12:00:00', 1_700_000_000, null]) await bad({ ...ok(), at }, '/at');
  });
  it.each([null, undefined, [], 'x', 5])('a non-object body (%s) -> 400', { timeout: T }, async (b) => { await bad(b); });
  it('errors never echo a submitted value', { timeout: T }, async () => {
    const s = setup();
    const e = await rejection(s.db.run((ctx) => s.svc.quotePrices(ctx, { items: [{ orderable_id: 'SECRET-CANARY-77', priority: 'routine' }], context: {} }), { at: NOW }));
    expect(JSON.stringify({ m: e.message, d: e.detail, errors: e.errors })).not.toContain('SECRET-CANARY-77');
  });
  it('exactly 50 items are accepted and answered in order', { timeout: T }, async () => {
    const many = Array.from({ length: 50 }, (_, i) => orderable(100 + i, A, { code: `B${i}`, department_id: D1.id }));
    const s = setup((w) => { w['orderables']!.push(...many); w['price_list_items']!.push(...many.map((o, i) => item(100 + i, VD, o, 1_000 + i))); });
    const out = await quote(s, { items: items(...many.map((o) => [o] as [Row])), context: { credit_party_id: P1.id, centre_id: C2.id } });
    expect(out.map((q) => q.orderable_id)).toEqual(many.map((o) => o.id));
    expect(out.map((q) => q.unit_price.amount_paisa)).toEqual(many.map((_, i) => 1_000 + i));
    expect(s.db.stmts.length, 'no per-item query storm (N+1)').toBeLessThan(50);
  });
});

describe('read-only, tenant-scoped, bind-only (REQ-SEC-046, S-1, S-6) and concurrency', () => {
  it('quoting writes nothing and publishes nothing; the catalog revision is untouched', { timeout: T }, async () => {
    const s = setup({ surcharge_rules: [srule(1, A, { scope: 'all', amount_kind: 'flat', amount_paisa: 5_000 })] });
    await quote(s, { items: items([O1, 'urgent'], [O4]), context: { credit_party_id: P1.id, referrer_id: DOC1.id, centre_id: C2.id } });
    expect(s.db.writes).toEqual([]);
    expect(s.db.price.events).toHaveLength(0);
    expect(s.db.price.revisionOf(A)).toBe(417);
  });
  it('every statement on a tenant table filters on tenant_id with the caller tenant bound, and ids / codes are binds, never text', { timeout: T }, async () => {
    const s = setup({ surcharge_rules: [srule(1, A, { scope: 'all', amount_kind: 'flat', amount_paisa: 5_000 })] });
    await quote(s, { items: items([O1, 'urgent']), context: { price_list_id: EXP.id, credit_party_id: P1.id, referrer_id: DOC2.id, centre_id: C2.id } });
    const tenantTables = /catalog\.(price_lists|price_list_assignments|price_list_versions|price_list_items|orderables|doctors|credit_parties|surcharge_rules|tax_rules|cs_tax_types)\b|core\.collection_centres/i;
    const mine = s.db.stmts.filter((x) => tenantTables.test(x.text));
    expect(mine.length).toBeGreaterThan(0);
    for (const x of mine) {
      expect(/^\s*SELECT\b/i.test(x.text), x.text).toBe(true);
      expect(/\btenant_id\b/i.test(x.text), x.text).toBe(true);
      expect(x.values, x.text).toContain(A);
      for (const id of [O1.id, EXP.id, P1.id, DOC2.id, C2.id, A]) expect(x.text, 'literal id in SQL text').not.toContain(String(id));
    }
  });
  it('20 concurrent quotes in separate transactions agree (no shared mutable state, deterministic)', { timeout: T }, async () => {
    const s = setup({ surcharge_rules: [srule(1, A, { scope: 'department', department_id: D1.id, amount_kind: 'percent', amount_paisa: null, percent_bp: 5_000 })] });
    const body = { items: items([O1, 'urgent'], [O2], [O4]), context: { credit_party_id: P1.id, centre_id: C2.id } };
    const runs = await Promise.all(Array.from({ length: 20 }, () => quote(s, body)));
    for (const r of runs) expect(r).toEqual(runs[0]);
    expect(runs[0]![0]).toMatchObject({ source: 'credit_party', urgent_surcharge: money(30_000) });
  });
  it('a dependency failure (SQL error) surfaces as an error, never as a partial / zero price', { timeout: T }, async () => {
    const s = setup();
    s.db.price.fail(/price_list_items/i);
    const e = await rejection(s.db.run((ctx) => s.svc.quotePrices(ctx, { items: items([O1]), context: {} }), { at: NOW }));
    expect(e).toBeInstanceOf(Error);
  });
});
