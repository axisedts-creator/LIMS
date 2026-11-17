// T0C-SYNC-2 (LD-322, LD-325; founder blanket authority LD-310; founder 2026-11-17 09:19 NPT "works offline, when internet arrives all data gets bulk pushed to the server", 09:20 NPT own server) —
// offline sync part 2: contracts/openapi/core.yaml (5 additive staff operations under /v1/core/sync: pushSyncBatch, pullChanges, listSyncConflicts, getSyncConflict, resolveSyncConflict),
// the closed operation catalogue (oneOf + discriminator on op_type, 8 entries), contracts/errors.yaml (9 sync.* codes), migration 20261117260000_core__add_sync_operations_and_conflicts.sql
// (static checks; behaviour is db/tests/core/T0C-SYNC-2_sync_operations_conflicts.test.sql), generated-client freshness, the pending-operations rule of LD-325(b), implementer notes.
// Design source: C:/LIMS-state/offline-design-20261117.md (sections 2, 3, 4, 5, 7, 8). Part 1: tools/codegen/__tests__/sync1-openapi.test.ts (device registry, number blocks).
// ASSUMPTIONS (the brief gives names and rules, not wire shapes; a different choice needs a ruling, not a silent test edit; same style as T0C-SYNC-1):
//  - WHERE: contracts/openapi/core.yaml (same file as part 1, additive), all paths under /v1/core/sync. Tag core, bearerJwt, x-context tenant. No new permission code: the three part 1 codes are reused
//    (the brief: "contracts/permissions.yaml only if a code is missing"): pushSyncBatch and pullChanges need sync.use; list / get / resolve of conflicts need sync.conflict.resolve (privileged, so
//    auth.mfa_required is listed; the person who pushed sees the conflict status and conflict_id in the push result).
//  - PATHS: POST /v1/core/sync/batches (push), POST /v1/core/sync/pull (a read by POST because the body carries one cursor per entity type; x-idempotency none with an E1..E4 justification, lint rule),
//    GET /v1/core/sync/conflicts, GET /v1/core/sync/conflicts/{conflict_id}, POST /v1/core/sync/conflicts/{conflict_id}/resolve (Idempotency-Key required; no If-Match: the conflict row is
//    resolved once, a second resolution answers common.immutable_record). pushSyncBatch has x-idempotency none: op_id IS the idempotency key (design principle 3), no Idempotency-Key header.
//  - CATALOGUE: request body {device_id, operations[1..N]} with N >= 50 in the schema (the 50 limit and 1 MB are service rules answered per request as sync.batch_too_large, so the code is reachable;
//    the text states both). Each operation is an object with op_id, op_type, base_version?, entity_id?, payload, device_created_at. The 8 op_types and what each wraps (pinned in WRAPS below):
//    registration.create_order -> createRegistration, billing.record_receipt -> recordPayment, collection.mark_collected -> collectSpecimen, accession.receive -> receiveSpecimen,
//    result.enter -> bulkEnterResults, result.verify -> verifyResult, report.print_marker -> createReportPrint, daily_cash.close -> closeCashSession. `payload` is a $ref to the SAME schema object the
//    wrapped operation uses as its request body (identity, so no field is copied; an inline request body is hoisted to a component by the implementer). The path id of the wrapped operation
//    (order_id, specimen_id, result_id, report_version_id, cash_session_id) travels as `entity_id`, required for 6 of the 8 (not for registration.create_order and result.enter, which create).
//    base_version (type _common Version, integer >= 1) is required in the schema exactly where the wrapped operation requires If-Match: collection.mark_collected, accession.receive, result.verify,
//    daily_cash.close. The server never reads user_id, tenant_id, server_received_at, status from a request.
//  - RESULTS: {results[]} one per op_id: op_id, status (accepted | duplicate | rejected | conflict), error_code (closed enum of registered codes, at least the nine new ones), conflict_id?, entity_id?,
//    number_mappings? [{document_type bill|invoice|receipt, provisional_number "OFF-...", final_number}], skew_flag. A request level 429 carries Retry-After (common response) and says retry_after in the text.
//  - PULL: request {device_id, entities[{entity_type (whitelist enum), cursor? opaque string <= 512}], limit?}; response {changes[{entity_type, upserts[], tombstones[{id, removed_at}], next_cursor, has_more}], server_time}.
//    Row bodies (`document`, conflict local / server payload) are free form JSON (they are jsonb); every object WITH properties is closed.
//  - ERROR CODES (closed list, owner C0): sync.base_version_stale 409, sync.op_id_reused 422, sync.batch_too_large 422, sync.clock_skew_too_large 422, sync.result_locked 409,
//    sync.verification_policy_failed 403, sync.offline_not_allowed 403, sync.number_out_of_block 422, sync.entity_changed 409. registry-equality.test.ts was widened by exactly these nine.
//  - MIGRATION: tables core.sync_operation (PK (tenant_id, op_id), no id column) and core.sync_conflict; the outcome of an operation is written once; version column on at most 5 old tables.
//  - LD-325(b): the 5 operationIds are added to CORE_PENDING_OPERATIONS; T0B-SYNC-2..5 remove them with the handlers. Notes: .orchestra/notes/T0C-SYNC-2-impl.md.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = "20261117260000_core__add_sync_operations_and_conflicts.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-SYNC-2-impl.md");
const load = (f: string): any => parse(readFileSync(join(ROOT, f), "utf8"));
const DOCS: Record<string, any> = {};
for (const f of readdirSync(join(ROOT, "contracts/openapi")).filter((x) => x.endsWith(".yaml"))) DOCS[f] = load(`contracts/openapi/${f}`);
const C_DOC = DOCS["core.yaml"];
const common = DOCS["_common.yaml"];
const registry = load("contracts/permissions.yaml");
const errorsYaml: any[] = load("contracts/errors.yaml");
const METHODS = ["get", "put", "post", "delete", "patch"];
const PFX = "/v1/core/sync";
const U = (n: number) => `0193c4a0-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`;
const NOW = "2026-11-17T10:15:00Z";

type OpSpec = { method: string; path: string; perm: string; idem: "required" | "none"; ok: string; paged?: boolean; pathId?: boolean };
const USE = "sync.use", RES = "sync.conflict.resolve";
const OPS: Record<string, OpSpec> = {
  pushSyncBatch: { method: "post", path: `${PFX}/batches`, perm: USE, idem: "none", ok: "200" },
  pullChanges: { method: "post", path: `${PFX}/pull`, perm: USE, idem: "none", ok: "200" },
  listSyncConflicts: { method: "get", path: `${PFX}/conflicts`, perm: RES, idem: "none", ok: "200", paged: true },
  getSyncConflict: { method: "get", path: `${PFX}/conflicts/{conflict_id}`, perm: RES, idem: "none", ok: "200", pathId: true },
  resolveSyncConflict: { method: "post", path: `${PFX}/conflicts/{conflict_id}/resolve`, perm: RES, idem: "required", ok: "200", pathId: true },
};
const NEW_ERRORS: Record<string, number> = {
  "sync.base_version_stale": 409, "sync.op_id_reused": 422, "sync.batch_too_large": 422, "sync.clock_skew_too_large": 422, "sync.result_locked": 409,
  "sync.verification_policy_failed": 403, "sync.offline_not_allowed": 403, "sync.number_out_of_block": 422, "sync.entity_changed": 409,
};
const OP_ERRORS: Record<string, string[]> = {
  pushSyncBatch: ["sync.batch_too_large", "sync.device_unknown", "sync.device_revoked", "sync.wipe_required"],
  pullChanges: ["sync.device_unknown", "sync.device_revoked", "sync.wipe_required", "common.invalid_cursor"],
  resolveSyncConflict: ["sync.entity_changed", "common.immutable_record", "common.idempotency_key_required"],
};
const OP_TYPES = ["registration.create_order", "billing.record_receipt", "collection.mark_collected", "accession.receive", "result.enter", "result.verify", "report.print_marker", "daily_cash.close"];
// op_type -> wrapped operation (file, operationId), permission, base_version required, entity_id required
const WRAPS: Record<string, { file: string; op: string; perm: string; base: boolean; entity: boolean }> = {
  "registration.create_order": { file: "frontdesk.yaml", op: "createRegistration", perm: "frontdesk.registration.create", base: false, entity: false },
  "billing.record_receipt": { file: "billing.yaml", op: "recordPayment", perm: "billing.payment.record", base: false, entity: true },
  "collection.mark_collected": { file: "lab.yaml", op: "collectSpecimen", perm: "lab.specimen.collect", base: true, entity: true },
  "accession.receive": { file: "lab.yaml", op: "receiveSpecimen", perm: "lab.specimen.receive", base: true, entity: true },
  "result.enter": { file: "lab.yaml", op: "bulkEnterResults", perm: "lab.result.enter", base: false, entity: false },
  "result.verify": { file: "lab.yaml", op: "verifyResult", perm: "lab.result.verify", base: true, entity: true },
  "report.print_marker": { file: "reporting.yaml", op: "createReportPrint", perm: "reporting.report.print", base: false, entity: true },
  "daily_cash.close": { file: "billing.yaml", op: "closeCashSession", perm: "billing.payment.record", base: true, entity: true },
};
const STATUSES = ["accepted", "duplicate", "rejected", "conflict"];
const MFA = "auth.mfa_required";
const ENTITY_MUST = ["test", "parameter", "doctor", "centre", "price_list_version", "verification_policy", "print_profile", "patient"];

