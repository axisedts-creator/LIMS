// T0C-10.C3 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/catalog.yaml (C3 transcription of 02-TRD §5.2, ops #1–#107).
// Source of truth: spec/chunks/C3-catalog-pricing/02-TRD.md §5.0 (common rules), §5.1 (DTOs), §5.2 (operation tables).
// Checks: (1) file exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) is clean for catalog.yaml;
// (3) AC-0C-1.5 negative: bad x-permission / error code / missing additionalProperties / tier in a copy fails lint;
// (4) inventory = TRD table (107 ops, method+path, x-permission, idem, success code, error codes, If-Match/Idempotency-Key);
// (5) shape pins (uploads, xlsx downloads, paging, DTO constraints); (6) "Prism smoke" offline: every JSON example
// validates against its schema (ajv) and each operation has a servable 2xx example.
// Not testable here: Prism actually serving the file (prism not installed; mock wiring is T0C-08's mocks.test.ts).
// Assumptions (TRD silent): If-Match is pinned on PATCH/PUT and on the named state-changing actions (publish/retire/discard/
// verify/merge/end/commit); NOT on creates, read-only POSTs (#3 #36 #51 #60 #82), bulk-upsert/remove, createXDraft (TRD §5.0).
// `-` in the TRD Idem column: read-only POSTs (#3 #36 #51 #60 #82) = `none` + `E3 ` justification (LD-10, lint rule 4/P-8);
// non-creating state actions (discard*/verifyDoctor/end*) = `optional` (02-CV §4.5: required only on POSTs that create state;
// no E-label fits them and none may be faked). Assumption — the writer/lead may rule otherwise.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FILE = join(ROOT, "contracts/openapi/catalog.yaml");
const PFX = "/v1/catalog";
const TRD = join(ROOT, "spec/chunks/C3-catalog-pricing/02-TRD.md");
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// id  METHOD  path  permission  idem(none|required)  success-status
const R = "catalog.test.read", M = "catalog.test.manage", PR = "catalog.price_list.read", PM = "catalog.price_list.manage";
const DR = "catalog.referrer.read", DM = "catalog.referrer.manage", IM = "catalog.instrument_code_map.manage", PUB = "catalog.reference_range.publish";
const rows: [string, string, string, string, string, number][] = [
  ["getCatalogRevision", "GET", "/revision", R, "none", 200],
  ["searchOrderables", "GET", "/orderables", R, "none", 200],
  ["resolveOrderablesPreview", "POST", "/orderables/resolve", R, "none", 200],
  ["getCatalogHealthReport", "GET", "/health-report", R, "none", 200],
];
for (const [r, n] of [["departments", "Department"], ["specimen-types", "SpecimenType"], ["containers", "Container"], ["methods", "Method"]]) {
  rows.push([`list${n}s`, "GET", `/${r}`, R, "none", 200], [`create${n}`, "POST", `/${r}`, M, "required", 201], [`update${n}`, "PATCH", `/${r}/{id}`, M, "none", 200]);
}
rows.push(
  ["listUnits", "GET", "/units", R, "none", 200], ["createUnit", "POST", "/units", M, "required", 201], ["updateUnit", "PATCH", "/units/{unit_id}", M, "none", 200],
  ["listValueSets", "GET", "/value-sets", R, "none", 200], ["createValueSet", "POST", "/value-sets", M, "required", 201], ["updateValueSet", "PATCH", "/value-sets/{value_set_id}", M, "none", 200],
  ["listTests", "GET", "/tests", R, "none", 200], ["createTest", "POST", "/tests", M, "required", 201],
  ["getTestDetail", "GET", "/tests/{test_id}", R, "none", 200], ["updateTest", "PATCH", "/tests/{test_id}", M, "none", 200],
  ["replaceTestSpecimenRequirements", "PUT", "/tests/{test_id}/specimen-requirements", M, "none", 200],
  ["setTestTatTargets", "PUT", "/tests/{test_id}/tat-targets", M, "none", 200],
  ["createAnalyte", "POST", "/tests/{test_id}/analytes", M, "required", 201],
  ["getAnalyte", "GET", "/analytes/{analyte_id}", R, "none", 200], ["updateAnalyte", "PATCH", "/analytes/{analyte_id}", M, "none", 200],
  ["createAnalyteVersionDraft", "POST", "/analytes/{analyte_id}/versions", M, "required", 201],
  ["updateAnalyteVersionDraft", "PATCH", "/analyte-versions/{analyte_version_id}", M, "none", 200],
  ["publishAnalyteVersion", "POST", "/analyte-versions/{analyte_version_id}/publish", PUB, "required", 200],
  ["discardAnalyteVersionDraft", "POST", "/analyte-versions/{analyte_version_id}/discard", M, "optional", 200],
  ["validateFormula", "POST", "/formulas/validate", R, "none", 200],
);
for (const [s, P] of [["reference-range-sets", "ReferenceRangeSet"], ["critical-limit-sets", "CriticalLimitSet"]]) {
  rows.push(
    [`list${P}s`, "GET", `/analytes/{analyte_id}/${s}`, R, "none", 200], [`create${P}Draft`, "POST", `/analytes/{analyte_id}/${s}`, M, "required", 201],
    [`get${P}`, "GET", `/${s}/{set_id}`, R, "none", 200], [`replace${P}Bands`, "PUT", `/${s}/{set_id}/bands`, M, "none", 200],
    [`publish${P}`, "POST", `/${s}/{set_id}/publish`, PUB, "required", 200], [`retire${P}`, "POST", `/${s}/{set_id}/retire`, PUB, "required", 200],
    [`discard${P}Draft`, "POST", `/${s}/{set_id}/discard`, M, "optional", 200],
  );
}
rows.push(
  ["previewReferenceRange", "POST", "/reference-ranges/preview", R, "none", 200],
  ["listPanels", "GET", "/panels", R, "none", 200], ["createPanel", "POST", "/panels", M, "required", 201],
  ["getPanelDetail", "GET", "/panels/{panel_id}", R, "none", 200], ["updatePanel", "PATCH", "/panels/{panel_id}", M, "none", 200],
  ["replacePanelMembers", "PUT", "/panels/{panel_id}/members", M, "none", 200],
  ["listCommentCodes", "GET", "/comment-codes", R, "none", 200], ["createCommentCode", "POST", "/comment-codes", M, "required", 201],
  ["updateCommentCode", "PATCH", "/comment-codes/{comment_code_id}", M, "none", 200],
  ["searchDoctors", "POST", "/doctors/search", DR, "none", 200], ["listDoctors", "GET", "/doctors", DR, "none", 200],
  ["createDoctor", "POST", "/doctors", DM, "required", 201], ["getDoctor", "GET", "/doctors/{doctor_id}", DR, "none", 200],
  ["updateDoctor", "PATCH", "/doctors/{doctor_id}", DM, "none", 200], ["verifyDoctor", "POST", "/doctors/{doctor_id}/verify", DM, "optional", 200],
  ["mergeDoctor", "POST", "/doctors/{doctor_id}/merge", DM, "required", 200],
  ["listCreditParties", "GET", "/credit-parties", PR, "none", 200], ["createCreditParty", "POST", "/credit-parties", PM, "required", 201],
  ["getCreditParty", "GET", "/credit-parties/{credit_party_id}", PR, "none", 200], ["updateCreditParty", "PATCH", "/credit-parties/{credit_party_id}", PM, "none", 200],
  ["listPriceLists", "GET", "/price-lists", PR, "none", 200], ["createPriceList", "POST", "/price-lists", PM, "required", 201],
  ["getPriceListDetail", "GET", "/price-lists/{price_list_id}", PR, "none", 200], ["updatePriceList", "PATCH", "/price-lists/{price_list_id}", PM, "none", 200],
  ["replacePriceListAssignments", "PUT", "/price-lists/{price_list_id}/assignments", PM, "none", 200],
  ["createPriceListVersionDraft", "POST", "/price-lists/{price_list_id}/versions", PM, "required", 201],
  ["listPriceListItems", "GET", "/price-list-versions/{price_list_version_id}/items", PR, "none", 200],
  ["upsertPriceListItems", "POST", "/price-list-versions/{price_list_version_id}/items/bulk-upsert", PM, "required", 200],
  ["removePriceListItems", "POST", "/price-list-versions/{price_list_version_id}/items/bulk-remove", PM, "required", 200],
  ["publishPriceListVersion", "POST", "/price-list-versions/{price_list_version_id}/publish", PM, "required", 200],
  ["discardPriceListVersionDraft", "POST", "/price-list-versions/{price_list_version_id}/discard", PM, "optional", 200],
  ["quotePrices", "POST", "/prices/quote", PR, "none", 200],
  ["listSurchargeRules", "GET", "/surcharge-rules", PR, "none", 200], ["createSurchargeRule", "POST", "/surcharge-rules", PM, "required", 201],
  ["endSurchargeRule", "POST", "/surcharge-rules/{surcharge_rule_id}/end", PM, "optional", 200],
  ["listTaxTypes", "GET", "/tax-types", PR, "none", 200], ["createTaxType", "POST", "/tax-types", PM, "required", 201],
  ["updateTaxType", "PATCH", "/tax-types/{tax_type_id}", PM, "none", 200],
  ["listTaxRules", "GET", "/tax-rules", PR, "none", 200], ["createTaxRule", "POST", "/tax-rules", PM, "required", 201],
  ["endTaxRule", "POST", "/tax-rules/{tax_rule_id}/end", PM, "optional", 200],
  ["listInstrumentCodeMaps", "GET", "/instrument-code-maps", IM, "none", 200], ["createInstrumentCodeMap", "POST", "/instrument-code-maps", IM, "required", 201],
  ["updateInstrumentCodeMap", "PATCH", "/instrument-code-maps/{map_id}", IM, "none", 200],
  ["upsertInstrumentCodeMaps", "POST", "/instrument-code-maps/bulk-upsert", IM, "required", 200],
  // #96–#107: x-permission is the floor catalog.test.read; kind-dependent permission is asserted in the handler (P-10)
  ["downloadImportTemplate", "GET", "/import-templates/{kind}", R, "none", 200], ["createImport", "POST", "/imports", R, "required", 201],
  ["listImports", "GET", "/imports", R, "none", 200], ["getImport", "GET", "/imports/{import_id}", R, "none", 200],
  ["listImportIssues", "GET", "/imports/{import_id}/issues", R, "none", 200], ["downloadImportReport", "GET", "/imports/{import_id}/report-file", R, "none", 200],
  ["commitImport", "POST", "/imports/{import_id}/commit", R, "required", 202], ["discardImport", "POST", "/imports/{import_id}/discard", R, "optional", 200],
  ["createExport", "POST", "/exports", R, "required", 202], ["getExport", "GET", "/exports/{export_id}", R, "none", 200],
  ["downloadExportFile", "GET", "/exports/{export_id}/file", R, "none", 200], ["listExports", "GET", "/exports", R, "none", 200],
);
type Row = { id: string; method: string; path: string; perm: string; idem: string; status: number };
const ROWS: Row[] = rows.map(([id, method, path, perm, idem, status]) => ({ id, method, path: PFX + path, perm, idem, status }));

