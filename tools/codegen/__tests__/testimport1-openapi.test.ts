// T0C-TESTIMPORT-1 (LD-318, LD-325(b), LD-333, LD-335; founder 2026-11-17 08:58 NPT: one Excel workbook with the same fields as the forms, no dirty data) — contracts/openapi/catalog.yaml
// Excel test import (template download, dry run, atomic commit, batch history), contracts/errors.yaml (six codes), the additive LD-333 edits (event entity_type test_category, listCommentCodes is_active),
// the migration 20261117180000_catalog__add_import_batches.sql (static checks; behaviour is db/tests/catalog/T0C-TESTIMPORT-1_import_batches.test.sql), generated-client freshness and the implementation notes.
// ASSUMPTIONS (the brief names the operations, the table and the rules, not every wire name; a different choice needs a ruling, not a silent test edit; same style as T0C-PRICETOOLS-1):
//  - Exactly 6 new operations (117 -> 123), none removes or changes an existing one, all permission catalog.test.manage (no new permission code):
//      downloadCatalogImportTemplate GET  /v1/catalog/test-import-template                          idem none      200 xlsx attachment
//      validateCatalogImport         POST /v1/catalog/test-import-batches                           idem required  201 CatalogImportValidation (multipart, x-upload xlsx only; writes no catalog row)
//      commitCatalogImport           POST /v1/catalog/test-import-batches/{batch_id}/commit         idem required  201 CatalogImportCommitResult (If-Match + {"confirm": true})
//      listCatalogImports            GET  /v1/catalog/test-import-batches                           idem none      200 CatalogImportBatchPage
//      getCatalogImport              GET  /v1/catalog/test-import-batches/{batch_id}                idem none      200 CatalogImportBatch (ETag = version)
//      downloadCatalogImportErrors   GET  /v1/catalog/test-import-batches/{batch_id}/errors-file    idem none      200 xlsx (the uploaded rows with an Errors column)
//    (the paths avoid the price list import paths /v1/catalog/imports and /v1/catalog/price-list-import-*, which stay as they are).
//  - Wire names: batch id, file_name, file_sha256, template_version, mode (create_only | update), status (validated | rejected | committed | expired), counts {tests, analytes, ranges, panels, errors},
//    created_by, created_at, validated_at, committed_at, committed_by, version. The normalized payload is stored (db) but NOT exposed by the API. Error row: sheet, row, column, code, message (at most 1000 per batch).
//  - Error codes (errors.yaml, owner C3): import_invalid_file 422, import_template_outdated 422, import_too_large 413, import_has_errors 409, import_batch_expired 409, import_already_committed 409;
//    each has a synthetic problem+json example under the operation that returns it (validate: invalid_file, template_outdated, too_large; commit: has_errors, batch_expired, already_committed).
//  - the implementer's notes are .orchestra/notes/T0C-TESTIMPORT-1-impl.md (convention of every earlier T0C task).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { staleFiles } from "../codegen";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FILE = join(ROOT, "contracts/openapi/catalog.yaml");
const MIG = "20261117180000_catalog__add_import_batches.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-TESTIMPORT-1-impl.md");
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const doc: any = parse(readFileSync(FILE, "utf8"));
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const S = doc.components.schemas as Record<string, any>;
const P = (name: string, f: string): any => S[name]?.properties?.[f] ?? {}; // a missing field fails its assertion, not with a TypeError
const enumOf = (p: any): string[] => ((p?.enum ?? []) as unknown[]).filter((x): x is string => typeof x === "string");
const sortedEq = (a: string[], b: string[]) => expect([...a].sort()).toEqual([...b].sort());
const refName = (s: any): string => String(s?.$ref ?? "").split("/").pop()!;
const isUuid = (p: any) => JSON.stringify(p).includes("Uuid");
const METHODS = ["get", "put", "post", "delete", "patch"];

const NEW_OPS: Record<string, { method: string; path: string; idem: string; ok: string }> = {
  downloadCatalogImportTemplate: { method: "get", path: "/v1/catalog/test-import-template", idem: "none", ok: "200" },
  validateCatalogImport: { method: "post", path: "/v1/catalog/test-import-batches", idem: "required", ok: "201" },
  commitCatalogImport: { method: "post", path: "/v1/catalog/test-import-batches/{batch_id}/commit", idem: "required", ok: "201" },
  listCatalogImports: { method: "get", path: "/v1/catalog/test-import-batches", idem: "none", ok: "200" },
  getCatalogImport: { method: "get", path: "/v1/catalog/test-import-batches/{batch_id}", idem: "none", ok: "200" },
  downloadCatalogImportErrors: { method: "get", path: "/v1/catalog/test-import-batches/{batch_id}/errors-file", idem: "none", ok: "200" },
};
const PERM = "catalog.test.manage";
const NEW_SCHEMAS = ["CatalogImportBatch", "CatalogImportCounts", "CatalogImportError", "CatalogImportPreview", "CatalogImportValidation", "CatalogImportForm", "CatalogImportCommit", "CatalogImportCommitResult",
  "CatalogImportBatchPage"];
