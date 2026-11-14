// Shared request -> support service glue for the T21 platform handlers (02-TRD §5.10). Platform authz (PlatformAuthz) is the service's;
// this only fails closed without an authenticated platform request context and sets ETag "<version>" on single-session responses.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createSupportService, type PlatformCtx, type Result } from '../service/support.service.js';
import { obj } from './role.http.js';

type Svc = ReturnType<typeof createSupportService>;
const svc = createSupportService();

export function bindSupport(fn: (s: Svc, ctx: PlatformCtx, req: HandlerRequest) => Promise<Result>, o: { etag?: boolean } = {}): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<PlatformCtx>;
    if (typeof c?.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(svc, c as PlatformCtx, req);
    return { status: out.status, body: out.body, ...(o.etag && out.version !== undefined ? { headers: { etag: `"${out.version}"` } } : {}) };
  };
}
export const supportSessionId = (req: HandlerRequest) => obj(req.params)['support_session_id'];
