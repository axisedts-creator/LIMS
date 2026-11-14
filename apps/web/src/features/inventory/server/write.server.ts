import 'server-only';
// BFF writes for the inventory master-data screens. Creates send Idempotency-Key; rows that exist send If-Match "<version>" (CV §4.2).
// Path ids and keys are checked here because this is the trust boundary between the browser and the API.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { KEY_RE, UUID_RE, type Barcode, type BarcodeCreate, type Binding, type Item, type ItemCreate, type ItemPatch, type Pack, type PackCreate, type Store, type StoreCreate, type StoreItemSetting, type StoreItemSettingPut, type StorePatch, type Supplier, type SupplierCreate, type SupplierItem, type SupplierItemPut, type SupplierPatch } from './types';

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const uuid = (v: string) => {
  if (!UUID_RE.test(v)) throw bad();
  return v;
};
const base = '/v1/inventory';

function send<T>(method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown, o: { key?: string; version?: number } = {}): Promise<T> {
  if (o.key !== undefined && !KEY_RE.test(o.key)) throw bad();
  if (o.version !== undefined && !(Number.isInteger(o.version) && o.version > 0)) throw bad();
  return serverFetch<T>(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(o.key ? { 'idempotency-key': o.key } : {}),
      ...(o.version !== undefined ? { 'if-match': `"${o.version}"` } : {}),
    },
    body: JSON.stringify(body),
  });
}

export const createItem = (b: ItemCreate, key: string) => send<Item>('POST', `${base}/items`, b, { key });
export const updateItem = (id: string, version: number, p: ItemPatch) => send<Item>('PATCH', `${base}/items/${uuid(id)}`, p, { version });
export const setItemActive = (id: string, version: number, isActive: boolean) => send<Item>('POST', `${base}/items/${uuid(id)}/set-active`, { is_active: isActive }, { version });
export const createPack = (itemId: string, b: PackCreate, key: string) => send<Pack>('POST', `${base}/items/${uuid(itemId)}/packs`, b, { key });
export const addBarcode = (itemId: string, b: BarcodeCreate, key: string) => send<Barcode>('POST', `${base}/items/${uuid(itemId)}/barcodes`, b, { key });
export const deactivateBarcode = (itemId: string, barcodeId: string, version: number) =>
  send<Barcode>('POST', `${base}/items/${uuid(itemId)}/barcodes/${uuid(barcodeId)}/deactivate`, {}, { version });

export const createStore = (b: StoreCreate, key: string) => send<Store>('POST', `${base}/stores`, b, { key });
export const updateStore = (id: string, version: number, p: StorePatch) => send<Store>('PATCH', `${base}/stores/${uuid(id)}`, p, { version });
export const putStoreItemSetting = (storeId: string, itemId: string, version: number | undefined, b: StoreItemSettingPut) =>
  send<StoreItemSetting>('PUT', `${base}/stores/${uuid(storeId)}/item-settings/${uuid(itemId)}`, b, version === undefined ? {} : { version });

export const createSupplier = (b: SupplierCreate, key: string) => send<Supplier>('POST', `${base}/suppliers`, b, { key });
export const updateSupplier = (id: string, version: number, p: SupplierPatch) => send<Supplier>('PATCH', `${base}/suppliers/${uuid(id)}`, p, { version });
export const putSupplierItem = (supplierId: string, itemId: string, packId: string, version: number | undefined, b: SupplierItemPut) =>
  send<SupplierItem>('PUT', `${base}/suppliers/${uuid(supplierId)}/items/${uuid(itemId)}/packs/${uuid(packId)}`, b, version === undefined ? {} : { version });

export const putBinding = (instrumentId: string, version: number | undefined, storeId: string) =>
  send<Binding>('PUT', `${base}/instrument-bindings/${uuid(instrumentId)}`, { store_id: uuid(storeId) }, version === undefined ? {} : { version });
export const deactivateBinding = (instrumentId: string, version: number) =>
  send<Binding>('POST', `${base}/instrument-bindings/${uuid(instrumentId)}/deactivate`, {}, { version });
