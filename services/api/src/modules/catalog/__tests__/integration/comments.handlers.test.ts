// T-13 (C3) — comment codes HTTP contract + probes: the three handlers #57–#59 are real (no longer CR-C3-008 stubs) and honour catalog.yaml.
// Spec: 06-PLAN T-13; 02-TRD §5 rows 57–59, §5.0 (If-Match on PATCH: 428 missing / 409 stale; Idempotency-Key on creates); 07-SECURITY S-1, S-4, S-5, S-16, AB-20.
// Same harness conventions as masterSets.handlers.test.ts (T-05): handlers driven with a request-shaped object + the HandlerContext subset;
// responses validated against the OpenAPI schemas. Path param is `comment_code_id` (NOT `id`). If-Match is the raw header `"<n>"`.
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
import { cc, dept, makeCommentsDb, type CommentTable } from '../helpers/commentsDb.js';
import { ID, type Row } from '../helpers/mastersDb.js';

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

const IDS = ['listCommentCodes', 'createCommentCode', 'updateCommentCode'] as const;
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const HAEM = dept(1, TENANT_A, { code: 'HAEM' });
const B_DEPT = dept(9, TENANT_B, { code: 'THEIRS' });
const mk = (rows: Partial<Record<CommentTable, Row[]>> = {}) => makeCommentsDb({ rows, departments: [HAEM, B_DEPT], catalog: { state: { [TENANT_A]: { rootId: ROOT_A, revision: 417 } } } });
const bare = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } });
const KEY = { 'idempotency-key': 'k-1' };

describe('the 3 operations exist in the contract with the TRD permissions/idempotency (S-4, S-16)', () => {
  it('operationIds are in catalog.yaml and in the manifest handlers', () => {
    const ids = operationIds(spec);
    for (const id of IDS) { expect(ids).toContain(id); expect(typeof (manifest.handlers as any)[id]).toBe('function'); expect((manifest.handlers as any)[id]).toBe(H[id]); }
  });
  it('list = catalog.test.read; create/update = catalog.test.manage; create needs Idempotency-Key; update needs If-Match and has the comment_code_id path param', () => {
    expect(opOf('listCommentCodes')['x-permission']).toBe('catalog.test.read');
    expect(opOf('createCommentCode')['x-permission']).toBe('catalog.test.manage');
    expect(opOf('updateCommentCode')['x-permission']).toBe('catalog.test.manage');
    expect(opOf('createCommentCode')['x-idempotency']).toBe('required');
    expect(opOf('updateCommentCode')['x-idempotency']).toBe('none');
    expect(JSON.stringify(opOf('updateCommentCode').parameters)).toContain('IfMatch');
    expect(opOf('updateCommentCode').parameters.some((p: any) => p.name === 'comment_code_id' && p.in === 'path')).toBe(true);
  });
  it('contract facts the service relies on: update has only text/is_active (no code, no department_id), create has only code/department_id/text, all additionalProperties:false', () => {
    const u = spec.components.schemas['CommentCodeUpdate']; const c = spec.components.schemas['CommentCodeCreate'];
    expect(u.additionalProperties).toBe(false); expect(c.additionalProperties).toBe(false);
    expect(Object.keys(u.properties).sort()).toEqual(['is_active', 'text']);
    expect(Object.keys(c.properties).sort()).toEqual(['code', 'department_id', 'text']);
    expect(Object.keys(spec.components.schemas['CommentCode'].properties).sort()).toEqual(['code', 'department_id', 'id', 'is_active', 'text', 'version']);
  });
});

describe('probes (CR-C3-008): the comment-code stubs are gone', () => {
  const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
  it('none of the three operationIds is listed in probes/pending.json any more', () => {
    for (const id of IDS) expect(pending, id).not.toContain(id);
  });
  it.each(IDS)('%s does not answer 503 common.service_unavailable / not_implemented', { timeout: T }, async (id) => {
    const db = mk();
    const e = await db.run((ctx) => H[id]!(req({ params: { comment_code_id: ID(0x1) }, headers: { 'if-match': '"1"', ...KEY }, body: {} }), ctx)).then(() => undefined, (x) => x);
    expect(e?.code).not.toBe('common.service_unavailable');
    expect(e?.detail).not.toBe('not_implemented');
  });
});

