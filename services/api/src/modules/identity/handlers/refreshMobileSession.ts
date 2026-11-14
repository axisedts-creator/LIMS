// POST /v1/identity/mobile/sessions/refresh (T31; 02-TRD s5.1; 08 R10, A3.1 / CR-C2-018; 07-SECURITY AU-T13, AU-T15). Public app
// route, x-context identity_auth. kind staff_mobile only; rotates the opaque token, a rotated-out token revokes the session.
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createSessionService, type SessionDeps } from '../service/session.service.js';
import { TOKEN_RE, sessionCall, wireSession } from './resolveSession.js';
import { bodyObject, invalid } from './verifyMfaChallenge.js';

/** MobileSessionTokenRequest { session_token } (additionalProperties: false); malformed -> 400 before any DB work */
export function mobileToken(body: unknown): string {
  const { session_token: t } = bodyObject(body, ['session_token']);
  if (typeof t !== 'string' || !TOKEN_RE.test(t)) throw invalid();
  return t;
}

export const createRefreshMobileSession = (deps: SessionDeps) => {
  const svc = createSessionService(deps);
  return async (req: HandlerRequest, hctx: HandlerContext) => svc.refreshMobile(sessionCall('refreshMobileSession', req, hctx, mobileToken(req.body)));
};

export const refreshMobileSession: Handler = wireSession(createRefreshMobileSession);
