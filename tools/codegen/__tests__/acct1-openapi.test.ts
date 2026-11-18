// T0C-ACCT-1 (LD-313; founder blanket authority LD-310, request 2026-11-17 04:57 NPT "do not leave any function") — lab accounting in the billing module:
// contracts/openapi/billing.yaml (24 additive operations), contracts/permissions.yaml (7 new codes, corp_admin pack), the migration 20261117120000_billing__add_lab_accounting.sql
// (static checks; behaviour is db/tests/frontdesk_billing/T0C-ACCT-1_lab_accounting.test.sql), codegen freshness, notes.
// ASSUMPTIONS (the brief names functions and fields, not ids; a different choice needs a ruling, not a silent test edit; same wire rules as T0C-REGPARITY-1/2 rulings):
//  - NAME COLLISION: billing.ledger_entries, /v1/billing/ledger-entries, listLedgerEntries and reverseLedgerEntry already exist (invoice payment ledger, C4). The accounting ledger is therefore
//    `billing.account_ledger_entries` / /v1/billing/account-ledger-entries / create|list|get|reverseAccountLedgerEntry. The old ledger is not touched.
//  - Table ids: account_groups, account_particulars, expense_types, account_ledger_entries, expenses, cash_transfers (all in schema billing). Permission codes: see PERMS.
//  - Wire rule: no field is `nullable`, closed objects, money = integer paisa (int64, >= 0, bounded); an amount that is posted is > 0 (minimum 1). A balance is a non-negative amount plus a side
//    (debit | credit), never a negative number. No float anywhere (no `type: number`).
//  - Server-owned, never accepted from a client: tenant_id, id, status, receipt_no, receipt_seq, created_by, last_modified_by, reverses_entry_id (reversal has its own operation), decided_by, decided_at.
//  - No new error code: duplicates and bad values -> common.validation_failed; version -> common.version_conflict; reversing twice or a reversal -> billing.ledger_reversal_invalid;
//    deciding a transfer that is no longer pending -> common.immutable_record.
//  - Masters: code and group are immutable after create (update body has name / is_active only, plus expense type particular); nature of a group is immutable (postings depend on it).
//  - Documented, not enforced in a schema: cash transfer accept posts a balanced pair in ONE transaction (LD-313 b) -> the accept operation says so.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = "20261117120000_billing__add_lab_accounting.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-ACCT-1-impl.md");
const load = (p: string): any => parse(readFileSync(join(ROOT, p), "utf8"));
const bl: any = load("contracts/openapi/billing.yaml");
const common: any = load("contracts/openapi/_common.yaml");
const registry: any = load("contracts/permissions.yaml");
const errors: any[] = load("contracts/errors.yaml");
const packs: any = load("services/api/src/modules/identity/role-packs/role-packs.data.yaml");
const BS = bl.components.schemas as Record<string, any>;
const METHODS = ["get", "put", "post", "delete", "patch"];

// ---- permissions (pinned; the founder reviews the list in the notes)
const PERMS: Record<string, { privileged: boolean; roles: string[] }> = {
  "billing.account.read": { privileged: false, roles: ["finance", "tenant_admin"] },
  "billing.account.manage": { privileged: true, roles: ["finance", "tenant_admin"] },
  "billing.account_entry.create": { privileged: false, roles: ["finance"] },
  "billing.account_entry.reverse": { privileged: true, roles: ["finance"] },
  "billing.expense.manage": { privileged: false, roles: ["finance"] },
  "billing.cash_transfer.manage": { privileged: false, roles: ["finance"] },
  "billing.cash_transfer.decide": { privileged: true, roles: ["finance"] },
};
const READ = "billing.account.read", MANAGE = "billing.account.manage", ENTRY = "billing.account_entry.create", REVERSE = "billing.account_entry.reverse";
const EXP = "billing.expense.manage", XFER = "billing.cash_transfer.manage", DECIDE = "billing.cash_transfer.decide";

type Op = { id: string; method: string; path: string; perm: string; idem: "none" | "optional" | "required"; status: number; im?: boolean; list?: boolean };
const P = "/v1/billing/";
const OPS: Op[] = [
  { id: "listAccountGroups", method: "get", path: P + "account-groups", perm: READ, idem: "none", status: 200, list: true },
  { id: "createAccountGroup", method: "post", path: P + "account-groups", perm: MANAGE, idem: "required", status: 201 },
  { id: "updateAccountGroup", method: "patch", path: P + "account-groups/{account_group_id}", perm: MANAGE, idem: "optional", status: 200, im: true },
  { id: "listAccountParticulars", method: "get", path: P + "account-particulars", perm: READ, idem: "none", status: 200, list: true },
  { id: "createAccountParticular", method: "post", path: P + "account-particulars", perm: MANAGE, idem: "required", status: 201 },
  { id: "updateAccountParticular", method: "patch", path: P + "account-particulars/{account_particular_id}", perm: MANAGE, idem: "optional", status: 200, im: true },
  { id: "listExpenseTypes", method: "get", path: P + "expense-types", perm: READ, idem: "none", status: 200, list: true },
  { id: "createExpenseType", method: "post", path: P + "expense-types", perm: MANAGE, idem: "required", status: 201 },
  { id: "updateExpenseType", method: "patch", path: P + "expense-types/{expense_type_id}", perm: MANAGE, idem: "optional", status: 200, im: true },
  { id: "createAccountLedgerEntry", method: "post", path: P + "account-ledger-entries", perm: ENTRY, idem: "required", status: 201 },
  { id: "listAccountLedgerEntries", method: "get", path: P + "account-ledger-entries", perm: READ, idem: "none", status: 200, list: true },
  { id: "getAccountLedgerEntry", method: "get", path: P + "account-ledger-entries/{account_ledger_entry_id}", perm: READ, idem: "none", status: 200 },
  { id: "reverseAccountLedgerEntry", method: "post", path: P + "account-ledger-entries/{account_ledger_entry_id}/reverse", perm: REVERSE, idem: "required", status: 201 },
  { id: "getAccountStatement", method: "get", path: P + "account-statement", perm: READ, idem: "none", status: 200 },
  { id: "getAccountSummary", method: "get", path: P + "account-summary", perm: READ, idem: "none", status: 200 },
  { id: "createExpense", method: "post", path: P + "expenses", perm: EXP, idem: "required", status: 201 },
  { id: "listExpenses", method: "get", path: P + "expenses", perm: READ, idem: "none", status: 200, list: true },
  { id: "cancelExpense", method: "post", path: P + "expenses/{expense_id}/cancel", perm: EXP, idem: "required", status: 200 },
  { id: "createCashTransfer", method: "post", path: P + "cash-transfers", perm: XFER, idem: "required", status: 201 },
  { id: "listCashTransfers", method: "get", path: P + "cash-transfers", perm: READ, idem: "none", status: 200, list: true },
  { id: "acceptCashTransfer", method: "post", path: P + "cash-transfers/{cash_transfer_id}/accept", perm: DECIDE, idem: "required", status: 200 },
  { id: "rejectCashTransfer", method: "post", path: P + "cash-transfers/{cash_transfer_id}/reject", perm: DECIDE, idem: "required", status: 200 },
  { id: "cancelCashTransfer", method: "post", path: P + "cash-transfers/{cash_transfer_id}/cancel", perm: XFER, idem: "required", status: 200 },
  { id: "getDailyCollectionSummary", method: "get", path: P + "daily-collection-summary", perm: READ, idem: "none", status: 200 },
];
// the 47 operations that existed before this task must all still be there
const BASELINE = ["listInvoices", "getInvoice", "listInvoicePrints", "printInvoice", "cancelInvoice", "issuePartialCreditNote", "listCreditNotes", "getCreditNote", "printCreditNote", "getOrderBilling",
  "recordPayment", "requestRefund", "createPaymentIntent", "verifyPaymentIntent", "createReleaseOverride", "getReleaseEligibility", "reverseLedgerEntry", "listLedgerEntries", "approveRefund",
  "rejectRefund", "listRefundRequests", "listDues", "getMyCashSession", "closeCashSession", "getDailyCash", "listCreditAccounts", "getCreditAccount", "updateCreditAccount", "listCreditCharges",
  "issuePeriodicInvoice", "recordCreditPartyPayment", "getCreditPartyStatement", "getSalesRegister", "getCancelledInvoiceRegister", "getCreditNoteRegister", "getAuditTrail", "createBillingExport",
  "getBillingExport", "getBillingExportContent", "listCbmsDocuments", "retryCbmsDocument", "getBillingSettings", "updateBillingSettings", "listBillingCodes", "listCreditNoteTasks",
  "listFinanceReviewItems", "resolveFinanceReviewItem"];

