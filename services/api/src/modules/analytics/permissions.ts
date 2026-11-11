// Permission codes checked by module analytics (02-CV §2.2, §10.1). Copied verbatim from contracts/permissions.yaml (# analytics (C8) block).
export const ANALYTICS_PERMISSIONS = Object.freeze([
  'analytics.dashboard.read',
  'analytics.collections.read',
  'analytics.referral_report.read',
  'analytics.data.export',
  'analytics.schedule.manage',
] as const);

export type AnalyticsPermission = (typeof ANALYTICS_PERMISSIONS)[number];
