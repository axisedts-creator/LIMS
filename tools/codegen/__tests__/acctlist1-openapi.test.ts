// T0C-ACCTLIST-1 (LD-358, LD-325; founder blanket authority LD-310, "do not leave any function") — the account summary LIST of ElabAssist "View Account":
// contracts/openapi/billing.yaml gets ONE operation listAccountSummaries (GET /v1/billing/account-summaries) and ONE closed schema AccountSummaryRow (+ its page envelope), nothing else.
// No migration, no permission, no handler, no web change. The operation id joins billing pendingOperations (services/api/src/modules/billing/__tests__/contract/acctlist1.pending.test.ts).
// ASSUMPTIONS (the brief fixes names in words; a different choice needs a ruling, not a silent test edit):
//  - Page envelope = exactly the one of listAccountParticulars: response schema closed, required [data, page], data = array maxItems 200 of AccountSummaryRow, page = _common PageInfo;
//    query params cursor + limit are deep-equal to the ones of listAccountParticulars. The wrapper schema's NAME is free (e.g. AccountSummaryRowPage); the test follows the $ref.
//  - Query parameters are exactly: party_kind, q, blocked_only, outstanding_only, cursor, limit. All optional. party_kind has the same four values as AccountSummary.
//  - Error codes: at least the six of getAccountSummary plus common.invalid_cursor (a paged list has a cursor).
//  - AccountSummaryRow: every property of AccountSummary (deep-equal definition, still required) + party_name (required string, maxLength 200). centre_id is OPTIONAL in the brief: when present it is the
//    _common Uuid schema, NOT nullable (wire rule of T0C-ACCT-1: no `nullable` anywhere) and NOT required; AccountSummary has no centre, so the implementer states the choice in the notes.
//  - Wire rule (same as T0C-ACCT-1): closed objects, money = integer paisa (int64, >= 0, bounded), no `type: number`, no `nullable`.
//  - Implementation notes: .orchestra/notes/T0C-ACCTLIST-1-impl.md must say (a) the two follow-ups T0B-ACCTLIST-1 and T0D-UILIST-2, (b) the centre_id choice.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const NOTES = join(ROOT, ".orchestra/notes/T0C-ACCTLIST-1-impl.md");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const load = (rel: string): any => parse(read(rel));
const bl: any = load("contracts/openapi/billing.yaml");
const common: any = load("contracts/openapi/_common.yaml");
const BS = bl.components.schemas as Record<string, any>;
const METHODS = ["get", "put", "post", "delete", "patch"];
const ID = "listAccountSummaries";
const PATH = "/v1/billing/account-summaries";
const PERM = "billing.account.read";
const KINDS = ["credit_party", "franchise", "user_pocket", "laboratory"];

