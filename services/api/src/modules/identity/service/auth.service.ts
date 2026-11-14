// Staff login (03-APP-FLOW §3.1/§3.3; 01-PRD AC-A1.1-7; 07-SECURITY AU-T1/T2/T2a-c/T10/T14/T19/T22/T23; 08 A1, A6.6, A8.1, A19 P-42,
// A25 D-212/D-217/P-61, A28.1). Runs inside ctx.db.identityAuthTx: tenant, membership and kind come only from
// app.identity_login_context; tx.bindTenant runs once, after the membership is known and before any tenant write.
// Every 4xx: its auth event (+ job), ctx.commitOnError() once, nothing else, then the throw. Failures are padded to a floor (rule 2).
// No SQL here: repo / events / limits are seams (auth-events.repo.ts, AuthLimits adapter in handlers/loginStaff.ts).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { LimsError, isLimsError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as core/errors.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { GoTrueGateway, GoTrueTokens } from '../gotrue/gateway.js';
import { cidrList, ipAllowed } from '../claims/resolver.js';
import type { AuthEvent, NewSession } from '../repository/auth-events.repo.js';
import { idMetrics, loginOutcomeOf } from '../metrics.js';

type Row = Record<string, any>;
export interface AuthTx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }>; bindTenant?: (tenantId: string) => Promise<void> }
export interface AuthCtx {
  actor: { type: string; id: string }; requestId: string; clientIp: string; userAgent?: string | undefined; bffKey?: string | undefined;
  tx: AuthTx; now(): Date; commitOnError(): void; log: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
}
export interface AuthRepo {
  loginContext(tx: AuthTx, sub: string): Promise<Row | undefined>;
  /** T31 openMobileSession (AU-T17): does the membership hold the permission through an active role? Runs after tx.bindTenant. */
  membershipHasPermission?(tx: AuthTx, a: { tenantId: string; membershipId: string; permission: string }): Promise<boolean>;
  insertSession(tx: AuthTx, s: NewSession): Promise<void>;
  insertPlatformSession(tx: AuthTx, s: NewSession): Promise<void>;
  touchMembershipLogin(tx: AuthTx, a: { tenantId: string; membershipId: string; at: Date; actorId: string }): Promise<void>;
  platformStaffLogin(tx: AuthTx, a: { platformStaffId: string; userId: string; at: Date }): Promise<void>;
  enqueue(tx: AuthTx, taskIdentifier: string, payload: Record<string, unknown>, jobKey: string): Promise<void>;
}
export interface AuthEvents { recordTenantless(tx: AuthTx, e: AuthEvent): Promise<void>; recordTenant(tx: AuthTx, e: AuthEvent): Promise<void> }
/** Account key = HMAC hex (a:), IP key = ctx.clientIp (f:). Throwing common.rate_limited carries retryAfterSeconds. */
export interface AuthLimits {
  consumeAttempt(accountKey: string): Promise<void>;
  accountState(accountKey: string): Promise<{ failures: number; lastFailureAt: Date | null }>;
  recordAccountFailure(accountKey: string): Promise<void>;
  clearAccountFailures(accountKey: string): Promise<void>;
  checkIp(ip: string): Promise<void>;
  recordIpFailure(ip: string): Promise<{ engaged: boolean; windowStart: Date }>;
}
export type AlertCode = 'identity_multi_membership' | 'login_ip_throttled' | 'platform_ip_denied';
export interface AuthDeps {
  gotrue: Pick<GoTrueGateway, 'signInWithPassword'>; repo: AuthRepo; events: AuthEvents; limits: AuthLimits;
  hmac?: (normalisedEmail: string) => string; newId?: () => string; newToken?: () => string;
  sleep?: (ms: number) => Promise<void>; floorMs?: number; alert?: (code: AlertCode, detail: Record<string, unknown>) => void;
  /** LIMS_IDENTITY_PLATFORM_ALLOWED_CIDRS (global list, intersected with the per-staff list; empty = no global restriction). */
  platformAllowedCidrs?: readonly string[];
  /** LIMS_IDENTITY_PLATFORM_IDLE_MINUTES / _ABSOLUTE_HOURS (02-TRD §11 defaults 15 / 8). */
  platformIdleMinutes?: number; platformAbsoluteHours?: number;
  /** T31: LIMS_IDENTITY_MOBILE_ABSOLUTE_HOURS (02-TRD s11; staff_mobile idle = absolute, sessions__idle__ck 60..720 min). */
  mobileAbsoluteHours?: number;
  /** T31: request clock seam used by the login handler envelope (default new Date()) */
  now?: () => Date;
}
/** T31 (08 R10): which login family. staff = loginStaff (staff_web BFF), partner = loginPartner (partner BFF), mobile = openMobileSession (no BFF). */
export type LoginMode = 'staff' | 'partner' | 'mobile';
export interface MobileLoginInput { email: unknown; password: unknown; appInstanceId: string; appPlatform: 'android' | 'ios' }
export interface MobileSessionResult { status: 200; body: { session_token: string; access_token: string; access_expires_at: string; session_expires_at: string; session: Record<string, unknown> } }
export interface LoginResult { status: 200; body: { session_token: string; session: Record<string, unknown> } }

