// T-07 (C3) — HTTP contract, permission matrix + probes for #29 createAnalyte, #30 getAnalyte, #31 updateAnalyte, #32 createAnalyteVersionDraft,
// #33 updateAnalyteVersionDraft, #34 publishAnalyteVersion, #35 discardAnalyteVersionDraft.
// Spec: 06-PLAN T-07 ("integration, probes"; publish needs catalog.reference_range.publish + catalog.test.manage), 02-TRD §5.2 (permissions / idempotency / If-Match),
//       PRD AC-03.6, 07-SECURITY S-4 (hand-written test for #34: both permissions), AB-21, AB-8/AB-9, S-1, S-5, AB-20; CR-C3-008 (stubs leave probes/pending.json).
// Core pipeline (schema, auth, the x-permission FLOOR, Idempotency-Key replay) is not re-tested: handlers are driven with a request-shaped object and the same
// HandlerContext subset the services get; responses are validated against the OpenAPI schemas. Conventions identical to tests.handlers.test.ts:
//   Handler (req: {params, query, headers, body}, ctx) => {status, body}; path params are `test_id` (#29), `analyte_id` (#30–#32), `analyte_version_id` (#33–#35);
//   If-Match arrives as the raw header '"<n>"'; context without tenantId/actor/tx/events -> auth.unauthenticated.
// #34 additionally needs ctx.ports.IdentityPort (assertRole): the handler asserts BOTH catalog.test.manage (always) and catalog.reference_range.publish BEFORE any
// data access (02-TRD §5.2 #34: "catalog.test.manage always, asserted in the handler"); a context without IdentityPort fails closed (auth.unauthenticated).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec, operationIds } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { TENANT_A } from '../helpers/catalogDb.js';
import { makeIdentity } from '../helpers/identity.js';
import { rejection } from '../helpers/t6.js';
import { CBC, HB, HB_V1, HB_V2, ID, M1, T1, T, aBody, pBody, setup7, versionsOf, type Env7 } from '../helpers/t7.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validatorFor = (name: string) => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return (x: unknown) => { const ok = v(x); return ok ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
};
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const IDS = ['createAnalyte', 'getAnalyte', 'updateAnalyte', 'createAnalyteVersionDraft', 'updateAnalyteVersionDraft', 'publishAnalyteVersion', 'discardAnalyteVersionDraft'] as const;
const MANAGE = 'catalog.test.manage', PUBLISH = 'catalog.reference_range.publish', READ = 'catalog.test.read';
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const bare = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } });
const world = () => setup7({ t6: { analyte_versions: [HB_V2] } });
/** Runs a handler in one tx with a fake IdentityPort holding `grants` at `aal` (default: both permissions, aal2). */
const call = (e: Env7, id: string, r: ReturnType<typeof req>, grants: readonly string[] = [MANAGE, PUBLISH, READ], aal: 1 | 2 = 2) => {
  const identity = makeIdentity(grants, aal);
  return { identity, done: e.db.run((ctx) => H[id]!(r, { ...ctx, ports: { IdentityPort: identity } })) };
};
const ok = (e: Env7, id: string, r: ReturnType<typeof req>) => call(e, id, r).done;
const VID = HB_V2.id as string;
const IDEM = { 'idempotency-key': 'k-1' };

