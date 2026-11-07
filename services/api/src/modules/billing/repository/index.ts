// BL-T06: the repository seam the issue / balance services default to (tests inject fakes with the same shape). Not a *.repo.ts: it names no table.
import { insertActivity } from './activity.repo.js';
import { getOrderBalance, readOrderTotals, upsertOrderBalance } from './balances.repo.js';
import { enqueueCbmsSync } from './cbms.repo.js';
import { insertInvoice } from './invoices.repo.js';
import { insertInvoiceLines } from './invoiceLines.repo.js';
import { findActiveOverride } from './overrides.repo.js';
import { getBillingSettings } from './settings.repo.js';

export const billingRepo = {
  getBillingSettings, insertInvoice, insertInvoiceLines, insertActivity, enqueueCbmsSync,
  readOrderTotals, getOrderBalance, upsertOrderBalance, findActiveOverride,
};
export type BillingRepo = typeof billingRepo;
