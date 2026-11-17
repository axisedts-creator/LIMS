// T0C-04 / AC-0C-1.4, AC-0C-1.5 — spec lint fixtures, one (or more) per rule of 02-TRD §5.2.
// Contract the implementation (tools/codegen/lint-openapi.ts) must export:
//   lintOpenapi(files: {name: string; text: string}[], ctx: LintContext): Violation[] | Promise<Violation[]>
//   lintRepo(rootDir: string): Promise<Violation[]>   // loads contracts/openapi/*.yaml + registries
//   Violation = { rule: string; file: string; message: string }   rule = "1".."8" (TRD §5.2) or "AB-20"
//   LintContext = { permissions: string[]; errors: {code,owner}[]; moduleOwners: Record<module,chunk>;
//                   portOwners: Record<port,chunk>; portConsumers: Record<port,module[]> }
// `name` = file stem (module name), e.g. "widgets" for widgets.yaml.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintOpenapi, lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const ctx = {
  permissions: ["widgets.item.read", "widgets.item.manage", "identity.session.manage"],
  errors: [
    { code: "common.not_found", owner: "C0" },
    { code: "widgets.item_locked", owner: "C9" },
    { code: "gizmos.broken", owner: "C8" },
    { code: "auth.token_expired", owner: "C2" },
    { code: "catalog.price_missing", owner: "C3" },
  ],
  moduleOwners: { widgets: "C9", gizmos: "C8", identity: "C2", reporting: "C6", core: "C0" },
  portOwners: { CatalogPort: "C3" },
  portConsumers: { CatalogPort: ["widgets"] },
};

// ---------- fixture builders (fresh objects every call; no YAML anchors) ----------
const itemSchema = (): any => ({
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", maxLength: 50 },
    count: { type: "integer", minimum: 0, maximum: 1000 },
    tags: { type: "array", maxItems: 5, items: { type: "string", maxLength: 10 } },
  },
});
const ex = () => ({ ok: { value: { name: "Alpha", count: 1, tags: ["a"] } } });
const json = (schema: any, examples: any = ex()) => ({
  content: { "application/json": { schema, ...(examples ? { examples } : {}) } },
});
const getOp = (over: any = {}): any => ({
  operationId: "listItems",
  tags: ["widgets"],
  summary: "List items",
  security: [{ bffSession: [] }],
  "x-permission": "widgets.item.read",
  "x-idempotency": "none",
  "x-rate-limit-tier": "general",
  "x-error-codes": ["common.not_found"],
  responses: { "200": { description: "ok", ...json(itemSchema()) } },
  ...over,
});
const postOp = (over: any = {}): any => ({
  ...getOp({
    operationId: "createItem",
    summary: "Create item",
    "x-permission": "widgets.item.manage",
    "x-idempotency": "required",
    requestBody: { required: true, ...json(itemSchema()) },
    responses: { "201": { description: "created", ...json(itemSchema()) } },
  }),
  ...over,
});
const spec = (paths: any, extra: any = {}): any => ({
  openapi: "3.0.3",
  info: { title: "t", version: "1.0.0" },
  paths,
  components: { securitySchemes: { bffSession: { type: "apiKey", in: "cookie", name: "sid" } } },
  ...extra,
});
const file = (name: string, doc: any) => ({ name, text: typeof doc === "string" ? doc : stringify(doc, { aliasDuplicateObjects: false }) });
const good = (name = "widgets") => spec({ [`/v1/${name}/items`]: { get: getOp({ tags: [name] }) } });
const run = async (files: any[], c: any = ctx) => (await lintOpenapi(files, c)) as { rule: string; file: string; message: string }[];
const rulesOf = (v: { rule: string }[]) => [...new Set(v.map((x) => x.rule))];
async function expectRule(rule: string, files: any[], c: any = ctx) {
  const v = await run(files, c);
  expect(rulesOf(v), JSON.stringify(v)).toContain(rule);
}
const withGet = (over: any, name = "widgets") =>
  spec({ [`/v1/${name}/items`]: { get: getOp({ tags: [name], ...over }) } });
