// inventory.lots (05 §2.13). Explicit tenant filter on every statement.
import { type Row, type RepoCtx, first, getRow, insertRow, query, table, updateRow } from './_base.js';

const LOTS = table('lots', 'M', ['item_id', 'lot_no', 'expiry_on', 'manufactured_on', 'status', 'status_reason_code', 'last_receipt_qty_base', 'last_receipt_value_paisa']);

export const insertLot = (rc: RepoCtx, row: Row) => insertRow(rc, LOTS, row);
export const getLot = (rc: RepoCtx, id: string) => getRow(rc, LOTS, id);
export const getLotByNo = (rc: RepoCtx, itemId: string, lotNo: string) =>
  first(rc, 'SELECT * FROM inventory.lots WHERE tenant_id = $1 AND item_id = $2 AND lot_no = $3', [itemId, lotNo]);
/** Expiry scan (partial index lots__tenant_id_expiry_on__idx): expiry_on < date ('YYYY-MM-DD'); order expiry_on, id. */
export const listLotsExpiringBefore = (rc: RepoCtx, date: string): Promise<Row[]> =>
  query(rc, 'SELECT * FROM inventory.lots WHERE tenant_id = $1 AND expiry_on < $2 ORDER BY expiry_on, id', [date]);
export const updateLot = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, LOTS, id, expectedVersion, patch);
