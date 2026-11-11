// MFA challenge / enrolment repository (T7; 05-SCHEMA §4.1 sessions, §4.2 mfa_factors, §4.10 platform_events; 08 A28.1, A25 D-212/D-215;
// 07-SECURITY A-11 token sealing). Every method takes the identityAuthTx tx first; SQL is parameterised only (column lists are constants).
// Tenant rows: plain SQL under the tenant policies (handler ran tx.bindTenant first). Platform rows: app.identity_platform_auth_write_*.
import { createDecipheriv } from 'node:crypto';
import type { Tx } from '../../../core/db/tx.js';
import { LimsError } from '../../../core/errors.js';
import { sealerFromEnv, type Sealer } from './auth-events.repo.js';

type Q = Pick<Tx, 'query'>;
export type Opener = (enc: Buffer, keyId: string) => string;

/** Inverse of sealerFromEnv: iv(12) || tag(16) || ciphertext, AES-256-GCM, AAD = key id. Fails closed; messages carry no key material. */
export function openerFromEnv(env: NodeJS.ProcessEnv = process.env): Opener {
  return (enc, keyId) => {
    let keys: Record<string, string>;
    try { keys = JSON.parse(env['LIMS_IDENTITY_TOKEN_ENC_KEYS'] ?? ''); } catch { throw new LimsError('common.internal', 'identity: token encryption keys missing'); }
    const raw = keys && Object.prototype.hasOwnProperty.call(keys, keyId) ? keys[keyId] : undefined;
    const key = raw ? Buffer.from(String(raw), 'base64') : Buffer.alloc(0);
    if (key.length !== 32) throw new LimsError('common.internal', 'identity: token encryption key invalid');
    if (!Buffer.isBuffer(enc) || enc.length < 29) throw new LimsError('common.internal', 'identity: sealed token invalid');
    try {
      const d = createDecipheriv('aes-256-gcm', key, enc.subarray(0, 12)).setAAD(Buffer.from(keyId));
      d.setAuthTag(enc.subarray(12, 28));
      return Buffer.concat([d.update(enc.subarray(28)), d.final()]).toString('utf8');
    } catch { throw new LimsError('common.internal', 'identity: sealed token invalid'); }
  };
}

export interface SessionRef { sessionId: string; tenantId: string | null; userId: string; kind: string }
export interface SessionPatch {
  state?: string; aal?: string; accessToken?: string; refreshToken?: string; accessExpiresAt?: Date; mfaFailedAttempts?: number;
  revoked?: { reason: 'mfa_failed' }; actorId: string;
}

const BY_TOKEN_SQL = `SELECT session_id, kind, state, tenant_id, user_id, membership_id, platform_staff_id, support_session_id, token_reused
  FROM app.identity_session_by_token($1)`;
// [CONV] e-mail for the account-failure key: core.users (tenant) / identity.platform_staff (platform). Row lock serialises parallel codes.
const LOAD_SQL = `SELECT s.aal, s.access_token_enc, s.refresh_token_enc, s.enc_key_id, s.mfa_failed_attempts, s.access_expires_at,
    s.idle_expires_at, s.absolute_expires_at, coalesce(u.email_normalized, p.email_normalized) AS email
  FROM identity.sessions s
  LEFT JOIN core.users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
  LEFT JOIN identity.platform_staff p ON p.id = s.platform_staff_id
  WHERE s.id = $1 AND s.user_id = $2 AND s.tenant_id IS NOT DISTINCT FROM $3 AND s.kind = $4
  FOR UPDATE OF s`;
const SESSION_UPDATE_DEFINER = 'SELECT app.identity_platform_auth_write_session_update($1::uuid, $2::uuid, $3::jsonb) AS n';
const FACTORS_SQL = `SELECT id, gotrue_factor_id, status, verified_at, friendly_name FROM identity.mfa_factors
  WHERE tenant_id IS NOT DISTINCT FROM $1 AND user_id = $2 AND status <> 'removed'`;
const FACTOR_INSERT_SQL = `INSERT INTO identity.mfa_factors (id, tenant_id, user_id, gotrue_factor_id, factor_type, status, friendly_name, created_by, updated_by)
  VALUES ($1, $2, $3, $4, 'totp', 'unverified', $5, $6, $6)`;
const FACTOR_DEFINER = 'SELECT app.identity_platform_auth_write_mfa_factor($1::uuid, $2::uuid, $3::jsonb) AS n';
const FACTOR_VERIFY_SQL = `UPDATE identity.mfa_factors SET status = $4, verified_at = $5, updated_at = now(), updated_by = $6, version = version + 1
  WHERE tenant_id = $1 AND id = $2 AND user_id = $3 AND status = 'unverified' RETURNING id`;
