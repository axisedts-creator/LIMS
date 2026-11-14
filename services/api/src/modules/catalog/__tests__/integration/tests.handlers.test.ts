// T-06 (C3) — HTTP contract + probes for #2 searchOrderables, #23 listTests, #24 createTest, #25 getTestDetail, #26 updateTest, #27 replaceTestSpecimenRequirements.
// Spec: 06-PLAN T-06 ("integration, probes"), 02-TRD §5.2 (permissions/idempotency/If-Match), §5.0; 07-SECURITY S-1, S-4 (x-permission floor), S-5, S-16, AB-20;
//       CR-C3-008 (stubs leave probes/pending.json when swapped).
// Core pipeline (schema, auth, x-permission, Idempotency-Key replay) is not re-tested: handlers are driven with a request-shaped object and the same
// HandlerContext subset the services get; responses are validated against the OpenAPI schemas. Conventions identical to masters.handlers.test.ts:
//   Handler (req: {params, query, headers, body}, ctx) => {status, body}; path param is `test_id`; If-Match arrives as the raw header '"<n>"';
//   query values arrive already coerced by the pipeline (integers/booleans typed, enums as strings); context without tenantId/actor/tx/events -> auth.unauthenticated.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec, operationIds } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { TENANT_A, TENANT_B } from '../helpers/catalogDb.js';
import { ID, pnl, tsr, tst } from '../helpers/testsDb.js';
import { EDTA, HAEM, HAEM_B, LAV, SERUM, T, body, rejection, setup } from '../helpers/t6.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validatorFor = (name: string) => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return (x: unknown) => { const ok = v(x); return ok ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
};
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const IDS = ['searchOrderables', 'listTests', 'createTest', 'getTestDetail', 'updateTest', 'replaceTestSpecimenRequirements'] as const;
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const bare = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } });
const seed = () => {
  const t1 = tst(1, TENANT_A, HAEM.id, { code: 'CBC', name: 'Complete blood count' });
  const tb = tst(2, TENANT_B, HAEM_B.id, { code: 'BONLY', name: 'Tenant B only' });
  const p = pnl(1, TENANT_A, { code: 'CBCP', name: 'CBC panel', panel_kind: 'clinical' });
  return { t1, tb, p, ...setup({ t6: {
    orderables: [t1.orderable, tb.orderable, p.orderable], tests: [t1.test, tb.test], panels: [p.panel],
    test_specimen_types: [tsr(t1.test.id, EDTA.id, TENANT_A, { is_preferred: true, container_id: LAV.id, min_volume_ul: 2000 })],
  } }) };
};

describe('contract: the six operations exist with the TRD permissions / idempotency / If-Match (S-4, S-16)', () => {
  it('operationIds are in catalog.yaml and in the manifest handlers', () => {
    const ids = operationIds(spec);
    for (const id of IDS) { expect(ids).toContain(id); expect(typeof (manifest.handlers as any)[id]).toBe('function'); expect((manifest.handlers as any)[id]).toBe(H[id]); }
  });
  it('reads need catalog.test.read, writes catalog.test.manage; only createTest needs an Idempotency-Key; update/replace need If-Match', () => {
    for (const id of ['searchOrderables', 'listTests', 'getTestDetail']) { expect(opOf(id)['x-permission']).toBe('catalog.test.read'); expect(opOf(id)['x-idempotency']).toBe('none'); }
    for (const id of ['createTest', 'updateTest', 'replaceTestSpecimenRequirements']) expect(opOf(id)['x-permission']).toBe('catalog.test.manage');
    expect(opOf('createTest')['x-idempotency']).toBe('required');
    for (const id of ['updateTest', 'replaceTestSpecimenRequirements']) { expect(opOf(id)['x-idempotency']).toBe('none'); expect(JSON.stringify(opOf(id).parameters)).toContain('IfMatch'); }
  });
  it('request schemas are strict and carry no server-owned fields (REQ-SEC-080)', () => {
    for (const n of ['TestCreate', 'TestUpdate', 'SpecimenRequirementsReplace', 'SpecimenRequirement']) {
      const s = spec.components.schemas[n];
      expect(s.additionalProperties, n).toBe(false);
      for (const k of ['id', 'tenant_id', 'version', 'revision', 'created_by', 'updated_by', 'kind', 'analytes', 'tat_targets']) expect(Object.keys(s.properties), `${n}.${k}`).not.toContain(k);
    }
    expect(Object.keys(spec.components.schemas['TestUpdate'].properties)).not.toContain('code');
  });
});

