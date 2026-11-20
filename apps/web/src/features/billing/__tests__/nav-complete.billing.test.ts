// T0D-NAV-COMPLETE-1 (LD-250): billing manifest = C4 04-UI-UX s8.1, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.11 (billing).
// The spec names screens and paths only: permission = the API operation floor of the page (contracts/openapi/billing.yaml x-permission),
// group = billing, order = section order with gaps of 5 so C15's payments entries (billing 60-64) sort after [CONV].
// 8.2 invoice detail and the credit-party detail are not nav entries (path parameters).
import { pageExists, specSuite, type SpecRow } from '../../../core/nav/__tests__/nav-complete.helpers.ts';

// T0D-ACCT-1 (LD-313): five additive accounting entries after Billing settings (order 51-59; billing 60-64 stay with C15 payments).
// Rows join the exact check only once their page exists, so this file never demands a CR for a page the task has not built yet.
const ACCOUNTING: SpecRow[] = ([
  { name: 'Account entries', path: '/billing/accounts/entries', permission: 'billing.account.read', group: 'billing', orderRange: [50, 60] },
  { name: 'Account ledger', path: '/billing/accounts/ledger', permission: 'billing.account.read', group: 'billing', orderRange: [50, 60] },
  { name: 'Pocket ledger', path: '/billing/accounts/pocket', permission: 'billing.account.read', group: 'billing', orderRange: [50, 60] },
  { name: 'Account summary', path: '/billing/accounts/summary', permission: 'billing.account.read', group: 'billing', orderRange: [50, 60] },
  { name: 'Account masters', path: '/billing/accounts/masters', permission: 'billing.account.read', group: 'billing', orderRange: [50, 60] },
] satisfies SpecRow[]).filter((r) => pageExists(r.path));

// T0D-ACCT-2 (LD-313): three more additive entries in the free slots 52, 54, 56 (same rule: they join once the page exists).
const ACCOUNTING_2: SpecRow[] = ([
  { name: 'Expenses', path: '/billing/expenses', permission: 'billing.account.read', group: 'billing', orderRange: [50, 60] },
  { name: 'Expense types', path: '/billing/expenses/types', permission: 'billing.account.read', group: 'billing', orderRange: [50, 60] },
  { name: 'Cash transfers', path: '/billing/cash-transfers', permission: 'billing.account.read', group: 'billing', orderRange: [50, 60] },
] satisfies SpecRow[]).filter((r) => pageExists(r.path));

// T0D-FINCTRL-1 (LD-321): four more additive entries (discount reasons, slabs, limits, authorities), orders inside 50-60; join once the page exists.
const DISCOUNTS: SpecRow[] = ([
  { name: 'Discount reasons', path: '/billing/discounts/reasons', permission: 'billing.discount_policy.read', group: 'billing', orderRange: [50, 60] },
  { name: 'Discount slabs', path: '/billing/discounts/slabs', permission: 'billing.discount_policy.read', group: 'billing', orderRange: [50, 60] },
  { name: 'Discount limits', path: '/billing/discounts/limits', permission: 'billing.discount_policy.read', group: 'billing', orderRange: [50, 60] },
  { name: 'Discount authorities', path: '/billing/discounts/authorities', permission: 'billing.discount_policy.read', group: 'billing', orderRange: [50, 60] },
] satisfies SpecRow[]).filter((r) => pageExists(r.path));

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
    ...ACCOUNTING,
    ...ACCOUNTING_2,
    ...DISCOUNTS,
  ],
});
