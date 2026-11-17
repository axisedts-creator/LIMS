// T0C-LINTFIX-1 (LD-332; founder blanket authority LD-310): repo wide OpenAPI lint debt left on main.
//  - contracts/openapi/core.yaml Readiness.missing_env needs maxItems and items.maxLength (lint rule 3), chosen from the real data:
//    the names REQUIRED_ENV in services/api/src/core/health.ts can list (count and longest), rounded up, not absurdly large.
//  - contracts/openapi/identity.yaml listRolePacks / applyRolePack need examples (lint rule 4): response example for both, request example
//    for applyRolePack; each valid against its own schema, synthetic data only.
//  - nothing else changes: the pins below fail if the fix widens or drops anything, lintRepo(root) is empty, generated files are fresh.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const load = (f: string): any => parse(readFileSync(join(ROOT, "contracts/openapi", f), "utf8"));
const core = load("core.yaml");
const identity = load("identity.yaml");
const common = load("_common.yaml");
const missingEnv = core.components.schemas.Readiness.properties.missing_env ?? {};

// the real data: every LIMS_* name in the REQUIRED_ENV literal of health.ts plus the storage name it imports
const healthSrc = readFileSync(join(ROOT, "services/api/src/core/health.ts"), "utf8");
const listSrc = /REQUIRED_ENV: readonly string\[\] = Object\.freeze\(\[([\s\S]*?)\]\.sort\(\)\)/.exec(healthSrc)?.[1] ?? "";
const storage = /STORAGE_KEY_ENV = '([A-Z0-9_]+)'/.exec(readFileSync(join(ROOT, "services/api/src/core/storage/env.ts"), "utf8"))?.[1];
const REAL_NAMES = [...(listSrc.match(/'(LIMS_[A-Z0-9_]+)'/g) ?? []).map((s) => s.slice(1, -1)), ...(storage ? [storage] : [])];

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ ...common, id: "_common.yaml" });
ajv.addSchema({ ...identity, id: "identity.yaml" });
const examplesOf = (media: any): Array<[string, unknown]> => [
  ...(media?.example !== undefined ? [["example", media.example] as [string, unknown]] : []),
  ...Object.entries<any>(media?.examples ?? {}).map(([k, e]) => [k, e?.value] as [string, unknown]),
];
const op = (path: string, method: string): any => identity.paths[path]?.[method] ?? {};
const checkExamples = (media: any, label: string) => {
  const ex = examplesOf(media);
  expect(ex.length, `${label}: at least one example`).toBeGreaterThanOrEqual(1);
  const v = ajv.compile(media.schema);
  for (const [k, value] of ex) expect(v(value), `${label}/${k}: ${JSON.stringify(v.errors?.[0])}`).toBe(true);
};

describe("T0C-LINTFIX-1: Readiness.missing_env bounds (rule 3, LD-332)", () => {
  it("the real data was found: at least 20 required names, all LIMS_*", () => {
    expect(REAL_NAMES.length).toBeGreaterThanOrEqual(20);
    for (const n of REAL_NAMES) expect(n).toMatch(/^LIMS_[A-Z0-9_]*[A-Z0-9]$/);
  });
  it("missing_env has maxItems: a number that covers every required name, not absurd (<= 256)", () => {
    expect(typeof missingEnv.maxItems, "maxItems missing").toBe("number");
    expect(missingEnv.maxItems).toBeGreaterThanOrEqual(REAL_NAMES.length);
    expect(missingEnv.maxItems).toBeLessThanOrEqual(256);
  });
  it("missing_env items have maxLength: covers the longest required name, not absurd (<= 256)", () => {
    expect(typeof missingEnv.items?.maxLength, "items.maxLength missing").toBe("number");
    expect(missingEnv.items.maxLength).toBeGreaterThanOrEqual(Math.max(...REAL_NAMES.map((n) => n.length)));
    expect(missingEnv.items.maxLength).toBeLessThanOrEqual(256);
  });
  it("everything else on missing_env and Readiness is unchanged (pattern, string, optional, closed, required)", () => {
    const r = core.components.schemas.Readiness;
    expect(missingEnv.type).toBe("array");
    expect(missingEnv.items.type).toBe("string");
    expect(missingEnv.items.pattern).toBe("^LIMS_[A-Z0-9_]*[A-Z0-9]$");
    expect(r.required).toEqual(["status", "checks"]);
    expect(r.additionalProperties).toBe(false);
    expect(Object.keys(r.properties).sort()).toEqual(["checks", "missing_env", "status"]);
  });
  it("a full list of every required name is valid against the bounded schema, one more than maxItems is not", () => {
    const v = ajv.compile(missingEnv);
    expect(v(REAL_NAMES)).toBe(true);
    expect(v(Array.from({ length: missingEnv.maxItems + 1 }, () => "LIMS_X"))).toBe(false);
    expect(v(["LIMS_" + "A".repeat(missingEnv.items.maxLength)])).toBe(false);
  });
});

