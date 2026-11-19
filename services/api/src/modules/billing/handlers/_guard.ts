// SEC-AUTHZ-6 (LD-189 AUTH-SENSITIVE, LD-261; SEC-AUTHZ-1.1): handler-level guard, same shape as catalog/handlers/_guard.ts (SEC-AUTHZ-5). Asks
// IdentityPort.assertRole for the operation's contract x-permission BEFORE the wrapped handler reads, writes, opens the events port or checks the
// Idempotency-Key / If-Match. The error is whatever assertRole throws (auth.forbidden | auth.mfa_required | identity.support_session_required); no new
// error code. Fails closed without the port with auth.unauthenticated (the billing convention of every bind() in this folder). The later R2 authority
// rules (second person, ceilings, privileged aal2) stay in the services and still run after this floor.
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
