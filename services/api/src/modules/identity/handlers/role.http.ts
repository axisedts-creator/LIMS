// Shared request -> role service glue for the T14 handlers (02-TRD §5.4). Schema, x-permission (+aal2) and Idempotency-Key are the core
// pipeline's; this fails closed without an authenticated request context and sets ETag "<version>" on single-role responses.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createRoleService, type Result, type RoleCtx } from '../service/role.service.js';

type Svc = ReturnType<typeof createRoleService>;
const svc = createRoleService();

export const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : {});

export function bindRole(fn: (s: Svc, ctx: RoleCtx, req: HandlerRequest) => Promise<Result>, o: { etag?: boolean } = {}): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<RoleCtx>;
    if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(svc, c as RoleCtx, req);
    return { status: out.status, body: out.body, ...(o.etag && out.version !== undefined ? { headers: { etag: `"${out.version}"` } } : {}) };
  };
}

/** If-Match "<version>" (02-CV §4.2): absent -> undefined (service answers 428); malformed -> 0 (service answers 400). */
export function ifMatch(req: HandlerRequest): number | undefined {
  const h = obj(req.headers)['if-match'];
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  const v = m ? Number(m[1]) : 0;
  return v <= 2147483647 ? v : 0;
}

/** Only the RoleCreateRequest / RoleUpdateRequest fields are forwarded (mass assignment). */
export function roleFields(body: unknown) {
  const b = obj(body);
  return {
    name: b['name'], ...(b['description'] === undefined ? {} : { description: b['description'] }),
    permissionCodes: b['permission_codes'], mfaRequired: b['mfa_required'],
  };
}
export const roleId = (req: HandlerRequest) => obj(req.params)['role_id'];
