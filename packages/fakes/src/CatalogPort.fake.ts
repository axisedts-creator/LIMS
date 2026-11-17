// packages/fakes/src/CatalogPort.fake.ts — CatalogPort fake (IC §4.2 "Fake must support"; C0 TRD §5.4).
// Global rows (`tenantId: null`) are visible to every tenant, tenant rows only to their tenant (REQ-ARCH-035).
import type { CatalogPort, TestDefinition, PanelDefinition, AnalyteDefinition } from "@lims/contracts/ports/CatalogPort";
import {
  TENANT_A, TENANT_B, err, forbidden, idFor, invalid, isStaffOrSystem, makeFake, notFound, nowOf, tenantOf,
  type FakeOpts,
} from "./base";

type Tid = string | null;
type Row<T> = T & { id: string; tenantId: Tid };
type Band = { sex?: "male" | "female"; ageMinDays?: number; ageMaxDays?: number /* exclusive */; specimenTypeCode?: string };

export interface CatalogFixtures {
  catalogRevision: number;
  departments: Row<{ code: string; name: string }>[];
  tests: Row<Omit<TestDefinition, "departmentName">>[];
  panels: Row<PanelDefinition>[];
  valueSets: Row<{ code: string; values: { code: string; display: string; sortOrder: number; isActive: boolean }[] }>[];
  referenceRanges: Row<Band & { referenceRangeId: string; version: number; effectiveFrom: string; analyteId: string;
    unitCode?: string; methodName?: string; kind: "numeric" | "text" | "ordinal"; low?: string; high?: string; text?: string; normalCodes?: string[] }>[];
  criticalLimits: Row<Band & { criticalLimitId: string; version: number; effectiveFrom: string; analyteId: string;
    low?: string; high?: string; abnormalCodes?: string[] }>[];
  instrumentMaps: Row<{ instrumentId: string; instrumentCode: string; analyteId: string; testId: string;
    unitConversion?: { fromUnitRaw: string; toUnitCode: string; factor: string }; flagMap?: Record<string, string> }>[];
  /** `scope` drives precedence: credit_party via creditParties[].priceListId; referrer/centre via scopeRefId. */
  priceLists: Row<{ code: string; isActive: boolean; scope: "explicit" | "referrer" | "centre" | "tenant_default"; scopeRefId?: string;
    versions: { version: number; status: "draft" | "published" | "superseded" | "discarded"; effectiveFrom: string }[];
    prices: { orderableId: string; unitPricePaisa: number; urgentSurchargePaisa?: number }[] }>[];
  /** Per-orderable tax treatment; rates come from taxRates (R18). */
  taxRules: Row<{ orderableId: string; vat: "exempt" | "taxable"; otherTaxCode?: string; hsCode?: string }>[];
  taxRates: Row<{ taxCode: string; kind: "vat" | "other"; ratePercentBasisPoints: number; effectiveFrom: string | null }>[];
  referrers: Row<{ canonicalReferrerId?: string; code: string; displayName: string; qualification?: string; registrationNo?: string;
    isVerified: boolean; isActive: boolean; contact?: { phoneE164?: string; email?: string } }>[];
  creditParties: Row<{ code: string; name: string; kind: "hospital" | "company" | "clinic" | "partner_lab" | "insurer" | "other";
    allowsCredit: boolean; isActive: boolean; priceListId?: string; pan?: string; billingAddressText?: string;
    contact?: { phoneE164?: string; email?: string } }>[];
  commentCodes: Row<{ code: string; departmentId?: string; isActive: boolean; versions: { version: number; text: string; effectiveFrom: string }[] }>[];
}

const EPOCH = "2026-01-01T00:00:00.000Z";

