// C12.T-11 test helpers (not a test file). Synthetic data only. Operations #80-#89: listPurchaseOrders, createPurchaseOrder, getPurchaseOrder, replacePurchaseOrderDraft, approvePurchaseOrder,
// markPurchaseOrderSent, cancelPurchaseOrder, closePurchaseOrder, createPurchaseOrdersFromReorder, getPurchaseOrderPrintView.
// SEAMS pinned here (the spec leaves them open; the writer may dispute through the reviewer). Same call convention, gate order and ctx stub as T-08 / T-09 / T-13 (masters / lots / transfers helpers):
//   * `handlers[operationId](req, ctx)`; success => { status, body }; failure => the handler THROWS a LimsError. Header keys lower-case; If-Match = `"<version>"`. Query values arrive already typed.
//   * GATE ORDER. #80: `IdentityPort.assertRole(ctx, { permission })` with NO branchId FIRST, then query validation. #81 / #88 (branch(store)): request validation (400) with the tx untouched, then the store is
//     read (unknown / branch not visible => 404) and assertRole({ permission, branchId }) => 403 (P-B8). #82-#89 (branch(PO)): path / header / body validation first with the tx untouched, then the PO is read
//     (unknown / branch not visible => 404), then assertRole({ permission, branchId: po.branch_id }) => 403 / 403 auth.mfa_required, then the state check (409 inventory.po_invalid_transition), then If-Match
//     (409 common.version_conflict), then the body rules (422 inventory.reason_required, ...). #86: the extra `inventory.po.approve` is asserted (branch of the PO) only when the PO status is approved / sent.
//   * VALIDATION ORDER on #84 #86 #87 (Idempotency-Key required, P-8; x-idempotency: required): the request is checked in full BEFORE any tx statement: path uuid (400), If-Match (428 / 400),
//     Idempotency-Key header (missing / empty => 400 common.idempotency_key_required), body (400). Each contract test sends ONE defect, so the relative order of the checks is not pinned.
//     #85 takes the key optionally. Replay of a stored key is the pipeline's job (not tested here).
//   * TAX. `ctx.ports.CatalogPort.getTaxRate(ctx, { taxCode, on })` -> { taxCode, ratePercentBasisPoints, kind, effectiveFrom } (08 A4.1). `on` = the tenant business date of ctx.now() in the tenant timezone
//     (IdentityPort.getTenantSettings, Asia/Kathmandu). It is called once per distinct non-exempt tax code (the test accepts one call per line as well: only the SET of (code, on) pairs is pinned) and NEVER for an
//     exempt line. A LimsError thrown by the port propagates as the SAME object (P-23) and nothing is written.
//   * ACTOR. `ctx.actor.id` is the creator (purchase_orders.created_by) and the approver (approved_by). Self-approval = ctx.actor.id === po.created_by while settings.po_self_approval_allowed = false.
//   * MONEY (02-TRD §6.3): every property ending in `_paisa` is on the wire only when getActor().permissions includes `inventory.cost.read`; the print view needs it (403 auth.forbidden without).
//   * RESPONSES: Po / PoSummary carry no tenant / audit columns; an exempt line carries `is_exempt: true` and NO `tax_code` key (never null); `tax_rate_bp` is on the line; removed lines never appear.
import { LimsError } from '../../../../core/errors.js';
import { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, ifm, onlyKeys, rej, uid, type Req, type Tx } from './masters.helpers.js';
import { COST, makeLotCtx, addDays, ymdIn, type LotOpts, type LotStub } from './lots.helpers.js';

export { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, ifm, onlyKeys, rej, uid, COST, addDays, ymdIn };
export type { Req, Tx, LotOpts };
export const READ = 'inventory.item.read';
export const PO_MANAGE = 'inventory.po.manage';
export const PO_APPROVE = 'inventory.po.approve';

/** operationId -> permission the handler must assert first (02-TRD §5.5; #86 adds PO_APPROVE for approved / sent POs; #89 adds READ). */
export const PERMISSION: Record<string, string> = {
  listPurchaseOrders: READ, createPurchaseOrder: PO_MANAGE, getPurchaseOrder: READ, replacePurchaseOrderDraft: PO_MANAGE, approvePurchaseOrder: PO_APPROVE, markPurchaseOrderSent: PO_MANAGE,
  cancelPurchaseOrder: PO_MANAGE, closePurchaseOrder: PO_MANAGE, createPurchaseOrdersFromReorder: PO_MANAGE, getPurchaseOrderPrintView: COST,
};

/** Rates the fake C3 returns, in basis points (the 04 L14 VAT rate is 13 % = 1300). Any other code => catalog.tax_config_missing. */
export const RATES: Record<string, number> = { VAT: 1300, LOCALTAX: 500 };

export interface PoOpts extends LotOpts { actor?: string; rates?: Record<string, number>; taxFailure?: LimsError }
export interface PoStub extends LotStub { taxCalls: { taxCode: string; on: string }[] }

