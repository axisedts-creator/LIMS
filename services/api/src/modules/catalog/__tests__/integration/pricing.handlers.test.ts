// T-17 (C3) — price lists HTTP contract + probes: the eleven handlers #71–#81 are real (no longer CR-C3-008 stubs) and honour catalog.yaml.
// Spec: 06-PLAN T-17; 02-TRD §5 rows 71–81, §5.0 (If-Match on PATCH/PUT and on state actions on an existing resource: 428 missing / 409 stale; Idempotency-Key on the creates),
//       §6.2 (the handler gets its ports from ctx.ports — same convention as referrers/creditParties/imports handlers); 01-PRD AC-13.3–13.8; 07-SECURITY S-1, S-4, S-5, S-16, AB-1, AB-3, AB-10.
// Same harness conventions as creditParties.handlers.test.ts (T-16): handlers driven with a request-shaped object + the HandlerContext subset; responses validated against the
// OpenAPI schemas. Path params: `price_list_id` (#73–#76) and `price_list_version_id` (#77–#81). If-Match is the raw header `"<n>"`. The core pipeline (schema validation, auth,
// x-permission, aal2, Idempotency-Key replay) is not re-tested here — only that the contract DECLARES it (S-4 / S-16 facts).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec, operationIds } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { ROOT_A, TENANT_A, TENANT_B } from '../helpers/catalogDb.js';
import { ID, type Row } from '../helpers/mastersDb.js';
import { MANAGE, READ, actorIdentity, centre, defaultList, doc, makePricingDb, orderable, party, passign, pitem, plist, pver } from '../helpers/pricingDb.js';

const T = 20_000;
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true, formats: { email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ } });
const validatorFor = (name: string) => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return (x: unknown) => { const ok = v(x); return ok ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
};
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const IDS = ['listPriceLists', 'createPriceList', 'getPriceListDetail', 'updatePriceList', 'replacePriceListAssignments', 'createPriceListVersionDraft', 'listPriceListItems',
  'upsertPriceListItems', 'removePriceListItems', 'publishPriceListVersion', 'discardPriceListVersionDraft'] as const;
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const bare = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } });
const KEY = { 'idempotency-key': 'k-1' };
const A = TENANT_A;
const B = TENANT_B;
const REASON = 'Synthetic change reason';
const money = (n: number) => ({ amount_paisa: n, currency: 'NPR' });

const O1 = orderable(1, A, { code: 'CBC' }); const O2 = orderable(2, A, { code: 'FBS', kind: 'panel' }); const OB = orderable(9, B, { code: 'BSECRET' });
const C1 = centre(1, A); const CB = centre(9, B); const P1 = party(1, A);
const X = doc(1, A, { doctor_code: 'DRX1' }); const XB = doc(9, B, { doctor_code: 'DRB1' });
const DEF = defaultList(1, A); const LB = plist(9, B, { owner_kind: 'credit_party', code: 'BLIST' }); const VB = pver(9, B, LB.id as string, 1);
const BASE: Record<string, Row[]> = { orderables: [O1, O2, OB], collection_centres: [C1, CB], credit_parties: [P1], doctors: [X, XB], price_lists: [DEF, LB], price_list_versions: [VB] };
const mk = (rows: Record<string, Row[]> = {}) => {
  const merged: Record<string, Row[]> = { ...BASE };
  for (const [k, v] of Object.entries(rows)) merged[k] = [...(merged[k] ?? []), ...v];
  return makePricingDb({ rows: merged as never, catalog: { state: { [A]: { rootId: ROOT_A, revision: 417 } } } });
};
type Db = ReturnType<typeof mk>;
const at = new Date(Date.UTC(2026, 10, 7, 12, 0, 0));
/** Runs one handler in one transaction with the given permission set behind ctx.ports.IdentityPort. */
const call = (db: Db, id: string, r: ReturnType<typeof req>, perms: readonly string[] = [READ, MANAGE]) =>
  db.run((ctx) => H[id]!(r, ctx), { at, ctx: { ports: { IdentityPort: actorIdentity(perms) } } });
