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

// ---- T-23 stock operations (S8-S12). Shapes mirror contracts/openapi/inventory.yaml (BalanceRow, FefoSuggestion, Container, Transfer, Count, Fact).
export type LotStatus = 'available' | 'quarantined' | 'blocked';
export interface BalanceRow {
  store_id: string; item_id: string; item_code: string; item_name: string; lot_id?: string; lot_no?: string; expiry_on?: string; lot_status?: LotStatus;
  qty_base: string; available_qty_base: string; has_open_container: boolean; reorder_level_base?: string;
}
export interface Lot { id: string; item_id: string; lot_no: string; expiry_on?: string; status: LotStatus; version: number }
export interface FefoLine { lot_id: string; lot_no: string; expiry_on?: string; has_open_container: boolean; take_qty_base: string; available_qty_base: string }
export interface FefoSuggestion { store_id: string; item_id: string; qty_base: string; lines: FefoLine[]; shortfall_qty_base: string }
export interface StockMovement {
  id: string; occurred_at: string; store_id: string; item_id: string; lot_id?: string; lot_no?: string; movement_kind: string; qty_base: string; balance_qty_after?: string;
}
export interface StockDocument { id: string; doc_no: string; doc_kind: string; store_id: string; movements: StockMovement[]; version: number }
export interface TransferTarget { id: string; store_code: string; name: string; branch_id: string; branch_name: string }
export interface TransferLine { id: string; line_no: number; item_id: string; lot_id?: string; qty_base: string; received_qty_base?: string; discrepancy_reason_code?: string }
export type TransferStatus = 'draft' | 'dispatched' | 'received' | 'cancelled';
export interface TransferSummary { id: string; transfer_no: string; from_store_id: string; to_store_id: string; status: TransferStatus; dispatched_at?: string; received_at?: string; version: number }
export interface Transfer extends TransferSummary { notes?: string; lines: TransferLine[] }
export type CountStatus = 'open' | 'posted' | 'cancelled';
export interface CountSummary { id: string; count_no: string; store_id: string; status: CountStatus; scope_category?: Category; snapshot_at: string; posted_at?: string; version: number }
export interface CountLine {
  // book_/variance fields are removed by the server component for users without inventory.stock.adjust (blind count: the snapshot never reaches them)
  id: string; item_id: string; lot_id?: string; book_qty_snapshot?: string; counted_qty_base?: string; counted_at?: string;
  book_qty_at_count?: string; variance_qty_base?: string; variance_value_paisa?: number; version: number;
}
export interface Count extends CountSummary { lines: CountLine[] }
export interface Container {
  id: string; store_id: string; item_id: string; lot_id: string; lot_no?: string; instrument_id?: string; opened_at: string; open_expiry_at?: string;
  status: 'open' | 'finished' | 'discarded'; version: number;
}
export interface Fact { id: string; fact_kind: string; status: string; multiplier?: number; rules_applied?: number; movements: StockMovement[] }
export interface Department { id: string; code: string; name: string }
export interface TestRef { id: string; code: string; name: string }
export interface Analyte { id: string; code: string; name: string }
export type Direction = 'in' | 'out';
export type UncountedPolicy = 'skip' | 'zero';

export interface StockFilters { storeId?: string; category?: string; q?: string; belowReorder?: string; expiringWithinDays?: string; includeZero?: string; expiredOnly?: boolean; itemId?: string }
export interface IssueCreate { store_id: string; issued_to_kind: 'department' | 'instrument' | 'general'; department_id?: string; instrument_id?: string; lines: { item_id: string; lot_id?: string; qty: string }[] }
export interface WastageCreate { store_id: string; reason_code: string; reason_text?: string; lines: { item_id: string; lot_id?: string; qty: string }[] }
export interface AdjustmentCreate { store_id: string; reason_code: string; reason_text?: string; lines: { item_id: string; lot_id?: string; direction: Direction; qty: string }[] }
export interface ExpiryWriteoffCreate { store_id: string; lot_ids: string[] }
export interface TransferCreate { from_store_id: string; to_store_id: string; notes?: string; lines: { item_id: string; lot_id?: string; qty: string }[] }
export interface TransferReceive { lines: { line_id: string; received_qty_base: string; discrepancy_reason_code?: string }[] }
export interface CountCreate { store_id: string; scope_category?: Category; notes?: string }
export interface CountLinePut { line_id: string; item_id: string; lot_id?: string; counted_qty_base: string }
export interface ContainerOpen { store_id: string; item_id: string; lot_id?: string; instrument_id?: string }
export interface ContainerDiscard { qty_base: string; reason_code: string }
export interface ConsumptionEventCreate { fact_kind: 'calibration' | 'qc'; instrument_id?: string; test_id: string; analyte_id?: string; occurred_at: string; observations?: number; reason_code?: string; note?: string }

