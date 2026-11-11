// Auth-path repositories (05-SCHEMA §5.4, §6, §10.3; 08 A25 D-212, A28.1). Every call takes the identityAuthTx tx first; SQL is
// parameterised only.
//   createAuthEventsRepo: tenant-less events go through the DEFINER app.identity_record_auth_event; tenant events are a plain INSERT
//                         under auth_events__insert__tenant, so they need tx.bindTenant first.
//   createAuthRepo:       the login reads/writes of auth.service (AuthRepo seam): app.identity_login_context, tenant session
//                         INSERT (after bindTenant), platform rows through app.identity_platform_auth_write_* and app.enqueue_job.
// [CONV] Login-path repo lives here: T6 owns no other repository file.
import { createCipheriv, randomBytes } from 'node:crypto';
import type { Tx } from '../../../core/db/tx.js';
import { LimsError } from '../../../core/errors.js';

type Q = Pick<Tx, 'query'>;

export interface AuthEvent {
  id: string; eventType: string; reasonCode?: string | undefined; userId?: string | undefined; membershipId?: string | undefined;
  tenantId?: string | undefined; platformStaffId?: string | undefined; sessionId?: string | undefined; emailHmacHex?: string | undefined;
  clientIp: string; userAgent?: string | undefined; requestId: string; actorId: string;
}

const ua = (v: string | undefined) => (typeof v === 'string' ? v.slice(0, 512) : null); // auth_events__ua__ck / sessions client data
const nn = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
const hmacBuf = (hex: string | undefined) => (typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null);

const RECORD_SQL = 'SELECT app.identity_record_auth_event($1::jsonb)';
const TENANT_SQL = `INSERT INTO identity.auth_events (id, tenant_id, user_id, membership_id, platform_staff_id, session_id, event_type, reason_code,
  email_hmac, client_ip, user_agent, request_id, created_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, nullif($10, '')::inet, $11, $12, $13)`;

export function createAuthEventsRepo() {
  return {
    async recordTenantless(tx: Q, e: AuthEvent): Promise<void> {
      if (e.tenantId !== undefined && e.tenantId !== null) throw new Error('auth-events.repo: tenant event on the tenant-less path');
      const p: Record<string, unknown> = {
        id: e.id, event_type: e.eventType, reason_code: nn(e.reasonCode), user_id: nn(e.userId), platform_staff_id: nn(e.platformStaffId),
        session_id: nn(e.sessionId), email_hmac_hex: nn(e.emailHmacHex), client_ip: e.clientIp, user_agent: ua(e.userAgent),
        request_id: e.requestId, created_by: e.actorId,
      };
      await tx.query(RECORD_SQL, [JSON.stringify(p)]);
    },
    async recordTenant(tx: Q, e: AuthEvent): Promise<void> {
      if (typeof e.tenantId !== 'string' || !e.tenantId) throw new Error('auth-events.repo: tenant event without tenant id');
      await tx.query(TENANT_SQL, [e.id, e.tenantId, nn(e.userId), nn(e.membershipId), nn(e.platformStaffId), nn(e.sessionId), e.eventType,
        nn(e.reasonCode), hmacBuf(e.emailHmacHex), e.clientIp ?? '', ua(e.userAgent), e.requestId, e.actorId]);
    },
  };
}

// ---------- login repo ----------

export interface NewSession {
  id: string; tenantId: string | null; kind: string; userId: string; membershipId: string | null; platformStaffId: string | null;
  gotrueSessionId: string; tokenSha256: Buffer; state: string; aal: string; accessToken: string; refreshToken: string;
  accessExpiresAt: Date; idleTimeoutMinutes: number; idleExpiresAt: Date; absoluteExpiresAt: Date; expiresAt: Date;
  clientIp: string; userAgent?: string | undefined; actorId: string;
  /** T31: required iff kind staff_mobile (sessions__app__ck; patient sessions are written by the port, not here) */
  appInstanceId?: string; appPlatform?: string;
}

/** LIMS_IDENTITY_TOKEN_ENC_KEYS = JSON { "<key_id>": "<base64 32 bytes>" }; the last id listed encrypts [CONV "newest"].
 *  Sealed value = iv(12) || tag(16) || ciphertext, AES-256-GCM, AAD = key id [CONV]. */
export type Sealer = (plain: string) => { keyId: string; enc: Buffer };
export function sealerFromEnv(env: NodeJS.ProcessEnv = process.env): Sealer {
  return (plain) => {
    let keys: Record<string, string>;
    try { keys = JSON.parse(env['LIMS_IDENTITY_TOKEN_ENC_KEYS'] ?? ''); } catch { throw new LimsError('common.internal', 'identity: token encryption keys missing'); }
    const keyId = Object.keys(keys ?? {}).at(-1);
    const key = keyId ? Buffer.from(String(keys[keyId]), 'base64') : Buffer.alloc(0);
    if (!keyId || key.length !== 32) throw new LimsError('common.internal', 'identity: token encryption keys invalid');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(keyId));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return { keyId, enc: Buffer.concat([iv, c.getAuthTag(), ct]) };
  };
}

const LOGIN_CONTEXT_SQL = `SELECT platform_staff_id, platform_role, platform_active, platform_allowed_cidrs::text[] AS platform_allowed_cidrs,
  membership_count, tenant_id, tenant_status, membership_id, membership_status, membership_locked, mfa_required, has_verified_factor,
  idle_timeout_minutes, absolute_session_hours FROM app.identity_login_context($1::uuid)`;
