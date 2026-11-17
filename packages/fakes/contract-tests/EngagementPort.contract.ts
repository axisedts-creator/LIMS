// packages/fakes/contract-tests/EngagementPort.contract.ts — IC §4.17 case list (CV §8.4). Cases tagged phase1Stub also run
// against the phase stub (getActiveMembership → undefined, getHomeAddress → common.not_found; 08 R9).
import { beforeEach, describe, expect, it as vit } from "vitest";
import type { ContractHarness } from "../src/harness";

const P_A = "01900000-0000-7000-8000-0000000e0001";
const P_EXP = "01900000-0000-7000-8000-0000000e0002";
const ADDR_A = "01900000-0000-7000-8000-0000000e0101";
const PL = "01900000-0000-7000-8000-0000000e0201";

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const e: any = await p.then(() => undefined, (x) => x);
  expect(e?.code, `expected ${code}`).toBe(code);
}

export function runEngagementPortContract(makeImpl: () => Promise<ContractHarness>, opts: { phase1Stub?: boolean } = {}): void {
  let h: ContractHarness;
  describe("EngagementPort contract (IC §4.17)", () => {
    beforeEach(async () => {
      h = await makeImpl();
      const A = h.ctxFor("A").tenantId;
      await h.seed({
        memberships: [
          { membershipId: "01900000-0000-7000-8000-0000000e0301", tenantId: A, patientId: P_A, planCode: "GOLD", planName: "Test Gold Plan", priceListId: PL, validFrom: "2026-01-01T00:00:00.000Z", validTo: "2027-01-01T00:00:00.000Z", status: "active" },
          { membershipId: "01900000-0000-7000-8000-0000000e0302", tenantId: A, patientId: P_EXP, planCode: "GOLD", planName: "Test Gold Plan", validFrom: "2025-01-01T00:00:00.000Z", validTo: "2026-01-01T00:00:00.000Z", status: "active" },
        ],
        homeAddresses: [{ id: ADDR_A, tenantId: A, addressText: "Test Street 9, Test Ward 9" }],
      });
    });

    { // phase1Stub subset: the stub answers these exactly like the real owner would
      const it = vit;
      it("(1) other tenant → not_found / undefined", async () => {
        await expectCode(h.impl.getHomeAddress(h.ctxFor("B:system"), { homeAddressId: ADDR_A, purpose: "home_visit" }), "common.not_found");
        await expect(h.impl.getActiveMembership(h.ctxFor("B"), { patientId: P_A })).resolves.toBeUndefined();
      });
      it("(3) expired membership → undefined", async () => {
        await expect(h.impl.getActiveMembership(h.ctxFor("A"), { patientId: P_EXP })).resolves.toBeUndefined();
        await expect(h.impl.getActiveMembership(h.ctxFor("A"), { patientId: P_A, at: "2027-02-01T00:00:00.000Z" })).resolves.toBeUndefined();
      });
    }
    { // full owner behaviour (fake / real C16), skipped for the phase stub
      const it = opts.phase1Stub ? vit.skip : vit;
      it("(2) device/patient actor → auth.forbidden", async () => {
        for (const key of ["A:device", "A:patient"]) {
          await expectCode(h.impl.getHomeAddress(h.ctxFor(key), { homeAddressId: ADDR_A, purpose: "home_visit" }), "auth.forbidden");
          await expectCode(h.impl.getActiveMembership(h.ctxFor(key), { patientId: P_A }), "auth.forbidden");
        }
      });
      it("own tenant: active membership and home address are returned", async () => {
        await expect(h.impl.getActiveMembership(h.ctxFor("A"), { patientId: P_A })).resolves.toEqual({
          membershipId: "01900000-0000-7000-8000-0000000e0301", planCode: "GOLD", planName: "Test Gold Plan", priceListId: PL, validTo: "2027-01-01T00:00:00.000Z",
        });
        await expect(h.impl.getHomeAddress(h.ctxFor("A:system"), { homeAddressId: ADDR_A, purpose: "home_visit" })).resolves.toMatchObject({ addressText: "Test Street 9, Test Ward 9" });
      });
    }
  });
}
