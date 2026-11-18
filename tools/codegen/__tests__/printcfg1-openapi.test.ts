// T0C-PRINTCFG-1 (LD-316, LD-319(1), LD-325(b), LD-335; founder 2026-11-17 08:39 NPT: own notepad header and footer on printed reports and bills, signer profiles with a signature image, one plain black and white bill)
// — contracts/openapi/reporting.yaml (five new operations), contracts/openapi/billing.yaml (optional `style` on printInvoice and printCreditNote and on the print records), the migration
// 20261117160000_reporting__add_print_profiles_and_signatories.sql (static checks; behaviour is db/tests/reporting/T0C-PRINTCFG-1_print_profiles.test.sql), generated-client freshness and the implementation notes.
// ASSUMPTIONS (the brief names the operations, tables and rules, not every path or wire name; a different choice needs a ruling, not a silent test edit; same style as T0C-TESTIMPORT-1):
//  - Exactly 5 new operations, all in reporting.yaml (68 -> 73), all permission reporting.settings.manage (no new permission code; for document_kind invoice and credit_note the description names
//    billing.settings.manage, the permission the billing settings operations use, exactly like createReportPrint names a second permission in its description). billing.yaml gains NO operation (stays 71).
//      listPrintProfiles       GET /v1/reporting/print-profiles                      200 {data: PrintProfile[]}   query: document_kind, branch_id (both optional)
//      upsertPrintProfile      PUT /v1/reporting/print-profiles                      200 PrintProfile             body: one profile keyed by (branch_id?, document_kind, recipient_type?)
//      previewPrintProfile     POST /v1/reporting/print-profiles/preview             2xx PDF or JSON               body: a draft profile + document_kind; SYNTHETIC sample data only, no patient or document id is accepted
//      listSignatoryProfiles   GET /v1/reporting/signatory-profiles                  200 {data: SignatoryProfile[]}
//      upsertSignatoryProfile  PUT /v1/reporting/signatory-profiles/{user_id}        200 SignatoryProfile         body: display_name, title, registration_no, signature_asset_id, is_active (user_id is the key)
//  - Wire names equal the column names of the brief. branch_id and signature_asset_id are OPTIONAL properties (omitted = the lab default / no image), never nullable (lint rule X10: no nullable, no type arrays).
//    recipient_type (patient | doctor | franchise | laboratory | other) is an optional property of PrintProfile (LD-319(1)); omitted = every recipient. The active flag is `is_active` (repo convention) or `active` (the brief).
//  - header_text and footer_text: type string, plain text, at most 8 lines of 120 characters, no markup. Proven by VALIDATING samples with Ajv (the pattern/maxLength a contract writer picks is free).
//  - billing: PrintInvoiceRequest gains optional `style` (full | plain_bw, default full); printCreditNote gains an optional JSON request body with the same `style`; InvoicePrint, CreditNotePrint and InvoicePrintRow
//    carry `style` (the print record stores the style used); billing.print_log.style in the migration.
//  - the implementer's notes are .orchestra/notes/T0C-PRINTCFG-1-impl.md (convention of every earlier T0C task).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = "20261117160000_reporting__add_print_profiles_and_signatories.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-PRINTCFG-1-impl.md");
const METHODS = ["get", "put", "post", "delete", "patch"];
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ ...common, id: "_common.yaml" });

const sortedEq = (a: string[], b: string[]) => expect([...a].sort()).toEqual([...b].sort());
const refName = (s: any): string => String(s?.$ref ?? "").split("/").pop()!;
const enumOf = (p: any): string[] => ((p?.enum ?? []) as unknown[]).filter((x): x is string => typeof x === "string");
const textOf = (...parts: any[]): string => parts.map((p) => JSON.stringify(p ?? "")).join(" ").replace(/\\"/g, '"');
const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

function load(file: string) {
  const doc: any = parse(readFileSync(join(ROOT, "contracts/openapi", file), "utf8"));
  ajv.addSchema({ ...doc, id: file });
  const S = doc.components.schemas as Record<string, any>;
  const opOf = (id: string): { method: string; path: string; op: any } | undefined => {
    for (const [path, item] of Object.entries<any>(doc.paths)) for (const m of METHODS) if (item[m]?.operationId === id) return { method: m, path, op: item[m] };
    return undefined;
  };
  const allOps = (): string[] => Object.values<any>(doc.paths).flatMap((item) => METHODS.filter((m) => item[m]).map((m) => item[m].operationId as string));
  const deref = (n: any): any => (n && typeof n === "object" && typeof n.$ref === "string" && n.$ref.startsWith("#/components/") ? n.$ref.split("/").slice(1).reduce((a: any, k: string) => a?.[k], doc) ?? n : n);
  /** the (dereferenced) object schema of a named component or of a request body / response of an operation */
  const comp = (name: string): any => S[name] ?? {};
  const body = (id: string): any => deref(opOf(id)?.op.requestBody?.content?.["application/json"]?.schema);
  const bodyPtr = (id: string): string => { const f = opOf(id)!; return `${file}#/paths/${esc(f.path)}/${f.method}/requestBody/content/application~1json/schema`; };
  const okCode = (id: string): string => Object.keys(opOf(id)?.op.responses ?? {}).find((c) => /^2/.test(c)) ?? "";
  const okJson = (id: string): any => opOf(id)?.op.responses?.[okCode(id)]?.content?.["application/json"];
  const okPtr = (id: string): string => { const f = opOf(id)!; return `${file}#/paths/${esc(f.path)}/${f.method}/responses/${okCode(id)}/content/application~1json/schema`; };
  const reach = (root: string, seen = new Set<string>()): Set<string> => {
    const walk = (n: any) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === "object") {
        if (typeof n.$ref === "string" && n.$ref.startsWith("#/components/schemas/")) { const nm = n.$ref.split("/").pop()!; if (!seen.has(nm)) { seen.add(nm); walk(S[nm]); } }
        Object.values(n).forEach(walk);
      }
    };
    seen.add(root); walk(S[root]);
    return seen;
  };
  const validator = (name: string) => { const v = ajv.getSchema(`${file}#/components/schemas/${name}`); expect(v, `cannot resolve ${name}`).toBeDefined(); return v!; };
  const validatorAt = (ptr: string) => { const v = ajv.compile({ $ref: ptr }); return v; };
  return { file, doc, S, opOf, allOps, deref, comp, body, bodyPtr, okCode, okJson, okPtr, reach, validator, validatorAt };
}
const R = load("reporting.yaml");
const B = load("billing.yaml");

