// T0C-10.C15 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/payments.yaml (C15 transcription of spec/chunks/C15-payment-gateways/02-TRD.md §5.1, §5.2; LD-103).
// Checks: (1) exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) clean for payments.yaml; (3) AC-0C-1.5 negatives on a temp copy;
// (4) payments = TRD §5 tables (33 ops: P1–P24b staff incl. P23 get+update, P30–P34 public), method+path, x-permission (staff) / x-public (public),
// security, x-idempotency, tier general, success status, specific + common error codes, Idempotency-Key on required rows, If-Match on IM rows;
// (5) shape pins from §5 (query params, enums, bounds, patterns, x-coded-set without enum, DTO fields, Money, secret write-only, no callback token / return URL / raw payload in any schema);
// (6) "Prism smoke" offline: examples validate (ajv), every op has a servable 2xx/3xx example, examples synthetic; (7) package.json `mock:payments` script.
// Not testable here: Prism actually serving the file (prism not installed), generated-client freshness (codegen-fresh suite), access-log calls (runtime).
// Assumptions (TRD silent or ambiguous; each is also in the notes file):
//  - every staff op lists the six common codes (TRD §5.1 "common/auth"); IM rows + P7b-less recheck ops: If-Match only on P4 P9 P10 P11 P11b P16 P21 P23b (the IM rows);
//    P21 / P23b If-Match is declared but optional-in-spirit (absent row / optional idem), so only common.version_conflict is pinned there, not precondition_required;
//  - Optional-idem ops pin no Idempotency-Key header presence either way (wave 1 convention: none declared);
//  - public ops P30–P34: x-public (non-empty text) and no x-permission (lint rule 4 demands exactly one); P30–P33 security [{paymentCallbackToken: []}], P34 security [];
//    x-error-codes just an array (TRD lists none); each 200/303 response declares Cache-Control, Referrer-Policy, X-Content-Type-Options (TRD §5.2 header sentence);
//  - P23 row = two operations (getPaymentSettings GET, updatePaymentSettings PUT); P24 set_name enum = the ten names in the TRD cell;
//  - `secret` request property is `writeOnly: true`; MerchantAccountDto.secret is the object {is_set, set_at?, fingerprint?}.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRD = join(ROOT, "spec/chunks/C15-payment-gateways/02-TRD.md");
const FILE = join(ROOT, "contracts/openapi/payments.yaml");
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const METHODS = ["get", "put", "post", "delete", "patch"];
const name = "payments";
const PFX = "/v1/payments";

const RR = "payments.reconciliation.read", RES = "payments.intent.resolve", CRE = "payments.intent.create", RQ = "payments.refund.request", AP = "payments.refund.approve";
const MR = "payments.merchant_config.read", MM = "payments.merchant_config.manage";
const VF = "common.validation_failed", NF = "common.not_found", FB = "auth.forbidden";
const VC = "common.version_conflict", PRE = "common.precondition_required", IMM = "common.immutable_record";
const IDEM = ["common.idempotency_key_required", "common.idempotency_key_reused", "common.idempotency_in_progress"];
const SIX = [VF, NF, FB, "auth.unauthenticated", "common.rate_limited", "common.internal"];
const p = (c: string) => `payments.${c}`;
const GNA = p("gateway_not_available"), TRN = p("intent_invalid_transition"), RNA = p("refund_not_allowed"), EXC = p("refund_exceeds_captured");

type Spec = { n: string; id: string; method: string; path: string; perm?: string; idem: "none" | "optional" | "required"; status: number;
  err: string[]; im?: boolean; paged?: boolean; pub?: "token" | "none"; not?: string[] };
const N = "none" as const, O = "optional" as const, R = "required" as const;
const S = (n: string, id: string, method: string, path: string, perm: string, idem: Spec["idem"], status: number, err: string[], o: Partial<Spec> = {}): Spec =>
  ({ n, id, method, path, perm, idem, status, err, im: false, ...o });
const G = (n: string, id: string, path: string, perm: string, o: Partial<Spec> = {}) => S(n, id, "GET", path, perm, N, 200, [], o);
const L = { paged: true }, A = { im: true };
const PUB = (n: string, id: string, path: string, status: number, pub: "token" | "none"): Spec =>
  ({ n, id, method: "GET", path, idem: N, status, err: [], im: false, pub });

