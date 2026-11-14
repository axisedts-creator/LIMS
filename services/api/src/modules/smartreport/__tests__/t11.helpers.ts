// C14 T11 helpers (not a test file): calling handlers #1-#21 through the real handlers map, plus the openapi contract validator.
//
// SEAMS pinned for T11 (the spec fixes behaviour + names, not TypeScript shapes):
//   Handler ctx (CV §6.3): ctx.tenantId, ctx.actor.id + ctx.actor.membershipId, ctx.tx (only `pg_advisory_xact_lock` via tx.query; tx.savepoint(fn)), ctx.ports.IdentityPort / CatalogPort,
//     ctx.core.memberships.list(ctx, { membershipIds, activeOnly:false }) -> [{ membershipId, displayName }]  (P-17; the ONLY source of *_display_name; batched + memoised per request).
//   The caller's membership id (approved_by / submitted_by / returned_by / library_reviews.actor) = ctx.actor.membershipId (== IdentityPort.getActor(ctx).actor.membershipId).
//   Handlers/services reach the DB ONLY through the T02 repositories (mocked with stateful emulators, t11.fakes.ts). Tenant id never comes from request input.
//   Authorise FIRST (IdentityPort.assertRole, tenant-wide, no centreId): #1-#19 smartreport.template.manage, #20/#21 smartreport.template.approve; before any repository access.
//   Repos are used as in T02: libraryRepo.insertLibraryVersion/updateLibraryVersion(rc,id,expectedVersion,patch)/getLibraryVersion/getOpenLibraryVersion/listLibraryVersions(rc,{limit}),
//   blocks/rules/mappings/groups repos (insert/get/update/list), reviewsRepo.insertLibraryReview(rc,{id,library_version_id,action,comment?,content_sha256?,actor_membership_id}),
//   codedSetsRepo.listOrganGroups (starter group settings). Removal = update(..., { is_active:false }) (no delete function exists). Any child write bumps the parent (updateLibraryVersion).
//   Create (#2) takes ctx.tx.query('SELECT pg_advisory_xact_lock(...)', [... 'smartreport:library:<tenantId>' ...]) BEFORE any open-version / max-version read or insert.
//   Errors: LimsError(code[, detail, errors[]]); library_invalid issues go in LimsError.errors = [{ path (JSON pointer), code:'common.field_invalid', message: '<issue code> ...' }].
//   DB errors surface as pg-style errors { code:'P0001', message:'immutable_row' } -> common.immutable_record; 'invalid_transition' -> smartreport.library_invalid_transition;
//   23505 on the open-draft index -> smartreport.library_invalid_transition; 23505 on the block key index -> smartreport.library_invalid; 23503 on analyte FK -> common.not_found.
//   Responses are validated against contracts/openapi/smartreport.yaml (after a JSON round trip, as Fastify serialises them).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { parse } from 'yaml';
import { LimsError } from '../../../core/errors.js';
import { REPO_ROOT } from '../../../core/module.js';
import { AJV_OPTIONS } from '../../../core/openapi.js';
import { handlers } from '../handlers/index.js';
import { makeCtx, restore, snapshot, type Persona } from './t11.fakes.js';

export * from './t11.fakes.js';

/** The body goes through JSON like on the wire (keys set to `undefined` in a test fixture are absent, never present-and-undefined). */
export const request = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) =>
  ({ params: o.params ?? {}, query: o.query ?? {}, headers: o.headers ?? {}, body: o.body === undefined ? {} : JSON.parse(JSON.stringify(o.body)) });
export const ifMatch = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
export const json = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export function call(operationId: string, persona: Persona, req: ReturnType<typeof request>, tenant: 'A' | 'B' = 'A', o: { names?: boolean } = {}) {
  const { ctx, asserted } = makeCtx(persona, operationId, tenant, o);
  const h = (handlers as Record<string, (r: unknown, c: unknown) => Promise<any>>)[operationId];
  // the core rolls the request transaction back when a handler throws
  const run = async () => { const snap = snapshot(); try { return await h!(req, ctx); } catch (e) { restore(snap); throw e; } };
  return { run, asserted, ctx };
}
export async function fails(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected the operation to be refused, but it answered');
}
export const codeOf = (e: unknown): string | undefined => (e instanceof LimsError ? e.code : undefined);
export const pointerOf = (e: any): string[] => (e?.errors ?? []).map((x: any) => x.path);

// ---------------------------------------------------------------- openapi contract
const readYaml = (f: string): any => parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', f), 'utf8'));
const DOCS = { smartreport: readYaml('smartreport.yaml'), common: readYaml('_common.yaml') } as const;
type DocName = keyof typeof DOCS;
function deref(node: any, doc: DocName = 'smartreport'): any {
  if (Array.isArray(node)) return node.map((n) => deref(n, doc));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const [file, ptr = ''] = node.$ref.split('#');
    const target: DocName = file ? 'common' : doc;
    return deref(ptr.split('/').slice(1).reduce((o: any, k: string) => o[k], DOCS[target]), target);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(v, doc)]));
}
const opRaw = (id: string): any => {
  for (const item of Object.values<any>(DOCS.smartreport.paths)) for (const o of Object.values<any>(item)) if (o?.operationId === id) return o;
  throw new Error(`no operation ${id}`);
};
const compile = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object }) => any;
const validator = compile({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, useDefaults: false } });
const problems = (schema: object, value: unknown): string[] => {
  const v = validator({ schema });
  return v(value) ? [] : (v.errors ?? []).map((e: any) => `${e.instancePath || '/'} ${e.keyword} ${JSON.stringify(e.params)}`);
};
/** Problems of a handler result against the operation's declared response (status + body schema). */
export function responseProblems(operationId: string, r: { status: number; body?: unknown }): string[] {
  const decl = deref(opRaw(operationId).responses?.[String(r.status)]);
  if (!decl) return [`status ${r.status} is not declared for ${operationId}`];
  const schema = decl.content?.['application/json']?.schema;
  if (!schema) return r.body === undefined ? [] : [`${operationId} ${r.status} must have no body`];
  return problems(schema, json(r.body));
}
export const requestProblems = (operationId: string, body: unknown): string[] => {
  const schema = deref(opRaw(operationId).requestBody?.content?.['application/json']?.schema);
  return schema ? problems(schema, json(body)) : [];
};
export const declaredOperationIds = (): string[] => {
  const ids: string[] = [];
  for (const item of Object.values<any>(DOCS.smartreport.paths)) for (const o of Object.values<any>(item)) if (o?.operationId) ids.push(o.operationId);
  return ids;
};
export const permissionOf = (id: string): string => opRaw(id)['x-permission'];