const NEW_OPS: Record<string, { method: string; path: string; read: boolean }> = {
  listPrintProfiles: { method: "get", path: "/v1/reporting/print-profiles", read: true },
  upsertPrintProfile: { method: "put", path: "/v1/reporting/print-profiles", read: false },
  previewPrintProfile: { method: "post", path: "/v1/reporting/print-profiles/preview", read: false },
  listSignatoryProfiles: { method: "get", path: "/v1/reporting/signatory-profiles", read: true },
  upsertSignatoryProfile: { method: "put", path: "/v1/reporting/signatory-profiles/{user_id}", read: false },
};
const PERM = "reporting.settings.manage";
const BILLING_PERM = "billing.settings.manage";
const KINDS = ["report", "invoice", "credit_note"];
const MODES = ["letterhead_image", "typed_header_footer", "preprinted_paper", "plain"];
const RECIPIENTS = ["patient", "doctor", "franchise", "laboratory", "other"];
const STYLES = ["full", "plain_bw"];
const PROFILE_FIELDS = ["id", "document_kind", "paper_mode", "header_text", "footer_text", "reserve_top_mm", "reserve_bottom_mm", "show_logo", "show_seller_pan", "grayscale", "font_size_pt", "updated_at", "updated_by"];
const SIGNER_FIELDS = ["user_id", "display_name", "title", "registration_no", "updated_at", "updated_by"];
const UUID = "0193c4a0-0000-7000-8000-0000000000aa";
const UUID2 = "0193c4a0-0000-7000-8000-0000000000ab";
const NOW = "2026-11-17T04:15:00.000Z";
const ACTIVE = (S: any): string => ("is_active" in (S?.properties ?? {}) ? "is_active" : "active");
const lines = (n: number, len: number) => Array.from({ length: n }, () => "x".repeat(len)).join("\n");

const profile = (o: any = {}) => ({
  id: UUID, document_kind: "report", paper_mode: "typed_header_footer", header_text: "Synthetic Lab\nKathmandu (SYNTHETIC)", footer_text: "Synthetic footer", reserve_top_mm: 0, reserve_bottom_mm: 0,
  show_logo: false, show_seller_pan: true, grayscale: false, font_size_pt: 10, is_active: true, updated_at: NOW, updated_by: UUID2, ...o,
});

describe("T0C-PRINTCFG-1 contract: lint and additive baseline", () => {
  it("lintRepo reports no violation for reporting.yaml and billing.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "reporting.yaml" || x.file === "billing.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });

  it("is additive: reporting.yaml 68 -> 73 operations (the 5 new ones), billing.yaml stays at 71 operations, older print and settings operations keep method and path", () => {
    const ids = R.allOps();
    expect(ids.length, "68 + 5 print profile operations").toBe(73);
    expect(new Set(ids).size).toBe(73);
    for (const id of Object.keys(NEW_OPS)) expect(R.opOf(id), `${id} missing`).toBeDefined();
    expect(B.allOps().length, "no billing operation is added").toBe(71);
    for (const id of Object.keys(NEW_OPS)) expect(B.opOf(id), `${id} must not be in billing.yaml`).toBeUndefined();
    const keep: Record<string, [string, string]> = {
      createReportPrint: ["post", "/v1/reporting/report-versions/{report_version_id}/prints"],
      getReportingSettings: ["get", "/v1/reporting/settings"],
    };
    for (const id of ["createReportPrint", "createBulkPrint", "getReportingSettings", "updateReportingSettings", "getReportTemplate", "updateReportTemplateDraft", "previewReportTemplate", "publishReportTemplate"]) expect(R.opOf(id), `${id} kept`).toBeDefined();
    for (const [id, [m]] of Object.entries(keep)) expect(R.opOf(id)!.method, id).toBe(m);
    for (const id of ["printInvoice", "printCreditNote", "listInvoicePrints", "getBillingSettings", "updateBillingSettings"]) expect(B.opOf(id), `${id} kept`).toBeDefined();
    expect(B.opOf("printInvoice")!.path).toBe("/v1/billing/invoices/{invoice_id}/print");
  });
});

