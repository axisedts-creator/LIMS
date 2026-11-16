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
  ],
};
