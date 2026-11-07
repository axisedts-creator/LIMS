// BL-T06: the repository seam the issue / balance services default to (tests inject fakes with the same shape). Not a *.repo.ts: it names no table.
import { insertActivity } from './activity.repo.js';
import { getOrderBalance, readOrderTotals, upsertOrderBalance } from './balances.repo.js';
import { enqueueCbmsSync } from './cbms.repo.js';
import { insertCreditNote, insertCreditNoteLines, listCreditNoteLinesByInvoice } from './creditNotes.repo.js';
import { listOpenCreditNoteTasks, resolveCreditNoteTasks, getCreditNoteTask } from './creditNoteTasks.repo.js';
import { addInvoiceCredit, getInvoiceForUpdate, insertInvoice, markInvoiceCancelled } from './invoices.repo.js';
import { insertInvoiceLines, listInvoiceLines } from './invoiceLines.repo.js';
import { findActiveOverride } from './overrides.repo.js';
import { getBillingSettings } from './settings.repo.js';

export const billingRepo = {
  getBillingSettings, insertInvoice, insertInvoiceLines, insertActivity, enqueueCbmsSync,
  readOrderTotals, getOrderBalance, upsertOrderBalance, findActiveOverride,
  getInvoiceForUpdate, markInvoiceCancelled, addInvoiceCredit, listInvoiceLines, insertCreditNote, insertCreditNoteLines, listCreditNoteLinesByInvoice,
  getCreditNoteTask, listOpenCreditNoteTasks, resolveCreditNoteTasks,
};
export type BillingRepo = typeof billingRepo;
