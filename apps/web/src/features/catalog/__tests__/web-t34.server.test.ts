// C3.T-34 — BFF server functions for SCR-13…17 (02-CONVENTIONS §2.4: server/<operationId>.server.ts). MSW stands in for the C3 API
// (contracts/openapi/catalog.yaml) and for C2 listCentres (identity.yaml). Synthetic data only.
// ASSUMED signatures (same conventions as T-31/T-33: create*(input, idempotencyKey?), update*(id, version, input) → If-Match "<version>"):
//   listPriceLists({ownerKind?, ownerId?, isActive?, limit?, cursor?})  getPriceListDetail(id)  createPriceList(input, key?)  updatePriceList(id, version, input)
//   replacePriceListAssignments(id, version, {owner_ids})  createPriceListVersionDraft(priceListId, input?, key?)
//   listPriceListItems(versionId, {orderableKind?, departmentId?, sort?, limit?, cursor?})
//   upsertPriceListItems(versionId, {items}, key?)  removePriceListItems(versionId, {ids}, key?)
//   publishPriceListVersion(versionId, version, {effective_from?, change_reason}, key?)  discardPriceListVersionDraft(versionId, version)
//   quotePrices(input)  listSurchargeRules({scope?, activeAt?})  createSurchargeRule(input, key?)  endSurchargeRule(id, version, {effective_to?})
//   listTaxTypes({allVersions?, activeAt?})  createTaxType(input, key?)  updateTaxType(id, version, input)  listTaxRules({scope?, activeAt?})  createTaxRule(input, key?)  endTaxRule(id, version, {effective_to?})
//   listCentres() → GET /v1/identity/centres (08 A13 D-16)
// Covers AC-13.4/13.5/13.8 (+ 07-SECURITY AB-10: no client-supplied price/tenant on quote; REQ-SEC-046; REQ-SEC-100 bulk ≤200), AC-14.1/14.5, AC-15.2.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => undefined }));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-0000000e${String(n).padStart(4, '0')}`;
const PL = U(1);
const VER = U(2);
const ORD = U(3);
const KEY = 'key-synthetic-0001';

const seen: { url: URL; method: string; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { seen.push({ url: new URL(r.url), method: r.method, headers: r.headers, body: ['POST', 'PATCH', 'PUT'].includes(r.method) ? await r.clone().json().catch(() => undefined) : undefined }); };
const entity = { id: PL, version: 4, is_active: true };
const server = setupServer(
  http.get(`${ORIGIN}/v1/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [], page: { limit: 50 } }); }),
  http.post(`${ORIGIN}/v1/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ ...entity, results: [], quotes: [], data: [] }, { status: 201 }); }),
  http.patch(`${ORIGIN}/v1/*`, async ({ request }) => { await rec(request); return HttpResponse.json(entity); }),
  http.put(`${ORIGIN}/v1/*`, async ({ request }) => { await rec(request); return HttpResponse.json(entity); }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); seen.length = 0; });
afterAll(() => server.close());

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'x', status, code, ...extra }, { status });
const mod = async (op: string) => (await import(`../server/${op}.server.ts`))[op];
const rejects = async (p: Promise<unknown>) => { const e: any = await p.then(() => undefined, (x: unknown) => x); expect(e?.status, 'ApiError 400').toBe(400); expect(e.problem.code).toBe('common.validation_failed'); };
const lastCall = () => seen[seen.length - 1]!;
const money = (amount_paisa: number) => ({ amount_paisa, currency: 'NPR' });

