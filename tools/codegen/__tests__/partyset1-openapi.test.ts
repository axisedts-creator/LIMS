// T0C-PARTYSET-1 (LD-321, LD-325; founder blanket authority LD-310, priority order 2026-11-17 09:18 NPT, offline 09:19 NPT) — party commercial settings contracts:
// contracts/openapi/partners.yaml (13 additive staff operations under /v1/partners/admin), contracts/openapi/catalog.yaml (5 ICD master operations + doctor fields + masked PAN on credit parties),
// contracts/permissions.yaml + the corp_admin pack (6 new codes), the migration 20261117220000_partners__add_party_settings_and_penalties.sql (static checks; behaviour is
// db/tests/partners/T0C-PARTYSET-1_party_settings.test.sql), generated-client freshness, the pending-operations rule of LD-325(b), the implementer's notes with the FIELD MAP.
// ASSUMPTIONS (the brief gives function names and field labels, not wire names; a different choice needs a ruling, not a silent test edit; same style as T0C-SALES-1 / T0C-ACCT-1):
//  - EVIDENCE: C:/LIMS-state/elabassist-*.md is outside the tester sandbox (read denied), so the FIELD MAP labels below are the labels the BRIEF names; the implementer must map every evidence field.
//  - OPERATION IDS / PATHS: see OPS and ICD_OPS below. All staff, bearerJwt, x-context tenant. Party kinds = the LIMS split model of T0C-SALES-1: partner | credit_party | doctor | referrer.
//    Reads (get/list) of settings use partners.party_setting.read, writes partners.party_setting.manage; the onboarding queue AND its decision use partners.onboarding.decide; every penalty and
//    penalty event operation uses partners.penalty.manage; the ID reveal uses partners.party_id_number.read (the only privileged one, so only it lists auth.mfa_required); the ICD master uses
//    catalog.icd.manage. The brief names no privileged flag except party_id_number.read.
//  - BRIEF CONTRADICTS REPO (lead rules): (1) an ICD master EXISTS (frontdesk.icd_codes with listIcdCodes / createIcdCode / updateIcdCode, T0C-REGPARITY, permission frontdesk.registration.create).
//    Pinned reading = the brief literally: a NEW per tenant master catalog.icd_code (code, title, chapter, is_active) with 5 catalog operations under /v1/catalog/icd-master (distinct operationIds,
//    the frontdesk ones keep working); the notes must say how the two relate. (2) the brief writes "active"; the repo convention is is_active (used here). (3) the brief says partners carry tax_number
//    and national_id_number: the repo has `pan` only on catalog credit parties (kept, masked in reads) and nothing on partners, so partners gain tax_number + national_id_number.
//  - Wire names are snake_case; money is integer paisa (amount_paisa), percent is integer basis points (*_bp). Absent = not set (no `nullable`).
//  - Mutable rows carry `version`; update / deactivate / decide / waive / charge take If-Match and list common.version_conflict + common.precondition_required (02-CONVENTIONS 4.2); the settings PUT takes
//    If-Match OPTIONALLY (the first save has no version): version_conflict yes, precondition_required not pinned. Creates and raise are x-idempotency required.
//  - Rule breaks (bad transition, bad range) answer common.validation_failed or common.version_conflict; NO new error code (errors.yaml == IC section 8).
//  - Search query parameter is `q` (REQ-SEC-098).
//  - LD-325(b): the 13 + 5 new operationIds are in pendingOperations of services/api/src/modules/partners/index.ts and catalog/index.ts; T0B-PARTYSET-1 removes them.
//  - the implementer's notes are .orchestra/notes/T0C-PARTYSET-1-impl.md.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = "20261117220000_partners__add_party_settings_and_penalties.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-PARTYSET-1-impl.md");
const load = (f: string): any => parse(readFileSync(join(ROOT, f), "utf8"));
const P_DOC = load("contracts/openapi/partners.yaml");
const C_DOC = load("contracts/openapi/catalog.yaml");
const common = load("contracts/openapi/_common.yaml");
const registry = load("contracts/permissions.yaml");
const packs = load("services/api/src/modules/identity/role-packs/role-packs.data.yaml");
const METHODS = ["get", "put", "post", "delete", "patch"];
const PFX = "/v1/partners/admin";
const CPFX = "/v1/catalog/icd-master";
const UUID = "0193c4a0-0000-7000-8000-0000000000aa";

type OpSpec = { method: string; path: string; perm: string; idem: "required" | "none" | "any"; ok: string; ifMatch: boolean | "optional"; paged?: boolean };
const SR = "partners.party_setting.read", SM = "partners.party_setting.manage", OD = "partners.onboarding.decide", PM = "partners.penalty.manage", IDR = "partners.party_id_number.read", ICD = "catalog.icd.manage";
const OPS: Record<string, OpSpec> = {
  getPartyCommercialSetting: { method: "get", path: `${PFX}/party-settings/{party_kind}/{party_id}`, perm: SR, idem: "none", ok: "200", ifMatch: false },
  setPartyCommercialSetting: { method: "put", path: `${PFX}/party-settings/{party_kind}/{party_id}`, perm: SM, idem: "any", ok: "200", ifMatch: "optional" },
  listPartyOnboarding: { method: "get", path: `${PFX}/onboarding`, perm: OD, idem: "none", ok: "200", ifMatch: false, paged: true },
  decidePartyOnboarding: { method: "post", path: `${PFX}/onboarding/{onboarding_id}/decision`, perm: OD, idem: "any", ok: "200", ifMatch: true },
  listNonCompliancePenalties: { method: "get", path: `${PFX}/penalties`, perm: PM, idem: "none", ok: "200", ifMatch: false, paged: true },
  createNonCompliancePenalty: { method: "post", path: `${PFX}/penalties`, perm: PM, idem: "required", ok: "201", ifMatch: false },
  updateNonCompliancePenalty: { method: "patch", path: `${PFX}/penalties/{penalty_id}`, perm: PM, idem: "any", ok: "200", ifMatch: true },
  deactivateNonCompliancePenalty: { method: "post", path: `${PFX}/penalties/{penalty_id}/deactivate`, perm: PM, idem: "any", ok: "200", ifMatch: true },
  listNonComplianceEvents: { method: "get", path: `${PFX}/penalty-events`, perm: PM, idem: "none", ok: "200", ifMatch: false, paged: true },
  raiseNonComplianceEvent: { method: "post", path: `${PFX}/penalty-events`, perm: PM, idem: "required", ok: "201", ifMatch: false },
  waiveNonComplianceEvent: { method: "post", path: `${PFX}/penalty-events/{event_id}/waive`, perm: PM, idem: "any", ok: "200", ifMatch: true },
  chargeNonComplianceEvent: { method: "post", path: `${PFX}/penalty-events/{event_id}/charge`, perm: PM, idem: "required", ok: "200", ifMatch: true },
  revealPartyIdNumber: { method: "post", path: `${PFX}/parties/{party_kind}/{party_id}/id-number`, perm: IDR, idem: "any", ok: "200", ifMatch: false },
};
const ICD_OPS: Record<string, OpSpec> = {
  listIcdMasterCodes: { method: "get", path: CPFX, perm: ICD, idem: "none", ok: "200", ifMatch: false, paged: true },
  searchIcdMasterCodes: { method: "get", path: `${CPFX}/search`, perm: ICD, idem: "none", ok: "200", ifMatch: false },
  createIcdMasterCode: { method: "post", path: CPFX, perm: ICD, idem: "required", ok: "201", ifMatch: false },
  updateIcdMasterCode: { method: "patch", path: `${CPFX}/{icd_code_id}`, perm: ICD, idem: "any", ok: "200", ifMatch: true },
  deactivateIcdMasterCode: { method: "post", path: `${CPFX}/{icd_code_id}/deactivate`, perm: ICD, idem: "any", ok: "200", ifMatch: true },
};
const NEW_CODES = [SR, SM, OD, IDR, PM, ICD];
const PARTY_KINDS = ["partner", "credit_party", "doctor", "referrer"];
const MFA = "auth.mfa_required";
const ERRORS = new Set<string>(load("contracts/errors.yaml").map((x: any) => x.code));

