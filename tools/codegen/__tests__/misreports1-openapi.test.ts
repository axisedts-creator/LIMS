// T0C-MISREPORTS-1 (LD-321, LD-325, LD-337; founder blanket authority LD-310, priority order 2026-11-17 09:18 NPT, offline rule 09:19 NPT) — the missing ElabAssist MIS reports as rows of the
// EXISTING analytics report catalogue: contracts/openapi/analytics.yaml (additive: report definitions + export filter values), migration 20261117230000_analytics__add_mis_report_support.sql
// (static checks; behaviour is db/tests/analytics/T0C-MISREPORTS-1_report_codes.test.sql), generated-client freshness and the implementer's notes with the 31 type FIELD MAP.
// ASSUMPTIONS (the brief says "definitions in the catalogue", the repo has no route that returns a definition; a different choice needs a ruling, not a silent test edit; same style as T0C-SALES-1):
//  - NO new operation and NO new path (done_when 3): analytics.yaml keeps exactly its 30 operations. Hence no pendingOperations entry and no handler task for a route. The new reports run through the
//    existing createAnalyticsExport (report_code, params) and createReportSchedule (report_codes) operations: report_code is an x-coded-set (never an enum, lint rule 6), the set is the table
//    analytics.g_cs_report_codes, so the new codes are ROWS of that table added by the migration (a supporting row set is the only supporting change; no column, no table, no index).
//  - DEFINITIONS live in the contract as the root extension `x-report-definitions` (list) described by the closed schema components.schemas.ReportDefinition (OpenAPI allows root x- keys). Each definition:
//    code, title, description, permission, params[], columns[{name, type, title}], default_sort{column, direction}, row_cap, exportable, schedulable, example_params (+ optional flag). The 14 original
//    reports may also be listed; only the NEW ones are pinned here. The T0B-MISREPORTS-1 registry (reportRegistry.ts) is built from the same data.
//  - Column types: string | integer | integer_paisa | basis_points | date | datetime. Money is ONLY integer_paisa (name ends _paisa), ratios ONLY basis_points (name ends _bp); no float, no decimal.
//  - Parameter vocabulary (closed): business_date_from, business_date_to (existing ExportParams), centre_id (existing, top level), department_id and referrer_id (existing filters), and the NEW export
//    filters party_id, representative_id, collector_id (uuid arrays, maxItems 20), visit_type (opd | ipd, the frontdesk orders.visit_type field: it EXISTS, no frontdesk change), min_repeat_count (integer 2..100).
//    "consultant" of the brief = the referrer / doctor of the order = referrer_id. A schedule carries only period and centre scope, so a scheduled pack runs these reports with their default filters.
//  - NEW CODES (9, pinned): bill_of_the_day, two_level_commission, sales_representative, consultant, collection_boy, repeated_patient, repeated_test, ipd_opd, tds. Wire pattern ^[a-z][a-z_]*$, <= 32 chars
//    (the DB check g_cs_report_codes__code__ck is ^[a-z_]{2,40}$, so NO digit). The implementer may add more from the field map; they are checked for shape only.
//  - PERMISSIONS (done_when 4): no new code. bill_of_the_day, collection_boy -> analytics.collections.read; sales_representative, consultant, repeated_patient, repeated_test, ipd_opd -> analytics.dashboard.read;
//    two_level_commission, tds -> analytics.referral_report.read with flag referralIncentiveReportEnabled (the 04 L19 position: referral money reports stay behind the tenant flag). Export and schedule keep
//    analytics.data.export / analytics.schedule.manage.
//  - 04 L19 CONFLICT (for the lead): the original migration forbids the word "commission" in report codes and displays (CHECK g_cs_report_codes__no_c_word__ck). The brief and the founder ask for a
//    "two level commission" report and commission_bp exists in the party settings, so the migration drops that one check (the code pattern check stays) and the notes say so. If the lead rules for
//    the L19 wording instead, change only NEW_CODES / the two titles here and the pgTAP suite.
//  - Offline (founder 09:19): reports are online only; a shown report may be printed from the cache (notes).
//  - the implementer's notes are .orchestra/notes/T0C-MISREPORTS-1-impl.md (convention of every earlier T0C task).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = "20261117230000_analytics__add_mis_report_support.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-MISREPORTS-1-impl.md");
const load = (f: string): any => parse(readFileSync(join(ROOT, f), "utf8"));
const A: any = load("contracts/openapi/analytics.yaml");
const common: any = load("contracts/openapi/_common.yaml");
const registry: any = load("contracts/permissions.yaml");
const METHODS = ["get", "put", "post", "delete", "patch"];
const S = A.components.schemas as Record<string, any>;

