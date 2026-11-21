// T0C-FINCTRL-1 (LD-321, LD-310 blanket authority, founder priority order 2026-11-17 09:18 NPT, offline 09:19 NPT) — accounting controls contracts:
// contracts/openapi/billing.yaml (16 additive staff operations under /v1/billing: discount reasons, slabs per party, per user limits, authorities, my policy, hold / release of ledger entries;
// ledger entry gains status held + held_* / released_* / fiscal_year_label; cash session gains previous_outstanding_cash_paisa + deposit_paisa), contracts/openapi/frontdesk.yaml (additive only),
// contracts/permissions.yaml + the corp_admin pack (2 new codes), the migration 20261117190000_billing__add_finance_controls.sql (static checks; behaviour is
// db/tests/frontdesk_billing/T0C-FINCTRL-1_finance_controls.test.sql), generated-client freshness, the pending-operations rule of LD-325(b), the implementer's notes with the FIELD MAP.
// ASSUMPTIONS (the brief gives function names and field labels, not wire names; a different choice needs a ruling, not a silent test edit; same style as T0C-ACCT-1 / T0C-PARTYSET-1):
//  - EVIDENCE C:/LIMS-state/elabassist-accounting-20261117.md IS readable here; FIELD_LABELS below are its labels.
//  - TABLES (singular, as the brief names them): billing.discount_reason, billing.party_discount_slab, billing.user_discount_limit, billing.discount_authority. The brief writes `active`; the repo uses
//    is_active. The ledger table is billing.account_ledger_entries (T0C-ACCT-1; billing.ledger_entries is the C4 invoice payment ledger and is untouched).
//  - OPERATION IDS / PATHS / PERMISSIONS: see OPS. Reads (lists, resolve, my policy) use billing.discount_policy.read, every write uses billing.discount_policy.manage (privileged, finance + tenant_admin).
//    hold / release "reuse the ledger manage code of T0C-ACCT-1" = billing.account.manage (the only ACCT-1 code named *.manage that guards ledger masters; entry create / reverse have their own codes).
//    Ledger entries have no version column, so hold / release take Idempotency-Key (required) and no If-Match; an illegal transition answers common.immutable_record. NO new error code anywhere.
//  - All staff, bearerJwt, x-context tenant, tier general (c4-openapi.test.ts pins general for billing). Wire names are snake_case; money = integer paisa (*_paisa, int64), percent = integer basis points (*_bp 0..10000).
//    Absent = not set (no nullable). Searching / filtering is by exact query parameters; there is no free text search on these masters.
//  - SLAB RULE: amount range is HALF OPEN [amount_from_paisa, amount_to_paisa) (amount_to excluded, so adjacent slabs 0..100000 and 100000..500000 never overlap); dates are inclusive
//    (effective_from .. effective_to, effective_to absent = open ended); only ACTIVE slabs of one (tenant, party_kind, party_id) must not overlap in BOTH ranges.
//  - LEDGER RULE: hold only from `submitted`, release returns to `submitted`; approved / rejected / reversed entries are never held (a correction is a reversal). Posted = every status except held.
//  - CASH: previous_outstanding_cash_paisa and deposit_paisa are NEW optional response fields of CashSessionDto (DailyCash.sessions items reuse it); deposit_paisa is also an optional field of CloseCashSessionRequest.
//  - FRONTDESK (brief contradicts repo, lead rules): requestDiscountApproval ALREADY has a REQUIRED reason_code (coded set frontdesk.discount_reasons) on the request and the response, and within_limit exists
//    only on the quote. Pinned reading: the request is unchanged (making reason_code optional would break c4 and the live handlers: "existing contract tests stay green unchanged"); the response
//    DiscountApproval gains the boolean within_limit as an OPTIONAL property; nothing else changes. The notes must record the contradiction and how frontdesk.discount_reasons relates to billing.discount_reason.
//  - LD-325(b): the 16 new operationIds are in pendingOperations of services/api/src/modules/billing/index.ts; T0B-FINCTRL-1 removes them.
//  - the implementer's notes are .orchestra/notes/T0C-FINCTRL-1-impl.md.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = "20261117190000_billing__add_finance_controls.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-FINCTRL-1-impl.md");
const load = (f: string): any => parse(readFileSync(join(ROOT, f), "utf8"));
const B = load("contracts/openapi/billing.yaml");
const F = load("contracts/openapi/frontdesk.yaml");
const common = load("contracts/openapi/_common.yaml");
const registry = load("contracts/permissions.yaml");
const packs = load("services/api/src/modules/identity/role-packs/role-packs.data.yaml");
const ERRORS = new Set<string>(load("contracts/errors.yaml").map((x: any) => x.code));
const METHODS = ["get", "put", "post", "delete", "patch"];
const P = "/v1/billing/";
const UUID = "0193c4a0-0000-7000-8000-0000000000aa";
const READ = "billing.discount_policy.read", MANAGE = "billing.discount_policy.manage", LEDGER = "billing.account.manage";
const NEW_CODES = [READ, MANAGE];
const PARTY_KINDS = ["credit_party", "partner", "doctor", "franchise"];

type OpSpec = { method: string; path: string; perm: string; idem: "required" | "optional" | "none"; ok: string; ifMatch: boolean | "optional"; paged?: boolean };
const OPS: Record<string, OpSpec> = {
  listDiscountReasons: { method: "get", path: `${P}discount-reasons`, perm: READ, idem: "none", ok: "200", ifMatch: false, paged: true },
  createDiscountReason: { method: "post", path: `${P}discount-reasons`, perm: MANAGE, idem: "required", ok: "201", ifMatch: false },
  updateDiscountReason: { method: "patch", path: `${P}discount-reasons/{discount_reason_id}`, perm: MANAGE, idem: "optional", ok: "200", ifMatch: true },
  listPartyDiscountSlabs: { method: "get", path: `${P}discount-slabs`, perm: READ, idem: "none", ok: "200", ifMatch: false, paged: true },
  createPartyDiscountSlab: { method: "post", path: `${P}discount-slabs`, perm: MANAGE, idem: "required", ok: "201", ifMatch: false },
  updatePartyDiscountSlab: { method: "patch", path: `${P}discount-slabs/{party_discount_slab_id}`, perm: MANAGE, idem: "optional", ok: "200", ifMatch: true },
  deactivatePartyDiscountSlab: { method: "post", path: `${P}discount-slabs/{party_discount_slab_id}/deactivate`, perm: MANAGE, idem: "optional", ok: "200", ifMatch: true },
  resolveDiscountSlab: { method: "get", path: `${P}discount-slabs/resolve`, perm: READ, idem: "none", ok: "200", ifMatch: false },
  listUserDiscountLimits: { method: "get", path: `${P}discount-limits`, perm: READ, idem: "none", ok: "200", ifMatch: false, paged: true },
  setUserDiscountLimit: { method: "put", path: `${P}discount-limits/{user_id}`, perm: MANAGE, idem: "optional", ok: "200", ifMatch: "optional" },
  listDiscountAuthorities: { method: "get", path: `${P}discount-authorities`, perm: READ, idem: "none", ok: "200", ifMatch: false, paged: true },
  createDiscountAuthority: { method: "post", path: `${P}discount-authorities`, perm: MANAGE, idem: "required", ok: "201", ifMatch: false },
  deactivateDiscountAuthority: { method: "post", path: `${P}discount-authorities/{discount_authority_id}/deactivate`, perm: MANAGE, idem: "optional", ok: "200", ifMatch: true },
  getMyDiscountPolicy: { method: "get", path: `${P}discount-policy/me`, perm: READ, idem: "none", ok: "200", ifMatch: false },
  holdLedgerEntry: { method: "post", path: `${P}account-ledger-entries/{account_ledger_entry_id}/hold`, perm: LEDGER, idem: "required", ok: "200", ifMatch: false },
  releaseLedgerEntry: { method: "post", path: `${P}account-ledger-entries/{account_ledger_entry_id}/release`, perm: LEDGER, idem: "required", ok: "200", ifMatch: false },
};
const OLD_BILLING = ["listInvoices", "recordPayment", "getMyCashSession", "closeCashSession", "getDailyCash", "listAccountGroups", "createAccountLedgerEntry", "listAccountLedgerEntries", "getAccountLedgerEntry",
  "reverseAccountLedgerEntry", "getAccountStatement", "getAccountSummary", "listAccountSummaries", "getDailyCollectionSummary", "createCashTransfer", "acceptCashTransfer"];

