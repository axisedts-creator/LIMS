// T0C-REGPARITY-2 (LD-310; founder request 2026-11-17 04:49 + 05:00 NPT: "do not leave any function") — contracts/openapi/frontdesk.yaml + billing.yaml registration and billing parity:
// order fields, payment fields, coupons, ICD master, reward points, registration drafts, favourite tests, number preview, custom field definitions; the migration file
// 20261117110000_frontdesk__add_registration_parity_fields.sql (static checks; behaviour is db/tests/frontdesk_billing/T0C-REGPARITY-2_registration_parity.test.sql), codegen freshness, notes.
// ASSUMPTIONS (brief silent; a different choice needs a ruling, not a silent test edit; the same rulings as T0C-REGPARITY-1-ruling.md apply):
//  - Names. Operation ids are pinned (the brief names functions, not ids); paths are only required to sit under /v1/frontdesk/ and to follow the lint. See OPS below.
//    All 20 new operations live in frontdesk.yaml. billing.yaml gets additive schema fields only (payment card_holder_name / payment_remark), no new operation (billing stays at 45 paths / 47 ops).
//  - Wire rule (02-CONVENTIONS.md:348, ruling of REGPARITY-1): no field is `nullable`, no field is newly required, closed objects; an optional value is cleared by omitting it or by an `unset[]` list on PATCH.
//  - Order fields (CreateRegistrationRequest = input, OrderDto = read): collection_at, collected_by_membership_id (staff) + collected_by_name (outside collector), sample_not_collected,
//    sample_remark, remark_description, clinical_history, patient_history, mr_number, external_reference, insurance_code, insurance_claim_amount_paisa, visiting_charge_paisa, coupon_code,
//    coupon_amount_paisa, reward points (request: redeem_reward_points; read: reward_points_earned, reward_points_redeemed). coupon_amount_paisa and the reward points earned/redeemed are
//    SERVER-DERIVED: present on OrderDto, NOT accepted on the request (a client must not set its own discount). The quote input (RegistrationDraft) takes coupon_code and visiting_charge_paisa.
//  - Payment: card_holder_name, payment_remark on PaymentInput (frontdesk.yaml) and RecordPaymentRequest (billing.yaml), echoed on LedgerEntryDto (both files). card_holder_name is personal data: never in audit diffs or logs.
//  - Line: icd_code on RegistrationItem (request) and on the OrderDto item (read).
//  - Permissions: only codes that already exist (contracts/permissions.yaml): read / use = frontdesk.registration.create, master data writes = frontdesk.settings.manage. No new permission, no new error code.
//  - Notes: .orchestra/notes/T0C-REGPARITY-2-impl.md (convention of every earlier T0C task).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = "20261117110000_frontdesk__add_registration_parity_fields.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-REGPARITY-2-impl.md");
const load = (f: string): any => parse(readFileSync(join(ROOT, `contracts/openapi/${f}.yaml`), "utf8"));
const fd: any = load("frontdesk");
const bl: any = load("billing");
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const permissions = readFileSync(join(ROOT, "contracts/permissions.yaml"), "utf8");
const FS = fd.components.schemas as Record<string, any>;
const BS = bl.components.schemas as Record<string, any>;
const METHODS = ["get", "put", "post", "delete", "patch"];

const REG = "frontdesk.registration.create";
const SETM = "frontdesk.settings.manage";
const PAT_R = "frontdesk.patient.read";
type Op = { id: string; method: string; perm: string; idem: "none" | "optional" | "required"; status: number; im?: boolean; pathParam?: string };
const OPS: Op[] = [
  { id: "createRegistrationDraft", method: "post", perm: REG, idem: "required", status: 201 },
  { id: "listRegistrationDrafts", method: "get", perm: REG, idem: "none", status: 200 },
  { id: "getRegistrationDraft", method: "get", perm: REG, idem: "none", status: 200, pathParam: "draft_id" },
  { id: "deleteRegistrationDraft", method: "delete", perm: REG, idem: "none", status: 204, pathParam: "draft_id" },
  { id: "addFavouriteTest", method: "post", perm: REG, idem: "required", status: 201 },
  { id: "removeFavouriteTest", method: "delete", perm: REG, idem: "none", status: 204, pathParam: "orderable_id" },
  { id: "listFavouriteTests", method: "get", perm: REG, idem: "none", status: 200 },
  { id: "previewRegistrationNumbers", method: "get", perm: REG, idem: "none", status: 200 },
  { id: "listCustomFieldDefinitions", method: "get", perm: REG, idem: "none", status: 200 },
  { id: "createCustomFieldDefinition", method: "post", perm: SETM, idem: "required", status: 201 },
  { id: "updateCustomFieldDefinition", method: "patch", perm: SETM, idem: "optional", status: 200, im: true, pathParam: "definition_id" },
  { id: "listCoupons", method: "get", perm: SETM, idem: "none", status: 200 },
  { id: "createCoupon", method: "post", perm: SETM, idem: "required", status: 201 },
  { id: "updateCoupon", method: "patch", perm: SETM, idem: "optional", status: 200, im: true, pathParam: "coupon_id" },
  { id: "listIcdCodes", method: "get", perm: REG, idem: "none", status: 200 },
  { id: "createIcdCode", method: "post", perm: SETM, idem: "required", status: 201 },
  { id: "updateIcdCode", method: "patch", perm: SETM, idem: "optional", status: 200, im: true, pathParam: "icd_code_id" },
  { id: "getPatientRewards", method: "get", perm: PAT_R, idem: "none", status: 200, pathParam: "patient_id" },
];
const LISTS = ["listRegistrationDrafts", "listFavouriteTests", "listCustomFieldDefinitions", "listCoupons", "listIcdCodes"];
// the 29 operations that existed before this task (c4-openapi.test.ts table) must all still be there, same method + path
const BASELINE_FD = ["searchPatients", "createPatient", "getPatient", "updatePatient", "recordPatientConsent", "listPatientOrders", "anonymisePatient", "quoteRegistration", "quoteOrderItemsChange",
  "createRegistration", "listOrders", "getOrder", "confirmPreRegisteredOrder", "changeOrderItems", "cancelOrder", "requestDiscountApproval", "listDiscountApprovals", "getDiscountApproval",
  "approveDiscount", "rejectDiscount", "uploadTrf", "getTrfAttachment", "getTrfAttachmentContent", "listOrderFlags", "resolveOrderFlag", "getFrontdeskSettings", "updateFrontdeskSettings",
  "listFrontdeskCodes", "listPossibleDuplicatePatients"];