const OLD_OPS = ["getAnalyticsDashboard", "getIncomeReport", "getDepartmentIncomeReport", "getCollectionsReport", "getVolumeReport", "getTopReferrersReport", "getTopCentresReport", "getReferralIncentiveReport",
  "getTestsDoneReport", "getTatReport", "getPendingTestsSummary", "listPendingTests", "getQualityIndicatorsReport", "getDeliveryReport", "getInterfacesReport", "getAnalyticsFilterOptions", "searchAnalyticsReferrers",
  "getAnalyticsFreshness", "requestAnalyticsRefresh", "createAnalyticsExport", "listAnalyticsExports", "getAnalyticsExport", "downloadAnalyticsExport", "listReportSchedules", "createReportSchedule",
  "getReportSchedule", "updateReportSchedule", "deactivateReportSchedule", "getReportRun", "getCollectionsFilterOptions"];
const OLD_CODES = ["dashboard", "income", "department_income", "collections", "volume", "top_referrers", "top_centres", "referral_incentive", "tests_done", "tat", "pending_tests", "quality_indicators", "delivery", "interfaces"];
const ANALYTICS_PERMS = ["analytics.collections.read", "analytics.dashboard.read", "analytics.data.export", "analytics.referral_report.read", "analytics.schedule.manage"];
const DASH = "analytics.dashboard.read", COLL = "analytics.collections.read", REF = "analytics.referral_report.read";
const FLAG = "referralIncentiveReportEnabled";
const COLTYPES = ["string", "integer", "integer_paisa", "basis_points", "date", "datetime"];
const PARAM_VOCAB = ["business_date_from", "business_date_to", "centre_id", "department_id", "referrer_id", "party_id", "representative_id", "collector_id", "visit_type", "min_repeat_count"];
const NEW_FILTERS = ["party_id", "representative_id", "collector_id", "visit_type", "min_repeat_count"];

// per new report: permission, optional flag, params that must be offered, columns that must exist (name -> type)
type Pin = { perm: string; flag?: string; params: string[]; cols: Record<string, string>; text?: RegExp };
const PINS: Record<string, Pin> = {
  bill_of_the_day: { perm: COLL, params: ["centre_id", "party_id"], cols: { gross_paisa: "integer_paisa", discount_paisa: "integer_paisa", net_paisa: "integer_paisa" } },
  two_level_commission: { perm: REF, flag: FLAG, params: ["party_id"], cols: { parent_party_id: "string", party_id: "string", commission_bp: "basis_points", commission_paisa: "integer_paisa" }, text: /parent.*sub|two level|level/is },
  sales_representative: { perm: DASH, params: ["representative_id"], cols: { representative_id: "string", orders_registered: "integer", net_paisa: "integer_paisa" } }, // LD-357: net_billed_paisa is referral_incentive only
  consultant: { perm: DASH, params: ["referrer_id", "department_id"], cols: { orders_registered: "integer", tests_count: "integer" } }, // LD-346: volume only, no money column
  collection_boy: { perm: COLL, params: ["collector_id", "centre_id"], cols: { collections_count: "integer", pickups_count: "integer", collected_paisa: "integer_paisa" } },
  repeated_patient: { perm: DASH, params: ["min_repeat_count", "centre_id"], cols: { visit_count: "integer" } },
  repeated_test: { perm: DASH, params: ["min_repeat_count", "department_id"], cols: { test_count: "integer" } },
  ipd_opd: { perm: DASH, params: ["visit_type", "centre_id"], cols: { visit_type: "string", orders_registered: "integer", net_paisa: "integer_paisa" } },
  tds: { perm: REF, flag: FLAG, params: ["party_id"], cols: { party_id: "string", commission_payable_paisa: "integer_paisa", tds_bp: "basis_points", tds_withheld_paisa: "integer_paisa", net_payable_paisa: "integer_paisa" }, text: /report only|no money (moves|is moved)|no money/i },
};
const NEW_CODES = Object.keys(PINS);

const defs: any[] = Array.isArray(A["x-report-definitions"]) ? A["x-report-definitions"] : [];
const newDefs = defs.filter((d) => !OLD_CODES.includes(d.code));
const byCode = (c: string): any => defs.find((d) => d.code === c);
const idsOf = (doc: any): string[] => Object.values<any>(doc.paths).flatMap((item) => METHODS.filter((m) => item[m]).map((m) => item[m].operationId as string));
const opOf = (id: string): any => Object.values<any>(A.paths).flatMap((item) => METHODS.filter((m) => item[m]).map((m) => item[m])).find((o: any) => o.operationId === id);
const walk = (s: any, fn: (n: any) => void, seen = new Set<any>()): void => {
  if (!s || typeof s !== "object" || seen.has(s)) return;
  seen.add(s);
  if (s.$ref) return;
  fn(s);
  for (const v of Object.values<any>(s.properties ?? {})) walk(v, fn, seen);
  if (s.items) walk(s.items, fn, seen);
  for (const k of ["allOf", "oneOf", "anyOf"]) for (const v of s[k] ?? []) walk(v, fn, seen);
};

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ ...common, id: "_common.yaml" });
ajv.addSchema({ ...A, id: "analytics.yaml" });
const validator = (name: string) => {
  const v = ajv.getSchema(`analytics.yaml#/components/schemas/${name}`);
  expect(v, `schema ${name} missing`).toBeDefined();
  return v!;
};