const IM1 = { 'if-match': '"1"' };

describe('the 11 operations exist in the contract with the TRD permissions / idempotency / If-Match (S-4, S-16)', () => {
  it('operationIds are in catalog.yaml and in the manifest handlers (the real ones, not the stubs)', () => {
    const ids = operationIds(spec);
    for (const id of IDS) { expect(ids).toContain(id); expect(typeof (manifest.handlers as any)[id]).toBe('function'); expect((manifest.handlers as any)[id]).toBe(H[id]); }
  });
  it('reads = catalog.price_list.read; every write = catalog.price_list.manage (publish is privileged: aal2 is enforced by the core on this x-permission)', () => {
    for (const id of ['listPriceLists', 'getPriceListDetail', 'listPriceListItems']) expect(opOf(id)['x-permission'], id).toBe('catalog.price_list.read');
    for (const id of IDS.filter((i) => !['listPriceLists', 'getPriceListDetail', 'listPriceListItems'].includes(i))) expect(opOf(id)['x-permission'], id).toBe('catalog.price_list.manage');
  });
  it('Idempotency-Key required on create / draft create / upsert / remove / publish (P-8); none on list, get, update, replace; optional on discard', () => {
    for (const id of ['createPriceList', 'createPriceListVersionDraft', 'upsertPriceListItems', 'removePriceListItems', 'publishPriceListVersion']) expect(opOf(id)['x-idempotency'], id).toBe('required');
    for (const id of ['listPriceLists', 'getPriceListDetail', 'listPriceListItems', 'updatePriceList', 'replacePriceListAssignments']) expect(opOf(id)['x-idempotency'], id).toBe('none');
    expect(opOf('discardPriceListVersionDraft')['x-idempotency']).toBe('optional');
  });
  it('If-Match is declared on update, replace, publish and discard — and only there; path params are price_list_id / price_list_version_id', () => {
    for (const id of ['updatePriceList', 'replacePriceListAssignments', 'publishPriceListVersion', 'discardPriceListVersionDraft']) expect(JSON.stringify(opOf(id).parameters), id).toContain('IfMatch');
    for (const id of ['createPriceList', 'createPriceListVersionDraft', 'upsertPriceListItems', 'removePriceListItems', 'listPriceLists', 'listPriceListItems']) expect(JSON.stringify(opOf(id).parameters ?? []), id).not.toContain('IfMatch');
    for (const id of ['getPriceListDetail', 'updatePriceList', 'replacePriceListAssignments', 'createPriceListVersionDraft']) expect(opOf(id).parameters.some((p: any) => p.name === 'price_list_id' && p.in === 'path'), id).toBe(true);
    for (const id of ['listPriceListItems', 'upsertPriceListItems', 'removePriceListItems', 'publishPriceListVersion', 'discardPriceListVersionDraft']) expect(opOf(id).parameters.some((p: any) => p.name === 'price_list_version_id' && p.in === 'path'), id).toBe(true);
  });
  it('contract facts the service relies on (AC-13.5, AC-13.8, S-5, E18): request schemas are closed and carry no server-owned field; PriceMoney is integer paisa 0..999,999,999 NPR; batches 1..200; change_reason is required', () => {
    const s = spec.components.schemas;
    for (const n of ['PriceListCreate', 'PriceListUpdate', 'PriceListAssignmentsReplace', 'PriceListVersionDraftCreate', 'PriceItemsUpsert', 'PriceItemsRemove', 'PriceItemInput', 'PublishRequest', 'PriceMoney']) {
      expect(s[n].additionalProperties, n).toBe(false);
      for (const k of ['tenant_id', 'status', 'version', 'created_by', 'unit_price_paisa']) expect(Object.keys(s[n].properties), `${n}.${k}`).not.toContain(k);
    }
    expect(s['PriceMoney'].properties.amount_paisa).toMatchObject({ type: 'integer', minimum: 0, maximum: 999999999 });
    expect(s['PriceMoney'].properties.currency.enum).toEqual(['NPR']);
    expect(s['PriceItemsUpsert'].properties.items).toMatchObject({ minItems: 1, maxItems: 200 });
    expect(s['PriceItemsRemove'].properties.ids).toMatchObject({ minItems: 1, maxItems: 200 });
    expect(s['PublishRequest'].required).toContain('change_reason');
    expect(Object.keys(s['PriceListUpdate'].properties).sort()).toEqual(['falls_through', 'is_active', 'name']);
    expect(s['PriceListAssignmentsReplace'].properties.owner_ids.maxItems).toBe(500);
  });
});

