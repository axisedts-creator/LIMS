// Default SQL repo of the tenant-access service (T17; 02-TRD §5; 05-SCHEMA §5 sessions__*__tenant, support_sessions__*__tenant,
// admin_notices__*__tenant). SQL on the request tx under the tenant's claims (RLS bound by the core); every statement also names
// tenant_id explicitly (defence in depth). Literals are bound as parameters. No DELETE.
import type { Tx } from '../../../core/db/tx.js';
import type { NoticeRow, TenantAccessRepo } from '../service/tenant-access.service.js';
import type { SessRow } from '../service/self.service.js';
import type { SRow } from '../service/support.service.js';

type Q = Pick<Tx, 'query'>;
const q = async (tx: unknown, sql: string, params: unknown[]) => (await (tx as Q).query(sql, params)).rows as any[];
const TERMINAL = ['revoked', 'expired'];

const SESSION_COLS = `s.id, s.tenant_id, s.kind, s.user_id, s.membership_id, s.state, s.aal, s.created_at, s.last_seen_at, s.idle_expires_at,
    s.absolute_expires_at, host(s.client_ip) AS client_ip, s.user_agent, s.support_session_id`;
const LIST_SESSIONS_SQL = `SELECT ${SESSION_COLS}, u.display_name FROM identity.sessions s
  LEFT JOIN core.users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
  WHERE s.tenant_id = $1 AND ($2::uuid IS NULL OR s.membership_id = $2) AND ($3::text IS NULL OR s.state = $3)
    AND ($4::timestamptz IS NULL OR (s.last_seen_at, s.id) < ($4::timestamptz, $5::uuid))
  ORDER BY s.last_seen_at DESC, s.id DESC LIMIT $6`;
const FIND_SESSION_SQL = `SELECT ${SESSION_COLS} FROM identity.sessions s WHERE s.tenant_id = $1 AND s.id = $2 FOR UPDATE`;
const REVOKE_SQL = `UPDATE identity.sessions SET state = $3, revoked_at = $4, revoked_by = $5, revoke_reason = $6, updated_at = now(), updated_by = $5,
    version = version + 1
  WHERE tenant_id = $1 AND id = $2 AND state <> ALL ($7::text[])`;
const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3)';

// [CR-C2-T17] no lims_app policy lets tenant claims read identity.platform_staff: LEFT JOIN so rows are not lost; the name is '' until the CR lands.
const SUPPORT_COLS =`ss.id, ss.tenant_id, ss.platform_staff_id, COALESCE(ps.display_name, '') AS platform_staff_display_name, ss.scope, ss.reason_text, ss.ticket_ref,
    ss.duration_minutes, ss.status, ss.requested_at, ss.decided_at, ss.decision_note, ss.started_at, ss.expires_at, ss.ended_at, ss.ended_by, ss.end_reason,
    ss.version, NULL::uuid AS platform_session_id`;
const LIST_SUPPORT_SQL = `SELECT ${SUPPORT_COLS} FROM identity.support_sessions ss LEFT JOIN identity.platform_staff ps ON ps.id = ss.platform_staff_id
  WHERE ss.tenant_id = $1 AND ($2::text IS NULL OR ss.status = $2) ORDER BY ss.requested_at DESC, ss.id DESC LIMIT $3`;
const FIND_SUPPORT_SQL = `SELECT ${SUPPORT_COLS} FROM identity.support_sessions ss LEFT JOIN identity.platform_staff ps ON ps.id = ss.platform_staff_id
  WHERE ss.tenant_id = $1 AND ss.id = $2 FOR UPDATE OF ss`;
const UPDATE_SUPPORT_SQL = `UPDATE identity.support_sessions SET status = $4, decided_at = COALESCE($5, decided_at),
    decided_by_membership_id = COALESCE($6, decided_by_membership_id), decision_note = COALESCE($7, decision_note), ended_at = COALESCE($8, ended_at),
    ended_by = COALESCE($9, ended_by), end_reason = COALESCE($10, end_reason), version = version + 1, updated_at = now(), updated_by = $11
  WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id`;
