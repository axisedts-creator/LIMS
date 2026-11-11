// T0C-10.C10 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/micro.yaml (C10 transcription of spec/chunks/C10-microbiology/02-TRD.md §5, §5.1–5.6; LD-103).
// Checks: (1) exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) clean for micro.yaml; (3) AC-0C-1.5 negatives on a temp copy;
// (4) micro = TRD §5 tables (49 ops M1–M49), method+path under /v1/micro, x-permission (one code), security bearerJwt, x-idempotency, tier general,
//     success status, specific + common error codes, Idempotency-Key on R rows, If-Match on the §5 intro list;
// (5) shape pins from §5.1–5.6 (query params, enums, bounds, coded sets without enum, DTO allowlists, multipart M42, CSV M49, no tenant_id / server-authority fields);
// (6) "Prism smoke" offline: examples validate (ajv), every op has a servable 2xx example, examples synthetic; (7) package.json `mock:micro` script.
// Not testable here: Prism actually serving the file (prism not installed), generated-client freshness (codegen-fresh suite), runtime mappers (REQ-SEC-081), display-name resolution.
// Assumptions (TRD silent or ambiguous; each is also in the notes file):
//  - every op lists the six common codes (TRD §5 intro); IDEM codes (3) on R rows; common.version_conflict + common.precondition_required on the If-Match rows (§5 intro list);
//    precondition_required is absent on every op without If-Match; version_conflict is absent on M4 M6 M7 M14 (§5 intro: creates under a culture serialise via FOR UPDATE);
//    M12 per-entry codes (ast_value_invalid, ast_category_not_allowed, antibiotic_not_in_panel, version_conflict) are NOT pinned in x-error-codes (they travel in the 200 body); only the whole-request code is;
//  - M3 and M31 pin common.version_conflict (If-Match rows); M31 does not pin micro.code_duplicate (TRD names it for M26/M27/M30/M34 only);
//  - auth.mfa_required pinned on M14 M42 M46 M47 (TRD names it); other micro.breakpoint.manage (privileged) ops are unpinned either way;
//  - success status pinned only where the TRD gives one (GET 200; 201 on M14 M26 M30 M34 M42); other ops: "some 2xx";
//  - M23 `set_name` path enum = the 11 TRD names; M24 `set_name` is only a required string (TRD forbids ast_interpretations at runtime via 403, not in the schema);
//  - page.total (M1, include_total) is an optional integer on the page object; DTOs of §5.6 pinned by field allowlist; Plating/AstPanel/VocabMap/MicroSettings DTOs
//    ("all columns") pinned only by the fields the request tables name (+ id/version for the first three);
//  - M42 `x-upload` = [text/csv]; the 5 MiB cap (5,242,880) must be stated somewhere in the operation; M49 is text/csv with Content-Disposition + Cache-Control: no-store headers;
//  - no operation is public: no x-public anywhere, security [{bearerJwt: []}] on all.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRD = join(ROOT, "spec/chunks/C10-microbiology/02-TRD.md");
const FILE = join(ROOT, "contracts/openapi/micro.yaml");
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const METHODS = ["get", "put", "post", "delete", "patch"];
const name = "micro";
const PFX = "/v1/micro";

