// T0C-10.C4 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/frontdesk.yaml + billing.yaml (C4 transcription of 02-TRD §5.1 / §5.2).
// Source of truth: spec/chunks/C4-frontdesk-billing/02-TRD.md §5 (conventions line, F-table, B-table, key schemas).
// Checks per file: (1) exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) clean for that file;
// (3) AC-0C-1.5 negative: bad x-permission / error code / missing additionalProperties / tier in a temp copy fails lint;
// (4) inventory = TRD table (method+path, x-permission, idem, success code, error codes, If-Match/Idempotency-Key);
// (5) shape pins (TRF upload, streamed downloads, paging, DTO constraints); (6) "Prism smoke" offline: every JSON example
// validates against its schema (ajv) and each operation has a servable 2xx example; examples are synthetic.
// Not testable here: Prism actually serving the file (prism not installed; mock wiring is T0C-08's mocks.test.ts).
// Assumptions (TRD silent): split rows (F24, B6, B17, B19, B32, B36) become one operation per named operationId at the named
// method/path; a POST row without an explicit status returns 200 (201 only where the TRD says `201`); `—` Idem = `none`
// (a POST with `none` needs an `E1 `/`E2 ` x-idempotency-justification, lint rule 4/P-8); If-Match is pinned only on rows
// marked IM and absent on GET / unmarked POST (B32 PUT is unmarked: not asserted either way).
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRD = join(ROOT, "spec/chunks/C4-frontdesk-billing/02-TRD.md");
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const METHODS = ["get", "put", "post", "delete", "patch"];
const TRF_MIMES = ["image/jpeg", "image/png", "application/pdf"];

// ---- permission / idem shorthands
const FD = (s: string) => `frontdesk.${s}`, BL = (s: string) => `billing.${s}`;
const PAT_R = FD("patient.read"), REG = FD("registration.create"), ORD_R = FD("order.read"), ORD_E = FD("order.edit");
const DISC_A = FD("discount.apply"), DISC_OK = FD("discount.approve");
const INV_R = BL("invoice.read"), CP_R = BL("credit_party.read"), CP_M = BL("credit_party.manage"), PAY = BL("payment.record");
const REF_OK = BL("refund.approve"), CASH_R = BL("cash_report.read"), EXP = BL("data.export"), SET = BL("settings.manage");

type Spec = { id: string; method: string; path: string; perm: string; idem: "none" | "optional" | "required"; status: number; im?: boolean; err?: string[] };
const S = (id: string, method: string, path: string, perm: string, idem: Spec["idem"], status: number, o: { im?: boolean; err?: string[] } = {}): Spec =>
  ({ id, method, path, perm, idem, status, ...o });

// codes shared by F9 / F12 (TRD F9 "Extra error codes")
const CAT = ["catalog.test_inactive", "catalog.no_price", "catalog.tax_config_missing"];
const REGISTER_ERR = ["frontdesk.patient_duplicate_suspected", "frontdesk.consent_required", "frontdesk.referrer_required",
  "frontdesk.discount_approval_required", "frontdesk.discount_exceeds_limit", ...CAT, "billing.credit_limit_exceeded", "billing.credit_party_locked",
  "billing.payment_exceeds_due", "billing.counter_busy", "billing.fiscal_year_closed", "billing.numbering_pattern_invalid", "common.version_conflict"];
const INVALID_CURSOR = ["common.invalid_cursor"], VC = "common.version_conflict", IMM = "common.immutable_record";

