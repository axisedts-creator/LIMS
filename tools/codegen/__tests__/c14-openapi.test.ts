// T0C-10.C14 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/smartreport.yaml (C14 transcription of spec/chunks/C14-smart-report/02-TRD.md §5, §5.1; LD-103).
// Checks: (1) exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) clean for smartreport.yaml; (3) AC-0C-1.5 negatives on a temp copy;
// (4) smartreport = TRD §5 table (35 ops), method+path under /v1/smartreport, x-permission (one code, P-43), security bearerJwt, x-idempotency, tier general,
//     success status, specific + common error codes (+ auth.mfa_required on privileged permissions), Idempotency-Key on R rows, If-Match on ✓ rows;
// (5) shape pins from §5.1 (query params, enums, bounds, patterns, x-coded-set without enum, DTO fields, SmartSummaryView sub-shapes, no tenant_id, no PHI paths);
// (6) "Prism smoke" offline: examples validate (ajv), every op has a servable 2xx example, examples synthetic; (7) package.json `mock:smartreport` script.
// Not testable here: Prism actually serving the file (prism not installed), generated-client freshness (codegen-fresh suite), access-log calls (runtime), field allowlist (runtime mapper).
// Assumptions (TRD silent or ambiguous; each is also in the notes file):
//  - every op lists the six common codes (TRD §5 intro); IDEM codes (3) on R rows; common.version_conflict + common.precondition_required on ✓ rows;
//    #14 putSmartAnalyteGroup ("✓ when the row exists") declares If-Match and common.version_conflict but precondition_required is not pinned either way;
//  - privileged permissions (permissions.yaml: smartreport.template.approve, smartreport.summary.approve) add auth.mfa_required (TRD §5 intro) — pinned on #20 #21 #30–#34;
//  - Optional-idem ops pin no Idempotency-Key header presence either way (wave 1 / C15 convention);
//  - DELETE ops #8 #12 #15 (deactivate) have no response body in the TRD: only "some 2xx" is pinned; #14 declares 200 and 201; #30 declares 201 and 200;
//  - no operation is public: no x-public anywhere, security [{bearerJwt: []}] on all;
//  - attestation (#20, #31) is `enum: [true]` ("must be true"); #22 body is oneOf {order_id} | {fixture_code}; the preview response has no required `id`;
//  - list/table caps: blocks maxItems 500, rules maxItems 1000 (TRD "≤ 500 / ≤ 1,000, unpaginated").
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRD = join(ROOT, "spec/chunks/C14-smart-report/02-TRD.md");
const FILE = join(ROOT, "contracts/openapi/smartreport.yaml");
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const METHODS = ["get", "put", "post", "delete", "patch"];
const name = "smartreport";
const PFX = "/v1/smartreport";

