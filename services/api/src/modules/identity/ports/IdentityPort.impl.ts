// IdentityPort implementation (02-TRD §7; 03-IC §4.6; 08 A4.2, A19 D-100/D-119, A21.2, A22.2, A26.1, A28.3; CR-C2-013).
// Per-request memo (keyed by ctx.tx + requestId + tenant + actor), per-process settings cache (TTL 30 s), privileged re-validation
// without memo. All reads go through CoreAdminRepo in ctx.tx; nothing here touches the db directly.
import { idMetrics } from '../metrics.js';
import type {
  ActorProfile, IdentityPort, PartnerRole, Signatory, TenantSettings,
} from '../../../../../../contracts/ports/IdentityPort.js';
import { FIXED_ACTOR_PERMISSIONS, PERMISSION_CODES, PRIVILEGED } from '../../../../../../contracts/ports/generated/permissions.js';
import { createHash, randomBytes } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
import type { CoreAdminRepo, MembershipRecord } from '../repository/core-admin.repo.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as core/errors.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

/** T31 kind patient row (05-SCHEMA s4.1, LD-81): no GoTrue session / refresh / access-token columns (NULL by CHECK). */
export interface NewPatientSession {
  id: string; membershipId: string; userId: string; kind: 'patient'; tokenSha256: Buffer; state: 'active'; aal: 'aal1';
  appInstanceId: string; appPlatform: 'android' | 'ios'; idleTimeoutMinutes: number; idleExpiresAt: Date; absoluteExpiresAt: Date; expiresAt: Date; actorId: string;
}
/** T31 patient-context writes (08 A28.2: the repo runs them in the identity-system-actor write scope). Optional until the real repo
 *  lands them (.orchestra/cr/T31.md); absent -> the port fails closed with common.internal. */
export interface PatientWrites {
  createPatientMembership?(ctx: any, i: { accountId: string }): Promise<{ membershipId: string; userId: string }>;
  insertPatientSession?(ctx: any, s: NewPatientSession): Promise<void>;
  deactivatePatientMembership?(ctx: any, i: { membershipId: string }): Promise<void>;
}

export type AuthzOutcome = 'allow' | 'forbidden' | 'mfa_required' | 'locked' | 'support_required';
export interface IdentityPortDeps {
  readonly repo: CoreAdminRepo & PatientWrites;
  /** Worker-manifest permissions of a system actor id (CR-C2-013 = ctx.core.systemActorPermissions). Unknown id → []. */
  readonly systemActorPermissions: (actorId: string) => readonly string[];
  readonly nowMs?: () => number;
  readonly settingsTtlMs?: number;
  /** lims_identity_authz_decisions_total{outcome} — no ids. */
  readonly metrics?: { authzDecision(outcome: AuthzOutcome, privileged: boolean): void };
  /** T31: opaque patient session token (default 32 random bytes base64url = 43 chars), session row id */
  readonly newToken?: () => string;
  readonly newId?: () => string;
  /** LD-81: EdDSA signer of the patient access JWT; claims exactly sub / session_id / aal / iat / exp */
  readonly mintPatientAccessToken?: (c: { sub: string; sessionId: string; aal: string; issuedAt: Date; expiresAt: Date }) => string;
}
export type IdentityPortImpl = IdentityPort & { invalidateTenantSettings(tenantId: string): void };

const KNOWN = new Set<string>(PERMISSION_CODES);
const isPrivileged = (p: string) => (PRIVILEGED as ReadonlySet<string>).has(p);
const PARTNER_ROLES: readonly string[] = ['partner_admin', 'partner_member'];
// verbatim from sessions__revoke_reason__ck / memberships__deactivation_reason__ck (DB CHECKs; avoid raw 23514)
const REVOKE_REASONS: readonly string[] = ['logout', 'admin_revoke', 'self_revoke', 'password_change', 'role_change', 'lock', 'deactivate',
  'tenant_suspended', 'mfa_failed', 'mfa_reset', 'refresh_failed', 'superseded', 'token_reuse'];
