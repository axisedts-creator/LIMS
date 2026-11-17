// T0C-SYNC-1 (LD-322, LD-325; founder blanket authority LD-310; founder 2026-11-17 09:19 NPT "works offline, bulk push when internet arrives", 09:20 NPT own server in another office) —
// offline sync part 1 contracts: contracts/openapi/core.yaml (7 additive staff operations under /v1/core/sync), contracts/errors.yaml (5 sync.* codes), contracts/permissions.yaml +
// the corp_admin pack (sync.use, sync.device.manage, sync.conflict.resolve), migration 20261117250000_core__add_sync_devices_and_number_blocks.sql (static checks; behaviour is
// db/tests/core/T0C-SYNC-1_sync_devices_blocks.test.sql), generated-client freshness, the pending-operations rule of LD-325(b), the implementer's notes (design section 3 table + section 4 rule).
// Design source: C:/LIMS-state/offline-design-20261117.md (sections 3, 4, 5, 6, 7).
// ASSUMPTIONS (the brief gives names and fields, not wire shapes; a different choice needs a ruling, not a silent test edit; same style as T0C-SALES-1):
//  - WHERE: contracts/openapi/core.yaml, NOT a new sync.yaml. Reading how the last module files were registered: a new yaml needs MODULE_OWNERS (tools/codegen/lint-openapi.ts), MODULE_NAMES
//    (services/api/src/core/module.ts), EVENT_PRODUCERS, db/meta/dag.yaml, system-actors.yaml and a whole module directory; core.yaml is already owned by C0, already generates api-client-ts/dart
//    core.ts / core.dart and is mounted by the core itself. The only registry edit core.yaml needs: core had no pendingOperations path (bootstrap.ts calls checkHandlers('core', spec, handlers) with no
//    pending list), so the implementer adds CORE_PENDING_OPERATIONS (services/api/src/core/core-pending.ts) and passes it to checkHandlers and mountSpec. All paths stay under /v1/core/ (lint test).
//  - OPERATIONS (tag core, bearerJwt, x-context tenant): see OPS. Reads need sync.use or sync.device.manage; writes of the device owner (register, ack wipe, reserve block) need sync.use;
//    revoke, request wipe and list need sync.device.manage (privileged, so auth.mfa_required). registerSyncDevice is idempotent per device id: 200 (never 201), Idempotency-Key required.
//    reserveNumberBlock answers 201 and needs Idempotency-Key. The brief's `size within the configured maximum` is a service rule: oversize answers sync.block_size_too_large.
//  - WIRE NAMES = the brief's column names (snake_case). SyncDevice {id, user_id, device_label, platform, app_version, status, first_seen_at, last_seen_at, last_sync_at?, wipe_requested_at?,
//    wipe_acked_at?, last_clock_skew_ms?, offline_retention_days, created_at, updated_at}; NumberBlock {id, device_id, series, centre_id?, from_value, to_value, issued_at, exhausted_at?, skipped_count}.
//    reserveNumberBlock returns {block: NumberBlock, remaining_size: integer >= 0} ("the new remaining size" of the brief, pinned as remaining_size). getSyncStatus returns
//    {server_time, device_status, min_app_version, limits {max_batch_operations 50, max_batch_bytes 1048576}, retry {base_delay_ms, max_delay_ms 300000, jitter "full"}, offline_approval_allowed}.
//    The tenant_id never appears on the wire; no float, no nullable (absent = not set); identifiers are UUIDs, block bounds are integers.
//  - ERROR CODES (closed list, owner C0, errors.yaml widened by exactly these five; contracts/__tests__/registry-equality.test.ts was widened the same way, as for LD-313 and LD-321):
//    sync.device_revoked 403, sync.device_unknown 409, sync.block_size_too_large 422, sync.series_unknown 422, sync.wipe_required 409. Titles and meanings carry no personal data.
//  - PERMISSION NAME CONFLICT (decision for the lead, see the tests note): `sync.use` has TWO segments, but g_permissions__code__ck (migration 20261105000500), gen-permissions.ts and the registry
//    test require three. The brief and LD-322 name it verbatim, so it is pinned; the implementer relaxes the three places to ^[a-z_]+\.[a-z_]+(\.[a-z_]+)?$ (migration part: guarded
//    DROP + ADD of g_permissions__code__ck, tested in the pgTAP suite). If the lead prefers a rename the tests move with the ruling.
//  - LD-325(b): the 7 operationIds are in CORE_PENDING_OPERATIONS; T0B-SYNC-1 removes them with the handlers. The implementer's notes are .orchestra/notes/T0C-SYNC-1-impl.md.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MIG = "20261117250000_core__add_sync_devices_and_number_blocks.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-SYNC-1-impl.md");
const load = (f: string): any => parse(readFileSync(join(ROOT, f), "utf8"));
const C_DOC = load("contracts/openapi/core.yaml");
const common = load("contracts/openapi/_common.yaml");
const registry = load("contracts/permissions.yaml");
const errorsYaml: any[] = load("contracts/errors.yaml");
const packs = load("services/api/src/modules/identity/role-packs/role-packs.data.yaml");
const METHODS = ["get", "put", "post", "delete", "patch"];
const PFX = "/v1/core/sync";
const UUID = "0193c4a0-0000-7000-8000-0000000000aa";
const UUID2 = "0193c4a0-0000-7000-8000-0000000000bb";
const NOW = "2026-11-17T10:15:00Z";

