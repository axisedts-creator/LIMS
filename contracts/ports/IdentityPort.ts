// contracts/ports/IdentityPort.ts
import type { RequestContext, Uuidv7, Uuid, Actor, IsoUtc, Code } from './common';
export const IDENTITY_PORT_VERSION = 1 as const;

export type RoleCode = string;          // tenant-configurable; defaults in contracts/permissions.yaml (§11)
export type PermissionCode = string;    // '<module>.<resource>.<action>' — must exist in contracts/permissions.yaml (§11; A6)

export interface ActorProfile {
  readonly actor: Actor; readonly displayName: string;
  readonly roles: readonly RoleCode[]; readonly permissions: readonly PermissionCode[];
  readonly centreScope: { readonly all: boolean; readonly centreIds: readonly Uuidv7[] };
  readonly branchIds: readonly Uuidv7[];
  readonly mfa: { readonly enrolled: boolean; readonly level: 'aal1' | 'aal2' };
  readonly isLocked: boolean;
  readonly signature?: { readonly displayTitle: string; readonly registrationNo?: string; readonly signatureImageRef?: string }; // signatory block (00 §4)
}
export interface TenantSettings {                                // final shape per 08 §4.12 (CR-C2-008 primary; C0-009, C4-009, C5-009, C11-005)
  readonly calendarDisplay: 'AD' | 'BS' | 'AD_BS' | 'BS_AD';    // 04 D12; default AD
  readonly timezone: string;                                     // default 'Asia/Kathmandu'; v1 accepts only 'Asia/Kathmandu' (C2 → identity.setting_out_of_range; 08 A13 P-15, §6)
  readonly idleTimeoutMinutes: number;                           // 15–30 (04 A8)
  readonly absoluteSessionHours: number;                         // ≤12 (04 A8)
  readonly reportLinkTtlDays: number;                            // 30–90 (04 A10)
  readonly releaseRequiresPayment: boolean;                      // hold-till-paid (01 §1.4)
  readonly partialReleaseAllowed: boolean;
  readonly letterheadDefault: 'with' | 'without';
  readonly numbering: {                                          // §9.3
    readonly registrationNoPattern: string; readonly barcodePattern: string; readonly patientCodePattern: string;
    readonly invoiceNoPattern: string; readonly creditNoteNoPattern: string;
    readonly receiptNoPattern: string;                       // default 'RC-{fy}-{seq:6}'            (CR-C2-008)
    readonly barcodePrefix?: string;                         // [A-Z0-9]{0,4}                        (CR-C5-009)
    readonly accessionNoPattern?: string;                    // default '{prefix}{yy}-{seq:4}'       (CR-C11-005)
    readonly accessionPrefixes?: { readonly histology?: string; readonly cytology?: string;
                                   readonly ihc?: string; readonly molecular?: string };   // [A-Z0-9]{0,4}; defaults S/C/I/M
  };
  readonly channels: { readonly whatsappEnabled: boolean; readonly smsEnabled: boolean; readonly emailEnabled: boolean; readonly smsSenderId?: string };
  readonly branding: {                                       // replaces CR-C4-009 'letterhead' and CR-C0-009 'branding' (R21)
    readonly legalName: string; readonly displayName: string;
    readonly addressLines: readonly string[];                // ≤ 4 lines, each ≤ 120
    readonly phones: readonly string[];                      // ≤ 3 display strings, each ≤ 40
    readonly contactEmail?: string; readonly website?: string;
    readonly logoAssetId?: Uuidv7; readonly letterheadHeaderAssetId?: Uuidv7; readonly letterheadFooterAssetId?: Uuidv7;
    readonly receiptFooterNote?: string;                     // ≤ 200
    readonly accentColor?: string;                           // '#RRGGBB'; kit derives accessible variants (C0 04-UI-UX §1.6)
  };
  readonly retentionYears: number;                           // default 5 (04 I8, BLOCKED B15); kept = retention.clinicalYears (back-compat)
  readonly retention: { readonly clinicalYears: number; readonly auditYears: number; readonly rawInstrumentYears: number }; // floors 5/5/1 (04 I8, B15)
  readonly featureFlags: Readonly<Record<string, boolean>>;  // codes from identity.g_feature_flags (+ 'smart_report', CR-C14-005)
  readonly referralIncentiveReportEnabled: boolean;              // 04 L19 / B13 — reporting only, never "commission"
  readonly autoVerificationEnabled: boolean;                     // Phase 2 (04 R2); default false
  readonly westgardMode: 'classic' | 'modern';                   // 04 L23 per-lab flag; default set in C9 PRD
  readonly ird: { readonly pan?: string; readonly cbmsRealtimeRequired: boolean; readonly abbreviatedInvoiceLimitPaisa?: number;
                  readonly annexReadiness: 'complete' | 'incomplete' };   // 04 L6/L9/L26; values BLOCKED B6; annexReadiness tracking-derived, not a legal determination
}
export type TenantSettingKey = keyof TenantSettings;