describe('probes (CR-C3-008): the six stubs are gone', () => {
  const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
  it('none of the six operationIds is listed in probes/pending.json any more', () => {
    for (const id of IDS) expect(pending, id).not.toContain(id);
  });
  it.each(IDS)('%s does not answer 503 common.service_unavailable / not_implemented', { timeout: T }, async (id) => {
    const { db } = seed();
    const e = await db.run((ctx) => H[id]!(req({ params: { test_id: ID(0x1) }, query: { q: 'x' }, headers: { 'if-match': '"1"', 'idempotency-key': 'k-1' }, body: {} }), ctx)).then(() => undefined, (x) => x);
    expect(e?.code).not.toBe('common.service_unavailable');
    expect(e?.detail).not.toBe('not_implemented');
  });
});

describe('handlers over the service, validated against the OpenAPI schemas', () => {
  it('createTest -> 201 with a body that is exactly the contract Test; the Idempotency-Key header is accepted', { timeout: T }, async () => {
    const { db } = seed();
    const r = await db.run((ctx) => H['createTest']!(req({ headers: { 'idempotency-key': 'k-1' }, body: body({ code: 'hb' }) }), ctx));
    expect(r.status).toBe(201);
    expect(validatorFor('Test')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ code: 'HB', version: 1, is_active: true });
  });

  it('getTestDetail -> 200 Test; as_of passes through; path param is test_id', { timeout: T }, async () => {
    const { db, t1 } = seed();
    const r = await db.run((ctx) => H['getTestDetail']!(req({ params: { test_id: t1.test.id }, query: { as_of: '2026-03-01T00:00:00.000Z' } }), ctx));
    expect(r.status).toBe(200);
    expect(validatorFor('Test')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: t1.test.id, code: 'CBC', specimen_requirements: [{ specimen_type_id: EDTA.id, container_id: LAV.id, is_preferred: true, min_volume_ul: 2000 }] });
  });

  it('updateTest with If-Match "1" -> 200 Test version 2', { timeout: T }, async () => {
    const { db, t1 } = seed();
    const r = await db.run((ctx) => H['updateTest']!(req({ params: { test_id: t1.test.id }, headers: { 'if-match': '"1"' }, body: { name: 'CBC 3-part', report_order: 5 } }), ctx));
    expect(r.status).toBe(200);
    expect(validatorFor('Test')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ name: 'CBC 3-part', report_order: 5, version: 2 });
  });

  it('replaceTestSpecimenRequirements with If-Match "1" -> 200 Test with the new set', { timeout: T }, async () => {
    const { db, t1 } = seed();
    const r = await db.run((ctx) => H['replaceTestSpecimenRequirements']!(req({ params: { test_id: t1.test.id }, headers: { 'if-match': '"1"' }, body: { specimen_requirements: [{ specimen_type_id: SERUM.id, is_preferred: true }] } }), ctx));
    expect(r.status).toBe(200);
    expect(validatorFor('Test')(r.body)).toEqual([]);
    expect(r.body.specimen_requirements).toEqual([{ specimen_type_id: SERUM.id, is_preferred: true }]);
    expect(r.body.version).toBe(2);
  });

  it('listTests -> 200 exactly the contract OrderableSummaryPage; next_cursor appears when more rows exist', { timeout: T }, async () => {
    const { db } = seed();
    const r = await db.run((ctx) => H['listTests']!(req(), ctx));
    expect(r.status).toBe(200);
    expect(validatorFor('OrderableSummaryPage')(r.body)).toEqual([]);
    expect(r.body.data.map((x: any) => x.code)).toEqual(['CBC']);
    const more = setup({ t6: { ...(() => { const a = tst(1, TENANT_A, HAEM.id, { code: 'A1' }), b = tst(2, TENANT_A, HAEM.id, { code: 'A2' }); return { orderables: [a.orderable, b.orderable], tests: [a.test, b.test] }; })() } });
    const page = await more.db.run((ctx) => H['listTests']!(req({ query: { limit: 1 } }), ctx));
    expect(validatorFor('OrderableSummaryPage')(page.body)).toEqual([]);
    expect(typeof page.body.page.next_cursor).toBe('string');
  });

  it('searchOrderables -> 200 exactly the contract OrderableSummaryList (tests and panels)', { timeout: T }, async () => {
    const { db } = seed();
    const r = await db.run((ctx) => H['searchOrderables']!(req({ query: { q: 'cbc' } }), ctx));
    expect(r.status).toBe(200);
    expect(validatorFor('OrderableSummaryList')(r.body)).toEqual([]);
    expect(r.body.data.map((x: any) => x.code)).toEqual(['CBC', 'CBCP']);
  });
});

