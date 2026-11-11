// packages/fakes/contract-tests/ReportingPort.contract.ts — IC §4.7 contract cases (CV §8.4). Runs against the fake (C0) and the
// real C6 implementation. Fixture shape = ReportingFixtures (a real harness translates it).
import { describe, expect, it } from "vitest";
import type { ContractHarness } from "../src/harness";

const id = (n: number) => `01900000-0000-7000-8000-0000000c6${n.toString(16).padStart(3, "0")}`;
const O1 = id(1), O2 = id(2), O_B = id(3), PAT = id(4), P1 = id(5), P2 = id(6);
const R_SUP = id(0x11), R_UNREL = id(0x12), R_B = id(0x13), R_P1 = id(0x14), R_P2 = id(0x15);
const NOW = "2026-11-05T04:15:00.000Z";

async function rejects(p: Promise<unknown>, code: string) {
  const e: any = await p.then(() => undefined, (x) => x);
  expect(e, `expected ${code}, call resolved`).toBeDefined();
  expect(e.code).toBe(code);
}

async function setup(makeImpl: () => Promise<ContractHarness>) {
  const h = await makeImpl();
  const tA = h.ctxFor("A").tenantId, tB = h.ctxFor("B").tenantId;
  const rep = (reportId: string, o: object) => ({ tenantId: tA, reportId, versionNo: 1, orderId: O1, patientId: PAT, partnerId: null, centreId: null,
    kind: "final", status: "valid", released: true, releasedAt: "2026-11-01T04:15:00.000Z", panelNames: ["Synthetic Panel"], ...o });
  const reports = [
    rep(R_SUP, { status: "superseded" }),
    rep(R_SUP, { versionNo: 2, kind: "amended", releasedAt: "2026-11-02T04:15:00.000Z" }),
    rep(R_UNREL, { orderId: O2, released: false, releasedAt: null }),
    rep(R_B, { tenantId: tB, orderId: O_B }),
    rep(R_P1, { orderId: id(0x21), partnerId: P1 }),
    rep(R_P2, { orderId: id(0x22), partnerId: P2 }),
    ...[0, 1, 2, 3, 4].map((i) => rep(id(0x30 + i), { orderId: id(0x40 + i), releasedAt: `2026-10-0${i + 1}T04:15:00.000Z` })),
  ].map((r, i) => ({ id: id(0x100 + i), ...r }));
  await h.seed({
    reports,
    linkTtlDays: { [tA]: 45, [tB]: 60 },
    partnerOfActor: { [h.ctxFor("A:partner:p1").actor.id]: P1 },
  });
  return h;
}
const list = (h: ContractHarness, filter: object, key = "A", extra: object = {}) => h.impl.getReleasedReports(h.ctxFor(key), { filter, ...extra });

export function runReportingPortContract(makeImpl: () => Promise<ContractHarness>, opts: { phase1Stub?: boolean } = {}): void {
  // No phase stub exists for ReportingPort (08 R9): the phase1Stub subset is empty.
  describe.skipIf(!!opts.phase1Stub)("ReportingPort contract (IC §4.7)", () => {
    it("(1) unreleased report not listed", async () => {
      const h = await setup(makeImpl);
      expect((await list(h, { orderId: O2 })).items).toEqual([]);
      expect((await list(h, { patientId: PAT, includeSuperseded: true })).items.map((r: any) => r.reportId)).not.toContain(R_UNREL);
    });

    it("(2) superseded hidden by default", async () => {
      const h = await setup(makeImpl);
      const def = (await list(h, { orderId: O1 })).items;
      expect(def.map((r: any) => [r.reportId, r.versionNo, r.status])).toEqual([[R_SUP, 2, "valid"]]);
      const all = (await list(h, { orderId: O1, includeSuperseded: true })).items;
      expect(all.map((r: any) => [r.versionNo, r.status]).sort()).toEqual([[1, "superseded"], [2, "valid"]]);
    });

    it("(3) two filters → common.validation_failed", async () => {
      const h = await setup(makeImpl);
      await rejects(list(h, { orderId: O1, patientId: PAT }), "common.validation_failed");
      await rejects(list(h, {}), "common.validation_failed");
    });

    it("(4) partner sees only its orders", async () => {
      const h = await setup(makeImpl);
      expect((await list(h, { partnerId: P1 }, "A:partner:p1")).items.map((r: any) => r.reportId)).toEqual([R_P1]);
      expect((await list(h, { partnerId: P2 }, "A:partner:p1")).items).toEqual([]);
      expect((await list(h, { orderId: O1 }, "A:partner:p1")).items).toEqual([]);
      await rejects(h.impl.openReleasedReportFile(h.ctxFor("A:partner:p1"), { reportId: R_P2, versionNo: 1 }), "common.not_found");
      await expect(h.impl.openReleasedReportFile(h.ctxFor("A:partner:p1"), { reportId: R_P1, versionNo: 1 })).resolves.toMatchObject({ reportId: R_P1 });
    });

    it("(5) issuePortalLink on unreleased → reporting.report_not_released", async () => {
      const h = await setup(makeImpl);
      await rejects(h.impl.issuePortalLink(h.ctxFor("A"), { reportId: R_UNREL, channel: "sms", recipientKind: "patient" }), "reporting.report_not_released");
    });

    it("(6) expiresAt = now + tenant TTL", async () => {
      const h = await setup(makeImpl);
      const r: any = await h.impl.issuePortalLink(h.ctxFor("A", { now: () => NOW as any }), { reportId: R_SUP, channel: "sms", recipientKind: "patient" });
      expect(r.expiresAt).toBe(new Date(Date.parse(NOW) + 45 * 86_400_000).toISOString());
      expect(typeof r.linkId).toBe("string");
      expect(r.url).toMatch(/^https:\/\//);
    });

    it("(7) other tenant report → common.not_found", async () => {
      const h = await setup(makeImpl);
      await rejects(h.impl.issuePortalLink(h.ctxFor("A"), { reportId: R_B, channel: "sms", recipientKind: "patient" }), "common.not_found");
      await rejects(h.impl.openReleasedReportFile(h.ctxFor("A"), { reportId: R_B, versionNo: 1 }), "common.not_found");
      expect((await list(h, { orderId: O_B })).items).toEqual([]);
    });

    it("(8) pagination stable with cursor", async () => {
      const h = await setup(makeImpl);
      const all = (await list(h, { patientId: PAT })).items.map((r: any) => `${r.reportId}:${r.versionNo}`);
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const p: any = await list(h, { patientId: PAT }, "A", { limit: 2, ...(cursor ? { cursor } : {}) });
        const again: any = await list(h, { patientId: PAT }, "A", { limit: 2, ...(cursor ? { cursor } : {}) });
        expect(again).toEqual(p);
        expect(p.items.length).toBeLessThanOrEqual(2);
        seen.push(...p.items.map((r: any) => `${r.reportId}:${r.versionNo}`));
        cursor = p.nextCursor;
      } while (cursor);
      expect(seen).toEqual(all);
      expect(all.length).toBeGreaterThan(4);
    });
  });
}