const FACTOR_REMOVE_SQL = `UPDATE identity.mfa_factors SET status = $4, removed_at = $5, removed_by = $6, removal_reason = $7, updated_at = now(),
    updated_by = $6, version = version + 1
  WHERE tenant_id = $1 AND id = $2 AND user_id = $3 AND status <> 'removed' RETURNING id`;
const TOUCH_SQL = 'UPDATE core.memberships SET last_login_at = $3, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND id = $2';
const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3)';
const PLATFORM_EVENT_SQL = `INSERT INTO identity.platform_events (id, event_type, target_type, target_id, target_tenant_id, detail, actor_platform_staff_id,
    request_id, client_ip, created_by)
  VALUES ($1, $2, $3, $4, NULL, $5::jsonb, $6, $7, nullif($8, '')::inet, $9)`;

const bytea = (b: Buffer) => `\\x${b.toString('hex')}`;   // jsonb_populate_record bytea text form
const iso = (d: Date) => d.toISOString();
/** DEFINER integer result: a returned 0 (or no row) is a failed write, never a silent success. */
function definerOk(rows: any[], what: string): void {
  const r = rows[0];
  if (!r || (r.n !== undefined && Number(r.n) < 1)) throw new LimsError('common.internal', `identity: ${what} not applied`);
}
function rowsOk(rows: any[], what: string): void { if (!rows.length) throw new LimsError('common.internal', `identity: ${what} not applied`); }

