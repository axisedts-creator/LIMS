// Default SQL repo of the self service (T10; 02-TRD §5.2; 05-SCHEMA §5.2 sessions__*__own_user / mfa_factors__*__own). SQL on the
// request tx (tenant context, RLS bound by the core); every statement also names tenant_id AND user_id explicitly (defence in depth).
// Literals are bound as parameters. No DELETE.
import type { Tx } from '../../../core/db/tx.js';
import type { FactorRow, SelfRepo, SessRow } from '../service/self.service.js';

type Q = Pick<Tx, 'query'>;
const q = async (tx: unknown, sql: string, params: unknown[]) => (await (tx as Q).query(sql, params)).rows as any[];

const PROFILE_SQL = `SELECT m.id AS membership_id, m.user_id, m.last_login_at, m.all_centres, u.display_name, u.email_normalized AS email,
    coalesce((SELECT array_agg(r.id ORDER BY r.role_code) FROM core.membership_roles mr
              JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.is_active
              WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id), ARRAY[]::uuid[]) AS role_ids,
    coalesce((SELECT array_agg(r.role_code ORDER BY r.role_code) FROM core.membership_roles mr
              JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.is_active
              WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id), ARRAY[]::text[]) AS role_codes,
    coalesce((SELECT array_agg(r.display_name ORDER BY r.role_code) FROM core.membership_roles mr
              JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.is_active
              WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id), ARRAY[]::text[]) AS role_names,
    coalesce((SELECT array_agg(DISTINCT rp.permission_code ORDER BY rp.permission_code) FROM core.membership_roles mr
              JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.is_active
              JOIN core.role_permissions rp ON rp.tenant_id = r.tenant_id AND rp.role_id = r.id
              WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id), ARRAY[]::text[]) AS permissions,
    coalesce((SELECT array_agg(mc.centre_id ORDER BY mc.centre_id) FROM core.membership_centres mc
              WHERE mc.tenant_id = m.tenant_id AND mc.membership_id = m.id), ARRAY[]::uuid[]) AS centre_ids,
    EXISTS (SELECT 1 FROM identity.mfa_factors f WHERE f.tenant_id = m.tenant_id AND f.user_id = m.user_id AND f.status = $5) AS has_verified_factor
  FROM core.memberships m JOIN core.users u ON u.tenant_id = m.tenant_id AND u.id = m.user_id
  WHERE m.tenant_id = $1 AND m.id = $2 AND m.user_id = $3 AND m.actor_type = $4`;

// Partner: no role / permission / centre read (02-TRD s7.1, 08 A28.3: the role comes from the claims; partner claims cannot read core roles).
// [CONV] core.users / core.memberships reads under partner claims are still a spec gap (CR C2.T10).
const PARTNER_PROFILE_SQL = `SELECT m.id AS membership_id, m.user_id, m.last_login_at, u.display_name, u.email_normalized AS email,
    EXISTS (SELECT 1 FROM identity.mfa_factors f WHERE f.tenant_id = m.tenant_id AND f.user_id = m.user_id AND f.status = $5) AS has_verified_factor
  FROM core.memberships m JOIN core.users u ON u.tenant_id = m.tenant_id AND u.id = m.user_id
  WHERE m.tenant_id = $1 AND m.id = $2 AND m.user_id = $3 AND m.actor_type = $4`;

const SESSION_COLS = `s.id, s.tenant_id, s.kind, s.user_id, s.membership_id, s.state, s.aal, s.created_at, s.last_seen_at, s.idle_expires_at,
    s.absolute_expires_at, host(s.client_ip) AS client_ip, s.user_agent, s.support_session_id`;
const LIST_SESSIONS_SQL = `SELECT ${SESSION_COLS}, u.display_name FROM identity.sessions s
  LEFT JOIN core.users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
  WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.state <> ALL ($3::text[])
    AND ($4::timestamptz IS NULL OR (s.last_seen_at, s.id) < ($4::timestamptz, $5::uuid))
  ORDER BY s.last_seen_at DESC, s.id DESC LIMIT $6`;
const FIND_SESSION_SQL = `SELECT ${SESSION_COLS} FROM identity.sessions s WHERE s.tenant_id = $1 AND s.user_id = $2 AND s.id = $3 FOR UPDATE`;
const REVOKE_SQL = `UPDATE identity.sessions SET state = $4, revoked_at = $5, revoked_by = $6, revoke_reason = $7, updated_at = now(), updated_by = $6,
    version = version + 1
  WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND state <> ALL ($8::text[])`;
const REVOKE_OTHERS_SQL = `UPDATE identity.sessions SET state = $5, revoked_at = now(), revoked_by = $6, revoke_reason = $4, updated_at = now(), updated_by = $6,
    version = version + 1
  WHERE tenant_id = $1 AND user_id = $2 AND id <> $3 AND state <> ALL ($7::text[]) RETURNING id, kind`;