const BATCH_STATUS = ["validated", "rejected", "committed", "expired"];
const MODES = ["create_only", "update"];
const COUNT_KEYS = ["tests", "analytes", "ranges", "panels", "errors"];
const NEW_CODES: Record<string, { http: number; op: string }> = {
  "catalog.import_invalid_file": { http: 422, op: "validateCatalogImport" },
  "catalog.import_template_outdated": { http: 422, op: "validateCatalogImport" },
  "catalog.import_too_large": { http: 413, op: "validateCatalogImport" },
  "catalog.import_has_errors": { http: 409, op: "commitCatalogImport" },
  "catalog.import_batch_expired": { http: 409, op: "commitCatalogImport" },
  "catalog.import_already_committed": { http: 409, op: "commitCatalogImport" },
};
const OLD_IMPORT_OPS: Record<string, { method: string; path: string }> = {
  downloadImportTemplate: { method: "get", path: "/v1/catalog/import-templates/{kind}" },
  createImport: { method: "post", path: "/v1/catalog/imports" },
  commitImport: { method: "post", path: "/v1/catalog/imports/{import_id}/commit" },
  downloadPriceListTemplate: { method: "get", path: "/v1/catalog/price-list-import-template" },
  dryRunPriceListImport: { method: "post", path: "/v1/catalog/price-lists/{price_list_id}/import-dry-run" },
};

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ ...common, id: "_common.yaml" });
ajv.addSchema({ ...doc, id: "catalog.yaml" });
const validator = (name: string) => {
  const v = ajv.getSchema(`catalog.yaml#/components/schemas/${name}`);
  expect(v, `cannot resolve ${name}`).toBeDefined();
  return v!;
};
const opOf = (id: string): { method: string; path: string; op: any } | undefined => {
  for (const [path, item] of Object.entries<any>(doc.paths)) for (const m of METHODS) if (item[m]?.operationId === id) return { method: m, path, op: item[m] };
  return undefined;
};
const allOps = (): string[] => Object.values<any>(doc.paths).flatMap((item) => METHODS.filter((m) => item[m]).map((m) => item[m].operationId as string));
const okResponse = (id: string): any => opOf(id)?.op.responses?.[NEW_OPS[id].ok];
const jsonSchemaRef = (id: string): string => refName(okResponse(id)?.content?.["application/json"]?.schema);
// resolve a local $ref (#/components/responses/X) so an example under a shared response still counts for the operation
const deref = (n: any): any => (n && typeof n === "object" && typeof n.$ref === "string" && n.$ref.startsWith("#/components/") ? n.$ref.split("/").slice(1).reduce((a: any, k: string) => a?.[k], doc) ?? n : n);
const reach = (root: string, seen = new Set<string>()): Set<string> => {
  const walk = (n: any) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      if (typeof n.$ref === "string" && n.$ref.startsWith("#/components/schemas/")) {
        const name = n.$ref.split("/").pop()!;
        if (!seen.has(name)) { seen.add(name); walk(S[name]); }
      }
      Object.values(n).forEach(walk);
    }
  };
  seen.add(root);
  walk(S[root]);
  return seen;
};
const textOf = (...parts: any[]): string => parts.map((p) => JSON.stringify(p ?? "")).join(" ").replace(/\\"/g, '"');
const problemExamples = (id: string): any[] => Object.values<any>(opOf(id)?.op.responses ?? {}).flatMap((r) => Object.values<any>(deref(r)?.content?.["application/problem+json"]?.examples ?? {}).map((e) => e.value));

const UUID = "0193c4a0-0000-7000-8000-0000000000aa";
const UUID2 = "0193c4a0-0000-7000-8000-0000000000ab";
const SHA = "ab".repeat(32);

describe("T0C-TESTIMPORT-1 contract: catalog.yaml lint and additive baseline", () => {
  it("lintRepo reports no violation for catalog.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "catalog.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });

  it("is additive: 117 operations before, exactly 6 new operations now, every older import operation keeps method and path", () => {
    const ids = allOps();
    expect(ids.length, "117 + 6 test import operations").toBe(123);
    expect(new Set(ids).size).toBe(123);
    for (const id of Object.keys(NEW_OPS)) expect(opOf(id), `${id} missing`).toBeDefined();
    for (const [id, o] of Object.entries(OLD_IMPORT_OPS)) {
      const f = opOf(id);
      expect(f, `${id} missing`).toBeDefined();
      expect(`${f!.method} ${f!.path}`, id).toBe(`${o.method} ${o.path}`);
    }
    for (const id of ["listTestCategories", "createTestCategory", "listTests", "createTest", "publishAnalyteVersion", "publishReferenceRangeSet"]) expect(opOf(id), id).toBeDefined();
  });
});

