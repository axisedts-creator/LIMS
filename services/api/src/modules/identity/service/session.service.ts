// Session resolve / refresh / touch / logout (T8; 02-TRD s4 items 5-8, s5.1, s11/s12; 03-APP-FLOW s3.5, s3.6, SS9, SS10;
// 01-PRD AC-A4.1-3, AC-A5.1; 07-SECURITY AU-T7, AU-T13, AU-T18, E-9; 08 A19 P-42, A25 D-212/P-61).
// One ctx.db.identityAuthTx per request. The session comes only from the DEFINER app.identity_session_by_token(sha256(cookie));
// tx.bindTenant(session.tenant_id) once for tenant kinds; loadSession takes the row lock (FOR UPDATE), so parallel resolves of one
// session serialise: the second sees the first one's refresh / touch / expiry and does not repeat it (done_when).
// T31 (08 R10, CR-C2-018 / 08 A3.1, LD-81): the app families. refreshMobileSession / logoutMobileSession serve kind staff_mobile ONLY,
// resolvePatientSession / logoutPatientSession kind patient ONLY (AU-T13: any other kind = 401, nothing written). App tokens rotate on
// refresh; a rotated-out token presented again revokes the session (token_reuse) + session_token_reused, kept through the 401 via
// ctx.commitOnError() (P-42). LD-81: the patient kind has no GoTrue session: LIMS mints the 1 h access JWT (mintPatientAccessToken).
import { idMetrics } from '../metrics.js';
import { createHash, randomBytes } from 'node:crypto';
import { LimsError, isLimsError } from '../../../core/errors.js';
import type { Tx, TxFn, TxInput } from '../../../core/db/tx.js';
import type { GoTrueGateway } from '../gotrue/gateway.js';
import type { AuthEvent } from '../repository/auth-events.repo.js';
import type { MfaRepo, SessionRef } from '../repository/mfa.repo.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as core/errors.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

export type SessionRepo = Pick<MfaRepo, 'sessionByToken' | 'loadSession' | 'updateSession' | 'touchSession' | 'expireSession' | 'enqueue'>
  & Partial<Pick<MfaRepo, 'rotateToken'>>;
/** LD-81 patient access JWT claims: exactly sub / session_id / aal / iat / exp (the EdDSA signer is the seam) */
export interface PatientJwtClaims { sub: string; sessionId: string; aal: string; issuedAt: Date; expiresAt: Date }
export interface SessionDeps {
  gotrue: Pick<GoTrueGateway, 'refresh'>;
  repo: SessionRepo;
  events: { recordTenantless(tx: Tx, e: AuthEvent): Promise<void>; recordTenant(tx: Tx, e: AuthEvent): Promise<void> };
  hmac?: (normalisedEmail: string) => string; newId?: () => string; now?: () => Date;
  /** T31: opaque app token (default 32 random bytes base64url = 43 chars) and the LD-81 patient JWT signer */
  newToken?: () => string; mintPatientAccessToken?: (c: PatientJwtClaims) => string;
}
export type SessionFamily = 'bff' | 'staff_mobile' | 'patient';
/** what the handler hands over after parsing the request (cookie token already shape-checked) */
export interface SessionCall {
  operationId: 'resolveSession' | 'logoutSession' | 'refreshMobileSession' | 'logoutMobileSession' | 'resolvePatientSession' | 'logoutPatientSession';
  /** default 'bff' (kind from the BFF key); the app families accept exactly their own kind */
  family?: SessionFamily;
  token: string; bffKey: string | undefined; actorId: string;
  requestId: string; clientIp: string; userAgent: string | undefined; commitOnError: (() => void) | undefined;
  db: { identityAuthTx<T>(input: TxInput, fn: TxFn<T>): Promise<T> };
}

const PATIENT_JWT_MS = 3_600_000;    // LD-81: exp at most 1 h
const REFRESH_WINDOW_MS = 120_000;   // 02-TRD s12: refresh when the access JWT has <= 120 s left
/** 02-TRD s11: touch at most once per LIMS_IDENTITY_TOUCH_INTERVAL_SECONDS (default 60) */
function touchIntervalMs(): number {
  const v = Number(process.env['LIMS_IDENTITY_TOUCH_INTERVAL_SECONDS'] ?? 60);
  return (Number.isFinite(v) && v > 0 ? v : 60) * 1000;
}
// AU-T13: the BFF key binds the session kind. patient / staff_mobile never resolve here (LD-81 / T31).
const KINDS_FOR_KEY: Record<string, ReadonlySet<string>> = { staff_web: new Set(['tenant_staff', 'platform']), partner: new Set(['partner']) };
const TERMINAL = new Set(['revoked', 'expired']);