const opIndex = (d: any) => {
  const m: Record<string, { path: string; method: string; op: any }> = {};
  for (const [path, item] of Object.entries<any>(d.paths)) for (const method of METHODS) if (item[method]) m[item[method].operationId] = { path, method, op: item[method] };
  return m;
};
const BOPS = opIndex(bl);
const deref = (s: any): any => {
  let cur = s;
  for (let i = 0; i < 6 && cur?.$ref; i++) {
    if (cur.$ref.startsWith("#/components/schemas/")) cur = BS[cur.$ref.split("/").pop()!];
    else if (cur.$ref.startsWith("_common.yaml#/components/schemas/")) cur = common.components.schemas[cur.$ref.split("/").pop()!];
    else break;
  }
  return cur;
};
const bodyOf = (id: string, which: "req" | "res"): any => {
  const op = BOPS[id]?.op;
  return which === "req" ? op?.requestBody?.content?.["application/json"] : op?.responses?.[String(OPS.find((o) => o.id === id)?.status)]?.content?.["application/json"];
};
const schemaOf = (id: string, which: "req" | "res") => deref(bodyOf(id, which)?.schema);
const itemOf = (id: string) => deref(schemaOf(id, "res").properties.data.items);
const isPaisa = (p: any, min = 0) => { const d = deref(p); return d?.type === "integer" && d?.format === "int64" && d?.minimum >= min && Number.isInteger(d?.maximum); };
const param = (id: string, name: string) => (BOPS[id].op.parameters ?? []).map(deref).find((p: any) => p?.name === name);

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ ...common, id: "_common.yaml" });
ajv.addSchema({ ...bl, id: "billing.yaml" });
const validator = (name: string) => { const v = ajv.getSchema(`billing.yaml#/components/schemas/${name}`); expect(v, `cannot resolve billing:${name}`).toBeDefined(); return v!; };
const reqValidator = (id: string) => validator(bodyOf(id, "req").schema.$ref.split("/").pop());

// every schema name reachable from the 24 operations (request, responses)
const reach = (): Set<string> => {
  const seen = new Set<string>();
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.$ref === "string" && n.$ref.startsWith("#/components/schemas/")) {
      const k = n.$ref.split("/").pop()!;
      if (!seen.has(k)) { seen.add(k); walk(BS[k]); }
      return;
    }
    for (const v of Object.values(n)) walk(v);
  };
  for (const o of OPS) { const e = BOPS[o.id]; if (e) walk([e.op.requestBody, e.op.responses, e.op.parameters]); }
  return seen;
};

describe("T0C-ACCT-1 contract: lint, baseline kept, additive", () => {
  it("lintRepo reports no violation for billing.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "billing.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });
  it("billing.yaml keeps all 47 old operations; +24 new = 71 operations on 63 paths; the old ledger-entries operations are untouched", () => {
    for (const id of BASELINE) expect(BOPS[id], `${id} removed`).toBeDefined();
    expect(OPS.length).toBe(24);
    // T0C-ACCTLIST-1 (LD-358): +1 operation listAccountSummaries on +1 path /v1/billing/account-summaries (pinned in acctlist1-openapi.test.ts)
    expect(Object.keys(BOPS).length).toBe(47 + OPS.length + 1);
    expect(Object.keys(bl.paths).length).toBe(45 + 18 + 1);
    expect(BOPS.listLedgerEntries.path).toBe("/v1/billing/ledger-entries");
    expect(BOPS.reverseLedgerEntry.path).toBe("/v1/billing/ledger-entries/{ledger_entry_id}/reverse");
    expect(BOPS.reverseLedgerEntry.op["x-permission"]).toBe("billing.payment.reverse");
  });
  it("old required lists are unchanged", () => {
    expect(BS.LedgerEntryDto.required).toEqual(["id", "entry_kind", "capture_kind", "method_code", "amount", "created_at", "business_date_bs"]);
    expect(BS.RecordPaymentRequest.required).toEqual(["method_code", "amount_received_paisa"]);
  });
  it("every new operation id is unique and none of the 24 collides with an old one", () => {
    expect(new Set(OPS.map((o) => o.id)).size).toBe(24);
    for (const o of OPS) expect(BASELINE).not.toContain(o.id);
  });
});

