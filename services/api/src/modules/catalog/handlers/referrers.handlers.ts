// #60–#66 doctors handlers (02-TRD §5 rows 60–66). Schema, auth, x-permission and Idempotency-Key are the core pipeline's;
// these map request -> referrers.service and fail closed without an authenticated context or IdentityPort (contacts are decided by it, REQ-SEC-081).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createReferrersService, type ReferrersDeps } from '../service/referrers.service.js';
import type { Ctx } from '../service/masters.service.js';

type Svc = ReturnType<typeof createReferrersService>;
type RCtx = Ctx & { events?: ReferrersDeps['events']; ports?: { IdentityPort?: ReferrersDeps['identity'] } };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

/** If-Match: "<version>" (02-CV §4.2). Absent -> undefined (428 from the service); malformed -> 0 (400 from the service). */
function ifMatch(req: HandlerRequest): number | undefined {
  const h = obj(req.headers)['if-match'];
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  return m ? Number(m[1]) : 0;
}

function bind(run: (s: Svc, ctx: Ctx, req: HandlerRequest) => Promise<{ status: number; body: unknown }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<RCtx>;
    const identity = c.ports?.IdentityPort;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || !c.events || !identity) throw new LimsError('auth.unauthenticated');
    return run(createReferrersService({ events: c.events, identity }), c as Ctx, req);
  };
}
const id = (req: HandlerRequest) => obj(req.params)['doctor_id'];

export const referrersHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  searchDoctors: bind(async (s, ctx, req) => ({ status: 200, body: await s.searchDoctors(ctx, req.body) })),
  listDoctors: bind(async (s, ctx, req) => ({ status: 200, body: await s.listDoctors(ctx, req.query) })),
  createDoctor: bind(async (s, ctx, req) => ({ status: 201, body: await s.createDoctor(ctx, req.body) })),
  getDoctor: bind(async (s, ctx, req) => ({ status: 200, body: await s.getDoctor(ctx, { id: id(req) }) })),
  updateDoctor: bind(async (s, ctx, req) => ({ status: 200, body: await s.updateDoctor(ctx, { id: id(req), expectedVersion: ifMatch(req), patch: req.body }) })),
  verifyDoctor: bind(async (s, ctx, req) => ({ status: 200, body: await s.verifyDoctor(ctx, { id: id(req), expectedVersion: ifMatch(req) }) })),
  mergeDoctor: bind(async (s, ctx, req) => ({ status: 200, body: await s.mergeDoctor(ctx, { id: id(req), expectedVersion: ifMatch(req), body: req.body }) })),
});
