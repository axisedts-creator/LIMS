// SQL of T25: platform staff, platform-kind sessions, platform auth events, platform_events (02-TRD §5.10; 05-SCHEMA §4.10).
// Every method runs on the request tx under platform claims. Session reads name their columns explicitly (no credential column
// ever leaves the table); the auth-event list never reads the e-mail digest column.
// Optional filters are `($n IS NULL OR col = $n)` (same pattern as audit-read.repo).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { PlatformStaffRepo, StaffRow } from '../service/platform-staff.service.js';

interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
const q = async (tx: unknown, text: string, values: unknown[] = []) => (await (tx as Tx).query(text, values)).rows;

const STAFF_COLS = `id, user_id, email_normalized, display_name, role_code, allowed_cidrs::text[] AS allowed_cidrs, last_login_at, is_active, version`;
const n = <T>(v: T | undefined) => (v === undefined ? null : v);

/** pg returns text[] as an array once parsed; tolerate the '{a,b}' literal form. */
function cidrs(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string') return [];
  const inner = v.replace(/^\{|\}$/g, '').trim();
  return inner ? inner.split(',').map((s) => s.trim().replace(/^"|"$/g, '')) : [];
}
const staff = (r: any): StaffRow | undefined => (r ? { ...r, allowed_cidrs: cidrs(r.allowed_cidrs) } : undefined);