describe("T0C-ACCT-1 contract: the 24 new operations", () => {
  describe.each(OPS)("$id", (r) => {
    const e = BOPS[r.id];
    it("exists at the pinned method + path, tag billing", () => {
      expect(e, `${r.id} missing`).toBeDefined();
      expect(e.method).toBe(r.method);
      expect(e.path).toBe(r.path);
      expect(e.op.tags).toEqual(["billing"]);
      expect(typeof e.op.summary).toBe("string");
      for (const m of r.path.matchAll(/\{(\w+)\}/g)) expect(JSON.stringify(e.op.parameters), `path param ${m[1]}`).toContain(`"name":"${m[1]}"`);
    });
    it(`x-permission ${r.perm}, x-idempotency ${r.idem}, tier general, bearer, tenant context`, () => {
      expect(e.op["x-permission"]).toBe(r.perm);
      expect(Object.keys(PERMS)).toContain(r.perm);
      expect(e.op["x-public"]).toBeUndefined();
      expect(e.op["x-idempotency"]).toBe(r.idem);
      expect(e.op["x-rate-limit-tier"]).toBe("general");
      expect(e.op.security).toEqual([{ bearerJwt: [] }]);
      expect([undefined, "tenant"]).toContain(e.op["x-context"]);
    });
    it(`success ${r.status}; common errors listed and all registered; Idempotency-Key / If-Match as declared; no tenant_id parameter`, () => {
      expect(Object.keys(e.op.responses)).toContain(String(r.status));
      const registered = new Set(errors.map((x: any) => x.code));
      for (const c of ["common.validation_failed", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"]) expect(e.op["x-error-codes"], c).toContain(c);
      for (const c of e.op["x-error-codes"]) expect(registered.has(c), `${c} is not in contracts/errors.yaml (no new error code in this task)`).toBe(true);
      if (/\{/.test(r.path)) expect(e.op["x-error-codes"]).toContain("common.not_found");
      const params = JSON.stringify(e.op.parameters ?? []);
      if (r.idem === "required") expect(params).toMatch(/IdempotencyKey|Idempotency-Key/); else expect(params).not.toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.im) { expect(params).toMatch(/IfMatch|If-Match/); expect(e.op["x-error-codes"]).toEqual(expect.arrayContaining(["common.version_conflict", "common.precondition_required"])); }
      else expect(params).not.toMatch(/IfMatch|If-Match/);
      expect(params).not.toMatch(/"name":"tenant_id"/);
    });
    it("has a synthetic example on every JSON request and 2xx response, and it validates", () => {
      const media: any[] = [];
      if (e.op.requestBody?.content?.["application/json"]) media.push(e.op.requestBody.content["application/json"]);
      for (const [c, resp] of Object.entries<any>(e.op.responses)) if (/^2/.test(c) && !resp.$ref && resp.content?.["application/json"]) media.push(resp.content["application/json"]);
      expect(media.length, "a JSON 2xx response").toBeGreaterThan(0);
      for (const m of media) {
        const ex = Object.values<any>(m.examples ?? {}).map((x) => x.value);
        expect(ex.length, "example").toBeGreaterThan(0);
        const key = m.schema?.$ref?.startsWith("#/components/schemas/") ? m.schema.$ref.split("/").pop() : null;
        if (key) { const v = validator(key); for (const x of ex) expect(v(x), `${r.id} example vs ${key}: ${JSON.stringify(v.errors?.[0])}`).toBe(true); }
        const blob = JSON.stringify(ex);
        expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
        expect(blob).not.toMatch(/(?<!\d)(?:\+?977[-\s]?)?9[678]\d{8}(?!\d)/);
        expect(blob, "no card-like number in an example").not.toMatch(/\d{13,19}/);
      }
    });
  });
  it("list operations take cursor + limit and return { data: bounded array, page }", () => {
    for (const r of OPS.filter((o) => o.list)) {
      const ps = JSON.stringify(BOPS[r.id].op.parameters ?? []);
      expect(ps, r.id).toMatch(/cursor|Cursor/);
      expect(ps, r.id).toMatch(/limit|Limit/);
      expect(BOPS[r.id].op["x-error-codes"], r.id).toContain("common.invalid_cursor");
      const s = schemaOf(r.id, "res");
      expect(s?.additionalProperties, r.id).toBe(false);
      expect(s?.required, r.id).toEqual(expect.arrayContaining(["data", "page"]));
      expect(s?.properties?.data?.type, r.id).toBe("array");
      expect(typeof s?.properties?.data?.maxItems, `${r.id} data.maxItems`).toBe("number");
    }
  });
});

describe("T0C-ACCT-1 contract: money is integer paisa, objects are closed, nothing is nullable", () => {
  it("every schema reachable from the new operations is closed, has no nullable and no float", () => {
    const names = [...reach()].filter((n) => !["PageInfo", "FieldError"].includes(n));
    expect(names.length).toBeGreaterThan(15);
    const bad: string[] = [];
    const walk = (n: any, where: string) => {
      if (!n || typeof n !== "object" || n.$ref) return;
      if (n.type === "object" && n.additionalProperties !== false) bad.push(`${where}: object not closed`);
      if (n.nullable === true) bad.push(`${where}: nullable`);
      if (n.type === "number") bad.push(`${where}: float (type: number)`);
      for (const [k, v] of Object.entries<any>(n.properties ?? {})) {
        // LD-334 / CR-C0-ACCT-2: the daily collection summary is a signed net, so these two schemas allow negative paisa (pinned in acctfix1-openapi.test.ts)
        const signed = where === "DailyCollectionRow" || where === "DailyCollectionSummary";
        if (/_paisa$/.test(k) && !isPaisa(v, signed ? -9007199254740991 : 0)) bad.push(`${where}.${k}: not integer int64 >= 0 with a maximum`);
        walk(v, `${where}.${k}`);
      }
      if (n.items) walk(n.items, `${where}[]`);
    };
    for (const n of names) walk(BS[n], n);
    expect(bad).toEqual([]);
  });
  it("query parameters named *_paisa do not exist and every string has a bound (maxLength / enum / format)", () => {
    for (const o of OPS) for (const p of (BOPS[o.id].op.parameters ?? []).map(deref)) {
      expect(p.name, o.id).not.toMatch(/_paisa$/);
      const s = deref(p.schema);
      if (s?.type === "string") expect(s.maxLength !== undefined || s.enum !== undefined || s.format !== undefined, `${o.id}?${p.name} unbounded string`).toBe(true);
    }
  });
});

describe("T0C-ACCT-1 contract: masters (account groups, particulars, expense types)", () => {
  it("account group: code, name, nature (income|expense|asset|liability), is_active, version; create requires code+name+nature; update cannot change code or nature", () => {
    const item = itemOf("listAccountGroups");
    for (const f of ["id", "code", "name", "nature", "is_active", "version"]) expect(item.properties[f], `group.${f}`).toBeDefined();
    expect([...deref(item.properties.nature).enum].sort()).toEqual(["asset", "expense", "income", "liability"]);
    const c = schemaOf("createAccountGroup", "req");
    expect(c.required).toEqual(expect.arrayContaining(["code", "name", "nature"]));
    for (const f of ["tenant_id", "id", "version"]) expect(c.properties[f], `create must not take ${f}`).toBeUndefined();
    expect(deref(c.properties.code).maxLength).toBeLessThanOrEqual(32);
    expect(deref(c.properties.name).maxLength).toBeLessThanOrEqual(200);
    const u = schemaOf("updateAccountGroup", "req");
    for (const f of ["code", "nature", "tenant_id", "id"]) expect(u.properties[f], `update must not change ${f}`).toBeUndefined();
    for (const f of ["name", "is_active"]) expect(u.properties[f], `update.${f}`).toBeDefined();
    expect(u.required ?? [], "update body has nothing required (partial)").toEqual([]);
  });
  it("account particular: account_group_id, code, name, is_active, version; create requires group+code+name; update cannot move it to another group", () => {
    const item = itemOf("listAccountParticulars");
    for (const f of ["id", "account_group_id", "code", "name", "is_active", "version"]) expect(item.properties[f], `particular.${f}`).toBeDefined();
    const c = schemaOf("createAccountParticular", "req");
    expect(c.required).toEqual(expect.arrayContaining(["account_group_id", "code", "name"]));
    expect(JSON.stringify(c.properties.account_group_id)).toContain("Uuid");
    const u = schemaOf("updateAccountParticular", "req");
    for (const f of ["code", "account_group_id", "tenant_id"]) expect(u.properties[f], `update must not change ${f}`).toBeUndefined();
    for (const f of ["name", "is_active"]) expect(u.properties[f], `update.${f}`).toBeDefined();
    expect(param("listAccountParticulars", "account_group_id"), "filter by group").toBeDefined();
  });
  it("expense type: name, account_particular_id, is_active, version; create requires name + particular", () => {
    const item = itemOf("listExpenseTypes");
    for (const f of ["id", "name", "account_particular_id", "is_active", "version"]) expect(item.properties[f], `expense_type.${f}`).toBeDefined();
    const c = schemaOf("createExpenseType", "req");
    expect(c.required).toEqual(expect.arrayContaining(["name", "account_particular_id"]));
    const u = schemaOf("updateExpenseType", "req");
    for (const f of ["name", "account_particular_id", "is_active"]) expect(u.properties[f], `update.${f}`).toBeDefined();
    expect(u.properties.tenant_id).toBeUndefined();
  });
  it("master payloads: valid ones pass, junk fails (closed, enum, bounds)", () => {
    const g = reqValidator("createAccountGroup");
    expect(g({ code: "INCOME_LAB", name: "Laboratory income", nature: "income" }), JSON.stringify(g.errors?.[0])).toBe(true);
    for (const bad of [{ code: "X", name: "x", nature: "equity" }, { code: "X", name: "x" }, { code: "X", name: "x", nature: "income", tenant_id: "t" }, { code: "", name: "x", nature: "asset" }, { code: "X", name: "x".repeat(500), nature: "asset" }])
      expect(g(bad), JSON.stringify(bad).slice(0, 70)).toBe(false);
    const t = reqValidator("createExpenseType");
    expect(t({ name: "Electricity", account_particular_id: "0193c4a0-0000-7000-8000-000000000810" }), JSON.stringify(t.errors?.[0])).toBe(true);
    expect(t({ name: "Electricity" })).toBe(false);
  });
});

describe("T0C-ACCT-1 contract: account ledger entries", () => {
  const PARTY = ["credit_party", "franchise", "laboratory", "user_pocket"];
  const create = () => schemaOf("createAccountLedgerEntry", "req");
  it("create takes centre, party, date, particular, type, amount, payment mode; optional bank, reference, details, comments; nothing server-owned", () => {
    const s = create();
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(expect.arrayContaining(["centre_id", "party_kind", "party_id", "entry_date", "account_particular_id", "entry_type", "amount_paisa", "payment_mode"]));
    for (const f of ["bank_name", "reference_no", "payment_details", "comments"]) { expect(s.properties[f], f).toBeDefined(); expect(s.required, `${f} optional`).not.toContain(f); expect(deref(s.properties[f]).type).toBe("string"); }
    for (const f of ["tenant_id", "id", "status", "receipt_no", "receipt_seq", "created_by", "last_modified_by", "reverses_entry_id", "created_at"]) expect(s.properties[f], `create must not take ${f}`).toBeUndefined();
    expect([...deref(s.properties.party_kind).enum].sort()).toEqual(PARTY);
    expect([...deref(s.properties.entry_type).enum].sort()).toEqual(["credit", "debit"]);
    expect(isPaisa(s.properties.amount_paisa, 1), "amount_paisa is int64 paisa with minimum 1 (> 0) and a maximum").toBe(true);
    expect(JSON.stringify(s.properties.entry_date)).toContain("IsoDate");
    for (const f of ["bank_name", "reference_no", "payment_details", "comments", "payment_mode"]) expect(deref(s.properties[f]).maxLength, `${f} maxLength`).toBeLessThanOrEqual(2000);
    expect(deref(s.properties.reference_no).maxLength).toBeLessThanOrEqual(100);
  });
  it("create validates: a credit and a debit pass; zero, negative, fractional, string, unknown party or type, unknown field fail", () => {
    const v = reqValidator("createAccountLedgerEntry");
    const ok = { centre_id: "0193c4a0-0000-7000-8000-000000000811", party_kind: "credit_party", party_id: "0193c4a0-0000-7000-8000-000000000812", entry_date: "2026-11-17",
      account_particular_id: "0193c4a0-0000-7000-8000-000000000813", entry_type: "credit", amount_paisa: 150000, payment_mode: "bank_transfer" };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ ...ok, entry_type: "debit", bank_name: "Synthetic Bank", reference_no: "SYN-REF-1", payment_details: "synthetic", comments: "synthetic" })).toBe(true);
    for (const bad of [{ amount_paisa: 0 }, { amount_paisa: -5 }, { amount_paisa: 1.5 }, { amount_paisa: "100" }, { amount_paisa: null }, { party_kind: "vendor" }, { entry_type: "transfer" }, { status: "approved" },
      { receipt_no: "R1" }, { tenant_id: "0193c4a0-0000-7000-8000-000000000899" }, { entry_date: "17-11-2026" }, { comments: "x".repeat(5000) }]) expect(v({ ...ok, ...bad }), JSON.stringify(bad)).toBe(false);
    for (const f of Object.keys(ok)) { const { [f]: _d, ...rest } = ok as any; expect(v(rest), `missing ${f} accepted`).toBe(false); }
  });
  it("read shape: all stored fields, status enum, receipt_no, reverses_entry_id, no tenant_id", () => {
    const item = itemOf("listAccountLedgerEntries");
    expect(item.additionalProperties).toBe(false);
    for (const f of ["id", "centre_id", "party_kind", "party_id", "entry_date", "account_particular_id", "entry_type", "amount_paisa", "payment_mode", "bank_name", "reference_no", "payment_details", "comments",
      "status", "reverses_entry_id", "receipt_no", "created_by", "last_modified_by", "created_at"]) expect(item.properties[f], `entry.${f}`).toBeDefined();
    for (const f of ["id", "centre_id", "party_kind", "party_id", "entry_date", "account_particular_id", "entry_type", "amount_paisa", "status", "receipt_no", "created_at"]) expect(item.required, `entry.${f} required`).toContain(f);
    expect([...deref(item.properties.status).enum].sort()).toEqual(["approved", "rejected", "reversed", "submitted"]);
    expect(item.properties.tenant_id).toBeUndefined();
    expect(JSON.stringify(item.properties.created_at)).toContain("IsoUtc");
    expect(JSON.stringify(schemaOf("getAccountLedgerEntry", "res"))).toBe(JSON.stringify(item));
    expect(JSON.stringify(schemaOf("createAccountLedgerEntry", "res"))).toBe(JSON.stringify(item));
  });
  it("list filters: centre_id, party_kind, party_id, particular, entry_type, status, entry_date range; there is no update or delete operation for entries", () => {
    for (const p of ["centre_id", "party_kind", "party_id", "account_particular_id", "entry_type", "status", "entry_date_from", "entry_date_to"]) expect(param("listAccountLedgerEntries", p), `filter ${p}`).toBeDefined();
    const mine = Object.values(BOPS).filter((x) => /account-ledger-entries/.test(x.path));
    expect(mine.map((x) => x.method).sort()).toEqual(["get", "get", "post", "post"]);
    expect(mine.some((x) => x.method === "put" || x.method === "patch" || x.method === "delete")).toBe(false);
  });
  it("reverse: a body with a required reason_text, returns the NEW reversal entry (201); says append only and one reversal per entry; error billing.ledger_reversal_invalid", () => {
    const b = schemaOf("reverseAccountLedgerEntry", "req");
    expect(b.additionalProperties).toBe(false);
    expect(b.required).toContain("reason_text");
    expect(deref(b.properties.reason_text).maxLength).toBeLessThanOrEqual(500);
    for (const f of ["amount_paisa", "tenant_id", "entry_type", "status"]) expect(b.properties[f], `reverse must not take ${f}`).toBeUndefined();
    expect(BOPS.reverseAccountLedgerEntry.op["x-error-codes"]).toContain("billing.ledger_reversal_invalid");
    expect(BOPS.reverseAccountLedgerEntry.op["x-error-codes"]).toContain("common.idempotency_key_reused");
    const d = `${BOPS.reverseAccountLedgerEntry.op.description ?? ""} ${BOPS.createAccountLedgerEntry.op.description ?? ""}`;
    expect(d).toMatch(/append[- ]only|never (updated|edited|deleted)/i);
    expect(d).toMatch(/reversal/i);
    const ex = Object.values<any>(bodyOf("reverseAccountLedgerEntry", "res").examples).map((x) => x.value);
    for (const e of ex) expect(typeof e.reverses_entry_id).toBe("string");
  });
  it("create error codes: unknown party / particular -> not_found; credit limit and blocked party are NOT enforced here (records only, no money moves)", () => {
    const codes = BOPS.createAccountLedgerEntry.op["x-error-codes"];
    expect(codes).toContain("common.not_found");
    expect(codes).toContain("common.idempotency_key_reused");
    expect(JSON.stringify(BOPS.createAccountLedgerEntry.op)).toMatch(/records only|only records|no money (is )?moved|does not move money/i);
  });
});