type OpSpec = { method: string; path: string; perm: string; idem: "required" | "none" | "any"; ok: string; paged?: boolean; pathId?: boolean };
const USE = "sync.use", DEV = "sync.device.manage", RES = "sync.conflict.resolve";
const OPS: Record<string, OpSpec> = {
  registerSyncDevice: { method: "post", path: `${PFX}/devices`, perm: USE, idem: "required", ok: "200" },
  listSyncDevices: { method: "get", path: `${PFX}/devices`, perm: DEV, idem: "none", ok: "200", paged: true },
  revokeSyncDevice: { method: "post", path: `${PFX}/devices/{device_id}/revoke`, perm: DEV, idem: "any", ok: "200", pathId: true },
  requestDeviceWipe: { method: "post", path: `${PFX}/devices/{device_id}/wipe`, perm: DEV, idem: "any", ok: "200", pathId: true },
  ackDeviceWipe: { method: "post", path: `${PFX}/devices/{device_id}/wipe-ack`, perm: USE, idem: "any", ok: "200", pathId: true },
  getSyncStatus: { method: "get", path: `${PFX}/status`, perm: USE, idem: "none", ok: "200" },
  reserveNumberBlock: { method: "post", path: `${PFX}/number-blocks`, perm: USE, idem: "required", ok: "201" },
};
const NEW_ERRORS: Record<string, number> = { "sync.device_revoked": 403, "sync.device_unknown": 409, "sync.block_size_too_large": 422, "sync.series_unknown": 422, "sync.wipe_required": 409 };
const OP_ERRORS: Record<string, string[]> = {
  registerSyncDevice: ["sync.device_revoked", "sync.wipe_required"],
  revokeSyncDevice: ["sync.device_unknown"],
  requestDeviceWipe: ["sync.device_unknown"],
  ackDeviceWipe: ["sync.device_unknown", "sync.device_revoked"],
  getSyncStatus: ["sync.device_unknown", "sync.device_revoked", "sync.wipe_required"],
  reserveNumberBlock: ["sync.device_unknown", "sync.device_revoked", "sync.wipe_required", "sync.block_size_too_large", "sync.series_unknown"],
};
const PLATFORMS = ["web", "android", "ios"];
const STATUSES = ["active", "revoked", "wipe_requested"];
const SERIES = ["lab_code", "patient_id"];
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
const reqSchema = (id: string, o = opIn(C_DOC, id)!): any => deref(C_DOC, o.op.requestBody?.content?.["application/json"]?.schema);
const okSchema = (id: string, o = opIn(C_DOC, id)!): any => {
  const code = Object.keys(o.op.responses).find((c) => /^2/.test(c))!;
  return deref(C_DOC, o.op.responses[code]?.content?.["application/json"]?.schema);
};
const itemSchema = (id: string): any => deref(C_DOC, okSchema(id).properties.data.items);
const props = (s: any): Record<string, any> => s?.properties ?? {};
const paramNames = (op: any): string[] => (op.parameters ?? []).map((p: any) => deref(C_DOC, p).name);
const paramOf = (op: any, name: string): any => (op.parameters ?? []).map((p: any) => deref(C_DOC, p)).find((p: any) => p.name === name);
const enumOf = (p: any): string[] => ((deref(C_DOC, p)?.enum ?? []) as unknown[]).filter((x): x is string => typeof x === "string");
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
ajv.addSchema({ ...C_DOC, id: "core.yaml" });
const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const validatorFor = (id: string, where: "req" | string) => {
  const o = opIn(C_DOC, id)!;
  const ptr = where === "req" ? `/paths/${esc(o.path)}/${o.method}/requestBody/content/application~1json/schema` : `/paths/${esc(o.path)}/${o.method}/responses/${where}/content/application~1json/schema`;
  const v = ajv.getSchema(`core.yaml#${ptr}`);
  expect(v, `cannot resolve ${id} ${where}`).toBeDefined();
  return v!;
};
const device = (over: Record<string, unknown> = {}) => ({
  id: UUID, user_id: UUID2, device_label: "Front desk PC 1 (synthetic)", platform: "web", app_version: "1.4.0", status: "active", first_seen_at: NOW, last_seen_at: NOW,
  offline_retention_days: 14, created_at: NOW, updated_at: NOW, ...over,
});
const block = (over: Record<string, unknown> = {}) => ({ id: UUID, device_id: UUID2, series: "lab_code", from_value: 1001, to_value: 1200, issued_at: NOW, skipped_count: 0, ...over });

describe("T0C-SYNC-1 core.yaml: lint and additive baseline", () => {
  it("lintRepo reports no violation for core.yaml; paths stay under /v1/core/; still OpenAPI 3.0.3", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "core.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
    expect(C_DOC.openapi).toBe("3.0.3");
    for (const k of Object.keys(C_DOC.paths)) expect(k.startsWith("/v1/core/"), k).toBe(true);
  });
  it("core.yaml is additive: the 2 health operations stay unchanged, exactly 7 new ones, unique ids", () => {
    const ids = idsOf(C_DOC);
    expect(ids.length, "2 health + 7 sync").toBe(9);
    expect(new Set(ids).size).toBe(9);
    expect(opIn(C_DOC, "getLiveness")!.path).toBe("/v1/core/health/live");
    expect(opIn(C_DOC, "getReadiness")!.path).toBe("/v1/core/health/ready");
    expect(opIn(C_DOC, "getLiveness")!.op["x-public"]).toBeDefined();
    for (const id of Object.keys(OPS)) expect(opIn(C_DOC, id), `${id} missing`).toBeDefined();
  });
});

