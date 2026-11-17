// T-16 (C3) — credit parties HTTP contract + probes: the four handlers #67–#70 are real (no longer CR-C3-008 stubs) and honour catalog.yaml.
// Spec: 06-PLAN T-16; 02-TRD §5 rows 67–70, §5.0 (If-Match on PATCH: 428 missing / 409 stale; Idempotency-Key on create), §6.2 (the handler gets IdentityPort from
//       ctx.ports.IdentityPort — same convention as referrers.handlers.ts / imports.handlers.ts); 07-SECURITY S-1, S-4, S-5, S-11, S-16, AB-22; 01-PRD AC-12.1–12.4.
// Same harness conventions as referrers.handlers.test.ts (T-15): handlers driven with a request-shaped object + the HandlerContext subset; responses validated
// against the OpenAPI schemas. Path param is `credit_party_id`. If-Match is the raw header `"<n>"`. The core pipeline (schema validation, auth, x-permission,
// Idempotency-Key replay) is not re-tested here.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec, operationIds } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { ROOT_A, TENANT_A, TENANT_B } from '../helpers/catalogDb.js';
import { MANAGE, READ, actorIdentity, cp, makeCreditPartiesDb } from '../helpers/creditPartiesDb.js';
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

const IDS = ['listCreditParties', 'createCreditParty', 'getCreditParty', 'updateCreditParty'] as const;
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const bare = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } });
const KEY = { 'idempotency-key': 'k-1' };
const A = TENANT_A;
const P1 = '+9779800000001';
const SECRETS = /123456789|9779800000001|billing@example\.test|Synthetic Street/;
const X = cp(1, A, { party_code: 'CPX1', name: 'Synthetic General Hospital', pan: '123456789', contact_phone_e164: P1, contact_email: 'billing@example.test', billing_address: 'Synthetic Street 1, Synthetic City', allows_credit: false });
const Y = cp(2, A, { party_code: 'CPY1', name: 'Synthetic Clinic', kind: 'clinic' });
const THEIRS = cp(91, TENANT_B, { party_code: 'THEIRS1', name: 'B Secret Party', contact_phone_e164: '+9779800000099', pan: 'BPAN-9' });
const mk = (rows: Row[] = []) => makeCreditPartiesDb({ rows: { credit_parties: rows }, catalog: { state: { [A]: { rootId: ROOT_A, revision: 417 } } } });
type Db = ReturnType<typeof mk>;
/** Runs one handler in one transaction with the given permission set behind ctx.ports.IdentityPort. */
const call = (db: Db, id: string, r: ReturnType<typeof req>, perms: readonly string[] = [READ, MANAGE]) =>
  db.run((ctx) => H[id]!(r, ctx), { ctx: { ports: { IdentityPort: actorIdentity(perms) } } });
const IM1 = { 'if-match': '"1"' };

describe('the 4 operations exist in the contract with the TRD permissions/idempotency (S-4, S-16)', () => {
  it('operationIds are in catalog.yaml and in the manifest handlers', () => {
    const ids = operationIds(spec);
    for (const id of IDS) { expect(ids).toContain(id); expect(typeof (manifest.handlers as any)[id]).toBe('function'); expect((manifest.handlers as any)[id]).toBe(H[id]); }
  });
  it('list/get = catalog.price_list.read; create/update = catalog.price_list.manage', () => {
    for (const id of ['listCreditParties', 'getCreditParty']) expect(opOf(id)['x-permission'], id).toBe('catalog.price_list.read');
    for (const id of ['createCreditParty', 'updateCreditParty']) expect(opOf(id)['x-permission'], id).toBe('catalog.price_list.manage');
  });
  it('idempotency: create requires Idempotency-Key, list/get/update none; update needs If-Match; credit_party_id is the path param', () => {
    expect(opOf('createCreditParty')['x-idempotency']).toBe('required');
    for (const id of ['listCreditParties', 'getCreditParty', 'updateCreditParty']) expect(opOf(id)['x-idempotency'], id).toBe('none');
    expect(JSON.stringify(opOf('updateCreditParty').parameters)).toContain('IfMatch');
    for (const id of ['getCreditParty', 'updateCreditParty']) expect(opOf(id).parameters.some((p: any) => p.name === 'credit_party_id' && p.in === 'path'), id).toBe(true);
  });
  it('contract facts the service relies on (AC-12.3, REQ-SEC-081): CreditPartyCreate/CreditPartyUpdate are additionalProperties:false and carry no server-owned field nor any credit limit / days / balance; party_code is not updatable; the four sensitive fields are optional in the DTO', () => {
    const s = spec.components.schemas;
    for (const n of ['CreditPartyCreate', 'CreditPartyUpdate']) {
      expect(s[n].additionalProperties, n).toBe(false);
      for (const k of ['id', 'tenant_id', 'version', 'price_list_id', 'credit_limit', 'credit_days', 'balance', 'created_by']) expect(Object.keys(s[n].properties), `${n}.${k}`).not.toContain(k);
    }
    expect(Object.keys(s['CreditPartyUpdate'].properties)).not.toContain('party_code');
    expect(s['CreditPartyUpdate'].properties.unset.items.enum).toEqual(['pan', 'contact_phone_e164', 'contact_email', 'billing_address']);
    expect(Object.keys(s['CreditParty'].properties)).not.toEqual(expect.arrayContaining(['credit_limit']));
    for (const k of ['pan', 'contact_phone_e164', 'contact_email', 'billing_address']) expect(s['CreditParty'].required, k).not.toContain(k);
    expect(s['CreditParty'].required).toEqual(expect.arrayContaining(['id', 'party_code', 'name', 'kind', 'allows_credit', 'is_active', 'version']));
  });
});

