// T0C-10.C8 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/analytics.yaml (C8 transcription of spec/chunks/C8-analytics-mis/02-TRD.md §5, §5.1, §10).
// Checks: (1) exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) clean for analytics.yaml; (3) AC-0C-1.5 negatives on a temp copy;
// (4) inventory = TRD §5 table (30 ops), method+path, x-permission, security bearerJwt, x-idempotency, tier general, success status,
// specific + common error codes, Idempotency-Key / If-Match exactly on the TRD rows; (5) shape pins from §5/§5.1/§10 (period/scope params,
// enums, bounds, envelope, DTO allowlists, no money on referrers report, no "commission", export download headers);
// (6) "Prism smoke" offline: examples validate (ajv), every op has a servable 2xx example, examples synthetic (no e-mail / mobile number / path).
// Not testable here: Prism actually serving the file (prism not installed; mock wiring is T0C-08's mocks.test.ts).
// Assumptions (TRD silent): every op also lists the common codes auth.unauthenticated, common.rate_limited, common.internal ("responses 401/403/404/422/429/500");
// "as #1" ops (#2–#10, #13–#15) list the #1 codes WITHOUT common.dependency_unavailable ("#1 only"); #17 (read-only POST) = justification `E3 `;
// #19/#27/#28 idem optional; #27 also lists the idempotency codes ("as #25"); getReportSchedule carries the last 20 runs as an array property `runs`;
// paged ops: #8/#12 limit 1–200 default 50, #21/#24 limit max 50; download media types xlsx|csv|pdf; DTO schema names = the TRD bold names, in analytics.yaml.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRD = join(ROOT, "spec/chunks/C8-analytics-mis/02-TRD.md");
const FILE = join(ROOT, "contracts/openapi/analytics.yaml");
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const METHODS = ["get", "put", "post", "delete", "patch"];
const name = "analytics";
const PFX = "/v1/analytics";

const DASH = "analytics.dashboard.read", COLL = "analytics.collections.read", REF = "analytics.referral_report.read";
const EXP = "analytics.data.export", SCH = "analytics.schedule.manage";
const VF = "common.validation_failed", DOR = "common.date_out_of_range", RTL = "analytics.range_too_large", NF = "common.not_found", FB = "auth.forbidden";
const DEP = "common.dependency_unavailable", CUR = "common.invalid_cursor", FD = "common.feature_disabled", MFA = "auth.mfa_required";
const VC = "common.version_conflict", PRE = "common.precondition_required";
const IDEM = ["common.idempotency_key_required", "common.idempotency_key_reused", "common.idempotency_in_progress"];
const A1 = [VF, DOR, RTL, NF, FB]; // "as #1" minus the #1-only dependency_unavailable
const UNK = "analytics.report_unknown";
const SIX = [VF, NF, FB, "auth.unauthenticated", "common.rate_limited", "common.internal"];

type Spec = { n: number; id: string; method: string; path: string; perm: string; idem: "none" | "optional" | "required"; status: number;
  im?: boolean; err: string[]; paged?: boolean; max?: number; just?: RegExp; not?: string[] };
const S = (n: number, id: string, method: string, path: string, perm: string, idem: Spec["idem"], status: number, err: string[], o: Partial<Spec> = {}): Spec =>
  ({ n, id, method, path, perm, idem, status, err, ...o });
const N = "none" as const, O = "optional" as const, R = "required" as const;
const SCHED_ERR = [UNK, "analytics.recipient_ineligible", VF, NF, ...IDEM];

const SPECS: Spec[] = [
  S(1, "getAnalyticsDashboard", "GET", "/dashboard", DASH, N, 200, [...A1, DEP]),
  S(2, "getIncomeReport", "GET", "/reports/income", DASH, N, 200, A1, { not: [DEP] }),
  S(3, "getDepartmentIncomeReport", "GET", "/reports/department-income", DASH, N, 200, A1, { not: [DEP] }),
  S(4, "getCollectionsReport", "GET", "/reports/collections", COLL, N, 200, A1, { not: [DEP] }),
  S(5, "getVolumeReport", "GET", "/reports/volume", DASH, N, 200, A1, { not: [DEP] }),
  S(6, "getTopReferrersReport", "GET", "/reports/top-referrers", DASH, N, 200, A1, { not: [DEP] }),
  S(7, "getTopCentresReport", "GET", "/reports/top-centres", DASH, N, 200, A1, { not: [DEP] }),
  S(8, "getReferralIncentiveReport", "GET", "/reports/referral-incentive", REF, N, 200, [...A1, FD, MFA, CUR], { paged: true, max: 200, not: [DEP] }),
  S(9, "getTestsDoneReport", "GET", "/reports/tests-done", DASH, N, 200, A1, { not: [DEP] }),
  S(10, "getTatReport", "GET", "/reports/tat", DASH, N, 200, A1, { not: [DEP] }),
  S(11, "getPendingTestsSummary", "GET", "/reports/pending-tests/summary", DASH, N, 200, [VF, NF, FB, DEP]),
  S(12, "listPendingTests", "GET", "/reports/pending-tests/items", DASH, N, 200, [VF, NF, FB, DEP, CUR], { paged: true, max: 200 }),
  S(13, "getQualityIndicatorsReport", "GET", "/reports/quality-indicators", DASH, N, 200, A1, { not: [DEP] }),
  S(14, "getDeliveryReport", "GET", "/reports/delivery", DASH, N, 200, A1, { not: [DEP] }),
  S(15, "getInterfacesReport", "GET", "/reports/interfaces", DASH, N, 200, A1, { not: [DEP] }),
  S(16, "getAnalyticsFilterOptions", "GET", "/filter-options", DASH, N, 200, [FB]),
  S(17, "searchAnalyticsReferrers", "POST", "/referrers/search", DASH, N, 200, [VF], { just: /^E3 / }),
  S(18, "getAnalyticsFreshness", "GET", "/freshness", DASH, N, 200, []),
  S(19, "requestAnalyticsRefresh", "POST", "/refresh", DASH, O, 202, ["common.rate_limited", VF]),
  S(20, "createAnalyticsExport", "POST", "/exports", EXP, R, 202,
    [UNK, FD, RTL, VF, DOR, "common.rate_limited", FB, MFA, NF, ...IDEM]),
  S(21, "listAnalyticsExports", "GET", "/exports", EXP, N, 200, [CUR], { paged: true, max: 50 }),
  S(22, "getAnalyticsExport", "GET", "/exports/{export_id}", EXP, N, 200, [NF]),
  S(23, "downloadAnalyticsExport", "GET", "/exports/{export_id}/file", EXP, N, 200, [NF, "analytics.export_not_ready", "analytics.export_unavailable", MFA]),
  S(24, "listReportSchedules", "GET", "/schedules", SCH, N, 200, [], { paged: true, max: 50 }),
  S(25, "createReportSchedule", "POST", "/schedules", SCH, R, 201, SCHED_ERR),
  S(26, "getReportSchedule", "GET", "/schedules/{schedule_id}", SCH, N, 200, [NF]),
  S(27, "updateReportSchedule", "PUT", "/schedules/{schedule_id}", SCH, O, 200, [...SCHED_ERR, VC, PRE], { im: true }),
  S(28, "deactivateReportSchedule", "POST", "/schedules/{schedule_id}/deactivate", SCH, O, 200, [VC, PRE], { im: true }),
  S(29, "getReportRun", "GET", "/report-runs/{report_run_id}", DASH, N, 200, [NF]),
  S(30, "getCollectionsFilterOptions", "GET", "/filter-options/collections", COLL, N, 200, [FB]),
];
const TOTAL = 30;
const DTOS = ["Period", "ScopeEcho", "Freshness", "ReportEnvelope", "GroupKey", "Tile", "DashboardDto", "IncomeRow", "IncomeReport",
  "DepartmentIncomeReport", "CollectionsReport", "VolumeReport", "TopReferrersReport", "TopCentresReport", "ReferralIncentiveReport", "TestsDoneReport", "TatRow",
  "TatReport", "PendingSummary", "PendingItemDto", "QualityIndicatorsReport", "DeliveryReport", "InterfacesReport", "ExportParams", "ExportDto", "ScheduleInput",
  "ScheduleDto", "ReportRunDto"];
