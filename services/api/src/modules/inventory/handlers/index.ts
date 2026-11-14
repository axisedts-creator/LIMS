// Handler map: one entry per operationId of 02-TRD §5 (core validateManifest checks it against contracts/openapi/inventory.yaml).
// T-01 stubs: every operation rejects common.internal until its owning task (T-06+) replaces the entry.
import type { Handler } from '../../../core/module.js';
import { countHandlers } from './counts.js';
import { itemHandlers } from './items.js';
import { lotHandlers } from './lots.js';
import { masterHandlers } from './masters.js';
import { transferHandlers } from './transfers.js';

/** Error carrying a contract error code (contracts/errors.yaml). */
export class InventoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const stub: Handler = async (_req, ctx) => {
  throw new InventoryError('common.internal', `inventory operation ${ctx.operationId} is not implemented`);
};

export const handlers: Readonly<Record<string, Handler>> = {
  ...itemHandlers, // #1-#10 (T-07)
  ...masterHandlers, // #11-#25 (T-08)
  getInventorySettings: stub,
  updateInventorySettings: stub,
  listInventoryCodedSet: stub,
  putInventoryTenantCode: stub,
  ...lotHandlers, // #30-#39 (T-09)
  discardContainer: stub,
  listStockDocuments: stub,
  getStockDocument: stub,
  createStockIssue: stub,
  createStoreReturn: stub,
  createSupplierReturn: stub,
  recordWastage: stub,
  writeOffExpiredStock: stub,
  createStockAdjustment: stub,
  listGoodsReceipts: stub,
  createGoodsReceipt: stub,
  getGoodsReceipt: stub,
  replaceGoodsReceiptDraft: stub,
  postGoodsReceipt: stub,
  cancelGoodsReceipt: stub,
  exportGoodsReceiptsCsv: stub,
  ...transferHandlers, // #56-#62 (T-13)
  ...countHandlers, // #63-#68 (T-14)
  listConsumptionRules: stub,
  createConsumptionRule: stub,
  getConsumptionRule: stub,
  supersedeConsumptionRule: stub,
  deactivateConsumptionRule: stub,
  previewConsumption: stub,
  listConsumptionFacts: stub,
  logConsumptionEvent: stub,
  resolveConsumptionFact: stub,
  dismissConsumptionFact: stub,
  reverseConsumptionFact: stub,
  listPurchaseOrders: stub,
  createPurchaseOrder: stub,
  getPurchaseOrder: stub,
  replacePurchaseOrderDraft: stub,
  approvePurchaseOrder: stub,
  markPurchaseOrderSent: stub,
  cancelPurchaseOrder: stub,
  closePurchaseOrder: stub,
  createPurchaseOrdersFromReorder: stub,
  getPurchaseOrderPrintView: stub,
  listInventoryAlerts: stub,
  acknowledgeInventoryAlert: stub,
  getInventoryReport: stub,
  exportInventoryReport: stub,
};
