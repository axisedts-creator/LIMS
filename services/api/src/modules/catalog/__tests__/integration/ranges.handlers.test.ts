// T-08 (C3) — HTTP contract, permission matrix + probes for #37–#43 (reference-range sets) and #44–#50 (critical-limit sets).
// Spec: 06-PLAN T-08 (publish/retire need catalog.reference_range.publish — privileged, no interim grant), 02-TRD §5.2 (permissions / idempotency / If-Match / path params),
//       PRD AC-05.9 (a lab_manager without aal2 gets 403 auth.mfa_required), AC-06.4, 07-SECURITY S-4, S-5, AB-8, AB-21, CR-C3-003, CR-C3-008 (stubs leave probes/pending.json).
// Core pipeline (schema, auth, the x-permission FLOOR, Idempotency-Key replay) is not re-tested: handlers are driven with a request-shaped object and the same HandlerContext
// subset the services get; responses are validated against the OpenAPI schemas. Conventions identical to analyteVersions.handlers.test.ts:
//   Handler (req: {params, query, headers, body}, ctx) => {status, body}; path params are `analyte_id` (list, create) and `set_id` (get, bands, publish, retire, discard);
//   If-Match arrives as the raw header '"<n>"'; a context without tenantId/actor/tx/events -> auth.unauthenticated.
// publish and retire additionally assert catalog.reference_range.publish through ctx.ports.IdentityPort.assertRole BEFORE any parsing or data access (fail closed without the port).
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
import { FAMILIES, HB, ID, M1, T, draftSet, pBody, rBody, setup8, type Env8, type Family, type Row } from '../helpers/t8.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validatorFor = (name: string) => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return (x: unknown) => { const ok = v(x); return ok ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
};
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const MANAGE = 'catalog.test.manage', PUBLISH = 'catalog.reference_range.publish', READ = 'catalog.test.read';
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const IDEM = { 'idempotency-key': 'k-1' };
const IFM = { 'if-match': '"1"' };
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Runs a handler in one tx with a fake IdentityPort holding `grants` at `aal` (default: all three permissions, aal2). */
const call = (e: Env8, id: string, r: ReturnType<typeof req>, grants: readonly string[] = [MANAGE, PUBLISH, READ], aal: 1 | 2 = 2) => {
  const identity = makeIdentity(grants, aal);
  return { identity, done: e.db.run((ctx) => H[id]!(r, { ...ctx, ports: { IdentityPort: identity } })) };
};
const ok = (e: Env8, id: string, r: ReturnType<typeof req>) => call(e, id, r).done;

const OPS = ['list', 'create', 'get', 'replace', 'publish', 'retire', 'discard'] as const;
const ALL_IDS = FAMILIES.flatMap((f) => OPS.map((o) => f[o]));
const P1 = (f: Family, o: Row = {}) => f.mkSet(1, TENANT_A, HB.id, { method_id: M1.id, ...o });   // HB_V1 has method M1: the set snapshot must match (unit/method rule, TRD §5.2)
const D2 = (f: Family) => draftSet(f.mkSet, 2, HB.id, { method_id: M1.id });
const world = (f: Family) => setup8({ t6: { [f.setTable]: [P1(f), D2(f)], [f.bandTable]: [f.mkBand(1, TENANT_A, P1(f).id as string, { low: '13.0', high: '17.0', sort_order: 0 }),
  f.mkBand(11, TENANT_A, D2(f).id as string, { sex: 'male', age_low_value: 18, age_low_unit: 'year', low: '13.0', high: '17.0', sort_order: 0 }),
  f.mkBand(12, TENANT_A, D2(f).id as string, { sex: 'any', age_high_value: 18, age_high_unit: 'year', low: '11.0', high: '16.0', sort_order: 1 })] } as never });

