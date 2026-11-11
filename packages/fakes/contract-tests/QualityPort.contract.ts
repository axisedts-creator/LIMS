// packages/fakes/contract-tests/QualityPort.contract.ts — IC §4.11 contract cases (CV §8.4). Runs against the fake, the
// phase stub (`phase1Stub` subset: cases tagged [phase1Stub]) and the real C9 implementation.
import { beforeEach, describe, expect, it } from "vitest";
import type { ContractHarness } from "../src/harness";

type MakeImpl = () => Promise<ContractHarness>;
const NOW = "2026-11-05T04:15:00.000Z";
const IN = "01900000-0000-7000-8000-0000000c9001";
const AN = "01900000-0000-7000-8000-0000000c9002";
const PLAN = "01900000-0000-7000-8000-0000000c9003";
const LIM = "01900000-0000-7000-8000-0000000c9004";
const R_OK = "01900000-0000-7000-8000-0000000c9101";
const R_BAD = "01900000-0000-7000-8000-0000000c9102";
const R_WARN = "01900000-0000-7000-8000-0000000c9103";
const RESULT = "01900000-0000-7000-8000-0000000c9201";

const good = () => ({ resultId: RESULT, analyteId: AN, instrumentId: IN, valueNumeric: "4.2", instrumentFlags: [] as string[],
  rangeFlag: "N" as const, deltaCheckFailed: false, isCritical: false, resultedAt: NOW });