export function createPlatformStaffRepo(): PlatformStaffRepo & { insertPlatformEvent(tx: unknown, e: PlatformEventInsert): Promise<void> } {
  return {
    async listStaff(tx) {
      return (await q(tx, `SELECT ${STAFF_COLS} FROM identity.platform_staff ORDER BY display_name, id LIMIT 200`)).map((r) => staff(r)!);
    },
    async findStaff(tx, id) {
      return staff((await q(tx, `SELECT ${STAFF_COLS} FROM identity.platform_staff WHERE id = $1`, [id]))[0]);
    },
    async findStaffByEmail(tx, email) {
      return staff((await q(tx, `SELECT ${STAFF_COLS} FROM identity.platform_staff WHERE email_normalized = $1`, [email]))[0]);
    },
    async insertStaff(tx, a) {
      return staff((await q(tx, `INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, allowed_cidrs, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6::cidr[], $7, $7) RETURNING ${STAFF_COLS}`,
      [a.id, a.userId, a.emailNormalized, a.displayName, a.roleCode, a.allowedCidrs, a.actorId]))[0])!;
    },
    async updateStaff(tx, id, expectedVersion, p) {
      return staff((await q(tx, `UPDATE identity.platform_staff SET display_name = COALESCE($3, display_name), role_code = COALESCE($4, role_code),
          allowed_cidrs = COALESCE($5::cidr[], allowed_cidrs), is_active = COALESCE($6, is_active),
          version = version + 1, updated_at = now(), updated_by = $7
        WHERE id = $1 AND version = $2 RETURNING ${STAFF_COLS}`,
      [id, expectedVersion, n(p.displayName), n(p.roleCode), n(p.allowedCidrs), n(p.isActive), p.actorId]))[0]);
    },
    async touchStaff(tx, id, actorId) {
      return staff((await q(tx, `UPDATE identity.platform_staff SET version = version + 1, updated_at = now(), updated_by = $2
        WHERE id = $1 RETURNING ${STAFF_COLS}`, [id, actorId]))[0]);
    },
    /** Serialises concurrent demote / deactivate: the second waiter re-reads the set after the first commits. */
    async lockActiveSuperadmins(tx) {
      return (await q(tx, `SELECT id FROM identity.platform_staff WHERE role_code = 'platform_superadmin' AND is_active ORDER BY id FOR UPDATE`)).map((r) => r.id as string);
    },
    async insertInvitation(tx, a) {
      await q(tx, `INSERT INTO identity.invitations (id, tenant_id, user_id, membership_id, platform_staff_id, email, status, expires_at, invited_by, created_by, updated_by)
        VALUES ($1, NULL, $2, NULL, $3, $4, 'pending', $5, $6, $6, $6)`, [a.id, a.userId, a.platformStaffId, a.email, a.expiresAt, a.actorId]);
    },
    async enqueue(tx, identifier, payload, jobKey) {
      await q(tx, 'SELECT app.enqueue_job($1, $2::jsonb, $3)', [identifier, JSON.stringify(payload), jobKey]);
    },
    async listPlatformSessions(tx) {
      return q(tx, `SELECT s.id, s.kind, s.user_id, s.platform_staff_id, ps.display_name, s.state, s.aal, s.created_at, s.last_seen_at, s.idle_expires_at,
          s.absolute_expires_at, host(s.client_ip) AS client_ip, s.user_agent, s.support_session_id
        FROM identity.sessions s JOIN identity.platform_staff ps ON ps.id = s.platform_staff_id
        WHERE s.kind = 'platform' AND s.state NOT IN ('revoked', 'expired')
        ORDER BY s.last_seen_at DESC, s.id DESC LIMIT 200`);
    },
    async findSession(tx, id) {
      return (await q(tx, `SELECT id, kind, user_id, platform_staff_id, state FROM identity.sessions WHERE id = $1 AND kind = 'platform'`, [id]))[0];
    },
    async revokeSession(tx, id, o) {
      await q(tx, `UPDATE identity.sessions SET state = 'revoked', revoked_at = $2, revoked_by = $3, revoke_reason = 'admin_revoke',
          version = version + 1, updated_at = now(), updated_by = $3
        WHERE id = $1 AND kind = 'platform' AND state NOT IN ('revoked', 'expired')`, [id, o.at, o.actorId]);
    },
    async revokeStaffSessions(tx, o) {
      return (await q(tx, `UPDATE identity.sessions SET state = 'revoked', revoked_at = $3, revoked_by = $4, revoke_reason = $2,
          version = version + 1, updated_at = now(), updated_by = $4
        WHERE kind = 'platform' AND platform_staff_id = $1 AND state NOT IN ('revoked', 'expired') RETURNING id`,
      [o.platformStaffId, o.reason, o.at, o.actorId])).length;
    },
    async removeStaffMfaFactors(tx, o) {
      return (await q(tx, `UPDATE identity.mfa_factors SET status = 'removed', removal_reason = 'admin_reset', removed_at = now(), removed_by = $2,
          version = version + 1, updated_at = now(), updated_by = $2
        WHERE tenant_id IS NULL AND user_id = $1 AND status <> 'removed' RETURNING id`, [o.userId, o.actorId])).length;
    },
    async listAuthEvents(tx, p) {
      return q(tx, `SELECT id, occurred_at, occurred_at::text AS cursor_at, tenant_id, user_id, membership_id, platform_staff_id, session_id,
          event_type, reason_code, client_ip, user_agent, request_id
        FROM identity.auth_events
        WHERE occurred_at >= $1::timestamptz AND occurred_at <= $2::timestamptz
          AND (occurred_at, id) < ($3::timestamptz, $4::uuid)
          AND ($5::uuid IS NULL OR tenant_id = $5) AND ($6::text IS NULL OR event_type = $6)
        ORDER BY occurred_at DESC, id DESC
        LIMIT $7`, [p.from, p.to, p.after.at, p.after.id, n(p.f.tenant_id), n(p.f.event_type), p.limit]);
    },
    async insertPlatformEvent(tx, e) {
      await q(tx, `INSERT INTO identity.platform_events (id, event_type, target_type, target_id, target_tenant_id, detail, actor_platform_staff_id, request_id, client_ip, created_by)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::inet, $10)`,
      [uuidv7(), e.eventType, e.targetType, e.targetId, e.targetTenantId, JSON.stringify(e.detail), e.actorPlatformStaffId, e.requestId ?? null, e.clientIp ?? null, e.actorId]);
    },
  };
}

export interface PlatformEventInsert {
  eventType: string; targetType: string; targetId: string; targetTenantId: null; detail: Record<string, unknown>;
  actorPlatformStaffId: string; actorId: string; requestId?: string; clientIp?: string;
}