// Specific errors from the TRD "Specific errors" column (registered codes only); must appear in x-error-codes.
const DUP = "catalog.code_duplicate", INUSE = "catalog.version_in_use", FORM = "catalog.formula_invalid", CYC = "catalog.panel_cycle";
const INACT = "catalog.test_inactive", VC = "common.version_conflict", VF = "common.validation_failed";
const ERRORS: Record<string, string[]> = {
  resolveOrderablesPreview: [INACT, CYC],
  createDepartment: [DUP], updateDepartment: [DUP], createSpecimenType: [DUP], updateSpecimenType: [DUP],
  createContainer: [DUP], updateContainer: [DUP], createMethod: [DUP], updateMethod: [DUP],
  createUnit: [DUP], createValueSet: [DUP], updateValueSet: [INUSE],
  createTest: [DUP], updateTest: [INUSE], createAnalyte: [DUP, FORM], createAnalyteVersionDraft: [VC],
  updateAnalyteVersionDraft: [INUSE, FORM], publishAnalyteVersion: [INUSE, FORM], discardAnalyteVersionDraft: [INUSE],
  createReferenceRangeSetDraft: [VC], replaceReferenceRangeSetBands: [INUSE], publishReferenceRangeSet: [INUSE, VF],
  retireReferenceRangeSet: [INUSE], discardReferenceRangeSetDraft: [INUSE],
  createCriticalLimitSetDraft: [VC], replaceCriticalLimitSetBands: [INUSE], publishCriticalLimitSet: [INUSE, VF],
  retireCriticalLimitSet: [INUSE], discardCriticalLimitSetDraft: [INUSE],
  createPanel: [DUP, CYC, INACT], replacePanelMembers: [CYC, INACT], createCommentCode: [DUP],
  createDoctor: [DUP], verifyDoctor: [INUSE], mergeDoctor: [VF], createCreditParty: [DUP],
  createPriceList: [DUP], updatePriceList: [VF], replacePriceListAssignments: [DUP], createPriceListVersionDraft: [VC],
  upsertPriceListItems: [INUSE], removePriceListItems: [INUSE], publishPriceListVersion: [INUSE], discardPriceListVersionDraft: [INUSE],
  createSurchargeRule: [VF], createTaxType: [DUP], updateTaxType: [VF], createTaxRule: [VF], endTaxRule: [VF],
  createInstrumentCodeMap: [DUP], updateInstrumentCodeMap: [DUP],
  createImport: ["common.payload_too_large", "common.unsupported_media_type", "common.rate_limited"],
  downloadImportReport: [VC], commitImport: ["catalog.import_not_committable", "catalog.import_stale_base"],
  discardImport: ["catalog.import_not_committable"], downloadExportFile: [VC],
};
// #96–#107: handler-asserted kind permission → auth.forbidden + auth.mfa_required in each operation's x-error-codes (TRD §5.2 note)
const KIND_PERM_OPS = ["downloadImportTemplate", "createImport", "listImports", "getImport", "listImportIssues", "downloadImportReport",
  "commitImport", "discardImport", "createExport", "getExport", "downloadExportFile", "listExports"];
