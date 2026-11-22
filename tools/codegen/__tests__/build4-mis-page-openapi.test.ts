// T0D-BUILD-4 (LD-447; founder order 2026-11-22 13:36 NPT; closes CR item 8 of .orchestra/notes/T0D-MISREPORTS-1-cr-needed.md): ONE additive operation in contracts/openapi/analytics.yaml,
// getMisReportPage = GET /v1/analytics/mis-reports/{report_code}, the HTTP read of the 11 MIS report definitions (x-report-definitions) with rows, totals and paging.
// PINNED PICKS (the brief fixes names and limits; the shapes below follow runMisReport and may be disputed through the reviewer):
//  - path /v1/analytics/mis-reports/{report_code}, GET, tag analytics, bearerJwt, x-context tenant, x-idempotency none, ONE existing analytics.* x-permission (no new permission, no new error code).
//  - report_code is a path ENUM equal to the codes of x-report-definitions (brief: "report_code enum = the x-report-definitions codes"; lint rule 6 must accept it for a closed list of this root extension).
//  - query: business_date_from + business_date_to REQUIRED (date, inclusive); centre_id list <= 20 (form, explode false, Uuid items, same style as the other analytics lists); the definition params with the names
//    ExportParams.filters uses (party_id, representative_id, referrer_id, department_id, collector_id uuid lists <= 20; visit_type opd|ipd; min_repeat_count integer >= 2); limit 1..200 default 50; cursor opaque string.
//  - 200 body: columns [{ key, label, kind }], rows [object], totals (object of integers), next_cursor (string; absent on the last page); closed objects (no open object).
//  - additive: the 30 original operations are byte for byte the ones of the merge base with main; permissions.yaml, errors.yaml untouched by this task are checked by their own suites.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const A: any = parse(read("contracts/openapi/analytics.yaml"));
const ERR: any = parse(read("contracts/errors.yaml"));
const METHODS = ["get", "put", "post", "delete", "patch"];
const OP = "getMisReportPage";
const PATH = "/v1/analytics/mis-reports/{report_code}";
const ANALYTICS_PERMS = ["analytics.collections.read", "analytics.dashboard.read", "analytics.data.export", "analytics.referral_report.read", "analytics.schedule.manage"];

const opsOf = (doc: any): Record<string, { path: string; method: string; op: any }> => {
  const out: Record<string, { path: string; method: string; op: any }> = {};
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) for (const m of METHODS) if (item[m]) out[item[m].operationId] = { path, method: m, op: item[m] };
  return out;
};
const ops = opsOf(A);
const deref = (n: any, doc: any = A): any => {
  if (n && typeof n === "object" && typeof n.$ref === "string" && n.$ref.startsWith("#/")) return deref(n.$ref.slice(2).split("/").reduce((x: any, k: string) => x?.[k], doc), doc);
  return n;
};
const mis = ops[OP];
const param = (name: string): any => (mis?.op.parameters ?? []).map((p: any) => deref(p)).find((p: any) => p.name === name);
const body200 = (): any => deref(deref(mis!.op.responses["200"]).content["application/json"].schema);
const defs: { code: string; permission: string }[] = A["x-report-definitions"];

