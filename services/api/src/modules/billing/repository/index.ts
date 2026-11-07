// BL-T06: the repository seam the issue / balance services default to (tests inject fakes with the same shape). Not a *.repo.ts: it names no table.
import { insertActivity } from './activity.repo.js';
import { getOrderBalance, listDues, lockOrderBalance, readOrderTotals, upsertOrderBalance } from './balances.repo.js';
import { closeCashSession, findOpenCashSession, getCashSession, insertCashSession, listCashSessionsForDay } from './cashSessions.repo.js';
import { enqueueCbmsSync } from './cbms.repo.js';
import { getCreditAccount, sumOpenCreditExposure, upsertCreditAccount } from './creditAccounts.repo.js';
import { insertCreditCharges, listCreditChargesByOrder, voidCreditChargesByIds } from './creditCharges.repo.js';
import { insertCreditNoteTask } from './creditNoteTasks.repo.js';
import { findInvoiceForPayment, insertInvoice, listInvoicesByOrder } from './invoices.repo.js';
import { insertInvoiceLines, listInvoiceLinesByOrder } from './invoiceLines.repo.js';
import { findLedgerByIdempotencyKey, insertLedgerEntry, listLedgerForDay, pageLedger, sumLedgerBySession } from './ledger.repo.js';
import { findActiveOverride } from './overrides.repo.js';
import { getPaymentMethod } from './paymentMethods.repo.js';
import { getBillingSettings } from './settings.repo.js';

export const billingRepo = {
  getBillingSettings, insertInvoice, insertInvoiceLines, insertActivity, enqueueCbmsSync,
  readOrderTotals, getOrderBalance, upsertOrderBalance, findActiveOverride,
  // BL-T08
  lockOrderBalance, getPaymentMethod, findLedgerByIdempotencyKey, findInvoiceForPayment, insertLedgerEntry, sumLedgerBySession, pageLedger, listLedgerForDay,
  findOpenCashSession, insertCashSession, getCashSession, closeCashSession, listCashSessionsForDay, listDues,
  // BL-T07
  getCreditAccount, sumOpenCreditExposure, upsertCreditAccount, insertCreditCharges, listCreditChargesByOrder, voidCreditChargesByIds,
  listInvoicesByOrder, listInvoiceLinesByOrder, insertCreditNoteTask,
};
export type BillingRepo = typeof billingRepo;
