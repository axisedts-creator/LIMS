// T-26 handlers: #18 listWorklistItems, #19 listPendingItems, #20 createWorksheet, #21 listWorksheets, #22 getWorksheet — thin adapters over service/worklist.service.ts.
import type { Handler } from '../../../core/module.js';
import { createWorksheet, getWorksheet, listPendingItems, listVerificationQueue, listWorklistItems, listWorksheets } from '../service/worklist.service.js';

export const worklistHandlers: Readonly<Record<'listWorklistItems' | 'listPendingItems' | 'createWorksheet' | 'listWorksheets' | 'getWorksheet' | 'listVerificationQueue', Handler>> = Object.freeze({
  listVerificationQueue: (req, ctx) => listVerificationQueue(ctx, req.query),   // #34 (T-32)
  listWorklistItems: (req, ctx) => listWorklistItems(ctx, req.query),
  listPendingItems: (req, ctx) => listPendingItems(ctx, req.query),
  createWorksheet: (req, ctx) => createWorksheet(ctx, req.body),
  listWorksheets: (req, ctx) => listWorksheets(ctx, req.query),
  getWorksheet: (req, ctx) => getWorksheet(ctx, req.params),
});