const opIndex = (d: any) => {
  const m: Record<string, { path: string; method: string; op: any }> = {};
  for (const [path, item] of Object.entries<any>(d.paths)) for (const method of METHODS) if (item[method]) m[item[method].operationId] = { path, method, op: item[method] };
  return m;
};
const OPS = opIndex(bl);
const op: any = OPS[ID]?.op ?? {};
const deref = (s: any): any => {
  let cur = s;
  for (let i = 0; i < 6 && cur?.$ref; i++) {
    if (cur.$ref.startsWith("#/components/schemas/")) cur = BS[cur.$ref.split("/").pop()!];
    else if (cur.$ref.startsWith("_common.yaml#/components/schemas/")) cur = common.components.schemas[cur.$ref.split("/").pop()!];
    else break;
  }
  return cur;
};
const params = (o: any): any[] => (o?.parameters ?? []).map((p: any) => (p?.$ref ? resolveParam(p.$ref) : p));
const resolveParam = (ref: string): any => common.components.parameters?.[ref.split("/").pop()!];
const param = (o: any, name: string) => params(o).find((p: any) => p?.name === name);
const okJson = (o: any) => o?.responses?.["200"]?.content?.["application/json"];
const pageSchema = (): any => deref(okJson(op)?.schema);
const rowSchema = (): any => deref(pageSchema()?.properties?.data?.items);
const isPaisa = (p: any) => { const d = deref(p); return d?.type === "integer" && d?.format === "int64" && d?.minimum >= 0 && Number.isInteger(d?.maximum); };
const refName = (s: any): string => String(s?.$ref ?? "").split("/").pop()!;
const text = (...parts: any[]) => parts.map((p) => JSON.stringify(p ?? "")).join(" ").replace(/\\"/g, '"');

describe("T0C-ACCTLIST-1 contract: lint, additive, only what the brief names (done_when 1, 3, 6)", () => {
  it("lintRepo reports no violation for billing.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "billing.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });
  it("listAccountSummaries exists exactly once, as the only operation at GET /v1/billing/account-summaries; no other operation of that path", () => {
    expect(OPS[ID], `${ID} missing from billing.yaml`).toBeDefined();
    expect(OPS[ID].method).toBe("get");
    expect(OPS[ID].path).toBe(PATH);
    expect(Object.keys(bl.paths[PATH] ?? {}).filter((k) => METHODS.includes(k))).toEqual(["get"]);
    const all = Object.values<any>(bl.paths).flatMap((it) => METHODS.filter((m) => it[m]).map((m) => it[m].operationId as string));
    expect(all.filter((x) => x === ID)).toHaveLength(1);
  });
  it("additive: the 71 operations of T0C-ACCT-1 are all still there, getAccountSummary is unchanged, no other account-summar* path exists", () => {
    expect(Object.keys(OPS).length).toBeGreaterThanOrEqual(72);
    expect(OPS.getAccountSummary?.path).toBe("/v1/billing/account-summary");
    expect(OPS.getAccountSummary.method).toBe("get");
    expect(OPS.getAccountSummary.op["x-permission"]).toBe(PERM);
    const gp = params(OPS.getAccountSummary.op);
    expect(gp.map((p: any) => p.name).sort()).toEqual(["party_id", "party_kind"]);
    for (const p of gp) { expect(p.in).toBe("query"); expect(p.required, p.name).toBe(true); }
    expect(refName(okJson(OPS.getAccountSummary.op).schema)).toBe("AccountSummary");
    expect(Object.keys(bl.paths).filter((p) => /account-summar/.test(p)).sort()).toEqual([PATH, "/v1/billing/account-summary"]);
  });
  it("AccountSummary is unchanged: the six fields, all required, closed", () => {
    const s = BS.AccountSummary;
    expect(s.additionalProperties).toBe(false);
    expect(Object.keys(s.properties).sort()).toEqual(["credit_limit_paisa", "is_blocked", "outstanding_paisa", "outstanding_side", "party_id", "party_kind"]);
    expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
    expect([...s.properties.party_kind.enum].sort()).toEqual([...KINDS].sort());
  });
  it("no new permission: billing.account.read is the permission, and permissions.yaml has no account-summary code", () => {
    expect(read("contracts/permissions.yaml")).toMatch(/code:\s*billing\.account\.read\b/);
    expect(read("contracts/permissions.yaml")).not.toMatch(/account_summar/i);
  });
});

describe("T0C-ACCTLIST-1 operation metadata (done_when 1)", () => {
  it("tag billing, x-permission billing.account.read, x-context tenant, x-idempotency none, x-rate-limit-tier general, bearerJwt security", () => {
    expect(op.tags).toEqual(["billing"]);
    expect(op["x-permission"]).toBe(PERM);
    expect(op["x-context"]).toBe("tenant");
    expect(op["x-idempotency"]).toBe("none");
    expect(op["x-rate-limit-tier"]).toBe("general");
    expect(op.security).toEqual([{ bearerJwt: [] }]);
    expect(op.requestBody).toBeUndefined();
  });
  it("standard error codes: all six of getAccountSummary plus common.invalid_cursor; the 400/401/403/429/500 responses are the _common ones", () => {
    const codes: string[] = op["x-error-codes"] ?? [];
    for (const c of OPS.getAccountSummary.op["x-error-codes"]) expect(codes, c).toContain(c);
    expect(codes).toContain("common.invalid_cursor");
    expect(new Set(codes).size).toBe(codes.length);
    for (const [status, name] of [["400", "BadRequest"], ["401", "Unauthorized"], ["403", "Forbidden"], ["429", "TooManyRequests"], ["500", "Internal"]]) {
      expect(op.responses?.[status]?.$ref, status).toBe(`_common.yaml#/components/responses/${name}`);
    }
  });
  it("has a description or summary naming the screen (ElabAssist View Account / account summary list)", () => {
    expect(text(op.summary, op.description)).toMatch(/account summar/i);
  });
});