const withSchema = (schema: any) =>
  withGet({ responses: { "200": { description: "ok", ...json(schema) } } });

describe("baseline", () => {
  it("a fully valid spec produces no violations", async () => {
    expect(await run([file("widgets", good())])).toEqual([]);
  });
  it("valid POST with x-idempotency required and valid body produces none", async () => {
    const d = spec({ "/v1/widgets/items": { post: postOp() } });
    expect(await run([file("widgets", d)])).toEqual([]);
  });
});

describe("rule 1 — parse, OAS 3.0 schema, openapi 3.0.3", () => {
  it("rejects unparseable YAML", async () => expectRule("1", [file("widgets", "openapi: [unclosed\n  : :")]));
  it("rejects duplicate map keys", async () =>
    expectRule("1", [file("widgets", "openapi: 3.0.3\nopenapi: 3.0.3\ninfo: {title: t, version: '1'}\npaths: {}\n")]));
  it.each(["3.1.0", "3.0.0", "3.0.4", "2.0"])("rejects openapi %s", async (v) =>
    expectRule("1", [file("widgets", { ...good(), openapi: v })]));
  it("rejects structurally invalid OAS (missing info)", async () => {
    const d: any = good();
    delete d.info;
    await expectRule("1", [file("widgets", d)]);
  });
  it("rejects structurally invalid OAS (response without description)", async () =>
    expectRule("1", [file("widgets", withGet({ responses: { "200": { ...json(itemSchema()) } } }))]));
  it("vendored OAS 3.0 schema exists under tools/codegen/vendor/", () => {
    const dir = resolve(ROOT, "tools/codegen/vendor");
    expect(existsSync(dir), "tools/codegen/vendor must exist").toBe(true);
    expect(readdirSync(dir).filter((f) => /\.(json|ya?ml)$/.test(f)).length).toBeGreaterThan(0);
  });
});

describe("rule 2 — forbidden constructs (CV §4.12)", () => {
  const bad: Record<string, any> = {
    nullable: { type: "string", maxLength: 5, nullable: true },
    "type array": { type: ["string", "null"], maxLength: 5 },
    const: { type: "string", maxLength: 5, const: "a" },
    exclusiveMinimum: { type: "integer", minimum: 0, maximum: 9, exclusiveMinimum: true },
    exclusiveMaximum: { type: "integer", minimum: 0, maximum: 9, exclusiveMaximum: true },
    "example in schema": { type: "string", maxLength: 5, example: "a" },
    not: { not: { type: "string", maxLength: 5 } },
    if: { if: { type: "string", maxLength: 5 }, then: { type: "string", maxLength: 5 }, else: { type: "string", maxLength: 5 } },
    prefixItems: { type: "array", maxItems: 2, prefixItems: [{ type: "string", maxLength: 5 }] },
    $defs: { type: "string", maxLength: 5, $defs: { a: { type: "string", maxLength: 5 } } },
    contentMediaType: { type: "string", maxLength: 5, contentMediaType: "image/png" },
    contentEncoding: { type: "string", maxLength: 5, contentEncoding: "base64" },
  };
  it.each(Object.entries(bad))("rejects %s", async (_n, schema) =>
    expectRule("2", [file("widgets", withSchema({ type: "object", additionalProperties: false, properties: { f: schema } }))]));
  it("rejects $ref with sibling keys", async () =>
    expectRule("2", [file("widgets", withSchema({
      type: "object", additionalProperties: false,
      properties: { f: { $ref: "#/components/schemas/X", description: "sibling" } },
    }))]));
  it("rejects top-level webhooks", async () =>
    expectRule("2", [file("widgets", { ...good(), webhooks: {} })]));
  it("does not flag media-type-level `examples`", async () =>
    expect(rulesOf(await run([file("widgets", good())]))).not.toContain("2"));
});