const opIn = (doc: any, id: string): { method: string; path: string; op: any } | undefined => {
  for (const [path, item] of Object.entries<any>(doc.paths)) for (const m of METHODS) if (item[m]?.operationId === id) return { method: m, path, op: item[m] };
  return undefined;
};
const idsOf = (doc: any): string[] => Object.values<any>(doc.paths).flatMap((item) => METHODS.filter((m) => item[m]).map((m) => item[m].operationId as string));
const deref = (doc: any, s: any): any => {
  if (!s?.$ref) return s;
  const [file, ptr] = String(s.$ref).split("#");
  const root = file === "_common.yaml" ? common : doc;
  return deref(doc, ptr.split("/").slice(1).reduce((a: any, k: string) => a?.[k], root));
};
const sortedEq = (a: string[], b: string[]) => expect([...a].sort()).toEqual([...b].sort());
const reqSchema = (doc: any, id: string): any => deref(doc, opIn(doc, id)!.op.requestBody?.content?.["application/json"]?.schema);
const okSchema = (doc: any, id: string): any => {
  const o = opIn(doc, id)!;
  const code = Object.keys(o.op.responses).find((c) => /^2/.test(c))!;
  return deref(doc, o.op.responses[code]?.content?.["application/json"]?.schema);
};
const itemSchema = (id: string): any => deref(B, okSchema(B, id).properties.data.items);
const props = (s: any): Record<string, any> => s?.properties ?? {};
const paramNames = (doc: any, op: any): string[] => (op.parameters ?? []).map((p: any) => deref(doc, p).name);
const paramOf = (doc: any, op: any, name: string): any => (op.parameters ?? []).map((p: any) => deref(doc, p)).find((p: any) => p.name === name);
const enumOf = (p: any): string[] => ((deref(B, p)?.enum ?? []) as unknown[]).filter((x): x is string => typeof x === "string");
const walk = (doc: any, s: any, fn: (n: any) => void, seen = new Set<any>()): void => {
  const n = deref(doc, s);
  if (!n || typeof n !== "object" || seen.has(n)) return;
  seen.add(n);
  fn(n);
  for (const v of Object.values<any>(n.properties ?? {})) walk(doc, v, fn, seen);
  if (n.items) walk(doc, n.items, fn, seen);
  for (const k of ["allOf", "oneOf", "anyOf"]) for (const v of n[k] ?? []) walk(doc, v, fn, seen);
};
const jsonMedia = (op: any): any[] => [op.requestBody?.content?.["application/json"], ...Object.values<any>(op.responses).filter((r) => !r.$ref).map((r) => r.content?.["application/json"])].filter(Boolean);
const isPaisa = (p: any) => { const d = deref(B, p); return d?.type === "integer" && d?.format === "int64" && d?.minimum >= 0 && Number.isInteger(d?.maximum); };
const isBp = (p: any) => { const d = deref(B, p); return d?.type === "integer" && d?.minimum === 0 && d?.maximum === 10000; };
const isUuid = (p: any) => JSON.stringify(p).includes("Uuid") || deref(B, p)?.format === "uuid";
const isDate = (p: any) => JSON.stringify(p).includes("IsoDate") || deref(B, p)?.format === "date";

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ ...common, id: "_common.yaml" });
ajv.addSchema({ ...B, id: "billing.yaml" });
ajv.addSchema({ ...F, id: "frontdesk.yaml" });
const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const validatorFor = (id: string, where: "req" | string) => {
  const o = opIn(B, id)!;
  const ptr = where === "req" ? `/paths/${esc(o.path)}/${o.method}/requestBody/content/application~1json/schema` : `/paths/${esc(o.path)}/${o.method}/responses/${where}/content/application~1json/schema`;
  const v = ajv.getSchema(`billing.yaml#${ptr}`);
  expect(v, `cannot resolve ${id} ${where}`).toBeDefined();
  return v!;
};
const compSchema = (name: string) => { const v = ajv.getSchema(`billing.yaml#/components/schemas/${name}`); expect(v, `billing:${name}`).toBeDefined(); return v!; };

describe("T0C-FINCTRL-1 lint and additive baseline", () => {
  it("lintRepo reports no violation for billing.yaml or frontdesk.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => ["billing.yaml", "frontdesk.yaml"].includes(x.file));
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });
  it("billing.yaml is additive: the old operations stay, 72 + 16 = 88 operations on 64 + 13 = 77 paths, ids unique across every contracts/openapi file", () => {
    const ids = idsOf(B);
    expect(new Set(ids).size, "duplicate operationId in billing.yaml").toBe(ids.length);
    for (const id of OLD_BILLING) expect(opIn(B, id), `${id} removed`).toBeDefined();
    expect(opIn(B, "reverseAccountLedgerEntry")!.op["x-permission"]).toBe("billing.account_entry.reverse");
    for (const id of Object.keys(OPS)) expect(opIn(B, id), `${id} missing`).toBeDefined();
    expect(ids.length).toBe(72 + Object.keys(OPS).length);
    expect(Object.keys(B.paths).length).toBe(64 + 13);
    const all = readdirSync(join(ROOT, "contracts/openapi")).filter((f) => f.endsWith(".yaml") && !f.startsWith("_")).flatMap((f) => idsOf(load(`contracts/openapi/${f}`)));
    for (const id of Object.keys(OPS)) expect(all.filter((x) => x === id), `${id} must be unique across every contracts/openapi file`).toHaveLength(1);
  });
});

