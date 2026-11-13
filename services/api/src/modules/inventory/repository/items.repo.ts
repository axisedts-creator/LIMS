// inventory.items / item_packs / item_barcodes (05 §2.6-2.8). Explicit tenant filter on every statement (REQ-SEC-024); lists = is_active only unless includeInactive.
import { type ListOpts, type Row, type RepoCtx, Q, activeOnly, first, getRow, insertRow, limitOf, prefixOf, query, table, updateRow } from './_base.js';

const ITEMS = table('items', 'M', ['item_code', 'name', 'category', 'base_uom_code', 'manufacturer', 'catalogue_no', 'storage_condition', 'is_lot_tracked', 'requires_expiry',
  'open_stability_days', 'container_qty_base', 'hs_code', 'default_tax_code', 'notes']);
const PACKS = table('item_packs', 'M', ['item_id', 'pack_code', 'label', 'uom_code', 'qty_in_base', 'is_purchase_default']);
const BARCODES = table('item_barcodes', 'M', ['item_id', 'pack_id', 'barcode_value']);

export const insertItem = (rc: RepoCtx, row: Row) => insertRow(rc, ITEMS, row);
export const getItem = (rc: RepoCtx, id: string) => getRow(rc, ITEMS, id);
export const getItemByCode = (rc: RepoCtx, code: string) => first(rc, 'SELECT * FROM inventory.items WHERE tenant_id = $1 AND item_code = $2', [code]);
export const updateItem = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, ITEMS, id, expectedVersion, patch);

/** namePrefix: case-insensitive prefix on lower(name); codePrefix: prefix on item_code (LIKE metacharacters are literal). Order: item_code. */
export function listItems(rc: RepoCtx, f: { codePrefix?: string; namePrefix?: string; category?: string; limit?: number } = {}, opts?: ListOpts): Promise<Row[]> {
  const q = new Q();
  let w = activeOnly(opts);
  if (f.codePrefix !== undefined) w += ` AND item_code LIKE ${q.p(prefixOf(f.codePrefix))}`;
  if (f.namePrefix !== undefined) w += ` AND lower(name) LIKE lower(${q.p(prefixOf(f.namePrefix))})`;
  if (f.category !== undefined) w += ` AND category = ${q.p(f.category)}`;
  return query(rc, `SELECT * FROM inventory.items WHERE tenant_id = $1${w} ORDER BY item_code, id LIMIT ${q.p(limitOf(f.limit))}`, q.vals);
}

export const insertPack = (rc: RepoCtx, row: Row) => insertRow(rc, PACKS, row);
export const getPack = (rc: RepoCtx, id: string) => getRow(rc, PACKS, id);
export const listPacks = (rc: RepoCtx, itemId: string, opts?: ListOpts) =>
  query(rc, `SELECT * FROM inventory.item_packs WHERE tenant_id = $1 AND item_id = $2${activeOnly(opts)} ORDER BY pack_code, id`, [itemId]);
export const updatePack = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, PACKS, id, expectedVersion, patch);

export const insertBarcode = (rc: RepoCtx, row: Row) => insertRow(rc, BARCODES, row);
export const getBarcode = (rc: RepoCtx, id: string) => getRow(rc, BARCODES, id);
/** Active barcodes are unique per tenant (item_barcodes__tenant_id_value__p_uq). */
export const findActiveBarcode = (rc: RepoCtx, value: string) =>
  first(rc, 'SELECT * FROM inventory.item_barcodes WHERE tenant_id = $1 AND barcode_value = $2 AND is_active', [value]);
export const listBarcodes = (rc: RepoCtx, itemId: string, opts?: ListOpts) =>
  query(rc, `SELECT * FROM inventory.item_barcodes WHERE tenant_id = $1 AND item_id = $2${activeOnly(opts)} ORDER BY id`, [itemId]);
export const updateBarcode = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, BARCODES, id, expectedVersion, patch);
