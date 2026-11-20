// T0C-PRICETOOLS-1 (LD-321, LD-325; founder 2026-11-17 09:18 NPT priority order, 09:19 offline rule) — contracts/openapi/catalog.yaml price list tools (ElabAssist "Price Allocation"),
// the migration 20261117200000_catalog__add_price_list_tools.sql (static checks; behaviour is db/tests/catalog/T0C-PRICETOOLS-1_price_list_tools.test.sql),
// generated-client freshness and the implementation notes with the FIELD MAP, the party type map and the offline classification.
// ASSUMPTIONS (the brief names the operations and rules, not every wire name; a different choice needs a ruling, not a silent test edit; same style as T0C-TESTMGMT-1):
//  - Exactly 7 new operations (110 -> 117), no others, none removes or changes an existing one:
//      downloadPriceListTemplate  GET  /v1/catalog/price-list-import-template                               catalog.price_list.manage  idem none      200 xlsx
//      dryRunPriceListImport      POST /v1/catalog/price-lists/{price_list_id}/import-dry-run               catalog.price_list.manage  idem required  201 PriceListImportDryRun (multipart, x-upload xlsx only)
//      commitPriceListImport      POST /v1/catalog/price-list-import-batches/{batch_id}/commit              catalog.price_list.manage  idem required  201 PriceListVersion (status draft, never published)
//      bulkUpdatePriceListDraft   POST /v1/catalog/price-list-versions/{price_list_version_id}/bulk-update  catalog.price_list.manage  idem required  200 PriceListBulkUpdateResult
//      copyPriceList              POST /v1/catalog/price-lists/{price_list_id}/copy                         catalog.price_list.manage  idem required  201 PriceListVersion (DRAFT on the TARGET list in the path)
//      comparePriceLists          GET  /v1/catalog/price-list-comparisons?version_a_id&version_b_id         catalog.price_list.read    idem none      200 PriceListComparisonPage
//      listPriceListImportBatches GET  /v1/catalog/price-list-import-batches                                catalog.price_list.read    idem none      200 PriceListImportBatchPage
//  - Assignments are EXTENDED, not replaced: PriceListAssignment (response and create) and PriceListAssignmentsReplace gain optional effective_from / effective_to (IsoUtc, like price list versions);
//    replacePriceListAssignments stays the single "set" operation, PriceList.assignments is the "list"; the required lists of both schemas are unchanged. Overlap in time is refused (409, the existing Conflict response).
//  - Money is integer paisa everywhere (no `type: number` in any new schema): bulk update percent is percent_bp (basis points, integer, negative = decrease, like surcharge_rules.percent_bp) or amount_paisa (signed integer);
//    compare returns price_a_paisa, price_b_paisa, difference_paisa and percent_bp (difference as basis points of A), a price absent from one list is absent from the row.
//  - Enums: bulk change_kind percent | fixed_amount; rounding none | nearest_rupee | nearest_5 | nearest_10; scope all | department | listed_tests; copy mode replace | merge; batch status dry_run | committed | failed | cancelled.
//  - Wire names of the batch: id, price_list_id, status, row_count, error_count, file_sha256, summary, created_at, created_by (file_ref is a storage key and is NOT exposed); error row: row_no, column, code, message
//    (`column` as in ImportIssue; the table column is column_name).
//  - Import rules are written into the contract text in the exact phrases tested below (the brief's own words): "integer paisa", "at most 2 decimals", "never floats", "5000 rows", "5 MB", "magic bytes", "xlsx only",
//    "xlsm", "xls", "macros", "text cells starting with = + - or @", "external links", "all errors", "row and column", "writes no price", DRAFT only.
//  - No new permission code, no new error code (catalog.import_invalid is retired in contracts/errors.yaml and is not used).
//  - the implementer's notes are .orchestra/notes/T0C-PRICETOOLS-1-impl.md (convention of every earlier T0C task).
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
const MIG = "20261117200000_catalog__add_price_list_tools.sql";
const NOTES = join(ROOT, ".orchestra/notes/T0C-PRICETOOLS-1-impl.md");
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

const NEW_OPS: Record<string, { method: string; path: string; perm: string; idem: string; ok: string }> = {
  downloadPriceListTemplate: { method: "get", path: "/v1/catalog/price-list-import-template", perm: "catalog.price_list.manage", idem: "none", ok: "200" },
  dryRunPriceListImport: { method: "post", path: "/v1/catalog/price-lists/{price_list_id}/import-dry-run", perm: "catalog.price_list.manage", idem: "required", ok: "201" },
  commitPriceListImport: { method: "post", path: "/v1/catalog/price-list-import-batches/{batch_id}/commit", perm: "catalog.price_list.manage", idem: "required", ok: "201" },
  bulkUpdatePriceListDraft: { method: "post", path: "/v1/catalog/price-list-versions/{price_list_version_id}/bulk-update", perm: "catalog.price_list.manage", idem: "required", ok: "200" },
  copyPriceList: { method: "post", path: "/v1/catalog/price-lists/{price_list_id}/copy", perm: "catalog.price_list.manage", idem: "required", ok: "201" },
  comparePriceLists: { method: "get", path: "/v1/catalog/price-list-comparisons", perm: "catalog.price_list.read", idem: "none", ok: "200" },
  listPriceListImportBatches: { method: "get", path: "/v1/catalog/price-list-import-batches", perm: "catalog.price_list.read", idem: "none", ok: "200" },
};
const OLD_PRICE_OPS: Record<string, { method: string; path: string; perm: string }> = {
  listPriceLists: { method: "get", path: "/v1/catalog/price-lists", perm: "catalog.price_list.read" },
  createPriceList: { method: "post", path: "/v1/catalog/price-lists", perm: "catalog.price_list.manage" },
  getPriceListDetail: { method: "get", path: "/v1/catalog/price-lists/{price_list_id}", perm: "catalog.price_list.read" },
  updatePriceList: { method: "patch", path: "/v1/catalog/price-lists/{price_list_id}", perm: "catalog.price_list.manage" },
  replacePriceListAssignments: { method: "put", path: "/v1/catalog/price-lists/{price_list_id}/assignments", perm: "catalog.price_list.manage" },
  createPriceListVersionDraft: { method: "post", path: "/v1/catalog/price-lists/{price_list_id}/versions", perm: "catalog.price_list.manage" },
  listPriceListItems: { method: "get", path: "/v1/catalog/price-list-versions/{price_list_version_id}/items", perm: "catalog.price_list.read" },
  upsertPriceListItems: { method: "post", path: "/v1/catalog/price-list-versions/{price_list_version_id}/items/bulk-upsert", perm: "catalog.price_list.manage" },
  removePriceListItems: { method: "post", path: "/v1/catalog/price-list-versions/{price_list_version_id}/items/bulk-remove", perm: "catalog.price_list.manage" },
  publishPriceListVersion: { method: "post", path: "/v1/catalog/price-list-versions/{price_list_version_id}/publish", perm: "catalog.price_list.manage" },
  discardPriceListVersionDraft: { method: "post", path: "/v1/catalog/price-list-versions/{price_list_version_id}/discard", perm: "catalog.price_list.manage" },
};
const NEW_SCHEMAS = ["PriceListImportBatch", "PriceListImportError", "PriceListImportDryRun", "PriceListImportBatchPage", "PriceListImportForm", "PriceListImportCommit", "PriceListBulkUpdate",
  "PriceListBulkUpdateResult", "PriceListCopy", "PriceListComparisonRow", "PriceListComparisonPage"];
