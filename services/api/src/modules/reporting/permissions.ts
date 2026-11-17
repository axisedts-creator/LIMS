// reporting permission codes, verbatim from 03-INTERFACE-CATALOG §11 (incl. CR-C6-003 additions).
export const REPORTING_PERMISSIONS = Object.freeze([
  'reporting.report.read', 'reporting.report.release', 'reporting.report.bulk_release', 'reporting.report.print',
  'reporting.delivery.read', 'reporting.delivery.resend', 'reporting.template.manage', 'reporting.outsourced.attach',
  'reporting.portal.view', 'reporting.portal.download', 'reporting.report.render', 'reporting.report.regenerate',
  'reporting.report.bulk_download', 'reporting.token.revoke', 'reporting.narrative.write', 'reporting.narrative.sign',
  'reporting.message_template.manage', 'reporting.channel.manage', 'reporting.settings.manage', 'reporting.portal.challenge',
] as const);
export type ReportingPermission = (typeof REPORTING_PERMISSIONS)[number];

/** Manifest systemPermissions (02-TRD §9; 01-PRD §2). */
export const REPORTING_SYSTEM_PERMISSIONS = Object.freeze([
  'reporting.report.read', 'reporting.report.release', 'reporting.delivery.resend', 'reporting.portal.view', 'identity.signatory.read',
] as const);