describe("T0C-MISREPORTS-1 analytics.yaml: lint and additive baseline (done_when 3, 6)", () => {
  it("lintRepo reports no violation for analytics.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "analytics.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });
  it("NO new route: exactly the 30 original operations, unique ids, same x-permission on the export and schedule operations", () => {
    const ids = idsOf(A);
    expect([...ids].sort()).toEqual([...OLD_OPS].sort());
    expect(new Set(ids).size).toBe(30);
    expect(opOf("createAnalyticsExport")["x-permission"]).toBe("analytics.data.export");
    expect(opOf("createReportSchedule")["x-permission"]).toBe("analytics.schedule.manage");
    expect(opOf("getReferralIncentiveReport")["x-permission"]).toBe(REF);
  });
  it("report_code stays an x-coded-set (analytics.g_cs_report_codes), never an enum, on export, schedule and run schemas", () => {
    for (const [n, path] of [["ExportDto", "report_code"], ["ReportRunDto", "report_codes"]] as const) {
      const p = S[n].properties[path];
      const node = p.items ?? p;
      expect(node["x-coded-set"], `${n}.${path}`).toBe("analytics.g_cs_report_codes");
      expect(node.enum, `${n}.${path} must not carry an enum`).toBeUndefined();
    }
    const body = opOf("createAnalyticsExport").requestBody.content["application/json"].schema;
    expect(body.properties.report_code["x-coded-set"]).toBe("analytics.g_cs_report_codes");
    expect(body.properties.report_code.maxLength).toBe(32);
    expect(body.additionalProperties).toBe(false);
  });
  it("createAnalyticsExport / createReportSchedule keep their error models (analytics.report_unknown, validation, mfa, idempotency) and the _common responses", () => {
    const ec: string[] = opOf("createAnalyticsExport")["x-error-codes"];
    for (const c of ["analytics.report_unknown", "common.validation_failed", "auth.mfa_required", "common.idempotency_key_required", "analytics.range_too_large", "common.date_out_of_range", "auth.forbidden"]) expect(ec, c).toContain(c);
    for (const code of ["400", "401", "403", "404", "422", "429", "500"]) expect(opOf("createAnalyticsExport").responses[code]?.$ref, code).toMatch(/^_common\.yaml#\/components\/responses\//);
    expect(opOf("createReportSchedule")["x-error-codes"]).toContain("analytics.report_unknown");
  });
});