describe("T0C-ACCTLIST-1 query parameters (done_when 1)", () => {
  const names = () => params(op).map((p: any) => p?.name).sort();
  it("exactly party_kind, q, blocked_only, outstanding_only, cursor, limit; all in query, none required", () => {
    expect(names()).toEqual(["blocked_only", "cursor", "limit", "outstanding_only", "party_kind", "q"]);
    for (const p of params(op)) { expect(p.in, p.name).toBe("query"); expect(p.required === true, `${p.name} must be optional`).toBe(false); }
  });
  it("party_kind: string with the same four values as AccountSummary (and as getAccountSummary's parameter)", () => {
    const s = deref(param(op, "party_kind")?.schema);
    expect(s?.type).toBe("string");
    expect([...(s?.enum ?? [])].sort()).toEqual([...KINDS].sort());
    expect(Number.isInteger(s?.maxLength)).toBe(true);
    expect([...(s?.enum ?? [])].sort()).toEqual([...deref(param(OPS.getAccountSummary.op, "party_kind")?.schema).enum].sort());
  });
  it("q: optional string search of the party name, maxLength 80, described as a party name search", () => {
    const p = param(op, "q");
    const s = deref(p?.schema);
    expect(s?.type).toBe("string");
    expect(s?.maxLength).toBe(80);
    expect(text(p?.description, op.description)).toMatch(/party name/i);
  });
  it("blocked_only and outstanding_only are booleans; outstanding_only says outstanding_paisa above 0", () => {
    expect(deref(param(op, "blocked_only")?.schema)?.type).toBe("boolean");
    const o = param(op, "outstanding_only");
    expect(deref(o?.schema)?.type).toBe("boolean");
    expect(text(o?.description, op.description)).toMatch(/outstanding_paisa[^.]{0,40}(above|greater than|more than|>)\s*(0|zero)/i);
    expect(text(param(op, "blocked_only")?.description, op.description)).toMatch(/blocked/i);
  });
  it("paging parameters cursor and limit are deep-equal to the ones of listAccountParticulars (same page parameters)", () => {
    const ref = OPS.listAccountParticulars.op;
    for (const n of ["cursor", "limit"]) {
      expect(param(op, n), n).toBeDefined();
      expect(deref(param(op, n).schema), n).toEqual(deref(param(ref, n).schema));
    }
  });
});

describe("T0C-ACCTLIST-1 response envelope and AccountSummaryRow (done_when 1, 2)", () => {
  it("200 is a closed page envelope exactly like AccountParticularPage: required [data, page], data array maxItems 200, page = PageInfo", () => {
    const ref = BS.AccountParticularPage;
    const s = pageSchema();
    expect(s, "200 body schema does not resolve").toBeDefined();
    expect(s.additionalProperties).toBe(false);
    expect([...s.required].sort()).toEqual(["data", "page"]);
    expect(Object.keys(s.properties).sort()).toEqual(["data", "page"]);
    expect(s.properties.data.type).toBe("array");
    expect(s.properties.data.maxItems).toBe(ref.properties.data.maxItems);
    expect(s.properties.page).toEqual(ref.properties.page);
    expect(refName(s.properties.data.items)).toBe("AccountSummaryRow");
  });
  it("AccountSummaryRow is closed, carries every AccountSummary field unchanged (still required) plus party_name string maxLength 200 (required)", () => {
    const r = BS.AccountSummaryRow;
    expect(r, "components.schemas.AccountSummaryRow missing").toBeDefined();
    expect(r.type).toBe("object");
    expect(r.additionalProperties).toBe(false);
    for (const [f, def] of Object.entries<any>(BS.AccountSummary.properties)) expect(r.properties[f], `AccountSummaryRow.${f}`).toEqual(def);
    for (const f of BS.AccountSummary.required) expect(r.required, `${f} required`).toContain(f);
    expect(r.properties.party_name?.type).toBe("string");
    expect(r.properties.party_name?.maxLength).toBe(200);
    expect(r.required).toContain("party_name");
    for (const f of ["credit_limit_paisa", "outstanding_paisa"]) expect(isPaisa(r.properties[f]), f).toBe(true);
  });
  it("only party_name and (optionally) centre_id are added; centre_id, if present, is the Uuid schema, not nullable, not required", () => {
    const r = BS.AccountSummaryRow;
    const extra = Object.keys(r.properties).filter((f) => !(f in BS.AccountSummary.properties)).sort();
    expect([["party_name"], ["centre_id", "party_name"]], `unexpected extra fields: ${extra}`).toContainEqual(extra);
    if (r.properties.centre_id) {
      expect(r.properties.centre_id).toEqual({ $ref: "_common.yaml#/components/schemas/Uuid" });
      expect(r.required).not.toContain("centre_id");
    }
  });
  it("wire rule: no `nullable`, no `type: number` anywhere in the new schemas; the operation list has no server-owned field (tenant_id)", () => {
    expect(BS.AccountSummaryRow, "components.schemas.AccountSummaryRow missing").toBeDefined();
    expect(pageSchema(), "200 body schema does not resolve").toBeDefined();
    const blob = JSON.stringify([BS.AccountSummaryRow, pageSchema()]);
    expect(blob).not.toMatch(/"nullable"/);
    expect(blob).not.toMatch(/"type":"number"/);
    expect(blob).not.toMatch(/tenant_id/);
  });
  it("the 200 example is synthetic, has exactly two rows, validates against the response schema, rows are distinct parties and not the same row twice", () => {
    const body = okJson(op);
    const ex = Object.values<any>(body?.examples ?? {}).map((x) => x.value);
    expect(ex.length, "no example on the 200 response").toBeGreaterThan(0);
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...bl, id: "billing.yaml" });
    const v = ajv.compile({ $ref: "billing.yaml#/components/schemas/" + refName(okJson(op)?.schema) });
    for (const e of ex) {
      expect(v(e), JSON.stringify(v.errors?.slice(0, 2))).toBe(true);
      expect(e.data).toHaveLength(2);
      expect(new Set(e.data.map((r: any) => r.party_id)).size).toBe(2);
      for (const r of e.data) { expect(r.party_name.length).toBeGreaterThan(0); expect(KINDS).toContain(r.party_kind); }
      expect(e.page.limit).toBeGreaterThanOrEqual(2);
    }
    expect(text(ex)).not.toMatch(/@|\+977|\b9[78]\d{8}\b/); // synthetic: no e-mail, no phone number
  });
  it("negative: the schema refuses an unknown field and a missing party_name (closed + required are real)", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...bl, id: "billing.yaml" });
    const v = ajv.compile({ $ref: "billing.yaml#/components/schemas/AccountSummaryRow" });
    const row = { party_kind: "credit_party", party_id: "0193c4a0-0000-7000-8000-00000acc0101", credit_limit_paisa: 0, outstanding_paisa: 0, outstanding_side: "debit", is_blocked: false, party_name: "Synthetic Party" };
    expect(v(row), JSON.stringify(v.errors)).toBe(true);
    expect(v({ ...row, extra: 1 })).toBe(false);
    const { party_name: _n, ...noName } = row;
    expect(v(noName)).toBe(false);
    expect(v({ ...row, party_name: "x".repeat(201) })).toBe(false);
    expect(v({ ...row, outstanding_paisa: -1 })).toBe(false);
  });
});