const opIndex = (d: any) => {
  const m: Record<string, { path: string; method: string; op: any }> = {};
  for (const [path, item] of Object.entries<any>(d.paths)) for (const method of METHODS) if (item[method]) m[item[method].operationId] = { path, method, op: item[method] };
  return m;
};
const FOPS = opIndex(fd);
const BOPS = opIndex(bl);
const deref = (s: any, S: Record<string, any> = FS): any => {
  let cur = s;
  for (let i = 0; i < 6 && cur?.$ref; i++) {
    if (cur.$ref.startsWith("#/components/schemas/")) cur = S[cur.$ref.split("/").pop()!];
    else if (cur.$ref.startsWith("_common.yaml#/components/schemas/")) cur = common.components.schemas[cur.$ref.split("/").pop()!];
    else break;
  }
  return cur;
};
const bodyOf = (id: string, which: "req" | "res", code?: string): any => {
  const op = FOPS[id]?.op;
  const media = which === "req" ? op?.requestBody?.content?.["application/json"] : op?.responses?.[code ?? String(OPS.find((o) => o.id === id)?.status)]?.content?.["application/json"];
  return media;
};
const schemaOf = (id: string, which: "req" | "res", code?: string) => deref(bodyOf(id, which, code)?.schema);
const props = (name: string, S = FS): Record<string, any> => S[name]?.properties ?? {};
const isInt64Money = (p: any) => p?.type === "integer" && p?.format === "int64" && p?.minimum === 0 && Number.isInteger(p?.maximum);

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ ...common, id: "_common.yaml" });
ajv.addSchema({ ...fd, id: "frontdesk.yaml" });
ajv.addSchema({ ...bl, id: "billing.yaml" });
const validator = (file: string, name: string) => {
  const v = ajv.getSchema(`${file}.yaml#/components/schemas/${name}`);
  expect(v, `cannot resolve ${file}:${name}`).toBeDefined();
  return v!;
};

const ORDER_FIELDS = ["collection_at", "collected_by_membership_id", "collected_by_name", "sample_not_collected", "sample_remark", "remark_description", "clinical_history", "patient_history",
  "mr_number", "external_reference", "insurance_code", "insurance_claim_amount_paisa", "visiting_charge_paisa", "coupon_code"];
const ORDER_STRINGS = ["collected_by_name", "sample_remark", "remark_description", "clinical_history", "patient_history", "mr_number", "external_reference", "insurance_code", "coupon_code"];
const ORDER_MONEY = ["insurance_claim_amount_paisa", "visiting_charge_paisa"];
const SERVER_DERIVED = ["coupon_amount_paisa", "reward_points_earned", "reward_points_redeemed"];

describe("T0C-REGPARITY-2 contract: lint, baseline kept, additive", () => {
  it("lintRepo reports no violation for frontdesk.yaml or billing.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "frontdesk.yaml" || x.file === "billing.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });
  it("frontdesk.yaml keeps all 29 old operations at their old method + path; billing.yaml has no new operation", () => {
    for (const id of BASELINE_FD) expect(FOPS[id], `${id} removed`).toBeDefined();
    expect(Object.keys(BOPS).length, "billing operations").toBe(47);
    expect(Object.keys(bl.paths).length, "billing paths").toBe(45);
    expect(Object.keys(FOPS).length, "frontdesk operations = 29 old + 18 new").toBe(29 + OPS.length);
    expect(OPS.length).toBe(18);
  });
  it("old required lists are unchanged (nothing new is required)", () => {
    expect(FS.CreateRegistrationRequest.required).toEqual(["patient", "centre_id", "visit_type", "billing_mode", "items", "quote_fingerprint", "payments"]);
    expect(FS.RegistrationDraft.required).toEqual(["patient", "centre_id", "visit_type", "billing_mode", "items"]);
    expect(FS.RegistrationItem.required).toEqual(["orderable_id"]);
    expect(FS.PaymentInput.required).toEqual(["method_code", "amount_received_paisa"]);
    expect(BS.PaymentInput.required).toEqual(["method_code", "amount_received_paisa"]);
    expect(BS.RecordPaymentRequest.required).toEqual(["method_code", "amount_received_paisa"]);
    expect(FS.OrderDto.required).toEqual(["id", "registration_no", "patient", "branch_id", "centre_id", "visit_type", "billing_mode", "priority", "collection_mode", "source", "status", "items", "discounts",
      "trf_attachments", "flags", "requires_credit_note", "version"]);
    for (const [f, S] of [["frontdesk", FS], ["billing", BS]] as const) {
      expect(S.LedgerEntryDto.required, `${f} LedgerEntryDto`).toEqual(["id", "entry_kind", "capture_kind", "method_code", "amount", "created_at", "business_date_bs"]);
    }
  });
  it("closed objects kept and nothing new is `nullable`", () => {
    for (const [S, names] of [[FS, ["CreateRegistrationRequest", "OrderDto", "RegistrationDraft", "RegistrationItem", "PaymentInput", "LedgerEntryDto"]], [BS, ["PaymentInput", "RecordPaymentRequest", "LedgerEntryDto"]]] as const) {
      for (const n of names) {
        expect(S[n].additionalProperties, n).toBe(false);
        for (const [k, p] of Object.entries<any>(S[n].properties)) expect(p?.nullable, `${n}.${k}`).not.toBe(true);
      }
    }
  });
});