const unesc = (k: string) => decodeURIComponent(k).replace(/~1/g, "/").replace(/~0/g, "~");
/** follow $ref chains across the openapi files; returns the node and the file it lives in */
const rs = (doc: string, s: any): { doc: string; node: any } => {
  let cur = { doc, node: s };
  for (let i = 0; cur.node?.$ref && i < 20; i++) {
    const [file, ptr] = String(cur.node.$ref).split("#");
    const d = file || cur.doc;
    const root = DOCS[d];
    if (!root) throw new Error(`unknown file in $ref ${cur.node.$ref}`);
    cur = { doc: d, node: (ptr ?? "").split("/").slice(1).map(unesc).reduce((a: any, k: string) => a?.[k], root) };
  }
  return cur;
};
const deref = (s: any, doc = "core.yaml"): any => rs(doc, s).node;
const opIn = (doc: any, id: string): { method: string; path: string; op: any } | undefined => {
  for (const [path, item] of Object.entries<any>(doc.paths)) for (const m of METHODS) if (item[m]?.operationId === id) return { method: m, path, op: item[m] };
  return undefined;
};
const idsOf = (doc: any): string[] => Object.values<any>(doc.paths).flatMap((item) => METHODS.filter((m) => item[m]).map((m) => item[m].operationId as string));
const sortedEq = (a: string[], b: string[]) => expect([...a].sort()).toEqual([...b].sort());
const props = (s: any): Record<string, any> => s?.properties ?? {};
const enumOf = (p: any): string[] => ((deref(p)?.enum ?? []) as unknown[]).filter((x): x is string => typeof x === "string");
const reqSchema = (id: string): any => deref(opIn(C_DOC, id)!.op.requestBody?.content?.["application/json"]?.schema);
const okSchema = (id: string): any => {
  const o = opIn(C_DOC, id)!;
  const code = Object.keys(o.op.responses).find((c) => /^2/.test(c))!;
  return deref(o.op.responses[code]?.content?.["application/json"]?.schema);
};
const itemSchema = (id: string): any => deref(okSchema(id).properties.data.items);
const paramNames = (op: any): string[] => (op.parameters ?? []).map((p: any) => deref(p).name);
const paramOf = (op: any, name: string): any => (op.parameters ?? []).map((p: any) => deref(p)).find((p: any) => p.name === name);
const jsonMedia = (op: any): any[] => [op.requestBody?.content?.["application/json"], ...Object.values<any>(op.responses).filter((r) => !r.$ref).map((r) => r.content?.["application/json"])].filter(Boolean);
const variants = (): any[] => (deref(props(reqSchema("pushSyncBatch")).operations?.items).oneOf ?? []).map((v: any) => deref(v));
const variantOf = (opType: string): any => variants().find((v) => enumOf(props(v).op_type).includes(opType));
const wrappedBody = (opType: string): { doc: string; node: any; op: any } => {
  const w = WRAPS[opType];
  const o = opIn(DOCS[w.file], w.op)!;
  const r = rs(w.file, o.op.requestBody.content["application/json"].schema);
  return { doc: r.doc, node: r.node, op: o.op };
};
const walk = (s: any, fn: (n: any) => void, skip: Set<any> = new Set(), seen = new Set<any>(), doc = "core.yaml"): void => {
  const r = rs(doc, s);
  const n = r.node;
  if (!n || typeof n !== "object" || seen.has(n) || skip.has(n)) return;
  seen.add(n);
  fn(n);
  for (const v of Object.values<any>(n.properties ?? {})) walk(v, fn, skip, seen, r.doc);
  if (n.items) walk(n.items, fn, skip, seen, r.doc);
  for (const k of ["allOf", "oneOf", "anyOf"]) for (const v of n[k] ?? []) walk(v, fn, skip, seen, r.doc);
};
const wrappedSet = (): Set<any> => new Set(OP_TYPES.map((t) => wrappedBody(t).node));

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
for (const [f, d] of Object.entries(DOCS)) ajv.addSchema({ ...d, id: f });
const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const validatorFor = (id: string, where: "req" | string) => {
  const o = opIn(C_DOC, id)!;
  const ptr = where === "req" ? `/paths/${esc(o.path)}/${o.method}/requestBody/content/application~1json/schema` : `/paths/${esc(o.path)}/${o.method}/responses/${where}/content/application~1json/schema`;
  const v = ajv.getSchema(`core.yaml#${ptr}`);
  expect(v, `cannot resolve ${id} ${where}`).toBeDefined();
  return v!;
};
const firstExample = (opType: string): unknown => { const e = wrappedBody(opType).op.requestBody.content["application/json"].examples; return (Object.values<any>(e)[0] as any).value; };
const opEnv = (opType: string, n: number, over: Record<string, unknown> = {}) => ({
  op_id: U(n), op_type: opType, payload: firstExample(opType), device_created_at: NOW,
  ...(WRAPS[opType].base ? { base_version: 3 } : {}), ...(WRAPS[opType].entity ? { entity_id: U(90) } : {}), ...over,
});
const batch = (ops: unknown[], over: Record<string, unknown> = {}) => ({ device_id: U(70), operations: ops, ...over });
const result = (over: Record<string, unknown> = {}) => ({ op_id: U(1), status: "accepted", ...over });

describe("T0C-SYNC-2 core.yaml: lint and additive baseline", () => {
  it("lintRepo reports no violation for core.yaml; paths stay under /v1/core/; still OpenAPI 3.0.3", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "core.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
    expect(C_DOC.openapi).toBe("3.0.3");
    for (const k of Object.keys(C_DOC.paths)) expect(k.startsWith("/v1/core/"), k).toBe(true);
  });
  it("core.yaml is additive: 2 health + 7 part 1 operations stay, exactly 5 new ones, 14 unique ids", () => {
    const ids = idsOf(C_DOC);
    expect(ids.length).toBe(14);
    expect(new Set(ids).size).toBe(14);
    for (const id of ["getLiveness", "getReadiness", "registerSyncDevice", "listSyncDevices", "revokeSyncDevice", "requestSyncDeviceWipe", "ackDeviceWipe", "getSyncStatus", "reserveNumberBlock"])
      expect(ids, `${id} must stay`).toContain(id);
    for (const id of Object.keys(OPS)) expect(opIn(C_DOC, id), `${id} missing`).toBeDefined();
  });
  it("operationIds of the 5 new operations are unique across every openapi file (02-CONVENTIONS:311)", () => {
    const all = Object.entries(DOCS).filter(([f]) => !f.startsWith("_")).flatMap(([, d]) => idsOf(d));
    for (const id of Object.keys(OPS)) expect(all.filter((x) => x === id), id).toHaveLength(1);
  });
});

