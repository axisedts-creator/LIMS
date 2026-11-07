// T-18 (C3) — surcharge / tax HTTP contract + probes: the nine handlers #83–#91 are real (no longer CR-C3-008 stubs) and honour catalog.yaml.
// Spec: 06-PLAN T-18; 02-TRD §5 rows 83–91, §5.0 (If-Match on PATCH and on the state actions /end: 428 missing / 409 stale; Idempotency-Key on the creates), §6.2 (ports from ctx.ports);
//       01-PRD AC-14.5, AC-15.2, AC-15.5; 07-SECURITY S-1, S-4, S-5, S-16, AB-1, AB-3, AB-10.
// Same harness conventions as pricing.handlers.test.ts (T-17): handlers driven with a request-shaped object + the HandlerContext subset; responses validated against the OpenAPI schemas.
// Path params: `surcharge_rule_id` (#85), `tax_type_id` (#88), `tax_rule_id` (#91). If-Match is the raw header `"<n>"`. The core pipeline (schema validation, auth, x-permission, Idempotency-Key
// replay) is not re-tested here — only that the contract DECLARES it (S-4 / S-16 facts). Handler status codes: lists 200; creates 201; PATCH / end 200.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec, operationIds } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { ROOT_A, TENANT_A, TENANT_B } from '../helpers/catalogDb.js';
import { type Row } from '../helpers/mastersDb.js';
import { MANAGE, READ, actorIdentity, dept, makeTaxDb, orderable, srule, trule, ttype } from '../helpers/taxDb.js';

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

const IDS = ['listSurchargeRules', 'createSurchargeRule', 'endSurchargeRule', 'listTaxTypes', 'createTaxType', 'updateTaxType', 'listTaxRules', 'createTaxRule', 'endTaxRule'] as const;
const READS = ['listSurchargeRules', 'listTaxTypes', 'listTaxRules'];
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const bare = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } });
const KEY = { 'idempotency-key': 'k-1' };
const A = TENANT_A;
const B = TENANT_B;
const money = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const at = new Date(Date.UTC(2026, 10, 7, 12, 0, 0));
const iso = (d: Date) => d.toISOString();
const T0 = new Date('2026-01-01T00:00:00.000Z');

const D1 = dept(1, A); const O1 = orderable(1, A, { code: 'CBC', department_id: D1.id }); const OB = orderable(9, B, { code: 'BSECRET' });
const BASE: Record<string, Row[]> = { departments: [D1, dept(9, B)], orderables: [O1, OB] };
const mk = (rows: Record<string, Row[]> = {}) => {
  const merged: Record<string, Row[]> = { ...BASE };
  for (const [k, v] of Object.entries(rows)) merged[k] = [...(merged[k] ?? []), ...v];
  return makeTaxDb({ rows: merged as never, catalog: { state: { [A]: { rootId: ROOT_A, revision: 417 } } } });
};
type Db = ReturnType<typeof mk>;
const call = (db: Db, id: string, r: ReturnType<typeof req>, perms: readonly string[] = [READ, MANAGE]) =>
  db.run((ctx) => H[id]!(r, ctx), { at, ctx: { ports: { IdentityPort: actorIdentity(perms) } } });
const IM1 = { 'if-match': '"1"' };