describe("T0C-FINCTRL-1 operation table (done_when 5, 7, 8)", () => {
  for (const [id, s] of Object.entries(OPS)) {
    describe(id, () => {
      const o = opIn(B, id);
      it(`${s.method.toUpperCase()} ${s.path}, permission ${s.perm}, tag billing, bearerJwt, tenant context, tier general`, () => {
        expect(o, `${id} missing`).toBeDefined();
        expect(o!.method).toBe(s.method);
        expect(o!.path).toBe(s.path);
        expect(o!.op["x-permission"]).toBe(s.perm);
        expect(o!.op.tags).toEqual(["billing"]);
        expect(o!.op.security).toEqual([{ bearerJwt: [] }]);
        expect(o!.op["x-context"]).toBe("tenant");
        expect(o!.op["x-public"]).toBeUndefined();
        expect(o!.op["x-rate-limit-tier"]).toBe("general");
        expect(typeof o!.op.summary).toBe("string");
      });
      it("error codes: five common, not_found with a path id, If-Match pair, invalid_cursor on lists, immutable_record on hold / release; every code is registered (no new error code)", () => {
        const e: string[] = o?.op["x-error-codes"] ?? [];
        for (const c of ["common.validation_failed", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"]) expect(e, c).toContain(c);
        if (/\{/.test(s.path)) expect(e).toContain("common.not_found");
        if (s.ifMatch === true) for (const c of ["common.version_conflict", "common.precondition_required"]) expect(e, c).toContain(c);
        if (s.ifMatch === "optional") expect(e).toContain("common.version_conflict");
        if (s.paged) expect(e).toContain("common.invalid_cursor");
        if (id === "holdLedgerEntry" || id === "releaseLedgerEntry") expect(e).toContain("common.immutable_record");
        for (const c of e) expect(ERRORS.has(c), `${c} not in contracts/errors.yaml (no new error code allowed)`).toBe(true);
      });
      it("idempotency and If-Match headers", () => {
        const names = paramNames(B, o?.op ?? {});
        expect(o!.op["x-idempotency"]).toBe(s.idem);
        if (s.idem === "required") expect(names).toContain("Idempotency-Key"); else expect(names).not.toContain("Idempotency-Key");
        expect(names.includes("If-Match"), "If-Match").toBe(s.ifMatch !== false);
        if (s.ifMatch === "optional") expect(paramOf(B, o!.op, "If-Match").required, "first save has no version").not.toBe(true);
        if (s.ifMatch === true) expect(paramOf(B, o!.op, "If-Match").required).toBe(true);
      });
      it(`success ${s.ok}, JSON body with an example that validates, standard error responses`, () => {
        const r = o?.op.responses ?? {};
        expect(Object.keys(r).filter((c) => /^2/.test(c))).toEqual([s.ok]);
        const j = r[s.ok]?.content?.["application/json"];
        expect(j, "JSON 2xx").toBeDefined();
        const ex = Object.values<any>(j.examples ?? {});
        expect(ex.length, "example").toBeGreaterThan(0);
        const v = validatorFor(id, s.ok);
        for (const e of ex) expect(v(e.value), JSON.stringify(v.errors?.[0])).toBe(true);
        if (o!.op.requestBody) {
          const rj = o!.op.requestBody.content["application/json"];
          const rv = validatorFor(id, "req");
          expect(Object.keys(rj.examples ?? {}).length, "request example").toBeGreaterThan(0);
          for (const e of Object.values<any>(rj.examples)) expect(rv(e.value), JSON.stringify(rv.errors?.[0])).toBe(true);
        }
        for (const c of ["400", "401", "403", "429", "500"]) expect(r[c], c).toBeDefined();
      });
      it("every object schema reachable is closed; no float, no nullable; no tenant_id / created_by / server field in a request; money is paisa, percent is basis points (no *_percent)", () => {
        for (const m of jsonMedia(o!.op)) walk(B, m.schema, (n) => {
          if (n.type === "object" || n.properties) expect(n.additionalProperties, JSON.stringify(Object.keys(n.properties ?? {})).slice(0, 80)).toBe(false);
          expect(n.type, "never number").not.toBe("number");
          expect(n.nullable, "no nullable: absent means not set").not.toBe(true);
          for (const k of Object.keys(n.properties ?? {})) expect(k, "percent is *_bp").not.toMatch(/percent|_pct$/);
        });
        walk(B, o!.op.requestBody?.content?.["application/json"]?.schema, (n) => {
          for (const f of ["tenant_id", "created_by", "updated_by", "created_at", "updated_at", "version", "id", "held_by", "held_at", "released_by", "released_at"]) expect(Object.keys(n.properties ?? {}), `request names ${f}`).not.toContain(f);
        });
      });
      if (s.paged) it("is paged: Cursor + Limit parameters, {data (maxItems <= 200), page: PageInfo}", () => {
        const names = (o!.op.parameters as any[]).map((p) => p.$ref ?? p.name);
        expect(names).toEqual(expect.arrayContaining(["_common.yaml#/components/parameters/Cursor", "_common.yaml#/components/parameters/Limit"]));
        const ok = okSchema(B, id);
        sortedEq(ok.required, ["data", "page"]);
        expect(ok.properties.data.maxItems).toBeLessThanOrEqual(200);
        expect(JSON.stringify(ok.properties.page)).toContain("PageInfo");
      });
    });
  }
});

describe("T0C-FINCTRL-1 shapes: discount reasons (done_when 2, 5)", () => {
  it("item: id, code, name, is_active, display_order, version; code ^[A-Z0-9_]{1,32}$, name 1..200, display_order 0..9999; closed; no tenant_id", () => {
    const it_ = itemSchema("listDiscountReasons");
    const p = props(it_);
    for (const f of ["id", "code", "name", "is_active", "display_order", "version", "created_at", "updated_at"]) expect(p[f], `reason.${f}`).toBeDefined();
    expect(it_.required).toEqual(expect.arrayContaining(["id", "code", "name", "is_active", "display_order", "version"]));
    expect(it_.additionalProperties).toBe(false);
    expect(p.tenant_id).toBeUndefined();
    expect(p.is_active.type).toBe("boolean");
    expect(p.display_order).toMatchObject({ type: "integer", minimum: 0, maximum: 9999 });
    expect(new RegExp(p.code.pattern).test("PARTNER_FAMILY")).toBe(true);
    expect(new RegExp(p.code.pattern).test("bad code;")).toBe(false);
    expect(p.name).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(JSON.stringify(okSchema(B, "createDiscountReason"))).toBe(JSON.stringify(it_));
    expect(JSON.stringify(okSchema(B, "updateDiscountReason"))).toBe(JSON.stringify(it_));
  });
  it("list filters: is_active; create takes code + name (+ display_order); update takes name, display_order, is_active only (code is immutable; deactivate, never delete: no delete operation)", () => {
    expect(paramOf(B, opIn(B, "listDiscountReasons")!.op, "is_active")?.schema?.type).toBe("boolean");
    const c = reqSchema(B, "createDiscountReason");
    sortedEq(c.required, ["code", "name"]);
    for (const f of ["code", "name", "display_order"]) expect(props(c)[f], f).toBeDefined();
    const u = reqSchema(B, "updateDiscountReason");
    expect(props(u).code, "code is immutable").toBeUndefined();
    for (const f of ["name", "display_order", "is_active"]) expect(props(u)[f], f).toBeDefined();
    expect(Object.values<any>(B.paths).filter((i) => i.delete && /discount/.test(JSON.stringify(i.delete.operationId))), "no delete operation").toEqual([]);
  });
  it("payloads: valid accepted; bad code, empty name, display_order 10000, float, string, unknown and server fields rejected", () => {
    const v = validatorFor("createDiscountReason", "req");
    expect(v({ code: "STAFF", name: "Staff", display_order: 1 }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ code: "STAFF", name: "Staff" })).toBe(true);
    for (const bad of [{ code: "staff code" }, { code: "" }, { code: "A".repeat(33) }, { name: "" }, { display_order: 10000 }, { display_order: -1 }, { display_order: 1.5 }, { display_order: "1" }, { tenant_id: UUID }, { is_active: true, extra: 1 }])
      expect(v({ code: "STAFF", name: "Staff", ...bad }), JSON.stringify(bad)).toBe(false);
  });
});

describe("T0C-FINCTRL-1 shapes: party discount slabs (done_when 2, 5)", () => {
  const SLAB = { party_kind: "credit_party", party_id: UUID, amount_from_paisa: 0, amount_to_paisa: 100000, discount_bp: 500, effective_from: "2026-11-17" };
  it("item carries party_kind (credit_party|partner|doctor|franchise), party_id, amount range, discount_bp 0..10000, effective_from, optional effective_to, is_active, version", () => {
    const it_ = itemSchema("listPartyDiscountSlabs");
    const p = props(it_);
    for (const f of ["id", "party_kind", "party_id", "amount_from_paisa", "amount_to_paisa", "discount_bp", "effective_from", "effective_to", "is_active", "version"]) expect(p[f], `slab.${f}`).toBeDefined();
    expect(it_.required).toEqual(expect.arrayContaining(["id", "party_kind", "party_id", "amount_from_paisa", "amount_to_paisa", "discount_bp", "effective_from", "is_active", "version"]));
    expect(it_.required, "effective_to is optional (open ended)").not.toContain("effective_to");
    sortedEq(enumOf(p.party_kind), PARTY_KINDS);
    expect(isUuid(p.party_id)).toBe(true);
    expect(isPaisa(p.amount_from_paisa) && isPaisa(p.amount_to_paisa)).toBe(true);
    expect(isBp(p.discount_bp)).toBe(true);
    expect(isDate(p.effective_from) && isDate(p.effective_to)).toBe(true);
    expect(String(deref(B, p.amount_to_paisa).description ?? p.amount_to_paisa.description ?? ""), "amount_to is exclusive").toMatch(/exclusive|not included|up to but/i);
    for (const id of ["createPartyDiscountSlab", "updatePartyDiscountSlab", "deactivatePartyDiscountSlab"]) expect(JSON.stringify(okSchema(B, id)), id).toBe(JSON.stringify(it_));
  });
  it("list filters party_kind, party_id, is_active; create requires the six fields; update cannot change the party; deactivate has no body", () => {
    for (const f of ["party_kind", "party_id", "is_active"]) expect(paramOf(B, opIn(B, "listPartyDiscountSlabs")!.op, f), f).toBeDefined();
    sortedEq(reqSchema(B, "createPartyDiscountSlab").required, ["party_kind", "party_id", "amount_from_paisa", "amount_to_paisa", "discount_bp", "effective_from"]);
    const u = props(reqSchema(B, "updatePartyDiscountSlab"));
    for (const f of ["amount_from_paisa", "amount_to_paisa", "discount_bp", "effective_from", "effective_to"]) expect(u[f], f).toBeDefined();
    for (const f of ["party_kind", "party_id", "is_active"]) expect(u[f], `${f} is not editable`).toBeUndefined();
    expect(opIn(B, "deactivatePartyDiscountSlab")!.op.requestBody, "deactivate needs no body").toBeUndefined();
    expect(String(opIn(B, "createPartyDiscountSlab")!.op.description ?? ""), "description states the no overlap rule").toMatch(/overlap/i);
  });
  it("payloads: valid accepted (with and without effective_to); discount_bp 10001 / -1 / 1.5 / string, negative or float amounts, bad party_kind, bad date, unknown and server fields rejected", () => {
    const v = validatorFor("createPartyDiscountSlab", "req");
    expect(v(SLAB), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ ...SLAB, effective_to: "2027-11-16" })).toBe(true);
    expect(v({ ...SLAB, discount_bp: 0 }) && v({ ...SLAB, discount_bp: 10000 })).toBe(true);
    for (const bad of [{ discount_bp: 10001 }, { discount_bp: -1 }, { discount_bp: 1.5 }, { discount_bp: "500" }, { amount_from_paisa: -1 }, { amount_to_paisa: 100.5 }, { amount_to_paisa: "1" }, { party_kind: "patient" },
      { party_kind: "Credit_Party" }, { party_id: "x" }, { effective_from: "17-11-2026" }, { tenant_id: UUID }, { id: UUID }, { is_active: true }, { extra: 1 }])
      expect(v({ ...SLAB, ...bad }), JSON.stringify(bad)).toBe(false);
    for (const f of Object.keys(SLAB)) { const { [f]: _d, ...rest } = SLAB as any; expect(v(rest), `missing ${f} accepted`).toBe(false); }
  });
  it("resolveDiscountSlab: required party_kind, party_id, amount_paisa; optional on_date; response {matched, slab?, discount_bp?}: no slab = matched false with neither", () => {
    const o = opIn(B, "resolveDiscountSlab")!.op;
    for (const f of ["party_kind", "party_id", "amount_paisa"]) expect(paramOf(B, o, f)?.required, `${f} required`).toBe(true);
    expect(paramOf(B, o, "on_date"), "on_date").toBeDefined();
    expect(paramOf(B, o, "on_date").required).not.toBe(true);
    sortedEq(enumOf(paramOf(B, o, "party_kind").schema), PARTY_KINDS);
    expect(isPaisa(paramOf(B, o, "amount_paisa").schema)).toBe(true);
    const r = okSchema(B, "resolveDiscountSlab");
    expect(r.additionalProperties).toBe(false);
    sortedEq(r.required, ["matched"]);
    expect(props(r).matched.type).toBe("boolean");
    expect(deref(B, props(r).slab)?.properties?.discount_bp, "slab is the slab item").toBeDefined();
    expect(isBp(props(r).discount_bp)).toBe(true);
    const v = validatorFor("resolveDiscountSlab", "200");
    expect(v({ matched: false })).toBe(true);
    expect(v({ matched: true, discount_bp: 500 })).toBe(true);
    expect(v({})).toBe(false);
    expect(v({ matched: false, discount_bp: 10001 })).toBe(false);
  });
});