describe('contract: the seven operations exist with the TRD permissions / idempotency / If-Match (S-4, S-16)', () => {
  it('operationIds are in catalog.yaml and in the manifest handlers', () => {
    const ids = operationIds(spec);
    for (const id of IDS) { expect(ids).toContain(id); expect(typeof (manifest.handlers as any)[id]).toBe('function'); expect((manifest.handlers as any)[id]).toBe(H[id]); }
  });
  it('x-permission floors: read = catalog.test.read, writes = catalog.test.manage, publish = the privileged catalog.reference_range.publish', () => {
    expect(opOf('getAnalyte')['x-permission']).toBe(READ);
    for (const id of ['createAnalyte', 'updateAnalyte', 'createAnalyteVersionDraft', 'updateAnalyteVersionDraft', 'discardAnalyteVersionDraft']) expect(opOf(id)['x-permission'], id).toBe(MANAGE);
    expect(opOf('publishAnalyteVersion')['x-permission']).toBe(PUBLISH);
  });
  it('idempotency: create / draft-create / publish require a key; get / update / draft-update take none; discard is optional', () => {
    for (const id of ['createAnalyte', 'createAnalyteVersionDraft', 'publishAnalyteVersion']) expect(opOf(id)['x-idempotency'], id).toBe('required');
    for (const id of ['getAnalyte', 'updateAnalyte', 'updateAnalyteVersionDraft']) expect(opOf(id)['x-idempotency'], id).toBe('none');
    expect(opOf('discardAnalyteVersionDraft')['x-idempotency']).toBe('optional');
  });
  it('update / draft-update / publish / discard need If-Match', () => {
    for (const id of ['updateAnalyte', 'updateAnalyteVersionDraft', 'publishAnalyteVersion', 'discardAnalyteVersionDraft']) expect(JSON.stringify(opOf(id).parameters), id).toContain('IfMatch');
  });
  it('request schemas are strict and carry no server-owned fields (REQ-SEC-080)', () => {
    for (const n of ['AnalyteCreate', 'AnalyteUpdate', 'AnalyteVersionDraftInput', 'AnalyteVersionDraftUpdate', 'AnalyteVersionDraftCreate', 'AnalyteVersionPublish']) {
      const s = spec.components.schemas[n];
      expect(s.additionalProperties, n).toBe(false);
      for (const k of ['id', 'tenant_id', 'version', 'revision', 'created_by', 'updated_by', 'status', 'version_no', 'analyte_id', 'test_id', 'published_at', 'published_by', 'current_version', 'draft_version_id']) {
        expect(Object.keys(s.properties), `${n}.${k}`).not.toContain(k);
      }
    }
    expect(Object.keys(spec.components.schemas['AnalyteUpdate'].properties)).not.toContain('code');
    expect(Object.keys(spec.components.schemas['AnalyteVersionDraftUpdate'].properties)).not.toContain('effective_from');
  });
});

describe('probes (CR-C3-008): the seven stubs are gone', () => {
  const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
  it('none of the seven operationIds is listed in probes/pending.json any more', () => {
    for (const id of IDS) expect(pending, id).not.toContain(id);
  });
  it.each(IDS)('%s does not answer 503 common.service_unavailable / not_implemented', { timeout: T }, async (id) => {
    const e = world();
    const x = await call(e, id, req({ params: { test_id: ID(1), analyte_id: ID(1), analyte_version_id: ID(1) }, headers: { 'if-match': '"1"', ...IDEM }, body: {} })).done.then(() => undefined, (r) => r);
    expect(x?.code).not.toBe('common.service_unavailable');
    expect(x?.detail).not.toBe('not_implemented');
  });
});

