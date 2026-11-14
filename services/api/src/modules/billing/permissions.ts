// Billing permission codes, copied verbatim from contracts/permissions.yaml (02-TRD §10.1).
export const BILLING_PERMISSIONS = [
  'billing.invoice.read',
  'billing.invoice.issue',
  'billing.invoice.reprint',
  'billing.invoice.cancel',
  'billing.payment.record',
  'billing.payment.reverse',
  'billing.refund.approve',
  'billing.refund.request',
  'billing.credit_party.read',
  'billing.credit_party.manage',
  'billing.cash_report.read',
  'billing.data.export',
  'billing.release.override',
  'billing.settings.manage',
] as const;
export type BillingPermission = (typeof BILLING_PERMISSIONS)[number];
