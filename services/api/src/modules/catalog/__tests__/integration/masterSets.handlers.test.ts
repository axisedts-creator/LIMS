// T-05 (C3) — units + value sets HTTP contract + probes: the six handlers #17–#22 are real (no longer CR-C3-008 stubs) and honour catalog.yaml.
// Spec: 06-PLAN T-05; 02-TRD §5 rows 17–22, §5.0 (If-Match on PATCH: 428 missing / 409 stale; Idempotency-Key on creates); 07-SECURITY S-1, S-4, S-5, S-16, AB-20.
// Same harness conventions as masters.handlers.test.ts (T-04): handlers driven with a request-shaped object + the HandlerContext subset;
// responses validated against the OpenAPI schemas. Path params are `unit_id` / `value_set_id` (NOT `id`). If-Match is the raw header `"<n>"`.
// The core pipeline (schema validation, auth, x-permission, Idempotency-Key replay) is not re-tested here.
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
import { av, gSet, gUnit, gVal, makeSetsDb, unit, vset, vval, type SetTable } from '../helpers/setsDb.js';

const T = 20_000;
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validatorFor = (name: string) => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return (x: unknown) => { const ok = v(x); return ok ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
};
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const IDS = ['listUnits', 'createUnit', 'updateUnit', 'listValueSets', 'createValueSet', 'updateValueSet'] as const;
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const mk = (rows: Partial<Record<SetTable, Row[]>> = {}) => makeSetsDb({ rows, catalog: { state: { [TENANT_A]: { rootId: ROOT_A, revision: 417 } } } });
const bare = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } });

// NB: the starter unit `none` (display "") violates the Unit schema (display minLength 1) — see notes/T-05-tests.md; not used in schema-validated fixtures.
const GLOBALS = {
  g_units: [gUnit(1, { code: 'g_dl', display: 'g/dL' }), gUnit(2, { code: 'pct', display: '%' })],
  g_value_sets: [gSet(1, { code: 'URINE_SEMIQ', display: 'Urine semi-quantitative', is_ordered: true }), gSet(2, { code: 'POS_NEG', display: 'Positive / negative', is_ordered: false })],
  g_value_set_values: [gVal('URINE_SEMIQ', 1, { code: 'NEG', display: 'Negative', sort_order: 10 }), gVal('URINE_SEMIQ', 2, { code: '1+', display: '1+', sort_order: 20 }), gVal('POS_NEG', 1, { code: 'POS', display: 'Positive', sort_order: 10 })],
};
const SET_BODY = { code: 'LAB_GRADE', display: 'Lab grade', is_ordered: true, values: [{ code: 'LOW', display: 'Low', sort_order: 10 }, { code: 'HIGH', display: 'High', sort_order: 20 }] };

describe('the 6 operations exist in the contract with the TRD permissions/idempotency (S-4, S-16)', () => {
  it('operationIds are in catalog.yaml and in the manifest handlers', () => {
    const ids = operationIds(spec);
    for (const id of IDS) { expect(ids).toContain(id); expect(typeof (manifest.handlers as any)[id]).toBe('function'); expect((manifest.handlers as any)[id]).toBe(H[id]); }
  });
  it.each([['Unit', 'unit_id', 'Units'], ['ValueSet', 'value_set_id', 'ValueSets']])('%s: list = catalog.test.read; create/update = catalog.test.manage; create needs Idempotency-Key; update needs If-Match; update has no code/is_ordered field', (R, param, plural) => {
    expect(opOf(`list${plural}`)['x-permission']).toBe('catalog.test.read');
    expect(opOf(`create${R}`)['x-permission']).toBe('catalog.test.manage');
    expect(opOf(`update${R}`)['x-permission']).toBe('catalog.test.manage');
    expect(opOf(`create${R}`)['x-idempotency']).toBe('required');
    expect(opOf(`update${R}`)['x-idempotency']).toBe('none');
    expect(JSON.stringify(opOf(`update${R}`).parameters)).toContain('IfMatch');
    expect(opOf(`update${R}`).parameters.some((p: any) => p.name === param && p.in === 'path')).toBe(true);
    const u = spec.components.schemas[`${R}Update`]; const c = spec.components.schemas[`${R}Create`];
    expect(u.additionalProperties).toBe(false); expect(c.additionalProperties).toBe(false);
    for (const k of ['code', 'is_ordered', 'scope', 'id', 'tenant_id', 'version']) expect(Object.keys(u.properties)).not.toContain(k);
    for (const k of ['scope', 'id', 'tenant_id', 'version', 'is_active']) expect(Object.keys(c.properties)).not.toContain(k);
  });
  it('updateValueSet documents catalog.version_in_use', () => { expect(opOf('updateValueSet')['x-error-codes']).toContain('catalog.version_in_use'); });
});

