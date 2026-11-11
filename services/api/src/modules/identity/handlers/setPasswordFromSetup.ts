// POST set password from a password_setup session (03-APP-FLOW §3.7, SS8, M2; 01-PRD AC-A7.3, AC-A8.1, AC-A6.1-3; 07-SECURITY AU-T4/T11/T21;
// 08 A25 D-212/P-61). One identityAuthTx: DEFINER lookup of sha256(cookie token) -> bindTenant(session tenant) once -> row lock + expiry ->
// policy (12 code points, <= 72 bytes, local breached list) BEFORE GoTrue -> adminUpdatePassword -> M2 invitation accept -> SS8 state
// (MFA rule as login) -> other sessions revoked (password_change, one sign-out job each) -> failure counter cleared -> event.
// Any failure throws with nothing kept (no commitOnError): the tx rolls back.
import { createHash } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import type { Tx, TxFn, TxInput } from '../../../core/db/tx.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { evaluatePassword } from '../domain/password-policy.js';
import type { GoTrueGateway } from '../gotrue/gateway.js';
import { createAuthEventsRepo, type AuthEvent } from '../repository/auth-events.repo.js';
import { createBreachedRepo } from '../repository/breached.repo.js';
import { createMfaRepo, type MfaRepo, type SessionRef } from '../repository/mfa.repo.js';
import type { AuthLimits } from '../service/auth.service.js';
import { createAuthLimits } from './loginStaff.js';
import { bodyObject, envHmac, gotrueCall, gw, invalid, sessionToken } from './verifyMfaChallenge.js';

export interface SetPasswordDeps {
  gotrue: Pick<GoTrueGateway, 'adminUpdatePassword'>;
  repo: Pick<MfaRepo, 'sessionByToken' | 'loadSession' | 'updateSession' | 'loginContext' | 'revokeOtherSessions' | 'acceptInvitation' | 'enqueue'>;
  events: { recordTenantless(tx: Tx, e: AuthEvent): Promise<void>; recordTenant(tx: Tx, e: AuthEvent): Promise<void> };
  limits: Pick<AuthLimits, 'consumeAttempt' | 'clearAccountFailures'>;
  breached: { isBreached(tx: Tx, sha1: Buffer): Promise<boolean> };
  hmac?: (normalisedEmail: string) => string; newId?: () => string; now?: () => Date;
}
interface Hctx extends HandlerContext {
  requestId: string; bffKey?: string; actor?: { type: string; id: string };
  db: { identityAuthTx<T>(input: TxInput, fn: TxFn<T>): Promise<T> };
}

const OPERATION = Object.freeze({ module: 'identity', operationId: 'setPasswordFromSetup', context: 'identity_auth' });
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const PASSWORD_MAX = 128;   // PasswordSetRequest
const STAFF_KINDS = new Set(['tenant_staff', 'platform']);
const expired = () => new LimsError('auth.session_expired');

