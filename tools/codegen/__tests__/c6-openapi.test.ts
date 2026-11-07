// T0C-10.C6 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/reporting.yaml (C6 transcription of spec/chunks/C6-reporting-delivery/02-TRD.md §6.2–§6.7).
// Checks: (1) exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) clean for reporting.yaml; (3) AC-0C-1.5 negatives on a temp copy
// (bad x-permission / error code / additionalProperties / tier); (4) inventory = TRD tables (68 ops: R1–R18, D1–D4, O1–O6, N1–N10, T1–T6,
// M1–M2, C1–C3, S1–S7, P1–P7, PP1–PP2, Q1, CB1, CB2), method+path, x-permission | x-public, security scheme, x-idempotency, rate tier,
// success status, specific + common error codes, Idempotency-Key / If-Match; (5) shape pins (bulk ≤ 200, bounds, enums, coded sets, DTO
// allowlists, file-download headers, upload allowlists, no PHI params, portal/public rules); (6) "Prism smoke" offline: examples validate
// (ajv), every op has a servable 2xx example, examples synthetic (no e-mail / mobile number / paths).
// Not testable here: Prism actually serving the file (prism not installed; mock wiring is T0C-08's mocks.test.ts).
// Assumptions (TRD silent): staff ops list the six common codes; portal ops list validation_failed, rate_limited, internal + reporting.link_invalid
// (TRD §6.6: resolver failure for every portal op); public ops list validation_failed, rate_limited, internal. POST with idem `none`:
// C3 = `E1 `, P1/P2/P5 = `E2 `, R2 + Q1 (read-only POST) = `E3 `, CB1 any `E1`–`E4`. If-Match is a parameter exactly on the rows whose Request
// column names it (R6 R8 D4 O3 O4 N3 N4 N5 N10 T4 T6 M2 C3 S2 S5); M2's If-Match is optional (absent = create) so M2 lists version_conflict only.
// Composite permissions (P-10: R2, R10, N7): x-permission is the floor; the operation description names the conditional permission.
// Coded-set names: `reporting.<set>` or the bare set name. Download ops (R5 R12 O5 P4 N7) carry Content-Disposition / Cache-Control / nosniff headers.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRD = join(ROOT, "spec/chunks/C6-reporting-delivery/02-TRD.md");
const FILE = join(ROOT, "contracts/openapi/reporting.yaml");
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const METHODS = ["get", "put", "post", "delete", "patch"];
const name = "reporting";
const PFX = "/v1/reporting";

const RP = (s: string) => `reporting.${s}`;
const READ = RP("report.read"), REL = RP("report.release"), BULKREL = RP("report.bulk_release"), RENDER = RP("report.render"), REGEN = RP("report.regenerate");
const PRINT = RP("report.print"), BULKDL = RP("report.bulk_download"), REVOKE = RP("token.revoke"), DREAD = RP("delivery.read"), DRESEND = RP("delivery.resend");
const OUT = RP("outsourced.attach"), NW = RP("narrative.write"), NS = RP("narrative.sign"), TPL = RP("template.manage"), MSG = RP("message_template.manage");
const CHAN = RP("channel.manage"), SET = RP("settings.manage"), PV = RP("portal.view"), PDL = RP("portal.download"), PCH = RP("portal.challenge");
const VC = "common.version_conflict", PRE = "common.precondition_required", CUR = "common.invalid_cursor", MFA = "auth.mfa_required", IMM = "common.immutable_record";
const NOTREL = RP("report_not_released"), CANC = RP("report_cancelled"), TINV = RP("template_invalid"), INF = RP("input_file_not_ready"), OTPREQ = RP("otp_required");
const LINK = RP("link_invalid");

type Kind = "staff" | "portal" | "public";
type Spec = { n: string; id: string; method: string; path: string; perm: string; idem: "none" | "optional" | "required"; status: number | number[];
  im?: boolean; err?: string[]; paged?: boolean; k: Kind; tier: string; just?: RegExp };
const S = (n: string, id: string, method: string, path: string, perm: string, idem: Spec["idem"], status: Spec["status"],
  o: { im?: boolean; err?: string[]; paged?: boolean; k?: Kind; tier?: string; just?: RegExp } = {}): Spec =>
  ({ n, id, method, path, perm, idem, status, k: "staff", tier: "general", ...o });
const O = "optional" as const, R = "required" as const, N = "none" as const;
const PT = { k: "portal" as Kind }, PUB = { k: "public" as Kind };

