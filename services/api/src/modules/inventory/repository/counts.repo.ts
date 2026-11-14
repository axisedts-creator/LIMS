// inventory.stock_counts / stock_count_lines (05 §2.20; lines UNIQUE (count, item, lot) NULLS NOT DISTINCT). Explicit tenant filter on every statement.
import { type Row, type RepoCtx, Q, getRow, insertRow, query, table, updateRow } from './_base.js';

const COUNTS = table('stock_counts', 'C', ['count_no', 'store_id', 'status', 'scope_category', 'snapshot_at', 'posted_at', 'posted_by', 'cancelled_at', 'cancelled_by', 'notes']);
const LINES = table('stock_count_lines', 'C', ['count_id', 'item_id', 'lot_id', 'book_qty_snapshot', 'counted_qty_base', 'counted_at', 'counted_by', 'book_qty_at_count',
  'variance_qty_base', 'variance_value_paisa', 'reason_code']);

export const insertCount = (rc: RepoCtx, row: Row) => insertRow(rc, COUNTS, row);
export const getCount = (rc: RepoCtx, id: string) => getRow(rc, COUNTS, id);
export function listCounts(rc: RepoCtx, f: { storeId: string; status?: string }): Promise<Row[]> {
  const q = new Q();
  const store = q.p(f.storeId);
  const status = f.status !== undefined ? ` AND status = ${q.p(f.status)}` : '';
  return query(rc, `SELECT * FROM inventory.stock_counts WHERE tenant_id = $1 AND store_id = ${store}${status} ORDER BY created_at DESC, id`, q.vals);
}
export const updateCount = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, COUNTS, id, expectedVersion, patch);

export const insertCountLine = (rc: RepoCtx, row: Row) => insertRow(rc, LINES, row);
export const getCountLine = (rc: RepoCtx, id: string) => getRow(rc, LINES, id);
export const listCountLines = (rc: RepoCtx, countId: string) =>
  query(rc, 'SELECT * FROM inventory.stock_count_lines WHERE tenant_id = $1 AND count_id = $2 ORDER BY id', [countId]);
export const updateCountLine = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, LINES, id, expectedVersion, patch);
