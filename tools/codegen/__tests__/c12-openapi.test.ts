// T0C-10.C12 / AC-0C-1.4, AC-0C-1.5 — contracts/openapi/inventory.yaml (C12 transcription of spec/chunks/C12-inventory/02-TRD.md §5, §6; LD-103).
// Checks: (1) exists, openapi 3.0.3 first; (2) repo lint (T0C-04 lintRepo) clean for inventory.yaml; (3) AC-0C-1.5 negatives on a temp copy;
// (4) inventory = TRD §5 tables (93 ops: #1–#93), method+path, x-permission (first code of the Permission column), bearerJwt, x-idempotency, tier general,
// success status, specific + common error codes, Idempotency-Key on R rows, If-Match on PATCH / actions / draft-replace PUTs;
// (5) shape pins from §5/§6 (params, enums, bounds, line caps, quantity/money patterns, server-authority fields absent, cost fields optional (REQ-SEC-081),
// fact internals never returned, CSV exports); (6) "Prism smoke" offline: examples validate (ajv), every op has a servable 2xx example, examples synthetic;
// (7) package.json `mock:inventory` script.
// Not testable here: Prism actually serving the file (prism not installed; mock wiring is T0C-08), generated-client freshness (codegen-fresh suite).
// Assumptions (TRD silent or ambiguous; each is also in the notes file):
//  - every op lists the six common codes (TRD §5 intro) ; PATCH + action POSTs + draft-replace PUTs carry If-Match and common.version_conflict / precondition_required
//    (upsert PUTs #16 #22 #24 #27 #29 #66 are NOT pinned either way); Optional-idem ops pin no Idempotency-Key header (wave 1 convention: none declared);
//  - x-permission = FIRST code of the Permission column (TRD §5 "+ code when" rule), so #89 = inventory.cost.read, #55/#93 = inventory.report.export;
//  - auth.mfa_required pinned only where a privileged code is added by "+" (#50 #53 #55 #86 #93); #12 Idem column says O but the §5 rule says creates are R → #12 idem NOT pinned (CR-worthy);
//  - catalog.tax_config_missing on #50 #52 #81 #83 (TRD §14); DTO component names = the TRD names (ItemCreate, PoSummary, ReportResult, ...);
//  - CSV exports: only text/csv, with Content-Disposition + Cache-Control headers (03-APP-FLOW line 289); coded sets (reason_code, uom_code, tax_code) carry no enum.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { lintRepo } from "../lint-openapi";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TRD = join(ROOT, "spec/chunks/C12-inventory/02-TRD.md");
const FILE = join(ROOT, "contracts/openapi/inventory.yaml");
const common: any = parse(readFileSync(join(ROOT, "contracts/openapi/_common.yaml"), "utf8"));
const METHODS = ["get", "put", "post", "delete", "patch"];
const name = "inventory";
const PFX = "/v1/inventory";

const IT = "inventory.item.read", MM = "inventory.master.manage", SM = "inventory.stock.manage", SA = "inventory.stock.adjust", BR = "inventory.bench.record";
const PM = "inventory.po.manage", PA = "inventory.po.approve", CR = "inventory.cost.read", RE = "inventory.report.export";
const i = (c: string) => `inventory.${c}`;
const VF = "common.validation_failed", NF = "common.not_found", FB = "auth.forbidden", MFA = "auth.mfa_required";
const VC = "common.version_conflict", PRE = "common.precondition_required", IMM = "common.immutable_record";
const IDEM = ["common.idempotency_key_required", "common.idempotency_key_reused", "common.idempotency_in_progress"];
const SIX = [VF, NF, FB, "auth.unauthenticated", "common.rate_limited", "common.internal"];
const TAX = "catalog.tax_config_missing";
const DIT = i("document_invalid_transition"), POT = i("po_invalid_transition"), INS = i("insufficient_stock"), EXPD = i("lot_expired"), UNAV = i("lot_unavailable");
const LOCK = i("store_locked_for_count"), UOM = i("uom_mismatch"), RR = i("reason_required"), DUP = i("code_duplicate"), RNG = i("range_too_large"), BIG = i("export_too_large");

type Spec = { n: number; id: string; method: string; path: string; perm: string; idem: "none" | "optional" | "required" | "skip"; status: number;
  err: string[]; im?: boolean; paged?: boolean; csv?: boolean; not?: string[] };
const N = "none" as const, O = "optional" as const, R = "required" as const;
const S = (n: number, id: string, method: string, path: string, perm: string, idem: Spec["idem"], status: number, err: string[], o: Partial<Spec> = {}): Spec =>
  ({ n, id, method, path, perm, idem, status, err, ...o });
const L = { paged: true }, A = { im: true }; // list / If-Match action
const G = (n: number, id: string, path: string, perm = IT, o: Partial<Spec> = {}) => S(n, id, "GET", path, perm, N, 200, [], { im: false, ...o });

