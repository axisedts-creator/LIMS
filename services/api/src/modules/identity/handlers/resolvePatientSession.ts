// POST /v1/identity/auth/patient/session/resolve (T31; 02-TRD s5.1; 03-APP-FLOW s3.5a; 07-SECURITY AU-T13, AU-T16; LD-81).
// Public app route, x-context identity_auth. kind patient only. Token ONLY from the X-Lims-Patient-Session header (never a cookie
// or the body); body SessionResolveRequest { touch }. LD-81: no GoTrue call; LIMS mints the 1 h access JWT (mintPatientAccessToken).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createSessionService, type SessionDeps } from '../service/session.service.js';
import { TOKEN_RE, sessionCall, wireSession } from './resolveSession.js';
import { bodyObject, invalid } from './verifyMfaChallenge.js';

/** E-9: a missing / malformed header looks like any other dead session */
export function patientToken(req: HandlerRequest): string {
  const v = (req.headers as Record<string, unknown> | undefined)?.['x-lims-patient-session'];
  if (typeof v !== 'string' || !TOKEN_RE.test(v)) throw new LimsError('auth.session_expired');
  return v;
}

export const createResolvePatientSession = (deps: SessionDeps) => {
  const svc = createSessionService(deps);
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const { touch } = bodyObject(req.body, ['touch']);
    if (typeof touch !== 'boolean') throw invalid();
    return svc.resolvePatient(sessionCall('resolvePatientSession', req, hctx, patientToken(req)), touch);
  };
};

// LD-81 signer (EdDSA, kid pat-YYYY-MM, iss urn:lims:identity:patient, aud urn:lims:api:patient, key LIMS_IDENTITY_PATIENT_JWT_KEY_FILE).
// [CONV] fails closed until the kid source is ruled (.orchestra/cr/T31.md): an unsigned or mis-kid'd token would be rejected by core anyway.
const mintPatientAccessToken = (): string => { throw new LimsError('common.internal', 'identity: patient JWT signer not wired'); };

export const resolvePatientSession: Handler = wireSession(createResolvePatientSession, { mintPatientAccessToken });
