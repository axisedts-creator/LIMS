// inventory.stock_movements (05 §2.15, class A: append-only ledger). NO update / remove export: lims_api holds no UPDATE/DELETE grant (05 §4.4).
import { type Row, type RepoCtx, Q, getRow, insertRow, limitOf, query, table } from './_base.js';

const MOVEMENTS = table('stock_movements', 'A', ['business_date', 'occurred_at', 'store_id', 'item_id', 'lot_id', 'movement_kind', 'qty_base', 'value_paisa', 'value_basis',
  'doc_type', 'doc_id', 'doc_line_id', 'instrument_id', 'attributed_test_id', 'rule_id', 'reason_code', 'reverses_movement_id', 'balance_qty_after']);

export const insertMovement = (rc: RepoCtx, row: Row) => insertRow(rc, MOVEMENTS, row);
export const getMovement = (rc: RepoCtx, id: string) => getRow(rc, MOVEMENTS, id);
/** Newest first (index stock_movements__tenant_id_store_item__idx). */
export function listMovementsByStoreItem(rc: RepoCtx, f: { storeId: string; itemId: string; limit?: number }): Promise<Row[]> {
  const q = new Q();
  return query(rc, `SELECT * FROM inventory.stock_movements WHERE tenant_id = $1 AND store_id = ${q.p(f.storeId)} AND item_id = ${q.p(f.itemId)}
                    ORDER BY occurred_at DESC, id LIMIT ${q.p(limitOf(f.limit))}`, q.vals);
}
export const listMovementsByDoc = (rc: RepoCtx, f: { docType: string; docId: string }) =>
  query(rc, 'SELECT * FROM inventory.stock_movements WHERE tenant_id = $1 AND doc_type = $2 AND doc_id = $3 ORDER BY occurred_at, id', [f.docType, f.docId]);
/** Lot history (partial index ..._lot__p_idx: lot_id IS NOT NULL is implied by lot_id = $2). */
export const listMovementsByLot = (rc: RepoCtx, lotId: string) =>
  query(rc, 'SELECT * FROM inventory.stock_movements WHERE tenant_id = $1 AND lot_id = $2 ORDER BY occurred_at, id', [lotId]);
