// T0C-SALES-1 (LD-321, LD-325; founder blanket authority LD-310, priority order 2026-11-17 09:18 NPT, offline 09:19 NPT) — sales hierarchy contracts:
// contracts/openapi/partners.yaml (15 additive staff operations under /v1/partners/admin/sales), contracts/openapi/homecollection.yaml (collector Allow Collection / Allow Pickup flags),
// contracts/permissions.yaml + the corp_admin pack (partners.sales.read, partners.sales.manage), the migration 20261117210000_partners__add_sales_hierarchy.sql (static checks; behaviour is
// db/tests/partners/T0C-SALES-1_sales_hierarchy.test.sql), generated-client freshness, the pending-operations rule of LD-325(b), the implementer's notes with the FIELD MAP.
// ASSUMPTIONS (the brief gives function names and field labels, not wire names; a different choice needs a ruling, not a silent test edit; same style as T0C-ACCT-1 / T0C-TESTMGMT-1):
//  - OPERATION IDS / PATHS (all staff, so under /v1/partners/admin/sales, tag partners, bearerJwt, x-context tenant): see OPS below. "unassign" of the brief = unassignPartyFromRepresentative.
//    Reads (list*, getSalesTree, listRepresentativeClients) need partners.sales.read; every write needs partners.sales.manage (privileged, so auth.mfa_required). No delete operation anywhere:
//    deactivate = POST .../deactivate (representative, service area), unassign = POST .../unassign (assignment closes with effective_to); a designation is switched off by update is_active=false.
//  - Wire names are the snake_case of the brief: designation {name, level 1..8, is_active}; representative {name, phone, email, user_id, designation_id, manager_id, joining_date, is_active};
//    assignment {party_kind in partner | credit_party | doctor | referrer (the LIMS split model is kept), party_id, representative_id, effective_from, effective_to};
//    service area {name, district, area_text, centre_id, is_active}; every row also id, version, created_at, updated_at. Absent = not set (no `nullable`); updates clear through unset[].
//  - Mutable rows carry `version`; update / deactivate / unassign take If-Match and list common.version_conflict + common.precondition_required (02-CONVENTIONS 4.2). Creates and assign are
//    x-idempotency required (Idempotency-Key header). Reads are none. Update / deactivate / unassign idempotency is not pinned.
//  - The sales tree is a FLAT, paged list ordered parent before child: node {id, name, designation_id, designation_level, manager_id?, depth 1..8, is_active}; param max_depth 1..8 (default 8), root_id.
//  - Client list row: {assignment_id, party_kind, party_id, party_name, outstanding_paisa (integer paisa, may be negative = advance), last_bill_date?, effective_from, effective_to?}. Filters party_kind, as_of.
//  - Business-rule violations (own manager, manager loop, overlapping assignment, level out of range) answer common.validation_failed; NO new error code (errors.yaml == IC section 8).
//  - Search query parameter is `q` (never name / email / phone: REQ-SEC-098 query allowlist convention of C13).
//  - HOMECOLLECTION: the repo has NO collector table and NO collector update operation (collectors are core.memberships eligible through listEligiblePhlebotomists), so "the existing collector read
//    and update" cannot be taken literally. Pinned reading: listEligiblePhlebotomists items gain allow_collection and allow_pickup (booleans, not required), and ONE new operation updateCollectorFlags
//    PATCH /v1/homecollection/phlebotomists/{membership_id} (permission homecollection.settings.manage, existing code) sets them; the flags live in the new table homecollection.collector_flags
//    (absent row = both true). The brief said no new homecollection operation: the lead rules on this (see the tests note). The homecollection module lists the new id in pendingOperations.
//  - LD-325(b): the 15 + 1 new operationIds are in pendingOperations of services/api/src/modules/partners/index.ts and homecollection/index.ts; T0B-SALES-1 removes them.
//  - the implementer's notes are .orchestra/notes/T0C-SALES-1-impl.md.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = "20261117210000_partners__add_sales_hierarchy.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-SALES-1-impl.md");
const load = (f: string): any => parse(readFileSync(join(ROOT, f), "utf8"));
const P_DOC = load("contracts/openapi/partners.yaml");
const H_DOC = load("contracts/openapi/homecollection.yaml");
const common = load("contracts/openapi/_common.yaml");
const registry = load("contracts/permissions.yaml");
const packs = load("services/api/src/modules/identity/role-packs/role-packs.data.yaml");
const METHODS = ["get", "put", "post", "delete", "patch"];
const PFX = "/v1/partners/admin/sales";
const UUID = "0193c4a0-0000-7000-8000-0000000000aa";

