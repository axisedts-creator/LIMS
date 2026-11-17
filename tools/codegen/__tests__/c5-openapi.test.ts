// T0C-10.C5 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/lab.yaml (C5 transcription of spec/chunks/C5-lab-workflow/02-TRD.md §5.1–§5.9).
// Checks: (1) exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) clean for lab.yaml; (3) AC-0C-1.5 negatives on a temp copy
// (bad x-permission / error code / additionalProperties / tier); (4) inventory = TRD tables (55 ops: #1–#54 + #14a), method+path,
// x-permission, x-idempotency, success status, extra + common error codes, Idempotency-Key / If-Match (TRD §3.2 list);
// (5) shape pins (bulk items[{id,version}] ≤200, bounds, enums, coded sets, DTO allowlists); (6) "Prism smoke" offline: examples
// validate (ajv), every op has a servable 2xx example, examples synthetic (no e-mail / mobile number / paths).
// Not testable here: Prism actually serving the file (prism not installed; mock wiring is T0C-08's mocks.test.ts).
// Assumptions (TRD silent): POST without an explicit status = 200, except pure creates #20/#37/#44/#50 = 201; ambiguous creates
// (#9, #10, #11, #40, #51) accept 200 or 201; `—` Idem = none; #14a (only `none` POST) needs an `E3 ` justification (LD-10, read-only POST)
// mentioning "readiness"; bulk ops list the per-id codes of the single-object op in x-error-codes; If-Match is a parameter only on the
// TRD §3.2 list (#4 #7 #9 #10 #11 #12 #13 #27 #29 #30 #32 #48 #51 #52 #54) and absent elsewhere.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRD = join(ROOT, "spec/chunks/C5-lab-workflow/02-TRD.md");
const FILE = join(ROOT, "contracts/openapi/lab.yaml");
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const METHODS = ["get", "put", "post", "delete", "patch"];
const name = "lab";
const PFX = "/v1/lab";

const L = (s: string) => `lab.${s}`;
const SP_R = L("specimen.read"), SP_C = L("specimen.collect"), SP_RCV = L("specimen.receive"), SP_REJ = L("specimen.reject"), SP_LBL = L("specimen.label_print");
const RES_R = L("result.read"), RES_E = L("result.enter"), RES_V = L("result.verify"), RES_A = L("result.approve"), RES_AM = L("result.amend");
const WL_R = L("worklist.read"), CV_R = L("critical_value.read"), QC = L("qc.capture"), CFG = L("config.manage");
const VC = "common.version_conflict", PRE = "common.precondition_required", CUR = "common.invalid_cursor", MFA = "auth.mfa_required";
const INV_T = L("specimen_invalid_transition"), INACT = L("specimen_inactive"), R_INV_T = L("result_invalid_transition");

type Spec = { n: string; id: string; method: string; path: string; perm: string; idem: "none" | "optional" | "required"; status: number | number[];
  im?: boolean; err?: string[]; paged?: boolean };
const S = (n: string, id: string, method: string, path: string, perm: string, idem: Spec["idem"], status: Spec["status"],
  o: { im?: boolean; err?: string[]; paged?: boolean } = {}): Spec => ({ n, id, method, path, perm, idem, status, ...o });
const O = "optional" as const, R = "required" as const, N = "none" as const;

