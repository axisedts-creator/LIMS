// #67–#70 credit-party handlers (02-TRD §5 rows 67–70). Schema, auth, x-permission and Idempotency-Key are the core pipeline's;
// these map request -> creditParties.service and fail closed without an authenticated context or IdentityPort (pan / contacts / address are decided by it, REQ-SEC-081).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createCreditPartiesService, type CreditPartiesDeps } from '../service/creditParties.service.js';
import type { Ctx } from '../service/masters.service.js';

type Svc = ReturnType<typeof createCreditPartiesService>;
type RCtx = Ctx & { events?: CreditPartiesDeps['events']; ports?: { IdentityPort?: CreditPartiesDeps['identity'] } };
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
    return run(createCreditPartiesService({ events: c.events, identity }), c as Ctx, req);
  };
}
const id = (req: HandlerRequest) => obj(req.params)['credit_party_id'];

export const creditPartiesHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listCreditParties: bind(async (s, ctx, req) => ({ status: 200, body: await s.listCreditParties(ctx, req.query) })),
  createCreditParty: bind(async (s, ctx, req) => ({ status: 201, body: await s.createCreditParty(ctx, req.body) })),
  getCreditParty: bind(async (s, ctx, req) => ({ status: 200, body: await s.getCreditParty(ctx, { id: id(req) }) })),
  updateCreditParty: bind(async (s, ctx, req) => ({ status: 200, body: await s.updateCreditParty(ctx, { id: id(req), expectedVersion: ifMatch(req), patch: req.body }) })),
});
