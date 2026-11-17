// T0C-REGPARITY-3 (CR-C0-REGAPI-2 part B, LD-323, LD-326): contracts/openapi/frontdesk.yaml schema RegistrationNumberPreview.
//  - next_receipt_no becomes type [string, null], maxLength 64: it previews the next INVOICE number (issueReceiptNo is false, the invoice is the receipt); null when the preview is unavailable.
//  - next_receipt_no_label (string, minLength 1, maxLength 64) is new, required, always present: the text assigned when saved.
//  - the example of previewRegistrationNumbers is an invoice number in the tenant invoiceNoPattern shape (2083/84-000077), no RC- receipt number.
//  - The one allowed breaking change (the only consumer, T0D-REGSCREEN-2, is not merged). Nothing else changes: no other schema, no operation, no permission.
// KNOWN CONFLICT (see .orchestra/notes/T0C-REGPARITY-3-tests.md): tools/codegen/lint-openapi.ts rule 2 forbids `type` arrays (and OAS 3.0.3 has no `type: [..., null]`).
//  The brief wants type [string, null] AND a clean lint, so the lint needs one narrow exemption (this field only), as LD-119 did for rule 3. The "exactly one type array" test below pins that narrowness.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const load = (f: string): any => parse(read(`contracts/openapi/${f}.yaml`));
const fd: any = load("frontdesk");
const bl: any = load("billing");
const common: any = parse(read("contracts/openapi/_common.yaml"));
const S = fd.components.schemas as Record<string, any>;
const P = S.RegistrationNumberPreview;
const NO = P?.properties?.next_receipt_no;
const LABEL = P?.properties?.next_receipt_no_label;

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ ...common, id: "_common.yaml" });
ajv.addSchema({ ...fd, id: "frontdesk.yaml" });
ajv.addSchema({ ...bl, id: "billing.yaml" });
const validate = ajv.getSchema("frontdesk.yaml#/components/schemas/RegistrationNumberPreview")!;

const CENTRE = "0193c4a0-0000-7000-8000-000000000901";
const ok = { centre_id: CENTRE, next_registration_no: "R-2083-000124", next_receipt_no: "2083/84-000077", next_receipt_no_label: "2083/84-000077", is_preview: true };
// port failure body (LD-323): the number is null, the label says what will be assigned
const portFailure = { centre_id: CENTRE, next_registration_no: "R-2083-000124", next_receipt_no: null, next_receipt_no_label: "Assigned when saved", is_preview: true };
const INVOICE_SHAPE = /^\d{4}\/\d{2}-\d{6}$/; // tenant invoiceNoPattern '{fy}-{seq:6}' with fy 2083/84
const types = (p: any): string[] => (Array.isArray(p?.type) ? p.type : p?.type ? [p.type] : []);
const exampleBodies = (): any[] => {
  const media = fd.paths["/v1/frontdesk/registrations/number-preview"].get.responses["200"].content["application/json"];
  return Object.values<any>(media.examples ?? {}).map((e) => e.value);
};