const SPECS: Spec[] = [
  // 5.1 master data
  G(1, "listInventoryItems", "/items", IT, L),
  S(2, "createInventoryItem", "POST", "/items", MM, R, 201, [DUP, ...IDEM], { im: false }),
  G(3, "getInventoryItem", "/items/{item_id}"),
  S(4, "updateInventoryItem", "PATCH", "/items/{item_id}", MM, N, 200, [IMM, VC, PRE], A),
  S(5, "setInventoryItemActive", "POST", "/items/{item_id}/set-active", MM, O, 200, [i("item_in_use"), VC, PRE], A),
  S(6, "createInventoryItemPack", "POST", "/items/{item_id}/packs", MM, R, 201, [DUP, ...IDEM], { im: false }),
  S(7, "updateInventoryItemPack", "PATCH", "/items/{item_id}/packs/{pack_id}", MM, N, 200, [IMM, VC, PRE], A),
  S(8, "addInventoryItemBarcode", "POST", "/items/{item_id}/barcodes", MM, R, 201, [DUP, ...IDEM], { im: false }),
  S(9, "deactivateInventoryItemBarcode", "POST", "/items/{item_id}/barcodes/{barcode_id}/deactivate", MM, O, 200, [VC, PRE], A),
  S(10, "lookupInventoryBarcode", "POST", "/barcodes/lookup", IT, O, 200, [], { im: false }),
  G(11, "listInventoryStores", "/stores", IT, L),
  S(12, "createInventoryStore", "POST", "/stores", MM, "skip", 201, [DUP, VF], { im: false }),
  G(13, "getInventoryStore", "/stores/{store_id}"),
  S(14, "updateInventoryStore", "PATCH", "/stores/{store_id}", MM, N, 200, [i("store_not_empty"), VC, PRE], A),
  G(15, "listStoreItemSettings", "/stores/{store_id}/item-settings", IT, L),
  S(16, "putStoreItemSetting", "PUT", "/stores/{store_id}/item-settings/{item_id}", MM, N, 200, []),
  G(17, "listInventorySuppliers", "/suppliers", IT, L),
  S(18, "createInventorySupplier", "POST", "/suppliers", MM, R, 201, [DUP, ...IDEM], { im: false }),
  G(19, "getInventorySupplier", "/suppliers/{supplier_id}"),
  S(20, "updateInventorySupplier", "PATCH", "/suppliers/{supplier_id}", MM, N, 200, [VC, PRE], A),
  G(21, "listSupplierItems", "/suppliers/{supplier_id}/items", IT, L),
  S(22, "putSupplierItem", "PUT", "/suppliers/{supplier_id}/items/{item_id}/packs/{pack_id}", MM, N, 200, [UOM]),
  G(23, "listInstrumentBindings", "/instrument-bindings", IT, L),
  S(24, "putInstrumentBinding", "PUT", "/instrument-bindings/{instrument_id}", MM, N, 200, []),
  S(25, "deactivateInstrumentBinding", "POST", "/instrument-bindings/{instrument_id}/deactivate", MM, O, 200, [VC, PRE], A),
  G(26, "getInventorySettings", "/settings"),
  S(27, "updateInventorySettings", "PUT", "/settings", MM, N, 200, [VF]),
  G(28, "listInventoryCodedSet", "/coded-sets/{set_name}"),
  S(29, "putInventoryTenantCode", "PUT", "/coded-sets/{set_name}/codes/{code}", MM, N, 200, []),
  // 5.2 stock, lots, containers
  G(30, "listInventoryLots", "/lots", IT, L),
  G(31, "getInventoryLot", "/lots/{lot_id}"),
  S(32, "setInventoryLotStatus", "POST", "/lots/{lot_id}/set-status", SA, O, 200, [RR, VC, PRE], A),
  S(33, "correctInventoryLotExpiry", "POST", "/lots/{lot_id}/correct-expiry", SA, O, 200, [RR, VC, PRE], A),
  G(34, "listStockBalances", "/stock", IT, L),
  G(35, "listStockMovements", "/movements", IT, L),
  G(36, "getFefoSuggestion", "/fefo-suggestions"),
  G(37, "listOpenedContainers", "/containers", IT, L),
  S(38, "openContainer", "POST", "/containers", BR, R, 201, [EXPD, UNAV, INS, ...IDEM], { im: false }),
  S(39, "finishContainer", "POST", "/containers/{container_id}/finish", BR, O, 200, [DIT, VC, PRE], A),
  S(40, "discardContainer", "POST", "/containers/{container_id}/discard", BR, R, 200, [RR, DIT, VC, PRE, ...IDEM], A),
  // 5.3 documents
  G(41, "listStockDocuments", "/stock-documents", IT, L),
  G(42, "getStockDocument", "/stock-documents/{document_id}"),
  S(43, "createStockIssue", "POST", "/issues", SM, R, 201, [INS, EXPD, UNAV, i("item_inactive"), UOM, LOCK, ...IDEM], { im: false }),
  S(44, "createStoreReturn", "POST", "/store-returns", SM, R, 201, [EXPD, UNAV, i("item_inactive"), UOM, LOCK, ...IDEM], { im: false, not: [INS] }),
  S(45, "createSupplierReturn", "POST", "/supplier-returns", SM, R, 201, [INS, RR, ...IDEM], { im: false }),
  S(46, "recordWastage", "POST", "/wastage", SM, R, 201, [RR, INS, ...IDEM], { im: false }),
  S(47, "writeOffExpiredStock", "POST", "/expiry-writeoffs", SM, R, 201, [VF, ...IDEM], { im: false }),
  S(48, "createStockAdjustment", "POST", "/adjustments", SA, R, 201, [RR, INS, LOCK, ...IDEM], { im: false }),
  // 5.4 goods receipts
  G(49, "listGoodsReceipts", "/goods-receipts", IT, L),
  S(50, "createGoodsReceipt", "POST", "/goods-receipts", SM, R, 201, [POT, TAX, MFA, FB, ...IDEM], { im: false }),
  G(51, "getGoodsReceipt", "/goods-receipts/{grn_id}"),
  S(52, "replaceGoodsReceiptDraft", "PUT", "/goods-receipts/{grn_id}", SM, N, 200, [DIT, TAX, VC, PRE], A),
  S(53, "postGoodsReceipt", "POST", "/goods-receipts/{grn_id}/post", SM, R, 200, [DIT, i("over_receipt"), EXPD, LOCK, MFA, VC, PRE, ...IDEM], A),
  S(54, "cancelGoodsReceipt", "POST", "/goods-receipts/{grn_id}/cancel", SM, O, 200, [DIT, VC, PRE], A),
  G(55, "exportGoodsReceiptsCsv", "/goods-receipts/export.csv", RE, { csv: true, err: [BIG, MFA] }),
  // 5.5 transfers
  G(56, "listTransfers", "/transfers", IT, L),
  S(57, "createTransfer", "POST", "/transfers", SM, R, 201, [UOM, ...IDEM], { im: false }),
  G(58, "getTransfer", "/transfers/{transfer_id}"),
  S(59, "replaceTransferDraft", "PUT", "/transfers/{transfer_id}", SM, N, 200, [DIT, VC, PRE], A),
  S(60, "dispatchTransfer", "POST", "/transfers/{transfer_id}/dispatch", SM, R, 200, [INS, EXPD, UNAV, LOCK, DIT, VC, PRE, ...IDEM], A),
  S(61, "receiveTransfer", "POST", "/transfers/{transfer_id}/receive", SM, R, 200, [RR, DIT, LOCK, VC, PRE, ...IDEM], A),
  S(62, "cancelTransfer", "POST", "/transfers/{transfer_id}/cancel", SM, O, 200, [DIT, VC, PRE], A),
  // 5.6 stock counts
  G(63, "listStockCounts", "/stock-counts", IT, L),
  S(64, "openStockCount", "POST", "/stock-counts", SM, R, 201, [i("count_already_open"), ...IDEM], { im: false }),
  G(65, "getStockCount", "/stock-counts/{count_id}", IT, L),
  S(66, "recordStockCountLines", "PUT", "/stock-counts/{count_id}/lines", SM, N, 200, [DIT]),
  S(67, "postStockCount", "POST", "/stock-counts/{count_id}/post", SA, R, 200, [DIT, VC, PRE, ...IDEM], A),
  S(68, "cancelStockCount", "POST", "/stock-counts/{count_id}/cancel", SM, O, 200, [DIT, VC, PRE], A),
  // 5.7 consumption
  G(69, "listConsumptionRules", "/consumption-rules", IT, L),
  S(70, "createConsumptionRule", "POST", "/consumption-rules", MM, R, 201, [i("rule_conflict"), UOM, VF, ...IDEM], { im: false }),
  G(71, "getConsumptionRule", "/consumption-rules/{rule_id}"),
  S(72, "supersedeConsumptionRule", "POST", "/consumption-rules/{rule_id}/supersede", MM, R, 201, [DIT, VC, PRE, ...IDEM], A),
  S(73, "deactivateConsumptionRule", "POST", "/consumption-rules/{rule_id}/deactivate", MM, O, 200, [VC, PRE], A),
  S(74, "previewConsumption", "POST", "/consumption-rules/preview", IT, O, 200, [], { im: false }),
  G(75, "listConsumptionFacts", "/consumption-facts", IT, L),
  S(76, "logConsumptionEvent", "POST", "/consumption-events", BR, R, 201, [VF, FB, ...IDEM], { im: false }),
  S(77, "resolveConsumptionFact", "POST", "/consumption-facts/{fact_id}/resolve", MM, R, 200, [DIT, VC, PRE, ...IDEM], A),
  S(78, "dismissConsumptionFact", "POST", "/consumption-facts/{fact_id}/dismiss", MM, O, 200, [DIT, RR, VC, PRE], A),
  S(79, "reverseConsumptionFact", "POST", "/consumption-facts/{fact_id}/reverse", SA, R, 200, [i("fact_not_reversible"), DIT, VC, PRE, ...IDEM], A),
  // 5.8 purchase orders
  G(80, "listPurchaseOrders", "/purchase-orders", IT, L),
  S(81, "createPurchaseOrder", "POST", "/purchase-orders", PM, R, 201, [UOM, i("item_inactive"), TAX, ...IDEM], { im: false }),
  G(82, "getPurchaseOrder", "/purchase-orders/{po_id}"),
  S(83, "replacePurchaseOrderDraft", "PUT", "/purchase-orders/{po_id}", PM, N, 200, [POT, TAX, VC, PRE], A),
  S(84, "approvePurchaseOrder", "POST", "/purchase-orders/{po_id}/approve", PA, R, 200, [POT, i("po_self_approval_forbidden"), VF, VC, PRE, ...IDEM], A),
  S(85, "markPurchaseOrderSent", "POST", "/purchase-orders/{po_id}/mark-sent", PM, O, 200, [POT, VC, PRE], A),
  S(86, "cancelPurchaseOrder", "POST", "/purchase-orders/{po_id}/cancel", PM, R, 200, [POT, RR, MFA, VC, PRE, ...IDEM], A),
  S(87, "closePurchaseOrder", "POST", "/purchase-orders/{po_id}/close", PM, R, 200, [POT, RR, VC, PRE, ...IDEM], A),
  S(88, "createPurchaseOrdersFromReorder", "POST", "/purchase-orders/from-reorder", PM, R, 201, IDEM, { im: false }),
  G(89, "getPurchaseOrderPrintView", "/purchase-orders/{po_id}/print-view", CR),
  // 5.9 alerts and reports
  G(90, "listInventoryAlerts", "/alerts", IT, L),
  S(91, "acknowledgeInventoryAlert", "POST", "/alerts/{alert_id}/acknowledge", SM, O, 200, [DIT, VC, PRE], A),
  G(92, "getInventoryReport", "/reports/{report_code}", IT, { err: [RNG] }),
  G(93, "exportInventoryReport", "/reports/{report_code}/export.csv", RE, { csv: true, err: [BIG, RNG, MFA] }),
];
const TOTAL = 93;