function defaults(seed: number): CatalogFixtures {
  const id = (n: number) => idFor(seed, n);
  const D = { haem: id(1), bio: id(2), micro: id(3), path: id(4) };
  const an = (n: number, code: string, name: string, extra: Partial<AnalyteDefinition> = {}): AnalyteDefinition =>
    ({ id: id(n), code, name, resultType: "numeric", reportable: true, sortOrder: n, ...extra }) as AnalyteDefinition;
  const test = (n: number, tenantId: Tid, code: string, name: string, departmentId: string, departmentCode: string,
    analytes: AnalyteDefinition[], extra: Partial<TestDefinition> = {}): CatalogFixtures["tests"][number] => ({
    id: id(n), tenantId, code, name, departmentId, departmentCode, specimenTypeCodes: ["blood"], containerCode: "edta",
    workflowType: "standard", analytes, isActive: true, revision: 1, ...extra,
  }) as any;
  const T = { cbc: id(100), glu: id(101), ure: id(102), cul: id(103), bx: id(104), tA: id(105), tB: id(106), lft: id(107) };
  return {
    catalogRevision: 1,
    departments: [
      { id: D.haem, tenantId: null, code: "HAEM", name: "Haematology" },
      { id: D.bio, tenantId: null, code: "BIO", name: "Biochemistry" },
      { id: D.micro, tenantId: null, code: "MICRO", name: "Microbiology" },
      { id: D.path, tenantId: null, code: "PATH", name: "Pathology" },
    ],
    tests: [
      test(100, null, "CBC", "Complete Blood Count", D.haem, "HAEM", [
        an(200, "HB", "Haemoglobin", { unitCode: "g/dL", decimals: 1, reportSubheading: "RBC parameters" }),
        an(201, "RBC", "RBC Count", { unitCode: "10^12/L", decimals: 2 }),
        an(202, "MCV", "MCV", { unitCode: "fL", decimals: 1 }),
        an(203, "MCH", "MCH", { unitCode: "pg", decimals: 1, formula: { expression: "HB / RBC * 10", inputAnalyteCodes: ["HB", "RBC"] } }),
      ]),
      test(101, null, "GLU", "Glucose Fasting", D.bio, "BIO", [an(204, "GLU", "Glucose", { unitCode: "mg/dL", methodName: "GOD-POD" })],
        { containerCode: "fluoride" }),
      test(102, null, "URE", "Urine Routine", D.bio, "BIO", [an(205, "UPRO", "Urine Protein", { resultType: "ordinal", ordinalSetCode: "URINE_PLUS" })],
        { specimenTypeCodes: ["urine"], containerCode: "urine_cup" }),
      test(103, null, "CUL", "Culture and Sensitivity", D.micro, "MICRO", [an(206, "ORG", "Organism", { resultType: "coded" })],
        { workflowType: "microbiology", specimenTypeCodes: ["urine"], containerCode: "sterile_cup" }),
      test(104, null, "BXR", "Biopsy Report Scan", D.path, "PATH", [an(207, "ATT", "Attachment", { resultType: "attachment" })],
        { workflowType: "attachment", specimenTypeCodes: ["tissue"], containerCode: "formalin" }),
      test(105, TENANT_A, "TA1", "Tenant A Special Panel Test", D.bio, "BIO", [an(208, "TA1", "Tenant A Analyte", { unitCode: "U/L" })]),
      test(106, TENANT_B, "TB1", "Tenant B Special Test", D.bio, "BIO", [an(209, "TB1", "Tenant B Analyte", { unitCode: "U/L" })]),
      test(107, null, "LFT", "Liver Function Test", D.bio, "BIO", [an(210, "ALT", "ALT", { unitCode: "U/L" })], { isActive: false }),
    ],
    panels: [
      { id: id(300), tenantId: null, code: "ANAEMIA", name: "Anaemia Panel", panelKind: "clinical",
        members: [{ kind: "test", id: T.cbc }, { kind: "test", id: T.glu }], isActive: true, revision: 1 },
      { id: id(301), tenantId: null, code: "WHP", name: "Women's Health Package", panelKind: "package", sexRestriction: "female",
        members: [{ kind: "panel", id: id(300) }, { kind: "test", id: T.ure }], isActive: true, revision: 1 },
    ],
    valueSets: [{ id: id(400), tenantId: null, code: "URINE_PLUS", values: [
      { code: "NEG", display: "Negative", sortOrder: 1, isActive: true }, { code: "1+", display: "1+", sortOrder: 2, isActive: true },
      { code: "2+", display: "2+", sortOrder: 3, isActive: true }, { code: "TRACE_OLD", display: "Trace", sortOrder: 9, isActive: false },
    ] }],
    referenceRanges: [
      { id: id(500), tenantId: null, referenceRangeId: id(500), version: 1, effectiveFrom: EPOCH, analyteId: id(200), sex: "male", ageMinDays: 6570, unitCode: "g/dL", kind: "numeric", low: "13.0", high: "17.0" },
      { id: id(501), tenantId: null, referenceRangeId: id(501), version: 1, effectiveFrom: EPOCH, analyteId: id(200), sex: "female", ageMinDays: 6570, unitCode: "g/dL", kind: "numeric", low: "12.0", high: "15.5" },
      { id: id(502), tenantId: null, referenceRangeId: id(502), version: 1, effectiveFrom: EPOCH, analyteId: id(200), ageMinDays: 0, ageMaxDays: 6570, unitCode: "g/dL", kind: "numeric", low: "11.0", high: "16.0" },
      { id: id(503), tenantId: null, referenceRangeId: id(503), version: 1, effectiveFrom: EPOCH, analyteId: id(204), unitCode: "mg/dL", methodName: "GOD-POD", kind: "numeric", low: "70", high: "110" },
      { id: id(504), tenantId: null, referenceRangeId: id(504), version: 1, effectiveFrom: EPOCH, analyteId: id(205), kind: "ordinal", text: "Negative", normalCodes: ["NEG"] },
    ],
    criticalLimits: [
      { id: id(600), tenantId: null, criticalLimitId: id(600), version: 1, effectiveFrom: EPOCH, analyteId: id(204), low: "40", high: "450" },
    ],
    instrumentMaps: [
      { id: id(700), tenantId: TENANT_A, instrumentId: id(701), instrumentCode: "HGB", analyteId: id(200), testId: T.cbc },
      { id: id(702), tenantId: TENANT_B, instrumentId: id(703), instrumentCode: "HGB", analyteId: id(200), testId: T.cbc },
    ],
    priceLists: [
      // [CONV] seeded lists are explicit/referrer-scoped so contract suites can seed their own tenant default list.
      { id: id(800), tenantId: TENANT_A, code: "STD", isActive: true, scope: "explicit",
        versions: [{ version: 1, status: "published", effectiveFrom: EPOCH }],
        prices: [{ orderableId: T.cbc, unitPricePaisa: 50000, urgentSurchargePaisa: 10000 }, { orderableId: T.glu, unitPricePaisa: 20000 },
          { orderableId: id(300), unitPricePaisa: 65000 }, { orderableId: T.tA, unitPricePaisa: 30000 }] },
      { id: id(801), tenantId: TENANT_A, code: "DRX", isActive: true, scope: "referrer", scopeRefId: id(900),
        versions: [{ version: 1, status: "superseded", effectiveFrom: EPOCH }, { version: 2, status: "published", effectiveFrom: "2026-06-01T00:00:00.000Z" }],
        prices: [{ orderableId: T.cbc, unitPricePaisa: 45000 }] },
      { id: id(802), tenantId: TENANT_B, code: "STD", isActive: true, scope: "explicit",
        versions: [{ version: 1, status: "published", effectiveFrom: EPOCH }], prices: [{ orderableId: T.cbc, unitPricePaisa: 55000 }] },
      { id: id(803), tenantId: TENANT_A, code: "NEW", isActive: true, scope: "explicit", versions: [{ version: 1, status: "draft", effectiveFrom: EPOCH }], prices: [] },
    ],
    taxRules: [{ id: id(810), tenantId: null, orderableId: T.cbc, vat: "exempt" }, { id: id(811), tenantId: TENANT_A, orderableId: T.tA, vat: "taxable", hsCode: "9018" }],
    taxRates: [{ id: id(820), tenantId: null, taxCode: "VAT", kind: "vat", ratePercentBasisPoints: 1300, effectiveFrom: null }],
    referrers: [
      { id: id(900), tenantId: TENANT_A, code: "DR001", displayName: "Dr. Test Referrer 0001", qualification: "MBBS", registrationNo: "NMC-00001",
        isVerified: true, isActive: true, contact: { phoneE164: "+9779800000001", email: "referrer0001@example.com" } },
    ],
    creditParties: [
      { id: id(910), tenantId: TENANT_A, code: "HOSP01", name: "Test Hospital 0001", kind: "hospital", allowsCredit: true, isActive: true,
        pan: "600000001", billingAddressText: "Ward 1, Test City", contact: { email: "accounts0001@example.com" } },
    ],
    commentCodes: [
      { id: id(920), tenantId: TENANT_A, code: "HAEM", isActive: true, versions: [{ version: 1, text: "Sample haemolysed.", effectiveFrom: EPOCH }] },
    ],
  };
}