const opIn = (doc: any, id: string): { method: string; path: string; op: any } | undefined => {
  for (const [path, item] of Object.entries<any>(doc.paths)) for (const m of METHODS) if (item[m]?.operationId === id) return { method: m, path, op: item[m] };
  return undefined;
};
const idsOf = (doc: any): string[] => Object.values<any>(doc.paths).flatMap((item) => METHODS.filter((m) => item[m]).map((m) => item[m].operationId as string));
const deref = (doc: any, s: any): any => {
  if (!s?.$ref) return s;
  const [file, ptr] = String(s.$ref).split("#");
  const root = file === "_common.yaml" ? common : doc;
  return deref(root === common ? common : doc, ptr.split("/").slice(1).reduce((a: any, k: string) => a?.[k], root));
};
const sortedEq = (a: string[], b: string[]) => expect([...a].sort()).toEqual([...b].sort());
const reqSchema = (doc: any, id: string, o = opIn(doc, id)!): any => deref(doc, o.op.requestBody?.content?.["application/json"]?.schema);
const okSchema = (doc: any, id: string, o = opIn(doc, id)!): any => {
  const code = Object.keys(o.op.responses).find((c) => /^2/.test(c))!;
  return deref(doc, o.op.responses[code]?.content?.["application/json"]?.schema);
};
const itemSchema = (doc: any, id: string): any => deref(doc, okSchema(doc, id).properties.data.items);
const props = (s: any): Record<string, any> => s?.properties ?? {};
/** properties of a schema including its allOf parts (refs resolved) */
const allProps = (doc: any, s: any): Record<string, any> => {
  const n = deref(doc, s);
  return { ...props(n), ...Object.assign({}, ...(n?.allOf ?? []).map((p: any) => allProps(doc, p))) };
};
const paramNames = (doc: any, op: any): string[] => (op.parameters ?? []).map((p: any) => deref(doc, p).name);
const paramOf = (doc: any, op: any, name: string): any => (op.parameters ?? []).map((p: any) => deref(doc, p)).find((p: any) => p.name === name);
const enumOf = (p: any): string[] => ((p?.enum ?? []) as unknown[]).filter((x): x is string => typeof x === "string");
const walk = (doc: any, s: any, fn: (n: any) => void, seen = new Set<any>()): void => {
  const n = deref(doc, s);
  if (!n || typeof n !== "object" || seen.has(n)) return;
  seen.add(n);
  fn(n);
  for (const v of Object.values<any>(n.properties ?? {})) walk(doc, v, fn, seen);
  if (n.items) walk(doc, n.items, fn, seen);
  for (const k of ["allOf", "oneOf", "anyOf"]) for (const v of n[k] ?? []) walk(doc, v, fn, seen);
  if (n.additionalProperties && typeof n.additionalProperties === "object") walk(doc, n.additionalProperties, fn, seen);
};
const jsonMedia = (op: any): any[] => [op.requestBody?.content?.["application/json"], ...Object.values<any>(op.responses).filter((r) => !r.$ref).map((r) => r.content?.["application/json"])].filter(Boolean);

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ ...common, id: "_common.yaml" });
ajv.addSchema({ ...P_DOC, id: "partners.yaml" });
ajv.addSchema({ ...C_DOC, id: "catalog.yaml" });
const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const validatorFor = (file: string, doc: any, id: string, where: "req" | string) => {
  const o = opIn(doc, id)!;
  const ptr = where === "req" ? `/paths/${esc(o.path)}/${o.method}/requestBody/content/application~1json/schema` : `/paths/${esc(o.path)}/${o.method}/responses/${where}/content/application~1json/schema`;
  const v = ajv.getSchema(`${file}#${ptr}`);
  expect(v, `cannot resolve ${id} ${where}`).toBeDefined();
  return v!;
};
const SETTING_FIELDS = ["auto_release_reports", "whatsapp_enabled", "insurance_enabled", "print_exception", "lab_number_scheme_code", "billing_cycle", "invoice_payment_days", "invoice_blocking_days",
  "invoice_warning_days", "interest_bp_per_day", "priority", "header_footer_mode", "commission_bp", "tds_bp", "auto_block_overdue"];
const MASKED = /^\*+[A-Za-z0-9]{0,4}$/;

describe("T0C-PARTYSET-1 lint and additive baseline", () => {
  it("lintRepo reports no violation for partners.yaml, catalog.yaml or frontdesk.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => ["partners.yaml", "catalog.yaml", "frontdesk.yaml"].includes(x.file));
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });
  it("partners.yaml is additive: the original operations stay, the 13 new ones exist, ids are unique across all specs", () => {
    const ids = idsOf(P_DOC);
    expect(new Set(ids).size, "duplicate operationId in partners.yaml").toBe(ids.length);
    for (const id of ["listPartners", "createPartner", "getPartner", "updatePartner", "suspendPartner", "createManifest", "mapPartnerReferrer", "getPartnerSettings", "updatePartnerSettings", "listSalesRepresentatives", "createPartnerTicket"])
      expect(opIn(P_DOC, id), id).toBeDefined();
    expect(opIn(P_DOC, "suspendPartner")!.op["x-permission"]).toBe("partners.partner.manage");
    for (const id of Object.keys(OPS)) expect(opIn(P_DOC, id), `${id} missing`).toBeDefined();
    const all = readdirSync(join(ROOT, "contracts/openapi")).filter((f) => f.endsWith(".yaml") && !f.startsWith("_")).flatMap((f) => idsOf(load(`contracts/openapi/${f}`)));
    for (const id of [...Object.keys(OPS), ...Object.keys(ICD_OPS)]) expect(all.filter((x) => x === id), `${id} must be unique across every contracts/openapi file`).toHaveLength(1);
  });
  it("catalog.yaml is additive: the original operations stay (createDoctor, listDoctors, credit parties, price lists), the 5 ICD master operations exist, frontdesk ICD operations untouched", () => {
    const ids = idsOf(C_DOC);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["createDoctor", "listDoctors", "getDoctor", "updateDoctor", "createCreditParty", "getCreditParty", "updateCreditParty", "listCreditParties", "listPriceLists"]) expect(opIn(C_DOC, id), id).toBeDefined();
    expect(opIn(C_DOC, "createDoctor")!.op["x-permission"]).toBe("catalog.referrer.manage");
    for (const id of Object.keys(ICD_OPS)) expect(opIn(C_DOC, id), `${id} missing`).toBeDefined();
    const F = load("contracts/openapi/frontdesk.yaml");
    expect(opIn(F, "listIcdCodes")!.path).toBe("/v1/frontdesk/icd-codes");
    expect(opIn(F, "createIcdCode")!.op["x-permission"]).toBe("frontdesk.settings.manage");
    expect(opIn(F, "listIcdCodes")!.op["x-permission"]).toBe("frontdesk.registration.create");
  });
});