describe("T0C-REGPARITY-2 contract: order fields (registration request + order read)", () => {
  it("CreateRegistrationRequest and OrderDto carry every order field, optional, bounded", () => {
    for (const name of ["CreateRegistrationRequest", "OrderDto"]) {
      for (const f of [...ORDER_FIELDS]) {
        expect(props(name)[f], `${name}.${f}`).toBeDefined();
        expect(FS[name].required ?? [], `${name}.${f} must stay optional`).not.toContain(f);
      }
      for (const f of ORDER_STRINGS) {
        const p = props(name)[f];
        expect(p.type, `${name}.${f}`).toBe("string");
        expect(Number.isInteger(p.maxLength) && p.maxLength > 0 && p.maxLength <= 4000, `${name}.${f} sane maxLength`).toBe(true);
      }
      for (const f of ORDER_MONEY) expect(isInt64Money(props(name)[f]), `${name}.${f} is int64 paisa >= 0 with a maximum`).toBe(true);
      expect(props(name).sample_not_collected.type).toBe("boolean");
      expect(JSON.stringify(props(name).collection_at)).toContain("IsoUtc");
      expect(JSON.stringify(props(name).collected_by_membership_id)).toContain("Uuid");
    }
  });
  it("histories allow long text, remarks stay short (bounds are deliberate)", () => {
    for (const name of ["CreateRegistrationRequest", "OrderDto"]) {
      expect(props(name).clinical_history.maxLength).toBeGreaterThanOrEqual(1000);
      expect(props(name).patient_history.maxLength).toBeGreaterThanOrEqual(1000);
      expect(props(name).mr_number.maxLength).toBeLessThanOrEqual(64);
      expect(props(name).external_reference.maxLength).toBeLessThanOrEqual(64);
    }
  });
  it("server-derived values (coupon amount, reward points earned / redeemed) are on OrderDto and NOT accepted on the request", () => {
    for (const f of SERVER_DERIVED) {
      expect(props("OrderDto")[f], `OrderDto.${f}`).toBeDefined();
      expect(props("CreateRegistrationRequest")[f], `CreateRegistrationRequest.${f} must not be client-settable`).toBeUndefined();
      expect(props("RegistrationDraft")[f], `RegistrationDraft.${f}`).toBeUndefined();
    }
    expect(isInt64Money(props("OrderDto").coupon_amount_paisa)).toBe(true);
    for (const f of ["reward_points_earned", "reward_points_redeemed"]) {
      const p = props("OrderDto")[f];
      expect(p.type).toBe("integer");
      expect(p.minimum).toBe(0);
      expect(Number.isInteger(p.maximum)).toBe(true);
    }
  });
  it("redeem_reward_points is an optional bounded non-negative integer on the request", () => {
    const p = props("CreateRegistrationRequest").redeem_reward_points;
    expect(p, "CreateRegistrationRequest.redeem_reward_points").toBeDefined();
    expect(p.type).toBe("integer");
    expect(p.minimum).toBe(0);
    expect(Number.isInteger(p.maximum)).toBe(true);
    expect(FS.CreateRegistrationRequest.required).not.toContain("redeem_reward_points");
  });
  it("the quote input (RegistrationDraft) takes coupon_code and visiting_charge_paisa so a quote can price them", () => {
    expect(props("RegistrationDraft").coupon_code?.type).toBe("string");
    expect(isInt64Money(props("RegistrationDraft").visiting_charge_paisa)).toBe(true);
    expect(FS.RegistrationDraft.required).not.toContain("coupon_code");
  });
  it("coupon_code is sensitive-free but bounded: a code pattern or a short maxLength rejects junk", () => {
    const p = props("CreateRegistrationRequest").coupon_code;
    expect(p.maxLength).toBeLessThanOrEqual(64);
    const v = validator("frontdesk", "CreateRegistrationRequest");
    expect(v(minimalRegistration({ coupon_code: "x".repeat(500) })), "500-char coupon_code").toBe(false);
  });
  it("icd_code is per order line: RegistrationItem (request) and the OrderDto item (read), optional, bounded", () => {
    for (const p of [props("RegistrationItem").icd_code, FS.OrderDto.properties.items.items.properties.icd_code]) {
      expect(p, "icd_code").toBeDefined();
      expect(p.type).toBe("string");
      expect(p.maxLength).toBeLessThanOrEqual(16);
    }
    expect(FS.OrderDto.properties.items.items.required).not.toContain("icd_code");
  });
  it("RegistrationItem rejects an oversized or unknown icd_code; accepts a synthetic one", () => {
    const v = validator("frontdesk", "RegistrationItem");
    expect(v({ orderable_id: ID, icd_code: "A09" }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ orderable_id: ID }), "icd_code stays optional").toBe(true);
    expect(v({ orderable_id: ID, icd_code: "X".repeat(40) })).toBe(false);
    expect(v({ orderable_id: ID, icd_code: "A09", other: 1 })).toBe(false);
  });
});

const ID = "0193c4a0-0000-7000-8000-0000000000aa";
const minimalRegistration = (o: object = {}) => ({
  patient: { patient_id: ID }, centre_id: ID, visit_type: "opd", billing_mode: "cash", items: [{ orderable_id: ID }], quote_fingerprint: "a".repeat(64), payments: [{ method_code: "cash", amount_received_paisa: 100 }], ...o,
});

