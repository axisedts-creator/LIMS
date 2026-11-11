// POST /v1/identity/mobile/sessions/logout (T31; 02-TRD s5.1; 08 R10). Public app route, x-context identity_auth. kind staff_mobile
// only: 204, row revoked (logout), GoTrue sign-out as the identity.gotrue_signout job; a repeat is a no-op, unknown token -> 401.
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createSessionService, type SessionDeps } from '../service/session.service.js';
import { mobileToken } from './refreshMobileSession.js';
import { sessionCall, wireSession } from './resolveSession.js';

export const createLogoutMobileSession = (deps: SessionDeps) => {
  const svc = createSessionService(deps);
  return async (req: HandlerRequest, hctx: HandlerContext) => svc.logoutMobile(sessionCall('logoutMobileSession', req, hctx, mobileToken(req.body)));
};

export const logoutMobileSession: Handler = wireSession(createLogoutMobileSession);