describe("T0C-ACCT-1 contract: statement, summary, daily collection", () => {
  it("getAccountStatement: required party_kind, party_id, from, to; returns opening balance, rows with running balance, closing balance and totals", () => {
    for (const p of ["party_kind", "party_id", "from", "to"]) { const q = param("getAccountStatement", p); expect(q, p).toBeDefined(); expect(q.in).toBe("query"); expect(q.required, `${p} required`).toBe(true); }
    expect(JSON.stringify(param("getAccountStatement", "from").schema)).toContain("IsoDate");
    const s = schemaOf("getAccountStatement", "res");
    expect(s.additionalProperties).toBe(false);
    for (const f of ["party_kind", "party_id", "from", "to", "opening_balance_paisa", "opening_balance_side", "rows", "closing_balance_paisa", "closing_balance_side", "total_credit_paisa", "total_debit_paisa"]) {
      expect(s.properties[f], f).toBeDefined(); expect(s.required, `${f} required`).toContain(f);
    }
    for (const f of ["opening_balance_paisa", "closing_balance_paisa", "total_credit_paisa", "total_debit_paisa"]) expect(isPaisa(s.properties[f]), `${f} paisa`).toBe(true);
    for (const f of ["opening_balance_side", "closing_balance_side"]) expect([...deref(s.properties[f]).enum].sort()).toEqual(["credit", "debit"]);
    expect(s.properties.rows.type).toBe("array");
    expect(typeof s.properties.rows.maxItems).toBe("number");
    const row = deref(s.properties.rows.items);
    expect(row.additionalProperties).toBe(false);
    for (const f of ["entry_id", "entry_date", "receipt_no", "entry_type", "credit_paisa", "debit_paisa", "balance_paisa", "balance_side", "status"]) { expect(row.properties[f], `row.${f}`).toBeDefined(); expect(row.required, `row.${f} required`).toContain(f); }
    for (const f of ["credit_paisa", "debit_paisa", "balance_paisa"]) expect(isPaisa(row.properties[f]), `row.${f} paisa`).toBe(true);
    expect([...deref(row.properties.balance_side).enum].sort()).toEqual(["credit", "debit"]);
    const d = `${BOPS.getAccountStatement.op.description ?? ""} ${s.description ?? ""}`;
    expect(d).toMatch(/running balance/i);
    expect(d).toMatch(/opening balance/i);
    expect(d).toMatch(/reversal/i);
  });
  it("statement example is internally consistent: opening + credits - debits = closing, and rows carry a running balance", () => {
    const ex = Object.values<any>(bodyOf("getAccountStatement", "res").examples).map((x) => x.value);
    expect(ex.length).toBeGreaterThan(0);
    const sgn = (amt: number, side: string) => (side === "credit" ? amt : -amt);
    for (const e of ex) {
      const closing = sgn(e.opening_balance_paisa, e.opening_balance_side) + e.total_credit_paisa - e.total_debit_paisa;
      expect(sgn(e.closing_balance_paisa, e.closing_balance_side), "closing = opening + credits - debits").toBe(closing);
      expect(e.rows.reduce((a: number, r: any) => a + r.credit_paisa, 0)).toBe(e.total_credit_paisa);
      expect(e.rows.reduce((a: number, r: any) => a + r.debit_paisa, 0)).toBe(e.total_debit_paisa);
      let run = sgn(e.opening_balance_paisa, e.opening_balance_side);
      for (const r of e.rows) { run += r.credit_paisa - r.debit_paisa; expect(sgn(r.balance_paisa, r.balance_side), `row ${r.entry_id} running balance`).toBe(run); }
    }
  });
  it("getAccountSummary: required party_kind + party_id; returns credit limit, outstanding, side, blocked flag", () => {
    for (const p of ["party_kind", "party_id"]) expect(param("getAccountSummary", p)?.required, p).toBe(true);
    const s = schemaOf("getAccountSummary", "res");
    expect(s.additionalProperties).toBe(false);
    for (const f of ["party_kind", "party_id", "credit_limit_paisa", "outstanding_paisa", "outstanding_side", "is_blocked"]) { expect(s.properties[f], f).toBeDefined(); expect(s.required, `${f} required`).toContain(f); }
    expect(isPaisa(s.properties.credit_limit_paisa)).toBe(true);
    expect(isPaisa(s.properties.outstanding_paisa)).toBe(true);
    expect([...deref(s.properties.outstanding_side).enum].sort()).toEqual(["credit", "debit"]);
    expect(s.properties.is_blocked.type).toBe("boolean");
  });
  it("getDailyCollectionSummary: required centre_id + day; rows by payment mode with totals", () => {
    for (const p of ["centre_id", "day"]) expect(param("getDailyCollectionSummary", p)?.required, p).toBe(true);
    expect(JSON.stringify(param("getDailyCollectionSummary", "day").schema)).toContain("IsoDate");
    const s = schemaOf("getDailyCollectionSummary", "res");
    expect(s.additionalProperties).toBe(false);
    for (const f of ["centre_id", "day", "rows", "total_paisa"]) { expect(s.properties[f], f).toBeDefined(); expect(s.required, f).toContain(f); }
    expect(typeof s.properties.rows.maxItems).toBe("number");
    const row = deref(s.properties.rows.items);
    for (const f of ["payment_mode", "entry_count", "total_paisa"]) { expect(row.properties[f], `row.${f}`).toBeDefined(); expect(row.required, `row.${f}`).toContain(f); }
    // LD-334 / CR-C0-ACCT-2: signed net, minimum below 0 (the old pin was minimum 0 and is stale)
    expect(isPaisa(row.properties.total_paisa, -9007199254740991)).toBe(true);
    expect(isPaisa(s.properties.total_paisa, -9007199254740991)).toBe(true);
    const ex = Object.values<any>(bodyOf("getDailyCollectionSummary", "res").examples).map((x) => x.value);
    for (const e of ex) expect(e.rows.reduce((a: number, r: any) => a + r.total_paisa, 0), "total = sum of rows").toBe(e.total_paisa);
  });
});

