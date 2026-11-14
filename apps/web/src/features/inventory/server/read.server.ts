import 'server-only';
// BFF reads for the inventory master-data screens (S2-S5, S14). Every call carries the session bearer on the server only (REQ-SEC-068).
import { notFound } from 'next/navigation';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { UUID_RE, type Binding, type Branch, type CodedValue, type Instrument, type Item, type ItemSummary, type Page, type Store, type StoreItemSetting, type Supplier, type SupplierItem, type SupplierSummary } from './types';

const uuid = (v: string) => {
  if (!UUID_RE.test(v)) notFound();
  return v;
};
const qs = (o: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

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
export const listCodedSet = (set: 'uom' | 'tax_codes') => serverFetch<Page<CodedValue & { is_active?: boolean }>>(`/v1/inventory/coded-sets/${set}${qs({ limit: 200 })}`).then((r) => r.data.filter((c) => c.is_active !== false));

export const listStores = () => serverFetch<Page<Store>>(`/v1/inventory/stores${qs({ limit: 200 })}`);
export const getStore = (id: string) => serverFetch<Store>(`/v1/inventory/stores/${uuid(id)}`);
export const listItemSettings = (storeId: string) => serverFetch<Page<StoreItemSetting>>(`/v1/inventory/stores/${uuid(storeId)}/item-settings${qs({ limit: 200 })}`);
export const listBindings = () => serverFetch<Page<Binding>>(`/v1/inventory/instrument-bindings${qs({ limit: 200 })}`);
export const listBranches = () => serverFetch<{ data: Branch[] }>('/v1/identity/branches').then((r) => r.data);
export const listInstruments = () => serverFetch<Page<Instrument>>(`/v1/instruments/instruments${qs({ limit: 200 })}`).then((r) => r.data);

export const listSuppliers = (f: { cursor?: string } = {}) => serverFetch<Page<SupplierSummary>>(`/v1/inventory/suppliers${qs({ cursor: f.cursor, limit: 100 })}`);
export const getSupplier = (id: string) => serverFetch<Supplier>(`/v1/inventory/suppliers/${uuid(id)}`);
export const listSupplierItems = (id: string) => serverFetch<Page<SupplierItem>>(`/v1/inventory/suppliers/${uuid(id)}/items${qs({ limit: 200 })}`);
