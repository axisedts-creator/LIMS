// packages/fakes/src/EngagementPort.fake.ts — IC §4.17 fake: seeded memberships (active / expired) and home addresses per tenant.
import type { EngagementPort } from "@lims/contracts/ports/EngagementPort";
import { TENANTS, actorType, forbidden, idFor, makeFake, notFound, nowOf, requireStr, tenantOf, type FakeOpts } from "./base";

export interface EngagementFixtures {
  memberships: { membershipId: string; tenantId: string; patientId: string; planCode: string; planName: string; priceListId?: string; validFrom: string; validTo: string; status: "active" | "cancelled" }[];
  homeAddresses: { id: string; tenantId: string; addressText: string; landmark?: string; latitude?: string; longitude?: string }[];
}

const defaults = (seed: number): EngagementFixtures => ({
  memberships: [
    { membershipId: idFor(seed, 0x301), tenantId: TENANTS.A, patientId: idFor(seed, 0x201), planCode: "GOLD", planName: "Test Gold Plan", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2027-01-01T00:00:00.000Z", status: "active" },
    { membershipId: idFor(seed, 0x302), tenantId: TENANTS.B, patientId: idFor(seed, 0x202), planCode: "GOLD", planName: "Test Gold Plan", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2027-01-01T00:00:00.000Z", status: "active" },
  ],
  homeAddresses: [
    { id: idFor(seed, 0x401), tenantId: TENANTS.A, addressText: "Test Street 1, Test Ward 1", landmark: "Near Test Chowk", latitude: "27.700000", longitude: "85.300000" },
    { id: idFor(seed, 0x402), tenantId: TENANTS.B, addressText: "Test Street 2, Test Ward 2" },
  ],
});

/** user (staff) and system only; device/patient/portal/partner → auth.forbidden. Staff permission checks are the caller's (C4/C17) [CONV]. */
const requireStaffOrSystem = (ctx: any) => { if (!["user", "system"].includes(actorType(ctx))) throw forbidden(); };

export function createFakeEngagementPort(opts: FakeOpts<EngagementFixtures>) {
  return makeFake(defaults, opts, (s) => {
    const port: EngagementPort = {
      async getHomeAddress(ctx, input) {
        const t = tenantOf(ctx);
        requireStaffOrSystem(ctx);
        const a = s.fixtures.homeAddresses.find((x) => x.tenantId === t && x.id === input?.homeAddressId);
        if (!a) throw notFound();
        const { id: _i, tenantId: _t, ...out } = a;
        return out;
      },
      async getActiveMembership(ctx, input) {
        const t = tenantOf(ctx);
        requireStaffOrSystem(ctx);
        const patientId = requireStr(input?.patientId, "patient_id_required");
        const at = Date.parse(input.at ?? nowOf(ctx));
        const m = s.fixtures.memberships.find((x) => x.tenantId === t && x.patientId === patientId && x.status === "active"
          && Date.parse(x.validFrom) <= at && at < Date.parse(x.validTo));
        if (!m) return undefined;
        return { membershipId: m.membershipId as any, planCode: m.planCode, planName: m.planName, ...(m.priceListId ? { priceListId: m.priceListId as any } : {}), validTo: m.validTo as any };
      },
    };
    return port;
  });
}
