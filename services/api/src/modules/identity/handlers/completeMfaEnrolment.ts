// POST /v1/identity/auth/mfa/enrolment/{factor_id}/verify (02-TRD §5.1; 01-PRD AC-A3.2/A3.3; 03-APP-FLOW SS7; 07-SECURITY AU-T22;
// 08 A19 P-42, A25 D-215). factor_id = the mirror row id from startMfaEnrolment; a factor that is not the session user's own
// `unverified` row -> 404 (no oracle). Wrong code: same counter / revoke rules as verifyMfaChallenge (failCode). Success: factor
// verified, session active at aal2, mfa_enrolled; login_succeeded only when this completed a login (not a voluntary enrolment);
// platform staff also write platform_events platform_mfa_enrolled. Plumbing: verifyMfaChallenge.ts (mfaOperation = one ctx.db.identityAuthTx, D-212).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerRequest } from '../../../core/module.js';
import { activate, checkCode, invalid, loginSucceeded, mfaOperation, parseCode, sessionState, UUID_RE, wire } from './verifyMfaChallenge.js';

function parse(req: HandlerRequest): { factorId: string; code: string } {
  const factorId = (req.params as Record<string, unknown> | undefined)?.['factor_id'];
  if (typeof factorId !== 'string' || !UUID_RE.test(factorId)) throw invalid();
  return { factorId: factorId.toLowerCase(), code: parseCode(req.body) };
}

export const createCompleteMfaEnrolment = mfaOperation('completeMfaEnrolment', parse, async (c, { factorId, code }) => {
  const wasLogin = c.s.state === 'mfa_enrolment_required';
  if (!wasLogin && c.s.state !== 'active') throw new LimsError('common.not_found');   // OpenAPI declares no 409; same as an unusable factor
  const f = (await c.deps.repo.factors(c.tx, { tenantId: c.s.tenantId, userId: c.s.userId }))
    .find((x) => x.id.toLowerCase() === factorId && x.status === 'unverified');
  if (!f) throw new LimsError('common.not_found');
  const t = await checkCode(c, f.gotrueFactorId, code, 'enrol');
  await c.deps.repo.markFactorVerified(c.tx, { id: f.id, tenantId: c.s.tenantId, userId: c.s.userId, at: c.now, actorId: c.actorId });
  await activate(c, t);
  await c.record(c.ev('mfa_enrolled'));
  if (c.s.kind === 'platform') {
    await c.deps.repo.recordPlatformEvent(c.tx, { id: c.newId(), eventType: 'platform_mfa_enrolled', targetType: 'platform_staff', targetId: c.s.platformStaffId!,
      actorPlatformStaffId: c.s.platformStaffId!, detail: { factor_id: f.id }, requestId: c.requestId, clientIp: c.clientIp, actorId: c.actorId });
  }
  if (wasLogin) await loginSucceeded(c);
  return sessionState(c);
});

export const completeMfaEnrolment: Handler = wire(createCompleteMfaEnrolment);