const EMAIL_MAX = 254; const PASSWORD_MAX = 128;
const BACKOFF_BASE_S = 30; const BACKOFF_CAP_S = 900; const STEP_UP_FAILS = 5;   // 03-APP-FLOW §3.3 [CONV]

function envHmac(email: string): string {
  const key = process.env['LIMS_IDENTITY_EMAIL_HMAC_KEY'];
  if (!key) throw new LimsError('common.internal', 'identity: email HMAC key missing');
  return createHmac('sha256', key).update(email).digest('hex');
}
const envList = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const envInt = (v: string | undefined, d: number) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; };
const MOBILE_PERMISSION = 'homecollection.sync.upload';   // 02-TRD s4 item 10 / AU-T17
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const invalid = () => new LimsError('common.validation_failed');
const normalise = (e: string) => e.trim().normalize('NFC').toLowerCase();

// T28 (02-TRD §13): checkIp refusals are the same common.rate_limited as the account cap; marked here so the counter says ip_throttled.
const ipThrottled = new WeakSet<object>();
// T28 backing gauge lims_identity_login_failures_by_tenant_5m [CONV]: failures this process can attribute to a tenant (blocked / forbidden
// after the password matched). A wrong password names no tenant here (GoTrue says only "no"): the auth_events sample is CR-C2-T28-002.
// ponytail: process-local window like the login limiter (handlers/loginStaff.ts); the DB sampler replaces it.
const tenantFails = new Map<string, number[]>();
function tenantFailure(ctx: unknown, tenantId: string, now: number) {
  const a = (tenantFails.get(tenantId) ?? []).filter((t) => t > now - 300_000);
  a.push(now); tenantFails.set(tenantId, a);
  if (tenantFails.size > 10_000) tenantFails.delete(tenantFails.keys().next().value as string);
  idMetrics.tenantFailures5m(ctx, tenantId, a.length);
}