describe("T0C-ACCT-1 contract: expenses and cash transfers", () => {
  it("expense: create takes centre, time, type, amount (> 0), optional description; read has ledger_entry_id and cancelled_at; cancel takes an optional reason only", () => {
    const c = schemaOf("createExpense", "req");
    expect(c.additionalProperties).toBe(false);
    expect(c.required).toEqual(expect.arrayContaining(["centre_id", "expense_at", "expense_type_id", "amount_paisa"]));
    expect(c.required).not.toContain("description");
    expect(isPaisa(c.properties.amount_paisa, 1)).toBe(true);
    expect(JSON.stringify(c.properties.expense_at)).toContain("IsoUtc");
    for (const f of ["tenant_id", "id", "ledger_entry_id", "cancelled_at", "created_by"]) expect(c.properties[f], `create must not take ${f}`).toBeUndefined();
    const item = itemOf("listExpenses");
    for (const f of ["id", "centre_id", "expense_at", "expense_type_id", "amount_paisa", "description", "ledger_entry_id", "cancelled_at", "created_at"]) expect(item.properties[f], `expense.${f}`).toBeDefined();
    expect(item.required).toEqual(expect.arrayContaining(["id", "centre_id", "expense_at", "expense_type_id", "amount_paisa"]));
    expect(item.required, "ledger_entry_id and cancelled_at are optional on the wire").not.toEqual(expect.arrayContaining(["cancelled_at"]));
    for (const p of ["centre_id", "expense_type_id", "expense_at_from", "expense_at_to"]) expect(param("listExpenses", p), `filter ${p}`).toBeDefined();
    const cancel = bodyOf("cancelExpense", "req");
    if (cancel) { const s = deref(cancel.schema); expect(s.additionalProperties).toBe(false); expect(s.required ?? []).toEqual([]); expect(s.properties.reason_text).toBeDefined(); }
    expect(BOPS.cancelExpense.op["x-error-codes"]).toContain("common.immutable_record");
    expect(Object.values(BOPS).filter((x) => /\/expenses/.test(x.path) && x.method === "delete")).toEqual([]);
    const v = reqValidator("createExpense");
    const ok = { centre_id: "0193c4a0-0000-7000-8000-000000000820", expense_at: "2026-11-17T04:15:00.000Z", expense_type_id: "0193c4a0-0000-7000-8000-000000000821", amount_paisa: 25000 };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ amount_paisa: 0 }, { amount_paisa: -1 }, { amount_paisa: 2.5 }, { cancelled_at: "2026-11-17T04:15:00.000Z" }, { ledger_entry_id: "0193c4a0-0000-7000-8000-000000000822" }, { description: "x".repeat(5000) }])
      expect(v({ ...ok, ...bad }), JSON.stringify(bad)).toBe(false);
  });
  it("cash transfer: from/to are user or centre; amount > 0; status pending|accepted|rejected|cancelled; decided_by / decided_at are read-only", () => {
    const c = schemaOf("createCashTransfer", "req");
    expect(c.additionalProperties).toBe(false);
    expect(c.required).toEqual(expect.arrayContaining(["from_kind", "from_id", "to_kind", "to_id", "amount_paisa"]));
    expect(c.required).not.toContain("remark");
    for (const f of ["from_kind", "to_kind"]) expect([...deref(c.properties[f]).enum].sort()).toEqual(["centre", "user"]);
    expect(isPaisa(c.properties.amount_paisa, 1)).toBe(true);
    for (const f of ["tenant_id", "id", "status", "decided_by", "decided_at"]) expect(c.properties[f], `create must not take ${f}`).toBeUndefined();
    const item = itemOf("listCashTransfers");
    for (const f of ["id", "from_kind", "from_id", "to_kind", "to_id", "amount_paisa", "status", "remark", "decided_by", "decided_at", "created_at"]) expect(item.properties[f], `transfer.${f}`).toBeDefined();
    expect([...deref(item.properties.status).enum].sort()).toEqual(["accepted", "cancelled", "pending", "rejected"]);
    for (const p of ["status", "from_id", "to_id"]) expect(param("listCashTransfers", p), `filter ${p}`).toBeDefined();
    const v = reqValidator("createCashTransfer");
    const ok = { from_kind: "user", from_id: "0193c4a0-0000-7000-8000-000000000830", to_kind: "centre", to_id: "0193c4a0-0000-7000-8000-000000000831", amount_paisa: 500000, remark: "synthetic" };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ amount_paisa: 0 }, { amount_paisa: -1 }, { from_kind: "bank" }, { status: "accepted" }, { decided_by: "0193c4a0-0000-7000-8000-000000000832" }, { remark: "x".repeat(3000) }]) expect(v({ ...ok, ...bad }), JSON.stringify(bad)).toBe(false);
  });
  it("accept / reject / cancel return the transfer; accept says it posts a balanced pair in one transaction; a decided transfer cannot be decided again (common.immutable_record); self decision is documented", () => {
    for (const id of ["acceptCashTransfer", "rejectCashTransfer", "cancelCashTransfer"]) {
      expect(JSON.stringify(schemaOf(id, "res"))).toBe(JSON.stringify(itemOf("listCashTransfers")));
      expect(BOPS[id].op["x-error-codes"], id).toContain("common.immutable_record");
      const b = bodyOf(id, "req");
      if (b) { const s = deref(b.schema); expect(s.additionalProperties, id).toBe(false); expect(s.required ?? [], id).toEqual([]); }
    }
    expect(String(BOPS.acceptCashTransfer.op.description ?? "")).toMatch(/balanced pair/i);
    expect(String(BOPS.acceptCashTransfer.op.description ?? "")).toMatch(/one transaction|single transaction|same transaction/i);
    expect(`${BOPS.acceptCashTransfer.op.description ?? ""} ${BOPS.cancelCashTransfer.op.description ?? ""}`).toMatch(/sender|requester|creator/i);
    expect(Object.values(BOPS).filter((x) => /\/cash-transfers/.test(x.path) && (x.method === "delete" || x.method === "patch" || x.method === "put"))).toEqual([]);
  });
});