describe('probes (CR-C3-008): the price-list stubs are gone', () => {
  const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
  it('none of the eleven operationIds is listed in probes/pending.json any more', () => {
    for (const id of IDS) expect(pending, id).not.toContain(id);
  });
  it.each(IDS)('%s does not answer 503 common.service_unavailable / not_implemented', { timeout: T }, async (id) => {
    const e = await call(mk(), id, req({ params: { price_list_id: ID(0x1), price_list_version_id: ID(0x2) }, headers: { ...IM1, ...KEY }, body: {} })).then(() => undefined, (x) => x);
    expect(e?.code).not.toBe('common.service_unavailable');
    expect(e?.detail).not.toBe('not_implemented');
  });
});

describe('price lists — handlers over the service, validated against the OpenAPI schemas (F-12: create, edit, publish)', () => {
  const listOk = validatorFor('PriceList'); const detailOk = validatorFor('PriceListDetail'); const pageOk = validatorFor('PriceListPage');
  const verOk = validatorFor('PriceListVersion'); const resultsOk = validatorFor('PriceItemResults'); const itemsOk = validatorFor('PriceItemPage');

  it('full flow: POST create (201 PriceList) -> GET detail (PriceListDetail) -> GET list (PriceListPage) -> POST bulk-upsert (200 PriceItemResults) -> GET items (PriceItemPage) -> POST publish with If-Match (200 PriceListVersion) -> upsert again = 409 version_in_use (AC-13.4) -> POST draft (201) -> POST discard (200)', { timeout: T }, async () => {
    const db = mk();
    const created = await call(db, 'createPriceList', req({ headers: KEY, body: { code: 'hosp1', name: 'Synthetic Hospital', owner_kind: 'credit_party', assignments: [{ owner_id: P1.id }] } }));
    expect(created.status).toBe(201);
    expect(listOk(created.body)).toEqual([]);
    expect(created.body).toMatchObject({ code: 'HOSP1', owner_kind: 'credit_party', assignments: [{ owner_id: P1.id }], version: 1 });
    const id = created.body.id; const v1 = created.body.draft_version_id;

    const d = await call(db, 'getPriceListDetail', req({ params: { price_list_id: id } }));
    expect(d.status).toBe(200); expect(detailOk(d.body)).toEqual([]);
    expect(d.body.versions).toEqual([expect.objectContaining({ id: v1, version_no: 1, status: 'draft', item_count: 0 })]);

    const l = await call(db, 'listPriceLists', req());
    expect(l.status).toBe(200); expect(pageOk(l.body)).toEqual([]);
    expect(l.body.data.map((x: Row) => x.code).sort()).toEqual(['DEFAULT1', 'HOSP1']);

    const up = await call(db, 'upsertPriceListItems', req({ params: { price_list_version_id: v1 }, headers: KEY, body: { items: [{ orderable_id: O1.id, unit_price: money(90_000) }, { orderable_id: O2.id, unit_price: money(1_500) }, { orderable_id: OB.id, unit_price: money(1) }] } }));
    expect(up.status).toBe(200); expect(resultsOk(up.body)).toEqual([]);
    expect(Object.fromEntries(up.body.results.map((r: Row) => [r.orderable_id, r.outcome]))).toEqual({ [O1.id as string]: 'created', [O2.id as string]: 'created', [OB.id as string]: 'error' });
    expect(up.body.results.find((r: Row) => r.orderable_id === OB.id).error_code).toBe('common.not_found');

    const it1 = await call(db, 'listPriceListItems', req({ params: { price_list_version_id: v1 }, query: { sort: '-orderable_code' } }));
    expect(it1.status).toBe(200); expect(itemsOk(it1.body)).toEqual([]);
    expect(it1.body.data.map((x: Row) => [x.orderable_code, x.orderable_kind, x.unit_price.amount_paisa])).toEqual([['FBS', 'panel', 1_500], ['CBC', 'test', 90_000]]);

    const pub = await call(db, 'publishPriceListVersion', req({ params: { price_list_version_id: v1 }, headers: { ...IM1, ...KEY }, body: { change_reason: REASON } }));
    expect(pub.status).toBe(200); expect(verOk(pub.body)).toEqual([]);
    expect(pub.body).toMatchObject({ id: v1, price_list_id: id, version_no: 1, status: 'published', change_reason: REASON, item_count: 2, version: 2 });

    const e = await rejection(call(db, 'upsertPriceListItems', req({ params: { price_list_version_id: v1 }, headers: { 'idempotency-key': 'k-2' }, body: { items: [{ orderable_id: O1.id, unit_price: money(1) }] } })));
    expect(isLimsError(e, 'catalog.version_in_use')).toBe(true); expect(e.statusCode).toBe(409);

    const dr = await call(db, 'createPriceListVersionDraft', req({ params: { price_list_id: id }, headers: { 'idempotency-key': 'k-3' }, body: { copy_from_version_no: 1 } }));
    expect(dr.status).toBe(201); expect(verOk(dr.body)).toEqual([]);
    expect(dr.body).toMatchObject({ version_no: 2, status: 'draft', item_count: 2 });

    const dis = await call(db, 'discardPriceListVersionDraft', req({ params: { price_list_version_id: dr.body.id }, headers: IM1 }));
    expect(dis.status).toBe(200); expect(verOk(dis.body)).toEqual([]); expect(dis.body.status).toBe('discarded');
    expect(db.revisionOf(A)).toBe(419);                                                       // create (created) + publish (versioned); draft edits and discard bump nothing
  });

  it('PATCH update (If-Match "1") -> 200 PriceList v2; the default list refuses is_active:false with 400; 428 without If-Match, 409 on a stale one', { timeout: T }, async () => {
    const db = mk();
    const ok = await call(db, 'updatePriceList', req({ params: { price_list_id: DEF.id }, headers: IM1, body: { name: 'Walk-in', falls_through: false } }));
    expect(ok.status).toBe(200); expect(listOk(ok.body)).toEqual([]);
    expect(ok.body).toMatchObject({ name: 'Walk-in', falls_through: false, version: 2 });
    const off = await rejection(call(db, 'updatePriceList', req({ params: { price_list_id: DEF.id }, headers: { 'if-match': '"2"' }, body: { is_active: false } })));
    expect(off.statusCode).toBe(400);
    const a = await rejection(call(db, 'updatePriceList', req({ params: { price_list_id: DEF.id }, body: { name: 'x' } })));
    expect(isLimsError(a, 'common.precondition_required')).toBe(true); expect(a.statusCode).toBe(428);
    const b = await rejection(call(db, 'updatePriceList', req({ params: { price_list_id: DEF.id }, headers: IM1, body: { name: 'x' } })));
    expect(isLimsError(b, 'common.version_conflict')).toBe(true); expect(b.statusCode).toBe(409);
    expect(db.row('price_lists', DEF.id as string)).toMatchObject({ name: 'Walk-in', is_active: true, version: 2 });
  });

  it('PUT assignments -> 200 PriceList; AC-13.7 second owner -> 409 catalog.code_duplicate; AB-3 tenant-B centre / doctor -> 404; 428 without If-Match', { timeout: T }, async () => {
    const LC = plist(4, A, { owner_kind: 'centre', code: 'CENT1' }); const LC2 = plist(5, A, { owner_kind: 'centre', code: 'CENT2' });
    const db = mk({ price_lists: [LC, LC2], price_list_assignments: [passign(1, A, LC2.id as string, 'centre', C1.id as string)] });
    const ok = await call(db, 'replacePriceListAssignments', req({ params: { price_list_id: LC.id }, headers: IM1, body: { owner_ids: [] } }));
    expect(ok.status).toBe(200); expect(listOk(ok.body)).toEqual([]); expect(ok.body.assignments).toEqual([]);
    const dup = await rejection(call(db, 'replacePriceListAssignments', req({ params: { price_list_id: LC.id }, headers: { 'if-match': '"2"' }, body: { owner_ids: [C1.id] } })));
    expect(isLimsError(dup, 'catalog.code_duplicate')).toBe(true); expect(dup.statusCode).toBe(409);
    const foreign = await rejection(call(db, 'replacePriceListAssignments', req({ params: { price_list_id: LC.id }, headers: { 'if-match': '"2"' }, body: { owner_ids: [CB.id] } })));
    expect(isLimsError(foreign, 'common.not_found')).toBe(true); expect(foreign.statusCode).toBe(404);
    const LR = plist(6, A, { owner_kind: 'referrer', code: 'DOCX1' });
    const db2 = mk({ price_lists: [LR] });
    const fd = await rejection(call(db2, 'replacePriceListAssignments', req({ params: { price_list_id: LR.id }, headers: IM1, body: { owner_ids: [XB.id] } })));
    expect(fd.statusCode).toBe(404);
    const noIm = await rejection(call(db, 'replacePriceListAssignments', req({ params: { price_list_id: LC.id }, body: { owner_ids: [] } })));
    expect(isLimsError(noIm, 'common.precondition_required')).toBe(true); expect(noIm.statusCode).toBe(428);
    expect(db.rows('price_list_assignments', A).map((r) => r.centre_id)).toEqual([C1.id]);
  });

  it('AC-13.6: a second default list -> 409 catalog.code_duplicate; AC-13.5: publish without change_reason -> 400, nothing published', { timeout: T }, async () => {
    const db = mk();
    const e = await rejection(call(db, 'createPriceList', req({ headers: KEY, body: { code: 'DEF2', name: 'x', owner_kind: 'default', assignments: [] } })));
    expect(isLimsError(e, 'catalog.code_duplicate')).toBe(true); expect(e.statusCode).toBe(409);
    const V = pver(2, A, DEF.id as string, 1);
    const db2 = mk({ price_list_versions: [V] });
    const bad = await rejection(call(db2, 'publishPriceListVersion', req({ params: { price_list_version_id: V.id }, headers: { ...IM1, ...KEY }, body: {} })));
    expect(bad.statusCode).toBe(400);
    expect(db2.row('price_list_versions', V.id as string)!.status).toBe('draft');
  });

  it.each([
    ['publish', 'publishPriceListVersion', { change_reason: REASON }, true], ['discard', 'discardPriceListVersionDraft', undefined, true],
  ])('%s: no If-Match -> 428; stale -> 409 common.version_conflict; malformed If-Match -> 400; never a write', { timeout: T }, async (_n, op, body, _x) => {
    const V = pver(2, A, DEF.id as string, 1, { version: 3 });
    const db = mk({ price_list_versions: [V] });
    const p = { price_list_version_id: V.id };
    const a = await rejection(call(db, op, req({ params: p, headers: KEY, body })));
    expect(isLimsError(a, 'common.precondition_required')).toBe(true); expect(a.statusCode).toBe(428);
    const b = await rejection(call(db, op, req({ params: p, headers: { ...KEY, 'if-match': '"2"' }, body })));
    expect(isLimsError(b, 'common.version_conflict')).toBe(true); expect(b.statusCode).toBe(409);
    for (const h of ['3', 'W/"3"', '*', '"0"', '"abc"', '']) expect((await rejection(call(db, op, req({ params: p, headers: { ...KEY, 'if-match': h }, body })))).statusCode, h).toBe(400);
    expect(db.row('price_list_versions', V.id as string)).toMatchObject({ status: 'draft', version: 3 });
    expect(db.events).toHaveLength(0);
  });

  it.each([['update', 'updatePriceList', { name: 'x' }], ['replace', 'replacePriceListAssignments', { owner_ids: [] }]])
  ('%s: malformed If-Match -> 400, never 500, never a write', { timeout: T }, async (_n, op, body) => {
    const db = mk();
    for (const h of ['1', 'W/"1"', '*', '"0"', '"01"', '"-1"', '"99999999999"', '']) {
      expect((await rejection(call(db, op, req({ params: { price_list_id: DEF.id }, headers: { 'if-match': h }, body })))).statusCode, h).toBe(400);
    }
    expect(db.row('price_lists', DEF.id as string)!.version).toBe(1); expect(db.events).toHaveLength(0);
  });

  it('GET list passes the filters through (owner_kind, owner_id, is_active, cursor, limit) and rejects bad ones with 400', { timeout: T }, async () => {
    const LC = plist(4, A, { owner_kind: 'centre', code: 'CENT1' });
    const db = mk({ price_lists: [LC, plist(5, A, { owner_kind: 'centre', code: 'OLD', is_active: false })], price_list_assignments: [passign(1, A, LC.id as string, 'centre', C1.id as string)] });
    expect((await call(db, 'listPriceLists', req({ query: { owner_kind: 'centre' } }))).body.data.map((d: Row) => d.code)).toEqual(['CENT1']);
    expect((await call(db, 'listPriceLists', req({ query: { owner_id: C1.id } }))).body.data.map((d: Row) => d.code)).toEqual(['CENT1']);
    expect((await call(db, 'listPriceLists', req({ query: { is_active: 'false' } }))).body.data.map((d: Row) => d.code)).toEqual(['OLD']);
    const first = await call(db, 'listPriceLists', req({ query: { is_active: 'all', limit: 2 } }));
    expect(pageOk(first.body)).toEqual([]); expect(first.body.data).toHaveLength(2);
    const next = await call(db, 'listPriceLists', req({ query: { is_active: 'all', limit: 2, cursor: first.body.page.next_cursor } }));
    expect([...first.body.data, ...next.body.data].map((d: Row) => d.code).sort()).toEqual(['CENT1', 'DEFAULT1', 'OLD']);
    for (const query of [{ owner_kind: 'vendor' }, { is_active: 'maybe' }, { limit: 0 }, { limit: 201 }, { cursor: '!!!' }, { owner_id: 'x' }]) {
      expect((await rejection(call(db, 'listPriceLists', req({ query })))).statusCode, JSON.stringify(query)).toBe(400);
    }
  });

  it('S-1 / AB-1: tenant B\'s list id and version id -> 404 on every operation that takes one; B\'s rows are untouched; no B value in any error', { timeout: T }, async () => {
    const db = mk();
    const before = JSON.stringify([db.rows('price_lists', B), db.rows('price_list_versions', B), db.rows('price_list_items', B)]);
    const ops: Array<[string, ReturnType<typeof req>]> = [
      ['getPriceListDetail', req({ params: { price_list_id: LB.id } })],
      ['updatePriceList', req({ params: { price_list_id: LB.id }, headers: IM1, body: { name: 'hijack' } })],
      ['replacePriceListAssignments', req({ params: { price_list_id: LB.id }, headers: IM1, body: { owner_ids: [] } })],
      ['createPriceListVersionDraft', req({ params: { price_list_id: LB.id }, headers: KEY, body: {} })],
      ['listPriceListItems', req({ params: { price_list_version_id: VB.id } })],
      ['upsertPriceListItems', req({ params: { price_list_version_id: VB.id }, headers: KEY, body: { items: [{ orderable_id: O1.id, unit_price: money(1) }] } })],
      ['removePriceListItems', req({ params: { price_list_version_id: VB.id }, headers: KEY, body: { ids: [O1.id] } })],
      ['publishPriceListVersion', req({ params: { price_list_version_id: VB.id }, headers: { ...IM1, ...KEY }, body: { change_reason: REASON } })],
      ['discardPriceListVersionDraft', req({ params: { price_list_version_id: VB.id }, headers: IM1 })],
    ];
    for (const [op, r] of ops) {
      const e = await rejection(call(db, op, r));
      expect(isLimsError(e, 'common.not_found'), op).toBe(true); expect(e.statusCode, op).toBe(404);
      expect(JSON.stringify([e.message, e.detail, e.errors]), op).not.toMatch(/BLIST|BSECRET|Synthetic List 9/);
    }
    expect(JSON.stringify([db.rows('price_lists', B), db.rows('price_list_versions', B), db.rows('price_list_items', B)])).toBe(before);
    expect(db.events).toHaveLength(0);
  });

  it('S-5 / AB-10: mass assignment through the handlers -> 400, nothing written', { timeout: T }, async () => {
    const db = mk();
    for (const extra of [{ tenant_id: B }, { version: 7 }, { id: ID(0xbad) }, { is_active: false }, { status: 'published' }, { unit_price: 5 }]) {
      expect((await rejection(call(db, 'createPriceList', req({ headers: KEY, body: { code: 'NEW1', name: 'x', owner_kind: 'centre', assignments: [], ...extra } })))).statusCode, JSON.stringify(extra)).toBe(400);
    }
    for (const patch of [{ code: 'RENAMED' }, { owner_kind: 'centre' }, { tenant_id: B }, { version: 9 }, { assignments: [] }]) {
      expect((await rejection(call(db, 'updatePriceList', req({ params: { price_list_id: DEF.id }, headers: IM1, body: patch })))).statusCode, JSON.stringify(patch)).toBe(400);
    }
    expect(db.rows('price_lists', A)).toHaveLength(1); expect(db.row('price_lists', DEF.id as string)).toMatchObject({ version: 1, code: 'DEFAULT1' });
    expect(db.events).toHaveLength(0);
  });

  it('a read-only caller (catalog.price_list.read) that reaches a read handler gets the data (no field is role-restricted in price lists)', { timeout: T }, async () => {
    const db = mk();
    const r = await call(db, 'listPriceLists', req(), [READ]);
    expect(r.status).toBe(200); expect(pageOk(r.body)).toEqual([]);
  });

  it('fails closed without an authenticated request context: auth.unauthenticated for all eleven operations, nothing reflected', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    for (const id of IDS) {
      const e = await rejection(H[id]!(req({ params: { price_list_id: ID(1), price_list_version_id: ID(2) }, headers: { ...IM1, ...KEY }, query: {}, body: { name: planted, code: planted, change_reason: planted } }), bare(id)));
      expect(isLimsError(e, 'auth.unauthenticated'), id).toBe(true);
      expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain(planted);
    }
  });

  it('every handler response body is free of server-internal fields (tenant_id, created_by, updated_by, published_by, unit_price_paisa, published_at)', { timeout: T }, async () => {
    const V = pver(2, A, DEF.id as string, 1);
    const db = mk({ price_list_versions: [V], price_list_items: [pitem(1, A, V.id as string, O1.id as string, 100)] });
    const bodies = [
      (await call(db, 'getPriceListDetail', req({ params: { price_list_id: DEF.id } }))).body,
      (await call(db, 'listPriceLists', req())).body,
      (await call(db, 'listPriceListItems', req({ params: { price_list_version_id: V.id } }))).body,
      (await call(db, 'publishPriceListVersion', req({ params: { price_list_version_id: V.id }, headers: { ...IM1, ...KEY }, body: { change_reason: REASON } }))).body,
    ];
    expect(JSON.stringify(bodies)).not.toMatch(/"(tenant_id|created_by|updated_by|published_by|unit_price_paisa|published_at|created_at|updated_at)"/);
  });
});
