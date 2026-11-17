// Support sessions, platform side (02-TRD §5.10; 03-APP-FLOW §2.4 SP1/SP2/SP6/SP8/SP9; 01-PRD AC-E4.1-E4.6; 07-SECURITY E-5, E-6, P-6, P-8).
// Acting identity comes from the platform ctx only (CR-C2-004). Every operation runs PlatformAuthz.assertPlatform before any repo call.
// Writes into the TARGET tenant (access log, admin notice) happen only inside ctx.db.withTenantScope (08 R10 item 4 / A25 D-214).
// The reason text (P2) is never logged nor written to the access-log detail or notice (07-SECURITY threat 6).
import { idMetrics } from '../metrics.js';
import { access, type AccessLogEntry } from '../../../core/audit/access.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as role.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { STATES, type SupportSessionStatus } from '../domain/support-session.state.js';
import { PlatformAuthz } from '../platform/authz.js';

const OPEN = 'platform.support_session.open';
const READ = 'platform.tenant.read';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIVATE_WINDOW_MS = 60 * 60_000;            // approved -> active within 60 min (SP7; owner policy of the expiry cron) [CONV]
const NOTICE_TTL = '30 days';                      // 05-SCHEMA §9 admin_notices.expires_at [CONV]
const LIST_DEFAULT = 50, LIST_MAX = 200;

type Scope = 'read_only' | 'admin';
// [CR-C2-T21] `aal` and `platformSessionId` are not yet on the core PlatformRequestContext (CR-C2-004); requested in .orchestra/cr/C2.T21.md.
export interface PlatformCtx {
  readonly actor: { readonly type: string; readonly id: string; readonly supportSessionId?: string };
  readonly platformRole: string;
  readonly platformStaffId: string;
  readonly platformSessionId: string;
  readonly aal?: string;
  readonly requestId?: string;
  readonly tx: unknown;
  readonly now?: () => Date;
  readonly db: { withTenantScope<T>(tx: unknown, tenantId: string, fn: () => Promise<T>): Promise<T> };
}
export interface Result { status: number; body: any; version?: number }

export interface SRow {
  id: string; tenant_id: string; platform_staff_id: string; platform_staff_display_name: string; scope: Scope; reason_text: string; ticket_ref: string;
  duration_minutes: number; status: SupportSessionStatus; requested_at: Date | string; decided_at: Date | string | null; decision_note: string | null;
  started_at: Date | string | null; expires_at: Date | string | null; ended_at: Date | string | null; ended_by: string | null; end_reason: string | null;
  version: number; platform_session_id: string | null;
}
export interface TenantInfo { id: string; status: 'provisioning' | 'active' | 'suspended' | 'offboarded'; supportAccessMode: 'notify' | 'approval_required' }
export interface InsertArg {
  id: string; tenantId: string; platformStaffId: string; platformSessionId: string; scope: Scope; reasonText: string; ticketRef: string;
  durationMinutes: number; status: 'active' | 'requested'; startedAt?: Date; expiresAt?: Date; actorId: string;
}
export interface Patch { status: SupportSessionStatus; startedAt?: Date; expiresAt?: Date; endedAt?: Date; endedBy?: string; endReason?: string; actorId: string }
export interface WriteMeta { actor: PlatformCtx['actor']; requestId?: string | undefined }
export interface ListFilter { tenantId?: string; status?: string; platformStaffId?: string; cursor?: string; limit?: number }

export interface SupportRepo {
  findTenant(tx: unknown, tenantId: string): Promise<TenantInfo | undefined>;
  endActiveForPlatformSession(tx: unknown, platformSessionId: string, o: { endedBy: string; endedAt: Date; actorId: string }): Promise<SRow[]>;
  insert(tx: unknown, a: InsertArg): Promise<SRow>;
  find(tx: unknown, id: string): Promise<SRow | undefined>;
  update(tx: unknown, id: string, expectedVersion: number, p: Patch): Promise<SRow | undefined>;
  bindPlatformSession(tx: unknown, platformSessionId: string, supportSessionId: string | null): Promise<void>;
  list(tx: unknown, f: ListFilter): Promise<SRow[]>;
  insertAccessLog(tx: unknown, tenantId: string, e: AccessLogEntry, meta?: WriteMeta): Promise<void>;
  insertNotice(tx: unknown, tenantId: string, n: { kind: string; subjectType: string; subjectId: string }, meta?: WriteMeta): Promise<void>;
}

type Tx = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