describe('contract: the fourteen operations exist with the TRD permissions / idempotency / If-Match (S-4, S-16)', () => {
  it('operationIds are in catalog.yaml and in the manifest handlers', () => {
    const ids = operationIds(spec);
    for (const id of ALL_IDS) { expect(ids).toContain(id); expect(typeof (manifest.handlers as any)[id]).toBe('function'); expect((manifest.handlers as any)[id]).toBe(H[id]); }
  });

  it.each(FAMILIES)('$name x-permission floors: list / get = catalog.test.read; create / replace / discard = catalog.test.manage; publish / retire = the privileged catalog.reference_range.publish', (f) => {
    for (const o of ['list', 'get'] as const) expect(opOf(f[o])['x-permission'], f[o]).toBe(READ);
    for (const o of ['create', 'replace', 'discard'] as const) expect(opOf(f[o])['x-permission'], f[o]).toBe(MANAGE);
    for (const o of ['publish', 'retire'] as const) expect(opOf(f[o])['x-permission'], f[o]).toBe(PUBLISH);
  });

  it.each(FAMILIES)('$name idempotency: create / publish / retire require a key; list / get / replace take none; discard is optional', (f) => {
    for (const o of ['create', 'publish', 'retire'] as const) expect(opOf(f[o])['x-idempotency'], f[o]).toBe('required');
    for (const o of ['list', 'get', 'replace'] as const) expect(opOf(f[o])['x-idempotency'], f[o]).toBe('none');
    expect(opOf(f.discard)['x-idempotency']).toBe('optional');
  });

  it.each(FAMILIES)('$name replace / publish / retire / discard need If-Match', (f) => {
    for (const o of ['replace', 'publish', 'retire', 'discard'] as const) expect(JSON.stringify(opOf(f[o]).parameters), f[o]).toContain('IfMatch');
  });

  it('request schemas are strict and carry no server-owned fields (REQ-SEC-080, S-5)', () => {
    const SERVER = ['id', 'tenant_id', 'version', 'revision', 'created_by', 'updated_by', 'status', 'version_no', 'analyte_id', 'set_id', 'published_at', 'published_by', 'effective_to', 'unit_code', 'method_id'];
    for (const n of ['RangeSetDraftCreate', 'RangeSetBandsReplace', 'CriticalSetDraftCreate', 'CriticalSetBandsReplace', 'PublishRequest', 'RetireRequest', 'RangeBand', 'CriticalBand', 'AgeBound']) {
      const s = spec.components.schemas[n];
      expect(s.additionalProperties, n).toBe(false);
      if (n === 'AgeBound') continue;
      for (const k of SERVER) expect(Object.keys(s.properties), `${n}.${k}`).not.toContain(k);
    }
    expect(Object.keys(spec.components.schemas['PublishRequest'].properties)).not.toContain('effective_to');
    expect(Object.keys(spec.components.schemas['RetireRequest'].properties)).toEqual(expect.arrayContaining(['change_reason', 'effective_at']));
  });
});

describe('probes (CR-C3-008): the fourteen stubs are gone', () => {
  const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
  it('none of the fourteen operationIds is listed in probes/pending.json any more', () => {
    for (const id of ALL_IDS) expect(pending, id).not.toContain(id);
  });
  it.each(ALL_IDS)('%s does not answer 503 common.service_unavailable / not_implemented', { timeout: T }, async (id) => {
    const e = setup8();
    const x = await call(e, id, req({ params: { analyte_id: ID(1), set_id: ID(1) }, headers: { ...IFM, ...IDEM }, body: {} })).done.then(() => undefined, (r) => r);
    expect(x?.code).not.toBe('common.service_unavailable');
    expect(x?.detail).not.toBe('not_implemented');
  });
});

