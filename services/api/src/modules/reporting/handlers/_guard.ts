// SEC-AUTHZ-7 (LD-189 AUTH-SENSITIVE, LD-261; SEC-AUTHZ-1.1): handler-level guard, same shape as billing/handlers/_guard.ts (SEC-AUTHZ-6) and catalog/handlers/_guard.ts (SEC-AUTHZ-5).
// Asks IdentityPort.assertRole for the operation's contract x-permission BEFORE the wrapped handler reads, writes, opens a transaction, events or storage, or checks the
// Idempotency-Key / If-Match. The error is whatever assertRole throws (auth.forbidden | auth.mfa_required | identity.support_session_required); no new error code.
// Fails closed without the port (auth.unauthenticated). Later centre-scoped or authority checks (release second step, narrative sign, conditional lab.specimen.read) stay in the services.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';

type Port = { assertRole?: (ctx: unknown, req: { permission: string }) => Promise<unknown> };

export function guarded(permission: string, handler: Handler): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const port = (hctx as unknown as { ports?: { IdentityPort?: Port } }).ports?.IdentityPort;
    if (typeof port?.assertRole !== 'function') throw new LimsError('auth.unauthenticated'); // fail closed: no guard, no handler
    await port.assertRole(hctx, { permission });
    return handler(req, hctx);
  };
}
