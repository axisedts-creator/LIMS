// T0C-TESTMGMT-1 (LD-318, LD-319, LD-325; founder 2026-11-17 08:48 NPT "test management first priority") — contracts/openapi/catalog.yaml parity fields for ElabAssist Test Management,
// the migration 20261117170000_catalog__test_management_parity.sql (static checks; behaviour is db/tests/catalog/T0C-TESTMGMT-1_test_management_parity.test.sql),
// generated-client freshness, the pending-operations rule of LD-325(b) and the implementation notes with the FIELD MAP.
// ASSUMPTIONS (brief gives labels, not wire names; a different choice needs a ruling, not a silent test edit; same style as T0C-REGPARITY-1 / T0C-ACCT-1):
//  - Wire names are the snake_case of the brief's field list, verbatim (short_name, display_name, tags, barcode_text, loyalty_points, display_order, description, report_type, processing_type, template_ref,
//    outsource_name, is_outsourced, is_popular, smart_report, print_category_wise, nabl, accab_logo, auto_approval_enabled, use_normal_range_for_auto_approval, template_test, nabl_processing_centres, font,
//    alert_before_expiry_minutes, category_id). They go on Test, TestCreate, TestUpdate (read + write), never required, closed objects kept, no `nullable` (02-CONVENTIONS: clear through unset[]).
//  - Enum wire values: report_type = lower snake_case of the ten ElabAssist labels; processing_type = local | branch_transfer | outsource_branch; result_display_type = lower snake_case of the eleven labels.
//  - Seven stage TAT: TatTargetsSet.stage_targets and Test.stage_targets = [{stage, target_minutes}] (stage in registration, sample_collection, accession, result, approval_1, approval_2, release);
//    the old `targets` (routine/urgent, seconds) is untouched (Test.tat_targets maxItems 2 stays).
//  - Category: schemas TestCategory / TestCategoryCreate / TestCategoryUpdate / TestCategoryPage; operations listTestCategories GET /v1/catalog/test-categories, createTestCategory POST (same path),
//    updateTestCategory PATCH /v1/catalog/test-categories/{category_id}; NO delete anywhere (deactivate via is_active); permissions catalog.test.read (list) / catalog.test.manage (create, update); no new code.
//  - Analyte: display-only fields on the ANALYTE row (Analyte, AnalyteCreate, AnalyteUpdate): trend_name, specimen_type_id, font, result_display_type, print_on_negative, print_on_worksheet, send_in_sms, nabl,
//    accab_logo, is_trend. Fields that change what a result means stay on the draft VERSION (AnalyteVersion, AnalyteVersionDraftInput, AnalyteVersionDraftUpdate): default_value, long_text_value, high_low,
//    require_verification, and the widened result_type (old six + boolean, test_footer, space, graph, html_descriptive; Integer/Float/Equation map to numeric, List to coded, Long Text/Single Line Text to text,
//    Descriptive to narrative, Image to attachment). Analyte display_order = the existing sort_order (field map says so).
//  - Range band: RangeBand gains third_gender in sex, instrument_id, laboratory_id, default_range, method_id, auto_approved_low, auto_approved_high; AgeBound.unit gains hour; CriticalBand gains third_gender only
//    (critical keeps its own set, no auto-approved range, no default flag).
//  - Panel: barcode_text, loyalty_points, display_order, is_popular on Panel / PanelCreate / PanelUpdate (panel_kind stays clinical | package; ElabAssist "Profile" = clinical).
//  - Notes: CommentCode / CommentCodeCreate / CommentCodeUpdate gain category_id, result_type, is_default_template, text_format (plain | markdown); text never raw HTML.
//  - Complete test list: OrderableSummary gains category_id, category_name, short_name, display_name, default_price_paisa (integer paisa, absent when no default price list price); listTests gains category_id filter.
//  - LD-325(b): the new operationIds are in pendingOperations of services/api/src/modules/catalog/index.ts (no handler task has run yet). The T0B handler task removes them.
//  - the implementer's notes are .orchestra/notes/T0C-TESTMGMT-1-impl.md (convention of every earlier T0C task).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FILE = join(ROOT, "contracts/openapi/catalog.yaml");
const MIG = "20261117170000_catalog__test_management_parity.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-TESTMGMT-1-impl.md");
const MODULE_INDEX = join(ROOT, "services/api/src/modules/catalog/index.ts");
const doc: any = parse(readFileSync(FILE, "utf8"));
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const S = doc.components.schemas as Record<string, any>;
const P = (name: string, f: string): any => S[name]?.properties?.[f] ?? {}; // a missing field fails its assertion, not with a TypeError
const enumOf = (p: any): string[] => ((p?.enum ?? []) as unknown[]).filter((x): x is string => typeof x === "string");
const sortedEq = (a: string[], b: string[]) => expect([...a].sort()).toEqual([...b].sort());
const resolveRef = (s: any): any => (s?.$ref?.startsWith("#/components/schemas/") ? S[s.$ref.split("/").pop()!] : s);
const refName = (s: any): string => String(s?.$ref ?? "").split("/").pop()!;
const isUuid = (p: any) => JSON.stringify(p).includes("Uuid");

const TEST_FIELDS = ["short_name", "display_name", "tags", "barcode_text", "loyalty_points", "display_order", "description", "report_type", "processing_type", "template_ref", "outsource_name",
  "is_outsourced", "is_popular", "smart_report", "print_category_wise", "nabl", "accab_logo", "auto_approval_enabled", "use_normal_range_for_auto_approval", "template_test",
  "nabl_processing_centres", "font", "alert_before_expiry_minutes", "category_id"];
