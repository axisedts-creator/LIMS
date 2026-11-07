// BL-T01 handler stubs: one per operationId in contracts/openapi/billing.yaml (core checkHandlers, 02-TRD §6.3).
// Every stub refuses with common.service_unavailable (503) until its task (BL-T03..) replaces it; never a 2xx (REQ-SEC-099).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { invoiceHandlers } from './invoice.handlers.js';
import { settingsHandlers } from './settings.handlers.js';

const notYet: Handler = async () => { throw new LimsError('common.service_unavailable'); };

const OPERATION_IDS = [
  'listInvoices', 'getInvoice', 'listInvoicePrints', 'printInvoice', 'cancelInvoice', 'issuePartialCreditNote',
  'listCreditNotes', 'getCreditNote', 'printCreditNote', 'getOrderBilling', 'recordPayment', 'requestRefund',
  'createPaymentIntent', 'verifyPaymentIntent', 'createReleaseOverride', 'getReleaseEligibility', 'reverseLedgerEntry',
  'listLedgerEntries', 'approveRefund', 'rejectRefund', 'listRefundRequests', 'listDues', 'getMyCashSession',
  'closeCashSession', 'getDailyCash', 'listCreditAccounts', 'getCreditAccount', 'updateCreditAccount', 'listCreditCharges',
  'issuePeriodicInvoice', 'recordCreditPartyPayment', 'getCreditPartyStatement', 'getSalesRegister',
  'getCancelledInvoiceRegister', 'getCreditNoteRegister', 'getAuditTrail', 'createBillingExport', 'getBillingExport',
  'getBillingExportContent', 'listCbmsDocuments', 'retryCbmsDocument', 'getBillingSettings', 'updateBillingSettings',
  'listBillingCodes', 'listCreditNoteTasks', 'listFinanceReviewItems', 'resolveFinanceReviewItem',
] as const;

export const handlers: Readonly<Record<(typeof OPERATION_IDS)[number], Handler>> = Object.freeze({
  ...(Object.fromEntries(OPERATION_IDS.map((op) => [op, notYet])) as Record<(typeof OPERATION_IDS)[number], Handler>),
  getBillingSettings: settingsHandlers['getBillingSettings']!,
  updateBillingSettings: settingsHandlers['updateBillingSettings']!,
  listBillingCodes: settingsHandlers['listBillingCodes']!,
  listInvoices: invoiceHandlers['listInvoices']!,
  getInvoice: invoiceHandlers['getInvoice']!,
  getOrderBilling: invoiceHandlers['getOrderBilling']!,
  listInvoicePrints: invoiceHandlers['listInvoicePrints']!,
});