describe("T0C-TESTIMPORT-1 contract: the six operations (done_when 2)", () => {
  for (const [id, n] of Object.entries(NEW_OPS)) {
    it(`${id}: ${n.method.toUpperCase()} ${n.path}, ${PERM}, idempotency ${n.idem}, ${n.ok}, tenant context, error codes, standard error responses`, () => {
      const f = opOf(id);
      expect(f, `${id} missing`).toBeDefined();
      const { op } = f!;
      expect(`${f!.method} ${f!.path}`).toBe(`${n.method} ${n.path}`);
      expect(op.tags).toEqual(["catalog"]);
      expect(op["x-permission"]).toBe(PERM);
      expect(op["x-context"]).toBe("tenant");
      expect(op["x-idempotency"]).toBe(n.idem);
      expect(typeof op["x-rate-limit-tier"]).toBe("string");
      expect(op.security).toEqual([{ bearerJwt: [] }]);
      expect(Array.isArray(op["x-error-codes"]), "x-error-codes").toBe(true);
      expect(typeof op.summary).toBe("string");
      expect(op.responses?.[n.ok], `${id} ${n.ok} response`).toBeDefined();
      for (const c of ["400", "401", "403", "429", "500"]) expect(op.responses?.[c], `${id} ${c}`).toBeDefined();
      if (n.idem === "required") expect(JSON.stringify(op.parameters), `${id} needs the Idempotency-Key parameter`).toContain("IdempotencyKey");
      if (f!.path.includes("{")) {
        expect(op.responses?.["404"], `${id} 404`).toBeDefined();
        const p = (op.parameters as any[]).find((x) => x.name === "batch_id");
        expect(p, "batch_id path parameter").toBeDefined();
        expect(p.in).toBe("path");
        expect(p.required).toBe(true);
        expect(isUuid(p.schema)).toBe(true);
      }
    });
  }

  it("no new permission code: catalog.test.manage exists and is the only permission used; every x-error-code exists in contracts/errors.yaml", () => {
    expect(readFileSync(join(ROOT, "contracts/permissions.yaml"), "utf8")).toContain(PERM);
    const eText = readFileSync(join(ROOT, "contracts/errors.yaml"), "utf8");
    for (const id of Object.keys(NEW_OPS)) for (const c of (opOf(id)!.op["x-error-codes"] ?? []) as string[]) expect(eText, `${id}: error code ${c} must exist in contracts/errors.yaml`).toContain(c);
  });

  it("downloadCatalogImportTemplate returns an xlsx attachment; its text names the sheets, the version and the instruction sheet", () => {
    const r = okResponse("downloadCatalogImportTemplate");
    expect(Object.keys(r.content ?? {})).toEqual([XLSX]);
    expect(r.content[XLSX].schema).toMatchObject({ type: "string", format: "binary" });
    expect(r.headers?.["Content-Disposition"], "Content-Disposition header (download convention of reporting)").toBeDefined();
    const t = textOf(opOf("downloadCatalogImportTemplate")!.op.summary, opOf("downloadCatalogImportTemplate")!.op.description).toLowerCase();
    for (const w of ["tests", "parameters", "reference ranges", "template version", "instruction", "same field"]) expect(t, `template text names "${w}"`).toContain(w);
  });

  it("validateCatalogImport is a multipart upload of xlsx ONLY (x-upload, encoding), returns CatalogImportValidation, documents 413, 415 and 422", () => {
    const { op } = opOf("validateCatalogImport")!;
    expect(op["x-upload"], "x-upload").toEqual([XLSX]);
    const mp = op.requestBody?.content?.["multipart/form-data"];
    expect(mp, "multipart/form-data body").toBeDefined();
    expect(Object.keys(op.requestBody.content), "no other request media type").toEqual(["multipart/form-data"]);
    expect(refName(mp.schema)).toBe("CatalogImportForm");
    expect(mp.encoding?.file?.contentType).toBe(XLSX);
    expect(op.requestBody.required).toBe(true);
    expect(jsonSchemaRef("validateCatalogImport")).toBe("CatalogImportValidation");
    for (const c of ["413", "415", "422"]) expect(op.responses?.[c], `validate ${c}`).toBeDefined();
    for (const c of ["common.payload_too_large", "common.unsupported_media_type", "common.idempotency_key_reused", "catalog.import_invalid_file", "catalog.import_template_outdated", "catalog.import_too_large"])
      expect(op["x-error-codes"], c).toContain(c);
    expect(textOf(op.summary, op.description)).toMatch(/writes? no catalog row|no catalog row is written/i);
    expect(Object.keys(op.requestBody.content["multipart/form-data"].examples ?? {}).length, "multipart example").toBeGreaterThan(0);
  });

  it("commitCatalogImport: If-Match required, explicit confirm flag, all rows or none, DRAFTS only and never publishes; has_errors, expired and already committed are documented", () => {
    const { op } = opOf("commitCatalogImport")!;
    expect(JSON.stringify(op.parameters), "If-Match parameter").toContain("IfMatch");
    for (const c of ["common.precondition_required", "common.version_conflict", "catalog.import_has_errors", "catalog.import_batch_expired", "catalog.import_already_committed"]) expect(op["x-error-codes"], c).toContain(c);
    for (const c of ["409", "428"]) expect(op.responses?.[c], `commit ${c}`).toBeDefined();
    expect(refName(op.requestBody?.content?.["application/json"]?.schema)).toBe("CatalogImportCommit");
    expect(op.requestBody.required).toBe(true);
    expect(jsonSchemaRef("commitCatalogImport")).toBe("CatalogImportCommitResult");
    const t = textOf(op.summary, op.description);
    expect(t).toMatch(/atomic|all rows or none/i);
    expect(t).toMatch(/confirm/i);
    expect(t).toMatch(/draft/i);
    expect(t).toMatch(/never publish|does not publish|not publish|only a draft|only drafts/i);
    expect(t).toMatch(/publish permission|pathologist/i);
    expect(t).toMatch(/errors?[^.]*(cannot be committed|not committable|refused|rejected)|(cannot be committed|not committable)[^.]*errors?/i);
    expect(t).toMatch(/24 hours/i);
    expect(t).toMatch(/already committed/i);
  });

  it("commit body is closed: confirm must be exactly true; nothing else (no publish, status or tenant fields)", () => {
    const c = S.CatalogImportCommit;
    expect(c.required).toEqual(["confirm"]);
    expect(c.additionalProperties).toBe(false);
    expect(Object.keys(c.properties)).toEqual(["confirm"]);
    const v = validator("CatalogImportCommit");
    expect(v({ confirm: true }), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{}, { confirm: false }, { confirm: "true" }, { confirm: 1 }, { confirm: true, publish: true }, { confirm: true, status: "committed" }]) expect(v(bad), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });

  it("getCatalogImport returns the batch with an ETag; listCatalogImports filters by status and mode and pages; downloadCatalogImportErrors is an xlsx attachment", () => {
    const g = okResponse("getCatalogImport");
    expect(jsonSchemaRef("getCatalogImport")).toBe("CatalogImportBatch");
    expect(g.headers?.ETag, "ETag header carries the batch version for If-Match").toBeDefined();
    const names = (id: string) => (opOf(id)!.op.parameters as any[]).map((p) => p.name ?? p.$ref?.split("/").pop());
    for (const n of ["status", "mode", "Cursor", "Limit"]) expect(names("listCatalogImports"), `list ${n}`).toContain(n);
    expect(jsonSchemaRef("listCatalogImports")).toBe("CatalogImportBatchPage");
    const params = opOf("listCatalogImports")!.op.parameters as any[];
    sortedEq(enumOf(params.find((p) => p.name === "status").schema), BATCH_STATUS);
    sortedEq(enumOf(params.find((p) => p.name === "mode").schema), MODES);
    const e = okResponse("downloadCatalogImportErrors");
    expect(Object.keys(e.content ?? {})).toEqual([XLSX]);
    expect(e.content[XLSX].schema).toMatchObject({ type: "string", format: "binary" });
    expect(e.headers?.["Content-Disposition"]).toBeDefined();
    const t = textOf(opOf("downloadCatalogImportErrors")!.op.summary, opOf("downloadCatalogImportErrors")!.op.description);
    expect(t).toMatch(/errors? column/i);
    expect(t).toMatch(/uploaded rows|rows of the upload/i);
  });
});