// [CR-C2-T17] platform session rows have tenant_id NULL: under tenant claims RLS hides them, so this is a no-op until the CR lands.
const UNBIND_SQL = `UPDATE identity.sessions s SET support_session_id = NULL, updated_at = now()
  WHERE s.kind = 'platform' AND s.support_session_id = $2
    AND EXISTS (SELECT 1 FROM identity.support_sessions ss WHERE ss.tenant_id = $1 AND ss.id = $2)`;

const NOTICE_COLS = 'id, tenant_id, kind, subject_type, subject_id, created_for_membership_id, dismissed_by, created_at, expires_at';
const LIST_NOTICES_SQL = `SELECT ${NOTICE_COLS} FROM identity.admin_notices
  WHERE tenant_id = $1 AND expires_at > $3 AND NOT ($2::uuid = ANY (dismissed_by))
    AND (created_for_membership_id IS NULL OR created_for_membership_id = $2)
  ORDER BY created_at DESC, id DESC LIMIT 200`;
const FIND_NOTICE_SQL = `SELECT ${NOTICE_COLS} FROM identity.admin_notices WHERE tenant_id = $1 AND id = $2 FOR UPDATE`;
const DISMISS_SQL = `UPDATE identity.admin_notices SET dismissed_by = array_append(dismissed_by, $3::uuid), version = version + 1, updated_at = now(), updated_by = $4
  WHERE tenant_id = $1 AND id = $2 AND NOT ($3::uuid = ANY (dismissed_by))`;

export function createTenantAccessRepo(): TenantAccessRepo {
  const findSupport = async (tx: unknown, t: string, id: string) => (await q(tx, FIND_SUPPORT_SQL, [t, id]))[0] as SRow | undefined;
  return {
    async listSessions(tx, t, a) {
      return (await q(tx, LIST_SESSIONS_SQL, [t, a.membershipId ?? null, a.state ?? null, a.after?.at ?? null, a.after?.id ?? null, a.limit])) as SessRow[];
    },
    async findSession(tx, t, a) {
      return (await q(tx, FIND_SESSION_SQL, [t, a.sessionId]))[0] as SessRow | undefined;
    },
    async revokeSession(tx, t, a) {
      await q(tx, REVOKE_SQL, [t, a.sessionId, 'revoked', a.at, a.actorId, a.reason, TERMINAL]);
    },
    async enqueue(tx, taskIdentifier, payload, jobKey) {
      await q(tx, ENQUEUE_SQL, [taskIdentifier, JSON.stringify(payload), jobKey]);
    },
    async listSupportSessions(tx, t, a) {
      return (await q(tx, LIST_SUPPORT_SQL, [t, a.status ?? null, a.limit])) as SRow[];
    },
    findSupportSession: (tx, t, a) => findSupport(tx, t, a.supportSessionId),
    async updateSupportSession(tx, t, a) {
      const p = a.patch;
      const hit = await q(tx, UPDATE_SUPPORT_SQL, [t, a.supportSessionId, a.expectedVersion, p.status, p.decidedAt ?? null, p.decidedByMembershipId ?? null,
        p.decisionNote ?? null, p.endedAt ?? null, p.endedBy ?? null, p.endReason ?? null, p.actorId]);
      return hit.length ? findSupport(tx, t, a.supportSessionId) : undefined;
    },
    async unbindSupportSession(tx, t, a) {
      await q(tx, UNBIND_SQL, [t, a.supportSessionId]);
    },
    async listNotices(tx, t, a) {
      return (await q(tx, LIST_NOTICES_SQL, [t, a.membershipId, a.now])) as NoticeRow[];
    },
    async findNotice(tx, t, a) {
      return (await q(tx, FIND_NOTICE_SQL, [t, a.noticeId]))[0] as NoticeRow | undefined;
    },
    async dismissNotice(tx, t, a) {
      await q(tx, DISMISS_SQL, [t, a.noticeId, a.membershipId, a.actorId]);
    },
  };
}