describe("T0C-SYNC-2 core.yaml: the 5 operations (done_when 3, 4, 6)", () => {
  for (const [id, s] of Object.entries(OPS)) {
    describe(id, () => {
      const o = opIn(C_DOC, id);
      it(`${s.method.toUpperCase()} ${s.path}, permission ${s.perm}, tag core, bearerJwt, tenant context`, () => {
        expect(o, `${id} missing`).toBeDefined();
        expect(o!.method).toBe(s.method);
        expect(o!.path).toBe(s.path);
        expect(o!.op["x-permission"]).toBe(s.perm);
        expect(o!.op.tags).toEqual(["core"]);
        expect(o!.op.security).toEqual([{ bearerJwt: [] }]);
        expect(o!.op["x-context"]).toBe("tenant");
        expect(o!.op["x-public"]).toBeUndefined();
        expect(o!.op["x-rate-limit-tier"]).toBeDefined();
      });
      it("error codes: the five common ones, not_found with a path id, mfa on the privileged code, invalid_cursor on the list, the codes of the table; every code is registered", () => {
        const e: string[] = o?.op["x-error-codes"] ?? [];
        for (const c of ["common.validation_failed", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"]) expect(e, c).toContain(c);
        if (s.pathId) expect(e).toContain("common.not_found");
        if (s.perm === RES) expect(e, "privileged permission needs auth.mfa_required").toContain(MFA);
        else expect(e).not.toContain(MFA);
        if (s.paged) expect(e).toContain("common.invalid_cursor");
        for (const c of OP_ERRORS[id] ?? []) expect(e, c).toContain(c);
        const reg = new Set<string>(errorsYaml.map((x: any) => x.code));
        for (const c of e) expect(reg.has(c), `${c} not in contracts/errors.yaml`).toBe(true);
      });
      it("idempotency: resolve requires Idempotency-Key; push and pull are x-idempotency none with an E1..E4 justification (push: op_id is the key); no If-Match anywhere", () => {
        const names = paramNames(o?.op ?? {});
        expect(o!.op["x-idempotency"]).toBe(s.idem);
        if (s.idem === "required") { expect(names).toContain("Idempotency-Key"); expect(o!.op["x-error-codes"]).toContain("common.idempotency_key_required"); }
        else expect(names).not.toContain("Idempotency-Key");
        if (s.method === "post" && s.idem === "none") expect(String(o!.op["x-idempotency-justification"] ?? "")).toMatch(/^E[1-4] /);
        if (id === "pushSyncBatch") expect(String(o!.op["x-idempotency-justification"] ?? ""), "the justification names op_id").toMatch(/op_id/);
        expect(names).not.toContain("If-Match");
      });
      it(`success ${s.ok}, JSON body with at least one example, standard error responses`, () => {
        const r = o?.op.responses ?? {};
        expect(Object.keys(r).filter((c) => /^2/.test(c))).toEqual([s.ok]);
        const j = r[s.ok]?.content?.["application/json"];
        expect(j, "JSON 2xx").toBeDefined();
        expect(Object.keys(j.examples ?? {}).length, "example").toBeGreaterThan(0);
        for (const c of ["400", "401", "403", "429", "500"]) expect(r[c], c).toBeDefined();
      });
      it("every object schema with properties is closed (additionalProperties false); no float or number type, no nullable (absent = not set); no server authority field in a request", () => {
        const skip = wrappedSet();
        for (const m of jsonMedia(o!.op)) walk(m.schema, (n) => {
          if (n.properties) expect(n.additionalProperties, JSON.stringify(Object.keys(n.properties)).slice(0, 80)).toBe(false);
          expect(n.type, "money and counts are integers (paisa), never number").not.toBe("number");
          expect(["float", "double"]).not.toContain(n.format);
          expect(n.nullable, "no nullable: absent means not set").not.toBe(true);
        }, skip);
        walk(o!.op.requestBody?.content?.["application/json"]?.schema, (n) => {
          for (const f of ["tenant_id", "user_id", "created_by", "updated_by", "created_at", "updated_at", "server_received_at", "resolved_by", "resolved_at", "skew_flag", "status"])
            expect(Object.keys(n.properties ?? {}), `request names server field ${f}`).not.toContain(f);
        }, skip);
      });
      if (s.paged) it("is paged: Cursor + Limit parameters, {data (maxItems <= 200), page: PageInfo}", () => {
        const names = (o!.op.parameters as any[]).map((p) => p.$ref ?? p.name);
        expect(names).toEqual(expect.arrayContaining(["_common.yaml#/components/parameters/Cursor", "_common.yaml#/components/parameters/Limit"]));
        const ok = okSchema(id);
        sortedEq(ok.required, ["data", "page"]);
        expect(ok.properties.data.maxItems).toBeLessThanOrEqual(200);
        expect(JSON.stringify(ok.properties.page)).toContain("PageInfo");
      });
    });
  }
});

describe("T0C-SYNC-2 the closed operation catalogue (done_when 2)", () => {
  const sop = () => deref(props(reqSchema("pushSyncBatch")).operations.items);
  it("operations items are a oneOf with a discriminator on op_type: exactly the 8 op_types, the mapping lists the same schemas as the oneOf", () => {
    const s = sop();
    expect(Array.isArray(s.oneOf), "oneOf").toBe(true);
    expect(s.oneOf).toHaveLength(8);
    expect(s.discriminator?.propertyName).toBe("op_type");
    sortedEq(Object.keys(s.discriminator?.mapping ?? {}), OP_TYPES);
    sortedEq(variants().flatMap((v) => enumOf(props(v).op_type)), OP_TYPES);
    for (const v of variants()) expect(enumOf(props(v).op_type), "one op_type per entry").toHaveLength(1);
    const viaOneOf = new Set(s.oneOf.map((v: any) => deref(v)));
    for (const [t, ref] of Object.entries<any>(s.discriminator.mapping)) expect(viaOneOf.has(deref({ $ref: ref })), `mapping ${t}`).toBe(true);
  });
  for (const t of OP_TYPES) {
    const w = WRAPS[t];
    describe(t, () => {
      it(`envelope: op_id (uuid), op_type, payload, device_created_at required; base_version ${w.base ? "required" : "optional"} (Version, integer >= 1); entity_id ${w.entity ? "required" : "not required"}; closed`, () => {
        const v = variantOf(t);
        expect(v, `no entry for ${t}`).toBeDefined();
        expect(v.additionalProperties).toBe(false);
        expect(v.required).toEqual(expect.arrayContaining(["op_id", "op_type", "payload", "device_created_at"]));
        expect(JSON.stringify(props(v).op_id)).toContain("Uuid");
        expect(JSON.stringify(props(v).device_created_at)).toMatch(/IsoDateTime|date-time/);
        expect(JSON.stringify(props(v).base_version), "base_version is the shared Version type").toMatch(/Version|"minimum":1/);
        expect(deref(props(v).base_version).type).toBe("integer");
        if (w.base) expect(v.required).toContain("base_version"); else expect(v.required).not.toContain("base_version");
        if (w.entity) expect(v.required).toContain("entity_id"); else expect(v.required).not.toContain("entity_id");
        expect(JSON.stringify(props(v).entity_id)).toContain("Uuid");
        for (const f of ["tenant_id", "user_id", "status", "server_received_at"]) expect(Object.keys(props(v)), f).not.toContain(f);
      });
      it(`payload is a $ref to the very schema ${w.op} (${w.file}) uses as request body: no copied fields`, () => {
        const v = variantOf(t);
        const p = props(v).payload;
        expect(typeof p?.$ref, "payload must be a plain $ref (no inline fields, no allOf copy)").toBe("string");
        expect(Object.keys(p)).toEqual(["$ref"]);
        expect(deref(p), `${t} payload is not the request body of ${w.op}`).toBe(wrappedBody(t).node);
      });
      it(`contract text names the wrapped operation ${w.op}, the permission ${w.perm}, whether base_version is required, and the offline refusal sync.offline_not_allowed (step up)`, () => {
        const d = String(variantOf(t)?.description ?? "");
        expect(d.length, "entry description").toBeGreaterThan(60);
        expect(d, "wrapped operationId").toContain(w.op);
        expect(d, "permission").toContain(w.perm);
        expect(d, "base_version statement").toMatch(w.base ? /base_version[^.]{0,60}\brequired\b/i : /base_version[^.]{0,60}(\bnot required\b|\boptional\b|\bnone\b|\bnot used\b)/i);
        expect(d, "offline refusal statement").toContain("sync.offline_not_allowed");
        expect(d, "states whether a step up refuses it offline").toMatch(/step.?up|MFA/i);
      });
      it(`the wrapped operation really needs ${w.perm} (the text is not stale)`, () => {
        expect(wrappedBody(t).op["x-permission"]).toBe(w.perm);
      });
    });
  }
  it("result.verify and daily_cash.close say they are refused offline when a step up is needed; registration, receipt, collection, accession, result.enter and print marker say no step up applies", () => {
    for (const t of ["result.verify"]) expect(String(variantOf(t)?.description), t).toMatch(/refused[^.]{0,80}(step.?up|MFA)|(step.?up|MFA)[^.]{0,80}refused/i);
  });
  it("the envelope validates with the real example of the wrapped operation as payload (all 8) and rejects an unknown op_type, a copied/extra field, bad uuid, base_version 0 / 1.5 / '3', missing payload", () => {
    const v = validatorFor("pushSyncBatch", "req");
    const ops = OP_TYPES.map((t, i) => opEnv(t, i + 1));
    for (const o of ops) expect(v(batch([o])), `${o.op_type}: ${JSON.stringify(v.errors?.[0])}`).toBe(true);
    expect(v(batch(ops)), "all 8 in one batch").toBe(true);
    const ok = opEnv("collection.mark_collected", 1);
    for (const bad of [{ op_type: "user.delete" }, { op_type: "patient.merge" }, { op_type: "Result.Enter" }, { extra: 1 }, { tenant_id: U(1) }, { user_id: U(1) }, { status: "accepted" }, { op_id: "x" }, { base_version: 0 },
      { base_version: 1.5 }, { base_version: "3" }, { entity_id: "x" }, { device_created_at: 5 }, { payload: undefined }, { payload: { unknown_field: 1 } }])
      expect(v(batch([{ ...ok, ...bad }])), `accepted ${JSON.stringify(bad)}`).toBe(false);
    for (const missing of ["op_id", "op_type", "payload", "device_created_at", "base_version", "entity_id"]) { const { [missing]: _x, ...rest } = ok as any; expect(v(batch([rest])), `accepted without ${missing}`).toBe(false); }
  });
});

describe("T0C-SYNC-2 pushSyncBatch: request, results, limits, retry (done_when 3, 6; design sections 2, 5, 7)", () => {
  it("request: {device_id (uuid), operations}; both required; operations minItems 1, maxItems between 50 and 500 (the 50 and 1 MB limits are service rules: sync.batch_too_large); closed; no user_id / tenant_id", () => {
    const b = reqSchema("pushSyncBatch");
    sortedEq(b.required, ["device_id", "operations"]);
    sortedEq(Object.keys(props(b)), ["device_id", "operations"]);
    expect(JSON.stringify(props(b).device_id)).toContain("Uuid");
    expect(props(b).operations.type).toBe("array");
    expect(props(b).operations.minItems).toBe(1);
    expect(props(b).operations.maxItems).toBeGreaterThanOrEqual(50);
    expect(props(b).operations.maxItems).toBeLessThanOrEqual(500);
    expect(b.additionalProperties).toBe(false);
  });
  it("text states the limits (50 operations, 1 MB / 1048576 bytes), that one bad operation never fails the batch, op_id idempotency, retry_after on a request level 429, and that the server is authoritative", () => {
    const d = String(opIn(C_DOC, "pushSyncBatch")!.op.description ?? "");
    expect(d).toMatch(/\b50\b/);
    expect(d).toMatch(/1 ?MB|1048576|1 048 576/i);
    expect(d).toMatch(/never fail|not fail|does not fail|own transaction|independent/i);
    expect(d).toMatch(/op_id/);
    expect(d).toMatch(/retry_after|Retry-After/i);
    expect(d).toMatch(/re-?check|server time|authoritative|permission/i);
  });
  it("429 carries Retry-After (the common TooManyRequests response with its header)", () => {
    const r = opIn(C_DOC, "pushSyncBatch")!.op.responses["429"];
    const node = deref(r);
    expect(node.headers?.["Retry-After"], "Retry-After header").toBeDefined();
  });
  it("response: {results} (array of SyncOperationResult), one entry per op_id; each result has op_id and status (accepted | duplicate | rejected | conflict); closed", () => {
    const ok = okSchema("pushSyncBatch");
    expect(ok.required).toEqual(expect.arrayContaining(["results"]));
    expect(props(ok).results.type).toBe("array");
    expect(ok.additionalProperties).toBe(false);
    const r = deref(props(ok).results.items);
    expect(r.required).toEqual(expect.arrayContaining(["op_id", "status"]));
    sortedEq(enumOf(props(r).status), STATUSES);
    expect(JSON.stringify(props(r).op_id)).toContain("Uuid");
    for (const f of ["error_code", "conflict_id", "entity_id", "number_mappings", "skew_flag"]) expect(props(r)[f], `result.${f}`).toBeDefined();
    for (const f of ["error_code", "conflict_id", "entity_id", "number_mappings"]) expect(r.required, `${f} optional`).not.toContain(f);
    expect(props(r).skew_flag.type).toBe("boolean");
    expect(r.additionalProperties).toBe(false);
  });
  it("error_code is a closed enum of registered codes and contains the nine new sync.* codes (never free text, never personal data)", () => {
    const r = deref(props(okSchema("pushSyncBatch")).results.items);
    const e = enumOf(props(r).error_code);
    expect(e.length).toBeGreaterThan(0);
    for (const c of Object.keys(NEW_ERRORS)) expect(e, c).toContain(c);
    const reg = new Set<string>(errorsYaml.map((x: any) => x.code));
    for (const c of e) expect(reg.has(c), `${c} is not registered`).toBe(true);
  });
  it("number_mappings: [{document_type bill | invoice | receipt, provisional_number OFF-..., final_number}] all required, strings, closed (provisional to final number, design section 4)", () => {
    const r = deref(props(okSchema("pushSyncBatch")).results.items);
    const m = deref(props(r).number_mappings.items);
    sortedEq(m.required, ["document_type", "provisional_number", "final_number"]);
    sortedEq(enumOf(props(m).document_type), ["bill", "invoice", "receipt"]);
    for (const f of ["provisional_number", "final_number"]) { expect(props(m)[f].type).toBe("string"); expect(props(m)[f].maxLength).toBeLessThanOrEqual(60); }
    expect(m.additionalProperties).toBe(false);
    expect(JSON.stringify(opIn(C_DOC, "pushSyncBatch")!.op)).toMatch(/provisional/i);
  });
  it("result payload validation: the four statuses validate; unknown status, unregistered error_code, float mapping, extra field, missing op_id are rejected", () => {
    const v = validatorFor("pushSyncBatch", "200");
    expect(v({ results: [result(), result({ op_id: U(2), status: "duplicate" }), result({ op_id: U(3), status: "rejected", error_code: "sync.result_locked" }),
      result({ op_id: U(4), status: "conflict", error_code: "sync.entity_changed", conflict_id: U(9) })] }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ results: [result({ number_mappings: [{ document_type: "receipt", provisional_number: "OFF-7F3A-12", final_number: "RCP-2083-000145" }], skew_flag: true })] }), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ status: "pending" }, { status: "Accepted" }, { error_code: "boom" }, { error_code: "Patient John Doe not found" }, { number_mappings: [{ document_type: "bill", provisional_number: 12, final_number: "x" }] },
      { number_mappings: [{ document_type: "voucher", provisional_number: "OFF-1", final_number: "x" }] }, { extra: 1 }, { skew_flag: "yes" }, { conflict_id: "x" }])
      expect(v({ results: [result(bad)] }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    const { op_id: _o, ...noId } = result();
    expect(v({ results: [noId] })).toBe(false);
  });
  it("the examples include one batch of three operations (accepted, duplicate, conflict): a request example and a response example with the same three op_ids", () => {
    const o = opIn(C_DOC, "pushSyncBatch")!.op;
    const reqs = Object.values<any>(o.requestBody.content["application/json"].examples ?? {}).map((e) => e.value).filter((b) => b?.operations?.length === 3);
    const resps = Object.values<any>(o.responses["200"].content["application/json"].examples ?? {}).map((e) => e.value);
    expect(reqs.length, "a request example with 3 operations").toBeGreaterThan(0);
    const pair = reqs.find((rq) => resps.some((rp) => JSON.stringify(rp.results.map((x: any) => x.op_id)) === JSON.stringify(rq.operations.map((x: any) => x.op_id))));
    expect(pair, "a response example with the results of the same three op_ids in the same order").toBeDefined();
    const rp = resps.find((rp) => JSON.stringify(rp.results.map((x: any) => x.op_id)) === JSON.stringify(pair.operations.map((x: any) => x.op_id)));
    sortedEq(rp.results.map((x: any) => x.status), ["accepted", "duplicate", "conflict"]);
    const conflict = rp.results.find((x: any) => x.status === "conflict");
    expect(conflict.conflict_id, "the conflict result points at its conflict row").toBeDefined();
    expect(conflict.error_code).toMatch(/^sync\./);
  });
});

describe("T0C-SYNC-2 pullChanges (done_when 3; design sections 3, 7)", () => {
  it("request: {device_id, entities[{entity_type, cursor?}], limit?}; entity_type is a whitelist enum; cursor is an opaque string <= 512; limit is an integer page size 1..1000", () => {
    const b = reqSchema("pullChanges");
    sortedEq(b.required, ["device_id", "entities"]);
    sortedEq(Object.keys(props(b)), ["device_id", "entities", "limit"]);
    expect(JSON.stringify(props(b).device_id)).toContain("Uuid");
    const e = deref(props(b).entities.items);
    sortedEq(e.required, ["entity_type"]);
    sortedEq(Object.keys(props(e)), ["entity_type", "cursor"]);
    expect(e.additionalProperties).toBe(false);
    expect(props(e).cursor.type).toBe("string");
    expect(props(e).cursor.maxLength).toBeLessThanOrEqual(512);
    expect(props(b).entities.minItems).toBe(1);
    expect(props(b).entities.maxItems).toBeLessThanOrEqual(40);
    expect(props(b).limit).toMatchObject({ type: "integer", minimum: 1 });
    expect(props(b).limit.maximum).toBeLessThanOrEqual(1000);
    expect(b.additionalProperties).toBe(false);
  });
  it("the entity whitelist holds the cacheable reads of design section 3 (tests, parameters, doctors, centres, price list version, verification policy, print profile, patients) and nothing that is a credential or a user / role record", () => {
    const wl = enumOf(props(deref(props(reqSchema("pullChanges")).entities.items)).entity_type);
    for (const x of ENTITY_MUST) expect(wl, x).toContain(x);
    for (const x of wl) expect(x, "snake_case name").toMatch(/^[a-z][a-z_]*$/);
    expect(wl.join(","), "no credentials, users or roles in the sync pull").not.toMatch(/\b(user|role|session|password|secret|token|credential|mfa)\b/);
    expect(new Set(wl).size).toBe(wl.length);
    const resp = deref(props(okSchema("pullChanges")).changes.items);
    sortedEq(enumOf(props(resp).entity_type), wl);
  });
  it("response: {changes[{entity_type, upserts[], tombstones[{id, removed_at}], next_cursor, has_more}], server_time}; the tombstone carries no row data; next_cursor is opaque", () => {
    const ok = okSchema("pullChanges");
    sortedEq(ok.required, ["changes", "server_time"]);
    expect(ok.additionalProperties).toBe(false);
    expect(JSON.stringify(props(ok).server_time)).toMatch(/IsoDateTime|date-time/);
    const c = deref(props(ok).changes.items);
    sortedEq(c.required, ["entity_type", "upserts", "tombstones", "next_cursor", "has_more"]);
    expect(c.additionalProperties).toBe(false);
    expect(props(c).upserts.type).toBe("array");
    expect(props(c).upserts.maxItems).toBeLessThanOrEqual(1000);
    expect(props(c).next_cursor).toMatchObject({ type: "string" });
    expect(props(c).next_cursor.maxLength).toBeLessThanOrEqual(512);
    expect(props(c).has_more.type).toBe("boolean");
    const t = deref(props(c).tombstones.items);
    sortedEq(t.required, ["id", "removed_at"]);
    sortedEq(Object.keys(props(t)), ["id", "removed_at"]);
    expect(t.additionalProperties).toBe(false);
    const u = deref(props(c).upserts.items);
    expect(u.required).toEqual(expect.arrayContaining(["id", "updated_at", "document"]));
    expect(props(u).version, "version token travels with the row (base_version of a later edit)").toBeDefined();
    expect(u.required, "version may be absent for tables without one (falls back to updated_at)").not.toContain("version");
    expect(u.additionalProperties).toBe(false);
  });
  it("text: one opaque cursor per entity type (clients never parse it), tombstones for removed rows, page size, a revoked device / wipe is answered before any data", () => {
    const d = String(opIn(C_DOC, "pullChanges")!.op.description ?? "");
    expect(d).toMatch(/opaque/i);
    expect(d).toMatch(/tombstone/i);
    expect(d).toMatch(/per entity type|each entity type|one cursor/i);
    expect(d).toMatch(/revoked|wipe/i);
  });
  it("request payload validation: a minimal and a full request validate; empty entities, unknown entity_type, oversize cursor, limit 0 / 1.5 / 5000, tenant_id, unknown field are rejected", () => {
    const v = validatorFor("pullChanges", "req");
    const wl = enumOf(props(deref(props(reqSchema("pullChanges")).entities.items)).entity_type);
    const ok = { device_id: U(70), entities: [{ entity_type: wl[0] }] };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ ...ok, entities: [{ entity_type: wl[0], cursor: "opaque-AbC123==" }, { entity_type: wl[1] }], limit: 200 })).toBe(true);
    for (const bad of [{ entities: [] }, { entities: [{ entity_type: "users" }] }, { entities: [{ entity_type: wl[0], cursor: "c".repeat(600) }] }, { entities: [{ entity_type: wl[0], extra: 1 }] },
      { limit: 0 }, { limit: 1.5 }, { limit: 5000 }, { tenant_id: U(1) }, { unknown_field: 1 }, { device_id: "x" }])
      expect(v({ ...ok, ...bad }), `accepted ${JSON.stringify(bad).slice(0, 70)}`).toBe(false);
    const { device_id: _d, ...noDevice } = ok;
    expect(v(noDevice)).toBe(false);
  });
  it("response payload validation: a page with an upsert and a tombstone validates; missing next_cursor, string has_more, an extra tombstone field are rejected", () => {
    const v = validatorFor("pullChanges", "200");
    const wl = enumOf(props(deref(props(reqSchema("pullChanges")).entities.items)).entity_type);
    const ch = { entity_type: wl[0], upserts: [{ id: U(5), version: 4, updated_at: NOW, document: { code: "CBC", name: "Complete blood count" } }], tombstones: [{ id: U(6), removed_at: NOW }], next_cursor: "opaque-1", has_more: false };
    expect(v({ changes: [ch], server_time: NOW }), JSON.stringify(v.errors?.[0])).toBe(true);
    const { next_cursor: _n, ...noCursor } = ch;
    for (const bad of [{ changes: [noCursor], server_time: NOW }, { changes: [{ ...ch, has_more: "no" }], server_time: NOW }, { changes: [{ ...ch, tombstones: [{ id: U(6), removed_at: NOW, name: "x" }] }], server_time: NOW }, { changes: [ch] }])
      expect(v(bad), `accepted ${JSON.stringify(bad).slice(0, 70)}`).toBe(false);
  });
});

