// packages/fakes/src/SmartReportPort.fake.ts — C14 SmartReportPort fake (IC §4.10). Default = Phase-1 behaviour: every tenant
// has smart reports disabled (smartreport.feature_disabled). A summary that a pathologist has not approved is returned with
// status 'draft' (D-111). Summaries are built deterministically from the seeded approved result set of each order.
import type { SmartReportPort, SmartSummary, BandStatus } from "@lims/contracts/ports/SmartReportPort";
import { TENANT_A, TENANT_B, err, forbidden, idFor, isStaffOrSystem, makeFake, notFound, sha256Hex, tenantOf, type FakeOpts } from "./base";

export interface SmartResultFixture {
  resultId: string; analyteId: string; analyteName: string; panelCode: string; valueNumeric: string;
  refLow?: string; refHigh?: string; unitCode?: string; flag: "N" | "L" | "H" | "LL" | "HH" | "A";
}
export interface SmartReportFixtures {
  tenants: Record<string, { enabled: boolean; libraryApproved: boolean; libraryVersion: string; minGroupsScored: number }>;
  /** `results` = the order's LabPort approved set; `approvedSetHash` changes on amendment. */
  orders: { id: string; tenantId: string; patientId: string; reportVersionNo: number; approvedSetHash: string;
            reviewStatus: "pending" | "approved" | "rejected"; approvedByMembershipId?: string; approvedAt?: string; results: SmartResultFixture[] }[];
  history: { resultId: string; tenantId: string; patientId: string; analyteId: string; approvedAt: string; valueNumeric: string }[];
  followUpRules: { id: string; tenantId: string; analyteId: string; direction: "low" | "high" | "abnormal"; suggestedTestCode: string; suggestedTestName?: string; intervalDays: number }[];
}

const defaults = (seed: number): SmartReportFixtures => {
  const t = (enabled = false) => ({ enabled, libraryApproved: true, libraryVersion: "lib-2026.1", minGroupsScored: 2 });
  return {
    tenants: { [TENANT_A]: t(), [TENANT_B]: t() },
    orders: [TENANT_A, TENANT_B].map((tenantId, i) => ({
      id: idFor(seed, 0x10 + i), tenantId, patientId: idFor(seed, 0x20 + i), reportVersionNo: 1, approvedSetHash: `synthetic-hash-${i}`,
      reviewStatus: "pending" as const,
      results: [
        { resultId: idFor(seed, 0x30 + i), analyteId: idFor(seed, 0x40), analyteName: "Haemoglobin", panelCode: "CBC", valueNumeric: "10.1", refLow: "12.0", refHigh: "15.5", unitCode: "g_dl", flag: "L" as const },
        { resultId: idFor(seed, 0x32 + i), analyteId: idFor(seed, 0x41), analyteName: "Fasting glucose", panelCode: "GLUCOSE", valueNumeric: "92", refLow: "70", refHigh: "110", unitCode: "mg_dl", flag: "N" as const },
      ],
    })),
    history: [],
    followUpRules: [],
  };
};

const SEVERITY: Record<string, BandStatus> = { N: "in_range", L: "out_of_range", H: "out_of_range", A: "out_of_range", LL: "critical", HH: "critical" };
const DIRECTION = { L: "low", LL: "low", H: "high", HH: "high", A: "abnormal" } as const;
const RANK: BandStatus[] = ["in_range", "borderline", "out_of_range", "critical"];
const uuidFromHex = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;