describe("T0C-ACCT-1 permissions (new codes allowed for this module only, LD-313 c)", () => {
  const byCode = new Map<string, any>(registry.permissions.map((p: any) => [p.code, p]));
  it.each(Object.entries(PERMS))("%s is in contracts/permissions.yaml with the owning roles and the privileged flag", (code, want) => {
    const p = byCode.get(code);
    expect(p, `${code} missing from contracts/permissions.yaml`).toBeDefined();
    expect(p.privileged).toBe(want.privileged);
    for (const r of want.roles) expect(p.roles, `${code} role ${r}`).toContain(r);
    const known = new Set(registry.roles.map((r: any) => r.code));
    for (const r of p.roles) expect(known.has(r), `${code} unknown role ${r}`).toBe(true);
    expect(code).toMatch(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/);
  });
  it("the registry grew by exactly these 7 codes: no other code is new in the billing module, and no old billing code is gone or changed", () => {
    const billing = registry.permissions.filter((p: any) => p.code.startsWith("billing.")).map((p: any) => p.code);
    const oldBilling = ["billing.invoice.read", "billing.invoice.issue", "billing.invoice.reprint", "billing.invoice.cancel", "billing.payment.record", "billing.payment.reverse", "billing.refund.approve",
      "billing.refund.request", "billing.credit_party.read", "billing.credit_party.manage", "billing.cash_report.read", "billing.data.export", "billing.release.override", "billing.settings.manage"];
    expect([...billing].sort()).toEqual([...oldBilling, ...Object.keys(PERMS)].sort());
    expect(byCode.get("billing.payment.reverse").roles).toEqual(["finance"]);
    expect(byCode.get("billing.cash_report.read").roles).toEqual(["finance", "tenant_admin", "owner_viewer"]);
  });
  it("every x-permission of the 24 operations is one of the 7 new codes; each of the 7 is used by at least one operation", () => {
    const used = new Set(OPS.map((o) => BOPS[o.id]?.op["x-permission"]));
    expect([...used].sort()).toEqual(Object.keys(PERMS).sort());
  });
  it("privileged codes sit on the sensitive operations: manage masters, reverse an entry, decide a transfer", () => {
    for (const id of ["createAccountGroup", "updateAccountGroup", "createAccountParticular", "createExpenseType", "reverseAccountLedgerEntry", "acceptCashTransfer", "rejectCashTransfer"])
      expect(byCode.get(BOPS[id].op["x-permission"]).privileged, id).toBe(true);
    for (const id of ["listAccountGroups", "createAccountLedgerEntry", "createExpense", "createCashTransfer", "getAccountStatement"])
      expect(byCode.get(BOPS[id].op["x-permission"]).privileged, id).toBe(false);
  });
  it("corp_admin pack (services/api role-packs.data.yaml) holds all 7 codes, sorted and without duplicates (the administrator pack test enumerates every staff code)", () => {
    const admin = packs.packs.flatMap((p: any) => p.roles).find((r: any) => r.code === "corp_admin");
    for (const c of Object.keys(PERMS)) expect(admin.permissions, `corp_admin lacks ${c}`).toContain(c);
    expect(new Set(admin.permissions).size).toBe(admin.permissions.length);
    expect(admin.permissions).toEqual([...admin.permissions].sort());
  });
});

