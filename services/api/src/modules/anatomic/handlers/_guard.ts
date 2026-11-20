// SEC-AUTHZ-7 (LD-189 AUTH-SENSITIVE, LD-261; SEC-AUTHZ-1.1): handler-level baseline guard, same shape as billing/handlers/_guard.ts (SEC-AUTHZ-6).
// Asks IdentityPort.assertRole for the operation's contract x-permission (no centre) BEFORE the service loads or writes anything. The service keeps its own centre-scoped
// assertRole after the row is loaded. The error is whatever assertRole throws (auth.forbidden | auth.mfa_required | identity.support_session_required); no new error code.
// Fails closed without the port (auth.unauthenticated).
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
