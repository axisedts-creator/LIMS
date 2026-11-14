// DTOs mirrored from contracts/openapi/inventory.yaml. [CONV] hand-mirrored: apps/web has no generated client yet.
// Type-only + constants: safe to import from client components (no server-only, no secrets).
// LD-140 (2026-11-13): UI is built from @lims/ui components only; this file holds no markup.
export interface Page<T> { data: T[]; page: { limit: number; next_cursor?: string } }
export interface FieldProblem { path?: string; code?: string; message: string }
export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; title: string; requestId?: string; errors?: FieldProblem[] };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

export type Category = 'reagent' | 'kit' | 'consumable' | 'control' | 'calibrator' | 'other';
export type StorageCondition = 'ambient' | 'refrigerated' | 'frozen' | 'other';
export type StoreKind = 'main' | 'bench' | 'other';

export interface ItemSummary {
  id: string; item_code: string; name: string; category: Category; base_uom_code: string; storage_condition?: StorageCondition;
  is_lot_tracked: boolean; requires_expiry: boolean; is_active: boolean; version: number; updated_at?: string;
}
export interface Pack {
  id: string; item_id: string; pack_code: string; label: string; uom_code: string; qty_in_base: string;
  is_purchase_default: boolean; is_active: boolean; version: number;
}
export interface Barcode { id: string; item_id: string; pack_id?: string; barcode_value: string; is_active: boolean; version: number }
export interface Item extends ItemSummary {
  manufacturer?: string; catalogue_no?: string; open_stability_days?: number; container_qty_base?: string; hs_code?: string;
  default_tax_code?: string; notes?: string; packs: Pack[]; barcodes: Barcode[]; updated_at: string;
}
export interface ItemCreate {
  item_code: string; name: string; category: Category; base_uom_code: string; manufacturer?: string; catalogue_no?: string;
  storage_condition?: StorageCondition; open_stability_days?: number; container_qty_base?: string; hs_code?: string;
  default_tax_code?: string; notes?: string; is_lot_tracked: boolean; requires_expiry: boolean;
}
export type ItemPatch = Partial<Omit<ItemCreate, 'item_code' | 'base_uom_code'>> & { unset?: string[] };
export interface PackCreate { pack_code: string; label: string; uom_code: string; qty_in_base: string; is_purchase_default: boolean }
export interface BarcodeCreate { barcode_value: string; pack_id?: string }

export interface Store {
  id: string; branch_id: string; branch_name: string; store_code: string; name: string; store_kind: StoreKind;
  is_default_consumption: boolean; is_active: boolean; version: number;
}
export interface StoreCreate { branch_id: string; store_code: string; name: string; store_kind: StoreKind; is_default_consumption: boolean }
export type StorePatch = Partial<{ name: string; store_kind: StoreKind; is_default_consumption: boolean; is_active: boolean }>;
export interface StoreItemSetting {
  id: string; store_id: string; item_id: string; reorder_level_base?: string; reorder_qty_base?: string; max_level_base?: string;
  preferred_supplier_id?: string; is_stocked: boolean; is_active: boolean; version: number;
}
export interface StoreItemSettingPut {
  is_stocked: boolean; reorder_level_base?: string; reorder_qty_base?: string; max_level_base?: string; preferred_supplier_id?: string;
}

export interface SupplierSummary { id: string; supplier_code: string; name: string; is_active: boolean; version: number; pan_text?: string; phone_display?: string }
export interface Supplier extends SupplierSummary {
  contact_name?: string; email?: string; address_text?: string; payment_terms_days?: number; notes?: string; updated_at: string;
}
export interface SupplierCreate {
  supplier_code: string; name: string; pan_text?: string; contact_name?: string; phone_display?: string; email?: string;
  address_text?: string; payment_terms_days?: number; notes?: string;
}
export type SupplierPatch = Partial<Omit<SupplierCreate, 'supplier_code'>> & { unset?: string[] };
export interface SupplierItem {
  id: string; supplier_id: string; item_id: string; pack_id: string; supplier_item_code?: string; last_unit_price_paisa?: number;
  lead_time_days?: number; default_tax_code?: string; is_active: boolean; version: number;
}
export interface SupplierItemPut { supplier_item_code?: string; last_unit_price_paisa?: number; lead_time_days?: number; default_tax_code?: string; is_active: boolean }

export interface Binding { id: string; instrument_id: string; store_id: string; is_active: boolean; version: number; since?: string }
export interface CodedValue { code: string; display: string }
export interface Branch { branch_id: string; code: string; name: string }
export interface Instrument { id: string; instrument_code: string; display_name: string }