// If-Match: every PATCH/PUT, plus these state-changing actions on an existing resource (TRD §5.0)
const READ_ONLY_POSTS = ["resolveOrderablesPreview", "validateFormula", "previewReferenceRange", "searchDoctors", "quotePrices"];
const IFMATCH_ACTIONS =["publishAnalyteVersion", "discardAnalyteVersionDraft", "verifyDoctor", "mergeDoctor", "publishPriceListVersion",
  "discardPriceListVersionDraft", "endSurchargeRule", "endTaxRule", "commitImport", "discardImport",
  ...["ReferenceRangeSet", "CriticalLimitSet"].flatMap((P) => [`publish${P}`, `retire${P}`, `discard${P}Draft`])];
// TRD §5.0: If-Match does NOT apply to read-only POSTs #3 #36 #51 #60 #82 nor creates #97 #104
const NO_IFMATCH = ["resolveOrderablesPreview", "validateFormula", "previewReferenceRange", "searchDoctors", "quotePrices", "createImport", "createExport"];
const UPLOADS = ["createImport"];
const XLSX_DOWNLOADS = ["downloadImportTemplate", "downloadImportReport", "downloadExportFile"];
const PAGED = [...["Departments", "SpecimenTypes", "Containers", "Methods"].map((x) => `list${x}`), "listTests", "listPanels", "listCommentCodes", "listDoctors",
  "listCreditParties", "listPriceLists", "listPriceListItems", "listImports", "listImportIssues", "listExports", "listInstrumentCodeMaps"];