describe("T0C-FINCTRL-1 shapes: per user limits, authorities, my policy (done_when 2, 5)", () => {
  it("limit item: user_id, max_discount_bp 0..10000, max_discount_paisa (per bill), is_active, version; set body requires both maxima; the user is a path parameter", () => {
    const it_ = itemSchema("listUserDiscountLimits");
    const p = props(it_);
    for (const f of ["id", "user_id", "max_discount_bp", "max_discount_paisa", "is_active", "version"]) expect(p[f], `limit.${f}`).toBeDefined();
    expect(isUuid(p.user_id) && isBp(p.max_discount_bp) && isPaisa(p.max_discount_paisa)).toBe(true);
    expect(JSON.stringify(okSchema(B, "setUserDiscountLimit"))).toBe(JSON.stringify(it_));
    const b = reqSchema(B, "setUserDiscountLimit");
    sortedEq(b.required, ["max_discount_bp", "max_discount_paisa"]);
    expect(props(b).user_id, "user is in the path").toBeUndefined();
    expect(isUuid(paramOf(B, opIn(B, "setUserDiscountLimit")!.op, "user_id").schema)).toBe(true);
    for (const f of ["user_id", "is_active"]) expect(paramOf(B, opIn(B, "listUserDiscountLimits")!.op, f), f).toBeDefined();
    const v = validatorFor("setUserDiscountLimit", "req");
    expect(v({ max_discount_bp: 500, max_discount_paisa: 100000 }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ max_discount_bp: 10000, max_discount_paisa: 0, is_active: false })).toBe(true);
    for (const bad of [{ max_discount_bp: 10001 }, { max_discount_bp: -1 }, { max_discount_bp: 1.5 }, { max_discount_paisa: -1 }, { max_discount_paisa: 1.5 }, { max_discount_paisa: "5" }, { user_id: UUID }, { x: 1 }])
      expect(v({ max_discount_bp: 500, max_discount_paisa: 100000, ...bad }), JSON.stringify(bad)).toBe(false);
  });
  it("authority item: user_id, max_discount_bp, max_discount_paisa, is_active, version; create requires user_id + both maxima; deactivate has no body (never delete)", () => {
    const it_ = itemSchema("listDiscountAuthorities");
    const p = props(it_);
    for (const f of ["id", "user_id", "max_discount_bp", "max_discount_paisa", "is_active", "version"]) expect(p[f], `authority.${f}`).toBeDefined();
    for (const id of ["createDiscountAuthority", "deactivateDiscountAuthority"]) expect(JSON.stringify(okSchema(B, id)), id).toBe(JSON.stringify(it_));
    sortedEq(reqSchema(B, "createDiscountAuthority").required, ["user_id", "max_discount_bp", "max_discount_paisa"]);
    expect(opIn(B, "deactivateDiscountAuthority")!.op.requestBody).toBeUndefined();
    const v = validatorFor("createDiscountAuthority", "req");
    expect(v({ user_id: UUID, max_discount_bp: 2000, max_discount_paisa: 500000 })).toBe(true);
    for (const bad of [{ max_discount_bp: 10001 }, { max_discount_paisa: -5 }, { user_id: "u" }, { tenant_id: UUID }]) expect(v({ user_id: UUID, max_discount_bp: 2000, max_discount_paisa: 500000, ...bad }), JSON.stringify(bad)).toBe(false);
  });
  it("getMyDiscountPolicy: {own_limit?, authority?, reasons[]} for the signed in user, reasons required (active ones only, max 200), nothing about other users, no path or query user id", () => {
    const o = opIn(B, "getMyDiscountPolicy")!.op;
    expect(paramNames(B, o).filter((n) => !/^(Cursor|Limit)$/i.test(n) && n !== "cursor" && n !== "limit"), "no user parameter: always the caller").toEqual([]);
    const r = okSchema(B, "getMyDiscountPolicy");
    expect(r.additionalProperties).toBe(false);
    expect(r.required).toEqual(["reasons"]);
    const p = props(r);
    for (const f of ["own_limit", "authority", "reasons"]) expect(p[f], f).toBeDefined();
    for (const f of ["own_limit", "authority"]) { const s = deref(B, p[f]); expect(isBp(s.properties.max_discount_bp) && isPaisa(s.properties.max_discount_paisa), f).toBe(true); expect(s.additionalProperties).toBe(false); }
    expect(p.reasons).toMatchObject({ type: "array" });
    expect(p.reasons.maxItems).toBeLessThanOrEqual(200);
    const ri = deref(B, p.reasons.items);
    for (const f of ["code", "name"]) expect(ri.properties[f], `reasons[].${f}`).toBeDefined();
    const v = validatorFor("getMyDiscountPolicy", "200");
    expect(v({ reasons: [] })).toBe(true);
    expect(v({ own_limit: { max_discount_bp: 500, max_discount_paisa: 1000 }, authority: { max_discount_bp: 2000, max_discount_paisa: 5000 }, reasons: [{ code: "STAFF", name: "Staff", display_order: 1 }] }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({})).toBe(false);
    expect(v({ reasons: [], own_limit: { max_discount_bp: 10001, max_discount_paisa: 1 } })).toBe(false);
  });
});

