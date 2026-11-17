// T0C-10.C11 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/anatomic.yaml (C11 transcription of spec/chunks/C11-specialty-pathology/02-TRD.md §5, §5.1–5.7; LD-103).
// Checks: (1) exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) clean for anatomic.yaml; (3) AC-0C-1.5 negatives on a temp copy;
// (4) anatomic = TRD §5 tables (70 ops A1–A12 M1–M15 R1–R10 I1–I4 Q1–Q7 K1–K22), method+path under /v1/anatomic, x-permission (one code), bearerJwt,
//     x-idempotency (R = required, – = none; no "optional"), tier general, success status, specific + common codes, Idempotency-Key / If-Match, MFA on (P) rows;
// (5) shape pins from §5.1–5.7 (query params, enums, bounds, coded sets without enum, DTO allowlists, multipart I1, binary image I2, no tenant_id/created_by/updated_by);
// (6) "Prism smoke" offline: examples validate (ajv), every JSON 2xx has an example, examples synthetic; (7) package.json `mock:anatomic` script.
// Not testable here: Prism actually serving the file (prism not installed), generated-client freshness (codegen-fresh suite), runtime mappers (REQ-SEC-081), RLS 404s.
// Assumptions (TRD silent or ambiguous; also in the notes file):
//  - the eight "always-possible" codes of TRD §5 intro (validation_failed, not_found, unauthenticated, forbidden, account_locked, session_expired, rate_limited, internal) are on every op;
//    IDEM codes (3) on R rows only; precondition_required + version_conflict on the If-Match rows only; auth.mfa_required on every (P) row (case.signout, config.manage);
//  - "(CR)" suffixes in the TRD are provenance, not part of the code name; common.invalid_cursor pinned only where the TRD row lists it (A1 M6 M12 Q2);
//  - x-coded-set names follow the wave-1 `<module>.<set>` form: anatomic.cancel_reasons, anatomic.stains, anatomic.cytology_adequacy, anatomic.diagnoses (TRD gives the bare set name);
//    R4 reason_code is a pattern only (TRD: "C11 checks the format only"), NOT a coded set; M11 reason_code is an enum (TRD lists the five values);
//  - success status pinned: 200 on GET, 201 on A6 M1 M2 M5 R4 R8 I1 Q3 K4 K9 K14 K19 K21, 204 on R5; other ops "some 2xx";
//  - 5.7 DTOs are pinned by the property allowlist of the operation's 2xx schema (component names are free); `X = Y + {...}` rows pinned as superset of Y;
//    ReportVersion content columns (05-SCHEMA §5 shapes) are not pinned beyond the summary fields;
//  - I1 `x-upload` = [image/png, image/jpeg], 15 MB cap (15728640) stated somewhere in the operation; I2 returns image/png + image/jpeg with the five security headers;
//  - no operation is public: no x-public, security [{bearerJwt: []}] everywhere.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRD = join(ROOT, "spec/chunks/C11-specialty-pathology/02-TRD.md");
const FILE = join(ROOT, "contracts/openapi/anatomic.yaml");
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const METHODS = ["get", "put", "post", "delete", "patch"];
const name = "anatomic";
const PFX = "/v1/anatomic";

const CR = "anatomic.case.read", CW = "anatomic.case.work", CS = "anatomic.case.signout", CM = "anatomic.config.manage";
const VC = "common.version_conflict", PRE = "common.precondition_required", CUR = "common.invalid_cursor", MFA = "auth.mfa_required", IMM = "common.immutable_record";
const IDEM = ["common.idempotency_key_required", "common.idempotency_key_reused", "common.idempotency_in_progress"];
const EIGHT = ["common.validation_failed", "common.not_found", "auth.unauthenticated", "auth.forbidden", "auth.account_locked", "auth.session_expired", "common.rate_limited", "common.internal"];
const CIT = "anatomic.case_invalid_transition", SOL = "anatomic.signout_locked", API = "anatomic.accession_pattern_invalid", ADU = "anatomic.accession_duplicate";
const BNA = "anatomic.block_not_available", IRB = "anatomic.ihc_requires_block", OII = "anatomic.order_item_inactive", TNP = "anatomic.template_not_published";
const ILR = "anatomic.image_limit_reached", RI = "anatomic.report_incomplete", TI = "anatomic.template_invalid", BC = "anatomic.batch_closed", BPT = "anatomic.batch_position_taken";
const LAB = ["lab.module_result_invalid", "lab.result_locked", "lab.result_invalid_transition", "lab.module_result_stale", "lab.amendment_reason_required"];
const PTL = "common.payload_too_large", UMT = "common.unsupported_media_type", UQ = "common.upload_quarantined";