const DEACTIVATION_REASONS: readonly string[] = ['left_organisation', 'security_concern', 'policy_violation', 'other'];
const BRANDING_KINDS: readonly string[] = ['logo', 'letterhead_header', 'letterhead_footer'];
const MIME: readonly string[] = ['image/png', 'image/jpeg'];
const RESTRICTED_SETTING_KEYS: readonly string[] = ['timezone', 'calendarDisplay'];             // 08 A19 D-119
const SUPPORT_RO = ['identity.user.read', 'identity.centre.read', 'audit.log.read'];          // §7.4 [DECISION]
const SUPPORT_ADMIN = [...SUPPORT_RO, 'identity.user.manage', 'identity.role.manage', 'identity.centre.manage', 'identity.settings.manage', 'identity.session.revoke'];
const SUPPORT_SUFFIX = ' (the LIMS provider support)';
// patient kind lifetimes (05-SCHEMA s4.1 sessions__idle__ck default 14 d; 02-TRD s11 absolute 30 d), LD-81 access JWT <= 1 h
const PATIENT_IDLE_MIN = 14 * 24 * 60, PATIENT_ABSOLUTE_MS = 30 * 86_400_000, PATIENT_JWT_MS = 3_600_000;
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Missing settings row (§7.3 defaults; other values = identity.tenant_settings column defaults, 05-SCHEMA §4.6). */
const DEFAULT_SETTINGS: TenantSettings = {
  calendarDisplay: 'AD', timezone: 'Asia/Kathmandu', idleTimeoutMinutes: 15, absoluteSessionHours: 12, reportLinkTtlDays: 30,
  releaseRequiresPayment: true, partialReleaseAllowed: false, letterheadDefault: 'with',
  numbering: {
    registrationNoPattern: '{branch}{prefix}{seq:6}', barcodePattern: '{prefix}{yy}{seq:8}', patientCodePattern: '{prefix}{seq:8}',
    invoiceNoPattern: '{fy}-{seq:6}', creditNoteNoPattern: 'CN-{fy}-{seq:6}', receiptNoPattern: 'RC-{fy}-{seq:6}',
    accessionNoPattern: '{prefix}{yy}-{seq:4}', accessionPrefixes: { histology: 'S', cytology: 'C', ihc: 'I', molecular: 'M' },
  },
  channels: { whatsappEnabled: false, smsEnabled: false, emailEnabled: false },
  branding: { legalName: '', displayName: '', addressLines: [], phones: [] },                  // [CONV] NOT NULL without default
  retentionYears: 5, retention: { clinicalYears: 5, auditYears: 5, rawInstrumentYears: 1 },
  featureFlags: {}, referralIncentiveReportEnabled: false, autoVerificationEnabled: false, westgardMode: 'classic',
  ird: { cbmsRealtimeRequired: false, annexReadiness: 'incomplete' },
};
const SETTING_KEYS = new Set<string>(Object.keys(DEFAULT_SETTINGS));

const err = (code: string, detail?: string) => new LimsError(code, detail);
const forbidden = () => err('auth.forbidden');
const invalid = (detail: string) => err('common.validation_failed', detail);
const copy = <T>(v: T): T => structuredClone(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);   // ids reach ::uuid casts only well-formed
const claim = (c: Record<string, unknown>, k: string): string | undefined => (typeof c[k] === 'string' && c[k] !== '' ? (c[k] as string) : undefined);

interface Resolved {
  profile: ActorProfile;
  claims: Record<string, unknown>;
  membershipId?: string;          // user membership (privileged re-validation)
  supportSessionId?: string;      // support actor (privileged re-validation)
}