describe("T0C-ACCTLIST-1 generated clients (done_when 5)", () => {
  it("generated clients, MSW handlers, route and permission types are fresh (codegen --check)", () => {
    expect(staleFiles(ROOT)).toEqual([]);
  }, 120_000);
  it("the generated types and clients carry the new operation and schema", () => {
    const ts = read("packages/api-client-ts/src/billing.ts");
    expect(ts).toContain(`"${PATH}"`);
    expect(ts).toContain(`${ID}:`);
    // codegen inlines schemas into operations[...] and emits no component names (ruling)
    expect(ts.slice(ts.indexOf(`${ID}:`))).toContain("party_name: string");
    expect(read("packages/api-client-ts/src/server/operations.ts")).toContain(`${ID}:`);
    expect(read("packages/api-client-dart/lib/billing.dart")).toContain(`Future<Object?> ${ID}(`);
    expect(read("packages/fakes/src/msw/handlers.generated.ts")).toContain(`// ${ID}`);
  });
});

describe("T0C-ACCTLIST-1 billing manifest, notes (done_when 4, 6)", () => {
  it("billing index.ts lists listAccountSummaries in pendingOperations (the one array line; no handler file touched for it)", () => {
    const src = read("services/api/src/modules/billing/index.ts");
    const m = src.match(/pendingOperations:\s*\[([^\]]*)\]/);
    expect(m, "pendingOperations array not found").not.toBeNull();
    expect(m![1]).toMatch(new RegExp(`['"]${ID}['"]`));
    expect(read("services/api/src/modules/billing/handlers/index.ts")).not.toContain(ID);
  });
  it("no migration names account_summar (the web list landed in T0D-UILIST-2, LD-358)", () => {
    const mig = join(ROOT, "db/migrations");
    const names = existsSync(mig) ? readdirSync(mig) : [];
    expect(names.filter((n) => /account_summar/i.test(n))).toEqual([]);
  });
  it("implementation notes list the two follow-ups (T0B-ACCTLIST-1 handler, T0D-UILIST-2 web list) and the centre_id choice", () => {
    expect(existsSync(NOTES), "notes .orchestra/notes/T0C-ACCTLIST-1-impl.md missing").toBe(true);
    const n = readFileSync(NOTES, "utf8");
    expect(n).toMatch(/T0B-ACCTLIST-1/);
    expect(n).toMatch(/T0D-UILIST-2/);
    expect(n).toMatch(/centre_id/);
    expect(n).toMatch(/pendingOperations/);
  });
});
