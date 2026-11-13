// operationId -> handler map of module lab (02-CV §2.2). Keys = every operationId of contracts/openapi/lab.yaml; the core
// fails boot on a missing or extra key (AC-0D-1.2). 06-IMPLEMENTATION-PLAN T-01: no 501 stubs — every stub throws
// common.internal (fail closed) until its task replaces it with handlers/<operationId>.ts.
// [CONV] stubs are generated here from one list instead of 55 placeholder files; each later task adds its own file.
import { join } from 'node:path';
import { REPO_ROOT, loadSpec, type Handler } from '../../../core/module.js';
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
import { handler as getStatusBoard } from './getStatusBoard.js';
import { handler as getLabOrder } from './getLabOrder.js';
import { handler as listSpecimens } from './listSpecimens.js';
import { handler as lookupSpecimenByBarcode } from './lookupSpecimenByBarcode.js';
import { handler as printSpecimenLabels } from './printSpecimenLabels.js';
import { handler as receiveSpecimen } from './receiveSpecimen.js';
import { handler as requestOrderLabelPrint } from './requestOrderLabelPrint.js';
import { handler as storeSpecimen } from './storeSpecimen.js';
import { resultEntryHandlers } from './resultEntry.handlers.js';
import { verifyHandlers } from './verify.handlers.js';
import { historyHandlers } from './history.handlers.js';
import { approveHandlers } from './approve.handlers.js';
import { worklistHandlers } from './worklist.handlers.js';
import { ingestExceptionHandlers } from './ingestException.handlers.js';
import { configHandlers } from './config.handlers.js';
import { qcHandlers } from './qc.handlers.js';

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
  printSpecimenLabels, requestOrderLabelPrint, // T-10
  ...resultEntryHandlers, // T-14: bulkEnterResults, getResult, listOrderResults
  ...criticalHandlers, // T-15: listCriticalValues, getCriticalValue, logCriticalNotification
  ...verifyHandlers, // T-16: verifyResult, bulkVerifyResults, returnResult
  ...approveHandlers, // T-17: approveResult, bulkApproveResults, amendResult, listResultVersions
  ...historyHandlers, // T-19: getResultHistory, getAnalyteTrend
  ...worklistHandlers, // T-26: listWorklistItems, listPendingItems, createWorksheet, listWorksheets, getWorksheet
  ...ingestExceptionHandlers, // T-23: list/get/assign/reapply/discard IngestException (#38-#42)
  ...configHandlers, // T-29: getLabSettings, updateLabSettings, list/create/version/deactivate DeltaCheckRule, listLabCodedSet, upsertLabCode (#47-#54)
  ...qcHandlers, // T-25: listQcResults, captureQcResult, listQcHolds, releaseQcHold (#43-#46)
  getStatusBoard, // T-27
  getLabOrder, // T-32
};

// 07-SECURITY P-10 / S-01 (T-32): the contract x-permission is asserted (tenant-wide, no centre) BEFORE any handler code, so a role without it gets 403 auth.forbidden
// (privileged at aal1: auth.mfa_required) and nothing is read or written; the handlers keep their own centre-scoped check (P-02 -> 404). Read from lab.yaml, never hand-copied.
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/lab.yaml'));
const PERMISSION: Readonly<Record<string, string>> = Object.fromEntries(Object.values<any>(spec.paths).flatMap((item) =>
  ['get', 'post', 'put', 'patch', 'delete'].map((m) => item?.[m]).filter((op) => op?.operationId).map((op) => [op.operationId, op['x-permission']])));

function gated(op: string, h: Handler): Handler {
  const permission = PERMISSION[op];
  if (typeof permission !== 'string') throw new Error(`lab.yaml has no x-permission for ${op}`);   // boot fails, never an open operation
  return async (req, ctx) => {
    const c = ctx as { tenantId?: unknown; actor?: { id?: unknown }; ports?: { IdentityPort?: { assertRole(c: unknown, r: { permission: string }): Promise<unknown> } } };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string') return h(req, ctx);   // the handler answers auth.unauthenticated
    const id = c.ports?.IdentityPort;
    if (!id) throw new LimsError('common.internal');   // fail closed: no identity port
    try { await id.assertRole(ctx, { permission }); }
    catch (e) {
      // 02-TRD:266 / 07 S-04 / AC-17.2 (ruling D): any auth.forbidden on lab.result.amend is 403 lab.amend_requires_pathologist; auth.mfa_required passes through.
      if (op === 'amendResult' && e instanceof LimsError && e.code === 'auth.forbidden') throw new LimsError('lab.amend_requires_pathologist');
      throw e;
    }
    if (op !== 'amendResult') return h(req, ctx);
    try { return await h(req, ctx); }
    catch (e) {   // the tenant-wide role passed above, so auth.forbidden from the centre-scoped check = a centre the caller cannot see: 404, never 403 (07 P-02)
      throw e instanceof LimsError && e.code === 'auth.forbidden' ? new LimsError('common.not_found') : e;
    }
  };
}

export const handlers: Readonly<Record<LabOperationId, Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, REAL[op] ? gated(op, REAL[op]) : notImplemented(op)])) as Record<LabOperationId, Handler>,
);
