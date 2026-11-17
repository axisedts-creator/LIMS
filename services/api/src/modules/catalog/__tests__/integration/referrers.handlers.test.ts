// T-15 (C3) — doctors HTTP contract + probes: the seven handlers #60–#66 are real (no longer CR-C3-008 stubs) and honour catalog.yaml.
// Spec: 06-PLAN T-15; 02-TRD §5 rows 60–66, §5.0 (If-Match on PATCH and on state actions: 428 missing / 409 stale; Idempotency-Key on creates and merge), §6.2 (the handler
//       gets IdentityPort from ctx.ports.IdentityPort — same convention as imports.handlers.ts); 07-SECURITY S-1, S-4, S-5, S-11, S-16, AB-15, AB-20.
// Same harness conventions as comments.handlers.test.ts (T-13): handlers driven with a request-shaped object + the HandlerContext subset;
// responses validated against the OpenAPI schemas. Path param is `doctor_id`. If-Match is the raw header `"<n>"`.
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
import { MANAGE, READ, actorIdentity, doc, makeDoctorsDb } from '../helpers/doctorsDb.js';
import { ID, type Row } from '../helpers/mastersDb.js';

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

const IDS = ['searchDoctors', 'listDoctors', 'createDoctor', 'getDoctor', 'updateDoctor', 'verifyDoctor', 'mergeDoctor'] as const;
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const bare = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } });
const KEY = { 'idempotency-key': 'k-1' };
const A = TENANT_A;
const P1 = '+9779800000001';
const X = doc(1, A, { doctor_code: 'DX1', display_name: 'Dr Test Referrer 0007', phone_e164: P1, email: 'x@example.test', qualification: 'MD' });
const Y = doc(2, A, { doctor_code: 'DY1', display_name: 'Dr Other' });
const THEIRS = doc(91, TENANT_B, { doctor_code: 'THEIRS1', display_name: 'B Secret Doctor', phone_e164: '+9779800000099' });
const mk = (rows: Row[] = []) => makeDoctorsDb({ rows: { doctors: rows }, catalog: { state: { [A]: { rootId: ROOT_A, revision: 417 } } } });
type Db = ReturnType<typeof mk>;
/** Runs one handler in one transaction with the given permission set behind ctx.ports.IdentityPort. */
const call = (db: Db, id: string, r: ReturnType<typeof req>, perms: readonly string[] = [READ, MANAGE]) =>
  db.run((ctx) => H[id]!(r, ctx), { ctx: { ports: { IdentityPort: actorIdentity(perms) } } });
const IM1 = { 'if-match': '"1"' };