describe('probes (CR-C3-008): the units / value-set stubs are gone', () => {
  const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
  it('none of the six operationIds is listed in probes/pending.json any more', () => {
    for (const id of IDS) expect(pending, id).not.toContain(id);
  });
  it.each(IDS)('%s does not answer 503 common.service_unavailable / not_implemented', { timeout: T }, async (id) => {
    const db = mk();
    const e = await db.run((ctx) => H[id]!(req({ params: { unit_id: ID(0x1), value_set_id: ID(0x1) }, headers: { 'if-match': '"1"', 'idempotency-key': 'k-1' }, body: {} }), ctx)).then(() => undefined, (x) => x);
    expect(e?.code).not.toBe('common.service_unavailable');
    expect(e?.detail).not.toBe('not_implemented');
  });
});

describe('units — handlers over the service, validated against the OpenAPI schemas', () => {
  const unitOk = validatorFor('Unit'); const listOk = validatorFor('UnitList');
  const mine = unit(1, TENANT_A, { code: 'lab_x', display: 'lab x' });

  it('GET list -> 200 whose body is exactly UnitList (global + tenant, no `page`)', { timeout: T }, async () => {
    const db = mk({ ...GLOBALS, cs_units: [mine, unit(2, TENANT_B, { code: 'b_only' })] });
    const r = await db.run((ctx) => H['listUnits']!(req(), ctx));
    expect(r.status).toBe(200);
    expect(listOk(r.body)).toEqual([]);
    expect(r.body.data.map((u: any) => u.code).sort()).toEqual(['g_dl', 'lab_x', 'pct']);
    expect(r.body).not.toHaveProperty('page');
  });

  it('query is passed through: scope=global / is_active=true; scope=bogus -> 400', { timeout: T }, async () => {
    const db = mk({ ...GLOBALS, cs_units: [mine, unit(3, TENANT_A, { code: 'off', is_active: false })] });
    const g = await db.run((ctx) => H['listUnits']!(req({ query: { scope: 'global' } }), ctx));
    expect(g.body.data.every((u: any) => u.scope === 'global')).toBe(true);
    const a = await db.run((ctx) => H['listUnits']!(req({ query: { is_active: 'true' } }), ctx));
    expect(a.body.data.map((u: any) => u.code)).not.toContain('off');
    const f = await db.run((ctx) => H['listUnits']!(req({ query: { is_active: 'false' } }), ctx));
    expect(f.body.data.map((u: any) => u.code)).toEqual(['off']);
    const all = await db.run((ctx) => H['listUnits']!(req({ query: { is_active: 'all' } }), ctx));
    expect(all.body.data.map((u: any) => u.code)).toContain('off');
    expect((await rejection(db.run((ctx) => H['listUnits']!(req({ query: { scope: 'bogus' } }), ctx)))).statusCode).toBe(400);
  });

  it('POST -> 201 with a body that is exactly the Unit schema', { timeout: T }, async () => {
    const db = mk(GLOBALS);
    const r = await db.run((ctx) => H['createUnit']!(req({ headers: { 'idempotency-key': 'k-1' }, body: { code: 'mg_x', display: 'mg/x' } }), ctx));
    expect(r.status).toBe(201);
    expect(unitOk(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ code: 'mg_x', scope: 'tenant', version: 1, is_active: true });
  });

  it('POST with a global code -> 409 catalog.code_duplicate; own duplicate -> 409', { timeout: T }, async () => {
    const db = mk({ ...GLOBALS, cs_units: [mine] });
    for (const code of ['g_dl', 'lab_x']) {
      const e = await rejection(db.run((ctx) => H['createUnit']!(req({ headers: { 'idempotency-key': 'k-1' }, body: { code, display: 'x' } }), ctx)));
      expect(isLimsError(e, 'catalog.code_duplicate')).toBe(true); expect(e.statusCode).toBe(409);
    }
  });

  it('PATCH unit_id with If-Match "1" -> 200 Unit, version 2', { timeout: T }, async () => {
    const db = mk({ cs_units: [mine] });
    const r = await db.run((ctx) => H['updateUnit']!(req({ params: { unit_id: mine.id }, headers: { 'if-match': '"1"' }, body: { display: 'lab x2' } }), ctx));
    expect(r.status).toBe(200);
    expect(unitOk(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: mine.id, display: 'lab x2', version: 2 });
  });

  it('AC-01.6 pattern: no If-Match -> 428; stale -> 409 version_conflict', { timeout: T }, async () => {
    const db = mk({ cs_units: [{ ...mine, version: 3 }] });
    const a = await rejection(db.run((ctx) => H['updateUnit']!(req({ params: { unit_id: mine.id }, body: { display: 'x' } }), ctx)));
    expect(isLimsError(a, 'common.precondition_required')).toBe(true); expect(a.statusCode).toBe(428);
    const b = await rejection(db.run((ctx) => H['updateUnit']!(req({ params: { unit_id: mine.id }, headers: { 'if-match': '"2"' }, body: { display: 'x' } }), ctx)));
    expect(isLimsError(b, 'common.version_conflict')).toBe(true); expect(b.statusCode).toBe(409);
    expect(db.row('cs_units', mine.id)!.version).toBe(3);
  });

  it.each([['unquoted', '1'], ['weak', 'W/"1"'], ['star', '*'], ['zero', '"0"'], ['leading zero', '"01"'], ['non numeric', '"abc"'], ['negative', '"-1"'], ['beyond int32', '"99999999999"'], ['empty', '']])
  ('malformed If-Match (%s) -> 400, never 500, never a write', { timeout: T }, async (_n, h) => {
    const db = mk({ cs_units: [mine] });
    const e = await rejection(db.run((ctx) => H['updateUnit']!(req({ params: { unit_id: mine.id }, headers: { 'if-match': h }, body: { display: 'x' } }), ctx)));
    expect(isLimsError(e)).toBe(true); expect(e.statusCode).toBe(400);
    expect(db.row('cs_units', mine.id)!.version).toBe(1);
  });

  it('done_when "global rows read-only": PATCH of a global unit\'s id -> 404 common.not_found, g_units unchanged', { timeout: T }, async () => {
    const db = mk(GLOBALS);
    const g = GLOBALS.g_units[0]!;
    const e = await rejection(db.run((ctx) => H['updateUnit']!(req({ params: { unit_id: g.id }, headers: { 'if-match': '"1"' }, body: { display: 'hacked' } }), ctx)));
    expect(isLimsError(e, 'common.not_found')).toBe(true); expect(e.statusCode).toBe(404);
    expect(db.row('g_units', g.id)!.display).toBe('g/dL');
    expect(db.events).toHaveLength(0);
  });

  it('S-1: tenant B\'s unit id -> 404; B row untouched', { timeout: T }, async () => {
    const theirs = unit(2, TENANT_B);
    const db = mk({ cs_units: [theirs] });
    const e = await rejection(db.run((ctx) => H['updateUnit']!(req({ params: { unit_id: theirs.id }, headers: { 'if-match': '"1"' }, body: { display: 'x' } }), ctx)));
    expect(isLimsError(e, 'common.not_found')).toBe(true);
    expect(db.row('cs_units', theirs.id)!.version).toBe(1);
  });

  it('S-5: mass assignment through the handler -> 400, nothing written', { timeout: T }, async () => {
    const db = mk(GLOBALS);
    for (const extra of [{ tenant_id: TENANT_B }, { version: 7 }, { id: ID(0xbad) }, { scope: 'global' }]) {
      const e = await rejection(db.run((ctx) => H['createUnit']!(req({ headers: { 'idempotency-key': 'k-1' }, body: { code: 'mg_x', display: 'mg/x', ...extra } }), ctx)));
      expect(e.statusCode).toBe(400);
    }
    expect(db.rows('cs_units')).toHaveLength(0); expect(db.events).toHaveLength(0);
  });

  it('fails closed without an authenticated request context: auth.unauthenticated, nothing reflected', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    const e = await rejection(H['createUnit']!(req({ body: { code: 'mg_x', display: planted } }), bare('createUnit')));
    expect(isLimsError(e, 'auth.unauthenticated')).toBe(true);
    expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain(planted);
    for (const id of ['listUnits', 'updateUnit']) expect(isLimsError(await rejection(H[id]!(req({ params: { unit_id: ID(1) }, headers: { 'if-match': '"1"' }, body: { display: 'x' } }), bare(id))), 'auth.unauthenticated')).toBe(true);
  });
});