const FRONTDESK: Spec[] = [
  S("searchPatients", "POST", "/patients/search", PAT_R, "none", 200),
  S("createPatient", "POST", "/patients", REG, "required", 201, { err: ["frontdesk.patient_duplicate_suspected", "frontdesk.consent_required"] }),
  S("getPatient", "GET", "/patients/{patient_id}", PAT_R, "none", 200),
  S("updatePatient", "PATCH", "/patients/{patient_id}", REG, "optional", 200, { im: true, err: [VC, "common.precondition_required"] }),
  S("recordPatientConsent", "POST", "/patients/{patient_id}/consents", REG, "required", 201),
  S("listPatientOrders", "GET", "/patients/{patient_id}/orders", ORD_R, "none", 200, { err: INVALID_CURSOR }),
  S("anonymisePatient", "POST", "/patients/{patient_id}/anonymise", FD("patient.anonymise"), "required", 200, { im: true, err: ["frontdesk.retention_not_elapsed"] }),
  S("quoteRegistration", "POST", "/registrations/quote", REG, "none", 200, { err: [...CAT, "frontdesk.discount_exceeds_limit"] }),
  S("quoteOrderItemsChange", "POST", "/orders/{order_id}/items-changes/quote", ORD_E, "none", 200, { err: ["frontdesk.order_not_editable", "frontdesk.order_already_cancelled", ...CAT] }),
  S("createRegistration", "POST", "/registrations", REG, "required", 201, { err: REGISTER_ERR }),
  S("listOrders", "GET", "/orders", ORD_R, "none", 200, { err: INVALID_CURSOR }),
  S("getOrder", "GET", "/orders/{order_id}", ORD_R, "none", 200),
  S("confirmPreRegisteredOrder", "POST", "/orders/{order_id}/confirm", REG, "required", 200, { im: true, err: [...REGISTER_ERR, IMM] }),
  S("changeOrderItems", "POST", "/orders/{order_id}/items-changes", ORD_E, "required", 200,
    { im: true, err: ["frontdesk.order_not_editable", "frontdesk.order_already_cancelled", ...CAT, VC, "billing.counter_busy"] }),
  S("cancelOrder", "POST", "/orders/{order_id}/cancel", FD("order.cancel"), "required", 200, { im: true, err: ["frontdesk.order_cancel_not_allowed", "frontdesk.order_already_cancelled"] }),
  S("requestDiscountApproval", "POST", "/discount-approvals", DISC_A, "required", 201, { err: ["frontdesk.discount_exceeds_limit"] }),
  S("listDiscountApprovals", "GET", "/discount-approvals", DISC_OK, "none", 200),
  S("getDiscountApproval", "GET", "/discount-approvals/{approval_id}", DISC_A, "none", 200),
  S("approveDiscount", "POST", "/discount-approvals/{approval_id}/approve", DISC_OK, "required", 200, { im: true, err: ["frontdesk.discount_self_approval_forbidden", IMM] }),
  S("rejectDiscount", "POST", "/discount-approvals/{approval_id}/reject", DISC_OK, "required", 200, { im: true, err: ["frontdesk.discount_self_approval_forbidden", IMM] }),
  S("uploadTrf", "POST", "/trf-attachments", FD("trf.upload"), "required", 201, { err: ["common.payload_too_large", "common.unsupported_media_type"] }),
  S("getTrfAttachment", "GET", "/trf-attachments/{attachment_id}", ORD_R, "none", 200),
  S("getTrfAttachmentContent", "GET", "/trf-attachments/{attachment_id}/content", ORD_R, "none", 200, { err: ["common.upload_quarantined"] }),
  S("listOrderFlags", "GET", "/order-flags", ORD_R, "none", 200),
  S("resolveOrderFlag", "POST", "/order-flags/{flag_id}/resolve", ORD_E, "required", 200, { im: true, err: [IMM] }),
  S("getFrontdeskSettings", "GET", "/settings", FD("settings.manage"), "none", 200),
  S("updateFrontdeskSettings", "PUT", "/settings", FD("settings.manage"), "optional", 200, { im: true, err: [VC] }),
  S("listFrontdeskCodes", "GET", "/coded-sets/{set_name}", ORD_R, "none", 200),
  S("listPossibleDuplicatePatients", "GET", "/patients/possible-duplicates", REG, "none", 200, { err: INVALID_CURSOR }),
];