describe("T0C-MISREPORTS-1 the report definitions (done_when 2, 3, 5)", () => {
  it("analytics.yaml has the root x-report-definitions list and the closed component schema ReportDefinition", () => {
    expect(Array.isArray(A["x-report-definitions"]), "x-report-definitions missing").toBe(true);
    const s = S.ReportDefinition;
    expect(s, "components.schemas.ReportDefinition missing").toBeDefined();
    expect(s.additionalProperties).toBe(false);
    for (const k of ["code", "title", "description", "permission", "params", "columns", "default_sort", "row_cap", "exportable", "schedulable", "example_params"]) {
      expect(s.required, `required ${k}`).toContain(k);
      expect(s.properties[k], `property ${k}`).toBeDefined();
    }
    expect(s.properties.flag).toBeDefined();
    expect(s.required).not.toContain("flag");
    const col = s.properties.columns.items;
    expect(col.additionalProperties).toBe(false);
    expect(col.required).toEqual(expect.arrayContaining(["name", "type"]));
    expect([...col.properties.type.enum].sort()).toEqual([...COLTYPES].sort());
    expect(s.properties.columns.maxItems, "columns need maxItems").toBeGreaterThan(0);
    expect(s.properties.params.maxItems, "params need maxItems").toBeGreaterThan(0);
    expect(s.properties.default_sort.additionalProperties).toBe(false);
    expect([...s.properties.default_sort.properties.direction.enum].sort()).toEqual(["asc", "desc"]);
    expect(s.properties.row_cap.type).toBe("integer");
    expect(s.properties.row_cap.maximum).toBeLessThanOrEqual(100000);
    expect(s.properties.code.pattern).toBeDefined();
    expect(s.properties.code.maxLength).toBe(32);
  });
  it("the 9 pinned codes are defined, codes are unique, none collides with the 14 original codes", () => {
    const codes = defs.map((d) => d.code);
    expect(new Set(codes).size, "duplicate code").toBe(codes.length);
    for (const c of NEW_CODES) expect(codes, `definition ${c} missing`).toContain(c);
    for (const c of NEW_CODES) expect(OLD_CODES).not.toContain(c);
  });
  it("every definition validates against ReportDefinition (closed schema, ajv)", () => {
    const v = validator("ReportDefinition");
    for (const d of defs) expect(v(d), `${d.code}: ${JSON.stringify(v.errors?.slice(0, 2))}`).toBe(true);
  });
  it("every NEW definition: wire code shape, title, description, permission is an existing analytics code, closed params, typed columns, valid default sort, row cap, exportable and schedulable", () => {
    expect(newDefs.length, "the 9 new definitions are missing").toBeGreaterThanOrEqual(NEW_CODES.length);
    for (const d of newDefs) {
      expect(d.code, d.code).toMatch(/^[a-z][a-z_]*$/);
      expect(d.code.length, `${d.code} longer than 32`).toBeLessThanOrEqual(32);
      expect(String(d.title).trim().length, `${d.code} title`).toBeGreaterThan(2);
      expect(String(d.description).trim().length, `${d.code} description`).toBeGreaterThan(20);
      expect(ANALYTICS_PERMS, `${d.code} permission ${d.permission}`).toContain(d.permission);
      expect(d.permission, `${d.code}: export and schedule permissions are not report gates`).not.toMatch(/data\.export|schedule\.manage/);
      expect(d.params.length).toBeGreaterThan(0);
      expect(new Set(d.params).size).toBe(d.params.length);
      for (const p of d.params) expect(PARAM_VOCAB, `${d.code}: param ${p} is outside the closed list`).toContain(p);
      expect(d.params, `${d.code} needs the date range`).toEqual(expect.arrayContaining(["business_date_from", "business_date_to"]));
      const names = d.columns.map((c: any) => c.name);
      expect(new Set(names).size, `${d.code} duplicate column`).toBe(names.length);
      expect(names.length, `${d.code} needs 3..30 columns`).toBeGreaterThanOrEqual(3);
      expect(names.length).toBeLessThanOrEqual(30);
      for (const c of d.columns) {
        expect(c.name, `${d.code} column name`).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(COLTYPES, `${d.code}.${c.name} type`).toContain(c.type);
        if (/_paisa$/.test(c.name)) expect(c.type, `${d.code}.${c.name}: money is integer_paisa`).toBe("integer_paisa");
        if (c.type === "integer_paisa") expect(c.name, `${d.code}.${c.name}`).toMatch(/_paisa$/);
        if (/_bp$/.test(c.name)) expect(c.type, `${d.code}.${c.name}: ratio is basis_points`).toBe("basis_points");
        if (c.type === "basis_points") expect(c.name, `${d.code}.${c.name}`).toMatch(/_bp$/);
      }
      expect(names, `${d.code}: default_sort.column must be a column`).toContain(d.default_sort.column);
      expect(["asc", "desc"]).toContain(d.default_sort.direction);
      expect(Number.isInteger(d.row_cap) && d.row_cap >= 1 && d.row_cap <= 100000, `${d.code} row_cap ${d.row_cap}`).toBe(true);
      expect(d.exportable, `${d.code} exportable`).toBe(true);
      expect(d.schedulable, `${d.code} schedulable`).toBe(true);
    }
  });
  it("each NEW definition carries a synthetic example_params that is valid ExportParams, uses only the params it declares and a safe date range", () => {
    expect(newDefs.length, "the 9 new definitions are missing").toBeGreaterThanOrEqual(NEW_CODES.length);
    const v = validator("ExportParams");
    for (const d of newDefs) {
      expect(v(d.example_params), `${d.code}: ${JSON.stringify(v.errors?.slice(0, 2))}`).toBe(true);
      expect(d.example_params.business_date_from, d.code).toBeDefined();
      expect(d.example_params.business_date_to, d.code).toBeDefined();
      expect(String(d.example_params.business_date_from), d.code).toMatch(/^20[2-3]\d-/);
      const used = [...Object.keys(d.example_params), ...Object.keys(d.example_params.filters ?? {})].filter((k) => k !== "filters" && k !== "group_by" && k !== "bs_month" && k !== "fiscal_year_bs" && k !== "branch_id");
      for (const k of used) expect(d.params, `${d.code}: example uses undeclared param ${k}`).toContain(k);
    }
  });
  it("no float, no decimal, no nullable, no free text type anywhere in the definition schema; every object closed; every array and string bounded", () => {
    expect(S.ReportDefinition, "ReportDefinition missing").toBeDefined();
    walk(S.ReportDefinition, (n) => {
      expect(n.type, "no number type").not.toBe("number");
      expect(n.nullable, "no nullable").toBeUndefined();
      expect(n.format ?? "", "no float format").not.toMatch(/float|double|decimal/);
      if (n.type === "object" && n.properties) expect(n.additionalProperties, "object must be closed").toBe(false);
      if (n.type === "array") expect(n.maxItems, "array needs maxItems").toBeDefined();
      if (n.type === "string" && !n.enum && !n.format && !n.$ref) expect(n.maxLength, `string needs maxLength: ${JSON.stringify(n).slice(0, 60)}`).toBeDefined();
    });
  });
});