describe("T0C-SYNC-1 core.yaml: the 7 operations (done_when 3, 4, 5, 6)", () => {
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
      it("error codes: five common, not_found with a path id, mfa on the privileged code, invalid_cursor on lists, the sync.* codes of the table; every code is registered", () => {
        const e: string[] = o?.op["x-error-codes"] ?? [];
        for (const c of ["common.validation_failed", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"]) expect(e, c).toContain(c);
        if (s.pathId) expect(e).toContain("common.not_found");
        if (s.perm === DEV) expect(e, "privileged permission needs auth.mfa_required").toContain(MFA);
        else expect(e).not.toContain(MFA);
        if (s.paged) expect(e).toContain("common.invalid_cursor");
        for (const c of OP_ERRORS[id] ?? []) expect(e, c).toContain(c);
        const reg = new Set<string>(errorsYaml.map((x: any) => x.code));
        for (const c of e) expect(reg.has(c), `${c} not in contracts/errors.yaml`).toBe(true);
      });
      it("idempotency header on required operations; no If-Match anywhere (the device table has no version column)", () => {
        const names = paramNames(o?.op ?? {});
        if (s.idem === "required") { expect(o!.op["x-idempotency"]).toBe("required"); expect(names).toContain("Idempotency-Key"); expect(o!.op["x-error-codes"]).toContain("common.idempotency_key_required"); }
        if (s.idem === "none") expect(o!.op["x-idempotency"]).toBe("none");
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
      it("every object schema reachable from the request and response is closed (additionalProperties false); no float, no nullable, no tenant_id / server authority field in a request", () => {
        for (const m of jsonMedia(o!.op)) walk(C_DOC, m.schema, (n) => {
          if (n.type === "object" || n.properties) expect(n.additionalProperties, JSON.stringify(Object.keys(n.properties ?? {})).slice(0, 80)).toBe(false);
          expect(n.type, "counts and bounds are integers, never number").not.toBe("number");
          expect(n.nullable, "no nullable: absent means not set").not.toBe(true);
        });
        walk(C_DOC, o!.op.requestBody?.content?.["application/json"]?.schema, (n) => {
          for (const f of ["tenant_id", "user_id", "created_by", "updated_by", "created_at", "updated_at", "status", "first_seen_at", "last_seen_at", "issued_at", "from_value", "to_value"])
            expect(Object.keys(n.properties ?? {}), `request names server field ${f}`).not.toContain(f);
        });
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

describe("T0C-SYNC-1 shapes: device registry (design section 6)", () => {
  it("SyncDevice carries the brief's columns; required = id, user_id, device_label, platform, app_version, status, first_seen_at, last_seen_at, offline_retention_days; optional fields not nullable", () => {
    const row = itemSchema("listSyncDevices");
    for (const f of ["id", "user_id", "device_label", "platform", "app_version", "status", "first_seen_at", "last_seen_at", "last_sync_at", "wipe_requested_at", "wipe_acked_at", "last_clock_skew_ms", "offline_retention_days", "created_at", "updated_at"])
      expect(props(row)[f], `device.${f}`).toBeDefined();
    expect(row.required).toEqual(expect.arrayContaining(["id", "user_id", "device_label", "platform", "app_version", "status", "first_seen_at", "last_seen_at", "offline_retention_days"]));
    for (const f of ["last_sync_at", "wipe_requested_at", "wipe_acked_at", "last_clock_skew_ms"]) { expect(row.required, f).not.toContain(f); expect(props(row)[f].nullable).not.toBe(true); }
    sortedEq(enumOf(props(row).platform), PLATFORMS);
    sortedEq(enumOf(props(row).status), STATUSES);
    expect(props(row).device_label.maxLength).toBeLessThanOrEqual(120);
    expect(props(row).app_version.maxLength).toBeLessThanOrEqual(40);
    expect(props(row).last_clock_skew_ms.type).toBe("integer");
    expect(props(row).offline_retention_days).toMatchObject({ type: "integer" });
    expect(JSON.stringify(props(row).id)).toContain("Uuid");
    expect(JSON.stringify(props(row).user_id)).toContain("Uuid");
    expect(Object.keys(props(row)), "tenant_id never on the wire").not.toContain("tenant_id");
  });
  it("registerSyncDevice: body {id: device uuid, device_label, platform, app_version}; all required; the response is the SyncDevice", () => {
    const b = reqSchema("registerSyncDevice");
    sortedEq(b.required, ["id", "device_label", "platform", "app_version"]);
    sortedEq(Object.keys(props(b)), ["id", "device_label", "platform", "app_version"]);
    expect(JSON.stringify(props(b).id)).toContain("Uuid");
    sortedEq(enumOf(props(b).platform), PLATFORMS);
    expect(String(opIn(C_DOC, "registerSyncDevice")!.op.description ?? ""), "description says re-registering the same id is idempotent").toMatch(/idempot|same (device )?id|already/i);
    expect(props(okSchema("registerSyncDevice")).status).toBeDefined();
  });
  it("registerSyncDevice payloads: valid; empty label, unknown platform, bad uuid, oversize version, unknown and server fields rejected", () => {
    const v = validatorFor("registerSyncDevice", "req");
    const ok = { id: UUID, device_label: "Front desk PC 1 (synthetic)", platform: "web", app_version: "1.4.0" };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const p of PLATFORMS) expect(v({ ...ok, platform: p })).toBe(true);
    for (const bad of [{ device_label: "" }, { platform: "windows" }, { platform: "Web" }, { id: "x" }, { app_version: "" }, { app_version: "9".repeat(100) }, { device_label: "L".repeat(500) },
      { unknown_field: 1 }, { tenant_id: UUID }, { user_id: UUID }, { status: "active" }, { offline_retention_days: 365 }]) expect(v({ ...ok, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    for (const missing of ["id", "device_label", "platform", "app_version"]) { const { [missing]: _x, ...rest } = ok as any; expect(v(rest), `accepted without ${missing}`).toBe(false); }
  });
  it("listSyncDevices filters: status, user_id, platform; the response is a paged list of SyncDevice; no search by label or e-mail", () => {
    const names = paramNames(opIn(C_DOC, "listSyncDevices")!.op);
    for (const n of ["status", "user_id", "platform"]) expect(names, n).toContain(n);
    for (const n of ["name", "email", "phone", "device_label"]) expect(names, n).not.toContain(n);
    sortedEq(enumOf(paramOf(opIn(C_DOC, "listSyncDevices")!.op, "status")?.schema), STATUSES);
    sortedEq(enumOf(paramOf(opIn(C_DOC, "listSyncDevices")!.op, "platform")?.schema), PLATFORMS);
  });
  it("revoke, wipe request and wipe ack take the device id in the path, no body needed (a reason is optional and closed), and answer the SyncDevice", () => {
    for (const id of ["revokeSyncDevice", "requestDeviceWipe", "ackDeviceWipe"]) {
      const o = opIn(C_DOC, id)!;
      expect(paramNames(o.op), id).toContain("device_id");
      if (o.op.requestBody) { expect(o.op.requestBody.required, `${id} body optional`).not.toBe(true); expect(reqSchema(id).additionalProperties).toBe(false); }
      for (const f of ["id", "status", "wipe_requested_at", "wipe_acked_at"]) expect(props(okSchema(id))[f], `${id} response ${f}`).toBeDefined();
    }
    expect(String(opIn(C_DOC, "ackDeviceWipe")!.op.description ?? ""), "ack: only the device itself (the signed in owner of that device) may acknowledge").toMatch(/own|itself|that device|owner/i);
    expect(String(opIn(C_DOC, "requestDeviceWipe")!.op.description ?? ""), "wipe: runs on the device's next contact").toMatch(/next|contact|sync/i);
    expect(String(opIn(C_DOC, "revokeSyncDevice")!.op.description ?? ""), "revoke: the device refuses to unlock").toMatch(/revok|refus|unlock|rejected/i);
  });
});

describe("T0C-SYNC-1 shapes: sync status, limits and retry hints (design sections 5, 6, 7)", () => {
  const st = () => okSchema("getSyncStatus");
  it("getSyncStatus query: device_id required uuid; the response has server_time, device_status (active | revoked | wipe_requested), min_app_version, limits, retry, offline_approval_allowed", () => {
    expect(paramOf(opIn(C_DOC, "getSyncStatus")!.op, "device_id")?.required).toBe(true);
    for (const f of ["server_time", "device_status", "min_app_version", "limits", "retry", "offline_approval_allowed"]) expect(props(st())[f], `status.${f}`).toBeDefined();
    expect(st().required).toEqual(expect.arrayContaining(["server_time", "device_status", "limits", "retry", "offline_approval_allowed"]));
    sortedEq(enumOf(props(st()).device_status), STATUSES);
    expect(props(st()).offline_approval_allowed.type).toBe("boolean");
    expect(st().required, "min_app_version may be unset").not.toContain("min_app_version");
    expect(props(st()).min_app_version.nullable).not.toBe(true);
    expect(JSON.stringify(props(st()).server_time)).toMatch(/IsoDateTime|date-time/);
    expect(String(opIn(C_DOC, "getSyncStatus")!.op.description ?? "")).toMatch(/offline approval|policy/i);
  });
  it("limits: max_batch_operations (integer, example 50) and max_batch_bytes (integer, example 1048576) are required and closed; retry: base_delay_ms, max_delay_ms, jitter enum full", () => {
    const lim = deref(C_DOC, props(st()).limits), retry = deref(C_DOC, props(st()).retry);
    sortedEq(lim.required, ["max_batch_operations", "max_batch_bytes"]);
    for (const f of ["max_batch_operations", "max_batch_bytes"]) expect(props(lim)[f].type).toBe("integer");
    expect(lim.additionalProperties).toBe(false);
    sortedEq(retry.required, ["base_delay_ms", "max_delay_ms", "jitter"]);
    expect(retry.additionalProperties).toBe(false);
    for (const f of ["base_delay_ms", "max_delay_ms"]) expect(props(retry)[f].type).toBe("integer");
    expect(enumOf(props(retry).jitter)).toEqual(["full"]);
  });
  it("the status examples state the design values: 50 operations, 1 MB (1048576 bytes), retry cap 300000 ms (5 minutes), full jitter", () => {
    const ex = Object.values<any>(opIn(C_DOC, "getSyncStatus")!.op.responses["200"].content["application/json"].examples).map((e) => e.value);
    expect(ex.length).toBeGreaterThan(0);
    for (const e of ex) {
      expect(e.limits).toMatchObject({ max_batch_operations: 50, max_batch_bytes: 1048576 });
      expect(e.retry).toMatchObject({ max_delay_ms: 300000, jitter: "full" });
    }
    expect(ex.map((e) => e.device_status), "one example shows a device that must wipe or is revoked").toEqual(expect.arrayContaining(["active"]));
  });
  it("status payload validation: a full answer validates; a float limit, a string, an unknown device_status and an unknown field are rejected", () => {
    const v = validatorFor("getSyncStatus", "200");
    const ok = { server_time: NOW, device_status: "active", min_app_version: "1.0.0", limits: { max_batch_operations: 50, max_batch_bytes: 1048576 }, retry: { base_delay_ms: 1000, max_delay_ms: 300000, jitter: "full" }, offline_approval_allowed: false };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ ...ok, device_status: "wipe_requested" })).toBe(true);
    for (const bad of [{ limits: { max_batch_operations: 50.5, max_batch_bytes: 1048576 } }, { limits: { max_batch_operations: "50", max_batch_bytes: 1 } }, { device_status: "deleted" }, { offline_approval_allowed: "no" }, { extra: 1 }])
      expect(v({ ...ok, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });
});

describe("T0C-SYNC-1 shapes: number block reservation (design section 4)", () => {
  it("NumberBlock: id, device_id, series (lab_code | patient_id), centre_id?, from_value, to_value (integers), issued_at, exhausted_at?, skipped_count", () => {
    const b = deref(C_DOC, props(okSchema("reserveNumberBlock")).block);
    for (const f of ["id", "device_id", "series", "centre_id", "from_value", "to_value", "issued_at", "exhausted_at", "skipped_count"]) expect(props(b)[f], `block.${f}`).toBeDefined();
    expect(b.required).toEqual(expect.arrayContaining(["id", "device_id", "series", "from_value", "to_value", "issued_at", "skipped_count"]));
    for (const f of ["centre_id", "exhausted_at"]) { expect(b.required, f).not.toContain(f); expect(props(b)[f].nullable).not.toBe(true); }
    sortedEq(enumOf(props(b).series), SERIES);
    for (const f of ["from_value", "to_value", "skipped_count"]) expect(props(b)[f].type, `${f} is an integer`).toBe("integer");
    expect(props(b).skipped_count.minimum).toBeGreaterThanOrEqual(0);
    expect(b.additionalProperties).toBe(false);
  });
  it("reserveNumberBlock: body {device_id, series, centre_id?, size >= 1}; the answer is {block, remaining_size}", () => {
    const b = reqSchema("reserveNumberBlock");
    sortedEq(b.required, ["device_id", "series", "size"]);
    sortedEq(Object.keys(props(b)), ["device_id", "series", "centre_id", "size"]);
    expect(props(b).size).toMatchObject({ type: "integer", minimum: 1 });
    expect(props(b).size.maximum, "an upper bound exists in the schema; the configured maximum is a service rule").toBeDefined();
    sortedEq(enumOf(props(b).series), SERIES);
    const ok = okSchema("reserveNumberBlock");
    sortedEq(ok.required, ["block", "remaining_size"]);
    expect(props(ok).remaining_size).toMatchObject({ type: "integer", minimum: 0 });
    expect(ok.additionalProperties).toBe(false);
    expect(String(opIn(C_DOC, "reserveNumberBlock")!.op.description ?? ""), "description states no overlap and that unused numbers are skipped").toMatch(/overlap/i);
    expect(String(opIn(C_DOC, "reserveNumberBlock")!.op.description ?? "")).toMatch(/skipped|gap/i);
  });
  it("block request payloads: both series and an optional centre validate; size 0, -1, 1.5, '200', unknown series, bad uuid and unknown fields are rejected", () => {
    const v = validatorFor("reserveNumberBlock", "req");
    const ok = { device_id: UUID, series: "lab_code", size: 200 };
    expect(v(ok), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ device_id: UUID, series: "patient_id", size: 100, centre_id: UUID2 })).toBe(true);
    for (const bad of [{ size: 0 }, { size: -1 }, { size: 1.5 }, { size: "200" }, { series: "bill_no" }, { series: "invoice" }, { series: "Lab_Code" }, { device_id: "x" }, { centre_id: "x" }, { unknown_field: 1 }, { tenant_id: UUID }, { from_value: 1 }])
      expect(v({ ...ok, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    for (const missing of ["device_id", "series", "size"]) { const { [missing]: _x, ...rest } = ok as any; expect(v(rest), `accepted without ${missing}`).toBe(false); }
  });
  it("response payloads: a block with bounds and remaining_size validates; float bounds and a missing remaining_size are rejected", () => {
    const v = validatorFor("reserveNumberBlock", "201");
    expect(v({ block: block(), remaining_size: 0 }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ block: block({ series: "patient_id", centre_id: UUID, exhausted_at: NOW, skipped_count: 12 }), remaining_size: 4800 })).toBe(true);
    for (const bad of [{ block: block({ from_value: 1.5 }), remaining_size: 1 }, { block: block({ series: "bill_no" }), remaining_size: 1 }, { block: block() }, { block: block(), remaining_size: -1 }, { block: block({ extra: 1 }), remaining_size: 1 }])
      expect(v(bad), `accepted ${JSON.stringify(bad).slice(0, 80)}`).toBe(false);
  });
  it("bill, invoice and receipt numbers are NOT in blocks (design section 4: provisional numbers, server finalises): the series enum has no bill series", () => {
    const b = reqSchema("reserveNumberBlock");
    expect(enumOf(props(b).series).join(",")).not.toMatch(/bill|invoice|receipt/);
  });
});

describe("T0C-SYNC-1 examples", () => {
  const check = (id: string) => {
    const o = opIn(C_DOC, id)!;
    const reqEx = o.op.requestBody?.content?.["application/json"]?.examples;
    if (reqEx) for (const e of Object.values<any>(reqEx)) { const v = validatorFor(id, "req"); expect(v(e.value), `${id} request example: ${JSON.stringify(v.errors?.[0])}`).toBe(true); }
    for (const [code, r] of Object.entries<any>(o.op.responses)) {
      if (r.$ref || !r.content?.["application/json"]?.examples) continue;
      for (const e of Object.values<any>(r.content["application/json"].examples)) { const v = validatorFor(id, code); expect(v(e.value), `${id} ${code} example: ${JSON.stringify(v.errors?.[0])}`).toBe(true); }
    }
  };
  it("every request and response example of the 7 operations validates against its schema, with synthetic values only", () => {
    for (const id of Object.keys(OPS)) check(id);
    const text = JSON.stringify(Object.keys(OPS).map((id) => opIn(C_DOC, id)!.op));
    expect(text).not.toMatch(/@(?!example\.(test|com|org)|[a-z0-9.-]*\.test)/i);
    expect(text).not.toMatch(/\b9[78]\d{8}\b/);
  });
});

describe("T0C-SYNC-1 error codes: the closed list (done_when 4)", () => {
  it("errors.yaml holds exactly five sync.* codes, owner C0, with the pinned http status and a title and meaning free of personal data; no other code was added", () => {
    const sync = errorsYaml.filter((e) => String(e.code).startsWith("sync."));
    sortedEq(sync.map((e) => e.code), Object.keys(NEW_ERRORS));
    for (const e of sync) {
      expect(e.owner, e.code).toBe("C0");
      expect(e.http, `${e.code} http`).toBe(NEW_ERRORS[e.code]);
      expect(String(e.title).length, `${e.code} title`).toBeGreaterThan(0);
      expect(String(e.title).length, `${e.code} title`).toBeLessThanOrEqual(80);
      expect(`${e.title} ${e.meaning}`, `${e.code}: no name, e-mail, phone, id placeholder`).not.toMatch(/@|\{|\}|%s|\$\{|patient name|\b9[78]\d{8}\b/i);
    }
  });
  it("every sync.* code is used by at least one core.yaml operation, and no operation outside core.yaml uses them", () => {
    const used = new Set<string>(Object.keys(OPS).flatMap((id) => opIn(C_DOC, id)?.op["x-error-codes"] ?? []));
    for (const c of Object.keys(NEW_ERRORS)) expect(used.has(c), `${c} unused`).toBe(true);
    for (const f of readdirSync(join(ROOT, "contracts/openapi")).filter((x) => x.endsWith(".yaml") && x !== "core.yaml" && !x.startsWith("_"))) {
      const t = readFileSync(join(ROOT, "contracts/openapi", f), "utf8");
      expect(t, `${f} must not use a sync.* error code`).not.toMatch(/\bsync\.(device_revoked|device_unknown|block_size_too_large|series_unknown|wipe_required)\b/);
    }
  });
});

describe("T0C-SYNC-1 permissions (done_when 5)", () => {
  const byCode = new Map<string, any>(registry.permissions.map((p: any) => [p.code, p]));
  const TENANT_ROLES = registry.roles.map((r: any) => r.code as string);
  it("sync.use (not privileged) is held by every tenant role that can sign in; sync.device.manage (privileged) by tenant_admin; sync.conflict.resolve (privileged) by tenant_admin, lab_manager, finance", () => {
    const known = new Set([...registry.roles, ...registry.partner_roles, ...registry.platform_roles].map((r: any) => r.code));
    const want: Array<[string, boolean, string[]]> = [[USE, false, TENANT_ROLES], [DEV, true, ["tenant_admin"]], [RES, true, ["tenant_admin", "lab_manager", "finance"]]];
    for (const [code, priv, roles] of want) {
      const p = byCode.get(code);
      expect(p, `${code} missing from contracts/permissions.yaml`).toBeDefined();
      expect(p.privileged, `${code} privileged`).toBe(priv);
      sortedEq(p.roles, roles);
      for (const r of p.roles) expect(known.has(r), `${code} unknown role ${r}`).toBe(true);
      expect(p.roles.filter((r: string) => r.startsWith("partner_") || r.startsWith("platform_")), "never a partner or platform role").toEqual([]);
    }
  });
  it("the registry grew only by these three sync codes; nothing was renamed or removed (homecollection.sync.upload keeps its role)", () => {
    sortedEq(registry.permissions.filter((p: any) => p.code.startsWith("sync.")).map((p: any) => p.code), [USE, DEV, RES]);
    expect(byCode.get("homecollection.sync.upload")).toMatchObject({ privileged: false, roles: ["phlebotomist"] });
    expect(JSON.stringify(registry.fixed_actor_permissions), "sync codes are for signed in staff, not for fixed actors").not.toMatch(/"sync\.|[\[,]sync\./);
  });
  it("every x-permission of the 7 operations is one of the three codes; sync.conflict.resolve is reserved for part 2 (used by no operation here); the privileged device code only on admin operations", () => {
    const used = new Set(Object.keys(OPS).map((id) => opIn(C_DOC, id)!.op["x-permission"]));
    sortedEq([...used] as string[], [USE, DEV]);
    for (const id of ["listSyncDevices", "revokeSyncDevice", "requestDeviceWipe"]) expect(opIn(C_DOC, id)!.op["x-permission"], id).toBe(DEV);
    for (const id of ["registerSyncDevice", "ackDeviceWipe", "getSyncStatus", "reserveNumberBlock"]) expect(opIn(C_DOC, id)!.op["x-permission"], id).toBe(USE);
  });
  it("corp_admin pack holds all three codes, sorted and without duplicates", () => {
    const admin = packs.packs.flatMap((p: any) => p.roles).find((r: any) => r.code === "corp_admin");
    for (const c of [USE, DEV, RES]) expect(admin.permissions, `corp_admin lacks ${c}`).toContain(c);
    expect(new Set(admin.permissions).size).toBe(admin.permissions.length);
    expect(admin.permissions).toEqual([...admin.permissions].sort());
  });
  it("the generated permission seed and the ports permission list carry the three codes (the two segment code is accepted by the generator)", () => {
    const seed = readFileSync(join(ROOT, "db/seeds/001_core__g_permissions.sql"), "utf8");
    for (const c of [USE, DEV, RES]) expect(seed, `seed lacks ${c}`).toContain(`'${c}'`);
    const ts = readFileSync(join(ROOT, "contracts/ports/generated/permissions.ts"), "utf8");
    for (const c of [USE, DEV, RES]) expect(ts, `permissions.ts lacks ${c}`).toContain(`"${c}"`);
  });
});

describe("T0C-SYNC-1 generated clients and the pending-operations rule (LD-325)", () => {
  it("generated clients, types, MSW handlers, permissions and seeds are fresh (codegen --check)", () => { expect(staleFiles(ROOT)).toEqual([]); }, 120_000);
  it("the core client carries the 7 operations (api-client-ts core.ts and api-client-dart core.dart)", () => {
    const ts = readFileSync(join(ROOT, "packages/api-client-ts/src/core.ts"), "utf8");
    const dart = readFileSync(join(ROOT, "packages/api-client-dart/lib/core.dart"), "utf8");
    for (const id of Object.keys(OPS)) { expect(ts, `core.ts ${id}`).toContain(id); expect(dart, `core.dart ${id}`).toContain(id); }
  });
  it("core has a pending list: services/api/src/core/core-pending.ts exports CORE_PENDING_OPERATIONS with the 7 ids, and bootstrap.ts hands it to checkHandlers and mountSpec for core (T0B-SYNC-1 empties it)", () => {
    const p = join(ROOT, "services/api/src/core/core-pending.ts");
    expect(existsSync(p), "services/api/src/core/core-pending.ts missing").toBe(true);
    const t = readFileSync(p, "utf8");
    expect(t).toMatch(/CORE_PENDING_OPERATIONS/);
    for (const id of Object.keys(OPS)) expect(t, id).toContain(id);
    const boot = readFileSync(join(ROOT, "services/api/src/core/bootstrap.ts"), "utf8");
    expect(boot).toMatch(/checkHandlers\('core',\s*spec,\s*handlers,\s*CORE_PENDING_OPERATIONS\)/);
    expect(boot).toMatch(/mountSpec\(app,\s*'core',\s*spec,\s*handlers,\s*auth,\s*pipes\.pipelineFor\('core'\),\s*CORE_PENDING_OPERATIONS\)/);
  });
});

describe("T0C-SYNC-1 migration file (static; behaviour in the pgTAP suite)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");
  const TABLES = ["sync_device", "number_block"];

  it("exists, is the only 20261117250000 migration, sorts after the SALES-1 migration, runs as lims_owner", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all.filter((f) => f.startsWith("20261117250000"))).toEqual([MIG]);
    expect(all.indexOf(MIG)).toBeGreaterThan(all.indexOf("20261117210000_partners__add_sales_hierarchy.sql"));
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("creates both tables IF NOT EXISTS in schema core, each with ENABLE + FORCE row level security, a tenant policy and a grant to lims_app only, and no DELETE grant", () => {
    for (const t of TABLES) {
      expect(code, `CREATE TABLE ${t}`).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS core\\.${t}\\b`, "i"));
      expect(code, `ENABLE RLS ${t}`).toMatch(new RegExp(`ALTER TABLE core\\.${t} ENABLE ROW LEVEL SECURITY`, "i"));
      expect(code, `FORCE RLS ${t}`).toMatch(new RegExp(`ALTER TABLE core\\.${t} FORCE ROW LEVEL SECURITY`, "i"));
      expect(code, `policy on ${t}`).toMatch(new RegExp(`CREATE POLICY[^;]*ON core\\.${t}\\b[^;]*app\\.current_tenant_id\\(\\)`, "is"));
      const g = code.match(new RegExp(`GRANT\\s+([^;]*?)\\s+ON\\s+core\\.${t}\\s+TO\\s+lims_app`, "i"));
      expect(g, `GRANT lims_app ${t}`).not.toBeNull();
      expect(g![1], `${t}: no DELETE / ALL / TRUNCATE (revoke and wipe keep the row for audit)`).not.toMatch(/\bDELETE\b|\bALL\b|\bTRUNCATE\b/i);
    }
    expect(code).not.toMatch(/TO\s+(PUBLIC|anon|authenticated)\b/i);
  });
  it("policies are re-runnable; every CREATE TABLE and INDEX is IF NOT EXISTS (tenant_id first); every ADD CONSTRAINT is pg_constraint guarded", () => {
    for (const m of code.matchAll(/CREATE\s+POLICY\s+(\S+)\s+ON\s+(\S+)/gi)) {
      const before = code.slice(Math.max(0, m.index! - 700), m.index);
      expect(new RegExp(`DROP POLICY IF EXISTS ${m[1]}\\b`, "i").test(code.slice(0, m.index! + 10)) || /pg_policy/i.test(before), `policy ${m[1]} is not idempotent`).toBe(true);
    }
    expect((code.match(/CREATE TABLE(?! IF NOT EXISTS)/gi) ?? []).length).toBe(0);
    for (const m of code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/gi)) throw new Error(`unguarded CREATE INDEX near ${m.index}`);
    for (const m of code.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF NOT EXISTS\s+\S+\s+ON\s+\S+\s*(?:USING\s+\w+\s*)?\(\s*(\w+)/gi)) expect(m[1], `index leads with tenant_id: ${m[0].slice(0, 80)}`).toBe("tenant_id");
    for (const m of code.matchAll(/ADD\s+CONSTRAINT/gi)) expect(code.slice(Math.max(0, m.index! - 900), m.index), "ADD CONSTRAINT must sit in a DO block that checks pg_constraint").toMatch(/DO\s+\$[a-z_]*\$[\s\S]*pg_constraint/i);
  });
  it("database rules exist: block overlap guard (exclusion constraint or BEFORE trigger under an advisory lock), audit triggers, search_path pinned on every trigger function", () => {
    expect(code).toMatch(/EXCLUDE\s+USING\s+gist|CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+\w+\s+BEFORE\s+INSERT\s+OR\s+UPDATE[^;]*ON\s+core\.number_block/i);
    if (!/EXCLUDE\s+USING\s+gist/i.test(code)) expect(code, "trigger form needs a lock against two concurrent reservations").toMatch(/pg_advisory_xact_lock/i);
    for (const t of TABLES) expect(code, `audit trigger ${t}`).toMatch(new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?TRIGGER\\s+${t}__audit\\b[^;]*ON core\\.${t}\\b[^;]*tg_row_audit`, "is"));
    for (const m of code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\S+)\s*\([^)]*\)\s+RETURNS\s+trigger[\s\S]*?\$\$;?/gi)) expect(m[0], `${m[1]} must pin search_path`).toMatch(/SET\s+search_path\s*=\s*''/i);
  });
  it("widens g_permissions__code__ck so sync.use (two segments) can be seeded: guarded DROP + ADD, tests in the pgTAP suite", () => {
    expect(code).toMatch(/g_permissions__code__ck/);
    expect(code, "the widened check keeps lowercase letters and underscores, 2 or 3 segments").toMatch(/\^\[a-z_\]\+\\\.\[a-z_\]\+\(\\\.\[a-z_\]\+\)\?\$/);
    expect(code).toMatch(/ALTER TABLE core\.g_permissions\s+(DROP CONSTRAINT IF EXISTS g_permissions__code__ck|ADD CONSTRAINT g_permissions__code__ck)/i);
  });
  it("is additive: no DROP of data, no TRUNCATE / DELETE / INSERT / UPDATE data statement, no ALTER of an old table except the g_permissions check, no type or enum, no REVOKE, no money column", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect(code).not.toMatch(/\b(DROP\s+(TABLE|COLUMN|SCHEMA|INDEX|POLICY|TRIGGER)|TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|REVOKE)\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+\S+\s+SET\b/i);
    expect(code).not.toMatch(/\bCREATE\s+TYPE\b|\bAS\s+ENUM\b|DISABLE\s+ROW|NO\s+FORCE|ALTER\s+COLUMN/i);
    const mine = [...TABLES.map((t) => `core.${t}`), "core.g_permissions"];
    for (const m of code.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF EXISTS\s+)?((?:\w+)\.\w+)/gi)) expect(mine, `ALTER of an old table ${m[1]}`).toContain(m[1]);
    expect(code).not.toMatch(/\b(float|double precision|real|numeric|decimal|money)\b/i);
  });
  it("comments: LD-322, both tables, the design file, down note with DROP TABLE, additive / no rewrite, push-cloud founder step", () => {
    expect(comments).toMatch(/LD-322/);
    expect(comments).toMatch(/offline-design-20261117/);
    expect(comments).toMatch(/\bdown\b/i);
    expect(comments).toMatch(/DROP TABLE/i);
    for (const t of TABLES) expect(comments, `down note names ${t}`).toContain(t);
    expect(comments).toMatch(/no data rewrite|does not rewrite|no rewrite|additive/i);
    expect(comments).toMatch(/push-cloud/i);
    expect(comments).toMatch(/g_permissions__code__ck/);
  });
});

describe("T0C-SYNC-1 implementation notes: design table and rule, choice, permissions, founder step (done_when 1, 7)", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  const OP_TYPES = ["registration.create_order", "billing.record_receipt", "collection.mark_collected", "accession.receive", "result.enter", "result.verify", "report.print_marker", "daily_cash.close"];
  it("notes exist, name the migration as a founder step (push-cloud), cite LD-322 and the design file, list every operation id and the pendingOperations move to T0B-SYNC-1", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-SYNC-1-impl.md missing").toBe(true);
    expect(t).toContain(MIG);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/LD-322/);
    expect(t).toMatch(/offline-design-20261117/);
    for (const id of Object.keys(OPS)) expect(t, id).toContain(id);
    expect(t).toMatch(/pendingOperations|CORE_PENDING_OPERATIONS/);
    expect(t).toMatch(/T0B-SYNC-1/);
  });
  it("copies the design section 3 operation catalogue (all 8 op_types) and the section 4 numbering rule (blocks for lab codes and patient ids; provisional OFF numbers for bills; accountant confirms) as the acceptance list", () => {
    for (const op of OP_TYPES) expect(t, op).toContain(op);
    expect(t).toMatch(/ONLINE ONLY/i);
    expect(t).toMatch(/PROVISIONAL/);
    expect(t).toMatch(/OFF-/);
    expect(t).toMatch(/accountant/i);
    expect(t).toMatch(/gap free|gap-free/i);
    expect(t).toMatch(/lab code/i);
    expect(t).toMatch(/patient id/i);
    expect(t).toMatch(/200 lab codes|default 200/i);
    expect(t).toMatch(/100 patient ids|default 100/i);
    expect(t).toMatch(/skipped/i);
  });
  it("records where the operations live and why (core.yaml vs a new file), with the registry edits that needed", () => {
    expect(t).toMatch(/core\.yaml/);
    expect(t).toMatch(/sync\.yaml/);
    expect(t).toMatch(/registry|MODULE_OWNERS|fewer/i);
  });
  it("lists every new permission code and the role-pack re-apply founder step, and the sync.use two segment decision", () => {
    for (const c of [USE, DEV, RES]) expect(t, c).toContain(c);
    expect(t).toMatch(/apply-role-pack|role pack/i);
    expect(t).toMatch(/g_permissions__code__ck|two segment|2 segment/i);
  });
  it("lists the five error codes and says messages never carry personal data", () => {
    for (const c of Object.keys(NEW_ERRORS)) expect(t, c).toContain(c);
    expect(t).toMatch(/personal data/i);
  });
  it("states the offline classification: registerSyncDevice and getSyncStatus are online (first sign in on a new device is online only), reserveNumberBlock is online only (blocks are taken while online)", () => {
    expect(t).toMatch(/online only/i);
    expect(t).toMatch(/offline/i);
    expect(t).toMatch(/reserveNumberBlock/);
  });
});
