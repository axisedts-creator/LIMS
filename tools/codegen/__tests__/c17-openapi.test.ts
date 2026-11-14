// T0C-10.C17 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/homecollection.yaml (C17 transcription of spec/chunks/C17-home-collection/02-TRD.md §5.1–§5.3.1, §6.3, §11.2; LD-103).
// Checks: (1) exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) clean for homecollection.yaml; (3) AC-0C-1.5 negatives on a temp copy;
// (4) homecollection = TRD §5 tables (26 operations: H1–H21 staff, A1–A5 phlebo_app), method+path under /v1/homecollection, x-permission (one code), bearerJwt,
//     x-idempotency, tier general, success statuses, specific + common error codes, Idempotency-Key on required rows, If-Match on versioned actions;
// (5) shape pins: query params, enums, bounds, x-coded-set without enum, DTO fields (§5.3), sync DTOs (§5.3.1), Mutation oneOf + discriminator mapping (§6.3), settings (§11.2),
//     app headers X-Lims-App-Version / X-Lims-Device-Id, no tenant/membership id in any request body;
// (6) "Prism smoke" offline: examples validate (ajv), every JSON 2xx has an example, examples synthetic; (7) package.json `mock:homecollection` script.
// Not testable here: Prism actually serving the file (prism not installed), generated-client freshness (codegen-fresh suite), runtime behaviour (assignee filter, access log, header equality).
// Assumptions (TRD silent or ambiguous; each is also in the notes file):
//  - every op lists five common codes (validation_failed, auth.forbidden, auth.unauthenticated, rate_limited, internal); common.not_found only on ops with a path parameter and on
//    H11 (foreign id → 404, §5.4.4); homecollection.app_version_unsupported + device_not_registered + common.id_mismatch on A1–A5 only (never on staff ops); the other 401 codes are not pinned;
//  - If-Match pinned (header + common.version_conflict + common.precondition_required) on H3 H4 H5 H6 H8 H9 H11 H15 H17 H19 (TRD preamble: actions on versioned resources; every DTO carries `version`);
//    NOT pinned either way: H7 (creates a new visit), H21 (no state), A1–A5 (device-id binding instead); none on GETs, H1 H10 H12 H13 H14 H16 H18 H20;
//  - Idempotency: required rows pin header + three IDEM codes; "optional" rows pin nothing on the header; "none" rows pin no header;
//  - privileged permissions (permissions.yaml: homecollection.device.manage, homecollection.settings.manage) add auth.mfa_required; no other op lists it;
//  - A2 x-permission = homecollection.sync.upload (the floor); coded-set names `homecollection.<set>` (05-SCHEMA §2 set codes), no enum;
//  - bare TRD response (no status code) pins "some 2xx" only; H10/H12/H20 return `{data}` without `page`; H1/H13/H16 return `{data, page}`;
//  - example phone numbers must not look like Nepali mobiles (9[678]xxxxxxxx): the TRD §6.2 example "+9779800000042" does not satisfy that — use a different synthetic number.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRD = join(ROOT, "spec/chunks/C17-home-collection/02-TRD.md");
const FILE = join(ROOT, "contracts/openapi/homecollection.yaml");
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const permissions: any = parse(readFileSync(join(ROOT, "contracts/permissions.yaml"), "utf8"));
const PRIVILEGED = new Set<string>((permissions.permissions ?? []).filter((p: any) => p.privileged).map((p: any) => p.code));
const METHODS = ["get", "put", "post", "delete", "patch"];
const name = "homecollection";
const PFX = "/v1/homecollection";

