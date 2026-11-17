// E10 getMyAccount, E11 updateMyAccount, E12 deleteMyAccount (02-TRD §5). Order: fail closed without request context -> IdentityPort.assertRole (before any query) -> service.
// The Account body is PII-adjacent: never cacheable.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createAccountService, type AccountCtx, type AccountService } from '../service/account.service.js';

type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };

function bind(permission: string, fn: (svc: AccountService, ctx: AccountCtx, req: HandlerRequest) => ReturnType<AccountService['get']>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<AccountCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    if (!c.ports?.IdentityPort || !c.ports.IdentityPort.assertRole) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await c.ports.IdentityPort.assertRole(hctx, { permission });
    const out = await fn(createAccountService(), c as AccountCtx, req);
    return out.status === 204 ? { status: 204 } : { status: out.status, body: out.body, headers: { 'cache-control': 'no-store' } };
  };
}

export const accountHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  getMyAccount: bind('engagement.self.read', (s, ctx) => s.get(ctx)),
  updateMyAccount: bind('engagement.self.manage', (s, ctx, req) => s.update(ctx, { headers: req.headers, body: req.body })),
  deleteMyAccount: bind('engagement.self.manage', (s, ctx, req) => s.remove(ctx, { headers: req.headers, body: req.body })),
});