// ---- T-22 purchasing + receiving (S6, S7). Shapes mirror contracts/openapi/inventory.yaml (Po, PoSummary, PoPrintView, Grn, GrnSummary, GrnDraft).
// Money is integer paisa. Totals and line amounts are computed by the SERVER only (CV §4.7); the create/replace bodies carry no amounts besides unit price and discount.
export type PoStatus = 'draft' | 'approved' | 'sent' | 'partially_received' | 'received' | 'closed' | 'cancelled';
export type SentChannel = 'email' | 'phone' | 'in_person' | 'portal' | 'other';
export type GrnKind = 'purchase' | 'opening_balance';
export type GrnStatus = 'draft' | 'posted' | 'cancelled';
export interface PoSummary { id: string; po_no: string; branch_id: string; store_id: string; supplier_id: string; status: PoStatus; source: 'manual' | 'reorder'; expected_on?: string; total_paisa?: number; created_at: string; version: number }
export interface PoLine {
  id: string; line_no: number; item_id: string; pack_id: string; qty_packs: string; qty_base: string; unit_price_paisa?: number; discount_paisa?: number; tax_code?: string; is_exempt: boolean;
  tax_rate_bp?: number; net_paisa?: number; vat_paisa?: number; line_total_paisa?: number; received_qty_base: string; open_qty_base: string; is_closed_short: boolean;
}
export interface GrnSummary { id: string; grn_no: string; kind: GrnKind; store_id: string; supplier_id?: string; po_id?: string; status: GrnStatus; received_at: string; posted_at?: string; total_paisa?: number; version: number }
export interface Po extends PoSummary {
  notes?: string; subtotal_paisa?: number; discount_paisa?: number; net_paisa?: number; vat_paisa?: number;
  approved_at?: string; sent_at?: string; sent_channel?: SentChannel; sent_reference?: string; cancelled_at?: string; cancel_reason_code?: string; closed_at?: string; close_reason_code?: string;
  lines: PoLine[]; receipts?: GrnSummary[];
}
export interface PoLineIn { item_id: string; pack_id: string; qty_packs: string; unit_price_paisa?: number; discount_paisa?: number; tax_code?: string; is_exempt?: boolean }
export interface PoCreate { supplier_id: string; store_id: string; expected_on?: string; notes?: string; lines: PoLineIn[] }
export interface ReasonAction { reason_code: string; reason_text?: string }
export interface PoPrintLine { line_no: number; item_code: string; item_name: string; pack_label: string; qty_packs: string; unit_price_paisa: number; discount_paisa: number; tax_code?: string; is_exempt: boolean; line_total_paisa: number }
export interface PoPrintView {
  is_draft: boolean; tenant_display_name: string; branch_name: string; po_no: string; status: PoStatus; created_at: string; expected_on?: string;
  supplier: { supplier_code: string; name: string; pan_text?: string; address_text?: string }; lines: PoPrintLine[];
  subtotal_paisa: number; discount_paisa: number; net_paisa: number; vat_paisa: number; total_paisa: number;
}
export interface GrnLine {
  id: string; line_no: number; item_id: string; pack_id: string; qty_packs: string; qty_base: string; po_line_id?: string; lot_no?: string; expiry_on?: string; manufactured_on?: string;
  unit_price_paisa?: number; discount_paisa?: number; tax_code?: string; is_exempt: boolean; tax_rate_bp?: number; net_paisa?: number; vat_paisa?: number; line_total_paisa?: number;
}
export interface Grn extends GrnSummary {
  supplier_invoice_no?: string; supplier_invoice_on?: string; supplier_invoice_total_paisa?: number; invoice_total_mismatch_paisa?: number;
  subtotal_paisa?: number; discount_paisa?: number; net_paisa?: number; vat_paisa?: number; notes?: string; lines: GrnLine[];
}
export interface GrnLineIn { po_line_id?: string; item_id: string; pack_id: string; qty_packs: string; lot_no?: string; expiry_on?: string; manufactured_on?: string; unit_price_paisa?: number; discount_paisa?: number; tax_code?: string; is_exempt?: boolean }
export interface GrnDraft {
  kind: GrnKind; store_id: string; supplier_id?: string; po_id?: string; received_at?: string; supplier_invoice_no?: string; supplier_invoice_on?: string; supplier_invoice_total_paisa?: number; notes?: string; lines: GrnLineIn[];
}
/** PUT /goods-receipts/{grn_id} body: GrnDraft minus kind, store_id (TRD §5 #52; additionalProperties: false). */
export type GrnReplace = Omit<GrnDraft, 'kind' | 'store_id'>;
/** reason_group values of GET /coded-sets/reasons for the two PO reason dialogs (cancel, close). */
export const PO_REASON_GROUPS = { cancel: 'po_cancel', close: 'po_close' } as const;
export interface PoFilters { status?: string | undefined; supplier?: string | undefined; branch?: string | undefined; createdFrom?: string | undefined; createdTo?: string | undefined }
export interface GrnFilters { status?: string | undefined; store?: string | undefined; supplier?: string | undefined; poId?: string | undefined }

// ---- T-20 shell: alerts (S16, S1) and settings (S18). Shapes mirror contracts/openapi/inventory.yaml (Alert, Settings, SettingsUpdate).
export const ALERT_KINDS = ['below_reorder', 'expiry_soon', 'expired_on_hand', 'open_stability_exceeded', 'negative_stock', 'unresolved_consumption', 'expired_lot_in_use', 'balance_drift', 'reconciliation_gap'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const ALERT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];
export interface Alert {
  id: string; alert_kind: AlertKind; status: AlertStatus; store_id?: string; item_id?: string; lot_id?: string; instrument_id?: string; test_id?: string;
  first_raised_at: string; last_raised_at: string; occurrences: number; details: { key: string; value: string }[]; version: number;
}
export interface AlertFilters { status?: readonly AlertStatus[] | undefined; alertKind?: AlertKind | undefined; storeId?: string | undefined; limit?: number | undefined }
export interface Settings {
  consumption_enabled_at?: string; vat_in_cost: boolean; po_self_approval_allowed: boolean; grn_without_po_allowed: boolean; over_receipt_tolerance_bp: number;
  expiry_alert_days: number; default_consumption_store_id?: string; count_locks_store: boolean; per_day_requires_activity: boolean; reconciliation_gap_alert_bp: number;
  backdate_max_days: number; po_no_pattern: string; grn_no_pattern: string; transfer_no_pattern: string; count_no_pattern: string; doc_no_pattern: string; version: number;
}
export type SettingsUpdate = Omit<Settings, 'version'>;
/** Home only counts unresolved facts; the rest of the Fact shape is not read here. */
export interface FactRef { id: string; status: string }
