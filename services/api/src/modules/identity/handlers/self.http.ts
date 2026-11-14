// Shared request -> self service glue for the T10 /me handlers (02-TRD §5.2). Schema, x-permission identity.self.manage, tier and
// Idempotency-Key are the core pipeline's. Fails closed without an authenticated staff / partner request context that names the caller's
// current session; tenant, user and session come from that context only (never from params / query / body / headers).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createAuthEventsRepo } from '../repository/auth-events.repo.js';
import { createBreachedRepo } from '../repository/breached.repo.js';
import { createSelfRepo } from '../repository/self.repo.js';
import { createSelfService, type Result, type SelfCtx, type SelfDeps } from '../service/self.service.js';
import { gw } from './verifyMfaChallenge.js';

type Svc = ReturnType<typeof createSelfService>;
const gotrue: NonNullable<SelfDeps['gotrue']> = {
  signInWithPassword: (e, p) => gw().signInWithPassword(e, p),
  signOut: (t, s) => gw().signOut(t, s),
  adminUpdatePassword: (u, p) => gw().adminUpdatePassword(u, p),
  adminDeleteFactor: (u, f) => gw().adminDeleteFactor(u, f),
};
let svc: Svc | undefined;

export const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : {});

export function bindSelf(fn: (s: Svc, ctx: SelfCtx, req: HandlerRequest) => Promise<Result>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<SelfCtx>;
    if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || (c.actor.type !== 'user' && c.actor.type !== 'partner')
      || typeof c.sessionId !== 'string' || !c.sessionId || !c.tx) throw new LimsError('auth.unauthenticated');
    svc ??= createSelfService({ repo: createSelfRepo(), gotrue, breached: createBreachedRepo(), events: createAuthEventsRepo() });
    const out = await fn(svc, c as SelfCtx, req);
    return out.body === undefined ? { status: out.status } : { status: out.status, body: out.body };
  };
}
