// packages/fakes/contract-tests/CatalogPort.contract.ts — IC §4.2 contract cases (1)–(31) + A24.1 getPriceListStatus.
// Runs against the fake (C0) and the real C3 implementation (CV §8.4). Fixtures below are seeded through `h.seed`.
import { describe, expect, it } from "vitest";
import type { ContractHarness } from "../src/harness";

type MakeImpl = () => Promise<ContractHarness>;

const TA = "01900000-0000-7000-8000-00000000000a";
const TB = "01900000-0000-7000-8000-00000000000b";
const X = (n: number) => `01900000-0000-7000-8000-0000000c${n.toString(16).padStart(4, "0")}`;
const NOW = "2026-11-05T04:15:00.000Z";
const EPOCH = "2026-01-01T00:00:00.000Z";

const DEP_H = X(1), DEP_B = X(2);
const AN_HB = X(10), AN_TXT = X(11), AN_ORD = X(12), AN_UM = X(13);
const T_G = X(20), T_A1 = X(21), T_B1 = X(22), T_INACT = X(23), T_X2 = X(24), T_NP = X(25);
const P1 = X(30), P3 = X(31), PC1 = X(32), PC2 = X(33);
const RR_NEO = X(40), RR_ADULT = X(41), RR_TXT = X(42), RR_ORD = X(43), RR_UM = X(44);
const CL_HB = X(50), CL_ORD = X(51);
const INST = X(60), MAP1 = X(61);
const PL_EXPL = X(70), PL_CP = X(71), PL_REF = X(72), PL_CEN = X(73), PL_DEF = X(74), PL_INACT = X(75), PL_DRAFT = X(76);
const REF1 = X(80), REF_M = X(81), CP1 = X(82), CEN1 = X(83);
const CC1 = X(90), CC1H = X(91), CC2 = X(92);

const analyte = (id: string, code: string, extra: object = {}) => ({ id, code, name: `Suite ${code}`, resultType: "numeric", reportable: true, sortOrder: 1, ...extra });
const test = (id: string, tenantId: string | null, code: string, extra: object = {}) => ({
  id, tenantId, code, name: `Suite Test ${code}`, departmentId: DEP_B, departmentCode: "SBIO", specimenTypeCodes: ["blood"], containerCode: "edta",
  workflowType: "standard", analytes: [analyte(X(200 + Number.parseInt(id.slice(-4), 16)), `${code}_A`)], isActive: true, revision: 1, ...extra,
});
const range = (id: string, rrId: string, version: number, effectiveFrom: string, analyteId: string, extra: object) =>
  ({ id, tenantId: null, referenceRangeId: rrId, version, effectiveFrom, analyteId, kind: "numeric", ...extra });
const list = (id: string, scope: string, pricePaisa: number, extra: object = {}) => ({
  id, tenantId: TA, code: `SUITE_${id.slice(-3)}`, isActive: true, scope, versions: [{ version: 1, status: "published", effectiveFrom: EPOCH }],
  prices: [{ orderableId: T_G, unitPricePaisa: pricePaisa }, { orderableId: T_X2, unitPricePaisa: pricePaisa + 1 }], ...extra,
});

