// BL-T06: the repository seam the issue / balance services default to (tests inject fakes with the same shape). Not a *.repo.ts: it names no table.
import { insertActivity } from './activity.repo.js';
import { getOrderBalance, listDues, lockOrderBalance, readOrderTotals, upsertOrderBalance } from './balances.repo.js';
import { closeCashSession, findOpenCashSession, getCashSession, insertCashSession, listCashSessionsForDay } from './cashSessions.repo.js';
import { enqueueCbmsSync } from './cbms.repo.js';
import { getCreditAccount, sumOpenCreditExposure, upsertCreditAccount } from './creditAccounts.repo.js';
import { insertCreditCharges, listCreditChargesByOrder, voidCreditChargesByIds } from './creditCharges.repo.js';
import { getCreditNote, insertCreditNote, insertCreditNoteLines, listCreditNoteLines, listCreditNoteLinesByInvoice, markCreditNotePrinted } from './creditNotes.repo.js';
import { getCreditNoteTask, insertCreditNoteTask, listOpenCreditNoteTasks, resolveCreditNoteTasks } from './creditNoteTasks.repo.js';
import { addInvoiceCredit, findInvoiceForPayment, getInvoice, getInvoiceForUpdate, insertInvoice, listInvoicesByOrder, markInvoiceCancelled, markInvoicePrinted } from './invoices.repo.js';
import { insertInvoiceLines, listInvoiceLines, listInvoiceLinesByOrder, sumCreditedByLine } from './invoiceLines.repo.js';
import { findLedgerByIdempotencyKey, insertLedgerEntry, listLedgerForDay, pageLedger, sumLedgerBySession } from './ledger.repo.js';
import { findActiveOverride } from './overrides.repo.js';
import { getPaymentMethod } from './paymentMethods.repo.js';
import { insertPrintLog } from './printLog.repo.js';
import { getBillingSettings } from './settings.repo.js';

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
  // BL-T09
  getInvoice, sumCreditedByLine, getCreditNote, listCreditNoteLines, markInvoicePrinted, markCreditNotePrinted, insertPrintLog,
};
export type BillingRepo = typeof billingRepo;