const DTOS = ["Department", "SpecimenType", "Container", "Method", "Unit", "ValueSet", "OrderableSummary", "Test", "Analyte", "AnalyteVersion", "RangeBand",
  "RangeSet", "CriticalBand", "CriticalSet", "Panel", "TatTarget", "CommentCode", "Doctor", "CreditParty", "PriceList", "PriceListVersion", "PriceItem",
  "SurchargeRule", "TaxType", "TaxRule", "InstrumentCodeMap", "Import", "ImportIssue", "Export"];

const text = existsSync(FILE) ? readFileSync(FILE, "utf8") : "";
const doc: any = text ? parse(text) : { paths: {}, components: {} };
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const METHODS = ["get", "put", "post", "delete", "patch"];
const ops: Record<string, { method: string; path: string; op: any }> = {};
for (const [path, item] of Object.entries<any>(doc.paths ?? {}))
  for (const m of METHODS) if (item?.[m]) ops[item[m].operationId] = { method: m.toUpperCase(), path, op: item[m] };

// resolve a response / schema node ($ref to this file or _common.yaml), flattening allOf into one properties map
const deref = (n: any): any => {
  if (!n?.$ref) return n;
  const [file, ptr] = n.$ref.split("#");
  let cur: any = file === "_common.yaml" ? common : doc;
  for (const k of ptr.split("/").slice(1)) cur = cur?.[k.replace(/~1/g, "/").replace(/~0/g, "~")];
  return deref(cur);
};
const props = (s: any): Record<string, any> => {
  const n = deref(s) ?? {};
  return Object.assign({}, ...(n.allOf ?? []).map(props), n.properties ?? {});
};
const bodySchema = (id: string) => deref(ops[id].op.requestBody?.content?.["application/json"]?.schema);

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("catalog.yaml exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
  it("file exists", () => expect(existsSync(FILE), "contracts/openapi/catalog.yaml missing").toBe(true));
  it("first non-comment line is `openapi: 3.0.3`", () => {
    const first = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#"));
    expect(first?.trim()).toBe("openapi: 3.0.3");
  });
  it("info.title and version present", () => {
    expect(typeof doc.info?.title).toBe("string");
    expect(typeof doc.info?.version).toBe("string");
  });
});

