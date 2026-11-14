// C12.T-13 test helpers (not a test file). Synthetic data only. Operations #56-#62: listTransfers, createTransfer, getTransfer, replaceTransferDraft, dispatchTransfer, receiveTransfer, cancelTransfer.
// SEAMS pinned here (the spec leaves them open; the writer may dispute through the reviewer). Same call convention, gate order and ctx stub as T-08 / T-09 (masters.helpers.ts, lots.helpers.ts):
//   * `handlers[operationId](req, ctx)`; success => { status, body }; failure => the handler THROWS a LimsError. Header keys lower-case; If-Match = `"<version>"`. Query values arrive already typed.
//   * GATE ORDER. #56 (visible-branch list): `IdentityPort.assertRole(ctx, { permission })` with NO branchId is the FIRST thing, then query validation. #57-#62 and #58: request validation (400 / 428)
//     first with the tx untouched (so a stranger with a bad body gets 400, not 403: the permission cannot be checked without reading the row); then 02-TRD §5.4 / scope.service: #57 assertStoreAccess(from)
//     and the `to` store must exist in the tenant (404); #58-#62 assertTransferAccess({ permission, end }): transfer invisible via BOTH ends => 404; visible but the acted-on end is outside the actor's
//     branches => 403 auth.forbidden (P-B3). end = 'from' for #59 #60 #62, 'to' for #61, none (either end) for #58.
//   * STATE CHECK ORDER on #59-#62: scope (404 / 403), then the transition (409 inventory.document_invalid_transition), then If-Match (409 common.version_conflict), then the body rules (422 / 409 ...).
//   * MONEY (02-TRD §6.3): `dispatched_value_paisa` is on the wire only when getActor().permissions includes `inventory.cost.read`.
//   * TENANT TIME: lot expiry ("expiry_on < today" = expired; the expiry day itself is still usable) is judged in the tenant timezone from IdentityPort.getTenantSettings (as T-09), clock = ctx.now().
//   * RECEIVE with received 0 of d dispatched writes NO destination movement (the ledger rejects a zero-quantity movement); the source pair (+d transfer_in, -d wastage) is still written.
//   * REASON on receipt: received < dispatched needs `discrepancy_reason_code` in reason group `transfer_discrepancy` (missing / unknown / other group => 422 inventory.reason_required); the wastage
//     movement carries that code (not a hard-coded one). The "default transit_loss" of AC-10.2 is the code the UI pre-selects; the API never invents one.
//   * receive body rules: every current line exactly once, else 400 common.validation_failed; a line_id that is not a current line of THIS transfer => 404 common.not_found; received > dispatched => 400.
import { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, ifm, makeCtx, onlyKeys, rej, uid, type Req, type Tx } from './masters.helpers.js';
import { COST, makeLotCtx, qty, ymdIn, addDays, type LotOpts, type LotStub } from './lots.helpers.js';

export { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, ifm, makeLotCtx, onlyKeys, qty, rej, uid, ymdIn, addDays, COST };
export type { Req, Tx, LotOpts, LotStub };
export const READ = 'inventory.item.read';
export const MANAGE = 'inventory.stock.manage';

/** operationId -> permission the handler must assert (02-TRD §5.5). */
export const PERMISSION: Record<string, string> = {
  listTransfers: READ, createTransfer: MANAGE, getTransfer: READ, replaceTransferDraft: MANAGE, dispatchTransfer: MANAGE, receiveTransfer: MANAGE, cancelTransfer: MANAGE,
};

/** ctx for a store keeper: item.read + stock.manage, aal2, tenant timezone Asia/Kathmandu. */
export const makeTrCtx = (tx: Tx, tenantId: string, o: LotOpts = {}): LotStub => makeLotCtx(tx, tenantId, { permissions: [READ, MANAGE], ...o });

// ------------------------------------------------------------------ contract shapes (inventory.yaml components Transfer / TransferSummary; no tenant / audit columns ever)
export const TRANSFER_KEYS = ['id', 'transfer_no', 'from_store_id', 'to_store_id', 'status', 'dispatched_at', 'received_at', 'cancelled_at', 'cancel_reason_text', 'notes', 'version', 'lines'];
export const SUMMARY_KEYS = ['id', 'transfer_no', 'from_store_id', 'to_store_id', 'status', 'dispatched_at', 'received_at', 'version'];
export const LINE_KEYS = ['id', 'line_no', 'item_id', 'lot_id', 'qty_base', 'dispatched_value_paisa', 'received_qty_base', 'discrepancy_reason_code'];
export const TRANSFER_NO = /^TR\d{2}\d{6}$/; // transfer_no_pattern default 'TR{yy}{seq:6}' (05-SCHEMA settings)

export const newTransfer = (from: string, to: string, lines: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ from_store_id: from, to_store_id: to, lines, ...over });
export const trLine = (item: string, q: string, lot?: string | null, over: Record<string, unknown> = {}) => ({ item_id: item, qty: q, ...(lot ? { lot_id: lot } : {}), ...over });
export const replaceBody = (lines: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ lines, ...over });
export const recvBody = (lines: { line_id: string; received_qty_base: string; discrepancy_reason_code?: string }[]) => ({ lines });
export const cancelBody = (over: Record<string, unknown> = {}) => ({ reason_text: 'Synthetic cancel reason', ...over });