function userProfile(ctx: any, m: MembershipRecord, aal: 'aal1' | 'aal2'): ActorProfile {
  return {
    actor: { type: 'user', id: ctx.actor.id, membershipId: m.membershipId } as any,
    displayName: m.displayName, roles: [...m.roleCodes],
    permissions: m.status === 'active' ? [...new Set(m.permissions.filter((p) => !p.startsWith('platform.')))] : [],
    centreScope: { all: m.allCentres, centreIds: m.allCentres ? [] : [...m.centreIds] } as any,
    branchIds: [...m.branchIds] as any,
    mfa: { enrolled: m.mfaEnrolled, level: aal }, isLocked: m.lockedAt !== null,
    ...(m.signature ? { signature: {
      displayTitle: m.signature.displayTitle,
      ...(m.signature.registrationNo !== undefined ? { registrationNo: m.signature.registrationNo } : {}),
      ...(m.signature.imageRef !== undefined ? { signatureImageRef: m.signature.imageRef } : {}),
    } } : {}),
  };
}

export function createIdentityPort(deps: IdentityPortDeps): IdentityPortImpl {
  const { repo } = deps;
  const nowMs = deps.nowMs ?? Date.now;
  const newToken = deps.newToken ?? (() => randomBytes(32).toString('base64url'));
  const newId = deps.newId ?? uuidv7;
  const unwired = () => err('common.internal', 'identity: patient writer not wired');
  const ttl = deps.settingsTtlMs ?? 30_000;                                                  // 02-TRD §7.3 [CONV]
  const memo = new WeakMap<object, Map<string, Promise<Resolved>>>();
  // T28: default sink = the identity process sink (metrics.ts); a test may inject its own.
  const authzMetric = (o: AuthzOutcome, privileged: boolean) => (deps.metrics ? deps.metrics.authzDecision(o, privileged) : idMetrics.authz(undefined, o, privileged));
  const settingsCache = new Map<string, { value: TenantSettings; loadedAt: number }>();

  const tenantOf = (ctx: any): string => {
    if (!str(ctx?.tenantId) || !str(ctx?.actor?.id) || !str(ctx?.actor?.type)) throw err('auth.unauthenticated');
    return ctx.tenantId;
  };
  const sysPerms = (ctx: any): string[] => [...(deps.systemActorPermissions(ctx.actor.id) ?? [])].filter((p) => KNOWN.has(p) && !p.startsWith('platform.'));
  const requireSystemWith = (ctx: any, permission: string) => {
    tenantOf(ctx);
    if (ctx.actor.type !== 'system' || !sysPerms(ctx).includes(permission)) throw forbidden();
  };

  const fixed = (ctx: any, permissions: readonly string[], centreIds: string[] = [], roles: string[] = []): ActorProfile => ({
    actor: { type: ctx.actor.type, id: ctx.actor.id } as any, displayName: ctx.actor.type[0].toUpperCase() + ctx.actor.type.slice(1),
    roles, permissions: [...permissions], centreScope: { all: false, centreIds } as any, branchIds: [],
    mfa: { enrolled: false, level: 'aal1' }, isLocked: false,
  });

  /** Fresh (no memo) user profile from core.memberships; throws on unknown / locked. */
  async function readUser(ctx: any, membershipId: string, claims: Record<string, unknown>): Promise<ActorProfile> {
    const m = await repo.membership(ctx, { membershipId });
    if (!m || m.actorType !== 'user' || m.tenantId !== ctx.tenantId || m.actorId !== ctx.actor.id) throw err('auth.unauthenticated');
    if (m.lockedAt !== null) throw err('auth.account_locked');
    return userProfile(ctx, m, claims['aal'] === 'aal2' ? 'aal2' : 'aal1');
  }
  async function readSupport(ctx: any, supportSessionId: string): Promise<ActorProfile> {
    const s = await repo.supportSession(ctx, { supportSessionId });
    if (!s || !s.active) throw err('identity.support_session_required');
    return {
      actor: { type: 'user', id: ctx.actor.id, supportSessionId } as any,
      displayName: `${s.staffDisplayName}${SUPPORT_SUFFIX}`, roles: [],
      permissions: [...(s.scope === 'admin' ? SUPPORT_ADMIN : SUPPORT_RO)],
      centreScope: { all: false, centreIds: [] }, branchIds: [], mfa: { enrolled: true, level: 'aal2' }, isLocked: false,
    };
  }

  async function resolve(ctx: any): Promise<Resolved> {
    const type: string = ctx.actor.type;
    const claims = (await repo.claims(ctx)) ?? {};
    switch (type) {
      case 'system':
        return { claims, profile: { ...fixed(ctx, sysPerms(ctx)), displayName: 'System', centreScope: { all: true, centreIds: [] } } };
      case 'device': {
        const kind = claim(claims, 'device_kind') ?? 'bridge_agent';
        if (kind === 'queue_display') {
          const c = claim(claims, 'centre_id');
          return { claims, profile: fixed(ctx, FIXED_ACTOR_PERMISSIONS.device.queue_display, c ? [c] : []) };
        }
        if (kind !== 'bridge_agent') throw err('auth.unauthenticated');
        return { claims, profile: fixed(ctx, FIXED_ACTOR_PERMISSIONS.device.bridge_agent) };
      }
      case 'portal':
        return { claims, profile: fixed(ctx, FIXED_ACTOR_PERMISSIONS.portal) };
      case 'patient': {
        if (claim(claims, 'patient_stage') === 'pre_auth') return { claims, profile: fixed(ctx, FIXED_ACTOR_PERMISSIONS.patient_pre_auth) };
        const p = fixed(ctx, FIXED_ACTOR_PERMISSIONS.patient);
        const mid = claim(claims, 'membership_id');
        return { claims, profile: mid ? { ...p, actor: { ...p.actor, membershipId: mid } as any } : p };
      }
      case 'partner': {
        const role = claim(claims, 'partner_role');                                           // 08 A28.3: from claims, no core read
        if (!role || !PARTNER_ROLES.includes(role)) throw err('auth.unauthenticated');
        const p = fixed(ctx, FIXED_ACTOR_PERMISSIONS.partner[role as PartnerRole], [], [role]);
        const mid = claim(claims, 'membership_id');
        return { claims, profile: { ...p, mfa: { enrolled: false, level: claims['aal'] === 'aal2' ? 'aal2' : 'aal1' },
          ...(mid ? { actor: { ...p.actor, membershipId: mid } as any } : {}) } };
      }
      case 'user': {
        const scope = claim(claims, 'scope');
        if (scope === 'support') {
          const sid = claim(claims, 'support_session_id');
          if (!uuid(sid)) throw err('identity.support_session_required');
          return { claims, supportSessionId: sid, profile: await readSupport(ctx, sid) };
        }
        if (scope === 'platform') throw err('identity.support_session_required');          // §7.2 step 4
        const mid = claim(claims, 'membership_id');
        if (!uuid(mid)) throw err('auth.unauthenticated');
        return { claims, membershipId: mid, profile: await readUser(ctx, mid, claims) };
      }
      default:
        throw err('auth.unauthenticated');
    }
  }

  /** Memoised per request (02-TRD §7.1 step 1). Key includes tenant + actor: requestId alone is not trusted to be unique. */
  function load(ctx: any): Promise<Resolved> {
    tenantOf(ctx);
    const holder = ctx.tx && typeof ctx.tx === 'object' ? ctx.tx : undefined;
    if (!holder) return resolve(ctx);
    let m = memo.get(holder);
    if (!m) { m = new Map(); memo.set(holder, m); }
    const key = `${ctx.requestId}|${ctx.tenantId}|${ctx.actor.type}|${ctx.actor.id}|${ctx.actor.supportSessionId ?? ''}`;
    let p = m.get(key);
    if (!p) {
      p = resolve(ctx);
      m.set(key, p);
      p.catch(() => m!.delete(key));                                                        // never memoise a failure
    }
    return p;
  }

  function checkScope(pr: ActorProfile, req: { centreId?: string; branchId?: string }) {
    if (req.centreId !== undefined && !(pr.centreScope.all || pr.centreScope.centreIds.includes(req.centreId as any))) throw forbidden();
    if (req.branchId !== undefined && !(pr.centreScope.all || pr.branchIds.includes(req.branchId as any))) throw forbidden();
  }

  async function authorize(ctx: any, req: any, privileged: boolean): Promise<void> {
    const p: string = req.permission;
    if (p.startsWith('platform.')) throw forbidden();                                         // §7.2 step 3
    const r = await load(ctx);
    const state = claim(r.claims, 'session_state');
    if (state === 'mfa_pending') throw err('auth.mfa_required');
    if (state === 'mfa_enrolment_required') throw err('identity.mfa_enrolment_required');
    if (state === 'password_setup') throw forbidden();
    let pr = r.profile;
    if (privileged) {                                                                       // §7.2 step 7(a)/(c): fresh, no memo
      if (r.membershipId) pr = await readUser(ctx, r.membershipId, r.claims);
      else if (r.supportSessionId) pr = await readSupport(ctx, r.supportSessionId);
    }
    if (!pr.permissions.includes(p)) throw forbidden();
    checkScope(pr, req);
    if (privileged && ctx.actor.type !== 'system' && ctx.actor.type !== 'device' && r.claims['aal'] !== 'aal2') throw err('auth.mfa_required');
  }

  const outcomeOf = (e: unknown): AuthzOutcome | undefined => {
    switch ((e as any)?.code) {
      case 'auth.forbidden': return 'forbidden';
      case 'auth.mfa_required': case 'identity.mfa_enrolment_required': return 'mfa_required';
      case 'auth.account_locked': return 'locked';
      case 'identity.support_session_required': return 'support_required';
      default: return undefined;
    }
  };

  async function settings(ctx: any): Promise<TenantSettings> {
    const t = tenantOf(ctx);
    const hit = settingsCache.get(t);
    if (hit && nowMs() - hit.loadedAt < ttl) { idMetrics.settingsCache(undefined, 'hit'); return hit.value; }
    idMetrics.settingsCache(undefined, 'miss');   // T28 (02-TRD §13)
    const loaded = (await repo.tenantSettings(ctx)) ?? DEFAULT_SETTINGS;
    const value = copy(loaded);
    settingsCache.set(t, { value, loadedAt: nowMs() });
    return value;
  }

  const port: IdentityPortImpl = {
    async getActor(ctx) {
      return copy((await load(ctx)).profile);
    },

    async assertRole(ctx, req) {
      const p = (req as any)?.permission;
      if (typeof p !== 'string' || !KNOWN.has(p)) throw invalid('unknown_permission');       // §7.2 step 1 (contract case 10)
      for (const k of ['centreId', 'branchId'] as const) if (req[k] !== undefined && !str(req[k])) throw invalid(`${k}_invalid`);
      const privileged = isPrivileged(p);
      try {
        await authorize(ctx, req, privileged);
      } catch (e) {
        const o = outcomeOf(e);
        if (o) authzMetric(o, privileged);
        throw e;
      }
      authzMetric('allow', privileged);
    },

    async getTenantSettings(ctx, input) {
      tenantOf(ctx);
      const keys = input?.keys as readonly string[] | undefined;
      if (keys !== undefined && !Array.isArray(keys)) throw invalid('keys_invalid');
      if (['patient', 'portal', 'partner'].includes(ctx.actor.type)) {                         // 08 A19 D-119
        if (!keys || keys.length === 0 || !keys.every((k) => RESTRICTED_SETTING_KEYS.includes(k))) throw forbidden();
      }
      if (keys?.some((k) => typeof k !== 'string' || !SETTING_KEYS.has(k))) throw invalid('unknown_setting_key');
      const all = await settings(ctx);
      if (!keys) return copy(all) as any;
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = copy((all as any)[k]);
      return out as any;
    },

    async getSignatories(ctx, input) {
      requireSystemWith(ctx, 'identity.signatory.read');
      const ids = (input as any)?.membershipIds;
      if (!Array.isArray(ids) || ids.length > 20 || !ids.every(uuid)) throw invalid('membership_ids_invalid');
      if (ids.length === 0) return [];
      const rows = await repo.signatories(ctx, { membershipIds: [...new Set<string>(ids)] });
      const byId = new Map(rows.map((r) => [r.membershipId, r]));
      const out: Signatory[] = [];
      for (const id of new Set<string>(ids)) {
        const r = byId.get(id);
        if (!r) continue;
        out.push({
          membershipId: r.membershipId as any, displayName: r.displayName, isActive: r.status === 'active',
          ...(r.displayTitle !== undefined ? { displayTitle: r.displayTitle } : {}),
          ...(r.registrationNo !== undefined ? { registrationNo: r.registrationNo } : {}),
          ...(r.signatureAssetId !== undefined ? { signatureAssetId: r.signatureAssetId as any } : {}),
          ...(r.signatureSha256 !== undefined ? { signatureSha256: r.signatureSha256 } : {}),
        });
      }
      return out;
    },

    async readBrandingAsset(ctx, input) {
      tenantOf(ctx);
      if (ctx.actor.type !== 'user' && ctx.actor.type !== 'system') throw forbidden();      // 08 A13 D-26
      if (ctx.actor.type === 'user') await load(ctx);                                       // a live, unlocked actor of the tenant
      const id = (input as any)?.assetId;
      if (!uuid(id)) throw err('common.not_found');
      const a = await repo.brandingAsset(ctx, { assetId: id });
      if (!a || a.tenantId !== ctx.tenantId || !BRANDING_KINDS.includes(a.kind)) throw err('common.not_found');   // signature → not_found
      if (a.scanState !== 'clean') throw err('common.upload_quarantined');                  // P-19
      if (!MIME.includes(a.mimeType)) throw err('common.not_found');
      return { assetId: a.id as any, kind: a.kind as any, mimeType: a.mimeType as any, sha256: a.sha256, base64: a.base64 };
    },

    async provisionPartnerMembership(ctx, input) {
      tenantOf(ctx);
      // caller permission (partners.partner.manage / partners.partner_user.manage) is C13's check; partner actors allowed (08 A22.2)
      if (!['user', 'partner', 'system'].includes(ctx.actor.type)) throw forbidden();
      const i: any = input ?? {};
      const email = typeof i.email === 'string' ? i.email.trim().toLowerCase() : '';
      if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw invalid('email_invalid');
      const displayName = typeof i.displayName === 'string' ? i.displayName.trim() : '';
      if (displayName.length < 1 || displayName.length > 120) throw invalid('display_name_invalid');   // core.users__text__ck
      if (!PARTNER_ROLES.includes(i.partnerRole)) throw invalid('partner_role_invalid');
      if ((await repo.tenantStatus(ctx)) !== 'active') throw err('identity.tenant_suspended');
      if (await repo.emailExists(ctx, { email })) throw err('identity.user_exists');
      const r = await repo.createPartnerMembership(ctx, { email, displayName, partnerRole: i.partnerRole });
      return { membershipId: r.membershipId as any, userId: r.userId as any, invitationId: r.invitationId as any, status: 'invited' };
    },

    async updatePartnerMembership(ctx, input) {
      tenantOf(ctx);
      if (!['user', 'partner', 'system'].includes(ctx.actor.type)) throw forbidden();
      const i: any = input ?? {};
      if (!uuid(i.membershipId)) throw invalid('membership_id_invalid');
      if (!['deactivate', 'reactivate', 'set_role', 'resend_invitation'].includes(i.action)) throw invalid('action_invalid');
      if (i.action === 'set_role' && !PARTNER_ROLES.includes(i.partnerRole)) throw invalid('partner_role_invalid');
      if (i.reasonCode !== undefined && (typeof i.reasonCode !== 'string' || !CODE_RE.test(i.reasonCode))) throw invalid('reason_code_invalid');
      if (i.action === 'deactivate' && i.reasonCode !== undefined && !DEACTIVATION_REASONS.includes(i.reasonCode)) throw invalid('reason_code_invalid');
      if (i.expectedVersion !== undefined && !Number.isInteger(i.expectedVersion)) throw invalid('expected_version_invalid');
      const m = await repo.lockMembership(ctx, { membershipId: i.membershipId });          // SELECT … FOR UPDATE (D-100)
      if (!m || m.actorType !== 'partner' || m.tenantId !== ctx.tenantId) throw err('common.not_found');
      if (i.expectedVersion !== undefined && i.expectedVersion !== m.version) throw err('common.version_conflict');
      if (i.action === 'set_role' && m.status === 'deactivated') throw err('identity.membership_inactive');
      if (i.action === 'reactivate' && m.status === 'invited') throw err('identity.membership_inactive');   // [CONV] no invite bypass
      if (i.action === 'resend_invitation' && m.status !== 'invited') throw err('identity.membership_inactive');
      const r = await repo.applyPartnerAction(ctx, {
        membershipId: i.membershipId, action: i.action,
        ...(i.action === 'set_role' ? { partnerRole: i.partnerRole } : {}), ...(i.reasonCode !== undefined ? { reasonCode: i.reasonCode } : {}),
      });
      if (i.action === 'deactivate') await repo.revokeSessions(ctx, { membershipId: i.membershipId, reason: 'deactivate' });
      if (i.action === 'set_role') await repo.revokeSessions(ctx, { membershipId: i.membershipId, reason: 'role_change' });
      return { membershipId: i.membershipId, status: r.status, version: r.version };
    },

    // LD-81 (T31): the patient kind has no GoTrue user / session, so D-218 no longer blocks these two (patient pre_auth context only).
    async provisionPatientMembership(ctx, input) {
      await requirePreAuthPatient(ctx);
      const accountId = (input as any)?.accountId;
      if (!uuid(accountId)) throw invalid('account_id_invalid');
      if (!repo.createPatientMembership) throw unwired();
      const r = await repo.createPatientMembership(ctx, { accountId });   // idempotent per accountId; user id generated by LIMS; no phone / e-mail
      return { membershipId: r.membershipId as any, userId: r.userId as any };
    },
    async openPatientSession(ctx, input) {
      await requirePreAuthPatient(ctx);
      const i: any = input ?? {};
      if (!uuid(i.membershipId)) throw invalid('membership_id_invalid');
      if (!uuid(i.appInstanceId)) throw invalid('app_instance_id_invalid');
      if (i.appPlatform !== 'android' && i.appPlatform !== 'ios') throw invalid('app_platform_invalid');
      const m = await repo.membership(ctx, { membershipId: i.membershipId });
      if (!m || m.actorType !== 'patient' || m.tenantId !== ctx.tenantId) throw err('common.not_found');
      if (m.status !== 'active') throw err('identity.membership_inactive');
      if (!repo.insertPatientSession || !deps.mintPatientAccessToken) throw unwired();
      const now = nowMs(); const token = newToken(); const id = newId();
      const absoluteExpiresAt = new Date(now + PATIENT_ABSOLUTE_MS);
      await repo.insertPatientSession(ctx, {
        id, membershipId: m.membershipId, userId: m.userId, kind: 'patient', tokenSha256: createHash('sha256').update(token).digest(), state: 'active', aal: 'aal1',
        appInstanceId: i.appInstanceId, appPlatform: i.appPlatform, idleTimeoutMinutes: PATIENT_IDLE_MIN,
        idleExpiresAt: new Date(now + PATIENT_IDLE_MIN * 60_000), absoluteExpiresAt, expiresAt: absoluteExpiresAt, actorId: ctx.actor.id,
      });
      const expiresAt = new Date(Math.min(now + PATIENT_JWT_MS, absoluteExpiresAt.getTime()));   // never outlives the session
      const accessToken = deps.mintPatientAccessToken({ sub: m.userId, sessionId: id, aal: 'aal1', issuedAt: new Date(now), expiresAt });
      return { sessionToken: token, accessToken, accessExpiresAt: expiresAt.toISOString() as any, sessionExpiresAt: absoluteExpiresAt.toISOString() as any };
    },

    async revokePatientSessions(ctx, input) {
      tenantOf(ctx);
      const i: any = input ?? {};
      if (ctx.actor.type === 'patient') {
        const r = await load(ctx);
        if (!uuid(i.membershipId) || claim(r.claims, 'membership_id') !== i.membershipId) throw forbidden();
      } else if (ctx.actor.type !== 'system') throw forbidden();
      if (!uuid(i.membershipId)) throw invalid('membership_id_invalid');
      if (typeof i.reason !== 'string' || !REVOKE_REASONS.includes(i.reason)) throw invalid('reason_invalid');
      if (typeof i.deactivateMembership !== 'boolean') throw invalid('deactivate_membership_invalid');
      const m = await repo.membership(ctx, { membershipId: i.membershipId });
      if (!m || m.actorType !== 'patient' || m.tenantId !== ctx.tenantId) throw err('common.not_found');
      if (i.deactivateMembership && !repo.deactivatePatientMembership) throw unwired();   // checked before any write
      const revokedSessions = await repo.revokeSessions(ctx, { membershipId: i.membershipId, reason: i.reason });
      if (i.deactivateMembership) await repo.deactivatePatientMembership!(ctx, { membershipId: i.membershipId });   // 08 A28.2 write scope in the repo
      return { revokedSessions };
    },

    async getStaffNotificationContact(ctx, input) {
      tenantOf(ctx);
      if (ctx.actor.type !== 'system') throw forbidden();
      const i: any = input ?? {};
      if (typeof i.requiredPermission !== 'string' || !KNOWN.has(i.requiredPermission)) throw invalid('unknown_permission');
      if (!uuid(i.membershipId)) throw err('common.not_found');
      const m = await repo.membership(ctx, { membershipId: i.membershipId });
      if (!m || m.tenantId !== ctx.tenantId) throw err('common.not_found');
      const eligible = m.status === 'active' && m.actorType === 'user' && m.lockedAt === null && m.permissions.includes(i.requiredPermission);
      return { membershipId: m.membershipId as any, email: m.email ?? null, eligible };
    },

    async readSignatureImage(ctx, input) {
      requireSystemWith(ctx, 'identity.signatory.read');
      const id = (input as any)?.membershipId;
      if (!uuid(id)) throw err('common.not_found');
      const s = await repo.signatureImage(ctx, { membershipId: id });
      if (!s || s.tenantId !== ctx.tenantId || s.scanState !== 'clean' || !MIME.includes(s.mimeType)) throw err('common.not_found');
      return { membershipId: id as any, contentBase64: s.base64, mimeType: s.mimeType as any, sha256: s.sha256 };
    },

    invalidateTenantSettings(tenantId: string) { settingsCache.delete(tenantId); },
  };

  async function requirePreAuthPatient(ctx: any) {
    tenantOf(ctx);
    if (ctx.actor.type !== 'patient') throw forbidden();
    const r = await load(ctx);
    if (claim(r.claims, 'patient_stage') !== 'pre_auth') throw forbidden();
  }

  return port;
}
