// BL-T06: the repository seam the issue / balance services default to (tests inject fakes with the same shape). Not a *.repo.ts: it names no table.
import { insertActivity } from './activity.repo.js';
import { getOrderBalance, listDues, lockOrderBalance, readOrderTotals, upsertOrderBalance } from './balances.repo.js';
import { closeCashSession, findOpenCashSession, getCashSession, insertCashSession, listCashSessionsForDay } from './cashSessions.repo.js';
import { enqueueCbmsSync, getCbmsDocumentForUpdate, insertCbmsSubmission, listCbmsDocuments, recordCbmsAttempt, resetCbmsToPending } from './cbms.repo.js';
import { getCreditAccount, listCreditAccounts, readCreditPartyStatement, sumOpenCreditExposure, updateCreditAccount, upsertCreditAccount } from './creditAccounts.repo.js';
import { insertCreditCharges, listCreditChargesByOrder, listCreditChargesByParty, lockUninvoicedCreditCharges, markCreditChargesInvoiced, voidCreditChargesByIds } from './creditCharges.repo.js';
import { getCreditNote, insertCreditNote, insertCreditNoteLines, listCreditNoteLines, listCreditNoteLinesByInvoice, markCreditNotePrinted } from './creditNotes.repo.js';
import { getCreditNoteTask, insertCreditNoteTask, listOpenCreditNoteTasks, resolveCreditNoteTasks } from './creditNoteTasks.repo.js';
import { addInvoiceCredit, findInvoiceForPayment, getInvoice, getInvoiceForUpdate, getPeriodicInvoiceForUpdate, insertInvoice, listInvoicesByOrder, markInvoiceCancelled, markInvoicePrinted } from './invoices.repo.js';
import { insertInvoiceLines, listInvoiceLines, listInvoiceLinesByOrder, sumCreditedByLine } from './invoiceLines.repo.js';
import { findGatewayPayment, findLedgerByIdempotencyKey, findReversalOf, getLedgerEntry, getPaymentIntentRef, insertLedgerEntry, listLedgerForDay, pageLedger, sumGatewayByIntent, sumLedgerByInvoice, sumLedgerBySession } from './ledger.repo.js';
import { findActiveOverride, insertReleaseOverride } from './overrides.repo.js';
import { getPaymentMethod } from './paymentMethods.repo.js';
import { insertPrintLog } from './printLog.repo.js';
import { decideRefundRequest, getFinanceReviewItem, getRefundRequest, insertFinanceReviewItem, insertRefundRequest, pageFinanceReviewItems, pageRefundRequests, resolveFinanceReviewItem } from './refundRequests.repo.js';
import { getBillingSettings } from './settings.repo.js';
import { getExportJob } from './exports.repo.js';
import { countExportRows, enqueueExportRender, insertExportJob, listAuditTrail, listCancelledInvoices, listCreditNoteRegister, listSalesRegister } from './registers.repo.js';

export const billingRepo = {
  getBillingSettings, insertInvoice, insertInvoiceLines, insertActivity, enqueueCbmsSync,
  readOrderTotals, getOrderBalance, upsertOrderBalance, findActiveOverride,
  // BL-T10
  getInvoiceForUpdate, markInvoiceCancelled, addInvoiceCredit, listInvoiceLines, insertCreditNote, insertCreditNoteLines, listCreditNoteLinesByInvoice,
  getCreditNoteTask, listOpenCreditNoteTasks, resolveCreditNoteTasks,
  // BL-T08
  lockOrderBalance, getPaymentMethod, findLedgerByIdempotencyKey, findInvoiceForPayment, insertLedgerEntry, sumLedgerBySession, pageLedger, listLedgerForDay,
  findOpenCashSession, insertCashSession, getCashSession, closeCashSession, listCashSessionsForDay, listDues,
  // BL-T07
  getCreditAccount, sumOpenCreditExposure, upsertCreditAccount, insertCreditCharges, listCreditChargesByOrder, voidCreditChargesByIds,
  listInvoicesByOrder, listInvoiceLinesByOrder, insertCreditNoteTask,
  // BL-T13
  listCreditAccounts, updateCreditAccount, readCreditPartyStatement, listCreditChargesByParty, lockUninvoicedCreditCharges, markCreditChargesInvoiced,
  getPeriodicInvoiceForUpdate, sumLedgerByInvoice,
  // BL-T11
  getLedgerEntry, findReversalOf, insertRefundRequest, getRefundRequest, decideRefundRequest, pageRefundRequests,
  getFinanceReviewItem, pageFinanceReviewItems, resolveFinanceReviewItem,
  // BL-T12
  findGatewayPayment, getPaymentIntentRef, sumGatewayByIntent, insertFinanceReviewItem, insertReleaseOverride,
  // BL-T09
  getInvoice, sumCreditedByLine, getCreditNote, listCreditNoteLines, markInvoicePrinted, markCreditNotePrinted, insertPrintLog,
  // BL-T14
  getCbmsDocumentForUpdate, insertCbmsSubmission, recordCbmsAttempt, resetCbmsToPending, listCbmsDocuments,
  // BL-T15
  listSalesRegister, listCancelledInvoices, listCreditNoteRegister, listAuditTrail, countExportRows, insertExportJob, enqueueExportRender, getExportJob,
};
export type BillingRepo = typeof billingRepo;