describe('the 9 operations exist in the contract with the TRD permissions / idempotency / If-Match (S-4, S-16)', () => {
  it('operationIds are in catalog.yaml and in the manifest handlers (the real ones, not the stubs)', () => {
    const ids = operationIds(spec);
    for (const id of IDS) { expect(ids).toContain(id); expect(typeof (manifest.handlers as any)[id]).toBe('function'); expect((manifest.handlers as any)[id]).toBe(H[id]); }
  });
  it('reads = catalog.price_list.read; every write = catalog.price_list.manage', () => {
    for (const id of IDS) expect(opOf(id)['x-permission'], id).toBe(READS.includes(id) ? 'catalog.price_list.read' : 'catalog.price_list.manage');
  });
  it('Idempotency-Key required on the three creates; none on lists and PATCH; optional on the /end actions', () => {
    for (const id of ['createSurchargeRule', 'createTaxType', 'createTaxRule']) expect(opOf(id)['x-idempotency'], id).toBe('required');
    for (const id of [...READS, 'updateTaxType']) expect(opOf(id)['x-idempotency'], id).toBe('none');
    for (const id of ['endSurchargeRule', 'endTaxRule']) expect(opOf(id)['x-idempotency'], id).toBe('optional');
  });
  it('If-Match is declared on PATCH tax-type and on both /end actions — and nowhere else; path params are surcharge_rule_id / tax_type_id / tax_rule_id', () => {
    for (const id of ['updateTaxType', 'endSurchargeRule', 'endTaxRule']) expect(JSON.stringify(opOf(id).parameters), id).toContain('IfMatch');
    for (const id of [...READS, 'createSurchargeRule', 'createTaxType', 'createTaxRule']) expect(JSON.stringify(opOf(id).parameters ?? []), id).not.toContain('IfMatch');
    for (const [id, p] of [['endSurchargeRule', 'surcharge_rule_id'], ['updateTaxType', 'tax_type_id'], ['endTaxRule', 'tax_rule_id']] as const) expect(opOf(id).parameters.some((x: any) => x.name === p && x.in === 'path'), id).toBe(true);
  });
  it('contract facts the service relies on (S-5, 05-SCHEMA): request schemas are closed and carry no server-owned field; ranges match the CHECK constraints', () => {
    const s = spec.components.schemas;
    for (const n of ['SurchargeRuleCreate', 'TaxTypeCreate', 'TaxTypeUpdate', 'TaxRuleCreate', 'EndRequest']) {
      expect(s[n].additionalProperties, n).toBe(false);
      for (const k of ['tenant_id', 'id', 'version', 'created_by']) expect(Object.keys(s[n].properties), `${n}.${k}`).not.toContain(k);
    }
    expect(s['SurchargeRuleCreate'].properties.percent_bp).toMatchObject({ type: 'integer', minimum: 1, maximum: 100000 });
    expect(s['TaxTypeCreate'].properties.rate_bp).toMatchObject({ type: 'integer', minimum: 0, maximum: 10000 });
    expect(Object.keys(s['TaxTypeCreate'].properties).sort()).toEqual(['code', 'display', 'effective_from', 'rate_bp']);
    expect(Object.keys(s['TaxTypeUpdate'].properties).sort()).toEqual(['display', 'effective_from', 'is_active', 'rate_bp']);
    expect(s['TaxRuleCreate'].properties.other_tax_code.pattern).toBe('^[A-Z0-9_]{1,16}$');
    expect(s['TaxRuleCreate'].properties.hs_code.pattern).toBe('^[0-9]{4,8}$');
    expect(s['TaxRuleCreate'].properties.vat_treatment.enum).toEqual(['exempt', 'taxable']);
  });
});

describe('probes (CR-C3-008): the surcharge / tax stubs are gone', () => {
  const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
  it('none of the nine operationIds is listed in probes/pending.json any more (quotePrices #82 is T-19\'s: quote.handlers.test.ts asserts it leaves the list)', () => {
    for (const id of IDS) expect(pending, id).not.toContain(id);
  });
  it.each(IDS)('%s does not answer 503 common.service_unavailable / not_implemented', { timeout: T }, async (id) => {
    const e = await call(mk(), id, req({ params: { surcharge_rule_id: '0190c300-0000-7000-8000-000000000001', tax_type_id: '0190c300-0000-7000-8000-000000000002', tax_rule_id: '0190c300-0000-7000-8000-000000000003' }, headers: { ...IM1, ...KEY }, body: {} })).then(() => undefined, (x) => x);
    expect(e?.code).not.toBe('common.service_unavailable');
    expect(e?.detail).not.toBe('not_implemented');
  });
});