describe("T0C-PRINTCFG-1 contract: the five operations (done_when 4)", () => {
  for (const [id, n] of Object.entries(NEW_OPS)) {
    it(`${id}: ${n.method.toUpperCase()} ${n.path}, ${PERM}, tenant context, error codes, standard error responses`, () => {
      const f = R.opOf(id);
      expect(f, `${id} missing`).toBeDefined();
      const { op } = f!;
      expect(`${f!.method} ${f!.path}`).toBe(`${n.method} ${n.path}`);
      expect(op.tags).toEqual(["reporting"]);
      expect(op["x-permission"], "reuses the existing code, no new one").toBe(PERM);
      expect(op["x-context"]).toBe("tenant");
      expect(["required", "optional", "none"]).toContain(op["x-idempotency"]);
      if (n.read) expect(op["x-idempotency"]).toBe("none");
      if (id === "previewPrintProfile") expect(op["x-idempotency"], "same as previewReportTemplate").toBe("required");
      if (op["x-idempotency"] === "required") expect(JSON.stringify(op.parameters), `${id} needs the Idempotency-Key parameter`).toContain("IdempotencyKey");
      expect(typeof op["x-rate-limit-tier"]).toBe("string");
      expect(op.security).toEqual([{ bearerJwt: [] }]);
      expect(Array.isArray(op["x-error-codes"]), "x-error-codes").toBe(true);
      expect(typeof op.summary).toBe("string");
      expect(R.okCode(id), `${id} has a 2xx`).not.toBe("");
      for (const c of ["400", "401", "403", "429", "500"]) expect(op.responses?.[c], `${id} ${c}`).toBeDefined();
      if (!n.read) expect(op.requestBody?.required, `${id} body required`).toBe(true);
      if (f!.path.includes("{user_id}")) {
        expect(op.responses?.["404"], `${id} 404`).toBeDefined();
        const p = (op.parameters as any[]).find((x) => x.name === "user_id");
        expect(p, "user_id path parameter").toBeDefined();
        expect(p.in).toBe("path");
        expect(p.required).toBe(true);
        expect(JSON.stringify(p.schema)).toContain("Uuid");
      }
    });
  }

  it("no new permission code: reporting.settings.manage and billing.settings.manage exist, no print profile or signatory code was added, every x-error-code exists in contracts/errors.yaml", () => {
    const perms = readFileSync(join(ROOT, "contracts/permissions.yaml"), "utf8");
    expect(perms).toContain(PERM);
    expect(perms).toContain(BILLING_PERM);
    expect(perms, "no new permission for print profiles or signers (identity.signatory.read already exists and is not new)").not.toMatch(/code:\s*(reporting|billing)\.(print_profile|print_config|signatory|signer)/i);
    const eText = readFileSync(join(ROOT, "contracts/errors.yaml"), "utf8");
    for (const id of Object.keys(NEW_OPS)) for (const c of (R.opOf(id)!.op["x-error-codes"] ?? []) as string[]) expect(eText, `${id}: error code ${c} must exist in contracts/errors.yaml`).toContain(c);
  });

  it("invoice and credit note profiles need the billing settings permission as well: the operation text says so (same way createReportPrint names a second permission)", () => {
    for (const id of ["listPrintProfiles", "upsertPrintProfile", "previewPrintProfile"]) expect(textOf(R.opOf(id)!.op.summary, R.opOf(id)!.op.description), id).toContain(BILLING_PERM);
    expect(textOf(R.opOf("upsertSignatoryProfile")!.op.summary, R.opOf("upsertSignatoryProfile")!.op.description), "signer profiles are report only").not.toContain(BILLING_PERM);
  });

  it("listPrintProfiles takes optional document_kind (enum of 3) and branch_id (uuid) and returns {data: PrintProfile[]}; listSignatoryProfiles returns {data: SignatoryProfile[]}", () => {
    const ps = R.opOf("listPrintProfiles")!.op.parameters as any[];
    const dk = ps.find((x) => x.name === "document_kind");
    expect(dk, "document_kind query").toBeDefined();
    expect(dk.in).toBe("query");
    expect(dk.required ?? false).toBe(false);
    sortedEq(enumOf(dk.schema), KINDS);
    const br = ps.find((x) => x.name === "branch_id");
    expect(br?.in).toBe("query");
    expect(JSON.stringify(br?.schema)).toContain("Uuid");
    for (const [id, item] of [["listPrintProfiles", "PrintProfile"], ["listSignatoryProfiles", "SignatoryProfile"]]) {
      const s = R.deref(R.okJson(id)?.schema);
      expect(s.type, id).toBe("object");
      expect(s.additionalProperties, `${id} closed`).toBe(false);
      expect(s.required ?? []).toContain("data");
      expect(s.properties?.data?.type).toBe("array");
      expect(typeof s.properties?.data?.maxItems, `${id}: data needs maxItems`).toBe("number");
      expect(refName(s.properties?.data?.items), id).toBe(item);
    }
  });

  it("upsertPrintProfile and upsertSignatoryProfile return the stored row (PrintProfile, SignatoryProfile) as JSON", () => {
    expect(refName(R.okJson("upsertPrintProfile")?.schema)).toBe("PrintProfile");
    expect(refName(R.okJson("upsertSignatoryProfile")?.schema)).toBe("SignatoryProfile");
  });

  it("previewPrintProfile returns a PDF or a JSON page of SYNTHETIC sample data only; its body is a draft profile and accepts no patient, report, invoice or order id", () => {
    const f = R.opOf("previewPrintProfile")!;
    const code = R.okCode("previewPrintProfile");
    const content = f.op.responses[code].content ?? {};
    const types = Object.keys(content);
    expect(types.some((t) => t === "application/pdf" || t === "application/json"), `preview 2xx content: ${types}`).toBe(true);
    if (content["application/pdf"]) expect(content["application/pdf"].schema).toMatchObject({ type: "string", format: "binary" });
    const txt = textOf(f.op.summary, f.op.description);
    expect(txt, "says synthetic sample data only").toMatch(/synthetic/i);
    expect(txt, "never real patient data").toMatch(/never[^.]*(real|patient)|no (real )?patient|not (use )?real patient/i);
    const b = R.body("previewPrintProfile");
    expect(b.type).toBe("object");
    expect(b.additionalProperties, "closed body").toBe(false);
    const props = Object.keys(b.properties ?? {});
    for (const p of ["document_kind", "paper_mode", "header_text", "footer_text"]) expect(props, `preview body has ${p}`).toContain(p);
    for (const p of ["patient_id", "patient", "patient_name", "report_version_id", "report_id", "invoice_id", "order_id", "registration_no", "barcode", "mr_number", "phone", "tenant_id"]) expect(props, `preview must not accept ${p}`).not.toContain(p);
  });

  it("upsertSignatoryProfile body: display_name required, title, registration_no, signature_asset_id (uuid), active flag; user_id comes from the path (not the body); no tenant_id", () => {
    const b = R.body("upsertSignatoryProfile");
    expect(b.type).toBe("object");
    expect(b.additionalProperties).toBe(false);
    const props = Object.keys(b.properties ?? {});
    for (const p of ["display_name", "title", "registration_no", "signature_asset_id"]) expect(props, p).toContain(p);
    expect(props.includes("is_active") || props.includes("active"), "an active flag").toBe(true);
    expect(props, "user_id is the path key").not.toContain("user_id");
    expect(props).not.toContain("tenant_id");
    expect(b.required ?? []).toContain("display_name");
    expect(b.required ?? [], "signature_asset_id is optional").not.toContain("signature_asset_id");
    expect(JSON.stringify(b.properties.signature_asset_id)).toContain("Uuid");
  });

  it("upsertPrintProfile body: server owned fields (id, tenant_id, created_*, updated_*) are not accepted; document_kind and paper_mode are required", () => {
    const b = R.body("upsertPrintProfile");
    expect(b.type).toBe("object");
    expect(b.additionalProperties).toBe(false);
    const props = Object.keys(b.properties ?? {});
    for (const p of ["document_kind", "paper_mode", "header_text", "footer_text", "reserve_top_mm", "reserve_bottom_mm", "show_logo", "show_seller_pan", "grayscale", "font_size_pt", "branch_id"]) expect(props, p).toContain(p);
    for (const p of ["id", "tenant_id", "created_at", "created_by", "updated_at", "updated_by"]) expect(props, `${p} is server owned`).not.toContain(p);
    for (const p of ["document_kind", "paper_mode"]) expect(b.required ?? [], p).toContain(p);
    expect(b.required ?? [], "branch_id is optional (omitted = the lab default)").not.toContain("branch_id");
  });
});

