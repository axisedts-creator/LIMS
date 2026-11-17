// inventory.suppliers / supplier_items (05 §2.11, §2.12). Explicit tenant filter on every statement.
import { type ListOpts, type Row, type RepoCtx, Q, activeOnly, getRow, insertRow, limitOf, prefixOf, query, table, updateRow } from './_base.js';

const SUPPLIERS = table('suppliers', 'M', ['supplier_code', 'name', 'pan_text', 'contact_name', 'phone_display', 'email', 'address_text', 'payment_terms_days', 'notes']);
const SUPPLIER_ITEMS = table('supplier_items', 'M', ['supplier_id', 'item_id', 'pack_id', 'supplier_item_code', 'last_unit_price_paisa', 'lead_time_days', 'default_tax_code']);

export const insertSupplier = (rc: RepoCtx, row: Row) => insertRow(rc, SUPPLIERS, row);
export const getSupplier = (rc: RepoCtx, id: string) => getRow(rc, SUPPLIERS, id);
/** namePrefix: case-insensitive prefix on lower(name) (#17); order: name, id. */
export function listSuppliers(rc: RepoCtx, f: { namePrefix?: string; limit?: number } = {}, opts?: ListOpts): Promise<Row[]> {
  const q = new Q();
  const w = activeOnly(opts) + (f.namePrefix !== undefined ? ` AND lower(name) LIKE lower(${q.p(prefixOf(f.namePrefix))})` : '');
  return query(rc, `SELECT * FROM inventory.suppliers WHERE tenant_id = $1${w} ORDER BY name, id LIMIT ${q.p(limitOf(f.limit))}`, q.vals);
}
export const updateSupplier = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, SUPPLIERS, id, expectedVersion, patch);

export const insertSupplierItem = (rc: RepoCtx, row: Row) => insertRow(rc, SUPPLIER_ITEMS, row);
export const getSupplierItem = (rc: RepoCtx, id: string) => getRow(rc, SUPPLIER_ITEMS, id);
export const listSupplierItemsByItem = (rc: RepoCtx, itemId: string, opts?: ListOpts) =>
  query(rc, `SELECT * FROM inventory.supplier_items WHERE tenant_id = $1 AND item_id = $2${activeOnly(opts)} ORDER BY id`, [itemId]);
export const updateSupplierItem = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, SUPPLIER_ITEMS, id, expectedVersion, patch);