describe('surcharge rules — handlers over the service, validated against the OpenAPI schemas', () => {
  const ruleOk = validatorFor('SurchargeRule'); const listOk = validatorFor('SurchargeRuleList');
  it('POST create (201 SurchargeRule) -> GET list (200 SurchargeRuleList) -> overlapping POST = 400 /effective_from (AC-14.5) -> POST /end with If-Match (200 SurchargeRule)', { timeout: T }, async () => {
    const db = mk();
    const body = { scope: 'department', department_id: D1.id, amount_kind: 'percent', percent_bp: 5_000, effective_from: iso(at) };
    const created = await call(db, 'createSurchargeRule', req({ headers: KEY, body }));
    expect(created.status).toBe(201); expect(ruleOk(created.body)).toEqual([]);
    expect(created.body).toMatchObject({ scope: 'department', department_id: D1.id, amount_kind: 'percent', percent_bp: 5_000, version: 1 });
    const l = await call(db, 'listSurchargeRules', req({ query: { scope: 'department' } }));
    expect(l.status).toBe(200); expect(listOk(l.body)).toEqual([]); expect(l.body.data.map((r: Row) => r.id)).toEqual([created.body.id]);
    const dup = await rejection(call(db, 'createSurchargeRule', req({ headers: { 'idempotency-key': 'k-2' }, body: { ...body, effective_from: iso(new Date(at.getTime() + 86_400_000)) } })));
    expect(isLimsError(dup, 'common.validation_failed')).toBe(true); expect(dup.statusCode).toBe(400); expect(dup.errors.map((e: any) => e.path)).toContain('/effective_from');
    const ended = await call(db, 'endSurchargeRule', req({ params: { surcharge_rule_id: created.body.id }, headers: IM1, body: {} }));
    expect(ended.status).toBe(200); expect(ruleOk(ended.body)).toEqual([]); expect(ended.body).toMatchObject({ version: 2, effective_to: iso(at) });
  });
  it('/end: 428 without If-Match, 409 on a stale one, 400 on a malformed one — never a write', { timeout: T }, async () => {
    const R = srule(1, A); const db = mk({ surcharge_rules: [R] });
    const p = { surcharge_rule_id: R.id };
    expect((await rejection(call(db, 'endSurchargeRule', req({ params: p, body: {} })))).statusCode).toBe(428);
    expect((await rejection(call(db, 'endSurchargeRule', req({ params: p, headers: { 'if-match': '"5"' }, body: {} })))).statusCode).toBe(409);
    for (const h of ['1', 'W/"1"', '*', '"0"', '"abc"', '']) expect((await rejection(call(db, 'endSurchargeRule', req({ params: p, headers: { 'if-match': h }, body: {} })))).statusCode, h).toBe(400);
    expect(db.row('surcharge_rules', R.id as string)).toMatchObject({ version: 1, effective_to: null }); expect(db.events).toHaveLength(0);
  });
});