describe("T0C-PRINTCFG-1 contract: PrintProfile and SignatoryProfile schemas (done_when 2, 3)", () => {
  const P = () => R.comp("PrintProfile");
  const G = () => R.comp("SignatoryProfile");
  it("both schemas exist and are closed objects", () => {
    for (const n of ["PrintProfile", "SignatoryProfile"]) { expect(R.S[n], `${n} missing`).toBeDefined(); expect(R.S[n].type).toBe("object"); expect(R.S[n].additionalProperties, `${n} must be closed`).toBe(false); }
  });
  it("PrintProfile: every column of the brief as a property; enums for document_kind, paper_mode, recipient_type; branch_id and recipient_type optional and not nullable", () => {
    const props = Object.keys(P().properties ?? {});
    for (const f of PROFILE_FIELDS) expect(props, f).toContain(f);
    expect(props, "branch_id").toContain("branch_id");
    expect(props.includes("is_active") || props.includes("active"), "an active flag").toBe(true);
    sortedEq(enumOf(P().properties.document_kind), KINDS);
    sortedEq(enumOf(P().properties.paper_mode), MODES);
    sortedEq(enumOf(P().properties.recipient_type), RECIPIENTS);
    expect(JSON.stringify(P().properties.branch_id)).toContain("Uuid");
    for (const f of ["branch_id", "recipient_type"]) expect(P().required ?? [], `${f} is optional (omitted = lab default / every recipient)`).not.toContain(f);
    for (const f of ["id", "document_kind", "paper_mode", "header_text", "footer_text", "reserve_top_mm", "reserve_bottom_mm", "show_logo", "show_seller_pan", "grayscale", "font_size_pt", "updated_at"]) expect(P().required ?? [], `${f} is always returned`).toContain(f);
    expect(textOf(P().properties.branch_id), "branch_id omitted means the lab default").toMatch(/lab default/i);
  });
  it("numbers are integers with the brief's bounds: reserve_top_mm 0..80, reserve_bottom_mm 0..60, font_size_pt 8..12 (in PrintProfile and in the upsert and preview bodies)", () => {
    for (const s of [P(), R.body("upsertPrintProfile"), R.body("previewPrintProfile")]) {
      const p = s.properties ?? {};
      expect(p.reserve_top_mm?.type).toBe("integer"); expect([p.reserve_top_mm?.minimum, p.reserve_top_mm?.maximum]).toEqual([0, 80]);
      expect(p.reserve_bottom_mm?.type).toBe("integer"); expect([p.reserve_bottom_mm?.minimum, p.reserve_bottom_mm?.maximum]).toEqual([0, 60]);
      expect(p.font_size_pt?.type).toBe("integer"); expect([p.font_size_pt?.minimum, p.font_size_pt?.maximum]).toEqual([8, 12]);
      for (const f of ["show_logo", "show_seller_pan", "grayscale"]) expect(p[f]?.type, f).toBe("boolean");
    }
  });
  it("show_seller_pan defaults to true in the upsert body (a tax bill carries the seller PAN)", () => {
    expect(R.body("upsertPrintProfile").properties.show_seller_pan.default).toBe(true);
  });
  it("header_text and footer_text: plain text, at most 8 lines of 120 characters, no markup (Ajv on PrintProfile, the upsert body and the preview body)", () => {
    const targets = [["PrintProfile", R.validator("PrintProfile"), (o: any) => profile(o)], ["upsertPrintProfile body", R.validatorAt(R.bodyPtr("upsertPrintProfile")), (o: any) => ({ document_kind: "report", paper_mode: "typed_header_footer", ...o })],
      ["previewPrintProfile body", R.validatorAt(R.bodyPtr("previewPrintProfile")), (o: any) => ({ document_kind: "report", paper_mode: "typed_header_footer", header_text: "x", footer_text: "y", ...o })]] as const;
    for (const [name, v, mk] of targets) {
      for (const f of ["header_text", "footer_text"]) {
        const ok = (val: string, why: string) => expect(v(mk({ [f]: val })), `${name}.${f}: ${why}: ${JSON.stringify(v.errors?.[0])}`).toBe(true);
        const bad = (val: string, why: string) => expect(v(mk({ [f]: val })), `${name}.${f}: ${why} must be rejected`).toBe(false);
        ok("Synthetic Lab", "one line");
        ok("", "empty");
        ok(lines(8, 120), "8 lines of 120 characters");
        ok("Thank you & get well soon; open 6am-8pm (SYNTHETIC)", "ordinary punctuation");
        ok("नमस्ते Synthetic", "Devanagari");
        bad(lines(9, 5), "9 lines");
        bad(lines(1, 121), "a line of 121 characters");
        bad(lines(3, 5) + "\n" + "y".repeat(121), "one long line among short ones");
        bad("<b>Synthetic Lab</b>", "HTML bold tag");
        bad("<script>alert(1)</script>", "script tag");
        bad("Lab <img src=x onerror=alert(1)>", "img tag");
        bad("a < b", "lone <");
        bad("a > b", "lone >");
        bad("x".repeat(5000), "5000 characters");
      }
    }
  });
  it("the contract text says it: plain text only, at most 8 lines, 120 characters, no markup", () => {
    const t = textOf(P().properties.header_text, P().properties.footer_text, R.body("upsertPrintProfile").properties.header_text);
    expect(t).toMatch(/plain text/i);
    expect(t).toMatch(/\b8 lines\b/);
    expect(t).toMatch(/\b120 characters\b/);
    expect(t).toMatch(/no markup/i);
  });
  it("SignatoryProfile: user_id, display_name, title, registration_no, signature_asset_id (optional uuid), an active flag, updated_at, updated_by; nothing returns the image bytes", () => {
    const props = Object.keys(G().properties ?? {});
    for (const f of SIGNER_FIELDS) expect(props, f).toContain(f);
    expect(props, "signature_asset_id").toContain("signature_asset_id");
    expect(props.includes("is_active") || props.includes("active"), "an active flag").toBe(true);
    expect(JSON.stringify(G().properties.signature_asset_id)).toContain("Uuid");
    expect(G().required ?? [], "signature_asset_id is optional").not.toContain("signature_asset_id");
    for (const f of ["user_id", "display_name", "updated_at"]) expect(G().required ?? [], f).toContain(f);
    for (const f of props) expect(G().properties[f].format, `${f}: no inline image bytes`).not.toBe("byte");
    for (const f of ["tenant_id"]) expect(props).not.toContain(f);
  });
  it("text fields of the signer have bounds (display_name 1..120 chars at most; title, registration_no bounded) and no markup is documented as accepted", () => {
    const b = R.body("upsertSignatoryProfile").properties;
    expect(b.display_name.minLength, "display_name not empty").toBeGreaterThanOrEqual(1);
    for (const f of ["display_name", "title", "registration_no"]) expect(typeof b[f].maxLength, `${f}.maxLength`).toBe("number");
    expect(b.display_name.maxLength).toBeLessThanOrEqual(200);
    const v = R.validatorAt(R.bodyPtr("upsertSignatoryProfile"));
    expect(v({ display_name: "Dr Synthetic", title: "Consultant Pathologist", registration_no: "SYN-1" }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ display_name: "" })).toBe(false);
    expect(v({ display_name: "Dr Synthetic", user_id: UUID })).toBe(false);
    expect(v({ display_name: "Dr Synthetic", tenant_id: UUID })).toBe(false);
  });
  it("every schema reachable from the new operations is closed; none uses type number, nullable or a type array", () => {
    const names = new Set<string>(["PrintProfile", "SignatoryProfile"]);
    for (const id of Object.keys(NEW_OPS)) {
      const json = R.okJson(id)?.schema;
      if (json?.$ref) R.reach(refName(json), names);
      const bj = R.opOf(id)!.op.requestBody?.content?.["application/json"]?.schema;
      if (bj?.$ref) R.reach(refName(bj), names);
    }
    const bad: string[] = [];
    const visit = (n: any, at: string) => {
      if (Array.isArray(n)) return n.forEach((x, i) => visit(x, `${at}[${i}]`));
      if (!n || typeof n !== "object") return;
      if (n.type === "number") bad.push(`${at}: type number`);
      if (Array.isArray(n.type)) bad.push(`${at}: type array`);
      if (n.nullable === true) bad.push(`${at}: nullable`);
      Object.entries(n).forEach(([k, v]) => visit(v, `${at}.${k}`));
    };
    for (const n of names) { expect(R.S[n].additionalProperties, `${n} closed`).toBe(false); visit(R.S[n], n); }
    for (const id of Object.keys(NEW_OPS)) visit(R.opOf(id)!.op.requestBody, `${id}.requestBody`);
    expect(bad).toEqual([]);
  });
});