describe("repo spec lint is green for catalog.yaml (AC-0C-1.4, rules 1–8, AB-20)", () => {
  it("lintRepo reports no violation in catalog.yaml", async () => {
    expect(existsSync(FILE), "contracts/openapi/catalog.yaml missing").toBe(true);
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "catalog");
    expect(v, v.map((x) => `[rule ${x.rule}] ${x.message}`).join("\n")).toEqual([]);
  });
});

describe("lint actually checks catalog.yaml (AC-0C-1.5 negative)", () => {
  // copy contracts/ into a temp root, mutate catalog.yaml there, run lintRepo on it
  const mutate = async (fn: (d: any) => void) => {
    expect(existsSync(FILE), "contracts/openapi/catalog.yaml missing").toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "c3-lint-"));
    tmps.push(dir);
    cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
    const d = parse(readFileSync(FILE, "utf8"));
    fn(d);
    writeFileSync(join(dir, "contracts/openapi/catalog.yaml"), stringify(d, { aliasDuplicateObjects: false }));
    return (await lintRepo(dir)).filter((x) => x.file === "catalog");
  };
  const firstOp = (d: any, pred: (o: any) => boolean) =>
    Object.values<any>(d.paths).flatMap((p) => METHODS.map((m) => p[m]).filter(Boolean)).find(pred);

  it("x-permission not in permissions.yaml fails", async () => {
    const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = "catalog.no_such.permission"; });
    expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
  });
  it("x-error-codes entry not in errors.yaml fails", async () => {
    const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push("catalog.no_such_error"); });
    expect(v.some((x) => x.rule === "4" && /error code/.test(x.message))).toBe(true);
  });
  it("object schema without additionalProperties:false fails", async () => {
    const v = await mutate((d) => {
      const s = Object.values<any>(d.components?.schemas ?? {}).find((x) => x?.type === "object" && x.additionalProperties === false);
      delete s.additionalProperties;
    });
    expect(v.some((x) => x.rule === "3")).toBe(true);
  });
  it("operation without x-rate-limit-tier fails", async () => {
    const v = await mutate((d) => { delete firstOp(d, (o) => "x-rate-limit-tier" in o)["x-rate-limit-tier"]; });
    expect(v.some((x) => x.rule === "4" && /x-rate-limit-tier/.test(x.message))).toBe(true);
  });
});