describe('price lists (SCR-13; AC-13.6, 13.7)', () => {
  it('listPriceLists → GET /price-lists with owner_kind / owner_id / is_active=all mapped to query', async () => {
    await (await mod('listPriceLists'))({ ownerKind: 'referrer', ownerId: U(9), isActive: 'all', limit: 50 });
    const c = lastCall();
    expect(c.method).toBe('GET');
    expect(c.url.pathname).toBe('/v1/catalog/price-lists');
    expect(c.url.searchParams.get('owner_kind')).toBe('referrer');
    expect(c.url.searchParams.get('owner_id')).toBe(U(9));
    expect(c.url.searchParams.get('is_active')).toBe('all');
    await rejects((await mod('listPriceLists'))({ ownerKind: 'moon' }));
  });

  it('getPriceListDetail validates the id (no request for a malformed one)', async () => {
    await (await mod('getPriceListDetail'))(PL);
    expect(lastCall().url.pathname).toBe(`/v1/catalog/price-lists/${PL}`);
    seen.length = 0;
    await rejects((await mod('getPriceListDetail'))('../x'));
    expect(seen).toHaveLength(0);
  });

  it('createPriceList → POST with Idempotency-Key; code upper-cased; only known fields; mass assignment dropped', async () => {
    const create = await mod('createPriceList');
    await create({ code: ' hosp_a ', name: 'Hospital A list', owner_kind: 'credit_party', falls_through: true, assignments: [{ owner_id: U(9) }], tenant_id: 'evil', is_active: false }, KEY);
    const c = lastCall();
    expect(c.method).toBe('POST');
    expect(c.headers.get('idempotency-key')).toBe(KEY);
    expect(c.body).toEqual({ code: 'HOSP_A', name: 'Hospital A list', owner_kind: 'credit_party', falls_through: true, assignments: [{ owner_id: U(9) }] });
  });

  it('createPriceList: generates a key when none is given; rejects bad kind / name > 120 / > 500 assignments / bad key', async () => {
    const create = await mod('createPriceList');
    await create({ code: 'D', name: 'Default', owner_kind: 'default', assignments: [] });
    expect(lastCall().headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    const ok = { code: 'D', name: 'Default', owner_kind: 'default', assignments: [] };
    await rejects(create({ ...ok, owner_kind: 'tenant' }));
    await rejects(create({ ...ok, name: 'N'.repeat(121) }));
    await rejects(create({ ...ok, name: '' }));
    await rejects(create({ ...ok, assignments: Array.from({ length: 501 }, (_, i) => ({ owner_id: U(i + 10) })) }));
    await rejects(create({ ...ok, assignments: [{ owner_id: 'nope' }] }));
    await rejects(create(ok, 'bad key!'));
  });

  it('AC-13.6: second default list → 409 surfaces as ApiError 409 (no swallow)', async () => {
    server.use(http.post(`${ORIGIN}/v1/catalog/price-lists`, () => problem(409, 'catalog.code_duplicate')));
    const e: any = await (await mod('createPriceList'))({ code: 'D2', name: 'Second default', owner_kind: 'default', assignments: [] }).catch((x: unknown) => x);
    expect(e.status).toBe(409);
    expect(e.problem.code).toBe('catalog.code_duplicate');
  });

  it('updatePriceList → PATCH with If-Match "<version>" and only name / falls_through / is_active', async () => {
    await (await mod('updatePriceList'))(PL, 3, { name: 'Renamed', falls_through: false, is_active: true, owner_kind: 'default' });
    const c = lastCall();
    expect(c.method).toBe('PATCH');
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(c.body).toEqual({ name: 'Renamed', falls_through: false, is_active: true });
    await rejects((await mod('updatePriceList'))(PL, 0, { name: 'x' }));
    await rejects((await mod('updatePriceList'))(PL, 3, { name: 'N'.repeat(121) }));
  });

  it('AC-13.7: replacePriceListAssignments → PUT /assignments with If-Match and {owner_ids}; ≤ 500 uuids; 409 catalog.code_duplicate surfaces', async () => {
    const put = await mod('replacePriceListAssignments');
    await put(PL, 3, { owner_ids: [U(9), U(10)] });
    const c = lastCall();
    expect(c.method).toBe('PUT');
    expect(c.url.pathname).toBe(`/v1/catalog/price-lists/${PL}/assignments`);
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(c.body).toEqual({ owner_ids: [U(9), U(10)] });
    await rejects(put(PL, 3, { owner_ids: Array.from({ length: 501 }, (_, i) => U(i + 10)) }));
    await rejects(put(PL, 3, { owner_ids: ['x'] }));
    server.use(http.put(`${ORIGIN}/v1/catalog/price-lists/:id/assignments`, () => problem(409, 'catalog.code_duplicate')));
    const e: any = await put(PL, 3, { owner_ids: [U(9)] }).catch((x: unknown) => x);
    expect(e.status).toBe(409);
  });
});

describe('versions + items (SCR-14; AC-13.4, 13.8; REQ-SEC-100)', () => {
  it('createPriceListVersionDraft → POST /versions with Idempotency-Key and optional copy_from_version_no', async () => {
    const make = await mod('createPriceListVersionDraft');
    await make(PL, { copy_from_version_no: 2 }, KEY);
    const c = lastCall();
    expect(c.url.pathname).toBe(`/v1/catalog/price-lists/${PL}/versions`);
    expect(c.headers.get('idempotency-key')).toBe(KEY);
    expect(c.body).toEqual({ copy_from_version_no: 2 });
    await rejects(make(PL, { copy_from_version_no: 0 }));
    await rejects(make(PL, { copy_from_version_no: 1.5 }));
  });

  it('listPriceListItems → GET with orderable_kind / department_id / sort / limit ≤ 200', async () => {
    const list = await mod('listPriceListItems');
    await list(VER, { orderableKind: 'panel', departmentId: U(7), sort: '-orderable_code', limit: 200 });
    const q = lastCall().url;
    expect(q.pathname).toBe(`/v1/catalog/price-list-versions/${VER}/items`);
    expect(q.searchParams.get('orderable_kind')).toBe('panel');
    expect(q.searchParams.get('department_id')).toBe(U(7));
    expect(q.searchParams.get('sort')).toBe('-orderable_code');
    await rejects(list(VER, { limit: 201 }));
    await rejects(list(VER, { sort: 'price' }));
  });

  it('upsertPriceListItems → POST /items/bulk-upsert with Idempotency-Key; body is exactly {items:[{orderable_id, unit_price:{amount_paisa,currency}}]}', async () => {
    await (await mod('upsertPriceListItems'))(VER, { items: [{ orderable_id: ORD, unit_price: money(90000), tenant_id: 'evil', extra: 1 }] }, KEY);
    const c = lastCall();
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe(`/v1/catalog/price-list-versions/${VER}/items/bulk-upsert`);
    expect(c.headers.get('idempotency-key')).toBe(KEY);
    expect(c.body).toEqual({ items: [{ orderable_id: ORD, unit_price: money(90000) }] });
  });

  it('upsert: 200 rows pass, 201 / 0 rows are rejected without a request (batch cap, REQ-SEC-100)', async () => {
    const up = await mod('upsertPriceListItems');
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ orderable_id: U(1000 + i), unit_price: money(100) }));
    await up(VER, { items: rows(200) });
    expect(seen).toHaveLength(1);
    await rejects(up(VER, { items: rows(201) }));
    await rejects(up(VER, { items: [] }));
    expect(seen).toHaveLength(1);
  });

  it('AC-13.8: prices are integer paisa 0…999,999,999 NPR — floats, negatives, strings, > max, wrong currency rejected', async () => {
    const up = await mod('upsertPriceListItems');
    const one = (unit_price: unknown) => ({ items: [{ orderable_id: ORD, unit_price }] });
    await up(VER, one(money(0)));
    await up(VER, one(money(999_999_999)));
    const before = seen.length;
    await rejects(up(VER, one(money(1000_000_000))));
    await rejects(up(VER, one(money(-1))));
    await rejects(up(VER, one(money(10.5))));
    await rejects(up(VER, one({ amount_paisa: '900', currency: 'NPR' })));
    await rejects(up(VER, one({ amount_paisa: 900, currency: 'USD' })));
    await rejects(up(VER, one(900)));
    await rejects(up(VER, { items: [{ orderable_id: 'nope', unit_price: money(1) }] }));
    expect(seen).toHaveLength(before);
  });

  it('AC-13.4: 409 catalog.version_in_use on upsert surfaces as ApiError 409', async () => {
    server.use(http.post(`${ORIGIN}/v1/catalog/price-list-versions/:id/items/bulk-upsert`, () => problem(409, 'catalog.version_in_use')));
    const e: any = await (await mod('upsertPriceListItems'))(VER, { items: [{ orderable_id: ORD, unit_price: money(1) }] }).catch((x: unknown) => x);
    expect(e.status).toBe(409);
    expect(e.problem.code).toBe('catalog.version_in_use');
  });

  it('removePriceListItems → POST /items/bulk-remove {ids} with Idempotency-Key; 1…200 uuids', async () => {
    const rm = await mod('removePriceListItems');
    await rm(VER, { ids: [ORD] }, KEY);
    const c = lastCall();
    expect(c.url.pathname).toBe(`/v1/catalog/price-list-versions/${VER}/items/bulk-remove`);
    expect(c.headers.get('idempotency-key')).toBe(KEY);
    expect(c.body).toEqual({ ids: [ORD] });
    await rejects(rm(VER, { ids: [] }));
    await rejects(rm(VER, { ids: Array.from({ length: 201 }, (_, i) => U(1000 + i)) }));
  });

  it('AC-13.5: publishPriceListVersion → POST /publish with If-Match, Idempotency-Key, change_reason (1–500, required) and optional effective_from', async () => {
    const pub = await mod('publishPriceListVersion');
    await pub(VER, 5, { effective_from: '2026-11-10T06:00:00.000Z', change_reason: 'Synthetic yearly revision', extra: 1 }, KEY);
    const c = lastCall();
    expect(c.url.pathname).toBe(`/v1/catalog/price-list-versions/${VER}/publish`);
    expect(c.headers.get('if-match')).toBe('"5"');
    expect(c.headers.get('idempotency-key')).toBe(KEY);
    expect(c.body).toEqual({ effective_from: '2026-11-10T06:00:00.000Z', change_reason: 'Synthetic yearly revision' });
    const before = seen.length;
    await rejects(pub(VER, 5, {}));
    await rejects(pub(VER, 5, { change_reason: '' }));
    await rejects(pub(VER, 5, { change_reason: 'r'.repeat(501) }));
    await rejects(pub(VER, 5, { change_reason: 'ok', effective_from: 'tomorrow' }));
    await rejects(pub(VER, 0, { change_reason: 'ok' }));
    expect(seen).toHaveLength(before);
  });

  it('AC-13.5 / AB-7: 403 auth.mfa_required on publish keeps its code (the UI retries with the same key)', async () => {
    server.use(http.post(`${ORIGIN}/v1/catalog/price-list-versions/:id/publish`, () => problem(403, 'auth.mfa_required')));
    const e: any = await (await mod('publishPriceListVersion'))(VER, 5, { change_reason: 'r' }, KEY).catch((x: unknown) => x);
    expect(e.status).toBe(403);
    expect(e.problem.code).toBe('auth.mfa_required');
  });

  it('discardPriceListVersionDraft → POST /discard with If-Match', async () => {
    await (await mod('discardPriceListVersionDraft'))(VER, 2);
    const c = lastCall();
    expect(c.url.pathname).toBe(`/v1/catalog/price-list-versions/${VER}/discard`);
    expect(c.headers.get('if-match')).toBe('"2"');
  });
});

