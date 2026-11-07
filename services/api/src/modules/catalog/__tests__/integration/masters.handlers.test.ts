// T-04 (C3) — masters HTTP contract + probes: the 12 handlers #5–#16 are real (no longer CR-C3-008 stubs) and honour contracts/openapi/catalog.yaml.
// Spec: 06-PLAN T-04 ("integration, HTTP contract, probes"; done_when: "removes operationIds from pending.json"); 02-TRD §5 masters table,
//       §5.0 (If-Match on PATCH: 428 missing / 409 stale; Idempotency-Key on creates); 07-SECURITY S-1, S-4 (x-permission floor), S-5, S-16, AB-20.
// The core pipeline (schema, auth, x-permission, Idempotency-Key replay) is not re-tested here — its inputs are: handlers are driven with a
// request-shaped object and the same HandlerContext subset the services get, responses are validated against the OpenAPI schemas.
// Interface expected from the writer (SEAM, see .orchestra/notes/T-04-tests.md): handlers/index.ts maps each of the 12 operationIds to a real
// Handler `(req: {params, query, headers, body}, ctx) => {status, body, headers?}`; errors are thrown LimsErrors (pipeline renders problem+json).
// If-Match arrives as the raw header (`headers['if-match'] === '"<version>"'`, lower-cased name); a context without tenantId/actor/tx fails
// closed with auth.unauthenticated (same convention as C6 handlers).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec, operationIds } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { ROOT_A, TENANT_A, TENANT_B } from '../helpers/catalogDb.js';
import { cont, dept, ID, makeMastersDb, meth, spec as specimen, type Row, type Table } from '../helpers/mastersDb.js';

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

interface Op { R: string; table: Table; seedFn: (n: number, t: string, o?: Row) => Row; body: Record<string, unknown>; patch: Record<string, unknown> }
const OPS: Op[] = [
  { R: 'Department', table: 'departments', seedFn: dept, body: { code: 'haem', name: 'Hematology', report_order: 10 }, patch: { name: 'Haematology' } },
  { R: 'SpecimenType', table: 'specimen_types', seedFn: specimen, body: { code: 'edta_wb', name: 'EDTA whole blood', report_label: 'EDTA WHOLE BLOOD' }, patch: { report_label: 'EDTA WB' } },
  { R: 'Container', table: 'containers', seedFn: cont, body: { code: 'lav_top', name: 'Lavender top tube', additive: 'K2EDTA' }, patch: { additive: 'K3EDTA' } },
  { R: 'Method', table: 'methods', seedFn: meth, body: { code: 'impedance', name: 'Electrical impedance' }, patch: { name: 'Impedance counting' } },
];
const ALL_IDS = OPS.flatMap((o) => [`list${o.R}s`, `create${o.R}`, `update${o.R}`]);
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const mk = (rows: Partial<Record<Table, Row[]>> = {}) => makeMastersDb({ rows, catalog: { state: { [TENANT_A]: { rootId: ROOT_A, revision: 417 } } } });
const bare = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } });

describe('the 12 masters operations exist in the contract with the TRD permissions/idempotency (S-4, S-16)', () => {
  it('operationIds are all in catalog.yaml and in the manifest handlers', () => {
    const ids = operationIds(spec);
    for (const id of ALL_IDS) { expect(ids).toContain(id); expect(typeof (manifest.handlers as any)[id]).toBe('function'); expect((manifest.handlers as any)[id]).toBe(H[id]); }
  });
  it.each(OPS)('$R: list = catalog.test.read; create/update = catalog.test.manage; create needs Idempotency-Key, update needs If-Match, update has no code field', ({ R }) => {
    expect(opOf(`list${R}s`)['x-permission']).toBe('catalog.test.read');
    expect(opOf(`create${R}`)['x-permission']).toBe('catalog.test.manage');
    expect(opOf(`update${R}`)['x-permission']).toBe('catalog.test.manage');
    expect(opOf(`create${R}`)['x-idempotency']).toBe('required');
    expect(opOf(`update${R}`)['x-idempotency']).toBe('none');
    expect(JSON.stringify(opOf(`update${R}`).parameters)).toContain('IfMatch');
    const upd = spec.components.schemas[`${R}Update`]; const cre = spec.components.schemas[`${R}Create`];
    expect(upd.additionalProperties).toBe(false); expect(cre.additionalProperties).toBe(false);
    expect(Object.keys(upd.properties)).not.toContain('code');
    for (const k of ['id', 'tenant_id', 'version', 'created_by', 'updated_by', 'created_at', 'updated_at']) { expect(Object.keys(cre.properties)).not.toContain(k); expect(Object.keys(upd.properties)).not.toContain(k); }
  });
});

