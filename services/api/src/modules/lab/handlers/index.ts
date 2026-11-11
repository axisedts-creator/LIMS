// operationId -> handler map of module lab (02-CV §2.2). Keys = every operationId of contracts/openapi/lab.yaml; the core
// fails boot on a missing or extra key (AC-0D-1.2). 06-IMPLEMENTATION-PLAN T-01: no 501 stubs — every stub throws
// common.internal (fail closed) until its task replaces it with handlers/<operationId>.ts.
// [CONV] stubs are generated here from one list instead of 55 placeholder files; each later task adds its own file.
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import { criticalHandlers } from './critical.handlers.js';
// T-07 specimen actions (each file: `export const handler`); later tasks add their own imports + entries to REAL below.
import { handler as bulkCollectSpecimens } from './bulkCollectSpecimens.js';
import { handler as bulkDispatchSpecimens } from './bulkDispatchSpecimens.js';
import { handler as bulkReceiveSpecimens } from './bulkReceiveSpecimens.js';
import { handler as collectSpecimen } from './collectSpecimen.js';
import { handler as createAliquots } from './createAliquots.js';
import { handler as discardSpecimen } from './discardSpecimen.js';
import { handler as rejectSpecimen } from './rejectSpecimen.js';
import { handler as requestRecollection } from './requestRecollection.js';
import { handler as getSpecimen } from './getSpecimen.js';
import { handler as listSpecimens } from './listSpecimens.js';
import { handler as lookupSpecimenByBarcode } from './lookupSpecimenByBarcode.js';
import { handler as receiveSpecimen } from './receiveSpecimen.js';
import { handler as storeSpecimen } from './storeSpecimen.js';
import { resultEntryHandlers } from './resultEntry.handlers.js';
import { verifyHandlers } from './verify.handlers.js';
import { approveHandlers } from './approve.handlers.js';

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

/** operationId -> real handler; everything not listed is still a fail-closed stub. */
const REAL: Partial<Record<LabOperationId, Handler>> = {
  lookupSpecimenByBarcode, listSpecimens, getSpecimen, collectSpecimen, bulkCollectSpecimens, bulkDispatchSpecimens, receiveSpecimen, bulkReceiveSpecimens, storeSpecimen, discardSpecimen,
  rejectSpecimen, requestRecollection, createAliquots, // T-08
  ...resultEntryHandlers, // T-14: bulkEnterResults, getResult, listOrderResults
  ...criticalHandlers, // T-15: listCriticalValues, getCriticalValue, logCriticalNotification
  ...verifyHandlers, // T-16: verifyResult, bulkVerifyResults, returnResult
  ...approveHandlers, // T-17: approveResult, bulkApproveResults, amendResult, listResultVersions
};

export const handlers: Readonly<Record<LabOperationId, Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, REAL[op] ?? notImplemented(op)])) as Record<LabOperationId, Handler>,
);