const FIX = {
  departments: [
    { id: DEP_H, tenantId: null, code: "SHAEM", name: "Suite Haematology" },
    { id: DEP_B, tenantId: null, code: "SBIO", name: "Suite Biochemistry" },
  ],
  tests: [
    test(T_G, null, "SCBC", {
      departmentId: DEP_H, departmentCode: "SHAEM",
      analytes: [
        analyte(AN_HB, "SHB", { unitCode: "g/dL" }),
        analyte(AN_TXT, "SHIV", { resultType: "text" }),
        analyte(AN_ORD, "SUPRO", { resultType: "ordinal", ordinalSetCode: "SUITE_ORD" }),
        analyte(AN_UM, "SALB", { unitCode: "g/L" }),
      ],
    }),
    test(T_A1, TA, "SA1"), test(T_B1, TB, "SB1"), test(T_INACT, null, "SOLD", { isActive: false }), test(T_X2, null, "SX2"), test(T_NP, null, "SNP"),
  ],
  panels: [
    { id: P1, tenantId: null, code: "SP1", name: "Suite Panel 1", panelKind: "clinical", members: [{ kind: "test", id: T_G }, { kind: "test", id: T_X2 }], isActive: true, revision: 1 },
    { id: P3, tenantId: null, code: "SP3", name: "Suite Panel 3", panelKind: "package", sexRestriction: "female", members: [{ kind: "test", id: T_G }], isActive: true, revision: 1 },
    { id: PC1, tenantId: null, code: "SPC1", name: "Suite Cycle 1", panelKind: "clinical", members: [{ kind: "panel", id: PC2 }], isActive: true, revision: 1 },
    { id: PC2, tenantId: null, code: "SPC2", name: "Suite Cycle 2", panelKind: "clinical", members: [{ kind: "panel", id: PC1 }], isActive: true, revision: 1 },
  ],
  valueSets: [{ id: X(100), tenantId: null, code: "SUITE_ORD", values: [
    { code: "2+", display: "2+", sortOrder: 3, isActive: true }, { code: "NEG", display: "Negative", sortOrder: 1, isActive: true },
    { code: "1+", display: "1+", sortOrder: 2, isActive: true }, { code: "OLD", display: "Old", sortOrder: 4, isActive: false },
  ] }],
  referenceRanges: [
    range(X(110), RR_NEO, 1, EPOCH, AN_HB, { ageMinDays: 0, ageMaxDays: 30, unitCode: "g/dL", low: "14.0", high: "24.0" }),
    range(X(111), RR_NEO, 2, "2026-10-01T00:00:00.000Z", AN_HB, { ageMinDays: 0, ageMaxDays: 30, unitCode: "g/dL", low: "15.0", high: "25.0" }),
    range(X(112), RR_ADULT, 1, EPOCH, AN_HB, { ageMinDays: 30, unitCode: "g/dL", low: "12.0", high: "16.0" }),
    range(X(113), RR_TXT, 1, EPOCH, AN_TXT, { kind: "text", text: "Non-reactive" }),
    range(X(114), RR_ORD, 1, EPOCH, AN_ORD, { kind: "ordinal", text: "Negative", normalCodes: ["NEG"] }),
    range(X(115), RR_UM, 1, EPOCH, AN_UM, { unitCode: "g/dL", low: "3.5", high: "5.0" }),   // unit differs from the analyte's g/L
  ],
  criticalLimits: [
    { id: X(120), tenantId: null, criticalLimitId: CL_HB, version: 1, effectiveFrom: EPOCH, analyteId: AN_HB, low: "5.0", high: "22.0" },
    { id: X(121), tenantId: null, criticalLimitId: CL_ORD, version: 1, effectiveFrom: EPOCH, analyteId: AN_ORD, abnormalCodes: ["2+"] },
  ],
  instrumentMaps: [{ id: MAP1, tenantId: TA, instrumentId: INST, instrumentCode: "SHB1", analyteId: AN_HB, testId: T_G }],
  priceLists: [
    list(PL_EXPL, "explicit", 10000), list(PL_CP, "explicit", 20000),
    list(PL_REF, "referrer", 30000, { scopeRefId: REF1 }), list(PL_CEN, "centre", 40000, { scopeRefId: CEN1 }),
    list(PL_DEF, "tenant_default", 50000, { prices: [{ orderableId: T_G, unitPricePaisa: 50000, urgentSurchargePaisa: 5000 },
      { orderableId: T_X2, unitPricePaisa: 50001 }, { orderableId: T_A1, unitPricePaisa: 60000 }] }),
    list(PL_INACT, "explicit", 70000, { isActive: false }),
    list(PL_DRAFT, "explicit", 80000, { versions: [{ version: 1, status: "draft", effectiveFrom: EPOCH }] }),
  ],
  taxRules: [
    { id: X(130), tenantId: null, orderableId: T_G, vat: "exempt" },
    { id: X(131), tenantId: null, orderableId: T_X2, vat: "taxable" },
    { id: X(132), tenantId: TA, orderableId: T_A1, vat: "exempt", otherTaxCode: "SUITE_NORATE" },
  ],
  taxRates: [
    { id: X(140), tenantId: null, taxCode: "VAT", kind: "vat", ratePercentBasisPoints: 1300, effectiveFrom: null },
    { id: X(141), tenantId: TA, taxCode: "SUITE_HST", kind: "other", ratePercentBasisPoints: 100, effectiveFrom: "2026-04-01" },
    { id: X(142), tenantId: TA, taxCode: "SUITE_HST", kind: "other", ratePercentBasisPoints: 200, effectiveFrom: "2026-07-16" },
  ],
  referrers: [
    { id: REF1, tenantId: TA, code: "SDR1", displayName: "Dr. Suite Referrer 1", isVerified: true, isActive: true,
      contact: { phoneE164: "+9779800000101", email: "suite-ref1@example.com" } },
    { id: REF_M, tenantId: TA, canonicalReferrerId: REF1, code: "SDR1-DUP", displayName: "Dr. Suite Referrer 1 (dup)", isVerified: false, isActive: false },
  ],
  creditParties: [{ id: CP1, tenantId: TA, code: "SCP1", name: "Suite Hospital 1", kind: "hospital", allowsCredit: true, isActive: true, priceListId: PL_CP,
    pan: "600000101", billingAddressText: "Suite Ward 1", contact: { email: "suite-cp1@example.com" } }],
  commentCodes: [
    { id: CC1, tenantId: TA, code: "SC1", isActive: true, versions: [{ version: 1, text: "Suite tenant-wide", effectiveFrom: EPOCH }] },
    { id: CC1H, tenantId: TA, code: "SC1", departmentId: DEP_H, isActive: true, versions: [{ version: 1, text: "Suite haematology", effectiveFrom: EPOCH }] },
    { id: CC2, tenantId: TA, code: "SC2", isActive: true, versions: [
      { version: 1, text: "Suite old text", effectiveFrom: EPOCH }, { version: 2, text: "Suite new text", effectiveFrom: "2026-10-01T00:00:00.000Z" }] },
  ],
};

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e: any) { expect(e?.constructor?.name).toBe("LimsError"); return e.code; }
}