describe("T0C-PRINTCFG-1 contract: billing print style, plain black and white bill (done_when 5)", () => {
  const styleOf = (s: any) => s?.properties?.style;
  it("PrintInvoiceRequest gains an optional style: full | plain_bw, default full; reason_code stays; the request stays closed", () => {
    const s = B.comp("PrintInvoiceRequest");
    expect(s.additionalProperties).toBe(false);
    expect(Object.keys(s.properties)).toContain("reason_code");
    sortedEq(enumOf(styleOf(s)), STYLES);
    expect(styleOf(s).default).toBe("full");
    expect(styleOf(s).type).toBe("string");
    expect(s.required ?? []).not.toContain("style");
    const v = B.validator("PrintInvoiceRequest");
    expect(v({}), "empty body still valid (default full)").toBe(true);
    expect(v({ reason_code: "reprint" })).toBe(true);
    expect(v({ style: "plain_bw" })).toBe(true);
    expect(v({ reason_code: "first_print", style: "full" })).toBe(true);
    expect(v({ style: "colour" }), "unknown style").toBe(false);
    expect(v({ style: "PLAIN_BW" }), "upper case style").toBe(false);
  });
  it("printCreditNote gets an OPTIONAL JSON body with the same style (full | plain_bw, default full); the 200 response stays CreditNotePrint; the operation keeps its method, path, permission", () => {
    const f = B.opOf("printCreditNote")!;
    expect(f.method).toBe("post");
    expect(f.op["x-permission"]).toBe("billing.invoice.reprint");
    const rb = f.op.requestBody;
    expect(rb, "printCreditNote requestBody").toBeDefined();
    expect(rb.required ?? false, "the body stays optional (an empty call keeps working)").toBe(false);
    const s = B.body("printCreditNote");
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    sortedEq(enumOf(styleOf(s)), STYLES);
    expect(styleOf(s).default).toBe("full");
    expect(s.required ?? []).not.toContain("style");
    const v = B.validatorAt(B.bodyPtr("printCreditNote"));
    expect(v({}), "empty body valid").toBe(true);
    expect(v({ style: "plain_bw" })).toBe(true);
    expect(v({ style: "grey" })).toBe(false);
    expect(refName(B.okJson("printCreditNote")?.schema)).toBe("CreditNotePrint");
    expect(refName(B.okJson("printInvoice")?.schema)).toBe("InvoicePrint");
  });
  it("the print results and the print list carry the style used: InvoicePrint, CreditNotePrint, InvoicePrintRow have style (full | plain_bw)", () => {
    for (const n of ["InvoicePrint", "CreditNotePrint", "InvoicePrintRow"]) {
      const s = B.comp(n);
      expect(s.additionalProperties, `${n} closed`).toBe(false);
      expect(styleOf(s), `${n}.style`).toBeDefined();
      sortedEq(enumOf(styleOf(s)), STYLES);
    }
    // review 2026-11-18: the live printInvoice/printCreditNote handlers do not return style yet; a required style would make response validation 500 until T0B-PRINTCFG-1 merges. T0B makes it required with its handler.
    for (const n of ["InvoicePrint", "CreditNotePrint"]) expect(B.comp(n).required ?? [], `${n}: style stays optional until T0B-PRINTCFG-1 returns it`).not.toContain("style");
  });
  it("plain_bw is described in the contract: black on white only, no logo, no colour, no shading, no header and no footer text; the body keeps lab name, address, seller PAN, bill number and date", () => {
    const t = textOf(styleOf(B.comp("PrintInvoiceRequest")), B.opOf("printInvoice")!.op.description, B.opOf("printInvoice")!.op.summary, styleOf(B.body("printCreditNote")));
    expect(t, "black on white only").toMatch(/black (on|and) white|black and white|black-and-white/i);
    expect(t, "no logo").toMatch(/no logo/i);
    expect(t, "no colour or shading").toMatch(/no colou?r/i);
    expect(t).toMatch(/no shading/i);
    expect(t, "no header and no footer text").toMatch(/no header/i);
    expect(t).toMatch(/footer/i);
    expect(t, "seller PAN stays").toMatch(/seller PAN/i);
    expect(t, "lab name, address, bill number and date stay").toMatch(/lab name/i);
    expect(t).toMatch(/address/i);
    expect(t).toMatch(/bill number/i);
    expect(t).toMatch(/\bdate\b/i);
  });
  it("examples still validate against their schemas (the older printInvoice and listInvoicePrints examples gained the style)", () => {
    for (const id of ["printInvoice", "printCreditNote", "listInvoicePrints"]) {
      const m = B.okJson(id);
      expect(Object.keys(m.examples ?? {}).length, `${id} example`).toBeGreaterThan(0);
      const v = B.validatorAt(B.okPtr(id));
      for (const [k, e] of Object.entries<any>(m.examples)) expect(v(e.value), `${id}/${k}: ${JSON.stringify(v.errors?.[0])}`).toBe(true);
    }
    const req = B.opOf("printInvoice")!.op.requestBody.content["application/json"].examples;
    const vreq = B.validator("PrintInvoiceRequest");
    for (const e of Object.values<any>(req ?? {})) expect(vreq(e.value)).toBe(true);
    const styles = Object.values<any>(req ?? {}).map((e) => e.value?.style).filter(Boolean);
    expect(styles, "a plain_bw request example").toContain("plain_bw");
  });
});