const DTOS = ["ItemSummary", "Item", "ItemCreate", "ItemPatch", "Pack", "Barcode", "Store", "StoreItemSetting", "Supplier", "SupplierSummary", "SupplierCreate",
  "SupplierPatch", "SupplierItem", "Binding", "Settings", "SettingsUpdate", "InventoryCodedSetEntry", "Lot", "BalanceRow", "Movement", "FefoSuggestion", "Container", "StockDocument",
  "StockDocumentSummary", "Grn", "GrnDraft", "GrnSummary", "Transfer", "TransferSummary", "Count", "CountSummary", "CountLine", "Rule", "Fact", "PoSummary", "Po",
  "PoPrintView", "Alert", "ReportResult", "ColumnMeta"];
// list ops → item DTO (#11 skipped: transfer_target returns a reduced Store)
const LIST_ITEM: Record<string, string> = { listInventoryItems: "ItemSummary", listStoreItemSettings: "StoreItemSetting", listInventorySuppliers: "SupplierSummary",
  listSupplierItems: "SupplierItem", listInstrumentBindings: "Binding", listInventoryLots: "Lot", listStockBalances: "BalanceRow", listStockMovements: "Movement",
  listOpenedContainers: "Container", listStockDocuments: "StockDocumentSummary", listGoodsReceipts: "GrnSummary", listTransfers: "TransferSummary",
  listStockCounts: "CountSummary", listConsumptionRules: "Rule", listConsumptionFacts: "Fact", listPurchaseOrders: "PoSummary", listInventoryAlerts: "Alert" };
// single-object ops → DTO whose properties the response must include
const ONE: Record<string, string> = { createInventoryItem: "Item", getInventoryItem: "Item", updateInventoryItem: "Item", setInventoryItemActive: "Item",
  createInventoryItemPack: "Pack", updateInventoryItemPack: "Pack", addInventoryItemBarcode: "Barcode", deactivateInventoryItemBarcode: "Barcode",
  createInventoryStore: "Store", getInventoryStore: "Store", updateInventoryStore: "Store", putStoreItemSetting: "StoreItemSetting", createInventorySupplier: "Supplier",
  getInventorySupplier: "Supplier", updateInventorySupplier: "Supplier", putSupplierItem: "SupplierItem", putInstrumentBinding: "Binding",
  deactivateInstrumentBinding: "Binding", getInventorySettings: "Settings", updateInventorySettings: "Settings", putInventoryTenantCode: "InventoryCodedSetEntry", getInventoryLot: "Lot",
  setInventoryLotStatus: "Lot", correctInventoryLotExpiry: "Lot", getFefoSuggestion: "FefoSuggestion", openContainer: "Container", finishContainer: "Container",
  getStockDocument: "StockDocument", createStockIssue: "StockDocument", createStoreReturn: "StockDocument", createSupplierReturn: "StockDocument",
  recordWastage: "StockDocument", writeOffExpiredStock: "StockDocument", createStockAdjustment: "StockDocument", createGoodsReceipt: "Grn", getGoodsReceipt: "Grn",
  replaceGoodsReceiptDraft: "Grn", postGoodsReceipt: "Grn", cancelGoodsReceipt: "Grn", createTransfer: "Transfer", getTransfer: "Transfer",
  replaceTransferDraft: "Transfer", dispatchTransfer: "Transfer", receiveTransfer: "Transfer", cancelTransfer: "Transfer", openStockCount: "Count",
  getStockCount: "Count", postStockCount: "Count", cancelStockCount: "Count", createConsumptionRule: "Rule", getConsumptionRule: "Rule",
  supersedeConsumptionRule: "Rule", deactivateConsumptionRule: "Rule", logConsumptionEvent: "Fact", resolveConsumptionFact: "Fact", dismissConsumptionFact: "Fact",
  reverseConsumptionFact: "Fact", createPurchaseOrder: "Po", getPurchaseOrder: "Po", replacePurchaseOrderDraft: "Po", approvePurchaseOrder: "Po",
  markPurchaseOrderSent: "Po", cancelPurchaseOrder: "Po", closePurchaseOrder: "Po", acknowledgeInventoryAlert: "Alert", getPurchaseOrderPrintView: "PoPrintView",
  getInventoryReport: "ReportResult" };
const PHI_PARAMS = ["barcode", "sample_barcode", "registration_no", "patient_id", "patient_name", "patient_display_name", "phone", "phone_e164", "email", "full_name", "name", "query"];
const FORBIDDEN_REQ = ["tenant_id", "created_by", "updated_by", "totals", "net_paisa", "vat_paisa", "line_total_paisa", "capitalised_value_paisa", "value_paisa"];
const FORBIDDEN_ANY = ["tenant_id", "created_by", "updated_by", "basis_key", "source_event_id"];
const DEC_BASE = "^[0-9]{1,12}(\\.[0-9]{1,6})?$", DEC_PACKS = "^[0-9]{1,9}(\\.[0-9]{1,3})?$";
const REPORT_CODES = ["daily_consumption", "analyser_consumption", "cost_per_test", "wastage", "expiry", "stock_valuation", "consumption_reconciliation"];

