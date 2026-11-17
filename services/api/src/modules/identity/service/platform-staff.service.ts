// Platform staff, platform sessions, platform auth events (06 T25; 01-PRD US-E6; 02-TRD §5.10, §10; 07-SECURITY REQ-SEC-063, A-9).
// Platform context only; every operation runs PlatformAuthz.assertPlatform before any repo / GoTrue call. No SQL here: rows come
// through the injected PlatformStaffRepo; the platform_events writer is injected by handlers/platform-staff.http.ts.
// NULL-tenant staff actions write platform_events only (08 A25 D-215). Errors and events never carry e-mail, names or CIDR values.
import { isIP } from 'node:net';
import { LimsError, type FieldError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as role.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { GoTrueGateway } from '../gotrue/gateway.js';
import { PlatformAuthz } from '../platform/authz.js';
import { AUTH_EVENT_TYPES, after, authEvent, optText, optUuid, page, paged } from './audit-view.service.js';

const MANAGE = 'platform.staff.manage';
const READ = 'platform.tenant.read';
const ROLES = ['platform_superadmin', 'platform_support'] as const;
const SUPER = 'platform_superadmin';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_TTL_MS = 72 * 3_600_000;   // 03-APP-FLOW §4.1 invitations expires_at = now()+72h [CONV] same for platform staff
const MAX_CIDRS = 20;                   // platform_staff__cidrs__ck
const PG_INT_MAX = 2147483647;

type Role = (typeof ROLES)[number];
export interface StaffRow {
  id: string; user_id: string; email_normalized: string; display_name: string; role_code: Role; allowed_cidrs: string[];
  last_login_at: Date | string | null; is_active: boolean; version: number;
}
export interface SessionRow {
  id: string; kind: string; user_id: string; platform_staff_id: string | null; display_name?: string; state: string; aal?: string;
  created_at?: Date | string; last_seen_at?: Date | string; idle_expires_at?: Date | string; absolute_expires_at?: Date | string;
  client_ip?: string | null; user_agent?: string | null; support_session_id?: string | null;
}
export interface StaffPatch { displayName?: string; roleCode?: Role; allowedCidrs?: string[]; isActive?: boolean; actorId: string }
export interface PlatformStaffRepo {
  listStaff(tx: unknown): Promise<StaffRow[]>;
  findStaff(tx: unknown, id: string): Promise<StaffRow | undefined>;
  findStaffByEmail(tx: unknown, emailNormalized: string): Promise<StaffRow | undefined>;
  insertStaff(tx: unknown, a: { id: string; userId: string; emailNormalized: string; displayName: string; roleCode: Role; allowedCidrs: string[]; actorId: string }): Promise<StaffRow>;
  updateStaff(tx: unknown, id: string, expectedVersion: number, p: StaffPatch): Promise<StaffRow | undefined>;
  touchStaff(tx: unknown, id: string, actorId: string): Promise<StaffRow | undefined>;
  lockActiveSuperadmins(tx: unknown): Promise<string[]>;
  insertInvitation(tx: unknown, a: { id: string; userId: string; platformStaffId: string; email: string; expiresAt: Date; actorId: string }): Promise<void>;
  enqueue(tx: unknown, identifier: string, payload: Record<string, unknown>, jobKey: string): Promise<void>;
  listPlatformSessions(tx: unknown): Promise<SessionRow[]>;
  findSession(tx: unknown, id: string): Promise<SessionRow | undefined>;
  revokeSession(tx: unknown, id: string, o: { at: Date; actorId: string }): Promise<void>;
  /** Revokes every non-terminal kind='platform' session of the staff row; returns the count. */
  revokeStaffSessions(tx: unknown, o: { platformStaffId: string; reason: 'deactivate' | 'mfa_reset'; at: Date; actorId: string }): Promise<number>;
  /** Mirror rows of the platform user (tenant_id IS NULL) -> removed / admin_reset; returns the count. */
  removeStaffMfaFactors(tx: unknown, o: { userId: string; actorId: string }): Promise<number>;
  listAuthEvents(tx: unknown, p: { from: string; to: string; after: { at: string; id: string }; limit: number; f: { tenant_id?: string | undefined; event_type?: string | undefined } }): Promise<any[]>;
}
export interface PlatformEvent {
  eventType: 'platform_staff_invited' | 'platform_staff_changed' | 'platform_staff_deactivated' | 'platform_mfa_reset' | 'platform_session_revoked';
  targetType: 'platform_staff' | 'session'; targetId: string; targetTenantId: null; detail: Record<string, unknown>;
  actorPlatformStaffId: string; actorId: string; requestId?: string; clientIp?: string;
}
export interface PlatformStaffCtx {
  readonly actor: { readonly type: string; readonly id: string };
  readonly platformRole: string;
  readonly platformStaffId: string;
  readonly platformSessionId: string;
  readonly aal?: string;
  readonly requestId?: string;
  readonly clientIp?: string;
  readonly tx: unknown;
  readonly now?: () => Date;
}
export interface Result { status: number; body: any; version?: number }
type In = Record<string, unknown>;

const failAt = (path: string): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);
};
const idOrNotFound = (v: unknown): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw new LimsError('common.not_found');
  return v.toLowerCase();
};
function expectedVersion(v: unknown): number {
  if (v === undefined || v === null) throw new LimsError('common.precondition_required');
  return Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= PG_INT_MAX ? (v as number) : failAt('/If-Match');
}
const displayName = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' && [...v].length <= 120 ? v : failAt('/display_name'));
const roleCode = (v: unknown): Role => ((ROLES as readonly unknown[]).includes(v) ? (v as Role) : failAt('/role_code'));