describe('tax types — handlers over the service, validated against the OpenAPI schemas', () => {
  const typeOk = validatorFor('TaxType'); const listOk = validatorFor('TaxTypeList');
  it('GET list (200 TaxTypeList incl. the VAT global row) -> POST create (201 TaxType) -> PATCH rate change with If-Match (200 TaxType = the NEW version) -> GET all_versions shows both', { timeout: T }, async () => {
    const db = mk();
    const l0 = await call(db, 'listTaxTypes', req());
    expect(l0.status).toBe(200); expect(listOk(l0.body)).toEqual([]); expect(l0.body.data.map((r: Row) => r.code)).toEqual(['VAT']);
    expect(l0.body.data[0]).toMatchObject({ scope: 'global', rate_bp: 1300 });
    const created = await call(db, 'createTaxType', req({ headers: KEY, body: { code: 'hst', display: 'Synthetic HST', rate_bp: 500 } }));
    expect(created.status).toBe(201); expect(typeOk(created.body)).toEqual([]); expect(created.body).toMatchObject({ code: 'HST', scope: 'tenant', rate_bp: 500, version: 1 });
    const upd = await call(db, 'updateTaxType', req({ params: { tax_type_id: created.body.id }, headers: IM1, body: { rate_bp: 900, effective_from: iso(new Date(at.getTime() + 7 * 86_400_000)) } }));
    expect(upd.status).toBe(200); expect(typeOk(upd.body)).toEqual([]); expect(upd.body).toMatchObject({ code: 'HST', rate_bp: 900 }); expect(upd.body.id).not.toBe(created.body.id);
    const all = await call(db, 'listTaxTypes', req({ query: { all_versions: 'true' } }));
    expect(listOk(all.body)).toEqual([]); expect(all.body.data.filter((r: Row) => r.code === 'HST').map((r: Row) => r.rate_bp).sort()).toEqual([500, 900]);
  });
  it('PATCH: 428 without If-Match, 409 stale, 400 malformed; rate change without effective_from -> 400 /effective_from; unknown tax_type_id / tenant B\'s -> 404', { timeout: T }, async () => {
    const H1 = ttype(1, A, 'HST', { rate_bp: 500 }); const HB = ttype(9, B, 'BTAX');
    const db = mk({ cs_tax_types: [H1, HB] }); const p = { tax_type_id: H1.id };
    expect((await rejection(call(db, 'updateTaxType', req({ params: p, body: { display: 'x' } })))).statusCode).toBe(428);
    expect((await rejection(call(db, 'updateTaxType', req({ params: p, headers: { 'if-match': '"4"' }, body: { display: 'x' } })))).statusCode).toBe(409);
    for (const h of ['1', 'W/"1"', '*', '"0"', '']) expect((await rejection(call(db, 'updateTaxType', req({ params: p, headers: { 'if-match': h }, body: { display: 'x' } })))).statusCode, h).toBe(400);
    const e = await rejection(call(db, 'updateTaxType', req({ params: p, headers: IM1, body: { rate_bp: 900 } })));
    expect(isLimsError(e, 'common.validation_failed')).toBe(true); expect(e.errors.map((x: any) => x.path)).toContain('/effective_from');
    for (const id of [HB.id, '0190c300-0000-7000-8000-00000000ffff']) { const n = await rejection(call(db, 'updateTaxType', req({ params: { tax_type_id: id }, headers: IM1, body: { display: 'x' } }))); expect(isLimsError(n, 'common.not_found')).toBe(true); expect(n.statusCode).toBe(404); }
    expect(db.rows('cs_tax_types', A)).toHaveLength(1); expect(db.row('cs_tax_types', H1.id as string)).toMatchObject({ rate_bp: 500, version: 1, display: 'Synthetic HST' }); expect(db.row('cs_tax_types', HB.id as string)!.version).toBe(1);
  });
  it('POST duplicate code -> 409 catalog.code_duplicate; mass assignment (`scope`, `tenant_id`, `is_active`, `version`, `id`) -> 400', { timeout: T }, async () => {
    const db = mk({ cs_tax_types: [ttype(1, A, 'HST')] });
    const d = await rejection(call(db, 'createTaxType', req({ headers: KEY, body: { code: 'HST', display: 'again' } })));
    expect(isLimsError(d, 'catalog.code_duplicate')).toBe(true); expect(d.statusCode).toBe(409);
    for (const extra of [{ scope: 'global' }, { tenant_id: B }, { is_active: false }, { version: 3 }, { id: '0190c300-0000-7000-8000-000000000bad' }]) {
      expect((await rejection(call(db, 'createTaxType', req({ headers: KEY, body: { code: 'NEW1', display: 'x', ...extra } })))).statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect(db.rows('cs_tax_types', A)).toHaveLength(1);
  });
  it('the VAT global row is read-only through the handler: PATCH -> 4xx, row unchanged', { timeout: T }, async () => {
    const db = mk(); const vat = db.rows('g_tax_types')[0]!;
    const e = await rejection(call(db, 'updateTaxType', req({ params: { tax_type_id: vat.id }, headers: IM1, body: { display: 'x' } })));
    expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500);
    expect(db.rows('g_tax_types')[0]).toMatchObject({ code: 'VAT', rate_bp: 1300, display: vat.display });
  });
});

describe('tax rules — handlers over the service, validated against the OpenAPI schemas', () => {
  const ruleOk = validatorFor('TaxRule'); const listOk = validatorFor('TaxRuleList');
  it('POST default (201) -> POST successor (201, predecessor ended, AC-15.5) -> GET list (200 TaxRuleList) -> POST orderable rule -> POST /end (200 TaxRule)', { timeout: T }, async () => {
    const db = mk();
    const d1 = await call(db, 'createTaxRule', req({ headers: KEY, body: { scope: 'tenant_default', vat_treatment: 'exempt', effective_from: iso(T0) } }));
    expect(d1.status).toBe(201); expect(ruleOk(d1.body)).toEqual([]);
    const next = new Date(at.getTime() + 5 * 86_400_000);
    const d2 = await call(db, 'createTaxRule', req({ headers: { 'idempotency-key': 'k-2' }, body: { scope: 'tenant_default', vat_treatment: 'taxable', effective_from: iso(next) } }));
    expect(d2.status).toBe(201); expect(ruleOk(d2.body)).toEqual([]);
    const l = await call(db, 'listTaxRules', req({ query: { scope: 'tenant_default', active_at: iso(next) } }));
    expect(l.status).toBe(200); expect(listOk(l.body)).toEqual([]); expect(l.body.data.map((r: Row) => r.id)).toEqual([d2.body.id]);
    const ord = await call(db, 'createTaxRule', req({ headers: { 'idempotency-key': 'k-3' }, body: { scope: 'orderable', orderable_id: O1.id, vat_treatment: 'taxable', hs_code: '9018', effective_from: iso(at) } }));
    expect(ord.status).toBe(201); expect(ruleOk(ord.body)).toEqual([]);
    const end = await call(db, 'endTaxRule', req({ params: { tax_rule_id: ord.body.id }, headers: IM1, body: {} }));
    expect(end.status).toBe(200); expect(ruleOk(end.body)).toEqual([]); expect(end.body).toMatchObject({ version: 2, effective_to: iso(at) });
  });
  it('AC-15.2 through the handler: other_tax_code of a type with no rate -> 400 path /other_tax_code; AC-15.5 overlap -> 400 /effective_from', { timeout: T }, async () => {
    const db = mk({ cs_tax_types: [ttype(1, A, 'HST', { rate_bp: null })], tax_rules: [trule(2, A, { scope: 'department', department_id: D1.id })] });
    const a = await rejection(call(db, 'createTaxRule', req({ headers: KEY, body: { scope: 'tenant_default', vat_treatment: 'taxable', other_tax_code: 'HST', effective_from: iso(at) } })));
    expect(isLimsError(a, 'common.validation_failed')).toBe(true); expect(a.statusCode).toBe(400); expect(a.errors.map((e: any) => e.path)).toContain('/other_tax_code');
    const b = await rejection(call(db, 'createTaxRule', req({ headers: { 'idempotency-key': 'k-2' }, body: { scope: 'department', department_id: D1.id, vat_treatment: 'exempt', effective_from: iso(at) } })));
    expect(b.statusCode).toBe(400); expect(b.errors.map((e: any) => e.path)).toContain('/effective_from');
    expect(db.rows('tax_rules', A)).toHaveLength(1); expect(db.events).toHaveLength(0);
  });
  it('/end: 428 / 409 / 400 on If-Match; the tenant default cannot be ended (400); tenant B\'s rule id -> 404', { timeout: T }, async () => {
    const DEF = trule(1, A, { scope: 'tenant_default' }); const ORD = trule(2, A, { scope: 'orderable', orderable_id: O1.id }); const RB = trule(9, B, { scope: 'orderable', orderable_id: OB.id });
    const db = mk({ tax_rules: [DEF, ORD, RB] }); const p = { tax_rule_id: ORD.id };
    expect((await rejection(call(db, 'endTaxRule', req({ params: p, body: {} })))).statusCode).toBe(428);
    expect((await rejection(call(db, 'endTaxRule', req({ params: p, headers: { 'if-match': '"3"' }, body: {} })))).statusCode).toBe(409);
    for (const h of ['1', '*', '"0"', '']) expect((await rejection(call(db, 'endTaxRule', req({ params: p, headers: { 'if-match': h }, body: {} })))).statusCode, h).toBe(400);
    expect((await rejection(call(db, 'endTaxRule', req({ params: { tax_rule_id: DEF.id }, headers: IM1, body: {} })))).statusCode).toBe(400);
    const nf = await rejection(call(db, 'endTaxRule', req({ params: { tax_rule_id: RB.id }, headers: IM1, body: {} })));
    expect(isLimsError(nf, 'common.not_found')).toBe(true); expect(nf.statusCode).toBe(404);
    for (const r of [DEF, ORD]) expect(db.row('tax_rules', r.id as string)).toMatchObject({ version: 1, effective_to: null });
    expect(db.row('tax_rules', RB.id as string)).toMatchObject({ version: 1, effective_to: null }); expect(db.events).toHaveLength(0);
  });
});

describe('cross-cutting: tenant isolation, bad input, fail-closed', () => {
  it('S-1 / AB-1: lists return only tenant A\'s rows; tenant B\'s surcharge / tax rule / tax type are invisible', { timeout: T }, async () => {
    const db = mk({ surcharge_rules: [srule(1, A), srule(9, B)], tax_rules: [trule(1, A), trule(9, B)], cs_tax_types: [ttype(1, A, 'HST'), ttype(9, B, 'BTAX')] });
    expect((await call(db, 'listSurchargeRules', req())).body.data.map((r: Row) => r.id)).toEqual([srule(1, A).id]);
    expect((await call(db, 'listTaxRules', req())).body.data.map((r: Row) => r.id)).toEqual([trule(1, A).id]);
    expect((await call(db, 'listTaxTypes', req())).body.data.map((r: Row) => r.code).sort()).toEqual(['HST', 'VAT']);
  });
  it('AB-3: department / orderable ids of tenant B in a create body -> 4xx, nothing created, no B value in the error', { timeout: T }, async () => {
    const db = mk();
    const e1 = await rejection(call(db, 'createTaxRule', req({ headers: KEY, body: { scope: 'orderable', orderable_id: OB.id, vat_treatment: 'taxable', effective_from: iso(at) } })));
    const e2 = await rejection(call(db, 'createSurchargeRule', req({ headers: KEY, body: { scope: 'orderable', orderable_id: OB.id, amount_kind: 'flat', amount: money(5), effective_from: iso(at) } })));
    for (const e of [e1, e2]) { expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500); expect(JSON.stringify([e.message, e.detail, e.errors])).not.toMatch(/BSECRET/); }
    expect(db.rows('tax_rules', A)).toHaveLength(0); expect(db.rows('surcharge_rules', A)).toHaveLength(0); expect(db.events).toHaveLength(0);
  });
  it('list query validation through the handlers: bad scope / active_at / all_versions -> 400', { timeout: T }, async () => {
    const db = mk();
    for (const [op, query] of [['listSurchargeRules', { scope: 'tenant_default' }], ['listSurchargeRules', { active_at: 'x' }], ['listTaxRules', { scope: 'all' }], ['listTaxRules', { active_at: '2026-13-45' }], ['listTaxTypes', { all_versions: 'maybe' }], ['listTaxTypes', { active_at: 'x' }]] as const) {
      expect((await rejection(call(db, op, req({ query })))).statusCode, `${op} ${JSON.stringify(query)}`).toBe(400);
    }
  });
  it('fails closed without an authenticated request context: auth.unauthenticated for all nine operations, nothing reflected', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    for (const id of IDS) {
      const e = await rejection(H[id]!(req({ params: { surcharge_rule_id: '0190c300-0000-7000-8000-000000000001', tax_type_id: '0190c300-0000-7000-8000-000000000002', tax_rule_id: '0190c300-0000-7000-8000-000000000003' }, headers: { ...IM1, ...KEY }, body: { code: planted, display: planted } }), bare(id)));
      expect(isLimsError(e, 'auth.unauthenticated'), id).toBe(true);
      expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain(planted);
    }
  });
  it('no response body carries server-internal fields (tenant_id, created_by, updated_by, created_at, updated_at, amount_paisa at the top level)', { timeout: T }, async () => {
    const db = mk({ surcharge_rules: [srule(1, A)], tax_rules: [trule(1, A)], cs_tax_types: [ttype(1, A, 'HST')] });
    const bodies = [(await call(db, 'listSurchargeRules', req())).body, (await call(db, 'listTaxRules', req())).body, (await call(db, 'listTaxTypes', req())).body];
    const s = JSON.stringify(bodies);
    expect(s).not.toMatch(/"(tenant_id|created_by|updated_by|created_at|updated_at|sort_order)"/);
    expect(s).not.toMatch(/"amount_paisa":\s*"/);                                  // money is numeric, never a bigint string
  });
});