describe('comment codes — handlers over the service, validated against the OpenAPI schemas', () => {
  const itemOk = validatorFor('CommentCode'); const pageOk = validatorFor('CommentCodePage');
  const dep = cc(1, TENANT_A, { code: 'HYPO', department_id: HAEM.id, text: 'Hypochromia present.' });
  const tw = cc(2, TENANT_A, { code: 'HYPO', text: 'Hypochromia (tenant-wide).' });
  const off = cc(3, TENANT_A, { code: 'OLD', is_active: false });
  const seeded = () => mk({ comment_codes: [dep, tw, off, cc(20, TENANT_B, { code: 'BONLY' })] });

  it('GET list -> 200 whose body is exactly CommentCodePage (active only, own tenant, tenant-wide entries have no department_id key)', { timeout: T }, async () => {
    const db = seeded();
    const r = await db.run((ctx) => H['listCommentCodes']!(req(), ctx));
    expect(r.status).toBe(200);
    expect(pageOk(r.body)).toEqual([]);
    expect(r.body.data.map((x: any) => x.id).sort()).toEqual([dep.id, tw.id].sort());
    expect(r.body.data.find((x: any) => x.id === tw.id)).not.toHaveProperty('department_id');
    expect(JSON.stringify(r.body)).not.toContain('BONLY');
  });

  it('query is passed through: department_id (includes tenant-wide), code_prefix, limit + cursor; bad values -> 400', { timeout: T }, async () => {
    const db = seeded();
    const d = await db.run((ctx) => H['listCommentCodes']!(req({ query: { department_id: HAEM.id } }), ctx));
    expect(d.body.data.map((x: any) => x.id).sort()).toEqual([dep.id, tw.id].sort());
    const p = await db.run((ctx) => H['listCommentCodes']!(req({ query: { code_prefix: 'ZZ' } }), ctx));
    expect(p.body.data).toEqual([]);
    const one = await db.run((ctx) => H['listCommentCodes']!(req({ query: { limit: 1 } }), ctx));
    expect(one.body.data).toHaveLength(1); expect(one.body.page.limit).toBe(1);
    expect(pageOk(one.body)).toEqual([]);
    const two = await db.run((ctx) => H['listCommentCodes']!(req({ query: { limit: 1, cursor: one.body.page.next_cursor } }), ctx));
    expect(two.body.data).toHaveLength(1);
    expect(two.body.data[0].id).not.toBe(one.body.data[0].id);
    for (const query of [{ department_id: 'x' }, { code_prefix: 'A'.repeat(17) }, { limit: 0 }, { limit: 201 }, { cursor: '!!!' }]) {
      expect((await rejection(db.run((ctx) => H['listCommentCodes']!(req({ query }), ctx)))).statusCode).toBe(400);
    }
  });

  it('POST -> 201 with a body that is exactly the CommentCode schema (tenant-wide and department-scoped)', { timeout: T }, async () => {
    const db = mk();
    const a = await db.run((ctx) => H['createCommentCode']!(req({ headers: KEY, body: { code: 'hypo', text: 'Hypochromia (tenant-wide).' } }), ctx));
    expect(a.status).toBe(201);
    expect(itemOk(a.body)).toEqual([]);
    expect(a.body).toMatchObject({ code: 'HYPO', is_active: true, version: 1 });
    expect(a.body).not.toHaveProperty('department_id');
    const b = await db.run((ctx) => H['createCommentCode']!(req({ headers: { 'idempotency-key': 'k-2' }, body: { code: 'HYPO', department_id: HAEM.id, text: 'Hypochromia present.' } }), ctx));
    expect(b.status).toBe(201);
    expect(itemOk(b.body)).toEqual([]);
    expect(b.body).toMatchObject({ department_id: HAEM.id, version: 1 });
    expect(b.body.id).not.toBe(a.body.id);                                     // AC-09.1: both HYPO entries exist
  });

  it('POST duplicates -> 409 catalog.code_duplicate (tenant-wide and department scope)', { timeout: T }, async () => {
    const db = seeded();
    for (const body of [{ code: 'HYPO', text: 'x' }, { code: 'hypo', department_id: HAEM.id, text: 'x' }, { code: 'OLD', text: 'inactive still owns the slot' }]) {
      const e = await rejection(db.run((ctx) => H['createCommentCode']!(req({ headers: KEY, body }), ctx)));
      expect(isLimsError(e, 'catalog.code_duplicate')).toBe(true); expect(e.statusCode).toBe(409);
    }
  });

  it('S-1: POST with tenant B\'s department -> 404 common.not_found', { timeout: T }, async () => {
    const db = mk();
    const e = await rejection(db.run((ctx) => H['createCommentCode']!(req({ headers: KEY, body: { code: 'HYPO', department_id: B_DEPT.id, text: 'x' } }), ctx)));
    expect(isLimsError(e, 'common.not_found')).toBe(true); expect(e.statusCode).toBe(404);
    expect(db.rows('comment_codes')).toHaveLength(0);
  });

  it('PATCH comment_code_id with If-Match "1" -> 200 CommentCode, version 2 (AC-09.3)', { timeout: T }, async () => {
    const db = seeded();
    const r = await db.run((ctx) => H['updateCommentCode']!(req({ params: { comment_code_id: dep.id }, headers: { 'if-match': '"1"' }, body: { text: 'Hypochromia marked.' } }), ctx));
    expect(r.status).toBe(200);
    expect(itemOk(r.body)).toEqual([]);
    expect(r.body).toEqual({ id: dep.id, code: 'HYPO', department_id: HAEM.id, text: 'Hypochromia marked.', is_active: true, version: 2 });
    expect(db.texts(dep.id).filter((x) => x.effective_to === null)).toHaveLength(1);
  });

  it('PATCH is_active:false -> 200 and the code leaves the default list', { timeout: T }, async () => {
    const db = seeded();
    const r = await db.run((ctx) => H['updateCommentCode']!(req({ params: { comment_code_id: tw.id }, headers: { 'if-match': '"1"' }, body: { is_active: false } }), ctx));
    expect(r.body).toMatchObject({ id: tw.id, is_active: false, version: 2 });
    const l = await db.run((ctx) => H['listCommentCodes']!(req(), ctx));
    expect(l.body.data.map((x: any) => x.id)).toEqual([dep.id]);
  });

  it('AC-01.6 pattern: no If-Match -> 428; stale -> 409 version_conflict', { timeout: T }, async () => {
    const db = mk({ comment_codes: [{ ...dep, version: 3 }] });
    const a = await rejection(db.run((ctx) => H['updateCommentCode']!(req({ params: { comment_code_id: dep.id }, body: { text: 'x' } }), ctx)));
    expect(isLimsError(a, 'common.precondition_required')).toBe(true); expect(a.statusCode).toBe(428);
    const b = await rejection(db.run((ctx) => H['updateCommentCode']!(req({ params: { comment_code_id: dep.id }, headers: { 'if-match': '"2"' }, body: { text: 'x' } }), ctx)));
    expect(isLimsError(b, 'common.version_conflict')).toBe(true); expect(b.statusCode).toBe(409);
    expect(db.row('comment_codes', dep.id)!.version).toBe(3);
  });

  it.each([['unquoted', '1'], ['weak', 'W/"1"'], ['star', '*'], ['zero', '"0"'], ['leading zero', '"01"'], ['non numeric', '"abc"'], ['negative', '"-1"'], ['beyond int32', '"99999999999"'], ['empty', '']])
  ('malformed If-Match (%s) -> 400, never 500, never a write', { timeout: T }, async (_n, h) => {
    const db = seeded();
    const e = await rejection(db.run((ctx) => H['updateCommentCode']!(req({ params: { comment_code_id: dep.id }, headers: { 'if-match': h }, body: { text: 'x' } }), ctx)));
    expect(isLimsError(e)).toBe(true); expect(e.statusCode).toBe(400);
    expect(db.row('comment_codes', dep.id)!.version).toBe(1);
    expect(db.rows('comment_code_texts')).toHaveLength(0);
  });

  it('unknown comment_code_id -> 404; S-1: tenant B\'s id -> 404 and B row untouched', { timeout: T }, async () => {
    const db = seeded();
    for (const id of [ID(0xdead), cc(20, TENANT_B).id]) {
      const e = await rejection(db.run((ctx) => H['updateCommentCode']!(req({ params: { comment_code_id: id }, headers: { 'if-match': '"1"' }, body: { text: 'x' } }), ctx)));
      expect(isLimsError(e, 'common.not_found')).toBe(true); expect(e.statusCode).toBe(404);
    }
    expect(db.row('comment_codes', cc(20, TENANT_B).id)).toMatchObject({ version: 1, code: 'BONLY' });
    expect(db.events).toHaveLength(0);
  });

  it('S-5: mass assignment through the handlers -> 400, nothing written', { timeout: T }, async () => {
    const db = seeded();
    for (const extra of [{ tenant_id: TENANT_B }, { version: 7 }, { id: ID(0xbad) }, { is_active: false }, { created_by: ID(1) }]) {
      const e = await rejection(db.run((ctx) => H['createCommentCode']!(req({ headers: KEY, body: { code: 'NEWC', text: 'x', ...extra } }), ctx)));
      expect(e.statusCode).toBe(400);
    }
    for (const patch of [{ code: 'RENAMED' }, { department_id: HAEM.id }, { tenant_id: TENANT_B }, { version: 9 }]) {
      const e = await rejection(db.run((ctx) => H['updateCommentCode']!(req({ params: { comment_code_id: dep.id }, headers: { 'if-match': '"1"' }, body: patch }), ctx)));
      expect(e.statusCode).toBe(400);
    }
    expect(db.rows('comment_codes', TENANT_A)).toHaveLength(3);
    expect(db.row('comment_codes', dep.id)).toMatchObject({ version: 1, code: 'HYPO', department_id: HAEM.id });
    expect(db.events).toHaveLength(0);
  });

  it('fails closed without an authenticated request context: auth.unauthenticated, nothing reflected', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    const e = await rejection(H['createCommentCode']!(req({ body: { code: 'HYPO', text: planted } }), bare('createCommentCode')));
    expect(isLimsError(e, 'auth.unauthenticated')).toBe(true);
    expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain(planted);
    for (const id of ['listCommentCodes', 'updateCommentCode']) {
      expect(isLimsError(await rejection(H[id]!(req({ params: { comment_code_id: ID(1) }, headers: { 'if-match': '"1"' }, body: { text: 'x' } }), bare(id))), 'auth.unauthenticated')).toBe(true);
    }
  });
});