const ROUNDING = ["none", "nearest_rupee", "nearest_5", "nearest_10"];
const BATCH_STATUS = ["dry_run", "committed", "failed", "cancelled"];

// every ElabAssist label of the Price Allocation / Rate Master / Test Rate Card / Rate Change Log records (C:/LIMS-state/elabassist-accounting-20261117.md, elabassist-testmgmt-20261117.md): one decision line each (done_when 1)
const LABELS = [
  "Select Type", "Franchise", "Laboratory", "Doctor", "Rate Master", "Client", "Collection Center", "Effective From Date", "Effective To Date", "Recalculate Prices", "Test or Profile",
  "Display Name or Short Name", "Test Category", "Choose File", "Upload Test Price", "Bulk Update", "Search", "Export to Excel", "Export to PDF", "Compare Rate List", "Copy To",
  "Rate Type Name", "Lab Name", "Equation", "Operator", "Parent Rate Card", "Is Default", "Entity Name", "Entity Type", "Test Name", "Test Type", "Test MRP",
  "Rate Change Log", "Actual Price", "Changed Price",
];
// the six party types and the existing assignment each maps onto (done_when 1): the decision line of each names its target
const PARTY_MAP: Record<string, RegExp> = {
  Franchise: /credit[ _]party|partner/i, Laboratory: /credit[ _]party|partner/i, Doctor: /referrer/i, "Rate Master": /default (price )?list|default/i, Client: /credit[ _]party/i, "Collection Center": /centre|center/i,
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
// every schema reachable from a root by $ref inside catalog.yaml (to prove "no float", "closed objects")
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

const UUID = "0193c4a0-0000-7000-8000-0000000000aa";
const UUID2 = "0193c4a0-0000-7000-8000-0000000000ab";
const SHA = "ab".repeat(32);

describe("T0C-PRICETOOLS-1 contract: catalog.yaml lint and additive baseline", () => {
  it("lintRepo reports no violation for catalog.yaml", async () => {
    const v = (await lintRepo(ROOT)).filter((x) => x.file === "catalog.yaml");
    expect(v, JSON.stringify(v.slice(0, 3))).toEqual([]);
  });

  it("is additive: 110 operations before, exactly 7 new operations now, every old price list operation keeps method, path and permission", () => {
    const ids = allOps();
    // T0C-TESTIMPORT-1 (LD-318) adds 6 Excel test import operations on top (pinned in testimport1-openapi.test.ts): 117 + 6 = 123
    expect(ids.length, "110 (107 + 3 category operations) + 7 price list tool operations + 6 test import operations + 5 ICD master operations (T0C-PARTYSET-1)").toBe(128);
    expect(new Set(ids).size).toBe(128);
    for (const id of Object.keys(NEW_OPS)) expect(opOf(id), `${id} missing`).toBeDefined();
    for (const [id, o] of Object.entries(OLD_PRICE_OPS)) {
      const f = opOf(id);
      expect(f, `${id} missing`).toBeDefined();
      expect(`${f!.method} ${f!.path}`, id).toBe(`${o.method} ${o.path}`);
      expect(f!.op["x-permission"], `${id} permission`).toBe(o.perm);
    }
    for (const id of ["listTestCategories", "createTestCategory", "updateTestCategory", "listTests", "searchOrderables", "downloadImportTemplate", "createImport", "commitImport"]) expect(opOf(id), id).toBeDefined();
    expect(opOf("publishPriceListVersion")!.op["x-permission"]).toBe("catalog.price_list.manage");
  });

  it("required lists of the existing price list schemas are unchanged (no field became required)", () => {
    sortedEq(S.PriceList.required, ["id", "code", "name", "owner_kind", "falls_through", "assignments", "is_active", "version"]);
    sortedEq(S.PriceListVersion.required, ["id", "price_list_id", "version_no", "status", "item_count", "version"]);
    sortedEq(S.PriceListCreate.required, ["code", "name", "owner_kind", "assignments"]);
    sortedEq(S.PriceListAssignment.required, ["owner_id"]);
    sortedEq(S.PriceListAssignmentsReplace.required, ["owner_ids"]);
    expect(S.PriceListUpdate.required ?? []).toEqual([]);
    expect(S.PriceListVersionDraftCreate.required ?? []).toEqual([]);
    sortedEq(enumOf(P("PriceListVersion", "status")), ["draft", "published", "superseded", "retired", "discarded"]);
  });
});

describe("T0C-PRICETOOLS-1 contract: the seven operations (done_when 3, 5)", () => {
  for (const [id, n] of Object.entries(NEW_OPS)) {
    it(`${id}: ${n.method.toUpperCase()} ${n.path}, ${n.perm}, idempotency ${n.idem}, ${n.ok}, tenant context, error codes, standard error responses`, () => {
      const f = opOf(id);
      expect(f, `${id} missing`).toBeDefined();
      const { op } = f!;
      expect(`${f!.method} ${f!.path}`).toBe(`${n.method} ${n.path}`);
      expect(op.tags).toEqual(["catalog"]);
      expect(op["x-permission"]).toBe(n.perm);
      expect(op["x-context"]).toBe("tenant");
      expect(op["x-idempotency"]).toBe(n.idem);
      expect(typeof op["x-rate-limit-tier"]).toBe("string");
      expect(op.security).toEqual([{ bearerJwt: [] }]);
      expect(Array.isArray(op["x-error-codes"]), "x-error-codes").toBe(true);
      expect(typeof op.summary).toBe("string");
      expect(op.responses?.[n.ok], `${id} ${n.ok} response`).toBeDefined();
      for (const c of ["400", "401", "403", "429", "500"]) expect(op.responses?.[c], `${id} ${c}`).toBeDefined();
      if (n.idem === "required") expect(JSON.stringify(op.parameters), `${id} needs the Idempotency-Key parameter`).toContain("IdempotencyKey");
      if (f!.path.includes("{")) expect(op.responses?.["404"], `${id} 404`).toBeDefined();
    });
  }

  it("only the two existing permission codes are used; no new permission code and no new error code", () => {
    for (const id of Object.keys(NEW_OPS)) expect(["catalog.price_list.manage", "catalog.price_list.read"]).toContain(opOf(id)!.op["x-permission"]);
    const pText = readFileSync(join(ROOT, "contracts/permissions.yaml"), "utf8");
    expect(pText).toContain("catalog.price_list.manage");
    expect(pText).toContain("catalog.price_list.read");
    expect(pText.toLowerCase()).not.toMatch(/price[._-]?list[._-]?(import|bulk|copy|compare|tools)/);
    const eText = readFileSync(join(ROOT, "contracts/errors.yaml"), "utf8");
    for (const id of Object.keys(NEW_OPS)) for (const c of (opOf(id)!.op["x-error-codes"] ?? []) as string[]) expect(eText, `${id}: error code ${c} must exist in contracts/errors.yaml`).toContain(c);
    for (const id of Object.keys(NEW_OPS)) expect(opOf(id)!.op["x-error-codes"] ?? [], `${id} must not use the retired catalog.import_invalid`).not.toContain("catalog.import_invalid");
  });

  it("downloadPriceListTemplate returns an xlsx attachment; its text names the four columns and the instruction sheet", () => {
    const r = okResponse("downloadPriceListTemplate");
    expect(Object.keys(r.content ?? {})).toEqual([XLSX]);
    expect(r.content[XLSX].schema).toMatchObject({ type: "string", format: "binary" });
    expect(r.headers?.["Content-Disposition"], "Content-Disposition header").toBeDefined();
    const t = textOf(opOf("downloadPriceListTemplate")!.op.summary, opOf("downloadPriceListTemplate")!.op.description).toLowerCase();
    for (const w of ["test code", "test name", "read only", "price", "rupees", "effective from", "instruction"]) expect(t, `template text names "${w}"`).toContain(w);
  });

  it("dryRunPriceListImport is a multipart upload of xlsx ONLY (x-upload, encoding), returns PriceListImportDryRun, 413 and 415 documented, writes no price", () => {
    const { op } = opOf("dryRunPriceListImport")!;
    expect(op["x-upload"], "x-upload").toEqual([XLSX]);
    const mp = op.requestBody?.content?.["multipart/form-data"];
    expect(mp, "multipart/form-data body").toBeDefined();
    expect(Object.keys(op.requestBody.content), "no other request media type").toEqual(["multipart/form-data"]);
    expect(refName(mp.schema)).toBe("PriceListImportForm");
    expect(mp.encoding?.file?.contentType).toBe(XLSX);
    expect(op.requestBody.required).toBe(true);
    expect(jsonSchemaRef("dryRunPriceListImport")).toBe("PriceListImportDryRun");
    for (const c of ["413", "415", "422"]) expect(op.responses?.[c], `dry run ${c}`).toBeDefined();
    for (const c of ["common.payload_too_large", "common.unsupported_media_type", "common.idempotency_key_reused"]) expect(op["x-error-codes"], c).toContain(c);
    expect(textOf(op.summary, op.description)).toMatch(/writes? no price|no price is written/i);
  });

  it("commitPriceListImport takes the batch id in the path, creates a DRAFT only and never publishes; a batch with errors is not committable", () => {
    const { op } = opOf("commitPriceListImport")!;
    expect(jsonSchemaRef("commitPriceListImport")).toBe("PriceListVersion");
    expect(okResponse("commitPriceListImport").content["application/json"].examples, "example").toBeDefined();
    const ex = JSON.stringify(okResponse("commitPriceListImport").content["application/json"].examples);
    expect(ex).toContain('"status":"draft"');
    expect(op["x-error-codes"]).toContain("catalog.import_not_committable");
    expect(op.responses?.["409"], "409 (a draft already exists / batch already committed)").toBeDefined();
    const t = textOf(op.summary, op.description);
    expect(t).toMatch(/draft/i);
    expect(t).toMatch(/never publish|does not publish|not publish|only a draft/i);
    expect(t).toMatch(/errors?[^.]*(not committable|cannot be committed|refused|rejected)|(not committable|cannot be committed)[^.]*errors?/i);
    const body = op.requestBody?.content?.["application/json"]?.schema;
    if (body) {
      const c = S[refName(body)] ?? body;
      expect(c.additionalProperties).toBe(false);
      for (const bad of ["publish", "status", "effective_from", "effective_to", "published"]) expect(Object.keys(c.properties ?? {}), `commit body must not carry ${bad} (publishing goes through publishPriceListVersion)`).not.toContain(bad);
    }
  });

  it("copyPriceList creates a DRAFT on the target list of the path; bulkUpdatePriceListDraft only touches a draft", () => {
    const copy = opOf("copyPriceList")!.op;
    expect(jsonSchemaRef("copyPriceList")).toBe("PriceListVersion");
    expect(refName(copy.requestBody?.content?.["application/json"]?.schema)).toBe("PriceListCopy");
    expect(textOf(copy.summary, copy.description)).toMatch(/draft/i);
    const bulk = opOf("bulkUpdatePriceListDraft")!.op;
    expect(refName(bulk.requestBody?.content?.["application/json"]?.schema)).toBe("PriceListBulkUpdate");
    expect(jsonSchemaRef("bulkUpdatePriceListDraft")).toBe("PriceListBulkUpdateResult");
    expect(textOf(bulk.summary, bulk.description)).toMatch(/draft/i);
    expect(bulk.responses?.["409"], "409 when the version is not a draft").toBeDefined();
    expect(textOf(bulk.description)).toMatch(/below 0|negative|less than 0/i);
  });

  it("comparePriceLists takes version_a_id and version_b_id (required uuids) plus paging; listPriceListImportBatches filters by price_list_id and status", () => {
    const names = (id: string) => (opOf(id)!.op.parameters as any[]).map((p) => p.name ?? p.$ref?.split("/").pop());
    const cmp = opOf("comparePriceLists")!.op.parameters as any[];
    for (const n of ["version_a_id", "version_b_id"]) {
      const p = cmp.find((x) => x.name === n);
      expect(p, n).toBeDefined();
      expect(p.in).toBe("query");
      expect(p.required, `${n} required`).toBe(true);
      expect(isUuid(p.schema)).toBe(true);
    }
    for (const n of ["Cursor", "Limit"]) expect(names("comparePriceLists"), `compare ${n}`).toContain(n);
    expect(jsonSchemaRef("comparePriceLists")).toBe("PriceListComparisonPage");
    for (const n of ["price_list_id", "status", "Cursor", "Limit"]) expect(names("listPriceListImportBatches"), `list batches ${n}`).toContain(n);
    expect(jsonSchemaRef("listPriceListImportBatches")).toBe("PriceListImportBatchPage");
    const st = (opOf("listPriceListImportBatches")!.op.parameters as any[]).find((p) => p.name === "status");
    sortedEq(enumOf(st.schema), BATCH_STATUS);
  });
});

describe("T0C-PRICETOOLS-1 contract: schemas are closed, money is integer paisa (done_when 4, 6)", () => {
  it("all eleven new schemas exist and are closed objects", () => {
    for (const n of NEW_SCHEMAS) {
      expect(S[n], `${n} missing`).toBeDefined();
      expect(S[n].type, n).toBe("object");
      expect(S[n].additionalProperties, `${n} must be closed`).toBe(false);
    }
  });

  it("every schema reachable from the new operations and every object inside is closed; none uses type number (no floats)", () => {
    const names = new Set<string>(NEW_SCHEMAS);
    for (const id of Object.keys(NEW_OPS)) {
      const json = okResponse(id)?.content?.["application/json"]?.schema;
      if (json) reach(refName(json), names);
      const body = opOf(id)!.op.requestBody?.content;
      for (const m of Object.values<any>(body ?? {})) if (m.schema?.$ref) reach(refName(m.schema), names);
    }
    for (const n of ["PriceListAssignment", "PriceListAssignmentsReplace"]) names.add(n);
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

  it("PriceListImportBatch: fields, status enum, row and error counts, sha256, closed summary; file_ref (a storage key) is not exposed", () => {
    const s = S.PriceListImportBatch;
    for (const f of ["id", "price_list_id", "status", "row_count", "error_count", "file_sha256", "summary", "created_at", "created_by"]) {
      expect(s.properties?.[f], `PriceListImportBatch.${f}`).toBeDefined();
      expect(s.required ?? [], `PriceListImportBatch.${f} required`).toContain(f);
    }
    expect(Object.keys(s.properties), "file_ref is internal").not.toContain("file_ref");
    sortedEq(enumOf(P("PriceListImportBatch", "status")), BATCH_STATUS);
    expect(P("PriceListImportBatch", "row_count")).toMatchObject({ type: "integer", minimum: 0, maximum: 5000 });
    expect(P("PriceListImportBatch", "error_count")).toMatchObject({ type: "integer", minimum: 0 });
    expect(typeof P("PriceListImportBatch", "error_count").maximum).toBe("number");
    expect(P("PriceListImportBatch", "file_sha256").pattern).toBe("^[0-9a-f]{64}$");
    for (const f of ["id", "price_list_id", "created_by"]) expect(isUuid(P("PriceListImportBatch", f)), f).toBe(true);
    const sum = P("PriceListImportBatch", "summary");
    const resolved = sum.$ref ? S[refName(sum)] : sum;
    expect(resolved?.type).toBe("object");
    expect(resolved?.additionalProperties, "summary is a closed object").toBe(false);
  });

  it("PriceListImportError: row_no, column, code, message with bounds", () => {
    const s = S.PriceListImportError;
    for (const f of ["row_no", "column", "code", "message"]) {
      expect(s.properties?.[f], `PriceListImportError.${f}`).toBeDefined();
      expect(s.required ?? [], `PriceListImportError.${f} required`).toContain(f);
    }
    expect(P("PriceListImportError", "row_no")).toMatchObject({ type: "integer", minimum: 1 });
    expect(typeof P("PriceListImportError", "row_no").maximum).toBe("number");
    for (const f of ["column", "code", "message"]) {
      expect(P("PriceListImportError", f).type, f).toBe("string");
      expect(P("PriceListImportError", f).minLength, `${f} minLength`).toBeGreaterThanOrEqual(1);
      expect(typeof P("PriceListImportError", f).maxLength, `${f} maxLength`).toBe("number");
    }
  });

  it("PriceListImportDryRun returns the batch AND every error; PriceListImportBatchPage and PriceListComparisonPage follow the {data, page} convention", () => {
    const d = S.PriceListImportDryRun;
    sortedEq(d.required, ["batch", "errors"]);
    expect(refName(d.properties.batch)).toBe("PriceListImportBatch");
    expect(d.properties.errors.type).toBe("array");
    expect(refName(d.properties.errors.items)).toBe("PriceListImportError");
    expect(d.properties.errors.maxItems, "every error is returned together: room for more than 5000 errors").toBeGreaterThanOrEqual(5000);
    for (const [pg, item] of [["PriceListImportBatchPage", "PriceListImportBatch"], ["PriceListComparisonPage", "PriceListComparisonRow"]] as const) {
      sortedEq(S[pg].required, ["data", "page"]);
      expect(S[pg].properties.data.type).toBe("array");
      expect(typeof S[pg].properties.data.maxItems).toBe("number");
      expect(refName(S[pg].properties.data.items)).toBe(item);
      expect(JSON.stringify(S[pg].properties.page)).toContain("PageInfo");
    }
  });

  it("PriceListImportForm: one required binary file, at most 5 MB (5242880 bytes), nothing else required", () => {
    const f = S.PriceListImportForm;
    expect(f.required).toEqual(["file"]);
    expect(f.properties.file).toMatchObject({ type: "string", format: "binary" });
    expect(f.properties.file.maxLength, "5 MB").toBe(5242880);
  });

  it("PriceListBulkUpdate: percent_bp or amount_paisa (signed integers), rounding, scope with department_id / orderable_ids", () => {
    const b = S.PriceListBulkUpdate;
    sortedEq(b.required, ["change_kind", "rounding", "scope"]);
    sortedEq(enumOf(P("PriceListBulkUpdate", "change_kind")), ["percent", "fixed_amount"]);
    sortedEq(enumOf(P("PriceListBulkUpdate", "rounding")), ROUNDING);
    sortedEq(enumOf(P("PriceListBulkUpdate", "scope")), ["all", "department", "listed_tests"]);
    expect(P("PriceListBulkUpdate", "percent_bp")).toMatchObject({ type: "integer" });
    expect(P("PriceListBulkUpdate", "percent_bp").minimum).toBeLessThan(0);
    expect(P("PriceListBulkUpdate", "percent_bp").maximum).toBeGreaterThan(0);
    expect(P("PriceListBulkUpdate", "amount_paisa")).toMatchObject({ type: "integer", format: "int64" });
    expect(P("PriceListBulkUpdate", "amount_paisa").minimum).toBeLessThan(0);
    expect(isUuid(P("PriceListBulkUpdate", "department_id"))).toBe(true);
    const ids = P("PriceListBulkUpdate", "orderable_ids");
    expect(ids.type).toBe("array");
    expect(ids.uniqueItems).toBe(true);
    expect(ids.maxItems).toBeLessThanOrEqual(5000);
    expect(isUuid(ids.items)).toBe(true);
    const v = validator("PriceListBulkUpdate");
    expect(v({ change_kind: "percent", percent_bp: 1000, rounding: "nearest_rupee", scope: "all" }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ change_kind: "fixed_amount", amount_paisa: -500, rounding: "none", scope: "department", department_id: UUID }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ change_kind: "percent", percent_bp: 1000, rounding: "nearest_5", scope: "listed_tests", orderable_ids: [UUID, UUID2] }), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ percent_bp: 10.5 }, { percent_bp: "10" }, { rounding: "nearest_50" }, { scope: "everything" }, { change_kind: "set" }, { amount_paisa: 1.5 }, { orderable_ids: [UUID, UUID] }, { extra: 1 }])
      expect(v({ change_kind: "percent", percent_bp: 1000, rounding: "none", scope: "all", ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    expect(v({ rounding: "none", scope: "all" }), "change_kind is required").toBe(false);
  });

  it("PriceListCopy: source version, mode replace | merge, optional percent_bp and rounding; PriceListBulkUpdateResult counts", () => {
    const c = S.PriceListCopy;
    sortedEq(c.required, ["source_price_list_version_id", "mode"]);
    expect(isUuid(P("PriceListCopy", "source_price_list_version_id"))).toBe(true);
    sortedEq(enumOf(P("PriceListCopy", "mode")), ["replace", "merge"]);
    expect(P("PriceListCopy", "percent_bp")).toMatchObject({ type: "integer" });
    sortedEq(enumOf(P("PriceListCopy", "rounding")), ROUNDING);
    const v = validator("PriceListCopy");
    expect(v({ source_price_list_version_id: UUID, mode: "merge" }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ source_price_list_version_id: UUID, mode: "replace", percent_bp: -500, rounding: "nearest_10" }), JSON.stringify(v.errors?.[0])).toBe(true);
    for (const bad of [{ mode: "overwrite" }, { percent_bp: 1.5 }, { target_price_list_id: UUID }]) expect(v({ source_price_list_version_id: UUID, mode: "merge", ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    const r = S.PriceListBulkUpdateResult;
    for (const f of ["price_list_version_id", "changed_count", "unchanged_count"]) {
      expect(r.required ?? [], f).toContain(f);
      expect(r.properties?.[f], f).toBeDefined();
    }
    for (const f of ["changed_count", "unchanged_count"]) expect(P("PriceListBulkUpdateResult", f)).toMatchObject({ type: "integer", minimum: 0 });
  });

  it("PriceListComparisonRow: test code and name, price A and B, difference and percent as integers; a price missing from one list is absent, not zero", () => {
    const s = S.PriceListComparisonRow;
    for (const f of ["orderable_id", "test_code", "test_name"]) expect(s.required ?? [], f).toContain(f);
    for (const f of ["price_a_paisa", "price_b_paisa", "difference_paisa", "percent_bp"]) {
      expect(s.properties?.[f], f).toBeDefined();
      expect(s.required ?? [], `${f} is optional (absent when a test is on one list only)`).not.toContain(f);
      expect(P("PriceListComparisonRow", f).type, f).toBe("integer");
      expect(P("PriceListComparisonRow", f).nullable, f).not.toBe(true);
    }
    expect(P("PriceListComparisonRow", "price_a_paisa").minimum).toBe(0);
    expect(P("PriceListComparisonRow", "price_b_paisa").minimum).toBe(0);
    expect(P("PriceListComparisonRow", "difference_paisa").minimum).toBeLessThan(0);
    expect(P("PriceListComparisonRow", "percent_bp").minimum).toBeLessThan(0);
  });

  it("assignments carry effective dates: PriceListAssignment and PriceListAssignmentsReplace gain optional effective_from / effective_to (IsoUtc)", () => {
    for (const n of ["PriceListAssignment", "PriceListAssignmentsReplace"]) {
      for (const f of ["effective_from", "effective_to"]) {
        expect(S[n].properties?.[f], `${n}.${f}`).toBeDefined();
        expect(S[n].required ?? [], `${n}.${f} must not be required`).not.toContain(f);
        expect(JSON.stringify(P(n, f)), `${n}.${f} is IsoUtc`).toContain("IsoUtc");
      }
      expect(S[n].additionalProperties).toBe(false);
    }
    const v = validator("PriceListAssignmentsReplace");
    expect(v({ owner_ids: [UUID] }), "old payload still validates").toBe(true);
    expect(v({ owner_ids: [UUID], effective_from: "2026-08-01T00:00:00.000Z", effective_to: "2026-12-31T00:00:00.000Z" }), JSON.stringify(v.errors?.[0])).toBe(true);
    expect(v({ owner_ids: [UUID], effective_from: 5 })).toBe(false);
    const put = opOf("replacePriceListAssignments")!.op;
    expect(textOf(put.summary, put.description), "overlap rule is written into the operation").toMatch(/overlap/i);
    expect(put.responses?.["409"], "409 for an overlap").toBeDefined();
  });
});

describe("T0C-PRICETOOLS-1 contract: import rules are written into the contract text (done_when 4)", () => {
  const dry = (): string => textOf(opOf("dryRunPriceListImport")?.op, S.PriceListImportForm, S.PriceListImportError, S.PriceListImportDryRun, S.PriceListImportBatch);
  const rule = (name: string, re: RegExp) => it(`rule: ${name}`, () => expect(dry(), `contract text must say: ${name}`).toMatch(re));
  rule("prices are integer paisa converted exactly from rupees", /integer paisa/i);
  rule("at most 2 decimals in rupees", /(at most|max(imum)?|up to) (2|two) decimals?/i);
  rule("never floats", /never (a )?floats?|no floats?|not (a )?floats?/i);
  rule("the test code exists and is active", /(test )?code[^.]{0,60}exists[^.]{0,40}active|exists and is active/i);
  rule("no duplicate code", /duplicate/i);
  rule("price not below 0", /not below 0|below 0|negative/i);
  rule("at most 5000 rows", /5000 rows/i);
  rule("at most 5 MB", /5 ?MB/);
  rule("xlsx only", /xlsx only|only xlsx/i);
  rule("checked by magic bytes", /magic bytes/i);
  rule("never xlsm", /xlsm/i);
  rule("never xls", /\bxls\b/i);
  rule("no macros", /macros?/i);
  rule("text cells starting with = + - or @ are rejected", /starting with\s*=,?\s*\+,?\s*-,?\s*(or\s+)?@/i);
  rule("external links are rejected", /external links?/i);
  rule("all errors are returned together", /all errors/i);
  rule("with row and column", /row and column/i);
  it("the same rules reach the generated clients through the schema descriptions (not only the operation text)", () => {
    expect(textOf(S.PriceListImportForm, S.PriceListImportDryRun, S.PriceListImportError)).toMatch(/xlsx/i);
  });
});

describe("T0C-PRICETOOLS-1 contract: example payloads, including error rows (done_when 6)", () => {
  it("every 2xx JSON response of the seven operations has at least one example and it validates against its schema", () => {
    let n = 0;
    for (const id of Object.keys(NEW_OPS)) {
      const m = okResponse(id)?.content?.["application/json"];
      if (!m) { expect(id, "only the template download is not JSON").toBe("downloadPriceListTemplate"); continue; }
      const ex = Object.entries<any>(m.examples ?? {});
      expect(ex.length, `${id}: example`).toBeGreaterThan(0);
      const v = ajv.compile({ $ref: `catalog.yaml#/components/schemas/${refName(m.schema)}` });
      for (const [k, e] of ex) { expect(v(e.value), `${id}/${k}: ${JSON.stringify(v.errors?.[0])}`).toBe(true); n++; }
    }
    expect(n).toBeGreaterThanOrEqual(6);
  });

  it("the dry run has an example WITH error rows (row_no and column) and the batch count matches", () => {
    const ex = Object.values<any>(okResponse("dryRunPriceListImport").content["application/json"].examples).map((e) => e.value);
    const withErrors = ex.filter((v) => Array.isArray(v.errors) && v.errors.length > 0);
    expect(withErrors.length, "a dry run example with errors").toBeGreaterThan(0);
    for (const v of withErrors) {
      for (const e of v.errors) { expect(Number.isInteger(e.row_no) && e.row_no >= 1).toBe(true); expect(typeof e.column).toBe("string"); expect(typeof e.code).toBe("string"); }
      expect(v.batch.error_count, "batch.error_count equals the listed errors").toBe(v.errors.length);
      expect(v.batch.status).toBe("dry_run");
    }
    expect(ex.some((v) => v.errors.length === 0 && v.batch.error_count === 0), "a clean dry run example").toBe(true);
  });

  it("the multipart request example and the request examples of bulk update, copy and assignments validate", () => {
    const bu = opOf("bulkUpdatePriceListDraft")!.op.requestBody.content["application/json"].examples;
    const cp = opOf("copyPriceList")!.op.requestBody.content["application/json"].examples;
    expect(Object.keys(bu ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(cp ?? {}).length).toBeGreaterThan(0);
    for (const e of Object.values<any>(bu)) expect(validator("PriceListBulkUpdate")(e.value)).toBe(true);
    for (const e of Object.values<any>(cp)) expect(validator("PriceListCopy")(e.value)).toBe(true);
    expect(Object.keys(opOf("dryRunPriceListImport")!.op.requestBody.content["multipart/form-data"].examples ?? {}).length).toBeGreaterThan(0);
  });

  it("schemas reject bad payloads: bad status, negative counts, row 0, over 5 MB, bad hash", () => {
    const b = { id: UUID, price_list_id: UUID, status: "dry_run", row_count: 3, error_count: 0, file_sha256: SHA, summary: {}, created_at: "2026-11-17T10:00:00.000Z", created_by: UUID2 };
    const v = validator("PriceListImportBatch");
    for (const bad of [{ status: "uploaded" }, { row_count: -1 }, { row_count: 5001 }, { error_count: -1 }, { file_sha256: "XYZ" }, { file_ref: "files/x" }]) expect(v({ ...b, ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
    const e = validator("PriceListImportError");
    expect(e({ row_no: 2, column: "price", code: "price_invalid", message: "Synthetic: more than 2 decimals" })).toBe(true);
    for (const bad of [{ row_no: 0 }, { row_no: 1.5 }, { message: "" }, { code: "" }]) expect(e({ row_no: 2, column: "price", code: "price_invalid", message: "x", ...bad }), `accepted ${JSON.stringify(bad)}`).toBe(false);
  });
});

describe("T0C-PRICETOOLS-1 generated clients (codegen is fresh)", () => {
  it("generated clients and MSW handlers are fresh (codegen --check)", () => {
    expect(staleFiles(ROOT)).toEqual([]);
  }, 120_000);
});

describe("T0C-PRICETOOLS-1 migration file (static; behaviour in the pgTAP suite) (done_when 2, 7)", () => {
  const path = join(ROOT, "db/migrations", MIG);
  const text = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
  const code = text.split("\n").filter((l) => !/^\s*--/.test(l)).map((l) => l.replace(/--.*$/, "")).join("\n");
  const comments = text.split("\n").filter((l) => /^\s*--/.test(l)).join("\n");

  it("exists, is the only 20261117200000 migration, is newer than the TESTMGMT migration, runs as lims_owner", () => {
    expect(existsSync(path), `db/migrations/${MIG} missing`).toBe(true);
    const all = readdirSync(join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql")).sort();
    expect(all.filter((f) => f.startsWith("20261117200000"))).toEqual([MIG]);
    expect(all.indexOf(MIG)).toBeGreaterThan(all.indexOf("20261117170000_catalog__test_management_parity.sql"));
    expect(code).toMatch(/SET LOCAL ROLE lims_owner/);
  });
  it("creates the two tables with IF NOT EXISTS, tenant_id, created_at, RLS enabled and forced, a policy per command guarded by pg_policy", () => {
    for (const t of ["price_list_import_batch", "price_list_import_error"]) {
      expect(code, t).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS catalog\\.${t}\\b`, "i"));
      expect(code, `${t} ENABLE RLS`).toMatch(new RegExp(`ALTER TABLE catalog\\.${t}\\s+ENABLE ROW LEVEL SECURITY`, "i"));
      expect(code, `${t} FORCE RLS`).toMatch(new RegExp(`ALTER TABLE catalog\\.${t}\\s+FORCE ROW LEVEL SECURITY`, "i"));
      expect(code, `${t} select policy`).toMatch(new RegExp(`CREATE POLICY ${t}__select__tenant ON catalog\\.${t} FOR SELECT`, "i"));
      expect(code, `${t} insert policy`).toMatch(new RegExp(`CREATE POLICY ${t}__insert__tenant ON catalog\\.${t} FOR INSERT`, "i"));
      const block = code.slice(code.search(new RegExp(`CREATE TABLE IF NOT EXISTS catalog\\.${t}\\b`, "i")));
      expect(block.slice(0, 2500), `${t} has tenant_id and created_at`).toMatch(/tenant_id\s+uuid\s+NOT NULL/i);
      expect(block.slice(0, 2500)).toMatch(/created_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/i);
    }
    expect(code).toMatch(/CREATE POLICY price_list_import_batch__update__tenant ON catalog\.price_list_import_batch FOR UPDATE/i);
    expect(code, "the error table is append only: no UPDATE policy").not.toMatch(/price_list_import_error__update/i);
    expect(code).not.toMatch(/GRANT[^;]*\bDELETE\b[^;]*price_list_import/i);
    expect(code).toMatch(/GRANT SELECT, INSERT, UPDATE ON catalog\.price_list_import_batch TO lims_app/i);
    expect(code).toMatch(/GRANT SELECT, INSERT ON catalog\.price_list_import_error TO lims_app/i);
    expect((code.match(/CREATE TABLE(?! IF NOT EXISTS)/gi) ?? []).length, "every CREATE TABLE is IF NOT EXISTS").toBe(0);
    expect(code.match(/CREATE POLICY/gi)?.length ?? 0).toBeGreaterThanOrEqual(5);
    for (const m of code.matchAll(/CREATE POLICY (\w+)/gi)) expect(code, `policy ${m[1]} must be guarded by pg_policy`).toMatch(new RegExp(`pg_policy[^;]*${m[1]}`, "i"));
  });
  it("adds effective_from and effective_to to the assignments with ADD COLUMN IF NOT EXISTS and states the overlap rule (exclusion constraint or trigger)", () => {
    for (const f of ["effective_from", "effective_to"]) expect(code, f).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+"?${f}"?\\s+timestamptz`, "i"));
    expect(code).toMatch(/price_list_assignments/);
    expect(code, "effective_from NOT NULL needs a DEFAULT (no rewrite decision for existing rows)").toMatch(/ADD COLUMN IF NOT EXISTS\s+"?effective_from"?\s+timestamptz\s+NOT NULL\s+DEFAULT/i);
    expect(code).toMatch(/effective_to\s*>\s*effective_from/i);
    expect(code, "no overlap rule found").toMatch(/EXCLUDE\s+USING|CREATE (OR REPLACE )?TRIGGER\s+\w+\s+(BEFORE|AFTER)\s+(INSERT|UPDATE)/i);
    if (/EXCLUDE\s+USING\s+gist/i.test(code)) expect(code, "a gist exclusion on uuid columns needs btree_gist").toMatch(/btree_gist/i);
  });
  it("is additive and rewrite-free: only the three old one-row-per-party indexes may be dropped; no data statement, no type change, no policy change on existing tables", () => {
    expect(code.length, "migration missing or empty").toBeGreaterThan(0);
    expect(code).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+\S+\s+SET|REVOKE|DROP\s+TABLE|DROP\s+COLUMN|DROP\s+SCHEMA|DROP\s+POLICY)\b/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN|ALTER\s+TABLE\s+\S+\s+(RENAME|OWNER)/i);
    expect(code).not.toMatch(/DISABLE\s+ROW|NO\s+FORCE|ALTER\s+POLICY|\bCREATE\s+TYPE\b|\bAS\s+ENUM\b/i);
    const dropped = [...code.matchAll(/DROP\s+INDEX\s+(IF EXISTS\s+)?(?:catalog\.)?"?(\w+)"?/gi)].map((m) => m[2]).sort();
    expect(dropped, "the three partial unique indexes of the old one-row-per-party rule").toEqual([
      "price_list_assignments__tenant_id_centre_id__p_uq", "price_list_assignments__tenant_id_credit_party_id__p_uq", "price_list_assignments__tenant_id_doctor_id__p_uq"]);
    for (const m of code.matchAll(/DROP\s+INDEX\s+(?!IF EXISTS)/gi)) throw new Error(`unguarded DROP INDEX near ${m.index}`);
    for (const m of code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/gi)) throw new Error(`unguarded CREATE INDEX near ${m.index}`);
    for (const m of code.matchAll(/ADD\s+CONSTRAINT/gi)) expect(code.slice(Math.max(0, m.index! - 1500), m.index), "ADD CONSTRAINT must sit in a DO block that checks pg_constraint first").toMatch(/DO\s+\$[a-z_]*\$[\s\S]*pg_constraint/i);
    for (const m of code.matchAll(/ADD\s+COLUMN\s+IF NOT EXISTS\s+"?(\w+)"?\s+([^,;]*)/gi)) if (/\bNOT\s+NULL\b/i.test(m[2])) expect(m[2], `column ${m[1]}: NOT NULL needs a DEFAULT`).toMatch(/\bDEFAULT\b/i);
  });
  it("value checks: status list, row_count 0..5000, error_count, sha256 hex, row_no >= 1", () => {
    for (const v of BATCH_STATUS) expect(code, `status check names ${v}`).toContain(`'${v}'`);
    expect(code).toMatch(/row_count\s+BETWEEN\s+0\s+AND\s+5000|row_count\s*>=\s*0[\s\S]{0,60}row_count\s*<=\s*5000/i);
    expect(code).toMatch(/error_count\s*>=\s*0|error_count\s+BETWEEN\s+0/i);
    expect(code).toMatch(/\[0-9a-f\]\{64\}/);
    expect(code).toMatch(/row_no\s*>=\s*1|row_no\s+BETWEEN\s+1/i);
    expect(code, "composite tenant FKs").toMatch(/FOREIGN KEY \(tenant_id, price_list_id\) REFERENCES catalog\.price_lists \(tenant_id, id\)/i);
    expect(code).toMatch(/FOREIGN KEY \(tenant_id, batch_id\) REFERENCES catalog\.price_list_import_batch \(tenant_id, id\)/i);
  });
  it("comments: LD-321, down note, no data rewrite, push-cloud, the dropped indexes and the new tables named", () => {
    expect(comments).toMatch(/LD-321/);
    expect(comments).toMatch(/\bdown\b/i);
    expect(comments).toMatch(/DROP TABLE/i);
    expect(comments).toMatch(/DROP COLUMN/i);
    expect(comments).toMatch(/no data rewrite|does not rewrite|no rewrite/i);
    expect(comments).toMatch(/push-cloud/i);
    for (const w of ["price_list_import_batch", "price_list_import_error", "effective_from", "effective_to", "price_list_assignments__tenant_id_credit_party_id__p_uq"]) expect(comments, `comments name ${w}`).toContain(w);
  });
  it("db/meta/tables.yaml registers both tables and the two assignment columns; db/policies/catalog.sql carries their policies", () => {
    const meta = readFileSync(join(ROOT, "db/meta/tables.yaml"), "utf8");
    for (const t of ["catalog.price_list_import_batch", "catalog.price_list_import_error"]) expect(meta, t).toContain(`"${t}"`);
    const line = meta.split("\n").find((l) => l.includes('"catalog.price_list_assignments"')) ?? "";
    for (const f of ["effective_from", "effective_to"]) expect(line, `tables.yaml price_list_assignments column ${f}`).toContain(`"${f}"`);
    const pol = readFileSync(join(ROOT, "db/policies/catalog.sql"), "utf8");
    for (const t of ["price_list_import_batch", "price_list_import_error"]) expect(pol, t).toContain(`${t}__select__tenant`);
    expect(pol).toContain("price_list_import_batch__update__tenant");
  });
});

describe("T0C-PRICETOOLS-1 implementation notes: FIELD MAP, party type map, offline rule (done_when 1, 7)", () => {
  const t = existsSync(NOTES) ? readFileSync(NOTES, "utf8") : "";
  const lines = t.split("\n");
  const decisionLine = (label: string, extra?: RegExp) => lines.find((x) => {
    const s = x.replace(/^[\s|*\-•>`_#]+/, "").toLowerCase();
    const l = label.toLowerCase();
    if (!s.startsWith(l)) return false;
    const rest = s.slice(l.length).replace(/^[*`_\s]+/, "");
    return (rest === "" || /^[—–\-:|=(]/.test(rest)) && /already present|added|not added|deliberately not/i.test(x) && (extra ? extra.test(x) : true);
  });
  it("notes exist, name the migration, say the cloud migration is a founder step (push-cloud), the 7 pending operation ids and the T0B task", () => {
    expect(existsSync(NOTES), ".orchestra/notes/T0C-PRICETOOLS-1-impl.md missing").toBe(true);
    expect(t).toContain(MIG);
    expect(t).toMatch(/push-cloud/i);
    expect(t).toMatch(/founder/i);
    expect(t).toMatch(/pendingOperations/);
    for (const id of Object.keys(NEW_OPS)) expect(t, id).toContain(id);
    expect(t).toMatch(/T0B-PRICETOOLS-1/);
    expect(t).toMatch(/LD-321/);
  });
  it("every ElabAssist field label has one decision line: already present (field named), added (field named) or not added (reason)", () => {
    expect(t.length, "impl notes missing").toBeGreaterThan(0);
    const missing = LABELS.filter((l) => !decisionLine(l));
    expect(missing, `labels without a decision line: ${missing.join(" | ")}`).toEqual([]);
  });
  it("'not added' decisions carry a reason", () => {
    const bad = lines.filter((x) => /deliberately not added|not added/i.test(x) && !/because|reason|why|\bsince\b|—|: .{12,}/i.test(x));
    expect(bad, `not-added lines without a reason: ${bad.slice(0, 3).join(" || ")}`).toEqual([]);
  });
  it("the six party types each map onto an existing assignment kind (Doctor -> referrer, Collection Center -> centre, Rate Master -> the default list, Franchise, Laboratory and Client -> credit party)", () => {
    for (const [type, re] of Object.entries(PARTY_MAP)) expect(decisionLine(type, re), `party type ${type} must map onto an existing assignment (${re})`).toBeDefined();
    expect(t).toMatch(/Rate Master[^\n]*(named )?default (price )?list|default (price )?list[^\n]*Rate Master/i);
    expect(t).toMatch(/not an equation|no equation engine|equation[^\n]*not built|not built[^\n]*equation/i);
  });
  it("gives the offline classification (founder 09:19): import, bulk update, copy and compare are online only; billing price reads stay cached for offline use", () => {
    expect(t).toMatch(/offline/i);
    expect(t).toMatch(/online only|online-only/i);
    for (const w of ["import", "bulk update", "copy", "compare"]) expect(t.toLowerCase(), `offline note names ${w}`).toContain(w);
    expect(t).toMatch(/cache/i);
    expect(t).toMatch(/billing/i);
    expect(t).toMatch(/09:19/);
  });
  it("records what stays with the founder or later tasks: no price changed, no cloud apply, no service or web change", () => {
    expect(t).toMatch(/no (service|handler)/i);
    expect(t).toMatch(/draft/i);
    expect(t).toMatch(/apps\/web\/src\/features\/admin|rs-c2/i);
  });
});