describe("T0C-REGPARITY-3 schema RegistrationNumberPreview: shape", () => {
  it("exists, stays a closed object, and requires the 4 old fields plus next_receipt_no_label", () => {
    expect(P, "RegistrationNumberPreview").toBeDefined();
    expect(P.type).toBe("object");
    expect(P.additionalProperties).toBe(false);
    expect([...P.required].sort()).toEqual(["centre_id", "is_preview", "next_receipt_no", "next_receipt_no_label", "next_registration_no"]);
    expect(Object.keys(P.properties).sort()).toEqual(["centre_id", "is_preview", "next_receipt_no", "next_receipt_no_label", "next_registration_no"]);
  });
  it("next_receipt_no: type [string, null], maxLength 64, still required", () => {
    expect(NO, "next_receipt_no").toBeDefined();
    expect([...types(NO)].sort(), "type is string or null").toEqual(["null", "string"]);
    expect(NO.nullable, "null is expressed by the type list, not by nullable").toBeUndefined();
    expect(NO.maxLength).toBe(64);
    expect(P.required).toContain("next_receipt_no");
  });
  it("next_receipt_no description: previews the next invoice number, issueReceiptNo false, assigned when saved, two users may see the same, null when unavailable", () => {
    const d = String(NO?.description ?? "");
    expect(d).toMatch(/invoice number/i);
    expect(d).toMatch(/issueReceiptNo is false/);
    expect(d).toMatch(/invoice is the receipt/i);
    expect(d).toMatch(/assigned (when|on) (it is )?saved?/i);
    expect(d).toMatch(/two users/i);
    expect(d).toMatch(/same (preview|number)/i);
    expect(d).toMatch(/null/);
    expect(d).toMatch(/unavailable/i);
    expect(d, "the old receipt wording is gone").not.toMatch(/bill receipt number/i);
  });
  it("next_receipt_no_label: required string, minLength 1, maxLength 64, described as always the text assigned when saved", () => {
    expect(LABEL, "next_receipt_no_label").toBeDefined();
    expect(LABEL.type).toBe("string");
    expect(LABEL.minLength).toBe(1);
    expect(LABEL.maxLength).toBe(64);
    expect(P.required).toContain("next_receipt_no_label");
    const d = String(LABEL?.description ?? "");
    expect(d).toMatch(/always/i);
    expect(d).toMatch(/assigned when saved/i);
  });
  it("the other three fields are unchanged", () => {
    expect(P.properties.centre_id).toEqual({ $ref: "_common.yaml#/components/schemas/Uuid" });
    expect(P.properties.next_registration_no).toMatchObject({ type: "string", minLength: 1, maxLength: 32 });
    expect(P.properties.is_preview).toMatchObject({ type: "boolean" });
  });
});

describe("T0C-REGPARITY-3 schema RegistrationNumberPreview: validation of real bodies", () => {
  it("a success body (invoice number plus label) is valid", () => {
    expect(validate(ok), JSON.stringify(validate.errors)).toBe(true);
  });
  it("a port failure body (null number plus label) is valid", () => {
    expect(validate(portFailure), JSON.stringify(validate.errors)).toBe(true);
  });
  it("the label is mandatory, non-empty, at most 64 chars, and never null", () => {
    const { next_receipt_no_label: _l, ...noLabel } = ok;
    expect(validate(noLabel), "missing label").toBe(false);
    expect(validate({ ...ok, next_receipt_no_label: "" }), "empty label").toBe(false);
    expect(validate({ ...ok, next_receipt_no_label: "x".repeat(65) }), "65 char label").toBe(false);
    expect(validate({ ...ok, next_receipt_no_label: "x".repeat(64) }), "64 char label").toBe(true);
    expect(validate({ ...ok, next_receipt_no_label: null }), "null label").toBe(false);
    expect(validate({ ...portFailure, next_receipt_no_label: null }), "null label on a failure body").toBe(false);
  });
  it("the number is mandatory (null allowed, absent not), a string of at most 64 chars, nothing else", () => {
    const { next_receipt_no: _n, ...noNumber } = ok;
    expect(validate(noNumber), "number key absent").toBe(false);
    expect(validate({ ...ok, next_receipt_no: "9".repeat(64) }), "64 chars").toBe(true);
    expect(validate({ ...ok, next_receipt_no: "9".repeat(65) }), "65 chars").toBe(false);
    for (const bad of [123, true, {}, []]) expect(validate({ ...ok, next_receipt_no: bad }), `number ${JSON.stringify(bad)}`).toBe(false);
  });
  it("the other fields stay strict: missing field, extra field, wrong type are rejected", () => {
    for (const k of ["centre_id", "next_registration_no", "is_preview"]) {
      const b: any = { ...ok };
      delete b[k];
      expect(validate(b), `missing ${k}`).toBe(false);
    }
    expect(validate({ ...ok, tenant_id: CENTRE }), "extra field").toBe(false);
    expect(validate({ ...ok, is_preview: "yes" }), "is_preview string").toBe(false);
    expect(validate({ ...ok, next_registration_no: null }), "registration no is NOT nullable").toBe(false);
  });
});

