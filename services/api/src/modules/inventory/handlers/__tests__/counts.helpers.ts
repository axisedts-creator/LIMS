// C12.T-14 test helpers (not a test file). Synthetic data only. Operations #63-#68: listStockCounts, openStockCount, getStockCount, recordStockCountLines, postStockCount, cancelStockCount.
// SEAMS pinned here (the spec leaves them open; the writer may dispute through the reviewer). Same call convention, ctx stub and gate order as T-13 (transfers.helpers.ts) / T-09 (lots.helpers.ts):
//   * `handlers[operationId](req, ctx)`; success => { status, body }; failure => the handler THROWS a LimsError. Header keys lower-case; If-Match = `"<version>"`. Idempotency-Key is the core's job (not tested here).
//   * GATE ORDER. #63 (visible-branch list, no store_id): `IdentityPort.assertRole(ctx, { permission })` with NO branchId is the FIRST thing, then query validation. #64-#68: request validation (400 / 428) first with
//     the tx untouched; then #64 assertStoreAccess(store, MANAGE); #65-#68 load the count -> its store -> branch visible? else 404 common.not_found -> assertRole({ permission, branchId }) (403; P-B8: 404 beats 403).
//     #67 asserts `inventory.stock.adjust` (privileged: at aal1 the port rejects with 403 auth.mfa_required). #66 / #68 assert `inventory.stock.manage`, #65 `inventory.item.read`.
//   * STATE CHECK ORDER on #66-#68: scope (404 / 403), then the transition (409 inventory.document_invalid_transition: only an `open` count can be recorded / posted / cancelled), then If-Match (409 common.version_conflict; #67 #68 only).
//   * SNAPSHOT. `snapshot_at` and the default `counted_at` are `ctx.now()` (ISO); lines are every balance row of the store with qty_base <> 0 (negative unlotted rows included), filtered by `scope_category` of the ITEM when given.
//   * BLIND COUNT (PE / 07-SECURITY "blind count by default", 04-UI-UX S11). The API enforces it: a caller WITHOUT `inventory.stock.adjust` gets count lines WITHOUT `book_qty_snapshot`, `book_qty_at_count`,
//     `variance_qty_base`, `variance_value_paisa`. A holder of `inventory.stock.adjust` gets them (the UI's "Show system quantity" switch). `variance_value_paisa` ALSO needs `inventory.cost.read` (02-TRD §6.3).
//     NOTE: contracts/openapi/inventory.yaml lists `book_qty_snapshot` under CountLine.required; blind count conflicts with that. If the writer cannot satisfy both, dispute -> CR for C0.
//   * VARIANCE (TRD / 03-APP-FLOW K3): book_at_count = snapshot + sum(movements of (store,item,lot) with snapshot_at < occurred_at <= counted_at); variance = counted - book_at_count. Dates compare occurred_at, never created_at.
//   * POST writes `count_adjust_in` (variance > 0) / `count_adjust_out` (variance < 0) with doc_type 'stock_count', doc_id = count id, doc_line_id = the line, reason_code = the line's reason or 'count_variance'.
//     A zero variance writes NO movement (line still gets book_at_count, variance 0). A negative variance larger than the lot row's quantity splits (ledger) and raises `negative_stock`; the post never fails.
//   * UNCOUNTED POLICY. 'skip': lines with counted_qty_base NULL are left alone (no movement; book_at_count / variance stay NULL). 'zero': they are counted as 0 at post time (counted_at = ctx.now()).
//   * #66 body: no line_id => the line is found by (item_id, lot_id); a pair that is not in the count creates a line with book_qty_snapshot = the current balance (0 if none). Duplicate line_id or duplicate (item_id, lot_id)
//     inside one request => 400. The whole request is atomic (one bad line => nothing applied). Latest entry wins (re-recording overwrites). No stock effect.
import { LimsError } from '../../../../core/errors.js';
import { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, ifm, makeCtx, onlyKeys, rej, uid, type Req, type Tx } from './masters.helpers.js';
import { ADJUST, COST, makeLotCtx, qty, ymdIn, addDays, type LotOpts, type LotStub } from './lots.helpers.js';

export { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, ifm, makeCtx, makeLotCtx, onlyKeys, qty, rej, uid, ymdIn, addDays, ADJUST, COST, LimsError };
export type { Req, Tx, LotOpts, LotStub };
export const READ = 'inventory.item.read';
export const MANAGE = 'inventory.stock.manage';

/** operationId -> permission the handler must assert (02-TRD §5.5). */
export const PERMISSION: Record<string, string> = {
  listStockCounts: READ, openStockCount: MANAGE, getStockCount: READ, recordStockCountLines: MANAGE, postStockCount: ADJUST, cancelStockCount: MANAGE,
};

/** ctx for a store keeper (BLIND: item.read + stock.manage, aal2, tenant timezone Asia/Kathmandu). */
export const makeKeeperCtx = (tx: Tx, tenantId: string, o: LotOpts = {}): LotStub => makeLotCtx(tx, tenantId, { permissions: [READ, MANAGE], ...o });
/** ctx for a lab manager who may post a count and see system quantities (item.read + stock.manage + stock.adjust). */
export const makeLeadCtx = (tx: Tx, tenantId: string, o: LotOpts = {}): LotStub => makeLotCtx(tx, tenantId, { permissions: [READ, MANAGE, ADJUST], ...o });

// ------------------------------------------------------------------ contract shapes (inventory.yaml components Count / CountSummary / CountLine; no tenant / audit columns ever)
export const COUNT_KEYS = ['id', 'count_no', 'store_id', 'status', 'scope_category', 'snapshot_at', 'posted_at', 'cancelled_at', 'notes', 'version', 'lines', 'lines_page'];
export const SUMMARY_KEYS = ['id', 'count_no', 'store_id', 'status', 'scope_category', 'snapshot_at', 'posted_at', 'version'];
export const LINE_KEYS = ['id', 'item_id', 'lot_id', 'book_qty_snapshot', 'counted_qty_base', 'counted_at', 'book_qty_at_count', 'variance_qty_base', 'variance_value_paisa', 'reason_code', 'version'];
export const BOOK_KEYS = ['book_qty_snapshot', 'book_qty_at_count', 'variance_qty_base', 'variance_value_paisa'];
export const COUNT_NO = /^SC\d{2}\d{5}$/; // count_no_pattern default 'SC{yy}{seq:5}' (05-SCHEMA settings)

export const openBody = (store: string, over: Record<string, unknown> = {}) => ({ store_id: store, ...over });
export const cLine = (item: string, counted: string, lot?: string | null, over: Record<string, unknown> = {}) => ({ item_id: item, counted_qty_base: counted, ...(lot ? { lot_id: lot } : {}), ...over });
export const recBody = (lines: Record<string, unknown>[]) => ({ lines });
export const postBody = (policy: 'skip' | 'zero' = 'skip', over: Record<string, unknown> = {}) => ({ uncounted_policy: policy, ...over });