describe('value sets — handlers over the service, validated against the OpenAPI schemas', () => {
  const setOk = validatorFor('ValueSet'); const listOk = validatorFor('ValueSetList');
  const S = vset(1, TENANT_A, { code: 'LAB_GRADE', display: 'Lab grade', is_ordered: true });
  const rows = (extra: Partial<Record<SetTable, Row[]>> = {}) => ({
    ...GLOBALS, cs_value_sets: [S], cs_value_set_values: [vval(S.id, 1, TENANT_A, { code: 'LOW', display: 'Low', sort_order: 10 }), vval(S.id, 2, TENANT_A, { code: 'HIGH', display: 'High', sort_order: 20 })], ...extra,
  });

  it('GET list -> 200 whose body is exactly ValueSetList (global with values, tenant with id/version)', { timeout: T }, async () => {
    const db = mk(rows());
    const r = await db.run((ctx) => H['listValueSets']!(req(), ctx));
    expect(r.status).toBe(200);
    expect(listOk(r.body)).toEqual([]);
    expect(r.body.data.map((s: any) => s.code).sort()).toEqual(['LAB_GRADE', 'POS_NEG', 'URINE_SEMIQ']);
    expect(r.body.data.find((s: any) => s.code === 'URINE_SEMIQ')).toMatchObject({ scope: 'global', is_ordered: true });
    expect((await rejection(db.run((ctx) => H['listValueSets']!(req({ query: { scope: 'bogus' } }), ctx)))).statusCode).toBe(400);
  });

  it('POST -> 201 with a body that is exactly the ValueSet schema', { timeout: T }, async () => {
    const db = mk(GLOBALS);
    const r = await db.run((ctx) => H['createValueSet']!(req({ headers: { 'idempotency-key': 'k-1' }, body: SET_BODY }), ctx));
    expect(r.status).toBe(201);
    expect(setOk(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ code: 'LAB_GRADE', scope: 'tenant', is_ordered: true, version: 1 });
    expect(r.body.values.map((v: any) => v.code)).toEqual(['LOW', 'HIGH']);
  });

  it('POST with a global / own code -> 409 catalog.code_duplicate', { timeout: T }, async () => {
    const db = mk(rows());
    for (const code of ['POS_NEG', 'LAB_GRADE']) {
      const e = await rejection(db.run((ctx) => H['createValueSet']!(req({ headers: { 'idempotency-key': 'k-1' }, body: { ...SET_BODY, code } }), ctx)));
      expect(isLimsError(e, 'catalog.code_duplicate')).toBe(true); expect(e.statusCode).toBe(409);
    }
  });

  it('PATCH value_set_id with If-Match "1" -> 200 ValueSet version 2 (new code appended)', { timeout: T }, async () => {
    const db = mk(rows());
    const r = await db.run((ctx) => H['updateValueSet']!(req({ params: { value_set_id: S.id }, headers: { 'if-match': '"1"' }, body: { display: 'Lab grade 2', values: [{ code: 'EXTREME', display: 'Extreme', sort_order: 30 }] } }), ctx));
    expect(r.status).toBe(200);
    expect(setOk(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: S.id, display: 'Lab grade 2', version: 2 });
    expect(r.body.values.map((v: any) => v.code)).toEqual(['LOW', 'HIGH', 'EXTREME']);
  });

  it('done_when "in-use value-set protection": a published analyte version references the set -> re-ordering a code is 409 catalog.version_in_use, set unchanged', { timeout: T }, async () => {
    const db = mk(rows({ analyte_versions: [av(1, TENANT_A, 'LAB_GRADE', 'published')] }));
    const e = await rejection(db.run((ctx) => H['updateValueSet']!(req({ params: { value_set_id: S.id }, headers: { 'if-match': '"1"' }, body: { values: [{ code: 'LOW', sort_order: 99 }] } }), ctx)));
    expect(isLimsError(e, 'catalog.version_in_use')).toBe(true); expect(e.statusCode).toBe(409);
    expect(db.row('cs_value_sets', S.id)!.version).toBe(1);
    expect(db.rows('cs_value_set_values').find((v) => v.code === 'LOW')!.sort_order).toBe(10);
    expect(db.events).toHaveLength(0);
  });

  it('done_when "global rows read-only": PATCH of a global set\'s id -> 404 common.not_found, g_* unchanged', { timeout: T }, async () => {
    const db = mk(rows());
    const g = GLOBALS.g_value_sets[1]!;
    const e = await rejection(db.run((ctx) => H['updateValueSet']!(req({ params: { value_set_id: g.id }, headers: { 'if-match': '"1"' }, body: { values: [{ code: 'POS', display: 'hacked' }] } }), ctx)));
    expect(isLimsError(e, 'common.not_found')).toBe(true); expect(e.statusCode).toBe(404);
    expect(db.rows('g_value_set_values').find((v) => v.code === 'POS')!.display).toBe('Positive');
    expect(db.events).toHaveLength(0);
  });

  it('AC-01.6 pattern: no If-Match -> 428; stale -> 409 version_conflict; malformed -> 400', { timeout: T }, async () => {
    const db = mk(rows({ cs_value_sets: [{ ...S, version: 3 }] }));
    const go = (headers: object) => rejection(db.run((ctx) => H['updateValueSet']!(req({ params: { value_set_id: S.id }, headers, body: { display: 'x' } }), ctx)));
    expect((await go({})).statusCode).toBe(428);
    const stale = await go({ 'if-match': '"2"' });
    expect(isLimsError(stale, 'common.version_conflict')).toBe(true); expect(stale.statusCode).toBe(409);
    for (const bad of ['1', 'W/"1"', '*', '"0"', '"abc"', '']) expect((await go({ 'if-match': bad })).statusCode).toBe(400);
    expect(db.row('cs_value_sets', S.id)!.version).toBe(3);
  });

  it('S-1: tenant B\'s set id -> 404; B set + values untouched', { timeout: T }, async () => {
    const theirs = vset(9, TENANT_B, { code: 'THEIRS' });
    const db = mk({ cs_value_sets: [theirs], cs_value_set_values: [vval(theirs.id, 1, TENANT_B)] });
    const e = await rejection(db.run((ctx) => H['updateValueSet']!(req({ params: { value_set_id: theirs.id }, headers: { 'if-match': '"1"' }, body: { display: 'x' } }), ctx)));
    expect(isLimsError(e, 'common.not_found')).toBe(true);
    expect(db.row('cs_value_sets', theirs.id)!.version).toBe(1);
  });

  it('S-5: mass assignment through the handler (tenant_id, version, id, scope; value-level id/value_set_id) -> 400, nothing written', { timeout: T }, async () => {
    const db = mk(GLOBALS);
    const bodies = [{ ...SET_BODY, tenant_id: TENANT_B }, { ...SET_BODY, version: 7 }, { ...SET_BODY, id: ID(0xbad) }, { ...SET_BODY, scope: 'global' },
      { ...SET_BODY, values: [{ code: 'A', display: 'a', sort_order: 1, value_set_id: ID(1) }] }];
    for (const body of bodies) expect((await rejection(db.run((ctx) => H['createValueSet']!(req({ headers: { 'idempotency-key': 'k-1' }, body }), ctx)))).statusCode).toBe(400);
    expect(db.rows('cs_value_sets')).toHaveLength(0); expect(db.rows('cs_value_set_values')).toHaveLength(0); expect(db.events).toHaveLength(0);
  });

  it('fails closed without an authenticated request context: auth.unauthenticated, nothing reflected', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    const e = await rejection(H['createValueSet']!(req({ body: { ...SET_BODY, display: planted } }), bare('createValueSet')));
    expect(isLimsError(e, 'auth.unauthenticated')).toBe(true);
    expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain(planted);
    for (const id of ['listValueSets', 'updateValueSet']) expect(isLimsError(await rejection(H[id]!(req({ params: { value_set_id: ID(1) }, headers: { 'if-match': '"1"' }, body: { display: 'x' } }), bare(id))), 'auth.unauthenticated')).toBe(true);
  });
});