describe('quote (SCR-15; AB-10, REQ-SEC-046, AC-14.1)', () => {
  const q = (o: Record<string, unknown> = {}) => ({ items: [{ orderable_id: ORD, priority: 'urgent' }], context: { credit_party_id: U(9) }, ...o });

  it('quotePrices → POST /prices/quote with exactly {items, context, at}', async () => {
    await (await mod('quotePrices'))(q({ at: '2026-11-10T06:00:00.000Z' }));
    const c = lastCall();
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/v1/catalog/prices/quote');
    expect(c.headers.get('if-match')).toBeNull();
    expect(c.body).toEqual({ items: [{ orderable_id: ORD, priority: 'urgent' }], context: { credit_party_id: U(9) }, at: '2026-11-10T06:00:00.000Z' });
  });

  it('AB-10: client-supplied unit_price / tenant_id / status / revision / created_by never reach the API', async () => {
    const quote = await mod('quotePrices');
    const before = seen.length;
    await rejects(quote(q({ unit_price: money(1) })));
    await rejects(quote(q({ tenant_id: 'evil' })));
    await rejects(quote(q({ context: { tenant_id: 'evil' } })));
    await rejects(quote(q({ items: [{ orderable_id: ORD, priority: 'urgent', unit_price: money(1) }] })));
    expect(seen).toHaveLength(before);
  });

  it('items 1…50, priority routine|urgent, uuid ids, ISO `at`', async () => {
    const quote = await mod('quotePrices');
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ orderable_id: U(2000 + i), priority: 'routine' }));
    await quote(q({ items: items(50) }));
    const before = seen.length;
    await rejects(quote(q({ items: items(51) })));
    await rejects(quote(q({ items: [] })));
    await rejects(quote(q({ items: [{ orderable_id: ORD, priority: 'rush' }] })));
    await rejects(quote(q({ context: { centre_id: 'x' } })));
    await rejects(quote(q({ at: 'yesterday' })));
    expect(seen).toHaveLength(before);
  });

  it('a mixed result (quote + per-item error) is passed through unchanged', async () => {
    const body = { quotes: [{ orderable_id: ORD, price_list_id: PL, price_list_version: 2, source: 'tenant_default', unit_price: money(90000), urgent_surcharge: money(45000), tax: { vat: 'taxable', vat_rate_bp: 1300 } }, { orderable_id: U(4), error_code: 'catalog.no_price' }] };
    server.use(http.post(`${ORIGIN}/v1/catalog/prices/quote`, () => HttpResponse.json(body)));
    expect(await (await mod('quotePrices'))(q())).toEqual(body);
  });

  it('listCentres → GET /v1/identity/centres (C2, 08 A13 D-16)', async () => {
    await (await mod('listCentres'))();
    expect(lastCall().url.pathname).toBe('/v1/identity/centres');
    expect(lastCall().method).toBe('GET');
  });
});

