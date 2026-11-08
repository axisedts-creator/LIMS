// CoreAdminRepo — dumb SQL behind IdentityPort.impl (02-TRD §7). Every method runs in ctx.tx (the only db handle) and binds
// tenant_id = ctx.tenantId explicitly (REQ-SEC-024) on top of FORCE RLS. No memo/cache here: the port owns memo + settings cache.
// Columns: 05-SCHEMA / db/migrations 0400 (core.users, core.memberships, membership_*), 0500 (roles), 0700 (branches), 1300 (identity.*).
import type { TenantSettings } from '../../../../../../contracts/ports/IdentityPort.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import type { StorageAdapter } from '../../../core/storage/index.js';

type Q = { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };
export interface RepoCtx { readonly tenantId: string; readonly actor: { readonly type: string; readonly id: string }; readonly tx: unknown }
export type PartnerRoleCode = 'partner_admin' | 'partner_member';
export type ScanState = 'pending' | 'clean' | 'quarantined';

export interface MembershipRecord {
  membershipId: string; userId: string; tenantId: string; actorId: string; actorType: 'user' | 'partner' | 'patient';
  status: 'invited' | 'active' | 'deactivated'; lockedAt: string | null; displayName: string; email: string | null;
  roleCodes: string[]; permissions: string[]; allCentres: boolean; centreIds: string[]; branchIds: string[]; mfaEnrolled: boolean;
  signature?: { displayTitle: string; registrationNo?: string; imageRef?: string }; partnerRole?: PartnerRoleCode; version: number;
}
export interface SupportSessionRecord { active: boolean; scope: 'read_only' | 'admin'; staffDisplayName: string }
export interface SignatoryRecord {
  membershipId: string; displayName: string; displayTitle: string; registrationNo?: string;
  signatureAssetId?: string; signatureSha256?: string; status: string;
}
export interface AssetRecord { id: string; tenantId: string; kind: string; mimeType: string; sha256: string; base64: string; scanState: ScanState }
export interface SigImageRecord { tenantId: string; membershipId: string; mimeType: string; sha256: string; base64: string; scanState: ScanState }

export interface CoreAdminRepo {
  /** Verified request claims (GUC request.jwt.claims, set by core from the claims resolver). */
  claims(ctx: RepoCtx): Promise<Record<string, unknown>>;
  membership(ctx: RepoCtx, i: { membershipId: string }): Promise<MembershipRecord | undefined>;
  /** Same as membership() after SELECT … FOR UPDATE on the row (08 A19 D-100). */
  lockMembership(ctx: RepoCtx, i: { membershipId: string }): Promise<MembershipRecord | undefined>;
  supportSession(ctx: RepoCtx, i: { supportSessionId: string }): Promise<SupportSessionRecord | undefined>;
  tenantStatus(ctx: RepoCtx): Promise<string>;
  tenantSettings(ctx: RepoCtx): Promise<TenantSettings | undefined>;
  signatories(ctx: RepoCtx, i: { membershipIds: readonly string[] }): Promise<SignatoryRecord[]>;
  /** Any kind (incl. 'signature'); the port filters (D-26). Bytes only for clean branding kinds. */
  brandingAsset(ctx: RepoCtx, i: { assetId: string }): Promise<AssetRecord | undefined>;
  signatureImage(ctx: RepoCtx, i: { membershipId: string }): Promise<SigImageRecord | undefined>;
  emailExists(ctx: RepoCtx, i: { email: string }): Promise<boolean>;
  createPartnerMembership(ctx: RepoCtx, i: { email: string; displayName: string; partnerRole: PartnerRoleCode }): Promise<{ membershipId: string; userId: string; invitationId: string }>;
  applyPartnerAction(ctx: RepoCtx, i: { membershipId: string; action: string; partnerRole?: PartnerRoleCode; reasonCode?: string }): Promise<{ status: 'invited' | 'active' | 'deactivated'; version: number }>;
  revokeSessions(ctx: RepoCtx, i: { membershipId: string; reason: string }): Promise<number>;
}

const BRANDING_KINDS = ['logo', 'letterhead_header', 'letterhead_footer'];

// ---- SQL (parameters only; never concatenated values)
const CLAIMS_SQL = `SELECT app.current_claims() AS c`;