const SPECS: Spec[] = [
  S("R1", "listReports", "GET", "/reports", READ, N, 200, { err: [CUR], paged: true }),
  S("R2", "searchReports", "POST", "/reports/search", READ, N, 200, { just: /^E3 / }),
  S("R3", "getReport", "GET", "/reports/{report_id}", READ, N, 200),
  S("R4", "getReportVersion", "GET", "/report-versions/{report_version_id}", READ, N, 200),
  S("R5", "downloadReportVersionPdf", "GET", "/report-versions/{report_version_id}/pdf", READ, N, 200, { err: [NOTREL] }),
  S("R6", "releaseReportVersion", "POST", "/report-versions/{report_version_id}/release", REL, R, 200,
    { im: true, err: [RP("release_blocked_due"), RP("release_not_ready"), RP("version_not_latest"), CANC] }),
  S("R7", "bulkReleaseReportVersions", "POST", "/report-versions/bulk-release", BULKREL, R, 200, { err: [RP("bulk_release_too_large"), MFA] }),
  S("R8", "retryRenderReportVersion", "POST", "/report-versions/{report_version_id}/retry-render", RENDER, R, 202, { im: true, err: [IMM] }),
  S("R9", "regenerateReport", "POST", "/reports/{report_id}/regenerations", REGEN, R, 202, { err: [CANC, MFA] }),
  S("R10", "createReportPrint", "POST", "/report-versions/{report_version_id}/prints", PRINT, R, 201, { err: [NOTREL] }),
  S("R11", "getReportPrint", "GET", "/prints/{print_id}", PRINT, N, 200),
  S("R12", "downloadReportPrintPdf", "GET", "/prints/{print_id}/pdf", PRINT, N, 200, { err: [RP("print_not_ready")] }),
  S("R13", "createBulkPrint", "POST", "/report-versions/bulk-prints", BULKDL, R, 202, { err: [NOTREL] }),
  S("R14", "revokeReportQrToken", "POST", "/report-versions/{report_version_id}/qr-token/revoke", REVOKE, R, 200),
  S("R15", "listPortalLinks", "GET", "/reports/{report_id}/portal-links", DREAD, N, 200),
  S("R16", "revokePortalLink", "POST", "/portal-links/{link_id}/revoke", REVOKE, R, 200),
  S("R17", "listReportingCodes", "GET", "/coded-sets/{set_name}", READ, N, 200),
  S("R18", "listCriticalAlerts", "GET", "/critical-alerts", READ, N, 200, { err: [CUR], paged: true }),
  S("D1", "listDeliveries", "GET", "/deliveries", DREAD, N, 200, { paged: true }),
  S("D2", "getDelivery", "GET", "/deliveries/{delivery_id}", DREAD, N, 200),
  S("D3", "sendReportDelivery", "POST", "/reports/{report_id}/deliveries", DRESEND, R, 201, { err: [NOTREL, RP("channel_not_configured")] }),
  S("D4", "retryDelivery", "POST", "/deliveries/{delivery_id}/retry", DRESEND, R, 201, { im: true, err: [IMM] }),
  S("O1", "uploadOutsourcedReport", "POST", "/order-items/{order_item_id}/outsourced-files", OUT, R, 201,
    { err: ["common.payload_too_large", "common.unsupported_media_type", RP("outsourced_pdf_rejected")] }),
  S("O2", "listOutsourcedReports", "GET", "/order-items/{order_item_id}/outsourced-files", OUT, N, 200),
  S("O3", "confirmOutsourcedReport", "POST", "/outsourced-files/{file_id}/confirm", OUT, R, 200, { im: true, err: [INF, RP("outsourced_pdf_rejected")] }),
  S("O4", "withdrawOutsourcedReport", "POST", "/outsourced-files/{file_id}/withdraw", OUT, R, 200, { im: true, err: [IMM] }),
  S("O5", "downloadOutsourcedReport", "GET", "/outsourced-files/{file_id}/content", OUT, N, 200, { err: [INF] }),
  S("O6", "listOutsourcedItems", "GET", "/outsourced-items", OUT, N, 200, { paged: true }),
  S("N1", "listNarrativeReports", "GET", "/narratives", NW, N, 200, { paged: true }),
  S("N2", "getNarrativeReport", "GET", "/narratives/{narrative_id}", NW, N, 200),
  S("N3", "saveNarrativeDraft", "PUT", "/narratives/{narrative_id}/draft", NW, O, 200, { im: true, err: [RP("narrative_locked"), VC] }),
  S("N4", "signNarrativeReport", "POST", "/narratives/{narrative_id}/sign", NS, R, 200, { im: true, err: [RP("narrative_incomplete"), RP("narrative_locked"), MFA] }),
  S("N5", "startNarrativeAmendment", "POST", "/narratives/{narrative_id}/amendments", NS, R, 201, { im: true, err: [IMM] }),
  S("N6", "uploadNarrativeImage", "POST", "/narratives/{narrative_id}/images", NW, R, 201,
    { err: ["common.payload_too_large", "common.unsupported_media_type", "common.upload_quarantined"] }),
  S("N7", "getNarrativeImageContent", "GET", "/narrative-images/{image_id}/content", READ, N, 200, { err: [INF, "auth.forbidden"] }),
  S("N8", "listNarrativeTemplates", "GET", "/narrative-templates", NW, N, 200),
  S("N9", "createNarrativeTemplate", "POST", "/narrative-templates", TPL, R, 201, { err: [TINV] }),
  S("N10", "updateNarrativeTemplate", "PATCH", "/narrative-templates/{narrative_template_id}", TPL, N, 200, { im: true, err: [TINV] }),
  S("T1", "listReportTemplates", "GET", "/report-templates", TPL, N, 200),
  S("T2", "createReportTemplate", "POST", "/report-templates", TPL, R, 201, { err: [TINV] }),
  S("T3", "getReportTemplate", "GET", "/report-templates/{template_id}", TPL, N, 200),
  S("T4", "updateReportTemplateDraft", "PUT", "/report-templates/{template_id}/draft", TPL, N, 200, { im: true, err: [TINV] }),
  S("T5", "previewReportTemplate", "POST", "/report-templates/{template_id}/previews", TPL, R, 202),
  S("T6", "publishReportTemplate", "POST", "/report-templates/{template_id}/publish", TPL, R, 200, { im: true, err: [TINV] }),
  S("M1", "listMessageTemplates", "GET", "/message-templates", MSG, N, 200),
  S("M2", "upsertMessageTemplateText", "PUT", "/message-templates/{template_code}/texts/{channel}", MSG, N, 200,
    { err: [RP("notification_template_unknown"), RP("notification_params_invalid"), VC] }),
  S("C1", "listChannelAccounts", "GET", "/channel-accounts", CHAN, N, 200),
  S("C2", "upsertChannelAccount", "PUT", "/channel-accounts/{channel}", CHAN, N, 200),
  S("C3", "rotateChannelCallbackToken", "POST", "/channel-accounts/{channel}/callback-token", CHAN, N, 201, { im: true, err: [VC, PRE], just: /^E1 / }),
  S("S1", "getReportingSettings", "GET", "/settings", SET, N, 200),
  S("S2", "updateReportingSettings", "PATCH", "/settings", SET, N, 200, { im: true }),
  S("S3", "listCentreContacts", "GET", "/centre-contacts", SET, N, 200),
  S("S4", "createCentreContact", "POST", "/centre-contacts", SET, R, 201),
  S("S5", "updateCentreContact", "PATCH", "/centre-contacts/{centre_contact_id}", SET, N, 200, { im: true }),
  S("S6", "replaceStaffAssignments", "PUT", "/staff-assignments", SET, N, 200),
  S("S7", "upsertReferrerPreference", "PUT", "/referrer-preferences/{referrer_id}", SET, N, 200),
  S("P1", "createPortalOtpChallenge", "POST", "/portal/otp-challenges", PCH, N, 202, { ...PT, tier: "otp_request", err: [LINK], just: /^E2 / }),
  S("P2", "verifyPortalOtp", "POST", "/portal/otp-challenges/{challenge_id}/verify", PCH, N, 200,
    { ...PT, tier: "otp_verify", err: [LINK, "auth.otp_invalid", "auth.otp_attempts_exhausted"], just: /^E2 / }),
  S("P3", "getPortalReport", "GET", "/portal/report", PV, N, 200, { ...PT, err: [LINK, OTPREQ] }),
  S("P4", "downloadPortalReportPdf", "GET", "/portal/report-versions/{report_version_id}/pdf", PDL, N, 200, { ...PT, tier: "report_download", err: [LINK, OTPREQ] }),
  S("P5", "requestPortalLinkReissue", "POST", "/portal/link-reissues", PCH, N, 202, { ...PT, tier: "otp_request", err: [LINK], just: /^E2 / }),
  S("P6", "endPortalSession", "POST", "/portal/sessions/end", PV, N, 204, { ...PT, err: [LINK, OTPREQ], just: /^E[1-4] / }),
  S("P7", "getPortalDues", "GET", "/portal/dues", PV, N, 200, { ...PT, err: [LINK, OTPREQ] }),
  S("PP1", "createPortalPaymentRequest", "POST", "/portal/payment-requests", PV, R, [200, 202], { ...PT, err: [LINK, OTPREQ, CANC, VC] }),
  S("PP2", "getPortalPaymentRequest", "GET", "/portal/payment-requests/{portal_payment_request_id}", PV, N, 200, { ...PT, err: [LINK, OTPREQ] }),
  S("Q1", "verifyReportQr", "POST", "/verifications", "public", N, 200, { ...PUB, tier: "qr_verify", err: [RP("verify_not_found")], just: /^E3 / }),
  S("CB1", "receiveProviderCallback", "POST", "/provider-callbacks/{callback_token}", "public", N, 200, { ...PUB, err: [RP("callback_rejected")], just: /^E[1-4] / }),
  S("CB2", "verifyProviderCallback", "GET", "/provider-callbacks/{callback_token}", "public", N, 200, { ...PUB, err: [RP("callback_rejected")] }),
];
const TOTAL = 68;
const DOWNLOADS = ["downloadReportVersionPdf", "downloadReportPrintPdf", "downloadOutsourcedReport", "downloadPortalReportPdf", "getNarrativeImageContent"];
const DTOS = ["ReportSummary", "ReportDetail", "ReportVersionSummary", "Delivery", "InputFile", "NarrativeReport", "NarrativeTemplate", "CriticalAlert",
  "PortalPaymentRequest", "PrintJob", "TemplateConfig", "ReportingSettings"];
