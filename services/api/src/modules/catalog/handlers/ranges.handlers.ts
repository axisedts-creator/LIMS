// #37–#50 handlers (02-TRD §5.2). Schema, auth, the x-permission floor and Idempotency-Key are the core pipeline's; these map request -> service and fail
// closed without an authenticated request context. publish / retire (both families) assert the privileged catalog.reference_range.publish (aal2) through
// IdentityPort.assertRole BEFORE any parsing or data access (S-4, AC-05.9, AC-06.4, AB-8, AB-21). Path params: `analyte_id` (list, create), `set_id` (the rest).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createRangesService } from '../service/ranges.service.js';
import { ifMatch } from './masters.handlers.js';

type Svc = ReturnType<typeof createRangesService>;
type Ctx = Parameters<Svc['getReferenceRangeSet']>[0] & { events?: Parameters<typeof createRangesService>[0]['events']; ports?: { IdentityPort?: Identity } };
interface Identity { assertRole(ctx: unknown, requirement: { permission: string }): Promise<unknown> }
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
const PUBLISH = 'catalog.reference_range.publish';

function bind(run: (svc: Svc, ctx: Ctx, req: HandlerRequest) => Promise<{ status: number; body: unknown }>, privileged = false): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<Ctx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || !c.events || (privileged && !c.ports?.IdentityPort)) throw new LimsError('auth.unauthenticated');
    if (privileged) await c.ports!.IdentityPort!.assertRole(c, { permission: PUBLISH });
    return run(createRangesService({ events: c.events }), c as Ctx, req);
  };
}
const ok = (body: unknown) => ({ status: 200, body });
const setId = (r: HandlerRequest) => obj(r.params)['set_id'];
const analyteId = (r: HandlerRequest) => obj(r.params)['analyte_id'];

export const rangesHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listReferenceRangeSets: bind(async (s, c, r) => ok(await s.listReferenceRangeSets(c, { analyte_id: analyteId(r), status: obj(r.query)['status'] }))),
  createReferenceRangeSetDraft: bind(async (s, c, r) => ({ status: 201, body: await s.createReferenceRangeSetDraft(c, { analyte_id: analyteId(r), body: r.body }) })),
  getReferenceRangeSet: bind(async (s, c, r) => ok(await s.getReferenceRangeSet(c, { id: setId(r) }))),
  replaceReferenceRangeSetBands: bind(async (s, c, r) => ok(await s.replaceReferenceRangeSetBands(c, { id: setId(r), expectedVersion: ifMatch(r), body: r.body }))),
  publishReferenceRangeSet: bind(async (s, c, r) => ok(await s.publishReferenceRangeSet(c, { id: setId(r), expectedVersion: ifMatch(r), body: r.body })), true),
  retireReferenceRangeSet: bind(async (s, c, r) => ok(await s.retireReferenceRangeSet(c, { id: setId(r), expectedVersion: ifMatch(r), body: r.body })), true),
  discardReferenceRangeSetDraft: bind(async (s, c, r) => ok(await s.discardReferenceRangeSetDraft(c, { id: setId(r), expectedVersion: ifMatch(r) }))),

  listCriticalLimitSets: bind(async (s, c, r) => ok(await s.listCriticalLimitSets(c, { analyte_id: analyteId(r), status: obj(r.query)['status'] }))),
  createCriticalLimitSetDraft: bind(async (s, c, r) => ({ status: 201, body: await s.createCriticalLimitSetDraft(c, { analyte_id: analyteId(r), body: r.body }) })),
  getCriticalLimitSet: bind(async (s, c, r) => ok(await s.getCriticalLimitSet(c, { id: setId(r) }))),
  replaceCriticalLimitSetBands: bind(async (s, c, r) => ok(await s.replaceCriticalLimitSetBands(c, { id: setId(r), expectedVersion: ifMatch(r), body: r.body }))),
  publishCriticalLimitSet: bind(async (s, c, r) => ok(await s.publishCriticalLimitSet(c, { id: setId(r), expectedVersion: ifMatch(r), body: r.body })), true),
  retireCriticalLimitSet: bind(async (s, c, r) => ok(await s.retireCriticalLimitSet(c, { id: setId(r), expectedVersion: ifMatch(r), body: r.body })), true),
  discardCriticalLimitSetDraft: bind(async (s, c, r) => ok(await s.discardCriticalLimitSetDraft(c, { id: setId(r), expectedVersion: ifMatch(r) }))),
});