describe("rule 3 — closed, bounded schemas", () => {
  it("object without additionalProperties: false", async () => {
    const s = itemSchema();
    delete s.additionalProperties;
    await expectRule("3", [file("widgets", withSchema(s))]);
  });
  it("object with additionalProperties: true", async () =>
    expectRule("3", [file("widgets", withSchema({ ...itemSchema(), additionalProperties: true }))]));
  it("nested object without additionalProperties: false", async () => {
    const s = itemSchema();
    s.properties.sub = { type: "object", properties: { a: { type: "string", maxLength: 3 } } };
    await expectRule("3", [file("widgets", withSchema(s))]);
  });
  it("string without maxLength", async () => {
    const s = itemSchema();
    delete s.properties.name.maxLength;
    await expectRule("3", [file("widgets", withSchema(s))]);
  });
  it("array without maxItems", async () => {
    const s = itemSchema();
    delete s.properties.tags.maxItems;
    await expectRule("3", [file("widgets", withSchema(s))]);
  });
  it.each(["minimum", "maximum"])("integer without %s", async (k) => {
    const s = itemSchema();
    delete s.properties.count[k];
    await expectRule("3", [file("widgets", withSchema(s))]);
  });
});

// LD-119 (2026-11-12): rule 3 allowlist, ONE entry: module instruments + operationId getAgentConfig + response 200 + property path `document`
// (LD-78 opaque signed bytes). Exempts only additionalProperties: false; keyed by operation context, never by property name alone.
describe("LD-119 rule 3 allowlist: instruments getAgentConfig 200 `document`", () => {
  const c = { ...ctx, moduleOwners: { ...ctx.moduleOwners, instruments: "C7" } };
  const agentCfg = (opId: string, docProp: string, doc: any, extra: any = {}) =>
    file("instruments", spec({ "/v1/instruments/agent/config": { get: getOp({
      operationId: opId, tags: ["instruments"],
      responses: { "200": { description: "ok", ...json({ type: "object", additionalProperties: false,
        properties: { alg: { type: "string", maxLength: 20 }, [docProp]: doc, ...extra } }) } } }) } }));
  const open = () => ({ type: "object", additionalProperties: true });
  it("exact entry (getAgentConfig, 200, document) accepted", async () =>
    expect(await run([agentCfg("getAgentConfig", "document", open())], c)).toEqual([]));
  it("same open object under another operationId still rejected (rule 3)", async () =>
    expectRule("3", [agentCfg("getOtherConfig", "document", open())], c));
  it("same open object under another property of getAgentConfig still rejected (rule 3)", async () =>
    expectRule("3", [agentCfg("getAgentConfig", "other", open())], c));
  it("the exemption covers only additionalProperties: an unbounded string in `document` is still rejected", async () =>
    expectRule("3", [agentCfg("getAgentConfig", "document", { ...open(), properties: { s: { type: "string" } } })], c));
});

