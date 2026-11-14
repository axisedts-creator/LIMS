// packages/fakes/contract-tests/IdentityPort.contract.ts — IC §4.6 case list (CV §8.4). Runs against the fake (C0) and the
// real C2 implementation. Seeds memberships in the fake fixture shape (`memberships[]`, `settings`); a real-impl harness maps them.
import { beforeEach, describe, expect, it as vit } from "vitest";
import type { ContractHarness } from "../src/harness";

const M = (n: number) => `01900000-0000-7000-8000-0000000a${n.toString(16).padStart(4, "0")}`;
const CENTRE_IN = "01900000-0000-7000-8000-0000000c0001";
const CENTRE_OUT = "01900000-0000-7000-8000-0000000c0002";

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const e: any = await p.then(() => undefined, (x) => x);
  expect(e?.code, `expected ${code}`).toBe(code);
}

export function runIdentityPortContract(makeImpl: () => Promise<ContractHarness>, opts: { phase1Stub?: boolean } = {}): void {
  // No phase stub for IdentityPort (08 R9): every case runs; phase1Stub mode runs nothing.
  const it = opts.phase1Stub ? vit.skip : vit;
  let h: ContractHarness;
  const row = (key: string, id: string, o: Record<string, unknown> = {}) => {
    const c = h.ctxFor(key);
    return {
      id, tenantId: c.tenantId, actorId: c.actor.id, actorType: c.actor.type, displayName: `Test User ${id.slice(-4)}`,
      roles: ["lab_technologist"], centreScope: { all: true, centreIds: [] }, branchIds: [], mfaLevel: "aal2",
      isLocked: false, status: "active", email: `user${id.slice(-4)}@example.com`, version: 1, ...o,
    };
  };

  describe("IdentityPort contract (IC §4.6)", () => {
    beforeEach(async () => {
      h = await makeImpl();
      if (opts.phase1Stub) return;
      await h.seed({
        memberships: [
          row("A:user:c-tech", M(1)),
          row("A:user:c-admin", M(2), { roles: ["tenant_admin"], email: "Admin.Two@example.com".toLowerCase() }),
          row("A:user:c-centre", M(3), { roles: ["front_desk"], centreScope: { all: false, centreIds: [CENTRE_IN] } }),
          row("A:user:c-aal1", M(4), { roles: ["tenant_admin"], mfaLevel: "aal1" }),
          row("A:user:c-locked", M(5), { roles: ["tenant_admin"], isLocked: true }),
          row("A:user:c-revoked", M(6), { roles: ["tenant_admin"], status: "deactivated" }),
          row("A:partner:c-partner", M(7), { roles: [], partnerRole: "partner_admin", centreScope: { all: false, centreIds: [] } }),
          row("B:user:c-admin", M(8), { roles: ["tenant_admin"] }),
        ],
      });
    });

    it("(1) permission held → resolves", async () => {
      await expect(h.impl.assertRole(h.ctxFor("A:user:c-tech"), { permission: "lab.result.read" })).resolves.toBeUndefined();
    });
    it("(2) missing → auth.forbidden", async () => {
      await expectCode(h.impl.assertRole(h.ctxFor("A:user:c-tech"), { permission: "billing.invoice.issue" }), "auth.forbidden");
    });
    it("(3) centre outside scope → auth.forbidden", async () => {
      const ctx = h.ctxFor("A:user:c-centre");
      await expect(h.impl.assertRole(ctx, { permission: "frontdesk.registration.create", centreId: CENTRE_IN })).resolves.toBeUndefined();
      await expectCode(h.impl.assertRole(ctx, { permission: "frontdesk.registration.create", centreId: CENTRE_OUT }), "auth.forbidden");
    });
    it("(4) privileged at aal1 → auth.mfa_required", async () => {
      await expectCode(h.impl.assertRole(h.ctxFor("A:user:c-aal1"), { permission: "identity.user.manage" }), "auth.mfa_required");
      await expect(h.impl.assertRole(h.ctxFor("A:user:c-admin"), { permission: "identity.user.manage" })).resolves.toBeUndefined();
    });
    it("(5) locked → auth.account_locked", async () => {
      await expectCode(h.impl.assertRole(h.ctxFor("A:user:c-locked"), { permission: "catalog.test.read" }), "auth.account_locked");
      await expectCode(h.impl.getActor(h.ctxFor("A:user:c-locked")), "auth.account_locked");
    });
    it("(6) membership revoked after token issued → privileged check fails", async () => {
      const e: any = await h.impl.assertRole(h.ctxFor("A:user:c-revoked"), { permission: "identity.user.manage" }).then(() => undefined, (x: any) => x);
      expect(e?.code).toMatch(/^auth\./);
    });
    it("(7) device actor cannot get lab.result.read", async () => {
      await expectCode(h.impl.assertRole(h.ctxFor("A:device"), { permission: "lab.result.read" }), "auth.forbidden");
    });
    it("(8) settings defaults: calendarDisplay AD, idle within 15–30, link TTL within 30–90", async () => {
      const s = await h.impl.getTenantSettings(h.ctxFor("A:user:c-tech"));
      expect(s.calendarDisplay).toBe("AD");
      expect(s.idleTimeoutMinutes).toBeGreaterThanOrEqual(15);
      expect(s.idleTimeoutMinutes).toBeLessThanOrEqual(30);
      expect(s.reportLinkTtlDays).toBeGreaterThanOrEqual(30);
      expect(s.reportLinkTtlDays).toBeLessThanOrEqual(90);
      expect(s.timezone).toBe("Asia/Kathmandu");
    });
    it("(9) keys filter returns only requested keys", async () => {
      const s = await h.impl.getTenantSettings(h.ctxFor("A:user:c-tech"), { keys: ["timezone", "calendarDisplay"] });
      expect(Object.keys(s).sort()).toEqual(["calendarDisplay", "timezone"]);
    });
    it("(10) unknown permission code → common.validation_failed", async () => {
      await expectCode(h.impl.assertRole(h.ctxFor("A:user:c-admin"), { permission: "nope.not.a_permission" }), "common.validation_failed");
    });
    it("(11) getStaffNotificationContact: active unlocked user holding requiredPermission → eligible, email", async () => {
      const r = await h.impl.getStaffNotificationContact(h.ctxFor("A:system"), { membershipId: M(2), requiredPermission: "analytics.schedule.manage" });
      expect(r).toEqual({ membershipId: M(2), email: "admin.two@example.com", eligible: true });
    });
    it("(12) without requiredPermission, not active, locked or not actor_type user → eligible: false", async () => {
      const sys = h.ctxFor("A:system");
      for (const id of [M(1), M(6), M(5), M(7)]) {
        const r = await h.impl.getStaffNotificationContact(sys, { membershipId: id, requiredPermission: id === M(1) ? "analytics.schedule.manage" : "audit.log.read" });
        expect(r.eligible, id).toBe(false);
      }
    });
    it("(13) D-100 updatePartnerMembership without expectedVersion succeeds; with a stale version → common.version_conflict", async () => {
      const ctx = h.ctxFor("A:user:c-admin");
      const r = await h.impl.updatePartnerMembership(ctx, { membershipId: M(7), action: "deactivate" });   // no expectedVersion
      expect(r.status).toBe("deactivated");
      await expectCode(h.impl.updatePartnerMembership(ctx, { membershipId: M(7), action: "reactivate", expectedVersion: r.version - 1 }), "common.version_conflict");
      const r2 = await h.impl.updatePartnerMembership(ctx, { membershipId: M(7), action: "reactivate", expectedVersion: r.version });
      expect(r2.status).toBe("active");
      expect(r2.version).toBeGreaterThan(r.version);
    });

    // ---- added cases (CV §8.4: owners may add)
    it("A21.2 readSignatureImage: unknown or other-tenant membership → common.not_found; non-system actor → auth.forbidden", async () => {
      await expectCode(h.impl.readSignatureImage(h.ctxFor("A:system"), { membershipId: M(99) }), "common.not_found");
      await expectCode(h.impl.readSignatureImage(h.ctxFor("A:system"), { membershipId: M(8) }), "common.not_found");
      await expectCode(h.impl.readSignatureImage(h.ctxFor("A:user:c-admin"), { membershipId: M(2) }), "auth.forbidden");
    });
    it("D-100 updatePartnerMembership on a non-partner or other-tenant membership → common.not_found", async () => {
      await expectCode(h.impl.updatePartnerMembership(h.ctxFor("A:user:c-admin"), { membershipId: M(1), action: "deactivate" }), "common.not_found");
      await expectCode(h.impl.updatePartnerMembership(h.ctxFor("B:user:c-admin"), { membershipId: M(7), action: "deactivate" }), "common.not_found");
    });
    it("assertRole refuses platform.* codes", async () => {
      await expectCode(h.impl.assertRole(h.ctxFor("A:user:c-admin"), { permission: "platform.tenant.read" }), "auth.forbidden");
    });
    it("getStaffNotificationContact: other tenant's membership → common.not_found", async () => {
      await expectCode(h.impl.getStaffNotificationContact(h.ctxFor("B:system"), { membershipId: M(2), requiredPermission: "audit.log.read" }), "common.not_found");
    });
  });
}