export function createSetPasswordFromSetup(deps: SetPasswordDeps) {
  const hmac = deps.hmac ?? envHmac;
  const newId = deps.newId ?? uuidv7;
  const clock = deps.now ?? (() => new Date());
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const ctx = hctx as Hctx;
    const { new_password: pw } = bodyObject(req.body, ['new_password']);
    if (typeof pw !== 'string' || pw.length < 1 || pw.length > PASSWORD_MAX) throw invalid();
    const actorId = ctx.actor?.id;
    if (typeof actorId !== 'string' || !actorId) throw new LimsError('common.internal');
    const token = sessionToken(req);
    if (!token || !TOKEN_RE.test(token) || ctx.bffKey !== 'staff_web') throw expired();
    const ua = (req.headers as Record<string, unknown> | undefined)?.['user-agent'];
    const userAgent = typeof ua === 'string' ? ua : undefined;

    return ctx.db.identityAuthTx({ operation: OPERATION, requestId: ctx.requestId, clientIp: ctx.clientIp, userAgent }, async (tx, ctl) => {
      ctl.noRetry();   // the GoTrue password update is not replayable
      const s = await deps.repo.sessionByToken(tx, createHash('sha256').update(token).digest());
      if (!s || s.tokenReused || !STAFF_KINDS.has(s.kind)) throw expired();
      if (s.kind === 'platform' ? s.tenantId !== null || !s.platformStaffId : !s.tenantId || !s.membershipId) throw expired();
      if (s.kind !== 'platform') {
        if (!tx.bindTenant) throw new LimsError('common.internal');
        await tx.bindTenant(s.tenantId!);   // D-212: tenant from the session row, never from the request
      }
      if (s.state !== 'password_setup') throw new LimsError('common.version_conflict');   // SS8 only from password_setup
      const ref: SessionRef = { sessionId: s.sessionId, tenantId: s.tenantId, userId: s.userId, kind: s.kind };
      const load = await deps.repo.loadSession(tx, ref);   // FOR UPDATE: a parallel set-password waits here
      const now = clock();
      if (!load || (load.state !== undefined && load.state !== 'password_setup')
        || load.idleExpiresAt.getTime() <= now.getTime() || load.absoluteExpiresAt.getTime() <= now.getTime()) throw expired();
      const accountKey = hmac(load.email.trim().normalize('NFC').toLowerCase());
      await deps.limits.consumeAttempt(accountKey);   // x-rate-limit-tier login

      // AU-T4: policy before GoTrue; breached lookup only for a policy-valid password; a lookup error fails closed
      const verdict = await evaluatePassword(pw, { isBreached: (sha1) => deps.breached.isBreached(tx, sha1) });
      if (!verdict.ok) throw new LimsError(verdict.code);
      await gotrueCall(() => deps.gotrue.adminUpdatePassword(s.userId, pw));

      const row: Record<string, any> = (await deps.repo.loginContext(tx, s.userId)) ?? {};
      const accepted = await deps.repo.acceptInvitation(tx, { tenantId: s.tenantId, membershipId: s.membershipId, userId: s.userId, at: now, actorId });
      // SS8 = SS3/SS4 MFA rule: a verified factor -> mfa_pending; platform always needs MFA (08 A28.1); else tenant role rule
      const state = row['has_verified_factor'] === true ? 'mfa_pending'
        : s.kind === 'platform' || row['mfa_required'] === true ? 'mfa_enrolment_required' : 'active';
      await deps.repo.updateSession(tx, ref, { state, actorId });
      const revoked = await deps.repo.revokeOtherSessions(tx, { tenantId: s.tenantId, userId: s.userId, exceptSessionId: s.sessionId, reason: 'password_change', actorId });
      // 02-TRD §10: per session, tenant kinds only. LD-99 / 08 A38-2: no identity.gotrue_signout for platform (adminSignOutUser would
      // kill the live setup session's GoTrue tokens); the LIMS revocation above suffices (REQ-SEC-065).
      if (s.kind !== 'platform') for (const o of revoked) {
        await deps.repo.enqueue(tx, 'identity.gotrue_signout', { user_id: s.userId, tenant_id: s.tenantId, session_id: o.sessionId },
          `signout:${o.sessionId}:password_change`);
      }
      await deps.limits.clearAccountFailures(accountKey);
      const e: AuthEvent = { id: newId(), eventType: accepted ? 'invite_accepted' : 'password_reset_completed', userId: s.userId, sessionId: s.sessionId,
        emailHmacHex: accountKey, clientIp: ctx.clientIp, userAgent, requestId: ctx.requestId, actorId };
      if (s.kind === 'platform') await deps.events.recordTenantless(tx, { ...e, platformStaffId: s.platformStaffId! });
      else await deps.events.recordTenant(tx, { ...e, tenantId: s.tenantId!, membershipId: s.membershipId! });

      // [CONV] the session keeps its 15-min password_setup expiry (spec silent; .orchestra/cr/T9.md)
      return {
        status: 200 as const,
        body: { session_id: s.sessionId, kind: s.kind, state, aal: load.aal, idle_expires_at: load.idleExpiresAt.toISOString(),
          absolute_expires_at: load.absoluteExpiresAt.toISOString() },
      };
    });
  };
}

let wiredRepo: MfaRepo | undefined;
const events = createAuthEventsRepo();
const breached = createBreachedRepo();
const gotrue: SetPasswordDeps['gotrue'] = { adminUpdatePassword: (u, p) => gw().adminUpdatePassword(u, p) };
export const setPasswordFromSetup: Handler = (async (req: HandlerRequest, hctx: HandlerContext) =>
  createSetPasswordFromSetup({ gotrue, repo: (wiredRepo ??= createMfaRepo()), events, breached,
    limits: createAuthLimits((hctx as { rateLimit?: Parameters<typeof createAuthLimits>[0] }).rateLimit) })(req, hctx)) as Handler;