type Spec = { id: string; opId: string; method: string; path: string; perm: string; idem: "none" | "required"; status: number[]; err: string[]; im: boolean; mfa: boolean; paged?: boolean };
const GET = [200];
// S(row, opId, "METHOD path", perm, idem(R|-), status, extra errors, If-Match?)
const S = (id: string, opId: string, mp: string, perm: string, idem: "R" | "-", status: number[], err: string[] = [], im = false): Spec => {
  const [method, path] = mp.split(" ");
  return { id, opId, method, path, perm, idem: idem === "R" ? "required" : "none", status, err, im, mfa: perm === CS || perm === CM, paged: undefined };
};
const SPECS: Spec[] = [
  S("A1", "listAnatomicCases", "GET /cases", CR, "-", GET, [CUR]),
  S("A2", "lookupAnatomicObject", "POST /cases/lookup", CR, "-", []),
  S("A3", "getAnatomicCase", "GET /cases/{case_id}", CR, "-", GET),
  S("A4", "accessionAnatomicCase", "POST /cases/{case_id}/accession", CW, "R", [], [CIT, API, ADU], true),
  S("A5", "updateAnatomicCaseDetails", "PUT /cases/{case_id}/details", CW, "-", [], [SOL], true),
  S("A6", "addAnatomicPart", "POST /cases/{case_id}/parts", CW, "R", [201], [CIT, SOL]),
  S("A7", "updateAnatomicPart", "PUT /cases/{case_id}/parts/{part_id}", CW, "-", [], [SOL], true),
  S("A8", "saveAnatomicGross", "PUT /cases/{case_id}/parts/{part_id}/gross", CW, "-", [], [CIT, SOL], true),
  S("A9", "startAnatomicProcessing", "POST /cases/{case_id}/start-processing", CW, "R", [], [CIT], true),
  S("A10", "markAnatomicCaseReady", "POST /cases/{case_id}/mark-ready", CW, "R", [], [CIT], true),
  S("A11", "cancelAnatomicCase", "POST /cases/{case_id}/cancel", CW, "R", [], [CIT], true),
  S("A12", "listAnatomicAssignees", "GET /assignees", CR, "-", GET),
  S("M1", "createAnatomicBlocks", "POST /cases/{case_id}/blocks", CW, "R", [201], [CIT, SOL]),
  S("M2", "createAnatomicSlides", "POST /cases/{case_id}/slides", CW, "R", [201], [BNA, CIT]),
  S("M3", "markAnatomicSlidesReady", "POST /slides/bulk-mark-ready", CW, "R", []),
  S("M4", "saveAnatomicSlideAssessment", "PUT /slides/{slide_id}/assessment", CW, "-", [], [SOL], true),
  S("M5", "createAnatomicStainOrder", "POST /cases/{case_id}/stain-orders", CW, "R", [201], [IRB, BNA, OII]),
  S("M6", "listAnatomicStainOrders", "GET /stain-orders", CR, "-", GET, [CUR]),
  S("M7", "startAnatomicStainOrder", "POST /stain-orders/{stain_order_id}/start", CW, "R", [], [CIT], true),
  S("M8", "completeAnatomicStainOrder", "POST /stain-orders/{stain_order_id}/complete", CW, "R", [], [BNA, CIT], true),
  S("M9", "cancelAnatomicStainOrder", "POST /stain-orders/{stain_order_id}/cancel", CW, "R", [], [CIT], true),
  S("M10", "linkAnatomicAddonItem", "POST /stain-orders/{stain_order_id}/link-addon", CW, "R", [], [OII], true),
  S("M11", "recordAnatomicMovements", "POST /movements", CW, "R", []),
  S("M12", "listAnatomicBlocks", "GET /blocks", CR, "-", GET, [CUR]),
  S("M13", "listAnatomicBlockMovements", "GET /blocks/{block_id}/movements", CR, "-", GET),
  S("M14", "listAnatomicSlideMovements", "GET /slides/{slide_id}/movements", CR, "-", GET),
  S("M15", "getAnatomicLabels", "GET /cases/{case_id}/labels", CW, "-", GET),
  S("R1", "getAnatomicReportDraft", "GET /cases/{case_id}/report-draft", CR, "-", GET),
  S("R2", "saveAnatomicReportDraft", "PUT /cases/{case_id}/report-draft", CW, "-", [], [SOL, TNP, ILR], true),
  S("R3", "signOutAnatomicCase", "POST /cases/{case_id}/sign-out", CS, "R", [], [CIT, RI, OII, ...LAB], true),
  S("R4", "startAnatomicCaseChange", "POST /cases/{case_id}/changes", CS, "R", [201], [CIT], true),
  S("R5", "discardAnatomicCaseChange", "POST /cases/{case_id}/changes/discard", CS, "R", [204], [CIT], true),
  S("R6", "listAnatomicReportVersions", "GET /cases/{case_id}/versions", CR, "-", GET),
  S("R7", "getAnatomicReportVersion", "GET /cases/{case_id}/versions/{version_no}", CR, "-", GET),
  S("R8", "createAnatomicAddendum", "POST /cases/{case_id}/addenda", CW, "R", [201], [CIT]),
  S("R9", "updateAnatomicAddendum", "PUT /addenda/{addendum_id}", CW, "-", [], [SOL], true),
  S("R10", "signAnatomicAddendum", "POST /addenda/{addendum_id}/sign", CS, "R", [], [CIT, RI, OII, ...LAB], true),
  S("I1", "uploadAnatomicImage", "POST /cases/{case_id}/images", CW, "R", [201], [PTL, UMT, ILR]),
  S("I2", "getAnatomicImageContent", "GET /images/{image_id}/content", CR, "-", GET, [UQ]),
  S("I3", "updateAnatomicImage", "PUT /images/{image_id}", CW, "-", [], [SOL], true),
  S("I4", "deactivateAnatomicImage", "POST /images/{image_id}/deactivate", CW, "R", [], [], true),
  S("Q1", "saveAnatomicMolecularResults", "PUT /cases/{case_id}/molecular-results", CW, "-", [], [SOL, CIT], true),
  S("Q2", "listAnatomicBatches", "GET /batches", CR, "-", GET, [CUR]),
  S("Q3", "createAnatomicBatch", "POST /batches", CW, "R", [201]),
  S("Q4", "getAnatomicBatch", "GET /batches/{batch_id}", CR, "-", GET),
  S("Q5", "addAnatomicBatchMembers", "POST /batches/{batch_id}/members", CW, "R", [], [BC, BPT]),
  S("Q6", "removeAnatomicBatchMembers", "POST /batches/{batch_id}/members/remove", CW, "R", [], [BC], true),
  S("Q7", "closeAnatomicBatch", "POST /batches/{batch_id}/close", CW, "R", [], [BC], true),
  S("K1", "getAnatomicSettings", "GET /settings", CR, "-", GET),
  S("K2", "updateAnatomicSettings", "PUT /settings", CM, "-", [], [], true),
  S("K3", "listAnatomicStains", "GET /stains", CR, "-", GET),
  S("K4", "createAnatomicStain", "POST /stains", CM, "R", [201]),
  S("K5", "updateAnatomicStain", "PUT /stains/{stain_id}", CM, "-", [], [], true),
  S("K6", "listAnatomicTestProfiles", "GET /test-profiles", CR, "-", GET),
  S("K7", "upsertAnatomicTestProfile", "PUT /test-profiles/{test_id}", CM, "-", [], [], true),
  S("K8", "listAnatomicAssays", "GET /assays", CR, "-", GET),
  S("K9", "createAnatomicAssay", "POST /assays", CM, "R", [201]),
  S("K10", "updateAnatomicAssay", "PUT /assays/{assay_id}", CM, "-", [], [], true),
  S("K11", "listAnatomicCodedValues", "GET /coded-sets/{set_name}/values", CR, "-", GET),
  S("K12", "upsertAnatomicCodedValue", "PUT /coded-sets/{set_name}/values/{code}", CM, "-", [], [], true),
  S("K13", "listAnatomicSynopticTemplates", "GET /synoptic-templates", CR, "-", GET),
  S("K14", "createAnatomicSynopticTemplate", "POST /synoptic-templates", CM, "R", [201], [TI]),
  S("K15", "getAnatomicSynopticTemplate", "GET /synoptic-templates/{template_id}", CR, "-", GET),
  S("K16", "updateAnatomicSynopticTemplate", "PUT /synoptic-templates/{template_id}", CM, "-", [], [TI, IMM, TNP], true),
  S("K17", "publishAnatomicSynopticTemplate", "POST /synoptic-templates/{template_id}/publish", CM, "R", [], [IMM, TNP], true),
  S("K18", "retireAnatomicSynopticTemplate", "POST /synoptic-templates/{template_id}/retire", CM, "R", [], [IMM, TNP], true),
  S("K19", "createAnatomicSynopticTemplateVersion", "POST /synoptic-templates/{template_id}/new-version", CM, "R", [201], [IMM, TNP]),
  S("K20", "listAnatomicTextTemplates", "GET /text-templates", CR, "-", GET),
  S("K21", "createAnatomicTextTemplate", "POST /text-templates", CM, "R", [201]),
  S("K22", "updateAnatomicTextTemplate", "PUT /text-templates/{text_template_id}", CM, "-", [], [], true),
];
const TOTAL = 70;
const NO_BODY = ["A9", "A10", "M7", "I4", "Q7", "K17", "K18", "K19"]; // TRD request column: If-Match only, or "—"
const CASE_KINDS = ["histology", "cytology", "ihc", "molecular"];
const SECTIONS = ["gross", "microscopy", "impression", "comment", "addendum"];
const LOC = ["in_lab", "stored", "sent_out", "discarded"];
const MOVES = ["stored", "retrieved", "sent_out", "returned", "discarded"];
const PHI_PARAMS = ["barcode", "label", "accession_no", "registration_no", "patient_id", "patient_name", "patient_display_name", "phone", "phone_e164", "email", "full_name", "name", "sample_barcode"];
const FORBIDDEN_ANY = ["tenant_id", "created_by", "updated_by"];

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("anatomic.yaml (T0C-10.C11)", () => {
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
  const sorted = (s: any) => keys(s).sort();
  const bodySchema = (id: string) => deref(ops[id]?.op.requestBody?.content?.["application/json"]?.schema);
  const bp = (id: string, f: string) => deref(props(bodySchema(id))[f]);
  const params = (id: string) => (ops[id]?.op.parameters ?? []).map(deref);
  const param = (id: string, pname: string) => params(id).find((q: any) => q?.name === pname);
  const pschema = (id: string, pname: string) => deref(param(id, pname)?.schema);
  const names = (id: string) => params(id).filter((q: any) => q?.in === "query").map((q: any) => q.name);
  const okResp = (id: string, code?: string) => {
    const [, r] = Object.entries<any>(ops[id].op.responses).find(([c]) => (code ? c === code : /^2/.test(c)))!;
    return deref(r);
  };
  const okSchema = (id: string, code?: string) => deref(okResp(id, code).content?.["application/json"]?.schema);
  const has = (id: string) => expect(ops[id], `${id} missing`).toBeDefined();
  const ex = () => expect(existsSync(FILE), "contracts/openapi/anatomic.yaml missing").toBe(true);
  const T = (title: string, fn: () => void) => it(title, () => { ex(); fn(); });
  const coded = (s: any, set: string) => {
    expect(s?.["x-coded-set"], "x-coded-set").toBe(set);
    expect(s.enum, "coded-set field must not declare enum").toBeUndefined();
  };
  const item = (s: any) => deref(deref(s).items);
  const int = (s: any, min: number, max: number) => expect([s?.type, s?.minimum, s?.maximum]).toEqual(["integer", min, max]);
  const str = (s: any, min: number | undefined, max: number) => expect([s?.type, s?.minLength, s?.maxLength]).toEqual(["string", min, max]);
  const arr = (s: any, min: number | undefined, max: number) => expect([s?.type, s?.minItems, s?.maxItems]).toEqual(["array", min, max]);
  const walk = (s: any, fn: (n: any) => void, seen = new Set<any>()) => {
    const n = deref(s);
    if (!n || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    fn(n);
    for (const a of [...(n.allOf ?? []), ...(n.oneOf ?? []), ...(n.anyOf ?? [])]) walk(a, fn, seen);
    for (const q of Object.values(n.properties ?? {})) walk(q, fn, seen);
    if (n.items) walk(n.items, fn, seen);
  };
  // every key in `want` is a property; every key in `optional` is a property and not required
  const shape = (s: any, want: string[], optional: string[], label: string, exact = true) => {
    if (exact) expect([...new Set([...keys(s)])].sort(), label).toEqual([...want].sort());
    else expect(keys(s), label).toEqual(expect.arrayContaining(want));
    for (const f of optional) expect(reqd(s), `${label}.${f}`).not.toContain(f);
    for (const f of want.filter((x) => !optional.includes(x))) expect(reqd(s), `${label}.${f}`).toContain(f);
  };
  const enumOf = (s: any, vals: string[], label: string) => expect(deref(s)?.enum, label).toEqual(vals);
  const wrap = (id: string, inner: string[], paged: boolean) => {
    const s = okSchema(id);
    expect(sorted(s), id).toEqual(paged ? ["data", "page"] : inner.length ? [...inner].sort() : ["data"]);
    return s;
  };

  describe("exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
    it("file exists", () => expect(existsSync(FILE), "contracts/openapi/anatomic.yaml missing").toBe(true));
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
      const dir = mkdtempSync(join(tmpdir(), "c11-anatomic-lint-"));
      tmps.push(dir);
      cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
      const d = parse(readFileSync(FILE, "utf8"));
      fn(d);
      writeFileSync(join(dir, "contracts/openapi/anatomic.yaml"), stringify(d, { aliasDuplicateObjects: false }));
      return (await lintRepo(dir)).filter((x) => x.file === name);
    };
    const firstOp = (d: any, pred: (o: any) => boolean) =>
      Object.values<any>(d.paths).flatMap((q) => METHODS.map((m) => q[m]).filter(Boolean)).find(pred);

    it("x-permission not in permissions.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = "anatomic.no_such.permission"; });
      expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
    });
    it("x-error-codes entry not in errors.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push("anatomic.no_such_error"); });
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

  describe("anatomic equals 02-TRD §5 (no missing, no extra operations)", () => {
    it(`${TOTAL} operations; table ids unique; file has exactly these`, () => {
      expect(SPECS.length).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.id)).size).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.opId)).size).toBe(TOTAL);
      expect(Object.keys(ops).sort()).toEqual(SPECS.map((s) => s.opId).sort());
    });
    it("TRD drift guard: §5.1–5.6 tables = test table (operationId, method + path, permission, Idem, privileged)", () => {
      const all = readFileSync(TRD, "utf8").split("\n");
      const start = all.findIndex((l) => l.startsWith("## 5. HTTP endpoints"));
      const end = all.findIndex((l, k) => k > start && l.startsWith("### 5.7 "));
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const rows = new Map<string, { opId: string; mp: string; perm: string; idem: string; priv: boolean }>();
      for (const l of all.slice(start, end)) {
        const c = l.split("|");
        const m = /^\s*([AMRIQK]\d+)\s*$/.exec(c[1] ?? "");
        if (!m) continue;
        const opId = /^\s*`([a-z][A-Za-z0-9]+)`/.exec(c[3] ?? "")?.[1] ?? "";
        const mp = /^\s*([A-Z]+)\s+`([^`]+)`/.exec(c[2] ?? "");
        const perm = /^\s*((?:case\.(?:read|work|signout))|config\.manage)/.exec(c[4] ?? "")?.[1];
        const idemCell = (c[5] ?? "").replace(/\*/g, "").trim();
        rows.set(m[1], { opId, mp: `${mp?.[1]} ${mp?.[2]}`, perm: perm ? `anatomic.${perm}` : "", idem: /^R\b/.test(idemCell) ? "R" : /^(—|–|-)/.test(idemCell) ? "-" : idemCell, priv: /\(P\)/.test(c[4] ?? "") });
      }
      expect(rows.size, "rows parsed from TRD").toBe(TOTAL);
      for (const s of SPECS) {
        const r = rows.get(s.id);
        expect(r?.opId, `${s.id} id`).toBe(s.opId);
        expect(r?.mp, `${s.id} method+path`).toBe(`${s.method} ${s.path}`);
        expect(r?.perm, `${s.id} permission`).toBe(s.perm);
        expect(r?.idem, `${s.id} idem`).toBe(s.idem === "required" ? "R" : "-");
        expect(r?.priv, `${s.id} (P)`).toBe(s.mfa);
      }
    });
    T("every path is /v1/anatomic/… with tags [anatomic]; no PHI path or query params (REQ-SEC-098; A2 takes the label in the body)", () => {
      expect(Object.keys(doc.paths ?? {}).length, "no paths").toBeGreaterThan(0);
      for (const [q, it_] of Object.entries<any>(doc.paths ?? {})) {
        expect(q.startsWith(`${PFX}/`), q).toBe(true);
        expect(q).not.toMatch(/\{(registration_no|barcode|sample_barcode|phone|patient_id|email|label|accession_no)\}/);
        for (const m of METHODS) if (it_[m]) expect(it_[m].tags, `${m} ${q}`).toEqual([name]);
      }
      for (const id of Object.keys(ops))
        for (const q of params(id)) if (q?.in === "query") expect(PHI_PARAMS, `${id}?${q.name}`).not.toContain(q.name);
    });
  });

  describe.each(SPECS)("$id $opId", (r) => {
    const o = ops[r.opId]?.op;
    it("exists at the TRD method + path", () => {
      has(r.opId);
      expect(`${ops[r.opId].method} ${ops[r.opId].path}`).toBe(`${r.method} ${PFX}${r.path}`);
    });
    it("has tags, summary, x-idempotency (TRD Idem: R = required, – = none), x-rate-limit-tier general, x-error-codes", () => {
      has(r.opId);
      expect(o.tags).toEqual([name]);
      expect(typeof o.summary).toBe("string");
      expect(o["x-idempotency"]).toBe(r.idem);
      expect(o["x-rate-limit-tier"]).toBe("general");
      expect(Array.isArray(o["x-error-codes"])).toBe(true);
    });
    it(`x-permission = ${r.perm} (one code), never x-public; security bearerJwt; tenant context only`, () => {
      has(r.opId);
      expect(o["x-permission"]).toBe(r.perm);
      expect(o["x-public"]).toBeUndefined();
      expect(o.security).toEqual([{ bearerJwt: [] }]);
      expect([undefined, "tenant"]).toContain(o["x-context"]);
    });
    it("success response status", () => {
      has(r.opId);
      const codes = Object.keys(o.responses ?? {});
      for (const c of r.status) expect(codes, `want ${c}`).toContain(String(c));
      expect(codes.some((c) => /^2/.test(c)), "some 2xx").toBe(true);
    });
    it("lists the TRD specific error codes plus the eight common codes (+ If-Match / idempotency / MFA sets by row)", () => {
      has(r.opId);
      const e = o["x-error-codes"];
      for (const c of [...EIGHT, ...r.err]) expect(e, c).toContain(c);
      if (r.im) for (const c of [PRE, VC]) expect(e, `If-Match op: ${c}`).toContain(c);
      else for (const c of [PRE, VC]) expect(e, `no If-Match on this op: ${c}`).not.toContain(c);
      if (r.idem === "required") for (const c of IDEM) expect(e, c).toContain(c);
      else for (const c of IDEM) expect(e, `no idempotency on this op: ${c}`).not.toContain(c);
      if (r.mfa) expect(e, "privileged (P) op").toContain(MFA);
      else expect(e, "non-privileged op").not.toContain(MFA);
      expect(e, "retired code must not be emitted (TRD §13)").not.toContain("anatomic.image_not_ready");
    });
    it("Idempotency-Key header on R rows, none elsewhere; If-Match on the If-Match rows only", () => {
      has(r.opId);
      const ps = JSON.stringify(o.parameters ?? []);
      if (r.idem === "required") expect(ps).toMatch(/IdempotencyKey|Idempotency-Key/);
      else expect(ps).not.toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.im) expect(ps).toMatch(/IfMatch|If-Match/);
      else expect(ps).not.toMatch(/IfMatch|If-Match/);
    });
  });

  describe("query and path parameters (TRD §5.1–5.6)", () => {
    T("list query parameter names", () => {
      expect(names("listAnatomicCases")).toEqual(expect.arrayContaining(["queue", "case_kind", "centre_id", "priority", "assigned_pathologist", "received_at_from", "received_at_to", "sort", "limit", "cursor"]));
      expect(names("listAnatomicAssignees").sort()).toEqual(["case_id", "limit", "q"]);
      expect(names("listAnatomicStainOrders")).toEqual(expect.arrayContaining(["status", "stain_kind", "centre_id", "sort", "limit", "cursor"]));
      expect(names("listAnatomicBlocks")).toEqual(expect.arrayContaining(["location_status", "case_id", "limit", "cursor"]));
      for (const id of ["listAnatomicBlockMovements", "listAnatomicSlideMovements"]) expect(names(id).sort(), id).toEqual(["cursor", "limit"]);
      expect(names("getAnatomicLabels").sort()).toEqual(["ids", "kind"]);
      expect(names("listAnatomicBatches").sort()).toEqual(["assay_code", "cursor", "limit", "status"]);
      expect(names("listAnatomicStains").sort()).toEqual(["include_inactive", "kind"]);
      expect(names("listAnatomicAssays")).toEqual(["include_inactive"]);
      expect(names("listAnatomicCodedValues").sort()).toEqual(["cursor", "include_inactive", "limit", "q"]);
      expect(names("listAnatomicSynopticTemplates").sort()).toEqual(["case_kind", "status"]);
      expect(names("listAnatomicTextTemplates").sort()).toEqual(["include_inactive", "section"]);
      for (const id of ["getAnatomicReportDraft", "listAnatomicReportVersions", "getAnatomicCase", "getAnatomicSettings", "listAnatomicTestProfiles"]) expect(names(id), id).toEqual([]);
    });
    T("A1 queue + sort enums, defaults, limit 1..200 (50), optional filters", () => {
      enumOf(pschema("listAnatomicCases", "queue"), ["to_accession", "grossing", "bench", "reporting", "awaiting_lab", "signed_out", "cancelled", "all"], "queue");
      expect(pschema("listAnatomicCases", "queue").default).toBe("all");
      enumOf(pschema("listAnatomicCases", "sort"), ["received_at", "-received_at", "accessioned_at", "-accessioned_at", "priority_received_at"], "sort");
      expect(pschema("listAnatomicCases", "sort").default).toBe("priority_received_at");
      const lim = pschema("listAnatomicCases", "limit");
      expect([lim.minimum, lim.maximum, lim.default]).toEqual([1, 200, 50]);
      for (const f of ["received_at_from", "received_at_to"]) expect(pschema("listAnatomicCases", f).format, f).toBe("date-time");
      for (const f of ["queue", "case_kind", "centre_id", "priority", "assigned_pathologist", "sort", "cursor", "limit"]) expect(param("listAnatomicCases", f).required, f).not.toBe(true);
    });
    T("M6 stain-order filters: status default `requested,in_progress`, sort enum, M12/M15/K-list enums", () => {
      expect(pschema("listAnatomicStainOrders", "status").default).toBe("requested,in_progress");
      enumOf(pschema("listAnatomicStainOrders", "sort"), ["requested_at", "-requested_at"], "sort");
      enumOf(pschema("getAnatomicLabels", "kind"), ["blocks", "slides"], "kind");
      expect(param("getAnatomicLabels", "ids").required).not.toBe(true);
      enumOf(pschema("listAnatomicTextTemplates", "section"), SECTIONS, "section");
      for (const [id, f] of [["listAnatomicStains", "include_inactive"], ["listAnatomicAssays", "include_inactive"], ["listAnatomicTextTemplates", "include_inactive"], ["listAnatomicCodedValues", "include_inactive"]] as const)
        expect(pschema(id, f).type, `${id}.${f}`).toBe("boolean");
    });
    T("A12 assignees: case_id uuid, q ≤60, limit 1..50 (20)", () => {
      expect(pschema("listAnatomicAssignees", "case_id").format).toBe("uuid");
      expect(pschema("listAnatomicAssignees", "q").maxLength).toBe(60);
      const lim = pschema("listAnatomicAssignees", "limit");
      expect([lim.minimum, lim.maximum, lim.default]).toEqual([1, 50, 20]);
    });
    T("K11 set_name path enum = diagnoses, cytology_adequacy, cancel_reasons (K12 too); q ≤60; K12 code pattern", () => {
      for (const id of ["listAnatomicCodedValues", "upsertAnatomicCodedValue"]) {
        expect(param(id, "set_name").in, id).toBe("path");
        enumOf(pschema(id, "set_name"), ["diagnoses", "cytology_adequacy", "cancel_reasons"], `${id}.set_name`);
      }
      expect(pschema("listAnatomicCodedValues", "q").maxLength).toBe(60);
      expect(param("upsertAnatomicCodedValue", "code").in).toBe("path");
      expect(pschema("upsertAnatomicCodedValue", "code").pattern).toBe("^[A-Za-z0-9_.:-]{1,64}$");
    });
    T("R7 version_no is an integer ≥ 1", () => expect(pschema("getAnatomicReportVersion", "version_no")).toMatchObject({ type: "integer", minimum: 1 }));
    T("path ids are required uuids", () => {
      for (const [id, f] of [["getAnatomicCase", "case_id"], ["updateAnatomicPart", "part_id"], ["saveAnatomicSlideAssessment", "slide_id"], ["startAnatomicStainOrder", "stain_order_id"],
        ["listAnatomicBlockMovements", "block_id"], ["updateAnatomicAddendum", "addendum_id"], ["getAnatomicImageContent", "image_id"], ["getAnatomicBatch", "batch_id"],
        ["updateAnatomicStain", "stain_id"], ["updateAnatomicAssay", "assay_id"], ["getAnatomicSynopticTemplate", "template_id"], ["updateAnatomicTextTemplate", "text_template_id"]] as const) {
        expect(param(id, f)?.in, `${id}:${f}`).toBe("path");
        expect(pschema(id, f)?.format, `${id}:${f}`).toBe("uuid");
      }
    });
    T("every path parameter is required", () => {
      for (const id of Object.keys(ops)) for (const q of params(id).filter((x: any) => x?.in === "path")) expect(q.required, `${id}:${q.name}`).toBe(true);
    });
  });

  describe("request bodies (TRD §5.1–5.6)", () => {
    T("ops with a body in the TRD have a JSON/multipart body; ops without one have none (A9 A10 M7 I4 Q7 K17 K18 K19 + GETs)", () => {
      for (const s of SPECS) {
        const rb = ops[s.opId].op.requestBody;
        if (s.method === "GET" || NO_BODY.includes(s.id)) expect(rb?.content?.["application/json"]?.schema && Object.keys(props(rb.content["application/json"].schema)).length, `${s.id} body`).toBeFalsy();
        else expect(rb?.content, `${s.id} body`).toBeDefined();
      }
    });
    T("A2 lookup: label ^[A-Z0-9-]{1,32}$ required, body not URL (REQ-SEC-098)", () => {
      const s = "lookupAnatomicObject";
      expect(bp(s, "label").pattern).toBe("^[A-Z0-9-]{1,32}$");
      expect(reqd(bodySchema(s))).toEqual(["label"]);
      expect(keys(bodySchema(s))).toEqual(["label"]);
    });
    T("A4 accession: parts 1..52 {part_id, site_text 1..200, description_text ≤1000}; history ≤4000; parts required", () => {
      const s = "accessionAnatomicCase";
      expect(bp(s, "clinical_history_text").maxLength).toBe(4000);
      expect(bp(s, "assigned_pathologist_membership_id").format).toBe("uuid");
      const p = bp(s, "parts");
      arr(p, 1, 52);
      expect(sorted(item(p))).toEqual(["description_text", "part_id", "site_text"]);
      expect([...reqd(item(p))].sort()).toEqual(["part_id", "site_text"]);
      expect(deref(props(item(p)).part_id).format).toBe("uuid");
      str(deref(props(item(p)).site_text), 1, 200);
      expect(deref(props(item(p)).description_text).maxLength).toBe(1000);
      expect(reqd(bodySchema(s))).toEqual(["parts"]);
    });
    T("A5 details: history ≤4000, assignee uuid; nothing required (full replace)", () => {
      const s = "updateAnatomicCaseDetails";
      expect(sorted(bodySchema(s))).toEqual(["assigned_pathologist_membership_id", "clinical_history_text"]);
      expect(bp(s, "clinical_history_text").maxLength).toBe(4000);
      expect(reqd(bodySchema(s))).toEqual([]);
    });
    T("A6 add part: site_text 1..200 required, description ≤1000, specimen_id uuid", () => {
      const s = "addAnatomicPart";
      str(bp(s, "site_text"), 1, 200);
      expect(bp(s, "description_text").maxLength).toBe(1000);
      expect(bp(s, "specimen_id").format).toBe("uuid");
      expect(reqd(bodySchema(s))).toEqual(["site_text"]);
    });
    T("A7 part: site_text 1..200 required, description ≤1000", () => {
      const s = "updateAnatomicPart";
      expect(sorted(bodySchema(s))).toEqual(["description_text", "site_text"]);
      str(bp(s, "site_text"), 1, 200);
      expect(reqd(bodySchema(s))).toEqual(["site_text"]);
    });
    T("A8 gross: text ≤20000, pieces 0..999, dimensions 1..3 DecimalStrings, weight pattern, is_complete; gross_text + is_complete required", () => {
      const s = "saveAnatomicGross";
      expect(sorted(bodySchema(s))).toEqual(["dimensions_mm", "gross_text", "is_complete", "pieces_count", "weight_g"]);
      expect(bp(s, "gross_text").maxLength).toBe(20000);
      int(bp(s, "pieces_count"), 0, 999);
      arr(bp(s, "dimensions_mm"), 1, 3);
      expect(item(bp(s, "dimensions_mm")).pattern).toBe("^[0-9]{1,4}(\\.[0-9])?$");
      expect(bp(s, "weight_g").pattern).toBe("^[0-9]{1,5}(\\.[0-9]{1,2})?$");
      expect(bp(s, "is_complete").type).toBe("boolean");
      expect([...reqd(bodySchema(s))].sort()).toEqual(["gross_text", "is_complete"]);
    });
    T("A11 cancel: reason_code coded-set anatomic.cancel_reasons (no enum) required, reason_text ≤500", () => {
      coded(bp("cancelAnatomicCase", "reason_code"), "anatomic.cancel_reasons");
      expect(bp("cancelAnatomicCase", "reason_text").maxLength).toBe(500);
      expect(reqd(bodySchema("cancelAnatomicCase"))).toEqual(["reason_code"]);
    });
    T("M1 blocks: part_id uuid, count 1..50, note ≤200; part_id + count required", () => {
      const s = "createAnatomicBlocks";
      expect(bp(s, "part_id").format).toBe("uuid");
      int(bp(s, "count"), 1, 50);
      expect(bp(s, "note").maxLength).toBe(200);
      expect([...reqd(bodySchema(s))].sort()).toEqual(["count", "part_id"]);
    });
    T("M2 slides: block_id/part_id uuid, stain_code coded-set anatomic.stains, count 1..20; stain_code + count required", () => {
      const s = "createAnatomicSlides";
      for (const f of ["block_id", "part_id"]) expect(bp(s, f).format, f).toBe("uuid");
      coded(bp(s, "stain_code"), "anatomic.stains");
      int(bp(s, "count"), 1, 20);
      expect([...reqd(bodySchema(s))].sort()).toEqual(["count", "stain_code"]);
    });
    T("M3 bulk-mark-ready: ids uuid[] 1..200 required; results {id, outcome enum}", () => {
      const s = "markAnatomicSlidesReady";
      arr(bp(s, "ids"), 1, 200);
      expect(item(bp(s, "ids")).format).toBe("uuid");
      expect(reqd(bodySchema(s))).toEqual(["ids"]);
      const r = item(props(okSchema(s)).results);
      expect(sorted(r)).toEqual(["id", "outcome"]);
      enumOf(props(r).outcome, ["updated", "unchanged", "invalid_state", "not_found"], "outcome");
    });
    T("M4 assessment: adequacy_code coded-set anatomic.cytology_adequacy, finding_text ≤2000, include_in_report boolean required", () => {
      const s = "saveAnatomicSlideAssessment";
      coded(bp(s, "adequacy_code"), "anatomic.cytology_adequacy");
      expect(bp(s, "finding_text").maxLength).toBe(2000);
      expect(bp(s, "include_in_report").type).toBe("boolean");
      expect(reqd(bodySchema(s))).toEqual(["include_in_report"]);
    });
    T("M5 stain order: stain_code coded-set anatomic.stains required; block_id, part_id, addon_order_item_id uuid; note ≤500", () => {
      const s = "createAnatomicStainOrder";
      coded(bp(s, "stain_code"), "anatomic.stains");
      for (const f of ["block_id", "part_id", "addon_order_item_id"]) expect(bp(s, f).format, f).toBe("uuid");
      expect(bp(s, "note").maxLength).toBe(500);
      expect(reqd(bodySchema(s))).toEqual(["stain_code"]);
    });
    T("M8 complete: slide_count 1..20 required, reagent_lot ≤64, performed_at date-time; response {stain_order, slides}", () => {
      const s = "completeAnatomicStainOrder";
      int(bp(s, "slide_count"), 1, 20);
      expect(bp(s, "reagent_lot").maxLength).toBe(64);
      expect(bp(s, "performed_at").format).toBe("date-time");
      expect(reqd(bodySchema(s))).toEqual(["slide_count"]);
      expect(sorted(okSchema(s))).toEqual(["slides", "stain_order"]);
    });
    T("M9 cancel: reason_text 1..500 required; M10 link-addon: order_item_id uuid required", () => {
      str(bp("cancelAnatomicStainOrder", "reason_text"), 1, 500);
      expect(reqd(bodySchema("cancelAnatomicStainOrder"))).toEqual(["reason_text"]);
      expect(bp("linkAnatomicAddonItem", "order_item_id").format).toBe("uuid");
      expect(reqd(bodySchema("linkAnatomicAddonItem"))).toEqual(["order_item_id"]);
    });
    T("M11 movements: object_kind enum, object_ids 1..200, movement enum, reason_code enum, text bounds; results outcome enum", () => {
      const s = "recordAnatomicMovements";
      expect(sorted(bodySchema(s))).toEqual(["destination_text", "location_text", "movement", "note", "object_ids", "object_kind", "reason_code"]);
      enumOf(bp(s, "object_kind"), ["block", "slide"], "object_kind");
      arr(bp(s, "object_ids"), 1, 200);
      expect(item(bp(s, "object_ids")).format).toBe("uuid");
      enumOf(bp(s, "movement"), MOVES, "movement");
      enumOf(bp(s, "reason_code"), ["second_opinion", "external_stain", "consultation", "retention_expired", "other"], "reason_code");
      expect(bp(s, "location_text").maxLength).toBe(120);
      expect(bp(s, "destination_text").maxLength).toBe(200);
      expect(bp(s, "note").maxLength).toBe(500);
      expect([...reqd(bodySchema(s))].sort()).toEqual(["movement", "object_ids", "object_kind"]);
      const r = item(props(okSchema(s)).results);
      expect(sorted(r)).toEqual(["id", "outcome"]);
      enumOf(props(r).outcome, ["recorded", "invalid_state", "not_found"], "outcome");
    });
    T("R2 ReportDraftInput: text bounds, flag N|A, synoptic ≤5, image_ids ≤24, ancillary ≤50, diagnosis_codes ≤20 coded; nothing required", () => {
      const s = "saveAnatomicReportDraft";
      expect(sorted(bodySchema(s))).toEqual(["ancillary", "comment_text", "diagnosis_codes", "flag", "gross_text", "image_ids", "impression_text", "is_critical", "microscopy_text", "synoptic"]);
      expect([bp(s, "gross_text").maxLength, bp(s, "microscopy_text").maxLength, bp(s, "impression_text").maxLength, bp(s, "comment_text").maxLength]).toEqual([20000, 20000, 8000, 8000]);
      enumOf(bp(s, "flag"), ["N", "A"], "flag");
      expect(bp(s, "is_critical").type).toBe("boolean");
      const sy = bp(s, "synoptic");
      arr(sy, undefined, 5);
      expect(sorted(item(sy))).toEqual(["template_id", "values"]);
      expect(deref(props(item(sy)).template_id).format).toBe("uuid");
      const vals = deref(props(item(sy)).values);
      expect(vals.type).toBe("object");
      arr(bp(s, "image_ids"), undefined, 24);
      expect(item(bp(s, "image_ids")).format).toBe("uuid");
      const an = bp(s, "ancillary");
      arr(an, undefined, 50);
      expect(sorted(item(an))).toEqual(["result_text", "stain_order_id"]);
      str(deref(props(item(an)).result_text), 1, 2000);
      const dg = bp(s, "diagnosis_codes");
      arr(dg, undefined, 20);
      expect(sorted(item(dg))).toEqual(["code"]);
      coded(deref(props(item(dg)).code), "anatomic.diagnoses");
      expect(reqd(bodySchema(s))).toEqual([]);
    });
    T("R3 sign-out + R10 sign addendum: attest boolean required, nothing else", () => {
      for (const s of ["signOutAnatomicCase", "signAnatomicAddendum"]) {
        expect(keys(bodySchema(s)), s).toEqual(["attest"]);
        expect(bp(s, "attest").type).toBe("boolean");
        expect(reqd(bodySchema(s))).toEqual(["attest"]);
      }
    });
    T("R4 change: reason_code pattern ^[a-z0-9_]{1,64}$ (format only, not a coded set) required, reason_text ≤500", () => {
      const s = "startAnatomicCaseChange";
      expect(bp(s, "reason_code").pattern).toBe("^[a-z0-9_]{1,64}$");
      expect(bp(s, "reason_code")["x-coded-set"]).toBeUndefined();
      expect(bp(s, "reason_text").maxLength).toBe(500);
      expect(reqd(bodySchema(s))).toEqual(["reason_code"]);
    });
    T("R8/R9 addendum: kind enum, text 1..8000, stain_order_ids uuid[] ≤20, addon_case_item_id uuid; kind + text required", () => {
      for (const s of ["createAnatomicAddendum", "updateAnatomicAddendum"]) {
        expect(sorted(bodySchema(s)), s).toEqual(["addon_case_item_id", "kind", "stain_order_ids", "text"]);
        enumOf(bp(s, "kind"), ["ihc", "special_stain", "molecular", "other"], `${s}.kind`);
        str(bp(s, "text"), 1, 8000);
        arr(bp(s, "stain_order_ids"), undefined, 20);
        expect(item(bp(s, "stain_order_ids")).format).toBe("uuid");
        expect(bp(s, "addon_case_item_id").format).toBe("uuid");
        expect([...reqd(bodySchema(s))].sort(), s).toEqual(["kind", "text"]);
      }
    });
    T("I1 upload: multipart/form-data {file binary, kind enum, part_id uuid, caption ≤200}; x-upload png+jpeg; 15 MB cap stated", () => {
      const o = ops.uploadAnatomicImage?.op;
      expect(Object.keys(o.requestBody?.content ?? {})).toEqual(["multipart/form-data"]);
      expect(o["x-upload"]).toEqual(["image/png", "image/jpeg"]);
      expect(JSON.stringify(o)).toMatch(/15728640|15 ?MB|15 ?MiB/);
      const m = deref(o.requestBody.content["multipart/form-data"].schema);
      expect(Object.keys(m.properties).sort()).toEqual(["caption", "file", "kind", "part_id"]);
      expect(deref(m.properties.file)).toMatchObject({ type: "string", format: "binary" });
      enumOf(m.properties.kind, ["gross", "microscopy", "other"], "kind");
      expect(deref(m.properties.part_id).format).toBe("uuid");
      expect(deref(m.properties.caption).maxLength).toBe(200);
      expect([...m.required].sort()).toEqual(["file", "kind"]);
    });
    T("I3 image: kind enum required, part_id uuid, caption ≤200", () => {
      const s = "updateAnatomicImage";
      enumOf(bp(s, "kind"), ["gross", "microscopy", "other"], "kind");
      expect(bp(s, "part_id").format).toBe("uuid");
      expect(bp(s, "caption").maxLength).toBe(200);
      expect(reqd(bodySchema(s))).toEqual(["kind"]);
    });
    T("Q1 molecular: results ≤50 {assay_code, target_code, result_code required; bounds}; response {molecular_rev, results}", () => {
      const s = "saveAnatomicMolecularResults";
      const r = bp(s, "results");
      arr(r, undefined, 50);
      expect(sorted(item(r))).toEqual(["assay_code", "batch_id", "comment_text", "kit_expiry_on", "kit_lot", "kit_name", "method_text", "result_code", "target_code", "unit_code", "value_decimal"]);
      expect([...reqd(item(r))].sort()).toEqual(["assay_code", "result_code", "target_code"]);
      const i = props(item(r));
      expect([deref(i.unit_code).maxLength, deref(i.method_text).maxLength, deref(i.kit_name).maxLength, deref(i.kit_lot).maxLength, deref(i.comment_text).maxLength]).toEqual([32, 200, 120, 64, 1000]);
      expect(deref(i.kit_expiry_on).format).toBe("date");
      expect(deref(i.batch_id).format).toBe("uuid");
      expect(reqd(bodySchema(s))).toEqual(["results"]);
      expect(sorted(okSchema(s))).toEqual(["molecular_rev", "results"]);
    });
    T("Q3 batch: assay_code required; kit/instrument bounds; run_at date-time; capacity 1..384 default 96", () => {
      const s = "createAnatomicBatch";
      expect(sorted(bodySchema(s))).toEqual(["assay_code", "capacity", "instrument_text", "kit_expiry_on", "kit_lot", "kit_name", "run_at"]);
      expect([bp(s, "kit_name").maxLength, bp(s, "kit_lot").maxLength, bp(s, "instrument_text").maxLength]).toEqual([120, 64, 120]);
      expect(bp(s, "run_at").format).toBe("date-time");
      int(bp(s, "capacity"), 1, 384);
      expect(bp(s, "capacity").default).toBe(96);
      expect(reqd(bodySchema(s))).toEqual(["assay_code"]);
    });
    T("Q5 members 1..96 {case_id uuid, position ≥1} required; Q6 case_ids uuid[] 1..96 required", () => {
      const m = bp("addAnatomicBatchMembers", "members");
      arr(m, 1, 96);
      expect(sorted(item(m))).toEqual(["case_id", "position"]);
      expect([...reqd(item(m))].sort()).toEqual(["case_id", "position"]);
      expect(deref(props(item(m)).case_id).format).toBe("uuid");
      expect(deref(props(item(m)).position)).toMatchObject({ type: "integer", minimum: 1 });
      expect(reqd(bodySchema("addAnatomicBatchMembers"))).toEqual(["members"]);
      arr(bp("removeAnatomicBatchMembers", "case_ids"), 1, 96);
      expect(item(bp("removeAnatomicBatchMembers", "case_ids")).format).toBe("uuid");
      expect(reqd(bodySchema("removeAnatomicBatchMembers"))).toEqual(["case_ids"]);
    });
    T("K2 settings: five mutable fields with §10.2 ranges; no `version` in the body", () => {
      const s = "updateAnatomicSettings";
      expect(sorted(bodySchema(s))).toEqual(["auto_accession_on_receipt", "default_routine_stain_code", "max_images_per_case", "max_report_images", "require_gross_complete_for_processing"]);
      for (const f of ["auto_accession_on_receipt", "require_gross_complete_for_processing"]) expect(bp(s, f).type, f).toBe("boolean");
      expect(bp(s, "default_routine_stain_code").type).toBe("string");
      int(bp(s, "max_images_per_case"), 1, 200);
      int(bp(s, "max_report_images"), 0, 24);
    });
    T("K4 stain: code ^[A-Z0-9_]{1,32}$, display 1..120, kind enum, addon_test_id uuid, sort_order 0..9999; K5 same minus code, plus is_active", () => {
      const s = "createAnatomicStain";
      expect(sorted(bodySchema(s))).toEqual(["addon_test_id", "code", "display", "kind", "sort_order"]);
      expect(bp(s, "code").pattern).toBe("^[A-Z0-9_]{1,32}$");
      str(bp(s, "display"), 1, 120);
      enumOf(bp(s, "kind"), ["routine", "special", "ihc"], "kind");
      expect(bp(s, "addon_test_id").format).toBe("uuid");
      int(bp(s, "sort_order"), 0, 9999);
      expect([...reqd(bodySchema(s))].sort()).toEqual(["code", "display", "kind", "sort_order"]);
      const u = "updateAnatomicStain";
      expect(sorted(bodySchema(u))).toEqual(["addon_test_id", "display", "is_active", "kind", "sort_order"]);
      expect([...reqd(bodySchema(u))].sort()).toEqual(["display", "is_active", "kind", "sort_order"]);
    });
    T("K7 test profile: case_kind enum, flags, default_stain_code, ≤5 synoptic keys, is_active", () => {
      const s = "upsertAnatomicTestProfile";
      expect(sorted(bodySchema(s))).toEqual(["case_kind", "default_stain_code", "default_synoptic_template_keys", "is_active", "is_addon", "requires_gross"]);
      enumOf(bp(s, "case_kind"), CASE_KINDS, "case_kind");
      for (const f of ["is_addon", "requires_gross", "is_active"]) expect(bp(s, f).type, f).toBe("boolean");
      arr(bp(s, "default_synoptic_template_keys"), undefined, 5);
      expect([...reqd(bodySchema(s))].sort()).toEqual(["case_kind", "is_active", "is_addon", "requires_gross"]);
    });
    T("K9/K10 AssayInput: code pattern, targets 1..50, result_values 1..20, decimals 0..6, patterns; K10 body has the same shape (code immutable by contract)", () => {
      for (const s of ["createAnatomicAssay", "updateAnatomicAssay"]) {
        expect(sorted(bodySchema(s)), s).toEqual(["code", "display", "is_active", "method_text_default", "targets"]);
        expect(bp(s, "code").pattern).toBe("^[A-Z0-9_]{1,32}$");
        str(bp(s, "display"), 1, 120);
        expect(bp(s, "method_text_default").maxLength).toBe(200);
        expect([...reqd(bodySchema(s))].sort(), s).toEqual(["code", "display", "is_active", "targets"]);
        const t = bp(s, "targets");
        arr(t, 1, 50);
        expect(sorted(item(t))).toEqual(["allows_quantitative", "code", "decimals", "display", "is_active", "result_values", "sort_order", "unit_code"]);
        expect([...reqd(item(t))].sort()).toEqual(["allows_quantitative", "code", "display", "is_active", "result_values", "sort_order"]);
        expect(deref(props(item(t)).code).pattern).toBe("^[A-Z0-9_]{1,32}$");
        int(deref(props(item(t)).decimals), 0, 6);
        expect(deref(props(item(t)).unit_code).maxLength).toBe(32);
        const rv = deref(props(item(t)).result_values);
        arr(rv, 1, 20);
        expect(sorted(item(rv))).toEqual(["code", "display", "is_abnormal", "is_active", "sort_order"]);
        expect([...reqd(item(rv))].sort()).toEqual(["code", "display", "is_abnormal", "is_active", "sort_order"]);
        expect(deref(props(item(rv)).code).pattern).toBe("^[a-z0-9_]{1,32}$");
      }
    });
    T("K12 coded value: display 1..300, system ≤32, system_version ≤32, sort_order 0..9999, is_active; display + sort_order + is_active required", () => {
      const s = "upsertAnatomicCodedValue";
      expect(sorted(bodySchema(s))).toEqual(["display", "is_active", "sort_order", "system", "system_version"]);
      str(bp(s, "display"), 1, 300);
      expect([bp(s, "system").maxLength, bp(s, "system_version").maxLength]).toEqual([32, 32]);
      int(bp(s, "sort_order"), 0, 9999);
      expect([...reqd(bodySchema(s))].sort()).toEqual(["display", "is_active", "sort_order"]);
    });
    T("K14 synoptic create: template_key ^[a-z][a-z0-9_]{0,39}$, definition (SynopticDefinitionV1) required; K16 body = {definition}", () => {
      const s = "createAnatomicSynopticTemplate";
      expect(sorted(bodySchema(s))).toEqual(["definition", "template_key"]);
      expect(bp(s, "template_key").pattern).toBe("^[a-z][a-z0-9_]{0,39}$");
      expect(deref(props(bodySchema(s)).definition)?.type).toBe("object");
      expect([...reqd(bodySchema(s))].sort()).toEqual(["definition", "template_key"]);
      expect(doc.components?.schemas?.SynopticDefinitionV1, "SynopticDefinitionV1 schema (TRD §4.5)").toBeDefined();
      expect(keys(bodySchema("updateAnatomicSynopticTemplate"))).toEqual(["definition"]);
      expect(reqd(bodySchema("updateAnatomicSynopticTemplate"))).toEqual(["definition"]);
    });
    T("K21 text template: short_code ^[a-z0-9_]{1,16}$, section enum, title 1..120, body 1..8000 (all required); K22 title/body/is_active", () => {
      const s = "createAnatomicTextTemplate";
      expect(sorted(bodySchema(s))).toEqual(["body", "section", "short_code", "title"]);
      expect(bp(s, "short_code").pattern).toBe("^[a-z0-9_]{1,16}$");
      enumOf(bp(s, "section"), SECTIONS, "section");
      str(bp(s, "title"), 1, 120);
      str(bp(s, "body"), 1, 8000);
      expect([...reqd(bodySchema(s))].sort()).toEqual(["body", "section", "short_code", "title"]);
      const u = "updateAnatomicTextTemplate";
      expect(sorted(bodySchema(u))).toEqual(["body", "is_active", "title"]);
      expect([...reqd(bodySchema(u))].sort()).toEqual(["body", "is_active", "title"]);
    });
    T("every JSON string property has maxLength (TRD §5 common: strings have maxLength) unless it is an enum, format-bound or a map", () => {
      for (const s of SPECS) {
        const b = bodySchema(s.opId);
        if (!b) continue;
        walk(b, (n) => {
          for (const [k, v] of Object.entries<any>(n.properties ?? {})) {
            const d = deref(v);
            if (d?.type === "string" && !d.enum && !d.format && !d.pattern) expect(d.maxLength, `${s.id}.${k}`).toBeGreaterThan(0);
          }
        });
      }
    });
  });

  describe("responses (TRD §5.7 field lists; mappers emit exactly these)", () => {
    const CS_FIELDS = ["id", "accession_no", "case_kind", "status", "priority", "centre_id", "order_id", "patient_id", "patient", "test_names", "part_count", "received_at", "accessioned_at", "signed_out_at",
      "assigned_pathologist", "flags", "version"];
    const CS_OPT = ["accession_no", "patient", "accessioned_at", "signed_out_at", "assigned_pathologist"];
    const CD_EXTRA = ["clinical_history_text", "branch_id", "current_version_no", "parts", "blocks", "slides", "stain_orders", "images", "items", "molecular_rev", "molecular_results", "open_draft", "addenda",
      "transitions", "allowed_actions"];
    const BLOCK = ["id", "part_id", "label", "seq", "note", "location_status", "location_text", "slide_count", "version"];
    const STAIN_ORDER = ["id", "stain_code", "stain_display", "stain_kind", "block_id", "block_label", "part_id", "status", "note", "reagent_lot", "addon_order_item_id", "requested_at", "requested_by_display_name",
      "completed_at", "version"];
    const REPORT_SUMMARY = ["version_no", "version_kind", "scope", "signed_at", "signed_by_display_name", "change_reason_code", "submissions"];
    const BATCH = ["id", "batch_no", "assay_code", "status", "kit_name", "kit_lot", "kit_expiry_on", "instrument_text", "run_at", "capacity", "member_count", "version"];
    const TEMPLATE_SUMMARY = ["id", "template_key", "version_no", "status", "title", "applies_to_case_kinds", "published_at"];

    T("CaseSummary exact fields + optionality; patient + flags sub-shapes (A1 data item)", () => {
      const c = item(props(okSchema("listAnatomicCases")).data);
      shape(c, CS_FIELDS, CS_OPT, "CaseSummary");
      shape(props(c).patient, ["display_name", "sex", "age_text", "patient_code"], [], "CaseSummary.patient");
      shape(props(c).flags, ["profile_missing", "specimen_rejected", "open_change", "pending_stain_orders", "parts_missing_site"], [], "CaseSummary.flags");
      expect(deref(props(props(c).flags).pending_stain_orders).type).toBe("integer");
      expect(deref(props(props(c).flags).parts_missing_site).type).toBe("boolean");
      shape(props(c).assigned_pathologist, ["membership_id", "display_name"], [], "CaseSummary.assigned_pathologist");
      expect(deref(props(c).test_names).type).toBe("array");
    });
    T("CaseDetail = CaseSummary + extras (A3, A4, A5, A9–A11); items / transitions / open_draft sub-shapes", () => {
      for (const id of ["getAnatomicCase", "accessionAnatomicCase", "updateAnatomicCaseDetails", "startAnatomicProcessing", "markAnatomicCaseReady", "cancelAnatomicCase"]) {
        const d = okSchema(id);
        shape(d, [...CS_FIELDS, ...CD_EXTRA], [...CS_OPT, "clinical_history_text", "branch_id", "open_draft"], `${id} CaseDetail`);
      }
      const d = okSchema("getAnatomicCase");
      const it_ = item(props(d).items);
      shape(it_, ["case_item_id", "order_item_id", "test_id", "test_name", "role", "is_active", "lab_status", "lab_version_no", "last_submitted_version_no"], ["lab_status", "lab_version_no", "last_submitted_version_no"], "items[]");
      enumOf(props(it_).role, ["primary", "addon"], "items[].role");
      const t = deref(props(d).transitions);
      arr(t, undefined, 100);
      shape(item(t), ["from_status", "to_status", "at", "by_display_name"], ["from_status"], "transitions[]");
      shape(props(d).open_draft, ["kind", "version", "updated_at"], [], "open_draft");
      expect(deref(props(d).allowed_actions).type).toBe("array");
    });
    T("A2 lookup response {object_kind case|block|slide, case_id, block_id?, slide_id?}", () => {
      const s = okSchema("lookupAnatomicObject");
      shape(s, ["object_kind", "case_id", "block_id", "slide_id"], ["block_id", "slide_id"], "lookup");
      enumOf(props(s).object_kind, ["case", "block", "slide"], "object_kind");
    });
    T("A12 assignees {data: [{membership_id, display_name}]}", () => {
      const s = wrap("listAnatomicAssignees", [], false);
      shape(item(props(s).data), ["membership_id", "display_name"], [], "assignee");
    });
    T("Part + GrossRecord (A6, A7, A8 responses)", () => {
      const p = okSchema("addAnatomicPart");
      shape(p, ["id", "letter", "site_text", "description_text", "specimen_id", "specimen_type_code", "specimen_state", "gross", "version"],
        ["site_text", "description_text", "specimen_id", "specimen_type_code", "gross"], "Part");
      enumOf(props(p).specimen_state, ["received", "rejected", "none"], "specimen_state");
      expect(sorted(okSchema("updateAnatomicPart"))).toEqual(sorted(p));
      shape(okSchema("saveAnatomicGross"), ["part_id", "gross_text", "pieces_count", "dimensions_mm", "weight_g", "is_complete", "completed_at", "grossed_by_display_name", "updated_at", "version"],
        ["pieces_count", "dimensions_mm", "weight_g", "completed_at"], "GrossRecord");
    });
    T("Block (M1 blocks[]) location_status enum; Slide (M2 slides[]); wrappers {blocks}, {slides}", () => {
      const b = item(props(wrap("createAnatomicBlocks", ["blocks"], false)).blocks);
      shape(b, BLOCK, ["note", "location_text"], "Block");
      enumOf(props(b).location_status, LOC, "Block.location_status");
      const s = item(props(wrap("createAnatomicSlides", ["slides"], false)).slides);
      shape(s, ["id", "label", "block_id", "part_id", "stain_code", "stain_display", "status", "location_status", "location_text", "stain_order_id", "adequacy_code", "finding_text", "include_in_report", "version"],
        ["block_id", "location_text", "stain_order_id", "adequacy_code", "finding_text"], "Slide");
      enumOf(props(s).status, ["pending_stain", "ready"], "Slide.status");
      expect(sorted(okSchema("saveAnatomicSlideAssessment"))).toEqual(sorted(s));
    });
    T("StainOrder (M5, M7, M9, M10) + status enum; StainOrderRow (M6) adds case_id/accession_no/priority; M8 slides[] = Slide", () => {
      const so = okSchema("createAnatomicStainOrder");
      shape(so, STAIN_ORDER, ["block_id", "block_label", "part_id", "note", "reagent_lot", "addon_order_item_id", "completed_at"], "StainOrder");
      enumOf(props(so).status, ["requested", "in_progress", "completed", "cancelled"], "StainOrder.status");
      for (const id of ["startAnatomicStainOrder", "cancelAnatomicStainOrder", "linkAnatomicAddonItem"]) expect(sorted(okSchema(id)), id).toEqual(sorted(so));
      const row = item(props(wrap("listAnatomicStainOrders", [], true)).data);
      shape(row, [...STAIN_ORDER, "case_id", "accession_no", "priority"], ["block_id", "block_label", "part_id", "note", "reagent_lot", "addon_order_item_id", "completed_at"], "StainOrderRow");
      expect(sorted(item(props(okSchema("completeAnatomicStainOrder")).slides))).toEqual(sorted(item(props(okSchema("createAnatomicSlides")).slides)));
    });
    T("BlockRow (M12) = Block + case_id, accession_no, last_movement_at?; Movement (M13, M14) with movement enum", () => {
      const br = item(props(wrap("listAnatomicBlocks", [], true)).data);
      shape(br, [...BLOCK, "case_id", "accession_no", "last_movement_at"], ["note", "location_text", "last_movement_at"], "BlockRow");
      for (const id of ["listAnatomicBlockMovements", "listAnatomicSlideMovements"]) {
        const m = item(props(wrap(id, [], true)).data);
        shape(m, ["id", "movement", "location_text", "destination_text", "reason_code", "note", "at", "by_display_name"], ["location_text", "destination_text", "reason_code", "note"], `${id} Movement`);
        enumOf(props(m).movement, MOVES, `${id}.movement`);
      }
    });
    T("M15 labels {labels: [{object_kind, object_id, label, line2}]}", () => {
      const l = item(props(wrap("getAnatomicLabels", ["labels"], false)).labels);
      shape(l, ["object_kind", "object_id", "label", "line2"], [], "label");
    });
    T("Image (I1 201, I3, I4): state enum, optional dims; I2 image/png|jpeg binary + security headers (P-2 exception)", () => {
      const i = okSchema("uploadAnatomicImage", "201");
      shape(i, ["id", "kind", "part_id", "caption", "state", "mime_type", "width_px", "height_px", "created_at", "is_active", "version"], ["part_id", "caption", "mime_type", "width_px", "height_px"], "Image");
      enumOf(props(i).state, ["processing", "ready", "quarantined"], "Image.state");
      for (const id of ["updateAnatomicImage", "deactivateAnatomicImage"]) expect(sorted(okSchema(id)), id).toEqual(sorted(i));
      const r = okResp("getAnatomicImageContent", "200");
      expect(Object.keys(r.content ?? {}).sort()).toEqual(["image/jpeg", "image/png"]);
      for (const m of Object.values<any>(r.content)) expect(deref(m.schema)).toMatchObject({ type: "string", format: "binary" });
      expect(Object.keys(r.headers ?? {})).toEqual(expect.arrayContaining(["Content-Type", "Content-Disposition", "X-Content-Type-Options", "Content-Security-Policy", "Cache-Control"]));
      const h = JSON.stringify(r.headers);
      expect(h).toContain("inline");
      expect(h).toContain("nosniff");
      expect(h).toContain("default-src 'none'; sandbox");
      expect(h).toContain("no-store");
      expect(Object.keys(ops.getAnatomicImageContent.op.responses)).toContain("422");
    });
    T("ReportDraft (R1, R2, R4 201): kind enum, sub-shapes", () => {
      const d = okSchema("getAnatomicReportDraft");
      shape(d, ["case_id", "kind", "change_reason_code", "change_reason_text", "gross_text", "microscopy_text", "impression_text", "comment_text", "flag", "is_critical", "synoptic", "image_ids", "ancillary",
        "diagnosis_codes", "updated_at", "updated_by_display_name", "version"], ["change_reason_code", "change_reason_text", "flag"], "ReportDraft");
      enumOf(props(d).kind, ["initial", "revision", "amendment"], "ReportDraft.kind");
      shape(item(props(d).synoptic), ["template_id", "template_key", "template_version", "title", "values"], [], "ReportDraft.synoptic[]");
      shape(item(props(d).diagnosis_codes), ["code", "display", "system", "system_version"], ["system_version"], "ReportDraft.diagnosis_codes[]");
      for (const [id, c] of [["saveAnatomicReportDraft", undefined], ["startAnatomicCaseChange", "201"]] as const) expect(sorted(okSchema(id, c)), id).toEqual(sorted(d));
    });
    T("ReportVersionSummary (R6 data[] ≤200), ReportVersion ⊇ summary (R7); R5 returns 204 with no body", () => {
      const l = wrap("listAnatomicReportVersions", [], false);
      arr(deref(props(l).data), undefined, 200);
      const s = item(props(l).data);
      shape(s, REPORT_SUMMARY, ["change_reason_code"], "ReportVersionSummary");
      enumOf(props(s).version_kind, ["original", "revision", "amendment", "addendum"], "version_kind");
      enumOf(props(s).scope, ["full", "addendum_only"], "scope");
      shape(item(props(s).submissions), ["case_item_id", "order_item_id", "item_version_no", "lab_status_at_submit"], [], "submissions[]");
      shape(okSchema("getAnatomicReportVersion"), REPORT_SUMMARY, ["change_reason_code"], "ReportVersion", false);
      expect(okResp("discardAnatomicCaseChange", "204").content).toBeUndefined();
    });
    T("SignOutResult {case: CaseDetail, report_version: summary} (R3, R10); Addendum (R8 201, R9)", () => {
      for (const id of ["signOutAnatomicCase", "signAnatomicAddendum"]) {
        const r = okSchema(id);
        expect(sorted(r), id).toEqual(["case", "report_version"]);
        expect(reqd(r).sort()).toEqual(["case", "report_version"]);
        shape(props(r).case, [...CS_FIELDS, ...CD_EXTRA], [...CS_OPT, "clinical_history_text", "branch_id", "open_draft"], `${id}.case`);
        shape(props(r).report_version, REPORT_SUMMARY, ["change_reason_code"], `${id}.report_version`);
      }
      const a = okSchema("createAnatomicAddendum", "201");
      shape(a, ["id", "kind", "text", "stain_order_ids", "addon_case_item_id", "status", "signed_at", "signed_by_display_name", "report_version_no", "version"],
        ["addon_case_item_id", "signed_at", "signed_by_display_name", "report_version_no"], "Addendum");
      enumOf(props(a).status, ["draft", "signed"], "Addendum.status");
      expect(sorted(okSchema("updateAnatomicAddendum"))).toEqual(sorted(a));
    });
    T("MolecularResult (Q1 results[])", () => {
      shape(item(props(okSchema("saveAnatomicMolecularResults")).results), ["id", "assay_code", "assay_display", "target_code", "target_display", "result_code", "result_display", "is_abnormal",
        "value_decimal", "unit_code", "method_text", "kit_name", "kit_lot", "kit_expiry_on", "batch_id", "batch_no", "comment_text"],
        ["value_decimal", "unit_code", "method_text", "kit_name", "kit_lot", "kit_expiry_on", "batch_id", "batch_no", "comment_text"], "MolecularResult");
    });
    T("Batch (Q2 data[], Q3 201); BatchDetail = Batch + members[] (Q4, Q5, Q6, Q7)", () => {
      const opt = ["kit_name", "kit_lot", "kit_expiry_on", "instrument_text", "run_at"];
      shape(item(props(wrap("listAnatomicBatches", [], true)).data), BATCH, opt, "Batch");
      shape(okSchema("createAnatomicBatch", "201"), BATCH, opt, "Batch (Q3)");
      for (const id of ["getAnatomicBatch", "addAnatomicBatchMembers", "removeAnatomicBatchMembers", "closeAnatomicBatch"]) {
        const d = okSchema(id);
        shape(d, [...BATCH, "members"], opt, `${id} BatchDetail`);
        shape(item(props(d).members), ["case_id", "accession_no", "position"], ["accession_no"], `${id} members[]`);
      }
    });
    T("Settings (K1, K2): five fields + version, exactly", () => {
      for (const id of ["getAnatomicSettings", "updateAnatomicSettings"])
        shape(okSchema(id), ["auto_accession_on_receipt", "require_gross_complete_for_processing", "default_routine_stain_code", "max_images_per_case", "max_report_images", "version"], [], id);
    });
    T("Stain (K3 data[] ≤500, K4 201, K5), TestProfile (K6, K7), Assay (K8, K9 201, K10), CodedValue (K11, K12), TextTemplate (K20 ≤1000, K21 201, K22)", () => {
      const stain = ["id", "code", "display", "kind", "addon_test_id", "sort_order", "is_active", "version"];
      const l3 = wrap("listAnatomicStains", [], false);
      arr(deref(props(l3).data), undefined, 500);
      shape(item(props(l3).data), stain, ["addon_test_id"], "Stain");
      shape(okSchema("createAnatomicStain", "201"), stain, ["addon_test_id"], "Stain K4");
      shape(okSchema("updateAnatomicStain"), stain, ["addon_test_id"], "Stain K5");
      const tp = ["test_id", "test_name", "case_kind", "is_addon", "requires_gross", "default_stain_code", "default_synoptic_template_keys", "is_active", "version"];
      shape(item(props(wrap("listAnatomicTestProfiles", [], false)).data), tp, ["default_stain_code"], "TestProfile");
      shape(okSchema("upsertAnatomicTestProfile"), tp, ["default_stain_code"], "TestProfile K7");
      const assay = ["id", "code", "display", "method_text_default", "is_active", "targets", "version"];
      shape(item(props(wrap("listAnatomicAssays", [], false)).data), assay, ["method_text_default"], "Assay");
      for (const [id, c] of [["createAnatomicAssay", "201"], ["updateAnatomicAssay", undefined]] as const) {
        const a = okSchema(id, c);
        shape(a, assay, ["method_text_default"], `Assay ${id}`);
        expect(keys(item(props(a).targets)), `${id} targets[]`).toEqual(expect.arrayContaining(["id", "code", "display", "allows_quantitative", "result_values"]));
      }
      const cv = ["code", "display", "system", "system_version", "sort_order", "is_active", "version"];
      shape(item(props(wrap("listAnatomicCodedValues", [], true)).data), cv, ["system_version"], "CodedValue");
      shape(okSchema("upsertAnatomicCodedValue"), cv, ["system_version"], "CodedValue K12");
      const tt = ["id", "short_code", "section", "title", "body", "is_active", "version"];
      const l20 = wrap("listAnatomicTextTemplates", [], false);
      arr(deref(props(l20).data), undefined, 1000);
      shape(item(props(l20).data), tt, [], "TextTemplate");
      shape(okSchema("createAnatomicTextTemplate", "201"), tt, [], "TextTemplate K21");
      shape(okSchema("updateAnatomicTextTemplate"), tt, [], "TextTemplate K22");
    });
    T("SynopticTemplateSummary (K13 data[] ≤500); SynopticTemplate = summary + definition, version (K14 201, K15, K16, K17, K18, K19 201)", () => {
      const l = wrap("listAnatomicSynopticTemplates", [], false);
      arr(deref(props(l).data), undefined, 500);
      shape(item(props(l).data), TEMPLATE_SUMMARY, ["published_at"], "SynopticTemplateSummary");
      enumOf(props(item(props(l).data)).status, ["draft", "published", "retired"], "SynopticTemplate.status");
      for (const [id, c] of [["createAnatomicSynopticTemplate", "201"], ["getAnatomicSynopticTemplate", undefined], ["updateAnatomicSynopticTemplate", undefined],
        ["publishAnatomicSynopticTemplate", undefined], ["retireAnatomicSynopticTemplate", undefined], ["createAnatomicSynopticTemplateVersion", "201"]] as const)
        shape(okSchema(id, c), [...TEMPLATE_SUMMARY, "definition", "version"], ["published_at"], `SynopticTemplate ${id}`);
    });
    T("paged list ops return {data, page}", () => {
      for (const id of ["listAnatomicCases", "listAnatomicStainOrders", "listAnatomicBlocks", "listAnatomicBlockMovements", "listAnatomicSlideMovements", "listAnatomicBatches", "listAnatomicCodedValues"])
        expect(sorted(okSchema(id)), id).toEqual(["data", "page"]);
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
    T("privileged ops (case.signout, config.manage) list auth.mfa_required; case.read/case.work ops do not", () => {
      for (const s of SPECS) {
        if (s.mfa) expect(ops[s.opId].op["x-error-codes"], s.id).toContain(MFA);
        else expect(ops[s.opId].op["x-error-codes"], s.id).not.toContain(MFA);
      }
    });
  });

  describe("synthetic examples and offline 'Prism smoke' (AC-0C-1.4)", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...doc, id: "anatomic.yaml" });
    const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    const check = (ptr: string, example: unknown) => {
      const validate = ajv.getSchema(`anatomic.yaml#${ptr}`);
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
      expect(n).toBeGreaterThanOrEqual(60);
    });
    it("every operation with a JSON 2xx response has an example Prism can serve", () => {
      ex();
      expect(Object.keys(ops).length).toBe(TOTAL);
      for (const s of SPECS) {
        const { op, path, method } = ops[s.opId];
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
    it("package.json has `mock:anatomic` = prism mock contracts/openapi/anatomic.yaml on a port no other mock uses", () => {
      const scripts: Record<string, string> = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
      const mine = scripts["mock:anatomic"];
      expect(mine, "mock:anatomic script missing").toBeDefined();
      const m = /^prism mock contracts\/openapi\/anatomic\.yaml --host 127\.0\.0\.1 --port (\d+)$/.exec(mine);
      expect(m, mine).not.toBeNull();
      const ports = Object.entries(scripts).filter(([k]) => k.startsWith("mock:") && k !== "mock:anatomic" && k !== "mock:list")
        .map(([, v]) => /--port (\d+)/.exec(v)?.[1]);
      expect(ports).not.toContain(m![1]);
    });
  });
});
