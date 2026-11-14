'use server';
// Server actions for the inventory client components. A thrown ApiError loses its code across the action boundary in production,
// so errors become { ok:false, code, title, requestId, errors } (the registry title is shown with the request id, never a raw message).
// Only ApiError is mapped; anything else rethrows to the error boundary. Browser code never sees the token (REQ-SEC-068).
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { getItem, listItems } from './read.server';
import { addBarcode, createItem, createPack, createStore, createSupplier, deactivateBarcode, deactivateBinding, putBinding, putStoreItemSetting, putSupplierItem, setItemActive, updateItem, updateStore, updateSupplier } from './write.server';
import type { ActionResult, BarcodeCreate, ItemCreate, ItemPatch, ItemSummary, Pack, PackCreate, StoreCreate, StoreItemSetting, StoreItemSettingPut, StorePatch, SupplierCreate, SupplierItem, SupplierItemPut, SupplierPatch, Binding, FieldProblem } from './types';

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) {
      const p = e.problem;
      const errors = Array.isArray(p['errors']) ? (p['errors'] as FieldProblem[]) : undefined;
      return { ok: false, status: e.status, code: p.code, title: p.title, ...(p.request_id ? { requestId: p.request_id } : {}), ...(errors ? { errors } : {}) };
    }
    throw e;
  }
}
const done = (f: () => Promise<unknown>): Promise<ActionResult<true>> => run(async () => (await f(), true as const));

export async function createItemAction(b: ItemCreate, key: string) { return done(() => createItem(b, key)); }
export async function updateItemAction(id: string, version: number, p: ItemPatch) { return done(() => updateItem(id, version, p)); }
export async function setItemActiveAction(id: string, version: number, isActive: boolean) { return done(() => setItemActive(id, version, isActive)); }
export async function createPackAction(itemId: string, b: PackCreate, key: string) { return done(() => createPack(itemId, b, key)); }
export async function addBarcodeAction(itemId: string, b: BarcodeCreate, key: string) { return done(() => addBarcode(itemId, b, key)); }
export async function deactivateBarcodeAction(itemId: string, barcodeId: string, version: number) { return done(() => deactivateBarcode(itemId, barcodeId, version)); }

export async function createStoreAction(b: StoreCreate, key: string) { return done(() => createStore(b, key)); }
export async function updateStoreAction(id: string, version: number, p: StorePatch) { return done(() => updateStore(id, version, p)); }
export async function putStoreItemSettingAction(storeId: string, itemId: string, version: number | undefined, b: StoreItemSettingPut): Promise<ActionResult<StoreItemSetting>> {
  return run(() => putStoreItemSetting(storeId, itemId, version, b));
}

export async function createSupplierAction(b: SupplierCreate, key: string) { return done(() => createSupplier(b, key)); }
export async function updateSupplierAction(id: string, version: number, p: SupplierPatch) { return done(() => updateSupplier(id, version, p)); }
export async function putSupplierItemAction(supplierId: string, itemId: string, packId: string, version: number | undefined, b: SupplierItemPut): Promise<ActionResult<SupplierItem>> {
  return run(() => putSupplierItem(supplierId, itemId, packId, version, b));
}

export async function putBindingAction(instrumentId: string, version: number | undefined, storeId: string): Promise<ActionResult<Binding>> {
  return run(() => putBinding(instrumentId, version, storeId));
}
export async function deactivateBindingAction(instrumentId: string, version: number) { return done(() => deactivateBinding(instrumentId, version)); }

/** Item picker for the supplier-item form: code/name prefix, active items only. */
export async function searchItemsAction(q: string): Promise<ActionResult<ItemSummary[]>> {
  return run(async () => (await listItems({ q: q.slice(0, 60), isActive: 'true', limit: 20 })).data);
}
export async function listItemPacksAction(itemId: string): Promise<ActionResult<Pack[]>> {
  return run(async () => (await getItem(itemId)).packs.filter((p) => p.is_active));
}