const TEST_BOOLS = ["is_outsourced", "is_popular", "smart_report", "print_category_wise", "nabl", "accab_logo", "auto_approval_enabled", "use_normal_range_for_auto_approval", "template_test"];
const TEST_UNSET = ["short_name", "display_name", "barcode_text", "description", "template_ref", "outsource_name", "nabl_processing_centres", "font", "alert_before_expiry_minutes", "category_id"];
const REPORT_TYPES = ["four_column", "three_column", "two_column", "graph", "template_based_html", "micro_automated", "cbc_four_column", "micro_manual", "histo", "four_column_10_font"];
const PROCESSING = ["local", "branch_transfer", "outsource_branch"];
const STAGES = ["registration", "sample_collection", "accession", "result", "approval_1", "approval_2", "release"];
const ANALYTE_FIELDS = ["trend_name", "specimen_type_id", "font", "result_display_type", "print_on_negative", "print_on_worksheet", "send_in_sms", "nabl", "accab_logo", "is_trend"];
const ANALYTE_BOOLS = ["print_on_negative", "print_on_worksheet", "send_in_sms", "nabl", "accab_logo", "is_trend"];
const DISPLAY_TYPES = ["table", "note_value_only", "list_note", "one_column", "two_column", "three_column", "four_column", "comment", "hidden", "table_with_subheader", "merge_two_column"];
const VERSION_FIELDS = ["default_value", "long_text_value", "high_low", "require_verification"];
const OLD_RESULT_TYPES = ["numeric", "text", "ordinal", "coded", "attachment", "narrative"];
const NEW_RESULT_TYPES = ["boolean", "test_footer", "space", "graph", "html_descriptive"];
const BAND_FIELDS = ["instrument_id", "laboratory_id", "default_range", "method_id", "auto_approved_low", "auto_approved_high"];
const PANEL_FIELDS = ["barcode_text", "loyalty_points", "display_order", "is_popular"];
const NOTE_FIELDS = ["category_id", "result_type", "is_default_template", "text_format"];
const SUMMARY_FIELDS = ["category_id", "category_name", "short_name", "display_name", "default_price_paisa"];
const NEW_OPS: Record<string, { method: string; path: string; perm: string; idem: string; ok: string }> = {
  listTestCategories: { method: "get", path: "/v1/catalog/test-categories", perm: "catalog.test.read", idem: "none", ok: "200" },
  createTestCategory: { method: "post", path: "/v1/catalog/test-categories", perm: "catalog.test.manage", idem: "required", ok: "201" },
  updateTestCategory: { method: "patch", path: "/v1/catalog/test-categories/{category_id}", perm: "catalog.test.manage", idem: "none", ok: "200" },
};
// every ElabAssist field label of C:/LIMS-state/elabassist-testmgmt-20261117.md: the impl notes must carry one decision line for each (done_when 1)
const LABELS = [
  // Add Test
  "Test Name", "Test Short Name", "Test Display Name", "Select Category", "Select Group", "Select Font", "SubHeaders", "Barcode", "Loyalty Point", "Test display Order", "Test Description", "Tags",
  "TestCode/LoincCode", "Company", "Tabular Report Type", "Report Type", "Test Processing Type", "Template", "IsOutSourcing", "Select OutSource Name", "IsPopular", "Smart Report", "Print Category Wise",
  "ISNABL Test", "Enable Test For Auto Approval", "ACCAB Logo Test", "Use Normal Range for Test Level Auto Approval", "Template Test", "Select NABL Processing Centre", "Alert Before Expiry Minutes",
  "Registration", "Sample Collection", "Accession", "Result", "Approval 1", "Approval 2", "Release",
  // Add Test Parameter
  "Parameter Name", "Parameter Short Name", "Trend Report Parameter Name", "Unit", "Display Order", "Selected Font", "Sub Header", "Result Type", "Result Display Type", "Default Value", "Equation Value",
  "Long Text Value", "High - Low", "Decimal Places", "Method", "Require Verification", "Print on Negative Value", "Print on WorkSheet", "Send Result In SMS", "IsParamNABL", "IsParamACCABLogo", "IsTrendReport",
  "Reference Range",
  // Reference Range Manage
  "Range Name", "Select Range", "From", "To", "Gender", "Laboratory", "Machine", "Default Range", "Normal Low", "Normal High", "Critical Low", "Critical High", "Copy Normal Range", "Approved Low",
  "Approved High", "Show Display Range", "Display Range",
  // Category / Group / Profile / Unit / Notes / Popular / Complete list
  "Test Category Name", "Category Footer Text", "Department", "Print Category Footer", "Test Group", "Bar Code", "Profile Code", "Profile or Package", "Test Unit Name",
  "Note Short Name", "Details", "Default Template", "Select Type", "Charge",
];

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ ...common, id: "_common.yaml" });
ajv.addSchema({ ...doc, id: "catalog.yaml" });
const validator = (name: string) => {
  const v = ajv.getSchema(`catalog.yaml#/components/schemas/${name}`);
  expect(v, `cannot resolve ${name}`).toBeDefined();
  return v!;
};
const opOf = (id: string): { method: string; path: string; op: any } | undefined => {
  for (const [path, item] of Object.entries<any>(doc.paths)) for (const m of ["get", "put", "post", "delete", "patch"]) if (item[m]?.operationId === id) return { method: m, path, op: item[m] };
  return undefined;
};
const allOps = (): string[] => Object.values<any>(doc.paths).flatMap((item) => ["get", "put", "post", "delete", "patch"].filter((m) => item[m]).map((m) => item[m].operationId as string));

const UUID = "0193c4a0-0000-7000-8000-0000000000aa";
const TEST_BODY = {
  short_name: "HM011", display_name: "COMPLETE BLOOD COUNT, EDTA WB(HM011)", tags: ["cbc", "haematology"], barcode_text: "CBC", loyalty_points: 5, display_order: 10, description: "Synthetic description",
  report_type: "cbc_four_column", processing_type: "local", template_ref: "SYN-TEMPLATE-1", outsource_name: "Synthetic Outsource Lab", is_outsourced: false, is_popular: true, smart_report: false,
  print_category_wise: false, nabl: true, accab_logo: false, auto_approval_enabled: false, use_normal_range_for_auto_approval: false, template_test: false, nabl_processing_centres: ["Synthetic Centre A"],
  font: "Arial", alert_before_expiry_minutes: 120, category_id: UUID,
};
const STAGE_TARGETS = STAGES.map((stage, i) => ({ stage, target_minutes: 10 * (i + 1) }));

describe("T0C-TESTMGMT-1 contract: catalog.yaml lint and additive baseline", () => {
  it("lintRepo reports no violation for catalog.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "catalog.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });

  it("is additive: the 107 original operations keep method, path, permission and idempotency; exactly 3 new operations", () => {
    const ids = allOps();
    // T0C-PRICETOOLS-1 (LD-321) adds 7 price list tool operations on top (pinned in pricetools1-openapi.test.ts): 107 original + 3 category operations + 7 = 117; T0C-TESTIMPORT-1 (LD-318) adds 6 Excel test import operations (pinned in testimport1-openapi.test.ts): 123
    expect(ids.length, "107 original + 3 category operations + 7 price list tool operations + 6 test import operations").toBe(123);
    expect(new Set(ids).size).toBe(123);
    for (const id of ["getCatalogRevision", "searchOrderables", "listDepartments", "listTests", "createTest", "getTestDetail", "updateTest", "setTestTatTargets", "createAnalyte", "updateAnalyte",
      "createAnalyteVersionDraft", "updateAnalyteVersionDraft", "publishAnalyteVersion", "validateFormula", "createReferenceRangeSetDraft", "replaceReferenceRangeSetBands", "publishReferenceRangeSet",
      "replaceCriticalLimitSetBands", "listPanels", "createPanel", "updatePanel", "listCommentCodes", "createCommentCode", "updateCommentCode", "listUnits", "listMethods", "listValueSets"]) expect(opOf(id), id).toBeDefined();
    expect(opOf("listTests")!.path).toBe("/v1/catalog/tests");
    expect(opOf("setTestTatTargets")!.op["x-permission"]).toBe("catalog.test.manage");
    expect(opOf("publishAnalyteVersion")!.op["x-permission"], "publish keeps its own permission (pathologist sign-off stays the gate)").not.toBe("catalog.test.manage");
    for (const id of Object.keys(NEW_OPS)) expect(opOf(id), `${id} missing`).toBeDefined();
  });

  it("required lists of the existing schemas are unchanged (no field became required)", () => {
    sortedEq(S.TestCreate.required, ["code", "name", "department_id", "workflow_type", "specimen_requirements"]);
    expect(S.TestUpdate.required ?? []).toEqual([]);
    sortedEq(S.Test.required, ["id", "kind", "code", "name", "is_orderable", "is_active", "revision", "department_id", "workflow_type", "report_order", "uses_existing_material", "specimen_requirements",
      "analytes", "tat_targets", "version"]);
    sortedEq(S.AnalyteCreate.required, ["code", "name", "initial_version"]);
    expect(S.AnalyteUpdate.required ?? []).toEqual([]);
    sortedEq(S.AnalyteVersionDraftInput.required, ["result_type"]);
    sortedEq(S.RangeBand.required, ["sex", "kind", "sort_order"]);
    sortedEq(S.CriticalBand.required, ["sex"]);
    sortedEq(S.AgeBound.required, ["value", "unit"]);
    sortedEq(S.PanelCreate.required, ["code", "name", "panel_kind", "members"]);
    sortedEq(S.CommentCodeCreate.required, ["code", "text"]);
    expect(S.PanelUpdate.required ?? []).toEqual([]);
    expect(S.CommentCodeUpdate.required ?? []).toEqual([]);
    sortedEq(S.TatTargetsSet.required, ["targets"]);
    expect(S.Test.properties.tat_targets.maxItems).toBe(2);
    sortedEq(enumOf(P("Test", "workflow_type")), ["standard", "narrative", "microbiology", "anatomic", "molecular", "attachment", "outsourced"]);
    sortedEq(enumOf(P("Panel", "panel_kind")), ["clinical", "package"]);
  });

  it("no pagination / filter convention is lost: listTests still has department_id, workflow_type, is_active, sort, Cursor, Limit", () => {
    const names = (opOf("listTests")!.op.parameters as any[]).map((p) => p.name ?? p.$ref?.split("/").pop());
    for (const n of ["department_id", "workflow_type", "is_active", "sort", "Cursor", "Limit"]) expect(names, `listTests param ${n}`).toContain(n);
  });
});

