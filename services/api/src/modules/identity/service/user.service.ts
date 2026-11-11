// Users API (02-TRD §5.3; 03-APP-FLOW §2.2, §4.1-4.5; 01-PRD AC-B1.1-5, AC-B2.3-4, AC-B3.3, AC-B4.1-4, US-B5, US-B6; 07-SECURITY D-T7, D-T8, D-T13).
// Tenant and actor come from ctx only; every SQL statement names tenant_id on top of RLS (REQ-SEC-040). Only actor_type 'user' memberships are
// addressed: partner / patient ids behave as not found. Every membership write is ONE version-guarded UPDATE (`updateMembership`, bumps version).
// Sessions revoked in the request tx get an identity.gotrue_signout job committed with it (SS9).
import { LimsError, type FieldError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as role.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { GoTrueGateway } from '../gotrue/gateway.js';
import type { AuthEvent } from '../repository/auth-events.repo.js';
import { createAssetsRepo } from '../repository/assets.repo.js';
import { createInvitationsRepo } from '../repository/invitations.repo.js';

type Access = { action: string; entityType: string; entityId?: string; outcome: 'allowed' | 'denied' };
export interface UserCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly requestId?: string;
  readonly clientIp?: string;
  readonly tx: unknown;
  readonly now?: () => string | Date;
  readonly audit?: { access(entry: Access): Promise<unknown> };
  // core request helpers (03-IC §13.6); absent -> TypeError -> 500 (fail closed)
  readonly uploads: { accept(file: unknown, opts: unknown): Promise<any> };
  readonly storage: { delete(bucket: any, objectPath: string): Promise<void> };
}
export interface Result { status: number; body: any; version?: number }

export type Role = { id: string; code: string; name: string; is_active: boolean; permission_codes: string[] };
export type MemberView = {
  id: string; user_id: string; actor_type: string; status: 'invited' | 'active' | 'deactivated'; display_name: string; email_normalized: string;
  phone_e164: string | null; all_centres: boolean; version: number; accepted_at: unknown; locked_at: unknown; lock_reason_code: string | null;
  last_login_at: unknown; signatory_display_title: string | null; signatory_registration_no: string | null; signature_asset_id: string | null;
  role_ids: string[]; centre_ids: string[]; branch_ids: string[]; mfa_enrolled: boolean; roles: Array<{ role_id: string; code: string; name: string }>;
  invitation: { status: string; expires_at: unknown } | null;
};
export interface Holder { membershipId: string; userId: string; actorType: string; status: string; isLocked: boolean; roleId: string }
type ListQuery = { status?: string; isLocked?: boolean; roleId?: string; centreId?: string; mfaEnrolled?: boolean; sort: string; cursor?: string; limit: number };

export interface UserRepo {
  listUsers(tx: unknown, tenantId: string, q: ListQuery): Promise<{ rows: MemberView[]; nextCursor?: string }>;
  searchUsers(tx: unknown, tenantId: string, q: { query: string; limit: number }): Promise<MemberView[]>;
  findMember(tx: unknown, tenantId: string, id: string): Promise<MemberView | undefined>;
  findRolesByIds(tx: unknown, tenantId: string, ids: string[]): Promise<Role[]>;
  findCentresByIds(tx: unknown, tenantId: string, ids: string[]): Promise<Array<{ id: string; is_active: boolean }>>;
  findBranchesByIds(tx: unknown, tenantId: string, ids: string[]): Promise<Array<{ id: string; is_active: boolean }>>;
  listRoleManageHolders(tx: unknown, tenantId: string): Promise<Holder[]>;
  insertUser(tx: unknown, tenantId: string, u: { id: string; displayName: string; emailNormalized: string; emailHmac: Buffer; phoneE164?: string; actorId: string }): Promise<void>;
  insertMembership(tx: unknown, tenantId: string, m: { id: string; userId: string; allCentres: boolean; invitedAt: string; actorId: string }): Promise<void>;
  updateMembership(tx: unknown, tenantId: string, id: string, expectedVersion: number | undefined, set: Record<string, unknown>, actorId: string): Promise<boolean>;
  updateUserProfile(tx: unknown, tenantId: string, userId: string, set: { display_name?: string; phone_e164?: string | null }, actorId: string): Promise<void>;
  replaceRoles(tx: unknown, tenantId: string, membershipId: string, roleIds: string[], actorId: string): Promise<void>;
  replaceScope(tx: unknown, tenantId: string, membershipId: string, s: { centreIds: string[]; branchIds: string[] }, actorId: string): Promise<void>;
  insertInvitation(tx: unknown, tenantId: string, i: { id: string; membershipId: string; userId: string; email: string; expiresAt: Date; actorId: string }): Promise<void>;
  revokeOpenInvitations(tx: unknown, tenantId: string, membershipId: string, actorId: string): Promise<void>;
  revokeSessions(tx: unknown, tenantId: string, a: { membershipId: string; userId: string; reason: string; actorId: string }): Promise<Array<{ id: string; user_id: string }>>;
  removeMfaFactors(tx: unknown, tenantId: string, a: { userId: string; actorId: string }): Promise<number>;
  insertSignatureAsset(tx: unknown, tenantId: string, a: { id: string; membershipId: string; bucket: string; objectPath: string; contentType: string; sizeBytes: number; widthPx: number; heightPx: number; sha256: string; scanState: string; actorId: string }): Promise<void>;
  deactivateOtherSignatureAssets(tx: unknown, tenantId: string, membershipId: string, keepId: string, actorId: string): Promise<void>;
  enqueue(tx: unknown, identifier: string, payload: Record<string, unknown>, jobKey: string): Promise<void>;
}