describe("T0C-REGPARITY-2 contract: order payloads (ajv)", () => {
  const patientRefOk = () => {
    // find a PatientRef shape that validates, whatever its exact field names are
    const v = validator("frontdesk", "CreateRegistrationRequest");
    return v;
  };
  it("a full registration with every new field validates; the old minimal one still does", () => {
    const v = patientRefOk();
    const full = minimalRegistration({
      collection_at: "2026-11-17T04:15:00.000Z", collected_by_name: "Synthetic Collector", sample_not_collected: false, sample_remark: "ok", remark_description: "synthetic remark",
      clinical_history: "synthetic clinical history", patient_history: "synthetic patient history", mr_number: "MR-SYN-0001", external_reference: "EXT-SYN-0001", insurance_code: "INS-SYN-1",
      insurance_claim_amount_paisa: 5000, visiting_charge_paisa: 20000, coupon_code: "SAVE10", redeem_reward_points: 10, items: [{ orderable_id: ID, icd_code: "A09" }],
      payments: [{ method_code: "card", amount_received_paisa: 100, card_holder_name: "Synthetic Holder", payment_remark: "synthetic" }],
    });
    expect(v(full), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v(minimalRegistration()), JSON.stringify(v.errors?.[0])).toBe(true);
  });
  it("a staff collector and an outside collector are both expressible", () => {
    const v = patientRefOk();
    expect(v(minimalRegistration({ collected_by_membership_id: ID })), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v(minimalRegistration({ collected_by_name: "Outside Courier (synthetic)" })), JSON.stringify(v.errors?.[0])).toBe(true);
  });
  it("rejects bad values: negative or fractional money, null, client-set coupon amount / earned points, junk types, oversize text", () => {
    const v = patientRefOk();
    for (const bad of [{ insurance_claim_amount_paisa: -1 }, { visiting_charge_paisa: -5 }, { visiting_charge_paisa: 1.5 }, { visiting_charge_paisa: "100" }, { visiting_charge_paisa: null }, { coupon_amount_paisa: 1000 },
      { reward_points_earned: 5 }, { reward_points_redeemed: 5 }, { redeem_reward_points: -1 }, { redeem_reward_points: 1.5 }, { sample_not_collected: "yes" }, { collection_at: 12345 }, { collection_at: "yesterday" },
      { clinical_history: "x".repeat(100000) }, { mr_number: "x".repeat(500) }, { unknown_field: 1 }, { collected_by_membership_id: "not-a-uuid" }]) {
      expect(v(minimalRegistration(bad)), `accepted ${JSON.stringify(bad).slice(0, 80)}`).toBe(false);
    }
  });
  it("PaymentInput (frontdesk) and RecordPaymentRequest (billing) take card_holder_name and payment_remark, bounded and optional", () => {
    for (const [file, S, name] of [["frontdesk", FS, "PaymentInput"], ["billing", BS, "PaymentInput"], ["billing", BS, "RecordPaymentRequest"]] as const) {
      for (const f of ["card_holder_name", "payment_remark"]) {
        const p = S[name].properties[f];
        expect(p, `${file} ${name}.${f}`).toBeDefined();
        expect(p.type).toBe("string");
        expect(p.maxLength).toBeGreaterThan(0);
        expect(p.maxLength).toBeLessThanOrEqual(300);
        expect(S[name].required).not.toContain(f);
      }
      const v = validator(file, name);
      const base = { method_code: "card", amount_received_paisa: 100 };
      expect(v({ ...base, card_holder_name: "Synthetic Holder", payment_remark: "synthetic" }), `${file} ${name}: ${JSON.stringify(v.errors?.[0])}`).toBe(true);
      expect(v(base), `${file} ${name} minimal`).toBe(true);
      expect(v({ ...base, card_holder_name: "x".repeat(1000) }), `${file} ${name} oversize`).toBe(false);
      expect(v({ ...base, payment_remark: null }), `${file} ${name} null`).toBe(false);
    }
  });
  it("LedgerEntryDto (both files) echoes card_holder_name and payment_remark as optional strings", () => {
    for (const S of [FS, BS]) for (const f of ["card_holder_name", "payment_remark"]) {
      expect(S.LedgerEntryDto.properties[f]?.type, `LedgerEntryDto.${f}`).toBe("string");
      expect(S.LedgerEntryDto.required).not.toContain(f);
    }
  });
  it("OrderDto read payload with every new field validates and all of them are optional", () => {
    const base: any = { id: ID, registration_no: "R-1", patient: { id: ID, patient_code: "P-000001", full_name: "Demo Patient A", sex: "female", age_display: "43 Years", phone_masked: "15xxxxxx00", is_anonymised: false },
      branch_id: ID, centre_id: ID, visit_type: "opd", billing_mode: "cash", priority: "routine", collection_mode: "walk_in", source: "front_desk", status: "registered", items: [], discounts: [], trf_attachments: [], flags: [],
      requires_credit_note: false, version: 1 };
    const v = validator("frontdesk", "OrderDto");
    expect(v(base), `old minimal OrderDto: ${JSON.stringify(v.errors?.[0])}`).toBe(true);
    const full = { ...base, collection_at: "2026-11-17T04:15:00.000Z", collected_by_name: "Synthetic Collector", sample_not_collected: true, sample_remark: "hemolysed", remark_description: "synthetic", clinical_history: "s",
      patient_history: "s", mr_number: "MR-SYN-0001", external_reference: "EXT-SYN-0001", insurance_code: "INS-SYN-1", insurance_claim_amount_paisa: 5000, visiting_charge_paisa: 20000, coupon_code: "SAVE10",
      coupon_amount_paisa: 1000, reward_points_earned: 12, reward_points_redeemed: 3 };
    expect(v(full), JSON.stringify(v.errors?.[0])).toBe(true);
  });
});