const CR = "micro.culture.read", CW = "micro.culture.work", CM = "micro.config.manage", BM = "micro.breakpoint.manage";
const VC = "common.version_conflict", PRE = "common.precondition_required", CUR = "common.invalid_cursor", MFA = "auth.mfa_required";
const IDEM = ["common.idempotency_key_required", "common.idempotency_key_reused", "common.idempotency_in_progress"];
const SIX = ["common.validation_failed", "common.not_found", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"];
const CIT = "micro.culture_invalid_transition", IIT = "micro.isolate_invalid_transition", RFL = "micro.report_final_locked", OCU = "micro.organism_code_unknown";
const RI = "micro.report_incomplete", ASR = "micro.ast_standard_required", ARR = "micro.amendment_reason_required";
const IRC = "micro.instrument_record_conflict", CD = "micro.code_duplicate";
const BII = "micro.breakpoint_import_invalid", BSIT = "micro.breakpoint_set_invalid_transition", BFE = "micro.breakpoint_four_eyes_required";
const LAB = ["lab.result_locked", "lab.result_invalid_transition", "lab.module_result_invalid", "lab.module_result_stale", "lab.amendment_reason_required"];
const PTL = "common.payload_too_large", UMT = "common.unsupported_media_type";

type Spec = { n: number; id: string; method: string; path: string; perm: string; idem: "none" | "optional" | "required"; status: number[]; err: string[]; im: boolean; paged?: boolean };
const N = "none" as const, O = "optional" as const, R = "required" as const;
const S = (n: number, id: string, method: string, path: string, perm: string, idem: Spec["idem"], status: number[], err: string[], o: Partial<Spec> = {}): Spec =>
  ({ n, id, method, path, perm, idem, status, err, im: false, ...o });
const IM = { im: true }, L = { paged: true };

const SPECS: Spec[] = [
  S(1, "listCultures", "GET", "/cultures", CR, N, [200], [CUR], L),
  S(2, "getCulture", "GET", "/cultures/{culture_id}", CR, N, [200], []),
  S(3, "setupCulture", "POST", "/cultures/{culture_id}/setup", CW, R, [], [CIT, VC, ...IDEM], IM),
  S(4, "addCulturePlate", "POST", "/cultures/{culture_id}/plates", CW, R, [], [RFL, CIT, ...IDEM]),
  S(5, "discardCulturePlate", "POST", "/cultures/{culture_id}/plates/{plate_id}/discard", CW, O, [], [RFL, CIT, VC], IM),
  S(6, "recordCultureObservation", "POST", "/cultures/{culture_id}/observations", CW, R, [], [RFL, CIT, ...IDEM]),
  S(7, "createIsolate", "POST", "/cultures/{culture_id}/isolates", CW, R, [], [OCU, RFL, CIT, ...IDEM]),
  S(8, "identifyIsolate", "POST", "/isolates/{isolate_id}/identify", CW, O, [], [OCU, IIT, RFL, VC], IM),
  S(9, "describeIsolate", "POST", "/isolates/{isolate_id}/describe", CW, O, [], [OCU, IIT, RFL, VC], IM),
  S(10, "withdrawIsolate", "POST", "/isolates/{isolate_id}/withdraw", CW, O, [], [IIT, RFL, VC], IM),
  S(11, "assignAstPanel", "POST", "/isolates/{isolate_id}/ast-panel", CW, R, [], [IIT, RFL, VC, ...IDEM], IM),
  S(12, "recordAstResults", "POST", "/isolates/{isolate_id}/ast-results/bulk-record", CW, R, [], [RFL, ...IDEM]),
  S(13, "previewAstInterpretation", "POST", "/isolates/{isolate_id}/ast-results/interpret", CW, N, [], []),
  S(14, "submitCultureReport", "POST", "/cultures/{culture_id}/report-versions", CW, R, [201], [RI, ASR, CIT, ARR, ...LAB, MFA, ...IDEM]),
  S(15, "listCultureReportVersions", "GET", "/cultures/{culture_id}/report-versions", CR, N, [200], []),
  S(16, "getCultureReportVersion", "GET", "/cultures/{culture_id}/report-versions/{version_no}", CR, N, [200], []),
  S(17, "reopenCulture", "POST", "/cultures/{culture_id}/reopen", CW, O, [], [ARR, CIT, VC], IM),
  S(18, "cancelCulture", "POST", "/cultures/{culture_id}/cancel", CW, O, [], [CIT, VC], IM),
  S(19, "listMicroInstrumentRecords", "GET", "/instrument-records", CR, N, [200], [CUR], L),
  S(20, "assignMicroInstrumentRecord", "POST", "/instrument-records/{record_id}/assign", CW, R, [], [IRC, RFL, VC, ...IDEM], IM),
  S(21, "applyMicroInstrumentRecord", "POST", "/instrument-records/{record_id}/apply", CW, R, [], [IRC, RFL, VC, ...IDEM], IM),
  S(22, "ignoreMicroInstrumentRecord", "POST", "/instrument-records/{record_id}/ignore", CW, O, [], [IRC, VC], IM),
  S(23, "listMicroCodedSet", "GET", "/coded-sets/{set_name}", CR, N, [200], []),
  S(24, "upsertMicroCode", "PUT", "/coded-sets/{set_name}/codes/{code}", CM, O, [], [VC], IM),
  S(25, "listPlatingProtocols", "GET", "/plating-protocols", CR, N, [200], []),
  S(26, "createPlatingProtocol", "POST", "/plating-protocols", CM, R, [201], [CD, ...IDEM]),
  S(27, "versionPlatingProtocol", "POST", "/plating-protocols/{protocol_id}/versions", CM, R, [], [CD, VC, ...IDEM], IM),
  S(28, "deactivatePlatingProtocol", "POST", "/plating-protocols/{protocol_id}/deactivate", CM, O, [], [VC], IM),
  S(29, "listAstPanels", "GET", "/ast-panels", CR, N, [200], []),
  S(30, "createAstPanel", "POST", "/ast-panels", CM, R, [201], [CD, ...IDEM]),
  S(31, "versionAstPanel", "POST", "/ast-panels/{panel_id}/versions", CM, R, [], [VC, ...IDEM], IM),
  S(32, "deactivateAstPanel", "POST", "/ast-panels/{panel_id}/deactivate", CM, O, [], [VC], IM),
  S(33, "listInstrumentVocabMaps", "GET", "/instrument-vocab-maps", CR, N, [200], [CUR], L),
  S(34, "createInstrumentVocabMap", "POST", "/instrument-vocab-maps", CM, R, [201], [CD, ...IDEM]),
  S(35, "updateInstrumentVocabMap", "PUT", "/instrument-vocab-maps/{map_id}", CM, O, [], [VC], IM),
  S(36, "deactivateInstrumentVocabMap", "POST", "/instrument-vocab-maps/{map_id}/deactivate", CM, O, [], [VC], IM),
  S(37, "listInstrumentAstDefaults", "GET", "/instrument-ast-defaults", CR, N, [200], []),
  S(38, "putInstrumentAstDefault", "PUT", "/instrument-ast-defaults/{instrument_id}", CM, O, [], [VC], IM),
  S(39, "getMicroSettings", "GET", "/settings", CR, N, [200], []),
  S(40, "updateMicroSettings", "PUT", "/settings", CM, O, [], [VC], IM),
  S(41, "listBreakpointSets", "GET", "/breakpoint-sets", CR, N, [200], [CUR], L),
  S(42, "createBreakpointImport", "POST", "/breakpoint-sets", BM, R, [201], [BII, PTL, UMT, MFA, ...IDEM]),
  S(43, "getBreakpointSet", "GET", "/breakpoint-sets/{set_id}", CR, N, [200], []),
  S(44, "listBreakpointImportIssues", "GET", "/breakpoint-sets/{set_id}/issues", BM, N, [200], [CUR], L),
  S(45, "listBreakpointRows", "GET", "/breakpoint-sets/{set_id}/rows", BM, N, [200], [CUR], L),
  S(46, "activateBreakpointSet", "POST", "/breakpoint-sets/{set_id}/activate", BM, O, [], [BSIT, BFE, MFA, VC], IM),
  S(47, "retireBreakpointSet", "POST", "/breakpoint-sets/{set_id}/retire", BM, O, [], [BSIT, MFA, VC], IM),
  S(48, "discardBreakpointSet", "POST", "/breakpoint-sets/{set_id}/discard", BM, O, [], [BSIT, VC], IM),
  S(49, "downloadBreakpointTemplate", "GET", "/breakpoint-import-template", BM, N, [200], []),
];
const TOTAL = 49;
// TRD §5 intro: creates under a culture lock the culture row FOR UPDATE instead of If-Match, so no version_conflict
const NO_VC = ["addCulturePlate", "recordCultureObservation", "createIsolate", "submitCultureReport"];

const DTOS = ["CultureSummaryDto", "CultureDetailDto", "PlateDto", "ObservationDto", "IsolateDto", "AstResultDto", "ReportVersionSummaryDto", "ReportVersionDto", "InstrumentRecordDto",
  "BreakpointSetDto", "PlatingProtocolDto", "AstPanelDto", "VocabMapDto", "MicroSettingsDto"];
const LIST_PAGED: Record<string, string> = { listCultures: "CultureSummaryDto", listMicroInstrumentRecords: "InstrumentRecordDto", listInstrumentVocabMaps: "VocabMapDto", listBreakpointSets: "BreakpointSetDto" };
const LIST_DATA: Record<string, string> = { listCultureReportVersions: "ReportVersionSummaryDto", listPlatingProtocols: "PlatingProtocolDto", listAstPanels: "AstPanelDto" };
const ONE: Record<string, string> = { getCulture: "CultureDetailDto", setupCulture: "CultureDetailDto", reopenCulture: "CultureDetailDto", cancelCulture: "CultureSummaryDto",
  addCulturePlate: "PlateDto", discardCulturePlate: "PlateDto", createIsolate: "IsolateDto", identifyIsolate: "IsolateDto", describeIsolate: "IsolateDto", withdrawIsolate: "IsolateDto",
  assignAstPanel: "IsolateDto", submitCultureReport: "ReportVersionDto", getCultureReportVersion: "ReportVersionDto",
  assignMicroInstrumentRecord: "InstrumentRecordDto", applyMicroInstrumentRecord: "InstrumentRecordDto", ignoreMicroInstrumentRecord: "InstrumentRecordDto",
  createPlatingProtocol: "PlatingProtocolDto", versionPlatingProtocol: "PlatingProtocolDto", deactivatePlatingProtocol: "PlatingProtocolDto",
  createAstPanel: "AstPanelDto", versionAstPanel: "AstPanelDto", deactivateAstPanel: "AstPanelDto",
  createInstrumentVocabMap: "VocabMapDto", updateInstrumentVocabMap: "VocabMapDto", deactivateInstrumentVocabMap: "VocabMapDto",
  getMicroSettings: "MicroSettingsDto", updateMicroSettings: "MicroSettingsDto",
  getBreakpointSet: "BreakpointSetDto", createBreakpointImport: "BreakpointSetDto", activateBreakpointSet: "BreakpointSetDto", retireBreakpointSet: "BreakpointSetDto", discardBreakpointSet: "BreakpointSetDto" };
const PHI_PARAMS = ["barcode", "sample_barcode", "registration_no", "patient_id", "patient_name", "patient_display_name", "phone", "phone_e164", "email", "full_name", "name"];
// never in any schema of this file (§5.6: every DTO omits tenant_id/created_by/updated_by)
const FORBIDDEN_ANY = ["tenant_id", "created_by", "updated_by"];
const SETS = ["organisms", "organism_groups", "antibiotics", "media", "specimen_sites", "growth_codes", "culture_outcomes", "isolate_withdraw_reasons", "culture_cancel_reasons", "record_ignore_reasons", "ast_interpretations"];

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("micro.yaml (T0C-10.C10)", () => {
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
  const bodySchema = (id: string) => deref(ops[id]?.op.requestBody?.content?.["application/json"]?.schema);
  const bp = (id: string, f: string) => deref(props(bodySchema(id))[f]);
  const params = (id: string) => (ops[id]?.op.parameters ?? []).map(deref);
  const param = (id: string, pname: string) => params(id).find((q: any) => q?.name === pname);
  const pschema = (id: string, pname: string) => deref(param(id, pname)?.schema);
  const okResp = (id: string, code?: string) => {
    const [, r] = Object.entries<any>(ops[id].op.responses).find(([c]) => (code ? c === code : /^2/.test(c)))!;
    return deref(r);
  };
  const okSchema = (id: string, code?: string) => deref(okResp(id, code).content?.["application/json"]?.schema);
  const has = (id: string) => expect(ops[id], `${id} missing`).toBeDefined();
  const ex = () => expect(existsSync(FILE), "contracts/openapi/micro.yaml missing").toBe(true);
  const T = (title: string, fn: () => void) => it(title, () => { ex(); fn(); });
  const coded = (s: any, set: string) => {
    expect(s?.["x-coded-set"], "x-coded-set").toBe(set);
    expect(s.enum, "coded-set field must not declare enum").toBeUndefined();
  };
  const item = (s: any) => deref(deref(s).items);
  const sorted = (s: any) => keys(s).sort();
  const walk = (s: any, fn: (n: any) => void, seen = new Set<any>()) => {
    const n = deref(s);
    if (!n || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    fn(n);
    for (const a of [...(n.allOf ?? []), ...(n.oneOf ?? []), ...(n.anyOf ?? [])]) walk(a, fn, seen);
    for (const q of Object.values(n.properties ?? {})) walk(q, fn, seen);
    if (n.items) walk(n.items, fn, seen);
  };
  const int = (s: any, min: number, max: number) => expect([s?.type, s?.minimum, s?.maximum]).toEqual(["integer", min, max]);
  const str = (s: any, min: number | undefined, max: number) => expect([s?.type, s?.minLength, s?.maxLength]).toEqual(["string", min, max]);
  const names = (id: string) => params(id).filter((q: any) => q?.in === "query").map((q: any) => q.name);
  // every key in `want` is a property; every key in `optional` is not required
  const shape = (s: any, want: string[], optional: string[], label: string) => {
    expect(keys(s), label).toEqual(expect.arrayContaining(want));
    for (const f of optional) { expect(keys(s), `${label}.${f}`).toContain(f); expect(reqd(s), `${label}.${f}`).not.toContain(f); }
  };

  describe("exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
    it("file exists", () => expect(existsSync(FILE), "contracts/openapi/micro.yaml missing").toBe(true));
    it("first non-comment line is `openapi: 3.0.3`", () => {
      const first = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#"));
      expect(first?.trim()).toBe("openapi: 3.0.3");
    });
    it("info.title and version present; no `nullable: true` (no null on the wire, CV §4.2)", () => {
      expect(typeof doc.info?.title).toBe("string");
      expect(typeof doc.info?.version).toBe("string");
      expect(text.length, "empty").toBeGreaterThan(0);
      expect(text).not.toMatch(/nullable:\s*true/);
    });
    it("the LD-103 decision is cited in a comment", () => expect(text).toMatch(/LD-103/));
  });

  describe("repo spec lint is green (AC-0C-1.4, rules 1–8)", () => {
    it("lintRepo reports no violation", async () => {
      ex();
      const v = (await lintRepo(ROOT)).filter((x) => x.file === name);
      expect(v, v.map((x) => `[rule ${x.rule}] ${x.message}`).join("\n")).toEqual([]);
    });
  });

  describe("lint actually checks this file (AC-0C-1.5 negative)", () => {
    const mutate = async (fn: (d: any) => void) => {
      ex();
      const dir = mkdtempSync(join(tmpdir(), "c10-micro-lint-"));
      tmps.push(dir);
      cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
      const d = parse(readFileSync(FILE, "utf8"));
      fn(d);
      writeFileSync(join(dir, "contracts/openapi/micro.yaml"), stringify(d, { aliasDuplicateObjects: false }));
      return (await lintRepo(dir)).filter((x) => x.file === name);
    };
    const firstOp = (d: any, pred: (o: any) => boolean) =>
      Object.values<any>(d.paths).flatMap((q) => METHODS.map((m) => q[m]).filter(Boolean)).find(pred);

    it("x-permission not in permissions.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = "micro.no_such.permission"; });
      expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
    });
    it("x-error-codes entry not in errors.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push("micro.no_such_error"); });
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
    it("a coded-set field that also declares enum fails (rule 6)", async () => {
      const v = await mutate((d) => {
        const s = Object.values<any>(d.components?.schemas ?? {}).flatMap((x: any) => Object.values<any>(x?.properties ?? {})).find((x) => "x-coded-set" in x)
          ?? Object.values<any>(d.paths).flatMap((q) => METHODS.map((m) => q[m]?.requestBody?.content?.["application/json"]?.schema).filter(Boolean))
            .flatMap((b: any) => Object.values<any>(b.properties ?? {})).find((x) => x && "x-coded-set" in x);
        s.enum = ["a"];
      });
      expect(v.some((x) => x.rule === "6")).toBe(true);
    });
    it("a request body naming a server-authority field fails (rule 7)", async () => {
      const v = await mutate((d) => {
        const op = firstOp(d, (o) => o.requestBody?.content?.["application/json"]?.schema?.properties);
        op.requestBody.content["application/json"].schema.properties.tenant_id = { type: "string", maxLength: 36 };
      });
      expect(v.some((x) => x.rule === "7")).toBe(true);
    });
  });

  describe("micro equals 02-TRD §5 (no missing, no extra operations)", () => {
    it(`${TOTAL} operations; table ids unique; file has exactly these`, () => {
      expect(SPECS.length).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.id)).size).toBe(TOTAL);
      expect(Object.keys(ops).sort()).toEqual(SPECS.map((s) => s.id).sort());
    });
    it("TRD drift guard: §5.1–5.5 tables = test table (operationId, method + path, permission, Idem)", () => {
      const all = readFileSync(TRD, "utf8").split("\n");
      const start = all.findIndex((l) => l.startsWith("## 5. HTTP endpoints"));
      const end = all.findIndex((l, k) => k > start && l.startsWith("### 5.6 "));
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const rows = new Map<number, { id: string; mp: string; perm: string; idem: string }>();
      for (const l of all.slice(start, end)) {
        const c = l.split("|");
        const m = /^\s*M(\d+)\s*$/.exec(c[1] ?? "");
        if (!m) continue;
        const id = /^\s*`([a-z][A-Za-z0-9]+)`/.exec(c[3] ?? "")?.[1];
        const mp = /^\s*([A-Z]+)\s+`([^`]+)`/.exec(c[2] ?? "");
        const perm = /`(micro\.[a-z_.]+)`/.exec(c[4] ?? "")?.[1];
        const last = (c[c.length - 1].trim() === "" ? c[c.length - 2] : c[c.length - 1]).replace(/\*/g, "").trim();
        const idem = /^R\b/.test(last) ? "R" : /^O\b/.test(last) ? "O" : /^(—|–|-|none)/.test(last) ? "-" : last;
        rows.set(Number(m[1]), { id: id ?? "", mp: `${mp?.[1]} ${mp?.[2]}`, perm: perm ?? "", idem });
      }
      expect(rows.size, "rows parsed from TRD").toBe(TOTAL);
      for (const s of SPECS) {
        const r = rows.get(s.n);
        expect(r?.id, `M${s.n} id`).toBe(s.id);
        expect(r?.mp, `M${s.n} method+path`).toBe(`${s.method} ${s.path}`);
        // M43 says "as M41" (no own code): same permission as M41
        expect(r?.perm || rows.get(41)?.perm, `M${s.n} permission`).toBe(s.perm);
        expect(r?.idem, `M${s.n} idem`).toBe({ none: "-", optional: "O", required: "R" }[s.idem]);
      }
    });
    T("every path is /v1/micro/… with tags [micro]; no PHI path or query params (REQ-SEC-098)", () => {
      expect(Object.keys(doc.paths ?? {}).length, "no paths").toBeGreaterThan(0);
      for (const [q, it_] of Object.entries<any>(doc.paths ?? {})) {
        expect(q.startsWith(`${PFX}/`), q).toBe(true);
        expect(q).not.toMatch(/\{(registration_no|barcode|sample_barcode|phone|patient_id|email)\}/);
        for (const m of METHODS) if (it_[m]) expect(it_[m].tags, `${m} ${q}`).toEqual([name]);
      }
      for (const id of Object.keys(ops))
        for (const q of params(id)) if (q?.in === "query") expect(PHI_PARAMS, `${id}?${q.name}`).not.toContain(q.name);
    });
  });

  describe.each(SPECS)("M$n $id", (r) => {
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
    it(`x-permission = ${r.perm} (one code), never x-public; security bearerJwt; tenant context only`, () => {
      has(r.id);
      expect(o["x-permission"]).toBe(r.perm);
      expect(o["x-public"]).toBeUndefined();
      expect(o.security).toEqual([{ bearerJwt: [] }]);
      expect([undefined, "tenant"]).toContain(o["x-context"]);
    });
    it("success response status", () => {
      has(r.id);
      const codes = Object.keys(o.responses ?? {});
      for (const c of r.status) expect(codes, `want ${c}`).toContain(String(c));
      expect(codes.some((c) => /^2/.test(c)), "some 2xx").toBe(true);
    });
    it("lists the TRD specific error codes plus the six common codes", () => {
      has(r.id);
      for (const c of [...SIX, ...r.err]) expect(o["x-error-codes"], c).toContain(c);
      if (!r.im) expect(o["x-error-codes"], "no If-Match on this op").not.toContain(PRE);
      else expect(o["x-error-codes"], "If-Match op").toContain(PRE);
      if (NO_VC.includes(r.id)) expect(o["x-error-codes"], "creates under a culture serialise via FOR UPDATE (§5 intro)").not.toContain(VC);
    });
    it("Idempotency-Key header where x-idempotency required, none where none; If-Match on the §5 intro list only", () => {
      has(r.id);
      const ps = JSON.stringify(o.parameters ?? []);
      if (r.idem === "required") expect(ps).toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.idem === "none") expect(ps).not.toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.im) expect(ps).toMatch(/IfMatch|If-Match/);
      else expect(ps).not.toMatch(/IfMatch|If-Match/);
    });
    if (r.paged)
      it("takes cursor + limit (max 200, default 50)", () => {
        has(r.id);
        const ps = JSON.stringify(o.parameters ?? []);
        expect(ps).toMatch(/cursor|Cursor/);
        expect(ps).toMatch(/limit|Limit/);
        const lim = pschema(r.id, "limit");
        expect([lim?.maximum, lim?.default]).toEqual([200, 50]);
      });
  });

  describe("query and path parameters (TRD §5.1–5.5)", () => {
    T("list query parameter names", () => {
      expect(names("listCultures")).toEqual(expect.arrayContaining(["status", "specimen_id", "order_id", "centre_id", "received_at_from", "received_at_to", "read_overdue",
        "has_open_instrument_records", "updated_at_from", "include_total", "sort", "cursor", "limit"]));
      expect(names("listMicroInstrumentRecords")).toEqual(expect.arrayContaining(["match_status", "culture_id", "instrument_id", "received_at_from", "received_at_to", "sort", "cursor", "limit"]));
      expect(names("listMicroCodedSet")).toEqual(["include_inactive", "q"]);
      expect(names("listPlatingProtocols")).toEqual(expect.arrayContaining(["include_superseded", "is_active"]));
      expect(names("listAstPanels")).toEqual(expect.arrayContaining(["include_superseded", "organism_code", "organism_group_code"]));
      expect(names("listInstrumentVocabMaps")).toEqual(expect.arrayContaining(["instrument_id", "kind", "is_active", "cursor", "limit"]));
      expect(names("listBreakpointSets")).toEqual(expect.arrayContaining(["standard", "status", "cursor", "limit"]));
      expect(names("listBreakpointImportIssues")).toEqual(expect.arrayContaining(["severity", "cursor", "limit"]));
      expect(names("listBreakpointRows")).toEqual(expect.arrayContaining(["antibiotic_code", "organism_code", "cursor", "limit"]));
    });
    T("sort enums are exactly the TRD lists", () => {
      expect(pschema("listCultures", "sort").enum).toEqual(["received_at", "-received_at", "next_read_due_at", "-updated_at"]);
      expect(pschema("listMicroInstrumentRecords", "sort").enum).toEqual(["-received_at", "received_at"]);
    });
    T("M1 typed filters: bools, uuids, date-times; none required", () => {
      for (const f of ["read_overdue", "has_open_instrument_records", "include_total"]) expect(pschema("listCultures", f).type, f).toBe("boolean");
      for (const f of ["specimen_id", "order_id", "centre_id"]) expect(pschema("listCultures", f).format, f).toBe("uuid");
      for (const f of ["received_at_from", "received_at_to", "updated_at_from"]) expect(pschema("listCultures", f).format, f).toBe("date-time");
      for (const f of ["status", "specimen_id", "order_id", "centre_id", "read_overdue", "include_total"]) expect(param("listCultures", f).required, f).not.toBe(true);
    });
    T("M23 set_name path enum = the 11 TRD sets; include_inactive boolean; q prefix ≤ 40", () => {
      expect(param("listMicroCodedSet", "set_name").in).toBe("path");
      expect(pschema("listMicroCodedSet", "set_name").enum).toEqual(SETS);
      expect(pschema("listMicroCodedSet", "include_inactive").type).toBe("boolean");
      expect(pschema("listMicroCodedSet", "q").maxLength).toBe(40);
    });
    T("M16 version_no is an integer ≥ 1; M24 has set_name + code path params", () => {
      expect(pschema("getCultureReportVersion", "version_no")).toMatchObject({ type: "integer", minimum: 1 });
      for (const f of ["set_name", "code"]) expect(param("upsertMicroCode", f)?.in, f).toBe("path");
    });
    T("path ids are required uuids", () => {
      for (const [id, f] of [["getCulture", "culture_id"], ["discardCulturePlate", "plate_id"], ["identifyIsolate", "isolate_id"], ["assignMicroInstrumentRecord", "record_id"],
        ["versionPlatingProtocol", "protocol_id"], ["versionAstPanel", "panel_id"], ["updateInstrumentVocabMap", "map_id"], ["putInstrumentAstDefault", "instrument_id"],
        ["getBreakpointSet", "set_id"]] as const) {
        expect(param(id, f)?.in, `${id}:${f}`).toBe("path");
        expect(pschema(id, f)?.format, `${id}:${f}`).toBe("uuid");
      }
    });
    T("every path parameter is required", () => {
      for (const id of Object.keys(ops)) for (const q of params(id).filter((x: any) => x?.in === "path")) expect(q.required, `${id}:${q.name}`).toBe(true);
    });
  });

  describe("request bodies (TRD §5.1–5.5)", () => {
    T("M3 setup: protocol uuid, plates 1..12 {media_code required, incubation_text ≤120}; nothing required", () => {
      const s = "setupCulture";
      expect(bp(s, "plating_protocol_id").format).toBe("uuid");
      expect(bp(s, "planted_at").format).toBe("date-time");
      expect(bp(s, "specimen_site_code")).toBeDefined();
      const pl = bp(s, "plates");
      expect([pl.minItems, pl.maxItems]).toEqual([1, 12]);
      expect(reqd(item(pl))).toEqual(["media_code"]);
      expect(props(item(pl)).incubation_text.maxLength).toBe(120);
      expect(reqd(bodySchema(s))).toEqual([]);
    });
    T("M4 plate: media_code required; incubation_text, parent_plate_id, source_isolate_id, planted_at optional", () => {
      const s = "addCulturePlate";
      expect(reqd(bodySchema(s))).toEqual(["media_code"]);
      for (const f of ["incubation_text", "parent_plate_id", "source_isolate_id", "planted_at"]) expect(keys(bodySchema(s)), f).toContain(f);
      for (const f of ["parent_plate_id", "source_isolate_id"]) expect(bp(s, f).format, f).toBe("uuid");
    });
    T("M5 discard / M28 / M32 / M36 / M47 / M48 take no required body fields (`{}`)", () => {
      for (const id of ["discardCulturePlate", "deactivatePlatingProtocol", "deactivateAstPanel", "deactivateInstrumentVocabMap", "retireBreakpointSet", "discardBreakpointSet"]) {
        const b = bodySchema(id);
        if (b) expect(reqd(b), id).toEqual([]);
      }
    });
    T("M6 observation: kind enum required; quantity_text ≤80, finding_text 1..2000; uuids", () => {
      const s = "recordCultureObservation";
      expect(bp(s, "kind").enum).toEqual(["plate_read", "gram_stain", "microscopy", "other"]);
      expect(reqd(bodySchema(s))).toEqual(["kind"]);
      expect(bp(s, "quantity_text").maxLength).toBe(80);
      str(bp(s, "finding_text"), 1, 2000);
      expect(bp(s, "observed_at").format).toBe("date-time");
      for (const f of ["plate_id", "corrects_observation_id"]) expect(bp(s, f).format, f).toBe("uuid");
      expect(keys(bodySchema(s))).toContain("growth_code");
    });
    T("M7 isolate: colony_description ≤500, quantity_text ≤80, plate_id uuid, organism_code; nothing required", () => {
      const s = "createIsolate";
      expect(bp(s, "colony_description").maxLength).toBe(500);
      expect(bp(s, "quantity_text").maxLength).toBe(80);
      expect(bp(s, "plate_id").format).toBe("uuid");
      expect(keys(bodySchema(s))).toContain("organism_code");
      expect(reqd(bodySchema(s))).toEqual([]);
    });
    T("M8 identify: organism_code required; M9 describe: is_reportable required, ≤500 / ≤80", () => {
      expect(reqd(bodySchema("identifyIsolate"))).toEqual(["organism_code"]);
      const s = "describeIsolate";
      expect(bp(s, "colony_description").maxLength).toBe(500);
      expect(bp(s, "quantity_text").maxLength).toBe(80);
      expect(bp(s, "is_reportable").type).toBe("boolean");
      expect(bp(s, "plate_id").format).toBe("uuid");
      expect(reqd(bodySchema(s))).toEqual(["is_reportable"]);
    });
    T("M10 withdraw: reason_code coded-set micro.isolate_withdraw_reasons (no enum), comment ≤500; reason_code required", () => {
      coded(bp("withdrawIsolate", "reason_code"), "micro.isolate_withdraw_reasons");
      expect(bp("withdrawIsolate", "comment").maxLength).toBe(500);
      expect(reqd(bodySchema("withdrawIsolate"))).toEqual(["reason_code"]);
    });
    T("M11 ast-panel: ast_panel_id uuid, method enum mic|zone_diameter|other; nothing required", () => {
      expect(bp("assignAstPanel", "ast_panel_id").format).toBe("uuid");
      expect(bp("assignAstPanel", "method").enum).toEqual(["mic", "zone_diameter", "other"]);
      expect(reqd(bodySchema("assignAstPanel"))).toEqual([]);
    });
    T("M12 bulk-record: entries 1..60; entry fields, bounds, enums; antibiotic_code + method required", () => {
      const s = "recordAstResults";
      const e = bp(s, "entries");
      expect([e.minItems, e.maxItems]).toEqual([1, 60]);
      expect(reqd(bodySchema(s))).toEqual(["entries"]);
      const i = item(e);
      expect(sorted(i)).toEqual(["accept_suggestion", "add_to_isolate", "antibiotic_code", "breakpoint_band_id", "category_code", "is_reportable", "method", "qualifier_code", "raw_value",
        "standard", "standard_version", "version"]);
      expect([...reqd(i)].sort()).toEqual(["antibiotic_code", "method"]);
      str(deref(props(i).raw_value), 1, 32);
      expect(deref(props(i).category_code).maxLength).toBe(8);
      expect(deref(props(i).standard).enum).toEqual(["CLSI", "EUCAST", "ECOFF"]);
      str(deref(props(i).standard_version), 1, 32);
      for (const f of ["accept_suggestion", "is_reportable", "add_to_isolate"]) expect(deref(props(i)[f]).type, f).toBe("boolean");
      expect(deref(props(i).breakpoint_band_id).format).toBe("uuid");
      expect(deref(props(i).version).type).toBe("integer");
    });
    T("M13 interpret: entries 1..60 {antibiotic_code, method, raw_value required; qualifier_code optional}", () => {
      const e = bp("previewAstInterpretation", "entries");
      expect([e.minItems, e.maxItems]).toEqual([1, 60]);
      expect(sorted(item(e))).toEqual(["antibiotic_code", "method", "qualifier_code", "raw_value"]);
      expect([...reqd(item(e))].sort()).toEqual(["antibiotic_code", "method", "raw_value"]);
      expect(reqd(bodySchema("previewAstInterpretation"))).toEqual(["entries"]);
    });
    T("M14 report: phase enum, text bounds, is_critical; report_phase + is_critical required", () => {
      const s = "submitCultureReport";
      expect(bp(s, "report_phase").enum).toEqual(["preliminary", "final"]);
      str(bp(s, "culture_summary_text"), 1, 4000);
      expect(bp(s, "comments_text").maxLength).toBe(4000);
      expect(bp(s, "is_critical").type).toBe("boolean");
      str(bp(s, "early_final_reason"), 1, 500);
      expect(keys(bodySchema(s))).toContain("outcome_code");
      expect([...reqd(bodySchema(s))].sort()).toEqual(["is_critical", "report_phase"]);
    });
    T("M17 reopen: amendment_reason_code coded-set lab.amendment_reasons (no enum), text ≤500; code required", () => {
      coded(bp("reopenCulture", "amendment_reason_code"), "lab.amendment_reasons");
      expect(bp("reopenCulture", "amendment_reason_text").maxLength).toBe(500);
      expect(reqd(bodySchema("reopenCulture"))).toEqual(["amendment_reason_code"]);
    });
    T("M18 cancel: reason_code coded-set micro.culture_cancel_reasons (no enum), comment ≤500; reason_code required", () => {
      coded(bp("cancelCulture", "reason_code"), "micro.culture_cancel_reasons");
      expect(bp("cancelCulture", "comment").maxLength).toBe(500);
      expect(reqd(bodySchema("cancelCulture"))).toEqual(["reason_code"]);
    });
    T("M20 assign: culture_id uuid required, isolate_seq 1..99, resolution enum; M21 apply: resolution only", () => {
      const s = "assignMicroInstrumentRecord";
      expect(bp(s, "culture_id").format).toBe("uuid");
      int(bp(s, "isolate_seq"), 1, 99);
      expect(bp(s, "resolution").enum).toEqual(["use_instrument", "keep_existing"]);
      expect(reqd(bodySchema(s))).toEqual(["culture_id"]);
      expect(bp("applyMicroInstrumentRecord", "resolution").enum).toEqual(["use_instrument", "keep_existing"]);
      expect(reqd(bodySchema("applyMicroInstrumentRecord"))).toEqual([]);
    });
    T("M22 ignore: reason_code coded-set micro.record_ignore_reasons (no enum), comment ≤300; reason_code required", () => {
      coded(bp("ignoreMicroInstrumentRecord", "reason_code"), "micro.record_ignore_reasons");
      expect(bp("ignoreMicroInstrumentRecord", "comment").maxLength).toBe(300);
      expect(reqd(bodySchema("ignoreMicroInstrumentRecord"))).toEqual(["reason_code"]);
    });
    T("M24 upsert code: display 1..200, sort_order int, is_active boolean required", () => {
      const s = "upsertMicroCode";
      str(bp(s, "display"), 1, 200);
      expect(bp(s, "sort_order").type).toBe("integer");
      expect(bp(s, "is_active").type).toBe("boolean");
      expect(reqd(bodySchema(s))).toEqual(expect.arrayContaining(["display", "sort_order", "is_active"]));
    });
    T("M26 create protocol: bounds; seven required fields; media 1..12, applies_to ≤50, read_schedule_hours 1..10 of 1..720", () => {
      const s = "createPlatingProtocol";
      str(bp(s, "display"), 1, 120);
      const h = bp(s, "read_schedule_hours");
      expect([h.minItems, h.maxItems]).toEqual([1, 10]);
      int(deref(h.items), 1, 720);
      int(bp(s, "final_no_growth_hours"), 1, 720);
      expect(bp(s, "requires_gram_stain").type).toBe("boolean");
      const m = bp(s, "media");
      expect([m.minItems, m.maxItems]).toEqual([1, 12]);
      expect(reqd(item(m))).toEqual(["media_code"]);
      expect(bp(s, "applies_to").maxItems).toBe(50);
      expect(sorted(item(bp(s, "applies_to")))).toEqual(["specimen_type_code", "test_id"]);
      expect(reqd(item(bp(s, "applies_to")))).toEqual([]);
      expect(keys(bodySchema(s))).toContain("default_specimen_site_code");
      expect([...reqd(bodySchema(s))].sort()).toEqual(["applies_to", "code", "display", "final_no_growth_hours", "media", "read_schedule_hours", "requires_gram_stain"]);
    });
    T("M27 version protocol: as M26 minus `code`", () => {
      const s = "versionPlatingProtocol";
      expect(keys(bodySchema(s))).not.toContain("code");
      expect(sorted(bodySchema(s))).toEqual(sorted(bodySchema("createPlatingProtocol")).filter((k) => k !== "code"));
      expect([...reqd(bodySchema(s))].sort()).toEqual(["applies_to", "display", "final_no_growth_hours", "media", "read_schedule_hours", "requires_gram_stain"]);
    });
    T("M30 create AST panel: display 1..120, antibiotics 1..60 {antibiotic_code, is_reported_default required; method optional}; code/display/default_method/antibiotics required", () => {
      const s = "createAstPanel";
      str(bp(s, "display"), 1, 120);
      const a = bp(s, "antibiotics");
      expect([a.minItems, a.maxItems]).toEqual([1, 60]);
      expect(sorted(item(a))).toEqual(["antibiotic_code", "is_reported_default", "method"]);
      expect([...reqd(item(a))].sort()).toEqual(["antibiotic_code", "is_reported_default"]);
      for (const f of ["organism_code", "organism_group_code", "specimen_site_code"]) expect(keys(bodySchema(s)), f).toContain(f);
      expect([...reqd(bodySchema(s))].sort()).toEqual(["antibiotics", "code", "default_method", "display"]);
    });
    T("M31 version AST panel: as M30 minus `code`, display 1..120", () => {
      const s = "versionAstPanel";
      expect(keys(bodySchema(s))).not.toContain("code");
      expect(sorted(bodySchema(s))).toEqual(sorted(bodySchema("createAstPanel")).filter((k) => k !== "code"));
      str(bp(s, "display"), 1, 120);
    });
    T("M34 vocab map: kind enum, code_raw 1..64, instrument_id uuid, local_code; all four required; M35: local_code only", () => {
      const s = "createInstrumentVocabMap";
      expect(bp(s, "kind").enum).toEqual(["organism", "antibiotic"]);
      str(bp(s, "code_raw"), 1, 64);
      expect(bp(s, "instrument_id").format).toBe("uuid");
      expect([...reqd(bodySchema(s))].sort()).toEqual(["code_raw", "instrument_id", "kind", "local_code"]);
      expect(reqd(bodySchema("updateInstrumentVocabMap"))).toEqual(["local_code"]);
      expect(keys(bodySchema("updateInstrumentVocabMap"))).toEqual(["local_code"]);
    });
    T("M38 AST default: standard enum CLSI|EUCAST|ECOFF, standard_version 1..32, both required", () => {
      const s = "putInstrumentAstDefault";
      expect(bp(s, "standard").enum).toEqual(["CLSI", "EUCAST", "ECOFF"]);
      str(bp(s, "standard_version"), 1, 32);
      expect([...reqd(bodySchema(s))].sort()).toEqual(["standard", "standard_version"]);
    });
    T("M40 settings: manual_ast_standard CLSI|EUCAST, hours 1..720, recent_window_days 1..31, unset [manual_ast_standard]; five required", () => {
      const s = "updateMicroSettings";
      expect(bp(s, "manual_ast_standard").enum).toEqual(["CLSI", "EUCAST"]);
      for (const f of ["zone_suggestion_enabled", "mic_suggestion_enabled", "early_final_requires_reason"]) expect(bp(s, f).type, f).toBe("boolean");
      int(bp(s, "default_final_no_growth_hours"), 1, 720);
      int(bp(s, "recent_window_days"), 1, 31);
      expect(deref(bp(s, "unset").items).enum).toEqual(["manual_ast_standard"]);
      expect([...reqd(bodySchema(s))].sort()).toEqual(["default_final_no_growth_hours", "early_final_requires_reason", "mic_suggestion_enabled", "recent_window_days", "zone_suggestion_enabled"]);
    });
    T("M42 import: multipart/form-data {metadata (JSON object), file (binary)}; x-upload text/csv; 5 MiB cap stated; metadata bounds", () => {
      const o = ops.createBreakpointImport?.op;
      has("createBreakpointImport");
      expect(Object.keys(o.requestBody?.content ?? {})).toEqual(["multipart/form-data"]);
      expect(o["x-upload"]).toEqual(["text/csv"]);
      expect(JSON.stringify(o)).toMatch(/5242880|5,242,880|5 MiB/);
      const m = deref(o.requestBody.content["multipart/form-data"].schema);
      expect(m.additionalProperties).toBe(false);
      expect([...reqd(m)].sort()).toEqual(["file", "metadata"]);
      expect(deref(props(m).file).format).toBe("binary");
      const md = deref(props(m).metadata);
      expect(md.type).toBe("object");
      expect(md.additionalProperties).toBe(false);
      expect(sorted(md)).toEqual(["intended_effective_from", "licence_attestation_text", "standard", "standard_version", "title"]);
      expect([...reqd(md)].sort()).toEqual(["licence_attestation_text", "standard", "standard_version", "title"]);
      str(deref(props(md).standard_version), 1, 32);
      str(deref(props(md).title), 1, 120);
      str(deref(props(md).licence_attestation_text), 20, 500);
      expect(deref(props(md).intended_effective_from).format).toBe("date-time");
    });
    T("M46 activate: effective_from date-time optional; nothing required", () => {
      expect(bp("activateBreakpointSet", "effective_from").format).toBe("date-time");
      expect(reqd(bodySchema("activateBreakpointSet"))).toEqual([]);
    });
    T("no request body names a server-authority field", () => {
      for (const id of Object.keys(ops))
        for (const f of FORBIDDEN_ANY) expect(keys(bodySchema(id) ?? {}), `${id}.${f}`).not.toContain(f);
    });
  });

  describe("response shapes (TRD §5.1–5.6)", () => {
    T("named DTO schemas are components, closed, and never name tenant_id / created_by / updated_by", () => {
      for (const n of DTOS) {
        expect(schema(n), n).toBeDefined();
        expect(schema(n).additionalProperties, `${n} closed`).toBe(false);
        for (const f of FORBIDDEN_ANY) expect(keys(schema(n)), `${n}.${f}`).not.toContain(f);
      }
    });
    T("paged list ops return {data, page} with the TRD item DTO; M1 page may carry total", () => {
      for (const [id, dto] of Object.entries(LIST_PAGED)) {
        const s = okSchema(id);
        expect(keys(s), id).toEqual(expect.arrayContaining(["data", "page"]));
        expect(item(props(s).data), id).toEqual(deref(schema(dto)));
      }
      const page = deref(props(okSchema("listCultures")).page);
      expect(keys(page), "page.total").toContain("total");
      expect(reqd(page), "page.total optional").not.toContain("total");
      expect(deref(props(page).total).type).toBe("integer");
    });
    T("unpaginated list ops return {data} only; M37 rows {instrument_id, standard, standard_version, version}", () => {
      for (const [id, dto] of Object.entries(LIST_DATA)) {
        const s = okSchema(id);
        expect(keys(s), id).toEqual(["data"]);
        expect(item(props(s).data), id).toEqual(deref(schema(dto)));
      }
      const d = okSchema("listInstrumentAstDefaults");
      expect(keys(d)).toEqual(["data"]);
      expect(sorted(item(props(d).data))).toEqual(["instrument_id", "standard", "standard_version", "version"]);
      expect(deref(props(item(props(d).data)).standard).enum).toEqual(["CLSI", "EUCAST", "ECOFF"]);
      expect(keys(okSchema("putInstrumentAstDefault"))).toEqual(expect.arrayContaining(["instrument_id", "standard", "standard_version", "version"]));
    });
    T("single-object ops return (at least) the properties of their DTO", () => {
      for (const [id, dto] of Object.entries(ONE)) expect(keys(okSchema(id)), id).toEqual(expect.arrayContaining(keys(schema(dto))));
    });
    T("CultureSummaryDto fields exactly; ? fields optional (§5.6)", () => {
      const d = "CultureSummaryDto";
      expect(sorted(schema(d))).toEqual(["barcode", "centre_id", "chain_cancelled", "current_report_version_no", "final_due_at", "id", "is_read_overdue", "last_report_phase", "next_read_due_at",
        "open_instrument_record_count", "order_id", "order_item_id", "outcome_code", "patient_id", "planted_at", "received_at", "specimen_id", "specimen_site_code", "specimen_type_code",
        "status", "test_code", "test_id", "test_name", "version"]);
      for (const f of ["specimen_site_code", "outcome_code", "planted_at", "next_read_due_at", "final_due_at", "last_report_phase", "barcode"]) expect(reqd(schema(d)), f).not.toContain(f);
      expect(reqd(schema(d))).toEqual(expect.arrayContaining(["id", "version", "status", "order_id", "specimen_id", "patient_id", "centre_id", "test_id", "test_code", "test_name", "received_at",
        "is_read_overdue", "current_report_version_no", "chain_cancelled", "open_instrument_record_count"]));
    });
    T("CultureDetailDto = Summary + extras; nested shapes; viewer-gated lab_result / permissions_hint", () => {
      const d = "CultureDetailDto";
      expect(keys(schema(d))).toEqual(expect.arrayContaining([...keys(schema("CultureSummaryDto")), "suggested_protocol", "protocol", "plates", "observations", "isolates", "transitions",
        "report_versions", "amendment_reason_code", "amendment_reason_text", "cancel_reason_code", "lab_result", "permissions_hint"]));
      for (const f of ["suggested_protocol", "protocol", "amendment_reason_code", "amendment_reason_text", "cancel_reason_code", "lab_result"]) expect(reqd(schema(d)), f).not.toContain(f);
      expect(reqd(schema(d))).toEqual(expect.arrayContaining(["plates", "observations", "isolates", "transitions", "report_versions", "permissions_hint"]));
      expect(sorted(prop(d, "suggested_protocol"))).toEqual(["code", "display", "id", "version_no"]);
      expect(sorted(prop(d, "protocol"))).toEqual(["code", "display", "final_no_growth_hours", "id", "read_schedule_hours", "requires_gram_stain", "version_no"]);
      expect(item(prop(d, "plates"))).toEqual(deref(schema("PlateDto")));
      expect(item(prop(d, "observations"))).toEqual(deref(schema("ObservationDto")));
      expect(item(prop(d, "isolates"))).toEqual(deref(schema("IsolateDto")));
      expect(item(prop(d, "report_versions"))).toEqual(deref(schema("ReportVersionSummaryDto")));
      const t = item(prop(d, "transitions"));
      expect(Object.keys(props(t)).sort()).toEqual(["actor_display", "from_status", "occurred_at", "reason_code", "to_status"]);
      for (const f of ["from_status", "reason_code"]) expect(reqd(t), f).not.toContain(f);
      expect(Object.keys(props(prop(d, "lab_result"))).sort()).toEqual(["approved_at", "result_id", "status", "verified_at", "version_no"]);
      expect(Object.keys(props(prop(d, "permissions_hint")))).toEqual(["can_amend_approved"]);
    });
    T("PlateDto and ObservationDto fields exactly (§5.6)", () => {
      expect(sorted(schema("PlateDto"))).toEqual(["id", "incubation_text", "media_code", "parent_plate_id", "planted_at", "plate_no", "source_isolate_id", "status", "version"]);
      for (const f of ["incubation_text", "parent_plate_id", "source_isolate_id"]) expect(reqd(schema("PlateDto")), f).not.toContain(f);
      expect(sorted(schema("ObservationDto"))).toEqual(["corrects_observation_id", "finding_text", "growth_code", "hours_since_planting", "id", "is_corrected", "kind", "observed_at", "plate_id",
        "quantity_text", "recorded_by_display"]);
      for (const f of ["plate_id", "growth_code", "quantity_text", "finding_text", "hours_since_planting", "corrects_observation_id"]) expect(reqd(schema("ObservationDto")), f).not.toContain(f);
      expect(reqd(schema("ObservationDto"))).toEqual(expect.arrayContaining(["id", "kind", "observed_at", "recorded_by_display", "is_corrected"]));
    });
    T("IsolateDto and AstResultDto fields exactly (§5.6)", () => {
      expect(sorted(schema("IsolateDto"))).toEqual(["ast", "ast_method", "ast_panel", "colony_description", "id", "identified_at", "is_reportable", "isolate_seq", "organism_code", "organism_display",
        "organism_source", "quantity_text", "status", "version", "withdraw_reason_code"]);
      expect(reqd(schema("IsolateDto"))).toEqual(expect.arrayContaining(["id", "version", "isolate_seq", "status", "is_reportable", "ast"]));
      for (const f of ["organism_code", "organism_display", "organism_source", "identified_at", "colony_description", "quantity_text", "withdraw_reason_code", "ast_panel", "ast_method"])
        expect(reqd(schema("IsolateDto")), f).not.toContain(f);
      expect(sorted(prop("IsolateDto", "ast_panel"))).toEqual(["code", "display", "id", "version_no"]);
      expect(item(prop("IsolateDto", "ast"))).toEqual(deref(schema("AstResultDto")));
      expect(sorted(schema("AstResultDto"))).toEqual(["antibiotic_code", "antibiotic_display", "breakpoint_set_id", "category_code", "entered_at", "id", "instrument_id", "instrument_result_time",
        "interpretation_raw", "interpretation_source", "is_reportable", "method", "off_panel", "panel_sort_order", "raw_numeric", "raw_qualifier", "raw_value", "report_visibility", "source",
        "standard", "standard_source", "standard_version", "suggestion_overridden", "unit_code", "version"]);
      expect(reqd(schema("AstResultDto"))).toEqual(expect.arrayContaining(["id", "version", "antibiotic_code", "antibiotic_display", "method", "suggestion_overridden", "source", "is_reportable",
        "report_visibility", "off_panel"]));
      for (const f of ["raw_value", "raw_qualifier", "raw_numeric", "unit_code", "category_code", "standard", "standard_version", "standard_source", "interpretation_raw", "interpretation_source",
        "breakpoint_set_id", "instrument_id", "instrument_result_time", "panel_sort_order", "entered_at"]) expect(reqd(schema("AstResultDto")), f).not.toContain(f);
    });
    T("ReportVersionSummaryDto exactly; ReportVersionDto = Summary + extras (§5.6)", () => {
      expect(sorted(schema("ReportVersionSummaryDto"))).toEqual(["amendment_reason_code", "flag", "is_critical", "lab_status_at_submit", "outcome_code", "report_phase", "signed_at", "signed_by_display",
        "version_kind", "version_no"]);
      for (const f of ["outcome_code", "amendment_reason_code"]) expect(reqd(schema("ReportVersionSummaryDto")), f).not.toContain(f);
      expect(keys(schema("ReportVersionDto"))).toEqual(expect.arrayContaining([...keys(schema("ReportVersionSummaryDto")), "culture_summary_text", "isolates", "ast", "comments_text",
        "early_final_reason", "amendment_reason_text", "lab_result_id", "lab_result_version_no"]));
      for (const f of ["comments_text", "early_final_reason", "amendment_reason_text"]) expect(reqd(schema("ReportVersionDto")), f).not.toContain(f);
      expect(reqd(schema("ReportVersionDto"))).toEqual(expect.arrayContaining(["culture_summary_text", "isolates", "ast", "lab_result_id", "lab_result_version_no"]));
    });
    T("InstrumentRecordDto fields exactly; sample_barcode is a staff-only P2 field (§5.6)", () => {
      expect(sorted(schema("InstrumentRecordDto"))).toEqual(["antibiotic_code", "antibiotic_code_raw", "ast_result_id", "culture_id", "expires_at", "id", "ignore_comment", "ignore_reason_code",
        "instrument_id", "instrument_message_id", "instrument_result_time", "interpretation_raw", "is_rerun", "isolate_id", "isolate_seq", "match_reason", "match_status", "method",
        "organism_code", "organism_code_raw", "raw_value", "received_at", "record_kind", "sample_barcode", "standard", "standard_version", "version"]);
      expect(reqd(schema("InstrumentRecordDto"))).toEqual(expect.arrayContaining(["id", "version", "record_kind", "instrument_id", "instrument_message_id", "sample_barcode", "received_at",
        "is_rerun", "match_status"]));
      for (const f of ["isolate_seq", "culture_id", "isolate_id", "ast_result_id", "ignore_reason_code", "ignore_comment", "expires_at", "match_reason", "organism_code", "antibiotic_code"])
        expect(reqd(schema("InstrumentRecordDto")), f).not.toContain(f);
    });
    T("BreakpointSetDto fields exactly (§5.6); status enum includes uploaded", () => {
      expect(sorted(schema("BreakpointSetDto"))).toEqual(["activated_at", "activated_by_display", "band_count", "created_at", "effective_from", "effective_to", "error_count", "file_bytes",
        "file_sha256", "id", "imported_by_display", "intended_effective_from", "licence_attestation_text", "retired_at", "row_count", "standard", "standard_version", "status", "title",
        "version", "warning_count"]);
      expect(reqd(schema("BreakpointSetDto"))).toEqual(expect.arrayContaining(["id", "version", "standard", "standard_version", "title", "licence_attestation_text", "status", "file_sha256",
        "file_bytes", "row_count", "band_count", "error_count", "warning_count", "imported_by_display", "created_at"]));
      for (const f of ["intended_effective_from", "effective_from", "effective_to", "activated_by_display", "activated_at", "retired_at"]) expect(reqd(schema("BreakpointSetDto")), f).not.toContain(f);
      const st = prop("BreakpointSetDto", "status");
      if (st.enum) expect(st.enum).toContain("uploaded");
      else expect(st["x-coded-set"] ?? st.example ?? JSON.stringify(st)).toBeDefined();
    });
    T("config DTOs carry the fields the request tables name; Plating/AstPanel/VocabMap carry id + version", () => {
      shape(schema("PlatingProtocolDto"), ["id", "version", "code", "display", "read_schedule_hours", "final_no_growth_hours", "requires_gram_stain", "media", "applies_to"], ["default_specimen_site_code"], "PlatingProtocolDto");
      shape(schema("AstPanelDto"), ["id", "version", "code", "display", "default_method", "antibiotics"], ["organism_code", "organism_group_code", "specimen_site_code"], "AstPanelDto");
      shape(schema("VocabMapDto"), ["id", "version", "instrument_id", "kind", "code_raw", "local_code", "is_active"], [], "VocabMapDto");
      shape(schema("MicroSettingsDto"), ["zone_suggestion_enabled", "mic_suggestion_enabled", "default_final_no_growth_hours", "early_final_requires_reason", "recent_window_days"], ["manual_ast_standard"], "MicroSettingsDto");
    });
    T("M12 response {results[{antibiotic_code, method, outcome ok|error, code?, path?, ast_result?}]}; partial success is a 200", () => {
      const s = okSchema("recordAstResults");
      expect(sorted(s)).toEqual(["results"]);
      const r = item(props(s).results);
      expect(Object.keys(props(r)).sort()).toEqual(["antibiotic_code", "ast_result", "code", "method", "outcome", "path"]);
      expect(deref(props(r).outcome).enum).toEqual(["ok", "error"]);
      expect([...reqd(r)].sort()).toEqual(["antibiotic_code", "method", "outcome"]);
      expect(deref(props(r).ast_result)).toEqual(deref(schema("AstResultDto")));
      expect(Object.keys(ops.recordAstResults.op.responses)).toContain("200");
    });
    T("M13 response {results[{antibiotic_code, method, suggestion?{...}, reason? enum}]}", () => {
      const r = item(props(okSchema("previewAstInterpretation")).results);
      expect(Object.keys(props(r)).sort()).toEqual(["antibiotic_code", "method", "reason", "suggestion"]);
      expect(Object.keys(props(props(r).suggestion)).sort()).toEqual(["breakpoint_band_id", "breakpoint_set_id", "category_code", "standard", "standard_version"]);
      expect(deref(props(r).reason).enum).toEqual(["no_active_set", "no_row", "indeterminate", "disabled", "value_invalid"]);
      for (const f of ["suggestion", "reason"]) expect(reqd(r), f).not.toContain(f);
    });
    T("M6 response {observation, culture}", () => {
      const s = okSchema("recordCultureObservation");
      expect(sorted(s)).toEqual(["culture", "observation"]);
      expect(deref(props(s).observation)).toEqual(deref(schema("ObservationDto")));
      expect(deref(props(s).culture)).toEqual(deref(schema("CultureSummaryDto")));
    });
    T("M23 coded set {data:[{code, display, sort_order, is_active, source global|tenant, + extras (ast_interpretations: standard)}]}", () => {
      const l = okSchema("listMicroCodedSet");
      expect(keys(l)).toEqual(["data"]);
      const t = item(props(l).data);
      expect(keys(t)).toEqual(expect.arrayContaining(["code", "display", "sort_order", "is_active", "source", "standard"]));
      expect(deref(props(t).source).enum).toEqual(["global", "tenant"]);
      expect(reqd(t)).toEqual(expect.arrayContaining(["code", "display", "sort_order", "is_active", "source"]));
      expect(reqd(t)).not.toContain("standard");
      expect(keys(okSchema("upsertMicroCode"))).toEqual(expect.arrayContaining(["code", "display", "sort_order", "is_active"]));
    });
    T("M44 issue rows {line_no?, severity, code, field?, message}; M45 rows with bands", () => {
      const i = item(props(okSchema("listBreakpointImportIssues")).data);
      expect(Object.keys(props(i)).sort()).toEqual(["code", "field", "line_no", "message", "severity"]);
      expect([...reqd(i)].sort()).toEqual(["code", "message", "severity"]);
      const r = item(props(okSchema("listBreakpointRows")).data);
      expect(Object.keys(props(r)).sort()).toEqual(["antibiotic_code", "bands", "id", "line_no", "method", "organism_code", "organism_scope", "qualifier_code", "specimen_site_code"]);
      expect(reqd(r)).toEqual(expect.arrayContaining(["id", "line_no", "organism_scope", "antibiotic_code", "method", "bands"]));
      for (const f of ["organism_code", "specimen_site_code", "qualifier_code"]) expect(reqd(r), f).not.toContain(f);
      const b = item(props(r).bands);
      expect(Object.keys(props(b)).sort()).toEqual(["band_no", "category_code", "id", "lower_inclusive", "lower_value", "note", "upper_inclusive", "upper_value"]);
      expect(reqd(b)).toEqual(expect.arrayContaining(["id", "band_no", "category_code", "lower_inclusive", "upper_inclusive"]));
      for (const f of ["lower_value", "upper_value", "note"]) expect(reqd(b), f).not.toContain(f);
      for (const f of ["lower_value", "upper_value"]) expect(deref(props(b)[f]).type, f).toBe("string");
    });
    T("M49 template: 200 text/csv, Content-Disposition attachment breakpoint-template.csv, Cache-Control no-store", () => {
      const r = okResp("downloadBreakpointTemplate", "200");
      expect(Object.keys(r.content ?? {})).toContain("text/csv");
      expect(Object.keys(r.headers ?? {})).toEqual(expect.arrayContaining(["Content-Disposition", "Cache-Control"]));
      expect(JSON.stringify(r.headers)).toContain("no-store");
      expect(JSON.stringify(r.headers["Content-Disposition"])).toMatch(/attachment/);
      expect(JSON.stringify(r.headers["Content-Disposition"])).toContain("breakpoint-template.csv");
    });
    T("no schema names tenant_id / created_by / updated_by (scope is the token, not the wire)", () => {
      for (const [n, s] of Object.entries<any>(doc.components?.schemas ?? {}))
        for (const f of FORBIDDEN_ANY) expect(Object.keys(props(s)), `${n}.${f}`).not.toContain(f);
      for (const { op } of Object.values(ops))
        for (const [, r] of Object.entries<any>(op.responses ?? {}))
          walk(deref(r)?.content?.["application/json"]?.schema, (n) => { for (const f of FORBIDDEN_ANY) expect(Object.keys(props(n)), f).not.toContain(f); });
    });
  });

  describe("authentication surface", () => {
    T("no operation is public: no x-public, every op security bearerJwt only", () => {
      for (const [id, { op }] of Object.entries(ops)) {
        expect(op["x-public"], id).toBeUndefined();
        expect(op.security, id).toEqual([{ bearerJwt: [] }]);
      }
    });
    T("ops the TRD names auth.mfa_required for list it (M14 M42 M46 M47)", () => {
      for (const id of ["submitCultureReport", "createBreakpointImport", "activateBreakpointSet", "retireBreakpointSet"]) expect(ops[id].op["x-error-codes"], id).toContain(MFA);
    });
  });

  describe("synthetic examples and offline 'Prism smoke' (AC-0C-1.4)", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...doc, id: "micro.yaml" });
    const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    const check = (ptr: string, example: unknown) => {
      const validate = ajv.getSchema(`micro.yaml#${ptr}`);
      expect(validate, `cannot resolve ${ptr}`).toBeDefined();
      expect(validate!(example), `${ptr}: ${JSON.stringify(validate!.errors?.[0])}`).toBe(true);
    };
    const exampleValues = (): unknown[] => {
      const out: unknown[] = [];
      const w = (x: any) => {
        if (Array.isArray(x)) x.forEach(w);
        else if (x && typeof x === "object") {
          for (const [k, v] of Object.entries<any>(x)) {
            if (k === "example") out.push(v);
            else if (k === "examples" && v && typeof v === "object") for (const e of Object.values<any>(v)) out.push(e?.value);
            else w(v);
          }
        }
      };
      w(doc);
      return out;
    };
    it("every JSON request/response example matches its schema; at least one per JSON-bearing operation", () => {
      ex();
      let n = 0;
      for (const { method, path, op } of Object.values(ops)) {
        const base = `/paths/${esc(path)}/${method.toLowerCase()}`;
        const media: [string, any][] = [];
        const rb = op.requestBody;
        if (rb?.content?.["application/json"]) media.push([`${base}/requestBody/content/application~1json`, rb.content["application/json"]]);
        for (const [code, r] of Object.entries<any>(op.responses ?? {}))
          if (!r.$ref && r.content?.["application/json"]) media.push([`${base}/responses/${code}/content/application~1json`, r.content["application/json"]]);
        for (const [q, m] of media)
          for (const [k, e] of Object.entries<any>(m.examples ?? {})) {
            if (m.schema) check(`${q}/schema`, e.value);
            n++;
            expect(k.length).toBeGreaterThan(0);
          }
      }
      expect(n).toBeGreaterThanOrEqual(45);
    });
    it("every operation with a JSON 2xx response has an example Prism can serve; M49 serves a CSV example", () => {
      ex();
      expect(Object.keys(ops).length).toBe(TOTAL);
      for (const s of SPECS) {
        const { op, path, method } = ops[s.id];
        const two = Object.entries<any>(op.responses ?? {}).filter(([c]) => /^2/.test(c));
        expect(two.length, `${method} ${path}: no 2xx`).toBeGreaterThan(0);
        for (const [c, r0] of two) {
          const j = deref(r0).content?.["application/json"];
          if (j) expect(Object.keys(j.examples ?? {}).length, `${method} ${path} ${c}: no example`).toBeGreaterThan(0);
        }
      }
      const csv = okResp("downloadBreakpointTemplate", "200").content?.["text/csv"];
      expect(csv?.example !== undefined || Object.keys(csv?.examples ?? {}).length > 0, "CSV example").toBe(true);
    });
    it("examples are synthetic: no e-mail, no Nepali-mobile-shaped number, no Windows/user paths, no live-looking token or IP", () => {
      ex();
      const vals = exampleValues();
      expect(vals.length, "no examples at all").toBeGreaterThan(0);
      const blob = JSON.stringify(vals);
      expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
      expect(blob).not.toMatch(/(?<!\d)(?:\+?977[-\s]?)?9[678]\d{8}(?!\d)/);
      expect(blob).not.toMatch(/[A-Z]:\\\\|\/Users\/|\/home\//);
      expect(blob, "no JWT-shaped value").not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
      for (const ip of blob.match(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g) ?? [])
        expect(ip, `non-documentation IP ${ip}`).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
    });
  });

  describe("mock script (wave-1 convention)", () => {
    it("package.json has `mock:micro` = prism mock contracts/openapi/micro.yaml on a port no other mock uses", () => {
      const scripts: Record<string, string> = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
      const mine = scripts["mock:micro"];
      expect(mine, "mock:micro script missing").toBeDefined();
      const m = /^prism mock contracts\/openapi\/micro\.yaml --host 127\.0\.0\.1 --port (\d+)$/.exec(mine);
      expect(m, mine).not.toBeNull();
      const ports = Object.entries(scripts).filter(([k]) => k.startsWith("mock:") && k !== "mock:micro" && k !== "mock:list")
        .map(([, v]) => /--port (\d+)/.exec(v)?.[1]);
      expect(ports).not.toContain(m![1]);
    });
  });
});
