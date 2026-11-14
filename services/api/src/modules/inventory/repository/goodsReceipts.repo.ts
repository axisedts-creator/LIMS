// inventory.goods_receipts / goods_receipt_lines (05 §2.17). Draft lines are soft-removed (D-71): lists return removed_at IS NULL only, no DELETE.
import { type Row, type RepoCtx, Q, getRow, insertRow, limitOf, query, softRemove, table, updateRow } from './_base.js';

const GRNS = table('goods_receipts', 'C', ['grn_no', 'kind', 'store_id', 'supplier_id', 'po_id', 'status', 'received_at', 'supplier_invoice_no', 'supplier_invoice_on',
  'supplier_invoice_total_paisa', 'subtotal_paisa', 'discount_paisa', 'net_paisa', 'vat_paisa', 'total_paisa', 'posted_at', 'posted_by', 'cancelled_at', 'cancelled_by',
  'cancel_reason_text', 'notes']);
const LINES = table('goods_receipt_lines', 'C', ['grn_id', 'line_no', 'po_line_id', 'item_id', 'pack_id', 'qty_packs', 'qty_in_base_snapshot', 'qty_base', 'lot_no', 'expiry_on',
  'manufactured_on', 'lot_id', 'unit_price_paisa', 'discount_paisa', 'tax_code', 'tax_rate_bp', 'net_paisa', 'vat_paisa', 'line_total_paisa', 'capitalised_value_paisa',
  'removed_at', 'removed_by'], { noWrite: ['removed_at', 'removed_by'] });

export const insertGrn = (rc: RepoCtx, row: Row) => insertRow(rc, GRNS, row);
export const getGrn = (rc: RepoCtx, id: string) => getRow(rc, GRNS, id);
/** Newest received first (index goods_receipts__tenant_id_store_status__idx). */
export function listGrns(rc: RepoCtx, f: { storeId: string; status?: string; limit?: number }): Promise<Row[]> {
  const q = new Q();
  const store = q.p(f.storeId);
  const status = f.status !== undefined ? ` AND status = ${q.p(f.status)}` : '';
  return query(rc, `SELECT * FROM inventory.goods_receipts WHERE tenant_id = $1 AND store_id = ${store}${status} ORDER BY received_at DESC, id LIMIT ${q.p(limitOf(f.limit))}`, q.vals);
}
export function listGrnsBySupplier(rc: RepoCtx, f: { supplierId: string; limit?: number }): Promise<Row[]> {
  const q = new Q();
  return query(rc, `SELECT * FROM inventory.goods_receipts WHERE tenant_id = $1 AND supplier_id = ${q.p(f.supplierId)} ORDER BY received_at DESC, id LIMIT ${q.p(limitOf(f.limit))}`, q.vals);
}
export const updateGrn = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, GRNS, id, expectedVersion, patch);

export const insertGrnLine = (rc: RepoCtx, row: Row) => insertRow(rc, LINES, row);
export const getGrnLine = (rc: RepoCtx, id: string) => getRow(rc, LINES, id);
export const listGrnLines = (rc: RepoCtx, grnId: string) =>
  query(rc, 'SELECT * FROM inventory.goods_receipt_lines WHERE tenant_id = $1 AND grn_id = $2 AND removed_at IS NULL ORDER BY line_no, id', [grnId]);
export const updateGrnLine = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, LINES, id, expectedVersion, patch);
export const removeGrnLine = (rc: RepoCtx, id: string, expectedVersion: number) => softRemove(rc, LINES, id, expectedVersion);
