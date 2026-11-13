// inventory.purchase_orders / purchase_order_lines (05 §2.16). Draft lines are soft-removed (D-71): lists return removed_at IS NULL only, no DELETE.
import { type Row, type RepoCtx, Q, getRow, insertRow, limitOf, query, softRemove, table, updateRow } from './_base.js';

const POS = table('purchase_orders', 'C', ['po_no', 'branch_id', 'store_id', 'supplier_id', 'status', 'source', 'expected_on', 'notes', 'subtotal_paisa', 'discount_paisa', 'net_paisa',
  'vat_paisa', 'total_paisa', 'approved_at', 'approved_by', 'sent_at', 'sent_by', 'sent_channel', 'sent_reference', 'cancelled_at', 'cancelled_by', 'cancel_reason_code',
  'cancel_reason_text', 'closed_at', 'closed_by', 'close_reason_code', 'close_reason_text']);
const LINES = table('purchase_order_lines', 'C', ['po_id', 'line_no', 'item_id', 'pack_id', 'qty_packs', 'qty_in_base_snapshot', 'qty_base', 'unit_price_paisa', 'discount_paisa',
  'tax_code', 'tax_rate_bp', 'net_paisa', 'vat_paisa', 'line_total_paisa', 'received_qty_base', 'is_closed_short', 'removed_at', 'removed_by'], { noWrite: ['removed_at', 'removed_by'] });

export const insertPo = (rc: RepoCtx, row: Row) => insertRow(rc, POS, row);
export const getPo = (rc: RepoCtx, id: string) => getRow(rc, POS, id);
/** Filters combine with AND; newest first (indexes ..._status / _supplier / _branch). */
export function listPos(rc: RepoCtx, f: { status?: string; supplierId?: string; branchId?: string; limit?: number } = {}): Promise<Row[]> {
  const q = new Q();
  let w = '';
  if (f.status !== undefined) w += ` AND status = ${q.p(f.status)}`;
  if (f.supplierId !== undefined) w += ` AND supplier_id = ${q.p(f.supplierId)}`;
  if (f.branchId !== undefined) w += ` AND branch_id = ${q.p(f.branchId)}`;
  return query(rc, `SELECT * FROM inventory.purchase_orders WHERE tenant_id = $1${w} ORDER BY created_at DESC, id LIMIT ${q.p(limitOf(f.limit))}`, q.vals);
}
export const updatePo = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, POS, id, expectedVersion, patch);

export const insertPoLine = (rc: RepoCtx, row: Row) => insertRow(rc, LINES, row);
export const getPoLine = (rc: RepoCtx, id: string) => getRow(rc, LINES, id);
export const listPoLines = (rc: RepoCtx, poId: string) =>
  query(rc, 'SELECT * FROM inventory.purchase_order_lines WHERE tenant_id = $1 AND po_id = $2 AND removed_at IS NULL ORDER BY line_no, id', [poId]);
export const updatePoLine = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, LINES, id, expectedVersion, patch);
export const removePoLine = (rc: RepoCtx, id: string, expectedVersion: number) => softRemove(rc, LINES, id, expectedVersion);