describe('If-Match handling', () => {
  it.each(['updateTest', 'replaceTestSpecimenRequirements'])('%s: no header -> 428 common.precondition_required; stale -> 409 common.version_conflict', { timeout: T }, async (id) => {
    const { db, t1 } = seed();
    const b = id === 'updateTest' ? { name: 'x' } : { specimen_requirements: [{ specimen_type_id: SERUM.id, is_preferred: true }] };
    const e1 = await rejection(db.run((ctx) => H[id]!(req({ params: { test_id: t1.test.id }, body: b }), ctx)));
    expect(isLimsError(e1, 'common.precondition_required')).toBe(true); expect(e1.statusCode).toBe(428);
    const e2 = await rejection(db.run((ctx) => H[id]!(req({ params: { test_id: t1.test.id }, headers: { 'if-match': '"2"' }, body: b }), ctx)));
    expect(isLimsError(e2, 'common.version_conflict')).toBe(true); expect(e2.statusCode).toBe(409);
    expect(db.row('tests', t1.test.id)!['version']).toBe(1);
  });

  it.each([['unquoted', '1'], ['weak', 'W/"1"'], ['star', '*'], ['zero', '"0"'], ['leading zero', '"01"'], ['non numeric', '"abc"'], ['negative', '"-1"'], ['beyond int32', '"99999999999"'], ['empty', '']])(
    'malformed If-Match (%s) -> 400, never 500 and never a write', { timeout: T }, async (_n, h) => {
      const { db, t1 } = seed();
      for (const [id, b] of [['updateTest', { name: 'x' }], ['replaceTestSpecimenRequirements', { specimen_requirements: [{ specimen_type_id: SERUM.id, is_preferred: true }] }]] as const) {
        const e = await rejection(db.run((ctx) => H[id]!(req({ params: { test_id: t1.test.id }, headers: { 'if-match': h }, body: b }), ctx)));
        expect(isLimsError(e)).toBe(true); expect(e.statusCode).toBe(400);
      }
      expect(db.row('tests', t1.test.id)!['version']).toBe(1);
    });
});

