// Shared request -> platform-staff service glue for the T25 handlers (02-TRD §5.10). Platform authz is the service's; this only fails
// closed without an authenticated platform request context and sets ETag "<version>". Wires the repo, the platform_events writer and
// the GoTrue gateway (built on first use by gotrue/gateway.http.ts gotrueGatewayFromEnv).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import type { GoTrueGateway } from '../gotrue/gateway.js';
import { gotrueGatewayFromEnv } from '../gotrue/gateway.http.js';
import { createPlatformStaffRepo } from '../repository/platform-staff.repo.js';
import { createPlatformStaffService, type PlatformStaffCtx, type Result } from '../service/platform-staff.service.js';
import { obj } from './role.http.js';

type Svc = ReturnType<typeof createPlatformStaffService>;
const repo = createPlatformStaffRepo();
let gw: GoTrueGateway | undefined;
const gotrue: Pick<GoTrueGateway, 'adminCreateUser'> = {
  adminCreateUser: (i) => (gw ??= gotrueGatewayFromEnv()).adminCreateUser(i),
};
const svc = createPlatformStaffService({ repo, gotrue, platformEvents: { insert: (tx, e) => repo.insertPlatformEvent(tx, e) } });

export function bindPlatformStaff(fn: (s: Svc, ctx: PlatformStaffCtx, req: HandlerRequest) => Promise<Result>, o: { etag?: boolean } = {}): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<PlatformStaffCtx>;
    if (typeof c?.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(svc, c as PlatformStaffCtx, req);
    return { status: out.status, body: out.body, ...(o.etag && out.version !== undefined ? { headers: { etag: `"${out.version}"` } } : {}) };
  };
}
export const platformStaffId = (req: HandlerRequest) => obj(req.params)['platform_staff_id'];
/** PATCH / invite body (snake) -> camel; only keys present are forwarded; values are never coerced (the service validates). */
export function staffFields(body: unknown) {
  const b = obj(body);
  const map = { display_name: 'displayName', role_code: 'roleCode', allowed_cidrs: 'allowedCidrs' } as const;
  return Object.fromEntries(Object.entries(map).filter(([k]) => b[k] !== undefined).map(([k, v]) => [v, b[k]]));
}