const MEMBERSHIP_SQL = `
SELECT m.id, m.user_id, m.tenant_id, m.actor_type, m.status, m.locked_at, m.all_centres, m.version, m.partner_role,
       m.signatory_display_title, m.signatory_registration_no, m.signature_image_ref,
       u.display_name, u.email_normalized,
       coalesce((SELECT array_agg(DISTINCT r.role_code) FROM core.membership_roles mr
                 JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.is_active
                 WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id), '{}') AS role_codes,
       coalesce((SELECT array_agg(DISTINCT rp.permission_code) FROM core.membership_roles mr
                 JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.is_active
                 JOIN core.role_permissions rp ON rp.tenant_id = r.tenant_id AND rp.role_id = r.id
                 WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id), '{}') AS permissions,
       coalesce((SELECT array_agg(mc.centre_id) FROM core.membership_centres mc
                 WHERE mc.tenant_id = m.tenant_id AND mc.membership_id = m.id), '{}') AS centre_ids,
       coalesce((SELECT array_agg(mb.branch_id) FROM core.membership_branches mb
                 WHERE mb.tenant_id = m.tenant_id AND mb.membership_id = m.id), '{}') AS branch_ids,
       EXISTS (SELECT 1 FROM identity.mfa_factors f
               WHERE f.tenant_id = m.tenant_id AND f.user_id = m.user_id AND f.status = 'verified') AS mfa_enrolled
FROM core.memberships m
JOIN core.users u ON u.tenant_id = m.tenant_id AND u.id = m.user_id
WHERE m.tenant_id = $1 AND m.id = $2`;

const LOCK_SQL = `SELECT id FROM core.memberships WHERE tenant_id = $1 AND id = $2 FOR UPDATE`;

const SUPPORT_SQL = `
SELECT s.scope, (s.status = 'active' AND s.expires_at > now()) AS active, coalesce(ps.display_name, '') AS display_name
FROM identity.support_sessions s LEFT JOIN identity.platform_staff ps ON ps.id = s.platform_staff_id  -- lims_app has no platform_staff SELECT policy (CR T5)
WHERE s.tenant_id = $1 AND s.id = $2`;

const TENANT_STATUS_SQL = `SELECT status FROM core.tenants WHERE id = $1`;

const SETTINGS_SQL = `
SELECT ts.*,
       coalesce((SELECT jsonb_object_agg(g.code, coalesce(f.is_enabled, g.default_enabled))
                 FROM identity.g_feature_flags g
                 LEFT JOIN identity.feature_flags f ON f.tenant_id = $1 AND f.flag_code = g.code
                 WHERE g.is_active), '{}'::jsonb) AS feature_flags,
       ((SELECT count(DISTINCT a.annex_code) FROM identity.ird_annex_records a
         WHERE a.tenant_id = $1 AND a.is_active AND a.status = 'completed' AND a.annex_code IN ('annex_2','annex_3','annex_7')) = 3
        AND EXISTS (SELECT 1 FROM identity.ird_annex_records p
                    WHERE p.tenant_id IS NULL AND p.annex_code = 'annex_1' AND p.id = ts.ird_annex_1_record_id AND p.status = 'completed')) AS annex_complete
FROM identity.tenant_settings ts
WHERE ts.tenant_id = $1`;

const SIGNATORIES_SQL = `
SELECT m.id, m.status, m.signatory_display_title, m.signatory_registration_no, u.display_name,
       sa.id AS asset_id, encode(sa.sha256, 'hex') AS sha256
FROM core.memberships m
JOIN core.users u ON u.tenant_id = m.tenant_id AND u.id = m.user_id
LEFT JOIN LATERAL (SELECT b.id, b.sha256 FROM identity.branding_assets b
                   WHERE b.tenant_id = m.tenant_id AND b.membership_id = m.id AND b.kind = 'signature' AND b.is_active
                   ORDER BY b.created_at DESC LIMIT 1) sa ON true
WHERE m.tenant_id = $1 AND m.id = ANY($2::uuid[]) AND m.signatory_display_title IS NOT NULL`;

const ASSET_SQL = `
SELECT id, tenant_id, kind, bucket, object_path, content_type, encode(sha256, 'hex') AS sha256, scan_state
FROM identity.branding_assets WHERE tenant_id = $1 AND id = $2 AND is_active`;

const SIG_IMAGE_SQL = `
SELECT tenant_id, membership_id, bucket, object_path, content_type, encode(sha256, 'hex') AS sha256, scan_state
FROM identity.branding_assets
WHERE tenant_id = $1 AND membership_id = $2 AND kind = 'signature' AND is_active
ORDER BY created_at DESC LIMIT 1`;

