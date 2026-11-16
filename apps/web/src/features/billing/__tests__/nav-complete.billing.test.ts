// T0D-NAV-COMPLETE-1 (LD-250): billing manifest = C4 04-UI-UX s8.1, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.11 (billing).
// The spec names screens and paths only: permission = the API operation floor of the page (contracts/openapi/billing.yaml x-permission),
// group = billing, order = section order with gaps of 5 so C15's payments entries (billing 60-64) sort after [CONV].
// 8.2 invoice detail and the credit-party detail are not nav entries (path parameters).
import { specSuite } from '../../../core/nav/__tests__/nav-complete.helpers.ts';

specSuite({
  module: 'billing',
  owner: 'C4',
  section: 'C4 04-UI-UX s8',
  rows: [
    { name: 'Invoices', path: '/billing/invoices', permission: 'billing.invoice.read', group: 'billing', order: 10 },
    { name: 'Dues', path: '/billing/dues', permission: 'billing.invoice.read', group: 'billing', order: 15 },
    { name: 'Daily cash', path: '/billing/daily-cash', permission: 'billing.cash_report.read', group: 'billing', order: 20, routeId: 'staff.billing.daily_cash' },
    { name: 'Credit parties', path: '/billing/credit-parties', permission: 'billing.credit_party.read', group: 'billing', order: 25 },
    { name: 'Registers', path: '/billing/registers', permission: 'billing.invoice.read', group: 'billing', order: 30 },
    { name: 'Audit trail', path: '/billing/audit-trail', permission: 'billing.data.export', group: 'billing', order: 35 },
    { name: 'CBMS', path: '/billing/cbms', permission: 'billing.invoice.read', group: 'billing', order: 40 },
    { name: 'Finance worklist', path: '/billing/worklist', permission: 'billing.invoice.read', group: 'billing', order: 45 },
    { name: 'Billing settings', path: '/billing/settings', permission: 'billing.settings.manage', group: 'billing', order: 50 },
  ],
});