const expired = () => new LimsError('auth.session_expired');

type Session = NonNullable<Awaited<ReturnType<SessionRepo['sessionByToken']>>>;
type Loaded = NonNullable<Awaited<ReturnType<SessionRepo['loadSession']>>>;
interface Locked {
  tx: Tx; s: Session; ref: SessionRef; load: Loaded; now: Date;
  ev(eventType: string): AuthEvent; record(e: AuthEvent): Promise<void>; signOut(reason: string): Promise<void>;
  /** P-42: the writes made so far survive the error (commitOnError + the error is returned out of the tx and re-thrown) */
  deny(err: LimsError): never;
}

export function createSessionService(deps: SessionDeps) {
  const newId = deps.newId ?? uuidv7;
  const clock = deps.now ?? (() => new Date());

  const newToken = deps.newToken ?? (() => randomBytes(32).toString('base64url'));
  const sha = (t: string) => createHash('sha256').update(t).digest();

  /** cookie / app token -> DEFINER lookup -> kind/family check -> bindTenant -> loadSession (row lock) -> reuse check -> run.
   *  `gone` answers a dead / unknown row (and a kind of another family: AU-T13, nothing written). */
  async function locked<R>(c: SessionCall, gone: (known: boolean) => R, run: (l: Locked) => Promise<R>): Promise<R> {
    const family = c.family ?? 'bff';
    const kinds = family === 'bff' ? (c.bffKey ? KINDS_FOR_KEY[c.bffKey] : undefined) : new Set<string>([family]);
    if (!kinds) throw expired();
    const operation = Object.freeze({ module: 'identity', operationId: c.operationId, context: 'identity_auth' });
    const out = await c.db.identityAuthTx({ operation, requestId: c.requestId, clientIp: c.clientIp, userAgent: c.userAgent }, async (tx, ctl) => {
      ctl.noRetry();   // a GoTrue refresh rotates the refresh token: never replay it
      let keep = false;
      try {
        const s = await deps.repo.sessionByToken(tx, sha(c.token));
        // [CONV] BFF family: a rotated-out token (CR-C2-018) is treated as unknown (E-9); staff_web / partner tokens are not rotated.
        // The kind check comes first: a token of another family is never treated as a reuse (AU-T13).
        if (!s || !kinds.has(s.kind) || (family === 'bff' && s.tokenReused)) return { ok: gone(false) };
        if (s.kind === 'platform' ? s.tenantId !== null || !s.platformStaffId : !s.tenantId || !s.membershipId) return { ok: gone(false) };
        if (TERMINAL.has(s.state)) return { ok: gone(true) };
        if (s.kind !== 'platform') {
          if (!tx.bindTenant) throw new LimsError('common.internal');
          await tx.bindTenant(s.tenantId!);   // D-212: tenant from the session row, never from the request
        }
        const ref: SessionRef = { sessionId: s.sessionId, tenantId: s.tenantId, userId: s.userId, kind: s.kind };
        const load = await deps.repo.loadSession(tx, ref);   // FOR UPDATE: the serialisation point
        if (!load || TERMINAL.has(load.state)) return { ok: gone(!!load) };   // re-checked under the lock (a parallel request ended it)
        const who: Partial<AuthEvent> = s.kind === 'platform'
          ? { userId: s.userId, platformStaffId: s.platformStaffId!, sessionId: s.sessionId }
          : { userId: s.userId, tenantId: s.tenantId!, membershipId: s.membershipId!, sessionId: s.sessionId };
        const ev = (eventType: string): AuthEvent => ({ id: newId(), eventType, ...who, ...(deps.hmac && load.email ? { emailHmacHex: deps.hmac(load.email) } : {}),
          clientIp: c.clientIp, userAgent: c.userAgent, requestId: c.requestId, actorId: c.actorId });
        const l: Locked = {
          tx, s, ref, load, now: clock(), ev,
          record: (e) => (s.kind === 'platform' ? deps.events.recordTenantless(tx, e) : deps.events.recordTenant(tx, e)),
          // platform: { user_id } only (a worker cannot read platform rows). LD-81: the patient kind has no GoTrue session -> no job.
          signOut: async (reason) => {
            if (s.kind === 'patient') return;
            await deps.repo.enqueue(tx, 'identity.gotrue_signout', { user_id: s.userId, ...(s.tenantId ? { tenant_id: s.tenantId } : {}) },
              `signout:${s.userId}:${reason}`);
          },
          deny: (err) => { keep = true; c.commitOnError?.(); throw err; },
        };
        if (s.tokenReused) return await reuse(c, l);   // await: the rejection must reach the catch below (keep)
        return { ok: await run(l) };
      } catch (err) { if (keep) return { err }; throw err; }
    });
    if ('err' in out) throw out.err;
    return out.ok;
  }

  /** AU-T15 (08 R10, A3.1): rotated-out app token presented again -> revoke, event, sign-out job; kept through the 401 (P-42) */
  async function reuse(c: SessionCall, l: Locked): Promise<never> {
    await deps.repo.updateSession(l.tx, l.ref, { revoked: { reason: 'token_reuse' }, actorId: c.actorId });
    await l.record(l.ev('session_token_reused'));
    await l.signOut('token_reuse');
    idMetrics.sessionResolve(c, 'revoked');
    return l.deny(expired());
  }

  /** SS10 lazy expiry (absolute wins when both lapsed); expiry + event kept through the 401 (P-42) */
  async function lapse(c: SessionCall, l: Locked): Promise<void> {
    const t = l.now.getTime();
    const lapsed = l.load.absoluteExpiresAt.getTime() <= t ? 'absolute' : l.load.idleExpiresAt.getTime() <= t ? 'idle' : undefined;
    if (!lapsed) return;
    await deps.repo.expireSession(l.tx, l.ref, { reason: lapsed, actorId: c.actorId });
    await l.record(l.ev(`session_expired_${lapsed}`));
    idMetrics.sessionResolve(c, 'expired');
    l.deny(expired());
  }

  /** 02-TRD s12: GoTrue refresh when the access JWT has <= 120 s left; refused -> revoke (refresh_failed) + event + job, kept (SS9) */
  async function gotrueRefresh(c: SessionCall, l: Locked): Promise<{ accessToken: string; accessExpiresAt: Date }> {
    const t = l.now.getTime();
    let accessToken = l.load.accessToken; let accessExpiresAt = l.load.accessExpiresAt;
    if (accessExpiresAt.getTime() - t > REFRESH_WINDOW_MS) return { accessToken, accessExpiresAt };
    let r: Awaited<ReturnType<SessionDeps['gotrue']['refresh']>> | undefined;
    try { r = await deps.gotrue.refresh(l.load.refreshToken); } catch (e) {
      if (isLimsError(e) && e.code !== 'common.dependency_unavailable') throw e;
      // GoTrue outage is NOT a logout: keep serving the current JWT while it is valid, else 503
      if (accessExpiresAt.getTime() <= t) throw new LimsError('common.dependency_unavailable');
    }
    if (r && !r.ok) {
      await deps.repo.updateSession(l.tx, l.ref, { revoked: { reason: 'refresh_failed' }, actorId: c.actorId });
      await l.record(l.ev('refresh_failed'));
      await l.signOut('refresh_failed');
      idMetrics.sessionResolve(c, 'refresh_failed');
      return l.deny(expired());
    }
    if (r) {
      accessToken = r.tokens.accessToken; accessExpiresAt = new Date(r.tokens.expiresAt * 1000);
      await deps.repo.updateSession(l.tx, l.ref, { accessToken, refreshToken: r.tokens.refreshToken, accessExpiresAt, actorId: c.actorId });
    }
    return { accessToken, accessExpiresAt };
  }

  /** locked membership / suspended tenant (AU-T18): 403, nothing written */
  function blocked(l: Locked): void {
    // [CONV] app kinds (patient / staff_mobile) are served only while active: these routes have no MFA step
    if (l.s.kind === 'patient' || l.s.kind === 'staff_mobile') { if (l.load.state !== 'active') throw expired(); }
    if (l.load.membershipLocked) throw new LimsError('auth.account_locked');
    if (l.s.kind !== 'platform' && l.load.tenantStatus !== 'active') throw new LimsError('identity.tenant_suspended');
  }

  const sessionBody = (l: Locked, idleExpiresAt: Date) => ({ session_id: l.s.sessionId, kind: l.s.kind, state: l.load.state, aal: l.load.aal,
    idle_expires_at: idleExpiresAt.toISOString(), absolute_expires_at: l.load.absoluteExpiresAt.toISOString() });

  /** touch <= 1 per interval; touch=false never extends idle (AC-A4.2) */
  async function touched(c: SessionCall, l: Locked, touch: boolean): Promise<Date> {
    const t = l.now.getTime();
    if (!touch || t - l.load.lastSeenAt.getTime() < touchIntervalMs()) return l.load.idleExpiresAt;
    const idleExpiresAt = new Date(t + l.load.idleTimeoutMinutes * 60_000);
    await deps.repo.touchSession(l.tx, l.ref, { lastSeenAt: l.now, idleExpiresAt, actorId: c.actorId });
    return idleExpiresAt;
  }

  /** POST logout (all families): 204. Unknown token -> 401 (E-9); an already revoked / expired row -> 204 no-op. */
  const logout = (c: SessionCall) => locked(c, (known) => { if (!known) throw expired(); return { status: 204 as const, body: undefined }; }, async (l) => {
    // GoTrue sign-out is a job (none for patient): an outage cannot block logout. Any non-terminal state (incl. lapsed-but-active) is revoked.
    await deps.repo.updateSession(l.tx, l.ref, { revoked: { reason: 'logout' }, actorId: c.actorId });
    await l.record(l.ev('logout'));
    await l.signOut('logout');
    return { status: 204 as const, body: undefined };
  });

  return {
    /** POST resolve: 200 ResolvedSession, or 401 / 403 / 503 */
    resolve: (c: SessionCall, touch: boolean) => locked(c, () => { throw expired(); }, async (l) => {
      // 1. SS10 lazy expiry first (no GoTrue call for a dead session); 2. AU-T18 blocked; 3. access JWT refresh under the lock; 4. touch
      await lapse(c, l);
      blocked(l);
      const { accessToken, accessExpiresAt } = await gotrueRefresh(c, l);
      const idleExpiresAt = await touched(c, l, touch);
      idMetrics.sessionResolve(c, accessToken === l.load.accessToken ? 'ok' : 'refreshed');   // T28 (02-TRD §13)
      // SessionState.actor has no source on this path: omitted (.orchestra/cr/T6.md)
      return { status: 200 as const, body: { access_token: accessToken, access_expires_at: accessExpiresAt.toISOString(), session: sessionBody(l, idleExpiresAt) } };
    }),

    /** T31 resolvePatientSession (LD-81): no GoTrue; LIMS mints the access JWT, exp = min(now + 1 h, session end). */
    resolvePatient: (c: SessionCall, touch: boolean) => locked({ ...c, family: 'patient' }, () => { throw expired(); }, async (l) => {
      await lapse(c, l);
      blocked(l);
      const idleExpiresAt = await touched(c, l, touch);
      idMetrics.sessionResolve(c, 'ok');
      if (!deps.mintPatientAccessToken) throw new LimsError('common.internal', 'identity: patient JWT signer not wired');
      const expiresAt = new Date(Math.min(l.now.getTime() + PATIENT_JWT_MS, l.load.absoluteExpiresAt.getTime(), idleExpiresAt.getTime()));
      const accessToken = deps.mintPatientAccessToken({ sub: l.s.userId, sessionId: l.s.sessionId, aal: l.load.aal, issuedAt: l.now, expiresAt });
      return { status: 200 as const, body: { access_token: accessToken, access_expires_at: expiresAt.toISOString(), session: sessionBody(l, idleExpiresAt) } };
    }),

    /** T31 refreshMobileSession: GoTrue access refresh when due, then rotate the opaque token (CR-C2-018: old hash -> previous_token_sha256). */
    refreshMobile: (c: SessionCall) => locked({ ...c, family: 'staff_mobile' }, () => { throw expired(); }, async (l) => {
      await lapse(c, l);
      blocked(l);
      if (!deps.repo.rotateToken) throw new LimsError('common.internal');
      const token = newToken();
      // rotate BEFORE the GoTrue refresh: a lost race (0 rows) is reuse and never spends a refresh token (AU-T15, 02-TRD s4 item 10)
      if (!await deps.repo.rotateToken(l.tx, l.ref, { tokenSha256: sha(token), previousTokenSha256: sha(c.token), actorId: c.actorId })) return await reuse(c, l);
      const { accessToken, accessExpiresAt } = await gotrueRefresh(c, l);
      return { status: 200 as const, body: { session_token: token, access_token: accessToken, access_expires_at: accessExpiresAt.toISOString(),
        session_expires_at: l.load.absoluteExpiresAt.toISOString(), session: sessionBody(l, l.load.idleExpiresAt) } };
    }),

    logout,
    logoutMobile: (c: SessionCall) => logout({ ...c, family: 'staff_mobile' }),
    logoutPatient: (c: SessionCall) => logout({ ...c, family: 'patient' }),
  };
}
export type SessionService = ReturnType<typeof createSessionService>;