describe.each(FAMILIES)('$name handlers over the service, validated against the OpenAPI schemas', (f) => {
  it('list -> 200 {data} exactly the contract list schema (path param analyte_id; optional ?status)', { timeout: T }, async () => {
    const e = world(f);
    const r = await ok(e, f.list, req({ params: { analyte_id: HB.id } }));
    expect(r.status).toBe(200);
    expect(validatorFor(f.listSchema)(r.body)).toEqual([]);
    expect(r.body.data.map((s: any) => s.version_no)).toEqual([2, 1]);
    const onlyDraft = await ok(e, f.list, req({ params: { analyte_id: HB.id }, query: { status: 'draft' } }));
    expect(onlyDraft.body.data.map((s: any) => s.status)).toEqual(['draft']);
  });

  it('create -> 201 exactly the contract set schema (Idempotency-Key accepted; body optional)', { timeout: T }, async () => {
    const e = setup8();
    const r = await ok(e, f.create, req({ params: { analyte_id: HB.id }, headers: IDEM, body: { bands: [clean(f.band({ sex: 'male', age_low: { value: 18, unit: 'year' } }))] } }));
    expect(r.status).toBe(201);
    expect(validatorFor(f.schema)(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ analyte_id: HB.id, version_no: 1, status: 'draft', version: 1 });
    const bare = await ok(setup8(), f.create, req({ params: { analyte_id: HB.id }, headers: IDEM }));
    expect(bare.status).toBe(201); expect(bare.body.bands).toEqual([]);
  });

  it('get -> 200 exactly the contract set schema (path param set_id)', { timeout: T }, async () => {
    const r = await ok(world(f), f.get, req({ params: { set_id: P1(f).id } }));
    expect(r.status).toBe(200);
    expect(validatorFor(f.schema)(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: P1(f).id, status: 'published', version_no: 1 });
  });

  it('replace with If-Match "1" -> 200 set with the new bands, version 2', { timeout: T }, async () => {
    const e = world(f);
    const r = await ok(e, f.replace, req({ params: { set_id: D2(f).id }, headers: IFM, body: { bands: [clean(f.band({ sex: 'female', low: '12.0', high: '15.0' }))] } }));
    expect(r.status).toBe(200);
    expect(validatorFor(f.schema)(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ version: 2 }); expect(r.body.bands).toHaveLength(1);
  });

  it('publish with If-Match "1" and a key -> 200 published set (effective_from filled in)', { timeout: T }, async () => {
    const e = world(f);
    const r = await ok(e, f.publish, req({ params: { set_id: D2(f).id }, headers: { ...IFM, ...IDEM }, body: pBody() }));
    expect(r.status).toBe(200);
    expect(validatorFor(f.schema)(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: D2(f).id, status: 'published', version: 2 });
    expect(typeof r.body.effective_from).toBe('string');
  });

  it('retire with If-Match "1" and a key -> 200 retired set with effective_to', { timeout: T }, async () => {
    const e = world(f);
    const r = await ok(e, f.retire, req({ params: { set_id: P1(f).id }, headers: { ...IFM, ...IDEM }, body: rBody() }));
    expect(r.status).toBe(200);
    expect(validatorFor(f.schema)(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: P1(f).id, status: 'retired', version: 2 }); expect(typeof r.body.effective_to).toBe('string');
  });

  it('discard with If-Match "1" -> 200 discarded set', { timeout: T }, async () => {
    const r = await ok(world(f), f.discard, req({ params: { set_id: D2(f).id }, headers: IFM }));
    expect(r.status).toBe(200);
    expect(validatorFor(f.schema)(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ status: 'discarded' });
  });

  it('a missing / malformed If-Match -> 428 common.precondition_required (the handler does not default it)', { timeout: T }, async () => {
    for (const [id, p, b] of [[f.replace, D2(f).id, { bands: [clean(f.band())] }], [f.publish, D2(f).id, pBody()], [f.retire, P1(f).id, rBody()], [f.discard, D2(f).id, undefined]] as const) {
      const x = await rejection(ok(world(f), id, req({ params: { set_id: p }, headers: IDEM, body: b })));
      expect(isLimsError(x, 'common.precondition_required'), `${id}: ${x?.code}`).toBe(true);
    }
  });

  it('errors from the service pass through with their status (404 unknown set, 409 wrong state)', { timeout: T }, async () => {
    const e = world(f);
    const nf = await rejection(ok(e, f.get, req({ params: { set_id: ID(0xdead) } })));
    expect(isLimsError(nf, 'common.not_found')).toBe(true); expect(nf.statusCode).toBe(404);
    const inUse = await rejection(ok(e, f.discard, req({ params: { set_id: P1(f).id }, headers: IFM })));
    expect(isLimsError(inUse, 'catalog.version_in_use')).toBe(true); expect(inUse.statusCode).toBe(409);
  });
});