describe("T0C-MISREPORTS-1 one definition per brief report (done_when 2)", () => {
  for (const [code, p] of Object.entries(PINS)) {
    describe(code, () => {
      const d = byCode(code);
      it(`permission ${p.perm}${p.flag ? ` + flag ${p.flag}` : ""}, params ${p.params.join(", ")}`, () => {
        expect(d, `${code} not defined`).toBeDefined();
        expect(d.permission).toBe(p.perm);
        if (p.flag) expect(d.flag).toBe(p.flag);
        else expect(d.flag).toBeUndefined();
        for (const x of p.params) expect(d.params, `${code} param ${x}`).toContain(x);
      });
      it(`typed columns ${Object.keys(p.cols).join(", ")}`, () => {
        expect(d, `${code} not defined`).toBeDefined();
        for (const [name, type] of Object.entries(p.cols)) {
          const c = d.columns.find((x: any) => x.name === name);
          expect(c, `${code} lacks column ${name}`).toBeDefined();
          expect(c.type, `${code}.${name}`).toBe(type);
        }
      });
      if (p.text) it("description states the rule of the brief", () => { expect(String(d?.description)).toMatch(p.text!); });
    });
  }
  it("TDS and commission are reports only: no operation moves money, description says so, and tds_bp / commission_bp are named", () => {
    expect(String(byCode("tds")?.description)).toMatch(/tds_bp/);
    expect(String(byCode("tds")?.description)).toMatch(/commission_bp|commission payable/i);
    expect(String(byCode("two_level_commission")?.description)).toMatch(/commission_bp/);
    expect(String(byCode("two_level_commission")?.description)).toMatch(/report only|no money|never posts|does not post/i);
  });
  it("the commission and TDS reports are the only ones behind the referral flag; every other new report has no flag", () => {
    expect(newDefs.length, "the 9 new definitions are missing").toBeGreaterThanOrEqual(NEW_CODES.length);
    for (const d of newDefs) expect(d.flag, d.code).toBe(["two_level_commission", "tds"].includes(d.code) ? FLAG : undefined);
  });
  it("Bill of the Day is one business day (date range of at most 1 day is the default example) and sorted newest first", () => {
    const d = byCode("bill_of_the_day");
    expect(d?.example_params?.business_date_from).toBe(d?.example_params?.business_date_to);
    expect(d?.default_sort?.direction).toBe("desc");
  });
  it("consultant is volume only (LD-346, A39-3): no net_billed_paisa column, sorted by tests_count descending", () => {
    const d = byCode("consultant");
    expect(d.columns.map((c: any) => c.name)).not.toContain("net_billed_paisa");
    expect(d.default_sort).toEqual({ column: "tests_count", direction: "desc" });
  });
  it("LD-357 / P13: net_billed_paisa belongs to referral_incentive only; sales_representative, repeated_patient, party_billing use net_paisa", () => {
    for (const d of defs) if (!["referral_incentive", "two_level_commission", "tds"].includes(d.code)) expect(d.columns.map((c: any) => c.name), d.code).not.toContain("net_billed_paisa");
    expect(byCode("sales_representative").columns.map((c: any) => c.name)).toContain("net_paisa");
    expect(byCode("sales_representative").default_sort.column).not.toBe("net_billed_paisa");
  });
  it("repeated patient / repeated test offer min_repeat_count and sort by the repeat count, highest first", () => {
    expect(byCode("repeated_patient")?.default_sort).toEqual({ column: "visit_count", direction: "desc" });
    expect(byCode("repeated_test")?.default_sort).toEqual({ column: "test_count", direction: "desc" });
  });
  it("sales representative and collection boy reports do not expose a patient name or phone column (REQ-SEC-098 style identifier rule of the registry)", () => {
    for (const c of ["sales_representative", "collection_boy", "consultant", "tds", "two_level_commission"]) expect(byCode(c), c).toBeDefined();
    for (const c of ["sales_representative", "collection_boy", "consultant", "tds", "two_level_commission"])
      for (const col of byCode(c)?.columns ?? []) expect(col.name, `${c}.${col.name}`).not.toMatch(/phone|mobile|email|national_id|pan_number|patient_name/);
  });
});