describe('probes S-1 / S-5 through the handlers', () => {
  it('S-1: a path id of tenant B (and a panel id) -> 404 common.not_found on get/update/replace; B untouched; B never listed or searched', { timeout: T }, async () => {
    const { db, tb, p } = seed();
    for (const id of [tb.test.id, p.panel.id]) {
      for (const [op, extra] of [['getTestDetail', {}], ['updateTest', { headers: { 'if-match': '"1"' }, body: { name: 'hijack' } }],
        ['replaceTestSpecimenRequirements', { headers: { 'if-match': '"1"' }, body: { specimen_requirements: [{ specimen_type_id: EDTA.id, is_preferred: true }] } }]] as const) {
        const e = await rejection(db.run((ctx) => H[op]!(req({ params: { test_id: id }, ...extra }), ctx)));
        expect(isLimsError(e, 'common.not_found'), `${op} ${e?.code}`).toBe(true); expect(e.statusCode).toBe(404);
      }
    }
    expect(db.row('orderables', tb.test.id)).toMatchObject({ name: 'Tenant B only', tenant_id: TENANT_B });
    expect(db.row('tests', tb.test.id)!['version']).toBe(1);
    const listed = await db.run((ctx) => H['listTests']!(req({ query: { is_active: 'all' } }), ctx));
    const found = await db.run((ctx) => H['searchOrderables']!(req({ query: { q: 'bonly' } }), ctx));
    expect(JSON.stringify([listed.body, found.body])).not.toContain('BONLY');
  });

  it('S-1: department / specimen type / container ids of tenant B in a create body -> 404; nothing written, no event', { timeout: T }, async () => {
    const { db } = seed();
    const e = await rejection(db.run((ctx) => H['createTest']!(req({ headers: { 'idempotency-key': 'k-1' }, body: body({ code: 'new', department_id: HAEM_B.id }) }), ctx)));
    expect(isLimsError(e, 'common.not_found')).toBe(true);
    expect(db.rows('orderables', TENANT_A).map((r) => r['code'])).toEqual(['CBC', 'CBCP']);
    expect(db.events).toHaveLength(0);
  });

  it('S-5: mass assignment through the handler (tenant_id, id, kind, version, revision, is_active) -> 400 and nothing written', { timeout: T }, async () => {
    const { db } = seed();
    for (const extra of [{ tenant_id: TENANT_B }, { id: ID(0xbad) }, { kind: 'panel' }, { version: 7 }, { revision: 3 }, { is_active: false }]) {
      const e = await rejection(db.run((ctx) => H['createTest']!(req({ headers: { 'idempotency-key': 'k-1' }, body: { ...body({ code: 'new' }), ...extra } }), ctx)));
      expect(e.statusCode).toBe(400);
    }
    expect(db.rows('orderables', TENANT_A)).toHaveLength(2);
    expect(db.events).toHaveLength(0);
  });

  it('duplicate code (also against a panel) -> 409 catalog.code_duplicate', { timeout: T }, async () => {
    const { db } = seed();
    for (const code of ['cbc', 'cbcp']) {
      const e = await rejection(db.run((ctx) => H['createTest']!(req({ headers: { 'idempotency-key': 'k-1' }, body: body({ code }) }), ctx)));
      expect(isLimsError(e, 'catalog.code_duplicate')).toBe(true); expect(e.statusCode).toBe(409);
    }
  });

  it('searchOrderables / listTests reject bad queries with 400 before any SQL', { timeout: T }, async () => {
    const { db } = seed();
    for (const [op, query] of [['searchOrderables', {}], ['searchOrderables', { q: '' }], ['searchOrderables', { q: 'a', limit: 51 }], ['listTests', { limit: 0 }], ['listTests', { sort: 'password' }]] as const) {
      const e = await rejection(db.run((ctx) => H[op]!(req({ query }), ctx)));
      expect(e.statusCode, `${op} ${JSON.stringify(query)}`).toBe(400);
    }
    expect(db.stmts.filter((s) => s.tenantId === TENANT_A)).toHaveLength(0);
  });

  it('fails closed without an authenticated request context: auth.unauthenticated, nothing reflected', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    for (const id of IDS) {
      const e = await rejection(H[id]!(req({ params: { test_id: ID(1) }, query: { q: planted }, headers: { 'if-match': '"1"', 'idempotency-key': 'k-1' }, body: body({ name: planted }) }), bare(id)));
      expect(isLimsError(e, 'auth.unauthenticated'), `${id} ${e?.code}`).toBe(true);
      expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain(planted);
    }
  });
});