describe("T0C-REGPARITY-2 contract: the 18 new operations", () => {
  describe.each(OPS)("$id", (r) => {
    const e = FOPS[r.id];
    it("exists in frontdesk.yaml at the right method under /v1/frontdesk/, tag frontdesk", () => {
      expect(e, `${r.id} missing`).toBeDefined();
      expect(e.method).toBe(r.method);
      expect(e.path.startsWith("/v1/frontdesk/")).toBe(true);
      expect(e.op.tags).toEqual(["frontdesk"]);
      expect(typeof e.op.summary).toBe("string");
      if (r.pathParam) expect(e.path, "path parameter").toContain(`{${r.pathParam}}`);
      expect(e.path).not.toMatch(/\{(registration_no|invoice_no|barcode|phone)\}/);
    });
    it(`x-permission ${r.perm} (an existing code), x-idempotency ${r.idem}, tier general, bearer, tenant context`, () => {
      expect(e.op["x-permission"]).toBe(r.perm);
      expect(permissions, `${r.perm} not in permissions.yaml`).toContain(r.perm);
      expect(e.op["x-public"]).toBeUndefined();
      expect(e.op["x-idempotency"]).toBe(r.idem);
      expect(e.op["x-rate-limit-tier"]).toBe("general");
      expect(e.op.security).toEqual([{ bearerJwt: [] }]);
      expect([undefined, "tenant"]).toContain(e.op["x-context"]);
    });
    it(`success response ${r.status}; common errors listed; Idempotency-Key / If-Match as declared`, () => {
      expect(Object.keys(e.op.responses)).toContain(String(r.status));
      for (const c of ["common.validation_failed", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"]) expect(e.op["x-error-codes"], c).toContain(c);
      if (r.pathParam) expect(e.op["x-error-codes"]).toContain("common.not_found");
      const params = JSON.stringify(e.op.parameters ?? []);
      if (r.idem === "required") expect(params).toMatch(/IdempotencyKey|Idempotency-Key/);
      else expect(params).not.toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.im) { expect(params).toMatch(/IfMatch|If-Match/); expect(e.op["x-error-codes"]).toEqual(expect.arrayContaining(["common.version_conflict", "common.precondition_required"])); }
      else expect(params).not.toMatch(/IfMatch|If-Match/);
    });
    it("has a synthetic example on every JSON request and 2xx response, and it validates", () => {
      const media: any[] = [];
      if (e.op.requestBody?.content?.["application/json"]) media.push(e.op.requestBody.content["application/json"]);
      for (const [c, resp] of Object.entries<any>(e.op.responses)) if (/^2/.test(c) && !resp.$ref && resp.content?.["application/json"]) media.push(resp.content["application/json"]);
      if (r.status !== 204) expect(media.length, "a JSON 2xx response").toBeGreaterThan(0);
      for (const m of media) {
        const ex = Object.values<any>(m.examples ?? {}).map((x) => x.value);
        expect(ex.length, "example").toBeGreaterThan(0);
        const key = m.schema?.$ref?.startsWith("#/components/schemas/") ? m.schema.$ref.split("/").pop() : null;
        if (key) { const v = validator("frontdesk", key); for (const x of ex) expect(v(x), `${r.id} example vs ${key}: ${JSON.stringify(v.errors?.[0])}`).toBe(true); }
        const blob = JSON.stringify(ex);
        expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
        expect(blob).not.toMatch(/(?<!\d)(?:\+?977[-\s]?)?9[678]\d{8}(?!\d)/);
      }
    });
  });
  it("list operations take cursor + limit and return { data: bounded array, page }", () => {
    for (const id of LISTS) {
      const ps = JSON.stringify(FOPS[id].op.parameters ?? []);
      expect(ps, id).toMatch(/cursor|Cursor/);
      expect(ps, id).toMatch(/limit|Limit/);
      expect(FOPS[id].op["x-error-codes"], id).toContain("common.invalid_cursor");
      const s = schemaOf(id, "res");
      expect(s?.additionalProperties, id).toBe(false);
      expect(s?.required, id).toEqual(expect.arrayContaining(["data", "page"]));
      expect(s?.properties?.data?.type, id).toBe("array");
      expect(typeof s?.properties?.data?.maxItems, `${id} data.maxItems`).toBe("number");
    }
  });
});

describe("T0C-REGPARITY-2 contract: registration drafts", () => {
  it("create takes centre_id + a bounded payload, never tenant_id / user_id / expires_at from the client", () => {
    const s = schemaOf("createRegistrationDraft", "req");
    expect(s.additionalProperties).toBe(false);
    for (const f of ["centre_id", "payload"]) { expect(s.properties[f], f).toBeDefined(); expect(s.required).toContain(f); }
    for (const f of ["tenant_id", "user_id", "expires_at", "id", "created_by"]) expect(s.properties[f], `request must not take ${f}`).toBeUndefined();
    const p = deref(s.properties.payload);
    if (p.type === "string") expect(typeof p.maxLength, "payload maxLength").toBe("number");
    else { expect(p.type).toBe("object"); expect(p.additionalProperties, "payload object must be closed (02-CONVENTIONS.md:423)").toBe(false); }
    if (p.type === "string") expect(p.maxLength).toBeLessThanOrEqual(1_000_000);
  });
  it("read shape has id, centre_id, payload, updated_at and expires_at (14 days) and states the 14-day expiry", () => {
    for (const id of ["getRegistrationDraft", "createRegistrationDraft"]) {
      const s = schemaOf(id, "res");
      expect(s.additionalProperties).toBe(false);
      for (const f of ["id", "centre_id", "payload", "updated_at", "expires_at"]) { expect(s.properties[f], `${id}.${f}`).toBeDefined(); expect(s.required, `${id}.${f} required`).toContain(f); }
      expect(JSON.stringify(s.properties.expires_at)).toContain("IsoUtc");
      expect(s.properties.tenant_id, "tenant id is never echoed").toBeUndefined();
    }
    const text = JSON.stringify([FOPS.createRegistrationDraft.op, FOPS.listRegistrationDrafts.op]) + JSON.stringify(Object.values(FS).map((x: any) => x?.description ?? ""));
    expect(text).toMatch(/14 days|14 day|fourteen/i);
  });
  it("list supports filtering by centre_id and never returns another user's draft (documented)", () => {
    expect(JSON.stringify(FOPS.listRegistrationDrafts.op.parameters)).toContain("centre_id");
    expect(String(FOPS.listRegistrationDrafts.op.description ?? "")).toMatch(/own|current user|caller/i);
  });
  it("the quote input RegistrationDraft is untouched in meaning: it is still not a persisted draft (no id, no expires_at)", () => {
    expect(props("RegistrationDraft").id).toBeUndefined();
    expect(props("RegistrationDraft").expires_at).toBeUndefined();
  });
});

describe("T0C-REGPARITY-2 contract: favourite tests, number preview, custom fields, coupons, ICD, rewards", () => {
  it("addFavouriteTest takes orderable_id only; removeFavouriteTest is DELETE by orderable_id; list returns orderable ids", () => {
    const s = schemaOf("addFavouriteTest", "req");
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(["orderable_id"]);
    for (const f of ["tenant_id", "user_id"]) expect(s.properties[f], f).toBeUndefined();
    const item = deref(schemaOf("listFavouriteTests", "res").properties.data.items);
    expect(item.properties.orderable_id, "list item orderable_id").toBeDefined();
  });
  it("previewRegistrationNumbers: GET with required centre_id; returns next_registration_no, next_receipt_no, is_preview; says preview, not consumed, may differ", () => {
    const op = FOPS.previewRegistrationNumbers.op;
    const q = (op.parameters ?? []).find((p: any) => p.name === "centre_id");
    expect(q, "centre_id query parameter").toBeDefined();
    expect(q.in).toBe("query");
    expect(q.required).toBe(true);
    const s = schemaOf("previewRegistrationNumbers", "res");
    expect(s.additionalProperties).toBe(false);
    for (const f of ["next_registration_no", "next_receipt_no", "is_preview"]) { expect(s.properties[f], f).toBeDefined(); expect(s.required, f).toContain(f); }
    expect(s.properties.next_registration_no.type).toBe("string");
    expect(s.properties.next_receipt_no.type).toBe("string");
    expect(s.properties.is_preview.type).toBe("boolean");
    const d = `${op.description ?? ""} ${s.description ?? ""} ${s.properties.next_registration_no.description ?? ""}`;
    expect(d).toMatch(/preview/i);
    expect(d).toMatch(/not consum|without consuming|does not consume|never consume/i);
    expect(d).toMatch(/may differ|can differ|might differ/i);
    expect(d).toMatch(/another user/i);
    expect(d).toMatch(/assigned on save|assigned when .*saved|assigned at save/i);
    const ex = Object.values<any>(bodyOf("previewRegistrationNumbers", "res").examples ?? {}).map((x) => x.value);
    for (const e of ex) expect(e.is_preview).toBe(true);
  });
  it("custom field definitions: key, label, type (text|number|date|choice), required, active; key and type are immutable (not in the update body)", () => {
    const item = deref(schemaOf("listCustomFieldDefinitions", "res").properties.data.items);
    for (const f of ["id", "field_key", "label", "field_type", "required", "is_active", "version"]) expect(item.properties[f], `definition.${f}`).toBeDefined();
    expect([...deref(item.properties.field_type).enum].sort()).toEqual(["choice", "date", "number", "text"]);
    expect(item.properties.required.type).toBe("boolean");
    const create = schemaOf("createCustomFieldDefinition", "req");
    expect(create.additionalProperties).toBe(false);
    for (const f of ["field_key", "label", "field_type"]) expect(create.required, f).toContain(f);
    const key = deref(create.properties.field_key);
    expect(key.maxLength).toBeLessThanOrEqual(64);
    expect(new RegExp(key.pattern ?? "^$").test("blood_group"), "field_key pattern accepts blood_group").toBe(true);
    for (const bad of ["Blood Group", "1abc", "a;drop", "../x", ""]) expect(new RegExp(key.pattern ?? "^$").test(bad), `field_key pattern accepts ${JSON.stringify(bad)}`).toBe(false);
    const upd = schemaOf("updateCustomFieldDefinition", "req");
    expect(upd.additionalProperties).toBe(false);
    expect(upd.required ?? [], "update body has no required key").not.toContain("field_key");
    for (const f of ["field_key", "field_type", "tenant_id"]) expect(upd.properties[f], `update must not change ${f}`).toBeUndefined();
    for (const f of ["label", "required", "is_active"]) expect(upd.properties[f], `update.${f}`).toBeDefined();
  });
  it("custom field create validates: a choice definition lists its choices, a text one does not need any; unknown type rejected", () => {
    const body = bodyOf("createCustomFieldDefinition", "req").schema.$ref.split("/").pop();
    const v = validator("frontdesk", body);
    expect(v({ field_key: "blood_group", label: "Blood group", field_type: "choice", choices: ["A+", "O+"], required: false }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ field_key: "referral_note", label: "Referral note", field_type: "text" }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ field_key: "x", label: "X", field_type: "blob" })).toBe(false);
    expect(v({ field_key: "Bad Key", label: "X", field_type: "text" })).toBe(false);
  });
  it("coupons: code + (amount_paisa | percent) + validity dates + usage limit; used_count is read-only; tenant never client-set", () => {
    const item = deref(schemaOf("listCoupons", "res").properties.data.items);
    for (const f of ["id", "code", "amount_paisa", "percent", "valid_from", "valid_to", "usage_limit", "used_count", "is_active", "version"]) expect(item.properties[f], `coupon.${f}`).toBeDefined();
    const create = schemaOf("createCoupon", "req");
    expect(create.additionalProperties).toBe(false);
    expect(create.required).toContain("code");
    for (const f of ["code", "amount_paisa", "percent", "valid_from", "valid_to", "usage_limit", "is_active"]) expect(create.properties[f], `create.${f}`).toBeDefined();
    for (const f of ["used_count", "tenant_id", "id"]) expect(create.properties[f], `create must not take ${f}`).toBeUndefined();
    const amt = deref(create.properties.amount_paisa);
    expect(amt.type).toBe("integer");
    expect(amt.format).toBe("int64");
    expect(amt.minimum).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(amt.maximum)).toBe(true);
    const upd = schemaOf("updateCoupon", "req");
    for (const f of ["used_count", "tenant_id", "code"]) expect(upd.properties[f], `update must not change ${f}`).toBeUndefined();
    expect(upd.properties.is_active, "update.is_active (deactivate a coupon)").toBeDefined();
  });
  it("coupon create payloads: amount coupon, percent coupon valid; percent over 100, negative amount, past end before start rejected by the schema where expressible", () => {
    const v = validator("frontdesk", bodyOf("createCoupon", "req").schema.$ref.split("/").pop());
    expect(v({ code: "SAVE10", percent: 10, valid_from: "2026-11-17", valid_to: "2026-12-31", usage_limit: 100 }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ code: "FLAT500", amount_paisa: 50000 }), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ code: "NEG", amount_paisa: -1 }, { code: "BIG", percent: 101 }, { code: "ZERO", usage_limit: 0 }, { code: "x".repeat(200), percent: 5 }, { code: "T", percent: 5, extra: 1 }, { amount_paisa: 5 }]) {
      expect(v(bad), `accepted ${JSON.stringify(bad).slice(0, 70)}`).toBe(false);
    }
  });
  it("ICD master: code + description + active; update cannot change the code; list takes a q search parameter", () => {
    const item = deref(schemaOf("listIcdCodes", "res").properties.data.items);
    for (const f of ["id", "code", "description", "is_active", "version"]) expect(item.properties[f], `icd.${f}`).toBeDefined();
    expect(JSON.stringify(FOPS.listIcdCodes.op.parameters)).toMatch(/"name":"q"/);
    const create = schemaOf("createIcdCode", "req");
    expect(create.required).toEqual(expect.arrayContaining(["code", "description"]));
    expect(deref(create.properties.code).maxLength).toBeLessThanOrEqual(16);
    expect(deref(create.properties.description).maxLength).toBeLessThanOrEqual(500);
    const upd = schemaOf("updateIcdCode", "req");
    for (const f of ["code", "tenant_id"]) expect(upd.properties[f], `update must not change ${f}`).toBeUndefined();
    expect(upd.properties.description).toBeDefined();
    expect(upd.properties.is_active).toBeDefined();
  });
  it("patient rewards: GET returns balance, earned and redeemed totals and a ledger page; reads are patient-scoped by path", () => {
    const s = schemaOf("getPatientRewards", "res");
    expect(s.additionalProperties).toBe(false);
    for (const f of ["balance_points", "earned_points", "redeemed_points"]) { expect(s.properties[f], f).toBeDefined(); expect(s.properties[f].type, f).toBe("integer"); expect(s.required, f).toContain(f); }
    expect(s.properties.data?.type, "ledger rows").toBe("array");
    expect(typeof s.properties.data?.maxItems).toBe("number");
    expect(s.required).toContain("page");
    expect(JSON.stringify(FOPS.getPatientRewards.op.parameters)).toMatch(/cursor|Cursor/);
    const row = deref(s.properties.data.items);
    for (const f of ["id", "entry_kind", "points", "created_at"]) expect(row.properties[f], `reward row.${f}`).toBeDefined();
    expect([...deref(row.properties.entry_kind).enum].sort()).toEqual(["earned", "redeemed"]);
    expect(row.properties.order_id, "reference to the order").toBeDefined();
  });
});