describe("T0C-ACCT-1 generated clients", () => {
  it("generated clients, MSW handlers, route and permission types are fresh (codegen --check)", () => {
    expect(staleFiles(ROOT)).toEqual([]);
  }, 120_000);
});

describe("T0C-ACCT-1 migration file (static; behaviour in the pgTAP suite)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");
  const TABLES = ["account_groups", "account_particulars", "expense_types", "account_ledger_entries", "expenses", "cash_transfers"];

  it("exists, is the newest migration unless a later wave-2 file exists, runs as lims_owner, sits after the two LD-310 migrations", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all.filter((f) => f.startsWith("20261117120000"))).toEqual([MIG]);
    expect(all).toEqual(expect.arrayContaining(["20261117100000_frontdesk__add_patient_parity_fields.sql", "20261117110000_frontdesk__add_registration_parity_fields.sql"]));
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("creates the six tables IF NOT EXISTS in schema billing, each with ENABLE + FORCE row level security, tenant-scoped policies and a grant to lims_app only", () => {
    for (const t of TABLES) {
      expect(code, `CREATE TABLE ${t}`).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS billing\\.${t}\\b`, "i"));
      expect(code, `ENABLE RLS ${t}`).toMatch(new RegExp(`ALTER TABLE billing\\.${t} ENABLE ROW LEVEL SECURITY`, "i"));
      expect(code, `FORCE RLS ${t}`).toMatch(new RegExp(`ALTER TABLE billing\\.${t} FORCE ROW LEVEL SECURITY`, "i"));
      expect(code, `policy on ${t}`).toMatch(new RegExp(`CREATE POLICY[^;]*ON billing\\.${t}\\b[^;]*app\\.current_tenant_id\\(\\)`, "is"));
      expect(code, `GRANT lims_app ${t}`).toMatch(new RegExp(`GRANT[^;]*ON billing\\.${t} TO lims_app`, "i"));
    }
    expect((code.match(/CREATE TABLE/gi) ?? []).length).toBe((code.match(/CREATE TABLE IF NOT EXISTS/gi) ?? []).length);
    expect(code).not.toMatch(/TO\s+(PUBLIC|anon|authenticated)\b/i);
  });
  it("account_ledger_entries is append only: no UPDATE or DELETE grant (a column grant on status alone would need a guard trigger), no float or numeric money column", () => {
    const grant = code.match(/GRANT\s+([^;]*?)\s+ON\s+billing\.account_ledger_entries\s+TO\s+lims_app/i);
    expect(grant, "GRANT on account_ledger_entries").not.toBeNull();
    expect(grant![1]).not.toMatch(/\bDELETE\b|\bALL\b|\bTRUNCATE\b/i);
    if (/\bUPDATE\b/i.test(grant![1])) expect(code, "an UPDATE grant must be a column grant").toMatch(/GRANT\s+UPDATE\s*\(\s*(status|last_modified_by|updated_at|,|\s)+\)\s+ON\s+billing\.account_ledger_entries/i);
    for (const m of code.matchAll(/\b\w*_paisa\s+(\w+)/gi)) expect(m[1].toLowerCase(), `money column type near ${m[0]}`).toBe("bigint");
    expect(code).not.toMatch(/\b(float|double precision|real|numeric|decimal|money)\b/i);
  });
  it("policies are re-runnable: each CREATE POLICY sits in a pg_policy guard or follows a DROP POLICY IF EXISTS", () => {
    for (const m of code.matchAll(/CREATE\s+POLICY\s+(\S+)\s+ON\s+(\S+)/gi)) {
      const before = code.slice(Math.max(0, m.index! - 700), m.index);
      expect(new RegExp(`DROP POLICY IF EXISTS ${m[1]}\\b`, "i").test(code.slice(0, m.index! + 10)) || /pg_policy/i.test(before), `policy ${m[1]} is not idempotent`).toBe(true);
    }
  });
  it("is additive: no DROP TABLE / COLUMN, TRUNCATE, data statement, ALTER of an old table, type, enum or REVOKE", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect(code).not.toMatch(/\b(DROP\s+(TABLE|COLUMN|SCHEMA|INDEX)|TRUNCATE|DELETE\s+FROM|REVOKE)\b/i);
    expect(code).not.toMatch(/\bCREATE\s+TYPE\b|\bAS\s+ENUM\b|DISABLE\s+ROW|NO\s+FORCE|ALTER\s+COLUMN/i);
    for (const m of code.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF EXISTS\s+)?(billing\.\w+)/gi)) expect(TABLES.map((t) => `billing.${t}`), `ALTER of an old table ${m[1]}`).toContain(m[1]);
    for (const m of code.matchAll(/UPDATE\s+billing\.\w+\s+SET/gi)) throw new Error(`data statement: ${m[0]}`);
    expect(code).not.toMatch(/\bINSERT\s+INTO\s+billing\.(?!account_|expense|cash_)/i);
  });
  it("every index is IF NOT EXISTS (tenant_id first) and every ADD CONSTRAINT is guarded by a pg_constraint check", () => {
    for (const m of code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/gi)) throw new Error(`unguarded CREATE INDEX near ${m.index}`);
    for (const m of code.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF NOT EXISTS\s+\S+\s+ON\s+\S+\s*(?:USING\s+\w+\s*)?\(\s*(\w+)/gi)) expect(m[1], `index leads with tenant_id: ${m[0].slice(0, 80)}`).toBe("tenant_id");
    for (const m of code.matchAll(/ADD\s+CONSTRAINT/gi)) expect(code.slice(Math.max(0, m.index! - 600), m.index), "ADD CONSTRAINT must sit in a DO block that checks pg_constraint").toMatch(/DO\s+\$[a-z_]*\$[\s\S]*pg_constraint/i);
  });
  it("append only and lifecycle guards exist: a reversal guard on account_ledger_entries and a lifecycle guard on cash_transfers; audit triggers on the five mutable tables", () => {
    expect(code).toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+\w+\s+BEFORE\s+INSERT\s+ON\s+billing\.account_ledger_entries/i);
    expect(code).toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+\w+\s+BEFORE\s+UPDATE\s+ON\s+billing\.cash_transfers/i);
    for (const t of ["account_groups", "account_particulars", "expense_types", "expenses", "cash_transfers"])
      expect(code, `audit trigger ${t}`).toMatch(new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?TRIGGER\\s+${t}__audit\\b[^;]*ON billing\\.${t}\\b[^;]*tg_row_audit`, "is"));
    for (const m of code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\S+)\s*\([^)]*\)\s+RETURNS\s+trigger[\s\S]*?\$\$;?/gi)) expect(m[0], `${m[1]} must pin search_path`).toMatch(/SET\s+search_path\s*=\s*''/i);
  });
  it("comments: LD-313, the six tables, down note with DROP TABLE, no data rewrite, receipt counter per tenant, no sequences, accountant confirmation, push-cloud founder step", () => {
    expect(comments).toMatch(/LD-313/);
    expect(comments).toMatch(/\bdown\b/i);
    expect(comments).toMatch(/DROP TABLE/i);
    for (const t of TABLES) expect(comments, `down note names ${t}`).toContain(t);
    expect(comments).toMatch(/no data rewrite|does not rewrite|no rewrite|additive/i);
    expect(comments).toMatch(/receipt/i);
    expect(comments).toMatch(/push-cloud/i);
    expect(comments).toMatch(/accountant/i);
    expect(code, "no sequences in billing (05-SCHEMA §9 test 1)").not.toMatch(/CREATE\s+SEQUENCE/i);
    expect(code, "no default on id / tenant_id (UUIDv7 in app code)").not.toMatch(/\b(id|tenant_id)\s+uuid\s+NOT NULL\s+DEFAULT/i);
  });
});

describe("T0C-ACCT-1 implementation notes", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  it("name the migration as a founder step (push-cloud), cite LD-313, and say what stays with the founder", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-ACCT-1-impl.md missing").toBe(true);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toContain(MIG);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/LD-313/);
  });
  it("list every new permission code", () => { for (const c of Object.keys(PERMS)) expect(t, c).toContain(c); });
  it("record the follow-ups for services: accept posts a balanced pair in one transaction, receipt counter, accountant confirms groups and particulars, role-pack apply", () => {
    expect(t).toMatch(/balanced pair/i);
    expect(t).toMatch(/receipt/i);
    expect(t).toMatch(/accountant/i);
    expect(t).toMatch(/T0B-ACCT/);
    expect(t).toMatch(/apply-role-pack|role pack/i);
  });
});