/** ctx for a purchasing clerk + approver: item.read, po.manage, po.approve, cost.read; aal2; tenant timezone Asia/Kathmandu; fake CatalogPort.getTaxRate that records its calls. */
export function makePoCtx(tx: Tx, tenantId: string, o: PoOpts = {}): PoStub {
  const st = makeLotCtx(tx, tenantId, { permissions: [READ, PO_MANAGE, PO_APPROVE, COST], ...o });
  const port = st.ctx.ports.IdentityPort;
  const base = port.assertRole.bind(port);
  port.assertRole = async (c: unknown, req: { permission: string; branchId?: string }) => {
    await base(c, req); // records the request, rejects a missing permission with auth.forbidden
    if (req.permission === PO_APPROVE && (o.aal ?? 'aal2') === 'aal1') throw new LimsError('auth.mfa_required'); // privileged (PE-1)
  };
  st.ctx.actor = { type: 'user', id: o.actor ?? SYS };
  const taxCalls: { taxCode: string; on: string }[] = [];
  const rates = o.rates ?? RATES;
  st.ctx.ports.CatalogPort = {
    async getTaxRate(_c: unknown, i: { taxCode: string; on: string }) {
      taxCalls.push({ taxCode: i.taxCode, on: i.on });
      if (o.taxFailure) throw o.taxFailure;
      const bp = rates[i.taxCode];
      if (bp === undefined) throw new LimsError('catalog.tax_config_missing');
      return { taxCode: i.taxCode, ratePercentBasisPoints: bp, kind: 'vat', effectiveFrom: null };
    },
  };
  return { ...st, taxCalls };
}

// ------------------------------------------------------------------ contract shapes (inventory.yaml components Po / PoSummary / PoPrintView; no tenant / audit columns ever)
export const PO_KEYS = ['id', 'po_no', 'branch_id', 'store_id', 'supplier_id', 'status', 'source', 'expected_on', 'notes', 'subtotal_paisa', 'discount_paisa', 'net_paisa', 'vat_paisa', 'total_paisa',
  'approved_at', 'sent_at', 'sent_channel', 'sent_reference', 'cancelled_at', 'cancel_reason_code', 'cancel_reason_text', 'closed_at', 'close_reason_code', 'close_reason_text', 'created_at', 'version', 'lines', 'receipts'];
export const SUMMARY_KEYS = ['id', 'po_no', 'branch_id', 'store_id', 'supplier_id', 'status', 'source', 'expected_on', 'total_paisa', 'created_at', 'version'];
export const LINE_KEYS = ['id', 'line_no', 'item_id', 'pack_id', 'qty_packs', 'qty_base', 'unit_price_paisa', 'discount_paisa', 'tax_code', 'is_exempt', 'tax_rate_bp', 'net_paisa', 'vat_paisa', 'line_total_paisa',
  'received_qty_base', 'open_qty_base', 'is_closed_short'];
export const PRINT_KEYS = ['is_draft', 'tenant_display_name', 'branch_name', 'po_no', 'status', 'created_at', 'expected_on', 'supplier', 'lines', 'subtotal_paisa', 'discount_paisa', 'net_paisa', 'vat_paisa', 'total_paisa'];
export const PRINT_LINE_KEYS = ['line_no', 'item_code', 'item_name', 'pack_label', 'qty_packs', 'unit_price_paisa', 'discount_paisa', 'tax_code', 'is_exempt', 'line_total_paisa'];
export const PO_NO = /^PO\d{2}\d{6}$/; // po_no_pattern default 'PO{yy}{seq:6}' (05-SCHEMA settings)
export const MONEY_KEY = /_paisa(_x1e6)?$/;

// ------------------------------------------------------------------ request builders
export const poLine = (item: string, pack: string, qtyPacks: string, over: Record<string, unknown> = {}) => ({ item_id: item, pack_id: pack, qty_packs: qtyPacks, ...over });
export const newPo = (supplier: string, store: string, lines: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ supplier_id: supplier, store_id: store, lines, ...over });
export const sentBody = (over: Record<string, unknown> = {}) => ({ sent_channel: 'email', sent_reference: 'SYN-REF-1', ...over });
export const cancelBody = (over: Record<string, unknown> = {}) => ({ reason_code: 'no_longer_needed', ...over });
export const closeBody = (over: Record<string, unknown> = {}) => ({ reason_code: 'short_supply', ...over });
export const reorderBody = (store: string, over: Record<string, unknown> = {}) => ({ store_id: store, ...over });
/** Idempotency-Key header (required on #84 #86 #87, P-8; also accepted on every other write). */
export const idem = (k = 'syn-key-1') => ({ 'idempotency-key': k });
export const hdr = (version: number, k = 'syn-key-1') => ({ ...ifm(version), ...idem(k) });