export interface IdentityPortV1 {
  /** @throws auth.unauthenticated, auth.account_locked */
  getActor(ctx: RequestContext): Promise<ActorProfile>;
  /** Throws unless the actor holds `permission` (and covers `centreId` when given). Privileged permissions re-validate membership
   *  against core.memberships and require aal2 (04 A4; REQ-SEC-067).
   *  @throws auth.forbidden, auth.mfa_required, auth.account_locked, auth.session_expired */
  assertRole(ctx: RequestContext, requirement: { permission: PermissionCode; centreId?: Uuidv7; branchId?: Uuidv7 }): Promise<void>;
  getTenantSettings<K extends TenantSettingKey>(ctx: RequestContext, input?: { keys?: readonly K[] }): Promise<Pick<TenantSettings, K>>;
  // ---- added by 08 (CR-C6-007, C13-003, C16-004)
  /** System actor holding identity.signatory.read only. ≤ 20 ids; unknown/other tenant omitted. */
  getSignatories(ctx: RequestContext, input: { membershipIds: readonly Uuidv7[] }): Promise<readonly Signatory[]>;
  /** Callers: any `user` or `system` actor of the tenant. Returns only branding assets (kinds `logo`, `letterhead_header`, `letterhead_footer`);
   *  signature images are never returned here and stay behind `getSignatories` (system actor holding `identity.signatory.read`). (08 A13 D-26)
   *  Assets referenced by a released report stay readable (never deleted). @throws common.not_found */
  readBrandingAsset(ctx: RequestContext, input: { assetId: Uuidv7 }): Promise<BrandingAssetContent>;
  /** Caller: C13 service with partners.partner.manage (staff) or partners.partner_user.manage (partner admin of the same partner).
   *  @throws identity.user_exists, identity.tenant_suspended */
  provisionPartnerMembership(ctx: RequestContext, input: { email: string; displayName: string; partnerRole: PartnerRole }):
    Promise<{ membershipId: Uuidv7; userId: Uuid; invitationId: Uuidv7; status: 'invited' }>;
  /** Revokes sessions on deactivate/role change. Non-partner membership → common.not_found.
   *  `expectedVersion` (08 A19 D-100): omitted → C2 applies the action to the current row under `SELECT … FOR UPDATE`;
   *  present → `common.version_conflict` on mismatch. C13 controls concurrency on its own `partner_users` row and calls without it.
   *  @throws common.version_conflict, identity.membership_inactive */
  updatePartnerMembership(ctx: RequestContext, input: { membershipId: Uuidv7; action: 'deactivate' | 'reactivate' | 'set_role' | 'resend_invitation';
    partnerRole?: PartnerRole; reasonCode?: Code; expectedVersion?: number }): Promise<{ membershipId: Uuidv7; status: 'invited' | 'active' | 'deactivated'; version: number }>;
  /** Caller: patient pre_auth context only; idempotent per accountId; no phone/e-mail stored in GoTrue; GoTrue never messages these users. */
  provisionPatientMembership(ctx: RequestContext, input: { accountId: Uuidv7 }): Promise<{ membershipId: Uuidv7; userId: Uuid }>;
  /** Same caller restriction; membership must be actor_type 'patient' and active. Returns the opaque session token (08 R10). */
  openPatientSession(ctx: RequestContext, input: { membershipId: Uuidv7; appInstanceId: Uuidv7; appPlatform: 'android' | 'ios' }):
    Promise<{ sessionToken: string; accessToken: string; accessExpiresAt: IsoUtc; sessionExpiresAt: IsoUtc }>;
  /** Caller: the patient whose claims membership_id = membershipId, or the engagement system actor. */
  revokePatientSessions(ctx: RequestContext, input: { membershipId: Uuidv7; reason: Code; deactivateMembership: boolean }): Promise<{ revokedSessions: number }>;
  // ---- added by 08 Addendum A4.2 (CR-C6-018, additive)
  /** Caller: system actors only (reporting worker). `eligible` = membership status = 'active', actor_type = 'user', not locked
   *  (locked_at IS NULL — 08 A3.4), holds `requiredPermission`. `email` = core.users.email_normalized (08 A3.4). */
  getStaffNotificationContact(ctx: RequestContext, input: { membershipId: Uuidv7; requiredPermission: PermissionCode }): Promise<{ membershipId: Uuidv7; email: string | null; eligible: boolean }>;
  // ---- added by 08 Addendum A21.2 (CR-C6-020, additive). C6 render worker uses it; C2 implements.
  /** Caller: system actor holding `identity.signatory.read` only. Signature image of the membership's signatory record.
   *  @throws common.not_found */
  readSignatureImage(ctx: RequestContext, input: { membershipId: Uuidv7 }): Promise<SignatureImageContent>;   // return type per 08 A26.1
}
export type IdentityPort = IdentityPortV1;

// ---- added by 08
export interface Signatory { readonly membershipId: Uuidv7; readonly displayName: string; readonly displayTitle?: string; readonly registrationNo?: string;
  readonly signatureAssetId?: Uuidv7; readonly signatureSha256?: string; readonly isActive: boolean }      // inactive still returned
export interface BrandingAssetContent { readonly assetId: Uuidv7; readonly kind: 'logo' | 'letterhead_header' | 'letterhead_footer';
  readonly mimeType: 'image/png' | 'image/jpeg'; readonly sha256: string; readonly base64: string }        // ≤ 2 MB
export interface SignatureImageContent { readonly membershipId: Uuidv7; readonly contentBase64: string;      // 08 A26.1 (readSignatureImage; not BrandingAssetContent)
  readonly mimeType: 'image/png' | 'image/jpeg'; readonly sha256: string }
export type PartnerRole = 'partner_admin' | 'partner_member';
// Migration system actor (CR-C18-007): DEFER (B4).
