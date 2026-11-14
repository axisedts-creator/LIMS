// Handler map: one entry per operationId of 02-TRD §5 (core validateManifest checks it against contracts/openapi/inventory.yaml).
// T-01 stubs: every operation rejects common.internal until its owning task (T-06+) replaces the entry.
import type { Handler } from '../../../core/module.js';
import { consumptionHandlers } from './consumption.js';
import { countHandlers } from './counts.js';
import { documentHandlers } from './documents.js';
import { itemHandlers } from './items.js';
import { lotHandlers } from './lots.js';
import { masterHandlers } from './masters.js';
import { purchasingHandlers } from './purchasing.js';
import { receiptHandlers } from './receipts.js';
import { settingsHandlers } from './settings.handlers.js';
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
  ...settingsHandlers, // #26-#29 (T-06)
  ...lotHandlers, // #30-#39 (T-09)
  ...documentHandlers, // #40-#48 (T-10)
  ...receiptHandlers, // #49-#55 (T-12)
  ...transferHandlers, // #56-#62 (T-13)
  ...countHandlers, // #63-#68 (T-14)
  ...consumptionHandlers, // #69-#79 (T-15)
  ...purchasingHandlers, // #80-#89 (T-11)
  listInventoryAlerts: stub,
  acknowledgeInventoryAlert: stub,
  getInventoryReport: stub,
  exportInventoryReport: stub,
};