describe('handlers over the service, validated against the OpenAPI schemas', () => {
  it('createAnalyte -> 201 with exactly the contract Analyte (path param test_id; Idempotency-Key accepted)', { timeout: T }, async () => {
    const e = world();
    const r = await ok(e, 'createAnalyte', req({ params: { test_id: CBC.test.id }, headers: IDEM, body: aBody({ code: 'wbc', print_name: 'WBC' }) }));
    expect(r.status).toBe(201);
    expect(validatorFor('Analyte')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ code: 'WBC', test_id: CBC.test.id, version: 1 });
    expect(typeof r.body.draft_version_id).toBe('string');
  });

  it('getAnalyte -> 200 exactly the contract AnalyteDetail; as_of passes through; path param analyte_id', { timeout: T }, async () => {
    const e = world();
    const r = await ok(e, 'getAnalyte', req({ params: { analyte_id: HB.id }, query: { as_of: '2026-03-01T00:00:00.000Z' } }));
    expect(r.status).toBe(200);
    expect(validatorFor('AnalyteDetail')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: HB.id, code: 'HB', draft_version_id: VID });
    expect(r.body.current_version).toMatchObject({ id: HB_V1.id, decimals: 1 });
    expect(r.body.versions.map((v: any) => v.version_no)).toEqual([2, 1]);
    const before = await ok(e, 'getAnalyte', req({ params: { analyte_id: HB.id }, query: { as_of: '2025-01-01T00:00:00.000Z' } }));
    expect(before.body).not.toHaveProperty('current_version');
  });

  it('updateAnalyte with If-Match "1" -> 200 Analyte version 2', { timeout: T }, async () => {
    const e = world();
    const r = await ok(e, 'updateAnalyte', req({ params: { analyte_id: HB.id }, headers: { 'if-match': '"1"' }, body: { name: 'Haemoglobin', sort_order: 5 } }));
    expect(r.status).toBe(200);
    expect(validatorFor('Analyte')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ name: 'Haemoglobin', sort_order: 5, version: 2 });
  });

  it('createAnalyteVersionDraft -> 201 AnalyteVersion (draft, version_no 2)', { timeout: T }, async () => {
    const e = setup7();
    const r = await ok(e, 'createAnalyteVersionDraft', req({ params: { analyte_id: HB.id }, headers: IDEM, body: { copy_from_version_no: 1 } }));
    expect(r.status).toBe(201);
    expect(validatorFor('AnalyteVersion')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ analyte_id: HB.id, version_no: 2, status: 'draft', unit_code: 'g_dl', decimals: 1, method_id: M1.id });
  });

  it('updateAnalyteVersionDraft with If-Match "1" -> 200 AnalyteVersion version 2 (unset honoured)', { timeout: T }, async () => {
    const e = world();
    const r = await ok(e, 'updateAnalyteVersionDraft', req({ params: { analyte_version_id: VID }, headers: { 'if-match': '"1"' }, body: { decimals: 4, unset: ['method_id'] } }));
    expect(r.status).toBe(200);
    expect(validatorFor('AnalyteVersion')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: VID, decimals: 4, version: 2 });
    expect(r.body).not.toHaveProperty('method_id');
  });

  it('publishAnalyteVersion (both permissions, aal2) -> 200 AnalyteVersion status published', { timeout: T }, async () => {
    const e = world();
    const r = await ok(e, 'publishAnalyteVersion', req({ params: { analyte_version_id: VID }, headers: { 'if-match': '"1"', ...IDEM }, body: pBody({ effective_from: T1 }) }));
    expect(r.status).toBe(200);
    expect(validatorFor('AnalyteVersion')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: VID, status: 'published', version_no: 2, effective_from: T1, version: 2 });
    expect(versionsOf(e.db, HB.id).map((v) => v['status'])).toEqual(['superseded', 'published']);
  });

  it('discardAnalyteVersionDraft with If-Match "1" -> 200 AnalyteVersion status discarded', { timeout: T }, async () => {
    const e = world();
    const r = await ok(e, 'discardAnalyteVersionDraft', req({ params: { analyte_version_id: VID }, headers: { 'if-match': '"1"' } }));
    expect(r.status).toBe(200);
    expect(validatorFor('AnalyteVersion')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: VID, status: 'discarded', version: 2 });
  });
});

