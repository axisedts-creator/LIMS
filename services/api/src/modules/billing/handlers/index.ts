// BL-T01 handler stubs: one per operationId in contracts/openapi/billing.yaml (core checkHandlers, 02-TRD §6.3).
// Every stub refuses with common.service_unavailable (503) until its task (BL-T03..) replaces it; never a 2xx (REQ-SEC-099).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { cbmsHandlers } from './cbms.handlers.js';
import { creditHandlers } from './credit.handlers.js';
import { exportHandlers } from './export.handlers.js';
import { invoiceHandlers } from './invoice.handlers.js';
import { ledgerHandlers } from './ledger.handlers.js';
import { registerHandlers } from './register.handlers.js';
import { releaseHandlers } from './release.handlers.js';
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
  printInvoice: invoiceHandlers['printInvoice']!,
  printCreditNote: invoiceHandlers['printCreditNote']!,
  listCreditNoteTasks: invoiceHandlers['listCreditNoteTasks']!,
  listCreditNotes: invoiceHandlers['listCreditNotes']!,
  getCreditNote: invoiceHandlers['getCreditNote']!,
  getSalesRegister: registerHandlers['getSalesRegister']!,
  getCancelledInvoiceRegister: registerHandlers['getCancelledInvoiceRegister']!,
  getCreditNoteRegister: registerHandlers['getCreditNoteRegister']!,
  getAuditTrail: registerHandlers['getAuditTrail']!,
  createBillingExport: exportHandlers['createBillingExport']!,
  getBillingExport: exportHandlers['getBillingExport']!,
  getBillingExportContent: exportHandlers['getBillingExportContent']!,
  cancelInvoice: invoiceHandlers['cancelInvoice']!,
  issuePartialCreditNote: invoiceHandlers['issuePartialCreditNote']!,
  createReleaseOverride: releaseHandlers['createReleaseOverride']!,
  getReleaseEligibility: releaseHandlers['getReleaseEligibility']!,
  recordPayment: ledgerHandlers['recordPayment']!,
  getMyCashSession: ledgerHandlers['getMyCashSession']!,
  closeCashSession: ledgerHandlers['closeCashSession']!,
  listLedgerEntries: ledgerHandlers['listLedgerEntries']!,
  listDues: ledgerHandlers['listDues']!,
  getDailyCash: ledgerHandlers['getDailyCash']!,
  listCreditAccounts: creditHandlers['listCreditAccounts']!,
  getCreditAccount: creditHandlers['getCreditAccount']!,
  updateCreditAccount: creditHandlers['updateCreditAccount']!,
  listCreditCharges: creditHandlers['listCreditCharges']!,
  issuePeriodicInvoice: creditHandlers['issuePeriodicInvoice']!,
  recordCreditPartyPayment: creditHandlers['recordCreditPartyPayment']!,
  getCreditPartyStatement: creditHandlers['getCreditPartyStatement']!,
  reverseLedgerEntry: ledgerHandlers['reverseLedgerEntry']!,
  requestRefund: ledgerHandlers['requestRefund']!,
  approveRefund: ledgerHandlers['approveRefund']!,
  rejectRefund: ledgerHandlers['rejectRefund']!,
  listRefundRequests: ledgerHandlers['listRefundRequests']!,
  listFinanceReviewItems: ledgerHandlers['listFinanceReviewItems']!,
  resolveFinanceReviewItem: ledgerHandlers['resolveFinanceReviewItem']!,
  listCbmsDocuments: cbmsHandlers['listCbmsDocuments']!,
  retryCbmsDocument: cbmsHandlers['retryCbmsDocument']!,
});
