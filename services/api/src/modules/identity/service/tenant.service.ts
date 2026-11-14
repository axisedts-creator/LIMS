// Tenant provisioning + lifecycle, platform side (02-TRD §5.10; 03-APP-FLOW §2.3 T1-T5, §9.1; 01-PRD AC-E1.1-E1.3, US-E2, AC-C5.3;
// 07-SECURITY D-T13, D-T21; 08 R10 item 4 / A25 D-213 / D-214, A3.4, A8.3, A9.5, A13 P-1 / P-15).
// Acting identity comes from the platform ctx only (CR-C2-004). Every operation runs PlatformAuthz.assertPlatform before any repo / GoTrue call.
// core.tenants is written under platform claims; every tenant-scoped row is written inside ONE ctx.db.withTenantScope(target) window, and only by
// the D-214 allowlisted operations (listTenants / getTenant / updateTenant / getTenantSettingsAsPlatform never open one).
// Idempotency of provisionTenant / inviteTenantAdmin is the core platform store's (x-idempotency: required, tenant_id NULL, D-213).
// Everything runs on the request tx: a failure part-way propagates and the core pipeline rolls the whole bundle back (AC-E1.1).
// Reason texts (suspend / terminate) are stored on core.tenants.status_reason only: never logged, never in the access-log detail.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { access, type AccessLogEntry } from '../../../core/audit/access.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { REPO_ROOT } from '../../../core/module.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as role.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { validateSettingsPatch } from '../domain/settings.ranges.js';
import { validateNumberingPattern, type NumberingKind } from '../domain/numbering-pattern.js';
import { canTransition, STATES, type TenantStatus } from '../domain/tenant.state.js';
import type { GoTrueGateway } from '../gotrue/gateway.js';
import { PlatformAuthz } from '../platform/authz.js';
import { createInvitationsRepo } from '../repository/invitations.repo.js';
import { createSettingsRepo } from '../repository/settings.repo.js';
import { ROLE_GRANTS } from '../../../../../../contracts/ports/generated/permissions.js';
import { ASSET_COLUMNS, BOOLS, DEFERRED, EDITABLE, PATTERNS, PATTERN_MAX, PLATFORM_ONLY, UNSETTABLE, nextFiscalYear, toDto } from '../domain/settings.fields.js';
import type { PlatformCtx } from './support.service.js';