describe('If-Match handling', () => {
  const CASES: Array<[string, object, unknown]> = [
    ['updateAnalyte', { analyte_id: HB.id }, { name: 'x' }],
    ['updateAnalyteVersionDraft', { analyte_version_id: VID }, { decimals: 3 }],
    ['publishAnalyteVersion', { analyte_version_id: VID }, pBody()],
    ['discardAnalyteVersionDraft', { analyte_version_id: VID }, undefined],
  ];
  it.each(CASES)('%s: no header -> 428 common.precondition_required; stale -> 409 common.version_conflict; nothing written', { timeout: T }, async (id, params, body) => {
    const e = world();
    const e1 = await rejection(call(e, id, req({ params, headers: IDEM, body })).done);
    expect(isLimsError(e1, 'common.precondition_required')).toBe(true); expect(e1.statusCode).toBe(428);
    const e2 = await rejection(call(e, id, req({ params, headers: { 'if-match': '"7"', ...IDEM }, body })).done);
    expect(isLimsError(e2, 'common.version_conflict')).toBe(true); expect(e2.statusCode).toBe(409);
    expect(e.db.row('analyte_versions', VID)).toMatchObject({ status: 'draft', version: 1 });
    expect(e.db.row('analytes', HB.id)!['version']).toBe(1);
    expect(e.db.events).toHaveLength(0);
  });

  it.each(CASES.flatMap(([id, params, body]) => [['unquoted', '1'], ['weak', 'W/"1"'], ['star', '*'], ['zero', '"0"'], ['leading zero', '"01"'], ['non numeric', '"abc"'], ['negative', '"-1"'], ['beyond int32', '"99999999999"'], ['empty', '']]
    .map(([n, h]) => [id, n, h, params, body] as const)))('%s: malformed If-Match (%s) -> 400, never 500 and never a write', { timeout: T }, async (id, _n, h, params, body) => {
    const e = world();
    const x = await rejection(call(e, id, req({ params, headers: { 'if-match': h, ...IDEM }, body })).done);
    expect(isLimsError(x)).toBe(true); expect(x.statusCode).toBe(400);
    expect(e.db.row('analyte_versions', VID)).toMatchObject({ status: 'draft', version: 1 });
    expect(e.db.events).toHaveLength(0);
  });
});

describe('S-4 / AC-03.6 / AB-21: publishing an analyte version needs BOTH catalog.reference_range.publish (aal2) and catalog.test.manage', () => {
  const publishReq = () => req({ params: { analyte_version_id: VID }, headers: { 'if-match': '"1"', ...IDEM }, body: pBody() });
  const untouched = (e: Env7) => {
    expect(e.db.row('analyte_versions', VID)).toMatchObject({ status: 'draft', version: 1 });
    expect(e.db.row('analyte_versions', HB_V1.id)).toMatchObject({ status: 'published', version: 1 });
    expect(e.db.events).toHaveLength(0); expect(e.db.revisionOf(TENANT_A)).toBe(417);
    expect(e.db.stmts.filter((s) => s.tenantId === TENANT_A)).toHaveLength(0);       // authorisation happens BEFORE any data access
  };

  it('both permissions at aal2 -> 200; the handler asserted catalog.test.manage AND catalog.reference_range.publish through IdentityPort.assertRole', { timeout: T }, async () => {
    const e = world();
    const c = call(e, 'publishAnalyteVersion', publishReq(), [MANAGE, PUBLISH], 2);
    expect((await c.done).status).toBe(200);
    const asked = c.identity.calls.map((x) => x.permission);
    expect(asked).toContain(MANAGE); expect(asked).toContain(PUBLISH);
    expect(c.identity.calls.every((x) => x.ctx !== undefined && x.ctx !== null)).toBe(true);
  });

  it.each([
    ['lab_manager at aal1 (both permissions)', [MANAGE, PUBLISH], 1, 'auth.mfa_required'],
    ['a user with ONLY catalog.test.manage (aal2)', [MANAGE], 2, 'auth.forbidden'],
    ['a user with ONLY catalog.test.manage (aal1)', [MANAGE], 1, 'auth.forbidden'],
    ['a pathologist: ONLY catalog.reference_range.publish (aal2)', [PUBLISH], 2, 'auth.forbidden'],
    ['a user with neither', [READ], 2, 'auth.forbidden'],
    ['a user with no permission at all', [], 2, 'auth.forbidden'],
  ] as const)('%s -> 403 %s; nothing read, nothing written, no event', { timeout: T }, async (_n, grants, aal, code) => {
    const e = world();
    const x = await rejection(call(e, 'publishAnalyteVersion', publishReq(), grants, aal).done);
    expect(isLimsError(x, code), `got ${x?.code}`).toBe(true); expect(x.statusCode).toBe(403);
    untouched(e);
  });

  it('no IdentityPort in the context -> auth.unauthenticated (fails closed), nothing written', { timeout: T }, async () => {
    const e = world();
    const x = await rejection(e.db.run((ctx) => H['publishAnalyteVersion']!(publishReq(), ctx)));
    expect(isLimsError(x, 'auth.unauthenticated')).toBe(true);
    untouched(e);
  });

  it('the permission check precedes validation and state: a forbidden caller with a bad body / wrong state still gets 403', { timeout: T }, async () => {
    const e = world();
    const bad = req({ params: { analyte_version_id: HB_V1.id }, headers: { 'if-match': '"9"', ...IDEM }, body: { change_reason: '' } });
    const x = await rejection(call(e, 'publishAnalyteVersion', bad, [MANAGE], 2).done);
    expect(isLimsError(x, 'auth.forbidden')).toBe(true);
  });

  it('the other six operations do not need the privileged permission: catalog.test.manage at aal1 can create / patch / discard (pipeline floors apply separately)', { timeout: T }, async () => {
    const e = world();
    const c = call(e, 'discardAnalyteVersionDraft', req({ params: { analyte_version_id: VID }, headers: { 'if-match': '"1"' } }), [MANAGE], 1);
    expect((await c.done).status).toBe(200);
    expect(c.identity.calls.map((x) => x.permission)).not.toContain(PUBLISH);
  });
});

