// Payments permission codes, copied verbatim from contracts/permissions.yaml (02-TRD §5.4, CR-C15-005).
export const PAYMENTS_PERMISSIONS = [
  'payments.intent.create',
  'payments.intent.resolve',
  'payments.reconciliation.read',
  'payments.refund.request',
  'payments.refund.approve',
  'payments.merchant_config.read',
  'payments.merchant_config.manage',
] as const;
export type PaymentsPermission = (typeof PAYMENTS_PERMISSIONS)[number];
