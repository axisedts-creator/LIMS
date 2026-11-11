// Session resolve / refresh / touch / logout (T8; 02-TRD s4 items 5-8, s5.1, s11/s12; 03-APP-FLOW s3.5, s3.6, SS9, SS10;
// 01-PRD AC-A4.1-3, AC-A5.1; 07-SECURITY AU-T7, AU-T13, AU-T18, E-9; 08 A19 P-42, A25 D-212/P-61).
// One ctx.db.identityAuthTx per request. The session comes only from the DEFINER app.identity_session_by_token(sha256(cookie));
// tx.bindTenant(session.tenant_id) once for tenant kinds; loadSession takes the row lock (FOR UPDATE), so parallel resolves of one
// session serialise: the second sees the first one's refresh / touch / expiry and does not repeat it (done_when).
// LD-81: patient / staff_mobile sessions are never served here (no GoTrue refresh for the patient kind; T31 owns them).
import { createHash } from 'node:crypto';
import { LimsError, isLimsError } from '../../../core/errors.js';
import type { Tx, TxFn, TxInput } from '../../../core/db/tx.js';
import type { GoTrueGateway } from '../gotrue/gateway.js';
import type { AuthEvent } from '../repository/auth-events.repo.js';
import type { MfaRepo, SessionRef } from '../repository/mfa.repo.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as core/errors.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

