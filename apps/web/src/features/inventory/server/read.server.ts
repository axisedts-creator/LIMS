import 'server-only';
// BFF reads for the inventory master-data screens (S2-S5, S14). Every call carries the session bearer on the server only (REQ-SEC-068).
import { notFound } from 'next/navigation';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { FACT_DISMISS_GROUP, UUID_RE, type Alert, type AlertFilters, type FactRef, type Settings, type Fact, type Rule, type RuleFilters, type Analyte, type BalanceRow, type Binding, type Branch, type CodedValue, type Container, type Count, type CountLine, type CountSummary, type Department, type FefoSuggestion, type Grn, type GrnFilters, type GrnSummary, type Po, type PoFilters, type PoPrintView, type PoSummary, type Instrument, type Item, type ItemSummary, type Lot, type Page, type StockFilters, type StockMovement, type Store, type StoreItemSetting, type Supplier, type SupplierItem, type SupplierSummary, type TestRef, type Transfer, type TransferSummary, type TransferTarget } from './types';

export const uuid = (v: string) => {
  if (!UUID_RE.test(v)) notFound();
  return v;
};
export const qs = (o: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** BLIND count (04-UI-UX S11, 07-SECURITY.md:57): the API returns book/variance fields to every caller, so the BFF drops them
 *  for users without inventory.stock.adjust before anything reaches the browser (page props and server-action results). */
export function blindLines(lines: CountLine[], perms: readonly string[]): CountLine[] {
  if (perms.includes('inventory.stock.adjust')) return lines;
  return lines.map(({ book_qty_snapshot: _s, book_qty_at_count: _b, variance_qty_base: _v, variance_value_paisa: _p, ...rest }) => rest);
}

export const FORBIDDEN = Symbol('forbidden');
/** 403 -> FORBIDDEN (page shows the no-access state); 404 -> notFound(); anything else goes to error.tsx. */
export async function guarded<T>(f: () => Promise<T>): Promise<T | typeof FORBIDDEN> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return FORBIDDEN;
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
}
/** Optional lookups (pickers, labels owned by other chunks): any API failure falls back instead of breaking the page. */
export async function soft<T>(f: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ApiError) return fallback;
    throw e;
  }
}

export const listItems = (f: { category?: string; isActive?: string; q?: string; cursor?: string; limit?: number }) =>
  serverFetch<Page<ItemSummary>>(`/v1/inventory/items${qs({ category: f.category, is_active: f.isActive, q: f.q, cursor: f.cursor, limit: f.limit ?? 50 })}`);
export const getItem = (id: string) => serverFetch<Item>(`/v1/inventory/items/${uuid(id)}`);
export const listCodedSet = (set: 'uom' | 'tax_codes' | 'wastage' | 'adjustment' | 'transfer_discrepancy' | 'calibration') => serverFetch<Page<CodedValue & { is_active?: boolean }>>(`/v1/inventory/coded-sets/${set}` /* LD-446 6c: no limit */).then((r) => r.data.filter((c) => c.is_active !== false));

export const listStores = () => serverFetch<Page<Store>>(`/v1/inventory/stores${qs({ limit: 200 })}`);
export const getStore = (id: string) => serverFetch<Store>(`/v1/inventory/stores/${uuid(id)}`);
export const listItemSettings = (storeId: string) => serverFetch<Page<StoreItemSetting>>(`/v1/inventory/stores/${uuid(storeId)}/item-settings${qs({ limit: 200 })}`);
export const listBindings = () => serverFetch<Page<Binding>>(`/v1/inventory/instrument-bindings${qs({ limit: 200 })}`);
export const listBranches = () => serverFetch<{ data: Branch[] }>('/v1/identity/branches').then((r) => r.data);
export const listInstruments = () => serverFetch<Page<Instrument>>(`/v1/instruments/instruments${qs({ limit: 200 })}`).then((r) => r.data);

// ---- T-23 stock operations (S8-S12)
export const listStock = (f: StockFilters) =>
  serverFetch<Page<BalanceRow>>(
    `/v1/inventory/stock${qs({ store_id: f.storeId, item_id: f.itemId, category: f.category, q: f.q, below_reorder: f.belowReorder, expiring_within_days: f.expiringWithinDays, expired_only: f.expiredOnly ? true : undefined, include_zero: f.includeZero, limit: 200 })}`,
  );
export const getFefo = (storeId: string, itemId: string, qtyBase: string) =>
  serverFetch<FefoSuggestion>(`/v1/inventory/fefo-suggestions${qs({ store_id: uuid(storeId), item_id: uuid(itemId), qty_base: qtyBase })}`);
export const listMovements = (storeId: string, itemId: string) =>
  serverFetch<Page<StockMovement>>(`/v1/inventory/movements${qs({ store_id: uuid(storeId), item_id: uuid(itemId), limit: 50 })}`);
