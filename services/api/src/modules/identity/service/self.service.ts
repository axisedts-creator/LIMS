// Self service /me (06 T10; 02-TRD §5.2; 01-PRD AC-A5.2, AC-A5.4, AC-A6.1-A6.4; 07-SECURITY AU-T20, AU-T22; 08 A19 D-101, P-42).
// Tenant, user, membership and the caller's CURRENT session come from ctx only, never from the input. Staff and partner sessions run
// the same operations on their own rows; someone else's id is common.not_found (indistinguishable from an unknown id).
// Writes go to the request tx (rolled back on any throw) except the P-42 path: a wrong current password records login_failed, then
// commit-on-error (P-42) and the 401. GoTrue calls run after the DB writes so a GoTrue failure rolls every write back.
import { LimsError, type FieldError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as role.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { evaluatePassword } from '../domain/password-policy.js';
import { fixedActorPermissions } from '../domain/permission-set.js';
import type { GoTrueGateway } from '../gotrue/gateway.js';
import type { AuthEvent } from '../repository/auth-events.repo.js';
import { maskIp, uaFamily } from './platform-staff.service.js';

export interface Profile {
  membershipId: string; userId: string; email: string; displayName: string; roles: Array<{ role_id: string; code: string; name: string }>;
  permissions: string[]; allCentres: boolean; centreIds: string[]; lastLoginAt: Date | string | null; hasVerifiedFactor: boolean;
}
export interface SessRow {
  id: string; tenant_id: string; kind: string; user_id: string; membership_id: string | null; display_name?: string | null; state: string; aal: string;
  created_at: Date | string; last_seen_at: Date | string; idle_expires_at: Date | string; absolute_expires_at: Date | string;
  client_ip: string | null; user_agent: string | null; support_session_id: string | null;
}
export interface FactorRow {
  id: string; tenant_id: string; user_id: string; gotrue_factor_id: string; friendly_name: string | null; status: 'unverified' | 'verified' | 'removed';
  verified_at: Date | string | null;
}
type Keyset = { at: string; id: string };
export interface SelfRepo {
  getProfile(tx: unknown, tenantId: string, a: { membershipId: string; userId: string; actorType: string }): Promise<Profile | undefined>;
  listOwnSessions(tx: unknown, tenantId: string, a: { userId: string; limit: number; after?: Keyset }): Promise<SessRow[]>;
  findOwnSession(tx: unknown, tenantId: string, a: { userId: string; sessionId: string }): Promise<SessRow | undefined>;
  revokeSession(tx: unknown, tenantId: string, a: { userId: string; sessionId: string; reason: 'self_revoke'; at: Date; actorId: string }): Promise<void>;
  revokeOtherSessions(tx: unknown, a: { tenantId: string; userId: string; exceptSessionId: string; reason: 'password_change'; actorId: string }): Promise<Array<{ sessionId: string; kind: string }>>;
  listOwnFactors(tx: unknown, tenantId: string, a: { userId: string }): Promise<FactorRow[]>;
  findOwnFactor(tx: unknown, tenantId: string, a: { userId: string; factorId: string }): Promise<FactorRow | undefined>;
  roleRequiresMfa(tx: unknown, tenantId: string, a: { membershipId: string }): Promise<boolean>;
  markFactorRemoved(tx: unknown, tenantId: string, a: { userId: string; factorId: string; reason: 'self'; at: Date; actorId: string }): Promise<void>;
  enqueue(tx: unknown, taskIdentifier: string, payload: Record<string, unknown>, jobKey: string): Promise<void>;
  /** tenant password_min_length (AC-A6.1); undefined (no settings row) -> the service fails closed (common.internal) */
  passwordMinLength(tx: unknown, tenantId: string): Promise<number | undefined>;
}
export interface SelfCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId: string };
  readonly sessionId: string;
  readonly aal?: string;
  readonly partnerRole?: string;
  readonly requestId: string;
  readonly clientIp: string;
  readonly tx: unknown;
  readonly now?: () => Date;
  readonly commitOnError: () => void;
  readonly log?: { warn(o: object, m?: string): void };
  readonly audit: { access(entry: { action: string; entityType: string; entityId?: string; outcome: 'allowed' | 'denied' }): Promise<void> };
}
export interface Result { status: number; body?: unknown }
type In = Record<string, unknown>;
export interface SelfDeps {
  repo?: SelfRepo;
  gotrue?: Pick<GoTrueGateway, 'signInWithPassword' | 'signOut' | 'adminUpdatePassword' | 'adminDeleteFactor'>;
  breached?: { isBreached(tx: any, sha1: Buffer): Promise<boolean> };
  events?: { recordTenant(tx: any, e: AuthEvent): Promise<void> };
  newId?: () => string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/;
const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;
const PASSWORD_MAX = 128;   // PasswordChangeRequest maxLength
const LIVE = (s: { state: string }) => s.state !== 'revoked' && s.state !== 'expired';
const SIGNOUT = 'identity.gotrue_signout';

const iso = (v: Date | string) => new Date(v).toISOString();
const notFound = () => new LimsError('common.not_found');
const failAt = (path: string): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);
};
const omitEmpty = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
const sameId = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