const EMAIL_EXISTS_SQL = `
SELECT EXISTS (SELECT 1 FROM core.users u JOIN core.memberships m ON m.tenant_id = u.tenant_id AND m.user_id = u.id
               WHERE u.tenant_id = $1 AND u.email_normalized = $2 AND m.status IN ('invited','active')) AS e`;

const INSERT_USER_SQL = `
INSERT INTO core.users (tenant_id, id, display_name, email_normalized, created_by, updated_by)
VALUES ($1, $2, $3, $4, $5, $5)`;
const INSERT_MEMBERSHIP_SQL = `
INSERT INTO core.memberships (tenant_id, id, user_id, actor_type, all_centres, status, invited_at, partner_role, created_by, updated_by)
VALUES ($1, $2, $3, 'partner', false, 'invited', now(), $4, $5, $5)`;
// expires_at = now()+72 h (03-APP-FLOW invitation row: `pending`, expires_at = now()+72 h)
const INSERT_INVITATION_SQL = `
INSERT INTO identity.invitations (tenant_id, id, user_id, membership_id, email, status, expires_at, invited_by, created_by, updated_by)
VALUES ($1, $2, $3, $4, $5, 'pending', now() + interval '72 hours', $6, $6, $6)`;

const DEACTIVATE_SQL = `
UPDATE core.memberships SET status = 'deactivated', deactivated_at = now(), deactivated_by = $3,
       deactivation_reason_code = $4, version = version + 1, updated_at = now(), updated_by = $3
WHERE tenant_id = $1 AND id = $2 RETURNING status, version`;
const REACTIVATE_SQL = `
UPDATE core.memberships SET status = 'active', deactivated_at = NULL, deactivated_by = NULL, deactivation_reason_code = NULL,
       version = version + 1, updated_at = now(), updated_by = $3
WHERE tenant_id = $1 AND id = $2 RETURNING status, version`;
const SET_ROLE_SQL = `
UPDATE core.memberships SET partner_role = $4, version = version + 1, updated_at = now(), updated_by = $3
WHERE tenant_id = $1 AND id = $2 RETURNING status, version`;
const RESEND_SQL = `
WITH inv AS (
  INSERT INTO identity.invitations (tenant_id, id, user_id, membership_id, email, status, attempt_no, expires_at, invited_by, created_by, updated_by)
  SELECT m.tenant_id, $4, m.user_id, m.id, u.email_normalized, 'pending',
         coalesce((SELECT max(i.attempt_no) FROM identity.invitations i WHERE i.tenant_id = m.tenant_id AND i.membership_id = m.id), 0) + 1,
         now() + interval '72 hours', $3, $3, $3
  FROM core.memberships m JOIN core.users u ON u.tenant_id = m.tenant_id AND u.id = m.user_id
  WHERE m.tenant_id = $1 AND m.id = $2
  RETURNING 1)
UPDATE core.memberships SET version = version + 1, updated_at = now(), updated_by = $3
WHERE tenant_id = $1 AND id = $2 RETURNING status, version`;

const REVOKE_SQL = `
UPDATE identity.sessions SET state = 'revoked', revoked_at = now(), revoke_reason = $3
WHERE tenant_id = $1 AND membership_id = $2 AND state NOT IN ('revoked','expired')`;

// ---- mapping helpers
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String)
  : typeof v === 'string' && v.startsWith('{') ? v.slice(1, -1).split(',').filter(Boolean) : []);
const opt = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

function mapMembership(r: any): MembershipRecord {
  return {
    membershipId: r.id, userId: r.user_id, tenantId: r.tenant_id, actorId: r.user_id, actorType: r.actor_type, status: r.status,
    lockedAt: iso(r.locked_at), displayName: r.display_name, email: r.email_normalized ?? null,
    roleCodes: arr(r.role_codes), permissions: arr(r.permissions), allCentres: r.all_centres === true,
    centreIds: arr(r.centre_ids), branchIds: arr(r.branch_ids), mfaEnrolled: r.mfa_enrolled === true, version: Number(r.version),
    ...(r.signatory_display_title != null ? { signature: { displayTitle: r.signatory_display_title,
      ...(r.signatory_registration_no != null ? { registrationNo: r.signatory_registration_no } : {}),
      ...(r.signature_image_ref != null ? { imageRef: r.signature_image_ref } : {}) } } : {}),
    ...(r.partner_role != null ? { partnerRole: r.partner_role } : {}),
  };
}