describe("inventory equals 02-TRD §5.2 (no missing, no extra operations)", () => {
  it("107 operations; every plain operationId named in the TRD tables is present; catalog.yaml has exactly these", () => {
    expect(ROWS.length).toBe(107);
    expect(new Set(ROWS.map((r) => r.id)).size).toBe(107);
    const lines = readFileSync(TRD, "utf8").split("\n");
    const start = lines.findIndex((l) => l.startsWith("### 5.2 Operations"));
    const end = lines.findIndex((l, i) => i > start && l.startsWith("## 6."));
    const fromTrd = new Set<string>();
    for (const l of lines.slice(start, end)) {
      const c = l.split("|");
      if (/^\s*\d+(\/\d+|–\d+)?\s*$/.test(c[1] ?? "") && c[3]) for (const m of c[3].matchAll(/`([a-z][A-Za-z0-9]+)`/g)) fromTrd.add(m[1]);
    }
    expect(fromTrd.size).toBeGreaterThan(60);
    const mine = new Set(ROWS.map((r) => r.id));
    for (const id of fromTrd) expect(mine.has(id), `TRD operationId ${id} not in test table`).toBe(true);
    expect(Object.keys(ops).sort()).toEqual([...mine].sort());
  });
  it("every path is /v1/catalog/… with tags [catalog]", () => {
    expect(Object.keys(doc.paths ?? {}).length, "no paths").toBeGreaterThan(0);
    for (const [p, item] of Object.entries<any>(doc.paths ?? {})) {
      expect(p.startsWith(`${PFX}/`), p).toBe(true);
      for (const m of METHODS) if (item[m]) expect(item[m].tags, `${m} ${p}`).toEqual(["catalog"]);
    }
  });
});

describe.each(ROWS)("$id", (r) => {
  const o = ops[r.id]?.op;
  it("exists at the TRD method + path", () => {
    expect(ops[r.id], `${r.id} missing`).toBeDefined();
    expect(`${ops[r.id].method} ${ops[r.id].path}`).toBe(`${r.method} ${r.path}`);
  });
  it("has tags [catalog], summary, x-idempotency (TRD Idem), tier general, x-error-codes", () => {
    expect(o.tags).toEqual(["catalog"]);
    expect(typeof o.summary).toBe("string");
    expect(o["x-idempotency"]).toBe(r.idem);
    expect(o["x-rate-limit-tier"]).toBe("general");
    expect(Array.isArray(o["x-error-codes"])).toBe(true);
  });
  it(`x-permission = ${r.perm}, never x-public; security bearerJwt; no identity/platform context`, () => {
    expect(o["x-permission"]).toBe(r.perm);
    expect(o["x-public"]).toBeUndefined();
    expect(o.security).toEqual([{ bearerJwt: [] }]);
    expect([undefined, "tenant"]).toContain(o["x-context"]);
    expect([undefined, "internal"]).toContain(o["x-edge-exposure"]);
  });
  // LD-10 (2026-11-07): the five read-only POSTs carry the honest `E3 ` (never a false E1/E2); state actions are `optional`.
  it(`success response ${r.status}; POST with idem none carries an E3 justification (read-only)`, () => {
    expect(Object.keys(o.responses ?? {})).toContain(String(r.status));
    if (r.method === "POST" && r.idem === "none") {
      expect(READ_ONLY_POSTS).toContain(r.id);
      expect(o["x-idempotency-justification"]).toMatch(/^E3 /);
    }
    if (READ_ONLY_POSTS.includes(r.id)) expect(r.idem).toBe("none");
  });
  it("lists the TRD specific error codes; never the retired catalog.import_invalid", () => {
    for (const c of ERRORS[r.id] ?? []) expect(o["x-error-codes"], c).toContain(c);
    expect(o["x-error-codes"]).not.toContain("catalog.import_invalid");
    if (KIND_PERM_OPS.includes(r.id)) expect(o["x-error-codes"]).toEqual(expect.arrayContaining(["auth.forbidden", "auth.mfa_required"]));
  });
  it("Idempotency-Key where x-idempotency required; If-Match per TRD §5.0", () => {
    const params = JSON.stringify(o.parameters ?? []);
    if (r.idem === "required") expect(params).toMatch(/IdempotencyKey|Idempotency-Key/);
    else if (r.idem === "none") expect(params).not.toMatch(/IdempotencyKey|Idempotency-Key/);
    const ifMatch = ["PATCH", "PUT"].includes(r.method) || IFMATCH_ACTIONS.includes(r.id);
    if (ifMatch) expect(params).toMatch(/IfMatch|If-Match/);
    if (NO_IFMATCH.includes(r.id) || r.method === "GET") expect(params).not.toMatch(/IfMatch|If-Match/);
  });
});