describe("T0C-TESTIMPORT-1 contract: error codes with synthetic examples (done_when 3)", () => {
  const entries = (): any[] => {
    const l: any = parse(readFileSync(join(ROOT, "contracts/errors.yaml"), "utf8"));
    return (Array.isArray(l) ? l : Object.values(l).flat()) as any[];
  };
  for (const [code, n] of Object.entries(NEW_CODES)) {
    it(`${code}: registered with http ${n.http} (owner C3, title, meaning), listed in ${n.op} and shown as a problem+json example with that status`, () => {
      const e = entries().find((x) => x?.code === code);
      expect(e, `${code} missing in contracts/errors.yaml`).toBeDefined();
      expect(e.http).toBe(n.http);
      expect(e.owner).toBe("C3");
      expect(String(e.title ?? "").length, "title").toBeGreaterThan(0);
      expect(String(e.meaning ?? "").length, "meaning").toBeGreaterThan(0);
      expect(e.retired, "not retired").not.toBe(true);
      expect(opOf(n.op)!.op["x-error-codes"], `${n.op} x-error-codes`).toContain(code);
      const ex = problemExamples(n.op).find((v) => v?.code === code);
      expect(ex, `${n.op}: a problem+json example with code ${code}`).toBeDefined();
      expect(ex.status).toBe(n.http);
      expect(ex.type).toBe(`urn:lims:error:${code}`);
      expect(typeof ex.title).toBe("string");
      expect(opOf(n.op)!.op.responses?.[String(n.http)], `${n.op} documents ${n.http}`).toBeDefined();
    });
  }
  it("the retired catalog.import_invalid is not used by the new operations and the older import codes are untouched", () => {
    const l = entries();
    expect(l.find((x) => x?.code === "catalog.import_invalid")?.retired).toBe(true);
    for (const c of ["catalog.import_not_committable", "catalog.import_stale_base"]) expect(l.find((x) => x?.code === c), c).toBeDefined();
    for (const id of Object.keys(NEW_OPS)) expect(opOf(id)!.op["x-error-codes"] ?? []).not.toContain("catalog.import_invalid");
  });
});

describe("T0C-TESTIMPORT-1 contract: limits and rules are written into the contract text (done_when 4)", () => {
  const txt = (): string => textOf(opOf("validateCatalogImport")?.op, opOf("downloadCatalogImportTemplate")?.op, S.CatalogImportForm, S.CatalogImportError, S.CatalogImportValidation, S.CatalogImportBatch);
  const rule = (name: string, re: RegExp) => it(`rule: ${name}`, () => expect(txt(), `contract text must say: ${name}`).toMatch(re));
  rule("xlsx only", /xlsx only|only xlsx/i);
  rule("at most 5 MB", /5 ?MB/);
  rule("at most 5000 rows per sheet", /5000 rows per sheet/i);
  rule("never xlsm", /xlsm/i);
  rule("never xls", /\bxls\b/i);
  rule("no macros", /macros?/i);
  rule("checked by magic bytes", /magic bytes/i);
  rule("zip bombs are rejected (uncompressed size)", /zip bomb|decompress|uncompressed/i);
  rule("text cells starting with = + - or @ are rejected (formula injection)", /starting with\s*=,?\s*\+,?\s*-,?\s*(or\s+)?@/i);
  rule("external links are rejected", /external links?/i);
  rule("a wrong template version is rejected", /template version/i);
  rule("all errors are listed, not only the first", /all errors/i);
  rule("at most 1000 errors are kept", /1000 errors|at most 1000|up to 1000/i);
  rule("row and column in every error", /row and column|sheet, row and column/i);
  rule("the dry run writes no catalog row", /writes? no catalog row|no catalog row is written/i);
  rule("a batch older than 24 hours cannot be committed", /24 hours/i);
  rule("the server parses and validates, never the browser", /server[^.]*(parses|validates)|never (in )?the browser/i);
  rule("imported analyte versions and range sets are drafts", /drafts?/i);
  rule("the import never publishes", /never publish|does not publish|not publish/i);
  it("the same limits reach the generated clients through schema descriptions (not only the operation text)", () => {
    expect(textOf(S.CatalogImportForm, S.CatalogImportValidation, S.CatalogImportError)).toMatch(/xlsx/i);
    expect(textOf(S.CatalogImportForm)).toMatch(/5 ?MB/);
  });
});