for (const [label, file, doc, table, tag] of [["partners", "partners.yaml", P_DOC, OPS, "partners"], ["catalog ICD master", "catalog.yaml", C_DOC, ICD_OPS, "catalog"]] as const) {
  describe(`T0C-PARTYSET-1 ${label}: operation table (done_when 5, 6, 7)`, () => {
    for (const [id, s] of Object.entries(table)) {
      describe(id, () => {
        const o = opIn(doc, id);
        const privileged = Boolean((registry.permissions as any[]).find((p) => p.code === s.perm)?.privileged);
        it(`${s.method.toUpperCase()} ${s.path}, permission ${s.perm}, tag ${tag}, bearerJwt, tenant context`, () => {
          expect(o, `${id} missing`).toBeDefined();
          expect(o!.method).toBe(s.method);
          expect(o!.path).toBe(s.path);
          expect(o!.op["x-permission"]).toBe(s.perm);
          expect(o!.op.tags).toEqual([tag]);
          expect(o!.op.security).toEqual([{ bearerJwt: [] }]);
          expect(o!.op["x-context"]).toBe("tenant");
          expect(o!.op["x-public"]).toBeUndefined();
          expect(o!.op["x-rate-limit-tier"]).toBeDefined();
        });
        it("error codes: five common, not_found with a path id, If-Match pair, mfa only on the privileged code, invalid_cursor on lists; every code is registered (no new error code)", () => {
          const e: string[] = o?.op["x-error-codes"] ?? [];
          for (const c of ["common.validation_failed", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"]) expect(e, c).toContain(c);
          if (/\{/.test(s.path)) expect(e).toContain("common.not_found");
          if (s.ifMatch === true) for (const c of ["common.version_conflict", "common.precondition_required"]) expect(e, c).toContain(c);
          if (s.ifMatch === "optional") expect(e).toContain("common.version_conflict");
          if (s.ifMatch === false) expect(e).not.toContain("common.precondition_required");
          if (privileged) expect(e).toContain(MFA); else expect(e).not.toContain(MFA);
          if (s.paged) expect(e).toContain("common.invalid_cursor");
          for (const c of e) expect(ERRORS.has(c), `${c} not in contracts/errors.yaml (no new error code allowed)`).toBe(true);
        });
        it("idempotency and If-Match headers", () => {
          const names = paramNames(doc, o?.op ?? {});
          if (s.idem === "required") { expect(o!.op["x-idempotency"]).toBe("required"); expect(names).toContain("Idempotency-Key"); }
          if (s.idem === "none") expect(o!.op["x-idempotency"]).toBe("none");
          expect(names.includes("If-Match"), "If-Match").toBe(s.ifMatch !== false);
        });
        it(`success ${s.ok}, JSON body with at least one example, standard error responses`, () => {
          const r = o?.op.responses ?? {};
          expect(Object.keys(r).filter((c) => /^2/.test(c))).toEqual([s.ok]);
          const j = r[s.ok]?.content?.["application/json"];
          expect(j, "JSON 2xx").toBeDefined();
          expect(Object.keys(j.examples ?? {}).length, "example").toBeGreaterThan(0);
          for (const c of ["400", "401", "403", "429", "500"]) expect(r[c], c).toBeDefined();
        });
        it("every object schema reachable from the request and response is closed; no float, no nullable; no tenant_id / created_by / server field in a request", () => {
          for (const m of jsonMedia(o!.op)) walk(doc, m.schema, (n) => {
            if (n.type === "object" || n.properties) expect(n.additionalProperties, JSON.stringify(Object.keys(n.properties ?? {})).slice(0, 80)).toBe(false);
            expect(n.type, "money and counts are integers, never number").not.toBe("number");
            expect(n.nullable, "no nullable: absent means not set").not.toBe(true);
          });
          walk(doc, o!.op.requestBody?.content?.["application/json"]?.schema, (n) => {
            for (const f of ["tenant_id", "created_by", "updated_by", "decided_by", "decided_at", "created_at", "updated_at", "version", "id", "ledger_entry_id"]) expect(Object.keys(n.properties ?? {}), `request names ${f}`).not.toContain(f);
          });
        });
        if (s.paged) it("is paged: Cursor + Limit parameters, {data (maxItems <= 200), page: PageInfo}", () => {
          const names = (o!.op.parameters as any[]).map((p) => p.$ref ?? p.name);
          expect(names).toEqual(expect.arrayContaining(["_common.yaml#/components/parameters/Cursor", "_common.yaml#/components/parameters/Limit"]));
          const ok = okSchema(doc, id);
          sortedEq(ok.required, ["data", "page"]);
          expect(ok.properties.data.maxItems).toBeLessThanOrEqual(200);
          expect(JSON.stringify(ok.properties.page)).toContain("PageInfo");
        });
      });
    }
  });
}

describe("T0C-PARTYSET-1 shapes: party commercial settings (done_when 2, 5)", () => {
  const S = (id: string) => ({ ...allProps(P_DOC, id === "set" ? reqSchema(P_DOC, "setPartyCommercialSetting") : okSchema(P_DOC, "getPartyCommercialSetting")) });
  it("get response carries party_kind, party_id, all 15 settings and version; ranges 0..365 days, 0..10000 bp, priority P1..P5, billing cycle, header_footer_mode; tds_bp defaults to 0", () => {
    const r = okSchema(P_DOC, "getPartyCommercialSetting");
    const p = S("get");
    for (const f of ["party_kind", "party_id", "version", ...SETTING_FIELDS]) expect(p[f], `response.${f}`).toBeDefined();
    expect(r.required).toEqual(expect.arrayContaining(["party_kind", "party_id", "version", "billing_cycle", "priority", "header_footer_mode", "commission_bp", "tds_bp"]));
    expect(r.required, "lab_number_scheme_code is optional").not.toContain("lab_number_scheme_code");
    sortedEq(enumOf(p.party_kind), PARTY_KINDS);
    sortedEq(enumOf(p.billing_cycle), ["daily", "weekly", "fortnightly", "monthly", "quarterly"]);
    sortedEq(enumOf(p.priority), ["P1", "P2", "P3", "P4", "P5"]);
    sortedEq(enumOf(p.header_footer_mode), ["with", "without", "both"]);
    for (const f of ["invoice_payment_days", "invoice_blocking_days", "invoice_warning_days"]) expect(p[f], f).toMatchObject({ type: "integer", minimum: 0, maximum: 365 });
    for (const f of ["interest_bp_per_day", "commission_bp", "tds_bp"]) expect(p[f], f).toMatchObject({ type: "integer", minimum: 0, maximum: 10000 });
    expect(p.tds_bp.default).toBe(0);
    for (const f of ["auto_release_reports", "whatsapp_enabled", "insurance_enabled", "print_exception", "auto_block_overdue"]) expect(p[f].type, f).toBe("boolean");
    expect(p.lab_number_scheme_code.maxLength).toBeLessThanOrEqual(20);
    expect(String(opIn(P_DOC, "getPartyCommercialSetting")!.op.description ?? ""), "description says what an unsaved party returns").toMatch(/default|not (yet )?(set|saved|configured)/i);
  });
  it("set request: the 15 settings are optional fields (omitted = unchanged / default), same ranges, closed, no party fields in the body", () => {
    const b = reqSchema(P_DOC, "setPartyCommercialSetting");
    const p = S("set");
    expect(b.additionalProperties).toBe(false);
    for (const f of SETTING_FIELDS) expect(p[f], `request.${f}`).toBeDefined();
    for (const f of ["party_kind", "party_id", "version"]) expect(p[f], `${f} is a path or header, not a body field`).toBeUndefined();
    expect(p.billing_cycle.enum).toEqual(expect.arrayContaining(["daily", "quarterly"]));
    for (const f of ["invoice_payment_days", "invoice_blocking_days", "invoice_warning_days"]) expect(p[f], f).toMatchObject({ type: "integer", minimum: 0, maximum: 365 });
    for (const f of ["interest_bp_per_day", "commission_bp", "tds_bp"]) expect(p[f], f).toMatchObject({ type: "integer", minimum: 0, maximum: 10000 });
    expect(String(opIn(P_DOC, "setPartyCommercialSetting")!.op.description ?? "")).toMatch(/interest/i);
  });
  it("payloads: in range accepted; 366 days, 10001 bp, -1, 1.5, P6, quarterly typo, string number, unknown and server fields rejected", () => {
    const v = validatorFor("partners.yaml", P_DOC, "setPartyCommercialSetting", "req");
    const ok = { auto_release_reports: true, whatsapp_enabled: false, insurance_enabled: false, print_exception: true, lab_number_scheme_code: "KTM_A", billing_cycle: "monthly", invoice_payment_days: 30,
      invoice_blocking_days: 60, invoice_warning_days: 45, interest_bp_per_day: 5, priority: "P2", header_footer_mode: "both", commission_bp: 1250, tds_bp: 100, auto_block_overdue: true };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({}), "an empty body is valid (nothing changes)").toBe(true);
    expect(v({ invoice_payment_days: 0, invoice_blocking_days: 365, interest_bp_per_day: 10000, commission_bp: 0 })).toBe(true);
    for (const bad of [{ invoice_payment_days: 366 }, { invoice_blocking_days: -1 }, { invoice_warning_days: 1.5 }, { interest_bp_per_day: 10001 }, { commission_bp: 10001 }, { tds_bp: -1 }, { tds_bp: "100" },
      { priority: "P6" }, { priority: "p1" }, { billing_cycle: "quaterly" }, { billing_cycle: "yearly" }, { header_footer_mode: "neither" }, { lab_number_scheme_code: "bad code!" }, { auto_release_reports: "yes" },
      { unknown_field: 1 }, { tenant_id: UUID }, { party_id: UUID }])
      expect(v({ ...ok, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });
  it("path party_kind is the four kinds; set takes If-Match as an optional header; examples use synthetic values", () => {
    const o = opIn(P_DOC, "setPartyCommercialSetting")!.op;
    sortedEq(enumOf(deref(P_DOC, paramOf(P_DOC, o, "party_kind")).schema), PARTY_KINDS);
    expect(paramOf(P_DOC, o, "party_id")?.in).toBe("path");
    expect(paramOf(P_DOC, o, "If-Match")?.required, "first save has no version").not.toBe(true);
  });
});

describe("T0C-PARTYSET-1 shapes: onboarding approval queue (done_when 2, 5)", () => {
  it("row: id, party_kind, party_id, status (pending | approved | held | rejected), reason?, decided_by?, decided_at?, version, created_at; filters status, party_kind, q", () => {
    const row = itemSchema(P_DOC, "listPartyOnboarding");
    for (const f of ["id", "party_kind", "party_id", "party_name", "status", "reason", "decided_by", "decided_at", "version", "created_at"]) expect(props(row)[f], `row.${f}`).toBeDefined();
    expect(row.required).toEqual(expect.arrayContaining(["id", "party_kind", "party_id", "status", "version"]));
    for (const f of ["reason", "decided_by", "decided_at"]) expect(row.required, f).not.toContain(f);
    sortedEq(enumOf(props(row).status), ["pending", "approved", "held", "rejected"]);
    sortedEq(enumOf(props(row).party_kind), PARTY_KINDS);
    const names = paramNames(P_DOC, opIn(P_DOC, "listPartyOnboarding")!.op);
    for (const n of ["status", "party_kind", "q"]) expect(names, n).toContain(n);
    sortedEq(enumOf(paramOf(P_DOC, opIn(P_DOC, "listPartyOnboarding")!.op, "status").schema), ["pending", "approved", "held", "rejected"]);
  });
  it("decide: {decision approve | hold | reject (required), reason (1..500)}; answers the row; description says hold and reject need a reason and which moves are allowed", () => {
    const b = reqSchema(P_DOC, "decidePartyOnboarding");
    expect(b.required).toContain("decision");
    sortedEq(enumOf(props(b).decision), ["approve", "hold", "reject"]);
    expect(props(b).reason).toMatchObject({ type: "string", minLength: 1 });
    expect(props(b).reason.maxLength).toBeLessThanOrEqual(500);
    const d = String(opIn(P_DOC, "decidePartyOnboarding")!.op.description ?? "");
    expect(d).toMatch(/reason/i);
    expect(d).toMatch(/pending/i);
    expect(d).toMatch(/held|hold/i);
    expect(JSON.stringify(okSchema(P_DOC, "decidePartyOnboarding"))).toContain("status");
    const v = validatorFor("partners.yaml", P_DOC, "decidePartyOnboarding", "req");
    for (const d2 of ["approve", "hold", "reject"]) expect(v({ decision: d2, reason: "Synthetic reason" }), d2).toBe(true);
    expect(v({ decision: "approve" })).toBe(true);
    for (const bad of [{ decision: "maybe" }, { decision: "approved" }, { decision: "hold", reason: "" }, { decision: "hold", reason: "x".repeat(501) }, { decision: "hold", status: "held" }, {}])
      expect(v(bad), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });
});

describe("T0C-PARTYSET-1 shapes: non compliance penalties and events (done_when 2, 5)", () => {
  it("Penalty row: id, code, name, amount_paisa (integer >= 0), is_active, version, timestamps; create needs code + name + amount_paisa; update changes name and amount", () => {
    const row = itemSchema(P_DOC, "listNonCompliancePenalties");
    for (const f of ["id", "code", "name", "amount_paisa", "is_active", "version", "created_at", "updated_at"]) expect(props(row)[f], `row.${f}`).toBeDefined();
    expect(row.required).toEqual(expect.arrayContaining(["id", "code", "name", "amount_paisa", "is_active", "version"]));
    expect(props(row).amount_paisa).toMatchObject({ type: "integer", minimum: 0 });
    const c = reqSchema(P_DOC, "createNonCompliancePenalty");
    sortedEq(c.required, ["code", "name", "amount_paisa"]);
    expect(props(c).code.maxLength).toBeLessThanOrEqual(20);
    expect(props(c).name.maxLength).toBeLessThanOrEqual(120);
    const u = reqSchema(P_DOC, "updateNonCompliancePenalty");
    expect(u.required ?? []).toEqual([]);
    expect(u.minProperties).toBeGreaterThanOrEqual(1);
    for (const f of ["name", "amount_paisa"]) expect(props(u)[f], `update.${f}`).toBeDefined();
    const names = paramNames(P_DOC, opIn(P_DOC, "listNonCompliancePenalties")!.op);
    for (const n of ["is_active", "q"]) expect(names, n).toContain(n);
  });
  it("penalty payloads: valid; negative, fractional, string, empty code, lower case code and unknown fields rejected", () => {
    const v = validatorFor("partners.yaml", P_DOC, "createNonCompliancePenalty", "req");
    expect(v({ code: "LATE_SAMPLE", name: "Late sample (synthetic)", amount_paisa: 50000 }), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ amount_paisa: -1 }, { amount_paisa: 10.5 }, { amount_paisa: "500" }, { code: "" }, { code: "late sample" }, { name: "" }, { unknown_field: 1 }, { tenant_id: UUID }])
      expect(v({ code: "LATE", name: "Late", amount_paisa: 100, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    expect(v({ code: "LATE", name: "Late" })).toBe(false);
    const u = validatorFor("partners.yaml", P_DOC, "updateNonCompliancePenalty", "req");
    expect(u({ amount_paisa: 0 })).toBe(true);
    expect(u({})).toBe(false);
  });
  it("Event row: id, party_kind, party_id, penalty_id, event_date, amount_paisa, reason?, status (raised | waived | charged), ledger_entry_id?, decided_by?, version; filters", () => {
    const row = itemSchema(P_DOC, "listNonComplianceEvents");
    for (const f of ["id", "party_kind", "party_id", "penalty_id", "event_date", "amount_paisa", "reason", "status", "ledger_entry_id", "decided_by", "version", "created_at"]) expect(props(row)[f], `row.${f}`).toBeDefined();
    expect(row.required).toEqual(expect.arrayContaining(["id", "party_kind", "party_id", "penalty_id", "event_date", "amount_paisa", "status", "version"]));
    for (const f of ["reason", "ledger_entry_id", "decided_by"]) expect(row.required, f).not.toContain(f);
    sortedEq(enumOf(props(row).status), ["raised", "waived", "charged"]);
    expect(props(row).amount_paisa.type).toBe("integer");
    expect(JSON.stringify(props(row).event_date)).toContain("IsoDate");
    const names = paramNames(P_DOC, opIn(P_DOC, "listNonComplianceEvents")!.op);
    for (const n of ["party_kind", "party_id", "penalty_id", "status", "from_date", "to_date"]) expect(names, n).toContain(n);
  });
  it("raise: party_kind, party_id, penalty_id, event_date required; amount_paisa (default: the penalty amount) and reason optional; payloads", () => {
    const c = reqSchema(P_DOC, "raiseNonComplianceEvent");
    sortedEq(c.required, ["party_kind", "party_id", "penalty_id", "event_date"]);
    sortedEq(enumOf(props(c).party_kind), PARTY_KINDS);
    expect(props(c).amount_paisa).toMatchObject({ type: "integer", minimum: 0 });
    expect(props(c).reason.maxLength).toBeLessThanOrEqual(500);
    const v = validatorFor("partners.yaml", P_DOC, "raiseNonComplianceEvent", "req");
    const ok = { party_kind: "partner", party_id: UUID, penalty_id: UUID, event_date: "2026-11-17" };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ ...ok, amount_paisa: 25000, reason: "Synthetic: sample arrived late" })).toBe(true);
    for (const bad of [{ party_kind: "franchise" }, { party_id: "x" }, { penalty_id: "x" }, { event_date: "17-11-2026" }, { amount_paisa: -5 }, { status: "charged" }, { ledger_entry_id: UUID }])
      expect(v({ ...ok, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });
  it("waive needs a reason; charge takes no required body, answers the event with ledger_entry_id, and says it is charged once (idempotent, one ledger entry)", () => {
    const w = reqSchema(P_DOC, "waiveNonComplianceEvent");
    expect(w.required).toContain("reason");
    expect(props(w).reason).toMatchObject({ type: "string", minLength: 1 });
    const o = opIn(P_DOC, "chargeNonComplianceEvent")!;
    if (o.op.requestBody) { expect(o.op.requestBody.required).not.toBe(true); expect(reqSchema(P_DOC, "chargeNonComplianceEvent").additionalProperties).toBe(false); }
    const ok = okSchema(P_DOC, "chargeNonComplianceEvent");
    for (const f of ["id", "status", "ledger_entry_id", "amount_paisa", "version"]) expect(props(ok)[f], `charge response.${f}`).toBeDefined();
    expect(String(o.op.description ?? ""), "charge description").toMatch(/once|exactly one|single ledger/i);
    expect(String(o.op.description ?? "")).toMatch(/ledger/i);
    expect(String(o.op.description ?? "")).toMatch(/raised/i);
    expect(String(opIn(P_DOC, "waiveNonComplianceEvent")!.op.description ?? "")).toMatch(/raised/i);
  });
});

describe("T0C-PARTYSET-1 government ID numbers: masked reads, privileged reveal (done_when 3)", () => {
  it("revealPartyIdNumber: body {field: tax_number | national_id_number}, response {party_kind, party_id, field, value}; description says audit and the permission; privileged code", () => {
    const b = reqSchema(P_DOC, "revealPartyIdNumber");
    sortedEq(b.required, ["field"]);
    sortedEq(enumOf(props(b).field), ["tax_number", "national_id_number"]);
    const ok = okSchema(P_DOC, "revealPartyIdNumber");
    for (const f of ["party_kind", "party_id", "field", "value"]) expect(props(ok)[f], `response.${f}`).toBeDefined();
    expect(props(ok).value.maxLength).toBeLessThanOrEqual(64);
    const d = String(opIn(P_DOC, "revealPartyIdNumber")!.op.description ?? "");
    expect(d).toMatch(/audit/i);
    expect(d).toMatch(/partners\.party_id_number\.read/);
    expect(d).toMatch(/online|not (cached|stored)|never cached/i);
    sortedEq(enumOf(deref(P_DOC, paramOf(P_DOC, opIn(P_DOC, "revealPartyIdNumber")!.op, "party_kind")).schema), PARTY_KINDS);
    const v = validatorFor("partners.yaml", P_DOC, "revealPartyIdNumber", "req");
    expect(v({ field: "tax_number" })).toBe(true);
    for (const bad of [{ field: "pan" }, {}, { field: "tax_number", value: "x" }]) expect(v(bad), JSON.stringify(bad)).toBe(false);
    // the reveal response example is the only place a full value may appear: it is synthetic
    expect(JSON.stringify(opIn(P_DOC, "revealPartyIdNumber")!.op.responses["200"])).toMatch(/synthetic|0000|XXXX/i);
  });
  const MASK_DESC = /mask/i;
  it("partners: createPartner / updatePartner accept tax_number and national_id_number (<= 32 chars, optional); getPartner and the create response show them masked", () => {
    for (const id of ["createPartner", "updatePartner"]) {
      const b = allProps(P_DOC, reqSchema(P_DOC, id));
      for (const f of ["tax_number", "national_id_number"]) {
        expect(b[f], `${id}.${f}`).toBeDefined();
        expect(b[f].type).toBe("string");
        expect(b[f].maxLength, `${id}.${f} maxLength`).toBeLessThanOrEqual(32);
      }
      expect(reqSchema(P_DOC, id).required ?? [], `${id}: ID numbers are optional`).not.toEqual(expect.arrayContaining(["tax_number"]));
    }
    for (const id of ["getPartner", "createPartner", "updatePartner"]) {
      const r = allProps(P_DOC, okSchema(P_DOC, id));
      for (const f of ["tax_number", "national_id_number"]) {
        expect(r[f], `${id} response ${f}`).toBeDefined();
        expect(String(r[f].description ?? ""), `${id} ${f} description must say masked, last four`).toMatch(MASK_DESC);
        expect(String(r[f].description ?? "")).toMatch(/partners\.party_id_number\.read/);
        expect(r[f].maxLength).toBeLessThanOrEqual(64);
      }
    }
    const list = allProps(P_DOC, itemSchema(P_DOC, "listPartners"));
    for (const f of ["tax_number", "national_id_number"]) if (list[f]) expect(String(list[f].description ?? ""), `list ${f}`).toMatch(MASK_DESC);
  });
  it("doctors: createDoctor and updateDoctor accept national_id_number; getDoctor / createDoctor / updateDoctor responses show it masked", () => {
    for (const id of ["createDoctor", "updateDoctor"]) {
      const b = allProps(C_DOC, reqSchema(C_DOC, id));
      expect(b.national_id_number, `${id}.national_id_number`).toBeDefined();
      expect(b.national_id_number.maxLength).toBeLessThanOrEqual(32);
    }
    for (const id of ["getDoctor", "createDoctor", "updateDoctor"]) {
      const r = allProps(C_DOC, okSchema(C_DOC, id));
      expect(r.national_id_number, `${id} response`).toBeDefined();
      expect(String(r.national_id_number.description ?? "")).toMatch(MASK_DESC);
      expect(String(r.national_id_number.description ?? "")).toMatch(/partners\.party_id_number\.read/);
    }
    const sum = allProps(C_DOC, "DoctorSummary" in (C_DOC.components?.schemas ?? {}) ? C_DOC.components.schemas.DoctorSummary : {});
    expect(sum.national_id_number, "the summary used by search and pickers never carries an ID number").toBeUndefined();
  });
  it("credit parties: pan stays (never renamed) but every read shows it masked; the examples of the four credit party reads are masked", () => {
    for (const id of ["getCreditParty", "createCreditParty", "updateCreditParty"]) {
      const r = allProps(C_DOC, okSchema(C_DOC, id));
      expect(r.pan, `${id} response pan`).toBeDefined();
      expect(String(r.pan.description ?? ""), `${id} pan description`).toMatch(MASK_DESC);
      expect(String(r.pan.description ?? "")).toMatch(/partners\.party_id_number\.read/);
    }
    for (const id of ["getCreditParty", "createCreditParty", "updateCreditParty", "listCreditParties"]) {
      const o = opIn(C_DOC, id)!;
      const code = Object.keys(o.op.responses).find((c) => /^2/.test(c))!;
      for (const e of Object.values<any>(o.op.responses[code].content["application/json"].examples ?? {})) {
        const rows: any[] = e.value?.data ?? [e.value];
        for (const row of rows) if (row?.pan !== undefined) expect(String(row.pan), `${id} example pan must be masked, last four only`).toMatch(MASKED);
      }
    }
    expect(props(reqSchema(C_DOC, "createCreditParty")).pan, "requests keep taking the full value").toBeDefined();
  });
  it("masked fields never leak through other doctor and partner read shapes: DoctorSummary, PartnerAdminSummary", () => {
    for (const [doc, name] of [[C_DOC, "DoctorSummary"], [P_DOC, "PartnerAdminSummary"]] as const) {
      const s = allProps(doc, doc.components.schemas[name]);
      for (const f of ["tax_number", "national_id_number", "pan"]) if (s[f]) expect(String(s[f].description ?? ""), `${name}.${f}`).toMatch(MASK_DESC);
    }
  });
});

describe("T0C-PARTYSET-1 shapes: doctor master parity (done_when 4)", () => {
  const NEWF = ["speciality", "hospital", "national_id_number"];
  it("DoctorCreate and DoctorUpdate gain speciality, hospital, national_id_number as optional fields; nothing existing is required or removed", () => {
    for (const id of ["createDoctor", "updateDoctor"]) {
      const s = reqSchema(C_DOC, id);
      const p = allProps(C_DOC, s);
      expect(s.additionalProperties).toBe(false);
      for (const f of NEWF) { expect(p[f], `${id}.${f}`).toBeDefined(); expect(s.required ?? [], `${id}: ${f} optional`).not.toContain(f); }
      for (const f of ["qualification", "registration_council", "registration_no", "phone_e164", "email", "notes"]) expect(p[f], `${id}.${f} still present`).toBeDefined();
      expect(p.speciality).toMatchObject({ type: "string" });
      expect(p.speciality.maxLength).toBeLessThanOrEqual(120);
      expect(p.hospital.maxLength).toBeLessThanOrEqual(200);
    }
    expect(reqSchema(C_DOC, "createDoctor").required).toEqual(["display_name"]);
  });
  it("Doctor and DoctorCreated responses carry speciality, hospital, national_id_number (not required)", () => {
    for (const id of ["getDoctor", "createDoctor", "updateDoctor"]) {
      const s = okSchema(C_DOC, id);
      const p = allProps(C_DOC, s);
      for (const f of NEWF) { expect(p[f], `${id} response ${f}`).toBeDefined(); expect(s.required ?? [], f).not.toContain(f); }
    }
    expect(allProps(C_DOC, C_DOC.components.schemas.Doctor).speciality).toBeDefined();
  });
  it("payloads: valid doctor with the new fields; 33 char ID, oversize speciality and hospital rejected; a rate field is refused (LD-385)", () => {
    const v = validatorFor("catalog.yaml", C_DOC, "createDoctor", "req");
    const ok = { display_name: "Synthetic Doctor", speciality: "Pathology (synthetic)", hospital: "Synthetic Hospital", national_id_number: "SYN-NID-0001", qualification: "MD (synthetic)", registration_no: "SYN-1" };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ commission_bp: 1500 }, { national_id_number: "N".repeat(33) }, { speciality: "s".repeat(121) }, { hospital: "h".repeat(201) }])
      expect(v({ ...ok, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    const u = validatorFor("catalog.yaml", C_DOC, "updateDoctor", "req");
    expect(u({ speciality: "Pathology (synthetic)" })).toBe(true);
    expect(u({ commission_bp: 0 }), "closed schema: no doctor rate on update").toBe(false);
  });
  it("LD-385: Doctor, DoctorCreate, DoctorUpdate, DoctorSummary (and DoctorCreated if present) have no commission-like property (C3 AC-11.5); the rate lives in partners party settings only", () => {
    for (const n of ["Doctor", "DoctorCreate", "DoctorUpdate", "DoctorSummary", "DoctorCreated"]) {
      const sc = C_DOC.components.schemas[n];
      if (!sc) { expect(n, "only DoctorCreated may be absent").toBe("DoctorCreated"); continue; }
      expect(Object.keys(allProps(C_DOC, sc)).filter((k) => /commission/i.test(k)), `${n} must have no commission like property`).toEqual([]);
    }
    for (const id of ["createDoctor", "updateDoctor", "getDoctor"]) {
      const names = Object.keys(allProps(C_DOC, id === "getDoctor" ? okSchema(C_DOC, id) : reqSchema(C_DOC, id)));
      expect(names.filter((k) => /commission/i.test(k)), id).toEqual([]);
    }
  });
});

describe("T0C-PARTYSET-1 shapes: ICD master (done_when 2, 5)", () => {
  it("row: id, code (upper case pattern, <= 16), title (1..500), chapter?, is_active, version, timestamps; create needs code + title", () => {
    const row = itemSchema(C_DOC, "listIcdMasterCodes");
    for (const f of ["id", "code", "title", "chapter", "is_active", "version", "created_at", "updated_at"]) expect(props(row)[f], `row.${f}`).toBeDefined();
    expect(row.required).toEqual(expect.arrayContaining(["id", "code", "title", "is_active", "version"]));
    expect(row.required).not.toContain("chapter");
    expect(props(row).code.maxLength).toBeLessThanOrEqual(16);
    expect(props(row).title.maxLength).toBeLessThanOrEqual(500);
    const c = reqSchema(C_DOC, "createIcdMasterCode");
    sortedEq(c.required, ["code", "title"]);
    const names = paramNames(C_DOC, opIn(C_DOC, "listIcdMasterCodes")!.op);
    for (const n of ["q", "chapter", "is_active"]) expect(names, n).toContain(n);
  });
  it("payloads: A09 and E11.9 accepted; lower case, empty, 17 chars, bad characters and unknown fields rejected; update needs a field and cannot send code", () => {
    const v = validatorFor("catalog.yaml", C_DOC, "createIcdMasterCode", "req");
    for (const code of ["A09", "E11.9", "J18.9"]) expect(v({ code, title: "Synthetic: diagnosis", chapter: "Chapter I (synthetic)" }), code).toBe(true);
    for (const bad of [{ code: "a09" }, { code: "" }, { code: "A".repeat(17) }, { code: "A 09" }, { code: "A09;--" }, { title: "" }, { title: "t".repeat(501) }, { unknown_field: 1 }])
      expect(v({ code: "A09", title: "Synthetic", ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    const u = reqSchema(C_DOC, "updateIcdMasterCode");
    expect(u.minProperties).toBeGreaterThanOrEqual(1);
    expect(props(u).code, "a code is never renamed").toBeUndefined();
    for (const f of ["title", "chapter"]) expect(props(u)[f], `update.${f}`).toBeDefined();
  });
  it("search: q required (1..64), limit 1..50 default 20, answers {data (maxItems <= 50)} without paging; description says it matches code prefix and title words and returns active codes only", () => {
    const o = opIn(C_DOC, "searchIcdMasterCodes")!.op;
    expect(paramOf(C_DOC, o, "q")?.required).toBe(true);
    expect(paramOf(C_DOC, o, "q")?.schema).toMatchObject({ type: "string", minLength: 1 });
    expect(paramOf(C_DOC, o, "q")?.schema.maxLength).toBeLessThanOrEqual(64);
    expect(paramOf(C_DOC, o, "limit")?.schema ?? paramOf(C_DOC, o, "Limit")?.schema ?? deref(C_DOC, (o.parameters as any[]).find((p) => String(p.$ref ?? "").endsWith("/Limit"))).schema).toMatchObject({ type: "integer", minimum: 1 });
    const ok = okSchema(C_DOC, "searchIcdMasterCodes");
    expect(ok.required).toEqual(["data"]);
    expect(ok.properties.data.maxItems).toBeLessThanOrEqual(50);
    expect(String(o.description ?? "")).toMatch(/active/i);
    expect(String(o.description ?? "")).toMatch(/prefix|title/i);
  });
  it("deactivate answers the row (is_active false) and says the code stays on old orders; no delete operation exists", () => {
    expect(JSON.stringify(okSchema(C_DOC, "deactivateIcdMasterCode"))).toContain("is_active");
    expect(String(opIn(C_DOC, "deactivateIcdMasterCode")!.op.description ?? "")).toMatch(/order|history|existing|stay|kept/i);
    for (const [, item] of Object.entries<any>(C_DOC.paths)) for (const [m, op] of Object.entries<any>(item)) if (m === "delete") expect(String(op.operationId), "no DELETE operation for the ICD master").not.toMatch(/icd/i);
  });
});

describe("T0C-PARTYSET-1 examples", () => {
  const check = (file: string, doc: any, id: string) => {
    const o = opIn(doc, id)!;
    const reqEx = o.op.requestBody?.content?.["application/json"]?.examples;
    if (reqEx) for (const e of Object.values<any>(reqEx)) { const v = validatorFor(file, doc, id, "req"); expect(v(e.value), `${id} request example: ${JSON.stringify(v.errors?.[0])}`).toBe(true); }
    for (const [code, r] of Object.entries<any>(o.op.responses)) {
      if (r.$ref || !r.content?.["application/json"]?.examples) continue;
      for (const e of Object.values<any>(r.content["application/json"].examples)) { const v = validatorFor(file, doc, id, code); expect(v(e.value), `${id} ${code} example: ${JSON.stringify(v.errors?.[0])}`).toBe(true); }
    }
  };
  it("every request and response example of the 13 partners and 5 ICD operations validates against its schema, with synthetic values only", () => {
    for (const id of Object.keys(OPS)) check("partners.yaml", P_DOC, id);
    for (const id of Object.keys(ICD_OPS)) check("catalog.yaml", C_DOC, id);
    const text = JSON.stringify([...Object.keys(OPS).map((id) => opIn(P_DOC, id)!.op), ...Object.keys(ICD_OPS).map((id) => opIn(C_DOC, id)!.op)]);
    expect(text).not.toMatch(/@(?!example\.(test|com|org)|[a-z0-9.-]*\.test)/i);
    expect(text).not.toMatch(/\b9[78]\d{8}\b/);
  });
  it("the doctor, partner and credit party examples that carry an ID number validate, and the response ones are masked", () => {
    for (const id of ["createDoctor", "updateDoctor", "getDoctor"]) check("catalog.yaml", C_DOC, id);
    for (const id of ["createCreditParty", "getCreditParty", "updateCreditParty"]) check("catalog.yaml", C_DOC, id);
    for (const id of ["createPartner", "getPartner", "updatePartner"]) check("partners.yaml", P_DOC, id);
    for (const [doc, id] of [[C_DOC, "getDoctor"], [C_DOC, "createDoctor"], [P_DOC, "getPartner"], [P_DOC, "createPartner"]] as const) {
      const o = opIn(doc, id)!;
      const code = Object.keys(o.op.responses).find((c) => /^2/.test(c))!;
      for (const e of Object.values<any>(o.op.responses[code].content["application/json"].examples ?? {}))
        for (const f of ["tax_number", "national_id_number"]) if (e.value?.[f] !== undefined) expect(String(e.value[f]), `${id} example ${f} must be masked`).toMatch(MASKED);
    }
  });
});

describe("T0C-PARTYSET-1 permissions (done_when 6)", () => {
  const byCode = new Map<string, any>(registry.permissions.map((p: any) => [p.code, p]));
  it("the six codes exist; only partners.party_id_number.read is privileged; roles known, never a partner or platform role; ID numbers are not granted to front desk or bench roles", () => {
    const known = new Set([...registry.roles, ...registry.partner_roles, ...registry.platform_roles].map((r: any) => r.code));
    for (const code of NEW_CODES) {
      const p = byCode.get(code);
      expect(p, `${code} missing from contracts/permissions.yaml`).toBeDefined();
      expect(p.privileged, `${code} privileged`).toBe(code === IDR);
      expect(p.roles, `${code} owned by tenant_admin`).toContain("tenant_admin");
      for (const r of p.roles) expect(known.has(r), `${code} unknown role ${r}`).toBe(true);
      expect(p.roles.filter((r: string) => r.startsWith("partner_") || r.startsWith("platform_")), "never a partner or platform role").toEqual([]);
    }
    for (const r of ["front_desk", "centre_staff", "lab_technologist", "pathologist"]) expect(byCode.get(IDR).roles, `${IDR} must not go to ${r}`).not.toContain(r);
    expect(byCode.get(ICD).roles).toContain("lab_manager");
    expect(JSON.stringify(registry.fixed_actor_permissions)).not.toMatch(/party_setting|onboarding\.decide|party_id_number|penalty\.manage|icd\.manage/);
  });
  it("older codes keep their flags and roles (never renamed or removed)", () => {
    for (const code of ["partners.partner.manage", "partners.referrer.map", "catalog.referrer.manage", "catalog.referrer.export", "catalog.price_list.manage"]) expect(byCode.has(code), code).toBe(true);
    expect(byCode.get("partners.referrer.map").roles).toEqual(["tenant_admin", "lab_manager"]);
    expect(byCode.get("catalog.referrer.manage").roles).toEqual(["tenant_admin", "lab_manager", "front_desk"]);
    expect(byCode.get("catalog.referrer.export").privileged).toBe(true);
  });
  it("every x-permission of the 18 operations is one of the six codes; each code is used; no new code outside the list on these operations", () => {
    const used = [...Object.keys(OPS).map((id) => opIn(P_DOC, id)!.op["x-permission"]), ...Object.keys(ICD_OPS).map((id) => opIn(C_DOC, id)!.op["x-permission"])];
    sortedEq([...new Set(used)] as string[], NEW_CODES);
  });
  it("corp_admin pack holds all six codes, sorted and without duplicates", () => {
    const admin = packs.packs.flatMap((p: any) => p.roles).find((r: any) => r.code === "corp_admin");
    for (const c of NEW_CODES) expect(admin.permissions, `corp_admin lacks ${c}`).toContain(c);
    expect(new Set(admin.permissions).size).toBe(admin.permissions.length);
    expect(admin.permissions).toEqual([...admin.permissions].sort());
  });
});

describe("T0C-PARTYSET-1 generated clients and the pending-operations rule (LD-325)", () => {
  it("generated clients and MSW handlers are fresh (codegen --check)", () => { expect(staleFiles(ROOT)).toEqual([]); }, 120_000);
  it("partners and catalog module manifests list the new operationIds in pendingOperations (T0B-PARTYSET-1 removes them)", () => {
    for (const [mod, ids] of [["partners", Object.keys(OPS)], ["catalog", Object.keys(ICD_OPS)]] as const) {
      const p = join(ROOT, `services/api/src/modules/${mod}/index.ts`);
      expect(existsSync(p)).toBe(true);
      const t = readFileSync(p, "utf8");
      expect(t, `${mod}/index.ts must declare pendingOperations`).toMatch(/pendingOperations/);
      const all = mod === "partners" ? t + (existsSync(join(ROOT, "services/api/src/modules/partners/pending.ts")) ? readFileSync(join(ROOT, "services/api/src/modules/partners/pending.ts"), "utf8") : "") : t;
      for (const id of ids) expect(all, `${mod} pendingOperations lists ${id}`).toContain(id);
    }
  });
  it("the module permission lists carry the new codes (services/api/src/modules/{partners,catalog}/permissions.ts)", () => {
    const pp = readFileSync(join(ROOT, "services/api/src/modules/partners/permissions.ts"), "utf8");
    for (const c of NEW_CODES.filter((x) => x.startsWith("partners."))) expect(pp, c).toContain(c);
    expect(readFileSync(join(ROOT, "services/api/src/modules/catalog/permissions.ts"), "utf8")).toContain(ICD);
  });
});

describe("T0C-PARTYSET-1 migration file (static; behaviour in the pgTAP suite)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");
  const NEWT = ["partners.party_commercial_setting", "partners.party_onboarding", "partners.non_compliance_penalty", "partners.non_compliance_event", "catalog.icd_code"];

  it("exists, is the only 20261117220000 migration, sorts after the SALES-1 migration, runs as lims_owner", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all.filter((f) => f.startsWith("20261117220000"))).toEqual([MIG]);
    expect(all.indexOf(MIG)).toBeGreaterThan(all.indexOf("20261117210000_partners__add_sales_hierarchy.sql"));
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("creates the five tables IF NOT EXISTS, each with ENABLE + FORCE row level security, a tenant policy and a grant to lims_app only, and no DELETE grant", () => {
    for (const t of NEWT) {
      expect(code, `CREATE TABLE ${t}`).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t.replace(".", "\\.")}\\b`, "i"));
      expect(code, `ENABLE RLS ${t}`).toMatch(new RegExp(`ALTER TABLE ${t.replace(".", "\\.")} ENABLE ROW LEVEL SECURITY`, "i"));
      expect(code, `FORCE RLS ${t}`).toMatch(new RegExp(`ALTER TABLE ${t.replace(".", "\\.")} FORCE ROW LEVEL SECURITY`, "i"));
      expect(code, `policy on ${t}`).toMatch(new RegExp(`CREATE POLICY[^;]*ON ${t.replace(".", "\\.")}\\b[^;]*app\\.current_tenant_id\\(\\)`, "is"));
      const g = code.match(new RegExp(`GRANT\\s+([^;]*?)\\s+ON\\s+${t.replace(".", "\\.")}\\s+TO\\s+lims_app`, "i"));
      expect(g, `GRANT lims_app ${t}`).not.toBeNull();
      expect(g![1], `${t}: no DELETE / ALL / TRUNCATE (deactivate, never delete)`).not.toMatch(/\bDELETE\b|\bALL\b|\bTRUNCATE\b/i);
    }
    expect(code).not.toMatch(/TO\s+(PUBLIC|anon|authenticated)\b/i);
  });
  it("adds the government ID and doctor columns with ADD COLUMN IF NOT EXISTS: partners.partners (tax_number, national_id_number), catalog.doctors (speciality, hospital, national_id_number; no rate, LD-385)", () => {
    for (const [t, cols] of [["partners.partners", ["tax_number", "national_id_number"]], ["catalog.doctors", ["speciality", "hospital", "national_id_number"]]] as const)
      for (const c of cols) expect(code, `${t}.${c}`).toMatch(new RegExp(`ALTER TABLE ${t.replace(".", "\\.")}[^;]*ADD COLUMN IF NOT EXISTS ${c}\\b`, "is"));
    expect(code, "LD-385: no ADD COLUMN commission_bp on catalog.doctors").not.toMatch(/ALTER TABLE catalog\.doctors[^;]*commission/is);
    expect(code, "LD-385: no doctors__commission_bp__ck").not.toMatch(/doctors__commission/i);
    expect(code, "commission_bp stays on partners.party_commercial_setting").toMatch(/party_commercial_setting[\s\S]*commission_bp\s+integer/i);
  });
  it("policies are re-runnable; every CREATE TABLE and INDEX is IF NOT EXISTS (tenant_id first); every ADD CONSTRAINT is pg_constraint guarded", () => {
    for (const m of code.matchAll(/CREATE\s+POLICY\s+(\S+)\s+ON\s+(\S+)/gi)) {
      const before = code.slice(Math.max(0, m.index! - 700), m.index);
      expect(new RegExp(`DROP POLICY IF EXISTS ${m[1]}\\b`, "i").test(code.slice(0, m.index! + 10)) || /pg_policy/i.test(before), `policy ${m[1]} is not idempotent`).toBe(true);
    }
    expect((code.match(/CREATE TABLE(?! IF NOT EXISTS)/gi) ?? []).length).toBe(0);
    for (const m of code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/gi)) throw new Error(`unguarded CREATE INDEX near ${m.index}`);
    for (const m of code.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF NOT EXISTS\s+\S+\s+ON\s+\S+\s*(?:USING\s+\w+\s*)?\(\s*(\w+)/gi)) expect(m[1], `index leads with tenant_id: ${m[0].slice(0, 80)}`).toBe("tenant_id");
    for (const m of code.matchAll(/ADD\s+CONSTRAINT/gi)) expect(code.slice(Math.max(0, m.index! - 600), m.index), "ADD CONSTRAINT must sit in a DO block that checks pg_constraint").toMatch(/DO\s+\$[a-z_]*\$[\s\S]*pg_constraint/i);
  });
  it("database rules exist: transition triggers on party_onboarding and non_compliance_event, audit triggers on all five tables, search_path pinned on every trigger function", () => {
    for (const t of ["party_onboarding", "non_compliance_event"]) expect(code, `transition trigger ${t}`).toMatch(new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?TRIGGER\\s+\\w+\\s+BEFORE\\s+(INSERT\\s+OR\\s+)?UPDATE[^;]*ON\\s+partners\\.${t}\\b`, "i"));
    for (const t of NEWT) expect(code, `audit trigger ${t}`).toMatch(new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?TRIGGER\\s+${t.split(".")[1]}__audit\\b[^;]*ON ${t.replace(".", "\\.")}\\b[^;]*tg_row_audit`, "is"));
    for (const m of code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\S+)\s*\([^)]*\)\s+RETURNS\s+trigger[\s\S]*?\$\$;?/gi)) expect(m[0], `${m[1]} must pin search_path`).toMatch(/SET\s+search_path\s*=\s*''/i);
  });
  it("government ID values never reach audit.audit_log: the audit triggers of partners, doctors and credit parties are re-created with the ID columns excluded (app.tg_row_audit(...) excluded columns, CR-C15-013)", () => {
    for (const [trg, tbl, cols] of [["partners__audit", "partners.partners", ["tax_number", "national_id_number"]], ["doctors__audit", "catalog.doctors", ["national_id_number"]], ["credit_parties__audit", "catalog.credit_parties", ["pan"]]] as const) {
      const m = code.match(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+TRIGGER\\s+${trg}\\b[^;]*ON\\s+${tbl.replace(".", "\\.")}\\b[^;]*tg_row_audit\\(([^)]*)\\)`, "is"));
      expect(m, `${trg} must be re-created with excluded columns`).not.toBeNull();
      for (const c of cols) expect(m![1], `${trg} excludes ${c}`).toContain(`'${c}'`);
      expect(m![0], `${trg} keeps AFTER INSERT OR UPDATE OR DELETE`).toMatch(/AFTER\s+INSERT\s+OR\s+UPDATE\s+OR\s+DELETE/i);
    }
  });
  it("is additive: no DROP of data, no TRUNCATE / DELETE / INSERT / UPDATE data statement, ALTER only ADD COLUMN on partners.partners and catalog.doctors, no REVOKE, no float / numeric / money column", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect(code).not.toMatch(/\b(DROP\s+(TABLE|COLUMN|SCHEMA|INDEX|POLICY|TRIGGER)|TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|REVOKE)\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+\S+\s+SET\b/i);
    expect(code).not.toMatch(/\bCREATE\s+TYPE\b|\bAS\s+ENUM\b|DISABLE\s+ROW|NO\s+FORCE|ALTER\s+COLUMN|DROP\s+CONSTRAINT|RENAME|CREATE\s+SEQUENCE/i);
    const mine = [...NEWT, "partners.partners", "catalog.doctors"];
    for (const m of code.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF EXISTS\s+)?((?:partners|catalog)\.\w+)([^;]*);/gi)) {
      expect(mine, `ALTER of an unrelated table ${m[1]}`).toContain(m[1]);
      if (m[1] === "partners.partners" || m[1] === "catalog.doctors") expect(m[2], `${m[1]}: only ADD COLUMN IF NOT EXISTS is allowed`).toMatch(/^\s*(ADD COLUMN IF NOT EXISTS[^;]*)$/is);
    }
    expect(code).not.toMatch(/\b(float|double precision|real|numeric|decimal|money)\b/i);
  });
  it("comments: LD-321, the five tables, the new columns, down note with DROP TABLE and DROP COLUMN, additive / no rewrite, masked ID retention, push-cloud founder step", () => {
    expect(comments).toMatch(/LD-321/);
    expect(comments).toMatch(/\bdown\b/i);
    expect(comments).toMatch(/DROP TABLE/i);
    expect(comments).toMatch(/DROP COLUMN/i);
    for (const t of ["party_commercial_setting", "party_onboarding", "non_compliance_penalty", "non_compliance_event", "icd_code", "tax_number", "national_id_number", "commission_bp"]) expect(comments, `down note names ${t}`).toContain(t);
    expect(comments).toMatch(/no data rewrite|does not rewrite|no rewrite|additive/i);
    expect(comments).toMatch(/mask/i);
    expect(comments).toMatch(/push-cloud/i);
  });
});

describe("T0C-PARTYSET-1 implementation notes: FIELD MAP, permissions, retention, offline classification (done_when 1, 3, 8)", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  const lines = t.split("\n");
  // the labels the BRIEF names from the evidence (C:/LIMS-state/elabassist-sales-20261117.md and -other-); the evidence itself is outside the tester sandbox
  const LABELS = ["Commission", "PAN", "Aadhar", "Printing block", "Header", "Approve", "Hold", "Auto release", "WhatsApp", "Insurance", "Print exception", "Lab number scheme", "Billing cycle", "Invoice payment",
    "Blocking", "Warning", "Interest per day", "Priority", "Header and footer", "ICD master", "Outsource", "Interlab", "Center Test Mapping", "Non Compliance", "National ID number", "Speciality", "Qualification",
    "Hospital", "Registration number", "Doctor rate"];
  it("notes exist, name the migration as a founder step (push-cloud), cite LD-321, list every operation id, the pendingOperations move and T0B-PARTYSET-1", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-PARTYSET-1-impl.md missing").toBe(true);
    expect(t).toContain(MIG);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/LD-321/);
    for (const id of [...Object.keys(OPS), ...Object.keys(ICD_OPS)]) expect(t, id).toContain(id);
    expect(t).toMatch(/pendingOperations/);
    expect(t).toMatch(/T0B-PARTYSET-1/);
  });
  it("lists every new permission code and the role-pack re-apply founder step", () => {
    for (const c of NEW_CODES) expect(t, c).toContain(c);
    expect(t).toMatch(/apply-role-pack|role pack/i);
  });
  it("gives the offline classification (founder 09:19): settings reads may be cached; onboarding decisions, penalty charges and ID reveals are online only; lab number scheme is a plain code", () => {
    expect(t).toMatch(/offline/i);
    expect(t).toMatch(/online only/i);
    expect(t).toMatch(/cache/i);
    for (const w of [/onboarding/i, /penalty charge|charge/i, /reveal/i, /lab number scheme/i, /number block/i]) expect(t, String(w)).toMatch(w);
  });
  it("records the retention rule for PAN, Aadhar style and national id numbers as a FOUNDER confirmation, and the masking, audit and log / export rules", () => {
    expect(t).toMatch(/retention/i);
    expect(t).toMatch(/founder (must |to |will )?confirm|confirmed by the founder|founder confirms|founder step.*retention|retention.*founder/is);
    expect(t).toMatch(/last four/i);
    expect(t).toMatch(/audit/i);
    expect(t).toMatch(/\blogs?\b/i);
    expect(t).toMatch(/export/i);
    expect(t).toMatch(/partners\.party_id_number\.read/);
  });
  it("records the repo contradictions for the lead: existing frontdesk.icd_codes, pan vs tax_number, is_active vs active", () => {
    expect(t).toMatch(/frontdesk\.icd_codes|listIcdCodes/);
    expect(t).toMatch(/\bpan\b/i);
    expect(t).toMatch(/tax_number/);
    expect(t).toMatch(/is_active/);
  });
  it("Outsource, Interlab and Center Test Mapping: the notes say reporting.yaml and partners.yaml were read and name what already exists or why nothing was added", () => {
    expect(t).toMatch(/reporting\.yaml/);
    expect(t).toMatch(/partners\.yaml/);
    expect(t).toMatch(/outsourc/i);
  });
  it("every evidence field label has one decision line: present (field named), added (field named) or not added (reason)", () => {
    expect(t.length, "impl notes missing").toBeGreaterThan(0);
    const missing: string[] = [];
    for (const label of LABELS) {
      const l = label.toLowerCase();
      const hit = lines.find((x) => {
        const s = x.replace(/^[\s|*\-•>`_#]+/, "").toLowerCase();
        if (!s.startsWith(l)) return false;
        const rest = s.slice(l.length).replace(/^[*`_\s]+/, "");
        return (rest === "" || /^[—–\-:|=(]/.test(rest)) && /already present|present|added|not added|deliberately not/i.test(x);
      });
      if (!hit) missing.push(label);
    }
    expect(missing, `labels without a decision line: ${missing.join(" | ")}`).toEqual([]);
  });
  it("'not added' decisions carry a reason", () => {
    const bad = lines.filter((x) => /deliberately not added|not added/i.test(x) && !/because|reason|why|\bsince\b|—|: .{12,}/i.test(x));
    expect(bad, `not-added lines without a reason: ${bad.slice(0, 3).join(" || ")}`).toEqual([]);
  });
});
