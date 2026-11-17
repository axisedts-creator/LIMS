// packages/fakes/contract-tests/SmartReportPort.contract.ts — IC §4.10 contract cases (CV §8.4). Runs against the fake, the
// phase stub (`phase1Stub` subset: cases tagged [phase1Stub]) and the real C14 implementation.
// D-111: buildSummary never throws smartreport.summary_not_ready; a summary not yet approved is returned with status 'draft'.
import { beforeEach, describe, expect, it } from "vitest";
import type { ContractHarness } from "../src/harness";

type MakeImpl = () => Promise<ContractHarness>;
const id = (n: number) => `01900000-0000-7000-8000-0000000c14${n.toString(16).padStart(2, "0")}`;
const O1 = id(1), O_B = id(2), O_EMPTY = id(3), P1 = id(4), P2 = id(5);
const AN_HB = id(6), AN_WBC = id(7), AN_GLU = id(8);
const R1 = id(9), R2 = id(10), R3 = id(11), H1 = id(12), H2 = id(13), RULE = id(14);

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e: any) { return e?.code ?? "non_lims_error"; }
}

export function runSmartReportPortContract(makeImpl: MakeImpl, opts: { phase1Stub?: boolean } = {}): void {
  // Cases without the [phase1Stub] tag need a Phase-2–3 implementation and are skipped for the stub.
  const full = (fn: () => Promise<void>) => async (t: { skip: () => void }) => { if (opts.phase1Stub) return t.skip(); await fn(); };

  describe("SmartReportPort contract (IC §4.10)", () => {
    let h: ContractHarness;
    let A: string, B: string;
    beforeEach(async () => { h = await makeImpl(); A = h.ctxFor("A").tenantId; B = h.ctxFor("B").tenantId; });
    const ctx = () => h.ctxFor("A:system");
    const results = (hbValue = "9.8") => [
      { resultId: R1, analyteId: AN_HB, analyteName: "Haemoglobin", panelCode: "CBC", valueNumeric: hbValue, refLow: "12.0", refHigh: "15.5", unitCode: "g_dl", flag: "L" },
      { resultId: R2, analyteId: AN_WBC, analyteName: "White cell count", panelCode: "CBC", valueNumeric: "7.2", refLow: "4.0", refHigh: "11.0", flag: "N" },
      { resultId: R3, analyteId: AN_GLU, analyteName: "Fasting glucose", panelCode: "GLUCOSE", valueNumeric: "182", refLow: "70", refHigh: "110", unitCode: "mg_dl", flag: "H" },
    ];
    const order = (over: object = {}) => ({ id: O1, tenantId: A, patientId: P1, reportVersionNo: 1, approvedSetHash: "hash-v1", reviewStatus: "pending", results: results(), ...over });
    const tenant = (over: object = {}) => ({ enabled: true, libraryApproved: true, libraryVersion: "lib-2026.1", minGroupsScored: 2, ...over });
    const seed = (o: { tenant?: object; orders?: object[] } = {}) => h.seed({
      tenants: { [A]: tenant(o.tenant) },
      orders: o.orders ?? [order()],
      history: [
        { resultId: H1, tenantId: A, patientId: P1, analyteId: AN_HB, approvedAt: "2026-08-01T04:00:00.000Z", valueNumeric: "10.5" },
        { resultId: H2, tenantId: A, patientId: P2, analyteId: AN_HB, approvedAt: "2026-09-01T04:00:00.000Z", valueNumeric: "13.0" },
      ],
      followUpRules: [{ id: RULE, tenantId: A, analyteId: AN_GLU, direction: "high", suggestedTestCode: "HBA1C", intervalDays: 90 }],
    });
    const build = (orderId = O1, c = ctx()) => h.impl.buildSummary(c, { orderId, version: 1 });

    it("(1) no approved results → smartreport.no_eligible_results", full(async () => {
      await seed({ orders: [order({ id: O_EMPTY, results: [] })] });
      expect(await codeOf(build(O_EMPTY))).toBe("smartreport.no_eligible_results");
    }));
    it("(2) determinism across calls", full(async () => {
      await seed();
      expect(await build()).toEqual(await build());
    }));
    it("(3) every deranged entry references a resultId present in the LabPort approved set", full(async () => {
      await seed();
      const s = await build();
      expect(s.deranged.length).toBeGreaterThan(0);
      for (const d of s.deranged) expect([R1, R2, R3]).toContain(d.resultId);
    }));
    it("(4) disabled tenant → smartreport.feature_disabled [phase1Stub]", async () => {
      await seed({ tenant: { enabled: false } });
      expect(await codeOf(build())).toBe("smartreport.feature_disabled");
    });
    it("(5) other tenant order → not_found", full(async () => {
      await seed({ orders: [order(), order({ id: O_B, tenantId: B })] });
      await h.seed({ tenants: { [A]: tenant(), [B]: tenant() } });
      expect(await codeOf(build(O_B))).toBe("common.not_found");
    }));
    it("(6) library not approved → smartreport.template_not_approved", full(async () => {
      await seed({ tenant: { libraryApproved: false } });
      expect(await codeOf(build())).toBe("smartreport.template_not_approved");
    }));
    it("(7) amendment changes approvedSetHash → new summaryId, old one never returned", full(async () => {
      await seed();
      const old = (await build()).summaryId;
      await seed({ orders: [order({ approvedSetHash: "hash-v2", results: results("11.1") })] });
      const s1 = await build(), s2 = await build();
      expect(s1.summaryId).not.toBe(old);
      expect(s2.summaryId).toBe(s1.summaryId);
    }));
    it("(10) rejected → status 'draft'; approved → 'approved'", full(async () => {
      await seed({ orders: [order({ reviewStatus: "rejected" })] });
      expect((await build()).status).toBe("draft");
      await seed({ orders: [order({ reviewStatus: "approved", approvedByMembershipId: id(15), approvedAt: "2026-11-05T04:00:00.000Z" })] });
      expect((await build()).status).toBe("approved");
    }));
    it("(11) healthScore omitted when panelsScored < min_groups_scored", full(async () => {
      await seed({ tenant: { minGroupsScored: 3 } });             // two panels (CBC, GLUCOSE)
      expect((await build()).healthScore).toBeUndefined();
      await seed({ tenant: { minGroupsScored: 2 } });
      expect((await build()).healthScore?.panelsScored).toBe(2);
    }));
    it("(12) property: no text contains a digit except digits from value, ref_range or interval_days placeholders", full(async () => {
      await seed();
      const s = await build();
      const allowed = [...results().flatMap((r) => [r.valueNumeric, r.refLow, r.refHigh]), "90"].sort((a, b) => b.length - a.length);
      const texts = [...s.deranged, ...s.advice, ...s.followUps].map((x) => x.text);
      expect(texts.length).toBeGreaterThan(0);
      for (const t of texts) {
        let rest = t;
        for (const a of allowed) rest = rest.split(a).join("");
        expect(rest, t).not.toMatch(/\d/);
      }
    }));
    it("(13) followUps[].intervalDays equal the rule data", full(async () => {
      await seed();
      const s = await build();
      expect(s.followUps.map((f) => [f.ruleId, f.intervalDays])).toEqual([[RULE, 90]]);
    }));
    it("(14) every trends[].pointResultIds element belongs to the same patient", full(async () => {
      await seed();
      const s = await build();
      const own = new Set([R1, R2, R3, H1]);
      expect(s.trends.length).toBeGreaterThan(0);
      for (const t of s.trends) for (const p of t.pointResultIds) expect(own.has(p), p).toBe(true);
      expect(JSON.stringify(s.trends)).not.toContain(H2);
    }));
    it("(D-111) never throws smartreport.summary_not_ready; an unapproved summary is returned as draft [phase1Stub]", async () => {
      await seed({ orders: [order({ reviewStatus: "pending" })] });
      for (const c of [h.ctxFor("A:system"), h.ctxFor("A:user")]) {
        let s: any, code: string | undefined;
        try { s = await build(O1, c); } catch (e: any) { code = e?.code; }
        expect(code).not.toBe("smartreport.summary_not_ready");
        if (code === undefined) expect(s.status).toBe("draft");
      }
    });
  });
}