const SPECS: Spec[] = [
  G("P1", "listPaymentIntents", "/intents", RR, L),
  G("P2", "getPaymentIntent", "/intents/{intent_id}", RR),
  S("P3", "recheckPaymentIntent", "POST", "/intents/{intent_id}/recheck", RES, O, 200, [GNA, TRN]),
  S("P4", "resolvePaymentIntent", "POST", "/intents/{intent_id}/resolve", RES, R, 200, [p("intent_not_verifiable"), TRN, VC, PRE, ...IDEM], A),
  S("P5", "cancelPaymentIntent", "POST", "/intents/{intent_id}/cancel", CRE, R, 200, [TRN, ...IDEM]),
  G("P6", "listPaymentRefunds", "/refunds", RR, L),
  G("P7", "getPaymentRefund", "/refunds/{refund_id}", RR),
  S("P7b", "recheckPaymentRefund", "POST", "/refunds/{refund_id}/recheck", RES, O, 200, [RNA, GNA]),
  S("P8", "createPaymentRefundRequest", "POST", "/intents/{intent_id}/refunds", RQ, R, 201, [RNA, EXC, ...IDEM]),
  S("P9", "approvePaymentRefund", "POST", "/refunds/{refund_id}/approve", AP, R, 200, [p("refund_self_approval_forbidden"), RNA, EXC, VC, PRE, ...IDEM], A),
  S("P10", "rejectPaymentRefund", "POST", "/refunds/{refund_id}/reject", AP, R, 200, [RNA, VC, PRE, ...IDEM], A),
  S("P11", "confirmManualPaymentRefund", "POST", "/refunds/{refund_id}/confirm-manual", AP, R, 200, [RNA, VC, PRE, ...IDEM], A),
  S("P11b", "failManualPaymentRefund", "POST", "/refunds/{refund_id}/fail", AP, R, 200, [RNA, GNA, VC, PRE, ...IDEM], A),
  G("P12", "listReconciliationRuns", "/reconciliation-runs", RR, L),
  G("P13", "getReconciliationRun", "/reconciliation-runs/{run_id}", RR),
  S("P14", "startReconciliationRun", "POST", "/reconciliation-runs", RES, R, 202, [p("reconciliation_in_progress"), ...IDEM]),
  G("P15", "listReconciliationFindings", "/reconciliation-findings", RR, L),
  S("P16", "resolveReconciliationFinding", "POST", "/reconciliation-findings/{finding_id}/resolve", RES, R, 200, [IMM, VC, PRE, ...IDEM], A),
  G("P17", "listStaticQrReconciliations", "/static-qr-reconciliations", RR, L),
  G("P18", "previewStaticQrReconciliation", "/static-qr-reconciliations/preview", RR),
  S("P19", "createStaticQrReconciliation", "POST", "/static-qr-reconciliations", RES, R, 201, [VF, p("static_qr_already_reconciled"), ...IDEM]),
  G("P20", "listMerchantAccounts", "/merchant-accounts", MR),
  S("P21", "putMerchantAccount", "PUT", "/merchant-accounts/{gateway}/{environment}", MM, O, 200, [GNA, VF, VC], A),
  S("P22", "testMerchantAccount", "POST", "/merchant-accounts/{gateway}/{environment}/test", MM, O, 200, [], { not: [p("credential_invalid")] }),
  G("P23a", "getPaymentSettings", "/settings", MR),
  S("P23b", "updatePaymentSettings", "PUT", "/settings", MM, O, 200, [VC], A),
  G("P24", "listPaymentCodes", "/coded-sets/{set_name}", RR),
  G("P24b", "listPaymentCancelReasons", "/cancel-reasons", CRE),
  PUB("P30", "launchEsewaPayment", "/launch/{callback_token}", 200, "token"),
  PUB("P31", "esewaSuccessCallback", "/callbacks/esewa/{callback_token}/success", 303, "token"),
  PUB("P32", "esewaFailureCallback", "/callbacks/esewa/{callback_token}/failure", 303, "token"),
  PUB("P33", "khaltiReturnCallback", "/callbacks/khalti/{callback_token}", 303, "token"),
  PUB("P34", "getPaymentResultPage", "/result", 200, "none"),
];
const TOTAL = 33;

const DTOS = ["PaymentIntentSummary", "PaymentIntentDetail", "RefundDto", "ReconciliationRunDto", "FindingDto", "StaticQrReconDto", "MerchantAccountDto", "PaymentSettingsDto"];
const LIST_ITEM: Record<string, string> = { listPaymentIntents: "PaymentIntentSummary", listPaymentRefunds: "RefundDto", listReconciliationRuns: "ReconciliationRunDto",
  listReconciliationFindings: "FindingDto", listStaticQrReconciliations: "StaticQrReconDto" };
const ONE: Record<string, string> = { getPaymentIntent: "PaymentIntentDetail", recheckPaymentIntent: "PaymentIntentDetail", resolvePaymentIntent: "PaymentIntentDetail",
  getPaymentRefund: "RefundDto", recheckPaymentRefund: "RefundDto", createPaymentRefundRequest: "RefundDto", approvePaymentRefund: "RefundDto",
  rejectPaymentRefund: "RefundDto", confirmManualPaymentRefund: "RefundDto", failManualPaymentRefund: "RefundDto", getReconciliationRun: "ReconciliationRunDto",
  startReconciliationRun: "ReconciliationRunDto", resolveReconciliationFinding: "FindingDto", createStaticQrReconciliation: "StaticQrReconDto",
  putMerchantAccount: "MerchantAccountDto", getPaymentSettings: "PaymentSettingsDto", updatePaymentSettings: "PaymentSettingsDto" };
const PHI_PARAMS = ["barcode", "sample_barcode", "registration_no", "patient_id", "patient_name", "patient_display_name", "phone", "phone_e164", "email", "full_name", "name"];
// never in any schema of this file: tenant scope, the callback token, return URLs, raw gateway payloads (TRD §5.1 DTO "Never:" line)
const FORBIDDEN_ANY = ["tenant_id", "callback_token", "return_url", "return_urls", "success_url", "failure_url", "cancel_url", "raw_payload", "raw_response", "payload"];
const CODED_SETS = ["hold_reasons", "failure_reasons", "cancel_reasons", "resolution_reasons", "refund_reasons", "refund_reject_reasons", "refund_fail_reasons",
  "refund_hold_reasons", "finding_kinds", "finding_resolutions"];
