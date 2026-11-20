// #5–#16 masters handlers (02-TRD §5). Schema, auth, x-permission and Idempotency-Key are the core pipeline's (catalog.yaml);
// these map request -> service and fail closed without an authenticated request context (same convention as C6 handlers).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createCategoriesService } from '../service/categories.service.js';
import { createCommentsService } from '../service/comments.service.js';
import { createMastersService } from '../service/masters.service.js';
import { guarded } from './_guard.js';

type Ctx = Parameters<ReturnType<typeof createMastersService>[string]>[0] & { events?: Parameters<typeof createMastersService>[0]['events'] };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

/** If-Match: "<version>" (02-CV §4.2). Absent -> undefined (428); malformed -> 0 (400 from the service). */
export function ifMatch(req: HandlerRequest): number | undefined {
  const h = obj(req.headers)['if-match'];
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  return m ? Number(m[1]) : 0;
}

function bind(op: string, run: (call: (input: unknown) => Promise<any>, req: HandlerRequest) => Promise<{ status: number; body: unknown }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<Ctx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || !c.events) throw new LimsError('auth.unauthenticated');
    const deps = { events: c.events };
    const fn = ({ ...createMastersService(deps), ...createCommentsService(deps), ...createCategoriesService(deps) } as Record<string, (ctx: Ctx, input: unknown) => Promise<any>>)[op]!;
    return run((input) => fn(c as Ctx, input), req);
  };
}

// #5–#16 use path param `id`; units / value sets (#17–#22, T-05) use `unit_id` / `value_set_id`; comment codes (#57–#59, T-13) `comment_code_id` (catalog.yaml).
const RESOURCES: Array<[string, string]> = [['Department', 'id'], ['SpecimenType', 'id'], ['Container', 'id'], ['Method', 'id'], ['Unit', 'unit_id'], ['ValueSet', 'value_set_id'],
  ['CommentCode', 'comment_code_id']];
const entries: Array<[string, Handler]> = RESOURCES.flatMap(([R, param]) => [
  [`list${R}s`, bind(`list${R}s`, async (call, req) => ({ status: 200, body: await call(req.query) }))],
  [`create${R}`, bind(`create${R}`, async (call, req) => ({ status: 201, body: await call(req.body) }))],
  [`update${R}`, bind(`update${R}`, async (call, req) => ({
    status: 200, body: await call({ id: obj(req.params)[param], expectedVersion: ifMatch(req), patch: req.body }),
  }))],
] as Array<[string, Handler]>);
// T0B-TESTMGMT-1 (LD-318, LD-325 b): test categories, path param `category_id` (catalog.yaml).
entries.push(
  ['listTestCategories', bind('listTestCategories', async (call, req) => ({ status: 200, body: await call(req.query) }))],
  ['createTestCategory', bind('createTestCategory', async (call, req) => ({ status: 201, body: await call(req.body) }))],
  ['updateTestCategory', bind('updateTestCategory', async (call, req) => ({ status: 200, body: await call({ id: obj(req.params)['category_id'], expectedVersion: ifMatch(req), patch: req.body }) }))],
);

const raw = Object.fromEntries(entries) as Record<string, Handler>;

// SEC-AUTHZ-5 (LD-189, LD-261): every master asserts its contract x-permission (catalog.test.read | catalog.test.manage) through IdentityPort.assertRole
// before bind() validates the context or touches the service. Written out per operation so the guard is greppable and the classifier sees it.
export const mastersHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listDepartments: guarded('catalog.test.read', raw['listDepartments']!),
  createDepartment: guarded('catalog.test.manage', raw['createDepartment']!),
  updateDepartment: guarded('catalog.test.manage', raw['updateDepartment']!),
  listSpecimenTypes: guarded('catalog.test.read', raw['listSpecimenTypes']!),
  createSpecimenType: guarded('catalog.test.manage', raw['createSpecimenType']!),
  updateSpecimenType: guarded('catalog.test.manage', raw['updateSpecimenType']!),
  listContainers: guarded('catalog.test.read', raw['listContainers']!),
  createContainer: guarded('catalog.test.manage', raw['createContainer']!),
  updateContainer: guarded('catalog.test.manage', raw['updateContainer']!),
  listMethods: guarded('catalog.test.read', raw['listMethods']!),
  createMethod: guarded('catalog.test.manage', raw['createMethod']!),
  updateMethod: guarded('catalog.test.manage', raw['updateMethod']!),
  listUnits: guarded('catalog.test.read', raw['listUnits']!),
  createUnit: guarded('catalog.test.manage', raw['createUnit']!),
  updateUnit: guarded('catalog.test.manage', raw['updateUnit']!),
  listValueSets: guarded('catalog.test.read', raw['listValueSets']!),
  createValueSet: guarded('catalog.test.manage', raw['createValueSet']!),
  updateValueSet: guarded('catalog.test.manage', raw['updateValueSet']!),
  listCommentCodes: guarded('catalog.test.read', raw['listCommentCodes']!),
  createCommentCode: guarded('catalog.test.manage', raw['createCommentCode']!),
  updateCommentCode: guarded('catalog.test.manage', raw['updateCommentCode']!),
  listTestCategories: guarded('catalog.test.read', raw['listTestCategories']!),
  createTestCategory: guarded('catalog.test.manage', raw['createTestCategory']!),
  updateTestCategory: guarded('catalog.test.manage', raw['updateTestCategory']!),
});