const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("inventory.yaml (T0C-10.C12)", () => {
  const text = existsSync(FILE) ? readFileSync(FILE, "utf8") : "";
  const doc: any = text ? parse(text) : { paths: {}, components: {} };
  const ops: Record<string, { method: string; path: string; op: any }> = {};
  for (const [path, item] of Object.entries<any>(doc.paths ?? {}))
    for (const m of METHODS) if (item?.[m]) ops[item[m].operationId] = { method: m.toUpperCase(), path, op: item[m] };

  const deref = (n: any): any => {
    if (!n?.$ref) return n;
    const [file, ptr] = n.$ref.split("#");
    let cur: any = file === "_common.yaml" ? common : doc;
    for (const k of ptr.split("/").slice(1)) cur = cur?.[k.replace(/~1/g, "/").replace(/~0/g, "~")];
    return deref(cur);
  };
  const props = (s: any): Record<string, any> => {
    const n = deref(s) ?? {};
    return Object.assign({}, ...(n.allOf ?? []).map(props), n.properties ?? {});
  };
  const reqd = (s: any): string[] => {
    const n = deref(s) ?? {};
    return [...(n.required ?? []), ...(n.allOf ?? []).flatMap(reqd)];
  };
  const keys = (s: any) => Object.keys(props(s));
  const schema = (n: string) => doc.components?.schemas?.[n];
  const prop = (n: string, f: string) => deref(props(schema(n))[f]);
  const bodySchema = (id: string) => deref(ops[id]?.op.requestBody?.content?.["application/json"]?.schema);
  const bp = (id: string, f: string) => deref(props(bodySchema(id))[f]);
  const params = (id: string) => (ops[id]?.op.parameters ?? []).map(deref);
  const param = (id: string, pname: string) => params(id).find((p: any) => p?.name === pname);
  const pschema = (id: string, pname: string) => deref(param(id, pname)?.schema);
  const okResp = (id: string, code?: string) => {
    const [, r] = Object.entries<any>(ops[id].op.responses).find(([c]) => (code ? c === code : /^2/.test(c)))!;
    return deref(r);
  };
  const okSchema = (id: string, code?: string) => deref(okResp(id, code).content?.["application/json"]?.schema);
  const has = (id: string) => expect(ops[id], `${id} missing`).toBeDefined();
  const ex = () => expect(existsSync(FILE), "contracts/openapi/inventory.yaml missing").toBe(true);
  const T = (title: string, fn: () => void) => it(title, () => { ex(); fn(); });
  const num = (s: any) => [s?.minimum, s?.maximum];
  const lines = (s: any) => deref(deref(props(s).lines)?.items);
  const walk = (s: any, fn: (n: any) => void, seen = new Set<any>()) => {
    const n = deref(s);
    if (!n || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    fn(n);
    for (const a of [...(n.allOf ?? []), ...(n.oneOf ?? []), ...(n.anyOf ?? [])]) walk(a, fn, seen);
    for (const p of Object.values(n.properties ?? {})) walk(p, fn, seen);
    if (n.items) walk(n.items, fn, seen);
  };

  describe("exists and is OAS 3.0.3 (AC-0C-1.4)", () => {
    it("file exists", () => expect(existsSync(FILE), "contracts/openapi/inventory.yaml missing").toBe(true));
    it("first non-comment line is `openapi: 3.0.3`", () => {
      const first = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#"));
      expect(first?.trim()).toBe("openapi: 3.0.3");
    });
    it("info.title and version present; no `nullable: true` (no null on the wire, CV §4.2)", () => {
      expect(typeof doc.info?.title).toBe("string");
      expect(typeof doc.info?.version).toBe("string");
      expect(text.length, "empty").toBeGreaterThan(0);
      expect(text).not.toMatch(/nullable:\s*true/);
    });
    it("the LD-103 decision is cited in a comment", () => expect(text).toMatch(/LD-103/));
  });

  describe("repo spec lint is green (AC-0C-1.4, rules 1–8)", () => {
    it("lintRepo reports no violation", async () => {
      ex();
      const v = (await lintRepo(ROOT)).filter((x) => x.file === name);
      expect(v, v.map((x) => `[rule ${x.rule}] ${x.message}`).join("\n")).toEqual([]);
    });
  });

  describe("lint actually checks this file (AC-0C-1.5 negative)", () => {
    const mutate = async (fn: (d: any) => void) => {
      ex();
      const dir = mkdtempSync(join(tmpdir(), "c12-inventory-lint-"));
      tmps.push(dir);
      cpSync(join(ROOT, "contracts"), join(dir, "contracts"), { recursive: true, filter: (s) => !s.includes("node_modules") });
      const d = parse(readFileSync(FILE, "utf8"));
      fn(d);
      writeFileSync(join(dir, "contracts/openapi/inventory.yaml"), stringify(d, { aliasDuplicateObjects: false }));
      return (await lintRepo(dir)).filter((x) => x.file === name);
    };
    const firstOp = (d: any, pred: (o: any) => boolean) =>
      Object.values<any>(d.paths).flatMap((p) => METHODS.map((m) => p[m]).filter(Boolean)).find(pred);

    it("x-permission not in permissions.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-permission"] = "inventory.no_such.permission"; });
      expect(v.some((x) => x.rule === "4" && /x-permission/.test(x.message))).toBe(true);
    });
    it("x-error-codes entry not in errors.yaml fails", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => Array.isArray(o["x-error-codes"]))["x-error-codes"].push("inventory.no_such_error"); });
      expect(v.some((x) => x.rule === "4" && /error code/.test(x.message))).toBe(true);
    });
    it("object schema without additionalProperties:false fails", async () => {
      const v = await mutate((d) => {
        const s = Object.values<any>(d.components?.schemas ?? {}).find((x) => x?.type === "object" && x.additionalProperties === false);
        delete s.additionalProperties;
      });
      expect(v.some((x) => x.rule === "3")).toBe(true);
    });
    it("operation without x-rate-limit-tier fails", async () => {
      const v = await mutate((d) => { delete firstOp(d, (o) => "x-rate-limit-tier" in o)["x-rate-limit-tier"]; });
      expect(v.some((x) => x.rule === "4" && /x-rate-limit-tier/.test(x.message))).toBe(true);
    });
    it("an operation with both x-permission and x-public fails (exactly one)", async () => {
      const v = await mutate((d) => { firstOp(d, (o) => "x-permission" in o)["x-public"] = "bogus public justification text"; });
      expect(v.some((x) => x.rule === "4" && /exactly one/.test(x.message))).toBe(true);
    });
  });

  describe("inventory equals 02-TRD §5 (no missing, no extra operations)", () => {
    it(`${TOTAL} operations; table ids unique; file has exactly these`, () => {
      expect(SPECS.length).toBe(TOTAL);
      expect(new Set(SPECS.map((s) => s.id)).size).toBe(TOTAL);
      expect(Object.keys(ops).sort()).toEqual(SPECS.map((s) => s.id).sort());
    });
    it("TRD drift guard: §5 tables = test table (number, operationId, method + path, first permission, Idem letter)", () => {
      const all = readFileSync(TRD, "utf8").split("\n");
      const start = all.findIndex((l) => l.startsWith("## 5. Endpoints"));
      const end = all.findIndex((l, k) => k > start && l.startsWith("## 6. "));
      const rows = new Map<number, { id: string; mp: string; perm: string; idem: string }>();
      for (const l of all.slice(start, end)) {
        const c = l.split("|");
        if (!/^\s*\d{1,3}\s*$/.test(c[1] ?? "") || !/^\s*[a-z][A-Za-z0-9]+\s*$/.test(c[2] ?? "")) continue;
        const mp = /^\s*([A-Z]+)\s+`([^`]+)`/.exec(c[3] ?? "");
        const perm = /(inventory\.[a-z_.]+)/.exec(c[4] ?? "");
        rows.set(Number(c[1]), { id: c[2].trim(), mp: `${mp?.[1]} ${PFX}${mp?.[2]}`, perm: perm?.[1] ?? "?", idem: (c[6] ?? "").trim() });
      }
      expect(rows.size).toBe(TOTAL);
      for (const s of SPECS) {
        const r = rows.get(s.n);
        expect(r?.id, `#${s.n} id`).toBe(s.id);
        expect(r?.mp, `#${s.n} method+path`).toBe(`${s.method} ${PFX}${s.path}`);
        expect(r?.perm, `#${s.n} permission`).toBe(s.perm);
        if (s.idem !== "skip") expect(r?.idem, `#${s.n} idem`).toBe({ none: "–", optional: "O", required: "R" }[s.idem]);
      }
    });
    T("every path is /v1/inventory/… with tags [inventory]; no PHI path or query params (REQ-SEC-098)", () => {
      expect(Object.keys(doc.paths ?? {}).length, "no paths").toBeGreaterThan(0);
      for (const [p, item] of Object.entries<any>(doc.paths ?? {})) {
        expect(p.startsWith(`${PFX}/`), p).toBe(true);
        expect(p).not.toMatch(/\{(registration_no|barcode|sample_barcode|phone|patient_id|email)\}/);
        for (const m of METHODS) if (item[m]) expect(item[m].tags, `${m} ${p}`).toEqual([name]);
      }
      for (const id of Object.keys(ops))
        for (const q of params(id)) if (q?.in === "query") expect(PHI_PARAMS, `${id}?${q.name}`).not.toContain(q.name);
    });
  });

  describe.each(SPECS)("#$n $id", (r) => {
    const o = ops[r.id]?.op;
    it("exists at the TRD method + path", () => {
      has(r.id);
      expect(`${ops[r.id].method} ${ops[r.id].path}`).toBe(`${r.method} ${PFX}${r.path}`);
    });
    it("has tags, summary, x-idempotency (TRD Idem), x-rate-limit-tier general, x-error-codes", () => {
      has(r.id);
      expect(o.tags).toEqual([name]);
      expect(typeof o.summary).toBe("string");
      if (r.idem !== "skip") expect(o["x-idempotency"]).toBe(r.idem);
      else expect(["optional", "required"]).toContain(o["x-idempotency"]);
      if (r.method === "POST") expect(o["x-idempotency"], "no C12 POST uses none (TRD §5)").not.toBe("none");
      expect(o["x-rate-limit-tier"]).toBe("general");
      expect(Array.isArray(o["x-error-codes"])).toBe(true);
    });
    it(`x-permission = ${r.perm}, never x-public; security bearerJwt; tenant context only`, () => {
      has(r.id);
      expect(o["x-permission"]).toBe(r.perm);
      expect(o["x-public"]).toBeUndefined();
      expect(o.security).toEqual([{ bearerJwt: [] }]);
      expect([undefined, "tenant"]).toContain(o["x-context"]);
    });
    it("success response status", () => {
      has(r.id);
      expect(Object.keys(o.responses ?? {}), `want ${r.status}`).toContain(String(r.status));
    });
    it("lists the TRD specific error codes plus the six common codes (+ If-Match codes on IM rows)", () => {
      has(r.id);
      for (const c of [...SIX, ...r.err]) expect(o["x-error-codes"], c).toContain(c);
      for (const c of r.not ?? []) expect(o["x-error-codes"], `${c} must be absent`).not.toContain(c);
      if (r.im === false) for (const c of [PRE]) expect(o["x-error-codes"], c).not.toContain(c);
    });
    it("Idempotency-Key header where x-idempotency required, none where none; If-Match on PATCH / actions / draft PUTs only", () => {
      has(r.id);
      const ps = JSON.stringify(o.parameters ?? []);
      if (r.idem === "required") expect(ps).toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.idem === "none") expect(ps).not.toMatch(/IdempotencyKey|Idempotency-Key/);
      if (r.im === true) expect(ps).toMatch(/IfMatch|If-Match/);
      if (r.im === false) expect(ps).not.toMatch(/IfMatch|If-Match/);
    });
    if (r.paged)
      it("takes cursor + limit (max 200, default 50)", () => {
        has(r.id);
        const ps = JSON.stringify(o.parameters ?? []);
        expect(ps).toMatch(/cursor|Cursor/);
        expect(ps).toMatch(/limit|Limit/);
        const lim = pschema(r.id, "limit");
        expect([lim?.maximum, lim?.default]).toEqual([200, 50]);
      });
  });

  describe("response shapes (TRD §5, §6.2)", () => {
    T("named DTO schemas are components, closed", () => {
      for (const n of DTOS) {
        expect(schema(n), n).toBeDefined();
        expect(schema(n).additionalProperties, `${n} closed`).toBe(false);
      }
    });
    T("list ops return {data, page} with the TRD item DTO (#11 data = Store[] ∪ reduced stores: keys ⊇ id, store_code, name, branch_id, branch_name)", () => {
      for (const [id, dto] of Object.entries(LIST_ITEM)) {
        const s = okSchema(id);
        expect(keys(s), id).toEqual(expect.arrayContaining(["data", "page"]));
        expect(deref(deref(props(s).data).items), id).toEqual(deref(schema(dto)));
      }
      expect(keys(okSchema("listInventoryStores"))).toEqual(expect.arrayContaining(["data", "page"]));
      expect(keys(deref(props(okSchema("listInventoryStores")).data).items)).toEqual(expect.arrayContaining(["id", "store_code", "name", "branch_id", "branch_name"]));
      expect(Object.keys(props(okSchema("listInventoryCodedSet")))).toEqual(["data"]);
      expect(deref(deref(props(okSchema("listInventoryCodedSet")).data).items)).toEqual(deref(schema("InventoryCodedSetEntry")));
    });
    T("single-object ops return (at least) the properties of their DTO", () => {
      for (const [id, dto] of Object.entries(ONE)) expect(keys(okSchema(id)), id).toEqual(expect.arrayContaining(keys(schema(dto))));
    });
    T("Item / Store / Lot / Movement / Fact / Alert core fields (§6.2); optional ones are not required", () => {
      expect(keys(schema("Item"))).toEqual(expect.arrayContaining(["id", "item_code", "name", "category", "base_uom_code", "manufacturer", "catalogue_no", "storage_condition",
        "is_lot_tracked", "requires_expiry", "open_stability_days", "container_qty_base", "hs_code", "default_tax_code", "notes", "is_active", "version", "packs", "barcodes", "updated_at"]));
      expect(reqd(schema("Item"))).toEqual(expect.arrayContaining(["id", "item_code", "name", "category", "base_uom_code", "is_lot_tracked", "requires_expiry", "is_active", "version", "packs", "barcodes", "updated_at"]));
      for (const f of ["manufacturer", "catalogue_no", "storage_condition", "open_stability_days", "container_qty_base", "hs_code", "default_tax_code", "notes"]) expect(reqd(schema("Item")), f).not.toContain(f);
      expect(keys(schema("Store"))).toEqual(expect.arrayContaining(["id", "branch_id", "branch_name", "store_code", "name", "store_kind", "is_default_consumption", "is_active", "version"]));
      expect(keys(schema("Lot"))).toEqual(expect.arrayContaining(["id", "item_id", "lot_no", "expiry_on", "manufactured_on", "status", "status_reason_code", "version", "last_receipt_unit_cost_paisa_x1e6"]));
      for (const f of ["expiry_on", "manufactured_on", "status_reason_code", "last_receipt_unit_cost_paisa_x1e6"]) expect(reqd(schema("Lot")), f).not.toContain(f);
      expect(keys(schema("Movement"))).toEqual(expect.arrayContaining(["id", "occurred_at", "business_date", "store_id", "item_id", "lot_id", "lot_no", "movement_kind", "qty_base",
        "balance_qty_after", "value_paisa", "value_basis", "doc_type", "doc_id", "doc_no", "instrument_id", "attributed_test_id", "rule_id", "reason_code", "created_by_display"]));
      expect(keys(schema("Fact"))).toEqual(expect.arrayContaining(["id", "fact_kind", "source", "status", "instrument_id", "test_id", "analyte_id", "occurred_at", "business_date",
        "multiplier", "store_id", "rules_applied", "value_paisa_total", "reason_code", "note", "movements"]));
      expect(keys(schema("Alert"))).toEqual(expect.arrayContaining(["id", "alert_kind", "status", "store_id", "item_id", "lot_id", "instrument_id", "test_id", "first_raised_at",
        "last_raised_at", "occurrences", "details", "version"]));
      expect(keys(schema("BalanceRow"))).toEqual(expect.arrayContaining(["store_id", "item_id", "item_code", "item_name", "lot_id", "lot_no", "expiry_on", "lot_status", "qty_base",
        "available_qty_base", "has_open_container", "reorder_level_base", "value_paisa", "avg_unit_cost_paisa_x1e6"]));
      expect(prop("BalanceRow", "avg_unit_cost_paisa_x1e6").type).toBe("integer");
      for (const f of ["lot_id", "lot_no", "expiry_on", "lot_status", "reorder_level_base", "value_paisa", "avg_unit_cost_paisa_x1e6"]) expect(reqd(schema("BalanceRow")), f).not.toContain(f);
    });
    T("Po / Grn: lines (non-removed only) carry is_exempt; tax_code is omitted on exempt lines (optional); Po lines have open_qty_base; version", () => {
      for (const n of ["Po", "Grn"]) {
        expect(keys(schema(n)), n).toEqual(expect.arrayContaining(["lines", "version"]));
        const ln = lines(schema(n));
        expect(Object.keys(props(ln)), `${n} line`).toEqual(expect.arrayContaining(["is_exempt", "tax_code"]));
        expect(reqd(ln), `${n} line`).not.toContain("tax_code");
        expect(deref(props(ln).is_exempt).type).toBe("boolean");
      }
      expect(Object.keys(props(lines(schema("Po"))))).toContain("open_qty_base");
    });
    T("Fact never returns basis_key / source_event_id (P1); no response or request component names tenant_id / created_by / updated_by", () => {
      for (const [n, s] of Object.entries<any>(doc.components?.schemas ?? {}))
        for (const f of FORBIDDEN_ANY) expect(Object.keys(props(s)), `${n}.${f}`).not.toContain(f);
      expect(keys(schema("Fact"))).not.toContain("basis_key");
      expect(keys(schema("Fact"))).not.toContain("source_event_id");
    });
    T("cost allowlist (REQ-SEC-081): every *_paisa / *_paisa_x1e6 / value_basis property of a response (except the cost-only PO print view) is optional", () => {
      let seen = 0;
      for (const [id, { op }] of Object.entries(ops)) {
        if (id === "getPurchaseOrderPrintView") continue;
        for (const [c, rr] of Object.entries<any>(op.responses ?? {})) {
          if (!/^2/.test(c)) continue;
          walk(deref(rr)?.content?.["application/json"]?.schema, (n) => {
            for (const f of Object.keys(props(n)))
              if (/_paisa$|_paisa_x1e6$/.test(f) || f === "value_basis") {
                seen++;
                expect(reqd(n), `${id} response: ${f} must be optional (omitted without inventory.cost.read)`).not.toContain(f);
              }
          });
        }
      }
      expect(seen, "no cost field found in any response").toBeGreaterThan(5);
    });
    T("previewConsumption: store_id optional, store_resolution_step, lines[{rule_id, item_id, qty_base, lot_id?, est_value_paisa† optional}]", () => {
      const s = okSchema("previewConsumption");
      expect(keys(s)).toEqual(expect.arrayContaining(["store_id", "store_resolution_step", "lines"]));
      expect(reqd(s)).not.toContain("store_id");
      const ln = deref(deref(props(s).lines).items);
      expect(Object.keys(props(ln))).toEqual(expect.arrayContaining(["rule_id", "item_id", "qty_base", "lot_id", "est_value_paisa"]));
      for (const f of ["lot_id", "est_value_paisa"]) expect(reqd(ln), f).not.toContain(f);
    });
    T("lookupInventoryBarcode → {item, pack?}; discardContainer → {container, document}; recordStockCountLines → {updated, lines: CountLine[]}", () => {
      const l = okSchema("lookupInventoryBarcode");
      expect(keys(l).sort()).toEqual(["item", "pack"]);
      expect(reqd(l)).toEqual(["item"]);
      expect(Object.keys(props(okSchema("discardContainer"))).sort()).toEqual(["container", "document"]);
      const c = okSchema("recordStockCountLines");
      expect(Object.keys(props(c)).sort()).toEqual(["lines", "updated"]);
      expect(deref(deref(props(c).lines).items)).toEqual(deref(schema("CountLine")));
    });
    T("getStockDocument adds lines + movements (§5.3); createPurchaseOrdersFromReorder → 201 {created: PoSummary[], skipped[{item_id, reason enum}]}", () => {
      expect(keys(okSchema("getStockDocument"))).toEqual(expect.arrayContaining(["lines", "movements"]));
      const s = okSchema("createPurchaseOrdersFromReorder", "201");
      expect(Object.keys(props(s)).sort()).toEqual(["created", "skipped"]);
      expect(deref(deref(props(s).created).items)).toEqual(deref(schema("PoSummary")));
      const sk = deref(deref(props(s).skipped).items);
      expect(Object.keys(props(sk)).sort()).toEqual(["item_id", "reason"]);
      expect(deref(props(sk).reason).enum).toEqual(["no_preferred_supplier", "no_pack", "not_below_reorder", "open_po_exists"]);
    });
    T("ReportResult: report_code, params, columns[ColumnMeta], rows ≤ 5000 (objects), totals, generated_at, truncated boolean; all required", () => {
      expect(keys(schema("ReportResult")).sort()).toEqual(["columns", "generated_at", "params", "report_code", "rows", "totals", "truncated"]);
      expect(reqd(schema("ReportResult")).sort()).toEqual(["columns", "generated_at", "params", "report_code", "rows", "totals", "truncated"]);
      expect(prop("ReportResult", "rows").maxItems).toBe(5000);
      expect(prop("ReportResult", "truncated").type).toBe("boolean");
      expect(deref(prop("ReportResult", "columns").items)).toEqual(deref(schema("ColumnMeta")));
    });
    T("CSV exports (#55, #93): 200 is text/csv only (never JSON) with Content-Disposition + Cache-Control headers", () => {
      for (const id of ["exportGoodsReceiptsCsv", "exportInventoryReport"]) {
        const r = okResp(id);
        expect(Object.keys(r.content ?? {}), id).toEqual(["text/csv"]);
        const h = JSON.stringify(r.headers ?? {}).toLowerCase();
        for (const x of ["content-disposition", "cache-control"]) expect(h, `${id} ${x}`).toContain(x);
      }
    });
  });

  describe("request shapes (TRD §5 Request column, §6.1)", () => {
    const REQ_IDS = () => Object.entries(ops).filter(([, v]) => v.op.requestBody).map(([id]) => id);
    T("request bodies are application/json only", () => {
      expect(REQ_IDS().length, "no request bodies").toBeGreaterThan(40);
      for (const id of REQ_IDS()) expect(Object.keys(ops[id].op.requestBody.content), id).toEqual(["application/json"]);
    });
    T("server-authority fields are never declared in a request (CV §4.7); `status` only on setInventoryLotStatus; GRN draft lines declare no lot_id", () => {
      for (const id of REQ_IDS()) {
        walk(bodySchema(id), (n) => {
          for (const f of Object.keys(props(n))) {
            expect(FORBIDDEN_REQ, `${id}.${f}`).not.toContain(f);
            if (f === "status") expect(id, "status in request").toBe("setInventoryLotStatus");
          }
        });
      }
      for (const id of ["createGoodsReceipt", "replaceGoodsReceiptDraft"]) expect(Object.keys(props(lines(bodySchema(id)))), id).not.toContain("lot_id");
    });
    T("money in a request: integer, 0 … 9007199254740991; base quantities (*_base) use the DecimalStringPositive pattern; qty_packs the DecimalStringPacks pattern", () => {
      let money = 0, base = 0, packs = 0;
      for (const id of REQ_IDS())
        walk(bodySchema(id), (n) => {
          for (const [f, raw] of Object.entries<any>(props(n))) {
            const p = deref(raw);
            if (/_paisa$/.test(f)) { money++; expect([p.type, p.minimum, p.maximum], `${id}.${f}`).toEqual(["integer", 0, 9007199254740991]); }
            if (/_base$/.test(f) && f !== "base_uom_code") { base++; expect([p.type, p.pattern], `${id}.${f}`).toEqual(["string", DEC_BASE]); }
            if (f === "qty_packs") { packs++; expect([p.type, p.pattern], `${id}.${f}`).toEqual(["string", DEC_PACKS]); }
          }
        });
      expect([money, base, packs].every((x) => x > 0), `money ${money} base ${base} packs ${packs}`).toBe(true);
    });
    T("coded-set fields (reason_code, uom_code, tax_code, default_tax_code) are strings without enum on the wire (CV §4)", () => {
      let n = 0;
      for (const id of REQ_IDS())
        walk(bodySchema(id), (s) => {
          for (const f of ["reason_code", "uom_code", "tax_code", "default_tax_code", "discrepancy_reason_code"]) {
            const p = deref(props(s)[f]);
            if (p) { n++; expect(p.type, `${id}.${f}`).toBe("string"); expect(p.enum, `${id}.${f} no enum`).toBeUndefined(); }
          }
        });
      expect(n).toBeGreaterThan(8);
    });
    T("every line array: lines[1..200] on #43 #47(lot_ids) #50 #52 #57 #59 #66 #81 #83; item_ids ≤ 200 on #88; observations integer 1–50 on #76", () => {
      for (const id of ["createStockIssue", "createGoodsReceipt", "replaceGoodsReceiptDraft", "createTransfer", "replaceTransferDraft", "recordStockCountLines", "createPurchaseOrder", "replacePurchaseOrderDraft"])
        expect([bp(id, "lines").minItems, bp(id, "lines").maxItems], id).toEqual([1, 200]);
      expect([bp("writeOffExpiredStock", "lot_ids").minItems, bp("writeOffExpiredStock", "lot_ids").maxItems]).toEqual([1, 200]);
      expect(bp("createPurchaseOrdersFromReorder", "item_ids").maxItems).toBe(200);
      expect([bp("logConsumptionEvent", "observations").type, bp("logConsumptionEvent", "observations").minimum, bp("logConsumptionEvent", "observations").maximum]).toEqual(["integer", 1, 50]);
      for (const id of ["createStoreReturn", "createSupplierReturn", "recordWastage", "createStockAdjustment", "receiveTransfer"]) expect(bp(id, "lines").maxItems, id).toBeLessThanOrEqual(200);
    });
    T("required request fields per TRD (master data, stock, documents)", () => {
      const R: Record<string, string[]> = {
        setInventoryItemActive: ["is_active"], createInventoryItemPack: ["pack_code", "label", "uom_code", "qty_in_base"], addInventoryItemBarcode: ["barcode_value"],
        lookupInventoryBarcode: ["barcode_value"], createInventoryStore: ["branch_id", "store_code", "name", "store_kind"], putStoreItemSetting: ["is_stocked"],
        putSupplierItem: ["is_active"], putInstrumentBinding: ["store_id"], putInventoryTenantCode: ["display", "is_active"],
        setInventoryLotStatus: ["status", "reason_code"], correctInventoryLotExpiry: ["expiry_on", "reason_code"], openContainer: ["store_id", "item_id"],
        discardContainer: ["qty_base", "reason_code"], createStockIssue: ["store_id", "issued_to_kind", "lines"], createStoreReturn: ["store_id", "lines"],
        createSupplierReturn: ["store_id", "supplier_id", "reason_code", "lines"], recordWastage: ["store_id", "reason_code", "lines"], writeOffExpiredStock: ["store_id", "lot_ids"],
        createStockAdjustment: ["store_id", "reason_code", "lines"], createGoodsReceipt: ["kind", "store_id", "lines"], cancelGoodsReceipt: ["reason_text"],
        createTransfer: ["from_store_id", "to_store_id", "lines"], receiveTransfer: ["lines"], cancelTransfer: ["reason_text"], openStockCount: ["store_id"],
        recordStockCountLines: ["lines"], postStockCount: ["uncounted_policy"], createConsumptionRule: ["rule_kind", "item_id", "qty"], supersedeConsumptionRule: ["qty"],
        previewConsumption: ["fact_kind"], logConsumptionEvent: ["fact_kind", "test_id", "occurred_at"], resolveConsumptionFact: ["store_id"],
        dismissConsumptionFact: ["reason_code"], reverseConsumptionFact: ["reason_code"], createPurchaseOrder: ["supplier_id", "store_id", "lines"],
        markPurchaseOrderSent: ["sent_channel"], cancelPurchaseOrder: ["reason_code"], createPurchaseOrdersFromReorder: ["store_id"],
      };
      for (const [id, f] of Object.entries(R)) {
        has(id);
        expect(bodySchema(id), `${id} body`).toBeDefined();
        expect(reqd(bodySchema(id)), id).toEqual(expect.arrayContaining(f));
      }
      expect(reqd(bodySchema("closePurchaseOrder"))).toEqual([]);
      for (const id of ["postGoodsReceipt", "approvePurchaseOrder", "dispatchTransfer"]) expect(ops[id].op.requestBody, `${id} has no body`).toBeUndefined();
    });
    T("line required fields: GRN/PO lines {item_id, pack_id, qty_packs}; is_exempt boolean default false; supplier return lines need lot_id; receive lines {line_id, received_qty_base}", () => {
      for (const id of ["createGoodsReceipt", "replaceGoodsReceiptDraft", "createPurchaseOrder", "replacePurchaseOrderDraft"]) {
        const ln = lines(bodySchema(id));
        expect(reqd(ln), id).toEqual(expect.arrayContaining(["item_id", "pack_id", "qty_packs"]));
        expect(reqd(ln), id).not.toContain("is_exempt");
        const ie = deref(props(ln).is_exempt);
        expect([ie.type, ie.default], id).toEqual(["boolean", false]);
        expect(Object.keys(props(ln)), id).toEqual(expect.arrayContaining(["tax_code", "unit_price_paisa", "discount_paisa"]));
        expect(reqd(ln), id).not.toContain("tax_code");
      }
      expect(Object.keys(props(lines(bodySchema("createGoodsReceipt"))))).toEqual(expect.arrayContaining(["po_line_id", "lot_no", "expiry_on", "manufactured_on"]));
      expect(reqd(lines(bodySchema("createSupplierReturn")))).toEqual(expect.arrayContaining(["item_id", "lot_id", "qty"]));
      expect(reqd(lines(bodySchema("receiveTransfer")))).toEqual(expect.arrayContaining(["line_id", "received_qty_base"]));
      expect(reqd(lines(bodySchema("createStockIssue")))).toEqual(expect.arrayContaining(["item_id", "qty"]));
    });
    T("draft-replace bodies: GRN draft minus kind/store_id (#52); transfer draft minus stores (#59); PO draft keeps store + supplier (#83); GrnDraft header fields (#50)", () => {
      expect(keys(bodySchema("createGoodsReceipt"))).toEqual(expect.arrayContaining(["kind", "store_id", "supplier_id", "po_id", "received_at", "supplier_invoice_no", "supplier_invoice_on",
        "supplier_invoice_total_paisa", "notes", "lines"]));
      expect(bp("createGoodsReceipt", "supplier_invoice_on").format).toBe("date");
      expect(keys(bodySchema("replaceGoodsReceiptDraft"))).toEqual(expect.arrayContaining(["supplier_id", "po_id", "lines"]));
      for (const f of ["kind", "store_id"]) expect(keys(bodySchema("replaceGoodsReceiptDraft")), f).not.toContain(f);
      for (const f of ["from_store_id", "to_store_id"]) expect(keys(bodySchema("replaceTransferDraft")), f).not.toContain(f);
      expect(keys(bodySchema("replaceTransferDraft"))).toContain("lines");
      expect(keys(bodySchema("replacePurchaseOrderDraft"))).toEqual(expect.arrayContaining(["supplier_id", "store_id", "lines"]));
    });
    T("PATCH bodies: ItemPatch / SupplierPatch carry unset[]; pack patch has no qty_in_base (400 if sent); settings update has consumption_enabled_at; tax-code body has no rate", () => {
      expect(keys(bodySchema("updateInventoryItem"))).toEqual(expect.arrayContaining(["unset"]));
      expect(keys(bodySchema("updateInventorySupplier"))).toEqual(expect.arrayContaining(["unset"]));
      expect(bp("updateInventoryItem", "unset").type).toBe("array");
      expect(keys(bodySchema("updateInventoryItemPack"))).toEqual(expect.arrayContaining(["label", "uom_code", "is_purchase_default", "is_active"]));
      expect(keys(bodySchema("updateInventoryItemPack"))).not.toContain("qty_in_base");
      expect(keys(bodySchema("updateInventoryStore"))).toEqual(expect.arrayContaining(["name", "store_kind", "is_default_consumption", "is_active"]));
      expect(keys(schema("SettingsUpdate"))).toContain("consumption_enabled_at");
      expect(keys(bodySchema("putInventoryTenantCode"))).toEqual(expect.arrayContaining(["display", "is_active"]));
      for (const f of keys(bodySchema("putInventoryTenantCode"))) expect(f, "no rate on a tax code (08 A2.2)").not.toMatch(/rate|percent/);
    });
    T("enums closed by the TRD: postStockCount uncounted_policy, logConsumptionEvent fact_kind", () => {
      expect(bp("postStockCount", "uncounted_policy").enum).toEqual(["skip", "zero"]);
      expect(bp("logConsumptionEvent", "fact_kind").enum).toEqual(["calibration", "qc"]);
    });
    T("setInventoryLotStatus / correctInventoryLotExpiry / openContainer / date + instant formats", () => {
      expect(bp("correctInventoryLotExpiry", "expiry_on").format).toBe("date");
      expect(bp("openContainer", "opened_at")).toBeDefined();
      expect(bp("logConsumptionEvent", "occurred_at").type).toBe("string");
      expect(bp("createStockIssue", "occurred_at")).toBeDefined();
    });
  });

  describe("query / path parameters (TRD §5 Request column)", () => {
    T("every {param} in a path is declared as a required path parameter", () => {
      for (const { op, path } of Object.values(ops))
        for (const m of path.match(/\{[^}]+\}/g) ?? []) {
          const p = (op.parameters ?? []).map(deref).find((x: any) => x?.name === m.slice(1, -1) && x.in === "path");
          expect(p, `${path} ${m}`).toBeDefined();
          expect(p.required, `${path} ${m}`).toBe(true);
        }
    });
    T("#1 listInventoryItems: category, is_active, q (≤ 60), sort ∈ {item_code, name, -updated_at}; no barcode parameter (use #10)", () => {
      for (const f of ["category", "is_active", "q", "sort"]) expect(param("listInventoryItems", f), f).toBeDefined();
      expect(pschema("listInventoryItems", "q").maxLength).toBe(60);
      expect(pschema("listInventoryItems", "sort").enum).toEqual(["item_code", "name", "-updated_at"]);
      expect(param("listInventoryItems", "barcode")).toBeUndefined();
    });
    T("#11 listInventoryStores: purpose ∈ {manage (default), transfer_target}; filters", () => {
      expect(pschema("listInventoryStores", "purpose").enum).toEqual(["manage", "transfer_target"]);
      expect(pschema("listInventoryStores", "purpose").default).toBe("manage");
      for (const f of ["branch_id", "is_active", "store_kind"]) expect(param("listInventoryStores", f), f).toBeDefined();
    });
    T("#28 listInventoryCodedSet: set_name ∈ {uom, reasons, tax_codes}, reason_group query; #29 same set_name", () => {
      expect(pschema("listInventoryCodedSet", "set_name").enum).toEqual(["uom", "reasons", "tax_codes"]);
      expect(pschema("putInventoryTenantCode", "set_name").enum).toEqual(["uom", "reasons", "tax_codes"]);
      expect(param("listInventoryCodedSet", "reason_group")).toBeDefined();
    });
    T("list filters: #15 #17 #21 #23 #30 #35 #41 #49 #55 #56 #63 #69 #75 #80 #90", () => {
      const F: Record<string, string[]> = {
        listStoreItemSettings: ["below_reorder", "item_id"], listInventorySuppliers: ["q", "is_active"], listSupplierItems: ["item_id"], listInstrumentBindings: ["store_id"],
        listInventoryLots: ["item_id", "status", "expiring_before"],
        listStockMovements: ["store_id", "item_id", "lot_id", "movement_kind", "occurred_at_from", "occurred_at_to", "doc_type", "doc_id", "instrument_id", "attributed_test_id", "sort"],
        listStockDocuments: ["store_id", "doc_kind", "occurred_at_from", "occurred_at_to"],
        listGoodsReceipts: ["store_id", "status", "supplier_id", "po_id", "received_at_from", "received_at_to"], exportGoodsReceiptsCsv: ["posted_at_from", "posted_at_to", "store_id"],
        listTransfers: ["from_store_id", "to_store_id", "status"], listStockCounts: ["store_id", "status"],
        listConsumptionRules: ["rule_kind", "test_id", "instrument_id", "item_id", "current_only"],
        listConsumptionFacts: ["status", "fact_kind", "instrument_id", "test_id", "business_date_from", "business_date_to"],
        listPurchaseOrders: ["status", "supplier_id", "branch_id", "created_at_from", "created_at_to"], listInventoryAlerts: ["status", "alert_kind", "store_id"],
        getFefoSuggestion: ["store_id", "item_id", "qty_base"],
      };
      for (const [id, fs] of Object.entries(F)) for (const f of fs) expect(param(id, f), `${id}?${f}`).toBeDefined();
      expect(pschema("listInventoryLots", "expiring_before").format).toBe("date");
      expect(param("listInventoryLots", "item_id").required).toBe(true);
      expect(pschema("listStockMovements", "sort").enum).toEqual(["-occurred_at"]);
      expect(pschema("listConsumptionRules", "current_only").default).toBe(true);
    });
    T("#34 listStockBalances: expiring_within_days 1–365, expired_only boolean default false, include_zero default false, below_reorder boolean", () => {
      expect(num(pschema("listStockBalances", "expiring_within_days"))).toEqual([1, 365]);
      expect([pschema("listStockBalances", "expired_only").type, pschema("listStockBalances", "expired_only").default]).toEqual(["boolean", false]);
      expect(pschema("listStockBalances", "include_zero").default).toBe(false);
      expect(pschema("listStockBalances", "below_reorder").type).toBe("boolean");
      for (const f of ["store_id", "item_id", "category"]) expect(param("listStockBalances", f), f).toBeDefined();
    });
    T("#37 listOpenedContainers: store_id required, instrument_id, status default open; #65 getStockCount takes limit + cursor for lines", () => {
      expect(param("listOpenedContainers", "store_id").required).toBe(true);
      expect(param("listOpenedContainers", "instrument_id")).toBeDefined();
      expect(pschema("listOpenedContainers", "status").default).toBe("open");
      expect(param("getStockCount", "limit")).toBeDefined();
      expect(param("getStockCount", "cursor")).toBeDefined();
    });
    T("#92 / #93 reports: report_code ∈ the 7 TRD codes; date range, as_of (date), within_days, group_by and the scope filters", () => {
      for (const id of ["getInventoryReport", "exportInventoryReport"]) {
        expect(pschema(id, "report_code").enum, id).toEqual(REPORT_CODES);
        for (const f of ["business_date_from", "business_date_to", "as_of"]) expect(pschema(id, f)?.format, `${id}.${f}`).toBe("date");
        for (const f of ["store_id", "branch_id", "instrument_id", "test_id", "item_id", "within_days", "group_by"]) expect(param(id, f), `${id}.${f}`).toBeDefined();
      }
    });
  });

  // ---------- "Prism smoke", offline: examples validate against their schemas ----------
  describe("examples validate against their schemas; each operation has a servable example (Prism smoke); examples are synthetic", () => {
    const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema({ ...common, id: "_common.yaml" });
    ajv.addSchema({ ...doc, id: "inventory.yaml" });
    const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
    const check = (ptr: string, example: unknown) => {
      const validate = ajv.getSchema(`inventory.yaml#${ptr}`);
      expect(validate, `cannot resolve ${ptr}`).toBeDefined();
      expect(validate!(example), `${ptr}: ${JSON.stringify(validate!.errors?.[0])}`).toBe(true);
    };
    const exampleValues = (): unknown[] => {
      const out: unknown[] = [];
      const w = (x: any) => {
        if (Array.isArray(x)) x.forEach(w);
        else if (x && typeof x === "object") {
          for (const [k, v] of Object.entries<any>(x)) {
            if (k === "example") out.push(v);
            else if (k === "examples" && v && typeof v === "object") for (const e of Object.values<any>(v)) out.push(e?.value);
            else w(v);
          }
        }
      };
      w(doc);
      return out;
    };
    it("every JSON request/response example matches its schema; at least one per operation (CSV exports excepted)", () => {
      ex();
      let n = 0;
      for (const { method, path, op } of Object.values(ops)) {
        const base = `/paths/${esc(path)}/${method.toLowerCase()}`;
        const media: [string, any][] = [];
        const rb = op.requestBody;
        if (rb?.content?.["application/json"]) media.push([`${base}/requestBody/content/application~1json`, rb.content["application/json"]]);
        for (const [code, r] of Object.entries<any>(op.responses ?? {}))
          if (!r.$ref && r.content?.["application/json"]) media.push([`${base}/responses/${code}/content/application~1json`, r.content["application/json"]]);
        for (const [p, m] of media)
          for (const [k, e] of Object.entries<any>(m.examples ?? {})) {
            if (m.schema) check(`${p}/schema`, e.value);
            n++;
            expect(k.length).toBeGreaterThan(0);
          }
      }
      expect(n).toBeGreaterThanOrEqual(TOTAL - 2);
    });
    it("every operation has a 2xx response with a servable example Prism can serve", () => {
      ex();
      expect(Object.keys(ops).length).toBe(TOTAL);
      for (const { op, path, method } of Object.values(ops)) {
        const two = Object.entries<any>(op.responses ?? {}).filter(([c]) => /^2/.test(c));
        expect(two.length, `${method} ${path}: no 2xx`).toBeGreaterThan(0);
        for (const [c, r] of two) {
          const j = r.content?.["application/json"];
          if (j) expect(Object.keys(j.examples ?? {}).length, `${method} ${path} ${c}: no example`).toBeGreaterThan(0);
          else if (c !== "204" && !r.$ref) expect(Object.keys(r.content ?? {}).length, `${method} ${path} ${c}: no content`).toBeGreaterThan(0);
        }
      }
    });
    it("examples are synthetic: no e-mail, no Nepali-mobile-shaped number, no Windows/user paths, no live-looking token or IP", () => {
      ex();
      const vals = exampleValues();
      expect(vals.length, "no examples at all").toBeGreaterThan(0);
      const blob = JSON.stringify(vals);
      expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
      expect(blob).not.toMatch(/(?<!\d)(?:\+?977[-\s]?)?9[678]\d{8}(?!\d)/);
      expect(blob).not.toMatch(/[A-Z]:\\\\|\/Users\/|\/home\//);
      for (const ip of blob.match(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g) ?? [])
        expect(ip, `non-documentation IP ${ip}`).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
    });
  });

  describe("mock script (wave-1 convention)", () => {
    it("package.json has `mock:inventory` = prism mock contracts/openapi/inventory.yaml on a port no other mock uses", () => {
      const scripts: Record<string, string> = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
      const mine = scripts["mock:inventory"];
      expect(mine, "mock:inventory script missing").toBeDefined();
      const m = /^prism mock contracts\/openapi\/inventory\.yaml --host 127\.0\.0\.1 --port (\d+)$/.exec(mine);
      expect(m, mine).not.toBeNull();
      const ports = Object.entries(scripts).filter(([k]) => k.startsWith("mock:") && k !== "mock:inventory" && k !== "mock:list")
        .map(([, v]) => /--port (\d+)/.exec(v)?.[1]);
      expect(ports).not.toContain(m![1]);
    });
  });
});