const SESSION_SQL = `INSERT INTO identity.sessions (id, tenant_id, kind, user_id, membership_id, gotrue_session_id, token_sha256, state, aal,
  refresh_token_enc, access_token_enc, enc_key_id, access_expires_at, idle_timeout_minutes, idle_expires_at, absolute_expires_at,
  client_ip, user_agent, expires_at, created_by, updated_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, nullif($17, '')::inet, $18, $19, $20, $20)`;
// T31 staff_mobile: same row + app_instance_id / app_platform (sessions__app__ck)
const APP_SESSION_SQL = `INSERT INTO identity.sessions (id, tenant_id, kind, user_id, membership_id, gotrue_session_id, token_sha256, state, aal,
  refresh_token_enc, access_token_enc, enc_key_id, access_expires_at, idle_timeout_minutes, idle_expires_at, absolute_expires_at,
  client_ip, user_agent, expires_at, created_by, updated_by, app_instance_id, app_platform)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, nullif($17, '')::inet, $18, $19, $20, $20, $21, $22)`;
// T31 AU-T17: permission through an active role of the membership (tenant bound; plain SQL under the tenant policies)
const MEMBERSHIP_PERMISSION_SQL = `SELECT EXISTS (SELECT 1 FROM core.membership_roles mr
    JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.is_active
    JOIN core.role_permissions rp ON rp.tenant_id = r.tenant_id AND rp.role_id = r.id
  WHERE mr.tenant_id = $1 AND mr.membership_id = $2 AND rp.permission_code = $3) AS ok`;
const PLATFORM_SESSION_SQL = 'SELECT app.identity_platform_auth_write_session_insert($1::uuid, $2::jsonb)';
const STAFF_LOGIN_SQL = 'SELECT app.identity_platform_auth_write_staff_login($1::uuid)';
const TOUCH_SQL = `UPDATE core.memberships SET last_login_at = $3, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND id = $2`;
const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3)';

const bytea = (b: Buffer) => `\\x${b.toString('hex')}`; // jsonb_populate_record bytea text form

export function createAuthRepo(o: { seal?: Sealer } = {}) {
  const seal = o.seal ?? sealerFromEnv();
  const sealBoth = (s: NewSession) => {
    const r = seal(s.refreshToken); const a = seal(s.accessToken);
    if (r.keyId !== a.keyId) throw new LimsError('common.internal');
    return { keyId: r.keyId, refresh: r.enc, access: a.enc };
  };
  return {
    async loginContext(tx: Q, sub: string): Promise<Record<string, unknown> | undefined> {
      return (await tx.query(LOGIN_CONTEXT_SQL, [sub])).rows[0];
    },
    async insertSession(tx: Q, s: NewSession): Promise<void> {
      const k = sealBoth(s);
      const p = [s.id, s.tenantId, s.kind, s.userId, s.membershipId, s.gotrueSessionId, s.tokenSha256, s.state, s.aal,
        k.refresh, k.access, k.keyId, s.accessExpiresAt, s.idleTimeoutMinutes, s.idleExpiresAt, s.absoluteExpiresAt, s.clientIp ?? '',
        ua(s.userAgent), s.expiresAt, s.actorId];
      if (s.appInstanceId) await tx.query(APP_SESSION_SQL, [...p, s.appInstanceId, s.appPlatform]);
      else await tx.query(SESSION_SQL, p);
    },
    async membershipHasPermission(tx: Q, a: { tenantId: string; membershipId: string; permission: string }): Promise<boolean> {
      return (await tx.query(MEMBERSHIP_PERMISSION_SQL, [a.tenantId, a.membershipId, a.permission])).rows[0]?.ok === true;
    },
    /** 08 A28.1: jsonb_populate_record + INSERT SELECT v.* means every NOT NULL column (defaults included) is sent explicitly. */
    async insertPlatformSession(tx: Q, s: NewSession): Promise<void> {
      const k = sealBoth(s); const now = new Date().toISOString();
      const row = {
        id: s.id, tenant_id: null, kind: 'platform', user_id: s.userId, membership_id: null, platform_staff_id: s.platformStaffId,
        gotrue_session_id: s.gotrueSessionId, token_sha256: bytea(s.tokenSha256), state: s.state, aal: s.aal,
        refresh_token_enc: bytea(k.refresh), access_token_enc: bytea(k.access), enc_key_id: k.keyId,
        access_expires_at: s.accessExpiresAt.toISOString(), idle_timeout_minutes: s.idleTimeoutMinutes, last_seen_at: now,
        idle_expires_at: s.idleExpiresAt.toISOString(), absolute_expires_at: s.absoluteExpiresAt.toISOString(), mfa_failed_attempts: 0,
        client_ip: s.clientIp || null, user_agent: ua(s.userAgent), expires_at: s.expiresAt.toISOString(), version: 1,
        created_at: now, created_by: s.actorId, updated_at: now, updated_by: s.actorId,
      };
      await tx.query(PLATFORM_SESSION_SQL, [s.userId, JSON.stringify(row)]);
    },
    async touchMembershipLogin(tx: Q, a: { tenantId: string; membershipId: string; at: Date; actorId: string }): Promise<void> {
      await tx.query(TOUCH_SQL, [a.tenantId, a.membershipId, a.at, a.actorId]);
    },
    async platformStaffLogin(tx: Q, a: { platformStaffId: string; userId: string; at: Date }): Promise<void> {
      await tx.query(STAFF_LOGIN_SQL, [a.userId]);
    },
    async enqueue(tx: Q, taskIdentifier: string, payload: Record<string, unknown>, jobKey: string): Promise<void> {
      await tx.query(ENQUEUE_SQL, [taskIdentifier, JSON.stringify(payload), jobKey]);
    },
  };
}