describe.each(FAMILIES)('$name permission matrix (S-4, AB-8, AB-21, AC-05.9, AC-06.4)', (f) => {
  const publishCall = (e: Env8, grants: readonly string[], aal: 1 | 2) => call(e, f.publish, req({ params: { set_id: D2(f).id }, headers: { ...IFM, ...IDEM }, body: pBody() }), grants, aal);
  const retireCall = (e: Env8, grants: readonly string[], aal: 1 | 2) => call(e, f.retire, req({ params: { set_id: P1(f).id }, headers: { ...IFM, ...IDEM }, body: rBody() }), grants, aal);
  const untouched = (e: Env8) => expect(e.db.t6Stmts()).toHaveLength(0);

  it.each([['publish', publishCall], ['retire', retireCall]] as const)('%s: AB-8 a user with catalog.test.manage + catalog.test.read but NOT catalog.reference_range.publish -> 403 auth.forbidden, zero data access', { timeout: T }, async (_n, make) => {
    const e = world(f); const before = e.db.t6Stmts().length;
    const { identity, done } = make(e, [MANAGE, READ], 2);
    const x = await rejection(done);
    expect(isLimsError(x, 'auth.forbidden')).toBe(true); expect(x.statusCode).toBe(403);
    expect(identity.calls.map((c) => c.permission)).toContain(PUBLISH);
    expect(e.db.t6Stmts()).toHaveLength(before);
    expect(e.db.row(f.setTable, D2(f).id)).toMatchObject({ status: 'draft' }); expect(e.db.row(f.setTable, P1(f).id)).toMatchObject({ status: 'published' });
  });

  it.each([['publish', publishCall], ['retire', retireCall]] as const)('%s: AC-05.9 a lab_manager holding the permission at aal1 -> 403 auth.mfa_required (privileged), zero data access, no event', { timeout: T }, async (_n, make) => {
    const e = world(f);
    const x = await rejection(make(e, [MANAGE, PUBLISH, READ], 1).done);
    expect(isLimsError(x, 'auth.mfa_required')).toBe(true); expect(x.statusCode).toBe(403);
    untouched(e); expect(e.db.events).toHaveLength(0);
  });

  it.each([['publish', publishCall], ['retire', retireCall]] as const)('%s: no permissions at all -> 403 auth.forbidden', { timeout: T }, async (_n, make) => {
    const e = world(f);
    const x = await rejection(make(e, [], 2).done);
    expect(isLimsError(x, 'auth.forbidden')).toBe(true); untouched(e);
  });

  it('publish: the privileged permission alone (aal2) is sufficient — #41 requires catalog.reference_range.publish, not also catalog.test.manage', { timeout: T }, async () => {
    const e = world(f);
    const r = await publishCall(e, [PUBLISH], 2).done;
    expect(r.status).toBe(200); expect(r.body.status).toBe('published');
  });

  it('retire: the privileged permission alone (aal2) is sufficient', { timeout: T }, async () => {
    const r = await retireCall(world(f), [PUBLISH], 2).done;
    expect(r.status).toBe(200); expect(r.body.status).toBe('retired');
  });

  it.each([['publish', f.publish, 'D2'], ['retire', f.retire, 'P1']] as const)('%s fails closed without an IdentityPort in the context (auth.unauthenticated), zero data access', { timeout: T }, async (_n, id, which) => {
    const e = world(f);
    const x = await rejection(e.db.run((ctx) => H[id]!(req({ params: { set_id: which === 'D2' ? D2(f).id : P1(f).id }, headers: { ...IFM, ...IDEM }, body: id === f.publish ? pBody() : rBody() }), ctx)));
    expect(isLimsError(x, 'auth.unauthenticated')).toBe(true); untouched(e);
  });

  it('the permission assertion happens BEFORE body parsing: a forbidden user with a garbage body still gets 403, not 400', { timeout: T }, async () => {
    const e = world(f);
    const x = await rejection(call(e, f.publish, req({ params: { set_id: 'not-a-uuid' }, headers: { ...IFM, ...IDEM }, body: { status: 'x' } }), [MANAGE], 2).done);
    expect(isLimsError(x, 'auth.forbidden')).toBe(true);
  });

  it.each([['create', () => req({ params: { analyte_id: HB.id }, headers: IDEM })], ['replace', () => req({ params: { set_id: D2(f).id }, headers: IFM, body: { bands: [clean(f.band())] } })],
    ['discard', () => req({ params: { set_id: D2(f).id }, headers: IFM })]] as const)('%s needs only the non-privileged catalog.test.manage floor: works at aal1 without catalog.reference_range.publish', { timeout: T }, async (op, mk) => {
    const e = world(f);
    if (op === 'create') await e.db.run((ctx) => e.svc[f.discard]!(ctx, { id: D2(f).id, expectedVersion: 1 }));        // free the single draft slot first
    const { identity, done } = call(e, f[op], mk(), [MANAGE], 1);
    const r = await done;
    expect([200, 201]).toContain(r.status);
    expect(identity.calls.map((c) => c.permission)).not.toContain(PUBLISH);
  });

  it('list / get need only catalog.test.read', { timeout: T }, async () => {
    const e = world(f);
    expect((await call(e, f.list, req({ params: { analyte_id: HB.id } }), [READ], 1).done).status).toBe(200);
    expect((await call(e, f.get, req({ params: { set_id: P1(f).id } }), [READ], 1).done).status).toBe(200);
  });

  it('a context without tenantId / actor / tx / events fails closed with auth.unauthenticated (all seven handlers)', { timeout: T }, async () => {
    for (const o of OPS) {
      const x = await rejection(H[f[o]]!(req({ params: { analyte_id: HB.id, set_id: P1(f).id }, headers: { ...IFM, ...IDEM }, body: {} }), { ports: { IdentityPort: makeIdentity([MANAGE, PUBLISH, READ]) } }));
      expect(isLimsError(x, 'auth.unauthenticated'), `${f[o]}: ${x?.code}`).toBe(true);
    }
  });
});
