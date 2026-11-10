// FD-T01: one handler per operationId of contracts/openapi/frontdesk.yaml (the core fails boot otherwise, AC-0D-1.2).
// Each stub throws common.service_unavailable until its task replaces it with handlers/<operationId>.ts (02-TRD §3.1).
// Stubs never read the request, so no request data can reach the error.
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { handler as createPatient } from './createPatient.js';
import { handler as getPatient } from './getPatient.js';
import { handler as listPatientOrders } from './listPatientOrders.js';
import { handler as quoteRegistration } from './quoteRegistration.js';
import { handler as recordPatientConsent } from './recordPatientConsent.js';
import { handler as searchPatients } from './searchPatients.js';
import { handler as updatePatient } from './updatePatient.js';

const OPERATION_IDS = [
  'searchPatients', 'createPatient', 'listPossibleDuplicatePatients', 'getPatient', 'updatePatient', 'recordPatientConsent',
  'listPatientOrders', 'anonymisePatient', 'quoteRegistration', 'createRegistration', 'listOrders', 'getOrder',
  'quoteOrderItemsChange', 'confirmPreRegisteredOrder', 'changeOrderItems', 'cancelOrder', 'requestDiscountApproval',
  'listDiscountApprovals', 'getDiscountApproval', 'approveDiscount', 'rejectDiscount', 'uploadTrf', 'getTrfAttachment',
  'getTrfAttachmentContent', 'listOrderFlags', 'resolveOrderFlag', 'getFrontdeskSettings', 'updateFrontdeskSettings',
  'listFrontdeskCodes',
] as const;
type OperationId = (typeof OPERATION_IDS)[number];

const notImplemented: Handler = async () => {
  throw new LimsError('common.service_unavailable');
};

// FD-T04: F1-F6, FD-T05: F8 are real handlers; the rest stay stubs until their task.
const real: Partial<Record<OperationId, Handler>> = {
  searchPatients, createPatient, getPatient, updatePatient, recordPatientConsent, listPatientOrders, quoteRegistration,
};

export const handlers: Readonly<Record<OperationId, Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, real[op] ?? notImplemented])) as Record<OperationId, Handler>,
);
