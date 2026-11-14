// T-27 (C3) — HTTP contract, permission matrix + probes for #92–#95 (instrument code maps).
// Spec: 06-PLAN T-27 (privileged permission, aal2 — 08 A13 D-18; tests: integration, probes, contract), 02-TRD §5 rows 92–95 + §6.2/§5.2 conventions, PRD AC-18.5 (a lab_manager at aal1
//       gets 403 auth.mfa_required; bulk <= 200 rows), 07-SECURITY S-4 (privilege escalation matrix), S-5 (mass assignment), S-16 (idempotency), AB-23, A4 via E5,
//       contracts/permissions.yaml (catalog.instrument_code_map.manage privileged: true), CR-C3-008 (implemented stubs leave probes/pending.json).
// Core pipeline (schema validation, auth, the x-permission FLOOR, Idempotency-Key replay) is not re-tested: handlers are driven with a request-shaped object and the same HandlerContext
// subset the service gets (same conventions as ranges.handlers.test.ts); responses are validated against the OpenAPI schemas.
//   Handler (req: {params, query, headers, body}, ctx) => {status, body}; path param of #94 is `map_id`; If-Match arrives as the raw header '"<n>"'.
// All four operations assert catalog.instrument_code_map.manage through ctx.ports.IdentityPort.assertRole BEFORE any parsing or data access (the permission is privileged, so even the
// read-only list needs aal2); a context without the port fails closed (auth.unauthenticated). Where the handlers live (file) is the writer's choice: they are found through handlers/index.ts.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec, operationIds } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { makeIdentity } from '../helpers/identity.js';
import { rejection } from '../helpers/t6.js';
import { CBC, HB, ID, INST, RBC, T, TENANT_A, TENANT_B, hgbBody, icm, mapStmts, mapsOf, row, setup27, type Env27 } from '../helpers/t27.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validatorFor = (name: string) => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return (x: unknown) => { const ok = v(x); return ok ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
};
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const MANAGE = 'catalog.instrument_code_map.manage';
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const IDEM = { 'idempotency-key': 'k-1' };
const IFM = { 'if-match': '"1"' };
const MAP1 = ID(0xb001);

const OPS = { list: 'listInstrumentCodeMaps', create: 'createInstrumentCodeMap', update: 'updateInstrumentCodeMap', bulk: 'upsertInstrumentCodeMaps' } as const;
const ALL_IDS = Object.values(OPS);