type OpSpec = { method: string; path: string; perm: string; idem: "required" | "none" | "any"; ok: string; ifMatch: boolean; paged?: boolean };
const R = "partners.sales.read", M = "partners.sales.manage";
const OPS: Record<string, OpSpec> = {
  listSalesDesignations: { method: "get", path: `${PFX}/designations`, perm: R, idem: "none", ok: "200", ifMatch: false, paged: true },
  createSalesDesignation: { method: "post", path: `${PFX}/designations`, perm: M, idem: "required", ok: "201", ifMatch: false },
  updateSalesDesignation: { method: "patch", path: `${PFX}/designations/{designation_id}`, perm: M, idem: "any", ok: "200", ifMatch: true },
  listSalesRepresentatives: { method: "get", path: `${PFX}/representatives`, perm: R, idem: "none", ok: "200", ifMatch: false, paged: true },
  createSalesRepresentative: { method: "post", path: `${PFX}/representatives`, perm: M, idem: "required", ok: "201", ifMatch: false },
  updateSalesRepresentative: { method: "patch", path: `${PFX}/representatives/{representative_id}`, perm: M, idem: "any", ok: "200", ifMatch: true },
  deactivateSalesRepresentative: { method: "post", path: `${PFX}/representatives/{representative_id}/deactivate`, perm: M, idem: "any", ok: "200", ifMatch: true },
  getSalesTree: { method: "get", path: `${PFX}/tree`, perm: R, idem: "none", ok: "200", ifMatch: false, paged: true },
  assignPartyToRepresentative: { method: "post", path: `${PFX}/assignments`, perm: M, idem: "required", ok: "201", ifMatch: false },
  unassignPartyFromRepresentative: { method: "post", path: `${PFX}/assignments/{assignment_id}/unassign`, perm: M, idem: "any", ok: "200", ifMatch: true },
  listRepresentativeClients: { method: "get", path: `${PFX}/representatives/{representative_id}/clients`, perm: R, idem: "none", ok: "200", ifMatch: false, paged: true },
  listServiceAreas: { method: "get", path: `${PFX}/service-areas`, perm: R, idem: "none", ok: "200", ifMatch: false, paged: true },
  createServiceArea: { method: "post", path: `${PFX}/service-areas`, perm: M, idem: "required", ok: "201", ifMatch: false },
  updateServiceArea: { method: "patch", path: `${PFX}/service-areas/{service_area_id}`, perm: M, idem: "any", ok: "200", ifMatch: true },
  deactivateServiceArea: { method: "post", path: `${PFX}/service-areas/{service_area_id}/deactivate`, perm: M, idem: "any", ok: "200", ifMatch: true },
};
const HOP = { id: "updateCollectorFlags", method: "patch", path: "/v1/homecollection/phlebotomists/{membership_id}", perm: "homecollection.settings.manage" };
const PARTY_KINDS = ["partner", "credit_party", "doctor", "referrer"];
const MFA = "auth.mfa_required";

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
const paramNames = (doc: any, op: any): string[] => (op.parameters ?? []).map((p: any) => deref(doc, p).name);
const paramOf = (doc: any, op: any, name: string): any => (op.parameters ?? []).map((p: any) => deref(doc, p)).find((p: any) => p.name === name);
const enumOf = (p: any): string[] => ((p?.enum ?? []) as unknown[]).filter((x): x is string => typeof x === "string");
/** visit every schema object reachable from s (refs resolved against doc / _common) */
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
ajv.addSchema({ ...H_DOC, id: "homecollection.yaml" });
const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const validatorFor = (file: string, doc: any, id: string, where: "req" | string) => {
  const o = opIn(doc, id)!;
  const ptr = where === "req" ? `/paths/${esc(o.path)}/${o.method}/requestBody/content/application~1json/schema` : `/paths/${esc(o.path)}/${o.method}/responses/${where}/content/application~1json/schema`;
  const v = ajv.getSchema(`${file}#${ptr}`);
  expect(v, `cannot resolve ${id} ${where}`).toBeDefined();
  return v!;
};

describe("T0C-SALES-1 partners.yaml: lint and additive baseline", () => {
  it("lintRepo reports no violation for partners.yaml or homecollection.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "partners.yaml" || x.file === "homecollection.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });
  it("partners.yaml is additive: the 68 original operations stay, exactly 15 new ones, unique ids", () => {
    const ids = idsOf(P_DOC);
    expect(ids.length, "68 original + 15 sales operations").toBe(83);
    expect(new Set(ids).size).toBe(83);
    for (const id of ["listPartners", "createPartner", "suspendPartner", "getPartnerDashboard", "createManifest", "listPartnerReferrers", "mapPartnerReferrer", "listReferrerMappings", "getPartnerSettings", "updatePartnerSettings"])
      expect(opIn(P_DOC, id), id).toBeDefined();
    expect(opIn(P_DOC, "createPartner")!.path).toBe("/v1/partners/admin/partners");
    expect(opIn(P_DOC, "suspendPartner")!.op["x-permission"]).toBe("partners.partner.manage");
    for (const id of Object.keys(OPS)) expect(opIn(P_DOC, id), `${id} missing`).toBeDefined();
  });
  it("homecollection.yaml is additive: 26 original operations stay, exactly 1 new (updateCollectorFlags), listEligiblePhlebotomists keeps its required list", () => {
    const ids = idsOf(H_DOC);
    expect(ids.length).toBe(27);
    expect(new Set(ids).size).toBe(27);
    for (const id of ["listHomeVisits", "assignHomeVisit", "listEligiblePhlebotomists", "registerPhleboDevice", "pushSyncMutations", "getHomecollectionSettings", "updateHomecollectionSettings"]) expect(opIn(H_DOC, id), id).toBeDefined();
    expect(opIn(H_DOC, "listEligiblePhlebotomists")!.op["x-permission"]).toBe("homecollection.visit.assign");
    sortedEq(itemSchema(H_DOC, "listEligiblePhlebotomists").required, ["membership_id", "display_name", "active_visits", "route_full"]);
    expect(opIn(H_DOC, HOP.id), HOP.id).toBeDefined();
  });
});