const READ = 'platform.tenant.read';
const MANAGE = 'platform.tenant.manage';
const TZ = 'Asia/Kathmandu';                                   // v1 single timezone (08 A13 P-15, D-T21)
const CODE = /^[a-z][a-z0-9_]{2,31}$/;
const OU_CODE = /^[A-Za-z0-9-]{1,16}$/;
const FLAG_CODE = /^[a-z][a-z0-9_]{2,63}$/;
const PAN = /^[0-9]{9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = ['own', 'franchise', 'home_collection'];
const CALENDARS = ['AD', 'BS', 'AD_BS', 'BS_AD'];
const SORTS = ['code', '-created_at'];
const TENANT_ANNEXES = ['annex_2', 'annex_3', 'annex_7'] as const;   // annex_1 is platform-level (05-SCHEMA §4.12)
const INVITE_TTL_MS = 72 * 3_600_000;                                   // 03-APP-FLOW §4.1 (same as inviteUser)
const SEND_INVITATION = 'identity.send_invitation';
const SIGNOUT = 'identity.gotrue_signout';
const SIGNOUT_BATCH = 200;                                              // users per identity.gotrue_signout job [CONV]
const LIST_DEFAULT = 50, LIST_MAX = 200;
const LIFECYCLE = 'tenant.lifecycle_change';
// Default tenant roles = contracts/permissions.yaml `roles:` (read once, like role.service reads the permission phases).
const DEFAULT_ROLES: ReadonlyArray<{ code: string; mfa_required: boolean; description?: string }> =
  (parse(readFileSync(join(REPO_ROOT, 'contracts', 'permissions.yaml'), 'utf8')) as { roles: Array<{ code: string; mfa_required: boolean; description?: string }> }).roles;
const ROLE_CODES = DEFAULT_ROLES.map((r) => r.code);
// LD-26 (2026-11-07): training_mode is set only by provisionTenant and immutable after; a platform settings PATCH naming it is refused.
const PLATFORM_EDITABLE = new Set([...[...EDITABLE].filter((k) => !ASSET_COLUMNS.has(k)), ...PLATFORM_ONLY]);   // asset pointers: tenant path only (needs the asset scan check)
const PLATFORM_UNSETTABLE = new Set([...[...UNSETTABLE].filter((k) => !ASSET_COLUMNS.has(k)), ...PLATFORM_ONLY]);

export type Status = TenantStatus;
export interface TRow {
  id: string; code: string; legal_name: string; display_name: string; status: Status; timezone: string; status_reason: string | null; activated_at: Date | string | null;
  suspended_at: Date | string | null; offboarded_at: Date | string | null; billing_live_on: Date | string | null; created_at: Date | string; version: number;
}
export interface Readiness { acceptedAdmins: number; activeBranches: number; activeCentres: number }
type Meta = { actor: PlatformCtx['actor']; requestId?: string | undefined };
export interface TenantRepo {
  findByCode(tx: unknown, code: string): Promise<TRow | undefined>;
  find(tx: unknown, id: string): Promise<TRow | undefined>;
  list(tx: unknown, f: { status?: string; sort?: string; cursor?: string; limit?: number }): Promise<TRow[]>;
  insert(tx: unknown, a: { id: string; code: string; legalName: string; displayName: string; pan?: string; timezone: string; actorId: string }): Promise<TRow>;
  update(tx: unknown, id: string, expectedVersion: number, p: { legalName?: string; displayName?: string; billingLiveOn?: string | null; actorId: string }): Promise<TRow | undefined>;
  setStatus(tx: unknown, id: string, expectedVersion: number, p: { status: Status; reason?: string; at: Date; actorId: string }): Promise<TRow | undefined>;
  detail(tx: unknown, id: string): Promise<{ counts: { users: number; branches: number; centres: number }; history: Array<{ from?: string; to: string; at: Date | string }>; annexReadiness: 'complete' | 'incomplete' }>;
  readiness(tx: unknown, id: string): Promise<Readiness>;
  // ---- SCOPED (inside ctx.db.withTenantScope(tenantId)) ----
  insertBranch(tx: unknown, t: string, b: { id: string; code: string; name: string; addressText?: string; actorId: string }): Promise<void>;
  insertCentre(tx: unknown, t: string, c: { id: string; code: string; name: string; kind: string; branchId: string; addressText?: string; actorId: string }): Promise<void>;
  seedRoles(tx: unknown, t: string, roleCodes: readonly string[], actorId: string): Promise<void>;
  insertSettings(tx: unknown, t: string, s: { timezone: string; calendarDisplay?: string; pan?: string; legalName: string; displayName: string; trainingMode: boolean; actorId: string }): Promise<void>;
  seedFlags(tx: unknown, t: string, actorId: string): Promise<void>;
  seedIrdAnnexes(tx: unknown, t: string, annexCodes: readonly string[], actorId: string): Promise<void>;
  insertAcceptances(tx: unknown, t: string, rows: Array<{ document: 'tos' | 'dpa'; version: string; acceptedByName: string; acceptedByTitle: string; acceptedAt: string; actorId: string }>): Promise<void>;
  insertAdmin(tx: unknown, t: string, a: { userId: string; membershipId: string; displayName: string; emailNormalized: string; emailHmac: Buffer; actorId: string }): Promise<void>;
  insertInvitation(tx: unknown, t: string, i: { id: string; membershipId: string; userId: string; email: string; expiresAt: Date; actorId: string }): Promise<void>;
  accessLog(tx: unknown, t: string, e: AccessLogEntry, meta?: Meta): Promise<void>;
  revokeTenantSessions(tx: unknown, t: string, o: { reason: string; actorId: string }): Promise<string[]>;
  deactivateMemberships(tx: unknown, t: string, o: { at: Date; by: string; reasonCode: 'other'; actorId: string }): Promise<number>;
  tenantUserIds(tx: unknown, t: string): Promise<string[]>;
  findSettings(tx: unknown, t: string): Promise<Record<string, any> | undefined>;
  updateSettings(tx: unknown, t: string, expectedVersion: number, set: Record<string, unknown>, unset: string[], actorId: string): Promise<Record<string, any> | undefined>;
  findFlag(tx: unknown, t: string, code: string): Promise<{ code: string; requires_founder_approval: boolean; is_enabled: boolean; [k: string]: unknown } | undefined>;
  updateFlag(tx: unknown, t: string, code: string, p: { isEnabled: boolean; approvalRef?: string; actorId: string }): Promise<void>;
  enqueue(tx: unknown, identifier: string, payload: Record<string, unknown>, jobKey: string): Promise<void>;
}

// ------------------------------------------------------------------------------------------------ default repo (SQL on the request tx)
type Tx = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
// Constant column list (no input is ever interpolated; values are bind parameters).
const T_COLS = `id, tenant_code AS code, legal_name, display_name, status, timezone, status_reason, activated_at, suspended_at, offboarded_at,
  to_char(billing_live_on, 'YYYY-MM-DD') AS billing_live_on, created_at, version`;
const SELECT_T = `SELECT id, tenant_code AS code, legal_name, display_name, status, timezone, status_reason, activated_at, suspended_at, offboarded_at,
  to_char(billing_live_on, 'YYYY-MM-DD') AS billing_live_on, created_at, version FROM core.tenants t`;

export function createTenantRepo(): TenantRepo {
  const q = async (tx: unknown, sql: string, params: unknown[]) => (await (tx as Tx).query(sql, params)).rows;
  const inv = createInvitationsRepo();
  const settings = createSettingsRepo();
  return {
    findByCode: async (tx, code) => (await q(tx, `${SELECT_T} WHERE t.tenant_code = $1`, [code]))[0],
    find: async (tx, id) => (await q(tx, `${SELECT_T} WHERE t.id = $1`, [id]))[0],
    // ponytail: keyset on (code) / (created_at, id) via the cursor tenant id; 200 rows max per page.
    list: (tx, f) => q(tx, `${SELECT_T}
        WHERE ($1::text IS NULL OR t.status = $1)
          AND ($2::uuid IS NULL OR (CASE WHEN $3 = 'code' THEN t.tenant_code > (SELECT c.tenant_code FROM core.tenants c WHERE c.id = $2)
               ELSE (t.created_at, t.id) < (SELECT c.created_at, c.id FROM core.tenants c WHERE c.id = $2) END))
        ORDER BY CASE WHEN $3 = 'code' THEN t.tenant_code END, t.created_at DESC, t.id DESC LIMIT $4`,
    [f.status ?? null, f.cursor ?? null, f.sort ?? '-created_at', f.limit ?? LIST_DEFAULT]),
    async insert(tx, a) {
      return (await q(tx, `INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, timezone, created_by, updated_by)
        VALUES ($1, $2, $3, $4, 'provisioning', $5, $6, $6) RETURNING ${T_COLS}`, [a.id, a.code, a.legalName, a.displayName, a.timezone, a.actorId]))[0];
    },
    async update(tx, id, v, p) {
      // Constant statement: $3/$4 NULL = keep; $5 = whether billing_live_on is written (value $6, NULL = unset).
      return (await q(tx, `UPDATE core.tenants SET legal_name = COALESCE($3, legal_name), display_name = COALESCE($4, display_name),
          billing_live_on = CASE WHEN $5 THEN $6::date ELSE billing_live_on END, version = version + 1, updated_at = now(), updated_by = $7
        WHERE id = $1 AND version = $2 RETURNING ${T_COLS}`,
      [id, v, p.legalName ?? null, p.displayName ?? null, 'billingLiveOn' in p, p.billingLiveOn ?? null, p.actorId]))[0];
    },
    async setStatus(tx, id, v, p) {
      return (await q(tx, `UPDATE core.tenants SET status = $3, status_reason = COALESCE($4, status_reason),
          activated_at = CASE WHEN $3 = 'active' AND activated_at IS NULL THEN $5 ELSE activated_at END,
          suspended_at = CASE WHEN $3 = 'suspended' THEN $5 ELSE suspended_at END,
          offboarded_at = CASE WHEN $3 = 'offboarded' THEN $5 ELSE offboarded_at END,
          version = version + 1, updated_at = now(), updated_by = $6
        WHERE id = $1 AND version = $2 RETURNING ${T_COLS}`, [id, v, p.status, p.reason ?? null, p.at, p.actorId]))[0];
    },
    async detail(tx, id) {
      // Open: no __platform SELECT policy on memberships/branches/collection_centres/ird_annex_records/audit_log, so under RLS this yields 0s / [] / 'incomplete'.
      // CR: .orchestra/cr/C2.T22-detail.md (platform read path, e.g. DEFINER app.platform_tenant_detail(uuid)). Status history = core.tenants audit rows that changed status.
      const r = (await q(tx, `SELECT
          (SELECT count(*)::int FROM core.memberships m WHERE m.tenant_id = $1 AND m.actor_type = 'user') AS users,
          (SELECT count(*)::int FROM core.branches b WHERE b.tenant_id = $1) AS branches,
          (SELECT count(*)::int FROM core.collection_centres c WHERE c.tenant_id = $1) AS centres,
          (SELECT count(DISTINCT a.annex_code)::int FROM identity.ird_annex_records a WHERE a.tenant_id = $1 AND a.status = 'completed' AND a.is_active) AS annexes_done,
          COALESCE((SELECT json_agg(json_build_object('from', l.old_values ->> 'status', 'to', l.new_values ->> 'status', 'at', l.occurred_at) ORDER BY l.occurred_at)
            FROM (SELECT * FROM audit.audit_log l WHERE l.tenant_id = $1 AND l.schema_name = 'core' AND l.table_name = 'tenants'
                    AND l.new_values ? 'status' ORDER BY l.occurred_at DESC LIMIT 200) l), '[]') AS history`, [id]))[0];
      return { counts: { users: r.users, branches: r.branches, centres: r.centres }, history: r.history, annexReadiness: r.annexes_done >= TENANT_ANNEXES.length ? 'complete' : 'incomplete' };
    },
    async readiness(tx, id) {
      const r = (await q(tx, `SELECT
          (SELECT count(*)::int FROM core.memberships m WHERE m.tenant_id = $1 AND m.actor_type = 'user' AND m.status = 'active' AND m.accepted_at IS NOT NULL
             AND EXISTS (SELECT 1 FROM core.membership_roles mr JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.is_active
                         WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id AND r.role_code = 'tenant_admin')) AS admins,
          (SELECT count(*)::int FROM core.branches b WHERE b.tenant_id = $1 AND b.is_active) AS branches,
          (SELECT count(*)::int FROM core.collection_centres c WHERE c.tenant_id = $1 AND c.is_active) AS centres`, [id]))[0];
      return { acceptedAdmins: r.admins, activeBranches: r.branches, activeCentres: r.centres };
    },
    async insertBranch(tx, t, b) {
      await q(tx, `INSERT INTO core.branches (id, tenant_id, branch_code, name, address_text, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [b.id, t, b.code, b.name, b.addressText ?? null, b.actorId]);
    },
    async insertCentre(tx, t, c) {
      await q(tx, `INSERT INTO core.collection_centres (id, tenant_id, branch_id, centre_code, name, centre_kind, address_text, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`, [c.id, t, c.branchId, c.code, c.name, c.kind, c.addressText ?? null, c.actorId]);
    },
    async seedRoles(tx, t, codes, actorId) {
      for (const code of codes) {
        const r = DEFAULT_ROLES.find((x) => x.code === code)!;
        const id = uuidv7();
        // [CONV] display_name = the role code (<= 80); tenant admins rename via updateRole.
        await q(tx, `INSERT INTO core.roles (id, tenant_id, role_code, display_name, description, is_system_default, mfa_required, created_by, updated_by)
          VALUES ($1, $2, $3, $3, $4, true, $5, $6, $6)`, [id, t, code, (r.description ?? '').slice(0, 300) || null, r.mfa_required, actorId]);
        await q(tx, `INSERT INTO core.role_permissions (tenant_id, role_id, permission_code, created_by)
          SELECT $1, $2, x, $4 FROM unnest($3::text[]) AS x`, [t, id, [...(ROLE_GRANTS[code] ?? [])], actorId]);
      }
    },
    async insertSettings(tx, t, s) {
      // LD-26: training_mode column per CR-C2-T16 (.orchestra/cr/C2.T16.nonblocking.md). Until it lands this statement fails loudly rather than
      // silently provisioning a live (CBMS-syncing) tenant that was meant to be a training tenant.
      await q(tx, `INSERT INTO identity.tenant_settings (tenant_id, timezone, calendar_display, ird_pan, legal_name_snapshot, display_name, training_mode, created_by, updated_by)
        VALUES ($1, $2, COALESCE($3, 'AD'), $4, $5, $6, $7, $8, $8)`, [t, s.timezone, s.calendarDisplay ?? null, s.pan ?? null, s.legalName, s.displayName, s.trainingMode, s.actorId]);
    },
    async seedFlags(tx, t, actorId) {
      await q(tx, `INSERT INTO identity.feature_flags (tenant_id, flag_code, is_enabled, created_by, updated_by)
        SELECT $1, g.code, g.default_enabled AND NOT g.requires_founder_approval, $2, $2 FROM identity.g_feature_flags g`, [t, actorId]);
    },
    async seedIrdAnnexes(tx, t, codes, actorId) {
      for (const c of codes) {
        await q(tx, `INSERT INTO identity.ird_annex_records (id, tenant_id, annex_code, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)`, [uuidv7(), t, c, actorId]);
      }
    },
    async insertAcceptances(tx, t, rows) {
      // LD-29 (2026-11-07): append-only acceptance rows. Table name/DDL requested in .orchestra/cr/C2.T22.md (CR-C2-T22).
      for (const r of rows) {
        await q(tx, `INSERT INTO identity.tenant_contract_acceptances (id, tenant_id, document, version, accepted_by_name, accepted_by_title, accepted_at, recorded_by, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`, [uuidv7(), t, r.document, r.version, r.acceptedByName, r.acceptedByTitle, r.acceptedAt, r.actorId]);
      }
    },
    async insertAdmin(tx, t, a) {
      await q(tx, `INSERT INTO core.users (tenant_id, id, display_name, email_normalized, email_hmac, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [t, a.userId, a.displayName, a.emailNormalized, a.emailHmac, a.actorId]);
      await q(tx, `INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, all_centres, status, invited_at, created_by, updated_by)
        VALUES ($2, $1, $3, 'user', true, 'invited', now(), $4, $4)`, [t, a.membershipId, a.userId, a.actorId]);
      const hit = await q(tx, `INSERT INTO core.membership_roles (tenant_id, membership_id, role_id, created_by)
        SELECT $1, $2, r.id, $3 FROM core.roles r WHERE r.tenant_id = $1 AND r.role_code = 'tenant_admin' AND r.is_active RETURNING role_id`, [t, a.membershipId, a.actorId]);
      if (!hit.length) throw new LimsError('common.internal', 'identity: tenant_admin role missing');
    },
    insertInvitation: inv.insertInvitation,
    async accessLog(tx, t, e, meta) {
      if (!meta) throw new LimsError('common.internal');
      await access({ tenantId: t, requestId: meta.requestId as string, actor: meta.actor, tx }, e);
    },
    async revokeTenantSessions(tx, t, o) {
      return (await q(tx, `UPDATE identity.sessions SET state = 'revoked', revoked_at = now(), revoked_by = $3, revoke_reason = $2,
          version = version + 1, updated_at = now(), updated_by = $3
        WHERE tenant_id = $1 AND state NOT IN ('revoked', 'expired') RETURNING user_id`, [t, o.reason, o.actorId])).map((r) => r.user_id)
        .filter((u: string, i: number, all: string[]) => all.indexOf(u) === i);
    },
    async deactivateMemberships(tx, t, o) {
      // 08 A3.4: status only (is_active is derived); A8.3 / A9.5 / D-T13: deactivated_by = the platform staff user, reason 'other'.
      return (await q(tx, `UPDATE core.memberships SET status = 'deactivated', deactivated_at = $2, deactivated_by = $3, deactivation_reason_code = $4,
          version = version + 1, updated_at = now(), updated_by = $5
        WHERE tenant_id = $1 AND status <> 'deactivated' RETURNING id`, [t, o.at, o.by, o.reasonCode, o.actorId])).length;
    },
    tenantUserIds: async (tx, t) => (await q(tx, `SELECT DISTINCT user_id FROM core.memberships WHERE tenant_id = $1 AND actor_type = 'user'`, [t])).map((r) => r.user_id),
    findSettings: settings.findSettings,       // T16 statement (platform SELECT policy)
    async updateSettings(tx, t, v, set, unset, actorId) {
      // T16 versioned statement for the tenant-editable columns; the platform-only columns it never writes follow in the same tx (no second bump).
      const { ird_pan, ird_annex_1_record_id, ...rest } = set as Record<string, unknown>;
      const plat: Record<string, unknown> = {};
      for (const [k, val] of [['ird_pan', ird_pan], ['ird_annex_1_record_id', ird_annex_1_record_id]] as const) if (val !== undefined) plat[k] = val;
      for (const k of unset) if (PLATFORM_ONLY.has(k)) plat[k] = null;
      const out = await settings.updateSettings(tx, t, v, rest, unset.filter((k) => !PLATFORM_ONLY.has(k)), actorId);
      if (!out || !Object.keys(plat).length) return out;
      await q(tx, `UPDATE identity.tenant_settings SET
          ird_pan = CASE WHEN $2::jsonb ? 'ird_pan' THEN $2::jsonb ->> 'ird_pan' ELSE ird_pan END,
          ird_annex_1_record_id = CASE WHEN $2::jsonb ? 'ird_annex_1_record_id' THEN ($2::jsonb ->> 'ird_annex_1_record_id')::uuid ELSE ird_annex_1_record_id END,
          updated_at = now(), updated_by = $3 WHERE tenant_id = $1`, [t, JSON.stringify(plat), actorId]);
      return settings.findSettings(tx, t);
    },
    findFlag: async (tx, t, code) => (await q(tx, `SELECT f.flag_code AS code, g.description, g.scope, g.settable_by, g.requires_founder_approval, g.blocker_ref,
        f.is_enabled, (f.approval_ref IS NOT NULL) AS approval_ref_present, f.version
      FROM identity.feature_flags f JOIN identity.g_feature_flags g ON g.code = f.flag_code WHERE f.tenant_id = $1 AND f.flag_code = $2`, [t, code]))[0],
    async updateFlag(tx, t, code, p) {
      await q(tx, `UPDATE identity.feature_flags SET is_enabled = $3, approval_ref = $4, version = version + 1, updated_at = now(), updated_by = $5
        WHERE tenant_id = $1 AND flag_code = $2`, [t, code, p.isEnabled, p.approvalRef ?? null, p.actorId]);
    },
    async enqueue(tx, identifier, payload, jobKey) {
      await q(tx, 'SELECT app.enqueue_job($1, $2::jsonb, $3)', [identifier, JSON.stringify(payload), jobKey]);
    },
  };
}

// ------------------------------------------------------------------------------------------------ validation + wire helpers
export interface Result { status: number; body: any; version?: number }
type Ctx = PlatformCtx & { readonly log?: unknown; readonly clientIp?: string };
type Acc = { version: string; acceptedByName: string; acceptedByTitle: string; acceptedAt: string };

const err = (path: string, code = 'common.field_invalid'): FieldError => ({ path, code, message: 'Field invalid' });
const fail = (errors: FieldError[]): never => { throw new LimsError('common.validation_failed', undefined, errors); };
const failAt = (path: string): never => fail([err(path)]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, lo: number, hi: number) => typeof v === 'string' && v.length >= lo && v.length <= hi;
const intIn = (v: unknown, lo: number, hi: number) => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isoUtc = (v: unknown) => typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));
const isoDate = (v: unknown) => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const iso = (v: Date | string | null | undefined) => (v === null || v === undefined ? undefined : new Date(v).toISOString());
const normEmail = (v: unknown) => (typeof v === 'string' ? v.trim().normalize('NFC').toLowerCase() : '');
const okEmail = (e: string) => e.length >= 3 && e.length <= 254 && EMAIL.test(e);
const notFound = () => new LimsError('common.not_found');
const conflict = () => new LimsError('common.version_conflict');
function expected(v: unknown): number {
  if (v === undefined || v === null) throw new LimsError('common.precondition_required');
  return intIn(v, 1, 2147483647) ? (v as number) : failAt('/If-Match');
}
/** P-15 / D-T21: the single v1 timezone. */
const timezoneOk = (v: unknown, path = '/timezone') => {
  if (v !== TZ) throw new LimsError('identity.setting_out_of_range', undefined, [err(path, 'identity.setting_out_of_range')]);
};

/** Tenant (contracts/openapi/identity.yaml): absent optionals omitted, never null. */
export function toTenant(r: TRow) {
  const bl = r.billing_live_on;
  const opt: Record<string, unknown> = {
    status_reason: r.status_reason ?? undefined, activated_at: iso(r.activated_at), suspended_at: iso(r.suspended_at), offboarded_at: iso(r.offboarded_at),
    billing_live_on: bl === null || bl === undefined ? undefined : typeof bl === 'string' ? bl : bl.toISOString().slice(0, 10),
  };
  return {
    tenant_id: r.id, code: r.code, legal_name: r.legal_name, display_name: r.display_name, status: r.status, timezone: r.timezone,
    ...Object.fromEntries(Object.entries(opt).filter(([, v]) => v !== undefined)), created_at: iso(r.created_at)!, version: r.version,
  };
}

/** Authz first (P-8), then the ctx fields the operation relies on. */
function guard(ctx: Ctx, permission: string) {
  PlatformAuthz.assertPlatform(ctx, permission);
  if (!ctx.tx || typeof ctx.db?.withTenantScope !== 'function') throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, actorId: ctx.actor.id, now: ctx.now ? ctx.now() : new Date() };
}
type S = ReturnType<typeof guard>;

function accInput(v: unknown, path: string, out: FieldError[]): Acc | undefined {
  if (!isObj(v)) { out.push(err(path)); return undefined; }
  const n = out.length;
  if (!str(v['version'], 1, 32)) out.push(err(`${path}/version`));
  if (!str(v['acceptedByName'], 1, 120)) out.push(err(`${path}/accepted_by_name`));
  if (!str(v['acceptedByTitle'], 1, 80)) out.push(err(`${path}/accepted_by_title`));
  if (!isoUtc(v['acceptedAt'])) out.push(err(`${path}/accepted_at`));
  if (out.length !== n) return undefined;
  return { version: v['version'] as string, acceptedByName: v['acceptedByName'] as string, acceptedByTitle: v['acceptedByTitle'] as string, acceptedAt: v['acceptedAt'] as string };
}
function ouInput(v: unknown, path: string, out: FieldError[], centre: boolean): Record<string, unknown> | undefined {
  if (!isObj(v)) { out.push(err(path)); return undefined; }
  if (!(typeof v['code'] === 'string' && OU_CODE.test(v['code']))) out.push(err(`${path}/code`));
  if (!str(v['name'], 1, 120)) out.push(err(`${path}/name`));
  if (v['addressText'] !== undefined && !str(v['addressText'], 0, 300)) out.push(err(`${path}/address_text`));
  if (centre && !KINDS.includes(v['kind'] as string)) out.push(err(`${path}/kind`));
  return v;
}
const optText = (v: unknown, key: string) => (v === undefined ? {} : { [key]: v as string });

export function createTenantService(deps: {
  repo?: TenantRepo; gotrue?: Pick<GoTrueGateway, 'adminCreateUser'>; emailHmac?: (emailNormalized: string) => Buffer;
  userExists?: (tx: unknown, userId: string) => Promise<boolean>; newId?: () => string;
} = {}) {
  const repo = deps.repo ?? createTenantRepo();
  const newId = deps.newId ?? uuidv7;
  const userExists = deps.userExists ?? (async (tx: unknown, id: string) => (await (tx as Tx).query('SELECT app.identity_user_exists($1) AS e', [id])).rows[0]?.e === true);
  const need = <T>(v: T | undefined): T => { if (v === undefined) throw new LimsError('common.internal'); return v; };   // wired by tenant.http.ts; absent -> fail closed
  const meta = (ctx: Ctx): Meta => ({ actor: ctx.actor, requestId: ctx.requestId });
  const scoped = <T>(ctx: Ctx, tenantId: string, fn: () => Promise<T>) => ctx.db.withTenantScope(ctx.tx, tenantId, fn);
  const log = (ctx: Ctx, t: string, e: Omit<AccessLogEntry, 'outcome'>) => repo.accessLog(ctx.tx, t, { ...e, outcome: 'allowed' }, meta(ctx));

  async function load(s: S, id: unknown): Promise<TRow> {
    if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
    const t = await repo.find(s.tx, id);
    if (!t) throw notFound();
    return t;
  }
  /** Create (or reuse an orphan of a rolled-back attempt) the GoTrue user; a core.users row anywhere -> 409 (AC-B1.3). Called BEFORE any tx write. */
  async function gotrueUser(s: S, email: string): Promise<string> {
    const g = await need(deps.gotrue).adminCreateUser({ email, emailConfirm: false });
    if ('exists' in g && g.exists && (await userExists(s.tx, g.userId))) throw new LimsError('identity.user_exists');
    return g.userId;
  }
  /** Invited tenant_admin + invitation + send job (03-APP-FLOW §4.1). Inside the target tenant scope. */
  async function inviteAdmin(s: S, t: string, userId: string, email: string, displayName: string) {
    const membershipId = newId(), invitationId = newId();
    const expiresAt = new Date(s.now.getTime() + INVITE_TTL_MS);
    try {
      await repo.insertAdmin(s.tx, t, { userId, membershipId, displayName, emailNormalized: email, emailHmac: need(deps.emailHmac)(email), actorId: s.actorId });
    } catch (e) {
      if ((e as { code?: unknown })?.code === '23505') throw new LimsError('identity.user_exists');   // race with a concurrent invite
      throw e;
    }
    await repo.insertInvitation(s.tx, t, { id: invitationId, membershipId, userId, email, expiresAt, actorId: s.actorId });
    await repo.enqueue(s.tx, SEND_INVITATION, { tenant_id: t, invitation_id: invitationId }, `invite:${invitationId}:1`);
    return { membershipId, expiresAt };
  }
  /** Revoke every live session of the tenant + GoTrue sign-out fan-out (200 users per job), committed with the status change (US-E2). */
  async function signOutTenant(s: S, t: string, reason: string, toVersion: number) {
    const users = await repo.revokeTenantSessions(s.tx, t, { reason, actorId: s.actorId });
    for (let n = 0; n * SIGNOUT_BATCH < users.length; n++) {
      const user_ids = users.slice(n * SIGNOUT_BATCH, (n + 1) * SIGNOUT_BATCH);
      await repo.enqueue(s.tx, SIGNOUT, { tenant_id: t, user_ids, reason }, `signout:tenant:${t}.${toVersion}.${n}:${reason}`);   // worker needs exactly {tenant_id,user_ids,reason}; key form as role.service (02-TRD §10)
    }
  }
  const setStatus = async (s: S, t: TRow, v: number, status: Status, reason?: string) => {
    const r = await repo.setStatus(s.tx, t.id, v, { status, ...(reason === undefined ? {} : { reason }), at: s.now, actorId: s.actorId });
    if (!r) throw conflict();
    return r;
  };
  const reasonOk = (i: Record<string, unknown>) => { if (!str(i['reasonText'], 1, 500)) failAt('/reason_text'); };
  /** Shared T2-T5 path: authz, input, If-Match, edge check (03-APP-FLOW §2.3), then ONE scope window with the change + the access log. */
  async function transition(ctx: Ctx, input: unknown, to: Status, validate: (i: Record<string, unknown>) => void,
    inScope: (s: S, t: TRow, v: number, i: Record<string, unknown>) => Promise<TRow>): Promise<Result> {
    const s = guard(ctx, MANAGE);
    const i = isObj(input) ? input : {};
    validate(i);
    const v = expected(i['expectedVersion']);
    const t = await load(s, i['tenantId']);
    if (!canTransition(t.status, to) || t.version !== v) throw conflict();   // illegal edge -> 409 (T21 convention)
    const out = await scoped(ctx, t.id, async () => {
      const row = await inScope(s, t, v, i);
      await log(ctx, t.id, { action: LIFECYCLE, entityType: 'tenant', entityId: t.id, detail: { from_status: t.status, to_status: to } });
      return row;
    });
    return { status: 200, body: toTenant(out), version: out.version };
  }

  return {
    async listTenants(ctx: Ctx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, READ);
      const i = isObj(input) ? input : {};
      const out: FieldError[] = [];
      if (i['status'] !== undefined && !(STATES as readonly unknown[]).includes(i['status'])) out.push(err('/status'));
      if (i['sort'] !== undefined && !SORTS.includes(i['sort'] as string)) out.push(err('/sort'));
      if (i['cursor'] !== undefined && !(typeof i['cursor'] === 'string' && UUID.test(i['cursor']))) out.push(err('/cursor'));   // [CONV] cursor = last tenant id
      if (i['limit'] !== undefined && !intIn(i['limit'], 1, LIST_MAX)) out.push(err('/limit'));
      if (out.length) fail(out);
      const limit = (i['limit'] as number | undefined) ?? LIST_DEFAULT;
      const f: { status?: string; sort?: string; cursor?: string; limit?: number } = { sort: (i['sort'] as string | undefined) ?? '-created_at', limit: limit + 1 };
      if (i['status'] !== undefined) f.status = i['status'] as string;
      if (i['cursor'] !== undefined) f.cursor = i['cursor'] as string;
      const rows = await repo.list(s.tx, f);
      const data = rows.slice(0, limit).map(toTenant);
      return { status: 200, body: { data, page: rows.length > limit ? { next_cursor: data[data.length - 1]!.tenant_id, limit } : { limit } } };
    },

    async provisionTenant(ctx: Ctx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      const i = isObj(input) ? input : {};
      const out: FieldError[] = [];
      if (!(typeof i['code'] === 'string' && CODE.test(i['code']))) out.push(err('/code'));
      if (!str(i['legalName'], 1, 200)) out.push(err('/legal_name'));
      if (!str(i['displayName'], 1, 120)) out.push(err('/display_name'));
      if (i['pan'] !== undefined && !(typeof i['pan'] === 'string' && PAN.test(i['pan']))) out.push(err('/pan'));
      if (i['calendarDisplay'] !== undefined && !CALENDARS.includes(i['calendarDisplay'] as string)) out.push(err('/calendar_display'));
      if (i['trainingMode'] !== undefined && typeof i['trainingMode'] !== 'boolean') out.push(err('/training_mode'));
      const branch = ouInput(i['firstBranch'], '/first_branch', out, false);
      const centre = ouInput(i['firstCentre'], '/first_centre', out, true);
      const admin = isObj(i['firstAdmin']) ? i['firstAdmin'] : undefined;
      if (!admin) out.push(err('/first_admin'));
      const email = normEmail(admin?.['email']);
      if (admin && !okEmail(email)) out.push(err('/first_admin/email'));
      if (admin && !str(admin['displayName'], 1, 120)) out.push(err('/first_admin/display_name'));
      // LD-29 (2026-11-07): provisioning fails without BOTH the ToS and the DPA acceptance.
      const ca = i['contractAcceptance'];
      let tos: Acc | undefined, dpa: Acc | undefined;
      if (!isObj(ca)) out.push(err('/contract_acceptance'));
      else { tos = accInput(ca['tos'], '/contract_acceptance/tos', out); dpa = accInput(ca['dpa'], '/contract_acceptance/dpa', out); }
      if (out.length || !branch || !centre || !admin || !tos || !dpa) return fail(out);
      timezoneOk(i['timezone'] === undefined ? TZ : i['timezone']);
      const code = i['code'] as string, legalName = i['legalName'] as string, displayName = i['displayName'] as string;
      const pan = optText(i['pan'], 'pan') as { pan?: string };
      // LD-26 (2026-11-07): training_mode is fixed here, at provisioning, and never changes afterwards.
      const trainingMode = i['trainingMode'] === true;

      if (await repo.findByCode(s.tx, code)) throw new LimsError('identity.code_duplicate');   // AC-E1.2, before GoTrue
      const userId = await gotrueUser(s, email);
      const id = newId();
      let row: TRow;
      try {
        row = await repo.insert(s.tx, { id, code, legalName, displayName, ...pan, timezone: TZ, actorId: s.actorId });
      } catch (e) {
        if ((e as { code?: unknown })?.code === '23505') throw new LimsError('identity.code_duplicate');   // race on tenants__tenant_code__uq
        throw e;
      }
      const branchId = newId();
      await scoped(ctx, id, async () => {
        await repo.insertBranch(s.tx, id, { id: branchId, code: branch['code'] as string, name: branch['name'] as string, ...optText(branch['addressText'], 'addressText'), actorId: s.actorId });
        await repo.insertCentre(s.tx, id, { id: newId(), code: centre['code'] as string, name: centre['name'] as string, kind: centre['kind'] as string, branchId,
          ...optText(centre['addressText'], 'addressText'), actorId: s.actorId });
        await repo.seedRoles(s.tx, id, ROLE_CODES, s.actorId);
        await repo.insertSettings(s.tx, id, { timezone: TZ, ...optText(i['calendarDisplay'], 'calendarDisplay'), ...pan, legalName, displayName, trainingMode, actorId: s.actorId });
        await repo.seedFlags(s.tx, id, s.actorId);
        await repo.seedIrdAnnexes(s.tx, id, TENANT_ANNEXES, s.actorId);
        // LD-29: recorded_by = the platform staff user (platform staff hold no membership) [CONV].
        await repo.insertAcceptances(s.tx, id, [{ document: 'tos', ...tos, actorId: s.actorId }, { document: 'dpa', ...dpa, actorId: s.actorId }]);
        await inviteAdmin(s, id, userId, email, admin['displayName'] as string);
        await log(ctx, id, { action: LIFECYCLE, entityType: 'tenant', entityId: id, detail: { to_status: 'provisioning' } });
      });
      return { status: 201, body: toTenant(row), version: row.version };
    },

    async getTenant(ctx: Ctx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, READ);
      const t = await load(s, isObj(input) ? input['tenantId'] : undefined);
      const d = await repo.detail(s.tx, t.id);
      const history = d.history.map((h) => ({ ...(h.from ? { from_status: h.from } : {}), to_status: h.to, occurred_at: iso(h.at)! }));
      return { status: 200, body: { ...toTenant(t), counts: d.counts, status_history: history, annex_readiness: d.annexReadiness }, version: t.version };
    },

    async updateTenant(ctx: Ctx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      const i = isObj(input) ? input : {};
      const out: FieldError[] = [];
      if (i['code'] !== undefined) out.push(err('/code'));                                   // immutable (AC-E1.2 key)
      if (i['legalName'] !== undefined && !str(i['legalName'], 1, 200)) out.push(err('/legal_name'));
      if (i['displayName'] !== undefined && !str(i['displayName'], 1, 120)) out.push(err('/display_name'));
      if (i['billingLiveOn'] !== undefined && !isoDate(i['billingLiveOn'])) out.push(err('/billing_live_on'));
      const unset = i['unset'];
      const unsetBilling = Array.isArray(unset) && unset.length === 1 && unset[0] === 'billing_live_on';
      if (unset !== undefined && (!unsetBilling || i['billingLiveOn'] !== undefined)) out.push(err('/unset'));
      if (out.length) fail(out);
      const v = expected(i['expectedVersion']);
      const t = await load(s, i['tenantId']);
      if (t.version !== v) throw conflict();
      const p: { legalName?: string; displayName?: string; billingLiveOn?: string | null; actorId: string } = { actorId: s.actorId };
      if (i['legalName'] !== undefined) p.legalName = i['legalName'] as string;
      if (i['displayName'] !== undefined) p.displayName = i['displayName'] as string;
      if (i['billingLiveOn'] !== undefined) p.billingLiveOn = i['billingLiveOn'] as string;
      if (unsetBilling) p.billingLiveOn = null;
      const r = await repo.update(s.tx, t.id, v, p);
      if (!r) throw conflict();
      return { status: 200, body: toTenant(r), version: r.version };
    },

    /** T2: provisioning -> active once an ACCEPTED tenant_admin, an active branch and an active centre exist (AC-E1.3). */
    activateTenant: (ctx: Ctx, input: Record<string, unknown> = {}) => transition(ctx, input, 'active', () => undefined, async (s, t, v) => {
      if (t.status !== 'provisioning') throw conflict();   // suspended -> active is reactivateTenant (T4)
      const r = await repo.readiness(s.tx, t.id);
      if (r.acceptedAdmins < 1 || r.activeBranches < 1 || r.activeCentres < 1) throw new LimsError('identity.tenant_not_ready');
      return setStatus(s, t, v, 'active');
    }),

    /** T3 (US-E2): every live session revoked in the same tx; the resolver refuses the tenant from the next request on. */
    suspendTenant: (ctx: Ctx, input: Record<string, unknown> = {}) => transition(ctx, input, 'suspended', reasonOk, async (s, t, v, i) => {
      const r = await setStatus(s, t, v, 'suspended', i['reasonText'] as string);
      await signOutTenant(s, t.id, 'tenant_suspended', r.version);
      return r;
    }),

    /** T4. */
    reactivateTenant: (ctx: Ctx, input: Record<string, unknown> = {}) => transition(ctx, input, 'active', () => undefined, async (s, t, v) => {
      if (t.status !== 'suspended') throw conflict();   // provisioning -> active is activateTenant (T2) only
      return setStatus(s, t, v, 'active');
    }),

    /** T5 (08 A8.3 / A9.5, D-T13): offboarded; every non-deactivated membership deactivated BY the platform staff user, reason 'other'. */
    terminateTenant: (ctx: Ctx, input: Record<string, unknown> = {}) => transition(ctx, input, 'offboarded', (i) => {
      if (!(typeof i['confirmCode'] === 'string' && CODE.test(i['confirmCode']))) failAt('/confirm_code');
      reasonOk(i);
    }, async (s, t, v, i) => {
      if (i['confirmCode'] !== t.code) failAt('/confirm_code');
      const r = await setStatus(s, t, v, 'offboarded', i['reasonText'] as string);
      // A9.5: `by` is ctx.actor.id, the claims sub of the staff user - not the actor that withTenantScope runs under.
      await repo.deactivateMemberships(s.tx, t.id, { at: s.now, by: s.actorId, reasonCode: 'other', actorId: s.actorId });
      await signOutTenant(s, t.id, 'deactivate', r.version);
      return r;
    }),

    async getTenantSettingsAsPlatform(ctx: Ctx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, READ);
      const id = isObj(input) ? input['tenantId'] : undefined;
      if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
      const row = await repo.findSettings(s.tx, id);
      if (!row) throw notFound();
      return { status: 200, body: platformDto(row), version: row['version'] };
    },

    async updateTenantSettingsAsPlatform(ctx: Ctx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      const i = isObj(input) ? input : {};
      const v = expected(i['expectedVersion']);   // same order as the tenant path (settings.service): 428, then the patch
      const { set, unset } = checkPlatformPatch(i['patch']);
      const t = await load(s, i['tenantId']);
      const cur = await repo.findSettings(s.tx, t.id);
      if (!cur) throw notFound();
      if (cur['version'] !== v) throw conflict();
      if (t.billing_live_on) {   // AC-C3.3 / P-6: same deferral as the tenant path
        for (const k of DEFERRED) {
          if (!Object.hasOwn(set, k)) continue;
          const next = set[k]; delete set[k];
          if (next === cur[k]) continue;
          set[`pending_${k}`] = next;
          set['pending_effective_fy_bs'] = nextFiscalYear(s.now.toISOString());
        }
      }
      const r = await scoped(ctx, t.id, async () => {
        const o = await repo.updateSettings(s.tx, t.id, v, set, unset, s.actorId);
        if (!o) throw conflict();
        await log(ctx, t.id, { action: 'settings.change', entityType: 'tenant_settings', entityId: t.id, detail: { fields: [...Object.keys(set), ...unset].sort().join(',') } });
        return o;
      });
      return { status: 200, body: platformDto(r), version: r['version'] };
    },

    /** AC-C5.3 / 08 A13 P-1: enabling a requires_founder_approval flag needs approval_ref; disabling never does. */
    async setFeatureFlagAsPlatform(ctx: Ctx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      const i = isObj(input) ? input : {};
      const code = i['flagCode'];
      if (!(typeof code === 'string' && FLAG_CODE.test(code))) return failAt('/flag_code');
      if (typeof i['isEnabled'] !== 'boolean') failAt('/is_enabled');
      const raw = i['approvalRef'];
      const ref = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;   // blank = absent
      if (raw !== undefined && !(typeof raw === 'string' && (ref === undefined || str(ref, 3, 200)))) failAt('/approval_ref');   // DB feature_flags__approval_len__ck
      const t = await load(s, i['tenantId']);
      const enable = i['isEnabled'] as boolean;
      const out = await scoped(ctx, t.id, async () => {
        const f = await repo.findFlag(s.tx, t.id, code);
        if (!f) throw notFound();
        if (enable && f.requires_founder_approval && ref === undefined) failAt('/approval_ref');
        await repo.updateFlag(s.tx, t.id, code, { isEnabled: enable, ...(enable && ref !== undefined ? { approvalRef: ref } : {}), actorId: s.actorId });
        await log(ctx, t.id, { action: 'feature_flag.change', entityType: 'feature_flag', detail: { flag_code: code, is_enabled: enable } });
        return (await repo.findFlag(s.tx, t.id, code))!;
      });
      const body: Record<string, unknown> = {};
      for (const k of ['code', 'description', 'scope', 'settable_by', 'is_enabled', 'blocker_ref', 'approval_ref_present', 'version']) if (out[k] !== undefined && out[k] !== null) body[k] = out[k];
      return { status: 200, body, ...(typeof out['version'] === 'number' ? { version: out['version'] } : {}) };
    },

    async inviteTenantAdmin(ctx: Ctx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      const i = isObj(input) ? input : {};
      const email = normEmail(i['email']);
      if (!okEmail(email)) failAt('/email');
      if (!str(i['displayName'], 1, 120)) failAt('/display_name');
      const t = await load(s, i['tenantId']);
      if (t.status === 'offboarded') throw conflict();   // [CONV] no new admins for a terminated tenant
      const userId = await gotrueUser(s, email);
      const r = await scoped(ctx, t.id, async () => {
        const x = await inviteAdmin(s, t.id, userId, email, i['displayName'] as string);
        await log(ctx, t.id, { action: LIFECYCLE, entityType: 'tenant', entityId: t.id, detail: { admin_invited: true } });
        return x;
      });
      return { status: 201, body: { membership_id: r.membershipId, invitation: { status: 'pending', expires_at: r.expiresAt.toISOString() } } };
    },
  };
}
export type TenantService = ReturnType<typeof createTenantService>;

