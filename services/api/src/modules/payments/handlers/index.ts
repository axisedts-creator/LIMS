// PG-T01 handler placeholders: one per operationId in contracts/openapi/payments.yaml (core checkHandlers, 02-TRD §6.3).
// Every placeholder refuses with common.service_unavailable (503) until its task replaces it; never a 2xx (REQ-SEC-099).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';

const notYet: Handler = async () => { throw new LimsError('common.service_unavailable'); };

const OPERATION_IDS = [
  'listPaymentIntents', 'getPaymentIntent', 'recheckPaymentIntent', 'resolvePaymentIntent', 'cancelPaymentIntent',
  'listPaymentRefunds', 'getPaymentRefund', 'recheckPaymentRefund', 'createPaymentRefundRequest', 'approvePaymentRefund',
  'rejectPaymentRefund', 'confirmManualPaymentRefund', 'failManualPaymentRefund', 'listReconciliationRuns',
  'startReconciliationRun', 'getReconciliationRun', 'listReconciliationFindings', 'resolveReconciliationFinding',
  'listStaticQrReconciliations', 'createStaticQrReconciliation', 'previewStaticQrReconciliation', 'listMerchantAccounts',
  'putMerchantAccount', 'testMerchantAccount', 'getPaymentSettings', 'updatePaymentSettings', 'listPaymentCodes',
  'listPaymentCancelReasons', 'launchEsewaPayment', 'esewaSuccessCallback', 'esewaFailureCallback', 'khaltiReturnCallback',
  'getPaymentResultPage',
] as const;

export const handlers: Readonly<Record<(typeof OPERATION_IDS)[number], Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, notYet])) as Record<(typeof OPERATION_IDS)[number], Handler>,
);
