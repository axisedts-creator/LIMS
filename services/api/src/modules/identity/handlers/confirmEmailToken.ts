// POST confirm invite / recovery link (03-APP-FLOW §3.7, SS1; 01-PRD AC-A7.2, AC-A8.1-2; 07-SECURITY AU-T6/T21; 08 A25 D-212/D-219/P-61).
// GoTrue verifies the token (its TTL, single use: D-219, no LIMS-side clock check). Every invalid link - unknown / used / expired / wrong type /
// no usable account - answers the SAME type-specific 400 and writes nothing. Valid: membership from app.identity_login_context(sub) ONLY,
// tx.bindTenant once, password_setup session (absolute now + 15 min [CONV] SS1), tenant event *_link_opened. One identityAuthTx.
import { createHash, randomBytes } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import type { Tx, TxFn, TxInput } from '../../../core/db/tx.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { GoTrueGateway } from '../gotrue/gateway.js';
import { createAuthEventsRepo, type AuthEvent, type NewSession } from '../repository/auth-events.repo.js';
import { createMfaRepo, type MfaRepo } from '../repository/mfa.repo.js';
import { bodyObject, gotrueCall, gw, invalid } from './verifyMfaChallenge.js';

export interface ConfirmDeps {
  gotrue: Pick<GoTrueGateway, 'verifyEmailToken'>;
  repo: Pick<MfaRepo, 'loginContext' | 'insertSession' | 'insertPlatformSession'>;
  events: { recordTenantless(tx: Tx, e: AuthEvent): Promise<void>; recordTenant(tx: Tx, e: AuthEvent): Promise<void> };
  hmac?: (normalisedEmail: string) => string; newId?: () => string; newToken?: () => string; now?: () => Date;
}
interface Hctx extends HandlerContext {
  requestId: string; bffKey?: string; actor?: { type: string; id: string };
  db: { identityAuthTx<T>(input: TxInput, fn: TxFn<T>): Promise<T> };
}

const OPERATION = Object.freeze({ module: 'identity', operationId: 'confirmEmailToken', context: 'identity_auth' });
const INVALID = { recovery: 'auth.reset_token_invalid', invite: 'auth.invite_invalid' } as const;
const OPENED = { recovery: 'recovery_link_opened', invite: 'invite_link_opened' } as const;
const SETUP_MINUTES = 15;          // SS1 [CONV]: password_setup lives 15 min (idle = absolute)
const HASH_MAX = 256;

export function createConfirmEmailToken(deps: ConfirmDeps) {
  const newId = deps.newId ?? uuidv7;
  const newToken = deps.newToken ?? (() => randomBytes(32).toString('base64url'));   // 43 chars
  const clock = deps.now ?? (() => new Date());
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const ctx = hctx as Hctx;
    const { token_hash: hash, type } = bodyObject(req.body, ['token_hash', 'type']);
    if (typeof hash !== 'string' || hash.length < 1 || hash.length > HASH_MAX || (type !== 'recovery' && type !== 'invite')) throw invalid();
    const actorId = ctx.actor?.id;
    if (typeof actorId !== 'string' || !actorId) throw new LimsError('common.internal');
    const bad = () => new LimsError(INVALID[type]);
    if (ctx.bffKey !== 'staff_web') throw bad();   // AU-T13: staff sessions serve the staff_web BFF only
    const ua = (req.headers as Record<string, unknown> | undefined)?.['user-agent'];
    const userAgent = typeof ua === 'string' ? ua : undefined;

    return ctx.db.identityAuthTx({ operation: OPERATION, requestId: ctx.requestId, clientIp: ctx.clientIp, userAgent }, async (tx, ctl) => {
      ctl.noRetry();   // a verified GoTrue token is consumed: never replay
      const r = await gotrueCall(() => deps.gotrue.verifyEmailToken(hash, type));
      if (!r.ok) throw bad();
      const t = r.tokens;
      const row: Record<string, any> = (await deps.repo.loginContext(tx, t.userId)) ?? {};
      const now = clock();
      const end = new Date(now.getTime() + SETUP_MINUTES * 60_000);
      const token = newToken();
      const base = {
        id: newId(), userId: t.userId, gotrueSessionId: t.sessionId, tokenSha256: createHash('sha256').update(token).digest(), state: 'password_setup',
        aal: t.aal, accessToken: t.accessToken, refreshToken: t.refreshToken, accessExpiresAt: new Date(t.expiresAt * 1000),
        idleTimeoutMinutes: SETUP_MINUTES, idleExpiresAt: end, absoluteExpiresAt: end, expiresAt: end, clientIp: ctx.clientIp, userAgent, actorId,
      };
      const ev = (o: Partial<AuthEvent>): AuthEvent => ({ id: newId(), eventType: OPENED[type], userId: t.userId, sessionId: base.id,
        clientIp: ctx.clientIp, userAgent, requestId: ctx.requestId, actorId, ...o });

      let s: NewSession;
      if (row['platform_staff_id'] && !row['tenant_id']) {
        if (row['platform_active'] !== true) throw bad();
        s = { ...base, tenantId: null, kind: 'platform', membershipId: null, platformStaffId: row['platform_staff_id'] };
        await deps.repo.insertPlatformSession(tx, s);
        await deps.events.recordTenantless(tx, ev({ platformStaffId: s.platformStaffId! }));
      } else {
        const tenantId = row['tenant_id']; const membershipId = row['membership_id'];
        // [CONV] usable = exactly one membership, tenant active, not locked, invited (invite) or active; anything else = invalid link (no oracle)
        if (Number(row['membership_count']) !== 1 || typeof tenantId !== 'string' || typeof membershipId !== 'string' || row['tenant_status'] !== 'active'
          || row['membership_locked'] !== false || !['active', 'invited'].includes(row['membership_status'])) throw bad();
        if (!tx.bindTenant) throw new LimsError('common.internal');
        await tx.bindTenant(tenantId);   // D-212: tenant from the DEFINER row only
        s = { ...base, tenantId, kind: 'tenant_staff', membershipId, platformStaffId: null };
        await deps.repo.insertSession(tx, s);
        await deps.events.recordTenant(tx, ev({ tenantId, membershipId }));
      }
      return {
        status: 200 as const,
        body: { session_token: token, session: { session_id: s.id, kind: s.kind, state: s.state, aal: s.aal,
          idle_expires_at: s.idleExpiresAt.toISOString(), absolute_expires_at: s.absoluteExpiresAt.toISOString() } },
      };
    });
  };
}

let wiredRepo: MfaRepo | undefined;
const events = createAuthEventsRepo();
const gotrue: ConfirmDeps['gotrue'] = { verifyEmailToken: (h, t) => gw().verifyEmailToken(h, t) };
export const confirmEmailToken: Handler = (async (req: HandlerRequest, hctx: HandlerContext) =>
  createConfirmEmailToken({ gotrue, repo: (wiredRepo ??= createMfaRepo()), events })(req, hctx)) as Handler;