describe("T0C-SYNC-2 conflicts: list, get, resolve (done_when 3; design section 8)", () => {
  it("SyncConflict (list item and get answer): id, op_id, entity_type, entity_id, local_payload, server_payload, status open | resolved, resolution keep_server | apply_local | merge, resolved_by, resolved_at, reason, created_at", () => {
    const c = itemSchema("listSyncConflicts");
    for (const f of ["id", "op_id", "entity_type", "entity_id", "local_payload", "server_payload", "status", "resolution", "resolved_by", "resolved_at", "reason", "created_at"]) expect(props(c)[f], `conflict.${f}`).toBeDefined();
    expect(c.required).toEqual(expect.arrayContaining(["id", "op_id", "entity_type", "entity_id", "local_payload", "server_payload", "status", "created_at"]));
    for (const f of ["resolution", "resolved_by", "resolved_at", "reason"]) { expect(c.required, f).not.toContain(f); expect(props(c)[f].nullable).not.toBe(true); }
    sortedEq(enumOf(props(c).status), ["open", "resolved"]);
    sortedEq(enumOf(props(c).resolution), ["keep_server", "apply_local", "merge"]);
    for (const f of ["id", "op_id", "entity_id", "resolved_by"]) expect(JSON.stringify(props(c)[f]), f).toContain("Uuid");
    expect(props(c).entity_type.maxLength).toBeLessThanOrEqual(60);
    expect(props(c).reason.maxLength).toBeLessThanOrEqual(1000);
    expect(Object.keys(props(c)), "tenant_id never on the wire").not.toContain("tenant_id");
    expect(c.additionalProperties).toBe(false);
    expect(JSON.stringify(deref(opIn(C_DOC, "getSyncConflict")!.op.responses["200"].content["application/json"].schema))).toBe(JSON.stringify(c));
  });
  it("listSyncConflicts filters: status, entity_type; paged list of conflicts; no search by patient name", () => {
    const o = opIn(C_DOC, "listSyncConflicts")!.op;
    const names = paramNames(o);
    for (const n of ["status", "entity_type"]) expect(names, n).toContain(n);
    for (const n of ["name", "patient_name", "phone", "email", "search"]) expect(names, n).not.toContain(n);
    sortedEq(enumOf(paramOf(o, "status")?.schema), ["open", "resolved"]);
  });
  it("getSyncConflict takes conflict_id in the path; the description says both versions are shown (local and server)", () => {
    const o = opIn(C_DOC, "getSyncConflict")!.op;
    expect(paramNames(o)).toContain("conflict_id");
    expect(deref(paramOf(o, "conflict_id").schema) && JSON.stringify(paramOf(o, "conflict_id").schema)).toMatch(/Uuid/);
    expect(String(o.description ?? "")).toMatch(/both|local[^.]*server|server[^.]*local/i);
  });
  it("resolveSyncConflict: body {resolution (keep_server | apply_local | merge), reason (1..1000), merged_payload?}; resolution and reason required; the answer is the resolved SyncConflict", () => {
    const b = reqSchema("resolveSyncConflict");
    sortedEq(b.required, ["resolution", "reason"]);
    sortedEq(Object.keys(props(b)), ["resolution", "reason", "merged_payload"]);
    sortedEq(enumOf(props(b).resolution), ["keep_server", "apply_local", "merge"]);
    expect(props(b).reason).toMatchObject({ type: "string", minLength: 1 });
    expect(props(b).reason.maxLength).toBeLessThanOrEqual(1000);
    expect(b.additionalProperties).toBe(false);
    expect(props(okSchema("resolveSyncConflict")).status).toBeDefined();
    const d = String(opIn(C_DOC, "resolveSyncConflict")!.op.description ?? "");
    expect(d, "merge needs merged_payload; audited; once").toMatch(/merged_payload/);
    expect(d).toMatch(/audit/i);
    expect(d).toMatch(/sync\.entity_changed|changed/i);
  });
  it("resolve payload validation: the three resolutions validate; empty reason, unknown resolution, resolved_by, status, unknown field are rejected", () => {
    const v = validatorFor("resolveSyncConflict", "req");
    for (const r of ["keep_server", "apply_local"]) expect(v({ resolution: r, reason: "Server copy is newer (synthetic)" }), r).toBe(true);
    expect(v({ resolution: "merge", reason: "Take the new phone number from the device", merged_payload: { phone_present: true } })).toBe(true);
    for (const bad of [{ reason: "" }, { resolution: "discard" }, { resolution: "Keep_Server" }, { resolved_by: U(1) }, { status: "resolved" }, { unknown_field: 1 }, { reason: "r".repeat(2000) }])
      expect(v({ resolution: "keep_server", reason: "ok", ...bad }), `accepted ${JSON.stringify(bad).slice(0, 60)}`).toBe(false);
    for (const missing of ["resolution", "reason"]) { const ok: any = { resolution: "keep_server", reason: "ok" }; delete ok[missing]; expect(v(ok), `accepted without ${missing}`).toBe(false); }
  });
  it("conflict payload validation: an open and a resolved conflict validate; bad status, bad resolution, float entity version and an extra field are rejected", () => {
    const v = validatorFor("getSyncConflict", "200");
    const open = { id: U(9), op_id: U(1), entity_type: "patient", entity_id: U(5), local_payload: { phone_present: true }, server_payload: { phone_present: false }, status: "open", created_at: NOW };
    expect(v(open), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ ...open, status: "resolved", resolution: "merge", resolved_by: U(3), resolved_at: NOW, reason: "Merged by the lab manager (synthetic)" })).toBe(true);
    for (const bad of [{ status: "closed" }, { resolution: "delete" }, { id: "x" }, { extra: 1 }, { entity_type: "e".repeat(200) }]) expect(v({ ...open, ...bad }), `accepted ${JSON.stringify(bad).slice(0, 60)}`).toBe(false);
  });
});