export function createAuthService(deps: AuthDeps) {
  const hmac = deps.hmac ?? envHmac;
  const newId = deps.newId ?? uuidv7;
  const newToken = deps.newToken ?? (() => randomBytes(32).toString('base64url'));   // 43 chars
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const floorMs = deps.floorMs ?? 400;
  const alert = deps.alert ?? (() => undefined);
  const globalCidrs = deps.platformAllowedCidrs ?? envList(process.env['LIMS_IDENTITY_PLATFORM_ALLOWED_CIDRS']);
  const pIdle = deps.platformIdleMinutes ?? envInt(process.env['LIMS_IDENTITY_PLATFORM_IDLE_MINUTES'], 15);
  const pAbs = deps.platformAbsoluteHours ?? envInt(process.env['LIMS_IDENTITY_PLATFORM_ABSOLUTE_HOURS'], 8);

  /** mobile hours read per call (env may change between tests / deploys); out of range -> the 12 h default (CHECK 60..720 min) [CONV] */
  const mobileHours = () => {
    const h = deps.mobileAbsoluteHours ?? envInt(process.env['LIMS_IDENTITY_MOBILE_ABSOLUTE_HOURS'], 12);
    return h >= 1 && h <= 12 ? h : 12;
  };

  async function login(ctx: AuthCtx, input: { email: unknown; password: unknown }, mode: LoginMode, app?: { appInstanceId: string; appPlatform: string }): Promise<LoginResult | MobileSessionResult> {
    const start = ctx.now().getTime();
    const { email, password } = input ?? ({} as never);
    if (typeof email !== 'string' || typeof password !== 'string' || password.length < 1 || password.length > PASSWORD_MAX) throw invalid();
    const norm = normalise(email);
    if (norm.length < 3 || norm.length > EMAIL_MAX) throw invalid();
    const k = hmac(norm);
    const tx = ctx.tx;
    const base = { clientIp: ctx.clientIp, userAgent: ctx.userAgent, requestId: ctx.requestId, actorId: ctx.actor.id };
    const ev = (eventType: string, o: Partial<AuthEvent> = {}): AuthEvent => ({ id: newId(), eventType, ...base, ...o });

    /** P-42 exit: writes already done by the caller; keep them, pad, throw. */
    const deny = async (err: LimsError): Promise<never> => {
      ctx.commitOnError();
      const left = floorMs - (ctx.now().getTime() - start);
      if (left > 0) await sleep(left);
      throw err;
    };
    const tenantless = async (eventType: string, err: LimsError, o: Partial<AuthEvent> = {}) => {
      await deps.events.recordTenantless(tx, ev(eventType, { emailHmacHex: k, ...o }));
      return deny(err);
    };
    const limited = (e: unknown) => (isLimsError(e, 'common.rate_limited') ? tenantless('login_rate_limited', e) : Promise.reject(e));

    // AU-T14: loginStaff serves the staff_web BFF only, loginPartner the partner BFF only; the password is not checked for any other key.
    // openMobileSession is a public app route (no BFF): the key is ignored.
    if (mode !== 'mobile' && ctx.bffKey !== (mode === 'partner' ? 'partner' : 'staff_web')) return tenantless('login_failed', new LimsError('auth.login_failed'), { reasonCode: 'wrong_bff' });

    // 1. per-IP throttle (only bites once engaged), 2. hourly account cap, 3. backoff / step-up (password not checked)
    try { await deps.limits.checkIp(ctx.clientIp); } catch (e) { if (e && typeof e === 'object') ipThrottled.add(e); return limited(e); }
    try { await deps.limits.consumeAttempt(k); } catch (e) { return limited(e); }
    const st = await deps.limits.accountState(k);
    if (st.failures >= STEP_UP_FAILS) {
      const backoffMs = Math.min(BACKOFF_BASE_S * 2 ** (st.failures - STEP_UP_FAILS), BACKOFF_CAP_S) * 1000;
      const since = st.lastFailureAt ? ctx.now().getTime() - st.lastFailureAt.getTime() : backoffMs;
      if (since < backoffMs) {
        const e = new LimsError('common.rate_limited'); e.retryAfterSeconds = Math.max(1, Math.ceil((backoffMs - since) / 1000));
        return tenantless('login_rate_limited', e);
      }
      return tenantless('login_step_up_required', new LimsError('auth.step_up_required'));
    }

    let r: Awaited<ReturnType<AuthDeps['gotrue']['signInWithPassword']>>;
    try { r = await deps.gotrue.signInWithPassword(norm, password); } catch (e) {
      if (isLimsError(e)) throw e;
      throw new LimsError('common.dependency_unavailable');   // outage: never a credential failure, never 200
    }

    if (!r.ok) {
      await deps.limits.recordAccountFailure(k);
      const ip = await deps.limits.recordIpFailure(ctx.clientIp);
      await deps.events.recordTenantless(tx, ev('login_failed', { emailHmacHex: k }));
      if (ip.engaged) {
        const now = ctx.now();
        await deps.events.recordTenantless(tx, ev('login_ip_throttled'));
        await deps.repo.enqueue(tx, 'identity.notify_ip_throttle', { client_ip: ctx.clientIp, window_start: ip.windowStart.toISOString() },
          `ipthrottle:${sha256(ctx.clientIp).toString('hex')}:${now.toISOString().slice(0, 16)}`);
        alert('login_ip_throttled', { request_id: ctx.requestId });
      }
      return deny(new LimsError('auth.login_failed'));
    }

    const t = r.tokens;
    const row = (await deps.repo.loginContext(tx, t.userId)) ?? {};
    const signOut = (reason: string, tenantId?: string) => deps.repo.enqueue(tx, 'identity.gotrue_signout',
      { user_id: t.userId, ...(tenantId ? { tenant_id: tenantId } : {}) }, `signout:${t.userId}:${reason}`);
    const who = { userId: t.userId };

    if (row['platform_staff_id'] && !row['tenant_id']) {
      if (mode !== 'staff') return tenantless('login_failed', new LimsError('auth.login_failed'), who);   // platform staff: staff_web only
      return platformLogin(ctx, row, t, k, ev, deny, signOut);
    }
    // AU-T14 (08 R10): loginPartner accepts only actor_type 'partner'; the staff / mobile families never a partner membership.
    // [CONV] a row without actor_type is a user membership (05-SCHEMA s6 DEFINER returns staff memberships; see .orchestra/cr/T31.md).
    if (mode === 'partner' ? row['actor_type'] !== 'partner' : row['actor_type'] === 'partner') return tenantless('login_failed', new LimsError('auth.login_failed'), who);

    if (Number(row['membership_count']) > 1) {   // 08 A6.6: data error, never a 403 leak
      alert('identity_multi_membership', { user_id: t.userId, request_id: ctx.requestId });
      return tenantless('login_failed', new LimsError('auth.login_failed'), { ...who, reasonCode: 'multi_membership' });
    }
    const tenantId = row['tenant_id'] as string | null | undefined; const membershipId = row['membership_id'] as string | null | undefined;
    if (!tenantId || !membershipId) return tenantless('login_failed', new LimsError('auth.login_failed'), who);   // no staff membership

    if (!tx.bindTenant) throw new LimsError('common.internal');
    await tx.bindTenant(tenantId);
    const blocked = async (eventType: string, code: string) => {
      await deps.events.recordTenant(tx, ev(eventType, { ...who, tenantId, membershipId, emailHmacHex: k }));
      await signOut(eventType, tenantId);
      tenantFailure(ctx, tenantId, ctx.now().getTime());
      return deny(new LimsError(code));
    };
    if (row['membership_status'] !== 'active') return blocked('login_blocked_inactive', 'identity.membership_inactive');
    if (row['membership_locked'] !== false) return blocked('login_blocked_locked', 'auth.account_locked');
    if (row['tenant_status'] !== 'active') return blocked('login_blocked_tenant_suspended', 'identity.tenant_suspended');

    if (mode === 'mobile') {   // AU-T17: read only after the password is verified and the tenant is bound (no oracle for unknown accounts)
      const ok = deps.repo.membershipHasPermission
        ? await deps.repo.membershipHasPermission(tx, { tenantId, membershipId, permission: MOBILE_PERMISSION }) : false;
      if (!ok) {
        await deps.events.recordTenant(tx, ev('login_failed', { ...who, tenantId, membershipId, emailHmacHex: k, reasonCode: 'auth.forbidden' }));
        await signOut('mobile_permission', tenantId);
        tenantFailure(ctx, tenantId, ctx.now().getTime());
        return deny(new LimsError('auth.forbidden'));
      }
    }

    let idle = Number(row['idle_timeout_minutes']); let abs = Number(row['absolute_session_hours']);
    if (mode === 'mobile') { abs = mobileHours(); idle = abs * 60; }   // staff_mobile: no idle timeout, idle = absolute (04 A16, 05-SCHEMA s4.1)
    if (!(idle > 0) || !(abs > 0)) throw new LimsError('common.internal', 'identity: tenant session settings missing');
    const state = row['has_verified_factor'] === true ? 'mfa_pending' : row['mfa_required'] === true ? 'mfa_enrolment_required' : 'active';
    const now = ctx.now();
    const kind = mode === 'partner' ? 'partner' : mode === 'mobile' ? 'staff_mobile' : 'tenant_staff';
    const { s, token } = session(ctx, t, { tenantId, kind, membershipId, platformStaffId: null, state, idle, abs, now });
    if (app) { s.appInstanceId = app.appInstanceId; s.appPlatform = app.appPlatform; }
    await deps.repo.insertSession(tx, s);
    if (state === 'active') await deps.repo.touchMembershipLogin(tx, { tenantId, membershipId, at: now, actorId: ctx.actor.id });
    await deps.events.recordTenant(tx, ev(state === 'active' ? 'login_succeeded' : 'login_password_ok', { ...who, tenantId, membershipId, sessionId: s.id, emailHmacHex: k }));
    await deps.limits.clearAccountFailures(k);
    if (mode === 'mobile') {
      const r = result(s, token);
      return { status: 200, body: { session_token: token, access_token: t.accessToken, access_expires_at: s.accessExpiresAt.toISOString(),
        session_expires_at: s.absoluteExpiresAt.toISOString(), session: r.body.session } };
    }
    return result(s, token);
  }

  async function platformLogin(ctx: AuthCtx, row: Row, t: GoTrueTokens, k: string, ev: (e: string, o?: Partial<AuthEvent>) => AuthEvent,
    deny: (e: LimsError) => Promise<never>, signOut: (reason: string) => Promise<void>): Promise<LoginResult> {
    const tx = ctx.tx; const platformStaffId = row['platform_staff_id'] as string;
    const who = { userId: t.userId, platformStaffId, emailHmacHex: k };
    if (row['platform_active'] !== true) {   // deactivated platform staff: no oracle, plain login failure [CONV]
      await deps.events.recordTenantless(tx, ev('login_failed', { ...who, reasonCode: 'platform_inactive' }));
      await signOut('platform_inactive');
      return deny(new LimsError('auth.login_failed'));
    }
    if (!ipAllowed([...globalCidrs], ctx.clientIp) || !ipAllowed(cidrList(row['platform_allowed_cidrs']), ctx.clientIp)) {   // AU-T10
      await deps.events.recordTenantless(tx, ev('login_blocked_ip', who));
      await signOut('login_blocked_ip');
      alert('platform_ip_denied', { platform_staff_id: platformStaffId, request_id: ctx.requestId });
      return deny(new LimsError('identity.platform_ip_denied'));
    }
    const state = row['has_verified_factor'] === true ? 'mfa_pending' : 'mfa_enrolment_required';   // MFA always required (08 A28.1)
    const now = ctx.now();
    const { s, token } = session(ctx, t, { tenantId: null, kind: 'platform', membershipId: null, platformStaffId, state, idle: pIdle, abs: pAbs, now });
    await deps.repo.insertPlatformSession(tx, s);
    await deps.repo.platformStaffLogin(tx, { platformStaffId, userId: t.userId, at: now });
    await deps.events.recordTenantless(tx, ev('login_password_ok', { ...who, sessionId: s.id }));
    await deps.limits.clearAccountFailures(k);
    return result(s, token);
  }

  function session(ctx: AuthCtx, t: GoTrueTokens, o: { tenantId: string | null; kind: string; membershipId: string | null; platformStaffId: string | null;
    state: string; idle: number; abs: number; now: Date }) {
    const token = newToken();
    const absolute = new Date(o.now.getTime() + o.abs * 3_600_000);
    const s: NewSession = {
      id: newId(), tenantId: o.tenantId, kind: o.kind, userId: t.userId, membershipId: o.membershipId, platformStaffId: o.platformStaffId,
      gotrueSessionId: t.sessionId, tokenSha256: sha256(token), state: o.state, aal: t.aal, accessToken: t.accessToken, refreshToken: t.refreshToken,
      accessExpiresAt: new Date(t.expiresAt * 1000), idleTimeoutMinutes: o.idle, idleExpiresAt: new Date(o.now.getTime() + o.idle * 60_000),
      absoluteExpiresAt: absolute, expiresAt: absolute, clientIp: ctx.clientIp, userAgent: ctx.userAgent, actorId: ctx.actor.id,
    };
    return { s, token };
  }

  // SessionState.actor (display_name, roles) has no source in app.identity_login_context: omitted, see .orchestra/cr/T6.md.
  const result = (s: NewSession, token: string): LoginResult => ({
    status: 200,
    body: { session_token: token, session: { session_id: s.id, kind: s.kind, state: s.state, aal: s.aal,
      idle_expires_at: s.idleExpiresAt.toISOString(), absolute_expires_at: s.absoluteExpiresAt.toISOString() } },
  });

  /** T28 lims_identity_logins_total{outcome, kind}: kind = login family [CONV]. A 400 (bad input) and an outage are not login attempts. */
  async function counted<T>(ctx: AuthCtx, mode: LoginMode, run: Promise<T>): Promise<T> {
    try {
      const out = await run;
      idMetrics.login(ctx, 'success', mode);
      return out;
    } catch (e) {
      if (isLimsError(e) && e.code !== 'common.validation_failed' && e.code !== 'common.dependency_unavailable' && e.code !== 'common.internal') {
        idMetrics.login(ctx, ipThrottled.has(e) ? 'ip_throttled' : loginOutcomeOf(e.code), mode);
      }
      throw e;
    }
  }

  return {
    loginStaff: (ctx: AuthCtx, input: { email: unknown; password: unknown }) => counted(ctx, 'staff', login(ctx, input, 'staff') as Promise<LoginResult>),
    /** T31 loginPartner: session kind partner (AU-T14, 03-APP-FLOW s3.5a) */
    loginPartner: (ctx: AuthCtx, input: { email: unknown; password: unknown }) => counted(ctx, 'partner', login(ctx, input, 'partner') as Promise<LoginResult>),
    /** T31 openMobileSession: session kind staff_mobile (AU-T17) */
    openMobileSession: (ctx: AuthCtx, input: MobileLoginInput) =>
      counted(ctx, 'mobile', login(ctx, input, 'mobile', { appInstanceId: input.appInstanceId, appPlatform: input.appPlatform }) as Promise<MobileSessionResult>),
  };
}
