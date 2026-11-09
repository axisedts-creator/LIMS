// #2, #23–#27 handlers (02-TRD §5.2). Schema, auth, x-permission and Idempotency-Key are the core pipeline's (catalog.yaml);
// these map request -> service and fail closed without an authenticated request context (same convention as masters.handlers.ts).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createTestsService } from '../service/tests.service.js';
import { ifMatch } from './masters.handlers.js';

type Svc = ReturnType<typeof createTestsService>;
type Ctx = Parameters<Svc['createTest']>[0] & { events?: Parameters<typeof createTestsService>[0]['events'] };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(run: (svc: Svc, ctx: Ctx, req: HandlerRequest) => Promise<{ status: number; body: unknown }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<Ctx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || !c.events) throw new LimsError('auth.unauthenticated');
    return run(createTestsService({ events: c.events }), c as Ctx, req);
  };
}
const ok = (body: unknown) => ({ status: 200, body });

export const testsHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  searchOrderables: bind(async (s, c, r) => ok(await s.searchOrderables(c, r.query))),
  listTests: bind(async (s, c, r) => ok(await s.listTests(c, r.query))),
  createTest: bind(async (s, c, r) => ({ status: 201, body: await s.createTest(c, r.body) })),
  getTestDetail: bind(async (s, c, r) => ok(await s.getTestDetail(c, { id: obj(r.params)['test_id'], as_of: obj(r.query)['as_of'] }))),
  updateTest: bind(async (s, c, r) => ok(await s.updateTest(c, { id: obj(r.params)['test_id'], expectedVersion: ifMatch(r), patch: r.body }))),
  replaceTestSpecimenRequirements: bind(async (s, c, r) =>
    ok(await s.replaceTestSpecimenRequirements(c, { id: obj(r.params)['test_id'], expectedVersion: ifMatch(r), body: r.body }))),
  setTestTatTargets: bind(async (s, c, r) => ok(await s.setTestTatTargets(c, { id: obj(r.params)['test_id'], expectedVersion: ifMatch(r), body: r.body }))),
});