describe("T0C-FINCTRL-1 shapes: ledger hold, release, fiscal year (done_when 3, 5)", () => {
  const ENTRY = () => itemSchema("listAccountLedgerEntries");
  it("hold and release: body {reason} required 1..500 (closed), response is the ledger entry; descriptions state posted balances exclude held entries", () => {
    for (const id of ["holdLedgerEntry", "releaseLedgerEntry"]) {
      const b = reqSchema(B, id);
      expect(b.additionalProperties).toBe(false);
      sortedEq(b.required, ["reason"]);
      expect(props(b).reason).toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
      expect(JSON.stringify(okSchema(B, id)), `${id} returns the entry`).toBe(JSON.stringify(ENTRY()));
      const v = validatorFor(id, "req");
      expect(v({ reason: "Cheque not cleared" })).toBe(true);
      for (const bad of [{}, { reason: "" }, { reason: "x".repeat(501) }, { reason: 5 }, { reason: "ok", status: "held" }, { reason: "ok", amount_paisa: 1 }]) expect(v(bad), `${id} ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(String(opIn(B, "holdLedgerEntry")!.op.description ?? "")).toMatch(/posted|balance/i);
    expect(String(opIn(B, "holdLedgerEntry")!.op.description ?? "")).toMatch(/submitted/i);
    expect(String(opIn(B, "releaseLedgerEntry")!.op.description ?? "")).toMatch(/submitted/i);
  });
  it("entry status enum gains held (five values); held_reason, held_by, held_at, released_by, released_at, fiscal_year_label are optional response fields; old required list unchanged", () => {
    const e = ENTRY();
    sortedEq(enumOf(props(e).status), ["submitted", "approved", "rejected", "reversed", "held"]);
    for (const f of ["held_reason", "held_by", "held_at", "released_by", "released_at", "fiscal_year_label"]) {
      expect(props(e)[f], `entry.${f}`).toBeDefined();
      expect(e.required, `${f} optional`).not.toContain(f);
    }
    expect(props(e).held_reason).toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
    expect(isUuid(props(e).held_by) && isUuid(props(e).released_by)).toBe(true);
    expect(JSON.stringify(props(e).held_at) + JSON.stringify(props(e).released_at)).toContain("IsoUtc");
    const re = new RegExp(deref(B, props(e).fiscal_year_label).pattern);
    for (const ok of ["2083/84", "2082/83", "2099/00"]) expect(re.test(ok), ok).toBe(true);
    for (const bad of ["2083-84", "83/84", "2083/8", "2083/844", "abcd/ef", " 2083/84"]) expect(re.test(bad), bad).toBe(false);
    expect(e.required).toEqual(expect.arrayContaining(["id", "centre_id", "party_kind", "party_id", "entry_date", "account_particular_id", "entry_type", "amount_paisa", "payment_mode", "status", "receipt_no", "created_by", "last_modified_by", "created_at"]));
    expect(e.additionalProperties).toBe(false);
  });
  it("listAccountLedgerEntries filters by fiscal_year_label and accepts status held; the create request does not accept status or held fields", () => {
    const o = opIn(B, "listAccountLedgerEntries")!.op;
    expect(paramOf(B, o, "fiscal_year_label"), "fiscal_year_label filter").toBeDefined();
    const st = paramOf(B, o, "status");
    if (enumOf(st.schema).length) expect(enumOf(st.schema)).toContain("held");
    const c = props(reqSchema(B, "createAccountLedgerEntry"));
    for (const f of ["status", "held_reason", "held_by", "held_at", "released_by", "released_at"]) expect(c[f], `create must not take ${f}`).toBeUndefined();
  });
});

describe("T0C-FINCTRL-1 shapes: carried forward cash (done_when 4)", () => {
  it("CashSessionDto gains previous_outstanding_cash_paisa and deposit_paisa (optional int64 paisa >= 0); DailyCash sessions still reuse it; old required list unchanged", () => {
    const s = B.components.schemas.CashSessionDto;
    for (const f of ["previous_outstanding_cash_paisa", "deposit_paisa"]) {
      expect(isPaisa(s.properties[f]), f).toBe(true);
      expect(s.required, `${f} optional`).not.toContain(f);
    }
    expect(s.required).toEqual(["id", "opened_by", "centre_id", "status", "opened_at", "rows", "version"]);
    expect(JSON.stringify(B.components.schemas.DailyCash.properties.sessions.items)).toContain("CashSessionDto");
    expect(String(s.properties.previous_outstanding_cash_paisa.description ?? "")).toMatch(/carried|previous|day before/i);
  });
  it("CloseCashSessionRequest gains optional deposit_paisa (paisa >= 0); counted stays the only required field", () => {
    const s = B.components.schemas.CloseCashSessionRequest;
    expect(isPaisa(s.properties.deposit_paisa)).toBe(true);
    expect(s.required).toEqual(["counted"]);
    const v = compSchema("CloseCashSessionRequest");
    const base = { counted: [{ method_code: "cash", amount_paisa: 1000 }] };
    expect(v(base)).toBe(true);
    expect(v({ ...base, deposit_paisa: 900 })).toBe(true);
    for (const bad of [{ deposit_paisa: -1 }, { deposit_paisa: 1.5 }, { deposit_paisa: "9" }]) expect(v({ ...base, ...bad }), JSON.stringify(bad)).toBe(false);
  });
});

describe("T0C-FINCTRL-1 frontdesk.yaml: additive only (done_when 6)", () => {
  const FS = F.components.schemas;
  it("requestDiscountApproval request is unchanged (reason_code stays required, coded set kept); the response DiscountApproval gains within_limit (boolean, optional) and keeps reason_code", () => {
    expect(FS.DiscountApprovalRequest.required).toEqual(["centre_id", "base_fingerprint", "discounts", "reason_code", "patient_ref"]);
    expect(FS.DiscountApprovalRequest.properties.reason_code).toMatchObject({ type: "string", maxLength: 64, minLength: 1 });
    expect(FS.DiscountApprovalRequest.properties.reason_code["x-coded-set"]).toBe("frontdesk.discount_reasons");
    expect(FS.DiscountApproval.required).toEqual(["id", "status", "centre_id", "requested_by", "discounts", "computed_discount", "gross", "percent_of_gross_bp", "reason_code", "expires_at", "version"]);
    expect(FS.DiscountApproval.properties.reason_code).toMatchObject({ type: "string", maxLength: 64 });
    expect(FS.DiscountApproval.properties.within_limit, "within_limit").toMatchObject({ type: "boolean" });
    expect(FS.DiscountApproval.required, "within_limit is optional: live handlers validate their output against this schema").not.toContain("within_limit");
    expect(FS.DiscountApproval.additionalProperties).toBe(false);
  });
  it("the operation keeps id, path, permission, error codes and idempotency; its response example carries within_limit and validates", () => {
    const o = opIn(F, "requestDiscountApproval")!;
    expect(o.path).toBe("/v1/frontdesk/discount-approvals");
    expect(o.op["x-permission"]).toBe("frontdesk.discount.apply");
    expect(o.op["x-idempotency"]).toBe("required");
    expect(o.op["x-error-codes"]).toEqual(expect.arrayContaining(["frontdesk.discount_exceeds_limit", "common.validation_failed", "common.idempotency_key_reused"]));
    const ex = Object.values<any>(o.op.responses["201"].content["application/json"].examples)[0].value;
    expect(typeof ex.within_limit).toBe("boolean");
    const v = ajv.getSchema("frontdesk.yaml#/components/schemas/DiscountApproval")!;
    expect(v(ex), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ ...ex, within_limit: "yes" })).toBe(false);
    expect(v({ ...ex, within_limit: undefined })).toBe(true);
  });
  it("the discount approval workflow operations all stay (nothing removed or renamed)", () => {
    for (const id of ["requestDiscountApproval", "listDiscountApprovals", "getDiscountApproval", "approveDiscount", "rejectDiscount"]) expect(opIn(F, id), id).toBeDefined();
    expect(opIn(F, "approveDiscount")!.op["x-permission"]).toBe("frontdesk.discount.approve");
    expect(FS.Discount.properties.reason_code, "per line reason_code stays").toBeDefined();
  });
});

describe("T0C-FINCTRL-1 permissions (done_when 7)", () => {
  const byCode = new Map<string, any>(registry.permissions.map((p: any) => [p.code, p]));
  it("billing.discount_policy.read (not privileged) and .manage (privileged, finance + tenant_admin) exist; read reaches the roles that bill; no partner or platform role; not a fixed actor grant", () => {
    const known = new Set([...registry.roles, ...registry.partner_roles, ...registry.platform_roles].map((r: any) => r.code));
    for (const c of NEW_CODES) {
      const p = byCode.get(c);
      expect(p, `${c} missing from contracts/permissions.yaml`).toBeDefined();
      for (const r of p.roles) expect(known.has(r), `${c} unknown role ${r}`).toBe(true);
      expect(p.roles.filter((r: string) => r.startsWith("partner_") || r.startsWith("platform_"))).toEqual([]);
    }
    expect(byCode.get(READ).privileged).toBe(false);
    expect(byCode.get(MANAGE).privileged).toBe(true);
    expect([...byCode.get(MANAGE).roles].sort()).toEqual(["finance", "tenant_admin"]);
    expect(byCode.get(READ).roles).toEqual(expect.arrayContaining(["finance", "tenant_admin", "front_desk"]));
    expect(JSON.stringify(registry.fixed_actor_permissions)).not.toMatch(/discount_policy/);
  });
  it("hold and release reuse billing.account.manage (privileged, unchanged roles); older billing codes keep flags and roles", () => {
    expect(byCode.get(LEDGER)).toMatchObject({ privileged: true });
    expect([...byCode.get(LEDGER).roles].sort()).toEqual(["finance", "tenant_admin"]);
    expect(byCode.get("billing.account_entry.reverse").privileged).toBe(true);
    expect(byCode.get("frontdesk.discount.approve")).toMatchObject({ privileged: true });
    expect(byCode.get("frontdesk.discount.apply").roles).toEqual(["front_desk"]);
  });
  it("the 16 operations use only billing.discount_policy.read / .manage / billing.account.manage; both new codes are used", () => {
    const used = Object.keys(OPS).map((id) => opIn(B, id)!.op["x-permission"]);
    sortedEq([...new Set(used)] as string[], [READ, MANAGE, LEDGER]);
    expect(used.filter((c) => c === READ)).toHaveLength(6);
    expect(used.filter((c) => c === MANAGE)).toHaveLength(8);
  });
  it("corp_admin pack holds both codes, sorted and without duplicates", () => {
    const admin = packs.packs.flatMap((p: any) => p.roles).find((r: any) => r.code === "corp_admin");
    for (const c of NEW_CODES) expect(admin.permissions, `corp_admin lacks ${c}`).toContain(c);
    expect(new Set(admin.permissions).size).toBe(admin.permissions.length);
    expect(admin.permissions).toEqual([...admin.permissions].sort());
  });
});

describe("T0C-FINCTRL-1 generated clients and the pending-operations rule (LD-325)", () => {
  it("generated clients and MSW handlers are fresh (codegen --check)", () => { expect(staleFiles(ROOT)).toEqual([]); }, 120_000);
  it("the billing module manifest lists the 16 operationIds in pendingOperations (T0B-FINCTRL-1 removes them)", () => {
    const t = readFileSync(join(ROOT, "services/api/src/modules/billing/index.ts"), "utf8");
    expect(t).toMatch(/pendingOperations/);
    for (const id of Object.keys(OPS)) expect(t, `billing pendingOperations lists ${id}`).toContain(id);
  });
});

describe("T0C-FINCTRL-1 migration file (static; behaviour in the pgTAP suite)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const noComments = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");
  const code = noComments;
  const outside = noComments.replace(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION[\s\S]*?\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, "-- function removed"); // everything except function bodies
  const NEWT = ["billing.discount_reason", "billing.party_discount_slab", "billing.user_discount_limit", "billing.discount_authority"];
  const re = (t: string) => t.replace(".", "\\.");

  it("exists, is the only 20261117190000 migration, sorts after the catalog import batches migration, runs as lims_owner", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all.filter((f) => f.startsWith("20261117190000"))).toEqual([MIG]);
    expect(all.indexOf(MIG)).toBeGreaterThan(all.indexOf("20261117180000_catalog__add_import_batches.sql"));
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("creates the four tables IF NOT EXISTS with ENABLE + FORCE row level security, a tenant policy, a grant to lims_app only and no DELETE grant", () => {
    for (const t of NEWT) {
      expect(code, `CREATE TABLE ${t}`).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${re(t)}\\b`, "i"));
      expect(code, `ENABLE RLS ${t}`).toMatch(new RegExp(`ALTER TABLE ${re(t)} ENABLE ROW LEVEL SECURITY`, "i"));
      expect(code, `FORCE RLS ${t}`).toMatch(new RegExp(`ALTER TABLE ${re(t)} FORCE ROW LEVEL SECURITY`, "i"));
      expect(code, `policy on ${t}`).toMatch(new RegExp(`CREATE POLICY[^;]*ON ${re(t)}\\b[^;]*app\\.current_tenant_id\\(\\)`, "is"));
      const g = code.match(new RegExp(`GRANT\\s+([^;]*?)\\s+ON\\s+${re(t)}\\s+TO\\s+lims_app`, "i"));
      expect(g, `GRANT lims_app ${t}`).not.toBeNull();
      expect(g![1], `${t}: no DELETE / ALL / TRUNCATE (deactivate, never delete)`).not.toMatch(/\bDELETE\b|\bALL\b|\bTRUNCATE\b/i);
    }
    expect(code).not.toMatch(/TO\s+(PUBLIC|anon|authenticated)\b/i);
  });
  it("the ledger gains ADD COLUMN IF NOT EXISTS held_reason, held_by, held_at, released_by, released_at, fiscal_year_label; cash_sessions gains previous_outstanding_cash_paisa and deposit_paisa (bigint NOT NULL DEFAULT 0)", () => {
    for (const c of ["held_reason", "held_by", "held_at", "released_by", "released_at", "fiscal_year_label"]) expect(code, `ledger.${c}`).toMatch(new RegExp(`ALTER TABLE billing\\.account_ledger_entries[^;]*ADD COLUMN IF NOT EXISTS ${c}\\b`, "is"));
    for (const c of ["previous_outstanding_cash_paisa", "deposit_paisa"]) expect(code, `cash_sessions.${c}`).toMatch(new RegExp(`ALTER TABLE billing\\.cash_sessions[^;]*ADD COLUMN IF NOT EXISTS ${c}\\s+bigint\\s+NOT NULL\\s+DEFAULT\\s+0`, "is"));
  });
  it("the ledger rule is in the database: the status check admits held, a guard trigger allows only submitted -> held and held -> submitted, the column grant to lims_app is limited to status and the hold columns", () => {
    expect(code).toMatch(/account_ledger_entries__status__ck/);
    expect(code).toMatch(/'held'/);
    expect(code).toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+\w+\s+BEFORE\s+UPDATE[^;]*ON\s+billing\.account_ledger_entries\b/i);
    const g = code.match(/GRANT\s+UPDATE\s*\(([^)]*)\)\s+ON\s+billing\.account_ledger_entries\s+TO\s+lims_app/i);
    expect(g, "column level UPDATE grant on the ledger").not.toBeNull();
    const cols = g![1].split(",").map((c) => c.trim()).sort();
    expect(cols).toEqual(["held_at", "held_by", "held_reason", "last_modified_by", "released_at", "released_by", "status", "updated_at"].sort());
    expect(code).not.toMatch(/GRANT\s+(ALL|UPDATE|DELETE)\s+ON\s+(TABLE\s+)?billing\.account_ledger_entries/i);
    expect(code).toMatch(/CREATE POLICY[^;]*ON billing\.account_ledger_entries\s+FOR UPDATE/i);
  });
  it("overlap of active slabs is refused in the database: EXCLUDE USING gist with CREATE EXTENSION IF NOT EXISTS btree_gist, or a BEFORE trigger under pg_advisory_xact_lock (btree_gist is not assumed in the pinned image: LD-321 precedent in 20261117200000)", () => {
    const gist = /EXCLUDE\s+USING\s+gist/i.test(code) && /CREATE EXTENSION IF NOT EXISTS btree_gist/i.test(code);
    const trig = /CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+\w+\s+BEFORE\s+INSERT\s+OR\s+UPDATE[^;]*ON\s+billing\.party_discount_slab\b/i.test(code) && /pg_advisory_xact_lock/i.test(noComments);
    expect(gist || trig, "no exclusion constraint and no advisory-locked overlap trigger").toBe(true);
    expect(code).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+IF NOT EXISTS\s+\S+\s+ON\s+billing\.user_discount_limit\s*\(\s*tenant_id\s*,\s*user_id\s*\)\s+WHERE\s+is_active/i);
  });
  it("the seed function billing.seed_discount_reasons(uuid, uuid) exists, pins search_path, is idempotent (ON CONFLICT DO NOTHING) and is granted to lims_app only", () => {
    expect(noComments).toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+billing\.seed_discount_reasons\s*\(\s*\w+\s+uuid\s*,\s*\w+\s+uuid\s*\)/i);
    const body = noComments.match(/FUNCTION\s+billing\.seed_discount_reasons[\s\S]*?\$([a-z_]*)\$[\s\S]*?\$\1\$/i)?.[0] ?? "";
    expect(body).toMatch(/SET\s+search_path\s*=\s*''/i);
    expect(body).toMatch(/ON CONFLICT[^;]*DO NOTHING/i);
    expect(body).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(code).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+billing\.seed_discount_reasons\s*\(\s*uuid\s*,\s*uuid\s*\)\s+TO\s+lims_app/i);
    expect(code).not.toMatch(/GRANT\s+EXECUTE[^;]*TO\s+(PUBLIC|anon|authenticated)/i);
  });
  it("is re-runnable: every CREATE TABLE and INDEX is IF NOT EXISTS (tenant_id first), policies are guarded, ADD CONSTRAINT / DROP CONSTRAINT sit in a DO block that checks pg_constraint, search_path pinned on every function", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect((code.match(/CREATE TABLE(?! IF NOT EXISTS)/gi) ?? []).length).toBe(0);
    for (const m of code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/gi)) throw new Error(`unguarded CREATE INDEX near ${m.index}`);
    for (const m of code.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF NOT EXISTS\s+\S+\s+ON\s+\S+\s*(?:USING\s+\w+\s*)?\(\s*(\w+)/gi)) expect(m[1], `index leads with tenant_id: ${m[0].slice(0, 80)}`).toBe("tenant_id");
    for (const m of code.matchAll(/CREATE\s+POLICY\s+(\S+)\s+ON\s+(\S+)/gi)) expect(code.slice(Math.max(0, m.index! - 700), m.index), `policy ${m[1]} is not idempotent`).toMatch(/pg_policy|DROP POLICY IF EXISTS/i);
    for (const m of code.matchAll(/(ADD|DROP)\s+CONSTRAINT/gi)) expect(code.slice(Math.max(0, m.index! - 700), m.index), "constraint change must sit in a DO block that checks pg_constraint").toMatch(/DO\s+\$[a-z_]*\$[\s\S]*pg_constraint/i);
    for (const m of noComments.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\S+)\s*\([^)]*\)[\s\S]*?\$([a-z_]*)\$[\s\S]*?\$\2\$/gi)) expect(m[0], `${m[1]} must pin search_path`).toMatch(/SET\s+search_path\s*=\s*''/i);
  });
  it("is additive: no DROP of data objects, no TRUNCATE / DELETE, no data statement outside function bodies, ALTER only ADD COLUMN IF NOT EXISTS (plus the guarded status check swap), no REVOKE, no float / numeric / money column", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect(code).not.toMatch(/\b(DROP\s+(TABLE|COLUMN|SCHEMA|INDEX|POLICY|TRIGGER|FUNCTION)|TRUNCATE|DELETE\s+FROM|REVOKE)\b/i);
    expect(outside).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET)\b/i);
    expect(code).not.toMatch(/\bCREATE\s+TYPE\b|\bAS\s+ENUM\b|DISABLE\s+ROW|NO\s+FORCE|RENAME|CREATE\s+SEQUENCE|ALTER\s+COLUMN/i);
    for (const m of code.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF EXISTS\s+)?(billing\.\w+)([^;]*);/gi)) {
      expect([...NEWT, "billing.account_ledger_entries", "billing.cash_sessions"], `ALTER of an unrelated table ${m[1]}`).toContain(m[1]);
      if (m[1] === "billing.account_ledger_entries" || m[1] === "billing.cash_sessions")
        expect(m[2], `${m[1]}: only ADD COLUMN IF NOT EXISTS, constraint swap, RLS or nothing else`).toMatch(/^\s*(ADD COLUMN IF NOT EXISTS[^;]*|ADD CONSTRAINT[^;]*|DROP CONSTRAINT[^;]*)$/is);
    }
    expect(code).not.toMatch(/\b(float|double precision|real|numeric|decimal|money)\b/i);
  });
  it("the cash_sessions mutable column trigger is re-created with deposit_paisa allowed and previous_outstanding_cash_paisa NOT allowed (set once at open)", () => {
    const m = code.match(/CREATE\s+OR\s+REPLACE\s+TRIGGER\s+cash_sessions__mutable_columns\b[^;]*enforce_mutable_columns\(([^)]*)\)/is);
    expect(m, "cash_sessions__mutable_columns must be re-created").not.toBeNull();
    expect(m![1]).toContain("'deposit_paisa'");
    expect(m![1]).not.toContain("previous_outstanding_cash_paisa");
    for (const c of ["status", "closed_at", "expected", "counted", "variance_paisa", "close_note", "updated_at", "updated_by", "version"]) expect(m![1], `keeps ${c}`).toContain(`'${c}'`);
    expect(m![0]).toMatch(/BEFORE\s+UPDATE/i);
  });
  it("audit triggers on the four new tables (tg_row_audit); comments: LD-321, tables, columns, held rule, down note with DROP TABLE / DROP COLUMN, additive, push-cloud founder step", () => {
    for (const t of NEWT) expect(code, `audit trigger ${t}`).toMatch(new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?TRIGGER\\s+${t.split(".")[1]}__audit\\b[^;]*ON ${re(t)}\\b[^;]*tg_row_audit`, "is"));
    expect(comments).toMatch(/LD-321/);
    expect(comments).toMatch(/\bdown\b/i);
    expect(comments).toMatch(/DROP TABLE/i);
    expect(comments).toMatch(/DROP COLUMN/i);
    for (const t of ["discount_reason", "party_discount_slab", "user_discount_limit", "discount_authority", "held_reason", "fiscal_year_label", "previous_outstanding_cash_paisa", "deposit_paisa"]) expect(comments, `down note names ${t}`).toContain(t);
    expect(comments).toMatch(/no data rewrite|does not rewrite|no rewrite|additive/i);
    expect(comments).toMatch(/push-cloud/i);
  });
});

// the labels of C:/LIMS-state/elabassist-accounting-20261117.md that the field map must decide one by one (done_when 1)
const FIELD_LABELS = [
  "Laboratory", "Franchise", "Client", "Transaction Date", "Particulars", "Amount", "Comments", "Financial Year", "Payment Mode", "Bank Details", "Payment Details", "Submit", "Search",
  "Bill", "Payment", "Cheque Bounce Charges", "Other Charges", "Additional Test", "Credit Note", "Cash", "CreditCard", "DebitCard", "Cheque", "Coupens", "Others", "Online", "Trade Discount",
  "Entry Date", "Type", "Last Modified By", "Entry Status",
  "Account Status", "Pending", "Initiated", "Verified", "Hold", "Approved", "Rejected", "Delete", "Credited", "Debited", "Reference Number", "Download Receipt", "Export to Excel",
  "Bill Of The Day", "Daily Payment Collection", "Deposit", "Collection Center Name", "User Name", "Cash Amount", "Credit Card Amount", "Debit Card Amount", "Coupons", "Online Amount", "DD Amount", "Deposit Amount", "Trade Discount Amount", "Previous Outstanding Cash",
  "Account Summary", "Is Auto Blocked", "Is Blocked", "PAN No", "Credit Limit", "Outstanding Amount", "Debit / Credit",
  "Client Ledger", "Opening Balance", "Year Balance", "Current Balance", "Allow Credit", "Credit Period", "Billing Period", "Rate Master",
  "Sub Admin Commission", "Lab Commission", "Price Allocation", "Invoice", "Pocket Payment", "Pay From Pocket", "Payment Status", "Overdue", "Archive", "Submit Discount", "Save Due",
  "Discount master", "Amount From", "Amount To", "Discount Percentage", "Account Group Master", "Account Particulars Master", "Expense", "Expense Type", "Cash Transfer",
  "Discount Reason", "Discount Authority", "Authorize person", "Discount Limit", "Account Ledger", "Pocket Ledger",
];
describe("T0C-FINCTRL-1 implementation notes: FIELD MAP, permissions, ledger rule, offline classification (done_when 1, 3, 9)", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  const lines = t.split("\n");
  it("notes exist, name the migration as a founder step (push-cloud), cite LD-321, list every operation id, the pendingOperations move and T0B-FINCTRL-1", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-FINCTRL-1-impl.md missing").toBe(true);
    expect(t).toContain(MIG);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/LD-321/);
    for (const id of Object.keys(OPS)) expect(t, id).toContain(id);
    expect(t).toMatch(/pendingOperations/);
    expect(t).toMatch(/T0B-FINCTRL-1/);
  });
  it("lists every new permission code and the role-pack re-apply founder step", () => {
    for (const c of NEW_CODES) expect(t, c).toContain(c);
    expect(t).toMatch(/apply-role-pack|role pack/i);
  });
  it("gives the offline classification (founder 09:19): master changes, hold and release are online only; resolveDiscountSlab and getMyDiscountPolicy are cacheable reads", () => {
    expect(t).toMatch(/offline/i);
    expect(t).toMatch(/online only/i);
    expect(t).toMatch(/cache/i);
    for (const w of [/resolveDiscountSlab/, /getMyDiscountPolicy/, /hold/i, /release/i, /master/i]) expect(t, String(w)).toMatch(w);
  });
  it("writes the ledger rule: balances, statements and summaries count only posted entries; held entries are listed apart until released; the append only rule stays (hold and release are the only status transitions besides reversal)", () => {
    expect(t).toMatch(/posted/i);
    expect(t).toMatch(/held/i);
    expect(t).toMatch(/listed apart|listed separately|listed on their own/i);
    expect(t).toMatch(/append[- ]only/i);
    expect(t).toMatch(/balances?/i);
    expect(t).toMatch(/statements?/i);
    expect(t).toMatch(/summar(y|ies)/i);
  });
  it("records the discount reasons seeded (the eight the evidence lists), the slab overlap rule, the fiscal year start default (Shrawan 1 BS, accountant confirms), carried forward cash rule and the frontdesk contradiction", () => {
    for (const n of ["Partner Family", "Partners friend and relatives", "Prescribed by Doctor", "Employees and family", "Employee relatives", "Regular patient", "Walking patient", "Gold membership"]) expect(t, n).toContain(n);
    expect(t).toMatch(/seed_discount_reasons/);
    expect(t).toMatch(/overlap/i);
    expect(t).toMatch(/Shrawan/i);
    expect(t).toMatch(/accountant/i);
    expect(t).toMatch(/carried forward|previous outstanding/i);
    expect(t).toMatch(/requestDiscountApproval/);
    expect(t).toMatch(/within_limit/);
    expect(t).toMatch(/frontdesk\.discount_reasons/);
    expect(t).toMatch(/is_active/);
  });
  it("every evidence field label has one decision line: present (field named), added (field named) or not added (reason)", () => {
    expect(t.length, "impl notes missing").toBeGreaterThan(0);
    const missing: string[] = [];
    for (const label of FIELD_LABELS) {
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