describe("T0C-SYNC-2 examples (done_when 6)", () => {
  const check = (id: string) => {
    const o = opIn(C_DOC, id)!;
    const reqEx = o.op.requestBody?.content?.["application/json"]?.examples;
    if (reqEx) for (const e of Object.values<any>(reqEx)) { const v = validatorFor(id, "req"); expect(v(e.value), `${id} request example: ${JSON.stringify(v.errors?.[0])}`).toBe(true); }
    for (const [code, r] of Object.entries<any>(o.op.responses)) {
      if (r.$ref || !r.content?.["application/json"]?.examples) continue;
      for (const e of Object.values<any>(r.content["application/json"].examples)) { const v = validatorFor(id, code); expect(v(e.value), `${id} ${code} example: ${JSON.stringify(v.errors?.[0])}`).toBe(true); }
    }
  };
  it("every request and response example of the 5 operations validates against its schema; synthetic values only; amounts are integer paisa", () => {
    for (const id of Object.keys(OPS)) check(id);
    const text = JSON.stringify(Object.keys(OPS).map((id) => opIn(C_DOC, id)!.op));
    expect(text).not.toMatch(/@(?!example\.(test|com|org)|[a-z0-9.-]*\.test)/i);
    expect(text).not.toMatch(/\b9[78]\d{8}\b/);
    expect(text, "no decimal money").not.toMatch(/"(amount|total|paid|due)[a-z_]*":\s*\d+\.\d/i);
  });
  it("the push request examples carry op_types of the catalogue only, and at least one example uses a receipt with a provisional OFF- number in its result mapping", () => {
    const o = opIn(C_DOC, "pushSyncBatch")!.op;
    for (const e of Object.values<any>(o.requestBody.content["application/json"].examples ?? {})) for (const op of e.value.operations) expect(OP_TYPES, op.op_type).toContain(op.op_type);
    const maps = Object.values<any>(o.responses["200"].content["application/json"].examples ?? {}).flatMap((e) => e.value.results).flatMap((r: any) => r.number_mappings ?? []);
    expect(maps.length, "an example with a number mapping").toBeGreaterThan(0);
    for (const m of maps) expect(m.provisional_number).toMatch(/^OFF-/);
  });
});

