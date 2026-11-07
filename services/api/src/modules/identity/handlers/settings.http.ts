// Shared request -> settings service glue for the T16 handlers (02-TRD §5.6). Schema, x-permission, multipart and Idempotency-Key are the core
// pipeline's; this fails closed without an authenticated request context, forwards service headers unchanged and adds ETag "<version>" when asked.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createSettingsService, type Result, type SettingsCtx } from '../service/settings.service.js';

export { ifMatch, obj } from './role.http.js';

type Svc = ReturnType<typeof createSettingsService>;
const svc = createSettingsService();

export function bindSettings(fn: (s: Svc, ctx: SettingsCtx, req: HandlerRequest) => Promise<Result>, o: { etag?: boolean } = {}): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<SettingsCtx>;
    if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(svc, c as SettingsCtx, req);
    const headers = { ...(out.headers ?? {}), ...(o.etag && out.version !== undefined ? { etag: `"${out.version}"` } : {}) };
    return { status: out.status, body: out.body, ...(Object.keys(headers).length ? { headers } : {}) };
  };
}
