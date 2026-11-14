// packages/fakes/src/IdentityPort.fake.ts — IC §4.6 fake (C0 TRD §5.4): actors per default role for both tenants,
// centre-scoped / all-centre, locked, aal1 vs aal2, privileged list, settings overrides per test (08 §4.12 defaults).
import { createHash } from "node:crypto";
import type { IdentityPort, TenantSettings } from "@lims/contracts/ports/IdentityPort";
import { FIXED_ACTOR_PERMISSIONS, PERMISSION_CODES, PRIVILEGED, ROLE_GRANTS } from "../../../contracts/ports/generated/permissions.ts"; // [CONV] @lims/contracts does not export this subpath yet
import {
  TENANTS, actorIdFor, actorType, err, forbidden, idFor, invalid, makeFake, notFound, requireStr, tenantOf,
  type FakeOpts, type TenantKey,
} from "./base";

export interface MembershipRow {
  id: string; tenantId: string; actorId: string; actorType: "user" | "partner" | "patient";
  displayName: string; roles: string[]; extraPermissions?: string[];
  centreScope: { all: boolean; centreIds: string[] }; branchIds: string[];
  mfaLevel: "aal1" | "aal2"; isLocked: boolean; status: "invited" | "active" | "deactivated";
  email: string | null; version: number; partnerRole?: "partner_admin" | "partner_member"; accountId?: string;
  signature?: { displayTitle: string; registrationNo?: string; signatureAssetId?: string; sha256?: string; base64?: string; mimeType?: "image/png" | "image/jpeg" };
}
export interface IdentityFixtures {
  memberships: MembershipRow[];
  /** Per-tenant overrides of the 08 §4.12 defaults. */
  settings: Record<string, Partial<TenantSettings>>;
  brandingAssets: { id: string; tenantId: string; kind: "logo" | "letterhead_header" | "letterhead_footer"; mimeType: "image/png" | "image/jpeg"; sha256: string; base64: string }[];
  /** System actors' permissions (CV §2.3: declared per worker manifest) [CONV: one set for every system actor]. */
  systemPermissions: string[];
}

// 1x1 transparent PNG (synthetic asset)
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PNG_SHA = createHash("sha256").update(Buffer.from(PNG, "base64")).digest("hex");

/** 08 §4.12 defaults; values marked [CONV] are fake choices inside the 04 ranges. */
export const DEFAULT_SETTINGS: TenantSettings = {
  calendarDisplay: "AD",
  timezone: "Asia/Kathmandu",
  idleTimeoutMinutes: 15,          // [CONV] within 15–30
  absoluteSessionHours: 12,
  reportLinkTtlDays: 30,           // [CONV] within 30–90
  releaseRequiresPayment: false,   // [CONV]
  partialReleaseAllowed: false,    // [CONV]
  letterheadDefault: "with",       // [CONV]
  numbering: {
    registrationNoPattern: "{centre:4}SY{seq:6}", barcodePattern: "{prefix}{seq:8}", patientCodePattern: "P{seq:6}", // [CONV]
    invoiceNoPattern: "INV-{fy}-{seq:6}", creditNoteNoPattern: "CN-{fy}-{seq:6}",                              // [CONV]
    receiptNoPattern: "RC-{fy}-{seq:6}", accessionNoPattern: "{prefix}{yy}-{seq:4}",
    accessionPrefixes: { histology: "S", cytology: "C", ihc: "I", molecular: "M" },
  },
  channels: { whatsappEnabled: false, smsEnabled: true, emailEnabled: true },                                  // [CONV]
  branding: { legalName: "Synthetic Test Lab Pvt Ltd", displayName: "Synthetic Test Lab", addressLines: ["Test Street 1"], phones: ["01-0000000"] },
  retentionYears: 5,
  retention: { clinicalYears: 5, auditYears: 5, rawInstrumentYears: 1 },
  featureFlags: {},
  referralIncentiveReportEnabled: false,
  autoVerificationEnabled: false,
  westgardMode: "classic",          // [CONV]
  ird: { cbmsRealtimeRequired: false, annexReadiness: "incomplete" },
};