describe("T0C-MISREPORTS-1 ExportParams: the closed parameter list (done_when 3, 5)", () => {
  const ep = S.ExportParams;
  it("ExportParams and filters stay closed and keep every original key", () => {
    expect(ep.additionalProperties).toBe(false);
    for (const k of ["business_date_from", "business_date_to", "bs_month", "fiscal_year_bs", "centre_id", "branch_id", "group_by", "filters"]) expect(ep.properties[k], k).toBeDefined();
    expect(ep.properties.filters.additionalProperties).toBe(false);
    for (const k of ["department_id", "processing_branch_id", "priority", "segment", "payment_method_code", "rollup", "referrer_id", "item_status", "overdue_only"]) expect(ep.properties.filters.properties[k], k).toBeDefined();
    expect(ep.properties.filters.properties.priority.enum).toEqual(["routine", "urgent"]);
  });
  it("adds exactly the new filters party_id, representative_id, collector_id (uuid lists <= 20), visit_type (opd | ipd), min_repeat_count (integer 2..100)", () => {
    const f = ep.properties.filters.properties;
    for (const k of NEW_FILTERS) expect(f[k], `filters.${k}`).toBeDefined();
    for (const k of ["party_id", "representative_id", "collector_id"]) {
      expect(f[k].type, k).toBe("array");
      expect(f[k].maxItems, k).toBeLessThanOrEqual(20);
      expect(f[k].items.$ref, k).toBe("_common.yaml#/components/schemas/Uuid");
    }
    expect(f.visit_type.type).toBe("string");
    expect([...f.visit_type.enum].sort()).toEqual(["ipd", "opd"]);
    expect(f.visit_type.maxLength).toBeLessThanOrEqual(3);
    expect(f.min_repeat_count).toMatchObject({ type: "integer", minimum: 2, maximum: 100 });
  });
  it("every declared param of every NEW definition is a key of ExportParams or of its filters (no orphan parameter)", () => {
    expect(newDefs.length, "the 9 new definitions are missing").toBeGreaterThanOrEqual(NEW_CODES.length);
    const known = new Set([...Object.keys(ep.properties), ...Object.keys(ep.properties.filters.properties)]);
    for (const d of newDefs) for (const p of d.params) expect(known.has(p), `${d.code}: ${p} is not an ExportParams key`).toBe(true);
  });
  it("no new float or nullable in ExportParams", () => {
    expect(ep.properties.filters.properties.party_id, "new filters missing").toBeDefined();
    walk(ep, (n) => { expect(n.type).not.toBe("number"); expect(n.nullable).toBeUndefined(); });
  });
  it("the export request example set holds one example for a new report and it validates (example payloads, done_when 5)", () => {
    const o = opOf("createAnalyticsExport");
    const media = o.requestBody.content["application/json"];
    const exs = Object.values<any>(media.examples ?? {}).map((e) => e.value);
    expect(exs.length).toBeGreaterThan(1);
    const mine = exs.filter((e) => NEW_CODES.includes(e?.report_code));
    expect(mine.length, "an export example for a new report").toBeGreaterThanOrEqual(1);
    const v = ajv.getSchema(`analytics.yaml#/paths/~1v1~1analytics~1exports/post/requestBody/content/application~1json/schema`)!;
    expect(v).toBeDefined();
    for (const e of exs) expect(v(e), JSON.stringify(v.errors?.slice(0, 2))).toBe(true);
  });
});

describe("T0C-MISREPORTS-1 permissions (done_when 4)", () => {
  it("contracts/permissions.yaml keeps exactly the 5 analytics codes: no new code was needed", () => {
    const all: string[] = JSON.stringify(registry).match(/analytics\.[a-z_]+\.[a-z_]+/g) ?? [];
    expect([...new Set(all)].sort()).toEqual([...ANALYTICS_PERMS].sort());
  });
  it("every report permission of every definition is in the registry and no definition names a code outside it", () => {
    const text = JSON.stringify(registry);
    for (const d of defs) expect(text, `${d.code}: ${d.permission}`).toContain(d.permission);
  });
  it("the original reports keep their gate (referral_incentive stays behind analytics.referral_report.read)", () => {
    expect(opOf("getReferralIncentiveReport")["x-permission"]).toBe(REF);
    expect(opOf("getCollectionsReport")["x-permission"]).toBe(COLL);
  });
});

describe("T0C-MISREPORTS-1 generated clients", () => {
  it("generated clients and MSW handlers are fresh (codegen --check)", () => { expect(staleFiles(ROOT)).toEqual([]); }, 120_000);
});