const BILLING: Spec[] = [
  S("listInvoices", "GET", "/invoices", INV_R, "none", 200, { err: INVALID_CURSOR }),
  S("getInvoice", "GET", "/invoices/{invoice_id}", INV_R, "none", 200),
  S("listInvoicePrints", "GET", "/invoices/{invoice_id}/prints", INV_R, "none", 200, { err: INVALID_CURSOR }),
  S("printInvoice", "POST", "/invoices/{invoice_id}/print", BL("invoice.reprint"), "required", 200),
  S("cancelInvoice", "POST", "/invoices/{invoice_id}/cancel", BL("invoice.cancel"), "required", 200,
    { im: true, err: ["billing.invoice_already_cancelled", "billing.cancel_reason_required", "billing.counter_busy"] }),
  S("issuePartialCreditNote", "POST", "/invoices/{invoice_id}/credit-notes", BL("invoice.cancel"), "required", 201,
    { im: true, err: ["billing.invoice_already_cancelled", "billing.cancel_reason_required", "billing.counter_busy"] }),
  S("listCreditNotes", "GET", "/credit-notes", INV_R, "none", 200),
  S("getCreditNote", "GET", "/credit-notes/{credit_note_id}", INV_R, "none", 200),
  S("printCreditNote", "POST", "/credit-notes/{credit_note_id}/print", BL("invoice.reprint"), "required", 200),
  S("getOrderBilling", "GET", "/orders/{order_id}", INV_R, "none", 200),
  S("recordPayment", "POST", "/orders/{order_id}/payments", PAY, "required", 201, { err: ["billing.payment_exceeds_due", "billing.order_not_invoiced", "billing.counter_busy"] }),
  S("reverseLedgerEntry", "POST", "/ledger-entries/{ledger_entry_id}/reverse", BL("payment.reverse"), "required", 201, { err: ["billing.ledger_reversal_invalid"] }),
  S("requestRefund", "POST", "/orders/{order_id}/refund-requests", BL("refund.request"), "required", 201, { err: ["billing.ledger_reversal_invalid", "common.feature_disabled"] }),
  S("approveRefund", "POST", "/refund-requests/{refund_request_id}/approve", REF_OK, "required", 200,
    { im: true, err: ["billing.refund_self_approval_forbidden", "billing.ledger_reversal_invalid", IMM, VC] }),
  S("rejectRefund", "POST", "/refund-requests/{refund_request_id}/reject", REF_OK, "required", 200, { im: true, err: [IMM, VC] }),
  S("listRefundRequests", "GET", "/refund-requests", REF_OK, "none", 200, { err: INVALID_CURSOR }),
  S("listLedgerEntries", "GET", "/ledger-entries", CASH_R, "none", 200),
  S("createPaymentIntent", "POST", "/orders/{order_id}/payment-intents", "payments.intent.create", "required", 201,
    { err: ["payments.intent_open_exists", "payments.nothing_due", "payments.gateway_not_available", "payments.amount_not_supported", "payments.return_url_not_allowed", "common.feature_disabled"] }),
  S("verifyPaymentIntent", "POST", "/orders/{order_id}/payment-intents/{intent_id}/verify", "payments.intent.create", "optional", 200),
  S("createReleaseOverride", "POST", "/orders/{order_id}/release-overrides", BL("release.override"), "required", 201),
  S("getReleaseEligibility", "GET", "/orders/{order_id}/release-eligibility", INV_R, "none", 200),
  S("listDues", "GET", "/dues", INV_R, "none", 200),
  S("getMyCashSession", "GET", "/cash-sessions/current", PAY, "none", 200),
  S("closeCashSession", "POST", "/cash-sessions/{cash_session_id}/close", PAY, "required", 200, { im: true, err: [IMM, "auth.forbidden"] }),
  S("getDailyCash", "GET", "/daily-cash", CASH_R, "none", 200),
  S("listCreditAccounts", "GET", "/credit-parties", CP_R, "none", 200),
  S("getCreditAccount", "GET", "/credit-parties/{credit_party_id}", CP_R, "none", 200),
  S("updateCreditAccount", "PUT", "/credit-parties/{credit_party_id}", CP_M, "optional", 200, { im: true, err: [VC] }),
  S("listCreditCharges", "GET", "/credit-parties/{credit_party_id}/charges", CP_R, "none", 200),
  S("issuePeriodicInvoice", "POST", "/credit-parties/{credit_party_id}/periodic-invoices", CP_M, "required", 201,
    { err: ["billing.credit_period_already_billed", "billing.counter_busy", "billing.numbering_pattern_invalid"] }),
  S("recordCreditPartyPayment", "POST", "/credit-parties/{credit_party_id}/payments", PAY, "required", 201, { err: ["billing.payment_exceeds_due"] }),
  S("getCreditPartyStatement", "GET", "/credit-parties/{credit_party_id}/statement", CP_R, "none", 200, { err: ["billing.export_too_large"] }),
  S("getSalesRegister", "GET", "/registers/sales", INV_R, "none", 200),
  S("getCancelledInvoiceRegister", "GET", "/registers/cancelled-invoices", INV_R, "none", 200),
  S("getCreditNoteRegister", "GET", "/registers/credit-notes", INV_R, "none", 200, { err: INVALID_CURSOR }),
  S("getAuditTrail", "GET", "/audit-trail", EXP, "none", 200),
  S("createBillingExport", "POST", "/exports", EXP, "required", 202, { err: ["billing.export_too_large", "common.feature_disabled"] }),
  S("getBillingExport", "GET", "/exports/{export_id}", EXP, "none", 200),
  S("getBillingExportContent", "GET", "/exports/{export_id}/content", EXP, "none", 200, { err: [VC, "common.not_found"] }),
  S("listCbmsDocuments", "GET", "/cbms/documents", INV_R, "none", 200),
  S("retryCbmsDocument", "POST", "/cbms/documents/{document_kind}/{document_id}/retry", SET, "required", 200),
  S("getBillingSettings", "GET", "/settings", SET, "none", 200),
  S("updateBillingSettings", "PUT", "/settings", SET, "optional", 200, { err: [VC, "common.validation_failed"] }),
  S("listBillingCodes", "GET", "/coded-sets/{set_name}", INV_R, "none", 200),
  S("listCreditNoteTasks", "GET", "/credit-note-tasks", INV_R, "none", 200),
  S("listFinanceReviewItems", "GET", "/finance-review-items", INV_R, "none", 200),
  S("resolveFinanceReviewItem", "POST", "/finance-review-items/{item_id}/resolve", REF_OK, "required", 200, { im: true, err: [IMM] }),
];