describe("T0C-LINTFIX-1: role pack examples (rule 4, LD-332)", () => {
  const LIST = "/v1/identity/role-packs";
  const APPLY = "/v1/identity/role-packs/apply";
  it("listRolePacks has a 200 response example valid against its schema", () => {
    expect(op(LIST, "get").operationId).toBe("listRolePacks");
    checkExamples(op(LIST, "get").responses?.["200"]?.content?.["application/json"], "listRolePacks 200");
  });
  it("applyRolePack has a request example and a 200 response example valid against their schemas", () => {
    expect(op(APPLY, "post").operationId).toBe("applyRolePack");
    checkExamples(op(APPLY, "post").requestBody?.content?.["application/json"], "applyRolePack request");
    checkExamples(op(APPLY, "post").responses?.["200"]?.content?.["application/json"], "applyRolePack 200");
  });
  it("examples are synthetic: no e-mail, phone-shaped number or real-looking name field", () => {
    const text = JSON.stringify([
      examplesOf(op(LIST, "get").responses?.["200"]?.content?.["application/json"]),
      examplesOf(op(APPLY, "post").requestBody?.content?.["application/json"]),
      examplesOf(op(APPLY, "post").responses?.["200"]?.content?.["application/json"]),
    ]);
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/\+?\d{8,}/);
  });
  it("both operations keep their contract (ids, permission, idempotency, status codes, schemas unchanged)", () => {
    const l = op(LIST, "get"), a = op(APPLY, "post");
    expect(l["x-permission"]).toBe("identity.role.manage");
    expect(l["x-idempotency"]).toBe("none");
    expect(Object.keys(l.responses).sort()).toEqual(["200", "401", "403", "429", "500"]);
    expect(a["x-permission"]).toBe("identity.role.manage");
    expect(a["x-idempotency"]).toBe("required");
    expect(a["x-error-codes"]).toEqual(["common.validation_failed"]);
    expect(Object.keys(a.responses).sort()).toEqual(["200", "400", "401", "403", "409", "422", "429", "500"]);
    const req = a.requestBody.content["application/json"].schema;
    expect(req.required).toEqual(["pack_code"]);
    expect(req.additionalProperties).toBe(false);
    expect(a.responses["200"].content["application/json"].schema.required).toEqual(["pack_code", "created", "updated", "unchanged"]);
    expect(l.responses["200"].content["application/json"].schema.required).toEqual(["data"]);
  });
});

describe("T0C-LINTFIX-1: repo wide lint and generated files", () => {
  it("lintRepo(root) is empty: the 5 violations (core rule 3 x2, identity rule 4 x3) are gone", async () => {
    expect(await lintRepo(ROOT)).toEqual([]);
  }, 300_000);
  it("the lint rules and the lint tool are untouched: the 5 original messages still exist as rules", () => {
    const src = readFileSync(join(ROOT, "tools/codegen/lint-openapi.ts"), "utf8");
    for (const m of ["array needs maxItems", "string needs maxLength", "needs at least one response example", "request body needs at least one example"])
      expect(src, m).toContain(m);
  });
  it("generated contract types are fresh (staleFiles empty)", () => {
    expect(existsSync(join(ROOT, "packages/api-client-ts/src/core.ts"))).toBe(true);
    expect(staleFiles(ROOT)).toEqual([]);
  }, 300_000);
});