export type SessionRepo = Pick<MfaRepo, 'sessionByToken' | 'loadSession' | 'updateSession' | 'touchSession' | 'expireSession' | 'enqueue'>;
export interface SessionDeps {
  gotrue: Pick<GoTrueGateway, 'refresh'>;
  repo: SessionRepo;
  events: { recordTenantless(tx: Tx, e: AuthEvent): Promise<void>; recordTenant(tx: Tx, e: AuthEvent): Promise<void> };
  hmac?: (normalisedEmail: string) => string; newId?: () => string; now?: () => Date;
}
/** what the handler hands over after parsing the request (cookie token already shape-checked) */
export interface SessionCall {
  operationId: 'resolveSession' | 'logoutSession'; token: string; bffKey: string | undefined; actorId: string;
  requestId: string; clientIp: string; userAgent: string | undefined; commitOnError: (() => void) | undefined;
  db: { identityAuthTx<T>(input: TxInput, fn: TxFn<T>): Promise<T> };
}

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

  /** cookie -> DEFINER lookup -> kind/key check -> bindTenant -> loadSession (row lock) -> run. `gone` answers a dead / unknown row. */
  async function locked<R>(c: SessionCall, gone: (known: boolean) => R, run: (l: Locked) => Promise<R>): Promise<R> {
    const kinds = c.bffKey ? KINDS_FOR_KEY[c.bffKey] : undefined;
    if (!kinds) throw expired();
    const operation = Object.freeze({ module: 'identity', operationId: c.operationId, context: 'identity_auth' });
    const out = await c.db.identityAuthTx({ operation, requestId: c.requestId, clientIp: c.clientIp, userAgent: c.userAgent }, async (tx, ctl) => {
      ctl.noRetry();   // a GoTrue refresh rotates the refresh token: never replay it
      let keep = false;
      try {
        const s = await deps.repo.sessionByToken(tx, createHash('sha256').update(c.token).digest());
        // [CONV] a rotated-out token (CR-C2-018) is treated as unknown (E-9); staff_web / partner tokens are not rotated.
        if (!s || s.tokenReused || !kinds.has(s.kind)) return { ok: gone(false) };
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
          // platform: { user_id } only (a worker cannot read platform rows)
          signOut: (reason) => deps.repo.enqueue(tx, 'identity.gotrue_signout', { user_id: s.userId, ...(s.tenantId ? { tenant_id: s.tenantId } : {}) },
            `signout:${s.userId}:${reason}`),
          deny: (err) => { keep = true; c.commitOnError?.(); throw err; },
        };
        return { ok: await run(l) };
      } catch (err) { if (keep) return { err }; throw err; }
    });
    if ('err' in out) throw out.err;
    return out.ok;
  }

  return {
    /** POST resolve: 200 ResolvedSession, or 401 / 403 / 503 */
    resolve: (c: SessionCall, touch: boolean) => locked(c, () => { throw expired(); }, async (l) => {
      const t = l.now.getTime();
      // 1. SS10 lazy expiry first (no GoTrue call for a dead session; absolute wins when both lapsed); kept through the 401 (P-42)
      const lapsed = l.load.absoluteExpiresAt.getTime() <= t ? 'absolute' : l.load.idleExpiresAt.getTime() <= t ? 'idle' : undefined;
      if (lapsed) {
        await deps.repo.expireSession(l.tx, l.ref, { reason: lapsed, actorId: c.actorId });
        await l.record(l.ev(`session_expired_${lapsed}`));
        return l.deny(expired());
      }
      // 2. AU-T18: locked membership / suspended tenant (nothing written)
      if (l.load.membershipLocked) throw new LimsError('auth.account_locked');
      if (l.s.kind !== 'platform' && l.load.tenantStatus !== 'active') throw new LimsError('identity.tenant_suspended');
      // 3. access JWT refresh, decided on the row loaded under the lock
      let accessToken = l.load.accessToken; let accessExpiresAt = l.load.accessExpiresAt;
      if (accessExpiresAt.getTime() - t <= REFRESH_WINDOW_MS) {
        let r: Awaited<ReturnType<SessionDeps['gotrue']['refresh']>> | undefined;
        try { r = await deps.gotrue.refresh(l.load.refreshToken); } catch (e) {
          if (isLimsError(e) && e.code !== 'common.dependency_unavailable') throw e;
          // GoTrue outage is NOT a logout: keep serving the current JWT while it is valid, else 503
          if (accessExpiresAt.getTime() <= t) throw new LimsError('common.dependency_unavailable');
        }
        if (r && !r.ok) {   // SS9: refresh refused -> revoke (refresh_failed) + event + sign-out job, all kept through the 401
          await deps.repo.updateSession(l.tx, l.ref, { revoked: { reason: 'refresh_failed' }, actorId: c.actorId });
          await l.record(l.ev('refresh_failed'));
          await l.signOut('refresh_failed');
          return l.deny(expired());
        }
        if (r) {
          accessToken = r.tokens.accessToken; accessExpiresAt = new Date(r.tokens.expiresAt * 1000);
          await deps.repo.updateSession(l.tx, l.ref, { accessToken, refreshToken: r.tokens.refreshToken, accessExpiresAt, actorId: c.actorId });
        }
      }
      // 4. touch <= 1 per interval; background polling (touch=false) never extends idle (AC-A4.2)
      let idleExpiresAt = l.load.idleExpiresAt;
      if (touch && t - l.load.lastSeenAt.getTime() >= touchIntervalMs()) {
        idleExpiresAt = new Date(t + l.load.idleTimeoutMinutes * 60_000);
        await deps.repo.touchSession(l.tx, l.ref, { lastSeenAt: l.now, idleExpiresAt, actorId: c.actorId });
      }
      // SessionState.actor has no source on this path: omitted (.orchestra/cr/T6.md)
      return { status: 200 as const, body: {
        access_token: accessToken, access_expires_at: accessExpiresAt.toISOString(),
        session: { session_id: l.s.sessionId, kind: l.s.kind, state: l.load.state, aal: l.load.aal,
          idle_expires_at: idleExpiresAt.toISOString(), absolute_expires_at: l.load.absoluteExpiresAt.toISOString() },
      } };
    }),

    /** POST logout: 204. Unknown token -> 401 (E-9); an already revoked / expired row -> 204 no-op ("a repeat is a no-op"). */
    logout: (c: SessionCall) => locked(c, (known) => { if (!known) throw expired(); return { status: 204 as const, body: undefined }; }, async (l) => {
      // GoTrue sign-out is a job: an outage cannot block logout. Any non-terminal state (incl. lapsed-but-active) is revoked.
      await deps.repo.updateSession(l.tx, l.ref, { revoked: { reason: 'logout' }, actorId: c.actorId });
      await l.record(l.ev('logout'));
      await l.signOut('logout');
      return { status: 204 as const, body: undefined };
    }),
  };
}
export type SessionService = ReturnType<typeof createSessionService>;
