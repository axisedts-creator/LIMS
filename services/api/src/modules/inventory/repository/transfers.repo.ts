// inventory.transfers / transfer_lines (05 §2.18). Draft lines are soft-removed (D-71): lists return removed_at IS NULL only, no DELETE.
import { type Row, type RepoCtx, Q, getRow, insertRow, query, softRemove, table, updateRow } from './_base.js';

const TRANSFERS = table('transfers', 'C', ['transfer_no', 'from_store_id', 'to_store_id', 'status', 'dispatched_at', 'dispatched_by', 'received_at', 'received_by', 'cancelled_at',
  'cancelled_by', 'cancel_reason_text', 'notes']);
const LINES = table('transfer_lines', 'C', ['transfer_id', 'line_no', 'item_id', 'lot_id', 'qty_base', 'dispatched_value_paisa', 'received_qty_base', 'discrepancy_reason_code',
  'removed_at', 'removed_by'], { noWrite: ['removed_at', 'removed_by'] });

export const insertTransfer = (rc: RepoCtx, row: Row) => insertRow(rc, TRANSFERS, row);
export const getTransfer = (rc: RepoCtx, id: string) => getRow(rc, TRANSFERS, id);
function listBy(col: 'from_store_id' | 'to_store_id') {
  return (rc: RepoCtx, f: { storeId: string; status?: string }): Promise<Row[]> => {
    const q = new Q();
    const store = q.p(f.storeId);
    const status = f.status !== undefined ? ` AND status = ${q.p(f.status)}` : '';
    return query(rc, `SELECT * FROM inventory.transfers WHERE tenant_id = $1 AND ${col} = ${store}${status} ORDER BY created_at DESC, id`, q.vals);
  };
}
export const listTransfersFrom = listBy('from_store_id');
export const listTransfersTo = listBy('to_store_id');
export const updateTransfer = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, TRANSFERS, id, expectedVersion, patch);

export const insertTransferLine = (rc: RepoCtx, row: Row) => insertRow(rc, LINES, row);
export const getTransferLine = (rc: RepoCtx, id: string) => getRow(rc, LINES, id);
export const listTransferLines = (rc: RepoCtx, transferId: string) =>
  query(rc, 'SELECT * FROM inventory.transfer_lines WHERE tenant_id = $1 AND transfer_id = $2 AND removed_at IS NULL ORDER BY line_no, id', [transferId]);
export const updateTransferLine = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, LINES, id, expectedVersion, patch);
export const removeTransferLine = (rc: RepoCtx, id: string, expectedVersion: number) => softRemove(rc, LINES, id, expectedVersion);