describe("T0C-SALES-1 partners.yaml: the 15 operations (done_when 4, 5, 6)", () => {
  for (const [id, s] of Object.entries(OPS)) {
    describe(id, () => {
      const o = opIn(P_DOC, id);
      it(`${s.method.toUpperCase()} ${s.path}, permission ${s.perm}, tag partners, bearerJwt, tenant context`, () => {
        expect(o, `${id} missing`).toBeDefined();
        expect(o!.method).toBe(s.method);
        expect(o!.path).toBe(s.path);
        expect(o!.op["x-permission"]).toBe(s.perm);
        expect(o!.op.tags).toEqual(["partners"]);
        expect(o!.op.security).toEqual([{ bearerJwt: [] }]);
        expect(o!.op["x-context"]).toBe("tenant");
        expect(o!.op["x-public"]).toBeUndefined();
        expect(o!.op["x-rate-limit-tier"]).toBeDefined();
      });
      it("error codes: five common, not_found with a path id, If-Match pair, mfa on the privileged code, invalid_cursor on lists; every code is registered", () => {
        const e: string[] = o?.op["x-error-codes"] ?? [];
        for (const c of ["common.validation_failed", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"]) expect(e, c).toContain(c);
        if (/\{/.test(s.path)) expect(e).toContain("common.not_found");
        if (s.ifMatch) for (const c of ["common.version_conflict", "common.precondition_required"]) expect(e, c).toContain(c);
        else expect(e).not.toContain("common.precondition_required");
        if (s.perm === M) expect(e).toContain(MFA);
        else expect(e).not.toContain(MFA);
        if (s.paged) expect(e).toContain("common.invalid_cursor");
        const reg = new Set<string>(load("contracts/errors.yaml").map((x: any) => x.code));
        for (const c of e) expect(reg.has(c), `${c} not in contracts/errors.yaml (no new error code allowed)`).toBe(true);
      });
      it("idempotency and If-Match headers", () => {
        const names = paramNames(P_DOC, o?.op ?? {});
        if (s.idem === "required") { expect(o!.op["x-idempotency"]).toBe("required"); expect(names).toContain("Idempotency-Key"); }
        if (s.idem === "none") expect(o!.op["x-idempotency"]).toBe("none");
        expect(names.includes("If-Match"), "If-Match").toBe(s.ifMatch);
      });
      it(`success ${s.ok}, JSON body with at least one example, standard error responses`, () => {
        const r = o?.op.responses ?? {};
        expect(Object.keys(r).filter((c) => /^2/.test(c))).toEqual([s.ok]);
        const j = r[s.ok]?.content?.["application/json"];
        expect(j, "JSON 2xx").toBeDefined();
        expect(Object.keys(j.examples ?? {}).length, "example").toBeGreaterThan(0);
        for (const c of ["400", "401", "403", "429", "500"]) expect(r[c], c).toBeDefined();
      });
      it("every object schema reachable from the request and response is closed (additionalProperties false); no float, no nullable, no tenant_id / created_by / server authority field in a request", () => {
        for (const m of jsonMedia(o!.op)) walk(P_DOC, m.schema, (n) => {
          if (n.type === "object" || n.properties) expect(n.additionalProperties, JSON.stringify(Object.keys(n.properties ?? {})).slice(0, 80)).toBe(false);
          expect(n.type, "money and counts are integers, never number").not.toBe("number");
          expect(n.nullable, "no nullable: absent means not set").not.toBe(true);
        });
        walk(P_DOC, o!.op.requestBody?.content?.["application/json"]?.schema, (n) => {
          for (const f of ["tenant_id", "created_by", "updated_by", "created_at", "updated_at", "version", "id"]) expect(Object.keys(n.properties ?? {}), `request names ${f}`).not.toContain(f);
        });
      });
      if (s.paged) it("is paged: Cursor + Limit parameters, {data (maxItems <= 200), page: PageInfo}", () => {
        const names = (o!.op.parameters as any[]).map((p) => p.$ref ?? p.name);
        expect(names).toEqual(expect.arrayContaining(["_common.yaml#/components/parameters/Cursor", "_common.yaml#/components/parameters/Limit"]));
        const ok = okSchema(P_DOC, id);
        sortedEq(ok.required, ["data", "page"]);
        expect(ok.properties.data.maxItems).toBeLessThanOrEqual(200);
        expect(JSON.stringify(ok.properties.page)).toContain("PageInfo");
      });
    });
  }
});

describe("T0C-SALES-1 shapes: designations (levels 1 to 8)", () => {
  it("SalesDesignation row: id, name, level 1..8, is_active, version, timestamps; create needs name + level; update clears nothing and needs at least one field", () => {
    const row = itemSchema(P_DOC, "listSalesDesignations");
    for (const f of ["id", "name", "level", "is_active", "version", "created_at", "updated_at"]) expect(props(row)[f], `row.${f}`).toBeDefined();
    expect(row.required).toEqual(expect.arrayContaining(["id", "name", "level", "is_active", "version"]));
    expect(props(row).level).toMatchObject({ type: "integer", minimum: 1, maximum: 8 });
    const c = reqSchema(P_DOC, "createSalesDesignation");
    sortedEq(c.required, ["name", "level"]);
    expect(props(c).name).toMatchObject({ type: "string", minLength: 1 });
    expect(props(c).name.maxLength).toBeLessThanOrEqual(120);
    expect(props(c).level).toMatchObject({ type: "integer", minimum: 1, maximum: 8 });
    const u = reqSchema(P_DOC, "updateSalesDesignation");
    expect(u.required ?? []).toEqual([]);
    expect(u.minProperties).toBeGreaterThanOrEqual(1);
    for (const f of ["name", "level", "is_active"]) expect(props(u)[f], `update.${f}`).toBeDefined();
  });
  it("payloads: level 1..8 accepted; 0, 9, 1.5, '3', empty name and unknown fields rejected", () => {
    const v = validatorFor("partners.yaml", P_DOC, "createSalesDesignation", "req");
    for (const level of [1, 4, 8]) expect(v({ name: "Regional Head (synthetic)", level }), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ level: 0 }, { level: 9 }, { level: 1.5 }, { level: "3" }, { name: "" }, { unknown_field: 1 }, { tenant_id: UUID }]) expect(v({ name: "Area Head", level: 3, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    expect(v({ name: "Area Head" })).toBe(false);
    const u = validatorFor("partners.yaml", P_DOC, "updateSalesDesignation", "req");
    expect(u({ is_active: false })).toBe(true);
    expect(u({})).toBe(false);
    expect(u({ level: 9 })).toBe(false);
  });
  it("list filters: is_active, level, q", () => {
    const names = paramNames(P_DOC, opIn(P_DOC, "listSalesDesignations")!.op);
    for (const n of ["is_active", "level", "q"]) expect(names, n).toContain(n);
  });
});

describe("T0C-SALES-1 shapes: representatives and the manager tree", () => {
  const rowFields = ["id", "name", "phone", "email", "user_id", "designation_id", "manager_id", "joining_date", "is_active", "version", "created_at", "updated_at"];
  it("SalesRepresentative row carries the brief's fields; required = id, name, designation_id, is_active, version; optional fields are not nullable", () => {
    const row = itemSchema(P_DOC, "listSalesRepresentatives");
    for (const f of rowFields) expect(props(row)[f], `row.${f}`).toBeDefined();
    expect(row.required).toEqual(expect.arrayContaining(["id", "name", "designation_id", "is_active", "version"]));
    for (const f of ["phone", "email", "user_id", "manager_id", "joining_date"]) { expect(row.required, f).not.toContain(f); expect(props(row)[f].nullable).not.toBe(true); }
    expect(props(row).name.maxLength).toBeLessThanOrEqual(200);
    expect(props(row).phone.maxLength).toBeLessThanOrEqual(30);
    expect(JSON.stringify(props(row).joining_date)).toContain("IsoDate");
    expect(JSON.stringify(props(row).manager_id)).toContain("Uuid");
  });
  it("create: name + designation_id required; phone, email, user_id, manager_id, joining_date optional; update clears through unset[] and never sets is_active (deactivate has its own operation)", () => {
    const c = reqSchema(P_DOC, "createSalesRepresentative");
    sortedEq(c.required, ["name", "designation_id"]);
    for (const f of ["phone", "email", "user_id", "manager_id", "joining_date"]) expect(props(c)[f], `create.${f}`).toBeDefined();
    const u = reqSchema(P_DOC, "updateSalesRepresentative");
    expect(u.required ?? []).toEqual([]);
    expect(u.minProperties).toBeGreaterThanOrEqual(1);
    const unset = deref(P_DOC, props(u).unset)?.items?.enum as string[];
    expect(unset, "update.unset").toBeDefined();
    for (const f of ["phone", "email", "user_id", "manager_id", "joining_date"]) expect(unset, `unset ${f}`).toContain(f);
    expect(props(u).is_active, "update must not toggle is_active").toBeUndefined();
  });
  it("payloads: a full representative validates; missing designation, bad uuid and bad date are rejected", () => {
    const v = validatorFor("partners.yaml", P_DOC, "createSalesRepresentative", "req");
    const ok = { name: "Synthetic Representative", phone: "+9779800000000", email: "rep@example.test", user_id: UUID, designation_id: UUID, manager_id: UUID, joining_date: "2026-11-17" };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ name: "Only Name", designation_id: UUID })).toBe(true);
    for (const bad of [{ designation_id: "x" }, { manager_id: "x" }, { name: "" }, { joining_date: "17-11-2026" }, { unknown_field: 1 }]) expect(v({ ...ok, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    expect(v({ name: "No Designation" })).toBe(false);
    const u = validatorFor("partners.yaml", P_DOC, "updateSalesRepresentative", "req");
    expect(u({ manager_id: UUID })).toBe(true);
    expect(u({ unset: ["manager_id"] })).toBe(true);
    expect(u({ unset: ["name"] })).toBe(false);
  });
  it("list filters: q, designation_id, manager_id, is_active; the search parameter is never called name, email or phone", () => {
    const names = paramNames(P_DOC, opIn(P_DOC, "listSalesRepresentatives")!.op);
    for (const n of ["q", "designation_id", "manager_id", "is_active"]) expect(names, n).toContain(n);
    for (const n of ["name", "email", "phone"]) expect(names, n).not.toContain(n);
    expect(String(opIn(P_DOC, "listSalesRepresentatives")!.op.description ?? "") + String(opIn(P_DOC, "createSalesRepresentative")!.op.description ?? "")).toMatch(/manager/i);
  });
  it("deactivate takes If-Match and answers the representative; its description says the reporting line and open assignments stay", () => {
    const o = opIn(P_DOC, "deactivateSalesRepresentative")!;
    expect(JSON.stringify(okSchema(P_DOC, "deactivateSalesRepresentative"))).toContain("is_active");
    expect(String(o.op.description ?? ""), "description must state what happens to reports and assignments").toMatch(/assign|report|manager/i);
  });
  it("getSalesTree: flat paged list, node {id, name, designation_id, designation_level, manager_id?, depth 1..8, is_active}; max_depth 1..8 default 8; root_id", () => {
    const node = itemSchema(P_DOC, "getSalesTree");
    for (const f of ["id", "name", "designation_id", "designation_level", "manager_id", "depth", "is_active"]) expect(props(node)[f], `node.${f}`).toBeDefined();
    expect(node.required).toEqual(expect.arrayContaining(["id", "name", "designation_id", "designation_level", "depth", "is_active"]));
    expect(node.required).not.toContain("manager_id");
    expect(props(node).depth).toMatchObject({ type: "integer", minimum: 1, maximum: 8 });
    expect(props(node).designation_level).toMatchObject({ type: "integer", minimum: 1, maximum: 8 });
    const md = paramOf(P_DOC, opIn(P_DOC, "getSalesTree")!.op, "max_depth");
    expect(md?.schema).toMatchObject({ type: "integer", minimum: 1, maximum: 8, default: 8 });
    expect(paramNames(P_DOC, opIn(P_DOC, "getSalesTree")!.op)).toContain("root_id");
  });
});

describe("T0C-SALES-1 shapes: party assignment and the representative client list", () => {
  it("assignPartyToRepresentative: party_kind (partner | credit_party | doctor | referrer), party_id, representative_id, effective_from required; effective_to optional", () => {
    const c = reqSchema(P_DOC, "assignPartyToRepresentative");
    sortedEq(c.required, ["party_kind", "party_id", "representative_id", "effective_from"]);
    sortedEq(enumOf(props(c).party_kind), PARTY_KINDS);
    for (const v of PARTY_KINDS) expect(v.length <= props(c).party_kind.maxLength, `maxLength fits ${v}`).toBe(true);
    expect(props(c).effective_to).toBeDefined();
    const row = okSchema(P_DOC, "assignPartyToRepresentative");
    for (const f of ["id", "party_kind", "party_id", "representative_id", "effective_from", "effective_to", "version"]) expect(props(row)[f], `assignment.${f}`).toBeDefined();
    expect(row.required).not.toContain("effective_to");
  });
  it("assign payloads: valid; unknown kind, bad uuid, bad date, missing representative rejected; unassign body is optional and closed", () => {
    const v = validatorFor("partners.yaml", P_DOC, "assignPartyToRepresentative", "req");
    const ok = { party_kind: "credit_party", party_id: UUID, representative_id: UUID, effective_from: "2026-11-17" };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ ...ok, effective_to: "2027-11-16" })).toBe(true);
    for (const bad of [{ party_kind: "franchise" }, { party_id: "x" }, { effective_from: "yesterday" }, { unknown_field: 1 }]) expect(v({ ...ok, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    expect(v({ party_kind: "doctor", party_id: UUID, effective_from: "2026-11-17" })).toBe(false);
    const o = opIn(P_DOC, "unassignPartyFromRepresentative")!;
    if (o.op.requestBody) { expect(o.op.requestBody.required).not.toBe(true); expect(reqSchema(P_DOC, "unassignPartyFromRepresentative").additionalProperties).toBe(false); }
  });
  it("listRepresentativeClients row: party kind, id and name, outstanding_paisa integer paisa, last_bill_date, assignment window; filters party_kind, as_of", () => {
    const row = itemSchema(P_DOC, "listRepresentativeClients");
    for (const f of ["assignment_id", "party_kind", "party_id", "party_name", "outstanding_paisa", "last_bill_date", "effective_from", "effective_to"]) expect(props(row)[f], `client.${f}`).toBeDefined();
    expect(row.required).toEqual(expect.arrayContaining(["assignment_id", "party_kind", "party_id", "party_name", "outstanding_paisa", "effective_from"]));
    expect(row.required).not.toContain("last_bill_date");
    expect(props(row).outstanding_paisa.type).toBe("integer");
    sortedEq(enumOf(props(row).party_kind), PARTY_KINDS);
    const names = paramNames(P_DOC, opIn(P_DOC, "listRepresentativeClients")!.op);
    for (const n of ["representative_id", "party_kind", "as_of"]) expect(names, n).toContain(n);
  });
  it("the client list answers only the representative's own clients: description says so and names the date window", () => {
    expect(String(opIn(P_DOC, "listRepresentativeClients")!.op.description ?? "")).toMatch(/effective|as_of|active assignment/i);
  });
});

describe("T0C-SALES-1 shapes: service areas (free text, not pincodes)", () => {
  it("ServiceArea row: name, district, area_text, centre_id, is_active, version; create needs name + district; no pincode field anywhere", () => {
    const row = itemSchema(P_DOC, "listServiceAreas");
    for (const f of ["id", "name", "district", "area_text", "centre_id", "is_active", "version"]) expect(props(row)[f], `area.${f}`).toBeDefined();
    expect(row.required).toEqual(expect.arrayContaining(["id", "name", "district", "is_active", "version"]));
    for (const f of ["area_text", "centre_id"]) { expect(row.required, f).not.toContain(f); expect(props(row)[f].nullable).not.toBe(true); }
    for (const f of ["name", "district", "area_text"]) expect(props(row)[f].maxLength, f).toBeLessThanOrEqual(500);
    const c = reqSchema(P_DOC, "createServiceArea");
    sortedEq(c.required, ["name", "district"]);
    const u = reqSchema(P_DOC, "updateServiceArea");
    expect(u.minProperties).toBeGreaterThanOrEqual(1);
    const unset = deref(P_DOC, props(u).unset)?.items?.enum as string[];
    for (const f of ["area_text", "centre_id"]) expect(unset ?? [], `unset ${f}`).toContain(f);
    expect(JSON.stringify([c, u, row]).toLowerCase()).not.toMatch(/pincode|pin_code|postal/);
  });
  it("payloads: a free text area validates; empty name, unknown field and bad centre uuid are rejected; list filters district, centre_id, is_active, q", () => {
    const v = validatorFor("partners.yaml", P_DOC, "createServiceArea", "req");
    expect(v({ name: "Synthetic ward 4", district: "Kathmandu", area_text: "Synthetic municipality, ward 4, near the synthetic chowk", centre_id: UUID }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ name: "Synthetic ward 5", district: "Lalitpur" })).toBe(true);
    for (const bad of [{ name: "" }, { district: "" }, { centre_id: "x" }, { pincode: "44600" }]) expect(v({ name: "A", district: "B", ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    const names = paramNames(P_DOC, opIn(P_DOC, "listServiceAreas")!.op);
    for (const n of ["district", "centre_id", "is_active", "q"]) expect(names, n).toContain(n);
  });
});

describe("T0C-SALES-1 homecollection.yaml: collector flags (done_when 3, 4)", () => {
  it("listEligiblePhlebotomists items gain allow_collection and allow_pickup (boolean, not required, not nullable); the item stays closed", () => {
    const item = itemSchema(H_DOC, "listEligiblePhlebotomists");
    expect(item.additionalProperties).toBe(false);
    for (const f of ["allow_collection", "allow_pickup"]) {
      expect(props(item)[f], f).toBeDefined();
      expect(props(item)[f].type).toBe("boolean");
      expect(item.required).not.toContain(f);
      expect(props(item)[f].nullable).not.toBe(true);
      expect(String(props(item)[f].description ?? ""), `${f} description names the default true`).toMatch(/default|true/i);
    }
  });
  it(`updateCollectorFlags: ${HOP.method.toUpperCase()} ${HOP.path}, permission ${HOP.perm}, closed body with at least one boolean, returns the flags`, () => {
    const o = opIn(H_DOC, HOP.id);
    expect(o, "updateCollectorFlags missing").toBeDefined();
    expect([o!.method, o!.path]).toEqual([HOP.method, HOP.path]);
    expect(o!.op["x-permission"]).toBe(HOP.perm);
    expect(o!.op.tags).toEqual(["homecollection"]);
    expect(o!.op.security).toEqual([{ bearerJwt: [] }]);
    const e: string[] = o!.op["x-error-codes"];
    for (const c of ["common.validation_failed", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal", "common.not_found"]) expect(e, c).toContain(c);
    const priv = (registry.permissions as any[]).find((p) => p.code === HOP.perm)?.privileged;
    if (priv) expect(e).toContain(MFA);
    const b = reqSchema(H_DOC, HOP.id);
    expect(b.additionalProperties).toBe(false);
    expect(b.minProperties).toBeGreaterThanOrEqual(1);
    sortedEq(Object.keys(props(b)), ["allow_collection", "allow_pickup"]);
    for (const f of ["allow_collection", "allow_pickup"]) expect(props(b)[f].type).toBe("boolean");
    const ok = okSchema(H_DOC, HOP.id);
    for (const f of ["membership_id", "allow_collection", "allow_pickup"]) expect(props(ok)[f], `response.${f}`).toBeDefined();
    expect(ok.additionalProperties).toBe(false);
    expect(Object.keys(o!.op.responses["200"].content["application/json"].examples ?? {}).length).toBeGreaterThan(0);
  });
  it("flag payloads: one or both booleans validate; empty body, string and unknown field are rejected", () => {
    const v = validatorFor("homecollection.yaml", H_DOC, HOP.id, "req");
    expect(v({ allow_collection: false })).toBe(true);
    expect(v({ allow_pickup: false, allow_collection: true })).toBe(true);
    for (const bad of [{}, { allow_pickup: "no" }, { allow_collection: null }, { allow_collection: true, extra: 1 }]) expect(v(bad), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });
});

describe("T0C-SALES-1 examples", () => {
  const check = (file: string, doc: any, id: string) => {
    const o = opIn(doc, id)!;
    const reqEx = o.op.requestBody?.content?.["application/json"]?.examples;
    if (reqEx) for (const e of Object.values<any>(reqEx)) { const v = validatorFor(file, doc, id, "req"); expect(v(e.value), `${id} request example: ${JSON.stringify(v.errors?.[0])}`).toBe(true); }
    for (const [code, r] of Object.entries<any>(o.op.responses)) {
      if (r.$ref || !r.content?.["application/json"]?.examples) continue;
      for (const e of Object.values<any>(r.content["application/json"].examples)) { const v = validatorFor(file, doc, id, code); expect(v(e.value), `${id} ${code} example: ${JSON.stringify(v.errors?.[0])}`).toBe(true); }
    }
  };
  it("every request and response example of the 15 partners operations validates against its schema, with synthetic values only", () => {
    for (const id of Object.keys(OPS)) check("partners.yaml", P_DOC, id);
    const text = JSON.stringify(Object.keys(OPS).map((id) => opIn(P_DOC, id)!.op));
    expect(text).not.toMatch(/@(?!example\.(test|com|org)|[a-z0-9.-]*\.test)/i);
    expect(text).not.toMatch(/\b9[78]\d{8}\b/);
  });
  it("the updateCollectorFlags examples validate", () => { check("homecollection.yaml", H_DOC, HOP.id); });
});

describe("T0C-SALES-1 permissions (done_when 5)", () => {
  const byCode = new Map<string, any>(registry.permissions.map((p: any) => [p.code, p]));
  it("partners.sales.read (not privileged) and partners.sales.manage (privileged) exist, owned by tenant_admin, finance and lab_manager, all roles known", () => {
    const known = new Set([...registry.roles, ...registry.partner_roles, ...registry.platform_roles].map((r: any) => r.code));
    for (const [code, priv] of [["partners.sales.read", false], ["partners.sales.manage", true]] as const) {
      const p = byCode.get(code);
      expect(p, `${code} missing from contracts/permissions.yaml`).toBeDefined();
      expect(p.privileged, `${code} privileged`).toBe(priv);
      for (const r of ["tenant_admin", "finance", "lab_manager"]) expect(p.roles, `${code} role ${r}`).toContain(r);
      for (const r of p.roles) expect(known.has(r), `${code} unknown role ${r}`).toBe(true);
      expect(p.roles.filter((r: string) => r.startsWith("partner_") || r.startsWith("platform_")), "never a partner or platform role").toEqual([]);
    }
  });
  it("the registry grew only by these two partners codes; the 14 older partners codes keep their flags and roles", () => {
    const partners = registry.permissions.filter((p: any) => p.code.startsWith("partners.")).map((p: any) => p.code);
    sortedEq(partners, ["partners.manifest.receive", "partners.manifest.submit", "partners.order.read", "partners.partner.manage", "partners.partner.read", "partners.partner_user.manage", "partners.pickup.manage",
      "partners.pickup.request", "partners.price_list.read", "partners.referrer.manage", "partners.referrer.map", "partners.referrer.read", "partners.report.read", "partners.statement.read",
      "partners.sales.read", "partners.sales.manage",
      // T0C-PARTYSET-1 (LD-321): the five party settings codes are pinned in partyset1-openapi.test.ts; the other LD-321 tasks' codes are pinned in theirs
      "partners.party_setting.read", "partners.party_setting.manage", "partners.onboarding.decide", "partners.party_id_number.read", "partners.penalty.manage"]);
    expect(byCode.get("partners.referrer.map").roles).toEqual(["tenant_admin", "lab_manager"]);
    expect(byCode.get("partners.referrer.read").roles).toEqual([]);
    expect(registry.fixed_actor_permissions.partner.partner_admin.join(",")).not.toContain("partners.sales");
  });
  it("every x-permission of the 15 operations is one of the two codes and both are used; privileged code only on writes", () => {
    const used = new Set(Object.keys(OPS).map((id) => opIn(P_DOC, id)!.op["x-permission"]));
    sortedEq([...used] as string[], [R, M]);
    for (const [id, s] of Object.entries(OPS)) expect(opIn(P_DOC, id)!.op["x-permission"] === M, id).toBe(s.method !== "get");
  });
  it("corp_admin pack holds both codes, sorted and without duplicates", () => {
    const admin = packs.packs.flatMap((p: any) => p.roles).find((r: any) => r.code === "corp_admin");
    for (const c of [R, M]) expect(admin.permissions, `corp_admin lacks ${c}`).toContain(c);
    expect(new Set(admin.permissions).size).toBe(admin.permissions.length);
    expect(admin.permissions).toEqual([...admin.permissions].sort());
  });
  it("partners.sales.* never appears in a partner actor's fixed permissions (staff only)", () => {
    expect(JSON.stringify(registry.fixed_actor_permissions)).not.toContain("partners.sales");
  });
});

describe("T0C-SALES-1 generated clients and the pending-operations rule (LD-325)", () => {
  it("generated clients and MSW handlers are fresh (codegen --check)", () => { expect(staleFiles(ROOT)).toEqual([]); }, 120_000);
  it("partners and homecollection module manifests list the new operationIds in pendingOperations (T0B-SALES-1 removes them)", () => {
    for (const [file, ids] of [["partners", Object.keys(OPS)], ["homecollection", [HOP.id]]] as const) {
      const p = join(ROOT, `services/api/src/modules/${file}/index.ts`);
      expect(existsSync(p)).toBe(true);
      const t = readFileSync(p, "utf8");
      expect(t, `${file}/index.ts must declare pendingOperations`).toMatch(/pendingOperations/);
      for (const id of ids) expect(t, `${file} pendingOperations lists ${id}`).toContain(id);
    }
  });
});

describe("T0C-SALES-1 migration file (static; behaviour in the pgTAP suite)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");
  const TABLES = ["sales_designation", "sales_representative", "party_sales_assignment", "service_area"];

  it("exists, is the only 20261117210000 migration, sorts after the ACCT-1 and TESTMGMT-1 migrations, runs as lims_owner", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all.filter((f) => f.startsWith("20261117210000"))).toEqual([MIG]);
    for (const older of ["20261117120000_billing__add_lab_accounting.sql", "20261117170000_catalog__test_management_parity.sql"]) expect(all.indexOf(MIG)).toBeGreaterThan(all.indexOf(older));
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("creates the four tables IF NOT EXISTS in schema partners, each with ENABLE + FORCE row level security, a tenant policy and a grant to lims_app only, and no DELETE grant", () => {
    for (const t of TABLES) {
      expect(code, `CREATE TABLE ${t}`).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS partners\\.${t}\\b`, "i"));
      expect(code, `ENABLE RLS ${t}`).toMatch(new RegExp(`ALTER TABLE partners\\.${t} ENABLE ROW LEVEL SECURITY`, "i"));
      expect(code, `FORCE RLS ${t}`).toMatch(new RegExp(`ALTER TABLE partners\\.${t} FORCE ROW LEVEL SECURITY`, "i"));
      expect(code, `policy on ${t}`).toMatch(new RegExp(`CREATE POLICY[^;]*ON partners\\.${t}\\b[^;]*app\\.current_tenant_id\\(\\)`, "is"));
      const g = code.match(new RegExp(`GRANT\\s+([^;]*?)\\s+ON\\s+partners\\.${t}\\s+TO\\s+lims_app`, "i"));
      expect(g, `GRANT lims_app ${t}`).not.toBeNull();
      expect(g![1], `${t}: no DELETE / ALL / TRUNCATE (deactivate, never delete)`).not.toMatch(/\bDELETE\b|\bALL\b|\bTRUNCATE\b/i);
    }
    expect(code).not.toMatch(/TO\s+(PUBLIC|anon|authenticated)\b/i);
  });
  it("collector flags: homecollection.collector_flags IF NOT EXISTS with allow_collection and allow_pickup boolean NOT NULL DEFAULT true, FORCE RLS, tenant policy, grant", () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS homecollection\.collector_flags\b/i);
    for (const f of ["allow_collection", "allow_pickup"]) expect(code, f).toMatch(new RegExp(`\\b${f}\\s+boolean\\s+NOT NULL\\s+DEFAULT\\s+true\\b`, "i"));
    expect(code).toMatch(/ALTER TABLE homecollection\.collector_flags ENABLE ROW LEVEL SECURITY/i);
    expect(code).toMatch(/ALTER TABLE homecollection\.collector_flags FORCE ROW LEVEL SECURITY/i);
    expect(code).toMatch(/CREATE POLICY[^;]*ON homecollection\.collector_flags\b[^;]*app\.current_tenant_id\(\)/is);
    expect(code).toMatch(/GRANT[^;]*ON homecollection\.collector_flags TO lims_app/i);
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
  it("database rules exist: manager guard trigger on sales_representative (self + loop), overlap rule on party_sales_assignment (exclusion constraint or trigger), audit triggers, search_path pinned", () => {
    expect(code).toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+\w+\s+BEFORE\s+INSERT\s+OR\s+UPDATE[^;]*ON\s+partners\.sales_representative/i);
    expect(code, "a manager chain is walked with a recursive query").toMatch(/WITH\s+RECURSIVE/i);
    expect(code).toMatch(/EXCLUDE\s+USING\s+gist|CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+\w+\s+BEFORE\s+INSERT\s+OR\s+UPDATE[^;]*ON\s+partners\.party_sales_assignment/i);
    for (const t of TABLES) expect(code, `audit trigger ${t}`).toMatch(new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?TRIGGER\\s+${t}__audit\\b[^;]*ON partners\\.${t}\\b[^;]*tg_row_audit`, "is"));
    for (const m of code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\S+)\s*\([^)]*\)\s+RETURNS\s+trigger[\s\S]*?\$\$;?/gi)) expect(m[0], `${m[1]} must pin search_path`).toMatch(/SET\s+search_path\s*=\s*''/i);
  });
  it("is additive: no DROP of data, no TRUNCATE / DELETE / INSERT / UPDATE data statement, no ALTER of an old table, type or enum, no REVOKE, no sequence, no money column", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect(code).not.toMatch(/\b(DROP\s+(TABLE|COLUMN|SCHEMA|INDEX|POLICY|TRIGGER)|TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|REVOKE)\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+\S+\s+SET\b/i);
    expect(code).not.toMatch(/\bCREATE\s+TYPE\b|\bAS\s+ENUM\b|DISABLE\s+ROW|NO\s+FORCE|ALTER\s+COLUMN|CREATE\s+SEQUENCE/i);
    const mine = [...TABLES.map((t) => `partners.${t}`), "homecollection.collector_flags"];
    for (const m of code.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF EXISTS\s+)?((?:partners|homecollection)\.\w+)/gi)) expect(mine, `ALTER of an old table ${m[1]}`).toContain(m[1]);
    expect(code).not.toMatch(/\b(float|double precision|real|numeric|decimal|money)\b/i);
  });
  it("comments: LD-321, the five tables, down note with DROP TABLE, additive / no rewrite, free text areas not pincodes, push-cloud founder step", () => {
    expect(comments).toMatch(/LD-321/);
    expect(comments).toMatch(/\bdown\b/i);
    expect(comments).toMatch(/DROP TABLE/i);
    for (const t of [...TABLES, "collector_flags"]) expect(comments, `down note names ${t}`).toContain(t);
    expect(comments).toMatch(/no data rewrite|does not rewrite|no rewrite|additive/i);
    expect(comments).toMatch(/pincode/i);
    expect(comments).toMatch(/district/i);
    expect(comments).toMatch(/push-cloud/i);
  });
});