const MANAGE = 'identity.role.manage';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;   // C0 / DB users__phone_e164__ck (08 A6.2)
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REASON_CODES = ['left_organisation', 'security_concern', 'policy_violation', 'other'];
const STATUSES = ['invited', 'active', 'deactivated'];
const SORTS = ['display_name', '-last_login_at', 'created_at'];
const UNSET: Record<string, 'phone_e164' | 'signatory_display_title' | 'signatory_registration_no'> = {
  phone_e164: 'phone_e164', signatory_title: 'signatory_display_title', signatory_registration_no: 'signatory_registration_no',
};
const INVITE_TTL_MS = 72 * 3_600_000;           // 03-APP-FLOW §4.1
const SIGNATURE_MAX_BYTES = 1_048_576;          // DB branding_assets__size__ck (signature <= 1 MB)
const MAX_DIM = 4000;                           // DB branding_assets__dims__ck
const BUCKET = 'identity-assets';
const SEND_INVITATION = 'identity.send_invitation';
const SIGNOUT = 'identity.gotrue_signout';
const REMOVE_MFA = 'identity.remove_mfa_factors';
const RESCAN = 'identity.rescan_upload';

// ------------------------------------------------------------------------------------------------ default repo (SQL on the request tx)
type Tx = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
const enc = (o: number) => Buffer.from(JSON.stringify({ o })).toString('base64url');
function dec(c: string | undefined): number {
  if (c === undefined) return 0;
  try { const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')).o; if (Number.isSafeInteger(o) && o >= 0) return o; } catch { /* fall through */ }
  throw new LimsError('common.validation_failed', undefined, [{ path: '/cursor', code: 'common.field_invalid', message: 'Field invalid' }]);
}
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function createUserRepo(): UserRepo {
  const q = async (tx: unknown, sql: string, params: unknown[]) => (await (tx as Tx).query(sql, params)).rows;
  // One statement for find / list / search (constant text): $2 id, $3 status, $4 locked, $5 role, $6 centre, $7 mfa, $8 escaped search, $9 sort, $10 limit, $11 offset.
  const view = (tx: unknown, p: unknown[]) => q(tx, `SELECT m.id, m.user_id, m.actor_type, m.status, u.display_name, u.email_normalized, u.phone_e164, m.all_centres, m.version,
      m.accepted_at, m.locked_at, m.lock_reason_code, m.last_login_at, m.signatory_display_title, m.signatory_registration_no,
      COALESCE((SELECT array_agg(mr.role_id ORDER BY mr.role_id) FROM core.membership_roles mr WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id), '{}') AS role_ids,
      COALESCE((SELECT json_agg(json_build_object('role_id', r.id, 'code', r.role_code, 'name', r.display_name) ORDER BY r.role_code)
                FROM core.membership_roles mr JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
                WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id), '[]') AS roles,
      COALESCE((SELECT array_agg(mc.centre_id ORDER BY mc.centre_id) FROM core.membership_centres mc WHERE mc.tenant_id = m.tenant_id AND mc.membership_id = m.id), '{}') AS centre_ids,
      COALESCE((SELECT array_agg(mb.branch_id ORDER BY mb.branch_id) FROM core.membership_branches mb WHERE mb.tenant_id = m.tenant_id AND mb.membership_id = m.id), '{}') AS branch_ids,
      EXISTS (SELECT 1 FROM identity.mfa_factors f WHERE f.tenant_id = m.tenant_id AND f.user_id = m.user_id AND f.status = 'verified') AS mfa_enrolled,
      (SELECT a.id FROM identity.branding_assets a WHERE a.tenant_id = m.tenant_id AND a.membership_id = m.id AND a.kind = 'signature' AND a.is_active
        ORDER BY a.created_at DESC LIMIT 1) AS signature_asset_id,
      (SELECT json_build_object('status', i.status, 'expires_at', i.expires_at) FROM identity.invitations i WHERE i.tenant_id = m.tenant_id AND i.membership_id = m.id
        ORDER BY i.created_at DESC LIMIT 1) AS invitation
    FROM core.memberships m JOIN core.users u ON u.tenant_id = m.tenant_id AND u.id = m.user_id
    WHERE m.tenant_id = $1 AND m.actor_type = 'user'
      AND ($2::uuid IS NULL OR m.id = $2::uuid) AND ($3::text IS NULL OR m.status = $3::text)
      AND ($4::boolean IS NULL OR (m.locked_at IS NOT NULL) = $4::boolean)
      AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM core.membership_roles x WHERE x.tenant_id = m.tenant_id AND x.membership_id = m.id AND x.role_id = $5::uuid))
      AND ($6::uuid IS NULL OR EXISTS (SELECT 1 FROM core.membership_centres y WHERE y.tenant_id = m.tenant_id AND y.membership_id = m.id AND y.centre_id = $6::uuid))
      AND ($7::boolean IS NULL OR EXISTS (SELECT 1 FROM identity.mfa_factors g WHERE g.tenant_id = m.tenant_id AND g.user_id = m.user_id AND g.status = 'verified') = $7::boolean)
      AND ($8::text IS NULL OR u.display_name ILIKE '%' || $8::text || '%' ESCAPE '\\' OR u.email_normalized LIKE lower($8::text) || '%' ESCAPE '\\')
    ORDER BY CASE WHEN $9::text = 'display_name' THEN u.display_name END, CASE WHEN $9::text = '-last_login_at' THEN m.last_login_at END DESC NULLS LAST,
      CASE WHEN $9::text = 'created_at' THEN m.created_at END, m.id
    LIMIT $10 OFFSET $11`, p) as Promise<MemberView[]>;
  const inv = createInvitationsRepo();
  const assets = createAssetsRepo();
  return {
    async listUsers(tx, t, f) {
      // ponytail: offset cursor (base64url {o}); keyset per sort key if lists ever get deep enough for OFFSET to cost.
      const off = dec(f.cursor);
      const rows = await view(tx, [t, null, f.status ?? null, f.isLocked ?? null, f.roleId ?? null, f.centreId ?? null, f.mfaEnrolled ?? null, null, f.sort, f.limit + 1, off]);
      return { rows: rows.slice(0, f.limit), ...(rows.length > f.limit ? { nextCursor: enc(off + f.limit) } : {}) };
    },
    searchUsers: (tx, t, s) => view(tx, [t, null, null, null, null, null, null, likeEscape(s.query), 'display_name', s.limit, 0]),
    findMember: async (tx, t, id) => (await view(tx, [t, id, null, null, null, null, null, null, 'display_name', 1, 0]))[0],
    async findRolesByIds(tx, t, ids) {
      return q(tx, `SELECT r.id, r.role_code AS code, r.display_name AS name, r.is_active,
          COALESCE((SELECT array_agg(p.permission_code) FROM core.role_permissions p WHERE p.tenant_id = r.tenant_id AND p.role_id = r.id), '{}') AS permission_codes
        FROM core.roles r WHERE r.tenant_id = $1 AND r.id = ANY($2::uuid[])`, [t, ids]);
    },
    findCentresByIds: (tx, t, ids) => q(tx, `SELECT id, is_active FROM core.collection_centres WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [t, ids]),
    findBranchesByIds: (tx, t, ids) => q(tx, `SELECT id, is_active FROM core.branches WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [t, ids]),
    async listRoleManageHolders(tx, t) {
      // ponytail: locks every active role row of the tenant so concurrent "drop the other admin" requests serialise (A-17, T14 convention).
      await q(tx, `SELECT id FROM core.roles WHERE tenant_id = $1 AND is_active ORDER BY id FOR UPDATE`, [t]);
      const rows = await q(tx, `SELECT m.id AS membership_id, m.user_id, m.actor_type, m.status, (m.locked_at IS NOT NULL) AS locked, mr.role_id
        FROM core.membership_roles mr
        JOIN core.memberships m ON m.tenant_id = mr.tenant_id AND m.id = mr.membership_id
        JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.is_active
        JOIN core.role_permissions p ON p.tenant_id = mr.tenant_id AND p.role_id = mr.role_id AND p.permission_code = $2
        WHERE mr.tenant_id = $1`, [t, MANAGE]);
      return rows.map((x) => ({ membershipId: x.membership_id, userId: x.user_id, actorType: x.actor_type, status: x.status, isLocked: x.locked, roleId: x.role_id }));
    },
    async insertUser(tx, t, u) {
      await q(tx, `INSERT INTO core.users (tenant_id, id, display_name, email_normalized, email_hmac, phone_e164, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`, [t, u.id, u.displayName, u.emailNormalized, u.emailHmac, u.phoneE164 ?? null, u.actorId]);
    },
    async insertMembership(tx, t, m) {
      await q(tx, `INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, all_centres, status, invited_at, created_by, updated_by)
        VALUES ($2, $1, $3, 'user', $4, 'invited', $5, $6, $6)`, [t, m.id, m.userId, m.allCentres, m.invitedAt, m.actorId]);
    },
    async updateMembership(tx, t, id, v, set, actorId) {
      // Constant statement: a column changes only when its key is in the $4 jsonb map (JSON null -> NULL). $3 NULL = unversioned (signature upload).
      const rows = await q(tx, `UPDATE core.memberships SET
          status = CASE WHEN $4::jsonb ? 'status' THEN $4::jsonb ->> 'status' ELSE status END,
          all_centres = CASE WHEN $4::jsonb ? 'all_centres' THEN ($4::jsonb ->> 'all_centres')::boolean ELSE all_centres END,
          deactivated_at = CASE WHEN $4::jsonb ? 'deactivated_at' THEN ($4::jsonb ->> 'deactivated_at')::timestamptz ELSE deactivated_at END,
          deactivated_by = CASE WHEN $4::jsonb ? 'deactivated_by' THEN ($4::jsonb ->> 'deactivated_by')::uuid ELSE deactivated_by END,
          deactivation_reason_code = CASE WHEN $4::jsonb ? 'deactivation_reason_code' THEN $4::jsonb ->> 'deactivation_reason_code' ELSE deactivation_reason_code END,
          locked_at = CASE WHEN $4::jsonb ? 'locked_at' THEN ($4::jsonb ->> 'locked_at')::timestamptz ELSE locked_at END,
          locked_by = CASE WHEN $4::jsonb ? 'locked_by' THEN ($4::jsonb ->> 'locked_by')::uuid ELSE locked_by END,
          lock_reason_code = CASE WHEN $4::jsonb ? 'lock_reason_code' THEN $4::jsonb ->> 'lock_reason_code' ELSE lock_reason_code END,
          lock_reason_text = CASE WHEN $4::jsonb ? 'lock_reason_text' THEN $4::jsonb ->> 'lock_reason_text' ELSE lock_reason_text END,
          signatory_display_title = CASE WHEN $4::jsonb ? 'signatory_display_title' THEN $4::jsonb ->> 'signatory_display_title' ELSE signatory_display_title END,
          signatory_registration_no = CASE WHEN $4::jsonb ? 'signatory_registration_no' THEN $4::jsonb ->> 'signatory_registration_no' ELSE signatory_registration_no END,
          signature_image_ref = CASE WHEN $4::jsonb ? 'signature_image_ref' THEN $4::jsonb ->> 'signature_image_ref' ELSE signature_image_ref END,
          version = version + 1, updated_at = now(), updated_by = $5
        WHERE tenant_id = $1 AND id = $2 AND actor_type = 'user' AND ($3::integer IS NULL OR version = $3::integer) RETURNING id`,
      [t, id, v ?? null, JSON.stringify(set), actorId]);
      return rows.length === 1;
    },
    async updateUserProfile(tx, t, userId, set, actorId) {
      await q(tx, `UPDATE core.users SET
          display_name = CASE WHEN $3::jsonb ? 'display_name' THEN $3::jsonb ->> 'display_name' ELSE display_name END,
          phone_e164 = CASE WHEN $3::jsonb ? 'phone_e164' THEN $3::jsonb ->> 'phone_e164' ELSE phone_e164 END,
          version = version + 1, updated_at = now(), updated_by = $4
        WHERE tenant_id = $1 AND id = $2`, [t, userId, JSON.stringify(set), actorId]);
    },
    async replaceRoles(tx, t, id, roleIds, actorId) {
      await q(tx, `DELETE FROM core.membership_roles WHERE tenant_id = $1 AND membership_id = $2`, [t, id]);
      await q(tx, `INSERT INTO core.membership_roles (tenant_id, membership_id, role_id, created_by) SELECT $1, $2, x, $4 FROM unnest($3::uuid[]) AS x`, [t, id, roleIds, actorId]);
    },
    async replaceScope(tx, t, id, s, actorId) {
      await q(tx, `DELETE FROM core.membership_centres WHERE tenant_id = $1 AND membership_id = $2`, [t, id]);
      await q(tx, `INSERT INTO core.membership_centres (tenant_id, membership_id, centre_id, created_by) SELECT $1, $2, x, $4 FROM unnest($3::uuid[]) AS x`, [t, id, s.centreIds, actorId]);
      await q(tx, `DELETE FROM core.membership_branches WHERE tenant_id = $1 AND membership_id = $2`, [t, id]);
      await q(tx, `INSERT INTO core.membership_branches (tenant_id, membership_id, branch_id, created_by) SELECT $1, $2, x, $4 FROM unnest($3::uuid[]) AS x`, [t, id, s.branchIds, actorId]);
    },
    insertInvitation: inv.insertInvitation,
    revokeOpenInvitations: inv.revokeOpenInvitations,
    async revokeSessions(tx, t, a) {
      return (await q(tx, `UPDATE identity.sessions SET state = 'revoked', revoked_at = now(), revoked_by = $4, revoke_reason = $3,
          version = version + 1, updated_at = now(), updated_by = $4
        WHERE tenant_id = $1 AND membership_id = $2 AND state NOT IN ('revoked', 'expired') RETURNING id, user_id`, [t, a.membershipId, a.reason, a.actorId]));
    },
    async removeMfaFactors(tx, t, a) {
      return (await q(tx, `UPDATE identity.mfa_factors SET status = 'removed', removed_at = now(), removed_by = $3, removal_reason = 'admin_reset', is_active = false,
          version = version + 1, updated_at = now(), updated_by = $3
        WHERE tenant_id = $1 AND user_id = $2 AND status <> 'removed' RETURNING id`, [t, a.userId, a.actorId])).length;
    },
    insertSignatureAsset: assets.insertSignatureAsset,
    deactivateOtherSignatureAssets: assets.deactivateOtherSignatureAssets,
    async enqueue(tx, identifier, payload, jobKey) {
      await q(tx, 'SELECT app.enqueue_job($1, $2::jsonb, $3)', [identifier, JSON.stringify(payload), jobKey]);
    },
  };
}

/** DEFINER app.identity_user_exists (03-APP-FLOW §4.2 step 2): a core.users row of this GoTrue user in ANY tenant. */
async function definerUserExists(tx: unknown, userId: string): Promise<boolean> {
  return (await (tx as Tx).query('SELECT app.identity_user_exists($1) AS e', [userId])).rows[0]?.e === true;
}

// ------------------------------------------------------------------------------------------------ validation helpers
const err = (path: string): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' });
const fail = (errors: FieldError[]): never => { throw new LimsError('common.validation_failed', undefined, errors); };
const failAt = (path: string): never => fail([err(path)]);
const notFound = () => new LimsError('common.not_found');
const conflict = () => new LimsError('common.version_conflict');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, min: number, max: number) => typeof v === 'string' && v.length >= min && v.length <= max;
const intIn = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

