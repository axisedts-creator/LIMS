// T0C-ACCTFIX-1 (CR-C0-ACCT-2, LD-334): the daily collection summary is the SIGNED NET per payment mode
// (it must match getDailyCash, which nets refunds and reversals by business date), so the contract allows negative values.
// Option (a) of the CR: no clamping, no handler change. Convention X10: no nullable, no type arrays.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const bl: any = parse(readFileSync(join(ROOT, "contracts/openapi/billing.yaml"), "utf8"));
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const BS = bl.components.schemas as Record<string, any>;
const ROW = BS.DailyCollectionRow;
const SUM = BS.DailyCollectionSummary;
const OP = bl.paths["/v1/billing/daily-collection-summary"].get;
const OK = OP.responses["200"].content["application/json"];

const MIN_COUNT = -2147483648;
const MAX_COUNT = 2147483647;
const MIN_PAISA = -9007199254740991;
const MAX_PAISA = 9007199254740991;

// inline every $ref so one Ajv compile validates an example against the real schema
const inline = (n: any): any => {
  if (Array.isArray(n)) return n.map(inline);
  if (!n || typeof n !== "object") return n;
  if (typeof n.$ref === "string") {
    const name = n.$ref.split("/").pop()!;
    return inline(n.$ref.startsWith("_common.yaml#") ? common.components.schemas[name] : BS[name]);
  }
  return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, inline(v)]));
};
const validate = new Ajv({ strict: false, validateFormats: false, allErrors: true }).compile(inline(SUM));

const FIELDS: [string, any, number, number][] = [
  ["DailyCollectionRow.entry_count", ROW.properties.entry_count, MIN_COUNT, MAX_COUNT],
  ["DailyCollectionRow.total_paisa", ROW.properties.total_paisa, MIN_PAISA, MAX_PAISA],
  ["DailyCollectionSummary.total_paisa", SUM.properties.total_paisa, MIN_PAISA, MAX_PAISA],
];

describe("T0C-ACCTFIX-1 bounds: signed net is allowed (LD-334)", () => {
  for (const [name, p, min, max] of FIELDS) {
    it(`${name}: integer, minimum ${min} (below 0), maximum ${max} unchanged`, () => {
      expect(p.type).toBe("integer");
      expect(p.minimum, "minimum allows negative").toBeLessThan(0);
      expect(p.minimum).toBe(min);
      expect(p.maximum, "maximum unchanged").toBe(max);
    });
    it(`${name}: description says net of refunds and reversals, negative when refunds exceed collections`, () => {
      expect(p.description, "description").toMatch(/net of refunds and reversals/i);
      expect(p.description).toMatch(/negative/i);
      expect(p.description).toMatch(/refunds exceed collections/i);
    });
    it(`${name}: no nullable, no type array (X10)`, () => {
      expect(p.nullable).toBeUndefined();
      expect(Array.isArray(p.type)).toBe(false);
    });
  }
  it("the two total_paisa fields stay int64", () => {
    expect(ROW.properties.total_paisa.format).toBe("int64");
    expect(SUM.properties.total_paisa.format).toBe("int64");
  });
  it("DailyCollectionRow itself says net of refunds and reversals, negative when refunds exceed collections", () => {
    expect(ROW.description).toMatch(/net of refunds and reversals/i);
    expect(ROW.description).toMatch(/negative/i);
  });
  it("nothing else changed: closed objects, same required lists, rows maxItems kept", () => {
    expect(ROW.additionalProperties).toBe(false);
    expect(SUM.additionalProperties).toBe(false);
    expect([...ROW.required].sort()).toEqual(["entry_count", "payment_mode", "total_paisa"]);
    expect([...SUM.required].sort()).toEqual(["centre_id", "day", "rows", "total_paisa"]);
    expect(SUM.properties.rows.maxItems).toBe(100);
    expect(ROW.properties.payment_mode.pattern).toBe("^[a-z][a-z0-9_]{0,49}$");
  });
});

describe("T0C-ACCTFIX-1 examples of getDailyCollectionSummary", () => {
  const ex: Record<string, any> = OK.examples;
  it("keeps the existing synthetic example and adds refund_only_day", () => {
    expect(Object.keys(ex)).toContain("synthetic");
    expect(Object.keys(ex)).toContain("refund_only_day");
  });
  it("every example validates against the schema and total_paisa = sum of the rows", () => {
    for (const [k, e] of Object.entries(ex)) {
      expect(validate(e.value), `${k}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(e.value.rows.reduce((a: number, r: any) => a + r.total_paisa, 0), `${k}: total = sum of rows`).toBe(e.value.total_paisa);
    }
  });
  it("refund_only_day: one payment mode row, negative entry_count, negative total_paisa, negative day total", () => {
    const v = ex.refund_only_day.value;
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].entry_count).toBeLessThan(0);
    expect(v.rows[0].total_paisa).toBeLessThan(0);
    expect(v.total_paisa).toBe(v.rows[0].total_paisa);
    expect(v.total_paisa).toBeLessThan(0);
  });
  it("the schema rejects out of range values (the bounds are not removed)", () => {
    const base = ex.refund_only_day.value;
    expect(validate({ ...base, total_paisa: MAX_PAISA + 2 })).toBe(false);
    expect(validate({ ...base, rows: [{ ...base.rows[0], entry_count: MAX_COUNT + 1 }] })).toBe(false);
    expect(validate({ ...base, rows: [{ ...base.rows[0], entry_count: MIN_COUNT - 1 }] })).toBe(false);
    expect(validate({ ...base, rows: [{ ...base.rows[0], entry_count: 1.5 }] })).toBe(false);
  });
});

describe("T0C-ACCTFIX-1 repo gates", () => {
  it("lintRepo of the root is empty (no lint rule was touched or broken)", async () => {
    expect(await lintRepo(ROOT)).toEqual([]);
  });
});