/** Bits of an IP address as a bigint (v4: 32, v6: 128); undefined when unparsable. */
function ipBits(ip: string, fam: 4 | 6): bigint | undefined {
  if (fam === 4) return ip.split('.').reduce((a, o) => (a << 8n) | BigInt(Number(o)), 0n);
  let s = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) { const b = ipBits(v4[1]!, 4)!; s = s.slice(0, -v4[1]!.length) + `${(b >> 16n).toString(16)}:${(b & 0xffffn).toString(16)}`; }
  const [head = '', tail] = s.split('::');
  const h = head ? head.split(':') : []; const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.length === 8 ? groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n) : undefined;
}
/** A pg `cidr` literal: address/prefix with no host bits set (pg rejects '10.0.0.1/8'). */
function isCidr(v: unknown): boolean {
  if (typeof v !== 'string' || v.length > 43) return false;
  const m = /^([0-9a-fA-F:.]+)\/([0-9]{1,3})$/.exec(v);
  if (!m) return false;
  const fam = isIP(m[1]!);
  if (fam !== 4 && fam !== 6) return false;
  const width = fam === 4 ? 32 : 128; const prefix = Number(m[2]);
  if (prefix > width) return false;
  const bits = ipBits(m[1]!, fam);
  if (bits === undefined) return false;
  const host = (1n << BigInt(width - prefix)) - 1n;
  return (bits & host) === 0n;
}
const cidrList = (v: unknown): string[] =>
  Array.isArray(v) && v.length <= MAX_CIDRS && v.every(isCidr) ? [...(v as string[])] : failAt('/allowed_cidrs');

