// packages/fakes/contract-tests/RenderPort.contract.ts — IC §4.16 case list (CV §8.4). No phase stub (08 R9).
// Outage is seeded as `{ rendererDown: true }` (fake fixture shape; a real-impl harness stops/points away the renderer).
import { beforeEach, describe, expect, it as vit } from "vitest";
import type { ContractHarness } from "../src/harness";

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const e: any = await p.then(() => undefined, (x) => x);
  expect(e?.code, `expected ${code}`).toBe(code);
}
const SLIP = {
  tenantDisplayName: "Synthetic Test Lab", partnerName: "Test Partner Clinic", patientDisplayName: "Test Patient 0042",
  orderRef: "0001SY000001", portalUrl: "https://portal.invalid/r/tok0001", expiresAtLocal: "2026-12-05 10:00", issuedAtLocal: "2026-11-05 10:00",
};

export function runRenderPortContract(makeImpl: () => Promise<ContractHarness>, opts: { phase1Stub?: boolean } = {}): void {
  const it = opts.phase1Stub ? vit.skip : vit;
  let h: ContractHarness;
  describe("RenderPort contract (IC §4.16)", () => {
    beforeEach(async () => { h = await makeImpl(); });

    it("(1) unknown key → common.validation_failed", async () => {
      await expectCode(h.impl.renderPdf(h.ctxFor("A:system"), { templateKey: "billing.nope", data: {}, idempotencyKey: "r-1" }), "common.validation_failed");
    });
    it("(2) data violating schema → reporting.template_invalid", async () => {
      const { portalUrl: _drop, ...bad } = SLIP;
      await expectCode(h.impl.renderPdf(h.ctxFor("A:system"), { templateKey: "partners.access_slip", data: bad, idempotencyKey: "r-2" }), "reporting.template_invalid");
    });
    it("(3) user actor → auth.forbidden", async () => {
      await expectCode(h.impl.renderPdf(h.ctxFor("A"), { templateKey: "partners.access_slip", data: SLIP, idempotencyKey: "r-3" }), "auth.forbidden");
    });
    it("(4) same idempotencyKey + data → identical sha256", async () => {
      const a = await h.impl.renderPdf(h.ctxFor("A:system"), { templateKey: "partners.access_slip", data: SLIP, idempotencyKey: "r-4" });
      const b = await h.impl.renderPdf(h.ctxFor("A:system"), { templateKey: "partners.access_slip", data: { ...SLIP }, idempotencyKey: "r-4" });
      expect(b.sha256).toBe(a.sha256);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.byteSize).toBe(Buffer.from(a.contentBase64, "base64").length);
      expect(a.pageCount).toBeGreaterThanOrEqual(1);
    });
    it("(5) renderer down → reporting.render_unavailable", async () => {
      await h.seed({ rendererDown: true });
      await expectCode(h.impl.renderPdf(h.ctxFor("A:system"), { templateKey: "partners.access_slip", data: SLIP, idempotencyKey: "r-5" }), "reporting.render_unavailable");
    });
    it("P-40 idempotencyKey outside ^[A-Za-z0-9_.:-]{1,200}$ → common.validation_failed", async () => {
      for (const k of ["", "a b", "a/b", "x".repeat(201)]) {
        await expectCode(h.impl.renderPdf(h.ctxFor("A:system"), { templateKey: "partners.access_slip", data: SLIP, idempotencyKey: k }), "common.validation_failed");
      }
    });
  });
}
