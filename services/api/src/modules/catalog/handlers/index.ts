// One handler per catalog.yaml operationId (02-CV §2.2; the core fails boot if one is missing).
// T-01: every entry is a stub. Each later task swaps its entries for real ./<operationId>.ts handlers and removes
// them from __tests__/probes/pending.json (CR-C3-008; the list must be empty at M6).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { creditPartiesHandlers } from './creditParties.handlers.js';
import { importsHandlers } from './imports.handlers.js';
import { mastersHandlers } from './masters.handlers.js';
import { referrersHandlers } from './referrers.handlers.js';
import { testsHandlers } from './tests.handlers.js';

/** 503 common.service_unavailable, detail not_implemented (06-PLAN T-01). Never echoes the request. */
const notImplemented: Handler = async () => {
  throw new LimsError('common.service_unavailable', 'not_implemented');
};

export const handlers: Readonly<Record<string, Handler>> = Object.freeze({
  getCatalogRevision: notImplemented,
  resolveOrderablesPreview: notImplemented,
  getCatalogHealthReport: notImplemented,
  ...mastersHandlers, // T-04: #5–#16; T-05: #17–#22 (units, value sets); T-13: #57–#59 (comment codes)
  ...testsHandlers, // T-06: #2, #23–#27
  setTestTatTargets: notImplemented,
  createAnalyte: notImplemented,
  getAnalyte: notImplemented,
  updateAnalyte: notImplemented,
  createAnalyteVersionDraft: notImplemented,
  updateAnalyteVersionDraft: notImplemented,
  publishAnalyteVersion: notImplemented,
  discardAnalyteVersionDraft: notImplemented,
  validateFormula: notImplemented,
  listReferenceRangeSets: notImplemented,
  createReferenceRangeSetDraft: notImplemented,
  getReferenceRangeSet: notImplemented,
  replaceReferenceRangeSetBands: notImplemented,
  publishReferenceRangeSet: notImplemented,
  retireReferenceRangeSet: notImplemented,
  discardReferenceRangeSetDraft: notImplemented,
  listCriticalLimitSets: notImplemented,
  createCriticalLimitSetDraft: notImplemented,
  getCriticalLimitSet: notImplemented,
  replaceCriticalLimitSetBands: notImplemented,
  publishCriticalLimitSet: notImplemented,
  retireCriticalLimitSet: notImplemented,
  discardCriticalLimitSetDraft: notImplemented,
  previewReferenceRange: notImplemented,
  listPanels: notImplemented,
  createPanel: notImplemented,
  getPanelDetail: notImplemented,
  updatePanel: notImplemented,
  replacePanelMembers: notImplemented,
  ...referrersHandlers, // T-15: #60–#66 (doctors)
  ...creditPartiesHandlers, // T-16: #67–#70 (credit parties)
  listPriceLists: notImplemented,
  createPriceList: notImplemented,
  getPriceListDetail: notImplemented,
  updatePriceList: notImplemented,
  replacePriceListAssignments: notImplemented,
  createPriceListVersionDraft: notImplemented,
  listPriceListItems: notImplemented,
  upsertPriceListItems: notImplemented,
  removePriceListItems: notImplemented,
  publishPriceListVersion: notImplemented,
  discardPriceListVersionDraft: notImplemented,
  quotePrices: notImplemented,
  listSurchargeRules: notImplemented,
  createSurchargeRule: notImplemented,
  endSurchargeRule: notImplemented,
  listTaxTypes: notImplemented,
  createTaxType: notImplemented,
  updateTaxType: notImplemented,
  listTaxRules: notImplemented,
  createTaxRule: notImplemented,
  endTaxRule: notImplemented,
  listInstrumentCodeMaps: notImplemented,
  createInstrumentCodeMap: notImplemented,
  updateInstrumentCodeMap: notImplemented,
  upsertInstrumentCodeMaps: notImplemented,
  ...importsHandlers,
  commitImport: notImplemented,
  createExport: notImplemented,
  listExports: notImplemented,
  getExport: notImplemented,
  downloadExportFile: notImplemented,
});
