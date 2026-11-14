// C12.T-10 test helpers (not a test file). Synthetic data only. Operations #40-#48: discardContainer, listStockDocuments, getStockDocument, createStockIssue, createStoreReturn, createSupplierReturn,
// recordWastage, writeOffExpiredStock, createStockAdjustment.
// SEAMS pinned here (the spec leaves them open; the writer may dispute through the reviewer). Same call convention, gate order and ctx stub as T-09 / T-13 (lots.helpers.ts, transfers.helpers.ts):
//   * `handlers[operationId](req, ctx)`; success => { status, body }; failure => the handler THROWS a LimsError. Header keys lower-case; If-Match = `"<version>"`. Idempotency-Key is the pipeline's job.
//   * GATE ORDER. #41 without store_id: `IdentityPort.assertRole(ctx, { permission })` with NO branchId first. Everything else (#40, #41 with store_id, #42-#48) is branch(store): request validation
//     (400 / 428) first with the tx untouched; then load the store (or the container / document, then its store) via RLS -> unknown or branch not visible => 404 common.not_found ->
//     assertRole({ permission, branchId }) => 403 (P-B8: 404 beats 403).  #48 asserts 'inventory.stock.adjust' (privileged: aal1 => 403 auth.mfa_required, PE-1); #40 asserts 'inventory.bench.record'.
//   * ORDER INSIDE A WRITE (03-APP-FLOW §4.3): scope -> count lock (store_locked_for_count, only when settings.count_locks_store AND an open count exists for the store) -> line validation
//     (item_inactive, uom_mismatch, lot_expired, lot_unavailable) -> FEFO split / reasons -> ledger.post (insufficient_stock).  #40: scope, transition (409 document_invalid_transition), If-Match (409), body rules.
//   * RESPONSE. #43-#48 => 201 StockDocument { id, doc_no, doc_kind, store_id, occurred_at, business_date, ..., lines[], movements[] }; #40 => 200 { container, document }. doc_no follows
//     settings.doc_no_pattern 'SD{yy}{seq:6}'. business_date = the tenant-timezone (Asia/Kathmandu) calendar date of occurred_at; occurred_at defaults to ctx.now().
//   * LINES. One document line PER LOT USED (a FEFO split of one requested line gives several lines, lines[] in FEFO order, line_no 1..n), `direction` 'out' (issue, supplier_return, wastage,
//     expiry_writeoff, adjustment out) or 'in' (return_to_store, adjustment in), qty_base the base quantity (packs resolved server-side). Movements: kind issue / return_to_store / supplier_return /
//     wastage / expiry_writeoff / adjust_in / adjust_out, doc_type 'stock_document', doc_id = document id, one movement per line.
//   * MONEY (02-TRD §6.3 / PE-3): every `_paisa` field of the response (lines[].value_paisa, movements[].value_paisa / value_basis) is on the wire only with `inventory.cost.read`.
//   * REASONS (TRD §5.3 / 05-SCHEMA §2.2): the reason must be an ACTIVE code of the operation's group (#40 / #46 wastage, #45 supplier_return, #48 adjustment; tenant codes shadow global ones). An OMITTED
//     reason_code (AC-11.1 literal: "without a reason code => 422") or an unknown / inactive / other-group code => 422 inventory.reason_required. A MALFORMED code (spaces, upper case, 33 chars) => 400.
//   * TENANT TIME: "expired" = expiry_on < today in the tenant timezone (the expiry day itself is still usable), clock = ctx.now(), as T-09 / T-13.
import { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, ifm, onlyKeys, rej, uid, type Req, type Tx } from './masters.helpers.js';
import { BALANCE_KEYS, BENCH, COST, CONTAINER_KEYS, MOVEMENT_KEYS, addDays, costKeys, makeLotCtx, qty, ymdIn, type LotOpts, type LotStub } from './lots.helpers.js';

export { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, ifm, onlyKeys, rej, uid, BENCH, COST, CONTAINER_KEYS, MOVEMENT_KEYS, BALANCE_KEYS, addDays, costKeys, qty, ymdIn };
export type { Req, Tx, LotOpts, LotStub };
export const READ = 'inventory.item.read';
export const MANAGE = 'inventory.stock.manage';
export const ADJUST = 'inventory.stock.adjust';

/** operationId -> permission the handler must assert (02-TRD §5.2 / §5.3). */
export const PERMISSION: Record<string, string> = {
  discardContainer: BENCH, listStockDocuments: READ, getStockDocument: READ, createStockIssue: MANAGE, createStoreReturn: MANAGE, createSupplierReturn: MANAGE,
  recordWastage: MANAGE, writeOffExpiredStock: MANAGE, createStockAdjustment: ADJUST,
};

/** ctx for a store keeper who may also adjust: item.read + stock.manage + stock.adjust + bench.record, aal2, tenant timezone Asia/Kathmandu. */
export const makeDocCtx = (tx: Tx, tenantId: string, o: LotOpts = {}): LotStub => makeLotCtx(tx, tenantId, { permissions: [READ, MANAGE, ADJUST, BENCH], ...o });

// ------------------------------------------------------------------ contract shapes (inventory.yaml components StockDocument / StockDocumentSummary; no tenant / audit columns ever)
export const DOC_KEYS = ['id', 'doc_no', 'doc_kind', 'store_id', 'occurred_at', 'business_date', 'issued_to_kind', 'department_id', 'instrument_id', 'supplier_id', 'grn_id', 'container_id',
  'reason_code', 'reason_text', 'lines', 'movements'];
export const DOC_SUMMARY_KEYS = ['id', 'doc_no', 'doc_kind', 'store_id', 'occurred_at', 'business_date', 'issued_to_kind', 'department_id', 'instrument_id', 'supplier_id', 'grn_id', 'container_id',
  'reason_code', 'reason_text', 'line_count'];
export const DOC_LINE_KEYS = ['id', 'line_no', 'item_id', 'lot_id', 'direction', 'qty_base', 'value_paisa', 'reason_code'];
export const DOC_NO = /^SD\d{2}\d{6}$/; // doc_no_pattern default 'SD{yy}{seq:6}' (05-SCHEMA settings)
export const DOC_KINDS = ['issue', 'return_to_store', 'supplier_return', 'wastage', 'adjustment', 'expiry_writeoff'];
export const KIND_OF: Record<string, string> = {
  createStockIssue: 'issue', createStoreReturn: 'return_to_store', createSupplierReturn: 'supplier_return', recordWastage: 'wastage', writeOffExpiredStock: 'expiry_writeoff', createStockAdjustment: 'adjustment',
};

// ------------------------------------------------------------------ request builders
export const dLine = (item: string, q: string, lot?: string | null, over: Record<string, unknown> = {}) => ({ item_id: item, qty: q, ...(lot ? { lot_id: lot } : {}), ...over });
export const aLine = (item: string, direction: 'in' | 'out', q: string, lot?: string | null, over: Record<string, unknown> = {}) => ({ ...dLine(item, q, lot), direction, ...over });
export const issueBody = (store: string, lines: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ store_id: store, issued_to_kind: 'general', lines, ...over });
export const returnBody = (store: string, lines: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ store_id: store, lines, ...over });
export const supplierReturnBody = (store: string, supplier: string, lines: Record<string, unknown>[], over: Record<string, unknown> = {}) =>
  ({ store_id: store, supplier_id: supplier, reason_code: 'damaged_on_arrival', lines, ...over });
export const wastageBody = (store: string, lines: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ store_id: store, reason_code: 'spillage', lines, ...over });
export const writeoffBody = (store: string, lotIds: string[], over: Record<string, unknown> = {}) => ({ store_id: store, lot_ids: lotIds, ...over });
export const adjustBody = (store: string, lines: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ store_id: store, reason_code: 'stock_correction', lines, ...over });
export const discardBody = (q: string, over: Record<string, unknown> = {}) => ({ qty_base: q, reason_code: 'spillage', ...over });

export const isDocShape = (d: any): string[] => onlyKeys(d, DOC_KEYS);