describe("T0C-MISREPORTS-1 migration file (static; behaviour in the pgTAP suite) (done_when 6)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");
  it("exists (a supporting row set is required: the codes are rows of analytics.g_cs_report_codes), is the only 20261117230000 migration, sorts after the SALES and PARTYSET migrations, runs as lims_owner", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all.filter((f) => f.startsWith("20261117230000"))).toEqual([MIG]);
    expect(all.indexOf(MIG)).toBeGreaterThan(all.indexOf("20261105002100_analytics__create_analytics_schema.sql"));
    for (const older of all.filter((f) => /^202611172[0-2]/.test(f))) expect(all.indexOf(MIG), older).toBeGreaterThan(all.indexOf(older));
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("inserts every pinned code into analytics.g_cs_report_codes with display, sort_order, is_exportable and is_schedulable, ON CONFLICT DO NOTHING", () => {
    expect(code).toMatch(/INSERT\s+INTO\s+analytics\.g_cs_report_codes\s*\(\s*code\s*,\s*display\s*,\s*sort_order\s*,\s*is_exportable\s*,\s*is_schedulable\s*\)/i);
    for (const c of NEW_CODES) expect(code, `row for ${c}`).toMatch(new RegExp(`\\(\\s*'${c}'\\s*,\\s*'[^']{3,60}'\\s*,\\s*\\d+\\s*,\\s*true\\s*,\\s*true\\s*\\)`, "i"));
    expect(code).toMatch(/ON\s+CONFLICT\s*\(\s*code\s*\)\s*DO\s+NOTHING/i);
    for (const m of code.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'[^']*'\s*,\s*(\d+)\s*,\s*(true|false)\s*,\s*(true|false)\s*\)/gi)) {
      expect(m[1]!.length, `${m[1]} longer than 32`).toBeLessThanOrEqual(32);
      expect(Number(m[2]), `${m[1]} sort_order must follow the original 140`).toBeGreaterThan(140);
    }
  });
  it("relaxes ONLY the 04 L19 commission check (drop IF EXISTS g_cs_report_codes__no_c_word__ck), leaves the code pattern check alone, no other constraint touched", () => {
    expect(code).toMatch(/ALTER\s+TABLE\s+analytics\.g_cs_report_codes\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+g_cs_report_codes__no_c_word__ck/i);
    expect(code).not.toMatch(/g_cs_report_codes__code__ck|g_cs_report_codes__pk/i);
    expect((code.match(/DROP\s+CONSTRAINT/gi) ?? []).length).toBe(1);
  });
  it("is additive and idempotent: no CREATE TABLE / COLUMN / INDEX unless guarded, no DELETE, TRUNCATE, UPDATE, REVOKE, no DISABLE RLS, no other table touched, no money column", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect(code).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM|REVOKE|DROP\s+(TABLE|COLUMN|SCHEMA|INDEX|POLICY|TRIGGER))\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+\S+\s+SET\b/i);
    expect(code).not.toMatch(/\bCREATE\s+TYPE\b|\bAS\s+ENUM\b|DISABLE\s+ROW|NO\s+FORCE|ALTER\s+COLUMN|CREATE\s+SEQUENCE|GRANT\b/i);
    expect((code.match(/CREATE\s+TABLE(?!\s+IF\s+NOT\s+EXISTS)/gi) ?? []).length).toBe(0);
    expect((code.match(/ADD\s+COLUMN(?!\s+IF\s+NOT\s+EXISTS)/gi) ?? []).length).toBe(0);
    expect((code.match(/CREATE\s+(UNIQUE\s+)?INDEX(?!\s+IF\s+NOT\s+EXISTS)/gi) ?? []).length).toBe(0);
    for (const m of code.matchAll(/\b(?:INSERT\s+INTO|ALTER\s+TABLE)\s+(?:ONLY\s+)?(?:IF EXISTS\s+)?(\S+)/gi)) expect(m[1], "only the coded set is touched").toBe("analytics.g_cs_report_codes");
    expect(code).not.toMatch(/\b(float|double precision|real|numeric|decimal|money)\b/i);
  });
  it("comments: LD-321, L19 relaxed by founder order, the new codes, down note (DELETE the rows, re-add the check), additive, push-cloud founder step", () => {
    expect(comments).toMatch(/LD-321/);
    expect(comments).toMatch(/L19/);
    expect(comments).toMatch(/commission/i);
    expect(comments).toMatch(/\bdown\b/i);
    expect(comments).toMatch(/DELETE FROM analytics\.g_cs_report_codes/i);
    expect(comments).toMatch(/no_c_word/);
    expect(comments).toMatch(/additive|no data rewrite|no rewrite/i);
    expect(comments).toMatch(/push-cloud/i);
    for (const c of NEW_CODES) expect(comments, `comment names ${c}`).toContain(c);
  });
});