/** Personas (harness `ctxFor('<T>:<type>:<persona>')`): default=lab_technologist, admin=tenant_admin, aal1, locked, centre, revoked, partner. */
function defaults(seed: number): IdentityFixtures {
  const memberships: MembershipRow[] = [];
  let n = 0x100;
  const centre = (t: TenantKey) => idFor(seed, t === "A" ? 0xc1 : 0xc2);
  for (const t of ["A", "B"] as TenantKey[]) {
    const mk = (persona: string, roles: string[], o: Partial<MembershipRow> = {}, type: MembershipRow["actorType"] = "user"): void => {
      memberships.push({
        id: idFor(seed, n++), tenantId: TENANTS[t], actorId: actorIdFor(t, type, persona), actorType: type,
        displayName: `Test User ${t}-${persona}`, roles, centreScope: { all: true, centreIds: [] }, branchIds: [],
        mfaLevel: "aal2", isLocked: false, status: "active", email: `${persona}.${t.toLowerCase()}@example.com`, version: 1, ...o,
      });
    };
    mk("default", ["lab_technologist"]);
    mk("admin", ["tenant_admin"], {
      signature: { displayTitle: "Consultant Pathologist", registrationNo: "NMC-0000", signatureAssetId: idFor(seed, t === "A" ? 0xa1 : 0xa2), sha256: PNG_SHA, base64: PNG, mimeType: "image/png" },
    });
    mk("aal1", ["tenant_admin"], { mfaLevel: "aal1" });
    mk("locked", ["lab_technologist"], { isLocked: true });
    mk("centre", ["front_desk"], { centreScope: { all: false, centreIds: [centre(t)] } });
    mk("revoked", ["tenant_admin"], { status: "deactivated" });
    mk("default", ["partner_admin"], { partnerRole: "partner_admin", centreScope: { all: false, centreIds: [] } }, "partner");
  }
  return {
    memberships,
    settings: {},
    brandingAssets: (["A", "B"] as TenantKey[]).map((t, i) => ({ id: idFor(seed, 0xb1 + i), tenantId: TENANTS[t], kind: "logo" as const, mimeType: "image/png" as const, sha256: PNG_SHA, base64: PNG })),
    systemPermissions: ["identity.signatory.read"],
  };
}

const KNOWN = new Set<string>(PERMISSION_CODES);
const isPrivileged = (p: string) => (PRIVILEGED as ReadonlySet<string>).has(p);