describe('the 7 operations exist in the contract with the TRD permissions/idempotency (S-4, S-16)', () => {
  it('operationIds are in catalog.yaml and in the manifest handlers', () => {
    const ids = operationIds(spec);
    for (const id of IDS) { expect(ids).toContain(id); expect(typeof (manifest.handlers as any)[id]).toBe('function'); expect((manifest.handlers as any)[id]).toBe(H[id]); }
  });
  it('search/list/get = catalog.referrer.read; create/update/verify/merge = catalog.referrer.manage', () => {
    for (const id of ['searchDoctors', 'listDoctors', 'getDoctor']) expect(opOf(id)['x-permission'], id).toBe('catalog.referrer.read');
    for (const id of ['createDoctor', 'updateDoctor', 'verifyDoctor', 'mergeDoctor']) expect(opOf(id)['x-permission'], id).toBe('catalog.referrer.manage');
  });
  it('idempotency: create and merge need Idempotency-Key, search/list/get/update none, verify optional; update/verify/merge need If-Match; doctor_id is the path param', () => {
    expect([opOf('createDoctor')['x-idempotency'], opOf('mergeDoctor')['x-idempotency']]).toEqual(['required', 'required']);
    expect([opOf('searchDoctors')['x-idempotency'], opOf('listDoctors')['x-idempotency'], opOf('getDoctor')['x-idempotency'], opOf('updateDoctor')['x-idempotency']]).toEqual(['none', 'none', 'none', 'none']);
    expect(opOf('verifyDoctor')['x-idempotency']).toBe('optional');
    for (const id of ['updateDoctor', 'verifyDoctor', 'mergeDoctor']) expect(JSON.stringify(opOf(id).parameters), id).toContain('IfMatch');
    for (const id of ['getDoctor', 'updateDoctor', 'verifyDoctor', 'mergeDoctor']) expect(opOf(id).parameters.some((p: any) => p.name === 'doctor_id' && p.in === 'path'), id).toBe(true);
  });
  it('contract facts the service relies on: DoctorCreate/DoctorUpdate/DoctorMerge/DoctorSearchRequest are additionalProperties:false and carry no server-owned field; DoctorCreated requires possible_duplicate_of (maxItems 10)', () => {
    const s = spec.components.schemas;
    for (const n of ['DoctorCreate', 'DoctorUpdate', 'DoctorMerge', 'DoctorSearchRequest']) expect(s[n].additionalProperties, n).toBe(false);
    for (const n of ['DoctorCreate', 'DoctorUpdate']) for (const k of ['id', 'tenant_id', 'is_verified', 'source', 'merged_into_id', 'version', 'price_list_id', 'name_normalised']) expect(Object.keys(s[n].properties), `${n}.${k}`).not.toContain(k);
    expect(Object.keys(s['DoctorUpdate'].properties)).not.toContain('doctor_code');
    expect(Object.keys(s['DoctorMerge'].properties)).toEqual(['into_doctor_id']);
    expect(s['DoctorCreated'].required).toContain('possible_duplicate_of');
    expect(s['DoctorCreated'].properties.possible_duplicate_of.maxItems).toBe(10);
    expect(s['DoctorSummary'].additionalProperties).toBe(false);
    for (const c of ['phone_e164', 'email']) expect(Object.keys(s['DoctorSummary'].properties)).not.toContain(c);
    expect(s['Doctor'].required).not.toContain('phone_e164');                      // contacts are optional in the DTO: absence is a valid answer
    expect(s['Doctor'].required).not.toContain('email');
  });
});

describe('probes (CR-C3-008): the doctor stubs are gone', () => {
  const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
  it('none of the seven operationIds is listed in probes/pending.json any more', () => {
    for (const id of IDS) expect(pending, id).not.toContain(id);
  });
  it.each(IDS)('%s does not answer 503 common.service_unavailable / not_implemented', { timeout: T }, async (id) => {
    const e = await call(mk(), id, req({ params: { doctor_id: ID(0x1) }, headers: { ...IM1, ...KEY }, body: {} })).then(() => undefined, (x) => x);
    expect(e?.code).not.toBe('common.service_unavailable');
    expect(e?.detail).not.toBe('not_implemented');
  });
});

