import Ajv from "ajv-draft-04";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { it, expect } from "vitest";
it("ajv ptr", () => {
  const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
  const common = parse(readFileSync("C:/LIMS-lanes/C0-0C/contracts/openapi/_common.yaml", "utf8"));
  const doc = parse(readFileSync("C:/LIMS-lanes/C0-0C/contracts/openapi/core.yaml", "utf8"));
  doc.components.schemas.X = { type: "object", additionalProperties: false, properties: { p: { $ref: "_common.yaml#/components/schemas/Problem" } } };
  ajv.addSchema({ ...common, id: "_common.yaml" }); ajv.addSchema({ ...doc, id: "identity.yaml" });
  const v = ajv.getSchema("identity.yaml#/paths/~1v1~1core~1health~1ready/get/responses/200/content/application~1json/schema")!;
  expect(v({ status: "ok", checks: { db: "ok", ratelimit: "ok" } })).toBe(true);
  expect(v({ status: "bad" })).toBe(false);
  const x = ajv.getSchema("identity.yaml#/components/schemas/X")!;
  expect(x({ p: { foo: 1 } })).toBe(false);
});