describe("rule 4 — operation metadata", () => {
  it.each(["operationId", "tags", "summary", "security", "x-idempotency", "x-rate-limit-tier", "x-error-codes"])(
    "missing %s", async (k) => {
      const o = getOp();
      delete o[k];
      await expectRule("4", [file("widgets", spec({ "/v1/widgets/items": { get: o } }))]);
    });
  it("neither x-permission nor x-public", async () => {
    const o = getOp();
    delete o["x-permission"];
    await expectRule("4", [file("widgets", spec({ "/v1/widgets/items": { get: o } }))]);
  });
  it("both x-permission and x-public", async () =>
    expectRule("4", [file("widgets", withGet({ "x-public": "pre-auth form" }))]));
  it("x-public alone with justification is accepted", async () => {
    const o = getOp({ "x-public": "pre-auth form" });
    delete o["x-permission"];
    expect(await run([file("widgets", spec({ "/v1/widgets/items": { get: o } }))])).toEqual([]);
  });
  it.each(["", "   "])("x-public with empty justification %j", async (j) => {
    const o = getOp({ "x-public": j });
    delete o["x-permission"];
    await expectRule("4", [file("widgets", spec({ "/v1/widgets/items": { get: o } }))]);
  });
  it("AC-0C-1.5: x-permission not in permissions.yaml", async () =>
    expectRule("4", [file("widgets", withGet({ "x-permission": "widgets.item.nope" }))]));
  it("AC-0C-1.5: x-error-codes code not in errors.yaml", async () =>
    expectRule("4", [file("widgets", withGet({ "x-error-codes": ["common.not_found", "widgets.invented"] }))]));
  it.each(["ListItems", "list_items", "list-items", "1list"])("operationId %s is not lowerCamel", async (id) =>
    expectRule("4", [file("widgets", withGet({ operationId: id }))]));
  it("operationId duplicated across specs", async () => {
    const a = file("widgets", good("widgets"));
    const b = file("gizmos", withGet({ operationId: "listItems" }, "gizmos"));
    await expectRule("4", [a, b]);
  });
  it("tags must be exactly [<module>]", async () =>
    expectRule("4", [file("widgets", withGet({ tags: ["gizmos"] }))]));
  it.each(["sometimes", "REQUIRED", ""])("x-idempotency %j invalid", async (v) =>
    expectRule("4", [file("widgets", withGet({ "x-idempotency": v }))]));
  it("x-rate-limit-tier outside the 7-value set", async () =>
    expectRule("4", [file("widgets", withGet({ "x-rate-limit-tier": "turbo" }))]));
  it.each(["login", "otp_request", "otp_verify", "qr_verify", "report_download", "ingest", "general"])(
    "x-rate-limit-tier %s accepted", async (t) =>
      expect(rulesOf(await run([file("widgets", withGet({ "x-rate-limit-tier": t }))]))).not.toContain("4"));

  describe("P-8 x-idempotency-justification (E1/E2)", () => {
    const post = (over: any) => file("widgets", spec({ "/v1/widgets/items": { post: postOp(over) } }));
    it("POST x-idempotency none without justification", async () =>
      expectRule("4", [post({ "x-idempotency": "none" })]));
    it("justification without E1/E2 prefix", async () =>
      expectRule("4", [post({ "x-idempotency": "none", "x-idempotency-justification": "it is fine" })]));
    it("prefix without trailing space (E1x)", async () =>
      expectRule("4", [post({ "x-idempotency": "none", "x-idempotency-justification": "E1x secret" })]));
    // LD-10 (2026-11-07): E3 = read-only POST, E4 = identity pre-auth/session op (not replayable)
    it.each(["E1 secret shown once", "E2 patient pre-auth OTP POST", "E3 read-only search, no state written",
      "E4 pre-auth session op, response not replayed"])("accepts %j", async (j) =>
      expect(await run([post({ "x-idempotency": "none", "x-idempotency-justification": j })])).toEqual([]));
    it.each(["E5 whatever", "E3x read-only", "E4x session", "E0 nothing", "e3 lowercase", " E4 leading space"])("rejects %j", async (j) =>
      expectRule("4", [post({ "x-idempotency": "none", "x-idempotency-justification": j })]));
    it("GET with x-idempotency none needs no justification", async () =>
      expect(await run([file("widgets", good())])).toEqual([]));
  });

  describe("P-23 error-code owner", () => {
    const withCodes = (codes: string[], name = "widgets", c: any = ctx) =>
      run([file(name, withGet({ "x-error-codes": codes }, name))], c);
    it("module-owner code accepted", async () => expect(await withCodes(["widgets.item_locked"])).toEqual([]));
    it("C0 code accepted in any module", async () => expect(await withCodes(["common.not_found"], "gizmos")).toEqual([]));
    it("auth.* code owned by C2 accepted in any module", async () => expect(await withCodes(["auth.token_expired"], "gizmos")).toEqual([]));
    it("other module's code rejected", async () => expect(rulesOf(await withCodes(["gizmos.broken"]))).toContain("4"));
    it("port-propagated code accepted for a listed consumer of the port", async () =>
      expect(await withCodes(["catalog.price_missing"])).toEqual([]));
    it("port-propagated code rejected for a non-consumer", async () =>
      expect(rulesOf(await withCodes(["catalog.price_missing"], "gizmos"))).toContain("4"));
    it("consumer list drives acceptance (consumer removed -> rejected)", async () =>
      expect(rulesOf(await withCodes(["catalog.price_missing"], "widgets", { ...ctx, portConsumers: { CatalogPort: [] } }))).toContain("4"));
  });

  describe("examples", () => {
    it("missing response example", async () =>
      expectRule("4", [file("widgets", withGet({ responses: { "200": { description: "ok", ...json(itemSchema(), null) } } }))]));
    it("body present but request example missing", async () =>
      expectRule("4", [file("widgets", spec({ "/v1/widgets/items": { post: postOp({
        requestBody: { required: true, ...json(itemSchema(), null) } }) } }))]));
    it("no body -> no request example needed", async () =>
      expect(await run([file("widgets", good())])).toEqual([]));
  });
});