const PHI_PARAMS = ["barcode", "sample_barcode", "registration_no", "patient_id", "patient_name", "patient_display_name", "phone", "phone_e164", "email", "full_name", "name", "query"];
const REPORT_OPS = ["getAnalyticsDashboard", "getIncomeReport", "getDepartmentIncomeReport", "getCollectionsReport", "getVolumeReport", "getTopReferrersReport",
  "getTopCentresReport", "getReferralIncentiveReport", "getTestsDoneReport", "getTatReport", "getQualityIndicatorsReport", "getDeliveryReport", "getInterfacesReport"];
const PERIOD_SCOPE = ["getAnalyticsDashboard", "getIncomeReport", "getDepartmentIncomeReport", "getCollectionsReport", "getVolumeReport", "getTopReferrersReport",
  "getTopCentresReport", "getReferralIncentiveReport", "getTatReport", "getQualityIndicatorsReport", "getDeliveryReport", "getInterfacesReport"];
const SCOPE_ONLY = ["getPendingTestsSummary", "listPendingTests"];

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("analytics.yaml (T0C-10.C8)", () => {
  const text = existsSync(FILE) ? readFileSync(FILE, "utf8") : "";
  const doc: any = text ? parse(text) : { paths: {}, components: {} };
  const ops: Record<string, { method: string; path: string; op: any }> = {};
  for (const [path, item] of Object.entries<any>(doc.paths ?? {}))
    for (const m of METHODS) if (item?.[m]) ops[item[m].operationId] = { method: m.toUpperCase(), path, op: item[m] };

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
  const reqd = (s: any): string[] => {
    const n = deref(s) ?? {};
    return [...(n.required ?? []), ...(n.allOf ?? []).flatMap(reqd)];
  };
  const keys = (s: any) => Object.keys(props(s));
  const schema = (n: string) => doc.components?.schemas?.[n];
  const prop = (n: string, f: string) => deref(props(schema(n))[f]);
  const sub = (s: any, f: string) => deref(props(s)[f]);
  const bodySchema = (id: string) => deref(ops[id].op.requestBody?.content?.["application/json"]?.schema);
  const bp = (id: string, f: string) => deref(props(bodySchema(id))[f]);
  const params = (id: string) => (ops[id].op.parameters ?? []).map(deref);
  const param = (id: string, pname: string) => params(id).find((p: any) => p?.name === pname);
  const pschema = (id: string, pname: string) => deref(param(id, pname)?.schema);
  const okResp = (id: string, code?: string) => {
    const [, r] = Object.entries<any>(ops[id].op.responses).find(([c]) => (code ? c === code : /^2/.test(c)))!;
    return deref(r);
  };
  const okSchema = (id: string, code?: string) => deref(okResp(id, code).content?.["application/json"]?.schema);
  const has = (id: string) => expect(ops[id], `${id} missing`).toBeDefined();
  const num = (s: any) => [s?.minimum, s?.maximum];
  const rowsOf = (s: any) => deref(deref(props(s).rows).items);
  const arr = (s: any, f: string) => deref(props(s)[f]);

  describe("exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
    it("file exists", () => expect(existsSync(FILE), "contracts/openapi/analytics.yaml missing").toBe(true));
    it("first non-comment line is `openapi: 3.0.3`", () => {
      const first = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#"));
      expect(first?.trim()).toBe("openapi: 3.0.3");
    });
    it("info.title and version present; no `nullable: true` (no null on the wire)", () => {
      expect(typeof doc.info?.title).toBe("string");
      expect(typeof doc.info?.version).toBe("string");
      expect(text.length, "empty").toBeGreaterThan(0);
      expect(text).not.toMatch(/nullable:\s*true/);
    });
    it('no field, label or text anywhere says "commission" (PRD US-07.3, TRD §5.1)', () => {
      expect(text.length, "empty").toBeGreaterThan(0);
      expect(text).not.toMatch(/commission/i);
    });
  });

  describe("repo spec lint is green (AC-0C-1.4, rules 1–8, AB-20)", () => {
    it("lintRepo reports no violation", async () => {
      expect(existsSync(FILE), "contracts/openapi/analytics.yaml missing").toBe(true);
      const v = (await lintRepo(ROOT)).filter((x) => x.file === name);
      expect(v, v.map((x) => `[rule ${x.rule}] ${x.message}`).join("\n")).toEqual([]);
    });
  });

  describe("lint actually checks this file (AC-0C-1.5 negative)", () => {
    const mutate = async (fn: (d: any) => void) => {
      expect(existsSync(FILE), "contracts/openapi/analytics.yaml missing").toBe(true);
      const dir = mkdtempSync(join(tmpdir(), "c8-analytics-lint-"));
      tmps.push(dir);
      cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
      const d = parse(readFileSync(FILE, "utf8"));
      fn(d);
      writeFileSync(join(dir, "contracts/openapi/analytics.yaml"), stringify(d, { aliasDuplicateObjects: false }));
      return (await lintRepo(dir)).filter((x) => x.file === name);
    };
    const firstOp = (d: any, pred: (o: any) => boolean) =>
      Object.values<any>(d.paths).flatMap((p) => METHODS.map((m) => p[m]).filter(Boolean)).find(pred);

    it("x-permission not in permissions.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = "analytics.no_such.permission"; });
      expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
    });
    it("x-error-codes entry not in errors.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push("analytics.no_such_error"); });
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
    it("an operation with both x-permission and x-public fails (exactly one)", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-public"] = "bogus public justification text"; });
      expect(v.some((x) => x.rule === "4" && /exactly one/.test(x.message))).toBe(true);
    });
  });

  describe("inventory equals 02-TRD §5 (no missing, no extra operations)", () => {
    it(`${TOTAL} operations; table ids unique; file has exactly these`, () => {
      expect(SPECS.length).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.id)).size).toBe(TOTAL);
      expect(Object.keys(ops).sort()).toEqual(SPECS.map((s) => s.id).sort());
    });
    it("every operationId named in the TRD §5 table is in the test table (TRD drift guard)", () => {
      const lines = readFileSync(TRD, "utf8").split("\n");
      const start = lines.findIndex((l) => l.startsWith("## 5. Endpoints"));
      const end = lines.findIndex((l, i) => i > start && l.startsWith("### 5.1 "));
      const fromTrd = new Set<string>();
      for (const l of lines.slice(start, end)) {
        const c = l.split("|");
        if (/^\s*\d{1,2}\s*$/.test(c[1] ?? "") && c[2]) for (const m of c[2].matchAll(/`([a-z][A-Za-z0-9]+)`/g)) fromTrd.add(m[1]);
      }
      expect(fromTrd.size).toBe(TOTAL);
      const mine = new Set(SPECS.map((s) => s.id));
      for (const id of fromTrd) expect(mine.has(id), `TRD operationId ${id} not in test table`).toBe(true);
    });
    it("every path is /v1/analytics/… with tags [analytics]; no PHI path or query params (REQ-SEC-098)", () => {
      expect(Object.keys(doc.paths ?? {}).length, "no paths").toBeGreaterThan(0);
      for (const [p, item] of Object.entries<any>(doc.paths ?? {})) {
        expect(p.startsWith(`${PFX}/`), p).toBe(true);
        expect(p).not.toMatch(/\{(registration_no|barcode|sample_barcode|phone|patient_id|email)\}/);
        for (const m of METHODS) if (item[m]) expect(item[m].tags, `${m} ${p}`).toEqual([name]);
      }
      for (const [id] of Object.entries(ops))
        for (const q of params(id)) if (q?.in === "query") expect(PHI_PARAMS, `${id}?${q.name}`).not.toContain(q.name);
    });
  });

  describe.each(SPECS)("#$n $id", (r) => {
    const o = ops[r.id]?.op;
    it("exists at the TRD method + path", () => {
      has(r.id);
      expect(`${ops[r.id].method} ${ops[r.id].path}`).toBe(`${r.method} ${PFX}${r.path}`);
    });
    it("has tags, summary, x-idempotency (TRD Idem), x-rate-limit-tier general, x-error-codes", () => {
      has(r.id);
      expect(o.tags).toEqual([name]);
      expect(typeof o.summary).toBe("string");
      expect(o["x-idempotency"]).toBe(r.idem);
      expect(o["x-rate-limit-tier"]).toBe("general");
      expect(Array.isArray(o["x-error-codes"])).toBe(true);
    });
    it(`x-permission = ${r.perm}, never x-public; security bearerJwt; tenant context only`, () => {
      has(r.id);
      expect(o["x-permission"]).toBe(r.perm);
      expect(o["x-public"]).toBeUndefined();
      expect(o.security).toEqual([{ bearerJwt: [] }]);
      expect([undefined, "tenant"]).toContain(o["x-context"]);
    });
    it("success response status; POST with idem none carries the TRD justification letter (P-8, LD-10)", () => {
      has(r.id);
      expect(Object.keys(o.responses ?? {}), `want ${r.status}`).toContain(String(r.status));
      if (r.method === "POST" && r.idem === "none") expect(o["x-idempotency-justification"]).toMatch(r.just ?? /^E[1-4] /);
    });
    it("lists the TRD specific error codes plus the common codes (+ If-Match codes on IM rows)", () => {
      has(r.id);
      for (const c of [...SIX, ...r.err]) expect(o["x-error-codes"], c).toContain(c);
      for (const c of r.not ?? []) expect(o["x-error-codes"], `${c} is #1-only`).not.toContain(c);
      if (!r.im) expect(o["x-error-codes"]).not.toContain(PRE);
    });
    it("Idempotency-Key where x-idempotency required; If-Match exactly on #27/#28", () => {
      has(r.id);
      const ps = JSON.stringify(o.parameters ?? []);
      if (r.idem === "required") expect(ps).toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.idem === "none") expect(ps).not.toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.im) expect(ps).toMatch(/IfMatch|If-Match/);
      else expect(ps).not.toMatch(/IfMatch|If-Match/);
    });
    if (r.paged)
      it(`takes cursor + limit (max ${r.max})`, () => {
        has(r.id);
        const ps = JSON.stringify(o.parameters ?? []);
        expect(ps).toMatch(/cursor|Cursor/);
        expect(ps).toMatch(/limit|Limit/);
        const lim = pschema(r.id, "limit");
        expect(lim?.maximum).toBe(r.max);
        if (r.max === 200) expect(lim.default).toBe(50);
      });
  });

  describe("shape pins from TRD §5 / §5.1 / §10", () => {
    it("named DTO schemas are components", () => {
      for (const n of DTOS) expect(schema(n), n).toBeDefined();
    });
    it("request bodies are JSON; no tenant_id / created_by in any JSON body (rule 7)", () => {
      expect(Object.keys(ops).length, "no operations").toBe(TOTAL);
      for (const [id, { op }] of Object.entries(ops)) {
        for (const k of Object.keys(op.requestBody?.content ?? {})) expect(k, id).toBe("application/json");
        const s = deref(op.requestBody?.content?.["application/json"]?.schema);
        if (s) for (const f of ["tenant_id", "created_by", "updated_by"]) expect(keys(s), `${id}.${f}`).not.toContain(f);
      }
    });

    it("PeriodQuery on every period report: business_date_from/to date, bs_month and fiscal_year_bs patterns, none required", () => {
      for (const id of [...PERIOD_SCOPE, "getTestsDoneReport"]) {
        for (const f of ["business_date_from", "business_date_to"]) {
          expect(pschema(id, f)?.type, `${id}.${f}`).toBe("string");
          expect(pschema(id, f)?.format, `${id}.${f}`).toBe("date");
          expect(param(id, f).required ?? false).toBe(false);
        }
        expect(pschema(id, "bs_month")?.pattern, id).toBe("^[0-9]{4}-(0[1-9]|1[0-2])$");
        expect(pschema(id, "fiscal_year_bs")?.pattern, id).toBe("^[0-9]{4}/[0-9]{2}$");
      }
    });
    it("PeriodQuery is absent from the live pending endpoints (#11, #12)", () => {
      for (const id of SCOPE_ONLY) for (const f of ["business_date_from", "business_date_to", "bs_month", "fiscal_year_bs"]) expect(param(id, f), `${id}.${f}`).toBeUndefined();
    });
    it("ScopeQuery: centre_id / branch_id are uuid arrays, ≤ 20, form style, explode false", () => {
      for (const id of [...PERIOD_SCOPE, ...SCOPE_ONLY, "getAnalyticsDashboard"])
        for (const f of ["centre_id", "branch_id"]) {
          const p = param(id, f);
          expect(p, `${id}.${f}`).toBeDefined();
          const s = deref(p.schema);
          expect([s.type, s.maxItems, deref(s.items)?.format ?? deref(s.items)?.$ref], `${id}.${f}`).toEqual(["array", 20, expect.anything()]);
          expect([p.style, p.explode], `${id}.${f}`).toEqual(["form", false]);
        }
    });
    it("getTestsDoneReport takes Period only plus processing_branch_id/department_id (no centre_id / branch_id)", () => {
      expect(param("getTestsDoneReport", "centre_id")).toBeUndefined();
      expect(param("getTestsDoneReport", "branch_id")).toBeUndefined();
      expect([pschema("getTestsDoneReport", "processing_branch_id").maxItems, pschema("getTestsDoneReport", "department_id").maxItems]).toEqual([20, 50]);
      expect(pschema("getTestsDoneReport", "group_by").enum).toEqual(["department", "test", "processing_branch", "day", "ad_month", "bs_month"]);
    });
    it("group_by enums and defaults per report", () => {
      const g = (id: string) => pschema(id, "group_by");
      expect(g("getIncomeReport").enum).toEqual(["day", "ad_month", "bs_month", "branch", "centre"]);
      expect(g("getIncomeReport").default).toBe("day");
      expect(g("getDepartmentIncomeReport").enum).toEqual(["department", "department_ad_month", "department_bs_month"]);
      expect(g("getDepartmentIncomeReport").default).toBe("department");
      expect(g("getCollectionsReport").enum).toEqual(["method", "staff", "staff_method", "centre", "day", "ad_month", "bs_month"]);
      expect(g("getCollectionsReport").default).toBe("method");
      expect(g("getVolumeReport").enum).toEqual(["day", "ad_month", "bs_month", "branch", "centre"]);
      expect(g("getReferralIncentiveReport").enum).toEqual(["referrer", "referrer_ad_month", "referrer_bs_month"]);
      expect(g("getTatReport").enum).toEqual(["none", "centre", "processing_branch", "priority", "specimen_type", "day", "ad_month", "bs_month"]);
      expect(g("getTatReport").default).toBe("none");
      expect(g("getQualityIndicatorsReport").enum).toEqual(["reason", "centre", "specimen_type", "day", "ad_month", "bs_month"]);
      expect(g("getDeliveryReport").enum).toEqual(["channel", "day", "ad_month", "bs_month"]);
    });
    it("report filters: department_id ≤ 50, payment_method_code coded set ≤ 20, referrer filters, top-N bounds", () => {
      expect(pschema("getDepartmentIncomeReport", "department_id").maxItems).toBe(50);
      const pm = pschema("getCollectionsReport", "payment_method_code");
      expect([pm.type, pm.maxItems]).toEqual(["array", 20]);
      expect(deref(pm.items)["x-coded-set"] ?? pm["x-coded-set"]).toMatch(/^(billing\.)?payment_methods$/);
      expect(deref(pm.items).enum ?? pm.enum).toBeUndefined();
      const sort6 = pschema("getTopReferrersReport", "sort");
      expect([sort6.enum, sort6.default]).toEqual([["-orders", "-patient_visits", "-tests_ordered"], "-orders"]);
      expect([num(pschema("getTopReferrersReport", "limit")), pschema("getTopReferrersReport", "limit").default]).toEqual([[1, 100], 20]);
      expect([pschema("getTopReferrersReport", "rollup").enum, pschema("getTopReferrersReport", "rollup").default]).toEqual([["canonical", "none"], "canonical"]);
      expect(pschema("getTopReferrersReport", "referrer_id").maxItems).toBe(20);
      expect(pschema("getTopCentresReport", "sort").enum).toEqual(["-orders", "-net_sales_paisa", "-patient_visits", "-tests_ordered"]);
      expect([num(pschema("getTopCentresReport", "limit")), pschema("getTopCentresReport", "limit").default]).toEqual([[1, 50], 20]);
      expect(pschema("getReferralIncentiveReport", "rollup").enum).toEqual(["canonical", "none"]);
      expect(pschema("getReferralIncentiveReport", "referrer_id").maxItems).toBe(20);
    });
    it("getTatReport filters: segment enum[] (5), priority, specimen_type_code ≤ 20, processing_branch_id ≤ 20", () => {
      const seg = pschema("getTatReport", "segment");
      expect(seg.type).toBe("array");
      expect(deref(seg.items).enum).toEqual(["pre_analytical", "transport", "within_lab", "total_first_release", "total_final_release"]);
      expect(pschema("getTatReport", "priority").enum).toEqual(["routine", "urgent"]);
      expect(pschema("getTatReport", "specimen_type_code").maxItems).toBe(20);
      expect(pschema("getTatReport", "processing_branch_id").maxItems).toBe(20);
    });
    it("pending endpoints: filters, item_status enum[], overdue_only, sort", () => {
      for (const id of SCOPE_ONLY) {
        expect(pschema(id, "department_id").maxItems, id).toBe(50);
        expect(pschema(id, "priority").enum, id).toEqual(["routine", "urgent"]);
        expect(pschema(id, "processing_branch_id").maxItems, id).toBe(20);
      }
      expect(deref(pschema("listPendingTests", "item_status").items).enum).toEqual(["awaiting_collection", "awaiting_receipt", "in_process", "resulted", "verified"]);
      expect(pschema("listPendingTests", "overdue_only").type).toBe("boolean");
      const s = pschema("listPendingTests", "sort");
      expect([s.enum, s.default]).toEqual([["-age_seconds", "age_seconds"], "-age_seconds"]);
    });

    it("ReportEnvelope + Period + ScopeEcho + Freshness + GroupKey (§5 shared components)", () => {
      expect(keys(schema("ReportEnvelope")).sort()).toEqual(["freshness", "generated_at", "period", "report_code", "scope"]);
      expect(prop("ReportEnvelope", "freshness").maxItems).toBe(20);
      expect(keys(schema("Period")).sort()).toEqual(["bs_month", "business_date_from", "business_date_to", "days", "fiscal_year_bs", "label_ad", "label_bs", "timezone"]);
      expect(prop("Period", "timezone").enum).toEqual(["Asia/Kathmandu"]);
      expect(keys(schema("ScopeEcho")).sort()).toEqual(["all_centres", "centre_ids", "tenant_wide_sections_hidden"]);
      expect(prop("ScopeEcho", "centre_ids").maxItems).toBe(50);
      expect(prop("ScopeEcho", "tenant_wide_sections_hidden").maxItems).toBe(20);
      expect(keys(schema("Freshness")).sort()).toEqual(["family", "is_stale", "live", "refreshed_at", "stale_reason"]);
      expect(prop("Freshness", "stale_reason").enum).toEqual(["refresh_lagging", "refresh_failed", "never_refreshed"]);
      expect(prop("Freshness", "family")["x-coded-set"]).toMatch(/^(analytics\.)?families$/);
      expect(prop("Freshness", "family").enum).toBeUndefined();
      expect(keys(schema("GroupKey")).sort()).toEqual(["is_inactive", "key", "label", "label_bs"]);
      expect([prop("GroupKey", "key").maxLength, prop("GroupKey", "label").maxLength, prop("GroupKey", "label_bs").maxLength]).toEqual([64, 200, 32]);
      for (const n of ["ReportEnvelope", "Period", "ScopeEcho", "Freshness", "GroupKey"]) expect(schema(n).additionalProperties, n).toBe(false);
    });
    it("every report response carries the envelope (report_code, period, scope, freshness, generated_at)", () => {
      for (const id of REPORT_OPS)
        expect(keys(okSchema(id)), id).toEqual(expect.arrayContaining(["report_code", "period", "scope", "freshness", "generated_at"]));
    });
    it("getPendingTestsSummary: envelope WITHOUT period; summary fields; age buckets enum", () => {
      const s = okSchema("getPendingTestsSummary");
      const k = keys(s);
      expect(k).toEqual(expect.arrayContaining(["report_code", "scope", "freshness", "generated_at", "total", "overdue", "no_target", "by_status", "by_priority",
        "by_department", "by_age_bucket", "backlog", "age_anchor_note_key"]));
      expect(k).not.toContain("period");
      expect(deref(sub(s, "by_department")).maxItems).toBe(200);
      expect(deref(props(deref(deref(sub(s, "by_age_bucket")).items)).bucket).enum).toEqual(["lt_4h", "h4_24", "d1_3", "gt_3d"]);
      expect(Object.keys(props(sub(s, "backlog")))).toEqual(expect.arrayContaining(["reports_pending", "awaiting_results", "ready_unreleased", "oldest_registered_at", "by_centre"]));
    });
    it("PendingItemDto: TRD fields, item_status enum, open_route_id enum [staff.lab.order_results]; listPendingTests returns a page", () => {
      const k = keys(schema("PendingItemDto"));
      expect(k).toEqual(expect.arrayContaining(["order_item_id", "order_id", "centre_id", "processing_branch_id", "department_id", "test_id", "test_code", "test_label",
        "priority", "item_status", "age_seconds", "tat_target_seconds", "is_overdue", "open_route_id"]));
      expect(prop("PendingItemDto", "open_route_id").enum).toEqual(["staff.lab.order_results"]);
      expect(prop("PendingItemDto", "item_status").enum).toEqual(["awaiting_collection", "awaiting_receipt", "in_process", "resulted", "verified"]);
      expect(schema("PendingItemDto").additionalProperties).toBe(false);
      expect(keys(okSchema("listPendingTests"))).toEqual(expect.arrayContaining(["data", "page"]));
      expect(deref(deref(props(okSchema("listPendingTests")).data).items)).toEqual(deref(schema("PendingItemDto")));
    });

    it("Tile: value + optional previous/delta/delta_bp, unit enum; DashboardDto tiles (collections tile optional) + series ≤ 366 + department_top ≤ 10", () => {
      expect(keys(schema("Tile")).sort()).toEqual(["delta", "delta_bp", "previous", "unit", "value"]);
      expect(reqd(schema("Tile")).sort()).toEqual(["unit", "value"]);
      expect(prop("Tile", "unit").enum).toEqual(["count", "paisa", "seconds"]);
      const tiles = prop("DashboardDto", "tiles");
      expect(Object.keys(props(tiles)).sort()).toEqual(["credit_notes_paisa", "invoiced_paisa", "net_collected_paisa", "net_orders", "net_sales_paisa", "new_patients",
        "patient_visits", "pending_overdue", "pending_tests", "reports_pending", "reports_ready_unreleased", "results_approved", "tests_ordered"]);
      expect(reqd(tiles)).not.toContain("net_collected_paisa");
      expect(reqd(tiles)).toEqual(expect.arrayContaining(["patient_visits", "net_sales_paisa", "pending_overdue", "results_approved"]));
      expect(deref(sub(prop("DashboardDto", "series"), "days")).maxItems).toBe(366);
      expect(Object.keys(props(deref(deref(sub(prop("DashboardDto", "series"), "days")).items))).sort()).toEqual(["business_date", "net_orders", "net_sales_paisa", "patient_visits"]);
      const dt = prop("DashboardDto", "department_top");
      expect(dt.maxItems).toBe(10);
      expect(Object.keys(props(deref(dt.items))).sort()).toEqual(["department_id", "is_multiple", "label", "net_paisa", "share_bp"]);
    });
    it("IncomeRow / IncomeReport / DepartmentIncomeReport / CollectionsReport rows and caps", () => {
      expect(keys(schema("IncomeRow"))).toEqual(expect.arrayContaining(["key", "label", "invoices_issued", "invoices_cancelled", "gross_paisa", "discount_paisa", "exempt_paisa",
        "taxable_paisa", "vat_paisa", "other_tax_paisa", "invoiced_paisa", "credit_notes_paisa", "net_sales_paisa"]));
      expect(deref(props(schema("IncomeReport")).rows).maxItems).toBe(400);
      expect(keys(schema("IncomeReport"))).toEqual(expect.arrayContaining(["rows", "totals", "basis_note_key"]));
      const d = schema("DepartmentIncomeReport");
      expect(deref(props(d).rows).maxItems).toBe(5000);
      expect(Object.keys(props(rowsOf(d)))).toEqual(expect.arrayContaining(["department_id", "is_multiple", "period_key", "line_count", "gross_paisa", "discount_paisa", "net_paisa", "share_bp"]));
      expect(Object.keys(props(sub(d, "totals"))).sort()).toEqual(["discount_paisa", "gross_paisa", "line_count", "net_paisa"]);
      expect(prop("DepartmentIncomeReport", "reconciles_with_income").type).toBe("boolean");
      const c = schema("CollectionsReport");
      expect(deref(props(c).rows).maxItems).toBe(5000);
      expect(Object.keys(props(rowsOf(c)))).toEqual(expect.arrayContaining(["entries", "reversals", "gross_collected_paisa", "reversed_paisa", "net_collected_paisa"]));
      expect(prop("CollectionsReport", "daily_cash_route_id").enum).toEqual(["staff.billing.daily_cash"]);
      expect(reqd(c)).not.toContain("daily_cash_route_id");
    });
    it("VolumeReport / TopCentresReport / TestsDoneReport rows and caps", () => {
      const v = schema("VolumeReport");
      expect(deref(props(v).rows).maxItems).toBe(400);
      expect(Object.keys(props(rowsOf(v)))).toEqual(expect.arrayContaining(["orders_registered", "orders_cancelled", "net_orders", "patient_visits", "new_patients", "urgent_orders",
        "opd_orders", "ipd_orders", "tests_ordered"]));
      const c = schema("TopCentresReport");
      expect(deref(props(c).rows).maxItems).toBe(50);
      expect(Object.keys(props(rowsOf(c)))).toEqual(expect.arrayContaining(["rank", "centre_id", "label", "branch_id", "orders", "patient_visits", "tests_ordered", "net_sales_paisa", "by_mode"]));
      expect(Object.keys(props(sub(rowsOf(c), "by_mode"))).sort()).toEqual(["centre", "home", "partner", "walk_in"]);
      const t = schema("TestsDoneReport");
      expect(deref(props(t).rows).maxItems).toBe(5000);
      expect(Object.keys(props(rowsOf(t)))).toEqual(expect.arrayContaining(["results_resulted", "results_verified", "results_approved", "results_amended", "auto_verified",
        "critical_count", "abnormal_count", "tests_approved"]));
    });
    it("TopReferrersReport is volume only: NO money / incentive field anywhere (D-44, B13); rows ≤ 100", () => {
      const s = schema("TopReferrersReport");
      expect(deref(props(s).rows).maxItems).toBe(100);
      expect(Object.keys(props(rowsOf(s)))).toEqual(expect.arrayContaining(["rank", "referrer_id", "label", "is_self", "is_inactive", "orders", "patient_visits", "tests_ordered"]));
      const all = [...Object.keys(props(rowsOf(s))), ...Object.keys(props(sub(s, "totals")))];
      expect(Object.keys(props(sub(s, "totals"))).sort()).toEqual(["orders", "patient_visits", "tests_ordered"]);
      for (const f of all) expect(f, f).not.toMatch(/paisa|amount|billed|incentive|share|revenue|income/);
    });
    it("ReferralIncentiveReport: the ONLY response with net_billed_paisa, optional (absent on SELF row); paged ≤ 200", () => {
      const s = schema("ReferralIncentiveReport");
      expect(deref(props(s).rows).maxItems).toBe(200);
      const row = rowsOf(s);
      expect(Object.keys(props(row))).toEqual(expect.arrayContaining(["referrer_id", "label", "is_self", "period_key", "period_label", "orders", "patient_visits", "tests_ordered", "net_billed_paisa"]));
      expect(reqd(row)).not.toContain("net_billed_paisa");
      expect(keys(s)).toEqual(expect.arrayContaining(["totals", "billed_note_key", "page"]));
      for (const n of ["TopReferrersReport", "TopCentresReport", "IncomeReport", "VolumeReport"])
        expect(JSON.stringify(schema(n)), n).not.toContain("net_billed_paisa");
    });
    it("TatReport: rows ≤ 2000, TatRow stats optional (omitted when n = 0), segment_definitions", () => {
      expect(Object.keys(props(schema("TatRow"))).sort()).toEqual(["anomalies", "key", "label", "max_seconds", "median_seconds", "n", "p90_seconds", "segment"]);
      expect(reqd(schema("TatRow"))).not.toEqual(expect.arrayContaining(["median_seconds"]));
      expect(deref(props(schema("TatReport")).rows).maxItems).toBe(2000);
      expect(Object.keys(props(deref(deref(prop("TatReport", "segment_definitions")).items))).sort()).toEqual(["segment", "start_label_key", "stop_label_key"]);
    });
    it("QualityIndicatorsReport / DeliveryReport / InterfacesReport shapes", () => {
      const q = schema("QualityIndicatorsReport");
      expect(Object.keys(props(q)).sort()).toEqual(["critical_values", "rejections"]);
      expect(Object.keys(props(rowsOf(sub(q, "rejections"))))).toEqual(expect.arrayContaining(["rejections", "recollections_ordered", "specimens_received", "per_100_received_bp"]));
      const cv = sub(q, "critical_values");
      expect(deref(props(cv).rows).maxItems).toBe(366);
      expect(Object.keys(props(rowsOf(cv)))).toEqual(expect.arrayContaining(["business_date", "detected", "notified", "notified_bp", "median_notify_seconds", "max_notify_seconds"]));
      const d = schema("DeliveryReport");
      expect(Object.keys(props(d)).sort()).toEqual(["deliveries", "releases"]);
      expect(Object.keys(props(rowsOf(sub(d, "deliveries"))))).toEqual(expect.arrayContaining(["queued", "sent", "delivered", "read", "failed", "suppressed", "failure_share_bp"]));
      expect(Object.keys(props(rowsOf(sub(d, "releases"))))).toEqual(expect.arrayContaining(["released", "final", "partial", "preliminary", "amended", "overrides"]));
      const i = schema("InterfacesReport");
      expect(deref(props(i).instruments).maxItems).toBe(200);
      expect(Object.keys(props(deref(deref(props(i).instruments).items)))).toEqual(expect.arrayContaining(["instrument_id", "instrument_code", "label", "is_active", "centre_id",
        "messages", "patient_records", "qc_records", "unmatched", "quarantined", "duplicates"]));
      const ag = sub(i, "agents");
      expect(Object.keys(props(ag)).sort()).toEqual(["agents", "by_state"]);
      expect(deref(props(ag).agents).maxItems).toBe(200);
      expect(Object.keys(props(deref(deref(props(ag).agents).items))).sort()).toEqual(["agent_id", "agent_version", "centre_id", "last_heartbeat_at", "queue_depth", "state"]);
    });

    it("getAnalyticsFilterOptions: lists + caps; recipients optional; getCollectionsFilterOptions: centres, branches, payment_methods only", () => {
      const s = okSchema("getAnalyticsFilterOptions");
      expect(Object.keys(props(s)).sort()).toEqual(["branches", "centres", "departments", "payment_methods", "recipients", "specimen_types"]);
      expect(reqd(s)).not.toContain("recipients");
      const caps: Record<string, number> = { centres: 200, branches: 50, departments: 200, payment_methods: 50, specimen_types: 100, recipients: 200 };
      for (const [f, m] of Object.entries(caps)) expect(deref(props(s)[f]).maxItems, f).toBe(m);
      expect(Object.keys(props(deref(deref(props(s).recipients).items))).sort()).toEqual(["display_name", "membership_id"]);
      expect(Object.keys(props(deref(deref(props(s).centres).items))).sort()).toEqual(["branch_id", "id", "is_active", "label"]);
      const c = okSchema("getCollectionsFilterOptions");
      expect(Object.keys(props(c)).sort()).toEqual(["branches", "centres", "payment_methods"]);
      for (const f of ["centres", "branches", "payment_methods"]) expect(deref(props(c)[f]).maxItems, f).toBe(caps[f]);
    });
    it("searchAnalyticsReferrers: POST body {query 2–60} closed (no PHI in URL); data ≤ 20 {referrer_id, label, is_active}", () => {
      const b = bodySchema("searchAnalyticsReferrers");
      expect(b.additionalProperties).toBe(false);
      expect(reqd(b)).toEqual(["query"]);
      expect([bp("searchAnalyticsReferrers", "query").minLength, bp("searchAnalyticsReferrers", "query").maxLength]).toEqual([2, 60]);
      const d = deref(props(okSchema("searchAnalyticsReferrers")).data);
      expect(d.maxItems).toBe(20);
      expect(Object.keys(props(deref(d.items))).sort()).toEqual(["is_active", "label", "referrer_id"]);
    });
    it("getAnalyticsFreshness: {data: Freshness[]}; requestAnalyticsRefresh: families ≤ 20 optional, 202 {queued_families, next_allowed_at}, 429 listed", () => {
      expect(Object.keys(props(okSchema("getAnalyticsFreshness")))).toEqual(["data"]);
      const b = bodySchema("requestAnalyticsRefresh");
      expect(b.additionalProperties).toBe(false);
      expect(reqd(b)).toEqual([]);
      expect(bp("requestAnalyticsRefresh", "families").maxItems).toBe(20);
      expect(Object.keys(props(okSchema("requestAnalyticsRefresh", "202"))).sort()).toEqual(["next_allowed_at", "queued_families"]);
      expect(Object.keys(ops.requestAnalyticsRefresh.op.responses)).toContain("429");
    });

    it("createAnalyticsExport: body {report_code, format xlsx|csv|pdf, params}, closed; 202 ExportDto; 429 quota listed", () => {
      const b = bodySchema("createAnalyticsExport");
      expect(b.additionalProperties).toBe(false);
      expect(reqd(b).sort()).toEqual(["format", "params", "report_code"]);
      expect(bp("createAnalyticsExport", "format").enum).toEqual(["xlsx", "csv", "pdf"]);
      expect(bp("createAnalyticsExport", "report_code").type).toBe("string");
      expect(deref(props(b).params)).toEqual(deref(schema("ExportParams")));
      expect(keys(okSchema("createAnalyticsExport"))).toEqual(expect.arrayContaining(["id", "report_code", "format", "status"]));
      expect(Object.keys(ops.createAnalyticsExport.op.responses)).toContain("429");
    });
    it("ExportParams: closed; period selectors, scope ≤ 20, group_by ≤ 32, filters closed with the TRD enums", () => {
      const s = schema("ExportParams");
      expect(s.additionalProperties).toBe(false);
      expect(Object.keys(props(s)).sort()).toEqual(["bs_month", "branch_id", "business_date_from", "business_date_to", "centre_id", "filters", "fiscal_year_bs", "group_by"].sort());
      expect(reqd(s)).toEqual([]);
      expect([prop("ExportParams", "centre_id").maxItems, prop("ExportParams", "branch_id").maxItems, prop("ExportParams", "group_by").maxLength]).toEqual([20, 20, 32]);
      const f = prop("ExportParams", "filters");
      expect(f.additionalProperties).toBe(false);
      expect(Object.keys(props(f)).sort()).toEqual(["department_id", "item_status", "overdue_only", "payment_method_code", "priority", "processing_branch_id", "referrer_id", "rollup",
        "segment"]);
      expect([deref(props(f).department_id).maxItems, deref(props(f).processing_branch_id).maxItems, deref(props(f).payment_method_code).maxItems, deref(props(f).referrer_id).maxItems])
        .toEqual([50, 20, 20, 20]);
      expect(deref(props(f).priority).enum).toEqual(["routine", "urgent"]);
      expect(deref(props(f).rollup).enum).toEqual(["canonical", "none"]);
      expect(deref(deref(props(f).item_status).items).enum).toEqual(["awaiting_collection", "awaiting_receipt", "in_process", "resulted", "verified"]);
    });
    it("ExportDto: status enum, downloads counters, optional ready_at/expires_at/row_count/size_bytes/failure_code", () => {
      const s = schema("ExportDto");
      expect(s.additionalProperties).toBe(false);
      expect(Object.keys(props(s)).sort()).toEqual(["downloads_allowed", "downloads_used", "expires_at", "failure_code", "format", "id", "params", "ready_at", "report_code", "requested_at",
        "row_count", "size_bytes", "status"]);
      expect(prop("ExportDto", "status").enum).toEqual(["queued", "building", "ready", "failed", "expired"]);
      expect(prop("ExportDto", "format").enum).toEqual(["xlsx", "csv", "pdf"]);
      expect(reqd(s)).toEqual(expect.arrayContaining(["id", "report_code", "format", "status", "params", "requested_at", "downloads_used", "downloads_allowed"]));
      for (const f of ["ready_at", "expires_at", "row_count", "size_bytes", "failure_code"]) expect(reqd(s), f).not.toContain(f);
      for (const f of ["tenant_id", "sha256", "content", "scope_centre_ids"]) expect(Object.keys(props(s)), f).not.toContain(f);
    });
    it("listAnalyticsExports: status enum[] filter; page of ExportDto (own only)", () => {
      expect(deref(pschema("listAnalyticsExports", "status").items).enum).toEqual(["queued", "building", "ready", "failed", "expired"]);
      expect(keys(okSchema("listAnalyticsExports"))).toEqual(expect.arrayContaining(["data", "page"]));
      expect(deref(deref(props(okSchema("listAnalyticsExports")).data).items)).toEqual(deref(schema("ExportDto")));
    });
    it("downloadAnalyticsExport: binary xlsx|csv|pdf, never JSON; attachment + no-store + nosniff headers (P-2); 409 and 410 responses", () => {
      const r = okResp("downloadAnalyticsExport");
      expect(Object.keys(r.content ?? {}).sort()).toEqual(["application/pdf", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv"]);
      expect(r.content?.["application/json"]).toBeUndefined();
      const h = JSON.stringify(r.headers ?? {}).toLowerCase();
      for (const x of ["content-disposition", "cache-control", "x-content-type-options"]) expect(h, x).toContain(x);
      for (const c of ["404", "409", "410"]) expect(Object.keys(ops.downloadAnalyticsExport.op.responses), c).toContain(c);
    });

    it("ScheduleInput: TRD bounds, closed; weekday not schema-required (required iff weekly is a server rule)", () => {
      const s = schema("ScheduleInput");
      expect(s.additionalProperties).toBe(false);
      expect(reqd(s).sort()).toEqual(["frequency", "name", "period_rule", "recipient_membership_ids", "report_codes", "scope", "send_time_local"]);
      expect([prop("ScheduleInput", "name").minLength, prop("ScheduleInput", "name").maxLength]).toEqual([1, 80]);
      expect([prop("ScheduleInput", "report_codes").minItems, prop("ScheduleInput", "report_codes").maxItems]).toEqual([1, 10]);
      expect(prop("ScheduleInput", "frequency").enum).toEqual(["daily", "weekly", "monthly_ad", "monthly_bs"]);
      expect(prop("ScheduleInput", "send_time_local").pattern).toBe("^([01][0-9]|2[0-3]):(00|15|30|45)$");
      expect(num(prop("ScheduleInput", "weekday"))).toEqual([1, 7]);
      expect(prop("ScheduleInput", "period_rule").enum).toEqual(["previous_business_day", "previous_7_days", "month_to_date_ad", "previous_ad_month", "month_to_date_bs",
        "previous_bs_month", "fiscal_year_to_date"]);
      const sc = prop("ScheduleInput", "scope");
      expect(sc.additionalProperties).toBe(false);
      expect(Object.keys(props(sc)).sort()).toEqual(["all_centres", "centre_ids"]);
      expect(deref(props(sc).centre_ids).maxItems).toBe(20);
      expect([prop("ScheduleInput", "recipient_membership_ids").minItems, prop("ScheduleInput", "recipient_membership_ids").maxItems]).toEqual([1, 20]);
      for (const f of ["tenant_id", "owner_membership_id", "created_by"]) expect(Object.keys(props(s)), f).not.toContain(f);
    });
    it("ScheduleDto = ScheduleInput + id, version, is_active, next_run_at, created_at, owner_membership_id, last_run; create/update take ScheduleInput", () => {
      const k = keys(schema("ScheduleDto"));
      expect(k).toEqual(expect.arrayContaining([...keys(schema("ScheduleInput")), "id", "version", "is_active", "next_run_at", "created_at", "owner_membership_id", "last_run"]));
      expect(deref(bodySchema("createReportSchedule"))).toEqual(deref(schema("ScheduleInput")));
      expect(deref(bodySchema("updateReportSchedule"))).toEqual(deref(schema("ScheduleInput")));
      expect(keys(okSchema("createReportSchedule"))).toEqual(expect.arrayContaining(["id", "version", "is_active"]));
      expect(keys(okSchema("updateReportSchedule"))).toEqual(expect.arrayContaining(["id", "version"]));
      expect(keys(okSchema("deactivateReportSchedule"))).toEqual(expect.arrayContaining(["id", "version", "is_active"]));
      expect(bodySchema("deactivateReportSchedule")?.additionalProperties ?? false).toBe(false);
    });
    it("listReportSchedules: is_active boolean filter; getReportSchedule: ScheduleDto + last 20 runs", () => {
      expect(pschema("listReportSchedules", "is_active").type).toBe("boolean");
      expect(keys(okSchema("listReportSchedules"))).toEqual(expect.arrayContaining(["data", "page"]));
      const s = okSchema("getReportSchedule");
      expect(keys(s)).toEqual(expect.arrayContaining([...keys(schema("ScheduleDto")), "runs"]));
      expect(deref(props(s).runs).maxItems).toBe(20);
    });
    it("ReportRunDto: TRD fields, effective_scope = ScopeEcho, recipients optional (owner only)", () => {
      const s = schema("ReportRunDto");
      expect(s.additionalProperties).toBe(false);
      expect(Object.keys(props(s)).sort()).toEqual(["created_at", "effective_scope", "id", "period", "recipients", "report_codes", "schedule_id", "schedule_name", "scope_all_centres",
        "scope_centre_ids", "viewer_omitted_report_codes"]);
      expect(reqd(s)).not.toContain("recipients");
      expect(Object.keys(props(deref(deref(props(s).recipients).items))).sort()).toEqual(["display_name", "membership_id", "outcome"]);
      expect(keys(okSchema("getReportRun"))).toEqual(expect.arrayContaining(["id", "schedule_id", "effective_scope", "viewer_omitted_report_codes"]));
    });
    it("DTO allowlists: no tenant_id / internal columns anywhere in a response schema", () => {
      for (const n of DTOS) {
        const blob = JSON.stringify(schema(n));
        expect(blob, n).not.toMatch(/"tenant_id"|"created_by"|"updated_by"|"requested_by_membership_id"/);
      }
    });
  });

  // ---------- "Prism smoke", offline: examples validate against their schemas ----------
  describe("examples validate against their schemas; each operation has a servable example (Prism smoke); examples are synthetic", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...doc, id: "analytics.yaml" });
    const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    const check = (ptr: string, example: unknown) => {
      const validate = ajv.getSchema(`analytics.yaml#${ptr}`);
      expect(validate, `cannot resolve ${ptr}`).toBeDefined();
      expect(validate!(example), `${ptr}: ${JSON.stringify(validate!.errors?.[0])}`).toBe(true);
    };
    const exampleValues = (): unknown[] => {
      const out: unknown[] = [];
      const walk = (x: any) => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === "object") {
          for (const [k, v] of Object.entries<any>(x)) {
            if (k === "example") out.push(v);
            else if (k === "examples" && v && typeof v === "object") for (const e of Object.values<any>(v)) out.push(e?.value);
            else walk(v);
          }
        }
      };
      walk(doc);
      return out;
    };
    it("every JSON request/response example matches its schema; at least one per operation (binary download excepted)", () => {
      expect(existsSync(FILE), "contracts/openapi/analytics.yaml missing").toBe(true);
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
      expect(n).toBeGreaterThanOrEqual(TOTAL - 1);
    });
    it("every operation has a 2xx response with a servable example Prism can serve", () => {
      expect(Object.keys(ops).length).toBe(TOTAL);
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
    it("examples are synthetic: no e-mail, no Nepali-mobile-shaped number, no Windows/user paths, no live-looking token or IP", () => {
      expect(existsSync(FILE), "contracts/openapi/analytics.yaml missing").toBe(true);
      const vals = exampleValues();
      expect(vals.length, "no examples at all").toBeGreaterThan(0);
      const blob = JSON.stringify(vals);
      expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
      expect(blob).not.toMatch(/(?<!\d)(?:\+?977[-\s]?)?9[678]\d{8}(?!\d)/);
      expect(blob).not.toMatch(/[A-Z]:\\\\|\/Users\/|\/home\//);
      for (const ip of blob.match(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g) ?? [])
        expect(ip, `non-documentation IP ${ip}`).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
    });
  });
});