describe('probes (CR-C3-008): the credit-party stubs are gone', () => {
  const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
  it('none of the four operationIds is listed in probes/pending.json any more', () => {
    for (const id of IDS) expect(pending, id).not.toContain(id);
  });
  it.each(IDS)('%s does not answer 503 common.service_unavailable / not_implemented', { timeout: T }, async (id) => {
    const e = await call(mk(), id, req({ params: { credit_party_id: ID(0x1) }, headers: { ...IM1, ...KEY }, body: {} })).then(() => undefined, (x) => x);
    expect(e?.code).not.toBe('common.service_unavailable');
    expect(e?.detail).not.toBe('not_implemented');
  });
});

describe('credit parties — handlers over the service, validated against the OpenAPI schemas', () => {
  const itemOk = validatorFor('CreditParty'); const pageOk = validatorFor('CreditPartyPage');
  const seeded = () => mk([X, Y, cp(3, A, { party_code: 'CPZ1', is_active: false }), THEIRS]);

  it('AC-12.1: POST create with a blank party_code -> 201 with exactly the CreditParty schema, auto code CP00001, then GET list -> 200 CreditPartyPage containing it', { timeout: T }, async () => {
    const db = mk();
    const r = await call(db, 'createCreditParty', req({ headers: KEY, body: { name: 'Synthetic General Hospital', kind: 'hospital', allows_credit: true } }));
    expect(r.status).toBe(201);
    expect(itemOk(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ party_code: 'CP00001', name: 'Synthetic General Hospital', kind: 'hospital', allows_credit: true, is_active: true, version: 1 });
    const l = await call(db, 'listCreditParties', req());
    expect(l.status).toBe(200);
    expect(pageOk(l.body)).toEqual([]);
    expect(l.body.data.map((d: Row) => d.id)).toEqual([r.body.id]);
    const explicit = await call(db, 'createCreditParty', req({ headers: { 'idempotency-key': 'k-2' }, body: { name: 'Explicit', kind: 'company', party_code: 'ex-1' } }));
    expect(explicit.status).toBe(201);
    expect(itemOk(explicit.body)).toEqual([]);
    expect(explicit.body.party_code).toBe('EX-1');
  });

  it('POST create duplicates -> 409 catalog.code_duplicate', { timeout: T }, async () => {
    const e = await rejection(call(seeded(), 'createCreditParty', req({ headers: KEY, body: { name: 'Clash', kind: 'other', party_code: 'cpx1' } })));
    expect(isLimsError(e, 'catalog.code_duplicate')).toBe(true); expect(e.statusCode).toBe(409);
  });

  it('GET list -> 200 whose body is exactly CreditPartyPage; filters pass through (kind, allows_credit, is_active, q + cursor); bad values -> 400', { timeout: T }, async () => {
    const db = seeded();
    const l = await call(db, 'listCreditParties', req());
    expect(pageOk(l.body)).toEqual([]);
    expect(l.body.data.map((d: Row) => d.party_code).sort()).toEqual(['CPX1', 'CPY1']);
    expect(JSON.stringify(l.body)).not.toMatch(/THEIRS1|B Secret|BPAN-9/);
    expect((await call(db, 'listCreditParties', req({ query: { kind: 'clinic' } }))).body.data.map((d: Row) => d.party_code)).toEqual(['CPY1']);
    expect((await call(db, 'listCreditParties', req({ query: { allows_credit: false } }))).body.data.map((d: Row) => d.party_code)).toEqual(['CPX1']);
    expect((await call(db, 'listCreditParties', req({ query: { is_active: 'false' } }))).body.data.map((d: Row) => d.party_code)).toEqual(['CPZ1']);
    expect((await call(db, 'listCreditParties', req({ query: { q: 'cpy' } }))).body.data.map((d: Row) => d.party_code)).toEqual(['CPY1']);
    const first = await call(db, 'listCreditParties', req({ query: { is_active: 'all', limit: 2 } }));
    expect(pageOk(first.body)).toEqual([]);
    expect(first.body.data).toHaveLength(2);
    const next = await call(db, 'listCreditParties', req({ query: { is_active: 'all', limit: 2, cursor: first.body.page.next_cursor } }));
    expect(next.body.data).toHaveLength(1);
    expect([...first.body.data, ...next.body.data].map((d: Row) => d.party_code).sort()).toEqual(['CPX1', 'CPY1', 'CPZ1']);
    for (const query of [{ is_active: 'maybe' }, { kind: 'bank' }, { allows_credit: 'perhaps' }, { limit: 0 }, { limit: 201 }, { cursor: '!!!' }, { q: 'C'.repeat(21) }]) {
      expect((await rejection(call(db, 'listCreditParties', req({ query })))).statusCode, JSON.stringify(query)).toBe(400);
    }
  });

  it('GET one -> 200 CreditParty schema; manage holder sees pan / contacts / address', { timeout: T }, async () => {
    const r = await call(seeded(), 'getCreditParty', req({ params: { credit_party_id: X.id } }));
    expect(r.status).toBe(200);
    expect(itemOk(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: X.id, party_code: 'CPX1', allows_credit: false, pan: '123456789', contact_phone_e164: P1, contact_email: 'billing@example.test', billing_address: 'Synthetic Street 1, Synthetic City' });
  });

  it('AC-12.4 / AB-22 / S-11: GET one with catalog.price_list.read only (front_desk) -> still a valid CreditParty, but pan, contact_phone_e164, contact_email and billing_address are ABSENT', { timeout: T }, async () => {
    const r = await call(seeded(), 'getCreditParty', req({ params: { credit_party_id: X.id } }), [READ]);
    expect(r.status).toBe(200);
    expect(itemOk(r.body)).toEqual([]);
    for (const k of ['pan', 'contact_phone_e164', 'contact_email', 'billing_address']) expect(r.body).not.toHaveProperty(k);
    expect(JSON.stringify(r.body)).not.toMatch(SECRETS);
    expect(r.body).toMatchObject({ id: X.id, name: 'Synthetic General Hospital', allows_credit: false });
  });

  it('AC-12.4 / AB-22: GET list with catalog.price_list.read only -> every item valid, no sensitive field anywhere in the body', { timeout: T }, async () => {
    const r = await call(seeded(), 'listCreditParties', req({ query: { is_active: 'all' } }), [READ]);
    expect(r.status).toBe(200);
    expect(pageOk(r.body)).toEqual([]);
    expect(r.body.data).toHaveLength(3);
    expect(JSON.stringify(r.body)).not.toMatch(SECRETS);
    for (const k of ['pan', 'contact_phone_e164', 'contact_email', 'billing_address']) expect(JSON.stringify(r.body)).not.toContain(`"${k}"`);
  });

  it('fail closed: getCreditParty and listCreditParties never return sensitive fields when the identity port is missing or its getActor fails', { timeout: T }, async () => {
    const broken = { ...actorIdentity([READ, MANAGE]), getActor: async () => { throw Object.assign(new Error('down'), { code: 'auth.unauthenticated' }); } };
    for (const [id, r] of [['getCreditParty', req({ params: { credit_party_id: X.id } })], ['listCreditParties', req()]] as const) {
      const noPort = await mk([X]).run((ctx) => H[id]!(r, { ...ctx, ports: {} })).then((x) => JSON.stringify(x), (e) => `rejected ${e?.code ?? ''}`);
      expect(noPort, id).not.toMatch(SECRETS);
      const failing = await mk([X]).run((ctx) => H[id]!(r, { ...ctx, ports: { IdentityPort: broken } })).then((x) => JSON.stringify(x), (e) => `rejected ${e?.code ?? ''}`);
      expect(failing, id).not.toMatch(SECRETS);
    }
  });

  it('PATCH with If-Match "1" -> 200 CreditParty, version 2 (the unset list clears a field); AC-12.2: allows_credit flips', { timeout: T }, async () => {
    const db = seeded();
    const r = await call(db, 'updateCreditParty', req({ params: { credit_party_id: X.id }, headers: IM1, body: { allows_credit: true, billing_address: 'New Street 5', unset: ['contact_email'] } }));
    expect(r.status).toBe(200);
    expect(itemOk(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: X.id, allows_credit: true, billing_address: 'New Street 5', version: 2 });
    expect(r.body).not.toHaveProperty('contact_email');
  });

  it('PATCH by a read-only caller that reaches the handler still returns no sensitive field', { timeout: T }, async () => {
    const r = await call(seeded(), 'updateCreditParty', req({ params: { credit_party_id: X.id }, headers: IM1, body: { name: 'Renamed' } }), [READ]);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(SECRETS);
  });

  it('AC-01.6 pattern on PATCH: no If-Match -> 428; stale -> 409 version_conflict; nothing written', { timeout: T }, async () => {
    const db = mk([{ ...X, version: 3 }, Y]);
    const a = await rejection(call(db, 'updateCreditParty', req({ params: { credit_party_id: X.id }, body: { name: 'x' } })));
    expect(isLimsError(a, 'common.precondition_required')).toBe(true); expect(a.statusCode).toBe(428);
    const b = await rejection(call(db, 'updateCreditParty', req({ params: { credit_party_id: X.id }, headers: { 'if-match': '"2"' }, body: { name: 'x' } })));
    expect(isLimsError(b, 'common.version_conflict')).toBe(true); expect(b.statusCode).toBe(409);
    expect(db.row(X.id)).toMatchObject({ version: 3, name: 'Synthetic General Hospital' });
  });

  it.each([['unquoted', '1'], ['weak', 'W/"1"'], ['star', '*'], ['zero', '"0"'], ['leading zero', '"01"'], ['non numeric', '"abc"'], ['negative', '"-1"'], ['beyond int32', '"99999999999"'], ['empty', '']])
  ('malformed If-Match (%s) on PATCH -> 400, never 500, never a write', { timeout: T }, async (_n, h) => {
    const db = mk([X, Y]);
    const e = await rejection(call(db, 'updateCreditParty', req({ params: { credit_party_id: X.id }, headers: { 'if-match': h }, body: { name: 'x' } })));
    expect(isLimsError(e)).toBe(true); expect(e.statusCode).toBe(400);
    expect(db.row(X.id)).toMatchObject({ version: 1, name: 'Synthetic General Hospital' });
    expect(db.events).toHaveLength(0);
  });

  it('unknown credit_party_id -> 404 on get/patch; S-1: tenant B\'s id -> 404 and the B row is untouched; no value of B in the error', { timeout: T }, async () => {
    const db = seeded();
    for (const id of [ID(0xdead), THEIRS.id]) {
      for (const [op, extra] of [['getCreditParty', {}], ['updateCreditParty', { headers: IM1, body: { name: 'x' } }]] as const) {
        const e = await rejection(call(db, op, req({ params: { credit_party_id: id }, ...extra })));
        expect(isLimsError(e, 'common.not_found'), op).toBe(true); expect(e.statusCode, op).toBe(404);
        expect(JSON.stringify([e.message, e.detail, e.errors])).not.toMatch(/THEIRS1|B Secret|9779800000099|BPAN-9/);
      }
    }
    expect(db.row(THEIRS.id)).toMatchObject({ version: 1, name: 'B Secret Party' });
    expect(db.events).toHaveLength(0);
  });

  it('S-5 / AC-12.3: mass assignment through the handlers -> 400, nothing written', { timeout: T }, async () => {
    const db = seeded();
    for (const extra of [{ tenant_id: TENANT_B }, { version: 7 }, { id: ID(0xbad) }, { is_active: false }, { price_list_id: ID(5) }, { credit_limit: 100000 }, { credit_days: 30 }, { balance: 0 }]) {
      expect((await rejection(call(db, 'createCreditParty', req({ headers: KEY, body: { name: 'New', kind: 'other', ...extra } })))).statusCode, JSON.stringify(extra)).toBe(400);
    }
    for (const patch of [{ party_code: 'RENAMED' }, { tenant_id: TENANT_B }, { version: 9 }, { price_list_id: ID(5) }, { credit_limit: 1 }, { credit_days: 1 }, { balance: 1 }]) {
      expect((await rejection(call(db, 'updateCreditParty', req({ params: { credit_party_id: X.id }, headers: IM1, body: patch })))).statusCode, JSON.stringify(patch)).toBe(400);
    }
    expect(db.rows('credit_parties', A)).toHaveLength(3);                                         // X, Y, the inactive CPZ1 — no new row
    expect(db.row(X.id)).toMatchObject({ version: 1, party_code: 'CPX1' });
    expect(db.events).toHaveLength(0);
  });

  it('fails closed without an authenticated request context: auth.unauthenticated for all four operations, nothing reflected', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    for (const id of IDS) {
      const e = await rejection(H[id]!(req({ params: { credit_party_id: ID(1) }, headers: { ...IM1, ...KEY }, query: {}, body: { name: planted, kind: planted, q: planted } }), bare(id)));
      expect(isLimsError(e, 'auth.unauthenticated'), id).toBe(true);
      expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain(planted);
    }
  });
});