const FACTOR_COLS = 'id, tenant_id, user_id, gotrue_factor_id, friendly_name, status, verified_at';
const LIST_FACTORS_SQL = `SELECT ${FACTOR_COLS} FROM identity.mfa_factors WHERE tenant_id = $1 AND user_id = $2 AND status <> $3 ORDER BY created_at, id`;
// Locks EVERY factor row of the user first, so two parallel removals serialise on the "last verified factor" guard.
const LOCK_FACTORS_SQL = `SELECT id FROM identity.mfa_factors WHERE tenant_id = $1 AND user_id = $2 ORDER BY id FOR UPDATE`;
const FIND_FACTOR_SQL = `SELECT ${FACTOR_COLS} FROM identity.mfa_factors WHERE tenant_id = $1 AND user_id = $2 AND id = $3`;
const REMOVE_FACTOR_SQL = `UPDATE identity.mfa_factors SET status = $4, removed_at = $5, removed_by = $6, removal_reason = $7, updated_at = now(),
    updated_by = $6, version = version + 1
  WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND status <> $4`;
const MFA_REQUIRED_SQL = `SELECT EXISTS (SELECT 1 FROM core.membership_roles mr
    JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.is_active AND r.mfa_required
    WHERE mr.tenant_id = $1 AND mr.membership_id = $2) AS required`;
const MIN_LENGTH_SQL = 'SELECT password_min_length FROM identity.tenant_settings WHERE tenant_id = $1';
const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3)';
const TERMINAL = ['revoked', 'expired'];

export function createSelfRepo(): SelfRepo {
  return {
    async getProfile(tx, t, a) {
      const partner = a.actorType === 'partner';
      const r = (await q(tx, partner ? PARTNER_PROFILE_SQL : PROFILE_SQL, [t, a.membershipId, a.userId, a.actorType, 'verified']))[0];
      if (!r) return undefined;
      if (partner) {   // roles / permissions / centres are the service's, from the claims
        return { membershipId: r.membership_id, userId: r.user_id, email: r.email, displayName: r.display_name, roles: [], permissions: [],
          allCentres: false, centreIds: [], lastLoginAt: r.last_login_at ?? null, hasVerifiedFactor: r.has_verified_factor === true };
      }
      const ids: string[] = r.role_ids ?? [], codes: string[] = r.role_codes ?? [], names: string[] = r.role_names ?? [];
      return {
        membershipId: r.membership_id, userId: r.user_id, email: r.email, displayName: r.display_name,
        roles: ids.map((id, i) => ({ role_id: id, code: codes[i]!, name: names[i]! })), permissions: r.permissions ?? [],
        allCentres: r.all_centres === true, centreIds: r.centre_ids ?? [], lastLoginAt: r.last_login_at ?? null, hasVerifiedFactor: r.has_verified_factor === true,
      };
    },
    async listOwnSessions(tx, t, a) {
      return (await q(tx, LIST_SESSIONS_SQL, [t, a.userId, TERMINAL, a.after?.at ?? null, a.after?.id ?? null, a.limit])) as SessRow[];
    },
    async findOwnSession(tx, t, a) {
      return (await q(tx, FIND_SESSION_SQL, [t, a.userId, a.sessionId]))[0] as SessRow | undefined;
    },
    async revokeSession(tx, t, a) {
      await q(tx, REVOKE_SQL, [t, a.userId, a.sessionId, 'revoked', a.at, a.actorId, a.reason, TERMINAL]);
    },
    async revokeOtherSessions(tx, a) {
      return (await q(tx, REVOKE_OTHERS_SQL, [a.tenantId, a.userId, a.exceptSessionId, a.reason, 'revoked', a.actorId, TERMINAL]))
        .map((r) => ({ sessionId: r.id as string, kind: r.kind as string }));
    },
    async listOwnFactors(tx, t, a) {
      return (await q(tx, LIST_FACTORS_SQL, [t, a.userId, 'removed'])) as FactorRow[];
    },
    async findOwnFactor(tx, t, a) {
      await q(tx, LOCK_FACTORS_SQL, [t, a.userId]);
      return (await q(tx, FIND_FACTOR_SQL, [t, a.userId, a.factorId]))[0] as FactorRow | undefined;
    },
    async roleRequiresMfa(tx, t, a) {
      return (await q(tx, MFA_REQUIRED_SQL, [t, a.membershipId]))[0]?.required === true;
    },
    async markFactorRemoved(tx, t, a) {
      await q(tx, REMOVE_FACTOR_SQL, [t, a.userId, a.factorId, 'removed', a.at, a.actorId, a.reason]);
    },
    async enqueue(tx, taskIdentifier, payload, jobKey) {
      await q(tx, ENQUEUE_SQL, [taskIdentifier, JSON.stringify(payload), jobKey]);
    },
    async passwordMinLength(tx, t) {
      const v = (await q(tx, MIN_LENGTH_SQL, [t]))[0]?.password_min_length;
      return typeof v === 'number' ? v : undefined;
    },
  };
}