describe("T0C-REGPARITY-3 the previewRegistrationNumbers example", () => {
  it("has at least one example; every example is valid, is_preview true, carries a label", () => {
    const ex = exampleBodies();
    expect(ex.length).toBeGreaterThan(0);
    for (const e of ex) {
      expect(validate(e), JSON.stringify(validate.errors)).toBe(true);
      expect(e.is_preview).toBe(true);
      expect(typeof e.next_receipt_no_label).toBe("string");
      expect(e.next_receipt_no_label.length).toBeGreaterThan(0);
    }
  });
  it("the success example is an invoice number in the tenant invoiceNoPattern shape (2083/84-000077), not an RC receipt number", () => {
    const ex = exampleBodies();
    const withNumber = ex.filter((e) => e.next_receipt_no !== null);
    expect(withNumber.length, "an example with a number").toBeGreaterThan(0);
    for (const e of withNumber) {
      expect(e.next_receipt_no).toMatch(INVOICE_SHAPE);
      expect(e.next_receipt_no).not.toMatch(/^RC-/);
    }
    expect(ex.some((e) => e.next_receipt_no === "2083/84-000077"), "2083/84-000077").toBe(true);
    expect(read("contracts/openapi/frontdesk.yaml")).not.toContain("RC-2083/84-000077");
  });
});

describe("T0C-REGPARITY-3 lint, scope, generated artifacts", () => {
  it("lintRepo reports no violation for frontdesk.yaml (needs the narrow type array exemption, see header)", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "frontdesk.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });
  it("the exemption is narrow: exactly ONE schema in all contracts/openapi/*.yaml has a type array, and it is RegistrationNumberPreview.next_receipt_no", () => {
    const found: string[] = [];
    const walk = (o: any, where: string) => {
      if (Array.isArray(o)) return o.forEach((x, i) => walk(x, `${where}/${i}`));
      if (o === null || typeof o !== "object") return;
      if (Array.isArray(o.type)) found.push(where);
      for (const [k, v] of Object.entries(o)) if (k !== "examples" && k !== "example" && k !== "enum") walk(v, `${where}/${k}`);
    };
    for (const f of readdirSync(join(ROOT, "contracts/openapi")).filter((x) => x.endsWith(".yaml"))) walk(parse(read(`contracts/openapi/${f}`)), f);
    expect(found).toEqual(["frontdesk.yaml/components/schemas/RegistrationNumberPreview/properties/next_receipt_no"]);
    for (const f of readdirSync(join(ROOT, "contracts/openapi")).filter((x) => x.endsWith(".yaml")))
      expect(read(`contracts/openapi/${f}`), `${f}: no nullable: true`).not.toMatch(/nullable:\s*true/);
  });
  it("scope: no other schema mentions the receipt preview fields, and the operation is unchanged (GET, same permission)", () => {
    for (const [n, s] of Object.entries<any>(S)) if (n !== "RegistrationNumberPreview") expect(JSON.stringify(s), n).not.toMatch(/next_receipt_no/);
    const op = fd.paths["/v1/frontdesk/registrations/number-preview"].get;
    expect(op.operationId).toBe("previewRegistrationNumbers");
    expect(op["x-permission"]).toBe("frontdesk.registration.create");
    expect(op.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/RegistrationNumberPreview" });
  });
  it("generated contract types are fresh (codegen output equals the files on disk)", () => {
    expect(staleFiles(ROOT)).toEqual([]);
  });
  it("generated client types: next_receipt_no is (string | null), next_receipt_no_label is a required string, in both client files", () => {
    for (const f of ["packages/api-client-ts/src/frontdesk.ts", "packages/api-client-ts/src/server/operations.ts"]) {
      const t = read(f);
      expect(t, `${f} nullable number`).toMatch(/next_receipt_no: \(string \| null\);/);
      expect(t, `${f} label`).toMatch(/next_receipt_no_label: string;/);
      expect(t, `${f} old type gone`).not.toMatch(/next_receipt_no: string;/);
    }
  });
  it("generated MSW handler for number-preview returns the invoice number example plus the label", () => {
    const line = read("packages/fakes/src/msw/handlers.generated.ts").split("\n").find((l) => l.includes("/v1/frontdesk/registrations/number-preview"))!;
    expect(line, "handler line").toBeDefined();
    expect(line).toContain('"next_receipt_no":"2083/84-000077"');
    expect(line).toContain('"next_receipt_no_label"');
    expect(line).not.toContain("RC-2083");
  });
});