describe("T0C-TESTMGMT-1 contract: Test fields (done_when 2)", () => {
  for (const name of ["Test", "TestCreate", "TestUpdate"]) {
    it(`${name} declares the 24 test fields, none required, closed object kept, none nullable`, () => {
      expect(S[name].additionalProperties).toBe(false);
      for (const f of TEST_FIELDS) {
        expect(S[name].properties?.[f], `${name}.${f}`).toBeDefined();
        expect(S[name].required ?? [], `${name}.${f} must not be required`).not.toContain(f);
        expect(P(name, f).nullable, `${name}.${f} must not be nullable`).not.toBe(true);
      }
    });
    it(`${name}: types, bounds and enums`, () => {
      for (const f of TEST_BOOLS) expect(P(name, f).type, `${name}.${f}`).toBe("boolean");
      for (const f of ["short_name", "barcode_text", "template_ref", "outsource_name", "font", "description", "display_name"]) {
        const p = P(name, f);
        expect(p.type, `${name}.${f}`).toBe("string");
        expect(Number.isInteger(p.maxLength) && p.maxLength > 0 && p.maxLength <= 2000, `${name}.${f} maxLength`).toBe(true);
      }
      expect(P(name, "display_name").minLength, "ElabAssist: display name min 3 chars").toBe(3);
      expect(P(name, "loyalty_points")).toMatchObject({ type: "integer", minimum: 0 });
      expect(typeof P(name, "loyalty_points").maximum).toBe("number");
      expect(P(name, "display_order")).toMatchObject({ type: "integer", minimum: 0 });
      expect(P(name, "alert_before_expiry_minutes")).toMatchObject({ type: "integer", minimum: 0 });
      expect(typeof P(name, "alert_before_expiry_minutes").maximum).toBe("number");
      expect(isUuid(P(name, "category_id"))).toBe(true);
      const rt = enumOf(P(name, "report_type"));
      for (const t of REPORT_TYPES) expect(rt, `${name}.report_type has ${t}`).toContain(t);
      sortedEq(enumOf(P(name, "processing_type")), PROCESSING);
      for (const f of ["report_type", "processing_type"]) for (const v of enumOf(P(name, f))) expect(v.length <= P(name, f).maxLength, `${name}.${f} maxLength fits "${v}"`).toBe(true);
      const tags = P(name, "tags");
      expect(tags.type).toBe("array");
      expect(tags.uniqueItems, "tags unique").toBe(true);
      expect(tags.maxItems > 0 && tags.maxItems <= 50).toBe(true);
      expect(tags.items?.type).toBe("string");
      expect(tags.items?.minLength).toBeGreaterThanOrEqual(1);
      expect(tags.items?.maxLength).toBeLessThanOrEqual(60);
      expect(String(tags.description ?? "")).toMatch(/at least one/i);
      expect(String(tags.description ?? "")).toMatch(/orderable/i);
      const c = P(name, "nabl_processing_centres");
      expect(c.type).toBe("array");
      expect(typeof c.maxItems).toBe("number");
      expect(c.items?.type).toBe("string");
      expect(typeof c.items?.maxLength).toBe("number");
    });
  }

  it("TestUpdate can clear every optional text/list field through unset[] (no null on the wire)", () => {
    const u = S.TestUpdate.properties.unset;
    expect(u?.type, "TestUpdate.unset").toBe("array");
    for (const f of TEST_UNSET) expect(u.items.enum as string[], `${f} clearable via unset[]`).toContain(f);
    expect(u.maxItems).toBeGreaterThanOrEqual(u.items.enum.length);
    for (const v of u.items.enum as string[]) expect(v.length <= u.items.maxLength, `unset item maxLength fits ${v}`).toBe(true);
  });

  it("seven stage TAT in minutes: TatTargetsSet.stage_targets and Test.stage_targets; the old seconds targets are kept", () => {
    for (const name of ["TatTargetsSet", "Test"]) {
      const st = P(name, "stage_targets");
      expect(st.type, `${name}.stage_targets`).toBe("array");
      expect(st.maxItems, `${name}.stage_targets maxItems`).toBe(7);
      const item = resolveRef(st.items);
      expect(item?.additionalProperties).toBe(false);
      sortedEq(item?.required ?? [], ["stage", "target_minutes"]);
      sortedEq(enumOf(item?.properties?.stage), STAGES);
      for (const v of STAGES) expect(v.length <= item.properties.stage.maxLength, `stage maxLength fits ${v}`).toBe(true);
      expect(item?.properties?.target_minutes).toMatchObject({ type: "integer" });
      expect(item.properties.target_minutes.minimum).toBeGreaterThanOrEqual(0);
      expect(typeof item.properties.target_minutes.maximum).toBe("number");
      expect(S[name].required ?? []).not.toContain("stage_targets");
    }
    expect(P("TatTargetsSet", "targets").maxItems).toBe(2);
    expect(String(opOf("setTestTatTargets")!.op.summary ?? "") + JSON.stringify(P("TatTargetsSet", "stage_targets").description ?? "")).toMatch(/minute/i);
  });

  it("OrderableSummary (complete test list) carries category, short name, display name and the default price; listTests filters by category", () => {
    for (const f of SUMMARY_FIELDS) {
      expect(S.OrderableSummary.properties[f], `OrderableSummary.${f}`).toBeDefined();
      expect(S.OrderableSummary.required).not.toContain(f);
    }
    expect(isUuid(P("OrderableSummary", "category_id"))).toBe(true);
    expect(P("OrderableSummary", "default_price_paisa")).toMatchObject({ type: "integer", minimum: 0 });
    expect(String(P("OrderableSummary", "default_price_paisa").description ?? "")).toMatch(/default price list/i);
    const q = (opOf("listTests")!.op.parameters as any[]).find((p) => p.name === "category_id");
    expect(q, "listTests category_id query filter").toBeDefined();
    expect(q.in).toBe("query");
    expect(isUuid(q.schema)).toBe(true);
  });
});