/** TenantSettingsDto + training_mode (LD-26; column per CR-C2-T16): readable by platform operators. */
function platformDto(r: Record<string, any>) {
  const out = toDto(r);
  if (typeof r['training_mode'] === 'boolean') out['training_mode'] = r['training_mode'];
  return out;
}

/** Platform PATCH: any tenant-editable column + the platform-only ones; training_mode (LD-26), system and unknown columns -> 400. */
function checkPlatformPatch(patch: unknown): { set: Record<string, unknown>; unset: string[] } {
  if (!isObj(patch)) return failAt('');
  const { unset: rawUnset, ...set } = patch;
  const bad: FieldError[] = [];
  for (const k of Object.keys(set)) if (!PLATFORM_EDITABLE.has(k) || set[k] === null) bad.push(err(`/${k}`));   // NULL only via unset[]
  const unset: string[] = [];
  if (rawUnset !== undefined) {
    if (!Array.isArray(rawUnset) || rawUnset.length > 12) bad.push(err('/unset'));
    else rawUnset.forEach((c, n) => {
      if (typeof c !== 'string' || !PLATFORM_UNSETTABLE.has(c) || Object.hasOwn(set, c)) bad.push(err(`/unset/${n}`));
      else if (!unset.includes(c)) unset.push(c);
    });
  }
  if (bad.length) fail(bad);
  for (const [k, v] of Object.entries(set)) {
    if (BOOLS.has(k) && typeof v !== 'boolean') bad.push(err(`/${k}`));
    if (PATTERNS.has(k) && (typeof v !== 'string' || v.length > PATTERN_MAX || !validateNumberingPattern(k.slice(0, -'_pattern'.length) as NumberingKind, v).ok)) bad.push(err(`/${k}`));
    if (k === 'ird_pan' && !(typeof v === 'string' && PAN.test(v))) bad.push(err('/ird_pan'));
    if (k === 'ird_annex_1_record_id' && !(typeof v === 'string' && UUID.test(v))) bad.push(err('/ird_annex_1_record_id'));
  }
  const r = validateSettingsPatch(set);
  const ranges = r.ok ? [] : r.errors;
  bad.push(...ranges.filter((e) => e.code === 'common.field_invalid').map((e) => err(e.pointer)));
  if (bad.length) fail(bad);
  const oor = ranges.filter((e) => e.code === 'identity.setting_out_of_range');
  if (oor.length) throw new LimsError('identity.setting_out_of_range', undefined, oor.map((e) => err(e.pointer, e.code)));
  return { set, unset };
}
