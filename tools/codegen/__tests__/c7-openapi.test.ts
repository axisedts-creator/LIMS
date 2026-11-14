// T0C-10.C7 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/instruments.yaml (C7 transcription of spec/chunks/C7-instrument-integration/02-TRD.md §7.2–§7.4).
// Checks: (1) exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) clean for instruments.yaml; (3) AC-0C-1.5 negatives on a temp copy;
// (4) inventory = TRD tables (41 ops: E01–E08 agent-facing, E10–E42 staff; there is no E09), method+path, x-permission, security scheme
// (deviceToken | bearerJwt), x-idempotency, rate tier (ingest | general), success status, specific + common error codes, Idempotency-Key / If-Match;
// (5) shape pins from §7.4 (bounds, enums, DTO allowlists: no secret_sha256, no barcode in lists, no raw in rejections, download headers, upload allowlist);
// (6) "Prism smoke" offline: examples validate (ajv), every op has a servable 2xx example, examples synthetic (no e-mail / mobile number / paths / live credential).
// Not testable here: Prism actually serving the file (prism not installed; mock wiring is T0C-08's mocks.test.ts).
// Assumptions (TRD silent): staff ops list the six common codes; device ops list auth.device_token_invalid, validation_failed, rate_limited, internal
// (+ not_found where the TRD row names 404). POST with idem `none`: E01 and E14 (secret in response) = any `E1`–`E4`, E34 (read-only POST) = `E3 `.
// If-Match is a parameter exactly on E13, E15, E16, E26–E31, E41 (rows whose Request column names it); those list version_conflict + precondition_required.
// Tenant context only (`x-context` absent or tenant). Coded-set names: `instruments.g_cs_<set>` or the bare set name. Component schema names = the
// bold names of TRD §7.4 (Message, Heartbeat, InstrumentCreate, Agent, Instrument, MessageSummary, ...).
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRD = join(ROOT, "spec/chunks/C7-instrument-integration/02-TRD.md");
const FILE = join(ROOT, "contracts/openapi/instruments.yaml");
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const METHODS = ["get", "put", "post", "delete", "patch"];
const name = "instruments";
const PFX = "/v1/instruments";

const IP = (s: string) => `instruments.${s}`;
const ENROL = IP("ingest.enrol"), CFG = IP("ingest.config_read"), HB = IP("ingest.heartbeat"), SUB = IP("ingest.submit"), HQ = IP("ingest.host_query");
const AR = IP("agent.read"), AM = IP("agent.manage"), IR = IP("instrument.read"), IMG = IP("instrument.manage"), MR = IP("message.read"), MRM = IP("message.rematch");
const VC = "common.version_conflict", PRE = "common.precondition_required", NF = "common.not_found";
const INV = IP("invalid_transition"), DRV = IP("driver_not_available"), CAP = IP("capability_not_supported"), NOACT = IP("agent_not_active");
const DUP = IP("code_duplicate"), UNK = IP("instrument_unknown"), MISM = IP("device_mismatch"), REPR = IP("reprocess_not_allowed");
const DEVTOK = "auth.device_token_invalid";

type Kind = "device" | "staff";
type Spec = { n: string; id: string; method: string; path: string; perm: string; idem: "none" | "optional" | "required"; status: number;
  im?: boolean; err?: string[]; paged?: boolean; k: Kind; just?: RegExp };
const S = (n: string, id: string, method: string, path: string, perm: string, idem: Spec["idem"], status: number,
  o: { im?: boolean; err?: string[]; paged?: boolean; k?: Kind; just?: RegExp } = {}): Spec =>
  ({ n, id, method, path, perm, idem, status, k: "staff", ...o });
const O = "optional" as const, R = "required" as const, N = "none" as const;
const D = { k: "device" as Kind };
const I = "/instruments/{instrument_id}", A = "/agents/{agent_id}", M = "/messages/{instrument_message_id}";