const TM = "smartreport.template.manage", TA = "smartreport.template.approve", SR = "smartreport.summary.read", SA = "smartreport.summary.approve";
const VC = "common.version_conflict", PRE = "common.precondition_required", IMM = "common.immutable_record", CUR = "common.invalid_cursor", MFA = "auth.mfa_required";
const IDEM = ["common.idempotency_key_required", "common.idempotency_key_reused", "common.idempotency_in_progress"];
const SIX = ["common.validation_failed", "common.not_found", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"];
const LIT = "smartreport.library_invalid_transition", LI = "smartreport.library_invalid", NER = "smartreport.no_eligible_results", FD = "smartreport.feature_disabled";
const TNA = "smartreport.template_not_approved", SIT = "smartreport.summary_invalid_transition", SS = "smartreport.summary_superseded";

type Spec = { n: number; id: string; method: string; path: string; perm: string; idem: "none" | "optional" | "required"; status: number[]; err: string[]; im?: boolean; imOpt?: boolean; paged?: boolean };
const N = "none" as const, O = "optional" as const, R = "required" as const;
const S = (n: number, id: string, method: string, path: string, perm: string, idem: Spec["idem"], status: number[], err: string[], o: Partial<Spec> = {}): Spec =>
  ({ n, id, method, path, perm, idem, status, err, im: false, ...o });
const IM = { im: true }, L = { paged: true };
const LV = "/library-versions/{library_version_id}";

const SPECS: Spec[] = [
  S(1, "listSmartLibraryVersions", "GET", "/library-versions", TM, N, [200], [CUR], L),
  S(2, "createSmartLibraryVersion", "POST", "/library-versions", TM, R, [201], [LIT, ...IDEM]),
  S(3, "getSmartLibraryVersion", "GET", LV, TM, N, [200], []),
  S(4, "updateSmartLibraryVersion", "PATCH", LV, TM, O, [200], [LIT, VC, PRE], IM),
  S(5, "listSmartTemplateBlocks", "GET", `${LV}/blocks`, TM, N, [200], []),
  S(6, "createSmartTemplateBlock", "POST", `${LV}/blocks`, TM, R, [201], [LIT, LI, ...IDEM]),
  S(7, "replaceSmartTemplateBlock", "PUT", `${LV}/blocks/{block_id}`, TM, O, [200], [LIT, LI, VC, PRE], IM),
  S(8, "deleteSmartTemplateBlock", "DELETE", `${LV}/blocks/{block_id}`, TM, N, [], [LIT, LI, VC, PRE], IM),
  S(9, "listSmartRules", "GET", `${LV}/rules`, TM, N, [200], []),
  S(10, "createSmartRule", "POST", `${LV}/rules`, TM, R, [201], [LIT, LI, ...IDEM]),
  S(11, "replaceSmartRule", "PUT", `${LV}/rules/{rule_id}`, TM, O, [200], [LIT, LI, VC, PRE], IM),
  S(12, "deleteSmartRule", "DELETE", `${LV}/rules/{rule_id}`, TM, N, [], [LIT, VC, PRE], IM),
  S(13, "listSmartAnalyteGroups", "GET", `${LV}/analyte-groups`, TM, N, [200], []),
  S(14, "putSmartAnalyteGroup", "PUT", `${LV}/analyte-groups/{analyte_id}`, TM, O, [200, 201], [LIT, VC], { im: true, imOpt: true }),
  S(15, "deleteSmartAnalyteGroup", "DELETE", `${LV}/analyte-groups/{analyte_id}`, TM, N, [], [LIT, VC, PRE], IM),
  S(16, "listSmartGroupSettings", "GET", `${LV}/groups`, TM, N, [200], []),
  S(17, "putSmartGroupSetting", "PUT", `${LV}/groups/{group_code}`, TM, O, [200], [LIT, VC, PRE], IM),
  S(18, "validateSmartLibraryVersion", "POST", `${LV}/validate`, TM, N, [200], []),
  S(19, "submitSmartLibraryVersion", "POST", `${LV}/submit`, TM, O, [200], [LI, LIT, VC, PRE], IM),
  S(20, "approveSmartLibraryVersion", "POST", `${LV}/approve`, TA, O, [200], [LIT, MFA, VC, PRE], IM),
  S(21, "returnSmartLibraryVersion", "POST", `${LV}/return`, TA, O, [200], [LIT, MFA, VC, PRE], IM),
  S(22, "previewSmartLibraryVersion", "POST", `${LV}/preview`, TM, N, [200], [NER]),
  S(23, "listSmartDenyTerms", "GET", "/wording-deny-terms", TM, N, [200], []),
  S(24, "createSmartDenyTerm", "POST", "/wording-deny-terms", TM, R, [201], [...IDEM]),
  S(25, "deactivateSmartDenyTerm", "POST", "/wording-deny-terms/{term_id}/deactivate", TM, O, [200], [IMM, VC, PRE], IM),
  S(26, "getSmartCodedSet", "GET", "/coded-sets/{set_code}", SR, N, [200], []),
  S(27, "listSmartSummaries", "GET", "/summaries", SR, N, [200], [CUR], L),
  S(28, "getSmartSummary", "GET", "/summaries/{summary_id}", SR, N, [200], []),
  S(29, "getCurrentSmartSummary", "GET", "/orders/{order_id}/summary", SR, N, [200], []),
  S(30, "buildSmartSummary", "POST", "/orders/{order_id}/summaries", SA, R, [200, 201], [FD, TNA, NER, MFA, ...IDEM]),
  S(31, "approveSmartSummary", "POST", "/summaries/{summary_id}/approve", SA, O, [200], [SIT, SS, MFA, VC, PRE], IM),
  S(32, "rejectSmartSummary", "POST", "/summaries/{summary_id}/reject", SA, O, [200], [SIT, MFA, VC, PRE], IM),
  S(33, "requestSmartLlmRephrase", "POST", "/summaries/{summary_id}/llm-rephrase", SA, R, [202], [FD, SIT, MFA, VC, PRE, ...IDEM], IM),
  S(34, "listSmartLlmRuns", "GET", "/summaries/{summary_id}/llm-runs", SA, N, [200], [MFA]),
  S(35, "getSmartLibraryCodedSet", "GET", "/library/coded-sets/{set_code}", TM, N, [200], []),
];
const TOTAL = 35;

const DTOS = ["LibraryParams", "LibraryVersionSummary", "LibraryVersion", "TemplateBlock", "Rule", "AnalyteGroup", "GroupSetting", "SmartSummaryListItem", "SmartSummaryView"];
const LIST_PAGED: Record<string, string> = { listSmartLibraryVersions: "LibraryVersionSummary", listSmartSummaries: "SmartSummaryListItem" };
const LIST_DATA: Record<string, string> = { listSmartTemplateBlocks: "TemplateBlock", listSmartRules: "Rule", listSmartAnalyteGroups: "AnalyteGroup", listSmartGroupSettings: "GroupSetting" };
const ONE: Record<string, string> = { getSmartLibraryVersion: "LibraryVersion", createSmartLibraryVersion: "LibraryVersion", updateSmartLibraryVersion: "LibraryVersion",
  submitSmartLibraryVersion: "LibraryVersion", approveSmartLibraryVersion: "LibraryVersion", returnSmartLibraryVersion: "LibraryVersion",
  createSmartTemplateBlock: "TemplateBlock", replaceSmartTemplateBlock: "TemplateBlock", createSmartRule: "Rule", replaceSmartRule: "Rule",
  putSmartAnalyteGroup: "AnalyteGroup", putSmartGroupSetting: "GroupSetting",
  getSmartSummary: "SmartSummaryView", getCurrentSmartSummary: "SmartSummaryView", buildSmartSummary: "SmartSummaryView", approveSmartSummary: "SmartSummaryView", rejectSmartSummary: "SmartSummaryView" };
const PHI_PARAMS = ["barcode", "sample_barcode", "registration_no", "patient_id", "patient_name", "patient_display_name", "phone", "phone_e164", "email", "full_name", "name"];
// never in any schema of this file: tenant scope (library objects are tenant-wide, no tenant_id on the wire)
const FORBIDDEN_ANY = ["tenant_id"];
const PARAM_KEYS = ["score_enabled", "credit_in_range_bp", "credit_borderline_bp", "credit_out_of_range_bp", "credit_critical_bp", "min_groups_scored", "band_good_min", "band_fair_min",
  "critical_forces_needs_attention", "borderline_fraction_bp", "min_mapped_results", "trend_enabled", "trend_max_points", "trend_lookback_days", "trend_stable_bp", "trends_max",
  "advice_max_blocks", "followup_max"];

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("smartreport.yaml (T0C-10.C14)", () => {
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
  const ex = () => expect(existsSync(FILE), "contracts/openapi/smartreport.yaml missing").toBe(true);
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

  describe("exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
    it("file exists", () => expect(existsSync(FILE), "contracts/openapi/smartreport.yaml missing").toBe(true));
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
      const dir = mkdtempSync(join(tmpdir(), "c14-smartreport-lint-"));
      tmps.push(dir);
      cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
      const d = parse(readFileSync(FILE, "utf8"));
      fn(d);
      writeFileSync(join(dir, "contracts/openapi/smartreport.yaml"), stringify(d, { aliasDuplicateObjects: false }));
      return (await lintRepo(dir)).filter((x) => x.file === name);
    };
    const firstOp = (d: any, pred: (o: any) => boolean) =>
      Object.values<any>(d.paths).flatMap((q) => METHODS.map((m) => q[m]).filter(Boolean)).find(pred);

    it("x-permission not in permissions.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = "smartreport.no_such.permission"; });
      expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
    });
    it("x-error-codes entry not in errors.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push("smartreport.no_such_error"); });
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
        const s = Object.values<any>(d.components?.schemas ?? {}).flatMap((x: any) => Object.values<any>(x?.properties ?? {})).find((x) => "x-coded-set" in x);
        s.enum = ["a"];
      });
      expect(v.some((x) => x.rule === "6")).toBe(true);
    });
  });

  describe("smartreport equals 02-TRD §5 (no missing, no extra operations)", () => {
    it(`${TOTAL} operations; table ids unique; file has exactly these`, () => {
      expect(SPECS.length).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.id)).size).toBe(TOTAL);
      expect(Object.keys(ops).sort()).toEqual(SPECS.map((s) => s.id).sort());
    });
    it("TRD drift guard: §5 table = test table (operationId, method + path, first permission, Idem)", () => {
      const all = readFileSync(TRD, "utf8").split("\n");
      const start = all.findIndex((l) => l.startsWith("## 5. Endpoints"));
      const end = all.findIndex((l, k) => k > start && l.startsWith("### 5.1 "));
      expect(start).toBeGreaterThanOrEqual(0);
      const rows = new Map<number, { id: string; mp: string; perm: string; idem: string }>();
      for (const l of all.slice(start, end)) {
        const c = l.split("|");
        if (!/^\s*\d+\s*$/.test(c[1] ?? "")) continue;
        const id = /^\s*`([a-z][A-Za-z0-9]+)`/.exec(c[3] ?? "")?.[1];
        const mp = /^\s*([A-Z]+)\s+`([^`]+)`/.exec(c[2] ?? "");
        const perm = /`(smartreport\.[a-z_.]+)`/.exec(c[4] ?? "")?.[1];
        rows.set(Number(c[1]), { id: id ?? "", mp: `${mp?.[1]} ${mp?.[2]}`, perm: perm ?? "", idem: (c[5] ?? "").trim() });
      }
      expect(rows.size, "rows parsed from TRD").toBe(TOTAL);
      for (const s of SPECS) {
        const r = rows.get(s.n);
        expect(r?.id, `#${s.n} id`).toBe(s.id);
        expect(r?.mp, `#${s.n} method+path`).toBe(`${s.method} ${s.path}`);
        expect(r?.perm, `#${s.n} permission`).toBe(s.perm);
        expect(r?.idem, `#${s.n} idem`).toBe({ none: "–", optional: "O", required: "R" }[s.idem]);
      }
    });
    T("every path is /v1/smartreport/… with tags [smartreport]; no PHI path or query params (REQ-SEC-098)", () => {
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
      if (!r.err.includes(MFA)) expect(o["x-error-codes"], "non-privileged op").not.toContain(MFA);
    });
    it("Idempotency-Key header where x-idempotency required, none where none; If-Match on ✓ rows only", () => {
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

  describe("query and path parameters (TRD §5, §5.1)", () => {
    const names = (id: string) => params(id).filter((q: any) => q?.in === "query").map((q: any) => q.name);
    T("list query parameter names", () => {
      expect(names("listSmartLibraryVersions")).toEqual(expect.arrayContaining(["status", "limit", "cursor", "sort"]));
      expect(names("listSmartTemplateBlocks")).toEqual(["kind"]);
      expect(names("listSmartRules")).toEqual(["rule_kind"]);
      expect(names("listSmartDenyTerms")).toEqual(["include_global"]);
      expect(names("listSmartSummaries")).toEqual(expect.arrayContaining(["status", "centre_id", "built_at_from", "built_at_to", "has_critical", "limit", "cursor", "sort"]));
    });
    T("sort enums are exactly the TRD lists", () => {
      expect(pschema("listSmartLibraryVersions", "sort").enum).toEqual(["-version_no"]);
      expect(pschema("listSmartSummaries", "sort").enum).toEqual(["built_at", "-built_at"]);
      expect(pschema("listSmartSummaries", "sort").default).toBe("built_at");
    });
    T("#27 status defaults to draft; centre_id uuid; built_at_* date-time; has_critical boolean; include_global boolean", () => {
      expect(pschema("listSmartSummaries", "status").default).toBe("draft");
      expect(pschema("listSmartSummaries", "centre_id").format).toBe("uuid");
      for (const f of ["built_at_from", "built_at_to"]) expect(pschema("listSmartSummaries", f).format, f).toBe("date-time");
      expect(pschema("listSmartSummaries", "has_critical").type).toBe("boolean");
      expect(pschema("listSmartDenyTerms", "include_global").type).toBe("boolean");
      for (const f of ["status", "centre_id", "built_at_from", "built_at_to", "has_critical"]) expect(param("listSmartSummaries", f).required, f).not.toBe(true);
    });
    T("block `kind` and rule `rule_kind` filters carry the TRD enums", () => {
      expect(pschema("listSmartTemplateBlocks", "kind").enum).toEqual(["deranged", "advice", "followup", "disclaimer", "score_explanation"]);
      expect(pschema("listSmartRules", "rule_kind").enum).toEqual(["deranged", "advice", "followup"]);
    });
    T("set_code path param: #26 enum summary_reject_reasons, #35 enum organ_groups", () => {
      expect(pschema("getSmartCodedSet", "set_code").enum).toEqual(["summary_reject_reasons"]);
      expect(pschema("getSmartLibraryCodedSet", "set_code").enum).toEqual(["organ_groups"]);
      expect(param("getSmartCodedSet", "set_code").in).toBe("path");
    });
    T("path ids are required uuids", () => {
      for (const [id, f] of [["getSmartLibraryVersion", "library_version_id"], ["replaceSmartTemplateBlock", "block_id"], ["replaceSmartRule", "rule_id"], ["putSmartAnalyteGroup", "analyte_id"],
        ["deactivateSmartDenyTerm", "term_id"], ["getSmartSummary", "summary_id"], ["getCurrentSmartSummary", "order_id"]] as const) {
        expect(param(id, f)?.in, `${id}:${f}`).toBe("path");
        expect(pschema(id, f)?.format, `${id}:${f}`).toBe("uuid");
      }
    });
    T("every path parameter is required", () => {
      for (const id of Object.keys(ops)) for (const q of params(id).filter((x: any) => x?.in === "path")) expect(q.required, `${id}:${q.name}`).toBe(true);
    });
  });

  describe("request bodies (TRD §5.1)", () => {
    T("#2 create: source enum, source_version_id uuid, change_summary ≤500; source required", () => {
      const s = "createSmartLibraryVersion";
      expect(bp(s, "source").enum).toEqual(["starter", "clone_active", "clone_version"]);
      expect(bp(s, "source_version_id").format).toBe("uuid");
      expect(bp(s, "change_summary").maxLength).toBe(500);
      expect(reqd(bodySchema(s))).toEqual(["source"]);
    });
    T("#4 patch: language en|ne, change_summary ≤500, params = LibraryParams; nothing required", () => {
      const s = "updateSmartLibraryVersion";
      expect(bp(s, "language").enum).toEqual(["en", "ne"]);
      expect(bp(s, "change_summary").maxLength).toBe(500);
      expect(sorted(bp(s, "params"))).toEqual([...PARAM_KEYS].sort());
      expect(reqd(bodySchema(s))).toEqual([]);
      expect(reqd(bp(s, "params")), "all LibraryParams fields optional on PATCH").toEqual([]);
    });
    T("LibraryParams bounds (TRD §5.1 field list)", () => {
      const g = (f: string) => deref(props(bp("updateSmartLibraryVersion", "params"))[f]);
      for (const f of ["credit_in_range_bp", "credit_borderline_bp", "credit_out_of_range_bp", "credit_critical_bp"]) int(g(f), 0, 10000);
      int(g("min_groups_scored"), 1, 20);
      int(g("band_good_min"), 1, 100);
      int(g("band_fair_min"), 0, 99);
      int(g("borderline_fraction_bp"), 0, 2500);
      int(g("min_mapped_results"), 1, 50);
      int(g("trend_max_points"), 2, 6);
      int(g("trend_lookback_days"), 30, 3650);
      int(g("trend_stable_bp"), 0, 5000);
      int(g("trends_max"), 0, 12);
      int(g("advice_max_blocks"), 0, 10);
      int(g("followup_max"), 0, 5);
      for (const f of ["score_enabled", "critical_forces_needs_attention", "trend_enabled"]) expect(g(f).type, f).toBe("boolean");
    });
    T("#6 / #7 block body: block_key pattern, kind enum, text_en/ne ≤600, note ≤500; block_key + kind required", () => {
      for (const s of ["createSmartTemplateBlock", "replaceSmartTemplateBlock"]) {
        expect(bp(s, "block_key").pattern, s).toBe("^[a-z][a-z0-9_.]{2,79}$");
        expect(bp(s, "kind").enum, s).toEqual(["deranged", "advice", "followup", "disclaimer", "score_explanation"]);
        expect(bp(s, "text_en").maxLength, s).toBe(600);
        expect(bp(s, "text_ne").maxLength, s).toBe(600);
        expect(bp(s, "note").maxLength, s).toBe(500);
        expect([...reqd(bodySchema(s))].sort(), s).toEqual(["block_key", "kind"]);
      }
    });
    T("#10 / #11 rule body: enums, priority 1–999 default 100, interval_days 1–730, uuids; four required", () => {
      for (const s of ["createSmartRule", "replaceSmartRule"]) {
        expect(bp(s, "rule_kind").enum, s).toEqual(["deranged", "advice", "followup"]);
        expect(bp(s, "trigger_kind").enum, s).toEqual(["analyte", "group", "any", "all_in_range"]);
        expect(bp(s, "direction").enum, s).toEqual(["low", "high", "abnormal", "any"]);
        expect(bp(s, "min_severity").enum, s).toEqual(["borderline", "out_of_range", "critical"]);
        int(bp(s, "priority"), 1, 999);
        expect(bp(s, "priority").default, s).toBe(100);
        int(bp(s, "interval_days"), 1, 730);
        for (const f of ["analyte_id", "block_id", "suggested_test_id"]) expect(bp(s, f).format, `${s}.${f}`).toBe("uuid");
        expect(bp(s, "group_code"), `${s}.group_code`).toBeDefined();
        expect([...reqd(bodySchema(s))].sort(), s).toEqual(["block_id", "direction", "rule_kind", "trigger_kind"]);
      }
    });
    T("#14 analyte-group body: group_code required; include_in_score default true, trend_enabled default false; bp bounds; sort_order 0–9999", () => {
      const s = "putSmartAnalyteGroup";
      expect(reqd(bodySchema(s))).toEqual(["group_code"]);
      expect([bp(s, "include_in_score").type, bp(s, "include_in_score").default]).toEqual(["boolean", true]);
      expect([bp(s, "trend_enabled").type, bp(s, "trend_enabled").default]).toEqual(["boolean", false]);
      int(bp(s, "borderline_fraction_bp"), 0, 2500);
      int(bp(s, "trend_stable_bp"), 0, 5000);
      int(bp(s, "sort_order"), 0, 9999);
    });
    T("#17 group setting body: display_en 1–60, display_ne ≤60, score_weight 0–10, sort_order 0–9999, is_shown; four required", () => {
      const s = "putSmartGroupSetting";
      expect([bp(s, "display_en").minLength, bp(s, "display_en").maxLength]).toEqual([1, 60]);
      expect(bp(s, "display_ne").maxLength).toBe(60);
      int(bp(s, "score_weight"), 0, 10);
      int(bp(s, "sort_order"), 0, 9999);
      expect(bp(s, "is_shown").type).toBe("boolean");
      expect([...reqd(bodySchema(s))].sort()).toEqual(["display_en", "is_shown", "score_weight", "sort_order"]);
    });
    T("#18 / #19 / #25 / #33 take no required body fields (`{}`)", () => {
      for (const id of ["validateSmartLibraryVersion", "submitSmartLibraryVersion", "deactivateSmartDenyTerm", "requestSmartLlmRephrase"]) {
        const b = bodySchema(id);
        if (b) expect(reqd(b), id).toEqual([]);
      }
    });
    T("#20 approve: attestation must be true (enum [true]), note ≤500; #21 return: comment 1–1000 required", () => {
      expect(bp("approveSmartLibraryVersion", "attestation").enum).toEqual([true]);
      expect(bp("approveSmartLibraryVersion", "note").maxLength).toBe(500);
      expect(reqd(bodySchema("approveSmartLibraryVersion"))).toEqual(["attestation"]);
      const c = bp("returnSmartLibraryVersion", "comment");
      expect([c.minLength, c.maxLength]).toEqual([1, 1000]);
      expect(reqd(bodySchema("returnSmartLibraryVersion"))).toEqual(["comment"]);
    });
    T("#22 preview: body is exactly one of {order_id uuid} | {fixture_code enum}", () => {
      const b = bodySchema("previewSmartLibraryVersion");
      const alts = (b.oneOf ?? []).map(deref);
      expect(alts.length, "oneOf with two alternatives").toBe(2);
      const order = alts.find((a: any) => "order_id" in props(a));
      const fixture = alts.find((a: any) => "fixture_code" in props(a));
      expect(deref(props(order).order_id).format).toBe("uuid");
      expect(deref(props(fixture).fixture_code).enum).toEqual(["synthetic_basic", "synthetic_all_in_range", "synthetic_critical"]);
      expect(reqd(order)).toEqual(["order_id"]);
      expect(reqd(fixture)).toEqual(["fixture_code"]);
    });
    T("#24 deny term: term 2–60, language en|ne|any, reason ≤200; term + language required", () => {
      const s = "createSmartDenyTerm";
      expect([bp(s, "term").minLength, bp(s, "term").maxLength]).toEqual([2, 60]);
      expect(bp(s, "language").enum).toEqual(["en", "ne", "any"]);
      expect(bp(s, "reason").maxLength).toBe(200);
      expect([...reqd(bodySchema(s))].sort()).toEqual(["language", "term"]);
    });
    T("#30 build: mode enum, required", () => {
      expect(bp("buildSmartSummary", "mode").enum).toEqual(["current", "rebuild_with_active_library"]);
      expect(reqd(bodySchema("buildSmartSummary"))).toEqual(["mode"]);
    });
    T("#31 approve: attestation must be true, use_llm_text default false", () => {
      expect(bp("approveSmartSummary", "attestation").enum).toEqual([true]);
      expect([bp("approveSmartSummary", "use_llm_text").type, bp("approveSmartSummary", "use_llm_text").default]).toEqual(["boolean", false]);
      expect(reqd(bodySchema("approveSmartSummary"))).toEqual(["attestation"]);
    });
    T("#32 reject: reason_code coded-set smartreport.summary_reject_reasons (no enum), comment ≤500; reason_code required", () => {
      coded(bp("rejectSmartSummary", "reason_code"), "smartreport.summary_reject_reasons");
      expect(bp("rejectSmartSummary", "comment").maxLength).toBe(500);
      expect(reqd(bodySchema("rejectSmartSummary"))).toEqual(["reason_code"]);
    });
    T("no request body names a server-authority field", () => {
      for (const id of Object.keys(ops))
        for (const f of ["tenant_id", "created_by", "approved_by", "approved_at", "status", "content_sha256", "version_no"])
          expect(keys(bodySchema(id) ?? {}), `${id}.${f}`).not.toContain(f);
    });
  });

  describe("response shapes (TRD §5.1)", () => {
    T("named DTO schemas are components, closed", () => {
      for (const n of DTOS) {
        expect(schema(n), n).toBeDefined();
        expect(schema(n).additionalProperties, `${n} closed`).toBe(false);
      }
    });
    T("paged list ops return {data, page} with the TRD item DTO", () => {
      for (const [id, dto] of Object.entries(LIST_PAGED)) {
        const s = okSchema(id);
        expect(keys(s), id).toEqual(expect.arrayContaining(["data", "page"]));
        expect(item(props(s).data), id).toEqual(deref(schema(dto)));
      }
    });
    T("unpaginated list ops return {data} only; blocks ≤500, rules ≤1000", () => {
      for (const [id, dto] of Object.entries(LIST_DATA)) {
        const s = okSchema(id);
        expect(keys(s), id).toEqual(["data"]);
        expect(item(props(s).data), id).toEqual(deref(schema(dto)));
      }
      expect(deref(props(okSchema("listSmartTemplateBlocks")).data).maxItems).toBe(500);
      expect(deref(props(okSchema("listSmartRules")).data).maxItems).toBe(1000);
    });
    T("single-object ops return (at least) the properties of their DTO", () => {
      for (const [id, dto] of Object.entries(ONE)) expect(keys(okSchema(id)), id).toEqual(expect.arrayContaining(keys(schema(dto))));
    });
    T("#14 and #30 declare both of their success statuses with the DTO", () => {
      for (const c of ["200", "201"]) {
        expect(keys(okSchema("putSmartAnalyteGroup", c)), `#14 ${c}`).toEqual(expect.arrayContaining(keys(schema("AnalyteGroup"))));
        expect(keys(okSchema("buildSmartSummary", c)), `#30 ${c}`).toEqual(expect.arrayContaining(keys(schema("SmartSummaryView"))));
      }
    });
    T("LibraryVersionSummary fields exactly; approved_* optional", () => {
      expect(sorted(schema("LibraryVersionSummary"))).toEqual(["approved_at", "approved_by_display_name", "approved_by_membership_id", "id", "language", "status", "updated_at", "version", "version_no"].sort());
      expect(reqd(schema("LibraryVersionSummary"))).toEqual(expect.arrayContaining(["id", "version_no", "status", "language", "updated_at", "version"]));
      for (const f of ["approved_at", "approved_by_membership_id", "approved_by_display_name"]) expect(reqd(schema("LibraryVersionSummary")), f).not.toContain(f);
      expect(prop("LibraryVersionSummary", "status").enum).toEqual(["draft", "in_review", "approved", "retired"]);
    });
    T("LibraryVersion fields exactly; params = LibraryParams; counts shape; formula_version hs-1", () => {
      expect(sorted(schema("LibraryVersion"))).toEqual(["id", "version_no", "status", "language", "formula_version", "params", "source_version_id", "change_summary", "content_sha256",
        "submitted_at", "submitted_by_membership_id", "approved_at", "approved_by_membership_id", "approved_by_display_name", "approval_note", "returned_at", "return_comment",
        "retired_at", "counts", "version", "created_at", "updated_at"].sort());
      expect(sorted(prop("LibraryVersion", "params"))).toEqual([...PARAM_KEYS].sort());
      expect(sorted(prop("LibraryVersion", "counts"))).toEqual(["analyte_groups", "blocks", "groups_shown", "rules"]);
      expect(prop("LibraryVersion", "language").enum).toEqual(["en", "ne"]);
      expect(prop("LibraryVersion", "formula_version").enum).toEqual(["hs-1"]);
      expect(prop("LibraryVersion", "status").enum).toEqual(["draft", "in_review", "approved", "retired"]);
      expect(reqd(schema("LibraryVersion"))).toEqual(expect.arrayContaining(["id", "version_no", "status", "language", "formula_version", "params", "counts", "version", "created_at", "updated_at"]));
      for (const f of ["source_version_id", "change_summary", "content_sha256", "approved_at", "approval_note", "returned_at", "return_comment", "retired_at"]) expect(reqd(schema("LibraryVersion")), f).not.toContain(f);
    });
    T("TemplateBlock fields exactly; placeholders string[]; text/note optional", () => {
      expect(sorted(schema("TemplateBlock"))).toEqual(["block_key", "id", "kind", "note", "placeholders", "text_en", "text_ne", "updated_at", "version"]);
      expect(prop("TemplateBlock", "placeholders").type).toBe("array");
      expect(deref(prop("TemplateBlock", "placeholders").items).type).toBe("string");
      for (const f of ["text_en", "text_ne", "note"]) expect(reqd(schema("TemplateBlock")), f).not.toContain(f);
      expect(reqd(schema("TemplateBlock"))).toEqual(expect.arrayContaining(["id", "block_key", "kind", "placeholders", "version", "updated_at"]));
    });
    T("Rule = rule input fields + id + version", () => {
      expect(sorted(schema("Rule"))).toEqual(["analyte_id", "block_id", "direction", "group_code", "id", "interval_days", "min_severity", "priority", "rule_kind", "suggested_test_id",
        "trigger_kind", "version"]);
      expect(reqd(schema("Rule"))).toEqual(expect.arrayContaining(["id", "version", "rule_kind", "trigger_kind", "direction", "block_id"]));
    });
    T("AnalyteGroup and GroupSetting fields exactly", () => {
      expect(sorted(schema("AnalyteGroup"))).toEqual(["analyte_id", "borderline_fraction_bp", "group_code", "include_in_score", "sort_order", "trend_enabled", "trend_stable_bp", "version"]);
      for (const f of ["borderline_fraction_bp", "trend_stable_bp"]) expect(reqd(schema("AnalyteGroup")), f).not.toContain(f);
      expect(sorted(schema("GroupSetting"))).toEqual(["display_en", "display_ne", "group_code", "is_shown", "score_weight", "sort_order", "version"]);
      expect(reqd(schema("GroupSetting"))).not.toContain("display_ne");
    });
    T("#18 validate response {valid, issues[]}; issue code/severity/detail ≤200, optional path/block_key/rule_id/analyte_id", () => {
      const s = okSchema("validateSmartLibraryVersion");
      expect(sorted(s)).toEqual(["issues", "valid"]);
      expect(reqd(s).sort()).toEqual(["issues", "valid"]);
      const i = item(props(s).issues);
      expect(Object.keys(props(i)).sort()).toEqual(["analyte_id", "block_key", "code", "detail", "path", "rule_id", "severity"]);
      expect(deref(props(i).severity).enum).toEqual(["error", "warning"]);
      expect(deref(props(i).detail).maxLength).toBe(200);
      expect(reqd(i)).toEqual(expect.arrayContaining(["code", "severity", "detail"]));
      for (const f of ["path", "block_key", "rule_id", "analyte_id"]) expect(reqd(i), f).not.toContain(f);
    });
    T("#22 preview response: SmartSummaryView fields with no required `id`, status includes preview, unmapped_result_count + ignored_duplicate_count", () => {
      const s = okSchema("previewSmartLibraryVersion");
      expect(keys(s)).toEqual(expect.arrayContaining(["status", "unmapped_result_count", "ignored_duplicate_count", "panels", "deranged", "disclaimer_text", "reviews"]));
      expect(reqd(s)).not.toContain("id");
      expect(deref(props(s).status).enum).toContain("preview");
    });
    T("#23 / #24 / #25 deny term: {id?, term, language, scope, reason?, is_active, version?}; list is {data} only", () => {
      const l = okSchema("listSmartDenyTerms");
      expect(keys(l)).toEqual(["data"]);
      const t = item(props(l).data);
      expect(Object.keys(props(t)).sort()).toEqual(["id", "is_active", "language", "reason", "scope", "term", "version"]);
      expect(deref(props(t).scope).enum).toEqual(["global", "tenant"]);
      expect(deref(props(t).language).enum).toEqual(["en", "ne", "any"]);
      for (const f of ["id", "reason", "version"]) expect(reqd(t), f).not.toContain(f);
      expect(reqd(t)).toEqual(expect.arrayContaining(["term", "language", "scope", "is_active"]));
      for (const id of ["createSmartDenyTerm", "deactivateSmartDenyTerm"]) expect(keys(okSchema(id)), id).toEqual(expect.arrayContaining(Object.keys(props(t))));
    });
    T("#26 / #35 coded set: {set_code, items[{code, display, sort_order, is_active}]}", () => {
      for (const id of ["getSmartCodedSet", "getSmartLibraryCodedSet"]) {
        const s = okSchema(id);
        expect(sorted(s), id).toEqual(["items", "set_code"]);
        expect(Object.keys(props(item(props(s).items))).sort(), id).toEqual(["code", "display", "is_active", "sort_order"]);
      }
    });
    T("SmartSummaryListItem fields exactly; health_score_band + patient_display_name optional", () => {
      expect(sorted(schema("SmartSummaryListItem"))).toEqual(["built_at", "centre_id", "critical_count", "deranged_count", "health_score_band", "id", "order_id", "patient_display_name",
        "registration_no", "status", "version"]);
      for (const f of ["health_score_band", "patient_display_name"]) expect(reqd(schema("SmartSummaryListItem")), f).not.toContain(f);
      expect(reqd(schema("SmartSummaryListItem"))).toEqual(expect.arrayContaining(["id", "order_id", "centre_id", "status", "built_at", "deranged_count", "critical_count", "registration_no", "version"]));
      expect(prop("SmartSummaryListItem", "status").enum).toEqual(["draft", "approved", "rejected", "superseded"]);
    });
    T("SmartSummaryView fields exactly; status enum; optional approval/reject/supersede/health/review fields", () => {
      const v = "SmartSummaryView";
      expect(sorted(schema(v))).toEqual(["id", "order_id", "centre_id", "status", "library_version_id", "template_library_version", "formula_version", "language", "built_at",
        "report_version_nos", "approved_at", "approved_by_membership_id", "approved_by_display_name", "rejected_at", "rejected_by_display_name", "reject_reason_code", "reject_comment",
        "superseded_at", "superseded_reason", "superseded_by_summary_id", "health_score", "panels", "deranged", "advice", "follow_ups", "trends", "disclaimer_block_id",
        "disclaimer_text", "counts", "llm", "registration_no", "patient_display_name", "review_inputs", "reviews", "version"].sort());
      expect(prop(v, "status").enum).toEqual(["draft", "approved", "rejected", "superseded", "preview"]);
      expect(reqd(schema(v))).toEqual(expect.arrayContaining(["id", "order_id", "centre_id", "status", "library_version_id", "built_at", "panels", "deranged", "advice", "follow_ups", "trends",
        "disclaimer_text", "counts", "llm", "registration_no", "reviews", "version"]));
      for (const f of ["approved_at", "approved_by_membership_id", "approved_by_display_name", "rejected_at", "rejected_by_display_name", "reject_reason_code", "reject_comment", "superseded_at",
        "superseded_reason", "superseded_by_summary_id", "health_score", "patient_display_name", "review_inputs"]) expect(reqd(schema(v)), f).not.toContain(f);
    });
    T("SmartSummaryView nested shapes (health_score, panels, deranged, advice, follow_ups, trends, counts, llm, review_inputs, reviews)", () => {
      const v = "SmartSummaryView";
      const hs = prop(v, "health_score");
      expect(Object.keys(props(hs)).sort()).toEqual(["band", "explanation_text", "formula_version", "panels_scored", "value"]);
      expect(reqd(hs).sort()).toEqual(["band", "formula_version", "panels_scored", "value"]);
      expect(Object.keys(props(item(prop(v, "panels")))).sort()).toEqual(["display_name", "panel_code", "result_ids", "status"]);
      const d = item(prop(v, "deranged"));
      expect(Object.keys(props(d)).sort()).toEqual(["analyte_id", "analyte_name", "direction", "llm_text", "result_id", "severity", "template_block_id", "text"]);
      expect(reqd(d)).not.toContain("llm_text");
      const a = item(prop(v, "advice"));
      expect(Object.keys(props(a)).sort()).toEqual(["llm_text", "template_block_id", "text"]);
      expect(reqd(a)).not.toContain("llm_text");
      const f = item(prop(v, "follow_ups"));
      expect(Object.keys(props(f)).sort()).toEqual(["interval_days", "llm_text", "rule_id", "suggested_test_code", "suggested_test_name", "text"]);
      expect(reqd(f)).not.toContain("llm_text");
      const t = item(prop(v, "trends"));
      expect(Object.keys(props(t)).sort()).toEqual(["analyte_id", "analyte_name", "direction", "point_result_ids", "points", "unit_code"]);
      expect(Object.keys(props(item(props(t).points))).sort()).toEqual(["approved_at", "result_id", "value_numeric"]);
      expect(Object.keys(props(prop(v, "counts"))).sort()).toEqual(["critical", "deranged", "ignored_duplicates", "unmapped_results"]);
      const llm = prop(v, "llm");
      expect(Object.keys(props(llm)).sort()).toEqual(["enabled", "last_run_id", "use_llm_text"]);
      expect(reqd(llm)).not.toContain("last_run_id");
      const ri = item(prop(v, "review_inputs"));
      expect(Object.keys(props(ri)).sort()).toEqual(["analyte_id", "analyte_name", "band_status", "flag", "group_code", "ref_range_text", "result_id", "unit_code", "value_text"]);
      const rv = item(prop(v, "reviews"));
      expect(Object.keys(props(rv)).sort(), "comment is not included (08 A22.1)").toEqual(["action", "actor_display_name", "at", "reason_code"]);
      expect(deref(props(rv).action).enum).toEqual(["approved", "rejected", "superseded", "llm_rephrase_requested"]);
      expect(reqd(rv)).toEqual(expect.arrayContaining(["action", "at"]));
      expect(reqd(rv)).not.toContain("actor_display_name");
    });
    T("#33 response 202 {summary_id, requested_at}; #34 {data: [{id, status, prompt_template_version, model_ref, items[], latency_ms?, created_at}]}", () => {
      expect(sorted(okSchema("requestSmartLlmRephrase"))).toEqual(["requested_at", "summary_id"]);
      const l = okSchema("listSmartLlmRuns");
      expect(keys(l)).toEqual(["data"]);
      const r = item(props(l).data);
      expect(Object.keys(props(r)).sort()).toEqual(["created_at", "id", "items", "latency_ms", "model_ref", "prompt_template_version", "status"]);
      expect(reqd(r)).not.toContain("latency_ms");
      expect(Object.keys(props(item(props(r).items))).sort()).toEqual(["failure_codes", "item_ref", "output_text", "passed", "template_text"]);
      expect(reqd(item(props(r).items))).not.toContain("output_text");
    });
    T("no schema names tenant_id (library objects are tenant-wide; scope is the token, not the wire)", () => {
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
    T("privileged permissions (template.approve, summary.approve) always list auth.mfa_required", () => {
      for (const [id, { op }] of Object.entries(ops))
        if ([TA, SA].includes(op["x-permission"])) expect(op["x-error-codes"], id).toContain(MFA);
    });
  });

  describe("synthetic examples and offline 'Prism smoke' (AC-0C-1.4)", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...doc, id: "smartreport.yaml" });
    const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    const check = (ptr: string, example: unknown) => {
      const validate = ajv.getSchema(`smartreport.yaml#${ptr}`);
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
      expect(n).toBeGreaterThanOrEqual(30);
    });
    it("every operation with a JSON 2xx response has an example Prism can serve", () => {
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
    it("package.json has `mock:smartreport` = prism mock contracts/openapi/smartreport.yaml on a port no other mock uses", () => {
      const scripts: Record<string, string> = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
      const mine = scripts["mock:smartreport"];
      expect(mine, "mock:smartreport script missing").toBeDefined();
      const m = /^prism mock contracts\/openapi\/smartreport\.yaml --host 127\.0\.0\.1 --port (\d+)$/.exec(mine);
      expect(m, mine).not.toBeNull();
      const ports = Object.entries(scripts).filter(([k]) => k.startsWith("mock:") && k !== "mock:smartreport" && k !== "mock:list")
        .map(([, v]) => /--port (\d+)/.exec(v)?.[1]);
      expect(ports).not.toContain(m![1]);
    });
  });
});