export function limitOf(v: unknown): number {
  if (v === undefined) return 50;
  const l = typeof v === 'string' && /^\d{1,4}$/.test(v) ? Number(v) : v;
  return Number.isInteger(l) && (l as number) >= 1 && (l as number) <= 200 ? (l as number) : failAt('/limit');
}
export const encodeCursor = (r: SessRow) => Buffer.from(JSON.stringify([iso(r.last_seen_at), r.id])).toString('base64url');
export function decodeCursor(c: unknown): Keyset {
  try {
    if (typeof c === 'string' && CURSOR.test(c)) {
      const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && PG_TS.test(v[0]) && !Number.isNaN(Date.parse(v[0]))
        && typeof v[1] === 'string' && UUID.test(v[1])) return { at: v[0], id: v[1].toLowerCase() };
    }
  } catch { /* fall through */ }
  return failAt('/cursor');
}

/** SessionSummary (tenant): whitelisted keys only, IP masked, user agent reduced to its family; no token material. */
export const toSession = (r: SessRow) => omitEmpty({
  session_id: r.id, membership_id: r.membership_id, display_name: r.display_name ?? '', state: r.state, aal: r.aal,
  created_at: iso(r.created_at), last_seen_at: iso(r.last_seen_at), idle_expires_at: iso(r.idle_expires_at), absolute_expires_at: iso(r.absolute_expires_at),
  client_ip_masked: r.client_ip ? maskIp(r.client_ip) : undefined, user_agent_family: r.user_agent ? uaFamily(r.user_agent) : undefined,
  is_support: !!r.support_session_id,
});
const toFactor = (f: FactorRow) => omitEmpty({
  factor_id: f.id, friendly_name: f.friendly_name, status: f.status, verified_at: f.verified_at ? iso(f.verified_at) : undefined,
});