describe("T0C-SALES-1 implementation notes: FIELD MAP, permissions, offline classification (done_when 1, 7)", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  const lines = t.split("\n");
  // every ElabAssist label of the sales, designation, sales client list, services in area and collection boy sections of C:/LIMS-state/elabassist-sales-20261117.md
  const LABELS = ["Name", "Code", "Mobile No.", "Email", "Address", "Track", "Designation", "Manager", "Doctor enrol", "Level", "Client Code", "Client Name", "Billing Type", "O/S Balance", "Credit Limit",
    "Total Patient", "Amount", "Rate Master", "EmailId", "Sales Person", "Sales Manager", "Sales Ref", "Enter PinCode", "Laboratory", "Collection Point", "Allow Collection", "Allow Pickup"];
  it("notes exist, name the migration as a founder step (push-cloud), cite LD-321, list every operation id, the pendingOperations move and T0B-SALES-1", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-SALES-1-impl.md missing").toBe(true);
    expect(t).toContain(MIG);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/LD-321/);
    for (const id of [...Object.keys(OPS), HOP.id]) expect(t, id).toContain(id);
    expect(t).toMatch(/pendingOperations/);
    expect(t).toMatch(/T0B-SALES-1/);
  });
  it("lists every new permission code and the role-pack re-apply founder step", () => {
    for (const c of [R, M]) expect(t, c).toContain(c);
    expect(t).toMatch(/apply-role-pack|role pack/i);
  });
  it("gives the offline classification (founder 09:19): all writes online only, a representative may read the own client list offline from the cache", () => {
    expect(t).toMatch(/offline/i);
    expect(t).toMatch(/online only/i);
    expect(t).toMatch(/cache/i);
    expect(t).toMatch(/own client list|client list/i);
  });
  it("says areas are free text (district, municipality) not pincodes, and records the homecollection collector decision for the lead", () => {
    expect(t).toMatch(/free text/i);
    expect(t).toMatch(/pincode/i);
    expect(t).toMatch(/district/i);
    expect(t).toMatch(/collector_flags/);
    expect(t).toMatch(/updateCollectorFlags/);
  });
  it("every ElabAssist field label has one decision line: present (field named), added (field named) or not added (reason)", () => {
    expect(t.length, "impl notes missing").toBeGreaterThan(0);
    // a decision line STARTS with the label (after bullet / table / bold marks) and then a separator (— - : | = ( or end), e.g. "- **Name** — added (sales_representative.name)"
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