const SPECS: Spec[] = [
  S("E01", "enrolAgent", "POST", "/agent/enrolments", ENROL, N, 201, { ...D, just: /^E[1-4] / }),
  S("E02", "getAgentConfig", "GET", "/agent/config", CFG, N, 200, D),
  S("E03", "submitAgentHeartbeat", "POST", "/agent/heartbeats", HB, O, 200, D),
  S("E04", "submitMessageBatch", "POST", "/agent/message-batches", SUB, R, 200, { ...D, err: [IP("batch_too_large"), "common.payload_too_large"] }),
  S("E05", "submitHostQuery", "POST", "/agent/host-queries", HQ, R, 200, { ...D, err: [CAP, UNK, MISM, IP("message_malformed"), DRV, NF] }),
  S("E06", "submitAttachment", "POST", "/agent/attachments", SUB, R, 202, { ...D, err: ["common.payload_too_large", "common.unsupported_media_type", UNK, MISM, CAP] }),
  S("E07", "submitAgentLogBundle", "POST", "/agent/log-bundles", HB, R, 201, { ...D, err: [NF, INV] }),
  S("E08", "downloadAgentRelease", "GET", "/agent/releases/{release_id}/package", CFG, N, 200, { ...D, err: [NF] }),
  S("E10", "listAgents", "GET", "/agents", AR, N, 200, { paged: true }),
  S("E11", "createAgent", "POST", "/agents", AM, R, 201, { err: [DUP] }),
  S("E12", "getAgent", "GET", A, AR, N, 200),
  S("E13", "updateAgent", "PATCH", A, AM, N, 200, { im: true, err: [NOACT] }),
  S("E14", "issueEnrolmentCode", "POST", `${A}/enrolment-codes`, AM, N, 201, { err: [NOACT], just: /^E[1-4] / }),
  S("E15", "revokeAgent", "POST", `${A}/revoke`, AM, O, 200, { im: true, err: [INV] }),
  S("E16", "retireAgent", "POST", `${A}/retire`, AM, O, 200, { im: true, err: [IP("agent_has_active_instruments"), INV] }),
  S("E17", "requestAgentCommand", "POST", `${A}/commands`, AM, R, 202, { err: [NOACT] }),
  S("E18", "listAgentCommands", "GET", `${A}/commands`, AR, N, 200, { paged: true }),
  S("E19", "listAgentHealthTransitions", "GET", `${A}/health-transitions`, AR, N, 200, { paged: true }),
  S("E20", "getAgentLogBundle", "GET", `${A}/log-bundles/{bundle_id}`, AM, N, 200),
  S("E21", "listAgentReleases", "GET", "/agent-releases", AR, N, 200),
  S("E22", "listDrivers", "GET", "/drivers", IR, N, 200),
  S("E23", "listInstruments", "GET", "/instruments", IR, N, 200, { paged: true }),
  S("E24", "createInstrument", "POST", "/instruments", IMG, R, 201, { err: [DUP, CAP, DRV, NOACT] }),
  S("E25", "getInstrument", "GET", I, IR, N, 200),
  S("E26", "updateInstrument", "PATCH", I, IMG, N, 200, { im: true, err: [DUP, CAP, DRV, NOACT, INV] }),
  S("E27", "startInstrumentCommissioning", "POST", `${I}/start-commissioning`, IMG, O, 200, { im: true, err: [INV, DRV] }),
  S("E28", "goLiveInstrument", "POST", `${I}/go-live`, IMG, O, 200, { im: true, err: [DRV, IP("go_live_checklist_incomplete"), INV] }),
  S("E29", "suspendInstrument", "POST", `${I}/suspend`, IMG, O, 200, { im: true, err: [INV] }),
  S("E30", "resumeInstrument", "POST", `${I}/resume`, IMG, O, 200, { im: true, err: [INV, DRV] }),
  S("E31", "retireInstrument", "POST", `${I}/retire`, IMG, O, 200, { im: true, err: [INV] }),
  S("E32", "listObservedInstrumentCodes", "GET", `${I}/observed-codes`, IR, N, 200, { paged: true }),
  S("E33", "listInstrumentMessages", "GET", "/messages", MR, N, 200, { paged: true }),
  S("E34", "searchInstrumentMessages", "POST", "/messages/search", MR, N, 200, { just: /^E3 / }),
  S("E35", "getInstrumentMessage", "GET", M, MR, N, 200),
  S("E36", "getInstrumentMessageRaw", "GET", `${M}/raw`, MR, N, 200),
  S("E37", "downloadInstrumentAttachment", "GET", `${M}/attachment/content`, MR, N, 200, { err: ["common.upload_quarantined"] }),
  S("E38", "reprocessInstrumentMessage", "POST", `${M}/reprocess`, MRM, R, 200, { err: [REPR, DRV] }),
  S("E39", "rematchInstrumentRecord", "POST", "/message-records/{record_id}/rematch", MRM, R, 200, { err: [REPR] }),
  S("E40", "getInstrumentSettings", "GET", "/settings", IR, N, 200),
  S("E41", "updateInstrumentSettings", "PUT", "/settings", IMG, N, 200, { im: true }),
  S("E42", "listMessageRejections", "GET", "/rejections", MR, N, 200, { paged: true }),
];
const TOTAL = 41;
const DTOS = ["Message", "Heartbeat", "InstrumentCreate", "Agent", "Instrument", "MessageSummary", "MessageDetail", "RecordView", "AgentSummary", "AgentCommand",
  "HealthTransition", "AgentRelease", "Driver", "InstrumentSummary", "ObservedCode", "ProcessingRun", "InstrumentSettings", "MessageRejection"];