describe("T0C-TESTIMPORT-1 contract: schemas are closed and have no floats (done_when 2, 4)", () => {
  it("all nine new schemas exist and are closed objects", () => {
    for (const n of NEW_SCHEMAS) {
      expect(S[n], `${n} missing`).toBeDefined();
      expect(S[n].type, n).toBe("object");
      expect(S[n].additionalProperties, `${n} must be closed`).toBe(false);
    }
  });

  it("every schema reachable from the new operations is closed; none uses type number", () => {
    const names = new Set<string>(NEW_SCHEMAS);
    for (const id of Object.keys(NEW_OPS)) {
      const json = okResponse(id)?.content?.["application/json"]?.schema;
      if (json) reach(refName(json), names);
      for (const m of Object.values<any>(opOf(id)!.op.requestBody?.content ?? {})) if (m.schema?.$ref) reach(refName(m.schema), names);
    }
    const bad: string[] = [];
    const walk = (n: any, at: string) => {
      if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${at}[${i}]`));
      if (!n || typeof n !== "object") return;
      if (n.type === "number") bad.push(`${at}: type number`);
      if (n.properties && n.additionalProperties !== false) bad.push(`${at}: object not closed`);
      for (const [k, v] of Object.entries(n)) walk(v, `${at}.${k}`);
    };
    for (const n of names) walk(S[n], n);
    expect(bad, bad.join(" | ")).toEqual([]);
  });

  it("CatalogImportBatch: fields, status and mode enums, closed counts, sha256, version; the normalized payload is not exposed", () => {
    const s = S.CatalogImportBatch;
    for (const f of ["id", "file_name", "file_sha256", "template_version", "mode", "status", "counts", "created_by", "created_at", "version"]) {
      expect(s.properties?.[f], `CatalogImportBatch.${f}`).toBeDefined();
      expect(s.required ?? [], `CatalogImportBatch.${f} required`).toContain(f);
    }
    for (const f of ["validated_at", "committed_at", "committed_by"]) {
      expect(s.properties?.[f], `CatalogImportBatch.${f}`).toBeDefined();
      expect(s.required ?? [], `${f} is absent until it happens`).not.toContain(f);
    }
    expect(Object.keys(s.properties), "payload is internal").not.toContain("payload");
    expect(Object.keys(s.properties), "tenant_id is never on the wire").not.toContain("tenant_id");
    sortedEq(enumOf(P("CatalogImportBatch", "status")), BATCH_STATUS);
    sortedEq(enumOf(P("CatalogImportBatch", "mode")), MODES);
    expect(P("CatalogImportBatch", "file_sha256").pattern).toBe("^[0-9a-f]{64}$");
    expect(P("CatalogImportBatch", "version")).toMatchObject({ type: "integer", minimum: 1 });
    for (const f of ["id", "created_by", "committed_by"]) expect(isUuid(P("CatalogImportBatch", f)), f).toBe(true);
    for (const f of ["file_name", "template_version"]) expect(typeof P("CatalogImportBatch", f).maxLength, `${f} maxLength`).toBe("number");
    const c = S.CatalogImportCounts;
    sortedEq(c.required, COUNT_KEYS);
    for (const k of COUNT_KEYS) expect(P("CatalogImportCounts", k), k).toMatchObject({ type: "integer", minimum: 0 });
    expect(refName(P("CatalogImportBatch", "counts"))).toBe("CatalogImportCounts");
    const v = validator("CatalogImportBatch");
    const b = { id: UUID, file_name: "tests-synthetic.xlsx", file_sha256: SHA, template_version: "1", mode: "create_only", status: "validated", counts: { tests: 2, analytes: 5, ranges: 12, panels: 1, errors: 0 },
      created_by: UUID2, created_at: "2026-11-17T10:00:00.000Z", version: 1 };
    expect(v(b), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ status: "uploaded" }, { mode: "replace" }, { file_sha256: "XYZ" }, { counts: { tests: -1, analytes: 0, ranges: 0, panels: 0, errors: 0 } }, { counts: { tests: 1 } }, { payload: {} }, { tenant_id: UUID }, { version: 0 }])
      expect(v({ ...b, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });

  it("CatalogImportError: sheet, row, column, code, message with bounds", () => {
    const s = S.CatalogImportError;
    for (const f of ["sheet", "row", "column", "code", "message"]) {
      expect(s.properties?.[f], `CatalogImportError.${f}`).toBeDefined();
      expect(s.required ?? [], `CatalogImportError.${f} required`).toContain(f);
    }
    expect(P("CatalogImportError", "row")).toMatchObject({ type: "integer", minimum: 1 });
    expect(typeof P("CatalogImportError", "row").maximum).toBe("number");
    for (const f of ["sheet", "column", "code", "message"]) {
      expect(P("CatalogImportError", f).type, f).toBe("string");
      expect(P("CatalogImportError", f).minLength, `${f} minLength`).toBeGreaterThanOrEqual(1);
      expect(typeof P("CatalogImportError", f).maxLength, `${f} maxLength`).toBe("number");
    }
    const v = validator("CatalogImportError");
    expect(v({ sheet: "Parameters", row: 7, column: "Equation", code: "formula_cycle", message: "Synthetic: VLDL uses TG, TG uses VLDL" }), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ row: 0 }, { row: 1.5 }, { message: "" }, { code: "" }, { sheet: "" }, { extra: 1 }]) expect(v({ sheet: "Tests", row: 2, column: "Test Code", code: "code_duplicate", message: "x", ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });

  it("CatalogImportValidation returns the batch, up to 1000 errors and a preview; CatalogImportBatchPage follows {data, page}", () => {
    const d = S.CatalogImportValidation;
    sortedEq(d.required, ["batch", "errors", "preview"]);
    expect(refName(d.properties.batch)).toBe("CatalogImportBatch");
    expect(d.properties.errors.type).toBe("array");
    expect(refName(d.properties.errors.items)).toBe("CatalogImportError");
    expect(d.properties.errors.maxItems, "at most 1000 errors are kept (done_when 1)").toBe(1000);
    const pv = d.properties.preview;
    const resolved = pv.$ref ? S[refName(pv)] : pv;
    expect(resolved?.type, "preview is an object").toBe("object");
    expect(resolved?.additionalProperties, "preview is closed").toBe(false);
    sortedEq(S.CatalogImportBatchPage.required, ["data", "page"]);
    expect(S.CatalogImportBatchPage.properties.data.type).toBe("array");
    expect(typeof S.CatalogImportBatchPage.properties.data.maxItems).toBe("number");
    expect(refName(S.CatalogImportBatchPage.properties.data.items)).toBe("CatalogImportBatch");
    expect(JSON.stringify(S.CatalogImportBatchPage.properties.page)).toContain("PageInfo");
  });

  it("CatalogImportForm: one required binary file of at most 5 MB (5242880 bytes) and an optional mode create_only | update (default create_only)", () => {
    const f = S.CatalogImportForm;
    expect(f.required).toEqual(["file"]);
    expect(f.properties.file).toMatchObject({ type: "string", format: "binary" });
    expect(f.properties.file.maxLength, "5 MB").toBe(5242880);
    sortedEq(enumOf(P("CatalogImportForm", "mode")), MODES);
    expect(P("CatalogImportForm", "mode").default).toBe("create_only");
  });

  it("CatalogImportCommitResult returns the batch and what was created (integer counts of tests, analytes, ranges, panels)", () => {
    const r = S.CatalogImportCommitResult;
    for (const f of ["batch", "created"]) expect(r.required ?? [], f).toContain(f);
    expect(refName(r.properties.batch)).toBe("CatalogImportBatch");
    const cr = r.properties.created.$ref ? S[refName(r.properties.created)] : r.properties.created;
    expect(cr?.additionalProperties).toBe(false);
    for (const k of ["tests", "analytes", "ranges", "panels"]) {
      expect(cr.properties?.[k], `created.${k}`).toMatchObject({ type: "integer", minimum: 0 });
      expect(cr.required ?? [], `created.${k} required`).toContain(k);
    }
  });
});

describe("T0C-TESTIMPORT-1 contract: examples, including a rejected batch (done_when 3)", () => {
  it("every 2xx JSON response has at least one example and it validates against its schema", () => {
    let n = 0;
    for (const id of Object.keys(NEW_OPS)) {
      const m = okResponse(id)?.content?.["application/json"];
      if (!m) { expect(["downloadCatalogImportTemplate", "downloadCatalogImportErrors"], `${id} must return JSON`).toContain(id); continue; }
      const ex = Object.entries<any>(m.examples ?? {});
      expect(ex.length, `${id}: example`).toBeGreaterThan(0);
      const v = ajv.compile({ $ref: `catalog.yaml#/components/schemas/${refName(m.schema)}` });
      for (const [k, e] of ex) { expect(v(e.value), `${id}/${k}: ${JSON.stringify(v.errors?.[0])}`).toBe(true); n++; }
    }
    expect(n).toBeGreaterThanOrEqual(5);
  });

  it("the validate response has a clean example (validated, 0 errors) and a rejected example whose counts.errors equals the listed errors; sheet, row and column are given", () => {
    const ex = Object.values<any>(okResponse("validateCatalogImport").content["application/json"].examples).map((e) => e.value);
    const clean = ex.filter((v) => v.batch.status === "validated");
    const rejected = ex.filter((v) => v.batch.status === "rejected");
    expect(clean.length, "a validated example").toBeGreaterThan(0);
    expect(rejected.length, "a rejected example").toBeGreaterThan(0);
    for (const v of clean) { expect(v.errors).toEqual([]); expect(v.batch.counts.errors).toBe(0); }
    for (const v of rejected) {
      expect(v.errors.length).toBeGreaterThan(0);
      expect(v.batch.counts.errors, "counts.errors equals the listed errors").toBe(v.errors.length);
      for (const e of v.errors) { expect(typeof e.sheet).toBe("string"); expect(Number.isInteger(e.row) && e.row >= 1).toBe(true); expect(typeof e.column).toBe("string"); }
    }
  });

  it("the commit response example shows what was created and a committed batch", () => {
    const ex = Object.values<any>(okResponse("commitCatalogImport").content["application/json"].examples).map((e) => e.value);
    expect(ex.some((v) => v.batch.status === "committed" && typeof v.batch.committed_at === "string" && typeof v.batch.committed_by === "string")).toBe(true);
    for (const v of ex) expect(v.created.tests + v.created.analytes + v.created.ranges + v.created.panels, "something was created").toBeGreaterThan(0);
    const body = opOf("commitCatalogImport")!.op.requestBody.content["application/json"].examples;
    expect(Object.keys(body ?? {}).length).toBeGreaterThan(0);
    for (const e of Object.values<any>(body)) expect(validator("CatalogImportCommit")(e.value)).toBe(true);
  });
});