describe("T0D-BUILD-4 contract: getMisReportPage", () => {
  it("the operation exists once, at GET /v1/analytics/mis-reports/{report_code}", () => {
    expect(mis, `operation ${OP} missing from analytics.yaml`).toBeDefined();
    expect(mis!.path).toBe(PATH);
    expect(mis!.method).toBe("get");
    expect(Object.values(opsOf(A)).filter((o) => o.path === PATH)).toHaveLength(1);
  });

  it("is ADDITIVE: the 30 original operations are unchanged against the merge base with main, and this is the only new operation", () => {
    const base = execFileSync("git", ["merge-base", "HEAD", "main"], { cwd: ROOT, encoding: "utf8" }).trim();
    const old: any = parse(execFileSync("git", ["show", `${base}:contracts/openapi/analytics.yaml`], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
    const was = opsOf(old);
    const now = opsOf(A);
    expect(Object.keys(was)).toHaveLength(30);
    const added = Object.keys(now).filter((k) => !(k in was));
    expect(added).toEqual([OP]);
    for (const [id, o] of Object.entries(was)) expect(JSON.stringify(now[id]), `${id} changed`).toBe(JSON.stringify(o));
    expect(JSON.stringify(A["x-report-definitions"])).toBe(JSON.stringify(old["x-report-definitions"]));
  });

  it("security headers: tag analytics, bearerJwt, tenant context, no idempotency key, general rate tier, one EXISTING analytics permission (no new permission)", () => {
    const o = mis!.op;
    expect(o.tags).toEqual(["analytics"]);
    expect(o.security).toEqual([{ bearerJwt: [] }]);
    expect(o["x-context"]).toBe("tenant");
    expect(o["x-idempotency"]).toBe("none");
    expect(o["x-rate-limit-tier"]).toBe("general");
    expect(ANALYTICS_PERMS).toContain(o["x-permission"]);
    expect(o["x-public"]).toBeUndefined();
    const registry: any = parse(read("contracts/permissions.yaml"));
    expect(JSON.stringify(registry)).not.toMatch(/mis_report|mis\.read|bill_of_the_day/);
  });

  it("report_code: required path parameter, enum equal to the codes of x-report-definitions", () => {
    const p = param("report_code");
    expect(p, "path parameter report_code").toBeDefined();
    expect(p.in).toBe("path");
    expect(p.required).toBe(true);
    const e = deref(p.schema).enum as string[] | undefined;
    expect(e, "report_code enum").toBeDefined();
    expect([...e!].sort()).toEqual(defs.map((d) => d.code).sort());
    expect(defs.map((d) => d.code)).toContain("bill_of_the_day");
  });

  it("business_date_from and business_date_to: required query dates", () => {
    for (const n of ["business_date_from", "business_date_to"]) {
      const p = param(n);
      expect(p, n).toBeDefined();
      expect(p.in).toBe("query");
      expect(p.required, `${n} required`).toBe(true);
      const s = deref(p.schema);
      expect(s.type).toBe("string");
      expect(s.format === "date" || typeof s.pattern === "string", `${n} is a date`).toBe(true);
    }
  });

  it("centre_id and the id filters: uuid lists of at most 20, form style, explode false (same as the other analytics lists)", () => {
    for (const n of ["centre_id", "party_id", "representative_id", "referrer_id", "department_id", "collector_id"]) {
      const p = param(n);
      expect(p, n).toBeDefined();
      expect(p.in).toBe("query");
      expect(p.required ?? false).toBe(false);
      expect(p.style).toBe("form");
      expect(p.explode).toBe(false);
      const s = deref(p.schema);
      expect(s.type).toBe("array");
      expect(s.maxItems).toBe(20);
      expect(JSON.stringify(s.items)).toMatch(/Uuid/);
    }
  });

  it("visit_type is opd | ipd and min_repeat_count an integer of at least 2; both optional", () => {
    const v = param("visit_type"), m = param("min_repeat_count");
    expect(v).toBeDefined(); expect(m).toBeDefined();
    expect([...deref(v.schema).enum].sort()).toEqual(["ipd", "opd"]);
    expect(deref(m.schema).type).toBe("integer");
    expect(deref(m.schema).minimum).toBe(2);
    expect(v.required ?? false).toBe(false); expect(m.required ?? false).toBe(false);
  });

  it("limit is an integer 1..200 with default 50; cursor is an opaque string with a length cap", () => {
    const l = deref(param("limit")?.schema);
    expect(l, "limit").toBeDefined();
    expect(l).toMatchObject({ type: "integer", minimum: 1, maximum: 200, default: 50 });
    const c = deref(param("cursor")?.schema);
    expect(c, "cursor").toBeDefined();
    expect(c.type).toBe("string");
    expect(typeof c.maxLength).toBe("number");
    expect(c.maxLength).toBeLessThanOrEqual(512);
  });

  it("no parameter that could carry PHI (no name, phone, email, barcode, patient id, free text query)", () => {
    const names = (mis!.op.parameters ?? []).map((p: any) => deref(p).name);
    for (const bad of ["name", "query", "q", "phone", "phone_e164", "email", "patient_id", "patient_name", "barcode", "registration_no", "full_name"]) expect(names).not.toContain(bad);
  });

  it("200 body: columns [{key,label,kind}], rows, totals (integers) and next_cursor, in closed objects; columns, rows and totals required", () => {
    const b = body200();
    expect(b.type).toBe("object");
    expect(b.additionalProperties).toBe(false);
    for (const k of ["columns", "rows", "totals", "next_cursor"]) expect(Object.keys(b.properties ?? {}), k).toContain(k);
    expect(b.required).toEqual(expect.arrayContaining(["columns", "rows", "totals"]));
    expect(b.required ?? []).not.toContain("next_cursor");
    const col = deref(deref(b.properties.columns).items);
    expect(Object.keys(col.properties).sort()).toEqual(["key", "kind", "label"]);
    expect(col.additionalProperties).toBe(false);
    expect([...deref(col.properties.kind).enum].sort()).toEqual(["bp", "count", "paisa", "text"]);
    expect(deref(b.properties.rows).type).toBe("array");
    const t = deref(b.properties.totals);
    expect(t.type).toBe("object");
    expect(deref(t.additionalProperties).type, "totals values are integers (paisa or counts)").toBe("integer");
    expect(deref(b.properties.next_cursor).type).toBe("string");
  });

  it("error responses: 400, 401, 403, 404, 429, 500 are declared; x-error-codes name the typed errors of the brief and all exist in errors.yaml", () => {
    for (const s of ["400", "401", "403", "404", "429", "500"]) expect(Object.keys(mis!.op.responses), s).toContain(s);
    const declared: string[] = mis!.op["x-error-codes"] ?? [];
    for (const c of ["common.validation_failed", "common.invalid_cursor", "analytics.report_unknown", "common.feature_disabled", "auth.mfa_required", "common.not_found", "auth.forbidden", "auth.unauthenticated", "common.rate_limited", "common.internal"]) expect(declared, c).toContain(c);
    const known = new Set<string>((ERR as any[]).map((e) => e.code));
    for (const c of declared) expect(known.has(c), `${c} must exist in contracts/errors.yaml`).toBe(true);
  });

  it("has a synthetic 200 example: Bill of the Day with money in integer paisa, a totals object whose keys are row keys, no PHI-looking value", () => {
    const ex = Object.values<any>(deref(mis!.op.responses["200"]).content["application/json"].examples ?? {})[0]?.value;
    expect(ex, "an example of the 200 body").toBeDefined();
    expect(ex.rows.length).toBeGreaterThan(0);
    for (const k of Object.keys(ex.totals)) { expect(Number.isInteger(ex.totals[k]), k).toBe(true); expect(Object.keys(ex.rows[0]), k).toContain(k); }
    for (const c of ex.columns) expect(Object.keys(ex.rows[0])).toContain(c.key);
    expect(JSON.stringify(ex)).not.toMatch(/@|\+977|98\d{8}/);
  });

  it("the definitions already carry the gate the read shares: the two money codes keep flag + analytics.referral_report.read", () => {
    for (const code of ["two_level_commission", "tds"]) {
      const d: any = defs.find((x) => x.code === code);
      expect(d.permission).toBe("analytics.referral_report.read");
      expect(d.flag).toBe("referralIncentiveReportEnabled");
    }
  });

  it("lintRepo reports no violation for analytics.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "analytics.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });
});

describe("T0D-BUILD-4 generated artifacts and security inventory", () => {
  it("generated clients and MSW handlers are fresh (codegen --check)", () => { expect(staleFiles(ROOT)).toEqual([]); }, 300_000);

  it.each([
    "packages/api-client-ts/src/analytics.ts", "packages/api-client-ts/src/server/operations.ts", "packages/fakes/src/msw/handlers.generated.ts", "packages/api-client-dart/lib/analytics.dart",
  ])("%s knows getMisReportPage", (f) => {
    expect(existsSync(join(ROOT, f))).toBe(true);
    expect(read(f)).toContain(OP);
  });

  it("tests/security/authz-classification.json (regenerated by tests/security/classify-authz.mjs) has an entry for getMisReportPage: guarded, with the x-permission of the contract", () => {
    const cls: any = JSON.parse(read("tests/security/authz-classification.json"));
    const e = cls.operations[OP];
    expect(e, "classification entry").toBeDefined();
    expect(["guarded-exact", "guarded-other"], `class ${e?.class}: a read of report data must be guarded`).toContain(e.class);
    expect(e.x_permission).toBe(mis!.op["x-permission"]);
    expect(typeof e.permission).toBe("string");
    expect(cls.total).toBe(Object.keys(cls.operations).length);
  });
});