describe("T0C-TESTMGMT-1 contract: test category operations (done_when 3)", () => {
  for (const [id, want] of Object.entries(NEW_OPS)) {
    it(`${id}: ${want.method.toUpperCase()} ${want.path}, ${want.perm}, idempotency ${want.idem}, ${want.ok}`, () => {
      const o = opOf(id);
      expect(o, `${id} missing`).toBeDefined();
      expect(o!.method).toBe(want.method);
      expect(o!.path).toBe(want.path);
      expect(o!.op.tags).toEqual(["catalog"]);
      expect(o!.op["x-permission"]).toBe(want.perm);
      expect(o!.op["x-idempotency"]).toBe(want.idem);
      expect(o!.op["x-rate-limit-tier"]).toBe("general");
      expect(o!.op["x-context"]).toBe("tenant");
      expect(o!.op.security).toEqual([{ bearerJwt: [] }]);
      expect(Object.keys(o!.op.responses)).toContain(want.ok);
      for (const c of ["401", "403", "429", "500"]) expect(Object.keys(o!.op.responses), `${id} ${c}`).toContain(c);
    });
  }
  it("no delete operation on test categories (deactivate, never delete)", () => {
    for (const [p, item] of Object.entries<any>(doc.paths)) if (p.startsWith("/v1/catalog/test-categories")) expect(item.delete, `DELETE ${p}`).toBeUndefined();
    expect(allOps().filter((id) => /delete/i.test(id) && /categor/i.test(id))).toEqual([]);
  });
  it("create needs Idempotency-Key; update needs If-Match; both document their conflict codes", () => {
    const create = opOf("createTestCategory")!.op;
    expect(JSON.stringify(create.parameters)).toContain("IdempotencyKey");
    expect(create["x-error-codes"]).toContain("common.idempotency_key_reused");
    const upd = opOf("updateTestCategory")!.op;
    expect(JSON.stringify(upd.parameters)).toContain("IfMatch");
    expect(upd["x-error-codes"]).toEqual(expect.arrayContaining(["common.version_conflict", "common.precondition_required"]));
    expect(Object.keys(upd.responses)).toEqual(expect.arrayContaining(["409", "428"]));
    const p = (upd.parameters as any[]).find((x) => x.name === "category_id");
    expect(p?.in).toBe("path");
    expect(isUuid(p?.schema)).toBe(true);
  });
  it("list has department_id and is_active filters, sort, Cursor and Limit and returns TestCategoryPage", () => {
    const o = opOf("listTestCategories")!.op;
    const names = (o.parameters as any[]).map((p) => p.name ?? p.$ref?.split("/").pop());
    for (const n of ["department_id", "is_active", "sort", "Cursor", "Limit"]) expect(names, `param ${n}`).toContain(n);
    expect(refName(o.responses["200"].content["application/json"].schema)).toBe("TestCategoryPage");
    expect(refName(opOf("createTestCategory")!.op.requestBody.content["application/json"].schema)).toBe("TestCategoryCreate");
    expect(refName(opOf("updateTestCategory")!.op.requestBody.content["application/json"].schema)).toBe("TestCategoryUpdate");
    expect(refName(opOf("createTestCategory")!.op.responses["201"].content["application/json"].schema)).toBe("TestCategory");
    expect(refName(opOf("updateTestCategory")!.op.responses["200"].content["application/json"].schema)).toBe("TestCategory");
  });
  it("schemas: TestCategory read model, create, update, page", () => {
    for (const n of ["TestCategory", "TestCategoryCreate", "TestCategoryUpdate", "TestCategoryPage"]) {
      expect(S[n], n).toBeDefined();
      expect(S[n].additionalProperties, `${n} closed`).toBe(false);
    }
    for (const n of ["TestCategory", "TestCategoryCreate", "TestCategoryUpdate"]) {
      for (const f of ["name", "display_order", "print_footer", "footer_text", "is_active"]) expect(S[n].properties[f], `${n}.${f}`).toBeDefined();
      expect(S[n].properties.name).toMatchObject({ type: "string", minLength: 1 });
      expect(S[n].properties.name.maxLength).toBeLessThanOrEqual(200);
      expect(S[n].properties.display_order).toMatchObject({ type: "integer", minimum: 0 });
      expect(S[n].properties.print_footer.type).toBe("boolean");
      expect(S[n].properties.footer_text.type).toBe("string");
      expect(S[n].properties.footer_text.maxLength).toBeLessThanOrEqual(2000);
      expect(S[n].properties.is_active.type).toBe("boolean");
    }
    expect(isUuid(S.TestCategory.properties.department_id)).toBe(true);
    expect(isUuid(S.TestCategoryCreate.properties.department_id)).toBe(true);
    sortedEq(S.TestCategoryCreate.required, ["department_id", "name"]);
    expect(S.TestCategoryUpdate.required ?? []).toEqual([]);
    expect(S.TestCategory.required).toEqual(expect.arrayContaining(["id", "department_id", "name", "is_active", "version"]));
    expect(S.TestCategoryUpdate.properties.unset?.items?.enum, "footer_text clearable").toContain("footer_text");
    expect(S.TestCategoryPage.required).toEqual(expect.arrayContaining(["data", "page"]));
    expect(refName(S.TestCategoryPage.properties.data.items)).toBe("TestCategory");
    expect(S.TestCategoryPage.properties.data.maxItems).toBeLessThanOrEqual(200);
  });
  it("examples exist, validate against the schemas and are synthetic", () => {
    const ex = (m: any) => Object.values<any>(m?.examples ?? {}).map((e) => e.value);
    const lst = ex(opOf("listTestCategories")!.op.responses["200"].content["application/json"]);
    const crReq = ex(opOf("createTestCategory")!.op.requestBody.content["application/json"]);
    const crRes = ex(opOf("createTestCategory")!.op.responses["201"].content["application/json"]);
    const upReq = ex(opOf("updateTestCategory")!.op.requestBody.content["application/json"]);
    const upRes = ex(opOf("updateTestCategory")!.op.responses["200"].content["application/json"]);
    for (const [vals, schema] of [[lst, "TestCategoryPage"], [crReq, "TestCategoryCreate"], [crRes, "TestCategory"], [upReq, "TestCategoryUpdate"], [upRes, "TestCategory"]] as const) {
      expect(vals.length, `${schema} example`).toBeGreaterThan(0);
      for (const e of vals) { const v = validator(schema); expect(v(e), `${schema}: ${JSON.stringify(v.errors?.[0])}`).toBe(true); }
    }
    expect(JSON.stringify([lst, crReq, crRes]).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/)).toBeNull();
  });
  it("payloads: a good create passes; bad values and unknown keys are rejected", () => {
    const v = validator("TestCategoryCreate");
    const ok = { department_id: UUID, name: "Hematology", display_order: 1, print_footer: true, footer_text: "Synthetic footer", is_active: true };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ department_id: UUID, name: "Minimal" })).toBe(true);
    for (const bad of [{ name: "" }, { name: "x".repeat(500) }, { department_id: "nope" }, { display_order: -1 }, { print_footer: "yes" }, { footer_text: "x".repeat(5000) }, { unknown_field: 1 }, { is_active: null }]) {
      expect(v({ ...ok, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(v({ name: "No department" }), "department_id is required").toBe(false);
    const u = validator("TestCategoryUpdate");
    expect(u({ name: "Renamed", is_active: false })).toBe(true);
    expect(u({ unset: ["footer_text"] })).toBe(true);
    for (const bad of [{ display_order: -5 }, { name: "" }, { unknown_field: 1 }, { department_id: UUID, extra: 1 }]) expect(u(bad), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });
});

describe("T0C-TESTMGMT-1 contract: test payloads (ajv)", () => {
  const baseCreate = { code: "HM011", name: "Complete Blood Count", department_id: UUID, workflow_type: "standard", specimen_requirements: [] as unknown[] };
  it("old minimal TestCreate still validates; full parity TestCreate and TestUpdate validate", () => {
    const v = validator("TestCreate");
    expect(v(baseCreate), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ ...baseCreate, ...TEST_BODY }), JSON.stringify(v.errors?.[0])).toBe(true);
    const u = validator("TestUpdate");
    expect(u(TEST_BODY), JSON.stringify(u.errors?.[0])).toBe(true);
    expect(u({ unset: TEST_UNSET }), JSON.stringify(u.errors?.[0])).toBe(true);
    expect(u({ name: "Renamed" })).toBe(true);
  });
  it("bad values are rejected (negative loyalty points, unknown enums, short display name, null, unknown key, duplicate tags)", () => {
    const v = validator("TestCreate");
    const u = validator("TestUpdate");
    for (const bad of [{ loyalty_points: -1 }, { report_type: "five_column" }, { processing_type: "courier" }, { display_name: "ab" }, { short_name: null }, { tags: ["a", "a"] }, { tags: "cbc" },
      { category_id: "x" }, { alert_before_expiry_minutes: -1 }, { is_popular: "yes" }, { display_order: -1 }, { unknown_field: 1 }, { nabl_processing_centres: "x" }]) {
      expect(v({ ...baseCreate, ...bad }), `TestCreate accepted ${JSON.stringify(bad)}`).toBe(false);
      expect(u(bad), `TestUpdate accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });
  it("stage_targets validate: seven stages ok; unknown stage, extra key, negative minutes, eight items rejected; old targets untouched", () => {
    const v = validator("TatTargetsSet");
    expect(v({ targets: [] }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ targets: [{ priority: "routine", segment: "within_lab", target_seconds: 3600 }] }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ targets: [], stage_targets: STAGE_TARGETS }), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [[{ stage: "packing", target_minutes: 5 }], [{ stage: "result", target_minutes: -1 }], [{ stage: "result", target_minutes: 5, x: 1 }], [{ stage: "result" }],
      [...STAGE_TARGETS, { stage: "release", target_minutes: 1 }]]) expect(v({ targets: [], stage_targets: bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });
  it("examples of createTest / updateTest / getTestDetail / setTestTatTargets show new fields and validate", () => {
    const ex = (m: any) => Object.values<any>(m?.examples ?? {}).map((e) => e.value);
    const cases: [string, any[], string][] = [
      ["createTest request", ex(opOf("createTest")!.op.requestBody.content["application/json"]), "TestCreate"],
      ["createTest 201", ex(opOf("createTest")!.op.responses["201"].content["application/json"]), "Test"],
      ["getTestDetail 200", ex(opOf("getTestDetail")!.op.responses["200"].content["application/json"]), "Test"],
      ["setTestTatTargets request", ex(opOf("setTestTatTargets")!.op.requestBody.content["application/json"]), "TatTargetsSet"],
    ];
    for (const [label, vals, schema] of cases) {
      expect(vals.length, `${label} example`).toBeGreaterThan(0);
      for (const e of vals) { const v = validator(schema); expect(v(e), `${label}: ${JSON.stringify(v.errors?.[0])}`).toBe(true); }
    }
    expect(cases[3][1].some((e) => Array.isArray(e.stage_targets) && e.stage_targets.length === 7), "setTestTatTargets example shows the seven stages").toBe(true);
    expect(cases[0][1].some((e) => TEST_FIELDS.some((f) => f in e)), "createTest example uses a new field").toBe(true);
    expect(cases[2][1].some((e) => TEST_FIELDS.filter((f) => f in e).length >= 8), "getTestDetail example shows at least 8 new fields").toBe(true);
  });
});

describe("T0C-TESTMGMT-1 contract: analyte fields (done_when 4)", () => {
  for (const name of ["Analyte", "AnalyteCreate", "AnalyteUpdate"]) {
    it(`${name} carries the display-only fields, none required, none nullable, version-side fields NOT here`, () => {
      expect(S[name].additionalProperties).toBe(false);
      for (const f of ANALYTE_FIELDS) {
        expect(S[name].properties?.[f], `${name}.${f}`).toBeDefined();
        expect(S[name].required ?? []).not.toContain(f);
        expect(P(name, f).nullable).not.toBe(true);
      }
      for (const f of ANALYTE_BOOLS) expect(P(name, f).type, `${name}.${f}`).toBe("boolean");
      for (const f of ["trend_name", "font"]) { expect(P(name, f).type).toBe("string"); expect(P(name, f).maxLength).toBeLessThanOrEqual(120); }
      expect(isUuid(P(name, "specimen_type_id"))).toBe(true);
      sortedEq(enumOf(P(name, "result_display_type")), DISPLAY_TYPES);
      for (const v of DISPLAY_TYPES) expect(v.length <= P(name, "result_display_type").maxLength, `maxLength fits ${v}`).toBe(true);
      for (const f of VERSION_FIELDS) expect(S[name].properties?.[f], `${name}.${f} changes what a result means: draft version only`).toBeUndefined();
    });
  }
  it("AnalyteUpdate clears the optional display fields through unset[]", () => {
    const u = S.AnalyteUpdate.properties.unset;
    expect(u?.type, "AnalyteUpdate.unset").toBe("array");
    for (const f of ["trend_name", "specimen_type_id", "font", "result_display_type"]) expect(u.items.enum as string[], f).toContain(f);
  });
  for (const name of ["AnalyteVersion", "AnalyteVersionDraftInput", "AnalyteVersionDraftUpdate"]) {
    it(`${name}: default_value, long_text_value, high_low, require_verification and the widened result_type; display fields NOT here`, () => {
      expect(S[name].additionalProperties).toBe(false);
      for (const f of VERSION_FIELDS) { expect(S[name].properties?.[f], `${name}.${f}`).toBeDefined(); expect(S[name].required ?? []).not.toContain(f); expect(P(name, f).nullable).not.toBe(true); }
      expect(P(name, "default_value")).toMatchObject({ type: "string" });
      expect(P(name, "default_value").maxLength).toBeLessThanOrEqual(500);
      expect(P(name, "long_text_value")).toMatchObject({ type: "string" });
      expect(P(name, "long_text_value").maxLength).toBeLessThanOrEqual(20000);
      expect(JSON.stringify(P(name, "high_low")), "high_low is a DecimalString, never a float").toContain("DecimalString");
      expect(P(name, "require_verification").type).toBe("boolean");
      const rt = enumOf(P(name, "result_type"));
      for (const t of [...OLD_RESULT_TYPES, ...NEW_RESULT_TYPES]) expect(rt, `${name}.result_type has ${t}`).toContain(t);
      for (const t of rt) expect(t.length <= P(name, "result_type").maxLength, `${name}.result_type maxLength fits ${t}`).toBe(true);
      for (const f of ANALYTE_FIELDS) expect(S[name].properties?.[f], `${name}.${f} is display only: analyte row`).toBeUndefined();
    });
  }
  it("AnalyteVersionDraftUpdate clears default_value, long_text_value and high_low through unset[]", () => {
    const u = S.AnalyteVersionDraftUpdate.properties.unset;
    for (const f of ["unit_code", "decimals", "method_id", "value_set_code", "formula_expression", "default_value", "long_text_value", "high_low"]) expect(u.items.enum as string[], f).toContain(f);
    expect(u.maxItems).toBeGreaterThanOrEqual(u.items.enum.length);
    for (const v of u.items.enum as string[]) expect(v.length <= u.items.maxLength, `unset maxLength fits ${v}`).toBe(true);
  });
  it("payloads: the old draft input still validates; new fields validate; bad values rejected", () => {
    const v = validator("AnalyteVersionDraftInput");
    expect(v({ result_type: "numeric", decimals: 1, unit_code: "g_dl" }), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const t of NEW_RESULT_TYPES) expect(v({ result_type: t }), `${t}: ${JSON.stringify(v.errors?.[0])}`).toBe(true);
    expect(v({ result_type: "numeric", decimals: 1, default_value: "0", high_low: "9.5", require_verification: true, long_text_value: "Synthetic" }), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ result_type: "float" }, { high_low: 9.5 }, { high_low: "abc" }, { require_verification: "yes" }, { default_value: "x".repeat(5000) }, { unknown_field: 1 }]) expect(v({ result_type: "numeric", decimals: 1, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    const a = validator("AnalyteCreate");
    const base = { code: "HB", name: "Haemoglobin", initial_version: { result_type: "numeric", decimals: 1 } };
    expect(a(base)).toBe(true);
    expect(a({ ...base, trend_name: "HB trend", specimen_type_id: UUID, font: "Arial", result_display_type: "four_column", print_on_negative: true, print_on_worksheet: false, send_in_sms: false, nabl: true, accab_logo: false, is_trend: true }),
      JSON.stringify(a.errors?.[0])).toBe(true);
    for (const bad of [{ result_display_type: "five_column" }, { specimen_type_id: "x" }, { print_on_negative: "yes" }, { default_value: "1" }]) expect(a({ ...base, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });
});

describe("T0C-TESTMGMT-1 contract: reference range bands (done_when 5)", () => {
  it("RangeBand: third_gender, instrument, laboratory, default flag, method, auto approved low/high; display_text kept", () => {
    sortedEq(enumOf(P("RangeBand", "sex")), ["any", "male", "female", "third_gender"]);
    expect(P("RangeBand", "sex").maxLength).toBeGreaterThanOrEqual("third_gender".length);
    for (const f of BAND_FIELDS) { expect(S.RangeBand.properties[f], `RangeBand.${f}`).toBeDefined(); expect(S.RangeBand.required).not.toContain(f); expect(P("RangeBand", f).nullable).not.toBe(true); }
    for (const f of ["instrument_id", "laboratory_id", "method_id"]) expect(isUuid(P("RangeBand", f)), f).toBe(true);
    expect(P("RangeBand", "default_range").type).toBe("boolean");
    for (const f of ["auto_approved_low", "auto_approved_high", "low", "high"]) expect(JSON.stringify(P("RangeBand", f)), `${f} DecimalString`).toContain("DecimalString");
    expect(P("RangeBand", "display_text").maxLength).toBe(500);
    expect(S.RangeBand.additionalProperties).toBe(false);
  });
  it("age unit gains hour and keeps day, week, month, year (no existing band changes meaning)", () => {
    sortedEq(enumOf(P("AgeBound", "unit")), ["hour", "day", "week", "month", "year"]);
    expect(P("AgeBound", "unit").maxLength).toBeGreaterThanOrEqual("month".length);
    expect(P("AgeBound", "value")).toMatchObject({ type: "integer", minimum: 0 });
  });
  it("critical band keeps its own set: third_gender yes, no auto approved range, no default flag, no machine / lab / method fields", () => {
    sortedEq(enumOf(P("CriticalBand", "sex")), ["any", "male", "female", "third_gender"]);
    for (const f of ["auto_approved_low", "auto_approved_high", "default_range", "display_text"]) expect(S.CriticalBand.properties[f], `CriticalBand.${f} must not exist`).toBeUndefined();
    expect(S.CriticalBand.additionalProperties).toBe(false);
  });
  it("payloads: a full band validates; old band still validates; bad values rejected", () => {
    const v = validator("RangeBand");
    const old = { sex: "any", kind: "numeric", low: "1", high: "2", sort_order: 1 };
    expect(v(old)).toBe(true);
    const full = { ...old, sex: "third_gender", age_low: { value: 0, unit: "hour" }, age_high: { value: 72, unit: "hour" }, instrument_id: UUID, laboratory_id: UUID, default_range: true, method_id: UUID,
      auto_approved_low: "1.5", auto_approved_high: "1.8", display_text: "Synthetic display range" };
    expect(v(full), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ sex: "other" }, { age_low: { value: 1, unit: "minute" } }, { default_range: "yes" }, { auto_approved_low: 1.5 }, { instrument_id: "x" }, { auto_approved_high: "abc" }, { unknown_field: 1 }]) {
      expect(v({ ...full, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
    const c = validator("CriticalBand");
    expect(c({ sex: "third_gender", low: "1" }), JSON.stringify(c.errors?.[0])).toBe(true);
    expect(c({ sex: "any", auto_approved_low: "1" }), "critical band must not take the auto approved range").toBe(false);
  });
  it("band examples (replaceReferenceRangeSetBands) still validate", () => {
    const o = opOf("replaceReferenceRangeSetBands")!.op;
    const vals = Object.values<any>(o.requestBody.content["application/json"].examples ?? {}).map((e) => e.value);
    expect(vals.length).toBeGreaterThan(0);
    const schema = refName(o.requestBody.content["application/json"].schema);
    for (const e of vals) { const v = validator(schema); expect(v(e), JSON.stringify(v.errors?.[0])).toBe(true); }
  });
});

describe("T0C-TESTMGMT-1 contract: panels and notes (done_when 6, 7)", () => {
  for (const name of ["Panel", "PanelCreate", "PanelUpdate"]) {
    it(`${name}: barcode_text, loyalty_points, display_order, is_popular; panel_kind unchanged`, () => {
      expect(S[name].additionalProperties).toBe(false);
      for (const f of PANEL_FIELDS) { expect(S[name].properties?.[f], `${name}.${f}`).toBeDefined(); expect(S[name].required ?? []).not.toContain(f); expect(P(name, f).nullable).not.toBe(true); }
      expect(P(name, "barcode_text")).toMatchObject({ type: "string" });
      expect(P(name, "barcode_text").maxLength).toBeLessThanOrEqual(64);
      expect(P(name, "loyalty_points")).toMatchObject({ type: "integer", minimum: 0 });
      expect(P(name, "display_order")).toMatchObject({ type: "integer", minimum: 0 });
      expect(P(name, "is_popular").type).toBe("boolean");
    });
  }
  it("PanelUpdate clears barcode_text through unset[]; panel payloads validate and reject negative loyalty points", () => {
    expect(S.PanelUpdate.properties.unset?.items?.enum, "PanelUpdate.unset").toContain("barcode_text");
    const v = validator("PanelCreate");
    const base = { code: "ML001", name: "Advanced Diabetes Screening", panel_kind: "clinical", members: [{ kind: "test", orderable_id: UUID, sort_order: 1 }] };
    const ok = { ...base, barcode_text: "ADS", loyalty_points: 0, display_order: 3, is_popular: true };
    expect(v(base), `old PanelCreate payload must still validate: ${JSON.stringify(v.errors?.[0])}`).toBe(true);
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ loyalty_points: -1 }, { is_popular: "yes" }, { barcode_text: "x".repeat(300) }]) expect(v({ ...ok, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });
  for (const name of ["CommentCode", "CommentCodeCreate", "CommentCodeUpdate"]) {
    it(`${name}: category, result type, default template flag, text format; text is plain or Markdown, never raw HTML`, () => {
      expect(S[name].additionalProperties).toBe(false);
      for (const f of NOTE_FIELDS) { expect(S[name].properties?.[f], `${name}.${f}`).toBeDefined(); expect(S[name].required ?? []).not.toContain(f); expect(P(name, f).nullable).not.toBe(true); }
      expect(isUuid(P(name, "category_id"))).toBe(true);
      expect(P(name, "is_default_template").type).toBe("boolean");
      sortedEq(enumOf(P(name, "text_format")), ["plain", "markdown"]);
      const rt = enumOf(P(name, "result_type"));
      for (const t of [...OLD_RESULT_TYPES, ...NEW_RESULT_TYPES]) expect(rt, `${name}.result_type has ${t}`).toContain(t);
      for (const t of rt) expect(t.length <= P(name, "result_type").maxLength, `maxLength fits ${t}`).toBe(true);
      const d = String(P(name, "text").description ?? "");
      expect(d, `${name}.text description must say plain text or safe Markdown, never raw HTML`).toMatch(/markdown/i);
      expect(d).toMatch(/html/i);
      expect(d).toMatch(/never|not|no /i);
    });
  }
  it("CommentCodeUpdate clears category_id and result_type through unset[]; payloads validate and bad values are rejected", () => {
    const u = S.CommentCodeUpdate.properties.unset?.items?.enum as string[];
    expect(u, "CommentCodeUpdate.unset").toBeDefined();
    for (const f of ["category_id", "result_type"]) expect(u).toContain(f);
    const v = validator("CommentCodeCreate");
    expect(v({ code: "CBCNOTE", text: "Synthetic note" })).toBe(true);
    expect(v({ code: "CBCNOTE", text: "Synthetic **note**", category_id: UUID, result_type: "narrative", is_default_template: true, text_format: "markdown" }), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ text_format: "html" }, { result_type: "rich" }, { is_default_template: "yes" }, { category_id: "x" }]) expect(v({ code: "CBCNOTE", text: "x", ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });
});

describe("T0C-TESTMGMT-1 permissions and errors (done_when 10)", () => {
  it("no new permission code, no new error code", () => {
    const perms = new Set(allOps().map((id) => opOf(id)!.op["x-permission"]));
    for (const id of Object.keys(NEW_OPS)) expect(["catalog.test.read", "catalog.test.manage"]).toContain(opOf(id)!.op["x-permission"]);
    expect(perms.has("catalog.test.read") && perms.has("catalog.test.manage")).toBe(true);
    const pText = readFileSync(join(ROOT, "contracts/permissions.yaml"), "utf8");
    expect(pText).toContain("catalog.test.read");
    expect(pText).toContain("catalog.test.manage");
    expect(pText.toLowerCase(), "no test-category permission code").not.toMatch(/test[._-]?categor/);
  });
});

describe("T0C-TESTMGMT-1 generated clients and the pending-operations rule (LD-325)", () => {
  it("generated clients and MSW handlers are fresh (codegen --check)", () => {
    expect(staleFiles(ROOT)).toEqual([]);
  }, 120_000);

  it("catalog module manifest still declares pendingOperations, but the T0B handler task removed the three test category ids and registered handlers (LD-325(b))", () => {
    expect(existsSync(MODULE_INDEX)).toBe(true);
    const t = readFileSync(MODULE_INDEX, "utf8");
    expect(t, "services/api/src/modules/catalog/index.ts must declare pendingOperations").toMatch(/pendingOperations/);
    const arr = /pendingOperations\s*:\s*\[([\s\S]*?)\]/.exec(t);
    expect(arr, "pendingOperations array literal").not.toBeNull();
    const pending = [...arr![1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g)].map((m) => m[1]);
    const handlers = readFileSync(join(ROOT, "services/api/src/modules/catalog/handlers/masters.handlers.ts"), "utf8");
    for (const id of Object.keys(NEW_OPS)) {
      expect(pending, `${id} must not be pending (T0B-TESTMGMT-1 implemented it)`).not.toContain(id);
      expect(handlers, `${id} registered in masters.handlers.ts`).toContain(`'${id}'`);
    }
  });
});

describe("T0C-TESTMGMT-1 migration file (static; behaviour in the pgTAP suite)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");

  it("exists, is the only 20261117170000 migration, is newer than the ACCT-1 migration, runs as lims_owner", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all.filter((f) => f.startsWith("20261117170000"))).toEqual([MIG]);
    expect(all.indexOf(MIG)).toBeGreaterThan(all.indexOf("20261117120000_billing__add_lab_accounting.sql"));
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("adds the test, analyte, version, band and panel columns, each with ADD COLUMN IF NOT EXISTS", () => {
    for (const f of [...TEST_FIELDS, ...ANALYTE_FIELDS.filter((f) => f !== "specimen_type_id"), "specimen_type_id", ...VERSION_FIELDS, ...BAND_FIELDS, ...NOTE_FIELDS]) {
      if (f === "category_id" || f === "tags" || f === "nabl_processing_centres") continue;
      expect(code, f).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+"?${f}"?\\s`, "i"));
    }
    for (const f of ["tags", "nabl_processing_centres", "category_id"]) expect(code, f).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+"?${f}"?\\s`, "i"));
    for (const t of ["catalog.tests", "catalog.analytes", "catalog.analyte_versions", "catalog.reference_ranges", "catalog.panels", "catalog.comment_codes"]) expect(code, t).toContain(t);
    expect((code.match(/ADD COLUMN/gi) ?? []).length).toBe((code.match(/ADD COLUMN IF NOT EXISTS/gi) ?? []).length);
  });
  it("creates test_categories and the stage TAT table with IF NOT EXISTS, RLS enabled and forced", () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS catalog\.test_categories/i);
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS catalog\.test_stage_tat_targets/i);
    for (const t of ["test_categories", "test_stage_tat_targets"]) {
      expect(code, `${t} ENABLE RLS`).toMatch(new RegExp(`ALTER TABLE catalog\\.${t}\\s+ENABLE ROW LEVEL SECURITY`, "i"));
      expect(code, `${t} FORCE RLS`).toMatch(new RegExp(`ALTER TABLE catalog\\.${t}\\s+FORCE ROW LEVEL SECURITY`, "i"));
    }
    expect((code.match(/CREATE TABLE(?! IF NOT EXISTS)/gi) ?? []).length, "every CREATE TABLE is IF NOT EXISTS").toBe(0);
  });
  it("is additive and rewrite-free: no DROP of data, no data statement, no type change, no NOT NULL without DEFAULT, no policy change on existing tables", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect(code).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+\S+\s+SET|REVOKE|DROP\s+TABLE|DROP\s+COLUMN|DROP\s+SCHEMA|DROP\s+POLICY|DROP\s+TRIGGER)\b/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN|ALTER\s+TABLE\s+\S+\s+(RENAME|OWNER)/i);
    for (const m of code.matchAll(/ADD\s+COLUMN\s+IF NOT EXISTS\s+"?(\w+)"?\s+([^,;]*)/gi)) {
      if (/\bNOT\s+NULL\b/i.test(m[2])) expect(m[2], `column ${m[1]}: NOT NULL needs a DEFAULT so existing rows need no rewrite decision`).toMatch(/\bDEFAULT\b/i);
    }
    expect(code).not.toMatch(/DISABLE\s+ROW|NO\s+FORCE/i);
    expect(code).not.toMatch(/ALTER\s+POLICY/i);
    expect(code).not.toMatch(/\bCREATE\s+TYPE\b|\bAS\s+ENUM\b/i);
  });
  it("every index is IF NOT EXISTS; every constraint is guarded by a pg_constraint check or inline in CREATE TABLE; DROP CONSTRAINT only widens the three known checks", () => {
    for (const m of code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/gi)) throw new Error(`unguarded CREATE INDEX near ${m.index}`);
    for (const m of code.matchAll(/ADD\s+CONSTRAINT/gi)) {
      const before = code.slice(Math.max(0, m.index! - 1500), m.index);
      expect(before, "ADD CONSTRAINT must sit in a DO block that checks pg_constraint first").toMatch(/DO\s+\$[a-z_]*\$[\s\S]*pg_constraint/i);
    }
    for (const m of code.matchAll(/DROP\s+CONSTRAINT\s+(IF EXISTS\s+)?"?(\w+)"?/gi)) {
      expect(["analyte_versions__result_type__ck", "reference_ranges__sex__ck", "critical_limits__sex__ck", "reference_ranges__age_low_unit__ck", "reference_ranges__age_high_unit__ck",
        "critical_limits__age_low_unit__ck", "critical_limits__age_high_unit__ck"], `unexpected DROP CONSTRAINT ${m[2]}`).toContain(m[2]);
    }
  });
  it("widened checks keep the old values and add the new ones; new value checks exist", () => {
    for (const v of [...OLD_RESULT_TYPES, ...NEW_RESULT_TYPES]) expect(code, `result_type check names ${v}`).toContain(`'${v}'`);
    for (const v of ["any", "male", "female", "third_gender", "hour", "day", "week", "month", "year"]) expect(code, `sex / age unit check names ${v}`).toContain(`'${v}'`);
    for (const v of [...REPORT_TYPES, ...PROCESSING, ...DISPLAY_TYPES, ...STAGES]) expect(code, `check names ${v}`).toContain(`'${v}'`);
    expect(code).toMatch(/loyalty_points\s*>=\s*0|loyalty_points\s+BETWEEN\s+0/i);
    expect(code).toMatch(/auto_approved_low\s*<=\s*auto_approved_high|auto_approved_low\s+IS\s+NULL\s+OR\s+auto_approved_high\s+IS\s+NULL\s+OR/i);
  });
  it("comments: LD-318, down note, no data rewrite, push-cloud, nothing existing renamed", () => {
    expect(comments).toMatch(/LD-318/);
    expect(comments).toMatch(/\bdown\b/i);
    expect(comments).toMatch(/DROP COLUMN/i);
    expect(comments).toMatch(/no data rewrite|does not rewrite|no rewrite/i);
    expect(comments).toMatch(/push-cloud/i);
    expect(comments).toMatch(/test_categories/);
    for (const f of ["short_name", "default_value", "third_gender", "stage"]) expect(comments, `down note names ${f}`).toContain(f);
  });
});

describe("T0C-TESTMGMT-1 implementation notes: FIELD MAP (done_when 1)", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  const lines = t.split("\n");
  it("notes exist, name the migration, say the cloud migration is a founder step, and list the pending operation ids", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-TESTMGMT-1-impl.md missing").toBe(true);
    expect(t).toContain(MIG);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/pendingOperations/);
    for (const id of Object.keys(NEW_OPS)) expect(t, id).toContain(id);
    expect(t).toMatch(/T0B-TESTMGMT-1/);
  });
  it("every ElabAssist field label has one decision line: already present (field named), added (field named) or not added (reason)", () => {
    expect(t.length, "impl notes missing").toBeGreaterThan(0);
    // a decision line STARTS with the label (after bullet / table / bold marks) and then a separator (— - : | = ( or end), e.g. "- **Test Name** — already present (orderables.name)" or "| Test Name | already present | ... |"
    const missing: string[] = [];
    for (const label of LABELS) {
      const l = label.toLowerCase();
      const hit = lines.find((x) => {
        const s = x.replace(/^[\s|*\-•>`_#]+/, "").toLowerCase();
        if (!s.startsWith(l)) return false;
        const rest = s.slice(l.length).replace(/^[*`_\s]+/, "");
        return (rest === "" || /^[—–\-:|=(]/.test(rest)) && /already present|added|not added|deliberately not/i.test(x);
      });
      if (!hit) missing.push(label);
    }
    expect(missing, `labels without a decision line: ${missing.join(" | ")}`).toEqual([]);
  });
  it("'not added' decisions carry a reason", () => {
    const bad = lines.filter((x) => /deliberately not added|not added/i.test(x) && !/because|reason|why|\bsince\b|—|: .{12,}/i.test(x));
    expect(bad, `not-added lines without a reason: ${bad.slice(0, 3).join(" || ")}`).toEqual([]);
  });
  it("maps the thirteen ElabAssist result types to LIMS result_type values and the processing / report types to their enums", () => {
    for (const rt of ["Integer", "Float", "List", "Boolean", "Long Text", "Equation", "Test_Footer", "Space", "Graph", "Descriptive", "Single Line Text", "Image", "Html Descriptive"]) {
      expect(t.toLowerCase(), `result type ${rt} mapped`).toContain(rt.toLowerCase());
    }
    expect(t).toMatch(/third_gender/);
    expect(t).toMatch(/LD-318/);
  });
  it("records what stays with the founder or later tasks: rate card equations not built, no test created", () => {
    expect(t).toMatch(/rate card/i);
    expect(t).toMatch(/not (built|added)|do not build|deferred|founder/i);
    expect(t).toMatch(/Test Group[^\n]*(specimen|exists|present|added)/i);
  });
});