describe("T0C-PRINTCFG-1 contract: examples for the new operations (done_when 6)", () => {
  it("every 2xx JSON response of the five operations has at least one example and it validates against its schema", () => {
    let n = 0;
    for (const id of Object.keys(NEW_OPS)) {
      const m = R.okJson(id);
      if (!m) { expect(id, `${id} must return JSON`).toBe("previewPrintProfile"); continue; }
      const ex = Object.entries<any>(m.examples ?? {});
      expect(ex.length, `${id}: example`).toBeGreaterThan(0);
      const v = R.validatorAt(R.okPtr(id));
      for (const [k, e] of ex) { expect(v(e.value), `${id}/${k}: ${JSON.stringify(v.errors?.[0])}`).toBe(true); n++; }
    }
    expect(n).toBeGreaterThanOrEqual(4);
  });
  it("every JSON request body of the five operations has an example that validates; the print profile examples cover a branch row, a plain invoice and a pre printed paper report", () => {
    for (const id of ["upsertPrintProfile", "previewPrintProfile", "upsertSignatoryProfile"]) {
      const ex = Object.entries<any>(R.opOf(id)!.op.requestBody.content["application/json"].examples ?? {});
      expect(ex.length, `${id}: request example`).toBeGreaterThan(0);
      const v = R.validatorAt(R.bodyPtr(id));
      for (const [k, e] of ex) expect(v(e.value), `${id}/${k}: ${JSON.stringify(v.errors?.[0])}`).toBe(true);
    }
    const all = Object.values<any>(R.opOf("upsertPrintProfile")!.op.requestBody.content["application/json"].examples).map((e) => e.value).concat(
      Object.values<any>(R.okJson("listPrintProfiles").examples).flatMap((e: any) => e.value.data));
    expect(all.some((x) => x.paper_mode === "plain" && x.document_kind === "invoice"), "a plain invoice example").toBe(true);
    expect(all.some((x) => x.paper_mode === "preprinted_paper" && x.reserve_top_mm > 0), "a pre printed paper example with blank space").toBe(true);
  });
  it("the signer examples carry synthetic data (SYNTHETIC marker or an obviously synthetic name), never a real person", () => {
    const t = textOf(Object.values<any>(R.okJson("listSignatoryProfiles").examples));
    expect(t).toMatch(/synthetic/i);
  });
});

describe("T0C-PRINTCFG-1 generated clients (codegen is fresh)", () => {
  it("generated clients and MSW handlers are fresh (codegen --check)", () => {
    expect(staleFiles(ROOT)).toEqual([]);
  }, 120_000);
});