const PHI_PARAMS = ["barcode", "registration_no", "patient_id", "patient_name", "patient_display_name", "phone", "phone_e164", "email", "full_name", "name"];

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("reporting.yaml (T0C-10.C6)", () => {
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
  const dataItem = (id: string) => deref(deref(props(okSchema(id)).data).items);
  const has = (id: string) => expect(ops[id], `${id} missing`).toBeDefined();
  const csName = (s: any, set: string) => expect(s?.["x-coded-set"], set).toMatch(new RegExp(`^(reporting\\.)?${set}$`));

  describe("exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
    it("file exists", () => expect(existsSync(FILE), "contracts/openapi/reporting.yaml missing").toBe(true));
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
      expect(existsSync(FILE), "contracts/openapi/reporting.yaml missing").toBe(true);
      const v = (await lintRepo(ROOT)).filter((x) => x.file === name);
      expect(v, v.map((x) => `[rule ${x.rule}] ${x.message}`).join("\n")).toEqual([]);
    });
  });

  describe("lint actually checks this file (AC-0C-1.5 negative)", () => {
    const mutate = async (fn: (d: any) => void) => {
      expect(existsSync(FILE), "contracts/openapi/reporting.yaml missing").toBe(true);
      const dir = mkdtempSync(join(tmpdir(), "c6-reporting-lint-"));
      tmps.push(dir);
      cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
      const d = parse(readFileSync(FILE, "utf8"));
      fn(d);
      writeFileSync(join(dir, "contracts/openapi/reporting.yaml"), stringify(d, { aliasDuplicateObjects: false }));
      return (await lintRepo(dir)).filter((x) => x.file === name);
    };
    const firstOp = (d: any, pred: (o: any) => boolean) =>
      Object.values<any>(d.paths).flatMap((p) => METHODS.map((m) => p[m]).filter(Boolean)).find(pred);

    it("x-permission not in permissions.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = "reporting.no_such.permission"; });
      expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
    });
    it("x-error-codes entry not in errors.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push("reporting.no_such_error"); });
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
    it("a public op that also carries x-permission fails (exactly one of x-permission / x-public)", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-public" in o)["x-permission"] = READ; });
      expect(v.some((x) => x.rule === "4" && /exactly one/.test(x.message))).toBe(true);
    });
  });

  describe("inventory equals 02-TRD §6 (no missing, no extra operations)", () => {
    it(`${TOTAL} operations; table ids unique; file has exactly these`, () => {
      expect(SPECS.length).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.id)).size).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.n)).size).toBe(TOTAL);
      expect(Object.keys(ops).sort()).toEqual(SPECS.map((s) => s.id).sort());
    });
    it("every operationId named in the TRD tables §6.2–§6.7 is in the test table (TRD drift guard)", () => {
      const lines = readFileSync(TRD, "utf8").split("\n");
      const start = lines.findIndex((l) => l.startsWith("### 6.2 "));
      const end = lines.findIndex((l, i) => i > start && l.startsWith("## 7. "));
      const fromTrd = new Set<string>();
      for (const l of lines.slice(start, end)) {
        const c = l.split("|");
        if (/^\s*[A-Z]{1,2}\d+\s*$/.test(c[1] ?? "") && c[3]) for (const m of c[3].matchAll(/`([a-z][A-Za-z0-9]+)`/g)) fromTrd.add(m[1]);
      }
      expect(fromTrd.size).toBe(TOTAL);
      const mine = new Set(SPECS.map((s) => s.id));
      for (const id of fromTrd) expect(mine.has(id), `TRD operationId ${id} not in test table`).toBe(true);
    });
    it("every path is /v1/reporting/… with tags [reporting]; no PHI / human-number path or query params (REQ-SEC-098)", () => {
      expect(Object.keys(doc.paths ?? {}).length, "no paths").toBeGreaterThan(0);
      for (const [p, item] of Object.entries<any>(doc.paths ?? {})) {
        expect(p.startsWith(`${PFX}/`), p).toBe(true);
        expect(p).not.toMatch(/\{(registration_no|invoice_no|barcode|phone|patient_id|email)\}/);
        for (const m of METHODS) if (item[m]) expect(item[m].tags, `${m} ${p}`).toEqual([name]);
      }
      for (const [id] of Object.entries(ops))
        for (const q of params(id)) if (q?.in === "query") expect(PHI_PARAMS, `${id}?${q.name}`).not.toContain(q.name);
    });
  });

  describe.each(SPECS)("$n $id", (r) => {
    const o = ops[r.id]?.op;
    it("exists at the TRD method + path", () => {
      has(r.id);
      expect(`${ops[r.id].method} ${ops[r.id].path}`).toBe(`${r.method} ${PFX}${r.path}`);
    });
    it("has tags, summary, x-idempotency (TRD Idem), the TRD rate tier, x-error-codes", () => {
      expect(o.tags).toEqual([name]);
      expect(typeof o.summary).toBe("string");
      expect(o["x-idempotency"]).toBe(r.idem);
      expect(o["x-rate-limit-tier"]).toBe(r.tier);
      expect(Array.isArray(o["x-error-codes"])).toBe(true);
    });
    if (r.k === "public")
      it("public: x-public justification, no x-permission, security []", () => {
        expect(typeof o["x-public"]).toBe("string");
        expect(o["x-public"].length).toBeGreaterThan(10);
        expect(o["x-permission"]).toBeUndefined();
        expect(o.security).toEqual([]);
      });
    else
      it(`x-permission = ${r.perm}, never x-public; security ${r.k === "portal" ? "portalSession" : "bearerJwt"}; tenant context only`, () => {
        expect(o["x-permission"]).toBe(r.perm);
        expect(o["x-public"]).toBeUndefined();
        expect(o.security).toEqual([{ [r.k === "portal" ? "portalSession" : "bearerJwt"]: [] }]);
        expect([undefined, "tenant"]).toContain(o["x-context"]);
      });
    it("success response status(es); POST with idem none carries the TRD justification letter (P-8, LD-10)", () => {
      const want = ([] as number[]).concat(r.status).map(String);
      for (const c of want) expect(Object.keys(o.responses ?? {}), `want ${c}`).toContain(c);
      if (r.method === "POST" && r.idem === "none") {
        expect(o["x-idempotency-justification"]).toMatch(r.just ?? /^E[1-4] /);
      } else expect(o["x-idempotency-justification"] === undefined || typeof o["x-idempotency-justification"] === "string").toBe(true);
    });
    it("lists the TRD specific error codes plus the common codes (+ If-Match codes on IM rows)", () => {
      const six = ["common.validation_failed", "common.not_found", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"];
      const base = r.k === "staff" ? six : ["common.validation_failed", "common.rate_limited", "common.internal"];
      const imCodes = r.im ? (r.id === "upsertMessageTemplateText" ? [VC] : [VC, PRE]) : [];
      for (const c of [...base, ...imCodes, ...(r.err ?? [])]) expect(o["x-error-codes"], c).toContain(c);
      if (!r.im) expect(o["x-error-codes"]).not.toContain(PRE);
    });
    it("Idempotency-Key where x-idempotency required; If-Match exactly on the TRD rows", () => {
      const ps = JSON.stringify(o.parameters ?? []);
      if (r.idem === "required") expect(ps).toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.idem === "none") expect(ps).not.toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.im) expect(ps).toMatch(/IfMatch|If-Match/);
      else expect(ps).not.toMatch(/IfMatch|If-Match/);
    });
    if (r.paged)
      it("takes cursor + limit (default 50, max 200)", () => {
        const ps = JSON.stringify(o.parameters ?? []);
        expect(ps).toMatch(/cursor|Cursor/);
        expect(ps).toMatch(/limit|Limit/);
        const lim = pschema(r.id, "limit");
        if (lim) expect([lim.maximum, lim.default]).toEqual([200, 50]);
      });
  });

  describe("shape pins from TRD §6", () => {
    it("named DTO schemas are components", () => {
      for (const n of DTOS) expect(schema(n), n).toBeDefined();
    });
    it("request bodies: JSON, or multipart for O1/N6 (x-upload), raw for CB1; no tenant_id / created_by in any JSON body (rule 7)", () => {
      expect(Object.keys(ops).length, "no operations").toBe(TOTAL);
      for (const [id, { op }] of Object.entries(ops)) {
        const b = op.requestBody?.content ?? {};
        const allowed = ["uploadOutsourcedReport", "uploadNarrativeImage"].includes(id) ? ["multipart/form-data"] : id === "receiveProviderCallback" ? Object.keys(b) : ["application/json"];
        for (const k of Object.keys(b)) expect(allowed, `${id} ${k}`).toContain(k);
        const s = deref(b["application/json"]?.schema);
        if (s) for (const f of ["tenant_id", "created_by", "updated_by"]) expect(keys(s), `${id}.${f}`).not.toContain(f);
      }
    });
    it("receiveProviderCallback is x-raw-body: true (CR-C6-001); verifyProviderCallback is a GET with no body", () => {
      has("receiveProviderCallback");
      expect(ops.receiveProviderCallback.op["x-raw-body"]).toBe(true);
      expect(ops.verifyProviderCallback.op.requestBody).toBeUndefined();
      expect(param("receiveProviderCallback", "callback_token")?.in).toBe("path");
    });
    it("listReports params + sort enum; PHI-bearing filters are not query params (P2)", () => {
      const names = params("listReports").map((p: any) => p?.name);
      expect(names).toEqual(expect.arrayContaining(["display_status", "family", "centre_id", "registered_at_from", "registered_at_to",
        "released_at_from", "released_at_to", "has_review_flag", "sort", "cursor", "limit"]));
      expect(pschema("listReports", "sort").enum).toEqual(["-updated_at", "registered_at", "-released_at"]);
      expect(JSON.stringify(param("listReports", "display_status"))).toMatch(/awaiting_content/);
    });
    it("searchReports: oneOf registration_no ≤ 20 | barcode ≤ 20 | order_id | patient_id, closed; ≤ 50 rows; PHI in body not URL", () => {
      const b = bodySchema("searchReports");
      const branches = (b.oneOf ?? []).map(deref);
      expect(branches.length).toBe(4);
      const f = (k: string) => branches.find((x: any) => keys(x).includes(k));
      expect(deref(props(f("registration_no"))["registration_no"]).maxLength).toBe(20);
      expect(deref(props(f("barcode"))["barcode"]).maxLength).toBe(20);
      expect(f("order_id")).toBeDefined();
      expect(f("patient_id")).toBeDefined();
      for (const x of branches) expect(x.additionalProperties).toBe(false);
      expect(deref(props(okSchema("searchReports")).data).maxItems).toBe(50);
      expect(ops.searchReports.op.description ?? "").toContain("lab.specimen.read");
    });
    it("ReportSummary allowlist: TRD fields only; display_status 8 values; no tenant_id", () => {
      const k = keys(schema("ReportSummary"));
      expect(k).toEqual(expect.arrayContaining(["id", "order_id", "family", "centre_id", "state", "display_status", "registration_no", "patient_display_name",
        "centre_code", "referrer_name", "items_total", "items_ready", "latest_version_no", "released_version_no", "held_basis", "balance_due_paisa",
        "registered_at", "first_released_at", "updated_at", "version"]));
      expect(k).not.toContain("tenant_id");
      expect(prop("ReportSummary", "state").enum).toEqual(["open", "cancelled"]);
      expect(prop("ReportSummary", "display_status").enum).toEqual(["awaiting_content", "assembling", "rendering", "render_failed", "held",
        "ready_to_release", "released", "cancelled"]);
      for (const f of ["id", "order_id", "family", "state", "display_status", "version"]) expect(reqd(schema("ReportSummary")), f).toContain(f);
      expect(reqd(schema("ReportSummary"))).not.toContain("patient_display_name");
    });
    it("ReportDetail = ReportSummary + items[], versions[], deliveries_summary", () => {
      const k = keys(schema("ReportDetail"));
      expect(k).toEqual(expect.arrayContaining(["id", "display_status", "items", "versions", "deliveries_summary", "review_flag"]));
      expect(Object.keys(props(prop("ReportDetail", "deliveries_summary")))).toEqual(expect.arrayContaining(["queued", "sent", "delivered", "read", "failed", "suppressed"]));
      const it0 = deref(deref(props(schema("ReportDetail")).items).items);
      expect(Object.keys(props(it0))).toEqual(expect.arrayContaining(["order_item_id", "test_names", "item_kind", "requires_lab", "requires_narrative",
        "requires_outsourced", "lab_ready", "narrative_ready", "outsourced_ready", "item_status"]));
    });
    it("ReportVersionSummary allowlist", () => {
      expect(keys(schema("ReportVersionSummary"))).toEqual(expect.arrayContaining(["id", "version_no", "status", "report_kind", "completeness", "page_count",
        "pdf_bytes", "rendered_at", "released_at", "release_basis", "audiences", "supersedes_version_no", "superseded_at", "held_basis", "held_checked_at",
        "last_render_error_code", "version"]));
      expect(keys(schema("ReportVersionSummary"))).not.toContain("tenant_id");
    });
    it("releaseReportVersion: audiences ⊆ patient|referrer|centre|partner (≤ 4, unique), suppress_notifications boolean, all optional", () => {
      const a = bp("releaseReportVersion", "audiences");
      expect(a.maxItems).toBe(4);
      expect(a.uniqueItems).toBe(true);
      expect(deref(a.items).enum).toEqual(["patient", "referrer", "centre", "partner"]);
      expect(bp("releaseReportVersion", "suppress_notifications").type).toBe("boolean");
      expect(reqd(bodySchema("releaseReportVersion"))).toEqual([]);
    });
    it("bulkReleaseReportVersions: ids 1–200 unique (REQ-SEC-100); results outcome enum", () => {
      const ids = bp("bulkReleaseReportVersions", "ids");
      expect([ids.minItems, ids.maxItems, ids.uniqueItems]).toEqual([1, 200, true]);
      expect(reqd(bodySchema("bulkReleaseReportVersions"))).toContain("ids");
      const row = deref(deref(props(okSchema("bulkReleaseReportVersions")).results).items);
      expect(deref(props(row).outcome).enum).toEqual(["released", "blocked_due", "not_ready", "not_latest", "already_released", "cancelled", "not_found"]);
      expect(Object.keys(props(row))).toContain("release_basis");
    });
    it("retryRenderReportVersion is 202 → ReportVersionSummary", () => {
      expect(JSON.stringify(okResp("retryRenderReportVersion", "202"))).toMatch(/ReportVersionSummary/);
    });
    it("regenerateReport: reason_code coded set, reason_text ≤ 500, no enum; 202 {report_id, scheduled}", () => {
      expect(reqd(bodySchema("regenerateReport"))).toContain("reason_code");
      csName(bp("regenerateReport", "reason_code"), "regeneration_reasons");
      expect(bp("regenerateReport", "reason_code").enum).toBeUndefined();
      expect(bp("regenerateReport", "reason_text").maxLength).toBe(500);
      const rs = okSchema("regenerateReport", "202");
      expect(keys(rs)).toEqual(expect.arrayContaining(["report_id", "scheduled"]));
      expect(deref(props(rs).scheduled).type).toBe("boolean");
    });
    it("createReportPrint / createBulkPrint: variant letterhead|plain, copies 1–5, ids 1–200; PrintJob shape", () => {
      expect(deref(bp("createReportPrint", "variant")).enum).toEqual(["letterhead", "plain"]);
      const c = bp("createReportPrint", "copies");
      expect([c.minimum, c.maximum]).toEqual([1, 5]);
      expect(reqd(bodySchema("createReportPrint"))).toEqual(expect.arrayContaining(["variant", "copies"]));
      const ids = bp("createBulkPrint", "ids");
      expect([ids.minItems, ids.maxItems]).toEqual([1, 200]);
      expect(deref(bp("createBulkPrint", "variant")).enum).toEqual(["letterhead", "plain"]);
      expect(keys(schema("PrintJob"))).toEqual(expect.arrayContaining(["id", "state", "variant", "copies", "expires_at"]));
      expect(prop("PrintJob", "state").enum).toEqual(expect.arrayContaining(["ready", "rendering"]));
      expect(keys(okSchema("createBulkPrint", "202"))).toEqual(expect.arrayContaining(["id", "state"]));
      expect(keys(okSchema("createBulkPrint", "202"))).toContain("excluded_ids");
    });
    it("revokeReportQrToken / revokePortalLink: reason_code coded set token_revoke_reasons, reason_text ≤ 500; revoke returns revoked_at", () => {
      for (const id of ["revokeReportQrToken", "revokePortalLink"]) {
        expect(reqd(bodySchema(id)), id).toContain("reason_code");
        csName(bp(id, "reason_code"), "token_revoke_reasons");
        expect(bp(id, "reason_text").maxLength, id).toBe(500);
      }
      expect(keys(okSchema("revokeReportQrToken"))).toContain("revoked_at");
    });
    it("listPortalLinks rows: no token / url, destination masked only", () => {
      const k = Object.keys(props(dataItem("listPortalLinks")));
      expect(k).toEqual(expect.arrayContaining(["id", "channel", "recipient_kind", "destination_masked", "expires_at", "revoked_at", "last_used_at", "use_count"]));
      for (const f of ["token", "url", "link", "destination", "token_sha256"]) expect(k, f).not.toContain(f);
    });
    it("listReportingCodes: set_name enum of the four TRD names; rows {code, display, sort_order}", () => {
      expect(pschema("listReportingCodes", "set_name").enum).toEqual(["regeneration_reasons", "token_revoke_reasons", "outsourced_withdraw_reasons", "narrative_amend_reasons"]);
      expect(Object.keys(props(dataItem("listReportingCodes"))).sort()).toEqual(["code", "display", "sort_order"]);
    });
    it("listCriticalAlerts: since param; CriticalAlert carries no value / analyte / patient name", () => {
      expect(param("listCriticalAlerts", "since")).toBeDefined();
      expect(param("listCriticalAlerts", "centre_id")).toBeDefined();
      const k = keys(schema("CriticalAlert"));
      expect(k).toEqual(expect.arrayContaining(["critical_event_id", "report_id", "order_id", "registration_no", "centre_id", "alerted_at", "recipients"]));
      for (const f of ["value", "value_numeric", "value_text", "analyte", "analyte_id", "analyte_code", "patient_name", "patient_display_name", "full_name", "tenant_id"])
        expect(k, f).not.toContain(f);
      const rec = deref(deref(props(schema("CriticalAlert")).recipients).items);
      expect(Object.keys(props(rec))).toEqual(expect.arrayContaining(["recipient_kind", "membership_id", "status", "failure_code"]));
      expect(deref(props(rec).recipient_kind).enum).toEqual(["referrer", "staff"]);
    });
    it("Delivery allowlist (no body, destination, link or params); attempts[]; listDeliveries sort + filters", () => {
      const k = keys(schema("Delivery"));
      expect(k).toEqual(expect.arrayContaining(["id", "channel", "purpose", "recipient_kind", "status", "attempt_no", "destination_masked", "template_code",
        "report_id", "report_version_no", "fallback_of_delivery_id", "failure_code", "queued_at", "sent_at", "delivered_at", "read_at", "failed_at", "attempts"]));
      for (const f of ["body", "body_text", "destination", "destination_e164", "link", "url", "params", "tenant_id"]) expect(k, f).not.toContain(f);
      const at = deref(deref(props(schema("Delivery")).attempts).items);
      expect(Object.keys(props(at))).toEqual(expect.arrayContaining(["attempt_no", "started_at", "finished_at", "outcome", "error_code"]));
      expect(pschema("listDeliveries", "sort").enum).toEqual(["-created_at"]);
      expect(params("listDeliveries").map((p: any) => p?.name)).toEqual(expect.arrayContaining(["status", "channel", "purpose", "recipient_kind", "report_id",
        "created_at_from", "created_at_to", "sort"]));
    });
    it("sendReportDelivery: recipient_kind patient|referrer|centre, channel whatsapp|sms|email, centre_contact_id optional", () => {
      const b = bodySchema("sendReportDelivery");
      expect(reqd(b)).toEqual(expect.arrayContaining(["recipient_kind", "channel"]));
      expect(reqd(b)).not.toContain("centre_contact_id");
      expect(deref(props(b).recipient_kind).enum).toEqual(["patient", "referrer", "centre"]);
      expect(deref(props(b).channel).enum).toEqual(["whatsapp", "sms", "email"]);
      expect(keys(b)).toContain("centre_contact_id");
    });
    it("upload ops (O1, N6): multipart with x-upload allowlist and bounded fields (REQ-SEC-083)", () => {
      for (const [id, mimes] of [["uploadOutsourcedReport", ["application/pdf"]], ["uploadNarrativeImage", ["image/png", "image/jpeg"]]] as const) {
        const m = deref(ops[id].op.requestBody?.content?.["multipart/form-data"]?.schema);
        expect(m, id).toBeDefined();
        expect([...ops[id].op["x-upload"]].sort(), id).toEqual([...mimes].sort());
        expect(deref(props(m).file).format, id).toBe("binary");
        expect(reqd(m), id).toContain("file");
        expect(m.additionalProperties, id).toBe(false);
      }
      const m1 = deref(ops.uploadOutsourcedReport.op.requestBody.content["multipart/form-data"].schema);
      expect(reqd(m1)).toContain("external_lab_name");
      const n = deref(props(m1).external_lab_name);
      expect([n.minLength, n.maxLength]).toEqual([1, 120]);
      const m2 = deref(ops.uploadNarrativeImage.op.requestBody.content["multipart/form-data"].schema);
      expect(reqd(m2)).not.toContain("caption");
      expect(deref(props(m2).caption).maxLength).toBeGreaterThan(0);
    });
    it("InputFile allowlist; confirm needs patient_match_confirmed; withdraw coded set outsourced_withdraw_reasons", () => {
      expect(keys(schema("InputFile"))).toEqual(expect.arrayContaining(["id", "kind", "order_item_id", "state", "original_filename", "size_bytes", "page_count",
        "external_lab_name", "caption", "last_error_code", "confirmed_at", "version"]));
      expect(reqd(bodySchema("confirmOutsourcedReport"))).toContain("patient_match_confirmed");
      expect(bp("confirmOutsourcedReport", "patient_match_confirmed").type).toBe("boolean");
      expect(reqd(bodySchema("withdrawOutsourcedReport"))).toContain("reason_code");
      csName(bp("withdrawOutsourcedReport", "reason_code"), "outsourced_withdraw_reasons");
      expect(bp("withdrawOutsourcedReport", "reason_text").maxLength).toBe(500);
      for (const v of ["awaiting_file", "awaiting_confirmation", "confirmed"]) expect(JSON.stringify(param("listOutsourcedItems", "state"))).toContain(v);
      expect(Object.keys(props(dataItem("listOutsourcedItems")))).toEqual(expect.arrayContaining(["order_item_id", "report_id", "registration_no", "test_names", "latest_file_state", "registered_at"]));
    });
    it("narrative: list filters; NarrativeReport shape; draft bounds (sections ≤ 12 / key ≤ 40 / html ≤ 20000, images ≤ 12 / caption ≤ 200)", () => {
      for (const v of ["draft", "signed", "amending"]) expect(JSON.stringify(param("listNarrativeReports", "status"))).toContain(v);
      expect(params("listNarrativeReports").map((p: any) => p?.name)).toEqual(expect.arrayContaining(["template_kind", "centre_id"]));
      expect(keys(schema("NarrativeReport"))).toEqual(expect.arrayContaining(["id", "order_item_id", "test_id", "test_name", "status", "current_version", "history", "version"]));
      const cv = prop("NarrativeReport", "current_version");
      expect(Object.keys(props(cv))).toEqual(expect.arrayContaining(["version_no", "status", "template_id", "sections", "images", "signed_by", "signed_at", "amendment_reason_code"]));
      const s = bp("saveNarrativeDraft", "sections");
      expect(s.maxItems).toBe(12);
      expect(deref(props(s.items).key).maxLength).toBe(40);
      expect(deref(props(s.items).html).maxLength).toBe(20000);
      const im = bp("saveNarrativeDraft", "images");
      expect(im.maxItems).toBe(12);
      expect(deref(props(im.items).caption).maxLength).toBe(200);
      expect(reqd(bodySchema("saveNarrativeDraft"))).not.toContain("template_id");
    });
    it("startNarrativeAmendment: coded set narrative_amend_reasons; sign has no body", () => {
      expect(reqd(bodySchema("startNarrativeAmendment"))).toContain("reason_code");
      csName(bp("startNarrativeAmendment", "reason_code"), "narrative_amend_reasons");
      expect(bp("startNarrativeAmendment", "reason_text").maxLength).toBe(500);
      expect(ops.signNarrativeReport.op.requestBody).toBeUndefined();
    });
    it("createNarrativeTemplate: code ^[A-Z0-9_]{1,32}$, name 1–120, sections 1–12 {key, heading ≤ 80, required, default_html ≤ 5000}", () => {
      const b = bodySchema("createNarrativeTemplate");
      expect(reqd(b)).toEqual(expect.arrayContaining(["code", "name", "kind", "sections"]));
      expect(bp("createNarrativeTemplate", "code").pattern).toBe("^[A-Z0-9_]{1,32}$");
      const n = bp("createNarrativeTemplate", "name");
      expect([n.minLength, n.maxLength]).toEqual([1, 120]);
      const s = bp("createNarrativeTemplate", "sections");
      expect([s.minItems, s.maxItems]).toEqual([1, 12]);
      expect(reqd(s.items)).toEqual(expect.arrayContaining(["key", "heading", "required"]));
      expect(deref(props(s.items).heading).maxLength).toBe(80);
      expect(deref(props(s.items).default_html).maxLength).toBe(5000);
      expect(keys(bodySchema("updateNarrativeTemplate"))).toEqual(expect.arrayContaining(["name", "sections", "is_active"]));
      expect(reqd(bodySchema("updateNarrativeTemplate"))).toEqual([]);
    });
    it("file downloads: attachment + no-store + nosniff headers (P-2); PDFs are application/pdf, images png|jpeg + CSP sandbox", () => {
      for (const id of DOWNLOADS) {
        has(id);
        const r = okResp(id);
        const h = JSON.stringify(r.headers ?? {}).toLowerCase();
        expect(h, `${id} Content-Disposition`).toContain("content-disposition");
        expect(h, `${id} Cache-Control`).toContain("cache-control");
        expect(h, `${id} nosniff`).toContain("x-content-type-options");
        expect(r.content?.["application/json"], `${id} must not be JSON`).toBeUndefined();
      }
      for (const id of ["downloadReportVersionPdf", "downloadReportPrintPdf", "downloadOutsourcedReport", "downloadPortalReportPdf"])
        expect(Object.keys(okResp(id).content ?? {}), id).toEqual(["application/pdf"]);
      expect(Object.keys(okResp("getNarrativeImageContent").content ?? {}).sort()).toEqual(["image/jpeg", "image/png"]);
      expect(JSON.stringify(okResp("getNarrativeImageContent").headers).toLowerCase()).toContain("content-security-policy");
      expect(ops.getNarrativeImageContent.op.description ?? "").toContain("reporting.narrative.write");
      expect(ops.createReportPrint.op.description ?? "").toContain("reporting.report.release");
    });
    it("TemplateConfig: closed schemas, TRD bounds", () => {
      const t = schema("TemplateConfig");
      expect(Object.keys(props(t))).toEqual(expect.arrayContaining(["page", "letterhead", "header_fields", "results", "signatories", "qr", "watermark",
        "disclaimers", "contact_strip_extra", "fonts", "narrative"]));
      expect(t.additionalProperties).toBe(false);
      expect(deref(props(prop("TemplateConfig", "page")).size).enum).toEqual(["A4", "Letter"]);
      const qr = props(prop("TemplateConfig", "qr")).size_mm;
      expect([deref(qr).minimum, deref(qr).maximum]).toEqual([15, 35]);
      const wm = props(prop("TemplateConfig", "watermark")).opacity;
      expect([deref(wm).minimum, deref(wm).maximum]).toEqual([0.05, 0.3]);
      const fb = deref(props(prop("TemplateConfig", "fonts")).base_pt);
      expect([fb.minimum, fb.maximum]).toEqual([7, 11]);
      const sg = deref(props(prop("TemplateConfig", "signatories")).max);
      expect([sg.minimum, sg.maximum]).toEqual([1, 4]);
      expect(deref(prop("TemplateConfig", "disclaimers")).maxItems).toBe(5);
      expect(deref(prop("TemplateConfig", "contact_strip_extra")).maxLength).toBe(300);
      expect(deref(props(prop("TemplateConfig", "signatories")).mode).enum).toEqual(["approvers", "nominated"]);
    });
    it("report templates: create {family, name ≤ 80, config}; update draft {config}; publish has no body; preview variant", () => {
      expect(reqd(bodySchema("createReportTemplate"))).toEqual(expect.arrayContaining(["family", "name", "config"]));
      expect(bp("createReportTemplate", "name").maxLength).toBe(80);
      expect(reqd(bodySchema("updateReportTemplateDraft"))).toContain("config");
      expect(ops.publishReportTemplate.op.requestBody).toBeUndefined();
      expect(reqd(bodySchema("previewReportTemplate"))).toContain("variant");
      expect(JSON.stringify(okResp("previewReportTemplate", "202"))).toMatch(/PrintJob/);
      expect(keys(dataItem("listReportTemplates"))).toEqual(expect.arrayContaining(["id", "family", "name", "current_version_no", "draft_version_no", "is_active"]));
      expect(keys(okSchema("getReportTemplate"))).toEqual(expect.arrayContaining(["versions", "draft"]));
    });
    it("upsertMessageTemplateText: language en|ne, bounds, approval_status enum, channel path enum; M1 row shape", () => {
      const b = bodySchema("upsertMessageTemplateText");
      expect(reqd(b)).toEqual(expect.arrayContaining(["language", "body_text", "approval_status", "is_active"]));
      expect(bp("upsertMessageTemplateText", "language").enum).toEqual(["en", "ne"]);
      expect(bp("upsertMessageTemplateText", "body_text").maxLength).toBe(1000);
      expect(bp("upsertMessageTemplateText", "subject_text").maxLength).toBe(150);
      expect(bp("upsertMessageTemplateText", "provider_template_name").maxLength).toBe(128);
      expect(bp("upsertMessageTemplateText", "provider_template_language").maxLength).toBe(16);
      expect(keys(b)).toContain("provider_variable_order");
      expect(bp("upsertMessageTemplateText", "approval_status").enum).toEqual(["not_required", "draft", "submitted", "approved", "rejected"]);
      expect(pschema("upsertMessageTemplateText", "channel").enum).toEqual(["whatsapp", "sms", "email"]);
      expect(param("upsertMessageTemplateText", "template_code")).toBeDefined();
      expect(Object.keys(props(dataItem("listMessageTemplates")))).toEqual(expect.arrayContaining(["code", "purpose", "channels", "params", "texts"]));
    });
    it("channel accounts: secret_ref is a reference (^[a-z0-9_./-]{1,128}$), never a plaintext secret; callback token returned once", () => {
      const b = bodySchema("upsertChannelAccount");
      expect(reqd(b)).toEqual(expect.arrayContaining(["provider_kind", "secret_ref", "is_active"]));
      expect(bp("upsertChannelAccount", "secret_ref").pattern).toBe("^[a-z0-9_./-]{1,128}$");
      expect(bp("upsertChannelAccount", "sender_id").maxLength).toBe(64);
      expect(pschema("upsertChannelAccount", "channel").enum).toEqual(["whatsapp", "sms", "email"]);
      const row = Object.keys(props(dataItem("listChannelAccounts")));
      expect(row).toEqual(expect.arrayContaining(["id", "channel", "provider_kind", "sender_id", "secret_ref", "callback_url_configured", "is_active", "version"]));
      for (const f of ["secret", "api_key", "access_token", "callback_url", "callback_token"]) expect(row, f).not.toContain(f);
      expect(keys(okSchema("rotateChannelCallbackToken"))).toContain("callback_url");
      expect(ops.rotateChannelCallbackToken.op.requestBody).toBeUndefined();
    });
    it("settings + centre contacts + staff assignments + referrer prefs", () => {
      expect(reqd(bodySchema("updateReportingSettings"))).toEqual([]);
      expect(JSON.stringify(okResp("getReportingSettings"))).toMatch(/ReportingSettings/);
      const b = bodySchema("createCentreContact");
      expect(reqd(b)).toEqual(expect.arrayContaining(["centre_id", "channel", "address", "label"]));
      expect(deref(props(b).channel).enum).toEqual(["whatsapp", "sms", "email"]);
      expect(deref(props(b).address).maxLength).toBe(254);
      expect(deref(props(b).label).maxLength).toBe(80);
      const row = Object.keys(props(dataItem("listCentreContacts")));
      expect(row).toEqual(expect.arrayContaining(["id", "centre_id", "channel", "address_masked", "label", "is_active", "version"]));
      expect(row).not.toContain("address");
      expect(param("listCentreContacts", "centre_id")).toBeDefined();
      expect(keys(bodySchema("updateCentreContact"))).toEqual(expect.arrayContaining(["label", "is_active"]));
      const sa = bodySchema("replaceStaffAssignments");
      expect(reqd(sa)).toEqual(expect.arrayContaining(["nominated_signatories", "critical_alert_recipients"]));
      expect(deref(props(sa).nominated_signatories).maxItems).toBe(4);
      expect(deref(props(sa).critical_alert_recipients).maxItems).toBe(20);
      expect(deref(deref(props(bodySchema("upsertReferrerPreference")).disabled_channels).items).enum).toEqual(["whatsapp", "sms", "email"]);
    });
    it("portal OTP: P1 response {challenge_id, channel sms|email} with no destination / mask (D-31); P1 and P5 take no fields", () => {
      const rs = okSchema("createPortalOtpChallenge");
      expect(keys(rs).sort()).toEqual(["challenge_id", "channel"]);
      expect(deref(props(rs).channel).enum).toEqual(["sms", "email"]);
      expect(keys(bodySchema("createPortalOtpChallenge") ?? {})).toEqual([]);
      expect(keys(bodySchema("requestPortalLinkReissue") ?? {})).toEqual([]);
    });
    it("verifyPortalOtp: code ^[0-9]{6}$; response session_token + expiries + link_purpose report|dues", () => {
      expect(reqd(bodySchema("verifyPortalOtp"))).toContain("code");
      expect(bp("verifyPortalOtp", "code").pattern).toBe("^[0-9]{6}$");
      const rs = okSchema("verifyPortalOtp");
      expect(keys(rs)).toEqual(expect.arrayContaining(["session_token", "idle_expires_at", "absolute_expires_at", "link_purpose"]));
      expect(deref(props(rs).link_purpose).enum).toEqual(["report", "dues"]);
      expect(param("verifyPortalOtp", "challenge_id")?.in).toBe("path");
    });
    it("getPortalReport / getPortalDues: TRD response keys; dues.online_gateways esewa|khalti; no tenant / internal ids beyond report_version_id", () => {
      const rs = okSchema("getPortalReport");
      expect(keys(rs)).toEqual(expect.arrayContaining(["lab_name", "patient_display", "report", "download", "smart_summary", "dues"]));
      expect(Object.keys(props(deref(props(rs).report)))).toEqual(expect.arrayContaining(["family", "report_kind", "status_label", "issued_at", "version_no", "panel_names", "updated_notice"]));
      expect(Object.keys(props(deref(props(rs).download)))).toEqual(["report_version_id"]);
      const dues = deref(props(rs).dues);
      expect(Object.keys(props(dues))).toEqual(expect.arrayContaining(["balance_due_paisa", "online_gateways", "open_request"]));
      expect(deref(deref(props(dues).online_gateways).items).enum).toEqual(["esewa", "khalti"]);
      expect(keys(rs)).not.toContain("tenant_id");
      const d = okSchema("getPortalDues");
      expect(keys(d)).toEqual(expect.arrayContaining(["lab_name", "dues", "report_follows"]));
      expect(deref(props(d).report_follows).type).toBe("boolean");
      expect(keys(d)).not.toContain("report");
    });
    it("createPortalPaymentRequest: body {gateway esewa|khalti} only (no amount); 202 + 200 both PortalPaymentRequest", () => {
      const b = bodySchema("createPortalPaymentRequest");
      expect(keys(b)).toEqual(["gateway"]);
      expect(reqd(b)).toContain("gateway");
      expect(deref(props(b).gateway).enum).toEqual(["esewa", "khalti"]);
      expect(b.additionalProperties).toBe(false);
      for (const c of ["200", "202"]) expect(JSON.stringify(okResp("createPortalPaymentRequest", c)), c).toMatch(/PortalPaymentRequest/);
      expect(keys(schema("PortalPaymentRequest"))).toEqual(expect.arrayContaining(["id", "status", "gateway", "review", "amount_paisa", "action_url", "failure_code", "intent_expires_at"]));
      expect(prop("PortalPaymentRequest", "status").enum).toEqual(["queued", "ready", "completed", "failed", "expired"]);
      expect(JSON.stringify(okResp("getPortalPaymentRequest")).toLowerCase()).toContain("cache-control");
    });
    it("endPortalSession is 204 with no content", () => {
      expect(okResp("endPortalSession").content).toBeUndefined();
    });
    it("verifyReportQr: qr_token maxLength 64 and NO pattern (review fix #25); minimal response; 404 verify_not_found", () => {
      const q = bp("verifyReportQr", "qr_token");
      expect(reqd(bodySchema("verifyReportQr"))).toContain("qr_token");
      expect(q.maxLength).toBe(64);
      expect(q.pattern).toBeUndefined();
      const rs = okSchema("verifyReportQr");
      expect(keys(rs).sort()).toEqual(["issued_at", "lab_name", "panel_names", "patient_display", "status", "version_no"]);
      expect(deref(props(rs).status).enum).toEqual(["valid", "superseded"]);
      expect(Object.keys(ops.verifyReportQr.op.responses)).toContain("404");
    });
    it("provider callbacks: public, no tenant data in params (path token only); CB2 text/plain", () => {
      expect(params("verifyProviderCallback").filter((p: any) => p?.in === "path").map((p: any) => p.name)).toEqual(["callback_token"]);
      const c = okResp("verifyProviderCallback").content ?? {};
      expect(Object.keys(c)).toContain("text/plain");
    });
  });

  // ---------- "Prism smoke", offline: examples validate against their schemas ----------
  describe("examples validate against their schemas; each operation has a servable example (Prism smoke); examples are synthetic", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...doc, id: "reporting.yaml" });
    const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    const check = (ptr: string, example: unknown) => {
      const validate = ajv.getSchema(`reporting.yaml#${ptr}`);
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
      expect(existsSync(FILE), "contracts/openapi/reporting.yaml missing").toBe(true);
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
      expect(n).toBeGreaterThanOrEqual(TOTAL - 8);
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
    it("examples are synthetic: no e-mail, no Nepali-mobile-shaped number, no Windows/user paths, no live-looking link/session credentials", () => {
      expect(existsSync(FILE), "contracts/openapi/reporting.yaml missing").toBe(true);
      const vals = exampleValues();
      expect(vals.length, "no examples at all").toBeGreaterThan(0);
      const blob = JSON.stringify(vals);
      expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
      expect(blob).not.toMatch(/(?<!\d)(?:\+?977[-\s]?)?9[678]\d{8}(?!\d)/);
      expect(blob).not.toMatch(/[A-Z]:\\\\|\/Users\/|\/home\//);
      expect(blob).not.toMatch(/(?:link|session)\.[A-Za-z0-9_-]{22,}/);
    });
  });
});
