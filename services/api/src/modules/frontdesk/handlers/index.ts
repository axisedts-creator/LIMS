// FD-T01: one handler per operationId of contracts/openapi/frontdesk.yaml (the core fails boot otherwise, AC-0D-1.2).
// Each stub throws common.service_unavailable until its task replaces it with handlers/<operationId>.ts (02-TRD §3.1).
// Stubs never read the request, so no request data can reach the error.
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { handler as approveDiscount } from './approveDiscount.js';
import { handler as cancelOrder } from './cancelOrder.js';
import { handler as changeOrderItems } from './changeOrderItems.js';
import { handler as createPatient } from './createPatient.js';
import { handler as createRegistration } from './createRegistration.js';
import { handler as getDiscountApproval } from './getDiscountApproval.js';
import { handler as getOrder } from './getOrder.js';
import { handler as getPatient } from './getPatient.js';
import { handler as getTrfAttachment } from './getTrfAttachment.js';
import { handler as getTrfAttachmentContent } from './getTrfAttachmentContent.js';
import { handler as listDiscountApprovals } from './listDiscountApprovals.js';
import { handler as listOrders } from './listOrders.js';
import { handler as listPatientOrders } from './listPatientOrders.js';
import { handler as quoteOrderItemsChange } from './quoteOrderItemsChange.js';
import { handler as quoteRegistration } from './quoteRegistration.js';
import { handler as recordPatientConsent } from './recordPatientConsent.js';
import { handler as rejectDiscount } from './rejectDiscount.js';
import { handler as requestDiscountApproval } from './requestDiscountApproval.js';
import { handler as searchPatients } from './searchPatients.js';
import { handler as updatePatient } from './updatePatient.js';
import { handler as uploadTrf } from './uploadTrf.js';

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

// FD-T04: F1-F6, FD-T05: F8, FD-T06: F9, FD-T07: F15-F19, FD-T08: F10-F11, FD-T09: F8b/F13/F14, FD-T10: F20/F21/F21a are real handlers; the rest stay stubs until their task.
const real: Partial<Record<OperationId, Handler>> = {
  searchPatients, createPatient, getPatient, updatePatient, recordPatientConsent, listPatientOrders, quoteRegistration, createRegistration,
  requestDiscountApproval, listDiscountApprovals, getDiscountApproval, approveDiscount, rejectDiscount, listOrders, getOrder,
  quoteOrderItemsChange, changeOrderItems, cancelOrder, uploadTrf, getTrfAttachment, getTrfAttachmentContent,
};

export const handlers: Readonly<Record<OperationId, Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, real[op] ?? notImplemented])) as Record<OperationId, Handler>,
);
