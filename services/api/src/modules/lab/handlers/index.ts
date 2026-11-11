// operationId -> handler map of module lab (02-CV §2.2). Keys = every operationId of contracts/openapi/lab.yaml; the core
// fails boot on a missing or extra key (AC-0D-1.2). 06-IMPLEMENTATION-PLAN T-01: no 501 stubs — every stub throws
// common.internal (fail closed) until its task replaces it with handlers/<operationId>.ts.
// [CONV] stubs are generated here from one list instead of 55 placeholder files; each later task adds its own file.
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import { criticalHandlers } from './critical.handlers.js';
import { resultEntryHandlers } from './resultEntry.handlers.js';

const OPERATION_IDS = [
  // specimens
  'lookupSpecimenByBarcode', 'listSpecimens', 'getSpecimen', 'collectSpecimen', 'bulkCollectSpecimens',
  'bulkDispatchSpecimens', 'receiveSpecimen', 'bulkReceiveSpecimens', 'rejectSpecimen', 'requestRecollection',
  'createAliquots', 'storeSpecimen', 'discardSpecimen', 'printSpecimenLabels', 'requestOrderLabelPrint',
  // orders, board, worklists, worksheets
  'getLabOrder', 'listOrderResults', 'getStatusBoard', 'listWorklistItems', 'listPendingItems',
  'createWorksheet', 'listWorksheets', 'getWorksheet',
  // results
  'getResult', 'bulkEnterResults', 'getResultHistory', 'getAnalyteTrend', 'verifyResult', 'bulkVerifyResults',
  'returnResult', 'approveResult', 'bulkApproveResults', 'amendResult', 'listResultVersions', 'listVerificationQueue',
  // critical values
  'listCriticalValues', 'getCriticalValue', 'logCriticalNotification',
  // ingest exceptions
  'listIngestExceptions', 'getIngestException', 'assignIngestException', 'reapplyIngestException',
  'discardIngestException',
  // QC
  'listQcResults', 'captureQcResult', 'listQcHolds', 'releaseQcHold',
  // configuration
  'getLabSettings', 'updateLabSettings', 'listDeltaCheckRules', 'createDeltaCheckRule', 'versionDeltaCheckRule',
  'deactivateDeltaCheckRule', 'listLabCodedSet', 'upsertLabCode',
] as const;

export type LabOperationId = (typeof OPERATION_IDS)[number];

const notImplemented = (operationId: string): Handler => async () => {
  throw new LimsError('common.internal', `lab ${operationId} not implemented`);
};

export const handlers: Readonly<Record<LabOperationId, Handler>> = Object.freeze({
  ...(Object.fromEntries(OPERATION_IDS.map((op) => [op, notImplemented(op)])) as Record<LabOperationId, Handler>),
  ...resultEntryHandlers, // T-14: bulkEnterResults, getResult, listOrderResults
  ...criticalHandlers, // T-15: listCriticalValues, getCriticalValue, logCriticalNotification
});