// Which list operations take cursor + limit (TRD: "page of …" / `cursor&limit` in the path column)
const PAGED: Record<string, string[]> = {
  frontdesk: ["listPatientOrders", "listOrders", "listDiscountApprovals", "listOrderFlags", "listPossibleDuplicatePatients"],
  billing: ["listInvoices", "listInvoicePrints", "listCreditNotes", "listRefundRequests", "listLedgerEntries", "listCreditAccounts", "listCreditCharges",
    "getSalesRegister", "getCancelledInvoiceRegister", "getCreditNoteRegister", "getAuditTrail", "listCbmsDocuments", "listDues",
    "listCreditNoteTasks", "listFinanceReviewItems"],
};
// §5.1 / §5.2 named schemas that must exist as components
const DTOS: Record<string, string[]> = {
  frontdesk: ["NewPatient", "Consents", "PatientSummary", "Patient", "RegistrationDraft", "Quote", "RegistrationResult", "OrderDto",
    "DiscountApproval", "TrfAttachment", "OrderFlag", "FrontdeskSettings"],
  billing: ["InvoiceDto", "InvoiceSummary", "CreditNoteDto", "LedgerEntryDto", "SalesRegisterRow", "CreditNoteRegisterRow", "ExportJob",
    "RefundRequestDto", "CashSessionDto", "CreditAccountDto", "BillingSettings", "FinanceReviewItem"],
};
const STREAMS: Record<string, string[]> = { frontdesk: ["getTrfAttachmentContent"], billing: ["getBillingExportContent"] };

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe.each([
  { name: "frontdesk", specs: FRONTDESK, total: 29 },
  { name: "billing", specs: BILLING, total: 47 },
])("$name.yaml (T0C-10.C4)", ({ name, specs, total }) => {
  const FILE = join(ROOT, `contracts/openapi/${name}.yaml`);
  const PFX = `/v1/${name}`;
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
  const schema = (n: string) => doc.components?.schemas?.[n];
  const prop = (n: string, f: string) => deref(props(schema(n))[f]);
  const bodySchema = (id: string) => deref(ops[id].op.requestBody?.content?.["application/json"]?.schema);
  const param = (id: string, pname: string) => (ops[id].op.parameters ?? []).map(deref).find((p: any) => p?.name === pname);
  const headerNames = (r: any) => Object.keys(deref(r)?.headers ?? {}).map((x) => x.toLowerCase());

  describe("exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
    it("file exists", () => expect(existsSync(FILE), `contracts/openapi/${name}.yaml missing`).toBe(true));
    it("first non-comment line is `openapi: 3.0.3`", () => {
      const first = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#"));
      expect(first?.trim()).toBe("openapi: 3.0.3");
    });
    it("info.title and version present", () => {
      expect(typeof doc.info?.title).toBe("string");
      expect(typeof doc.info?.version).toBe("string");
    });
  });

  describe("repo spec lint is green (AC-0C-1.4, rules 1–8, AB-20)", () => {
    it("lintRepo reports no violation", async () => {
      expect(existsSync(FILE), `contracts/openapi/${name}.yaml missing`).toBe(true);
      const v = (await lintRepo(ROOT)).filter((x) => x.file === name);
      expect(v, v.map((x) => `[rule ${x.rule}] ${x.message}`).join("\n")).toEqual([]);
    });
  });

  describe("lint actually checks this file (AC-0C-1.5 negative)", () => {
    const mutate = async (fn: (d: any) => void) => {
      expect(existsSync(FILE), `contracts/openapi/${name}.yaml missing`).toBe(true);
      const dir = mkdtempSync(join(tmpdir(), `c4-${name}-lint-`));
      tmps.push(dir);
      cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
      const d = parse(readFileSync(FILE, "utf8"));
      fn(d);
      writeFileSync(join(dir, `contracts/openapi/${name}.yaml`), stringify(d, { aliasDuplicateObjects: false }));
      return (await lintRepo(dir)).filter((x) => x.file === name);
    };
    const firstOp = (d: any, pred: (o: any) => boolean) =>
      Object.values<any>(d.paths).flatMap((p) => METHODS.map((m) => p[m]).filter(Boolean)).find(pred);

    it("x-permission not in permissions.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = `${name}.no_such.permission`; });
      expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
    });
    it("x-error-codes entry not in errors.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push(`${name}.no_such_error`); });
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
    it(`${total} operations; table ids unique; file has exactly these`, () => {
      expect(specs.length).toBe(total);
      expect(new Set(specs.map((s) => s.id)).size).toBe(total);
      expect(Object.keys(ops).sort()).toEqual(specs.map((s) => s.id).sort());
    });
    it("every operationId named in the TRD table is in the test table (TRD drift guard)", () => {
      const lines = readFileSync(TRD, "utf8").split("\n");
      const start = lines.findIndex((l) => l.startsWith(name === "frontdesk" ? "### 5.1 " : "### 5.2 "));
      const end = lines.findIndex((l, i) => i > start && /^(###? |Access-log|Key schemas)/.test(l) && !l.startsWith(lines[start]));
      const fromTrd = new Set<string>();
      for (const l of lines.slice(start, end > 0 ? end : undefined)) {
        const c = l.split("|");
        if (/^\s*[FB]\d+[a-z]?\s*$/.test(c[1] ?? "") && c[2]) for (const m of c[2].matchAll(/`([a-z][A-Za-z0-9]+)`/g)) fromTrd.add(m[1]);
      }
      expect(fromTrd.size).toBeGreaterThan(name === "frontdesk" ? 25 : 35);
      const mine = new Set(specs.map((s) => s.id));
      const CR004: Record<string, string> = { listCreditParties: "listCreditAccounts", getCreditParty: "getCreditAccount" }; // CR-C0-0C-004 option (1), AUTO 2026-11-07T08:30:15
      for (const id of fromTrd) {
        const want = name === "billing" ? (CR004[id] ?? id) : id;
        expect(mine.has(want), `TRD operationId ${id} not in test table`).toBe(true);
      }
    });
    it(`every path is ${PFX}/… with tags [${name}]; no human-number path params (REQ-SEC-098)`, () => {
      expect(Object.keys(doc.paths ?? {}).length, "no paths").toBeGreaterThan(0);
      for (const [p, item] of Object.entries<any>(doc.paths ?? {})) {
        expect(p.startsWith(`${PFX}/`), p).toBe(true);
        expect(p).not.toMatch(/\{(registration_no|invoice_no|barcode|phone)\}/);
        for (const m of METHODS) if (item[m]) expect(item[m].tags, `${m} ${p}`).toEqual([name]);
      }
    });
  });

  describe.each(specs)("$id", (r) => {
    const o = ops[r.id]?.op;
    const full = PFX + r.path;
    it("exists at the TRD method + path", () => {
      expect(ops[r.id], `${r.id} missing`).toBeDefined();
      expect(`${ops[r.id].method} ${ops[r.id].path}`).toBe(`${r.method} ${full}`);
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
    it(`success response ${r.status}; POST with idem none carries an E1-E4 justification (LD-10)`, () => {
      expect(Object.keys(o.responses ?? {})).toContain(String(r.status));
      if (r.method === "POST" && r.idem === "none") expect(o["x-idempotency-justification"]).toMatch(/^E[1-4] /);
    });
    it("lists the TRD extra error codes plus the common set implied by the §5 conventions line", () => {
      const common6 = ["common.validation_failed", "common.not_found", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"];
      for (const c of [...common6, ...(r.err ?? [])]) expect(o["x-error-codes"], c).toContain(c);
    });
    it("Idempotency-Key where x-idempotency required; If-Match on IM rows, never on GET/unmarked POST", () => {
      const params = JSON.stringify(o.parameters ?? []);
      if (r.idem === "required") expect(params).toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.idem === "none") expect(params).not.toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.im) expect(params).toMatch(/IfMatch|If-Match/);
      else if (r.id !== "updateBillingSettings") expect(params).not.toMatch(/IfMatch|If-Match/);
    });
  });

  describe("shape pins from TRD §5", () => {
    it("named TRD schemas are components", () => {
      for (const n of DTOS[name]) expect(schema(n), n).toBeDefined();
    });
    it("list operations take cursor + limit", () => {
      for (const id of PAGED[name]) {
        const ps = JSON.stringify(ops[id].op.parameters ?? []);
        expect(ps, id).toMatch(/cursor|Cursor/);
        expect(ps, id).toMatch(/limit|Limit/);
      }
    });
    it("streamed downloads: 200 carries Content-Disposition + nosniff + no-store (08 A13 P-2); never a URL body", () => {
      for (const id of STREAMS[name]) {
        const r200 = deref(ops[id].op.responses["200"]);
        expect(headerNames(r200), id).toEqual(expect.arrayContaining(["content-disposition", "x-content-type-options", "cache-control"]));
        expect(Object.keys(r200.content ?? {}), id).not.toContain("application/json");
      }
    });
    it("request bodies are JSON-or-multipart only; no tenant_id / created_by in any request body (rule 7)", () => {
      expect(Object.keys(ops).length, "no operations").toBe(total);
      for (const [id, { op }] of Object.entries(ops)) {
        const b = op.requestBody?.content ?? {};
        for (const k of Object.keys(b)) expect(["application/json", "multipart/form-data"], `${id} ${k}`).toContain(k);
        const s = deref(b["application/json"]?.schema);
        if (s) for (const f of ["tenant_id", "created_by", "updated_by"]) expect(Object.keys(props(s)), `${id}.${f}`).not.toContain(f);
      }
    });

    if (name === "frontdesk") {
      it("uploadTrf: multipart/form-data, x-upload = [jpeg, png, pdf], form has binary file + centre_id + optional order_id, 201, 413/415 documented via x-error-codes", () => {
        const o = ops.uploadTrf.op;
        expect(Object.keys(o.requestBody?.content ?? {})).toContain("multipart/form-data");
        expect(o["x-upload"]).toEqual(TRF_MIMES);
        const f = o.requestBody.content["multipart/form-data"].schema;
        expect(deref(props(f).file)?.format).toBe("binary");
        expect(Object.keys(props(f))).toEqual(expect.arrayContaining(["file", "centre_id", "order_id"]));
        expect(deref(f).required ?? []).toEqual(expect.arrayContaining(["file", "centre_id"]));
        expect(deref(f).required ?? []).not.toContain("order_id");
      });
      it("getTrfAttachmentContent documents 422 (common.upload_quarantined) and a 200 that is not JSON", () => {
        expect(Object.keys(ops.getTrfAttachmentContent.op.responses)).toContain("422");
      });
      it("TrfAttachment is metadata only: scan_state enum, no url/link/content property", () => {
        expect(prop("TrfAttachment", "scan_state").enum).toEqual(["pending", "clean", "quarantined", "failed"]);
        const keys = Object.keys(props(schema("TrfAttachment")));
        expect(keys).toEqual(expect.arrayContaining(["id", "mime_type", "size_bytes", "scan_state", "uploaded_at", "uploaded_by", "original_filename"]));
        for (const k of keys) expect(k).not.toMatch(/url|link|href|content|base64/i);
      });
      it("searchPatients: query ≤ 100, mode enum, limit ≤ 20 (no cursor)", () => {
        const b = bodySchema("searchPatients");
        expect(b.required).toContain("query");
        expect(deref(props(b).query).maxLength).toBe(100);
        expect(deref(props(b).mode).enum).toEqual(["auto", "name", "phone", "code", "registration_no"]);
        expect(deref(props(b).limit).maximum).toBe(20);
      });
      it("coded-set path parameters are enums of the TRD set names", () => {
        expect(deref(param("listFrontdeskCodes", "set_name").schema).enum).toEqual(
          ["order_cancel_reasons", "item_removal_reasons", "discount_reasons", "duplicate_override_reasons", "anonymise_reasons", "flag_resolutions"]);
      });
      it("NewPatient: full_name ≤ 200, sex enum, E.164 phone, email ≤ 254, address ≤ 300, consents required", () => {
        const n = deref(schema("NewPatient"));
        expect(n.required).toEqual(expect.arrayContaining(["full_name", "sex", "consents"]));
        expect(prop("NewPatient", "full_name").maxLength).toBe(200);
        expect(prop("NewPatient", "sex").enum).toEqual(["male", "female", "other", "unknown"]);
        expect(prop("NewPatient", "phone_e164").pattern).toBe("^\\+[1-9][0-9]{7,14}$");
        expect(prop("NewPatient", "email").maxLength).toBe(254);
        expect(prop("NewPatient", "address_text").maxLength).toBe(300);
        const age = deref(props(schema("NewPatient")).age);
        expect([deref(props(age).years).minimum, deref(props(age).years).maximum]).toEqual([0, 150]);
        expect([deref(props(age).months).minimum, deref(props(age).months).maximum]).toEqual([0, 11]);
        expect([deref(props(age).days).minimum, deref(props(age).days).maximum]).toEqual([0, 31]);
      });
      it("Consents: five booleans + consent_text_version ≤ 32", () => {
        for (const f of ["processing", "sms", "whatsapp", "email", "share_with_referrer"]) expect(prop("Consents", f).type, f).toBe("boolean");
        expect(prop("Consents", "consent_text_version").maxLength).toBe(32);
      });
      it("PatientSummary exposes the masked phone, never the raw one", () => {
        const keys = Object.keys(props(schema("PatientSummary")));
        expect(keys).toEqual(expect.arrayContaining(["id", "patient_code", "full_name", "sex", "age_display", "phone_masked", "last_visit_at", "is_anonymised"]));
        expect(keys).not.toContain("phone_e164");
      });
      it("RegistrationDraft: enums, items 1–50, discounts ≤ 20, percent_bp 0–10000", () => {
        const d = (f: string) => prop("RegistrationDraft", f);
        expect(deref(schema("RegistrationDraft")).required).toEqual(expect.arrayContaining(["patient", "centre_id", "visit_type", "billing_mode", "items"]));
        expect(d("visit_type").enum).toEqual(["opd", "ipd"]);
        expect(d("billing_mode").enum).toEqual(["cash", "credit"]);
        expect(d("priority").enum).toEqual(["routine", "urgent"]);
        expect(d("collection_mode").enum).toEqual(["walk_in", "home", "centre", "partner"]);
        expect([d("items").minItems, d("items").maxItems]).toEqual([1, 50]);
        expect(d("discounts").maxItems).toBe(20);
        const disc = deref(d("discounts").items);
        expect(deref(props(disc).kind).enum).toEqual(["amount", "percent"]);
        expect(deref(props(disc).scope).enum).toEqual(["line", "bill"]);
        expect([deref(props(disc).percent_bp).minimum, deref(props(disc).percent_bp).maximum]).toEqual([0, 10000]);
        expect(deref(props(disc).reason_text).maxLength).toBe(500);
      });
      it("createRegistration body: quote_fingerprint required, payments ≤ 5 each amount_received_paisa ≥ 1, trf ≤ 5", () => {
        const b = bodySchema("createRegistration");
        expect(JSON.stringify(b.required ?? deref(b.allOf?.[b.allOf.length - 1])?.required ?? [])).toContain("quote_fingerprint");
        const p = deref(props(b).payments);
        expect(p.maxItems).toBe(5);
        expect(deref(props(p.items).amount_received_paisa).minimum).toBe(1);
        expect(deref(props(b).trf_attachment_ids).maxItems).toBe(5);
      });
      it("Quote: 64-hex quote_fingerprint + base_fingerprint, credit_status state enum", () => {
        for (const f of ["quote_fingerprint", "base_fingerprint"]) {
          const p = prop("Quote", f);
          expect(p.maxLength, f).toBe(64);
          expect(p.pattern ?? "", f).toMatch(/\{64\}|a-f/);
        }
        expect(deref(props(prop("Quote", "credit_status")).state).enum).toEqual(["ok", "locked", "over_limit"]);
        expect(Object.keys(props(prop("Quote", "totals")))).toEqual(expect.arrayContaining(["gross", "discount", "exempt", "taxable", "vat", "other_tax", "net"]));
      });
      it("quoteOrderItemsChange body: add 1–50", () => {
        const a = deref(props(bodySchema("quoteOrderItemsChange")).add);
        expect([a.minItems, a.maxItems]).toEqual([1, 50]);
      });
      it("changeOrderItems body: add ≤ 50, remove ≤ 50 with reason_code", () => {
        const b = bodySchema("changeOrderItems");
        expect(deref(props(b).add).maxItems).toBe(50);
        const rm = deref(props(b).remove);
        expect(rm.maxItems).toBe(50);
        expect(deref(rm.items).required).toEqual(expect.arrayContaining(["order_item_id", "reason_code"]));
      });
      it("OrderDto status enum + RegistrationResult notifications enum", () => {
        expect(prop("OrderDto", "status").enum).toEqual(["pre_registered", "registered", "in_progress", "completed", "cancelled"]);
        expect(deref(props(prop("RegistrationResult", "notifications")).registration_sms).enum).toEqual(
          ["queued", "suppressed_no_consent", "suppressed_no_contact", "suppressed_channel_disabled", "not_attempted"]);
      });
      it("DiscountApproval / OrderFlag enums", () => {
        expect(prop("DiscountApproval", "status").enum).toEqual(["pending", "approved", "rejected", "expired", "consumed"]);
        expect(prop("OrderFlag", "kind").enum).toEqual(["recollection_required", "booking_cancelled_after_registration"]);
        expect(prop("OrderFlag", "status").enum).toEqual(["open", "resolved"]);
      });
      it("rejectDiscount requires note ≤ 500; approveDiscount note optional", () => {
        expect(bodySchema("rejectDiscount").required).toContain("note");
        expect(deref(props(bodySchema("rejectDiscount")).note).maxLength).toBe(500);
        expect(bodySchema("approveDiscount").required ?? []).not.toContain("note");
      });
    } else {
      it("coded-set path parameter is an enum of the TRD set names", () => {
        expect(deref(param("listBillingCodes", "set_name").schema).enum).toEqual(
          ["payment_methods", "invoice_cancel_reasons", "reversal_reasons", "refund_reasons", "override_reasons", "cash_variance_reasons", "lock_reasons"]);
      });
      it("createBillingExport body: kind / format enums, filters object", () => {
        const b = bodySchema("createBillingExport");
        expect(b.required).toEqual(expect.arrayContaining(["kind", "format"]));
        expect(deref(props(b).kind).enum).toEqual(["sales_register", "cancelled_invoices", "credit_notes", "audit_trail", "daily_cash", "invoice_documents"]);
        expect(deref(props(b).format).enum).toEqual(["xlsx", "xml", "pdf"]);
        expect(Object.keys(props(props(b).filters))).toEqual(
          expect.arrayContaining(["fiscal_year_bs", "from", "to", "centre_id", "actor_membership_id"]));
      });
      it("ExportJob: status / kind / format enums; metadata only (no url property)", () => {
        expect(prop("ExportJob", "status").enum).toEqual(["queued", "running", "ready", "failed", "expired"]);
        expect(prop("ExportJob", "format").enum).toEqual(["xlsx", "xml", "pdf"]);
        for (const k of Object.keys(props(schema("ExportJob")))) expect(k).not.toMatch(/url|link|href/i);
      });
      it("getBillingExportContent documents 409 (file_not_ready) and 404 (expired)", () => {
        expect(Object.keys(ops.getBillingExportContent.op.responses)).toEqual(expect.arrayContaining(["409", "404"]));
      });
      it("createPaymentIntent: gateway enum esewa|khalti|fonepay; client never supplies a URL (D-113)", () => {
        const b = bodySchema("createPaymentIntent");
        expect(deref(props(b).gateway).enum).toEqual(["esewa", "khalti", "fonepay"]);
        for (const k of Object.keys(props(b))) expect(k).not.toMatch(/url/i);
      });
      it("requestRefund body: refund_amount_paisa 1…9007199254740991, reference ≤ 100, reason_text ≤ 500", () => {
        const b = bodySchema("requestRefund");
        expect(b.required).toEqual(expect.arrayContaining(["method_code", "refund_amount_paisa", "reason_code"]));
        const a = deref(props(b).refund_amount_paisa);
        expect([a.minimum, a.maximum]).toEqual([1, 9007199254740991]);
        expect(deref(props(b).reference).maxLength).toBe(100);
        expect(deref(props(b).reason_text).maxLength).toBe(500);
      });
      it("RefundRequestDto status enum; LedgerEntryDto kind enums and no collector for gateway entries is optional", () => {
        expect(prop("RefundRequestDto", "status").enum).toEqual(["pending", "approved", "rejected"]);
        expect(prop("LedgerEntryDto", "entry_kind").enum).toEqual(["payment", "reversal", "refund"]);
        expect(prop("LedgerEntryDto", "capture_kind").enum).toEqual(["manual", "gateway", "home_collection"]);
        expect(deref(schema("LedgerEntryDto")).required ?? []).not.toContain("collected_by");
      });
      it("recordPayment body: amount_received_paisa ≥ 1, reference ≤ 100, method_code is a coded set (rule 6: no enum)", () => {
        const b = bodySchema("recordPayment");
        expect(b.required).toEqual(expect.arrayContaining(["method_code", "amount_received_paisa"]));
        expect(deref(props(b).amount_received_paisa).minimum).toBe(1);
        expect(deref(props(b).reference).maxLength).toBe(100);
        expect(deref(props(b).method_code)["x-coded-set"]).toBe("billing.payment_methods");
        expect(deref(props(b).method_code).enum).toBeUndefined();
      });
      it("cancelInvoice body: reason_code is x-coded-set billing.invoice_cancel_reasons, reason_text ≤ 500", () => {
        const b = bodySchema("cancelInvoice");
        expect(b.required).toContain("reason_code");
        expect(deref(props(b).reason_code)["x-coded-set"]).toBe("billing.invoice_cancel_reasons");
        expect(deref(props(b).reason_text).maxLength).toBe(500);
      });
      it("issuePartialCreditNote body: lines 1–200", () => {
        const l = deref(props(bodySchema("issuePartialCreditNote")).lines);
        expect([l.minItems, l.maxItems]).toEqual([1, 200]);
      });
      it("printInvoice reason_code enum", () => {
        expect(deref(props(bodySchema("printInvoice")).reason_code).enum).toEqual(["first_print", "reprint", "printer_fault", "customer_copy"]);
      });
      it("issuePeriodicInvoice body: period_month + branch_id required", () => {
        expect(bodySchema("issuePeriodicInvoice").required).toEqual(expect.arrayContaining(["period_month", "branch_id"]));
        expect(deref(props(bodySchema("issuePeriodicInvoice")).period_month).maxLength).toBe(7);
      });
      it("closeCashSession body: counted[] of {method_code, amount_paisa}", () => {
        const b = bodySchema("closeCashSession");
        expect(b.required).toContain("counted");
        expect(Object.keys(props(deref(props(b).counted).items))).toEqual(expect.arrayContaining(["method_code", "amount_paisa"]));
      });
      it("resolveFinanceReviewItem body: resolution_code enum refunded|kept_as_advance|other", () => {
        expect(deref(props(bodySchema("resolveFinanceReviewItem")).resolution_code).enum).toEqual(["refunded", "kept_as_advance", "other"]);
      });
      it("CreditNoteRegisterRow publishes the C8 reconciliation columns (incl. `net`)", () => {
        const keys = Object.keys(props(schema("CreditNoteRegisterRow")));
        expect(keys).toEqual(expect.arrayContaining(["sn", "credit_note_date_bs", "credit_note_date_ad", "credit_note_no", "kind", "invoice_no",
          "buyer_name", "buyer_pan", "reason_code", "exempt", "taxable", "vat", "other_tax", "net"]));
        expect(prop("CreditNoteRegisterRow", "kind").enum).toEqual(["cancellation", "partial"]);
      });
      it("SalesRegisterRow columns", () => {
        expect(Object.keys(props(schema("SalesRegisterRow")))).toEqual(expect.arrayContaining(["sn", "invoice_date_bs", "invoice_date_ad", "invoice_no",
          "buyer_name", "buyer_pan", "total", "exempt", "taxable", "vat", "other_tax", "status"]));
      });
      it("tax operations were removed from C4 (08 R18): no path under /tax-types or /tax-rules", () => {
        expect(Object.keys(doc.paths ?? {}).length, "no paths").toBeGreaterThan(0);
        for (const p of Object.keys(doc.paths ?? {})) expect(p).not.toMatch(/tax-(types|rules)/);
      });
    }
  });

  // ---------- "Prism smoke", offline: examples validate against their schemas ----------
  describe("examples validate against their schemas; each operation has a servable example (Prism smoke); examples are synthetic", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...doc, id: `${name}.yaml` });
    const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    const check = (ptr: string, example: unknown) => {
      const validate = ajv.getSchema(`${name}.yaml#${ptr}`);
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
    it("every JSON request/response example matches its schema", () => {
      expect(existsSync(FILE), `contracts/openapi/${name}.yaml missing`).toBe(true);
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
      expect(n).toBeGreaterThanOrEqual(total);
    });
    it("every operation has a 2xx response; JSON ones carry an example Prism can serve", () => {
      expect(Object.keys(ops).length).toBe(total);
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
    it("examples are synthetic: no e-mail, no Nepali-mobile-shaped number, no raw E.164 phone, no Windows/user paths, no placeholder-free PAN-like runs of real data", () => {
      expect(existsSync(FILE), `contracts/openapi/${name}.yaml missing`).toBe(true);
      const vals = exampleValues();
      expect(vals.length, "no examples at all").toBeGreaterThan(0);
      const blob = JSON.stringify(vals);
      expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
      expect(blob).not.toMatch(/(?<!\d)(?:\+?977[-\s]?)?9[678]\d{8}(?!\d)/);
      expect(blob).not.toMatch(/[A-Z]:\\\\|\/Users\/|\/home\//);
    });
  });
});
