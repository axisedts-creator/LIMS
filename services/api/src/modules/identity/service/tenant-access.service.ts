// Tenant sessions, tenant-side support sessions, admin notices (06 T17; 02-TRD §5; 01-PRD AC-A5.3, AC-A5.4, AC-E4.4; 03-APP-FLOW SP3/SP4/SP10;
// 07-SECURITY P-1, P-3, P-6, E-5, threat 6). Tenant, caller and current session come from ctx only. A row of another tenant is common.not_found,
// indistinguishable from an unknown id; rows a repo leaks are dropped again here. Authorization (x-permission, aal2) is the core pipeline's.
// All writes go to the request tx (rolled back on any throw); the access-log entry is written last. Reason / note texts never reach a sink.
import { LimsError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as role.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { canTransition, STATES, type SupportSessionStatus } from '../domain/support-session.state.js';
import type { AuthEvent } from '../repository/auth-events.repo.js';
import { createTenantAccessRepo } from '../repository/tenant-access.repo.js';
import { decodeCursor, encodeCursor, limitOf, toSession, type SessRow } from './self.service.js';
import { expected, toBody, uuidAt, type SRow } from './support.service.js';

type Keyset = { at: string; id: string };
export interface NoticeRow {
  id: string; tenant_id: string; kind: string; subject_type: string; subject_id: string | null; created_for_membership_id: string | null;
  dismissed_by: string[]; created_at: Date | string; expires_at: Date | string;
}
export interface SupportPatch {
  status: SupportSessionStatus; decidedAt?: Date; decidedByMembershipId?: string; decisionNote?: string; endedAt?: Date; endedBy?: string; endReason?: string; actorId: string;
}
export interface TenantAccessRepo {
  listSessions(tx: unknown, tenantId: string, a: { membershipId?: string; state?: string; limit: number; after?: Keyset }): Promise<SessRow[]>;
  findSession(tx: unknown, tenantId: string, a: { sessionId: string }): Promise<SessRow | undefined>;
  revokeSession(tx: unknown, tenantId: string, a: { sessionId: string; reason: 'admin_revoke'; at: Date; actorId: string }): Promise<void>;
  enqueue(tx: unknown, taskIdentifier: string, payload: Record<string, unknown>, jobKey: string): Promise<void>;
  listSupportSessions(tx: unknown, tenantId: string, a: { status?: string; limit: number }): Promise<SRow[]>;
  findSupportSession(tx: unknown, tenantId: string, a: { supportSessionId: string }): Promise<SRow | undefined>;
  updateSupportSession(tx: unknown, tenantId: string, a: { supportSessionId: string; expectedVersion: number; patch: SupportPatch }): Promise<SRow | undefined>;
  unbindSupportSession(tx: unknown, tenantId: string, a: { supportSessionId: string }): Promise<void>;
  listNotices(tx: unknown, tenantId: string, a: { membershipId: string; now: Date }): Promise<NoticeRow[]>;
  findNotice(tx: unknown, tenantId: string, a: { noticeId: string }): Promise<NoticeRow | undefined>;
  dismissNotice(tx: unknown, tenantId: string, a: { noticeId: string; membershipId: string; actorId: string }): Promise<void>;
}
export interface TenantCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string; readonly supportSessionId?: string };
  readonly sessionId?: string;
  readonly requestId: string;
  readonly clientIp: string;
  readonly tx: unknown;
  readonly now?: () => Date;
  readonly audit: { access(entry: { action: string; entityType: string; entityId?: string; outcome: 'allowed' | 'denied' }): Promise<void> };
}
export interface Result { status: number; body?: unknown; version?: number }
type In = Record<string, unknown>;
export interface TenantAccessDeps {
  repo?: TenantAccessRepo;
  events?: { recordTenant(tx: unknown, e: AuthEvent): Promise<void> };
  newId?: () => string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_STATES = ['password_setup', 'mfa_pending', 'mfa_enrolment_required', 'active', 'revoked', 'expired'];
const LIVE = (s: { state: string }) => s.state !== 'revoked' && s.state !== 'expired';
const LIST_MAX = 200;                       // SupportSessionList / AdminNoticeList maxItems
const REQUEST_TTL_MS = 24 * 3_600_000;      // AC-E4.4: a request expires after 24 h (SP5)
const SIGNOUT = 'identity.gotrue_signout';

const iso = (v: Date | string) => new Date(v).toISOString();
const notFound = () => new LimsError('common.not_found');
const conflict = () => new LimsError('common.version_conflict');
const failAt = (path: string): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' }]);
};
const pathId = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : undefined);