describe("shape pins from TRD §5", () => {
  it("every §5.1 DTO is a component schema", () => {
    for (const n of DTOS) expect(doc.components?.schemas?.[n], n).toBeDefined();
  });
  it("searchOrderables: q required 1–64; limit default 20, max 50", () => {
    const ps = (ops.searchOrderables.op.parameters ?? []).map(deref);
    const q = ps.find((p: any) => p.name === "q");
    expect(q?.required).toBe(true);
    expect(q.schema.minLength).toBe(1);
    expect(q.schema.maxLength).toBe(64);
    const lim = ps.find((p: any) => p.name === "limit");
    expect(lim?.schema.default).toBe(20);
    expect(lim.schema.maximum).toBe(50);
  });
  it("list operations take cursor + limit", () => {
    for (const id of PAGED) {
      const ps = JSON.stringify(ops[id].op.parameters ?? []);
      expect(ps, id).toMatch(/cursor|Cursor/);
      expect(ps, id).toMatch(/limit|Limit/);
    }
  });
  it("createImport: multipart/form-data, x-upload = [xlsx], 201 and 200 (deduplicated) and 429 with Retry-After", () => {
    for (const id of UPLOADS) {
      const o = ops[id].op;
      expect(Object.keys(o.requestBody?.content ?? {}), id).toContain("multipart/form-data");
      expect(o["x-upload"], id).toEqual([XLSX]);
    }
    const r = ops.createImport.op.responses;
    expect(Object.keys(r)).toEqual(expect.arrayContaining(["200", "201", "429"]));
    const h429 = Object.keys(deref(r["429"]).headers ?? {}).map((x) => x.toLowerCase());
    expect(h429).toContain("retry-after");
  });
  it("xlsx downloads: 200 content is the xlsx media type with Content-Disposition", () => {
    for (const id of XLSX_DOWNLOADS) {
      const r200 = deref(ops[id].op.responses["200"]);
      expect(Object.keys(r200.content ?? {}), id).toContain(XLSX);
      expect(Object.keys(r200.headers ?? {}).map((x) => x.toLowerCase()), id).toContain("content-disposition");
    }
  });
  it("downloadExportFile also carries nosniff + no-store headers (08 A13 P-2)", () => {
    const h = Object.keys(deref(ops.downloadExportFile.op.responses["200"]).headers ?? {}).map((x) => x.toLowerCase());
    expect(h).toEqual(expect.arrayContaining(["content-disposition", "x-content-type-options", "cache-control"]));
  });
  it("file_not_ready: report-file and export file document a 409", () => {
    for (const id of ["downloadImportReport", "downloadExportFile"]) expect(Object.keys(ops[id].op.responses), id).toContain("409");
  });
  it("createImport form: kind enum, file is binary", () => {
    const f = ops.createImport.op.requestBody.content["multipart/form-data"].schema;
    expect(deref(props(f).kind).enum).toEqual(["price_list", "catalog_master", "referrers", "credit_parties"]);
    expect(deref(props(f).file)?.format).toBe("binary");
  });
  it("Doctor / CreditParty phones use the E.164 pattern (08 A13 P-11); contact e-mail ≤ 254", () => {
    const E164 = "^\\+[1-9][0-9]{7,14}$";
    expect(deref(props(doc.components.schemas.Doctor).phone_e164).pattern).toBe(E164);
    expect(deref(props(doc.components.schemas.CreditParty).contact_phone_e164).pattern).toBe(E164);
    expect(deref(props(doc.components.schemas.Doctor).email).maxLength).toBe(254);
    expect(deref(props(doc.components.schemas.CreditParty).contact_email).maxLength).toBe(254);
  });
  it("DTO enums match TRD §5.1", () => {
    const e = (n: string, f: string) => deref(props(doc.components.schemas[n])[f]).enum;
    expect(e("Test", "workflow_type")).toEqual(["standard", "narrative", "microbiology", "anatomic", "molecular", "attachment", "outsourced"]);
    expect(e("AnalyteVersion", "status")).toEqual(["draft", "published", "superseded", "retired", "discarded"]);
    expect(e("AnalyteVersion", "result_type")).toEqual(["numeric", "text", "ordinal", "coded", "attachment", "narrative"]);
    expect(e("PriceList", "owner_kind")).toEqual(["default", "credit_party", "referrer", "centre"]);
    expect(e("CreditParty", "kind")).toEqual(["hospital", "company", "clinic", "partner_lab", "insurer", "other"]);
    expect(e("Export", "status")).toEqual(["queued", "building", "ready", "failed", "expired"]);
    expect(e("Export", "kind")).toEqual(["price_list", "catalog_master", "referrers"]);
    expect(e("Import", "kind")).toEqual(["price_list", "catalog_master", "referrers", "credit_parties"]);
    expect(e("TatTarget", "priority")).toEqual(["routine", "urgent"]);
    expect(e("TatTarget", "segment")).toEqual(["within_lab", "total"]);
  });
  it("TatTarget.target_seconds 60–2592000; PriceList.code pattern; SurchargeRule.percent_bp 1–100000", () => {
    const t = deref(props(doc.components.schemas.TatTarget).target_seconds);
    expect([t.minimum, t.maximum]).toEqual([60, 2592000]);
    expect(deref(props(doc.components.schemas.PriceList).code).pattern).toBe("^[A-Z0-9][A-Z0-9_\\-]{0,31}$");
    const b = deref(props(doc.components.schemas.SurchargeRule).percent_bp);
    expect([b.minimum, b.maximum]).toEqual([1, 100000]);
  });
  it("publishAnalyteVersion body: change_reason 1–500 required", () => {
    const b = bodySchema("publishAnalyteVersion");
    expect(b.required).toContain("change_reason");
    const c = deref(props(b).change_reason);
    expect([c.minLength, c.maxLength]).toEqual([1, 500]);
  });
});

