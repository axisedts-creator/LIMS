// inventory.stores / store_item_settings / instrument_bindings (05 §2.9, §2.10, §2.22). Explicit tenant filter on every statement.
import { type ListOpts, type Row, type RepoCtx, Q, activeOnly, getRow, insertRow, query, table, updateRow } from './_base.js';

const STORES = table('stores', 'M', ['branch_id', 'store_code', 'name', 'store_kind', 'is_default_consumption']);
const SETTINGS = table('store_item_settings', 'M', ['store_id', 'item_id', 'reorder_level_base', 'reorder_qty_base', 'max_level_base', 'preferred_supplier_id', 'is_stocked']);
const BINDINGS = table('instrument_bindings', 'M', ['instrument_id', 'store_id']);

export const insertStore = (rc: RepoCtx, row: Row) => insertRow(rc, STORES, row);
export const getStore = (rc: RepoCtx, id: string) => getRow(rc, STORES, id);
export function listStores(rc: RepoCtx, f: { branchId?: string } = {}, opts?: ListOpts): Promise<Row[]> {
  const q = new Q();
  const w = activeOnly(opts) + (f.branchId !== undefined ? ` AND branch_id = ${q.p(f.branchId)}` : '');
  return query(rc, `SELECT * FROM inventory.stores WHERE tenant_id = $1${w} ORDER BY store_code, id`, q.vals);
}
export const updateStore = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, STORES, id, expectedVersion, patch);

export const insertStoreItemSetting = (rc: RepoCtx, row: Row) => insertRow(rc, SETTINGS, row);
export const getStoreItemSetting = (rc: RepoCtx, id: string) => getRow(rc, SETTINGS, id);
/** Reorder scan: active settings with a reorder level (partial index store_item_settings__tenant_id_reorder__p_idx). */
export const listReorderSettings = (rc: RepoCtx, storeId: string) =>
  query(rc, 'SELECT * FROM inventory.store_item_settings WHERE tenant_id = $1 AND store_id = $2 AND is_active AND reorder_level_base IS NOT NULL ORDER BY item_id, id', [storeId]);
export const updateStoreItemSetting = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, SETTINGS, id, expectedVersion, patch);

export const insertInstrumentBinding = (rc: RepoCtx, row: Row) => insertRow(rc, BINDINGS, row);
export const getInstrumentBinding = (rc: RepoCtx, id: string) => getRow(rc, BINDINGS, id);
export const listBindingsByStore = (rc: RepoCtx, storeId: string, opts?: ListOpts) =>
  query(rc, `SELECT * FROM inventory.instrument_bindings WHERE tenant_id = $1 AND store_id = $2${activeOnly(opts)} ORDER BY id`, [storeId]);
export const updateInstrumentBinding = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, BINDINGS, id, expectedVersion, patch);