const toNotice = (n: NoticeRow) => ({
  notice_id: n.id, kind: n.kind, subject_type: n.subject_type, ...(n.subject_id ? { subject_id: n.subject_id } : {}),
  created_at: iso(n.created_at), expires_at: iso(n.expires_at),
});

export function createTenantAccessService(deps: TenantAccessDeps = {}) {
  const newId = deps.newId ?? uuidv7;

  function who(ctx: TenantCtx) {
    const a = ctx?.actor;
    if (typeof ctx?.tenantId !== 'string' || !a || a.type !== 'user' || typeof a.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
    const repo = deps.repo ?? createTenantAccessRepo();
    return { tx: ctx.tx, repo, tenantId: ctx.tenantId, userId: a.id, now: ctx.now ? ctx.now() : new Date() };
  }
  /** E-5: decisions and notices belong to a tenant member; a support-session actor (no membership) is refused. */
  function member(ctx: TenantCtx): string {
    const a = ctx.actor;
    if (a.supportSessionId !== undefined || typeof a.membershipId !== 'string') throw new LimsError('auth.forbidden');
    return a.membershipId;
  }
  const ours = (t: string, r: { tenant_id: string | null } | undefined) => !!r && r.tenant_id === t;

  /** shared find -> state check -> compare-and-set -> access log for the three support decisions */
  async function decide(ctx: TenantCtx, w: ReturnType<typeof who>, id: string, opts: {
    to: SupportSessionStatus; version?: number; action: string; patch: (w: ReturnType<typeof who>) => Omit<SupportPatch, 'status' | 'actorId'>; check?: (r: SRow, now: Date) => boolean;
  }): Promise<Result> {
    const row = await w.repo.findSupportSession(w.tx, w.tenantId, { supportSessionId: id });
    if (!ours(w.tenantId, row)) throw notFound();   // P-6
    const r = row!;
    if (!canTransition(r.status, opts.to) || (opts.check && !opts.check(r, w.now))) throw conflict();
    if (opts.version !== undefined && r.version !== opts.version) throw conflict();
    const updated = await w.repo.updateSupportSession(w.tx, w.tenantId, {
      supportSessionId: r.id, expectedVersion: r.version, patch: { status: opts.to, ...opts.patch(w), actorId: w.userId },
    });
    if (!updated || !ours(w.tenantId, updated)) throw conflict();   // lost race
    if (r.status === 'active') await w.repo.unbindSupportSession(w.tx, w.tenantId, { supportSessionId: r.id });   // SP10: cut the platform user off
    await ctx.audit.access({ action: opts.action, entityType: 'support_session', entityId: r.id, outcome: 'allowed' });
    return { status: 200, body: toBody(updated), version: updated.version };
  }

  return {
    async listSessions(ctx: TenantCtx, input: In = {}): Promise<Result> {
      const w = who(ctx);
      const membershipId = input?.['membershipId'], state = input?.['state'];
      if (membershipId !== undefined && pathId(membershipId) === undefined) failAt('/membership_id');
      if (state !== undefined && (typeof state !== 'string' || !SESSION_STATES.includes(state))) failAt('/state');
      const limit = limitOf(input?.['limit']);
      const after = input?.['cursor'] === undefined ? undefined : decodeCursor(input['cursor']);
      const rows = (await w.repo.listSessions(w.tx, w.tenantId, {
        ...(membershipId !== undefined ? { membershipId: pathId(membershipId)! } : {}), ...(state !== undefined ? { state: state as string } : {}),
        limit: limit + 1, ...(after ? { after } : {}),
      })).filter((r) => ours(w.tenantId, r));   // P-3
      const more = rows.length > limit; const kept = more ? rows.slice(0, limit) : rows;
      return { status: 200, body: { data: kept.map(toSession), page: { limit, ...(more ? { next_cursor: encodeCursor(kept[kept.length - 1]!) } : {}) } } };
    },

    async revokeSession(ctx: TenantCtx, input: In): Promise<Result> {
      const w = who(ctx);
      if (typeof ctx.sessionId !== 'string' || !ctx.sessionId) throw new LimsError('auth.unauthenticated');   // never guess "current"
      const id = pathId(input?.['sessionId']);
      if (!id) throw notFound();
      if (id === ctx.sessionId.toLowerCase()) throw new LimsError('identity.self_action_forbidden');   // AC-A5.4: the current session ends through logout
      const row = await w.repo.findSession(w.tx, w.tenantId, { sessionId: id });
      if (!row || !ours(w.tenantId, row)) throw notFound();   // P-1
      if (!LIVE(row)) return { status: 204 };
      await w.repo.revokeSession(w.tx, w.tenantId, { sessionId: row.id, reason: 'admin_revoke', at: w.now, actorId: w.userId });
      await w.repo.enqueue(w.tx, SIGNOUT, { user_id: row.user_id, tenant_id: w.tenantId, session_id: row.id }, `signout:${row.id}:admin_revoke`);
      if (!deps.events) throw new LimsError('common.internal');
      await deps.events.recordTenant(w.tx, {
        id: newId(), eventType: 'session_revoked', reasonCode: 'admin_revoke', tenantId: w.tenantId, userId: row.user_id,
        ...(row.membership_id ? { membershipId: row.membership_id } : {}), sessionId: row.id, clientIp: ctx.clientIp, requestId: ctx.requestId, actorId: w.userId,
      });
      await ctx.audit.access({ action: 'session.revoke', entityType: 'session', entityId: row.id, outcome: 'allowed' });
      return { status: 204 };
    },

    async listTenantSupportSessions(ctx: TenantCtx, input: In = {}): Promise<Result> {
      const w = who(ctx);
      const status = input?.['status'];
      if (status !== undefined && (typeof status !== 'string' || !(STATES as readonly string[]).includes(status))) failAt('/status');
      const rows = (await w.repo.listSupportSessions(w.tx, w.tenantId, { ...(status !== undefined ? { status: status as string } : {}), limit: LIST_MAX }))
        .filter((r) => ours(w.tenantId, r)).slice(0, LIST_MAX);
      return { status: 200, body: { data: rows.map(toBody) } };
    },

    async approveSupportSession(ctx: TenantCtx, input: In): Promise<Result> {
      const w = who(ctx); const membershipId = member(ctx);
      const id = uuidAt(input?.['supportSessionId'], '/support_session_id');
      if (input?.['expectedVersion'] == null) throw new LimsError('common.precondition_required');   // If-Match absent
      const version = expected(input['expectedVersion']);
      return decide(ctx, w, id, {
        to: 'approved', version, action: 'support_session.approve', patch: (x) => ({ decidedAt: x.now, decidedByMembershipId: membershipId }),
        check: (r, now) => now.getTime() - new Date(r.requested_at).getTime() <= REQUEST_TTL_MS,   // SP5 cron may not have run yet
      });
    },

    async denySupportSession(ctx: TenantCtx, input: In): Promise<Result> {
      const w = who(ctx); const membershipId = member(ctx);
      const id = uuidAt(input?.['supportSessionId'], '/support_session_id');
      const note = input?.['reasonText'];
      if (typeof note !== 'string' || note.length < 1 || note.length > 500) failAt('/reason_text');
      return decide(ctx, w, id, {
        to: 'denied', action: 'support_session.deny',
        patch: (x) => ({ decidedAt: x.now, decidedByMembershipId: membershipId, decisionNote: note as string, endReason: 'denied' }),
      });
    },

    async revokeSupportSession(ctx: TenantCtx, input: In): Promise<Result> {
      const w = who(ctx); member(ctx);
      const id = uuidAt(input?.['supportSessionId'], '/support_session_id');
      return decide(ctx, w, id, {
        to: 'revoked', action: 'support_session.revoke', patch: (x) => ({ endedAt: x.now, endedBy: x.userId, endReason: 'revoked_by_tenant' }),
      });
    },

    async listAdminNotices(ctx: TenantCtx, _input: In = {}): Promise<Result> {
      const w = who(ctx); const me = member(ctx);
      const rows = (await w.repo.listNotices(w.tx, w.tenantId, { membershipId: me, now: w.now }))
        .filter((n) => ours(w.tenantId, n) && new Date(n.expires_at).getTime() > w.now.getTime() && !n.dismissed_by.includes(me)
          && (n.created_for_membership_id === null || n.created_for_membership_id === me))
        .slice(0, LIST_MAX);
      return { status: 200, body: { data: rows.map(toNotice) } };
    },

    async dismissAdminNotice(ctx: TenantCtx, input: In): Promise<Result> {
      const w = who(ctx); const me = member(ctx);
      const id = pathId(input?.['noticeId']);
      if (!id) throw notFound();
      const n = await w.repo.findNotice(w.tx, w.tenantId, { noticeId: id });
      if (!n || !ours(w.tenantId, n) || (n.created_for_membership_id !== null && n.created_for_membership_id !== me)) throw notFound();
      if (n.dismissed_by.includes(me)) return { status: 204 };
      await w.repo.dismissNotice(w.tx, w.tenantId, { noticeId: n.id, membershipId: me, actorId: w.userId });
      return { status: 204 };
    },
  };
}
