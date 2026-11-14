// #29–#35 handlers (02-TRD §5.2). Schema, auth, the x-permission floor and Idempotency-Key are the core pipeline's; these map request -> service
// and fail closed without an authenticated request context. #34 asserts BOTH catalog.test.manage and the privileged catalog.reference_range.publish
// (aal2) through IdentityPort.assertRole BEFORE any parsing or data access (S-4, AC-03.6, AB-21).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createAnalyteVersionsService } from '../service/analyteVersions.service.js';
import { ifMatch } from './masters.handlers.js';

type Svc = ReturnType<typeof createAnalyteVersionsService>;
type Ctx = Parameters<Svc['createAnalyte']>[0] & { events?: Parameters<typeof createAnalyteVersionsService>[0]['events']; ports?: { IdentityPort?: Identity } };
interface Identity { assertRole(ctx: unknown, requirement: { permission: string }): Promise<unknown> }
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(run: (svc: Svc, ctx: Ctx, req: HandlerRequest) => Promise<{ status: number; body: unknown }>, needsIdentity = false): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<Ctx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || !c.events || (needsIdentity && !c.ports?.IdentityPort)) throw new LimsError('auth.unauthenticated');
    return run(createAnalyteVersionsService({ events: c.events }), c as Ctx, req);
  };
}
const ok = (body: unknown) => ({ status: 200, body });

export const analyteVersionsHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  createAnalyte: bind(async (s, c, r) => ({ status: 201, body: await s.createAnalyte(c, { test_id: obj(r.params)['test_id'], body: r.body }) })),
  getAnalyte: bind(async (s, c, r) => ok(await s.getAnalyte(c, { id: obj(r.params)['analyte_id'], as_of: obj(r.query)['as_of'] }))),
  updateAnalyte: bind(async (s, c, r) => ok(await s.updateAnalyte(c, { id: obj(r.params)['analyte_id'], expectedVersion: ifMatch(r), patch: r.body }))),
  createAnalyteVersionDraft: bind(async (s, c, r) => ({ status: 201, body: await s.createAnalyteVersionDraft(c, { analyte_id: obj(r.params)['analyte_id'], body: r.body }) })),
  updateAnalyteVersionDraft: bind(async (s, c, r) =>
    ok(await s.updateAnalyteVersionDraft(c, { id: obj(r.params)['analyte_version_id'], expectedVersion: ifMatch(r), patch: r.body }))),
  publishAnalyteVersion: bind(async (s, c, r) => {
    const identity = c.ports!.IdentityPort!;
    await identity.assertRole(c, { permission: 'catalog.test.manage' });
    await identity.assertRole(c, { permission: 'catalog.reference_range.publish' });
    return ok(await s.publishAnalyteVersion(c, { id: obj(r.params)['analyte_version_id'], expectedVersion: ifMatch(r), body: r.body }));
  }, true),
  discardAnalyteVersionDraft: bind(async (s, c, r) => ok(await s.discardAnalyteVersionDraft(c, { id: obj(r.params)['analyte_version_id'], expectedVersion: ifMatch(r) }))),
});
