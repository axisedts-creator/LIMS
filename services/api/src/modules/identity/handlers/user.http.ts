// Shared request -> user service glue for the T13 handlers (02-TRD §5.3). Schema, x-permission (+aal2) and Idempotency-Key are the core
// pipeline's; this fails closed without an authenticated request context, forwards only the contract fields (mass assignment, AC-B1.5) and
// sets ETag "<version>" on single-user responses. Wires GoTrue (LIMS_IDENTITY_GOTRUE_URL / _SERVICE_KEY), the e-mail HMAC
// (LIMS_IDENTITY_EMAIL_HMAC_KEY, 08 A25 D-217) and the login failure counter (handlers/loginStaff.ts) on first use.
import { createHmac } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import type { GoTrueGateway } from '../gotrue/gateway.js';
import { gotrueGatewayFromEnv } from '../gotrue/gateway.http.js';
import { createAuthEventsRepo } from '../repository/auth-events.repo.js';
import { createUserService, type Result, type UserCtx } from '../service/user.service.js';
import { createAuthLimits } from './loginStaff.js';
import { ifMatch, obj } from './role.http.js';

type Svc = ReturnType<typeof createUserService>;
let gw: GoTrueGateway | undefined;
const hmacHex = (email: string) => {
  const key = process.env['LIMS_IDENTITY_EMAIL_HMAC_KEY'];
  if (!key) throw new LimsError('common.internal', 'identity: email HMAC key missing');
  return createHmac('sha256', key).update(email).digest('hex');
};
const limits = createAuthLimits(undefined);
const svc = createUserService({
  gotrue: { adminCreateUser: (i) => (gw ??= gotrueGatewayFromEnv()).adminCreateUser(i) },
  emailHmac: (e) => Buffer.from(hmacHex(e), 'hex'),
  clearAccountFailures: (e) => limits.clearAccountFailures(hmacHex(e)),
  events: createAuthEventsRepo(),
});

export function bindUser(fn: (s: Svc, ctx: UserCtx, req: HandlerRequest) => Promise<Result>, o: { etag?: boolean } = {}): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<UserCtx>;
    if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(svc, c as UserCtx, req);
    return { status: out.status, body: out.body, ...(o.etag && out.version !== undefined ? { headers: { etag: `"${out.version}"` } } : {}) };
  };
}

export const membershipId = (req: HandlerRequest) => obj(req.params)['membership_id'];
/** snake -> camel for the keys present in `src`; values are never coerced (the service validates). */
export function pick(src: unknown, map: Record<string, string>): Record<string, unknown> {
  const b = obj(src);
  return Object.fromEntries(Object.entries(map).filter(([k]) => b[k] !== undefined).map(([k, v]) => [v, b[k]]));
}
/** Versioned membership operation input: path id + If-Match + the given body fields. */
export const versioned = (req: HandlerRequest, map: Record<string, string> = {}) => ({ membershipId: membershipId(req), expectedVersion: ifMatch(req), ...pick(req.body, map) });
export const REASON = { reason_code: 'reasonCode', reason_text: 'reasonText' };