describe("T0C-TESTIMPORT-1 LD-333 additive edits: event entity_type test_category and listCommentCodes is_active", () => {
  it("catalog.changed.v1 payload.entity_type gains test_category; every earlier value stays", () => {
    const sch: any = JSON.parse(readFileSync(join(ROOT, "contracts/events/catalog.changed.v1.schema.json"), "utf8"));
    const find = (n: any): any => (n && typeof n === "object" ? (n.properties?.entity_type ? n.properties.entity_type : Object.values(n).map(find).find(Boolean)) : undefined);
    const e = find(sch);
    expect(e, "entity_type property").toBeDefined();
    for (const v of ["department", "specimen_type", "container", "test", "analyte", "panel", "reference_range", "critical_limit", "comment_code", "doctor", "credit_party", "test_category"])
      expect(e.enum, `entity_type ${v}`).toContain(v);
    expect(new Set(e.enum).size).toBe(e.enum.length);
  });

  it("listCommentCodes has the optional query parameter is_active (string, maxLength 5, enum true | false | all, default true), like listTestCategories", () => {
    const p = (opOf("listCommentCodes")!.op.parameters as any[]).find((x) => x.name === "is_active");
    expect(p, "is_active parameter").toBeDefined();
    expect(p.in).toBe("query");
    expect(p.required).toBe(false);
    expect(p.schema.type).toBe("string");
    expect(p.schema.maxLength).toBe(5);
    sortedEq(enumOf(p.schema), ["true", "false", "all"]);
    expect(p.schema.default).toBe("true");
    const cat = (opOf("listTestCategories")!.op.parameters as any[]).find((x) => x.name === "is_active");
    expect(JSON.stringify(p.schema), "a copy of listTestCategories").toBe(JSON.stringify(cat.schema));
    for (const n of ["department_id", "code_prefix"]) expect((opOf("listCommentCodes")!.op.parameters as any[]).find((x) => x.name === n), `${n} kept`).toBeDefined();
  });
});