/** A world with one map (MAP1: both, HGB -> HB, g/L -> g_dl x 0.1) of tenant A on INST. */
const world = () => setup27({ maps: [icm(1, TENANT_A, INST, { direction: 'both', instrument_code: 'HGB', analyte_id: HB.id, test_id: CBC.test.id, unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1' })] });
const requests = {
  list: () => req({ query: { instrument_id: INST } }),
  create: () => req({ headers: IDEM, body: hgbBody({ instrument_code: 'NEW1', analyte_id: RBC.id, direction: 'inbound' }) }),
  update: () => req({ params: { map_id: MAP1 }, headers: IFM, body: { unit_factor: '0.2' } }),
  bulk: () => req({ headers: IDEM, body: { instrument_id: INST, maps: [row({ instrument_code: 'B1', analyte_id: RBC.id })] } }),
} as const;

/** Runs a handler in one tx with a fake IdentityPort holding `grants` at `aal` (default: the map permission at aal2). */
const call = (e: Env27, id: string, r: ReturnType<typeof req>, grants: readonly string[] = [MANAGE], aal: 1 | 2 = 2) => {
  const identity = makeIdentity(grants, aal);
  return { identity, done: e.db.run((ctx) => H[id]!(r, { ...ctx, ports: { IdentityPort: identity } })) };
};
const ok = (e: Env27, id: string, r: ReturnType<typeof req>) => call(e, id, r).done;
const untouched = (e: Env27) => { expect(e.db.t6Stmts()).toHaveLength(0); expect(e.db.events).toHaveLength(0); };

describe('contract: the four operations exist with the TRD permission / idempotency / If-Match (S-4, S-16)', () => {
  it('operationIds are in catalog.yaml and in the manifest handlers (same function as handlers/index.ts)', () => {
    const ids = operationIds(spec);
    for (const id of ALL_IDS) { expect(ids).toContain(id); expect(typeof (manifest.handlers as any)[id]).toBe('function'); expect((manifest.handlers as any)[id]).toBe(H[id]); }
  });

  it('x-permission of all four is the privileged catalog.instrument_code_map.manage (listing included)', () => {
    for (const id of ALL_IDS) expect(opOf(id)['x-permission'], id).toBe(MANAGE);
  });

  it('idempotency: create (#93) and bulk-upsert (#95) require a key; list / update take none', () => {
    expect(opOf(OPS.create)['x-idempotency']).toBe('required');
    expect(opOf(OPS.bulk)['x-idempotency']).toBe('required');
    expect(opOf(OPS.list)['x-idempotency']).toBe('none');
    expect(opOf(OPS.update)['x-idempotency']).toBe('none');
  });

  it('update needs If-Match; list requires instrument_id', () => {
    expect(JSON.stringify(opOf(OPS.update).parameters)).toContain('IfMatch');
    const inst = opOf(OPS.list).parameters.find((p: any) => p.name === 'instrument_id');
    expect(inst?.required).toBe(true);
  });

  it('request schemas are strict and carry no server-owned fields (REQ-SEC-080, S-5); the update schema cannot change the identity of a map; bulk is 1..200 rows', () => {
    const SERVER = ['id', 'tenant_id', 'version', 'created_by', 'updated_by', 'created_at', 'updated_at'];
    for (const n of ['InstrumentCodeMapCreate', 'InstrumentCodeMapUpdate', 'InstrumentCodeMapRow', 'InstrumentCodeMapsUpsert']) {
      const s = spec.components.schemas[n];
      expect(s.additionalProperties, n).toBe(false);
      for (const k of SERVER) expect(Object.keys(s.properties), `${n}.${k}`).not.toContain(k);
    }
    for (const k of ['instrument_id', 'instrument_code', 'analyte_id', 'test_id', 'direction']) expect(Object.keys(spec.components.schemas['InstrumentCodeMapUpdate'].properties), k).not.toContain(k);
    expect(Object.keys(spec.components.schemas['InstrumentCodeMapCreate'].properties)).not.toContain('is_active');
    const maps = spec.components.schemas['InstrumentCodeMapsUpsert'].properties.maps;
    expect([maps.minItems, maps.maxItems]).toEqual([1, 200]);
  });
});

describe('probes (CR-C3-008): the four stubs are gone', () => {
  const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
  it('none of the four operationIds is listed in probes/pending.json any more', () => {
    for (const id of ALL_IDS) expect(pending, id).not.toContain(id);
  });
  it.each(ALL_IDS)('%s does not answer 503 common.service_unavailable / not_implemented', { timeout: T }, async (id) => {
    const x = await call(setup27(), id, req({ params: { map_id: MAP1 }, query: { instrument_id: INST }, headers: { ...IFM, ...IDEM }, body: {} })).done.then(() => undefined, (r) => r);
    expect(x?.code).not.toBe('common.service_unavailable');
    expect(x?.detail).not.toBe('not_implemented');
  });
});

describe('handlers over the service, validated against the OpenAPI schemas', () => {
  it('list (#92) -> 200 exactly InstrumentCodeMapPage; query instrument_id / direction / analyte_id / is_active reach the service', { timeout: T }, async () => {
    const e = world();
    const r = await ok(e, OPS.list, req({ query: { instrument_id: INST } }));
    expect(r.status).toBe(200);
    expect(validatorFor('InstrumentCodeMapPage')(r.body)).toEqual([]);
    expect(r.body.data.map((m: any) => m.id)).toEqual([MAP1]);
    expect((await ok(e, OPS.list, req({ query: { instrument_id: INST, direction: 'inbound' } }))).body.data).toEqual([]);
    expect((await ok(e, OPS.list, req({ query: { instrument_id: INST, is_active: 'false' } }))).body.data).toEqual([]);
    const bad = await rejection(ok(e, OPS.list, req({ query: {} })));
    expect(isLimsError(bad), `${bad?.code}`).toBe(true);
    expect(bad.statusCode).toBe(400);
  });

  it('create (#93) -> 201 exactly InstrumentCodeMap (Idempotency-Key accepted; AC-18.1 body)', { timeout: T }, async () => {
    const e = setup27();
    const r = await ok(e, OPS.create, req({ headers: IDEM, body: hgbBody() }));
    expect(r.status).toBe(201);
    expect(validatorFor('InstrumentCodeMap')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ instrument_id: INST, direction: 'both', instrument_code: 'HGB', analyte_id: HB.id, test_id: CBC.test.id, unit_from_raw: 'g/L', unit_to_code: 'g_dl', unit_factor: '0.1', is_active: true, version: 1 });
    expect(mapsOf(e.db)).toHaveLength(1);
  });

  it('create: a duplicate active inbound code -> 409 catalog.code_duplicate; an analyte of another test -> 400 common.validation_failed (statuses pass through)', { timeout: T }, async () => {
    const e = world();
    const dup = await rejection(ok(e, OPS.create, req({ headers: IDEM, body: hgbBody({ direction: 'inbound', analyte_id: RBC.id }) })));
    expect(isLimsError(dup, 'catalog.code_duplicate')).toBe(true); expect(dup.statusCode).toBe(409);
    const mism = await rejection(ok(e, OPS.create, req({ headers: IDEM, body: hgbBody({ instrument_code: 'Q', analyte_id: RBC.id, test_id: ID(0x1002) }) })));
    expect(isLimsError(mism), `${mism?.code}`).toBe(true);
    expect([400, 404]).toContain(mism.statusCode);
  });

  it('update (#94) with If-Match "1" -> 200 exactly InstrumentCodeMap, version 2 (path param map_id; body = the PATCH)', { timeout: T }, async () => {
    const e = world();
    const r = await ok(e, OPS.update, req({ params: { map_id: MAP1 }, headers: IFM, body: { unit_factor: '0.2', unset: ['flag_map'] } }));
    expect(r.status).toBe(200);
    expect(validatorFor('InstrumentCodeMap')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: MAP1, unit_factor: '0.2', version: 2 });
  });

  it('update: a missing If-Match -> 428 common.precondition_required (the handler does not default it); a stale one -> 409 common.version_conflict; unknown map -> 404', { timeout: T }, async () => {
    const e = world();
    const none = await rejection(ok(e, OPS.update, req({ params: { map_id: MAP1 }, body: { is_active: false } })));
    expect(isLimsError(none, 'common.precondition_required')).toBe(true); expect(none.statusCode).toBe(428);
    const stale = await rejection(ok(e, OPS.update, req({ params: { map_id: MAP1 }, headers: { 'if-match': '"7"' }, body: { is_active: false } })));
    expect(isLimsError(stale, 'common.version_conflict')).toBe(true); expect(stale.statusCode).toBe(409);
    const nf = await rejection(ok(e, OPS.update, req({ params: { map_id: ID(0xdead) }, headers: IFM, body: { is_active: false } })));
    expect(isLimsError(nf, 'common.not_found')).toBe(true); expect(nf.statusCode).toBe(404);
  });

  it('bulk upsert (#95) -> 200 exactly InstrumentCodeMapResults (per-row outcome, error rows keep the 200)', { timeout: T }, async () => {
    const e = world();
    const r = await ok(e, OPS.bulk, req({ headers: IDEM, body: { instrument_id: INST, maps: [row({ instrument_code: 'B1', analyte_id: RBC.id }), row({ instrument_code: 'BAD', test_id: ID(0x1002) })] } }));
    expect(r.status).toBe(200);
    expect(validatorFor('InstrumentCodeMapResults')(r.body)).toEqual([]);
    expect(r.body.results.map((x: any) => x.outcome)).toEqual(['created', 'error']);
    expect(typeof r.body.results[1].error_code).toBe('string');
  });
});

describe('permission matrix (S-4, AB-23, AC-18.5, 08 A13 D-18)', () => {
  const OTHERS = ['catalog.test.read', 'catalog.test.manage', 'catalog.price_list.manage', 'catalog.price_list.read', 'catalog.reference_range.publish', 'catalog.referrer.manage'];

  it.each(Object.entries(OPS))('%s (%s): holding every OTHER catalog permission but NOT catalog.instrument_code_map.manage -> 403 auth.forbidden, zero data access', { timeout: T }, async (k, id) => {
    const e = world();
    const { identity, done } = call(e, id, requests[k as keyof typeof requests](), OTHERS, 2);
    const x = await rejection(done);
    expect(isLimsError(x, 'auth.forbidden'), `${id}: ${x?.code}`).toBe(true); expect(x.statusCode).toBe(403);
    expect(identity.calls.map((c) => c.permission)).toContain(MANAGE);
    untouched(e);
    expect(mapsOf(e.db)[0]).toMatchObject({ version: 1, unit_factor: '0.1' });
  });

  it.each(Object.entries(OPS))('%s (%s): AB-23 a lab_manager holding the permission at aal1 -> 403 auth.mfa_required (privileged), zero data access, no event', { timeout: T }, async (k, id) => {
    const e = world();
    const x = await rejection(call(e, id, requests[k as keyof typeof requests](), [MANAGE], 1).done);
    expect(isLimsError(x, 'auth.mfa_required'), `${id}: ${x?.code}`).toBe(true); expect(x.statusCode).toBe(403);
    untouched(e);
  });

  it.each(Object.entries(OPS))('%s (%s): no permissions at all -> 403 auth.forbidden', { timeout: T }, async (k, id) => {
    const e = world();
    const x = await rejection(call(e, id, requests[k as keyof typeof requests](), [], 2).done);
    expect(isLimsError(x, 'auth.forbidden')).toBe(true); untouched(e);
  });

  it.each(Object.entries(OPS))('%s (%s): the permission at aal2 is sufficient; exactly catalog.instrument_code_map.manage was asserted through IdentityPort.assertRole', { timeout: T }, async (k, id) => {
    const e = world();
    const { identity, done } = call(e, id, requests[k as keyof typeof requests](), [MANAGE], 2);
    const r = await done;
    expect([200, 201]).toContain(r.status);
    expect(identity.calls.map((c) => c.permission)).toEqual([MANAGE]);
  });

  it.each(Object.entries(OPS))('%s (%s) fails closed without an IdentityPort in the context (auth.unauthenticated), zero data access', { timeout: T }, async (k, id) => {
    const e = world();
    const x = await rejection(e.db.run((ctx) => H[id]!(requests[k as keyof typeof requests](), ctx)));
    expect(isLimsError(x, 'auth.unauthenticated'), `${id}: ${x?.code}`).toBe(true); untouched(e);
  });

  it('the permission assertion happens BEFORE parsing: a forbidden user with garbage input still gets 403, not 400 / 428 / 404 (no existence oracle)', { timeout: T }, async () => {
    for (const [id, r] of [
      [OPS.list, req({ query: { instrument_id: 'x' } })], [OPS.create, req({ headers: IDEM, body: { tenant_id: 'x' } })],
      [OPS.update, req({ params: { map_id: 'not-a-uuid' }, body: { instrument_code: 'x' } })], [OPS.bulk, req({ headers: IDEM, body: { maps: [] } })],
    ] as const) {
      const e = world();
      const x = await rejection(call(e, id, r, ['catalog.test.manage'], 2).done);
      expect(isLimsError(x, 'auth.forbidden'), `${id}: ${x?.code}`).toBe(true); untouched(e);
    }
  });

  it('a context without tenantId / actor / tx / events fails closed with auth.unauthenticated (all four handlers)', { timeout: T }, async () => {
    for (const id of ALL_IDS) {
      const x = await rejection(H[id]!(req({ params: { map_id: MAP1 }, query: { instrument_id: INST }, headers: { ...IFM, ...IDEM }, body: {} }), { ports: { IdentityPort: makeIdentity([MANAGE]) } }));
      expect(isLimsError(x, 'auth.unauthenticated'), `${id}: ${x?.code}`).toBe(true);
    }
  });

  it('S-1 through the handlers: tenant A\'s map id from tenant B\'s session -> 404 on update; B\'s list of the same instrument never shows A\'s map', { timeout: T }, async () => {
    const e = world();
    const identity = makeIdentity([MANAGE], 2);
    const x = await rejection(e.db.run((ctx) => H[OPS.update]!(requests.update(), { ...ctx, ports: { IdentityPort: identity } }), { tenantId: TENANT_B }));
    expect(isLimsError(x, 'common.not_found')).toBe(true);
    const l = await e.db.run((ctx) => H[OPS.list]!(requests.list(), { ...ctx, ports: { IdentityPort: identity } }), { tenantId: TENANT_B });
    expect(l.body.data).toEqual([]);
    expect(mapsOf(e.db)[0]).toMatchObject({ version: 1 });
    for (const s of mapStmts(e.db)) expect(s.text, s.text).toMatch(/tenant_id/i);
  });
});