describe("T0C-PRINTCFG-1 migration file (static; behaviour in the pgTAP suite) (done_when 2, 3, 5)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");
  const block = (tbl: string): string => { const i = code.search(new RegExp(`CREATE TABLE IF NOT EXISTS reporting\\.${tbl}\\b`, "i")); return i < 0 ? "" : code.slice(i, i + 5000); };

  it("exists, is the only 20261117160000 migration, runs as lims_owner", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all.filter((f) => f.startsWith("20261117160000"))).toEqual([MIG]);
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("creates reporting.print_profile with every column of the brief (and recipient_type), IF NOT EXISTS, RLS enabled and forced, a guarded policy per command", () => {
    const b = block("print_profile");
    expect(b, "CREATE TABLE IF NOT EXISTS reporting.print_profile").not.toBe("");
    for (const c of ["id", "tenant_id", "branch_id", "document_kind", "recipient_type", "paper_mode", "header_text", "footer_text", "reserve_top_mm", "reserve_bottom_mm", "show_logo", "show_seller_pan", "grayscale", "font_size_pt", "created_at", "updated_at", "updated_by"])
      expect(b, `column ${c}`).toMatch(new RegExp(`\\b${c}\\s+(uuid|text|smallint|integer|int|boolean|timestamptz)`, "i"));
    expect(b).toMatch(/\b(is_active|active)\s+boolean/i);
    expect(b).toMatch(/tenant_id\s+uuid\s+NOT NULL/i);
    expect(b).toMatch(/show_seller_pan\s+boolean\s+NOT NULL\s+DEFAULT\s+true/i);
    expect(b, "branch_id nullable (no NOT NULL)").not.toMatch(/branch_id\s+uuid\s+NOT NULL/i);
    expect(code).toMatch(/ALTER TABLE reporting\.print_profile\s+ENABLE ROW LEVEL SECURITY/i);
    expect(code).toMatch(/ALTER TABLE reporting\.print_profile\s+FORCE ROW LEVEL SECURITY/i);
    for (const cmd of ["SELECT", "INSERT", "UPDATE"]) expect(code, `${cmd} policy`).toMatch(new RegExp(`CREATE POLICY print_profile__\\w+ ON reporting\\.print_profile FOR ${cmd}`, "i"));
    expect(code).toMatch(/GRANT SELECT, INSERT, UPDATE ON reporting\.print_profile TO lims_app/i);
  });
  it("creates reporting.signatory_profile with every column of the brief, IF NOT EXISTS, RLS enabled and forced, one row per user, a guarded policy per command", () => {
    const b = block("signatory_profile");
    expect(b, "CREATE TABLE IF NOT EXISTS reporting.signatory_profile").not.toBe("");
    for (const c of ["tenant_id", "user_id", "display_name", "title", "registration_no", "signature_asset_id", "updated_at", "updated_by"])
      expect(b, `column ${c}`).toMatch(new RegExp(`\\b${c}\\s+(uuid|text|timestamptz)`, "i"));
    expect(b).toMatch(/\b(is_active|active)\s+boolean/i);
    expect(b, "signature_asset_id is nullable").not.toMatch(/signature_asset_id\s+uuid\s+NOT NULL/i);
    expect(b, "one row per user: UNIQUE (tenant_id, user_id) or PRIMARY KEY").toMatch(/(UNIQUE|PRIMARY KEY)\s*\(\s*tenant_id\s*,\s*user_id\s*\)/i);
    expect(b, "user must exist in core.users").toMatch(/REFERENCES core\.users\s*\(\s*tenant_id\s*,\s*id\s*\)/i);
    expect(code).toMatch(/ALTER TABLE reporting\.signatory_profile\s+ENABLE ROW LEVEL SECURITY/i);
    expect(code).toMatch(/ALTER TABLE reporting\.signatory_profile\s+FORCE ROW LEVEL SECURITY/i);
    for (const cmd of ["SELECT", "INSERT", "UPDATE"]) expect(code, `${cmd} policy`).toMatch(new RegExp(`CREATE POLICY signatory_profile__\\w+ ON reporting\\.signatory_profile FOR ${cmd}`, "i"));
    expect(code).toMatch(/GRANT SELECT, INSERT, UPDATE ON reporting\.signatory_profile TO lims_app/i);
    for (const m of code.matchAll(/CREATE POLICY (\w+)/gi)) expect(code, `policy ${m[1]} must be guarded by pg_policy`).toMatch(new RegExp(`pg_policy[^;]*${m[1]}`, "i"));
  });
  it("value checks: document_kind, paper_mode, recipient_type lists, mm and pt bounds, 8 lines of 120 characters, no markup, one active row per key", () => {
    for (const v of [...KINDS, ...MODES, ...RECIPIENTS]) expect(code, `check names ${v}`).toContain(`'${v}'`);
    for (const n of ["80", "60"]) expect(code, `bound ${n}`).toMatch(new RegExp(`\\b${n}\\b`));
    expect(code).toMatch(/font_size_pt[^;]*\b8\b[^;]*\b12\b|BETWEEN 8 AND 12/i);
    expect(code, "120 character line limit").toMatch(/\b120\b/);
    expect(code, "8 line limit").toMatch(/\b8\b/);
    expect(code, "markup refused: < and >").toMatch(/[<>\[\]\\^]*[<>][^;]*(!~|~|NOT SIMILAR|LIKE)|(!~|~|NOT LIKE)[^;]*[<>]/i);
    expect(code, "a partial unique index for one active row per tenant, branch, kind (NULL branch counts once)").toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS\s+\w+\s+ON reporting\.print_profile[^;]*(coalesce|NULLS NOT DISTINCT)[^;]*WHERE[^;]*(is_active|active)|CREATE UNIQUE INDEX IF NOT EXISTS\s+\w+\s+ON reporting\.print_profile[^;]*WHERE[^;]*(is_active|active)[^;]*|UNIQUE NULLS NOT DISTINCT/is);
    expect(code, "document_kind is part of the unique key").toMatch(/UNIQUE[^;]*document_kind/is);
  });
  it("adds billing.print_log.style (text NOT NULL DEFAULT 'full' CHECK full | plain_bw) with ADD COLUMN IF NOT EXISTS; old rows read full; no UPDATE or DELETE grant is added", () => {
    expect(code).toMatch(/ALTER TABLE billing\.print_log\s+ADD COLUMN IF NOT EXISTS style\s+text\s+NOT NULL\s+DEFAULT\s+'full'/i);
    expect(code).toContain("'plain_bw'");
    expect(code, "style is checked").toMatch(/style\s+IN\s*\(\s*'full'\s*,\s*'plain_bw'\s*\)/i);
    expect(code).not.toMatch(/GRANT[^;]*\b(UPDATE|DELETE)\b[^;]*billing\.print_log/i);
  });
  it("is additive and rewrite-free: no data statement, no drop, only the three named tables are altered", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect(code).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|REVOKE|DROP\s+TABLE|DROP\s+COLUMN|DROP\s+SCHEMA|DROP\s+POLICY|DROP\s+INDEX)\b/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN|ALTER\s+TABLE\s+\S+\s+(RENAME|OWNER)|DISABLE\s+ROW|NO\s+FORCE|ALTER\s+POLICY|\bCREATE\s+TYPE\b|\bAS\s+ENUM\b/i);
    for (const m of code.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?((?:reporting|billing)\.\w+)/gi)) expect(["reporting.print_profile", "reporting.signatory_profile", "billing.print_log"], "only the new tables and billing.print_log may be altered").toContain(m[1]);
    expect((code.match(/CREATE TABLE(?! IF NOT EXISTS)/gi) ?? []).length, "every CREATE TABLE is IF NOT EXISTS").toBe(0);
    for (const m of code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/gi)) throw new Error(`unguarded CREATE INDEX near ${m.index}`);
    for (const m of code.matchAll(/ADD\s+CONSTRAINT/gi)) expect(code.slice(Math.max(0, m.index! - 1500), m.index), "ADD CONSTRAINT must sit in a DO block that checks pg_constraint first").toMatch(/DO\s+\$[a-z_]*\$[\s\S]*pg_constraint/i);
  });
  it("row audit triggers on both new tables (class M, audited)", () => {
    for (const t of ["print_profile", "signatory_profile"]) expect(code, `${t} audit trigger`).toMatch(new RegExp(`ON reporting\\.${t}\\s+FOR EACH ROW EXECUTE FUNCTION app\\.tg_row_audit\\(\\)`, "i"));
  });
  it("comments: LD-316, LD-319, down note (DROP TABLE and the dropped column), push-cloud, no data rewrite, both new tables named", () => {
    expect(comments).toMatch(/LD-316/);
    expect(comments).toMatch(/LD-319/);
    expect(comments).toMatch(/\bdown\b/i);
    expect(comments).toMatch(/DROP TABLE/i);
    expect(comments).toMatch(/DROP COLUMN/i);
    expect(comments).toMatch(/push-cloud/i);
    expect(comments).toMatch(/no data rewrite|does not rewrite|no rewrite|new tables?/i);
    for (const t of ["print_profile", "signatory_profile", "print_log"]) expect(comments, t).toContain(t);
  });
  it("db/meta/tables.yaml registers both tables (class M, audited, tenant scoped) and the new billing.print_log column; db/policies/reporting.sql carries the policies", () => {
    const meta = readFileSync(join(ROOT, "db/meta/tables.yaml"), "utf8");
    const line = (t: string) => meta.split("\n").find((l) => l.includes(`"${t}"`)) ?? "";
    for (const [t, cols] of [["reporting.print_profile", ["id", "tenant_id", "branch_id", "document_kind", "recipient_type", "paper_mode", "header_text", "footer_text", "reserve_top_mm", "reserve_bottom_mm", "show_logo", "show_seller_pan", "grayscale", "font_size_pt", "updated_by"]],
      ["reporting.signatory_profile", ["tenant_id", "user_id", "display_name", "title", "registration_no", "signature_asset_id", "updated_by"]]] as const) {
      const l = line(t);
      expect(l, `${t} registered`).not.toBe("");
      expect(l).toContain('"class":"M"');
      expect(l).toContain('"audited":true');
      expect(l).toContain('"centre_scoped":false');
      for (const c of cols) expect(l, `${t}: tables.yaml column ${c}`).toContain(`"${c}"`);
    }
    expect(line("billing.print_log"), "billing.print_log lists the new column style").toContain('"style"');
    const pol = readFileSync(join(ROOT, "db/policies/reporting.sql"), "utf8");
    for (const t of ["print_profile", "signatory_profile"]) for (const c of ["select", "insert", "update"]) expect(pol, `policy ${t} ${c}`).toMatch(new RegExp(`${t}__\\w*${c}\\w*`, "i"));
  });
});