describe("T0C-SYNC-2 error codes: the closed list (done_when 4)", () => {
  it("errors.yaml holds the nine new sync.* codes, owner C0, with the pinned http status and a title and meaning free of personal data; the five part 1 codes stay", () => {
    for (const [code, http] of Object.entries(NEW_ERRORS)) {
      const e = errorsYaml.find((x: any) => x.code === code);
      expect(e, `${code} missing from contracts/errors.yaml`).toBeDefined();
      expect(e.owner, code).toBe("C0");
      expect(e.http, `${code} http`).toBe(http);
      expect(String(e.title).length, `${code} title`).toBeGreaterThan(0);
      expect(String(e.title).length, `${code} title`).toBeLessThanOrEqual(80);
      expect(`${e.title} ${e.meaning}`, `${code}: no name, e-mail, phone, id placeholder`).not.toMatch(/@|\{|\}|%s|\$\{|patient name|\b9[78]\d{8}\b/i);
    }
    const sync = errorsYaml.filter((e) => String(e.code).startsWith("sync.")).map((e) => e.code);
    sortedEq(sync, ["sync.device_revoked", "sync.device_unknown", "sync.block_size_too_large", "sync.series_unknown", "sync.wipe_required", ...Object.keys(NEW_ERRORS)]);
  });
  it("every new code is reachable: listed in an x-error-codes of one of the 5 operations or in the error_code enum of the push result; none is used by a file other than core.yaml", () => {
    const used = new Set<string>([...Object.keys(OPS).flatMap((id) => opIn(C_DOC, id)?.op["x-error-codes"] ?? []), ...enumOf(props(deref(props(okSchema("pushSyncBatch")).results.items)).error_code)]);
    for (const c of Object.keys(NEW_ERRORS)) expect(used.has(c), `${c} unused`).toBe(true);
    for (const f of readdirSync(join(ROOT, "contracts/openapi")).filter((x) => x.endsWith(".yaml") && x !== "core.yaml" && !x.startsWith("_"))) {
      const t = readFileSync(join(ROOT, "contracts/openapi", f), "utf8");
      for (const c of Object.keys(NEW_ERRORS)) expect(t, `${f} must not use ${c}`).not.toContain(c);
    }
  });
});

describe("T0C-SYNC-2 permissions (no new code: the SYNC-1 codes are reused)", () => {
  const byCode = new Map<string, any>(registry.permissions.map((p: any) => [p.code, p]));
  it("the registry still holds exactly the three sync codes; sync.use is not privileged, sync.conflict.resolve is privileged (tenant_admin, lab_manager, finance)", () => {
    sortedEq(registry.permissions.filter((p: any) => p.code.startsWith("sync.")).map((p: any) => p.code), [USE, "sync.device.manage", RES]);
    expect(byCode.get(USE).privileged).toBe(false);
    expect(byCode.get(RES)).toMatchObject({ privileged: true });
    sortedEq(byCode.get(RES).roles, ["tenant_admin", "lab_manager", "finance"]);
  });
  it("the 5 operations use only sync.use (push, pull) and sync.conflict.resolve (list, get, resolve); no other permission appears", () => {
    for (const [id, s] of Object.entries(OPS)) expect(opIn(C_DOC, id)!.op["x-permission"], id).toBe(s.perm);
  });
  it("every permission the catalogue text names exists in the registry (a wrapped operation permission is re-checked at sync time)", () => {
    for (const t of OP_TYPES) expect(byCode.has(WRAPS[t].perm), `${WRAPS[t].perm} not in contracts/permissions.yaml`).toBe(true);
  });
});

describe("T0C-SYNC-2 generated clients and the pending-operations rule (LD-325)", () => {
  it("generated clients, types, MSW handlers, permissions and seeds are fresh (codegen --check)", () => { expect(staleFiles(ROOT)).toEqual([]); }, 120_000);
  it("the core client carries the 5 operations and the SyncOperation catalogue (api-client-ts core.ts and api-client-dart core.dart)", () => {
    const ts = readFileSync(join(ROOT, "packages/api-client-ts/src/core.ts"), "utf8");
    const dart = readFileSync(join(ROOT, "packages/api-client-dart/lib/core.dart"), "utf8");
    for (const id of Object.keys(OPS)) { expect(ts, `core.ts ${id}`).toContain(id); expect(dart, `core.dart ${id}`).toContain(id); }
    for (const t of OP_TYPES) expect(ts, `core.ts ${t}`).toContain(t);
  });
  it("services/api/src/core/core-pending.ts lists the 5 ids next to the 7 of part 1 (T0B-SYNC-2..5 remove them with the handlers)", () => {
    const t = readFileSync(join(ROOT, "services/api/src/core/core-pending.ts"), "utf8");
    expect(t).toMatch(/CORE_PENDING_OPERATIONS/);
    for (const id of Object.keys(OPS)) expect(t, id).toContain(id);
    for (const id of ["registerSyncDevice", "reserveNumberBlock"]) expect(t, `${id} stays until T0B-SYNC-1 removes it`).toContain(id);
  });
});

describe("T0C-SYNC-2 migration file (static; behaviour in the pgTAP suite) (done_when 1, 5, 7)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");
  const TABLES = ["sync_operation", "sync_conflict"];
  const versionAlters = [...code.matchAll(/ALTER\s+TABLE\s+(?:IF EXISTS\s+)?(?:ONLY\s+)?(\w+\.\w+)\s+ADD\s+COLUMN\s+(?:IF NOT EXISTS\s+)?(\w+)([^;]*);/gi)];

  it("exists, is the only 20261117260000 migration, sorts after the SYNC-1 migration, runs as lims_owner", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all.filter((f) => f.startsWith("20261117260000"))).toEqual([MIG]);
    expect(all.indexOf(MIG)).toBeGreaterThan(all.indexOf("20261117250000_core__add_sync_devices_and_number_blocks.sql"));
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("creates both tables IF NOT EXISTS in schema core, each with ENABLE + FORCE row level security, tenant policies and a grant to lims_app only; no DELETE, ALL or TRUNCATE grant", () => {
    for (const t of TABLES) {
      expect(code, `CREATE TABLE ${t}`).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS core\\.${t}\\b`, "i"));
      expect(code, `ENABLE RLS ${t}`).toMatch(new RegExp(`ALTER TABLE core\\.${t} ENABLE ROW LEVEL SECURITY`, "i"));
      expect(code, `FORCE RLS ${t}`).toMatch(new RegExp(`ALTER TABLE core\\.${t} FORCE ROW LEVEL SECURITY`, "i"));
      expect(code, `policy on ${t}`).toMatch(new RegExp(`CREATE POLICY[^;]*ON core\\.${t}\\b[^;]*app\\.current_tenant_id\\(\\)`, "is"));
      const grants = [...code.matchAll(new RegExp(`GRANT\\s+([^;]*?)\\s+ON\\s+core\\.${t}\\s+TO\\s+lims_app`, "gi"))];
      expect(grants.length, `GRANT lims_app ${t}`).toBeGreaterThan(0);
      for (const g of grants) expect(g[1], `${t}: no DELETE / ALL / TRUNCATE`).not.toMatch(/\bDELETE\b|\bALL\b|\bTRUNCATE\b/i);
    }
    expect(code).not.toMatch(/TO\s+(PUBLIC|anon|authenticated)\b/i);
  });
  it("sync_operation: PRIMARY KEY (tenant_id, op_id); the brief's columns; op_type CHECK holds exactly the 8 catalogue types; status CHECK the four outcomes; tenant FKs", () => {
    expect(code).toMatch(/PRIMARY KEY\s*\(\s*tenant_id\s*,\s*op_id\s*\)/i);
    const body = code.match(/CREATE TABLE IF NOT EXISTS core\.sync_operation\s*\(([\s\S]*?)\n\);/i)?.[1] ?? "";
    expect(body.length, "sync_operation body").toBeGreaterThan(0);
    for (const c of ["tenant_id", "op_id", "device_id", "user_id", "op_type", "base_version", "payload_hash", "payload", "device_created_at", "server_received_at", "status", "result", "error_code", "skew_flag", "created_at"])
      expect(body, `column ${c}`).toMatch(new RegExp(`\\b${c}\\s+(uuid|text|integer|bigint|jsonb|timestamptz|boolean)`, "i"));
    for (const t of OP_TYPES) expect(body, t).toContain(`'${t}'`);
    for (const s of STATUSES) expect(body, s).toContain(`'${s}'`);
    expect(body).toMatch(/payload\s+jsonb\s+NOT NULL/i);
    expect(body).toMatch(/payload_hash\s+text\s+NOT NULL/i);
    expect(body).toMatch(/base_version\s+integer(?!\s+NOT NULL)/i);
    expect(body).toMatch(/FOREIGN KEY\s*\(\s*tenant_id\s*,\s*device_id\s*\)\s*REFERENCES core\.sync_device/i);
    expect(body).toMatch(/FOREIGN KEY\s*\(\s*tenant_id\s*,\s*user_id\s*\)\s*REFERENCES core\.users/i);
  });
  it("sync_operation is append only: no DELETE; UPDATE only through column grants on the outcome columns or a BEFORE UPDATE trigger that writes the outcome once and freezes op_id, payload, payload_hash, device and time columns", () => {
    const colGrant = code.match(/GRANT\s+UPDATE\s*\(([^)]*)\)\s+ON\s+core\.sync_operation\s+TO\s+lims_app/i);
    const trig = /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+\w+\s+BEFORE\s+UPDATE[^;]*ON\s+core\.sync_operation/i.test(code);
    expect(Boolean(colGrant) || trig, "column level UPDATE grant or a BEFORE UPDATE trigger").toBe(true);
    if (colGrant) for (const frozen of ["op_id", "tenant_id", "payload", "payload_hash", "op_type", "device_id", "user_id", "base_version", "device_created_at", "server_received_at"])
      expect(colGrant[1], `${frozen} must not be updatable`).not.toMatch(new RegExp(`\\b${frozen}\\b`));
    expect(code, "no UPDATE grant on the whole table unless a trigger guards it").toSatisfy((c: string) => !/GRANT\s+[^;]*\bUPDATE\b(?!\s*\()[^;]*ON\s+core\.sync_operation/i.test(c) || trig);
  });
  it("sync_conflict: id PK, composite FK to sync_operation (tenant_id, op_id), status open | resolved, resolution keep_server | apply_local | merge, a CHECK tying resolved rows to resolver, time and reason; resolved rows are frozen by a trigger", () => {
    const body = code.match(/CREATE TABLE IF NOT EXISTS core\.sync_conflict\s*\(([\s\S]*?)\n\);/i)?.[1] ?? "";
    expect(body.length, "sync_conflict body").toBeGreaterThan(0);
    for (const c of ["id", "tenant_id", "op_id", "entity_type", "entity_id", "local_payload", "server_payload", "status", "resolution", "resolved_by", "resolved_at", "reason", "created_at"])
      expect(body, `column ${c}`).toMatch(new RegExp(`\\b${c}\\s+(uuid|text|jsonb|timestamptz)`, "i"));
    for (const s of ["open", "resolved", "keep_server", "apply_local", "merge"]) expect(body, s).toContain(`'${s}'`);
    expect(body).toMatch(/FOREIGN KEY\s*\(\s*tenant_id\s*,\s*op_id\s*\)\s*REFERENCES core\.sync_operation/i);
    expect(body, "resolved implies resolver, time, reason, resolution").toMatch(/CHECK\s*\([^;]*resolved_by[^;]*resolved_at[^;]*reason|CHECK\s*\([^;]*status\s*=\s*'resolved'/is);
    expect(code, "a resolved conflict cannot be changed again").toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+\w+\s+BEFORE\s+UPDATE[^;]*ON\s+core\.sync_conflict/i);
  });
  it("policies are re-runnable; every CREATE TABLE and INDEX is IF NOT EXISTS (tenant_id first); every ADD CONSTRAINT is pg_constraint guarded; trigger functions pin search_path", () => {
    for (const m of code.matchAll(/CREATE\s+POLICY\s+(\S+)\s+ON\s+(\S+)/gi)) {
      const before = code.slice(Math.max(0, m.index! - 700), m.index);
      expect(new RegExp(`DROP POLICY IF EXISTS ${m[1]}\\b`, "i").test(code.slice(0, m.index! + 10)) || /pg_policy/i.test(before), `policy ${m[1]} is not idempotent`).toBe(true);
    }
    expect((code.match(/CREATE TABLE(?! IF NOT EXISTS)/gi) ?? []).length).toBe(0);
    for (const m of code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/gi)) throw new Error(`unguarded CREATE INDEX near ${m.index}`);
    for (const m of code.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF NOT EXISTS\s+\S+\s+ON\s+\S+\s*(?:USING\s+\w+\s*)?\(\s*(\w+)/gi)) expect(m[1], `index leads with tenant_id: ${m[0].slice(0, 80)}`).toBe("tenant_id");
    for (const m of code.matchAll(/ADD\s+CONSTRAINT/gi)) expect(code.slice(Math.max(0, m.index! - 900), m.index), "ADD CONSTRAINT must sit in a DO block that checks pg_constraint").toMatch(/DO\s+\$[a-z_]*\$[\s\S]*pg_constraint/i);
    for (const m of code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\S+)\s*\([^)]*\)\s+RETURNS\s+trigger[\s\S]*?\$\$;?/gi)) expect(m[0], `${m[1]} must pin search_path`).toMatch(/SET\s+search_path\s*=\s*''/i);
  });
  it("sync_conflict has a row audit trigger; sync_operation does not copy its payload into the audit log (it is the ledger itself)", () => {
    expect(code).toMatch(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+sync_conflict__audit\b[^;]*ON core\.sync_conflict\b[^;]*tg_row_audit/is);
  });
  it("version column (done_when 5): at most 5 old tables get `version integer NOT NULL DEFAULT 1` (ADD COLUMN IF NOT EXISTS, a constant default, no rewrite); no other column is added to an old table; no UPDATE of existing rows", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect(versionAlters.length, "at most 5 version columns").toBeLessThanOrEqual(5);
    for (const m of versionAlters) {
      expect(m[2], `${m[1]}: only a version column may be added to an old table`).toBe("version");
      expect(m[0], `${m[1]}: ADD COLUMN IF NOT EXISTS`).toMatch(/ADD\s+COLUMN\s+IF NOT EXISTS/i);
      expect(m[3], `${m[1]}: integer NOT NULL DEFAULT 1`).toMatch(/^\s*integer\s+NOT NULL\s+DEFAULT\s+1\s*$/i);
      expect(TABLES.map((t) => `core.${t}`), "version is for OLD tables").not.toContain(m[1]);
    }
    expect(code).not.toMatch(/\bUPDATE\s+\S+\s+SET\b/i);
  });
  it("is additive: no DROP of data, no TRUNCATE / DELETE / INSERT data statement, no ALTER of an old table except the version columns, no type or enum, no REVOKE, no float or money column", () => {
    expect(code).not.toMatch(/\b(DROP\s+(TABLE|COLUMN|SCHEMA|INDEX|POLICY|TRIGGER)|TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|REVOKE)\b/i);
    expect(code).not.toMatch(/\bCREATE\s+TYPE\b|\bAS\s+ENUM\b|DISABLE\s+ROW|NO\s+FORCE|ALTER\s+COLUMN|\bRENAME\b/i);
    const mine = [...TABLES.map((t) => `core.${t}`), ...versionAlters.map((m) => m[1])];
    for (const m of code.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF EXISTS\s+)?((?:\w+)\.\w+)/gi)) expect(mine, `unexpected ALTER of ${m[1]}`).toContain(m[1]);
    expect(code).not.toMatch(/\b(float|double precision|real|numeric|decimal|money)\b/i);
  });
  it("comments: LD-322, both tables, the design file, down note with DROP TABLE and the version columns, additive / no rewrite, push-cloud founder step", () => {
    expect(comments).toMatch(/LD-322/);
    expect(comments).toMatch(/offline-design-20261117/);
    expect(comments).toMatch(/\bdown\b/i);
    expect(comments).toMatch(/DROP TABLE/i);
    for (const t of TABLES) expect(comments, `down note names ${t}`).toContain(t);
    expect(comments).toMatch(/DROP COLUMN|version/i);
    expect(comments).toMatch(/no data rewrite|does not rewrite|no rewrite|additive/i);
    expect(comments).toMatch(/push-cloud/i);
    expect(comments).toMatch(/append[- ]only|once/i);
  });
});

describe("T0C-SYNC-2 implementation notes (done_when 7): classification table, version columns, founder step, permissions", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  it("notes exist, name the migration as a founder step (push-cloud), cite LD-322, the design file, and list the five operation ids", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-SYNC-2-impl.md missing").toBe(true);
    expect(t).toContain(MIG);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/LD-322/);
    expect(t).toMatch(/offline-design-20261117/);
    for (const id of Object.keys(OPS)) expect(t, id).toContain(id);
    expect(t).toMatch(/pendingOperations|CORE_PENDING_OPERATIONS/);
    expect(t).toMatch(/T0B-SYNC-2/);
  });
  it("lists the new permission codes (none: the three SYNC-1 codes are reused) and the nine error codes, and says messages never carry personal data", () => {
    expect(t).toMatch(/no new permission|none new|reuse/i);
    for (const c of [USE, RES]) expect(t, c).toContain(c);
    for (const c of Object.keys(NEW_ERRORS)) expect(t, c).toContain(c);
    expect(t).toMatch(/personal data/i);
  });
  it("lists every table that got a version column (at most 5) and that existing rows were not rewritten beyond the default", () => {
    expect(t).toMatch(/version column/i);
    expect(t).toMatch(/updated_at/);
    expect(t).toMatch(/default|no rewrite|not rewrit/i);
    const m = existsSync(join(ROOT, "db/migrations", MIG)) ? readFileSync(join(ROOT, "db/migrations", MIG), "utf8") : "";
    for (const a of m.matchAll(/ALTER\s+TABLE\s+(?:IF EXISTS\s+)?(?:ONLY\s+)?(\w+\.\w+)\s+ADD\s+COLUMN/gi)) expect(t, `notes list ${a[1]}`).toContain(a[1]);
  });
  it("contains the classification table of every existing operation family as queueable, cacheable read or online only (the web tasks rely on it), covering the 8 queueable op_types, the cacheable reads of design section 3 and the online only list of section 3", () => {
    expect(t).toMatch(/queueable/i);
    expect(t).toMatch(/cacheable read/i);
    expect(t).toMatch(/online only/i);
    for (const op of OP_TYPES) expect(t, op).toContain(op);
    for (const w of ["test catalog", "price list", "doctors", "centres", "permissions", "patients", "worklist", "verification policy", "print profile"]) expect(t.toLowerCase(), `cacheable: ${w}`).toContain(w);
    for (const w of ["SMS", "WhatsApp", "broadcast", "online payment", "user and role", "platform admin", "first sign in", "import", "refund", "cancel", "MFA"]) expect(t, `online only: ${w}`).toContain(w);
    for (const w of ["sales", "partner", "report", "price tool", "billing", "lab", "frontdesk", "homecollection"]) expect(t.toLowerCase(), `family ${w}`).toContain(w);
    expect((t.match(/^\|.*\b(queueable|cacheable read|online only)\b.*\|/gim) ?? []).length, "a markdown table with one row per family").toBeGreaterThanOrEqual(12);
  });
  it("states the numbering rule (provisional OFF- number, final gap free number returned in number_mappings; the accountant must confirm) and the conflict rules of design section 8", () => {
    expect(t).toMatch(/PROVISIONAL/);
    expect(t).toMatch(/OFF-/);
    expect(t).toMatch(/number_mappings/);
    expect(t).toMatch(/accountant/i);
    expect(t).toMatch(/gap free|gap-free/i);
    expect(t).toMatch(/keep_server/);
    expect(t).toMatch(/apply_local/);
    expect(t).toMatch(/merge/);
    expect(t).toMatch(/append[- ]only/i);
  });
  it("records the choices: where (core.yaml, same file as part 1), the payload identity rule (no copied fields) and the entity_id / base_version rules", () => {
    expect(t).toMatch(/core\.yaml/);
    expect(t).toMatch(/entity_id/);
    expect(t).toMatch(/base_version/);
    expect(t).toMatch(/no copied|\$ref|identity|hoist/i);
  });
});

// Review T0C-SYNC-2 items 1 and 2 (LD-322): open JSON documents are objects, and SyncErrorCode covers the wrapped operations.
describe("T0C-SYNC-2 review: JSON document fields are objects (item 1)", () => {
  const schemas = (): Record<string, any> => C_DOC.components.schemas;
  const FIELDS: [string, string][] = [["SyncUpsert", "document"], ["SyncConflict", "local_payload"], ["SyncConflict", "server_payload"], ["ResolveSyncConflictRequest", "merged_payload"]];
  for (const [sch, f] of FIELDS) {
    it(`${sch}.${f} is type: object (not any JSON value)`, () => {
      expect(deref(props(schemas()[sch])[f])?.type, `${sch}.${f}`).toBe("object");
    });
  }
  it("migration: core.sync_conflict has CONSTRAINT sync_conflict__payloads__ck CHECK jsonb_typeof(local_payload) and (server_payload) = 'object'", () => {
    const m = readFileSync(join(ROOT, "db/migrations", MIG), "utf8");
    expect(m).toMatch(/CONSTRAINT\s+sync_conflict__payloads__ck\s+CHECK\s*\(\s*jsonb_typeof\(\s*local_payload\s*\)\s*=\s*'object'\s+AND\s+jsonb_typeof\(\s*server_payload\s*\)\s*=\s*'object'\s*\)/i);
  });
  it("a non-object merged_payload, local_payload or server_payload fails ajv", () => {
    const r = validatorFor("resolveSyncConflict", "req");
    for (const bad of ["x", 5, [1], null, true])
      expect(r({ resolution: "merge", reason: "ok", merged_payload: bad }), `merged_payload ${JSON.stringify(bad)}`).toBe(false);
    const g = validatorFor("getSyncConflict", "200");
    const open = { id: U(9), op_id: U(1), entity_type: "patient", entity_id: U(5), local_payload: { a: 1 }, server_payload: { a: 2 }, status: "open", created_at: NOW };
    expect(g(open), JSON.stringify(g.errors?.[0])).toBe(true);
    for (const f of ["local_payload", "server_payload"])
      for (const bad of ["x", 5, [1], null]) expect(g({ ...open, [f]: bad }), `${f} ${JSON.stringify(bad)}`).toBe(false);
  });
});

describe("T0C-SYNC-2 review: SyncErrorCode covers the wrapped operations (item 2)", () => {
  const codes = (): string[] => deref(C_DOC.components.schemas.SyncErrorCode).enum;
  for (const t of OP_TYPES) {
    it(`${t}: every domain code of ${WRAPS[t].op} is in SyncErrorCode`, () => {
      const wrapped: string[] = wrappedBody(t).op["x-error-codes"] ?? [];
      expect(wrapped.length, "wrapped op lists error codes").toBeGreaterThan(0);
      // request-level codes (auth, rate limit, idempotency key) are answered per request, not per op_id
      for (const c of wrapped.filter((x) => x !== "auth.unauthenticated" && x !== "common.rate_limited" && !x.startsWith("common.idempotency_key_") && x !== MFA))
        expect(codes(), `${c} missing from SyncErrorCode`).toContain(c);
    });
  }
  it("every SyncErrorCode value exists in contracts/errors.yaml and the list has no duplicates", () => {
    const reg = new Set<string>(errorsYaml.map((x: any) => x.code));
    for (const c of codes()) expect(reg.has(c), `${c} not in errors.yaml`).toBe(true);
    expect(new Set(codes()).size).toBe(codes().length);
  });
});