describe('probes (CR-C3-008): the masters stubs are gone', () => {
  const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
  it('none of the 12 operationIds is listed in probes/pending.json any more', () => {
    for (const id of ALL_IDS) expect(pending, id).not.toContain(id);
  });
  it.each(ALL_IDS)('%s does not answer 503 common.service_unavailable / not_implemented', { timeout: T }, async (id) => {
    const db = mk();
    const e = await db.run((ctx) => H[id]!(req({ params: { id: ID(0x1) }, headers: { 'if-match': '"1"', 'idempotency-key': 'k-1' }, body: {} }), ctx)).then(() => undefined, (x) => x);
    expect(e?.code).not.toBe('common.service_unavailable');
    expect(e?.detail).not.toBe('not_implemented');
  });
});

describe.each(OPS)('$R — handlers over the service, validated against the OpenAPI schemas', (o) => {
  const [list, create, update] = [`list${o.R}s`, `create${o.R}`, `update${o.R}`] as const;
  const dtoOk = validatorFor(o.R);
  const pageOk = validatorFor(`${o.R}Page`);

  it('create -> 201 with a body that is exactly the contract DTO (no extra/internal fields)', { timeout: T }, async () => {
    const db = mk();
    const r = await db.run((ctx) => H[create]!(req({ headers: { 'idempotency-key': 'k-1' }, body: o.body }), ctx));
    expect(r.status).toBe(201);
    expect(dtoOk(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ version: 1, is_active: true, code: String(o.body['code']).toUpperCase() });
  });

  it('list -> 200 with a body that is exactly the contract Page; default filter hides inactive rows', { timeout: T }, async () => {
    const db = mk({ [o.table]: [o.seedFn(1, TENANT_A), o.seedFn(2, TENANT_A, { is_active: false }), o.seedFn(3, TENANT_B)] });
    const r = await db.run((ctx) => H[list]!(req(), ctx));
    expect(r.status).toBe(200);
    expect(pageOk(r.body)).toEqual([]);
    expect(r.body.data).toHaveLength(1);
    const all = await db.run((ctx) => H[list]!(req({ query: { is_active: 'all', limit: 1 } }), ctx));
    expect(all.body.data).toHaveLength(1);
    expect(typeof all.body.page.next_cursor).toBe('string');
    expect(pageOk(all.body)).toEqual([]);
  });

  it('update with If-Match "1" -> 200 DTO version 2', { timeout: T }, async () => {
    const row = o.seedFn(1, TENANT_A);
    const db = mk({ [o.table]: [row] });
    const r = await db.run((ctx) => H[update]!(req({ params: { id: row.id }, headers: { 'if-match': '"1"' }, body: o.patch }), ctx));
    expect(r.status).toBe(200);
    expect(dtoOk(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ ...o.patch, id: row.id, version: 2 });
  });

  it('AC-01.6: no If-Match header -> 428 common.precondition_required', { timeout: T }, async () => {
    const row = o.seedFn(1, TENANT_A);
    const db = mk({ [o.table]: [row] });
    const e = await rejection(db.run((ctx) => H[update]!(req({ params: { id: row.id }, body: o.patch }), ctx)));
    expect(isLimsError(e, 'common.precondition_required')).toBe(true);
    expect(e.statusCode).toBe(428);
  });

  it('AC-01.6: stale If-Match -> 409 common.version_conflict', { timeout: T }, async () => {
    const row = o.seedFn(1, TENANT_A, { version: 3 });
    const db = mk({ [o.table]: [row] });
    const e = await rejection(db.run((ctx) => H[update]!(req({ params: { id: row.id }, headers: { 'if-match': '"2"' }, body: o.patch }), ctx)));
    expect(isLimsError(e, 'common.version_conflict')).toBe(true);
    expect(e.statusCode).toBe(409);
    expect(db.row(o.table, row.id)!.version).toBe(3);
  });

  it.each([['unquoted', '1'], ['weak', 'W/"1"'], ['star', '*'], ['zero', '"0"'], ['leading zero', '"01"'], ['non numeric', '"abc"'], ['negative', '"-1"'],
    ['beyond int32', '"99999999999"'], ['empty', '']])('malformed If-Match (%s) -> 400, never 500 and never a write', { timeout: T }, async (_n, h) => {
    const row = o.seedFn(1, TENANT_A);
    const db = mk({ [o.table]: [row] });
    const e = await rejection(db.run((ctx) => H[update]!(req({ params: { id: row.id }, headers: { 'if-match': h }, body: o.patch }), ctx)));
    expect(isLimsError(e)).toBe(true);
    expect(e.statusCode).toBe(400);
    expect(db.row(o.table, row.id)!.version).toBe(1);
  });

  it('duplicate code -> 409 catalog.code_duplicate', { timeout: T }, async () => {
    const db = mk({ [o.table]: [o.seedFn(1, TENANT_A, { code: String(o.body['code']).toUpperCase() })] });
    const e = await rejection(db.run((ctx) => H[create]!(req({ headers: { 'idempotency-key': 'k-1' }, body: o.body }), ctx)));
    expect(isLimsError(e, 'catalog.code_duplicate')).toBe(true);
    expect(e.statusCode).toBe(409);
  });

  it('S-1: a path id of tenant B -> 404 common.not_found, B row untouched', { timeout: T }, async () => {
    const theirs = o.seedFn(1, TENANT_B);
    const db = mk({ [o.table]: [theirs] });
    const e = await rejection(db.run((ctx) => H[update]!(req({ params: { id: theirs.id }, headers: { 'if-match': '"1"' }, body: o.patch }), ctx)));
    expect(isLimsError(e, 'common.not_found')).toBe(true);
    expect(db.row(o.table, theirs.id)).toMatchObject({ version: 1 });
    const read = await db.run((ctx) => H[list]!(req({ query: { id: theirs.id } }), ctx));
    expect(read.body.data).toEqual([]);
  });

  it('S-5: mass assignment through the handler (tenant_id, version, id) -> 400 and nothing written', { timeout: T }, async () => {
    const db = mk();
    for (const extra of [{ tenant_id: TENANT_B }, { version: 7 }, { id: ID(0xbad) }]) {
      const e = await rejection(db.run((ctx) => H[create]!(req({ headers: { 'idempotency-key': 'k-1' }, body: { ...o.body, ...extra } }), ctx)));
      expect(e.statusCode).toBe(400);
    }
    expect(db.rows(o.table)).toHaveLength(0);
    expect(db.events).toHaveLength(0);
  });

  it('fails closed without an authenticated request context (no tenant/actor/tx): auth.unauthenticated, nothing reflected', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    const e = await rejection(H[create]!(req({ body: { ...o.body, name: planted } }), bare(create)));
    expect(isLimsError(e, 'auth.unauthenticated')).toBe(true);
    expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain(planted);
    for (const id of [list, update]) expect(isLimsError(await rejection(H[id]!(req({ params: { id: ID(1) }, headers: { 'if-match': '"1"' }, body: o.patch }), bare(id))), 'auth.unauthenticated')).toBe(true);
  });
});
