// Shared request -> tenant-access service glue for the T17 handlers (02-TRD §5). Schema, x-permission, aal2, tier and Idempotency-Key are the
// core pipeline's. Fails closed without an authenticated tenant staff context; tenant, caller and current session come from that context only.
// Single support-session responses carry ETag "<version>".
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createAuthEventsRepo } from '../repository/auth-events.repo.js';
import { createTenantAccessRepo } from '../repository/tenant-access.repo.js';
import { createTenantAccessService, type Result, type TenantCtx } from '../service/tenant-access.service.js';
import { obj } from './role.http.js';

type Svc = ReturnType<typeof createTenantAccessService>;
let svc: Svc | undefined;

export function bindTenantAccess(fn: (s: Svc, ctx: TenantCtx, req: HandlerRequest) => Promise<Result>, o: { etag?: boolean; currentSession?: boolean } = {}): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<TenantCtx>;
    if (typeof c?.tenantId !== 'string' || c.actor?.type !== 'user' || typeof c.actor.id !== 'string' || !c.tx
      || (o.currentSession && (typeof c.sessionId !== 'string' || !c.sessionId))) throw new LimsError('auth.unauthenticated');
    svc ??= createTenantAccessService({ repo: createTenantAccessRepo(), events: createAuthEventsRepo() });
    const out = await fn(svc, c as TenantCtx, req);
    return {
      status: out.status, ...(out.body === undefined ? {} : { body: out.body }),
      ...(o.etag && out.version !== undefined ? { headers: { etag: `"${out.version}"` } } : {}),
    };
  };
}
export const param = (req: HandlerRequest, name: string) => obj(req.params)[name];
export const query = (req: HandlerRequest) => obj(req.query);