function scope(ctx: UserCtx, audited = false) {
  if (typeof ctx?.tenantId !== 'string' || !UUID.test(ctx.tenantId) || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  if (audited && typeof ctx.audit?.access !== 'function') throw new LimsError('common.internal');   // fail closed: no access log
  return { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id, clientIp: ctx.clientIp ?? '', requestId: ctx.requestId ?? '' };
}
type Scope = ReturnType<typeof scope>;
function expected(v: unknown): number {
  if (v === undefined || v === null) throw new LimsError('common.precondition_required');
  if (!intIn(v, 1, 2147483647)) failAt('/If-Match');
  return v as number;
}
/** uuid array with min/max items; per-item errors at <path>/<i>. */
function ids(v: unknown, path: string, min: number, max: number, out: FieldError[]): string[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) { out.push(err(path)); return []; }
  v.forEach((x, i) => { if (typeof x !== 'string' || !UUID.test(x)) out.push(err(`${path}/${i}`)); });
  return [...new Set(v as string[])];
}
const nowOf = (ctx: UserCtx) => new Date(ctx.now?.() ?? Date.now());
const iso = (v: unknown) => new Date(v as string).toISOString();

// ------------------------------------------------------------------------------------------------ wire shapes (absent optionals omitted, never null)
function maskEmail(e: string): string {
  const [local = '', domain = ''] = e.split('@');
  const tld = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '';
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***${tld}`;
}
const maskPhone = (p: string) => `${p.slice(0, 1)}${'*'.repeat(Math.max(0, p.length - 5))}${p.slice(-4)}`;
function toSummary(m: MemberView) {
  return {
    membership_id: m.id, display_name: m.display_name, email_masked: maskEmail(m.email_normalized ?? ''), status: m.status, is_locked: m.locked_at !== null && m.locked_at !== undefined,
    roles: m.roles.map((r) => ({ role_id: r.role_id, code: r.code, name: r.name })), all_centres: m.all_centres, centre_count: m.centre_ids.length,
    mfa_enrolled: m.mfa_enrolled, ...(m.last_login_at ? { last_login_at: iso(m.last_login_at) } : {}), version: m.version,
  };
}
function toUser(m: MemberView) {
  const signatory = {
    ...(m.signatory_display_title ? { display_title: m.signatory_display_title } : {}),
    ...(m.signatory_registration_no ? { registration_no: m.signatory_registration_no } : {}),
    ...(m.signature_asset_id ? { signature_asset_id: m.signature_asset_id } : {}),
  };
  return {
    ...toSummary(m), ...(m.phone_e164 ? { phone_masked: maskPhone(m.phone_e164) } : {}), branch_ids: [...m.branch_ids], centre_ids: [...m.centre_ids],
    ...(Object.keys(signatory).length ? { signatory } : {}),
    ...(m.locked_at ? { lock: { locked_at: iso(m.locked_at), ...(m.lock_reason_code ? { reason_code: m.lock_reason_code } : {}) } } : {}),
    ...(m.invitation ? { invitation: { status: m.invitation.status, expires_at: iso(m.invitation.expires_at) } } : {}),
  };
}

export function createUserService(deps: {
  repo?: UserRepo; gotrue?: Pick<GoTrueGateway, 'adminCreateUser'>; userExists?: (tx: unknown, userId: string) => Promise<boolean>;
  emailHmac?: (emailNormalized: string) => Buffer; clearAccountFailures?: (emailNormalized: string) => Promise<void>; newId?: () => string;
  events?: { recordTenant(tx: unknown, e: AuthEvent): Promise<void> };
} = {}) {
  const repo = deps.repo ?? createUserRepo();
  const newId = deps.newId ?? uuidv7;
  const userExists = deps.userExists ?? definerUserExists;
  // Wired by handlers/user.http.ts (env-backed); absent -> fail closed.
  const need = <T>(v: T | undefined): T => { if (v === undefined) throw new LimsError('common.internal'); return v; };

  async function load(s: Scope, id: unknown): Promise<MemberView> {
    if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
    const m = await repo.findMember(s.tx, s.tenantId, id);
    if (!m || m.actor_type !== 'user') throw notFound();
    return m;
  }
  async function loadAt(s: Scope, id: unknown, v: number): Promise<MemberView> {
    const m = await load(s, id);
    if (m.version !== v) throw conflict();
    return m;
  }
  const fresh = async (s: Scope, id: string): Promise<Result> => { const m = (await repo.findMember(s.tx, s.tenantId, id))!; return { status: 200, body: toUser(m), version: m.version }; };
  const write = async (s: Scope, id: string, v: number | undefined, set: Record<string, unknown>) => { if (!(await repo.updateMembership(s.tx, s.tenantId, id, v, set, s.actorId))) throw conflict(); };
  const selfGuard = (ctx: UserCtx, m: MemberView) => { if (ctx.actor.membershipId === m.id) throw new LimsError('identity.self_action_forbidden'); };
  /** AC-B2.3: an eligible admin = actor_type user, active, not locked, holding identity.role.manage via an active role. Read before the first write. */
  async function guardLastAdmin(s: Scope, targetId: string, keepsManage: boolean) {
    const eligible = (await repo.listRoleManageHolders(s.tx, s.tenantId)).filter((h) => h.actorType === 'user' && h.status === 'active' && !h.isLocked);
    if (keepsManage || !eligible.some((h) => h.membershipId === targetId)) return;
    if (!eligible.some((h) => h.membershipId !== targetId)) throw new LimsError('identity.last_admin_protected');
  }
  /** SS9: revoke in this tx, sign-out job committed with it, auth event session_revoked (reason) per revoked session. */
  async function signOut(s: Scope, m: MemberView, reason: string): Promise<number> {
    const events = need(deps.events);   // fail closed
    const rows = await repo.revokeSessions(s.tx, s.tenantId, { membershipId: m.id, userId: m.user_id, reason, actorId: s.actorId });
    await repo.enqueue(s.tx, SIGNOUT, { user_id: m.user_id, tenant_id: s.tenantId }, `signout:${m.user_id}:${reason}`);
    for (const r of rows) {
      await events.recordTenant(s.tx, { id: newId(), eventType: 'session_revoked', reasonCode: reason, tenantId: s.tenantId, userId: r.user_id,
        membershipId: m.id, sessionId: r.id, clientIp: s.clientIp, requestId: s.requestId, actorId: s.actorId });
    }
    return rows.length;
  }
  async function invite(ctx: UserCtx, s: Scope, membershipId: string, userId: string, email: string) {
    const id = newId();
    await repo.insertInvitation(s.tx, s.tenantId, { id, membershipId, userId, email, expiresAt: new Date(nowOf(ctx).getTime() + INVITE_TTL_MS), actorId: s.actorId });
    await repo.enqueue(s.tx, SEND_INVITATION, { tenant_id: s.tenantId, invitation_id: id }, `invite:${id}:1`);
  }
  async function checkRoles(s: Scope, roleIds: string[]): Promise<Role[]> {
    const found = await repo.findRolesByIds(s.tx, s.tenantId, roleIds);
    const roles = roleIds.map((id) => found.find((r) => r.id === id));
    if (roles.some((r) => !r || !r.is_active)) throw new LimsError('identity.role_unknown');
    return roles as Role[];
  }
  /** Unknown / foreign ids -> 400 at their index (no oracle); inactive -> 409 identity.centre_inactive (AC-B3.3). */
  async function checkScope(s: Scope, centreIds: string[], branchIds: string[]) {
    const c = centreIds.length ? await repo.findCentresByIds(s.tx, s.tenantId, centreIds) : [];
    const b = branchIds.length ? await repo.findBranchesByIds(s.tx, s.tenantId, branchIds) : [];
    const missing = [
      ...centreIds.flatMap((id, i) => (c.some((x) => x.id === id) ? [] : [err(`/centre_ids/${i}`)])),
      ...branchIds.flatMap((id, i) => (b.some((x) => x.id === id) ? [] : [err(`/branch_ids/${i}`)])),
    ];
    if (missing.length) fail(missing);
    if ([...c, ...b].some((x) => !x.is_active)) throw new LimsError('identity.centre_inactive');
  }
  function scopeInput(input: Record<string, unknown>, out: FieldError[]) {
    if (typeof input['allCentres'] !== 'boolean') out.push(err('/all_centres'));
    const all = input['allCentres'] === true;
    const centreIds = all ? [] : ids(input['centreIds'], '/centre_ids', 1, 200, out);
    const branchIds = input['branchIds'] === undefined ? [] : ids(input['branchIds'], '/branch_ids', 0, 50, out);
    return { all, centreIds, branchIds };
  }
  function reasonInput(input: Record<string, unknown>) {
    const { reasonCode, reasonText } = input;
    const out: FieldError[] = [];
    if (typeof reasonCode !== 'string' || !REASON_CODES.includes(reasonCode)) out.push(err('/reason_code'));
    if (reasonText !== undefined && !str(reasonText, 1, 500)) out.push(err('/reason_text'));
    if (out.length) fail(out);
    return { reasonCode: reasonCode as string, reasonText: reasonText as string | undefined };
  }

  return {
    async listUsers(ctx: UserCtx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = scope(ctx);
      const i = input ?? {};
      const out: FieldError[] = [];
      if (i['status'] !== undefined && !STATUSES.includes(i['status'] as string)) out.push(err('/status'));
      if (i['isLocked'] !== undefined && typeof i['isLocked'] !== 'boolean') out.push(err('/is_locked'));
      if (i['mfaEnrolled'] !== undefined && typeof i['mfaEnrolled'] !== 'boolean') out.push(err('/mfa_enrolled'));
      if (i['roleId'] !== undefined && !(typeof i['roleId'] === 'string' && UUID.test(i['roleId']))) out.push(err('/role_id'));
      if (i['centreId'] !== undefined && !(typeof i['centreId'] === 'string' && UUID.test(i['centreId']))) out.push(err('/centre_id'));
      if (i['sort'] !== undefined && !SORTS.includes(i['sort'] as string)) out.push(err('/sort'));
      if (i['cursor'] !== undefined && !(typeof i['cursor'] === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(i['cursor']))) out.push(err('/cursor'));
      if (i['limit'] !== undefined && !intIn(i['limit'], 1, 200)) out.push(err('/limit'));
      if (out.length) fail(out);
      const q: ListQuery = { sort: (i['sort'] as string) ?? 'display_name', limit: (i['limit'] as number) ?? 50 };
      for (const k of ['status', 'isLocked', 'roleId', 'centreId', 'mfaEnrolled', 'cursor'] as const) if (i[k] !== undefined) (q as any)[k] = i[k];
      const r = await repo.listUsers(s.tx, s.tenantId, q);
      return { status: 200, body: { data: r.rows.filter((m) => m.actor_type === 'user').map(toSummary), page: { limit: q.limit, ...(r.nextCursor ? { next_cursor: r.nextCursor } : {}) } } };
    },

    async searchUsers(ctx: UserCtx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = scope(ctx);
      const query = typeof input?.['query'] === 'string' ? input['query'].trim() : undefined;
      const out: FieldError[] = [];
      if (query === undefined || query.length < 2 || query.length > 100) out.push(err('/query'));
      if (input?.['limit'] !== undefined && !intIn(input['limit'], 1, 200)) out.push(err('/limit'));
      if (out.length) fail(out);
      const limit = (input['limit'] as number) ?? 50;
      const rows = await repo.searchUsers(s.tx, s.tenantId, { query: query!, limit });
      return { status: 200, body: { data: rows.filter((m) => m.actor_type === 'user').map(toSummary), page: { limit } } };
    },

    async inviteUser(ctx: UserCtx, input: Record<string, unknown>): Promise<Result> {
      const s = scope(ctx);
      const i = input ?? {};
      const out: FieldError[] = [];
      const email = typeof i['email'] === 'string' ? i['email'].trim().normalize('NFC').toLowerCase() : '';
      if (email.length < 3 || email.length > 254 || !EMAIL.test(email)) out.push(err('/email'));
      if (!str(i['displayName'], 1, 120)) out.push(err('/display_name'));
      if (i['phoneE164'] !== undefined && !(typeof i['phoneE164'] === 'string' && PHONE.test(i['phoneE164']))) out.push(err('/phone_e164'));
      const roleIds = ids(i['roleIds'], '/role_ids', 1, 20, out);
      const sc = scopeInput(i, out);
      if (out.length) fail(out);
      await checkRoles(s, roleIds);
      await checkScope(s, sc.centreIds, sc.branchIds);

      const g = await need(deps.gotrue).adminCreateUser({ email, emailConfirm: false });
      // AC-B1.3: an account with a core.users row anywhere -> generic 409; a GoTrue orphan of a rolled-back attempt is reused.
      if ('exists' in g && g.exists && (await userExists(s.tx, g.userId))) throw new LimsError('identity.user_exists');
      const membershipId = newId();
      try {
        await repo.insertUser(s.tx, s.tenantId, {
          id: g.userId, displayName: i['displayName'] as string, emailNormalized: email, emailHmac: need(deps.emailHmac)(email),
          ...(i['phoneE164'] === undefined ? {} : { phoneE164: i['phoneE164'] as string }), actorId: s.actorId,
        });
        await repo.insertMembership(s.tx, s.tenantId, { id: membershipId, userId: g.userId, allCentres: sc.all, invitedAt: nowOf(ctx).toISOString(), actorId: s.actorId });
      } catch (e) {
        if ((e as { code?: unknown })?.code === '23505') throw new LimsError('identity.user_exists');   // race with a concurrent invite
        throw e;
      }
      await repo.replaceRoles(s.tx, s.tenantId, membershipId, roleIds, s.actorId);
      await repo.replaceScope(s.tx, s.tenantId, membershipId, { centreIds: sc.centreIds, branchIds: sc.branchIds }, s.actorId);
      await invite(ctx, s, membershipId, g.userId, email);
      return { ...(await fresh(s, membershipId)), status: 201 };
    },

    async getUser(ctx: UserCtx, input: { membershipId?: unknown }): Promise<Result> {
      const s = scope(ctx);
      const m = await load(s, input?.membershipId);
      return { status: 200, body: toUser(m), version: m.version };
    },

    async updateUser(ctx: UserCtx, input: Record<string, unknown>): Promise<Result> {
      const s = scope(ctx);
      const v = expected(input?.['expectedVersion']);
      const { displayName, phoneE164, signatoryTitle, signatoryRegistrationNo, unset } = input;
      const out: FieldError[] = [];
      if (displayName !== undefined && !str(displayName, 1, 120)) out.push(err('/display_name'));
      if (phoneE164 !== undefined && !(typeof phoneE164 === 'string' && PHONE.test(phoneE164))) out.push(err('/phone_e164'));
      if (signatoryTitle !== undefined && !str(signatoryTitle, 1, 80)) out.push(err('/signatory_title'));
      if (signatoryRegistrationNo !== undefined && !str(signatoryRegistrationNo, 1, 40)) out.push(err('/signatory_registration_no'));
      const given: Record<string, unknown> = { phone_e164: phoneE164, signatory_title: signatoryTitle, signatory_registration_no: signatoryRegistrationNo };
      const nulls: string[] = [];
      if (unset !== undefined) {
        if (!Array.isArray(unset) || unset.length > 3) out.push(err('/unset'));
        else unset.forEach((u, idx) => {
          if (typeof u !== 'string' || !Object.hasOwn(UNSET, u)) out.push(err(`/unset/${idx}`));
          else if (given[u] !== undefined || nulls.includes(u)) out.push(err('/unset'));
          else nulls.push(u);
        });
      }
      if (out.length) fail(out);
      const m = await loadAt(s, input['membershipId'], v);
      const profile: { display_name?: string; phone_e164?: string | null } = {};
      const set: Record<string, unknown> = {};
      if (displayName !== undefined) profile.display_name = displayName as string;
      if (phoneE164 !== undefined) profile.phone_e164 = phoneE164 as string;
      if (signatoryTitle !== undefined) set['signatory_display_title'] = signatoryTitle;
      if (signatoryRegistrationNo !== undefined) set['signatory_registration_no'] = signatoryRegistrationNo;
      for (const u of nulls) { if (u === 'phone_e164') profile.phone_e164 = null; else set[UNSET[u]!] = null; }
      await write(s, m.id, v, set);
      if (Object.keys(profile).length) await repo.updateUserProfile(s.tx, s.tenantId, m.user_id, profile, s.actorId);
      return fresh(s, m.id);
    },

    async setUserRoles(ctx: UserCtx, input: Record<string, unknown>): Promise<Result> {
      const s = scope(ctx, true);
      const v = expected(input?.['expectedVersion']);
      const out: FieldError[] = [];
      const roleIds = ids(input['roleIds'], '/role_ids', 1, 20, out);
      if (out.length) fail(out);
      const m = await loadAt(s, input['membershipId'], v);
      const roles = await checkRoles(s, roleIds);
      await guardLastAdmin(s, m.id, roles.some((r) => r.permission_codes.includes(MANAGE)));
      await write(s, m.id, v, {});
      await repo.replaceRoles(s.tx, s.tenantId, m.id, roleIds, s.actorId);
      await signOut(s, m, 'role_change');   // AC-B2.4
      await ctx.audit!.access({ action: 'role.change', entityType: 'membership', entityId: m.id, outcome: 'allowed' });
      return fresh(s, m.id);
    },

    async setUserCentreScope(ctx: UserCtx, input: Record<string, unknown>): Promise<Result> {
      const s = scope(ctx);
      const v = expected(input?.['expectedVersion']);
      const out: FieldError[] = [];
      const sc = scopeInput(input, out);
      if (out.length) fail(out);
      const m = await loadAt(s, input['membershipId'], v);
      await checkScope(s, sc.centreIds, sc.branchIds);
      await write(s, m.id, v, { all_centres: sc.all });
      await repo.replaceScope(s.tx, s.tenantId, m.id, { centreIds: sc.centreIds, branchIds: sc.branchIds }, s.actorId);
      await signOut(s, m, 'role_change');
      return fresh(s, m.id);
    },

    async lockUser(ctx: UserCtx, input: Record<string, unknown>): Promise<Result> {
      const s = scope(ctx);
      const v = expected(input?.['expectedVersion']);
      const r = reasonInput(input);
      const m = await loadAt(s, input['membershipId'], v);
      selfGuard(ctx, m);   // AC-B4.3, before last-admin
      if (m.locked_at) throw conflict();
      await guardLastAdmin(s, m.id, false);
      await write(s, m.id, v, { locked_at: nowOf(ctx).toISOString(), locked_by: s.actorId, lock_reason_code: r.reasonCode, lock_reason_text: r.reasonText ?? null });
      await signOut(s, m, 'lock');
      return fresh(s, m.id);
    },

    async unlockUser(ctx: UserCtx, input: Record<string, unknown>): Promise<Result> {
      const s = scope(ctx);
      const v = expected(input?.['expectedVersion']);
      const m = await loadAt(s, input['membershipId'], v);
      if (!m.locked_at) throw conflict();
      await write(s, m.id, v, { locked_at: null, locked_by: null, lock_reason_code: null, lock_reason_text: null });
      await need(deps.clearAccountFailures)(m.email_normalized);   // AC-B4.2: only after the guarded update succeeded
      return fresh(s, m.id);
    },

    async deactivateUser(ctx: UserCtx, input: Record<string, unknown>): Promise<Result> {
      const s = scope(ctx);
      const v = expected(input?.['expectedVersion']);
      const r = reasonInput(input);
      const m = await loadAt(s, input['membershipId'], v);
      selfGuard(ctx, m);
      if (m.status === 'deactivated') throw conflict();
      await guardLastAdmin(s, m.id, false);
      // reason_text has no membership column; the request is in the row audit (05-SCHEMA §3.3).
      await write(s, m.id, v, { status: 'deactivated', deactivated_at: nowOf(ctx).toISOString(), deactivated_by: s.actorId, deactivation_reason_code: r.reasonCode });
      if (m.status === 'invited') await repo.revokeOpenInvitations(s.tx, s.tenantId, m.id, s.actorId);   // M3
      await signOut(s, m, 'deactivate');
      return fresh(s, m.id);
    },

    /** M5 (accepted -> active) / M6 (never accepted -> invited + new invitation); both clear deactivated_* (08 A6.3, A8.2; D-T8, D-T13). Lock untouched. */
    async reactivateUser(ctx: UserCtx, input: Record<string, unknown>): Promise<Result> {
      const s = scope(ctx);
      const v = expected(input?.['expectedVersion']);
      const m = await loadAt(s, input['membershipId'], v);
      if (m.status !== 'deactivated') throw conflict();
      const accepted = m.accepted_at !== null && m.accepted_at !== undefined;
      await write(s, m.id, v, { status: accepted ? 'active' : 'invited', deactivated_at: null, deactivated_by: null, deactivation_reason_code: null });
      if (!accepted) await invite(ctx, s, m.id, m.user_id, m.email_normalized);
      return fresh(s, m.id);
    },

    async resendInvitation(ctx: UserCtx, input: { membershipId?: unknown }): Promise<Result> {
      const s = scope(ctx);
      const m = await load(s, input?.membershipId);
      if (m.status !== 'invited') throw conflict();
      await repo.revokeOpenInvitations(s.tx, s.tenantId, m.id, s.actorId);
      await invite(ctx, s, m.id, m.user_id, m.email_normalized);
      return { status: 202, body: {} };
    },

    /** US-B5: mirror rows removed now, GoTrue factors by identity.remove_mfa_factors; reason_text stays out of jobs and access logs. */
    async resetUserMfa(ctx: UserCtx, input: Record<string, unknown>): Promise<Result> {
      const s = scope(ctx);
      const v = expected(input?.['expectedVersion']);
      if (!str(input['reasonText'], 1, 500)) failAt('/reason_text');
      const m = await loadAt(s, input['membershipId'], v);
      selfGuard(ctx, m);
      await write(s, m.id, v, {});
      await repo.removeMfaFactors(s.tx, s.tenantId, { userId: m.user_id, actorId: s.actorId });
      await signOut(s, m, 'mfa_reset');
      await repo.enqueue(s.tx, REMOVE_MFA, { tenant_id: s.tenantId, user_id: m.user_id, membership_id: m.id }, `mfa_reset:${m.id}:${v + 1}`);
      return fresh(s, m.id);
    },

    async revokeUserSessions(ctx: UserCtx, input: { membershipId?: unknown }): Promise<Result> {
      const s = scope(ctx, true);
      const m = await load(s, input?.membershipId);
      const revoked = await signOut(s, m, 'admin_revoke');
      await ctx.audit!.access({ action: 'session.revoke', entityType: 'session', entityId: m.id, outcome: 'allowed' });
      return { status: 200, body: { revoked } };
    },

    /** US-B6: private object {tenant}/signatures/{membership}/{asset}.png (client name never used); P-19 pending -> rescan job. */
    async uploadUserSignature(ctx: UserCtx, input: { membershipId?: unknown; file?: unknown }): Promise<Result> {
      const s = scope(ctx);
      const m = await load(s, input?.membershipId);
      if (!isObj(input.file)) failAt('/file');
      const id = newId();
      const objectPath = `${s.tenantId}/signatures/${m.id}/${id}.png`;
      const acc = await ctx.uploads.accept(input.file, {
        allow: ['image/png'], maxBytes: SIGNATURE_MAX_BYTES, bucket: BUCKET, objectPath,
        images: { reencode: true, stripMetadata: true, maxMegapixels: 16 }, scan: 'required',
      });
      const scanState = acc.scanState === 'clean' ? 'clean' : 'pending';
      try {
        const w = acc.image?.width, h = acc.image?.height;
        if (!w || !h || w > MAX_DIM || h > MAX_DIM) failAt('/file');
        await repo.insertSignatureAsset(s.tx, s.tenantId, {
          id, membershipId: m.id, bucket: BUCKET, objectPath, contentType: acc.mime, sizeBytes: acc.byteSize, widthPx: w!, heightPx: h!,
          sha256: acc.sha256, scanState, actorId: s.actorId,
        });
        await repo.deactivateOtherSignatureAssets(s.tx, s.tenantId, m.id, id, s.actorId);
        await write(s, m.id, undefined, { signature_image_ref: objectPath });
        if (scanState === 'pending') await repo.enqueue(s.tx, RESCAN, { tenant_id: s.tenantId, asset_id: id, kind: 'signature' }, `rescan:branding_assets:${id}`);
      } catch (e) {
        await ctx.storage.delete(BUCKET, objectPath).catch(() => undefined);   // no orphan object when the row is refused
        throw e;
      }
      return fresh(s, m.id);
    },
  };
}
export type UserService = ReturnType<typeof createUserService>;
