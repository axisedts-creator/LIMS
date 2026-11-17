// Shared request -> IRD service glue for the T23 platform handlers (02-TRD §5.10). PlatformAuthz is the service's; this only fails closed
// without an authenticated platform request context, forwards service headers unchanged (download) and sets ETag "<version>" when asked.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createIrdService, type IrdCtx, type Result } from '../service/ird.service.js';
import { obj } from './role.http.js';

export { ifMatch, obj } from './role.http.js';

type Svc = ReturnType<typeof createIrdService>;
const svc = createIrdService();

export function bindIrd(fn: (s: Svc, ctx: IrdCtx, req: HandlerRequest) => Promise<Result>, o: { etag?: boolean } = {}): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<IrdCtx>;
    if (typeof c?.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(svc, c as IrdCtx, req);
    const headers = { ...(out.headers ?? {}), ...(o.etag && out.version !== undefined ? { etag: `"${out.version}"` } : {}) };
    return { status: out.status, body: out.body, ...(Object.keys(headers).length ? { headers } : {}) };
  };
}
export const recordId = (req: HandlerRequest) => obj(req.params)['record_id'];
