// Billing nav manifest (C4 04-UI-UX s8.1, 8.4-8.11; T0D-NAV-COMPLETE-1, LD-250). Only parameterless staff_web routes are nav entries;
// invoice and credit-party detail pages are reached from lists. Permission = the page's API floor; order = section order, gaps of 5 [CONV].
import type { NavManifest } from '../../core/nav/types.ts';

export const navManifest: NavManifest = {
  module: 'billing',
  entries: [
    { id: 'billing.invoices', label: 'nav.billing.invoices', routeId: 'staff.billing.invoices', permission: 'billing.invoice.read', group: 'billing', order: 10 },
    { id: 'billing.dues', label: 'nav.billing.dues', routeId: 'staff.billing.dues', permission: 'billing.invoice.read', group: 'billing', order: 15 },
    { id: 'billing.daily_cash', label: 'nav.billing.daily_cash', routeId: 'staff.billing.daily_cash', permission: 'billing.cash_report.read', group: 'billing', order: 20 },
    { id: 'billing.credit_parties', label: 'nav.billing.credit_parties', routeId: 'staff.billing.credit_parties', permission: 'billing.credit_party.read', group: 'billing', order: 25 },
    { id: 'billing.registers', label: 'nav.billing.registers', routeId: 'staff.billing.registers', permission: 'billing.invoice.read', group: 'billing', order: 30 },
    { id: 'billing.audit_trail', label: 'nav.billing.audit_trail', routeId: 'staff.billing.audit_trail', permission: 'billing.data.export', group: 'billing', order: 35 },
    { id: 'billing.cbms', label: 'nav.billing.cbms', routeId: 'staff.billing.cbms', permission: 'billing.invoice.read', group: 'billing', order: 40 },
    { id: 'billing.worklist', label: 'nav.billing.worklist', routeId: 'staff.billing.worklist', permission: 'billing.invoice.read', group: 'billing', order: 45 },
    { id: 'billing.settings', label: 'nav.billing.settings', routeId: 'staff.billing.settings', permission: 'billing.settings.manage', group: 'billing', order: 50 },
    // T0D-ACCT-1 (LD-313): lab accounting, inside 50-60 (billing 60-64 stay with C15 payments).
    // [CONV] T0D-ACCT-2: the ACCT-1 entries moved to 51-51.8 so the ACCT-2 entries can take 52/54/56 and still follow them in spec order.
    { id: 'billing.account_entries', label: 'nav.billing.account_entries', routeId: 'staff.billing.account_entries', permission: 'billing.account.read', group: 'billing', order: 51 },
    { id: 'billing.account_ledger', label: 'nav.billing.account_ledger', routeId: 'staff.billing.account_ledger', permission: 'billing.account.read', group: 'billing', order: 51.2 },
    { id: 'billing.pocket_ledger', label: 'nav.billing.pocket_ledger', routeId: 'staff.billing.pocket_ledger', permission: 'billing.account.read', group: 'billing', order: 51.4 },
    { id: 'billing.account_summary', label: 'nav.billing.account_summary', routeId: 'staff.billing.account_summary', permission: 'billing.account.read', group: 'billing', order: 51.6 },
    { id: 'billing.account_masters', label: 'nav.billing.account_masters', routeId: 'staff.billing.account_masters', permission: 'billing.account.read', group: 'billing', order: 51.8 },
    // T0D-ACCT-2 (LD-313): Expense, Expense Type, Cash Transfer at 52/54/56.
    { id: 'billing.expenses', label: 'nav.billing.expenses', routeId: 'staff.billing.expenses', permission: 'billing.account.read', group: 'billing', order: 52 },
    { id: 'billing.expense_types', label: 'nav.billing.expense_types', routeId: 'staff.billing.expense_types', permission: 'billing.account.read', group: 'billing', order: 54 },
    { id: 'billing.cash_transfers', label: 'nav.billing.cash_transfers', routeId: 'staff.billing.cash_transfers', permission: 'billing.account.read', group: 'billing', order: 56 },
  ],
};