function mapSettings(r: any): TenantSettings {
  const flags: Record<string, boolean> = { ...(r.feature_flags ?? {}) };
  const s = {
    calendarDisplay: r.calendar_display, timezone: r.timezone, idleTimeoutMinutes: r.idle_timeout_minutes,
    absoluteSessionHours: r.absolute_session_hours, reportLinkTtlDays: r.report_link_ttl_days,
    releaseRequiresPayment: r.release_requires_payment, partialReleaseAllowed: r.partial_release_allowed, letterheadDefault: r.letterhead_default,
    numbering: {
      registrationNoPattern: r.registration_no_pattern, barcodePattern: r.barcode_pattern, patientCodePattern: r.patient_code_pattern,
      invoiceNoPattern: r.invoice_no_pattern, creditNoteNoPattern: r.credit_note_no_pattern, receiptNoPattern: r.receipt_no_pattern,
      barcodePrefix: opt(r.barcode_prefix), accessionNoPattern: r.accession_no_pattern,
      accessionPrefixes: { histology: r.accession_prefix_histology, cytology: r.accession_prefix_cytology, ihc: r.accession_prefix_ihc, molecular: r.accession_prefix_molecular },
    },
    channels: { whatsappEnabled: r.whatsapp_enabled, smsEnabled: r.sms_enabled, emailEnabled: r.email_enabled, smsSenderId: opt(r.sms_sender_id) },
    branding: {
      legalName: r.legal_name_snapshot, displayName: r.display_name, addressLines: arr(r.address_lines), phones: arr(r.phones),
      contactEmail: opt(r.contact_email), website: opt(r.website), logoAssetId: opt(r.logo_asset_id),
      letterheadHeaderAssetId: opt(r.letterhead_header_asset_id), letterheadFooterAssetId: opt(r.letterhead_footer_asset_id),
      receiptFooterNote: opt(r.receipt_footer_note), accentColor: opt(r.accent_color),
    },
    retentionYears: r.retention_clinical_years,
    retention: { clinicalYears: r.retention_clinical_years, auditYears: r.retention_audit_years, rawInstrumentYears: r.retention_raw_instrument_years },
    featureFlags: flags,
    referralIncentiveReportEnabled: flags['referral_incentive_report'] === true,   // 05-SCHEMA §4.6
    autoVerificationEnabled: r.auto_verification_enabled, westgardMode: r.westgard_mode,
    ird: { pan: opt(r.ird_pan), cbmsRealtimeRequired: r.cbms_realtime_required,
      abbreviatedInvoiceLimitPaisa: r.abbreviated_invoice_limit_paisa == null ? undefined : Number(r.abbreviated_invoice_limit_paisa),
      annexReadiness: r.annex_complete === true ? 'complete' : 'incomplete' },
  };
  return JSON.parse(JSON.stringify(s));   // drops undefined optionals
}

export interface CoreAdminRepoDeps {
  /** Object storage for asset bytes (bucket identity-assets). Absent → asset byte reads fail closed (common.internal). */
  readonly storage?: Pick<StorageAdapter, 'read'>;
}

