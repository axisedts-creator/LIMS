// T0C-10.C13 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/partners.yaml (C13 transcription of spec/chunks/C13-b2b-partner-portal/02-TRD.md §5.1–§5.3; LD-103).
// Checks: (1) exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) clean for partners.yaml; (3) AC-0C-1.5 negatives on a temp copy;
// (4) partners = TRD §5.2/§5.3 tables (41 partner-facing + 27 staff = 68 ops), method+path under /v1/partners, x-permission (one code), security bearerJwt,
//     x-idempotency, tier (general; R3 report_download), success status, specific + common error codes, Idempotency-Key on R rows, If-Match on rows that take it;
// (5) shape pins from §5.1/§5.2/§5.3 (query params, enums, bounds, patterns, x-coded-set without enum, DTO allowlists, PDF download headers, no token/url on access slips,
//     no tenant_id / clear e-mail / staff-only fields on partner-facing responses, no PHI paths);
// (6) "Prism smoke" offline: examples validate (ajv), every JSON 2xx has an example, examples synthetic; (7) package.json `mock:partners` script.
// Not testable here: Prism serving the file (prism not installed), generated-client freshness (codegen-fresh suite), access-log calls, actor-type checks (runtime),
//   exactly-one-of birth_on/age_years (TRD prose; the schema mechanism is the implementer's choice, so it is not pinned).
// Assumptions (TRD silent or ambiguous; each is also in the notes file):
//  - every op lists validation_failed, auth.forbidden, auth.unauthenticated, rate_limited, internal; common.not_found on ops with a path parameter ("object operations");
//    partner-facing ops (not /admin) also list partners.partner_inactive (TRD §5 intro); IDEM codes are NOT pinned (Idem R rows only pin the Idempotency-Key header);
//  - ops with If-Match list common.version_conflict + common.precondition_required, ops without If-Match list no precondition_required;
//  - privileged permissions (partners.partner.manage, partners.partner_user.manage per permissions.yaml) add auth.mfa_required (TRD §5 intro); no other op lists it;
//  - Optional-idem ops pin no Idempotency-Key header presence either way (wave 1 / C15 convention);
//  - x-coded-set value is the set name, optionally prefixed `partners.` (05-SCHEMA §7 says `<set_name>`, wave 1 uses `<module>.<set>`); never with `enum`;
//  - SS1's PartnerSettings is TRD §10.2 (the §5.3 cell cites "§11.2", a stale cross-reference; no CR needed, §10.2 is unambiguous);
//  - staff ops carry no Tier column: general; no operation is public: no x-public, security [{bearerJwt: []}] on all;
//  - examples may contain e-mail addresses only on reserved domains (example.com/.org/.net, *.test, *.invalid): U2/SA9 requests need an `email`.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRD = join(ROOT, "spec/chunks/C13-b2b-partner-portal/02-TRD.md");
const FILE = join(ROOT, "contracts/openapi/partners.yaml");
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const METHODS = ["get", "put", "post", "delete", "patch"];
const name = "partners";
const PFX = "/v1/partners";