describe('surcharge rules (SCR-16; AC-14.1, 14.2, 14.5)', () => {
  it('listSurchargeRules → GET with scope / active_at', async () => {
    const list = await mod('listSurchargeRules');
    await list({ scope: 'department', activeAt: '2026-11-10T06:00:00.000Z' });
    const u = lastCall().url;
    expect(u.pathname).toBe('/v1/catalog/surcharge-rules');
    expect(u.searchParams.get('scope')).toBe('department');
    expect(u.searchParams.get('active_at')).toBe('2026-11-10T06:00:00.000Z');
    await rejects(list({ scope: 'planet' }));
  });

  it('createSurchargeRule: percent rule 50 % = percent_bp 5000; flat rule carries Money; Idempotency-Key; unknown fields dropped', async () => {
    const create = await mod('createSurchargeRule');
    await create({ scope: 'department', department_id: U(7), amount_kind: 'percent', percent_bp: 5000, effective_from: '2026-11-10T06:00:00.000Z', tenant_id: 'evil' }, KEY);
    expect(lastCall().body).toEqual({ scope: 'department', department_id: U(7), amount_kind: 'percent', percent_bp: 5000, effective_from: '2026-11-10T06:00:00.000Z' });
    expect(lastCall().headers.get('idempotency-key')).toBe(KEY);
    await create({ scope: 'all', amount_kind: 'flat', amount: money(20000), price_list_id: PL, effective_from: '2026-11-10T06:00:00.000Z' });
    expect(lastCall().body).toEqual({ scope: 'all', amount_kind: 'flat', amount: money(20000), price_list_id: PL, effective_from: '2026-11-10T06:00:00.000Z' });
  });

  it('createSurchargeRule rejects bp outside 1…100000, float bp, scope without its id, missing effective_from', async () => {
    const create = await mod('createSurchargeRule');
    const ok = { scope: 'all', amount_kind: 'percent', percent_bp: 5000, effective_from: '2026-11-10T06:00:00.000Z' };
    const before = seen.length;
    await rejects(create({ ...ok, percent_bp: 0 }));
    await rejects(create({ ...ok, percent_bp: 100001 }));
    await rejects(create({ ...ok, percent_bp: 12.5 }));
    await rejects(create({ ...ok, scope: 'department' })); // no department_id
    await rejects(create({ ...ok, scope: 'orderable' })); // no orderable_id
    await rejects(create({ ...ok, effective_from: undefined }));
    await rejects(create({ ...ok, amount_kind: 'flat', amount: money(-5), percent_bp: undefined }));
    expect(seen).toHaveLength(before);
  });

  it('AC-14.5: 400 common.validation_failed with path /effective_from is passed through with its field errors', async () => {
    server.use(http.post(`${ORIGIN}/v1/catalog/surcharge-rules`, () => problem(400, 'common.validation_failed', { errors: [{ path: '/effective_from', code: 'overlap', message: 'Overlaps an existing rule' }] })));
    const e: any = await (await mod('createSurchargeRule'))({ scope: 'all', amount_kind: 'percent', percent_bp: 5000, effective_from: '2026-11-10T06:00:00.000Z' }).catch((x: unknown) => x);
    expect(e.status).toBe(400);
    expect(JSON.stringify(e.problem)).toContain('/effective_from');
  });

  it('endSurchargeRule → POST /{id}/end with If-Match and optional effective_to', async () => {
    await (await mod('endSurchargeRule'))(U(5), 2, { effective_to: '2026-12-01T00:00:00.000Z' });
    const c = lastCall();
    expect(c.url.pathname).toBe(`/v1/catalog/surcharge-rules/${U(5)}/end`);
    expect(c.headers.get('if-match')).toBe('"2"');
    expect(c.body).toEqual({ effective_to: '2026-12-01T00:00:00.000Z' });
    await rejects((await mod('endSurchargeRule'))(U(5), 2, { effective_to: 'soon' }));
  });
});

