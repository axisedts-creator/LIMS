// packages/fakes/contract-tests/LabPort.contract.ts — IC §4.5 contract cases (1)–(36) (CV §8.4). Implementation-agnostic:
// runs against the C0 fake and against C5's real LabPort; the real-impl harness maps `seed(fixtures)` onto its own tables.
// LabPort has no phase stub (08 R9): with `phase1Stub` nothing runs.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ContractHarness } from "../src/harness";

type MakeImpl = () => Promise<ContractHarness>;
const L = (n: number) => `01900000-0000-7000-8000-${(0xc000 + n).toString(16).padStart(12, "0")}`;

// ---- ids (synthetic)
const P1 = L(1), P2 = L(2), PB = L(3), CEN = L(4), CENB = L(5), INS1 = L(6), DEP = L(7), T1 = L(8), TM = L(9), TA = L(10);
const AN1 = L(11), AN2 = L(12), AN3 = L(13), ANM = L(14);
const O1 = L(21), O2 = L(22), O3 = L(23), O4 = L(24), O5 = L(25), O6 = L(26), O7 = L(27), OB = L(28);
const I1 = L(31), I2 = L(32), I3 = L(33), I4 = L(34), I5 = L(35), I6 = L(36), I7 = L(37), I8 = L(38), I10 = L(40), I11 = L(41), I12 = L(42), IB = L(43);
const S1 = L(51), S2 = L(52), S3 = L(53), S4 = L(54), S5 = L(55), SB = L(56);
const R1 = L(61), R2 = L(62), R3 = L(63), R4 = L(64), R5 = L(65), R6 = L(66), R7 = L(67), R8 = L(68), R9 = L(69), R10 = L(70), R11 = L(71), R13 = L(73), RB = L(74);
const M1 = L(81), M2 = L(82), M3 = L(83);
const NOW = "2026-11-05T04:15:00.000Z";

function fixtures(h: ContractHarness) {
  const A = h.ctxFor("A").tenantId, B = h.ctxFor("B").tenantId;
  const ord = (id: string, patientId: string, tenantId = A, centreId = CEN) =>
    ({ id, tenantId, patientId, centreId, priority: "routine", patient: { sex: "female", ageDays: 12000 } });
  const item = (id: string, orderId: string, workflowType = "standard", testId = T1, extra = {}) =>
    ({ id, tenantId: A, orderId, testId, departmentId: DEP, workflowType, ...extra });
  const spec = (id: string, orderId: string, barcode: string, status: string, itemIds: string[], extra = {}) =>
    ({ id, tenantId: A, orderId, barcode, specimenTypeCode: "BLOOD", status, itemIds, isActive: status !== "rejected", version: 1,
       ...(status === "received" ? { receivedAt: "2026-11-05T02:00:00.000Z" } : {}), ...extra });
  const res = (id: string, orderItemId: string, analyteId: string, status: string, extra: Record<string, unknown> = {}) =>
    ({ id, tenantId: A, orderItemId, testId: T1, analyteId, versionNo: 1, status, origin: "manual", commentCodes: [], attachments: [],
       onHold: false, qcReviewRequired: false, ...(status === "approved" ? { approvedAt: "2026-11-01T05:00:00.000Z" } : {}), ...extra });
  const modRef = (module: string, entityId: string) => ({ module, entityId, versionNo: 1 });
  return {
    grants: {
      [h.ctxFor("A:user:reader").actor.id]: ["lab.result.read"],
      [h.ctxFor("A:user:amender").actor.id]: ["lab.result.amend", "lab.result.read"],
      [h.ctxFor("A:user:spec").actor.id]: ["lab.specimen.read"],
      [h.ctxFor("A:user:hc").actor.id]: ["homecollection.visit.read"],
    },
    orders: [ord(O1, P1), ord(O2, P1), ord(O3, P1), ord(O4, P1), ord(O5, P2), ord(O6, P1), ord(O7, P2), ord(OB, PB, B, CENB)],
    items: [
      item(I1, O1), item(I2, O2), item(I3, O3), item(I4, O4),
      item(I5, O5, "microbiology", TM), item(I6, O5, "anatomic", TA), item(I7, O5, "microbiology", TM), item(I8, O5, "microbiology", TM),
      item(I10, O6, "standard", T1, { reportedAt: "2026-11-02T00:00:00.000Z" }), item(I11, O6, "standard", T1, { reportedAt: "2026-11-02T00:00:00.000Z" }),
      item(I12, O7), { ...item(IB, OB), tenantId: B },
    ],
    specimens: [
      spec(S1, O1, "SYN-0001", "received", [I1]), spec(S2, O2, "SYN-0002", "received", [I2]), spec(S3, O3, "SYN-0003", "rejected", [I3]),
      spec(S4, O4, "SYN-0004-OLD", "rejected", [I4]), spec(S5, O4, "SYN-0004-NEW", "received", [I4], { replacesSpecimenId: S4 }),
      { ...spec(SB, OB, "SYN-B-0001", "received", [IB]), tenantId: B },
    ],
    results: [
      res(R1, I1, AN1, "approved", { valueNumeric: "13.40", instrumentId: INS1, resultedAt: "2026-11-04T01:00:00.000Z" }),
      res(R2, I1, AN2, "resulted", { valueNumeric: "7.10", instrumentId: INS1, resultedAt: "2026-11-05T01:00:00.000Z" }),
      res(R3, I2, AN1, "pending"), res(R4, I2, AN2, "approved", { valueNumeric: "6.00" }), res(R5, I2, AN3, "cancelled"),
      res(R6, I3, AN1, "cancelled"), res(R13, I4, AN1, "pending"),
      res(R7, I5, ANM, "pending", { testId: TM }),
      res(R8, I6, ANM, "approved", { testId: TA, origin: "module", moduleRef: modRef("anatomic", M2), lastPhase: "final", lastPayloadVersion: 1 }),
      res(R9, I7, ANM, "approved", { testId: TM, origin: "module", moduleRef: modRef("micro", M1), lastPhase: "preliminary", lastPayloadVersion: 1 }),
      res(R10, I8, ANM, "verified", { testId: TM, origin: "module", moduleRef: modRef("micro", M3), lastPhase: "final", lastPayloadVersion: 1,
        verifiedAt: "2026-11-04T00:00:00.000Z", verifiedByMembershipId: L(90) }),
      res(R11, I12, AN1, "approved", { valueNumeric: "11.00", approvedAt: "2026-11-03T05:00:00.000Z" }),
      { ...res(RB, IB, AN1, "pending"), tenantId: B },
    ],
    mappings: [AN1, AN2, AN3].map((analyteId, n) => ({ id: L(100 + n), tenantId: A, instrumentId: INS1, instrumentCode: `C${n}`, analyteId, testId: T1 })),
    criticalLimits: [{ id: L(110), tenantId: A, analyteId: AN2, low: "2.0", high: "30.0" }],
    qcHolds: [],
  };
}