const SPECS: Spec[] = [
  S("1", "lookupSpecimenByBarcode", "POST", "/specimens/lookup", SP_R, O, 200),
  S("2", "listSpecimens", "GET", "/specimens", SP_R, N, 200, { err: [CUR], paged: true }),
  S("3", "getSpecimen", "GET", "/specimens/{specimen_id}", SP_R, N, 200),
  S("4", "collectSpecimen", "POST", "/specimens/{specimen_id}/collect", SP_C, O, 200, { im: true, err: [INV_T, INACT] }),
  S("5", "bulkCollectSpecimens", "POST", "/specimens/bulk-collect", SP_C, R, 200, { err: [INV_T, INACT] }),
  S("6", "bulkDispatchSpecimens", "POST", "/specimens/bulk-dispatch", SP_C, R, 200, { err: [INV_T] }),
  S("7", "receiveSpecimen", "POST", "/specimens/{specimen_id}/receive", SP_RCV, O, 200, { im: true, err: [L("specimen_not_receivable"), INV_T, INACT] }),
  S("8", "bulkReceiveSpecimens", "POST", "/specimens/bulk-receive", SP_RCV, R, 200, { err: [L("specimen_not_receivable"), INV_T, INACT] }),
  S("9", "rejectSpecimen", "POST", "/specimens/{specimen_id}/reject", SP_REJ, R, [200, 201], { im: true, err: [L("rejection_reason_required"), INV_T] }),
  S("10", "requestRecollection", "POST", "/specimens/{specimen_id}/recollect", SP_REJ, R, [200, 201], { im: true, err: [INV_T] }),
  S("11", "createAliquots", "POST", "/specimens/{specimen_id}/aliquots", SP_RCV, R, [200, 201], { im: true, err: [INV_T] }),
  S("12", "storeSpecimen", "POST", "/specimens/{specimen_id}/store", SP_RCV, O, 200, { im: true, err: [INV_T] }),
  S("13", "discardSpecimen", "POST", "/specimens/{specimen_id}/discard", SP_RCV, O, 200, { im: true, err: [INV_T] }),
  S("14", "printSpecimenLabels", "POST", "/specimens/labels", SP_LBL, O, 200, { err: [INACT] }),
  S("14a", "requestOrderLabelPrint", "POST", "/orders/{order_id}/label-prints", SP_LBL, N, 200, { err: [VC] }),
  S("15", "getLabOrder", "GET", "/orders/{order_id}", SP_R, N, 200),
  S("16", "listOrderResults", "GET", "/orders/{order_id}/results", RES_R, N, 200),
  S("17", "getStatusBoard", "GET", "/status-board", L("status_board.read"), N, 200, { err: [CUR], paged: true }),
  S("18", "listWorklistItems", "GET", "/worklist-items", WL_R, N, 200, { err: [CUR], paged: true }),
  S("19", "listPendingItems", "GET", "/pending-items", WL_R, N, 200, { err: [CUR], paged: true }),
  S("20", "createWorksheet", "POST", "/worksheets", L("worksheet.manage"), R, 201),
  S("21", "listWorksheets", "GET", "/worksheets", WL_R, N, 200, { err: [CUR], paged: true }),
  S("22", "getWorksheet", "GET", "/worksheets/{worksheet_id}", WL_R, N, 200),
  S("23", "getResult", "GET", "/results/{result_id}", RES_R, N, 200),
  S("24", "bulkEnterResults", "POST", "/results/bulk-enter", RES_E, R, 200,
    { err: [L("result_value_invalid"), L("result_locked"), R_INV_T, VC] }),
  S("25", "getResultHistory", "GET", "/results/{result_id}/history", RES_R, N, 200),
  S("26", "getAnalyteTrend", "GET", "/patients/{patient_id}/analytes/{analyte_id}/trend", RES_R, N, 200),
  S("27", "verifyResult", "POST", "/results/{result_id}/verify", RES_V, O, 200, { im: true, err: [R_INV_T, L("result_on_hold"), L("flag_ack_required")] }),
  S("28", "bulkVerifyResults", "POST", "/results/bulk-verify", RES_V, R, 200, { err: [R_INV_T, L("result_on_hold"), L("flag_ack_required")] }),
  S("29", "returnResult", "POST", "/results/{result_id}/return", RES_V, O, 200, { im: true, err: [R_INV_T] }),
  S("30", "approveResult", "POST", "/results/{result_id}/approve", RES_A, O, 200,
    { im: true, err: [R_INV_T, L("result_on_hold"), L("self_approval_forbidden"), L("critical_ack_required"), MFA] }),
  S("31", "bulkApproveResults", "POST", "/results/bulk-approve", RES_A, R, 200,
    { err: [R_INV_T, L("result_on_hold"), L("self_approval_forbidden"), L("critical_ack_required")] }),
  S("32", "amendResult", "POST", "/results/{result_id}/amend", RES_AM, R, 200,
    { im: true, err: [L("amend_requires_pathologist"), L("amendment_reason_required"), L("result_value_invalid"), R_INV_T, MFA] }),
  S("33", "listResultVersions", "GET", "/results/{result_id}/versions", RES_R, N, 200),
  S("34", "listVerificationQueue", "GET", "/verification-queue", RES_R, N, 200, { err: [CUR], paged: true }),
  S("35", "listCriticalValues", "GET", "/critical-values", CV_R, N, 200, { err: [CUR], paged: true }),
  S("36", "getCriticalValue", "GET", "/critical-values/{critical_event_id}", CV_R, N, 200),
  S("37", "logCriticalNotification", "POST", "/critical-values/{critical_event_id}/notifications", L("critical_value.log_notification"), R, 201),
  S("38", "listIngestExceptions", "GET", "/ingest-exceptions", RES_R, N, 200, { err: [CUR], paged: true }),
  S("39", "getIngestException", "GET", "/ingest-exceptions/{exception_id}", RES_R, N, 200),
  S("40", "assignIngestException", "POST", "/ingest-exceptions/{exception_id}/assign", RES_E, R, [200, 201]),
  S("41", "reapplyIngestException", "POST", "/ingest-exceptions/{exception_id}/reapply", RES_E, O, 200),
  S("42", "discardIngestException", "POST", "/ingest-exceptions/{exception_id}/discard", RES_E, O, 200),
  S("43", "listQcResults", "GET", "/qc-results", QC, N, 200, { err: [CUR], paged: true }),
  S("44", "captureQcResult", "POST", "/qc-results", QC, R, 201),
  S("45", "listQcHolds", "GET", "/qc-holds", RES_R, N, 200),
  S("46", "releaseQcHold", "POST", "/qc-holds/{hold_id}/release", L("qc_hold.release"), O, 200, { err: [MFA] }),
  S("47", "getLabSettings", "GET", "/settings", WL_R, N, 200),
  S("48", "updateLabSettings", "PUT", "/settings", CFG, O, 200, { im: true, err: [MFA] }),
  S("49", "listDeltaCheckRules", "GET", "/delta-check-rules", RES_R, N, 200),
  S("50", "createDeltaCheckRule", "POST", "/delta-check-rules", CFG, R, 201, { err: [MFA] }),
  S("51", "versionDeltaCheckRule", "POST", "/delta-check-rules/{rule_id}/versions", CFG, R, [200, 201], { im: true, err: [MFA] }),
  S("52", "deactivateDeltaCheckRule", "POST", "/delta-check-rules/{rule_id}/deactivate", CFG, O, 200, { im: true, err: [MFA] }),
  S("53", "listLabCodedSet", "GET", "/coded-sets/{set_name}", SP_R, N, 200),
  S("54", "upsertLabCode", "PUT", "/coded-sets/{set_name}/codes/{code}", CFG, O, 200, { im: true, err: [MFA] }),
];
const TOTAL = 55;
const BULK = ["bulkCollectSpecimens", "bulkDispatchSpecimens", "bulkReceiveSpecimens", "bulkVerifyResults", "bulkApproveResults"];
const DTOS = ["SpecimenDto", "SpecimenDetailDto", "LabelDataDto", "LabOrderDto", "WorklistItemDto", "PendingItemDto", "WorksheetDto",
  "ResultDto", "ResultVersionDto", "CriticalNotificationDto", "QcResultDto", "LabSettingsDto"];

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("lab.yaml (T0C-10.C5)", () => {
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
  const schema = (n: string) => doc.components?.schemas?.[n];
  const prop = (n: string, f: string) => deref(props(schema(n))[f]);
  const bodySchema = (id: string) => deref(ops[id].op.requestBody?.content?.["application/json"]?.schema);
  const bp = (id: string, f: string) => deref(props(bodySchema(id))[f]);
  const params = (id: string) => (ops[id].op.parameters ?? []).map(deref);
  const param = (id: string, pname: string) => params(id).find((p: any) => p?.name === pname);
  const okSchema = (id: string) => {
    const [, r] = Object.entries<any>(ops[id].op.responses).find(([c]) => /^2/.test(c))!;
    return deref(deref(r).content?.["application/json"]?.schema);
  };
  const has = (id: string) => expect(ops[id], `${id} missing`).toBeDefined();

  describe("exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
    it("file exists", () => expect(existsSync(FILE), "contracts/openapi/lab.yaml missing").toBe(true));
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
  });

  describe("repo spec lint is green (AC-0C-1.4, rules 1–8, AB-20)", () => {
    it("lintRepo reports no violation", async () => {
      expect(existsSync(FILE), "contracts/openapi/lab.yaml missing").toBe(true);
      const v = (await lintRepo(ROOT)).filter((x) => x.file === name);
      expect(v, v.map((x) => `[rule ${x.rule}] ${x.message}`).join("\n")).toEqual([]);
    });
  });

  describe("lint actually checks this file (AC-0C-1.5 negative)", () => {
    const mutate = async (fn: (d: any) => void) => {
      expect(existsSync(FILE), "contracts/openapi/lab.yaml missing").toBe(true);
      const dir = mkdtempSync(join(tmpdir(), "c5-lab-lint-"));
      tmps.push(dir);
      cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
      const d = parse(readFileSync(FILE, "utf8"));
      fn(d);
      writeFileSync(join(dir, "contracts/openapi/lab.yaml"), stringify(d, { aliasDuplicateObjects: false }));
      return (await lintRepo(dir)).filter((x) => x.file === name);
    };
    const firstOp = (d: any, pred: (o: any) => boolean) =>
      Object.values<any>(d.paths).flatMap((p) => METHODS.map((m) => p[m]).filter(Boolean)).find(pred);

    it("x-permission not in permissions.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = "lab.no_such.permission"; });
      expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
    });
    it("x-error-codes entry not in errors.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push("lab.no_such_error"); });
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

  describe("inventory equals 02-TRD §5 (no missing, no extra operations)", () => {
    it(`${TOTAL} operations; table ids unique; file has exactly these`, () => {
      expect(SPECS.length).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.id)).size).toBe(TOTAL);
      expect(Object.keys(ops).sort()).toEqual(SPECS.map((s) => s.id).sort());
    });
    it("every operationId named in the TRD tables §5.1–§5.8 is in the test table (TRD drift guard)", () => {
      const lines = readFileSync(TRD, "utf8").split("\n");
      const start = lines.findIndex((l) => l.startsWith("### 5.1 "));
      const end = lines.findIndex((l, i) => i > start && l.startsWith("### 5.9 "));
      const fromTrd = new Set<string>();
      for (const l of lines.slice(start, end)) {
        const c = l.split("|");
        if (/^\s*\d+a?\s*$/.test(c[1] ?? "") && c[3]) for (const m of c[3].matchAll(/`([a-z][A-Za-z0-9]+)`/g)) fromTrd.add(m[1]);
      }
      expect(fromTrd.size).toBe(TOTAL);
      const mine = new Set(SPECS.map((s) => s.id));
      for (const id of fromTrd) expect(mine.has(id), `TRD operationId ${id} not in test table`).toBe(true);
    });
    it("every path is /v1/lab/… with tags [lab]; no human-number path params (REQ-SEC-098); lookup is POST not a barcode URL", () => {
      expect(Object.keys(doc.paths ?? {}).length, "no paths").toBeGreaterThan(0);
      for (const [p, item] of Object.entries<any>(doc.paths ?? {})) {
        expect(p.startsWith(`${PFX}/`), p).toBe(true);
        expect(p).not.toMatch(/\{(registration_no|invoice_no|barcode|phone)\}/);
        for (const m of METHODS) if (item[m]) expect(item[m].tags, `${m} ${p}`).toEqual([name]);
      }
      for (const p of params("listSpecimens").map((x: any) => x?.name)) expect(p).not.toBe("barcode");
    });
  });

  describe.each(SPECS)("#$n $id", (r) => {
    const o = ops[r.id]?.op;
    it("exists at the TRD method + path", () => {
      has(r.id);
      expect(`${ops[r.id].method} ${ops[r.id].path}`).toBe(`${r.method} ${PFX}${r.path}`);
    });
    it("has tags, summary, x-idempotency (TRD Idem), tier general, x-error-codes", () => {
      expect(o.tags).toEqual([name]);
      expect(typeof o.summary).toBe("string");
      expect(o["x-idempotency"]).toBe(r.idem);
      expect(o["x-rate-limit-tier"]).toBe("general");
      expect(Array.isArray(o["x-error-codes"])).toBe(true);
    });
    it(`x-permission = ${r.perm}, never x-public; security bearerJwt; tenant context only`, () => {
      expect(o["x-permission"]).toBe(r.perm);
      expect(o["x-public"]).toBeUndefined();
      expect(o.security).toEqual([{ bearerJwt: [] }]);
      expect([undefined, "tenant"]).toContain(o["x-context"]);
      expect([undefined, "internal"]).toContain(o["x-edge-exposure"]);
    });
    it("success response status; POST with idem none carries an E3 justification (LD-10: read-only POST)", () => {
      const want = ([] as number[]).concat(r.status).map(String);
      expect(Object.keys(o.responses ?? {}).some((c) => want.includes(c)), `want one of ${want}`).toBe(true);
      if (r.method === "POST" && r.idem === "none") {
        expect(o["x-idempotency-justification"]).toMatch(/^E3 /);
        expect(o["x-idempotency-justification"]).toMatch(/readiness/i);
      }
    });
    it("lists the TRD extra error codes plus the six common codes (+ If-Match codes on IM rows)", () => {
      const common6 = ["common.validation_failed", "common.not_found", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"];
      const imCodes = r.im ? [VC, PRE] : [];
      for (const c of [...common6, ...imCodes, ...(r.err ?? [])]) expect(o["x-error-codes"], c).toContain(c);
      if (!r.im) expect(o["x-error-codes"]).not.toContain(PRE);
    });
    it("Idempotency-Key where x-idempotency required; If-Match exactly on the TRD §3.2 list", () => {
      const ps = JSON.stringify(o.parameters ?? []);
      if (r.idem === "required") expect(ps).toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.idem === "none") expect(ps).not.toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.im) expect(ps).toMatch(/IfMatch|If-Match/);
      else expect(ps).not.toMatch(/IfMatch|If-Match/);
    });
    if (r.paged)
      it("takes cursor + limit", () => {
        const ps = JSON.stringify(o.parameters ?? []);
        expect(ps).toMatch(/cursor|Cursor/);
        expect(ps).toMatch(/limit|Limit/);
      });
  });

  describe("shape pins from TRD §5", () => {
    it("named DTO schemas are components", () => {
      for (const n of DTOS) expect(schema(n), n).toBeDefined();
    });
    it("request bodies are JSON only; no tenant_id / created_by in any request body (rule 7)", () => {
      expect(Object.keys(ops).length, "no operations").toBe(TOTAL);
      for (const [id, { op }] of Object.entries(ops)) {
        const b = op.requestBody?.content ?? {};
        for (const k of Object.keys(b)) expect(k, id).toBe("application/json");
        const s = deref(b["application/json"]?.schema);
        if (s) for (const f of ["tenant_id", "created_by", "updated_by"]) expect(Object.keys(props(s)), `${id}.${f}`).not.toContain(f);
      }
    });
    it("bulk bodies: items[{id, version}] ≤ 200, no `ids` (CR-C5-011)", () => {
      for (const id of BULK) {
        has(id);
        const items = bp(id, "items");
        expect(items.maxItems, id).toBe(200);
        expect(reqd(items.items), id).toEqual(expect.arrayContaining(["id", "version"]));
        expect(Object.keys(props(bodySchema(id))), id).not.toContain("ids");
        expect(reqd(bodySchema(id)), id).toContain("items");
      }
      expect(reqd(bodySchema("bulkReceiveSpecimens"))).toContain("processing_centre_id");
      expect(Object.keys(props(deref(bp("bulkVerifyResults", "items")).items))).toContain("acknowledged_flags");
    });
    it("lookupSpecimenByBarcode: oneOf barcode ^[A-Z0-9]{1,20}$ | registration_no ^[A-Z0-9]{1,40}$ (body, never URL)", () => {
      has("lookupSpecimenByBarcode");
      const b = bodySchema("lookupSpecimenByBarcode");
      const branches = (b.oneOf ?? []).map(deref);
      expect(branches.length).toBe(2);
      const pat = (f: string) => branches.map((x: any) => deref(props(x)[f])?.pattern).find(Boolean);
      expect(pat("barcode")).toBe("^[A-Z0-9]{1,20}$");
      expect(pat("registration_no")).toBe("^[A-Z0-9]{1,40}$");
      for (const x of branches) expect(x.additionalProperties).toBe(false);
    });
    it("listSpecimens params: filters, sort enum, is_active default true, limit default 50 max 200", () => {
      const names = params("listSpecimens").map((p: any) => p?.name);
      expect(names).toEqual(expect.arrayContaining(["order_id", "status", "centre_id", "processing_centre_id", "priority",
        "received_at_from", "received_at_to", "is_active", "sort", "cursor", "limit"]));
      expect(deref(param("listSpecimens", "sort").schema).enum).toEqual(["-created_at", "received_at", "-received_at"]);
      expect(deref(param("listSpecimens", "is_active").schema).default).toBe(true);
    });
    it("collectSpecimen: collected_at optional IsoUtc; receiveSpecimen: processing_centre_id required", () => {
      expect(reqd(bodySchema("collectSpecimen"))).not.toContain("collected_at");
      expect(Object.keys(props(bodySchema("collectSpecimen")))).toContain("collected_at");
      expect(reqd(bodySchema("receiveSpecimen"))).toContain("processing_centre_id");
    });
    it("rejectSpecimen: reason_code coded set lab.rejection_reasons (no enum), comment ≤ 500, recollection_required; response specimen + recollection_specimen", () => {
      const b = bodySchema("rejectSpecimen");
      expect(reqd(b)).toEqual(expect.arrayContaining(["reason_code", "recollection_required"]));
      expect(bp("rejectSpecimen", "reason_code")["x-coded-set"]).toBe("lab.rejection_reasons");
      expect(bp("rejectSpecimen", "reason_code").enum).toBeUndefined();
      expect(bp("rejectSpecimen", "comment").maxLength).toBe(500);
      expect(bp("rejectSpecimen", "recollection_required").type).toBe("boolean");
      expect(Object.keys(props(okSchema("rejectSpecimen")))).toEqual(expect.arrayContaining(["specimen", "recollection_specimen"]));
      expect(reqd(okSchema("rejectSpecimen"))).not.toContain("recollection_specimen");
    });
    it("createAliquots: 1..10 aliquots, test_ids ≥ 1; store location ≤ 120; discard reason ≤ 200", () => {
      const a = bp("createAliquots", "aliquots");
      expect([a.minItems, a.maxItems]).toEqual([1, 10]);
      expect(deref(props(a.items).test_ids).minItems).toBe(1);
      expect(reqd(a.items)).toContain("test_ids");
      expect(bp("storeSpecimen", "location").maxLength).toBe(120);
      expect(bp("discardSpecimen", "discard_reason").maxLength).toBe(200);
    });
    it("printSpecimenLabels: copies 1..5, specimen_ids ≤ 200; response labels/errors/size/label_copies_default", () => {
      const c = bp("printSpecimenLabels", "copies");
      expect([c.minimum, c.maximum]).toEqual([1, 5]);
      expect(bp("printSpecimenLabels", "specimen_ids").maxItems).toBe(200);
      expect(Object.keys(props(bodySchema("printSpecimenLabels")))).toContain("order_id");
      const rs = okSchema("printSpecimenLabels");
      expect(Object.keys(props(rs))).toEqual(expect.arrayContaining(["labels", "errors", "size", "label_copies_default"]));
      expect(Object.keys(props(props(rs).size))).toEqual(expect.arrayContaining(["width_mm", "height_mm"]));
      const d = deref(props(rs).label_copies_default);
      expect([d.minimum, d.maximum]).toEqual([1, 5]);
    });
    it("requestOrderLabelPrint: empty body (no copies); response order_id, specimens[outcome ready|inactive], labels_route", () => {
      expect(Object.keys(props(bodySchema("requestOrderLabelPrint")))).not.toContain("copies");
      const rs = okSchema("requestOrderLabelPrint");
      expect(Object.keys(props(rs))).toEqual(expect.arrayContaining(["order_id", "specimens", "labels_route"]));
      const sp = deref(deref(props(rs).specimens).items);
      expect(Object.keys(props(sp))).toEqual(expect.arrayContaining(["specimen_id", "barcode", "outcome"]));
      expect(deref(props(sp).outcome).enum).toEqual(["ready", "inactive"]);
    });
    it("getStatusBoard: registered_at_from required; board_status csv; response rows have no raw phone", () => {
      expect(param("getStatusBoard", "registered_at_from").required).toBe(true);
      expect(params("getStatusBoard").map((p: any) => p?.name)).toEqual(expect.arrayContaining(["centre_id", "registered_at_to", "board_status"]));
      const row = deref(deref(props(okSchema("getStatusBoard")).data).items);
      expect(Object.keys(props(row))).toEqual(expect.arrayContaining(["order_id", "registration_no", "patient_display", "centre_id", "board_status",
        "rejected_specimens", "priority"]));
      expect(JSON.stringify(row)).not.toMatch(/phone|email/i);
      const bs = JSON.stringify(deref(props(row).board_status)) + JSON.stringify(param("getStatusBoard", "board_status"));
      for (const v of ["collected", "in_lab", "ready", "printed", "waiting"]) expect(bs).toContain(v);
    });
    it("listWorklistItems / listPendingItems / listVerificationQueue enums", () => {
      const enumsOf = (id: string, p: string) => JSON.stringify(param(id, p));
      for (const v of ["in_process", "resulted", "verified"]) expect(enumsOf("listWorklistItems", "status")).toContain(v);
      expect(enumsOf("listWorklistItems", "sort")).toContain("priority_received");
      for (const v of ["awaiting_collection", "awaiting_receipt", "in_process", "resulted", "verified"]) expect(enumsOf("listPendingItems", "item_status")).toContain(v);
      expect(param("listPendingItems", "over_target")).toBeDefined();
      expect(param("listVerificationQueue", "stage").required).toBe(true);
      expect(deref(param("listVerificationQueue", "stage").schema).enum).toEqual(["verify", "approve"]);
      const age = Object.keys(props(deref(deref(props(okSchema("listPendingItems")).data).items)));
      expect(age).toEqual(expect.arrayContaining(["age_seconds", "age_anchor"]));
    });
    it("createWorksheet: title ≤ 80, order_test_ids 1..200 required, centre_id optional", () => {
      const b = bodySchema("createWorksheet");
      expect(reqd(b)).toEqual(expect.arrayContaining(["title", "order_test_ids"]));
      expect(reqd(b)).not.toContain("centre_id");
      expect(bp("createWorksheet", "title").maxLength).toBe(80);
      const t = bp("createWorksheet", "order_test_ids");
      expect([t.minItems, t.maxItems]).toEqual([1, 200]);
    });
    it("bulkEnterResults: entries 1..200; value / ordinal / comment bounds; response results + recomputed", () => {
      const e = bp("bulkEnterResults", "entries");
      expect([e.minItems, e.maxItems]).toEqual([1, 200]);
      expect(reqd(e.items)).toEqual(expect.arrayContaining(["result_id", "version"]));
      const f = (k: string) => deref(props(e.items)[k]);
      expect(f("value_text").maxLength).toBe(2000);
      expect(f("ordinal_code").pattern).toBe("^[A-Z0-9_+\\-]{1,16}$");
      expect(f("comment_codes").maxItems).toBe(10);
      expect(f("comment_text").maxLength).toBe(1000);
      expect(Object.keys(props(e.items))).toEqual(expect.arrayContaining(["value_numeric", "manual_abnormal"]));
      const rs = okSchema("bulkEnterResults");
      expect(Object.keys(props(rs))).toEqual(expect.arrayContaining(["results", "recomputed"]));
      expect(deref(props(deref(deref(props(rs).results).items)).outcome).enum).toEqual(["ok", "error"]);
    });
    it("getResultHistory limit 1..20 default 5; getAnalyteTrend limit 1..50 default 50", () => {
      const h = deref(param("getResultHistory", "limit").schema);
      expect([h.minimum, h.maximum, h.default]).toEqual([1, 20, 5]);
      const t = deref(param("getAnalyteTrend", "limit").schema);
      expect([t.minimum, t.maximum, t.default]).toEqual([1, 50, 50]);
      expect(Object.keys(props(okSchema("getAnalyteTrend")))).toContain("points");
    });
    it("verifyResult acknowledged_flags enum; returnResult / amendResult coded sets and bounds", () => {
      const fl = deref(bp("verifyResult", "acknowledged_flags").items);
      expect(fl.enum).toEqual(["delta", "critical", "unit_mismatch", "instrument_flag"]);
      expect(reqd(bodySchema("returnResult"))).toContain("reason_code");
      expect(bp("returnResult", "reason_code")["x-coded-set"]).toBe("lab.return_reasons");
      expect(bp("returnResult", "comment").maxLength).toBe(500);
      expect(reqd(bodySchema("amendResult"))).toContain("amendment_reason_code");
      expect(bp("amendResult", "amendment_reason_code")["x-coded-set"]).toBe("lab.amendment_reasons");
      expect(bp("amendResult", "amendment_reason_text").maxLength).toBe(500);
      expect(Object.keys(props(bodySchema("amendResult")))).toEqual(expect.arrayContaining(["value_numeric", "value_text", "ordinal_code", "comment_codes", "comment_text"]));
    });
    it("logCriticalNotification: enums, bounds, read_back_text, required set", () => {
      const b = bodySchema("logCriticalNotification");
      expect(reqd(b)).toEqual(expect.arrayContaining(["notified_party_kind", "notified_party_name", "contact_method", "notified_at", "outcome", "read_back_confirmed"]));
      expect(bp("logCriticalNotification", "notified_party_kind").enum).toEqual(["referrer", "clinician", "ward", "patient", "other"]);
      expect(bp("logCriticalNotification", "contact_method").enum).toEqual(["phone", "sms", "in_person", "whatsapp", "other"]);
      expect(bp("logCriticalNotification", "outcome").enum).toEqual(["reached", "not_reached", "left_message"]);
      const n = bp("logCriticalNotification", "notified_party_name");
      expect([n.minLength, n.maxLength]).toEqual([1, 120]);
      expect(bp("logCriticalNotification", "contact_detail").maxLength).toBe(60);
      expect(bp("logCriticalNotification", "read_back_text").maxLength).toBe(300);
      expect(bp("logCriticalNotification", "comment").maxLength).toBe(500);
      expect(reqd(b)).not.toContain("read_back_text");
    });
    it("getCriticalValue exposes optional referrer_display_name (resolved server-side)", () => {
      const rs = okSchema("getCriticalValue");
      expect(Object.keys(props(rs))).toContain("referrer_display_name");
      expect(reqd(rs)).not.toContain("referrer_display_name");
    });
    it("ingest exceptions: assign result_id required + override_analyte boolean; discard coded set + comment ≤ 300", () => {
      expect(reqd(bodySchema("assignIngestException"))).toContain("result_id");
      expect(bp("assignIngestException", "override_analyte").type).toBe("boolean");
      expect(reqd(bodySchema("discardIngestException"))).toContain("reason_code");
      expect(bp("discardIngestException", "reason_code")["x-coded-set"]).toBe("lab.exception_discard_reasons");
      expect(bp("discardIngestException", "comment").maxLength).toBe(300);
      for (const v of ["open", "resolved", "discarded"]) expect(JSON.stringify(param("listIngestExceptions", "status"))).toContain(v);
    });
    it("captureQcResult: bounds + required set; server-set columns are not request properties (#44)", () => {
      const b = bodySchema("captureQcResult");
      expect(reqd(b)).toEqual(expect.arrayContaining(["centre_id", "instrument_id", "analyte_id", "control_id_raw", "value_numeric", "instrument_result_time"]));
      expect(bp("captureQcResult", "control_id_raw").maxLength).toBe(64);
      expect(bp("captureQcResult", "control_lot_raw").maxLength).toBe(64);
      expect(bp("captureQcResult", "control_level").maxLength).toBe(16);
      for (const k of ["source", "entered_by_membership_id", "value_raw", "received_at", "idempotency_key", "mapping_status"])
        expect(Object.keys(props(b)), k).not.toContain(k);
    });
    it("releaseQcHold: comment 1..500 required; listQcHolds status enum active|released", () => {
      expect(reqd(bodySchema("releaseQcHold"))).toContain("comment");
      const c = bp("releaseQcHold", "comment");
      expect([c.minLength, c.maxLength]).toEqual([1, 500]);
      for (const v of ["active", "released"]) expect(JSON.stringify(param("listQcHolds", "status"))).toContain(v);
    });
    it("delta-check rules: window_seconds 3600..31536000, thresholds, unit_code; versions body has no analyte_id", () => {
      const b = bodySchema("createDeltaCheckRule");
      expect(reqd(b)).toEqual(expect.arrayContaining(["analyte_id", "window_seconds", "unit_code"]));
      const w = bp("createDeltaCheckRule", "window_seconds");
      expect([w.minimum, w.maximum]).toEqual([3600, 31536000]);
      expect(Object.keys(props(b))).toEqual(expect.arrayContaining(["abs_threshold", "pct_threshold", "effective_from"]));
      expect(Object.keys(props(bodySchema("versionDeltaCheckRule")))).not.toContain("analyte_id");
      expect(Object.keys(props(bodySchema("versionDeltaCheckRule")))).toEqual(expect.arrayContaining(["window_seconds", "unit_code"]));
    });
    it("coded sets: set_name enum of the four TRD names; upsert body display 1..120, sort_order integer, is_active boolean", () => {
      const sets = ["rejection_reasons", "return_reasons", "amendment_reasons", "exception_discard_reasons"];
      expect(deref(param("listLabCodedSet", "set_name").schema).enum).toEqual(sets);
      expect(deref(param("upsertLabCode", "set_name").schema).enum).toEqual(sets);
      expect(param("upsertLabCode", "code")).toBeDefined();
      const b = bodySchema("upsertLabCode");
      expect(reqd(b)).toEqual(expect.arrayContaining(["display", "sort_order", "is_active"]));
      const d = bp("upsertLabCode", "display");
      expect([d.minLength, d.maxLength]).toEqual([1, 120]);
      expect(bp("upsertLabCode", "sort_order").type).toBe("integer");
      expect(bp("upsertLabCode", "is_active").type).toBe("boolean");
      const row = deref(deref(props(okSchema("listLabCodedSet")).data).items);
      expect(deref(props(row).source).enum).toEqual(["global", "tenant"]);
    });
    it("SpecimenDto allowlist (REQ-SEC-081): TRD fields only; rejection_comment only on SpecimenDetailDto", () => {
      const keys = Object.keys(props(schema("SpecimenDto")));
      expect(keys).toEqual(expect.arrayContaining(["id", "version", "barcode", "order_id", "registration_no", "specimen_type_code", "container_code",
        "status", "priority", "centre_id", "processing_centre_id", "parent_specimen_id", "replaces_specimen_id", "is_active", "collected_at",
        "in_transit_at", "received_at", "rejected_at", "rejection_reason_code", "collection_barcode_unverified", "label_print_count", "tests"]));
      expect(keys).not.toContain("rejection_comment");
      expect(keys).not.toContain("tenant_id");
      expect(Object.keys(props(schema("SpecimenDetailDto")))).toContain("rejection_comment");
    });
    it("ResultDto allowlist (REQ-SEC-081): TRD fields; no tenant_id / patient name", () => {
      const keys = Object.keys(props(schema("ResultDto")));
      expect(keys).toEqual(expect.arrayContaining(["id", "version", "order_id", "order_item_id", "specimen_id", "test_id", "analyte_id", "analyte_code",
        "status", "origin", "value_numeric", "value_text", "ordinal_code", "unit_code", "flag", "reference_range_snapshot", "range_unavailable_age_unknown",
        "delta", "critical", "calc", "comment_codes", "comment_text", "on_hold", "qc_review_required", "unit_mismatch", "instrument_id",
        "instrument_flags", "current_version_no", "verified_at", "verified_by", "approved_at", "approved_by", "amendment"]));
      for (const k of ["tenant_id", "full_name", "patient_name", "phone_e164", "email"]) expect(keys, k).not.toContain(k);
      expect(Object.keys(props(prop("ResultDto", "delta")))).toEqual(expect.arrayContaining(["status", "prev_value", "abs", "pct", "prev_at"]));
      expect(Object.keys(props(prop("ResultDto", "critical")))).toEqual(expect.arrayContaining(["is_critical", "critical_event_id"]));
    });
    it("patient_display carries full_name, age_sex, patient_code only (from FrontdeskPort lab_display)", () => {
      const pd = deref(props(deref(deref(props(okSchema("getStatusBoard")).data).items)).patient_display);
      expect(Object.keys(props(pd)).sort()).toEqual(["age_sex", "full_name", "patient_code"]);
    });
  });

  // ---------- "Prism smoke", offline: examples validate against their schemas ----------
  describe("examples validate against their schemas; each operation has a servable example (Prism smoke); examples are synthetic", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...doc, id: "lab.yaml" });
    const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    const check = (ptr: string, example: unknown) => {
      const validate = ajv.getSchema(`lab.yaml#${ptr}`);
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
    it("every JSON request/response example matches its schema; at least one per operation", () => {
      expect(existsSync(FILE), "contracts/openapi/lab.yaml missing").toBe(true);
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
      expect(n).toBeGreaterThanOrEqual(TOTAL);
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
    it("examples are synthetic: no e-mail, no Nepali-mobile-shaped number, no Windows/user paths", () => {
      expect(existsSync(FILE), "contracts/openapi/lab.yaml missing").toBe(true);
      const vals = exampleValues();
      expect(vals.length, "no examples at all").toBeGreaterThan(0);
      const blob = JSON.stringify(vals);
      expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
      expect(blob).not.toMatch(/(?<!\d)(?:\+?977[-\s]?)?9[678]\d{8}(?!\d)/);
      expect(blob).not.toMatch(/[A-Z]:\\\\|\/Users\/|\/home\//);
    });
  });
});