export function runCatalogPortContract(makeImpl: MakeImpl, _opts: { phase1Stub?: boolean } = {}): void {
  // CatalogPort has no phase stub (08 R9): opts.phase1Stub is accepted for a uniform signature and ignored.
  const setup = async () => { const h = await makeImpl(); await h.seed(FIX); return { h, p: h.impl, a: h.ctxFor("A") }; };
  const q = (orderableId: string, context: object, priority = "routine") => ({ orderableId, context, priority, at: NOW });
  const rq = (analyteId: string, extra: object = {}) => ({ analyteId, sex: "male", ageDays: 400, at: NOW, ...extra });

  describe("CatalogPort contract (IC §4.2)", () => {
    it("(1) getTest unknown id → common.not_found", async () => {
      const { p, a } = await setup();
      expect(await codeOf(p.getTest(a, { testId: X(999) }))).toBe("common.not_found");
    });
    it("(2) other tenant's tenant-specific test → common.not_found", async () => {
      const { h, p, a } = await setup();
      expect(await codeOf(p.getTest(a, { testId: T_B1 }))).toBe("common.not_found");
      expect((await p.getTest(h.ctxFor("B"), { testId: T_B1 })).id).toBe(T_B1);
      expect((await p.getTest(a, { testId: T_A1 })).id).toBe(T_A1);
    });
    it("(3) `at` before a new range version returns the old version", async () => {
      const { p, a } = await setup();
      const old = await p.referenceRangeFor(a, rq(AN_HB, { ageDays: 5, at: "2026-09-01T00:00:00.000Z" }));
      const cur = await p.referenceRangeFor(a, rq(AN_HB, { ageDays: 5 }));
      expect([old.referenceRangeId, old.version, old.low]).toEqual([RR_NEO, 1, "14.0"]);
      expect([cur.referenceRangeId, cur.version, cur.low]).toEqual([RR_NEO, 2, "15.0"]);
    });
    it("(4) resolveOrderables de-duplicates a test present in two panels", async () => {
      const { p, a } = await setup();
      const r = await p.resolveOrderables(a, { orderableIds: [P1, P3] });
      expect(r.tests.map((t: any) => t.id).sort()).toEqual([T_G, T_X2].sort());
      expect(r.orderables).toHaveLength(2);
      expect(r.specimenRequirements.flatMap((s: any) => s.testIds).sort()).toEqual([T_G, T_X2].sort());
      expect(typeof r.catalogRevision).toBe("number");
    });
    it("(5) panel cycle → catalog.panel_cycle", async () => {
      const { p, a } = await setup();
      expect(await codeOf(p.resolveOrderables(a, { orderableIds: [PC1] }))).toBe("catalog.panel_cycle");
    });
    it("(6) priceFor precedence: explicit > credit party > referrer > centre > tenant default", async () => {
      const { p, a } = await setup();
      const all = { priceListId: PL_EXPL, creditPartyId: CP1, referrerId: REF1, centreId: CEN1 };
      const steps: [object, string, string][] = [
        [all, "explicit", PL_EXPL],
        [{ creditPartyId: CP1, referrerId: REF1, centreId: CEN1 }, "credit_party", PL_CP],
        [{ referrerId: REF1, centreId: CEN1 }, "referrer", PL_REF],
        [{ centreId: CEN1 }, "centre", PL_CEN],
        [{}, "tenant_default", PL_DEF],
      ];
      for (const [context, source, listId] of steps) {
        const r = await p.priceFor(a, q(T_G, context));
        expect([r.source, r.priceListId], source).toEqual([source, listId]);
        expect(Number.isSafeInteger(r.unitPrice.amountPaisa)).toBe(true);
        expect(r.unitPrice.currency).toBe("NPR");
      }
    });
    it("(7) priceFor urgent adds a surcharge only when a rule exists", async () => {
      const { p, a } = await setup();
      expect((await p.priceFor(a, q(T_G, {}, "urgent"))).urgentSurcharge).toEqual({ amountPaisa: 5000, currency: "NPR" });
      expect((await p.priceFor(a, q(T_G, {}, "routine"))).urgentSurcharge).toBeUndefined();
      expect((await p.priceFor(a, q(T_X2, {}, "urgent"))).urgentSurcharge).toBeUndefined();
    });
    it("(8) no price → catalog.no_price", async () => {
      const { p, a } = await setup();
      expect(await codeOf(p.priceFor(a, q(T_NP, {})))).toBe("catalog.no_price");
    });
    it("(9) referenceRangeFor picks the age/sex band at boundaries (day 0, exact upper age)", async () => {
      const { p, a } = await setup();
      expect((await p.referenceRangeFor(a, rq(AN_HB, { ageDays: 0 }))).referenceRangeId).toBe(RR_NEO);
      expect((await p.referenceRangeFor(a, rq(AN_HB, { ageDays: 29 }))).referenceRangeId).toBe(RR_NEO);
      expect((await p.referenceRangeFor(a, rq(AN_HB, { ageDays: 30 }))).referenceRangeId).toBe(RR_ADULT);
      expect((await p.referenceRangeFor(a, rq(AN_HB, { ageDays: 30, sex: "female" }))).referenceRangeId).toBe(RR_ADULT);
    });
    it("(10) criticalLimitsFor returns undefined when unset", async () => {
      const { p, a } = await setup();
      expect(await p.criticalLimitsFor(a, rq(AN_TXT))).toBeUndefined();
      expect((await p.criticalLimitsFor(a, rq(AN_HB))).criticalLimitId).toBe(CL_HB);
    });
    it("(11) mapInstrumentCode inbound and outbound round-trip", async () => {
      const { p, a } = await setup();
      const inb = await p.mapInstrumentCode(a, { instrumentId: INST, direction: "inbound", instrumentCode: "SHB1" });
      expect([inb.analyteId, inb.testId]).toEqual([AN_HB, T_G]);
      const out = await p.mapInstrumentCode(a, { instrumentId: INST, direction: "outbound", analyteId: inb.analyteId });
      expect([out.instrumentCode, out.mappingId]).toEqual(["SHB1", inb.mappingId]);
    });
    it("(12) unmapped → catalog.instrument_code_unmapped", async () => {
      const { p, a } = await setup();
      expect(await codeOf(p.mapInstrumentCode(a, { instrumentId: INST, direction: "inbound", instrumentCode: "NOPE" }))).toBe("catalog.instrument_code_unmapped");
    });
    it("(13) deactivated test readable with requireActive unset, rejected with requireActive: true", async () => {
      const { p, a } = await setup();
      expect((await p.getTest(a, { testId: T_INACT })).isActive).toBe(false);
      expect(await codeOf(p.getTest(a, { testId: T_INACT, requireActive: true }))).toBe("catalog.test_inactive");
    });
    it("(14) getReferrer display hides contact, notification shows it", async () => {
      const { h, p, a } = await setup();
      expect((await p.getReferrer(a, { referrerId: REF1, purpose: "display" })).contact).toBeUndefined();
      expect((await p.getReferrer(a, { referrerId: REF1, purpose: "notification" })).contact?.email).toBe("suite-ref1@example.com");
      expect(await codeOf(p.getReferrer(h.ctxFor("A:device"), { referrerId: REF1, purpose: "notification" }))).toBe("auth.forbidden");
    });
    it("(15) merged doctor → canonical id", async () => {
      const { p, a } = await setup();
      const r = await p.getReferrer(a, { referrerId: REF_M, purpose: "display" });
      expect([r.referrerId, r.canonicalReferrerId]).toEqual([REF_M, REF1]);
    });
    it("(16) resolveCommentCodes department precedence + unknown list", async () => {
      const { p, a } = await setup();
      const dep = await p.resolveCommentCodes(a, { codes: ["SC1", "SUITE_NOPE"], departmentId: DEP_H });
      expect(dep.resolved.map((r: any) => [r.code, r.text])).toEqual([["SC1", "Suite haematology"]]);
      expect(dep.unknown).toEqual(["SUITE_NOPE"]);
      expect((await p.resolveCommentCodes(a, { codes: ["SC1"], departmentId: DEP_B })).resolved[0].text).toBe("Suite tenant-wide");
      expect(await codeOf(p.resolveCommentCodes(a, { codes: Array.from({ length: 51 }, (_, i) => `C${i}`) }))).toBe("common.validation_failed");
    });
    it("(17) priceFor returns vatRateBp = 1300 for taxable", async () => {
      const { p, a } = await setup();
      const r = await p.priceFor(a, q(T_X2, {}));
      expect([r.tax.vat, r.tax.vatRateBp]).toEqual(["taxable", 1300]);
    });
    it("(18) catalog.tax_config_missing", async () => {
      const { p, a } = await setup();
      expect(await codeOf(p.priceFor(a, q(T_A1, {})))).toBe("catalog.tax_config_missing");
    });
    it("(19) text-kind range has no low/high", async () => {
      const { p, a } = await setup();
      const r = await p.referenceRangeFor(a, rq(AN_TXT));
      expect(r.kind).toBe("text");
      expect(r.text).toBe("Non-reactive");
      expect(r.low).toBeUndefined();
      expect(r.high).toBeUndefined();
    });
    it("(20) birthOn exact-age boundary", async () => {
      const { p, a } = await setup();
      const by = (birthOn: string) => p.referenceRangeFor(a, { analyteId: AN_HB, sex: "male", birthOn, at: NOW });
      expect((await by("2026-10-06")).referenceRangeId).toBe(RR_ADULT);   // exactly 30 days
      expect((await by("2026-10-07")).referenceRangeId).toBe(RR_NEO);     // 29 days
    });
    it("(21) critical ordinal abnormalCodes", async () => {
      const { p, a } = await setup();
      const r = await p.criticalLimitsFor(a, rq(AN_ORD));
      expect(r.abnormalCodes).toEqual(["2+"]);
      expect(r.low).toBeUndefined();
    });
    it("(22) unit/method mismatch → catalog.no_reference_range", async () => {
      const { p, a } = await setup();
      expect(await codeOf(p.referenceRangeFor(a, rq(AN_UM)))).toBe("catalog.no_reference_range");
    });
    it("(23) explicit inactive price list → common.not_found", async () => {
      const { p, a } = await setup();
      expect(await codeOf(p.priceFor(a, q(T_G, { priceListId: PL_INACT })))).toBe("common.not_found");
    });
    it("(24) purpose billing returns pan/billingAddressText, never contact", async () => {
      const { h, p, a } = await setup();
      const r = await p.getCreditParty(a, { creditPartyId: CP1, purpose: "billing" });
      expect([r.pan, r.billingAddressText]).toEqual(["600000101", "Suite Ward 1"]);
      expect(r.contact).toBeUndefined();
      const d = await p.getCreditParty(a, { creditPartyId: CP1, purpose: "display" });
      expect([d.pan, d.contact]).toEqual([undefined, undefined]);
      expect(await codeOf(p.getCreditParty(h.ctxFor("A:portal"), { creditPartyId: CP1, purpose: "billing" }))).toBe("auth.forbidden");
    });
    it("(25) TestDefinition.departmentName present", async () => {
      const { p, a } = await setup();
      expect((await p.getTest(a, { testId: T_G })).departmentName).toBe("Suite Haematology");
    });
    it("(26) resolveCommentCodes with asOf before a text change returns the old text", async () => {
      const { p, a } = await setup();
      const old = await p.resolveCommentCodes(a, { codes: ["SC2"], asOf: "2026-09-01T00:00:00.000Z" });
      const cur = await p.resolveCommentCodes(a, { codes: ["SC2"] });
      expect([old.resolved[0].text, old.resolved[0].version]).toEqual(["Suite old text", 1]);
      expect([cur.resolved[0].text, cur.resolved[0].version]).toEqual(["Suite new text", 2]);
    });
    it("(27) getTaxRate returns the rate effective on `on` (day before / on effectiveFrom)", async () => {
      const { p, a } = await setup();
      const before = await p.getTaxRate(a, { taxCode: "SUITE_HST", on: "2026-07-15" });
      const on = await p.getTaxRate(a, { taxCode: "SUITE_HST", on: "2026-07-16" });
      expect([before.ratePercentBasisPoints, before.effectiveFrom, before.kind]).toEqual([100, "2026-04-01", "other"]);
      expect([on.ratePercentBasisPoints, on.effectiveFrom]).toEqual([200, "2026-07-16"]);
    });
    it("(28) getTaxRate unknown code, or no rate effective on `on` → catalog.tax_config_missing", async () => {
      const { p, a } = await setup();
      expect(await codeOf(p.getTaxRate(a, { taxCode: "SUITE_UNKNOWN", on: "2026-07-16" }))).toBe("catalog.tax_config_missing");
      expect(await codeOf(p.getTaxRate(a, { taxCode: "SUITE_HST", on: "2026-03-31" }))).toBe("catalog.tax_config_missing");
    });
    it("(29) getTaxRate global VAT code (no versioned history) → kind 'vat', effectiveFrom null", async () => {
      const { p, a } = await setup();
      expect(await p.getTaxRate(a, { taxCode: "VAT", on: "2026-07-16" })).toEqual({ taxCode: "VAT", ratePercentBasisPoints: 1300, kind: "vat", effectiveFrom: null });
    });
    it("(30) getTaxRate result kind is never 'exempt'", async () => {
      const { p, a } = await setup();
      for (const [taxCode, on] of [["VAT", "2026-01-01"], ["SUITE_HST", "2026-05-01"], ["SUITE_HST", "2026-11-01"]]) {
        expect(["vat", "other"]).toContain((await p.getTaxRate(a, { taxCode, on })).kind);
      }
    });
    it("(31) analyte with ordinalSetCode → ordinalSetValues equals the active set", async () => {
      const { p, a } = await setup();
      const t = await p.getTest(a, { testId: T_G });
      const ord = t.analytes.find((x: any) => x.id === AN_ORD);
      expect(ord.ordinalSetValues).toEqual([
        { code: "NEG", display: "Negative", sortOrder: 1 }, { code: "1+", display: "1+", sortOrder: 2 }, { code: "2+", display: "2+", sortOrder: 3 }]);
      expect(t.analytes.find((x: any) => x.id === AN_HB).ordinalSetValues).toBeUndefined();
    });
    it("A24.1 getPriceListStatus: published / draft / inactive / unknown and other-tenant → common.not_found", async () => {
      const { h, p, a } = await setup();
      expect(await p.getPriceListStatus(a, { priceListId: PL_DEF })).toEqual({ priceListId: PL_DEF, isActive: true, status: "published" });
      expect(await p.getPriceListStatus(a, { priceListId: PL_DRAFT })).toEqual({ priceListId: PL_DRAFT, isActive: true, status: "draft" });
      expect(await p.getPriceListStatus(a, { priceListId: PL_INACT })).toMatchObject({ isActive: false });
      expect(await codeOf(p.getPriceListStatus(a, { priceListId: X(998) }))).toBe("common.not_found");
      expect(await codeOf(p.getPriceListStatus(h.ctxFor("B"), { priceListId: PL_DEF }))).toBe("common.not_found");
    });
  });
}