export function createFakeSmartReportPort(opts: FakeOpts<SmartReportFixtures>) {
  return makeFake(defaults, opts, ({ fixtures, seed }) => {
    const block = (n: number) => idFor(seed, 0x500 + n);
    const port: SmartReportPort = {
      async buildSummary(ctx, input) {
        const tenantId = tenantOf(ctx);
        if (!isStaffOrSystem(ctx)) throw forbidden();            // staff/system only (08 A2.3)
        const t = fixtures.tenants[tenantId];
        if (!t?.enabled) throw err("smartreport.feature_disabled");
        const o = fixtures.orders.find((x) => x.tenantId === tenantId && x.id === input.orderId);
        if (!o) throw notFound();
        if (!t.libraryApproved) throw err("smartreport.template_not_approved");
        if (o.results.length === 0) throw err("smartreport.no_eligible_results");

        const deranged = o.results.filter((r) => r.flag !== "N").map((r) => {
          const direction = DIRECTION[r.flag as keyof typeof DIRECTION];
          return {
            resultId: r.resultId, analyteId: r.analyteId, direction, severity: SEVERITY[r.flag]!, templateBlockId: block(direction === "low" ? 1 : direction === "high" ? 2 : 3),
            text: `${r.analyteName} is ${direction === "abnormal" ? "abnormal" : direction} (${r.valueNumeric}; reference ${r.refLow ?? ""}–${r.refHigh ?? ""}).`,
            analyteName: r.analyteName,
          };
        });
        const codes = [...new Set(o.results.map((r) => r.panelCode))].sort();
        const panels = codes.map((panelCode) => {
          const rs = o.results.filter((r) => r.panelCode === panelCode);
          const status = rs.map((r) => SEVERITY[r.flag]!).reduce((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a), "in_range" as BandStatus);
          return { panelCode, status, resultIds: rs.map((r) => r.resultId) };
        });
        const inRange = panels.filter((p) => p.status === "in_range").length;
        const value = Math.round((100 * inRange) / panels.length);
        const followUps = fixtures.followUpRules
          .filter((f) => f.tenantId === tenantId && deranged.some((d) => d.analyteId === f.analyteId && d.direction === f.direction))
          .map((f) => ({ ruleId: f.id, suggestedTestCode: f.suggestedTestCode, intervalDays: f.intervalDays,
                         text: `Repeat this test in ${f.intervalDays} days.`, ...(f.suggestedTestName ? { suggestedTestName: f.suggestedTestName } : {}) }));
        const trends = o.results.flatMap((r) => {
          const hist = fixtures.history
            .filter((h) => h.tenantId === tenantId && h.patientId === o.patientId && h.analyteId === r.analyteId)
            .sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
          if (hist.length === 0) return [];
          const mid = r.refLow !== undefined && r.refHigh !== undefined ? (Number(r.refLow) + Number(r.refHigh)) / 2 : undefined;
          const d0 = mid === undefined ? 0 : Math.abs(Number(hist[0]!.valueNumeric) - mid), d1 = mid === undefined ? 0 : Math.abs(Number(r.valueNumeric) - mid);
          return [{ analyteId: r.analyteId, analyteName: r.analyteName, ...(r.unitCode ? { unitCode: r.unitCode } : {}),
                    direction: d1 < d0 ? "improved" as const : d1 > d0 ? "worsened" as const : "stable" as const,
                    pointResultIds: [...hist.map((h) => h.resultId), r.resultId],
                    points: hist.map((h) => ({ resultId: h.resultId, approvedAt: h.approvedAt, valueNumeric: h.valueNumeric })) }];
        });
        const summaryId = uuidFromHex(await sha256Hex(`${tenantId}|${o.id}|${o.reportVersionNo}|${o.approvedSetHash}|${t.libraryVersion}`));
        const approved = o.reviewStatus === "approved";       // internal 'rejected' and 'pending' map to 'draft'
        const s: SmartSummary = {
          summaryId, orderId: o.id, reportVersionNo: o.reportVersionNo, templateLibraryVersion: t.libraryVersion,
          status: approved ? "approved" : "draft",
          ...(approved && o.approvedByMembershipId ? { approvedByMembershipId: o.approvedByMembershipId } : {}),
          ...(approved && o.approvedAt ? { approvedAt: o.approvedAt } : {}),
          ...(panels.length >= t.minGroupsScored
            ? { healthScore: { value, band: value >= 80 ? "good" as const : value >= 50 ? "fair" as const : "needs_attention" as const, formulaVersion: "hs-1", panelsScored: panels.length } }
            : {}),
          panels, deranged,
          advice: deranged.length ? [{ templateBlockId: block(4), text: "Discuss these results with your doctor." }] : [],
          followUps, trends,
          disclaimerBlockId: block(0), language: "en",
          disclaimerText: "This summary is generated from approved results and does not replace medical advice.",
        };
        return s;
      },
    };
    return port;
  });
}
