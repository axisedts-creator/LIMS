// POST /v1/identity/auth/patient/session/logout (T31; 02-TRD s5.1; 08 R10; LD-81). Public app route, x-context identity_auth.
// kind patient only; token from X-Lims-Patient-Session. 204, row revoked (logout); NO GoTrue sign-out (the patient kind has none).
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createSessionService, type SessionDeps } from '../service/session.service.js';
import { patientToken } from './resolvePatientSession.js';
import { sessionCall, wireSession } from './resolveSession.js';

export const createLogoutPatientSession = (deps: SessionDeps) => {
  const svc = createSessionService(deps);
  return async (req: HandlerRequest, hctx: HandlerContext) => svc.logoutPatient(sessionCall('logoutPatientSession', req, hctx, patientToken(req)));
};

export const logoutPatientSession: Handler = wireSession(createLogoutPatientSession);