const ingestInput = (barcode: string, analyteId: string | undefined, valueNumeric: string, extra: Record<string, unknown> = {}) => ({
  instrumentMessageId: L(120), instrumentId: INS1, agentId: L(121), centreId: CEN, protocol: "astm", sampleBarcode: barcode,
  recordKind: "quantitative", instrumentAnalyteCode: `X-${analyteId ?? "none"}`, mappingStatus: analyteId ? "mapped" : "unmapped",
  ...(analyteId ? { analyteId, testId: T1 } : {}), valueNumeric, instrumentResultTime: "2026-11-05T04:00:00.000Z", receivedAt: NOW, ...extra,
});
const moduleInput = (orderItemId: string, module: "micro" | "anatomic", entityId: string, versionNo: number, extra: Record<string, unknown> = {}) => ({
  orderItemId, kind: "narrative", reportPhase: "final", payloadRef: { module, entityId, versionNo }, summaryText: "Synthetic summary",
  submittedAt: NOW, idempotencyKey: `${module}:${entityId}:${versionNo}`, ...extra,
});

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e: any) { return e?.code; }
}
const resultIn = (or: any, resultId: string) => or.items.flatMap((i: any) => i.results).find((r: any) => r.resultId === resultId);

export function runLabPortContract(makeImpl: MakeImpl, opts: { phase1Stub?: boolean } = {}): void {
  const setup = async () => { const h = await makeImpl(); await h.seed(fixtures(h)); return h; };
  const sys = (h: ContractHarness) => h.ctxFor("A:system");

  describe.skipIf(!!opts.phase1Stub)("LabPort contract (IC §4.5)", () => {
    it("(1) approved scope hides unverified results", async () => {
      const h = await setup();
      const r = await h.impl.getOrderResults(h.ctxFor("A"), { orderId: O1, scope: "approved" });
      expect(r.items[0].results.map((x: any) => x.resultId)).toEqual([R1]);
    });

    it("(2) all_visible requires lab.result.read (else auth.forbidden)", async () => {
      const h = await setup();
      expect(await codeOf(h.impl.getOrderResults(h.ctxFor("A"), { orderId: O1, scope: "all_visible" }))).toBe("auth.forbidden");
      const r = await h.impl.getOrderResults(h.ctxFor("A:user:reader"), { orderId: O1, scope: "all_visible" });
      expect(r.items[0].results.map((x: any) => x.resultId).sort()).toEqual([R1, R2].sort());
    });

    it("(3) host query on received specimen returns its pending tests only (excludes approved/cancelled)", async () => {
      const h = await setup();
      const r = await h.impl.getPendingTestsForBarcode(h.ctxFor("A:device"), { instrumentId: INS1, barcode: "SYN-0002" });
      expect(r.specimenId).toBe(S2);
      expect(r.tests).toEqual([{ orderItemId: I2, testId: T1, analyteIds: [AN1] }]);
    });

    it("(4) unknown barcode → lab.specimen_not_found", async () => {
      const h = await setup();
      expect(await codeOf(h.impl.getPendingTestsForBarcode(h.ctxFor("A:device"), { instrumentId: INS1, barcode: "SYN-9999" }))).toBe("lab.specimen_not_found");
    });

    it("(5) rejected barcode → lab.specimen_not_receivable", async () => {
      const h = await setup();
      expect(await codeOf(h.impl.getPendingTestsForBarcode(h.ctxFor("A:device"), { instrumentId: INS1, barcode: "SYN-0003" }))).toBe("lab.specimen_not_receivable");
    });

    it("(6) ingest new → applied, status resulted", async () => {
      const h = await setup();
      const r = await h.impl.ingestInstrumentResult(h.ctxFor("A:device"), ingestInput("SYN-0002", AN1, "12.10"));
      expect(r.outcome).toBe("applied");
      expect(r.resultId).toBe(R3);
      const v = resultIn(await h.impl.getOrderResults(h.ctxFor("A:user:reader"), { orderId: O2, scope: "all_visible" }), R3);
      expect(v.status).toBe("resulted");
      expect(v.valueNumeric).toBe("12.10");
    });

    it("(7) same key → duplicate", async () => {
      const h = await setup();
      await h.impl.ingestInstrumentResult(h.ctxFor("A:device"), ingestInput("SYN-0002", AN1, "12.10"));
      const r = await h.impl.ingestInstrumentResult(h.ctxFor("A:device"), ingestInput("SYN-0002", AN1, "12.10"));
      expect(r.outcome).toBe("duplicate");
    });

    it("(8) ingest on approved → rejected_state, value unchanged", async () => {
      const h = await setup();
      const r = await h.impl.ingestInstrumentResult(h.ctxFor("A:device"), ingestInput("SYN-0001", AN1, "99.00"));
      expect(r.outcome).toBe("rejected_state");
      expect(r.reasonCode).toBe("result_locked");
      const v = resultIn(await h.impl.getOrderResults(h.ctxFor("A"), { orderId: O1, scope: "approved" }), R1);
      expect(v.valueNumeric).toBe("13.40");
    });

    it("(9) unmapped → unmatched", async () => {
      const h = await setup();
      expect((await h.impl.ingestInstrumentResult(h.ctxFor("A:device"), ingestInput("SYN-0002", undefined, "1.00"))).outcome).toBe("unmatched");
      expect((await h.impl.ingestInstrumentResult(h.ctxFor("A:device"), ingestInput("SYN-UNKNOWN", AN1, "1.00"))).outcome).toBe("unmatched");
    });

    it("(10) critical value → event spy sees lab.critical_value.detected.v1", async () => {
      const h = await setup();
      const r = await h.impl.ingestInstrumentResult(h.ctxFor("A:device"), ingestInput("SYN-0001", AN2, "1.00"));
      expect(r.outcome).toBe("applied");
      const ev = h.events.ofType("lab.critical_value.detected.v1");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.payload).toMatchObject({ result_id: R2, direction: "low", order_id: O1, patient_id: P1 });
    });

    it("(11) holdResultsSince twice same qcRunId → same lists, no double flagging", async () => {
      const h = await setup();
      const input = { instrumentId: INS1, analyteIds: [AN1, AN2], since: "2026-11-01T00:00:00.000Z", qcRunId: L(130), reasonCode: "qc_failure" };
      const a = await h.impl.holdResultsSince(sys(h), input);
      const b = await h.impl.holdResultsSince(sys(h), input);
      expect(a).toEqual({ heldResultIds: [R2], reviewFlaggedResultIds: [R1] });
      expect(b).toEqual(a);
      const or = await h.impl.getOrderResults(sys(h), { orderId: O1, scope: "all_visible" });
      expect(resultIn(or, R2).onHold).toBe(true);
      expect(resultIn(or, R1).qcReviewRequired).toBe(true);
    });

    it("(12) other tenant barcode → not found in this tenant (lab.specimen_not_found) [CONV]", async () => {
      const h = await setup();
      expect(await codeOf(h.impl.getPendingTestsForBarcode(h.ctxFor("A:device"), { instrumentId: INS1, barcode: "SYN-B-0001" }))).toBe("lab.specimen_not_found");
      expect(await codeOf(h.impl.getOrderResults(h.ctxFor("A"), { orderId: OB, scope: "approved" }))).toBe("common.not_found");
    });

    it("(13) approvedSetHash stable across calls and changes after amendment (SHA-256 of sorted result_id:version_no)", async () => {
      const h = await setup();
      const a = await h.impl.getOrderResults(h.ctxFor("A"), { orderId: O5, scope: "approved" });
      const b = await h.impl.getOrderResults(h.ctxFor("A"), { orderId: O5, scope: "approved" });
      expect(a.approvedSetHash).toBe(b.approvedSetHash);
      expect(a.approvedSetHash).toBe(createHash("sha256").update([`${R8}:1`, `${R9}:1`].sort().join("\n")).digest("hex"));
      await h.impl.submitModuleResult(h.ctxFor("A:user:amender"), moduleInput(I7, "micro", M1, 2, { amendment: { reasonCode: "correction" } }));
      const c = await h.impl.getOrderResults(h.ctxFor("A"), { orderId: O5, scope: "approved" });
      expect(c.approvedSetHash).not.toBe(a.approvedSetHash);
      expect(c.approvedSetHash).toBe(createHash("sha256").update([`${R8}:1`, `${R9}:2`].sort().join("\n")).digest("hex"));
    });

    it("(14) submitModuleResult new → resulted, origin module", async () => {
      const h = await setup();
      const r = await h.impl.submitModuleResult(sys(h), moduleInput(I5, "micro", L(140), 1));
      expect(r).toMatchObject({ resultId: R7, status: "resulted", replayed: false });
      expect(resultIn(await h.impl.getOrderResults(sys(h), { orderId: O5, scope: "all_visible" }), R7).origin).toBe("module");
    });

    it("(15) replay with same idempotencyKey → replayed: true, same resultId/versionNo", async () => {
      const h = await setup();
      const a = await h.impl.submitModuleResult(sys(h), moduleInput(I5, "micro", L(140), 1));
      const b = await h.impl.submitModuleResult(sys(h), moduleInput(I5, "micro", L(140), 1));
      expect(b.replayed).toBe(true);
      expect([b.resultId, b.versionNo]).toEqual([a.resultId, a.versionNo]);
    });

    it("(16) lower payloadRef.versionNo → lab.module_result_stale", async () => {
      const h = await setup();
      await h.impl.submitModuleResult(sys(h), moduleInput(I5, "micro", L(140), 3));
      expect(await codeOf(h.impl.submitModuleResult(sys(h), moduleInput(I5, "micro", L(140), 2)))).toBe("lab.module_result_stale");
    });

    it("(17) submission on approved result without lab.result.amend → lab.result_locked; with it → version n+1 + lab.result.amended.v1", async () => {
      const h = await setup();
      const input = moduleInput(I7, "micro", M1, 2, { amendment: { reasonCode: "correction" } });
      expect(await codeOf(h.impl.submitModuleResult(h.ctxFor("A"), input))).toBe("lab.result_locked");
      const r = await h.impl.submitModuleResult(h.ctxFor("A:user:amender"), input);
      expect(r.versionNo).toBe(2);
      expect(h.events.ofType("lab.result.amended.v1")).toHaveLength(1);
      expect(h.events.ofType("lab.result.amended.v1")[0]!.payload).toMatchObject({ result_id: R9, previous_version_no: 1, new_version_no: 2 });
    });

    it("(18) orderItem whose test workflowType is not microbiology/anatomic/molecular → lab.module_result_invalid", async () => {
      const h = await setup();
      expect(await codeOf(h.impl.submitModuleResult(sys(h), moduleInput(I1, "micro", L(141), 1)))).toBe("lab.module_result_invalid");
    });

    it("(19) isCritical: true → lab.critical_value.detected.v1 with direction abnormal", async () => {
      const h = await setup();
      await h.impl.submitModuleResult(sys(h), moduleInput(I5, "micro", L(140), 1, { isCritical: true }));
      const ev = h.events.ofType("lab.critical_value.detected.v1");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.payload).toMatchObject({ result_id: R7, direction: "abnormal" });
    });

    it("(20) other tenant's order item → not_found", async () => {
      const h = await setup();
      expect(await codeOf(h.impl.submitModuleResult(sys(h), moduleInput(IB, "micro", L(142), 1)))).toBe("common.not_found");
    });

    it("(21) replay of an unmatched key after the fix → applied, exception closed (CR-C7-011)", async () => {
      const h = await setup();
      const key = { instrumentAnalyteCode: "X-FIXED" };
      expect((await h.impl.ingestInstrumentResult(h.ctxFor("A:device"), ingestInput("SYN-0002", undefined, "12.10", key))).outcome).toBe("unmatched");
      const r = await h.impl.ingestInstrumentResult(h.ctxFor("A:device"), ingestInput("SYN-0002", AN1, "12.10", { ...key, processingKind: "rematch" }));
      expect(r.outcome).toBe("applied");
      expect((await h.impl.ingestInstrumentResult(h.ctxFor("A:device"), ingestInput("SYN-0002", AN1, "12.10", key))).outcome).toBe("duplicate");
    });

    it("(22) approved + amendment → event carries the code; approved without amendment → lab.amendment_reason_required", async () => {
      const h = await setup();
      expect(await codeOf(h.impl.submitModuleResult(h.ctxFor("A:user:amender"), moduleInput(I7, "micro", M1, 2)))).toBe("lab.amendment_reason_required");
      await h.impl.submitModuleResult(h.ctxFor("A:user:amender"), moduleInput(I7, "micro", M1, 2, { amendment: { reasonCode: "correction" } }));
      expect(h.events.ofType("lab.result.amended.v1")[0]!.payload.amendment_reason_code).toBe("correction");
    });

    it("(23) module_phase_progression from anatomic → lab.module_result_invalid", async () => {
      const h = await setup();
      const input = moduleInput(I6, "anatomic", M2, 2, { amendment: { reasonCode: "module_phase_progression" } });
      expect(await codeOf(h.impl.submitModuleResult(h.ctxFor("A:user:amender"), input))).toBe("lab.module_result_invalid");
    });

    it("(24) approved scope returns barcode", async () => {
      const h = await setup();
      const r = await h.impl.getOrderResults(h.ctxFor("A"), { orderId: O1, scope: "approved" });
      expect(r.specimens).toEqual([expect.objectContaining({ specimenId: S1, barcode: "SYN-0001" })]);
    });

    it("(25) module result returns moduleRef", async () => {
      const h = await setup();
      const r = await h.impl.getOrderResults(h.ctxFor("A"), { orderId: O5, scope: "approved" });
      expect(resultIn(r, R9).moduleRef).toEqual({ module: "micro", entityId: M1, versionNo: 1 });
    });

    it("(26) lookupSpecimens other tenant omitted / old barcode resolves to old specimen", async () => {
      const h = await setup();
      expect(await h.impl.lookupSpecimens(sys(h), { barcode: "SYN-B-0001" })).toEqual([]);
      expect(await h.impl.lookupSpecimens(sys(h), { specimenIds: [SB, S1] })).toEqual([expect.objectContaining({ specimenId: S1 })]);
      const old = await h.impl.lookupSpecimens(h.ctxFor("A:user:spec"), { barcode: "SYN-0004-OLD" });
      expect(old.map((s: any) => s.specimenId)).toEqual([S4]);
      expect(await codeOf(h.impl.lookupSpecimens(h.ctxFor("A:device"), { barcode: "SYN-0001" }))).toBe("auth.forbidden");
    });

    it("(27) {orderId} form with homecollection.visit.read", async () => {
      const h = await setup();
      const r = await h.impl.lookupSpecimens(h.ctxFor("A:user:hc"), { orderId: O1 });
      expect(r).toEqual([expect.objectContaining({ specimenId: S1, orderId: O1, patientId: P1, barcode: "SYN-0001" })]);
    });

    it("(28) getAnalyteHistory never returns another patient's results", async () => {
      const h = await setup();
      const r = await h.impl.getAnalyteHistory(sys(h), { patientId: P1, analyteIds: [AN1], before: NOW, limitPerAnalyte: 10 });
      expect(r.series).toHaveLength(1);
      expect(r.series[0].points.map((p: any) => p.resultId)).toEqual([R1]);
      const other = await h.impl.getAnalyteHistory(sys(h), { patientId: L(199), analyteIds: [AN1], before: NOW, limitPerAnalyte: 10 });
      expect(other.series[0].points).toEqual([]);
    });

    it("(29) listPendingForInstrument excludes approved/cancelled", async () => {
      const h = await setup();
      const r = await h.impl.listPendingForInstrument(h.ctxFor("A:device"), { instrumentId: INS1 });
      const s2 = r.items.find((x: any) => x.specimenId === S2);
      expect(s2.tests).toEqual([{ orderItemId: I2, testId: T1, analyteIds: [AN1] }]);
      expect(r.items.map((x: any) => x.specimenId)).not.toContain(S1);
      expect(r.items.map((x: any) => x.specimenId)).not.toContain(SB);
    });

    it("(30) getOrderItemProcessingState: received specimen → removable: false", async () => {
      const h = await setup();
      const r = await h.impl.getOrderItemProcessingState(sys(h), { orderId: O1 });
      expect(r).toEqual([{ orderItemId: I1, removable: false, reasonCode: "specimen_received", processingStatus: "in_progress" }]);
    });

    it("(31) item whose only specimen is rejected without recollection → removable: true, processingStatus: cancelled (D-5)", async () => {
      const h = await setup();
      const r = await h.impl.getOrderItemProcessingState(sys(h), { orderId: O3 });
      expect(r).toEqual([expect.objectContaining({ orderItemId: I3, removable: true, processingStatus: "cancelled" })]);
    });

    it("(32) all items reported → reported (D-5)", async () => {
      const h = await setup();
      const r = await h.impl.getOrderItemProcessingState(sys(h), { orderId: O6 });
      expect(r.map((x: any) => x.processingStatus)).toEqual(["reported", "reported"]);
    });

    it("(33) submitModuleResult resubmission on verified → resulted, verification cleared (D-7)", async () => {
      const h = await setup();
      const r = await h.impl.submitModuleResult(sys(h), moduleInput(I8, "micro", M3, 2));
      expect(r.status).toBe("resulted");
      const v = resultIn(await h.impl.getOrderResults(sys(h), { orderId: O5, scope: "all_visible" }), R10);
      expect(v.status).toBe("resulted");
      expect(v.verifiedAt).toBeUndefined();
    });

    it("(34) versionNo = 1 before approval, n+1 after amendment (D-7)", async () => {
      const h = await setup();
      expect((await h.impl.submitModuleResult(sys(h), moduleInput(I5, "micro", L(140), 1))).versionNo).toBe(1);
      expect((await h.impl.submitModuleResult(sys(h), moduleInput(I5, "micro", L(140), 2))).versionNo).toBe(1);
      const am = await h.impl.submitModuleResult(h.ctxFor("A:user:amender"), moduleInput(I7, "micro", M1, 2, { amendment: { reasonCode: "correction" } }));
      expect(am.versionNo).toBe(2);
    });

    it("(35) micro preliminary over an approved preliminary with module_preliminary_update → version n+1, event carries the code", async () => {
      const h = await setup();
      const r = await h.impl.submitModuleResult(h.ctxFor("A:user:amender"),
        moduleInput(I7, "micro", M1, 2, { reportPhase: "preliminary", amendment: { reasonCode: "module_preliminary_update" } }));
      expect(r.versionNo).toBe(2);
      expect(h.events.ofType("lab.result.amended.v1")[0]!.payload.amendment_reason_code).toBe("module_preliminary_update");
    });

    it("(36) module_preliminary_update with reportPhase final or from anatomic → lab.module_result_invalid", async () => {
      const h = await setup();
      const amender = h.ctxFor("A:user:amender");
      const amendment = { reasonCode: "module_preliminary_update" };
      expect(await codeOf(h.impl.submitModuleResult(amender, moduleInput(I7, "micro", M1, 2, { reportPhase: "final", amendment })))).toBe("lab.module_result_invalid");
      expect(await codeOf(h.impl.submitModuleResult(amender, moduleInput(I6, "anatomic", M2, 2, { reportPhase: "preliminary", amendment })))).toBe("lab.module_result_invalid");
      expect(h.events.ofType("lab.result.amended.v1")).toHaveLength(0);
    });
  });
}