const PHI_PARAMS = ["barcode", "sample_barcode", "registration_no", "patient_id", "patient_name", "patient_display_name", "phone", "phone_e164", "email", "full_name", "name"];

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("instruments.yaml (T0C-10.C7)", () => {
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
  const csName = (s: any, set: string) => expect(s?.["x-coded-set"], set).toMatch(new RegExp(`^(instruments\\.)?(g_cs_)?${set}$`));
  const num = (s: any) => [s?.minimum, s?.maximum];
  const len = (s: any) => [s?.minLength, s?.maxLength];

  describe("exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
    it("file exists", () => expect(existsSync(FILE), "contracts/openapi/instruments.yaml missing").toBe(true));
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
      expect(existsSync(FILE), "contracts/openapi/instruments.yaml missing").toBe(true);
      const v = (await lintRepo(ROOT)).filter((x) => x.file === name);
      expect(v, v.map((x) => `[rule ${x.rule}] ${x.message}`).join("\n")).toEqual([]);
    });
  });

  describe("lint actually checks this file (AC-0C-1.5 negative)", () => {
    const mutate = async (fn: (d: any) => void) => {
      expect(existsSync(FILE), "contracts/openapi/instruments.yaml missing").toBe(true);
      const dir = mkdtempSync(join(tmpdir(), "c7-instruments-lint-"));
      tmps.push(dir);
      cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
      const d = parse(readFileSync(FILE, "utf8"));
      fn(d);
      writeFileSync(join(dir, "contracts/openapi/instruments.yaml"), stringify(d, { aliasDuplicateObjects: false }));
      return (await lintRepo(dir)).filter((x) => x.file === name);
    };
    const firstOp = (d: any, pred: (o: any) => boolean) =>
      Object.values<any>(d.paths).flatMap((p) => METHODS.map((m) => p[m]).filter(Boolean)).find(pred);

    it("x-permission not in permissions.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = "instruments.no_such.permission"; });
      expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
    });
    it("x-error-codes entry not in errors.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push("instruments.no_such_error"); });
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

  describe("inventory equals 02-TRD §7 (no missing, no extra operations)", () => {
    it(`${TOTAL} operations; table ids unique; file has exactly these`, () => {
      expect(SPECS.length).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.id)).size).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.n)).size).toBe(TOTAL);
      expect(Object.keys(ops).sort()).toEqual(SPECS.map((s) => s.id).sort());
    });
    it("every operationId named in the TRD tables §7.2–§7.3 is in the test table (TRD drift guard)", () => {
      const lines = readFileSync(TRD, "utf8").split("\n");
      const start = lines.findIndex((l) => l.startsWith("### 7.2 "));
      const end = lines.findIndex((l, i) => i > start && l.startsWith("### 7.4 "));
      const fromTrd = new Set<string>();
      for (const l of lines.slice(start, end)) {
        const c = l.split("|");
        if (/^\s*E\d{2}\s*$/.test(c[1] ?? "") && c[3]) for (const m of c[3].matchAll(/`([a-z][A-Za-z0-9]+)`/g)) fromTrd.add(m[1]);
      }
      expect(fromTrd.size).toBe(TOTAL);
      const mine = new Set(SPECS.map((s) => s.id));
      for (const id of fromTrd) expect(mine.has(id), `TRD operationId ${id} not in test table`).toBe(true);
    });
    it("every path is /v1/instruments/… with tags [instruments]; no PHI / barcode path or query params (REQ-SEC-098)", () => {
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

  describe.each(SPECS)("$n $id", (r) => {
    const o = ops[r.id]?.op;
    it("exists at the TRD method + path", () => {
      has(r.id);
      expect(`${ops[r.id].method} ${ops[r.id].path}`).toBe(`${r.method} ${PFX}${r.path}`);
    });
    it("has tags, summary, x-idempotency (TRD Idem), the TRD rate tier (ingest | general), x-error-codes", () => {
      expect(o.tags).toEqual([name]);
      expect(typeof o.summary).toBe("string");
      expect(o["x-idempotency"]).toBe(r.idem);
      expect(o["x-rate-limit-tier"]).toBe(r.k === "device" ? "ingest" : "general");
      expect(Array.isArray(o["x-error-codes"])).toBe(true);
    });
    it(`x-permission = ${r.perm}, never x-public; security ${r.k === "device" ? "deviceToken" : "bearerJwt"}; tenant context only`, () => {
      expect(o["x-permission"]).toBe(r.perm);
      expect(o["x-public"]).toBeUndefined();
      expect(o.security).toEqual([{ [r.k === "device" ? "deviceToken" : "bearerJwt"]: [] }]);
      expect([undefined, "tenant"]).toContain(o["x-context"]);
    });
    it("success response status; POST with idem none carries the TRD justification letter (P-8, LD-10)", () => {
      expect(Object.keys(o.responses ?? {}), `want ${r.status}`).toContain(String(r.status));
      if (r.method === "POST" && r.idem === "none") expect(o["x-idempotency-justification"]).toMatch(r.just ?? /^E[1-4] /);
      else expect(o["x-idempotency-justification"] === undefined || typeof o["x-idempotency-justification"] === "string").toBe(true);
    });
    it("lists the TRD specific error codes plus the common codes (+ If-Match codes on IM rows)", () => {
      const six = ["common.validation_failed", "common.not_found", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"];
      const base = r.k === "staff" ? six : ["common.validation_failed", "common.rate_limited", "common.internal", DEVTOK];
      for (const c of [...base, ...(r.im ? [VC, PRE] : []), ...(r.err ?? [])]) expect(o["x-error-codes"], c).toContain(c);
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

  describe("shape pins from TRD §7.2–§7.4", () => {
    it("named DTO schemas are components", () => {
      for (const n of DTOS) expect(schema(n), n).toBeDefined();
    });
    it("request bodies: JSON, multipart for E06 (x-upload); no tenant_id / created_by in any JSON body (rule 7)", () => {
      expect(Object.keys(ops).length, "no operations").toBe(TOTAL);
      for (const [id, { op }] of Object.entries(ops)) {
        const b = op.requestBody?.content ?? {};
        const allowed = id === "submitAttachment" ? ["multipart/form-data"] : ["application/json"];
        for (const k of Object.keys(b)) expect(allowed, `${id} ${k}`).toContain(k);
        const s = deref(b["application/json"]?.schema);
        if (s) for (const f of ["tenant_id", "created_by", "updated_by"]) expect(keys(s), `${id}.${f}`).not.toContain(f);
      }
    });

    it("enrolAgent: body hex64 fingerprint + bounded versions; 201 {agent_id, centre_id, device_token, server_time, config_version}", () => {
      const b = bodySchema("enrolAgent");
      expect(reqd(b)).toEqual(expect.arrayContaining(["host_fingerprint_sha256", "agent_version", "launcher_version", "os_version"]));
      expect(bp("enrolAgent", "host_fingerprint_sha256").pattern).toMatch(/^\^?\[(0-9a-f|a-f0-9)\]\{64\}\$?$/);
      expect([bp("enrolAgent", "agent_version").maxLength, bp("enrolAgent", "launcher_version").maxLength, bp("enrolAgent", "os_version").maxLength]).toEqual([32, 32, 64]);
      expect(b.additionalProperties).toBe(false);
      expect(keys(okSchema("enrolAgent")).sort()).toEqual(["agent_id", "centre_id", "config_version", "device_token", "server_time"]);
      expect(Object.keys(ops.enrolAgent.op.responses)).toContain("401");
    });
    it("getAgentConfig: 200 {alg, key_id, signature, document}", () => {
      expect(keys(okSchema("getAgentConfig")).sort()).toEqual(["alg", "document", "key_id", "signature"]);
    });
    it("Heartbeat: TRD fields, enums and bounds (§7.4)", () => {
      const k = keys(schema("Heartbeat"));
      expect(k).toEqual(expect.arrayContaining(["sent_at_agent", "agent_version", "launcher_version", "os_version", "queue", "disk_free_mb", "clock_offset_ms",
        "clock_offset_uncertainty_ms", "config", "update", "auth_state", "instruments", "counters", "command_results"]));
      expect(schema("Heartbeat").additionalProperties).toBe(false);
      expect(Object.keys(props(prop("Heartbeat", "queue")))).toEqual(expect.arrayContaining(["pending", "uploading", "rejected", "oversize", "uploaded_retained", "oldest_pending_age_seconds"]));
      expect(deref(props(prop("Heartbeat", "config")).state).enum).toEqual(["ok", "signature_invalid", "agent_mismatch", "rollback_rejected", "schema_invalid"]);
      expect(deref(props(prop("Heartbeat", "update")).state).enum).toEqual(["idle", "downloading", "verifying", "staged", "applying", "rolled_back", "verify_failed", "failed"]);
      expect(prop("Heartbeat", "auth_state").enum).toEqual(["ok", "rejected"]);
      expect(prop("Heartbeat", "instruments").maxItems).toBe(50);
      expect(deref(props(deref(prop("Heartbeat", "instruments").items)).link_state).enum).toEqual(["up", "down", "listening", "connecting", "error", "disabled"]);
      expect(prop("Heartbeat", "command_results").maxItems).toBe(20);
      expect(deref(props(deref(prop("Heartbeat", "command_results").items)).state).enum).toEqual(["completed", "failed"]);
      expect(Object.keys(props(prop("Heartbeat", "counters")))).toEqual(expect.arrayContaining(["astm_naks_sent", "astm_naks_received", "astm_incomplete_sessions",
        "mllp_discarded_bytes", "mllp_oversize", "host_query_unavailable"]));
      expect(keys(okSchema("submitAgentHeartbeat"))).toEqual(expect.arrayContaining(["server_time", "latest_config_version", "health_state", "commands"]));
    });
    it("submitMessageBatch: messages 1–100; Message raw_base64 ≤ 1,398,104, hex64 sha, protocol/kind enums, link_meta closed", () => {
      const b = bodySchema("submitMessageBatch");
      expect(reqd(b)).toEqual(expect.arrayContaining(["sent_at_agent", "clock_offset_ms", "messages"]));
      const ms = bp("submitMessageBatch", "messages");
      expect([ms.minItems, ms.maxItems]).toEqual([1, 100]);
      expect(keys(schema("Message"))).toEqual(expect.arrayContaining(["agent_message_id", "instrument_id", "protocol", "kind", "raw_base64", "raw_sha256", "captured_at_agent", "clock_offset_ms", "link_meta"]));
      expect(reqd(schema("Message"))).not.toContain("link_meta");
      expect(prop("Message", "raw_base64").maxLength).toBe(1398104);
      expect(prop("Message", "raw_sha256").pattern).toMatch(/\{64\}/);
      expect(prop("Message", "protocol").enum).toEqual(["astm", "hl7v2"]);
      expect(prop("Message", "kind").enum).toEqual(["data", "incomplete", "host_query"]);
      expect(deref(props(prop("Message", "link_meta")).incomplete_reason).enum).toEqual(["frame_timeout", "new_enq", "new_start_block", "msh_unparseable", "process_restart"]);
      expect(prop("Message", "link_meta").additionalProperties).toBe(false);
      expect(keys(okSchema("submitMessageBatch"))).toEqual(expect.arrayContaining(["server_time", "results"]));
      expect(JSON.stringify(ops.submitMessageBatch.op["x-body-limit"] ?? ops.submitMessageBatch.op.description ?? "")).toMatch(/4 ?MiB|4194304/i);
    });
    it("submitHostQuery: raw_base64 ≤ 64 KiB decoded (≤ 87,384 chars); required body keys; protocol enum", () => {
      expect(reqd(bodySchema("submitHostQuery"))).toEqual(expect.arrayContaining(["instrument_id", "agent_message_id", "protocol", "raw_base64", "raw_sha256", "captured_at_agent", "clock_offset_ms"]));
      const rb = bp("submitHostQuery", "raw_base64");
      expect(rb.maxLength).toBeGreaterThan(0);
      expect(rb.maxLength).toBeLessThanOrEqual(87384);
      expect(bp("submitHostQuery", "protocol").enum).toEqual(["astm", "hl7v2"]);
    });
    it("submitAttachment: multipart metadata + binary file, x-upload pdf|png|jpeg (REQ-SEC-083); 202 outcome accepted|duplicate", () => {
      expect([...ops.submitAttachment.op["x-upload"]].sort()).toEqual(["application/pdf", "image/jpeg", "image/png"]);
      const m = deref(ops.submitAttachment.op.requestBody?.content?.["multipart/form-data"]?.schema);
      expect(m).toBeDefined();
      expect(m.additionalProperties).toBe(false);
      expect(reqd(m)).toEqual(expect.arrayContaining(["metadata", "file"]));
      expect(deref(props(m).file).format).toBe("binary");
      const md = deref(props(m).metadata);
      expect(Object.keys(props(md))).toEqual(expect.arrayContaining(["agent_message_id", "instrument_id", "file_name", "file_sha256", "file_size", "barcode",
        "captured_at_agent", "clock_offset_ms", "file_mtime_agent"]));
      expect(deref(props(md).file_name).maxLength).toBe(255);
      expect(deref(props(md).barcode).maxLength).toBe(40);
      expect(reqd(md)).not.toContain("barcode");
      const rs = okSchema("submitAttachment", "202");
      expect(keys(rs).sort()).toEqual(["attachment_id", "instrument_message_id", "outcome", "scan_state"]);
      expect(deref(props(rs).outcome).enum).toEqual(["accepted", "duplicate"]);
    });
    it("submitAgentLogBundle: lines 1–20000 × ≤ 1000; 201 {bundle_id}; getAgentLogBundle returns the bundle", () => {
      expect(reqd(bodySchema("submitAgentLogBundle"))).toEqual(expect.arrayContaining(["command_id", "lines", "from_at_agent", "to_at_agent"]));
      const l = bp("submitAgentLogBundle", "lines");
      expect([l.minItems, l.maxItems, deref(l.items).maxLength]).toEqual([1, 20000, 1000]);
      expect(keys(okSchema("submitAgentLogBundle"))).toEqual(["bundle_id"]);
      expect(keys(okSchema("getAgentLogBundle")).sort()).toEqual(["bundle_id", "created_at", "from_at_agent", "lines", "to_at_agent"]);
    });
    it("downloadAgentRelease: application/octet-stream binary with Content-Length + X-Package-Sha256 headers", () => {
      const r = okResp("downloadAgentRelease");
      expect(Object.keys(r.content ?? {})).toEqual(["application/octet-stream"]);
      expect(deref(r.content["application/octet-stream"].schema).format).toBe("binary");
      const h = JSON.stringify(r.headers ?? {}).toLowerCase();
      expect(h).toContain("content-length");
      expect(h).toContain("x-package-sha256");
    });

    it("listAgents: filters + sort enum; AgentSummary allowlist", () => {
      expect(params("listAgents").map((p: any) => p?.name)).toEqual(expect.arrayContaining(["centre_id", "status", "health_state", "sort", "cursor", "limit"]));
      expect(pschema("listAgents", "sort").enum).toEqual(["agent_code", "-last_heartbeat_at"]);
      expect(keys(schema("AgentSummary"))).toEqual(expect.arrayContaining(["id", "agent_code", "display_name", "centre_id", "status", "update_channel", "version", "latest_config_version", "health"]));
      expect(Object.keys(props(prop("AgentSummary", "health")))).toEqual(expect.arrayContaining(["state", "last_heartbeat_at", "agent_version", "queue_depth",
        "oldest_pending_age_seconds", "clock_offset_seconds", "config_state", "update_state"]));
      expect(keys(schema("AgentSummary"))).not.toContain("tenant_id");
    });
    it("createAgent: agent_code ^[A-Z0-9-]{2,32}$, display_name 1–80, centre_id required, update_channel stable|beta, backlog_threshold 10–100000; 201 Agent", () => {
      const b = bodySchema("createAgent");
      expect(reqd(b)).toEqual(expect.arrayContaining(["agent_code", "display_name", "centre_id"]));
      expect(reqd(b)).not.toContain("update_channel");
      expect(bp("createAgent", "agent_code").pattern).toBe("^[A-Z0-9-]{2,32}$");
      expect(len(bp("createAgent", "display_name"))).toEqual([1, 80]);
      expect(bp("createAgent", "update_channel").enum).toEqual(["stable", "beta"]);
      expect(num(bp("createAgent", "backlog_threshold"))).toEqual([10, 100000]);
      expect(b.additionalProperties).toBe(false);
      expect(JSON.stringify(okResp("createAgent", "201"))).toMatch(/Agent/);
    });
    it("Agent: TRD fields; health + credentials shapes; never secret_sha256 or a token", () => {
      const k = keys(schema("Agent"));
      expect(k).toEqual(expect.arrayContaining(["id", "agent_code", "display_name", "centre_id", "status", "update_channel", "pinned_release_id", "backlog_threshold",
        "enrolled_at", "revoked_at", "revoke_reason_code", "retired_at", "version", "health", "latest_config_version", "credentials"]));
      for (const f of ["secret_sha256", "secret", "token", "device_token", "enrolment_code", "tenant_id"]) expect(k, f).not.toContain(f);
      expect(Object.keys(props(prop("Agent", "health")))).toEqual(expect.arrayContaining(["state", "health_version", "last_heartbeat_at", "queue_depth",
        "oldest_pending_age_seconds", "queue_rejected", "queue_oversize", "disk_free_mb", "clock_offset_seconds", "clock_offset_ms", "clock_offset_uncertainty_ms",
        "config_version_applied", "config_state", "update_state", "update_target_version", "auth_state", "last_ip", "last_ip_changed_at"]));
      expect(deref(props(prop("Agent", "health")).last_ip).maxLength).toBe(45);
      const c = Object.keys(props(deref(prop("Agent", "credentials").items)));
      expect(c).toEqual(expect.arrayContaining(["credential_id", "kind", "status", "issued_at", "issued_by_display", "expires_at", "used_at", "last_used_at", "revoked_at"]));
      for (const f of ["secret_sha256", "secret", "token", "value"]) expect(c, f).not.toContain(f);
    });
    it("updateAgent: optional fields only, unset enum [pinned_release_id], backlog 10–100000", () => {
      const b = bodySchema("updateAgent");
      expect(keys(b)).toEqual(expect.arrayContaining(["display_name", "update_channel", "pinned_release_id", "backlog_threshold", "unset"]));
      expect(reqd(b)).toEqual([]);
      expect(deref(bp("updateAgent", "unset").items).enum).toEqual(["pinned_release_id"]);
      expect(num(bp("updateAgent", "backlog_threshold"))).toEqual([10, 100000]);
      expect(b.additionalProperties).toBe(false);
    });
    it("issueEnrolmentCode: empty closed body; 201 {enrolment_code, expires_at, credential_id}", () => {
      const b = bodySchema("issueEnrolmentCode");
      if (b) expect(keys(b)).toEqual([]);
      expect(keys(okSchema("issueEnrolmentCode")).sort()).toEqual(["credential_id", "enrolment_code", "expires_at"]);
    });
    it("revokeAgent / retireAgent: reason_code (coded set, no enum) required, reason_text ≤ 300", () => {
      for (const id of ["revokeAgent", "retireAgent"]) {
        expect(reqd(bodySchema(id)), id).toContain("reason_code");
        expect(bp(id, "reason_code")["x-coded-set"], id).toBeDefined();
        expect(bp(id, "reason_code").enum, id).toBeUndefined();
        expect(bp(id, "reason_text").maxLength, id).toBe(300);
        expect(reqd(bodySchema(id)), id).not.toContain("reason_text");
      }
      csName(bp("revokeAgent", "reason_code"), "revoke_reasons");
    });
    it("requestAgentCommand: kind enum; params.since; 202 AgentCommand; AgentCommand allowlist", () => {
      expect(bp("requestAgentCommand", "kind").enum).toEqual(["upload_logs", "refresh_config", "restart_service", "reupload_since"]);
      expect(reqd(bodySchema("requestAgentCommand"))).toContain("kind");
      expect(keys(bp("requestAgentCommand", "params"))).toContain("since");
      expect(JSON.stringify(okResp("requestAgentCommand", "202"))).toMatch(/AgentCommand/);
      expect(keys(schema("AgentCommand"))).toEqual(expect.arrayContaining(["command_id", "agent_id", "kind", "params", "state", "requested_at", "requested_by_display",
        "delivered_at", "completed_at", "result_code", "expires_at", "log_bundle_id"]));
      expect(prop("AgentCommand", "state").enum).toEqual(["queued", "delivered", "completed", "failed", "expired"]);
      expect(prop("AgentCommand", "kind").enum).toEqual(["upload_logs", "refresh_config", "restart_service", "reupload_since"]);
      expect(deref(props(schema("AgentCommand")).requested_by_display).maxLength).toBe(120);
      expect(deref(props(schema("AgentCommand")).result_code).maxLength).toBe(64);
    });
    it("health transitions: changed_at_from/_to params; HealthTransition fields; silent_instrument_ids ≤ 50", () => {
      expect(params("listAgentHealthTransitions").map((p: any) => p?.name)).toEqual(expect.arrayContaining(["changed_at_from", "changed_at_to"]));
      expect(keys(schema("HealthTransition"))).toEqual(expect.arrayContaining(["health_version", "from_state", "to_state", "changed_at", "last_heartbeat_at",
        "queue_depth", "clock_offset_seconds", "silent_instrument_ids"]));
      expect(prop("HealthTransition", "from_state").enum).toEqual(["online", "offline", "backlog", "degraded"]);
      expect(prop("HealthTransition", "silent_instrument_ids").maxItems).toBe(50);
    });
    it("AgentRelease: version semver pattern, channel enum, notes ≤ 2000; no signature / hash fields; listAgentReleases has channel filter", () => {
      const k = keys(schema("AgentRelease"));
      expect(k).toEqual(expect.arrayContaining(["id", "version", "channel", "released_at", "package_size", "min_windows_build", "notes", "is_active"]));
      for (const f of ["signature", "sha256", "package_sha256", "hash", "checksum", "tenant_id"]) expect(k, f).not.toContain(f);
      expect(prop("AgentRelease", "version").pattern).toBe("^[0-9]+\\.[0-9]+\\.[0-9]+$");
      expect(prop("AgentRelease", "channel").enum).toEqual(["stable", "beta"]);
      expect(prop("AgentRelease", "notes").maxLength).toBe(2000);
      expect(param("listAgentReleases", "channel")).toBeDefined();
    });
    it("Driver: status enum, capabilities booleans, manual shape; listDrivers filters", () => {
      expect(keys(schema("Driver"))).toEqual(expect.arrayContaining(["code", "display_name", "protocol", "vendor", "model_pattern", "status", "driver_version", "capabilities", "manual", "is_active"]));
      expect(prop("Driver", "status").enum).toEqual(["generic", "verified", "sketch_blocked"]);
      expect(Object.keys(props(prop("Driver", "capabilities")))).toEqual(expect.arrayContaining(["host_query", "worklist_download", "qc", "attachments", "calibration"]));
      expect(Object.keys(props(prop("Driver", "manual")))).toEqual(expect.arrayContaining(["title", "document_id", "revision", "software_version"]));
      expect(params("listDrivers").map((p: any) => p?.name)).toEqual(expect.arrayContaining(["protocol", "status"]));
    });

    it("InstrumentCreate: TRD bounds; transport is oneOf + discriminator(kind) with explicit mapping (02-CV §4.12); capabilities closed", () => {
      const s = schema("InstrumentCreate");
      expect(s.additionalProperties).toBe(false);
      expect(reqd(s)).toEqual(expect.arrayContaining(["instrument_code", "display_name", "agent_id", "vendor", "model", "protocol", "driver_code", "transport", "capabilities"]));
      for (const f of ["serial_no", "software_version", "protocol_options", "parser_options", "file_drop", "qc_sample_id_patterns", "timezone", "silence_window_minutes"])
        expect(reqd(s), f).not.toContain(f);
      expect(prop("InstrumentCreate", "instrument_code").pattern).toBe("^[A-Z0-9-]{2,32}$");
      expect(len(prop("InstrumentCreate", "display_name"))).toEqual([1, 80]);
      expect(len(prop("InstrumentCreate", "vendor"))).toEqual([1, 60]);
      expect(len(prop("InstrumentCreate", "model"))).toEqual([1, 60]);
      expect(prop("InstrumentCreate", "serial_no").maxLength).toBe(60);
      expect(prop("InstrumentCreate", "software_version").maxLength).toBe(40);
      expect(prop("InstrumentCreate", "protocol").enum).toEqual(["astm", "hl7v2", "file_drop"]);
      expect(prop("InstrumentCreate", "driver_code").maxLength).toBe(64);
      expect(prop("InstrumentCreate", "timezone").maxLength).toBe(64);
      expect(num(prop("InstrumentCreate", "silence_window_minutes"))).toEqual([15, 1440]);
      expect(prop("InstrumentCreate", "silence_active_from").pattern).toBeDefined();
      expect(prop("InstrumentCreate", "silence_active_to").pattern).toBeDefined();
      const q = prop("InstrumentCreate", "qc_sample_id_patterns");
      expect([q.maxItems, deref(q.items).maxLength]).toEqual([10, 100]);
      const cap = prop("InstrumentCreate", "capabilities");
      expect(Object.keys(props(cap)).sort()).toEqual(["host_query", "worklist_download"]);
      expect(cap.additionalProperties).toBe(false);
      const t = prop("InstrumentCreate", "transport");
      expect(Array.isArray(t.oneOf) && t.oneOf.length >= 2, "transport oneOf").toBe(true);
      expect(t.discriminator?.propertyName).toBe("kind");
      expect(Object.keys(t.discriminator?.mapping ?? {}).length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(t.discriminator.mapping).length).toBe(t.oneOf.length);
      expect(JSON.stringify(bodySchema("createInstrument"))).toMatch(/InstrumentCreate/);
      expect(JSON.stringify(okResp("createInstrument", "201"))).toMatch(/Instrument/);
    });
    it("Instrument = InstrumentCreate fields + id, centre_id, state, driver_status, version, status{...}; updateInstrument forbids instrument_code / agent_id", () => {
      expect(keys(schema("Instrument"))).toEqual(expect.arrayContaining(["instrument_code", "agent_id", "id", "centre_id", "state", "driver_status", "driver_version",
        "commissioned_at", "live_at", "live_by_display", "go_live_checklist", "suspended_at", "retired_at", "version", "status"]));
      expect(Object.keys(props(prop("Instrument", "status")))).toEqual(expect.arrayContaining(["link_state", "last_message_at", "last_message_at_agent",
        "last_link_error_code", "instrument_clock_offset_seconds", "silent_since"]));
      expect(keys(schema("Instrument"))).not.toContain("tenant_id");
      const b = bodySchema("updateInstrument");
      expect(keys(b)).toEqual(expect.arrayContaining(["display_name", "vendor", "model", "transport"]));
      expect(keys(b)).not.toContain("instrument_code");
      expect(keys(b)).not.toContain("agent_id");
      expect(reqd(b)).toEqual([]);
      expect(b.additionalProperties).toBe(false);
    });
    it("InstrumentSummary + listInstruments: filters, sort enum, unmapped_code_count ≥ 0", () => {
      expect(params("listInstruments").map((p: any) => p?.name)).toEqual(expect.arrayContaining(["centre_id", "agent_id", "state", "protocol", "sort", "cursor", "limit"]));
      expect(pschema("listInstruments", "sort").enum).toEqual(["instrument_code", "-last_message_at"]);
      expect(keys(schema("InstrumentSummary"))).toEqual(expect.arrayContaining(["id", "instrument_code", "display_name", "vendor", "model", "protocol", "agent_id",
        "agent_code", "centre_id", "driver_code", "driver_status", "state", "version", "link_state", "last_message_at", "unmapped_code_count"]));
      expect(prop("InstrumentSummary", "unmapped_code_count").minimum).toBe(0);
    });
    it("lifecycle bodies: go-live checklist (4 booleans, all required) + evidence_note 10–2000; suspend/retire reason_text 3–300", () => {
      const cl = bp("goLiveInstrument", "checklist");
      expect(Object.keys(props(cl)).sort()).toEqual(["manual_reference_confirmed", "mappings_reviewed", "qc_comparison_done", "sample_comparison_done"]);
      expect([...reqd(cl)].sort()).toEqual(["manual_reference_confirmed", "mappings_reviewed", "qc_comparison_done", "sample_comparison_done"]);
      for (const f of Object.keys(props(cl))) expect(deref(props(cl)[f]).type, f).toBe("boolean");
      expect(reqd(bodySchema("goLiveInstrument"))).toEqual(expect.arrayContaining(["checklist", "evidence_note"]));
      expect(len(bp("goLiveInstrument", "evidence_note"))).toEqual([10, 2000]);
      for (const id of ["suspendInstrument", "retireInstrument"]) {
        expect(reqd(bodySchema(id)), id).toContain("reason_text");
        expect(len(bp(id, "reason_text")), id).toEqual([3, 300]);
      }
      for (const id of ["startInstrumentCommissioning", "resumeInstrument"]) {
        const b = bodySchema(id);
        if (b) expect(keys(b), id).toEqual([]);
      }
    });
    it("observed codes: record_class + mapping_status filters; ObservedCode shape", () => {
      expect(pschema("listObservedInstrumentCodes", "record_class").enum).toEqual(["patient", "qc", "calibrator"]);
      expect(param("listObservedInstrumentCodes", "mapping_status")).toBeDefined();
      expect(keys(schema("ObservedCode"))).toEqual(expect.arrayContaining(["instrument_id", "record_class", "instrument_analyte_code", "first_seen_at", "last_seen_at",
        "seen_count", "last_mapping_status", "last_analyte_id", "last_mapping_checked_at"]));
      expect(len(prop("ObservedCode", "instrument_analyte_code"))).toEqual([1, 64]);
      expect(prop("ObservedCode", "seen_count").minimum).toBe(1);
      expect(prop("ObservedCode", "last_mapping_status").enum).toEqual(["mapped", "unmapped"]);
    });

    it("listInstrumentMessages: received_at_from + _to REQUIRED; sort -received_at; filters; no barcode param", () => {
      for (const p of ["received_at_from", "received_at_to"]) expect(param("listInstrumentMessages", p)?.required, p).toBe(true);
      expect(pschema("listInstrumentMessages", "sort").enum).toEqual(["-received_at"]);
      expect(params("listInstrumentMessages").map((p: any) => p?.name)).toEqual(expect.arrayContaining(["instrument_id", "agent_id", "centre_id", "message_kind",
        "latest_outcome", "has_unmapped", "has_qc"]));
      expect(pschema("listInstrumentMessages", "has_qc").type).toBe("boolean");
      expect(pschema("listInstrumentMessages", "has_unmapped").type).toBe("boolean");
      expect(JSON.stringify(ops.listInstrumentMessages.op.description ?? "") + JSON.stringify(param("listInstrumentMessages", "received_at_to"))).toMatch(/31/);
    });
    it("searchInstrumentMessages: sample_barcode ^[A-Z0-9]{1,40}$ required, in the BODY (REQ-SEC-098); ≤ 50 rows; optional window + instrument", () => {
      const b = bodySchema("searchInstrumentMessages");
      expect(reqd(b)).toEqual(["sample_barcode"]);
      expect(bp("searchInstrumentMessages", "sample_barcode").pattern).toBe("^[A-Z0-9]{1,40}$");
      expect(keys(b)).toEqual(expect.arrayContaining(["received_at_from", "received_at_to", "instrument_id"]));
      expect(b.additionalProperties).toBe(false);
      expect(deref(props(okSchema("searchInstrumentMessages")).data).maxItems).toBe(50);
    });
    it("MessageSummary: TRD fields, latest_run counters, NO barcode (lists must not carry it)", () => {
      const k = keys(schema("MessageSummary"));
      expect(k).toEqual(expect.arrayContaining(["id", "instrument_id", "instrument_code", "agent_id", "centre_id", "protocol", "message_kind", "received_at",
        "captured_at", "size_bytes", "latest_run"]));
      for (const f of ["sample_barcode", "barcode", "raw_base64", "raw", "tenant_id"]) expect(k, f).not.toContain(f);
      expect(Object.keys(props(prop("MessageSummary", "latest_run")))).toEqual(expect.arrayContaining(["run_no", "kind", "outcome", "patient_records", "qc_records",
        "calibrator_records", "unmapped_records", "emitted_events"]));
    });
    it("MessageDetail: summary + control fields, runs[], records[], attachment{...}, records_expired boolean; getInstrumentMessage has preview_parse", () => {
      expect(keys(schema("MessageDetail"))).toEqual(expect.arrayContaining(["id", "latest_run", "message_control_id", "message_key_kind", "warnings", "runs", "records",
        "attachment", "records_expired"]));
      expect(Object.keys(props(prop("MessageDetail", "attachment")))).toEqual(expect.arrayContaining(["attachment_id", "scan_state", "mime_type", "size_bytes", "original_file_name"]));
      expect(prop("MessageDetail", "records_expired").type).toBe("boolean");
      expect(pschema("getInstrumentMessage", "preview_parse").type).toBe("boolean");
    });
    it("RecordView: TRD fields incl. emit_status / port_outcome; no tenant_id", () => {
      const k = keys(schema("RecordView"));
      expect(k).toEqual(expect.arrayContaining(["id", "run_no", "record_seq", "record_class", "sample_barcode", "control_id_raw", "record_kind", "instrument_analyte_code",
        "mapping_status", "analyte_id", "test_id", "value_raw", "unit_raw", "instrument_flags", "instrument_result_time", "is_rerun", "emit_status", "event_id",
        "port_outcome", "port_reason_code", "port_result_id", "source_record_id", "warnings"]));
      expect(k).not.toContain("tenant_id");
    });
    it("ProcessingRun: TRD fields; outcome/kind/actor_type enums; reason_text ≤ 300; error_reason ≤ 200", () => {
      expect(keys(schema("ProcessingRun"))).toEqual(expect.arrayContaining(["id", "run_no", "kind", "driver_code", "driver_version", "outcome", "error_code", "error_reason",
        "patient_records", "qc_records", "calibrator_records", "host_query_records", "unmapped_records", "skipped_no_barcode_records", "emitted_events", "skipped_records",
        "reason_code", "reason_text", "actor_type", "actor_display", "created_at"]));
      expect(prop("ProcessingRun", "kind").enum).toEqual(["live", "reprocess", "rematch", "attachment_scan"]);
      expect(prop("ProcessingRun", "outcome").enum).toEqual(["parsed", "shadow", "quarantined", "rejected_capability"]);
      expect(prop("ProcessingRun", "actor_type").enum).toEqual(["device", "user", "system"]);
      expect(prop("ProcessingRun", "error_code").maxLength).toBe(64);
      expect(prop("ProcessingRun", "error_reason").maxLength).toBe(200);
      expect(prop("ProcessingRun", "reason_text").maxLength).toBe(300);
      expect(prop("ProcessingRun", "actor_display").maxLength).toBe(120);
    });
    it("getInstrumentMessageRaw: {raw_base64, raw_text_escaped, raw_sha256, size_bytes}", () => {
      expect(keys(okSchema("getInstrumentMessageRaw")).sort()).toEqual(["raw_base64", "raw_sha256", "raw_text_escaped", "size_bytes"]);
    });
    it("downloadInstrumentAttachment: pdf|png|jpeg binary; attachment + nosniff + no-store + Content-Length headers (P-2); never JSON", () => {
      const r = okResp("downloadInstrumentAttachment");
      expect(Object.keys(r.content ?? {}).sort()).toEqual(["application/pdf", "image/jpeg", "image/png"]);
      expect(r.content?.["application/json"]).toBeUndefined();
      const h = JSON.stringify(r.headers ?? {}).toLowerCase();
      for (const x of ["content-disposition", "x-content-type-options", "cache-control", "content-length"]) expect(h, x).toContain(x);
    });
    it("reprocessInstrumentMessage / rematchInstrumentRecord: coded-set reason_code required, reason_text ≤ 300, no If-Match; responses", () => {
      expect(reqd(bodySchema("reprocessInstrumentMessage"))).toContain("reason_code");
      csName(bp("reprocessInstrumentMessage", "reason_code"), "reprocess_reasons");
      expect(bp("reprocessInstrumentMessage", "reason_code").enum).toBeUndefined();
      expect(bp("reprocessInstrumentMessage", "reason_text").maxLength).toBe(300);
      expect(keys(okSchema("reprocessInstrumentMessage"))).toEqual(expect.arrayContaining(["run", "records"]));
      // "E38 adds `preview: boolean`" — on the response or on the embedded run
      const pv = props(okSchema("reprocessInstrumentMessage")).preview ?? props(deref(props(okSchema("reprocessInstrumentMessage")).run)).preview;
      expect(deref(pv)?.type).toBe("boolean");
      const b = bodySchema("rematchInstrumentRecord");
      expect(reqd(b)).toEqual(expect.arrayContaining(["sample_barcode", "reason_code"]));
      expect(bp("rematchInstrumentRecord", "sample_barcode").pattern).toBe("^[A-Z0-9]{1,40}$");
      expect(bp("rematchInstrumentRecord", "reason_text").maxLength).toBe(300);
      expect(keys(okSchema("rematchInstrumentRecord"))).toEqual(expect.arrayContaining(["run", "record"]));
    });
    it("InstrumentSettings: TRD bounds; update window HH:MM pattern; version read-only", () => {
      const s = schema("InstrumentSettings");
      expect(s.additionalProperties).toBe(false);
      expect(keys(s)).toEqual(expect.arrayContaining(["default_backlog_threshold", "backlog_max_oldest_pending_seconds", "clock_offset_warn_seconds",
        "agent_uploaded_retention_hours", "update_window_from", "update_window_to", "version"]));
      expect(num(prop("InstrumentSettings", "default_backlog_threshold"))).toEqual([10, 100000]);
      expect(num(prop("InstrumentSettings", "backlog_max_oldest_pending_seconds"))).toEqual([60, 86400]);
      expect(num(prop("InstrumentSettings", "clock_offset_warn_seconds"))).toEqual([30, 3600]);
      expect(num(prop("InstrumentSettings", "agent_uploaded_retention_hours"))).toEqual([1, 72]);
      for (const f of ["update_window_from", "update_window_to"]) expect(prop("InstrumentSettings", f).pattern).toBe("^([01][0-9]|2[0-3]):[0-5][0-9]$");
      expect(prop("InstrumentSettings", "version").readOnly).toBe(true);
      expect(keys(okSchema("getInstrumentSettings"))).toContain("default_backlog_threshold");
      expect(keys(bodySchema("updateInstrumentSettings"))).not.toContain("version");
    });
    it("MessageRejection: reason_code enum of 3; NEVER raw bytes; listMessageRejections window + filters", () => {
      const k = keys(schema("MessageRejection"));
      expect(k).toEqual(expect.arrayContaining(["id", "received_at", "agent_id", "claimed_instrument_id", "agent_message_id", "reason_code", "size_bytes", "raw_sha256"]));
      for (const f of ["raw_bytes", "raw_base64", "raw", "raw_text_escaped", "tenant_id"]) expect(k, f).not.toContain(f);
      expect(prop("MessageRejection", "reason_code").enum).toEqual(["instruments.instrument_unknown", "instruments.device_mismatch", "instruments.message_too_large"]);
      expect(params("listMessageRejections").map((p: any) => p?.name)).toEqual(expect.arrayContaining(["received_at_from", "received_at_to", "agent_id", "reason", "cursor", "limit"]));
    });
  });

  // ---------- "Prism smoke", offline: examples validate against their schemas ----------
  describe("examples validate against their schemas; each operation has a servable example (Prism smoke); examples are synthetic", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...doc, id: "instruments.yaml" });
    const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    const check = (ptr: string, example: unknown) => {
      const validate = ajv.getSchema(`instruments.yaml#${ptr}`);
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
    it("every JSON request/response example matches its schema; at least one per operation (binary ops excepted)", () => {
      expect(existsSync(FILE), "contracts/openapi/instruments.yaml missing").toBe(true);
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
      expect(n).toBeGreaterThanOrEqual(TOTAL - 4);
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
    it("examples are synthetic: no e-mail, no Nepali-mobile-shaped number, no Windows/user paths, no live-looking device token / enrolment code / IP", () => {
      expect(existsSync(FILE), "contracts/openapi/instruments.yaml missing").toBe(true);
      const vals = exampleValues();
      expect(vals.length, "no examples at all").toBeGreaterThan(0);
      const blob = JSON.stringify(vals);
      expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
      expect(blob).not.toMatch(/(?<!\d)(?:\+?977[-\s]?)?9[678]\d{8}(?!\d)/);
      expect(blob).not.toMatch(/[A-Z]:\\\\|\/Users\/|\/home\//);
      expect(blob).not.toMatch(/lms[de]_[A-Za-z0-9_-]{22,}/);
      // IPs (Agent.health.last_ip) only from the RFC 5737 documentation ranges
      for (const ip of blob.match(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g) ?? [])
        expect(ip, `non-documentation IP ${ip}`).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
    });
  });
});