describe('probes S-1 / S-5 / AB-9 through the handlers', () => {
  it('S-1: tenant B\'s analyte / version ids -> 404 common.not_found on every operation; B untouched', { timeout: T }, async () => {
    const e = world();
    const bAnalyte = ID(0x3003), bVersion = ID(0x4004);                                   // HB_B, B_V1
    const cases: Array<[string, object, object, unknown]> = [
      ['getAnalyte', { analyte_id: bAnalyte }, {}, undefined],
      ['updateAnalyte', { analyte_id: bAnalyte }, { 'if-match': '"1"' }, { name: 'hijack' }],
      ['createAnalyteVersionDraft', { analyte_id: bAnalyte }, IDEM, {}],
      ['updateAnalyteVersionDraft', { analyte_version_id: bVersion }, { 'if-match': '"1"' }, { decimals: 3 }],
      ['publishAnalyteVersion', { analyte_version_id: bVersion }, { 'if-match': '"1"', ...IDEM }, pBody()],
      ['discardAnalyteVersionDraft', { analyte_version_id: bVersion }, { 'if-match': '"1"' }, undefined],
      ['createAnalyte', { test_id: ID(0x1003) }, IDEM, aBody({ code: 'newone' })],       // TEST_B
    ];
    for (const [id, params, headers, body] of cases) {
      const x = await rejection(call(e, id, req({ params, headers, body })).done);
      expect(isLimsError(x, 'common.not_found'), `${id} ${x?.code}`).toBe(true); expect(x.statusCode).toBe(404);
    }
    expect(e.db.row('analytes', ID(0x3003))).toMatchObject({ name: 'Tenant B hemoglobin', version: 1 });
    expect(e.db.row('analyte_versions', bVersion)).toMatchObject({ status: 'published', version: 1 });
    expect(e.db.events).toHaveLength(0);
  });

  it('malformed path ids -> 400, never 500', { timeout: T }, async () => {
    const e = world();
    for (const [id, key] of [['getAnalyte', 'analyte_id'], ['updateAnalyte', 'analyte_id'], ['createAnalyteVersionDraft', 'analyte_id'], ['updateAnalyteVersionDraft', 'analyte_version_id'],
      ['publishAnalyteVersion', 'analyte_version_id'], ['discardAnalyteVersionDraft', 'analyte_version_id'], ['createAnalyte', 'test_id']] as const) {
      const x = await rejection(call(e, id, req({ params: { [key]: "1' OR '1'='1" }, headers: { 'if-match': '"1"', ...IDEM }, body: id === 'createAnalyte' ? aBody() : id === 'publishAnalyteVersion' ? pBody() : {} })).done);
      expect(x.statusCode, id).toBe(400);
    }
  });

  it('S-5: mass assignment through the handlers (server-owned fields) -> 400 and nothing written', { timeout: T }, async () => {
    const e = world(); const rows = JSON.stringify([e.db.rows('analytes'), e.db.rows('analyte_versions')]);
    const trials: Array<[string, object, object, unknown]> = [
      ['createAnalyte', { test_id: CBC.test.id }, IDEM, { ...aBody({ code: 'newone' }), tenant_id: ID(0xbad) }],
      ['createAnalyte', { test_id: CBC.test.id }, IDEM, { ...aBody({ code: 'newone' }), id: ID(0xbad) }],
      ['updateAnalyte', { analyte_id: HB.id }, { 'if-match': '"1"' }, { code: 'HGB' }],
      ['updateAnalyteVersionDraft', { analyte_version_id: VID }, { 'if-match': '"1"' }, { status: 'published' }],
      ['updateAnalyteVersionDraft', { analyte_version_id: VID }, { 'if-match': '"1"' }, { effective_from: '2030-01-01T00:00:00.000Z' }],
      ['publishAnalyteVersion', { analyte_version_id: VID }, { 'if-match': '"1"', ...IDEM }, { ...pBody(), published_by: ID(0xbad) }],
      ['createAnalyteVersionDraft', { analyte_id: HB.id }, IDEM, { status: 'published' }],
    ];
    for (const [id, params, headers, body] of trials) {
      const x = await rejection(call(e, id, req({ params, headers, body })).done);
      expect(x.statusCode, id).toBe(400);
    }
    expect(JSON.stringify([e.db.rows('analytes'), e.db.rows('analyte_versions')])).toBe(rows);
    expect(e.db.events).toHaveLength(0);
  });

  it('AB-9: PATCH of a clinical field of a PUBLISHED version through the handler -> 409 catalog.version_in_use; the row is unchanged', { timeout: T }, async () => {
    const e = world();
    const x = await rejection(call(e, 'updateAnalyteVersionDraft', req({ params: { analyte_version_id: HB_V1.id }, headers: { 'if-match': '"1"' }, body: { decimals: 4 } })).done);
    expect(isLimsError(x, 'catalog.version_in_use')).toBe(true); expect(x.statusCode).toBe(409);
    expect(e.db.row('analyte_versions', HB_V1.id)).toMatchObject({ decimals: 1, version: 1, status: 'published' });
  });

  it('AC-03.4 through the handler: a second draft -> 409 common.version_conflict', { timeout: T }, async () => {
    const e = world();
    const x = await rejection(call(e, 'createAnalyteVersionDraft', req({ params: { analyte_id: HB.id }, headers: IDEM, body: {} })).done);
    expect(isLimsError(x, 'common.version_conflict')).toBe(true); expect(x.statusCode).toBe(409);
  });

  it('fails closed without an authenticated request context: auth.unauthenticated, nothing reflected', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    for (const id of IDS) {
      const x = await rejection(H[id]!(req({ params: { test_id: ID(1), analyte_id: ID(1), analyte_version_id: ID(1) }, query: { as_of: planted }, headers: { 'if-match': '"1"', ...IDEM }, body: aBody({ name: planted }) }), bare(id)));
      expect(isLimsError(x, 'auth.unauthenticated'), `${id} ${x?.code}`).toBe(true);
      expect(JSON.stringify({ m: x.message, d: x.detail, errs: x.errors })).not.toContain(planted);
    }
  });

  it('validation errors never echo submitted values (AB-20)', { timeout: T }, async () => {
    const e = world();
    const planted = 'PLANTED-VALUE-77aa';
    const x = await rejection(call(e, 'createAnalyte', req({ params: { test_id: CBC.test.id }, headers: IDEM, body: aBody({ code: planted + ' bad code', name: planted }, { unit_code: planted }) })).done);
    expect(x.statusCode).toBe(400);
    expect(JSON.stringify({ m: x.message, d: x.detail, errs: x.errors })).not.toContain(planted);
  });
});