/** Default repo: SQL on the request tx (platform claims; access log + notice run inside withTenantScope). */
export function createSupportRepo(): SupportRepo {
  const q = async (tx: unknown, sql: string, params: unknown[]) => (await (tx as Tx).query(sql, params)).rows;
  const SELECT = `SELECT ss.id, ss.tenant_id, ss.platform_staff_id, ps.display_name AS platform_staff_display_name, ss.scope, ss.reason_text, ss.ticket_ref,
      ss.duration_minutes, ss.status, ss.requested_at, ss.decided_at, ss.decision_note, ss.started_at, ss.expires_at, ss.ended_at, ss.ended_by, ss.end_reason, ss.version,
      (SELECT s.id FROM identity.sessions s WHERE s.kind = 'platform' AND s.support_session_id = ss.id LIMIT 1) AS platform_session_id
    FROM identity.support_sessions ss JOIN identity.platform_staff ps ON ps.id = ss.platform_staff_id`;
  const find = async (tx: unknown, id: string): Promise<SRow | undefined> => (await q(tx, `${SELECT} WHERE ss.id = $1`, [id]))[0];
  return {
    async findTenant(tx, id) {
      const r = (await q(tx, `SELECT t.id, t.status, COALESCE(s.support_access_mode, 'notify') AS support_access_mode
        FROM core.tenants t LEFT JOIN identity.tenant_settings s ON s.tenant_id = t.id WHERE t.id = $1`, [id]))[0];
      return r && { id: r.id, status: r.status, supportAccessMode: r.support_access_mode };
    },
    async endActiveForPlatformSession(tx, ps, o) {
      const ids = await q(tx, `UPDATE identity.support_sessions ss SET status = 'ended', ended_at = $2, ended_by = $3, end_reason = 'superseded',
          version = ss.version + 1, updated_at = now(), updated_by = $4
        FROM identity.sessions s WHERE s.id = $1 AND s.kind = 'platform' AND s.support_session_id = ss.id AND ss.status = 'active' RETURNING ss.id`,
      [ps, o.endedAt, o.endedBy, o.actorId]);
      if (!ids.length) return [];
      await q(tx, `UPDATE identity.sessions SET support_session_id = NULL, updated_at = now() WHERE id = $1 AND kind = 'platform'`, [ps]);
      return (await Promise.all(ids.map((r) => find(tx, r.id)))).filter((r): r is SRow => !!r);
    },
    async insert(tx, a) {
      await q(tx, `INSERT INTO identity.support_sessions (id, tenant_id, platform_staff_id, scope, reason_text, ticket_ref, duration_minutes, status,
          started_at, expires_at, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [a.id, a.tenantId, a.platformStaffId, a.scope, a.reasonText, a.ticketRef, a.durationMinutes, a.status, a.startedAt ?? null, a.expiresAt ?? null, a.actorId]);
      return (await find(tx, a.id))!;
    },
    find,
    async update(tx, id, v, p) {
      const hit = await q(tx, `UPDATE identity.support_sessions SET status = $3, started_at = COALESCE($4, started_at), expires_at = COALESCE($5, expires_at),
          ended_at = COALESCE($6, ended_at), ended_by = COALESCE($7, ended_by), end_reason = COALESCE($8, end_reason),
          version = version + 1, updated_at = now(), updated_by = $9
        WHERE id = $1 AND version = $2 RETURNING id`,
      [id, v, p.status, p.startedAt ?? null, p.expiresAt ?? null, p.endedAt ?? null, p.endedBy ?? null, p.endReason ?? null, p.actorId]);
      return hit.length ? find(tx, id) : undefined;
    },
    async bindPlatformSession(tx, ps, sid) {
      await q(tx, `UPDATE identity.sessions SET support_session_id = $2, updated_at = now() WHERE id = $1 AND kind = 'platform'`, [ps, sid]);
    },
    list: (tx, f) => q(tx, `${SELECT}
      WHERE ($1::uuid IS NULL OR ss.tenant_id = $1) AND ($2::text IS NULL OR ss.status = $2) AND ($3::uuid IS NULL OR ss.platform_staff_id = $3)
        AND ($4::uuid IS NULL OR (ss.requested_at, ss.id) < (SELECT c.requested_at, c.id FROM identity.support_sessions c WHERE c.id = $4))
      ORDER BY ss.requested_at DESC, ss.id DESC LIMIT $5`,
    [f.tenantId ?? null, f.status ?? null, f.platformStaffId ?? null, f.cursor ?? null, f.limit ?? LIST_DEFAULT]),
    async insertAccessLog(tx, tenantId, e, meta) {
      if (!meta) throw new LimsError('common.internal');
      await access({ tenantId, requestId: meta.requestId as string, actor: meta.actor, tx }, e);
    },
    async insertNotice(tx, tenantId, n, meta) {
      if (!meta) throw new LimsError('common.internal');
      await q(tx, `INSERT INTO identity.admin_notices (id, tenant_id, kind, subject_type, subject_id, expires_at, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5, now() + $6::interval, $7, $7)`, [uuidv7(), tenantId, n.kind, n.subjectType, n.subjectId, NOTICE_TTL, meta.actor.id]);
    },
  };
}

const failAt = (path: string): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);
};
export const uuidAt = (v: unknown, path: string): string => (typeof v === 'string' && UUID.test(v) ? v : failAt(path));
const optUuid = (v: unknown, path: string) => (v === undefined ? undefined : uuidAt(v, path));
const intIn = (v: unknown, lo: number, hi: number) => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;
const strLen = (v: unknown, lo: number, hi: number) => typeof v === 'string' && v.length >= lo && v.length <= hi;
export function expected(v: unknown): number {
  if (v === undefined || v === null) throw new LimsError('common.precondition_required');
  return intIn(v, 1, 2147483647) ? (v as number) : failAt('/If-Match');
}
const iso = (v: Date | string | null | undefined) => (v === null || v === undefined ? undefined : new Date(v).toISOString());

/** SupportSession (contracts/openapi/identity.yaml): absent optional fields are omitted, never null. */
export function toBody(r: SRow) {
  const opt = {
    decided_at: iso(r.decided_at), decision_note: r.decision_note ?? undefined, started_at: iso(r.started_at),
    expires_at: iso(r.expires_at), ended_at: iso(r.ended_at), end_reason: r.end_reason ?? undefined,
  };
  return {
    support_session_id: r.id, tenant_id: r.tenant_id, platform_staff_id: r.platform_staff_id, platform_staff_display_name: r.platform_staff_display_name,
    scope: r.scope, reason_text: r.reason_text, ticket_ref: r.ticket_ref, duration_minutes: r.duration_minutes, status: r.status,
    requested_at: iso(r.requested_at)!, ...Object.fromEntries(Object.entries(opt).filter(([, v]) => v !== undefined)), version: r.version,
  };
}

/** Authz first (P-8), then the ctx fields the operation relies on. */
function guard(ctx: PlatformCtx, permission: string) {
  PlatformAuthz.assertPlatform(ctx, permission);
  if (typeof ctx.platformStaffId !== 'string' || typeof ctx.platformSessionId !== 'string' || !ctx.tx || typeof ctx.db?.withTenantScope !== 'function') {
    throw new LimsError('auth.unauthenticated');
  }
  return { tx: ctx.tx, staffId: ctx.platformStaffId, psid: ctx.platformSessionId, actorId: ctx.actor.id, now: ctx.now ? ctx.now() : new Date() };
}

export function createSupportService(deps: { repo?: SupportRepo; newId?: () => string } = {}) {
  const repo = deps.repo ?? createSupportRepo();
  const newId = deps.newId ?? uuidv7;

  const meta = (ctx: PlatformCtx): WriteMeta => ({ actor: ctx.actor, requestId: ctx.requestId });
  const logIn = (ctx: PlatformCtx, tenantId: string, action: string, id: string, extra?: () => Promise<void>) =>
    ctx.db.withTenantScope(ctx.tx, tenantId, async () => {
      await repo.insertAccessLog(ctx.tx, tenantId, { action, entityType: 'support_session', entityId: id, outcome: 'allowed' }, meta(ctx));
      if (extra) await extra();
    });
  /** Superseded sessions: close is logged in EACH ended session's own tenant. */
  const logSuperseded = async (ctx: PlatformCtx, ended: SRow[]) => {
    for (const r of ended) await logIn(ctx, r.tenant_id, 'support_session.close', r.id);
  };
  /** Owner + status check shared by activate / end. */
  async function owned(s: ReturnType<typeof guard>, id: string, status: SupportSessionStatus): Promise<SRow> {
    const row = await repo.find(s.tx, id);
    if (!row) throw new LimsError('common.not_found');
    if (row.platform_staff_id !== s.staffId) throw new LimsError('auth.forbidden');
    if (row.status !== status) throw new LimsError('common.version_conflict');
    return row;
  }

  return {
    async openSupportSession(ctx: PlatformCtx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, OPEN);
      const i = input ?? {};
      const tenantId = uuidAt(i['tenantId'], '/tenant_id');
      const scope = i['scope'];
      if (scope !== 'read_only' && scope !== 'admin') return failAt('/scope');
      if (!strLen(i['reasonText'], 10, 500)) failAt('/reason_text');
      if (!strLen(i['ticketRef'], 1, 60)) failAt('/ticket_ref');
      if (!intIn(i['durationMinutes'], 5, 60)) failAt('/duration_minutes');
      const reasonText = i['reasonText'] as string, ticketRef = i['ticketRef'] as string, durationMinutes = i['durationMinutes'] as number;
      if (scope === 'admin' && ctx.platformRole !== 'platform_superadmin') throw new LimsError('auth.forbidden');   // E-6

      const t = await repo.findTenant(s.tx, tenantId);
      if (!t) throw new LimsError('common.not_found');
      if (t.status === 'offboarded') throw new LimsError('auth.forbidden');                                        // SP1 guard [CONV] code
      if (t.status === 'suspended' && scope === 'admin') throw new LimsError('identity.tenant_suspended');          // read_only allowed for diagnosis

      const id = newId();
      const base = { id, tenantId, platformStaffId: s.staffId, platformSessionId: s.psid, scope, reasonText, ticketRef, durationMinutes, actorId: s.actorId } as const;
      if (t.supportAccessMode === 'approval_required') {                                                             // SP2
        const row = await repo.insert(s.tx, { ...base, status: 'requested' });
        await ctx.db.withTenantScope(ctx.tx, tenantId, () =>
          repo.insertNotice(ctx.tx, tenantId, { kind: 'support_session_requested', subjectType: 'support_session', subjectId: id }, meta(ctx)));
        return { status: 201, body: toBody(row), version: row.version };
      }
      // SP1 notify: one active per platform session -> end the previous one first, then bind the new one.
      const ended = await repo.endActiveForPlatformSession(s.tx, s.psid, { endedBy: s.actorId, endedAt: s.now, actorId: s.actorId });
      const row = await repo.insert(s.tx, { ...base, status: 'active', startedAt: s.now, expiresAt: new Date(s.now.getTime() + durationMinutes * 60_000) });
      await repo.bindPlatformSession(s.tx, s.psid, id);
      await logSuperseded(ctx, ended);
      await logIn(ctx, tenantId, 'support_session.open', id, () =>
        repo.insertNotice(ctx.tx, tenantId, { kind: 'support_session_started', subjectType: 'support_session', subjectId: id }, meta(ctx)));
      idMetrics.supportOpened(ctx, scope);   // T28 (02-TRD §13): opened = became active (SP1 here, SP3 in activate)
      return { status: 201, body: toBody(row), version: row.version };
    },

    async activateSupportSession(ctx: PlatformCtx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, OPEN);
      const id = uuidAt(input?.['supportSessionId'], '/support_session_id');
      const v = expected(input?.['expectedVersion']);
      const row = await owned(s, id, 'approved');
      const decided = row.decided_at === null ? NaN : new Date(row.decided_at).getTime();
      if (!(s.now.getTime() - decided <= ACTIVATE_WINDOW_MS) || row.version !== v) throw new LimsError('common.version_conflict');
      const up = await repo.update(s.tx, id, v, {
        status: 'active', startedAt: s.now, expiresAt: new Date(s.now.getTime() + row.duration_minutes * 60_000), actorId: s.actorId,
      });
      if (!up) throw new LimsError('common.version_conflict');
      const ended = await repo.endActiveForPlatformSession(s.tx, s.psid, { endedBy: s.actorId, endedAt: s.now, actorId: s.actorId });
      await repo.bindPlatformSession(s.tx, s.psid, id);
      await logSuperseded(ctx, ended);
      await logIn(ctx, up.tenant_id, 'support_session.activate', id);
      idMetrics.supportOpened(ctx, up.scope);
      return { status: 200, body: toBody(up), version: up.version };
    },

    async endSupportSession(ctx: PlatformCtx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, OPEN);
      const id = uuidAt(input?.['supportSessionId'], '/support_session_id');
      const row = await owned(s, id, 'active');
      const up = await repo.update(s.tx, id, row.version, { status: 'ended', endedAt: s.now, endedBy: s.actorId, endReason: 'ended_by_staff', actorId: s.actorId });
      if (!up) throw new LimsError('common.version_conflict');
      await repo.bindPlatformSession(s.tx, s.psid, null);
      await logIn(ctx, up.tenant_id, 'support_session.close', id);
      return { status: 200, body: toBody(up), version: up.version };
    },

    async listPlatformSupportSessions(ctx: PlatformCtx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, READ);
      const i = input ?? {};
      const tenantId = optUuid(i['tenantId'], '/tenant_id');
      const platformStaffId = optUuid(i['platformStaffId'], '/platform_staff_id');
      const cursor = optUuid(i['cursor'], '/cursor');                                                               // [CONV] cursor = last id
      const status = i['status'];
      if (status !== undefined && !(STATES as readonly unknown[]).includes(status)) failAt('/status');
      const limit = i['limit'] === undefined ? LIST_DEFAULT : intIn(i['limit'], 1, LIST_MAX) ? (i['limit'] as number) : failAt('/limit');
      const f: ListFilter = Object.fromEntries(Object.entries({ tenantId, status, platformStaffId, cursor }).filter(([, v]) => v !== undefined));
      const rows = await repo.list(s.tx, { ...f, limit: limit + 1 });
      const data = rows.slice(0, limit).map(toBody);
      const page = rows.length > limit ? { next_cursor: data[data.length - 1]!.support_session_id, limit } : { limit };
      return { status: 200, body: { data, page } };
    },
  };
}