export function createMfaRepo(o: { seal?: Sealer; open?: Opener } = {}) {
  const seal = o.seal ?? sealerFromEnv();
  const open = o.open ?? openerFromEnv();

  return {
    async sessionByToken(tx: Q, sha: Buffer) {
      if (!Buffer.isBuffer(sha) || sha.length !== 32) throw new LimsError('common.internal', 'identity: token hash must be 32 bytes');
      const r = (await tx.query(BY_TOKEN_SQL, [sha])).rows[0];
      if (!r) return undefined;
      return { sessionId: r.session_id as string, kind: r.kind as string, state: r.state as string, tenantId: (r.tenant_id ?? null) as string | null,
        userId: r.user_id as string, membershipId: (r.membership_id ?? null) as string | null, platformStaffId: (r.platform_staff_id ?? null) as string | null,
        tokenReused: r.token_reused === true };
    },

    async loadSession(tx: Q, ref: SessionRef) {
      const r = (await tx.query(LOAD_SQL, [ref.sessionId, ref.userId, ref.tenantId, ref.kind])).rows[0];
      if (!r) return undefined;
      return {
        aal: r.aal as 'aal1' | 'aal2', accessToken: open(r.access_token_enc, r.enc_key_id), refreshToken: open(r.refresh_token_enc, r.enc_key_id),
        mfaFailedAttempts: Number(r.mfa_failed_attempts), email: typeof r.email === 'string' ? r.email.trim().normalize('NFC').toLowerCase() : '',
        accessExpiresAt: r.access_expires_at as Date, idleExpiresAt: r.idle_expires_at as Date, absoluteExpiresAt: r.absolute_expires_at as Date,
      };
    },

    async updateSession(tx: Q, ref: SessionRef, patch: SessionPatch): Promise<void> {
      const set: Record<string, unknown> = {};
      if (patch.accessToken !== undefined || patch.refreshToken !== undefined) {
        if (patch.accessToken === undefined || patch.refreshToken === undefined) throw new LimsError('common.internal', 'identity: token pair incomplete');
        const a = seal(patch.accessToken); const r = seal(patch.refreshToken);
        if (a.keyId !== r.keyId) throw new LimsError('common.internal');
        set['access_token_enc'] = a.enc; set['refresh_token_enc'] = r.enc; set['enc_key_id'] = a.keyId;
      }
      if (patch.state !== undefined) set['state'] = patch.state;
      if (patch.aal !== undefined) set['aal'] = patch.aal;
      if (patch.accessExpiresAt !== undefined) set['access_expires_at'] = patch.accessExpiresAt;
      if (patch.mfaFailedAttempts !== undefined) set['mfa_failed_attempts'] = patch.mfaFailedAttempts;
      if (patch.revoked) {   // sessions__revoke__ck: state + revoked_at + revoke_reason together
        set['state'] = 'revoked'; set['revoked_at'] = new Date(); set['revoke_reason'] = patch.revoked.reason; set['revoked_by'] = patch.actorId;
      }
      set['updated_by'] = patch.actorId;

      if (ref.kind === 'platform') {
        if (ref.tenantId !== null) throw new LimsError('common.internal');
        const j: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(set)) j[k] = Buffer.isBuffer(v) ? bytea(v) : v instanceof Date ? iso(v) : v;
        definerOk((await tx.query(SESSION_UPDATE_DEFINER, [ref.userId, ref.sessionId, JSON.stringify(j)])).rows, 'session update');
        return;
      }
      if (!ref.tenantId) throw new LimsError('common.internal');
      const p: unknown[] = [ref.tenantId, ref.sessionId, ref.userId];
      const cols = Object.entries(set).map(([k, v]) => { p.push(v); return k + ' = $' + p.length; });
      const sql = 'UPDATE identity.sessions SET ' + cols.join(', ') + ', updated_at = now(), version = version + 1'
        + ' WHERE tenant_id = $1 AND id = $2 AND user_id = $3 RETURNING id';
      rowsOk((await tx.query(sql, p)).rows, 'session update');
    },

    async factors(tx: Q, q: { tenantId: string | null; userId: string }) {
      return (await tx.query(FACTORS_SQL, [q.tenantId, q.userId])).rows.map((r: any) => ({
        id: r.id as string, gotrueFactorId: r.gotrue_factor_id as string, status: r.status as 'unverified' | 'verified',
        verifiedAt: (r.verified_at ?? null) as Date | null, friendlyName: (r.friendly_name ?? null) as string | null,
      }));
    },

    async insertFactor(tx: Q, a: { id: string; tenantId: string | null; userId: string; gotrueFactorId: string; friendlyName: string | null; actorId: string }): Promise<void> {
      if (a.tenantId) { await tx.query(FACTOR_INSERT_SQL, [a.id, a.tenantId, a.userId, a.gotrueFactorId, a.friendlyName, a.actorId]); return; }
      const now = iso(new Date());   // jsonb_populate_record + INSERT SELECT v.*: every NOT NULL column sent explicitly (08 A28.1)
      const row = { id: a.id, tenant_id: null, user_id: a.userId, gotrue_factor_id: a.gotrueFactorId, factor_type: 'totp', status: 'unverified',
        friendly_name: a.friendlyName, verified_at: null, removed_at: null, removed_by: null, removal_reason: null, is_active: true, version: 1,
        created_at: now, created_by: a.actorId, updated_at: now, updated_by: a.actorId };
      definerOk((await tx.query(FACTOR_DEFINER, [a.userId, null, JSON.stringify(row)])).rows, 'factor insert');
    },

    async markFactorVerified(tx: Q, a: { id: string; tenantId: string | null; userId: string; at: Date; actorId: string }): Promise<void> {
      if (a.tenantId) { rowsOk((await tx.query(FACTOR_VERIFY_SQL, [a.tenantId, a.id, a.userId, 'verified', a.at, a.actorId])).rows, 'factor verify'); return; }
      definerOk((await tx.query(FACTOR_DEFINER, [a.userId, a.id, JSON.stringify({ status: 'verified', verified_at: iso(a.at), updated_by: a.actorId })])).rows, 'factor verify');
    },

    async removeFactor(tx: Q, a: { id: string; tenantId: string | null; userId: string; reason: 're_enrol'; at: Date; actorId: string }): Promise<void> {
      if (a.tenantId) { rowsOk((await tx.query(FACTOR_REMOVE_SQL, [a.tenantId, a.id, a.userId, 'removed', a.at, a.actorId, a.reason])).rows, 'factor remove'); return; }
      const j = { status: 'removed', removed_at: iso(a.at), removed_by: a.actorId, removal_reason: a.reason, updated_by: a.actorId };
      definerOk((await tx.query(FACTOR_DEFINER, [a.userId, a.id, JSON.stringify(j)])).rows, 'factor remove');
    },

    async touchMembershipLogin(tx: Q, a: { tenantId: string; membershipId: string; at: Date; actorId: string }): Promise<void> {
      await tx.query(TOUCH_SQL, [a.tenantId, a.membershipId, a.at, a.actorId]);
    },

    async enqueue(tx: Q, taskIdentifier: string, payload: Record<string, unknown>, jobKey: string): Promise<void> {
      await tx.query(ENQUEUE_SQL, [taskIdentifier, JSON.stringify(payload), jobKey]);
    },

    async recordPlatformEvent(tx: Q, e: { id: string; eventType: string; targetType: string; targetId: string; actorPlatformStaffId: string;
      detail: Record<string, unknown>; requestId: string; clientIp: string; actorId: string }): Promise<void> {
      await tx.query(PLATFORM_EVENT_SQL, [e.id, e.eventType, e.targetType, e.targetId, JSON.stringify(e.detail ?? {}), e.actorPlatformStaffId,
        e.requestId, e.clientIp ?? '', e.actorId]);
    },
  };
}

export type MfaRepo = ReturnType<typeof createMfaRepo>;
