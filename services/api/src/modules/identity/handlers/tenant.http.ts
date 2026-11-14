// Shared request -> tenant service glue for the T22 platform handlers (02-TRD §5.10). Platform authz (PlatformAuthz) is the service's;
// this only fails closed without an authenticated platform request context, forwards only the contract fields (mass assignment) and sets
// ETag "<version>" on single-tenant responses. GoTrue + e-mail HMAC are wired exactly like the T13 user handlers (user.http.ts).
import { createHmac } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import type { GoTrueGateway } from '../gotrue/gateway.js';
import { gotrueGatewayFromEnv } from '../gotrue/gateway.http.js';
import type { PlatformCtx } from '../service/support.service.js';
import { createTenantService, type Result } from '../service/tenant.service.js';
import { obj } from './role.http.js';
import { pick } from './user.http.js';

type Svc = ReturnType<typeof createTenantService>;
let gw: GoTrueGateway | undefined;
const svc = createTenantService({
  gotrue: { adminCreateUser: (i) => (gw ??= gotrueGatewayFromEnv()).adminCreateUser(i) },
  emailHmac: (e) => {
    const key = process.env['LIMS_IDENTITY_EMAIL_HMAC_KEY'];
    if (!key) throw new LimsError('common.internal', 'identity: email HMAC key missing');
    return createHmac('sha256', key).update(e).digest();
  },
});

export function bindTenant(fn: (s: Svc, ctx: PlatformCtx, req: HandlerRequest) => Promise<Result>, o: { etag?: boolean } = {}): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<PlatformCtx>;
    if (typeof c?.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(svc, c as PlatformCtx, req);
    return { status: out.status, body: out.body, ...(o.etag && out.version !== undefined ? { headers: { etag: `"${out.version}"` } } : {}) };
  };
}
export const tenantId = (req: HandlerRequest) => {
  const v = obj(req.params)['tenant_id'];
  return typeof v === 'string' ? v : undefined;
};
export { pick };