describe('tax types + rules (SCR-17; AC-15.2, 15.5)', () => {
  it('listTaxTypes → all_versions / active_at; listTaxRules → scope / active_at', async () => {
    await (await mod('listTaxTypes'))({ allVersions: true });
    expect(lastCall().url.pathname).toBe('/v1/catalog/tax-types');
    expect(lastCall().url.searchParams.get('all_versions')).toBe('true');
    await (await mod('listTaxRules'))({ scope: 'tenant_default' });
    expect(lastCall().url.pathname).toBe('/v1/catalog/tax-rules');
    expect(lastCall().url.searchParams.get('scope')).toBe('tenant_default');
    await rejects((await mod('listTaxRules'))({ scope: 'all' }));
  });

  it('createTaxType: code upper-cased and ^[A-Z0-9_]{1,16}$; rate_bp optional 0…10000 integer; Idempotency-Key', async () => {
    const create = await mod('createTaxType');
    await create({ code: ' hst ', display: 'Harmonised sales tax', rate_bp: 1350, effective_from: '2026-11-10T06:00:00.000Z', scope: 'global' }, KEY);
    expect(lastCall().body).toEqual({ code: 'HST', display: 'Harmonised sales tax', rate_bp: 1350, effective_from: '2026-11-10T06:00:00.000Z' });
    expect(lastCall().headers.get('idempotency-key')).toBe(KEY);
    await create({ code: 'NORATE', display: 'No rate yet' }); // rate may stay empty
    expect(lastCall().body).toEqual({ code: 'NORATE', display: 'No rate yet' });
    const before = seen.length;
    await rejects(create({ code: 'A'.repeat(17), display: 'x' }));
    await rejects(create({ code: 'bad code', display: 'x' }));
    await rejects(create({ code: 'OK', display: 'x', rate_bp: 10001 }));
    await rejects(create({ code: 'OK', display: 'x', rate_bp: 13.5 }));
    await rejects(create({ code: 'OK', display: 'x', rate_bp: -1 }));
    expect(seen).toHaveLength(before);
  });

  it('updateTaxType → PATCH with If-Match; only display / rate_bp / effective_from / is_active', async () => {
    await (await mod('updateTaxType'))(U(6), 2, { rate_bp: 1400, effective_from: '2026-12-01T00:00:00.000Z', code: 'HACK' });
    const c = lastCall();
    expect(c.method).toBe('PATCH');
    expect(c.headers.get('if-match')).toBe('"2"');
    expect(c.body).toEqual({ rate_bp: 1400, effective_from: '2026-12-01T00:00:00.000Z' });
  });

  it('createTaxRule: scopes, VAT treatment exempt|taxable, hs_code 4–8 digits, other_tax_code regex; Idempotency-Key', async () => {
    const create = await mod('createTaxRule');
    await create({ scope: 'tenant_default', vat_treatment: 'exempt', hs_code: '9018', other_tax_code: 'CESS', effective_from: '2026-11-10T06:00:00.000Z', tenant_id: 'evil' }, KEY);
    expect(lastCall().body).toEqual({ scope: 'tenant_default', vat_treatment: 'exempt', hs_code: '9018', other_tax_code: 'CESS', effective_from: '2026-11-10T06:00:00.000Z' });
    expect(lastCall().headers.get('idempotency-key')).toBe(KEY);
    const ok = { scope: 'tenant_default', vat_treatment: 'taxable', effective_from: '2026-11-10T06:00:00.000Z' };
    const before = seen.length;
    await rejects(create({ ...ok, vat_treatment: 'maybe' })); // D-C3-04: no default treatment, no third value
    await rejects(create({ ...ok, vat_treatment: undefined }));
    await rejects(create({ ...ok, hs_code: '123' }));
    await rejects(create({ ...ok, hs_code: '123456789' }));
    await rejects(create({ ...ok, hs_code: '90 18' }));
    await rejects(create({ ...ok, other_tax_code: 'bad code' }));
    await rejects(create({ ...ok, scope: 'department' })); // no department_id
    await rejects(create({ ...ok, scope: 'orderable' })); // no orderable_id
    expect(seen).toHaveLength(before);
  });

  it('AC-15.2: 400 path /other_tax_code ("tax type has no rate") is passed through', async () => {
    server.use(http.post(`${ORIGIN}/v1/catalog/tax-rules`, () => problem(400, 'common.validation_failed', { errors: [{ path: '/other_tax_code', code: 'tax_type_no_rate', message: 'tax type has no rate' }] })));
    const e: any = await (await mod('createTaxRule'))({ scope: 'tenant_default', vat_treatment: 'exempt', other_tax_code: 'HST', effective_from: '2026-11-10T06:00:00.000Z' }).catch((x: unknown) => x);
    expect(e.status).toBe(400);
    expect(JSON.stringify(e.problem)).toContain('/other_tax_code');
  });

  it('endTaxRule → POST /{id}/end with If-Match', async () => {
    await (await mod('endTaxRule'))(U(8), 6, {});
    const c = lastCall();
    expect(c.url.pathname).toBe(`/v1/catalog/tax-rules/${U(8)}/end`);
    expect(c.headers.get('if-match')).toBe('"6"');
  });
});
