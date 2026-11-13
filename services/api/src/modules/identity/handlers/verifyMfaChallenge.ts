// POST /v1/identity/auth/mfa/verify (02-TRD §5.1; 01-PRD AC-A2.1-3; 03-APP-FLOW SS5/SS6; 07-SECURITY AU-T3/T13/T21/T22; 08 A19 P-42,
// A25 D-212/P-61). x-context identity_auth: one ctx.db.identityAuthTx per request; the session comes only from the DEFINER
// app.identity_session_by_token(sha256(cookie token)); tx.bindTenant(session.tenant_id) once for tenant kinds; client IP = ctx.clientIp.
// A wrong code keeps its counter / event / revoke: ctx.commitOnError(), the 4xx is RETURNED out of the tx callback (COMMIT) and re-thrown.
// [CONV] The request plumbing shared by the three T7 handlers (mfaOperation, failCode, …) lives here: the plan lists no service file.
import { idMetrics } from '../metrics.js';
import { createHash, createHmac } from 'node:crypto';
import { LimsError, isLimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import type { Tx, TxFn, TxInput } from '../../../core/db/tx.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as core/errors.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { gotrueGatewayFromEnv } from '../gotrue/gateway.http.js';
import type { GoTrueGateway, GoTrueTokens } from '../gotrue/gateway.js';
import { createAuthEventsRepo, type AuthEvent } from '../repository/auth-events.repo.js';
import { createMfaRepo, type MfaRepo, type SessionRef } from '../repository/mfa.repo.js';
import type { AuthLimits } from '../service/auth.service.js';
import { createAuthLimits } from './loginStaff.js';

export interface MfaDeps {
  gotrue: Pick<GoTrueGateway, 'mfaChallengeAndVerify' | 'mfaEnrollTotp' | 'adminDeleteFactor'>;
  repo: Pick<MfaRepo, keyof MfaRepo>;
  events: { recordTenantless(tx: Tx, e: AuthEvent): Promise<void>; recordTenant(tx: Tx, e: AuthEvent): Promise<void> };
  limits: Pick<AuthLimits, 'consumeAttempt' | 'recordAccountFailure' | 'clearAccountFailures'>;
  hmac?: (normalisedEmail: string) => string; newId?: () => string; now?: () => Date;
}
interface MfaHctx extends HandlerContext {
  requestId: string; bffKey?: string; actor?: { type: string; id: string }; commitOnError?: () => void;
  rateLimit?: { consume(tier: 'login', key: string): Promise<void> };
  db: { identityAuthTx<T>(input: TxInput, fn: TxFn<T>): Promise<T> };
}
type Session = NonNullable<Awaited<ReturnType<MfaRepo['sessionByToken']>>>;
type Loaded = NonNullable<Awaited<ReturnType<MfaRepo['loadSession']>>>;
export interface MfaCtx {
  tx: Tx; deps: MfaDeps; s: Session; ref: SessionRef; load: Loaded; now: Date; requestId: string; clientIp: string; userAgent?: string | undefined;
  actorId: string; newId: () => string; accountKey: string; ev(eventType: string, o?: Partial<AuthEvent>): AuthEvent;
  record(e: AuthEvent): Promise<void>; deny(err: LimsError): never;
}

const COOKIE = '__Host-lims_sid';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^[0-9]{6}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MFA_FAILS = 5;   // sessions__mfa_attempts__ck 0..5; 03-APP-FLOW SS6
const STAFF_KINDS = new Set(['tenant_staff', 'platform']);

export const invalid = () => new LimsError('common.validation_failed');
const expired = () => new LimsError('auth.session_expired');

export function envHmac(email: string): string {
  const key = process.env['LIMS_IDENTITY_EMAIL_HMAC_KEY'];
  if (!key) throw new LimsError('common.internal', 'identity: email HMAC key missing');
  return createHmac('sha256', key).update(email).digest('hex');
}

/** request body that is a plain object with only `allowed` keys (additionalProperties: false) */
export function bodyObject(b: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid();
  const o = b as Record<string, unknown>;
  if (Object.keys(o).some((k) => !allowed.includes(k))) throw invalid();
  return o;
}
/** MfaCodeRequest */
export function parseCode(b: unknown): string {
  const { code } = bodyObject(b, ['code']);
  if (typeof code !== 'string' || !CODE_RE.test(code)) throw invalid();
  return code;
}

export function sessionToken(req: HandlerRequest): string | undefined {
  const raw = (req.headers as Record<string, unknown> | undefined)?.['cookie'];
  if (typeof raw !== 'string') return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** GoTrue call: an outage (non-LIMS error) is never a wrong code and never a 2xx. */
export async function gotrueCall<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { if (isLimsError(e)) throw e; throw new LimsError('common.dependency_unavailable'); }
}

/**
 * The common envelope of the three T7 operations: body already validated by the caller; cookie -> DEFINER lookup -> bindTenant ->
 * loadSession -> `run`. A LimsError thrown through ctx.deny() after commitOnError is returned out of the tx (P-42) and re-thrown.
 */
export function mfaOperation<B, R>(operationId: string, parse: (req: HandlerRequest) => B, run: (c: MfaCtx, input: B) => Promise<R>) {
  const operation = Object.freeze({ module: 'identity', operationId, context: 'identity_auth' });
  return (deps: MfaDeps) => async (req: HandlerRequest, hctx: HandlerContext): Promise<R> => {
    const ctx = hctx as MfaHctx;
    const input = parse(req);
    const actorId = ctx.actor?.id;
    if (typeof actorId !== 'string' || !actorId) throw new LimsError('common.internal');   // system actor = created_by of every write
    const token = sessionToken(req);
    // AU-T13: staff sessions serve the staff_web BFF only; E-9: malformed / unknown / revoked look identical
    if (!token || !TOKEN_RE.test(token) || ctx.bffKey !== 'staff_web') throw expired();
    const ua = (req.headers as Record<string, unknown> | undefined)?.['user-agent'];
    const userAgent = typeof ua === 'string' ? ua : undefined;
    const newId = deps.newId ?? uuidv7;
    const hmac = deps.hmac ?? envHmac;

    const out = await ctx.db.identityAuthTx({ operation, requestId: ctx.requestId, clientIp: ctx.clientIp, userAgent }, async (tx, ctl) => {
      ctl.noRetry();   // GoTrue MFA calls and limiter state are not replayable
      let keep = false;
      try {
        const s = await deps.repo.sessionByToken(tx, createHash('sha256').update(token).digest());
        // [CONV] a rotated-out token (CR-C2-018) is treated as unknown here; the reuse revoke belongs to resolveSession.
        if (!s || s.tokenReused || !STAFF_KINDS.has(s.kind)) throw expired();
        if (s.kind === 'platform' ? s.tenantId !== null || !s.platformStaffId : !s.tenantId || !s.membershipId) throw expired();
        if (s.kind !== 'platform') {
          if (!tx.bindTenant) throw new LimsError('common.internal');
          await tx.bindTenant(s.tenantId!);   // D-212: tenant from the session row, never from the request
        }
        const ref: SessionRef = { sessionId: s.sessionId, tenantId: s.tenantId, userId: s.userId, kind: s.kind };
        const load = await deps.repo.loadSession(tx, ref);
        const now = (deps.now ?? (() => new Date()))();
        if (!load || load.idleExpiresAt.getTime() <= now.getTime() || load.absoluteExpiresAt.getTime() <= now.getTime()) throw expired();
        const who: Partial<AuthEvent> = s.kind === 'platform'
          ? { userId: s.userId, platformStaffId: s.platformStaffId!, sessionId: s.sessionId }
          : { userId: s.userId, tenantId: s.tenantId!, membershipId: s.membershipId!, sessionId: s.sessionId };
        const accountKey = hmac(load.email);
        await deps.limits.consumeAttempt(accountKey);   // x-rate-limit-tier: login (LD-10, 02-CV §10.3): 429 before any GoTrue call / write
        const c: MfaCtx = {
          tx, deps, s, ref, load, now, requestId: ctx.requestId, clientIp: ctx.clientIp, userAgent, actorId, newId, accountKey,
          ev: (eventType, o = {}) => ({ id: newId(), eventType, ...who, emailHmacHex: accountKey, clientIp: ctx.clientIp, userAgent, requestId: ctx.requestId, actorId, ...o }),
          record: (e) => (s.kind === 'platform' ? deps.events.recordTenantless(tx, e) : deps.events.recordTenant(tx, e)),
          deny: (err) => { keep = true; ctx.commitOnError?.(); throw err; },
        };
        return { ok: await run(c, input) };
      } catch (err) { if (keep) return { err }; throw err; }
    });
    if ('err' in out) throw out.err;
    return out.ok;
  };
}

/** SS6: wrong code -> attempts +1, account failure, mfa_challenge_failed; the 5th revokes (mfa_failed) + session_revoked + sign-out job. All kept. */
export async function failCode(c: MfaCtx): Promise<never> {
  const attempts = Math.min(c.load.mfaFailedAttempts + 1, MAX_MFA_FAILS);
  await c.deps.limits.recordAccountFailure(c.accountKey);
  await c.record(c.ev('mfa_challenge_failed'));
  if (attempts >= MAX_MFA_FAILS) {
    await c.deps.repo.updateSession(c.tx, c.ref, { mfaFailedAttempts: attempts, revoked: { reason: 'mfa_failed' }, actorId: c.actorId });
    await c.record(c.ev('session_revoked', { reasonCode: 'mfa_failed' }));
    await c.deps.repo.enqueue(c.tx, 'identity.gotrue_signout', { user_id: c.s.userId, ...(c.s.tenantId ? { tenant_id: c.s.tenantId } : {}) },
      `signout:${c.s.userId}:mfa_failed`);
  } else {
    await c.deps.repo.updateSession(c.tx, c.ref, { mfaFailedAttempts: attempts, actorId: c.actorId });
  }
  return c.deny(new LimsError('auth.mfa_invalid'));
}

/** verify the code at GoTrue; wrong code -> failCode (throws). T28: lims_identity_mfa_verifications_total{outcome, flow} (outage not counted). */
export async function checkCode(c: MfaCtx, gotrueFactorId: string, code: string, flow: 'challenge' | 'enrol'): Promise<GoTrueTokens> {
  const r = await gotrueCall(() => c.deps.gotrue.mfaChallengeAndVerify(c.load.accessToken, gotrueFactorId, code));
  idMetrics.mfa(c, r.ok ? 'success' : 'failed', flow);
  if (!r.ok) return failCode(c);
  return r.tokens;
}

/** session raised to active / aal2 with the new GoTrue token pair; attempts reset */
export async function activate(c: MfaCtx, t: GoTrueTokens): Promise<void> {
  await c.deps.repo.updateSession(c.tx, c.ref, { state: 'active', aal: 'aal2', accessToken: t.accessToken, refreshToken: t.refreshToken,
    accessExpiresAt: new Date(t.expiresAt * 1000), mfaFailedAttempts: 0, actorId: c.actorId });
}

/** login completes (session was not yet active): membership last_login_at + login_succeeded; account failures cleared */
export async function loginSucceeded(c: MfaCtx): Promise<void> {
  if (c.s.kind !== 'platform') await c.deps.repo.touchMembershipLogin(c.tx, { tenantId: c.s.tenantId!, membershipId: c.s.membershipId!, at: c.now, actorId: c.actorId });
  await c.record(c.ev('login_succeeded'));
  await c.deps.limits.clearAccountFailures(c.accountKey);
}

// SessionState.actor (display_name, roles) has no source on this path: omitted, as in loginStaff (.orchestra/cr/T6.md).
export const sessionState = (c: MfaCtx) => ({
  status: 200 as const,
  body: { session_id: c.s.sessionId, kind: c.s.kind, state: 'active', aal: 'aal2',
    idle_expires_at: c.load.idleExpiresAt.toISOString(), absolute_expires_at: c.load.absoluteExpiresAt.toISOString() },
});

// ---------- wiring (shared by the three handlers) ----------
let gateway: GoTrueGateway | undefined;
export const gw = () => (gateway ??= gotrueGatewayFromEnv());
const wiredGotrue: MfaDeps['gotrue'] = {
  mfaChallengeAndVerify: (a, f, c) => gw().mfaChallengeAndVerify(a, f, c),
  mfaEnrollTotp: (a, n) => gw().mfaEnrollTotp(a, n),
  adminDeleteFactor: (u, f) => gw().adminDeleteFactor(u, f),
};
let wiredRepo: MfaRepo | undefined;
const wiredEvents = createAuthEventsRepo();
export function wire(factory: (deps: MfaDeps) => (req: HandlerRequest, hctx: HandlerContext) => Promise<unknown>): Handler {
  return (async (req: HandlerRequest, hctx: HandlerContext) => factory({
    gotrue: wiredGotrue, repo: (wiredRepo ??= createMfaRepo()), events: wiredEvents, limits: createAuthLimits((hctx as MfaHctx).rateLimit),
  })(req, hctx)) as Handler;
}

// ---------- verifyMfaChallenge ----------
export const createVerifyMfaChallenge = mfaOperation('verifyMfaChallenge', (req) => parseCode(req.body), async (c, code) => {
  if (c.s.state !== 'mfa_pending') throw new LimsError('common.version_conflict');
  const verified = (await c.deps.repo.factors(c.tx, { tenantId: c.s.tenantId, userId: c.s.userId })).filter((f) => f.status === 'verified');
  // [CONV] several verified factors: the most recently verified one is challenged; none (data error) -> 409
  const f = verified.sort((a, b) => (b.verifiedAt?.getTime() ?? 0) - (a.verifiedAt?.getTime() ?? 0))[0];
  if (!f) throw new LimsError('common.version_conflict');
  const t = await checkCode(c, f.gotrueFactorId, code, 'challenge');
  await activate(c, t);
  await c.record(c.ev('mfa_verified'));
  await loginSucceeded(c);
  return sessionState(c);
});

export const verifyMfaChallenge: Handler = wire(createVerifyMfaChallenge);