describe("rule 5 — paths", () => {
  it("path outside /v1/<module>/", async () =>
    expectRule("5", [file("widgets", spec({ "/v1/gizmos/items": { get: getOp() } }))]));
  it("path without /v1 prefix", async () =>
    expectRule("5", [file("widgets", spec({ "/widgets/items": { get: getOp() } }))]));
  it("prefix must match whole segment (/v1/widgetsx/)", async () =>
    expectRule("5", [file("widgets", spec({ "/v1/widgetsx/items": { get: getOp() } }))]));
  it.each(["barcode", "registration_no", "invoice_no", "phone"])("path parameter {%s} (REQ-SEC-098)", async (p) =>
    expectRule("5", [file("widgets", spec({ [`/v1/widgets/items/{${p}}`]: { get: getOp({
      parameters: [{ name: p, in: "path", required: true, schema: { type: "string", maxLength: 40 } }] }) } }))]));
  it("uuid path parameter accepted", async () =>
    expect(await run([file("widgets", spec({ "/v1/widgets/items/{id}": { get: getOp({
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid", maxLength: 36 } }] }) } }))])).toEqual([]));
});

describe("rule 6 — coded sets vs enum", () => {
  const prop = (p: any) => withSchema({ type: "object", additionalProperties: false, properties: { f: p } });
  it("x-coded-set field accepted", async () =>
    expect(await run([file("widgets", prop({ type: "string", maxLength: 20, "x-coded-set": "sample_type" }))])).toEqual([]));
  it("x-coded-set together with enum rejected", async () =>
    expectRule("6", [file("widgets", prop({ type: "string", maxLength: 20, "x-coded-set": "sample_type", enum: ["a", "b"] }))]));
  it("closed-flag / status enum accepted", async () =>
    expect(rulesOf(await run([file("widgets", prop({ type: "string", maxLength: 10, enum: ["open", "closed"] }))]))).not.toContain("6"));
  it("x-extensible: true enum accepted", async () =>
    expect(rulesOf(await run([file("widgets", prop({ type: "string", maxLength: 10, enum: ["a"], "x-extensible": true }))]))).not.toContain("6"));
});

describe("rule 7 — server-authority fields in request bodies (CV §4.7)", () => {
  const body = (extraProp: string) => {
    const s = itemSchema();
    s.properties[extraProp] = { type: "string", maxLength: 40 };
    return file("widgets", spec({ "/v1/widgets/items": { post: postOp({ requestBody: { required: true, ...json(s) } }) } }));
  };
  it.each(["tenant_id", "created_by", "updated_by", "status"])("request body declaring %s", async (p) =>
    expectRule("7", [body(p)]));
  it("nested request property named tenant_id", async () => {
    const s = itemSchema();
    s.properties.sub = { type: "object", additionalProperties: false, properties: { tenant_id: { type: "string", maxLength: 36 } } };
    await expectRule("7", [file("widgets", spec({ "/v1/widgets/items": { post: postOp({ requestBody: { required: true, ...json(s) } }) } }))]);
  });
  // LD-11 (2026-11-07): tenant_id in request bodies is allowed ONLY for x-context: platform operations
  describe("LD-11 platform tenant_id exemption", () => {
    const withCtx = (ctxVal: string | undefined, prop = "tenant_id") => {
      const s = itemSchema();
      s.properties[prop] = { type: "string", maxLength: 36 };
      const o = postOp({ requestBody: { required: true, ...json(s) } });
      if (ctxVal) o["x-context"] = ctxVal;
      return file("widgets", spec({ "/v1/widgets/items": { post: o } }));
    };
    it("platform op: tenant_id in body accepted", async () => expect(await run([withCtx("platform")])).toEqual([]));
    it.each(["tenant", "identity_auth", undefined])("x-context %s: tenant_id still rejected (rule 7)", async (c) =>
      expectRule("7", [withCtx(c)]));
    it.each(["created_by", "updated_by", "status"])("platform op: %s still rejected", async (p) =>
      expectRule("7", [withCtx("platform", p)]));
    it("platform op via $ref requestBody: tenant_id accepted", async () => {
      const s = itemSchema();
      s.properties.tenant_id = { type: "string", maxLength: 36 };
      const o = postOp({ requestBody: { $ref: "#/components/requestBodies/ItemBody" }, "x-context": "platform" });
      const f = file("widgets", spec({ "/v1/widgets/items": { post: o } }, { components: {
        securitySchemes: { bffSession: { type: "apiKey", in: "cookie", name: "sid" } },
        requestBodies: { ItemBody: { required: true, ...json(s) } } } }));
      expect(rulesOf(await run([f]))).not.toContain("7");
    });
  });
  it("PATCH body declaring status on a non-action path", async () => {
    const s = itemSchema();
    s.properties.status = { type: "string", maxLength: 10 };
    await expectRule("7", [file("widgets", spec({ "/v1/widgets/items/{id}": { patch: postOp({
      operationId: "updateItem", "x-idempotency": "optional",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", maxLength: 36 } }],
      requestBody: { required: true, ...json(s) } }) } }))]);
  });
  // LD-118 (2026-11-12, ruling: C17 TRD 6.3 puts gps in payload): ONE allowlisted path: pushSyncMutations (homecollection.yaml) payload.gps.status; keyed by operationId + property path
  describe("LD-118 payload.gps.status allowlist", () => {
    const syncBody = (opId: string, payload: any, root: any = {}) => {
      const s = itemSchema();
      s.properties.payload = payload;
      Object.assign(s.properties, root);
      return file("homecollection", spec({ "/v1/homecollection/sync/mutations": { post: postOp({
        operationId: opId, tags: ["homecollection"], requestBody: { required: true, ...json(s) } }) } }));
    };
    const gps = (extra: any = {}) => ({ type: "object", additionalProperties: false, properties: {
      gps: { type: "object", additionalProperties: false, properties: { status: { type: "string", maxLength: 12, enum: ["off", "denied", "unavailable", "ok"] }, ...extra } } } });
    const sev = async (f: any) => rulesOf(await run([f]));
    it("pushSyncMutations payload.gps.status accepted (no rule 7)", async () =>
      expect(await sev(syncBody("pushSyncMutations", gps()))).not.toContain("7"));
    it("same path under a different operationId rejected", async () =>
      expect(await sev(syncBody("pushOtherMutations", gps()))).toContain("7"));
    it("unrelated nested status in pushSyncMutations rejected", async () => {
      const c = { type: "object", additionalProperties: false, properties: { other: { type: "object", additionalProperties: false,
        properties: { status: { type: "string", maxLength: 12 } } } } };
      expect(await sev(syncBody("pushSyncMutations", c))).toContain("7");
    });
    it("root status in pushSyncMutations still rejected", async () =>
      expect(await sev(syncBody("pushSyncMutations", gps(), { status: { type: "string", maxLength: 12 } }))).toContain("7"));
    it("payload.gps.status plus a sibling status under payload still rejected", async () => {
      const c = gps(); c.properties.status = { type: "string", maxLength: 12 };
      expect(await sev(syncBody("pushSyncMutations", c))).toContain("7");
    });
  });
  // review T0C-04 item 1: $ref requestBody must not bypass rules 4 / 7
  const refSpec = (rb: any) => file("widgets", spec(
    { "/v1/widgets/items": { post: postOp({ requestBody: { $ref: "#/components/requestBodies/ItemBody" } }) } },
    { components: {
      securitySchemes: { bffSession: { type: "apiKey", in: "cookie", name: "sid" } },
      requestBodies: { ItemBody: rb },
    } }));
  it("$ref requestBody with tenant_id -> rule 7", async () => {
    const s = itemSchema();
    s.properties.tenant_id = { type: "string", maxLength: 36 };
    await expectRule("7", [refSpec({ required: true, ...json(s) })]);
  });
  it("$ref requestBody without example -> rule 4", async () =>
    expectRule("4", [refSpec({ required: true, ...json(itemSchema(), null) })]));
  it("$ref requestBody, clean schema + example -> no violations", async () =>
    expect(await run([refSpec({ required: true, ...json(itemSchema()) })])).toEqual([]));
  it("same names in RESPONSE bodies are fine", async () => {
    const s = itemSchema();
    s.properties.tenant_id = { type: "string", maxLength: 36 };
    s.properties.status = { type: "string", maxLength: 10 };
    expect(await run([file("widgets", withSchema(s))])).toEqual([]);
  });
});

describe("rule 8 / D-212 — x-context: identity_auth", () => {
  const OPS = ["loginStaff", "loginPartner", "openMobileSession", "refreshMobileSession", "logoutMobileSession", "confirmEmailToken",
    "requestPasswordRecovery", "verifyMfaChallenge", "startMfaEnrolment", "completeMfaEnrolment", "resolveSession", "logoutSession",
    "setPasswordFromSetup", "resolvePatientSession", "logoutPatientSession"];
  const idOp = (over: any = {}) => {
    const o = getOp({ operationId: "loginStaff", tags: ["identity"], "x-context": "identity_auth", "x-public": "pre-auth login", ...over });
    delete o["x-permission"];
    if (over["x-permission"]) o["x-permission"] = over["x-permission"];
    return o;
  };
  const idFile = (o: any, name = "identity") => file(name, spec({ [`/v1/${name}/login`]: { get: { ...o, tags: [name] } } }));
  it("allowed op in identity.yaml with x-public accepted", async () => expect(await run([idFile(idOp())])).toEqual([]));
  it.each(OPS)("all 15 allowlisted ops accepted: %s", async (id) =>
    expect(rulesOf(await run([idFile(idOp({ operationId: id }))]))).not.toContain("8"));
  it("op not on the allowlist rejected", async () =>
    expectRule("8", [idFile(idOp({ operationId: "listUsers" }))]));
  it("identity_auth outside identity.yaml rejected", async () =>
    expectRule("8", [idFile(idOp(), "reporting")]));
  it("identity_auth without x-public rejected", async () =>
    expectRule("8", [idFile(idOp({ "x-public": undefined, "x-permission": "identity.session.manage" }))]));
  it("identity_auth with empty x-public justification rejected", async () =>
    expectRule("8", [idFile(idOp({ "x-public": "" }))]));
  it("x-context other than tenant|platform|identity_auth rejected", async () =>
    expectRule("8", [file("widgets", withGet({ "x-context": "root" }))]));
  it.each(["tenant", "platform"])("x-context %s accepted", async (c) =>
    expect(rulesOf(await run([file("widgets", withGet({ "x-context": c }))]))).not.toContain("8"));
});

describe("AB-20 / 07-SECURITY — no PHI-shaped data in examples", () => {
  const withEx = (v: any) => file("widgets", withGet({ responses: { "200": { description: "ok", ...json(itemSchema(), { ok: { value: v } }) } } }));
  it("Nepali-mobile-shaped number", async () => expectRule("AB-20", [withEx({ name: "9841234567" })]));
  it("+977 phone", async () => expectRule("AB-20", [withEx({ name: "+977-9841234567" })]));
  it("email address", async () => expectRule("AB-20", [withEx({ name: "someone@example.com" })]));
});

describe("real repo contracts (T0C-04 deliverables)", () => {
  const dir = resolve(ROOT, "contracts/openapi");
  it("_common.yaml defines the exact components of TRD §5.1", () => {
    const p = resolve(dir, "_common.yaml");
    expect(existsSync(p), "contracts/openapi/_common.yaml must exist").toBe(true);
    const d: any = parse(readFileSync(p, "utf8"), { strict: true, uniqueKeys: true });
    expect(d.openapi).toBe("3.0.3");
    const c = d.components;
    const names = (o: any) => Object.keys(o ?? {}).sort();
    const has = (o: any, want: string[]) => expect(names(o)).toEqual(expect.arrayContaining(want));
    has(c.schemas, ["Problem", "FieldError", "Uuid", "Uuidv7", "IsoUtc", "IsoDate", "DecimalString", "Code", "Money", "PageInfo", "Version"]);
    has(c.parameters, ["IdempotencyKey", "IfMatch", "Limit", "Cursor", "RequestId", "Traceparent"]);
    has(c.responses, ["BadRequest", "Unauthorized", "Forbidden", "NotFound", "Conflict", "PreconditionRequired", "PayloadTooLarge",
      "UnsupportedMediaType", "Unprocessable", "TooManyRequests", "Internal", "ServiceUnavailable"]);
    has(c.headers, ["RetryAfter", "IdempotentReplayed", "Deprecation", "Sunset"]);
    has(c.securitySchemes, ["bffSession", "bearerJwt", "deviceToken", "queueDisplayToken", "portalSession", "patientPreAuth", "paymentCallbackToken"]);
    expect(c.schemas.Problem.additionalProperties).toBe(false);
    expect(c.parameters.IdempotencyKey.schema.pattern).toBe("^[A-Za-z0-9_-]{1,64}$");
    expect(c.parameters.Limit.schema).toMatchObject({ minimum: 1, maximum: 200, default: 50 });
    expect(c.parameters.Cursor.schema.maxLength).toBe(512);
    expect(c.responses.TooManyRequests.headers).toHaveProperty("Retry-After");
    for (const r of Object.values<any>(c.responses)) expect(r.content).toHaveProperty("application/problem+json");
  });
  it("core.yaml exists, is 3.0.3, paths under /v1/core/", () => {
    const p = resolve(dir, "core.yaml");
    expect(existsSync(p), "contracts/openapi/core.yaml must exist").toBe(true);
    const d: any = parse(readFileSync(p, "utf8"), { strict: true, uniqueKeys: true });
    expect(d.openapi).toBe("3.0.3");
    for (const k of Object.keys(d.paths)) expect(k.startsWith("/v1/core/"), k).toBe(true);
  });
  it("lintRepo(contracts/openapi/*.yaml) is clean against real permissions.yaml / errors.yaml", async () => {
    expect(await lintRepo(ROOT)).toEqual([]);
  });
});