export function createFakeIdentityPort(opts: FakeOpts<IdentityFixtures>) {
  return makeFake(defaults, opts, (s) => {
    const rows = s.fixtures.memberships;
    const sessions = new Map<string, number>();
    const own = (ctx: any, id: unknown) => rows.find((r) => r.tenantId === tenantOf(ctx) && r.id === id);
    const membershipOf = (ctx: any) => rows.find((r) => r.tenantId === tenantOf(ctx) && r.actorId === ctx?.actor?.id && r.actorType === actorType(ctx));
    const permsOf = (m: MembershipRow) =>
      m.actorType === "partner" ? [...FIXED_ACTOR_PERMISSIONS.partner[m.partnerRole ?? "partner_member"]]
        : m.actorType === "patient" ? [...FIXED_ACTOR_PERMISSIONS.patient]
          : [...new Set([...m.roles.flatMap((r) => ROLE_GRANTS[r] ?? []), ...(m.extraPermissions ?? [])])];

    function profile(ctx: any) {
      const t = tenantOf(ctx);
      const type = actorType(ctx);
      const actor = { type, id: ctx.actor?.id };
      const base = { actor, roles: [] as string[], centreScope: { all: false, centreIds: [] as string[] }, branchIds: [] as string[], mfa: { enrolled: false, level: "aal1" as const }, isLocked: false };
      if (type === "system") return { profile: { ...base, displayName: "System", permissions: [...s.fixtures.systemPermissions], centreScope: { all: true, centreIds: [] } }, m: undefined };
      if (type === "device") return { profile: { ...base, displayName: "Device", permissions: [...FIXED_ACTOR_PERMISSIONS.device.bridge_agent] }, m: undefined };
      if (type === "portal") return { profile: { ...base, displayName: "Portal", permissions: [...FIXED_ACTOR_PERMISSIONS.portal] }, m: undefined };
      const m = membershipOf(ctx);
      if (!m || !t) throw err("auth.unauthenticated");
      if (m.isLocked) throw err("auth.account_locked");
      return {
        m,
        profile: {
          actor: { ...actor, membershipId: m.id }, displayName: m.displayName, roles: m.partnerRole ? [m.partnerRole] : [...m.roles],
          permissions: m.status === "active" ? permsOf(m) : [], centreScope: m.centreScope, branchIds: m.branchIds,
          mfa: { enrolled: m.mfaLevel === "aal2", level: m.mfaLevel }, isLocked: false,
          ...(m.signature ? { signature: { displayTitle: m.signature.displayTitle, registrationNo: m.signature.registrationNo, signatureImageRef: m.signature.signatureAssetId } } : {}),
        },
      };
    }
    const requireSystemSignatory = (ctx: any) => {
      if (actorType(ctx) !== "system" || !s.fixtures.systemPermissions.includes("identity.signatory.read")) throw forbidden();
    };

    const port: IdentityPort = {
      async getActor(ctx) { return profile(ctx).profile as any; },

      async assertRole(ctx, req) {
        const p = requireStr(req?.permission, "permission_required");
        if (!KNOWN.has(p)) throw invalid("unknown_permission");
        if (p.startsWith("platform.")) throw forbidden();
        const { profile: pr, m } = profile(ctx);
        if (m && m.status !== "active") throw forbidden();          // privileged re-validation reads the membership (04 A4)
        if (!pr.permissions.includes(p)) throw forbidden();
        if (isPrivileged(p) && m && m.mfaLevel !== "aal2") throw err("auth.mfa_required");
        if (req.centreId && !pr.centreScope.all && !pr.centreScope.centreIds.includes(req.centreId)) throw forbidden();
      },

      async getTenantSettings(ctx, input) {
        const all: any = { ...DEFAULT_SETTINGS, ...(s.fixtures.settings[tenantOf(ctx)] ?? {}) };
        if (!input?.keys) return all;
        return Object.fromEntries(input.keys.map((k) => [k, all[k]])) as any;
      },

      async getSignatories(ctx, input) {
        requireSystemSignatory(ctx);
        const ids = input?.membershipIds;
        if (!Array.isArray(ids) || ids.length > 20) throw invalid("membership_ids_invalid");
        return ids.map((id) => own(ctx, id)).filter((m): m is MembershipRow => !!m?.signature).map((m) => ({
          membershipId: m.id as any, displayName: m.displayName, displayTitle: m.signature!.displayTitle, registrationNo: m.signature!.registrationNo,
          signatureAssetId: m.signature!.signatureAssetId as any, signatureSha256: m.signature!.sha256, isActive: m.status === "active",
        }));
      },

      async readBrandingAsset(ctx, input) {
        if (!["user", "system"].includes(actorType(ctx))) throw forbidden();
        const a = s.fixtures.brandingAssets.find((x) => x.tenantId === tenantOf(ctx) && x.id === input?.assetId);
        if (!a) throw notFound();
        return { assetId: a.id as any, kind: a.kind, mimeType: a.mimeType, sha256: a.sha256, base64: a.base64 };
      },

      // Caller authorisation (partners.partner.manage / partners.partner_user.manage) is C13's check [CONV: fake does not re-check].
      async provisionPartnerMembership(ctx, input) {
        const t = tenantOf(ctx);
        const email = requireStr(input?.email, "email_required").toLowerCase();
        requireStr(input?.displayName, "display_name_required");
        if (!["partner_admin", "partner_member"].includes(input?.partnerRole)) throw invalid("partner_role_invalid");
        if (rows.some((r) => r.tenantId === t && r.email === email)) throw err("identity.user_exists");
        const m: MembershipRow = {
          id: s.nextId(), tenantId: t, actorId: s.nextId(), actorType: "partner", displayName: input.displayName, roles: [],
          centreScope: { all: false, centreIds: [] }, branchIds: [], mfaLevel: "aal1", isLocked: false, status: "invited",
          email, version: 1, partnerRole: input.partnerRole,
        };
        rows.push(m);
        return { membershipId: m.id as any, userId: m.actorId as any, invitationId: s.nextId() as any, status: "invited" };
      },

      // D-100: expectedVersion optional — omitted ⇒ applied to the current row.
      async updatePartnerMembership(ctx, input) {
        const m = own(ctx, input?.membershipId);
        if (!m || m.actorType !== "partner") throw notFound();
        if (input.expectedVersion !== undefined && input.expectedVersion !== m.version) throw err("common.version_conflict");
        switch (input.action) {
          case "deactivate": m.status = "deactivated"; sessions.delete(m.id); break;
          case "reactivate": m.status = "active"; break;
          case "set_role":
            if (!["partner_admin", "partner_member"].includes(input.partnerRole as string)) throw invalid("partner_role_invalid");
            if (m.status === "deactivated") throw err("identity.membership_inactive");
            m.partnerRole = input.partnerRole; sessions.delete(m.id); break;
          case "resend_invitation": if (m.status !== "invited") throw err("identity.membership_inactive"); break;
          default: throw invalid("action_invalid");
        }
        m.version += 1;
        return { membershipId: m.id as any, status: m.status, version: m.version };
      },

      async provisionPatientMembership(ctx, input) {
        if (actorType(ctx) !== "patient") throw forbidden();
        const t = tenantOf(ctx);
        const accountId = requireStr(input?.accountId, "account_id_required");
        let m = rows.find((r) => r.tenantId === t && r.actorType === "patient" && r.accountId === accountId);
        if (!m) {
          m = { id: s.nextId(), tenantId: t, actorId: s.nextId(), actorType: "patient", displayName: "Patient", roles: [], centreScope: { all: false, centreIds: [] },
            branchIds: [], mfaLevel: "aal1", isLocked: false, status: "active", email: null, version: 1, accountId };
          rows.push(m);
        }
        return { membershipId: m.id as any, userId: m.actorId as any };
      },

      async openPatientSession(ctx, input) {
        if (actorType(ctx) !== "patient") throw forbidden();
        const m = own(ctx, input?.membershipId);
        if (!m || m.actorType !== "patient") throw notFound();
        if (m.status !== "active") throw err("identity.membership_inactive");
        requireStr(input.appInstanceId, "app_instance_id_required");
        if (!["android", "ios"].includes(input.appPlatform)) throw invalid("app_platform_invalid");
        const k = (sessions.get(m.id) ?? 0) + 1;
        sessions.set(m.id, k);
        const now = Date.parse(ctx.now());
        return {
          sessionToken: `fake-session-${m.id}-${k}`, accessToken: `fake-access-${m.id}-${k}`,
          accessExpiresAt: new Date(now + 15 * 60_000).toISOString() as any, sessionExpiresAt: new Date(now + 30 * 86_400_000).toISOString() as any, // [CONV]
        };
      },

      async revokePatientSessions(ctx, input) {
        const m = own(ctx, input?.membershipId);
        const type = actorType(ctx);
        if (type === "patient") { if (!m || m.actorId !== ctx.actor.id) throw forbidden(); } else if (type !== "system") throw forbidden();
        if (!m || m.actorType !== "patient") throw notFound();
        requireStr(input.reason, "reason_required");
        const revokedSessions = sessions.get(m.id) ?? 0;
        sessions.delete(m.id);
        if (input.deactivateMembership) { m.status = "deactivated"; m.version += 1; }
        return { revokedSessions };
      },

      async getStaffNotificationContact(ctx, input) {
        if (actorType(ctx) !== "system") throw forbidden();
        const p = requireStr(input?.requiredPermission, "permission_required");
        if (!KNOWN.has(p)) throw invalid("unknown_permission");
        const m = own(ctx, input.membershipId);
        if (!m) throw notFound();
        const eligible = m.status === "active" && m.actorType === "user" && !m.isLocked && permsOf(m).includes(p);
        return { membershipId: m.id as any, email: m.email, eligible };
      },

      // A21.2 (return type 08 A26.1)
      async readSignatureImage(ctx, input) {
        requireSystemSignatory(ctx);
        const m = own(ctx, input?.membershipId);
        if (!m?.signature?.base64) throw notFound();
        return { membershipId: m.id as any, contentBase64: m.signature.base64, mimeType: m.signature.mimeType ?? "image/png", sha256: m.signature.sha256 ?? "" };
      },
    };
    return port;
  });
}
