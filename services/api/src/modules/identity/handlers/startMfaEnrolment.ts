// POST /v1/identity/auth/mfa/enrolment (02-TRD §5.1; 01-PRD AC-A3.1; 03-APP-FLOW SS3; 08 A28.1). x-idempotency none (E1: the secret is
// shown once and stored nowhere: not in a write, a log line or a job). Session states mfa_enrolment_required (login) and active
// (voluntary, AC-A3.3); a user who already has a verified factor -> 409. Stale `unverified` factors are deleted at GoTrue and marked
// removed (re_enrol) before the new one is enrolled. Plumbing: verifyMfaChallenge.ts (mfaOperation = one ctx.db.identityAuthTx, D-212).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { GoTrueError } from '../gotrue/gateway.js';
import { bodyObject, gotrueCall, invalid, mfaOperation, wire } from './verifyMfaChallenge.js';

function parse(b: unknown): { friendlyName: string | undefined } {
  const { friendly_name: n } = bodyObject(b, ['friendly_name']);   // MfaEnrolmentStartRequest
  if (n !== undefined && (typeof n !== 'string' || n.length < 1 || n.length > 40)) throw invalid();
  return { friendlyName: n };
}

export const createStartMfaEnrolment = mfaOperation('startMfaEnrolment', (req) => parse(req.body), async (c, { friendlyName }) => {
  if (c.s.state !== 'mfa_enrolment_required' && c.s.state !== 'active') throw new LimsError('common.version_conflict');
  const own = await c.deps.repo.factors(c.tx, { tenantId: c.s.tenantId, userId: c.s.userId });
  if (own.some((f) => f.status === 'verified')) throw new LimsError('common.version_conflict');
  for (const f of own) {   // only `unverified` remain here
    // a GoTrue 404 = already deleted by an earlier attempt whose tx rolled back: treat as removed, else the user is locked out
    await gotrueCall(async () => {
      try { await c.deps.gotrue.adminDeleteFactor(c.s.userId, f.gotrueFactorId); } catch (e) { if (!(e instanceof GoTrueError && e.status === 404)) throw e; }
    });
    await c.deps.repo.removeFactor(c.tx, { id: f.id, tenantId: c.s.tenantId, userId: c.s.userId, reason: 're_enrol', at: c.now, actorId: c.actorId });
  }
  const enr = await gotrueCall(() => c.deps.gotrue.mfaEnrollTotp(c.load.accessToken, friendlyName));
  const id = c.newId();
  await c.deps.repo.insertFactor(c.tx, { id, tenantId: c.s.tenantId, userId: c.s.userId, gotrueFactorId: enr.factorId, friendlyName: friendlyName ?? null, actorId: c.actorId });
  return { status: 200 as const, body: { factor_id: id, otpauth_uri: enr.otpauthUri, secret_base32: enr.secret } };
});

export const startMfaEnrolment: Handler = wire(createStartMfaEnrolment);