export function createCoreAdminRepo(deps: CoreAdminRepoDeps = {}): CoreAdminRepo {
  const tx = (ctx: RepoCtx): Q => {
    const t = ctx?.tx as Q | undefined;
    if (!ctx?.tenantId || typeof t?.query !== 'function') throw new LimsError('common.internal');
    return t;
  };
  const bytes = async (bucket: string, path: string): Promise<string> => {
    if (!deps.storage) throw new LimsError('common.internal');
    return Buffer.from(await deps.storage.read(bucket as any, path)).toString('base64');
  };
  const membership = async (ctx: RepoCtx, membershipId: string) => {
    const { rows } = await tx(ctx).query(MEMBERSHIP_SQL, [ctx.tenantId, membershipId]);
    return rows[0] ? mapMembership(rows[0]) : undefined;
  };

  return {
    async claims(ctx) {
      const { rows } = await tx(ctx).query(CLAIMS_SQL);
      const c = rows[0]?.c;
      return c && typeof c === 'object' ? c : {};
    },
    membership: (ctx, i) => membership(ctx, i.membershipId),
    async lockMembership(ctx, i) {
      const { rows } = await tx(ctx).query(LOCK_SQL, [ctx.tenantId, i.membershipId]);
      return rows[0] ? membership(ctx, i.membershipId) : undefined;
    },
    async supportSession(ctx, i) {
      const { rows } = await tx(ctx).query(SUPPORT_SQL, [ctx.tenantId, i.supportSessionId]);
      const r = rows[0];
      return r ? { active: r.active === true, scope: r.scope, staffDisplayName: r.display_name } : undefined;
    },
    async tenantStatus(ctx) {
      const { rows } = await tx(ctx).query(TENANT_STATUS_SQL, [ctx.tenantId]);
      return rows[0]?.status ?? 'unknown';
    },
    async tenantSettings(ctx) {
      const { rows } = await tx(ctx).query(SETTINGS_SQL, [ctx.tenantId]);
      return rows[0] ? mapSettings(rows[0]) : undefined;
    },
    async signatories(ctx, i) {
      const { rows } = await tx(ctx).query(SIGNATORIES_SQL, [ctx.tenantId, [...i.membershipIds]]);
      return rows.map((r) => ({
        membershipId: r.id, displayName: r.display_name, displayTitle: r.signatory_display_title, status: r.status,
        ...(r.signatory_registration_no != null ? { registrationNo: r.signatory_registration_no } : {}),
        ...(r.asset_id != null ? { signatureAssetId: r.asset_id, signatureSha256: r.sha256 } : {}),
      }));
    },
    async brandingAsset(ctx, i) {
      const { rows } = await tx(ctx).query(ASSET_SQL, [ctx.tenantId, i.assetId]);
      const r = rows[0];
      if (!r) return undefined;
      // never fetch bytes of a signature or a non-clean object (D-26, P-19)
      const readable = r.scan_state === 'clean' && BRANDING_KINDS.includes(r.kind);
      return { id: r.id, tenantId: r.tenant_id, kind: r.kind, mimeType: r.content_type, sha256: r.sha256, scanState: r.scan_state,
        base64: readable ? await bytes(r.bucket, r.object_path) : '' };
    },
    async signatureImage(ctx, i) {
      const { rows } = await tx(ctx).query(SIG_IMAGE_SQL, [ctx.tenantId, i.membershipId]);
      const r = rows[0];
      if (!r) return undefined;
      return { tenantId: r.tenant_id, membershipId: r.membership_id, mimeType: r.content_type, sha256: r.sha256, scanState: r.scan_state,
        base64: r.scan_state === 'clean' ? await bytes(r.bucket, r.object_path) : '' };
    },
    async emailExists(ctx, i) {
      const { rows } = await tx(ctx).query(EMAIL_EXISTS_SQL, [ctx.tenantId, i.email]);
      return rows[0]?.e === true;
    },
    async createPartnerMembership(ctx, i) {
      const q = tx(ctx);
      const userId = uuidv7(), membershipId = uuidv7(), invitationId = uuidv7();
      await q.query(INSERT_USER_SQL, [ctx.tenantId, userId, i.displayName, i.email, ctx.actor.id]);
      await q.query(INSERT_MEMBERSHIP_SQL, [ctx.tenantId, membershipId, userId, i.partnerRole, ctx.actor.id]);
      await q.query(INSERT_INVITATION_SQL, [ctx.tenantId, invitationId, userId, membershipId, i.email, ctx.actor.id]);
      return { membershipId, userId, invitationId };
    },
    async applyPartnerAction(ctx, i) {
      const q = tx(ctx);
      const base = [ctx.tenantId, i.membershipId, ctx.actor.id];
      const { rows } = i.action === 'deactivate' ? await q.query(DEACTIVATE_SQL, [...base, i.reasonCode ?? 'other'])
        : i.action === 'reactivate' ? await q.query(REACTIVATE_SQL, base)
          : i.action === 'set_role' ? await q.query(SET_ROLE_SQL, [...base, i.partnerRole])
            : i.action === 'resend_invitation' ? await q.query(RESEND_SQL, [...base, uuidv7()])
              : { rows: [] };
      if (!rows[0]) throw new LimsError('common.not_found');
      return { status: rows[0].status, version: Number(rows[0].version) };
    },
    async revokeSessions(ctx, i) {
      const r: any = await tx(ctx).query(REVOKE_SQL, [ctx.tenantId, i.membershipId, i.reason]);
      return Number(r.rowCount ?? r.rows?.length ?? 0);
    },
  };
}