describe("T0C-PRINTCFG-1 implementation notes (done_when 1, LD-325(b))", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  it("notes exist, name the migration, the five pending operation ids, T0B-PRINTCFG-1 and that the cloud migration is a founder step (push-cloud)", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-PRINTCFG-1-impl.md missing").toBe(true);
    expect(t).toContain(MIG);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/pendingOperations/);
    for (const id of Object.keys(NEW_OPS)) expect(t, id).toContain(id);
    expect(t).toMatch(/T0B-PRINTCFG-1/);
    expect(t).toMatch(/LD-316/);
    expect(t).toMatch(/LD-319/);
  });
  it("done_when 1: records exactly which print and template settings are reachable from the screens and which exist only in the contract", () => {
    expect(t).toMatch(/reachable/i);
    expect(t).toMatch(/only in the contract|contract only|not reachable|no screen/i);
    for (const w of ["createReportPrint", "printInvoice", "printCreditNote", "listInvoicePrints", "header_asset", "footer_asset", "plain_reserve_top_mm", "signatories", "show_signature_images"]) expect(t, `notes cover ${w}`).toContain(w);
  });
  it("records the design decisions: plain text header and footer (no markup), four paper modes, plain_bw keeps the tax bill lines and the accountant confirms them, signature only for pathologist sign-off, no service or web change, rs-c2 untouched", () => {
    expect(t).toMatch(/plain text/i);
    expect(t).toMatch(/letterhead_image/);
    expect(t).toMatch(/preprinted_paper/);
    expect(t).toMatch(/plain_bw/);
    expect(t).toMatch(/seller PAN/i);
    expect(t).toMatch(/accountant/i);
    expect(t).toMatch(/pathologist/i);
    expect(t).toMatch(/no (service|handler)|no web change/i);
    expect(t).toMatch(/apps\/web\/src\/features\/admin|rs-c2/i);
    expect(t, "the 12 file cap or the file count is stated").toMatch(/12 files|file cap|files? (changed|touched)/i);
  });
});
