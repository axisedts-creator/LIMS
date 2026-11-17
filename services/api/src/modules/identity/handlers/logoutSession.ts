// POST /v1/identity/auth/session/logout (T8; 02-TRD s5.1; 03-APP-FLOW s3.6; 01-PRD AC-A5.1). BFF-only, x-context identity_auth.
// 204 = the BFF clears the cookie. The row is revoked (logout) in-request; GoTrue sign-out is the identity.gotrue_signout job.
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createSessionService, type SessionDeps } from '../service/session.service.js';
import { sessionCall, wireSession } from './resolveSession.js';

export const createLogoutSession = (deps: SessionDeps) => {
  const svc = createSessionService(deps);
  return async (req: HandlerRequest, hctx: HandlerContext) => svc.logout(sessionCall('logoutSession', req, hctx));
};

export const logoutSession: Handler = wireSession(createLogoutSession);