const SEC_HEADERS = ["cache-control", "referrer-policy", "x-content-type-options"];

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("payments.yaml (T0C-10.C15)", () => {
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
  const ex = () => expect(existsSync(FILE), "contracts/openapi/payments.yaml missing").toBe(true);
  const T = (title: string, fn: () => void) => it(title, () => { ex(); fn(); });
  const money = () => deref(common.components.schemas.Money);
  const isMoney = (s: any) => expect(deref(s)).toEqual(money());
  const coded = (s: any, set: string) => {
    expect(s?.["x-coded-set"], "x-coded-set").toBe(set);
    expect(s.enum, "coded-set field must not declare enum").toBeUndefined();
  };
  const walk = (s: any, fn: (n: any) => void, seen = new Set<any>()) => {
    const n = deref(s);
    if (!n || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    fn(n);
    for (const a of [...(n.allOf ?? []), ...(n.oneOf ?? []), ...(n.anyOf ?? [])]) walk(a, fn, seen);
    for (const q of Object.values(n.properties ?? {})) walk(q, fn, seen);
    if (n.items) walk(n.items, fn, seen);
  };

  describe("exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
    it("file exists", () => expect(existsSync(FILE), "contracts/openapi/payments.yaml missing").toBe(true));
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
      const dir = mkdtempSync(join(tmpdir(), "c15-payments-lint-"));
      tmps.push(dir);
      cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
      const d = parse(readFileSync(FILE, "utf8"));
      fn(d);
      writeFileSync(join(dir, "contracts/openapi/payments.yaml"), stringify(d, { aliasDuplicateObjects: false }));
      return (await lintRepo(dir)).filter((x) => x.file === name);
    };
    const firstOp = (d: any, pred: (o: any) => boolean) =>
      Object.values<any>(d.paths).flatMap((q) => METHODS.map((m) => q[m]).filter(Boolean)).find(pred);

    it("x-permission not in permissions.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = "payments.no_such.permission"; });
      expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
    });
    it("x-error-codes entry not in errors.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push("payments.no_such_error"); });
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

  describe("payments equals 02-TRD §5 (no missing, no extra operations)", () => {
    it(`${TOTAL} operations; table ids unique; file has exactly these`, () => {
      expect(SPECS.length).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.id)).size).toBe(TOTAL);
      expect(Object.keys(ops).sort()).toEqual(SPECS.map((s) => s.id).sort());
    });
    it("TRD drift guard: §5.1/§5.2 tables = test table (operationId, method + path, first permission, Idem; P23 row = two ops)", () => {
      const all = readFileSync(TRD, "utf8").split("\n");
      const start = all.findIndex((l) => l.startsWith("### 5.1 Staff operations"));
      const end = all.findIndex((l, k) => k > start && l.startsWith("### 5.3 "));
      expect(start).toBeGreaterThan(0);
      const rows = new Map<string, { id: string; mp: string; perm: string; idem: string }>();
      for (const l of all.slice(start, end)) {
        const c = l.split("|");
        if (!/^\s*P\d+b?\s*$/.test(c[1] ?? "")) continue;
        const id = /^\s*`([a-z][A-Za-z0-9]+)`\s*$/.exec(c[2] ?? "")?.[1];
        if (!id) continue; // P23 (two operationIds in one cell) and the access-log table
        const mp = /^\s*([A-Z]+)\s+`([^`]+)`/.exec(c[3] ?? "");
        const sec = /`(payments\.[a-z_.]+)`/.exec(c[4] ?? "");
        rows.set(c[1].trim(), { id, mp: `${mp?.[1]} ${mp?.[2]}`, perm: sec?.[1] ?? "", idem: (c[5] ?? "").trim() });
      }
      expect(rows.size, "rows parsed from TRD").toBe(TOTAL - 2); // 33 operations; the P23 row holds two and is skipped
      for (const s of SPECS) {
        if (s.n.startsWith("P23")) continue;
        const r = rows.get(s.n);
        expect(r?.id, `${s.n} id`).toBe(s.id);
        expect(r?.mp, `${s.n} method+path`).toBe(`${s.method} ${PFX}${s.path}`);
        if (s.perm) expect(r?.perm, `${s.n} permission`).toBe(s.perm);
        else expect(r?.perm, `${s.n} public rows name paymentCallbackToken / none, not a permission`).toBe("");
        if (s.perm) expect(r?.idem, `${s.n} idem`).toBe({ none: "—", optional: "optional", required: "required" }[s.idem]);
      }
    });
    T("every path is /v1/payments/… with tags [payments]; no PHI path or query params (REQ-SEC-098)", () => {
      expect(Object.keys(doc.paths ?? {}).length, "no paths").toBeGreaterThan(0);
      for (const [q, item] of Object.entries<any>(doc.paths ?? {})) {
        expect(q.startsWith(`${PFX}/`), q).toBe(true);
        expect(q).not.toMatch(/\{(registration_no|barcode|sample_barcode|phone|patient_id|email)\}/);
        for (const m of METHODS) if (item[m]) expect(item[m].tags, `${m} ${q}`).toEqual([name]);
      }
      for (const id of Object.keys(ops))
        for (const q of params(id)) if (q?.in === "query") expect(PHI_PARAMS, `${id}?${q.name}`).not.toContain(q.name);
    });
  });

  describe.each(SPECS)("$n $id", (r) => {
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
    if (r.pub)
      it(`public: x-public justification, no x-permission, security ${r.pub === "token" ? "paymentCallbackToken" : "none"} (TRD §5.2)`, () => {
        has(r.id);
        expect(typeof o["x-public"]).toBe("string");
        expect(o["x-public"].trim().length).toBeGreaterThan(10);
        expect(o["x-permission"]).toBeUndefined();
        expect(o.security).toEqual(r.pub === "token" ? [{ paymentCallbackToken: [] }] : []);
      });
    else
      it(`x-permission = ${r.perm}, never x-public; security bearerJwt; tenant context only`, () => {
        has(r.id);
        expect(o["x-permission"]).toBe(r.perm);
        expect(o["x-public"]).toBeUndefined();
        expect(o.security).toEqual([{ bearerJwt: [] }]);
        expect([undefined, "tenant"]).toContain(o["x-context"]);
      });
    it("success response status", () => {
      has(r.id);
      expect(Object.keys(o.responses ?? {}), `want ${r.status}`).toContain(String(r.status));
    });
    if (!r.pub)
      it("lists the TRD specific error codes plus the six common codes", () => {
        has(r.id);
        for (const c of [...SIX, ...r.err]) expect(o["x-error-codes"], c).toContain(c);
        for (const c of r.not ?? []) expect(o["x-error-codes"], `${c} must be absent`).not.toContain(c);
        if (!r.im) expect(o["x-error-codes"], "no If-Match on this op").not.toContain(PRE);
      });
    it("Idempotency-Key header where x-idempotency required, none where none; If-Match on IM rows only", () => {
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

  describe("query parameters (TRD §5.1, §5.2)", () => {
    const names = (id: string) => params(id).filter((q: any) => q?.in === "query").map((q: any) => q.name);
    T("list / preview query parameter names", () => {
      expect(names("listPaymentIntents")).toEqual(expect.arrayContaining(["status", "gateway", "hold_reason", "order_id", "centre_id", "created_at_from", "created_at_to", "sort", "cursor", "limit"]));
      expect(names("listPaymentRefunds")).toEqual(expect.arrayContaining(["status", "gateway", "intent_id", "created_at_from", "created_at_to", "sort", "cursor", "limit"]));
      expect(names("listReconciliationRuns")).toEqual(expect.arrayContaining(["business_date_from", "business_date_to", "status", "sort", "cursor", "limit"]));
      expect(names("listReconciliationFindings")).toEqual(expect.arrayContaining(["status", "kind", "severity", "run_id", "sort", "cursor", "limit"]));
      expect(names("listStaticQrReconciliations")).toEqual(expect.arrayContaining(["business_date_from", "business_date_to", "centre_id", "cursor", "limit"]));
      expect(names("previewStaticQrReconciliation")).toEqual(expect.arrayContaining(["business_date", "centre_id"]));
    });
    T("sort enums are exactly the TRD lists (-updated_at dropped, review m#21)", () => {
      expect(pschema("listPaymentIntents", "sort").enum).toEqual(["-created_at", "created_at"]);
      expect(pschema("listPaymentRefunds", "sort").enum).toEqual(["-created_at", "created_at"]);
      expect(pschema("listReconciliationRuns", "sort").enum).toEqual(["-business_date"]);
      expect(pschema("listReconciliationFindings", "sort").enum).toEqual(["-created_at", "severity"]);
    });
    T("hold_reason is a coded-set csv (payments.hold_reasons), no enum", () => coded(pschema("listPaymentIntents", "hold_reason"), "payments.hold_reasons"));
    T("preview: business_date required (date); the 303 result page needs outcome", () => {
      expect(param("previewStaticQrReconciliation", "business_date").required).toBe(true);
      expect(pschema("previewStaticQrReconciliation", "business_date").format).toBe("date");
      expect(param("previewStaticQrReconciliation", "centre_id")?.required).not.toBe(true);
    });
    T("listPaymentCodes: set_name path param is exactly the ten TRD coded-set names", () => {
      expect(pschema("listPaymentCodes", "set_name").enum).toEqual(CODED_SETS);
      expect(param("listPaymentCodes", "set_name").in).toBe("path");
    });
    T("P31 data: ≤4096, Base64 pattern, optional; P32: no query params", () => {
      const d = pschema("esewaSuccessCallback", "data");
      expect(d.maxLength).toBe(4096);
      expect(d.pattern).toBe("^[A-Za-z0-9+/=_-]+$");
      expect(param("esewaSuccessCallback", "data")?.required).not.toBe(true);
      expect(names("esewaFailureCallback")).toEqual([]);
    });
    T("P33 khalti query: pidx 64, status 32, transaction_id 64, tidx 64, txnId 64, amount 20, total_amount 20, mobile 20, purchase_order_id 64, purchase_order_name 100; all optional", () => {
      const caps: Record<string, number> = { pidx: 64, status: 32, transaction_id: 64, tidx: 64, txnId: 64, amount: 20, total_amount: 20, mobile: 20, purchase_order_id: 64, purchase_order_name: 100 };
      for (const [k, max] of Object.entries(caps)) {
        expect(pschema("khaltiReturnCallback", k)?.maxLength, k).toBe(max);
        expect(param("khaltiReturnCallback", k).required, k).not.toBe(true);
      }
      expect(names("khaltiReturnCallback").sort()).toEqual(Object.keys(caps).sort());
    });
    T("P34: outcome required ∈ settled|pending|failed|unknown; intent_id optional uuid", () => {
      expect(param("getPaymentResultPage", "outcome").required).toBe(true);
      expect(pschema("getPaymentResultPage", "outcome").enum).toEqual(["settled", "pending", "failed", "unknown"]);
      expect(pschema("getPaymentResultPage", "intent_id").format).toBe("uuid");
      expect(param("getPaymentResultPage", "intent_id").required).not.toBe(true);
      expect(names("getPaymentResultPage").sort()).toEqual(["intent_id", "outcome"]);
    });
    T("every path parameter is a required string/uuid with maxLength or format", () => {
      for (const id of Object.keys(ops))
        for (const q of params(id).filter((x: any) => x?.in === "path")) expect(q.required, `${id}:${q.name}`).toBe(true);
    });
  });

  describe("request bodies (TRD §5.1)", () => {
    T("P4 resolve: resolution enum, reason_code coded-set, note ≤500", () => {
      expect(bp("resolvePaymentIntent", "resolution").enum).toEqual(["settle", "fail", "record_exceeding_due"]);
      coded(bp("resolvePaymentIntent", "reason_code"), "payments.resolution_reasons");
      expect(bp("resolvePaymentIntent", "note").maxLength).toBe(500);
      expect(reqd(bodySchema("resolvePaymentIntent")).sort()).toEqual(["reason_code", "resolution"]);
    });
    T("P5 cancel: reason_code coded-set payments.cancel_reasons (required); response {intent_id, status}", () => {
      coded(bp("cancelPaymentIntent", "reason_code"), "payments.cancel_reasons");
      expect(reqd(bodySchema("cancelPaymentIntent"))).toEqual(["reason_code"]);
      expect(keys(okSchema("cancelPaymentIntent")).sort()).toEqual(["intent_id", "status"]);
    });
    T("P8 refund request: refund_amount_paisa 1…9007199254740991, reason_code coded-set, reason_text ≤500 optional", () => {
      const a = bp("createPaymentRefundRequest", "refund_amount_paisa");
      expect([a.type, a.minimum, a.maximum]).toEqual(["integer", 1, 9007199254740991]);
      coded(bp("createPaymentRefundRequest", "reason_code"), "payments.refund_reasons");
      expect(bp("createPaymentRefundRequest", "reason_text").maxLength).toBe(500);
      expect(reqd(bodySchema("createPaymentRefundRequest")).sort()).toEqual(["reason_code", "refund_amount_paisa"]);
    });
    T("P9 approve note ≤500; P10 reject reason_code coded-set refund_reject_reasons + note ≤500", () => {
      expect(bp("approvePaymentRefund", "note").maxLength).toBe(500);
      coded(bp("rejectPaymentRefund", "reason_code"), "payments.refund_reject_reasons");
      expect(bp("rejectPaymentRefund", "note").maxLength).toBe(500);
    });
    T("P11 confirm-manual: gateway_refund_reference ≤100 pattern, refunded_on date; both required", () => {
      const g = bp("confirmManualPaymentRefund", "gateway_refund_reference");
      expect([g.maxLength, g.pattern]).toEqual([100, "^[A-Za-z0-9_.:/-]{1,100}$"]);
      expect(bp("confirmManualPaymentRefund", "refunded_on").format).toBe("date");
      expect(reqd(bodySchema("confirmManualPaymentRefund")).sort()).toEqual(["gateway_refund_reference", "refunded_on"]);
    });
    T("P11b fail: reason_code coded-set refund_fail_reasons, note ≤500", () => {
      coded(bp("failManualPaymentRefund", "reason_code"), "payments.refund_fail_reasons");
      expect(bp("failManualPaymentRefund", "note").maxLength).toBe(500);
    });
    T("P16 finding resolve: resolution_code coded-set finding_resolutions, note ≤1000", () => {
      coded(bp("resolveReconciliationFinding", "resolution_code"), "payments.finding_resolutions");
      expect(bp("resolveReconciliationFinding", "note").maxLength).toBe(1000);
      expect(reqd(bodySchema("resolveReconciliationFinding"))).toContain("resolution_code");
    });
    T("P19 static-QR: business_date date, centre_id optional, statement_total_paisa ≥0, statement_reference ≤100, note ≤1000", () => {
      const s = "createStaticQrReconciliation";
      expect(bp(s, "business_date").format).toBe("date");
      const t = bp(s, "statement_total_paisa");
      expect([t.type, t.minimum]).toEqual(["integer", 0]);
      expect(bp(s, "statement_reference").maxLength).toBe(100);
      expect(bp(s, "note").maxLength).toBe(1000);
      expect(reqd(bodySchema(s))).toEqual(expect.arrayContaining(["business_date", "statement_total_paisa", "statement_reference"]));
      expect(reqd(bodySchema(s))).not.toContain("centre_id");
      expect(reqd(bodySchema(s))).not.toContain("note");
    });
    T("P21 merchant account: is_enabled required; esewa_product_code ≤64 pattern; khalti_website_url ≤300; secret ≤256 write-only; api_refunds_enabled bool", () => {
      const s = "putMerchantAccount";
      expect(reqd(bodySchema(s))).toEqual(["is_enabled"]);
      expect(bp(s, "is_enabled").type).toBe("boolean");
      expect([bp(s, "esewa_product_code").maxLength, bp(s, "esewa_product_code").pattern]).toEqual([64, "^[A-Za-z0-9_-]+$"]);
      expect(bp(s, "khalti_website_url").maxLength).toBe(300);
      expect(bp(s, "secret").maxLength).toBe(256);
      expect(bp(s, "secret").writeOnly, "secret value is write-only").toBe(true);
      expect(bp(s, "api_refunds_enabled").type).toBe("boolean");
      expect(pschema(s, "environment").enum).toEqual(["uat", "production"]);
    });
    T("P23b settings: threshold ≥0, purchase_order_label 1–50 pattern, reconciliation_enabled bool", () => {
      const s = "updatePaymentSettings";
      const t = bp(s, "refund_two_person_threshold_paisa");
      expect([t.type, t.minimum]).toEqual(["integer", 0]);
      const l = bp(s, "purchase_order_label");
      expect([l.minLength, l.maxLength, l.pattern]).toEqual([1, 50, "^[A-Za-z0-9 .,&()-]+$"]);
      expect(bp(s, "reconciliation_enabled").type).toBe("boolean");
    });
    T("P3 / P7b / P14 take no required body fields (`{}`)", () => {
      for (const id of ["recheckPaymentIntent", "recheckPaymentRefund", "startReconciliationRun"]) {
        const b = bodySchema(id);
        if (b) expect(reqd(b), id).toEqual([]);
      }
    });
    T("no request body names a server-authority field (tenant_id, created_by, ledger_entry_id, status except actions)", () => {
      for (const id of Object.keys(ops))
        for (const f of ["tenant_id", "created_by", "ledger_entry_id", "requested_by", "approved_by"]) expect(keys(bodySchema(id) ?? {}), `${id}.${f}`).not.toContain(f);
    });
  });

  describe("response shapes (TRD §5.1 DTOs, §5.2)", () => {
    T("named DTO schemas are components, closed", () => {
      for (const n of DTOS) {
        expect(schema(n), n).toBeDefined();
        expect(schema(n).additionalProperties, `${n} closed`).toBe(false);
      }
    });
    T("list ops return {data, page} with the TRD item DTO", () => {
      for (const [id, dto] of Object.entries(LIST_ITEM)) {
        const s = okSchema(id);
        expect(keys(s), id).toEqual(expect.arrayContaining(["data", "page"]));
        expect(deref(deref(props(s).data).items), id).toEqual(deref(schema(dto)));
      }
    });
    T("single-object ops return (at least) the properties of their DTO", () => {
      for (const [id, dto] of Object.entries(ONE)) expect(keys(okSchema(id)), id).toEqual(expect.arrayContaining(keys(schema(dto))));
    });
    T("PaymentIntentSummary fields exactly; optional ones not required", () => {
      expect(keys(schema("PaymentIntentSummary")).sort()).toEqual(["amount", "centre_id", "created_at", "environment", "expires_at", "failure_reason", "gateway", "hold_reason", "id",
        "last_checked_at", "order_id", "settled_at", "status", "version"]);
      for (const f of ["hold_reason", "failure_reason", "expires_at", "settled_at", "last_checked_at"]) expect(reqd(schema("PaymentIntentSummary")), f).not.toContain(f);
      expect(reqd(schema("PaymentIntentSummary"))).toEqual(expect.arrayContaining(["id", "order_id", "centre_id", "gateway", "environment", "status", "amount", "created_at", "version"]));
      isMoney(prop("PaymentIntentSummary", "amount"));
    });
    T("PaymentIntentDetail = Summary + detail fields; Money amounts; last-20 arrays; nested shapes", () => {
      const d = "PaymentIntentDetail";
      expect(keys(schema(d))).toEqual(expect.arrayContaining([...keys(schema("PaymentIntentSummary")), "gateway_txn_ref", "gateway_secondary_ref", "last_gateway_status_raw", "verified_amount",
        "verification_method", "refunded_amount", "ledger_entry_id", "created_by_actor_type", "transitions", "gateway_checks", "callbacks", "refunds"]));
      isMoney(prop(d, "verified_amount"));
      isMoney(prop(d, "refunded_amount"));
      for (const f of ["gateway_secondary_ref", "last_gateway_status_raw", "verified_amount", "verification_method", "ledger_entry_id"]) expect(reqd(schema(d)), f).not.toContain(f);
      expect(prop(d, "gateway_checks").maxItems).toBe(20);
      expect(prop(d, "callbacks").maxItems).toBe(20);
      expect(Object.keys(props(prop(d, "transitions").items)).sort()).toEqual(["actor_type", "at", "cause", "from_status", "reason_code", "to_status"]);
      expect(Object.keys(props(prop(d, "gateway_checks").items)).sort()).toEqual(["at", "gateway_status_raw", "http_status", "operation", "outcome"]);
      expect(Object.keys(props(prop(d, "callbacks").items)).sort()).toEqual(["at", "kind", "outcome_code", "signature_valid"]);
      expect(deref(prop(d, "refunds").items)).toEqual(deref(schema("RefundDto")));
    });
    T("RefundDto fields; amount Money; requested_by {membership_id, display_name}", () => {
      expect(keys(schema("RefundDto")).sort()).toEqual(["amount", "approved_at", "approved_by", "completed_at", "failure_note", "failure_reason", "gateway", "gateway_refund_reference",
        "held_reason", "id", "intent_id", "last_checked_at", "ledger_entry_id", "mode", "order_id", "reason_code", "reason_text", "rejected_at", "rejected_by", "requested_at", "requested_by",
        "status", "version"]);
      isMoney(prop("RefundDto", "amount"));
      expect(Object.keys(props(prop("RefundDto", "requested_by"))).sort()).toEqual(["display_name", "membership_id"]);
      for (const f of ["approved_by", "rejected_by"]) expect(Object.keys(props(prop("RefundDto", f))).sort(), f).toEqual(["display_name", "membership_id"]);
      expect(reqd(schema("RefundDto"))).toEqual(expect.arrayContaining(["id", "intent_id", "order_id", "gateway", "mode", "status", "amount", "reason_code", "requested_by", "requested_at", "version"]));
      for (const f of ["reason_text", "approved_by", "rejected_by", "gateway_refund_reference", "completed_at", "ledger_entry_id", "failure_reason", "failure_note", "held_reason", "last_checked_at"])
        expect(reqd(schema("RefundDto")), f).not.toContain(f);
    });
    T("ReconciliationRunDto: counts {checked, ok, findings, critical}", () => {
      expect(keys(schema("ReconciliationRunDto")).sort()).toEqual(["business_date", "counts", "finished_at", "id", "started_at", "status", "trigger", "version"]);
      expect(Object.keys(props(prop("ReconciliationRunDto", "counts"))).sort()).toEqual(["checked", "critical", "findings", "ok"]);
      expect(reqd(schema("ReconciliationRunDto"))).not.toContain("finished_at");
    });
    T("FindingDto fields; optional refs/amounts not required", () => {
      expect(keys(schema("FindingDto")).sort()).toEqual(["auto_action", "created_at", "gateway_amount", "gateway_status_raw", "id", "intent_id", "kind", "note", "our_amount", "our_status",
        "refund_id", "resolution_code", "resolved_at", "resolved_by", "run_id", "severity", "status", "version"]);
      for (const f of ["intent_id", "refund_id", "our_status", "gateway_status_raw", "our_amount", "gateway_amount", "resolution_code", "note", "resolved_by", "resolved_at"])
        expect(reqd(schema("FindingDto")), f).not.toContain(f);
      isMoney(prop("FindingDto", "our_amount"));
      isMoney(prop("FindingDto", "gateway_amount"));
    });
    T("StaticQrReconDto: Money totals; status matched|accepted_with_difference", () => {
      expect(keys(schema("StaticQrReconDto")).sort()).toEqual(["business_date", "centre_id", "created_at", "difference", "id", "note", "reconciled_by", "statement_reference",
        "statement_total", "status", "system_entries", "system_total"]);
      for (const f of ["system_total", "statement_total", "difference"]) isMoney(prop("StaticQrReconDto", f));
      expect(prop("StaticQrReconDto", "status").enum).toEqual(["matched", "accepted_with_difference"]);
      expect(reqd(schema("StaticQrReconDto"))).not.toContain("centre_id");
    });
    T("P18 preview response {business_date, centre_id?, system_entries, system_total: Money}", () => {
      const s = okSchema("previewStaticQrReconciliation");
      expect(keys(s).sort()).toEqual(["business_date", "centre_id", "system_entries", "system_total"]);
      isMoney(props(s).system_total);
      expect(reqd(s)).not.toContain("centre_id");
    });
    T("MerchantAccountDto: secret is an object {is_set, set_at?, fingerprint?} (never the value); last_test {outcome, at} optional", () => {
      expect(keys(schema("MerchantAccountDto")).sort()).toEqual(["api_refunds_enabled", "environment", "esewa_product_code", "gateway", "is_enabled", "khalti_website_url", "last_test", "secret", "version"]);
      const sec = prop("MerchantAccountDto", "secret");
      expect(Object.keys(props(sec)).sort()).toEqual(["fingerprint", "is_set", "set_at"]);
      expect(reqd(sec)).toEqual(["is_set"]);
      expect(Object.keys(props(prop("MerchantAccountDto", "last_test"))).sort()).toEqual(["at", "outcome"]);
      expect(reqd(schema("MerchantAccountDto"))).not.toContain("last_test");
      expect(reqd(schema("MerchantAccountDto"))).toEqual(expect.arrayContaining(["gateway", "environment", "is_enabled", "secret", "api_refunds_enabled", "version"]));
    });
    T("P20 list: {data: MerchantAccountDto[] ≤6}, no page", () => {
      const s = okSchema("listMerchantAccounts");
      expect(keys(s)).toEqual(["data"]);
      expect(deref(props(s).data).maxItems).toBe(6);
      expect(deref(deref(props(s).data).items)).toEqual(deref(schema("MerchantAccountDto")));
    });
    T("PaymentSettingsDto: refund_two_person_threshold Money, purchase_order_label, reconciliation_enabled, version", () => {
      expect(keys(schema("PaymentSettingsDto")).sort()).toEqual(["purchase_order_label", "reconciliation_enabled", "refund_two_person_threshold", "version"]);
      isMoney(prop("PaymentSettingsDto", "refund_two_person_threshold"));
    });
    T("P22 response {outcome ∈ 4 values, checked_at}, always 200 (no 422 payments.credential_invalid)", () => {
      const s = okSchema("testMerchantAccount");
      expect(keys(s).sort()).toEqual(["checked_at", "outcome"]);
      expect(deref(props(s).outcome).enum).toEqual(["reachable_key_valid", "reachable_key_unverifiable", "auth_failed", "unreachable"]);
      expect(Object.keys(ops.testMerchantAccount.op.responses)).not.toContain("422");
    });
    T("P24 / P24b: {data: [{code, display, requires_text, is_active}]}, no pagination", () => {
      for (const id of ["listPaymentCodes", "listPaymentCancelReasons"]) {
        const s = okSchema(id);
        expect(keys(s), id).toEqual(["data"]);
        expect(Object.keys(props(deref(props(s).data).items)).sort(), id).toEqual(["code", "display", "is_active", "requires_text"]);
      }
    });
    T("no schema names tenant_id / callback token / return URLs / raw payloads (TRD DTO 'Never:' line)", () => {
      for (const [n, s] of Object.entries<any>(doc.components?.schemas ?? {}))
        for (const f of FORBIDDEN_ANY) expect(Object.keys(props(s)), `${n}.${f}`).not.toContain(f);
      for (const { op } of Object.values(ops))
        for (const [, r] of Object.entries<any>(op.responses ?? {}))
          walk(deref(r)?.content?.["application/json"]?.schema, (n) => { for (const f of FORBIDDEN_ANY) expect(Object.keys(props(n)), f).not.toContain(f); });
    });
    T("no secret value in any response schema: only the write-only request property is a string `secret`", () => {
      for (const [id, { op }] of Object.entries(ops))
        for (const [c, r] of Object.entries<any>(op.responses ?? {}))
          walk(deref(r)?.content?.["application/json"]?.schema, (n) => {
            const sec = props(n).secret;
            if (sec) expect(deref(sec).type, `${id} ${c}: response secret must be an object`).toBe("object");
          });
    });
  });

  describe("public operations (TRD §5.2)", () => {
    const pubIds = SPECS.filter((s) => s.pub).map((s) => s.id);
    T("P30 / P34 return text/html 200; P30 / P31 / P32 / P33 also declare 303 with Location; P31–P33 declare no 200", () => {
      for (const id of ["launchEsewaPayment", "getPaymentResultPage"]) expect(Object.keys(okResp(id).content ?? {}), id).toContain("text/html");
      for (const id of ["launchEsewaPayment", "esewaSuccessCallback", "esewaFailureCallback", "khaltiReturnCallback"]) {
        const r = deref(ops[id].op.responses["303"]);
        expect(r, `${id} 303`).toBeDefined();
        expect(Object.keys(r.headers ?? {}).map((h) => h.toLowerCase()), `${id} Location`).toContain("location");
      }
      for (const id of ["esewaSuccessCallback", "esewaFailureCallback", "khaltiReturnCallback"]) expect(Object.keys(ops[id].op.responses)).not.toContain("200");
    });
    T("every 200 / 303 of P30–P34 declares Cache-Control, Referrer-Policy, X-Content-Type-Options", () => {
      for (const id of pubIds)
        for (const [c, r] of Object.entries<any>(ops[id].op.responses))
          if (c === "200" || c === "303") {
            const hs = Object.keys(deref(r).headers ?? {}).map((h) => h.toLowerCase());
            for (const h of SEC_HEADERS) expect(hs, `${id} ${c} ${h}`).toContain(h);
          }
    });
    T("callback_token path param on P30–P33 is a bounded string (a secret: never a format that invites logging in examples)", () => {
      for (const id of ["launchEsewaPayment", "esewaSuccessCallback", "esewaFailureCallback", "khaltiReturnCallback"]) {
        const s = pschema(id, "callback_token");
        expect(s?.type, id).toBe("string");
        expect(typeof s?.maxLength, id).toBe("number");
      }
    });
    T("staff-only operations never use paymentCallbackToken; public ops are exactly P30–P34", () => {
      const pub = Object.entries(ops).filter(([, { op }]) => "x-public" in op).map(([id]) => id).sort();
      expect(pub).toEqual([...pubIds].sort());
    });
  });

  describe("synthetic examples and offline 'Prism smoke' (AC-0C-1.4)", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...doc, id: "payments.yaml" });
    const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    const check = (ptr: string, example: unknown) => {
      const validate = ajv.getSchema(`payments.yaml#${ptr}`);
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
      expect(n).toBeGreaterThanOrEqual(25);
    });
    it("every staff operation has a 2xx JSON example Prism can serve; every public operation has a servable 200/303 (html content or headers)", () => {
      ex();
      expect(Object.keys(ops).length).toBe(TOTAL);
      for (const s of SPECS) {
        const { op, path, method } = ops[s.id];
        const two = Object.entries<any>(op.responses ?? {}).filter(([c]) => /^[23]/.test(c));
        expect(two.length, `${method} ${path}: no 2xx/3xx`).toBeGreaterThan(0);
        for (const [c, r0] of two) {
          const r = deref(r0);
          const j = r.content?.["application/json"];
          if (j) expect(Object.keys(j.examples ?? {}).length, `${method} ${path} ${c}: no example`).toBeGreaterThan(0);
          else if (c.startsWith("2")) expect(Object.keys(r.content ?? {}).length, `${method} ${path} ${c}: no content`).toBeGreaterThan(0);
          else expect(Object.keys(r.headers ?? {}).length, `${method} ${path} ${c}: 303 without headers`).toBeGreaterThan(0);
        }
      }
    });
    it("examples are synthetic: no e-mail, no Nepali-mobile-shaped number, no Windows/user paths, no live-looking token or IP, no secret-looking value", () => {
      ex();
      const vals = exampleValues();
      expect(vals.length, "no examples at all").toBeGreaterThan(0);
      const blob = JSON.stringify(vals);
      expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
      expect(blob).not.toMatch(/(?<!\d)(?:\+?977[-\s]?)?9[678]\d{8}(?!\d)/);
      expect(blob).not.toMatch(/[A-Z]:\\\\|\/Users\/|\/home\//);
      expect(blob, "no JWT-shaped value").not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
      expect(blob, "no real eSewa / Khalti key shapes").not.toMatch(/live_secret_key|Key\s+[0-9a-f]{32}/i);
      for (const ip of blob.match(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g) ?? [])
        expect(ip, `non-documentation IP ${ip}`).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
    });
  });

  describe("mock script (wave-1 convention)", () => {
    it("package.json has `mock:payments` = prism mock contracts/openapi/payments.yaml on a port no other mock uses", () => {
      const scripts: Record<string, string> = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
      const mine = scripts["mock:payments"];
      expect(mine, "mock:payments script missing").toBeDefined();
      const m = /^prism mock contracts\/openapi\/payments\.yaml --host 127\.0\.0\.1 --port (\d+)$/.exec(mine);
      expect(m, mine).not.toBeNull();
      const ports = Object.entries(scripts).filter(([k]) => k.startsWith("mock:") && k !== "mock:payments" && k !== "mock:list")
        .map(([, v]) => /--port (\d+)/.exec(v)?.[1]);
      expect(ports).not.toContain(m![1]);
    });
  });
});