describe("T0C-MISREPORTS-1 implementation notes: FIELD MAP of the 31 ElabAssist MIS report types, offline, founder steps (done_when 1, 4, 6)", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  const lines = t.split("\n");
  // the 31 report types of Reports/Reports.aspx, copied from C:/LIMS-state/elabassist-other-20261117.md (MIS Reports), in that order
  const TYPES = ["Doctor Accounts", "Laboratory Summary", "Laboratory Details", "Test Details", "Patient Details", "Test Registration", "Franchise", "Franchise Details", "Dispatch Sheet", "Company Details",
    "Doctor Accounts IPD/OPD", "Laboratory IPD/OPD", "Franchise IPD/OPD", "Patient Bill Report", "Consolidate Report", "OutSource Report", "Payment History Report", "TAT Details Report", "CASH PARTY Report",
    "CREDIT PARTY Report", "Daily Payment History Report", "CollectionBoy Details", "EntityBilling With TDS", "Client Postpaid Bill", "Client Details", "Sales Representative", "Sales Report", "Consultant MIS",
    "Critical Value MIS", "Repeated and Non Repeated MIS", "InterLab Transfer MIS"];
  const decisionLine = (label: string): string | undefined => lines.find((x) => {
    const l = label.toLowerCase();
    const s = x.replace(/^[\s|*\-•>`_#\d.]+/, "").toLowerCase();
    if (!s.startsWith(l)) return false;
    const rest = s.slice(l.length).replace(/^[*`_\s]+/, "");
    return (rest === "" || /^[—–\-:|=(]/.test(rest)) && /already present|present|added|not added|deliberately not/i.test(x);
  });
  it("the list has 31 distinct types (guard for this test)", () => { expect(new Set(TYPES).size).toBe(31); });
  it("notes exist, name the migration as a founder step (push-cloud), cite LD-321, say no operation and no route was added, and name T0B-MISREPORTS-1", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-MISREPORTS-1-impl.md missing").toBe(true);
    expect(t).toContain(MIG);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/LD-321/);
    expect(t).toMatch(/no (new )?(route|operation)/i);
    expect(t).toMatch(/T0B-MISREPORTS-1/);
    expect(t).toMatch(/x-report-definitions/);
  });
  it("every one of the 31 types has exactly one decision line: present (catalogue code named), added (code named) or not added (reason); nothing left unmapped", () => {
    expect(t.length, "impl notes missing").toBeGreaterThan(0);
    const missing = TYPES.filter((x) => !decisionLine(x));
    expect(missing, `types without a decision line: ${missing.join(" | ")}`).toEqual([]);
  });
  it("'present' lines name an original catalogue code, 'added' lines name a code defined in analytics.yaml, 'not added' lines give a reason", () => {
    expect(t.length, "impl notes missing").toBeGreaterThan(0);
    expect(defs.length, "definitions missing").toBeGreaterThan(0);
    const allCodes = defs.map((d) => d.code);
    const bad: string[] = [];
    for (const ty of TYPES) {
      const l = decisionLine(ty);
      if (!l) continue;
      const words = l.toLowerCase().match(/[a-z][a-z_]+/g) ?? [];
      if (/not added|deliberately not/i.test(l)) { if (!/because|reason|why|\bsince\b|: .{12,}|— .{12,}/i.test(l)) bad.push(`${ty}: no reason`); }
      else if (/\badded\b/i.test(l)) { if (!allCodes.some((c) => words.includes(c))) bad.push(`${ty}: added but no defined code named`); }
      else if (!OLD_CODES.some((c) => words.includes(c)) && !allCodes.some((c) => words.includes(c))) bad.push(`${ty}: present but no catalogue code named`);
    }
    expect(bad, bad.join(" || ")).toEqual([]);
  });
  it("the brief's reports are mapped to added codes: Sales Representative, CollectionBoy Details, EntityBilling With TDS, Consultant MIS, Repeated and Non Repeated MIS, the IPD/OPD trio", () => {
    const need: Record<string, string[]> = { "Sales Representative": ["sales_representative"], "CollectionBoy Details": ["collection_boy"], "EntityBilling With TDS": ["tds"], "Consultant MIS": ["consultant"],
      "Repeated and Non Repeated MIS": ["repeated_patient", "repeated_test"], "Doctor Accounts IPD/OPD": ["ipd_opd"], "Laboratory IPD/OPD": ["ipd_opd"], "Franchise IPD/OPD": ["ipd_opd"] };
    for (const [ty, codes] of Object.entries(need)) for (const c of codes) expect(decisionLine(ty) ?? "", `${ty} -> ${c}`).toContain(c);
  });
  it("Bill of the Day and the two level commission report are named in the notes with their codes (they come from the accounting walk, not the 31 list)", () => {
    expect(t).toMatch(/Bill Of The Day/i);
    expect(t).toContain("bill_of_the_day");
    expect(t).toContain("two_level_commission");
    expect(t).toMatch(/elabassist-accounting-20261117/);
  });
  it("PERMISSIONS: says no new permission code was added and why (the five analytics codes suffice)", () => {
    expect(t).toMatch(/no new permission/i);
    for (const c of [DASH, COLL, REF]) expect(t, c).toContain(c);
  });
  it("records the 04 L19 'commission' wording decision for the lead", () => {
    expect(t).toMatch(/L19/);
    expect(t).toMatch(/no_c_word|commission/i);
    expect(t).toMatch(/lead/i);
  });
  it("gives the offline classification (founder 09:19): reports are online only, a shown report may be printed from the cache", () => {
    expect(t).toMatch(/offline/i);
    expect(t).toMatch(/online only/i);
    expect(t).toMatch(/print/i);
    expect(t).toMatch(/cache/i);
  });
  it("founder steps: push-cloud of the migration; the ElabAssist filters not mapped to a param (patient, test, amount status, area, company, user in lab) are listed with a decision", () => {
    expect(t).toMatch(/push-cloud/i);
    for (const f of ["amount status", "area", "company", "user in lab"]) expect(t.toLowerCase(), `filter ${f}`).toContain(f);
  });
});
