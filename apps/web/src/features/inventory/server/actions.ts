'use server';
// Server actions for the inventory client components. A thrown ApiError loses its code across the action boundary in production,
// so errors become { ok:false, code, title, requestId, errors } (the registry title is shown with the request id, never a raw message).
// Only ApiError is mapped; anything else rethrows to the error boundary. Browser code never sees the token (REQ-SEC-068).
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { blindLines, getFefo, getItem, listAnalytes, listItems, listMovements, listStock } from './read.server';
import { lookupBarcode, cancelTransfer, createAdjustment, createCount, createExpiryWriteoff, createIssue, createTransfer, createWastage, discardContainer, dispatchTransfer, finishContainer, logConsumptionEvent, openContainer, postCount, putCountLines, receiveTransfer, addBarcode, createItem, createPack, createStore, createSupplier, deactivateBarcode, deactivateBinding, putBinding, putStoreItemSetting, putSupplierItem, setItemActive, updateItem, updateStore, updateSupplier } from './write.server';
import type { ActionResult, AdjustmentCreate, Analyte, BalanceRow, ConsumptionEventCreate, ContainerDiscard, ContainerOpen, CountCreate, CountLinePut, ExpiryWriteoffCreate, FefoSuggestion, IssueCreate, StockMovement, TransferCreate, TransferReceive, UncountedPolicy, WastageCreate, BarcodeCreate, ItemCreate, ItemPatch, ItemSummary, Pack, PackCreate, StoreCreate, StoreItemSetting, StoreItemSettingPut, StorePatch, SupplierCreate, SupplierItem, SupplierItemPut, SupplierPatch, Binding, FieldProblem } from './types';

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

// ---- T-23 stock operations. Same contract as above: ApiError -> { ok:false, ... }, the token stays on the server.
export async function fefoAction(storeId: string, itemId: string, qtyBase: string): Promise<ActionResult<FefoSuggestion>> { return run(() => getFefo(storeId, itemId, qtyBase)); }
export async function listStockAction(storeId: string, itemId?: string): Promise<ActionResult<BalanceRow[]>> { return run(async () => (await listStock({ storeId, ...(itemId ? { itemId } : {}) })).data); }
export async function listMovementsAction(storeId: string, itemId: string): Promise<ActionResult<StockMovement[]>> { return run(async () => (await listMovements(storeId, itemId)).data); }
export async function listAnalytesAction(testId: string): Promise<ActionResult<Analyte[]>> { return run(() => listAnalytes(testId)); }

export async function createIssueAction(b: IssueCreate, key: string) { return run(() => createIssue(b, key)); }
export async function createWastageAction(b: WastageCreate, key: string) { return run(() => createWastage(b, key)); }
export async function createAdjustmentAction(b: AdjustmentCreate, key: string) { return run(() => createAdjustment(b, key)); }
export async function createExpiryWriteoffAction(b: ExpiryWriteoffCreate, key: string) { return run(() => createExpiryWriteoff(b, key)); }

export async function createTransferAction(b: TransferCreate, key: string) { return run(() => createTransfer(b, key)); }
export async function dispatchTransferAction(id: string, version: number, key: string) { return done(() => dispatchTransfer(id, version, key)); }
export async function receiveTransferAction(id: string, version: number, key: string, b: TransferReceive) { return done(() => receiveTransfer(id, version, key, b)); }
export async function cancelTransferAction(id: string, version: number, key: string) { return done(() => cancelTransfer(id, version, key)); }

export async function lookupBarcodeAction(value: string): Promise<ActionResult<ItemSummary>> { return run(async () => (await lookupBarcode(value)).item); }
// BLIND count (07-SECURITY.md:57): CountsView needs only id/count_no, so the lines (with book_qty_snapshot) never leave the server.
export async function createCountAction(b: CountCreate, key: string) { return run(async () => { const c = await createCount(b, key); return { id: c.id, count_no: c.count_no }; }); }
export async function putCountLinesAction(id: string, lines: CountLinePut[]) {
  const perms = (await getShellSession())?.actor.permissions ?? [];
  return run(async () => { const r = await putCountLines(id, lines); return { ...r, lines: blindLines(r.lines, perms) }; });
}
export async function postCountAction(id: string, version: number, key: string, policy: UncountedPolicy) { return done(() => postCount(id, version, key, policy)); }

export async function openContainerAction(b: ContainerOpen, key: string) { return done(() => openContainer(b, key)); }
export async function finishContainerAction(id: string, version: number, key: string) { return done(() => finishContainer(id, version, key)); }
export async function discardContainerAction(id: string, version: number, key: string, b: ContainerDiscard) { return done(() => discardContainer(id, version, key, b)); }
export async function logConsumptionEventAction(b: ConsumptionEventCreate, key: string) { return run(() => logConsumptionEvent(b, key)); }

/** Item picker for the supplier-item form: code/name prefix, active items only. */
export async function searchItemsAction(q: string): Promise<ActionResult<ItemSummary[]>> {
  return run(async () => (await listItems({ q: q.slice(0, 60), isActive: 'true', limit: 20 })).data);
}
export async function listItemPacksAction(itemId: string): Promise<ActionResult<Pack[]>> {
  return run(async () => (await getItem(itemId)).packs.filter((p) => p.is_active));
}