const OR = "partners.order.read", MS = "partners.manifest.submit", RR = "partners.report.read", STR = "partners.statement.read", PL = "partners.price_list.read";
const PKR = "partners.pickup.request", RFR = "partners.referrer.read", RFM = "partners.referrer.manage", PUM = "partners.partner_user.manage";
const PRD = "partners.partner.read", PM = "partners.partner.manage", MRC = "partners.manifest.receive", PKM = "partners.pickup.manage", RMAP = "partners.referrer.map";
const PRIVILEGED = [PM, PUM];
const VC = "common.version_conflict", PRE = "common.precondition_required", MFA = "auth.mfa_required", FD = "common.feature_disabled", NF = "common.not_found";
const FIVE = ["common.validation_failed", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"];
const PI = "partners.partner_inactive", MNE = "partners.manifest_not_editable", ONO = "partners.orderable_not_offered", MI = "partners.manifest_invalid";
const MIT = "partners.manifest_invalid_transition", MLIT = "partners.manifest_line_invalid_transition", PKI = "partners.pickup_invalid", PKIT = "partners.pickup_invalid_transition";
const RD = "partners.referrer_duplicate", IUE = "identity.user_exists", LPA = "partners.last_partner_admin", SAF = "partners.self_action_forbidden", PUIT = "partners.partner_user_invalid_transition";
const CD = "partners.code_duplicate", CPIU = "partners.credit_party_in_use", CPI = "partners.credit_party_inactive", ICI = "identity.centre_inactive", PAIT = "partners.partner_invalid_transition";
const RDI = "partners.referrer_doctor_inactive", RIT = "partners.referrer_invalid_transition", SOR = "partners.setting_out_of_range";

type Spec = { n: string; id: string; method: string; path: string; perm: string; idem: "none" | "optional" | "required"; status: number[]; err: string[]; im: boolean; paged: boolean; tier: string };
const N = "none" as const, O = "optional" as const, R = "required" as const;
const S = (n: string, id: string, method: string, path: string, perm: string, idem: Spec["idem"], status: number[], err: string[], o: Partial<Spec> = {}): Spec =>
  ({ n, id, method, path, perm, idem, status, err, im: false, paged: false, tier: "general", ...o });
const IM = { im: true }, L = { paged: true };
const MF = "/manifests/{manifest_id}", PU = "/users/{partner_user_id}", AP = "/admin/partners/{partner_id}", AU = "/admin/partner-users/{partner_user_id}";
const AM = "/admin/manifests/{manifest_id}", AL = "/admin/manifest-lines/{line_id}", APK = "/admin/pickup-requests/{pickup_request_id}", AR = "/admin/referrers/{referrer_id}";

const SPECS: Spec[] = [
  S("A1", "getPartnerContext", "GET", "/me", OR, N, [200], []),
  S("A2", "getPartnerDashboard", "GET", "/dashboard", OR, N, [200], []),
  S("M1", "createManifest", "POST", "/manifests", MS, R, [201], []),
  S("M2", "listManifests", "GET", "/manifests", OR, N, [200], [], L),
  S("M3", "getManifest", "GET", MF, OR, N, [200], []),
  S("M4", "updateManifest", "PATCH", MF, MS, N, [200], [MNE], IM),
  S("M5", "addManifestLine", "POST", `${MF}/lines`, MS, R, [201], [MNE, ONO, MI], IM),
  S("M6", "replaceManifestLine", "PUT", `${MF}/lines/{line_id}`, MS, N, [200], [MNE, ONO, MI], IM),
  S("M7", "deleteManifestLine", "DELETE", `${MF}/lines/{line_id}`, MS, N, [204], [MNE], IM),
  S("M8", "submitManifest", "POST", `${MF}/submit`, MS, R, [200], [MI, MIT], IM),
  S("M9", "withdrawManifest", "POST", `${MF}/withdraw`, MS, R, [200], [MIT], IM),
  S("M10", "discardManifest", "POST", `${MF}/discard`, MS, O, [200], [MIT], IM),
  S("M11", "getManifestPrintView", "GET", `${MF}/print-view`, OR, N, [200], [MIT]),
  S("O1", "listPartnerOrders", "GET", "/orders", OR, N, [200], [], L),
  S("O2", "searchPartnerOrders", "POST", "/orders/search", OR, N, [200], []),
  S("O3", "getPartnerOrder", "GET", "/orders/{order_id}", OR, N, [200], []),
  S("R1", "listPartnerReports", "GET", "/reports", RR, N, [200], [], L),
  S("R2", "markPartnerReportsSeen", "POST", "/reports/mark-seen", RR, O, [200], []),
  S("R3", "downloadPartnerReport", "GET", "/reports/{report_id}/versions/{version_no}/file", RR, N, [200], [], { tier: "report_download" }),
  S("R4", "issuePatientAccessSlip", "POST", "/reports/{report_id}/access-slips", RR, R, [202], [FD]),
  S("R5", "getPatientAccessSlip", "GET", "/reports/{report_id}/access-slips/{access_slip_id}", RR, N, [200], []),
  S("R6", "downloadPatientAccessSlip", "GET", "/reports/{report_id}/access-slips/{access_slip_id}/file", RR, N, [200], []),
  S("K1", "createPickupRequest", "POST", "/pickup-requests", PKR, R, [201], [PKI]),
  S("K2", "listPickupRequests", "GET", "/pickup-requests", OR, N, [200], [], L),
  S("K3", "getPickupRequest", "GET", "/pickup-requests/{pickup_request_id}", OR, N, [200], []),
  S("K4", "cancelPickupRequest", "POST", "/pickup-requests/{pickup_request_id}/cancel", PKR, R, [200], [PKIT], IM),
  S("P1", "listPartnerPriceList", "GET", "/price-list", PL, N, [200], [], L),
  S("P2", "searchPartnerOrderables", "GET", "/orderables", MS, N, [200], []),
  S("S1", "listPartnerStatements", "GET", "/statements", STR, N, [200], [], L),
  S("S2", "getPartnerStatement", "GET", "/statements/{period_month}", STR, N, [200], []),
  S("F1", "listPartnerReferrers", "GET", "/referrers", RFR, N, [200], [], L),
  S("F2", "createPartnerReferrer", "POST", "/referrers", RFM, R, [201], [RD]),
  S("F3", "updatePartnerReferrer", "PATCH", "/referrers/{referrer_id}", RFM, N, [200], [RD], IM),
  S("F4", "deactivatePartnerReferrer", "POST", "/referrers/{referrer_id}/deactivate", RFM, O, [200], [], IM),
  S("F5", "reactivatePartnerReferrer", "POST", "/referrers/{referrer_id}/reactivate", RFM, O, [200], [], IM),
  S("U1", "listPartnerUsers", "GET", "/users", PUM, N, [200], [MFA], L),
  S("U2", "invitePartnerUser", "POST", "/users", PUM, R, [201], [IUE, MFA]),
  S("U3", "changePartnerUserRole", "POST", `${PU}/role`, PUM, O, [200], [LPA, SAF, MFA], IM),
  S("U4", "deactivatePartnerUser", "POST", `${PU}/deactivate`, PUM, O, [200], [LPA, SAF, MFA], IM),
  S("U5", "reactivatePartnerUser", "POST", `${PU}/reactivate`, PUM, O, [200], [MFA], IM),
  S("U6", "resendPartnerInvitation", "POST", `${PU}/resend-invitation`, PUM, R, [202], [PUIT, MFA]),
  S("SA1", "listPartners", "GET", "/admin/partners", PRD, N, [200], [], L),
  S("SA2", "createPartner", "POST", "/admin/partners", PM, R, [201], [CD, CPIU, CPI, ICI, MFA]),
  S("SA3", "getPartner", "GET", AP, PRD, N, [200], []),
  S("SA4", "updatePartner", "PATCH", AP, PM, N, [200], [CD, CPIU, CPI, ICI, MFA], IM),
  S("SA5", "suspendPartner", "POST", `${AP}/suspend`, PM, O, [200], [PAIT, MFA], IM),
  S("SA6", "reactivatePartner", "POST", `${AP}/reactivate`, PM, O, [200], [PAIT, CPI, MFA], IM),
  S("SA7", "resyncPartnerProjections", "POST", `${AP}/resync`, PM, O, [202], [MFA]),
  S("SA8", "listPartnerUsersForPartner", "GET", `${AP}/users`, PRD, N, [200], [], L),
  S("SA9", "invitePartnerUserByStaff", "POST", `${AP}/users`, PM, R, [201], [IUE, MFA]),
  S("SA10", "changePartnerUserRoleByStaff", "POST", `${AU}/role`, PM, O, [200], [LPA, MFA], IM),
  S("SA10", "deactivatePartnerUserByStaff", "POST", `${AU}/deactivate`, PM, O, [200], [LPA, MFA], IM),
  S("SA10", "reactivatePartnerUserByStaff", "POST", `${AU}/reactivate`, PM, O, [200], [MFA], IM),
  S("SI1", "listInboundManifests", "GET", "/admin/manifests", MRC, N, [200], [], L),
  S("SI2", "getInboundManifest", "GET", AM, MRC, N, [200], []),
  S("SI3", "receiveManifest", "POST", `${AM}/receive`, MRC, R, [200], [MIT, MI], IM),
  S("SI4", "retryManifestLineConversion", "POST", `${AL}/retry`, MRC, R, [202], [MLIT], IM),
  S("SI5", "markManifestLineNotReceived", "POST", `${AL}/not-received`, MRC, O, [200], [MLIT], IM),
  S("SP1", "listInboundPickups", "GET", "/admin/pickup-requests", PKM, N, [200], [], L),
  S("SP2", "schedulePickup", "POST", `${APK}/schedule`, PKM, O, [200], [PKIT, PKI], IM),
  S("SP3", "markPickupCollected", "POST", `${APK}/picked-up`, PKM, O, [200], [PKIT], IM),
  S("SP4", "rejectPickup", "POST", `${APK}/reject`, PKM, O, [200], [PKIT], IM),
  S("SR1", "listReferrerMappings", "GET", "/admin/referrers", RMAP, N, [200], [], L),
  S("SR2", "mapPartnerReferrer", "POST", `${AR}/map`, RMAP, O, [200], [RDI], IM),
  S("SR3", "rejectPartnerReferrerMapping", "POST", `${AR}/reject-mapping`, RMAP, O, [200], [RIT], IM),
  S("SR3", "unmapPartnerReferrer", "POST", `${AR}/unmap`, RMAP, O, [200], [RIT], IM),
  S("SS1", "getPartnerSettings", "GET", "/admin/settings", PRD, N, [200], []),
  S("SS1", "updatePartnerSettings", "PUT", "/admin/settings", PM, N, [200], [SOR, MFA], IM),
];
const TOTAL = 68, PARTNER_TOTAL = 41;

const DTOS = ["PartnerContext", "ManifestSummary", "Manifest", "ManifestLine", "ManifestLineInput", "PartnerOrder", "PartnerOrderDetail", "PartnerReport", "PickupRequest", "PriceListItem",
  "StatementMonth", "PartnerReferrer", "PartnerUser", "AccessSlip", "PartnerSettings", "PartnerAdminSummary", "PartnerAdmin", "InboundManifestSummary", "InboundManifest", "PickupRequestAdmin"];
const LIST_PAGED: Record<string, string> = { listManifests: "ManifestSummary", listPartnerOrders: "PartnerOrder", listPartnerReports: "PartnerReport", listPickupRequests: "PickupRequest",
  listPartnerPriceList: "PriceListItem", listPartnerStatements: "StatementMonth", listPartnerReferrers: "PartnerReferrer", listPartnerUsers: "PartnerUser", listPartners: "PartnerAdminSummary",
  listPartnerUsersForPartner: "PartnerUser", listInboundManifests: "InboundManifestSummary", listInboundPickups: "PickupRequestAdmin" };
const LIST_DATA: Record<string, string> = { searchPartnerOrders: "PartnerOrder", searchPartnerOrderables: "PriceListItem" };
const ONE: Record<string, string> = { getPartnerContext: "PartnerContext", createManifest: "Manifest", getManifest: "Manifest", updateManifest: "Manifest", submitManifest: "Manifest",
  withdrawManifest: "Manifest", discardManifest: "Manifest", addManifestLine: "ManifestLine", replaceManifestLine: "ManifestLine", retryManifestLineConversion: "ManifestLine",
  getPartnerOrder: "PartnerOrderDetail", createPickupRequest: "PickupRequest", getPickupRequest: "PickupRequest", cancelPickupRequest: "PickupRequest", createPartnerReferrer: "PartnerReferrer",
  invitePartnerUser: "PartnerUser", invitePartnerUserByStaff: "PartnerUser", issuePatientAccessSlip: "AccessSlip", getPatientAccessSlip: "AccessSlip", getInboundManifest: "InboundManifest",
  receiveManifest: "InboundManifest", createPartner: "PartnerAdmin", getPartner: "PartnerAdmin", getPartnerSettings: "PartnerSettings", updatePartnerSettings: "PartnerSettings" };
const PHI_PARAMS = ["barcode", "sample_barcode", "registration_no", "patient_id", "patient_name", "patient_display_name", "phone", "phone_e164", "email", "full_name", "name"];
const FORBIDDEN_ANY = ["tenant_id"];
// never on a partner-facing (non-/admin) response: tenant scope, clear e-mail, GoTrue/identity ids, staff audit + credit-party fields (REQ-SEC-081 allowlists)
const FORBIDDEN_PARTNER = ["tenant_id", "email", "user_id", "membership_id", "credit_party", "created_by", "received_by", "branch_id", "receiving_branch_id"];
const SETTINGS = ["default_conversion_mode", "include_default_price_list", "require_mapped_referrer", "access_slip_enabled", "max_lines_per_manifest", "draft_ttl_days",
  "pickup_max_days_ahead", "report_download_daily_cap_per_user", "consent_text_version", "consent_statement"];
const SUMMARY_KEYS = ["id", "manifest_no", "state", "line_count", "lines_converted", "lines_failed", "receiving_centre", "submitted_at", "received_at", "pickup_request_id", "created_at", "version"];
const PICKUP_KEYS = ["id", "state", "window_start", "window_end", "packages_count", "notes", "contact_name", "contact_phone_e164", "manifests", "scheduled_start", "scheduled_end",
  "assignee_text", "picked_up_at", "reject_reason_code", "cancel_reason_code", "created_at", "version"];

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("partners.yaml (T0C-10.C13)", () => {
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
  const ex = () => expect(existsSync(FILE), "contracts/openapi/partners.yaml missing").toBe(true);
  const T = (title: string, fn: () => void) => it(title, () => { ex(); fn(); });
  const coded = (s: any, set: string) => {
    expect(s?.["x-coded-set"], "x-coded-set").toMatch(new RegExp(`^(partners\\.)?${set}$`));
    expect(s.enum, "coded-set field must not declare enum").toBeUndefined();
  };
  const item = (s: any) => deref(deref(s).items);
  const sorted = (s: any) => keys(s).sort();
  const sup = (actual: string[], expected: string[], msg: string) => expect(actual, msg).toEqual(expect.arrayContaining(expected));
  const exact = (actual: string[], expected: string[], msg: string) => expect([...actual].sort(), msg).toEqual([...expected].sort());
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
  const len = (s: any, min: number | undefined, max: number) => expect([s?.type, s?.minLength, s?.maxLength]).toEqual(["string", min, max]);
  const bool = (s: any) => expect(s?.type).toBe("boolean");
  const uuid = (s: any, msg: string) => expect(s?.format, msg).toBe("uuid");
  const dt = (s: any, msg: string) => expect(s?.format, msg).toBe("date-time");
  const E164 = "^\\+[1-9][0-9]{7,14}$";
  const pdfOps = ["downloadPartnerReport", "downloadPatientAccessSlip"];
  const hdrs = (id: string) => Object.keys(okResp(id).headers ?? {}).map((h) => h.toLowerCase());

  describe("exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
    it("file exists", () => expect(existsSync(FILE), "contracts/openapi/partners.yaml missing").toBe(true));
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
      const dir = mkdtempSync(join(tmpdir(), "c13-partners-lint-"));
      tmps.push(dir);
      cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
      const d = parse(readFileSync(FILE, "utf8"));
      fn(d);
      writeFileSync(join(dir, "contracts/openapi/partners.yaml"), stringify(d, { aliasDuplicateObjects: false }));
      return (await lintRepo(dir)).filter((x) => x.file === name);
    };
    const firstOp = (d: any, pred: (o: any) => boolean) =>
      Object.values<any>(d.paths).flatMap((q) => METHODS.map((m) => q[m]).filter(Boolean)).find(pred);
    // first object anywhere in the document that satisfies pred (coded-set fields live inline in request bodies)
    const findDeep = (x: any, pred: (o: any) => boolean): any => {
      if (Array.isArray(x)) { for (const v of x) { const r = findDeep(v, pred); if (r) return r; } return undefined; }
      if (x && typeof x === "object") { if (pred(x)) return x; for (const v of Object.values(x)) { const r = findDeep(v, pred); if (r) return r; } }
      return undefined;
    };

    it("x-permission not in permissions.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = "partners.no_such.permission"; });
      expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
    });
    it("x-error-codes entry not in errors.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push("partners.no_such_error"); });
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
      const v = await mutate((d) => { findDeep(d, (o) => typeof o["x-coded-set"] === "string").enum = ["a"]; });
      expect(v.some((x) => x.rule === "6")).toBe(true);
    });
  });

  describe("partners equals 02-TRD §5.2 + §5.3 (no missing, no extra operations)", () => {
    it(`${TOTAL} operations (${PARTNER_TOTAL} partner-facing + ${TOTAL - PARTNER_TOTAL} staff); table ids unique; file has exactly these`, () => {
      expect(SPECS.length).toBe(TOTAL);
      expect(SPECS.filter((s) => !s.path.startsWith("/admin")).length).toBe(PARTNER_TOTAL);
      expect(new Set(SPECS.map((s) => s.id)).size).toBe(TOTAL);
      expect(Object.keys(ops).sort()).toEqual(SPECS.map((s) => s.id).sort());
    });
    it("TRD drift guard: §5.2/§5.3 rows = test table (operationId(s), method + path, first permission, Idem, Tier)", () => {
      const all = readFileSync(TRD, "utf8").split("\n");
      const start = all.findIndex((l) => l.startsWith("### 5.2 "));
      const end = all.findIndex((l, k) => k > start && l.startsWith("### 5.4 "));
      expect(start).toBeGreaterThanOrEqual(0);
      const rows = new Map<string, { ids: string[]; mp: string; perm: string; idem: string; tier: string; staff: boolean }>();
      let staff = false;
      for (const l of all.slice(start, end)) {
        if (l.startsWith("### 5.3 ")) staff = true;
        const c = l.split("|");
        const label = (c[1] ?? "").trim();
        if (!/^[A-Z]{1,2}\d+$/.test(label)) continue;
        const mp = /^\s*([A-Z]+)\s+`([^`]+)`/.exec(c[3] ?? "");
        rows.set(label, {
          ids: [...(c[2] ?? "").matchAll(/`([a-z][A-Za-z0-9]+)`/g)].map((m) => m[1]),
          mp: `${mp?.[1]} ${mp?.[2]}`,
          perm: /`(partners\.[a-z_]+\.[a-z_]+)`/.exec(l.split("|").slice(4).join("|"))?.[1] ?? "",
          // read from the end: some middle cells hold `|` (R4 `requested\|issued`, S2 path regex)
          idem: (staff ? c[c.length - 2] : c[c.length - 3]).trim().split(/\s/)[0],
          tier: staff ? "general" : c[c.length - 2].replace(/`/g, "").trim(),
          staff,
        });
      }
      expect(rows.size, "rows parsed from TRD (41 partner-facing + 23 staff labels; SA10, SR3, SS1 hold several ids)").toBe(64);
      for (const s of SPECS) {
        const r = rows.get(s.n);
        expect(r?.ids, `#${s.n} id`).toContain(s.id);
        expect(r?.staff, `#${s.n} staff table`).toBe(s.path.startsWith("/admin"));
        if (r!.ids.length === 1 && !/\bGET \/ PUT\b/.test(r!.mp)) expect(r!.mp, `#${s.n} method+path`).toBe(`${s.method} ${s.path}`);
        if (r!.ids.length === 1) {
          expect(r!.perm, `#${s.n} permission`).toBe(s.perm);
          // Ruling T0C-10.C13: 02-CONVENTIONS.md:371-375 — a POST may be `none` only for E1-E4 (searchPartnerOrders = E3);
          // every other TRD-`none` POST is "Optional (accepted)", like catalog.yaml.
          const expIdem = r!.idem === "none" && s.method === "POST" && s.id !== "searchPartnerOrders" ? "optional" : r!.idem;
          expect(expIdem, `#${s.n} idem`).toBe(s.idem);
          expect(r!.tier, `#${s.n} tier`).toBe(s.tier);
        }
      }
    });
    T("every path is /v1/partners/… with tags [partners]; no PHI path or query params (REQ-SEC-098)", () => {
      expect(Object.keys(doc.paths ?? {}).length, "no paths").toBeGreaterThan(0);
      for (const [q, it_] of Object.entries<any>(doc.paths ?? {})) {
        expect(q.startsWith(`${PFX}/`), q).toBe(true);
        expect(q).not.toMatch(/\{(registration_no|barcode|sample_barcode|phone|patient_id|email|full_name)\}/);
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
    it(`has tags, summary, x-idempotency (TRD Idem), x-rate-limit-tier ${r.tier}, x-error-codes`, () => {
      has(r.id);
      expect(o.tags).toEqual([name]);
      expect(typeof o.summary).toBe("string");
      expect(o["x-idempotency"]).toBe(r.idem);
      expect(o["x-rate-limit-tier"]).toBe(r.tier);
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
    it("lists the TRD specific error codes plus the common codes", () => {
      has(r.id);
      const want = [...FIVE, ...r.err];
      if (r.path.includes("{")) want.push(NF);
      if (!r.path.startsWith("/admin")) want.push(PI);
      if (r.im) want.push(VC, PRE);
      if (PRIVILEGED.includes(r.perm)) want.push(MFA);
      for (const c of want) expect(o["x-error-codes"], c).toContain(c);
      if (!r.im) expect(o["x-error-codes"], "no If-Match on this op").not.toContain(PRE);
      if (!PRIVILEGED.includes(r.perm)) expect(o["x-error-codes"], "non-privileged op").not.toContain(MFA);
      if (r.path.startsWith("/admin")) expect(o["x-error-codes"], "staff op").not.toContain(PI);
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

  describe("query and path parameters (TRD §5.2, §5.3)", () => {
    const names = (id: string) => params(id).filter((q: any) => q?.in === "query").map((q: any) => q.name);
    T("list query parameter names", () => {
      const m: Record<string, string[]> = {
        listManifests: ["state", "created_at_from", "created_at_to", "sort", "cursor", "limit"],
        listPartnerOrders: ["tracking_status", "manifest_id", "referrer_id", "registered_at_from", "registered_at_to", "has_new_report", "sort", "cursor", "limit"],
        listPartnerReports: ["released_at_from", "released_at_to", "is_new", "include_superseded", "sort", "cursor", "limit"],
        listPickupRequests: ["state", "sort", "cursor"],
        listPartnerPriceList: ["kind", "source", "q", "sort", "cursor"],
        searchPartnerOrderables: ["q", "limit"],
        listPartnerStatements: ["period_month_from", "period_month_to", "cursor"],
        listPartnerReferrers: ["is_active", "q", "cursor"],
        listPartnerUsers: ["status", "cursor"],
        listPartners: ["status", "q", "cursor", "sort"],
        listPartnerUsersForPartner: ["status", "cursor"],
        listInboundManifests: ["state", "partner_id", "receiving_centre_id", "submitted_at_from", "submitted_at_to", "has_failed_lines", "has_missing_samples", "sort", "cursor"],
        listInboundPickups: ["state", "partner_id", "receiving_centre_id", "window_start_from", "window_start_to", "sort", "cursor"],
        listReferrerMappings: ["mapping_state", "partner_id", "cursor"],
      };
      for (const [id, want] of Object.entries(m)) sup(names(id), want, id);
      expect(names("getPartnerContext"), "no params").toEqual([]);
    });
    T("sort enums are exactly the TRD lists", () => {
      const m: Record<string, string[]> = {
        listManifests: ["-created_at", "-submitted_at"], listPartnerOrders: ["-registered_at", "-last_event_at"], listPartnerReports: ["-released_at"],
        listPickupRequests: ["-created_at", "window_start"], listPartnerPriceList: ["code", "name"], listPartners: ["partner_code", "-created_at"],
        listInboundManifests: ["-submitted_at", "manifest_no"], listInboundPickups: ["window_start", "-created_at"],
      };
      for (const [id, want] of Object.entries(m)) expect(pschema(id, "sort").enum, id).toEqual(want);
    });
    T("filter types: dates date-time, booleans boolean, uuids uuid, csv state/status filters strings, q ≤64", () => {
      for (const [id, f] of [["listManifests", "created_at_from"], ["listManifests", "created_at_to"], ["listPartnerOrders", "registered_at_from"], ["listPartnerOrders", "registered_at_to"],
        ["listPartnerReports", "released_at_from"], ["listPartnerReports", "released_at_to"], ["listInboundManifests", "submitted_at_from"], ["listInboundManifests", "submitted_at_to"],
        ["listInboundPickups", "window_start_from"], ["listInboundPickups", "window_start_to"]] as const) dt(pschema(id, f), `${id}.${f}`);
      for (const [id, f] of [["listPartnerOrders", "has_new_report"], ["listPartnerReports", "is_new"], ["listPartnerReports", "include_superseded"], ["listPartnerReferrers", "is_active"],
        ["listInboundManifests", "has_failed_lines"], ["listInboundManifests", "has_missing_samples"]] as const) bool(pschema(id, f));
      for (const [id, f] of [["listPartnerOrders", "manifest_id"], ["listPartnerOrders", "referrer_id"], ["listInboundManifests", "partner_id"], ["listInboundManifests", "receiving_centre_id"],
        ["listInboundPickups", "partner_id"], ["listInboundPickups", "receiving_centre_id"], ["listReferrerMappings", "partner_id"]] as const) uuid(pschema(id, f), `${id}.${f}`);
      for (const [id, f] of [["listManifests", "state"], ["listPartnerOrders", "tracking_status"], ["listPickupRequests", "state"], ["listInboundManifests", "state"], ["listInboundPickups", "state"]] as const)
        expect(pschema(id, f).type, `${id}.${f}`).toBe("string");
      for (const [id, f] of [["listPartnerPriceList", "q"], ["listPartnerReferrers", "q"], ["listPartners", "q"]] as const) expect(pschema(id, f).maxLength, `${id}.${f}`).toBe(64);
      expect(pschema("listPartnerReports", "include_superseded").default).toBe(false);
    });
    T("enum and default filters: kind, source, mapping_state default unmapped, inbound state defaults", () => {
      expect(pschema("listPartnerPriceList", "kind").enum).toEqual(["test", "panel"]);
      expect(pschema("listPartnerPriceList", "source").enum).toEqual(["partner", "standard"]);
      expect(pschema("listReferrerMappings", "mapping_state").default).toBe("unmapped");
      expect(pschema("listInboundManifests", "state").default).toBe("submitted,partially_received");
      expect(pschema("listInboundPickups", "state").default).toBe("requested,scheduled");
    });
    T("#P2 q 1–64 and limit max 20; #S1 period_month_from/_to YYYY-MM; #S2 period_month path pattern", () => {
      expect([pschema("searchPartnerOrderables", "q").minLength, pschema("searchPartnerOrderables", "q").maxLength]).toEqual([1, 64]);
      expect(pschema("searchPartnerOrderables", "limit").maximum).toBe(20);
      for (const f of ["period_month_from", "period_month_to"]) expect(pschema("listPartnerStatements", f).pattern, f).toBe("^[0-9]{4}-(0[1-9]|1[0-2])$");
      expect(param("getPartnerStatement", "period_month").in).toBe("path");
      expect(pschema("getPartnerStatement", "period_month").pattern).toBe("^[0-9]{4}-(0[1-9]|1[0-2])$");
    });
    T("path ids are required uuids", () => {
      for (const [id, f] of [["getManifest", "manifest_id"], ["replaceManifestLine", "line_id"], ["getPartnerOrder", "order_id"], ["downloadPartnerReport", "report_id"],
        ["getPatientAccessSlip", "access_slip_id"], ["getPickupRequest", "pickup_request_id"], ["updatePartnerReferrer", "referrer_id"], ["changePartnerUserRole", "partner_user_id"],
        ["getPartner", "partner_id"], ["changePartnerUserRoleByStaff", "partner_user_id"], ["getInboundManifest", "manifest_id"], ["retryManifestLineConversion", "line_id"],
        ["schedulePickup", "pickup_request_id"], ["mapPartnerReferrer", "referrer_id"]] as const) {
        expect(param(id, f)?.in, `${id}:${f}`).toBe("path");
        uuid(pschema(id, f), `${id}:${f}`);
      }
      const v = pschema("downloadPartnerReport", "version_no");
      expect([v?.type, v?.minimum]).toEqual(["integer", 1]);
    });
    T("every path parameter is required", () => {
      for (const id of Object.keys(ops)) for (const q of params(id).filter((x: any) => x?.in === "path")) expect(q.required, `${id}:${q.name}`).toBe(true);
    });
  });

  describe("request bodies (TRD §5.1–§5.3)", () => {
    T("#M1 / #M4: notes ≤500, collected_on A.D. date, nothing required; #M4 unset[] array", () => {
      for (const s of ["createManifest", "updateManifest"]) {
        expect(bp(s, "notes").maxLength, s).toBe(500);
        expect(bp(s, "collected_on").format, s).toBe("date");
        expect(reqd(bodySchema(s)), s).toEqual([]);
      }
      expect(bp("updateManifest", "unset").type).toBe("array");
    });
    T("ManifestLineInput is a closed component shared by #M5 and #M6; required patient, consents, orderable_ids, priority", () => {
      const m = schema("ManifestLineInput");
      expect(m, "ManifestLineInput component").toBeDefined();
      for (const s of ["addManifestLine", "replaceManifestLine"]) expect(keys(bodySchema(s)), s).toEqual(keys(m));
      exact(keys(m), ["partner_sample_ref", "patient", "consents", "orderable_ids", "priority", "referrer_id", "collected_at", "clinical_note"], "ManifestLineInput fields");
      exact(reqd(m), ["patient", "consents", "orderable_ids", "priority"], "ManifestLineInput required");
    });
    T("ManifestLineInput bounds: sample ref, patient block, consents, orderables 1–30, priority, note ≤300", () => {
      const p = (f: string) => deref(props(schema("ManifestLineInput"))[f]);
      expect([p("partner_sample_ref").minLength, p("partner_sample_ref").maxLength, p("partner_sample_ref").pattern]).toEqual([1, 40, "^[A-Za-z0-9_./-]+$"]);
      const pat = p("patient");
      exact(Object.keys(props(pat)), ["full_name", "sex", "birth_on", "age_years", "phone_e164"], "patient fields");
      exact(reqd(pat), ["full_name", "sex"], "patient required");
      const g = (f: string) => deref(props(pat)[f]);
      len(g("full_name"), 1, 120);
      expect(g("sex").enum).toEqual(["male", "female", "other", "unknown"]);
      expect(g("birth_on").format).toBe("date");
      int(g("age_years"), 0, 130);
      expect(g("phone_e164").pattern).toBe(E164);
      const c = p("consents");
      exact(Object.keys(props(c)), ["sms", "whatsapp", "email", "share_with_referrer"], "consents fields (consent_text_version is server-set)");
      exact(reqd(c), ["sms", "whatsapp", "email", "share_with_referrer"], "consents required");
      for (const f of ["sms", "whatsapp", "email", "share_with_referrer"]) bool(deref(props(c)[f]));
      const o = p("orderable_ids");
      expect([o.type, o.minItems, o.maxItems]).toEqual(["array", 1, 30]);
      uuid(item(o), "orderable_ids items");
      expect(p("priority").enum).toEqual(["routine", "urgent"]);
      uuid(p("referrer_id"), "referrer_id");
      dt(p("collected_at"), "collected_at");
      expect(p("clinical_note").maxLength).toBe(300);
    });
    T("#M8 / #M10 / #R4 / #SA..reactivate take no required body fields", () => {
      for (const id of ["submitManifest", "discardManifest", "issuePatientAccessSlip", "reactivatePartnerReferrer", "deactivatePartnerReferrer", "reactivatePartnerUser", "reactivatePartner",
        "reactivatePartnerUserByStaff", "unmapPartnerReferrer", "resendPartnerInvitation"]) {
        const b = bodySchema(id);
        if (b) expect(reqd(b), id).toEqual([]);
      }
    });
    T("#M9 withdraw: reason_code coded set manifest_withdraw_reasons (no enum), reason_text ≤300; reason_code required", () => {
      coded(bp("withdrawManifest", "reason_code"), "manifest_withdraw_reasons");
      expect(bp("withdrawManifest", "reason_text").maxLength).toBe(300);
      expect(reqd(bodySchema("withdrawManifest"))).toEqual(["reason_code"]);
    });
    T("#O2 search: q 2–64 required, limit ≤50", () => {
      len(bp("searchPartnerOrders", "q"), 2, 64);
      expect(bp("searchPartnerOrders", "limit").maximum).toBe(50);
      expect(reqd(bodySchema("searchPartnerOrders"))).toEqual(["q"]);
    });
    T("#R2 mark-seen: report_versions 1–200 of {report_id uuid, version_no}, required", () => {
      const a = bp("markPartnerReportsSeen", "report_versions");
      expect([a.type, a.minItems, a.maxItems]).toEqual(["array", 1, 200]);
      const i = item(a);
      exact(Object.keys(props(i)), ["report_id", "version_no"], "report_versions item");
      uuid(deref(props(i).report_id), "report_id");
      exact(reqd(i), ["report_id", "version_no"], "item required");
      expect(reqd(bodySchema("markPartnerReportsSeen"))).toEqual(["report_versions"]);
    });
    T("#K1 pickup: manifest_ids 1–20 uuids, window_start/_end date-time, packages_count 1–50, notes ≤500, contact_name ≤80, phone pattern", () => {
      const s = "createPickupRequest";
      const m = bp(s, "manifest_ids");
      expect([m.type, m.minItems, m.maxItems]).toEqual(["array", 1, 20]);
      uuid(item(m), "manifest_ids items");
      dt(bp(s, "window_start"), "window_start");
      dt(bp(s, "window_end"), "window_end");
      int(bp(s, "packages_count"), 1, 50);
      expect(bp(s, "notes").maxLength).toBe(500);
      expect(bp(s, "contact_name").maxLength).toBe(80);
      expect(bp(s, "contact_phone_e164").pattern).toBe(E164);
      expect([...reqd(bodySchema(s))].sort()).toEqual(["manifest_ids", "packages_count", "window_end", "window_start"]);
    });
    T("#K4 cancel: reason_code coded set pickup_cancel_reasons, required", () => {
      coded(bp("cancelPickupRequest", "reason_code"), "pickup_cancel_reasons");
      expect(reqd(bodySchema("cancelPickupRequest"))).toEqual(["reason_code"]);
    });
    T("#F2 / #F3 referrer: display_name 1–120, qualification ≤120, registration_council ≤20, registration_no ≤30; F2 requires display_name; F3 nothing + unset[]", () => {
      for (const s of ["createPartnerReferrer", "updatePartnerReferrer"]) {
        len(bp(s, "display_name"), 1, 120);
        expect(bp(s, "qualification").maxLength, s).toBe(120);
        expect(bp(s, "registration_council").maxLength, s).toBe(20);
        expect(bp(s, "registration_no").maxLength, s).toBe(30);
      }
      expect(reqd(bodySchema("createPartnerReferrer"))).toEqual(["display_name"]);
      expect(reqd(bodySchema("updatePartnerReferrer"))).toEqual([]);
      expect(bp("updatePartnerReferrer", "unset").type).toBe("array");
    });
    T("#U2 / #SA9 invite: email ≤254, display_name 1–120, partner_role enum; all required", () => {
      for (const s of ["invitePartnerUser", "invitePartnerUserByStaff"]) {
        expect(bp(s, "email").maxLength, s).toBe(254);
        len(bp(s, "display_name"), 1, 120);
        expect(bp(s, "partner_role").enum, s).toEqual(["partner_admin", "partner_member"]);
        expect([...reqd(bodySchema(s))].sort(), s).toEqual(["display_name", "email", "partner_role"]);
      }
    });
    T("#U3 / #SA10 role: partner_role required; #U4 / #SA10 deactivate: reason_code coded set partner_user_deactivate_reasons required", () => {
      for (const s of ["changePartnerUserRole", "changePartnerUserRoleByStaff"]) {
        expect(bp(s, "partner_role").enum, s).toEqual(["partner_admin", "partner_member"]);
        expect(reqd(bodySchema(s)), s).toEqual(["partner_role"]);
      }
      for (const s of ["deactivatePartnerUser", "deactivatePartnerUserByStaff"]) {
        coded(bp(s, "reason_code"), "partner_user_deactivate_reasons");
        expect(reqd(bodySchema(s)), s).toEqual(["reason_code"]);
      }
    });
    T("#SA2 create partner: code pattern, name 1–160, uuids, conversion_mode enum, phone, address ≤300; five required", () => {
      const s = "createPartner";
      expect(bp(s, "partner_code").pattern).toBe("^[A-Z0-9_-]{1,20}$");
      len(bp(s, "name"), 1, 160);
      for (const f of ["credit_party_id", "receiving_branch_id", "receiving_centre_id"]) uuid(bp(s, f), f);
      expect(bp(s, "conversion_mode").enum).toEqual(["on_receipt", "on_submit"]);
      expect(bp(s, "conversion_mode").default, "default comes from settings, not the schema").toBeUndefined();
      expect(bp(s, "contact_email"), "contact_email").toBeDefined();
      expect(bp(s, "contact_phone_e164").pattern).toBe(E164);
      expect(bp(s, "address_text").maxLength).toBe(300);
      expect([...reqd(bodySchema(s))].sort()).toEqual(["credit_party_id", "name", "partner_code", "receiving_branch_id", "receiving_centre_id"]);
    });
    T("#SA4 update partner: mutable fields + unset[]; credit_party_id and partner_code not changeable; nothing required", () => {
      const s = "updatePartner";
      sup(keys(bodySchema(s)), ["name", "receiving_branch_id", "receiving_centre_id", "conversion_mode", "contact_email", "contact_phone_e164", "address_text", "unset"], "mutable");
      for (const f of ["credit_party_id", "partner_code"]) expect(keys(bodySchema(s)), f).not.toContain(f);
      expect(reqd(bodySchema(s))).toEqual([]);
    });
    T("#SA5 suspend: reason_code coded set partner_suspend_reasons required, reason_text ≤300", () => {
      coded(bp("suspendPartner", "reason_code"), "partner_suspend_reasons");
      expect(bp("suspendPartner", "reason_text").maxLength).toBe(300);
      expect(reqd(bodySchema("suspendPartner"))).toEqual(["reason_code"]);
    });
    T("#SA7 resync: scopes 1–3 of price_list|statements|tracking, required", () => {
      const a = bp("resyncPartnerProjections", "scopes");
      expect([a.type, a.minItems, a.maxItems]).toEqual(["array", 1, 3]);
      expect(item(a).enum).toEqual(["price_list", "statements", "tracking"]);
      expect(reqd(bodySchema("resyncPartnerProjections"))).toEqual(["scopes"]);
    });
    T("#SI3 receive: lines 1–200 of {line_id uuid, outcome received|not_received, reason_code coded line_not_received_reasons}", () => {
      const a = bp("receiveManifest", "lines");
      expect([a.type, a.minItems, a.maxItems]).toEqual(["array", 1, 200]);
      const i = item(a);
      exact(Object.keys(props(i)), ["line_id", "outcome", "reason_code"], "line item");
      uuid(deref(props(i).line_id), "line_id");
      expect(deref(props(i).outcome).enum).toEqual(["received", "not_received"]);
      coded(deref(props(i).reason_code), "line_not_received_reasons");
      exact(reqd(i), ["line_id", "outcome"], "item required (reason_code only iff not_received)");
      expect(reqd(bodySchema("receiveManifest"))).toEqual(["lines"]);
    });
    T("#SI4 retry: patient_id uuid optional; #SI5 not-received: reason_code coded, required", () => {
      uuid(bp("retryManifestLineConversion", "patient_id"), "patient_id");
      expect(reqd(bodySchema("retryManifestLineConversion"))).toEqual([]);
      expect(bp("markManifestLineNotReceived", "reason_code")?.["x-coded-set"]).toBeTruthy();
      expect(bp("markManifestLineNotReceived", "reason_code").enum).toBeUndefined();
      expect(reqd(bodySchema("markManifestLineNotReceived"))).toEqual(["reason_code"]);
    });
    T("#SP2 schedule: scheduled_start/_end date-time + assignee_text ≤80, all required; #SP3 picked_up_at optional; #SP4 reason_code coded pickup_reject_reasons", () => {
      for (const f of ["scheduled_start", "scheduled_end"]) dt(bp("schedulePickup", f), f);
      expect(bp("schedulePickup", "assignee_text").maxLength).toBe(80);
      expect([...reqd(bodySchema("schedulePickup"))].sort()).toEqual(["assignee_text", "scheduled_end", "scheduled_start"]);
      dt(bp("markPickupCollected", "picked_up_at"), "picked_up_at");
      expect(reqd(bodySchema("markPickupCollected"))).toEqual([]);
      coded(bp("rejectPickup", "reason_code"), "pickup_reject_reasons");
      expect(reqd(bodySchema("rejectPickup"))).toEqual(["reason_code"]);
    });
    T("#SR2 map: catalog_doctor_id uuid required; #SR3 reject-mapping: reason_code coded referrer_mapping_reject_reasons required", () => {
      uuid(bp("mapPartnerReferrer", "catalog_doctor_id"), "catalog_doctor_id");
      expect(reqd(bodySchema("mapPartnerReferrer"))).toEqual(["catalog_doctor_id"]);
      coded(bp("rejectPartnerReferrerMapping", "reason_code"), "referrer_mapping_reject_reasons");
      expect(reqd(bodySchema("rejectPartnerReferrerMapping"))).toEqual(["reason_code"]);
    });
    T("PartnerSettings (TRD §10.2): ten fields, bounds, enums; PUT body = PartnerSettings", () => {
      const s = schema("PartnerSettings");
      expect(s, "PartnerSettings component").toBeDefined();
      sup(keys(s), SETTINGS, "PartnerSettings fields");
      const g = (f: string) => deref(props(s)[f]);
      expect(g("default_conversion_mode").enum).toEqual(["on_receipt", "on_submit"]);
      for (const f of ["include_default_price_list", "require_mapped_referrer", "access_slip_enabled"]) bool(g(f));
      int(g("max_lines_per_manifest"), 1, 200);
      int(g("draft_ttl_days"), 1, 90);
      int(g("pickup_max_days_ahead"), 1, 30);
      int(g("report_download_daily_cap_per_user"), 50, 5000);
      len(g("consent_text_version"), 1, 32);
      len(g("consent_statement"), 1, 2000);
      sup(keys(bodySchema("updatePartnerSettings")), SETTINGS, "PUT body fields");
    });
    T("no request body names a server-authority field", () => {
      for (const id of Object.keys(ops))
        for (const f of ["tenant_id", "partner_id", "created_by", "received_by", "approved_by", "state", "version"])
          expect(keys(bodySchema(id) ?? {}), `${id}.${f}`).not.toContain(f);
    });
  });

  describe("response shapes (TRD §5.1–§5.3)", () => {
    T("named DTO schemas are components, closed", () => {
      for (const n of DTOS) {
        expect(schema(n), n).toBeDefined();
        const closed = (x: any): boolean => x?.additionalProperties === false || (x?.allOf ?? []).every((a: any) => closed(deref(a)) || a?.$ref);
        expect(closed(schema(n)), `${n} closed`).toBe(true);
      }
    });
    T("paged list ops return {data, page} with the TRD item DTO", () => {
      for (const [id, dto] of Object.entries(LIST_PAGED)) {
        const s = okSchema(id);
        sup(keys(s), ["data", "page"], id);
        sup(keys(item(props(s).data)), keys(schema(dto)), `${id} item`);
      }
    });
    T("unpaginated search ops return {data} only with the TRD item DTO", () => {
      for (const [id, dto] of Object.entries(LIST_DATA)) {
        const s = okSchema(id);
        expect(keys(s), id).toEqual(["data"]);
        sup(keys(item(props(s).data)), keys(schema(dto)), `${id} item`);
      }
    });
    T("single-object ops return (at least) the properties of their named DTO", () => {
      for (const [id, dto] of Object.entries(ONE)) sup(keys(okSchema(id, String(SPECS.find((x) => x.id === id)!.status[0]))), keys(schema(dto)), id);
    });
    T("#PartnerContext: partner/user/tenant/permissions/features exactly", () => {
      exact(keys(schema("PartnerContext")), ["partner", "user", "tenant", "permissions", "features"], "PartnerContext");
      exact(reqd(schema("PartnerContext")), ["partner", "user", "tenant", "permissions", "features"], "PartnerContext required");
      exact(Object.keys(props(prop("PartnerContext", "partner"))), ["id", "partner_code", "name"], "partner");
      exact(Object.keys(props(prop("PartnerContext", "user"))), ["partner_user_id", "display_name", "partner_role", "mfa_enrolled"], "user");
      exact(Object.keys(props(prop("PartnerContext", "tenant"))), ["display_name", "calendar_display", "timezone"], "tenant");
      exact(Object.keys(props(prop("PartnerContext", "features"))), ["access_slip_enabled", "conversion_mode", "include_default_price_list"], "features");
      expect(deref(props(prop("PartnerContext", "user")).partner_role).enum).toEqual(["partner_admin", "partner_member"]);
      expect(deref(props(prop("PartnerContext", "features")).conversion_mode).enum).toEqual(["on_receipt", "on_submit"]);
      expect(prop("PartnerContext", "permissions").type).toBe("array");
    });
    T("#A2 dashboard: counters + optional outstanding Money + outstanding_as_of", () => {
      const s = okSchema("getPartnerDashboard");
      exact(keys(s), ["submitted_today", "in_lab", "reported_today", "rejected_open", "new_reports", "open_pickups", "outstanding", "outstanding_as_of"], "dashboard");
      for (const f of ["outstanding", "outstanding_as_of"]) expect(reqd(s), f).not.toContain(f);
      for (const f of ["submitted_today", "in_lab", "reported_today", "rejected_open", "new_reports", "open_pickups"]) {
        expect(reqd(s), f).toContain(f);
        expect(deref(props(s)[f]).type, f).toBe("integer");
      }
      sup(Object.keys(props(props(s).outstanding)), ["amount_paisa", "currency"], "outstanding Money");
    });
    T("ManifestSummary / Manifest / InboundManifestSummary / InboundManifest fields", () => {
      exact(keys(schema("ManifestSummary")), SUMMARY_KEYS, "ManifestSummary");
      sup(reqd(schema("ManifestSummary")), ["id", "manifest_no", "state", "line_count", "lines_converted", "lines_failed", "receiving_centre", "created_at", "version"], "ManifestSummary required");
      for (const f of ["submitted_at", "received_at", "pickup_request_id"]) expect(reqd(schema("ManifestSummary")), f).not.toContain(f);
      exact(Object.keys(props(prop("ManifestSummary", "receiving_centre"))), ["id", "name"], "receiving_centre");
      exact(keys(schema("Manifest")), [...SUMMARY_KEYS, "notes", "collected_on", "withdraw_reason_code", "lines"], "Manifest");
      expect(reqd(schema("Manifest"))).toContain("lines");
      for (const f of ["notes", "collected_on", "withdraw_reason_code"]) expect(reqd(schema("Manifest")), f).not.toContain(f);
      expect(item(prop("Manifest", "lines"))).toEqual(deref(schema("ManifestLine")));
      sup(keys(schema("InboundManifestSummary")), [...SUMMARY_KEYS, "partner"], "InboundManifestSummary");
      exact(Object.keys(props(prop("InboundManifestSummary", "partner"))), ["id", "partner_code", "name"], "summary partner block");
      sup(keys(schema("InboundManifest")), [...SUMMARY_KEYS, "notes", "collected_on", "withdraw_reason_code", "lines", "partner"], "InboundManifest");
    });
    T("ManifestLine fields exactly; nested patient/consents/orderables/referrer/order/failure", () => {
      exact(keys(schema("ManifestLine")), ["id", "line_no", "state", "partner_sample_ref", "patient", "consents", "orderables", "priority", "referrer", "collected_at", "clinical_note", "order",
        "failure", "not_received_reason_code", "version"], "ManifestLine");
      exact(reqd(schema("ManifestLine")), ["id", "line_no", "state", "patient", "consents", "orderables", "priority", "version"], "ManifestLine required");
      exact(Object.keys(props(prop("ManifestLine", "patient"))), ["full_name", "sex", "birth_on", "age_years", "phone_e164"], "patient");
      exact(Object.keys(props(prop("ManifestLine", "consents"))), ["sms", "whatsapp", "email", "share_with_referrer", "consent_text_version"], "consents");
      exact(Object.keys(props(item(prop("ManifestLine", "orderables")))), ["orderable_id", "kind", "code", "name"], "orderables item");
      exact(Object.keys(props(prop("ManifestLine", "referrer"))), ["id", "display_name"], "referrer");
      exact(Object.keys(props(prop("ManifestLine", "order"))), ["order_id", "registration_no"], "order");
      exact(Object.keys(props(prop("ManifestLine", "failure"))), ["code", "message_key"], "failure");
    });
    T("PartnerOrder / PartnerOrderDetail / PartnerReport fields exactly", () => {
      const PO = ["order_id", "registration_no", "manifest", "line_id", "partner_sample_ref", "patient", "priority", "tracking_status", "referrer", "registered_at", "last_event_at", "report_count", "has_new_report"];
      exact(keys(schema("PartnerOrder")), PO, "PartnerOrder");
      exact(Object.keys(props(prop("PartnerOrder", "manifest"))), ["id", "manifest_no"], "manifest");
      exact(Object.keys(props(prop("PartnerOrder", "patient"))), ["full_name", "sex", "age_years"], "patient (no birth date, no phone)");
      exact(Object.keys(props(prop("PartnerOrder", "referrer"))), ["display_name"], "referrer");
      exact(keys(schema("PartnerOrderDetail")), [...PO, "orderables", "specimens", "reports", "timeline"], "PartnerOrderDetail");
      exact(Object.keys(props(item(prop("PartnerOrderDetail", "orderables")))), ["code", "name"], "orderables item");
      exact(Object.keys(props(item(prop("PartnerOrderDetail", "specimens")))), ["specimen_id", "specimen_type_code", "specimen_type_display", "status", "collected_at", "in_transit_at",
        "received_at", "rejected_at", "rejection_reason_code", "rejection_reason_display", "replaces_specimen_id"], "specimens item");
      exact(Object.keys(props(item(prop("PartnerOrderDetail", "timeline")))), ["at", "label_key", "specimen_type_display"], "timeline item");
      expect(keys(item(prop("PartnerOrderDetail", "reports")))).toEqual(keys(schema("PartnerReport")));
      exact(keys(schema("PartnerReport")), ["report_id", "version_no", "order_id", "registration_no", "patient", "kind", "status", "released_at", "panel_names", "is_new"], "PartnerReport");
      exact(Object.keys(props(prop("PartnerReport", "patient"))), ["full_name"], "report patient");
      expect(prop("PartnerReport", "kind").enum).toEqual(["final", "partial", "preliminary", "amended", "addendum"]);
      expect(prop("PartnerReport", "kind")["x-extensible"], "kind is x-extensible (08 R1/R13)").toBe(true);
      expect(prop("PartnerReport", "status").enum).toEqual(["valid", "superseded"]);
    });
    T("PickupRequest / PickupRequestAdmin fields", () => {
      exact(keys(schema("PickupRequest")), PICKUP_KEYS, "PickupRequest");
      expect([...reqd(schema("PickupRequest"))].sort()).toEqual(expect.arrayContaining(["id", "state", "window_start", "window_end", "packages_count", "manifests", "created_at", "version"]));
      exact(Object.keys(props(item(prop("PickupRequest", "manifests")))), ["id", "manifest_no"], "manifests item");
      sup(keys(schema("PickupRequestAdmin")), [...PICKUP_KEYS, "partner"], "PickupRequestAdmin");
    });
    T("PriceListItem and StatementMonth fields exactly; Money-shaped amounts", () => {
      exact(keys(schema("PriceListItem")), ["orderable_id", "kind", "code", "name", "department_name", "unit_price", "source", "price_list_version", "effective_from", "effective_to"], "PriceListItem");
      expect(prop("PriceListItem", "kind").enum).toEqual(["test", "panel"]);
      expect(prop("PriceListItem", "source").enum).toEqual(["partner", "standard"]);
      sup(Object.keys(props(prop("PriceListItem", "unit_price"))), ["amount_paisa", "currency"], "unit_price");
      for (const f of ["department_name", "effective_to"]) expect(reqd(schema("PriceListItem")), f).not.toContain(f);
      exact(keys(schema("StatementMonth")), ["period_month", "fiscal_year_bs", "invoiced", "paid", "credited", "closing_balance", "synced_at"], "StatementMonth");
      expect(prop("StatementMonth", "period_month").pattern).toBe("^[0-9]{4}-(0[1-9]|1[0-2])$");
      for (const f of ["invoiced", "paid", "credited", "closing_balance"]) sup(Object.keys(props(prop("StatementMonth", f))), ["amount_paisa", "currency"], `StatementMonth.${f}`);
      exact(reqd(schema("StatementMonth")), ["period_month", "fiscal_year_bs", "invoiced", "paid", "credited", "closing_balance", "synced_at"], "StatementMonth required");
    });
    T("#P1 price list and #S1 statements envelopes carry their extra fields", () => {
      sup(keys(okSchema("listPartnerPriceList")), ["data", "page", "price_list_version", "synced_at"], "P1");
      sup(keys(okSchema("listPartnerStatements")), ["data", "page", "outstanding", "outstanding_as_of"], "S1");
      for (const f of ["outstanding", "outstanding_as_of"]) expect(reqd(okSchema("listPartnerStatements")), f).not.toContain(f);
    });
    T("#S2 statement: {period_month, rows[StatementMonth], synced_at}", () => {
      const s = okSchema("getPartnerStatement");
      exact(keys(s), ["period_month", "rows", "synced_at"], "S2");
      expect(keys(item(props(s).rows))).toEqual(keys(schema("StatementMonth")));
    });
    T("PartnerReferrer and PartnerUser fields exactly; PartnerUser exposes email_masked only", () => {
      exact(keys(schema("PartnerReferrer")), ["id", "display_name", "qualification", "registration_council", "registration_no", "is_active", "mapping_state", "samples_this_month", "version"], "PartnerReferrer");
      expect(prop("PartnerReferrer", "mapping_state").enum).toEqual(["unmapped", "mapped", "rejected"]);
      exact(keys(schema("PartnerUser")), ["id", "display_name", "email_masked", "partner_role", "status", "mfa_enrolled", "last_login_at", "version"], "PartnerUser");
      expect(prop("PartnerUser", "status").enum).toEqual(["invited", "active", "deactivated"]);
      expect(prop("PartnerUser", "partner_role").enum).toEqual(["partner_admin", "partner_member"]);
      expect(keys(schema("PartnerUser"))).not.toContain("email");
    });
    T("#SR1 mapping list item = PartnerReferrer + partner{id,name} + optional catalog_doctor{id,display_name}", () => {
      const i = item(props(okSchema("listReferrerMappings")).data);
      sup(Object.keys(props(i)), [...keys(schema("PartnerReferrer")), "partner", "catalog_doctor"], "SR1 item");
      exact(Object.keys(props(props(i).partner)), ["id", "name"], "partner block");
      exact(Object.keys(props(props(i).catalog_doctor)), ["id", "display_name"], "catalog_doctor block");
      expect(reqd(i)).not.toContain("catalog_doctor");
    });
    T("#M11 print view: {manifest: Manifest, partner{name,partner_code}, receiving_centre{name,code}, printed_at}", () => {
      const s = okSchema("getManifestPrintView");
      exact(keys(s), ["manifest", "partner", "receiving_centre", "printed_at"], "print view");
      exact(reqd(s), ["manifest", "partner", "receiving_centre", "printed_at"], "print view required");
      expect(keys(props(s).manifest)).toEqual(keys(schema("Manifest")));
      exact(Object.keys(props(props(s).partner)), ["name", "partner_code"], "partner");
      exact(Object.keys(props(props(s).receiving_centre)), ["name", "code"], "receiving_centre");
    });
    T("#R2 {updated}; #U6 / #SA7 202 with an empty object body", () => {
      exact(keys(okSchema("markPartnerReportsSeen")), ["updated"], "R2");
      expect(deref(props(okSchema("markPartnerReportsSeen")).updated).type).toBe("integer");
      expect(okResp("resendPartnerInvitation").content?.["application/json"], "U6 202 {} body").toBeDefined();
      expect(keys(okSchema("resendPartnerInvitation")), "U6").toEqual([]);
      expect(keys(okSchema("resyncPartnerProjections")), "SA7").toEqual([]);
    });
    T("#R4 / #R5 AccessSlip: fields, state enum, never a token or URL (08 A2.1)", () => {
      const s = schema("AccessSlip");
      sup(keys(s), ["id", "report_id", "version_no", "state", "created_at", "link_expires_at", "failure_code", "issued_at"], "AccessSlip");
      expect(prop("AccessSlip", "state").enum).toEqual(["requested", "issued", "failed", "expired"]);
      sup(reqd(s), ["id", "report_id", "version_no", "state"], "AccessSlip required");
      for (const f of ["link_expires_at", "failure_code", "issued_at"]) expect(reqd(s), f).not.toContain(f);
      for (const id of ["issuePatientAccessSlip", "getPatientAccessSlip"])
        walk(okSchema(id), (n) => { for (const f of Object.keys(props(n))) expect(f, `${id}.${f}`).not.toMatch(/token|url|href|secret|^link$/i); });
      for (const [n, sc] of Object.entries<any>(doc.components?.schemas ?? {}))
        if (/slip/i.test(n)) for (const f of Object.keys(props(sc))) expect(f, `${n}.${f}`).not.toMatch(/token|url|href|secret|^link$/i);
    });
    T("#R3 / #R6 return application/pdf (binary) with Content-Disposition, nosniff, no-store; R3 also X-Lims-Sha256; no JSON body", () => {
      for (const id of pdfOps) {
        const r = okResp(id);
        expect(Object.keys(r.content ?? {}), id).toEqual(["application/pdf"]);
        expect(deref(r.content["application/pdf"].schema), id).toMatchObject({ type: "string", format: "binary" });
        sup(hdrs(id), ["content-disposition", "x-content-type-options", "cache-control"], id);
        const nosniff = Object.entries<any>(r.headers).find(([h]) => h.toLowerCase() === "x-content-type-options")![1];
        expect(JSON.stringify(deref(nosniff))).toMatch(/nosniff/);
        const nostore = Object.entries<any>(r.headers).find(([h]) => h.toLowerCase() === "cache-control")![1];
        expect(JSON.stringify(deref(nostore))).toMatch(/no-store/);
      }
      expect(hdrs("downloadPartnerReport")).toContain("x-lims-sha256");
      expect(ops.downloadPartnerReport.op["x-rate-limit-tier"]).toBe("report_download");
    });
    T("#M5 201 declares the manifest-version `ETag` response header", () => {
      expect(Object.keys(okResp("addManifestLine", "201").headers ?? {}).map((h) => h.toLowerCase())).toContain("etag");
    });
    T("#M7 204 has no body", () => expect(okResp("deleteManifestLine", "204").content).toBeUndefined());
    T("#SA2 / #SA3 PartnerAdmin carries the summary fields; #SA3 adds version + projection_status{price_list_synced_at, statements_synced_at}", () => {
      sup(keys(schema("PartnerAdminSummary")), ["id", "partner_code", "name", "status", "credit_party", "receiving_centre", "active_users", "open_manifests"], "PartnerAdminSummary");
      exact(Object.keys(props(prop("PartnerAdminSummary", "credit_party"))), ["id", "party_code", "name"], "credit_party");
      exact(Object.keys(props(prop("PartnerAdminSummary", "receiving_centre"))), ["id", "code", "name"], "receiving_centre");
      sup(keys(schema("PartnerAdmin")), ["id", "partner_code", "name", "status", "credit_party", "receiving_centre"], "PartnerAdmin");
      const g = okSchema("getPartner");
      sup(keys(g), ["version", "projection_status"], "SA3 extras");
      exact(Object.keys(props(props(g).projection_status)), ["price_list_synced_at", "statements_synced_at"], "projection_status");
    });
    T("no schema or response names tenant_id; no partner-facing response names staff-only / identity fields or a clear `email` (REQ-SEC-081, 03 §5.3)", () => {
      for (const [n, s] of Object.entries<any>(doc.components?.schemas ?? {}))
        for (const f of FORBIDDEN_ANY) expect(Object.keys(props(s)), `${n}.${f}`).not.toContain(f);
      for (const { op, path } of Object.values(ops))
        for (const [, r] of Object.entries<any>(op.responses ?? {}))
          walk(deref(r)?.content?.["application/json"]?.schema, (n) => {
            const bad = path.startsWith(`${PFX}/admin`) ? [...FORBIDDEN_ANY, "email"] : FORBIDDEN_PARTNER;
            for (const f of bad) {
              // Ruling T0C-10.C13: `consents.email` is a boolean consent flag (TRD §5.2 R/M lines, 204/360); only string `email` is a clear address.
              if (f === "email" && deref(props(n).email)?.type === "boolean") continue;
              expect(Object.keys(props(n)), `${op.operationId}.${f}`).not.toContain(f);
            }
          });
    });
  });

  describe("authentication surface", () => {
    T("no operation is public: no x-public, every op security bearerJwt only", () => {
      for (const [id, { op }] of Object.entries(ops)) {
        expect(op["x-public"], id).toBeUndefined();
        expect(op.security, id).toEqual([{ bearerJwt: [] }]);
      }
    });
    T("privileged permissions (partners.partner.manage, partners.partner_user.manage) always list auth.mfa_required", () => {
      for (const [id, { op }] of Object.entries(ops))
        if (PRIVILEGED.includes(op["x-permission"])) expect(op["x-error-codes"], id).toContain(MFA);
    });
    T("partner-facing ops use partner permissions only; /admin ops use staff permissions only", () => {
      const staffPerms = [PRD, PM, MRC, PKM, RMAP];
      for (const [id, { path, op }] of Object.entries(ops)) {
        const admin = path.startsWith(`${PFX}/admin/`);
        expect(staffPerms.includes(op["x-permission"]), `${id} (${op["x-permission"]})`).toBe(admin);
      }
    });
  });

  describe("synthetic examples and offline 'Prism smoke' (AC-0C-1.4)", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...doc, id: "partners.yaml" });
    const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    const check = (ptr: string, example: unknown) => {
      const validate = ajv.getSchema(`partners.yaml#${ptr}`);
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
    it("every operation with a JSON 2xx response has an example Prism can serve; the two PDF downloads declare application/pdf", () => {
      ex();
      expect(Object.keys(ops).length).toBe(TOTAL);
      for (const s of SPECS) {
        const { op, path, method } = ops[s.id];
        const two = Object.entries<any>(op.responses ?? {}).filter(([c]) => /^2/.test(c));
        expect(two.length, `${method} ${path}: no 2xx`).toBeGreaterThan(0);
        for (const [c, r0] of two) {
          const j = deref(r0).content?.["application/json"];
          if (j) expect(Object.keys(j.examples ?? {}).length, `${method} ${path} ${c}: no example`).toBeGreaterThan(0);
          else if (!pdfOps.includes(s.id)) expect(c, `${method} ${path}: non-PDF 2xx without JSON body`).toMatch(/^204$/);
        }
      }
    });
    it("examples are synthetic: only reserved-domain e-mail, no Nepali-mobile-shaped number, no Windows/user paths, no live-looking token or IP", () => {
      ex();
      const vals = exampleValues();
      expect(vals.length, "no examples at all").toBeGreaterThan(0);
      const blob = JSON.stringify(vals);
      for (const m of blob.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g))
        expect(m[1].toLowerCase(), `non-reserved e-mail domain in ${m[0]}`).toMatch(/^(example\.(com|org|net)$|.+\.(test|invalid|example)$)/);
      expect(blob).not.toMatch(/(?<!\d)(?:\+?977[-\s]?)?9[678]\d{8}(?!\d)/);
      expect(blob).not.toMatch(/[A-Z]:\\\\|\/Users\/|\/home\//);
      expect(blob, "no JWT-shaped value").not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
      expect(blob, "no link token / URL in access-slip examples").not.toMatch(/https?:\/\/(?!example\.)/);
      for (const ip of blob.match(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g) ?? [])
        expect(ip, `non-documentation IP ${ip}`).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
    });
  });

  describe("mock script (wave-1 convention)", () => {
    it("package.json has `mock:partners` = prism mock contracts/openapi/partners.yaml on a port no other mock uses", () => {
      const scripts: Record<string, string> = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
      const mine = scripts["mock:partners"];
      expect(mine, "mock:partners script missing").toBeDefined();
      const m = /^prism mock contracts\/openapi\/partners\.yaml --host 127\.0\.0\.1 --port (\d+)$/.exec(mine);
      expect(m, mine).not.toBeNull();
      const ports = Object.entries(scripts).filter(([k]) => k.startsWith("mock:") && k !== "mock:partners" && k !== "mock:list")
        .map(([, v]) => /--port (\d+)/.exec(v)?.[1]);
      expect(ports).not.toContain(m![1]);
    });
  });
});