describe("T0C-REGPARITY-2 generated clients", () => {
  it("generated clients and MSW handlers are fresh (codegen --check)", () => {
    expect(staleFiles(ROOT)).toEqual([]);
  }, 120_000);
});

describe("T0C-REGPARITY-2 migration file (static; behaviour in the pgTAP suite)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");
  const NEW_TABLES = ["coupons", "icd_codes", "reward_points_ledger", "registration_drafts", "favourite_tests", "custom_field_definitions"];

  it("exists, is the newest migration, runs as lims_owner, sits after 20261117100000", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all[all.length - 1] >= MIG).toBe(true);
    expect(all.filter((f) => f.startsWith("20261117110000"))).toEqual([MIG]);
    expect(all).toContain("20261117100000_frontdesk__add_patient_parity_fields.sql");
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("creates the six tables IF NOT EXISTS, each with ENABLE + FORCE row level security and tenant-scoped policies", () => {
    for (const t of NEW_TABLES) {
      expect(code, `CREATE TABLE ${t}`).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS frontdesk\\.${t}\\b`, "i"));
      expect(code, `ENABLE RLS ${t}`).toMatch(new RegExp(`ALTER TABLE frontdesk\\.${t} ENABLE ROW LEVEL SECURITY`, "i"));
      expect(code, `FORCE RLS ${t}`).toMatch(new RegExp(`ALTER TABLE frontdesk\\.${t} FORCE ROW LEVEL SECURITY`, "i"));
      expect(code, `policy on ${t}`).toMatch(new RegExp(`CREATE POLICY[^;]*ON frontdesk\\.${t}\\b[^;]*app\\.current_tenant_id\\(\\)`, "is"));
      expect(code, `GRANT lims_app ${t}`).toMatch(new RegExp(`GRANT[^;]*ON frontdesk\\.${t} TO lims_app`, "i"));
    }
    expect((code.match(/CREATE TABLE/gi) ?? []).length).toBe((code.match(/CREATE TABLE IF NOT EXISTS/gi) ?? []).length);
  });
  it("policies are re-runnable: each CREATE POLICY is preceded by DROP POLICY IF EXISTS or sits in a pg_policies guard", () => {
    for (const m of code.matchAll(/CREATE\s+POLICY\s+(\S+)\s+ON\s+(\S+)/gi)) {
      const before = code.slice(Math.max(0, m.index! - 700), m.index);
      const dropped = new RegExp(`DROP POLICY IF EXISTS ${m[1]}\\b`, "i").test(code.slice(0, m.index! + 10));
      expect(dropped || /pg_policy/i.test(before), `policy ${m[1]} is not idempotent`).toBe(true);
    }
  });
  it("is additive: new nullable columns only on existing tables; no DROP TABLE / COLUMN, TRUNCATE, data statement, type change, NOT NULL or DEFAULT on an ADD COLUMN of an old table", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect(code).not.toMatch(/\b(DROP\s+(TABLE|COLUMN|SCHEMA|TRIGGER|INDEX)|TRUNCATE|DELETE\s+FROM|UPDATE\s+\S+\s+SET|REVOKE)\b/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN|SET\s+NOT\s+NULL|\bCREATE\s+TYPE\b|\bAS\s+ENUM\b|DISABLE\s+ROW|NO\s+FORCE|ALTER\s+TABLE\s+\S+\s+(RENAME|OWNER)/i);
    for (const m of code.matchAll(/ALTER\s+TABLE\s+(frontdesk|billing)\.(orders|order_items|ledger_entries)\b([^;]*);/gi)) {
      for (const add of m[3].split(/,\s*(?=ADD\s)/i)) {
        if (!/ADD\s+COLUMN/i.test(add)) continue;
        expect(add, "ADD COLUMN IF NOT EXISTS").toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i);
        expect(add, `ADD COLUMN must be nullable: ${add.slice(0, 80)}`).not.toMatch(/\bNOT\s+NULL\b/i);
        expect(add, `ADD COLUMN must have no DEFAULT: ${add.slice(0, 80)}`).not.toMatch(/\bDEFAULT\b/i);
      }
    }
  });
  it("adds each new column with ADD COLUMN IF NOT EXISTS on the right table", () => {
    const need: Record<string, string[]> = {
      "frontdesk.orders": [...ORDER_FIELDS.filter((f) => f !== "coupon_code"), "coupon_code", "coupon_amount_paisa"],
      "frontdesk.order_items": ["icd_code"],
      "billing.ledger_entries": ["card_holder_name", "payment_remark"],
    };
    for (const [tbl, cols] of Object.entries(need)) {
      const body = [...code.matchAll(new RegExp(`ALTER\\s+TABLE\\s+${tbl.replace(".", "\\.")}\\b([^;]*);`, "gi"))].map((m) => m[1]).join("\n");
      for (const c of cols) expect(body, `${tbl}.${c}`).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+"?${c}"?\\s`, "i"));
    }
  });
  it("every index is IF NOT EXISTS (tenant_id first) and every ADD CONSTRAINT is guarded", () => {
    for (const m of code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/gi)) throw new Error(`unguarded CREATE INDEX near ${m.index}`);
    for (const m of code.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF NOT EXISTS\s+\S+\s+ON\s+\S+\s*(?:USING\s+\w+\s*)?\(\s*(\w+)/gi)) expect(m[1], `index leads with tenant_id: ${m[0].slice(0, 80)}`).toBe("tenant_id");
    for (const m of code.matchAll(/ADD\s+CONSTRAINT/gi)) {
      const before = code.slice(Math.max(0, m.index! - 600), m.index);
      expect(before, "ADD CONSTRAINT must sit in a DO block that checks pg_constraint first").toMatch(/DO\s+\$[a-z_]*\$[\s\S]*pg_constraint/i);
    }
  });
  it("master and ledger tables get the audit trigger; drafts and favourites are ephemeral (trigger optional, but a drafts trigger must exclude payload)", () => {
    for (const t of ["coupons", "icd_codes", "custom_field_definitions", "reward_points_ledger"])
      expect(code, `audit trigger ${t}`).toMatch(new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?TRIGGER\\s+${t}__audit\\b[^;]*ON frontdesk\\.${t}\\b[^;]*tg_row_audit`, "is"));
    const draftsAudit = code.match(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+\w+\s+[^;]*ON\s+frontdesk\.registration_drafts\b[^;]*tg_row_audit\(([^)]*)\)/is);
    if (draftsAudit) expect(draftsAudit[1], "drafts payload holds patient data (D-27a)").toContain("'payload'");
  });
  it("orders audit trigger is replaced in place (CREATE OR REPLACE, never dropped) and now excludes clinical_history and patient_history (health text, D-27a)", () => {
    const m = code.match(/CREATE\s+OR\s+REPLACE\s+TRIGGER\s+orders__audit\b[^;]*ON\s+frontdesk\.orders\b[^;]*tg_row_audit\(([^)]*)\)/is);
    expect(m, "orders__audit not replaced").not.toBeNull();
    for (const c of ["clinical_history", "patient_history"]) expect(m![1], c).toContain(`'${c}'`);
  });
  it("comments: LD-310, the six tables, down note with DROP, no data rewrite, personal data note, push-cloud founder step, 14 days, no sequences", () => {
    expect(comments).toMatch(/LD-310/);
    expect(comments).toMatch(/\bdown\b/i);
    expect(comments).toMatch(/DROP TABLE/i);
    expect(comments).toMatch(/DROP COLUMN/i);
    for (const t of NEW_TABLES) expect(comments, `down note names ${t}`).toContain(t);
    for (const f of [...ORDER_FIELDS, "coupon_amount_paisa", "icd_code", "card_holder_name", "payment_remark"]) expect(comments, `down note names ${f}`).toContain(f);
    expect(comments).toMatch(/no data rewrite|does not rewrite|no rewrite/i);
    expect(comments).toMatch(/card_holder_name[^\n]*(personal|sensitive)|(personal|sensitive)[^\n]*card_holder_name/i);
    expect(comments).toMatch(/14 days/i);
    expect(comments).toMatch(/push-cloud/i);
    expect(code, "no sequences in frontdesk (05-SCHEMA §9 test 1)").not.toMatch(/CREATE\s+SEQUENCE/i);
    expect(code, "no default on id / tenant_id (UUIDv7 in app code)").not.toMatch(/\b(id|tenant_id)\s+uuid\s+NOT NULL\s+DEFAULT/i);
  });
});

describe("T0C-REGPARITY-2 implementation notes", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  it("state the cloud migration is a founder step (push-cloud), name the file, and list what stays with the founder", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-REGPARITY-2-impl.md missing").toBe(true);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toContain(MIG);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/LD-310/);
  });
  it("record the follow-up for services (T0B-REGAPI-1/2): per-user draft filter, coupon usage race, card holder not logged, custom field validation", () => {
    expect(t).toMatch(/T0B-REGAPI/);
    expect(t).toMatch(/per[- ]user|own drafts|current user/i);
    expect(t).toMatch(/card_holder_name/);
    expect(t).toMatch(/custom_fields/);
  });
});