export const listTransferTargets = () => serverFetch<Page<TransferTarget>>(`/v1/inventory/stores${qs({ purpose: 'transfer_target', limit: 200 })}`).then((r) => r.data);
export const listTransfers = (f: { status?: string } = {}) => serverFetch<Page<TransferSummary>>(`/v1/inventory/transfers${qs({ status: f.status, limit: 100 })}`);
export const getTransfer = (id: string) => serverFetch<Transfer>(`/v1/inventory/transfers/${uuid(id)}`);
export const listCounts = () => serverFetch<Page<CountSummary>>(`/v1/inventory/stock-counts${qs({ limit: 100 })}`);
export const getCount = (id: string) => serverFetch<Count>(`/v1/inventory/stock-counts/${uuid(id)}`);
export const listContainers = (storeId: string) => serverFetch<Page<Container>>(`/v1/inventory/containers${qs({ store_id: uuid(storeId), status: 'open', limit: 200 })}`);
export const listLots = (itemId: string) => serverFetch<Page<Lot>>(`/v1/inventory/lots${qs({ item_id: uuid(itemId), limit: 200 })}`);
export const listDepartments = () => serverFetch<Page<Department & { is_active?: boolean }>>(`/v1/catalog/departments${qs({ limit: 200 })}`).then((r) => r.data.filter((d) => d.is_active !== false));
export const listTests = () => serverFetch<Page<TestRef & { is_active?: boolean }>>(`/v1/catalog/tests${qs({ limit: 200 })}`).then((r) => r.data.filter((t) => t.is_active !== false));
export const listAnalytes = (testId: string) => serverFetch<Page<Analyte & { is_active?: boolean }>>(`/v1/catalog/tests/${uuid(testId)}/analytes${qs({ limit: 200 })}`).then((r) => r.data.filter((a) => a.is_active !== false));

/** Id -> label joins for rows that carry ids only (CountLine, Container). One lot lookup per distinct item (the lots API needs item_id), capped. */
export async function lotsByItems(itemIds: readonly string[]): Promise<Lot[]> {
  const ids = [...new Set(itemIds)].slice(0, 100);
  const parts = await Promise.all(ids.map((id) => soft(() => listLots(id).then((r) => r.data), [] as Lot[])));
  return parts.flat();
}

export const listSuppliers =(f: { cursor?: string } = {}) => serverFetch<Page<SupplierSummary>>(`/v1/inventory/suppliers${qs({ cursor: f.cursor, limit: 100 })}`);
export const getSupplier = (id: string) => serverFetch<Supplier>(`/v1/inventory/suppliers/${uuid(id)}`);
export const listSupplierItems = (id: string) => serverFetch<Page<SupplierItem>>(`/v1/inventory/suppliers/${uuid(id)}/items${qs({ limit: 200 })}`);

// ---- T-22 purchasing + receiving (S6, S7). The API omits cost fields for callers without inventory.cost.read.
export const listPos = (f: PoFilters = {}) =>
  serverFetch<Page<PoSummary>>(`/v1/inventory/purchase-orders${qs({ status: f.status, supplier_id: f.supplier, branch_id: f.branch, created_at_from: f.createdFrom, created_at_to: f.createdTo, limit: 100 })}`);
export const getPo = (id: string) => serverFetch<Po>(`/v1/inventory/purchase-orders/${uuid(id)}`);
export const getPoPrintView = (id: string) => serverFetch<PoPrintView>(`/v1/inventory/purchase-orders/${uuid(id)}/print-view`);
export const listGrns = (f: GrnFilters = {}) =>
  serverFetch<Page<GrnSummary>>(`/v1/inventory/goods-receipts${qs({ status: f.status, store_id: f.store, supplier_id: f.supplier, po_id: f.poId, limit: 100 })}`);
export const getGrn = (id: string) => serverFetch<Grn>(`/v1/inventory/goods-receipts/${uuid(id)}`);
// ---- T-20 shell (S1 home, S16 alerts, S18 settings)
export const listAlerts = (f: AlertFilters = {}) =>
  serverFetch<Page<Alert>>(`/v1/inventory/alerts${qs({ status: f.status?.join(','), alert_kind: f.alertKind, store_id: f.storeId, limit: f.limit ?? 200 })}`);
export const listUnresolvedFacts = () => serverFetch<Page<FactRef>>(`/v1/inventory/consumption-facts${qs({ status: 'unresolved', limit: 200 })}`);
// Set-up checklist probes (S1): one row is enough to know a step has been started (rules probe = listRules({ limit: 1 }) below).
export const listOpeningMovements = () => serverFetch<Page<{ id: string }>>(`/v1/inventory/movements${qs({ movement_kind: 'opening_balance', limit: 1 })}`);
export const getSettings = () => serverFetch<Settings>('/v1/inventory/settings');

/** Reason codes live in the shared `reasons` coded set, selected by reason_group (contract form; there is no /coded-sets/po_cancel). */
export const listReasons = (group: 'po_cancel' | 'po_close' | typeof FACT_DISMISS_GROUP) =>
  serverFetch<Page<CodedValue & { is_active?: boolean }>>(`/v1/inventory/coded-sets/reasons${qs({ reason_group: group }) /* LD-446 6c: no limit */}`).then((r) => r.data.filter((c) => c.is_active !== false));

// ---- T-24 consumption rules (S13) and waiting consumption (S15). Names (tests, analytes, analysers, items) are joined by the page from the C3/C7/C12 lists.
export const listRules = (f: RuleFilters & { limit?: number } = {}) =>
  serverFetch<Page<Rule>>(`/v1/inventory/consumption-rules${qs({ rule_kind: f.kind, test_id: f.test, instrument_id: f.analyser, item_id: f.item, current_only: f.history ? false : undefined, limit: f.limit ?? 200 })}`);
export const listFacts = (f: { status: 'unresolved'; cursor?: string | undefined }) =>
  serverFetch<Page<Fact>>(`/v1/inventory/consumption-facts${qs({ status: f.status, cursor: f.cursor, limit: 50 })}`);