describe("T0C-TESTIMPORT-1 generated clients (codegen is fresh)", () => {
  it("generated clients and MSW handlers are fresh (codegen --check)", () => {
    expect(staleFiles(ROOT)).toEqual([]);
  }, 120_000);
});

describe("T0C-TESTIMPORT-1 migration file (static; behaviour in the pgTAP suite) (done_when 1)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");
  const block = (): string => code.slice(code.search(/CREATE TABLE IF NOT EXISTS catalog\.import_batch\b/i));

  it("exists, is the only 20261117180000 migration, is newer than the TESTMGMT migration, runs as lims_owner", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all.filter((f) => f.startsWith("20261117180000"))).toEqual([MIG]);
    expect(all.indexOf(MIG)).toBeGreaterThan(all.indexOf("20261117170000_catalog__test_management_parity.sql"));
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("creates catalog.import_batch with every column of the brief, IF NOT EXISTS, RLS enabled and forced, a guarded policy per command, no DELETE", () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS catalog\.import_batch\b/i);
    const b = block().slice(0, 4000);
    for (const c of ["id", "tenant_id", "created_by", "file_name", "file_sha256", "template_version", "mode", "status", "counts", "errors", "payload", "created_at", "validated_at", "committed_at", "committed_by", "version"])
      expect(b, `column ${c}`).toMatch(new RegExp(`\\b${c}\\s+(uuid|text|jsonb|timestamptz|integer|int|bigint)`, "i"));
    expect(b).toMatch(/tenant_id\s+uuid\s+NOT NULL/i);
    expect(b).toMatch(/created_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/i);
    expect(b).toMatch(/\bcounts\s+jsonb\s+NOT NULL/i);
    expect(b).toMatch(/\berrors\s+jsonb\s+NOT NULL/i);
    expect(b).toMatch(/\bpayload\s+jsonb\s+NOT NULL/i);
    expect(code).toMatch(/ALTER TABLE catalog\.import_batch\s+ENABLE ROW LEVEL SECURITY/i);
    expect(code).toMatch(/ALTER TABLE catalog\.import_batch\s+FORCE ROW LEVEL SECURITY/i);
    for (const [name, cmd] of [["select", "SELECT"], ["insert", "INSERT"], ["update", "UPDATE"]]) expect(code, `${name} policy`).toMatch(new RegExp(`CREATE POLICY import_batch__${name}__tenant ON catalog\\.import_batch FOR ${cmd}`, "i"));
    for (const m of code.matchAll(/CREATE POLICY (\w+)/gi)) expect(code, `policy ${m[1]} must be guarded by pg_policy`).toMatch(new RegExp(`pg_policy[^;]*${m[1]}`, "i"));
    expect(code).not.toMatch(/GRANT[^;]*\bDELETE\b[^;]*import_batch/i);
    expect(code).not.toMatch(/CREATE POLICY \w+ ON catalog\.import_batch FOR DELETE/i);
    expect(code).toMatch(/GRANT SELECT, INSERT(, UPDATE)? ON catalog\.import_batch TO lims_app/i);
    expect((code.match(/CREATE TABLE(?! IF NOT EXISTS)/gi) ?? []).length, "every CREATE TABLE is IF NOT EXISTS").toBe(0);
  });
  it("value checks: status list, mode list, sha256 hex, counts keys, errors at most 1000, payload size cap, 24 hour rule, committed needs committed_at and committed_by", () => {
    for (const v of BATCH_STATUS) expect(code, `status check names ${v}`).toContain(`'${v}'`);
    for (const v of MODES) expect(code, `mode check names ${v}`).toContain(`'${v}'`);
    expect(code).toMatch(/\[0-9a-f\]\{64\}/);
    for (const k of COUNT_KEYS) expect(code, `counts check names ${k}`).toContain(`'${k}'`);
    expect(code, "errors capped at 1000 entries").toMatch(/jsonb_array_length\([^)]*errors[^)]*\)\s*(<=\s*1000|<\s*1001)/i);
    expect(code, "payload size cap").toMatch(/(pg_column_size|octet_length)\(\s*payload/i);
    expect(code, "24 hour expiry rule (trigger or check)").toMatch(/24\s*hours/i);
    expect(code, "committed rows carry committed_at and committed_by").toMatch(/committed_at IS NOT NULL/i);
    expect(code).toMatch(/committed_by IS NOT NULL/i);
    expect(code, "a committed batch cannot be changed (trigger)").toMatch(/CREATE (OR REPLACE )?TRIGGER\s+\w+\s+BEFORE\s+UPDATE/i);
  });
  it("is additive and rewrite-free: no data statement, no change to an existing table, no policy drop", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect(code).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|REVOKE|DROP\s+TABLE|DROP\s+COLUMN|DROP\s+SCHEMA|DROP\s+POLICY|DROP\s+INDEX)\b/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN|ALTER\s+TABLE\s+\S+\s+(RENAME|OWNER)|DISABLE\s+ROW|NO\s+FORCE|ALTER\s+POLICY|\bCREATE\s+TYPE\b|\bAS\s+ENUM\b/i);
    for (const m of code.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:catalog\.)?(\w+)/gi)) expect(m[1], "only catalog.import_batch may be altered").toBe("import_batch");
    for (const m of code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/gi)) throw new Error(`unguarded CREATE INDEX near ${m.index}`);
    for (const m of code.matchAll(/ADD\s+CONSTRAINT/gi)) expect(code.slice(Math.max(0, m.index! - 1500), m.index), "ADD CONSTRAINT must sit in a DO block that checks pg_constraint first").toMatch(/DO\s+\$[a-z_]*\$[\s\S]*pg_constraint/i);
  });
  it("comments: LD-318, down note, push-cloud, drafts-only decision and the new table named", () => {
    expect(comments).toMatch(/LD-318/);
    expect(comments).toMatch(/\bdown\b/i);
    expect(comments).toMatch(/DROP TABLE/i);
    expect(comments).toMatch(/push-cloud/i);
    expect(comments).toMatch(/no data rewrite|does not rewrite|no rewrite|new table/i);
    expect(comments).toContain("import_batch");
  });
  it("db/meta/tables.yaml registers catalog.import_batch with its columns; db/policies/catalog.sql carries its policies", () => {
    const meta = readFileSync(join(ROOT, "db/meta/tables.yaml"), "utf8");
    const line = meta.split("\n").find((l) => l.includes('"catalog.import_batch"')) ?? "";
    expect(line, "catalog.import_batch registered").not.toBe("");
    for (const f of ["id", "tenant_id", "created_by", "file_name", "file_sha256", "template_version", "mode", "status", "counts", "errors", "payload", "created_at", "validated_at", "committed_at", "committed_by", "version"])
      expect(line, `tables.yaml column ${f}`).toContain(`"${f}"`);
    const pol = readFileSync(join(ROOT, "db/policies/catalog.sql"), "utf8");
    for (const c of ["select", "insert", "update"]) expect(pol, `policy ${c}`).toContain(`import_batch__${c}__tenant`);
  });
});

describe("T0C-TESTIMPORT-1 implementation notes (done_when 5, LD-325(b), LD-333)", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  it("notes exist, name the migration, the six pending operation ids, T0B-TESTIMPORT-1 and that the cloud migration is a founder step (push-cloud)", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-TESTIMPORT-1-impl.md missing").toBe(true);
    expect(t).toContain(MIG);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/pendingOperations/);
    for (const id of Object.keys(NEW_OPS)) expect(t, id).toContain(id);
    expect(t).toMatch(/T0B-TESTIMPORT-1/);
    expect(t).toMatch(/LD-318/);
    expect(t).toMatch(/LD-333/);
  });
  it("records the design decisions: drafts only (pathologist sign-off stays), server side parsing, no rate card equations, header lists shared with the forms", () => {
    expect(t).toMatch(/draft/i);
    expect(t).toMatch(/pathologist|publish permission/i);
    expect(t).toMatch(/server/i);
    expect(t).toMatch(/header list|same field definitions|cannot drift/i);
    expect(t).toMatch(/no (service|handler)/i);
    expect(t).toMatch(/apps\/web\/src\/features\/admin|rs-c2/i);
  });
});
