// T-14 (C3) — HTTP contract + probes for #28 setTestTatTargets (PUT /v1/catalog/tests/{test_id}/tat-targets).
// Spec: 02-TRD §5.2 #28 (catalog.test.manage, no Idempotency-Key, `{targets[] (<=2), effective_from?}` -> 200 Test), contracts/openapi/catalog.yaml (IfMatch param,
//       TatTargetsSet / TatTargetInput strict), 07-SECURITY S-1, S-4, S-5, REQ-SEC-080; CR-C3-008 (a stub leaves probes/pending.json when swapped).
// Same conventions as tests.handlers.test.ts: Handler (req: {params, query, headers, body}, ctx) => {status, body}; path param `test_id`; If-Match arrives as '"<n>"'.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec, operationIds } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { TENANT_A, TENANT_B } from '../helpers/catalogDb.js';
import { ID, pnl, tat, tst } from '../helpers/testsDb.js';
import { HAEM, HAEM_B, T, rejection, setup } from '../helpers/t6.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validatorFor = (name: string) => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return (x: unknown) => { const ok = v(x); return ok ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
};
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const ID28 = 'setTestTatTargets';
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any }>>;
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const bare = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } });
const seed = () => {
  const t1 = tst(1, TENANT_A, HAEM.id, { code: 'CBC' });
  const tb = tst(2, TENANT_B, HAEM_B.id, { code: 'BONLY' });
  const p = pnl(1, TENANT_A, { code: 'CBCP' });
  return { t1, tb, p, ...setup({ t6: {
    orderables: [t1.orderable, tb.orderable, p.orderable], tests: [t1.test, tb.test], panels: [p.panel],
    tat_targets: [tat(1, TENANT_A, t1.test.id), tat(2, TENANT_A, t1.test.id, { priority: 'urgent', target_seconds: 3600 }), tat(3, TENANT_B, tb.test.id)],
  } }) };
};
const TARGETS = [{ priority: 'routine', segment: 'within_lab', target_seconds: 7200 }, { priority: 'urgent', segment: 'within_lab', target_seconds: 1800 }];

describe('contract: #28 exists with the TRD permission / idempotency / If-Match', () => {
  it('operationId is in catalog.yaml and in the manifest handlers', () => {
    expect(operationIds(spec)).toContain(ID28);
    expect(typeof (manifest.handlers as any)[ID28]).toBe('function');
    expect((manifest.handlers as any)[ID28]).toBe(H[ID28]);
  });
  it('PUT /v1/catalog/tests/{test_id}/tat-targets: catalog.test.manage, x-idempotency none, If-Match parameter, 200 Test', () => {
    const op = opOf(ID28);
    expect(op['x-permission']).toBe('catalog.test.manage');
    expect(op['x-idempotency']).toBe('none');
    expect(JSON.stringify(op.parameters)).toContain('IfMatch');
    expect(spec.paths['/v1/catalog/tests/{test_id}/tat-targets'].put.operationId).toBe(ID28);
    expect(op.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/Test');
  });
  it('request schemas are strict and carry no server-owned fields (REQ-SEC-080, S-5)', () => {
    for (const n of ['TatTargetsSet', 'TatTargetInput']) {
      const s = spec.components.schemas[n];
      expect(s.additionalProperties, n).toBe(false);
      for (const k of ['id', 'tenant_id', 'test_id', 'version', 'revision', 'created_by', 'updated_by', 'effective_to', 'is_active']) expect(Object.keys(s.properties), `${n}.${k}`).not.toContain(k);
    }
    expect(spec.components.schemas['TatTargetsSet'].properties.targets.maxItems).toBe(2);
  });
});

describe('probes (CR-C3-008): the stub is gone', () => {
  it('setTestTatTargets is no longer listed in probes/pending.json', () => {
    const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
    expect(pending).not.toContain(ID28);
  });
  it('the handler does not answer 503 common.service_unavailable / not_implemented', { timeout: T }, async () => {
    const { db } = seed();
    const e = await db.run((ctx) => H[ID28]!(req({ params: { test_id: ID(0x1) }, headers: { 'if-match': '"1"' }, body: { targets: [] } }), ctx)).then(() => undefined, (x) => x);
    expect(e?.code).not.toBe('common.service_unavailable');
    expect(e?.detail).not.toBe('not_implemented');
  });
});

describe('handler over the service, validated against the OpenAPI schemas', () => {
  it('PUT with If-Match "1" -> 200 exactly the contract Test; tat_targets hold the new open rows; version 2', { timeout: T }, async () => {
    const { db, t1 } = seed();
    const r = await db.run((ctx) => H[ID28]!(req({ params: { test_id: t1.test.id }, headers: { 'if-match': '"1"' }, body: { targets: TARGETS } }), ctx));
    expect(r.status).toBe(200);
    expect(validatorFor('Test')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: t1.test.id, code: 'CBC', version: 2 });
    expect(r.body.tat_targets.map((x: any) => [x.priority, x.segment, x.target_seconds])).toEqual([['routine', 'within_lab', 7200], ['urgent', 'within_lab', 1800]]);
    expect(db.rows('tat_targets', TENANT_A).filter((x) => x['effective_to'] == null)).toHaveLength(2);
  });

  it('the request body of the OpenAPI example is accepted by TatTargetsSet and by the handler', { timeout: T }, async () => {
    const { db, t1 } = seed();
    const example = { targets: [{ priority: 'routine', segment: 'within_lab', target_seconds: 3600 }], effective_from: '2026-11-07T10:00:00.000Z' };
    expect(validatorFor('TatTargetsSet')(example)).toEqual([]);
    const r = await db.run((ctx) => H[ID28]!(req({ params: { test_id: t1.test.id }, headers: { 'if-match': '"1"' }, body: example }), ctx));
    expect(r.status).toBe(200);
    expect(validatorFor('Test')(r.body)).toEqual([]);
  });

  it('segments that differ -> 400 common.validation_failed at /targets/1/segment through the handler', { timeout: T }, async () => {
    const { db, t1 } = seed();
    const e = await rejection(db.run((ctx) => H[ID28]!(req({ params: { test_id: t1.test.id }, headers: { 'if-match': '"1"' },
      body: { targets: [TARGETS[0], { ...TARGETS[1], segment: 'total' }] } }), ctx)));
    expect(isLimsError(e, 'common.validation_failed')).toBe(true);
    expect(e.statusCode).toBe(400);
    expect((e.errors ?? []).map((x: { path: string }) => x.path)).toContain('/targets/1/segment');
  });
});