export function createSelfService(deps: SelfDeps = {}) {
  const newId = deps.newId ?? uuidv7;
  const need = <T>(v: T | undefined): T => { if (!v) throw new LimsError('common.internal'); return v; };   // fail closed when unwired

  /** ctx fields every operation relies on; anything else (patient / device / system) never reaches a repo. */
  function who(ctx: SelfCtx) {
    const a = ctx?.actor;
    if (typeof ctx?.tenantId !== 'string' || !a || (a.type !== 'user' && a.type !== 'partner') || typeof a.id !== 'string' || typeof a.membershipId !== 'string'
      || typeof ctx.sessionId !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
    return { tx: ctx.tx, repo: need(deps.repo), tenantId: ctx.tenantId, userId: a.id, membershipId: a.membershipId, actorType: a.type,
      sessionId: ctx.sessionId, now: ctx.now ? ctx.now() : new Date() };
  }
  type Who = ReturnType<typeof who>;
  const event = (ctx: SelfCtx, w: Who, e: { eventType: string; reasonCode?: string; sessionId?: string }) =>
    need(deps.events).recordTenant(w.tx, {
      id: newId(), eventType: e.eventType, ...(e.reasonCode ? { reasonCode: e.reasonCode } : {}), tenantId: w.tenantId, userId: w.userId,
      membershipId: w.membershipId, sessionId: e.sessionId ?? w.sessionId, clientIp: ctx.clientIp, requestId: ctx.requestId, actorId: w.userId,
    });
  const signOut = (w: Who, sessionId: string, reason: string) =>
    w.repo.enqueue(w.tx, SIGNOUT, { user_id: w.userId, tenant_id: w.tenantId, session_id: sessionId }, `signout:${sessionId}:${reason}`);
  const mine = (w: Who, r: { tenant_id: string; user_id: string } | undefined) => !!r && r.tenant_id === w.tenantId && r.user_id === w.userId;
  /** any GoTrue failure -> dependency error (no GoTrue detail leaks); a LimsError passes through */
  async function gotrue<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) { if (e instanceof LimsError) throw e; throw new LimsError('common.dependency_unavailable'); }
  }
  async function profile(ctx: SelfCtx, w: Who): Promise<Profile> {
    // 02-TRD s5.2 / s7.1 (08 A28.3): a partner's role comes from the claims (ctx.partnerRole), permissions from the fixed set; no core role read.
    const partnerPerms = w.actorType === 'partner' && typeof ctx.partnerRole === 'string' ? fixedActorPermissions('partner', ctx.partnerRole) : [];
    if (w.actorType === 'partner' && partnerPerms.length === 0) throw new LimsError('auth.unauthenticated');
    const p = await w.repo.getProfile(w.tx, w.tenantId, { membershipId: w.membershipId, userId: w.userId, actorType: w.actorType });
    if (!p || p.userId !== w.userId || p.membershipId !== w.membershipId) throw new LimsError('auth.unauthenticated');
    if (w.actorType !== 'partner') return p;
    // [CONV] RoleRef.role_id is required but a partner role has no core.roles row: the membership id stands in (CR C2.T10).
    return { ...p, roles: [{ role_id: p.membershipId, code: ctx.partnerRole!, name: ctx.partnerRole! }], permissions: partnerPerms, allCentres: false, centreIds: [] };
  }

  return {
    async getMe(ctx: SelfCtx, _input: In = {}): Promise<Result> {
      const w = who(ctx); const p = await profile(ctx, w);
      const partner = w.actorType === 'partner';   // 08 A19 D-101: a partner has no centre scope
      return {
        status: 200,
        body: omitEmpty({
          membership_id: p.membershipId, display_name: p.displayName, email: p.email, roles: p.roles.map((r) => ({ role_id: r.role_id, code: r.code, name: r.name })),
          permissions: [...p.permissions], centre_scope: partner ? { all: false, centre_ids: [] } : { all: p.allCentres, centre_ids: p.allCentres ? [] : [...p.centreIds] },
          mfa: { enrolled: p.hasVerifiedFactor, level: ctx.aal === 'aal1' ? 'aal1' : 'aal2' }, last_login_at: p.lastLoginAt ? iso(p.lastLoginAt) : undefined,
        }),
      };
    },

    async changeOwnPassword(ctx: SelfCtx, input: In): Promise<Result> {
      const w = who(ctx);
      const cur = input?.['currentPassword'], next = input?.['newPassword'];
      if (typeof cur !== 'string' || cur.length < 1 || cur.length > PASSWORD_MAX) failAt('/current_password');
      if (typeof next !== 'string' || next.length < 1 || next.length > PASSWORD_MAX) failAt('/new_password');
      const p = await profile(ctx, w);
      const gt = need(deps.gotrue);
      // GoTrue has no verify-only call: a password sign-in proves the current password.
      const check = await gotrue(() => gt.signInWithPassword(p.email, cur as string));
      if (!check.ok) {   // P-42 / AU-T22: the failure event is the only write that survives the 401
        await event(ctx, w, { eventType: 'login_failed', reasonCode: 'auth.login_failed' });
        ctx.commitOnError();
        throw new LimsError('auth.login_failed');
      }
      // the verifying sign-in opened a GoTrue session: close it now, best-effort (a failure is logged, never fatal, never silent)
      try { await gt.signOut(check.tokens.accessToken, 'local'); }
      catch (e) { ctx.log?.warn({ err: e instanceof Error ? e.name : 'unknown', requestId: ctx.requestId }, 'identity.self.verify_signout_failed'); }
      const minLength = await w.repo.passwordMinLength(w.tx, w.tenantId);
      if (typeof minLength !== 'number') throw new LimsError('common.internal');   // fail closed: never fall back to the floor
      const breached = need(deps.breached);
      const verdict = await evaluatePassword(next as string, { minLength, isBreached: (sha1) => breached.isBreached(w.tx, sha1) });
      if (!verdict.ok) throw new LimsError(verdict.code);

      const revoked = await w.repo.revokeOtherSessions(w.tx, { tenantId: w.tenantId, userId: w.userId, exceptSessionId: w.sessionId, reason: 'password_change', actorId: w.userId });
      for (const o of revoked) {
        await signOut(w, o.sessionId, 'password_change');
        await event(ctx, w, { eventType: 'session_revoked', reasonCode: 'password_change', sessionId: o.sessionId });
      }
      await event(ctx, w, { eventType: 'password_changed' });
      await gotrue(() => gt.adminUpdatePassword(w.userId, next as string));   // last: a GoTrue refusal rolls every write back
      return { status: 204 };
    },

    async listOwnSessions(ctx: SelfCtx, input: In = {}): Promise<Result> {
      const w = who(ctx);
      const limit = limitOf(input?.['limit']);
      const after = input?.['cursor'] === undefined ? undefined : decodeCursor(input['cursor']);
      const rows = (await w.repo.listOwnSessions(w.tx, w.tenantId, { userId: w.userId, limit: limit + 1, ...(after ? { after } : {}) }))
        .filter((r) => mine(w, r) && LIVE(r));
      const more = rows.length > limit; const kept = more ? rows.slice(0, limit) : rows;
      return { status: 200, body: { data: kept.map(toSession), page: { limit, ...(more ? { next_cursor: encodeCursor(kept[kept.length - 1]!) } : {}) } } };
    },

    async revokeOwnSession(ctx: SelfCtx, input: In): Promise<Result> {
      const w = who(ctx);
      const id = input?.['sessionId'];
      if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
      if (sameId(id, w.sessionId)) throw new LimsError('identity.self_action_forbidden');   // AC-A5.4: the current session ends through logout
      const row = await w.repo.findOwnSession(w.tx, w.tenantId, { userId: w.userId, sessionId: id.toLowerCase() });
      if (!row || !mine(w, row)) throw notFound();   // AU-T20: someone else's id == unknown id
      if (!LIVE(row)) return { status: 204 };          // already ended: nothing to do
      await w.repo.revokeSession(w.tx, w.tenantId, { userId: w.userId, sessionId: row.id, reason: 'self_revoke', at: w.now, actorId: w.userId });
      await signOut(w, row.id, 'self_revoke');
      await event(ctx, w, { eventType: 'session_revoked', reasonCode: 'self_revoke', sessionId: row.id });
      await ctx.audit.access({ action: 'session.revoke', entityType: 'session', entityId: row.id, outcome: 'allowed' });
      return { status: 204 };
    },

    async listOwnMfaFactors(ctx: SelfCtx, _input: In = {}): Promise<Result> {
      const w = who(ctx);
      const rows = (await w.repo.listOwnFactors(w.tx, w.tenantId, { userId: w.userId })).filter((f) => mine(w, f) && f.status !== 'removed');
      return { status: 200, body: { data: rows.map(toFactor) } };
    },

    async removeOwnMfaFactor(ctx: SelfCtx, input: In): Promise<Result> {
      const w = who(ctx);
      const id = input?.['factorId'];
      if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
      const f = await w.repo.findOwnFactor(w.tx, w.tenantId, { userId: w.userId, factorId: id.toLowerCase() });
      if (!f || !mine(w, f) || f.status === 'removed') throw notFound();
      if (f.status === 'verified' && await w.repo.roleRequiresMfa(w.tx, w.tenantId, { membershipId: w.membershipId })) {
        const verified = (await w.repo.listOwnFactors(w.tx, w.tenantId, { userId: w.userId })).filter((x) => mine(w, x) && x.status === 'verified');
        if (!verified.some((x) => x.id !== f.id)) throw new LimsError('identity.self_action_forbidden');   // last verified factor of an MFA role
      }
      await w.repo.markFactorRemoved(w.tx, w.tenantId, { userId: w.userId, factorId: f.id, reason: 'self', at: w.now, actorId: w.userId });
      await event(ctx, w, { eventType: 'mfa_factor_removed', reasonCode: 'self' });
      await gotrue(() => need(deps.gotrue).adminDeleteFactor(w.userId, f.gotrue_factor_id));   // last: a GoTrue failure rolls the row back
      return { status: 204 };
    },
  };
}