const iso = (v: Date | string) => new Date(v).toISOString();
const maskEmail = (e: string) => {
  const [local = '', domain = ''] = e.split('@');
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***`;
};
export const maskIp = (ip: string) => {
  if (isIP(ip) === 4) return ip.split('.').slice(0, 2).join('.') + '.x.x';
  if (isIP(ip) === 6) return ip.split(':').slice(0, 2).join(':') + ':x:x';
  return undefined;
};
export function uaFamily(ua: string): string {
  for (const [re, name] of [[/Edg\//, 'Edge'], [/OPR\/|Opera/, 'Opera'], [/Firefox\//, 'Firefox'], [/Chrome\//, 'Chrome'], [/Safari\//, 'Safari']] as const) {
    if (re.test(ua)) return name;
  }
  return 'Other';
}
const omitEmpty = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/** PlatformStaff (identity.yaml): masked e-mail only; no user id or audit columns; absent optionals omitted. */
const toStaff = (r: StaffRow) => omitEmpty({
  platform_staff_id: r.id, display_name: r.display_name, email_masked: maskEmail(r.email_normalized), role_code: r.role_code,
  allowed_cidrs: [...r.allowed_cidrs], is_active: r.is_active, last_login_at: r.last_login_at === null ? undefined : iso(r.last_login_at), version: r.version,
});
/** SessionSummary: whitelisted keys only, IP masked, user agent reduced to its family. */
const toSession = (r: SessionRow) => omitEmpty({
  session_id: r.id, platform_staff_id: r.platform_staff_id, display_name: r.display_name, state: r.state, aal: r.aal,
  created_at: r.created_at && iso(r.created_at), last_seen_at: r.last_seen_at && iso(r.last_seen_at),
  idle_expires_at: r.idle_expires_at && iso(r.idle_expires_at), absolute_expires_at: r.absolute_expires_at && iso(r.absolute_expires_at),
  client_ip_masked: r.client_ip ? maskIp(r.client_ip) : undefined, user_agent_family: r.user_agent ? uaFamily(r.user_agent) : undefined,
  is_support: !!r.support_session_id,
});

export function createPlatformStaffService(deps: {
  repo?: PlatformStaffRepo; gotrue?: Pick<GoTrueGateway, 'adminCreateUser'>; platformEvents?: { insert(tx: unknown, e: PlatformEvent): Promise<void> }; newId?: () => string;
} = {}) {
  const newId = deps.newId ?? uuidv7;
  const need = <T>(v: T | undefined): T => { if (!v) throw new LimsError('common.internal'); return v; };   // fail closed when unwired

  /** Authz first, then the ctx fields every operation relies on. */
  function guard(ctx: PlatformStaffCtx, permission: string) {
    PlatformAuthz.assertPlatform(ctx, permission);
    if (typeof ctx.platformStaffId !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
    return { tx: ctx.tx, repo: need(deps.repo), actorId: ctx.actor.id, now: ctx.now ? ctx.now() : new Date() };
  }
  const emit = (ctx: PlatformStaffCtx, e: Pick<PlatformEvent, 'eventType' | 'targetType' | 'targetId' | 'detail'>) =>
    need(deps.platformEvents).insert(ctx.tx, {
      ...e, targetTenantId: null, actorPlatformStaffId: ctx.platformStaffId, actorId: ctx.actor.id,
      ...(ctx.requestId !== undefined ? { requestId: ctx.requestId } : {}), ...(ctx.clientIp !== undefined ? { clientIp: ctx.clientIp } : {}),
    });
  /** identity.last_admin_protected: the set is locked FOR UPDATE before the write that would remove `row` from it. */
  async function keepOneSuperadmin(s: ReturnType<typeof guard>, row: StaffRow) {
    if (row.role_code !== SUPER || !row.is_active) return;
    const active = await s.repo.lockActiveSuperadmins(s.tx);
    if (!active.some((id) => id !== row.id)) throw new LimsError('identity.last_admin_protected');
  }
  async function found(s: ReturnType<typeof guard>, id: string): Promise<StaffRow> {
    const row = await s.repo.findStaff(s.tx, id);
    if (!row) throw new LimsError('common.not_found');
    return row;
  }

  return {
    async listPlatformStaff(ctx: PlatformStaffCtx, _input: In = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      return { status: 200, body: { data: (await s.repo.listStaff(s.tx)).map(toStaff) } };
    },

    async invitePlatformStaff(ctx: PlatformStaffCtx, input: In = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      const i = input ?? {};
      const raw = i['email'];
      const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (email.length < 3 || email.length > 254 || !EMAIL.test(email)) failAt('/email');
      const name = displayName(i['displayName']);
      const role = roleCode(i['roleCode']);
      const allowedCidrs = i['allowedCidrs'] === undefined ? [] : cidrList(i['allowedCidrs']);

      if (await s.repo.findStaffByEmail(s.tx, email)) throw new LimsError('identity.user_exists');
      const user = await need(deps.gotrue).adminCreateUser({ email, emailConfirm: false });
      if ('exists' in user) throw new LimsError('identity.user_exists');   // e.g. a tenant user: one GoTrue user is never shared

      const row = await s.repo.insertStaff(s.tx, { id: newId(), userId: user.userId, emailNormalized: email, displayName: name, roleCode: role, allowedCidrs, actorId: s.actorId });
      const invitationId = newId();
      await s.repo.insertInvitation(s.tx, { id: invitationId, userId: user.userId, platformStaffId: row.id, email, expiresAt: new Date(s.now.getTime() + INVITE_TTL_MS), actorId: s.actorId });
      await s.repo.enqueue(s.tx, 'identity.send_invitation', { invitation_id: invitationId }, `invite:${invitationId}:1`);
      await emit(ctx, { eventType: 'platform_staff_invited', targetType: 'platform_staff', targetId: row.id, detail: { role_code: role } });
      return { status: 201, body: toStaff(row), version: row.version };
    },

    async updatePlatformStaff(ctx: PlatformStaffCtx, input: In = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      const i = input ?? {};
      const id = idOrNotFound(i['platformStaffId']);
      const v = expectedVersion(i['expectedVersion']);
      const patch: StaffPatch = { actorId: s.actorId };
      const changed: string[] = [];
      if (i['displayName'] !== undefined) { patch.displayName = displayName(i['displayName']); changed.push('display_name'); }
      if (i['roleCode'] !== undefined) { patch.roleCode = roleCode(i['roleCode']); changed.push('role_code'); }
      if (i['allowedCidrs'] !== undefined) { patch.allowedCidrs = cidrList(i['allowedCidrs']); changed.push('allowed_cidrs'); }
      if (!changed.length) failAt('/');

      const row = await found(s, id);
      if (row.version !== v) throw new LimsError('common.version_conflict');
      if (patch.roleCode !== undefined && patch.roleCode !== SUPER) await keepOneSuperadmin(s, row);
      const up = await s.repo.updateStaff(s.tx, id, v, patch);
      if (!up) throw new LimsError('common.version_conflict');
      await emit(ctx, { eventType: 'platform_staff_changed', targetType: 'platform_staff', targetId: id, detail: { changed } });
      return { status: 200, body: toStaff(up), version: up.version };
    },

    async deactivatePlatformStaff(ctx: PlatformStaffCtx, input: In = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      const id = idOrNotFound(input?.['platformStaffId']);
      const v = expectedVersion(input?.['expectedVersion']);
      if (id === ctx.platformStaffId.toLowerCase()) throw new LimsError('identity.self_action_forbidden');
      const row = await found(s, id);
      if (row.version !== v) throw new LimsError('common.version_conflict');
      await keepOneSuperadmin(s, row);
      const up = await s.repo.updateStaff(s.tx, id, v, { isActive: false, actorId: s.actorId });
      if (!up) throw new LimsError('common.version_conflict');
      // 03-APP-FLOW §1 SS9: deactivate revokes every non-terminal session in the request tx.
      await s.repo.revokeStaffSessions(s.tx, { platformStaffId: id, reason: 'deactivate', at: s.now, actorId: s.actorId });
      // 02-TRD §10: platform kind -> payload {user_id} only; job_key signout:<user_id>:<reason>.
      await s.repo.enqueue(s.tx, 'identity.gotrue_signout', { user_id: up.user_id }, `signout:${up.user_id}:deactivate`);
      await emit(ctx, { eventType: 'platform_staff_deactivated', targetType: 'platform_staff', targetId: id, detail: {} });
      return { status: 200, body: toStaff(up), version: up.version };
    },

    async resetPlatformStaffMfa(ctx: PlatformStaffCtx, input: In = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      const id = idOrNotFound(input?.['platformStaffId']);
      if (id === ctx.platformStaffId.toLowerCase()) throw new LimsError('identity.self_action_forbidden');
      await found(s, id);
      const up = await s.repo.touchStaff(s.tx, id, s.actorId);   // moves the version, so each reset gets its own job_key
      if (!up) throw new LimsError('common.not_found');
      // 03-APP-FLOW §4.5 / SS9: the mirror is authoritative - factors removed and sessions revoked now; the job syncs GoTrue.
      await s.repo.removeStaffMfaFactors(s.tx, { userId: up.user_id, actorId: s.actorId });
      await s.repo.revokeStaffSessions(s.tx, { platformStaffId: id, reason: 'mfa_reset', at: s.now, actorId: s.actorId });
      await s.repo.enqueue(s.tx, 'identity.remove_mfa_factors', { user_id: up.user_id, platform_staff_id: id }, `mfa_reset:${id}:${up.version}`);
      await emit(ctx, { eventType: 'platform_mfa_reset', targetType: 'platform_staff', targetId: id, detail: {} });
      return { status: 200, body: toStaff(up), version: up.version };
    },

    async listPlatformSessions(ctx: PlatformStaffCtx, _input: In = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      const rows = (await s.repo.listPlatformSessions(s.tx)).filter((r) => r.kind === 'platform');
      return { status: 200, body: { data: rows.map(toSession) } };
    },

    async revokePlatformSession(ctx: PlatformStaffCtx, input: In = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      const id = idOrNotFound(input?.['sessionId']);
      if (typeof ctx.platformSessionId === 'string' && id === ctx.platformSessionId.toLowerCase()) throw new LimsError('identity.self_action_forbidden');   // use logout
      const row = await s.repo.findSession(s.tx, id);
      if (!row || row.kind !== 'platform') throw new LimsError('common.not_found');
      if (row.state === 'revoked' || row.state === 'expired') return { status: 204, body: undefined };   // idempotent: no second job / event
      await s.repo.revokeSession(s.tx, id, { at: s.now, actorId: s.actorId });
      await s.repo.enqueue(s.tx, 'identity.gotrue_signout', { user_id: row.user_id }, `signout:${id}:admin_revoke`);
      await emit(ctx, { eventType: 'platform_session_revoked', targetType: 'session', targetId: id, detail: {} });
      return { status: 204, body: undefined };
    },

    /** Date rule as §5.9 (shared with listAuthEvents); no tenant predicate unless filtered, so tenant-less events are included. */
    async listPlatformAuthEvents(ctx: PlatformStaffCtx, q: In = {}): Promise<Result> {
      const s = guard(ctx, READ);
      const query = q ?? {};
      const p = page(query);
      const f = { tenant_id: optUuid(query, 'tenant_id'), event_type: optText(query, 'event_type', (x) => AUTH_EVENT_TYPES.has(x)) };
      const rows = await s.repo.listAuthEvents(s.tx, { from: p.from, to: p.to, after: after(p, false), limit: p.limit + 1, f });
      return { status: 200, body: paged(rows, p.limit, authEvent) };
    },
  };
}