export function runQualityPortContract(makeImpl: MakeImpl, opts: { phase1Stub?: boolean } = {}): void {
  // Cases without the [phase1Stub] tag need a Phase-2 implementation and are skipped for the stub.
  const full = (fn: () => Promise<void>) => async (t: { skip: () => void }) => { if (opts.phase1Stub) return t.skip(); await fn(); };

  describe("QualityPort contract (IC §4.11)", () => {
    let h: ContractHarness;
    let A: string, B: string;
    beforeEach(async () => { h = await makeImpl(); A = h.ctxFor("A").tenantId; B = h.ctxFor("B").tenantId; });
    const ctx = () => h.ctxFor("A:system");
    const plan = (runs: object[], over: object = {}) => ({ id: PLAN, tenantId: A, instrumentId: IN, analyteId: AN, validityHours: 24, runs, ...over });
    const enable = (runs: object[] = [{ runId: R_OK, at: "2026-11-05T02:00:00.000Z", outcome: "accepted" }], extra: object = {}) => h.seed({
      tenants: { [A]: { autoVerificationEnabled: true, ruleSetVersion: "av-1" } },
      autoVerifyLimits: [{ id: LIM, tenantId: A, analyteId: AN, ruleSetVersion: "av-1", low: "3.5", high: "5.5" }],
      qcPlans: [plan(runs)],
      ...extra,
    });

    it("(1) feature disabled → deny with feature_disabled [phase1Stub]", async () => {
      await h.seed({ tenants: { [A]: { autoVerificationEnabled: false, ruleSetVersion: "av-1" } } });
      const r = await h.impl.canAutoVerify(ctx(), good());
      expect(r.decision).toBe("deny");
      expect(r.reasons).toContain("feature_disabled");
    });
    it("(2) critical → deny with critical", full(async () => {
      await enable();
      const r = await h.impl.canAutoVerify(ctx(), { ...good(), isCritical: true });
      expect(r.decision).toBe("deny");
      expect(r.reasons).toContain("critical");
    }));
    it("(3) delta failure → deny", full(async () => {
      await enable();
      const r = await h.impl.canAutoVerify(ctx(), { ...good(), deltaCheckFailed: true });
      expect(r.decision).toBe("deny");
      expect(r.reasons).toContain("delta_failure");
    }));
    it("(4) QC out of control → deny qc_out_of_control", full(async () => {
      await enable([{ runId: R_OK, at: "2026-11-05T01:00:00.000Z", outcome: "accepted" },
                    { runId: R_BAD, at: "2026-11-05T02:00:00.000Z", outcome: "rejected", violatedRules: ["1-3s"] }]);
      const r = await h.impl.canAutoVerify(ctx(), good());
      expect(r.decision).toBe("deny");
      expect(r.reasons).toContain("qc_out_of_control");
    }));
    it("(5) all criteria pass + enabled → allow", full(async () => {
      await enable();
      const r = await h.impl.canAutoVerify(ctx(), good());
      expect(r).toMatchObject({ decision: "allow", reasons: [] });
    }));
    it("(6) qcStatusFor with only 1-2s → warning", full(async () => {
      await enable([{ runId: R_WARN, at: "2026-11-05T02:00:00.000Z", outcome: "warning", violatedRules: ["1-2s"] }]);
      const q = await h.impl.qcStatusFor(ctx(), { instrumentId: IN, analyteId: AN, at: NOW });
      expect(q.status).toBe("warning");
    }));
    it("(7) time before any QC → no_qc_data [phase1Stub]", async () => {
      await enable();
      const q = await h.impl.qcStatusFor(ctx(), { instrumentId: IN, analyteId: AN, at: "2026-11-01T00:00:00.000Z" });
      expect(q.status).toBe("no_qc_data");
    });
    it("(8) open rejected run masks a newer accepted run", full(async () => {
      await enable([{ runId: R_BAD, at: "2026-11-05T02:00:00.000Z", outcome: "rejected", violatedRules: ["1-3s"] },
                    { runId: R_OK, at: "2026-11-05T03:00:00.000Z", outcome: "accepted" }]);
      const q = await h.impl.qcStatusFor(ctx(), { instrumentId: IN, analyteId: AN, at: NOW });
      expect(q.status).toBe("out_of_control");
      expect(q.currentRunId).toBe(R_BAD);
    }));
    it("(9) staleness → no_qc_data [phase1Stub]", async () => {
      await enable([{ runId: R_OK, at: "2026-11-03T02:00:00.000Z", outcome: "accepted" }]);
      const q = await h.impl.qcStatusFor(ctx(), { instrumentId: IN, analyteId: AN, at: NOW });
      expect(q.status).toBe("no_qc_data");
    });
    it("(10) shadow version never changes the returned decision", full(async () => {
      await enable();
      const before = await h.impl.canAutoVerify(ctx(), good());
      await enable(undefined, {
        tenants: { [A]: { autoVerificationEnabled: true, ruleSetVersion: "av-1", shadowRuleSetVersion: "av-2" } },
        autoVerifyLimits: [{ id: LIM, tenantId: A, analyteId: AN, ruleSetVersion: "av-1", low: "3.5", high: "5.5" },
                           { id: "01900000-0000-7000-8000-0000000c9005", tenantId: A, analyteId: AN, ruleSetVersion: "av-2", low: "9.0", high: "9.5" }],
      });
      const after = await h.impl.canAutoVerify(ctx(), good());
      expect(after.decision).toBe(before.decision);
      expect(after.decision).toBe("allow");
      expect(after.ruleSetVersion).toBe(before.ruleSetVersion);
    }));
    it("(11) allow never returned when any reason applies (property test) [phase1Stub]", async () => {
      await enable();
      const variants = [
        { instrumentFlags: ["E"] }, { isCritical: true }, { deltaCheckFailed: true }, { valueNumeric: "9.9" }, { valueNumeric: "1.0" },
        { instrumentId: undefined }, { analyteId: "01900000-0000-7000-8000-0000000c9fff" }, { resultedAt: "2026-11-01T00:00:00.000Z" },
        { isCritical: true, deltaCheckFailed: true, instrumentFlags: ["H", "E"] },
      ];
      for (const v of variants) {
        const r = await h.impl.canAutoVerify(ctx(), { ...good(), ...v });
        expect(r.decision, JSON.stringify(v)).toBe("deny");
        expect(r.reasons.length, JSON.stringify(v)).toBeGreaterThan(0);
      }
    });
    it("(12) other tenant's plan invisible → no_qc_data [phase1Stub]", async () => {
      await h.seed({ qcPlans: [{ ...plan([{ runId: R_OK, at: "2026-11-05T02:00:00.000Z", outcome: "accepted" }]), tenantId: B }] });
      const q = await h.impl.qcStatusFor(ctx(), { instrumentId: IN, analyteId: AN, at: NOW });
      expect(q.status).toBe("no_qc_data");
    });
  });
}