describe('doctors — handlers over the service, validated against the OpenAPI schemas', () => {
  const itemOk = validatorFor('Doctor'); const createdOk = validatorFor('DoctorCreated'); const listOk = validatorFor('DoctorSummaryList'); const pageOk = validatorFor('DoctorSummaryPage');
  const seeded = () => mk([X, Y, doc(3, A, { doctor_code: 'DZ1', is_active: false, display_name: 'Dr Gone' }), THEIRS]);

  it('POST search -> 200 whose body is exactly DoctorSummaryList (no contacts, own tenant only)', { timeout: T }, async () => {
    const r = await call(seeded(), 'searchDoctors', req({ body: { q: 'dr' } }));
    expect(r.status).toBe(200);
    expect(listOk(r.body)).toEqual([]);
    expect(r.body.data.map((d: Row) => d.doctor_code)).toEqual(['DX1', 'DY1']);                  // name prefix both -> by code; inactive hidden
    expect(JSON.stringify(r.body)).not.toMatch(/phone|email|9779800000001|THEIRS1|B Secret/);
    const wide = await call(seeded(), 'searchDoctors', req({ body: { q: 'dr', include_inactive: true, include_unverified: false, limit: 1 } }));
    expect(listOk(wide.body)).toEqual([]);
    expect(wide.body.data).toHaveLength(0);                                                      // every seeded doctor is unverified
  });

  it('GET list -> 200 whose body is exactly DoctorSummaryPage; query is passed through (is_active, is_verified, source, sort, limit + cursor); bad values -> 400', { timeout: T }, async () => {
    const db = seeded();
    const l = await call(db, 'listDoctors', req());
    expect(l.status).toBe(200);
    expect(pageOk(l.body)).toEqual([]);
    expect(l.body.data.map((d: Row) => d.doctor_code).sort()).toEqual(['DX1', 'DY1']);
    const all = await call(db, 'listDoctors', req({ query: { is_active: 'all', sort: '-doctor_code', limit: 1 } }));
    expect(all.body.data.map((d: Row) => d.doctor_code)).toEqual(['DZ1']);
    expect(pageOk(all.body)).toEqual([]);
    const next = await call(db, 'listDoctors', req({ query: { is_active: 'all', sort: '-doctor_code', limit: 1, cursor: all.body.page.next_cursor } }));
    expect(next.body.data.map((d: Row) => d.doctor_code)).toEqual(['DY1']);
    expect((await call(db, 'listDoctors', req({ query: { source: 'quick_add' } }))).body.data).toEqual([]);
    for (const query of [{ is_active: 'maybe' }, { sort: 'display_name' }, { limit: 0 }, { limit: 201 }, { cursor: '!!!' }, { source: 'web' }]) {
      expect((await rejection(call(db, 'listDoctors', req({ query })))).statusCode).toBe(400);
    }
  });

  it('POST create (quick-add) -> 201 with exactly the DoctorCreated schema; duplicate hint present; code auto-assigned', { timeout: T }, async () => {
    const db = seeded();
    const r = await call(db, 'createDoctor', req({ headers: KEY, body: { display_name: ' dr  test referrer 0007 ', phone_e164: P1, quick_add: true } }));
    expect(r.status).toBe(201);
    expect(createdOk(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ doctor_code: 'DR00001', is_verified: false, source: 'quick_add', is_active: true, version: 1 });
    expect(r.body.possible_duplicate_of.map((d: Row) => d.id)).toEqual([X.id]);
    const b = await call(db, 'createDoctor', req({ headers: { 'idempotency-key': 'k-2' }, body: { display_name: 'Dr Back Office', doctor_code: 'bo-1' } }));
    expect(b.status).toBe(201);
    expect(createdOk(b.body)).toEqual([]);
    expect(b.body).toMatchObject({ doctor_code: 'BO-1', source: 'back_office', possible_duplicate_of: [] });
  });

  it('POST create duplicates -> 409 catalog.code_duplicate', { timeout: T }, async () => {
    const e = await rejection(call(seeded(), 'createDoctor', req({ headers: KEY, body: { display_name: 'Dr Clash', doctor_code: 'dx1' } })));
    expect(isLimsError(e, 'catalog.code_duplicate')).toBe(true); expect(e.statusCode).toBe(409);
  });

  it('GET one -> 200 Doctor schema; manage holder sees contacts', { timeout: T }, async () => {
    const r = await call(seeded(), 'getDoctor', req({ params: { doctor_id: X.id } }));
    expect(r.status).toBe(200);
    expect(itemOk(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: X.id, doctor_code: 'DX1', phone_e164: P1, email: 'x@example.test' });
  });

  it('AB-15 / S-11: GET one with catalog.referrer.read only -> still a valid Doctor, but phone_e164 and email are ABSENT', { timeout: T }, async () => {
    const r = await call(seeded(), 'getDoctor', req({ params: { doctor_id: X.id } }), [READ]);
    expect(r.status).toBe(200);
    expect(itemOk(r.body)).toEqual([]);
    for (const k of ['phone_e164', 'email']) expect(r.body).not.toHaveProperty(k);
    expect(JSON.stringify(r.body)).not.toMatch(/9779800000001|x@example\.test/);
    expect(r.body).toMatchObject({ id: X.id, display_name: 'Dr Test Referrer 0007', qualification: 'MD' });
  });

  it('fail closed: getDoctor never returns contacts when the identity port is missing or its getActor fails', { timeout: T }, async () => {
    const noPort = await mk([X]).run((ctx) => H['getDoctor']!(req({ params: { doctor_id: X.id } }), { ...ctx, ports: {} })).then((r) => JSON.stringify(r), (e) => `rejected ${e?.code ?? ''}`);
    expect(noPort).not.toMatch(/9779800000001|x@example\.test/);
    const broken = { ...actorIdentity([READ, MANAGE]), getActor: async () => { throw Object.assign(new Error('down'), { code: 'auth.unauthenticated' }); } };
    const failing = await mk([X]).run((ctx) => H['getDoctor']!(req({ params: { doctor_id: X.id } }), { ...ctx, ports: { IdentityPort: broken } })).then((r) => JSON.stringify(r), (e) => `rejected ${e?.code ?? ''}`);
    expect(failing).not.toMatch(/9779800000001|x@example\.test/);
  });

  it('PATCH with If-Match "1" -> 200 Doctor, version 2 (the unset list clears a field)', { timeout: T }, async () => {
    const db = seeded();
    const r = await call(db, 'updateDoctor', req({ params: { doctor_id: X.id }, headers: IM1, body: { notes: 'Synthetic note.', unset: ['email'] } }));
    expect(r.status).toBe(200);
    expect(itemOk(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: X.id, notes: 'Synthetic note.', version: 2 });
    expect(r.body).not.toHaveProperty('email');
  });

  it('POST verify with If-Match -> 200 Doctor with is_verified true', { timeout: T }, async () => {
    const r = await call(seeded(), 'verifyDoctor', req({ params: { doctor_id: X.id }, headers: IM1 }));
    expect(r.status).toBe(200);
    expect(itemOk(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: X.id, is_verified: true, version: 2 });
  });

  it('POST merge with If-Match + Idempotency-Key -> 200 Doctor (the merged one): inactive, merged_into_id = target; target in another tenant -> not merged', { timeout: T }, async () => {
    const db = seeded();
    const r = await call(db, 'mergeDoctor', req({ params: { doctor_id: X.id }, headers: { ...IM1, ...KEY }, body: { into_doctor_id: Y.id } }));
    expect(r.status).toBe(200);
    expect(itemOk(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: X.id, is_active: false, merged_into_id: Y.id, version: 2 });
    const e = await rejection(call(seeded(), 'mergeDoctor', req({ params: { doctor_id: X.id }, headers: { ...IM1, ...KEY }, body: { into_doctor_id: THEIRS.id } })));
    expect([400, 404]).toContain(e.statusCode);
    const self = await rejection(call(seeded(), 'mergeDoctor', req({ params: { doctor_id: X.id }, headers: { ...IM1, ...KEY }, body: { into_doctor_id: X.id } })));
    expect(isLimsError(self, 'common.validation_failed')).toBe(true); expect(self.statusCode).toBe(400);
  });

  it('verify on a merged doctor -> 409 catalog.version_in_use', { timeout: T }, async () => {
    const db = mk([doc(1, A, { is_active: false, merged_into_id: Y.id }), Y]);
    const e = await rejection(call(db, 'verifyDoctor', req({ params: { doctor_id: doc(1, A).id }, headers: IM1 })));
    expect(isLimsError(e, 'catalog.version_in_use')).toBe(true); expect(e.statusCode).toBe(409);
  });

  it.each([
    ['updateDoctor', { notes: 'x' }], ['verifyDoctor', undefined], ['mergeDoctor', { into_doctor_id: Y.id }],
  ])('AC-01.6 pattern on %s: no If-Match -> 428; stale -> 409 version_conflict', { timeout: T }, async (id, body) => {
    const db = mk([{ ...X, version: 3 }, Y]);
    const a = await rejection(call(db, id, req({ params: { doctor_id: X.id }, headers: KEY, body })));
    expect(isLimsError(a, 'common.precondition_required')).toBe(true); expect(a.statusCode).toBe(428);
    const b = await rejection(call(db, id, req({ params: { doctor_id: X.id }, headers: { 'if-match': '"2"', ...KEY }, body })));
    expect(isLimsError(b, 'common.version_conflict')).toBe(true); expect(b.statusCode).toBe(409);
    expect(db.row(X.id)).toMatchObject({ version: 3, is_active: true, is_verified: false });
  });

  it.each([['unquoted', '1'], ['weak', 'W/"1"'], ['star', '*'], ['zero', '"0"'], ['leading zero', '"01"'], ['non numeric', '"abc"'], ['negative', '"-1"'], ['beyond int32', '"99999999999"'], ['empty', '']])
  ('malformed If-Match (%s) on PATCH, verify and merge -> 400, never 500, never a write', { timeout: T }, async (_n, h) => {
    const db = mk([X, Y]);
    for (const [id, body] of [['updateDoctor', { notes: 'x' }], ['verifyDoctor', undefined], ['mergeDoctor', { into_doctor_id: Y.id }]] as const) {
      const e = await rejection(call(db, id, req({ params: { doctor_id: X.id }, headers: { 'if-match': h, ...KEY }, body })));
      expect(isLimsError(e), id).toBe(true); expect(e.statusCode, id).toBe(400);
    }
    expect(db.row(X.id)).toMatchObject({ version: 1, is_active: true, is_verified: false, notes: null });
    expect(db.events).toHaveLength(0);
  });

  it('unknown doctor_id -> 404 on get/patch/verify/merge; S-1: tenant B\'s id -> 404 and the B row is untouched; no value of B in the error', { timeout: T }, async () => {
    const db = seeded();
    for (const id of [ID(0xdead), THEIRS.id]) {
      for (const [op, extra] of [['getDoctor', {}], ['updateDoctor', { headers: IM1, body: { notes: 'x' } }], ['verifyDoctor', { headers: IM1 }], ['mergeDoctor', { headers: { ...IM1, ...KEY }, body: { into_doctor_id: Y.id } }]] as const) {
        const e = await rejection(call(db, op, req({ params: { doctor_id: id }, ...extra })));
        expect(isLimsError(e, 'common.not_found'), op).toBe(true); expect(e.statusCode, op).toBe(404);
        expect(JSON.stringify([e.message, e.detail, e.errors])).not.toMatch(/THEIRS1|B Secret|9779800000099/);
      }
    }
    expect(db.row(THEIRS.id)).toMatchObject({ version: 1, is_verified: false, is_active: true, merged_into_id: null, notes: null });
    expect(db.events).toHaveLength(0);
  });

  it('S-5: mass assignment through the handlers -> 400, nothing written', { timeout: T }, async () => {
    const db = seeded();
    for (const extra of [{ tenant_id: TENANT_B }, { version: 7 }, { id: ID(0xbad) }, { is_verified: true }, { source: 'import' }, { merged_into_id: Y.id }]) {
      expect((await rejection(call(db, 'createDoctor', req({ headers: KEY, body: { display_name: 'Dr New', ...extra } })))).statusCode).toBe(400);
    }
    for (const patch of [{ doctor_code: 'RENAMED' }, { is_verified: true }, { tenant_id: TENANT_B }, { version: 9 }, { source: 'import' }, { merged_into_id: Y.id }]) {
      expect((await rejection(call(db, 'updateDoctor', req({ params: { doctor_id: X.id }, headers: IM1, body: patch })))).statusCode).toBe(400);
    }
    for (const body of [{ into_doctor_id: Y.id, is_active: false }, { into_doctor_id: Y.id, tenant_id: TENANT_B }, {}]) {
      expect((await rejection(call(db, 'mergeDoctor', req({ params: { doctor_id: X.id }, headers: { ...IM1, ...KEY }, body })))).statusCode).toBe(400);
    }
    expect((await rejection(call(db, 'searchDoctors', req({ body: { q: 'dr', tenant_id: TENANT_B } })))).statusCode).toBe(400);
    expect(db.rows('doctors', A)).toHaveLength(3);                                               // X, Y, the inactive DZ1 — no new row
    expect(db.row(X.id)).toMatchObject({ version: 1, doctor_code: 'DX1', is_verified: false, merged_into_id: null });
    expect(db.events).toHaveLength(0);
  });

  it('fails closed without an authenticated request context: auth.unauthenticated for all seven operations, nothing reflected', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    for (const id of IDS) {
      const e = await rejection(H[id]!(req({ params: { doctor_id: ID(1) }, headers: { ...IM1, ...KEY }, query: {}, body: { display_name: planted, q: planted, into_doctor_id: planted } }), bare(id)));
      expect(isLimsError(e, 'auth.unauthenticated'), id).toBe(true);
      expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain(planted);
    }
  });
});
