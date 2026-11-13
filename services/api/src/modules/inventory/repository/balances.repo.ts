// inventory.stock_balances (05 §2.14, projection; UNIQUE (tenant, store, item, lot) NULLS NOT DISTINCT). Explicit tenant filter on every statement.
import { type Row, type RepoCtx, first, getRow, insertRow, query, table, updateRow } from './_base.js';

const BALANCES = table('stock_balances', 'M', ['store_id', 'item_id', 'lot_id', 'qty_base', 'value_paisa', 'last_movement_at']);

export const insertBalance = (rc: RepoCtx, row: Row) => insertRow(rc, BALANCES, row);
export const getBalance = (rc: RepoCtx, id: string) => getRow(rc, BALANCES, id);
/** lotId null = the unlotted row. `= $n` / `IS NULL` (not IS NOT DISTINCT FROM) so stock_balances__key__uq stays usable. */
export const getBalanceByKey = (rc: RepoCtx, k: { storeId: string; itemId: string; lotId: string | null }): Promise<Row | null> =>
  k.lotId === null
    ? first(rc, 'SELECT * FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id IS NULL', [k.storeId, k.itemId])
    : first(rc, 'SELECT * FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id = $4', [k.storeId, k.itemId, k.lotId]);
/** Non-zero balances only (partial index stock_balances__tenant_id_store_nonzero__p_idx). */
export const listBalancesByStore = (rc: RepoCtx, storeId: string) =>
  query(rc, 'SELECT * FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND qty_base <> 0 ORDER BY item_id, id', [storeId]);
export const listBalancesByItem = (rc: RepoCtx, itemId: string) =>
  query(rc, 'SELECT * FROM inventory.stock_balances WHERE tenant_id = $1 AND item_id = $2 ORDER BY store_id, id', [itemId]);
export const updateBalance = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, BALANCES, id, expectedVersion, patch);