const VC = "common.version_conflict", PRE = "common.precondition_required", MFA = "auth.mfa_required", NF = "common.not_found";
const IDEM = ["common.idempotency_key_required", "common.idempotency_key_reused", "common.idempotency_in_progress"];
const FIVE = ["common.validation_failed", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"];
const APPV = "homecollection.app_version_unsupported", NREG = "homecollection.device_not_registered", IDM = "common.id_mismatch";
const VCL = "homecollection.visit_closed", MSUP = "homecollection.mutation_superseded";
const VSTATUS = ["unassigned", "assigned", "in_progress", "completed", "failed", "cancelled"];
const VKIND = ["booking", "front_desk", "recollection", "revisit"];
const SETS = ["visit_cancel_reasons", "unassign_reasons", "visit_fail_reasons", "specimen_not_collected_reasons", "revisit_reasons", "review_reasons", "flag_resolutions", "wipe_reasons"];

type Spec = {
  row: string; id: string; method: string; path: string; perm: string; idem: "none" | "optional" | "required" | "any";
  status: number[]; err: string[]; im: boolean | "any"; app?: boolean; paged?: boolean;
};
const N = "none" as const, O = "optional" as const, R = "required" as const;
type Opt = Partial<Pick<Spec, "im" | "app" | "paged">>;
const mk = (row: string, id: string, method: string, path: string, perm: string, idem: Spec["idem"], status: number[], err: string[], o: Opt = {}): Spec =>
  ({ row, id, method, path, perm, idem, status, err, im: false, ...o });
const IM = { im: true as const }, ANY = { im: "any" as const }, L = { paged: true };
const V = "/visits/{visit_id}", HV = "/handovers/{handover_id}";
const AP = { app: true as const };
const SU = "homecollection.sync.upload";
const AE = [NREG, IDM, APPV];

const SPECS: Spec[] = [
  mk("H1", "listHomeVisits", "GET", "/visits", "homecollection.visit.read", N, [200], ["common.invalid_cursor"], L),
  mk("H2", "getHomeVisit", "GET", V, "homecollection.visit.read", N, [200], ["homecollection.visit_not_assigned"]),
  mk("H3", "assignHomeVisit", "POST", `${V}/assign`, "homecollection.visit.assign", R,
    [], [VCL, "homecollection.visit_incomplete", "homecollection.phlebotomist_not_eligible", "frontdesk.consent_required", "frontdesk.booking_already_converted",
      "frontdesk.patient_duplicate_suspected", ...IDEM, VC, PRE], IM),
  mk("H4", "unassignHomeVisit", "POST", `${V}/unassign`, "homecollection.visit.assign", O, [], [VCL, MSUP, VC, PRE], IM),
  mk("H5", "scheduleHomeVisit", "POST", `${V}/schedule`, "homecollection.visit.assign", R, [], [VCL, ...IDEM, VC, PRE], IM),
  mk("H6", "cancelHomeVisit", "POST", `${V}/cancel`, "homecollection.visit.assign", R, [], [VCL, MSUP, ...IDEM, VC, PRE], IM),
  mk("H7", "createHomeRevisit", "POST", `${V}/revisits`, "homecollection.visit.assign", R, [201], [VCL, ...IDEM], ANY),
  mk("H8", "resolveHomeVisitFlag", "POST", `${V}/flags/{flag_id}/resolve`, "homecollection.visit.assign", O, [], [VC, PRE], IM),
  mk("H9", "reviewHeldCollection", "POST", "/collections/{collection_id}/review", "homecollection.visit.assign", R,
    [], ["homecollection.collection_not_held", MSUP, "homecollection.barcode_mismatch", ...IDEM, VC, PRE], IM),
  mk("H10", "listHomeRoutes", "GET", "/routes", "homecollection.visit.read", N, [200], []),
  mk("H11", "resequenceHomeRoute", "POST", "/routes/{route_id}/sequence", "homecollection.visit.assign", O, [], [NF, VC, PRE], IM),
  mk("H12", "listEligiblePhlebotomists", "GET", "/phlebotomists", "homecollection.visit.assign", N, [200], []),
  mk("H13", "listHandovers", "GET", "/handovers", "homecollection.handover.receive", N, [200], [], L),
  mk("H14", "getHandover", "GET", HV, "homecollection.handover.receive", N, [200], []),
  mk("H15", "confirmHandover", "POST", `${HV}/confirm`, "homecollection.handover.receive", R, [], [...IDEM, VC, PRE], IM),
  mk("H16", "listPhleboDevices", "GET", "/devices", "homecollection.device.manage", N, [200], [], L),
  mk("H17", "requestDeviceWipe", "POST", "/devices/{device_id}/wipe", "homecollection.device.manage", R, [], [...IDEM, VC, PRE], IM),
  mk("H18", "getHomecollectionSettings", "GET", "/settings", "homecollection.settings.manage", N, [200], []),
  mk("H19", "updateHomecollectionSettings", "PUT", "/settings", "homecollection.settings.manage", O, [200], [VC, PRE], IM),
  mk("H20", "listHomecollectionReasons", "GET", "/reasons", "homecollection.visit.read", N, [200], []),
  mk("H21", "revealHomeVisitPhone", "POST", `${V}/phone-reveal`, "homecollection.visit.assign", O, [200], [], ANY),
  mk("A1", "registerPhleboDevice", "POST", "/devices", SU, R, [201, 200], [...AE, ...IDEM], AP),
  mk("A2", "getSyncSnapshot", "GET", "/sync/snapshot", SU, N, [200], AE, AP),
  mk("A3", "pushSyncMutations", "POST", "/sync/mutations", SU, R, [200], [...AE, "common.payload_too_large", "common.dependency_unavailable", ...IDEM], AP),
  mk("A4", "ackSync", "POST", "/sync/ack", SU, O, [204], AE, AP),
  mk("A5", "signOffPhleboDevice", "POST", "/devices/{device_id}/sign-off", SU, O, [204], [...AE, "homecollection.unsynced_changes"], { ...AP, im: "any" }),
];
const TOTAL = 26;
// ids of IM:"any" rows that A1–A5 share: A* never take If-Match (device-id binding); pinned absent below
const APP_IDS = SPECS.filter((s) => s.app).map((s) => s.id);

// ---- §5.3 DTOs: "?" marks optional (TRD "field?")
const DTO: Record<string, string[]> = {
  VisitSummaryDto: ["id", "version", "kind", "status", "outcome?", "centre_id", "branch_id", "order_id?", "patient_id", "patient_display_name", "window_start?", "window_end?", "route_id?",
    "route_date?", "route_sequence?", "phlebotomist?", "area_hint?", "open_flag_kinds", "specimens_summary", "last_device_ack_at?"],
  CollectionDto: ["id", "version", "visit_id", "specimen_id", "client_mutation_id", "status", "hold_code?", "scan_method", "barcode_verified", "collected_at", "collected_by", "review?"],
  VisitFlagDto: ["id", "version", "kind", "status", "created_at", "detail_code?", "resolved_at?", "resolution_code?", "resolved_by_display?"],
  RouteDto: ["id", "version", "centre_id", "route_date", "phlebotomist", "visit_ids_in_order", "active_visits", "completed_visits", "last_snapshot_at?", "last_ack_at?"],
  HandoverSummaryDto: ["id", "version", "status", "from", "to_centre_id", "handed_over_at", "item_count", "received_count?"],
  DeviceDto: ["id", "version", "membership_id", "display_name", "platform", "os_version", "app_version", "model?", "status", "registered_at", "last_seen_at?", "last_snapshot_at?",
    "last_push_at?", "max_device_seq_received", "wipe_requested_at?", "wiped_at?"],
  BalanceItem: ["visit_id", "balance_due", "as_of"],
  SnapshotDto: ["server_time", "cursor", "unchanged", "device_command", "balances", "route_date?", "config?", "routes?", "visits?"],
  SnapshotConfig: ["sync_interval_seconds", "offline_purge_hours", "capture_gps", "map_handoff_enabled", "manual_barcode_entry_allowed", "second_identifier", "collection_consent_text_version",
    "collection_consent_text", "payment_methods", "reasons", "handover_centres", "min_app_version"],
  SnapshotVisit: ["visit_id", "version", "route_id", "route_sequence", "status", "kind", "window_start?", "window_end?", "order_id", "outcome?", "patient?", "patient_unavailable?", "address?",
    "note_for_phlebotomist?", "specimens", "specimens_stale?", "balance?", "balance_unavailable?"],
  SnapshotStub: ["visit_id", "version", "route_id", "route_sequence", "status", "kind", "window_start?", "window_end?"],
  PushRequest: ["device_id", "batch_id", "sent_at_device", "anchors", "now", "mutations"],
  Anchor: ["anchor_id", "server_time", "device_wall_time", "monotonic_ms", "boot_id"],
  PushResponse: ["server_time", "batch_id", "results", "handover_items", "device_command"],
  PushResult: ["client_mutation_id", "device_seq", "outcome", "code?"],
  HandoverItemResult: ["handover_id", "specimen_id", "outcome"],
};
const VISIT_DETAIL_EXTRA = ["booking_id", "parent_visit_id", "registration_no", "address", "note_for_phlebotomist", "status_reason_code", "status_reason_text", "assigned_at", "arrived_at",
  "completed_at", "cancelled_at", "specimens", "collections", "flags", "assignments", "transitions", "payments", "balance"];
const HANDOVER_DETAIL_EXTRA = ["items", "received_by_display", "received_at", "note"];
const SETTINGS_KEYS = ["min_app_version", "sync_interval_seconds", "offline_purge_hours", "capture_gps", "gps_retention_days", "map_handoff_enabled", "manual_barcode_entry_allowed",
  "second_identifier", "collection_consent_text_version", "collection_consent_text", "payment_methods", "handover_confirmation_required", "handover_overdue_hours", "max_visits_per_route",
  "notify_phlebotomist_on_assign", "notify_patient_on_assign", "clock_tolerance_seconds"];
// responses: operationId -> DTO component name (single object) / list item name ({data[,page]})
const ONE: Record<string, string> = { getHomeVisit: "VisitDetailDto", assignHomeVisit: "VisitDetailDto", unassignHomeVisit: "VisitDetailDto", scheduleHomeVisit: "VisitDetailDto",
  cancelHomeVisit: "VisitDetailDto", createHomeRevisit: "VisitDetailDto", resolveHomeVisitFlag: "VisitFlagDto", reviewHeldCollection: "CollectionDto", resequenceHomeRoute: "RouteDto",
  getHandover: "HandoverDetailDto", confirmHandover: "HandoverDetailDto", requestDeviceWipe: "DeviceDto", getHomecollectionSettings: "SettingsDto", updateHomecollectionSettings: "SettingsDto",
  registerPhleboDevice: "DeviceDto", getSyncSnapshot: "SnapshotDto", pushSyncMutations: "PushResponse" };
const PAGED: Record<string, string> = { listHomeVisits: "VisitSummaryDto", listHandovers: "HandoverSummaryDto", listPhleboDevices: "DeviceDto" };
const PHI_PARAMS = ["barcode", "registration_no", "booking_no", "phone", "phone_e164", "email", "full_name", "name"];
const FORBIDDEN_BODY = ["tenant_id", "membership_id", "created_by"];

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("homecollection.yaml (T0C-10.C17)", () => {
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
  const schema = (n: string) => doc.components?.schemas?.[n];
  const prop = (n: string, f: string) => deref(props(schema(n))[f]);
  const bodySchema = (id: string) => deref(ops[id]?.op.requestBody?.content?.["application/json"]?.schema);
  const bp = (id: string, f: string) => deref(props(bodySchema(id))[f]);
  const params = (id: string) => (ops[id]?.op.parameters ?? []).map(deref);
  const param = (id: string, pname: string) => params(id).find((q: any) => q?.name === pname);
  const pschema = (id: string, pname: string) => deref(param(id, pname)?.schema);
  const names = (id: string, where = "query") => params(id).filter((q: any) => q?.in === where).map((q: any) => q.name);
  const okResp = (id: string, code?: string) => {
    const e = Object.entries<any>(ops[id].op.responses).find(([c]) => (code ? c === code : /^2/.test(c)));
    expect(e, `${id}: no ${code ?? "2xx"} response`).toBeDefined();
    return deref(e![1]);
  };
  const okSchema = (id: string, code?: string) => deref(okResp(id, code).content?.["application/json"]?.schema);
  const has = (id: string) => expect(ops[id], `${id} missing`).toBeDefined();
  const ex = () => expect(existsSync(FILE), "contracts/openapi/homecollection.yaml missing").toBe(true);
  const T = (title: string, fn: () => void) => it(title, () => { ex(); fn(); });
  const coded = (s: any, set: string) => {
    expect(s?.["x-coded-set"], "x-coded-set").toBe(`homecollection.${set}`);
    expect(s.enum, "coded-set field must not declare enum").toBeUndefined();
  };
  const item = (s: any) => deref(deref(s).items);
  const enumIs = (s: any, want: unknown[]) => expect([...(s?.enum ?? [])].sort(), `enum of ${JSON.stringify(s)}`).toEqual([...want].sort());
  const int = (s: any, min: number | undefined, max: number | undefined) => expect([s?.type, s?.minimum, s?.maximum]).toEqual(["integer", min, max]);
  const len = (s: any, min: number | undefined, max: number) => expect([s?.minLength, s?.maxLength]).toEqual([min, max]);
  const walk = (s: any, fn: (n: any) => void, seen = new Set<any>()) => {
    const n = deref(s);
    if (!n || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    fn(n);
    for (const a of [...(n.allOf ?? []), ...(n.oneOf ?? []), ...(n.anyOf ?? [])]) walk(a, fn, seen);
    for (const q of Object.values(n.properties ?? {})) walk(q, fn, seen);
    if (n.items) walk(n.items, fn, seen);
  };
  const dtoReq = (f: string[]) => f.filter((x) => !x.endsWith("?"));
  const dtoOpt = (f: string[]) => f.filter((x) => x.endsWith("?")).map((x) => x.slice(0, -1));
  const dtoKeys = (f: string[]) => f.map((x) => x.replace(/\?$/, "")).sort();
  const shape = (s: any, fields: string[], label: string) => {
    expect(s, `${label} schema missing`).toBeDefined();
    expect(sorted(s), `${label} fields`).toEqual(dtoKeys(fields));
    expect(reqd(s), `${label} required`).toEqual(expect.arrayContaining(dtoReq(fields)));
    for (const o of dtoOpt(fields)) expect(reqd(s), `${label}.${o} optional`).not.toContain(o);
  };
  const dataOf = (id: string) => item(props(okSchema(id)).data);
  const req = (id: string, ...f: string[]) => f.forEach((x) => expect(param(id, x)?.required, `${id}?${x} required`).toBe(true));
  const opt = (id: string, ...f: string[]) => f.forEach((x) => { expect(param(id, x), `${id}?${x}`).toBeDefined(); expect(param(id, x).required, `${id}?${x} optional`).not.toBe(true); });
  const r = (id: string) => [...reqd(bodySchema(id))].sort();
  const isUuid = (s: any) => expect(s?.format).toBe("uuid");

  describe("exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
    it("file exists", () => expect(existsSync(FILE), "contracts/openapi/homecollection.yaml missing").toBe(true));
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
      const dir = mkdtempSync(join(tmpdir(), "c17-homecollection-lint-"));
      tmps.push(dir);
      cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
      const d = parse(readFileSync(FILE, "utf8"));
      fn(d);
      writeFileSync(join(dir, "contracts/openapi/homecollection.yaml"), stringify(d, { aliasDuplicateObjects: false }));
      return (await lintRepo(dir)).filter((x) => x.file === name);
    };
    const firstOp = (d: any, pred: (o: any) => boolean) =>
      Object.values<any>(d.paths).flatMap((q) => METHODS.map((m) => q[m]).filter(Boolean)).find(pred);

    it("x-permission not in permissions.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = "homecollection.no_such.permission"; });
      expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
    });
    it("x-error-codes entry not in errors.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push("homecollection.no_such_error"); });
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

  describe("homecollection equals 02-TRD §5 (no missing, no extra operations)", () => {
    it(`${TOTAL} operations; table ids unique; file has exactly these`, () => {
      expect(SPECS.length).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.id)).size).toBe(TOTAL);
      expect(Object.keys(ops).sort()).toEqual(SPECS.map((s) => s.id).sort());
    });
    it("TRD drift guard: §5.1–5.2 rows = test rows (row id, operationId, first permission)", () => {
      const all = readFileSync(TRD, "utf8").split("\n");
      const start = all.findIndex((l) => l.startsWith("### 5.1 "));
      const end = all.findIndex((l, k) => k > start && l.startsWith("### 5.3 "));
      expect(start).toBeGreaterThanOrEqual(0);
      const rows = new Map<string, { id: string; perm: string }>();
      for (const l of all.slice(start, end)) {
        const c = l.split("|");
        const row = (c[1] ?? "").trim();
        if (!/^[HA]\d+$/.test(row)) continue;
        rows.set(row, { id: /`([a-z][A-Za-z0-9]+)`/.exec(c[2] ?? "")![1], perm: /`(homecollection\.[a-z_.]+)`/.exec(c[4] ?? "")![1] });
      }
      expect([...rows.keys()].sort(), "row ids").toEqual(SPECS.map((s) => s.row).sort());
      for (const s of SPECS) expect(rows.get(s.row), s.row).toEqual({ id: s.id, perm: s.perm });
    });
    T("every path is /v1/homecollection/… with tags [homecollection]; no human number in a path; no PHI query params (REQ-SEC-098)", () => {
      expect(Object.keys(doc.paths ?? {}).length, "no paths").toBeGreaterThan(0);
      for (const [q, it_] of Object.entries<any>(doc.paths ?? {})) {
        expect(q.startsWith(`${PFX}/`), q).toBe(true);
        expect(q).not.toMatch(/\{(registration_no|barcode|booking_no|phone|email)\}/);
        for (const m of METHODS) if (it_[m]) expect(it_[m].tags, `${m} ${q}`).toEqual([name]);
      }
      for (const id of Object.keys(ops))
        for (const q of params(id)) if (q?.in === "query") expect(PHI_PARAMS, `${id}?${q.name}`).not.toContain(q.name);
    });
  });

  describe.each(SPECS)("$row $id", (s) => {
    const o = ops[s.id]?.op;
    it("exists at the TRD method + path", () => {
      has(s.id);
      expect(`${ops[s.id].method} ${ops[s.id].path}`).toBe(`${s.method} ${PFX}${s.path}`);
    });
    it("has tags, summary, x-idempotency (TRD Idem), x-rate-limit-tier general, x-error-codes", () => {
      has(s.id);
      expect(o.tags).toEqual([name]);
      expect(typeof o.summary).toBe("string");
      if (s.idem !== "any") expect(o["x-idempotency"]).toBe(s.idem);
      expect(["none", "optional", "required"]).toContain(o["x-idempotency"]);
      expect(o["x-rate-limit-tier"]).toBe("general");
      expect(Array.isArray(o["x-error-codes"])).toBe(true);
    });
    it(`x-permission = ${s.perm} (one code), never x-public; security bearerJwt; tenant context only`, () => {
      has(s.id);
      expect(o["x-permission"]).toBe(s.perm);
      expect(o["x-public"]).toBeUndefined();
      expect(o.security).toEqual([{ bearerJwt: [] }]);
      expect([undefined, "tenant"]).toContain(o["x-context"]);
    });
    it("success response status(es)", () => {
      has(s.id);
      const codes = Object.keys(o.responses ?? {});
      for (const c of s.status) expect(codes, `want ${c}`).toContain(String(c));
      expect(codes.some((c) => /^2/.test(c)), "some 2xx").toBe(true);
    });
    it("lists the TRD specific error codes plus the common codes (not_found on object ops, app codes on A*, mfa on privileged)", () => {
      has(s.id);
      const want = [...FIVE, ...s.err];
      if (s.path.includes("{")) want.push(NF);
      for (const c of want) expect(o["x-error-codes"], c).toContain(c);
      if (!s.app) for (const c of [APPV, NREG, IDM]) expect(o["x-error-codes"], `${c} is for A* only`).not.toContain(c);
      if (s.im === false) expect(o["x-error-codes"], "no If-Match on this op").not.toContain(PRE);
      if (PRIVILEGED.has(s.perm)) expect(o["x-error-codes"], "privileged permission").toContain(MFA);
      else expect(o["x-error-codes"], "non-privileged op").not.toContain(MFA);
    });
    it("Idempotency-Key header where x-idempotency required, none where none; If-Match on versioned actions", () => {
      has(s.id);
      const ps = JSON.stringify(o.parameters ?? []);
      if (s.idem === "required") expect(ps).toMatch(/IdempotencyKey|Idempotency-Key/);
      if (s.idem === "none") expect(ps).not.toMatch(/IdempotencyKey|Idempotency-Key/);
      if (s.im === true) expect(ps).toMatch(/IfMatch|If-Match/);
      if (s.im === false || s.app) expect(ps).not.toMatch(/IfMatch|If-Match/);
    });
    if (s.paged)
      it("takes cursor + limit (max 200, default 50)", () => {
        has(s.id);
        const ps = JSON.stringify(o.parameters ?? []);
        expect(ps).toMatch(/cursor|Cursor/);
        expect(ps).toMatch(/limit|Limit/);
        const lim = pschema(s.id, "limit");
        expect([lim?.maximum, lim?.default]).toEqual([200, 50]);
      });
  });

  describe("app operations A1–A5: headers, 426, device binding (TRD §5 preamble, §5.2)", () => {
    T("every A* op requires X-Lims-App-Version (≤20) and X-Lims-Device-Id (uuid) headers; staff ops take neither", () => {
      for (const id of APP_IDS) {
        const v = param(id, "X-Lims-App-Version"), d = param(id, "X-Lims-Device-Id");
        expect([v?.in, v?.required], `${id} app version`).toEqual(["header", true]);
        expect(deref(v.schema).maxLength, `${id} app version length`).toBe(20);
        expect([d?.in, d?.required], `${id} device id`).toEqual(["header", true]);
        isUuid(deref(d.schema));
      }
      for (const s of SPECS.filter((x) => !x.app))
        for (const h of ["X-Lims-App-Version", "X-Lims-Device-Id"]) expect(names(s.id, "header"), `${s.id} ${h}`).not.toContain(h);
    });
    T("A* success: 426 and 409 are declared as responses; A2/A3 are never cached publicly (no Cache-Control: public)", () => {
      for (const id of APP_IDS) {
        const codes = Object.keys(ops[id].op.responses);
        expect(codes, `${id} 426`).toContain("426");
        expect(codes, `${id} 409`).toContain("409");
      }
      expect(JSON.stringify(ops.getSyncSnapshot.op.responses)).not.toMatch(/public/);
    });
    T("A5 declares 409 and 204; A3 declares 413 and 503; A1 declares 201 and 200", () => {
      expect(Object.keys(ops.signOffPhleboDevice.op.responses)).toEqual(expect.arrayContaining(["204", "409"]));
      expect(Object.keys(ops.pushSyncMutations.op.responses)).toEqual(expect.arrayContaining(["200", "413", "503"]));
      expect(Object.keys(ops.registerPhleboDevice.op.responses)).toEqual(expect.arrayContaining(["201", "200"]));
    });
    T("A1–A5 request bodies never carry tenant_id / membership_id / created_by (actor comes from the token, REQ-SEC)", () => {
      for (const id of APP_IDS.filter((x) => ops[x].op.requestBody))
        walk(bodySchema(id), (n) => { for (const k of FORBIDDEN_BODY) expect(Object.keys(n.properties ?? {}), `${id}.${k}`).not.toContain(k); });
    });
  });

  describe("query and path parameters (TRD §5.1–5.2)", () => {
    T("H1 listHomeVisits params, types and sort enum", () => {
      expect(names("listHomeVisits")).toEqual(expect.arrayContaining(["route_date", "window_from", "window_to", "status", "centre_id", "phlebotomist_membership_id",
        "unassigned_only", "has_open_flags", "kind", "sort", "limit", "cursor"]));
      opt("listHomeVisits", "route_date", "window_from", "window_to", "status", "centre_id", "phlebotomist_membership_id", "unassigned_only", "has_open_flags", "kind", "sort");
      expect(pschema("listHomeVisits", "route_date").format).toBe("date");
      for (const f of ["window_from", "window_to"]) expect(pschema("listHomeVisits", f).format, f).toBe("date-time");
      for (const f of ["centre_id", "phlebotomist_membership_id"]) isUuid(pschema("listHomeVisits", f));
      for (const f of ["unassigned_only", "has_open_flags"]) expect(pschema("listHomeVisits", f).type, f).toBe("boolean");
      for (const f of ["status", "kind"]) expect(pschema("listHomeVisits", f).type, f).toBe("string"); // csv
      enumIs(pschema("listHomeVisits", "sort"), ["window_start", "-window_start", "route_sequence", "created_at", "-created_at"]);
    });
    T("H10 route_date required (date), centre_id optional", () => {
      req("listHomeRoutes", "route_date");
      expect(pschema("listHomeRoutes", "route_date").format).toBe("date");
      opt("listHomeRoutes", "centre_id");
      expect(names("listHomeRoutes").sort()).toEqual(["centre_id", "route_date"]);
    });
    T("H12 centre_id required (uuid), route_date optional (date)", () => {
      req("listEligiblePhlebotomists", "centre_id");
      isUuid(pschema("listEligiblePhlebotomists", "centre_id"));
      opt("listEligiblePhlebotomists", "route_date");
      expect(pschema("listEligiblePhlebotomists", "route_date").format).toBe("date");
    });
    T("H13 handover list params; H16 device list params", () => {
      expect(names("listHandovers")).toEqual(expect.arrayContaining(["status", "to_centre_id", "handed_over_from", "handed_over_to", "limit", "cursor"]));
      opt("listHandovers", "status", "to_centre_id", "handed_over_from", "handed_over_to");
      isUuid(pschema("listHandovers", "to_centre_id"));
      expect(names("listPhleboDevices")).toEqual(expect.arrayContaining(["status", "membership_id", "limit", "cursor"]));
      opt("listPhleboDevices", "status", "membership_id");
      isUuid(pschema("listPhleboDevices", "membership_id"));
    });
    T("H20 `set` enum = the eight 05-SCHEMA §2 sets", () => enumIs(pschema("listHomecollectionReasons", "set"), SETS));
    T("A2 device_id required uuid; cursor optional ≤512", () => {
      req("getSyncSnapshot", "device_id");
      isUuid(pschema("getSyncSnapshot", "device_id"));
      opt("getSyncSnapshot", "cursor");
      expect(pschema("getSyncSnapshot", "cursor").maxLength).toBe(512);
    });
    T("path ids (`*_id`) are required uuids; every path parameter is required", () => {
      for (const id of Object.keys(ops))
        for (const q of params(id).filter((x: any) => x?.in === "path")) {
          expect(q.required, `${id}:${q.name}`).toBe(true);
          if (/_id$/.test(q.name)) isUuid(deref(q.schema));
        }
    });
  });

  describe("request bodies (TRD §5.1–5.2, §6.3)", () => {
    T("H3 assign: phlebotomist_membership_id + route_date required, route_sequence 1..60 optional", () => {
      const s = "assignHomeVisit";
      isUuid(bp(s, "phlebotomist_membership_id"));
      expect(bp(s, "route_date").format).toBe("date");
      int(bp(s, "route_sequence"), 1, 60);
      expect(r(s)).toEqual(["phlebotomist_membership_id", "route_date"]);
    });
    T("H4 unassign / H6 cancel / H7 revisit / H8 resolve / H9 review / H17 wipe: coded reasons (x-coded-set, no enum), text ≤500", () => {
      coded(bp("unassignHomeVisit", "reason_code"), "unassign_reasons");
      coded(bp("cancelHomeVisit", "reason_code"), "visit_cancel_reasons");
      coded(bp("createHomeRevisit", "reason_code"), "revisit_reasons");
      coded(bp("resolveHomeVisitFlag", "resolution_code"), "flag_resolutions");
      coded(bp("reviewHeldCollection", "reason_code"), "review_reasons");
      coded(bp("requestDeviceWipe", "reason_code"), "wipe_reasons");
      for (const s of ["unassignHomeVisit", "cancelHomeVisit", "createHomeRevisit", "reviewHeldCollection", "requestDeviceWipe"]) {
        expect(bp(s, "reason_text").maxLength, s).toBe(500);
        expect(r(s), s).toEqual(s === "reviewHeldCollection" ? ["decision", "reason_code"] : ["reason_code"]);
      }
      expect(bp("resolveHomeVisitFlag", "note").maxLength).toBe(500);
      expect(r("resolveHomeVisitFlag")).toEqual(["resolution_code"]);
    });
    T("H5 schedule: window_start/end date-time required; address {address_text 1..500 required, landmark ≤200, latitude/longitude DecimalString}; note ≤500; unset enum array", () => {
      const s = "scheduleHomeVisit";
      for (const f of ["window_start", "window_end"]) expect(bp(s, f).format, f).toBe("date-time");
      expect(r(s)).toEqual(["window_end", "window_start"]);
      const a = bp(s, "address");
      expect(Object.keys(props(a)).sort()).toEqual(["address_text", "landmark", "latitude", "longitude"]);
      len(deref(props(a).address_text), 1, 500);
      expect(deref(props(a).landmark).maxLength).toBe(200);
      for (const f of ["latitude", "longitude"]) expect(deref(props(a)[f]).type, f).toBe("string");
      expect(reqd(a)).toEqual(["address_text"]);
      expect(bp(s, "note_for_phlebotomist").maxLength).toBe(500);
      enumIs(item(bp(s, "unset")), ["note_for_phlebotomist", "landmark", "coordinates"]);
      expect(bp(s, "unset").type).toBe("array");
    });
    T("H9 review: decision apply|discard required", () => {
      enumIs(bp("reviewHeldCollection", "decision"), ["apply", "discard"]);
      expect(r("reviewHeldCollection")).toEqual(["decision", "reason_code"]);
    });
    T("H11 resequence: visit_ids uuid[1..60] required", () => {
      const v = bp("resequenceHomeRoute", "visit_ids");
      expect([v.type, v.minItems, v.maxItems]).toEqual(["array", 1, 60]);
      isUuid(item(v));
      expect(r("resequenceHomeRoute")).toEqual(["visit_ids"]);
    });
    T("H15 confirm: items[1..50] {specimen_id, received} both required; note ≤500", () => {
      const s = "confirmHandover";
      const it_ = bp(s, "items");
      expect([it_.minItems, it_.maxItems]).toEqual([1, 50]);
      expect(Object.keys(props(item(it_))).sort()).toEqual(["received", "specimen_id"]);
      expect(reqd(item(it_)).sort()).toEqual(["received", "specimen_id"]);
      isUuid(deref(props(item(it_)).specimen_id));
      expect(deref(props(item(it_)).received).type).toBe("boolean");
      expect(bp(s, "note").maxLength).toBe(500);
      expect(r(s)).toEqual(["items"]);
    });
    T("H19 settings update: §11.2 keys, ranges, enums; payment_methods 1..10 {code, display ≤40, requires_reference}; no `version`-less extras", () => {
      const s = "updateHomecollectionSettings";
      expect(keys(bodySchema(s)).sort()).toEqual([...SETTINGS_KEYS].sort());
      int(bp(s, "sync_interval_seconds"), 60, 900);
      int(bp(s, "offline_purge_hours"), 4, 24);
      int(bp(s, "gps_retention_days"), 7, 365);
      int(bp(s, "handover_overdue_hours"), 1, 24);
      int(bp(s, "max_visits_per_route"), 1, 60);
      int(bp(s, "clock_tolerance_seconds"), 60, 3600);
      enumIs(bp(s, "second_identifier"), ["phone", "birth_date"]);
      expect(bp(s, "min_app_version").maxLength).toBe(20);
      expect(bp(s, "collection_consent_text_version").maxLength).toBe(40);
      len(bp(s, "collection_consent_text"), 1, 2000);
      for (const f of ["capture_gps", "map_handoff_enabled", "manual_barcode_entry_allowed", "handover_confirmation_required", "notify_phlebotomist_on_assign", "notify_patient_on_assign"])
        expect(bp(s, f).type, f).toBe("boolean");
      const pm = bp(s, "payment_methods");
      expect([pm.type, pm.minItems, pm.maxItems]).toEqual(["array", 1, 10]);
      expect(Object.keys(props(item(pm))).sort()).toEqual(["code", "display", "requires_reference"]);
      expect(reqd(item(pm)).sort()).toEqual(["code", "display", "requires_reference"]);
      expect(deref(props(item(pm)).display).maxLength).toBe(40);
      expect(deref(props(item(pm)).requires_reference).type).toBe("boolean");
    });
    T("H21 phone-reveal body is an empty object (additionalProperties false); response {phone_e164?}", () => {
      const b = bodySchema("revealHomeVisitPhone");
      expect(keys(b)).toEqual([]);
      expect(b.additionalProperties).toBe(false);
      expect(sorted(okSchema("revealHomeVisitPhone"))).toEqual(["phone_e164"]);
      expect(reqd(okSchema("revealHomeVisitPhone"))).not.toContain("phone_e164");
    });
    T("A1 register: device_id uuid, platform android|ios, os_version ≤40, app_version ≤20, model ≤80 optional", () => {
      const s = "registerPhleboDevice";
      isUuid(bp(s, "device_id"));
      enumIs(bp(s, "platform"), ["android", "ios"]);
      expect(bp(s, "os_version").maxLength).toBe(40);
      expect(bp(s, "app_version").maxLength).toBe(20);
      expect(bp(s, "model").maxLength).toBe(80);
      expect(r(s)).toEqual(["app_version", "device_id", "os_version", "platform"]);
    });
    T("A4 ack: device_id, cursor ≤512, applied_at_device, max_device_seq_acked ≥0 required; wipe_completed optional", () => {
      const s = "ackSync";
      isUuid(bp(s, "device_id"));
      expect(bp(s, "cursor").maxLength).toBe(512);
      expect(bp(s, "applied_at_device").format).toBe("date-time");
      int(bp(s, "max_device_seq_acked"), 0, 9007199254740991);
      expect(bp(s, "wipe_completed").type).toBe("boolean");
      expect(r(s)).toEqual(["applied_at_device", "cursor", "device_id", "max_device_seq_acked"]);
    });
    T("A5 sign-off: last_device_seq int ≥0 required", () => {
      int(bp("signOffPhleboDevice", "last_device_seq"), 0, 9007199254740991);
      expect(r("signOffPhleboDevice")).toEqual(["last_device_seq"]);
    });
    T("A3 PushRequest: all six fields required; anchors 0..20; mutations 1..100; now {device_wall_time, monotonic_ms ≥0, boot_id 1..64}", () => {
      const b = bodySchema("pushSyncMutations");
      expect(r("pushSyncMutations")).toEqual(["anchors", "batch_id", "device_id", "mutations", "now", "sent_at_device"]);
      isUuid(bp("pushSyncMutations", "batch_id"));
      const an = bp("pushSyncMutations", "anchors");
      expect([an.type, an.minItems ?? 0, an.maxItems]).toEqual(["array", 0, 20]);
      const mu = bp("pushSyncMutations", "mutations");
      expect([mu.type, mu.minItems, mu.maxItems]).toEqual(["array", 1, 100]);
      const now = bp("pushSyncMutations", "now");
      expect(Object.keys(props(now)).sort()).toEqual(["boot_id", "device_wall_time", "monotonic_ms"]);
      expect(reqd(now).sort()).toEqual(["boot_id", "device_wall_time", "monotonic_ms"]);
      int(deref(props(now).monotonic_ms), 0, 9007199254740991);
      len(deref(props(now).boot_id), 1, 64);
      expect(sorted(b)).toEqual(dtoKeys(DTO.PushRequest));
    });
    T("no request body anywhere carries tenant_id (tenant comes from the token)", () => {
      for (const id of Object.keys(ops).filter((x) => ops[x].op.requestBody))
        walk(bodySchema(id), (n) => expect(Object.keys(n.properties ?? {}), `${id}.tenant_id`).not.toContain("tenant_id"));
    });
  });

  describe("Mutation union (TRD §6.3: oneOf + discriminator type + explicit mapping)", () => {
    const TYPES: Record<string, { visit: boolean; payload: string[]; optional?: string[] }> = {
      "visit.arrived": { visit: true, payload: ["gps"] },
      "visit.identity_checked": { visit: true, payload: ["name_check", "second_identifier", "second_check"] },
      "visit.consent_recorded": { visit: true, payload: ["consent_text_version", "given"] },
      "specimen.collected": { visit: true, payload: ["specimen_id", "scanned_barcode", "scan_method", "specimen_type_code", "gps"] },
      "specimen.not_collected": { visit: true, payload: ["specimen_id", "reason_code", "reason_text"], optional: ["reason_text"] },
      "payment.captured": { visit: true, payload: ["order_id", "payment_method_code", "amount", "reference"], optional: ["reference"] },
      "visit.completed": { visit: true, payload: ["outcome"] },
      "visit.failed": { visit: true, payload: ["reason_code", "reason_text", "gps"], optional: ["reason_text"] },
      "handover.recorded": { visit: false, payload: ["handover_id", "to_centre_id", "specimen_ids"] },
    };
    const mutation = () => deref(props(bodySchema("pushSyncMutations")).mutations && item(bp("pushSyncMutations", "mutations")));
    const variant = (t: string) => {
      const m = mutation().discriminator?.mapping?.[t];
      expect(m, `mapping for ${t}`).toBeDefined();
      return deref({ $ref: m });
    };
    T("Mutation is a oneOf with discriminator.propertyName = type and a mapping entry for each of the nine types", () => {
      const m = mutation();
      expect(Array.isArray(m.oneOf), "oneOf").toBe(true);
      expect(m.oneOf.length).toBe(9);
      expect(m.discriminator?.propertyName).toBe("type");
      expect(Object.keys(m.discriminator?.mapping ?? {}).sort()).toEqual(Object.keys(TYPES).sort());
    });
    for (const [t, spec] of Object.entries(TYPES))
      T(`${t}: envelope fields, type pinned, visit_id ${spec.visit ? "required" : "absent"}, payload fields`, () => {
        const v = variant(t);
        expect(keys(v)).toEqual(expect.arrayContaining(["client_mutation_id", "device_seq", "type", "captured", "payload"]));
        expect(reqd(v)).toEqual(expect.arrayContaining(["client_mutation_id", "device_seq", "type", "captured", "payload"]));
        const ty = deref(props(v).type);
        expect(ty.enum ?? [ty.const]).toEqual([t]);
        isUuid(deref(props(v).client_mutation_id));
        int(deref(props(v).device_seq), 1, 9007199254740991);
        const cap = deref(props(v).captured);
        expect(Object.keys(props(cap)).sort()).toEqual(["anchor_id", "device_wall_time", "elapsed_since_anchor_ms"]);
        expect(reqd(cap).sort()).toEqual(["anchor_id", "device_wall_time", "elapsed_since_anchor_ms"]);
        if (spec.visit) { expect(keys(v)).toContain("visit_id"); expect(reqd(v)).toContain("visit_id"); }
        else expect(reqd(v)).not.toContain("visit_id");
        const p = deref(props(v).payload);
        expect(Object.keys(props(p)).sort(), `${t} payload`).toEqual([...spec.payload].sort());
        expect(reqd(p).sort(), `${t} payload required`).toEqual(spec.payload.filter((f) => !(spec.optional ?? []).includes(f)).sort());
        expect(p.additionalProperties).toBe(false);
      });
    T("payload pins: scanned_barcode pattern, scan_method enum, reason_text ≤200, reference ≤100, amount 1..50,000,000 paisa, outcome, checks, specimen_ids 1..50", () => {
      const pl = (t: string, f: string) => deref(props(deref(props(variant(t)).payload))[f]);
      expect(pl("specimen.collected", "scanned_barcode").pattern).toBe("^[A-Z0-9]{1,20}$");
      enumIs(pl("specimen.collected", "scan_method"), ["camera", "hid", "manual"]);
      expect(pl("specimen.not_collected", "reason_text").maxLength).toBe(200);
      expect(pl("visit.failed", "reason_text").maxLength).toBe(200);
      coded(pl("specimen.not_collected", "reason_code"), "specimen_not_collected_reasons");
      coded(pl("visit.failed", "reason_code"), "visit_fail_reasons");
      expect(pl("payment.captured", "reference").maxLength).toBe(100);
      const amt = props(pl("payment.captured", "amount")).amount_paisa;
      expect([deref(amt)?.minimum, deref(amt)?.maximum], "amount range").toEqual([1, 50000000]);
      enumIs(pl("visit.completed", "outcome"), ["collected", "partial"]);
      enumIs(pl("visit.identity_checked", "name_check"), ["matches", "mismatch"]);
      enumIs(pl("visit.identity_checked", "second_check"), ["matches", "mismatch"]);
      enumIs(pl("visit.identity_checked", "second_identifier"), ["phone", "birth_date"]);
      expect(pl("visit.consent_recorded", "consent_text_version").maxLength).toBe(40);
      expect(pl("visit.consent_recorded", "given").type).toBe("boolean");
      const ids = pl("handover.recorded", "specimen_ids");
      expect([ids.type, ids.minItems, ids.maxItems]).toEqual(["array", 1, 50]);
      isUuid(item(ids));
    });
    T("gps = {status off|denied|unavailable|ok required, latitude?, longitude?, accuracy_m 0..10000}", () => {
      const g = deref(props(deref(props(variant("visit.arrived")).payload)).gps);
      expect(Object.keys(props(g)).sort()).toEqual(["accuracy_m", "latitude", "longitude", "status"]);
      expect(reqd(g)).toEqual(["status"]);
      enumIs(deref(props(g).status), ["off", "denied", "unavailable", "ok"]);
      int(deref(props(g).accuracy_m), 0, 10000);
      for (const f of ["latitude", "longitude"]) expect(deref(props(g)[f]).type, f).toBe("string");
    });
  });

  describe("DTO components (TRD §5.3, §5.3.1, §11.2)", () => {
    for (const [n, f] of Object.entries(DTO)) T(`${n} fields and required set`, () => shape(schema(n), f, n));
    T("VisitDetailDto = VisitSummaryDto + the §5.3 extras", () => {
      const s = schema("VisitDetailDto");
      expect(s, "VisitDetailDto").toBeDefined();
      expect(keys(s)).toEqual(expect.arrayContaining([...dtoKeys(DTO.VisitSummaryDto), ...VISIT_DETAIL_EXTRA]));
      expect(reqd(s)).toEqual(expect.arrayContaining(dtoReq(DTO.VisitSummaryDto)));
      for (const f of VISIT_DETAIL_EXTRA) expect(reqd(s), f).not.toContain(f);
    });
    T("HandoverDetailDto = HandoverSummaryDto + items, received_by_display?, received_at?, note?; items carry barcode + specimen_type_code themselves (D-125)", () => {
      const s = schema("HandoverDetailDto");
      expect(s, "HandoverDetailDto").toBeDefined();
      expect(keys(s)).toEqual(expect.arrayContaining([...dtoKeys(DTO.HandoverSummaryDto), ...HANDOVER_DETAIL_EXTRA]));
      expect(reqd(s)).toContain("items");
      const it_ = item(props(s).items);
      expect(Object.keys(props(it_)).sort()).toEqual(["barcode", "outcome", "specimen_id", "specimen_type_code", "visit_id"]);
      expect(reqd(it_).sort()).toEqual(["barcode", "specimen_id", "specimen_type_code", "visit_id"]);
      enumIs(deref(props(it_).outcome), ["received", "missing"]);
    });
    T("SettingsDto = the §11.2 keys + version", () => {
      const s = schema("SettingsDto");
      expect(s, "SettingsDto").toBeDefined();
      expect(sorted(s)).toEqual([...SETTINGS_KEYS, "version"].sort());
      expect(reqd(s)).toEqual(expect.arrayContaining(["version", ...SETTINGS_KEYS]));
    });
    T("enums: visit kind/status/outcome, flag status, device status/platform, handover status, collection status", () => {
      enumIs(prop("VisitSummaryDto", "kind"), VKIND);
      enumIs(prop("VisitSummaryDto", "status"), VSTATUS);
      enumIs(prop("VisitSummaryDto", "outcome"), ["collected", "partial", "none"]);
      enumIs(prop("VisitFlagDto", "status"), ["open", "resolved"]);
      enumIs(prop("DeviceDto", "status"), ["active", "signed_off", "wipe_requested", "wiped"]);
      enumIs(prop("DeviceDto", "platform"), ["android", "ios"]);
      enumIs(prop("HandoverSummaryDto", "status"), ["pending", "confirmed", "discrepancy"]);
      enumIs(prop("CollectionDto", "status"), ["applied", "held", "discarded"]);
      enumIs(prop("CollectionDto", "scan_method"), ["camera", "hid", "manual"]);
    });
    T("sync enums: device_command none|wipe; PushResult.outcome applied|duplicate|held|rejected; HandoverItemResult.outcome; second_identifier phone|birth_date", () => {
      enumIs(prop("SnapshotDto", "device_command"), ["none", "wipe"]);
      enumIs(prop("PushResponse", "device_command"), ["none", "wipe"]);
      enumIs(prop("PushResult", "outcome"), ["applied", "duplicate", "held", "rejected"]);
      enumIs(prop("HandoverItemResult", "outcome"), ["included", "skipped_not_collected", "skipped_already_handed_over"]);
      enumIs(prop("SnapshotConfig", "second_identifier"), ["phone", "birth_date"]);
    });
    T("snapshot bounds: visits ≤60 oneOf [SnapshotVisit, SnapshotStub]; balances ≤60; stub status = cancelled only; PushResult.code is a Code", () => {
      const v = prop("SnapshotDto", "visits");
      expect([v.type, v.maxItems]).toEqual(["array", 60]);
      expect(deref(v.items).oneOf?.length, "visits items oneOf").toBe(2);
      expect(prop("SnapshotDto", "balances").maxItems).toBe(60);
      const st = prop("SnapshotStub", "status");
      expect(st.enum ?? [st.const]).toEqual(["cancelled"]);
      enumIs(prop("SnapshotVisit", "status"), ["assigned", "in_progress", "completed", "failed"]);
      expect(prop("SnapshotDto", "cursor").maxLength).toBe(512);
      expect(prop("PushResult", "code").type).toBe("string");
    });
    T("§5.3.1 presence rules: SnapshotVisit patient/address/note/balance fields are optional; `true`-flags (patient_unavailable, specimens_stale, balance_unavailable) are enum [true]", () => {
      for (const f of ["patient", "patient_unavailable", "address", "note_for_phlebotomist", "balance", "balance_unavailable", "specimens_stale", "outcome"])
        expect(reqd(schema("SnapshotVisit")), f).not.toContain(f);
      for (const f of ["patient_unavailable", "specimens_stale", "balance_unavailable"]) enumIs(prop("SnapshotVisit", f), [true]);
      const pt = prop("SnapshotVisit", "patient");
      expect(Object.keys(props(pt)).sort()).toEqual(["birth_on", "full_name", "phone_e164"]);
      expect(reqd(pt)).toEqual(["full_name"]);
    });
    T("page responses {data, page} (H1/H13/H16); H10/H12/H20 {data} without page; item shapes", () => {
      for (const [id, dto] of Object.entries(PAGED)) {
        expect(sorted(okSchema(id)), id).toEqual(["data", "page"]);
        const it_ = dataOf(id);
        expect(it_.$ref ?? JSON.stringify(props(props(okSchema(id)).data.items ?? {}) ?? {}), id).toBeDefined();
        expect(JSON.stringify(props(okSchema(id)).data), id).toContain(dto);
      }
      for (const id of ["listHomeRoutes", "listEligiblePhlebotomists", "listHomecollectionReasons"]) expect(sorted(okSchema(id)), id).toEqual(["data"]);
      expect(JSON.stringify(props(okSchema("listHomeRoutes")).data)).toContain("RouteDto");
      const ph = dataOf("listEligiblePhlebotomists");
      expect(Object.keys(props(ph)).sort()).toEqual(["active_visits", "display_name", "membership_id", "route_full", "route_id"]);
      expect(reqd(ph).sort()).toEqual(["active_visits", "display_name", "membership_id", "route_full"]);
      const rs = dataOf("listHomecollectionReasons");
      expect(Object.keys(props(rs)).sort()).toEqual(["code", "display", "is_active", "requires_text"]);
      expect(reqd(rs).sort()).toEqual(["code", "display", "is_active", "requires_text"]);
    });
    T("single-object responses reference the named DTO; A4/A5 success have no body", () => {
      for (const [id, dto] of Object.entries(ONE)) {
        const resp = Object.entries<any>(ops[id].op.responses).filter(([c]) => /^2/.test(c)).map(([, v]) => JSON.stringify(deref(v).content?.["application/json"]?.schema ?? {}));
        expect(resp.some((x) => x.includes(dto)), `${id} → ${dto}`).toBe(true);
      }
      for (const id of ["ackSync", "signOffPhleboDevice"]) expect(okResp(id, "204").content, id).toBeUndefined();
    });
    T("no response schema or request body exposes tenant_id (REQ-SEC-081/098)", () => {
      for (const n of Object.keys(doc.components?.schemas ?? {})) walk(schema(n), (x) => expect(Object.keys(x.properties ?? {}), `${n}.tenant_id`).not.toContain("tenant_id"));
    });
  });

  describe("synthetic examples and offline 'Prism smoke' (AC-0C-1.4)", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...doc, id: "homecollection.yaml" });
    const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    const check = (ptr: string, example: unknown) => {
      const validate = ajv.getSchema(`homecollection.yaml#${ptr}`);
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
        for (const [code, r0] of Object.entries<any>(op.responses ?? {}))
          if (!r0.$ref && r0.content?.["application/json"]) media.push([`${base}/responses/${code}/content/application~1json`, r0.content["application/json"]]);
        for (const [q, m] of media)
          for (const [k, e] of Object.entries<any>(m.examples ?? {})) {
            if (m.schema) check(`${q}/schema`, e.value);
            n++;
            expect(k.length).toBeGreaterThan(0);
          }
      }
      expect(n).toBeGreaterThanOrEqual(30);
    });
    it("every operation with a JSON 2xx response has an example Prism can serve; A3 request carries one example", () => {
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
      expect(Object.keys(ops.pushSyncMutations.op.requestBody?.content?.["application/json"]?.examples ?? {}).length).toBeGreaterThan(0);
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
    it("package.json has `mock:homecollection` = prism mock contracts/openapi/homecollection.yaml on a port no other mock uses", () => {
      const scripts: Record<string, string> = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
      const mine = scripts["mock:homecollection"];
      expect(mine, "mock:homecollection script missing").toBeDefined();
      const m = /^prism mock contracts\/openapi\/homecollection\.yaml --host 127\.0\.0\.1 --port (\d+)$/.exec(mine);
      expect(m, mine).not.toBeNull();
      const ports = Object.entries(scripts).filter(([k]) => k.startsWith("mock:") && k !== "mock:homecollection" && k !== "mock:list")
        .map(([, v]) => /--port (\d+)/.exec(v)?.[1]);
      expect(ports).not.toContain(m![1]);
    });
  });
});