// ---------- "Prism smoke", offline: examples validate against their schemas ----------
describe("examples validate against their schemas; each operation has a servable example (Prism smoke)", () => {
  const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
  ajv.addSchema({ ...common, id: "_common.yaml" });
  ajv.addSchema({ ...doc, id: "catalog.yaml" });
  const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
  const check = (ptr: string, example: unknown) => {
    const validate = ajv.getSchema(`catalog.yaml#${ptr}`);
    expect(validate, `cannot resolve ${ptr}`).toBeDefined();
    expect(validate!(example), `${ptr}: ${JSON.stringify(validate!.errors?.[0])}`).toBe(true);
  };
  it("every JSON request/response example matches its schema", () => {
    expect(existsSync(FILE), "contracts/openapi/catalog.yaml missing").toBe(true);
    let n = 0;
    for (const { method, path, op } of Object.values(ops)) {
      const base = `/paths/${esc(path)}/${method.toLowerCase()}`;
      const media: [string, any][] = [];
      const rb = op.requestBody;
      if (rb?.content?.["application/json"]) media.push([`${base}/requestBody/content/application~1json`, rb.content["application/json"]]);
      for (const [code, r] of Object.entries<any>(op.responses ?? {}))
        if (!r.$ref && r.content?.["application/json"]) media.push([`${base}/responses/${code}/content/application~1json`, r.content["application/json"]]);
      for (const [p, m] of media)
        for (const [k, e] of Object.entries<any>(m.examples ?? {})) {
          if (m.schema) check(`${p}/schema`, e.value);
          n++;
          expect(k.length).toBeGreaterThan(0);
        }
    }
    expect(n).toBeGreaterThan(100);
  });
  it("every operation has a 2xx response; JSON ones carry an example Prism can serve", () => {
    expect(Object.keys(ops).length).toBe(107);
    for (const { op, path, method } of Object.values(ops)) {
      const two = Object.entries<any>(op.responses ?? {}).filter(([c]) => /^2/.test(c));
      expect(two.length, `${method} ${path}: no 2xx`).toBeGreaterThan(0);
      for (const [c, r] of two) {
        const j = r.content?.["application/json"];
        if (j) expect(Object.keys(j.examples ?? {}).length, `${method} ${path} ${c}: no example`).toBeGreaterThan(0);
        else if (c !== "204" && !r.$ref) expect(Object.keys(r.content ?? {}).length, `${method} ${path} ${c}: no content`).toBeGreaterThan(0);
      }
    }
  });
});