describe('If-Match handling', () => {
  it('no header -> 428 common.precondition_required; stale -> 409 common.version_conflict; nothing written', { timeout: T }, async () => {
    const { db, t1 } = seed();
    const before = JSON.stringify(db.rows('tat_targets'));
    const e1 = await rejection(db.run((ctx) => H[ID28]!(req({ params: { test_id: t1.test.id }, body: { targets: TARGETS } }), ctx)));
    expect(isLimsError(e1, 'common.precondition_required')).toBe(true); expect(e1.statusCode).toBe(428);
    const e2 = await rejection(db.run((ctx) => H[ID28]!(req({ params: { test_id: t1.test.id }, headers: { 'if-match': '"2"' }, body: { targets: TARGETS } }), ctx)));
    expect(isLimsError(e2, 'common.version_conflict')).toBe(true); expect(e2.statusCode).toBe(409);
    expect(JSON.stringify(db.rows('tat_targets'))).toBe(before);
    expect(db.row('tests', t1.test.id)!['version']).toBe(1);
  });

  it.each([['unquoted', '1'], ['weak', 'W/"1"'], ['star', '*'], ['zero', '"0"'], ['leading zero', '"01"'], ['non numeric', '"abc"'], ['negative', '"-1"'], ['beyond int32', '"99999999999"'], ['empty', '']])(
    'malformed If-Match (%s) -> 400, never 500 and never a write', { timeout: T }, async (_n, h) => {
      const { db, t1 } = seed();
      const before = JSON.stringify(db.rows('tat_targets'));
      const e = await rejection(db.run((ctx) => H[ID28]!(req({ params: { test_id: t1.test.id }, headers: { 'if-match': h }, body: { targets: TARGETS } }), ctx)));
      expect(isLimsError(e)).toBe(true); expect(e.statusCode).toBe(400);
      expect(JSON.stringify(db.rows('tat_targets'))).toBe(before);
    });
});

describe('probes S-1 / S-5 through the handler', () => {
  it('S-1: a path id of tenant B, a panel id and an unknown id -> 404 common.not_found; B\'s targets untouched', { timeout: T }, async () => {
    const { db, tb, p } = seed();
    const b = JSON.stringify(db.rows('tat_targets', TENANT_B));
    for (const id of [tb.test.id, p.panel.id, ID(0xdead)]) {
      const e = await rejection(db.run((ctx) => H[ID28]!(req({ params: { test_id: id }, headers: { 'if-match': '"1"' }, body: { targets: TARGETS } }), ctx)));
      expect(isLimsError(e, 'common.not_found'), `${id} ${e?.code}`).toBe(true); expect(e.statusCode).toBe(404);
    }
    expect(JSON.stringify(db.rows('tat_targets', TENANT_B))).toBe(b);
    expect(db.events).toHaveLength(0);
  });

  it('S-5: mass assignment through the handler (tenant_id, test_id, version, effective_to at the top level and inside a target) -> 400, nothing written', { timeout: T }, async () => {
    const { db, t1 } = seed();
    const before = JSON.stringify(db.rows('tat_targets'));
    for (const body of [{ targets: TARGETS, tenant_id: TENANT_B }, { targets: TARGETS, version: 9 }, { targets: TARGETS, effective_to: '2030-01-01T00:00:00.000Z' },
      { targets: [{ ...TARGETS[0], test_id: ID(0xbad) }] }, { targets: [{ ...TARGETS[0], effective_to: '2030-01-01T00:00:00.000Z' }] }, { targets: [{ ...TARGETS[0], tenant_id: TENANT_B }] }]) {
      const e = await rejection(db.run((ctx) => H[ID28]!(req({ params: { test_id: t1.test.id }, headers: { 'if-match': '"1"' }, body }), ctx)));
      expect(e.statusCode).toBe(400);
    }
    expect(JSON.stringify(db.rows('tat_targets'))).toBe(before);
    expect(db.events).toHaveLength(0);
  });

  it('fails closed without an authenticated request context: auth.unauthenticated, nothing reflected', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    const e = await rejection(H[ID28]!(req({ params: { test_id: ID(1) }, headers: { 'if-match': '"1"' }, body: { targets: [{ priority: planted, segment: 'within_lab', target_seconds: 60 }] } }), bare(ID28)));
    expect(isLimsError(e, 'auth.unauthenticated'), `${e?.code}`).toBe(true);
    expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain(planted);
  });
});
