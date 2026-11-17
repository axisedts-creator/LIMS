// Shared request -> org service glue for the T15 branch/centre handlers (02-TRD §5.5). Schema, x-permission and Idempotency-Key are the core
// pipeline's; this fails closed without an authenticated request context and sets ETag "<version>" on single-resource responses.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createOrgService, type OrgCtx, type Result } from '../service/org.service.js';
import { obj } from './role.http.js';

export { ifMatch } from './role.http.js';

type Svc = ReturnType<typeof createOrgService>;
const svc = createOrgService();

export function bindOrg(fn: (s: Svc, ctx: OrgCtx, req: HandlerRequest) => Promise<Result>, o: { etag?: boolean } = {}): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<OrgCtx>;
    if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(svc, c as OrgCtx, req);
    return { status: out.status, body: out.body, ...(o.etag && out.version !== undefined ? { headers: { etag: `"${out.version}"` } } : {}) };
  };
}

/** snake_case body/query keys -> camelCase input; only the listed keys, only when present (mass assignment). */
export function pick(src: unknown, keys: Record<string, string>): Record<string, unknown> {
  const b = obj(src);
  return Object.fromEntries(Object.entries(keys).filter(([k]) => b[k] !== undefined).map(([k, to]) => [to, b[k]]));
}
/** Query booleans arrive as strings; anything else is passed through for the service to reject. */
export const qbool = (v: unknown) => (v === 'true' ? true : v === 'false' ? false : v);
export const listQuery = (req: HandlerRequest, keys: Record<string, string>) => {
  const q = pick(req.query, keys);
  if ('isActive' in q) q['isActive'] = qbool(q['isActive']);
  return q;
};

export const BRANCH_FIELDS = { code: 'code', name: 'name', address_text: 'addressText', phone: 'phone', is_processing_lab: 'isProcessingLab' };
export const BRANCH_PATCH = { name: 'name', address_text: 'addressText', phone: 'phone', is_processing_lab: 'isProcessingLab', unset: 'unset' };
export const CENTRE_FIELDS = { code: 'code', name: 'name', branch_id: 'branchId', kind: 'kind', address_text: 'addressText', phone: 'phone' };
export const CENTRE_PATCH = { name: 'name', branch_id: 'branchId', kind: 'kind', address_text: 'addressText', phone: 'phone', unset: 'unset' };
export const branchId = (req: HandlerRequest) => obj(req.params)['branch_id'];
export const centreId = (req: HandlerRequest) => obj(req.params)['centre_id'];