const visible = (t: string) => (r: { tenantId: Tid }) => r.tenantId === null || r.tenantId === t;
const ms = (iso: string) => Date.parse(iso);
const DAY = 86_400_000;

export function createFakeCatalogPort(opts: FakeOpts<CatalogFixtures>) {
  return makeFake<CatalogFixtures, CatalogPort>(defaults, opts, ({ fixtures: f }) => {
    const testsOf = (t: string) => f.tests.filter(visible(t));
    const findTest = (t: string, id: unknown) => testsOf(t).find((x) => x.id === id);
    const findPanel = (t: string, id: unknown) => f.panels.filter(visible(t)).find((x) => x.id === id);
    const findAnalyte = (t: string, id: unknown) => {
      for (const x of testsOf(t)) { const a = x.analytes.find((y) => y.id === id); if (a) return a; }
      return undefined;
    };
    const strip = <T extends { tenantId: Tid }>(r: T): Omit<T, "tenantId"> => { const { tenantId: _t, ...rest } = r; return rest; };
    const outAnalyte = (t: string, a: AnalyteDefinition): AnalyteDefinition => {
      if (!a.ordinalSetCode) return a;
      const vs = f.valueSets.filter(visible(t)).find((v) => v.code === a.ordinalSetCode);
      const ordinalSetValues = (vs?.values ?? []).filter((v) => v.isActive).sort((x, y) => x.sortOrder - y.sortOrder)
        .map(({ code, display, sortOrder }) => ({ code, display, sortOrder }));
      return { ...a, ordinalSetValues };
    };
    const outTest = (t: string, x: CatalogFixtures["tests"][number]): TestDefinition => {
      const { id: _id, ...rest } = strip(x);
      const departmentName = f.departments.find((d) => d.id === x.departmentId)?.name;
      return { id: x.id, ...rest, analytes: x.analytes.map((a) => outAnalyte(t, a)), ...(departmentName ? { departmentName } : {}) } as TestDefinition;
    };
    const ageOf = (q: { ageDays?: number; birthOn?: string; at: string }): number | undefined => {
      if (typeof q.ageDays === "number") return q.ageDays;
      if (q.birthOn) return Math.floor((ms(q.at.slice(0, 10)) - ms(q.birthOn)) / DAY);
      return undefined;
    };
    const bandMatch = (b: Band, q: { sex?: string; specimenTypeCode?: string }, age: number | undefined) => {
      if (b.sex && b.sex !== q.sex) return false;
      if (b.specimenTypeCode && q.specimenTypeCode && b.specimenTypeCode !== q.specimenTypeCode) return false;
      if (age === undefined) return b.ageMinDays === undefined && b.ageMaxDays === undefined;   // 08 A17.1
      if (b.ageMinDays !== undefined && age < b.ageMinDays) return false;
      if (b.ageMaxDays !== undefined && age >= b.ageMaxDays) return false;
      return true;
    };
    /** Latest version (effectiveFrom ≤ at) per logical row id, then the first remaining row. */
    const pickVersion = <R extends { effectiveFrom: string; version: number }>(rows: R[], key: (r: R) => string, at: string): R | undefined => {
      const best = new Map<string, R>();
      for (const r of rows) {
        if (ms(r.effectiveFrom) > ms(at)) continue;
        const k = key(r), cur = best.get(k);
        if (!cur || r.version > cur.version) best.set(k, r);
      }
      return [...best.values()][0];
    };
    const atOf = (ctx: any, v: unknown) => (typeof v === "string" ? v : nowOf(ctx));
    const listStatus = (pl: CatalogFixtures["priceLists"][number]) =>
      pl.versions.some((v) => v.status === "published") ? "published" : pl.versions.some((v) => v.status === "draft") ? "draft" : "discarded";
    const publishedVersion = (pl: CatalogFixtures["priceLists"][number], at: string) =>
      pl.versions.filter((v) => v.status === "published" && ms(v.effectiveFrom) <= ms(at)).sort((a, b) => b.version - a.version)[0];
    const rateOn = (t: string, taxCode: unknown, on: string) =>
      f.taxRates.filter(visible(t)).filter((r) => r.taxCode === taxCode && (r.effectiveFrom === null || r.effectiveFrom.slice(0, 10) <= on.slice(0, 10)))
        .sort((a, b) => (b.effectiveFrom ?? "").localeCompare(a.effectiveFrom ?? ""))[0];

    return {
      async getTest(ctx, input) {
        const x = findTest(tenantOf(ctx), input.testId);
        if (!x) throw notFound();
        if (input.requireActive && !x.isActive) throw err("catalog.test_inactive");
        return outTest(ctx.tenantId, x);
      },
      async getPanel(ctx, input) {
        const p = findPanel(tenantOf(ctx), input.panelId);
        if (!p) throw notFound();
        if (input.requireActive && !p.isActive) throw err("catalog.test_inactive");
        return strip(p) as PanelDefinition;
      },
      async resolveOrderables(ctx, input) {
        const t = tenantOf(ctx);
        if (!Array.isArray(input.orderableIds)) throw invalid("orderableIds_required");
        const expand = (id: string, path: string[]): string[] => {
          const test = findTest(t, id);
          if (test) { if (!test.isActive) throw err("catalog.test_inactive"); return [id]; }
          const p = findPanel(t, id);
          if (!p) throw notFound();
          if (path.includes(id)) throw err("catalog.panel_cycle");
          if (!p.isActive) throw err("catalog.test_inactive");
          return p.members.flatMap((m) => expand(m.id, [...path, id]));
        };
        const orderables = input.orderableIds.map((oid) => {
          const testIds = [...new Set(expand(oid, []))];
          return { orderableId: oid, kind: findTest(t, oid) ? ("test" as const) : ("panel" as const), testIds };
        });
        const ids = [...new Set(orderables.flatMap((o) => o.testIds))];
        const tests = ids.map((id) => outTest(t, findTest(t, id)!));
        const groups = new Map<string, { specimenTypeCode: string; containerCode?: string; testIds: string[] }>();
        for (const x of tests) {
          const k = `${x.specimenTypeCodes[0]}|${x.containerCode ?? ""}`;
          const g = groups.get(k) ?? groups.set(k, { specimenTypeCode: x.specimenTypeCodes[0]!, ...(x.containerCode ? { containerCode: x.containerCode } : {}), testIds: [] }).get(k)!;
          g.testIds.push(x.id);
        }
        return { orderables, tests, specimenRequirements: [...groups.values()], catalogRevision: f.catalogRevision } as any;
      },
      async priceFor(ctx, input) {
        const t = tenantOf(ctx);
        const c = input.context ?? {};
        const at = atOf(ctx, input.at);
        if (!findTest(t, input.orderableId) && !findPanel(t, input.orderableId)) throw notFound();
        const lists = f.priceLists.filter(visible(t));
        const usable = (pl?: (typeof lists)[number]) => (pl && pl.isActive && publishedVersion(pl, at) ? pl : undefined);
        const cands: { source: "explicit" | "credit_party" | "referrer" | "centre" | "tenant_default"; pl?: (typeof lists)[number] }[] = [];
        if (c.priceListId) {
          const pl = usable(lists.find((l) => l.id === c.priceListId));
          if (!pl) throw notFound();                                   // C3 TRD §14: explicit inactive list → not_found
          cands.push({ source: "explicit", pl });
        }
        if (c.creditPartyId) {
          const cp = f.creditParties.filter(visible(t)).find((x) => x.id === c.creditPartyId);
          cands.push({ source: "credit_party", pl: usable(lists.find((l) => l.id === cp?.priceListId)) });
        }
        if (c.referrerId) cands.push({ source: "referrer", pl: usable(lists.find((l) => l.scope === "referrer" && l.scopeRefId === c.referrerId)) });
        if (c.centreId) cands.push({ source: "centre", pl: usable(lists.find((l) => l.scope === "centre" && l.scopeRefId === c.centreId)) });
        cands.push({ source: "tenant_default", pl: usable(lists.find((l) => l.scope === "tenant_default")) });
        for (const { source, pl } of cands) {
          const price = pl?.prices.find((p) => p.orderableId === input.orderableId);
          if (!pl || !price) continue;
          const rule = f.taxRules.filter(visible(t)).find((r) => r.orderableId === input.orderableId);
          const tax: any = { vat: rule?.vat ?? "exempt" };
          if (rule?.hsCode) tax.hsCode = rule.hsCode;
          if (tax.vat === "taxable") {
            const vat = rateOn(t, "VAT", at);
            if (!vat) throw err("catalog.tax_config_missing");
            tax.vatRateBp = vat.ratePercentBasisPoints;
          }
          if (rule?.otherTaxCode) {
            const o = rateOn(t, rule.otherTaxCode, at);
            if (!o) throw err("catalog.tax_config_missing");
            tax.otherTaxCode = rule.otherTaxCode; tax.otherTaxRateBp = o.ratePercentBasisPoints;
          }
          return {
            orderableId: input.orderableId, priceListId: pl.id, priceListVersion: publishedVersion(pl, at)!.version, source,
            unitPrice: { amountPaisa: price.unitPricePaisa, currency: "NPR" },
            ...(input.priority === "urgent" && price.urgentSurchargePaisa !== undefined
              ? { urgentSurcharge: { amountPaisa: price.urgentSurchargePaisa, currency: "NPR" } } : {}),
            tax,
          } as any;
        }
        throw err("catalog.no_price");
      },
      async referenceRangeFor(ctx, input) {
        const t = tenantOf(ctx);
        const a = findAnalyte(t, input.analyteId);
        if (!a) throw notFound();
        const at = atOf(ctx, input.at), age = ageOf({ ...input, at });
        const rows = f.referenceRanges.filter(visible(t)).filter((r) => r.analyteId === a.id && bandMatch(r, input, age)
          && (!r.unitCode || r.unitCode === a.unitCode) && (!r.methodName || r.methodName === a.methodName));
        const r = pickVersion(rows, (x) => x.referenceRangeId, at);
        if (!r) throw err("catalog.no_reference_range");
        const out: any = { referenceRangeId: r.referenceRangeId, version: r.version, kind: r.kind };
        if (r.kind === "numeric") { if (r.low !== undefined) out.low = r.low; if (r.high !== undefined) out.high = r.high; }
        if (r.text !== undefined) out.text = r.text;
        if (r.unitCode) out.unitCode = r.unitCode;
        if (r.normalCodes) out.normalCodes = r.normalCodes;
        return out;
      },
      async criticalLimitsFor(ctx, input) {
        const t = tenantOf(ctx);
        const a = findAnalyte(t, input.analyteId);
        if (!a) throw notFound();
        const at = atOf(ctx, input.at), age = ageOf({ ...input, at });
        const r = pickVersion(f.criticalLimits.filter(visible(t)).filter((x) => x.analyteId === a.id && bandMatch(x, input, age)), (x) => x.criticalLimitId, at);
        if (!r) return undefined;
        const out: any = { criticalLimitId: r.criticalLimitId, version: r.version };
        for (const k of ["low", "high", "abnormalCodes"] as const) if (r[k] !== undefined) out[k] = r[k];
        return out;
      },
      async mapInstrumentCode(ctx, input) {
        const t = tenantOf(ctx);
        const m = f.instrumentMaps.filter(visible(t)).find((x) => x.instrumentId === input.instrumentId && (input.direction === "inbound"
          ? x.instrumentCode === input.instrumentCode
          : input.direction === "outbound" && ((input.analyteId && x.analyteId === input.analyteId) || (!input.analyteId && input.testId && x.testId === input.testId))));
        if (!m) throw err("catalog.instrument_code_unmapped");
        const { id, ...rest } = strip(m);
        return { mappingId: id, ...rest } as any;
      },
      async getReferrer(ctx, input) {
        const t = tenantOf(ctx);
        if (input.purpose === "notification" && !isStaffOrSystem(ctx)) throw forbidden();
        const r = f.referrers.filter(visible(t)).find((x) => x.id === input.referrerId);
        if (!r) throw notFound();
        const { id, contact, canonicalReferrerId, ...rest } = strip(r);
        return { referrerId: id, canonicalReferrerId: canonicalReferrerId ?? id, ...rest, ...(input.purpose === "notification" && contact ? { contact } : {}) } as any;
      },
      async getCreditParty(ctx, input) {
        const t = tenantOf(ctx);
        if ((input.purpose === "notification" || input.purpose === "billing") && !isStaffOrSystem(ctx)) throw forbidden();
        const r = f.creditParties.filter(visible(t)).find((x) => x.id === input.creditPartyId);
        if (!r) throw notFound();
        const { id, contact, pan, billingAddressText, ...rest } = strip(r);
        return {
          creditPartyId: id, ...rest,
          ...(input.purpose === "billing" ? { ...(pan ? { pan } : {}), ...(billingAddressText ? { billingAddressText } : {}) } : {}),
          ...(input.purpose === "notification" && contact ? { contact } : {}),
        } as any;
      },
      async resolveCommentCodes(ctx, input) {
        const t = tenantOf(ctx);
        if (!Array.isArray(input.codes) || input.codes.length > 50) throw invalid("codes_max_50");
        const at = atOf(ctx, input.asOf);
        const resolved: any[] = [], unknown: string[] = [];
        for (const code of input.codes) {
          const rows = f.commentCodes.filter(visible(t)).filter((x) => x.code === code && x.isActive);
          const row = rows.find((x) => input.departmentId && x.departmentId === input.departmentId) ?? rows.find((x) => !x.departmentId);
          const v = row && pickVersion(row.versions, () => "v", at);
          if (!row || !v) { unknown.push(code); continue; }
          resolved.push({ code, commentCodeId: row.id, version: v.version, ...(row.departmentId ? { departmentId: row.departmentId } : {}), text: v.text });
        }
        return { resolved, unknown };
      },
      async getTaxRate(ctx, input) {
        const t = tenantOf(ctx);
        if (typeof input.on !== "string") throw err("catalog.tax_config_missing");
        const r = rateOn(t, input.taxCode, input.on);
        if (!r) throw err("catalog.tax_config_missing");
        return { taxCode: r.taxCode, ratePercentBasisPoints: r.ratePercentBasisPoints, kind: r.kind, effectiveFrom: r.effectiveFrom === null ? null : r.effectiveFrom.slice(0, 10) };
      },
      async getPriceListStatus(ctx, input) {
        const pl = f.priceLists.filter(visible(tenantOf(ctx))).find((x) => x.id === input.priceListId);
        if (!pl) throw notFound();
        return { priceListId: pl.id, isActive: pl.isActive, status: listStatus(pl) } as any;
      },
    };
  });
}
